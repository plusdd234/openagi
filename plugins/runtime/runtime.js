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
const MELO_DIR = TTS_DIR ? path.join(TTS_DIR, 'melo') : '';
const VITS_DIR = TTS_DIR ? path.join(TTS_DIR, 'vits-theresa') : '';
const ZIPVOICE_DIR = TTS_DIR ? path.join(TTS_DIR, 'zipvoice') : '';
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
  const meloReady = !!(SHERPA_EXE && fs.existsSync(SHERPA_EXE) &&
    fs.existsSync(path.join(MELO_DIR, 'model.onnx')) &&
    fs.existsSync(path.join(MELO_DIR, 'tokens.txt')) &&
    fs.existsSync(path.join(MELO_DIR, 'lexicon.txt')));
  /* 角色音色的 onnx 名字跟着模型走（theresa.onnx），只要有一个且词典齐就算就绪 */
  let vitsReady = false;
  try{
    vitsReady = !!(SHERPA_EXE && fs.existsSync(SHERPA_EXE) &&
      fs.readdirSync(VITS_DIR).some(f => /\.onnx$/i.test(f)) &&
      fs.existsSync(path.join(VITS_DIR, 'tokens.txt')) &&
      fs.existsSync(path.join(VITS_DIR, 'lexicon.txt')));
  }catch(e){ vitsReady = false; }
  const zipReady = !!(SHERPA_EXE && fs.existsSync(SHERPA_EXE) &&
    fs.existsSync(path.join(ZIPVOICE_DIR, 'encoder.int8.onnx')) &&
    fs.existsSync(path.join(ZIPVOICE_DIR, 'decoder.int8.onnx')) &&
    fs.existsSync(path.join(ZIPVOICE_DIR, 'tokens.txt')) &&
    fs.existsSync(path.join(ZIPVOICE_DIR, 'vocos_24khz.onnx')));
  /* 克隆是否可用：模型之外还要有参考录音与参考文本，缺一样就明确告诉前端「还没录」 */
  let cloneReady = false;
  let refText = '';
  try{
    refText = fs.readFileSync(path.join(ZIPVOICE_DIR, 'ref.txt'), 'utf8').trim();
    cloneReady = zipReady && fs.existsSync(path.join(ZIPVOICE_DIR, 'ref.wav')) && !!refText;
  }catch(e){ cloneReady = false; }
  /* 参数合成音库：离线蒸馏产物，运行时只做拼接，不加载任何模型 */
  let param = { ready: false, units: 0, chars: 0, rate: 0, source: '' };
  try { param = paramStatus(dir ? path.join(dir, 'param') : ''); } catch (e) { /* 索引损坏时保持未就绪 */ }
  return {
    ok: !!(dir && fs.existsSync(exe)),
    engine: !!(dir && fs.existsSync(exe)),
    dir, voices,
    kokoro: kokoroReady,
    melo: meloReady,
    vits: vitsReady,
    zipvoice: zipReady,
    clone: cloneReady,
    param: !!param.ready,
    paramUnits: Number(param.units) || 0,
    paramChars: Number(param.chars) || 0,
    paramRate: Number(param.rate) || 0,
    paramSource: String(param.source || ''),
    refText: refText.slice(0, 200)
  };
}

function sendWavBuffer(res, buf) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'audio/wav',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  }, CORS));
  res.end(buf);
}

function sendWav(res, file) {
  fs.readFile(file, (err, buf) => {
    try { fs.unlink(file, () => {}); } catch (e) {}
    if (err) { sendJson(res, 500, { error: '读取合成结果失败：' + err.message }); return; }
    sendWavBuffer(res, buf);
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
    const engine = String(body.engine || 'piper');
    /* 参数合成自己解析 [[r]]/[[p]]/[[f]]/[[e]]/[[t]]，不走逐段子进程那条路 */
    if (engine === 'param') { speakParam(res, body, text); return; }
    /* 韵律标记对所有支持分段语速的本地引擎生效（Piper / Kokoro / MeloTTS / VITS）。
     * 没带标记时仍然走原来的单次合成，不增加任何开销。 */
    if (PROSODY_ENGINES[engine]) {
      const plan = parseProsody(text, Number(body.rate) || 1);
      if (plan.used && plan.segments.length) { speakProsody(res, body, plan, engine); return; }
    }
    if (engine === 'kokoro') speakKokoro(res, body, text);
    else if (engine === 'melo') speakMelo(res, body, text);
    else if (engine === 'vits') speakVits(res, body, text);
    else if (engine === 'zipvoice') speakZipVoice(res, body, text);
    else speakPiper(res, body, text);
  });
}

