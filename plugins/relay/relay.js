// Open AGI 本地中转
// 作用：绕过服务商（灵算 / Tripo 等）不开放浏览器 CORS 的限制。
// 启动：node plugins/relay/relay.js
// 默认监听：http://127.0.0.1:8787

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// 存储文件路径可用 RELAY_STORE_FILE 覆盖（自动化测试必须指向临时文件，
// 否则测试产生的脏数据会覆盖用户的真实工作流）
const STORE_FILE = process.env.RELAY_STORE_FILE || path.join(__dirname, 'openagi-store.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type,accept,x-relay-target,x-relay-follow',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}

/* 转发上游响应头时，必须按小写键覆盖 CORS。
   upstream.headers 的键全是小写；若直接 Object.assign({}, up.headers, CORS)，
   Node 会同时写出 'access-control-allow-origin' 和 'Access-Control-Allow-Origin' 两行，
   浏览器看到 '*, *' 直接判为非法响应 —— GitHub API 这类自带 CORS 头的接口就全被拦死。 */
function corsHeaders(upHeaders) {
  const merged = Object.assign({}, upHeaders);
  Object.keys(CORS).forEach(k => { merged[k.toLowerCase()] = CORS[k]; });
  return merged;
}

// ---------------------------------------------------------------------------
// 上游转发的连接策略与重试
//
// 背景：中转进程长期运行且频繁转发到同几个上游，Node 默认的 keep-alive 连接池
// 会复用「服务端已回收但本地仍以为可用」的空闲 socket，一旦写入就抛 ECONNRESET；
// 服务端在长请求期间主动断连、TLS 握手被拒、网关 5xx 抖动也会造成同样现象。
// 因此：① 专用 keep-alive Agent + 连接复用；② 瞬时故障自动重试（指数退避 + 抖动）；
// ③ 超时分级（连接超时 / 整体响应超时）；④ 失败时给出可操作的提示而不是裸 errno。
// ---------------------------------------------------------------------------

// 可重试的瞬时错误码
const RETRY_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'ESOCKETTIMEDOUT',
]);
// 可重试的上游状态码（网关 / 服务不可用）
const RETRY_STATUS = new Set([502, 503, 504]);
// 额外重试次数（总尝试次数 = 1 + RETRY_MAX），RELAY_RETRY=0 可关闭
const RETRY_MAX = Math.max(0, Math.min(5, Number(process.env.RELAY_RETRY ?? 2)));
// 整体响应超时（毫秒），默认 10 分钟——视觉模型分析大图可能跑好几分钟
const UPSTREAM_TIMEOUT = Math.max(30, Number(process.env.RELAY_TIMEOUT || 600)) * 1000;
// 退避基数（毫秒）
const RETRY_BASE_DELAY = Math.max(100, Number(process.env.RELAY_RETRY_DELAY || 400));

// 指数退避 + 抖动，避免多个并发请求同时重试打爆上游
function backoff(attempt) {
  const base = RETRY_BASE_DELAY * Math.pow(2, Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.min(500, base));
}

// 专用连接池：keep-alive 复用 + 限制并发 + 空闲 socket 超时
const agentOpts = {
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 16,
  maxFreeSockets: 8,
  timeout: 120000,
};
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

