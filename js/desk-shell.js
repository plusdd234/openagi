/* 虚拟机桌面：图标 / Dock / 格子拖拽 / App 页窗口挂载
 *
 * 原 index.html 2952-4381 行 → js/desktop.js，2026-11-01 再按职责拆成三个文件：
 *   1) desk-shell.js       桌面本身（本文件）：图标、时钟、App 页翻页、窗口挂载
 *   2) flow-canvas.js      流程画布：坐标 / 连线 / 存档 / 节点新建
 *   3) flow-node-view.js   节点 DOM：参数控件、引脚、渲染
 *
 * ⚠ 三个文件都是**普通脚本顶层代码**（不套 IIFE），函数名保持原样。
 *   它们靠全局脚本作用域互相看见，和拆之前住在同一个文件里等价；
 *   改名前先搜一遍另外两个文件。
 */
const DESK_GLYPH = {
  chat: '<path d="M4 5h16v10H9l-5 4V5Z"/>',
  /* 裸聊用「一个气泡 + 一条横线」：和 AI 对话的气泡同源，但气泡里只有一句话，
   * 表达「单轮、无记忆」。别再加省略号三个点——那会被读成「正在输入」。 */
  bare: '<path d="M4 5h16v10H9l-5 4V5Z"/><path d="M9.5 10h5"/>',
  /* 图像转 SVG 用「贝塞尔曲线 + 控制点」：这是矢量编辑器的通用符号，
   * 不用再画一个画框——那个和文生图/图生图的图标撞脸。 */
  i2s: '<path d="M4.5 17.5c3.5 0 3.5-11 7-11s3.5 11 8 11"/><circle cx="4.5" cy="17.5" r="1.6"/><circle cx="11.5" cy="6.5" r="1.6"/><circle cx="19.5" cy="17.5" r="1.6"/><path d="M11.5 6.5l-2.4 3M11.5 6.5l2.4 3"/>',
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
  mv: '<rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.6"/><path d="M12 2.6v3.4M12 18v3.4M2.6 12h3.4M18 12h3.4"/>',
  /* 建模用「线框立方体 + 顶点手柄」：立方体是 3D 资产，四个小圆点表示可编辑顶点。
   * 别复用 modelLib 的立方体——那个是「存模型」，这里是「改模型」。 */
  modeler: '<path d="M12 3 20 7.5v9L12 21 4 16.5v-9L12 3Z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/><circle cx="12" cy="3" r="1.1"/><circle cx="20" cy="7.5" r="1.1"/><circle cx="4" cy="7.5" r="1.1"/><circle cx="12" cy="21" r="1.1"/>',
  /* 图像工坊用「画框 + 滑杆」：画框表示图像，右侧两条带圆点的线表示调色/滤镜。
   * 不能只画一张图——那和图库、文生图的图标会撞；带参数线才像「编辑工作站」。 */
  ps: '<rect x="3" y="4" width="12.5" height="16" rx="2.2"/><path d="M4 16.2 6.6 13a1.6 1.6 0 0 1 2.4 0l1.5 1.6 1.2-1.2a1.6 1.6 0 0 1 2.3 0l.7.7"/><circle cx="12" cy="8.2" r="1"/><path d="M18 8.2h3M18 12h3M18 15.8h3"/><circle cx="16.7" cy="8.2" r="1.2"/><circle cx="19.3" cy="12" r="1.2"/><circle cx="16.7" cy="15.8" r="1.2"/>'
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
  /* 裸聊：摆在 AI 对话旁边，因为它就是「同一条链路的最小对照」。
   * 它不带 system、不带上下文、不带历史，输入 token ≈ 你打的字；
   * 打开时只需聚焦输入框——窗口本身由 openDeskApp 按 DESK_APP_META 挂载。 */
  { id:'bare', name:'裸聊', glyph:'bare', type:'system', open: () => {
    if(typeof window.bareChatApp !== 'undefined' && typeof window.bareChatApp.focus === 'function') window.bareChatApp.focus();
  } },
  /* 图像转 SVG：模型只看得到工具摘要，SVG 草稿留在本地。
   * 摆在裸聊旁边——两者是同一条链路的两端：裸聊测「一句话能返回什么」，
   * 这里测「模型能不能靠工具把图还原成分层矢量」。 */
  { id:'img2svg', name:'图像转 SVG', glyph:'i2s', type:'system', open: () => {
    if(typeof window.img2svgApp !== 'undefined' && typeof window.img2svgApp.open === 'function') window.img2svgApp.open();
  } },
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
  /* 图像工坊：图片的「深加工」去处。图库负责收，它负责改——
   * 多图层、选区、滤镜和大尺寸瓦片渲染，和上一代只做快速修正的图片编辑器分工不同。 */
  { id:'imglab', name:'图像工坊', glyph:'ps', type:'system', open: () => {
    if(typeof window.psLab !== 'undefined' && typeof window.psLab.open === 'function') window.psLab.open();
  } },
  /* 建模：网格资产工作站。摆在模型库旁边——一个是「造」，一个是「存」。
   * MVP-1 用可编辑 face-vertex 网格；点线面工具随后续里程碑接入。 */
  { id:'modeldesk', name:'建模', glyph:'modeler', type:'system', open: () => {
    if(typeof window.modelDesk !== 'undefined' && typeof window.modelDesk.open === 'function') window.modelDesk.open();
  } },
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
const DESK_ROW = 6;   // 首屏默认一行几个图标

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
  bare:     { title: '裸聊',   sub: '无 system / 无上下文 / 无历史', win: 'bareWin' },
  img2svg:  { title: '图像转 SVG', sub: '工具调用 + 本地分层草稿', win: 'img2svgWin' },
  store:    { title: '模型商店', sub: '安装 / 删除本地模型', win: 'storeWin'  },
  comfy:    { title: '本地生图', sub: 'ComfyUI 引擎',        win: 'comfyWin'  },
    gallery:  { title: '图库',     sub: '生成结果与素材',      win: 'libWin'    },
    modelLib: { title: '模型库',   sub: '本机模型文件',        win: 'libWin'    },
    imglab:   { title: '图像工坊', sub: '图层 · 选区 · 滤镜 · 瓦片大图', win: 'imgLabWin' },
    modeldesk: { title: '建模',    sub: '网格资产工作站 · 变换 · 材质槽',      win: 'modelDeskWin' },
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
     返回入口（顶栏 The seed 左侧的主页图标）走的是 deskAppLeave()，它不经过对话模块自己的 close，
     靠事件才能保证输入条一定会被搬回桌面，不会跟着窗口一起被隐藏。 */
  try{ window.dispatchEvent(new CustomEvent('openagi:app-mounted', { detail: { win: win.id || '' } })); }catch(e){}
  const wall = $('deskWall');
  if(wall){
    /* 翻页状态只留一个（app-open），免得两页同时翻过来。
       对话以前有自己那套 chat-open，现在它也是普通 App，走同一条路。 */
    wall.classList.remove('chat-open');
    wall.classList.add('app-open');
  }
  deskHomeBtn(true);
  return true;
}