/* 语速统一语义：rate 越大越快，引擎的 length_scale 越大越慢。
 * 单次合成和逐段合成都用这一份换算，避免两条链路语速不一致。 */
function ttsRateScale(rate) {
  const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
  return Math.round((1 / r) * 100) / 100;
}

function ttsFail(status, msg) {
  const e = new Error(msg);
  e.status = status;
  throw e;
}

function sendTtsError(res, e) {
  sendJson(res, (e && e.status) || 500, { error: (e && e.message) || '语音合成失败' });
}

function ttsTemp(prefix) {
  return path.join(os.tmpdir(), 'openagi-' + prefix + '-' + process.pid + '-' + Date.now() +
    '-' + Math.random().toString(36).slice(2, 7) + '.wav');
}

/* 各引擎的公共参数（模型 / 词典 / 线程）只算一次：
 * 单次合成补一个 length_scale 和输出路径，韵律分段则每段补一次。 */
function piperSetup(body) {
  const voice = path.basename(String(body.voice || ''));
  if (!/\.onnx$/i.test(voice)) ttsFail(400, '语音文件名不合法');
  if (!TTS_DIR) ttsFail(404, '本地语音未启用：请用桌面端启动');
  const model = path.join(TTS_DIR, 'voices', voice);
  const exe = path.join(TTS_DIR, 'piper', 'piper.exe');
  if (!fs.existsSync(model)) ttsFail(404, '没有找到语音权重，请先在模型商店下载');
  if (!fs.existsSync(exe)) ttsFail(404, '本地语音引擎未安装，请重新下载任一语音');
  const baseArgs = ['--model', model];
  const cfg = model + '.json';
  if (fs.existsSync(cfg)) baseArgs.push('--config', cfg);
  return { exe: exe, cwd: path.join(TTS_DIR, 'piper'), baseArgs: baseArgs, stdin: true, timeout: 30000 };
}

function speakPiper(res, body, text) {
  let s;
  try { s = piperSetup(body); } catch (e) { sendTtsError(res, e); return; }
  const out = ttsTemp('piper');
  const args = s.baseArgs.concat(['--output_file', out, '--length_scale', String(ttsRateScale(body.rate))]);
  runTts(res, s.exe, args, text, s.cwd, out, s.timeout);
}

/* Kokoro 通过 sherpa-onnx 的离线 TTS 命令行合成：音色只是 --sid 不同，
 * 模型/声纹/音素表都指向同一份共享文件。RTF 约 1.5（2 秒音频约 3 秒合成），
 * 所以超时放宽到 60s，长句也不会被误杀。 */
function kokoroSetup(body) {
  if (!TTS_DIR || !SHERPA_EXE || !KOKORO_DIR) ttsFail(404, 'Kokoro 本地语音未启用：请用桌面端启动');
  const model = path.join(KOKORO_DIR, 'model.int8.onnx');
  const voices = path.join(KOKORO_DIR, 'voices.bin');
  const tokens = path.join(KOKORO_DIR, 'tokens.txt');
  if (!fs.existsSync(SHERPA_EXE)) ttsFail(404, 'Kokoro 引擎未安装，请先在模型商店下载超自然音色');
  if (!fs.existsSync(model) || !fs.existsSync(voices) || !fs.existsSync(tokens)) {
    ttsFail(404, 'Kokoro 共享模型不完整，请在模型商店重新下载');
  }
  const sid = Math.max(0, Math.min(200, parseInt(body.sid, 10) || 0));
  const threads = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  const lexicons = [
    path.join(KOKORO_DIR, 'lexicon-us-en.txt'),
    path.join(KOKORO_DIR, 'lexicon-zh.txt')
  ].filter(p => fs.existsSync(p)).join(',');
  const baseArgs = [
    '--kokoro-model=' + model,
    '--kokoro-voices=' + voices,
    '--kokoro-tokens=' + tokens
  ];
  if (lexicons) baseArgs.push('--kokoro-lexicon=' + lexicons);
  baseArgs.push('--sid=' + sid, '--num-threads=' + threads);
  return { exe: SHERPA_EXE, cwd: path.dirname(SHERPA_EXE), baseArgs: baseArgs, timeout: 60000 };
}