// ---------------------------------------------------------------------------
// 上游请求头
//
// 抓不到的网页里，一大半是「403 站点拒绝」。原因不在目标站，而在我们自己：
// 浏览器 fetch 不允许设置 User-Agent，于是转发到上游时带的是 Node 的默认 UA，
// 目标站一眼就判定成脚本，直接 403。这里补齐一整套浏览器默认头；
// 客户端显式传了就不覆盖（图片 / 接口请求仍用调用方自己的头）。
// ---------------------------------------------------------------------------
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER_UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function browserHeaders(target, given) {
  const out = Object.assign({}, given);
  if (!out['user-agent']) out['user-agent'] = BROWSER_UA;
  if (!out['accept']) {
    out['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,'
      + 'image/avif,image/webp,*/*;q=0.8';
  }
  if (!out['accept-language']) out['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
  // 明确要明文：否则上游可能回 gzip/br，浏览器读到的就是乱码
  if (!out['accept-encoding']) out['accept-encoding'] = 'identity';
  if (!out['referer']) out['referer'] = target.origin + '/';
  if (!out['cache-control']) out['cache-control'] = 'no-cache';
  return out;
}

// 少数站点无视 accept-encoding: identity，照样压缩；这里兜一层解压，免得正文变乱码。
function decoderFor(encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  return null;
}

// ---------------------------------------------------------------------------
// 系统代理
//
// 现在很多环境靠本地代理上网（本机 127.0.0.1:18081），浏览器和 PowerShell 会自动走它，
// 而 Node 不会 —— 于是同一个网址浏览器能开、中转却一直等到超时，App 里就显示「站点拒绝」。
// 这里把系统代理也接上：直连 7 秒没响应就自动改走代理。只看 GET（抓网页），
// 模型接口这类 POST 不重试，避免一次请求被发两遍。
// ---------------------------------------------------------------------------
function detectProxy() {
  if (process.env.RELAY_NO_PROXY === '1') return '';
  const env = process.env.RELAY_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY;
  if (env) return env;
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const on = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
    if (on && parseInt(on[1], 16) === 1 && server) return server[1];
  } catch (e) { /* 读不到注册表就当没有代理 */ }
  return '';
}

function parseProxy(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^"|"$/g, '');
  /* 注册表可能是 http=1.2.3.4:80;https=1.2.3.4:443 这种多协议写法 */
  if (s.indexOf('=') >= 0 && s.indexOf(';') >= 0) {
    const pick = /(?:^|;)\s*https=([^;]+)/i.exec(s) || /(?:^|;)\s*http=([^;]+)/i.exec(s);
    if (pick) s = pick[1].trim();
  }
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  try {
    const p = new URL(s);
    if (!p.hostname) return null;
    const auth = p.username
      ? 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64')
      : '';
    return { host: p.hostname, port: Number(p.port || 80), auth };
  } catch (e) { return null; }
}

const UPSTREAM_PROXY = parseProxy(detectProxy());
/* 直连多久没拿到响应就改走代理。不能设太长：App 抓单页只等 9 秒，
   这里拖到 7 秒的话，等到代理接手时浏览器已经放弃了。 */
const PROXY_AFTER = Math.max(800, Number(process.env.RELAY_PROXY_AFTER || 2500));

/* HTTPS 走 HTTP 代理要先 CONNECT 建隧道，再把 TLS 套在这条 socket 上。 */
function tunnelSocket(u, cb) {
  const port = u.port || 443;
  const target = u.hostname + ':' + port;
  const connectReq = http.request({
    host: UPSTREAM_PROXY.host,
    port: UPSTREAM_PROXY.port,
    method: 'CONNECT',
    path: target,
    headers: Object.assign({ host: target },
      UPSTREAM_PROXY.auth ? { 'proxy-authorization': UPSTREAM_PROXY.auth } : {})
  });
  connectReq.on('connect', (r, socket) => {
    if (r.statusCode !== 200) {
      socket.destroy();
      cb(new Error('代理 CONNECT 失败 ' + r.statusCode));
      return;
    }
    cb(null, tls.connect({ socket, servername: u.hostname }));
  });
  connectReq.on('error', (e) => cb(e));
  connectReq.end();
}

// ---------------------------------------------------------------------------
// Cookie 罐
//
// 知乎 / 百度百科这类站不是「UA 像浏览器」就能读：它们先看有没有会话 Cookie
// （zhihu 的 d_c0、百度的 BAIDUID），没有就回登录墙或 403。
// 浏览器每次请求都会自动带上，而中转是逐请求转发的，不记 Cookie 就永远像新访客。
// 这里按域名存一份最小 Cookie 罐：上游 Set-Cookie → 落罐；后续请求 → 自动带上。
// 登录态无法匿名获取，可用 RELAY_COOKIES 环境变量注入（JSON 或 host=cookie 行）。
// ---------------------------------------------------------------------------
const COOKIE_MAX = 60;               // 单域名最多记几个，防止罐子无限长
const cookieJar = new Map();         // domain -> Map(name -> { v, exp })

