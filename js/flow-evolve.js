/* 流程变异与 A/B 试跑（P1 · 自我迭代的第一个闭环）
 *
 * 「变异」只改自然语言参数（提示词 / 指令 / 文本），不动节点与连线 ——
 * 结构由 P0 的生成器负责，这里做的是在结构不变的前提下找更好的措辞。
 *
 * compareVariants 的 runner 由调用方注入：
 *   UI 传入「临时 bp + runFlow」的真实执行，测试传入构造好的假结果。
 *   这样 A/B 的全部编排逻辑（逐个跑、收集指标、选优）都能被离线验证。
 */

// 真正影响输出的自然语言字段
const MUTABLE_KEYS = ['instruction', 'prompt', 'text'];

/* 收集流程里所有可改的文本参数 */
function collectTextTargets(flow){
  const out = [];
  ((flow && flow.nodes) || []).forEach(n => {
    const data = n.data || {};
    MUTABLE_KEYS.forEach(k => {
      if(typeof data[k] === 'string' && data[k].trim()){
        out.push({
          nodeId: n.id,
          type: n.type,
          key: k,
          current: data[k],
          label: (NODE_DEFS[n.type] || {}).title || n.type
        });
      }
    });
  });
  return out;
}

function buildMutateSystemPrompt(count){
  return [
    '你是工作流提示词优化助手。用户已经搭好一个工作流，流程里有若干可修改的文本参数（提示词 / 指令 / 文本）。',
    '请给出 ' + count + ' 个变体：每个变体只改这些文本参数的值，**不要改变节点与连线结构**。',
    '',
    '## 输出格式',
    '只输出一个 JSON 对象，不要输出 JSON 之外的任何文字：',
    '{"variants":[{"name":"变体名","reason":"为什么这样改（一句话）","patches":[{"nodeId":"节点 id","key":"instruction","value":"新的完整文本"}]}]}',
    '',
    '## 硬性规则',
    '1. nodeId 与 key 必须来自下面列出的可改参数，不要发明新的节点或参数。',
    '2. value 必须是完整可用、可直接写进节点的文本，不要写占位符、不要留空。',
    '3. 变体之间要有实质差异（例如：更具体 / 更中性 / 换个分析角度 / 约束更严），不要只改标点。',
    '4. 每个变体至少改一个参数；没把握就少给变体，也不要凑数。'
  ].join('\n');
}

function buildMutateUserPrompt(targets, count, goal, flowName){
  const lines = [];
  lines.push('工作流：' + (flowName || '未命名工作流'));
  lines.push('可改参数（' + targets.length + ' 个）：');
  targets.forEach(t => {
    lines.push('- nodeId=' + t.nodeId + ' key=' + t.key + '（节点：' + t.label + '）');
    lines.push('  当前值：' + t.current.replace(/\s+/g, ' ').slice(0, 400));
  });
  if(goal) lines.push('\n优化目标：' + goal);
  lines.push('\n请输出 ' + count + ' 个变体的 JSON。');
  return lines.join('\n');
}

/* 过滤 + 收敛模型给的 patches：只保留「存在且确实改了」的文本参数 */
function normalizePatches(list, targets){
  const byKey = new Map(targets.map(t => [t.nodeId + '|' + t.key, t]));
  const out = [];
  (Array.isArray(list) ? list : []).forEach(p => {
    if(!p || typeof p !== 'object') return;
    const nodeId = String(p.nodeId || p.node || '');
    const key = String(p.key || '');
    const t = byKey.get(nodeId + '|' + key);
    if(!t) return;                                          // 不存在的节点 / 不是可改文本参数
    const val = p.value == null ? '' : String(p.value).trim();
    if(!val || val === String(t.current).trim()) return;     // 空值或跟原值一样，等于没改
    if(out.some(x => x.nodeId === nodeId && x.key === key)) return;
    out.push({ nodeId, key, value: val });
  });
  return out;
}

