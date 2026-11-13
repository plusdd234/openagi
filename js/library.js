/* 图库 / 模型库（参考 UE 的 Content Browser）
 *
 * 两个 app 共用一份实现，差别只在 kind：
 *   图库   → image（生成图、参考图、四视图）
 *   模型库 → model（glb / gltf / obj 等 3D 资产）
 *
 * 为什么要有它：
 *   资产原本以 base64 躺在 localStorage / IndexedDB 里——看不见总量、导不出来、
 *   删之前也不知道有没有被流程用着。UE 的 Content Browser 把这三件事做成了常识：
 *   **一个网格看全、每项带体积、删之前能看到引用**。
 *
 * 三条不能省的设计：
 *   ① 引用关系是**现扫流程算出来的**，不存索引。存一份必然和真相对不上
 *      （删节点、撤销、导入备份都会改引用，索引不会）。
 *   ② 缩略图**懒加载**：一次读几百张 dataURL 会把内存和 IPC 一起打爆。
 *   ③ 删除只进回收站，且**引用不为零时必须先警告**——资产是用户的产出，误删没法重来。
 */
const LIB_KINDS = {
  image: {
    title: '图库',
    sub: '生成图 · 参考图 · 四视图',
    glyph: 'gallery',
    emptyTitle: '图库还是空的',
    empty: '还没有图片。在工作流里跑一次生成，或用「导入」把本机的图片收进来。',
    refOf: id => 'blob:' + id
  },
  model: {
    title: '模型库',
    sub: 'glb · gltf · obj · fbx 等 3D 资产',
    glyph: 'modelLib',
    emptyTitle: '还没有 3D 资产',
    empty: '还没有 3D 资产。用「导入」把 glb / obj 收进来——收进库之后就能导出、能看到体积。',
    refOf: () => null
  }
};

const libState = {
  kind: 'image',
  assets: [],
  stat: null,
  refs: {},          // id -> 引用它的流程数
  refWhere: {},      // id -> [流程名]
  q: '',
  sort: 'new',       // new | big | name
  sortDir: 'desc',   // asc | desc —— 点排序方向按钮切换
  dense: (function(){
    try{
      const v = localStorage.getItem('hf_lib_dense');
      if(v === 's' || v === 'm' || v === 'l') return v;
    }catch(e){}
    return 'm';
  })(),
  sel: new Set(),
  busy: '',
  error: '',
  note: '',
  ready: false
};

