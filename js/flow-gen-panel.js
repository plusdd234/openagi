/* AI 搭建面板（P0 · 自主搭建的交互层）
 *
 * 只做交互编排：读需求 → 调 generateFlowDag（注入流式 ask）→ 展示问题 / 预览 / 错误
 * → 用户点「确认创建」才落盘。业务判断全在 flow-gen.js，这里不重复实现。
 */

let genBusy = false;
let genAbort = null;
let genResult = null;
let genBaseNl = '';

function openFlowGen(){
  genReset();
  $('genBackdrop').classList.remove('hidden');
  setTimeout(() => { const t = $('genInput'); if(t) t.focus(); }, 30);
}

function closeFlowGen(){
  if(genBusy && genAbort){ try { genAbort.abort(); } catch(e){} }
  genBusy = false;
  $('genBackdrop').classList.add('hidden');
}

function genReset(){
  genBusy = false;
  genAbort = null;
  genResult = null;
  genBaseNl = '';
  $('genInput').value = '';
  $('genInput').disabled = false;
  genStatus('', '');
  const qHost = $('genQuestions');
  qHost.classList.add('hidden');
  qHost.innerHTML = '';
  const p = $('genPreview');
  p.classList.add('hidden');
  p.innerHTML = '';
  $('genConfirm').classList.add('hidden');
  $('genCancel').classList.add('hidden');
  $('genRun').classList.remove('hidden');
  $('genRun').disabled = false;
  $('genRun').textContent = '生成';
  genRunPrimary(true);
  $('genHint').textContent = '生成只调用大语言模型，不会自动运行或保存';
}

function genStatus(text, cls){
  const el = $('genStatus');
  el.className = 'gen-status' + (cls ? ' ' + cls : '') + (text ? '' : ' hidden');
  el.textContent = text || '';
}

// 「生成」按钮的主次：确认创建在场时它降为次要动作，避免两个主按钮抢注意力
function genRunPrimary(on){
  const b = $('genRun');
  if(on) b.classList.add('primary'); else b.classList.remove('primary');
}

/* 注入给 generateFlowDag 的 ask：走流式通道（带空闲超时与外部中断） */
function genAsk(sys, user){
  if(typeof llmReady === 'function' && !llmReady()){
    return Promise.reject(new Error('语言模型未配置：请先在设置里填写 Key、接口地址与模型名'));
  }
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    genAbort = ctrl;
    let acc = '';
    llmStreamRequest(sys, [{ role:'user', content:[{ type:'text', text:user }] }],
      t => { acc += t; },
      { timeoutMs: 180000, signal: ctrl.signal }
    ).then(raw => { genAbort = null; resolve(raw || acc); })
      .catch(e => { genAbort = null; reject(e); });
  });
}

