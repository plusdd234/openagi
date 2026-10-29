/* 体检：P3 基础设施（轨迹 / 判定 / 版本锁定 / 复用缓存 / 血缘 / 轨迹编译器）
 * 用法：node tools/infra.js
 *
 * 这一组守的是「Agent 探索 → 压成图 → 确定性重放」这条链的地基。
 * 每条断言都对应一个**曾经真实缺失**的能力，不是为覆盖率凑数：
 *   ① 库版本 4 与 8 张表都在 —— 少一张，对应的功能会静默返回空数组
 *   ② 节点能力描述符 —— 没有它，成本路由与确定性标注都无从谈起
 *   ③ 轨迹能落盘 —— 在此之前对话一条都不存，窗口一关这次探索就没了
 *   ④ 成功判定三档 —— 只有一个 ok 布尔时，「跑完但一步没执行」也算成功
 *   ⑤ 轨迹编译器是**确定性**的 —— 同一份轨迹编译两次必须完全一致
 *   ⑥ 运行记录带 versionId + 节点级快照 —— 否则「重放」跑的是今天的图
 *   ⑦ 复用的节点不计入本次消耗，但计入「省下的量」
 *   ⑧ 血缘能把一张图往上追一层
 *   ⑨ 对话刷新后还在（这是「刚刚成功那一刻」存在的前提）
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const base = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
  await page.goto(base + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);

  console.log('\n=== 1. 运行库升到 v4，8 张表都在 ===');
  const db = await page.evaluate(async () => {
    const d = await runDbOpen();
    return { ver: d.version, stores: Array.from(d.objectStoreNames).sort() };
  });
  check(db.ver === 4, '库版本 = 4', 'v' + db.ver);
  const want = ['bench', 'cache', 'evolve', 'lineage', 'memory', 'runs', 'traces', 'versions'];
  check(want.every(s => db.stores.indexOf(s) >= 0), '8 张表齐全', db.stores.join(','));

  console.log('\n=== 2. 节点能力描述符（成本 / 延迟 / 确定性）===');
  const meta = await page.evaluate(() => {
    const bad = [];
    const types = Object.keys(NODE_DEFS);
    types.forEach(t => {
      const m = NODE_DEFS[t].meta;
      if (!m) { bad.push(t + ':无meta'); return; }
      if (['exact', 'structural', 'none'].indexOf(m.determinism) < 0) bad.push(t + ':det');
      if (typeof m.cost !== 'number') bad.push(t + ':cost');
      if (['fast', 'med', 'slow'].indexOf(m.latency) < 0) bad.push(t + ':latency');
      if (!!m.cacheable !== (Number(m.cost) > 0)) bad.push(t + ':cacheable');
    });
    return {
      n: types.length, bad,
      gen: NODE_DEFS.imageGen.meta,
      txt: NODE_DEFS.text.meta,
      model: NODE_DEFS.model3d.meta,
      metaOfUnknown: (typeof nodeMeta === 'function') ? nodeMeta('__nope__').determinism : 'missing'
    };
  });
  check(meta.n >= 21, '节点类型数正常', String(meta.n));
  check(meta.bad.length === 0, '每个节点都有合法的能力描述符', meta.bad.slice(0, 4).join(' '));
  check(meta.gen.cost === 30 && meta.gen.determinism === 'none', '出图 = 30u + 不可逐像素复现', JSON.stringify(meta.gen));
  check(meta.txt.cost === 0 && meta.txt.determinism === 'exact', '纯文本 = 0u + 确定性', JSON.stringify(meta.txt));
  check(meta.model.cost === 300, '3D 生成 = 300u', String(meta.model.cost));
  check(meta.metaOfUnknown === 'structural', '未知类型走兜底档（不返回 undefined）');

  console.log('\n=== 3. 轨迹落盘 ===');
  await page.evaluate(async () => { await traceClear(); });
  await page.evaluate(async () => {
    await traceAppend({ cap: 'imageGen', ok: true, ms: 900, model: 'banana_pro', engine: 'cloud', inputs: { prompt: '一只在雨里的猫', denoise: 0.55 } });
    await traceAppend({ cap: 'imageGen', ok: true, ms: 800, model: 'banana_pro', engine: 'cloud', inputs: { prompt: '一只在雨里的猫' } });
    await traceAppend({ cap: 'webSearch', ok: true, ms: 120, inputs: { query: '天气' } });
  });
  const tl = await page.evaluate(async () => {
    const l = await traceList();
    return { n: l.events.length, sum: traceSummary(l), first: l.events[0] && l.events[0].inputs.prompt };
  });
  check(tl.n === 3, '三次调用都记下来了', String(tl.n));
  check(tl.sum.byCap.imageGen === 2 && tl.sum.byCap.webSearch === 1, '按能力分类正确', JSON.stringify(tl.sum.byCap));
  check(tl.first === '一只在雨里的猫', '记的是解析后的输入（不是空壳）', String(tl.first));

  console.log('\n=== 4. 成功判定三档 ===');
  const vd = await page.evaluate(() => ({
    ok: verdictOf({ started: true, structuralOk: true, failedNodes: 0, activated: 5, stopped: false, rating: 0, retries: 0 }).verdict,
    part: verdictOf({ started: true, structuralOk: true, failedNodes: 1, activated: 4 }).verdict,
    idle: verdictOf({ started: true, structuralOk: true, failedNodes: 0, activated: 0 }).verdict,
    noStart: verdictOf({ started: false }).verdict,
    invalid: verdictOf({ started: true, structuralOk: false }).verdict,
    retry: verdictOf({ started: true, structuralOk: true, failedNodes: 0, activated: 3, retries: 4 }).verdict,
    down: verdictOf({ started: true, structuralOk: true, failedNodes: 0, activated: 3, rating: -1 }).verdict
  }));
  check(vd.ok === 'ok', '全部通过且无瑕疵 → ok');
  check(vd.part === 'partial', '有节点失败 → partial');
  check(vd.retry === 'partial' && vd.down === 'partial', '试错过多 / 被踩 → partial');
  check(vd.idle === 'failed', '跑完但一个节点都没激活 → failed（以前算成功）');
  check(vd.noStart === 'failed' && vd.invalid === 'failed', '没入口 / 结构不成立 → failed');

  console.log('\n=== 5. 轨迹 → 流程（确定性编译，不过 LLM）===');
  const cmp = await page.evaluate(async () => {
    const l = await traceList();
    const a = flowFromTrace(l.events, {});
    const b = flowFromTrace(l.events, {});
    const types = a.ok ? a.flow.nodes.map(n => n.type) : [];
    const start = a.ok ? a.flow.nodes.find(n => n.type === 'start') : null;
    return {
      ok: a.ok, err: a.error, types,
      same: !!(a.ok && b.ok && JSON.stringify(a.flow) === JSON.stringify(b.flow)),
      prompt: start && start.params && start.params[0] ? start.params[0].value : '',
      paramCount: start && start.params ? start.params.length : 0,
      skipped: (a.skipped || []).map(s => s.cap),
      steps: a.steps,
      valid: a.ok ? validateFlow(a.flow).errors.length : -1,
      links: a.ok ? a.flow.links.length : 0
    };
  });
  check(cmp.ok, '成功轨迹能编译成流程', cmp.err || '');
  check(cmp.same, '同一份轨迹编译两次完全一致（确定性）');
  check(cmp.types.indexOf('imageGen') >= 0 && cmp.types.indexOf('start') >= 0 && cmp.types.indexOf('result') >= 0,
    '节点齐全', cmp.types.slice(0, 6).join(','));
  check(cmp.prompt === '一只在雨里的猫', '提示词进了「任务开始」的参数默认值（可改词复用）', cmp.prompt);
  check(cmp.paramCount === 1, '重复的提示词只建一个参数', String(cmp.paramCount));
  check(cmp.skipped.indexOf('webSearch') >= 0, '映射不到的步骤明确列出来（搜索）', cmp.skipped.join(','));
  check(cmp.valid === 0, '编译结果通过 flow-validate', 'errors=' + cmp.valid);
  check(cmp.links >= 3, '连线建起来了', String(cmp.links));

  const cmpFail = await page.evaluate(() => {
    const r = flowFromTrace([{ cap: 'webSearch', ok: true, inputs: {} }], {});
    return { ok: r.ok, err: r.error };
  });
  check(!cmpFail.ok && /没有可固化/.test(cmpFail.err), '只有搜索时拒绝编译并说明原因', cmpFail.err);

  console.log('\n=== 6. 安装（必须由用户点击触发，不自动落盘）===');
  const inst = await page.evaluate(async () => {
    const l = await traceList();
    const res = flowFromTrace(l.events, {});
    const before = FLOWS.length;
    let flow = null, err = '';
    try { flow = installGeneratedFlow(res); } catch (e) { err = String((e && e.message) || e); }
    return { before, after: FLOWS.length, name: flow && flow.name, nodes: flow && flow.nodes.length, err };
  });
  check(inst.after === inst.before + 1, '落盘一条', inst.before + ' → ' + inst.after + (inst.err ? ' ' + inst.err : ''));
  check(/对话沉淀/.test(inst.name || ''), '名字能看出是对话沉淀的', inst.name);

  console.log('\n=== 7. 版本锁定 + 节点级快照 + 成本账本 ===');
  const rec = await page.evaluate(async () => {
    const flow = FLOWS[0];
    const vid = await pinFlowVersion(flow);
    const vid2 = await pinFlowVersion(flow);
    await recordRun({
      flowId: flow.id, flowName: flow.name, versionId: vid, ok: true, ms: 1200,
      nodes: 6, activated: 5, failed: 0, verdict: 'ok',
      nodeInputs: [
        { id: 'n1', type: 'imageGen', ok: true, ms: 900, model: 'banana_pro', engine: 'cloud', determinism: 'none', cost: 30, cache: false, params: { prompt: '猫' } },
        { id: 'n2', type: 'imageGen', ok: true, ms: 0, model: 'banana_pro', engine: 'cloud', determinism: 'none', cost: 30, cache: true, params: { prompt: '猫' } },
        { id: 'n3', type: 'text', ok: true, ms: 1, determinism: 'exact', cost: 0, cache: false, params: { text: '猫' } }
      ]
    });
    const list = await runHistoryList(20);
    const r0 = list.find(x => x.flowId === flow.id) || list[0];
    const led = await runLedger(flow.id);
    return {
      vid, vid2, versionId: r0.versionId, nodeInputs: (r0.nodeInputs || []).length,
      cost: r0.cost, cacheHits: r0.cacheHits, det: r0.determinism, verdict: r0.verdict, led
    };
  });
  check(!!rec.vid && rec.vid === rec.vid2, '结构没变 → 复用同一版快照（不刷屏）', String(rec.vid).slice(0, 12));
  check(rec.versionId === rec.vid, '运行记录带上了 versionId');
  check(rec.nodeInputs === 3, '节点级快照逐条留下', String(rec.nodeInputs));
  check(rec.cost && rec.cost.u === 30, '复用的节点不计入本次消耗', JSON.stringify(rec.cost));
  check(rec.cacheHits === 1, '记下命中次数', String(rec.cacheHits));
  check(rec.det === 'none', '整体确定性取最弱的一档（有出图就是 none）', rec.det);
  check(rec.verdict === 'ok', '记录里带判定结论', rec.verdict);
  check(rec.led && rec.led.cachedSaved === 30, '账本单独记「省下的量」', rec.led && String(rec.led.cachedSaved));

  console.log('\n=== 8. 跨运行复用缓存 ===');
  const c = await page.evaluate(async () => {
    await cacheClear();
    const k = cacheKeyFor('imageGen', 'cloud|banana_pro', { prompt: '猫' });
    const k2 = cacheKeyFor('imageGen', 'cloud|banana_pro', { prompt: '狗' });
    const k3 = cacheKeyFor('imageGen', 'local|sdxl', { prompt: '猫' });
    await cachePut(k, { cap: 'imageGen', cost: 30, determinism: 'none', out: { image: 'data:x' } });
    const hit = await cacheGet(k);
    await cacheTouch(k);
    const st = await cacheStats();
    const miss = await cacheGet(k2);
    return {
      hit: !!hit, out: hit && hit.out && hit.out.image, miss: !!miss,
      diffPrompt: k !== k2, diffEngine: k !== k3,
      entries: st.entries, hits: st.hits
    };
  });
  check(c.hit && c.out === 'data:x', '同输入能复用', String(c.out));
  check(!c.miss, '换提示词就不命中');
  check(c.diffPrompt && c.diffEngine, '键里含提示词与引擎（少一维就会拿错图）');
  check(c.entries === 1 && c.hits === 1, '统计对得上', c.entries + '/' + c.hits);

  console.log('\n=== 9. 资产血缘 ===');
  const lg = await page.evaluate(async () => {
    await lineageAdd({ asset: '/tmp/a.png', kind: 'image', runId: 'r1', flowId: 'f1', versionId: 'v1', nodeId: 'n1', nodeType: 'imageGen', cap: 'imageGen', determinism: 'none', parents: ['/tmp/b.png'] });
    await lineageAdd({ asset: '/tmp/b.png', kind: 'image', runId: 'r0', cap: 'imageGen' });
    const one = await lineageOf('/tmp/a.png');
    const up = await lineageUp('/tmp/a.png', 3);
    const byRun = await lineageByRun('r1');
    const st = await lineageStats();
    return {
      key: one && one.asset, parent: one && one.parents && one.parents[0],
      levels: up.map(x => x.level), byRun: byRun.length, total: st.total
    };
  });
  check(lg.key === 'desk:/tmp/a.png', '路径归一成 desk: 前缀', String(lg.key));
  check(lg.parent === 'desk:/tmp/b.png', '上级资产也归一');
  check(lg.levels.indexOf(1) >= 0 && lg.total === 2, '能往上追一层', lg.levels.join(','));
  check(lg.byRun === 1, '能按运行查产出');

  console.log('\n=== 10. 对话落盘：刷新后还在 ===');
  const p2 = await context.newPage();
  await p2.goto(base, { waitUntil: 'load' });          // 不带 nostore：要允许写
  await p2.waitForTimeout(700);
  await p2.evaluate(async () => {
    await chatSave([
      { id: 1, role: 'user', content: '画一只在雨里的猫' },
      { id: 2, role: 'assistant', kind: 'image', phase: 'done', prompt: 'a cat in the rain', image: 'data:image/png;base64,AAA', srcLabel: '在线 · banana_pro' }
    ]);
  });
  const saved = await p2.evaluate(async () => {
    const r = await chatLoad();
    return { n: r.msgs.length, prompt: r.msgs[1] && r.msgs[1].prompt, img: !!(r.msgs[1] && r.msgs[1].image) };
  });
  check(saved.n === 2 && saved.prompt === 'a cat in the rain' && saved.img, '存进去能读回来', JSON.stringify(saved));
  await p2.reload({ waitUntil: 'load' });
  await p2.waitForTimeout(1000);
  const restored = await p2.evaluate(() => {
    const log = document.getElementById('deskChatLog');
    return { txt: log ? log.textContent : '' };
  });
  check(/雨里的猫|cat in the rain/.test(restored.txt), '刷新后对话还在（这就是「刚刚成功那一刻」的前提）', restored.txt.slice(0, 40));
  await p2.close();

  console.log('\n=== 10b. 「存成流程」的判定与入口都在 ===');
  const ui = await page.evaluate(() => ({
    bar: !!document.getElementById('deskChatSaveFlow'),
    btn: !!document.getElementById('btnChatSaveFlow'),
    x: !!document.getElementById('btnChatSaveFlowX'),
    hintYes: traceFlowHint(null, { steps: 2, byCap: { imageGen: 2 }, failCount: 0 }).worthy,
    hintNo: traceFlowHint(null, { steps: 1, byCap: { webSearch: 1 }, failCount: 0 }).worthy,
    hintWarn: (traceFlowHint(null, { steps: 2, byCap: { imageGen: 2 }, failCount: 1 }).reason || ''),
    cvOk: chatVerdict([{ role: 'assistant', kind: 'image', phase: 'done', image: 'x' }]).verdict,
    /* 有产出 + 中间失败过 → partial；一次产出都没有（哪怕是失败了）→ failed */
    cvErr: chatVerdict([
      { role: 'assistant', kind: 'image', phase: 'done', image: 'x' },
      { role: 'assistant', kind: 'image', phase: 'error', error: 'boom' }
    ]).verdict,
    cvOnlyErr: chatVerdict([{ role: 'assistant', kind: 'image', phase: 'error', error: 'boom' }]).verdict,
    cvEmpty: chatVerdict([]).verdict
  }));
  check(ui.bar && ui.btn && ui.x, '提示条与两个按钮都在 DOM 里');
  check(ui.hintYes && !ui.hintNo, '只有含出图步骤才推荐存（纯搜索不推荐）');
  check(/失败过/.test(ui.hintWarn), '有失败尝试时把话说清楚', ui.hintWarn);
  check(ui.cvOk === 'ok' && ui.cvErr === 'partial' && ui.cvOnlyErr === 'failed' && ui.cvEmpty === 'failed',
    '对话侧判定三档正确', [ui.cvOk, ui.cvErr, ui.cvOnlyErr, ui.cvEmpty].join('/'));

  console.log('\n=== 11. 端到端：真跑一次流程，记录里必须带上新字段 ===');
  /* 用 start → text → result 这条最朴素的链（不联网、不花成本），
   * 验证运行时那几处改动真的接上了：版本锁定、节点级快照、成本、确定性、判定。
   * 前面 7 段是「函数自己能跑」，这一段才是「跑一次运行会不会自动留下这些」。 */
  const runRes = await page.evaluate(async () => {
    const s = newNode('start', -320, 0);
    const t = newNode('text', -120, 140);
    t.data.text = '这一轮探索的原文';
    const r = newNode('result', 240, 0);
    const flow = {
      id: 'infra_' + Date.now(), name: '基础设施体检', nodes: [s, t, r],
      links: [
        { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: r.id, key: 'exec' } },
        { id: uid(), from: { node: t.id, key: 'text' }, to: { node: r.id, key: 'text' } }
      ],
      vars: [], updated: Date.now(), lastRun: null
    };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    if (typeof flushViewSwap === 'function') flushViewSwap();
    await runFlow();
    await new Promise(res => setTimeout(res, 600));
    const list = await runHistoryList(40);
    const rec = list.find(x => x.flowId === flow.id) || null;
    const led = await runLedger(flow.id);
    return {
      found: !!rec,
      versionId: rec && rec.versionId,
      det: rec && rec.determinism,
      cost: rec && rec.cost && rec.cost.u,
      verdict: rec && rec.verdict,
      nIn: rec ? (rec.nodeInputs || []).length : 0,
      types: rec ? (rec.nodeInputs || []).map(n => n.type) : [],
      activated: rec && rec.activated,
      ledDet: led && led.byDet
    };
  });
  check(runRes.found, '运行结束后自动写了一条记录');
  check(!!runRes.versionId, '自动锁定了版本（重放才有依据）', String(runRes.versionId).slice(0, 10));
  check(runRes.nIn >= 2, '节点级快照记到了中间节点', (runRes.types || []).join(','));
  check(runRes.det === 'exact', '纯本地链的确定性是 exact', String(runRes.det));
  check(runRes.cost === 0, '不花钱的链成本为 0', String(runRes.cost));
  check(runRes.verdict === 'ok', '判定为成功', String(runRes.verdict));
  check(runRes.ledDet && runRes.ledDet.exact >= 1, '账本按确定性分档统计', JSON.stringify(runRes.ledDet));

  console.log('\n=== 12. 页面零报错 ===');
  check(errors.length === 0, '无 pageerror', errors.length ? errors.slice(0, 3).join(' | ') : 'clean');

  await browser.close();
  console.log('\n' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
