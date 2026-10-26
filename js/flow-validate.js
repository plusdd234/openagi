/* 工作流静态校验（P0 · 自主搭建基础设施第二层）
 *
 * 职责：在「落盘 / 生成 / 运行」之前，用纯逻辑把结构性错误拦下来。
 *   错误（errors）→ 必须修，否则流程跑不起来或跑出来是错的
 *   告警（warnings）→ 能跑但大概率不是用户想要的（未接执行线、没填指令等）
 *
 * 与运行时的分工：运行时负责执行与中断，这里只做静态检查；
 * 环路在运行时也会检测，但那时已经跑了一半，静态检查能提前拦住。
 *
 * 依赖 flow-contract.js 的 pinTypeOf / pinDirOf（无 DOM、不读全局 bp）。
 */

const VALID_MSG = {
  'E-STRUCT': '流程结构不完整',
  'E-TYPE-UNKNOWN': '未知的节点类型',
  'E-DUP-ID': '节点 id 重复',
  'E-LINK-NODE': '连线指向不存在的节点',
  'E-PIN': '引脚不存在',
  'E-PIN-DIR': '连线方向不对',
  'E-TYPE': '引脚类型不匹配',
  'E-CYCLE': '数据连接成环',
  'E-START': '缺少任务开始节点',
  'E-VAR': '引用了不存在的变量',
  'W-STRUCT': '',
  'W-START': '多个任务开始节点',
  'W-EXECIN': '节点未接入执行线',
  'W-OUTPUT': '没有产出收集节点',
  'W-VAR-UNUSED': '变量未被使用',
  'W-REQ': '必填项缺失',
  'W-DYNAMIC': '动态引脚为空',
  'W-DUP-LINK': '重复连线',
  'W-NO-INPUT': '流程没有输入参数'
};

// 每类节点的必需连线（连上或就地填写都算满足）；校验器用 items 逐条检查
const REQUIRED_PINS = {
  aiTask: { pins: [], note: '自定义输入引脚' },
  imageGen: { pins: ['prompt'], note: '提示词' },
  tripoImg: { pins: ['prompt'], note: '提示词' },
  imageSplit: { pins: ['image', 'prompt'], note: '图像与提示词' },
  imageCompress: { pins: ['image'], note: '待压缩图像' },
  condition: { pins: ['text'], note: '待判断文本' },
  aiBranch: { pins: ['text'], note: '判断依据文本' },
  model3d: { pins: ['image'], note: '参考图' },
  tripoModel: { pins: ['image'], note: '参考图' },
  modelViews: { pins: ['model'], note: '3D 模型' },
  varSet: { pins: [], note: '待写入的值' },
  end: { pins: [], note: '输出参数' }
};
// 就地参数被「连线或填写」任一满足即可
const REQUIRED_PARAMS = {
  aiTask: ['instruction'],
  condition: ['instruction'],
  aiBranch: ['instruction'],
  imageSplit: ['prompt'],
  tripoImg: ['prompt'],
  imageGen: ['prompt']
};
// 多视图建模：四个参考图引脚至少接一个
const AT_LEAST_ONE = { tripoModelMulti: ['front', 'left', 'right', 'back'] };

function nodeLabelOf(n){
  const d = NODE_DEFS[(n && n.type) || ''] || {};
  const title = d.title || (n && n.type) || '未知节点';
  const named = n && n.data && (n.data.varId || n.data.name);
  return named ? title + '（' + String(named).slice(0, 12) + '）' : title;
}

