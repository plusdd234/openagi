/* 媒体库（视频 / 音频 / 字幕）· 主进程侧
 *
 * 为什么需要它：
 *   播放器 App 要播「已经下到本地的剧」，而播放器跑在 app://openagi 这个源里，
 *   直接写 <video src="file:///D:/片子/01.mp4"> 会被 Chromium 直接挡掉（跨源文件访问）。
 *   唯一能流式播的路子是：文件进一个受控目录 + 主进程注册一个自定义协议去读。
 *
 * 三条设计（都是踩过的坑换来的）：
 *   ① **目录只此一处**：所有媒体都放在 userData/media 下，id 是「相对这个目录的 posix 路径」。
 *      用户导入文件夹时保持原来的子目录结构（一部番一个文件夹），否则二十部番的
 *      第 01 集会全挤在一个平铺列表里，谁是谁都分不清。
 *   ② **id 必须过闸门**：渲染进程传来的字符串会拼进磁盘路径，不校验就等于给了
 *      一个 ../../ 穿越写任意位置的口子。`safeRel()` 是唯一入口，任何读写都得先过它。
 *   ③ **播放器只认识 id**：播放列表里存 id，真路径只有协议处理器知道。
 *      这样文件被用户自己改名/搬走时，界面报「找不到」而不是拿到一条错路径。
 *
 * 转码不做：Chromium 只认 mp4(H.264/AAC) / webm / m4v，mkv 里的 H.264 也播不了
 * （它不支持 Matroska 容器）。这件事在渲染层如实提示，别在主进程假装能解码。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* 扩展名 → MIME。协议处理器靠它对 Content-Type 下判断；
 * 认不出来的按 application/octet-stream 给，浏览器会自己嗅探。 */
const VIDEO_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t',
  flv: 'video/x-flv', ogv: 'video/ogg', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg'
};
const AUDIO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma'
};
const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp'
};
const SUB_MIME = { srt: 'text/plain', vtt: 'text/vtt', ass: 'text/plain', ssa: 'text/plain' };

/* Chromium 真正能解的容器。列表里给每个文件算一个 playable 标记，
 * 界面据此把「点了黑屏」提前说清楚——播放器最忌讳的是点了没反应还不知道为什么。 */
const PLAYABLE_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);

const ALL_EXT = Object.assign({}, VIDEO_MIME, AUDIO_MIME, IMAGE_MIME, SUB_MIME);

/* 递归扫描的上限。太深会陷进「下载软件的缓存目录」那种几十万文件的坑。 */
const MAX_DEPTH = 5;
const MAX_FILES = 4000;

function extOf(name){ return String(path.extname(name || '')).replace(/^\./, '').toLowerCase(); }
function mimeOf(name){
  return ALL_EXT[extOf(name)] || 'application/octet-stream';
}
function kindOf(name){
  const e = extOf(name);
  if(VIDEO_MIME[e]) return 'video';
  if(AUDIO_MIME[e]) return 'audio';
  if(IMAGE_MIME[e]) return 'image';
  if(SUB_MIME[e]) return 'sub';
  return '';
}

/* id 闸门：只允许一层层普通的相对路径段。
 * 反斜杠先统一成正斜杠（用户在 Windows 上可能会带过来），再逐段校验。 */
