/* 账号网关（桌面版专用）
 *
 * 解决的问题：把上游 Key 收到服务端，让用户「登录账号就能用」，同时按人头限额。
 * 客户端是 Electron / 浏览器里的静态页面，只会调这里的 HTTP 接口。
 *
 * 端点：
 *   POST /auth/register   {email, password, code?}  → {token, user}      （第一个用户自动成为管理员）
 *   POST /auth/login      {email, password}         → {token, user}
 *   GET  /auth/me         Bearer                    → {user, usage}
 *   POST /auth/logout     Bearer                    → {ok}（令牌版本号 +1，旧令牌立刻失效）
 *   POST /auth/password   Bearer {oldPassword,newPassword}
 *   POST /v1/chat/completions  Bearer  OpenAI 兼容请求 → 原样转发（支持 SSE 流式）
 *   GET  /healthz                                   → {ok, users, model}
 *
 * 存储：单个 JSON 文件（原子写）。几百个账号规模足够，也省掉装数据库。
 * 安全：scrypt 加盐存密码；令牌 = HMAC 签名（含过期与版本号）；上游 Key 只在服务端。
 *
 * 启动：
 *   node server/gateway.js --port=8791
 * 必配环境变量（或首次启动写入 server/data/config.json）：
 *   GATEWAY_UPSTREAM_BASE=https://api.example.com/v1
 *   GATEWAY_UPSTREAM_KEY=sk-xxx
 *   GATEWAY_MODEL=gpt-4o-mini
 *   GATEWAY_DAILY_LIMIT=50            每人每天次数
 *   GATEWAY_REGISTER_CODE=invite-me   注册邀请码（留空=允许自由注册）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- 配置 ---------- */
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if(!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
};

const PORT = Number(process.env.GATEWAY_PORT || arg('port', '8791')) || 8791;
const DATA_DIR = process.env.GATEWAY_DATA || arg('data', path.join(__dirname, 'data'));
const STORE_FILE = path.join(DATA_DIR, 'gateway-store.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  upstreamBase: '',
  upstreamKey: '',
  model: '',            // 兼容旧配置：没有 models 时当作唯一模型
  defaultModel: '',
  dailyCredits: 100,    // 每日额度（按模型倍率消耗，0 = 不限）
  models: [],           // [{ id, label, multiplier, tags:[...] }]
  dailyLimit: 500,      // 每日请求数上限（防刷）
  registerCode: '',
  tokenDays: 7,
  maxBodyKB: 512,
  minIntervalMs: 400,
  maxConcurrent: 4
};

function loadConfig(){
  const saved = (() => {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e){ return {}; }
  })();
  const env = {
    upstreamBase: process.env.GATEWAY_UPSTREAM_BASE,
    upstreamKey: process.env.GATEWAY_UPSTREAM_KEY,
    model: process.env.GATEWAY_MODEL,
    dailyLimit: process.env.GATEWAY_DAILY_LIMIT,
    registerCode: process.env.GATEWAY_REGISTER_CODE
  };
  const cfg = Object.assign({}, DEFAULTS, saved);
  Object.keys(env).forEach(k => {
    if(env[k] !== undefined && env[k] !== '') cfg[k] = env[k];
  });
  cfg.dailyLimit = Math.max(0, Number(cfg.dailyLimit) || 0);
  // 环境变量里的 Key 不落盘，其余配置首次启动时写一份方便运维改
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if(!fs.existsSync(CONFIG_FILE)){
      const persisted = Object.assign({}, cfg, { upstreamKey: '' });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(persisted, null, 2) + '\n');
    }
  } catch(e){}
  return cfg;
}

/* ---------- 模型目录 ---------- */
function modelCatalog(){
  if(Array.isArray(CFG.models) && CFG.models.length){
    return CFG.models.filter(m => m && m.id).map(m => ({
      id: String(m.id),
      label: String(m.label || m.id),
      multiplier: Math.max(0, Number(m.multiplier) || 0),
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 3).map(String) : []
    }));
  }
  const id = CFG.model || CFG.defaultModel;
  return id ? [{ id, label: id, multiplier: 1, tags: [] }] : [];
}
function defaultModelId(){
  const cat = modelCatalog();
  if(CFG.defaultModel && cat.some(m => m.id === CFG.defaultModel)) return CFG.defaultModel;
  return cat.length ? cat[0].id : '';
}
function findModel(id){
  return modelCatalog().find(m => m.id === String(id || '')) || null;
}
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ---------- 存储（JSON + 原子写） ---------- */
let STORE = { version: 1, secret: '', users: [], usage: [] };

