// Open AGI 本地中转
// 作用：绕过服务商（灵算 / Tripo 等）不开放浏览器 CORS 的限制。
// 启动：node relay.js
// 默认监听：http://127.0.0.1:8787

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const STORE_FILE = path.join(__dirname, 'openagi-store.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type,accept,x-relay-target',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
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

// 统计：便于 /health 查看重试情况
const relayStats = { proxied: 0, retried: 0, failed: 0 };

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
    sendJson(res, 200, {
      ok: true,
      service: 'open-agi-relay',
      stats: Object.assign({}, relayStats),
      retry: { max: RETRY_MAX, timeoutSec: Math.round(UPSTREAM_TIMEOUT / 1000) },
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
      loadStore()[key] = val;
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

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = {};
    ['authorization', 'content-type', 'accept', 'user-agent'].forEach(k => {
      if (req.headers[k]) headers[k] = req.headers[k];
    });
    if (body.length) headers['content-length'] = body.length;

    const lib = u.protocol === 'https:' ? https : http;
    const agent = u.protocol === 'https:' ? httpsAgent : httpAgent;

    // 转发一次；失败且可重试时递归重试（attempt 递增）
    relayStats.proxied++;
    const sendUpstream = (attempt) => {
      if (res.writableEnded || res.destroyed) return;   // 客户端已断开，没必要再连上游
      const upstream = lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method,
        headers,
        agent
      }, up => {
        const status = up.statusCode || 502;
        // 网关类 5xx（502/503/504）通常是上游抖动，换一次连接重试
        if (RETRY_STATUS.has(status) && attempt < RETRY_MAX && !res.headersSent && !res.writableEnded) {
          up.resume();   // 丢弃这次响应体
          const wait = backoff(attempt);
          relayStats.retried++;
          log(`上游返回 ${status}，${wait}ms 后重试（第 ${attempt + 1}/${RETRY_MAX} 次）…`);
          setTimeout(() => sendUpstream(attempt + 1), wait);
          return;
        }
        res.writeHead(status, Object.assign({}, up.headers, CORS));
        up.pipe(res);
      });

      upstream.setTimeout(UPSTREAM_TIMEOUT, () => {
        upstream.destroy(Object.assign(new Error('上游响应超时'), { code: 'ETIMEDOUT' }));
      });

      upstream.on('error', e => {
        if (res.headersSent) { res.destroy(); return; }   // 已经开始回传，不能重放
        if (res.writableEnded || res.destroyed) return;  // 客户端已放弃
        const code = e && e.code;
        if (RETRY_CODES.has(code) && attempt < RETRY_MAX) {
          const wait = backoff(attempt);
          relayStats.retried++;
          log(`上游连接异常（${code || e.message}），${wait}ms 后重试（第 ${attempt + 1}/${RETRY_MAX} 次）…`);
          setTimeout(() => sendUpstream(attempt + 1), wait);
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

    sendUpstream(0);
  });

  req.on('error', () => {});
});

process.on('exit', () => { if (storeTimer) flushStore(); });
process.on('SIGINT', () => { if (storeTimer) flushStore(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('Open AGI relay running: http://' + HOST + ':' + PORT);
  console.log('请在页面 设置 -> 本地中转 中启用，并保持本窗口运行。');
});
