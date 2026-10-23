/* 工作流蓝图：节点定义、状态、基线工具
 * 原 index.html 2767-2951 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ======================= 工作流蓝图 =======================
const NODE_DEFS = {
  start:    { title:'任务开始', dot:'start', desc:'定义工作流输入参数', inputs:[], outputs:[], execIn:false, execOut:['exec'] },
  end:      { title:'任务结束', dot:'end', desc:'收集工作流输出参数', inputs:[], outputs:[], execIn:true, execOut:[] },
  imageIn:  { title:'图像输入', dot:'image', desc:'载入一张图像；参数节点，由下游按需读取', inputs:[], outputs:['image'], execIn:false, execOut:[], pure:true },
  modelIn:  { title:'3D 模型输入', dot:'model', desc:'导入 OBJ / GLB / STL 等模型；参数节点，由下游按需读取', inputs:[], outputs:['model'], execIn:false, execOut:[], pure:true },
  text:     { title:'文本 / 提示词', dot:'text', desc:'固定文本、提示词或补充说明；参数节点，由下游按需读取', inputs:[], outputs:['text'], execIn:false, execOut:[], pure:true },
  numNode:  { title:'数值', dot:'logic', desc:'输出整数 / 浮点，供数值参数引脚连线使用；参数节点，由下游按需读取', inputs:[], outputs:['int','float'], execIn:false, execOut:[], pure:true },
  boolNode: { title:'布尔值', dot:'logic', desc:'手动输出真 / 假；参数节点，由下游按需读取', inputs:[], outputs:['bool'], execIn:false, execOut:[], pure:true },
  aiTask:   { title:'分析任务', dot:'text', desc:'按指令分析文本 / 图像，自定义输入输出引脚与超时', inputs:[], outputs:[], execIn:true, execOut:['exec'] },
  condition:{ title:'IF 条件判断', dot:'logic', desc:'让语言模型判断条件是否成立', inputs:['text'], outputs:['bool'], execIn:true, execOut:['exec'] },
  branch:   { title:'条件分支', dot:'logic', desc:'按布尔值走真 / 假执行线', inputs:['bool'], outputs:[], execIn:true, execOut:['true','false'] },
  varGet:   { title:'获取变量', dot:'var', desc:'读取变量当前值', inputs:[], outputs:[], execIn:false, execOut:[], pure:true },
  varSet:   { title:'设置变量', dot:'var', desc:'把输入值写入变量', inputs:[], outputs:[], execIn:true, execOut:['exec'] },
  imageGen: { title:'图像生成', dot:'gen', desc:'文生图或图生图', inputs:['prompt','image'], outputs:['image'], execIn:true, execOut:['exec'] },
  tripoImg: { title:'Tripo 网页生图', dot:'gen', desc:'通过 Tripo 网页账号文生图 / 图生图，最多可传 3 张参考图', inputs:['prompt','image','image2','image3'], outputs:['image','text'], execIn:true, execOut:['exec'] },
  imageCompress: { title:'压缩图像', dot:'image', desc:'缩放并压缩图像，降低分析 / 生成请求的数据量', inputs:['image'], outputs:['image'], execIn:true, execOut:['exec'] },
  imageSplit: { title:'图像拆分', dot:'image', desc:'AI 按提示词把图中多个视图 / 对象分别拆分出来；每个视图输出一张图 + 一个「是否有」布尔，视图可动态增减', inputs:['image','prompt'], outputs:['text'], execIn:true, execOut:['exec'] },
  model3d:  { title:'3D 生成', dot:'model', desc:'图生 3D 模型（Tripo API 或网页账号）', inputs:['image'], outputs:['model'], execIn:true, execOut:['exec'] },
  tripoModel:{ title:'Tripo 网页生成模型', dot:'model', desc:'通过 Tripo 网页账号图生 3D 模型（单张参考图），可选智能网格 P2.0、拓扑 / 面数、数量、导出格式', inputs:['image'], outputs:['model','text'], execIn:true, execOut:['exec'] },
  tripoModelMulti:{ title:'Tripo 网页多视图生成', dot:'model', desc:'通过 Tripo 网页账号多视图生 3D 模型（前 / 左 / 右 / 后 四张参考图），可选智能网格 P2.0、拓扑 / 面数、数量、导出格式', inputs:['front','left','right','back'], outputs:['model','text'], execIn:true, execOut:['exec'] },
  modelViews:{ title:'3D 模型转四视图', dot:'model', desc:'把 3D 模型渲染为 2×2 四视图（前/后/左/右），可直接喂给生图 AI', inputs:['model'], outputs:['image','text'], execIn:true, execOut:['exec'] },
  result:   { title:'结果输出', dot:'out', desc:'汇总文本、图像与模型结果', inputs:['text','image','model'], outputs:[], execIn:true, execOut:[] },
};
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

const NODE_PARAMS = {
  start: [
    { key:'__params__', ctl:'paramList' }
  ],
  end: [
    { key:'__params__', ctl:'paramList' },
    { tip:'运行结束时汇总各引脚收到的值' }
  ],

  imageIn: [ { key:'__image__', ctl:'filePick' } ],
  modelIn: [ { key:'__model__', ctl:'filePick' } ],

  // 注意：text 节点的 data 键叫 text、输出引脚也叫 text，两者不能共用引脚键，
  // 否则会重复出一条输入引脚。这里用 __content__ 作为独立引脚键。
  text:     [ { key:'__content__', label:'内容', dataKey:'text', ctl:'textarea', ph:'文本内容' } ],

  imageGen: [
    { key:'__prompt__', label:'prompt', dataKey:'prompt', ctl:'textarea', ph:'提示词（未连线时使用）' }
  ],

  tripoImg: [
    { key:'prompt', label:'prompt', ctl:'textarea', ph:'提示词（未连线时使用）' },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:10, max:900, step:10, unit:'秒', default:240 },
    { key:'mode', label:'模式', ctl:'select', default:'auto', options:[
      ['auto','自动（有参考图走图生图）'], ['text','文生图'], ['image','图生图']
    ] },
    { key:'ratio', label:'比例', ctl:'select', default:'auto', options:[
      ['auto','自动'], ['1:1','1:1'], ['16:9','16:9'], ['9:16','9:16'], ['4:3','4:3'], ['3:4','3:4']
    ] },
    { tip:'使用 Tripo 网页账号；运行时先自动切到文生图 / 图生图面板，参考图引脚可接图像。' },
    { tip:'最多可接 3 张参考图：图像 / 参考图2 / 参考图3，按引脚顺序一起上传；只接一张时与原来一致。' }
  ],

  imageCompress: [
    { key:'maxEdge', label:'最长边', ctl:'number', type:'int', min:64, max:4096, step:64, unit:'px', default:1024 },
    { key:'quality', label:'质量',   ctl:'number', type:'int', min:10, max:100, step:5, unit:'%',  default:80 },
    { tip:'等比缩小到最长边限制，并转成 JPEG 输出' }
  ],

  /* 图像拆分：提示词 + 输出形式 + 动态视图列表（viewPins 控件）。
     每个视图生成两条输出引脚：id → 图像（该视图的拆分结果），id__has → 布尔（图中是否有该视图）。 */
  imageSplit: [
    { key:'prompt', label:'提示词', ctl:'textarea', ph:'拆分要求（例如：把图中角色的各个视图分别拆出来，背景忽略）' },
    { key:'output', label:'输出形式', ctl:'select', default:'cutout', options:[
      ['cutout','抠图（透明背景）'], ['crop','矩形裁剪'], ['mask','蒙版图']
    ] },
    { key:'feather', label:'边缘羽化', ctl:'number', type:'int', min:0, max:32, step:1, unit:'px', default:2 },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:10, max:600, step:10, unit:'秒', default:120 },
    { key:'__views__', ctl:'viewPins' },
    { tip:'每个视图输出两张引脚：图像（拆分结果，找不到时为空）+ 布尔（图中是否有该视图）。点「+ 添加视图」或常用视图标签动态增减。' }
  ],

  model3d: [ { tip:'使用设置中的 Tripo 版本，输出 GLB 模型' } ],

  tripoModel: [
    { tip:'通过 Tripo 网页账号生成 3D 模型；参考图引脚接图像（未连线需页面里已上传）' },
    { key:'mode', label:'模式', ctl:'select', default:'smart', options:[
      ['smart','智能网格'], ['hd','高精度模型'], ['','页面默认']
    ] },
    { key:'version', label:'网格版本', ctl:'select', default:'P2.0', options:[
      ['P2.0','P2.0'], ['P1.0','P1.0'], ['','页面默认']
    ] },
    { key:'topology', label:'拓扑', ctl:'select', default:'', options:[
      ['','页面默认'], ['quad','四边面'], ['tri','三角面']
    ] },
    { key:'faceCount', label:'面数', ctl:'number', type:'int', min:0, max:25000, step:100, unit:'面（500–25000，0=默认）', default:0 },
    { key:'count', label:'数量', ctl:'select', type:'int', default:1, options:[[1,'1'],[2,'2'],[4,'4']] },
    { key:'format', label:'格式', ctl:'select', default:'', options:[
      ['','页面默认'], ['glb','GLB'], ['obj','OBJ'], ['fbx','FBX'], ['stl','STL'], ['usdz','USDZ']
    ] },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:30, max:1800, step:30, unit:'秒', default:420 },
    { tip:'生成走网页自动化，会消耗网页账号积分；存在风控风险。' }
  ],
  tripoModelMulti: [
    { tip:'前 / 左 / 右 / 后 四个引脚各接一张参考图（至少接一个）；页面会自动切到多视图上传模式' },
    { key:'mode', label:'模式', ctl:'select', default:'smart', options:[
      ['smart','智能网格'], ['hd','高精度模型'], ['','页面默认']
    ] },
    { key:'version', label:'网格版本', ctl:'select', default:'P2.0', options:[
      ['P2.0','P2.0'], ['P1.0','P1.0'], ['','页面默认']
    ] },
    { key:'topology', label:'拓扑', ctl:'select', default:'', options:[
      ['','页面默认'], ['quad','四边面'], ['tri','三角面']
    ] },
    { key:'faceCount', label:'面数', ctl:'number', type:'int', min:0, max:25000, step:100, unit:'面（500–25000，0=默认）', default:0 },
    { key:'count', label:'数量', ctl:'select', type:'int', default:1, options:[[1,'1'],[2,'2'],[4,'4']] },
    { key:'format', label:'格式', ctl:'select', default:'', options:[
      ['','页面默认'], ['glb','GLB'], ['obj','OBJ'], ['fbx','FBX'], ['stl','STL'], ['usdz','USDZ']
    ] },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:30, max:1800, step:30, unit:'秒', default:600 },
    { tip:'生成走网页自动化，会消耗网页账号积分；存在风控风险。' }
  ],

  condition: [ { key:'instruction', ctl:'textarea', ph:'判断条件（例如：输入内容是否描述了人物）' } ],

  branch: [ { tip:'按布尔引脚的值决定走「真」或「假」执行线' } ],

  // 取值控件挂在输出引脚上（side:'out'），布尔节点本身是数据源，没有输入引脚
  boolNode: [ { key:'bool', label:'取值', ctl:'bool', default:true, side:'out' } ],

  // 数值节点：一次同时提供「整数」与「浮点」两种输出，覆盖全部数值输入引脚
  numNode: [
    { key:'float', label:'数值', dataKey:'value', ctl:'number', step:'any', default:0, side:'out' },
    { tip:'同一数值同时从两个引脚输出：整数引脚取整，浮点引脚保留小数' }
  ],

  aiTask: [
    { key:'instruction', ctl:'textarea', ph:'任务指令（例如：总结输入文本并列出风险点）' },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:0, max:3600, step:10, unit:'秒，0 表示不限时', default:TASK_TIMEOUT_DEFAULT },
    { key:'__taskPins__', ctl:'taskPins' }
  ],

  modelViews: PARAM_PARAMS([
    { key:'画布尺寸',     ctl:'select', default:2048, options:[[2048,'2048 (2K)'],[4096,'4096 (4K)']] },
    { key:'间距',         ctl:'number', min:0,   max:256, step:8,   default:0 },
    { key:'线宽',         ctl:'number', min:0.4, max:6,   step:0.1, default:1.4 },
    { key:'线色',         ctl:'color',  default:'#2b2b2b' },
    { key:'填充色',       ctl:'color',  default:'#ffffff' },
    { key:'背景色',       ctl:'color',  default:'#ffffff' },
    { key:'背景不透明度', ctl:'number', min:0,   max:1,   step:0.05, default:1 },
    { key:'模式',         ctl:'select', default:'line', options:[['line','线框'],['solid','实体']] }
  ]),

  result: [ { tip:'连接文本、图像或模型，运行后在此汇总结果' } ],
  varGet: [],
  varSet: [ { tip:'运行到此处时，把「值」引脚的数据写入该变量' } ]
};

