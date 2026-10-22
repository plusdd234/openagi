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
let bpSideTab = localStorage.getItem('hf_bp_side_tab') === 'vars' ? 'vars' : 'lib';
let bpVarAddOpen = false;
let varDrag = null;
let varMenuTarget = null;

function setBpSideTab(name){
  bpSideTab = name === 'vars' ? 'vars' : 'lib';
  localStorage.setItem('hf_bp_side_tab', bpSideTab);
  applySideTab();
}

function applySideTab(){
  const showVars = bpSideTab === 'vars';
  $('tabLib').classList.toggle('active', !showVars);
  $('tabLib').setAttribute('aria-selected', String(!showVars));
  $('tabVars').classList.toggle('active', showVars);
  $('tabVars').setAttribute('aria-selected', String(showVars));
  $('paneLib').classList.toggle('hidden', showVars);
  $('paneVars').classList.toggle('hidden', !showVars);
  if(showVars) renderVars();
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
    dot.style.background = PIN_COLORS[v.type] || '#7c8cff';

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
    if(file.size > 2 * 1024 * 1024){ bpToast('模型超过 2MB，无法写入工作流本地存储'); return; }
  } else if(!/^image\//.test(file.type)){
    bpToast('请选择图像文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    v.value = reader.result;
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
    const group = document.createElement('div');
    group.className = 'lib-group';
    group.textContent = g.group;
    host.appendChild(group);
    g.types.forEach(type => {
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

function addNodeAt(type, x, y){
  if(!bp) return;
  const n = newNode(type, Math.round(x), Math.round(y));
  bp.nodes.push(n);
  renderNodes();
  scheduleFlowSave();
  const el = $('n-' + n.id);
  if(el) el.classList.add('sel');
}

// ---- 节点执行 ----
async function llmChat(sys, userText, image){
  const key = $('llmKey').value.trim();
  const base = $('llmBaseUrl').value.trim().replace(/\/$/, '');
  const model = $('llmModel').value.trim();
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
  const key = $('llmKey').value.trim();
  const base = $('llmBaseUrl').value.trim().replace(/\/$/, '');
  const model = $('llmModel').value.trim();
  if(!key || !base || !model) throw new Error('语言模型未配置');

  const limitMs = opts && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  const ctrl = new AbortController();
  let idle = null;
  let hard = null;
  let waitingFirst = true;
  let abortReason = '';
  const abortWith = reason => { abortReason = reason; ctrl.abort(); };
  const bump = ms => {
    clearTimeout(idle);
    idle = setTimeout(() => abortWith('idle'), ms || 60000);
  };
  // 首段响应等待：任务配置了超时则按配置等待，否则默认 30 秒
  const firstWaitMs = limitMs > 0 ? limitMs : 30000;
  bump(firstWaitMs);
  hard = setTimeout(() => abortWith('limit'), limitMs || 600000);

  const req = apiRequest(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    },
    body: JSON.stringify({
      model,
      messages: (sys ? [{ role:'system', content: sys }] : []).concat(messages),
      temperature: .3,
      stream: true
    })
  });

  try{
    const res = await fetch(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
    if(!res.ok){
      const detail = await res.text();
      throw new Error('HTTP ' + res.status + '：' + String(detail).slice(0, 200));
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if(!res.body || ctype.includes('application/json')){
      const data = await res.json();
      const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
      if(!text) throw new Error('模型没有返回内容');
      if(onDelta) onDelta(text, text);
      return text;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
    let doneFlag = false;
    const pushLine = line => {
      const s = line.replace(/\r$/, '').trim();
      if(!s || s.startsWith(':') || !s.startsWith('data:')) return;
      const payload = s.slice(5).trim();
      if(payload === '[DONE]'){ doneFlag = true; return; }
      try{
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message || {});
        const piece = d && typeof d.content === 'string' ? d.content : '';
        if(piece){
          waitingFirst = false;
          acc += piece;
          if(onDelta) onDelta(acc, piece);
        }
      }catch(_){ /* 跳过非 JSON 行 */ }
    };

    while(true){
      const { done, value } = await reader.read();
      if(done) break;
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

    const text = acc.trim();
    if(!text) throw new Error('模型没有返回内容');
    return text;
  }catch(e){
    if(e && e.name === 'AbortError'){
      if(abortReason === 'limit') throw new Error('任务超时（' + Math.round((limitMs || 600000) / 1000) + ' 秒）已中止');
      throw new Error(waitingFirst
        ? '等待模型首段响应超过 ' + Math.round(firstWaitMs / 1000) + ' 秒（图像分析较慢，可在节点的「超时」里调大；也可能是地址/密钥/模型名错误，或模型不支持图像输入）'
        : '流式响应中断：连续 60 秒没有收到新内容');
    }
    throw e;
  }finally{
    clearTimeout(idle);
    clearTimeout(hard);
  }
}
async function llmChatMessagesStream(sys, messages, onDelta){
  return llmStreamRequest(sys || BASE_SYS, messages, onDelta);
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
  const raw = await llmStreamRequest(sys, [{ role:'user', content }], onDelta, { timeoutMs });
  if(!raw) throw new Error('分析任务未返回内容');
  return parseAiTaskResult(raw, outs);
}

function toBool(v){
  if(typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s.startsWith('true') || s === '1' || s === 'yes' || s === '是' || s === '真';
}

async function wfCondition(instruction, text){
  const user = [
    '判断条件：' + (instruction || '输入内容是否满足条件'),
    text ? '输入文本：\n' + text : ''
  ].filter(Boolean).join('\n\n');
  const out = await llmChat('你是条件判断器。根据判断条件评估输入内容，只输出 true 或 false，不要输出任何其他文字。', user);
  if(!out) throw new Error('条件判断未返回结果');
  return toBool(out);
}

async function wfTripoWebImage(prompt, image, opts){
  const o = opts || {};
  const timeoutSec = Math.max(10, Math.min(900, Math.trunc(Number(o.timeoutSec) || 0) || 240));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 40) * 1000);
  try{
    const res = await fetch(TRIPO_WEB_BASE + '/generate', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        prompt,
        image: image || '',
        ratio: o.ratio && o.ratio !== 'auto' ? o.ratio : '',
        mode: o.mode === 'text' || o.mode === 'image' ? o.mode : '',
        timeoutSec
      }),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await res.json(); } catch(e) {}
    if(!res.ok || !data || !data.url) throw new Error((data && data.message) || ('Tripo 助手返回 HTTP ' + res.status));
    return { url: data.url + '?t=' + Date.now(), file: data.file || '', canvas: !!data.canvas, message: data.message || '' };
  }catch(e){
    if(e && e.name === 'AbortError') throw new Error('Tripo 网页生成超时（' + (timeoutSec + 40) + ' 秒）');
    if(e instanceof TypeError) throw new Error('无法连接 Tripo 助手：请先运行 start-relay.bat（或 start-tripo-bridge.bat）');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function wfImage(prompt, image){
  if(isTripoWeb()){
    const r = await wfTripoWebImage(prompt, image, { timeoutSec: 240 });
    return r.url;
  }
  if(isTripo()){
    const model = $('imgModel').value.trim() || 'seedream_v5';
    let task;
    if(image){
      const token = await tripoUpload(image);
      task = await tripoCall('/generation/image-to-image', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ model, input:token, prompt, size:'2K', output_format:'png' })
      });
    } else {
      task = await tripoCall('/generation/text-to-image', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ model, prompt, size:'2K', output_format:'png', watermark:false })
      });
    }
    const done = await tripoPoll(task.task_id);
    const src = done.output && done.output.generated_image_url;
    if(!src) throw new Error('任务完成但未返回图片地址');
    return src;
  }

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

