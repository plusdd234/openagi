/* imageSplit 图像拆分节点体检（全程不调用真实 LLM、不触桥、不耗积分）
 * 护栏：window.fetch 拦截 127.0.0.1:8790（Tripo 桥）与 stub.test（LLM 端点），
 *       任何真实外部请求都不可能发生。
 * 1) 节点库 / 标题 / 引脚渲染（image + prompt 输入，text + 动态视图输出）
 * 2) 动态视图：添加 / 预设 / 重命名（布尔标签联动）/ 删除
 * 3) 打桩 LLM：cutout 输出 + 布尔判定 + 请求体内容
 * 4) markdown 围栏容错 + crop / mask 输出形式
 * 5) 全部视图未找到 → 布尔全 false、图像为空、不算失败
 * 6) 缺图 / 缺提示词 / 无视图 → 友好报错且零 LLM 请求
 * 用法：node tools/image-split-node.js
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
  const relayDown = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => { if (/127\.0\.0\.1:(8787|8790)|localhost:(8787|8790)/.test(r.url())) relayDown.push(r.url()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  /* ---- 护栏：拦桥（8790）+ 记录；LLM 端点由各测试节单独打桩 ---- */
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
    // LLM 配置（打桩目标）；关闭本地中转，让请求直连桩域名
    $('llmKey').value = 'test-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-vision';
    if ($('relayOn')) $('relayOn').checked = false;
  });

  /* ---------- 1. 渲染：引脚 + 参数 + 动态视图 ---------- */
  const ui = await page.evaluate(() => {
    const flow = { id: 'is_' + Date.now(), name: 'imageSplit 体检', nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null };
    const s = newNode('start', -420, 0);
    const img = newNode('imageIn', -220, 0);
    img.data.image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const txt = newNode('text', -220, 160);
    txt.data.text = '把图中角色的各个视图分别拆出来';
    const sp = newNode('imageSplit', 40, 0);
    const rs = newNode('result', 640, 0);
    flow.nodes = [s, img, txt, sp, rs];
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: sp.id, key: 'exec' } },
      { id: uid(), from: { node: sp.id, key: 'exec' }, to: { node: rs.id, key: 'exec' } },
      { id: uid(), from: { node: img.id, key: 'image' }, to: { node: sp.id, key: 'image' } },
      { id: uid(), from: { node: txt.id, key: 'text' }, to: { node: sp.id, key: 'prompt' } },
      { id: uid(), from: { node: sp.id, key: 'text' }, to: { node: rs.id, key: 'text' } }
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const el = document.getElementById('n-' + sp.id);
    const pins = d => Array.from(el.querySelectorAll('.pin.' + d)).map(p => ({ key: p.dataset.key, type: p.dataset.type }));
    const labels = Array.from(el.querySelectorAll('.view-bool-label')).map(t => (t.textContent || '').trim());
    const names = Array.from(el.querySelectorAll('.view-name')).map(t => t.value);
    const presets = Array.from(el.querySelectorAll('.view-preset')).map(b => (b.textContent || '').trim());
    const addBtn = Array.from(el.querySelectorAll('.task-add')).map(b => (b.textContent || '').trim());
    const paramRows = Array.from(el.querySelectorAll('.port-row.has-param')).map(r => {
      const label = ((r.querySelector('.port-label') || {}).textContent || '').trim();
      const ctl = r.querySelector('select, input');
      return { label, ctl: ctl ? ctl.tagName.toLowerCase() : '', value: ctl ? ctl.value : '' };
    });
    return {
      in: pins('in'), out: pins('out'), labels, names, presets, addBtn, paramRows,
      libHas: NODE_LIB.reduce((a, g) => a.concat(g.types), []).includes('imageSplit'),
      title: ((el.querySelector('.node-title') || {}).textContent || '').trim(),
      def: NODE_DEFS.imageSplit,
      data: sp.data
    };
  });

  console.log('=== 1. imageSplit 节点渲染 ===');
  check(ui.libHas, '节点库可添加 imageSplit');
  check(ui.title === '图像拆分', '节点标题正确', ui.title);
  check(ui.in.some(p => p.key === 'image' && p.type === 'image'), '输入引脚：image', JSON.stringify(ui.in.map(p => p.key)));
  check(ui.in.some(p => p.key === 'prompt' && p.type === 'string'), '输入引脚：prompt');
  check(ui.def && ui.def.execIn === true && (ui.def.execOut || []).length === 1, '带执行引脚（接入执行线）');
  const staticOut = ui.out.filter(p => p.key === 'text');
  check(staticOut.length === 1 && staticOut[0].type === 'string', '静态输出引脚：text');
  const viewImgPins = ui.out.filter(p => p.type === 'image');
  const viewBoolPins = ui.out.filter(p => p.type === 'bool');
  check(viewImgPins.length === 2 && viewBoolPins.length === 2, '动态视图输出：2 图像 + 2 布尔', JSON.stringify(ui.out.map(p => p.key + ':' + p.type)));
  check(JSON.stringify(ui.names) === '["正视图","背视图"]', '默认预填正视图 + 背视图', JSON.stringify(ui.names));
  check(JSON.stringify(ui.labels) === '["是否有正视图","是否有背视图"]', '布尔引脚标签联动', JSON.stringify(ui.labels));
  check(ui.presets.length === 6 && ui.presets.includes('正视图') && ui.presets.includes('背视图'), '常用视图预设标签', JSON.stringify(ui.presets));
  check(ui.addBtn.some(t => t.includes('添加视图')), '「+ 添加视图」按钮存在', JSON.stringify(ui.addBtn));
  const plabels = ui.paramRows.map(r => r.label).join('|');
  ['提示词', '输出形式', '边缘羽化', '超时'].forEach(k => check(plabels.includes(k), '参数行含「' + k + '」'));
  const outRow = ui.paramRows.find(r => r.label === '输出形式');
  check(outRow && outRow.value === 'cutout', '输出形式默认「抠图」', outRow && outRow.value);
  const fRow = ui.paramRows.find(r => r.label === '边缘羽化');
  check(fRow && fRow.value === '2', '边缘羽化默认 2px', fRow && fRow.value);

  /* ---------- 2. 动态增删改 ---------- */
  const dyn = await page.evaluate(() => {
    const sp = bp.nodes.find(n => n.type === 'imageSplit');
    const el = document.getElementById('n-' + sp.id);
    // 添加
    Array.from(el.querySelectorAll('.task-add')).find(b => b.textContent.includes('添加视图')).click();
    const afterAdd = sp.data.views.length;
    // 预设
    Array.from(el.querySelectorAll('.view-preset')).find(b => b.textContent === '顶视图').click();
    const afterPreset = sp.data.views.map(v => v.name);
    // 重复预设应被拒绝
    Array.from(el.querySelectorAll('.view-preset')).find(b => b.textContent === '顶视图').click();
    const afterDup = sp.data.views.length;
    // 重命名 → 布尔标签联动
    const nameInput = el.querySelector('.view-name');
    nameInput.value = '前视图';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    const boolLabel = el.querySelector('.view-bool-label').textContent;
    // 删除第二个视图（renderNodes 会重建节点元素，之后必须重新查询）
    el.querySelectorAll('.view-pin .param-del')[1].click();
    const el2 = document.getElementById('n-' + sp.id);
    return {
      afterAdd, afterPreset, afterDup, boolLabel,
      afterDel: sp.data.views.map(v => v.name),
      delPins: Array.from(el2.querySelectorAll('.pin.out')).length
    };
  });
  console.log('\n=== 2. 动态视图增删改 ===');
  check(dyn.afterAdd === 3, '「+ 添加视图」新增一条', 'views=' + dyn.afterAdd);
  check(dyn.afterPreset.includes('顶视图'), '预设「顶视图」一键添加', JSON.stringify(dyn.afterPreset));
  check(dyn.afterDup === 4, '重复预设被拒绝（不重复添加）', 'views=' + dyn.afterDup);
  check(dyn.boolLabel === '是否有前视图', '重命名后布尔标签联动', dyn.boolLabel);
  check(JSON.stringify(dyn.afterDel) === '["前视图","视图 3","顶视图"]', '删除第二个视图', JSON.stringify(dyn.afterDel));
  check(dyn.delPins === 1 + 1 + 3 * 2, '删除后输出引脚同步减少（exec + text + 3 视图×2）', 'out pins=' + dyn.delPins);

  /* ---------- 3. 打桩 LLM：cutout + 布尔 ---------- */
  const run1 = await page.evaluate(async () => {
    // 打桩：LLM 端点；响应按当前视图名动态生成（第一个视图存在，其余不存在）
    window.__llmCalls = [];
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__llmCalls.push({ url, body: (init && init.body) || '' });
        const vs = bp.nodes.find(n => n.type === 'imageSplit').data.views;
        const views = vs.map((v, i) => i === 0
          ? { name: v.name, present: true, confidence: 0.93, box: [0.1, 0.1, 0.35, 0.8],
              polygon: [[0.1, 0.1], [0.45, 0.1], [0.45, 0.9], [0.1, 0.9]] }
          : { name: v.name, present: false });
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ views }) } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    const sp = bp.nodes.find(n => n.type === 'imageSplit');
    bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
    await runFlow();
    const views = sp.data.views;
    return {
      status: sp.status, err: sp.error || '',
      out: sp.out,
      text: sp.out.text || '',
      v1: views[0].id, v2: views[1].id,
      llm: window.__llmCalls.slice(),
      bridge: window.__bridgeCalls.slice()
    };
  });
  console.log('\n=== 3. 打桩 LLM 执行（cutout）===');
  check(run1.status === 'ok', '节点运行成功', run1.status + ' ' + run1.err);
  check(typeof run1.out[run1.v1] === 'string' && run1.out[run1.v1].indexOf('data:image/png') === 0, '正视图输出透明底 PNG', (run1.out[run1.v1] || '').slice(0, 30));
  check(run1.out[run1.v1 + '__has'] === true, '「是否有正视图」= true');
  check(run1.out[run1.v2] === '' && run1.out[run1.v2 + '__has'] === false, '背视图未找到：图像为空、布尔 false');
  check(/已拆分/.test(run1.text) && /未找到/.test(run1.text), 'text 汇总包含拆分结果', run1.text);
  check(run1.llm.length === 1, 'LLM 请求一次', '次数=' + run1.llm.length);
  const reqBody = run1.llm.length ? JSON.parse(run1.llm[0].body) : {};
  const userContent = reqBody.messages && reqBody.messages[1] && reqBody.messages[1].content;
  const userText = Array.isArray(userContent) ? userContent.map(c => c.text || '').join('\n') : '';
  const hasImg = Array.isArray(userContent) && userContent.some(c => c.type === 'image_url');
  check(/\/chat\/completions/.test(run1.llm[0] ? run1.llm[0].url : ''), '请求打到 /chat/completions');
  check(/前视图/.test(userText) && /视图 3/.test(userText) && /顶视图/.test(userText), '请求体包含视图清单', userText.slice(0, 60));
  check(/把图中角色的各个视图分别拆出来/.test(userText), '请求体包含拆分要求（提示词）');
  check(hasImg, '请求体附带图像（image_url）');
  check(run1.bridge.length === 0, '全程零桥请求（不误触发生成）');

  /* ---------- 4. markdown 围栏 + crop / mask ---------- */
  const run2 = await page.evaluate(async () => {
    window.__llmCalls = [];
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__llmCalls.push(1);
        const vs = bp.nodes.find(n => n.type === 'imageSplit').data.views;
        const views = vs.map((v, i) => i === 0
          ? { name: v.name, present: true, confidence: 0.9, box: [0.1, 0.1, 0.35, 0.8],
              polygon: [[0.1, 0.1], [0.45, 0.1], [0.45, 0.9], [0.1, 0.9]] }
          : { name: v.name, present: false });
        // 带 markdown 代码围栏 + 前后杂语，验证容错解析
        const content = '分析结果如下：\n```json\n' + JSON.stringify({ views }) + '\n```\n以上。';
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    const sp = bp.nodes.find(n => n.type === 'imageSplit');
    const views = sp.data.views;
    const out = {};
    for (const mode of ['crop', 'mask']) {
      sp.data.output = mode;
      bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
      await runFlow();
      out[mode] = {
        status: sp.status,
        img: sp.out[views[0].id] || '',
        has: sp.out[views[0].id + '__has']
      };
    }
    return { out, calls: window.__llmCalls.length };
  });
  console.log('\n=== 4. markdown 围栏容错 + crop / mask ===');
  check(run2.out.crop.status === 'ok' && /^data:image\/png/.test(run2.out.crop.img) && run2.out.crop.has === true,
    'crop 模式：围栏 JSON 容错解析并输出 PNG', run2.out.crop.status);
  check(run2.out.mask.status === 'ok' && /^data:image\/png/.test(run2.out.mask.img),
    'mask 模式：输出蒙版图', run2.out.mask.status);
  check(run2.calls === 2, '两次运行各请求一次', '次数=' + run2.calls);

  /* ---------- 5. 全部未找到 ---------- */
  const run3 = await page.evaluate(async () => {
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        const vs = bp.nodes.find(n => n.type === 'imageSplit').data.views;
        const views = vs.map(v => ({ name: v.name, present: false }));
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ views }) } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    const sp = bp.nodes.find(n => n.type === 'imageSplit');
    sp.data.output = 'cutout';
    bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
    await runFlow();
    const views = sp.data.views;
    return {
      status: sp.status,
      has1: sp.out[views[0].id + '__has'], img1: sp.out[views[0].id],
      has2: sp.out[views[1].id + '__has'], img2: sp.out[views[1].id],
      text: sp.out.text || ''
    };
  });
  console.log('\n=== 5. 全部视图未找到 ===');
  check(run3.status === 'ok', '未找到不算失败（布尔语义）', run3.status);
  check(run3.has1 === false && run3.has2 === false && run3.img1 === '' && run3.img2 === '', '布尔全 false、图像为空');
  check(/未找到/.test(run3.text), 'text 说明未找到', run3.text);

  /* ---------- 6. 缺图 / 缺提示词 / 无视图 → 零请求 ---------- */
  const bad = await page.evaluate(async () => {
    const results = {};
    const runOnce = async (mut) => {
      const sp = bp.nodes.find(n => n.type === 'imageSplit');
      const savedLinks = bp.links.slice();
      const savedData = JSON.parse(JSON.stringify(sp.data));
      window.__llmCalls = [];
      mut(sp);
      bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
      await runFlow();
      const r = { status: sp.status, err: sp.error || '', calls: window.__llmCalls.length };
      bp.links = savedLinks;
      sp.data = savedData;
      return r;
    };
    results.noImage = await runOnce(sp => { bp.links = bp.links.filter(l => !(l.to.node === sp.id && l.to.key === 'image')); });
    results.noPrompt = await runOnce(sp => { bp.links = bp.links.filter(l => !(l.to.node === sp.id && l.to.key === 'prompt')); });
    results.noViews = await runOnce(sp => { sp.data.views = []; });
    return results;
  });
  console.log('\n=== 6. 缺图 / 缺提示词 / 无视图 ===');
  check(bad.noImage.status === 'error' && /图像/.test(bad.noImage.err) && bad.noImage.calls === 0,
    '缺图：友好报错且零请求', bad.noImage.err);
  check(bad.noPrompt.status === 'error' && /提示词/.test(bad.noPrompt.err) && bad.noPrompt.calls === 0,
    '缺提示词：友好报错且零请求', bad.noPrompt.err);
  check(bad.noViews.status === 'error' && /视图/.test(bad.noViews.err) && bad.noViews.calls === 0,
    '无视图：友好报错且零请求', bad.noViews.err);

  const bridgeCalls = await page.evaluate(() => window.__bridgeCalls.slice());
  check(bridgeCalls.length === 0, '护栏：全程零桥请求', '次数=' + bridgeCalls.length);

  await browser.close();

  const noise = errors.filter(e => !/Failed to load resource/.test(e));
  console.log('\n页面错误：' + (noise.length ? noise.slice(0, 5).join(' | ') : '无'));
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('体检失败：', e.stack); process.exit(1); });
