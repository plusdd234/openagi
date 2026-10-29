/* 虚拟机桌面
 * 原 index.html 2952-4381 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ======================= 虚拟机桌面 =======================
const DESK_GLYPH = {
  chat: '<path d="M4 5h16v10H9l-5 4V5Z"/>',
  t2i: '<rect x="3.5" y="4.5" width="17" height="14" rx="2.5"/><circle cx="8.6" cy="9.6" r="1.4"/><path d="m4.5 16.5 4.6-4 3.4 2.7 3-2.2 4 3.5"/>',
  i2i: '<rect x="3.5" y="7.5" width="10.5" height="10.5" rx="2"/><path d="M8.5 4.5h7.5a2 2 0 0 1 2 2v7.5"/><path d="m8 14 2.2-2.2 1.6 1.6 1.4-1.4"/>',
  flow: '<rect x="3.5" y="4.5" width="6" height="5" rx="1.4"/><rect x="14.5" y="14.5" width="6" height="5" rx="1.4"/><path d="M9.5 7h3.5a3 3 0 0 1 3 3v4.5"/><path d="M6.5 9.5v3a2 2 0 0 0 2 2h1.5"/>',
  model: '<rect x="5" y="8.5" width="14" height="14" rx="2.5"/><rect x="8.5" y="12" width="7" height="7" rx="1.5"/><path d="M12 5v3.5M12 18.5V22M5 12H1.5M22.5 12H19M5 19H1.5M22.5 19H19"/>',
  /* 本地生图用「节点连线图」做图标：ComfyUI 的心智就是拖节点连成一张图，
   * 比再造一个抽象齿轮更容易让人知道点进去是什么。 */
  comfy: '<rect x="2.5" y="4" width="7" height="5.2" rx="1.5"/><rect x="14.5" y="4" width="7" height="5.2" rx="1.5"/><rect x="8.5" y="15" width="7" height="5.2" rx="1.5"/><path d="M9.5 6.6h5"/><path d="M6 9.2v3.6a2.2 2.2 0 0 0 2.2 2.2h.3"/><path d="M18 9.2v3.6a2.2 2.2 0 0 1-2.2 2.2h-.3"/>',
  /* 图库用「两列画框」：和图像节点、文生图那几个单图图标区分开，
   * 一眼能看出这是「很多张图」而不是「一张图」。 */
  gallery: '<rect x="3" y="4.4" width="7.6" height="7.6" rx="1.6"/><rect x="13.4" y="4.4" width="7.6" height="7.6" rx="1.6"/><rect x="3" y="14.9" width="7.6" height="5.6" rx="1.6"/><rect x="13.4" y="14.9" width="7.6" height="5.6" rx="1.6"/>',
  /* 模型库用线框立方体：3D 资产的通用符号。 */
  modelLib: '<path d="M12 2.9 20 7.2v9.6L12 21.1 4 16.8V7.2l8-4.3Z"/><path d="M4 7.2l8 4.3 8-4.3"/><path d="M12 11.5v9.6"/>',
  /* 播放器用「屏幕 + 播放三角」：别用纯三角，那个和上面的文档/流程图标太像；
   * 带屏幕边框才一眼看出是「播片」的 App。 */
  video: '<rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6"/><path d="m10 9.2 5.2 2.8-5.2 2.8z"/>',
  /* 名片用「证件卡」：卡片框 + 头像 + 右侧两行信息，是「自我介绍」的通用符号。
   * 别用「人形剪影」——那个在通讯录类 App 里太泛滥，和这里的开发者名片不是一件事。 */
  card: '<rect x="2.6" y="4.8" width="18.8" height="14.4" rx="2.6"/><circle cx="8.4" cy="10.8" r="2.1"/><path d="M5.2 16.4c.5-1.6 1.8-2.5 3.2-2.5s2.7.9 3.2 2.5"/><path d="M14.4 9.8h4.2M14.4 13.2h4.2"/>',
  /* 多视图用「一个模型 + 四向视线」：中心是模型，四个方向的短线表示从前后左右看。
   * 不能再用四宫格——那跟图库的两列画框几乎一样，摆一起就分不清谁是谁。 */
  mv: '<rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.6"/><path d="M12 2.6v3.4M12 18v3.4M2.6 12h3.4M18 12h3.4"/>'
};
function deskSvg(kind){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (DESK_GLYPH[kind] || DESK_GLYPH.flow) + '</svg>';
}

const DESK_APPS = [
  /* AI 对话：和其他 App 一样双击图标翻到 App 页，不再是独立的「第二页」。
   * 原来它有一套自己的翻页规则（.desk-wall.chat-open + .desk-page-2），
   * 返回按钮、动效、页头全和别的 App 对不上——用户提出的就是这个不一致。
   * 统一成 App 之后：翻页动效、<< 返回按钮、标题栏全都跟其他 App 同一套。 */
  { id:'chat', name:'AI 对话', glyph:'chat', type:'system', open: () => { if(typeof window.deskChat !== 'undefined' && typeof window.deskChat.open === 'function') window.deskChat.open(); } },
  /* 模型商店用 Ollama 的羊驼头做图标：这张图是「本地模型」这件事的通用符号，
   * 比再画一个抽象图标更容易一眼认出来。png 放在 vendor 里随内容包一起分发。 */
  { id:'store', name:'模型商店', icon:'<img class="desk-app-img" src="vendor/ollama-llama.png" alt="" draggable="false">', type:'system', open: () => { if(typeof openModelStore === 'function') openModelStore(); } },
  /* ComfyUI 单独成 app：它自带安装/启动/端口/网页界面，塞在模型控制台的小方块里
   * 用户既不知道点哪里也看不清状态。装生图模型前先把这个引擎跑起来是最自然的顺序，
   * 所以摆在模型商店旁边。 */
  { id:'comfy', name:'本地生图', glyph:'comfy', type:'system', open: () => { if(typeof openComfyApp === 'function') openComfyApp(); } },
  /* 图库 / 模型库：资产的去处。挨着两个引擎图标，形成「造东西的」和「存东西的」两排。 */
  { id:'gallery', name:'图库', glyph:'gallery', type:'system', open: () => { if(typeof openLibrary === 'function') openLibrary('image'); } },
  { id:'modelLib', name:'模型库', glyph:'modelLib', type:'system', open: () => { if(typeof openLibrary === 'function') openLibrary('model'); } },
  /* 播放器：和图库配对——图库里是「造出来的图」，播放器里是「攒下来的影音」。
   * 它只播本地已有的文件（媒体库目录），不负责去网上抓内容。 */
  { id:'player', name:'播放器', glyph:'video', type:'system', open: () => {
    if(typeof window.playerApp !== 'undefined' && typeof window.playerApp.open === 'function') window.playerApp.open();
  } },
  /* 「对话 / 文生图 / 图生图」三个单步工具 App 与「基线工具」界面已整块移除：
   * 对话有底部 AI 输入条（翻页即对话页）、生图有工作流节点与本地 ComfyUI，
   * 再留一套单步面板是重复入口。 */
  /* 「工作流」App 已移除：左侧固定列表就是全部工作流，再摆一个桌面 App 是重复入口 */
  { id:'models', name:'模型',  glyph:'model', type:'system', open: () => {
    const m = DESK_APP_META.models;
    deskMountApp($('modelsWin'), m.title, m.sub);
    if(typeof renderModelsConsole === 'function') renderModelsConsole();
  } },
  /* 多视图：挨着「模型」放——模型是输入，多视图是把它摊开看的工具。
   * 它也是唯一一个**同时有独立页**的 App（multiview.html，双击就能用、不需要桌面），
   * 两边的 DOM 与逻辑共用，别在这里另写一套。 */
  { id:'multiview', name:'多视图', glyph:'mv', type:'system', open: () => {
    if(typeof window.multiview !== 'undefined' && typeof window.multiview.open === 'function') window.multiview.open();
  } },
  /* 名片：放最后一位。它不是「做东西」的 App，是「关于这个人」的 App——
   * 按使用频率排最后，但位置要固定，否则用户每次都要找。 */
  { id:'card', name:'名片', glyph:'card', type:'system', open: () => {
    if(typeof window.devCard !== 'undefined' && typeof window.devCard.open === 'function') window.devCard.open();
  } }
];
function deskAppById(id){ return DESK_APPS.find(a => a.id === id); }

let deskPos = {};
try { deskPos = JSON.parse(localStorage.getItem('hf_desk_pos') || '{}') || {}; } catch(e){ deskPos = {}; }

function deskStateOf(id){
  // 本地生图：引擎在跑才算就绪（橙点 = 引擎没启动，和「对话未配置」是同一套语义）
  if(id === 'comfy') return (typeof cfState === 'object' && cfState) ? !!cfState.running : null;
  return null;
}
function saveDeskPos(){
  try { localStorage.setItem('hf_desk_pos', JSON.stringify(deskPos)); } catch(e){}
}
/* ---------- 桌面格子：图标永远吸附到格位，不再自由落点 ----------
 * 格子尺寸 = 图标实际尺寸 + 间距；拖动时实时吸附，落到被占格位时与原图标互换位置。 */
const DESK_CELL = { w: 104, h: 104 };
const DESK_ROW = 5;   // 首屏默认一行几个图标

/* 图标画布：拖拽与格子都以「图标容器」为边界。
 * 图标是相对 #deskIcons 绝对定位的，只有用它算边界才不会出现
 * 「松手后被吸到灰底外面 / 被画布裁掉」这类错位。 */
function deskCanvasEl(){
  return $('deskIcons') || $('deskCanvas') || $('deskWall');
}

function deskGridBounds(el){
  const wall = deskCanvasEl();
  const w = el ? el.offsetWidth : 92;
  const h = el ? el.offsetHeight : 92;
  return {
    maxCol: wall ? Math.max(0, Math.floor((wall.clientWidth - w) / DESK_CELL.w)) : 6,
    maxRow: wall ? Math.max(0, Math.floor((wall.clientHeight - h) / DESK_CELL.h)) : 4
  };
}
function deskCellOf(x, y){
  return { col: Math.round(x / DESK_CELL.w), row: Math.round(y / DESK_CELL.h) };
}
function deskPosOfCell(cell){
  return { x: cell.col * DESK_CELL.w, y: cell.row * DESK_CELL.h };
}
function deskClampCell(col, row, el){
  const g = deskGridBounds(el);
  return { col: Math.min(Math.max(0, col), g.maxCol), row: Math.min(Math.max(0, row), g.maxRow) };
}
function deskCellKey(cell){ return cell.col + ',' + cell.row; }
/* 从 start 开始扫描，找到第一个未被占用的格位。
 * 必须环形扫描：老写法 idx++ 到行尾就 row++ 并 break，永远回不到本行行首，
 * 于是格子紧张时（比如画布只有 2 行 7 列）后面几个图标会全部叠到 (0,0)。 */
function deskNextFreeCell(start, el, taken){
  const g = deskGridBounds(el);
  const cols = g.maxCol + 1;
  const total = cols * (g.maxRow + 1);
  let idx = Math.min(start.row, g.maxRow) * cols + Math.min(start.col, g.maxCol);
  for(let t = 0; t < total; t++){
    const cell = { col: idx % cols, row: Math.floor(idx / cols) };
    if(!taken.has(deskCellKey(cell))) return cell;
    idx = (idx + 1) % total;
  }
  return { col: 0, row: 0 };
}

function selectDeskApp(id){
  document.querySelectorAll('.desk-app').forEach(el => el.classList.toggle('sel', el.dataset.app === id));
}
function clearDeskSel(){
  document.querySelectorAll('.desk-app.sel').forEach(el => el.classList.remove('sel'));
}

