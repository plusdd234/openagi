/* 思考过程（reasoning / thinking）体检：不触桥、不耗积分，LLM 全部打桩为本地 SSE
 * 护栏：window.fetch 拦截 127.0.0.1:8790（Tripo 桥）；LLM 桩返回本地构造的流。
 * 1) 流式思考：节点状态先「思考中 N 字」再「生成中 N 字」，日志实时显示思考片段
 * 2) 节点上折叠保留思考过程（运行结束后仍可回看）
 * 3) 非流式 JSON 带 reasoning_content 时同样显示
 * 4) 关键回归：思考阶段不再被「首段等待」误判成连接问题（原先会报「上游返回了数据但没有内容」）
 * 5) 设置开关：勾选后请求体带 enable_thinking，不勾则不带
 * 6) 基线对话：状态区分思考/生成，气泡里折叠显示思考过程
 * 用法：node tools/ai-thinking.js
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

// 页面内安装桩：script 决定推什么（reasoning 块 / 正文块 / 延迟）
const STUB = `
window.__installStub = (script) => {
  window.__bridgeCalls = [];
  window.__llmBodies = [];
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/127\\.0\\.0\\.1:8790|localhost:8790/.test(url)) {
      window.__bridgeCalls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ message: '测试环境已禁用真实桥调用' }), {
        status: 503, headers: { 'Content-Type': 'application/json' }
      }));
    }
    if (/stub\\.test/.test(url)) {
      window.__llmBodies.push((init && init.body) || '');
      const chunks = script();
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder();
          for (const it of chunks) {
            if (it.wait) await new Promise(r => setTimeout(r, it.wait));
            const payload = it.json ? JSON.stringify(it.json) : '[DONE]';
            c.enqueue(enc.encode('data: ' + payload + '\\n\\n'));
          }
          c.enqueue(enc.encode('data: [DONE]\\n\\n'));
          c.close();
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200, headers: { 'Content-Type': 'text/event-stream' }
      }));
    }
    return orig.apply(this, arguments);
  };
};
`;

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(STUB);

  await page.evaluate(() => {
    $('llmKey').value = 'test-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-think';
    if ($('relayOn')) $('relayOn').checked = false;
    if ($('llmThink')) $('llmThink').checked = false;
    // 流程：开始 → 分析任务 → 结果
    const s = newNode('start', -420, 0);
    const t = newNode('text', -220, 140);
    t.data.text = '待分析的文本';
    const a = newNode('aiTask', 40, 0);
    a.data.instruction = '总结这段文本';
    a.data.timeout = 60;
    const r = newNode('result', 420, 0);
    const flow = { id: 'th_' + Date.now(), name: '思考过程体检', nodes: [s, t, a, r], links: [], vars: [], updated: Date.now(), lastRun: null };
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: a.id, key: 'exec' } },
      { id: uid(), from: { node: a.id, key: 'exec' }, to: { node: r.id, key: 'exec' } },
      { id: uid(), from: { node: t.id, key: 'text' }, to: { node: a.id, key: a.data.inputs[0].id } },
      { id: uid(), from: { node: a.id, key: a.data.outputs[0].id }, to: { node: r.id, key: 'text' } }
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    window.__ids = { a: a.id, r: r.id };
  });

  /* ---------- 1~2. 流式：思考 → 正文，状态与日志要分开显示 ---------- */
  const run1 = await page.evaluate(async () => {
    const seen = [];
    const origStatus = (() => {
      // 抓取节点状态与日志的实时文案
      const obs = new MutationObserver(() => {
        const el = document.getElementById('n-' + window.__ids.a);
        const st = el && el.querySelector('.node-status');
        const txt = st && st.textContent ? st.textContent : '';
        const last = document.querySelector('.bp-log-row.live .bp-log-msg');
        const log = last ? last.textContent : '';
        const rec = { s: txt, l: log };
        const prev = seen[seen.length - 1];
        if (!prev || prev.s !== rec.s || prev.l !== rec.l) seen.push(rec);
      });
      obs.observe(document.getElementById('bpNodes'), { subtree: true, childList: true, characterData: true, attributes: true });
      obs.observe(document.getElementById('bpLogBody'), { subtree: true, childList: true, characterData: true });
      return obs;
    })();
    window.__installStub(() => [
      { json: { choices: [{ delta: { reasoning_content: '先确认输入长度，' } }] } },
      { json: { choices: [{ delta: { reasoning_content: '再归纳要点。' } }] } },
      { json: { choices: [{ delta: { content: '摘要：' } }] } },
      { json: { choices: [{ delta: { content: '一切正常。' } }] } }
    ]);
    await runFlow();
    origStatus.disconnect();
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    const r = bp.nodes.find(n => n.id === window.__ids.r);
    const el = document.getElementById('n-' + a.id);
    const det = el.querySelector('.node-think');
    return {
      seen,
      status: a.status,
      reasoning: a.reasoning || '',
      nodeThinkLabel: det ? det.querySelector('summary').textContent : '',
      nodeThinkText: det ? det.querySelector('.node-result').textContent : '',
      rText: r.out.text || '',
      bodies: window.__llmBodies.slice(),
      bridge: window.__bridgeCalls.slice()
    };
  });

  console.log('=== 1. 流式思考：状态与日志 ===');
  const statuses = run1.seen.map(x => x.s).filter(Boolean);
  const logs = run1.seen.map(x => x.l).filter(Boolean);
  check(statuses.some(s => /^思考中 \d+ 字$/.test(s)), '节点状态出现「思考中 N 字」', JSON.stringify(statuses.slice(0, 4)));
  check(statuses.some(s => /^生成中 \d+ 字$/.test(s)), '节点状态随后切到「生成中 N 字」', JSON.stringify(statuses.slice(-2)));
  check(statuses.findIndex(s => /^思考中/.test(s)) < statuses.findIndex(s => /^生成中/.test(s)), '顺序正确：先思考后生成');
  check(logs.some(l => /思考中 \d+ 字/.test(l)), '运行日志实时显示思考进度', (logs.find(l => /思考中/.test(l)) || '').slice(0, 40));
  check(logs.some(l => /先确认输入长度|再归纳要点/.test(l)), '日志带出思考内容尾部', (logs.find(l => /归纳/.test(l)) || '').slice(-30));

  console.log('\n=== 2. 节点保留思考过程 ===');
  check(run1.status === 'ok', '节点运行成功', run1.status);
  check(/先确认输入长度/.test(run1.reasoning) && /再归纳要点/.test(run1.reasoning), '思考内容完整拼接', run1.reasoning);
  check(/^思考过程 · \d+ 字$/.test(run1.nodeThinkLabel), '节点上有折叠的「思考过程」块', run1.nodeThinkLabel);
  check(run1.nodeThinkText === run1.reasoning, '折叠块内容与思考一致');
  check(run1.rText === '摘要：一切正常。', '正文结果不受影响', run1.rText);
  check(!/enable_thinking/.test(run1.bodies[0] || ''), '默认不带 enable_thinking（避免不兼容网关报错）');
  check(run1.bridge.length === 0, '护栏：全程零桥请求');

  /* ---------- 3. 非流式 JSON 带 reasoning ---------- */
  const run2 = await page.evaluate(async () => {
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { reasoning_content: '非流式思考', content: '非流式答案' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    await runFlow();
    const el = document.getElementById('n-' + a.id);
    const det = el.querySelector('.node-think');
    return { status: a.status, reasoning: a.reasoning || '', label: det ? det.querySelector('summary').textContent : '' };
  });
  console.log('\n=== 3. 非流式响应 ===');
  check(run2.status === 'ok' && run2.reasoning === '非流式思考', '非流式 JSON 的 reasoning_content 也能取到', run2.reasoning);
  check(/思考过程/.test(run2.label), '同样在节点上展示', run2.label);

  /* ---------- 4. 关键回归：思考阶段不被首段计时器误杀 ---------- */
  const run3 = await page.evaluate(async () => {
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    a.data.timeout = 10;                       // 首段上限 10 秒
    window.__installStub(() => [
      { json: { choices: [{ delta: { reasoning_content: '这条要慢慢想……' } }] } },
      { wait: 12000, json: { choices: [{ delta: { content: '迟到但正确的答案' } }] } }   // 12 秒后才吐正文
    ]);
    await runFlow();
    return { status: a.status, err: a.error || '', out: a.out[a.data.outputs[0].id] || '', reasoning: a.reasoning || '' };
  });
  console.log('\n=== 4. 思考阶段不再被当成「连接问题」===');
  check(run3.status === 'ok', '思考超过首段上限后仍能正常出结果（不再误报上游没数据）', run3.status + ' ' + run3.err);
  check(run3.out === '迟到但正确的答案', '正文完整', run3.out);
  check(/慢慢想/.test(run3.reasoning), '思考内容保留', run3.reasoning);

  /* ---------- 5. 设置开关 → 请求体 ---------- */
  const run4 = await page.evaluate(async () => {
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    a.data.timeout = 60;
    const bodies = [];
    const send = async (checked) => {
      $('llmThink').checked = checked;
      window.__installStub(() => [{ json: { choices: [{ delta: { content: 'ok' } }] } }]);
      await runFlow();
      bodies.push(window.__llmBodies[window.__llmBodies.length - 1] || '');
    };
    await send(false);
    await send(true);
    $('llmThink').checked = false;
    return bodies;
  });
  console.log('\n=== 5. 思考开关 ===');
  check(!/enable_thinking/.test(run4[0]), '未勾选：请求体不带 enable_thinking');
  check(/enable_thinking"\s*:\s*true/.test(run4[1]), '勾选后：请求体带 enable_thinking', (run4[1] || '').slice(-60));

  /* ---------- 6. 桌面对话（第二页）：状态分阶段 + 气泡折叠思考 ----------
     原来的「基线工具 → 对话」面板已整块移除，覆盖点跟着搬到现在的对话入口：
     底部输入条发送后翻到的第二页。 */
  const chat = await page.evaluate(async () => {
    // 造一个指向桩地址的可选模型，让 connFor 的校验能通过（不发真实请求）
    const sel = document.getElementById('deskAiModel');
    if (!Array.from(sel.options).some(o => o.value === 'local:stub-think')) {
      const op = document.createElement('option');
      op.value = 'local:stub-think';
      op.textContent = 'stub-think';
      sel.appendChild(op);
    }
    sel.value = 'local:stub-think';
    document.getElementById('llmModel').value = 'stub-think';

    window.__installStub(() => [
      { json: { choices: [{ delta: { reasoning_content: '用户问的是可用性，' } }] } },
      { json: { choices: [{ delta: { reasoning_content: '先确认配置。' } }] } },
      { json: { choices: [{ delta: { content: '可用。' } }] } }
    ]);
    // 桩流几毫秒就跑完：用 MutationObserver 抓状态点的每一次文案变化
    const dot = document.getElementById('deskAiDot');
    const seen = [];
    const push = () => {
      const t = (dot.title || '').trim();
      if (t && seen[seen.length - 1] !== t) seen.push(t);
    };
    const obs = new MutationObserver(push);
    obs.observe(dot, { attributes: true, attributeFilter: ['title', 'class'] });
    document.getElementById('deskAiText').value = '接口能用吗';
    await window.deskChat.send();
    obs.disconnect();
    const all = window.deskChat.msgs();
    const last = all[all.length - 1] || {};
    const det = document.querySelector('.dchat-think');
    return {
      seen: [...new Set(seen)],
      content: last.content || '', reasoning: last.reasoning || '',
      label: det ? det.querySelector('summary').textContent : '',
      thinkText: det ? det.querySelector('div').textContent : ''
    };
  });
  console.log('\n=== 6. 桌面对话：状态分阶段 + 气泡折叠思考 ===');
  check(chat.seen.some(s => /^思考中 \d+ 字$/.test(s)), '状态点先显示「思考中 N 字」', JSON.stringify(chat.seen.slice(0, 4)));
  check(chat.seen.some(s => /^生成中 \d+ 字$/.test(s)), '随后切到「生成中 N 字」', JSON.stringify(chat.seen.slice(-2)));
  // 只比较「思考中 N 字 / 生成中 N 字」两种阶段文案（前面还有一条「生成中…」占位，不算）
  const phases = chat.seen.filter(s => /^(思考中|生成中) \d+ 字$/.test(s));
  check(phases.findIndex(s => /^思考中/.test(s)) < phases.findIndex(s => /^生成中/.test(s)), '顺序正确：先思考后生成', JSON.stringify(phases));
  check(chat.content === '可用。', '正文正确', chat.content);
  check(/用户问的是可用性/.test(chat.reasoning), '思考内容存到消息上', chat.reasoning);
  check(/^思考过程 · \d+ 字$/.test(chat.label), '气泡里折叠展示思考过程', chat.label);

  /* ---------- 7. 内联 <think>…（标签被分片截断）---------- */
  const run7 = await page.evaluate(async () => {
    const a = bp.nodes.find(n => n.id === window.__ids.a);
    // 流式：标签正好在分片边界被切开
    window.__installStub(() => [
      { json: { choices: [{ delta: { content: '<th' } }] } },
      { json: { choices: [{ delta: { content: 'ink>先算' } }] } },
      { json: { choices: [{ delta: { content: '一下</thi' } }] } },
      { json: { choices: [{ delta: { content: 'nk>答案是 42' } }] } }
    ]);
    await runFlow();
    const streamed = { reasoning: a.reasoning || '', out: a.out[a.data.outputs[0].id] || '', status: a.status };
    // 非流式：整段带 think 标签
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '<think>非流式也想</think>最终答案' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    const plain = { reasoning: a.reasoning || '', out: a.out[a.data.outputs[0].id] || '', status: a.status };
    return { streamed, plain };
  });
  console.log('\n=== 7. 内联 <think>（部分网关把思考塞进正文）===');
  check(run7.streamed.status === 'ok' && run7.streamed.reasoning === '先算一下',
    '流式：跨分片的 <think> 内容进思考，不混进正文', JSON.stringify(run7.streamed));
  check(run7.streamed.out === '答案是 42', '流式：正文干净（没有残留半个标签）', run7.streamed.out);
  check(run7.plain.reasoning === '非流式也想' && run7.plain.out === '最终答案',
    '非流式：整段 <think> 也拆得干净', JSON.stringify(run7.plain));

  const bridgeCalls = await page.evaluate(() => window.__bridgeCalls.slice());
  check(bridgeCalls.length === 0, '护栏：全程零桥请求', '次数=' + bridgeCalls.length);

  await browser.close();
  const noise = errors.filter(e => !/Failed to load resource/.test(e));
  console.log('\n页面错误：' + (noise.length ? noise.slice(0, 5).join(' | ') : '无'));
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('体检失败：', e.stack); process.exit(1); });