function speakKokoro(res, body, text) {
  let s;
  try { s = kokoroSetup(body); } catch (e) { sendTtsError(res, e); return; }
  const out = ttsTemp('kokoro');
  const args = s.baseArgs.concat([
    '--kokoro-length-scale=' + ttsRateScale(body.rate),
    '--output-filename=' + out,
    text
  ]);
  /* cwd 必须是 exe 所在目录：sherpa 的 shared 包把 onnxruntime.dll 放在 exe 旁边，
   * 从别处启动会找不到 DLL。 */
  runTts(res, s.exe, args, '', s.cwd, out, s.timeout);
}

/* MeloTTS zh_en（VITS）：单女声，中英混读更稳。
 * 规则 fst 的命名各版本不完全一致（date.fst / date-zh.fst），所以按 *.fst 收集，
 * 传空也不会让引擎报错。 */
function meloSetup() {
  if (!TTS_DIR || !SHERPA_EXE || !MELO_DIR) ttsFail(404, 'MeloTTS 本地语音未启用：请用桌面端启动');
  /* 官方包叫 model.onnx，量化包可能带 int8 后缀，两种都认 */
  const model = ['model.onnx', 'model.int8.onnx']
    .map(f => path.join(MELO_DIR, f)).filter(p => fs.existsSync(p))[0] || '';
  const tokens = path.join(MELO_DIR, 'tokens.txt');
  const lexicon = path.join(MELO_DIR, 'lexicon.txt');
  if (!fs.existsSync(SHERPA_EXE)) ttsFail(404, 'MeloTTS 引擎未安装，请先在模型商店下载');
  if (!model || !fs.existsSync(tokens) || !fs.existsSync(lexicon)) {
    ttsFail(404, 'MeloTTS 模型不完整，请在模型商店重新下载');
  }
  const threads = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  let fsts = '';
  try{
    fsts = fs.readdirSync(MELO_DIR).filter(f => /\.fst$/i.test(f)).sort()
      .map(f => path.join(MELO_DIR, f)).join(',');
  }catch(e){ fsts = ''; }
  const baseArgs = [
    '--vits-model=' + model,
    '--vits-lexicon=' + lexicon,
    '--vits-tokens=' + tokens,
    '--num-threads=' + threads
  ];
  if (fsts) baseArgs.push('--tts-rule-fsts=' + fsts);
  return { exe: SHERPA_EXE, cwd: path.dirname(SHERPA_EXE), baseArgs: baseArgs, timeout: 60000 };
}

function speakMelo(res, body, text) {
  let s;
  try { s = meloSetup(); } catch (e) { sendTtsError(res, e); return; }
  const out = ttsTemp('melo');
  const args = s.baseArgs.concat([
    '--vits-length-scale=' + ttsRateScale(body.rate),
    '--output-filename=' + out,
    text
  ]);
  runTts(res, s.exe, args, '', s.cwd, out, s.timeout);
}

/* 朗读韵律与参数合成各自独立成模块，方便脱离 HTTP 服务做纯逻辑测试。 */
const { parseProsody, concatWavs } = require('./tts-prosody');
const { paramStatus, synth: synthParam } = require('./tts-param');

/* VITS 角色音色（社区模型）：onnx 文件名随模型变化，按目录里的 *.onnx 取；
 * lexicon/tokens 必需，规则 fst（date/number/phone/heteronym）有则一起交给引擎。 */