function libEsc(s){
  if(typeof mcEsc === 'function') return mcEsc(s);
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function libDesk(){
  const d = window.openagiDesktop;
  return (d && typeof d.assetList === 'function') ? d : null;
}
function libFmt(b){
  const n = Number(b) || 0;
  if(n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if(n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}
function libFmtTime(ms){
  if(!ms) return '';
  const d = new Date(ms);
  const p = n => (n < 10 ? '0' : '') + n;
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 扫当前所有流程，数出每个资产被几个流程引用。
 * 用 JSON 整体扫而不是遍历节点字段：资产 id 可能出现在任何节点类型里，
 * 遍历字段就得为每种节点维护一份「哪个参数能放图」的名单，迟早漏。 */
function libScanRefs(){
  const counts = {}, where = {};
  const flows = [];
  try{ if(typeof FLOWS !== 'undefined' && Array.isArray(FLOWS)) FLOWS.forEach(f => flows.push(f)); }catch(e){}
  try{ if(typeof bp !== 'undefined' && bp && bp.id && !flows.some(f => f && f.id === bp.id)) flows.push(bp); }catch(e){}

  flows.forEach(f => {
    let text = '';
    try{ text = JSON.stringify(f); }catch(e){ return; }
    const seen = new Set();
    /* 存根 id 由 blobIdFor 生成，形如 b<len36>_<hash36><hash36>：b 开头、含下划线、
     * 只有小写字母数字。这个形状很重要——`blob:http://...`（浏览器给 Blob 的 URL）
     * 也以 blob: 开头，不限定形状就会把它当成资产 id 统计进去。 */
    text.replace(/blob:(b[0-9a-z]+_[0-9a-z]+)/g, (m, id) => { seen.add(id); return m; });
    seen.forEach(id => {
      counts[id] = (counts[id] || 0) + 1;
      (where[id] = where[id] || []).push((f && f.name) || '未命名流程');
    });
  });
  return { counts, where };
}

async function libRefresh(showBusy){
  const d = libDesk();
  if(!d){
    libState.ready = true;
    libState.busy = '';
    libState.error = '需通过桌面版打开：资产要落到本机磁盘上，网页版做不到';
    libPaint();          // 少了这句，界面上什么都不会显示，用户只看到一片空白
    return;
  }
  if(showBusy){ libState.busy = '读取中'; libPaint(); }
  try{
    const [l, s] = await Promise.all([d.assetList(), d.assetStat()]);
    const kind = libState.kind;
    libState.assets = (l && l.assets || []).filter(a => a.kind === kind);
    libState.stat = s || null;
    const r = libScanRefs();
    libState.refs = r.counts;
    libState.refWhere = r.where;
    libState.error = '';
  }catch(e){
    libState.error = '读取失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    libState.ready = true;
    libPaint();
  }
}

/* ---------- 动作 ---------- */
async function libImport(){
  const d = libDesk();
  if(!d || libState.busy) return;
  libState.busy = '导入中';
  libState.note = '';
  libState.error = '';
  libPaint();
  try{
    const r = await d.assetImport();
    if(r && r.cancelled){ libState.note = ''; return; }
    if(!r || !r.ok) throw new Error((r && r.message) || '导入失败');
    const n = (r.imported || []).length;
    libState.note = n ? ('已导入 ' + n + ' 个资产') : '没有可导入的文件';
    if(r.failed && r.failed.length) libState.error = r.failed.length + ' 个文件导入失败：' + r.failed[0].error;
  }catch(e){
    libState.error = '导入失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    await libRefresh();
  }
}

async function libRemoveSelected(){
  const d = libDesk();
  if(!d || !libState.sel.size) return;
  const ids = Array.from(libState.sel);
  const used = ids.filter(id => (libState.refs[id] || 0) > 0);
  let msg = '把选中的 ' + ids.length + ' 个资产移到回收站？';
  if(used.length){
    /* 引用不为零时必须说清后果，而且要点名是哪个流程——
     * 只说「2 个流程在用」用户没法去处理，得告诉他是哪两个，他才能先去把图换掉。 */
    const names = used.slice(0, 3).map(id => {
      const a = libState.assets.find(x => x.id === id);
      const who = (libState.refWhere[id] || []).slice(0, 2).join('、');
      const more = (libState.refWhere[id] || []).length > 2 ? ' 等' : '';
      return '· ' + (a ? a.name : id) + '（' + libState.refs[id] + ' 个流程在用' +
        (who ? '：' + who + more : '') + '）';
    });
    msg = '注意：有 ' + used.length + ' 个资产正被流程引用——\n' + names.join('\n') +
      '\n\n删掉后那些流程里会变成打不开的图。确认删除？';
  }
  if(!confirm(msg)) return;
  libState.busy = '删除中';
  libPaint();
  try{
    const r = await d.assetRemove(ids);
    if(!r || !r.ok) throw new Error((r && r.message) || '删除失败');
    libState.sel.clear();
    libState.note = '已移到回收站（' + (r.moved || []).length + ' 个），需要的话还能捞回来';
    if(r.failed && r.failed.length) libState.error = r.failed.length + ' 个删除失败';
  }catch(e){
    libState.error = '删除失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    await libRefresh();
  }
}

async function libExportSelected(){
  const d = libDesk();
  if(!d || !libState.sel.size) return;
  libState.busy = '导出中';
  libPaint();
  try{
    const r = await d.assetExport(Array.from(libState.sel));
    if(r && r.cancelled) return;
    if(r && r.ok) libState.note = '已导出 ' + (r.files || []).length + ' 个文件到 ' + r.dir;
  }catch(e){
    libState.error = '导出失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    libPaint();
  }
}

async function libReconcile(){
  const d = libDesk();
  if(!d) return;
  libState.busy = '核对中';
  libPaint();
  try{
    const r = await d.assetReconcile();
    const added = (r && r.added || []).length;
    const dropped = (r && r.dropped || []).length;
    libState.note = added || dropped
      ? ('核对完成：补回 ' + added + ' 个、清理 ' + dropped + ' 条失效记录')
      : '核对完成：磁盘和索引一致';
  }catch(e){
    libState.error = '核对失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    await libRefresh();
  }
}

async function libEmptyTrash(){
  const d = libDesk();
  if(!d) return;
  const st = libState.stat || {};
  if(!st.trashBytes){ libState.note = '回收站是空的'; libPaint(); return; }
  if(!confirm('彻底清空回收站？\n\n将永久删除 ' + libFmt(st.trashBytes) + '（' + (st.trashCount || 0) + ' 个文件），不可恢复。')) return;
  libState.busy = '清理中';
  libPaint();
  try{
    await d.assetEmptyTrash();
    libState.note = '回收站已清空';
  }catch(e){
    libState.error = '清空失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    await libRefresh();
  }
}

function libToggleSel(id, on){
  if(on) libState.sel.add(id); else libState.sel.delete(id);
  libSyncSelectionUI();
}

/* 只更新选中态的 UI（卡片 .on、复选框、垃圾桶、工具栏按钮可用态），不重建 DOM。
 * ⚠ 垃圾桶不能放进 libBody 的流里：框选过程中「第一次选中 → 垃圾桶插入 →
 * 网格整体下移」，卡片会在手底下跳走，框选直接废掉。它挂在窗口本体上绝对定位。 */
function libSyncSelectionUI(){
  const box = $('libBody');
  if(!box) return;
  box.querySelectorAll('.lib-card').forEach(c => {
    const on = libState.sel.has(c.dataset.libId);
    if(c.classList.contains('on') !== on) c.classList.toggle('on', on);
    const cb = c.querySelector('.lib-check input');
    if(cb && cb.checked !== on) cb.checked = on;
  });
  const selN = libState.sel.size;
  /* 选中数变了，「重命名 / 设为壁纸」要跟着变可用态。
   * 必须放在这里而不是只在 libPaint 末尾：点选/框选只走 libSyncSelectionUI，
   * 不重建 DOM —— 否则工具栏按钮永远停在「打开时没人选中」的禁用态，
   * 用户选好图再点「设为壁纸」毫无反应，看起来就是功能坏了。 */
  const rBtn = box.querySelector('[data-lib-act="rename"]');
  if(rBtn) rBtn.disabled = !selN;
  const wBtn = box.querySelector('[data-lib-act="wall"]');
  if(wBtn) wBtn.disabled = !(selN === 1 && libWallApplicable('image'));
}

function libSetSel(ids){
  libState.sel = new Set(ids);
  libSyncSelectionUI();
}

/* Ctrl+A：只选「当前筛选/搜索后真正看得见」的那些，符合文件管理器直觉 */
function libSelectAllVisible(){
  libSetSel(libVisible().map(a => a.id));
}

/* Shift+点击：在「可见列表」里从锚点选到目标，和文件管理器一致 */
function libSelectRange(anchorId, targetId){
  const ids = libVisible().map(a => a.id);
  const a = ids.indexOf(anchorId), b = ids.indexOf(targetId);
  if(a < 0 || b < 0){ libSetSel([targetId]); return; }
  const [s, e] = a < b ? [a, b] : [b, a];
  libSetSel(ids.slice(s, e + 1));
}

/* ---------- 点选 / 框选 / 拖拽到垃圾桶 ---------- */
let libGesture = null;
let libLastAnchor = null;
let libBodyBound = false;

/* 窗口级的收尾挂载（关窗时把内嵌的 3D 视口一起收掉） */
function libEnsureChrome(){
  const win = $('libWin');
  if(!win) return;
  /* 关库窗口时把内嵌的 3D 视口一起收掉：不然 WebGL 上下文和渲染循环会留在后台 */
  if(!win.dataset.libViewClose){
    win.dataset.libViewClose = '1';
    const btn = $('btnLibWinClose');
    if(btn) btn.addEventListener('click', () => {
      if(libMv.open) libMvClose();
    });
  }
}

function libCreateMarquee(){
  const el = document.createElement('div');
  el.className = 'lib-marquee';
  document.body.appendChild(el);
  libGesture.rectEl = el;
}
function libUpdateMarquee(e){
  const g = libGesture, el = g.rectEl;
  const x1 = Math.min(g.startX, e.clientX), y1 = Math.min(g.startY, e.clientY);
  const x2 = Math.max(g.startX, e.clientX), y2 = Math.max(g.startY, e.clientY);
  el.style.left = x1 + 'px'; el.style.top = y1 + 'px';
  el.style.width = (x2 - x1) + 'px'; el.style.height = (y2 - y1) + 'px';
}
function libApplyMarquee(){
  const g = libGesture, el = g.rectEl;
  const r = el.getBoundingClientRect();
  const ids = [];
  document.querySelectorAll('#libBody .lib-card').forEach(c => {
    const b = c.getBoundingClientRect();
    const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
    const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
    if(ix > 0 && iy > 0) ids.push(c.dataset.libId);
  });
  if(g.additive) libSetSel(Array.from(new Set([...g.base, ...ids])));
  else libSetSel(ids);
}

/* 唯一的清理出口：pointerup / pointercancel / 窗口失焦 / Esc 全走这里。
 * 幂等——重复调用无害；漏清理会让框选遮罩留在页面上。 */
function libGestureAbort(){
  window.removeEventListener('pointermove', libOnPointerMove);
  window.removeEventListener('pointerup', libOnPointerUp);
  window.removeEventListener('pointercancel', libOnPointerCancel);
  window.removeEventListener('blur', libGestureAbort);
  const body = $('libBody');
  if(body) body.classList.remove('lib-selecting');
  const g = libGesture;
  libGesture = null;
  if(!g) return;
  if(g.rectEl) g.rectEl.remove();
}

function libOnPointerUp(e){ libGestureAbort(); }
function libOnPointerCancel(){ libGestureAbort(); }

function libOnPointerDown(e){
  if(e.button !== 0) return;
  const body = $('libBody');
  if(!body || !body.contains(e.target)) return;
  // 这些区域有各自的交互，不能劫持
  if(e.target.closest('.lib-check')) return;
  if(e.target.closest('input, button, a, .lib-bar, .lib-head')) return;
  const card = e.target.closest('.lib-card');
  const grid = e.target.closest('.lib-grid');
  if(!grid) return;
  if(card){
    const id = card.dataset.libId;
    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    if(range && libLastAnchor) libSelectRange(libLastAnchor, id);
    else if(additive) libToggleSel(id, !libState.sel.has(id));
    else if(!libState.sel.has(id)) libSetSel([id]);
    libLastAnchor = id;
    /* 卡片上只处理点选：删除走右键菜单 / Del，不再支持拖拽 */
    return;
  }
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  if(!additive) libSetSel([]);
  libGesture = { mode: 'marquee', startX: e.clientX, startY: e.clientY, additive, base: new Set(libState.sel) };
  e.preventDefault();
  body.classList.add('lib-selecting');
  window.addEventListener('pointermove', libOnPointerMove);
  window.addEventListener('pointerup', libOnPointerUp);
  window.addEventListener('pointercancel', libOnPointerCancel);
  window.addEventListener('blur', libGestureAbort);
}

function libOnPointerMove(e){
  const g = libGesture;
  if(!g || g.mode !== 'marquee') return;
  if(!g.rectEl) libCreateMarquee();
  libUpdateMarquee(e);
  libApplyMarquee();
}

function libBindGestures(){
  const body = $('libBody');
  if(!body || libBodyBound) return;
  body.addEventListener('pointerdown', libOnPointerDown);
  // 原生拖拽（选中文字 / 图片）会打断指针手势，干脆禁掉
  body.addEventListener('dragstart', e => e.preventDefault());
  // Esc 随时中止进行中的框选/拖拽（和 blur、pointercancel 一样走统一清理出口）
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape'){
      if(libCtxEl){ libContextClose(); return; }
      if(libWallDrawerOpen){ libWallClose(); return; }
      if(libGesture){ libGestureAbort(); return; }
      if(libMv.open){ libMvClose(); return; }
      if(libState.sel.size){ libSetSel([]); return; }
      return;
    }
    /* 库窗口没在前台时别抢键：F2 / Delete 是全局快捷键，全应用只该有一处响应。
     * 判据用 offsetParent 而不是 hidden —— 库是 App 页的一种，隐藏方式不一定加 hidden 类。 */
    const win = $('libWin');
    if(!win || win.classList.contains('hidden') || !win.offsetParent) return;
    if(libGesture) return;
    /* 图片编辑器是浮动窗口，和图库可以同时可见；它在最前面时快捷键归它管，
     * 免得在编辑器里按 Ctrl+A 把背后的图库资产全选上。 */
    const ieWin = $('imgEditWin');
    if(ieWin && !ieWin.classList.contains('hidden') && ieWin.contains(document.activeElement)) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if((e.ctrlKey || e.metaKey) && !typing && (e.key === 'a' || e.key === 'A')){
      e.preventDefault();
      libSelectAllVisible();
      return;
    }
    if(e.key === 'Enter' && !typing){
      if(libState.sel.size === 1){
        e.preventDefault();
        libOpenAsset(Array.from(libState.sel)[0]);
      }
      return;
    }
    if(e.key === 'F2'){ e.preventDefault(); libRenameSelected(); return; }
    if((e.key === 'Delete' || e.key === 'Backspace') && libState.sel.size){
      /* 光标在输入框里时 Delete / Backspace 是「删字符」，不是「删资产」。
       * 以前只拦了 Backspace：在搜索框或改名框里按 Delete 会直接把选中的资产丢进回收站。 */
      if(typing) return;
      e.preventDefault();
      libRemoveSelected();
    }
  });
  libBodyBound = true;
}

/* ---------- 缩略图懒加载 ----------
 * 一张 2 MB 的 PNG 转成 dataURL 是 2.7 MB 字符串，几百张就是几百 MB。
 * 只给接近视口的卡片取图，滚过去的就不管了。 */
let libObserver = null;
const libThumbCache = new Map();

/* 图片被编辑器覆盖后必须让缓存失效，否则图库还显示改之前那张 */
function libForgetThumb(id){
  if(id) libThumbCache.delete(id);
}

function libEnsureObserver(){
  if(libObserver || typeof IntersectionObserver === 'undefined') return;
  libObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if(!en.isIntersecting) return;
      /* 观察的是整张卡片，缩略图要从卡片里找回来（容错：直接观察缩略图时也能用） */
      const el = en.target.classList && en.target.classList.contains('lib-thumb')
        ? en.target
        : en.target.querySelector('.lib-thumb');
      if(!el) return;
      /* 这里**不 unobserve**：卡片可能因为滚远被队列丢掉，
       * 留着观察才能等它再滚回来时重新报到。真拿到图后由队列统一 unobserve。 */
      libLoadThumb(el.dataset.libThumb, el);
    });
  }, { rootMargin: '240px' });
}

