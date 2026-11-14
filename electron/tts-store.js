/* 本地语音商店：把 Piper 语音权重下到 userData/tts，供本地引擎桥合成。
 *
 * 和生图权重的区别：
 *   - 体积小（20-115 MB），但仍然走 ollama-download 的分片/续传，弱网下不至于白下；
 *   - 语音之外还需要一份 piper 可执行文件（约 21 MB），所有音色共用，只装一次；
 *   - 文件不做 PE 校验（.onnx / .zip 不是 MZ 头），改成「长度对齐 + 能被引擎读到」。
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const dl = require('./ollama-download');

const ENGINE = {
  dir: 'piper',
  exe: 'piper.exe',
  zip: 'piper_windows_amd64.zip',
  bytes: 22477236,
  urls: [
    { url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', name: 'GitHub' },
    { url: 'https://github.moeyy.xyz/https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', name: '代理' }
  ]
};

/* 超自然语音（Kokoro-82M int8 + sherpa-onnx）。
 * 和 Piper 最大的不同是「共享」：所有音色共用同一份模型，切换音色只是换 --sid，
 * 所以这里不再按 voiceFile 管理，而是两个固定目录：
 *   tts/sherpa/  —— 引擎（exe + 同目录 DLL，必须整包解压在一起）
 *   tts/kokoro/  —— model.int8.onnx / voices.bin / tokens.txt / lexicon
 * 体积为 GitHub Release 上的实测 Content-Length，不是估算。 */
