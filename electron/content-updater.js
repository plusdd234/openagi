/* 内容包热更新（P3 骨架）
 *
 * 「内容」= index.html / css / js / vendor —— 也就是界面与节点定义（node-defs.js）。
 * 它们不需要重新打包安装程序：下载 → 校验 → 原子切换目录 → 重载窗口即可生效。
 *
 * 设计要点：
 *   - 每个版本一个目录：<baseDir>/<version>/，里面带一份 manifest.json 供启动时自检
 *   - 指针文件 <baseDir>/current.json 记录 current / previous 两个槽位
 *   - 启动先自检 current（逐文件 sha256），坏了退 previous，再坏就用内置版本（bundled）
 *   - 下载按「变动文件」逐个拉，无需 zip 依赖；每个文件都验 sha256
 *   - manifest 可用 Ed25519 签名（公钥内置在程序里）——**不验签的热更新等于远程执行漏洞**
 *   - 全流程不依赖 Electron，方便用普通 node 单测（见 tools/electron-content.js）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = 'current.json';
const MANIFEST_FILE = 'manifest.json';
const FETCH_TIMEOUT = 30000;

function sha256(buf){
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* 签名的规范化内容：只覆盖「版本 + 最低主程序 + 文件表」，其余字段不参与 */
function canonicalManifest(m){
  return JSON.stringify({ version: String(m.version || ''), minShell: String(m.minShell || ''), files: m.files || {} });
}

function verifySignature(manifest, publicKeyB64){
  if(!publicKeyB64) return { ok: true, skipped: true };            // 开发期可不配公钥
  if(!manifest || !manifest.sig) return { ok: false, reason: '内容包没有签名' };
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki'
    });
    const ok = crypto.verify(null, Buffer.from(canonicalManifest(manifest)), key,
      Buffer.from(String(manifest.sig), 'base64'));
    return ok ? { ok: true } : { ok: false, reason: '内容包签名不匹配' };
  } catch(e){
    return { ok: false, reason: '公钥无效：' + ((e && e.message) || e) };
  }
}

/* 版本号比较：只认数字段，够用即可（1.2.10 > 1.2.9） */
function compareVersion(a, b){
  const pa = String(a || '').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map(x => parseInt(x, 10) || 0);
  for(let i = 0; i < Math.max(pa.length, pb.length); i++){
    const d = (pa[i] || 0) - (pb[i] || 0);
    if(d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function readState(baseDir){
  try {
    const raw = await fsp.readFile(path.join(baseDir, STATE_FILE), 'utf8');
    const st = JSON.parse(raw);
    return { current: String(st.current || ''), previous: String(st.previous || '') };
  } catch(e){
    return { current: '', previous: '' };
  }
}

async function writeState(baseDir, st){
  await fsp.mkdir(baseDir, { recursive: true });
  const tmp = path.join(baseDir, STATE_FILE + '.tmp');
  await fsp.writeFile(tmp, JSON.stringify({ current: st.current || '', previous: st.previous || '' }, null, 1));
  await fsp.rename(tmp, path.join(baseDir, STATE_FILE));
}

async function readManifest(dir){
  try {
    const raw = await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
    const m = JSON.parse(raw);
    if(!m || !m.files || typeof m.files !== 'object') return null;
    return m;
  } catch(e){
    return null;
  }
}

/* 目录自检：文件在不在、哈希对不对 */
async function dirHealthy(dir, manifest, opts){
  const files = Object.keys(manifest.files || {});
  if(!files.length) return false;
  for(const rel of files){
    const abs = path.join(dir, rel);
    let buf;
    try { buf = await fsp.readFile(abs); } catch(e){ return false; }
    if(opts && opts.skipHash && manifest.sizes && manifest.sizes[rel] !== buf.length) return false;
    if(!opts || !opts.skipHash){
      if(sha256(buf) !== manifest.files[rel]) return false;
    }
  }
  return true;
}

/* 选一个可用的内容根：current → previous → bundled */
async function resolveRoot(opts){
  const baseDir = opts.baseDir;
  const bundledRoot = opts.bundledRoot;
  const st = await readState(baseDir);
  const order = [st.current, st.previous].filter(Boolean);
  for(const v of order){
    const dir = path.join(baseDir, v);
    const man = await readManifest(dir);
    if(man && await dirHealthy(dir, man)){
      return { root: dir, version: v, degraded: v !== st.current, state: st };
    }
  }
  return { root: bundledRoot, version: 'bundled', degraded: order.length > 0, state: st };
}

/* 下载并切换到一个新版本；任何一步失败都不动指针 */
async function applyUpdate(opts){
  const { baseDir, manifest, manifestUrl } = opts;
  const version = String(manifest.version || '');
  if(!version) throw new Error('manifest 缺少 version');
  const tmp = path.join(baseDir, version + '.tmp');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  const files = Object.keys(manifest.files || {});
  for(const rel of files){
    const url = new URL(rel.split('/').map(encodeURIComponent).join('/'), manifestUrl).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), cache: 'no-store' });
    if(!res.ok) throw new Error('下载失败 ' + rel + '（HTTP ' + res.status + '）');
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if(got !== manifest.files[rel]){
      throw new Error('文件校验失败：' + rel);
    }
    const dest = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    if(typeof opts.onProgress === 'function'){
      opts.onProgress({ file: rel, done: files.indexOf(rel) + 1, total: files.length });
    }
  }
  await fsp.writeFile(path.join(tmp, MANIFEST_FILE), JSON.stringify(manifest, null, 1));

  const st = await readState(baseDir);
  const final = path.join(baseDir, version);
  await fsp.rm(final, { recursive: true, force: true });
  await fsp.rename(tmp, final);
  await writeState(baseDir, { current: version, previous: st.current || st.previous || '' });
  await pruneVersions(baseDir, [version, st.current].filter(Boolean));
  return { root: final, version };
}

