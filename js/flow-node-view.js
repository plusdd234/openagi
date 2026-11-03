/* 节点视图：参数控件 / 引脚 / 节点 DOM 渲染
 *
 * 从 js/desktop.js 拆出（2026-11-01），见 desk-shell.js 顶部说明。
 * 这里的函数仍是全局顶层函数，名字不变。
 */
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
  if(isVarNode && v) dot.style.background = PIN_COLORS[v.type] || '#e88a00';
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
    (d.execOut || []).forEach(k => outWrap.appendChild(makeExecPort(k, 'out',
      k === 'true' ? '真' : k === 'false' ? '假' : k === 'done' ? '完成' : (d.asyncExec && k === 'exec') ? '开始' : '执行')));
    execOutDyn.forEach(p => outWrap.appendChild(makeExecPort(p.id, 'out', p.name || '出口')));
    exec.appendChild(outWrap);
  }
  const hasExec = !!d.execIn || !!(d.execOut && d.execOut.length) || !!execOutDyn.length;

  /* ---------- 节点主体：引脚清单由 node-registry 的 schema 统一给出 ---------- */
  const specs = (NODE_PARAMS[n.type] || []).slice();

  const body = document.createElement('div');
  body.className = 'node-body';
  const inCol = document.createElement('div');
  inCol.className = 'node-col in';
  const outCol = document.createElement('div');
  outCol.className = 'node-col out';

  const pinSets = pinsForRender(n, (bp && bp.vars) || []);

  pinSets.in.forEach(p => {
    if(p.kind === 'endParam'){
      const param = (n.params || []).find(x => x.id === p.key);
      if(param) inCol.appendChild(endParamPort(n, param));
      return;
    }
    if(p.kind === 'param' && p.spec){
      inCol.appendChild(makePort(p.key, 'in', paramPortMeta(p.spec, n, p.key)));
      return;
    }
    inCol.appendChild(makePort(p.key, 'in', { label:p.label, type:p.type }));
  });

  pinSets.out.forEach(p => {
    if(p.kind === 'param' && p.spec){
      outCol.appendChild(makePort(p.key, 'out', paramPortMeta(p.spec, n, p.key)));
    } else {
      outCol.appendChild(makePort(p.key, 'out', { label:p.label, type:p.type }));
    }
  });

  // 图像拆分的动态视图引脚由 viewPinSection 在字段区渲染（紧跟各自的视图控件），不在这里重复

  // 2) 含参数的节点让引脚列占满整行，取值控件才有位置（输入侧 / 输出侧都算）
  const hasParamRow = specs.some(s => !s.tip
    && s.ctl !== 'paramList' && s.ctl !== 'taskPins' && s.ctl !== 'filePick'
    && s.ctl !== 'viewPins' && s.ctl !== 'branchPins' && s.ctl !== 'inPins');
  if(hasParamRow) body.classList.add('wide-in');
  body.append(inCol);
  if(pinSets.out.length) body.appendChild(outCol);

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
      // 输入 / 输出引脚都由管理行自己画 pin（行内探出到节点边缘），
      // 这样引脚和它对应的「设置行」严格对齐；列里不再重复画，避免同一个引脚出现两次。
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

/* 结束节点的参数行：真引脚 + 名称 / 类型 / 接收值。
   只画 paramRow 时没有 pin，portPos 找不到坐标，这条连线就永远画不出来。 */
function endParamPort(n, param){
  const row = document.createElement('div');
  row.className = 'port-row param-port';
  const pin = document.createElement('span');
  pin.className = 'pin in';
  pin.dataset.dir = 'in';
  pin.dataset.key = param.id;
  pin.dataset.type = param.type;
  pin.style.setProperty('--pin-c', PIN_COLORS[param.type] || '#6a7488');
  const body = document.createElement('div');
  body.className = 'param-port-body';
  body.appendChild(paramRow(n, param));
  row.append(pin, body);
  return row;
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
    pin.style.setProperty('--pin-c', PIN_COLORS[p.type] || '#6a7488');
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
  pinWorldReset();      // 节点是重建的，引脚的本地偏移全部作废
  if(typeof edNodeSizeReset === 'function') edNodeSizeReset();   // 节点尺寸缓存同理
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

/* ---------- 节点图像右键菜单：复制到系统剪贴板 ---------- */
let nodeImgMenuSrc = '';
let nodeImgMenuEl = null;

function hideNodeImgMenu(){
  if(nodeImgMenuEl) nodeImgMenuEl.classList.add('hidden');
}

function ensureNodeImgMenu(){
  if(nodeImgMenuEl) return nodeImgMenuEl;
  const menu = document.createElement('div');
  menu.className = 'img-menu hidden';
  menu.id = 'nodeImgMenu';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.act = 'copy';
  btn.append('复制图像');
  const tip = document.createElement('span');
  tip.textContent = '复制到剪贴板';
  btn.appendChild(tip);
  menu.appendChild(btn);
  document.body.appendChild(menu);
  // 菜单内的点击不要冒泡到画布（否则会顺带拖动 / 取消选中）
  menu.addEventListener('pointerdown', e => e.stopPropagation());
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    const src = nodeImgMenuSrc;
    hideNodeImgMenu();
    if(!src) return;
    try{
      await copyNodeImage(src);
      bpToast('图像已复制到剪贴板');
    }catch(err){
      bpToast('复制失败：' + ((err && err.message) || '当前环境不支持写入剪贴板'));
    }
  });
  nodeImgMenuEl = menu;
  return menu;
}

