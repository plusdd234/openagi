/* 编辑器手势与注释面板体检（零桥、零真实请求）
 * 1) 中键拖动平移（节点上方也能拖），左键拖空白只框选、不平移
 * 2) 框选多选、Shift 追加、Ctrl+A 全选、Esc 清空
 * 3) 框选后按 C 建注释面板：面板包住选区、标题可改、可换色
 * 4) 拖动面板标题栏 → 框内节点跟着走，框外的节点不动
 * 5) 面板缩放、删除面板（节点保留）；Delete 删选中节点
 * 6) 缩放入口（按钮 / 指示器）与视图适应包含面板
 * 7) 落盘：注释面板随工作流一起保存
 * 用法：node tools/editor-canvas.js
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  // 固定视图：世界坐标 == 画布内坐标，后续用像素算矩形更直观
  const setup = await page.evaluate(() => {
    window.__bridgeCalls = [];
    const orig = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push(String(url));
        return Promise.resolve(new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
      }
      return orig.apply(this, arguments);
    };

    FLOWS.length = 0;
    const a = newNode('text', 60, 60);   a.data.text = 'A';
    const b = newNode('text', 360, 60);  b.data.text = 'B';
    const c = newNode('text', 60, 320);  c.data.text = 'C';
    const flow = { id: 'ed_' + Date.now(), name: '手势验证', nodes: [a, b, c], links: [], vars: [], frames: [], updated: Date.now() };
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    return { a: a.id, b: b.id, c: c.id };
  });
  await page.waitForTimeout(300);

  const resetView = async () => page.evaluate(() => {
    bpPan = { x: 0, y: 0 }; bpZoom = 1; applyBpTransform();
    Editor.reset();
  });
  const canvasBox = await page.evaluate(() => {
    const r = $('bpCanvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // 画布内坐标 → 屏幕坐标
  const P = (x, y) => ({ x: canvasBox.x + x, y: canvasBox.y + y });
  const dragPx = async (from, to, opts) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down(opts || {});
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up(opts || {});
  };
  const snap = async () => page.evaluate(() => ({
    pan: { x: bpPan.x, y: bpPan.y },
    zoom: bpZoom,
    sel: Editor.selectionCount(),
    frames: (bp.frames || []).length,
    nodes: bp.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })),
    marquee: !$('bpMarquee').classList.contains('hidden'),
  }));

  console.log('=== 1. 中键平移 / 左键框选 ===');
  await resetView();
  let s0 = await snap();
  const empty = P(700, 500);
  await dragPx(empty, { x: empty.x + 90, y: empty.y + 60 }, { button: 'middle' });
  let s1 = await snap();
  check(Math.round(s1.pan.x - s0.pan.x) === 90 && Math.round(s1.pan.y - s0.pan.y) === 60,
    '中键拖动平移', `Δ=${Math.round(s1.pan.x - s0.pan.x)},${Math.round(s1.pan.y - s0.pan.y)}`);
  check(s1.nodes.every((n, i) => n.x === s0.nodes[i].x && n.y === s0.nodes[i].y), '中键平移不移动节点');

  await resetView();
  s0 = await snap();
  const midAtNode = await page.evaluate(id => {
    const r = $('n-' + id).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 14 };
  }, setup.a);
  await dragPx(midAtNode, { x: midAtNode.x + 60, y: midAtNode.y + 40 }, { button: 'middle' });
  s1 = await snap();
  check(Math.abs(s1.pan.x - s0.pan.x) > 40, '节点上方中键也能平移', `Δx=${Math.round(s1.pan.x - s0.pan.x)}`);
  check(s1.nodes[0].x === 60 && s1.nodes[0].y === 60, '中键拖节点不会挪节点');

  await resetView();
  s0 = await snap();
  // 左键空白拖动：只框选，不平移
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 80, empty.y + 50, { steps: 5 });
  const during = await snap();
  await page.mouse.up();
  s1 = await snap();
  check(during.marquee === true, '左键拖空白出现框选矩形');
  check(s1.pan.x === s0.pan.x && s1.pan.y === s0.pan.y, '左键拖空白不再平移视图',
    `Δ=${s1.pan.x - s0.pan.x},${s1.pan.y - s0.pan.y}`);
  check(s1.sel === 0, '空白处框选没有选中任何节点', 'sel=' + s1.sel);

  console.log('\n=== 2. 框选多选 ===');
  await resetView();
  await dragPx(P(30, 30), P(520, 240));
  let s2 = await snap();
  const sel2 = await page.evaluate(() => Array.from(Editor.selection));
  check(s2.sel === 2 && sel2.includes(setup.a) && sel2.includes(setup.b),
    '框选命中两个节点', 'sel=' + s2.sel);
  check(!sel2.includes(setup.c), '框外的节点没被选中');
  check(await page.locator('#bpNodes .node.sel').count() === 2, '选中态同步到 DOM');
  const infoTxt = await page.textContent('#bpSelInfo');
  check(/按 C 建注释面板/.test(infoTxt), '状态栏提示可以按 C 建注释', infoTxt.trim());
  await page.screenshot({ path: path.join(__dirname, '..', 'samples', 'editor-marquee.png') });

  // 左键拖节点标题栏：多选时整组一起移动
  const nodeHead = await page.evaluate(id => {
    const r = $('n-' + id).querySelector('.node-head').getBoundingClientRect();
    return { x: r.left + 46, y: r.top + 14 };
  }, setup.a);
  await dragPx(nodeHead, { x: nodeHead.x + 30, y: nodeHead.y + 20 });
  const grp = await page.evaluate(() => bp.nodes.map(n => Math.round(n.x) + ',' + Math.round(n.y)));
  check(grp[0] === '90,80' && grp[1] === '390,80' && grp[2] === '60,320',
    '拖动选中节点时整组一起移动', grp.join(' | '));
  await page.evaluate(() => {
    bp.nodes[0].x = 60; bp.nodes[0].y = 60;
    bp.nodes[1].x = 360; bp.nodes[1].y = 60;
    renderNodes();
  });

  // Shift 追加选择
  await page.keyboard.down('Shift');
  await dragPx(P(30, 300), P(300, 420));
  await page.keyboard.up('Shift');
  s2 = await snap();
  check(s2.sel === 3, 'Shift + 框选为追加选择', 'sel=' + s2.sel);

  // Ctrl+A 全选 / Esc 清空
  await page.keyboard.press('Control+a');
  check((await snap()).sel === 3, 'Ctrl+A 全选');
  await page.keyboard.press('Escape');
  check((await snap()).sel === 0, 'Esc 清空选择');

  console.log('\n=== 3. 按 C 建注释面板 ===');
  await resetView();
  await dragPx(P(30, 30), P(520, 240));
  await page.keyboard.press('c');
  await page.waitForTimeout(150);
  let s3 = await snap();
  const frame = await page.evaluate(() => {
    const f = (bp.frames || [])[0] || null;
    return f ? { id: f.id, x: f.x, y: f.y, w: f.w, h: f.h, title: f.title, color: f.color } : null;
  });
  check(s3.frames === 1, '框选后按 C 生成一个注释面板');
  check(!!frame && frame.x <= 60 && frame.y < 60 && frame.x + frame.w >= 584 && frame.y + frame.h >= 140,
    '面板包住了选区（含留白）', frame ? `rect=${frame.x},${frame.y},${frame.w}x${frame.h}` : '');
  check(await page.locator('#bpFrames .bp-frame').count() === 1, '面板已渲染到画布');
  check(await page.evaluate(() => document.activeElement && document.activeElement.className === 'frame-title'),
    '创建后标题输入框自动聚焦，可直接写注释');

  // 改标题 + 换色
  const fid = frame.id;
  await page.fill('#f-' + fid + ' .frame-title', '角色拆分 · 前后视图');
  await page.evaluate(() => document.activeElement.blur());
  await page.click('#f-' + fid + ' .frame-dot');
  const frame2 = await page.evaluate(() => (bp.frames || [])[0]);
  check(frame2.title === '角色拆分 · 前后视图', '标题写入模型', frame2.title);
  check(frame2.color !== frame.color, '点色点可以换颜色', frame2.color);
  check(await page.inputValue('#f-' + fid + ' .frame-title') === '角色拆分 · 前后视图', '标题回填到输入框');
  await page.screenshot({ path: path.join(__dirname, '..', 'samples', 'editor-frame.png') });

  console.log('\n=== 4. 拖动面板带走框内节点 ===');
  await resetView();
  const before = await snap();
  const head = await page.evaluate(id => {
    const r = document.querySelector('#f-' + id + ' .frame-grip').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, fid);
  await dragPx(head, { x: head.x + 120, y: head.y + 70 });
  const after = await snap();
  const moved = id => {
    const a = before.nodes.find(n => n.id === id), b = after.nodes.find(n => n.id === id);
    return Math.round(b.x - a.x) + ',' + Math.round(b.y - a.y);
  };
  check(moved(setup.a) === '120,70' && moved(setup.b) === '120,70', '框内节点跟着面板移动', moved(setup.a));
  check(moved(setup.c) === '0,0', '框外节点保持不动', moved(setup.c));
  check(Math.round(after.frames) === 1, '面板本身仍在');
  const fr2 = await page.evaluate(() => bp.frames[0]);
  check(fr2.x === frame.x + 120 && fr2.y === frame.y + 70, '面板坐标同步更新',
    `${fr2.x},${fr2.y}`);

  console.log('\n=== 5. 面板缩放 / 删除 ===');
  const rz = await page.evaluate(id => {
    const r = document.querySelector('#f-' + id + ' .frame-resize').getBoundingClientRect();
    return { x: r.left + 8, y: r.top + 8 };
  }, fid);
  await dragPx(rz, { x: rz.x + 100, y: rz.y + 80 });
  const fr3 = await page.evaluate(() => bp.frames[0]);
  check(fr3.w === fr2.w + 100 && fr3.h === fr2.h + 80, '右下角可拉大面板', `${fr3.w}x${fr3.h}`);

  const head2 = await page.evaluate(id => {
    const r = document.querySelector('#f-' + id + ' .frame-grip').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, fid);
  await page.mouse.click(head2.x, head2.y);
  check(await page.evaluate(() => Editor.frameSel) === fid, '点击标题栏选中面板');
  await page.keyboard.press('Delete');
  let s5 = await snap();
  check(s5.frames === 0, 'Delete 删除选中面板');
  check(s5.nodes.length === 3, '删除面板不删节点', 'nodes=' + s5.nodes.length);

  console.log('\n=== 6. Delete 删节点 / 缩放 / 落盘 ===');
  await page.mouse.click(canvasBox.x + 800, canvasBox.y + 600);
  await page.evaluate(id => {
    const r = $('n-' + id).getBoundingClientRect();
    Editor.selection = new Set([id]);
    document.querySelectorAll('#bpNodes .node.sel').forEach(x => x.classList.remove('sel'));
    Editor.render();
  }, setup.c);
  await page.keyboard.press('Delete');
  s5 = await snap();
  check(s5.nodes.length === 2 && !s5.nodes.some(n => n.id === setup.c), 'Delete 删除选中节点');

  await page.click('#btnZoomIn');
  const z1 = await page.evaluate(() => bpZoom);
  await page.click('#btnZoomOut');
  const z2 = await page.evaluate(() => bpZoom);
  const zLabel = await page.textContent('#btnZoomReset');
  check(z1 > 1 && z2 < z1, '缩放按钮生效', `${z1.toFixed(2)} → ${z2.toFixed(2)}`);
  check(/%$/.test(zLabel.trim()), '缩放指示器显示百分比', zLabel);
  await page.click('#btnZoomReset');
  check(Math.abs(await page.evaluate(() => bpZoom) - 1) < 0.001, '点百分比回到 100%');

  const saved = await page.evaluate(() => {
    const id = bp.id;
    // 再建一个面板，确保落盘包含 frames
    bp.frames = [{ id: 'fr_save', title: '落盘验证', color: '#5b9dff', x: 10, y: 10, w: 300, h: 200 }];
    saveFlowNow();
    const flow = FLOWS.find(x => x.id === id);
    const raw = JSON.parse(localStorage.getItem('hf_flows') || '[]').find(x => x.id === id);
    return {
      inMemory: flow && flow.frames ? flow.frames.length : -1,
      onDisk: raw && raw.frames ? raw.frames.length : -1,
      title: raw && raw.frames && raw.frames[0] ? raw.frames[0].title : ''
    };
  });
  check(saved.inMemory === 1 && saved.onDisk === 1, '注释面板随工作流一起保存',
    `mem=${saved.inMemory} disk=${saved.onDisk}`);
  check(saved.title === '落盘验证', '标题也一并保存', saved.title);

  const fitFrames = await page.evaluate(() => {
    bp.frames = [{ id: 'far', title: '远处注释', color: '#6fdc9f', x: 2000, y: 1500, w: 400, h: 300 }];
    renderFrames();
    fitView();
    const w = 2000 * bpZoom + bpPan.x;
    const h = 1500 * bpZoom + bpPan.y;
    return { visibleX: w > 0 && w < $('bpCanvas').clientWidth, visibleY: h > 0 && h < $('bpCanvas').clientHeight };
  });
  check(fitFrames.visibleX && fitFrames.visibleY, '适应视图会把远处的注释面板也框进来');

  console.log('\n=== 7. 复制 / 粘贴 ===');
  await page.evaluate(() => { bp.frames = []; renderFrames(); });
  const beforeCp = await page.evaluate(id => {
    Editor.selection = new Set([id]);
    Editor.render();
    return bp.nodes.length;
  }, setup.a);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  const cp = await page.evaluate(id => {
    const ids = Array.from(Editor.selection);
    const fresh = bp.nodes.find(n => ids.includes(n.id));
    return {
      count: bp.nodes.length,
      sel: ids.length,
      isNew: !!fresh && fresh.id !== id,
      sameText: !!fresh && fresh.data.text === 'A'
    };
  }, setup.a);
  check(cp.count === beforeCp + 1, 'Ctrl+C / Ctrl+V 粘贴出新节点', `${beforeCp} → ${cp.count}`);
  check(cp.sel === 1 && cp.isNew, '粘贴后选中的是新节点');
  check(cp.sameText, '副本内容与原节点一致');

  const bridge = await page.evaluate(() => window.__bridgeCalls.length);
  check(bridge === 0, '全程零桥请求', 'calls=' + bridge);

  console.log('\n=== 8. 框选中途按 C（还没松手）===');
  await page.evaluate(() => {
    bp.frames = [];
    renderFrames();
    bp.nodes.forEach((n, i) => { n.x = 60 + i * 300; n.y = 60; });
    renderNodes();
    bpPan = { x: 0, y: 0 }; bpZoom = 1; applyBpTransform();
    Editor.reset();
  });
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 500, canvasBox.y + 260, { steps: 6 });
  await page.keyboard.press('c');
  await page.mouse.up();
  const midC = await page.evaluate(() => ({ frames: (bp.frames || []).length, t: (bp.frames[0] || {}).title }));
  check(midC.frames === 1, '框选未松手时按 C 也能建出面板', 'frames=' + midC.frames);
  check(midC.t === '注释', '默认标题为「注释」', midC.t);

  check(errors.length === 0, '无控制台/页面错误', errors.slice(0, 2).join(' | '));

  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e); process.exit(2); });
