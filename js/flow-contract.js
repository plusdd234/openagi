/* 节点契约与 DAG 规范（P0 · 自主搭建基础设施第一层）
 *
 * 这个模块是「给人看的 UI 声明」到「给机器/LLM 看的契约」之间的一座桥：
 *   - seedNodeData：节点默认值的唯一来源（desktop.js 的 newNode 也调它，杜绝两处硬编码漂移）
 *   - nodeContract / dagSpec：把 NODE_DEFS / NODE_PARAMS / PIN_META 整理成 LLM 可消费的描述
 *   - pinTypeOf / pinDirOf / pinExists：不依赖 DOM 与全局 bp 的引脚解析（校验器与生成器共用）
 *   - extractJson / autoLayout：生成器的解析与布局兜底
 *
 * 纯逻辑、零 DOM：浏览器里作为全局脚本加载，Node 测试里可单独 eval。
 */

/* ---------------------------------------------------------------
 * 一、节点默认数据（唯一来源）
 * 从 desktop.js 的 newNode 原样搬来并扩充：返回 { data, params }。
 * desktop.js 的 newNode 必须调用本函数，不要再写第二份。
 * -------------------------------------------------------------- */
function seedNodeData(type){
  const data = {};
  let params = null;
  switch(type){
    case 'start':
    case 'end':
      params = [];
      break;
    case 'text':
      data.text = '';
      break;
    case 'imageGen':
      data.prompt = '';
      break;
    case 'tripoImg':
      data.prompt = '';
      data.timeout = 240;
      data.ratio = 'auto';
      data.mode = 'auto';
      break;
    case 'imageCompress':
      data.maxEdge = 1024;
      data.quality = 80;
      break;
    case 'imageSplit':
      data.prompt = '';
      data.output = 'cutout';
      data.feather = 2;
      data.timeout = 120;
      data.views = [ seedView('正视图'), seedView('背视图') ];
      break;
    case 'aiTask':
      data.instruction = '';
      data.timeout = TASK_TIMEOUT_DEFAULT;
      data.inputs = [ seedPin('文本', 'string') ];
      data.outputs = [ seedPin('结果', 'string') ];
      break;
    case 'modelViews':
      data.params = [
        seedParam('画布尺寸', 'int', 2048),
        seedParam('间距', 'int', 0),
        seedParam('线宽', 'float', 1.4),
        seedParam('线色', 'string', '#2b2b2b'),
        seedParam('填充色', 'string', '#ffffff'),
        seedParam('背景色', 'string', '#ffffff'),
        seedParam('背景不透明度', 'float', 1),
        seedParam('模式', 'string', 'line')
      ];
      break;
    case 'aiBranch':
      data.instruction = '';
      data.timeout = 120;
      data.branches = [ seedBranch('分支 A'), seedBranch('分支 B') ];
      break;
    case 'condition':
      data.instruction = '';
      break;
    case 'boolNode':
      data.bool = true;
      break;
    case 'numNode':
      data.value = 0;
      break;
    case 'tripoModel':
      data.mode = 'smart';
      data.version = 'P2.0';
      data.topology = '';
      data.faceCount = 0;
      data.count = 1;
      data.format = '';
      data.timeout = 420;
      break;
    case 'tripoModelMulti':
      data.mode = 'smart';
      data.version = 'P2.0';
      data.topology = '';
      data.faceCount = 0;
      data.count = 1;
      data.format = '';
      data.timeout = 600;
      break;
    case 'imageIn':
      data.image = '';
      break;
    case 'modelIn':
      data.model = '';
      break;
    default:
      break;   // branch / result / varGet / varSet / model3d：无默认数据
  }
  return { data, params };
}
function seedPin(name, type){ return { id: uid(), name, type }; }
function seedParam(name, type, value){ return { id: uid(), name, type, value: value, fileName: '' }; }
function seedView(name, hint){ return { id: uid(), name: name || '视图', hint: hint || '' }; }
function seedBranch(name, hint){ return { id: uid(), name: name || '出口', hint: hint || '', fallback: false }; }

/* ---------------------------------------------------------------
 * 二、无 DOM 引脚解析（vars 由调用方传入，不读全局 bp）
 * 返回 null 表示「这个节点没有这个引脚」——校验器要靠它抓悬空连线。
 * -------------------------------------------------------------- */
