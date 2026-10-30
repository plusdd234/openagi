/* 运行日志 / 变量面板 / 节点库 / 节点执行
 * 原 index.html 4382-5444 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ---- 运行日志 ----
let bpLogCollapsed = false;
function bpLog(msg, cls, live){
  const body = $('bpLogBody');
  if(!body) return null;
  const empty = body.querySelector('.bp-log-empty');
  if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'bp-log-row ' + (cls || '') + (live ? ' live' : '');
  const t = document.createElement('span');
  t.className = 'bp-log-time';
  const d = new Date();
  t.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
  const m = document.createElement('span');
  m.className = 'bp-log-msg';
  m.textContent = msg;
  row.append(t, m);
  body.appendChild(row);
  while(body.children.length > 300) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
  try{ console.log('[flow]', msg); }catch(_){ }
  return {
    set(text){ m.textContent = text; body.scrollTop = body.scrollHeight; },
    done(text, cls2){
      row.className = 'bp-log-row ' + (cls2 || '');
      m.textContent = text;
      body.scrollTop = body.scrollHeight;
      try{ console.log('[flow]', text); }catch(_){ }
    }
  };
}
function bpLogClear(){
  const body = $('bpLogBody');
  if(body) body.innerHTML = '<div class="bp-log-empty">运行工作流后，这里会显示每个节点的执行与流式输出。</div>';
}
function bpLogExpand(){
  if(!$('bpLog')) return;
  bpLogCollapsed = false;
  $('bpLog').classList.remove('collapsed');
  $('btnBpLogToggle').textContent = '收起';
}
function bpNodeLabel(n){
  return (NODE_DEFS[n.type] && NODE_DEFS[n.type].title) || n.type;
}
function bpPreview(v, max){
  if(v === undefined || v === null || v === '') return '（空）';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
function bpOutPreview(out){
  if(!out) return '无输出';
  const parts = [];
  if(out.text) parts.push('文本 ' + (out.text.length || 0) + ' 字：' + bpPreview(out.text, 90));
  if(out.image) parts.push('图像已产出');
  if(out.imageInfo) parts.push(out.imageInfo);
  if(out.model) parts.push('模型已产出');
  if(out.bool !== undefined) parts.push('布尔：' + out.bool);
  if(out.values) parts.push('结束参数 ' + out.values.length + ' 项');
  return parts.join(' · ') || '完成';
}
$('btnBpLogToggle').addEventListener('click', () => {
  bpLogCollapsed = !bpLogCollapsed;
  $('bpLog').classList.toggle('collapsed', bpLogCollapsed);
  $('btnBpLogToggle').textContent = bpLogCollapsed ? '展开' : '收起';
});
$('btnBpLogClear').addEventListener('click', bpLogClear);

// ---- 变量面板 ----
const BP_SIDE_TABS = [
  { key: 'lib',  tab: 'tabLib',  pane: 'paneLib' },
  { key: 'vars', tab: 'tabVars', pane: 'paneVars' },
  { key: 'runs', tab: 'tabRuns', pane: 'paneRuns' },
  { key: 'mem',  tab: 'tabMem',  pane: 'paneMem' }
];
let bpSideTab = BP_SIDE_TABS.some(t => t.key === localStorage.getItem('hf_bp_side_tab'))
  ? localStorage.getItem('hf_bp_side_tab') : 'lib';
let bpVarAddOpen = false;
let varDrag = null;
let varMenuTarget = null;

function setBpSideTab(name){
  bpSideTab = BP_SIDE_TABS.some(t => t.key === name) ? name : 'lib';
  localStorage.setItem('hf_bp_side_tab', bpSideTab);
  applySideTab();
}

function applySideTab(){
  BP_SIDE_TABS.forEach(t => {
    const on = bpSideTab === t.key;
    const tab = $(t.tab), pane = $(t.pane);
    if(tab){ tab.classList.toggle('active', on); tab.setAttribute('aria-selected', String(on)); }
    if(pane) pane.classList.toggle('hidden', !on);
  });
  if(bpSideTab === 'vars') renderVars();
  if(bpSideTab === 'runs' && typeof renderRunHistory === 'function') renderRunHistory();
  if(bpSideTab === 'mem' && typeof renderMemPane === 'function') renderMemPane();
}

function varPreviewEl(v){
  const box = document.createElement('div');
  box.className = 'node-result';
  box.dataset.varPreview = v.id;
  if(v.type === 'image'){
    if(v.value){
      const img = document.createElement('img');
      img.className = 'node-img';
      img.src = v.value;
      box.appendChild(img);
    } else {
      box.textContent = '未设置图像';
    }
  } else if(v.type === 'model'){
    box.textContent = v.value ? '模型：' + (v.fileName || '已载入') : '未设置模型';
  } else if(v.type === 'bool'){
    box.textContent = '当前值：' + (v.value === false ? '假' : '真');
  } else {
    box.textContent = '当前值：' + (v.value === '' || v.value == null ? '空' : String(v.value));
  }
  return box;
}

function refreshVarPreview(v){
  document.querySelectorAll('[data-var-preview="' + v.id + '"]').forEach(box => {
    box.replaceWith(varPreviewEl(v));
  });
}

function varValueEditor(v){
  if(v.type === 'image' || v.type === 'model'){
    const btn = document.createElement('button');
    btn.className = 'param-file';
    btn.textContent = v.value ? (v.fileName || '已选择，点击更换') : (v.type === 'image' ? '选择图像' : '选择模型');
    btn.title = v.fileName || '';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      bpPickedParam = null;
      bpPickedVar = v;
      const inp = $('bpParamFile');
      inp.accept = v.type === 'image' ? 'image/*' : '.obj,.glb,.gltf,.fbx,.stl,.ply,.3mf';
      inp.value = '';
      inp.click();
    });
    return btn;
  }
  if(v.type === 'bool'){
    const sel = document.createElement('select');
    [['true','真'],['false','假']].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      sel.appendChild(opt);
    });
    sel.value = v.value === false ? 'false' : 'true';
    sel.addEventListener('change', () => {
      v.value = sel.value === 'true';
      refreshVarPreview(v);
      scheduleFlowSave();
    });
    return sel;
  }
  const inp = document.createElement('input');
  if(v.type === 'int' || v.type === 'float'){
    inp.type = 'number';
    inp.step = v.type === 'int' ? '1' : '0.01';
    inp.value = v.value === '' ? 0 : v.value;
    inp.addEventListener('input', () => {
      v.value = inp.value === '' ? 0 : Number(inp.value);
      refreshVarPreview(v);
      scheduleFlowSave();
    });
  } else {
    inp.type = 'text';
    inp.placeholder = '默认值';
    inp.value = v.value || '';
    inp.addEventListener('input', () => {
      v.value = inp.value;
      refreshVarPreview(v);
      scheduleFlowSave();
    });
  }
  return inp;
}

function renderVars(){
  if(!bp) return;
  bp.vars = Array.isArray(bp.vars) ? bp.vars : [];
  const host = $('bpVarsBody');
  host.innerHTML = '';
  const count = $('varCount');
  count.textContent = String(bp.vars.length);
  count.classList.toggle('hidden', !bp.vars.length);

  if(!bp.vars.length && !bpVarAddOpen){
    const tip = document.createElement('div');
    tip.className = 'var-empty';
    tip.textContent = '暂无变量';
    const sub = document.createElement('div');
    sub.style.marginTop = '4px';
    sub.textContent = '新建后拖到画布，选择「获取」或「设置」。';
    tip.appendChild(sub);
    host.appendChild(tip);
  }

  bp.vars.forEach(v => {
    const row = document.createElement('div');
    row.className = 'var-row';

    const top = document.createElement('div');
    top.className = 'var-top';

    const grip = document.createElement('span');
    grip.className = 'var-grip';
    grip.textContent = '⠿';
    grip.title = '拖到画布创建获取 / 设置节点';
    grip.addEventListener('pointerdown', e => startVarDrag(e, v));

    const dot = document.createElement('span');
    dot.className = 'var-dot';
    dot.style.background = PIN_COLORS[v.type] || '#e88a00';

    const name = document.createElement('input');
    name.className = 'var-name';
    name.type = 'text';
    name.value = v.name || '';
    name.title = '点击重命名';
    name.addEventListener('change', () => {
      const next = name.value.trim() || '未命名变量';
      if(next === v.name) return;
      v.name = next;
      renderNodes();
      scheduleFlowSave();
    });
    name.addEventListener('keydown', e => { if(e.key === 'Enter') name.blur(); });

    const type = document.createElement('span');
    type.className = 'var-type';
    type.textContent = TYPE_META[v.type] ? TYPE_META[v.type].label : v.type;

    const del = document.createElement('button');
    del.className = 'var-del';
    del.title = '删除变量';
    del.textContent = '×';
    del.addEventListener('click', e => { e.stopPropagation(); removeVar(v); });

    top.append(grip, dot, name, type, del);

    const val = document.createElement('div');
    val.className = 'var-val';
    val.appendChild(varValueEditor(v));

    row.append(top, val);
    host.appendChild(row);
  });

  if(bpVarAddOpen) host.appendChild(varAddForm());
}

function varAddForm(){
  const form = document.createElement('div');
  form.className = 'var-addform';
  const prow = document.createElement('div');
  prow.className = 'prow';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = '变量名';
  for(const ev of NAME_EVENTS) name.addEventListener(ev, e => e.stopPropagation());
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
  ok.textContent = '创建变量';
  ok.addEventListener('click', e => {
    e.stopPropagation();
    if(!bp) return;
    const vname = name.value.trim() || (TYPE_META[sel.value].label + (bp.vars.length + 1));
    bp.vars.push(newParam(vname, sel.value));
    bpVarAddOpen = false;
    renderVars();
    scheduleFlowSave();
  });
  name.addEventListener('keydown', e => { if(e.key === 'Enter') ok.click(); });

  form.append(prow, ok);
  return form;
}

function removeVar(v){
  if(!confirm('删除变量「' + (v.name || '未命名') + '」？相关的获取 / 设置节点也会一并删除。')) return;
  const ids = new Set(bp.nodes
    .filter(n => (n.type === 'varGet' || n.type === 'varSet') && n.data.varId === v.id)
    .map(n => n.id));
  bp.nodes = bp.nodes.filter(n => !ids.has(n.id));
  bp.links = bp.links.filter(l => !ids.has(l.from.node) && !ids.has(l.to.node));
  bp.vars = bp.vars.filter(x => x.id !== v.id);
  renderNodes();
  scheduleFlowSave();
}

function startVarDrag(e, v){
  if(e.button !== 0 || !bp) return;
  e.preventDefault();
  e.stopPropagation();
  const ghost = document.createElement('div');
  ghost.className = 'lib-ghost';
  ghost.textContent = '变量 · ' + (v.name || '未命名');
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  document.body.appendChild(ghost);
  varDrag = { v, ghost, x:e.clientX, y:e.clientY, moved:false };
}

function endVarDrag(e){
  const drag = varDrag;
  if(!drag) return;
  varDrag = null;
  drag.ghost.remove();
  if(!bp) return;
  const c = $('bpCanvas').getBoundingClientRect();
  const inside = e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom;
  if(drag.moved && !inside) return;
  let x, y, sx, sy;
  if(drag.moved){
    const p = screenToWorld(e.clientX, e.clientY);
    x = p.x - 100;
    y = p.y - 16;
    sx = e.clientX - c.left;
    sy = e.clientY - c.top;
  } else {
    x = (c.width / 2 - bpPan.x) / bpZoom - 100;
    y = (c.height / 2 - bpPan.y) / bpZoom - 40;
    sx = c.width / 2;
    sy = c.height / 2;
  }
  showVarMenu(drag.v, Math.round(x), Math.round(y), sx, sy);
}

function showVarMenu(v, wx, wy, sx, sy){
  varMenuTarget = { v, x:wx, y:wy };
  const menu = $('varMenu');
  $('varMenuHead').textContent = v.name || '未命名变量';
  menu.style.left = Math.max(8, Math.min(sx + 10, $('bpCanvas').clientWidth - 172)) + 'px';
  menu.style.top = Math.max(8, Math.min(sy - 10, $('bpCanvas').clientHeight - 104)) + 'px';
  menu.classList.remove('hidden');
}

function hideVarMenu(){
  $('varMenu').classList.add('hidden');
  varMenuTarget = null;
}

function addVarNode(v, mode, x, y){
  if(!bp) return;
  const n = newNode(mode === 'set' ? 'varSet' : 'varGet', x, y);
  n.data.varId = v.id;
  bp.nodes.push(n);
  renderNodes();
  scheduleFlowSave();
  const el = $('n-' + n.id);
  if(el) el.classList.add('sel');
  bpToast((mode === 'set' ? '已创建设置变量节点：' : '已创建获取变量节点：') + (v.name || '变量'));
}

function loadVarFile(v, file){
  if(v.type === 'model'){
    if(!/\.(obj|glb|gltf|fbx|stl|ply|3mf)$/i.test(file.name)){ bpToast('模型格式不支持'); return; }
    if(file.size > 20 * 1024 * 1024){ bpToast('模型超过 20MB，请用更轻的模型文件'); return; }
  } else if(!/^image\//.test(file.type)){
    bpToast('请选择图像文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    v.value = v.type === 'image' ? await shrinkImageDataUrl(String(reader.result)) : String(reader.result);
    v.fileName = file.name;
    renderNodes();
    scheduleFlowSave();
  };
  reader.readAsDataURL(file);
}

// ---- 节点库 ----
function initNodeLib(){
  const host = $('bpLibBody');
  const menu = $('bpAdd');
  host.innerHTML = '';
  menu.innerHTML = '<option value="">+ 添加节点</option>';
  NODE_LIB.forEach(g => {
    // 已存在的骨架节点不再出现在库里（不可删除，避免误加第二个）
    const types = g.types.filter(t => !(isSingleton(t) && hasNodeType(t)));
    if(!types.length) return;
    const group = document.createElement('div');
    group.className = 'lib-group';
    group.textContent = g.group;
    host.appendChild(group);
    types.forEach(type => {
      const d = NODE_DEFS[type];
      const item = document.createElement('div');
      item.className = 'lib-item';
      item.dataset.type = type;
      item.title = '拖到画布添加「' + d.title + '」';
      const dot = document.createElement('span');
      dot.className = 'node-dot ' + d.dot;
      const txt = document.createElement('div');
      txt.className = 'lib-txt';
      const b = document.createElement('b');
      b.textContent = d.title;
      const small = document.createElement('small');
      small.textContent = d.desc;
      txt.append(b, small);
      item.append(dot, txt);
      item.addEventListener('pointerdown', startLibDrag);
      host.appendChild(item);

      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = d.title;
      menu.appendChild(opt);
    });
  });
}

function startLibDrag(e){
  if(e.button !== 0 || !bp) return;
  e.preventDefault();
  const type = e.currentTarget.dataset.type;
  const ghost = document.createElement('div');
  ghost.className = 'lib-ghost';
  ghost.textContent = NODE_DEFS[type].title;
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  document.body.appendChild(ghost);
  libDrag = { type, ghost, x:e.clientX, y:e.clientY, moved:false };
}

function endLibDrag(e){
  const drag = libDrag;
  if(!drag) return;
  libDrag = null;
  drag.ghost.remove();
  if(!bp) return;
  const c = $('bpCanvas').getBoundingClientRect();
  const inside = e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom;
  if(drag.moved && !inside) return;
  let x, y;
  if(drag.moved){
    const p = screenToWorld(e.clientX, e.clientY);
    x = p.x - 120; y = p.y - 16;
  } else {
    x = (c.width / 2 - bpPan.x) / bpZoom - 120;
    y = (c.height / 2 - bpPan.y) / bpZoom - 40;
  }
  addNodeAt(drag.type, x, y);
}

// 流程骨架节点唯一：既然不可删除，就不允许出现第二个
function isSingleton(type){ return type === 'start' || type === 'end'; }
function hasNodeType(type){ return !!(bp && bp.nodes.some(n => n.type === type)); }

function addNodeAt(type, x, y){
  if(!bp) return;
  if(isSingleton(type) && hasNodeType(type)){
    bpToast('「' + NODE_DEFS[type].title + '」只能有一个');
    return;
  }
  const n = newNode(type, Math.round(x), Math.round(y));
  bp.nodes.push(n);
  renderNodes();
  scheduleFlowSave();
  const el = $('n-' + n.id);
  if(el) el.classList.add('sel');
}

/* 部分网关 / 本地模型把思考内联进正文：`<think>……</think>答案`。
   整段文本已到手时（非流式 / 兜底）用它一次拆干净。 */
