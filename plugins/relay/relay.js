// Open AGI 本地中转
// 作用：绕过服务商（灵算 / Tripo 等）不开放浏览器 CORS 的限制。
// 启动：node plugins/relay/relay.js
// 默认监听：http://127.0.0.1:8787

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// 存储文件路径可用 RELAY_STORE_FILE 覆盖（自动化测试必须指向临时文件，
// 否则测试产生的脏数据会覆盖用户的真实工作流）
const STORE_FILE = process.env.RELAY_STORE_FILE || path.join(__dirname, 'openagi-store.json');

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
