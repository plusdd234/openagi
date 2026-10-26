/* 节点注册表与引脚 schema（架构改良 A + B）
 *
 * 目标：**一个节点 = 一个描述符 + 一次注册**。声明、参数形态、默认值、动态引脚、校验规则、
 * 执行逻辑都写在描述符里，registerNode 负责把它们填进 NODE_DEFS / NODE_PARAMS / NODE_LIB
 * 与各分发表；引脚解析只有这一份实现（schema），编辑器、校验器、生成器都调它。
 *
 * 依赖：blueprint-core.js 的 NODE_DEFS / NODE_PARAMS / NODE_LIB（空容器）、PIN_META、uid。
 * 纯逻辑、零 DOM（渲染由 desktop.js 调 pinsForRender 拿数据自己画）。
 */

const NODE_REGISTRY = {};
const NODE_SEEDS = {};
const NODE_RUNNERS = {};
const NODE_VALIDATORS = {};
const NODE_NORMALIZERS = {};

// 块级控件：不生成引脚、由专门的区块渲染
const BLOCK_CTL = { paramList:1, filePick:1, taskPins:1, viewPins:1, branchPins:1, inPins:1 };

/* 注册一个节点。d 的字段：
 *   type / title / desc / dot / group / execIn / execOut / execOutFrom / pure
 *   inputs / outputs      固定数据引脚（key 名，类型查 PIN_META）
 *   params                NODE_PARAMS 声明（参数形态唯一来源）
 *   seed()                → { data, params }，默认值唯一来源
 *   pins(n, vars)         → { in:[{key,label,type,kind?}], out:[...] } 动态引脚（解析用）
 *   render                { in:false, out:false } 指定动态引脚不进列（默认都进）
 *   run(ctx)              → 执行逻辑（取代 executeNode 里的 if 分支）
 *   validate(n, ctx)      → [{ code, message }] 节点特有的告警
 *   normalize(raw, n, h)  → 生成器规范化时的节点特有处理（h 提供 uid/clampPick 等）
 */
function registerNode(d){
  if(!d || !d.type) throw new Error('registerNode: 缺少 type');
  if(NODE_REGISTRY[d.type]) throw new Error('registerNode: 「' + d.type + '」重复注册');
  NODE_REGISTRY[d.type] = d;
  NODE_DEFS[d.type] = {
    title: d.title || d.type,
    dot: d.dot || 'logic',
    desc: d.desc || '',
    inputs: (d.inputs || []).slice(),
    outputs: (d.outputs || []).slice(),
    execIn: !!d.execIn,
    execOut: (d.execOut || []).slice(),
    execOutFrom: d.execOutFrom || '',
    pure: !!d.pure
  };
  NODE_PARAMS[d.type] = d.params || [];
  if(d.seed) NODE_SEEDS[d.type] = d.seed;
  if(d.run) NODE_RUNNERS[d.type] = d.run;
  if(d.validate) NODE_VALIDATORS[d.type] = d.validate;
  if(d.normalize) NODE_NORMALIZERS[d.type] = d.normalize;
  if(d.group){
    let g = NODE_LIB.find(x => x.group === d.group);
    if(!g){ g = { group: d.group, types: [] }; NODE_LIB.push(g); }
    if(g.types.indexOf(d.type) < 0) g.types.push(d.type);
  }
  return d.type;
}

function nodeDesc(type){ return NODE_REGISTRY[type] || null; }
function nodeRunner(type){ return NODE_RUNNERS[type] || null; }
function nodeNormalizer(type){ return NODE_NORMALIZERS[type] || null; }
function seedNodeData(type){
  const f = NODE_SEEDS[type];
  const s = f ? f() : null;
  return s || { data: {}, params: null };
}

/* 默认值构造小工具：节点 seed() 与老流程迁移共用 */
function seedPin(name, type){ return { id: uid(), name, type }; }
function seedParam(name, type, value){ return { id: uid(), name, type, value: value, fileName: '' }; }
function seedView(name, hint){ return { id: uid(), name: name || '视图', hint: hint || '' }; }
function seedBranch(name, hint){ return { id: uid(), name: name || '出口', hint: hint || '', fallback: false }; }

/* ---------------------------------------------------------------
 * Schema：引脚解析（唯一真源）
 * 顺序：执行引脚 → 静态数据引脚 → 描述符的动态引脚 → 参数引脚
 * 返回 { key, label, type, dir, kind } 或 null（引脚不存在）
 * -------------------------------------------------------------- */
function specPinType(spec){
  if(!spec) return 'string';
  if(spec.type) return spec.type;
  if(spec.ctl === 'number') return 'float';
  if(spec.ctl === 'bool') return 'bool';
  return 'string';
}
// 参数引脚的 key：有参数对象（store:'param' / 起止节点）时用对象 id，否则用 dataKey/key
function paramPinType(n, spec){
  if(spec && spec.store === 'param' && n.data && Array.isArray(n.data.params)){
    const p = n.data.params.find(x => x.name === spec.key);
    if(p && p.type) return p.type;
  }
  return specPinType(spec);
}
function paramPinKey(n, spec){
  if(!spec) return '';
  const obj = (spec.store === 'param' && n.data && Array.isArray(n.data.params))
    ? (n.data.params.find(p => p.name === spec.key) || null)
    : null;
  return obj ? obj.id : (spec.dataKey || spec.key);
}
function paramPinSpec(n, key){
  const specs = NODE_PARAMS[n.type] || [];
  for(const s of specs){
    if(s.tip || BLOCK_CTL[s.ctl]) continue;
    if(paramPinKey(n, s) === key) return s;
  }
  return null;
}

