// 本地引擎桥（阶段 C）
// 作用：把浏览器无法直连的本地模型引擎（Ollama 11434 / ComfyUI 8188）统一转发到一个
// 允许 CORS 的端口上，并对外提供 /health 探测引擎是否可用（面向 JIT / Python 测试模式）。
// 启动：node plugins/runtime/runtime.js        （默认监听 http://127.0.0.1:8794，可用 RUNTIME_PORT 覆盖）
// 端口约定：Ollama=11434（环境可变 OLLAMA_HOST），ComfyUI=8188（环境可变 COMFY_HOST）

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || process.env.RUNTIME_PORT || 8794);
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const COMFY = process.env.COMFY_HOST || 'http://127.0.0.1:8188';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type,accept',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}

const agentOpts = { keepAlive: true, keepAliveMsecs: 10000, maxSockets: 16, maxFreeSockets: 8, timeout: 120000 };
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

function upstreamBase(raw) {
  const u = new URL(raw);
  return { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80) };
}

/* 探测「引擎还在不在」。
 *
 * 两个坑，都踩过：
 *  ① **不能复用 keep-alive 连接**。ComfyUI（aiohttp）闲置 75 秒就会关连接，
 *     而 Node 的 agent 还留着那条 socket，下次复用直接 ECONNRESET —— 于是引擎明明活着，
 *     探针却报「没运行」。诊断一次连接成本可以忽略，假阴性才是灾难。
 *  ② **探针端点要和主进程用同一个**。主进程探 ComfyUI 的 /system_stats，
 *     这里原来探 '/'（返回整个前端 HTML，几十上百 KB 的流量白读）。
 */
function probeEngine(base, timeoutMs, probePath) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const u = upstreamBase(base);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: probePath || '/',
        agent: false
      }, res => {
        finish({ ok: true, status: res.statusCode || 0 });
        res.resume();
      });
      req.setTimeout(Math.max(1000, timeoutMs), () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
      req.on('error', e => finish({ ok: false, error: (e && e.code) || (e && e.message) || 'error' }));
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || 'error' });
    }
  });
}

/* 代码比进程新 = 这个桥还在跑旧逻辑（改了源码却没重启的样子）。
 * 这里只负责「说出来」，重启由主进程做：桥自己没法重新加载自己。 */
const BOOT_MS = Date.now();
function buildInfo() {
  try {
    const fs = require('fs');
    const mtime = Math.round(fs.statSync(__filename).mtimeMs);
    return { build: mtime, stale: mtime > BOOT_MS + 1000 };
  } catch (e) {
    return { build: 0, stale: false };
  }
}

async function health() {
  // ComfyUI 用 /system_stats：几百字节，和主进程 comfy:detect 同一个口径（两边结论必须一致）
  const [ollama, comfy] = await Promise.all([
    probeEngine(OLLAMA, 1500, '/'),
    probeEngine(COMFY, 1500, '/system_stats')
  ]);
  return Object.assign({ ok: ollama.ok || comfy.ok, ollama, comfy }, buildInfo());
}

function normalizeBase(raw) {
  const base = String(raw || '').replace(/\/+$/, '');
  return base ? upstreamBase(base) : null;
}

function forward(req, res, base, prefix, rest, method, headers, body, timeoutMs) {
  const u = normalizeBase(base);
  if (!u) { sendJson(res, 502, { error: '引擎地址未配置' }); return; }
  const path = '/' + rest.replace(/^\/+/, '');
  const lib = u.protocol === 'https:' ? https : http;
  const agent = u.protocol === 'https:' ? httpsAgent : httpAgent;
  const upstream = lib.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    path,
    method,
    headers,
    agent
  }, up => {
    res.writeHead(up.statusCode || 502, Object.assign({}, up.headers, CORS));
    up.pipe(res);
  });
  // 模型拉取（/api/pull）可能是 GB 级下载，远超常规 60s 超时；timeoutMs <= 0 表示不设上游超时。
  if (timeoutMs > 0) upstream.setTimeout(timeoutMs, () => upstream.destroy(Object.assign(new Error('上游响应超时'), { code: 'ETIMEDOUT' })));
  upstream.on('error', e => {
    if (res.headersSent || res.writableEnded) { res.destroy(); return; }
    const code = e && e.code;
    const msg = e && e.message ? e.message : '未知错误';
    if (code === 'ECONNREFUSED') sendJson(res, 502, { error: '无法连接引擎服务（' + msg + '）：请确认引擎已启动。' });
    else if (code === 'ETIMEDOUT' || /超时/.test(msg)) sendJson(res, 504, { error: '引擎响应超时：请检查引擎状态。' });
    else sendJson(res, 502, { error: '引擎请求失败（' + msg + '）。' });
  });
  res.on('close', () => {
    if (!res.writableEnded && !upstream.destroyed) upstream.destroy();
  });
  if (body.length) upstream.write(body);
  upstream.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const url = req.url || '/';
  const q = url.indexOf('?');
  const pathname = (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, '') || '/';
  /* 查询串必须原样带给上游。
   * 曾经这里只拿 pathname 拼上游路径，`/comfy/view?filename=...&type=output` 转发过去
   * 变成没有文件名的 /view —— ComfyUI 一律 404，界面上就是「取回生成图失败：HTTP 404」。
   * 本地生图每次成功都会被这一步卡住，跟模型、显存、设置全都无关。 */
  const query = q === -1 ? '' : url.slice(q);

  if (pathname === '/health') {
    health().then(h => sendJson(res, 200, Object.assign({ service: 'open-agi-runtime' }, h)));
    return;
  }

  if (pathname === '/ollama' || pathname.startsWith('/ollama/')) {
    // restPath 用来判等（不能带查询串），rest 是真正转给上游的路径
    const restPath = pathname.slice('/ollama'.length);
    const rest = restPath + query;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = {};
      ['authorization', 'content-type', 'accept', 'user-agent'].forEach(k => { if (req.headers[k]) headers[k] = req.headers[k]; });
      if (body.length) headers['content-length'] = body.length;
      // 注意判等用 restPath：带上查询串之后 '/api/pull?x=1' 会让「拉模型不设超时」失效
      const isPull = restPath === '/api/pull';
      forward(req, res, OLLAMA, '/ollama', rest, req.method, headers, body, isPull ? 0 : 60000);
    });
    return;
  }

  if (pathname === '/comfy' || pathname.startsWith('/comfy/')) {
    const restPath = pathname.slice('/comfy'.length);
    const rest = restPath + query;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = {};
      ['authorization', 'content-type', 'accept', 'user-agent'].forEach(k => { if (req.headers[k]) headers[k] = req.headers[k]; });
      if (body.length) headers['content-length'] = body.length;
      forward(req, res, COMFY, '/comfy', rest, req.method, headers, body);
    });
    return;
  }

  sendJson(res, 404, { error: '未知路径：' + url });
});

server.listen(PORT, HOST, () => {
  console.log('Open AGI runtime running: http://' + HOST + ':' + PORT);
  console.log('  Ollama → ' + OLLAMA + '   ComfyUI → ' + COMFY);
});