const KOKORO = {
  engine: {
    dir: 'sherpa',
    tar: 'sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2',
    unpack: 'sherpa-onnx-v2.0.1-win-x64-shared-MT-Release',
    exe: path.join('bin', 'sherpa-onnx-offline-tts.exe'),
    bytes: 26664192,
    urls: [
      { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2', name: 'GitHub' },
      { url: 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2', name: 'gh-proxy' },
      { url: 'https://gh.monlor.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2', name: 'gh.monlor' }
    ]
  },
  model: {
    dir: 'kokoro',
    tar: 'kokoro-int8-multi-lang-v1_0.tar.bz2',
    unpack: 'kokoro-int8-multi-lang-v1_0',
    bytes: 132353410,
    urls: [
      { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2', name: 'GitHub' },
      { url: 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2', name: 'gh-proxy' },
      { url: 'https://gh.monlor.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2', name: 'gh.monlor' }
    ]
  }
};

function root(userData){
  return path.join(userData, 'tts');
}
function voicesDir(userData){
  return path.join(root(userData), 'voices');
}
function enginePath(userData){
  return path.join(root(userData), ENGINE.dir, ENGINE.exe);
}
function engineReady(userData){
  try{ return fs.existsSync(enginePath(userData)); }catch(e){ return false; }
}
/* ---- Kokoro 路径与状态 ---- */
function kokoroDir(userData){
  return path.join(root(userData), KOKORO.model.dir);
}
function sherpaDir(userData){
  return path.join(root(userData), KOKORO.engine.dir);
}
function kokoroExe(userData){
  return path.join(sherpaDir(userData), KOKORO.engine.exe);
}
/* 三个文件缺一不可：model.int8.onnx 是权重，voices.bin 是声纹，
 * tokens.txt 是音素表。少一个都会在合成时直接报错，所以提前判掉。 */
function kokoroModelReady(userData){
  try{
    const d = kokoroDir(userData);
    return fs.existsSync(path.join(d, 'model.int8.onnx')) &&
      fs.existsSync(path.join(d, 'voices.bin')) &&
      fs.existsSync(path.join(d, 'tokens.txt'));
  }catch(e){ return false; }
}
function kokoroStatus(userData){
  const engine = fs.existsSync(kokoroExe(userData));
  const model = kokoroModelReady(userData);
  return {
    ok: true,
    installed: engine && model,
    engine,
    model,
    dir: kokoroDir(userData),
    exe: kokoroExe(userData)
  };
}
/* 文件名只允许落在 voices/ 下：否则一个 ../ 就能删掉用户别的文件。 */
function safeName(name){
  const base = path.basename(String(name || ''));
  return base && base !== '.' && base !== '..' ? base : '';
}
function psQuote(s){
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function unzip(zip, dest){
  return new Promise((resolve, reject) => {
    const cmd = 'Expand-Archive -LiteralPath ' + psQuote(zip) + ' -DestinationPath ' + psQuote(dest) + ' -Force';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 120000 }, err => {
        if(err) return reject(new Error('解压 Piper 引擎失败：' + err.message));
        resolve();
      });
  });
}

async function list(userData){
  let files = [];
  try{ files = await fsp.readdir(voicesDir(userData)); }catch(e){}
  const voices = files
    .filter(f => /\.onnx$/i.test(f))
    .map(f => ({
      file: f,
      json: fs.existsSync(path.join(voicesDir(userData), f + '.json'))
    }));
  return { ok: true, engine: engineReady(userData), dir: root(userData), voices };
}

/* 引擎只装一次；装完写 .ready 标记，之后 list/install 都只 stat 这个文件。 */
async function ensureEngine(userData, report, isCancelled, httpGet){
  if(engineReady(userData)) return;
  await fsp.mkdir(root(userData), { recursive: true });
  const zip = path.join(root(userData), ENGINE.zip);
  report({ stage: 'engine', pct: 0, msg: '正在下载本地语音引擎（约 21 MB）…' });
  const r = await dl.download({
    dest: zip,
    sources: ENGINE.urls,
    expectPE: false,
    httpGet,
    isCancelled,
    onLog: () => {},
    onProgress: p => {
      if(!p) return;
      report({
        stage: 'engine',
        pct: p.pct >= 0 ? Math.round(p.pct * 0.25) : -1,
        msg: '正在下载本地语音引擎（约 21 MB）…',
        speed: p.speed, etaMs: p.etaMs
      });
    }
  });
  if(r && r.cancelled) return;
  report({ stage: 'engine', pct: 25, msg: '正在解压语音引擎…' });
  await unzip(zip, root(userData));
  try{ await fsp.rm(zip, { force: true }); }catch(e){}
  if(!engineReady(userData)) throw new Error('语音引擎解压后没有找到 piper.exe');
}

async function install(userData, req, opts){
  const o = opts || {};
  const r = req || {};
  /* Piper 的预编译包目前只提供 Windows x64；其它平台先明确拒绝，
   * 而不是下一个 .zip 解压失败让用户猜。 */
  if(process.platform !== 'win32') throw new Error('本地语音下载目前仅支持 Windows');
  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const isCancelled = typeof o.isCancelled === 'function' ? o.isCancelled : () => false;
  const rawName = String(r.voiceFile || '');
  const name = safeName(rawName);
  /* 含路径分隔符的名字直接拒绝，而不是悄悄 basename 掉：
   * 正常目录里下发的就是纯文件名，出现 ../ 只可能是请求出错或被构造。 */
  if(!name || name !== rawName || !/\.onnx$/i.test(name)) throw new Error('语音权重文件名不合法');
  if(!Array.isArray(r.urls) || !r.urls.length) throw new Error('缺少语音权重下载地址');
  const jsonName = safeName(r.voiceJson || (name + '.json'));
  await fsp.mkdir(voicesDir(userData), { recursive: true });

  await ensureEngine(userData, report, isCancelled, o.httpGet);
  if(isCancelled()) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };

  const stages = [
    { file: name, urls: r.urls, from: 25, span: 73, msg: '正在下载语音权重…' },
    { file: jsonName, urls: r.jsonUrls || r.urls, from: 98, span: 2, msg: '正在写入语音配置…' }
  ];
  for(const st of stages){
    if(isCancelled()) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };
    report({ stage: 'voice', pct: st.from, msg: st.msg });
    const got = await dl.download({
      dest: path.join(voicesDir(userData), st.file),
      sources: st.urls.map(url => ({ url, name: /hf-mirror/.test(url) ? 'HF 镜像' : 'HuggingFace' })),
      expectPE: false,
      httpGet: o.httpGet,
      isCancelled,
      onLog: () => {},
      onProgress: p => {
        if(!p) return;
        report({
          stage: 'voice',
          pct: p.pct >= 0 ? Math.round(st.from + p.pct * st.span / 100) : -1,
          msg: st.msg,
          speed: p.speed, etaMs: p.etaMs
        });
      }
    });
    if(got && got.cancelled) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };
  }
  const after = await list(userData);
  if(after.voices.findIndex(v => v.file === name) === -1) throw new Error('下载完成但没有找到语音文件');
  report({ stage: 'done', pct: 100, msg: '已下载并设为默认语音' });
  return { ok: true, engine: after.engine, voices: after.voices };
}

async function remove(userData, req){
  const r = req || {};
  const dir = voicesDir(userData);
  const names = [safeName(r.voiceFile), safeName(r.voiceJson)].filter(Boolean);
  if(!names.length) throw new Error('缺少要删除的语音文件');
  for(const n of names){
    await fsp.rm(path.join(dir, n), { force: true });
    /* 中断留下的续传侧车也一起清掉，否则重新下载会复用旧分片 */
    await fsp.rm(path.join(dir, n + '.part.json'), { force: true });
  }
  return { ok: true, voices: (await list(userData)).voices };
}