function renderDeskIcons(){
  const wrap = $('deskIcons');
  if(!wrap) return;
  wrap.innerHTML = '';
  const taken = new Set();
  DESK_APPS.forEach((app, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'desk-app';
    el.dataset.app = app.id;
    el.title = app.name;
    const saved = deskPos[app.id];
    el.innerHTML = `
      <span class="desk-app-icon">
        ${app.icon || deskSvg(app.glyph)}
        ${deskStateOf(app.id) === null ? '' : '<span class="desk-app-state"></span>'}
      </span>
      <span class="desk-app-label">${app.name}</span>`;
    wrap.appendChild(el);
    // 默认从画布左上角开始排（老的 +半格 偏移会让首屏图标整体缩进一格）
    // 一行放 DESK_ROW 个：现在是 5 个 App，正好排满一行，不会剩下孤零零一个。
    const cell = deskNextFreeCell(
      deskCellOf(saved ? saved.x : (i % DESK_ROW) * DESK_CELL.w,
                 saved ? saved.y : Math.floor(i / DESK_ROW) * DESK_CELL.h), el, taken);
    taken.add(deskCellKey(cell));
    const p = deskPosOfCell(cell);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    pinDeskDrag(el, app);
  });
  refreshDeskStates();
}

function refreshDeskStates(){
  document.querySelectorAll('.desk-app[data-app]').forEach(el => {
    const ok = deskStateOf(el.dataset.app);
    if(ok === null) return;
    const dot = el.querySelector('.desk-app-state');
    // 统一用平面金黄（--gold）：就绪用实色，未就绪压到 45% 透明。
    // 不再用绿/棕两色——参考图里所有小点都是同一支黄。
    if(dot) dot.style.background = ok ? '' : 'rgba(240,180,41,.45)';
  });
}

function pinDeskDrag(el, app){
  let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false, fromCell = null;
  el.addEventListener('pointerdown', e => {
    if(e.button) return;
    active = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const cs = getComputedStyle(el);
    ox = parseFloat(cs.left) || 0; oy = parseFloat(cs.top) || 0;
    fromCell = deskCellOf(ox, oy);
    selectDeskApp(app.id);
    try { el.setPointerCapture(e.pointerId); } catch(err){}
  });
  el.addEventListener('pointermove', e => {
    if(!active) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if(!moved){
      if(Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      el.classList.add('dragging');
    }
    e.preventDefault();
    // 跟手移动：图标实时跟随指针（像抓住一样），不提前吸附格子
    const wall = deskCanvasEl();
    const maxX = wall ? Math.max(0, wall.clientWidth - el.offsetWidth) : Infinity;
    const maxY = wall ? Math.max(0, wall.clientHeight - el.offsetHeight) : Infinity;
    el.style.left = Math.min(Math.max(0, ox + dx), maxX) + 'px';
    el.style.top = Math.min(Math.max(0, oy + dy), maxY) + 'px';
  });
  const end = () => {
    if(!active) return;
    active = false;
    el.classList.remove('dragging');
    if(!moved) return;
    // 落点格位：松开后吸附到最近的格子；被别的图标占着就互换，否则空着就放
    const target = deskClampCell(deskCellOf(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0).col,
                                 deskCellOf(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0).row, el);
    const p = deskPosOfCell(target);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    const tkey = deskCellKey(target);
    document.querySelectorAll('.desk-app[data-app]').forEach(other => {
      if(other === el) return;
      const oc = deskCellOf(parseFloat(other.style.left) || 0, parseFloat(other.style.top) || 0);
      if(deskCellKey(oc) !== tkey) return;
      const oid = other.dataset.app;
      const back = deskPosOfCell(fromCell || oc);
      other.style.left = back.x + 'px';
      other.style.top = back.y + 'px';
      deskPos[oid] = back;
    });
    deskPos[app.id] = deskPosOfCell(target);
    saveDeskPos();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', e => {
    e.preventDefault();
    if(!moved) openDeskApp(app.id);
  });
  el.addEventListener('keydown', e => { if(e.key === 'Enter') openDeskApp(app.id); });
}

/* Dock（底部应用条）已从 index.html 移除：桌面图标本身就是全部入口。
 * 函数保留是为了「找不到容器就什么都不做」，不至于让 renderHome 里的调用炸掉。 */
function renderDeskDock(){
  const dock = $('deskDock');
  if(!dock) return;
  dock.innerHTML = '';
  const addApp = app => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dock-app';
    b.title = app.name;
    b.setAttribute('aria-label', app.name);
    b.innerHTML = deskSvg(app.glyph);
    b.addEventListener('click', () => openDeskApp(app.id));
    dock.appendChild(b);
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'dock-sep'; dock.appendChild(s); };
  DESK_APPS.filter(a => a.type === 'tool').forEach(addApp);
  sep();
  DESK_APPS.filter(a => a.type === 'system').forEach(addApp);
  sep();
  const clock = document.createElement('span');
  clock.className = 'dock-clock';
  clock.id = 'deskClock';
  clock.textContent = deskClockText();
  dock.appendChild(clock);
}

