/* 大块数据外置存储
 * localStorage 只有 ~5MB，而工作流里的图片 / 模型是 base64 data URL，
 * 一张照片就能吃掉大半配额 —— 这就是「保存失败：本地存储空间不足」的根因。
 *
 * 做法：写盘时把超过阈值的长字符串搬到 IndexedDB（配额几百 MB），
 * localStorage 里只留一个存根 'blob:<id>'；读回时用内存缓存还原。
 * IndexedDB 不可用（个别浏览器对 file:// 的限制）时自动退回内联，
 * 绝不在外置没成功的情况下把数据换成存根 —— 宁可占满，不能丢数据。
 */
const BLOB_MIN = 40 * 1024;        // 超过这个长度的字符串才外置
const BLOB_STUB = 'blob:';
const BLOB_DB = 'openagi';
const BLOB_STORE_NAME = 'blobs';

const BLOB_CACHE = new Map();      // id -> 原文，同步可读（解析存根不依赖异步）
const BLOB_UNSAVED = new Set();    // 已外置但还没确认落库的 id（用于回补）
let _db = null;
let _opening = null;
let _broken = false;               // IndexedDB 不可用
let _loaded = false;
let _loadP = null;

/* 用内容本身做 id（内容寻址）：同一张图多次保存不会产生新副本，
 * 也就不会每次保存都往 IndexedDB 里堆一份垃圾。 */
