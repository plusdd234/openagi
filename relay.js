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
    sendJson(res, 200, { ok: true, service: 'open-agi-relay' });
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
    const upstream = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: req.method,
      headers
    }, up => {
      res.writeHead(up.statusCode || 502, Object.assign({}, up.headers, CORS));
      up.pipe(res);
    });

    upstream.setTimeout(180000, () => {
      upstream.destroy(new Error('上游响应超时'));
    });
    upstream.on('error', e => {
      if (!res.headersSent) sendJson(res, 504, { error: '上游请求失败：' + e.message });
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableEnded && !upstream.destroyed) upstream.destroy();
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });

  req.on('error', () => {});
});

process.on('exit', () => { if (storeTimer) flushStore(); });
process.on('SIGINT', () => { if (storeTimer) flushStore(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('Open AGI relay running: http://' + HOST + ':' + PORT);
  console.log('请在页面 设置 -> 本地中转 中启用，并保持本窗口运行。');
});
