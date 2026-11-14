// 本地引擎桥（阶段 C）
// 作用：把浏览器无法直连的本地模型引擎（Ollama 11434 / ComfyUI 8188）统一转发到一个
// 允许 CORS 的端口上，并对外提供 /health 探测引擎是否可用（面向 JIT / Python 测试模式）。
// 启动：node plugins/runtime/runtime.js        （默认监听 http://127.0.0.1:8794，可用 RUNTIME_PORT 覆盖）
// 端口约定：Ollama=11434（环境可变 OLLAMA_HOST），ComfyUI=8188（环境可变 COMFY_HOST）

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || process.env.RUNTIME_PORT || 8794);
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const COMFY = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
/* 模型商店把 Piper 引擎与音色下到 userData/tts，由主进程用 TTS_DIR 传进来。
 * 没有这个环境变量时（浏览器模式手动起桥）语音路由直接报「未安装」，不影响其它转发。 */
const TTS_DIR = process.env.TTS_DIR || '';
/* Kokoro 共享模型与 sherpa 引擎的固定位置（由 electron/tts-store.js 落盘）。
 * 所有音色共用同一份模型，切换音色只改 --sid。 */
const KOKORO_DIR = TTS_DIR ? path.join(TTS_DIR, 'kokoro') : '';
const SHERPA_EXE = TTS_DIR ? path.join(TTS_DIR, 'sherpa', 'bin', 'sherpa-onnx-offline-tts.exe') : '';

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

/* ---------------- 本地语音（Piper / Kokoro） ----------------
 * 商店只负责把引擎与权重下到 TTS_DIR；合成在这里做：
 * Piper 文本走 stdin，Kokoro 文本走命令行参数，WAV 落到临时文件再整块回传。
 * 超时分别是 30s / 60s，避免一个卡死的子进程把桥的后半段也堵住。 */
function ttsStatus() {
  const dir = TTS_DIR;
  const exe = dir ? path.join(dir, 'piper', 'piper.exe') : '';
  const voicesDir = dir ? path.join(dir, 'voices') : '';
  let voices = [];
  try {
    voices = fs.readdirSync(voicesDir).filter(f => /\.onnx$/i.test(f));
  } catch (e) {}
  const kokoroReady = !!(SHERPA_EXE && fs.existsSync(SHERPA_EXE) &&
    fs.existsSync(path.join(KOKORO_DIR, 'model.int8.onnx')) &&
    fs.existsSync(path.join(KOKORO_DIR, 'voices.bin')) &&
    fs.existsSync(path.join(KOKORO_DIR, 'tokens.txt')));
  return {
    ok: !!(dir && fs.existsSync(exe)),
    engine: !!(dir && fs.existsSync(exe)),
    dir, voices,
    kokoro: kokoroReady
  };
}

function sendWav(res, file) {
  fs.readFile(file, (err, buf) => {
    try { fs.unlink(file, () => {}); } catch (e) {}
    if (err) { sendJson(res, 500, { error: '读取合成结果失败：' + err.message }); return; }
    res.writeHead(200, Object.assign({
      'Content-Type': 'audio/wav',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    }, CORS));
    res.end(buf);
  });
}

function speakTts(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {
      sendJson(res, 400, { error: '请求不是合法 JSON' });
      return;
    }
    const text = String(body.text || '').slice(0, 2000).trim();
    if (!text) { sendJson(res, 400, { error: '没有要朗读的文本' }); return; }
    /* engine 缺省按 piper：老版本前端只发 voice，不认这个字段 */
    if (String(body.engine || 'piper') === 'kokoro') speakKokoro(res, body, text);
    else speakPiper(res, body, text);
  });
}

function speakPiper(res, body, text) {
  const voice = path.basename(String(body.voice || ''));
  if (!/\.onnx$/i.test(voice)) { sendJson(res, 400, { error: '语音文件名不合法' }); return; }
  if (!TTS_DIR) { sendJson(res, 404, { error: '本地语音未启用：请用桌面端启动' }); return; }
  const model = path.join(TTS_DIR, 'voices', voice);
  const exe = path.join(TTS_DIR, 'piper', 'piper.exe');
  if (!fs.existsSync(model)) { sendJson(res, 404, { error: '没有找到语音权重，请先在模型商店下载' }); return; }
  if (!fs.existsSync(exe)) { sendJson(res, 404, { error: '本地语音引擎未安装，请重新下载任一语音' }); return; }

  const out = path.join(os.tmpdir(), 'openagi-tts-' + process.pid + '-' + Date.now() + '.wav');
  const rate = Math.max(0.5, Math.min(2, Number(body.rate) || 1));
  const args = ['--model', model, '--output_file', out];
  const cfg = model + '.json';
  if (fs.existsSync(cfg)) args.push('--config', cfg);
  /* Piper 的 length_scale 越大越慢：rate=1.25 对应 0.8。 */
  args.push('--length_scale', String(Math.round((1 / rate) * 100) / 100));

  runTts(res, exe, args, text, path.join(TTS_DIR, 'piper'), out, 30000);
}

