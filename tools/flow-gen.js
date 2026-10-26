/* 体检：NL → 工作流生成器（P0 第三层）
 * 用 mock ask 模拟 LLM，覆盖：正常生成 / 校验失败带错重试 / 反问 / 重试用尽
 * / 规范化（默认值补齐、坐标补齐、id 去重、类型收敛）/ 人工确认门（不确认不落盘）
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

// 合法 DAG：start → aiTask → tripoImg → end（tripoImg 故意不写 timeout，验默认值补齐）
const GOOD_DAG = {
  name: '参考图修复流程',
  nodes: [
    { id: 'n1', type: 'start', params: [{ id: 'p1', name: '原图', type: 'image', value: '' }] },
    { id: 'n2', type: 'aiTask', data: {
      instruction: '诊断画面中的无意义结构，并给出中性修复提示词',
      inputs: [{ id: 'i1', name: '图像', type: 'image' }],
      outputs: [{ id: 'o1', name: '修复提示词', type: 'string' }]
    } },
    { id: 'n3', type: 'tripoImg' },
    { id: 'n4', type: 'end', params: [{ id: 'p2', name: '结果图', type: 'image', value: '' }] }
  ],
  links: [
    { id: 'l1', from: { node: 'n1', key: 'p1' }, to: { node: 'n2', key: 'i1' } },
    { id: 'l2', from: { node: 'n1', key: 'exec' }, to: { node: 'n2', key: 'exec' } },
    { id: 'l3', from: { node: 'n2', key: 'o1' }, to: { node: 'n3', key: 'prompt' } },
    { id: 'l4', from: { node: 'n2', key: 'exec' }, to: { node: 'n3', key: 'exec' } },
    { id: 'l5', from: { node: 'n3', key: 'image' }, to: { node: 'n4', key: 'p2' } },
    { id: 'l6', from: { node: 'n3', key: 'exec' }, to: { node: 'n4', key: 'exec' } }
  ]
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof generateFlowDag === 'function', null, { timeout: 8000 });

  console.log('=== 1. 正常生成 + 人工确认门 ===');
  const r1 = await page.evaluate(async dag => {
    const before = FLOWS.length;
    const calls = [];
    const ask = (sys, user) => {
      calls.push({ sys, user });
      return Promise.resolve('```json\n' + JSON.stringify(dag) + '\n```');   // 同时验证围栏解析
    };
    const res = await generateFlowDag('读取原图、诊断并修复后输出结果图', { ask, retries: 2 });
    const mid = FLOWS.length;
    const flow = res.ok ? installGeneratedFlow(res) : null;
    return {
      ok: res.ok,
      attempts: res.attempts,
      errs: res.errors ? res.errors.map(e => e.code) : [],
      nodes: res.flow ? res.flow.nodes.length : 0,
      links: res.flow ? res.flow.links.length : 0,
      name: res.flow ? res.flow.name : '',
      tips: res.flow ? res.flow.nodes.find(n => n.type === 'tripoImg').data.timeout : null,
      coords: res.flow ? res.flow.nodes.every(n => typeof n.x === 'number' && typeof n.y === 'number') : false,
      layoutSpread: res.flow ? new Set(res.flow.nodes.map(n => n.x)).size : 0,
      before, mid,
      after: flow ? FLOWS.length : mid,
      installed: flow ? FLOWS.some(f => f.id === flow.id) : false,
      opened: flow ? (bp && bp.id === flow.id) : false,
      uniqueIds: flow ? new Set(flow.nodes.map(n => n.id)).size === flow.nodes.length : false,
      calls: calls.length,
      sysHint: calls.length ? /节点目录/.test(calls[0].sys) : false
    };
  }, GOOD_DAG);
  check('生成成功', r1.ok === true, r1.errs.join(','));
  check('一次通过（不需要重试）', r1.attempts === 1, 'attempts=' + r1.attempts);
  check('节点数与 DAG 一致（4）', r1.nodes === 4, 'nodes=' + r1.nodes);
  check('连线数与 DAG 一致（6）', r1.links === 6, 'links=' + r1.links);
  check('名称透传', r1.name === '参考图修复流程', r1.name);
  check('未写的参数补上默认值（tripoImg 超时 240）', r1.tips === 240, String(r1.tips));
  check('没给坐标时自动排版', r1.coords && r1.layoutSpread >= 3, 'spread=' + r1.layoutSpread);
  check('生成阶段不写入 FLOWS（人工确认门）', r1.mid === r1.before, r1.before + ' → ' + r1.mid);
  check('确认后才写入 FLOWS', r1.after === r1.before + 1 && r1.installed, r1.before + ' → ' + r1.after);
  check('确认后打开该流程', r1.opened === true);
  check('安装后节点 id 仍唯一', r1.uniqueIds === true);
  check('系统提示词带入节点目录', r1.sysHint === true);

  console.log('\n=== 2. 校验失败带错重试 ===');
  const r2 = await page.evaluate(async dag => {
    const bad = JSON.parse(JSON.stringify(dag));
    bad.nodes = bad.nodes.filter(n => n.type !== 'start');
    bad.links = bad.links.filter(l => l.from.node !== 'n1');
    const calls = [];
    const ask = (sys, user) => {
      calls.push(user);
      return Promise.resolve(JSON.stringify(calls.length === 1 ? bad : dag));
    };
    const res = await generateFlowDag('修图', { ask, retries: 2 });
    return {
      ok: res.ok,
      attempts: res.attempts,
      calls: calls.length,
      feedbackHasStart: calls.length > 1 && calls[1].indexOf('任务开始') >= 0,
      feedbackHasHint: calls.length > 1 && /修正/.test(calls[1])
    };
  }, GOOD_DAG);
  check('第一轮没过、第二轮通过', r2.ok === true && r2.calls === 2, JSON.stringify(r2));
  check('重试次数统计正确', r2.attempts === 2, 'attempts=' + r2.attempts);
  check('错误清单回馈给了模型（含「任务开始」）', r2.feedbackHasStart === true);
  check('回馈里带「修正」指令', r2.feedbackHasHint === true);

  console.log('\n=== 3. 模型反问 ===');
  const r3 = await page.evaluate(async () => {
    const ask = () => Promise.resolve(JSON.stringify({ questions: ['输入图从哪里来？', '需要 3D 模型还是只要图？'] }));
    const res = await generateFlowDag('帮我做个修复的东西', { ask, retries: 2 });
    return { ok: res.ok, questions: res.questions || [], hasFlow: !!res.flow };
  });
  check('反问时 ok=false', r3.ok === false);
  check('返回两条问题', r3.questions.length === 2, JSON.stringify(r3.questions));
  check('反问时不产出流程', r3.hasFlow === false);

  console.log('\n=== 4. 重试用尽 ===');
  const r4 = await page.evaluate(async () => {
    const calls = [];
    const ask = (s, u) => { calls.push(u); return Promise.resolve('我不会输出 JSON'); };
    const res = await generateFlowDag('随便', { ask, retries: 1 });
    return { ok: res.ok, calls: calls.length, err: res.error || '' };
  });
  check('重试用尽后 ok=false', r4.ok === false);
  check('按 retries 精确调用（1+1=2 次）', r4.calls === 2, 'calls=' + r4.calls);
  check('错误信息可读', /校验|JSON/.test(r4.err), r4.err);

  const r5 = await page.evaluate(async dag => {
    const calls = [];
    const ask = (s, u) => { calls.push(u); return Promise.resolve('{}'); };
    const res = await generateFlowDag('随便', { ask, retries: 0 });
    return { ok: res.ok, calls: calls.length };
  });
  check('retries=0 时只调用一次', r5.calls === 1 && r5.ok === false, 'calls=' + r5.calls);

  console.log('\n=== 5. 规范化 ===');
  const r6 = await page.evaluate(async () => {
    const dag = {
      name: '',
      nodes: [
        { id: 'dup', type: 'start', params: [
          { name: '张数', type: 'int', value: '5' },
          { name: '修复', type: 'bool', value: 'true' }
        ] },
        { id: 'dup', type: 'text', data: { text: '补充说明' } },
        { id: 'z', type: 'end', params: [{ name: '说明', type: 'string', value: '结果' }] }
      ],
      links: [
        { from: { node: 'dup', key: 'exec' }, to: { node: 'z', key: 'exec' } }
      ]
    };
    const ask = () => Promise.resolve(JSON.stringify(dag));
    const res = await generateFlowDag('生成一个带说明的流程', { ask, retries: 0 });
    const st = res.ok ? res.flow.nodes.find(n => n.type === 'start') : null;
    return {
      ok: res.ok,
      name: res.ok ? res.flow.name : '',
      idsUnique: res.ok ? new Set(res.flow.nodes.map(n => n.id)).size === res.flow.nodes.length : false,
      intVal: st ? st.params[0].value : null,
      intType: st ? typeof st.params[0].value : '',
      boolVal: st ? st.params[1].value : null,
      notes: res.ok ? res.notes.length : -1,
      errs: res.errors ? res.errors.map(e => e.code) : []
    };
  });
  check('同名 id 自动去重', r6.idsUnique === true, JSON.stringify(r6));
  check('缺名称时给默认名', !!r6.name, r6.name);
  check('参数值按声明类型收敛（int）', r6.intVal === 5 && r6.intType === 'number', String(r6.intVal) + '/' + r6.intType);
  check('参数值按声明类型收敛（bool）', r6.boolVal === true, String(r6.boolVal));
  check('去重过程有 notes 说明', r6.notes >= 1, String(r6.notes));

  console.log('\n=== 6. 非法输入被拦住 ===');
  const r7 = await page.evaluate(async () => {
    const ask = () => Promise.resolve(JSON.stringify({ nodes: [{ id: 'a', type: '不存在的类型' }], links: [] }));
    const res = await generateFlowDag('随便', { ask, retries: 0 });
    return { ok: res.ok, err: res.error || '', hasErrors: !!(res.errors && res.errors.length) };
  });
  check('未知节点类型不生成流程', r7.ok === false);
  check('错误里说明类型问题', /类型/.test(r7.err), r7.err);

  const r8 = await page.evaluate(async () => {
    let threw = '';
    try { await generateFlowDag('', { ask: () => Promise.resolve('{}') }); } catch(e){ threw = String(e.message || e); }
    return threw;
  });
  check('空需求直接拒绝', /描述/.test(r8), r8);

  console.log('\n=== 7. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