/* 顶栏的返回主页图标：只在 App 页出现。桌面本身就是主页，摆一个点了没反应的按钮是噪音。
 * title/sub 仍保留在 deskMountApp 的签名里——调用方还在传（搜 openDeskApp 一堆），
 * 但页头已经删掉，不再往界面上写应用名。 */
function deskHomeBtn(on){
  const b = $('btnDeskHome');
  if(b) b.classList.toggle('show', !!on);
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
  deskHomeBtn(false);
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
  /* 全屏中的窗口被关掉：先把全屏退掉，否则窗口藏了、屏幕还是被它占着 */
  if(document.fullscreenElement === win) document.exitFullscreen().catch(() => {});
  if(win === deskAppWin) deskAppLeave();
  else win.classList.add('hidden');
}

(function bindDeskAppPage(){
  /* 返回主页：App 页没有自己的页头了，回桌面只有顶栏这一个入口 */
  const home = $('btnDeskHome');
  if(home) home.addEventListener('click', () => deskAppLeave());
})();

$('deskWall').addEventListener('pointerdown', e => {
  // 空白处（外围白底 / 灰底画布 / 图标容器）点击都取消选中
  if(e.target === $('deskWall') || e.target === $('deskIcons') || e.target === $('deskCanvas')) clearDeskSel();
});

/* ---------------- 全屏 ----------------
 * 两层全屏，互不重叠：
 *   ① 应用级：整个 The seed 窗口。桌面版交给主进程 setFullScreen——菜单里的 F11
 *      改的也是原生全屏状态，两边必须同源；网页版没有桥，退回整页 HTML 全屏。
 *   ② 窗口级：应用内的 .os-win（3D 预览 / 图库 / 多视图…）。直接对该元素
 *      requestFullscreen：HTML 全屏走顶层层，窗口祖先的翻页透视与位移都不再参与布局，
 *      所以能真正铺满屏幕，而不是「把容器撑大」。Esc 是浏览器自带的退出键。
 */
