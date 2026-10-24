/* aiBranch「AI 分支」节点体检（全程不调用真实 LLM、不触桥、不耗积分）
 * 护栏：window.fetch 拦截 127.0.0.1:8790（Tripo 桥）；LLM 端点由各测试节单独打桩。
 * 1) 节点库 / 标题 / 引脚渲染（text + image 输入，text 输出，动态 exec 出口）
 * 2) pinType 把分支出口识别成 exec（执行线分类的关键回归点）
 * 3) 动态出口：添加 / 预设 / 重命名 / 兜底互斥 / 删除（含连线清理）
 * 4) 打桩 LLM：选中哪条出口就只走哪条执行线，另一条不激活
 * 5) 容错：markdown 围栏 + 前后杂语；模型乱答 → 走兜底出口（无兜底走第一条）
 * 6) 缺出口 / 既无依据也无上下文 → 友好报错且零 LLM 请求
 * 用法：node tools/ai-branch-node.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储

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

  /* ---- 护栏：拦桥（8790）；LLM 配置指向桩域名 ---- */
  await page.evaluate(() => {
    window.__bridgeCalls = [];
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ message: '测试环境已禁用真实桥调用' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        }));
      }
      return orig.apply(this, arguments);
    };
    $('llmKey').value = 'test-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-router';
    if ($('relayOn')) $('relayOn').checked = false;
  });

  /* ---------- 1. 渲染：引脚 + 参数 + 动态出口 ---------- */
  const ui = await page.evaluate(() => {
    const A = newNode('aiBranch', 40, 0);
    const flow = { id: 'ab_' + Date.now(), name: 'aiBranch 体检', nodes: [A], links: [], vars: [], updated: Date.now(), lastRun: null };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const el = document.getElementById('n-' + A.id);
    const pins = d => Array.from(el.querySelectorAll('.pin.' + d)).map(p => ({ key: p.dataset.key, type: p.dataset.type }));
    const execOut = Array.from(el.querySelectorAll('.exec-row.out')).map(r => ({
      key: (r.querySelector('.pin') || {}).dataset ? r.querySelector('.pin').dataset.key : '',
      type: (r.querySelector('.pin') || {}).dataset ? r.querySelector('.pin').dataset.type : '',
      label: (r.firstElementChild.textContent || '').trim()
    }));
    const names = Array.from(el.querySelectorAll('.branch-pin .view-name')).map(i => i.value);
    const presets = Array.from(el.querySelectorAll('.view-preset')).map(b => (b.textContent || '').trim());
    const addBtn = Array.from(el.querySelectorAll('.task-add')).map(b => (b.textContent || '').trim());
    const fbBtns = Array.from(el.querySelectorAll('.branch-fallback')).map(b => (b.textContent || '').trim());
    const paramRows = Array.from(el.querySelectorAll('.port-row.has-param')).map(r => {
      const label = ((r.querySelector('.port-label') || {}).textContent || '').trim();
      const ctl = r.querySelector('select, input, textarea');
      return { label, ctl: ctl ? ctl.tagName.toLowerCase() : '', value: ctl ? ctl.value : '' };
    });
    return {
      in: pins('in'), out: pins('out'), execIn: !!el.querySelector('.pin.exec.in'), execOut,
      names, presets, addBtn, fbBtns, paramRows,
      libHas: NODE_LIB.reduce((a, g) => a.concat(g.types), []).includes('aiBranch'),
      title: ((el.querySelector('.node-title') || {}).textContent || '').trim(),
      def: NODE_DEFS.aiBranch,
      branches: A.data.branches.map(b => b.name),
      nodeId: A.id
    };
  });

  console.log('=== 1. aiBranch 节点渲染 ===');
  check(ui.libHas, '节点库可添加 aiBranch');
  check(ui.title === 'AI 分支', '节点标题正确', ui.title);
  check(ui.execIn, '带执行线入口');
  check(ui.execOut.length === 2, '两条动态执行线出口', JSON.stringify(ui.execOut));
  check(ui.execOut.every(p => p.type !== undefined) && JSON.stringify(ui.execOut.map(p => p.label)) === '["分支 A","分支 B"]',
    '出口标签跟随分支名', JSON.stringify(ui.execOut.map(p => p.label)));
  check(JSON.stringify(ui.branches) === '["分支 A","分支 B"]', '默认预填两条出口', JSON.stringify(ui.branches));
  check(ui.in.some(p => p.key === 'text' && p.type === 'string'), '输入引脚：text', JSON.stringify(ui.in.map(p => p.key)));
  check(ui.in.some(p => p.key === 'image' && p.type === 'image'), '输入引脚：image');
  check(ui.out.some(p => p.key === 'text' && p.type === 'string'), '输出引脚：text（选择结果）');
  check(ui.presets.length === 3 && ui.presets.includes('兜底'), '常用出口预设标签', JSON.stringify(ui.presets));
  check(ui.addBtn.some(t => t.includes('添加出口')), '「+ 添加出口」按钮存在', JSON.stringify(ui.addBtn));
  check(ui.fbBtns.length === 2, '每条出口带「兜底」标记按钮', '数量=' + ui.fbBtns.length);
  const plabels = ui.paramRows.map(r => r.label).join('|');
  ['选择依据', '超时'].forEach(k => check(plabels.includes(k), '参数行含「' + k + '」'));
  const tRow = ui.paramRows.find(r => r.label === '超时');
  check(tRow && tRow.value === '120', '超时默认 120 秒', tRow && tRow.value);

  /* ---------- 2. pinType：分支出口必须识别为 exec ---------- */
  const typing = await page.evaluate(() => {
    const n = bp.nodes.find(x => x.type === 'aiBranch');
    const b = n.data.branches;
    return {
      b0: pinType(n, b[0].id), b1: pinType(n, b[1].id),
      text: pinType(n, 'text'), image: pinType(n, 'image'),
      dynPins: execPinsOf(n).map(p => p.type)
    };
  });
  console.log('\n=== 2. 引脚类型（执行线分类）===');
  check(typing.b0 === 'exec' && typing.b1 === 'exec', '分支出口 pinType = exec', typing.b0 + '/' + typing.b1);
  check(JSON.stringify(typing.dynPins) === '["exec","exec"]', 'execPinsOf 返回动态出口', JSON.stringify(typing.dynPins));
  check(typing.text === 'string' && typing.image === 'image', '数据引脚类型不受影响', typing.text + '/' + typing.image);

  /* ---------- 3. 动态出口增删改 + 兜底互斥 ---------- */
  const dyn = await page.evaluate(() => {
    const n = bp.nodes.find(x => x.type === 'aiBranch');
    const el = document.getElementById('n-' + n.id);
    // 添加
    Array.from(el.querySelectorAll('.task-add')).find(b => b.textContent.includes('添加出口')).click();
    const afterAdd = n.data.branches.map(b => b.name);
    // 预设「兜底」
    Array.from(document.getElementById('n-' + n.id).querySelectorAll('.view-preset')).find(b => b.textContent === '兜底').click();
    const afterPreset = n.data.branches.map(b => b.name);
    // 重复预设被拒
    Array.from(document.getElementById('n-' + n.id).querySelectorAll('.view-preset')).find(b => b.textContent === '兜底').click();
    const afterDup = n.data.branches.length;
    // 重命名第一条
    let el2 = document.getElementById('n-' + n.id);
    const nameInput = el2.querySelector('.branch-pin .view-name');
    nameInput.value = '轻量修复';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    const renamedLabels = Array.from(document.getElementById('n-' + n.id)
      .querySelectorAll('.exec-row.out')).map(r => r.firstElementChild.textContent.trim());
    // 兜底互斥：先给第 2 条设兜底，再给第 3 条设兜底 → 只剩第 3 条
    el2 = document.getElementById('n-' + n.id);
    el2.querySelectorAll('.branch-fallback')[1].click();
    const fb1 = n.data.branches.map(b => !!b.fallback);
    el2 = document.getElementById('n-' + n.id);
    el2.querySelectorAll('.branch-fallback')[2].click();
    const fb2 = n.data.branches.map(b => !!b.fallback);
    // 删除最后一条（其执行线应一并清理）
    const delId = n.data.branches[3].id;
    el2 = document.getElementById('n-' + n.id);
    el2.querySelectorAll('.branch-pin .param-del')[3].click();
    return {
      afterAdd, afterPreset, afterDup, renamedLabels, fb1, fb2,
      afterDel: n.data.branches.map(b => b.name),
      delId,
      execOutCount: document.getElementById('n-' + n.id).querySelectorAll('.exec-row.out').length
    };
  });
  console.log('\n=== 3. 动态出口增删改 / 兜底互斥 ===');
  check(JSON.stringify(dyn.afterAdd) === '["分支 A","分支 B","分支 3"]', '「+ 添加出口」新增一条', JSON.stringify(dyn.afterAdd));
  check(dyn.afterPreset.includes('兜底'), '预设「兜底」一键添加', JSON.stringify(dyn.afterPreset));
  check(dyn.afterDup === 4, '重复预设被拒绝', '数量=' + dyn.afterDup);
  check(dyn.renamedLabels[0] === '轻量修复', '重命名后出口引脚标签联动', JSON.stringify(dyn.renamedLabels));
  check(JSON.stringify(dyn.fb1) === '[false,true,false,false]', '设置第 2 条为兜底', JSON.stringify(dyn.fb1));
  check(JSON.stringify(dyn.fb2) === '[false,false,true,false]', '兜底互斥：改设第 3 条后第 2 条自动取消', JSON.stringify(dyn.fb2));
  check(dyn.afterDel.length === 3 && !dyn.afterDel.includes('兜底'), '删除出口生效', JSON.stringify(dyn.afterDel));
  check(dyn.execOutCount === 3, '删除后执行线出口同步减少', '出口数=' + dyn.execOutCount);

  /* ---------- 4. 打桩 LLM：只走被选中的那条执行线 ---------- */
  const run1 = await page.evaluate(async () => {
    const n = bp.nodes.find(x => x.type === 'aiBranch');
    // 重建一条干净流程：start → aiBranch →（分支 A / 分支 B）→ 两个结果输出
    n.data.branches = [branchEntry('轻量修复'), branchEntry('精细重绘')];
    n.data.instruction = '按图像复杂度选择修复方式';
    const s = bp.nodes.find(x => x.type === 'start') || newNode('start', -420, 0);
    if (!bp.nodes.includes(s)) bp.nodes.push(s);
    const rA = newNode('result', 460, -140);
    const rB = newNode('result', 460, 140);
    const src = newNode('text', -220, 200);
    src.data.text = '这是一张轻微破损的老照片';
    bp.nodes = [s, n, rA, rB, src];
    const B = n.data.branches[1];
    bp.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: n.id, key: 'exec' } },
      { id: uid(), from: { node: n.id, key: n.data.branches[0].id }, to: { node: rA.id, key: 'exec' } },
      { id: uid(), from: { node: n.id, key: B.id }, to: { node: rB.id, key: 'exec' } },
      { id: uid(), from: { node: src.id, key: 'text' }, to: { node: n.id, key: 'text' } },
      { id: uid(), from: { node: n.id, key: 'text' }, to: { node: rA.id, key: 'text' } },
      { id: uid(), from: { node: n.id, key: 'text' }, to: { node: rB.id, key: 'text' } }
    ];
    renderNodes();
    window.__llmCalls = [];
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__llmCalls.push({ url, body: (init && init.body) || '' });
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ choice: '精细重绘', reason: '破损较多' }) } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    const chosenRows = Array.from(document.getElementById('n-' + n.id).querySelectorAll('.branch-box.chosen'));
    return {
      status: n.status, err: n.error || '',
      choice: n.out.choice, text: n.out.text || '', B: B.id,
      chosenRows: chosenRows.length,
      chosenName: chosenRows.length ? chosenRows[0].querySelector('.view-name').value : '',
      rA: { status: rA.status, text: rA.out.text || '' },
      rB: { status: rB.status, text: rB.out.text || '' },
      llm: window.__llmCalls.slice(), bridge: window.__bridgeCalls.slice()
    };
  });
  console.log('\n=== 4. 打桩 LLM 执行（选中「精细重绘」）===');
  check(run1.status === 'ok', '节点运行成功', run1.status + ' ' + run1.err);
  check(run1.choice === run1.B, 'out.choice 指向被选中的出口', run1.choice === run1.B ? 'ok' : run1.choice);
  check(/已选择「精细重绘」/.test(run1.text) && /破损较多/.test(run1.text), 'text 输出选择结果与理由', run1.text);
  check(run1.rB.status === 'ok' && run1.rB.text.indexOf('已选择') === 0, '被选中出口的下游已激活', run1.rB.status);
  check(run1.rA.status === '' && run1.rA.text === '', '未选中出口的下游未激活', 'status=' + run1.rA.status);
  check(run1.chosenRows === 1 && run1.chosenName === '精细重绘', '节点上「已选择」标记落在被选中的出口',
    run1.chosenRows + ' 条 / ' + run1.chosenName);
  check(run1.llm.length === 1, 'LLM 请求一次', '次数=' + run1.llm.length);
  const body = run1.llm.length ? JSON.parse(run1.llm[0].body) : {};
  const uc = body.messages && body.messages[1] && body.messages[1].content;
  const userText = Array.isArray(uc) ? uc.map(c => c.text || '').join('\n') : '';
  check(/轻量修复/.test(userText) && /精细重绘/.test(userText), '请求体包含出口清单', userText.slice(0, 50));
  check(/按图像复杂度选择修复方式/.test(userText), '请求体包含选择依据');
  check(/轻微破损的老照片/.test(userText), '请求体包含上下文文本');
  check(run1.bridge.length === 0, '全程零桥请求（不误触发生成）');

  /* ---------- 5. 容错：围栏 JSON / 乱答走兜底 ---------- */
  const run2 = await page.evaluate(async () => {
    const n = bp.nodes.find(x => x.type === 'aiBranch');
    const stub = content => {
      const guard = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/stub\.test/.test(url)) {
          window.__llmCalls.push(1);
          return Promise.resolve(new Response(JSON.stringify({
            choices: [{ message: { content } }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return guard.apply(this, arguments);
      };
    };
    const once = async content => {
      window.__llmCalls = [];
      stub(content);
      await runFlow();
      const picked = n.data.branches.find(b => b.id === n.out.choice);
      return { status: n.status, name: picked ? picked.name : '', text: n.out.text || '' };
    };
    // 5a markdown 围栏 + 前后杂语
    const fenced = await once('我的判断如下：\n```json\n{"choice":"轻量修复","reason":"整体清晰"}\n```\n完毕。');
    // 5b 乱答：给一个不存在的名字 → 走标了兜底的出口（第 2 条标兜底）
    n.data.branches[1].fallback = true;
    const bad = await once('{"choice":"随便一个名字","reason":"无法确定"}');
    // 5c 无兜底标记：乱答 → 走第一条
    n.data.branches.forEach(b => { b.fallback = false; });
    const bad2 = await once('选择不了');
    return { fenced, bad, bad2 };
  });
  console.log('\n=== 5. 容错解析 / 兜底 ===');
  check(run2.fenced.status === 'ok' && run2.fenced.name === '轻量修复',
    'markdown 围栏 + 杂语：仍能解析', run2.fenced.name);
  check(run2.bad.name === '精细重绘' && /回退/.test(run2.bad.text),
    '乱答 → 走「兜底」出口', run2.bad.name + ' · ' + run2.bad.text);
  check(run2.bad2.name === '轻量修复' && /回退/.test(run2.bad2.text),
    '无兜底标记 → 回退第一条出口', run2.bad2.name);

  /* ---------- 6. 缺出口 / 无依据无上下文 → 零请求 ---------- */
  const bad = await page.evaluate(async () => {
    const n = bp.nodes.find(x => x.type === 'aiBranch');
    const saved = JSON.parse(JSON.stringify(n.data));
    const savedLinks = bp.links.slice();
    const once = async mut => {
      window.__llmCalls = [];
      mut(n);
      await runFlow();
      const r = { status: n.status, err: n.error || '', calls: window.__llmCalls.length };
      n.data = JSON.parse(JSON.stringify(saved));
      bp.links = savedLinks.slice();
      return r;
    };
    const noBranch = await once(x => { x.data.branches = []; });
    const noCtx = await once(x => {
      x.data.instruction = '';
      bp.links = bp.links.filter(l => !(l.to.node === x.id && (l.to.key === 'text' || l.to.key === 'image')));
    });
    return { noBranch, noCtx };
  });
  console.log('\n=== 6. 缺出口 / 无依据无上下文 ===');
  check(bad.noBranch.status === 'error' && /出口/.test(bad.noBranch.err) && bad.noBranch.calls === 0,
    '无出口：友好报错且零请求', bad.noBranch.err);
  check(bad.noCtx.status === 'error' && /依据|上下文/.test(bad.noCtx.err) && bad.noCtx.calls === 0,
    '无依据无上下文：友好报错且零请求', bad.noCtx.err);

  const bridgeCalls = await page.evaluate(() => window.__bridgeCalls.slice());
  check(bridgeCalls.length === 0, '护栏：全程零桥请求', '次数=' + bridgeCalls.length);

  await browser.close();

  const noise = errors.filter(e => !/Failed to load resource/.test(e));
  console.log('\n页面错误：' + (noise.length ? noise.slice(0, 5).join(' | ') : '无'));
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('体检失败：', e.stack); process.exit(1); });
