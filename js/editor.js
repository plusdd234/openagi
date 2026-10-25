/* ======================= 画布编辑引擎 =======================
 * 从「按钮 + 一堆全局 drag 变量」升级成带手势状态机的编辑器内核。
 * 拆开四件事，互不污染：
 *   1) 视图变换：bpPan / bpZoom 仍是唯一真源（desktop / runtime 都读它），
 *      本模块只负责改它，并同步网格背景与缩放指示。
 *   2) 手势状态机：Editor.gesture ∈ '' | pan | marquee | node | frame | frameResize。
 *      一个 pointerdown 决策、一个 window 级 move/up 收尾，不再各个方向各写一套。
 *   3) 选择模型：Editor.selection（节点 id 集合）+ Editor.frameSel（注释面板）。
 *      不落盘；只在渲染后回填 class，避免重渲染丢选中。
 *   4) 注释面板（comment frame）：bp.frames 落盘，拖动面板时按「包含关系」
 *      带上框住的节点一起走 —— 成员在拖动开始时算一次，之后不随鼠标漂移。
 *
 * 交互约定（对齐专业节点编辑器）：
 *   中键拖动 = 平移；左键在空白拖动 = 框选；Shift/Ctrl = 追加选择；
 *   框选或选中后按 C = 建注释面板；Delete 删所选；Ctrl+A 全选；F 适应视图；
 *   空格 + 左键拖动 = 平移；滚轮 = 以光标为锚点缩放。
 * ========================================================== */

const FRAME_COLORS = ['#7c8cff', '#5b9dff', '#6fdc9f', '#f2c14e', '#e0674f', '#c77dff'];
const ED_ZOOM_MIN = .25;
const ED_ZOOM_MAX = 2.2;

const Editor = {
  gesture: '',          // '' | pan | marquee | node | frame | frameResize
  selection: new Set(), // 选中的节点 id
  frameSel: null,       // 选中的注释面板 id
  spaceDown: false,
  marquee: null,        // { x0, y0, x1, y1, base:Set }（client 坐标）
  drag: null,           // 当前拖动上下文
};