async function wf3D(image){
  if(!isTripo()) throw new Error('3D 节点需要 Tripo 引擎');
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

async function runFlow(){
  if(bpRunBusy || !bp) return;
  if(!bp.nodes.length){ bpToast('请先添加节点'); return; }

  const byId = {};
  bp.nodes.forEach(n => { byId[n.id] = n; });
  const links = bp.links.filter(l => byId[l.from.node] && byId[l.to.node]);
  const dataLinks = links.filter(l => pinType(byId[l.from.node], l.from.key) !== 'exec');
  const execLinks = links.filter(l => pinType(byId[l.from.node], l.from.key) === 'exec');
  const cache = new Map();
  const visiting = new Set();
  const activated = new Set();     // 本次实际被求值的节点，用于提示「未接入执行线」

  bpRunBusy = true;
  bpRunNodeId = null;
  bpRunLinkId = null;
  const btn = $('btnBpRun');
  btn.disabled = true;
  btn.textContent = '运行中…';
  bp.nodes.forEach(n => { n.status = ''; n.error = ''; n.out = {}; });
  renderNodes();

  const runStarted = Date.now();
  bpLogExpand();
  bpLogClear();
  bpLog(`开始运行 · ${bp.nodes.length} 个节点`);

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

  async function resolveInput(n, key, viaLinkId){
    const l = dataLinks.find(x => x.to.node === n.id && x.to.key === key);
    if(!l) return undefined;
    const src = byId[l.from.node];
    if(!src) return undefined;
    const out = await evalNode(src, l.id);
    highlight(n.id, viaLinkId);
    return out ? out[l.from.key] : undefined;
  }

  async function evalNode(n, viaLinkId){
    if(cache.has(n.id)) return cache.get(n.id);
    if(visiting.has(n.id)) throw new Error('检测到循环数据连接，请断开回路');
    visiting.add(n.id);
    try {
      const out = await executeNode(n, viaLinkId);
      cache.set(n.id, out);
      activated.add(n.id);
      return out;
    } finally {
      visiting.delete(n.id);
    }
  }

  async function executeNode(n, viaLinkId){
    highlight(n.id, viaLinkId);
    setStatus(n, '运行中', 'running');
    const nodeStarted = Date.now();
    bpLog('▶ ' + bpNodeLabel(n) + ' 开始');
    const input = key => resolveInput(n, key, viaLinkId);
    /* 参数引脚取值：连线优先，未连线才用节点上就地填写的值。
       少了这一步，数值节点连到 maxEdge / 超时这类引脚上也不会生效。 */
    const paramIn = async key => {
      const v = await input(key);
      if(v !== undefined && v !== null && v !== '') return v;
      const d = n.data ? n.data[key] : undefined;
      return (d === undefined || d === null) ? undefined : d;
    };
    try {
      if(n.type === 'start'){
        (n.params || []).forEach(p => { n.out[p.id] = paramValue(p); });
      } else if(n.type === 'end'){
        const values = [];
        for(const p of (n.params || [])){
          const v = await input(p.id);
          if(v !== undefined) p.value = v;
          n.out[p.id] = v;
          values.push({ id:p.id, name:p.name, type:p.type, value:v });
        }
        n.out.values = values;
        if(bp) bp.lastRun = { at: Date.now(), values };
      } else if(n.type === 'varGet'){
        const v = varOf(n.data.varId);
        if(!v) throw new Error('变量已删除');
        n.out[v.id] = paramValue(v);
      } else if(n.type === 'varSet'){
        const v = varOf(n.data.varId);
        if(!v) throw new Error('变量已删除');
        const val = await input(v.id);
        if(val === undefined) throw new Error('未连接要写入的值');
        v.value = coerceVar(v, val);
        if(v.type !== 'model' && v.type !== 'image') v.fileName = '';
        n.out[v.id] = v.value;
        renderNodes();
      } else if(n.type === 'modelIn'){
        if(!n.data.model) throw new Error('未导入 3D 模型');
        n.out.model = n.data.model;
      } else if(n.type === 'imageIn'){
        if(!n.data.image) throw new Error('未选择图像');
        n.out.image = n.data.image;
      } else if(n.type === 'text'){
        n.out.text = n.data.text || '';
      } else if(n.type === 'numNode'){
        const num = Number(n.data.value);
        const v = isFinite(num) ? num : 0;
        n.out.int = Math.trunc(v);
        n.out.float = v;
      } else if(n.type === 'boolNode'){
        // 旧流程存的是 data.value，保留兼容
        const raw = n.data.bool !== undefined ? n.data.bool : n.data.value;
        n.out.bool = raw !== false;
      } else if(n.type === 'aiTask'){
        const instruction = String((await paramIn('instruction')) || '').trim();
        const ins = n.data.inputs || [];
        const outs = n.data.outputs || [];
        const sections = [];
        const images = [];
        let hasMaterial = false;
        for(const p of ins){
          const v = await input(p.id);
          if(v === undefined || v === null || v === '') continue;
          hasMaterial = true;
          if(p.type === 'image') images.push(v);
          else if(p.type === 'model') sections.push({ name:p.name || '模型', value:'已提供模型文件' });
          else sections.push({ name:p.name || '输入', value: typeof v === 'object' ? JSON.stringify(v) : String(v) });
        }
        if(!instruction && !hasMaterial) throw new Error('缺少任务指令或输入');
        const tSec = Number(await paramIn('timeout'));
        const limitMs = tSec > 0 ? Math.round(tSec * 1000) : 0;
        const live = bpLog('分析任务：请求已发出，等待首段输出…', '', true);
        try{
          n.out = await wfAiTask(instruction, sections, images, outs, acc => {
            setStatus(n, '生成中 ' + acc.length + ' 字', 'running');
            if(live) live.set('流式生成 ' + acc.length + ' 字 · …' + acc.slice(-200));
          }, limitMs);
        }catch(e){
          if(live) live.done('分析任务失败 · ' + friendlyErr(e), 'error');
          if(e) e._bpLogged = true;
          throw e;
        }
        const first = outs.length ? n.out[outs[0].id] : '';
        if(live) live.done('分析任务完成 · ' + outs.length + ' 个输出 · ' + (Date.now() - nodeStarted) + 'ms · ' + bpPreview(first, 160), 'ok');
      } else if(n.type === 'condition'){
        const text = await input('text');
        n.out.bool = await wfCondition(String((await paramIn('instruction')) || ''), text);
      } else if(n.type === 'branch'){
        const v = await input('bool');
        if(v === undefined) throw new Error('条件引脚未连接布尔值');
        n.out.bool = toBool(v);
      } else if(n.type === 'result'){
        const text = await input('text');
        const image = await input('image');
        const model = await input('model');
        if(text !== undefined) n.out.text = text;
        if(image !== undefined) n.out.image = image;
        if(model !== undefined) n.out.model = model;
        if(!n.out.text && !n.out.image && !n.out.model) throw new Error('没有连接任何结果');
      } else if(n.type === 'imageGen'){
        const p = ((await input('prompt')) || n.data.prompt || '').trim();
        if(!p) throw new Error('缺少提示词');
        n.out.image = await wfImage(p, await input('image'));
      } else if(n.type === 'tripoImg'){
        const p = ((await input('prompt')) || n.data.prompt || '').trim();
        if(!p) throw new Error('缺少提示词');
        const ref = await input('image');
        const timeoutSec = Math.max(10, Math.min(900, Math.trunc(Number(await paramIn('timeout')) || 0) || 240));
        const r = await wfTripoWebImage(p, ref, {
          timeoutSec,
          ratio: await paramIn('ratio'),
          mode: await paramIn('mode')
        });
        n.out.image = r.url;
        n.out.text = r.file ? ('已保存：' + r.file) : r.url;
      } else if(n.type === 'imageCompress'){
        const src = await input('image');
        if(!src) throw new Error('缺少图像输入');
        const edge = Math.max(64, Math.min(4096, Math.trunc(Number(await paramIn('maxEdge')) || 0) || 1024));
        const q = Math.max(10, Math.min(100, Math.trunc(Number(await paramIn('quality')) || 0) || 80)) / 100;
        n.out = await wfCompressImage(src, edge, q);
      } else if(n.type === 'model3d'){
        const img = await input('image');
        if(!img) throw new Error('缺少图像输入');
        n.out.model = await wf3D(img);
      } else if(n.type === 'modelViews'){
        const model = await input('model');
        if(!model) throw new Error('缺少 3D 模型输入');
        if(!window.Model3D) throw new Error('3D 模块未加载');
        if(!Model3D.ready()) throw new Error('3D 组件未就绪（缺少 three.js）');
        const P = n.data.params || [];
        // 参数取值：连线优先，未连线则用节点上就地填写的值
        const get = async (name, fallback) => {
          const p = P.find(x => x.name === name);
          if(!p) return fallback;
          const linked = await input(p.id);
          if(linked !== undefined && linked !== null && linked !== '') return linked;
          return (p.value === '' || p.value === null || p.value === undefined) ? fallback : p.value;
        };
        const sizeRaw = Number(await get('画布尺寸', 2048));
        const opts = {
          size: sizeRaw === 4096 ? 4096 : 2048,
          gap: Number(await get('间距', 0)) || 0,
          lineWidth: Number(await get('线宽', 1.4)) || 1.4,
          lineColor: String(await get('线色', '#2b2b2b')),
          fillColor: String(await get('填充色', '#ffffff')),
          bgColor: String(await get('背景色', '#ffffff')),
          bgOpacity: Math.max(0, Math.min(1, Number(await get('背景不透明度', 1)))),
          mode: String(await get('模式', 'line')) === 'solid' ? 'solid' : 'line'
        };
        n.out.image = await Model3D.quadViews(model, opts);
        n.out.text = '四视图已生成 · ' + opts.size + '×' + opts.size + ' · ' + (opts.mode === 'solid' ? '实体' : '线框');
      }
      n.status = 'ok';
      setStatus(n, '完成', 'ok');
      if(n.type !== 'aiTask') bpLog('✓ ' + bpNodeLabel(n) + ' · ' + (Date.now() - nodeStarted) + 'ms · ' + bpOutPreview(n.out), 'ok');
      return n.out;
    } catch(err){
      n.status = 'error';
      n.error = friendlyErr(err);
      setStatus(n, '失败', 'error');
      if(!(err && err._bpLogged)) bpLog('✗ ' + bpNodeLabel(n) + ' 失败 · ' + n.error, 'error');
      throw err;
    }
  }

  async function execFrom(link, visited){
    const target = byId[link.to.node];
    if(!target || visited.has(target.id)) return;
    visited.add(target.id);
    let out;
    try {
      out = await evalNode(target, link.id);
    } catch(e){
      return;
    }
    await followExec(target, out, visited);
  }

  async function followExec(n, out, visited){
    const key = n.type === 'branch' ? (out && out.bool ? 'true' : 'false') : 'exec';
    const outs = execLinks.filter(l => l.from.node === n.id && l.from.key === key);
    for(const l of outs) await execFrom(l, visited);
  }

  /* 执行流只从「任务开始」出发：往下沿执行线依次激活；
     未接在执行链上的节点不会被执行（纯数据节点会在被连线引用时按需求值）。 */
  const starts = bp.nodes.filter(n => n.type === 'start');
  if(!starts.length){
    bpLog('没有「任务开始」节点，本次没有执行任何步骤', 'error');
  }
  for(const s of starts){
    const visited = new Set([s.id]);
    try {
      const out = await evalNode(s, null);
      await followExec(s, out, visited);
    } catch(e){
      // 某个入口失败不影响其他入口
    }
  }

  // 需要执行线驱动、却没被激活的节点，明确提示出来
  const idle = bp.nodes.filter(n => (NODE_DEFS[n.type] || {}).execIn && !activated.has(n.id));
  if(idle.length){
    bpLog('· ' + idle.length + ' 个节点未接入执行线，本次未激活：' + idle.map(bpNodeLabel).join('、'));
  }

  highlight(null, null);
  renderNodes();
  bpRunBusy = false;
  btn.disabled = false;
  btn.textContent = '运行';
  scheduleFlowSave();
  const errs = bp.nodes.filter(n => n.status === 'error').length;
  bpLog('运行结束 · ' + activated.size + ' 个节点已激活 · ' + errs + ' 失败 · ' + (Date.now() - runStarted) + 'ms', errs ? 'error' : 'ok');
  bpToast(errs ? '运行结束，有节点失败'
    : starts.length ? '运行完成'
      : '没有「任务开始」节点，未执行任何步骤');
}

