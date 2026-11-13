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
/* 图标语言（2026-11-13 全面重设计）
 * 统一规格：24×24 viewBox / 描边 1.7 / 圆头圆角 / 不填充 / 图形落在 3–21 的安全区内。
 * 三条自我约束：
 *   ① 每个图标最多 3 个「视觉块」，20px 下缩得下去；
 *   ② 同族共用母题但必须有一个判别特征（气泡族：AI 双行 / 模板三行带折角）；
 *   ③ 不用纯文字缩写（20px 下读不出，必须用图形符号说事）。 */
const DESK_GLYPH = {
  /* 角色工坊：头 + 身「分件」母题——圆头、虚线颈缝、肩身三块。
   * 虚线是判别特征（全表唯一一条虚线非选区框），表达「把角色拆成部件再建 3D」。 */
  chara: '<circle cx="12" cy="6.3" r="3.1"/><path d="M9.2 12.6h5.6" stroke-dasharray="2.1 1.9"/><path d="M5.8 20.7c.8-4 3.1-6.1 6.2-6.1s5.4 2.1 6.2 6.1"/>',
  /* 编码：一对尖括号夹一条斜杠 = </> 的最小写法，也是编辑器的通用徽标。
   * 别用「终端窗口 + 光标」——那和本地生图的三节点图标在 20px 下几乎分不清。 */
  code: '<path d="m8.6 8.2-4.3 3.8 4.3 3.8"/><path d="m15.4 8.2 4.3 3.8-4.3 3.8"/><path d="m13.4 5.6-2.8 12.8"/>',
  /* AI 对话：实心感的圆角气泡 + 两行内容，专指「多轮、有上下文」。
   * 尾巴压在左下角、两行横线右端不等长（真对话不会两头齐平）。 */
  chat: '<path d="M4.2 5.6h15.6a1.6 1.6 0 0 1 1.6 1.6v7.2a1.6 1.6 0 0 1-1.6 1.6H9.4L5 20.2v-4.2H4.2a1.6 1.6 0 0 1-1.6-1.6V7.2a1.6 1.6 0 0 1 1.6-1.6Z"/><path d="M8 9.6h8"/><path d="M8 12.6h5"/>',
  /* 【保留未用】文生图：画框 + 太阳 + 山，是「生成一张图」的通用符号。
   * 目前没有独立 App；将来做单步文生图工具时直接取用，别新造一个撞脸的。 */
  t2i: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><circle cx="8.8" cy="9.8" r="1.5"/><path d="m4.2 16.6 4.6-4.2 3.4 2.8 3-2.4 4.2 3.8"/>',
  /* 【保留未用】图生图：两张叠放的画框 + 中间的转换箭头，指向「A 变成 B」。 */
  i2i: '<rect x="3.4" y="8.4" width="9.4" height="9.4" rx="2"/><path d="M8.6 4.4h8.2a2.4 2.4 0 0 1 2.4 2.4v8.2"/><path d="m9.4 14.6 1.8-1.8 1.4 1.4 1.4-1.4"/>',
  /* 流程（也是 deskSvg 的兜底）：上两个节点、下一个汇聚节点，用直角折线连起来。
   * 用直角而非弧线，是为了和图库/节点的圆角块在 20px 下区分开。 */
  flow: '<rect x="3.2" y="4.2" width="6.6" height="5.4" rx="1.6"/><rect x="14.2" y="4.2" width="6.6" height="5.4" rx="1.6"/><rect x="8.7" y="14.6" width="6.6" height="5.2" rx="1.6"/><path d="M6.5 9.6v2.4a2 2 0 0 0 2 2h.2"/><path d="M17.5 9.6v2.4a2 2 0 0 1-2 2h-.2"/>',
  /* 模型控制台：一块芯片 + 两侧引脚 + 中心核心方块。芯片是「跑模型的硬件」，
   * 与模型库的立方体（存 3D 资产）视觉上完全不同族。 */
  model: '<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.6"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M9.4 3.4v2.8M14.6 3.4v2.8M9.4 17.8v2.8M14.6 17.8v2.8"/><path d="M3.4 9.4h2.8M3.4 14.6h2.8M17.8 9.4h2.8M17.8 14.6h2.8"/>',
  /* 本地生图：ComfyUI 的心智就是拖节点连成一张图 —— 上排两个输入节点
   * 用直角线汇到下方一个输出节点。比抽象齿轮更能让人知道点进去是什么。
   * 注意别和 flow 撞：flow 是「两个进、一个出」且块更小，comfy 的块更宽、连线更长。 */
  comfy: '<rect x="2.8" y="3.6" width="7.2" height="5" rx="1.5"/><rect x="14" y="3.6" width="7.2" height="5" rx="1.5"/><rect x="7.6" y="15.4" width="8.8" height="5" rx="1.5"/><path d="M6.4 8.6v3.6a2.2 2.2 0 0 0 2.2 2.2h2.4"/><path d="M17.6 8.6v3.6a2.2 2.2 0 0 1-2.2 2.2h-2.4"/>',
  /* 图库：一叠偏置的画框 —— 后面那张只露出右上两边（一小段 L 形），
   * 前面一张带山与太阳。「叠放」才表达「很多张」；四宫格会被读成「多视图」。
   * 刻意不画后排那张的完整矩形：两条重叠边在 20px 下会糊成一块灰。 */
  gallery: '<path d="M9.4 4.4h6.4a2.6 2.6 0 0 1 2.6 2.6v8.4"/><rect x="3.4" y="7" width="13.6" height="13.4" rx="2.4"/><circle cx="7.6" cy="11.6" r="1.4"/><path d="m4.4 18.6 3.2-3a1.5 1.5 0 0 1 2.1 0l1.8 1.7 1.2-1.1a1.5 1.5 0 0 1 2.1 0l1.6 1.5"/>',
  /* 模型库：线框立方体，3D 资产的通用符号。中心加一个向心的三条棱，
   * 表示「库里的件是完整资产」，和建模 app 的顶点手柄区分。 */
  modelLib: '<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6l8-4.4Z"/><path d="m4 7.6 8 4.4 8-4.4"/><path d="M12 12v8.8"/>',
  /* 视频库：胶片画格 + 两侧齿孔 + 中央实心播放三角。
   * 齿孔是判别特征——它把「一格格卷起来的影音」和纯播片屏幕区分开，
   * 也和图库的叠放画框不同族（那边是图片，这边是胶片）。
   * 齿孔只保留每侧三孔：四孔在 24px 下会糊成一串虚线。 */
  video: '<rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/><path d="M4.4 8.2h1.1M4.4 12h1.1M4.4 15.8h1.1M18.5 8.2h1.1M18.5 12h1.1M18.5 15.8h1.1"/>',
  /* 名片：证件卡框 + 头像 + 右侧两行信息，是「自我介绍」的通用符号。
   * 别用「人形剪影」——那个在通讯录类 App 里太泛滥，和开发者名片不是一件事。 */
  card: '<rect x="2.8" y="5" width="18.4" height="14" rx="2.6"/><circle cx="8.6" cy="10.6" r="2.1"/><path d="M5.4 16.2c.5-1.7 1.8-2.6 3.2-2.6s2.7.9 3.2 2.6"/><path d="M14.6 9.8h4M14.6 13.4h4"/><path d="M14.6 16.4h2.2"/>',
  /* 视图工坊：四角取景框 + 中央 2×2 棋盘贴图。
   * 取景框 = 多视图取景，棋盘 = 贴图回投，两件事合起来才是这个 App 的定位；
   * 排雷：不画成四宫格整框——那跟图库的叠放画框太近，摆一起会分不清。 */
  mv: '<path d="M3.4 8.6V5a1.6 1.6 0 0 1 1.6-1.6h3.6"/><path d="M15.4 3.4H19a1.6 1.6 0 0 1 1.6 1.6v3.6"/><path d="M20.6 15.4V19a1.6 1.6 0 0 1-1.6 1.6h-3.6"/><path d="M8.6 20.6H5a1.6 1.6 0 0 1-1.6-1.6v-3.6"/><rect x="8.2" y="8.2" width="7.6" height="7.6" rx="1.1"/><path d="M8.2 8.2h3.8v3.8H8.2zM12 12h3.8v3.8H12z" fill="currentColor" stroke="none"/>',
  /* 建模：**六边形轮廓**里的三条棱 + 三个顶点手柄 —— 六边形是「可编辑多边形选择」
   * 在 3D 软件里的通用符号。刻意不复用 modelLib 的立方体：实测两个立方体只有
   * 77% 可分辨度，而库里「存」和这里「改」是两个完全不同的动作，必须不同形。
   * 六边形比立方体多四条斜边，20px 下轮廓一眼可辨。 */
  modeler: '<path d="M12 3.3 19.3 7.4v9.2L12 20.7 4.7 16.6V7.4L12 3.3Z"/><path d="M12 8.2 15.4 10.1v3.8L12 15.8 8.6 13.9v-3.8L12 8.2Z"/><path d="M12 3.3v4.9M19.3 7.4l-3.9 2.7M4.7 7.4l3.9 2.7"/><circle cx="12" cy="3.3" r="1.15"/><circle cx="19.3" cy="7.4" r="1.15"/><circle cx="4.7" cy="7.4" r="1.15"/><circle cx="12" cy="20.7" r="1.15"/>',
  /* 图像工坊：左侧画框（含山与太阳）+ 右侧两条带滑钮的参数线 = 编辑工作站。
   * 只画**两条**：原来三条线加三颗滑钮实测墨量 43%，20px 下糊成一片竖线。
   * 两条必须长短不一、滑钮一左一右，否则还是会读成「≡」。 */
  ps: '<rect x="2.6" y="4.6" width="11.6" height="14.8" rx="2.2"/><circle cx="6.8" cy="8.8" r="1.3"/><path d="m3.4 15.8 2.4-2.4a1.5 1.5 0 0 1 2.1 0l1.5 1.5 1-1a1.5 1.5 0 0 1 2.1 0"/><path d="M16.6 9h4.4M17.4 15h3.6"/><circle cx="19.4" cy="9" r="1.5"/><circle cx="17.9" cy="15" r="1.5"/>',
  /* 浏览器：地球经纬 —— 外圆 + 赤道椭圆 + 一条经线 + 两极短弧。
   * 用「球面网格」而非「窗口 + 地址栏」，后者和 playe r 的屏幕框撞脸。 */
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.4 2.5 3.6 5.4 3.6 8.6S14.4 18.5 12 20.6c-2.4-2.1-3.6-5.4-3.6-8.6S9.6 5.9 12 3.4Z"/>',
  /* 模板 App（hello）：气泡族第三个成员 —— 与 chat 同形，但右侧带**折角**、
   * 里面是三条左对齐短行（骨架稿的样子）。折角 = 「这是一份待填的模板」。 */
  hello: '<path d="M4.4 5.4h15.2a1.6 1.6 0 0 1 1.6 1.6v7a1.6 1.6 0 0 1-1.6 1.6h-2.2v3.8l-3.8-3.8H4.4a1.6 1.6 0 0 1-1.6-1.6v-7a1.6 1.6 0 0 1 1.6-1.6Z"/><path d="M7.4 9h9.2M7.4 12h5.6"/>'
};
function deskSvg(kind){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (DESK_GLYPH[kind] || DESK_GLYPH.flow) + '</svg>';
}

