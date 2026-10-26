/* 变体试跑面板（P1 · A/B 的交互层）
 *
 * 只做交互编排：生成变体 → 勾选 → 依次试跑（临时 bp，不落盘）→ 结果表 → 采用最佳。
 * 试跑跑完一定把原流程还原；临时流程带 __noSave，runFlow 收尾的自动保存会跳过它。
 */

let vexBusy = false;
let vexAbort = null;
let vexVariants = [];
let vexResults = null;
let vexWinner = null;
let vexBase = null;
let vexStopped = false;

/* 「停止」：中断当前变体的运行，并让 compareVariants 不再启动下一个 */
function vexStop(){
  vexStopped = true;
  if(vexAbort){ try { vexAbort.abort(); } catch(e){} }
  if(typeof stopFlow === 'function' && bpRunBusy) stopFlow();
  vexStatus('正在停止…', 'warn');
}

function openVex(){
  if(!bp){ bpToast('请先打开一个工作流'); return; }
  if(bpRunBusy){ bpToast('正在运行，请等这次结束'); return; }
  vexReset();
  $('vexBackdrop').classList.remove('hidden');
  setTimeout(() => { const t = $('vexGoal'); if(t) t.focus(); }, 30);
}

function closeVex(){
  if(vexBusy) vexStop();
  vexBusy = false;
  $('vexBackdrop').classList.add('hidden');
}

function vexReset(){
  vexBusy = false;
  vexAbort = null;
  vexStopped = false;
  vexVariants = [];
  vexResults = null;
  vexWinner = null;
  vexBase = null;
  $('vexGoal').value = '';
  $('vexList').innerHTML = '';
  $('vexResults').innerHTML = '';
  $('vexResults').classList.add('hidden');
  $('vexAdopt').classList.add('hidden');
  $('vexRunAll').classList.add('hidden');
  $('vexCancel').classList.add('hidden');
  $('vexGen').classList.remove('hidden');
  $('vexGen').classList.add('primary');
  $('vexGen').textContent = '生成变体';
  vexStatus('', '');
  $('vexHint').textContent = '变体只改提示词 / 指令，不动结构；试跑不会保存到你正在编辑的流程';
}

function vexStatus(text, cls){
  const el = $('vexStatus');
  el.className = 'gen-status' + (cls ? ' ' + cls : '') + (text ? '' : ' hidden');
  el.textContent = text || '';
}

function vexAsk(sys, user){
  if(typeof llmReady === 'function' && !llmReady()){
    return Promise.reject(new Error('语言模型未配置：请先在设置里填写 Key、接口地址与模型名'));
  }
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    vexAbort = ctrl;
    let acc = '';
    llmStreamRequest(sys, [{ role: 'user', content: [{ type: 'text', text: user }] }],
      t => { acc += t; },
      { timeoutMs: 180000, signal: ctrl.signal }
    ).then(raw => { vexAbort = null; resolve(raw || acc); })
      .catch(e => { vexAbort = null; reject(e); });
  });
}

