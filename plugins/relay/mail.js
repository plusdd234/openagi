/* 本地中转的 IMAP 收信模块。
 *
 * 背景：邮箱台里「手动登记」的邮箱（Outlook / Gmail / QQ / 163 等）只有地址与口令，
 * 浏览器不能直接连 IMAP（TCP + TLS），所以由本地中转代连，读完即断，不落盘。
 *
 * 只做「读」：
 *   LOGIN → SELECT INBOX → FETCH 最近 N 封（BODY.PEEK[]）→ LOGOUT
 * 不删除、不改服务端标记；口令只用于这一次连接。
 *
 * 安全边界：
 *   ① 只允许常见邮箱的 IMAP 主机（测试环境可用 RELAY_MAIL_TEST=1 放行本机回环）；
 *   ② 单封正文最多 512KB，最多 12 封，整体 45 秒超时；
 *   ③ 返回前把 HTML 转成纯文本，避免把脚本/样式带进页面。
 */
'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { TextDecoder } = require('util');

const MAX_MESSAGES = 12;
const MAX_BODY_BYTES = 512 * 1024;
const TOTAL_TIMEOUT = 45000;
const TOKEN_TIMEOUT = 12000;

/* 微软个人账号（@outlook.com / @hotmail.com 等）的令牌端点。
 * 优先 consumers；部分账号只认 common，失败时回退一次。
 * scope 只需 IMAP 收信，并要求下发 refresh_token。 */
const TOKEN_URLS = [
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  'https://login.microsoftonline.com/common/oauth2/v2.0/token'
];
const OAUTH_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';

const ALLOWED_HOSTS = new Set([
  'outlook.office365.com',
  'outlook.office.com',
  'imap-mail.outlook.com',
  'imap.gmail.com',
  'imap.qq.com',
  'imap.163.com',
  'imap.126.com',
  'imap.sina.com',
  'imap.mail.yahoo.com',
  'imap.mail.me.com',
]);

const LOOPBACK = /^(127\.0\.0\.1|localhost)$/i;

function pickNumber(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function hostAllowed(host) {
  const h = String(host || '').trim().toLowerCase();
  if (ALLOWED_HOSTS.has(h)) return true;
  return LOOPBACK.test(h) && process.env.RELAY_MAIL_TEST === '1';
}

/* ---------------- IMAP 连接与逐行解析 ---------------- */

class ImapReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.err = null;
    this.closed = false;
    socket.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    socket.on('error', e => this.fail(e));
    socket.on('close', () => this.fail(new Error('IMAP 连接已关闭')));
  }

  fail(e) {
    if (!this.err) this.err = e;
    const list = this.waiters.splice(0);
    list.forEach(w => w.reject(e));
  }

  /* 读一条逻辑行：支持 IMAP literal（{n}\r\n<n bytes>），把 literal 收进 lits。
     数据不完整时返回 null，且不推进缓冲区。 */
  readLine() {
    const buf = this.buf;
    let pos = 0;
    let text = '';
    const lits = [];
    while (true) {
      const idx = buf.indexOf('\r\n', pos);
      if (idx < 0) return null;
      let seg = buf.slice(pos, idx).toString('utf8');
      pos = idx + 2;
      const m = /\{(\d+)\}$/.exec(seg);
      if (m) {
        const n = Number(m[1]);
        if (buf.length < pos + n) return null;
        lits.push(buf.slice(pos, pos + n));
        pos += n;
        text += seg.replace(/\{\d+\}$/, '{#}') + '\n';
        continue;
      }
      text += seg;
      this.buf = buf.slice(pos);
      return { text, lits };
    }
  }

  pump() {
    while (true) {
      const line = this.readLine();
      if (!line) break;
      this.queue.push(line);
    }
    while (this.waiters.length && this.queue.length) {
      this.waiters.shift().resolve(this.queue.shift());
    }
  }

  next(ms) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const w = {};
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('IMAP 响应超时'));
      }, ms);
      w.resolve = v => { clearTimeout(timer); resolve(v); };
      w.reject = e => { clearTimeout(timer); reject(e); };
      this.waiters.push(w);
    });
  }

  send(text) {
    if (!this.socket.destroyed) this.socket.write(text + '\r\n');
  }

  async command(tag, text, ms) {
    this.send(tag + ' ' + text);
    const lines = [];
    while (true) {
      const rec = await this.next(ms);
      lines.push(rec);
      if (rec.text.indexOf(tag + ' ') === 0) {
        const m = /^(\S+) (OK|NO|BAD)\b/i.exec(rec.text);
        return { lines, status: m ? m[2].toUpperCase() : 'BAD', text: rec.text };
      }
    }
  }
}

