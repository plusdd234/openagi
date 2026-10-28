/* 分析任务（aiTask）超时与缺省兜底体检 —— 全程打桩，不发真实模型请求
 * 1) paramFallback：老流程节点没有 timeout 字段时，回退到声明缺省值（不再退化成 30 秒硬等待）
 * 2) 首段等待：任务超时能传到流层，报错里带真实耗时与上限
 * 3) 错误分型：一个字节都没收到 → 「上游没有返回任何数据」；
 *    收到数据但没有内容 → 「上游返回了数据但没有内容」
 * 用法：node tools/ai-task-timeout.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1400);

  // 配置 LLM（打桩目标）
  await page.evaluate(() => {
    $('llmKey').value = 'stub-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-vision';
    if ($('relayOn')) $('relayOn').checked = false;   // 直连打桩，避免被转到 8787
  });

  /* ---------- 1. 缺省兜底 ---------- */
  console.log('=== 1. 参数缺省兜底 ===');
  const fb = await page.evaluate(() => {
    const n = newNode('aiTask', 0, 0);
    const withField = JSON.parse(JSON.stringify(n.data));
    delete n.data.timeout;                       // 模拟老流程节点：没有 timeout 字段
    const declared = (NODE_PARAMS.aiTask.find(s => s.key === 'timeout') || {}).default;
    return {
      declared,
      fallbackTimeout: paramFallback(n, 'timeout'),
      fallbackRatio: paramFallback({ type: 'tripoImg', data: {} }, 'ratio'),
      fallbackMode: paramFallback({ type: 'tripoImg', data: {} }, 'mode'),
      withFieldTimeout: withField.timeout,
      unknownKey: paramFallback(n, 'notAParam'),
    };
  });
  check(fb.declared === 300, '分析任务声明缺省超时为 300 秒', String(fb.declared));
  check(fb.fallbackTimeout === 300, '节点无 timeout 字段时回退到声明缺省值', String(fb.fallbackTimeout));
  check(fb.withFieldTimeout === 300, '新建节点的 timeout 即为缺省值', String(fb.withFieldTimeout));
  check(fb.fallbackRatio === 'auto' && fb.fallbackMode === 'auto', '其他参数也能回退缺省值', fb.fallbackRatio + '/' + fb.fallbackMode);
  check(fb.unknownKey === undefined, '未声明的参数返回 undefined', String(fb.unknownKey));

  /* ---------- 2/3. 首段等待与错误分型 ---------- */
  console.log('=== 2. 首段等待与错误分型 ===');

  const runCase = (mode, timeoutSec) => page.evaluate(async ({ mode, timeoutSec }) => {
    // 打桩：返回一个只发心跳、不发内容的 SSE 流（mode='bytes'）；或完全不吐字节（mode='none'）
    // 必须响应 init.signal，否则 abort 时读流永不结束（测试会挂住）
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/chat\/completions/.test(url)) {
        const enc = new TextEncoder();
        const sig = init && init.signal;
        const stream = new ReadableStream({
          start(c) {
            if (mode === 'bytes') c.enqueue(enc.encode(': ping\n\n'));
            if (sig) {
              const abortErr = () => c.error(new DOMException('Aborted', 'AbortError'));
              if (sig.aborted) abortErr();
              else sig.addEventListener('abort', abortErr);
            }
            // 永不 close：模拟上游挂住
          }
        });
        return Promise.resolve(new Response(stream, {
          status: 200, headers: { 'Content-Type': 'text/event-stream' }
        }));
      }
      return orig.apply(this, arguments);
    };

    const flow = { id: 'tt_' + Date.now(), name: '超时体检', nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null };
    const s = newNode('start', -320, 0);
    const t = newNode('aiTask', 40, 0);
    t.data.instruction = '分析这张图';
    t.data.timeout = timeoutSec;
    flow.nodes = [s, t];
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: t.id, key: 'exec' } },
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    // 安全网：桩若没响应 abort，10 秒后强行结束，避免测试整体挂死
    await Promise.race([runFlow(), new Promise(r => setTimeout(r, 10000))]);
    const node = bp.nodes.find(n => n.type === 'aiTask');
    const out = { status: node.status, error: node.error || '' };
    window.fetch = orig;
    return out;
  }, { mode, timeoutSec });

  const none = await runCase('none', 3);
  check(/没有返回任何数据/.test(none.error), '一个字节都没收到 → 「上游没有返回任何数据」', none.error.slice(0, 70));
  check(/已等待 \d+ 秒/.test(none.error), '报错带真实耗时', (none.error.match(/已等待 \d+ 秒/) || [''])[0]);
  check(/首段上限 3 秒/.test(none.error), '报错带首段上限（任务超时已生效）', (none.error.match(/首段上限 \d+ 秒/) || [''])[0]);

  const bytes = await runCase('bytes', 3);
  check(/返回了数据但没有内容/.test(bytes.error), '收到数据但无内容 → 区分提示', bytes.error.slice(0, 60));

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
