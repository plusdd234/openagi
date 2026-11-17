/* 隧道服务：把本机变成一个「可上传资源 + 可提交反馈」的分享站点，再用免费隧道暴露到公网。
 *
 * 组成：
 *   1) 本地 HTTP 服务（本机管理接口 + 对外页面）
 *   2) cloudflared quick tunnel（免费、无需账号；每次启动域名都会变）
 *
 * 三条硬约束（都是安全相关的，不要为了省事删掉）：
 *   ① 管理接口只接受本机 Host（127.0.0.1/localhost），且请求不带 Cloudflare 转发头。
 *      否则公网访问者拿着隧道地址就能读上传列表、改配置。
 *   ② 上传目录与「网站根」是两回事：上传的文件只落盘，不会被 HTTP 再提供出去，
 *      避免有人上传 .html 后在本站执行脚本。
 *   ③ 上传/反馈都限速、限体积；公网页面永不回传本机路径与口令。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const site = require('./site');
const dl = require('./tunnel-download');

const PORT = Number(process.env.PORT || 8796);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.TUNNEL_DIR || path.join(os.homedir(), '.openagi-tunnel');
const UPLOADS = path.join(DATA, 'uploads');
const BIN_DIR = path.join(DATA, 'bin');
const CONFIG_FILE = path.join(DATA, 'config.json');
const FEEDBACK_FILE = path.join(DATA, 'feedback.jsonl');
const UPLOAD_INDEX = path.join(DATA, 'uploads.jsonl');

const IS_WIN = process.platform === 'win32';
const EXE_NAME = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
const EXE = path.join(BIN_DIR, EXE_NAME);
const CF_ASSET = IS_WIN
  ? 'cloudflared-windows-amd64.exe'
  : (process.platform === 'linux' ? 'cloudflared-linux-amd64' : '');
const CF_URL = CF_ASSET
  ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + CF_ASSET
  : '';

const REALM_MAX = 300;

/* ---------------- 基础 ---------------- */

function ensureDirs() {
  [DATA, UPLOADS, BIN_DIR].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  });
}

function genKey() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

const DEFAULT_CONFIG = {
  keyOn: true,
  key: '',
  maxMB: 200,
  feedbackOn: true,
  note: '欢迎上传素材、模型或文档，也欢迎留下你的意见与反馈，一起把这个开源工程做得更好。'
};

let cfgCache = null;
function config() {
  if (cfgCache) return cfgCache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (e) { raw = {}; }
  const c = Object.assign({}, DEFAULT_CONFIG, raw);
  if (!c.key) c.key = genKey();
  if (!Number(c.maxMB) || c.maxMB < 1) c.maxMB = DEFAULT_CONFIG.maxMB;
  c.maxMB = Math.min(2048, Math.round(Number(c.maxMB)));
  cfgCache = c;
  saveConfig();
  return c;
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfgCache || {}, null, 2), 'utf8');
  } catch (e) { log('配置保存失败：' + e.message); }
}

function patchConfig(patch) {
  const c = config();
  if (patch && typeof patch === 'object') {
    if (typeof patch.keyOn === 'boolean') c.keyOn = patch.keyOn;
    if (typeof patch.feedbackOn === 'boolean') c.feedbackOn = patch.feedbackOn;
    if (typeof patch.note === 'string') c.note = patch.note.slice(0, 300);
    if (patch.maxMB != null) {
      const n = Number(patch.maxMB);
      if (n > 0) c.maxMB = Math.min(2048, Math.round(n));
    }
    if (typeof patch.key === 'string' && patch.key.trim()) c.key = patch.key.trim().slice(0, 40);
  }
  saveConfig();
  return c;
}

const logs = [];
function log(line) {
  const s = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!s) return;
  const item = { at: new Date().toISOString(), text: s };
  logs.push(item);
  if (logs.length > REALM_MAX) logs.shift();
  try { console.log('[tunnel] ' + s); } catch (e) {}
}

function tail(n) {
  return logs.slice(-Math.max(1, Math.min(REALM_MAX, n || 40)));
}

function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) { log('写入失败 ' + path.basename(file) + '：' + e.message); }
}

function readJsonl(file, limit) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < (limit || 200); i--) {
    try { out.push(JSON.parse(lines[i])); } catch (e) {}
  }
  return out;
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  } catch (e) { return 0; }
}

