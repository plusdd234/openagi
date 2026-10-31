/* 描边内核体检：闭合轮廓 / 内孔 / 精确栅格化 / 抽稀容差 / 节点契约
 * 用法：node tools/tracer.js
 */
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
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Tracer !== 'undefined' && typeof THREE !== 'undefined', null, { timeout: 15000 });

  /* 合成图：白底 + 一个带洞的方块（模拟「两腿之间的空洞必须扣掉」） */
  const makeRing = (hole) => {
    const W = 200, H = 200;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#333';
    c.fillRect(40, 40, 120, 120);
    if (hole) { c.fillStyle = '#fff'; c.fillRect(80, 80, 40, 60); }
    return c.getImageData(0, 0, W, H);
  };

  console.log('=== 1. 实心块：外环闭合、IoU ≈ 1 ===');
  const solid = await page.evaluate((makeRingSrc) => {
    const makeRing = eval('(' + makeRingSrc + ')');
    const t = Tracer.trace(makeRing(false), { minArea: 100, simplify: 0 });
    const v = Tracer.verify(t);
    return { outers: t.outers.length, holes: t.info.holes, points: t.info.points, iou: v.iou, missing: v.missing, extra: v.extra };
  }, makeRing.toString());
  check('描到 1 个外环', solid.outers === 1, String(solid.outers));
  check('没有内孔', solid.holes === 0, String(solid.holes));
  check('回填与原图 IoU ≥ 0.999', solid.iou >= 0.999, String(solid.iou));
  check('多算/少算都很少', Math.abs(solid.missing) < 30 && Math.abs(solid.extra) < 30, solid.missing + '/' + solid.extra);

  console.log('=== 2. 带洞：内孔必须扣掉 ===');
  const ring = await page.evaluate((makeRingSrc) => {
    const makeRing = eval('(' + makeRingSrc + ')');
    const t = Tracer.trace(makeRing(true), { minArea: 100, simplify: 0, fillInterior: false });
    const v = Tracer.verify(t);
    return { outers: t.outers.length, holes: t.info.holes, iou: v.iou, holeArea: t.outers[0] && t.outers[0].holes[0] ? Math.abs(Tracer.areaOf(t.outers[0].holes[0])) : 0 };
  }, makeRing.toString());
  check('仍然只有 1 个外环', ring.outers === 1, String(ring.outers));
  check('识别出 1 个内孔', ring.holes === 1, String(ring.holes));
  check('内孔面积约 40×60=2400', Math.abs(ring.holeArea - 2400) < 60, String(ring.holeArea));
  check('带洞回填 IoU ≥ 0.999', ring.iou >= 0.999, String(ring.iou));

  console.log('=== 3. 抽稀：点数降下来，吻合度基本不丢 ===');
  const simp = await page.evaluate((makeRingSrc) => {
    const makeRing = eval('(' + makeRingSrc + ')');
    const a = Tracer.trace(makeRing(false), { minArea: 100, simplify: 0 });
    const b = Tracer.trace(makeRing(false), { minArea: 100, simplify: 4 });
    return { p0: a.info.points, p4: b.info.points, iou0: Tracer.verify(a).iou, iou4: Tracer.verify(b).iou };
  }, makeRing.toString());
  check('抽稀后点数明显减少', simp.p4 < simp.p0 / 2, simp.p0 + '→' + simp.p4);
  check('抽稀后 IoU 仍 ≥ 0.99', simp.iou4 >= 0.99, String(simp.iou4));

  console.log('=== 4. 透明度模式（渲染图用）===');
  const alpha = await page.evaluate(() => {
    const W = 120, H = 120;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,0)'; c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,1)';
    c.beginPath(); c.arc(60, 60, 40, 0, Math.PI * 2); c.fill();
    const t = Tracer.trace(c.getImageData(0, 0, W, H), { mode: 'alpha', minArea: 200, simplify: 0.5 });
    return { outers: t.outers.length, iou: Tracer.verify(t).iou };
  });
  check('白模型（透明底）也能描', alpha.outers === 1, String(alpha.outers));
  check('alpha 模式 IoU ≥ 0.99', alpha.iou >= 0.99, String(alpha.iou));

  console.log('=== 5. 建模产出 ===');
  const built = await page.evaluate(async (makeRingSrc) => {
    const makeRing = eval('(' + makeRingSrc + ')');
    const r = await Tracer.buildGLB(makeRing(true), { minArea: 100, simplify: 0.5, height: 1.6, labels: ['测试块'], fillInterior: false });
    const g = await new Promise((res, rej) => new THREE.GLTFLoader().load(r.dataURL, res, undefined, rej));
    const names = [];
    g.scene.traverse(o => { if (o.isMesh) names.push(o.name); });
    return { prefix: r.dataURL.slice(0, 30), meshes: r.stats.meshes, tris: r.stats.tris, fit: r.fit.iou, names, region: r.regions[0] };
  }, makeRing.toString());
  check('产出 GLB', built.prefix.indexOf('data:model/gltf-binary') === 0, built.prefix);
  check('网格名 = 标签', built.names[0] === '测试块', built.names.join(','));
  check('内孔进了几何（holes=1）', built.region.holes === 1, String(built.region.holes));
  check('GLB 里的吻合度也 ≥ 0.999', built.fit >= 0.999, String(built.fit));

  console.log('=== 6. 节点契约 ===');
  const node = await page.evaluate(() => {
    const seed = Object.assign({ type: 'traceRegions' }, seedNodeData('traceRegions'));
    const pins = pinsForRender(seed);
    return {
      has: !!NODE_REGISTRY.traceRegions,
      title: (NODE_REGISTRY.traceRegions || {}).title,
      inKeys: pins.in.map(p => p.key),
      outKeys: pins.out.map(p => p.key),
      seed: seed.data
    };
  });
  check('节点已注册', node.has && node.title.indexOf('参考图描边') === 0, node.title);
  check('输入是 image', node.inKeys.indexOf('image') >= 0, node.inKeys.join(','));
  check('输出 model + text', node.outKeys.join(',') === 'model,text', node.outKeys.join(','));
  check('默认参数齐全', node.seed.mode === 'light' && node.seed.simplify === 0.9 && node.seed.height === 1.6, JSON.stringify(node.seed));

  console.log('=== 7. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})();