async function vexGenerate(){
  if(vexBusy) return;
  if(!bp){ bpToast('请先打开一个工作流'); return; }
  const snap = JSON.parse(JSON.stringify(snapshotBp()));
  const targets = collectTextTargets(snap);
  if(!targets.length){
    vexStatus('当前流程没有可优化的提示词 / 指令参数（分析任务、图像生成、文本节点才会被优化）', 'bad');
    return;
  }
  vexBase = snap;
  vexBusy = true;
  $('vexGen').classList.add('hidden');
  $('vexCancel').classList.remove('hidden');
  $('vexRunAll').classList.add('hidden');
  $('vexAdopt').classList.add('hidden');
  $('vexResults').classList.add('hidden');
  $('vexList').innerHTML = '';
  vexStatus('正在生成变体…（' + targets.length + ' 个可改参数）', 'busy');
  try {
    const res = await mutateFlowVariants(snap, { ask: vexAsk, count: 3, goal: $('vexGoal').value.trim() });
    vexVariants = res.variants;
    vexRenderList();
    vexStatus('生成了 ' + vexVariants.length + ' 个变体，勾选后依次试跑', 'ok');
    $('vexRunAll').classList.remove('hidden');
  } catch(e){
    const aborted = (e && e.name === 'AbortError') || /abort|停止|中断/i.test(String((e && e.message) || ''));
    vexStatus(aborted ? '已取消' : '生成失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : ((e && e.message) || e)), aborted ? 'warn' : 'bad');
    $('vexGen').classList.remove('hidden');
  } finally {
    vexBusy = false;
    vexAbort = null;
    $('vexCancel').classList.add('hidden');
  }
}

function vexRenderList(){
  const host = $('vexList');
  host.innerHTML = '';
  vexVariants.forEach((v, i) => {
    const row = document.createElement('label');
    row.className = 'vex-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.vid = v.id;
    cb.addEventListener('change', () => { $('vexRunAll').classList.toggle('hidden', !vexSelected().length); });
    const body = document.createElement('div');
    body.className = 'vex-body';
    const name = document.createElement('div');
    name.className = 'vex-name';
    name.textContent = v.id.toUpperCase() + ' · ' + v.name;
    body.appendChild(name);
    if(v.reason){
      const why = document.createElement('div');
      why.className = 'vex-reason';
      why.textContent = v.reason;
      body.appendChild(why);
    }
    v.patches.forEach(p => {
      const line = document.createElement('div');
      line.className = 'vex-patch';
      const t = vexTargetType(p.nodeId);
      line.textContent = (((NODE_DEFS[t] || {}).title) || t || '') + ' · ' + p.key + '：';
      const val = document.createElement('span');
      val.className = 'vex-val';
      val.textContent = p.value.length > 90 ? p.value.slice(0, 90) + '…' : p.value;
      line.appendChild(val);
      body.appendChild(line);
    });
    row.append(cb, body);
    host.appendChild(row);
  });
}

function vexTargetType(nodeId){
  const n = (vexBase && vexBase.nodes || []).find(x => x.id === nodeId);
  return n ? n.type : '';
}

function vexSelected(){
  const set = new Set();
  $('vexList').querySelectorAll('input[type=checkbox]').forEach(cb => {
    if(cb.checked) set.add(cb.dataset.vid);
  });
  return vexVariants.filter(v => set.has(v.id));
}

async function vexRunAll(){
  if(vexBusy) return;
  if(bpRunBusy){ vexStatus('工作流正在运行，请稍候再试', 'warn'); return; }
  const sel = vexSelected();
  if(!sel.length){ vexStatus('请至少勾选一个变体', 'bad'); return; }
  const base = JSON.parse(JSON.stringify(vexBase || snapshotBp()));
  vexBusy = true;
  vexStopped = false;
  $('vexRunAll').classList.add('hidden');
  $('vexAdopt').classList.add('hidden');
  $('vexCancel').classList.remove('hidden');
  $('vexResults').classList.add('hidden');
  vexStatus('开始依次试跑 ' + sel.length + ' 个变体…', 'busy');
  try {
    const res = await compareVariants(base, sel, {
      run: (variantFlow, v) => vexTrial(variantFlow, v),
      shouldStop: () => vexStopped,
      onProgress: (i, n, row) => {
        vexStatus('第 ' + i + '/' + n + ' 个：' + row.name + (row.ok ? ' ✓' : ' ✗') +
          ' · ' + (row.ms / 1000).toFixed(1) + 's' + (row.error ? ' · ' + row.error : ''),
          row.ok ? 'ok' : 'bad');
      }
    });
    vexResults = res.results;
    vexWinner = res.winner;
    vexRenderResults();
    if(vexWinner){
      vexStatus((vexStopped ? '已停止，' : '') + '试跑完成，最优：「' + vexWinner.name + '」（' + (vexWinner.ms / 1000).toFixed(1) + 's）', 'ok');
      $('vexAdopt').classList.remove('hidden');
      $('vexGen').classList.remove('primary');   // 采用最佳才是主动作
    } else if(vexStopped){
      vexStatus('已停止试跑，没有跑通的变体', 'warn');
    } else {
      vexStatus('试跑完成，但没有一个变体跑通 —— 说明问题不在措辞，建议检查流程本身', 'warn');
    }
  } catch(e){
    vexStatus('试跑失败：' + ((e && e.message) || e), 'bad');
  } finally {
    // 无论成败都还原原流程（临时 bp 从未写盘）
    bp = JSON.parse(JSON.stringify(base));
    if(window.Editor) Editor.reset();
    $('bpName').value = bp.name || '';
    $('bpState').textContent = '';
    renderNodes();
    requestAnimationFrame(() => { try { fitView(); } catch(e){} });
    vexBusy = false;
    $('vexCancel').classList.add('hidden');
    $('vexRunAll').classList.remove('hidden');
  }
}

/* 单个变体的试跑：临时 bp（不落盘），跑完把指标算出来 */
async function vexTrial(variantFlow, v){
  const trial = JSON.parse(JSON.stringify(variantFlow));
  trial.id = 'trial_' + (v && v.id ? v.id : 'v') + '_' + Date.now();
  trial.name = '试跑 · ' + ((v && v.name) || '变体');
  trial.__noSave = true;              // desktop.js 的 saveFlowNow 会跳过它
  bp = trial;
  if(window.Editor) Editor.reset();
  $('bpName').value = trial.name;
  renderNodes();
  const t0 = Date.now();
  try { await runFlow(); } catch(e){ /* runFlow 自己吞节点错误，这里只防意外 */ }
  const failed = bp.nodes.filter(n => n.status === 'error').length;
  const stopped = bp.nodes.some(n => n.status === 'stopped');
  const firstErr = bp.nodes.find(n => n.status === 'error');
  return {
    ok: !stopped && failed === 0 && bp.nodes.some(n => n.type === 'start'),
    stopped,
    failed,
    ms: Date.now() - t0,
    outs: typeof runOutsSummary === 'function' ? runOutsSummary(bp.lastRun) : [],
    error: firstErr ? (((NODE_DEFS[firstErr.type] || {}).title || firstErr.type) + '：' + (firstErr.error || '')) : ''
  };
}

function vexRenderResults(){
  const host = $('vexResults');
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'vex-res-head';
  ['变体', '结果', '耗时', '失败', '输出'].forEach(h => {
    const c = document.createElement('span');
    c.textContent = h;
    head.appendChild(c);
  });
  host.appendChild(head);
  (vexResults || []).forEach(r => {
    const row = document.createElement('div');
    row.className = 'vex-res-row' + (vexWinner && r.variantId === vexWinner.variantId ? ' win' : '') + (r.ok ? ' ok' : ' bad');
    const cells = [
      r.name,
      r.ok ? '通过' : '失败',
      (r.ms / 1000).toFixed(1) + 's',
      String(r.failed),
      String(r.outs)
    ];
    cells.forEach((t, i) => {
      const c = document.createElement('span');
      c.textContent = t;
      if(i === 1) c.className = r.ok ? 'ok' : 'bad';
      row.appendChild(c);
    });
    host.appendChild(row);
    if(r.error){
      const err = document.createElement('div');
      err.className = 'run-error';
      err.textContent = r.error;
      host.appendChild(err);
    }
  });
  host.classList.remove('hidden');
}

async function vexAdopt(){
  if(!vexWinner){ vexStatus('没有可采用的变体', 'bad'); return; }
  const v = vexVariants.find(x => x.id === vexWinner.variantId);
  if(!v || !bp){ vexStatus('找不到胜出的变体', 'bad'); return; }
  // 安全门：先存快照（采用后可以回到采用前），失败也照常采用，但要告知
  const snap = JSON.parse(JSON.stringify(snapshotBp()));
  let snapOk = false;
  try {
    const r = await flowVersionSave(snap, { reason: '采用变体前' });
    snapOk = !!r.ok;
  } catch(e){ snapOk = false; }
  const lessons = (typeof flowMemoryFromVariant === 'function') ? flowMemoryFromVariant(snap, v) : [];
  let applied = 0;
  v.patches.forEach(p => {
    const n = bp.nodes.find(x => x.id === p.nodeId);
    if(!n || !n.data) return;
    n.data[p.key] = p.value;
    applied++;
  });
  renderNodes();
  scheduleFlowSave();
  let memText = '';
  if(lessons.length && typeof flowMemoryAdd === 'function'){
    try {
      const mem = await flowMemoryAdd(lessons, {
        flowId: snap.id, flowName: snap.name,
        reason: '采用变体「' + v.name + '」'
      });
      if(mem.added) memText = '，' + mem.added + ' 条经验已记录';
    } catch(e){}
  }
  closeVex();
  bpToast('已采用「' + v.name + '」：改了 ' + applied + ' 处参数' + memText
    + (snapOk ? '' : '（快照保存失败，本次无法回滚）'));
}
