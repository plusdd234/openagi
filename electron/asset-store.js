/* 资产库（参考 UE 的 Content Browser / Asset Registry）
 *
 * 为什么要有它：
 *   项目一直把生成图以 base64 塞进 localStorage，超过 40 KB 再外置到 IndexedDB。
 *   那是为了绕开 5 MB 配额想出来的补丁——图不能备份、不能跨机带走、不能被别的
 *   工具打开，而且配额一超就要走「救援阶梯」丢数据。UE 的做法很直白：
 *   **资产就是磁盘上的文件，另维护一份元数据索引**。
 *
 * 四条设计（都是踩过的坑换来的）：
 *   ① **id 与文件名解耦**：文件名就用 id，改名只动索引不动文件。流程里只记 id，
 *      所以资产改名字不会断引用，也不会因为路径带中文/空格出问题。
 *   ② **引用关系不落索引**：谁在用某个资产，由渲染层扫流程得出。索引里再存一份
 *      必然和真相对不上——删节点、撤销、导入备份都会改引用，而索引不会跟着变。
 *   ③ **索引坏了能重建**：磁盘上的文件才是真相，index.json 只是缓存。
 *      `reconcile()` 扫目录补齐缺失元数据、剔除已被外部删掉的文件。
 *   ④ **删除进回收站不直接抹**：资产是用户的产出，误删没法重来。移到 `.trash/`
 *      里还能捞回来，再由用户显式清空。
 *
 * 类型：image（生成图/参考图）、model（glb/obj/gltf 等 3D）、blob（其他大字符串）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const KIND_DIR = { image: 'images', model: 'models', blob: 'blobs' };
const KIND_EXT = { image: 'png', model: 'glb', blob: 'bin' };
const TRASH_DIR = '.trash';
/* 3D 缩略图单独存一份：每次打开库都现场渲染会卡（一个模型要建 WebGL 上下文 + 解析几何）。
 * 图片不需要缩略图，原图本身就能当磁贴。 */
const THUMB_DIR = 'thumbs';

/* 各种 MIME 对应的落盘扩展名。不认识的按类型给默认值，
 * 扩展名只影响「双击能不能被系统正确打开」，不影响我们自己的读取。 */
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'application/octet-stream': ''      // 看文件名再定
};

const MODEL_EXT_RE = /^\.?(glb|gltf|obj|fbx|stl|ply|3mf|usdz)$/i;

function nowMs(){ return Date.now(); }

function newId(){
  // 时间戳前缀让目录按时间有序，随机后缀防碰撞
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

/* dataURL → { buf, ext }。不是 dataURL 时返回 null（调用方按普通 base64 处理）。 */
function parseDataURL(s){
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(s || ''));
  if(!m) return null;
  const mime = m[1].toLowerCase();
  const isB64 = !!m[2];
  const payload = m[3];
  const buf = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  let ext = MIME_EXT[mime];
  if(ext === undefined) ext = mime.startsWith('image/') ? mime.slice(6).replace(/[^a-z0-9]/g, '') : '';
  return { mime, buf, ext };
}

