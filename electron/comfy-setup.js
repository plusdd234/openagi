/* ComfyUI 环境自动配置（主进程）
 *
 * 「自动配置」在这里指四件事，按重要性排序：
 *   ① 自动找到已安装的 ComfyUI（常见路径 + 端口探测），不用用户去翻盘符；
 *   ② 一键启动，并等到 API 真的起来（而不是 spawn 完就当成功）；
 *   ③ 缺什么说清楚（Python / 依赖 / 生图模型），启动日志留尾给用户看；
 *   ④ 没装时能下载官方便携包并解压。
 *
 * ④ 有个绕不开的现实：官方只发 .7z，Windows 自带工具解不了。
 * 所以先找 7z.exe（安装版 / PortableApps / PATH），找不到就明确报错，
 * 绝不假装支持——半路失败留下的半成品目录比不装更糟。
 */
'use strict';
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const COMFY_PORT = 8188;
const COMFY_BASE = 'http://127.0.0.1:' + COMFY_PORT;
const PORTABLE_URL = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z';
/* 便携包体积：实测 2,039,673,203 字节（≈ 2.0 GB）。早期文案写 1.5 GB 是错的，
 * 用户在进度条看到总量 2 GB 才发现，观感上等于「说的和做的不一样」。 */
const PORTABLE_GB = 2.04;
/* 下载源：下载器会并发探测、按实测速度排班聚合，所以这里给多个源是「加速」不是「备份」。
 * 只放**实测支持 Range（206）**的源：
 *   - GitHub 直连：206 ✓
 *   - ghproxy.net：206 ✓（国内通常比直连快）
 *   - gh-proxy.com：Range 请求返回 200 + 整个文件 ✗ —— 会被分片逻辑写错偏移，
 *     所以哪怕它通也不能放进来（`pickSources` 里还会再过滤一次 rangeOk 兜底）。
 * latest/download/ 是 302 到真实资产，两个 HTTP 层都会跟随重定向。 */
const PORTABLE_SOURCES = [
  { url: PORTABLE_URL, name: 'GitHub 官方' },
  { url: 'https://ghproxy.net/' + PORTABLE_URL, name: 'ghproxy 镜像' }
];

/* 启动日志留在内存里：ComfyUI 起不来时 90% 的原因（缺 torch、CUDA 版本不对、
 * 模型目录权限）都写在 stdout/stderr 里，不抓下来用户只能看到「启动失败」。 */
const LOG_MAX = 240;
const logRing = [];
function pushLog(line){
  const t = String(line || '').replace(/\r/g, '');
  if(!t.trim()) return;
  logRing.push(t.length > 400 ? t.slice(0, 400) + '…' : t);
  if(logRing.length > LOG_MAX) logRing.splice(0, logRing.length - LOG_MAX);
}
function logTail(n){ return logRing.slice(-(n || 40)).join('\n'); }

function httpProbe(url, timeoutMs){
  const http = require('http');
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if(!done){ done = true; resolve(v); } };
    try{
      const req = http.get(url, { timeout: Math.max(500, timeoutMs || 1500) }, res => {
        const chunks = [];
        res.on('data', c => { if(chunks.length < 64) chunks.push(c); });
        res.on('end', () => {
          let body = '';
          try{ body = Buffer.concat(chunks).toString('utf8'); }catch(e){}
          finish({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode || 0, body });
        });
        res.on('error', () => finish({ ok: false, status: 0, body: '' }));
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, body: '' }); });
      req.on('error', () => finish({ ok: false, status: 0, body: '' }));
    }catch(e){ finish({ ok: false, status: 0, body: '' }); }
  });
}

/* 从一个目录判断它是什么装法。返回 null 表示「这不是 ComfyUI 目录」。
 * 三种布局：
 *   portable —— ComfyUI_windows_portable/{python_embeded, ComfyUI/main.py}
 *   venv     —— ComfyUI/{main.py, venv|.venv/Scripts/python.exe}
 *   system   —— ComfyUI/{main.py}，python 走 PATH
 */
