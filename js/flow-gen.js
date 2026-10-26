/* 自然语言 → 工作流生成（P0 · 自主搭建基础设施第三层）
 *
 * 流程：用户需求 → LLM（系统提示词 = 节点契约）→ JSON → 规范化 → 静态校验
 *        → 有错就把错误清单回馈给模型重试（有限次）→ 通过后交给 UI 人工确认 → 落盘
 *
 * 设计约束：
 *   - 这里不直接调 LLM：ask(sys, user) 由调用方注入（UI 传入流式实现，测试传入 mock）
 *   - 生成的流程**绝不自动落盘**：installGeneratedFlow 只能由用户点「确认创建」触发
 *   - 规范化时用 seedNodeData 补齐默认值，保证生成节点与手工添加的节点完全同形
 */

// 参数值按类型收敛（与 desktop.js 的 paramValue / coerceVar 口径一致）
function coerceByType(type, v){
  if(type === 'int') return Math.trunc(Number(v) || 0);
  if(type === 'float') return Number(v) || 0;
  if(type === 'bool') return v === true || v === 'true' || v === 1 || v === '1' || v === '是';
  if(type === 'string') return v == null ? '' : String(v);
  return v == null ? '' : v;
}
const VAR_TYPES = ['int', 'float', 'string', 'bool', 'image', 'model'];
const TASK_IN_TYPES = ['string', 'int', 'float', 'bool', 'image'];

function clampPick(v, list, fallback){
  return list.indexOf(v) >= 0 ? v : fallback;
}

/* 把 LLM 输出的 DAG 规范成与手工搭建完全一致的 flow 对象。
   结构性问题（不是对象、没有节点、类型未知）直接抛错，交给生成器当反馈重试。 */