function jarPut(domain, name, value, exp) {
  let jar = cookieJar.get(domain);
  if (!jar) { jar = new Map(); cookieJar.set(domain, jar); }
  if (!value || exp <= Date.now()) { jar.delete(name); return; }
  jar.delete(name);                  // 重新插入，保证 Map 迭代顺序是「最近写入在后」
  jar.set(name, { v: value, exp });
  while (jar.size > COOKIE_MAX) jar.delete(jar.keys().next().value);
}

/* Set-Cookie 可能一次来多条；Domain 属性能把 Cookie 挂到父域（.zhihu.com）。 */
function jarStore(host, setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  list.forEach(raw => {
    const parts = String(raw).split(';');
    const pair = parts.shift() || '';
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = String(host || '').toLowerCase();
    let exp = Date.now() + 86400000;   // 没写有效期就按一天算
    parts.forEach(p => {
      const i = p.indexOf('=');
      if (i < 0) return;
      const k = p.slice(0, i).trim().toLowerCase();
      const v = p.slice(i + 1).trim();
      if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
      else if (k === 'max-age') { const n = Number(v); if (n > 0) exp = Date.now() + n * 1000; }
      else if (k === 'expires') { const t = Date.parse(v); if (!isNaN(t)) exp = t; }
    });
    if (!domain || domain.indexOf('.') < 0) domain = String(host || '').toLowerCase();
    jarPut(domain, name, value, exp);
  });
}

/* 手动注入一整条 Cookie 头：name=value; name2=value2 */
function jarImport(host, cookieHeader) {
  String(cookieHeader || '').split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i <= 0) return;
    jarPut(String(host || '').toLowerCase(), pair.slice(0, i).trim(), pair.slice(i + 1).trim(),
      Date.now() + 7 * 86400000);
  });
}

function jarGet(host) {
  const h = String(host || '').toLowerCase();
  const now = Date.now();
  const out = [];
  cookieJar.forEach((jar, domain) => {
    if (h !== domain && h.slice(-(domain.length + 1)) !== '.' + domain) return;
    jar.forEach((c, name) => {
      if (c.exp <= now) { jar.delete(name); return; }
      out.push(name + '=' + c.v);
    });
  });
  return out.join('; ');
}

/* RELAY_COOKIES 支持两种写法：
   {"zhihu.com":"z_c0=xxx; _zap=yyy"}  或每行 host=cookie。 */
(function seedCookies() {
  const raw = process.env.RELAY_COOKIES;
  if (!raw) return;
  try {
    const map = JSON.parse(raw);
    Object.keys(map || {}).forEach(h => jarImport(String(h).replace(/^\./, ''), map[h]));
  } catch (e) {
    String(raw).split(/\r?\n/).forEach(line => {
      const i = line.indexOf('=');
      if (i > 0) jarImport(line.slice(0, i).trim().replace(/^\./, ''), line.slice(i + 1).trim());
    });
  }
})();

// 需要先拿会话 Cookie 才肯给正文的站点：先访问一次站点根目录再抓目标页。
const WARM_HOSTS = [/(^|\.)zhihu\.com$/i, /(^|\.)baike\.baidu\.com$/i];
const warmPending = new Map();

function warmCookies(host, done) {
  const need = WARM_HOSTS.some(re => re.test(host)) && !jarGet(host);
  if (!need) { done(); return; }
  const queued = warmPending.get(host);
  if (queued) { queued.push(done); return; }
  warmPending.set(host, [done]);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const list = warmPending.get(host) || [];
    warmPending.delete(host);
    list.forEach(fn => { try { fn(); } catch (e) { /* 调用方自己兜底 */ } });
  };
  /* 预热不能拖太久：App 抓单页只给 9 秒，这里最多花 2.5 秒，拿不到 Cookie 也照常抓。 */
  const timer = setTimeout(finish, 2500);
  const rootTarget = new URL('https://' + host + '/');
  const headers = browserHeaders(rootTarget, {});

  const attempt = (viaProxy) => {
    const opts = {
      protocol: 'https:',
      hostname: rootTarget.hostname,
      port: 443,
      path: '/',
      method: 'GET',
      headers
    };
    if (viaProxy && UPSTREAM_PROXY) {
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = (o, cb) => tunnelSocket(rootTarget, cb);
      opts.agent = agent;
    } else {
      opts.agent = httpsAgent;
    }
    const r = https.request(opts, up => {
      jarStore(host, up.headers['set-cookie']);
      up.resume();
      clearTimeout(timer);
      try { up.destroy(); } catch (e) { /* 已经结束 */ }
      finish();
    });
    r.setTimeout(2000, () => r.destroy(new Error('warm timeout')));
    r.on('error', () => {
      if (!viaProxy && UPSTREAM_PROXY) attempt(true);
      else { clearTimeout(timer); finish(); }
    });
    r.end();
  };
  attempt(false);
}

