/* 运行停止按钮体检（不触桥、不耗积分；LLM 用「永不返回」的桩模拟卡住的任务）
 * 护栏：window.fetch 拦截 127.0.0.1:8790（Tripo 桥）；LLM 桩记录 abort 次数。
 * 1) 按钮形态：平时隐藏，运行中显示，结束后收起
 * 2) 停止在途请求：fetch 收到 abort（signal 被 abort → 桩里 reject AbortError）
 * 3) 节点状态：正在跑的节点标「已停止」（不算失败），下游不再激活
 * 4) 收尾：运行按钮恢复可点、bpRunBusy 归位、控制器清空、日志留痕
 * 5) 未运行时点停止是空操作，不报错
 * 用法：node tools/stop-flow.js
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

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    window.__bridgeCalls = [];
    window.__aborted = 0;
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ message: '测试环境已禁用真实桥调用' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        }));
      }
      if (/stub\.test/.test(url)) {
        // 永不返回：模拟上游卡住，只能靠 abort 中断
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            window.__aborted++;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          };
          const sig = init && init.signal;
          if (sig) {
            if (sig.aborted) return onAbort();
            sig.addEventListener('abort', onAbort);
          }
        });
      }
      return orig.apply(this, arguments);
    };
    $('llmKey').value = 'test-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-slow';
    if ($('relayOn')) $('relayOn').checked = false;
  });

  /* ---------- 1. 按钮形态 ---------- */
  const before = await page.evaluate(() => {
    const s = newNode('start', -420, 0);
    const t = newNode('text', -220, 120);
    t.data.text = '一段待分析的文本';
    const a = newNode('aiTask', 40, 0);
    a.data.instruction = '总结这段文本';
    const r = newNode('result', 420, 0);
    const flow = { id: 'stop_' + Date.now(), name: '停止按钮体检', nodes: [s, t, a, r], links: [], vars: [], updated: Date.now(), lastRun: null };
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: a.id, key: 'exec' } },
      { id: uid(), from: { node: a.id, key: 'exec' }, to: { node: r.id, key: 'exec' } },
      { id: uid(), from: { node: t.id, key: 'text' }, to: { node: a.id, key: a.data.inputs[0].id } },
      { id: uid(), from: { node: a.id, key: a.data.outputs[0].id }, to: { node: r.id, key: 'text' } }
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    window.__ids = { a: a.id, r: r.id };
    return {
      stopHidden: $('btnBpStop').classList.contains('hidden'),
      runText: $('btnBpRun').textContent.trim(),
      noop: (typeof stopFlow === 'function') ? (stopFlow(), 'ok') : 'missing'
    };
  });
  console.log('=== 1. 按钮初始形态 ===');
  check(before.stopHidden, '未运行时「停止」按钮隐藏');
  check(before.runText === '运行', '运行按钮文案为「运行」', before.runText);
  check(before.noop === 'ok', '未运行时点停止是空操作（不报错）');

  /* ---------- 2~4. 运行 → 点停止 → 收尾 ---------- */
  const stopped = await page.evaluate(async () => {
    const run = runFlow();                       // 不 await：等它卡在上游
    await new Promise(r => setTimeout(r, 600));
    const during = {
      stopShown: !$('btnBpStop').classList.contains('hidden'),
      stopEnabled: !$('btnBpStop').disabled,
      runDisabled: $('btnBpRun').disabled,
      busy: bpRunBusy,
      hasCtrl: !!bpRunCtrl
    };
    $('btnBpStop').click();
    await run;                                   // 停止后 runFlow 应尽快返回
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    const r = bp.nodes.find(n => n.id === window.__ids.r);
    return {
      during,
      elapsedAborted: window.__aborted,
      aStatus: a.status, aErr: a.error || '',
      rStatus: r.status,
      busy: bpRunBusy,
      ctrl: bpRunCtrl,
      abort: bpRunAbort,
      runText: $('btnBpRun').textContent.trim(),
      runDisabled: $('btnBpRun').disabled,
      stopHidden: $('btnBpStop').classList.contains('hidden'),
      log: Array.from(document.querySelectorAll('.bp-log-row')).map(x => x.textContent).join(' | '),
      bridge: window.__bridgeCalls.slice()
    };
  });

  console.log('\n=== 2. 运行中 ===');
  check(stopped.during.stopShown, '运行中「停止」按钮出现');
  check(stopped.during.stopEnabled, '停止按钮可点');
  check(stopped.during.runDisabled && stopped.during.busy, '运行按钮禁用、bpRunBusy 为真');
  check(stopped.during.hasCtrl, '已建立中断控制器');

  console.log('\n=== 3. 停止效果 ===');
  check(stopped.elapsedAborted >= 1, '在途请求收到 abort（解析流 / 生成请求已断）', 'abort=' + stopped.elapsedAborted);
  check(stopped.aStatus === 'stopped', '正在执行的节点标记为已停止', stopped.aStatus + ' ' + stopped.aErr);
  check(stopped.rStatus !== 'ok', '下游节点不再被激活', 'status=' + stopped.rStatus);

  console.log('\n=== 4. 收尾 ===');
  check(stopped.busy === false, 'bpRunBusy 归位');
  check(stopped.ctrl === null && stopped.abort === false, '中断控制器已清空', String(stopped.ctrl) + '/' + stopped.abort);
  check(stopped.runText === '运行' && stopped.runDisabled === false, '运行按钮恢复', stopped.runText);
  check(stopped.stopHidden, '停止按钮重新收起');
  check(/已停止/.test(stopped.log), '日志留痕（已停止）', stopped.log.slice(-90));
  check(!/失败/.test(stopped.log) || /已停止/.test(stopped.log), '停止不算失败');
  check(stopped.bridge.length === 0, '护栏：全程零桥请求', '次数=' + stopped.bridge.length);

  /* ---------- 5. 停止后还能正常再跑一次 ---------- */
  const again = await page.evaluate(async () => {
    const guard = window.fetch;
    window.__llmCalls = 0;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__llmCalls++;
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '摘要：一切正常' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    const r = bp.nodes.find(n => n.id === window.__ids.r);
    return { aStatus: a.status, rStatus: r.status, rText: r.out.text || '', calls: window.__llmCalls, busy: bpRunBusy };
  });
  console.log('\n=== 5. 停止后可再次运行 ===');
  check(again.aStatus === 'ok' && again.rStatus === 'ok', '重跑成功（状态未被残留中断标志污染）',
    again.aStatus + '/' + again.rStatus);
  check(again.rText.indexOf('摘要') === 0, '下游拿到结果', again.rText);
  check(again.busy === false, '运行结束后空闲');

  await browser.close();
  const noise = errors.filter(e => !/Failed to load resource/.test(e));
  console.log('\n页面错误：' + (noise.length ? noise.slice(0, 5).join(' | ') : '无'));
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('体检失败：', e.stack); process.exit(1); });