/* 只留当前与上一版，别的目录（含 .tmp）清掉 */
async function pruneVersions(baseDir, keep){
  let names = [];
  try { names = await fsp.readdir(baseDir); } catch(e){ return 0; }
  let removed = 0;
  for(const n of names){
    if(n === STATE_FILE || n === STATE_FILE + '.tmp') continue;
    if(keep.indexOf(n) >= 0) continue;
    try { await fsp.rm(path.join(baseDir, n), { recursive: true, force: true }); removed++; } catch(e){}
  }
  return removed;
}

/* 检查并更新。返回 { ok, updated, version, root, reason } —— 永不抛错（调用方是启动流程） */
async function check(opts){
  const o = opts || {};
  try {
    if(!o.manifestUrl) return { ok: false, reason: '未配置内容源' };
    const res = await fetch(o.manifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if(!res.ok) return { ok: false, reason: '清单不可用（HTTP ' + res.status + '）' };
    const manifest = await res.json();

    const sig = verifySignature(manifest, o.publicKey);
    if(!sig.ok) return { ok: false, reason: sig.reason };

    if(manifest.minShell && o.appVersion && compareVersion(o.appVersion, manifest.minShell) < 0){
      return { ok: false, reason: '这一版内容需要更新的主程序（≥ ' + manifest.minShell + '）' };
    }

    const cur = await resolveRoot({ baseDir: o.baseDir, bundledRoot: o.bundledRoot });
    if(cur.version === manifest.version){
      return { ok: true, updated: false, version: cur.version, root: cur.root };
    }
    const applied = await applyUpdate({
      baseDir: o.baseDir, manifest, manifestUrl: o.manifestUrl, onProgress: o.onProgress
    });
    return { ok: true, updated: true, version: applied.version, root: applied.root, previous: cur.version };
  } catch(e){
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = {
  STATE_FILE, MANIFEST_FILE,
  sha256, canonicalManifest, verifySignature, compareVersion,
  readState, writeState, readManifest, dirHealthy,
  resolveRoot, applyUpdate, pruneVersions, check
};
