/* 轨迹 → 工作流（P3 · 确定性编译，**不过 LLM**）
 *
 * 这是整条链上最容易做错的一步，所以先把「不做」写清楚：
 *
 *   ✗ 不重新让模型生成一遍流程。
 *     重新生成会把刚才真正调通的参数（模型名、尺寸、重绘强度、参考图）全部丢掉，
 *     产出一张「看起来像」但跑不出同样结果的图 —— 那就等于什么都没固化。
 *
 *   ✓ 只做**搬移与规范化**：把轨迹里已经发生的事实映射成节点与连线，
 *     交给 normalizeDag 补默认值、validateFlow 校验、installGeneratedFlow 安装。
 *     同一份轨迹编译两次，结果必须完全一致（有测试守这条）。
 *
 * 两个刻意的取舍：
 *   1. 提示词做成「任务开始」的**参数**，默认值 = 这次真正生效的那句。
 *      这样流程既能原样重跑（默认值就是它），又能改词复用（参数可传）。
 *      做成固定 text 节点的话，这张图就只能永远出这一张。
 *   2. 参考图落到「图像输入」节点里。用户能换图，流程体积也不会因为把图塞进参数表而膨胀。
 *
 * 映射不到的步骤（联网搜索、纯对话）**明确列在 skipped 里**，不静默丢弃 ——
 * 用户得知道「存下来的流程少了什么」。
 */

const TRACE_CAP_NODE = {
  imageGen:  { node:'imageGen',  outPin:'image', promptPin:'prompt', refPin:'image', label:'出图' },
  imageEdit: { node:'imageGen',  outPin:'image', promptPin:'prompt', refPin:'image', label:'改图' },
  /* 「3D 生成」没有 prompt 引脚（它是图生 3D，只有 image 输入），
   * 所以 promptPin 留空 —— 照着 others 抄一个 'prompt' 上去，校验会直接判引脚不存在。 */
  model3d:   { node:'model3d',   outPin:'model', promptPin:'',       refPin:'image', label:'图生 3D' }
};

function traceCapSupported(cap){ return !!TRACE_CAP_NODE[cap]; }

function tracePromptOf(step){
  const i = (step && step.inputs) || {};
  const raw = i.prompt != null ? i.prompt : (i.text != null ? i.text : '');
  return String(raw == null ? '' : raw).trim();
}

/* 编译。events 是 traceList().events；返回 installGeneratedFlow 可直接吃的形状：
 *   { ok:true, flow, warnings, notes, skipped, steps }
 *   { ok:false, error, skipped }
 */
