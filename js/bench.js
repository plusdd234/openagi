/* 基准集（P1 · 回归的地基）
 *
 * 一条基准 = 某个工作流 + 一组通过标准：
 *   expectOk      必须成功
 *   maxMs         耗时不超基线（捕获时按最近一次成功运行的 1.5 倍自动给）
 *   minOuts       输出参数数量不少于基准
 *   outsNames     输出参数名齐全（端节点改名 = 流程变了，应重新捕获）
 *
 * 判定逻辑（benchCheck）是纯函数，测试直接喂构造出来的运行记录。
 * 试跑（benchRunNow）会打开对应流程真跑一遍 —— 会消耗积分，只能由用户手动触发。
 */

const BENCH_STORE = 'bench';

/* 从当前流程 + 最近一次成功记录生成基准。flow 用 snapshotBp() 的形态即可 */
function benchCapture(flow, opts){
  const o = opts || {};
  const nodes = (flow && flow.nodes) || [];
  const ends = nodes.filter(n => n.type === 'end');
  const names = [];
  ends.forEach(n => (n.params || []).forEach(p => { if(p && p.name) names.push(String(p.name)); }));
  const minOuts = ends.reduce((s, n) => s + ((n.params || []).length), 0);
  const lastRec = o.lastRec && o.lastRec.ms > 0 ? o.lastRec : null;
  return {
    id: 'b' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    flowId: (flow && flow.id) || '',
    flowName: (flow && flow.name) || '未命名工作流',
    expectOk: true,
    maxMs: lastRec ? Math.round(lastRec.ms * 1.5) : 0,
    minOuts,
    outsNames: names,
    created: Date.now(),
    last: null,
    history: []
  };
}

/* 纯判定：rec 是运行概要 { ok, stopped, ms, outs, error } */
function benchCheck(rec, bench){
  const reasons = [];
  const r = rec || {};
  const b = bench || {};
  if(r.stopped) reasons.push('运行被手动停止，不算一次有效回归');
  if(b.expectOk !== false && !r.ok && !r.stopped){
    reasons.push('预期成功，实际失败' + (r.error ? '：' + r.error : ''));
  }
  if(Number(b.maxMs) > 0 && Number(r.ms) > Number(b.maxMs)){
    reasons.push('耗时 ' + (Number(r.ms) / 1000).toFixed(1) + 's，超过基准 ' + (Number(b.maxMs) / 1000).toFixed(1) + 's');
  }
  const outs = Array.isArray(r.outs) ? r.outs : [];
  if(Number(b.minOuts) > 0 && outs.length < Number(b.minOuts)){
    reasons.push('输出参数 ' + outs.length + ' 个，少于基准 ' + b.minOuts + ' 个');
  }
  if(Array.isArray(b.outsNames) && b.outsNames.length){
    const got = new Set(outs.map(x => x && x.name));
    const missing = b.outsNames.filter(n => !got.has(n));
    if(missing.length) reasons.push('缺少输出参数：' + missing.join('、'));
  }
  return { pass: reasons.length === 0, reasons };
}

/* ---- 存取 ---- */
function benchAll(){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(BENCH_STORE, 'readonly'); } catch(e){ res([]); return; }
      let q;
      try { q = t.objectStore(BENCH_STORE).getAll(); } catch(e){ res([]); return; }
      q.onsuccess = () => res((q.result || []).slice().sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0)));
      q.onerror = () => res([]);
    });
  }).catch(() => []);
}
function benchList(flowId){
  return benchAll().then(list => flowId ? list.filter(b => b.flowId === flowId) : list);
}
function benchGet(id){
  return benchAll().then(list => list.find(b => b.id === id) || null);
}
function benchSave(bench){
  if(!bench || !bench.id) return Promise.resolve(false);
  return runDbTx('readwrite', s => s.put(bench), BENCH_STORE);
}
function benchDelete(id){
  return runDbTx('readwrite', s => s.delete(id), BENCH_STORE);
}

/* 注入式试跑：run(bench) → 运行概要。测试用它喂构造数据，UI 传真实执行 */
function benchRunWith(bench, run){
  if(typeof run !== 'function') throw new Error('缺少运行函数');
  return Promise.resolve(run(bench)).then(rec => {
    const chk = benchCheck(rec, bench);
    const entry = {
      at: Date.now(),
      pass: chk.pass,
      reasons: chk.reasons,
      ms: Math.max(0, Math.trunc(Number(rec && rec.ms) || 0)),
      outs: Array.isArray(rec && rec.outs) ? rec.outs.length : 0
    };
    const next = Object.assign({}, bench, {
      last: entry,
      history: [entry].concat((bench.history || []).slice(0, 9))
    });
    return benchSave(next).then(ok => ({ bench: next, check: chk, saved: ok }));
  });
}