// 右键节点里的任意图像（输入图 / 参数图 / 运行结果图）都弹菜单
document.addEventListener('contextmenu', e => {
  const img = e.target && e.target.closest ? e.target.closest('#bpNodes .node img') : null;
  if(!img) return;
  const src = img.currentSrc || img.src;
  if(!src) return;
  e.preventDefault();
  e.stopPropagation();
  nodeImgMenuSrc = src;
  const menu = ensureNodeImgMenu();
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8)) + 'px';
});

document.addEventListener('pointerdown', e => {
  if(nodeImgMenuEl && !nodeImgMenuEl.classList.contains('hidden') && !nodeImgMenuEl.contains(e.target)) hideNodeImgMenu();
});
document.addEventListener('keydown', e => { if(e.key === 'Escape') hideNodeImgMenu(); });
window.addEventListener('blur', hideNodeImgMenu);
document.addEventListener('wheel', hideNodeImgMenu, { passive:true, capture:true });

function nodeImgLoad(src){
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图像加载失败'));
    im.src = src;
  });
}

function nodeImgDrawPng(im, w, h){
  return new Promise((resolve, reject) => {
    if(!w || !h) return reject(new Error('图像尺寸无效'));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').drawImage(im, 0, 0, w, h);
    cv.toBlob(b => b ? resolve(b) : reject(new Error('图像编码失败')), 'image/png');
  });
}

/* 统一转成 PNG：系统剪贴板只认 image/png，原图可能是 WebP / JPEG。
 * 远程图先 fetch 原始字节，能绕开画布跨域污染；跨域仍失败时再退回直绘。 */
async function nodeImgPngBlob(src){
  if(/^(http|https|blob):/i.test(src)){
    try{
      const res = await fetch(src);
      if(res.ok){
        const raw = await res.blob();
        if(!/^image\//.test(raw.type || '')) throw new Error('不是图像');
        if(/^image\/png$/i.test(raw.type)) return raw;
        const bmp = await createImageBitmap(raw);
        return await nodeImgDrawPng(bmp, bmp.width, bmp.height);
      }
    }catch(err){ /* CORS / 无 CORS 头时走下面的画布直绘 */ }
  }
  const im = await nodeImgLoad(src);
  return await nodeImgDrawPng(im, im.naturalWidth, im.naturalHeight);
}

function nodeImgBlobDataUrl(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图像转码失败'));
    reader.readAsDataURL(blob);
  });
}

// 老环境兜底：选中 img 后 execCommand('copy')，至少能复制图像本体
function nodeImgLegacyCopy(src){
  try{
    const box = document.createElement('div');
    box.contentEditable = 'true';
    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
    const im = document.createElement('img');
    im.src = src;
    box.appendChild(im);
    document.body.appendChild(box);
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    box.remove();
    return ok;
  }catch(err){ return false; }
}

async function copyNodeImage(src){
  // Electron：走主进程原生剪贴板，不受 Chromium 异步剪贴板对图片的限制
  const bridge = window.openagiDesktop && window.openagiDesktop.copyImage;
  if(bridge){
    try{
      const dataUrl = await nodeImgBlobDataUrl(await nodeImgPngBlob(src));
      if(await bridge(dataUrl)) return;
    }catch(err){ /* 落到浏览器的 Clipboard API */ }
  }
  if(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem){
    // Promise 形式的 ClipboardItem：写入在点击手势内立即发起，等待转码不会丢掉用户激活
    try{
      const p = nodeImgPngBlob(src);
      p.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': p })]);
      return;
    }catch(err){
      try{
        const blob = await nodeImgPngBlob(src);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return;
      }catch(err2){ /* 落到下面的兼容方案 */ }
    }
  }
  if(!nodeImgLegacyCopy(src)) throw new Error('当前环境不支持写入剪贴板');
}
