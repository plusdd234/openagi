/* 「IF 条件判断」→「分析任务」迁移体检（不调真实 LLM、不触桥、不耗积分）
 * condition 类型已删除；老流程里的条件判断必须变成「文本 → 布尔」的分析任务，
 * 下游「条件分支」照旧按布尔走真 / 假两条线。
 * 1) 类型已删除、节点库不再列出、seed 不生成任何默认值
 * 2) 老流程打开后：type=aiTask、指令补上「只输出 true/false」、入边与出边都重映射
 * 3) 迁移幂等
 * 4) 迁移后真跑：模型回 true 走「真」、回 false 走「假」
 * 用法：node tools/condition-migrate.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 老版本流程：condition 只有 instruction，入边用 key 'text'，出边用 key 'bool' */
const LEGACY = {
  id: 'legacy_condition_flow',
  name: '老流程（含 IF 条件判断）',
  vars: [], frames: [], updated: Date.now(), lastRun: null,
  nodes: [
    { id: 'C_s', type: 'start', x: 0, y: 0, data: {}, params: [] },
    { id: 'C_t', type: 'text', x: 0, y: 120, data: { text: '画面里有一只猫' } },
    { id: 'C_c', type: 'condition', x: 300, y: 60, data: { instruction: '输入内容是否描述了动物' } },
    { id: 'C_b', type: 'branch', x: 560, y: 60, data: {} },
    { id: 'C_ra', type: 'result', x: 820, y: 0, data: {} },
    { id: 'C_ta', type: 'text', x: 820, y: 120, data: { text: '走了真分支' } },
    { id: 'C_rb', type: 'result', x: 820, y: 240, data: {} },
    { id: 'C_tb', type: 'text', x: 820, y: 340, data: { text: '走了假分支' } }
  ],
  links: [
    { id: 'C1', from: { node: 'C_s', key: 'exec' }, to: { node: 'C_c', key: 'exec' } },
    { id: 'C2', from: { node: 'C_t', key: 'text' }, to: { node: 'C_c', key: 'text' } },
    { id: 'C3', from: { node: 'C_c', key: 'exec' }, to: { node: 'C_b', key: 'exec' } },
    { id: 'C4', from: { node: 'C_c', key: 'bool' }, to: { node: 'C_b', key: 'bool' } },
    { id: 'C5', from: { node: 'C_b', key: 'true' }, to: { node: 'C_ra', key: 'exec' } },
    { id: 'C6', from: { node: 'C_ta', key: 'text' }, to: { node: 'C_ra', key: 'text' } },
    { id: 'C7', from: { node: 'C_b', key: 'false' }, to: { node: 'C_rb', key: 'exec' } },
    { id: 'C8', from: { node: 'C_tb', key: 'text' }, to: { node: 'C_rb', key: 'text' } }
  ]
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    window.__bridgeCalls = [];
    const orig = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push(String(url));
        return Promise.resolve(new Response('{"message":"测试环境已禁用真实桥调用"}', { status: 503 }));
      }
      return orig.apply(this, arguments);
    };
    $('llmKey').value = 'test-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-judge';
    if ($('relayOn')) $('relayOn').checked = false;
  });

  console.log('\n=== 1. 类型已删除 ===');
  const r1 = await page.evaluate(() => {
    const lib = NODE_LIB.reduce((a, g) => a.concat(g.types), []);
    const seed = seedNodeData('condition');
    return {
      defined: !!NODE_DEFS.condition,
      params: !!NODE_PARAMS.condition,
      inLib: lib.indexOf('condition') >= 0,
      seedEmpty: Object.keys(seed.data).length === 0,
      libLogic: NODE_LIB.find(g => g.group === '逻辑').types.join(',')
    };
  });
  check(r1.defined === false, 'NODE_DEFS 里没有 condition');
  check(r1.params === false, 'NODE_PARAMS 里没有 condition');
  check(r1.inLib === false, '节点库不再列出 IF 条件判断', r1.libLogic);
  check(r1.seedEmpty === true, 'seedNodeData 不再为 condition 生成默认值');
  check(r1.libLogic === 'branch,smartBranch', '「逻辑」组只剩条件分支与智能分支', r1.libLogic);

  console.log('\n=== 2. 老流程打开即迁移 ===');
  const r2 = await page.evaluate(legacy => {
    FLOWS.unshift(JSON.parse(JSON.stringify(legacy)));
    openFlow('legacy_condition_flow'); flushViewSwap();
    const n = bp.nodes.find(x => x.id === 'C_c');
    const inLinks = bp.links.filter(l => l.to.node === 'C_c');
    const outLinks = bp.links.filter(l => l.from.node === 'C_c');
    const dataIn = inLinks.find(l => l.to.key !== 'exec');
    const dataOut = outLinks.find(l => l.from.key !== 'exec');
    const v = validateFlow(snapshotBp());
    const el = document.getElementById('n-' + n.id);
    const inId = (n.data.inputs || [])[0] ? n.data.inputs[0].id : '';
    const outId = (n.data.outputs || [])[0] ? n.data.outputs[0].id : '';
    return {
      type: n.type,
      instruction: n.data.instruction || '',
      inputs: (n.data.inputs || []).map(p => p.id + ':' + p.type),
      outputs: (n.data.outputs || []).map(p => p.id + ':' + p.type),
      inKeys: inLinks.map(l => l.to.key),
      outKeys: outLinks.map(l => l.from.key),
      inType: dataIn ? pinType(n, dataIn.to.key) : '',
      outType: dataOut ? pinType(n, dataOut.from.key) : '',
      errors: v.errors.map(e => e.code),
      dynInPins: Array.from(el.querySelectorAll('.pin.in')).filter(p => p.dataset.key === inId).length,
      dynOutPins: Array.from(el.querySelectorAll('.pin.out')).filter(p => p.dataset.key === outId).length
    };
  }, LEGACY);
  check(r2.type === 'aiTask', '节点类型转成 aiTask', r2.type);
  check(/只输出 true 或 false/.test(r2.instruction) && /是否描述了动物/.test(r2.instruction),
    '指令补上布尔输出约束、保留原条件', r2.instruction.replace(/\n/g, ' '));
  check(r2.inputs.length === 1 && /:string$/.test(r2.inputs[0]), '输入是 1 个字符串引脚', r2.inputs.join(','));
  check(r2.outputs.length === 1 && /:bool$/.test(r2.outputs[0]), '输出是 1 个布尔引脚', r2.outputs.join(','));
  check(r2.inKeys.every(k => k !== 'text'), '入边不再指向旧 key text', r2.inKeys.join(','));
  check(r2.outKeys.every(k => k !== 'bool'), '出边不再指向旧 key bool', r2.outKeys.join(','));
  check(r2.inType === 'string' && r2.outType === 'bool', '重映射后引脚类型正确（string → bool）', r2.inType + '→' + r2.outType);
  check(r2.errors.length === 0, '迁移后校验无错误', r2.errors.join(','));
  check(r2.dynInPins === 1 && r2.dynOutPins === 1, '新的输入 / 输出引脚都渲染出来了（各 1 个）', r2.dynInPins + '/' + r2.dynOutPins);

  console.log('\n=== 3. 迁移幂等 ===');
  const r3 = await page.evaluate(() => {
    const flow = FLOWS.find(f => f.id === 'legacy_condition_flow');
    const first = migrateLegacyCondition(flow);
    const second = migrateLegacyCondition(flow);
    const n = flow.nodes.find(x => x.id === 'C_c');
    return { first, second, inputs: (n.data.inputs || []).length, type: n.type };
  });
  check(r3.second === 0 && r3.first <= 1, '重复迁移是空操作', 'first=' + r3.first + ' second=' + r3.second);
  check(r3.type === 'aiTask' && r3.inputs === 1, '迁移结果稳定（1 个输入）', r3.type + '/' + r3.inputs);

  console.log('\n=== 4. 迁移后真跑：true → 真分支 ===');
  const runWith = async answer => page.evaluate(async ans => {
    const n = bp.nodes.find(x => x.id === 'C_c');
    const ra = bp.nodes.find(x => x.id === 'C_ra');
    const rb = bp.nodes.find(x => x.id === 'C_rb');
    const guard = window.fetch;
    window.__calls = [];
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__calls.push((init && init.body) || '');
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: ans } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    const body = window.__calls.length ? JSON.parse(window.__calls[0]) : {};
    const content = (body.messages && body.messages[1] && body.messages[1].content) || [];
    const text = Array.isArray(content) ? content.map(c => c.text || '').join('\n') : String(content || '');
    return {
      status: n.status, err: n.error || '',
      boolOut: n.out[((n.data.outputs || [])[0] || {}).id],
      ra: ra.status, rb: rb.status,
      reqText: text, bridge: window.__bridgeCalls.length
    };
  }, answer);

  const r4 = await runWith('true');
  check(r4.status === 'ok', '条件节点执行成功', r4.status + ' ' + r4.err);
  check(r4.boolOut === true, '输出被收敛成布尔 true', String(r4.boolOut));
  check(r4.ra === 'ok' && r4.rb === '', '模型回 true → 只走真分支', 'A=' + r4.ra + ' B=' + r4.rb);
  check(/是否描述了动物/.test(r4.reqText) && /画面里有一只猫/.test(r4.reqText), '条件与待判断文本都进了提示词', r4.reqText.slice(0, 70));
  check(r4.bridge === 0, '全程零桥请求');

  console.log('\n=== 5. false → 假分支 ===');
  const r5 = await runWith('false');
  check(r5.status === 'ok' && r5.boolOut === false, '输出被收敛成布尔 false', String(r5.boolOut));
  check(r5.rb === 'ok' && r5.ra === '', '模型回 false → 只走假分支', 'A=' + r5.ra + ' B=' + r5.rb);

  console.log('\n=== 6. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