const NODE_LIB = [
  // 「输入」组按数据类型排齐：文本 / 数值 / 布尔 / 图像 / 3D 模型，与 TYPE_META 一一对应
  { group:'输入', types:['text','numNode','boolNode','imageIn','modelIn'] },
  { group:'分析任务', types:['aiTask'] },
  { group:'图像任务', types:['imageGen','imageCompress','imageSplit','tripoImg'] },
  { group:'3D 任务', types:['model3d','modelViews','tripoModel','tripoModelMulti'] },
  { group:'逻辑', types:['condition','branch'] },
  { group:'流程', types:['start','end'] },
  { group:'输出', types:['result'] },
];
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
let nodeDrag = null;
let panDrag = null;
let libDrag = null;
let bpPickedNode = null;
let bpPickedModelNode = null;
let bpPickedParam = null;
let bpPickedVar = null;
let bpRunBusy = false;
let bpRunNodeId = null;
let bpRunLinkId = null;

function persistFlows(){
  try {
    // 安全网：内存列表为空时**不覆盖**已存储的流程。
    // 场景：磁盘/其他源有流程，但本源的 localStorage 还没从磁盘回填完（hydrate 是异步的），
    // 此时任何一次保存都会把「空列表」写回去，等于把用户的流程抹掉。
    if (!FLOWS.length) {
      try {
        const cur = JSON.parse(localStorage.getItem('hf_flows') || '[]');
        if (Array.isArray(cur) && cur.length) return true;   // 保持原样，不覆盖
      } catch (e) {}
    }
    localStorage.setItem('hf_flows', JSON.stringify(FLOWS));
    return true;
  } catch(e){
    bpToast('保存失败：本地存储空间不足，请删除部分工作流或使用更小的图片');
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
function exportFlows(){
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