/* tar.bz2 解包交给 Windows 自带的 bsdtar（Win10 1803+ 都有，原生支持 bz2）。
 * 不自己写解压：bz2 + tar 两层格式，用手写流式解析只会多一堆边界 bug。 */
function untar(tarFile, dest){
  return new Promise((resolve, reject) => {
    execFile('tar.exe', ['-xjf', tarFile, '-C', dest],
      { windowsHide: true, timeout: 300000 }, err => {
        if(err) return reject(new Error('解压语音模型失败：' + err.message));
        resolve();
      });
  });
}

/* 下载并解压一个 tar.bz2 包，最后把解压出来的顶层目录改名为固定名字。
 * 目录名固定下来，运行时桥就不用去猜版本号（版本升级只改这里的 unpack 值）。 */
async function ensurePackage(userData, spec, label, from, span, ready, report, isCancelled, httpGet){
  if(ready()) return true;
  await fsp.mkdir(root(userData), { recursive: true });
  const tarPath = path.join(root(userData), spec.tar);
  report({ stage: 'kokoro', pct: from, msg: '正在下载' + label + '…' });
  const r = await dl.download({
    dest: tarPath,
    sources: spec.urls,
    expectPE: false,
    httpGet,
    isCancelled,
    onLog: () => {},
    onProgress: p => {
      if(!p) return;
      /* 下载占这一段的前 85%，留 15% 给解压——否则进度条会停在 100% 干等十几秒 */
      report({
        stage: 'kokoro',
        pct: p.pct >= 0 ? Math.round(from + p.pct * span * 0.85 / 100) : -1,
        msg: '正在下载' + label + '…',
        speed: p.speed, etaMs: p.etaMs
      });
    }
  });
  if(r && r.cancelled) return false;
  report({ stage: 'kokoro', pct: Math.round(from + span * 0.85), msg: '正在解压' + label + '…' });

  const tmp = path.join(root(userData), '.unpack-' + spec.dir);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  await untar(tarPath, tmp);
  const src = path.join(tmp, spec.unpack);
  if(!fs.existsSync(src)) throw new Error('解压后没有找到 ' + spec.unpack);
  const dest = path.join(root(userData), spec.dir);
  await fsp.rm(dest, { recursive: true, force: true });
  try{
    await fsp.rename(src, dest);
  }catch(e){
    /* Windows 上杀毒软件偶尔会短暂占用刚解压的文件，rename 失败就退回复制 */
    await fsp.cp(src, dest, { recursive: true });
  }
  await fsp.rm(tmp, { recursive: true, force: true });
  try{ await fsp.rm(tarPath, { force: true }); }catch(e){}
  if(!ready()) throw new Error(label + '校验失败：缺少必要文件');
  report({ stage: 'kokoro', pct: from + span, msg: label + '已就绪' });
  return true;
}

/* 安装 Kokoro：引擎（26 MB）与模型（126 MB）分开下，已就绪的那份直接跳过。
 * 这是「共享模型」的关键——第二次点任意 Kokoro 音色都应该是秒完成。 */
async function installKokoro(userData, req, opts){
  const o = opts || {};
  if(process.platform !== 'win32') throw new Error('Kokoro 超自然语音目前仅支持 Windows');
  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const isCancelled = typeof o.isCancelled === 'function' ? o.isCancelled : () => false;
  report({ stage: 'kokoro', pct: 0, msg: '正在准备 Kokoro 超自然语音（约 160 MB）…' });

  const engineOk = await ensurePackage(userData, KOKORO.engine, '本地语音引擎（26 MB）', 0, 16,
    () => fs.existsSync(kokoroExe(userData)), report, isCancelled, o.httpGet);
  if(!engineOk) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };

  const modelOk = await ensurePackage(userData, KOKORO.model, 'Kokoro 超自然音色（126 MB）', 16, 82,
    () => kokoroModelReady(userData), report, isCancelled, o.httpGet);
  if(!modelOk) return { ok: false, cancelled: true, message: '已取消下载，进度已保留' };

  report({ stage: 'done', pct: 100, msg: 'Kokoro 超自然语音已就绪' });
  return Object.assign({ ok: true }, kokoroStatus(userData));
}

/* 卸载共享模型：引擎和模型一起删。Piper 在 tts/piper 与 tts/voices，互不影响。 */
async function removeKokoro(userData){
  await fsp.rm(kokoroDir(userData), { recursive: true, force: true });
  await fsp.rm(sherpaDir(userData), { recursive: true, force: true });
  return { ok: true, installed: false };
}

module.exports = {
  ENGINE, KOKORO, root, voicesDir, enginePath, engineReady, safeName, list, install, remove,
  kokoroDir, sherpaDir, kokoroExe, kokoroModelReady, kokoroStatus, installKokoro, removeKokoro
};
