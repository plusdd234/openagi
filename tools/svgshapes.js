/* 原画分区块体检：闭合校验 / 采样 / 三角化 / 标签 / 平面朝向
 * 用法：node tools/svgshapes.js
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

const OK_SVG = `<svg viewBox="0 0 512 1024">
  <path id="hair" data-label="头发" data-fill="#d8d3e6" d="M256,40 C330,40 380,90 380,170 L380,420 L132,420 L132,170 C132,90 182,40 256,40 Z"/>
  <path id="body" data-label="身体" data-fill="#fbffff" d="M180,420 L332,420 L340,700 L172,700 Z"/>
  <path id="skirt" data-label="裙摆" d="M160,700 L352,700 L390,820 L122,820 Z"/>
  <circle id="head" data-label="头" data-fill="#f6dfd2" cx="256" cy="150" r="70"/>
</svg>`;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof SvgShapes !== 'undefined' && typeof THREE !== 'undefined', null, { timeout: 15000 });

  console.log('=== 1. 闭合校验 ===');
  const open = await page.evaluate(() => {
    const svg = '<svg viewBox="0 0 100 100"><path id="broken" d="M10,10 L90,10 L90,90"/></svg>';
    const r = SvgShapes.parse(svg);
    return { ok: r.ok, err: (r.errors || [])[0] || '' };
  });
  check('开口路径被拒', open.ok === false);
  check('报错里点名是哪一条', /broken/.test(open.err), open.err.slice(0, 60));
  check('提示要补 Z', /闭合/.test(open.err), open.err.slice(0, 60));

  const empty = await page.evaluate(() => SvgShapes.parse('<svg viewBox="0 0 10 10"></svg>'));
  check('空 SVG 被拒', empty.ok === false);

  console.log('=== 2. 解析与标签 ===');
  const parsed = await page.evaluate((svg) => {
    const r = SvgShapes.parse(svg);
    return {
      ok: r.ok,
      n: r.regions.length,
      labels: r.regions.map(x => x.label),
      colors: r.regions.map(x => x.color),
      viewBox: r.viewBox
    };
  }, OK_SVG);
  check('四条路径都解析出来', parsed.ok && parsed.n === 4, String(parsed.n));
  check('标签取自 data-label', parsed.labels.join(',') === '头发,身体,裙摆,头', parsed.labels.join(','));
  check('circle 也能转成闭合路径', parsed.labels.indexOf('头') >= 0);
  check('颜色取自 data-fill', parsed.colors[0] === '#d8d3e6', parsed.colors.join(','));

  const override = await page.evaluate((svg) => {
    const r = SvgShapes.parse(svg, { hair: { label: '头发（主）', color: '#ff0000' } });
    return r.regions[0];
  }, OK_SVG);
  check('标签可被覆盖参数改写', override.label === '头发（主）' && override.color === '#ff0000', override.label + '/' + override.color);

  console.log('=== 3. 采样与三角化 ===');
  const built = await page.evaluate(async (svg) => {
    const r = await SvgShapes.buildGLB(svg, { height: 1.6 });
    const g = await new Promise((res, rej) => new THREE.GLTFLoader().load(r.dataURL, res, undefined, rej));
    g.scene.updateMatrixWorld(true);
    const meshNames = [];
    g.scene.traverse(o => { if (o.isMesh) meshNames.push(o.name); });
    const box = new THREE.Box3().setFromObject(g.scene);
    return {
      regions: r.regions.map(x => ({ id: x.id, label: x.label, tris: x.tris, area: x.area2d, points: x.points })),
      stats: r.stats,
      meshNames,
      bbox: [box.min.toArray(), box.max.toArray()],
      scale: r.scale,
      glbPrefix: r.dataURL.slice(0, 30)
    };
  }, OK_SVG);
  check('产出 GLB', built.glbPrefix.indexOf('data:model/gltf-binary') === 0, built.glbPrefix);
  check('四块各自成网格', built.stats.meshes === 4, String(built.stats.meshes));
  check('每块都有三角面', built.regions.every(x => x.tris > 0), JSON.stringify(built.regions.map(x => x.tris)));
  check('曲线被采样成多边形（点数 > 12）', built.regions.every(x => x.points >= 12), JSON.stringify(built.regions.map(x => x.points)));
  check('面积按米算（>0）', built.regions.every(x => x.area > 0), JSON.stringify(built.regions.map(x => x.area)));
  check('网格名 = 标签（后面按标签找件）', built.meshNames.every(nm => ['头发', '身体', '裙摆', '头'].indexOf(nm) >= 0), built.meshNames.join(','));
  check('整图高度映射到 1.6m', Math.abs(built.scale - 1.6 / 1024) < 1e-9, String(built.scale));

  console.log('=== 3.5 按标签做 2D 控制 ===');
  const adj = await page.evaluate((svg) => {
    const base = SvgShapes.build(svg, { height: 1.6 });
    const moved = SvgShapes.build(svg, { height: 1.6, adjust: { '头发': { dx: 0.1, dy: 0 } } });
    const scaled = SvgShapes.build(svg, { height: 1.6, adjust: { 'hair': { s: 2 } } });
    const hidden = SvgShapes.build(svg, { height: 1.6, adjust: { '身体': { hide: true } } });
    const find = (r, label) => r.regions.find(x => x.label === label || x.id === label);
    return {
      baseHair: find(base, '头发').bbox,
      movedHair: find(moved, '头发').bbox,
      baseArea: find(base, 'hair').area2d,
      scaledArea: find(scaled, 'hair').area2d,
      baseMeshes: base.regions.length,
      hiddenMeshes: hidden.regions.length,
      hiddenWarn: (hidden.warnings || []).join('|')
    };
  }, OK_SVG);
  check('dx 让整块按米平移', Math.abs((adj.movedHair[0] - adj.baseHair[0]) - 0.1) < 0.01, JSON.stringify([adj.baseHair[0], adj.movedHair[0]]));
  check('缩放 2× 面积约 4×', Math.abs(adj.scaledArea / adj.baseArea - 4) < 0.15, adj.baseArea + '→' + adj.scaledArea);
  check('hide 让这块不生成', adj.hiddenMeshes === adj.baseMeshes - 1, adj.baseMeshes + '→' + adj.hiddenMeshes);
  check('隐藏时留下说明', /隐藏/.test(adj.hiddenWarn), adj.hiddenWarn.slice(0, 40));

  console.log('=== 4. 平面朝向（躺平在 XZ，正视能看到原图样子）===');
  const orient = await page.evaluate((svg) => {
    const r = SvgShapes.build(svg, { height: 1.6 });
    const mesh = r.group.children[0];
    return { rotX: mesh.rotation.x, y: mesh.position.y };
  }, OK_SVG);
  check('绕 X 轴 -90° 躺平', Math.abs(orient.rotX + Math.PI / 2) < 1e-6, String(orient.rotX));

  console.log('=== 5. 节点契约 ===');
  const node = await page.evaluate(() => {
    const seed = Object.assign({ type: 'svgRegions' }, seedNodeData('svgRegions'));
    const pins = pinsForRender(seed);
    return {
      has: !!NODE_REGISTRY.svgRegions,
      title: (NODE_REGISTRY.svgRegions || {}).title,
      inKeys: pins.in.map(p => p.key),
      outKeys: pins.out.map(p => p.key),
      pinSvg: pinTypeOf(seed, 'svg'),
      seedSvg: seed.data.svg,
      seedHeight: seed.data.height
    };
  });
  check('节点已注册', node.has && node.title.indexOf('原画分区') === 0, node.title);
  check('输入引脚含 svg（string）', node.inKeys.indexOf('svg') >= 0 && node.pinSvg === 'string', node.inKeys.join(','));
  check('输出 model + text', node.outKeys.join(',') === 'model,text', node.outKeys.join(','));
  check('默认整图高度 1.6', node.seedHeight === 1.6, String(node.seedHeight));

  console.log('=== 6. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})();