function connect(opts, ms) {
  return new Promise((resolve, reject) => {
    const secure = opts.secure !== false;
    const socket = secure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.connect({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('连接 IMAP 服务器超时'));
    }, ms);
    const onErr = e => {
      clearTimeout(timer);
      reject(new Error('连接 IMAP 服务器失败：' + (e && e.message ? e.message : '未知错误')));
    };
    socket.once('error', onErr);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onErr);
      resolve(socket);
    });
  });
}

function quote(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function cleanReply(text) {
  return String(text || '').replace(/^\S+\s+(OK|NO|BAD)\s*/i, '').trim().slice(0, 200);
}

function authError(text) {
  const t = String(text || '');
  if (/basic authentication is disabled|basic auth/i.test(t)) {
    return new Error('登录失败：微软已关闭 Outlook.com 的密码登录（Basic Auth），口令方式不可用，需要 OAuth2 授权；QQ / 163 / Gmail 可改用授权码或应用专用密码');
  }
  if (/AUTHENTICATIONFAILED|invalid credentials|LOGIN failed|authentication failed/i.test(t)) {
    return new Error('登录失败：账号或口令不正确，或服务商已关闭密码登录（Outlook 可改用应用专用密码）');
  }
  if (/application-specific password|app password/i.test(t)) {
    return new Error('服务商要求应用专用密码：请先在邮箱安全设置里生成，再填到口令里');
  }
  if (/LOGINDISABLED/i.test(t)) return new Error('服务商禁用了密码登录，请改用应用专用密码或 OAuth');
  return new Error('登录失败：' + (cleanReply(t) || '服务商拒绝登录'));
}

/* ---------------- OAuth2（XOAUTH2）---------------- */

function oauthError(text) {
  const t = String(text || '');
  if (/AUTHENTICATE failed|invalid authentication|invalid token|token.*(expired|invalid)|401/i.test(t)) {
    return new Error('OAuth2 登录被拒：访问令牌无效或已过期，请重新授权取得新的 refresh_token');
  }
  if (/basic authentication is disabled/i.test(t)) return authError(t);
  return new Error('OAuth2 登录失败：' + (cleanReply(t) || '服务商拒绝登录'));
}

/* POST 表单到微软令牌端点。失败信息里绝不回显请求体（含 refresh_token）。 */
function postForm(url, form, ms) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('OAuth2 令牌地址不合法')); return; }
    const body = Buffer.from(form, 'utf8');
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
        Accept: 'application/json'
      }
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size <= 64 * 1024) chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        resolve({ status: res.statusCode, data: data });
      });
    });
    req.setTimeout(ms || TOKEN_TIMEOUT, () => {
      req.destroy(new Error('获取 OAuth2 访问令牌超时'));
    });
    req.on('error', e => {
      reject(new Error('连接微软令牌服务失败：' + ((e && e.message) || '未知错误')));
    });
    req.end(body);
  });
}

function tokenError(status, data) {
  const d = data || {};
  const code = String(d.error || '').trim();
  const desc = String(d.error_description || d.message || '').split('\n')[0].slice(0, 200);
  if (code === 'invalid_grant') {
    return new Error('OAuth2 授权已失效：refresh_token 已过期或被撤销，请重新授权获取新令牌');
  }
  if (code === 'invalid_client') {
    return new Error('OAuth2 授权失败：client_id 不正确或该应用未获授权');
  }
  if (code === 'unauthorized_client') {
    return new Error('OAuth2 授权失败：该应用不能用个人账号（consumers）授权，请确认 client_id 类型');
  }
  if (code === 'invalid_scope') {
    return new Error('OAuth2 授权缺少所需权限（invalid_scope）：该 refresh_token 没有开通此操作，需要重新授权');
  }
  if (/AADSTS70000|AADSTS700082|AADSTS50173/.test(desc)) {
    return new Error('OAuth2 授权已失效：refresh_token 已过期或被撤销，请重新授权');
  }
  return new Error('获取 OAuth2 访问令牌失败' + (code ? '（' + code + '）' : '') +
    '：' + (desc || ('HTTP ' + status)));
}