/* ---------------- 小工具 ---------------- */
function edRgba(hex, a){
  const h = String(hex || '').replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(v.slice(0, 6), 16);
  if(isNaN(n)) return 'rgba(124,140,255,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function edCanvasEl(){ return $('bpCanvas'); }
function edActiveView(){
  const v = $('blueprintView');
  return !!v && !v.classList.contains('hidden');
}
function edRectOfPoints(a, b){
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function edOverlap(a, b){
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
/* 节点在世界坐标里的矩形。尺寸取 DOM 实测（内容会撑高），坐标取模型值。 */
function edNodeRect(n){
  const el = $('n-' + n.id);
  return { x: n.x, y: n.y, w: el ? el.offsetWidth : 224, h: el ? el.offsetHeight : 80 };
}
function edApplyNodePos(n){
  const el = $('n-' + n.id);
  if(!el) return;
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
}
function edSetPanning(on, cls){
  const c = edCanvasEl();
  if(!c) return;
  c.classList.toggle('panning', !!on && cls !== 'space');
  c.classList.toggle('space-pan', !!on && cls === 'space');
}

/* ---------------- 注释面板数据 ---------------- */
function edFrames(){
  if(!bp) return [];
  if(!Array.isArray(bp.frames)) bp.frames = [];
  return bp.frames;
}
function edFrameById(id){
  return edFrames().find(f => f.id === id) || null;
}
/* 面板里「框住的节点」：以节点中心点是否落在面板矩形内为准（和专业编辑器一致） */
function edNodesInsideFrame(f){
  if(!bp || !f) return [];
  return bp.nodes.filter(n => {
    const r = edNodeRect(n);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
  });
}
function edAddFrame(rect, title){
  if(!bp) return null;
  const f = {
    id: uid(),
    title: title || '注释',
    color: FRAME_COLORS[edFrames().length % FRAME_COLORS.length],
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.max(160, Math.round(rect.w)), h: Math.max(96, Math.round(rect.h)),
  };
  edFrames().push(f);
  Editor.frameSel = f.id;
  renderFrames();
  scheduleFlowSave();
  const input = document.querySelector('#f-' + f.id + ' .frame-title');
  if(input){
    input.focus();
    input.select();
  }
  return f;
}

/* ---------------- 选择 ---------------- */
function edSelectedIds(){ return Array.from(Editor.selection); }
function edPruneSelection(){
  if(!bp){ Editor.selection = new Set(); Editor.frameSel = null; return; }
  const alive = new Set(bp.nodes.map(n => n.id));
  Array.from(Editor.selection).forEach(id => { if(!alive.has(id)) Editor.selection.delete(id); });
  if(Editor.frameSel && !edFrameById(Editor.frameSel)) Editor.frameSel = null;
}
function edSyncSelectionInfo(){
  const box = $('bpSelInfo');
  if(!box) return;
  const n = Editor.selection.size;
  let txt = '';
  if(n) txt = n + ' 个节点已选 · 按 C 建注释面板';
  else if(Editor.frameSel) txt = '已选中注释面板 · 拖动标题栏可连同节点移动';
  box.textContent = txt;
  box.classList.toggle('hidden', !txt);
}
function edSyncSelectionDom(){
  if(!bp) return;
  document.querySelectorAll('#bpNodes .node').forEach(el => {
    el.classList.toggle('sel', Editor.selection.has(el.dataset.id));
  });
  document.querySelectorAll('#bpFrames .bp-frame').forEach(el => {
    el.classList.toggle('sel', el.dataset.id === Editor.frameSel);
  });
  edSyncSelectionInfo();
}
/* ids 为空 = 清空。additive 时在 base 基础上追加 */
function edSelect(ids, opts){
  const o = opts || {};
  const base = o.additive ? (o.base || []) : [];
  const set = new Set(base);
  (ids || []).forEach(id => set.add(id));
  Editor.selection = set;
  if(!o.keepFrame) Editor.frameSel = o.frame || null;
  edSyncSelectionDom();
}
function edClearSelection(){
  Editor.selection = new Set();
  Editor.frameSel = null;
  edSyncSelectionDom();
}

/* ---------------- 视图变换 ---------------- */
function edSyncZoom(){
  const c = edCanvasEl();
  if(c){
    const s = 20 * bpZoom, S = 100 * bpZoom;
    c.style.backgroundSize = `${s}px ${s}px, ${s}px ${s}px, ${S}px ${S}px, ${S}px ${S}px`;
    c.style.backgroundPosition = `${bpPan.x}px ${bpPan.y}px, ${bpPan.x}px ${bpPan.y}px, ${bpPan.x}px ${bpPan.y}px, ${bpPan.x}px ${bpPan.y}px`;
  }
  const chip = $('btnZoomReset');
  if(chip) chip.textContent = Math.round(bpZoom * 100) + '%';
}
function edZoomAt(factor, clientX, clientY){
  const c = edCanvasEl();
  if(!c) return;
  const r = c.getBoundingClientRect();
  const mx = clientX - r.left, my = clientY - r.top;
  const wx = (mx - bpPan.x) / bpZoom, wy = (my - bpPan.y) / bpZoom;
  const next = Math.min(ED_ZOOM_MAX, Math.max(ED_ZOOM_MIN, bpZoom * factor));
  if(Math.abs(next - bpZoom) < .0005) return;
  bpZoom = next;
  bpPan.x = mx - wx * bpZoom;
  bpPan.y = my - wy * bpZoom;
  applyBpTransform();
}
function edZoomCenter(factor){
  const c = edCanvasEl();
  if(!c) return;
  const r = c.getBoundingClientRect();
  edZoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}
function edZoomReset(){
  const c = edCanvasEl();
  if(!c) return;
  const r = c.getBoundingClientRect();
  edZoomAt(1 / bpZoom, r.left + r.width / 2, r.top + r.height / 2);
}

/* ---------------- 注释面板渲染 ---------------- */
function frameEl(f){
  const el = document.createElement('div');
  el.className = 'bp-frame';
  el.id = 'f-' + f.id;
  el.dataset.id = f.id;
  const c = f.color || FRAME_COLORS[0];
  el.style.left = f.x + 'px';
  el.style.top = f.y + 'px';
  el.style.width = f.w + 'px';
  el.style.height = f.h + 'px';
  el.style.setProperty('--frame-c', c);
  el.style.setProperty('--frame-line', edRgba(c, .45));
  el.style.setProperty('--frame-fill', edRgba(c, .06));
  el.style.setProperty('--frame-head', edRgba(c, .16));

  const head = document.createElement('div');
  head.className = 'frame-head';

  // 显式抓手：标题输入框要能正常点击编辑，所以给它留一块明确的拖动区
  const grip = document.createElement('span');
  grip.className = 'frame-grip';
  grip.title = '拖动面板（框住的节点会一起移动）';
  grip.textContent = '⋮⋮';

  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'frame-dot';
  dot.title = '换颜色';
  dot.addEventListener('click', e => {
    e.stopPropagation();
    const i = FRAME_COLORS.indexOf(f.color);
    f.color = FRAME_COLORS[(i + 1) % FRAME_COLORS.length];
    renderFrames();
    scheduleFlowSave();
  });

  const title = document.createElement('input');
  title.className = 'frame-title';
  title.value = f.title || '';
  title.placeholder = '注释标题';
  title.spellcheck = false;
  title.setAttribute('aria-label', '注释标题');
  title.addEventListener('pointerdown', e => e.stopPropagation());
  title.addEventListener('dblclick', e => e.stopPropagation());
  title.addEventListener('input', () => { f.title = title.value; scheduleFlowSave(); });
  title.addEventListener('keydown', e => {
    e.stopPropagation();
    if(e.key === 'Enter' || e.key === 'Escape') title.blur();
  });
  title.addEventListener('blur', () => { if(!title.value.trim()) f.title = '注释'; });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'frame-del';
  del.title = '删除注释面板（面板里的节点会保留）';
  del.textContent = '×';
  del.addEventListener('click', e => {
    e.stopPropagation();
    bp.frames = edFrames().filter(x => x.id !== f.id);
    if(Editor.frameSel === f.id) Editor.frameSel = null;
    renderFrames();
    scheduleFlowSave();
  });

  head.append(grip, dot, title, del);

  const res = document.createElement('div');
  res.className = 'frame-resize';
  res.title = '拖动调整大小';

  el.append(head, res);

  head.addEventListener('pointerdown', e => {
    if(e.button !== 0) return;
    if(e.target.closest('button') || e.target.closest('input')) return;
    e.preventDefault();
    e.stopPropagation();
    edBeginFrameDrag(e, f);
  });
  res.addEventListener('pointerdown', e => {
    if(e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    edBeginFrameResize(e, f);
  });
  return el;
}

function renderFrames(){
  const host = $('bpFrames');
  if(!host) return;
  host.innerHTML = '';
  if(!bp) return;
  edFrames().forEach(f => host.appendChild(frameEl(f)));
  edSyncSelectionDom();
}

/* ---------------- 手势：平移 ---------------- */
function edBeginPan(e){
  Editor.gesture = 'pan';
  Editor.drag = { sx: e.clientX, sy: e.clientY, ox: bpPan.x, oy: bpPan.y, kind: 'pan' };
  edSetPanning(true, Editor.spaceDown && e.button === 0 ? 'space' : '');
}
function edBeginMarquee(e){
  const additive = !!(e.shiftKey || e.ctrlKey || e.metaKey);
  Editor.gesture = 'marquee';
  Editor.marquee = {
    x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
    base: additive ? edSelectedIds() : []
  };
  if(!additive) edClearSelection();
  edUpdateMarqueeDom();
}
function edMarqueeWorld(){
  const m = Editor.marquee;
  if(!m) return null;
  const a = screenToWorld(m.x0, m.y0), b = screenToWorld(m.x1, m.y1);
  return edRectOfPoints(a, b);
}
function edUpdateMarqueeDom(){
  const el = $('bpMarquee');
  const m = Editor.marquee;
  if(!el) return;
  if(!m){ el.classList.add('hidden'); return; }
  const c = edCanvasEl().getBoundingClientRect();
  const x = Math.min(m.x0, m.x1) - c.left, y = Math.min(m.y0, m.y1) - c.top;
  const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
  el.classList.remove('hidden');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.classList.toggle('add', !!(m.base && m.base.length));
}
function edMarqueeHit(rect){
  const r = rect || edMarqueeWorld();
  if(!r || !bp) return [];
  if(r.w < 2 && r.h < 2) return [];
  return bp.nodes.filter(n => edOverlap(edNodeRect(n), r)).map(n => n.id);
}
function edEndMarquee(){
  const m = Editor.marquee;
  if(!m){ edUpdateMarqueeDom(); return; }
  // 必须先算命中（edMarqueeHit 依赖 Editor.marquee），再清状态
  const ids = edMarqueeHit();
  Editor.marquee = null;
  edUpdateMarqueeDom();
  edSelect(ids, { additive: true, base: m.base });
  if(ids.length) edSyncSelectionInfo();
}

/* ---------------- 手势：节点拖动 ---------------- */
function edBeginNodeDrag(e, n){
  if(!bp || !n || e.button !== 0) return;
  if(!Editor.selection.has(n.id)) edSelect([n.id], {});
  const items = edSelectedIds()
    .map(id => nodeById(id))
    .filter(Boolean)
    .map(x => ({ n: x, ox: x.x, oy: x.y }));
  Editor.gesture = 'node';
  Editor.drag = { kind: 'node', sx: e.clientX, sy: e.clientY, items, moved: false };
  document.body.classList.add('ed-dragging');
}
function edMoveNodeDrag(e){
  const d = Editor.drag;
  if(!d) return;
  const dx = (e.clientX - d.sx) / bpZoom;
  const dy = (e.clientY - d.sy) / bpZoom;
  if(!d.moved && Math.abs(dx) + Math.abs(dy) < .6) return;
  d.moved = true;
  d.items.forEach(it => {
    it.n.x = Math.round(it.ox + dx);
    it.n.y = Math.round(it.oy + dy);
    edApplyNodePos(it.n);
  });
  renderLinks();
}

/* ---------------- 手势：面板拖动 / 缩放 ---------------- */
function edBeginFrameDrag(e, f){
  const inside = edNodesInsideFrame(f);
  // 面板选中与节点选中互斥：面板被选中时 Delete 只删面板，
  // 所以这里不把节点塞进 selection，只用高亮提示「这些会跟着走」。
  Editor.frameSel = f.id;
  Editor.selection = new Set();
  edSyncSelectionDom();
  inside.forEach(n => {
    const el = $('n-' + n.id);
    if(el) el.classList.add('frame-member');
  });
  Editor.gesture = 'frame';
  Editor.drag = {
    kind: 'frame', f, sx: e.clientX, sy: e.clientY,
    ox: f.x, oy: f.y,
    items: inside.map(n => ({ n, ox: n.x, oy: n.y })),
    moved: false
  };
  document.body.classList.add('ed-dragging');
}
function edClearFrameMembers(){
  document.querySelectorAll('#bpNodes .node.frame-member').forEach(el => el.classList.remove('frame-member'));
}
function edMoveFrameDrag(e){
  const d = Editor.drag;
  if(!d) return;
  const dx = (e.clientX - d.sx) / bpZoom;
  const dy = (e.clientY - d.sy) / bpZoom;
  if(!d.moved && Math.abs(dx) + Math.abs(dy) < .6) return;
  d.moved = true;
  d.f.x = Math.round(d.ox + dx);
  d.f.y = Math.round(d.oy + dy);
  const fe = $('f-' + d.f.id);
  if(fe){ fe.style.left = d.f.x + 'px'; fe.style.top = d.f.y + 'px'; }
  d.items.forEach(it => {
    it.n.x = Math.round(it.ox + dx);
    it.n.y = Math.round(it.oy + dy);
    edApplyNodePos(it.n);
  });
  renderLinks();
}
function edBeginFrameResize(e, f){
  Editor.frameSel = f.id;
  edSyncSelectionDom();
  Editor.gesture = 'frameResize';
  Editor.drag = { kind: 'frameResize', f, sx: e.clientX, sy: e.clientY, ow: f.w, oh: f.h, moved: false };
}
function edMoveFrameResize(e){
  const d = Editor.drag;
  if(!d) return;
  const dx = (e.clientX - d.sx) / bpZoom;
  const dy = (e.clientY - d.sy) / bpZoom;
  d.moved = true;
  d.f.w = Math.max(160, Math.round(d.ow + dx));
  d.f.h = Math.max(96, Math.round(d.oh + dy));
  const fe = $('f-' + d.f.id);
  if(fe){ fe.style.width = d.f.w + 'px'; fe.style.height = d.f.h + 'px'; }
}

/* ---------------- 注释面板：入口 ---------------- */
function edCommentSelection(){
  if(!bp) return;
  const box = Editor.marquee ? edMarqueeWorld() : null;
  // 框选还没松手就按了 C：先把这次框选收尾，再按它的范围建面板
  if(Editor.marquee){
    edEndMarquee();
    Editor.gesture = '';
    Editor.drag = null;
  }
  const ids = edSelectedIds();
  let rect = null;
  if(box && (box.w > 8 || box.h > 8)){
    rect = box;                       // 框选进行中：严格按选框范围
  } else if(ids.length){
    rect = edBoundsOfNodes(ids);      // 已选中：按选中节点包围盒
  } else {
    bpToast('先左键拖出选框选中节点，再按 C 建注释面板');
    return;
  }
  const padX = 20, padTop = 44, padBottom = 20;
  const f = edAddFrame({
    x: rect.x - padX, y: rect.y - padTop,
    w: rect.w + padX * 2, h: rect.h + padTop + padBottom
  }, '注释');
  // 面板创建后把框住的节点选上，方便紧接着继续操作
  const inside = edNodesInsideFrame(f);
  if(inside.length) edSelect(inside.map(n => n.id), { keepFrame: true, frame: f.id });
  bpToast('已创建注释面板 · 改标题即可写注释，拖动标题栏会带上框内节点');
}
function edBoundsOfNodes(ids){
  const rects = (ids || []).map(id => nodeById(id)).filter(Boolean).map(edNodeRect);
  if(!rects.length) return { x: 0, y: 0, w: 200, h: 120 };
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  const x2 = Math.max(...rects.map(r => r.x + r.w));
  const y2 = Math.max(...rects.map(r => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/* ---------------- 复制 / 粘贴 / 副本 ---------------- */
/* 只保存「节点 + 节点之间的连线」：跨流程粘贴时变量、骨架节点都不该跟着过来 */
let edClipboard = null;

function edCopySelection(){
  if(!bp) return false;
  const ids = edSelectedIds();
  if(!ids.length) return false;
  const set = new Set(ids);
  edClipboard = {
    nodes: bp.nodes.filter(n => set.has(n.id)).map(n => JSON.parse(JSON.stringify(n))),
    links: bp.links.filter(l => set.has(l.from.node) && set.has(l.to.node))
      .map(l => ({ from:{ node:l.from.node, key:l.from.key }, to:{ node:l.to.node, key:l.to.key } }))
  };
  bpToast('已复制 ' + edClipboard.nodes.length + ' 个节点');
  return true;
}

function edPasteClipboard(){
  if(!bp || !edClipboard || !edClipboard.nodes.length) return false;
  const map = {};
  const created = edClipboard.nodes.map(src => {
    const n = JSON.parse(JSON.stringify(src));
    const old = n.id;
    n.id = uid();
    map[old] = n.id;
    // 运行时状态不跟着走：粘贴出来的是干净的节点
    n.status = '';
    n.error = '';
    n.out = {};
    delete n.reasoning;
    n.x = Math.round(n.x + 40);
    n.y = Math.round(n.y + 40);
    bp.nodes.push(n);
    return n.id;
  });
  edClipboard.links.forEach(l => {
    if(!map[l.from.node] || !map[l.to.node]) return;
    bp.links.push({
      id: uid(),
      from: { node: map[l.from.node], key: l.from.key },
      to: { node: map[l.to.node], key: l.to.key }
    });
  });
  renderNodes();
  edSelect(created, {});
  scheduleFlowSave();
  bpToast('已粘贴 ' + created.length + ' 个节点');
  return true;
}

/* ---------------- 删除 ---------------- */
function edDeleteSelection(){
  if(!bp) return;
  // 面板被选中时只删面板：面板里的节点是容器关系，不是选中关系
  if(Editor.frameSel){
    const before = edFrames().length;
    bp.frames = edFrames().filter(f => f.id !== Editor.frameSel);
    Editor.frameSel = null;
    if(bp.frames.length !== before){
      renderNodes();
      renderFrames();
      scheduleFlowSave();
      bpToast('已删除注释面板（框内的节点保留）');
    } else {
      edSyncSelectionDom();
    }
    return;
  }
  const ids = edSelectedIds();
  let blocked = 0, removed = 0;
  ids.forEach(id => {
    const n = nodeById(id);
    if(!n) return;
    if(n.type === 'start' || n.type === 'end'){
      const same = bp.nodes.filter(x => x.type === n.type);
      if(same.length <= 1){ blocked++; return; }
    }
    bp.nodes = bp.nodes.filter(x => x.id !== id);
    bp.links = bp.links.filter(l => l.from.node !== id && l.to.node !== id);
    removed++;
  });
  Editor.selection = new Set();
  if(removed){
    renderNodes();
    scheduleFlowSave();
  } else {
    edSyncSelectionDom();
  }
  if(blocked) bpToast('「任务开始 / 任务结束」是流程骨架，不可删除');
  else if(removed > 1) bpToast('已删除 ' + removed + ' 个节点');
}

/* ---------------- 指针事件总入口 ---------------- */
Editor.onCanvasPointerDown = function(e){
  if(!bp) return;
  // 中键：任何位置都进入平移（含节点上方），这是专业编辑器的通用手势
  if(e.button === 1){
    e.preventDefault();
    edBeginPan(e);
    return;
  }
  if(e.button !== 0) return;
  if(Editor.spaceDown){ e.preventDefault(); edBeginPan(e); return; }
  // 落在交互元素上：交给它们自己处理
  if(e.target.closest('.node') || e.target.closest('.bp-link') || e.target.closest('.var-menu')
    || e.target.closest('.bp-log') || e.target.closest('.bp-statusbar')
    || e.target.closest('.bp-toast')) return;
  edBeginMarquee(e);
};

Editor.onCanvasWheel = function(e){
  e.preventDefault();
  edZoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
};

function edOnPointerMove(e){
  if(!Editor.gesture) return;
  if(Editor.gesture === 'pan'){
    const d = Editor.drag;
    bpPan.x = d.ox + (e.clientX - d.sx);
    bpPan.y = d.oy + (e.clientY - d.sy);
    applyBpTransform();
    return;
  }
  if(Editor.gesture === 'marquee'){
    const m = Editor.marquee;
    if(!m) return;
    m.x1 = e.clientX; m.y1 = e.clientY;
    edUpdateMarqueeDom();
    const ids = edMarqueeHit();
    edSelect(ids, { additive: true, base: m.base });
    return;
  }
  if(Editor.gesture === 'node'){ edMoveNodeDrag(e); return; }
  if(Editor.gesture === 'frame'){ edMoveFrameDrag(e); return; }
  if(Editor.gesture === 'frameResize'){ edMoveFrameResize(e); return; }
}

function edOnPointerUp(){
  const g = Editor.gesture;
  const d = Editor.drag;
  Editor.gesture = '';
  Editor.drag = null;
  document.body.classList.remove('ed-dragging');
  edClearFrameMembers();
  edSetPanning(false);
  if(g === 'marquee'){ edEndMarquee(); return; }
  if((g === 'node' || g === 'frame' || g === 'frameResize') && d && d.moved) scheduleFlowSave();
}

/* ---------------- 键盘 ---------------- */
function edTypingTarget(el){
  if(!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
function edOnKeyDown(e){
  if(!bp || !edActiveView()) return;
  const typing = edTypingTarget(e.target);

  if(e.code === 'Space' && !typing && !e.repeat){
    Editor.spaceDown = true;
    edSetPanning(true, 'space');
  }
  if(typing) return;
  if(e.altKey) return;

  const k = e.key;
  if(e.ctrlKey || e.metaKey){
    if(k === 'a' || k === 'A'){ e.preventDefault(); edSelect(bp.nodes.map(n => n.id), {}); return; }
    if(k === 'c' || k === 'C'){ if(edCopySelection()) e.preventDefault(); return; }
    if(k === 'v' || k === 'V'){ if(edPasteClipboard()) e.preventDefault(); return; }
    if(k === 'd' || k === 'D'){
      e.preventDefault();
      if(edCopySelection()) edPasteClipboard();
      return;
    }
    return;
  }

  if(k === 'c' || k === 'C'){
    e.preventDefault();
    edCommentSelection();
  } else if(k === 'Delete' || k === 'Backspace'){
    e.preventDefault();
    edDeleteSelection();
  } else if(k === 'Escape'){
    if(Editor.marquee){ Editor.marquee = null; edUpdateMarqueeDom(); }
    if(Editor.gesture && Editor.gesture !== 'pan'){
      Editor.gesture = ''; Editor.drag = null;
      document.body.classList.remove('ed-dragging');
      edSetPanning(false);
    }
    edClearSelection();
  } else if(k === 'f' || k === 'F'){
    if(!e.shiftKey){ e.preventDefault(); fitView(); }
  } else if(k === '0' && e.shiftKey){
    e.preventDefault();
    edZoomReset();
  }
}
function edOnKeyUp(e){
  if(e.code === 'Space'){
    Editor.spaceDown = false;
    if(Editor.gesture !== 'pan') edSetPanning(false);
  }
}

/* ---------------- 生命周期 ---------------- */
Editor.beginNodeDrag = edBeginNodeDrag;
Editor.reset = function(){
  Editor.gesture = '';
  Editor.drag = null;
  Editor.marquee = null;
  Editor.selection = new Set();
  Editor.frameSel = null;
  edUpdateMarqueeDom();
  edSetPanning(false);
};
/* renderNodes 末尾调用：面板要跟着重画，选中态要回填 */
Editor.render = function(){
  if(!bp) return;
  edPruneSelection();
  renderFrames();
};
Editor.fit = function(){ fitView(); };
Editor.zoomIn = function(){ edZoomCenter(1.15); };
Editor.zoomOut = function(){ edZoomCenter(1 / 1.15); };
Editor.zoomReset = function(){ edZoomReset(); };
Editor.comment = function(){ edCommentSelection(); };
Editor.selectAll = function(){ if(bp) edSelect(bp.nodes.map(n => n.id), {}); };
Editor.copy = function(){ return edCopySelection(); };
Editor.paste = function(){ return edPasteClipboard(); };
Editor.deleteSelection = function(){ edDeleteSelection(); };
Editor.selectionCount = function(){ return Editor.selection.size; };

/* ---------------- 事件安装 ---------------- */
(function edInstall(){
  const c = edCanvasEl();
  if(c){
    c.addEventListener('pointerdown', e => Editor.onCanvasPointerDown(e));
    c.addEventListener('wheel', e => Editor.onCanvasWheel(e), { passive: false });
    // 中键默认行为（Edge/Chrome 的自动滚动、Linux 的中键粘贴）必须按住
    c.addEventListener('mousedown', e => { if(e.button === 1) e.preventDefault(); });
    c.addEventListener('auxclick', e => { if(e.button === 1) e.preventDefault(); });
    c.addEventListener('contextmenu', e => { if(e.button === 1) e.preventDefault(); });
  }
  window.addEventListener('pointermove', edOnPointerMove);
  window.addEventListener('pointerup', edOnPointerUp);
  window.addEventListener('pointercancel', edOnPointerUp);
  window.addEventListener('keydown', edOnKeyDown);
  window.addEventListener('keyup', edOnKeyUp);
  window.addEventListener('blur', () => {
    Editor.spaceDown = false;
    edSetPanning(false);
  });
})();

window.Editor = Editor;
window.FRAME_COLORS = FRAME_COLORS;
window.edSyncZoom = edSyncZoom;
window.renderFrames = renderFrames;
window.edCommentSelection = edCommentSelection;