/* 3D 缩略图要排队渲染：观察者一次可能同时点着 6 张卡片，
 * 并发建 6 个 WebGL 上下文会直接把显卡驱动拖死（浏览器上下文上限通常 16 个）。 */
let libThumbQueue = Promise.resolve();
function libQueue(fn){
  libThumbQueue = libThumbQueue.then(fn, fn);
  return libThumbQueue;
}

/* ---------- 图片缩略图：先压小再进 DOM ----------
 * 直接把原图 dataURL 塞进 <img> 会卡：浏览器要为每张卡保留整幅解码位图
 * （一张 4000×3000 就是 48 MB），滚动时每帧都在缩放合成这些巨图 —— 卡片一多就掉帧。
 * 所以先把长边压到 480 再放进网格，滚动时只剩几十 KB 的小图。 */
const LIB_THUMB_PX = 480;
const LIB_THUMB_CACHE_MAX = 240;

/* ---------- 缩略图任务队列：按「离当前视口多远」排序 ----------
 * 观察者一次会把上下几屏的卡片都报进来。若按 DOM 顺序做，用户已经滑到底部，
 * 却还要等上面几屏的任务跑完 —— 表现就是「图总是从上往下加载」。
 * 所以每次取任务前重新量一遍位置：谁在眼前先做谁；已经滚远（超过两屏）的直接丢掉，
 * 等它重新滚进视口时观察者会再叫一次。 */
const libThumbJobs = [];
const libThumbPending = new WeakSet();
let libThumbActive = 0;
const LIB_THUMB_CONCURRENCY = 2;

function libThumbScroller(){
  const win = $('libWin');
  return (win && win.querySelector('.os-win-body')) || $('libBody');
}

/* 观察者盯的是整张卡片，缩略图只是卡片里的一块 */
function libThumbTarget(holder){
  return (holder && typeof holder.closest === 'function' && holder.closest('.lib-card')) || holder;
}

/* 卡片到可视区的距离：0 = 就在眼前，越大越靠后 */
function libThumbRank(holder){
  const sc = libThumbScroller();
  if(!sc || !holder || !holder.getBoundingClientRect) return 0;
  if(holder.isConnected === false) return Infinity;
  const v = sc.getBoundingClientRect();
  const r = holder.getBoundingClientRect();
  if(r.bottom < v.top) return v.top - r.bottom;
  if(r.top > v.bottom) return r.top - v.bottom;
  return 0;
}

function libThumbEnqueue(id, holder){
  /* 已经排过队就别重复排（观察者可能对同一张卡报多次） */
  if(libThumbPending.has(holder)) return Promise.resolve();
  libThumbPending.add(holder);
  const job = { id, holder };
  job.done = new Promise(resolve => { job.finish = resolve; });
  libThumbJobs.push(job);
  libThumbPump();
  return job.done;
}

function libThumbPump(){
  while(libThumbActive < LIB_THUMB_CONCURRENCY){
    const sc = libThumbScroller();
    const limit = sc ? Math.max(80, sc.clientHeight * 2) : Infinity;
    let best = -1, bestRank = Infinity;
    for(let i = 0; i < libThumbJobs.length; i++){
      const job = libThumbJobs[i];
      /* 卡片已经被重绘换掉：任务作废（isConnected 为 undefined 的假节点按在场处理） */
      if(job.holder && job.holder.isConnected === false){
        libThumbJobs.splice(i, 1); i--;
        libThumbPending.delete(job.holder);
        if(job.finish) job.finish();
        continue;
      }
      const rk = libThumbRank(job.holder);
      if(rk > limit){
        /* 已经滚远了：撤掉登记，等它再进视口时由观察者重新报一次 */
        libThumbPending.delete(job.holder);
        libThumbJobs.splice(i, 1); i--;
        if(job.finish) job.finish();
        continue;
      }
      if(rk < bestRank){ bestRank = rk; best = i; }
    }
    if(best < 0) return;
    const job = libThumbJobs.splice(best, 1)[0];
    libThumbActive++;
    Promise.resolve()
      .then(() => libThumbFetch(job.id, job.holder))
      .catch(() => {})
      .then(() => {
        libThumbActive--;
        if(job.finish) job.finish();
        libThumbPump();
      });
  }
}

/* 缓存只留最近用过的 N 张：几百张 dataURL 一直攥着不放，
 * 内存压力上来后 GC 会在滚动中途停顿，表现同样是「卡一下」。 */
function libThumbRemember(id, url){
  libThumbCache.delete(id);
  libThumbCache.set(id, url);
  while(libThumbCache.size > LIB_THUMB_CACHE_MAX){
    libThumbCache.delete(libThumbCache.keys().next().value);
  }
}

/* 解码 + 缩放必须离开主线程：`<img>` 解码本来就在解码线程上，
 * 但「解码完再 drawImage/toDataURL」会把十几毫秒压回主线程，滚动时正好赶上掉帧。
 * createImageBitmap 能带着缩放参数在工作线程完成解码，主线程只拿一张已经变小的位图。 */
async function libMakeThumb(url, maxPx){
  try{
    const blob = await (await fetch(url)).blob();
    let bmp = await createImageBitmap(blob);
    const nw = bmp.width, nh = bmp.height;
    const k = Math.min(1, maxPx / Math.max(nw, nh));
    if(k >= 1){
      if(bmp.close) bmp.close();
      return url;
    }
    const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if(bmp.close) bmp.close();
    let out = '';
    try{ out = cv.toDataURL('image/webp', 0.82); }catch(e){ out = ''; }
    return out && out.length < url.length ? out : url;
  }catch(e){
    return url;
  }
}

/* 只替换图片本身，不要整体重写 innerHTML ——
 * 3D 磁贴上还挂着「参考 / UV」两个快捷按钮，整块重写会把它们一起冲掉
 * （缩略图是异步回来，用户看到图的那一瞬间按钮就消失了）。 */
function libThumbPut(holder, url){
  if(!holder || holder.isConnected === false) return;
  const keep = holder.querySelector('.lib-thumb-acts');
  holder.innerHTML = '';
  const img = document.createElement('img');
  /* decoding:async —— 解码放在合成之外，滚动时不要卡在图片解码上 */
  img.alt = ''; img.src = url; img.draggable = false; img.decoding = 'async';
  holder.appendChild(img);
  if(keep) holder.appendChild(keep);
}

/* 观察者报到后先看缓存，有就立刻贴上；没有才进优先队列（返回的 Promise 在这张图就位后 resolve） */
function libLoadThumb(id, holder){
  if(!id || !holder) return Promise.resolve();
  const hit = libThumbCache.get(id);
  if(hit !== undefined){ libThumbRemember(id, hit); libThumbPut(holder, hit); return Promise.resolve(); }
  if(!libDesk()) return Promise.resolve();
  return libThumbEnqueue(id, holder);
}