// ---------------------------------------------------------------------------
// 站点按 IP 限流后的冷却
//
// 连续多轮抓同一批工具站时（Tripo / Meshy 这类），站点会按出口 IP 直接回 403，
// 此时继续重试只会加深封禁、还让每页白等 9 秒。这里给每个域名记一个解禁时间：
// 命中冷却就立刻回 429 + X-Relay-Error，由 App 显示「已暂停 N 分钟」并降级为摘要。
// 只对「抓网页的 GET」生效，模型 / 接口的 POST 不受影响。
// ---------------------------------------------------------------------------
const BLOCK_MS = Math.max(30, Number(process.env.RELAY_BLOCK_MS || 600)) * 1000;
const HOST_GAP = Math.max(0, Number(process.env.RELAY_HOST_GAP || 1200));
const NO_BLOCK_HOSTS = /^(cn\.bing\.com|www\.bing\.com|www\.baidu\.com|www\.so\.com|www\.sogou\.com|www\.google\.com|api\.github\.com)$/i;
const hostState = new Map();         // host -> { last, until, reason }

function hostStateOf(host) {
  let st = hostState.get(host);
  if (!st) { st = { last: 0, until: 0, reason: '' }; hostState.set(host, st); }
  return st;
}

function blockHost(host, ms, reason) {
  const st = hostStateOf(host);
  st.until = Date.now() + ms;
  st.reason = reason;
}

/* 只把「抓网页」的请求纳入限流：图片 / 接口 / POST 保持原样。 */
function isPageGet(req) {
  return req.method === 'GET' && /text\/html|application\/xhtml|text\/plain|xml/i.test(
    String(req.headers['accept'] || ''));
}

function blockedLeft(host) {
  const st = hostState.get(host);
  if (!st || !st.until) return 0;
  const left = st.until - Date.now();
  if (left <= 0) { st.until = 0; st.reason = ''; return 0; }
  return left;
}

function sendBlocked(res, host, left) {
  const mins = Math.max(1, Math.ceil(left / 60000));
  const msg = '站点按 IP 限流（' + host + '），已暂停抓取 ' + mins + ' 分钟';
  res.writeHead(429, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    /* HTTP 头只能放 ASCII：中文必须转义，客户端再 decodeURIComponent 还原。 */
    'X-Relay-Error': encodeURIComponent(msg)
  }, CORS));
  res.end(JSON.stringify({ error: msg }));
}

// ---------------------------------------------------------------------------
// 工作流存储的合并与备份
//
// localStorage 按 origin 隔离（file:// / 预览面板随机端口 / TRAE 内置预览 = 三个源），
// 各源的 localStorage 互不相通，而磁盘上只有一份 openagi-store.json。
// 若直接覆盖，任一源的一次写入就会抹掉其他源的流程（2026-10-24 实际发生过）。
// 因此：写 hf_flows 时与已有值**合并**（按 id 取较新版本），并在覆盖前备份旧值。
// ---------------------------------------------------------------------------
const BACKUP_DIR = process.env.RELAY_BACKUP_DIR || path.join(__dirname, 'openagi-store.backup');
const BACKUP_KEEP = 20;

// 统计：便于 /health 查看重试情况
const relayStats = { proxied: 0, retried: 0, failed: 0 };

