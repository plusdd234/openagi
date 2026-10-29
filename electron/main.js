/* Electron 主进程
 *
 * 职责边界很窄：起窗口、托管本地服务、提供稳定的 app:// 源、跑内容热更新。
 * 业务逻辑一行都不在这里 —— 前端仍然是那套静态脚本。
 *
 * 三个关键决策（改之前先读）：
 *   1) 用自定义协议 app://openagi 而不是 file:// —— file:// 的 localStorage 归属随路径变化，
 *      每次热更新换目录就会「数据全丢」；app:// 的 origin 永远稳定。
 *   2) 本地服务（relay / tripo / chat / runtime）用 utilityProcess 子进程跑，不 require ——
 *      它们是 listen-on-require，而且服务崩了不该带走整个窗口。
 *   3) 内容包（index.html / css / js / vendor）单独热更新，程序本体更新留给 P2 的安装包链路。
 */
const { app, BrowserWindow, protocol, ipcMain, Menu, shell, dialog, utilityProcess } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const netmod = require('net');
const { spawn, execFile } = require('child_process');
const content = require('./content-updater');
const ollamaDl = require('./ollama-download');
const comfySetup = require('./comfy-setup');
const modelStore = require('./model-store');
const mediaStoreMod = require('./media-store');
const engineAuto = require('./engine-autostart');
const engineKeepalive = require('./engine-keepalive');
const { probeHardwareMain } = require('./hardware-info');

const REPO_ROOT = path.join(__dirname, '..');
let bootLogFile = null;   // 打包后没有 stdout，统一写 userData/boot.log

