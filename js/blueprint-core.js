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
  string:'#6fdc9f', int:'#f2c14e', float:'#ef8354',
  bool:'#e05252', image:'#5b9dff', model:'#c77dff', exec:'#e8eaf0'
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
    // 安全网：内存列表为空时**不覆盖**已存储的流程。
    // 场景：磁盘/其他源有流程，但本源的 localStorage 还没从磁盘回填完（hydrate 是异步的），
    // 此时任何一次保存都会把「空列表」写回去，等于把用户的流程抹掉。
    if (!FLOWS.length) {
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

function showView(name){
  $('homeView').classList.toggle('hidden', name !== 'home');
  $('toolView').classList.toggle('hidden', name !== 'tool');
  $('blueprintView').classList.toggle('hidden', name !== 'bp');
  $('baseView').classList.toggle('hidden', name !== 'base');
  if(name === 'home') renderHome();
  if(name === 'base') refreshBaseState();
}

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
  });
  FLOWS = Array.from(map.values()).sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
  persistFlows();
  renderFlowsWindow();
  bpToast('导入完成：新增 ' + added + ' 个，更新 ' + updated + ' 个，共 ' + FLOWS.length + ' 个工作流');
  return true;
}

function renderFlowsWindow(){
  const grid = $('wfGrid');
  if(!grid) return;
  grid.innerHTML = '';

  const tool = document.createElement('div');
  tool.className = 'wf-card';
  tool.tabIndex = 0;
  tool.innerHTML = `
    <div>
      <div class="wf-name">图像修复工作台</div>
      <div class="wf-desc">粘贴原图 → 诊断幻觉 → 拟写提示词 → 单步生图。适合手动逐轮修复。</div>
    </div>
    <div class="wf-meta"><span class="wf-badge">内置</span><span>单步工具</span></div>`;
  tool.addEventListener('click', () => showView('tool'));
  tool.addEventListener('keydown', e => { if(e.key === 'Enter') showView('tool'); });
  grid.appendChild(tool);

  FLOWS.forEach(f => {
    const card = document.createElement('div');
    card.className = 'wf-card';
    card.tabIndex = 0;

    const top = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'wf-name';
    name.textContent = f.name || '未命名工作流';
    const desc = document.createElement('div');
    desc.className = 'wf-desc';
    const types = [...new Set((f.nodes || []).map(n => (NODE_DEFS[n.type] || {}).title).filter(Boolean))].slice(0, 3);
    desc.textContent = types.length ? types.join(' → ') : '空白蓝图';
    top.append(name, desc);

    const meta = document.createElement('div');
    meta.className = 'wf-meta';
    const count = document.createElement('span');
    count.textContent = (f.nodes || []).length + ' 节点 · ' + (f.links || []).length + ' 连线';
    meta.appendChild(count);

    // 占用大的工作流标出来：localStorage 只有 5MB，谁在吃空间要能一眼看到
    const size = flowInlineBytes(f);
    if(size > 0){
      const sz = document.createElement('span');
      sz.className = 'wf-size' + (size > 1024 * 1024 ? ' hot' : '');
      sz.textContent = fmtBytes(size);
      sz.title = '内联素材（图片 / 模型）占用，超过 1MB 会标红';
      meta.appendChild(sz);
    }
    if(f._stripped){
      const flag = document.createElement('span');
      flag.className = 'wf-size hot';
      flag.textContent = '素材已清理';
      flag.title = '保存时空间不足，这个工作流里的图片/模型已被清空，需要重新上传';
      meta.appendChild(flag);
    }

    const del = document.createElement('button');
    del.className = 'wf-del';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.stopPropagation();
      if(confirm('删除工作流「' + (f.name || '未命名') + '」？')){
        FLOWS = FLOWS.filter(x => x.id !== f.id);
        persistFlows();
        renderHome();
      }
    });

    card.append(top, meta, del);
    card.addEventListener('click', () => openFlow(f.id));
    card.addEventListener('keydown', e => { if(e.key === 'Enter') openFlow(f.id); });
    grid.appendChild(card);
  });

  const add = document.createElement('button');
  add.className = 'wf-card new';
  add.innerHTML = '<span class="wf-plus">+</span><span>新建工作流</span>';
  add.addEventListener('click', createFlow);
  grid.appendChild(add);

  renderStorageMeter();
}

// 本地存储用量：localStorage 约 5MB，快满时提前给出预警，别等到保存失败
function renderStorageMeter(){
  const host = $('wfStorage');
  if(!host) return;
  const used = flowsInlineBytes();
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
    ? '本地存储接近上限：大块图片/模型已自动外置，若仍保存失败请先导出备份再删除旧工作流'
    : '图片与模型已自动存到 IndexedDB，这里只统计未外置的残留部分';
  host.classList.toggle('hidden', FLOWS.length === 0);
}

// ======================= 基线工具 =======================
const BASE_SYS = '你是 Open AGI 的基线对话助手。回答准确、简洁；需要时给出可执行的下一步，不要编造不确定的信息。';
let baseTab = localStorage.getItem('hf_base_tab') || 'chat';
let baseMsgs = [];
let baseChatBusy = false;
let baseRefImage = '';

function llmReady(){
  return !!($('llmKey').value.trim() && $('llmBaseUrl').value.trim() && $('llmModel').value.trim());
}
function imageReady(){
  if(isTripoWeb()) return tripoWebReady;
  if(isTripo()) return !!($('tripoKey').value.trim() && $('imgModel').value.trim());
  const base = $('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim();
  const model = $('imgModel').value.trim() || $('llmModel').value.trim();
  return !!(base && model && ($('imgKey').value.trim() || $('llmKey').value.trim()));
}