function mergeFlowLists(a, b){
  const pa = Array.isArray(a) ? a : [];
  const pb = Array.isArray(b) ? b : [];
  const map = new Map();
  const put = f => {
    if(!f || !f.id) return;
    const old = map.get(f.id);
    if(!old || (Number(f.updated) || 0) > (Number(old.updated) || 0)) map.set(f.id, f);
  };
  pa.forEach(put);
  pb.forEach(put);
  return Array.from(map.values()).sort((x, y) => (Number(y.updated) || 0) - (Number(x.updated) || 0));
}
function parseFlowList(str){
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : null; } catch(e) { return null; }
}
// 删除墓碑是字符串 id 数组，单独一套解析 / 合并 / 读取
function parseIdList(str){
  try { const v = JSON.parse(str); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch(e){ return []; }
}
function mergeIdList(a, b){
  const set = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(x => typeof x === 'string'));
  return Array.from(set);
}
function readDelSet(store){
  return new Set(parseIdList(store['hf_flows_del']));
}

// 覆盖前把旧值存一份带时间戳的备份，最多保留 BACKUP_KEEP 份
function backupStoreValue(key, oldValue){
  if(!oldValue) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR, key + '-' + stamp + '.json'), String(oldValue), 'utf8');
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(key + '-'))
      .sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
  } catch (e) { /* 备份失败不影响主流程 */ }
}

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + msg);
}