function fnv1a(s, seed){
  let h = seed >>> 0;
  for(let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
const _hashCache = new Map();
function blobIdFor(s){
  const k = s.length + '|' + s.slice(0, 96) + '|' + s.slice(-96);
  const hit = _hashCache.get(k);
  if(hit) return hit;
  const id = 'b' + s.length.toString(36) + '_' + fnv1a(s, 2166136261).toString(36) + fnv1a(s, 84696351).toString(36);
  _hashCache.set(k, id);
  return id;
}

function blobOpen(){
  if(_db) return Promise.resolve(_db);
  if(_broken || typeof indexedDB === 'undefined') return Promise.resolve(null);
  if(_opening) return _opening;
  _opening = new Promise(res => {
    let q;
    try { q = indexedDB.open(BLOB_DB, 1); } catch(e){ _broken = true; res(null); return; }
    q.onupgradeneeded = () => { try { q.result.createObjectStore(BLOB_STORE_NAME); } catch(e){} };
    q.onsuccess = () => { _db = q.result; res(_db); };
    q.onerror = () => { _broken = true; res(null); };
    q.onblocked = () => { _broken = true; res(null); };
  });
  return _opening;
}

function blobTx(mode, fn){
  return blobOpen().then(db => {
    if(!db) return false;
    return new Promise(res => {
      let t;
      try { t = db.transaction(BLOB_STORE_NAME, mode); } catch(e){ res(false); return; }
      let out;
      try { out = fn(t.objectStore(BLOB_STORE_NAME)); } catch(e){ res(false); return; }
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
      t.onabort = () => res(false);
      return out;
    });
  }).catch(() => false);
}

/* 桌面端把大块数据写到磁盘资产库：图库能看到、能导出、不受 IndexedDB 配额限制。
 * 网页版没有这条通道，继续走 IndexedDB——两条路都要通，不能因为换了后端就丢图。 */
function deskAssets(){
  const d = (typeof window !== 'undefined') ? window.openagiDesktop : null;
  return (d && typeof d.assetPut === 'function' && typeof d.assetList === 'function') ? d : null;
}
function blobKindOf(val){
  if(/^data:image\//.test(val)) return 'image';
  if(/^data:(model\/|application\/(octet-stream|x-))/i.test(val)) return 'model';
  return 'blob';
}

function blobPutIdb(id, val){
  return blobTx('readwrite', s => s.put(val, id)).then(ok => {
    if(ok) BLOB_UNSAVED.delete(id);
    else { _broken = true; blobRepairSoon(); }
    return ok;
  });
}

function blobPut(id, val){
  BLOB_CACHE.set(id, val);          // 先落缓存：本会话内解析一定可用
  BLOB_UNSAVED.add(id);
  const d = deskAssets();
  if(!d) return blobPutIdb(id, val);
  /* 磁盘优先。写盘失败（无权限 / 资产库损坏）时回退 IndexedDB，
   * 宁可两处都存一份，也不能因为换了存储后端把图弄丢。 */
  return d.assetPut({ id, kind: blobKindOf(val), data: val, source: 'workflow' })
    .then(r => {
      if(r && r.ok){ BLOB_UNSAVED.delete(id); return true; }
      return blobPutIdb(id, val);
    })
    .catch(() => blobPutIdb(id, val));
}

function blobDel(id){
  BLOB_CACHE.delete(id);
  BLOB_UNSAVED.delete(id);
  return blobTx('readwrite', s => s.delete(id));
}

function blobLoadAllIdb(){
  return blobOpen().then(db => {
    if(!db) return 0;
    return new Promise(res => {
      let t;
      try{ t = db.transaction(BLOB_STORE_NAME, 'readonly'); }catch(e){ res(0); return; }
      let req;
      try{ req = t.objectStore(BLOB_STORE_NAME).openCursor(); }catch(e){ res(0); return; }
      let n = 0;
      req.onsuccess = () => {
        const c = req.result;
        if(!c){ res(n); return; }
        if(typeof c.value === 'string'){ BLOB_CACHE.set(String(c.key), c.value); n++; }
        try{ c.continue(); }catch(e){ res(n); }
      };
      req.onerror = () => res(n);
    });
  }).catch(() => 0);
}

/* 从磁盘资产库读回「流程真的引用到」的那些 id。
 * 不能全量读：图库里可能躺着几百张图，逐个读成 dataURL 会吃掉几百 MB 内存，
 * 而启动时真正需要的只有当前流程用到的几张。 */
function blobLoadFromDisk(){
  const d = deskAssets();
  if(!d) return Promise.resolve(0);
  const want = new Set();
  try{ if(typeof FLOWS !== 'undefined' && FLOWS) blobCollectIds(FLOWS, want, new WeakSet()); }catch(e){}
  try{ if(typeof bp !== 'undefined' && bp) blobCollectIds(bp, want, new WeakSet()); }catch(e){}
  if(!want.size) return Promise.resolve(0);
  let n = 0;
  return Promise.all(Array.from(want).map(id => {
    if(BLOB_CACHE.has(id)) return null;
    return d.assetRead(id).then(r => {
      if(r && r.ok && r.dataURL){ BLOB_CACHE.set(id, r.dataURL); n++; }
      return null;
    }).catch(() => null);
  })).then(() => n);
}

function blobLoadAll(){
  return blobLoadFromDisk().then(() => blobLoadAllIdb());
}

/* 全量载入一次；之后解析存根就是同步的 */
function blobEnsure(){
  if(_loaded) return Promise.resolve(true);
  if(!_loadP) _loadP = blobLoadAll().then(() => { _loaded = true; return true; });
  return _loadP;
}

/* ---- 存根的写入 / 解析 ---- */

// 同步：长字符串换成存根并返回；不可外置时原样返回
function blobPack(s){
  if(typeof s !== 'string' || s.length < BLOB_MIN) return s;
  if(_broken) return s;
  const id = blobIdFor(s);
  if(!BLOB_CACHE.has(id)) blobPut(id, s);   // 本次会话已有（刚从库里读回）就不必重写
  return BLOB_STUB + id;
}

function blobIsStub(v){
  return typeof v === 'string' && v.indexOf(BLOB_STUB) === 0;
}

// 深拷贝 + 外置，返回一份可安全序列化的副本（原对象不动）
function blobPackFlows(flows){
  const seen = new WeakMap();
  const walk = v => {
    if(typeof v === 'string') return blobPack(v);
    if(Array.isArray(v)) return v.map(walk);
    if(v && typeof v === 'object'){
      if(seen.has(v)) return v;
      const o = {};
      seen.set(v, o);
      Object.keys(v).forEach(k => { o[k] = walk(v[k]); });
      return o;
    }
    return v;
  };
  return walk(flows);
}

// 原地解析存根（FLOWS 是活对象，直接改）
function blobResolve(v, guard){
  if(typeof v === 'string'){
    if(!blobIsStub(v)) return v;
    const id = v.slice(BLOB_STUB.length);
    const val = BLOB_CACHE.get(id);
    return typeof val === 'string' ? val : v;
  }
  if(Array.isArray(v)){
    if(guard.has(v)) return v;
    guard.add(v);
    for(let i = 0; i < v.length; i++) v[i] = blobResolve(v[i], guard);
    return v;
  }
  if(v && typeof v === 'object'){
    if(guard.has(v)) return v;
    guard.add(v);
    Object.keys(v).forEach(k => { v[k] = blobResolve(v[k], guard); });
    return v;
  }
  return v;
}

function blobResolveFlows(list){
  const guard = new WeakSet();
  (Array.isArray(list) ? list : []).forEach(f => blobResolve(f, guard));
}

function blobResolveFlowsAsync(list){
  return blobEnsure().then(() => { blobResolveFlows(list); return true; });
}

// 统计还有多少存根没解析出来（用于判断是否需要等载入完成）
function blobMissing(list){
  let n = 0;
  const seen = new WeakSet();
  const walk = v => {
    if(typeof v === 'string'){ if(blobIsStub(v) && !BLOB_CACHE.has(v.slice(BLOB_STUB.length))) n++; return; }
    if(!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    Object.keys(v).forEach(k => walk(v[k]));
  };
  walk(list);
  return n;
}

function blobCollectIds(v, out, guard){
  if(typeof v === 'string'){ if(blobIsStub(v)) out.add(v.slice(BLOB_STUB.length)); return; }
  if(!v || typeof v !== 'object') return;
  if(guard.has(v)) return;
  guard.add(v);
  Object.keys(v).forEach(k => blobCollectIds(v[k], out, guard));
}

/* ---- 垃圾回收：删掉工作流后，它引用的大块数据也该清掉 ---- */
let _gcBusy = false;
async function blobGC(root){
  if(_gcBusy || _broken) return 0;
  _gcBusy = true;
  try{
    const keep = new Set();
    blobCollectIds(root, keep, new WeakSet());
    BLOB_UNSAVED.forEach(id => keep.add(id));    // 还没落库的绝不能当垃圾清掉
    const db = await blobOpen();
    if(!db) return 0;
    const keys = await new Promise(res => {
      try{
        const t = db.transaction(BLOB_STORE_NAME, 'readonly');
        const r = t.objectStore(BLOB_STORE_NAME).getAllKeys();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => res([]);
      }catch(e){ res([]); }
    });
    let removed = 0;
    for(const k of keys){
      const id = String(k);
      if(keep.has(id)) continue;
      removed++;
      await blobDel(id);
    }
    return removed;
  } finally {
    _gcBusy = false;
  }
}

/* ---- 兜底：外置失败（IndexedDB 不可用）时把存根换回原文，重新内联保存 ---- */
let _repairTimer = null;
function blobRepairSoon(){
  if(_repairTimer) return;
  _repairTimer = setTimeout(() => {
    _repairTimer = null;
    blobRepair();
  }, 300);
}
function blobRepair(){
  if(!BLOB_UNSAVED.size) return 0;
  let n = 0;
  const guard = new WeakSet();
  const walk = v => {
    if(typeof v === 'string'){
      if(!blobIsStub(v)) return v;
      const id = v.slice(BLOB_STUB.length);
      if(!BLOB_UNSAVED.has(id)) return v;
      const val = BLOB_CACHE.get(id);
      if(typeof val !== 'string') return v;
      n++;
      return val;
    }
    if(Array.isArray(v)){
      if(guard.has(v)) return v;
      guard.add(v);
      for(let i = 0; i < v.length; i++) v[i] = walk(v[i]);
      return v;
    }
    if(v && typeof v === 'object'){
      if(guard.has(v)) return v;
      guard.add(v);
      Object.keys(v).forEach(k => { v[k] = walk(v[k]); });
      return v;
    }
    return v;
  };
  const roots = [];
  if(typeof FLOWS !== 'undefined' && Array.isArray(FLOWS)) roots.push(FLOWS);
  if(typeof bp !== 'undefined' && bp) roots.push(bp);
  roots.forEach(r => walk(r));
  BLOB_UNSAVED.clear();
  if(n){
    try { if(typeof bpToast === 'function') bpToast('大块数据未能写入 IndexedDB，已改回内联保存（可能更容易占满存储）'); } catch(e){}
    try { if(typeof persistFlows === 'function') persistFlows(); } catch(e){}
  }
  return n;
}

/* 启动：先把库里的大块数据读进缓存，再解析已有工作流的存根并刷新界面 */
function blobInit(){
  return blobEnsure().then(() => {
    let n = 0;
    try { if(typeof FLOWS !== 'undefined' && Array.isArray(FLOWS)){ blobResolveFlows(FLOWS); n = 1; } } catch(e){}
    try { if(typeof bp !== 'undefined' && bp) blobResolveFlows([bp]); } catch(e){}
    try { if(n && typeof renderFlowsWindow === 'function') renderFlowsWindow(); } catch(e){}
    try { if(n && typeof renderNodes === 'function' && typeof bp !== 'undefined' && bp) renderNodes(); } catch(e){}
    return true;
  });
}

// 排障 / 测试钩子：人为关闭外置，验证「IndexedDB 不可用」的退化路径
function blobDisable(){ _broken = true; }
// 排障钩子：清空缓存并强制重新从库里载入（模拟刚打开页面、数据还没进内存）
function blobReload(){ BLOB_CACHE.clear(); _loaded = false; _loadP = null; return blobEnsure(); }
function blobState(){
  return { broken: _broken, loaded: _loaded, cached: BLOB_CACHE.size, unsaved: BLOB_UNSAVED.size };
}
