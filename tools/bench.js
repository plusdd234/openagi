/* 体检：基准集（P1）
 * 覆盖：捕获口径（基线耗时 1.5 倍 / 输出参数数量与名称）、判定各条原因、
 * 存取与删除、注入式试跑、真实 start→end 跑通、失败流程如判负。
 * 零 LLM、零桥、零积分（桥地址装 fetch 护栏兜底）。 */
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
  // 铁律：任何测试都不许碰到真实 Tripo 桥
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.indexOf('127.0.0.1:8790') >= 0 || u.indexOf('localhost:8790') >= 0) return route.abort();
    return route.continue();
  });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof benchCheck === 'function' && typeof benchCapture === 'function', null, { timeout: 8000 });

  console.log('=== 1. 捕获口径 ===');
  const r1 = await page.evaluate(() => {
    const s = newNode('start', 0, 0);
    s.params = [
      { id: 'p1', name: '文本', type: 'string', value: '' },
      { id: 'p2', name: '图', type: 'image', value: '' }
    ];
    const e = newNode('end', 30, 0);
    e.params = [{ id: 'p3', name: '摘要', type: 'string', value: '' }];
    const flow = { id: 'f1', name: '测试流程', nodes: [s, e], links: [] };
    const a = benchCapture(flow, {});
    const b = benchCapture(flow, { lastRec: { ok: true, ms: 2000 } });
    return {
      flowId: a.flowId, name: a.flowName,
      maxMsNoRec: a.maxMs, maxMsRec: b.maxMs,
      minOuts: a.minOuts, names: a.outsNames,
      hasLast: a.last === null, historyLen: a.history.length, idOk: /^b/.test(a.id)
    };
  });
  check('基准绑定流程 id 与名称', r1.flowId === 'f1' && r1.name === '测试流程', r1.flowId + '/' + r1.name);
  check('没有历史记录时不做耗时限制', r1.maxMsNoRec === 0, String(r1.maxMsNoRec));
  check('有成功记录时取 1.5 倍基线', r1.maxMsRec === 3000, String(r1.maxMsRec));
  check('输出数量取端节点参数总数', r1.minOuts === 1, String(r1.minOuts));
  check('记录输出参数名', JSON.stringify(r1.names) === JSON.stringify(['摘要']), JSON.stringify(r1.names));
  check('初始没有上次结果', r1.hasLast === true && r1.historyLen === 0);
  check('id 形状正确', r1.idOk);

  console.log('\n=== 2. 判定各条原因 ===');
  const r2 = await page.evaluate(() => {
    const bench = { expectOk: true, maxMs: 5000, minOuts: 2, outsNames: ['摘要', '图'] };
    const okRec = { ok: true, stopped: false, ms: 3000, outs: [{ name: '摘要' }, { name: '图' }], error: '' };
    const failRec = { ok: false, stopped: false, ms: 3000, outs: [], error: '分析任务：模型未返回内容' };
    const stopRec = { ok: false, stopped: true, ms: 800, outs: [], error: '' };
    const slowRec = { ok: true, stopped: false, ms: 9000, outs: [{ name: '摘要' }, { name: '图' }], error: '' };
    const fewOuts = { ok: true, stopped: false, ms: 1000, outs: [{ name: '摘要' }], error: '' };
    const noName = { ok: true, stopped: false, ms: 1000, outs: [{ name: '摘要' }, { name: '结果图' }], error: '' };
    const noLimit = { expectOk: true, maxMs: 0, minOuts: 0, outsNames: [] };
    return {
      ok: benchCheck(okRec, bench),
      fail: benchCheck(failRec, bench),
      stop: benchCheck(stopRec, bench),
      slow: benchCheck(slowRec, bench),
      few: benchCheck(fewOuts, bench),
      name: benchCheck(noName, bench),
      free: benchCheck({ ok: true, stopped: false, ms: 99999, outs: [] }, noLimit)
    };
  });
  check('全部满足 → 通过', r2.ok.pass === true && r2.ok.reasons.length === 0, JSON.stringify(r2.ok));
  check('运行失败 → 不通过且带原因', r2.fail.pass === false && /预期成功/.test(r2.fail.reasons[0]), JSON.stringify(r2.fail.reasons));
  check('手动停止 → 不算有效回归', r2.stop.pass === false && /手动停止/.test(r2.stop.reasons[0]), JSON.stringify(r2.stop.reasons));
  check('超时 → 报耗时对比', r2.slow.pass === false && /超过基准/.test(r2.slow.reasons[0]), JSON.stringify(r2.slow.reasons));
  check('输出数量不足 → 报数量', r2.few.pass === false && /少于基准/.test(r2.few.reasons[0]), JSON.stringify(r2.few.reasons));
  check('输出参数名缺失 → 报缺失项', r2.name.pass === false && /缺少输出参数/.test(r2.name.reasons[0]), JSON.stringify(r2.name.reasons));
  check('不设耗时上限时慢也不判负', r2.free.pass === true, JSON.stringify(r2.free));

  console.log('\n=== 3. 存取与注入式试跑 ===');
  const r3 = await page.evaluate(async () => {
    const list0 = await benchAll();
    const bench = { id: 'bt1', flowId: 'f1', flowName: '存取测试', expectOk: true, maxMs: 0, minOuts: 0, outsNames: [], created: Date.now(), last: null, history: [] };
    const saved = await benchSave(bench);
    const listed = await benchList('f1');
    const other = await benchList('f-other');
    const got = await benchGet('bt1');
    const run1 = await benchRunWith(bench, () => ({ ok: true, ms: 1200, failed: 0, outs: [] }));
    const run2 = await benchRunWith(run1.bench, () => ({ ok: false, ms: 800, failed: 1, outs: [], error: '炸了' }));
    const after = await benchGet('bt1');
    const del = await benchDelete('bt1');
    const gone = await benchGet('bt1');
    return {
      before: list0.length, saved, listed: listed.length, other: other.length,
      gotName: got ? got.flowName : '',
      pass1: run1.check.pass, histAfter1: run1.bench.history.length,
      pass2: run2.check.pass, histAfter2: after.history.length, lastPass: after.last.pass,
      failedReasons: run2.check.reasons.length,
      del, gone: gone === null
    };
  });
  check('保存成功', r3.saved === true);
  check('按流程筛选生效', r3.listed === 1 && r3.other === 0, r3.listed + '/' + r3.other);
  check('按 id 读取', r3.gotName === '存取测试');
  check('注入式试跑通过并落库', r3.pass1 === true && r3.histAfter1 === 1);
  check('失败结果覆盖 last 且历史累加', r3.pass2 === false && r3.histAfter2 === 2 && r3.lastPass === false);
  check('失败带原因', r3.failedReasons >= 1, String(r3.failedReasons));
  check('删除后读不到', r3.del === true && r3.gone === true);

  console.log('\n=== 4. 真实跑一遍（start → end） ===');
  const r4 = await page.evaluate(async () => {
    const s = newNode('start', 0, 0);
    s.params = [{ id: 'pin1', name: '文本', type: 'string', value: '你好' }];
    const e = newNode('end', 30, 0);
    e.params = [{ id: 'pout', name: '摘要', type: 'string', value: '' }];
    FLOWS.unshift({
      id: 'bench_ok', name: '基准流程', nodes: [s, e],
      links: [
        { id: 'bl1', from: { node: s.id, key: 'pin1' }, to: { node: e.id, key: 'pout' } },
        { id: 'bl2', from: { node: s.id, key: 'exec' }, to: { node: e.id, key: 'exec' } }
      ],
      vars: [], updated: Date.now(), lastRun: null
    });
    openFlow('bench_ok'); flushViewSwap();
    const bench = benchCapture(snapshotBp(), {});
    const res = await benchRunNow(bench);
    const saved = await benchGet(bench.id);
    return {
      pass: res.check.pass, reasons: res.check.reasons,
      saved: !!saved, lastMs: saved && saved.last ? saved.last.ms : -1,
      lastOuts: saved && saved.last ? saved.last.outs : -1,
      hist: saved ? saved.history.length : -1
    };
  });
  check('跑通后基准通过', r4.pass === true, JSON.stringify(r4.reasons));
  check('结果已落库', r4.saved === true && r4.hist === 1);
  check('记录到真实耗时', r4.lastMs > 0 && r4.lastMs < 30000, String(r4.lastMs));
  check('记录到输出数量', r4.lastOuts === 1, String(r4.lastOuts));

  console.log('\n=== 5. 失败流程判负（varSet 未连接值，不碰外部接口） ===');
  const r5 = await page.evaluate(async () => {
    const s = newNode('start', 0, 0);
    const vs = newNode('varSet', 30, 0);
    vs.data.varId = 'v1';
    FLOWS.unshift({
      id: 'bench_bad', name: '会失败的流程', nodes: [s, vs],
      links: [{ id: 'bl3', from: { node: s.id, key: 'exec' }, to: { node: vs.id, key: 'exec' } }],
      vars: [{ id: 'v1', name: '变量', type: 'string', value: '' }],
      updated: Date.now(), lastRun: null
    });
    openFlow('bench_bad'); flushViewSwap();
    const bench = benchCapture(snapshotBp(), {});
    const res = await benchRunNow(bench);
    return { pass: res.check.pass, reasons: res.check.reasons };
  });
  check('失败流程不通过', r5.pass === false, JSON.stringify(r5.reasons));
  check('原因指向预期成功实际失败', /预期成功，实际失败/.test(r5.reasons.join('；')), r5.reasons.join('；'));

  console.log('\n=== 6. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
