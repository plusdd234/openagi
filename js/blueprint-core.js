/* 工作流蓝图：节点定义、状态、基线工具
 * 原 index.html 2767-2951 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ======================= 工作流蓝图 =======================
/* 节点表：由 js/node-defs.js 的 registerNode() 填充（架构改良 A） */
const NODE_DEFS = {};

/* ---------------------------------------------------------------
 * 节点参数声明表（统一参数形态的唯一来源）
 *
 * 设计目标：所有节点的参数一律「名称 + 取值控件紧跟引脚右侧」，
 * 连线后自动隐藏控件。形态由声明驱动，不再散落 if(n.type===...) 分支。
 *
 * 字段：
 *   key    node.data 上的键；与引脚同名时（如 prompt / bool）自动绑定该引脚
 *   side   'in'（默认）挂到输入引脚右侧；'out' 挂到输出引脚右侧（数据源节点用）
 *   dataKey 引脚键与数据键分离时用（如 text 节点：引脚 __content__、数据键 text）
 *   label  显示名
 *   ctl    控件：text / textarea / number / select / bool
 *   min/max/step   number 的范围（超出自动夹取）
 *   unit   number 后面的单位后缀
 *   options [['值','显示'], ...]   select 选项
 *   default(value)  缺省值，可为常量或返回函数
 *   ph     占位提示
 *   store  写入位置：'data'（默认，写 node.data[key]）或 'param'（写参数对象自身）
 *   tip    跟在控件后的浅色说明，或直接给整块提示文字
 * -------------------------------------------------------------- */
const DATA_PARAMS = (list) => list.map(o => Object.assign({ store:'data' }, o));
const PARAM_PARAMS = (list) => list.map(o => Object.assign({ store:'param' }, o));

// 分析任务的默认超时（秒）。必须定义在 NODE_PARAMS 之前，否则声明表里引用不到
const TASK_TIMEOUT_DEFAULT = 300;

const NODE_PARAMS = {};

const NODE_LIB = [];
const PIN_META = {
  instruction: { label:'指令', type:'string' },
  maxEdge:     { label:'最长边', type:'int' },
  quality:     { label:'质量', type:'int' },
  timeout:     { label:'超时', type:'int' },
  int:    { label:'整数', type:'int' },
  float:  { label:'浮点', type:'float' },
  image:  { label:'图像', type:'image' },
  image2: { label:'参考图2', type:'image' },
  image3: { label:'参考图3', type:'image' },
  front:  { label:'前视图', type:'image' },
  left:   { label:'左视图', type:'image' },
  right:  { label:'右视图', type:'image' },
  back:   { label:'后视图', type:'image' },
  hint:   { label:'补充', type:'string' },
  prompt: { label:'提示词', type:'string' },
  text:   { label:'文本', type:'string' },
  model:  { label:'模型', type:'model' },
  bool:   { label:'布尔', type:'bool' },
  exec:   { label:'执行', type:'exec' },
  true:   { label:'真', type:'exec' },
  false:  { label:'假', type:'exec' },
};
const PIN_COLORS = {
  string:'#1f9d63', int:'#b07d00', float:'#d2691e',
  bool:'#c0392b', image:'#2b7cd3', model:'#8e44ad', exec:'#6b7280'
};
const TYPE_META = {
  int:    { label:'整数' },
  float:  { label:'浮点' },
  string: { label:'字符串' },
  bool:   { label:'布尔' },
  image:  { label:'图像' },
  model:  { label:'模型' },
};
const TYPE_ORDER = ['int','float','string','bool','image','model'];
const TASK_OUT_TYPES = ['string','int','float','bool'];
const SVG_NS = 'http://www.w3.org/2000/svg';
// 节点内可编辑控件必须拦下这几个事件，否则一按就开始拖节点 / 框选画布
const NAME_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick'];
const uid = () => Math.random().toString(36).slice(2, 9);