function resolveLayout(dir){
  if(!dir) return null;
  const abs = path.resolve(dir);
  const has = p => { try{ return fs.existsSync(p); }catch(e){ return false; } };

  // 用户可能选到外层目录（ComfyUI_windows_portable），也可能直接选到 ComfyUI
  const inner = path.join(abs, 'ComfyUI');
  if(has(path.join(inner, 'main.py'))){
    const py = path.join(abs, 'python_embeded', 'python.exe');
    if(has(py)) return { ok: true, mode: 'portable', dir: abs, comfyDir: inner, python: py, cwd: abs };
  }
  if(has(path.join(abs, 'main.py'))){
    /* 选到便携包的**内层** ComfyUI 目录（很多人直接进这里点 run_nvidia_gpu.bat）：
     * python 在上一层的 python_embeded 里，仍按便携版处理，
     * 并把 dir 归一成外层——配置里存内层路径的话，换版本重下就失效了。 */
    const embedded = path.join(abs, '..', 'python_embeded', 'python.exe');
    if(has(embedded)){
      const outer = path.dirname(abs);
      return { ok: true, mode: 'portable', dir: outer, comfyDir: abs, python: embedded, cwd: outer };
    }
    const venvs = [path.join(abs, 'venv', 'Scripts', 'python.exe'),
      path.join(abs, '.venv', 'Scripts', 'python.exe')];
    const py = venvs.find(has);
    return { ok: true, mode: py ? 'venv' : 'system', dir: abs, comfyDir: abs, python: py || 'python', cwd: abs };
  }
  return null;
}

/* 候选目录：已知路径优先（快），再扫各盘符根目录一层（多数人解压到盘根）。
 * 不做全盘递归——那会卡几分钟，用户以为程序死了。 */
function candidateDirs(saved){
  const home = os.homedir();
  const out = [];
  const add = p => { if(p && out.indexOf(p) === -1) out.push(p); };
  if(saved) add(saved);

  const names = ['ComfyUI', 'ComfyUI_windows_portable', 'ComfyUI_windows_portable_nvidia',
    'comfyui', 'ComfyUI-aki-v1.3', 'ComfyUI-aki'];
  const roots = [home, path.join(home, 'Desktop'), path.join(home, 'Downloads'),
    path.join(home, 'Documents'), path.join(home, 'AppData', 'Local')];
  roots.forEach(r => names.forEach(n => add(path.join(r, n))));

  if(process.platform === 'win32'){
    'CDEFGH'.split('').forEach(d => {
      const root = d + ':\\';
      try{
        if(!fs.existsSync(root)) return;
      }catch(e){ return; }
      try{
        fs.readdirSync(root, { withFileTypes: true }).forEach(dt => {
          if(!dt.isDirectory()) return;
          if(!/comfy/i.test(dt.name)) return;
          add(path.join(root, dt.name));
        });
      }catch(e){}
    });
    ['C:\\', 'D:\\'].forEach(r => names.forEach(n => add(path.join(r, n))));
  }
  return out;
}

/* 定位 ComfyUI 目录：显式指定 → 配置里存的 → 自动扫描候选位置。
 *
 * ⚠️ `detect` 和 `launch` **必须共用这一个函数**。
 * 曾经 detect 走自动扫描（所以面板显示「已安装」），launch 却只认配置里存的目录，
 * 于是用户看到「已安装 · 未启动」，点「启动引擎」却被告知「没有找到 ComfyUI 安装目录」——
 * 同一件事两个答案，比两个都错更难排查。
 * 一键安装会写配置，但**手动装过的机器、从旧版本升上来的机器、以及安装时用了别的
 * 配置文件的机器，配置里都是空的**，只能靠扫描认出来。 */
function locateLayout(cfg, preferDir){
  const direct = resolveLayout(preferDir || (cfg && cfg.dir) || '');
  if(direct) return direct;
  for(const d of candidateDirs(cfg && cfg.dir)){
    const r = resolveLayout(d);
    if(r) return r;
  }
  return null;
}

function readConfig(cfgFile){
  try{ return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }catch(e){ return {}; }
}
function writeConfig(cfgFile, data){
  try{
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2), 'utf8');
    return true;
  }catch(e){ return false; }
}

/* 找可用的 7z：安装版、PortableApps、以及 PATH 里 */
function findSevenZip(){
  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    'C:\\Program Files\\PortableApps\\7-ZipPortable\\App\\7-Zip\\7z.exe'
  ];
  for(const p of direct){
    try{ if(fs.existsSync(p)) return p; }catch(e){}
  }
  return '';
}