function deskClockText(){
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

let deskClockTimer = 0;
function startDeskClock(){
  if(deskClockTimer) return;
  // 钟表挂在 Dock 上，Dock 没了就别再空转定时器
  if(!$('deskClock')) return;
  deskClockTimer = setInterval(() => {
    const c = $('deskClock');
    if(c) c.textContent = deskClockText();
  }, 15000);
}

/* 打开 App：**先翻页，再加载**。
 * 各模块的 open() 一进去就同步建卡 / 扫描 / 探测（模型商店 19 张卡、图库全量重扫、
 * 控制台把所有引擎探一遍），以前是跟翻页同一帧开跑，主线程被占住，翻页就掉帧。
 * 现在翻页只做「搬节点 + 切 class」，重活等动画播完再上；第一次打开期间盖一层骨架，
 * 免得窗口空着。第二次打开有上次的内容顶着，不再盖。 */
const DESK_FLIP_MS = 520;      // 与 .desk-page 的 transform 过渡时长一致
let deskAppLoadTimer = 0, deskAppLoadRaf = 0;
/* 加载批次号：翻页期间用户可能又翻到别的 App（或直接关掉），
 * 旧的那批 setTimeout 一到点就会把页面抢回去——所以每次作废都推进批次，
 * 回调里对不上号就直接放弃。 */
let deskAppSeq = 0;

function deskCancelAppLoad(){
  cancelAnimationFrame(deskAppLoadRaf);
  clearTimeout(deskAppLoadTimer);
  deskAppLoadRaf = deskAppLoadTimer = 0;
  deskAppSeq++;
}

/* 骨架层：只切 hidden / opacity，不碰布局，撤的时候两帧内就干净
 * （旧版是给窗口挂一张 ::after 扫光，动的 background-position 要主线程重绘，
 *   模块一开始干活就冻在半路——用户看到的就是「波浪条卡在中间」） */
let deskSkelTimer = 0;
function deskSkelShow(){
  const sk = $('deskAppSkel');
  if(!sk) return;
  clearTimeout(deskSkelTimer);
  sk.classList.remove('is-out');
  if(sk.hidden){
    sk.hidden = false;
    void sk.offsetWidth;   // 先落屏再改透明度，过渡才有起点
  }
}
function deskSkelHide(){
  const sk = $('deskAppSkel');
  if(!sk || sk.hidden) return;
  clearTimeout(deskSkelTimer);
  sk.classList.add('is-out');
  deskSkelTimer = setTimeout(() => {
    sk.hidden = true;
    sk.classList.remove('is-out');
  }, 210);
}

function openDeskApp(id){
  const app = deskAppById(id);
  if(!app || typeof app.open !== 'function') return;
  const meta = DESK_APP_META[id];
  const win = meta && meta.win ? $(meta.win) : null;
  // 没有 App 页（或窗口不在）时退回原来的直接打开
  if(!win || !deskMountApp(win, meta.title, meta.sub)){
    deskCancelAppLoad();
    app.open();
    return;
  }
  // 第一次打开才盖骨架；第二次窗口里已经有上次的内容顶着，不该再被遮
  const first = win.dataset.loaded !== '1';
  win.classList.toggle('app-loading', first);
  if(first) deskSkelShow();
  const seq = deskAppSeq;                 // deskMountApp 里已经作废过上一批，这里取新号
  // 等这一帧画完（翻页已经开跑）再排定时器：动画期间主线程尽量空着
  deskAppLoadRaf = requestAnimationFrame(() => {
    deskAppLoadTimer = setTimeout(() => {
      if(seq !== deskAppSeq || deskAppWin !== win) return;   // 期间翻了别的 App，这批活作废
      let ret;
      try { ret = app.open(); } catch(e){ console.warn('[app] 打开失败', e); }
      win.dataset.loaded = '1';
      deskSkelWatch(win, ret);
    }, DESK_FLIP_MS);
  });
}

/* 什么时候撤骨架？**模块真的画出东西**才算数。
 * 只看「同步那段跑完了」会漏：模块可能先 await 网络，窗口里一个节点都没有，
 * 骨架一撤就剩一块白板（用户看到的就是「载入中突然没了、界面还空着」）。
 * 所以盯三件事：DOM 有变化（模块开始渲染）／open() 的 promise 落定／兜底 3 秒。 */
function deskSkelWatch(win, ret){
  let settled = false;
  if(ret && typeof ret.then === 'function'){
    ret.then(() => { settled = true; }, () => { settled = true; });
  }
  const t0 = performance.now();
  const finish = () => {
    win.classList.remove('app-loading');
    deskSkelHide();
  };
  let mo = null;
  if(window.MutationObserver){
    mo = new MutationObserver(() => {
      // 等这一批 DOM 写完、画上屏再撤
      requestAnimationFrame(() => { if(mo) mo.disconnect(); finish(); });
    });
    mo.observe(win, { childList: true, subtree: true, characterData: true });
  }
  const tick = () => {
    if(win !== deskAppWin){ if(mo) mo.disconnect(); return; }   // 已经翻走了，别再管
    if(settled || win.scrollHeight > 160){ if(mo) mo.disconnect(); finish(); return; }
    if(performance.now() - t0 > 3000){ if(mo) mo.disconnect(); finish(); return; }
    setTimeout(tick, 120);
  };
  setTimeout(tick, 120);
}

function closeModelsWin(){
  deskCloseWin($('modelsWin'));
}

/* ---------- App 页：双击图标整页翻过去，不再是浮在桌面上的弹窗 ----------
 * 各 App 的内部实现仍是原来的 .os-win（模块里按 id 取元素、按 closest('.os-win')
 * 找容器，都不依赖它在 DOM 的哪一层），这里只负责把窗口节点搬进 #deskAppHost
 * 并在关闭时原样放回，所以打开逻辑与内容代码一行都不用改。 */
const DESK_APP_META = {
  chat:     { title: 'AI 对话', sub: '问点什么，或让它画一张', win: 'chatWin'  },
  store:    { title: '模型商店', sub: '安装 / 删除本地模型', win: 'storeWin'  },
  comfy:    { title: '本地生图', sub: 'ComfyUI 引擎',        win: 'comfyWin'  },
    gallery:  { title: '图库',     sub: '生成结果与素材',      win: 'libWin'    },
    modelLib: { title: '模型库',   sub: '本机模型文件',        win: 'libWin'    },
    player:   { title: '播放器',   sub: '本地的视频与音频',    win: 'playerWin' },
    multiview:{ title: '多视图',   sub: '模型转三视图 / 六视图 / 八视图', win: 'mvWin' },
    card:     { title: '名片',     sub: '作者与联系方式',      win: 'cardWin'   },
  models:   { title: '模型',     sub: '引擎与 Provider',     win: 'modelsWin' }
};
let deskAppWin = null;                    // 当前挂在 App 页里的窗口
const deskAppHome = new WeakMap();        // 窗口节点 → 原来的父节点 / 下一个兄弟

/* 把窗口搬进 App 页并翻过去。meta 不传就按窗口 id 反查 DESK_APP_META。 */
function deskMountApp(win, title, sub){
  if(!win) return false;
  const host = $('deskAppHost');
  if(!host){ win.classList.remove('hidden'); return false; }   // 壳里没有 App 页时退回弹窗
  deskCancelAppLoad();        // 换页了：上一批延迟加载作废（模块也会直接调本函数，不只 openDeskApp）
  deskCancelRestore();        // 上一次「返回」还没搬完节点的话，别再插一脚
  deskSkelHide();             // 上一页残留的骨架先撤（openDeskApp 紧接着会按需重开）
  if(deskAppWin && deskAppWin !== win) deskAppRestore(deskAppWin);
  if(!deskAppHome.has(win)) deskAppHome.set(win, { parent: win.parentElement, next: win.nextSibling });
  // 已经在 App 页里就别再 appendChild：同一个节点重新插入会多一次布局与重绘
  if(win.parentElement !== host) host.appendChild(win);
  win.classList.remove('hidden');
  deskAppWin = win;
  /* 窗口归属变了，广播一次：对话 App 的输入条要跟着窗口搬（桌面底部 ↔ 对话窗口底部）。
     绑在窗口生命周期上而不是绑在「用户点了哪个按钮」上——
     返回按钮（#deskAppBack）走的是 deskAppLeave()，它不经过对话模块自己的 close，
     靠事件才能保证输入条一定会被搬回桌面，不会跟着窗口一起被隐藏。 */
  try{ window.dispatchEvent(new CustomEvent('openagi:app-mounted', { detail: { win: win.id || '' } })); }catch(e){}
  const wall = $('deskWall');
  if(wall){
    /* 翻页状态只留一个（app-open），免得两页同时翻过来。
       对话以前有自己那套 chat-open，现在它也是普通 App，走同一条路。 */
    wall.classList.remove('chat-open');
    wall.classList.add('app-open');
  }
  const t = $('deskAppTitle');
  if(t) t.textContent = title || '应用';
  const s = $('deskAppSub');
  if(s){ s.textContent = sub || ''; s.hidden = !sub; }
  return true;
}

/* 隐藏窗口并放回搬迁前的位置（父节点没了就退回桌面层，绝不把节点丢掉） */
function deskAppRestore(win){
  if(!win) return;
  const home = deskAppHome.get(win);
  deskAppHome.delete(win);
  win.classList.remove('app-loading');   // 加载还没跑就被关掉时，别把骨架留在节点上
  win.classList.add('hidden');
  try{ window.dispatchEvent(new CustomEvent('openagi:app-restored', { detail: { win: win.id || '' } })); }catch(e){}
  if(home && home.parent && home.parent.isConnected){
    home.parent.insertBefore(win, (home.next && home.next.parentNode === home.parent) ? home.next : null);
  }else{
    const wall = $('deskWall');
    if(wall) wall.appendChild(win);
  }
}

/* 返回桌面：把当前 App 放回原位、撤掉翻页状态。
 * 卸载也分两拍：这一帧只改 class（翻页立刻开跑），节点搬运那一拍挪到下一帧，
 * 免得「切 class + 重排整面墙」挤在同一帧里，起手就顿一下。 */
let deskRestoreRaf = 0;
function deskCancelRestore(){
  if(deskRestoreRaf) cancelAnimationFrame(deskRestoreRaf);
  deskRestoreRaf = 0;
}
function deskAppLeave(){
  if(!deskAppWin) return false;
  const win = deskAppWin;
  deskAppWin = null;
  deskCancelAppLoad();          // 还没开跑的加载就别跑了
  deskSkelHide();               // 骨架一起淡掉，别跟着翻回去
  const wall = $('deskWall');
  if(wall) wall.classList.remove('app-open');
  deskCancelRestore();
  deskRestoreRaf = requestAnimationFrame(() => {
    deskRestoreRaf = 0;
    deskAppRestore(win);
  });
  return true;
}

/* 统一关闭入口：正显示在 App 页里的走翻页返回，其余（如图片编辑器弹窗）只隐藏 */
function deskCloseWin(win){
  if(!win) return;
  if(win === deskAppWin) deskAppLeave();
  else win.classList.add('hidden');
}

(function bindDeskAppPage(){
  const back = $('deskAppBack');
  if(back) back.addEventListener('click', () => deskAppLeave());
})();

$('deskWall').addEventListener('pointerdown', e => {
  // 空白处（外围白底 / 灰底画布 / 图标容器）点击都取消选中
  if(e.target === $('deskWall') || e.target === $('deskIcons') || e.target === $('deskCanvas')) clearDeskSel();
});

function taskPin(name, type){
  return { id: uid(), name, type };
}

/* 图像拆分节点的视图条目：每条生成两张输出引脚
   （id → 图像、id + '__has' → 布尔），name 为视图名，hint 为可选补充说明 */
function viewEntry(name, hint){
  return { id: uid(), name: name || '视图', hint: hint || '' };
}
const VIEW_PRESETS = ['正视图', '背视图', '左侧视图', '右侧视图', '顶视图', '底视图'];

/* AI 分支节点的出口条目：每条生成一条执行线出口引脚（key = id）
   name 为出口名（送 AI 判断，也是引脚标签），hint 为可选说明，fallback 标记为兜底出口 */
function branchEntry(name, hint){
  return { id: uid(), name: name || '出口', hint: hint || '', fallback: false };
}
const BRANCH_PRESETS = ['兜底', '重试', '跳过'];

// 旧版「图像分析 / 文本任务」节点统一迁移为「分析任务」，并重映射引脚
function migrateAiTaskNodes(flow){
  (flow.nodes || []).forEach(n => {
    if(n.type !== 'analyze' && n.type !== 'textTask') return;
    const old = n.type;
    const data = n.data || {};
    n.type = 'aiTask';
    n.data = {
      instruction: data.instruction || data.note || '',
      timeout: Number(data.timeout) || TASK_TIMEOUT_DEFAULT,
      inputs: old === 'analyze'
        ? [taskPin('图像', 'image'), taskPin('补充', 'string')]
        : [taskPin('文本', 'string'), taskPin('补充', 'string')],
      outputs: [taskPin('结果', 'string')]
    };
    const firstIn = n.data.inputs[0].id;
    const hintIn = n.data.inputs[1].id;
    const outPin = n.data.outputs[0].id;
    (flow.links || []).forEach(l => {
      if(l.from.node === n.id && l.from.key === 'text') l.from.key = outPin;
      if(l.to.node === n.id){
        if(l.to.key === 'image' || l.to.key === 'text') l.to.key = firstIn;
        else if(l.to.key === 'hint') l.to.key = hintIn;
      }
    });
  });
}

/* 执行模型调整后的旧流程迁移：
   图像 / 模型 / 文本 / 数值 / 布尔等输入节点已改为纯参数节点，不再提供执行输出。
   老流程里从它们拉出的执行线会变成悬空线（既画不出来，下游也永远不会被触发），
   这里直接清掉，避免用户看到「连了线却不执行」。 */
/* 旧「AI 分支」(aiBranch) 已并入「智能分支」(smartBranch)。
   迁移方式：固定引脚 text / image 转成动态输入，并把所有入边按新 id 重映射，老流程打开即用。 */
function migrateLegacyBranches(flow){
  let migrated = 0;
  (flow.nodes || []).forEach(n => {
    if(n.type !== 'aiBranch') return;
    migrated++;
    const data = n.data || {};
    n.type = 'smartBranch';
    if(!Array.isArray(data.inputs) || !data.inputs.length){
      const tIn = taskPin('文本', 'string');
      const iIn = taskPin('图像', 'image');
      data.inputs = [tIn, iIn];
      (flow.links || []).forEach(l => {
        if(l.to.node !== n.id) return;
        if(l.to.key === 'text') l.to.key = tIn.id;
        else if(l.to.key === 'image') l.to.key = iIn.id;
      });
    }
    data.instruction = data.instruction || '';
    data.timeout = Number(data.timeout) || 120;
    data.branches = Array.isArray(data.branches) ? data.branches : [];
    n.data = data;
  });
  return migrated;
}

/* 「IF 条件判断」已删除：转成「分析任务」（文本 → 布尔）。
   执行位置不变，下游「条件分支」照旧拿布尔值，连线按新引脚 id 重映射。 */
function migrateLegacyCondition(flow){
  let migrated = 0;
  (flow.nodes || []).forEach(node => {
    if(node.type !== 'condition') return;
    migrated++;
    const inPin = taskPin('文本', 'string');
    const outPin = taskPin('结果', 'bool');
    node.data = conditionToTaskData(node.data || {}, inPin.id, outPin.id);
    node.type = 'aiTask';
    (flow.links || []).forEach(l => {
      if(l.to.node === node.id && l.to.key === 'text') l.to.key = inPin.id;
      if(l.from.node === node.id && l.from.key === 'bool') l.from.key = outPin.id;
    });
  });
  return migrated;
}

function migrateExecLinks(flow){
  if(!flow || !Array.isArray(flow.links) || !Array.isArray(flow.nodes)) return 0;
  const before = flow.links.length;
  flow.links = flow.links.filter(l => {
    const src = flow.nodes.find(n => n.id === l.from.node);
    if(!src) return false;
    const d = NODE_DEFS[src.type];
    if(!d) return false;
    return !(l.from.key === 'exec' && !(d.execOut && d.execOut.length));
  });
  return before - flow.links.length;
}

function newNode(type, x, y){
  const n = { id: uid(), type, x, y, data: {}, out: {}, status: '' };
  // 默认值统一来自 flow-contract.js 的 seedNodeData：生成器与手工添加的节点必须同形，
  // 两处硬编码迟早会漂移（历史上已经踩过一次）。
  const seed = seedNodeData(type);
  n.data = seed.data;
  if(seed.params) n.params = seed.params;
  return n;
}

function newParam(name, type){
  const v = type === 'bool' ? true : (type === 'int' || type === 'float') ? 0 : '';
  return { id: uid(), name, type, value: v, fileName: '' };
}

function paramValue(p){
  if(p.type === 'int') return Math.trunc(Number(p.value) || 0);
  if(p.type === 'float') return Number(p.value) || 0;
  if(p.type === 'bool') return p.value !== false;
  if(p.type === 'string') return p.value == null ? '' : String(p.value);
  return p.value || '';
}

function coerceVar(v, val){
  if(v.type === 'int') return Math.trunc(Number(val) || 0);
  if(v.type === 'float') return Number(val) || 0;
  if(v.type === 'bool') return toBool(val);
  if(v.type === 'string') return val == null ? '' : String(val);
  return val == null ? '' : val;
}

function createFlow(){
  const s = newNode('start', 40, 100);
  const pIn = newParam('图像', 'image');
  s.params = [pIn];
  const b = newNode('aiTask', 350, 70);
  b.data.instruction = '诊断图像中的无意义结构，并拟写中性修复提示词。';
  b.data.inputs = [taskPin('图像', 'image'), taskPin('补充', 'string')];
  b.data.outputs = [taskPin('结果', 'string')];
  const bImg = b.data.inputs[0].id;
  const bOut = b.data.outputs[0].id;
  const c = newNode('imageGen', 660, 90);
  const e = newNode('end', 970, 70);
  const pOut = newParam('结果图像', 'image');
  e.params = [pOut];
  const flow = {
    id: uid(), name:'图像修复流程', nodes:[s, b, c, e], links:[
      { id: uid(), from:{ node:s.id, key:pIn.id }, to:{ node:b.id, key:bImg } },
      { id: uid(), from:{ node:b.id, key:bOut }, to:{ node:c.id, key:'prompt' } },
      { id: uid(), from:{ node:c.id, key:'image' }, to:{ node:e.id, key:pOut.id } },
      { id: uid(), from:{ node:s.id, key:'exec' }, to:{ node:b.id, key:'exec' } },
      { id: uid(), from:{ node:b.id, key:'exec' }, to:{ node:c.id, key:'exec' } },
      { id: uid(), from:{ node:c.id, key:'exec' }, to:{ node:e.id, key:'exec' } },
    ], updated: Date.now(), lastRun: null, vars: []
  };
  FLOWS.unshift(flow);
  persistFlows();
  openFlow(flow.id);
}

function openFlow(id){
  const found = FLOWS.find(f => f.id === id);
  if(!found) return;
  wfActiveId = id;
  bp = JSON.parse(JSON.stringify(found));
  bp.links = bp.links || [];
  bp.vars = Array.isArray(bp.vars) ? bp.vars : [];
  bp.frames = Array.isArray(bp.frames) ? bp.frames : [];
  migrateAiTaskNodes(bp);
  const _legacyMigrated = migrateLegacyBranches(bp) + migrateLegacyCondition(bp);
  migrateExecLinks(bp);
  // 迁移结果要落盘，否则每次打开都重跑一遍迁移（且列表里一直显示旧类型）
  if(_legacyMigrated) scheduleFlowSave();
  bp.nodes.forEach(n => {
    n.out = {};
    n.status = '';
    n.error = '';
    if((n.type === 'start' || n.type === 'end') && !Array.isArray(n.params)) n.params = [];
  });
  if(window.Editor) Editor.reset();
  $('bpName').value = bp.name || '';
  $('bpState').textContent = '';
  bpVarAddOpen = false;
  hideVarMenu();
  showView('bp');
  /* 转场期间主线程要空着：先把画布清空（清 innerHTML 很便宜），
     节点、连线、节点库都等翻完再建。否则 49 个节点 + 78 条连线同步建 DOM + 量尺寸，
     会把这 340ms 整段吃掉，动画变成「直接跳到终点」。 */
  viewCancelSwap();               // 连点两个流程时，前一轮没跑的渲染任务作废
  $('bpNodes').innerHTML = '';
  $('bpFrames').innerHTML = '';
  $('bpLinks').innerHTML = '';
  $('bpEmpty').classList.add('hidden');
  viewAfterSwap(() => {
    initNodeLib();   // 节点库要按当前流程刷新：已存在的骨架节点不再列出
    const cv = $('bpCanvas');
    if(cv) cv.classList.add('nodes-in');
    renderNodes();
    // 同步 fit：省掉「先按旧缩放闪一帧、下一帧再归位」的跳动；
    // 测试里 flushViewSwap() 之后也要求节点已经摆好，不然紧接着的拖线会落空
    fitView();
    if(cv) setTimeout(() => cv.classList.remove('nodes-in'), 320);
  });
}

function snapshotBp(){
  return {
    id: bp.id, name: bp.name, updated: bp.updated || Date.now(),
    lastRun: bp.lastRun || null,
    vars: (bp.vars || []).map(v => ({ id:v.id, name:v.name, type:v.type, value:v.value, fileName:v.fileName || '' })),
    nodes: bp.nodes.map(n => ({
      id:n.id, type:n.type, x:Math.round(n.x), y:Math.round(n.y), data:n.data,
      params: n.params ? n.params.map(p => ({ id:p.id, name:p.name, type:p.type, value:p.value, fileName:p.fileName || '' })) : undefined
    })),
    links: bp.links.map(l => ({ id:l.id, from:l.from, to:l.to })),
    // 注释面板：只存几何与文案，成员关系在拖动时按包含关系实时计算
    frames: (bp.frames || []).map(f => ({
      id: f.id, title: f.title || '', color: f.color || FRAME_COLORS[0],
      x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h)
    })),
  };
}
function saveFlowNow(){
  if(!bp) return;
  // 变体试跑用的临时流程（带 __noSave）：绝不写回 FLOWS，
  // 否则 runFlow 收尾的自动保存会把用户正在编辑的流程替换成试跑内容
  if(bp.__noSave) return;
  bp.updated = Date.now();
  const snap = snapshotBp();
  const i = FLOWS.findIndex(f => f.id === bp.id);
  if(i >= 0) FLOWS[i] = snap; else FLOWS.unshift(snap);
  $('bpState').textContent = persistFlows() ? '已保存' : '未保存';
}
function scheduleFlowSave(){
  if(!bp) return;
  $('bpState').textContent = '保存中…';
  clearTimeout(bpSaveTimer);
  bpSaveTimer = setTimeout(saveFlowNow, 350);
}