let FLOWS = [];
try { FLOWS = JSON.parse(localStorage.getItem('hf_flows') || '[]'); } catch(e) { FLOWS = []; }
/* 本会话是否确认过「流程列表的真实状态」：
 *   启动时 localStorage 里有流程 → 已确认为真；
 *   config.js 的 hydrate 合并到流程后调 markFlowsLoaded() → 已确认为真；
 *   persistFlows 成功写过一次 → 已确认为真。
 * persistFlows 的「空列表防抹」安全网只在该标志为 false 时生效——
 * 否则「删光所有工作流」会被当成「还没 hydrate」，空列表不落盘，
 * 被删的流程留在 localStorage 和磁盘 store 里，下次加载全部复活
 * （2026-10-29 用户实测：删除工作流后刷新又出来了）。 */
let flowsKnown = FLOWS.length > 0;
function markFlowsLoaded(){ flowsKnown = true; }

/* 删除墓碑（tombstone）：被删工作流的 id 集合。
 * 为什么需要它：工作流在 localStorage（按 origin 隔离）与磁盘 store（只有一份）之间
 * 用「按 id 取较新版本的 union」合并。union 是只增不减的——磁盘上那份还留着被删流程，
 * 下次 hydrate 一合并就把删掉的流程并了回来（2026-10-29 用户实测：删一个刷新又恢复）。
 * 只有显式记下「哪些 id 已删除」，合并时把它们剔除，删除才能真正跨源/跨刷新生效。
 * 墓碑随 hf_flows_del 一起落盘，并由 config.js 的 hydrate 在本地与磁盘两源之间收敛。 */
let deletedFlowIds = new Set();
try {
  JSON.parse(localStorage.getItem('hf_flows_del') || '[]').forEach(id => { if (id) deletedFlowIds.add(id); });
} catch (e) {}
function persistDeletedIds(){
  try { localStorage.setItem('hf_flows_del', JSON.stringify(Array.from(deletedFlowIds))); }
  catch (e) {}
}
function recordFlowDelete(id){
  if (!id) return;
  deletedFlowIds.add(id);
  persistDeletedIds();   // 触发 setItem 包装器把墓碑 POST 到磁盘中转
}
// 重新导入某个 id 视为「复活」，清掉它的墓碑，避免下次加载又被过滤掉
function clearFlowDelete(id){
  if (!id) return;
  if (deletedFlowIds.delete(id)) persistDeletedIds();
}
// 迁移调用已移到 js/bind.js 开头：migrateAiTaskNodes 定义在更晚加载的 js/desktop.js，
// 此处直接调用会因跨 script 不再提升而抛 ReferenceError。
let bp = null;
let bpPan = { x: 40, y: 50 };
let bpZoom = 1;
let bpSaveTimer = null;
let bpToastTimer = null;
let linkDrag = null;
// 节点拖动 / 画布平移的上下文已收进 js/editor.js 的 Editor.drag（手势状态机统一管理）
let libDrag = null;
let bpPickedNode = null;
let bpPickedModelNode = null;
let bpPickedParam = null;
let bpPickedVar = null;
let bpRunBusy = false;
// 运行期中断：停止按钮按下后，置标志并 abort 控制器，所有在途请求一并中止
let bpRunAbort = false;
let bpRunCtrl = null;
let bpRunNodeId = null;
let bpRunLinkId = null;