function safeRel(input){
  const raw = String(input == null ? '' : input).replace(/\\/g, '/').trim();
  if(!raw) throw new Error('缺少文件 id');
  if(raw.length > 512) throw new Error('文件 id 过长');
  if(raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error('不允许绝对路径：' + raw);
  const parts = raw.split('/').filter(p => p !== '' && p !== '.');
  if(!parts.length) throw new Error('文件 id 不合法：' + raw);
  for(const seg of parts){
    if(seg === '..') throw new Error('不允许路径穿越：' + raw);
    if(/[:*?"<>|]/.test(seg)) throw new Error('文件名含非法字符：' + seg);
  }
  return parts.join('/');
}

/* 文件名清洗：从 URL 或用户输入里取一个能落盘的 basename。 */
function safeBaseName(name, fallbackExt){
  let base = String(name || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  base = base.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim();
  if(base.length > 150) base = base.slice(0, 150);
  if(!base) base = 'media-' + Date.now().toString(36);
  if(!extOf(base) && fallbackExt) base += '.' + String(fallbackExt).replace(/^\./, '');
  return base;
}

/* 重名就加 -1 / -2，绝不覆盖用户已有的文件——
 * 覆盖一次可能就是几个 G 的重新下载，而且原来那集再也找不回来。 */
async function uniqueIn(dir, base){
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = base;
  for(let i = 1; i < 500; i++){
    try{
      await fsp.access(path.join(dir, candidate));
      candidate = stem + '-' + i + ext;
    }catch(e){ return candidate; }
  }
  return stem + '-' + crypto.randomBytes(3).toString('hex') + ext;
}

/* 按路径自然排序：`第2集` 要排在 `第10集` 前面。
 * 纯字典序会把 10 排到 2 前面，一整季的播放顺序就乱了。 */
const NAT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function naturalCmp(a, b){ return NAT.compare(a, b); }

function createMediaStore(root, deps){
  const ROOT = root;
  const dl = (deps && deps.dl) || null;
  const jobs = new Map();       // 下载任务：id → 取消标记

  async function ensure(){
    await fsp.mkdir(ROOT, { recursive: true });
    return ROOT;
  }

  /* 绝对路径：先过 id 闸门，再确认落点真的在 root 之内。
   * 两道都要，因为 path.resolve 在不同平台上对符号链接的处理不一致。 */
  function absOf(id){
    const rel = safeRel(id);
    const abs = path.resolve(ROOT, rel);
    const relCheck = path.relative(ROOT, abs);
    if(!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new Error('路径越界：' + id);
    return abs;
  }

  async function walk(dir, depth, out){
    if(depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let ents = [];
    try{ ents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch(e){ return; }
    ents.sort((a, b) => naturalCmp(a.name, b.name));
    for(const ent of ents){
      if(out.length >= MAX_FILES) return;
      if(ent.name.startsWith('.')) continue;              // .part 临时文件、系统隐藏文件
      const full = path.join(dir, ent.name);
      if(ent.isDirectory()){ await walk(full, depth + 1, out); continue; }
      if(!ent.isFile()) continue;
      const kind = kindOf(ent.name);
      if(!kind) continue;                                  // 只收媒体与字幕，别的扩展名不进播放器
      let size = 0, mtime = 0;
      try{ const st = await fsp.stat(full); size = st.size; mtime = st.mtimeMs; }catch(e){ continue; }
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      out.push({
        id: rel,
        name: ent.name,
        /* folder 是「剧集分组」的依据：同一子目录下的文件归为一部，
         * 根目录下的文件 folder 为空串（散文件）。 */
        folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
        kind,
        ext: extOf(ent.name),
        mime: mimeOf(ent.name),
        size,
        sizeMB: Math.round(size / 1048576 * 10) / 10,
        mtime,
        playable: kind === 'video' ? PLAYABLE_EXT.has(extOf(ent.name)) : kind !== 'video'
      });
    }
  }

  /* 列表：磁盘是唯一真相，没有索引文件，所以不存在「索引和实际对不上」的问题。 */
  async function list(){
    await ensure();
    const files = [];
    await walk(ROOT, 0, files);
    files.sort((a, b) => naturalCmp(a.folder, b.folder) || naturalCmp(a.name, b.name));
    const folders = {};
    for(const f of files){
      const key = f.folder || '';
      if(!folders[key]) folders[key] = { name: key || '散文件', count: 0, bytes: 0 };
      folders[key].count++;
      folders[key].bytes += f.size;
    }
    let total = 0;
    for(const f of files) total += f.size;
    return {
      ok: true,
      root: ROOT,
      files,
      folders: Object.values(folders),
      total,
      totalMB: Math.round(total / 1048576 * 10) / 10
    };
  }

  /* 把一批磁盘文件拷进媒体库。子目录结构按 sourceDir 下的相对路径保留。 */
  async function importFiles(paths, opts){
    await ensure();
    const o = opts || {};
    const into = o.into ? safeRel(o.into).replace(/[^/]+$/, '') : '';
    const out = [];
    const errs = [];
    for(const src of (Array.isArray(paths) ? paths : [])){
      const p = String(src || '');
      if(!p) continue;
      const kind = kindOf(p);
      if(!kind){ errs.push(p + '：不是媒体文件'); continue; }
      try{
        let relName = safeBaseName(p);
        /* 从文件夹批量导入时，把相对层级带上，播放列表才会按剧分好组。
         * baseDir 由调用方给（选文件夹时就是那个文件夹）。 */
        if(o.baseDir){
          const relRaw = path.relative(o.baseDir, p);
          if(relRaw && !relRaw.startsWith('..')){
            const relDir = path.dirname(relRaw);
            if(relDir && relDir !== '.'){
              const segs = relDir.split(/[\\/]+/).filter(s => s && s !== '.' && s !== '..').map(s => s.replace(/[:*?"<>|]+/g, '_'));
              relName = segs.join('/') + '/' + safeBaseName(p);
            }
          }
        }
        const relDir = path.posix.dirname(relName);
        const targetDir = path.join(ROOT, into || '', relDir === '.' ? '' : relDir);
        await fsp.mkdir(targetDir, { recursive: true });
        const base = path.posix.basename(relName);
        const finalName = await uniqueIn(targetDir, base);
        const dest = path.join(targetDir, finalName);
        await fsp.copyFile(p, dest);
        const st = await fsp.stat(dest);
        out.push({
          id: path.relative(ROOT, dest).split(path.sep).join('/'),
          name: finalName,
          size: st.size,
          kind,
          ext: extOf(finalName)
        });
      }catch(e){
        errs.push(p + '：' + ((e && e.message) || e));
      }
    }
    return { ok: out.length > 0 || errs.length === 0, files: out, errors: errs, count: out.length };
  }

  /* 从 URL 下载。走 ollama-download 的通用下载器（多源择优、断点续传、取消），
   * 不自己手搓 stream —— 那套重试与 sidecar 逻辑已经踩过一遍坑了。 */
  async function download(req, opts){
    await ensure();
    const r = req || {};
    const o = opts || {};
    const url = String(r.url || '').trim();
    if(!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 直链');
    /* 文件名优先用调用方给的（页面上的标题通常比 URL 末尾好读），
     * 其次从 URL 路径取，最后退回时间戳。 */
    let guess = r.name;
    if(!guess){
      try{
        const u = new URL(url);
        guess = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      }catch(e){ guess = ''; }
    }
    const ext = extOf(guess) || '';
    if(ext && !ALL_EXT[ext]) throw new Error('这个链接看起来不是媒体文件（.' + ext + '）');
    const base = safeBaseName(guess || ('media-' + Date.now().toString(36)), 'mp4');
    const into = r.into ? safeRel(r.into) : '';
    const targetDir = into ? path.join(ROOT, into) : ROOT;
    await fsp.mkdir(targetDir, { recursive: true });
    const finalName = await uniqueIn(targetDir, base);
    const dest = path.join(targetDir, finalName);
    if(!dl || typeof dl.download !== 'function') throw new Error('下载器不可用');

    const jobId = String(r.jobId || (Date.now().toString(36) + crypto.randomBytes(3).toString('hex')));
    jobs.set(jobId, { cancelled: false });
    const isCancelled = () => !!(jobs.get(jobId) && jobs.get(jobId).cancelled);
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
    try{
      const res = await dl.download({
        dest,
        sources: [{ url }],
        httpGet: o.httpGet || dl.nodeHttpGet,
        expectPE: false,
        canResume: true,
        onProgress: p => onProgress(Object.assign({ jobId, id: finalName }, p || {})),
        onLog: typeof o.onLog === 'function' ? o.onLog : () => {},
        isCancelled
      });
      if(res && res.cancelled){
        const e = new Error('已取消');
        e.cancelled = true;
        throw e;
      }
      const st = await fsp.stat(dest).catch(() => null);
      return {
        ok: true,
        jobId,
        id: path.relative(ROOT, dest).split(path.sep).join('/'),
        name: finalName,
        size: st ? st.size : 0,
        kind: kindOf(finalName),
        ext: extOf(finalName)
      };
    }catch(e){
      /* 失败或取消都把半成品删掉：留着会让列表里多一个点不开的条目，
       * 用户下次还得自己找是谁留下的。 */
      try{ await fsp.rm(dest, { force: true }); }catch(_){}
      try{ await fsp.rm(dest + '.part.json', { force: true }); }catch(_){}
      throw e;
    }finally{
      jobs.delete(jobId);
    }
  }

  function cancel(jobId){
    const j = jobs.get(String(jobId || ''));
    if(j) j.cancelled = true;
    return { ok: !!j };
  }

  async function remove(ids){
    const list = Array.isArray(ids) ? ids : [ids];
    const gone = [];
    for(const id of list){
      try{
        const abs = absOf(id);
        await fsp.rm(abs, { force: true });
        gone.push(id);
        /* 顺手把变空的目录收掉：不然删完一整季会剩一串空文件夹，
         * 列表里还挂着「某番剧 0 集」。 */
        let dir = path.dirname(abs);
        while(dir && dir !== ROOT && dir.startsWith(ROOT)){
          try{
            const left = await fsp.readdir(dir);
            if(left.length) break;
            await fsp.rmdir(dir);
            dir = path.dirname(dir);
          }catch(e){ break; }
        }
      }catch(e){}
    }
    return { ok: true, removed: gone };
  }

  async function stat(){
    try{
      const l = await list();
      return { ok: true, root: ROOT, count: l.files.length, bytes: l.total };
    }catch(e){
      return { ok: false, root: ROOT, count: 0, bytes: 0, message: String((e && e.message) || e) };
    }
  }

  /* 协议处理器专用：返回 {abs, size, mime, isMedia}，不做任何缓存假设。
   * 每次播放都 stat 一次——用户在外部删了文件要立刻表现为 404，而不是拿一条死路径硬播。 */
  async function open(id){
    const abs = absOf(id);
    const st = await fsp.stat(abs);
    if(!st.isFile()) throw new Error('不是文件：' + id);
    return { abs, size: st.size, mime: mimeOf(abs), kind: kindOf(abs) };
  }

  return { root: ROOT, ensure, list, importFiles, download, cancel, remove, stat, open, absOf };
}

module.exports = {
  createMediaStore,
  safeRel, safeBaseName, extOf, mimeOf, kindOf, naturalCmp,
  VIDEO_MIME, AUDIO_MIME, IMAGE_MIME, PLAYABLE_EXT, MAX_FILES
};