/* 用 refresh_token 换 access_token。
 * tokenUrl 只允许测试环境覆盖（假令牌服务器），生产环境固定走微软端点。 */
async function getAccessToken(opts) {
  const clientId = String((opts && opts.clientId) || '').trim();
  const refreshToken = String((opts && opts.refreshToken) || '').trim();
  if (!clientId || !refreshToken) {
    throw new Error('缺少 OAuth2 的 client_id 或 refresh_token');
  }
  const urls = [];
  const override = String((opts && opts.tokenUrl) || '').trim();
  if (override) {
    if (process.env.RELAY_MAIL_TEST !== '1') {
      throw new Error('自定义令牌地址只允许在测试模式下使用');
    }
    urls.push(override);
  } else {
    urls.push(TOKEN_URLS[0], TOKEN_URLS[1]);
  }
  const baseForm = 'grant_type=refresh_token' +
    '&client_id=' + encodeURIComponent(clientId) +
    '&refresh_token=' + encodeURIComponent(refreshToken);
  /* 卡密里的 refresh_token 可能只授权了别的 scope（例如 REST 而不是 IMAP），
   * 此时带 scope 申请会 invalid_scope；去掉 scope 再试一次，微软会按原授权范围签发。 */
  const scopes = [String((opts && opts.scope) || OAUTH_SCOPE), ''];
  let last = null;
  for (let s = 0; s < scopes.length; s++) {
    const form = baseForm + (scopes[s] ? '&scope=' + encodeURIComponent(scopes[s]) : '');
    let retryScope = false;
    for (let i = 0; i < urls.length; i++) {
      let out;
      try {
        out = await postForm(urls[i], form, TOKEN_TIMEOUT);
      } catch (e) {
        last = e;
        continue;
      }
      const data = out.data || {};
      if (out.status >= 200 && out.status < 300 && data.access_token) {
        return String(data.access_token);
      }
      last = tokenError(out.status, data);
      const code = String(data.error || '');
      if (code === 'invalid_scope' && scopes[s]) { retryScope = true; break; }
      /* 授权类错误换端点也没用，直接报中文原因 */
      if (/invalid_grant|invalid_client|unauthorized_client/.test(code)) break;
    }
    if (!retryScope) break;
  }
  throw last || new Error('获取 OAuth2 访问令牌失败');
}

/* AUTHENTICATE XOAUTH2 握手：
 *   C: A1 AUTHENTICATE XOAUTH2
 *   S: +
 *   C: base64(user=...\x01auth=Bearer ...\x01\x01)
 *   S: A1 OK ...
 * 服务端若回 "+ <base64 错误>"，需要再发一个空行，它才会给出带原因的 NO。 */
async function authOauth2(r, user, token, tag, ms) {
  r.send(tag + ' AUTHENTICATE XOAUTH2');
  const payload = Buffer.from('user=' + user + '\x01auth=Bearer ' + token + '\x01\x01', 'utf8')
    .toString('base64');
  let step = 0;
  const lines = [];
  while (true) {
    const rec = await r.next(ms);
    lines.push(rec.text);
    if (rec.text.indexOf(tag + ' ') === 0) {
      const m = /^\S+ (OK|NO|BAD)\b/i.exec(rec.text);
      const status = m ? m[1].toUpperCase() : 'BAD';
      if (status !== 'OK') throw oauthError(lines.join('\n'));
      return;
    }
    if (rec.text.charAt(0) === '+') {
      if (step === 0) {
        r.send(payload);
        step = 1;
      } else {
        r.send('');
        step++;
        if (step > 3) throw oauthError(lines.join('\n'));
      }
    }
  }
}

/* ---------------- 邮件解码 ---------------- */

function findHeaderEnd(buf) {
  const a = buf.indexOf('\r\n\r\n');
  const b = buf.indexOf('\n\n');
  if (a < 0 && b < 0) return null;
  if (a >= 0 && (b < 0 || a <= b)) return { at: a, next: a + 4 };
  return { at: b, next: b + 2 };
}

function parseHeaders(text) {
  const map = {};
  let last = '';
  String(text || '').split(/\r?\n/).forEach(line => {
    if (/^[ \t]/.test(line) && last) {
      map[last] += ' ' + line.trim();
      return;
    }
    const i = line.indexOf(':');
    if (i <= 0) return;
    last = line.slice(0, i).trim().toLowerCase();
    map[last] = line.slice(i + 1).trim();
  });
  return map;
}

