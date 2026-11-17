/* 本地中转的 SMTP 发信模块。
 *
 * 与 mail.js 对称：浏览器连不上 SMTP（TCP + TLS），由本地中转代发，
 * 发完即断，不落盘、不写日志。
 *
 * 支持两种认证：
 *   ① 口令：AUTH LOGIN（QQ / 163 用授权码，Gmail 用应用专用密码）；
 *   ② OAuth2：AUTH XOAUTH2（Outlook 已关闭密码登录，必须走这条）。
 *
 * 安全边界：
 *   ① 只允许常见邮箱的 SMTP 主机；
 *   ② 单封正文最多 20KB，收件人 1 个，整体 40 秒超时；
 *   ③ 正文只发纯文本，不做 HTML，避免把脚本带进对方邮箱。
 */
'use strict';

const net = require('net');
const tls = require('tls');
const { getAccessToken } = require('./mail');

const MAX_SUBJECT = 200;
const MAX_BODY = 20 * 1024;
const TOTAL_TIMEOUT = 40000;

/* 发信需要单独的 SMTP.Send 权限；与收信令牌分开申请，缺少时给出明确提示。 */
const SMTP_SCOPE = 'https://outlook.office.com/SMTP.Send offline_access';

const ALLOWED_HOSTS = new Set([
  'smtp.office365.com',
  'smtp-mail.outlook.com',
  'smtp.gmail.com',
  'smtp.qq.com',
  'smtp.163.com',
  'smtp.126.com',
  'smtp.sina.com',
  'smtp.mail.yahoo.com',
  'smtp.mail.me.com'
]);

const LOOPBACK = /^(127\.0\.0\.1|localhost)$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function hostAllowed(host) {
  const h = String(host || '').trim().toLowerCase();
  if (ALLOWED_HOSTS.has(h)) return true;
  return LOOPBACK.test(h) && process.env.RELAY_MAIL_TEST === '1';
}

function pickNumber(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/* ---------------- 连接与回复解析 ---------------- */

class SmtpConn {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.err = null;
    this.gen = 0;
    this.upgrading = false;
    this.attach(socket);
  }

  attach(socket) {
    const gen = ++this.gen;
    this.socket = socket;
    socket.on('data', d => {
      if (gen !== this.gen) return;
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    socket.on('error', e => {
      if (gen !== this.gen) return;
      this.fail(e);
    });
    socket.on('close', () => {
      if (gen !== this.gen || this.upgrading) return;
      this.fail(new Error('SMTP 连接已关闭'));
    });
  }

  fail(e) {
    if (!this.err) this.err = e;
    const list = this.waiters.splice(0);
    list.forEach(w => w.reject(e));
  }

  readLine() {
    const idx = this.buf.indexOf('\r\n');
    if (idx < 0) return null;
    const line = this.buf.slice(0, idx).toString('utf8');
    this.buf = this.buf.slice(idx + 2);
    return line;
  }

  pump() {
    while (true) {
      const line = this.readLine();
      if (line == null) break;
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
        reject(new Error('SMTP 响应超时'));
      }, ms);
      w.resolve = v => { clearTimeout(timer); resolve(v); };
      w.reject = e => { clearTimeout(timer); reject(e); };
      this.waiters.push(w);
    });
  }

  send(text) {
    if (this.socket && !this.socket.destroyed) this.socket.write(text + '\r\n');
  }

  /* SMTP 多行回复：250-... 继续，250 ... 结束。 */
  async readReply(ms) {
    const lines = [];
    while (true) {
      const line = await this.next(ms);
      lines.push(line);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (m && m[2] === ' ') return { code: Number(m[1]), text: lines.join('\n') };
      if (lines.length > 40) return { code: 0, text: lines.join('\n') };
    }
  }

  async command(text, ms) {
    this.send(text);
    return this.readReply(ms);
  }
}

function connect(opts, ms) {
  return new Promise((resolve, reject) => {
    const secure = opts.secure === true;
    const socket = secure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.connect({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('连接 SMTP 服务器超时'));
    }, ms);
    const onErr = e => {
      clearTimeout(timer);
      reject(new Error('连接 SMTP 服务器失败：' + (e && e.message ? e.message : '未知错误')));
    };
    socket.once('error', onErr);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onErr);
      resolve(socket);
    });
  });
}

function startTls(socket, host, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP STARTTLS 超时'));
    }, ms);
    const t = tls.connect({ socket: socket, servername: host }, () => {
      clearTimeout(timer);
      resolve(t);
    });
    t.once('error', e => {
      clearTimeout(timer);
      reject(new Error('SMTP STARTTLS 失败：' + (e && e.message ? e.message : '未知错误')));
    });
  });
}

function b64(s) {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
}

function authError(reply) {
  const t = String((reply && reply.text) || '');
  if (/basic authentication is disabled/i.test(t)) {
    return new Error('发信认证失败：微软已关闭 Outlook.com 的密码登录，需要 OAuth2 授权');
  }
  if (/AUTHENTICATE failed|5\.7\.139|invalid credentials|authentication failed/i.test(t)) {
    return new Error('发信认证失败：账号或凭证被拒绝（QQ / 163 用授权码，Outlook 需要 OAuth2）');
  }
  return new Error('发信认证失败：' + (t.replace(/\r?\n/g, ' ').slice(0, 180) || '服务商拒绝登录'));
}

async function authLogin(c, user, pass, ms) {
  let r = await c.command('AUTH LOGIN', ms);
  if (r.code !== 334) throw authError(r);
  r = await c.command(b64(user), ms);
  if (r.code !== 334) throw authError(r);
  r = await c.command(b64(pass), ms);
  if (r.code !== 235) throw authError(r);
}