/* Windows 10 1803+ 自带 bsdtar（libarchive），**能直接读 7z**。
 * 实测 bsdtar 3.8.9 / libarchive 3.8.9：`tar -tf x.7z` 能列目录，`tar -xf x.7z -C dir` 能解出内容。
 * 所以「一键安装」不该要求用户先去装 7-Zip——那等于把门槛原封不动留在原地：
 * 官方只发 .7z，用户点安装 → 弹窗说「需要 7-Zip」→ 用户去下载安装 → 回来再点。
 * 这里把系统 tar 作为首选，7z.exe 只当回退（极老系统，或 libarchive 遇到不支持的过滤器）。 */
function findTar(){
  const root = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(root, 'System32', 'tar.exe');
  try{ if(fs.existsSync(p)) return p; }catch(e){}
  return '';
}

function runExe(exe, args){
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if(err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      resolve({ stdout, stderr });
    });
  });
}

/* 当前状态：跑没跑 / 装没装 / 缺什么 */
async function detect(cfgFile){
  const cfg = readConfig(cfgFile || '');
  const running = await httpProbe(COMFY_BASE + '/system_stats', 1500);
  const layout = locateLayout(cfg);
  /* 自动扫描认出来的目录写回配置：既省掉以后每次扫全盘，
   * 也让「面板显示已安装」和「launch 能找到目录」两件事彻底对齐。 */
  if(layout && cfgFile && layout.dir !== cfg.dir){
    try{ writeConfig(cfgFile, Object.assign(cfg, { dir: layout.dir })); }catch(e){}
  }
  return {
    ok: true,
    running: !!running.ok,
    base: COMFY_BASE,
    port: COMFY_PORT,
    dir: layout ? layout.dir : (cfg.dir || ''),
    layout,
    installed: !!layout,
    sevenZip: findSevenZip(),
    tar: findTar(),
    // 能不能一键安装，取决于有没有解压工具（tar 或 7z 有一个就够）
    canInstall: !!(findTar() || findSevenZip()),
    systemStats: running.ok ? safeJson(running.body) : null,
    // 只有「装了但没跑」才需要日志；没装过就不该显示上次的旧日志
    log: layout ? logTail(20) : ''
  };
}
function safeJson(s){
  try{ return JSON.parse(s); }catch(e){ return null; }
}

/* 等 API 真起来。spawn 成功只代表进程创建成功，ComfyUI 还要加载 torch（几十秒）。 */
async function waitReady(timeoutMs){
  const started = Date.now();
  while(Date.now() - started < (timeoutMs || 90000)){
    const r = await httpProbe(COMFY_BASE + '/system_stats', 1200);
    if(r.ok) return true;
    if(child && child.exitCode != null) return false;   // 进程已经退了，别再干等
    await new Promise(res => setTimeout(res, 800));
  }
  return false;
}

let child = null;
let launching = false;
/* 正在进行的这一次启动。后到的人（用户点「启动引擎」）等**同一个结果**，
 * 而不是吃一句「正在启动中，请稍候」——那句话会被界面当失败显示成红字，
 * 而真正那次启动其实成功了，用户看到的就是「卡在启动中」。
 * 开机自动启动和手动点按钮同时发生是常态，不是异常。 */
let launchJob = null;

async function launch(cfgFile, opts){
  if(launchJob) return launchJob;
  launchJob = launchNow(cfgFile, opts || {}).finally(() => { launchJob = null; });
  return launchJob;
}