function splitInlineThink(text){
  const s = String(text == null ? '' : text);
  const out = { answer:'', reasoning:'' };
  let i = 0;
  while(i < s.length){
    const a = s.indexOf('<think>', i);
    if(a < 0){ out.answer += s.slice(i); break; }
    out.answer += s.slice(i, a);
    const b = s.indexOf('</think>', a + 7);
    if(b < 0){ out.reasoning += s.slice(a + 7); break; }
    out.reasoning += s.slice(a + 7, b);
    i = b + 8;
  }
  return out;
}

/* 分片可能在标签中间断开（'<th' + 'ink>'），末尾像是某个标签开头时先扣住不发，
   等下一片来了再拼起来判断，避免把半个标签当正文显示出来。 */
function partialTail(str, tag){
  for(let k = tag.length - 1; k >= 1; k--){
    if(str.endsWith(tag.slice(0, k))) return tag.slice(0, k);
  }
  return '';
}

/* ---- 思考过程（reasoning / thinking）----
 * 各家字段不统一：DeepSeek-R1 / Qwen3 / OpenRouter 用 delta.reasoning_content，
 * 部分网关用 delta.reasoning 或 reasoning_details[].text；非流式则挂在 message 上。
 * 只要能取到就原样透出，取不到就当没有，不影响正文。 */
function readReasoning(obj){
  if(!obj || typeof obj !== 'object') return '';
  if(typeof obj.reasoning_content === 'string') return obj.reasoning_content;
  if(typeof obj.reasoning === 'string') return obj.reasoning;
  if(Array.isArray(obj.reasoning_details)){
    return obj.reasoning_details.map(d => (d && (d.text || d.content)) || '').filter(Boolean).join('');
  }
  return '';
}
// 设置里勾选后才请求开启思考：默认不带该字段，避免不认识它的网关直接报错
function thinkingRequestBody(){
  try{ return ($('llmThink') && $('llmThink').checked) ? { enable_thinking: true } : {}; }
  catch(e){ return {}; }
}
/* 流式进度文案：思考阶段与正文阶段分开显示。
   能看到「思考中」在涨，就说明上游一直在推数据，不是连接断了。 */
function streamPhaseText(acc, info){
  const i = info || {};
  const r = String(i.reasoning || '');
  if(i.phase === 'thinking') return '思考中 ' + r.length + ' 字';
  return '生成中 ' + String(acc || '').length + ' 字';
}

// ---- 运行期中断（停止按钮）----
// 停止时置 bpRunAbort 并 abort bpRunCtrl：在途的 LLM 流 / 网页生成请求会立刻断开，
// 节点之间靠 bpRunAbort 提前返回，不再继续往下走。
function runSignal(){ return bpRunCtrl ? bpRunCtrl.signal : undefined; }
function isStopped(){ return !!bpRunAbort || !!(bpRunCtrl && bpRunCtrl.signal.aborted); }
function stopError(){ const e = new Error('已手动停止'); e._stopped = true; return e; }
// 停止按钮：只置标志，真正的收尾（按钮复位 / 日志）由 runFlow 自己完成
function stopFlow(){
  if(!bpRunBusy) return;
  bpRunAbort = true;
  if(bpRunCtrl) bpRunCtrl.abort();
  bpLog('已请求停止，正在中断当前节点…', 'warn');
  const b = $('btnBpStop');
  if(b) b.disabled = true;
  const run = $('btnBpRun');
  if(run) run.textContent = '停止中…';
}