/* 桌面 App 的注册表。
 *
 * ⚠ **这里现在是空的，而且应该一直空着。** 全部 App 都迁到了 apps/<id>/app.js，
 * 由 registerApp() 在自己执行时 push 进来（顺序由各自声明的 order 决定）。
 *
 * 往这里加一项 = 又制造一个「多个 AI 并行开发时会撞车」的位置，而且窗口 DOM 还得回
 * index.html 里手写。加 App 的做法见 apps/README.md：建目录 + node tools/app-scan.js。
 *
 * 数组本身留着是因为 desk-shell 的渲染/拖拽/标签全按 DESK_APPS 遍历，
 * registerApp 也只是往里 push —— 空数组就是「还没注册任何 App」的正常初始态。 */
const DESK_APPS = [
  /* 「对话 / 文生图 / 图生图」三个单步工具 App 与「基线工具」界面已整块移除：
   * 对话有底部 AI 输入条（翻页即对话页）、生图有工作流节点与本地 ComfyUI，
   * 再留一套单步面板是重复入口。
   * 「工作流」App 已移除：左侧固定列表就是全部工作流，再摆一个桌面 App 是重复入口。 */
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
/* App 页标题 / 窗口 id 的映射。**同样应该一直空着** —— 全部由 registerApp() 写进来。
 * 留在 desk-shell 里是因为 deskMountApp / deskTabTouch / 标签反查都按它查窗口 id。 */
const DESK_APP_META = {
  /* 空。加 App 请见 apps/README.md，不要往这里加回来。 */
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
  /* 顶栏切换条：这里记一笔（而不是在 openDeskApp 里记）——
     模块自己也会调 deskMountApp（图库 / 播放器 / 多视图 / 名片），只挂在 openDeskApp 上会漏掉它们。 */
  deskTabTouch(win, title);
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
  deskTabRender();              // 桌面上不显示切换条，但标签表要留着（回来还能点）
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
  /* 「关闭」和「返回桌面」是两件事：关闭要划掉顶栏那个标签，返回保留（见 deskTabs 的说明）。
     deskTabClose 自己也会调到这儿，重复 forget 只是 findIndex 返回 -1，无副作用。 */
  deskTabForget(win.id);
  if(win === deskAppWin) deskAppLeave();
  else win.classList.add('hidden');
  deskTabRender();
}

/* ---------------- 顶栏 App 切换条 ----------------
 * 为什么「跳转」很便宜：App 页同一时刻只挂一个窗口，换 App 时上一个被 deskAppRestore
 * 搬回桌面层并加 .hidden —— **内容一点没丢**。所以切标签只要把节点搬回来（deskMountApp），
 * 不需要重跑模块的 open()。反过来，重跑 open() 会重新探测引擎 / 重扫图库 / 重置画布，
 * 「切个标签」变成一次刷新，还把滚动位置和选中状态一起冲掉。
 *
 * 这张表是「打开过的 App」的唯一真源：
 *   · 挂进 App 页 → 记一条（写在 deskMountApp 里，任何调用方都覆盖得到）；
 *   · 被关闭（deskCloseWin）→ 划掉；
 *   · 返回桌面（deskAppLeave）→ **不**划掉。返回只是离开，不是关闭，
 *     回来还要能点回刚才那个 App。
 *
 * ⚠ 窗口和 App 不是一一对应：图库 / 模型库共用 #libWin。所以表的键取**窗口 id**，
 *   名字取挂载时传进来的 title（openLibrary 会按 mode 传「图库」或「模型库」）。
 *   若按 DESK_APP_META[appId].title 反查，libWin 永远只会显示成「图库」。
 */
let deskTabs = [];   // [{ win:'modelDeskWin', appId:'modeldesk', name:'建模' }]

function deskTabFind(winId){ return deskTabs.find(t => t.win === winId) || null; }

/* 按窗口 id 反查是哪个 App 开的。一个窗口挂多个 App 时（libWin）用标题区分。 */
function deskTabAppOf(winId, title){
  const ids = Object.keys(DESK_APP_META).filter(k => DESK_APP_META[k].win === winId);
  if(!ids.length) return '';
  if(ids.length === 1) return ids[0];
  return ids.find(k => DESK_APP_META[k].title === title) || ids[0];
}

/* 记一条（同窗口只更新，不重复追加）—— 名字跟着最近一次挂载走 */
function deskTabTouch(win, name){
  if(!win || !win.id) return;
  const appId = deskTabAppOf(win.id, name);
  const label = name || (appId ? DESK_APP_META[appId].title : '') || win.id;
  const rec = deskTabFind(win.id);
  if(rec){ rec.appId = appId || rec.appId; rec.name = label; }
  else deskTabs.push({ win: win.id, appId: appId, name: label });
  deskTabRender();
}

function deskTabForget(winId){
  const i = deskTabs.findIndex(t => t.win === winId);
  if(i >= 0) deskTabs.splice(i, 1);
}

/* 什么时候显示：只要有标签、且工作台这一页在场就显示——**包括桌面首页**。
 * 「返回主页」只是把当前 App 放回桌面层，打开的 App 并没有关掉，藏起切换条等于
 * 让用户以为它们都没了，还得回桌面逐个双击图标把窗口重新翻出来。桌面上没有「当前 App」，
 * 这一条就只是把现有标签平铺出来，点哪个进哪个。
 * 唯一要挡的是工作流编辑器：从左栏点进 bp 视图时 #homeView 会被 .hidden 掉，
 * 而 .desk-wall 上的 app-open 不跟着撤 —— 那时标签点一下只是把窗口搬进一个看不见的页面，
 * 什么反应都没有（见 blueprint-core.js 的 settle()）。
 * 每次重绘都整段重建（最多十几个按钮），换来的是状态永远和 deskTabs / deskAppWin 一致。 */
function deskTabRender(){
  const bar = $('appbarTabs');
  if(!bar) return;
  const home = $('homeView');
  const show = deskTabs.length > 0 && !!home && !home.classList.contains('hidden');
  bar.classList.toggle('show', show);
  if(!show){ bar.innerHTML = ''; return; }
  const keep = bar.scrollLeft;          // 标签多时重绘会把横向滚动位置冲掉
  bar.innerHTML = deskTabs.map(t => {
    const app = deskAppById(t.appId) || {};
    const on = $(t.win) === deskAppWin;
    /* 图标跟桌面图标同源（app.icon 优先，模型商店用的是羊驼头图片）；
       类名换掉是因为 .desk-app-icon .desk-app-img 那套尺寸只在桌面图标里成立。 */
    const ico = (app.icon || deskSvg(app.glyph)).replace('class="desk-app-img"', 'class="abt-img"');
    return '<button type="button" class="abt' + (on ? ' on' : '') + '" data-win="' + t.win + '"' +
      ' role="tab" aria-selected="' + (on ? 'true' : 'false') + '" title="' + t.name + '">' +
      '<span class="abt-ico">' + ico + '</span>' +
      '<span class="abt-name">' + t.name + '</span>' +
      '<span class="abt-x" title="关闭">×</span>' +
    '</button>';
  }).join('');
  bar.scrollLeft = keep;
  /* 当前标签必须在可视区内：标签多到装不下时，切过去的那个很可能在右边看不见，
     高亮就白给了。只做最小位移，不把它推到最中间（那样每次切换整条都在晃）。 */
  const onEl = bar.querySelector('.abt.on');
  if(onEl){
    const br = bar.getBoundingClientRect(), or = onEl.getBoundingClientRect();
    if(or.left < br.left) bar.scrollLeft -= (br.left - or.left) + 10;
    else if(or.right > br.right) bar.scrollLeft += (or.right - br.right) + 10;
  }
}

/* 切到某个 App：纯搬节点 + 广播，不重跑 open()（理由见本节开头） */
function deskSwitchApp(winId){
  const win = $(winId);
  if(!win || win === deskAppWin) return false;
  const rec = deskTabFind(winId);
  const meta = (rec && rec.appId && DESK_APP_META[rec.appId]) || {};
  const ok = deskMountApp(win, meta.title || (rec ? rec.name : ''), meta.sub || '');
  if(ok) deskTabRender();
  return ok;
}

/* 关掉一个标签：关的是当前这个就切到相邻标签（像浏览器），
 * 只有它是最后一个时才退回桌面——比「关掉就跳回桌面、还得再双击图标」少一步。 */
function deskTabClose(winId){
  const i = deskTabs.findIndex(t => t.win === winId);
  if(i < 0) return;
  const win = $(winId);
  const active = !!win && win === deskAppWin;
  deskTabs.splice(i, 1);
  if(!win){ deskTabRender(); return; }
  if(!active){ win.classList.add('hidden'); deskTabRender(); return; }
  const nb = deskTabs[i] || deskTabs[i - 1];   // 已经删掉一条，同下标的元素就是「右边那个」
  if(nb && $(nb.win)) deskSwitchApp(nb.win);
  else deskCloseWin(win);
  deskTabRender();
}

(function bindDeskAppPage(){
  /* 返回主页：App 页没有自己的页头了，回桌面只有顶栏这一个入口 */
  const home = $('btnDeskHome');
  if(home) home.addEventListener('click', () => deskAppLeave());

  /* 标签条用事件委托：重绘会换掉所有按钮，逐个绑监听等于每次重绘都漏一批。
     .abt-x 是 span 不是 button —— button 里套 button 是非法嵌套，浏览器会自己拆结构。 */
  const tabs = $('appbarTabs');
  if(tabs){
    tabs.addEventListener('click', e => {
      const hit = e.target && e.target.closest ? e.target : null;
      if(!hit) return;
      const x = hit.closest('.abt-x');
      if(x){ const b = x.closest('.abt'); if(b) deskTabClose(b.dataset.win); return; }
      const b = hit.closest('.abt');
      if(b) deskSwitchApp(b.dataset.win);
    });
    /* 中键关闭：和浏览器标签的习惯一致，手比点那个小叉快 */
    tabs.addEventListener('auxclick', e => {
      if(e.button !== 1) return;
      const b = e.target && e.target.closest ? e.target.closest('.abt') : null;
      if(!b) return;
      e.preventDefault();
      deskTabClose(b.dataset.win);
    });
    /* 竖向滚轮横向翻标签：这条只横向溢出，Chromium 不会把 deltaY 自动转过去，
       没有触控板的话标签一多就只能拖着走。 */
    tabs.addEventListener('wheel', e => {
      if(Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if(tabs.scrollWidth <= tabs.clientWidth) return;
      tabs.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  /* Ctrl+Tab / Ctrl+Shift+Tab 轮换当前打开的 App。
     写成捕获阶段 + preventDefault：不然焦点在输入框里时会被浏览器/输入法先吃掉。 */
  window.addEventListener('keydown', e => {
    if(!e.ctrlKey || e.key !== 'Tab' || deskTabs.length < 2) return;
    e.preventDefault();
    const cur = deskTabs.findIndex(t => $(t.win) === deskAppWin);
    const step = e.shiftKey ? -1 : 1;
    const next = deskTabs[((cur < 0 ? 0 : cur) + step + deskTabs.length) % deskTabs.length];
    if(next) deskSwitchApp(next.win);
  }, true);
})();

$('deskWall').addEventListener('pointerdown', e => {
  // 空白处（外围白底 / 灰底画布 / 图标容器）点击都取消选中
  if(e.target === $('deskWall') || e.target === $('deskIcons') || e.target === $('deskCanvas')) clearDeskSel();
});

/* ---------------- 左侧工作流栏收纳 ----------------
 * 收起后只留一条 46px 的窄轨，展开按钮留在原位；桌面画布自动铺满。
 * 只切 .collapsed，列表 DOM 不重建，展开时滚动位置和选中态都还在。
 * 状态记 localStorage，下次进来保持上次的样子。 */
(function bindDeskSideCollapse(){
  const side = document.querySelector('.home.desk .desk-side');
  const btn = $('btnDeskSideToggle');
  if(!side || !btn) return;
  const KEY = 'hf_desk_side_collapsed';
  function apply(collapsed, persist){
    side.classList.toggle('collapsed', !!collapsed);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const label = collapsed ? '展开工作流栏' : '收起工作流栏';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if(persist){ try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch(e){} }
  }
  btn.addEventListener('click', () => apply(!side.classList.contains('collapsed'), true));
  let init = false;
  try { init = localStorage.getItem(KEY) === '1'; } catch(e){}
  apply(init, false);
})();

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