function pinDirOf(n, key, vars){
  if(!n || !n.type || !key) return null;
  const d = NODE_DEFS[n.type] || {};
  let isIn = false, isOut = false;
  if((d.inputs || []).indexOf(key) >= 0) isIn = true;
  if((d.outputs || []).indexOf(key) >= 0) isOut = true;
  /* 执行类引脚不在 inputs / outputs 里，声明在 execIn / execOut 上；
     同一个 'exec' 键在中间节点上既是入口也是出口，所以返回 'both' 而不是硬选一边。 */
  if(key === 'exec'){
    if(d.execIn) isIn = true;
    if((d.execOut || []).indexOf('exec') >= 0) isOut = true;
  }
  if((d.execOut || []).indexOf(key) >= 0) isOut = true;      // branch 的 true / false
  if(n.type === 'aiTask'){
    const data = n.data || {};
    if((data.inputs || []).some(p => p.id === key)) isIn = true;
    if((data.outputs || []).some(p => p.id === key)) isOut = true;
  }
  if(n.type === 'modelViews' && ((n.data || {}).params || []).some(p => p.id === key)) isIn = true;
  if(n.type === 'imageSplit'){
    const views = (n.data || {}).views || [];
    if(views.some(v => v.id === key)) isOut = true;
    if(/__has$/.test(key) && views.some(v => v.id === key.replace(/__has$/, ''))) isOut = true;
  }
  if(n.type === 'aiBranch' && ((n.data || {}).branches || []).some(b => b.id === key)) isOut = true;
  if(n.type === 'start' && (n.params || []).some(p => p.id === key)) isOut = true;
  if(n.type === 'end' && (n.params || []).some(p => p.id === key)) isIn = true;
  if(n.type === 'varGet' && n.data && n.data.varId === key) isOut = true;
  if(n.type === 'varSet' && n.data && n.data.varId === key) isIn = true;
  if(isIn && isOut) return 'both';
  if(isIn) return 'in';
  if(isOut) return 'out';
  return null;
}

function pinTypeOf(n, key, vars){
  if(!n || !n.type || !key) return null;
  const d = NODE_DEFS[n.type] || {};
  if(key === 'exec'){
    if(d.execIn || (d.execOut || []).indexOf('exec') >= 0) return 'exec';
    return null;
  }
  if((d.execOut || []).indexOf(key) >= 0) return 'exec';      // true / false
  if((d.inputs || []).indexOf(key) >= 0 || (d.outputs || []).indexOf(key) >= 0)
    return PIN_META[key] ? PIN_META[key].type : 'string';
  const data = n.data || {};
  if(n.type === 'aiTask'){
    const p = (data.inputs || []).concat(data.outputs || []).find(x => x.id === key);
    if(p) return p.type;
  }
  if(n.type === 'modelViews'){
    const p = (data.params || []).find(x => x.id === key);
    if(p) return p.type;
  }
  if(n.type === 'imageSplit'){
    const views = data.views || [];
    if(views.some(v => v.id === key)) return 'image';
    if(/__has$/.test(key) && views.some(v => v.id === key.replace(/__has$/, ''))) return 'bool';
  }
  if(n.type === 'aiBranch' && (data.branches || []).some(b => b.id === key)) return 'exec';
  if(n.type === 'start' || n.type === 'end'){
    const p = (n.params || []).find(x => x.id === key);
    if(p) return p.type;
  }
  if((n.type === 'varGet' || n.type === 'varSet') && data.varId && data.varId === key){
    const v = (vars || []).find(x => x.id === key);
    return v ? v.type : 'string';
  }
  return null;
}

function pinExists(n, key, vars){ return pinTypeOf(n, key, vars) !== null; }

/* ---------------------------------------------------------------
 * 三、节点契约（LLM 可读）
 * 大部分字段从声明表自动派生；NODE_RULES 只放声明表表达不了的
 * 语义约束（必填项、动态引脚结构、使用注意）。
 * -------------------------------------------------------------- */
