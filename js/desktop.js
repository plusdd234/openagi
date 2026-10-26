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
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M6 6l1.9 1.9M16.1 16.1 18 18M18 6l-1.9 1.9M7.9 16.1 6 18"/>'
};
function deskSvg(kind){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (DESK_GLYPH[kind] || DESK_GLYPH.flow) + '</svg>';
}

const DESK_APPS = [
  { id:'chat',     name:'对话',   glyph:'chat', grad:'linear-gradient(150deg,#5b8cff,#7a5cff)' },
  { id:'t2i',      name:'文生图', glyph:'t2i',  grad:'linear-gradient(150deg,#22c58b,#0f9aa8)' },
  { id:'i2i',      name:'图生图', glyph:'i2i',  grad:'linear-gradient(150deg,#f2994a,#e05a52)' },
  { id:'flows',    name:'工作流', glyph:'flow', grad:'linear-gradient(150deg,#7c5cff,#4f7cff)' },
  { id:'settings', name:'设置',   glyph:'gear', grad:'linear-gradient(150deg,#6b7689,#3c4457)' }
];

let deskPos = {};
try { deskPos = JSON.parse(localStorage.getItem('hf_desk_pos') || '{}') || {}; } catch(e){ deskPos = {}; }

function deskStateOf(id){
  if(id === 'chat') return llmReady();
  if(id === 't2i' || id === 'i2i') return imageReady();
  return null;
}
function saveDeskPos(){
  try { localStorage.setItem('hf_desk_pos', JSON.stringify(deskPos)); } catch(e){}
}
function deskClamp(x, y, el){
  const wall = $('deskWall');
  if(!wall) return { x, y };
  const w = el ? el.offsetWidth : 92;
  const h = el ? el.offsetHeight : 98;
  const maxX = Math.max(0, wall.clientWidth - w - 8);
  const maxY = Math.max(0, wall.clientHeight - h - 8);
  return { x: Math.round(Math.min(Math.max(0, x), maxX)), y: Math.round(Math.min(Math.max(0, y), maxY)) };
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
  DESK_APPS.forEach((app, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'desk-app';
    el.dataset.app = app.id;
    el.title = app.name;
    const saved = deskPos[app.id];
    el.innerHTML = `
      <span class="desk-app-icon" style="background:${app.grad}">
        ${deskSvg(app.glyph)}
        ${deskStateOf(app.id) === null ? '' : '<span class="desk-app-state"></span>'}
      </span>
      <span class="desk-app-label">${app.name}</span>`;
    wrap.appendChild(el);
    const p = deskClamp(saved ? saved.x : 20, saved ? saved.y : 20 + i * 96, el);
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
    if(dot) dot.style.background = ok ? '#3dd68c' : '#ffb454';
  });
}

function pinDeskDrag(el, app){
  let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;
  el.addEventListener('pointerdown', e => {
    if(e.button) return;
    active = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const cs = getComputedStyle(el);
    ox = parseFloat(cs.left) || 0; oy = parseFloat(cs.top) || 0;
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
    const p = deskClamp(ox + dx, oy + dy, el);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
  });
  const end = () => {
    if(!active) return;
    active = false;
    el.classList.remove('dragging');
    if(moved){
      deskPos[app.id] = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
      saveDeskPos();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', e => {
    e.preventDefault();
    if(!moved) openDeskApp(app.id);
  });
  el.addEventListener('keydown', e => { if(e.key === 'Enter') openDeskApp(app.id); });
}

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
    b.style.background = app.grad;
    b.innerHTML = deskSvg(app.glyph);
    b.addEventListener('click', () => openDeskApp(app.id));
    dock.appendChild(b);
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'dock-sep'; dock.appendChild(s); };
  DESK_APPS.filter(a => a.id === 'chat' || a.id === 't2i' || a.id === 'i2i').forEach(addApp);
  sep();
  DESK_APPS.filter(a => a.id === 'flows' || a.id === 'settings').forEach(addApp);
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
  deskClockTimer = setInterval(() => {
    const c = $('deskClock');
    if(c) c.textContent = deskClockText();
  }, 15000);
}