function loadStore(){
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const s = JSON.parse(raw);
    STORE = Object.assign({ version: 1, secret: '', users: [], usage: [] }, s);
  } catch(e){
    STORE = { version: 1, secret: '', users: [], usage: [] };
  }
  if(!STORE.secret){
    STORE.secret = crypto.randomBytes(32).toString('hex');
    saveStore();
  }
}
let _saving = false;
function saveStore(){
  if(_saving) return;
  _saving = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(STORE));
    fs.renameSync(tmp, STORE_FILE);
  } catch(e){
    console.error('[store] 写入失败：' + e.message);
  } finally {
    _saving = false;
  }
}

/* ---------- 密码与令牌 ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
function hashPassword(password, saltHex){
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password, user){
  try {
    const { hash } = hashPassword(password, user.salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passHash, 'hex'));
  } catch(e){ return false; }
}
function b64u(buf){ return Buffer.from(buf).toString('base64url'); }
function signToken(user, days){
  const payload = { uid: user.id, ver: user.tokenVersion, exp: Date.now() + days * 86400000 };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', STORE.secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token){
  if(!token || token.indexOf('.') < 0) return null;
  const [body, sig] = String(token).split('.');
  const want = crypto.createHmac('sha256', STORE.secret).update(body).digest('base64url');
  if(Buffer.byteLength(sig) !== Buffer.byteLength(want)) return null;
  if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch(e){ return null; }
  if(!payload || payload.exp < Date.now()) return null;
  const user = STORE.users.find(u => u.id === payload.uid);
  if(!user || user.disabled) return null;
  if(user.tokenVersion !== payload.ver) return null;   // 退出登录 / 改密码后旧令牌失效
  return user;
}

/* ---------- 额度 ---------- */
function todayKey(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function touchQuota(user){
  const key = todayKey();
  if(user.dayKey !== key){ user.dayKey = key; user.dayCount = 0; user.dayCost = 0; }
  return {
    requests: user.dayCount || 0,
    cost: round2(user.dayCost || 0),
    credits: Number(CFG.dailyCredits) || 0
  };
}
function chargeQuota(user, cost){
  touchQuota(user);
  user.dayCount = (user.dayCount || 0) + 1;
  user.dayCost = round2((user.dayCost || 0) + (Number(cost) || 0));
  user.totalCount = (user.totalCount || 0) + 1;
  saveStore();
}
function publicUser(u){
  const q = touchQuota(u);
  const credits = q.credits;
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt,
    usage: {
      requests: q.requests,
      cost: q.cost,
      credits,
      remaining: credits > 0 ? round2(Math.max(0, credits - q.cost)) : 0
    },
    model: defaultModelId()
  };
}