async function libThumbFetch(id, holder){
  const d = libDesk();
  try{
    if(!d || !holder || holder.isConnected === false) return;
    const is3d = holder.dataset.libKind === 'model';
    /* 1) 先问主进程要缩略图：图片由主进程把原图缩到 480px 并存盘，3D 是之前渲染好存下的。
     *    两边都只回传几十 KB，渲染进程不用背原图。 */
    if(typeof d.assetThumb === 'function'){
      let t = null;
      try{ t = await d.assetThumb(id); }catch(e){ t = null; }
      if(t && t.ok && t.dataURL){
        libThumbRemember(id, t.dataURL);
        libThumbPut(holder, t.dataURL);
        return;
      }
    }
    const r = await d.assetRead(id);
    if(!r || !r.ok || !r.dataURL){
      if(holder.isConnected !== false) holder.innerHTML = '<span class="lib-miss">文件已丢失</span>';
      return;
    }
    if(!is3d){
      /* 主进程没有缩略图接口时的退路（网页版 / 老库）：读原图自己压小 */
      const small = await libMakeThumb(r.dataURL, LIB_THUMB_PX);
      libThumbRemember(id, small);
      libThumbPut(holder, small);
      return;
    }
    // 2) 3D：排队渲染
    if(typeof Model3D === 'undefined' || typeof Model3D.renderThumb !== 'function'){
      if(holder.isConnected !== false) holder.innerHTML = '<span class="lib-miss">3D 未就绪</span>';
      return;
    }
    await libQueue(async () => {
      const t = await Model3D.renderThumb(r.dataURL, { size: 256 });
      if(t && t.dataURL){
        libThumbRemember(id, t.dataURL);
        libThumbPut(holder, t.dataURL);
        // 存起来，下次开库直接读文件
        try{ if(typeof d.assetThumbSave === 'function') await d.assetThumbSave(id, t.dataURL); }catch(e){}
      }
    });
  }catch(e){
    if(holder.isConnected !== false) holder.innerHTML = '<span class="lib-miss">渲染失败</span>';
  }finally{
    /* 拿到图就够了，不再需要观察这张卡（重绘后的新节点会重新登记） */
    libThumbPending.delete(holder);
    if(libObserver) libObserver.unobserve(libThumbTarget(holder));
  }
}

/* ---------- UV 查看（并入 3D 查看器） ----------
 * UV 不再是独立浮层：打开模型后点视口底栏的「UV 查看」即可切过去，
 * 岛图 / 3D 岛图 / 插槽隔离 / 编号 / 分辨率 / 导出都在同一个深色视口里，
 * 与材质插槽面板共用一套界面语言。libUvOpen 只负责把资产读出来交给查看器。 */
async function libUvOpen(id){
  const asset = libState.assets.find(x => x.id === id);
  const d = libDesk();
  if(!asset || !d) return;
  let r;
  try{ r = await d.assetRead(id); }catch(e){ r = null; }
  if(!r || !r.ok || !r.dataURL){
    libState.error = '打不开「' + asset.name + '」：' + ((r && r.error) || '文件缺失');
    libPaint();
    return;
  }
  await libMvOpen(r.dataURL, asset.name, id, { uv: true });
}
function libUvClose(){
  if(libMv.open) libMvClose();
}

/* 卡片「参考」入口：打开 3D 视口，再把参考图抽屉拉出来。
 * ⚠ libOpenAsset 里的 libMvOpen 是「发出去不等」的（openPreview 要加载模型，很慢），
 *   所以这里不能 await 完就立刻调 openRefs——那时视口还没建好，refOpener 还是空。
 *   用 openRefs() 的返回值当信号轮询：拿到 true 就说明抽屉已经开了。 */
async function libRefOpen(id){
  await libOpenAsset(id);
  const t0 = Date.now();
  (function poke(){
    let done = false;
    try{ done = !!(window.Model3D && Model3D.openRefs && Model3D.openRefs()); }catch(e){ done = false; }
    if(done) return;
    if(Date.now() - t0 > 20000) return;     // 加载失败就别一直轮询
    setTimeout(poke, 150);
  })();
}

/* ---------- 3D 查看（app 内嵌，不再单开窗口） ----------
 * 双击模型时在库窗口里铺一层深色视口；渲染本体交给 Model3D.openPreview
 * （chrome:false），标题栏 / 关闭按钮归这里管。UV 查看是视口内的一种模式。 */
const libMv = { open: false, name: '', id: '', sub: '' };
const LIB_MV_SUB = {
  d3: '拖拽旋转 · 滚轮缩放 · 右键平移',
  uv: 'UV 岛图 · 3D 岛图 · 插槽隔离 · 编号'
};

/* 只改副标题，不重建面板——重建会把 #libMvHost 里的 3D 视口连根拔掉 */
function libMvSubText(t){
  const el = $('libMv');
  const s = el && el.querySelector('.lib-uv-sub');
  if(s) s.textContent = t;
}

function libMvEnsure(){
  const win = $('libWin');
  if(!win) return null;
  let el = $('libMv');
  if(!el){
    el = document.createElement('div');
    el.id = 'libMv';
    el.className = 'lib-mv hidden';
    win.appendChild(el);
  }
  return el;
}
function libMvRender(){
  const el = $('libMv');
  if(!el) return;
  el.classList.toggle('hidden', !libMv.open);
  if(!libMv.open){ el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="lib-uv-panel">' +
      '<div class="lib-uv-head">' +
        '<div class="lib-uv-headmain">' +
          '<span class="lib-uv-kicker">模型查看</span>' +
          '<b class="lib-uv-name" title="' + libEsc(libMv.name) + '">' + libEsc(libMv.name) + '</b>' +
          '<span class="lib-uv-sub">' + libEsc(libMv.sub || LIB_MV_SUB.d3) + '</span>' +
        '</div>' +
        '<div class="lib-uv-acts">' +
          '<button type="button" class="os-win-close" data-mv-act="close" aria-label="关闭 3D 查看" title="关闭">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="lib-mv-host" id="libMvHost"></div>' +
    '</div>';
  const x = el.querySelector('[data-mv-act="close"]');
  if(x) x.addEventListener('click', libMvClose);
}
async function libMvOpen(src, name, assetId, opts){
  if(typeof Model3D === 'undefined' || typeof Model3D.openPreview !== 'function'){
    libState.error = '3D 查看器未就绪';
    libPaint();
    return;
  }
  libMvEnsure();
  libMv.open = true;
  libMv.name = name || '3D 模型';
  libMv.id = assetId || '';
  libMv.sub = (opts && opts.uv) ? LIB_MV_SUB.uv : LIB_MV_SUB.d3;
  libMvRender();
  const host = $('libMvHost');
  try{
    /* assetId 是贴图持久化的钥匙：模型打开时按它回读上次设置的贴图；
     * opts.uv 让视口直接以 UV 模式打开（库里的「UV 查看」入口走这条路） */
    await Model3D.openPreview(src, {
      title: name, host: host, chrome: false, assetId: libMv.id,
      uv: !!(opts && opts.uv),
      /* 视口里切换 UV / 3D 时同步外层副标题 */
      onUvState: function(on){ libMvSubText(on ? LIB_MV_SUB.uv : LIB_MV_SUB.d3); }
    });
  }catch(e){
    // 加载失败时 openPreview 已经把原因写在视口提示里，这里只兜底不整体崩掉
    if(host && !host.children.length){
      host.innerHTML = '<div class="lib-mv-err">加载失败：' + libEsc((e && e.message) || e) + '</div>';
    }
  }
}
function libMvClose(){
  if(!libMv.open) return;
  libMv.open = false;
  libMv.name = '';
  libMv.id = '';
  libMv.sub = '';
  try{ if(typeof Model3D !== 'undefined') Model3D.closePreview(); }catch(e){}
  libMvRender();
}

/* 双击打开资产：3D 进查看器，图片进编辑器。
 * 这是 Content Browser 最核心的手感——资产不只是"能看到"，还得"能进去看"。 */
async function libOpenAsset(id){
  const a = libState.assets.find(x => x.id === id);
  if(!a) return;
  const d = libDesk();
  if(!d) return;
  libState.error = '';
  let r;
  try{ r = await d.assetRead(id); }
  catch(e){ r = null; }
  if(!r || !r.ok){
    libState.error = '打不开「' + a.name + '」：' + ((r && r.error) || '文件缺失');
    libPaint();
    return;
  }
  if(a.kind === 'model'){
    libMvOpen(r.dataURL, a.name, a.id);
    return;
  }
  if(typeof openImageEditor === 'function'){
    openImageEditor(id, a, r.dataURL);
  }else{
    libState.error = '图片编辑器未就绪';
    libPaint();
  }
}

/* ---------- 改名输入框（自绘，替掉 window.prompt）----------
 * ⚠ 不能用 window.prompt：Electron 渲染进程里 prompt 是**明确不支持的**实现，
 * 调用当场抛 "prompt() is not supported."（alert / confirm 都有，唯独 prompt 没有）。
 * 「右键 → 重命名点了没反应」就是这么来的：异常在弹框那一步就把链路打断了，
 * 连 error 都落不到 libState 上，所以界面上只表现为「无效」。
 * 这里只做一件事：单行输入 + 确定/取消，Enter 确定、Esc 或点遮罩取消。 */
let libAskEl = null;
let libAskDone = null;

function libAskClose(val){
  const done = libAskDone;
  libAskDone = null;
  if(libAskEl){
    if(libAskEl.parentNode) libAskEl.parentNode.removeChild(libAskEl);
    libAskEl = null;
  }
  if(done) done(val == null ? null : String(val));
}

function libAskName(opt){
  const o = opt || {};
  /* 挂窗口本体（#libWin）而不是 #libBody：#libBody 会被 libPaint 整块重写。
   * 定位用 CSS 的 position:absolute（不是 fixed）—— App 页祖先 #deskPageApps 带 transform
   * 会抢走 fixed 的包含块，遮罩会按整页排。详见 css 里 .lib-ask 的注释。 */
  const host = $('libWin') || document.body;
  libAskClose(null);            // 连按 F2 / 又点右键：把上一个当取消收掉，别叠两个框
  return new Promise(function(resolve){
    const el = document.createElement('div');
    el.className = 'lib-ask';
    el.innerHTML =
      '<div class="lib-ask-card" role="dialog" aria-modal="true">' +
        '<div class="lib-ask-title">' + libEsc(o.title || '重命名') + '</div>' +
        '<input class="lib-ask-input" type="text" spellcheck="false" autocomplete="off" value="' + libEsc(o.value || '') + '">' +
        '<div class="lib-ask-tip">' + libEsc(o.tip || 'Enter 确定 · Esc 取消') + '</div>' +
        '<div class="lib-ask-acts">' +
          '<button type="button" class="btn sm" data-ask="cancel">取消</button>' +
          '<button type="button" class="btn sm primary" data-ask="ok">确定</button>' +
        '</div>' +
      '</div>';
    host.appendChild(el);
    libAskEl = el;
    libAskDone = resolve;

    const inp = el.querySelector('.lib-ask-input');
    if(!inp){ libAskClose(null); return; }
    const cancel = el.querySelector('[data-ask="cancel"]');
    const ok = el.querySelector('[data-ask="ok"]');

    el.addEventListener('pointerdown', e => { if(e.target === el) libAskClose(null); });
    if(cancel) cancel.addEventListener('click', () => libAskClose(null));
    if(ok) ok.addEventListener('click', () => libAskClose(inp.value));
    el.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); libAskClose(inp.value); }
      else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); libAskClose(null); }
    });

    inp.focus();
    /* 单选时只选中基名、不选扩展名（和资源管理器一致）：
     * 「首屏海报.png」进来光标就在 .png 前面，直接打字就是新名字。 */
    const v = String(inp.value || '');
    const dot = o.selectBase ? v.lastIndexOf('.') : -1;
    try{ dot > 0 ? inp.setSelectionRange(0, dot) : inp.select(); }catch(err){}
  });
}

