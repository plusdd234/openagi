/* 体检：流程变异与 A/B（P1）
 * 覆盖：可改参数收集 / 变体生成与过滤（不存在节点、非文本参数、空值、重复、原值）
 * / 应用到副本（原流程不动）/ 选优规则 / 注入 runner 的 A/B / 中途停止
 * 零真实 LLM、零桥、零积分。 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof mutateFlowVariants === 'function' && typeof compareVariants === 'function', null, { timeout: 8000 });

  console.log('=== 1. 可改参数收集 ===');
  const r1 = await page.evaluate(() => {
    const flow = {
      nodes: [
        { id: 'a', type: 'aiTask', data: { instruction: '分析画面问题', timeout: 300 } },
        { id: 'b', type: 'text', data: { text: '补充说明' } },
        { id: 'c', type: 'imageGen', data: { prompt: '' } },
        { id: 'd', type: 'tripoModel', data: { timeout: 420 } }
      ]
    };
    const t = collectTextTargets(flow);
    return { n: t.length, keys: t.map(x => x.nodeId + ':' + x.key), labels: t.map(x => x.label) };
  });
  check('只收集非空的文本参数', r1.n === 2 && r1.keys.join(',') === 'a:instruction,b:text', r1.keys.join(','));
  check('带节点标题便于展示', r1.labels[0] === '分析任务' && r1.labels[1] === '文本 / 提示词', r1.labels.join(','));

  console.log('\n=== 2. 变体生成与过滤 ===');
  const r2 = await page.evaluate(async () => {
    const flow = { name: '测试流程', nodes: [{ id: 'a', type: 'aiTask', data: { instruction: '分析画面问题' } }] };
    const good = { name: '更具体', reason: '补充判断维度', patches: [{ nodeId: 'a', key: 'instruction', value: '列出画面中的具体结构与位置' }] };
    const reply = {
      variants: [
        good,
        { name: '坏节点', patches: [{ nodeId: 'zz', key: 'instruction', value: 'x' }] },
        { name: '坏参数', patches: [{ nodeId: 'a', key: 'timeout', value: '60' }] },
        { name: '没变化', patches: [{ nodeId: 'a', key: 'instruction', value: '分析画面问题' }] },
        { name: '空值', patches: [{ nodeId: 'a', key: 'instruction', value: '   ' }] },
        { name: '重复', patches: [{ nodeId: 'a', key: 'instruction', value: '列出画面中的具体结构与位置' }] },
        { name: '第二个', reason: '更中性', patches: [{ nodeId: 'a', key: 'instruction', value: '客观描述画面，不做主观评价' }] }
      ]
    };
    const calls = [];
    const ask = (sys, user) => { calls.push({ sys, user }); return Promise.resolve(JSON.stringify(reply)); };
    const res = await mutateFlowVariants(flow, { ask, count: 3 });
    return {
      n: res.variants.length,
      names: res.variants.map(v => v.name),
      firstPatch: res.variants[0].patches[0],
      ids: res.variants.map(v => v.id),
      sysRule: /不要改变节点与连线结构/.test(calls[0].sys),
      userHasNode: calls[0].user.indexOf('nodeId=a') >= 0,
      userHasCurrent: calls[0].user.indexOf('分析画面问题') >= 0
    };
  });
  check('非法 patch 被过滤、重复与未变被去重', r2.n === 2, JSON.stringify(r2.names));
  check('保留合法变体名与改动', r2.names[0] === '更具体' && r2.firstPatch.value === '列出画面中的具体结构与位置', JSON.stringify(r2.firstPatch));
  check('变体 id 重新编号', r2.ids.join(',') === 'v1,v2', r2.ids.join(','));
  check('系统提示词声明「结构不变」', r2.sysRule === true);
  check('用户提示词带上节点 id 与当前值', r2.userHasNode && r2.userHasCurrent);

  console.log('\n=== 3. 异常输入 ===');
  const r3 = await page.evaluate(async () => {
    const flow = { name: 'x', nodes: [{ id: 'a', type: 'aiTask', data: { instruction: '分析' } }] };
    const out = {};
    try { await mutateFlowVariants({ nodes: [{ id: 'd', type: 'tripoModel', data: { timeout: 1 } }] }, { ask: () => Promise.resolve('{}') }); }
    catch(e){ out.noTarget = String(e.message || e); }
    try { await mutateFlowVariants(flow, { ask: () => Promise.resolve('这不是 JSON') }); }
    catch(e){ out.noJson = String(e.message || e); }
    try { await mutateFlowVariants(flow, { ask: () => Promise.resolve('{"variants":"x"}') }); }
    catch(e){ out.badShape = String(e.message || e); }
    try { await mutateFlowVariants(flow, { ask: () => Promise.resolve(JSON.stringify({ variants: [{ name: 'g', patches: [{ nodeId: 'a', key: 'instruction', value: '分析' }] }] })) }); }
    catch(e){ out.noChange = String(e.message || e); }
    try { await mutateFlowVariants(flow, {}); }
    catch(e){ out.noAsk = String(e.message || e); }
    return out;
  });
  check('没有可改参数时报错', /没有可优化的文本参数/.test(r3.noTarget), r3.noTarget);
  check('非 JSON 报错', /variants/.test(r3.noJson), r3.noJson);
  check('结构不对报错', /variants/.test(r3.badShape), r3.badShape);
  check('全是无效改动时报错', /不合法/.test(r3.noChange), r3.noChange);
  check('缺少 LLM 函数时报错', /LLM/.test(r3.noAsk || ''), r3.noAsk);

  console.log('\n=== 4. 应用到副本 ===');
  const r4 = await page.evaluate(() => {
    const flow = { name: 'f', nodes: [{ id: 'a', type: 'aiTask', data: { instruction: '旧值' } }, { id: 'b', type: 'text', data: { text: 'x' } }] };
    const v = { id: 'v1', name: 'n', patches: [{ nodeId: 'a', key: 'instruction', value: '新值' }, { nodeId: 'b', key: 'text', value: 'y' }] };
    const built = applyVariant(flow, v);
    return {
      orig: flow.nodes[0].data.instruction,
      copy: built.flow.nodes[0].data.instruction,
      text: built.flow.nodes[1].data.text,
      applied: built.applied.length,
      notSame: built.flow !== flow && built.flow.nodes[0] !== flow.nodes[0]
    };
  });
  check('原流程不被修改（深拷贝）', r4.orig === '旧值' && r4.notSame === true);
  check('副本被改写', r4.copy === '新值' && r4.text === 'y');
  check('返回实际应用条数', r4.applied === 2, String(r4.applied));

  console.log('\n=== 5. 选优规则 ===');
  const r5 = await page.evaluate(() => {
    const a = { name: 'A', ok: true, failed: 0, ms: 900 };
    const b = { name: 'B', ok: true, failed: 0, ms: 500 };
    const c = { name: 'C', ok: false, failed: 1, ms: 100 };
    const d = { name: 'D', ok: true, failed: 1, ms: 200 };
    const e = { name: 'E', ok: true, failed: 0, ms: 800 };
    return {
      fastest: pickWinner([a, b, c]).name,
      fewerFailed: pickWinner([d, e]).name,
      noneOk: pickWinner([c]),
      empty: pickWinner([])
    };
  });
  check('都成功时选最快', r5.fastest === 'B', r5.fastest);
  check('失败节点更少的优先于更快的', r5.fewerFailed === 'E', r5.fewerFailed);
  check('全失败时没有赢家', r5.noneOk === null);
  check('空列表没有赢家', r5.empty === null);

  console.log('\n=== 6. A/B 编排（注入 runner） ===');
  const r6 = await page.evaluate(async () => {
    const flow = { name: 'f', nodes: [{ id: 'a', type: 'aiTask', data: { instruction: '旧' } }] };
    const variants = [
      { id: 'v1', name: '快', patches: [{ nodeId: 'a', key: 'instruction', value: '新1' }] },
      { id: 'v2', name: '慢', patches: [{ nodeId: 'a', key: 'instruction', value: '新2' }] },
      { id: 'v3', name: '炸', patches: [{ nodeId: 'a', key: 'instruction', value: '新3' }] }
    ];
    const seen = [];
    const progress = [];
    const res = await compareVariants(flow, variants, {
      run: async (vf, v) => {
        seen.push(v.name + ':' + vf.nodes[0].data.instruction);
        if (v.id === 'v3') throw new Error('网络中断');
        return { ok: true, failed: 0, ms: v.id === 'v1' ? 300 : 1500, outs: [{}] };
      },
      onProgress: (i, n, row) => progress.push(i + '/' + n + ':' + row.ok)
    });
    return { rows: res.results.length, seen, winner: res.winner ? res.winner.name : '', progress, errRow: res.results[2].error };
  });
  check('三个变体全部有结果（异常也记账）', r6.rows === 3, String(r6.rows));
  check('每个变体都带着自己的改动开跑', r6.seen.join(',') === '快:新1,慢:新2,炸:新3', r6.seen.join(','));
  check('选中最快且成功的变体', r6.winner === '快', r6.winner);
  check('进度回调逐条触发', r6.progress.length === 3 && r6.progress[2] === '3/3:false', r6.progress.join(','));
  check('异常记到行上', /网络中断/.test(r6.errRow), r6.errRow);

  const r7 = await page.evaluate(async () => {
    const flow = { name: 'f', nodes: [{ id: 'a', type: 'aiTask', data: { instruction: '旧' } }] };
    const variants = [
      { id: 'v1', name: '一', patches: [{ nodeId: 'a', key: 'instruction', value: 'x' }] },
      { id: 'v2', name: '二', patches: [{ nodeId: 'a', key: 'instruction', value: 'y' }] },
      { id: 'v3', name: '三', patches: [{ nodeId: 'a', key: 'instruction', value: 'z' }] }
    ];
    let stop = false;
    const res = await compareVariants(flow, variants, {
      run: async () => { stop = true; return { ok: true, failed: 0, ms: 100, outs: [] }; },
      shouldStop: () => stop
    });
    return { rows: res.results.length, winner: res.winner && res.winner.name };
  });
  check('停止后不再启动下一个变体', r7.rows === 1, String(r7.rows));
  check('已跑的那条仍参与选优', r7.winner === '一', String(r7.winner));

  console.log('\n=== 7. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