function decodeBuffer(buf, charset) {
  const cs = String(charset || 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  const name = cs === 'gb2312' ? 'gbk' : cs;
  try {
    return new TextDecoder(name).decode(buf);
  } catch (e) {
    try { return new TextDecoder('utf-8').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}

function qpDecode(buf, underscore) {
  if (underscore) buf = Buffer.from(buf.toString('latin1').replace(/_/g, ' '), 'latin1');
  const s = buf.toString('latin1').replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : qpDecode(Buffer.from(data, 'utf8'), true);
      return decodeBuffer(buf, charset);
    } catch (e) {
      return m;
    }
  });
}

function parseAddress(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  const m = /^"?([^"<]*)"?\s*<([^>]+)>/.exec(str);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  const e = /[^\s<>"',;]+@[^\s<>"',;]+/.exec(str);
  return e ? { name: '', address: e[0].toLowerCase() } : null;
}

function decodeTransfer(buf, cte) {
  const enc = String(cte || '').toLowerCase();
  if (enc.indexOf('base64') >= 0) {
    return Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64');
  }
  if (enc.indexOf('quoted-printable') >= 0) return qpDecode(buf, false);
  return buf;
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  s = s.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
  return s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitParts(buf, boundary) {
  const mark = Buffer.from('--' + boundary);
  const idxs = [];
  let i = buf.indexOf(mark);
  while (i >= 0) {
    idxs.push(i);
    i = buf.indexOf(mark, i + mark.length);
  }
  const out = [];
  for (let k = 0; k < idxs.length - 1; k++) {
    let seg = buf.slice(idxs[k] + mark.length, idxs[k + 1]);
    if (seg.slice(0, 2).toString() === '--') break;
    if (seg.slice(0, 2).toString() === '\r\n') seg = seg.slice(2);
    else if (seg.slice(0, 1).toString() === '\n') seg = seg.slice(1);
    const sp = findHeaderEnd(seg);
    out.push({
      headText: (sp ? seg.slice(0, sp.at) : seg).toString('utf8'),
      body: sp ? seg.slice(sp.next) : Buffer.alloc(0)
    });
  }
  return out;
}

function extractText(headers, body, depth) {
  const ct = headers['content-type'] || 'text/plain';
  const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(ct);
  if (/^multipart\//i.test(ct) && boundary && depth < 3) {
    const parts = splitParts(body, boundary[1]);
    let plain = '';
    let html = '';
    parts.forEach(p => {
      const ph = parseHeaders(p.headText);
      const text = extractText(ph, p.body, depth + 1);
      if (/text\/plain/i.test(ph['content-type'] || '')) {
        if (!plain) plain = text;
      } else if (/text\/html/i.test(ph['content-type'] || '')) {
        if (!html) html = text;
      } else if (!plain) {
        plain = text;
      }
    });
    return plain || html;
  }
  const decoded = decodeTransfer(body, headers['content-transfer-encoding']);
  const cs = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  let text = decodeBuffer(decoded, cs ? cs[1] : 'utf-8');
  if (/text\/html/i.test(ct)) text = htmlToText(text);
  return text;
}

function parseMail(raw) {
  const buf = raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
  const sp = findHeaderEnd(buf);
  const headers = parseHeaders((sp ? buf.slice(0, sp.at) : buf).toString('utf8'));
  const body = sp ? buf.slice(sp.next) : Buffer.alloc(0);
  return {
    subject: decodeWords(headers.subject || ''),
    from: parseAddress(decodeWords(headers.from || '')),
    createdAt: headers.date || '',
    text: extractText(headers, body, 0)
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function imapDateToIso(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(String(s || '').trim());
  if (!m) return '';
  const mon = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase());
  if (mon < 0) return '';
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const ms = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
    - offset * 60000;
  return new Date(ms).toISOString();
}

function parseFetch(lines) {
  const out = [];
  lines.forEach(rec => {
    if (!/^\*\s+\d+\s+FETCH\s+/i.test(rec.text)) return;
    const uid = /UID\s+(\d+)/i.exec(rec.text);
    if (!uid) return;
    const flags = /FLAGS\s+\(([^)]*)\)/i.exec(rec.text);
    const date = /INTERNALDATE\s+"([^"]+)"/i.exec(rec.text);
    const raw = rec.lits[0] || Buffer.alloc(0);
    const mail = parseMail(raw);
    const createdAt = mail.createdAt && !isNaN(new Date(mail.createdAt).getTime())
      ? new Date(mail.createdAt).toISOString()
      : imapDateToIso(date ? date[1] : '');
    out.push({
      id: 'imap:' + uid[1],
      subject: mail.subject || '(无主题)',
      from: mail.from,
      createdAt: createdAt,
      seen: flags ? /\\Seen/i.test(flags[1]) : false,
      text: mail.text ? mail.text.slice(0, 20000) : '',
      loaded: true
    });
  });
  return out;
}

