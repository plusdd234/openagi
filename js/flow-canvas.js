/* 流程画布：坐标换算 / 连线 / 存档 / 节点与连线的新建
 *
 * 从 js/desktop.js 拆出（2026-11-01），见 desk-shell.js 顶部说明。
 * 这里的函数仍是全局顶层函数，名字不变。
 */
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
  /* 异步节点（asyncExec）引入「开始 / 完成」双出口后，老流程挂在 exec 上的
     下游线语义是「完成后触发」→ 统一改接到 done 出口，行为逐字节一致；
     exec 出口从此表示「任务启动时触发」。改接计数即返回值。 */
  let rewired = 0;
  flow.links = flow.links.filter(l => {
    const src = flow.nodes.find(n => n.id === l.from.node);
    if(!src) return false;
    const d = NODE_DEFS[src.type];
    if(!d) return false;
    if(d.asyncExec && l.from.key === 'exec'){ l.from.key = 'done'; rewired++; return true; }
    return !(l.from.key === 'exec' && !(d.execOut && d.execOut.length));
  });
  return before - flow.links.length + rewired;
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