function applyBpTransform(){
  $('bpWorld').style.transform = `translate(${bpPan.x}px, ${bpPan.y}px) scale(${bpZoom})`;
  if(typeof edSyncZoom === 'function') edSyncZoom();
}
function fitView(){
  if(!bp || (!bp.nodes.length && !(bp.frames || []).length)){
    bpPan = { x: 40, y: 50 }; bpZoom = 1;
    applyBpTransform();
    return;
  }
  const cw = $('bpCanvas').clientWidth, ch = $('bpCanvas').clientHeight;
  // 适应视图要同时框住节点和注释面板，否则刚框出来的注释会被挤到屏幕外。
  // 节点按真实 DOM 尺寸量：固定 230×160 会漏掉多参数 / 多引脚的高节点
  // （实测可到 340px+），适应视图后它的底部引脚被推到视口外，拖不了线
  const boxes = bp.nodes.map(n => {
    const el = $('n-' + n.id);
    return {
      x: n.x, y: n.y,
      w: el ? Math.max(230, el.offsetWidth + 24) : 230,
      h: el ? Math.max(160, el.offsetHeight + 24) : 160,
    };
  })
    .concat((bp.frames || []).map(f => ({ x:f.x, y:f.y, w:f.w, h:f.h })));
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const w = Math.max(...boxes.map(b => b.x + b.w)) - minX;
  const h = Math.max(...boxes.map(b => b.y + b.h)) - minY;
  bpZoom = Math.max(.3, Math.min(1.1, Math.min((cw - 100) / w, (ch - 130) / h)));
  bpPan.x = (cw - w * bpZoom) / 2 - minX * bpZoom;
  bpPan.y = (ch - h * bpZoom) / 2 - minY * bpZoom;
  applyBpTransform();
  renderLinks();
}

function screenToWorld(cx, cy){
  const r = $('bpCanvas').getBoundingClientRect();
  return { x: (cx - r.left - bpPan.x) / bpZoom, y: (cy - r.top - bpPan.y) / bpZoom };
}
/* 引脚位置缓存：量一次，记下「量的时候节点在哪」，之后全靠加法。
   为什么必须缓存：`getBoundingClientRect()` 会强制同步布局，而拖拽时我们每帧都在写
   `transform`/`d`，一写一读就是一次完整重排（78 条线 = 156 次读）。UE 的 SGraphPanel
   从来不这么干——引脚屏幕坐标是节点位置 + 缓存的本地偏移，纯算术，因此拖动时一次布局都不用。
   世界坐标与 bpPan/bpZoom 无关（公式里约掉了），所以缩放平移都不会让缓存失效；
   只有「节点自身尺寸/结构变了」才失效，那是 renderNodes() 的事。 */
const pinWorld = new Map();      // 'nodeId|dir|key' -> { x, y, nx, ny }
function pinWorldReset(){ pinWorld.clear(); }

function portPos(nodeId, dir, key){
  const n = nodeById(nodeId);
  if(!n) return null;
  const k = nodeId + '|' + dir + '|' + key;
  const c = pinWorld.get(k);
  if(c) return { x: c.x + (n.x - c.nx), y: c.y + (n.y - c.ny) };   // 热路径：0 次 DOM 读
  const el = $('n-' + nodeId);
  const pin = el && el.querySelector(`.pin[data-dir="${dir}"][data-key="${key}"]`);
  if(!pin) return null;
  const r = pin.getBoundingClientRect();
  const cv = $('bpCanvas').getBoundingClientRect();
  const x = (r.left + r.width / 2 - cv.left - bpPan.x) / bpZoom;
  const y = (r.top + r.height / 2 - cv.top - bpPan.y) / bpZoom;
  pinWorld.set(k, { x, y, nx: n.x, ny: n.y });
  return { x, y };
}
function linkD(a, b){
  const dx = Math.max(42, Math.abs(b.x - a.x) * .5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function nodeById(id){
  return bp ? bp.nodes.find(n => n.id === id) : null;
}
function paramOf(n, key){
  if(n && Array.isArray(n.params)) return n.params.find(p => p.id === key) || null;
  return null;
}
function varOf(key){
  if(bp && Array.isArray(bp.vars)) return bp.vars.find(v => v.id === key) || null;
  return null;
}
/* 引脚类型：统一交给 node-registry 的 schema（唯一真源），这里只补编辑器需要的兜底 */
function pinType(n, key){
  const t = (typeof pinTypeOf === 'function') ? pinTypeOf(n, key, bp ? bp.vars : null) : null;
  return t || 'string';
}

/* 连线渲染：**增量更新**。
 * 旧版每次把全部 path 删掉重建（78 条 = 78 次 createElement + 78 个闭包），
 * 而且「量一条 → 建一条 → 插一条」交替进行，每插一次 DOM 就废掉一次布局缓存，
 * 78 条连线就是 78 次强制重排——拖节点时每帧都这么走，必卡。
 * 现在：元素按 link.id 复用；先批量量完（量的时候不写 DOM，只触发一次布局），再统一写属性。 */
const bpLinkEls = new Map();      // link.id → <path>

function pinElOf(nodeId, dir, key){
  const el = $('n-' + nodeId);
  return el ? el.querySelector(`.pin[data-dir="${dir}"][data-key="${key}"]`) : null;
}

/* movedNodes 传节点 id 的 Set 时只更新「两端沾到这些节点」的连线（拖拽时的热路径） */
function renderLinks(movedNodes){
  if(!bp) return;
  const svg = $('bpLinks');
  if(!svg) return;
  const only = (movedNodes instanceof Set && movedNodes.size) ? movedNodes : null;
  const keep = new Set();
  const jobs = [];

  // 引脚坐标走缓存（冷启动才量，热路径纯算术）：拖拽时这里一次布局都不触发
  for(const l of bp.links){
    keep.add(l.id);
    const el = bpLinkEls.get(l.id);
    if(only && el && el.isConnected && !only.has(l.from.node) && !only.has(l.to.node)) continue;
    const a = portPos(l.from.node, 'out', l.from.key);
    const b = portPos(l.to.node, 'in', l.to.key);
    if(!a || !b){
      if(el){ el.remove(); bpLinkEls.delete(l.id); }
      continue;
    }
    jobs.push({ l, el, a, b });
  }

  let frag = null;
  for(const j of jobs){
    const a = j.a, b = j.b;
    let el = j.el;
    if(!el || !el.isConnected){
      el = document.createElementNS(SVG_NS, 'path');
      el.dataset.link = j.l.id;          // 点击删除走事件委托，不再逐条绑监听
      bpLinkEls.set(j.l.id, el);
      (frag || (frag = document.createDocumentFragment())).appendChild(el);
    }
    const pt = pinType(nodeById(j.l.from.node), j.l.from.key);
    const cls = 'bp-link t-' + pt + (j.l.id === bpRunLinkId ? ' active' : '');
    if(el.getAttribute('class') !== cls) el.setAttribute('class', cls);
    el.setAttribute('d', linkD(a, b));
  }
  if(frag) svg.appendChild(frag);

  // 已经不在 bp.links 里的连线，元素一并清掉
  bpLinkEls.forEach((el, id) => { if(!keep.has(id)){ el.remove(); bpLinkEls.delete(id); } });
}

/* 点连线删除：一条委托监听，替掉原来「每条 path 一个闭包」 */
(function bindLinkClick(){
  const svg = $('bpLinks');
  if(!svg || svg.dataset.bound === '1') return;
  svg.dataset.bound = '1';
  svg.addEventListener('click', e => {
    const el = e.target.closest ? e.target.closest('.bp-link') : null;
    if(!el || el.classList.contains('temp')) return;
    const id = el.dataset.link;
    if(!id) return;
    bp.links = bp.links.filter(x => x.id !== id);
    bpLinkEls.delete(id);
    el.remove();
    renderNodes();
    scheduleFlowSave();
  });
})();

/* ---------------------------------------------------------------
 * 统一参数控件：所有节点的参数都走这里，保证形态一致
 *   spec.store === 'param' → 读写传入的参数对象本身（如 modelViews 的 data.params 项）
 *   否则                    → 读写 node.data[spec.key]
 * 传参形式：makeFieldControl(spec, node, paramObj)
 * -------------------------------------------------------------- */
// 取参数声明对应的参数对象（仅 store==='param' 且名称匹配时存在）
function paramObjOf(n, spec){
  if(!spec || spec.store !== 'param' || !n.data || !Array.isArray(n.data.params)) return null;
  return n.data.params.find(p => p.name === spec.key) || null;
}

function tipEl(text){
  const el = document.createElement('div');
  el.className = 'node-result';
  el.textContent = text;
  return el;
}

// 图像输入：点击 / 拖入
function imageDropEl(n){
  const drop = document.createElement('div');
  drop.className = 'node-drop';
  if(n.data.image){
    const img = document.createElement('img');
    img.src = n.data.image;
    drop.appendChild(img);
  } else {
    drop.textContent = '点击或拖入图像';
  }
  drop.addEventListener('click', () => {
    bpPickedNode = n;
    $('bpFile').value = '';
    $('bpFile').click();
  });
  drop.addEventListener('dragover', e => e.preventDefault());
  drop.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) loadNodeImage(n, file);
  });
  return drop;
}