function vitsSetup() {
  if (!TTS_DIR || !SHERPA_EXE || !VITS_DIR) ttsFail(404, '角色音色未启用：请用桌面端启动');
  if (!fs.existsSync(SHERPA_EXE)) ttsFail(404, '角色音色引擎未安装，请先在模型商店下载');
  let model = '';
  try{
    const f = fs.readdirSync(VITS_DIR).filter(n => /\.onnx$/i.test(n))[0];
    model = f ? path.join(VITS_DIR, f) : '';
  }catch(e){ model = ''; }
  const tokens = path.join(VITS_DIR, 'tokens.txt');
  const lexicon = path.join(VITS_DIR, 'lexicon.txt');
  if (!model || !fs.existsSync(tokens) || !fs.existsSync(lexicon)) {
    ttsFail(404, '角色音色模型不完整，请在模型商店重新下载');
  }
  const threads = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  let fsts = '';
  try{
    fsts = fs.readdirSync(VITS_DIR).filter(f => /\.fst$/i.test(f)).sort()
      .map(f => path.join(VITS_DIR, f)).join(',');
  }catch(e){ fsts = ''; }
  const baseArgs = [
    '--vits-model=' + model,
    '--vits-lexicon=' + lexicon,
    '--vits-tokens=' + tokens,
    '--num-threads=' + threads
  ];
  if (fsts) baseArgs.push('--tts-rule-fsts=' + fsts);
  return { exe: SHERPA_EXE, cwd: path.dirname(SHERPA_EXE), baseArgs: baseArgs, timeout: 60000 };
}

function speakVits(res, body, text) {
  let s;
  try { s = vitsSetup(); } catch (e) { sendTtsError(res, e); return; }
  const out = ttsTemp('vits');
  const args = s.baseArgs.concat([
    '--vits-length-scale=' + ttsRateScale(body.rate),
    '--output-filename=' + out,
    text
  ]);
  runTts(res, s.exe, args, '', s.cwd, out, s.timeout);
}

/* 支持韵律标记的引擎：它们都能按段设置 length_scale，逐段合成后再拼成一个 WAV。
 * ZipVoice 的语速参数与 VITS 不同，暂不参与，前端也不会给它注入标记。 */
const PROSODY_ENGINES = { piper: 1, kokoro: 1, melo: 1, vits: 1 };

function prosodySetup(engine, body) {
  if (engine === 'piper') return piperSetup(body);
  if (engine === 'kokoro') return kokoroSetup(body);
  if (engine === 'melo') return meloSetup();
  return vitsSetup();
}

/* 单段参数：Piper 把文本写 stdin，其它三个把文本放命令行末尾。 */
function segmentArgs(engine, setup, text, rate, out) {
  const scale = ttsRateScale(rate);
  if (engine === 'piper') {
    return setup.baseArgs.concat(['--output_file', out, '--length_scale', String(scale)]);
  }
  if (engine === 'kokoro') {
    return setup.baseArgs.concat(['--kokoro-length-scale=' + scale, '--output-filename=' + out, text]);
  }
  return setup.baseArgs.concat(['--vits-length-scale=' + scale, '--output-filename=' + out, text]);
}

/* 带韵律标记的合成：逐段合成，按段间静音拼成一个 WAV。
 * 段数由解析器限制在 16 段以内，避免一句话触发几十次子进程。 */
function speakProsody(res, body, plan, engine) {
  (async () => {
    const s = prosodySetup(engine, body);
    const items = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const seg = plan.segments[i];
      const out = ttsTemp(engine);
      const args = segmentArgs(engine, s, seg.text, seg.rate, out);
      const buf = await runTtsBuffer(s.exe, args, s.stdin ? seg.text : '', s.cwd, out, s.timeout);
      items.push({ buf: buf, after: seg.after });
    }
    sendWavBuffer(res, concatWavs(items, plan.lead));
  })().catch(e => sendTtsError(res, e));
}

/* 参数合成：运行时不碰神经网络，直接查蒸馏音库并用 PSOLA 拼 WAV。
 * 音库由 tools/distill-voice.js 离线生成；没有音库时明确告诉前端去蒸馏，
 * 不要静默退回别的引擎（音色会变，快问快答的预期也就断了）。 */