async function imapFetch(opts) {
  const host = String((opts && opts.host) || '').trim().toLowerCase();
  const port = pickNumber(opts && opts.port, 993, 1, 65535);
  const secure = !(opts && opts.secure === false);
  const user = String((opts && opts.user) || (opts && opts.address) || '').trim();
  const pass = String((opts && opts.password) || '');
  const clientId = String((opts && opts.clientId) || '').trim();
  const refreshToken = String((opts && opts.refreshToken) || '').trim();
  const oauth = !!(clientId && refreshToken);
  const limit = pickNumber(opts && opts.limit, 8, 1, MAX_MESSAGES);

  if (!host) throw new Error('缺少 IMAP 主机');
  if (!hostAllowed(host)) throw new Error('这个 IMAP 主机不在允许列表里：' + host);
  if (!user) throw new Error('缺少邮箱地址');
  if (!oauth && !pass) throw new Error('缺少邮箱地址或口令');
  if (!secure && LOOPBACK.test(host) && process.env.RELAY_MAIL_TEST !== '1') {
    throw new Error('测试用的明文 IMAP 连接已被禁用');
  }

  /* 先换访问令牌：这一步失败就没必要连 IMAP（也不计进 45 秒收信预算）。 */
  const accessToken = oauth
    ? await getAccessToken({ clientId, refreshToken, tokenUrl: opts && opts.tokenUrl })
    : '';

  const deadline = Date.now() + TOTAL_TIMEOUT;
  const left = () => Math.max(1000, deadline - Date.now());
  const socket = await connect({ host, port, secure }, Math.min(12000, left()));
  const r = new ImapReader(socket);
  try {
    const greet = await r.next(Math.min(12000, left()));
    if (!/^\* (OK|PREAUTH)/i.test(greet.text)) {
      throw new Error('IMAP 服务器没有正常握手：' + cleanReply(greet.text));
    }

    if (oauth) {
      await authOauth2(r, user, accessToken, 'A1', left());
    } else {
      const auth = await r.command('A1', 'LOGIN ' + quote(user) + ' ' + quote(pass), left());
      if (auth.status !== 'OK') throw authError(auth.text);
    }

    const sel = await r.command('A2', 'SELECT "INBOX"', left());
    if (sel.status !== 'OK') throw new Error('打不开收件箱：' + cleanReply(sel.text));
    const exists = /^\*\s+(\d+)\s+EXISTS/m.exec(sel.lines.map(x => x.text).join('\n'));
    const total = exists ? Number(exists[1]) : 0;
    if (!total) {
      await r.command('A3', 'LOGOUT', 4000).catch(() => {});
      return { count: 0, messages: [] };
    }

    const start = Math.max(1, total - limit + 1);
    const fet = await r.command('A3',
      'FETCH ' + start + ':* (UID FLAGS INTERNALDATE BODY.PEEK[])', left());
    if (fet.status !== 'OK') throw new Error('读取邮件失败：' + cleanReply(fet.text));
    const messages = parseFetch(fet.lines);

    await r.command('A4', 'LOGOUT', 4000).catch(() => {});
    return { count: total, messages: messages };
  } finally {
    try { socket.destroy(); } catch (e) { /* 已断开 */ }
  }
}

/* 从 access_token（JWT）里读出授权范围，只用于展示，不返回令牌本身。 */
function tokenScopes(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return [];
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const scp = String(payload.scp || payload.roles || '');
    return scp ? scp.split(/[\s,]+/).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  imapFetch,
  getAccessToken,
  tokenScopes,
  parseMail,
  parseHeaders,
  decodeWords,
  htmlToText,
  imapDateToIso,
  ALLOWED_HOSTS
};