async function genStartRound(nl){
  if(genBusy) return;
  const text = String(nl || '').trim();
  if(!text){ genStatus('请先描述想要的工作流', 'bad'); return; }
  genBaseNl = text;
  genBusy = true;
  genResult = null;
  $('genRun').classList.add('hidden');
  $('genConfirm').classList.add('hidden');
  $('genQuestions').classList.add('hidden');
  $('genPreview').classList.add('hidden');
  $('genCancel').classList.remove('hidden');
  $('genInput').disabled = true;
  genStatus('正在生成…（不通关会自动带着错误重试，最多 2 轮）', 'busy');
  try {
    const res = await generateFlowDag(text, { ask: genAsk, retries: 2 });
    genResult = res;
    if(res.ok) genShowPreview(res);
    else if(res.questions && res.questions.length) genShowQuestions(res.questions);
    else {
      genStatus('生成失败：' + (res.error || '未知原因'), 'bad');
      $('genRun').classList.remove('hidden');
      $('genRun').textContent = '重新生成';
      genRunPrimary(true);
    }
  } catch(e){
    const aborted = (e && e.name === 'AbortError') || /abort|停止|中断/i.test(String(e && e.message || ''));
    genStatus(aborted ? '已取消生成' : '生成失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : (e && e.message) || e), aborted ? 'warn' : 'bad');
    $('genRun').classList.remove('hidden');
    $('genRun').textContent = '重新生成';
  } finally {
    genBusy = false;
    genAbort = null;
    $('genInput').disabled = false;
    $('genCancel').classList.add('hidden');
  }
}

/* 模型反问：逐条给输入框，答完拼进需求再生成一轮 */
function genShowQuestions(qs){
  const host = $('genQuestions');
  host.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'gen-q-title';
  title.textContent = '搭这个流程还差一点信息，补充后继续：';
  host.appendChild(title);
  qs.forEach((q, i) => {
    const wrap = document.createElement('label');
    wrap.className = 'gen-q';
    const span = document.createElement('span');
    span.textContent = q;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.qi = String(i);
    input.placeholder = '填写回答';
    wrap.append(span, input);
    host.appendChild(wrap);
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn sm primary gen-q-go';
  btn.textContent = '补充并继续生成';
  btn.addEventListener('click', () => {
    const lines = [];
    host.querySelectorAll('input[data-qi]').forEach(inp => {
      const q = qs[Number(inp.dataset.qi)];
      const a = inp.value.trim();
      if(a) lines.push('- ' + q + ' → ' + a);
    });
    if(!lines.length){ genStatus('请至少回答一个问题', 'bad'); return; }
    const merged = genBaseNl + '\n\n补充回答：\n' + lines.join('\n');
    $('genInput').value = merged;
    genStatus('', '');
    host.classList.add('hidden');
    genStartRound(merged);
  });
  host.appendChild(btn);
  host.classList.remove('hidden');
  genStatus('模型需要补充信息后才能搭建', 'warn');
  $('genRun').classList.remove('hidden');
  $('genRun').textContent = '按原需求重新生成';
  genRunPrimary(false);
}

/* 预览：节点构成 + 告警 + 规范化说明，确认前让人看懂要建什么 */
function genShowPreview(res){
  const host = $('genPreview');
  host.innerHTML = '';
  const d = describeFlow(res.flow);
  const head = document.createElement('div');
  head.className = 'gen-preview-head';
  const name = document.createElement('div');
  name.className = 'gen-preview-name';
  name.textContent = d.title;
  const stats = document.createElement('div');
  stats.className = 'gen-preview-stats';
  stats.textContent = d.stats + (d.params ? ' · ' + d.params + ' 个输入参数' : '') + (d.outs ? ' · ' + d.outs + ' 个产出节点' : '');
  head.append(name, stats);
  host.appendChild(head);

  const list = document.createElement('div');
  list.className = 'gen-preview-types';
  d.types.forEach(t => {
    const chip = document.createElement('span');
    chip.className = 'gen-chip';
    chip.textContent = t;
    list.appendChild(chip);
  });
  host.appendChild(list);

  if(res.warnings && res.warnings.length){
    const warnBox = document.createElement('div');
    warnBox.className = 'gen-preview-warn';
    const title = document.createElement('div');
    title.className = 'gen-preview-warn-title';
    title.textContent = res.warnings.length + ' 条提醒（不阻塞创建，创建后建议检查）：';
    warnBox.appendChild(title);
    res.warnings.slice(0, 6).forEach(w => {
      const line = document.createElement('div');
      line.textContent = '· ' + w.message;
      warnBox.appendChild(line);
    });
    host.appendChild(warnBox);
  }
  if(res.notes && res.notes.length){
    const note = document.createElement('div');
    note.className = 'gen-preview-note';
    note.textContent = res.notes.join('；');
    host.appendChild(note);
  }
  host.classList.remove('hidden');
  $('genConfirm').classList.remove('hidden');
  $('genRun').classList.remove('hidden');
  $('genRun').textContent = '重新生成';
  genRunPrimary(false);
  genStatus('生成完成，确认后才会创建并保存', 'ok');
}

function genConfirm(){
  if(!genResult || !genResult.ok){ genStatus('没有可创建的流程', 'bad'); return; }
  try {
    const flow = installGeneratedFlow(genResult);
    closeFlowGen();
    bpToast('已创建「' + (flow.name || 'AI 工作流') + '」· ' + flow.nodes.length + ' 节点');
    if(typeof bpLogExpand === 'function'){
      bpLogExpand();
      bpLog('AI 搭建：已创建「' + flow.name + '」· ' + flow.nodes.length + ' 节点', 'ok');
    }
  } catch(e){
    genStatus('创建失败：' + ((e && e.message) || e), 'bad');
  }
}

/* 手动校验当前流程：与生成器共用同一套规则，先让人把存量问题看清 */
function checkCurrentFlow(){
  if(!bp){ bpToast('请先打开一个工作流'); return; }
  let res = null;
  try { res = validateFlow(snapshotBp()); }
  catch(e){ bpToast('校验失败：' + ((e && e.message) || e)); return; }
  bpToast(validateSummary(res));
  if(typeof bpLogExpand === 'function' && (res.errors.length || res.warnings.length)){
    bpLogExpand();
    res.errors.concat(res.warnings).slice(0, 10).forEach(x => {
      bpLog((x.level === 'error' ? '✗ ' : '· ') + x.message, x.level === 'error' ? 'error' : 'warn');
    });
  }
}

/* 面板级快捷键：Esc 关闭（捕获阶段拦下，别让画布快捷键抢走） */
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  const bd = $('genBackdrop');
  if(bd && !bd.classList.contains('hidden')){
    e.preventDefault();
    e.stopPropagation();
    closeFlowGen();
  }
}, true);