// GUI 双击启动时 stdout/stderr 可能指向已断开的管道：写入会异步触发 EPIPE，
// 一旦变成 uncaughtException 就会打断窗口初始化。isTTY 判断在 Windows 分离进程下
// 不可靠，因此日志不用 console.log（console 缓存了进程创建时的旧流引用），
// 统一走 writeOut()：
//   1) 只写进程创建时的原始 stdout 引用；
//   2) 原始流挂 error 监听，EPIPE 一律吞掉，不让它升级成 uncaughtException；
//   3) 任一次写入失败（返回 false / 抛错 / error 事件）后进入静默态，不再尝试。
const origStdout = process.stdout;
const origStderr = process.stderr;
let stdoutDead = false;
[origStdout, origStderr].forEach(s => { if(s) s.on('error', () => { stdoutDead = true; }); });
function writeOut(text){
  if(stdoutDead || !origStdout) return;
  try {
    if(origStdout.write(text) === false) stdoutDead = true;
  } catch(e){ stdoutDead = true; }
}
function logLine(){
  const text = '[' + new Date().toISOString().slice(11, 19) + '] ' +
    Array.prototype.map.call(arguments, x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { if(bootLogFile) fs.appendFileSync(bootLogFile, text + '\n'); } catch(e){}
  writeOut(text + '\n');
}
const CONTENT_ORIGIN = 'app://openagi';

// 自定义协议必须在 ready 之前登记
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}, {
  /* 媒体协议：播放器要播本地视频，而 app://openagi 这个源不允许直接读 file://。
   * stream:true 是硬要求——没有它就整个文件读进内存再播，一集 1 GB 直接爆。
   * bypassCSP:true 是因为页面 CSP 里没有这个源，字幕 / 封面都要从这儿取。 */
  scheme: 'openagi-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}]);

let mainWin = null;
let serviceProcs = {};            // 插件服务子进程（key = 插件 id）
let chatProc = null;
let contentRoot = REPO_ROOT;       // 协议处理器读这个变量（热更新后就地改）
let contentVersion = 'bundled';
let pluginPorts = {};             // 插件实际端口（key = 插件 id，从 manifest 默认值顺延）
let chatPort = 8792;
/* 媒体库实例（electron/media-store.js）。协议处理器和 media:* IPC 都用它，
 * 在 ready 里创建——因为它的根目录要用 app.getPath('userData')。 */
let MEDIA = null;

// ---- Ollama 引擎管理（检测 / 下载 / 静默安装 / 启动）----
//
// 为什么不用一条 URL：ollama.com/download/OllamaSetup.exe 会 307 到
// github.com/.../OllamaSetup.exe，再 302 到 release-assets.githubusercontent.com。
// 国内这条链单连接只有十几 KB/s（本机实测 17 KB/s，1.66 GB 要二十多小时），
// 而安装包这几年从 700 MB 涨到了 1.6 GB。所以下载全部交给 ollama-download.js：
// 多镜像并发测速选源 + 分片并发 + 断点续传 + 停滞换源。
const OLLAMA_RELEASE_API = 'https://api.github.com/repos/ollama/ollama/releases/latest';
// 网页跳转地址：ollama.com/download/OllamaSetup.exe 与这个等价，但少一跳
const OLLAMA_SETUP_LATEST = 'https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe';
// GitHub 加速镜像（前缀）+ 官方直连。2026-10-27 实测（同一台机器、同一时刻）：
//   gh.monlor.com 139 KB/s > GitHub 直连 87 KB/s > gh-proxy.com 37 KB/s
//   其余十几个（ghfast/ghproxy.net/llkk/moeyy/ghproxy.cc…）全部 403 / 超时 / 证书过期 / DNS 失败。
// 注意：镜像存活率与速度每天都在变，顺序不是承诺——真正择优靠 probeOne 实测。
// 列表刻意保留几个当前不可用的，能连上的时候它们往往比直连快得多。
const OLLAMA_MIRRORS = [
  { prefix: '', name: 'GitHub 直连' },
  { prefix: 'https://gh.monlor.com/', name: 'gh.monlor' },
  { prefix: 'https://gh-proxy.com/', name: 'gh-proxy' },
  { prefix: 'https://ghfast.top/', name: 'ghfast' },
  { prefix: 'https://ghproxy.net/', name: 'ghproxy.net' },
  { prefix: 'https://gh.llkk.cc/', name: 'llkk' },
  { prefix: 'https://github.moeyy.xyz/', name: 'moeyy' },
  { prefix: 'https://gitproxy.click/', name: 'gitproxy' }
];
// 用户可覆盖：填自定义安装包地址（内网源 / 自建镜像）。
// 环境变量 OPENAGI_OLLAMA_SETUP_URL，或 userData/update.json 里的 ollamaSetupUrl。
function ollamaCustomSources(){
  const out = [];
  let envUrl = '';
  try{ envUrl = process.env.OPENAGI_OLLAMA_SETUP_URL || ''; }catch(e){}
  if(/^https?:\/\//i.test(envUrl)) out.push({ url: envUrl, name: '自定义（env）' });
  let cfgUrl = '';
  try{
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update.json'), 'utf8'));
    cfgUrl = String((cfg && cfg.ollamaSetupUrl) || '');
  }catch(e){}
  // 配置里的值也可能是误填的提示词（relayBase 踩过这个坑），URL 类配置取用前必须校验
  if(/^https?:\/\//i.test(cfgUrl)) out.push({ url: cfgUrl, name: '自定义（配置）' });
  return out;
}
let ollamaInstalling = false;
let ollamaCancel = false;
// ComfyUI 安装状态：与 Ollama 分开，两者可以互不影响地各自跑
let comfyInstalling = false;
let comfyCancel = false;
/* 模型商店的下载任务：id → { cancel }
 * 一个 id 一条任务，重复点安装会被挡掉；取消只置标志，下载循环在分片边界退出并保留续传侧车。 */
const storeJobs = new Map();
let ollamaLastProgress = null;

function ollamaPaths(){
  let base = null;
  try { base = app.getPath('localAppData'); } catch(e){ base = null; }
  if(!base && process.platform === 'win32' && process.env.LOCALAPPDATA) base = process.env.LOCALAPPDATA;
  const dir = base ? path.join(base, 'Programs', 'Ollama') : '';
  return { dir, exe: dir ? path.join(dir, 'ollama.exe') : '' };
}
function ollamaSetupPath(){ return path.join(app.getPath('temp'), 'the-seed-ollama-setup.exe'); }
function ollamaInstalled(){
  if(process.platform !== 'win32') return { installed: false, exe: null, dir: null, platform: process.platform };
  const { dir, exe } = ollamaPaths();
  const ok = !!(exe && fs.existsSync(exe));
  return { installed: ok, exe: ok ? exe : null, dir };
}

/* 解析最新的 Windows 安装包地址。
 * 先问 GitHub API 拿 assets（能顺带拿到 size 与官方 sha256，用于校验），失败就退回跳转地址。 */
async function resolveOllamaAsset(){
  try{
    const r = await fetch(OLLAMA_RELEASE_API, {
      signal: AbortSignal.timeout(12000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'openagi-desktop' }
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const asset = (j.assets || []).find(a => a && a.name === 'OllamaSetup.exe');
    if(asset && asset.browser_download_url){
      return {
        url: asset.browser_download_url,
        size: Number(asset.size) || 0,
        version: String(j.tag_name || ''),
        digest: String(asset.digest || '')
      };
    }
    throw new Error('该版本没有 OllamaSetup.exe 资源');
  }catch(e){
    logLine('[ollama] release API 不可用，退回跳转地址：' + ((e && e.message) || e));
    return { url: OLLAMA_SETUP_LATEST, size: 0, version: '', digest: '' };
  }
}
/* 下载安装包：交给 ollama-download.js（多源择优 + 分片并发 + 续传 + 停滞换源）。
 * httpGet 用 Electron net（继承系统代理），不用 node https——后者在国内经常连不上。 */
async function fetchOllamaSetup(send, asset){
  const dest = ollamaSetupPath();
  const httpGet = ollamaDl.makeElectronHttpGet(netmod_electron());
  const sources = OLLAMA_MIRRORS.map(m => ({
    url: m.prefix ? m.prefix + asset.url : asset.url,
    name: m.name
  })).concat(ollamaCustomSources());
  const title = '正在下载 Ollama 安装包';

  // 进度语义：整条进度条 0-100 由主进程统一算，前端只负责显示。
  //   下载占 0-48（1.6 GB 是最长的一段，必须给够宽度）
  //   校验 50 / 安装 55-85 / 启动 90 / 完成 100
  // 早期版本让前端再乘一次 0.5，安装阶段会从 55 掉回 28——进度条倒退是最容易被当成卡死的信号。
  const paint = info => {
    let message;
    if(info.stage === 'probe') message = '正在测速选择最快的下载源…';
    else if(info.stage === 'done') message = title + '（校验通过）';
    else {
      const mb = n => Math.round(n / 1048576);
      const parts = [title + ' ' + mb(info.done) + ' / ' + mb(info.total) + ' MB'];
      if(info.pct >= 0) parts.push(info.pct + '%');
      if(info.speed > 0) parts.push(ollamaDl.fmtSpeed(info.speed));
      if(info.etaMs >= 0) parts.push('剩余 ' + ollamaDl.fmtEta(info.etaMs));
      message = parts.join(' · ');
    }
    const downloadPct = info.pct >= 0 ? info.pct : 0;
    const payload = {
      stage: info.stage === 'probe' ? 'download' : (info.stage === 'done' ? 'download-done' : 'download'),
      pct: info.stage === 'done' ? 48 : Math.max(0, Math.min(48, Math.round(downloadPct * 0.48))),
      message,
      done: info.done,
      total: info.total,
      percent: info.pct,          // 下载本身的百分比（0-100），界面可单独展示
      speed: info.speed || 0,
      etaMs: info.etaMs,
      source: info.source,
      version: asset.version || ''
    };
    ollamaLastProgress = payload;
    send(payload);
  };

  const r = await ollamaDl.download({
    dest,
    sources,
    httpGet,
    onProgress: paint,
    onLog: m => logLine('[ollama] ' + m),
    isCancelled: () => ollamaCancel
  });
  if(r.cancelled || ollamaCancel) throw Object.assign(new Error('已取消下载'), { cancelled: true });
  return { dest, info: r };
}
function netmod_electron(){
  // 延迟取 net：app ready 之前 require('electron').net 不可用
  const { net } = require('electron');
  return net;
}
function runSetupSilently(setupExe){
  return new Promise((resolve, reject) => {
    const child = spawn(setupExe, ['/S'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try{ child.kill(); }catch(e){} reject(new Error('安装超时（10 分钟）')); }, 600000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if(code === 0) resolve();
      else reject(new Error('安装程序退出码 ' + code));
    });
  });
}
function launchOllama(){
  const { exe } = ollamaPaths();
  if(!exe || !fs.existsSync(exe)) return false;
  try{
    /* 这里绝对不能用 detached:true —— 那是「初次 AI 对话弹出几个一闪而过的黑窗口」
     * 的真正源头，实测（三种独立测量方式互相印证）：
     *
     *   detached:true  → 3 个 Windows Terminal 窗口
     *   detached:false → 0 个
     *
     * 机制（Windows 11 的「默认终端委托」）：
     *   detached:true 会给子进程加 DETACHED_PROCESS —— 它**不分配控制台**。
     *   Ollama 自己没有 console，于是它派生孙进程时（GPU 探测：
     *   `llama-server --list-devices` 与 `ollama gpu-discover`，正好 3 处，
     *   对应上游 ollama/ollama#18954）孙进程无处继承 console，
     *   Windows 只能新分配一个 —— 而 Windows 11 会把新 console 交给
     *   「默认终端应用」（用户机器上是 Windows Terminal），于是弹出一个
     *   深色终端窗口，进程一结束窗口就消失 = 用户看到的「一闪而过」。
     *
     *   不 detached 时，Ollama 继承 Electron 主进程那个「看不见的 console」
     *   （Electron 是 GUI 子系统，但主进程仍持有一个未显示的 console），
     *   孙进程继承它即可，全程零窗口。
     *
     * windowsHide 在这里**完全无关**（给与不给都是 0 个窗口）——真正的开关是 detached。
     *
     * 去掉 detached 不会改变生命周期：Windows 上父进程退出**不会**带走子进程
     *（没有 job object 那套机制），真正的「客户端关了 Ollama 也别跟着死」靠的是
     * `child.unref()`（解除 Node 事件循环的引用）+ `stdio:'ignore'`（不留管道）。
     * 这两行原本就有，去掉 detached 后它们照常生效。 */
    const child = spawn(exe, ['serve'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  }catch(e){
    return false;
  }
}
function waitOllamaUp(timeoutMs){
  return new Promise(resolve => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = netmod.connect({ port: 11434, host: '127.0.0.1' });
      let done = false;
      const ok = () => { if(!done){ done = true; try{ sock.destroy(); }catch(e){} resolve(true); } };
      const fail = () => {
        if(done) return;
        done = true;
        try{ sock.destroy(); }catch(e){}
        if(Date.now() - start < timeoutMs) setTimeout(tryConnect, 1000);
        else resolve(false);
      };
      sock.once('connect', ok);
      sock.once('error', fail);
      sock.once('timeout', fail);
      sock.setTimeout(1500);
    };
    tryConnect();
  });
}

/* ---------- 本地引擎自动启动 ----------
 * 「打开软件就能直接聊 / 直接画」的前提是引擎已经在了。以前两头都靠用户去点：
 * Ollama 要点「启动引擎」，ComfyUI 要点「启动引擎」并干等 106 秒。
 *
 * 约束（改之前先读）：
 *   ① **绝不阻塞窗口**：窗口先出来，1.2 秒后再起引擎。spawn 会和首屏动画抢磁盘与主线程，
 *      而首帧是用户唯一能直接感觉到「卡」的地方。
 *   ② **没装过就不装**：ComfyUI 未安装时只记 absent，绝不自动下 2 GB（那是安装按钮的事）。
 *   ③ **失败只降级**：自动启动失败要静默（写 boot.log + 界面提示），不能弹错误框。
 *   ④ 真正的决策逻辑在 engine-autostart.js，这里只做依赖注入。
 */
let engineRunner = null;
function engineCfgFile(){ return engineAuto.configFile(app.getPath('userData')); }
function comfyCfgFile(){ return path.join(app.getPath('userData'), 'comfy.json'); }

function ensureEngineRunner(){
  if(engineRunner) return engineRunner;
  engineRunner = engineAuto.createRunner({
    userData: () => app.getPath('userData'),
    // Ollama：装没装 / 起没起 / 起 / 等
    ollamaInstalled,
    ollamaUp: () => waitOllamaUp(1500),
    ollamaLaunch: launchOllama,
    ollamaWait: ms => waitOllamaUp(ms),
    ollamaTimeoutMs: 30000,
    // ComfyUI：探测与启动都走 comfy-setup，配置文件和「本地生图」App 是同一个
    comfyDetect: () => comfySetup.detect(comfyCfgFile()),
    comfyLaunch: () => comfySetup.launch(comfyCfgFile(), {}),
    emit: st => {
      try{ if(mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('engines:status', st); }
      catch(e){}
    },
    log: m => logLine('[engine] ' + m)
  });
  return engineRunner;
}

/* 触发一次自动启动。重复调用安全（runner 内部幂等），
 * 所以「开机」「用户在设置里勾上开关」「界面上点重试」可以共用这一个入口。 */
function autoStartEngines(reason){
  let r;
  try{ r = ensureEngineRunner(); }
  catch(e){ logLine('[engine] 初始化失败：' + ((e && e.message) || e)); return null; }
  return r.run({ reason: reason || 'boot' });
}

/* ---------- 本地模型驻留保活 ----------
 * 黑窗口的触发条件是「冷加载」（Ollama 派生 GPU 探测子进程去要一个新 console，
 * 触发 Windows 11 的默认终端委托 → 弹出 Windows Terminal 深色窗口）。
 * 实测：模型驻留后热请求 = 0 个窗口，冷加载 = 6 个。
 * 所以「让模型一直驻留」就是治本：驻留 → 提问走热请求 → 永不冷加载 → 永不弹窗。
 *
 * 为什么不用 keep_alive:-1：那样模型永不掉显存（qwen3-vl:8b 实测 6.2 GB），
 * 关了软件也还占着，用户会认为「偷我显存」。这里用「短 TTL + 周期续期」：
 * 软件开着就常驻，软件关掉最多 30 分钟后 Ollama 自己卸载。
 *
 * 真正的逻辑在 engine-keepalive.js（纯逻辑，node 可直测）。
 */
let engineKeeper = null;
function ensureEngineKeeper(){
  if(engineKeeper) return engineKeeper;
  engineKeeper = engineKeepalive.createKeeper({
    ping: (model, keepAlive) => ollamaPing(model, keepAlive),
    unload: model => ollamaUnload(model),
    resident: async model => {
      const r = await ollamaPs();
      if(!r.ok) return false;
      const want = String(model || '').trim();
      return r.models.some(m => m.name === want || m.name === want + ':latest');
    },
    log: m => logLine('[engine] ' + m)
  });
  return engineKeeper;
}

/* 续期用的「空 prompt」请求：Ollama 会把它当成一次使用，把 keep_alive 的
 * 到期时间往后推（实测推后 20 秒整，耗时 26ms），而不会真的生成 token。
 * 模型已驻留时这个请求不会触发 GPU 探测——实测 0 个新窗口。 */
async function ollamaPing(model, keepAlive){
  const m = String(model || '').trim();
  if(!m) return { ok: false, message: '没有指定模型' };
  const t0 = Date.now();
  try{
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: m,
        prompt: '',
        keep_alive: String(keepAlive || '30m'),
        stream: false,
        options: { num_predict: 0 }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    if(!res.ok) return { ok: false, message: 'HTTP ' + res.status };
    return { ok: true, model: m, ms: Date.now() - t0 };
  }catch(e){
    return { ok: false, model: m, message: String((e && e.message) || e) };
  }
}

/* 卸载模型（keep_alive:0）——换模型时卸掉旧的，防止两个模型同时占显存。 */
async function ollamaUnload(model){
  const m = String(model || '').trim();
  if(!m) return { ok: false };
  try{
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m, prompt: '', keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(10000)
    });
    await res.text();
    return { ok: res.ok };
  }catch(e){
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/* 查「现在哪些模型在显存里」（Ollama 的 /api/ps）。
 * 为什么要查：发送前的兜底不能无脑预热——
 * 预热一个**没驻留**的模型 = 一次冷加载 = 一次 GPU 探测 = 又闪一次黑窗口；
 * 而模型已经驻留时，只需要续一下期（实测 26ms、0 个新窗口）就够了。
 * 问一句「在不在」比盲目预热便宜得多，也干净得多。 */
async function ollamaPs(){
  try{
    const res = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) });
    if(!res.ok) return { ok: false, models: [] };
    const d = await res.json();
    const list = (d && Array.isArray(d.models)) ? d.models : [];
    return {
      ok: true,
      models: list.map(m => ({
        name: String(m.name || ''),
        size: Number(m.size) || 0,
        expiresAt: m.expires_at || ''
      }))
    };
  }catch(e){
    return { ok: false, models: [], message: String((e && e.message) || e) };
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm'
};

/* ---------- 路径 ---------- */
function pluginsDir(){
  return app.isPackaged ? path.join(process.resourcesPath, 'bridge', 'plugins') : path.join(REPO_ROOT, 'plugins');
}
function readManifest(){
  // 中央注册表：plugins/manifest.json 是外接功能的唯一事实来源
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginsDir(), 'manifest.json'), 'utf8'));
  } catch(e){
    logLine('[manifest] 读取失败：' + ((e && e.message) || e));
    return { plugins: {} };
  }
}
function bundledContentRoot(){
  // 打包后前端在 asar 里（files 白名单控制了范围），开发时就是仓库根目录
  return app.isPackaged ? app.getAppPath() : REPO_ROOT;
}
function contentBaseDir(){
  return path.join(app.getPath('userData'), 'content');
}
function readUpdateConfig(){
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update.json'), 'utf8'));
  } catch(e){
    return {};
  }
}