// ---- 配置落盘：localStorage 被清空 / 预览端口变化时仍能恢复 ----
let storeCache = null;
let storeTimer = null;
function loadStore() {
  if (storeCache) return storeCache;
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    storeCache = data && typeof data === 'object' ? data : {};
  } catch (e) {
    storeCache = {};
  }
  return storeCache;
}
function flushStore() {
  clearTimeout(storeTimer);
  storeTimer = null;
  const tmp = STORE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(loadStore()));
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) {
    console.error('配置落盘失败：' + e.message);
  }
}
function scheduleStoreFlush() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(flushStore, 200);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.url === '/health') {
    const blocked = [];
    const now = Date.now();
    hostState.forEach((st, h) => {
      if (st.until > now) blocked.push({ host: h, seconds: Math.ceil((st.until - now) / 1000), why: st.reason });
    });
    sendJson(res, 200, {
      ok: true,
      service: 'open-agi-relay',
      stats: Object.assign({}, relayStats),
      retry: { max: RETRY_MAX, timeoutSec: Math.round(UPSTREAM_TIMEOUT / 1000) },
      proxy: UPSTREAM_PROXY ? (UPSTREAM_PROXY.host + ':' + UPSTREAM_PROXY.port) : '',
      cookies: cookieJar.size,
      blocked: blocked,
    });
    return;
  }

  if (req.url.startsWith('/store.js')) {
    const js = 'window.__OPENAGI_STORE=' + JSON.stringify(loadStore()) + ';';
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    }, CORS));
    res.end(js);
    return;
  }

  if (req.url.startsWith('/store/') && req.method === 'GET') {
    // 读取单个键的原始值（便于排查与备份）
    const key = decodeURIComponent(req.url.slice('/store/'.length));
    if (!/^hf_[A-Za-z0-9_]+$/.test(key)) {
      sendJson(res, 400, { error: '非法键名' });
      return;
    }
    const val = loadStore()[key];
    res.writeHead(val === undefined ? 404 : 200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, CORS));
    res.end(val === undefined ? '' : String(val));
    return;
  }

  if (req.url.startsWith('/store/') && req.method === 'POST') {
    const key = decodeURIComponent(req.url.slice('/store/'.length));
    if (!/^hf_[A-Za-z0-9_]+$/.test(key)) {
      sendJson(res, 400, { error: '非法键名' });
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const val = Buffer.concat(chunks).toString('utf8');
      const store = loadStore();
      const old = store[key];
      if (key === 'hf_flows') {
        // 工作流：与已有值合并（按 id 取较新版本），再剔除已删除的（墓碑）。
        // 否则删除永远只是「本地消失、磁盘还在」，别的源一合并又复活
        // （2026-10-29 用户实测：删一个刷新又恢复，正是 union 把磁盘旧副本并了回来）。
        const merged = mergeFlowLists(parseFlowList(old), parseFlowList(val));
        const del = readDelSet(store);
        const finalList = merged.filter(f => f && !del.has(f.id));
        const finalJs = JSON.stringify(finalList);
        if (finalJs !== old) backupStoreValue(key, old);   // 有变化才备份
        store[key] = finalJs;
        scheduleStoreFlush();
        sendJson(res, 200, { ok: true, count: finalList.length });
        return;
      }
      if (key === 'hf_flows_del') {
        // 删除墓碑：取并集（多源都删过就都记着），并立刻用最新墓碑重筛 hf_flows，
        // 让「在某源删除」即时传播到磁盘上的工作流列表。
        const merged = mergeIdList(parseIdList(old), parseIdList(val));
        store[key] = JSON.stringify(merged);
        const flows = parseFlowList(store['hf_flows']);
        if (Array.isArray(flows)) {
          const left = flows.filter(f => f && !merged.includes(f.id));
          store['hf_flows'] = JSON.stringify(left);
        }
        scheduleStoreFlush();
        sendJson(res, 200, { ok: true, count: merged.length });
        return;
      }
      store[key] = val;
      scheduleStoreFlush();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  const target = req.headers['x-relay-target'];
  if (!target) {
    sendJson(res, 400, { error: '缺少 X-Relay-Target 请求头' });
    return;
  }

  let u;
  try {
    u = new URL(target);
  } catch (e) {
    sendJson(res, 400, { error: '目标地址无效' });
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    sendJson(res, 400, { error: '仅支持 http/https 目标' });
    return;
  }

  /* 抓网页的 GET 先看站点冷却：命中就立刻回 429，不再白等 9 秒、也不继续加深封禁。 */
  const host = u.hostname.toLowerCase();
  const pageGet = isPageGet(req);
  if (pageGet) {
    const left = blockedLeft(host);
    if (left > 0) { sendBlocked(res, host, left); return; }
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const given = {};
    ['authorization', 'content-type', 'accept', 'user-agent', 'accept-language', 'range', 'cookie']
      .forEach(k => {
        if (req.headers[k]) given[k] = req.headers[k];
      });
    if (body.length) given['content-length'] = body.length;
    const baseHeaders = browserHeaders(u, given);
    /* 403 时换一次移动端 UA：有些站只拦桌面 UA 或只拦某个 UA 指纹。 */
    let uaMode = 0;

    /* 可选：跟随上游 3xx 重定向（X-Relay-Follow: 1）。
       搜索引擎的结果链接常是 /link?url=… 这种跳转，不跟随就只能拿到一个空 302 页面。
       只跟随 http(s) 目标，最多 3 跳；最终地址回写在 X-Relay-Final-Url 里。 */
    const follow = req.headers['x-relay-follow'] === '1';
    let hops = 0;

    const sendUpstream = (attempt, viaProxy) => {
      if (res.writableEnded || res.destroyed) return;   // 客户端已断开，没必要再连上游
      if (viaProxy && !UPSTREAM_PROXY) viaProxy = false;
      const lib = u.protocol === 'https:' ? https : http;
      const directAgent = u.protocol === 'https:' ? httpsAgent : httpAgent;
      const headers = uaMode
        ? Object.assign({}, baseHeaders, { 'user-agent': BROWSER_UA_MOBILE })
        : Object.assign({}, baseHeaders);
      /* 每次尝试都按「当前目标域名」补 Cookie：重定向后域名会变，
         而知乎 / 百度百科没有会话 Cookie 直接回登录墙或 403。 */
      if (!given.cookie) {
        const jarCookie = jarGet(u.hostname.toLowerCase());
        if (jarCookie) headers.cookie = jarCookie;
      }
      const opts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method,
        headers,
        agent: viaProxy ? false : directAgent
      };
      if (viaProxy) {
        if (u.protocol === 'http:') {
          /* 明文目标是「绝对地址发给代理」，不用建隧道。 */
          opts.hostname = UPSTREAM_PROXY.host;
          opts.port = UPSTREAM_PROXY.port;
          opts.path = u.href;
          if (UPSTREAM_PROXY.auth) {
            opts.headers = Object.assign({}, headers, { 'proxy-authorization': UPSTREAM_PROXY.auth });
          }
        } else {
          /* 隧道要挂在 Agent 实例上（构造参数里的 createConnection 不会被采用），
             否则请求会绕过代理直连，被墙的站点就一直挂到超时。 */
          const tunnelAgent = new https.Agent({ keepAlive: false });
          tunnelAgent.createConnection = (o, cb) => tunnelSocket(u, cb);
          opts.agent = tunnelAgent;
        }
      }
      relayStats.proxied++;

      /* 直连一直不回（多半被墙 / 需要本地代理），到点就改走代理再来一次；只对抓网页的 GET 这样做。 */
      const canFallback = !viaProxy && !!UPSTREAM_PROXY && req.method === 'GET';
      let settled = false;
      const headerTimer = canFallback ? setTimeout(() => {
        if (settled) return;
        settled = true;
        relayStats.retried++;
        log('直连 ' + Math.round(PROXY_AFTER / 1000) + ' 秒没有响应，改走系统代理重试…');
        try { upstream.destroy(); } catch (e) { /* 已经结束 */ }
        sendUpstream(attempt, true);
      }, PROXY_AFTER) : null;

      const upstream = lib.request(opts, up => {
        settled = true;
        if (headerTimer) clearTimeout(headerTimer);
        const status = up.statusCode || 502;
        const curHost = u.hostname.toLowerCase();
        /* 上游下发的会话 Cookie 落罐，供同一站点的后续页面复用。 */
        jarStore(curHost, up.headers['set-cookie']);
        const location = up.headers.location;
        if (follow && status >= 300 && status < 400 && location && hops < 3) {
          up.resume();   // 丢弃跳转响应体
          hops++;
          let next;
          try {
            next = new URL(location, u);
          } catch (e) {
            sendJson(res, 502, { error: '上游重定向地址无效：' + location });
            return;
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            sendJson(res, 502, { error: '拒绝跟随非 http(s) 重定向' });
            return;
          }
          u = next;
          sendUpstream(0, viaProxy);
          return;
        }
        /* 403 多半是 UA / 反爬指纹判定：换移动端 UA 再试一次，仍失败才认。 */
        if (status === 403 && uaMode === 0 && !res.headersSent && !res.writableEnded) {
          up.resume();
          uaMode = 1;
          relayStats.retried++;
          log('上游返回 403，换移动端 UA 重试一次…');
          sendUpstream(attempt, viaProxy);
          return;
        }
        // 网关类 5xx（502/503/504）通常是上游抖动，换一次连接重试
        if (RETRY_STATUS.has(status) && attempt < RETRY_MAX && !res.headersSent && !res.writableEnded) {
          up.resume();   // 丢弃这次响应体
          const wait = backoff(attempt);
          relayStats.retried++;
          log(`上游返回 ${status}，${wait}ms 后重试（第 ${attempt + 1}/${RETRY_MAX} 次）…`);
          setTimeout(() => sendUpstream(attempt + 1, viaProxy), wait);
          return;
        }
        /* 换过 UA 仍是 403 / 明确 429：判定为「按 IP 限流」，记冷却并立刻告知 App。
           继续重试只会加深封禁，所以这里不再重试，改为 10 分钟内对该域名快速失败。 */
        if ((status === 403 || status === 429) && pageGet && !NO_BLOCK_HOSTS.test(curHost)
            && !res.headersSent && !res.writableEnded) {
          const ra = Number(up.headers['retry-after']);
          const ms = status === 429 && ra > 0 ? ra * 1000 : BLOCK_MS;
          blockHost(curHost, ms, status === 429 ? '上游限流 429' : '站点拒绝 403');
          up.resume();
          relayStats.failed++;
          log('上游 ' + status + '，' + curHost + ' 冷却 ' + Math.round(ms / 60000) + ' 分钟…');
          sendBlocked(res, curHost, ms);
          return;
        }
        /* 正常响应顺手解除该域名的冷却。 */
        if (status < 400) {
          const st = hostState.get(curHost);
          if (st && st.until) { st.until = 0; st.reason = ''; }
        }
        if (hops) res.setHeader('X-Relay-Final-Url', u.href);
        const outHeaders = corsHeaders(up.headers);
        const dec = decoderFor(up.headers['content-encoding']);
        if (dec) {
          /* 已经解压，就不能再告诉浏览器「这是压缩过的」，长度也会变。 */
          delete outHeaders['content-encoding'];
          delete outHeaders['content-length'];
        }
        res.writeHead(status, outHeaders);
        if (dec) {
          dec.on('error', () => res.destroy());
          up.pipe(dec).pipe(res);
        } else {
          up.pipe(res);
        }
      });

      upstream.setTimeout(UPSTREAM_TIMEOUT, () => {
        upstream.destroy(Object.assign(new Error('上游响应超时'), { code: 'ETIMEDOUT' }));
      });

      upstream.on('error', e => {
        if (headerTimer) clearTimeout(headerTimer);
        if (settled) return;   // 已经交给「改走代理」那条路处理
        settled = true;
        if (res.headersSent) { res.destroy(); return; }   // 已经开始回传，不能重放
        if (res.writableEnded || res.destroyed) return;  // 客户端已放弃
        const code = e && e.code;
        /* 直连失败（被墙 / 连接被拒）→ 有系统代理就立刻改走代理。 */
        if (canFallback) {
          relayStats.retried++;
          log(`直连失败（${code || e.message}），改走系统代理重试…`);
          sendUpstream(attempt, true);
          return;
        }
        if (RETRY_CODES.has(code) && attempt < RETRY_MAX) {
          const wait = backoff(attempt);
          relayStats.retried++;
          log(`上游连接异常（${code || e.message}），${wait}ms 后重试（第 ${attempt + 1}/${RETRY_MAX} 次）…`);
          setTimeout(() => sendUpstream(attempt + 1, viaProxy), wait);
          return;
        }
        // 重试耗尽：给出可操作的错误说明
        relayStats.failed++;
        const msg = e && e.message ? e.message : '未知错误';
        if (code === 'ECONNRESET' || /socket hang up/i.test(msg)) {
          sendJson(res, 502, { error: '上游连接被重置（ECONNRESET），已重试 ' + attempt + ' 次仍未成功。请检查本机网络 / 代理，或稍后重试。' });
        } else if (code === 'ECONNREFUSED') {
          sendJson(res, 502, { error: '无法连接上游服务（' + msg + '）：请检查网络、代理或目标地址是否可达。' });
        } else if (code === 'ETIMEDOUT' || /超时/.test(msg)) {
          sendJson(res, 504, { error: '上游响应超时（' + Math.round(UPSTREAM_TIMEOUT / 1000) + ' 秒）：服务商长时间没有返回。可调大环境变量 RELAY_TIMEOUT 或减少请求内容。' });
        } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
          sendJson(res, 502, { error: '域名解析失败（' + msg + '）：请检查网络与 DNS。' });
        } else {
          sendJson(res, 502, { error: '上游请求失败（' + msg + '），已重试 ' + attempt + ' 次。' });
        }
      });

      res.on('close', () => {
        if (!res.writableEnded && !upstream.destroyed) upstream.destroy();
      });
      if (body.length) upstream.write(body);
      upstream.end();
    };

    /* 同一域名的网页请求至少隔 HOST_GAP：一轮抓 10 个同站页面会被当成爬虫。
       间隔只压在网页 GET 上，接口 / 图片不受影响。 */
    const start = () => {
      hostStateOf(u.hostname.toLowerCase()).last = Date.now();
      warmCookies(u.hostname.toLowerCase(), () => sendUpstream(0));
    };
    const gap = pageGet ? Math.max(0, hostStateOf(host).last + HOST_GAP - Date.now()) : 0;
    if (gap > 0) setTimeout(start, gap);
    else start();
  });

  req.on('error', () => {});
});

process.on('exit', () => { if (storeTimer) flushStore(); });
process.on('SIGINT', () => { if (storeTimer) flushStore(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('Open AGI relay running: http://' + HOST + ':' + PORT);
  console.log('请在页面 设置 -> 本地中转 中启用，并保持本窗口运行。');
});