/* ---------- HTTP 小工具 ---------- */
function send(res, status, obj, extra){
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  }, CORS, extra || {}));
  res.end(body);
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-max-age': '600'
};
function readBody(req, limitKB){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if(size > (limitKB || 512) * 1024){
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if(!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e){ reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function bearer(req){
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/* ---------- 限流 ---------- */
const lastCallAt = new Map();     // userId -> ts
let inflight = 0;

/* ---------- 主服务 ---------- */
const CFG = loadConfig();
loadStore();

function validateEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

async function handleAuth(req, res, pathname){
  if(pathname === '/auth/register' && req.method === 'POST'){
    const body = await readBody(req, CFG.maxBodyKB);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if(!validateEmail(email)) return send(res, 400, { error: '邮箱格式不正确' });
    if(password.length < 6) return send(res, 400, { error: '密码至少 6 位' });
    if(STORE.users.some(u => u.email === email)) return send(res, 409, { error: '这个邮箱已经注册过了' });
    if(STORE.users.length && CFG.registerCode && String(body.code || '') !== String(CFG.registerCode)){
      return send(res, 403, { error: '邀请码不正确' });
    }
    const { salt, hash } = hashPassword(password);
    const user = {
      id: 'u' + crypto.randomBytes(6).toString('hex'),
      email, salt, passHash: hash,
      role: STORE.users.length ? 'user' : 'admin',
      createdAt: Date.now(),
      disabled: false,
      tokenVersion: 1,
      dayKey: todayKey(),
      dayCount: 0,
      totalCount: 0
    };
    STORE.users.push(user);
    saveStore();
    console.log('[auth] 注册 ' + email + '（' + user.role + '）');
    return send(res, 200, { token: signToken(user, CFG.tokenDays), user: publicUser(user) });
  }

  if(pathname === '/auth/login' && req.method === 'POST'){
    const body = await readBody(req, CFG.maxBodyKB);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = STORE.users.find(u => u.email === email);
    if(!user || user.disabled || !verifyPassword(password, user)){
      return send(res, 401, { error: '邮箱或密码不正确' });
    }
    return send(res, 200, { token: signToken(user, CFG.tokenDays), user: publicUser(user) });
  }

  const user = verifyToken(bearer(req));
  if(!user) return send(res, 401, { error: '登录已失效，请重新登录' });

  if(pathname === '/auth/me' && req.method === 'GET'){
    return send(res, 200, { user: publicUser(user) });
  }

  if(pathname === '/auth/logout' && req.method === 'POST'){
    user.tokenVersion = (user.tokenVersion || 1) + 1;
    saveStore();
    return send(res, 200, { ok: true });
  }

  if(pathname === '/auth/password' && req.method === 'POST'){
    const body = await readBody(req, CFG.maxBodyKB);
    if(!verifyPassword(String(body.oldPassword || ''), user)) return send(res, 401, { error: '原密码不正确' });
    const next = String(body.newPassword || '');
    if(next.length < 6) return send(res, 400, { error: '新密码至少 6 位' });
    const { salt, hash } = hashPassword(next);
    user.salt = salt;
    user.passHash = hash;
    user.tokenVersion = (user.tokenVersion || 1) + 1;
    saveStore();
    return send(res, 200, { ok: true, token: signToken(user, CFG.tokenDays) });
  }

  return send(res, 404, { error: '接口不存在' });
}

async function handleProxy(req, res){
  const user = verifyToken(bearer(req));
  if(!user) return send(res, 401, { error: '登录已失效，请重新登录' });
  if(!CFG.upstreamBase || !CFG.upstreamKey){
    return send(res, 503, { error: '网关还没配置上游模型（server/data/config.json）' });
  }

  // 先读请求体，才能知道要用哪个模型、要扣多少额度
  let body;
  try { body = await readBody(req, CFG.maxBodyKB); }
  catch(e){ return send(res, 400, { error: e.message }); }
  if(!body || !Array.isArray(body.messages)) return send(res, 400, { error: '缺少 messages' });

  // 模型必须来自目录：既允许用户挑（倍率不同），又不允许自选目录外的贵模型
  const wanted = String(body.model || '').trim() || defaultModelId();
  const picked = findModel(wanted);
  if(!picked){
    return send(res, 400, {
      error: '模型「' + wanted + '」不在可用列表里',
      models: modelCatalog().map(m => m.id)
    });
  }
  const cost = round2(picked.multiplier);

  // 额度：按倍率消耗（免费模型 0 倍率，额度用完也能用）
  const q = touchQuota(user);
  if(q.credits > 0 && round2(q.cost + cost) > q.credits){
    return send(res, 429, {
      error: '今天的额度不够了（已用 ' + q.cost + ' / ' + q.credits + '，这次需要 ' + cost + '），明天重置或换更便宜的模型',
      usage: publicUser(user).usage
    });
  }
  if(CFG.dailyLimit > 0 && q.requests >= CFG.dailyLimit){
    return send(res, 429, { error: '今天请求次数太多（上限 ' + CFG.dailyLimit + ' 次），明天再来', usage: publicUser(user).usage });
  }
  // 每人最小间隔
  const last = lastCallAt.get(user.id) || 0;
  if(Date.now() - last < CFG.minIntervalMs){
    return send(res, 429, { error: '请求太频繁，稍等一下' });
  }
  lastCallAt.set(user.id, Date.now());

  if(inflight >= CFG.maxConcurrent) return send(res, 503, { error: '网关繁忙，请稍后重试' });

  const payload = Object.assign({}, body);
  payload.model = picked.id;
  payload.stream = !!payload.stream;

  const url = CFG.upstreamBase.replace(/\/$/, '') + '/chat/completions';
  inflight++;
  const startedAt = Date.now();
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + CFG.upstreamKey,
        'content-type': 'application/json',
        'accept': payload.stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if(!upstream.ok){
      const text = await upstream.text().catch(() => '');
      let msg = '上游返回 ' + upstream.status;
      try { const j = JSON.parse(text); if(j && (j.error || j.message)) msg = j.error.message || j.error || j.message; } catch(e){}
      logUsage(user, 'chat', Date.now() - startedAt, upstream.status);
      return send(res, 502, { error: msg });
    }

    // 额度在上游成功后才扣，避免网络抖动白扣
    chargeQuota(user, cost);

    const ctype = upstream.headers.get('content-type') || 'application/json';
    res.writeHead(200, Object.assign({
      'content-type': ctype,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    }, CORS));

    if(payload.stream && upstream.body){
      const reader = upstream.body.getReader();
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      const text = await upstream.text();
      res.end(text);
    }
    logUsage(user, 'chat', Date.now() - startedAt, 200);
  } catch(e){
    logUsage(user, 'chat', Date.now() - startedAt, 0);
    if(!res.headersSent) send(res, 502, { error: '上游连接失败：' + ((e && e.message) || e) });
    else res.end();
  } finally {
    inflight--;
  }
}

function logUsage(user, kind, ms, status){
  STORE.usage.push({ at: Date.now(), uid: user.id, kind, ms, status });
  if(STORE.usage.length > 5000) STORE.usage = STORE.usage.slice(-5000);
  saveStore();
}

const server = http.createServer(async (req, res) => {
  if(req.method === 'OPTIONS'){
    res.writeHead(204, CORS);
    return res.end();
  }
  let pathname = '/';
  try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); } catch(e){}
  try {
    if(pathname === '/healthz'){
      return send(res, 200, {
        ok: true,
        users: STORE.users.length,
        model: defaultModelId() || '(未配置)',
        models: modelCatalog().length,
        dailyLimit: CFG.dailyLimit,
        upstream: CFG.upstreamBase ? '已配置' : '未配置'
      });
    }
    if(pathname === '/v1/models' && req.method === 'GET'){
      const u = verifyToken(bearer(req));
      if(!u) return send(res, 401, { error: '登录已失效，请重新登录' });
      return send(res, 200, {
        object: 'list',
        default: defaultModelId(),
        data: modelCatalog().map(m => ({
          id: m.id, object: 'model', owned_by: 'openagi-gateway',
          label: m.label, multiplier: m.multiplier, tags: m.tags
        }))
      });
    }
    if(pathname.indexOf('/auth/') === 0) return await handleAuth(req, res, pathname);
    if(pathname === '/v1/chat/completions' && req.method === 'POST') return await handleProxy(req, res);
    return send(res, 404, { error: '接口不存在' });
  } catch(e){
    console.error('[gw] ' + ((e && e.stack) || e));
    if(!res.headersSent) send(res, 500, { error: '服务内部错误' });
  }
});

server.requestTimeout = 0;
const HOST = process.env.GATEWAY_HOST || arg('host', '0.0.0.0');
server.listen(PORT, HOST, () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('账号网关已启动：http://127.0.0.1:' + PORT);
  console.log('  数据目录：' + DATA_DIR);
  console.log('  上游模型：' + (CFG.upstreamBase ? CFG.upstreamBase + ' / ' + (CFG.model || '(默认)') : '未配置（先填 server/data/config.json）'));
  console.log('  每日额度：' + (CFG.dailyLimit || '不限') + ' 次/人');
  console.log('  注册方式：' + (CFG.registerCode ? '需要邀请码' : '自由注册'));
  if(!STORE.users.length) console.log('  首个注册的账号会成为管理员');
});

module.exports = { signToken, verifyToken, hashPassword, verifyPassword, publicUser };