function flowFromTrace(events, opts){
  const o = opts || {};
  const all = Array.isArray(events) ? events.filter(e => e && typeof e === 'object') : [];
  const skipped = [];
  const usable = [];
  all.forEach(e => {
    if(!e.ok){
      skipped.push({ cap:e.cap, why:'这次调用失败了，不写进流程' });
      return;
    }
    if(!traceCapSupported(e.cap)){
      skipped.push({ cap:e.cap, why:'这类能力还没有对应的节点' });
      return;
    }
    usable.push(e);
  });

  if(!usable.length){
    return {
      ok: false,
      error: '这一轮没有可固化的能力调用（目前只编译成功的出图 / 3D 生成）',
      skipped
    };
  }

  const notes = [];
  const nodes = [];
  const links = [];
  let linkSeq = 0;
  const link = (fromNode, fromKey, toNode, toKey) => {
    links.push({ id: 'l' + (++linkSeq), from: { node: fromNode, key: fromKey }, to: { node: toNode, key: toKey } });
  };

  /* ---- 起点：提示词做成参数，默认值取这次真正生效的那句 ---- */
  const prompts = [];
  usable.forEach(e => {
    const p = tracePromptOf(e);
    if(p && prompts.indexOf(p) < 0) prompts.push(p);
  });
  const startParams = prompts.map((p, i) => ({
    id: 'p' + (i + 1),
    name: i === 0 ? '提示词' : '提示词' + (i + 1),
    type: 'string',
    value: p
  }));
  const startId = 'n_start';
  nodes.push({ id: startId, type: 'start', params: startParams.map(x => Object.assign({}, x)), data: {} });
  if(!startParams.length){
    notes.push('轨迹里没有取到提示词，流程只保留了能力步骤（重跑时要自己填）');
  }

  /* ---- 参考图：整轮共用一张输入节点，避免重复 ---- */
  let refNodeId = '';
  const refOf = usable.find(e => {
    const r = (e.inputs || {}).ref;
    return r && String(r).trim();
  });
  if(refOf){
    const ref = String(refOf.inputs.ref).trim();
    refNodeId = 'n_ref';
    nodes.push({ id: refNodeId, type: 'imageIn', data: { image: ref } });
    notes.push('参考图已存进「图像输入」节点，换图不用改参数');
  }

  /* ---- 能力步骤依次串成执行链 ---- */
  let prevExec = startId;
  let lastGen = null;
  usable.forEach((e, i) => {
    const m = TRACE_CAP_NODE[e.cap];
    const id = 'n_g' + (i + 1);
    const p = tracePromptOf(e);
    const data = {};
    if(m.promptPin && p) data[m.promptPin] = p;
    /* 能就地填的参数一起带过去，少一条连线就少一处出错的机会 */
    const ins = e.inputs || {};
    if(ins.denoise != null && e.cap === 'imageGen') data.denoise = ins.denoise;
    if(ins.size) data.size = ins.size;
    if(ins.views && e.cap === 'model3d') data.views = ins.views;
    nodes.push({ id, type: m.node, data });

    link(prevExec, 'exec', id, 'exec');
    prevExec = id;
    lastGen = id;

    /* 提示词优先走参数连线（可改词复用）；这句没进参数表才退回就地填写 */
    const pIdx = prompts.indexOf(p);
    if(m.promptPin && p && pIdx >= 0) link(startId, 'p' + (pIdx + 1), id, m.promptPin);
    if(refNodeId && m.refPin) link(refNodeId, 'image', id, m.refPin);
  });

  /* ---- 收尾：最后一步的产物接到「结果输出」 ---- */
  const lastMod = TRACE_CAP_NODE[usable[usable.length - 1].cap];
  const resultId = 'n_out';
  nodes.push({ id: resultId, type: 'result', data: {} });
  link(prevExec, 'exec', resultId, 'exec');
  link(lastGen, lastMod.outPin, resultId, lastMod.outPin);

  if(usable.length > 1){
    notes.push('这一轮有 ' + usable.length + ' 个能力步骤，按发生顺序串成一条链；只有最后一步接到结果输出');
  }

  const head = prompts[0] || (TRACE_CAP_NODE[usable[0].cap].label + '流程');
  const dag = {
    name: ('对话沉淀 · ' + head).slice(0, 40),
    nodes,
    links,
    vars: []
  };

  /* ---- 走与生成器完全相同的收尾路径：规范化 → 校验 ---- */
  let norm;
  try { norm = normalizeDag(dag); }
  catch(e){ return { ok: false, error: '轨迹编译失败：' + ((e && e.message) || String(e)), skipped }; }

  const v = validateFlow(norm.flow);
  if(v.errors.length){
    return { ok: false, error: '编译出的流程没通过校验：' + validateSummary(v), errors: v.errors, skipped };
  }
  return {
    ok: true,
    flow: norm.flow,
    warnings: v.warnings,
    notes: notes.concat(norm.notes || []),
    skipped,
    steps: usable.length
  };
}

/* 给 UI 的一句话判断：这一轮值不值得存成流程。
 * 不做成「自动保存」——生成的东西一律要人点确认（和 flow-gen 同一条规矩）。 */
function traceFlowHint(list, summary){
  const s = summary || traceSummary(list);
  const usable = (s.byCap && (s.byCap.imageGen || 0) + (s.byCap.imageEdit || 0) + (s.byCap.model3d || 0)) || 0;
  if(!usable) return { worthy: false, reason: '这一轮没有可固化的出图 / 3D 步骤' };
  if(s.failCount > 0) return { worthy: true, reason: '有 ' + usable + ' 个步骤可固化（其中 ' + s.failCount + ' 次尝试失败过，建议先确认结果）' };
  return { worthy: true, reason: '有 ' + usable + ' 个步骤可固化' };
}