// 模型输入：点击 / 拖入
function modelDropEl(n){
  const drop = document.createElement('div');
  drop.className = 'node-drop';
  if(n.data.model){
    const info = document.createElement('div');
    info.className = 'node-file';
    const name = document.createElement('b');
    name.textContent = n.data.fileName || '3D 模型文件';
    const meta = document.createElement('small');
    meta.textContent = (n.data.fileSize ? formatBytes(n.data.fileSize) + ' · ' : '') + '点击更换';
    info.append(name, meta);
    drop.appendChild(info);
  } else {
    drop.textContent = '点击或拖入 3D 模型';
  }
  drop.addEventListener('click', () => {
    bpPickedModelNode = n;
    $('bpModelFile').value = '';
    $('bpModelFile').click();
  });
  drop.addEventListener('dragover', e => e.preventDefault());
  drop.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) loadNodeModel(n, file);
  });
  return drop;
}

// 声明里的 dataKey 允许「引脚键」与「数据键」分离（如 text 节点输出引脚也叫 text）
function specDataKey(spec){ return spec.dataKey || spec.key; }

function paramSpecValue(spec, n, p){
  if(spec.store === 'param') return p ? p.value : undefined;
  return n.data ? n.data[specDataKey(spec)] : undefined;
}

function paramDefault(spec){
  return typeof spec.default === 'function' ? spec.default() : spec.default;
}

function writeParamValue(spec, n, p, raw){
  let v = raw;
  if(spec.ctl === 'number'){
    const num = Number(raw);
    if(!isFinite(num) || raw === '') return;          // 输入过程中的空值不落盘
    v = Math.max(spec.min != null ? spec.min : -Infinity,
                 Math.min(spec.max != null ? spec.max : Infinity, num));
  } else if(spec.ctl === 'bool'){
    v = !!raw;
  }
  if(spec.store === 'param'){
    if(p) p.value = v;
  } else if(n.data){
    n.data[specDataKey(spec)] = v;
  }
  scheduleFlowSave();
}