function normalizeDag(dag){
  if(!dag || typeof dag !== 'object' || Array.isArray(dag)) throw new Error('输出不是 JSON 对象');
  const rawNodes = Array.isArray(dag.nodes) ? dag.nodes : null;
  if(!rawNodes || !rawNodes.length) throw new Error('输出里没有 nodes 列表');
  const notes = [];

  // ---- 变量表先建：varGet / varSet 的引脚依赖它 ----
  const vars = (Array.isArray(dag.vars) ? dag.vars : []).map((v, i) => {
    const o = v && typeof v === 'object' ? v : {};
    return {
      id: (typeof o.id === 'string' && o.id) ? o.id : ('v' + (i + 1)),
      name: o.name != null && String(o.name).trim() ? String(o.name).trim() : '变量' + (i + 1),
      type: clampPick(o.type, VAR_TYPES, 'string'),
      value: '',
      fileName: ''
    };
  });
  if(vars.length){
    const seen = new Set();
    vars.forEach(v => { while(seen.has(v.id)) v.id = v.id + '_'; seen.add(v.id); });
  }

  // ---- 节点 ----
  const usedNodeIds = new Set();
  const nodes = rawNodes.map((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : {};
    if(!NODE_DEFS[r.type]) throw new Error('第 ' + (i + 1) + ' 个节点的类型「' + r.type + '」不存在');
    const seed = seedNodeData(r.type);
    const n = {
      id: (typeof r.id === 'string' && r.id) ? r.id : ('n' + (i + 1)),
      type: r.type,
      x: Number.isFinite(Number(r.x)) ? Math.round(Number(r.x)) : null,
      y: Number.isFinite(Number(r.y)) ? Math.round(Number(r.y)) : null,
      data: Object.assign({}, seed.data),
      out: {}, status: ''
    };
    if(seed.params) n.params = seed.params;

    const data = (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data : {};
    Object.keys(data).forEach(k => {
      if(k === 'inputs' || k === 'outputs' || k === 'views' || k === 'branches' || k === 'params' || k === 'varId') return;
      n.data[k] = data[k];
    });

    // 动态引脚列表：LLM 给了就整表替换（不能和种子的默认列表混在一起）
    if(r.type === 'aiTask'){
      const norm = (list, typeList, fallbackName) => (Array.isArray(list) ? list : []).map((p, j) => {
        const o = p && typeof p === 'object' ? p : {};
        return {
          id: (typeof o.id === 'string' && o.id) ? o.id : uid(),
          name: o.name != null && String(o.name).trim() ? String(o.name).trim() : fallbackName + (j + 1),
          type: clampPick(o.type, typeList, 'string')
        };
      });
      if(Array.isArray(data.inputs)) n.data.inputs = norm(data.inputs, TASK_IN_TYPES, '输入');
      if(Array.isArray(data.outputs)) n.data.outputs = norm(data.outputs, TASK_OUT_TYPES, '结果');
    }
    if(r.type === 'imageSplit' && Array.isArray(data.views)){
      // 条目 id 必须原样保留：连线是按 id 引用动态引脚的，换成新 id 会全部断开
      n.data.views = data.views.map((v, j) => {
        const o = v && typeof v === 'object' ? v : {};
        return {
          id: (typeof o.id === 'string' && o.id) ? o.id : uid(),
          name: o.name != null && String(o.name).trim() ? String(o.name).trim() : '视图' + (j + 1),
          hint: o.hint ? String(o.hint) : ''
        };
      });
    }
    if(r.type === 'aiBranch' && Array.isArray(data.branches)){
      n.data.branches = data.branches.map((b, j) => {
        const o = b && typeof b === 'object' ? b : {};
        return {
          id: (typeof o.id === 'string' && o.id) ? o.id : uid(),
          name: o.name != null && String(o.name).trim() ? String(o.name).trim() : '出口' + (j + 1),
          hint: o.hint ? String(o.hint) : '',
          fallback: o.fallback === true
        };
      });
    }
    if(r.type === 'modelViews' && Array.isArray(data.params)){
      (n.data.params || []).forEach(p => {
        const hit = data.params.find(x => x && (x.name === p.name || x.id === p.id));
        if(!hit) return;
        if(hit.value !== undefined) p.value = coerceByType(p.type, hit.value);
        if(typeof hit.id === 'string' && hit.id) p.id = hit.id;   // 保留引用 id，避免连线断开
      });
    }
    if(r.type === 'varGet' || r.type === 'varSet'){
      const vid = data.varId != null ? String(data.varId) : '';
      if(vid && !vars.some(v => v.id === vid)){
        vars.push({ id: vid, name: vid, type: 'string', value: '', fileName: '' });
        notes.push('变量 ' + vid + ' 已补建（模型引用了未声明的变量）');
      }
      n.data.varId = vid;
    }

    // start / end 的参数表（data 之外的一等公民）
    if(r.type === 'start' || r.type === 'end'){
      const list = Array.isArray(r.params) ? r.params : (Array.isArray(data.params) ? data.params : []);
      n.params = list.map((p, j) => {
        const o = p && typeof p === 'object' ? p : {};
        const type = clampPick(o.type, VAR_TYPES, 'string');
        return {
          id: (typeof o.id === 'string' && o.id) ? o.id : uid(),
          name: o.name != null && String(o.name).trim() ? String(o.name).trim() : '参数' + (j + 1),
          type,
          value: coerceByType(type, o.value),
          fileName: ''
        };
      });
    }

    if(usedNodeIds.has(n.id)){ const fresh = uid(); notes.push('节点 id「' + n.id + '」重复，已改为 ' + fresh); n.id = fresh; }
    usedNodeIds.add(n.id);
    return n;
  });

  // ---- 连线 ----
  const links = (Array.isArray(dag.links) ? dag.links : [])
    .filter(l => l && typeof l === 'object' && l.from && l.to)
    .map((l, i) => ({
      id: (typeof l.id === 'string' && l.id) ? l.id : ('l' + (i + 1)),
      from: { node: String(l.from.node || ''), key: String(l.from.key || '') },
      to: { node: String(l.to.node || ''), key: String(l.to.key || '') }
    }));

  // ---- 布局：缺坐标就整体自动排版 ----
  const needLayout = nodes.some(n => n.x === null || n.y === null || n.x < 0 || n.y < 0);
  if(needLayout){
    nodes.forEach(n => { if(n.x === null || n.x < 0) n.x = 0; if(n.y === null || n.y < 0) n.y = 0; });
    autoLayout(nodes, links);
    notes.push('部分节点缺少坐标，已自动排版');
  }

  const flow = {
    name: (dag.name != null && String(dag.name).trim()) ? String(dag.name).trim().slice(0, 40) : 'AI 生成的工作流',
    nodes, links, vars, frames: []
  };
  return { flow, notes };
}

/* 生成主流程。返回：
 *   { ok:true, flow, warnings, notes, attempts }
 *   { ok:false, questions:[...] }                 —— 需求不清，模型反问
 *   { ok:false, error, errors:[...], attempts }    —— 重试用尽仍未通过
 * ask(sys, user, {attempt}) → Promise<string>
 */
async function generateFlowDag(nl, opts){
  const o = opts || {};
  const ask = o.ask;
  if(typeof ask !== 'function') throw new Error('缺少 LLM 调用函数');
  const text = String(nl == null ? '' : nl).trim();
  if(!text) throw new Error('请先描述需求');
  const retries = o.retries == null ? 2 : Math.max(0, Math.trunc(Number(o.retries) || 0));
  const sys = buildGenSystemPrompt();
  let feedback = '';
  let lastErrors = [];
  let lastError = '';

  for(let attempt = 0; attempt <= retries; attempt++){
    const user = '用户需求：' + text
      + (feedback ? '\n\n上一次输出没通过校验，请修正后重新输出完整 JSON（不要只输出改动部分）：\n' + feedback : '');
    const raw = await ask(sys, user, { attempt });
    const dag = extractJson(raw);
    if(!dag){ feedback = '- 无法从输出里解析出 JSON 对象（必须输出一个 JSON 对象）'; lastError = '无法解析 JSON'; continue; }
    if(Array.isArray(dag.questions) && dag.questions.length){
      const qs = dag.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 5);
      if(qs.length) return { ok: false, questions: qs, attempts: attempt + 1 };
    }
    let norm = null;
    try { norm = normalizeDag(dag); }
    catch(e){ feedback = '- ' + (e && e.message ? e.message : String(e)); lastError = feedback.slice(2); continue; }
    const v = validateFlow(norm.flow);
    if(v.errors.length){
      lastErrors = v.errors;
      lastError = validateSummary(v);
      feedback = v.errors.slice(0, 12).map(e => '- ' + e.message).join('\n');
      continue;
    }
    return { ok: true, flow: norm.flow, warnings: v.warnings, notes: norm.notes, attempts: attempt + 1 };
  }
  return { ok: false, error: '生成未通过校验：' + (lastError || '未知原因'), errors: lastErrors, attempts: retries + 1 };
}