/* ---------------- 状态 ---------------- */

const state = {
  tunnel: { status: 'idle', url: '', error: '', startedAt: 0 },
  download: null,
  cf: null,
  stopTimer: null,
  urlTimer: null
};

function publicTunnel() {
  return {
    status: state.tunnel.status,
    url: state.tunnel.url || '',
    error: state.tunnel.error || '',
    startedAt: state.tunnel.startedAt || 0
  };
}

function statusPayload() {
  const c = config();
  return {
    ok: true,
    port: PORT,
    local: 'http://' + HOST + ':' + PORT,
    tunnel: publicTunnel(),
    config: { keyOn: c.keyOn, key: c.key, maxMB: c.maxMB, feedbackOn: c.feedbackOn, note: c.note },
    counts: { uploads: countLines(UPLOAD_INDEX), feedback: countLines(FEEDBACK_FILE) },
    download: state.download,
    bin: { path: EXE, ready: isFile(EXE) },
    dataDir: DATA,
    logs: tail(40)
  };
}

function isFile(p) {
  try { return fs.statSync(p).size > 1024 * 1024; } catch (e) { return false; }
}

/* ---------------- 限速 ---------------- */

const rate = new Map();
function rateOk(ip, kind) {
  const now = Date.now();
  const key = kind + ':' + (ip || 'unknown');
  const hit = rate.get(key) || { n: 0, t: now };
  if (now - hit.t > 60000) { hit.n = 0; hit.t = now; }
  hit.n++;
  rate.set(key, hit);
  const limit = kind === 'up' ? 30 : 20;
  if (rate.size > 2000) rate.clear();
  return hit.n <= limit;
}

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
}

/* ---------------- HTTP 工具 ---------------- */