// 文本域随内容自动增高：完整显示字符串，不裁切、不出滚动框
// 必须元素已在文档中（scrollHeight 才有意义），故渲染后再统一调用
function autoGrowTextarea(el){
  if(!el || el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  // scrollHeight 不含边框，而 height 为 border-box，补上上下边框避免差 2px 被裁
  const cs = getComputedStyle(el);
  const extra = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const need = Math.max(el.scrollHeight + extra, 24);
  el.style.height = need + 'px';
  el.style.overflow = 'hidden';
}

// 生成一个参数控件（不含标签行），统一处理范围夹取、颜色校验与事件隔离
function makeFieldControl(spec, n, p){
  const cur = paramSpecValue(spec, n, p);
  const val = (cur === undefined || cur === null) ? paramDefault(spec) : cur;
  let el;

  if(spec.ctl === 'select'){
    el = document.createElement('select');
    (spec.options || []).forEach(o => {
      const [ov, ol] = Array.isArray(o) ? o : [o, String(o)];
      const op = document.createElement('option');
      op.value = String(ov);
      op.textContent = String(ol);
      el.appendChild(op);
    });
    el.value = String(val);
    el.addEventListener('change', () => {
      const hit = (spec.options || []).map(o => Array.isArray(o) ? o[0] : o)
        .find(o => String(o) === el.value);
      writeParamValue(spec, n, p, hit !== undefined ? hit : el.value);
    });
  } else if(spec.ctl === 'bool'){
    el = document.createElement('select');
    [['true','真'], ['false','假']].forEach(([ov, ol]) => {
      const op = document.createElement('option');
      op.value = ov; op.textContent = ol;
      el.appendChild(op);
    });
    el.value = val === false ? 'false' : 'true';
    el.addEventListener('change', () => writeParamValue(spec, n, p, el.value === 'true'));
  } else if(spec.ctl === 'color'){
    el = document.createElement('input');
    el.type = 'color';
    el.value = /^#[0-9a-fA-F]{6}$/.test(String(val)) ? String(val) : '#ffffff';
    el.addEventListener('input', () => writeParamValue(spec, n, p, el.value));
  } else if(spec.ctl === 'number'){
    el = document.createElement('input');
    el.type = 'number';
    if(spec.min != null) el.min = String(spec.min);
    if(spec.max != null) el.max = String(spec.max);
    if(spec.step != null) el.step = String(spec.step);
    el.value = (val === undefined || val === null) ? '' : String(val);
    el.addEventListener('input', () => writeParamValue(spec, n, p, el.value));
  } else if(spec.ctl === 'textarea'){
    el = document.createElement('textarea');
    el.rows = 2;
    if(spec.ph) el.placeholder = spec.ph;
    el.value = val == null ? '' : String(val);
    el.addEventListener('input', () => {
      writeParamValue(spec, n, p, el.value);
      autoGrowTextarea(el);
    });
  } else {
    el = document.createElement('input');
    el.type = 'text';
    if(spec.ph) el.placeholder = spec.ph;
    el.value = val == null ? '' : String(val);
    el.addEventListener('input', () => writeParamValue(spec, n, p, el.value));
  }

  el.classList.add('port-param', 'ctl-' + spec.ctl);
  // 控件上的指针事件不冒泡到节点，避免编辑时误拖节点
  ['pointerdown', 'mousedown', 'click', 'dblclick'].forEach(ev =>
    el.addEventListener(ev, e => e.stopPropagation()));
  return el;
}

// 参数引脚的类型与名称：优先级 声明 → 引脚名映射 → 字符串
// 缺了第二级，maxEdge / quality / timeout 这类引脚会被当成字符串，数值节点就接不上
function paramPortMeta(spec, n, key){
  const m = PIN_META[key];
  const type = (spec && spec.type) || (m ? m.type : 'string');
  return {
    label: (spec && spec.label) || (m ? m.label : key),
    type, spec, node:n,
    param: spec ? paramObjOf(n, spec) : null
  };
}

// 一个参数 = 一行「引脚 + 名称 + 控件」；无同名列引脚时用规格里的 key 当引脚
// dir 为 'out' 时是数据源节点（布尔 / 数值），控件照样紧跟引脚，连线后不隐藏
function makeParamPort(spec, n, p, dir){
  dir = dir === 'out' ? 'out' : 'in';
  const row = document.createElement('div');
  row.className = 'port-row has-param'
    + (dir === 'out' ? ' out-param' : '')
    + (spec.ctl === 'textarea' ? ' wide' : '');
  row.dataset.paramKey = spec.key;
  if(p && p.id) row.dataset.paramId = p.id;

  const pin = document.createElement('span');
  pin.className = 'pin ' + dir;
  pin.dataset.dir = dir;
  pin.dataset.key = (p && p.id) ? p.id : (spec.dataKey || spec.key);
  // 类型优先级：声明的 type → 参数对象自身类型（如四视图的 int/float 参数）→ 引脚名映射 → 字符串
  // 少了第二步，数值参数引脚会被降级成 string，数值节点就永远连不上
  pin.dataset.type = spec.type
    || (p && p.type)
    || (PIN_META[spec.key] ? PIN_META[spec.key].type : null)
    || 'string';
  pin.style.setProperty('--pin-c', PIN_COLORS[pin.dataset.type] || '#6a7488');

  const label = document.createElement('span');
  label.className = 'port-label';
  label.textContent = spec.label || (p && p.name) || spec.key;

  row.append(pin, label);

  const ctl = makeFieldControl(spec, n, p);
  if(spec.unit){
    const wrap = document.createElement('span');
    wrap.className = 'port-unit-wrap';
    wrap.append(ctl);
    const u = document.createElement('span');
    u.className = 'port-unit';
    u.textContent = spec.unit;
    wrap.append(u);
    row.append(wrap);
  } else {
    row.append(ctl);
  }
  return row;
}

function makePort(key, dir, meta){
  meta = meta || PIN_META[key] || { label:key, type:'string' };
  // 未显式给类型的，用引脚名映射兜底（例如 text / prompt / model 等固定引脚）
  if(dir === 'out' && !meta.type && PIN_META[key]) meta = Object.assign({}, meta, { type:PIN_META[key].type });
  // 有对应参数声明时，直接渲染成「引脚 + 名称 + 控件」的统一形态
  if(meta.spec){
    return makeParamPort(meta.spec, meta.node, meta.param, dir);
  }
  const row = document.createElement('div');
  row.className = 'port-row';
  const pin = document.createElement('span');
  pin.className = 'pin ' + dir;
  pin.dataset.dir = dir;
  pin.dataset.key = key;
  pin.dataset.type = meta.type;
  pin.style.setProperty('--pin-c', PIN_COLORS[meta.type] || '#6a7488');
  const label = document.createElement('span');
  label.textContent = meta.label;
  label.className = 'port-label';
  if(dir === 'in') row.append(pin, label); else row.append(label, pin);
  // 带 param 的参数引脚：取值控件紧跟引脚右侧（连线后由 renderNodes 隐藏）
  return row;
}

function makeExecPort(key, dir, label){
  const row = document.createElement('div');
  row.className = 'exec-row ' + dir;
  const pin = document.createElement('span');
  pin.className = 'pin exec ' + dir + (key === 'true' ? ' true' : key === 'false' ? ' false' : '');
  pin.dataset.dir = dir;
  pin.dataset.key = key;
  pin.dataset.type = 'exec';
  const span = document.createElement('span');
  span.textContent = label;
  if(dir === 'in') row.append(pin, span); else row.append(span, pin);
  return row;
}

function nodeEl(n){
  const d = NODE_DEFS[n.type];
  const isVarNode = n.type === 'varGet' || n.type === 'varSet';
  const v = isVarNode ? varOf(n.data.varId) : null;
  const el = document.createElement('div');
  el.className = 'node';
  el.id = 'n-' + n.id;
  el.dataset.id = n.id;
  el.dataset.kind = d.dot;      // 供样式按类别染色（标题栏渐变 / 选中环）
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';

  const head = document.createElement('div');
  head.className = 'node-head';
  const dot = document.createElement('span');
  dot.className = 'node-dot ' + d.dot;
  if(isVarNode && v) dot.style.background = PIN_COLORS[v.type] || '#e88a00';
  const title = document.createElement('span');
  title.className = 'node-title';
  title.textContent = isVarNode
    ? (v ? (n.type === 'varSet' ? '设置 ' + v.name : v.name) : '变量已删除')
    : d.title;
  const status = document.createElement('span');
  status.className = 'node-status ' + (n.status || '');
  status.textContent = n.status === 'ok' ? '完成' : n.status === 'error' ? '失败' : n.status === 'running' ? '运行中' : '';
  // 任务开始 / 任务结束是流程骨架不给删除按钮；
  // 只有历史流程里重复出现时，才对多余的那些放开删除（保证至少留存一个）
  const sameCount = bp ? bp.nodes.filter(x => x.type === n.type).length : 1;
  const locked = (n.type === 'start' || n.type === 'end') && sameCount <= 1;
  let del = null;
  if(!locked){
    del = document.createElement('button');
    del.className = 'node-del';
    del.title = '删除节点';
    del.textContent = '×';
  }
  // 纯参数节点：不占执行线，标一下避免误以为「连了就该执行」
  if(d.pure){
    const tag = document.createElement('span');
    tag.className = 'node-tag';
    tag.textContent = '参数';
    tag.title = '参数节点：不带执行引脚，由下游按需读取';
    head.append(tag);
  }
  if(n.type === 'start' || n.type === 'end'){
    const plus = document.createElement('button');
    plus.className = 'node-plus';
    plus.title = '添加参数';
    plus.textContent = '+';
    plus.addEventListener('click', e => {
      e.stopPropagation();
      n._showAdd = !n._showAdd;
      renderNodes();
    });
    head.append(dot, title, plus, status);
    if(del) head.appendChild(del);
  } else {
    head.append(dot, title, status);
    if(del) head.appendChild(del);
  }

  const exec = document.createElement('div');
  exec.className = 'node-exec';
  if(d.execIn) exec.appendChild(makeExecPort('exec', 'in', '执行'));
  // 出口分两类：声明里写死的（真 / 假 / 执行）与取自数据的动态出口（AI 分支的分支列表）
  const execOutDyn = execPinsOf(n);
  if((d.execOut && d.execOut.length) || execOutDyn.length){
    const outWrap = document.createElement('div');
    outWrap.className = 'exec-out';
    (d.execOut || []).forEach(k => outWrap.appendChild(makeExecPort(k, 'out', k === 'true' ? '真' : k === 'false' ? '假' : '执行')));
    execOutDyn.forEach(p => outWrap.appendChild(makeExecPort(p.id, 'out', p.name || '出口')));
    exec.appendChild(outWrap);
  }
  const hasExec = !!d.execIn || !!(d.execOut && d.execOut.length) || !!execOutDyn.length;

  /* ---------- 节点主体：引脚清单由 node-registry 的 schema 统一给出 ---------- */
  const specs = (NODE_PARAMS[n.type] || []).slice();

  const body = document.createElement('div');
  body.className = 'node-body';
  const inCol = document.createElement('div');
  inCol.className = 'node-col in';
  const outCol = document.createElement('div');
  outCol.className = 'node-col out';

  const pinSets = pinsForRender(n, (bp && bp.vars) || []);

  pinSets.in.forEach(p => {
    if(p.kind === 'endParam'){
      const param = (n.params || []).find(x => x.id === p.key);
      if(param) inCol.appendChild(endParamPort(n, param));
      return;
    }
    if(p.kind === 'param' && p.spec){
      inCol.appendChild(makePort(p.key, 'in', paramPortMeta(p.spec, n, p.key)));
      return;
    }
    inCol.appendChild(makePort(p.key, 'in', { label:p.label, type:p.type }));
  });

  pinSets.out.forEach(p => {
    if(p.kind === 'param' && p.spec){
      outCol.appendChild(makePort(p.key, 'out', paramPortMeta(p.spec, n, p.key)));
    } else {
      outCol.appendChild(makePort(p.key, 'out', { label:p.label, type:p.type }));
    }
  });

  // 图像拆分的动态视图引脚由 viewPinSection 在字段区渲染（紧跟各自的视图控件），不在这里重复

  // 2) 含参数的节点让引脚列占满整行，取值控件才有位置（输入侧 / 输出侧都算）
  const hasParamRow = specs.some(s => !s.tip
    && s.ctl !== 'paramList' && s.ctl !== 'taskPins' && s.ctl !== 'filePick'
    && s.ctl !== 'viewPins' && s.ctl !== 'branchPins' && s.ctl !== 'inPins');
  if(hasParamRow) body.classList.add('wide-in');
  body.append(inCol);
  if(pinSets.out.length) body.appendChild(outCol);

  // 3) 纯块级内容（文件选择、参数列表、提示文字、运行结果）
  const fields = document.createElement('div');
  fields.className = 'node-fields';

  specs.forEach(s => {
    if(s.ctl === 'filePick'){
      fields.appendChild(s.key === '__image__' ? imageDropEl(n) : modelDropEl(n));
    } else if(s.ctl === 'paramList'){
      (n.params || []).forEach(p => fields.appendChild(paramRow(n, p)));
      if(n._showAdd) fields.appendChild(paramAddForm(n));
      if(!(n.params || []).length && !n._showAdd){
        fields.appendChild(tipEl('点击右上角 + 添加' + (n.type === 'start' ? '输入' : '输出') + '参数'));
      }
    } else if(s.ctl === 'taskPins'){
      // 输入 / 输出引脚都由管理行自己画 pin（行内探出到节点边缘），
      // 这样引脚和它对应的「设置行」严格对齐；列里不再重复画，避免同一个引脚出现两次。
      fields.appendChild(taskPinSection(n, 'in'));
      fields.appendChild(taskPinSection(n, 'out'));
    } else if(s.ctl === 'inPins'){
      // 引脚本体已经渲染在左列（可拖线），这里只保留改名 / 改类型的行
      fields.appendChild(taskPinSection(n, 'in', { noPin: n.type === 'smartBranch' }));
    } else if(s.ctl === 'viewPins'){
      fields.appendChild(viewPinSection(n));
    } else if(s.ctl === 'branchPins'){
      fields.appendChild(branchPinSection(n));
    } else if(s.tip){
      fields.appendChild(tipEl(
        (n.out && n.out.text && n.type !== 'aiTask') ? n.out.text
          : (n.type === 'end' && bp && bp.lastRun && bp.lastRun.at)
            ? s.tip + ' · 上次运行 ' + new Date(bp.lastRun.at).toLocaleTimeString()
            : s.tip
      ));
    }
  });

  if(isVarNode){
    if(!v){
      fields.appendChild(tipEl('变量已删除，请在变量面板重新创建。'));
    } else {
      fields.appendChild(varPreviewEl(v));
    }
  }

  if(fields.childNodes.length) body.appendChild(fields);


  // 思考过程：模型有 reasoning 时折叠展示，运行结束后仍能回看（判断它到底在想什么 / 有没有在工作）
  if(n.reasoning){
    const box = document.createElement('div');
    box.className = 'node-out-box';
    const det = document.createElement('details');
    det.className = 'node-think';
    const sum = document.createElement('summary');
    sum.textContent = '思考过程 · ' + n.reasoning.length + ' 字';
    const pre = document.createElement('div');
    pre.className = 'node-result';
    pre.textContent = n.reasoning;
    det.append(sum, pre);
    box.appendChild(det);
    body.appendChild(box);
  }
  if(n.out && n.out.text){
    const box = document.createElement('div');
    box.className = 'node-out-box';
    const out = document.createElement('div');
    out.className = 'node-result';
    out.textContent = n.out.text;
    box.appendChild(out);
    body.appendChild(box);
  }
  if(n.out && n.out.image){
    const box = document.createElement('div');
    box.className = 'node-out-box';
    const img = document.createElement('img');
    img.className = 'node-img';
    img.src = n.out.image;
    box.appendChild(img);
    body.appendChild(box);
  }
  if(n.out && n.out.model){
    const box = document.createElement('div');
    box.className = 'node-out-box';
    const a = document.createElement('a');
    a.className = 'node-model';
    a.href = n.out.model;
    if(n.out.model.indexOf('data:') === 0){
      a.download = modelNameFor(n);
      a.textContent = '下载 3D 模型';
    } else {
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '下载 GLB 模型';
    }
    box.appendChild(a);
    body.appendChild(box);
  }
  if(n.out && typeof n.out.bool === 'boolean'){
    const box = document.createElement('div');
    box.className = 'node-out-box';
    const out = document.createElement('div');
    out.className = 'node-result';
    out.textContent = '布尔结果：' + (n.out.bool ? '真' : '假');
    box.appendChild(out);
    body.appendChild(box);
  }
  if(n.type === 'aiTask'){
    (n.data.outputs || []).forEach(p => {
      const v = n.out ? n.out[p.id] : undefined;
      if(v === undefined || v === null || v === '') return;
      const box = document.createElement('div');
      box.className = 'node-out-box';
      const name = document.createElement('div');
      name.className = 'node-out-name';
      name.textContent = p.name || '输出';
      const out = document.createElement('div');
      out.className = 'node-result';
      out.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
      box.append(name, out);
      body.appendChild(box);
    });
  }
  if(n.error){
    const err = document.createElement('div');
    err.className = 'node-err';
    err.textContent = n.error;
    body.appendChild(err);
  }

  el.append(head);
  if(hasExec) el.append(exec);
  el.append(body);

  if(del) del.addEventListener('click', e => {
    e.stopPropagation();
    removeNode(n);
  });

  // 拖动交给编辑引擎：多选时整组移动，单选时只移动自己
  head.addEventListener('pointerdown', e => {
    if(e.target.closest('.node-del') || e.target.closest('.node-plus')) return;
    if(e.button !== 0) return;
    e.preventDefault();
    Editor.beginNodeDrag(e, n);
  });

  return el;
}

function paramEditor(n, p){
  if(p.type === 'image' || p.type === 'model'){
    const btn = document.createElement('button');
    btn.className = 'param-file';
    btn.textContent = p.value ? (p.fileName || '已选择，点击更换') : (p.type === 'image' ? '选择图像' : '选择模型');
    btn.title = p.fileName || '';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      bpPickedVar = null;
      bpPickedParam = { n, p };
      const inp = $('bpParamFile');
      inp.accept = p.type === 'image' ? 'image/*' : '.obj,.glb,.gltf,.fbx,.stl,.ply,.3mf';
      inp.value = '';
      inp.click();
    });
    return btn;
  }
  if(p.type === 'bool'){
    const sel = document.createElement('select');
    [['true','真'],['false','假']].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      sel.appendChild(opt);
    });
    sel.value = p.value === false ? 'false' : 'true';
    sel.addEventListener('change', () => { p.value = sel.value === 'true'; scheduleFlowSave(); });
    return sel;
  }
  const inp = document.createElement('input');
  if(p.type === 'int' || p.type === 'float'){
    inp.type = 'number';
    inp.step = p.type === 'int' ? '1' : '0.01';
    inp.value = p.value === '' ? 0 : p.value;
    inp.addEventListener('input', () => {
      p.value = inp.value === '' ? 0 : Number(inp.value);
      scheduleFlowSave();
    });
  } else {
    inp.type = 'text';
    inp.value = p.value || '';
    inp.addEventListener('input', () => { p.value = inp.value; scheduleFlowSave(); });
  }
  return inp;
}