const NODE_RULES = {
  start: {
    note: '流程有且只有一个。输入参数写在 params 里（每项 {id,name,type,value}，type 限 int/float/string/bool/image/model），每个参数是一条数据输出引脚（key = 参数 id）。',
    required: []
  },
  end: {
    note: '收集输出结果。输出参数写在 params 里（结构同 start 的 params），每条是一格「值」输入引脚（key = 参数 id）。至少要有 end 或 result 之一。',
    required: []
  },
  aiTask: {
    note: '动态引脚：data.inputs / data.outputs 各为 {id,name,type} 列表；inputs 的 type 还可为 image。',
    required: ['instruction']
  },
  aiBranch: {
    note: '动态执行出口：data.branches 每项 {id,name,hint,fallback}，每个 id 是一条执行线出口引脚；fallback:true 表示兜底出口。',
    required: ['instruction']
  },
  imageSplit: {
    note: '动态视图：data.views 每项 {id,name,hint}；每个 id 输出一条 image 引脚，另有 id+"__has" 输出 bool 引脚（图中是否有该视图）。',
    required: ['prompt']
  },
  varGet: { note: 'data.varId 指向 vars 里的变量 id，输出该变量的值（引脚 key = varId）。', required: [] },
  varSet: { note: 'data.varId 指向 vars 里的变量 id，把连入的值写入变量（引脚 key = varId）。', required: [] },
  modelViews: { note: 'data.params 每项 {id,name,type,value} 同时是可就地填写的参数和一条输入引脚。', required: [] },
  tripoImg: { note: '最多接 3 张参考图（image / image2 / image3），按引脚顺序上传；mode=auto 时有参考图走图生图。', required: ['prompt'] },
  tripoModelMulti: { note: 'front / left / right / back 四个参考图引脚至少接一个。', required: [] },
  tripoModel: { note: '参考图引脚接一张图像；走网页自动化，消耗网页账号积分。', required: [] },
  tripoModelMulti_warn: '',
  imageGen: { note: '文生图 / 图生图：prompt 引脚接提示词，image 引脚可接参考图。', required: ['prompt'] },
  text: { note: '参数节点（pure）：不被执行线激活，被下游连线引用时才求值。内容写在 data.text。', required: [] },
  numNode: { note: '参数节点（pure）：data.value 同时从 int / float 两个输出引脚输出。', required: [] },
  boolNode: { note: '参数节点（pure）：data.bool 输出布尔值。', required: [] },
  imageIn: { note: '参数节点（pure）：data.image 放图像（上传后由用户填充）。', required: [] },
  modelIn: { note: '参数节点（pure）：data.model 放 3D 模型文件（上传后由用户填充）。', required: [] },
  condition: { note: 'instruction 是判断条件；text 引脚接被判断的文本，输出布尔。', required: ['instruction'] },
  branch: { note: '按 bool 输入走 true / false 两条执行线。', required: [] },
  imageCompress: { note: '等比缩小到最长边并转 JPEG，降低下游数据量。', required: [] },
  result: { note: '汇总文本 / 图像 / 模型结果，运行后在此查看。', required: [] }
};
const NODE_GROUP_OF = {};
(NODE_LIB || []).forEach(g => (g.types || []).forEach(t => { NODE_GROUP_OF[t] = g.group; }));

// 控件形态 → 给 LLM 看的一句话说明
const CTL_DESC = {
  textarea: '多行文本', text: '单行文本', number: '数值', select: '下拉选择',
  bool: '布尔开关', color: '颜色', filePick: '文件选择', paramList: '参数列表',
  taskPins: '自定义引脚列表', viewPins: '动态视图列表', branchPins: '动态出口列表'
};