function openDeskApp(id){
  if(id === 'flows'){ $('flowsWin').classList.remove('hidden'); return; }
  if(id === 'settings'){ openSettings(); return; }
  if(id === 'chat' || id === 't2i' || id === 'i2i') openBase(id);
}

function closeFlowsWin(){
  $('flowsWin').classList.add('hidden');
}

$('deskWall').addEventListener('pointerdown', e => {
  if(e.target === $('deskWall') || e.target === $('deskIcons')) clearDeskSel();
});

function openBase(id){
  baseSetTab(id);
  showView('base');
}

function baseSetTab(name){
  baseTab = ['chat','t2i','i2i'].includes(name) ? name : 'chat';
  localStorage.setItem('hf_base_tab', baseTab);
  document.querySelectorAll('.base-tab').forEach(t => {
    const on = t.dataset.base === baseTab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.base-pane').forEach(p => {
    p.classList.toggle('hidden', p.dataset.pane !== baseTab);
  });
  refreshBaseState();
}

function refreshBaseState(){
  const imgOk = imageReady();
  $('t2iMeta').textContent = imgOk ? '就绪' : '待配置';
  $('i2iEngine').textContent = isTripo() ? 'Tripo V3' : 'OpenAI 兼容';
  $('i2iMeta').textContent = baseRefImage ? '已载入' : '未载入';
}

function setBaseStatus(id, msg, cls){
  const el = $(id);
  if(!el) return;
  el.textContent = msg || '';
  el.className = 'base-status ' + (cls || '');
}

function renderBaseChat(){
  const log = $('chatLog');
  log.innerHTML = '';
  if(!baseMsgs.length){
    log.innerHTML = '<div class="chat-empty">输入一句话，验证语言模型是否可用。支持多轮上下文。</div>';
    return;
  }
  baseMsgs.forEach(m => {
    const row = document.createElement('div');
    row.className = 'msg ' + m.role + (m.error ? ' msg-error' : '');
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = m.role === 'user' ? '你' : 'AI';
    const body = document.createElement('div');
    body.className = 'msg-body';
    // 思考过程单独折叠，默认收起：正文优先，需要排查时再展开
    if(m.reasoning){
      const det = document.createElement('details');
      det.className = 'msg-think';
      const sum = document.createElement('summary');
      sum.textContent = '思考过程 · ' + m.reasoning.length + ' 字';
      const pre = document.createElement('div');
      pre.textContent = m.reasoning;
      det.append(sum, pre);
      body.appendChild(det);
    }
    const text = document.createElement('div');
    text.textContent = m.content;
    body.appendChild(text);
    row.append(role, body);
    log.appendChild(row);
  });
  log.scrollTop = log.scrollHeight;
}

async function baseChatSend(){
  if(baseChatBusy) return;
  const input = $('chatInput');
  const text = input.value.trim();
  if(!text) return;
  if(!llmReady()){
    setBaseStatus('chatStatus', '语言模型未配置：填写 API Key、接口地址与模型后再试', 'error');
    openSettings('llm');
    return;
  }
  input.value = '';
  baseMsgs.push({ role:'user', content:text });
  renderBaseChat();
  baseChatBusy = true;
  const btn = $('btnChatSend');
  btn.disabled = true;
  btn.textContent = '发送中…';
  setBaseStatus('chatStatus', '请求中…');
  try{
    const messages = baseMsgs.filter(m => !m.error).map(m => ({ role: m.role, content: m.content }));
    const replyMsg = { role:'assistant', content:'' };
    baseMsgs.push(replyMsg);
    renderBaseChat();
    const reply = await llmChatMessagesStream($('chatSystem').value.trim(), messages, (acc, piece, info) => {
      replyMsg.content = acc;
      if(info && info.reasoning) replyMsg.reasoning = info.reasoning;
      setBaseStatus('chatStatus', streamPhaseText(acc, info));
      renderBaseChat();
    });
    if(!reply) throw new Error('模型没有返回内容');
    replyMsg.content = reply;
    renderBaseChat();
    setBaseStatus('chatStatus', '已返回 · ' + ($('llmModel').value.trim() || '模型'), 'ok');
  } catch(e){
    const empty = baseMsgs.findIndex(m => m.role === 'assistant' && !m.content && !m.error);
    if(empty >= 0) baseMsgs.splice(empty, 1);
    baseMsgs.push({ role:'assistant', content:friendlyErr(e), error:true });
    renderBaseChat();
    setBaseStatus('chatStatus', friendlyErr(e), 'error');
  } finally {
    baseChatBusy = false;
    btn.disabled = false;
    btn.textContent = '发送';
  }
}