// ---- 节点执行 ----
async function llmChat(sys, userText, image){
  // 登录了就走网关（Key 在服务端），否则用本地填的 Key
  const conn = (typeof llmConn === 'function') ? llmConn()
    : { base: $('llmBaseUrl').value.trim().replace(/\/$/, ''), key: $('llmKey').value.trim(), model: $('llmModel').value.trim() };
  const key = conn.key, base = conn.base, model = conn.model;
  if(!key || !base || !model) throw new Error('语言模型未配置');
  const content = [];
  if(userText) content.push({ type:'text', text: userText });
  if(image) content.push({ type:'image_url', image_url:{ url:image } });
  const data = await post(base, key, '/chat/completions', {
    model,
    messages: [{ role:'system', content:sys }, { role:'user', content }],
    temperature: .3
  });
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

// 流式对话：逐块回调，60 秒无新内容自动中断
async function llmStreamRequest(sys, messages, onDelta, opts){
  // 同 llmChat：登录走网关，未登录走本地 Key
  /* opts.conn 可覆盖本次连接（桌面聊天面板按用户在下拉里选的模型/来源走），
     不传 opts 时行为完全不变，避免影响设置页与工作流节点的既有链路。 */
  const conn = (opts && opts.conn) ? opts.conn
    : ((typeof llmConn === 'function') ? llmConn()
    : { base: $('llmBaseUrl').value.trim().replace(/\/$/, ''), key: $('llmKey').value.trim(), model: $('llmModel').value.trim() });
  const key = conn.key, base = conn.base, model = conn.model;
  if(!key || !base || !model) throw new Error('语言模型未配置');

  const limitMs = opts && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  const ctrl = new AbortController();
  /* 外部中断（停止按钮）：跟着一起 abort，并单独记原因，
     否则会被下面当成「超时」或「上游没有返回数据」报出来。 */
  const ext = opts && opts.signal;
  if(ext){
    if(ext.aborted) throw stopError();
    ext.addEventListener('abort', () => abortWith('stop'));
  }
  let idle = null;
  let hard = null;
  let firstTimer = null;
  let waitingFirst = true;
  let gotBytes = false;          // 是否收到过上游的任何字节
  let gotReasoning = false;      // 是否收到过思考内容（思考也算「上游在工作」）
  let startedAnswer = false;     // 是否已开始输出正文
  let rsn = '';                  // 累计的思考过程
  let abortReason = '';
  const startedAt = Date.now();
  const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
  const abortWith = reason => { abortReason = reason; ctrl.abort(); };
  /* 空闲计时：只在流建立（收到过字节）后才启动，避免把「首段等待」误判成「流中断」。
     思考阶段的宽限放到 3 分钟：推理模型经常长时间地想，期间一个字都不吐，
     拿正文阶段的 60 秒去卡它，会把「正在思考」误判成「连接断了」。 */
  const idleMs = () => (gotReasoning && !startedAnswer) ? 180000 : 60000;
  const bump = ms => {
    if(!gotBytes) return;
    clearTimeout(idle);
    idle = setTimeout(() => abortWith('idle'), ms || idleMs());
  };
  // 首段内容等待上限：优先用任务配置的超时；「不限时」时给 2 分钟
  // （此前硬编码 30 秒，视觉模型分析大图根本不够，且老流程节点没有 timeout 字段时会踩到）
  const firstWaitMs = limitMs > 0 ? limitMs : 120000;
  firstTimer = setTimeout(() => abortWith('first'), firstWaitMs);
  hard = setTimeout(() => abortWith('limit'), limitMs || 600000);

  const req = apiRequest(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    },
    body: JSON.stringify(Object.assign({
      model,
      messages: (sys ? [{ role:'system', content: sys }] : []).concat(messages),
      temperature: .3,
      stream: true
    }, thinkingRequestBody()))
  });

  // 建立连接的瞬时失败可安全重试：此时还没收到任何响应内容，
  // 请求基本没被上游处理，重放不会造成重复计费。
  // （流已开始输出后不再重试，避免拼接出重复内容。）
  const FETCH_RETRY_MAX = 2;
  const fetchWithRetry = async () => {
    let last = null;
    for (let i = 0; i <= FETCH_RETRY_MAX; i++) {
      try {
        const r = await fetch(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
        // 网关类错误（502/503/504）同样重试：多半是上游或中转的瞬时抖动
        if (r.status >= 502 && r.status <= 504 && i < FETCH_RETRY_MAX) {
          last = new Error('HTTP ' + r.status);
          await new Promise(rs => setTimeout(rs, 700 * (i + 1)));
          continue;
        }
        return r;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        last = e;
        if (i >= FETCH_RETRY_MAX) throw e;
        await new Promise(rs => setTimeout(rs, 700 * (i + 1)));
      }
    }
    throw last || new Error('请求失败');
  };

  // 保留最后几行原始 SSE，出错时带出来，便于判断上游到底发了什么
  const rawTail = [];

  try{
    const res = await fetchWithRetry();
    if(!res.ok){
      const detail = await res.text();
      throw new Error('HTTP ' + res.status + '：' + (typeof prettyError === 'function' ? prettyError(detail) : String(detail).slice(0, 200)));
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    /* 有些网关（实测 edge.lingsuan.org）对 /models 特判返回 JSON、但对拼错/缺 /v1 的
       chat 路径回退到 SPA 首页 —— HTTP 200 + text/html。不在这里拦住的话，
       SSE 解析器一行 data: 都收不到，最后只报「模型没有返回内容」，用户无从排查。 */
    if(ctype.includes('text/html')){
      throw new Error('接口返回的是网页而不是 API 数据（HTTP 200 + text/html）。'
        + '通常是接口地址少了 /v1 或路径不对——当前地址「' + base + '」，'
        + '试试改成「' + base + '/v1」再重试');
    }
    if(!res.body || ctype.includes('application/json')){
      const data = await res.json();
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const sp = splitInlineThink(msg.content || '');
      const text = sp.answer.trim();
      const think = (readReasoning(msg) + sp.reasoning).trim();
      if(think){ gotReasoning = true; rsn = think; }
      if(!text) throw new Error('模型没有返回内容');
      if(onDelta) onDelta(text, text, { phase:'answer', reasoning: rsn });
      return text;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
    let doneFlag = false;
    let inThink = false;          // 内联 <think> 块跨越多个分片，需要记忆状态
    let pending = '';             // 疑似半个标签的尾巴，等下一片再判断
    const notify = phase => { if(onDelta) onDelta(acc, '', { phase, reasoning: rsn }); };
    const addContent = t => {
      if(!t) return;
      waitingFirst = false;
      startedAnswer = true;
      clearTimeout(firstTimer);   // 首段内容已到，首段计时器完成使命
      acc += t;
      if(onDelta) onDelta(acc, t, { phase:'answer', reasoning: rsn });
    };
    /* 正文分片里可能内联 <think>…</think>（部分网关 / 本地模型这么干），
       按分片边界逐段处理：块内的进思考，块外的进正文。 */
    const feed = raw => {
      let s = pending + String(raw == null ? '' : raw);
      pending = '';
      while(s){
        if(inThink){
          const end = s.indexOf('</think>');
          if(end < 0){
            const hold = partialTail(s, '</think>');
            rsn += hold ? s.slice(0, s.length - hold.length) : s;
            gotReasoning = true;
            pending = hold;
            notify('thinking');
            return;
          }
          rsn += s.slice(0, end);
          gotReasoning = true;
          inThink = false;
          s = s.slice(end + 8);
          notify('thinking');
          continue;
        }
        const start = s.indexOf('<think>');
        if(start < 0){
          const hold = partialTail(s, '<think>');
          if(hold){ addContent(s.slice(0, s.length - hold.length)); pending = hold; return; }
          addContent(s);
          return;
        }
        addContent(s.slice(0, start));
        s = s.slice(start + 7);
        inThink = true;
        gotReasoning = true;
        notify('thinking');
      }
    };
    const pushLine = line => {
      const s = line.replace(/\r$/, '').trim();
      if(s){ rawTail.push(s.slice(0, 120)); if(rawTail.length > 4) rawTail.shift(); }
      if(!s || s.startsWith(':') || !s.startsWith('data:')) return;
      const payload = s.slice(5).trim();
      if(payload === '[DONE]'){ doneFlag = true; return; }
      try{
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message || {});
        const piece = d && typeof d.content === 'string' ? d.content : '';
        // 思考内容：R1 / Qwen3 这类模型会先推一大段推理，此时正文一个字都还没有
        const think = readReasoning(d);
        if(think){
          gotReasoning = true;
          rsn += think;
          // 思考也是「上游在推数据」的证据：清掉首段计时器，别把长思考判成没响应
          waitingFirst = false;
          clearTimeout(firstTimer);
          notify('thinking');
        }
        if(piece) feed(piece);
      }catch(_){ /* 跳过非 JSON 行 */ }
    };

    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      gotBytes = true;
      bump();
      buf += dec.decode(value, { stream:true });
      let idx;
      while((idx = buf.indexOf('\n')) >= 0){
        pushLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      if(doneFlag) break;
    }
    if(buf) pushLine(buf);
    if(pending){ const rest = pending; pending = ''; addContent(rest); }   // 结尾没等来标签，那它就只是普通文本

    const text = acc.trim();
    if(!text) throw new Error('模型没有返回内容');
    return text;
  }catch(e){
    if(e && e.name === 'AbortError'){
      const el = elapsedSec();
      if(abortReason === 'stop') throw stopError();
      if(abortReason === 'limit') throw new Error('任务超时（' + Math.round((limitMs || 600000) / 1000) + ' 秒）已中止');
      if(abortReason === 'first'){
        if(gotReasoning){
          // 说明连接是好的：模型一直在思考，只是还没吐正文
          throw new Error('模型一直在输出思考内容，还没开始输出正文（已等待 ' + el + ' 秒，首段上限 '
            + Math.round(firstWaitMs / 1000) + ' 秒）：调大节点「超时」，或换用思考更短的模型');
        }
        if(!gotBytes){
          throw new Error('上游没有返回任何数据（已等待 ' + el + ' 秒，首段上限 ' + Math.round(firstWaitMs / 1000) + ' 秒）：'
            + '请检查接口地址 / 密钥 / 模型名，以及本机网络与代理；本地中转已自动重试上游断连');
        }
        throw new Error('上游返回了数据但没有内容（已等待 ' + el + ' 秒，首段上限 ' + Math.round(firstWaitMs / 1000) + ' 秒）：'
          + '可能是模型不支持图像输入，或响应被中转截断；可在节点「超时」里调大后重试'
          + (rawTail.length ? '｜上游最后几行：' + rawTail.join(' ⏎ ').slice(0, 260) : ''));
      }
      throw new Error('流式响应中断：连续 ' + Math.round(idleMs() / 1000) + ' 秒没有收到新数据（本次已运行 ' + el + ' 秒）'
        + (gotReasoning && !startedAnswer ? '；中断发生在思考阶段，模型可能已停止输出或网关未流式下发思考内容' : ''));
    }
    throw e;
  }finally{
    clearTimeout(idle);
    clearTimeout(firstTimer);
    clearTimeout(hard);
  }
}
/* 没传系统提示词时的兜底人设。原来这份定义在「基线工具」里，基线工具整块移除后
 * 跟着搬到唯一的消费方（llmChatMessagesStream）旁边，行为不变。 */
const BASE_SYS = '你是 The seed 的对话助手。回答准确、简洁；需要时给出可执行的下一步，不要编造不确定的信息。';
async function llmChatMessagesStream(sys, messages, onDelta, opts){
  return llmStreamRequest(sys || BASE_SYS, messages, onDelta, opts);
}

function coerceTaskValue(v, type){
  if(type === 'int') return Math.trunc(Number(v) || 0);
  if(type === 'float') return Number(v) || 0;
  if(type === 'bool') return typeof v === 'boolean' ? v : toBool(v);
  if(typeof v === 'string') return v;
  return JSON.stringify(v);
}

function defaultTaskValue(type){
  if(type === 'bool') return false;
  if(type === 'int' || type === 'float') return 0;
  return '';
}

function parseAiTaskResult(raw, outs){
  const out = {};
  const text = raw == null ? '' : String(raw).trim();
  if(!outs.length) return out;
  if(outs.length === 1){
    out[outs[0].id] = coerceTaskValue(text, outs[0].type);
    return out;
  }
  const bare = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let obj = null;
  try{ obj = JSON.parse(bare); }catch(_){
    const m = bare.match(/\{[\s\S]*\}/);
    if(m){ try{ obj = JSON.parse(m[0]); }catch(_){ } }
  }
  const parsed = !!obj && typeof obj === 'object' && !Array.isArray(obj);
  if(parsed){
    outs.forEach(p => {
      const v = obj[p.name] !== undefined ? obj[p.name] : obj[(p.name || '').trim()];
      if(v !== undefined) out[p.id] = coerceTaskValue(v, p.type);
    });
  }
  outs.forEach((p, i) => {
    if(out[p.id] !== undefined) return;
    out[p.id] = parsed ? defaultTaskValue(p.type) : (i === 0 ? coerceTaskValue(text, p.type) : defaultTaskValue(p.type));
  });
  return out;
}

async function wfAiTask(instruction, sections, images, outs, onDelta, timeoutMs){
  const parts = ['任务指令：' + (instruction || '根据输入内容给出分析结果。')];
  if(sections.length){
    parts.push('输入数据：\n' + sections.map(s => '- ' + s.name + '：\n' + s.value).join('\n\n'));
  }
  if(images.length){
    parts.push('输入图像：已附带 ' + images.length + ' 张图像。');
  }
  const names = outs.map(p => p.name || '输出');
  const outSpec = outs.map(p => '"' + (p.name || '输出') + '"（' + (TYPE_META[p.type] ? TYPE_META[p.type].label : p.type) + '）').join('、');
  let sys = '你是工作流中的分析任务执行器。严格按任务指令分析输入内容，输出可直接传递给下游节点的结果，不要解释过程，不要添加客套话。';
  if(outs.length > 1){
    sys += '需要返回多个结果：只输出一个 JSON 对象，键为 ' + outSpec + '，值为对应类型的结果，不要输出 JSON 之外的任何文字。';
    parts.push('输出要求：返回 JSON 对象，键为 ' + names.join('、') + '。');
  } else if(outs.length === 1){
    parts.push('输出要求：直接输出「' + names[0] + '」的内容。');
  }
  const content = [{ type:'text', text: parts.join('\n\n') }];
  images.forEach(url => content.push({ type:'image_url', image_url:{ url } }));
  const raw = await llmStreamRequest(sys, [{ role:'user', content }], onDelta, { timeoutMs, signal: runSignal() });
  if(!raw) throw new Error('分析任务未返回内容');
  return parseAiTaskResult(raw, outs);
}

function toBool(v){
  if(typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s.startsWith('true') || s === '1' || s === 'yes' || s === '是' || s === '真';
}

async function wfTripoWebImage(prompt, images, opts){
  const o = opts || {};
  const list = (Array.isArray(images) ? images : (images ? [images] : [])).filter(Boolean).slice(0, 3);
  const timeoutSec = Math.max(10, Math.min(900, Math.trunc(Number(o.timeoutSec) || 0) || 240));
  const ctrl = new AbortController();
  const ext = o.signal;                       // 停止按钮：网页生成是长任务，必须能中断
  if(ext){
    if(ext.aborted) throw stopError();
    ext.addEventListener('abort', () => ctrl.abort());
  }
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 40) * 1000);
  try{
    const res = await fetch(TRIPO_WEB_BASE + '/generate', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        prompt,
        image: list[0] || '',
        images: list,
        // 比例：默认 1:1（可复现），显式传 'auto' 才跟随页面当前设置
        ratio: o.ratio === 'auto' ? '' : (o.ratio || '1:1'),
        mode: o.mode === 'text' || o.mode === 'image' ? o.mode : '',
        timeoutSec
      }),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await res.json(); } catch(e) {}
    if(!res.ok || !data || !data.url) throw new Error((data && data.message) || ('Tripo 助手返回 HTTP ' + res.status));
    return { url: data.url + '?t=' + Date.now(), file: data.file || '', canvas: !!data.canvas, message: data.message || '', refs: list.length };
  }catch(e){
    if(e && e.name === 'AbortError'){
      if(ext && ext.aborted) throw stopError();
      throw new Error('Tripo 网页生成超时（' + (timeoutSec + 40) + ' 秒）');
    }
    if(e instanceof TypeError) throw new Error('无法连接 Tripo 助手：请先启动项目（桌面端双击 start.bat），再点「打开登录页」');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

/* Tripo 网页账号：图生 3D 模型（智能网格 / 高精度模型、P2.0、拓扑 / 面数、数量、格式）
   multi=true 时走多视图上传（前 / 左 / 右 / 后 四张参考图） */
async function wfTripoWebModel(image, opts){
  const o = opts || {};
  const timeoutSec = Math.max(30, Math.min(1800, Math.trunc(Number(o.timeoutSec) || 0) || 420));
  const ctrl = new AbortController();
  const ext = o.signal;                       // 同上：模型生成同样要能立刻中断
  if(ext){
    if(ext.aborted) throw stopError();
    ext.addEventListener('abort', () => ctrl.abort());
  }
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 60) * 1000);
  try{
    const res = await fetch(TRIPO_WEB_BASE + '/generate-model', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        image: image || '',
        multi: !!o.multi,
        views: o.views || null,
        mode: o.mode || '',
        version: o.version || '',
        topology: o.topology || '',
        faceCount: Math.max(0, Math.trunc(Number(o.faceCount) || 0)),
        count: Math.max(0, Math.trunc(Number(o.count) || 0)),
        format: o.format || '',
        timeoutSec
      }),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await res.json(); } catch(e) {}
    if(!res.ok || !data || !data.url) throw new Error((data && data.message) || ('Tripo 助手返回 HTTP ' + res.status));
    return { url: data.url + '?t=' + Date.now(), file: data.file || '', size: data.size || 0, message: data.message || '' };
  }catch(e){
    if(e && e.name === 'AbortError'){
      if(ext && ext.aborted) throw stopError();
      throw new Error('Tripo 网页生成超时（' + (timeoutSec + 60) + ' 秒）');
    }
    if(e instanceof TypeError) throw new Error('无法连接 Tripo 助手：请先启动项目（桌面端双击 start.bat），再点「打开登录页」');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

/* opts 可选（对话面板用）：只覆盖中断信号与超时，
 * 不传时与工作流节点的行为完全一致——节点那条链路不需要知道对话的存在。 */
async function wfImage(prompt, image, opts){
  const o = opts || {};
  const sig = o.signal || runSignal();
  /* 生图来源优先：本地（ComfyUI）选中时就走本机，不再看 Tripo / 云端配置。
   * 放在最前面是因为它是**用户显式选择**；Tripo 的判断是「配没配」，不该盖过选择。 */
  if(typeof imgMode === 'function' && imgMode() === 'local'){
    const p = providerFor('image', 'comfy-image');
    if(!p) throw new Error('本地生图提供方缺失（provider.js 未加载 complete？）');
    const r = await p.generate({ prompt, image }, {
      signal: sig,
      timeoutSec: Math.max(30, Number(o.timeoutSec) || 300),
      // 图生图的重绘强度：不传就由 provider 按「想改多少」自动定档
      denoise: o.denoise
    });
    const src = r.dataUrl || r.url;
    if(!src) throw new Error('ComfyUI 没有返回图片');
    return src;
  }
  /* Tripo 不再作为通用生图引擎（2026-10-29）：网页生图只存在于
     「Tripo 网页生图」专用节点（tripoImg，支持多参考图）上，
     由「网页操作」页的连接状态管理，与这里的引擎路由无关。 */

  const base = ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()).replace(/\/$/, '');
  const model = $('imgModel').value.trim() || $('llmModel').value.trim();
  const key = $('imgKey').value.trim() || $('llmKey').value.trim();
  if(!base || !model || !key) throw new Error('图像模型未配置');

  let endpoint = $('imgEndpoint').value.trim() || '/images/edits';
  if(!image && /edit/i.test(endpoint)) endpoint = endpoint.replace(/edits?/i, 'generations');
  const size = $('imgSize').value.trim() || '1024x1024';
  let data;

  if(image && /edit/i.test(endpoint)){
    const blob = await (await fetch(image)).blob();
    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', prompt);
    fd.append('size', size);
    fd.append('image', blob, 'source.png');
    const res = await apiFetch(base + endpoint, { method:'POST', headers:{ Authorization:'Bearer ' + key }, body: fd });
    if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    data = await res.json();
  } else {
    const body = { model, prompt, size, n:1 };
    if(image) body.image = image.split(',')[1];
    data = await post(base, key, endpoint, body);
  }

  const path = $('respPath').value.trim() || 'data[0].url';
  const url = lookupPath(data, path);
  if(url) return url;
  const b64 = lookupPath(data, 'data[0].b64_json');
  if(b64) return 'data:image/png;base64,' + b64;
  throw new Error('响应中未找到图片字段');
}