(function bindFullscreen(){
  const appBtn = $('btnAppFull');
  const icoExpand = $('appFullIcoExpand');
  const icoExit = $('appFullIcoExit');
  const bridge = window.openagiDesktop;
  const hasNative = !!(bridge && typeof bridge.toggleWindowFullscreen === 'function');

  function syncApp(on){
    if(!appBtn) return;
    on = !!on;
    appBtn.title = on ? '退出全屏（F11）' : '全屏（F11）';
    appBtn.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    appBtn.classList.toggle('on', on);
    /* SVG 不是 HTMLElement，`.hidden = true` 只是挂了个属性、不会真的隐藏，
       这里必须改成内联 display。 */
    if(icoExpand) icoExpand.style.display = on ? 'none' : '';
    if(icoExit) icoExit.style.display = on ? '' : 'none';
  }

  if(hasNative){
    if(typeof bridge.onWindowFullscreen === 'function') bridge.onWindowFullscreen(syncApp);
    if(typeof bridge.windowIsFullscreen === 'function'){
      Promise.resolve(bridge.windowIsFullscreen()).then(syncApp).catch(() => {});
    }
  }
  if(appBtn){
    appBtn.addEventListener('click', () => {
      if(hasNative){ bridge.toggleWindowFullscreen(); return; }
      if(document.fullscreenElement){ document.exitFullscreen().catch(() => {}); return; }
      const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      if(p && p.catch) p.catch(() => {});
    });
  }

  /* ---- 窗口级 ---- */
  const EXPAND_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/></svg>';
  const SHRINK_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5"/></svg>';

  const allWins = () => Array.prototype.slice.call(document.querySelectorAll('.os-win'));

  function syncWin(){
    allWins().forEach(w => {
      const b = w.querySelector('.os-win-exp');
      if(!b) return;
      const on = document.fullscreenElement === w;
      b.title = on ? '退出全屏（Esc）' : '全屏显示';
      b.setAttribute('aria-label', b.title);
      b.classList.toggle('on', on);
      /* 图标跟着状态换：展开 ↔ 收回。不重建按钮，只改一处 innerHTML。 */
      const ico = on ? SHRINK_ICO : EXPAND_ICO;
      if(b.innerHTML !== ico) b.innerHTML = ico;
    });
  }

  function toggleWin(w){
    if(document.fullscreenElement === w){ document.exitFullscreen().catch(() => {}); return; }
    const p = w.requestFullscreen && w.requestFullscreen();
    if(p && p.catch) p.catch(() => {});
  }

  allWins().forEach(w => {
    const bar = w.querySelector('.os-win-bar');
    const close = w.querySelector('.os-win-close');
    if(!bar || w.querySelector('.os-win-exp')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'os-win-exp';
    b.innerHTML = EXPAND_ICO;
    b.title = '全屏显示';
    b.setAttribute('aria-label', '全屏显示');
    b.addEventListener('click', e => { e.stopPropagation(); toggleWin(w); });
    bar.insertBefore(b, close || null);
    /* 点关闭时先把全屏退掉，否则窗口藏起来了还占着整块屏幕 */
    if(close){
      close.addEventListener('click', () => {
        if(document.fullscreenElement === w) document.exitFullscreen().catch(() => {});
      }, true);
    }
    /* 双击标题栏 = 铺满 / 还原，和桌面窗口的习惯一致（按钮上双击不算） */
    bar.addEventListener('dblclick', e => {
      if(e.target.closest('button')) return;
      toggleWin(w);
    });
  });

  document.addEventListener('fullscreenchange', () => {
    /* 网页版没有主进程回推，只能自己判断整页全屏；桌面版以主进程状态为准 */
    if(!hasNative) syncApp(document.fullscreenElement === document.documentElement);
    syncWin();
  });

  /* 全屏里按 Esc：只退出全屏，不要顺手把窗口关掉。
   * 很多 App 自己监听 Esc 关闭（图库、播放器、多视图…），全屏时会被一起触发，
   * 变成「按 Esc = 退全屏 + 关窗口」。这里在捕获阶段截住：手动 exitFullscreen，
   * 再阻止事件继续下发。只 stopPropagation 不行——Chromium 的「Esc 退全屏」
   * 也在监听器链上，掐断后它自己也不退了。 */
  window.addEventListener('keydown', e => {
    if(e.key !== 'Escape' || !document.fullscreenElement) return;
    e.preventDefault();
    e.stopPropagation();
    document.exitFullscreen().catch(() => {});
  }, true);

  syncWin();
})();