function fmtBytes(n){
  n = Number(n) || 0;
  if(n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// 工作流里内联大块（图片 / 模型 / 超长文本）的字节数，用于容量展示
function flowInlineBytes(f){
  let n = 0;
  const seen = new WeakSet();
  const walk = v => {
    if(typeof v === 'string'){ if(v.length >= BLOB_MIN) n += v.length; return; }
    if(!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    Object.keys(v).forEach(k => walk(v[k]));
  };
  walk(f);
  return n;
}
function flowsInlineBytes(){
  return FLOWS.reduce((s, f) => s + flowInlineBytes(f), 0);
}

/* 磁盘口径：大块外置成存根后，真正要写进 localStorage 的字节数。
 * ⚠ 计量条 / 列表尺寸必须用它，不能用上面的内存口径——
 * 外置只发生在写盘那一刻（persistFlows → blobPackFlows），内存里的 FLOWS
 * 永远是完整原文。拿内存口径画条，拖一个 8MB 模型进来就「永远爆仓」，
 * 而盘上其实只有一个几十字节的存根，保存毫无压力（2026-10-29 用户实测踩过）。
 * 内存口径只留给 persistFlows 的救援阶梯：那里问的是「清掉它能省多少」。 */
function flowDiskBytes(f){
  if(typeof blobPackFlows !== 'function') return flowInlineBytes(f);
  try { return JSON.stringify(blobPackFlows([f])).length; }
  catch(e){ return flowInlineBytes(f); }
}
function flowsDiskBytes(){
  if(typeof blobPackFlows !== 'function') return flowsInlineBytes();
  try { return JSON.stringify(blobPackFlows(FLOWS)).length; }
  catch(e){ return flowsInlineBytes(); }
}

// 把某个工作流里的内联大块清掉（最后手段：优先保住当前正在编辑的流程）
function stripInline(f){
  let hit = 0;
  const seen = new WeakSet();
  const walk = v => {
    if(Array.isArray(v)){
      if(seen.has(v)) return v;
      seen.add(v);
      for(let i = 0; i < v.length; i++) v[i] = walk(v[i]);
      return v;
    }
    if(v && typeof v === 'object'){
      if(seen.has(v)) return v;
      seen.add(v);
      Object.keys(v).forEach(k => { v[k] = walk(v[k]); });
      return v;
    }
    if(typeof v === 'string' && v.length >= BLOB_MIN && v.indexOf(BLOB_STUB) !== 0){
      hit++;
      return '';
    }
    return v;
  };
  walk(f);
  if(hit) f._stripped = true;
  return hit;
}

function persistFlows(){
  try {
    // 安全网：内存列表为空时**不覆盖**已存储的流程 —— 但只保护「本会话从未确认过
    // 流程状态」的情况（hydrate 可能还没落）。用户真的删光了（flowsKnown=true）
    // 必须把空列表写下去，否则删除会在下次加载时复活。
    if (!FLOWS.length && !flowsKnown) {
      try {
        const cur = JSON.parse(localStorage.getItem('hf_flows') || '[]');
        if (Array.isArray(cur) && cur.length){
          // 盘上还有流程：不覆盖（防抹数据），但仍回收没人引用的大块数据
          blobGC([cur].concat(typeof bp !== 'undefined' && bp ? [bp] : []));
          return true;
        }
      } catch (e) {}
    }
  } catch(e){
    bpToast('保存失败：' + friendlyErr(e));
    return false;
  }

  // 存根只存在于写盘的副本里（内存里是还原后的原文），
  // 所以回收时要把这份副本也算进「仍被引用」，否则刚外置的数据会被当成垃圾删掉
  let packed = null;
  const write = () => {
    // 图片 / 模型等大块数据外置到 IndexedDB，localStorage 里只留存根
    packed = blobPackFlows(FLOWS);
    const js = JSON.stringify(packed);
    localStorage.setItem('hf_flows', js);
    return js.length;
  };

  try {
    write();
    // 成功写过一次（含删光后写空列表）→ 本会话的列表状态已被确认，
    // 之后的空列表是真实删除，安全网不再拦
    flowsKnown = true;
    const roots = [packed].concat(FLOWS);
    if(typeof bp !== 'undefined' && bp) roots.push(bp);
    blobGC(roots);
    return true;
  } catch(e){
    // 救援阶梯：IndexedDB 不可用时大块数据还内联着，空间又真的放不下 ——
    // 这时宁可丢素材也不能丢工作流本身（图和模型能重新上传，节点和连线不能）。
    // 先动别人的，最后才动当前正在编辑的这个。
    const rank = f => ({ f, size: flowInlineBytes(f) });
    const others = FLOWS.filter(f => !bp || f.id !== bp.id).map(rank).filter(x => x.size > 0).sort((a, b) => b.size - a.size);
    const mine = (bp && FLOWS.filter(f => f.id === bp.id).map(rank).filter(x => x.size > 0)) || [];
    const ladder = others.concat(mine);
    let dropped = 0, touchedMine = false;
    for(const v of ladder){
      if(!stripInline(v.f)) continue;
      dropped++;
      if(bp && v.f.id === bp.id) touchedMine = true;
      try { write(); } catch(_){ continue; }
      if(touchedMine){
        bpToast('存储空间不足：已清空 ' + dropped + ' 个工作流里的图片/模型以完成保存（含当前这个），素材需重新上传');
      } else {
        bpToast('存储空间不足：已清理 ' + dropped + ' 个非当前工作流里的图片/模型以完成保存，这些素材需要重新上传');
      }
      return true;
    }
    let need = 0;
    try { need = JSON.stringify(blobPackFlows(FLOWS)).length; } catch(_){ need = flowsInlineBytes(); }
    bpToast('保存失败：本地存储已满（这些工作流需要约 ' + fmtBytes(need) + '）'
      + '。请先「导出备份」，再删除不用的工作流');
    return false;
  }
}

/* ---- 视图转场：工作台 ↔ 工作流编辑器 ----
 * .hidden 是 display:none，没法直接过渡，所以：进来的那一页先上桌并挂 .view-in
 * （CSS 动画从「位移 + 透明」推到原位），出去的那一页挂 .view-out 淡出，动画跑完才真正隐藏。
 * 转场只做位移不做缩放：画布里的连线/端口坐标是 getBoundingClientRect 两两相减算的，
 * 祖先带 scale 会把差值一起放缩，那 300ms 里连线会歪；位移在相减里会互相抵消，安全。 */
const VIEW_SWAP_MS = 360;
let viewNow = '';        // 当前视图：home | tool | bp
let viewTimer = 0;
let viewBooted = false;  // 启动动画只放一次

function viewElOf(name){
  return name === 'bp' ? $('blueprintView')
    : name === 'tool' ? $('toolView')
    : name === 'home' ? $('homeView') : null;
}
function viewReduceMotion(){
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch(e){ return false; }
}

function showView(name){
  const next = viewElOf(name);
  if(!next) return;
  // 同一视图：只刷新内容，不重播动画（点 logo / 返回按钮经常落在这条路上）
  if(viewNow === name && !next.classList.contains('hidden')){
    if(name === 'home') renderHome();
    return;
  }
  const prev = viewNow && viewNow !== name ? viewElOf(viewNow) : null;
  const animate = !viewReduceMotion();

  clearTimeout(viewTimer);
  ['homeView', 'toolView', 'blueprintView'].forEach(id => {
    const v = $(id);
    if(v) v.classList.remove('view-in', 'view-out');
  });

  // 出去的页面动画期间必须还在场，跑完才隐藏
  next.classList.remove('hidden');
  if(prev) prev.classList.remove('hidden');
  void next.offsetWidth;                       // 强制回流，动画才会从起始态重新播

  if(animate){
    document.body.classList.add('view-swapping');   // 两页叠一起才谈得上交叉
    next.classList.add('view-in');
    if(prev) prev.classList.add('view-out');
  }
  viewNow = name;

  if(name === 'home'){
    renderHome();
    if(!viewBooted) deskBootIn();
  }

  const settle = () => {
    viewPendingSettle = null;
    ['homeView', 'toolView', 'blueprintView'].forEach(id => {
      const v = $(id);
      if(v && v !== next) v.classList.add('hidden');
    });
    next.classList.remove('view-in');
    if(prev) prev.classList.remove('view-out');
    document.body.classList.remove('view-swapping');
  };
  if(animate){
    viewPendingSettle = settle;
    viewTimer = setTimeout(settle, VIEW_SWAP_MS);
  }else settle();
}

/* 启动动画：画布立起来 → 图标逐个落位 → 输入条升起（延迟按 nth-child 排在 CSS 里） */
function deskBootIn(){
  viewBooted = true;
  const wall = $('deskWall');
  if(!wall) return;
  wall.classList.add('desk-boot');
  setTimeout(() => wall.classList.remove('desk-boot'), 1200);
}

/* 把重活排到转场之后：翻页是合成器上的 transform/opacity，
 * 主线程一旦被同步渲染占住（49 个节点 + 78 条连线的建 DOM 与量尺寸）动画就会被整段吃掉，
 * 看起来像「直接跳到终点」。当前没有在转场就直接跑，不额外拖慢。
 * 测试与脚本要同步拿结果时调 flushViewSwap() 立刻执行。 */
let viewDeferred = [];
let viewPendingSettle = null;

function viewAfterSwap(fn){
  if(!document.body.classList.contains('view-swapping')){ fn(); return; }
  viewDeferred.push(fn);
  requestAnimationFrame(() => setTimeout(flushViewSwap, VIEW_SWAP_MS + 20));
}

/* 立刻收尾：跳完转场动画 + 跑掉排队中的渲染。
 * 脚本/测试要在 openFlow 之后同步拿 DOM（拖线要拿引脚坐标）就调它，
 * 否则画布还在 translateX 过程中，量出来的坐标会偏。 */
function flushViewSwap(){
  if(viewPendingSettle){
    clearTimeout(viewTimer);
    const s = viewPendingSettle;
    viewPendingSettle = null;
    s();
  }
  if(!viewDeferred.length) return;
  const list = viewDeferred;
  viewDeferred = [];
  list.forEach(fn => { try { fn(); } catch(e){ console.warn('[view] 滞后任务失败', e); } });
}
function viewCancelSwap(){ viewDeferred = []; }

function renderHome(){
  renderDeskIcons();
  renderDeskDock();
  renderFlowsWindow();
  startDeskClock();
}

// ---- 工作流导出 / 导入（手动备份）----
// localStorage 按 origin 隔离，磁盘只有一份；导出文件是唯一能跨浏览器/跨机器带走的副本。
// 导入时按 id 归并，同 id 取 updated 更大的版本，不会用旧文件盖掉新工作流。
async function exportFlows(){
  // 导出必须是完整数据：先等 IndexedDB 载入，把存根还原成真正的图片 / 模型
  if(typeof blobEnsure === 'function') await blobEnsure();
  if(typeof blobResolveFlows === 'function') blobResolveFlows(FLOWS);
  const payload = {
    app: 'openagi', kind: 'workflows', version: 1,
    exportedAt: new Date().toISOString(),
    flows: FLOWS,
  };
  const text = JSON.stringify(payload, null, 1);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const filename = 'openagi-workflows-' + stamp + '.json';
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    bpToast('已导出 ' + FLOWS.length + ' 个工作流：' + filename);
  } catch (e) {
    bpToast('导出失败：' + e.message);
  }
}

function importFlowsText(text){
  let data = null;
  try { data = JSON.parse(text); } catch (e) { bpToast('导入失败：不是合法的 JSON 文件'); return false; }
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.flows) ? data.flows : null);
  if (!arr) { bpToast('导入失败：文件里没有找到工作流列表'); return false; }
  const before = FLOWS.length;
  const map = new Map(FLOWS.map(f => [f.id, f]));
  let added = 0, updated = 0;
  arr.forEach(f => {
    if (!f || !f.id || !Array.isArray(f.nodes)) return;
    // 兼容旧版节点类型
    if (typeof migrateAiTaskNodes === 'function') { try { migrateAiTaskNodes(f); } catch (e) {} }
    if (typeof migrateLegacyBranches === 'function') { try { migrateLegacyBranches(f); } catch (e) {} }
    if (typeof migrateLegacyCondition === 'function') { try { migrateLegacyCondition(f); } catch (e) {} }
    const old = map.get(f.id);
    if (!old) { map.set(f.id, f); added++; }
    else if ((Number(f.updated) || 0) > (Number(old.updated) || 0)) { map.set(f.id, f); updated++; }
    clearFlowDelete(f.id);   // 重新导入视为「复活」，清掉它的删除墓碑
  });
  FLOWS = Array.from(map.values()).sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
  persistFlows();
  renderFlowsWindow();
  bpToast('导入完成：新增 ' + added + ' 个，更新 ' + updated + ' 个，共 ' + FLOWS.length + ' 个工作流');
  return true;
}