function json(res, code, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function html(res, code, body) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function cookie(req, name) {
  const raw = String(req.headers.cookie || '');
  const parts = raw.split(';');
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    if (p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return '';
}

/* 本机请求：Host 是 127.0.0.1/localhost，且没有 Cloudflare 转发头。
 * 隧道回源同样来自 127.0.0.1，所以 Host + CF 头两个条件都要看。 */
function isLocal(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-visitor']) return false;
  const host = String(req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
}

/* 只允许「本地页面 / Electron app:// / 测试脚本」跨域调用管理接口。
 * 任意网站（Origin 是 https://xxx）拿不到本机数据。 */
function applyCors(req, res) {
  const origin = req.headers.origin || '';
  let allow = !origin || origin === 'null' || origin.indexOf('file://') === 0 ||
    origin.indexOf('app://') === 0 || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (!allow) return false;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-note');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function authed(req, url) {
  const c = config();
  if (!c.keyOn) return true;
  const given = url.searchParams.get('k') || cookie(req, 'tk');
  return !!given && given === c.key;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('内容过大'));
        try { req.destroy(); } catch (e) {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- 对外接口 ---------------- */

function safeName(raw) {
  let s = String(raw || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
  s = path.basename(s).replace(/^\.+/, '');
  if (!s) s = 'file';
  if (s.length > 100) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function handleUpload(req, res, url) {
  const c = config();
  if (!authed(req, url)) return json(res, 401, { error: '口令不正确' });
  if (!rateOk(clientIp(req), 'up')) return json(res, 429, { error: '提交太频繁，请稍后再试' });

  const max = c.maxMB * 1024 * 1024;
  const len = Number(req.headers['content-length'] || 0);
  if (len && len > max) return json(res, 413, { error: '文件超过 ' + c.maxMB + ' MB' });

  const name = safeName(url.searchParams.get('name'));
  const rel = stamp() + '-' + name;
  const abs = path.join(UPLOADS, rel);
  const note = decodeURIComponent(String(req.headers['x-note'] || '')).slice(0, 200);

  let size = 0;
  let failed = false;
  const ws = fs.createWriteStream(abs);
  const cleanup = () => {
    try { ws.destroy(); } catch (e) {}
    try { fs.unlinkSync(abs); } catch (e) {}
  };

  req.on('data', chunk => {
    size += chunk.length;
    if (size > max && !failed) {
      failed = true;
      cleanup();
      json(res, 413, { error: '文件超过 ' + c.maxMB + ' MB' });
      try { req.destroy(); } catch (e) {}
    }
  });
  req.on('aborted', cleanup);
  ws.on('error', e => {
    if (!failed) {
      failed = true;
      cleanup();
      json(res, 500, { error: '写入失败：' + e.message });
    }
  });
  ws.on('finish', () => {
    if (failed) return;
    appendJsonl(UPLOAD_INDEX, {
      name: name,
      rel: rel,
      size: size,
      at: new Date().toISOString(),
      ip: clientIp(req),
      note: note
    });
    log('收到文件 ' + name + '（' + (size / 1048576).toFixed(2) + ' MB）');
    json(res, 200, { ok: true, name: name, size: size });
  });
  req.pipe(ws);
}

async function handleFeedback(req, res, url) {
  if (!authed(req, url)) return json(res, 401, { error: '口令不正确' });
  if (!config().feedbackOn) return json(res, 403, { error: '反馈通道已关闭' });
  if (!rateOk(clientIp(req), 'fb')) return json(res, 429, { error: '提交太频繁，请稍后再试' });

  let body = '';
  try { body = await readBody(req, 48 * 1024); } catch (e) { return json(res, 413, { error: '内容过大' }); }
  let data = {};
  try { data = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { error: '格式不正确' }); }

  const text = String(data.text || '').trim().slice(0, 4000);
  if (!text) return json(res, 400, { error: '内容不能为空' });

  const item = {
    name: String(data.name || '').trim().slice(0, 40),
    contact: String(data.contact || '').trim().slice(0, 80),
    text: text,
    at: new Date().toISOString(),
    ip: clientIp(req)
  };
  appendJsonl(FEEDBACK_FILE, item);
  log('收到反馈：' + text.slice(0, 40));
  json(res, 200, { ok: true });
}

/* ---------------- 隧道进程 ---------------- */

let downloadPromise = null;

/* 同一次运行里只下载一份：用户中途点「停止」再点「启动」时，
   第二次启动应该等第一次的下载，而不是报「正在下载」。 */
function resolveExe() {
  if (isFile(EXE)) return Promise.resolve(EXE);
  if (!CF_URL) return Promise.reject(new Error('当前平台不支持自动下载 cloudflared，请手动安装后加入 PATH'));
  if (downloadPromise) return downloadPromise;

  state.download = { running: true, got: 0, total: 0, pct: 0, source: '', error: '' };
  log('首次使用，开始下载 cloudflared（约 55 MB，支持断点续传）');
  downloadPromise = dl.ensure(CF_URL, EXE, {
    onProgress: p => {
      state.download = Object.assign({ running: true, error: '' }, p);
    }
  }).then(r => {
    state.download = { running: false, got: r.bytes, total: r.bytes, pct: 100, source: '', error: '' };
    log('cloudflared 已就绪（' + (r.bytes / 1048576).toFixed(1) + ' MB）');
    downloadPromise = null;
    return EXE;
  }).catch(e => {
    state.download = { running: false, got: 0, total: 0, pct: 0, source: '', error: e.message };
    downloadPromise = null;
    throw e;
  });
  return downloadPromise;
}

function cfVersion(exe) {
  return new Promise(resolve => {
    execFile(exe, ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

function clearTimers() {
  if (state.stopTimer) { clearTimeout(state.stopTimer); state.stopTimer = null; }
  if (state.urlTimer) { clearTimeout(state.urlTimer); state.urlTimer = null; }
}

function stopTunnel() {
  startSeq++;            // 让正在下载/自检中的启动流程作废
  clearTimers();
  const child = state.cf;
  state.cf = null;
  if (child) {
    try { child.kill(); } catch (e) {}
    log('隧道已停止');
  }
  state.tunnel = { status: 'idle', url: '', error: '', startedAt: 0 };
  return publicTunnel();
}

let startSeq = 0;

async function startTunnel() {
  if (state.tunnel.status === 'running' || state.tunnel.status === 'starting') {
    return { ok: false, error: '隧道已经在运行', tunnel: publicTunnel() };
  }
  const seq = ++startSeq;
  state.tunnel = { status: 'starting', url: '', error: '', startedAt: Date.now() };
  log('正在启动隧道…');

  let exe;
  try {
    exe = await resolveExe();
  } catch (e) {
    state.tunnel = { status: 'error', url: '', error: e.message, startedAt: Date.now() };
    log('启动失败：' + e.message);
    return { ok: false, error: e.message, tunnel: publicTunnel() };
  }

  if (seq !== startSeq) {
    // 下载期间用户点了「停止」：下载结果保留，但不再拉起隧道
    log('启动已取消（下载结果已保留，下次启动可直接使用）');
    return { ok: false, error: '已取消', tunnel: publicTunnel() };
  }

  const ver = await cfVersion(exe);
  if (!ver) {
    state.tunnel = { status: 'error', url: '', error: 'cloudflared 无法运行（文件可能不完整）', startedAt: Date.now() };
    return { ok: false, error: state.tunnel.error, tunnel: publicTunnel() };
  }
  if (seq !== startSeq) return { ok: false, error: '已取消', tunnel: publicTunnel() };
  log(ver);

  const args = ['tunnel', '--url', 'http://' + HOST + ':' + PORT, '--no-autoupdate'];
  let child;
  try {
    child = spawn(exe, args, { windowsHide: true });
  } catch (e) {
    state.tunnel = { status: 'error', url: '', error: e.message, startedAt: Date.now() };
    return { ok: false, error: e.message, tunnel: publicTunnel() };
  }
  state.cf = child;

  let buf = '';
  const onChunk = chunk => {
    buf += String(chunk);
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    lines.forEach(line => {
      const clean = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (!clean) return;
      log(clean);
      if (!state.tunnel.url) {
        const m = clean.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          state.tunnel.url = m[0];
          state.tunnel.status = 'running';
          log('公网地址：' + m[0]);
        }
      }
    });
  };
  if (child.stdout) child.stdout.on('data', onChunk);
  if (child.stderr) child.stderr.on('data', onChunk);

  child.on('exit', code => {
    if (state.cf !== child) return;
    state.cf = null;
    clearTimers();
    if (state.tunnel.status === 'starting') {
      state.tunnel = { status: 'error', url: '', error: 'cloudflared 退出（code=' + code + '）', startedAt: Date.now() };
    } else {
      state.tunnel = { status: 'idle', url: '', error: 'cloudflared 已退出（code=' + code + '）', startedAt: 0 };
    }
    log('cloudflared 退出，code=' + code);
  });
  child.on('error', e => {
    state.tunnel = { status: 'error', url: '', error: e.message, startedAt: Date.now() };
    log('cloudflared 启动错误：' + e.message);
  });

  // 90 秒还没拿到域名就判定失败：继续挂着只会让人以为「在启动」
  state.urlTimer = setTimeout(() => {
    if (state.tunnel.status === 'starting' && state.cf === child) {
      state.tunnel = { status: 'error', url: '', error: '90 秒内没有拿到公网地址（网络可能无法到达 Cloudflare）', startedAt: Date.now() };
      log('启动超时，已停止 cloudflared');
      try { child.kill(); } catch (e) {}
    }
  }, 90000);

  return { ok: true, tunnel: publicTunnel() };
}

/* ---------------- 路由 ---------------- */

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const local = isLocal(req);

  if (req.method === 'OPTIONS') {
    if (!applyCors(req, res)) return json(res, 403, { error: '不允许的来源' });
    res.writeHead(204);
    return res.end();
  }

  // 健康检查（本机 / 探针）
  if (p === '/health') return json(res, 200, { ok: true, tunnel: state.tunnel.status });

  // —— 管理接口：只允许本机 ——
  if (p.indexOf('/api/') === 0 && local) {
    if (!applyCors(req, res)) return json(res, 403, { error: '不允许的来源' });

    if (p === '/api/status' && req.method === 'GET') return json(res, 200, statusPayload());

    if (p === '/api/config' && req.method === 'POST') {
      let data = {};
      try { data = JSON.parse(await readBody(req, 16 * 1024) || '{}'); } catch (e) { return json(res, 400, { error: '格式不正确' }); }
      const c = patchConfig(data);
      return json(res, 200, { ok: true, config: { keyOn: c.keyOn, key: c.key, maxMB: c.maxMB, feedbackOn: c.feedbackOn, note: c.note } });
    }

    if (p === '/api/key/regen' && req.method === 'POST') {
      const c = config();
      c.key = genKey();
      c.keyOn = true;
      saveConfig();
      log('已重新生成访问口令');
      return json(res, 200, { ok: true, key: c.key });
    }

    if (p === '/api/tunnel/start' && req.method === 'POST') {
      /* 首次启动要下载 55 MB 二进制，请求不能挂着等 —— 立刻返回 starting，
         进度与结果都通过 /api/status 反映，界面轮询即可。 */
      startTunnel().catch(e => log('启动失败：' + e.message));
      return json(res, 200, { ok: true, tunnel: publicTunnel() });
    }
    if (p === '/api/tunnel/stop' && req.method === 'POST') {
      stopTunnel();
      return json(res, 200, { ok: true, tunnel: publicTunnel() });
    }

    if (p === '/api/uploads' && req.method === 'GET') {
      return json(res, 200, { ok: true, items: readJsonl(UPLOAD_INDEX, 200).map(publicUpload) });
    }

    if (p === '/api/feedback' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        items: readJsonl(FEEDBACK_FILE, 200).map(x => ({
          name: x.name || '', contact: x.contact || '', text: x.text || '', at: x.at || ''
        }))
      });
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      try {
        if (IS_WIN) spawn('explorer', [UPLOADS], { windowsHide: true, detached: true }).unref();
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [UPLOADS], { detached: true }).unref();
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (p === '/api/logs' && req.method === 'GET') return json(res, 200, { ok: true, items: tail(Number(url.searchParams.get('tail') || 80)) });

    /* 这几条在本机浏览器直接打开页面时也要能用（分享页自己调它们），
       所以放行到下面的同一条处理链，而不是在管理接口里再写一份。 */
    if (p !== '/api/public/stats' && p !== '/api/upload' && !(p === '/api/feedback' && req.method === 'POST')) {
      return json(res, 404, { error: '没有这个接口：' + p });
    }
  }

  // —— 公网（或本机浏览器直接访问）页面与提交通道 ——
  if (p === '/api/public/stats' && req.method === 'GET') {
    if (!authed(req, url)) return json(res, 401, { error: '口令不正确' });
    return json(res, 200, {
      uploads: countLines(UPLOAD_INDEX),
      feedback: countLines(FEEDBACK_FILE),
      keyOn: config().keyOn
    });
  }

  if (p === '/api/upload' && req.method === 'PUT') return handleUpload(req, res, url);
  if (p === '/api/feedback' && req.method === 'POST') return handleFeedback(req, res, url);

  if ((p === '/' || p === '/index.html') && req.method === 'GET') {
    const c = config();
    if (!authed(req, url)) {
      const bad = !!url.searchParams.get('k');
      return html(res, bad ? 401 : 200, site.buildGate({ bad: bad }));
    }
    if (c.keyOn) {
      res.setHeader('Set-Cookie', 'tk=' + encodeURIComponent(c.key) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
    }
    return html(res, 200, site.buildPage({
      note: c.note,
      maxMB: c.maxMB,
      feedbackOn: c.feedbackOn,
      keyOn: c.keyOn
    }));
  }

  return html(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title>' +
    '<body style="font:15px system-ui;padding:40px;color:#475569">没有这个页面。</body>');
}

function publicUpload(x) {
  return {
    name: x.name || '',
    size: x.size || 0,
    at: x.at || '',
    note: x.note || ''
  };
}

/* ---------------- 启动 ---------------- */

ensureDirs();
config();

const server = http.createServer((req, res) => {
  try {
    const r = handle(req, res);
    if (r && typeof r.catch === 'function') {
      r.catch(e => {
        log('请求处理失败：' + e.message);
        try { json(res, 500, { error: '服务内部错误' }); } catch (err) {}
      });
    }
  } catch (e) {
    log('请求处理失败：' + e.message);
    try { json(res, 500, { error: '服务内部错误' }); } catch (err) {}
  }
});
server.keepAliveTimeout = 20000;

server.on('error', e => {
  log('监听失败：' + e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log('本地服务已就绪 http://' + HOST + ':' + PORT);
});

function shutdown() {
  stopTunnel();
  try { server.close(); } catch (e) {}
}
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