/* ---------- 重命名 ----------
 * 三种入口：F2、双击文件名、右键菜单（卡片名字上）。都走同一个 libRename()。 */
async function libRename(ids){
  const d = libDesk();
  if(!d || !ids || !ids.length) return;
  if(typeof d.assetRename !== 'function'){
    libState.error = '当前版本不支持改名（需要重启应用以加载新的桌面端接口）';
    libPaint();
    return;
  }
  const one = ids.length === 1 ? libState.assets.find(a => a.id === ids[0]) : null;
  const cur = one ? one.name : '';
  const name = await libAskName({
    title: one ? '重命名资产' : ('批量重命名 ' + ids.length + ' 个资产'),
    value: one ? cur : '新建名称',
    tip: one ? 'Enter 确定 · Esc 取消'
             : '填的是基名，重名会自动加 _2 _3 后缀 · Enter 确定 · Esc 取消',
    selectBase: !!one
  });
  if(name == null) return;
  const val = String(name).trim();
  if(!val){ libState.note = '名称不能为空，已取消'; libPaint(); return; }
  if(one && val === cur) return;

  libState.busy = '改名中';
  libPaint();
  try{
    const r = await d.assetRename(ids, val);
    if(!r || !r.ok) throw new Error((r && r.message) || '改名失败');
    const n = (r.renamed || []).length;
    libState.note = one ? ('已改名为「' + val + '」') : ('已重命名 ' + n + ' 个资产');
    if(r.failed && r.failed.length) libState.error = r.failed.length + ' 个改名失败';
  }catch(e){
    libState.error = '改名失败：' + ((e && e.message) || e);
  }finally{
    libState.busy = '';
    await libRefresh();
  }
}

function libRenameSelected(){
  if(!libState.sel.size){ libState.note = '先选中要改名的资产'; libPaint(); return; }
  libRename(Array.from(libState.sel));
}

/* ---------- 设为壁纸（图库 → 桌面） ----------
 * 链路：卡片右键/按钮 → 打开右侧抽屉（复用 DeskWall 的面板）→ 调 DeskWall.set。
 * 为什么不当场直接设：一张图设成壁纸还有「适应方式 / 雾化 / 色调」要定，
 * 直接生效等于让用户先吃一个默认值再手动去设置页改，不如一次说清。
 * 抽屉挂在 #libWin 上（不进 #libBody），否则会被 libPaint 重绘冲掉。 */

let libWallDrawerOpen = false;

function libWallApplicable(kind){
  return kind === 'image' && typeof DeskWall !== 'undefined';
}

/* 当前桌面壁纸引用的资产 id（用于在卡片上打「墙纸中」标记） */
function libWallAssetId(){
  try{
    const w = (typeof DeskWall !== 'undefined') ? DeskWall.get() : null;
    if(!w || w.mode !== 'image' || !w.image) return '';
    return w.image.indexOf('blob:') === 0 ? w.image.slice(5) : '';
  }catch(e){ return ''; }
}

function libWallEnsure(){
  const win = $('libWin');
  if(!win) return null;
  let el = $('libWallDrawer');
  if(!el){
    el = document.createElement('div');
    el.id = 'libWallDrawer';
    el.className = 'wp-drawer';
    win.appendChild(el);
  }
  return el;
}

function libWallClose(){
  const el = $('libWallDrawer');
  libWallDrawerOpen = false;
  if(el) el.classList.remove('show');
  if(typeof wallPanelRender === 'function') wallPanelRender(null);
}

/* 打开抽屉：先把图读成 dataURL（压缩后）再交给面板，
 * 不要在面板里读资产 —— 面板也要能在设置页里独立使用（那里没有选中资产）。 */
async function libWallOpen(id){
  if(!libWallApplicable('image')) return;
  const a = libState.assets.find(x => x.id === id);
  if(!a) return;
  const d = libDesk();
  if(!d) return;
  let r;
  try{ r = await d.assetRead(id); }catch(e){ r = null; }
  if(!r || !r.ok || !r.dataURL){
    libState.error = '打不开「' + a.name + '」：' + ((r && r.error) || '文件缺失');
    libPaint();
    return;
  }
  const el = libWallEnsure();
  if(!el) return;
  libWallDrawerOpen = true;
  el.classList.add('show');
  if(typeof wallPanelRender === 'function'){
    wallPanelRender(el, {
      source: 'asset',
      name: a.name,
      assetId: a.id,
      dataURL: r.dataURL,
      onClose: libWallClose,
      onDone: function(){
        libWallClose();
        libState.note = '已把「' + a.name + '」设为桌面壁纸';
        libPaint();
      }
    });
  }
}

/* 地址栏旁边那个「壁纸」按钮：从本机选一张图（不需要先进资产库） */
async function libWallPickLocal(){
  if(typeof DeskWall === 'undefined') return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if(!f) return;
    const raw = await new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => res('');
      fr.readAsDataURL(f);
    });
    if(!raw) return;
    const small = await DeskWall.shrink(raw);
    const el = libWallEnsure();
    if(!el) return;
    libWallDrawerOpen = true;
    el.classList.add('show');
    if(typeof wallPanelRender === 'function'){
      wallPanelRender(el, {
        source: 'local',
        name: f.name,
        dataURL: small,
        onClose: libWallClose,
        onDone: function(){
          libWallClose();
          libState.note = '已把「' + f.name + '」设为桌面壁纸';
          libPaint();
        }
      });
    }
  });
  inp.click();
}

/* 卡片右键菜单：挂 body、点外部即关。
 * 只做「对当前选中项的操作」，不做「按类型动态隐藏」——
 * 图库和模型库里可用项本来就不同，按 kind 过滤一次就够，别再按卡状态叠条件。
 * 关闭函数在下方统一定义（与「更多」菜单共用）。 */
