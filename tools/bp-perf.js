/* 蓝图性能：拖拽/平移的帧间隔 + 连线更新的调用次数与耗时 + 连线几何正确性
 * 用法：node tools/bp-perf.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await sleep(900);

  const flow = await page.evaluate(() => {
    const f = FLOWS.find(x => (x.nodes || []).length > 20) || FLOWS[0];
    return { id: f.id, nodes: f.nodes.length, links: (f.links || []).length };
  });
  console.log('\n=== 0. 打开大流程 ===');
  await page.evaluate(id => openFlow(id), flow.id);
  await sleep(900);
  await page.evaluate(() => flushViewSwap());
  await sleep(500);
  check(flow.links > 40, '选中的流程连线够多（压力才够）', flow.nodes + ' 节点 / ' + flow.links + ' 连线');

  console.log('\n=== 1. 连线渲染是增量的吗 ===');
  const inst = await page.evaluate(() => {
    window.__rl = { calls: 0, ms: 0, partial: 0, full: 0, lastN: [] };
    const orig = window.renderLinks;
    window.renderLinks = function (moved) {
      const t0 = performance.now();
      const r = orig.apply(this, arguments);
      const dt = performance.now() - t0;
      window.__rl.calls++;
      window.__rl.ms += dt;
      if (moved instanceof Set) window.__rl.partial++; else window.__rl.full++;
      window.__rl.lastN.push(Math.round(dt * 100) / 100);
      if (window.__rl.lastN.length > 40) window.__rl.lastN.shift();
      return r;
    };
    window.__frames = [];
    let last = 0;
    const loop = t => { if (last) window.__frames.push(t - last); last = t; window.__raf = requestAnimationFrame(loop); };
    window.__raf = requestAnimationFrame(loop);
    return { links: document.querySelectorAll('#bpLinks .bp-link').length };
  });
  check(inst.links === flow.links, '连线 DOM 数与模型一致', inst.links + '/' + flow.links);

  console.log('\n=== 2. 拖一个有连线的节点（40 步） ===');
  const nid = await page.evaluate(() => {
    const l = (bp.links || [])[0];
    return l ? l.from.node : (bp.nodes[0] || {}).id;
  });
  const pt = await page.evaluate(id => {
    const r = document.getElementById('n-' + id).querySelector('.node-head').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, nid);
  await page.evaluate(() => { window.__frames.length = 0; window.__rl.calls = 0; window.__rl.ms = 0; window.__rl.partial = 0; window.__rl.full = 0; });
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(pt.x + i * 4, pt.y + i * 2);
    await sleep(10);
  }
  await page.mouse.up();
  await sleep(120);
  const drag = await page.evaluate(() => ({
    frames: window.__frames.slice(),
    rl: { calls: window.__rl.calls, ms: Math.round(window.__rl.ms * 10) / 10, partial: window.__rl.partial, full: window.__rl.full, worst: Math.max.apply(null, window.__rl.lastN.concat([0])) },
  }));
  const df = drag.frames.filter(d => d < 200);
  const dAvg = Math.round(df.reduce((a, b) => a + b, 0) / df.length);
  const dMax = Math.round(Math.max.apply(null, df));
  const dLong = df.filter(d => d > 50).length;
  console.log('   · 帧间隔 平均 ' + dAvg + 'ms / 最长 ' + dMax + 'ms / 长帧(>50ms) ' + dLong + ' 个');
  console.log('   · renderLinks 调 ' + drag.rl.calls + ' 次（增量 ' + drag.rl.partial + ' / 全量 ' + drag.rl.full + '），合计 ' + drag.rl.ms + 'ms，单次最慢 ' + drag.rl.worst + 'ms');
  check(dMax <= 50, '拖节点最长帧 ≤50ms', dMax + 'ms');
  check(dAvg <= 22, '拖节点平均帧 ≤22ms（约 45fps 以上）', dAvg + 'ms');
  check(drag.rl.partial >= drag.rl.calls * 0.8, '拖拽期几乎全是增量更新', drag.rl.partial + '/' + drag.rl.calls);
  check(drag.rl.calls <= 45, '每个 pointermove 至多一次更新（没有重复渲染）', drag.rl.calls + ' 次 / 40 步');

  console.log('\n=== 2b. 拖动中：跟手 + 零量测 + 位移只走 transform ===');
  // 先轻拖一次把引脚坐标喂进缓存（冷启动量一次是合理的）
  const warm = await page.evaluate(id => {
    const r = document.getElementById('n-' + id).querySelector('.node-head').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, nid);
  await page.mouse.move(warm.x, warm.y);
  await page.mouse.down();
  await page.mouse.move(warm.x + 2, warm.y + 1);
  await sleep(160);
  await page.mouse.up();
  await sleep(260);

  // 计数 getBoundingClientRect：应用代码在拖动期间不该再量任何东西
  await page.evaluate(() => {
    window.__rect = 0;
    const orig = Element.prototype.getBoundingClientRect;
    window.__rawRect = orig;
    Element.prototype.getBoundingClientRect = function () { window.__rect++; return orig.call(this); };
    window.__dev = [];
    const loop = () => {
      const id = window.__dragId;                 // 每帧现取，别在启动时锁死
      const el = id ? document.getElementById('n-' + id) : null;
      if (el) {
        const pins = [...el.querySelectorAll('.pin')].map(x => {
          const r = window.__rawRect.call(x);          // 用原始方法，别污染计数
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const c = window.__rawRect.call(document.getElementById('bpCanvas'));
        let worst = 0;
        (bp.links || []).forEach(l => {
          if (l.from.node !== id && l.to.node !== id) return;
          const pEl = document.querySelector('#bpLinks .bp-link[data-link="' + l.id + '"]');
          if (!pEl) return;
          const nums = (pEl.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g);
          if (!nums || nums.length < 8) return;
          const isTo = l.to.node === id;
          const sx = c.left + bpPan.x + parseFloat(isTo ? nums[6] : nums[0]) * bpZoom;
          const sy = c.top + bpPan.y + parseFloat(isTo ? nums[7] : nums[1]) * bpZoom;
          worst = Math.max(worst, pins.reduce((m, q) => Math.min(m, Math.hypot(q.x - sx, q.y - sy)), 1e9));
        });
        window.__dev.push(worst);
      }
      window.__raf2 = requestAnimationFrame(loop);
    };
    window.__raf2 = requestAnimationFrame(loop);
  }, undefined);

  await page.evaluate(id => { window.__dragId = id; }, nid);
  await page.evaluate(() => { window.__dev.length = 0; window.__rect = 0; });
  const p2 = await page.evaluate(id => {
    const r = window.__rawRect.call(document.getElementById('n-' + id).querySelector('.node-head'));
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left0: document.getElementById('n-' + id).style.left };
  }, nid);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  let midTf = '';
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(p2.x + i * 5, p2.y + i * 3);
    if (i === 20) midTf = await page.evaluate(id => document.getElementById('n-' + id).style.transform, nid);
    await sleep(10);
  }
  const during = await page.evaluate(id => {
    const el = document.getElementById('n-' + id);
    return { left: el.style.left, tf: el.style.transform };
  }, nid);
  await page.mouse.up();
  await sleep(200);
  const after = await page.evaluate(id => {
    const el = document.getElementById('n-' + id);
    const n = nodeById(id);
    return {
      tf: el.style.transform,
      left: parseFloat(el.style.left), top: parseFloat(el.style.top),
      mx: n.x, my: n.y,
      rects: window.__rect, dev: window.__dev.slice(),
      cleanup: (function(){ cancelAnimationFrame(window.__raf2); Element.prototype.getBoundingClientRect = window.__rawRect; return true; })(),
    };
  }, nid);
  const devMax = Math.max.apply(null, after.dev.concat([0]));
  const devAvg = Math.round(after.dev.reduce((a, b) => a + b, 0) / Math.max(1, after.dev.length) * 10) / 10;
  console.log('   · 拖动中连线端点偏差 平均 ' + devAvg + 'px / 最大 ' + Math.round(devMax * 10) / 10 + 'px');
  console.log('   · 拖动期间 getBoundingClientRect 调用 ' + after.rects + ' 次');
  console.log('   · 拖动中 transform=' + (midTf || '(空)') + '，left 仍为 ' + during.left);
  check(devMax <= 1.2, '拖动中连线始终贴着引脚（跟手，不飞线）', '最大偏差 ' + Math.round(devMax * 10) / 10 + 'px');
  check(after.rects <= 2, '拖动期间不做任何 DOM 量测（无强制重排）', after.rects + ' 次');
  check(/translate3d/.test(midTf), '位移走 transform（合成层属性，不触发布局）', midTf);
  check(during.left === p2.left0, '拖动期 left/top 一次都没改', p2.left0 + ' → ' + during.left);
  check(after.tf === '', '松手后 transform 折回 left/top', 'transform=' + (after.tf || '(空)'));
  check(after.left === after.mx && after.top === after.my, 'left/top 与模型坐标一致', after.left + ',' + after.top + ' vs ' + after.mx + ',' + after.my);

  console.log('\n=== 3. 拖完连线有没有错位 ===');
  const geo = await page.evaluate(() => {
    const c = $('bpCanvas').getBoundingClientRect();
    let worst = 0, bad = 0;
    bp.links.forEach(l => {
      const pa = document.querySelector('#n-' + l.from.node + ' .pin[data-dir="out"][data-key="' + l.from.key + '"]');
      const pb = document.querySelector('#n-' + l.to.node + ' .pin[data-dir="in"][data-key="' + l.to.key + '"]');
      const el = document.querySelector('#bpLinks .bp-link[data-link="' + l.id + '"]');
      if (!pa || !pb || !el) { bad++; return; }
      const ra = pa.getBoundingClientRect(), rb = pb.getBoundingClientRect();
      const ax = (ra.left + ra.width / 2 - c.left - bpPan.x) / bpZoom;
      const ay = (ra.top + ra.height / 2 - c.top - bpPan.y) / bpZoom;
      const bx = (rb.left + rb.width / 2 - c.left - bpPan.x) / bpZoom;
      const by = (rb.top + rb.height / 2 - c.top - bpPan.y) / bpZoom;
      const d = el.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
      worst = Math.max(worst, Math.abs(d[0] - ax), Math.abs(d[1] - ay), Math.abs(d[6] - bx), Math.abs(d[7] - by));
    });
    return { worst: Math.round(worst * 10) / 10, bad };
  });
  check(geo.bad === 0, '每条连线都还有对应元素', String(geo.bad) + ' 条缺失');
  check(geo.worst <= 1.5, '连线端点仍贴着引脚（增量更新没漏）', '最大偏差 ' + geo.worst + 'px');

  console.log('\n=== 4. 平移画布：底纹是否只走合成层 ===');
  const bg = await page.evaluate(() => {
    const c = $('bpCanvas'), g = $('bpGrid');
    return {
      hasGrid: !!g,
      canvasBgImg: getComputedStyle(c).backgroundImage,
      gridWillChange: g ? getComputedStyle(g).willChange : '',
      gridTransformBefore: g ? g.style.transform : '',
    };
  });
  check(bg.hasGrid === true, '底纹有独立图层 #bpGrid');
  check(bg.canvasBgImg === 'none', '画布本身不再背渐变（不会整块重绘）', bg.canvasBgImg);
  check(/transform/.test(bg.gridWillChange), '底纹层托管给合成器', bg.gridWillChange);

  await page.evaluate(() => { window.__frames.length = 0; });
  const cbox = await page.evaluate(() => { const r = $('bpCanvas').getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.y + 60) }; });
  await page.keyboard.down('Space');
  await page.mouse.move(cbox.x + 200, cbox.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) { await page.mouse.move(cbox.x + 200 + i * 5, cbox.y + 200 + i * 3); await sleep(10); }
  await page.mouse.up();
  await page.keyboard.up('Space');
  await sleep(120);
  const pan = await page.evaluate(() => ({
    frames: window.__frames.slice().filter(d => d < 200),
    bgPos: $('bpCanvas').style.backgroundPosition,
    gridT: $('bpGrid').style.transform,
  }));
  const pAvg = Math.round(pan.frames.reduce((a, b) => a + b, 0) / pan.frames.length);
  const pMax = Math.round(Math.max.apply(null, pan.frames));
  console.log('   · 平移帧间隔 平均 ' + pAvg + 'ms / 最长 ' + pMax + 'ms');
  console.log('   · 画布 background-position = "' + pan.bgPos + '"（应为空）｜底纹 transform = ' + pan.gridT);
  check(!pan.bgPos, '平移时不再写 background-position');
  check(pan.gridT && /translate3d/.test(pan.gridT), '平移只改底纹 transform', pan.gridT);
  check(pMax <= 50, '平移最长帧 ≤50ms', pMax + 'ms');

  const shotDir = path.join(__dirname, '..', '.workbuddy', 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, 'bp-pan.png') });

  console.log('\n=== 4b. 平移到底有没有重绘（CDP paintCount）===');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('LayerTree.enable');
  let lyr = [];
  cdp.on('LayerTree.layerTreeDidChange', e => { if (e.layers && e.layers.length) lyr = e.layers; });
  const grab = async () => {
    lyr = [];
    await page.evaluate(() => { bpPan.x += 1; applyBpTransform(); });
    await sleep(260);
    return lyr.map(l => ({ id: l.layerId, w: l.width, h: l.height, p: l.paintCount || 0 }));
  };
  const gbox = await page.evaluate(() => { const r = $('bpGrid').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  const cbox2 = await page.evaluate(() => { const r = $('bpCanvas').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
  const before = await grab();
  await page.mouse.move(cbox2.x, cbox2.y);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 20; i++) { await page.mouse.move(cbox2.x + i * 5, cbox2.y + i * 3); await sleep(8); }
  await page.mouse.up({ button: 'middle' });
  await sleep(200);
  const afterL = lyr.map(l => ({ id: l.layerId, w: l.width, h: l.height, p: l.paintCount || 0 }));
  const bm = new Map(afterL.map(x => [x.id, x]));
  const gLayer = before.find(x => Math.abs(x.w - gbox.w) <= 8 && Math.abs(x.h - gbox.h) <= 8);
  let gridPaint = null;
  if (gLayer) { const z = bm.get(gLayer.id); if (z) gridPaint = z.p - gLayer.p; }
  let rep = 0, cmp = 0, repArea = 0, repMax = 0;
  before.forEach(x => {
    const y = bm.get(x.id);
    if (!y) return;
    cmp++;
    if (y.p - x.p > 0) { rep++; repArea += x.w * x.h; repMax = Math.max(repMax, x.w * x.h); }
  });
  const cvArea = await page.evaluate(() => { const r = $('bpCanvas').getBoundingClientRect(); return r.width * r.height; });
  console.log('   · 底纹层 ' + gbox.w + '×' + gbox.h + '，平移 20 步后重绘 ' + gridPaint + ' 次');
  console.log('   · 其余重绘 ' + rep + '/' + cmp + ' 层，合计 ' + (repArea / 1e6).toFixed(2) + ' Mpx，单层最大 ' + Math.round(repMax / 1e3) + 'k px（画布 ' + Math.round(cvArea / 1e3) + 'k px）');
  check(gridPaint === 0, '平移期间底纹层一次都没重绘（走合成器，不是重画）', '重绘 ' + gridPaint + ' 次');
  // 节点滚进视口要重新栅格化，这是固有成本；要拦的是「整块画布跟着重画」
  check(repMax < cvArea, '没有任何一层重绘面积达到整块画布（不是全局重绘）', Math.round(repMax / 1e3) + 'k < ' + Math.round(cvArea / 1e3) + 'k px');
  check(repArea <= 3e6, '整段平移的重绘总量很小（只有新滚进来的节点）', (repArea / 1e6).toFixed(2) + ' Mpx');

  console.log('\n=== 4c. 缩放 LOD：小比例下砍掉图案层 ===');
  const lod = await page.evaluate(() => {
    const out = {};
    [0.38, 1].forEach(z => {
      bpZoom = z; applyBpTransform();
      out[z] = { lod: $('bpCanvas').dataset.gridLod, img: getComputedStyle($('bpGrid')).backgroundImage };
    });
    bpZoom = 1; applyBpTransform();
    return out;
  });
  const layerCount = img => (img.match(/gradient/g) || []).length;
  check(lod['0.38'].lod === '1' && layerCount(lod['0.38'].img) === 2, '缩到 38%：去掉 20px 点阵，只留细网格', '图案层 ' + layerCount(lod['0.38'].img));
  check(lod['1'].lod === '0' && layerCount(lod['1'].img) === 3, '100%：点阵与网格齐全', '图案层 ' + layerCount(lod['1'].img));

  console.log('\n=== 5. 页面错误 ===');
  check(errors.length === 0, '无 JS 报错', errors.slice(0, 3).join(' | ') || '干净');

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项未通过 ❌'));
  await browser.close();
  if (fails) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