function speakParam(res, body, text) {
  const dir = TTS_DIR ? path.join(TTS_DIR, 'param') : '';
  let wav = null;
  try {
    wav = synthParam(text, {
      dir: dir,
      rate: body.rate,
      pitch: body.pitch,
      gain: body.gain
    });
  } catch (e) {
    sendJson(res, 500, { error: '参数合成失败：' + ((e && e.message) || '音库读取异常') });
    return;
  }
  if (!wav) {
    sendJson(res, 404, {
      error: '参数音库还没生成：在模型商店装好角色音色后，运行 node tools/distill-voice.js 蒸馏一次'
    });
    return;
  }
  sendWavBuffer(res, wav);
}

/* ZipVoice 零样本克隆：参考音频与参考文本由设置页写入 zipvoice/ref.wav + ref.txt。
 * num-steps 固定 4（distill 模型的推荐值），再大只是线性变慢。 */
function speakZipVoice(res, body, text) {
  if (!TTS_DIR || !SHERPA_EXE || !ZIPVOICE_DIR) {
    sendJson(res, 404, { error: 'ZipVoice 声音克隆未启用：请用桌面端启动' });
    return;
  }
  const enc = path.join(ZIPVOICE_DIR, 'encoder.int8.onnx');
  const dec = path.join(ZIPVOICE_DIR, 'decoder.int8.onnx');
  const tokens = path.join(ZIPVOICE_DIR, 'tokens.txt');
  const vocoder = path.join(ZIPVOICE_DIR, 'vocos_24khz.onnx');
  const ref = path.join(ZIPVOICE_DIR, 'ref.wav');
  const refTxt = path.join(ZIPVOICE_DIR, 'ref.txt');
  if (!fs.existsSync(SHERPA_EXE)) { sendJson(res, 404, { error: 'ZipVoice 引擎未安装，请先在模型商店下载' }); return; }
  if (!fs.existsSync(enc) || !fs.existsSync(dec) || !fs.existsSync(tokens) || !fs.existsSync(vocoder)) {
    sendJson(res, 404, { error: 'ZipVoice 模型不完整，请在模型商店重新下载' });
    return;
  }
  let refText = '';
  try{ refText = fs.readFileSync(refTxt, 'utf8').trim(); }catch(e){ refText = ''; }
  if (!fs.existsSync(ref) || !refText) {
    sendJson(res, 400, { error: '还没有参考录音：到「设置 → 语音合成 → 声音克隆」录一段 5-15 秒的 WAV，并填写录音里说的话' });
    return;
  }
  const out = path.join(os.tmpdir(), 'openagi-zipvoice-' + process.pid + '-' + Date.now() + '.wav');
  const threads = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  const lexicons = [path.join(ZIPVOICE_DIR, 'lexicon.txt'), path.join(ZIPVOICE_DIR, 'lexicon-en-us.txt')]
    .filter(p => fs.existsSync(p)).join(',');
  const args = [
    '--zipvoice-encoder=' + enc,
    '--zipvoice-decoder=' + dec,
    '--zipvoice-tokens=' + tokens,
    '--zipvoice-vocoder=' + vocoder,
    '--zipvoice-lexicon=' + lexicons,
    '--reference-audio=' + ref,
    '--reference-text=' + refText,
    '--num-steps=4',
    '--num-threads=' + threads,
    '--output-filename=' + out,
    text
  ];
  runTts(res, SHERPA_EXE, args, '', path.dirname(SHERPA_EXE), out, 90000);
}

/* 分段合成专用：跑一次引擎，成功返回 WAV Buffer，失败抛错（错误文案与 runTts 一致）。
 * 临时文件在成功/失败/超时三条路径都会删掉，避免多段合成后堆一目录 wav。 */
function runTtsBuffer(exe, args, stdinText, cwd, out, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let done = false;
    const child = spawn(exe, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) {}
      try { fs.unlink(out, () => {}); } catch (e) {}
      reject(new Error('语音合成超时'));
    }, timeoutMs);
    child.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('启动语音引擎失败：' + e.message));
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(out)) {
        try { fs.unlink(out, () => {}); } catch (e) {}
        reject(new Error('语音合成失败' + (stderr ? '：' + stderr.trim().slice(-300) : '')));
        return;
      }
      fs.readFile(out, (err, buf) => {
        try { fs.unlink(out, () => {}); } catch (e) {}
        if (err) reject(new Error('读取合成结果失败：' + err.message));
        else resolve(buf);
      });
    });
    child.stdin.end(stdinText || '');
  });
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