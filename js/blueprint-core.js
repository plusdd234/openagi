/* 工作流蓝图：节点定义、状态、基线工具
 * 原 index.html 2767-2951 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ======================= 工作流蓝图 =======================
const NODE_DEFS = {
  start:    { title:'任务开始', dot:'start', desc:'定义工作流输入参数', inputs:[], outputs:[], execIn:false, execOut:['exec'] },
  end:      { title:'任务结束', dot:'end', desc:'收集工作流输出参数', inputs:[], outputs:[], execIn:true, execOut:[] },
  imageIn:  { title:'图像输入', dot:'image', desc:'载入一张图像作为起点', inputs:[], outputs:['image'], execIn:false, execOut:['exec'] },
  modelIn:  { title:'3D 模型输入', dot:'model', desc:'导入 OBJ / GLB / STL 等模型', inputs:[], outputs:['model'], execIn:false, execOut:['exec'] },
  text:     { title:'文本 / 提示词', dot:'text', desc:'固定文本、提示词或补充说明', inputs:[], outputs:['text'], execIn:false, execOut:['exec'] },
  boolNode: { title:'布尔值', dot:'logic', desc:'手动输出真 / 假', inputs:[], outputs:[], execIn:false, execOut:['exec'] },
  aiTask:   { title:'分析任务', dot:'text', desc:'按指令分析文本 / 图像，自定义输入输出引脚与超时', inputs:[], outputs:[], execIn:true, execOut:['exec'] },
  condition:{ title:'IF 条件判断', dot:'logic', desc:'让语言模型判断条件是否成立', inputs:['text'], outputs:['bool'], execIn:true, execOut:['exec'] },
  branch:   { title:'条件分支', dot:'logic', desc:'按布尔值走真 / 假执行线', inputs:['bool'], outputs:[], execIn:true, execOut:['true','false'] },
  varGet:   { title:'获取变量', dot:'var', desc:'读取变量当前值', inputs:[], outputs:[], execIn:false, execOut:[], pure:true },
  varSet:   { title:'设置变量', dot:'var', desc:'把输入值写入变量', inputs:[], outputs:[], execIn:true, execOut:['exec'] },
  imageGen: { title:'图像生成', dot:'gen', desc:'文生图或图生图', inputs:['prompt','image'], outputs:['image'], execIn:true, execOut:['exec'] },
  tripoImg: { title:'Tripo 网页生图', dot:'gen', desc:'通过 Tripo 网页账号文生图 / 图生图', inputs:['prompt','image'], outputs:['image','text'], execIn:true, execOut:['exec'] },
  imageCompress: { title:'压缩图像', dot:'image', desc:'缩放并压缩图像，降低分析 / 生成请求的数据量', inputs:['image'], outputs:['image'], execIn:true, execOut:['exec'] },
  model3d:  { title:'3D 生成', dot:'model', desc:'图生 3D 模型（Tripo）', inputs:['image'], outputs:['model'], execIn:true, execOut:['exec'] },
  modelViews:{ title:'3D 模型转四视图', dot:'model', desc:'把 3D 模型渲染为 2×2 四视图（前/后/左/右），可直接喂给生图 AI', inputs:['model'], outputs:['image','text'], execIn:true, execOut:['exec'] },
  result:   { title:'结果输出', dot:'out', desc:'汇总文本、图像与模型结果', inputs:['text','image','model'], outputs:[], execIn:true, execOut:[] },
};
const NODE_LIB = [
  { group:'输入', types:['imageIn','modelIn','text','boolNode'] },
  { group:'分析任务', types:['aiTask'] },
  { group:'图像任务', types:['imageGen','imageCompress','tripoImg'] },
  { group:'3D 任务', types:['model3d','modelViews'] },
  { group:'逻辑', types:['condition','branch'] },
  { group:'输出', types:['result'] },
];
const PIN_META = {
  image:  { label:'图像', type:'image' },
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
const TASK_TIMEOUT_DEFAULT = 120;
const SVG_NS = 'http://www.w3.org/2000/svg';
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