let libCtxEl = null;
function libContextMenu(x, y){
  libContextClose();
  const n = libState.sel.size;
  const items = [
    { act: 'edit', label: '编辑图片…', hint: 'Enter', disabled: !(libState.kind === 'image' && n === 1) },
    { act: 'rename', label: '重命名', hint: 'F2', disabled: n < 1 },
    { act: 'wall', label: '设为桌面壁纸', hint: '', disabled: !(libState.kind === 'image' && n === 1 && libWallApplicable('image')) },
    { act: 'export', label: '导出到文件夹…', hint: '', disabled: n < 1 },
    { act: 'sep' },
    { act: 'remove', label: '删除（移到回收站）', hint: 'Del', danger: true, disabled: n < 1 }
  ];
  const el = document.createElement('div');
  el.className = 'lib-ctx';
  el.innerHTML = items.map(it => it.act === 'sep'
    ? '<div class="lib-ctx-sep"></div>'
    : '<button type="button" class="lib-ctx-item' + (it.danger ? ' danger' : '') + '" data-ctx="' + it.act + '"' +
      (it.disabled ? ' disabled' : '') + '><span>' + libEsc(it.label) + '</span>' +
      (it.hint ? '<kbd>' + libEsc(it.hint) + '</kbd>' : '') + '</button>').join('');
  document.body.appendChild(el);
  // 贴边修正：菜单贴到右/下边缘时要翻到鼠标左上方
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  el.querySelectorAll('[data-ctx]').forEach(b => {
    b.addEventListener('click', () => {
      const a = b.dataset.ctx;
      libContextClose();
      if(a === 'edit') libOpenAsset(Array.from(libState.sel)[0]);
      else if(a === 'rename') libRenameSelected();
      else if(a === 'wall') libWallOpen(Array.from(libState.sel)[0]);
      else if(a === 'export') libExportSelected();
      else if(a === 'remove') libRemoveSelected();
    });
  });
  libCtxEl = el;
  setTimeout(() => {
    document.addEventListener('pointerdown', libContextOutside, true);
    document.addEventListener('keydown', libContextKey, true);
  }, 0);
}
function libContextOutside(e){
  /* 两个菜单（右键 / 更多）共用一套关闭。当前开着哪个就判哪个，
   * 不要写死只判 libCtxEl ——「更多」菜单开着时点外部也要能关。 */
  const open = libCtxEl || libMoreEl;
  if(open && !open.contains(e.target)){
    libContextClose();
    document.removeEventListener('pointerdown', libContextOutside, true);
    document.removeEventListener('keydown', libContextKey, true);
  }
}
function libContextKey(e){
  if(e.key === 'Escape'){
    libContextClose();
    document.removeEventListener('pointerdown', libContextOutside, true);
    document.removeEventListener('keydown', libContextKey, true);
  }
}

/* 工具栏「更多」菜单：低频操作（重命名 / 核对磁盘 / 清空回收站）放进这里，
 * 让主工具栏只剩搜索 + 排序 + 导入。与右键菜单共享 .lib-ctx 样式与关闭机制。 */
let libMoreEl = null;
function libMoreMenu(anchor){
  libContextClose();
  const n = libState.sel.size;
  const items = [
    { act: 'selectall', label: '全选可见项', hint: 'Ctrl+A', disabled: false },
    { act: 'clearsel', label: '清空选择', hint: 'Esc', disabled: n < 1 },
    { act: 'rename', label: '重命名', hint: 'F2', disabled: n < 1 },
    { act: 'sep' },
    { act: 'wallLocal', label: '从本机选图设为壁纸…', hint: '', disabled: libState.kind !== 'image' },
    { act: 'sep' },
    { act: 'reconcile', label: '核对磁盘', hint: '', disabled: false },
    { act: 'empty', label: '清空回收站', hint: '', disabled: false }
  ];
  const el = document.createElement('div');
  el.className = 'lib-ctx lib-more';
  el.innerHTML = items.map(it => it.act === 'sep'
    ? '<div class="lib-ctx-sep"></div>'
    : '<button type="button" class="lib-ctx-item' + (it.danger ? ' danger' : '') + '" data-more="' + it.act + '"' +
      (it.disabled ? ' disabled' : '') + '><span>' + libEsc(it.label) + '</span>' +
      (it.hint ? '<kbd>' + libEsc(it.hint) + '</kbd>' : '') + '</button>').join('');
  document.body.appendChild(el);
  /* 贴边修正 + 定位在按钮下方 */
  const r = el.getBoundingClientRect();
  const br = anchor.getBoundingClientRect();
  let left = br.left;
  if(left + r.width > window.innerWidth - 6) left = window.innerWidth - r.width - 6;
  el.style.left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6)) + 'px';
  el.style.top = (br.bottom + 4) + 'px';
  el.querySelectorAll('[data-more]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.more;
      libContextClose();
      if(a === 'selectall') libSelectAllVisible();
      else if(a === 'clearsel') libSetSel([]);
      else if(a === 'rename') libRenameSelected();
      else if(a === 'wallLocal') libWallPickLocal();
      else if(a === 'reconcile') libReconcile();
      else if(a === 'empty') libEmptyTrash();
    });
  });
  libMoreEl = el;
  setTimeout(() => {
    document.addEventListener('pointerdown', libContextOutside, true);
    document.addEventListener('keydown', libContextKey, true);
  }, 0);
}
/* 与右键菜单共用关闭（libContextClose 一并清掉两者） */
function libContextClose(){
  if(libCtxEl){ libCtxEl.remove(); libCtxEl = null; }
  if(libMoreEl){ libMoreEl.remove(); libMoreEl = null; }
}

/* ---------- 渲染 ---------- */
function libVisible(){
  const q = libState.q.trim().toLowerCase();
  let list = libState.assets.slice();
  if(q) list = list.filter(a => String(a.name || '').toLowerCase().indexOf(q) >= 0);
  /* 先按「升序」定义比较器，再乘方向系数：方向只影响排序结果，
   * 不改变「最新 / 最大 / 名称」三档本身的语义。 */
  const dir = libState.sortDir === 'asc' ? 1 : -1;
  if(libState.sort === 'big') list.sort((a, b) => (a.size - b.size) * dir);
  else if(libState.sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name)) * dir);
  else list.sort((a, b) => (a.created - b.created) * dir);
  return list;
}