/* 结束节点的参数行：真引脚 + 名称 / 类型 / 接收值。
   只画 paramRow 时没有 pin，portPos 找不到坐标，这条连线就永远画不出来。 */
function endParamPort(n, param){
  const row = document.createElement('div');
  row.className = 'port-row param-port';
  const pin = document.createElement('span');
  pin.className = 'pin in';
  pin.dataset.dir = 'in';
  pin.dataset.key = param.id;
  pin.dataset.type = param.type;
  pin.style.setProperty('--pin-c', PIN_COLORS[param.type] || '#6a7488');
  const body = document.createElement('div');
  body.className = 'param-port-body';
  body.appendChild(paramRow(n, param));
  row.append(pin, body);
  return row;
}

function paramRow(n, p){
  const row = document.createElement('div');
  row.className = 'param-row';
  const head = document.createElement('div');
  head.className = 'param-head';
  const name = document.createElement('b');
  name.textContent = p.name || '参数';
  name.title = p.name || '';
  const type = document.createElement('span');
  type.className = 'param-type';
  type.textContent = TYPE_META[p.type] ? TYPE_META[p.type].label : p.type;
  const del = document.createElement('button');
  del.className = 'param-del';
  del.title = '删除参数';
  del.textContent = '×';
  del.addEventListener('click', e => { e.stopPropagation(); removeParam(n, p); });
  head.append(name, type, del);
  row.appendChild(head);

  if(n.type === 'start'){
    row.appendChild(paramEditor(n, p));
  } else {
    const v = document.createElement('div');
    v.className = 'param-val';
    if(p.type === 'image' && p.value){
      const img = document.createElement('img');
      img.src = p.value;
      v.append('已接收图像', img);
    } else if(p.type === 'model' && p.value){
      v.textContent = '已接收模型：' + (p.fileName || 'model');
    } else if(p.type === 'bool' && p.value !== '' && p.value !== undefined){
      v.textContent = p.value ? '真' : '假';
    } else if((p.type === 'int' || p.type === 'float') && p.value !== ''){
      v.textContent = String(p.value);
    } else if(p.type === 'string' && p.value){
      v.textContent = String(p.value);
    } else {
      v.textContent = p.value ? String(p.value) : '未接收';
    }
    row.appendChild(v);
  }
  return row;
}

function paramAddForm(n){
  const form = document.createElement('div');
  form.className = 'param-add';
  const prow = document.createElement('div');
  prow.className = 'prow';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = '参数名';
  const sel = document.createElement('select');
  TYPE_ORDER.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = TYPE_META[t].label;
    sel.appendChild(opt);
  });
  sel.value = 'string';
  prow.append(name, sel);
  const ok = document.createElement('button');
  ok.className = 'btn primary';
  ok.textContent = n.type === 'start' ? '添加输入' : '添加输出';
  ok.addEventListener('click', e => {
    e.stopPropagation();
    const pname = name.value.trim() || (TYPE_META[sel.value].label + (n.params.length + 1));
    n.params.push(newParam(pname, sel.value));
    n._showAdd = false;
    renderNodes();
    scheduleFlowSave();
  });
  name.addEventListener('keydown', e => { if(e.key === 'Enter') ok.click(); });
  form.append(prow, ok);
  return form;
}

function removeParam(n, p){
  n.params = n.params.filter(x => x.id !== p.id);
  if(bp){
    bp.links = bp.links.filter(l =>
      !(l.from.node === n.id && l.from.key === p.id) &&
      !(l.to.node === n.id && l.to.key === p.id)
    );
  }
  renderNodes();
  scheduleFlowSave();
}

/* 上传的图先压缩再入库：一张 4000px 的原图 base64 后动辄 5~10MB，
 * 直接塞进工作流会瞬间吃满本地存储。压到长边 1600px + WebP 0.82 通常只剩几百 KB，
 * 肉眼几乎无损。压完反而更大（已是优化过的图）就保留原图。 */