function pinMetaOf(n, key, vars){
  if(!n || !n.type || !key) return null;
  const d = NODE_DEFS[n.type] || {};
  const desc = NODE_REGISTRY[n.type] || {};

  // 1) 执行引脚（声明在 execIn / execOut / execOutFrom 上）
  if(key === 'exec'){
    const isIn = !!d.execIn, isOut = (d.execOut || []).indexOf('exec') >= 0;
    if(isIn || isOut) return { key, label:'执行', type:'exec', dir: isIn && isOut ? 'both' : (isIn ? 'in' : 'out') };
    return null;
  }
  if((d.execOut || []).indexOf(key) >= 0){
    return { key, label: key === 'true' ? '真' : key === 'false' ? '假' : key, type:'exec', dir:'out' };
  }
  if(d.execOutFrom){
    const hit = (((n.data || {})[d.execOutFrom]) || []).find(b => b.id === key);
    if(hit) return { key, label: hit.name || '出口', type:'exec', dir:'out' };
  }

  // 2) 静态数据引脚
  const dIn = (d.inputs || []).indexOf(key) >= 0;
  const dOut = (d.outputs || []).indexOf(key) >= 0;
  if(dIn || dOut){
    const m = PIN_META[key] || {};
    return { key, label: m.label || key, type: m.type || 'string', dir: dIn && dOut ? 'both' : (dIn ? 'in' : 'out') };
  }

  // 3) 描述符声明的动态引脚
  if(typeof desc.pins === 'function'){
    const dyn = desc.pins(n, vars) || {};
    const inHit = (dyn.in || []).find(p => p.key === key);
    if(inHit) return { key, label: inHit.label || inHit.name || key, type: inHit.type || 'string', dir:'in', kind: inHit.kind, dynamic:true };
    const outHit = (dyn.out || []).find(p => p.key === key);
    if(outHit) return { key, label: outHit.label || outHit.name || key, type: outHit.type || 'string', dir:'out', kind: outHit.kind, dynamic:true };
  }

  // 4) 参数引脚（可就地填写的那种）
  const spec = paramPinSpec(n, key);
  if(spec) return { key, label: spec.label || key, type: paramPinType(n, spec), dir:'in', kind:'param', spec };

  return null;
}

function pinTypeOf(n, key, vars){
  const m = pinMetaOf(n, key, vars);
  return m ? m.type : null;
}
function pinDirOf(n, key, vars){
  const m = pinMetaOf(n, key, vars);
  return m ? m.dir : null;
}
function pinExists(n, key, vars){ return pinMetaOf(n, key, vars) !== null; }

/* 动态执行出口：execOutFrom 指向 node.data 上的列表，每条一个出口 */
function execPinsOf(n){
  const d = NODE_DEFS[(n && n.type) || ''] || {};
  if(!d.execOutFrom) return [];
  return ((((n.data || {})[d.execOutFrom]) || [])).map(b => ({ id:b.id, name:b.name, type:'exec' }));
}

/* 渲染用：按显示顺序给出两侧引脚（动态优先 → 静态 → 参数），带 kind 供 UI 选择画法 */
function pinsForRender(n, vars){
  if(!n || !n.type) return { in: [], out: [] };
  const d = NODE_DEFS[n.type] || {};
  const desc = NODE_REGISTRY[n.type] || {};
  const dyn = (typeof desc.pins === 'function' ? (desc.pins(n, vars) || {}) : {});
  const render = desc.render || {};
  const ins = [], outs = [];
  const specs = NODE_PARAMS[n.type] || [];

  // 输入侧：动态引脚（起止节点参数也走这里）→ 静态引脚 → 参数引脚（控件挂在同行）
  if(render.in !== false){
    (dyn.in || []).forEach(p => ins.push(Object.assign({}, p, { label:p.label || p.name || p.key, type:p.type || 'string' })));
  }
  (d.inputs || []).forEach(k => {
    const m = PIN_META[k] || {};
    ins.push({ key:k, label:m.label || k, type:m.type || 'string', kind:'data' });
  });
  specs.forEach(s => {
    if(s.tip || BLOCK_CTL[s.ctl] || s.side === 'out') return;
    const key = paramPinKey(n, s);
    const i = ins.findIndex(p => p.key === key);
    if(i >= 0){ ins[i] = Object.assign({}, ins[i], { kind:'param', spec: s }); return; }
    ins.push({ key, label: s.label || s.key, type: paramPinType(n, s), kind:'param', spec: s });
  });

  // 输出侧：动态引脚 → 静态引脚（side:'out' 的参数控件跟着输出引脚渲染）
  if(render.out !== false){
    (dyn.out || []).forEach(p => outs.push(Object.assign({}, p, { label:p.label || p.name || p.key, type:p.type || 'string' })));
  }
  (d.outputs || []).forEach(k => {
    const m = PIN_META[k] || {};
    const spec = specs.find(s => (s.dataKey || s.key) === k && s.side === 'out');
    outs.push({ key:k, label:m.label || k, type: spec ? specPinType(spec) : (m.type || 'string'), kind: spec ? 'param' : 'data', spec });
  });

  return { in: ins, out: outs };
}