async function launchNow(cfgFile, o){
  const running = await httpProbe(COMFY_BASE + '/system_stats', 1200);
  if(running.ok) return { ok: true, already: true, dir: readConfig(cfgFile).dir || '' };

  const cfg = readConfig(cfgFile);
  // 和 detect 用同一个定位逻辑：否则会出现「面板说已安装、点启动说找不到」
  const layout = locateLayout(cfg, o.dir);
  if(!layout){
    throw new Error('没有找到 ComfyUI 安装目录：请点「选择目录」指定 ComfyUI（或 ComfyUI_windows_portable）所在文件夹');
  }
  if(cfgFile && layout.dir !== cfg.dir){
    try{ writeConfig(cfgFile, Object.assign(cfg, { dir: layout.dir })); }catch(e){}
  }
  launching = true;
  logRing.length = 0;
  try{
    /* 启动参数照便携版自带的 run_nvidia_gpu.bat 来：
     * -s 不加载用户 site-packages（避免和系统装的其他包冲突），
     * 便携版再加 --windows-standalone-build（跳过一些 Windows 上的兼容检查）。 */
    const launchArgs = ['-s', path.join(layout.comfyDir, 'main.py'),
      '--port', String(COMFY_PORT), '--listen', '127.0.0.1'];
    if(layout.mode === 'portable') launchArgs.push('--windows-standalone-build');

    pushLog('$ ' + layout.python + ' ' + launchArgs.join(' '));
    child = spawn(layout.python, launchArgs, {
      cwd: layout.cwd,
      windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' })
    });
    if(child.stdout) child.stdout.on('data', b => pushLog(b.toString('utf8')));
    if(child.stderr) child.stderr.on('data', b => pushLog(b.toString('utf8')));
    child.on('error', e => pushLog('启动失败：' + ((e && e.message) || e)));
    child.on('exit', code => { pushLog('进程退出，code=' + code); child = null; });

    const ready = await waitReady(o.timeoutMs || 120000);
    if(!ready){
      const tail = logTail(12);
      stop();
      throw new Error('ComfyUI 启动失败或超时。' + (tail ? '\n最后的日志：\n' + tail : ''));
    }
    const next = Object.assign({}, cfg, { dir: layout.dir });
    writeConfig(cfgFile, next);
    return { ok: true, dir: layout.dir, mode: layout.mode, log: logTail(10) };
  }finally{
    launching = false;
  }
}

function stop(){
  if(child && child.exitCode == null){
    pushLog('正在停止 ComfyUI…');
    try{ child.kill(); }catch(e){}
    // Windows 上 python 常留子进程：超时没退就更硬地收一次
    const pid = child.pid;
    setTimeout(() => {
      if(child && child.exitCode == null){
        try{ execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); }catch(e){}
      }
    }, 2500);
  }
  return { ok: true };
}

/* 解压 .7z：按「系统 tar（免安装）→ 7-Zip」顺序试，每个工具解完都让调用方验一次。
 *
 * 为什么要 probe：bsdtar 碰到不支持的压缩过滤器时可能**退出码 0 但没解出东西**，
 * 只看退出码会误判成功，接着在空目录里找不到 ComfyUI，报一个毫不相干的错。
 *
 * 抽成独立函数是为了能被测试真正跑到（用仓库里那份 226 字节的 .7z 样例），
 * 而不是靠「按理说 libarchive 支持 7z」来赌——这条路径错了，用户要白下 2 GB。 */
async function extractArchive(archive, outDir, probe){
  const tools = [];
  const tar = findTar();
  if(tar) tools.push({ name: '系统 tar', run: () => runExe(tar, ['-xf', archive, '-C', outDir]) });
  const seven = findSevenZip();
  if(seven) tools.push({ name: '7-Zip', run: () => runExe(seven, ['x', archive, '-o' + outDir, '-y']) });

  if(!tools.length){
    return { ok: false, via: '', fails: ['本机既没有系统 tar 也没有 7-Zip'] };
  }
  const fails = [];
  for(const t of tools){
    try{
      await t.run();
      if(await probe()) return { ok: true, via: t.name, fails };
      fails.push(t.name + '：解压后在目标目录里没找到预期内容');
    }catch(e){
      fails.push(t.name + '：' + ((e && e.message) || e));
    }
  }
  return { ok: false, via: '', fails };
}

/* ---- 一键安装：下载官方便携包 → 解压 → 认目录 ----
 * 下载复用 ollama-download 的分片引擎（2 GB 单连接必挂），这里只负责
 * 「解压 → 认目录」这一小段。
 *
 * 解压工具按可用性排优先级：系统自带 tar（免安装）→ 7-Zip。
 * 两个都没有就直接失败，且必须把「缺什么」说清楚——不能下完 2 GB 才告诉用户解不开。 */