/* 调 LLM 生成变体。返回 { variants:[{id,name,reason,patches}], targets } */
async function mutateFlowVariants(flow, opts){
  const o = opts || {};
  const ask = o.ask;
  if(typeof ask !== 'function') throw new Error('缺少 LLM 调用函数');
  const targets = collectTextTargets(flow);
  if(!targets.length) throw new Error('这个流程没有可优化的文本参数（提示词 / 指令）');
  const count = Math.max(1, Math.min(5, Math.trunc(Number(o.count) || 3)));
  const sys = buildMutateSystemPrompt(count);
  const user = buildMutateUserPrompt(targets, count, o.goal, flow && flow.name);
  const raw = await ask(sys, user);
  const parsed = extractJson(raw);
  if(!parsed || !Array.isArray(parsed.variants)) throw new Error('模型没有返回 variants 列表');

  const variants = [];
  const seen = new Set();
  parsed.variants.slice(0, count + 4).forEach((v, i) => {
    const o2 = v && typeof v === 'object' ? v : {};
    const patches = normalizePatches(o2.patches, targets);
    if(!patches.length) return;                              // 一个有效改动都没有的变体直接丢
    const fp = JSON.stringify(patches.map(p => [p.nodeId, p.key, p.value]));
    if(seen.has(fp)) return;                                 // 和前面重复
    seen.add(fp);
    variants.push({
      id: 'v' + (variants.length + 1),
      name: o2.name != null && String(o2.name).trim() ? String(o2.name).trim().slice(0, 24) : '变体 ' + (i + 1),
      reason: o2.reason != null ? String(o2.reason).slice(0, 200) : '',
      patches
    });
  });
  if(!variants.length) throw new Error('模型给出的改动都不合法（节点 id 或参数键对不上），请重试');
  return { variants: variants.slice(0, count), targets };
}

/* 把变体的改动应用到流程副本上（原流程不动） */
function applyVariant(flow, variant){
  const copy = JSON.parse(JSON.stringify(flow));
  const applied = [];
  ((variant && variant.patches) || []).forEach(p => {
    const n = (copy.nodes || []).find(x => x.id === p.nodeId);
    if(!n || !n.data) return;
    n.data[p.key] = p.value;
    applied.push(p);
  });
  return { flow: copy, applied };
}

/* 选优：先看是否成功，再看失败节点数，最后看耗时 */
function pickWinner(results){
  const ok = (results || []).filter(r => r && r.ok);
  if(!ok.length) return null;
  return ok.slice().sort((a, b) => {
    const fa = Number(a.failed) || 0, fb = Number(b.failed) || 0;
    if(fa !== fb) return fa - fb;
    return (Number(a.ms) || 0) - (Number(b.ms) || 0);
  })[0];
}

/* 逐个试跑并汇总。runner(flowVariant, variant) → {ok, failed, ms, outs, error} */
async function compareVariants(flow, variants, opts){
  const o = opts || {};
  const run = o.run;
  if(typeof run !== 'function') throw new Error('缺少运行函数');
  const list = Array.isArray(variants) ? variants : [];
  const results = [];
  for(const v of list){
    if(typeof o.shouldStop === 'function' && o.shouldStop()) break;   // 用户点了「停止」
    const built = applyVariant(flow, v);
    let r;
    try { r = await run(built.flow, v); }
    catch(e){ r = { ok: false, failed: 1, ms: 0, error: String((e && e.message) || e) }; }
    const row = {
      variantId: v.id,
      name: v.name || '变体',
      ok: !!(r && r.ok),
      scored: !!(r && r.ok) ? 1 : 0,
      failed: Math.max(0, Math.trunc(Number(r && r.failed) || 0)),
      ms: Math.max(0, Math.trunc(Number(r && r.ms) || 0)),
      outs: Array.isArray(r && r.outs) ? r.outs.length : 0,
      error: String((r && r.error) || '')
    };
    results.push(row);
    if(typeof o.onProgress === 'function') o.onProgress(results.length, list.length, row);
  }
  return { results, winner: pickWinner(results) };
}