/* 用户确认后才调用：写入 FLOWS 并打开。openFlow 里会深拷贝，所以这里不担心后续编辑污染。 */
function installGeneratedFlow(res){
  if(!res || !res.ok || !res.flow) throw new Error('没有可创建的工作流');
  const flow = JSON.parse(JSON.stringify(res.flow));
  flow.id = uid();
  flow.updated = Date.now();
  flow.lastRun = null;
  flow.vars = Array.isArray(flow.vars) ? flow.vars : [];
  flow.links = Array.isArray(flow.links) ? flow.links : [];
  flow.frames = [];
  const seen = new Set();
  flow.nodes.forEach(n => { while(seen.has(n.id)) n.id = uid(); seen.add(n.id); });
  FLOWS.unshift(flow);
  if(!persistFlows()) throw new Error('工作流保存失败（本地存储可能已满），请先导出备份再重试');
  if(typeof openFlow === 'function') openFlow(flow.id);
  return flow;
}

/* 预览文案：给确认弹层用，让人一眼看懂要建什么 */
function describeFlow(flow){
  const nodes = (flow && flow.nodes) || [];
  const links = (flow && flow.links) || [];
  const count = {};
  nodes.forEach(n => { count[n.type] = (count[n.type] || 0) + 1; });
  return {
    title: (flow && flow.name) || 'AI 生成的工作流',
    stats: nodes.length + ' 节点 · ' + links.length + ' 连线',
    types: Object.keys(count).map(t => (NODE_DEFS[t] ? NODE_DEFS[t].title : t) + ' × ' + count[t]),
    params: nodes.filter(n => n.type === 'start').reduce((s, n) => s + ((n.params || []).length), 0),
    outs: nodes.filter(n => n.type === 'end' || n.type === 'result').length
  };
}