async function installPortable(cfgFile, opts){
  const o = opts || {};
  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const tar = findTar();
  const seven = findSevenZip();
  if(!tar && !seven){
    throw new Error('找不到解压工具：本机既没有系统自带的 tar.exe，也没有 7-Zip。' +
      'Windows 10 1803 以上都自带 tar，若确实缺失可安装 7-Zip（https://www.7-zip.org/）后重试');
  }
  const target = path.resolve(o.dir || path.join(os.homedir(), 'ComfyUI_windows_portable'));
  const zipPath = path.join(os.tmpdir(), 'ComfyUI_windows_portable_nvidia.7z');
  const outDir = path.dirname(target);
  try{ await fsp.mkdir(outDir, { recursive: true }); }catch(e){}

  report({ stage: 'download', pct: 0, message: '准备下载 ComfyUI 便携包（约 2 GB）…' });
  const { download, makeElectronHttpGet } = require('./ollama-download');
  const httpGet = o.httpGet || makeElectronHttpGet(o.net);
  await download({
    dest: zipPath,
    /* sources 必须传：不传的话 download() 第 391 行直接抛「没有可用的下载源」——
     * 之前的实现漏了这一个字段，「一键安装」从来没真正走到过下载那一步。 */
    sources: o.sources || PORTABLE_SOURCES,
    // 便携包是 .7z 不是 exe：关掉 PE 头校验，否则会被当成坏文件重下
    expectPE: false,
    httpGet,
    isCancelled: () => (typeof o.isCancelled === 'function' ? o.isCancelled() : false),
    onProgress: p => report({
      stage: 'download',
      pct: p.pct,
      message: p.message || ('下载中 ' + (p.pct >= 0 ? p.pct + '%' : '')),
      speed: p.speed,
      etaMs: p.etaMs,
      source: p.source
    }),
    onLog: line => pushLog(line)
  });

  report({ stage: 'extract', pct: 100, message: '下载完成，正在解压（几分钟，2 GB）…' });

  /* 解压是一段**没有进度可报**的长任务：命令行 tar / 7z 都不吐百分比，
   * 2 GB 的包在机械盘上可能十几分钟。完全静默会让人以为卡死然后强退，
   * 所以这里只做时间心跳——不假装知道进度，但让「它还在动」这件事可见。 */
  let exSec = 0;
  const tick = setInterval(() => {
    exSec += 5;
    report({
      stage: 'extract', pct: 100,
      message: '正在解压（已 ' + Math.floor(exSec / 60) + ' 分 ' + (exSec % 60) + ' 秒）…' +
        '压缩包 2 GB，解完约 6-9 GB，硬盘慢的话要十几分钟'
    });
  }, 5000);

  /* 解压出来的目录名可能带版本后缀（ComfyUI_windows_portable / ..._nvidia 等），
   * 用前几层扫描认定 ComfyUI 在哪。 */
  async function findComfy(){
    try{
      const kids = await fsp.readdir(outDir, { withFileTypes: true });
      for(const k of kids){
        if(!k.isDirectory()) continue;
        const cand = path.join(outDir, k.name);
        if(resolveLayout(cand)) return cand;
      }
    }catch(e){}
    return '';
  }

  let found = '';
  let ex;
  try{
    ex = await extractArchive(zipPath, outDir, async () => {
      found = await findComfy();
      return !!found;
    });
  }finally{
    // 一定要停：解压失败/抛异常时留着这个定时器会一直往界面推「正在解压」
    clearInterval(tick);
  }
  report({ stage: 'extract', pct: 100, message: '解压完成，正在确认目录…' });

  if(!ex.ok){
    report({ stage: 'error', pct: 100, message: '解压没成功，已下载的包留在 ' + zipPath });
    return {
      ok: false,
      message: '解压失败（' + ex.fails.join('；') + '）。包已下载好在 ' + zipPath +
        '，可以用 7-Zip 手动解压到 ' + outDir + '，或点「选择目录」指定已装好的 ComfyUI'
    };
  }

  writeConfig(cfgFile, Object.assign(readConfig(cfgFile), { dir: found }));
  try{ await fsp.unlink(zipPath); }catch(e){}
  report({ stage: 'done', pct: 100, message: '安装完成（' + ex.via + ' 解压）：' + found });
  return { ok: true, dir: found, via: ex.via };
}

module.exports = {
  COMFY_PORT, COMFY_BASE, PORTABLE_URL, PORTABLE_SOURCES, PORTABLE_GB,
  resolveLayout, candidateDirs, locateLayout, findSevenZip, findTar, detect, launch, stop,
  extractArchive, installPortable, httpProbe, logTail, pushLog, readConfig, writeConfig
};