/* 主入口：flow 为 {nodes, links, vars} 形态（snapshotBp 或生成器输出都行） */
function validateFlow(flow){
  const errors = [], warnings = [];
  const err = (code, node, message) => errors.push({ code, level: 'error', node: node ? node.id : '', nodeLabel: node ? nodeLabelOf(node) : '', message });
  const warn = (code, node, message) => warnings.push({ code, level: 'warn', node: node ? node.id : '', nodeLabel: node ? nodeLabelOf(node) : '', message });

  if(!flow || typeof flow !== 'object'){ err('E-STRUCT', null, '流程为空'); return { ok: false, errors, warnings }; }
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : null;
  if(!nodes){ err('E-STRUCT', null, '流程缺少 nodes 数组'); return { ok: false, errors, warnings }; }
  const links = Array.isArray(flow.links) ? flow.links : [];
  const vars = Array.isArray(flow.vars) ? flow.vars : [];
  if(!nodes.length) err('E-STRUCT', null, '流程里没有任何节点');

  // ---- 1. 结构：类型 / id 唯一 / 坐标 ----
  const byId = {};
  nodes.forEach(n => {
    if(!n || typeof n !== 'object'){ err('E-STRUCT', null, '存在非法节点（不是对象）'); return; }
    if(!NODE_DEFS[n.type]) err('E-TYPE-UNKNOWN', n, '节点类型「' + n.type + '」不存在，可用：' + Object.keys(NODE_DEFS).join(' / '));
    if(!n.id) err('E-STRUCT', n, '节点缺少 id');
    else if(byId[n.id]) err('E-DUP-ID', n, '节点 id「' + n.id + '」重复');
    else byId[n.id] = n;
    if(typeof n.x !== 'number' || typeof n.y !== 'number') warn('W-STRUCT', n, '节点缺少坐标（x/y），将自动排版');
    if(!n.data || typeof n.data !== 'object') n.data = {};
  });

  // ---- 2. 连线：节点存在 / 引脚存在 / 方向 / 类型 ----
  const seenLink = new Set();
  const validLinks = [];
  links.forEach(l => {
    if(!l || !l.from || !l.to){ err('E-STRUCT', null, '存在非法连线（缺少 from / to）'); return; }
    const a = byId[l.from.node], b = byId[l.to.node];
    if(!a || !b){ err('E-LINK-NODE', a || b, '连线指向不存在的节点（' + l.from.node + ' → ' + l.to.node + '）'); return; }
    const ta = pinTypeOf(a, l.from.key, vars);
    const tb = pinTypeOf(b, l.to.key, vars);
    if(ta === null){
      err('E-PIN', a, '引脚「' + l.from.key + '」不在「' + nodeLabelOf(a) + '」上（检查节点类型与动态引脚是否声明）');
      return;
    }
    if(tb === null){
      err('E-PIN', b, '引脚「' + l.to.key + '」不在「' + nodeLabelOf(b) + '」上（检查节点类型与动态引脚是否声明）');
      return;
    }
    const da = pinDirOf(a, l.from.key, vars);
    const db = pinDirOf(b, l.to.key, vars);
    // 'both' = 同一引脚既能进也能出（如 imageGen 的 image、中间节点的 exec），两边都算合法
    const okFrom = da === 'out' || da === 'both';
    const okTo = db === 'in' || db === 'both';
    if(!okFrom) err('E-PIN-DIR', a, '连线的起点必须是输出引脚，「' + nodeLabelOf(a) + ' → ' + l.from.key + '」是输入引脚');
    if(!okTo) err('E-PIN-DIR', b, '连线的终点必须是输入引脚，「' + nodeLabelOf(b) + ' → ' + l.to.key + '」是输出引脚');
    if(!okFrom || !okTo) return;
    // 类型：完全相同，或 int → float（数值加宽）
    const okType = ta === tb || (ta === 'int' && tb === 'float');
    if(!okType) err('E-TYPE', b, '引脚类型不匹配：' + nodeLabelOf(a) + ' 输出 ' + ta + '，' + nodeLabelOf(b) + ' 的 ' + l.to.key + ' 需要 ' + tb);
    const sig = l.from.node + ':' + l.from.key + '>' + l.to.node + ':' + l.to.key;
    if(seenLink.has(sig)) warn('W-DUP-LINK', b, '重复连线：' + nodeLabelOf(a) + ' → ' + nodeLabelOf(b));
    seenLink.add(sig);
    validLinks.push(l);
  });

  // ---- 3. 数据线环路（静态） ----
  const dataLinks = validLinks.filter(l => {
    const a = byId[l.from.node];
    return a && pinTypeOf(a, l.from.key, vars) !== 'exec';
  });
  const adj = {};
  dataLinks.forEach(l => { (adj[l.from.node] = adj[l.from.node] || []).push(l.to.node); });
  const state = {};   // 0 未访问 / 1 在栈 / 2 完成
  const hitCycle = [];
  const dfs = id => {
    state[id] = 1;
    (adj[id] || []).forEach(next => {
      if(state[next] === 1){ hitCycle.push(next); return; }
      if(!state[next]) dfs(next);
    });
    state[id] = 2;
  };
  nodes.forEach(n => { if(n.id && !state[n.id]) dfs(n.id); });
  if(hitCycle.length){
    const uniq = [...new Set(hitCycle)];
    uniq.forEach(id => err('E-CYCLE', byId[id], '数据连接成环：' + nodeLabelOf(byId[id]) + ' 的输出又绕回了自己（运行时也会报错，必须断开）'));
  }

  // ---- 4. 起点 / 终点 ----
  const starts = nodes.filter(n => n.type === 'start');
  if(!starts.length) err('E-START', null, '缺少「任务开始」节点：执行流只从这里出发，没有它整个流程不会运行');
  if(starts.length > 1) starts.slice(1).forEach(s => warn('W-START', s, '有多个「任务开始」节点，会从每个入口分别跑一遍'));
  const hasOut = nodes.some(n => n.type === 'end' || n.type === 'result');
  if(!hasOut) warn('W-OUTPUT', null, '没有「任务结束」或「结果输出」节点，运行结果无法收集');
  if(starts.length && !(starts[0].params || []).length) warn('W-NO-INPUT', starts[0], '「任务开始」没有输入参数，流程将没有可传入的数据');

  // ---- 5. 执行线接入 ----
  const execInSet = new Set();
  validLinks.forEach(l => {
    const a = byId[l.from.node];
    if(a && pinTypeOf(a, l.from.key, vars) === 'exec') execInSet.add(l.to.node + ':' + l.to.key);
  });
  nodes.forEach(n => {
    const d = NODE_DEFS[n.type] || {};
    if(!d.execIn) return;
    if(!execInSet.has(n.id + ':exec')){
      warn('W-EXECIN', n, '「' + nodeLabelOf(n) + '」没有接入执行线，运行时不会被执行（数据节点可忽略这条）');
    }
  });

  // ---- 6. 变量 ----
  const varIds = new Set(vars.map(v => v.id));
  nodes.forEach(n => {
    if(n.type !== 'varGet' && n.type !== 'varSet') return;
    const vid = n.data && n.data.varId;
    if(!vid) warn('W-REQ', n, '「' + nodeLabelOf(n) + '」没有选择变量');
    else if(!varIds.has(vid)) err('E-VAR', n, '节点引用的变量不存在（可能已被删除），请重新选择变量');
  });
  const usedVars = new Set(nodes.filter(n => n.type === 'varGet' || n.type === 'varSet').map(n => n.data && n.data.varId));
  vars.forEach(v => { if(!usedVars.has(v.id)) warn('W-VAR-UNUSED', null, '变量「' + (v.name || v.id) + '」没有节点使用'); });

  // ---- 7. 必填项 / 动态引脚 ----
  const linkedIn = new Set();
  validLinks.forEach(l => linkedIn.add(l.to.node + ':' + l.to.key));
  nodes.forEach(n => {
    const req = REQUIRED_PINS[n.type];
    if(req){
      const missing = (req.pins || []).filter(k => {
        const type = (NODE_DEFS[n.type] || {}).inputs || [];
        return type.indexOf(k) >= 0 && !linkedIn.has(n.id + ':' + k) && !inlineValueOf(n, k);
      });
      if(missing.length) warn('W-REQ', n, '「' + nodeLabelOf(n) + '」缺少必需的' + req.note + '：' + missing.join('、') + '（可连线或就地填写）');
    }
    (REQUIRED_PARAMS[n.type] || []).forEach(k => {
      const v = n.data && n.data[k];
      if((v === '' || v === undefined || v === null) && !linkedIn.has(n.id + ':' + k)){
        warn('W-REQ', n, '「' + nodeLabelOf(n) + '」的「' + k + '」未填写且未连线，运行时会退化成默认行为');
      }
    });
    const need = AT_LEAST_ONE[n.type];
    if(need){
      const has = need.some(k => linkedIn.has(n.id + ':' + k));
      if(!has) warn('W-REQ', n, '「' + nodeLabelOf(n) + '」至少需要连接一张参考图（' + need.join(' / ') + '）');
    }
    if(n.type === 'aiTask'){
      if(!(n.data.inputs || []).length && !(n.data.outputs || []).length) warn('W-DYNAMIC', n, '「分析任务」没有声明任何自定义输入 / 输出引脚');
    }
    if(n.type === 'aiBranch' && !(n.data.branches || []).length) warn('W-DYNAMIC', n, '「AI 分支」没有出口，无法继续执行流');
    if(n.type === 'imageSplit' && !(n.data.views || []).length) warn('W-DYNAMIC', n, '「图像拆分」没有视图，不会输出任何拆分结果');
  });

  return { ok: errors.length === 0, errors, warnings };
}

// 参数引脚的就地值（text 节点的引脚 key 与 dataKey 可能不同）
function inlineValueOf(n, key){
  const data = (n && n.data) || {};
  const specs = NODE_PARAMS[n.type] || [];
  const hit = specs.find(s => (s.dataKey || s.key) === key);
  const v = hit ? data[hit.dataKey || hit.key] : data[key];
  if(v === '' || v === undefined || v === null || v === false) return false;
  return true;
}

// 一句话摘要，给 toast 用
function validateSummary(res){
  if(!res) return '校验失败';
  if(res.ok && !res.warnings.length) return '流程校验通过';
  const parts = [];
  if(res.errors.length) parts.push(res.errors.length + ' 个错误');
  if(res.warnings.length) parts.push(res.warnings.length + ' 个告警');
  return (res.ok ? '校验通过，但有 ' : '校验未通过：') + parts.join('、');
}