/* ---------- 端口 ---------- */
function isFree(port){
  return new Promise(resolve => {
    const srv = netmod.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort(start, span, avoid){
  for(let p = start; p < start + (span || 20); p++){
    if(avoid && avoid.has(p)) continue;
    if(await isFree(p)){
      if(avoid) avoid.add(p);
      return p;
    }
  }
  throw new Error('找不到可用端口（' + start + ' 起 ' + (span || 20) + ' 个都被占用）');
}

/* ---------- 服务 ---------- */
function startService(name, script, env, cwd, args){
  const proc = utilityProcess.fork(script, args || [], {
    env: Object.assign({}, process.env, env),
    cwd,
    serviceName: name,
    stdio: 'pipe'
  });
  if(proc.stdout) proc.stdout.on('data', d => safeOut('[' + name + '] ' + String(d)));
  if(proc.stderr) proc.stderr.on('data', d => safeOut('[' + name + '] ' + String(d)));
  proc.on('exit', code => logLine('[' + name + '] 已退出，code=' + code));
  return proc;
}

// 子进程日志转发：双击场景 stdout 可能无管道，写入失败一次后进入静默态
function safeOut(text){
  try { if(bootLogFile) fs.appendFileSync(bootLogFile, text); } catch(e){}
  writeOut(text);
}

function startServices(){
  const dir = pluginsDir();
  const userData = app.getPath('userData');
  const manifest = readManifest();

  // 插件服务：声明式 fork —— 新插件只要在 manifest.json 里注册就会自动拉起
  for(const [id, cfg] of Object.entries(manifest.plugins || {})){
    const env = Object.assign({}, cfg.env || {}, { PORT: String(pluginPorts[id]) });
    for(const [k, v] of Object.entries(cfg.userDataEnv || {})){
      env[k] = path.join(userData, v);
    }
    try {
      serviceProcs[id] = startService(id, path.join(dir, id, cfg.entry), env, dir, cfg.args || []);
    } catch(e){
      logLine('[service] ' + id + ' 启动失败：' + ((e && e.message) || e));
    }
  }

  // 交流社区（server/chat.js）：数据落 userData，和网关共用一个 data 目录
  const chatScript = app.isPackaged
    ? path.join(process.resourcesPath, 'bridge', 'chat.js')
    : path.join(REPO_ROOT, 'server', 'chat.js');
  chatProc = startService('chat', chatScript, {
    CHAT_PORT: String(chatPort),
    GATEWAY_DATA: userData,
    CHAT_ADMIN_KEY: (readUpdateConfig().chatAdminKey || '')
  }, dir);
}

function stopServices(){
  for(const p of Object.values(serviceProcs)){
    try { if(p) p.kill(); } catch(e){}
  }
  serviceProcs = {};
  try { if(chatProc) chatProc.kill(); } catch(e){}
  chatProc = null;
  // ComfyUI 是 spawn 出来的 python 进程，不主动收会留在后台占显存
  try { comfySetup.stop(); } catch(e){}
}

/* ---------- app:// 协议 ---------- */
function serveContent(req){
  let rel = '/index.html';
  try {
    const u = new URL(req.url);
    rel = decodeURIComponent(u.pathname || '/');
  } catch(e){}
  if(rel === '/' || rel === '') rel = '/index.html';

  const rootAbs = path.normalize(contentRoot);
  const abs = path.normalize(path.join(rootAbs, rel));
  if(abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)){
    return new Response('forbidden', { status: 403 });
  }
  return fsp.readFile(abs).then(buf => new Response(buf, {
    headers: {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    }
  })).catch(() => new Response('not found: ' + rel, { status: 404 }));
}

/* ---------- 窗口 ---------- */
async function createWindow(){
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0b0e',
    show: false,
    title: 'The seed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  const qs = new URLSearchParams({
    relay: 'http://127.0.0.1:' + (pluginPorts.relay || 8787),
    tripo: 'http://127.0.0.1:' + (pluginPorts.tripo || 8790),
    chat: 'http://127.0.0.1:' + chatPort,
    runtime: 'http://127.0.0.1:' + (pluginPorts.runtime || 8794)
  }).toString();

  win.once('ready-to-show', () => {
    win.show();
    // 冒烟模式：只验证「能起来、能加载、服务在跑」然后自动退出（CI / 无头验证用）
    if(process.env.OPENAGI_SMOKE){
      setTimeout(async () => {
        try {
          const alive = await isFree(pluginPorts.relay || 8787) === false;
          logLine('[smoke] window=ok relay=' + (alive ? 'up' : 'down') + ' content=' + contentVersion);
        } catch(e){}
        app.quit();
      }, 1200);
    }
  });
  // 兜底显示：渲染进程若卡住（ready-to-show 不触发），窗口也不能永远隐藏——3 秒后强制弹出
  const showFallback = setTimeout(() => {
    if(!win.isDestroyed() && !win.isVisible()) {
      logLine('[window] ready-to-show 超时，强制显示窗口');
      win.show();
    }
  }, 3000);
  win.on('closed', () => { clearTimeout(showFallback); mainWin = null; });
  await win.loadURL(CONTENT_ORIGIN + '/index.html?' + qs);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logLine('[window] 加载失败 ' + code + ' ' + desc + ' ' + url);
    // 加载失败也要把窗口弹出来（显示错误页而非"没反应"），方便排查
    if(!win.isDestroyed() && !win.isVisible()) win.show();
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if(level >= 2) logLine('[renderer] ' + message + ' @' + (source || '') + ':' + line);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if(/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if(url.indexOf(CONTENT_ORIGIN + '/') !== 0) e.preventDefault();
  });
  return win;
}

