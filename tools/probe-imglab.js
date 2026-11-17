/* 探针：图像工坊（PS 类多图层工作站）是否真的接上并能跑完整链路
 * 用法：node tools/probe-imglab.js
 *
 * 为什么单独一个：这套东西的关键卖点在「大图 + 瓦片 + 历史」，
 * 光看代码看不出真机上会不会白屏。这里从桌面图标点进去，验证：
 *   ① 默认是空白画布、瓦片渲染有统计；演示素材可随时载入；
 *   ② 缩小时走 mip（一次 drawImage 顶替一堆瓦片）；
 *   ③ 画笔 / 油漆桶 / 滤镜都进历史，撤销能回来；
 *   ④ 调整层、导出、超大图降采样、大图导入都能工作；
 *   ⑤ 关闭按钮真的能把窗口收回去，且全程无 pageerror。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.stack) || (e && e.message))));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const icon = await page.evaluate(() => !!document.querySelector('.desk-app[data-app="imglab"]'));
  check(icon, '桌面上的「图像工坊」图标存在', '');

  await page.evaluate(() => window.openDeskApp('imglab'));
  await page.waitForTimeout(2600);

  let dbg = await page.evaluate(() => window.psLab && window.psLab.__debug());
  check(!!dbg && dbg.ready, 'psLab 就绪', '');
  check(!!dbg && dbg.visible, '窗口已翻到前台（没有 hidden）', '');
  check(await page.evaluate(() => !!document.querySelector('#psStageHost canvas.ps-canvas')), '画布节点存在', '');
  check(dbg.doc.w === 1600 && dbg.doc.h === 1000, '默认空白画布 1600 × 1000', dbg.doc.w + ' × ' + dbg.doc.h);
  check(dbg.doc.layers === 1 && dbg.doc.names[0] === '背景', '默认只有一层白色背景', dbg.doc.layers + ' 层：' + dbg.doc.names.join(' / '));
  check(dbg.tiles > 0, '空白画布首帧生成瓦片', dbg.tiles + ' 瓦片');

  /* 默认背景层锁定：移动工具拖不动（对齐 PS 的背景层行为） */
  const bgLocked = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(bgLocked && bgLocked.locked === true && bgLocked.locks && bgLocked.locks.position === true,
    '默认背景层锁定位置', 'locked=' + (bgLocked && bgLocked.locked) + ' · locks=' + JSON.stringify(bgLocked && bgLocked.locks));
  const blankView = await page.evaluate(() => {
    const c = document.querySelector('#imgLabWin canvas.ps-canvas');
    const r = c.getBoundingClientRect();
    const d = window.psLab.__debug();
    return { left: r.left, top: r.top, px: d.pan.x, py: d.pan.y, z: d.zoom };
  });
  await page.click('#psTools [data-tool="move"]');
  const bgFrom = { x: blankView.left + blankView.px + 300 * blankView.z, y: blankView.top + blankView.py + 300 * blankView.z };
  await page.mouse.move(bgFrom.x, bgFrom.y);
  await page.mouse.down();
  await page.mouse.move(bgFrom.x + 60, bgFrom.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const bgAfter = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(bgAfter.locked === true && bgAfter.x === 0 && bgAfter.y === 0,
    '锁定背景拖不动', 'locked=' + bgAfter.locked + ' @' + bgAfter.x + ',' + bgAfter.y);

  /* 默认布局（对齐参考图）：选项栏横跨整个工作区；历史 / 导航器收起，图层展开 */
  const layout = await page.evaluate(() => {
    const app = document.getElementById('psApp');
    const opt = app.querySelector('.ps-options');
    const bar = app.querySelector('.ps-menubar');
    const r = opt.getBoundingClientRect();
    return {
      optW: Math.round(r.width), appW: Math.round(app.getBoundingClientRect().width),
      belowMenu: r.top >= bar.getBoundingClientRect().bottom - 1,
      hist: document.getElementById('psHistCard').classList.contains('is-collapsed'),
      nav: document.getElementById('psNavCard').classList.contains('is-collapsed'),
      layers: document.getElementById('psLayersCard').classList.contains('is-collapsed')
    };
  });
  check(layout.optW === layout.appW && layout.belowMenu, '选项栏横跨整个工作区', layout.optW + ' / ' + layout.appW);
  check(layout.hist && layout.nav && !layout.layers, '默认布局：历史与导航器收起、图层展开',
    'hist=' + layout.hist + ' / nav=' + layout.nav + ' / layers=' + layout.layers);

  /* 空白通过后载入演示素材，后面的渲染 / 选区 / 图层测试沿用固定内容 */
  await page.evaluate(() => window.psLab.__test.loadDemo());
  await page.waitForTimeout(500);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.doc.layers >= 3, '演示素材可载入（供后续测试）', dbg.doc.layers + ' 层：' + dbg.doc.names.join(' / '));

  /* 1. 缩放：100% 用瓦片；缩到 18% 用 mip */
  await page.evaluate(() => window.psLab.__test.setZoom(1));
  await page.waitForTimeout(500);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(Math.abs(dbg.zoom - 1) < 0.001, 'setZoom(1) 生效', 'zoom=' + dbg.zoom);
  check(dbg.stats && dbg.stats.tiles > 0, '100% 时按瓦片绘制', dbg.stats && (dbg.stats.tiles + ' 瓦片 / ' + dbg.stats.ms + 'ms'));

  await page.evaluate(() => window.psLab.__test.setZoom(0.18));
  await page.waitForTimeout(600);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.mips > 0, '缩小后 mip 已生成', dbg.mips + ' 层 mip');
  check(dbg.stats && dbg.stats.mips > 0, '18% 时走 mip 绘制', dbg.stats && ('mips=' + dbg.stats.mips + ' / tiles=' + dbg.stats.tiles));

  await page.evaluate(() => window.psLab.__test.setZoom(1));
  await page.waitForTimeout(320);

  /* 2. 画笔 → 撤销 → 重做 */
  const before = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  await page.evaluate(() => window.psLab.__test.brushAt(200, 200));
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  check(after.hex !== before.hex, '画笔画上去了', before.hex + ' → ' + after.hex);
  const undid = await page.evaluate(() => window.psLab.__test.undo());
  const un = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  check(!!undid && un.hex === before.hex, '撤销后像素回到原样', un.hex);
  const redid = await page.evaluate(() => window.psLab.__test.redo());
  const re = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  check(!!redid && re.hex === after.hex, '重做后像素再次出现', re.hex);

  /* 3. 选区 + 油漆桶 */
  await page.evaluate(() => window.psLab.__test.selectRect({ x: 780, y: 460, w: 150, h: 130 }));
  const fill = await page.evaluate(() => window.psLab.__test.fillAt(880, 520, '#2f7bff'));
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => window.psLab.__test.sample(880, 520));
  check(fill && fill.ok, '选区内油漆桶填充成功', fill && ('改了 ' + fill.count + ' 像素'));
  check(sel.hex !== '#e8a13a' && sel.b > 120, '填充颜色落在选区里', sel.hex);
  await page.evaluate(() => window.psLab.__test.selectClear());

  /* 3.5 魔棒：透明区取样 → 多边形选区（含一个圆形洞） */
  const wand = await page.evaluate(() => window.psLab.__test.magicWand(1500, 900, { tolerance: 8, contiguous: true, sampleMerged: false }));
  check(wand.ok && wand.type === 'polygons' && wand.count > 500,
    '魔棒生成多边形选区', wand.ok ? (wand.count + ' px / ' + wand.polygons + ' 轮廓') : wand.reason);
  check(wand.ok && wand.polygons >= 2, '魔棒轮廓包含外框与内部洞', wand.polygons + ' 个轮廓');
  const wandIn = await page.evaluate(() => window.psLab.__test.selectionContains(1500, 900));
  const wandOut = await page.evaluate(() => window.psLab.__test.selectionContains(980, 430));
  check(wandIn === true && wandOut === false, '魔棒选区命中测试正确', 'inside=' + wandIn + ' / outside=' + wandOut);
  await page.evaluate(() => window.psLab.__test.selectClear());

  /* 3.6 矢量形状：矩形 + 钢笔路径均为独立矢量图层，可撤销 */
  const rectId = await page.evaluate(() => window.psLab.__test.addShape(
    { kind: 'rect', x: 700, y: 170, w: 120, h: 90, fill: '#ff3355', stroke: null, strokeWidth: 0 },
    '测试矩形'));
  let active = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(!!rectId && active.type === 'shape' && active.shapes === 1, '新建矢量形状图层', active.type + ' · ' + active.shapes + ' 形状');
  const vecPx = await page.evaluate(() => window.psLab.__test.flattenSample(760, 215));
  check(vecPx.r > 180 && vecPx.g < 120 && vecPx.b < 140, '矢量矩形参与合成', JSON.stringify(vecPx));
  const hit = await page.evaluate(() => window.psLab.__test.hitShape(760, 215));
  check(!!hit && hit.id === rectId && hit.kind === 'rect', '路径选择命中矢量形状', hit && (hit.kind + ' / anchor=' + hit.anchor));
  const rasterized = await page.evaluate(() => window.psLab.__test.rasterize());
  active = await page.evaluate(() => window.psLab.__test.activeLayer());
  const rasPx = await page.evaluate(() => window.psLab.__test.flattenSample(760, 215));
  check(rasterized === true && active.type === 'pixel' && rasPx.r > 180 && rasPx.g < 120,
    '矢量图层栅格化为像素', active.type + ' / ' + JSON.stringify(rasPx));
  await page.evaluate(() => window.psLab.__test.undo());
  active = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(active.type === 'shape' && active.shapes === 1, '撤销栅格化恢复矢量', active.type + ' · ' + active.shapes);
  await page.evaluate(() => window.psLab.__test.undo());
  const vecGone = await page.evaluate(() => window.psLab.__test.flattenSample(760, 215));
  active = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(active.type !== 'shape' && !(vecGone.r > 180 && vecGone.g < 120), '撤销移除矢量图层', JSON.stringify(vecGone));

  await page.evaluate(() => window.psLab.__test.addShape(
    { kind: 'path', closed: true, fill: '#22d3ee', stroke: null, strokeWidth: 0,
      pts: [{ x: 250, y: 250 }, { x: 400, y: 250 }, { x: 325, y: 380 }] },
    '测试路径'));
  const pathPx = await page.evaluate(() => window.psLab.__test.flattenSample(320, 300));
  check(pathPx.g > 150 && pathPx.b > 150 && pathPx.r < 120, '钢笔路径填充参与合成', JSON.stringify(pathPx));
  await page.evaluate(() => window.psLab.__test.undo());

  /* 3.7 工具联动：形状拖拽 / 路径选择拖动 / 钢笔落点 / 魔棒点击 */
  const vp = await page.evaluate(() => {
    const c = document.querySelector('#imgLabWin canvas.ps-canvas');
    const r = c.getBoundingClientRect();
    const d = window.psLab.__debug();
    return { left: r.left, top: r.top, px: d.pan.x, py: d.pan.y, z: d.zoom };
  });
  const S = (x, y) => ({ x: vp.left + vp.px + x * vp.z, y: vp.top + vp.py + y * vp.z });

  /* 矢量工具只在矢量编辑器里出现：先切模式，再走形状 / 钢笔 / 路径选择 */
  const modeBefore = await page.evaluate(() => window.psLab.__test.mode());
  await page.evaluate(() => window.psLab.__test.setMode('vector'));
  const vecMode = await page.evaluate(() => ({
    mode: window.psLab.__test.mode(),
    hasShape: !!document.querySelector('#psTools [data-tool="shape"]'),
    hasBrush: !!document.querySelector('#psTools [data-tool="brush"]'),
    tab: window.psLab.__debug().layerTab
  }));
  check(modeBefore === 'raster' && vecMode.mode === 'vector' && vecMode.hasShape && !vecMode.hasBrush && vecMode.tab === 'paths',
    '切换到矢量编辑器并过滤工具箱', JSON.stringify(vecMode));

  await page.click('#psTools [data-tool="shape"]');
  const toolNow = await page.evaluate(() => window.psLab.__test.tool());
  check(toolNow === 'shape', '工具栏切换到形状工具', toolNow + ' / ' + JSON.stringify(vp));
  const s0 = S(700, 400), s1 = S(900, 540);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down();
  const midDrag = await page.evaluate(() => window.psLab.__test.preview());
  await page.mouse.move(s1.x, s1.y, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(160);
  active = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(active.type === 'shape' && active.shapes === 1, '形状工具拖拽创建矢量图层', active.type + ' @' + active.x + ',' + active.y + ' / ' + JSON.stringify(midDrag));

  await page.click('#psTools [data-tool="path-select"]');
  const c0 = S(800, 470), c1 = S(842, 502);
  await page.mouse.move(c0.x, c0.y); await page.mouse.down();
  await page.mouse.move(c1.x, c1.y, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(140);
  const moved = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(moved.x === 42 && moved.y === 32, '路径选择拖动矢量图层', moved.x + ',' + moved.y);
  await page.evaluate(() => window.psLab.__test.undo());
  await page.evaluate(() => window.psLab.__test.undo());

  /* 3.7b 钢笔手感：Backspace 撤回锚点 / Enter 结束成开放路径 / 悬停锚点 / Delete 删锚点 */
  await page.click('#psTools [data-tool="pen"]');
  const penB0 = S(500, 560), penB1 = S(560, 600);
  await page.mouse.click(penB0.x, penB0.y);
  await page.mouse.click(penB1.x, penB1.y);
  const penN1 = await page.evaluate(() => window.psLab.__test.penPoints().length);
  await page.keyboard.press('Backspace');
  const penN2 = await page.evaluate(() => window.psLab.__test.penPoints().length);
  check(penN1 === 2 && penN2 === 1, '钢笔 Backspace 撤回锚点', penN1 + '→' + penN2);
  await page.keyboard.press('Escape');

  await page.click('#psTools [data-tool="pen"]');
  const p0 = S(500, 480), p1 = S(650, 480), p2 = S(575, 610);
  for (const q of [p0, p1, p2]) {
    await page.mouse.move(q.x, q.y);
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(160);
  active = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(active.type === 'shape' && active.shapes === 1, '钢笔落点并回车生成路径图层', active.type + ' · ' + active.shapes + ' 形状');
  const penInfo = await page.evaluate(() => window.psLab.__test.shapeInfo());
  check(penInfo.kind === 'path' && penInfo.pts === 3 && penInfo.closed === false,
    '钢笔 Enter 结束并保留开放路径', JSON.stringify({ pts: penInfo.pts, closed: penInfo.closed }));

  await page.click('#psTools [data-tool="path-select"]');
  await page.mouse.move(p0.x, p0.y);
  await page.waitForTimeout(100);
  const nodeOverlay = await page.evaluate(() => window.psLab.__test.preview());
  check(nodeOverlay.edit === true && nodeOverlay.path >= 3, '路径选择悬停显示锚点', JSON.stringify(nodeOverlay));
  await page.mouse.down(); await page.mouse.up();
  const picked = await page.evaluate(() => window.psLab.__test.pathSelection());
  await page.keyboard.press('Delete');
  await page.waitForTimeout(140);
  const afterDel = await page.evaluate(() => window.psLab.__test.shapeInfo());
  check(picked && picked.index === 0 && afterDel && afterDel.pts === 2,
    '路径选择 Delete 删除锚点', JSON.stringify({ picked: picked && picked.index, pts: afterDel && afterDel.pts }));
  await page.evaluate(() => window.psLab.__test.undo());
  await page.evaluate(() => window.psLab.__test.undo());

  /* 3.7c 路径选择：拖动控制柄改形 */
  await page.evaluate(() => window.psLab.__test.addShape({
    kind: 'path', closed: false, fill: null, stroke: '#ff3355', strokeWidth: 2,
    pts: [
      { x: 560, y: 560, hix: null, hiy: null, hox: 640, hoy: 560 },
      { x: 760, y: 560, hix: 680, hiy: 560, hox: null, hoy: null }
    ]
  }, '控制柄测试'));
  await page.click('#psTools [data-tool="path-select"]');
  const h0 = S(640, 560), h1 = S(640, 620);
  await page.mouse.move(h0.x, h0.y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  const pickHandle = await page.evaluate(() => window.psLab.__test.pathSelection());
  await page.mouse.move(h1.x, h1.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(140);
  const handleInfo = await page.evaluate(() => window.psLab.__test.shapeInfo());
  check(handleInfo && Math.abs(handleInfo.points[0].hoy - 620) < 3,
    '路径选择拖动控制柄改形', JSON.stringify({ pick: pickHandle, p0: handleInfo && handleInfo.points[0] }));
  await page.evaluate(() => window.psLab.__test.undo());
  await page.evaluate(() => window.psLab.__test.undo());

  /* 回到图像编辑器，后续魔棒 / 画笔 / 选项栏 / 羽化都依赖位图工具 */
  await page.evaluate(() => window.psLab.__test.setMode('raster'));
  const backMode = await page.evaluate(() => ({
    mode: window.psLab.__test.mode(),
    hasBrush: !!document.querySelector('#psTools [data-tool="brush"]'),
    hasShape: !!document.querySelector('#psTools [data-tool="shape"]')
  }));
  check(backMode.mode === 'raster' && backMode.hasBrush && !backMode.hasShape,
    '切回图像编辑器并恢复位图工具', JSON.stringify(backMode));

  await page.click('#psTools [data-tool="magic-wand"]');
  const w0 = S(600, 250);
  await page.mouse.move(w0.x, w0.y); await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(500);
  const selNow = await page.evaluate(() => window.psLab.__debug().selection);
  check(selNow.active === true, '魔棒工具点击建立选区', JSON.stringify(selNow.bounds || {}));
  await page.evaluate(() => window.psLab.__test.selectClear());

  /* 3.8 画笔拖动过程中必须实时出墨，而不是松手才刷新 */
  await page.click('#psTools [data-tool="brush"]');
  const q = S(650, 275);
  const sampleCanvas = (pt) => page.evaluate(({ x, y }) => {
    const c = document.querySelector('#imgLabWin canvas.ps-canvas');
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }, { x: Math.round(pt.x - vp.left), y: Math.round(pt.y - vp.top) });
  /* 笔迹中点与笔迹外各取一点：拖动中前者必须变、后者必须不变。
   * 不锁死颜色，前景色换成任何值都成立。 */
  const qOff = S(600, 380);
  const beforeInk = await sampleCanvas(q);
  const beforeOff = await sampleCanvas(qOff);
  const b0 = S(600, 250), b1 = S(700, 300);
  await page.mouse.move(b0.x, b0.y); await page.mouse.down();
  await page.mouse.move(b1.x, b1.y, { steps: 8 });
  await page.waitForTimeout(160);
  const liveInk = await sampleCanvas(q);
  const liveOff = await sampleCanvas(qOff);
  await page.mouse.up();
  await page.waitForTimeout(120);
  const inkDiff = Math.abs(liveInk.r - beforeInk.r) + Math.abs(liveInk.g - beforeInk.g) + Math.abs(liveInk.b - beforeInk.b);
  const offDiff = Math.abs(liveOff.r - beforeOff.r) + Math.abs(liveOff.g - beforeOff.g) + Math.abs(liveOff.b - beforeOff.b);
  check(inkDiff > 40 && offDiff <= 6,
    '画笔拖动过程中实时显示轨迹', '笔迹 ' + JSON.stringify(beforeInk) + ' → ' + JSON.stringify(liveInk) +
    ' (Δ' + inkDiff + ') / 笔迹外 Δ' + offDiff);
  await page.evaluate(() => window.psLab.__test.undo());
  await page.click('#psTools [data-tool="move"]');

  /* 3.9 指针已经在画布里时用快捷键切换画笔 / 橡皮擦，笔刷环必须立刻出现 */
  const hover = S(650, 420);
  await page.mouse.move(hover.x, hover.y);
  await page.waitForTimeout(80);
  const pressTool = (k) => page.evaluate((key) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown',
      { key: key, code: 'Key' + key.toUpperCase(), bubbles: true }));
  }, k);
  await pressTool('e');
  await page.waitForTimeout(80);
  const curErase = await page.evaluate(() => window.psLab.__debug().cursor);
  await pressTool('b');
  await page.waitForTimeout(80);
  const curBrush = await page.evaluate(() => window.psLab.__debug().cursor);
  /* 笔刷环画在半径上，采样环上一点（光标左侧 r px）看有没有白色描边 */
  const ringPt = S(650 - (curBrush.r || 22), 420);
  const ringMax = await page.evaluate(({ x, y }) => {
    const c = document.querySelector('#imgLabWin canvas.ps-canvas');
    const d = c.getContext('2d').getImageData(x - 5, y - 5, 11, 11).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i] + d[i + 1] + d[i + 2]);
    return max;
  }, { x: Math.round(ringPt.x - vp.left), y: Math.round(ringPt.y - vp.top) });
  check(curErase.on && curBrush.on && curErase.r > 5 && curBrush.r > 5 && ringMax > 500,
    '切换画笔 / 橡皮擦后笔刷环仍在', '橡皮 ' + JSON.stringify(curErase) + ' / 画笔 ' +
    JSON.stringify(curBrush) + ' / 环亮度 ' + ringMax);
  await page.click('#psTools [data-tool="move"]');

  /* 3.10 选项栏：画笔有一整组可调参数，改动即时写回工具层 */
  await page.click('#psTools [data-tool="brush"]');
  const brushOpts = await page.evaluate(() => ({
    nums: document.querySelectorAll('#psOptions .ps-opt-num').length,
    labels: Array.from(document.querySelectorAll('#psOptions .ps-opt-field > span')).map(s => s.textContent),
    hint: document.querySelector('#psOptions .ps-opt-hint') ? document.querySelector('#psOptions .ps-opt-hint').textContent : ''
  }));
  check(brushOpts.nums >= 4 && brushOpts.labels.indexOf('间距') >= 0 && brushOpts.labels.indexOf('硬度') >= 0,
    '画笔选项栏参数齐全', JSON.stringify(brushOpts));
  const spacing = await page.evaluate(() => {
    const el = document.querySelector('#psOptions input[type="number"][data-opt="spacing"]');
    el.value = '60';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return window.psLab.__test.options().spacing;
  });
  check(spacing === 60, '选项栏数字框改动即时生效', 'spacing=' + spacing);
  await page.evaluate(() => window.psLab.__test.setOption('spacing', 18));

  /* 3.11 分段按钮：渐变类型 / 吸管取样大小 / 裁剪比例 */
  await page.click('#psTools [data-tool="gradient"]');
  await page.click('#psOptions .ps-seg-btn[data-seg="gradKind"][data-val="radial"]');
  const gradKind = await page.evaluate(() => window.psLab.__test.options().gradKind);
  await page.click('#psTools [data-tool="eyedropper"]');
  await page.click('#psOptions .ps-seg-btn[data-seg="eyeSize"][data-val="3"]');
  const eyeSize = await page.evaluate(() => window.psLab.__test.options().eyeSize);
  await page.click('#psTools [data-tool="crop"]');
  await page.click('#psOptions .ps-seg-btn[data-seg="cropRatio"][data-val="1:1"]');
  const cropRatio = await page.evaluate(() => window.psLab.__test.options().cropRatio);
  check(gradKind === 'radial' && eyeSize === 3 && cropRatio === '1:1',
    '分段按钮切换工具参数', '渐变=' + gradKind + ' · 吸管=' + eyeSize + ' · 裁剪=' + cropRatio);
  await page.evaluate(() => {
    window.psLab.__test.setOption('gradKind', 'linear');
    window.psLab.__test.setOption('eyeSize', 1);
    window.psLab.__test.setOption('cropRatio', 'free');
  });

  /* 3.12 羽化：选区边缘按遮罩渐变，而不是一刀切 */
  await page.click('#psTools [data-tool="select-rect"]');
  await page.evaluate(() => window.psLab.__test.setOption('feather', 24));
  const f0 = S(620, 320), f1 = S(720, 400);
  await page.mouse.move(f0.x, f0.y);
  await page.mouse.down();
  await page.mouse.move(f1.x, f1.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const featherOpt = await page.evaluate(() => window.psLab.__test.options().feather);
  await page.evaluate(() => window.psLab.__test.fillAt(670, 360));
  await page.waitForTimeout(120);
  const edgePx = await page.evaluate(() => window.psLab.__test.flattenSample(722, 360));
  const farPx = await page.evaluate(() => window.psLab.__test.flattenSample(746, 360));
  const edgeDiff = Math.abs(edgePx.r - farPx.r) + Math.abs(edgePx.g - farPx.g) + Math.abs(edgePx.b - farPx.b);
  check(featherOpt === 24 && edgeDiff > 6,
    '羽化让选区边缘柔和过渡', '羽化=' + featherOpt + ' · 边缘差 ' + edgeDiff);
  await page.evaluate(() => {
    window.psLab.__test.selectClear();
    window.psLab.__test.setOption('feather', 0);
  });

  /* 3.13 移动工具「自动选择」：点空白处自动切到该处图层 */
  const probeLayerId = await page.evaluate(() => window.psLab.__test.addShape(
    { kind: 'rect', x: 30, y: 30, w: 60, h: 60, fill: '#22d3ee', stroke: null, strokeWidth: 0 },
    '自动选择测试'));
  await page.click('#psTools [data-tool="move"]');
  await page.evaluate(() => window.psLab.__test.setOption('autoSelect', true));
  const pt = S(650, 420);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  const afterAuto = await page.evaluate(() => window.psLab.__test.activeLayer());
  await page.evaluate(() => window.psLab.__test.setOption('autoSelect', false));
  check(afterAuto && afterAuto.id !== probeLayerId,
    '自动选择切换到光标下的图层', '原 ' + probeLayerId + ' → ' + (afterAuto && afterAuto.id) + ' ' + (afterAuto && afterAuto.name));

  /* 4. 滤镜进历史 */
  const histBefore = dbg.history.length;
  const fr = await page.evaluate(async () => window.psLab.__test.filter('grayscale', {}));
  await page.waitForTimeout(500);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.history.length > histBefore, '灰度滤镜写入历史', histBefore + ' → ' + dbg.history.length);
  check(dbg.history.index === dbg.history.length - 1, '历史游标停在最新一步', dbg.history.index + '/' + dbg.history.length);
  check(!!fr, '滤镜返回结果', '');

  /* 5. 调整层 */
  const layersBefore = dbg.doc.layers;
  const adjId = await page.evaluate(() => window.psLab.__test.addAdjust('brightness'));
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(!!adjId && dbg.doc.layers === layersBefore + 1, '新建调整层', layersBefore + ' → ' + dbg.doc.layers);
  check(dbg.doc.types.indexOf('adjust') >= 0, '图层类型里出现 adjust', dbg.doc.types.join(','));

  /* 6. 导出 */
  await page.evaluate(() => { document.querySelectorAll('#psMenuBar .ps-menu')[0].click(); });
  await page.waitForTimeout(100);
  const menuInfo = await page.evaluate(() => Array.from(document.querySelectorAll('.ps-menu-pop .ps-menu-item'))
    .map(b => b.textContent.replace(/\s+/g, ' ').trim()));
  check(menuInfo.some(t => t.indexOf('置入图片') === 0) && menuInfo.some(t => t.indexOf('导出…') === 0)
    && menuInfo.some(t => t.indexOf('保存工程') === 0),
    '文件菜单含导入 / 导出 / 工程入口', menuInfo.join(' | '));
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.ps-menu-pop .ps-menu-item')).find(x => x.textContent.indexOf('导出…') === 0);
    if (b) b.click();
  });
  await page.waitForTimeout(140);
  const dlg = await page.evaluate(() => ({
    wide: !!document.querySelector('.ps-modal.ps-modal-wide'),
    labels: Array.from(document.querySelectorAll('.ps-modal .ps-field > span')).map(s => s.textContent),
    note: (document.querySelector('.ps-modal-note') || {}).textContent || ''
  }));
  check(dlg.wide && dlg.labels.join(',') === '文件名,格式,质量,缩放,范围,背景色' && /JPG/.test(dlg.note),
    '导出对话框字段齐全', dlg.labels.join(' / '));
  await page.evaluate(() => { const b = document.querySelector('.ps-modal-wrap [data-m="cancel"]'); if (b) b.click(); });
  await page.waitForTimeout(100);

  const exp = await page.evaluate(() => window.psLab.__test.exportBlob('image/png'));
  check(exp && exp.size > 0 && exp.w === 1600 && exp.h === 1000, '导出 PNG', exp && (exp.size + ' bytes · ' + exp.w + '×' + exp.h));

  /* 6.1 导出参数：缩放 + JPG 质量 / 选区裁剪 / 当前图层 */
  const expHalf = await page.evaluate(() => window.psLab.__test.exportBlob('image/jpeg', { scale: 0.5, quality: 0.6 }));
  check(expHalf && expHalf.w === 800 && expHalf.h === 500 && expHalf.type === 'image/jpeg' && expHalf.size > 0,
    '导出支持缩放与 JPG 质量', expHalf && (expHalf.w + '×' + expHalf.h + ' · ' + expHalf.type + ' · ' + expHalf.size + ' bytes'));
  await page.evaluate(() => window.psLab.__test.selectRect({ x: 100, y: 120, w: 300, h: 200 }));
  const expSel = await page.evaluate(() => window.psLab.__test.exportBlob('image/png', { scope: 'selection' }));
  check(expSel && expSel.w === 300 && expSel.h === 200, '按选区导出裁剪到选区范围', expSel && (expSel.w + '×' + expSel.h));
  await page.evaluate(() => window.psLab.__test.selectClear());
  const expLayer = await page.evaluate(() => window.psLab.__test.exportBlob('image/png', { scope: 'layer' }));
  check(expLayer && expLayer.size > 0 && expLayer.w > 0, '导出当前图层', expLayer && (expLayer.w + '×' + expLayer.h));

  /* 6.2 置入图片：新增图层且可撤销 / 重做 */
  const placeBase = (await page.evaluate(() => window.psLab.__debug())).doc.layers;
  const placed = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 30;
    const x = c.getContext('2d');
    x.fillStyle = '#00ff88'; x.fillRect(0, 0, 40, 30);
    return window.psLab.__test.placeDataURL(c.toDataURL('image/png'), '置入测试');
  });
  check(placed && placed.layers === placeBase + 1, '置入图片新增图层', placeBase + ' → ' + (placed && placed.layers));
  const undoPlace = await page.evaluate(() => window.psLab.__test.undo());
  const placeUndone = (await page.evaluate(() => window.psLab.__debug())).doc.layers;
  check(!!undoPlace && placeUndone === placeBase, '撤销置入移除图层', placeBase + ' → ' + placeUndone);
  await page.evaluate(() => window.psLab.__test.redo());

  /* 6.3 工程保存 / 打开：尺寸、图层数量与类型、像素都能还原 */
  const round = await page.evaluate(async () => {
    const payload = await window.psLab.__test.serialize();
    const json = JSON.stringify(payload);
    const before = {
      layers: payload.layers.length,
      types: payload.layers.map(l => l.type),
      name: payload.doc.name
    };
    const pts = [[60, 60], [760, 215], [100, 100]];
    const pxBefore = pts.map(p => window.psLab.__test.flattenSample(p[0], p[1]));
    const result = await window.psLab.__test.deserialize(JSON.parse(json));
    const pxAfter = pts.map(p => window.psLab.__test.flattenSample(p[0], p[1]));
    const dbg = window.psLab.__debug();
    return { before, result, pxBefore, pxAfter, size: json.length, history: dbg.history.length };
  });
  check(round.result.w === 1600 && round.result.h === 1000
    && round.result.layers === round.before.layers
    && round.result.types.join(',') === round.before.types.join(',')
    && round.result.name === round.before.name,
    '工程保存 / 打开保持文档与图层结构',
    round.before.layers + ' 层 / ' + round.before.types.join('+') + ' · JSON ' + Math.round(round.size / 1024) + ' KB');
  check(round.history === 0, '打开工程后历史从空开始', 'history=' + round.history);
  check(JSON.stringify(round.pxBefore) === JSON.stringify(round.pxAfter),
    '工程还原后合成像素完全一致', JSON.stringify(round.pxBefore) + ' → ' + JSON.stringify(round.pxAfter));

  /* 6.4 可收纳界面 */
  const wsCount = await page.evaluate(() => document.querySelectorAll('#psWorkspace [data-ws]').length);
  check(wsCount === 4, '工作区收纳按钮齐全', wsCount + ' 个');
  await page.evaluate(() => document.querySelector('#psWorkspace [data-ws="side"]').click());
  await page.waitForTimeout(80);
  const sideHidden = await page.evaluate(() => getComputedStyle(document.querySelector('#psApp .ps-side')).display === 'none');
  await page.evaluate(() => document.querySelector('#psWorkspace [data-ws="side"]').click());
  await page.waitForTimeout(80);
  const sideBack = await page.evaluate(() => getComputedStyle(document.querySelector('#psApp .ps-side')).display !== 'none');
  check(sideHidden && sideBack, '右侧面板可收起 / 恢复', sideHidden + ' → ' + sideBack);

  await page.evaluate(() => document.querySelector('[data-col="layers"]').click());
  await page.waitForTimeout(80);
  const cardCollapsed = await page.evaluate(() => {
    const c = document.getElementById('psLayersCard');
    return c.classList.contains('is-collapsed') && getComputedStyle(document.getElementById('psLayerList')).display === 'none';
  });
  await page.evaluate(() => document.querySelector('[data-col="layers"]').click());
  await page.waitForTimeout(80);
  const cardBack = await page.evaluate(() => getComputedStyle(document.getElementById('psLayerList')).display !== 'none');
  check(cardCollapsed && cardBack, '图层面板可折叠 / 展开', cardCollapsed + ' → ' + cardBack);

  const dragOrder = await page.evaluate(() => {
    const list = document.getElementById('psLayerList');
    const rows = Array.from(list.querySelectorAll('.ps-lay'));
    const before = rows.map(r => r.dataset.id);
    const src = rows[0];
    const dst = rows[rows.length - 1];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const rect = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: rect.bottom - 2 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: rect.bottom - 2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    const after = Array.from(list.querySelectorAll('.ps-lay')).map(r => r.dataset.id);
    return { before, after };
  });
  check(dragOrder.before.length > 1 && dragOrder.after[dragOrder.after.length - 1] === dragOrder.before[0]
    && dragOrder.after[0] !== dragOrder.before[0],
    '图层可拖拽调整顺序', dragOrder.before.join(',') + ' → ' + dragOrder.after.join(','));
  const orderUndone = await page.evaluate(() => {
    window.psLab.__test.undo();
    return Array.from(document.querySelectorAll('#psLayerList .ps-lay')).map(r => r.dataset.id);
  });
  check(JSON.stringify(orderUndone) === JSON.stringify(dragOrder.before), '撤销可还原图层顺序', orderUndone.join(','));
  await page.evaluate(() => window.psLab.__test.redo());

  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  const focusHidden = await page.evaluate(() => {
    const a = document.getElementById('psApp');
    return a.classList.contains('is-hide-tools') && a.classList.contains('is-hide-side')
      && getComputedStyle(document.querySelector('#psApp .ps-toolbar')).display === 'none';
  });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  const focusBack = await page.evaluate(() => !document.getElementById('psApp').classList.contains('is-hide-tools'));
  check(focusHidden && focusBack, 'Tab 专注模式可收起 / 恢复全部面板', focusHidden + ' → ' + focusBack);

  await page.evaluate(() => document.getElementById('psStatZoom').click());
  await page.waitForTimeout(80);
  const zItems = await page.evaluate(() => Array.from(document.querySelectorAll('.ps-zoom-pop .ps-menu-item')).length);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.ps-zoom-pop .ps-menu-item')).find(x => x.textContent.indexOf('50%') === 0);
    if (b) b.click();
  });
  await page.waitForTimeout(120);
  const z50 = await page.evaluate(() => window.psLab.__debug().zoom);
  check(zItems >= 7 && Math.abs(z50 - 0.5) < 0.01, '状态栏缩放菜单可用', zItems + ' 项 · zoom=' + z50);
  await page.evaluate(() => document.querySelector('#psZoomCtl [data-zoom="fit"]').click());

  /* 7. 超大图导入前自动降采样 */
  const plan = await page.evaluate(() => window.psLab.__test.planImport(12000, 8000));
  check(plan.limited && plan.width < 12000 && plan.width * plan.height <= 48e6,
    '12000×8000 自动降采样', plan.width + '×' + plan.height + ' · scale=' + plan.scale.toFixed(3));

  /* 8. 3000×2000 大图导入 + mip */
  const bigUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 2000;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 3000, 2000);
    g.addColorStop(0, '#123456'); g.addColorStop(1, '#fedcba');
    x.fillStyle = g; x.fillRect(0, 0, 3000, 2000);
    x.fillStyle = 'rgba(255,255,255,.9)';
    x.font = 'bold 180px sans-serif';
    x.fillText('BIG', 280, 1200);
    return c.toDataURL('image/png');
  });
  const imp = await page.evaluate(async url => window.psLab.__test.importDataURL(url, '测试大图'), bigUrl);
  check(imp && imp.w === 3000 && imp.h === 2000, '导入 3000×2000 大图', imp && (imp.w + '×' + imp.h + ' · ' + imp.layers + ' 层'));
  await page.waitForTimeout(1600);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.mips > 0, '大图导入后 mip 生成', dbg.mips + ' 层 mip');
  check(dbg.tiles > 0, '大图按瓦片存储', dbg.tiles + ' 瓦片 · ' + Math.round(dbg.memory / 1048576) + ' MB 估算');

  /* 10. 图层蒙版：非破坏性隐藏、撤销、停用、应用、存档往返 */
  await page.evaluate(() => window.psLab.__test.setOption('size', 40));
  const maskAdded = await page.evaluate(() => window.psLab.__test.maskAdd());
  let maskLayer = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(maskAdded && maskLayer.mask && maskLayer.mask.enabled && maskLayer.mask.tiles === 0,
    '添加图层蒙版（默认全显示）', JSON.stringify(maskLayer.mask));

  const maskUi = await page.evaluate(() => ({
    thumb: !!document.querySelector('#psLayerList .ps-lay.is-on .ps-lay-mask'),
    buttons: document.querySelectorAll('#psLayerProps .ps-mask-row [data-mask-act]').length
  }));
  check(maskUi.thumb && maskUi.buttons >= 4, '图层面板出现蒙版缩略图与操作按钮',
    'thumb=' + maskUi.thumb + ' · buttons=' + maskUi.buttons);
  await page.click('#psLayerList .ps-lay.is-on .ps-lay-mask');
  const editOff = await page.evaluate(() => window.psLab.__test.activeLayer().maskEditing);
  await page.click('#psLayerList .ps-lay.is-on .ps-lay-mask');
  const editOn = await page.evaluate(() => window.psLab.__test.activeLayer().maskEditing);
  check(editOff === false && editOn === true, '点击蒙版缩略图切换编辑目标', editOff + ' → ' + editOn);

  const maskPaint = await page.evaluate(() => window.psLab.__test.maskPaintAt(300, 300));
  await page.waitForTimeout(120);
  const maskHide = await page.evaluate(() => window.psLab.__test.maskValue(300, 300));
  const maskShow = await page.evaluate(() => window.psLab.__test.maskValue(900, 900));
  const flatHidden = await page.evaluate(() => window.psLab.__test.flattenSample(300, 300));
  const flatVisible = await page.evaluate(() => window.psLab.__test.flattenSample(900, 900));
  check(maskPaint && maskHide > 0.8 && maskShow < 0.01 && flatHidden.a < 30 && flatVisible.a > 240,
    '蒙版只隐藏落笔处，其余保持可见',
    'hide=' + maskHide.toFixed(2) + ' · show=' + maskShow.toFixed(2) + ' · a=' + flatHidden.a + '/' + flatVisible.a);

  await page.evaluate(() => window.psLab.__test.undo());
  check((await page.evaluate(() => window.psLab.__test.maskValue(300, 300))) < 0.01, '撤销蒙版笔画恢复显示');
  await page.evaluate(() => window.psLab.__test.redo());
  check((await page.evaluate(() => window.psLab.__test.maskValue(300, 300))) > 0.8, '重做蒙版笔画再次隐藏');

  const toggledOff = await page.evaluate(() => window.psLab.__test.maskToggle());
  const flatDisabled = await page.evaluate(() => window.psLab.__test.flattenSample(300, 300));
  check(toggledOff === false && flatDisabled.a > 240, '停用蒙版后图层完整显示', 'a=' + flatDisabled.a);
  await page.evaluate(() => window.psLab.__test.maskToggle());

  const applied = await page.evaluate(() => window.psLab.__test.maskApply());
  maskLayer = await page.evaluate(() => window.psLab.__test.activeLayer());
  const flatBaked = await page.evaluate(() => window.psLab.__test.flattenSample(300, 300));
  check(applied && !maskLayer.mask && flatBaked.a < 30, '应用蒙版：结果烘焙进像素且蒙版移除', 'a=' + flatBaked.a);
  await page.evaluate(() => window.psLab.__test.undo());
  maskLayer = await page.evaluate(() => window.psLab.__test.activeLayer());
  check(!!maskLayer.mask && (await page.evaluate(() => window.psLab.__test.flattenSample(300, 300))).a < 30,
    '撤销应用蒙版：蒙版与像素一起回来');
  await page.evaluate(() => window.psLab.__test.redo());
  await page.evaluate(() => window.psLab.__test.undo());

  const project = await page.evaluate(async () => {
    const doc = window.psLab.__test.doc();
    const payload = await PS.serializeDoc(doc);
    const item = payload.layers.find(l => l.mask);
    const back = await PS.deserializeDoc(payload);
    const bl = back.layers.find(l => l.mask);
    let alpha = -1;
    if (bl && bl.mask) {
      const mt = bl.mask.tiles.get('1,1');
      if (mt) alpha = mt.ctx.getImageData(300 - 256, 300 - 256, 1, 1).data[3];
    }
    return {
      version: payload.version,
      hasPng: !!(item && item.mask && item.mask.png),
      tiles: item && item.mask ? item.mask.tiles.length : 0,
      backMask: !!bl,
      alpha: alpha,
      locks: payload.layers[0].locks
    };
  });
  check(project.version === 2 && project.hasPng && project.tiles >= 1 && project.backMask && project.alpha > 200,
    '工程存档往返保留蒙版', JSON.stringify(project));

  const maskDeleted = await page.evaluate(() => window.psLab.__test.maskDelete());
  maskLayer = await page.evaluate(() => window.psLab.__test.activeLayer());
  const flatAfterDelete = await page.evaluate(() => window.psLab.__test.flattenSample(300, 300));
  check(maskDeleted && !maskLayer.mask && flatAfterDelete.a > 240, '删除蒙版恢复完整像素', 'a=' + flatAfterDelete.a);
  await page.evaluate(() => window.psLab.__test.undo());

  /* 11. 图像像素锁：工具与滤镜都被拦截 */
  await page.evaluate(() => window.psLab.__test.lockSet('image', true));
  const lockedPaint = await page.evaluate(() => window.psLab.__test.brushAt(700, 700));
  await page.evaluate(() => window.psLab.__test.lockSet('image', false));
  check(lockedPaint === false, '锁定图像像素后画笔被拒绝', 'paint=' + lockedPaint);
  const unlockedPaint = await page.evaluate(() => window.psLab.__test.brushAt(700, 700));
  check(unlockedPaint === true, '解锁后画笔恢复', 'paint=' + unlockedPaint);

  /* 透明像素锁：可以改颜色，但不能凭空长出新像素 */
  await page.evaluate(() => window.psLab.__test.addLayer('透明锁测试'));
  await page.evaluate(() => window.psLab.__test.lockSet('transparent', true));
  await page.evaluate(() => window.psLab.__test.brushAt(400, 400));
  const alphaLockedPx = await page.evaluate(() => window.psLab.__test.layerAlphaAt(400, 400));
  await page.evaluate(() => window.psLab.__test.lockSet('transparent', false));
  await page.evaluate(() => window.psLab.__test.brushAt(400, 400));
  const alphaFreePx = await page.evaluate(() => window.psLab.__test.layerAlphaAt(400, 400));
  check(alphaLockedPx === 0 && alphaFreePx > 0,
    '透明像素锁阻止新像素、解锁后可画', 'locked.a=' + alphaLockedPx + ' · free.a=' + alphaFreePx);

  /* 12. 抓手与缩放工具（不再是占位） */
  const canvasBox = await page.evaluate(() => {
    const c = document.querySelector('#imgLabWin canvas.ps-canvas');
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const pan0 = await page.evaluate(() => window.psLab.__debug().pan);
  await page.click('#psTools [data-tool="hand"]');
  await page.mouse.move(canvasBox.left + canvasBox.w / 2, canvasBox.top + canvasBox.h / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.left + canvasBox.w / 2 + 70, canvasBox.top + canvasBox.h / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const pan1 = await page.evaluate(() => window.psLab.__debug().pan);
  check(Math.abs(pan1.x - pan0.x - 70) < 6 && Math.abs(pan1.y - pan0.y - 30) < 6,
    '抓手工具拖拽平移', 'Δ=' + Math.round(pan1.x - pan0.x) + ',' + Math.round(pan1.y - pan0.y));

  const zoom0 = await page.evaluate(() => window.psLab.__debug().zoom);
  await page.click('#psTools [data-tool="zoom"]');
  await page.mouse.click(canvasBox.left + canvasBox.w / 2, canvasBox.top + canvasBox.h / 2);
  await page.waitForTimeout(120);
  const zoom1 = await page.evaluate(() => window.psLab.__debug().zoom);
  check(zoom1 > zoom0 * 1.2, '缩放工具单击放大', zoom0.toFixed(2) + ' → ' + zoom1.toFixed(2));

  /* 13. 直方图 */
  const hist = await page.evaluate(() => window.psLab.__test.histogram());
  check(hist && hist.w > 100 && hist.alphaSum > 1000, '导航器 RGB 直方图有数据',
    hist && (hist.w + '×' + hist.h + ' · sum=' + hist.alphaSum));

  /* 14. 通道面板：RGB/R/G/B 四行、缩略图、单独查看、Ctrl+2 返回 */
  await page.click('#psLayerTabs [data-ltab="channels"]');
  await page.waitForTimeout(200);
  const chUi = await page.evaluate(() => ({
    rows: document.querySelectorAll('#psLayerList .ps-ch-row').length,
    thumbs: document.querySelectorAll('#psLayerList .ps-ch-thumb').length,
    count: (document.getElementById('psLayerCount') || {}).textContent
  }));
  check(chUi.rows === 4 && chUi.thumbs === 4 && chUi.count === '4',
    '通道面板列出 RGB/R/G/B 四行', JSON.stringify(chUi));

  await page.click('#psLayerList [data-ch="r"]');
  await page.waitForTimeout(150);
  const chR = await page.evaluate(() => ({
    ch: window.psLab.__test.channel(),
    mode: document.getElementById('psStatMode').textContent,
    tab: window.psLab.__debug().layerTab
  }));
  check(chR.ch === 'r' && chR.mode.indexOf('红') === 0 && chR.tab === 'channels',
    '单击红通道进入单通道预览并同步状态栏', JSON.stringify(chR));

  await page.keyboard.press('Control+2');
  await page.waitForTimeout(150);
  const chBack = await page.evaluate(() => ({
    ch: window.psLab.__test.channel(),
    mode: document.getElementById('psStatMode').textContent
  }));
  check(chBack.ch === 'rgb' && chBack.mode === 'RGB · 8 位', 'Ctrl+2 回到 RGB 复合视图', JSON.stringify(chBack));

  /* 15. 路径面板：列出矢量形状、单击选中、眼睛隐藏 */
  await page.evaluate(() => {
    window.psLab.__test.addShape(
      { kind: 'rect', x: 120, y: 120, w: 220, h: 140, fill: '#22d3ee', stroke: null, strokeWidth: 0 }, '路径测试矩形');
    window.psLab.__test.addShape(
      { kind: 'ellipse', x: 380, y: 160, w: 170, h: 120, fill: null, stroke: '#ff3355', strokeWidth: 4 }, '路径测试椭圆');
  });
  await page.click('#psLayerTabs [data-ltab="paths"]');
  await page.waitForTimeout(180);
  const pathUi = await page.evaluate(() => ({
    heads: document.querySelectorAll('#psLayerList .ps-path-head').length,
    rows: document.querySelectorAll('#psLayerList .ps-path-row').length,
    labels: Array.from(document.querySelectorAll('#psLayerList .ps-path-meta b')).map(x => x.textContent).join(',')
  }));
  check(pathUi.rows >= 2 && pathUi.heads >= 2
    && pathUi.labels.indexOf('矩形') >= 0 && pathUi.labels.indexOf('椭圆') >= 0,
    '路径面板列出矢量形状（矩形 / 椭圆）', JSON.stringify(pathUi));

  const firstPath = await page.evaluate(() => {
    const row = document.querySelector('#psLayerList .ps-path-row');
    return row ? { layer: row.dataset.layer, index: Number(row.dataset.index) } : null;
  });
  await page.click('#psLayerList .ps-path-row');
  await page.waitForTimeout(160);
  const pathPick = await page.evaluate(() => ({
    active: window.psLab.__debug().doc.active,
    shapeSel: window.psLab.__test.preview().shapeSel
  }));
  check(!!firstPath && pathPick.active === firstPath.layer && pathPick.shapeSel,
    '路径面板单击选中形状并在画布高亮', JSON.stringify(pathPick) + ' · row=' + JSON.stringify(firstPath));

  const eyeId = await page.evaluate(() => {
    const head = document.querySelector('#psLayerList .ps-path-head');
    return head ? head.dataset.pathHead : null;
  });
  await page.click('#psLayerList .ps-path-head .ps-path-eye');
  await page.waitForTimeout(140);
  const visOff = await page.evaluate(id => {
    const l = window.psLab.__test.doc().layers.find(x => x.id === id);
    return l ? l.visible : null;
  }, eyeId);
  check(visOff === false, '路径面板眼睛隐藏矢量图层', 'visible=' + visOff);
  await page.click('#psLayerList .ps-path-head .ps-path-eye');

  /* 16. 菜单：展开状态下横向悬停标题直接切换 */
  const menuSwitch = await page.evaluate(async () => {
    const btns = Array.from(document.querySelectorAll('#psMenus .ps-menu'));
    if (btns.length < 2) return { ok: false };
    btns[0].click();
    await new Promise(r => setTimeout(r, 70));
    const first = document.querySelector('.ps-menu-pop');
    const firstText = first ? first.textContent : '';
    btns[1].dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise(r => setTimeout(r, 70));
    const second = document.querySelector('.ps-menu-pop');
    return {
      open: !!second,
      changed: !!second && second.textContent !== firstText,
      onlyOne: document.querySelectorAll('.ps-menu-pop').length === 1
    };
  });
  check(menuSwitch.open && menuSwitch.changed && menuSwitch.onlyOne,
    '菜单展开时悬停标题可切换', JSON.stringify(menuSwitch));
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));

  /* 17. 移动对齐辅助：文档中心 / 其他图层边缘吸附、Ctrl 临时关闭、Shift 约束 */
  await page.click('#psTools [data-tool="move"]');
  check(await page.evaluate(() => window.psLab.__test.options().moveSnap === true), '移动工具默认开启对齐', '');
  await page.evaluate(() => {
    window.psLab.__test.addShape(
      { kind: 'rect', x: 400, y: 300, w: 200, h: 100, fill: '#22d3ee', stroke: null, strokeWidth: 0 }, '对齐目标');
    window.psLab.__test.addShape(
      { kind: 'rect', x: 1200, y: 900, w: 200, h: 100, fill: '#f6c445', stroke: null, strokeWidth: 0 }, '对齐移动');
  });
  const vpAlign = await page.evaluate(() => {
    const c = document.querySelector('#imgLabWin canvas.ps-canvas');
    const r = c.getBoundingClientRect();
    const d = window.psLab.__debug();
    return { left: r.left, top: r.top, px: d.pan.x, py: d.pan.y, z: d.zoom };
  });
  const SA = (x, y) => ({ x: vpAlign.left + vpAlign.px + x * vpAlign.z, y: vpAlign.top + vpAlign.py + y * vpAlign.z });

  const centerFrom = SA(1300, 950);
  const centerTo = SA(1490, 950);
  await page.mouse.move(centerFrom.x, centerFrom.y);
  await page.mouse.down();
  await page.mouse.move(centerTo.x, centerTo.y, { steps: 8 });
  await page.waitForTimeout(100);
  const snapCenter = await page.evaluate(() => ({
    layer: window.psLab.__test.activeLayer(),
    guides: window.psLab.__debug().guides
  }));
  await page.mouse.up();
  check(snapCenter.layer && snapCenter.layer.bounds
    && Math.round(snapCenter.layer.bounds.x + snapCenter.layer.bounds.w / 2) === 1500
    && snapCenter.guides.indexOf('v:1500') >= 0,
    '移动吸附到文档中心并显示参考线',
    'bounds=' + JSON.stringify(snapCenter.layer && snapCenter.layer.bounds) + ' · guides=' + JSON.stringify(snapCenter.guides));

  const ctrlFrom = SA(1500, 950);
  const ctrlTo = SA(1490, 950);
  await page.mouse.move(ctrlFrom.x, ctrlFrom.y);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.move(ctrlTo.x, ctrlTo.y, { steps: 5 });
  await page.waitForTimeout(100);
  const ctrlState = await page.evaluate(() => ({
    layer: window.psLab.__test.activeLayer(),
    guides: window.psLab.__debug().guides
  }));
  await page.mouse.up();
  await page.keyboard.up('Control');
  check(ctrlState.layer && ctrlState.layer.bounds && Math.round(ctrlState.layer.bounds.x) === 1390
    && ctrlState.guides.length === 0,
    '按住 Ctrl 临时关闭吸附',
    'bounds=' + JSON.stringify(ctrlState.layer && ctrlState.layer.bounds) + ' · guides=' + JSON.stringify(ctrlState.guides));

  const edgeFrom = SA(1490, 950);
  const edgeTo = SA(690, 950);
  await page.mouse.move(edgeFrom.x, edgeFrom.y);
  await page.mouse.down();
  await page.mouse.move(edgeTo.x, edgeTo.y, { steps: 10 });
  await page.waitForTimeout(100);
  const snapEdge = await page.evaluate(() => ({
    layer: window.psLab.__test.activeLayer(),
    guides: window.psLab.__debug().guides
  }));
  await page.mouse.up();
  check(snapEdge.layer && snapEdge.layer.bounds && Math.round(snapEdge.layer.bounds.x) === 600
    && snapEdge.guides.indexOf('v:600') >= 0,
    '移动吸附到其他图层边缘',
    'bounds=' + JSON.stringify(snapEdge.layer && snapEdge.layer.bounds) + ' · guides=' + JSON.stringify(snapEdge.guides));

  await page.evaluate(() => window.psLab.__test.setOption('moveSnap', false));
  const shiftFrom = SA(690, 950);
  const shiftTo = SA(760, 990);
  await page.mouse.move(shiftFrom.x, shiftFrom.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(shiftTo.x, shiftTo.y, { steps: 5 });
  await page.waitForTimeout(80);
  const shiftState = await page.evaluate(() => window.psLab.__test.activeLayer());
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.evaluate(() => window.psLab.__test.setOption('moveSnap', true));
  check(shiftState && shiftState.bounds
    && Math.round(shiftState.bounds.x) === 670 && Math.round(shiftState.bounds.y) === 900,
    'Shift 约束为水平移动',
    'bounds=' + JSON.stringify(shiftState && shiftState.bounds));

  /* 18. 矢量布尔运算：同一形状层里的合并 / 减去 / 相交 / 排除 */
  const boolState = await page.evaluate(() => {
    window.psLab.__test.setMode('vector');
    const doc = window.psLab.__test.doc();
    const layer = PS.addShapeLayer(doc, [
      { kind: 'rect', x: 100, y: 100, w: 200, h: 200, fill: '#ff0000', stroke: null, strokeWidth: 0, op: 'add' },
      { kind: 'rect', x: 200, y: 200, w: 200, h: 200, fill: '#00ff00', stroke: null, strokeWidth: 0, op: 'subtract' }
    ], { name: '布尔测试' });
    function read(op) {
      if (op) PS.setShapeOp(doc, layer, layer.shapes[1], op);
      const cv = PS.renderLayer(layer);
      const c = cv.ctx;
      const px = (x, y) => Array.from(c.getImageData(x, y, 1, 1).data);
      return { a: px(150, 150), hole: px(250, 250), b: px(350, 350) };
    }
    const sub = read();
    const inter = read('intersect');
    const excl = read('exclude');
    const shapes = window.psLab.__test.shapes();
    const lone = PS.addShapeLayer(doc, [
      { kind: 'rect', x: 10, y: 10, w: 40, h: 40, fill: '#0000ff', op: 'subtract' }
    ], { name: '首形状' });
    const lonePx = Array.from(PS.renderLayer(lone).ctx.getImageData(20, 20, 1, 1).data);
    return { sub, inter, excl, shapes, lone: lonePx };
  });
  check(boolState.shapes.length === 2 && boolState.shapes[1].op === 'exclude',
    '同一形状层容纳多条布尔路径', JSON.stringify(boolState.shapes));
  check(boolState.sub.a[3] === 255 && boolState.sub.hole[3] === 0 && boolState.sub.b[3] === 0,
    '减去：重叠区被挖空', JSON.stringify(boolState.sub));
  check(boolState.inter.a[3] === 0 && boolState.inter.hole[3] === 255
    && boolState.inter.b[3] === 0,
    '相交：只保留重叠区', JSON.stringify(boolState.inter));
  check(boolState.excl.a[3] === 255 && boolState.excl.hole[3] === 0 && boolState.excl.b[3] === 255,
    '排除：只保留不重叠区', JSON.stringify(boolState.excl));
  check(boolState.lone[3] === 255, '首条路径即使标记为减去也按合并绘制', JSON.stringify(boolState.lone));

  const appendState = await page.evaluate(() => {
    window.psLab.__test.addShape(
      { kind: 'ellipse', x: 50, y: 50, w: 80, h: 80, fill: '#ffffff' }, '布尔追加');
    window.psLab.__test.appendShape(
      { kind: 'ellipse', x: 90, y: 90, w: 80, h: 80, fill: '#111111', op: 'subtract' });
    const s = window.psLab.__test.shapes();
    return { count: s.length, ops: s.map(x => x.op) };
  });
  check(appendState.count === 2 && appendState.ops.join(',') === 'add,subtract',
    '追加形状到当前矢量层并保留布尔标记', JSON.stringify(appendState));

  await page.click('#psTools [data-tool="shape"]');
  await page.waitForTimeout(80);
  const boolUi = await page.evaluate(() => Array.from(document.querySelectorAll('#psOptions [data-bool-op]'))
    .map(b => b.dataset.boolOp));
  await page.click('#psOptions [data-bool-op="subtract"]');
  const boolOpt = await page.evaluate(() => window.psLab.__test.options().vectorOp);
  check(boolUi.join(',') === 'add,subtract,intersect,exclude' && boolOpt === 'subtract',
    '形状选项栏提供四种布尔运算', JSON.stringify(boolUi) + ' · op=' + boolOpt);

  /* 19. PS 风格快捷键：颜色 / 选区切换 / 新建图层 / 笔刷参数 / 填充 */
  await page.evaluate(() => window.psLab.__test.setMode('raster'));
  await page.click('#psTools [data-tool="move"]');
  await page.click('#imgLabWin canvas.ps-canvas');

  const colors0 = await page.evaluate(() => {
    const d = window.psLab.__debug();
    return { fg: d.fg, bg: d.bg };
  });
  await page.keyboard.press('x');
  const colorsX = await page.evaluate(() => {
    const d = window.psLab.__debug();
    return { fg: d.fg, bg: d.bg };
  });
  await page.keyboard.press('d');
  const colorsD = await page.evaluate(() => {
    const d = window.psLab.__debug();
    return { fg: d.fg, bg: d.bg };
  });
  check(colorsX.fg === colors0.bg && colorsX.bg === colors0.fg
    && colorsD.fg === '#000000' && colorsD.bg === '#ffffff',
    'X 交换前景 / 背景色，D 复位黑白', JSON.stringify({ colors0, colorsX, colorsD }));

  await page.keyboard.press('m');
  const toolM = await page.evaluate(() => window.psLab.__test.options().tool);
  await page.keyboard.press('Shift+M');
  const toolM2 = await page.evaluate(() => window.psLab.__test.options().tool);
  check(toolM === 'select-rect' && toolM2 === 'select-ellipse',
    'Shift+M 在矩形 / 椭圆选区之间切换', toolM + ' → ' + toolM2);

  const layersBeforeNew = await page.evaluate(() => window.psLab.__debug().doc.layers);
  await page.keyboard.press('Control+Shift+N');
  await page.waitForTimeout(120);
  const layersAfterNew = await page.evaluate(() => window.psLab.__debug().doc.layers);
  check(layersAfterNew === layersBeforeNew + 1, 'Ctrl+Shift+N 新建图层',
    layersBeforeNew + ' → ' + layersAfterNew);
  await page.evaluate(() => window.psLab.__test.undo());

  await page.keyboard.press('b');
  const brush0 = await page.evaluate(() => window.psLab.__test.options());
  await page.keyboard.press('4');
  await page.keyboard.press('5');
  const brushOpacity = await page.evaluate(() => window.psLab.__test.options().opacity);
  await page.keyboard.press('0');
  const brushOpacity0 = await page.evaluate(() => window.psLab.__test.options().opacity);
  await page.keyboard.down('Shift');
  await page.keyboard.press('[');
  await page.keyboard.up('Shift');
  const brushHard = await page.evaluate(() => window.psLab.__test.options().hardness);
  check(brush0.opacity === 92 && brushOpacity === 45 && brushOpacity0 === 100 && brushHard === brush0.hardness - 10,
    '数字键设定不透明度，Shift+[ 降低硬度',
    JSON.stringify({ from: brush0.opacity, digits: brushOpacity, zero: brushOpacity0, hard: brush0.hardness + '→' + brushHard }));

  await page.click('#psTools [data-tool="move"]');
  await page.keyboard.press('5');
  await page.waitForTimeout(100);
  const layerOpacity = await page.evaluate(() => window.psLab.__test.activeLayer().opacity);
  check(Math.abs(layerOpacity - 0.5) < 0.001, '移动工具下数字键改图层不透明度', 'opacity=' + layerOpacity);
  await page.evaluate(() => window.psLab.__test.undo());

  const fillLayerId = await page.evaluate(() => window.psLab.__test.addLayer('快捷键填充'));
  await page.keyboard.press('Alt+Backspace');
  await page.waitForTimeout(150);
  const filledPx = await page.evaluate(() => window.psLab.__test.flattenSample(40, 40));
  check(!!fillLayerId && filledPx.r < 24 && filledPx.g < 24 && filledPx.b < 24,
    'Alt+Backspace 用前景色填充图层', JSON.stringify(filledPx));
  await page.evaluate(() => window.psLab.__test.undo());

  const modeKeys = await page.evaluate(() => window.psLab.__test.mode());
  await page.keyboard.press('F3');
  const modeF3 = await page.evaluate(() => window.psLab.__test.mode());
  await page.keyboard.press('F2');
  const modeF2 = await page.evaluate(() => window.psLab.__test.mode());
  check(modeKeys === 'raster' && modeF3 === 'vector' && modeF2 === 'raster',
    'F2 / F3 切换位图与矢量编辑器', [modeKeys, modeF3, modeF2].join(' → '));

  /* 9. 关闭按钮 */
  const closed = await page.evaluate(() => {
    const b = document.querySelector('#imgLabWin .os-win-close');
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(600);
  const hidden = await page.evaluate(() => {
    const w = document.getElementById('imgLabWin');
    return !!w && w.classList.contains('hidden');
  });
  check(closed && hidden, '关闭按钮能收回窗口', '');

  check(errors.length === 0, '无 pageerror', errors.join(' | '));

  await browser.close();
  console.log(fails ? '\n❌ ' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(1);
});