function nodeContract(){
  const types = {};
  Object.keys(NODE_DEFS).forEach(type => {
    const d = NODE_DEFS[type];
    const rule = NODE_RULES[type] || {};
    const specs = NODE_PARAMS[type] || [];
    const params = [], tips = [];
    specs.forEach(s => {
      if(s.tip){ tips.push(s.tip); return; }
      if(s.ctl === 'paramList' || s.ctl === 'filePick' || s.ctl === 'taskPins'
        || s.ctl === 'viewPins' || s.ctl === 'branchPins') return;   // 块控件由 note 说明
      const p = {
        key: s.dataKey || s.key,
        label: s.label || s.key,
        ctl: s.ctl,
        type: s.type || (s.ctl === 'number' ? 'number' : s.ctl === 'bool' ? 'bool' : 'string')
      };
      if(s.default !== undefined) p.default = (typeof s.default === 'function') ? s.default() : s.default;
      if(s.options) p.options = s.options.map(o => o[0]);
      if(s.min !== undefined) p.min = s.min;
      if(s.max !== undefined) p.max = s.max;
      params.push(p);
    });
    types[type] = {
      title: d.title,
      group: NODE_GROUP_OF[type] || '',
      desc: d.desc,
      pure: !!d.pure,
      execIn: !!d.execIn,
      execOut: d.execOut || [],
      execOutFrom: d.execOutFrom || '',
      inputs: (d.inputs || []).map(k => ({ key: k, type: PIN_META[k] ? PIN_META[k].type : 'string', label: PIN_META[k] ? PIN_META[k].label : k })),
      outputs: (d.outputs || []).map(k => ({ key: k, type: PIN_META[k] ? PIN_META[k].type : 'string', label: PIN_META[k] ? PIN_META[k].label : k })),
      params,
      tips,
      note: rule.note || '',
      required: rule.required || []
    };
  });
  return { app: 'openagi', version: 1, types };
}

/* DAG JSON 规范：生成器的输出契约，也是 installGeneratedFlow 的输入契约 */
function dagSpec(){
  return {
    root: {
      name: 'string · 工作流名称',
      nodes: 'Node[] · 节点列表',
      links: 'Link[] · 连线列表',
      vars: 'Var[]? · 可选，变量列表（varGet / varSet 用）'
    },
    node: {
      id: 'string · 自定义，全局唯一（如 n1）',
      type: 'string · 节点类型，见节点目录',
      x: 'number · 画布横坐标（左→右每隔 300）',
      y: 'number · 画布纵坐标（同列每隔 140）',
      data: 'object · 节点参数与动态列表（见各节点 note；缺省值会自动补）',
      params: '{id,name,type,value}[]? · 仅 start / end 用，type 限 int/float/string/bool/image/model'
    },
    link: {
      id: 'string · 自定义，全局唯一（如 l1）',
      from: '{node,key} · 起点节点 id 与输出引脚 key',
      to: '{node,key} · 终点节点 id 与输入引脚 key'
    },
    var: { id: 'string · 自定义（如 v1）', name: 'string · 变量名', type: 'int|float|string|bool|image|model' }
  };
}

/* ---------------------------------------------------------------
 * 四、生成器系统提示词：契约 + DAG 规范 + 硬规则
 * -------------------------------------------------------------- */