function buildMenu(){
  const isDev = !app.isPackaged;
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(app.getPath('userData'))
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 内容热更新 ---------- */
async function maybeUpdateContent(){
  const cfg = readUpdateConfig();
  const manifestUrl = process.env.OPENAGI_CONTENT_URL || cfg.manifestUrl;
  if(!manifestUrl) return;                       // 没配内容源就静默跳过（开发期常态）
  const r = await content.check({
    baseDir: contentBaseDir(),
    bundledRoot: bundledContentRoot(),
    manifestUrl,
    publicKey: process.env.OPENAGI_CONTENT_PUBKEY || cfg.publicKey,
    appVersion: app.getVersion(),
    onProgress: info => {
      if(mainWin) mainWin.webContents.send('content:progress', info);
    }
  });
  if(!r.ok){
    logLine('[content] 跳过：' + r.reason);
    return;
  }
  if(!r.updated){
    logLine('[content] 已是最新（' + r.version + '）');
    return;
  }
  logLine('[content] 已更新到 ' + r.version + '（上一版 ' + r.previous + '）');
  if(mainWin) mainWin.webContents.send('content:updated', { version: r.version });
  // 自动重载：前端有 350ms 的落盘防抖，留 1.5s 让编辑中的流程存下来
  if(process.env.OPENAGI_CONTENT_AUTORELOAD !== '0' && mainWin){
    setTimeout(() => {
      contentRoot = r.root;
      contentVersion = r.version;
      try { mainWin.reload(); } catch(e){}
    }, 1500);
  } else {
    contentRoot = r.root;   // 下次启动生效
    contentVersion = r.version;
  }
}

/* ---------- 启动 ---------- */
const gotLock = app.requestSingleInstanceLock();
if(!gotLock){
  app.quit();
} else {
  app.on('second-instance', () => {
    if(mainWin){
      if(mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  process.on('unhandledRejection', e => logLine('[fatal] 未处理的 Promise 拒绝：', String((e && e.stack) || e)));
  process.on('uncaughtException', e => logLine('[fatal] 未捕获异常：', String((e && e.stack) || e)));

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.openagi.desktop');
    try {
      bootLogFile = path.join(app.getPath('userData'), 'boot.log');
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(bootLogFile, '');
      logLine('启动 v' + app.getVersion() + ' packaged=' + app.isPackaged + ' electron=' + process.versions.electron);
    } catch(e){}

    try {
    // 1) 先选内容根（current → previous → 内置）
    try {
      const chosen = await content.resolveRoot({
        baseDir: contentBaseDir(),
        bundledRoot: bundledContentRoot()
      });
      contentRoot = chosen.root;
      contentVersion = chosen.version;
      logLine('[content] 版本 ' + chosen.version + ' → ' + chosen.root);
      if(chosen.degraded) logLine('[warn] [content] 当前版本目录校验失败，已回退到 ' + chosen.version);
      else logLine('[content] 使用内容版本 ' + chosen.version);
    } catch(e){
      logLine('[warn] [content] 内容根解析失败，使用内置版本：' + ((e && e.message) || e));
      contentRoot = bundledContentRoot();
    }

    protocol.handle('app', req => {
      const res = serveContent(req);
      res.then(r => { if(r.status >= 400) logLine('[app] ' + r.status + ' ' + req.url); }).catch(e => logLine('[app] 读取失败 ' + req.url + ' ' + e.message));
      return res;
    });

    /* 媒体库落点：开发态放仓库下 media/（直接看文件方便），打包后放 userData/media/。 */
    const mediaRoot = app.isPackaged
      ? path.join(app.getPath('userData'), 'media')
      : path.join(REPO_ROOT, 'media');
    MEDIA = mediaStoreMod.createMediaStore(mediaRoot, { dl: ollamaDl });

    /* 媒体协议：openagi-media://media/<encodeURIComponent(相对路径)>
     *
     * 必须自己实现 Range —— <video> 拖动进度条时会发 `Range: bytes=x-`，
     * 不认这个头就只能从头播到尾，用户一拖就回到 0 秒。Chromium 对不带
     * Accept-Ranges 的响应就是这么处理的（而且不报错，只表现为「拖不动」）。
     */
    protocol.handle('openagi-media', async req => {
      try{
        const u = new URL(req.url);
        const id = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
        const info = await MEDIA.open(id);
        const rangeHeader = req.headers.get('range');
        let start = 0;
        let end = info.size - 1;
        let status = 200;
        if(rangeHeader){
          const m = /bytes=(\d*)-(\d*)/i.exec(rangeHeader);
          if(m){
            if(m[1] === '' && m[2] !== ''){
              // bytes=-500 这种后缀写法：要最后 500 字节
              const tail = parseInt(m[2], 10);
              start = Math.max(0, info.size - (isFinite(tail) ? tail : 0));
            }else{
              start = parseInt(m[1], 10) || 0;
              if(m[2] !== '') end = Math.min(parseInt(m[2], 10), info.size - 1);
            }
            if(!isFinite(start) || !isFinite(end) || start > end || start >= info.size){
              return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + info.size } });
            }
            status = 206;
          }
        }
        const len = end - start + 1;
        const headers = {
          'content-type': info.mime,
          'content-length': String(len),
          'accept-ranges': 'bytes',
          // 本地文件随时可被用户改/删，缓存住会播到旧内容
          'cache-control': 'no-store'
        };
        if(status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + info.size;
        if(req.method === 'HEAD') return new Response(null, { status, headers });
        const stream = fs.createReadStream(info.abs, { start, end });
        stream.on('error', e => logLine('[media] 读取出错 ' + id + '：' + ((e && e.message) || e)));
        /* Node 流要转成 Web 流才能塞进 Response；转不了就退化成整块 Buffer
         * （只对小文件安全，大文件宁可报错也不要把内存吃满）。 */
        if(typeof ReadableStream !== 'undefined' && typeof require('stream').Readable.toWeb === 'function'){
          return new Response(require('stream').Readable.toWeb(stream), { status, headers });
        }
        if(info.size > 64 * 1048576) throw new Error('当前运行时不支持流式读取，文件过大');
        const buf = await fsp.readFile(info.abs);
        return new Response(buf.slice(start, end + 1), { status, headers });
      }catch(e){
        const msg = String((e && e.message) || e);
        logLine('[media] ' + msg + ' ← ' + req.url);
        return new Response('找不到媒体文件：' + msg, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    });

    // 2) 端口（被占用就顺延，然后通过 ?relay= / ?tripo= 告诉前端）
    //    四个服务互斥分配：即使外部残留进程占了中间端口，也不会出现两个服务撞同一端口
    try {
      const usedPorts = new Set();
      const manifest = readManifest();
      chatPort = await pickPort(8792, 20, usedPorts);
      for(const [id, cfg] of Object.entries(manifest.plugins || {})){
        pluginPorts[id] = await pickPort(cfg.port || 8787, 20, usedPorts);
        if(pluginPorts[id] !== cfg.port) logLine('[warn] [port] ' + id + ' 默认 ' + cfg.port + ' 被占用，改用 ' + pluginPorts[id]);
      }
    } catch(e){
      logLine('[error] [port] ' + ((e && e.message) || e));
    }

    // 3) 服务 + 菜单 + 窗口
    const portLog = Object.entries(pluginPorts).map(([id, p]) => id + '=' + p).join(' ');
    logLine('[port] ' + portLog + (portLog ? ' ' : '') + 'chat=' + chatPort);
    startServices();
    buildMenu();
    mainWin = await createWindow();
    logLine('[window] 已创建并加载 ' + CONTENT_ORIGIN);

    // 4) 后台检查内容更新（不阻塞首屏）
    setTimeout(() => { maybeUpdateContent().catch(e => logLine('[content] ' + e.message)); }, 5000);

    // 5) 本地引擎自动启动（Ollama / ComfyUI）
    //    延迟到首帧之后：spawn Python 会造成几十毫秒的磁盘抖动，而开机动画正好在那一段。
    //    fire-and-forget —— 引擎起不来也不能影响窗口，失败只进 boot.log 和界面提示。
    setTimeout(() => {
      const p = autoStartEngines('boot');
      if(p && typeof p.catch === 'function') p.catch(e => logLine('[engine] ' + ((e && e.message) || e)));
    }, 1200);
    } catch(e){
      logLine('[fatal] 启动失败：' + ((e && e.stack) || e));
      throw e;
    }
  });

  app.on('window-all-closed', () => {
    stopServices();
    if(process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    // 保活器必须停：退出后不该再续期，
    // 模型就按 keep_alive 的 TTL 自己卸载（最多再过 30 分钟）。
    try{ if(engineKeeper) engineKeeper.stop(); }catch(e){}
    stopServices();
  });
  app.on('activate', async () => {
    if(BrowserWindow.getAllWindows().length === 0) mainWin = await createWindow();
  });

  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    content: contentVersion,
    relay: pluginPorts.relay || 8787,
    tripo: pluginPorts.tripo || 8790,
    runtime: pluginPorts.runtime || 8794
  }));

  ipcMain.handle('ollama:detect', () => ollamaInstalled());

  /* 真实硬件信息：显卡 / 显存 / 内存。
   *
   * 为什么不能只用渲染进程的 navigator.gpu：
   * ① Chromium 默认把 WebGL/WebGPU 分配给**核显**（省电策略），双显卡笔记本上
   *    拿到的永远是 Intel/AMD 核显，独显完全看不见；
   * ② Windows 上 adapter.info.description / device 是**空字符串**，
   *    渲染进程既不知道型号也猜不出显存，最后只能落到「无独立 GPU」。
   * app.getGPUInfo('complete') 能列出全部适配器（含独显），再用
   * Win32_VideoController 补上型号与显存，两者都拿不到才交回渲染进程兜底。
   */
  ipcMain.handle('hw:probe', async () => probeHardwareMain());

  // 引擎是否正在下载（避免前端刷新后拿不到进度、以为卡死）
  ipcMain.handle('ollama:status', () => ({
    installing: ollamaInstalling,
    progress: ollamaLastProgress
  }));

  // 取消下载：只置标志，下载循环在下一个分片边界退出并保留续传侧车
  ipcMain.handle('ollama:cancel-install', () => {
    if(!ollamaInstalling) return { ok: false, message: '当前没有进行中的安装' };
    ollamaCancel = true;
    logLine('[ollama] 用户取消安装');
    return { ok: true, message: '正在取消…' };
  });

  ipcMain.handle('ollama:launch', async () => {
    if(!ollamaInstalled().installed) return { ok: false, message: '未安装 Ollama 引擎' };
    launchOllama();
    const ready = await waitOllamaUp(30000);
    logLine('[ollama] launch ' + (ready ? 'ok' : 'timeout'));
    return { ok: ready, message: ready ? '引擎已启动' : '启动超时（可稍后手动启动）' };
  });

  ipcMain.handle('ollama:install', async event => {
    if(process.platform !== 'win32') throw new Error('当前平台不支持自动安装');
    if(ollamaInstalled().installed) return { ok: true, installed: true, message: '已安装' };
    if(ollamaInstalling) throw new Error('安装进行中，请稍候');
    ollamaInstalling = true;
    ollamaCancel = false;
    const send = info => { try{ event.sender.send('ollama:progress', info); }catch(e){} };
    try{
      send({ stage: 'download', pct: 0, percent: 0, message: '正在查找最新安装包…' });
      const asset = await resolveOllamaAsset();
      logLine('[ollama] 安装包 ' + (asset.version || 'latest') + ' ' +
        (asset.size ? Math.round(asset.size / 1048576) + ' MB' : '大小未知') + ' ← ' + asset.url);

      const got = await fetchOllamaSetup(send, asset);
      // 官方 digest 只在 API 拿得到；分片下载已经做过长度与 PE 头校验，
      // 这里再对一次 sha256，防止镜像站在传输中改包
      if(asset.digest && /^sha256:/i.test(asset.digest)){
        send({ stage: 'verify', pct: 50, message: '正在校验安装包完整性…' });
        const want = asset.digest.slice(7).toLowerCase();
        const gotHash = await hashFile(got.dest);
        if(gotHash !== want){
          try{ fs.unlinkSync(got.dest); }catch(e){}
          try{ fs.unlinkSync(got.dest + '.part.json'); }catch(e){}
          throw new Error('安装包校验失败（下载内容与官方不一致，可能被中间节点篡改或截断），已删除，请重试');
        }
        logLine('[ollama] sha256 校验通过');
      }

      send({ stage: 'install', pct: 55, message: '正在静默安装 Ollama（约 1-3 分钟）…' });
      await runSetupSilently(got.dest);
      send({ stage: 'install', pct: 85, message: '安装完成，正在启动引擎…' });
      launchOllama();
      const ready = await waitOllamaUp(40000);
      try{ fs.unlinkSync(got.dest); }catch(e){}
      if(!ready) throw new Error('Ollama 安装完成但引擎未就绪，请稍后在控制台点击「启动引擎」');
      send({ stage: 'done', pct: 100, message: 'Ollama 引擎就绪' });
      logLine('[ollama] install ok');
      ollamaLastProgress = null;
      return { ok: true, installed: true, message: 'Ollama 引擎就绪' };
    }catch(e){
      const msg = String((e && e.message) || e);
      const aborted = !!(e && e.cancelled) || ollamaCancel;
      /* 可续传的中断（网络整体停滞、部分块始终下不下来）不该被当成「安装失败」：
       * 已下好的块都在侧车里，再点一次安装会从断点继续。这里回一个带 resumable 的结果，
       * 前端显示成「下载中断，进度已保留」而不是弹一个红色的操作失败。 */
      const resumable = !aborted && !!(e && e.resumable);
      send({ stage: aborted ? 'cancelled' : 'error', message: aborted ? '已取消下载（再次安装会续传）' : msg });
      logLine('[ollama] install ' + (aborted ? 'cancelled' : resumable ? 'interrupted: ' + msg : 'error: ' + msg));
      if(aborted) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };
      if(resumable) return { ok: false, resumable: true, message: msg };
      throw e;
    }finally{
      ollamaInstalling = false;
      ollamaCancel = false;
    }
  });

  /* ---- ComfyUI 本地生图环境 ----
   * 与 Ollama 同套路：探测 → 启动 → 安装。区别在于 ComfyUI 是「自带 Python 的目录」，
   * 所以状态里要带目录与装法（portable/venv/system），否则用户根本不知道该点哪里。 */
  const comfyCfg = comfyCfgFile;

  ipcMain.handle('comfy:detect', async () => {
    try{ return await comfySetup.detect(comfyCfg()); }
    catch(e){ return { ok: false, running: false, installed: false, message: String((e && e.message) || e) }; }
  });

  ipcMain.handle('comfy:launch', async (event, opts) => {
    try{
      const r = await comfySetup.launch(comfyCfg(), opts || {});
      logLine('[comfy] launch ' + (r.ok ? 'ok' : 'fail') + ' ' + (r.dir || ''));
      return r;
    }catch(e){
      const msg = String((e && e.message) || e);
      logLine('[comfy] launch error: ' + msg);
      return { ok: false, message: msg, log: comfySetup.logTail(20) };
    }
  });

  ipcMain.handle('comfy:stop', () => comfySetup.stop());

  /* ---- 重启单个插件服务 ----
   * 场景：改了 plugins/<id>/xxx.js 却还在跑旧进程（典型症状是桥吞参数、接口行为对不上，
   * 用户以为「改完了还是坏的」）。插件是 utilityProcess.fork 出来的，只能整只换掉。
   * 端口必须原地不变：渲染层的地址是开窗时写进 URL 的，换端口等于把页面指到一个死地址。 */
  ipcMain.handle('service:restart', async (event, id) => {
    const key = String(id || '');
    const proc = serviceProcs[key];
    const cfg = (readManifest().plugins || {})[key];
    if(!proc) return { ok: false, error: '服务没在运行：' + (key || '(空)') };
    if(!cfg) return { ok: false, error: 'manifest 里没有这个服务：' + key };
    const port = pluginPorts[key] || cfg.port;
    logLine('[service] 重启 ' + key + '（端口 ' + port + '）');
    try { proc.kill(); } catch(e){}
    delete serviceProcs[key];
    // 等端口真的空出来，否则重新 fork 会 EADDRINUSE —— 那会变成更难查的「服务没起来」
    let free = false;
    for(let i = 0; i < 20; i++){
      if(await isFree(port)){ free = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if(!free) return { ok: false, error: '旧进程没退出，端口 ' + port + ' 仍被占用（只能重启应用）', port };

    const dir = pluginsDir();
    const userData = app.getPath('userData');
    const env = Object.assign({}, cfg.env || {}, { PORT: String(port) });
    for(const [k, v] of Object.entries(cfg.userDataEnv || {})) env[k] = path.join(userData, v);
    try {
      serviceProcs[key] = startService(key, path.join(dir, key, cfg.entry), env, dir, cfg.args || []);
    } catch(e){
      const msg = String((e && e.message) || e);
      logLine('[service] ' + key + ' 重启失败：' + msg);
      return { ok: false, error: msg };
    }
    // runtime 只有几十毫秒就监听；给 5 秒，超时也把端口带回去让前端自己再试
    for(let i = 0; i < 25; i++){
      if(!(await isFree(port))) return { ok: true, port };
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: false, error: '重启后 5 秒内没有监听端口', port };
  });

  /* ---- 引擎自动启动：配置 / 状态 / 手动触发 / 预热 ----
   * 配置只有一个文件（userData/engines.json），默认 ollama 与 comfy 开、warm 关，
   * 理由写在 engine-autostart.js 顶部。 */
  ipcMain.handle('engines:config', () => engineAuto.readConfig(engineCfgFile()));

  ipcMain.handle('engines:set-config', (event, patch) => {
    const cfg = engineAuto.writeConfig(engineCfgFile(), patch || {});
    logLine('[engine] 配置 ' + JSON.stringify(cfg));
    return cfg;
  });

  ipcMain.handle('engines:status', () => ensureEngineRunner().status());

  // 手动再跑一次：界面上的「立即启动」和「勾上开关就现在启动」共用
  ipcMain.handle('engines:autostart', () => autoStartEngines('manual'));

  /* 预热语言模型：把权重提前读进显存，第一条消息就不用干等十几秒。
   * 走 Ollama 自己的 /api/generate —— prompt 留空只做加载，不产生任何 token。
   * 为什么不在主进程自己猜模型名：选中的模型存在渲染进程的 localStorage 里
   * （hf_desk_model = "oll:<模型名>"），主进程看不到，所以由前端点名调过来。
   *
   * keep_alive 给 30 分钟（不是 5 分钟）：5 分钟一过模型就退出显存，
   * 用户隔一会儿再提问 = 又一次冷加载 = 又干等四五秒，等于没预热。
   * 30 分钟覆盖绝大多数「打开软件 → 想事情 → 提问」的间隔。
   * 显存占用和 keep_alive 成正比，但模型本来就常驻在显存里（不卸载也不省），
   * 拉长只是把「卸载」推迟，不改变峰值占用。
   *
   * ⚠ 预热解决的是「第一条消息要等」和「黑窗口」——两件事，同一个原因。
   *   「黑窗口」是 Ollama 冷加载时派生 GPU 探测子进程造成的
   *   （见 launchOllama 的注释里的完整证据链）。
   *   预热把这一次冷加载从「用户提问那一刻」挪到「客户端启动那一刻」；
   *   再配合 keepalive 续期（下面 engines:keepalive），模型就一直驻留，
   *   提问时走热请求 → 不再冷加载 → **黑窗口彻底不再出现**。
   *
   * 预热成功后就把它登记进保活器：模型会一直留在显存里，
   * 直到客户端退出（最多再过一个 TTL，Ollama 自己卸载）。 */
  ipcMain.handle('engines:warm', async (event, req) => {
    const r = req || {};
    const model = String(r.model || '').trim();
    if(!model) return { ok: false, skipped: true, message: '没有指定模型' };
    if(!engineAuto.readConfig(engineCfgFile()).warm) return { ok: false, skipped: true, message: '未开启预热' };
    const up = await waitOllamaUp(1500);
    if(!up) return { ok: false, skipped: true, message: 'Ollama 还没就绪' };
    const t0 = Date.now();
    /* 模型已经在显存里了？——那就只续期，别再冷加载一次。
     * 冷加载 = 一次 GPU 探测 = 一次黑窗口（实测 6 个曾可见窗口）；
     * 续期 = 26ms、0 个窗口。这两件事的代价差着三个数量级，
     * 所以每次预热前都先问一句「在不在」。 */
    let inMem = false;
    try{
      const ps = await ollamaPs();
      inMem = ps.ok && ps.models.some(m => m.name === model || m.name === model + ':latest');
    }catch(e){ inMem = false; }
    if(inMem){
      const ping = await ollamaPing(model, String(r.keepAlive || '30m'));
      const ms = Date.now() - t0;
      if(ping.ok){
        logLine('[engine] warm ' + model + ' 已驻留，续期 ' + ms + 'ms');
        try{
          const keeper = ensureEngineKeeper();
          keeper.setModel(model);
          keeper.start();
        }catch(e){}
        return { ok: true, model, ms, resident: true };
      }
    }
    try{
      /* ⚠ 这里必须带 options.num_predict = 0，否则 Ollama 会真的去生成 token。
       *   带上了它才是一次「纯加载」：实测响应里 done_reason = "load"，
       *   模型进显存、不产出任何内容（实测 4.5 s）。
       *   不带的话会走完整推理（慢、且可能生成一堆没用的文本）。
       *   ——顺带一提，早期版本的预热没带这个参数，
       *   加上前端重复调度，就出现过「预热打了 9 次、模型始终没驻留」的现象：
       *   每次请求都重置 keep_alive，彼此把对方顶掉。 */
      const res = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '',
          keep_alive: String(r.keepAlive || '30m'),
          stream: false,
          options: { num_predict: 0 }
        }),
        signal: AbortSignal.timeout(Math.max(10000, Number(r.timeoutMs) || 180000))
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      if(!res.ok){
        logLine('[engine] warm ' + model + ' 失败 HTTP ' + res.status + ' ' + text.slice(0, 160));
        return { ok: false, model, ms, message: 'HTTP ' + res.status };
      }
      logLine('[engine] warm ' + model + ' ' + ms + 'ms');
      // 登记进保活器：之后每 10 分钟续一次期，模型就不会被 Ollama 卸载。
      // 换模型时保活器会自动把旧的卸掉（避免两个模型同时占显存）。
      try{
        const keeper = ensureEngineKeeper();
        keeper.setModel(model);
        keeper.start();
      }catch(e){ logLine('[engine] keepalive 启动失败：' + ((e && e.message) || e)); }
      return { ok: true, model, ms };
    }catch(e){
      const msg = String((e && e.message) || e);
      logLine('[engine] warm ' + model + ' 异常：' + msg);
      return { ok: false, model, message: msg };
    }
  });

  /* 保活状态（界面显示用）：当前保活着哪个模型、续期成功没有、下次续期什么时候。 */
  ipcMain.handle('engines:keepalive', () => {
    try{ return ensureEngineKeeper().status(); }
    catch(e){ return { model: '', running: false, fails: 0 }; }
  });

  /* 手动续期一次（界面上的「立即续期」，以及发送前兜底用）。
   * force=true 时无视「失败次数已达上限」的放弃状态，重新试一次——
   * 比如用户把引擎重新拉起来了，之前那些失败就不该算数了。 */
  ipcMain.handle('engines:keepalive-ping', async (event, req) => {
    const r = req || {};
    const model = String(r.model || '').trim();
    try{
      const keeper = ensureEngineKeeper();
      if(model) keeper.setModel(model);
      if(!keeper.model) return { ok: false, message: '没有指定模型' };
      if(r.force) keeper.start();
      const ok = await keeper.pingOnce(!!r.force);
      return { ok, model: keeper.model, status: keeper.status() };
    }catch(e){
      return { ok: false, message: String((e && e.message) || e) };
    }
  });

  /* 打开 ComfyUI 自带的网页界面。
   * 它本身就是个 Web UI（8188），用系统浏览器打开最省事：
   * 内嵌 BrowserWindow 会和主窗口抢 GPU、也没法用浏览器插件。 */
  ipcMain.handle('comfy:open-ui', async () => {
    try{
      const st = await comfySetup.detect(comfyCfg());
      if(!st.running){
        return { ok: false, message: 'ComfyUI 还没启动，先点「启动引擎」（首次启动要加载 torch，实测 106 秒）' };
      }
      await shell.openExternal(comfySetup.COMFY_BASE);
      return { ok: true, url: comfySetup.COMFY_BASE };
    }catch(e){
      return { ok: false, message: String((e && e.message) || e) };
    }
  });

  // 2 GB 下载没有取消入口会很折磨，尤其发现选错盘符的时候
  ipcMain.handle('comfy:cancel', () => {
    if(!comfyInstalling) return { ok: false, message: '当前没有正在进行的安装' };
    comfyCancel = true;
    return { ok: true };
  });

  /* ---- 资产库：图片 / 3D 模型落盘 ----
   * 开发态放仓库下 assets/（方便直接看文件、也方便连 assets 一起备份），
   * 打包后放 userData/assets/——安装目录通常不可写，更不可能写进 asar 里。 */
  const assetStoreMod = require('./asset-store');
  const assetRoot = app.isPackaged
    ? path.join(app.getPath('userData'), 'assets')
    : path.join(REPO_ROOT, 'assets');
  const ASSETS = assetStoreMod.createAssetStore(assetRoot);

  ipcMain.handle('asset:list', () => ASSETS.list());
  ipcMain.handle('asset:stat', () => ASSETS.stat());
  ipcMain.handle('asset:read', (e, id) => ASSETS.read(String(id || '')));
  ipcMain.handle('asset:remove', (e, ids) => ASSETS.remove(ids));
  ipcMain.handle('asset:reconcile', () => ASSETS.reconcile());
  ipcMain.handle('asset:empty-trash', () => ASSETS.emptyTrash());
  /* 3D 缩略图：主进程只负责存取 PNG，渲染在渲染进程做（WebGL 在那边）。
   * 分开的好处是同一个模型只渲染一次，之后每次打开图库都是读文件。 */
  ipcMain.handle('asset:thumb', (e, id) => ASSETS.readThumb(String(id || '')));
  ipcMain.handle('asset:thumb-save', (e, req) => {
    const r = req || {};
    return ASSETS.saveThumb(String(r.id || ''), r.dataURL);
  });

  ipcMain.handle('asset:put', async (e, req) => {
    const r = req || {};
    try{
      const a = await ASSETS.put({
        id: r.id ? String(r.id) : undefined,
        kind: r.kind,
        name: r.name,
        ext: r.ext,
        data: r.data,
        source: r.source || 'app',
        meta: r.meta
      });
      return { ok: true, asset: a };
    }catch(err){
      return { ok: false, message: String((err && err.message) || err) };
    }
  });

  /* 从磁盘导入：用户自己攒的图和 glb 也要能进库，
   * 只认程序生成的东西等于又造了一个封闭花园。 */
  ipcMain.handle('asset:import', async () => {
    const r = await dialog.showOpenDialog(mainWin || undefined, {
      title: '导入资产（图片 / 3D 模型）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '全部支持的格式', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', '3mf', 'usdz'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] },
        { name: '3D 模型', extensions: ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', '3mf', 'usdz'] }
      ]
    });
    if(r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    const isModel = ext => assetStoreMod.MODEL_EXT_RE.test(ext);
    const isImage = ext => /^(png|jpe?g|webp|gif|avif|svg)$/i.test(ext);
    const imported = [], failed = [];
    for(const fp of r.filePaths){
      try{
        const buf = await fsp.readFile(fp);
        const ext = path.extname(fp).slice(1).toLowerCase();
        const kind = isModel(ext) ? 'model' : (isImage(ext) ? 'image' : 'blob');
        imported.push(await ASSETS.put({ kind, ext, name: path.basename(fp), data: buf, source: 'import' }));
      }catch(err){
        failed.push({ file: path.basename(fp), error: String((err && err.message) || err) });
      }
    }
    return { ok: true, imported, failed };
  });

  ipcMain.handle('asset:export', async (e, ids) => {
    const r = await dialog.showOpenDialog(mainWin || undefined, {
      title: '导出到文件夹', properties: ['openDirectory', 'createDirectory']
    });
    if(r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    const res = await ASSETS.exportTo(ids, r.filePaths[0]);
    return { ok: true, dir: r.filePaths[0], files: res.files };
  });

  /* ---- 媒体库：播放器 App 的落点 ----
   * 界面只认 id（相对 mediaRoot 的路径），真实路径只有协议处理器知道。
   * 这样文件被用户在资源管理器里改名/搬走后，界面报「找不到」而不是拿一条死路径硬播。 */
  ipcMain.handle('media:list', () => MEDIA.list());
  ipcMain.handle('media:stat', () => MEDIA.stat());
  ipcMain.handle('media:remove', (e, ids) => MEDIA.remove(ids));
  ipcMain.handle('media:reveal', async (e, id) => {
    try{
      const abs = MEDIA.absOf(String(id || ''));
      shell.showItemInFolder(abs);
      return { ok: true };
    }catch(err){ return { ok: false, message: String((err && err.message) || err) }; }
  });
  ipcMain.handle('media:open-dir', async () => {
    try{
      await MEDIA.ensure();
      const r = await shell.openPath(MEDIA.root);
      return { ok: !r, dir: MEDIA.root, message: r || '' };
    }catch(err){ return { ok: false, message: String((err && err.message) || err) }; }
  });

  ipcMain.handle('media:import', async () => {
    const r = await dialog.showOpenDialog(mainWin || undefined, {
      title: '导入要播放的文件（视频 / 音频 / 字幕）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'ts', 'flv', 'wmv', 'mpg', 'ogv'] },
        { name: '音频', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'] },
        { name: '字幕', extensions: ['srt', 'vtt', 'ass'] },
        { name: '全部支持的格式', extensions: Object.keys(mediaStoreMod.VIDEO_MIME).concat(Object.keys(mediaStoreMod.AUDIO_MIME), ['srt', 'vtt', 'ass']) }
      ]
    });
    if(r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    /* 多选时按共同父目录算相对层级：选的是同一部番的若干集就直接平铺，
     * 跨目录多选就各自带上自己的层级，播完不会混成一锅。 */
    const dirs = r.filePaths.map(p => path.dirname(p));
    const sameDir = dirs.every(d => d === dirs[0]);
    const res = await MEDIA.importFiles(r.filePaths, sameDir ? { baseDir: dirs[0] } : {});
    return Object.assign({ ok: true }, res);
  });

  /* 导入整个文件夹（一部番一个文件夹是最常见的形态）。
   * 递归在渲染层做不了——渲染层拿不到任意路径，只能主进程扫。 */
  ipcMain.handle('media:import-dir', async () => {
    const r = await dialog.showOpenDialog(mainWin || undefined, {
      title: '选择作品文件夹（里面可以有子文件夹，按子文件夹分组成剧集）',
      properties: ['openDirectory']
    });
    if(r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    const base = r.filePaths[0];
    const found = [];
    const walk = async (dir, depth) => {
      if(depth > 5 || found.length >= mediaStoreMod.MAX_FILES) return;
      let ents = [];
      try{ ents = await fsp.readdir(dir, { withFileTypes: true }); }catch(e){ return; }
      for(const ent of ents){
        if(ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if(ent.isDirectory()){ await walk(full, depth + 1); continue; }
        if(ent.isFile() && mediaStoreMod.kindOf(ent.name)) found.push(full);
      }
    };
    await walk(base, 0);
    if(!found.length) return { ok: false, empty: true, message: '这个文件夹里没找到视频/音频/字幕文件' };
    const res = await MEDIA.importFiles(found, { baseDir: base });
    return Object.assign({ ok: true, dir: base, scanned: found.length }, res);
  });

  /* 从 URL 下载。进度用事件推回渲染层（同一套 ui 就能画进度条），
   * jobId 由渲染层生成，取消时按它找回任务。 */
  ipcMain.handle('media:download', async (event, req) => {
    const r = req || {};
    try{
      const res = await MEDIA.download(r, {
        onProgress: p => {
          try{ event.sender.send('media:progress', p); }catch(e){}
        },
        onLog: msg => logLine('[media-dl] ' + msg)
      });
      return res;
    }catch(err){
      return { ok: false, cancelled: !!(err && err.cancelled), message: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('media:cancel', (e, jobId) => MEDIA.cancel(jobId));

  // 让用户直接选目录：自动搜索再全也可能找不到（装在不常见的盘/自定义路径）
  ipcMain.handle('comfy:pick-dir', async () => {
    const r = await dialog.showOpenDialog(mainWin || undefined, {
      title: '选择 ComfyUI 所在文件夹（含 main.py 的那层，或 ComfyUI_windows_portable）',
      properties: ['openDirectory']
    });
    if(r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    const dir = r.filePaths[0];
    const layout = comfySetup.resolveLayout(dir);
    if(!layout) return { ok: false, message: '这个目录里没找到 main.py（选 ComfyUI 或 ComfyUI_windows_portable 那层）' };
    comfySetup.writeConfig(comfyCfg(), Object.assign(comfySetup.readConfig(comfyCfg()), { dir: layout.dir }));
    return { ok: true, dir: layout.dir, layout };
  });

  ipcMain.handle('comfy:install', async event => {
    if(process.platform !== 'win32') return { ok: false, message: '当前平台请用官方脚本安装 ComfyUI' };
    if(comfyInstalling) return { ok: false, message: '安装进行中，请稍候' };
    comfyInstalling = true;
    comfyCancel = false;
    const send = info => { try{ event.sender.send('comfy:progress', info); }catch(e){} };
    try{
      const r = await comfySetup.installPortable(comfyCfg(), {
        net: netmod_electron(),
        onProgress: send,
        isCancelled: () => comfyCancel
      });
      return r;
    }catch(e){
      const msg = String((e && e.message) || e);
      logLine('[comfy] install error: ' + msg);
      send({ stage: 'error', message: msg });
      return { ok: false, message: msg };
    }finally{
      comfyInstalling = false;
      comfyCancel = false;
    }
  });

  /* ---- 模型商店：把生图权重下载到 ComfyUI/models/checkpoints ----
   * 语言模型的拉取走渲染进程（Ollama 自己有 /api/pull 流式进度且带断点续传），
   * 这里只负责「浏览器下不动」的大文件：2-7 GB 的 .safetensors。 */
  ipcMain.handle('store:image-list', () => modelStore.list(comfyCfg()));

  ipcMain.handle('store:image-install', async (event, req) => {
    const r = req || {};
    const id = String(r.id || r.file || '');
    if(!id) return { ok: false, message: '缺少模型标识' };
    if(storeJobs.has(id)) return { ok: false, message: '这个模型正在下载中' };
    const job = { cancel: false };
    storeJobs.set(id, job);
    const send = info => {
      try{ event.sender.send('store:progress', Object.assign({ id }, info || {})); }catch(e){}
    };
    try{
      const want = Number(r.sizeGB) > 0 ? '（约 ' + r.sizeGB + ' GB）' : '';
      send({ stage: 'download', pct: 0, message: '正在测速选择最快的下载源…' });
      const res = await modelStore.install(comfyCfg(), r, {
        httpGet: ollamaDl.makeElectronHttpGet(netmod_electron()),
        isCancelled: () => job.cancel,
        onLog: m => logLine('[store] ' + m),
        onProgress: info => {
          if(!info) return;
          const mb = n => Math.round((Number(n) || 0) / 1048576);
          const parts = [];
          if(info.stage === 'probe') parts.push('正在测速选择最快的下载源…');
          else {
            parts.push('下载中 ' + mb(info.done) + ' / ' + mb(info.total) + ' MB');
            if(info.pct >= 0) parts.push(info.pct + '%');
            if(info.speed > 0) parts.push(ollamaDl.fmtSpeed(info.speed));
            if(info.etaMs >= 0) parts.push('剩余 ' + ollamaDl.fmtEta(info.etaMs));
          }
          send({
            stage: info.stage === 'done' ? 'done' : 'download',
            pct: info.stage === 'done' ? 100 : (info.pct >= 0 ? info.pct : 0),
            message: '下载 ' + (r.name || r.file) + want + ' · ' + parts.join(' · '),
            done: info.done, total: info.total,
            speed: info.speed || 0, etaMs: info.etaMs, source: info.source || ''
          });
        }
      });
      send({ stage: 'done', pct: 100, message: '下载完成，已放入 checkpoints' });
      logLine('[store] image ok ' + res.file);
      return { ok: true, file: res.file, cached: !!res.cached };
    }catch(e){
      const msg = String((e && e.message) || e);
      const cancelled = !!(e && e.cancelled) || job.cancel;
      send({ stage: cancelled ? 'cancelled' : 'error', message: cancelled ? '已取消下载（再次安装会续传）' : msg });
      logLine('[store] image ' + (cancelled ? 'cancelled' : 'error: ' + msg));
      if(cancelled) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };
      // 网络类中断带 resumable，前端显示成「进度已保留」而不是红色失败
      return { ok: false, resumable: !!(e && e.resumable), message: msg };
    }finally{
      storeJobs.delete(id);
    }
  });

  ipcMain.handle('store:cancel', (event, id) => {
    const job = storeJobs.get(String(id || ''));
    if(!job) return { ok: false, message: '没有进行中的下载' };
    job.cancel = true;
    return { ok: true };
  });

  ipcMain.handle('store:image-remove', async (event, file) => {
    try{
      const r = await modelStore.remove(comfyCfg(), file);
      logLine('[store] removed ' + r.file);
      return { ok: true, file: r.file };
    }catch(e){
      return { ok: false, message: String((e && e.message) || e) };
    }
  });
}

function hashFile(file){
  return new Promise((resolve, reject) => {
    const h = require('crypto').createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', c => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