/* ---- 浏览器端：真跑一遍（会消耗积分，仅手动触发） ---- */
async function benchRunNow(bench){
  if(!bench) throw new Error('缺少基准');
  if(typeof bpRunBusy !== 'undefined' && bpRunBusy) throw new Error('正在运行，请等这次结束再试');
  if(typeof FLOWS === 'undefined') throw new Error('工作流列表未加载');
  const flow = FLOWS.find(f => f.id === bench.flowId);
  if(!flow) throw new Error('基准对应的工作流已被删除，请删掉这条基准');
  openFlow(flow.id);
  const t0 = Date.now();
  await runFlow();
  // 口径与 runFlow 收尾处的遥测一致（成功 = 没停止、没有失败节点、且有任务开始）
  const stopped = bp.nodes.some(n => n.status === 'stopped');
  const failed = bp.nodes.filter(n => n.status === 'error').length;
  const firstErr = bp.nodes.find(n => n.status === 'error');
  const rec = {
    ok: !stopped && failed === 0 && bp.nodes.some(n => n.type === 'start'),
    stopped,
    ms: Date.now() - t0,
    failed,
    outs: typeof runOutsSummary === 'function' ? runOutsSummary(bp.lastRun) : [],
    error: firstErr ? ((NODE_DEFS[firstErr.type] || {}).title || firstErr.type) + '：' + firstErr.error : ''
  };
  return benchRunWith(bench, () => rec);
}

/* ---- 历史页的基准区渲染 ---- */
function benchRender(){
  const host = $('benchList');
  if(!host) return;
  host.innerHTML = '';
  if(!bp){
    const e = document.createElement('div');
    e.className = 'run-empty';
    e.textContent = '打开一个工作流后，可以把它设为回归基准。';
    host.appendChild(e);
    return;
  }
  benchList(bp.id).then(list => {
    host.innerHTML = '';
    if(!list.length){
      const e = document.createElement('div');
      e.className = 'run-empty';
      e.textContent = '当前流程还没有基准。跑通一次后点「设为基准」，以后改动就能一键回归。';
      host.appendChild(e);
      return;
    }
    list.forEach(b => {
      const row = document.createElement('div');
      row.className = 'bench-row' + (b.last ? (b.last.pass ? ' ok' : ' bad') : '');
      const l1 = document.createElement('div');
      l1.className = 'bench-l1';
      const name = document.createElement('span');
      name.className = 'bench-name';
      name.textContent = b.flowName;
      const chip = document.createElement('span');
      chip.className = 'bench-chip' + (b.last ? (b.last.pass ? ' ok' : ' bad') : ' idle');
      chip.textContent = b.last ? (b.last.pass ? '通过' : '未通过') : '未跑过';
      l1.append(name, chip);
      const sub = document.createElement('div');
      sub.className = 'run-sub';
      const crit = [];
      if(b.maxMs) crit.push('≤ ' + (b.maxMs / 1000).toFixed(1) + 's');
      if(b.minOuts) crit.push(b.minOuts + ' 个输出');
      sub.textContent = (crit.length ? crit.join(' · ') : '仅要求跑通') + (b.last ? ' · ' + runTimeText(b.last.at) : '');
      row.append(l1, sub);
      if(b.last && b.last.reasons && b.last.reasons.length){
        const why = document.createElement('div');
        why.className = 'run-error';
        why.textContent = b.last.reasons.join('；');
        row.appendChild(why);
      }
      const tools = document.createElement('div');
      tools.className = 'bench-tools';
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.textContent = '跑一遍';
      runBtn.title = '打开该流程并真跑（会消耗积分）';
      runBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        if(!confirm('跑基准会用真实接口执行一次「' + b.flowName + '」，可能消耗积分。继续？')) return;
        runBtn.disabled = true;
        runBtn.textContent = '跑…';
        benchRunNow(b).then(r => {
          bpToast(r.check.pass ? '基准通过' : '基准未通过：' + r.check.reasons[0]);
          benchRender();
        }).catch(e => {
          bpToast('基准运行失败：' + ((e && e.message) || e));
          runBtn.disabled = false;
          runBtn.textContent = '跑一遍';
        });
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', ev => {
        ev.stopPropagation();
        if(!confirm('删除基准「' + b.flowName + '」？只删基准，不影响工作流。')) return;
        benchDelete(b.id).then(() => benchRender());
      });
      tools.append(runBtn, del);
      row.appendChild(tools);
      host.appendChild(row);
    });
  });
}

/* 把当前流程设为基准：基线耗时取最近一次成功运行（若有） */
function benchCaptureNow(){
  if(!bp){ bpToast('请先打开一个工作流'); return; }
  const snap = snapshotBp();
  runHistoryList(40).then(list => {
    const lastRec = list.find(r => r.flowId === bp.id && r.ok) || null;
    const bench = benchCapture(snap, { lastRec });
    return benchSave(bench).then(ok => {
      if(!ok){ bpToast('基准保存失败（存储不可用）'); return; }
      bpToast('已设为基准：' + (bench.maxMs ? '耗时不超 ' + (bench.maxMs / 1000).toFixed(1) + 's' : '仅要求跑通'));
      benchRender();
    });
  }).catch(e => bpToast('设置基准失败：' + ((e && e.message) || e)));
}