function libCard(a){
  const k = LIB_KINDS[libState.kind];
  const refs = libState.refs[a.id] || 0;
  const where = (libState.refWhere[a.id] || []).slice(0, 2).join('、');
  const on = libState.sel.has(a.id);
  const sel = on ? ' on' : '';
  const miss = a.missing ? ' miss' : '';
  /* 「墙纸中」：当前桌面用的就是这张。没有这个标记，用户在图库里分不清
   * 哪张是壁纸、改完缩放后也找不到自己用的是哪张。 */
  const isWall = libState.kind === 'image' && a.id === libWallAssetId();
  const wallCls = isWall ? ' is-wall' : '';

  let thumbAttrs = '', thumbInner = '';
  if(libState.kind === 'image'){
    /* 图片磁贴上放一个「壁纸」快捷按钮：这是「把这张图变成桌面」的最短路径，
     * 比「进编辑器 → 导出 → 进设置 → 选文件」快三步。 */
    const wallBtn = libWallApplicable('image')
      ? '<button type="button" class="lib-thumb-act" data-lib-wall="' + libEsc(a.id) +
        '" title="把这张图设为桌面壁纸">壁纸</button>'
      : '';
    thumbAttrs = ' data-lib-thumb="' + libEsc(a.id) + '"';
    thumbInner = '<span class="lib-loading">···</span>' +
      '<span class="lib-thumb-acts">' + wallBtn + '</span>';
  } else {
    /* 3D 磁贴也走懒加载：先查存好的缩略图，没有就现场渲染一张并缓存。
     * 只放一个 "GLB" 字样的卡片和 UE 那种网格缩略图完全不是一个东西。
     * ⚠️ 属性名不能用 data-lib-3d：dataset 的驼峰规则对「-数字」不生效
     * （data-lib-3d 在真实 DOM 里读不到 dataset.lib3d），会静默退回图片分支，
     * 把 obj 原文件当成图片塞进 <img>——磁贴变成破图标。用纯字母最稳。 */
    thumbAttrs = ' data-lib-thumb="' + libEsc(a.id) + '" data-lib-kind="model"';
    thumbInner = '<span class="lib-ext">' + libEsc(String(a.ext || '').toUpperCase()) + '</span>' +
      '<span class="lib-thumb-acts">' +
        '<button type="button" class="lib-thumb-act" data-lib-ref="' + libEsc(a.id) +
          '" title="打开模型并配置结构 / 着色参考图">参考</button>' +
        '<button type="button" class="lib-thumb-act" data-lib-uv="' + libEsc(a.id) +
          '" title="查看 UV 岛分布">UV</button>' +
      '</span>';
  }

  const refHtml = (libState.kind === 'image' && refs)
    ? '<span class="lib-ref" title="' + libEsc(where) + '">' + refs + ' 处在用</span>'
    : '';

  /* 模型卡上的参考图小标：结构 / 着色有没有配过，一眼能看出来。
   * 直接读 ModelRefs 的索引（localStorage 里只有几十字节），不额外请求资产库。 */
  let refBadge = '';
  if(libState.kind === 'model' && typeof ModelRefs !== 'undefined' && ModelRefs.get){
    try{
      const rr = ModelRefs.get(a.id) || {};
      const bits = [];
      if(rr.struct) bits.push('结构');
      if(rr.color) bits.push('着色');
      if(bits.length){
        refBadge = '<span class="lib-refbadge" title="已配' + libEsc(bits.join(' / ')) + '参考图">' +
          libEsc(bits.join(' · ')) + '</span>';
      }
    }catch(e){}
  }

  const wallBadge = isWall ? '<span class="lib-wallbadge" title="这就是当前桌面壁纸">墙纸中</span>' : '';

  /* 卡片信息区：单行（名称） + 单行（大小 / 日期）。徽标集中在右上角，
   * 空态时让名字更突出 —— 三行小字叠起来是旧版最显「旧」的地方。 */
  return '<div class="lib-card' + sel + miss + wallCls + '" data-lib-id="' + libEsc(a.id) +
    '" title="双击打开 · F2 改名" draggable="false">' +
    '<label class="lib-check"><input type="checkbox" data-lib-sel="' + libEsc(a.id) + '"' +
      (on ? ' checked' : '') + '></label>' +
    '<div class="lib-thumb"' + thumbAttrs + '>' + thumbInner + '</div>' +
    '<div class="lib-card-info">' +
      '<div class="lib-name-row">' +
        '<div class="lib-name" data-lib-rename="' + libEsc(a.id) + '" title="' + libEsc(a.name) +
          '（双击可改名）">' + libEsc(a.name) + '</div>' +
        '<span class="lib-badges">' + refHtml + refBadge + wallBadge + '</span>' +
      '</div>' +
      '<div class="lib-meta">' +
        '<span>' + libFmt(a.size) + '</span>' +
        (a.missing ? '<b class="lib-bad">文件丢失</b>' : '') +
        '<span class="lib-date">' + libFmtTime(a.created) + '</span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function libPaint(){
  const box = $('libBody');
  if(!box) return;
  const k = LIB_KINDS[libState.kind] || LIB_KINDS.image;
  const win = $('libWin');
  if(win){
    win.classList.toggle('is-model', libState.kind === 'model');
    win.classList.remove('lib-dense-s', 'lib-dense-m', 'lib-dense-l');
    win.classList.add('lib-dense-' + libState.dense);
  }
  const titleEl = $('libWinTitle');
  if(titleEl) titleEl.textContent = k.title;

  const st = libState.stat || {};
  const kindStat = (st.byKind && st.byKind[libState.kind]) || { count: 0, bytes: 0 };
  const list = libVisible();
  /* 选中条已改为挂在窗口上的浮动条（libEnsureChrome），不进 libBody 的流——
   * 否则框选时「第一次选中 → 选中条插入 → 网格下移」，卡片会在手底下跳走 */

  const chips = [
    ['new', '最新'], ['big', '最大'], ['name', '名称']
  ].map(([v, label]) => '<button type="button" class="lib-chip' + (libState.sort === v ? ' on' : '') +
    '" data-lib-sort="' + v + '">' + label + '</button>').join('');
  const sortDirBtn = '<button type="button" class="lib-dir" data-lib-dir title="' +
    (libState.sortDir === 'asc' ? '当前升序，点击改为降序' : '当前降序，点击改为升序') + '" aria-label="切换排序方向">' +
    (libState.sortDir === 'asc' ? '↑' : '↓') + '</button>';
  const denseBtns = [['s', 'S', '小缩略图'], ['m', 'M', '中缩略图'], ['l', 'L', '大缩略图']]
    .map(([v, label, tip]) => '<button type="button" class="' + (libState.dense === v ? 'on' : '') +
      '" data-lib-dense="' + v + '" title="' + tip + '">' + label + '</button>').join('');

  /* 占用条：把「这个 app 管的东西占了多少」摆在最上面。
   * 用户打开图库/模型库的第一诉求往往就是「到底占了我多少空间」。 */
  const head =
    '<div class="lib-head">' +
      '<span class="lib-title">' + libEsc(k.title) + '</span>' +
      '<span class="lib-sub">' + libEsc(k.sub) + '</span>' +
      '<div class="lib-usage" title="占用空间 / 资产数">' +
        '<b>' + libFmt(kindStat.bytes) + '</b>' +
        '<span>' + kindStat.count + ' 项</span>' +
      '</div>' +
    '</div>' +
    (st.trashBytes
      ? '<div class="lib-trash">回收站还占着 <b>' + libFmt(st.trashBytes) + '</b>（' + (st.trashCount || 0) +
        ' 个文件）——确认不要了可以清掉</div>'
      : '');

  const toolbar =
    '<div class="lib-bar">' +
      '<div class="lib-searchwrap">' +
        '<svg class="lib-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 4.3 4.3"/></svg>' +
        '<input class="lib-search" type="search" placeholder="搜索名称…" data-lib-q value="' + libEsc(libState.q) + '">' +
        (libState.q ? '<button type="button" class="lib-search-clear" data-lib-act="clearq" title="清空搜索">×</button>' : '') +
      '</div>' +
      '<div class="lib-sorts" role="group" aria-label="排序方式">' + chips + sortDirBtn + '</div>' +
      (libState.q ? '<span class="lib-qcount">匹配 ' + list.length + ' 项</span>' : '') +
      '<div class="lib-acts">' +
        '<div class="lib-dense" role="group" aria-label="缩略图大小">' + denseBtns + '</div>' +
        (libState.kind === 'model'
          ? '<button type="button" class="btn sm" data-lib-act="uv" title="选中一个模型后查看它的 UV 岛分布">UV 查看</button>'
          : '') +
        (libState.kind === 'image'
          ? '<button type="button" class="btn sm" data-lib-act="wall" title="把选中的图片设为桌面壁纸"' +
            (libState.sel.size === 1 && libWallApplicable('image') ? '' : ' disabled') + '>设为壁纸</button>'
          : '') +
        '<button type="button" class="btn sm primary" data-lib-act="import" title="从磁盘导入图片或模型">导入</button>' +
        '<button type="button" class="btn sm icon" data-lib-act="more" title="更多操作" aria-label="更多操作">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>';

  const body = list.length
    ? '<div class="lib-grid">' + list.map(libCard).join('') + '</div>'
    : '<div class="lib-empty">' +
        '<span class="lib-empty-ico">' + (libState.kind === 'model' ? '▦' : '🖼') + '</span>' +
        '<b>' + libEsc(k.emptyTitle || '这里还空着') + '</b>' +
        '<p>' + libEsc(k.empty) + '</p>' +
        '<button type="button" class="btn sm" data-lib-act="import">导入第一个资产</button>' +
      '</div>';

  box.innerHTML = head + toolbar +
    (libState.error ? '<div class="lib-err">' + libEsc(libState.error) + '</div>' : '') +
    (libState.note ? '<div class="lib-note">' + libEsc(libState.note) + '</div>' : '') +
    body;

  // 事件
  box.querySelectorAll('[data-lib-sort]').forEach(b => {
    b.addEventListener('click', () => { libState.sort = b.dataset.libSort; libPaint(); });
  });
  box.querySelectorAll('[data-lib-sel]').forEach(inp => {
    // 复选框自己处理选中，别让卡片的 pointerdown 再触发一次
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    inp.addEventListener('change', () => libToggleSel(inp.dataset.libSel, inp.checked));
  });
  // 双击打开：3D 进查看器、图片进编辑器。
  // ⚠ 双击文件名是改名，不能同时开编辑器 —— 所以先判目标是不是名字。
  box.querySelectorAll('.lib-card').forEach(el => {
    el.addEventListener('dblclick', e => {
      if(e.target && (e.target.tagName === 'INPUT' || e.target.closest('.lib-thumb-act'))) return;
      if(e.target && e.target.closest('[data-lib-rename]')){ e.stopPropagation(); return; }
      libOpenAsset(el.dataset.libId);
    });
  });
  // 双击文件名 = 改名（文件管理器里改名的标准手势）
  box.querySelectorAll('[data-lib-rename]').forEach(el => {
    el.addEventListener('dblclick', e => { e.stopPropagation(); libRename([el.dataset.libRename]); });
  });
  // 右键菜单：卡片上右键给出「改名 / 设为壁纸 / 导出 / 删除」四项
  box.querySelectorAll('.lib-card').forEach(el => {
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const id = el.dataset.libId;
      if(!libState.sel.has(id)) libSetSel([id]);
      libContextMenu(e.clientX, e.clientY);
    });
  });
  // 卡片上的「壁纸」快捷入口
  box.querySelectorAll('[data-lib-wall]').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); libWallOpen(b.dataset.libWall); });
  });
  // 卡片上的 UV 快捷入口（不用先选中，看到就能点）
  box.querySelectorAll('[data-lib-uv]').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); libUvOpen(b.dataset.libUv); });
  });
  // 卡片上的「参考」：打开 3D 视口并直接把参考图抽屉拉出来（两步并一步）
  box.querySelectorAll('[data-lib-ref]').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); libRefOpen(b.dataset.libRef); });
  });
  const qEl = box.querySelector('[data-lib-q]');
  if(qEl){
    qEl.addEventListener('input', () => { libState.q = qEl.value; const v = qEl.value; libPaint(); const n = box.querySelector('[data-lib-q]'); if(n){ n.value = v; n.focus(); } });
  }
  /* 排序：点当前档位 = 反过来排，点其他档位 = 切过去并按该档的默认方向
   * （名称默认 A→Z，最新/最大默认从大到小），方向按钮再单独微调。 */
  box.querySelectorAll('[data-lib-sort]').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.libSort;
      if(libState.sort === v) libState.sortDir = libState.sortDir === 'asc' ? 'desc' : 'asc';
      else { libState.sort = v; libState.sortDir = v === 'name' ? 'asc' : 'desc'; }
      libPaint();
    });
  });
  const dirBtn = box.querySelector('[data-lib-dir]');
  if(dirBtn){
    dirBtn.addEventListener('click', () => {
      libState.sortDir = libState.sortDir === 'asc' ? 'desc' : 'asc';
      libPaint();
    });
  }
  box.querySelectorAll('[data-lib-dense]').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.libDense;
      if(v !== 's' && v !== 'm' && v !== 'l') return;
      libState.dense = v;
      try{ localStorage.setItem('hf_lib_dense', v); }catch(e){}
      libPaint();
    });
  });
  box.querySelectorAll('[data-lib-act]').forEach(b => {
    b.addEventListener('click', () => {
      const a = b.dataset.libAct;
      if(a === 'import') libImport();
      else if(a === 'reconcile') libReconcile();
      else if(a === 'empty') libEmptyTrash();
      else if(a === 'uv'){
        if(libState.sel.size !== 1){
          libState.note = '先在网格里选中一个模型，再点「UV 查看」（也可以直接点磁贴右下角的 UV）';
          libPaint();
          return;
        }
        libUvOpen(Array.from(libState.sel)[0]);
      }
      else if(a === 'export') libExportSelected();
      else if(a === 'remove') libRemoveSelected();
      else if(a === 'rename') libRenameSelected();
      else if(a === 'clearq'){ libState.q = ''; libPaint(); }
      else if(a === 'more'){ libMoreMenu(b); }
      else if(a === 'wall'){
        if(libState.sel.size !== 1){
          libState.note = '先选中一张图片，再点「设为壁纸」';
          libPaint();
          return;
        }
        libWallOpen(Array.from(libState.sel)[0]);
      }
      else if(a === 'clearsel'){ libState.sel.clear(); libPaint(); }
    });
  });

  // 懒加载缩略图
  libEnsureObserver();
  const thumbs = box.querySelectorAll('[data-lib-thumb]');
  thumbs.forEach(el => {
    /* 观察整张卡片，不观察缩略图本身：卡片有一小截露在视口上沿时，
     * 缩略图是零相交（完全在视口外），用户却已经看到那张卡的空边条。 */
    const target = libThumbTarget(el);
    if(libObserver) libObserver.observe(target);
    else libLoadThumb(el.dataset.libThumb, el);
  });

  // 重绘后同步浮动选中条 / 垃圾桶 / 卡片选中态
  libSyncSelectionUI();
}