/* 工作流列表的渲染入口。
 * 桌面上的「工作流」App 已移除（左侧列表就是全部），这里直接渲染左侧列表 + 底部占用条。
 * 函数名保留 renderFlowsWindow：blob-store / config 等处仍在调用它。 */
function renderFlowsWindow(){
  closeWfMenu();
  renderDeskFlows();
  renderStorageMeter();
}

// ---- 桌面左侧固定工作流区 ----
let wfActiveId = '';
let wfMenuEl = null;

const WF_SIDE_GLYPH = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="M8.5 9.5h7M8.5 13h5"/></svg>'
};

function wfAgoText(ts){
  if(!ts) return '未保存';
  const d = Date.now() - ts;
  if(d < 60000) return '刚刚';
  if(d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if(d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if(d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

function closeWfMenu(){
  if(!wfMenuEl) return;
  wfMenuEl.remove();
  wfMenuEl = null;
  document.removeEventListener('pointerdown', wfMenuOutside, true);
  document.removeEventListener('keydown', wfMenuEsc, true);
}
function wfMenuOutside(e){
  if(wfMenuEl && !wfMenuEl.contains(e.target)) closeWfMenu();
}
function wfMenuEsc(e){
  if(e.key === 'Escape'){ e.stopPropagation(); closeWfMenu(); }
}

// 行内改名：Electron 不支持 window.prompt()（调用即抛错，按钮会「点了没反应」），
// 所以重命名必须用行内输入框，Enter 提交 / Esc 取消 / 失焦提交
function beginFlowRename(anchor, f){
  const item = anchor && anchor.closest ? anchor.closest('.wf-side-item') : null;
  const nameEl = item ? item.querySelector('.wf-side-name') : null;
  if(!nameEl) return;
  const old = f.name || '未命名工作流';
  const input = document.createElement('input');
  input.className = 'wf-side-rename';
  input.type = 'text';
  input.value = old;
  input.maxLength = 60;
  input.setAttribute('aria-label', '重命名工作流');
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = ok => {
    if(done) return;
    done = true;
    const next = input.value.trim();
    if(ok && next && next !== old){
      f.name = next;
      f.updated = Date.now();
      persistFlows();
    }
    renderHome();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if(e.key === 'Enter'){ e.preventDefault(); commit(true); }
    else if(e.key === 'Escape'){ e.preventDefault(); commit(false); }
  });
  input.addEventListener('keyup', e => e.stopPropagation());
  input.addEventListener('keypress', e => e.stopPropagation());
  // 点输入框不能触发 item 的 click（那会 openFlow），也不能被外点关闭逻辑误伤
  input.addEventListener('pointerdown', e => e.stopPropagation());
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('blur', () => commit(true));
}

function openWfMenu(anchor, f){
  closeWfMenu();
  const menu = document.createElement('div');
  menu.className = 'wf-menu';

  const rename = document.createElement('button');
  rename.textContent = '重命名';
  rename.addEventListener('click', () => {
    closeWfMenu();
    beginFlowRename(anchor, f);
  });

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = '删除';
  del.addEventListener('click', () => {
    closeWfMenu();
    if(!confirm('删除工作流「' + (f.name || '未命名') + '」？')) return;
    FLOWS = FLOWS.filter(x => x.id !== f.id);
    if(wfActiveId === f.id) wfActiveId = '';
    recordFlowDelete(f.id);   // 记下墓碑，删除才能跨源/跨刷新真正生效
    persistFlows();
    renderHome();
  });

  menu.append(rename, del);
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.right - 122, innerWidth - 126)) + 'px';
  menu.style.top = Math.min(r.bottom + 4, innerHeight - 80) + 'px';
  wfMenuEl = menu;
  setTimeout(() => {
    if(!wfMenuEl) return;
    document.addEventListener('pointerdown', wfMenuOutside, true);
    document.addEventListener('keydown', wfMenuEsc, true);
  }, 0);
}

function wfSideItemEl(f){
  const item = document.createElement('div');
  item.className = 'wf-side-item' + (f.id === wfActiveId ? ' active' : '');
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.innerHTML = WF_SIDE_GLYPH.doc + '<span class="wf-side-item-main">' +
    '<span class="wf-side-name"></span><span class="wf-side-sub"></span></span>' +
    '<span class="wf-side-more" role="button" aria-label="更多操作" title="更多操作">⋯</span>';
  item.querySelector('.wf-side-name').textContent = f.name || '未命名工作流';
  // 副标题：节点数 + 素材占用 + 更新时间
  // 占用必须显示出来：localStorage 只有 5MB，谁在吃空间要能一眼看到
  // 列表尺寸也用磁盘口径：跟容量条同一个道理，内存口径会把存根态画成 8MB
  const size = flowDiskBytes(f);
  const parts = [(f.nodes || []).length + ' 节点'];
  if(size > 0) parts.push(fmtBytes(size));
  parts.push(wfAgoText(f.updated));
  item.querySelector('.wf-side-sub').textContent = parts.join(' · ');
  if(size > 1024 * 1024) item.querySelector('.wf-side-sub').classList.add('hot');
  if(f._stripped){
    item.querySelector('.wf-side-sub').textContent += ' · 素材已清理';
    item.title = '保存时空间不足，这个工作流里的图片/模型已被清空，需要重新上传';
  }

  const more = item.querySelector('.wf-side-more');
  more.addEventListener('click', e => {
    e.stopPropagation();
    openWfMenu(more, f);
  });

  item.addEventListener('click', () => {
    wfActiveId = f.id;
    openFlow(f.id);
  });
  item.addEventListener('keydown', e => {
    if(e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      wfActiveId = f.id;
      openFlow(f.id);
    }
  });
  return item;
}

function renderDeskFlows(){
  const list = $('deskSideList');
  if(!list) return;
  const count = $('deskSideCount');
  if(count) count.textContent = FLOWS.length;
  list.innerHTML = '';

  if(!FLOWS.length){
    const empty = document.createElement('div');
    empty.className = 'wf-side-empty';
    empty.textContent = '还没有工作流，点上方「新建工作流」开始搭建蓝图。';
    list.appendChild(empty);
    return;
  }
  FLOWS.forEach(f => list.appendChild(wfSideItemEl(f)));
}

// 本地存储用量：localStorage 约 5MB，快满时提前给出预警，别等到保存失败
function renderStorageMeter(){
  const host = $('wfStorage');
  if(!host) return;
  // 磁盘口径（见 flowDiskBytes 注释）：内存里的大原文在盘上只是存根，
  // 按内存量会把「完全健康」画成「爆仓」
  const used = flowsDiskBytes();
  const LIMIT = 5 * 1024 * 1024;
  const pct = Math.min(100, Math.round(used / LIMIT * 100));
  host.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'wf-storage-label';
  label.textContent = '内联素材 ' + fmtBytes(used) + ' / 约 5 MB';
  const bar = document.createElement('span');
  bar.className = 'wf-storage-bar';
  const fill = document.createElement('span');
  fill.className = 'wf-storage-fill' + (pct >= 80 ? ' hot' : pct >= 50 ? ' warn' : '');
  fill.style.width = Math.max(2, pct) + '%';
  bar.appendChild(fill);
  host.append(label, bar);
  host.title = pct >= 80
    ? '本地存储接近上限：图片/模型保存时自动外置到 IndexedDB，这里已经是外置后的占用。仍超限时先导出备份，再删除不用的工作流'
    : '按写盘后的实际占用统计：大块图片/模型自动存进 IndexedDB，localStorage 里只留几十字节的存根';
  // 常驻显示：占用信息放在列表底部，没工作流时也要能看到容量余量
  host.classList.remove('hidden');
}

// ======================= 就绪判定 =======================
// 「基线工具」（对话 / 文生图 / 图生图三个单步面板）已整块移除，
// 这里只留 llmReady / imageReady 给状态胶囊与工作流节点做前置校验。
function llmReady(){
  // 登录了云端账号也算就绪（模型与 Key 由网关托管）
  if(typeof gwLogged === 'function' && gwLogged()) return true;
  return !!($('llmKey').value.trim() && $('llmBaseUrl').value.trim() && $('llmModel').value.trim());
}
function imageReady(){
  if(isTripoWeb()) return tripoWebReady;
  if(isTripo()) return !!($('tripoKey').value.trim() && $('imgModel').value.trim());
  const base = $('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim();
  const model = $('imgModel').value.trim() || $('llmModel').value.trim();
  return !!(base && model && ($('imgKey').value.trim() || $('llmKey').value.trim()));
}

