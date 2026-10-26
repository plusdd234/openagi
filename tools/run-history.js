/* 体检：运行历史（P0 数据地基）
 * 覆盖：输出概要截断（不存图片）/ 记录写入与倒序 / 清空 / 坏输入不抛错
 * / 真实跑一遍 start→end 验证遥测钩子确实在 runFlow 收尾处生效
 * 零 LLM、零桥、零积分。 */
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
  await page.waitForFunction(() => typeof recordRun === 'function' && typeof runHistoryList === 'function', null, { timeout: 8000 });

  console.log('=== 1. 输出概要（不存大块内容） ===');
  const r1 = await page.evaluate(() => {
    const s = runOutsSummary({ values: [
      { id: '1', name: '提示词', type: 'string', value: 'A'.repeat(200) },
      { id: '2', name: '结果图', type: 'image', value: 'data:image/png;base64,' + 'B'.repeat(5000) },
      { id: '3', name: '数量', type: 'int', value: 3 }
    ] });
    return { len: s.length, p0: s[0].preview.length, tail: s[0].preview.slice(-1), p1: s[1].preview, p2: s[2].preview };
  });
  check('三条输出都保留', r1.len === 3, String(r1.len));
  check('长文本截断到 120 字 + 省略号', r1.p0 === 121 && r1.tail === '…', r1.p0 + '/' + r1.tail);
  check('图像只记类型、不记内容', r1.p1 === '');
  check('数值输出正常', r1.p2 === '3');

  console.log('\n=== 2. 写入与读取 ===');
  const r2 = await page.evaluate(async () => {
    await runHistoryClear();
    const before = (await runHistoryList(0)).length;
    const base = Date.now() - 5000;
    const ok1 = await recordRun({
      at: base, flowId: 'f1', flowName: '第一个', ok: true, stopped: false,
      ms: 1200, nodes: 5, activated: 5, failed: 0, error: '',
      outs: [{ name: '结果', type: 'string', preview: '好' }]
    });
    const ok2 = await recordRun({
      at: base + 1000, flowId: 'f1', flowName: '第二个', ok: false, stopped: false,
      ms: 800, nodes: 5, activated: 2, failed: 1, error: '分析任务：模型未返回内容', outs: []
    });
    const ok3 = await recordRun({
      at: base + 2000, flowId: 'f2', flowName: '第三个', ok: false, stopped: true,
      ms: 300, nodes: 3, activated: 1, failed: 0, error: '', outs: []
    });
    const list = await runHistoryList(0);
    const limited = await runHistoryList(2);
    const raw = JSON.stringify(list);
    return {
      before,
      flags: [ok1, ok2, ok3],
      count: list.length,
      limited: limited.length,
      order: list.map(r => r.flowName),
      flags2: list.map(r => r.ok),
      stopped: list[0].stopped,
      hasBase64: raw.indexOf('base64') >= 0,
      rawLen: raw.length
    };
  });
  check('清空后是空的', r2.before === 0, String(r2.before));
  check('三次写入都成功', r2.flags.every(Boolean), JSON.stringify(r2.flags));
  check('读回三条', r2.count === 3, String(r2.count));
  check('limit 生效', r2.limited === 2, String(r2.limited));
  check('按时间倒序（最新在前）', r2.order[0] === '第三个' && r2.order[2] === '第一个', r2.order.join('|'));
  check('成败标记正确', r2.flags2[0] === false && r2.flags2[2] === true, r2.flags2.join(','));
  check('停止标记正确', r2.stopped === true);
  check('记录里没有任何 base64 内容', r2.hasBase64 === false, 'len=' + r2.rawLen);

  console.log('\n=== 3. 坏输入与清空 ===');
  const r3 = await page.evaluate(async () => {
    const bad = await recordRun(null).catch(() => 'threw');
    const bad2 = await recordRun('not an object').catch(() => 'threw');
    const cleared = await runHistoryClear();
    const after = (await runHistoryList(0)).length;
    const state = await runHistoryState();
    return { bad, bad2, cleared, after, state };
  });
  check('null 记录被安全拒绝（不抛错）', r3.bad === false);
  check('字符串记录被安全拒绝', r3.bad2 === false);
  check('清空成功', r3.cleared === true && r3.after === 0, String(r3.after));
  check('状态接口可用', r3.state.count === 0 && r3.state.broken === false, JSON.stringify(r3.state));

  console.log('\n=== 4. 真实运行 → 遥测钩子 ===');
  const r4 = await page.evaluate(async () => {
    await runHistoryClear();
    const s = newNode('start', 0, 0);
    s.params = [{ id: 'pin1', name: '文本', type: 'string', value: '你好' }];
    const e = newNode('end', 30, 0);
    e.params = [{ id: 'pout', name: '摘要', type: 'string', value: '' }];
    FLOWS.unshift({
      id: 'hist_flow', name: '历史集成流程', nodes: [s, e],
      links: [
        { id: 'hl1', from: { node: s.id, key: 'pin1' }, to: { node: e.id, key: 'pout' } },
        { id: 'hl2', from: { node: s.id, key: 'exec' }, to: { node: e.id, key: 'exec' } }
      ],
      vars: [], updated: Date.now(), lastRun: null
    });
    openFlow('hist_flow');
    await runFlow();                      // 真实执行（start → end，不涉及 LLM）
    let list = [];
    for (let i = 0; i < 25; i++) {
      list = await runHistoryList(0);
      if (list.length) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const rec = list[0] || null;
    return {
      count: list.length,
      ok: rec ? rec.ok : null,
      flowId: rec ? rec.flowId : '',
      flowName: rec ? rec.flowName : '',
      nodes: rec ? rec.nodes : 0,
      activated: rec ? rec.activated : 0,
      failed: rec ? rec.failed : -1,
      outs: rec ? rec.outs : [],
      ms: rec ? rec.ms : -1,
      err: rec ? rec.error : ''
    };
  });
  check('运行后自动留下一条记录', r4.count === 1, String(r4.count));
  check('记录标记为成功', r4.ok === true, String(r4.ok));
  check('记录关联到对的工作流', r4.flowId === 'hist_flow' && r4.flowName === '历史集成流程', r4.flowId + '/' + r4.flowName);
  check('节点数与激活数正确', r4.nodes === 2 && r4.activated === 2, r4.nodes + '/' + r4.activated);
  check('失败数为 0', r4.failed === 0, String(r4.failed));
  check('耗时被记录', r4.ms >= 0 && r4.ms < 30000, String(r4.ms));
  check('输出概要带上了端节点参数', r4.outs.length === 1 && r4.outs[0].name === '摘要' && r4.outs[0].preview === '你好', JSON.stringify(r4.outs));
  check('没有误报错误', r4.err === '', r4.err);

  console.log('\n=== 5. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
