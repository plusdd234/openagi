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
    empty: '还没有图片。在工作流里跑一次生成，或用「导入」把本机的图片收进来。',
    refOf: id => 'blob:' + id
  },
  model: {
    title: '模型库',
    sub: 'glb · gltf · obj · fbx 等 3D 资产',
    glyph: 'modelLib',
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

/* 只更新选中态的 UI（卡片 .on、复选框、浮动选中条、垃圾桶），不重建 DOM。
 * ⚠ 选中条千万不能放在 libBody 的流里：框选过程中「第一次选中 → 选中条插入 →
 * 网格整体下移 40px」，卡片会在手底下跳走，框选直接废掉。所以它和垃圾桶一样
 * 挂在窗口本体上，用绝对定位浮在底部。 */
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
  const bar = $('libSelBar');
  if(bar){
    bar.classList.toggle('show', selN > 0);
    const cnt = bar.querySelector('.lib-selcount');
    if(cnt) cnt.textContent = '已选 ' + selN + ' 个';
  }
  const tc = $('libTrash');
  if(tc) tc.classList.toggle('show', selN > 0);
}

function libSetSel(ids){
  libState.sel = new Set(ids);
  libSyncSelectionUI();
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

/* 右下角垃圾桶 + 浮动选中条：都常驻在窗口里（不在 #libBody 内，否则被 libPaint 重绘冲掉） */
function libEnsureChrome(){
  const win = $('libWin');
  if(!win) return;
  if(!$('libTrash')){
    const tc = document.createElement('div');
    tc.id = 'libTrash';
    tc.className = 'lib-trashcan';
    tc.setAttribute('title', '把选中的资产拖到这里删除（移入回收站）');
    tc.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/></svg>' +
      '<span>拖到此处删除</span>';
    win.appendChild(tc);
  }
  if(!$('libSelBar')){
    const bar = document.createElement('div');
    bar.id = 'libSelBar';
    bar.className = 'lib-selbar';
    bar.innerHTML = '<span class="lib-selcount">已选 0 个</span>' +
      '<button type="button" class="btn sm" data-lib-sel-act="export">导出</button>' +
      '<button type="button" class="btn sm danger" data-lib-sel-act="remove">删除</button>' +
      '<button type="button" class="btn sm" data-lib-sel-act="clear">取消选择</button>';
    bar.querySelectorAll('[data-lib-sel-act]').forEach(b => {
      b.addEventListener('click', () => {
        const a = b.dataset.libSelAct;
        if(a === 'export') libExportSelected();
        else if(a === 'remove') libRemoveSelected();
        else { libState.sel.clear(); libSyncSelectionUI(); }
      });
    });
    win.appendChild(bar);
  }
}

function libOverTrash(e){
  const tc = $('libTrash');
  if(!tc) return false;
  const r = tc.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
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

function libBeginTrashDrag(e){
  /* 自愈：上一次手势若因 pointercancel/失焦漏了清理，这里先把残骸扫掉，
   * 不能让「N 项 · 拖到垃圾桶删除」的幽灵在页面上越积越多 */
  document.querySelectorAll('.lib-drag-ghost').forEach(el => el.remove());
  document.querySelectorAll('#libBody .lib-card.dragging').forEach(c => c.classList.remove('dragging'));
  const tc = $('libTrash');
  if(tc) tc.classList.remove('hot');
  document.querySelectorAll('#libBody .lib-card.on').forEach(c => c.classList.add('dragging'));
  const ghost = document.createElement('div');
  ghost.className = 'lib-drag-ghost';
  ghost.innerHTML = '<span class="lib-drag-n">' + libState.sel.size + '</span><span>项 · 拖到垃圾桶删除</span>';
  document.body.appendChild(ghost);
  libGesture.ghost = ghost;
  libMoveTrashDrag(e);
}
function libMoveTrashDrag(e){
  const g = libGesture;
  if(!g || !g.ghost) return;
  g.ghost.style.left = (e.clientX + 14) + 'px';
  g.ghost.style.top = (e.clientY + 14) + 'px';
  const tc = $('libTrash');
  if(tc) tc.classList.toggle('hot', libOverTrash(e));
}

/* 唯一的清理出口：pointerup / pointercancel / 窗口失焦 / Esc 全走这里。
 * 幂等——重复调用无害。漏清理的后果就是用户截图里那样：幽灵和红色垃圾桶永远留在页面上。 */
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
  if(g.ghost) g.ghost.remove();
  document.querySelectorAll('#libBody .lib-card.dragging').forEach(c => c.classList.remove('dragging'));
  const tc = $('libTrash');
  if(tc) tc.classList.remove('hot');
}

function libOnPointerUp(e){
  const g = libGesture;
  const drop = !!(g && g.mode === 'trash' && libOverTrash(e));
  libGestureAbort();
  if(drop) libTrashDrop();
}
function libOnPointerCancel(){ libGestureAbort(); }

/* 垃圾桶松手落点：复用 libRemoveSelected（引用警告 + 确认 + 移入回收站） */
function libTrashDrop(){
  if(!libState.sel.size) return;
  libRemoveSelected();
}

function libOnPointerDown(e){
  if(e.button !== 0) return;
  const body = $('libBody');
  if(!body || !body.contains(e.target)) return;
  // 这些区域有各自的交互，不能劫持
  if(e.target.closest('.lib-check')) return;
  if(e.target.closest('input, button, a, .lib-bar, .lib-head, .lib-trash, .lib-selbar')) return;
  const card = e.target.closest('.lib-card');
  const grid = e.target.closest('.lib-grid');
  if(!card && !grid) return;
  const startX = e.clientX, startY = e.clientY;
  if(card){
    const id = card.dataset.libId;
    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    if(range && libLastAnchor) libSelectRange(libLastAnchor, id);
    else if(additive) libToggleSel(id, !libState.sel.has(id));
    else if(!libState.sel.has(id)) libSetSel([id]);
    libLastAnchor = id;
    libGesture = { mode: 'maybe-trash', id, startX, startY };
  } else {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if(!additive) libSetSel([]);
    libGesture = { mode: 'marquee', startX, startY, additive, base: new Set(libState.sel) };
    e.preventDefault();
  }
  body.classList.add('lib-selecting');
  window.addEventListener('pointermove', libOnPointerMove);
  window.addEventListener('pointerup', libOnPointerUp);
  window.addEventListener('pointercancel', libOnPointerCancel);
  window.addEventListener('blur', libGestureAbort);
}

function libOnPointerMove(e){
  const g = libGesture;
  if(!g) return;
  const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
  if(g.mode === 'maybe-trash'){
    if(dist > 6){ g.mode = 'trash'; libBeginTrashDrag(e); }
    return;
  }
  if(g.mode === 'trash'){ libMoveTrashDrag(e); return; }
  // marquee
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
    if(e.key === 'Escape' && libGesture) libGestureAbort();
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
      const el = en.target;
      libObserver.unobserve(el);
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

async function libLoadThumb(id, holder){
  if(!id || !holder) return;
  const put = url => { holder.innerHTML = '<img alt="" src="' + url + '" draggable="false">'; };
  if(libThumbCache.has(id)){ put(libThumbCache.get(id)); return; }
  const d = libDesk();
  if(!d) return;
  const is3d = holder.dataset.libKind === 'model';

  try{
    // 1) 有存好的缩略图就直接用（3D 渲染一次几秒，不该每次开库都重来）
    if(is3d && typeof d.assetThumb === 'function'){
      const t = await d.assetThumb(id);
      if(t && t.ok && t.dataURL){ libThumbCache.set(id, t.dataURL); put(t.dataURL); return; }
    }
    const r = await d.assetRead(id);
    if(!r || !r.ok || !r.dataURL){
      holder.innerHTML = '<span class="lib-miss">文件已丢失</span>';
      return;
    }
    if(!is3d){
      libThumbCache.set(id, r.dataURL);
      put(r.dataURL);
      return;
    }
    // 2) 3D：排队渲染
    if(typeof Model3D === 'undefined' || typeof Model3D.renderThumb !== 'function'){
      holder.innerHTML = '<span class="lib-miss">3D 未就绪</span>';
      return;
    }
    await libQueue(async () => {
      const t = await Model3D.renderThumb(r.dataURL, { size: 256 });
      if(t && t.dataURL){
        libThumbCache.set(id, t.dataURL);
        put(t.dataURL);
        // 存起来，下次开库直接读文件
        try{ if(typeof d.assetThumbSave === 'function') await d.assetThumbSave(id, t.dataURL); }catch(e){}
      }
    });
  }catch(e){
    holder.innerHTML = '<span class="lib-miss">渲染失败</span>';
  }
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
    if(typeof Model3D !== 'undefined' && typeof Model3D.openPreview === 'function'){
      Model3D.openPreview(r.dataURL, { title: a.name });
    }else{
      libState.error = '3D 查看器未就绪';
      libPaint();
    }
    return;
  }
  if(typeof openImageEditor === 'function'){
    openImageEditor(id, a, r.dataURL);
  }else{
    libState.error = '图片编辑器未就绪';
    libPaint();
  }
}

/* ---------- 渲染 ---------- */
function libVisible(){
  const q = libState.q.trim().toLowerCase();
  let list = libState.assets.slice();
  if(q) list = list.filter(a => String(a.name || '').toLowerCase().indexOf(q) >= 0);
  if(libState.sort === 'big') list.sort((a, b) => b.size - a.size);
  else if(libState.sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else list.sort((a, b) => b.created - a.created);
  return list;
}

function libCard(a){
  const k = LIB_KINDS[libState.kind];
  const refs = libState.refs[a.id] || 0;
  const where = (libState.refWhere[a.id] || []).slice(0, 2).join('、');
  const on = libState.sel.has(a.id);
  const sel = on ? ' on' : '';
  const miss = a.missing ? ' miss' : '';

  let thumb;
  if(libState.kind === 'image'){
    thumb = '<div class="lib-thumb" data-lib-thumb="' + libEsc(a.id) + '"><span class="lib-loading">···</span></div>';
  } else {
    /* 3D 磁贴也走懒加载：先查存好的缩略图，没有就现场渲染一张并缓存。
     * 只放一个 "GLB" 字样的卡片和 UE 那种网格缩略图完全不是一个东西。
     * ⚠️ 属性名不能用 data-lib-3d：dataset 的驼峰规则对「-数字」不生效
     * （data-lib-3d 在真实 DOM 里读不到 dataset.lib3d），会静默退回图片分支，
     * 把 obj 原文件当成图片塞进 <img>——磁贴变成破图标。用纯字母最稳。 */
    thumb = '<div class="lib-thumb model" data-lib-thumb="' + libEsc(a.id) + '" data-lib-kind="model">' +
      '<span class="lib-ext">' + libEsc(String(a.ext || '').toUpperCase()) + '</span></div>';
  }

  const refHtml = (libState.kind === 'image' && refs)
    ? '<span class="lib-ref" title="' + libEsc(where) + '">' + refs + ' 处在用</span>'
    : '';

  return '<div class="lib-card' + sel + miss + '" data-lib-id="' + libEsc(a.id) + '" title="双击打开" draggable="false">' +
    '<label class="lib-check"><input type="checkbox" data-lib-sel="' + libEsc(a.id) + '"' +
      (on ? ' checked' : '') + '></label>' +
    thumb +
    '<div class="lib-name" title="' + libEsc(a.name) + '">' + libEsc(a.name) + '</div>' +
    '<div class="lib-meta">' + libFmt(a.size) + (a.missing ? ' · <b class="lib-bad">文件丢失</b>' : '') + '</div>' +
    '<div class="lib-meta2">' + refHtml + '<span>' + libFmtTime(a.created) + '</span></div>' +
  '</div>';
}

function libPaint(){
  const box = $('libBody');
  if(!box) return;
  const k = LIB_KINDS[libState.kind] || LIB_KINDS.image;
  const win = $('libWin');
  if(win) win.classList.toggle('is-model', libState.kind === 'model');
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

  /* 占用条：把「这个 app 管的东西占了多少」摆在最上面。
   * 用户打开图库/模型库的第一诉求往往就是「到底占了我多少空间」。 */
  const head =
    '<div class="lib-head">' +
      '<div class="lib-head-main">' +
        '<span class="lib-title">' + libEsc(k.title) + '</span>' +
        '<span class="lib-sub">' + libEsc(k.sub) + '</span>' +
      '</div>' +
      '<div class="lib-usage">' +
        '<b>' + libFmt(kindStat.bytes) + '</b>' +
        '<span>' + kindStat.count + ' 个资产</span>' +
      '</div>' +
    '</div>' +
    (st.trashBytes
      ? '<div class="lib-trash">回收站还占着 <b>' + libFmt(st.trashBytes) + '</b>（' + (st.trashCount || 0) +
        ' 个文件）——确认不要了可以清掉</div>'
      : '');

  const toolbar =
    '<div class="lib-bar">' +
      '<input class="lib-search" type="search" placeholder="搜索名称…" data-lib-q value="' + libEsc(libState.q) + '">' +
      '<div class="lib-sorts">' + chips + '</div>' +
      '<div class="lib-acts">' +
        '<button type="button" class="btn sm" data-lib-act="import">导入</button>' +
        '<button type="button" class="btn sm" data-lib-act="reconcile" title="磁盘是真相：补回外部放进去的文件、清掉已消失的记录">核对磁盘</button>' +
        '<button type="button" class="btn sm" data-lib-act="empty">清空回收站</button>' +
      '</div>' +
    '</div>';

  const body = list.length
    ? '<div class="lib-grid">' + list.map(libCard).join('') + '</div>'
    : '<div class="lib-empty">' + libEsc(k.empty) + '</div>';

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
  // 双击打开：3D 进查看器、图片进编辑器
  box.querySelectorAll('.lib-card').forEach(el => {
    el.addEventListener('dblclick', e => {
      if(e.target && e.target.tagName === 'INPUT') return;
      libOpenAsset(el.dataset.libId);
    });
  });
  const qEl = box.querySelector('[data-lib-q]');
  if(qEl){
    qEl.addEventListener('input', () => { libState.q = qEl.value; const v = qEl.value; libPaint(); const n = box.querySelector('[data-lib-q]'); if(n){ n.value = v; n.focus(); } });
  }
  box.querySelectorAll('[data-lib-act]').forEach(b => {
    b.addEventListener('click', () => {
      const a = b.dataset.libAct;
      if(a === 'import') libImport();
      else if(a === 'reconcile') libReconcile();
      else if(a === 'empty') libEmptyTrash();
      else if(a === 'export') libExportSelected();
      else if(a === 'remove') libRemoveSelected();
      else if(a === 'clearsel'){ libState.sel.clear(); libPaint(); }
    });
  });

  // 懒加载缩略图
  libEnsureObserver();
  const thumbs = box.querySelectorAll('[data-lib-thumb]');
  thumbs.forEach(el => {
    if(libObserver) libObserver.observe(el);
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
  /* 统一走 App 页翻页（deskMountApp 定义在 desktop.js）；拿不到时退回弹窗 */
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
  module.exports = { LIB_KINDS, libState, libScanRefs, libPaint, openLibrary, libFmt, libForgetThumb, libOpenAsset, renderAssetsPane };
}