/* Kokoro 通过 sherpa-onnx 的离线 TTS 命令行合成：音色只是 --sid 不同，
 * 模型/声纹/音素表都指向同一份共享文件。RTF 约 1.5（2 秒音频约 3 秒合成），
 * 所以超时放宽到 60s，长句也不会被误杀。 */
function speakKokoro(res, body, text) {
  if (!TTS_DIR || !SHERPA_EXE || !KOKORO_DIR) {
    sendJson(res, 404, { error: 'Kokoro 本地语音未启用：请用桌面端启动' });
    return;
  }
  const model = path.join(KOKORO_DIR, 'model.int8.onnx');
  const voices = path.join(KOKORO_DIR, 'voices.bin');
  const tokens = path.join(KOKORO_DIR, 'tokens.txt');
  if (!fs.existsSync(SHERPA_EXE)) { sendJson(res, 404, { error: 'Kokoro 引擎未安装，请先在模型商店下载超自然音色' }); return; }
  if (!fs.existsSync(model) || !fs.existsSync(voices) || !fs.existsSync(tokens)) {
    sendJson(res, 404, { error: 'Kokoro 共享模型不完整，请在模型商店重新下载' });
    return;
  }
  const sid = Math.max(0, Math.min(200, parseInt(body.sid, 10) || 0));
  const rate = Math.max(0.5, Math.min(2, Number(body.rate) || 1));
  /* length_scale 与语速反向：rate=1.25 → 0.8（和 Piper 保持同一套语义）。 */
  const scale = Math.round((1 / rate) * 100) / 100;
  const out = path.join(os.tmpdir(), 'openagi-kokoro-' + process.pid + '-' + Date.now() + '.wav');
  const threads = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  const lexicons = [
    path.join(KOKORO_DIR, 'lexicon-us-en.txt'),
    path.join(KOKORO_DIR, 'lexicon-zh.txt')
  ].filter(p => fs.existsSync(p)).join(',');
  const args = [
    '--kokoro-model=' + model,
    '--kokoro-voices=' + voices,
    '--kokoro-tokens=' + tokens
  ];
  if (lexicons) args.push('--kokoro-lexicon=' + lexicons);
  args.push(
    '--sid=' + sid,
    '--num-threads=' + threads,
    '--kokoro-length-scale=' + scale,
    '--output-filename=' + out,
    text
  );
  /* cwd 必须是 exe 所在目录：sherpa 的 shared 包把 onnxruntime.dll 放在 exe 旁边，
   * 从别处启动会找不到 DLL。 */
  runTts(res, SHERPA_EXE, args, '', path.dirname(SHERPA_EXE), out, 60000);
}

/* Piper / Kokoro 共用的子进程回收：超时、错误、非零退出都转成 JSON 错误，
 * 成功则把 WAV 整块回传并删临时文件。stdinText 为空表示不写 stdin（Kokoro 走命令行参数）。 */
function runTts(res, exe, args, stdinText, cwd, out, timeoutMs) {
  let stderr = '';
  let done = false;
  const child = spawn(exe, args, { cwd, windowsHide: true });
  const finish = () => { if (!done) { done = true; clearTimeout(timer); } };
  const timer = setTimeout(() => {
    if (done) return;
    finish();
    try { child.kill(); } catch (e) {}
    try { fs.unlink(out, () => {}); } catch (e) {}
    sendJson(res, 504, { error: '语音合成超时' });
  }, timeoutMs);
  child.stderr.on('data', d => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on('error', e => {
    if (done) return;
    finish();
    sendJson(res, 500, { error: '启动语音引擎失败：' + e.message });
  });
  child.on('close', code => {
    if (done) return;
    finish();
    if (code !== 0 || !fs.existsSync(out)) {
      try { fs.unlink(out, () => {}); } catch (e) {}
      sendJson(res, 500, { error: '语音合成失败' + (stderr ? '：' + stderr.trim().slice(-300) : '') });
      return;
    }
    sendWav(res, out);
  });
  child.stdin.end(stdinText || '');
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

  if (pathname === '/tts/status') {
    sendJson(res, 200, ttsStatus());
    return;
  }

  if (pathname === '/tts/speak' && req.method === 'POST') {
    speakTts(req, res);
    return;
  }

  sendJson(res, 404, { error: '未知路径：' + url });
});

server.listen(PORT, HOST, () => {
  console.log('Open AGI runtime running: http://' + HOST + ':' + PORT);
  console.log('  Ollama → ' + OLLAMA + '   ComfyUI → ' + COMFY);
});