async function authXoauth2(c, user, token, ms) {
  c.send('AUTH XOAUTH2 ' + b64('user=' + user + '\x01auth=Bearer ' + token + '\x01\x01'));
  let r = await c.readReply(ms);
  if (r.code === 334) {
    /* 失败挑战：补一个空行，服务端才会给出带原因的 535。 */
    r = await c.command('', ms);
  }
  if (r.code !== 235) throw authError(r);
}

/* 纯文本邮件：主题按 RFC 2047 编码，正文 base64，避免中文/换行在传输中被改。 */
function buildMessage(from, to, subject, body) {
  const date = new Date().toUTCString();
  const host = String(from).split('@')[1] || 'maildesk.local';
  const id = '<' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10) + '@' + host + '>';
  const bodyB64 = Buffer.from(String(body), 'utf8').toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [
    'From: <' + from + '>',
    'To: <' + to + '>',
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'Date: ' + date,
    'Message-ID: ' + id,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64
  ].join('\r\n');
}

function dotStuff(text) {
  return String(text).split('\r\n').map(line => (line.charAt(0) === '.' ? '.' + line : line)).join('\r\n');
}

async function smtpSend(opts) {
  const host = String((opts && opts.host) || '').trim().toLowerCase();
  const port = pickNumber(opts && opts.port, 587, 1, 65535);
  const secure = !!(opts && opts.secure === true);
  const user = String((opts && opts.user) || (opts && opts.address) || '').trim();
  const pass = String((opts && opts.password) || '');
  const clientId = String((opts && opts.clientId) || '').trim();
  const refreshToken = String((opts && opts.refreshToken) || '').trim();
  const oauth = !!(clientId && refreshToken);
  const to = String((opts && opts.to) || '').trim().toLowerCase();
  const subject = String((opts && opts.subject) || '').replace(/[\r\n]+/g, ' ').trim() || '(无主题)';
  const body = String((opts && opts.body) || '');

  if (!host) throw new Error('缺少 SMTP 主机');
  if (!hostAllowed(host)) throw new Error('这个 SMTP 主机不在允许列表里：' + host);
  if (!user || !EMAIL_RE.test(user)) throw new Error('缺少有效的发件地址');
  if (!oauth && !pass) throw new Error('缺少口令或 OAuth2 令牌，无法发信');
  if (!to || !EMAIL_RE.test(to)) throw new Error('收件人地址不正确');
  if (subject.length > MAX_SUBJECT) throw new Error('主题太长（最多 ' + MAX_SUBJECT + ' 字）');
  if (body.length > MAX_BODY) throw new Error('正文太长（最多 ' + Math.round(MAX_BODY / 1024) + 'KB）');
  if (!secure && LOOPBACK.test(host) && process.env.RELAY_MAIL_TEST !== '1') {
    throw new Error('测试用的明文 SMTP 连接已被禁用');
  }

  const accessToken = oauth
    ? await getAccessToken({ clientId, refreshToken, tokenUrl: opts && opts.tokenUrl, scope: SMTP_SCOPE })
    : '';

  const deadline = Date.now() + TOTAL_TIMEOUT;
  const left = () => Math.max(1000, deadline - Date.now());
  let socket = await connect({ host, port, secure }, Math.min(12000, left()));
  const c = new SmtpConn(socket);
  try {
    let r = await c.readReply(Math.min(12000, left()));
    if (r.code !== 220) throw new Error('SMTP 服务器没有正常握手：' + r.text.slice(0, 120));

    let ehlo = await c.command('EHLO maildesk.local', left());
    if (ehlo.code !== 250) throw new Error('SMTP EHLO 失败：' + ehlo.text.slice(0, 120));

    if (!secure) {
      if (opts && opts.starttls === false) {
        if (!LOOPBACK.test(host) || process.env.RELAY_MAIL_TEST !== '1') {
          throw new Error('明文 SMTP 只允许在测试模式下使用');
        }
      } else {
        r = await c.command('STARTTLS', left());
        if (r.code !== 220) throw new Error('SMTP 服务器不支持 STARTTLS');
        c.upgrading = true;
        c.gen++;  /* 旧明文 socket 的 data/close 不再进入队列，交给 TLS 层接管 */
        socket = await startTls(c.socket, host, Math.min(12000, left()));
        c.attach(socket);
        c.upgrading = false;
        ehlo = await c.command('EHLO maildesk.local', left());
        if (ehlo.code !== 250) throw new Error('STARTTLS 后 EHLO 失败');
      }
    }

    if (oauth) await authXoauth2(c, user, accessToken, left());
    else await authLogin(c, user, pass, left());

    r = await c.command('MAIL FROM:<' + user + '>', left());
    if (r.code !== 250) throw new Error('发件人被拒绝：' + r.text.slice(0, 160));

    r = await c.command('RCPT TO:<' + to + '>', left());
    if (r.code !== 250 && r.code !== 251) throw new Error('收件人被拒绝：' + r.text.slice(0, 160));

    r = await c.command('DATA', left());
    if (r.code !== 354) throw new Error('SMTP 未接受正文：' + r.text.slice(0, 120));

    c.send(dotStuff(buildMessage(user, to, subject, body)) + '\r\n.');
    r = await c.readReply(left());
    if (r.code !== 250) throw new Error('邮件发送失败：' + r.text.slice(0, 160));

    await c.command('QUIT', 4000).catch(() => {});
    return { ok: true, accepted: [to] };
  } finally {
    try { socket.destroy(); } catch (e) { /* 已断开 */ }
  }
}

module.exports = {
  smtpSend,
  ALLOWED_HOSTS
};