/* 打开 app：kind 决定是图库还是模型库。
 * 每次打开都重扫引用——用户很可能刚改完流程，缓存会显示成「没人用」。 */
async function openLibrary(kind){
  const win = $('libWin');
  if(!win) return false;
  libState.kind = LIB_KINDS[kind] ? kind : 'image';
  libState.sel.clear();
  libState.q = '';
  libState.note = '';
  libState.error = '';
  if(libMv.open) libMvClose();
  /* 统一走 App 页翻页（deskMountApp 定义在 desk-shell.js）；拿不到时退回弹窗 */
  if(typeof deskMountApp === 'function'){
    const isModel = libState.kind === 'model';
    deskMountApp(win, isModel ? '模型库' : '图库', isModel ? '本机模型文件' : '生成结果与素材');
  }else{
    win.classList.remove('hidden');
  }
  libEnsureChrome();
  libBindGestures();
  libPaint();
  await libRefresh(true);
  return true;
}

/* ---------- 设置 → 资产库 ----------
 * 放在设置里而不是只放图库 app，是因为「占用了多少、要不要清理」是设置级的问题；
 * 但操作（浏览/删除/导入）仍在图库和模型库 app 里做，这里只放汇总和跳转。 */
async function renderAssetsPane(){
  const pane = $('paneAssets');
  if(!pane) return;
  const d = libDesk();
  if(!d){
    pane.innerHTML = '<div class="lib-empty">资产要落到本机磁盘上，需通过桌面版使用</div>';
    return;
  }
  pane.innerHTML = '<div class="ap-loading">统计中…</div>';
  let s = null;
  try{ s = await d.assetStat(); }
  catch(e){
    pane.innerHTML = '<div class="cf-err">统计失败：' + libEsc((e && e.message) || e) + '</div>';
    return;
  }
  const img = (s.byKind && s.byKind.image) || { count: 0, bytes: 0 };
  const model = (s.byKind && s.byKind.model) || { count: 0, bytes: 0 };
  const trashBytes = s.trashBytes || 0, trashCount = s.trashCount || 0;

  const card = (title, bytes, sub, cls, click) =>
    '<button type="button" class="ap-card' + (cls ? ' ' + cls : '') + '" data-ap-act="' + click + '">' +
      '<b>' + libFmt(bytes) + '</b><span>' + title + '</span><i>' + sub + '</i>' +
    '</button>';

  pane.innerHTML =
    '<div class="ap-head">图库 + 模型库共占用 <b>' + libFmt(s.totalBytes) + '</b>（' + s.count + ' 个资产）</div>' +
    '<div class="ap-grid">' +
      card('图库', img.bytes, img.count + ' 个图片资产', '', 'gallery') +
      card('模型库', model.bytes, model.count + ' 个 3D 资产', '', 'modellib') +
      card('回收站', trashBytes, trashCount + ' 个文件 · 可彻底清空', trashBytes ? 'warn' : 'mute', 'empty') +
    '</div>' +
    '<div class="ap-actions">' +
      '<button type="button" class="btn sm primary" data-ap-act="gallery">打开图库</button>' +
      '<button type="button" class="btn sm primary" data-ap-act="modellib">打开模型库</button>' +
      '<button type="button" class="btn sm" data-ap-act="reconcile">核对磁盘</button>' +
      '<button type="button" class="btn sm danger" data-ap-act="empty"' + (trashBytes ? '' : ' disabled') + '>清空回收站</button>' +
    '</div>' +
    '<div class="ap-path">资产存放位置：<code title="' + libEsc(s.root) + '">' + libEsc(s.root) + '</code></div>' +
    '<div class="ap-note">图片和 3D 文件都落在这个目录里，整个文件夹可以直接备份或拷到别的机器。' +
      '「核对磁盘」会重新扫描目录：外部放进去的文件会被收编，已消失的记录会被清掉。</div>';

  pane.querySelectorAll('[data-ap-act]').forEach(b => {
    b.addEventListener('click', async () => {
      const a = b.dataset.apAct;
      if(a === 'gallery'){ closeSettings(); openLibrary('image'); }
      else if(a === 'modellib'){ closeSettings(); openLibrary('model'); }
      else if(a === 'reconcile'){
        try{ await d.assetReconcile(); }catch(e){}
        await renderAssetsPane();
      }
      else if(a === 'empty'){
        if(!trashBytes) return;
        if(!confirm('彻底清空回收站？将永久删除 ' + libFmt(trashBytes) + '（' + trashCount + ' 个文件），不可恢复。')) return;
        try{ await d.assetEmptyTrash(); }catch(e){}
        await renderAssetsPane();
      }
    });
  });
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { LIB_KINDS, libState, libScanRefs, libPaint, openLibrary, libFmt, libForgetThumb, libOpenAsset, renderAssetsPane, libUvOpen, libUvClose };
}