function safeName(s){
  return String(s || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
}

/* 建一个资产库实例。root 由调用方决定（dev 用仓库下 assets/，打包后用 userData/assets/）。
 * 不直接 require('electron').app 是为了能脱离 Electron 做单元测试。 */
function createAssetStore(root){
  const ROOT = path.resolve(root);
  const INDEX = path.join(ROOT, 'index.json');
  let cache = null;           // 索引内存副本
  let writeQueue = Promise.resolve();

  function kindDir(kind){
    return path.join(ROOT, KIND_DIR[kind] || KIND_DIR.blob);
  }
  async function ensureDirs(){
    for(const k of Object.keys(KIND_DIR)){
      try{ await fsp.mkdir(kindDir(k), { recursive: true }); }catch(e){}
    }
    try{ await fsp.mkdir(path.join(ROOT, TRASH_DIR), { recursive: true }); }catch(e){}
    try{ await fsp.mkdir(path.join(ROOT, THUMB_DIR), { recursive: true }); }catch(e){}
  }

  function thumbFile(id){
    return path.join(ROOT, THUMB_DIR, String(id) + '.png');
  }

  /* 读缩略图。没有就是没有（返回 ok:false），调用方据此决定要不要现场渲染一张。 */
  async function readThumb(id){
    try{
      const buf = await fsp.readFile(thumbFile(id));
      if(!buf.length) return { ok: false };
      return { ok: true, dataURL: 'data:image/png;base64,' + buf.toString('base64') };
    }catch(e){
      return { ok: false };
    }
  }

  async function saveThumb(id, data){
    const parsed = parseDataURL(data);
    if(!parsed) return { ok: false, message: '缩略图必须是 dataURL' };
    try{
      const f = thumbFile(id);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, parsed.buf);
      return { ok: true, bytes: parsed.buf.length };
    }catch(e){
      return { ok: false, message: String((e && e.message) || e) };
    }
  }

  function readIndex(){
    if(cache) return cache;
    try{
      const j = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
      cache = (j && typeof j === 'object' && j.assets && typeof j.assets === 'object')
        ? j : { version: 1, assets: {} };
    }catch(e){
      cache = { version: 1, assets: {} };
    }
    if(!cache.version) cache.version = 1;
    return cache;
  }

  /* 索引写入串行化：并发 put（比如流程里一次保存多张图）同时写会互相覆盖 */
  function writeIndex(){
    const data = JSON.stringify(cache, null, 1);
    writeQueue = writeQueue.then(async () => {
      await fsp.mkdir(ROOT, { recursive: true });
      const tmp = INDEX + '.tmp';
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, INDEX);
    }).catch(() => {});
    return writeQueue;
  }

  function metaOf(id){
    return readIndex().assets[id] || null;
  }

  function fileOf(meta){
    if(!meta) return '';
    return path.join(kindDir(meta.kind), meta.id + '.' + (meta.ext || KIND_EXT[meta.kind] || 'bin'));
  }

  /* 导入一份资产。data 可以是 dataURL 字符串，也可以是 Buffer。
   * 传 id 时用它当文件名（blob-store 的存根 id 要稳定，不能每次换）；
   * 不传就新生成一个。 */
  async function put(opts){
    const o = opts || {};
    await ensureDirs();
    const kind = KIND_DIR[o.kind] ? o.kind : 'blob';
    let buf, ext;

    if(Buffer.isBuffer(o.data)){
      buf = o.data;
      ext = String(o.ext || '').replace(/^\./, '').toLowerCase() ||
        (kind === 'model' ? KIND_EXT.model : KIND_EXT[kind]);
    } else {
      const s = String(o.data || '');
      const parsed = parseDataURL(s);
      if(parsed){
        buf = parsed.buf;
        ext = (o.ext || parsed.ext || KIND_EXT[kind]).replace(/^\./, '').toLowerCase();
        // octet-stream 且没给出有意义扩展名时，按类型兜底
        if(!ext) ext = KIND_EXT[kind];
      } else {
        buf = Buffer.from(s, 'utf8');
        ext = KIND_EXT[kind];
      }
    }
    if(!buf || !buf.length) throw new Error('资产内容为空');

    const id = o.id ? String(o.id) : newId();
    // 同一 id 重存（内容可能变了）：文件扩展名可能不同，先把旧文件清掉
    const old = metaOf(id);
    if(old){
      const oldFile = fileOf(old);
      if(oldFile && path.resolve(oldFile) !== path.resolve(fileOf({ id, kind, ext }))){
        try{ await fsp.unlink(oldFile); }catch(e){}
      }
    }

    const file = fileOf({ id, kind, ext });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);

    const idx = readIndex();
    const prev = idx.assets[id] || {};
    idx.assets[id] = {
      id,
      kind,
      ext,
      name: safeName(o.name) || prev.name || (id + '.' + ext),
      size: buf.length,
      created: prev.created || nowMs(),
      updated: nowMs(),
      source: safeName(o.source) || prev.source || '',
      ...(o.meta && typeof o.meta === 'object' ? o.meta : {})
    };
    await writeIndex();
    return idx.assets[id];
  }

  /* 读回资产内容 → dataURL（前端 <img src> / fetch 都能直接用）。
   * 文件不在了返回 ok:false：调用方（blob-store）要能感知到并降级。 */
  async function read(id){
    const meta = metaOf(id);
    if(!meta) return { ok: false, error: '资产不在索引里', id };
    const file = fileOf(meta);
    let buf;
    try{ buf = await fsp.readFile(file); }
    catch(e){ return { ok: false, error: '文件缺失：' + path.basename(file), id, missing: true }; }
    const mime = meta.kind === 'image'
      ? ('image/' + (meta.ext === 'jpg' ? 'jpeg' : meta.ext))
      : (meta.ext === 'glb' ? 'model/gltf-binary' : 'application/octet-stream');
    return { ok: true, id, kind: meta.kind, mime, size: buf.length, dataURL: 'data:' + mime + ';base64,' + buf.toString('base64') };
  }

  /* 列出全部资产。顺带把「索引里有、磁盘上没有」的条目标出来，
   * 让界面能显示「文件已丢失」而不是假装一切正常。 */
  async function list(){
    await ensureDirs();
    const idx = readIndex();
    const out = [];
    let total = 0;
    for(const id of Object.keys(idx.assets)){
      const meta = idx.assets[id];
      const file = fileOf(meta);
      let size = Number(meta.size) || 0;
      let missing = false;
      try{
        const st = await fsp.stat(file);
        size = st.size;
        if(size !== meta.size){ meta.size = size; }
      }catch(e){ missing = true; }
      total += size;
      out.push(Object.assign({}, meta, { size, missing }));
    }
    out.sort((a, b) => b.created - a.created);
    return { ok: true, root: ROOT, assets: out, totalBytes: total, count: out.length };
  }

  /* 删除 = 移到 .trash/<批次>/，不直接抹。返回搬运结果，前端据此提示「已移到回收站」。 */
  async function remove(ids){
    await ensureDirs();
    const list0 = Array.isArray(ids) ? ids : [ids];
    const idx = readIndex();
    const batch = path.join(ROOT, TRASH_DIR, String(nowMs()));
    const moved = [], failed = [];
    for(const id of list0){
      const meta = idx.assets[id];
      if(!meta){ failed.push({ id, error: '不存在' }); continue; }
      const file = fileOf(meta);
      try{
        await fsp.mkdir(batch, { recursive: true });
        await fsp.rename(file, path.join(batch, path.basename(file)));
        // 缩略图跟着资产走：留着就是个永远没人用的孤儿 PNG
        try{ await fsp.unlink(thumbFile(id)); }catch(e){}
        moved.push(id);
        delete idx.assets[id];
      }catch(e){
        // 文件本来就不在（用户手动删了）也算成功，否则会一直卡在列表里删不掉
        if(e && e.code === 'ENOENT'){ moved.push(id); delete idx.assets[id]; }
        else failed.push({ id, error: String((e && e.message) || e) });
      }
    }
    await writeIndex();
    return { ok: true, moved, failed, trashDir: batch };
  }

  /* 对账：磁盘是真相。补回索引里缺失的元数据，剔除文件已被外部删掉的条目。 */
  async function reconcile(){
    await ensureDirs();
    const idx = readIndex();
    const added = [];
    const dropped = [];

    // 1) 磁盘有、索引没有 → 补一条
    for(const kind of Object.keys(KIND_DIR)){
      const dir = kindDir(kind);
      let names = [];
      try{ names = await fsp.readdir(dir); }catch(e){ continue; }
      for(const fn of names){
        if(fn.startsWith('.')) continue;
        const ext = path.extname(fn).slice(1).toLowerCase();
        const id = path.basename(fn, path.extname(fn));
        if(idx.assets[id]) continue;
        let size = 0, mtime = nowMs();
        try{
          const st = await fsp.stat(path.join(dir, fn));
          size = st.size; mtime = st.mtimeMs;
        }catch(e){ continue; }
        idx.assets[id] = {
          id, kind, ext, name: fn, size, created: mtime, updated: mtime,
          source: 'recovered'
        };
        added.push(id);
      }
    }
    // 2) 索引有、磁盘没有 → 剔掉（否则界面会出现一堆打不开的空卡片）
    for(const id of Object.keys(idx.assets)){
      const file = fileOf(idx.assets[id]);
      try{ await fsp.access(file); }
      catch(e){ delete idx.assets[id]; dropped.push(id); }
    }
    // 3) 缩略图孤儿：资产没了，缩略图也该走，否则 thumbs/ 会一直变大
    let thumbsDropped = 0;
    try{
      const tdir = path.join(ROOT, THUMB_DIR);
      const names = await fsp.readdir(tdir);
      for(const fn of names){
        const id = path.basename(fn, path.extname(fn));
        if(idx.assets[id]) continue;
        try{ await fsp.unlink(path.join(tdir, fn)); thumbsDropped++; }catch(e){}
      }
    }catch(e){}
    if(added.length || dropped.length || thumbsDropped) await writeIndex();
    return { ok: true, added, dropped, thumbsDropped };
  }

  /* 占用统计：按类型分开算，界面上「谁在占空间」一眼看得见。
   * 同时统计回收站——那里往往也堆着几个 GB，用户常忘了。 */
  async function stat(){
    const l = await list();
    const byKind = {};
    for(const a of l.assets){
      const k = a.kind;
      if(!byKind[k]) byKind[k] = { count: 0, bytes: 0 };
      byKind[k].count++;
      byKind[k].bytes += a.size;
    }
    let trashBytes = 0, trashCount = 0;
    try{
      const batches = await fsp.readdir(path.join(ROOT, TRASH_DIR));
      for(const b of batches){
        const dir = path.join(ROOT, TRASH_DIR, b);
        let names = [];
        try{ names = await fsp.readdir(dir); }catch(e){ continue; }
        for(const fn of names){
          try{
            const st = await fsp.stat(path.join(dir, fn));
            if(st.isFile()){ trashBytes += st.size; trashCount++; }
          }catch(e){}
        }
      }
    }catch(e){}
    return { ok: true, root: ROOT, totalBytes: l.totalBytes, count: l.count, byKind, trashBytes, trashCount };
  }

  async function emptyTrash(){
    const dir = path.join(ROOT, TRASH_DIR);
    try{ await fsp.rm(dir, { recursive: true, force: true }); }catch(e){
      return { ok: false, message: String((e && e.message) || e) };
    }
    try{ await fsp.mkdir(dir, { recursive: true }); }catch(e){}
    return { ok: true };
  }

  /* 导出资产到指定目录（UE 的 Migrate 的最小版）：把文件复制出去，
   * 让用户能用别的工具打开，也方便备份。 */
  async function exportTo(ids, destDir){
    const out = [];
    for(const id of (Array.isArray(ids) ? ids : [ids])){
      const meta = metaOf(id);
      if(!meta) continue;
      try{
        await fsp.mkdir(destDir, { recursive: true });
        const target = path.join(destDir, safeName(meta.name) || (id + '.' + meta.ext));
        await fsp.copyFile(fileOf(meta), target);
        out.push(target);
      }catch(e){}
    }
    return { ok: true, files: out };
  }

  return {
    root: ROOT, indexFile: INDEX,
    ensureDirs, put, read, list, remove, reconcile, stat, emptyTrash, exportTo,
    readThumb, saveThumb, thumbFile,
    metaOf, fileOf, newId,
    // 测试用：清掉内存里的索引副本，强制重读
    _resetCache(){ cache = null; }
  };
}

module.exports = {
  createAssetStore, parseDataURL, MODEL_EXT_RE, KIND_DIR, KIND_EXT, TRASH_DIR
};