function loadCanvasImage(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图像加载失败：可能是格式不支持或地址不可访问'));
    img.src = src;
  });
}

async function loadImageForCanvas(src){
  if(src.indexOf('data:') === 0 || src.indexOf('blob:') === 0){
    return { img: await loadCanvasImage(src), revoke: null };
  }
  // 远程图像先取回 blob，避免画布被跨域污染后无法导出
  const res = await apiFetch(src, { method:'GET' });
  if(!res.ok) throw new Error('图像下载失败：HTTP ' + res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try{
    return { img: await loadCanvasImage(url), revoke: () => URL.revokeObjectURL(url) };
  }catch(e){
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function wfCompressImage(src, maxEdge, quality){
  const { img, revoke } = await loadImageForCanvas(src);
  try{
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if(!w || !h) throw new Error('无法读取图像尺寸');
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(img, 0, 0, tw, th);
    let out = '';
    try{ out = canvas.toDataURL('image/jpeg', quality); }
    catch(e){ throw new Error('图像受跨域限制，无法压缩；请改用本地图像或启用本地中转'); }
    return {
      image: out,
      imageInfo: '已压缩 ' + w + '×' + h + ' → ' + tw + '×' + th
        + ' · ' + formatBytes(src.length) + ' → ' + formatBytes(out.length)
    };
  }finally{
    if(revoke) revoke();
  }
}

/* 图像拆分：视觉模型按提示词定位多个视图 → 画布拆分
 * views: [{ id, name, hint }]
 * 输出：{ text, [id]: 图像 dataURL（找不到为 ''）, [id + '__has']: 布尔 } */
async function wfImageSplit(src, prompt, views, opts, onDelta){
  const o = opts || {};
  const output = o.output === 'crop' || o.output === 'mask' ? o.output : 'cutout';
  const feather = Math.max(0, Math.min(32, Math.trunc(Number(o.feather) || 0)));
  // 1) 压缩一份送给视觉模型（返回归一化坐标，映射回原图不受影响）
  const small = await wfCompressImage(src, 768, 0.7);
  // 2) 让模型返回各视图的区域（polygon 优先，box 兜底）
  const result = await wfSplitViews(small.image, prompt, views, o.timeoutSec, onDelta);
  // 3) 在原图上按输出形式拆分
  const { img, revoke } = await loadImageForCanvas(src);
  try{
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if(!w || !h) throw new Error('无法读取图像尺寸');
    const out = { text: '' };
    const lines = [];
    for(const v of views){
      const hit = result.views[v.id];
      const geom = hit && hit.present
        ? (hit.polygon && hit.polygon.length >= 3 ? { polygon: hit.polygon } : (hit.box ? { box: hit.box } : null))
        : null;
      if(!geom){
        out[v.id] = '';
        out[v.id + '__has'] = false;
        lines.push(v.name + '：未找到');
        continue;
      }
      out[v.id] = await renderSplit(img, w, h, geom, output, feather);
      out[v.id + '__has'] = true;
      lines.push(v.name + '：已拆分' + (hit.confidence ? '（置信度 ' + hit.confidence.toFixed(2) + '）' : ''));
    }
    out.text = '图像拆分完成 · ' + lines.join('；');
    return out;
  } finally{
    if(revoke) revoke();
  }
}

/* 让视觉模型逐视图判断「是否存在 + 区域」，返回 { views:{ [id]:{present,box,polygon,confidence} } } */
async function wfSplitViews(imageUrl, prompt, views, timeoutSec, onDelta){
  const sys = '你是图像拆分标注器。用户在图中寻找若干个指定的视图 / 对象，你需要判断每个视图是否存在，并给出存在视图的区域轮廓。只输出 JSON，不要输出 JSON 之外的任何文字。';
  const list = views.map((v, i) => (i + 1) + '. ' + v.name + (v.hint ? '（' + v.hint + '）' : '')).join('\n');
  const user = [
    '请分析附图，按下面的清单逐一检查每个视图是否存在，并给出存在视图的区域。',
    '拆分要求：' + (prompt || '把图中各个视图分别拆出来'),
    '视图清单：',
    list,
    '以图片左上角为原点，输出归一化坐标（0~1，保留 3 位小数）。只返回这个 JSON：',
    '{"views":[{"name":"正视图","present":true,"confidence":0.9,"box":[x,y,w,h],"polygon":[[x,y],[x,y],...]},{"name":"背视图","present":false}]}',
    'box 是该视图区域的最小外接矩形 [左,上,宽,高]；polygon 是贴合区域边缘的多边形顶点（至少 6 个点，不要自交；无法给多边形时可省略，只给 box）。',
    '一个都找不到时，所有 present 均为 false。'
  ].join('\n');
  const timeoutMs = Math.round((Number(timeoutSec) || 120) * 1000);
  const raw = await llmStreamRequest(sys, [{ role:'user', content:[
    { type:'text', text: user },
    { type:'image_url', image_url:{ url: imageUrl } }
  ]}], onDelta, { timeoutMs, signal: runSignal() });
  return parseSplitJson(raw, views);
}

/* 特征定位：开放式的「工作要求」驱动 —— 特征清单不写死，AI 按要求自行决定
 * 找哪些区域并命名（最多 9 个）。返回 [{ name, box:[x,y,w,h] 归一化 }]。
 * more 补齐模式：{ avoid:[已试过的特征名], need:这次要几个 }。 */
async function wfFeatureLocate(imageUrl, requirement, timeoutSec, more){
  const mo = more || {};
  const sys = '你是图像特征定位器。按用户的工作要求在图中找出值得提取的特征区域并命名。只输出 JSON，不要输出 JSON 之外的任何文字。';
  const user = [
    '工作要求：' + (String(requirement || '').trim() || '挑出图中最值得关注的细节区域（主体可辨识的部位 / 物件），最多 9 个'),
    (mo.avoid && mo.avoid.length ? '以下特征已经找过（含没通过复核的），必须避开它们，另找不同的：' + mo.avoid.join('、') : ''),
    '以图片左上角为原点，输出归一化坐标（0~1，保留 3 位小数）。只返回这个 JSON：',
    '{"regions":[{"name":"眼睛","box":[x,y,w,h]}]}',
    'box 是该区域的最小外接矩形 [左,上,宽,高]；name 用简短的部位 / 物件名（2~6 字）；'
      + (mo.need ? '这次只需要 ' + mo.need + ' 个，按重要程度排序。' : '最多 9 个，按重要程度排序。')
  ].filter(Boolean).join('\n');
  const timeoutMs = Math.round((Number(timeoutSec) || 180) * 1000);
  const raw = await llmStreamRequest(sys, [{ role:'user', content:[
    { type:'text', text: user },
    { type:'image_url', image_url:{ url: imageUrl } }
  ]}], null, { timeoutMs, signal: runSignal() });
  const text = String(raw || '').trim();
  let obj = null;
  const m = text.match(/\{[\s\S]*\}/);
  if(m){ try{ obj = JSON.parse(m[0]); }catch(e){ obj = null; } }
  const arr = obj && Array.isArray(obj.regions) ? obj.regions : [];
  if(!arr.length) throw new Error('模型没有定位到任何特征区域（调整「工作要求」后重试）');
  const clamp01 = v => { const x = Number(v); return isFinite(x) ? Math.max(0, Math.min(1, x)) : null; };
  const out = [];
  arr.forEach(item => {
    if(!item || typeof item !== 'object') return;
    const name = String(item.name || '').trim();
    if(!name || !Array.isArray(item.box) || item.box.length !== 4) return;
    const b = item.box.map(clamp01);
    if(b.every(x => x !== null) && b[2] > 0 && b[3] > 0) out.push({ name, box:b });
  });
  if(!out.length) throw new Error('模型返回的特征区域无法解析（box 缺失或格式不对）');
  return out.slice(0, 9);
}

/* 特征提取：AI 定位各特征区域 → 回原图裁切放大 → 3×3 网格拼接 + 位置标注文本。
 * 最多 3 张输入图；特征不写死，由「工作要求」驱动 AI 自行决定，每格一个命名区域，
 * 行优先填满 9 格，没凑满的格子留空。 */
const FEATURE_POS = ['左上','中上','右上','左中','正中','右中','左下','中下','右下'];
/* 特征复核：裁切完成后，把每张小图按顺序发给视觉模型，逐张判断
 * 「这张图是否确实是名字所指的部位」。返回 { [idx(1基)]: {ok, reason} }。 */
async function wfFeatureVerify(cells, crops, requirement, timeoutSec){
  const sys = '你是图像裁切质检员。给你若干张从原图裁切出来的小图（按顺序编号），逐张判断它是否确实符合对应的名字与工作要求。只输出 JSON，不要输出 JSON 之外的任何文字。';
  const list = cells.map((c, i) => (i + 1) + '. ' + c.name).join('\n');
  const user = [
    '工作要求：' + (String(requirement || '').trim() || '小图的画面主体应正好是名字所指的部位 / 物件'),
    '小图清单：',
    list,
    '逐张判断：小图内容是否就是清单中对应序号所指的部位 / 物件（画面里能清楚看到它，而不是背景或别的部位）。只返回这个 JSON：',
    '{"checks":[{"idx":1,"ok":true,"reason":"部位清晰居中"},{"idx":2,"ok":false,"reason":"切到的是背景"}]}',
    'idx 从 1 开始，与小图清单序号对应；看不出来或拿不准时判 false。'
  ].join('\n');
  const content = [{ type:'text', text: user }];
  crops.forEach(u => content.push({ type:'image_url', image_url:{ url: u } }));
  const timeoutMs = Math.round((Number(timeoutSec) || 180) * 1000);
  const raw = await llmStreamRequest(sys, [{ role:'user', content }], null, { timeoutMs, signal: runSignal() });
  const text = String(raw || '').trim();
  let obj = null;
  const m = text.match(/\{[\s\S]*\}/);
  if(m){ try{ obj = JSON.parse(m[0]); }catch(e){ obj = null; } }
  const out = {};
  if(obj && Array.isArray(obj.checks)){
    obj.checks.forEach(it => {
      if(!it || typeof it !== 'object') return;
      const idx = Math.trunc(Number(it.idx));
      if(idx >= 1) out[idx] = { ok: it.ok !== false, reason: String(it.reason || '') };
    });
  }
  return out;
}

async function wfFeatureExtract(srcs, opts){
  const o = opts || {};
  const subject = o.subject || '人物';
  const cell = Math.max(128, Math.min(1024, Math.trunc(Number(o.cell) || 512)));
  const margin = Math.max(0, Math.min(100, Number(o.margin) || 0)) / 100;
  const cells = [];            // 最终入格：{ imgIdx, name, box, cv }
  const usedNames = new Set(); // 试过的特征名（含被剔的），补齐时让 AI 避开
  const notes = [];
  let droppedN = 0;            // 复核剔除总数
  let backfillN = 0;           // 补齐进来的格数
  const loaded = {};           // imgIdx → image（懒加载缓存）

  /* 单格渲染：归一化 box → 原图像素（外扩 margin）→ cover 居中铺满格子 */
  const renderCell = (imgIdx, box) => {
    const { img } = loaded[imgIdx];
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    let bx = Number(box[0]), by = Number(box[1]);
    let bw = Number(box[2]), bh = Number(box[3]);
    const cv = document.createElement('canvas');
    cv.width = cell; cv.height = cell;
    if(bw > 0 && bh > 0){
      const cvx = cv.getContext('2d');
      const mx = bw * margin / 2, my = bh * margin / 2;   // 外扩，避免切到边缘
      let sx = (bx - mx) * w, sy = (by - my) * h;
      let sw = (bw + 2 * mx) * w, sh = (bh + 2 * my) * h;
      sx = Math.max(0, Math.min(w - 4, sx));
      sy = Math.max(0, Math.min(h - 4, sy));
      sw = Math.max(4, Math.min(w - sx, sw));
      sh = Math.max(4, Math.min(h - sy, sh));
      // cover 居中：裁切区域铺满格子（小部位由此自然放大，吃满网格分辨率）
      const sr = sw / sh;
      let cw = sw, ch = sh;
      if(sr > 1) cw = sh; else ch = sw;
      const cx = sx + (sw - cw) / 2, cy = sy + (sh - ch) / 2;
      cvx.drawImage(img, cx, cy, cw, ch, 0, 0, cell, cell);
    }
    return cv;
  };

  /* 一轮定位：逐图让 AI 找特征（avoid 为要避开的名字），裁切 + 复核，通过的形成格子。
   * want：本轮最多要几个；noteCount：逐图把识别数量记进 notes（只首轮用）。 */
  const runRound = async (want, avoid, phaseLabel, noteCount) => {
    if(want <= 0 || cells.length >= 9) return 0;
    const cands = [];
    for(let i = 0; i < srcs.length && cands.length < want; i++){
      if(o.onPhase) o.onPhase(phaseLabel + ' · 图' + (i + 1));
      const small = await wfCompressImage(srcs[i], 768, 0.7);   // 坐标归一化，映射回原图不受影响
      let regions = [];
      try {
        regions = await wfFeatureLocate(small.image, o.requirement, o.timeoutSec, { avoid, need: want - cands.length });
      } catch(e){
        if(srcs.length === 1 && !cells.length) throw e;   // 单图首轮失败 = 没得拼，直接报
        notes.push('图' + (i + 1) + ' 定位失败');           // 其余：跳过这张，别拖垮整次拼图
        continue;
      }
      if(noteCount) notes.push('图' + (i + 1) + ' 识别 ' + regions.length + ' 个');
      for(const rg of regions){
        if(cands.length >= want || cells.length + cands.length >= 9) break;
        if(usedNames.has(rg.name)) continue;   // AI 没避开时兜底去重
        usedNames.add(rg.name);
        cands.push({ imgIdx: i, name: rg.name, box: rg.box });
      }
    }
    if(!cands.length) return 0;
    for(const c of cands){
      if(!loaded[c.imgIdx]) loaded[c.imgIdx] = await loadImageForCanvas(srcs[c.imgIdx]);
      c.cv = renderCell(c.imgIdx, c.box);
    }
    /* 复核：把每张小图发给视觉模型判断「是否确实是名字所指的部位」，
       判 false 的候选剔除 —— 定位模型偶尔会框到背景或邻近部位，
       拼进网格再送下游分析就会污染结论，宁缺毋滥；剔掉的格位会触发补齐。 */
    if(o.verify){
      if(o.onPhase) o.onPhase('复核 ' + cands.length + ' 格');
      const crops = cands.map(c => {
        const s = document.createElement('canvas');
        s.width = 224; s.height = 224;
        s.getContext('2d').drawImage(c.cv, 0, 0, 224, 224);
        return s.toDataURL('image/jpeg', 0.75);
      });
      let checks = null;
      try {
        checks = await wfFeatureVerify(cands, crops, o.requirement, o.timeoutSec);
      } catch(e){
        checks = null;   // 复核本身失败不拦拼图：宁可放行也不白跑
        if(o.onNote) o.onNote('复核失败已跳过（' + friendlyErr(e) + '）');
      }
      if(checks){
        cands.forEach((c, k) => {
          const chk = checks[k + 1];
          if(chk && !chk.ok){
            c.drop = true;
            droppedN++;
            if(o.onNote) o.onNote('复核剔除「' + c.name + '」：' + (chk.reason || '不像'));
          }
        });
      }
    }
    let added = 0;
    for(const c of cands){
      if(c.drop || cells.length >= 9) continue;
      cells.push(c);
      added++;
    }
    return added;
  };

  /* 第一轮：正常定位 */
  await runRound(9, [], '定位特征', true);
  /* 补齐：复核剔掉几格就试着追加几个新特征（最多 2 轮，控制 AI 调用成本）；
   * 补进来的又被剔了就再追一轮，轮数用完为止。 */
  let toFill = o.verify ? droppedN : 0;
  let rounds = 0;
  while(toFill > 0 && rounds < 2 && cells.length < 9){
    rounds++;
    if(o.onNote) o.onNote('尝试补齐 ' + toFill + ' 格（第 ' + rounds + ' 轮）');
    const dropBefore = droppedN;
    backfillN += await runRound(toFill, [...usedNames], '补齐特征');
    toFill = droppedN - dropBefore;   // 本轮补进来的又被剔了几格 → 再追一轮
  }

  if(o.onPhase) o.onPhase('拼图');
  const canvas = document.createElement('canvas');
  canvas.width = cell * 3;
  canvas.height = cell * 3;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#15181d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // cells 是紧凑的（剔掉的不占位），按行优先直接铺
  cells.forEach((c, k) => {
    ctx.drawImage(c.cv, (k % 3) * cell, Math.floor(k / 3) * cell);
  });
  let image = '';
  try{ image = canvas.toDataURL('image/webp', 0.9); }
  catch(e){ throw new Error('拼图导出失败（画布受跨域污染）：请使用本地图像或已过中转的图像地址'); }
  // 标注：3行3列，左上为图1人物的发髻，中上为图1人物的眼睛，…；行与行之间用「；」
  let text;
  if(!cells.length){
    text = '3行3列 · 没有通过复核的特征区域（调整「工作要求」或换更清晰的图后重试）';
  } else {
    const rows = [];
    for(let r = 0; r < 3; r++){
      const row = cells.filter((c, k) => Math.floor(k / 3) === r);
      if(row.length) rows.push(row.map((c, k2) => FEATURE_POS[r * 3 + k2] + '为图' + (c.imgIdx + 1) + subject + '的' + c.name).join('，'));
    }
    text = '3行3列，' + rows.join('；') + '。';
  }
  const noteAll = '共 ' + cells.length + '/9 格'
    + (droppedN ? '（复核剔除 ' + droppedN + ' 格）' : '')
    + (backfillN ? '（补齐 ' + backfillN + ' 格）' : '')
    + ' · ' + notes.join(' · ') + ' · ' + (cell * 3) + '×' + (cell * 3);
  return { image, text, notes: noteAll };
}

/* AI 分支：让模型按选择依据 + 上下文从出口清单里挑一条
 * branches: [{ id, name, hint }]
 * 返回 { id, name, reason, matched }；matched=false 表示模型没给出可识别的出口 */
async function wfAiBranch(instruction, branches, ctx, timeoutSec, onDelta){
  const c = ctx || {};
  const sys = '你是工作流路由器。根据选择依据与上下文，从给定的出口清单中选出唯一一条最合适的执行线。只输出 JSON，不要输出 JSON 之外的任何文字。';
  const list = branches.map((b, i) => (i + 1) + '. ' + b.name + (b.hint ? '（' + b.hint + '）' : '')).join('\n');
  // 上下文：data.inputs 里的「名称：值」逐条列出，图像单独以 image_url 附带
  const imgs = (Array.isArray(c.images) ? c.images : []).filter(x => x && x.url);
  let ctxBlock = '';
  if(Array.isArray(c.sections) && c.sections.length){
    ctxBlock = '输入数据：\n' + c.sections.map(s => '- ' + s.name + '：' + s.value).join('\n');
    if(imgs.length) ctxBlock += '\n图像输入：已附带 ' + imgs.length + ' 张（' + imgs.map(x => x.name).join('、') + '）';
  } else if(imgs.length){
    ctxBlock = '图像输入：已附带 ' + imgs.length + ' 张（' + imgs.map(x => x.name).join('、') + '）';
  }
  const user = [
    '请从下面的出口清单中选择唯一一条执行线。',
    '选择依据：' + (instruction || '根据上下文选择最合适的处理方式'),
    '出口清单：',
    list,
    ctxBlock,
    '只返回这个 JSON：{"choice":"出口名称","reason":"一句话理由"}',
    'choice 必须与出口清单里的某个名称完全一致；实在无法确定时，选最接近的一条。'
  ].filter(Boolean).join('\n');
  const content = [{ type:'text', text: user }];
  imgs.forEach(img => content.push({ type:'image_url', image_url:{ url: img.url } }));
  const timeoutMs = Math.round((Number(timeoutSec) || 120) * 1000);
  const raw = await llmStreamRequest(sys, [{ role:'user', content }], onDelta, { timeoutMs, signal: runSignal() });
  if(!raw) throw new Error('AI 分支未返回内容');
  return parseAiBranchResult(raw, branches);
}

/* 容错解析分支选择：兼容 markdown 代码围栏、前后杂语，以及模型只回了出口名的情况；
   出口名允许大小写 / 空格差异与互相包含 */
function parseAiBranchResult(raw, branches){
  const text = String(raw || '').trim();
  const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
  const findByName = nm => {
    if(!nm) return null;
    const n = norm(nm);
    return branches.find(b => norm(b.name) === n)
      || branches.find(b => b.name && n && (n.indexOf(norm(b.name)) >= 0 || norm(b.name).indexOf(n) >= 0))
      || null;
  };
  let obj = null;
  const m = text.match(/\{[\s\S]*\}/);
  if(m){ try { obj = JSON.parse(m[0]); } catch(e) { obj = null; } }
  let name = '', reason = '';
  if(obj && typeof obj === 'object'){
    name = String(obj.choice || obj.branch || obj.name || obj.select || obj.pick || '').trim();
    reason = String(obj.reason || obj.why || obj.remark || '').trim();
  }
  const hit = findByName(name) || (name ? null : findByName(text));
  if(hit) return { id:hit.id, name:hit.name, reason: reason || '', matched:true };
  return { id:'', name: name || '', reason: reason || text.slice(0, 120), matched:false };
}

/* 容错解析拆分 JSON：兼容 markdown 代码围栏与前后杂语；按视图名归并 */
function parseSplitJson(raw, views){
  const text = String(raw || '').trim();
  let obj = null;
  const m = text.match(/\{[\s\S]*\}/);
  if(m){ try { obj = JSON.parse(m[0]); } catch(e) { obj = null; } }
  if(!obj) throw new Error('模型返回的拆分结果无法解析（未找到 JSON）');
  const arr = Array.isArray(obj.views) ? obj.views : [];
  const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
  const clamp01 = v => { const x = Number(v); return isFinite(x) ? Math.max(0, Math.min(1, x)) : null; };
  const byName = {};
  arr.forEach(item => {
    if(!item || typeof item !== 'object') return;
    const nm = norm(item.name);
    if(nm) byName[nm] = item;
  });
  const result = { views: {} };
  views.forEach(v => {
    const item = byName[norm(v.name)];
    if(!item || item.present === false){ result.views[v.id] = { present: false }; return; }
    let box = null;
    if(Array.isArray(item.box) && item.box.length === 4){
      const b = item.box.map(clamp01);
      if(b.every(x => x !== null)) box = b;
    }
    let polygon = [];
    if(Array.isArray(item.polygon)){
      polygon = item.polygon
        .map(p => (Array.isArray(p) && p.length >= 2) ? [clamp01(p[0]), clamp01(p[1])] : null)
        .filter(p => p && p[0] !== null && p[1] !== null);
    }
    const conf = Number(item.confidence);
    result.views[v.id] = {
      present: true,
      confidence: isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      box,
      polygon: polygon.length >= 3 ? polygon : []
    };
  });
  return result;
}

/* 按区域把原图拆成：cutout 透明底抠图 / crop 矩形裁剪 / mask 蒙版图 */
async function renderSplit(img, w, h, geom, output, feather){
  // 区域蒙版（白 = 保留，黑 = 去除）
  const mask = document.createElement('canvas');
  mask.width = w; mask.height = h;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h);
  mctx.fillStyle = '#fff';
  if(geom.polygon){
    mctx.beginPath();
    geom.polygon.forEach(([x, y], i) => {
      const px = x * w, py = y * h;
      if(i) mctx.lineTo(px, py); else mctx.moveTo(px, py);
    });
    mctx.closePath(); mctx.fill();
  } else {
    const [x, y, bw, bh] = geom.box;
    mctx.fillRect(x * w, y * h, bw * w, bh * h);
  }
  // 羽化：模糊蒙版得到半透明边缘（canvas filter 不支持时自动跳过）
  let alpha = mask;
  if(feather > 0){
    try{
      const soft = document.createElement('canvas');
      soft.width = w; soft.height = h;
      const sctx = soft.getContext('2d');
      sctx.filter = 'blur(' + feather + 'px)';
      sctx.drawImage(mask, 0, 0);
      alpha = soft;
    }catch(e){ /* 保持硬边缘 */ }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if(output === 'mask'){
    canvas.width = w; canvas.height = h;
    ctx.drawImage(alpha, 0, 0);
  } else if(output === 'crop'){
    let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
    if(geom.polygon){
      const xs = geom.polygon.map(p => p[0]), ys = geom.polygon.map(p => p[1]);
      x0 = Math.min.apply(null, xs); x1 = Math.max.apply(null, xs);
      y0 = Math.min.apply(null, ys); y1 = Math.max.apply(null, ys);
    } else {
      const bx = geom.box[0], by = geom.box[1];
      x0 = bx; y0 = by; x1 = bx + geom.box[2]; y1 = by + geom.box[3];
    }
    const sx = Math.max(0, Math.round(x0 * w)), sy = Math.max(0, Math.round(y0 * h));
    const sw = Math.max(1, Math.min(w - sx, Math.round((x1 - x0) * w)));
    const sh = Math.max(1, Math.min(h - sy, Math.round((y1 - y0) * h)));
    canvas.width = sw; canvas.height = sh;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  } else {
    canvas.width = w; canvas.height = h;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alpha, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  try{ return canvas.toDataURL('image/png'); }
  catch(e){ throw new Error('图像受跨域限制，无法导出；请改用本地图像或启用本地中转'); }
}

async function wf3D(image){
  /* Tripo 与生图引擎解耦后 isTripo() 恒为 false：API 兜底的门槛改为「有没有 Key」。
     到这里说明网页助手也没连上（model3d 节点已先探过一轮），提示要指向新入口。 */
  if(!$('tripoKey').value.trim()) throw new Error('3D 生成需要 Tripo：在 设置 → 网页操作 里登录网页账号，或填入 API Key');
  if(!image) throw new Error('缺少图像输入');
  const token = await tripoUpload(image);
  const task = await tripoCall('/generation/image-to-model', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ model: $('tripoVersion').value, input: token, texture: true, pbr: true })
  });
  const done = await tripoPoll(task.task_id);
  const out = done.output || {};
  const url = out.model_url || out.pbr_model;
  if(!url) throw new Error('任务完成但未返回模型地址');
  return url;
}

// 参数取值兜底：节点上没有该字段时，回退到声明表里的缺省值。
// 必要场景：老流程里的节点建于某个参数加入之前，data 里根本没有这个键，
// 若不回退就会拿到 undefined（超时类参数会退化成硬编码的短等待）。
function paramFallback(n, key){
  const list = (typeof NODE_PARAMS !== 'undefined' && NODE_PARAMS[n.type]) || [];
  const spec = list.find(s => s.key === key);
  if(!spec) return undefined;
  const dk = spec.dataKey || spec.key;
  const d = n.data ? n.data[dk] : undefined;
  if(d !== undefined && d !== null && d !== '') return d;
  const def = (typeof spec.default === 'function') ? spec.default() : spec.default;
  return (def === undefined || def === null) ? undefined : def;
}

async function runFlow(){
  if(bpRunBusy || !bp) return;
  if(!bp.nodes.length){ bpToast('请先添加节点'); return; }
  // 图片 / 模型可能还只是存根（IndexedDB 尚未载入完成），运行前先还原
  if(typeof blobEnsure === 'function') await blobEnsure();
  if(typeof blobResolveFlows === 'function') blobResolveFlows([bp]);

  const byId = {};
  bp.nodes.forEach(n => { byId[n.id] = n; });
  const links = bp.links.filter(l => byId[l.from.node] && byId[l.to.node]);
  const dataLinks = links.filter(l => pinType(byId[l.from.node], l.from.key) !== 'exec');
  const execLinks = links.filter(l => pinType(byId[l.from.node], l.from.key) === 'exec');
  const cache = new Map();
  const visiting = new Set();
  const activated = new Set();     // 本次实际被求值的节点，用于提示「未接入执行线」
  const startFired = new Set();    // 异步节点「开始」出口已触发过的节点（每节点每次运行只触发一次）

  /* ---- 运行级采集（P3）：这一层是「重放」和「成本账本」的唯一数据来源 ---- */
  const runId = 'run' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  let runVersionId = '';           // 这次跑的是哪一版快照
  let runCacheHits = 0;            // 跨运行复用了几个节点
  const runNodeLog = [];           // 节点级快照（实际模型 / 解析后参数 / 成本 / 确定性）
  const runInputs = new Map();     // nodeId -> { 引脚: 解析后的值 }，由 resolveInput 记
  const runRaw = new Map();        // nodeId -> { 引脚: 原值 }，只留资产类（算血缘用）
  const runEdges = [];             // 产出边，收尾时写进血缘表

  /* 值不适合入库时压成一行说明：data URL 动辄几 MB，直接进快照会把配额吃光，
   * 而且对「哪版参数出的这张图」没有信息量。长度和类型才是要留的信息。 */
  const snapVal = v => {
    if(v === undefined || v === null) return v;
    if(typeof v === 'number' || typeof v === 'boolean') return v;
    const s = typeof v === 'string' ? v : '';
    if(!s){ try { return JSON.stringify(v).slice(0, 120); } catch(e){ return '[对象]'; } }
    if(/^data:/i.test(s)) return '<内联数据 ' + s.length + 'B>';
    if(/^(blob|desk):/i.test(s)) return s.length > 160 ? s.slice(0, 160) : s;
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  };

  /* 引擎与模型名：快照里**必须**有这两项，否则「同参数重跑」根本对不上
   * —— 同一个提示词在不同引擎上出的是两张完全不同的图。 */
  const engineOf = n => {
    try {
      if(n.type === 'imageGen' || n.type === 'tripoImg') return (typeof imgMode === 'function') ? imgMode() : '';
      if(n.type === 'aiTask' || n.type === 'smartBranch' || n.type === 'featureExtract') return (typeof llmMode === 'function') ? llmMode() : '';
      if(n.type === 'model3d' || n.type === 'tripoModel' || n.type === 'tripoModelMulti'){
        return (typeof isTripoWeb === 'function' && isTripoWeb()) ? 'web' : 'api';
      }
    } catch(e){}
    return '';
  };
  const modelOf = n => {
    try {
      if(n.type === 'imageGen' || n.type === 'tripoImg'){
        const el = $('imgModel');
        return el && el.value ? String(el.value) : '';
      }
      if(n.type === 'aiTask' || n.type === 'smartBranch'){
        const el = $('bsModel') || $('modelSel');
        return el && el.value ? String(el.value) : '';
      }
    } catch(e){}
    return '';
  };

  /* 缓存键用的值归一。**不能用 snapVal**：它把任何 data: 都压成「<内联数据 NNNB>」，
   * 于是两张字节数相同的不同参考图会算出同一个键 —— 出来的是上次那张图，且毫无报错。
   * 这里改成短值原样、长值取指纹，既区分得开又不把 5MB 塞进哈希函数。 */
  const keyVal = v => {
    if(v === undefined || v === null) return v;
    if(typeof v === 'number' || typeof v === 'boolean') return v;
    if(typeof v !== 'string'){ try { return JSON.stringify(v).slice(0, 400); } catch(e){ return '[对象]'; } }
    if(v.length <= 2048) return v;
    const h = (typeof fnv1a === 'function') ? fnv1a(v, 2166136261).toString(36) : String(v.length);
    return '#h' + h + ':' + v.length;
  };

  /* 产出边：哪些节点产出了可以被追溯的资产。
   * 键用**内容哈希**而不是文件名 —— 同一份字节无论存到磁盘、又导入图库、还是被拿来当参考图，
   * 都能对回同一条边；也不用改动资产写入的四条路径（桌面 / IndexedDB / 图库扫描 / 对话保存）。 */
  const ASSET_NODES = {
    imageGen:'imageGen', imageEdit:'imageEdit', tripoImg:'tripoImg',
    model3d:'model3d', tripoModel:'tripoModel', tripoModelMulti:'tripoModelMulti',
    modelViews:'modelViews', featureExtract:'featureExtract'
  };
  const collectAssetEdges = (n, meta) => {
    if(!ASSET_NODES[n.type] || !n.out || runEdges.length >= 60) return;
    if(typeof blobIdFor !== 'function') return;
    const parents = [];
    const raw = runRaw.get(n.id) || {};
    Object.keys(raw).forEach(k => {
      const v = raw[k];
      if(typeof v !== 'string' || v.length < 40) return;
      if(!/^(data:|blob:|desk:|https?:)/i.test(v)) return;
      parents.push('blob:' + blobIdFor(v));
    });
    Object.keys(n.out).forEach(k => {
      const v = n.out[k];
      if(typeof v !== 'string' || v.length < 40) return;
      if(!/^(data:|blob:|desk:|https?:)/i.test(v)) return;
      runEdges.push({
        asset: 'blob:' + blobIdFor(v),
        kind: /^(data:|blob:|desk:)/i.test(v) ? 'image' : 'ref',
        runId, flowId: bp.id, versionId: runVersionId,
        nodeId: n.id, nodeType: n.type, cap: ASSET_NODES[n.type],
        model: modelOf(n), engine: engineOf(n),
        determinism: meta.determinism,
        parents: parents.slice(0, 8)
      });
    });
  };

  bpRunBusy = true;
  bpRunAbort = false;
  bpRunCtrl = new AbortController();     // 停止时 abort：在途请求一起断
  bpRunNodeId = null;
  bpRunLinkId = null;
  const btn = $('btnBpRun');
  btn.disabled = true;
  btn.textContent = '运行中…';
  const stopBtn = $('btnBpStop');
  if(stopBtn){ stopBtn.classList.remove('hidden'); stopBtn.disabled = false; }
  bp.nodes.forEach(n => { n.status = ''; n.error = ''; n.out = {}; n.reasoning = ''; });
  renderNodes();

  const runStarted = Date.now();
  bpLogExpand();
  bpLogClear();
  bpLog(`开始运行 · ${bp.nodes.length} 个节点`);

  /* 运行前锁定版本：拿到 versionId，事后的运行记录才能证明「跑的是哪一版」。
   * 结构没变就复用上一份快照，不会每跑一次多一份。失败不影响运行。 */
  try {
    if(typeof pinFlowVersion === 'function') runVersionId = (await pinFlowVersion(bp)) || '';
  } catch(e){ runVersionId = ''; }

  const setStatus = (n, text, cls) => {
    const el = $('n-' + n.id);
    const st = el && el.querySelector('.node-status');
    if(st){ st.textContent = text; st.className = 'node-status ' + cls; }
  };
  const highlight = (nodeId, linkId) => {
    bpRunNodeId = nodeId;
    bpRunLinkId = linkId;
    document.querySelectorAll('.node.running').forEach(x => x.classList.remove('running'));
    if(nodeId){
      const el = $('n-' + nodeId);
      if(el) el.classList.add('running');
    }
    renderLinks();
  };

  async function resolveInput(n, key, viaLinkId, visited){
    const l = dataLinks.find(x => x.to.node === n.id && x.to.key === key);
    if(!l) return undefined;
    const src = byId[l.from.node];
    if(!src) return undefined;
    const out = await evalNode(src, l.id, visited);
    highlight(n.id, viaLinkId);
    const v = out ? out[l.from.key] : undefined;
    /* 记「**解析后**」的值而不是流程里的原始参数：
     * 引脚连线会在运行时把上游结果灌进来，只看节点 data 永远算不出这张图用了什么。 */
    try {
      let bag = runInputs.get(n.id);
      if(!bag){ bag = {}; runInputs.set(n.id, bag); }
      bag[key] = snapVal(v);
      bag.__from = l.from.node;
      /* 原值另存一份（只留资产类、每个节点最多 4 个）：
       * 血缘要的是上游资产的**内容指纹**，被 snapVal 压过的值算不出来。 */
      if(typeof v === 'string' && v.length >= 40 && /^(data:|blob:|desk:|https?:)/i.test(v)){
        let raw = runRaw.get(n.id);
        if(!raw){ raw = {}; runRaw.set(n.id, raw); }
        const kn = Object.keys(raw).length;
        if(kn < 4) raw[key] = v;
      }
    } catch(e){}
    return v;
  }

  async function evalNode(n, viaLinkId, visited){
    if(cache.has(n.id)) return cache.get(n.id);
    if(visiting.has(n.id)) throw new Error('检测到循环数据连接，请断开回路');
    visiting.add(n.id);
    try {
      const out = await executeNode(n, viaLinkId, visited);
      cache.set(n.id, out);
      activated.add(n.id);
      return out;
    } finally {
      visiting.delete(n.id);
    }
  }

  async function executeNode(n, viaLinkId, visited){
    if(isStopped()) throw stopError();      // 停止后不再启动新节点
    highlight(n.id, viaLinkId);
    setStatus(n, '运行中', 'running');
    const nodeStarted = Date.now();
    bpLog('▶ ' + bpNodeLabel(n) + ' 开始');
    const input = key => resolveInput(n, key, viaLinkId, visited);
    /* 参数引脚取值：连线优先，未连线才用节点上就地填写的值。
       少了这一步，数值节点连到 maxEdge / 超时这类引脚上也不会生效。 */
    const paramIn = async key => {
      const v = await input(key);
      if(v !== undefined && v !== null && v !== '') return v;
      // 节点上没有就地值时，回退到声明缺省值（老流程节点可能根本没有这个字段）
      return paramFallback(n, key);
    };
    try {
      /* 节点行为由 node-defs.js 的描述符提供（架构改良 A），这里只负责统一的外壳：
         状态、日志、错误归类。ctx 里给出节点运行真正需要的东西。 */
      const runner = nodeRunner(n.type);
      if(!runner) throw new Error('节点类型「' + n.type + '」没有实现（未注册到 node-defs.js）');

      const meta = (typeof nodeMeta === 'function')
        ? nodeMeta(n.type)
        : { cost: 0, determinism: 'structural', cacheable: false };
      let fromCache = false;
      let cacheKey = '';

      /* 跨运行复用：只对花钱的节点做（cost > 0）。
       * 键里必须含引擎与模型名 —— 同一句提示词在本地 ComfyUI 与云端 banana 上是两张完全不同的图。
       * 少一个维度就会出现「参数不同却命中同一条」，而这种 bug 表面上一切正常，只是出来的是上次那张。 */
      if(meta.cacheable && typeof cacheKeyFor === 'function'){
        try {
          const ins = {};
          const dIn = (NODE_DEFS[n.type] || {}).inputs || [];
          for(const k of dIn){
            const v = await input(k);
            if(v !== undefined && v !== null) ins[k] = keyVal(v);
          }
          cacheKey = cacheKeyFor(n.type, engineOf(n) + '|' + modelOf(n),
            Object.assign({}, n.data || {}, ins));
          if(cacheKey){
            const hit = await cacheGet(cacheKey);
            if(hit && hit.out){
              n.out = (hit.out && typeof hit.out === 'object') ? Object.assign({}, hit.out) : hit.out;
              fromCache = true;
              runCacheHits++;
              try { cacheTouch(cacheKey); } catch(e){}
              bpLog('↺ ' + bpNodeLabel(n) + ' 复用上次产出（本次没花钱）', 'warn');
            }
          }
        } catch(e){
          cacheKey = '';       // 复用出问题就当没开，绝不让它挡住正常执行
        }
      }

      if(!fromCache){
        /* 异步节点的「开始」出口：任务真正启动时立即触发下游，不等结果。
         * 需要拿到结果才动的节点必须接「完成」出口（done）——那才是
         * 「网页生图结束、图片到手后才激活」的执行线。 */
        const dDef = NODE_DEFS[n.type] || {};
        if(dDef.asyncExec && !startFired.has(n.id)){
          startFired.add(n.id);
          bpLog('↷ ' + bpNodeLabel(n) + ' 任务启动（触发「开始」出口）');
          try { await followExec(n, n.out, visited || new Set([n.id]), 'exec'); } catch(e){}
        }
        await runner({ n, input, paramIn, setStatus, log: bpLog, startedAt: nodeStarted });
        if(cacheKey && meta.cacheable && typeof cachePut === 'function'){
          try {
            await cachePut(cacheKey, {
              cap: n.type, engine: engineOf(n), model: modelOf(n),
              determinism: meta.determinism, cost: meta.cost, out: n.out
            });
          } catch(e){}
        }
      }

      n.status = 'ok';
      setStatus(n, '完成', 'ok');
      const nodeMs = Date.now() - nodeStarted;
      if(!((NODE_REGISTRY[n.type] || {}).quiet)) bpLog('✓ ' + bpNodeLabel(n) + ' · ' + nodeMs + 'ms · ' + bpOutPreview(n.out), 'ok');

      /* 节点级快照：参数 = 就地填的 + **解析进来的**（后者覆盖前者，那才是真正生效的值）。
       * cost 记「这个节点本来要花多少」，命中缓存的也算进去 —— 账本要用它算省下的量。 */
      runNodeLog.push({
        id: n.id, type: n.type, title: bpNodeLabel(n), ok: true, ms: nodeMs,
        model: modelOf(n), engine: engineOf(n),
        determinism: meta.determinism, cost: Number(meta.cost) || 0,
        cache: fromCache,
        params: Object.assign({}, n.data || {}, runInputs.get(n.id) || {})
      });
      collectAssetEdges(n, meta);
      return n.out;
    } catch(err){
      // 手动停止不是失败：单独一种状态，不进失败计数
      if(err && err._stopped){
        n.status = 'stopped';
        n.error = '已停止';
        setStatus(n, '已停止', 'stopped');
        bpLog('■ ' + bpNodeLabel(n) + ' 已停止', 'warn');
        throw err;
      }
      n.status = 'error';
      n.error = friendlyErr(err);
      setStatus(n, '失败', 'error');
      try {
        const meta = (typeof nodeMeta === 'function') ? nodeMeta(n.type) : { cost:0, determinism:'structural' };
        runNodeLog.push({
          id: n.id, type: n.type, title: bpNodeLabel(n), ok: false,
          ms: Date.now() - nodeStarted, model: modelOf(n), engine: engineOf(n),
          determinism: meta.determinism, cost: 0, cache: false,
          params: Object.assign({}, n.data || {}, runInputs.get(n.id) || {}),
          error: n.error
        });
      } catch(e){}
      if(!(err && err._bpLogged)) bpLog('✗ ' + bpNodeLabel(n) + ' 失败 · ' + n.error, 'error');
      throw err;
    }
  }

  async function execFrom(link, visited){
    if(isStopped()) return;
    const target = byId[link.to.node];
    if(!target || visited.has(target.id)) return;
    visited.add(target.id);
    let out;
    try {
      out = await evalNode(target, link.id, visited);
    } catch(e){
      return;
    }
    await followExec(target, out, visited);
  }

  async function followExec(n, out, visited, keyOverride){
    if(isStopped()) return;
    const d = NODE_DEFS[n.type] || {};
    let key = keyOverride || 'exec';
    if(!keyOverride){
      /* 异步节点（asyncExec）完成后走「done · 完成」出口 —— 网页生图拿回图片、
         3D 拿回模型之后下游才开始激活；「exec · 开始」出口已在任务启动时触发过。 */
      if(d.asyncExec) key = 'done';
      else if(d.execOutFrom) key = (out && out.choice) || '';       // AI 分支：走模型选中的那条出口
      else if(n.type === 'branch') key = (out && out.bool) ? 'true' : 'false';
    }
    if(!key) return;
    const outs = execLinks.filter(l => l.from.node === n.id && l.from.key === key);
    if(!outs.length && !keyOverride && d.execOutFrom){
      const picked = ((n.data && n.data[d.execOutFrom]) || []).find(b => b.id === key);
      bpLog('· AI 分支选择了「' + (picked ? picked.name : key) + '」，但该出口没有连接执行线', 'warn');
    }
    for(const l of outs){ if(isStopped()) break; await execFrom(l, visited); }
  }

  /* 执行流只从「任务开始」出发：往下沿执行线依次激活；
     未接在执行链上的节点不会被执行（纯数据节点会在被连线引用时按需求值）。 */
  const starts = bp.nodes.filter(n => n.type === 'start');
  if(!starts.length){
    bpLog('没有「任务开始」节点，本次没有执行任何步骤', 'error');
  }
  for(const s of starts){
    if(isStopped()) break;
    const visited = new Set([s.id]);
    try {
      const out = await evalNode(s, null);
      await followExec(s, out, visited);
    } catch(e){
      // 某个入口失败不影响其他入口
    }
  }

  const wasStopped = isStopped();
  // 需要执行线驱动、却没被激活的节点，明确提示出来（中途停止时不唠叨这事）
  if(!wasStopped){
    const idle = bp.nodes.filter(n => (NODE_DEFS[n.type] || {}).execIn && !activated.has(n.id));
    if(idle.length){
      bpLog('· ' + idle.length + ' 个节点未接入执行线，本次未激活：' + idle.map(bpNodeLabel).join('、'));
    }
  }

  highlight(null, null);
  renderNodes();
  bpRunBusy = false;
  btn.disabled = false;
  btn.textContent = '运行';
  if(stopBtn){ stopBtn.classList.add('hidden'); stopBtn.disabled = false; }
  bpRunCtrl = null;
  bpRunAbort = false;
  scheduleFlowSave();
  const errs = bp.nodes.filter(n => n.status === 'error').length;
  if(wasStopped){
    bpLog('运行已停止 · ' + activated.size + ' 个节点已激活 · ' + (Date.now() - runStarted) + 'ms', 'warn');
    bpToast('已停止运行');
  } else {
    bpLog('运行结束 · ' + activated.size + ' 个节点已激活 · ' + errs + ' 失败 · ' + (Date.now() - runStarted) + 'ms', errs ? 'error' : 'ok');
    bpToast(errs ? '运行结束，有节点失败'
      : starts.length ? '运行完成'
        : '没有「任务开始」节点，未执行任何步骤');
  }

  /* 资产血缘：把这次产出的每个资产记一条边（带上级内容指纹）。
   * 异步写，不 await —— 血缘是诊断信息，绝不能拖慢或弄坏运行收尾。 */
  if(runEdges.length && typeof lineageAdd === 'function'){
    runEdges.forEach(e => { try { lineageAdd(e); } catch(x){} });
  }

  /* 运行遥测：记一条历史（自我迭代的数据地基）。
     只存概要，不存图片/模型内容；历史库不可用时静默跳过，绝不影响运行结果。 */
  if(typeof recordRun === 'function'){
    try {
      const firstErr = bp.nodes.find(n => n.status === 'error');
      /* 三档判定：结构（校验过没过）+ 行为（有没有失败节点 / 有没有真的跑起来）+ 质量。
       * 以前只有一个 ok 布尔，「跑完但一个节点都没激活」也算成功 —— 太粗，
       * 导致「刚刚成功」这个触发条件不精确，后面所有自动化都建在沙子上。 */
      let structuralOk = true;
      try { if(typeof validateFlow === 'function') structuralOk = validateFlow(bp).errors.length === 0; } catch(e){}
      const vres = (typeof verdictOf === 'function') ? verdictOf({
        started: starts.length > 0,
        structuralOk,
        failedNodes: errs,
        activated: activated.size,
        stopped: wasStopped,
        rating: 0,
        retries: 0
      }) : { verdict: '' };
      recordRun({
        at: Date.now(),
        flowId: bp.id,
        flowName: bp.name || '未命名工作流',
        versionId: runVersionId,
        ok: !wasStopped && errs === 0 && starts.length > 0,
        stopped: wasStopped,
        ms: Date.now() - runStarted,
        nodes: bp.nodes.length,
        activated: activated.size,
        failed: errs,
        error: firstErr ? (bpNodeLabel(firstErr) + '：' + firstErr.error)
          : (!starts.length ? '没有「任务开始」节点，未执行任何步骤' : ''),
        outs: typeof runOutsSummary === 'function' ? runOutsSummary(bp.lastRun) : [],
        verdict: vres.verdict || '',
        nodeInputs: runNodeLog,
        cacheHits: runCacheHits,
        determinism: (typeof runDeterminismOf === 'function') ? runDeterminismOf(runNodeLog) : ''
      });
    } catch(e){ /* 遥测失败不影响运行 */ }
  }
  // 历史页正开着时随手刷新一下，运行完就能看到这一条
  try {
    if(typeof bpSideTab !== 'undefined' && bpSideTab === 'runs' && typeof renderRunHistory === 'function') renderRunHistory();
  } catch(e){}
}