function shrinkImageDataUrl(dataUrl, maxEdge, quality){
  return new Promise(resolve => {
    if(typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) return resolve(dataUrl);
    const edge = maxEdge || 1600;
    const q = quality || .82;
    const img = new Image();
    img.onload = () => {
      try{
        const sw = img.naturalWidth || 0, sh = img.naturalHeight || 0;
        if(!sw || !sh) return resolve(dataUrl);
        const scale = Math.min(1, edge / Math.max(sw, sh));
        const cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        const webp = cv.toDataURL('image/webp', q);
        if(/^data:image\/webp/.test(webp) && webp.length < dataUrl.length) return resolve(webp);
        const jpg = cv.toDataURL('image/jpeg', q);
        if(jpg.length < dataUrl.length) return resolve(jpg);
        resolve(dataUrl);
      }catch(e){ resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function loadParamFile(n, p, file){
  if(p.type === 'model'){
    if(!/\.(obj|glb|gltf|fbx|stl|ply|3mf)$/i.test(file.name)){ bpToast('模型格式不支持'); return; }
    if(file.size > 20 * 1024 * 1024){ bpToast('模型超过 20MB，请用更轻的模型文件'); return; }
  } else if(p.type === 'image' && !/^image\//.test(file.type)){
    bpToast('请选择图像文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    p.value = p.type === 'image' ? await shrinkImageDataUrl(String(reader.result)) : String(reader.result);
    p.fileName = file.name;
    renderNodes();
    scheduleFlowSave();
  };
  reader.readAsDataURL(file);
}

function modelNameFor(n){
  if(n.data && n.data.fileName) return n.data.fileName;
  if(n.type === 'model3d') return 'model.glb';
  if(bp){
    const l = bp.links.find(x => x.to.node === n.id && x.to.key === 'model');
    if(l){
      const src = bp.nodes.find(x => x.id === l.from.node);
      if(src && src.data && src.data.fileName) return src.data.fileName;
    }
  }
  return 'model';
}

const TA_COLLAPSED_H = 148;
function bindTextarea(n, key, placeholder){
  const wrap = document.createElement('div');
  wrap.className = 'node-ta';

  const ta = document.createElement('textarea');
  ta.className = 'node-text';
  ta.placeholder = placeholder;
  ta.value = n.data[key] || '';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'node-ta-toggle hidden';
  btn.textContent = '展开全文';

  let expanded = !!n['_expand_' + key];
  let lastH = 0;
  const fit = () => {
    ta.style.height = 'auto';
    const full = ta.scrollHeight;
    const over = full > TA_COLLAPSED_H + 4;
    btn.classList.toggle('hidden', !over);
    if(over && expanded){
      ta.style.height = full + 'px';
      wrap.classList.remove('collapsed');
      btn.textContent = '收起';
    } else {
      expanded = false;
      ta.style.height = Math.max(52, Math.min(full, TA_COLLAPSED_H)) + 'px';
      wrap.classList.toggle('collapsed', over);
      btn.textContent = '展开全文';
    }
    const h = ta.offsetHeight;
    if(lastH && Math.abs(lastH - h) > 1) renderLinks();
    lastH = h;
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    expanded = !expanded;
    n['_expand_' + key] = expanded;
    fit();
  });
  ta.addEventListener('input', () => {
    n.data[key] = ta.value;
    scheduleFlowSave();
    fit();
  });

  wrap.append(ta, btn);
  requestAnimationFrame(fit);
  return wrap;
}

function loadNodeImage(n, file){
  const reader = new FileReader();
  reader.onload = async () => {
    n.data.image = await shrinkImageDataUrl(String(reader.result));
    renderNodes();
    scheduleFlowSave();
  };
  reader.readAsDataURL(file);
}

function formatBytes(size){
  if(size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(size / 1024)) + ' KB';
}

function loadNodeModel(n, file){
  if(!/\.(obj|glb|gltf|fbx|stl|ply|3mf)$/i.test(file.name)){
    bpToast('仅支持 OBJ / GLB / GLTF / FBX / STL / PLY / 3MF');
    return;
  }
  if(file.size > 20 * 1024 * 1024){
    bpToast('模型超过 20MB，请用更轻的模型文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    n.data.model = reader.result;
    n.data.fileName = file.name;
    n.data.fileSize = file.size;
    renderNodes();
    scheduleFlowSave();
  };
  reader.readAsDataURL(file);
}

function taskPinSection(n, kind, opts){
  const wrap = document.createElement('div');
  wrap.className = 'task-sec';
  const head = document.createElement('div');
  head.className = 'task-sec-head';
  const title = document.createElement('span');
  title.textContent = kind === 'in' ? '输入引脚' : '输出引脚';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'task-add';
  add.textContent = '+ 添加';
  add.addEventListener('click', e => {
    e.stopPropagation();
    const list = kind === 'in' ? n.data.inputs : n.data.outputs;
    list.push(taskPin((kind === 'in' ? '输入' : '输出') + (list.length + 1), 'string'));
    renderNodes();
    scheduleFlowSave();
  });
  head.append(title, add);
  wrap.appendChild(head);
  const list = kind === 'in' ? n.data.inputs : n.data.outputs;
  list.forEach(p => wrap.appendChild(taskPinRow(n, kind, p, opts)));
  return wrap;
}

function taskPinRow(n, kind, p, opts){
  const row = document.createElement('div');
  row.className = 'param-row task-pin';
  // 自定义引脚必须有真实的 pin 元素，否则既不能拖线，连线也画不出来。
  // opts.noPin：引脚已经渲染在左列时（智能分支），这里只做「改名 / 改类型 / 删除」的管理行，避免重复出两个引脚。
  const dir = kind === 'in' ? 'in' : 'out';
  if(!(opts && opts.noPin)){
    const pin = document.createElement('span');
    pin.className = 'pin ' + dir;
    pin.dataset.dir = dir;
    pin.dataset.key = p.id;
    pin.dataset.type = p.type;
    pin.style.setProperty('--pin-c', PIN_COLORS[p.type] || '#6a7488');
    row.appendChild(pin);
  }
  const head = document.createElement('div');
  head.className = 'param-head';
  const name = document.createElement('input');
  name.type = 'text';
  name.value = p.name || '';
  name.title = '引脚名称';
  for(const ev of NAME_EVENTS) name.addEventListener(ev, e => e.stopPropagation());
  name.addEventListener('input', () => {
    p.name = name.value;
    scheduleFlowSave();
  });
  const sel = document.createElement('select');
  for(const ev of NAME_EVENTS) sel.addEventListener(ev, e => e.stopPropagation());
  (kind === 'in' ? TYPE_ORDER : TASK_OUT_TYPES).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = TYPE_META[t] ? TYPE_META[t].label : t;
    sel.appendChild(opt);
  });
  sel.value = p.type;
  sel.addEventListener('change', () => {
    p.type = sel.value;
    renderNodes();
    scheduleFlowSave();
  });
  const del = document.createElement('button');
  del.className = 'param-del';
  del.title = '删除引脚';
  del.textContent = '×';
  del.addEventListener('click', e => { e.stopPropagation(); removeTaskPin(n, kind, p); });
  head.append(name, sel, del);
  row.appendChild(head);
  return row;
}

function removeTaskPin(n, kind, p){
  const key = kind === 'in' ? 'inputs' : 'outputs';
  n.data[key] = (n.data[key] || []).filter(x => x.id !== p.id);
  if(bp){
    bp.links = bp.links.filter(l =>
      !(l.from.node === n.id && l.from.key === p.id) &&
      !(l.to.node === n.id && l.to.key === p.id)
    );
  }
  renderNodes();
  scheduleFlowSave();
}

/* ---------- 图像拆分：动态视图输出（每视图 = 图像引脚 + 布尔引脚） ---------- */
function nextViewName(n){
  const list = (n && n.data && n.data.views) || [];
  let i = list.length + 1;
  while(list.some(v => v.name === '视图 ' + i)) i++;
  return '视图 ' + i;
}
function addView(n, name){
  const list = n.data.views || (n.data.views = []);
  const nm = name || nextViewName(n);
  if(list.some(v => v.name === nm)){ bpToast('已存在「' + nm + '」'); return; }
  list.push(viewEntry(nm));
  renderNodes();
  scheduleFlowSave();
}
function removeView(n, v){
  n.data.views = (n.data.views || []).filter(x => x.id !== v.id);
  if(bp){
    bp.links = bp.links.filter(l =>
      !(l.from.node === n.id && (l.from.key === v.id || l.from.key === v.id + '__has')) &&
      !(l.to.node === n.id && (l.to.key === v.id || l.to.key === v.id + '__has'))
    );
  }
  renderNodes();
  scheduleFlowSave();
}
function viewPinSection(n){
  const wrap = document.createElement('div');
  wrap.className = 'task-sec';
  const head = document.createElement('div');
  head.className = 'task-sec-head';
  const title = document.createElement('span');
  title.textContent = '视图输出';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'task-add';
  add.textContent = '+ 添加视图';
  add.addEventListener('click', e => { e.stopPropagation(); addView(n); });
  head.append(title, add);
  wrap.appendChild(head);
  // 常用视图一键添加
  const presets = document.createElement('div');
  presets.className = 'view-presets';
  VIEW_PRESETS.forEach(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'view-preset';
    b.textContent = name;
    b.addEventListener('click', e => { e.stopPropagation(); addView(n, name); });
    presets.appendChild(b);
  });
  wrap.appendChild(presets);
  (n.data.views || []).forEach(v => wrap.appendChild(viewPinRow(n, v)));
  return wrap;
}
function viewPinRow(n, v){
  const row = document.createElement('div');
  row.className = 'param-row view-pin';
  // 图像输出引脚（页面右侧探出；与布尔引脚错开 17px）
  const pinImg = document.createElement('span');
  pinImg.className = 'pin out view-pin-img';
  pinImg.dataset.dir = 'out';
  pinImg.dataset.key = v.id;
  pinImg.dataset.type = 'image';
  pinImg.style.setProperty('--pin-c', PIN_COLORS.image);
  row.appendChild(pinImg);
  // 视图名称（可改）；布尔引脚标签跟随名称实时更新
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'view-name';
  name.value = v.name || '';
  name.title = '视图名称';
  for(const ev of NAME_EVENTS) name.addEventListener(ev, e => e.stopPropagation());
  row.appendChild(name);
  // 布尔输出引脚（页面右侧探出）
  const pinBool = document.createElement('span');
  pinBool.className = 'pin out view-pin-bool';
  pinBool.dataset.dir = 'out';
  pinBool.dataset.key = v.id + '__has';
  pinBool.dataset.type = 'bool';
  pinBool.style.setProperty('--pin-c', PIN_COLORS.bool);
  row.appendChild(pinBool);
  const boolLabel = document.createElement('span');
  boolLabel.className = 'view-bool-label';
  boolLabel.textContent = '是否有' + (v.name || '');
  row.appendChild(boolLabel);
  name.addEventListener('input', () => {
    v.name = name.value;
    boolLabel.textContent = '是否有' + (v.name || '');
    scheduleFlowSave();
  });
  name.addEventListener('change', () => renderNodes());
  // 删除
  const del = document.createElement('button');
  del.className = 'param-del';
  del.title = '删除该视图';
  del.textContent = '×';
  del.addEventListener('click', e => { e.stopPropagation(); removeView(n, v); });
  row.appendChild(del);
  // 第二行：可选补充说明（送 AI 的该视图描述）
  const hintRow = document.createElement('div');
  hintRow.className = 'view-hint-row';
  const hint = document.createElement('input');
  hint.type = 'text';
  hint.className = 'view-hint';
  hint.value = v.hint || '';
  hint.placeholder = '补充说明（可选，送 AI 辅助识别）';
  for(const ev of NAME_EVENTS) hint.addEventListener(ev, e => e.stopPropagation());
  hint.addEventListener('input', () => { v.hint = hint.value; scheduleFlowSave(); });
  hintRow.appendChild(hint);
  const box = document.createElement('div');
  box.className = 'view-box';
  box.append(row, hintRow);
  return box;
}

/* ---------- AI 分支：动态出口列表（每出口 = 一条执行线出口引脚） ---------- */
function nextBranchName(n){
  const list = (n && n.data && n.data.branches) || [];
  let i = list.length + 1;
  while(list.some(b => b.name === '分支 ' + i)) i++;
  return '分支 ' + i;
}
function addBranch(n, name){
  const list = n.data.branches || (n.data.branches = []);
  const nm = name || nextBranchName(n);
  if(list.some(b => b.name === nm)){ bpToast('已存在「' + nm + '」'); return; }
  list.push(branchEntry(nm));
  renderNodes();
  scheduleFlowSave();
}
function removeBranch(n, b){
  n.data.branches = (n.data.branches || []).filter(x => x.id !== b.id);
  if(bp){
    bp.links = bp.links.filter(l =>
      !(l.from.node === n.id && l.from.key === b.id) &&
      !(l.to.node === n.id && l.to.key === b.id)
    );
  }
  renderNodes();
  scheduleFlowSave();
}
// 兜底出口互斥：同一时刻只能有一条
function setFallbackBranch(n, b){
  (n.data.branches || []).forEach(x => { x.fallback = (x.id === b.id) ? !x.fallback : false; });
  renderNodes();
  scheduleFlowSave();
}
function branchPinSection(n){
  const wrap = document.createElement('div');
  wrap.className = 'task-sec';
  const head = document.createElement('div');
  head.className = 'task-sec-head';
  const title = document.createElement('span');
  title.textContent = '执行线出口';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'task-add';
  add.textContent = '+ 添加出口';
  add.addEventListener('click', e => { e.stopPropagation(); addBranch(n); });
  head.append(title, add);
  wrap.appendChild(head);
  const presets = document.createElement('div');
  presets.className = 'view-presets';
  BRANCH_PRESETS.forEach(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'view-preset';
    b.textContent = name;
    b.addEventListener('click', e => { e.stopPropagation(); addBranch(n, name); });
    presets.appendChild(b);
  });
  wrap.appendChild(presets);
  (n.data.branches || []).forEach(b => wrap.appendChild(branchPinRow(n, b)));
  return wrap;
}
function branchPinRow(n, b){
  const chosen = !!(n.out && n.out.choice === b.id);
  const box = document.createElement('div');
  box.className = 'view-box branch-box' + (chosen ? ' chosen' : '');
  const row = document.createElement('div');
  row.className = 'param-row view-pin branch-pin';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'view-name';
  name.value = b.name || '';
  name.title = '出口名称（送 AI 判断，也是引脚标签）';
  for(const ev of NAME_EVENTS) name.addEventListener(ev, e => e.stopPropagation());
  name.addEventListener('input', () => { b.name = name.value; scheduleFlowSave(); });
  name.addEventListener('change', () => renderNodes());
  row.appendChild(name);
  // 兜底标记：模型选不出 / 找不到匹配出口时走这条
  const fb = document.createElement('button');
  fb.type = 'button';
  fb.className = 'branch-fallback' + (b.fallback ? ' on' : '');
  fb.textContent = '兜底';
  fb.title = '模型未给出可识别出口时，改走这条';
  for(const ev of NAME_EVENTS) fb.addEventListener(ev, e => e.stopPropagation());
  fb.addEventListener('click', e => { e.stopPropagation(); setFallbackBranch(n, b); });
  row.appendChild(fb);
  if(chosen){
    const tag = document.createElement('span');
    tag.className = 'branch-chosen';
    tag.textContent = '已选择';
    row.appendChild(tag);
  }
  const del = document.createElement('button');
  del.className = 'param-del';
  del.title = '删除该出口';
  del.textContent = '×';
  del.addEventListener('click', e => { e.stopPropagation(); removeBranch(n, b); });
  row.appendChild(del);
  const hintRow = document.createElement('div');
  hintRow.className = 'view-hint-row';
  const hint = document.createElement('input');
  hint.type = 'text';
  hint.className = 'view-hint';
  hint.value = b.hint || '';
  hint.placeholder = '出口说明（可选，送 AI 辅助判断）';
  for(const ev of NAME_EVENTS) hint.addEventListener(ev, e => e.stopPropagation());
  hint.addEventListener('input', () => { b.hint = hint.value; scheduleFlowSave(); });
  hintRow.appendChild(hint);
  box.append(row, hintRow);
  return box;
}

// 删除节点：任务开始 / 任务结束是流程骨架，必须至少保留一个
function removeNode(n){
  if(!bp || !n) return;
  if(n.type === 'start' || n.type === 'end'){
    const same = bp.nodes.filter(x => x.type === n.type);
    if(same.length <= 1){
      bpToast('「' + (NODE_DEFS[n.type] || {}).title + '」是流程骨架，不可删除');
      return;
    }
  }
  bp.nodes = bp.nodes.filter(x => x.id !== n.id);
  bp.links = bp.links.filter(l => l.from.node !== n.id && l.to.node !== n.id);
  renderNodes();
  scheduleFlowSave();
}

function renderNodes(){
  if(!bp) return;
  const host = $('bpNodes');
  host.innerHTML = '';
  pinWorldReset();      // 节点是重建的，引脚的本地偏移全部作废
  if(typeof edNodeSizeReset === 'function') edNodeSizeReset();   // 节点尺寸缓存同理
  bp.nodes.forEach(n => {
    const el = nodeEl(n);
    if(n.id === bpRunNodeId) el.classList.add('running');
    host.appendChild(el);
  });

  // 文本域按内容撑开：元素入文档后再量高度，保证字符串完整可见、无滚动框
  host.querySelectorAll('textarea').forEach(autoGrowTextarea);

  host.querySelectorAll('.pin').forEach(pin => {
    const nodeId = pin.closest('.node').dataset.id;
    const dir = pin.dataset.dir, key = pin.dataset.key;
    const on = bp.links.some(l => dir === 'out'
      ? (l.from.node === nodeId && l.from.key === key)
      : (l.to.node === nodeId && l.to.key === key));
    pin.classList.toggle('linked', on);
    // 参数引脚连线后隐藏取值控件：值改由上游提供，悬停时出小标签提示
    // 仅输入侧如此；输出侧是数据源，连出去后仍需可编辑
    const row = pin.closest('.port-row');
    if(row && row.classList.contains('has-param') && dir === 'in'){
      row.classList.toggle('is-linked', on);
      const ctl = row.querySelector('.port-param');
      if(ctl) ctl.setAttribute('title', on ? '该参数已由连线提供，断开连线后可手动编辑' : '');
    }
  });

  $('bpEmpty').classList.toggle('hidden', bp.nodes.length > 0);
  renderVars();
  if(window.Editor) Editor.render();
  requestAnimationFrame(renderLinks);
}

function bpToast(msg){
  const t = $('bpToast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(bpToastTimer);
  bpToastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