function buildGenSystemPrompt(){
  const c = nodeContract();
  const lines = [];
  lines.push('你是 Open AGI 工作流搭建助手：把用户的自然语言需求转换成一份工作流 JSON。');
  lines.push('');
  lines.push('## 输出格式');
  lines.push('只输出一个 JSON 对象，不要输出 JSON 之外的任何文字（不要解释、不要客套）：');
  lines.push('{ "name": "工作流名称", "nodes": [节点...], "links": [连线...], "vars": [变量...] }');
  lines.push('- nodes: [{ "id":"n1", "type":"节点类型", "x":60, "y":60, "data":{...}, "params":[...] }]');
  lines.push('  data 放该节点的参数与动态列表（见各节点说明），省略的字段会自动补默认值；start / end 用 params 而不是 data。');
  lines.push('- links: [{ "id":"l1", "from":{"node":"n1","key":"输出引脚key"}, "to":{"node":"n2","key":"输入引脚key"} }]');
  lines.push('  静态引脚用引脚名（如 prompt / image / exec / true / false）；动态引脚用条目 id。');
  lines.push('- vars: [{ "id":"v1", "name":"变量名", "type":"类型" }]，只有用到 varGet / varSet 时才需要。');
  lines.push('');
  lines.push('## 硬性规则（违反任何一条都算失败，会带错误反馈重试）');
  lines.push('1. 必须恰好一个 start（任务开始）；至少有一个 end（任务结束）或 result（结果输出）。');
  lines.push('2. 执行线连接：start 的 exec 出口连到第一个执行节点的 exec 入口，之后每个执行节点串下去；数据线不要接 exec 引脚。');
  lines.push('3. 数据线两端类型必须一致（int 可接 float，其余必须相同）；from 必须是输出引脚，to 必须是输入引脚。');
  lines.push('4. 只能使用下面节点目录里列出的引脚，不要发明引脚或节点类型。');
  lines.push('5. 提示词 / 指令写成具体可执行的中文，不要留空、不要写「待定」「示例」。');
  lines.push('6. 流程保持最小：3–8 个节点，只放完成需求所必需的环节。');
  lines.push('7. 需求信息不足以搭建时（缺输入来源 / 缺产出目标 / 有实质歧义），不要猜：输出 { "questions": ["问题1", "问题2"] }。');
  lines.push('');
  lines.push('## 节点目录');
  Object.keys(c.types).forEach(type => {
    const t = c.types[type];
    const head = '### ' + type + ' · ' + t.title + (t.group ? '（' + t.group + '）' : '');
    const body = [];
    body.push(t.desc);
    if(t.pure) body.push('参数节点：不被执行线激活，被下游连线引用时才求值。');
    if(t.execIn) body.push('执行入口：exec（必须接一条执行线才会运行）。');
    if(t.execOut.length) body.push('执行出口：' + t.execOut.join(' / '));
    if(t.execOutFrom) body.push('执行出口为动态条目（' + t.execOutFrom + '），每条一个出口。');
    if(t.inputs.length) body.push('数据输入：' + t.inputs.map(p => p.key + '(' + p.label + ':' + p.type + ')').join('、'));
    if(t.outputs.length) body.push('数据输出：' + t.outputs.map(p => p.key + '(' + p.label + ':' + p.type + ')').join('、'));
    if(t.params.length) body.push('参数：' + t.params.map(p => {
      let s = p.key + '(' + p.label + '，' + (CTL_DESC[p.ctl] || p.ctl);
      if(p.default !== undefined) s += '，默认 ' + JSON.stringify(p.default);
      if(p.options) s += '，可选 ' + p.options.map(o => JSON.stringify(o)).join('/');
      return s + ')';
    }).join('；'));
    if(t.note) body.push('说明：' + t.note);
    if(t.required.length) body.push('必填参数：' + t.required.join('、'));
    lines.push(head);
    body.forEach(b => lines.push(b));
    lines.push('');
  });
  return lines.join('\n');
}

/* ---------------------------------------------------------------
 * 五、JSON 提取与自动布局
 * -------------------------------------------------------------- */
function extractJson(text){
  const s = String(text == null ? '' : text).trim();
  if(!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cands = fence ? [fence[1].trim(), s] : [s];
  for(const t of cands){
    try { const v = JSON.parse(t); if(v && typeof v === 'object') return v; } catch(e){}
    const m = t.match(/\{[\s\S]*\}/);
    if(m){ try { const v = JSON.parse(m[0]); if(v && typeof v === 'object') return v; } catch(e){} }
  }
  return null;
}

/* 分层自动布局：按「入边最长路径」定层，同层纵向排开。
   只用于 LLM 没给坐标（或坐标明显不合理）时的兜底。 */
function autoLayout(nodes, links){
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });
  const depth = {};
  const guard = new Set();
  const calc = (n, chain) => {
    if(depth[n.id] !== undefined) return depth[n.id];
    if(guard.has(n.id)) return 0;               // 理论上校验已拦过环图，这里防死循环
    guard.add(n.id);
    const preds = links.filter(l => l.to.node === n.id && byId[l.from.node]).map(l => byId[l.from.node]);
    const d = preds.length ? Math.max(...preds.map(p => calc(p, chain))) + 1 : 0;
    guard.delete(n.id);
    depth[n.id] = d;
    return d;
  };
  nodes.forEach(n => calc(n, new Set()));
  const perLayer = {};
  nodes.forEach(n => {
    const d = depth[n.id] || 0;
    perLayer[d] = (perLayer[d] || 0) + 1;
    n.x = 60 + d * 300;
    n.y = 60 + (perLayer[d] - 1) * 140;
  });
  return nodes;
}