function baseImageGuard(statusId){
  if(imageReady()) return true;
  if(isTripoWeb()){
    setBaseStatus(statusId, 'Tripo 网页账号未连接：运行 start-tripo-bridge.bat，并在设置中打开登录页', 'error');
    openSettings('image');
    return false;
  }
  setBaseStatus(statusId, '图像模型未配置：在设置 → 图像生成中选择引擎并填写 Key 与模型', 'error');
  openSettings('image');
  return false;
}

function showBaseImage(boxId, url, openBtnId){
  const box = $(boxId);
  box.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '生成结果';
  img.addEventListener('click', () => window.open(url, '_blank'));
  box.appendChild(img);
  if(openBtnId){
    const b = $(openBtnId);
    b.classList.remove('hidden');
    b.onclick = () => window.open(url, '_blank');
  }
}

async function baseT2I(){
  const prompt = $('t2iPrompt').value.trim();
  if(!prompt){ setBaseStatus('t2iStatus', '请先填写提示词', 'error'); return; }
  if(!baseImageGuard('t2iStatus')) return;
  const btn = $('btnT2I');
  btn.disabled = true;
  btn.textContent = '生成中…';
  setBaseStatus('t2iStatus', isTripoWeb() ? '通过 Tripo 网页账号生成，请留意浏览器窗口…' : (isTripo() ? '提交 Tripo 文生图任务并等待结果…' : '请求图像接口…'));
  try{
    const url = await wfImage(prompt);
    showBaseImage('t2iResult', url, 'btnT2IOpen');
    setBaseStatus('t2iStatus', '生成完成 · ' + (isTripoWeb() ? 'Tripo 网页账号' : (isTripo() ? 'Tripo' : ($('imgModel').value.trim() || $('llmModel').value.trim()))), 'ok');
  } catch(e){
    setBaseStatus('t2iStatus', friendlyErr(e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成图片';
  }
}

function readBaseRef(file){
  if(!file) return;
  const r = new FileReader();
  r.onload = () => {
    baseRefImage = r.result;
    $('i2iPreview').innerHTML = `<img src="${r.result}" alt="参考图">`;
    $('i2iDrop').classList.add('has-image');
    $('i2iMeta').textContent = '已载入';
  };
  r.readAsDataURL(file);
}

async function baseI2I(){
  const prompt = $('i2iPrompt').value.trim();
  if(!baseRefImage){ setBaseStatus('i2iStatus', '请先载入参考图', 'error'); return; }
  if(!prompt){ setBaseStatus('i2iStatus', '请先填写提示词', 'error'); return; }
  if(!baseImageGuard('i2iStatus')) return;
  const btn = $('btnI2I');
  btn.disabled = true;
  btn.textContent = '生成中…';
  setBaseStatus('i2iStatus', isTripo() ? '上传参考图并提交 Tripo 图生图任务…' : '请求图像接口…');
  try{
    const url = await wfImage(prompt, baseRefImage);
    showBaseImage('i2iResult', url);
    setBaseStatus('i2iStatus', '生成完成 · ' + (isTripo() ? 'Tripo' : ($('imgModel').value.trim() || $('llmModel').value.trim())), 'ok');
  } catch(e){
    setBaseStatus('i2iStatus', friendlyErr(e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成变体';
  }
}

$('btnBaseBack').addEventListener('click', () => showView('home'));
$('btnBaseSettings').addEventListener('click', () => openSettings(baseTab === 'chat' ? 'llm' : 'image'));
document.querySelectorAll('.base-tab').forEach(t => t.addEventListener('click', () => baseSetTab(t.dataset.base)));
$('btnChatSend').addEventListener('click', baseChatSend);
$('chatInput').addEventListener('keydown', e => {
  if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); baseChatSend(); }
});
$('btnChatClear').addEventListener('click', () => {
  if(baseChatBusy) return;
  baseMsgs = [];
  renderBaseChat();
  setBaseStatus('chatStatus', '');
});
$('btnT2I').addEventListener('click', baseT2I);
$('btnI2I').addEventListener('click', baseI2I);
$('i2iDrop').addEventListener('click', () => $('i2iFile').click());
$('btnI2IPick').addEventListener('click', () => $('i2iFile').click());
$('i2iFile').addEventListener('change', e => {
  if(e.target.files[0]) readBaseRef(e.target.files[0]);
  e.target.value = '';
});
['dragover','dragenter'].forEach(ev => $('i2iDrop').addEventListener(ev, e => { e.preventDefault(); $('i2iDrop').classList.add('drag'); }));
['dragleave','drop'].forEach(ev => $('i2iDrop').addEventListener(ev, e => { e.preventDefault(); $('i2iDrop').classList.remove('drag'); }));
$('i2iDrop').addEventListener('drop', e => { if(e.dataTransfer.files[0]) readBaseRef(e.dataTransfer.files[0]); });

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
  bp = JSON.parse(JSON.stringify(found));
  bp.links = bp.links || [];
  bp.vars = Array.isArray(bp.vars) ? bp.vars : [];
  bp.frames = Array.isArray(bp.frames) ? bp.frames : [];
  migrateAiTaskNodes(bp);
  const _branchMigrated = migrateLegacyBranches(bp);
  migrateExecLinks(bp);
  // 迁移结果要落盘，否则每次打开都重跑一遍迁移（且列表里一直显示旧类型）
  if(_branchMigrated) scheduleFlowSave();
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
  initNodeLib();   // 节点库要按当前流程刷新：已存在的骨架节点不再列出
  renderNodes();
  requestAnimationFrame(fitView);
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
function portPos(nodeId, dir, key){
  const el = $('n-' + nodeId);
  if(!el) return null;
  const pin = el.querySelector(`.pin[data-dir="${dir}"][data-key="${key}"]`);
  if(!pin) return null;
  const r = pin.getBoundingClientRect();
  const c = $('bpCanvas').getBoundingClientRect();
  return { x: (r.left + r.width / 2 - c.left - bpPan.x) / bpZoom, y: (r.top + r.height / 2 - c.top - bpPan.y) / bpZoom };
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
function taskPinsOf(n){
  if(!n || !n.data) return [];
  if(n.type === 'aiTask') return (n.data.inputs || []).concat(n.data.outputs || []);
  if(n.type === 'smartBranch') return n.data.inputs || [];
  if(n.type === 'modelViews') return n.data.params || [];   // 参数引脚
  return [];
}
/* 图像拆分节点的动态视图引脚：条目 id → 图像引脚；id + '__has' → 布尔引脚 */
function viewPinOf(n, key){
  if(!n || n.type !== 'imageSplit' || !n.data) return null;
  const views = n.data.views || [];
  const v = views.find(x => x.id === key);
  if(v) return { id:key, name:v.name, type:'image' };
  if(/__has$/.test(key)){
    const base = key.replace(/__has$/, '');
    const v2 = views.find(x => x.id === base);
    if(v2) return { id:key, name:'是否有' + v2.name, type:'bool' };
  }
  return null;
}
/* 动态执行线出口：声明里 execOutFrom 指向 node.data 上的某个列表（如 branches），
   每条生成一条执行出口。pinType 必须认得它们，否则这类连线会被当成数据线，执行流就断了。 */
function execPinsOf(n){
  if(!n || !n.data) return [];
  const key = (NODE_DEFS[n.type] || {}).execOutFrom;
  if(!key) return [];
  return (n.data[key] || []).map(b => ({ id:b.id, name:b.name, type:'exec' }));
}
function taskPinOf(n, key){
  return viewPinOf(n, key) || execPinsOf(n).find(p => p.id === key)
    || taskPinsOf(n).find(p => p.id === key) || null;
}
function pinType(n, key){
  const p = paramOf(n, key) || taskPinOf(n, key);
  if(p) return p.type;
  const v = varOf(key);
  if(v) return v.type;
  return PIN_META[key] ? PIN_META[key].type : 'string';
}

function renderLinks(){
  if(!bp) return;
  const svg = $('bpLinks');
  svg.querySelectorAll('.bp-link:not(.temp)').forEach(el => el.remove());
  bp.links.forEach(l => {
    const a = portPos(l.from.node, 'out', l.from.key);
    const b = portPos(l.to.node, 'in', l.to.key);
    if(!a || !b) return;
    const p = document.createElementNS(SVG_NS, 'path');
    const pt = pinType(nodeById(l.from.node), l.from.key);
    p.setAttribute('class', 'bp-link t-' + pt + (l.id === bpRunLinkId ? ' active' : ''));
    p.setAttribute('d', linkD(a, b));
    p.addEventListener('click', () => {
      bp.links = bp.links.filter(x => x.id !== l.id);
      renderNodes();
      scheduleFlowSave();
    });
    svg.appendChild(p);
  });
}

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
  pin.dataset.key = (p && p.id) ? p.id : spec.key;
  // 类型优先级：声明的 type → 参数对象自身类型（如四视图的 int/float 参数）→ 引脚名映射 → 字符串
  // 少了第二步，数值参数引脚会被降级成 string，数值节点就永远连不上
  pin.dataset.type = spec.type
    || (p && p.type)
    || (PIN_META[spec.key] ? PIN_META[spec.key].type : null)
    || 'string';
  pin.style.setProperty('--pin-c', PIN_COLORS[pin.dataset.type] || '#5d6bb8');

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
  pin.style.setProperty('--pin-c', PIN_COLORS[meta.type] || '#5d6bb8');
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
  if(isVarNode && v) dot.style.background = PIN_COLORS[v.type] || '#7c8cff';
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

  /* ---------- 节点主体：统一由 NODE_PARAMS 声明驱动 ---------- */
  const specs = (NODE_PARAMS[n.type] || []).slice();

  // 1) 参数与输入引脚合并：有同名引脚时，参数直接挂在那个引脚右侧
  const inputKeys = (d.inputs || []).slice();
  if(n.type === 'smartBranch') (n.data.inputs || []).forEach(p => inputKeys.push(p.id));
  if(n.type === 'end') (n.params || []).forEach(p => inputKeys.push(p.id));
  if(isVarNode && v && n.type === 'varSet') inputKeys.push(v.id);

  // 有参数但缺同名引脚的，补一条输入引脚（值可视化于其右侧）
  specs.forEach(s => {
    if(s.ctl === 'paramList' || s.ctl === 'taskPins' || s.ctl === 'viewPins' || s.ctl === 'branchPins' || s.ctl === 'inPins' || s.ctl === 'filePick' || s.tip) return;
    if(s.side === 'out') return;   // 数据源参数：挂在输出引脚上，不生成输入引脚
    if(s.store === 'param'){
      if(!inputKeys.includes(s.key)) inputKeys.push(s.key);
    } else if(!inputKeys.includes(s.key)){
      inputKeys.push(s.key);
    }
  });

  const body = document.createElement('div');
  body.className = 'node-body';
  const inCol = document.createElement('div');
  inCol.className = 'node-col in';
  const outCol = document.createElement('div');
  outCol.className = 'node-col out';

  const specByKey = {};
  specs.forEach(s => { specByKey[s.key] = s; });

  // 输入侧
  inputKeys.forEach(k => {
    const spec = specByKey[k] || null;
    if(spec && spec.tip) return;
    if(spec && (spec.ctl === 'paramList' || spec.ctl === 'taskPins' || spec.ctl === 'viewPins' || spec.ctl === 'branchPins' || spec.ctl === 'inPins')) return;
    if(n.type === 'start') return;
    if(n.type === 'smartBranch'){
      const dp = (n.data.inputs || []).find(x => x.id === k);
      if(dp){ inCol.appendChild(makePort(k, 'in', { label: dp.name || '输入', type: dp.type })); return; }
    }
    if(n.type === 'end'){
      const p = (n.params || []).find(x => x.id === k);
      if(p){
        /* 参数行必须是「真引脚 + 名称 / 类型 / 接收值」：
           只渲染 paramRow 时没有 pin，portPos 找不到坐标，这条连线就永远画不出来。 */
        const row = document.createElement('div');
        row.className = 'port-row param-port';
        const pin = document.createElement('span');
        pin.className = 'pin in';
        pin.dataset.dir = 'in';
        pin.dataset.key = p.id;
        pin.dataset.type = p.type;
        pin.style.setProperty('--pin-c', PIN_COLORS[p.type] || '#5d6bb8');
        const body = document.createElement('div');
        body.className = 'param-port-body';
        body.appendChild(paramRow(n, p));
        row.append(pin, body);
        inCol.appendChild(row);
        return;
      }
    }
    if(isVarNode && v && k === v.id){
      inCol.appendChild(makePort(k, 'in', { label:'值', type:v.type }));
      return;
    }
    if(k === '__image__' || k === '__model__'){
      inCol.appendChild(makePort(k, 'in', { label:k === '__image__' ? '图像' : '模型',
        type:k === '__image__' ? 'image' : 'model' }));
      return;
    }
    inCol.appendChild(makePort(k, 'in', paramPortMeta(spec, n, k)));
  });

  // 输出侧：声明里 side:'out' 的参数，取值控件跟着输出引脚一起渲染
  (d.outputs || []).forEach(k => {
    const s = specByKey[k];
    outCol.appendChild(makePort(k, 'out', (s && s.side === 'out')
      ? paramPortMeta(s, n, k) : undefined));
  });
  if(n.type === 'start') (n.params || []).forEach(p => outCol.appendChild(makePort(p.id, 'out', { label:p.name, type:p.type })));
  if(isVarNode && v && n.type === 'varGet') outCol.appendChild(makePort(v.id, 'out', { label:v.name, type:v.type }));
  if(n.type === 'aiTask'){
    (n.data.outputs || []).forEach(p => outCol.appendChild(makePort(p.id, 'out', { label:p.name || '输出', type:p.type })));
  }
  // 图像拆分的动态视图引脚由 viewPinSection 在字段区渲染（紧跟各自的视图控件），不在这里重复

  // 2) 含参数的节点让引脚列占满整行，取值控件才有位置（输入侧 / 输出侧都算）
  const hasParamRow = specs.some(s => !s.tip
    && s.ctl !== 'paramList' && s.ctl !== 'taskPins' && s.ctl !== 'filePick'
    && s.ctl !== 'viewPins' && s.ctl !== 'branchPins' && s.ctl !== 'inPins');
  if(hasParamRow) body.classList.add('wide-in');
  body.append(inCol);
  if((d.outputs || []).length || isVarNode || n.type === 'start' || n.type === 'aiTask'){
    body.appendChild(outCol);
  }

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
    pin.style.setProperty('--pin-c', PIN_COLORS[p.type] || '#5d6bb8');
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

