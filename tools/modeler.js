/* 参数化建模内核体检：规格校验 / 建模结果 / 身高约束 / 落地 / 镜像 / 节点契约
 * 零网络、零外部建模服务。用法：node tools/modeler.js
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

const SPEC = {
  name: '测试人形',
  height: 1.6,
  parts: [
    { id: 'head', shape: 'sphere', size: [0.11, 0.13, 0.12], pos: [0, 1.47, 0], color: '#f2d9c9' },
    { id: 'torso', shape: 'capsule', size: [0.14, 0.32, 0.14], pos: [0, 1.1, 0], color: '#ffffff' },
    { id: 'leg', shape: 'cylinder', size: [0.07, 0.6, 0.06], pos: [0.09, 0.4, 0], mirror: 'x', color: '#f4f7fb' },
    { id: 'shoulder', shape: 'sphere', size: [0.05, 0.05, 0.05], pos: [0.16, 1.3, 0], repeat: { count: 2, offset: [0, -0.12, 0] }, color: '#e8c9a0' }
  ]
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Modeler !== 'undefined' && typeof THREE !== 'undefined', null, { timeout: 15000 });

  console.log('=== 1. 规格校验 ===');
  const bad = await page.evaluate(() => ({
    empty: Modeler.compile({}),
    noParts: Modeler.compile({ parts: [] }),
    badShape: Modeler.compile({ parts: [{ shape: 'dragon' }] }),
    badSize: Modeler.compile({ parts: [{ shape: 'box', size: [-1, 1, 1] }] }),
    tooBig: Modeler.compile({ parts: [{ shape: 'box', size: [160, 160, 160] }] })
  }));
  check('空规格被拒', bad.empty.ok === false && bad.empty.errors.length > 0);
  check('没有 parts 被拒', bad.noParts.ok === false);
  check('未知 shape 报错并指出第几个部件', /parts\[0\]/.test(bad.badShape.errors[0] || ''), (bad.badShape.errors[0] || '').slice(0, 60));
  check('负尺寸被拒', bad.badSize.ok === false);
  check('尺寸过大给出提醒而不是静默通过', bad.tooBig.ok === true && bad.tooBig.warnings.length > 0);

  console.log('=== 2. 建模结果 ===');
  const built = await page.evaluate(async (spec) => {
    const r = await Modeler.build(spec);
    const b = document.createElement('div');
    return { prefix: r.dataURL.slice(0, 30), tris: r.stats.tris, meshes: r.stats.meshes, size: r.size, parts: r.parts, len: r.dataURL.length };
  }, SPEC);
  check('产出是 GLB dataURL', built.prefix.indexOf('data:model/gltf-binary') === 0, built.prefix);
  check('有网格和三角面', built.tris > 100 && built.meshes >= 5, 'tris=' + built.tris + ' meshes=' + built.meshes);
  check('身高被缩放到 1.6 米', Math.abs(built.size[1] - 1.6) < 0.01, built.size.join('×'));

  console.log('=== 3. 落地与镜像 ===');
  const geo = await page.evaluate(async (spec) => {
    const r = await Modeler.buildFromText(JSON.stringify(spec));
    const g = await new Promise((res, rej) => new THREE.GLTFLoader().load(r.dataURL, res, undefined, rej));
    g.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g.scene);
    let meshes = 0, names = [];
    g.scene.traverse(o => { if (o.isMesh) { meshes++; names.push(o.name); } });
    return { minY: +box.min.y.toFixed(3), maxY: +box.max.y.toFixed(3), meshes, names };
  }, SPEC);
  check('模型落在地面上（minY ≈ 0）', Math.abs(geo.minY) < 0.02, String(geo.minY));
  check('镜像件真的多出来一份', geo.names.filter(n => /_mirror/.test(n)).length >= 1, geo.names.join(','));
  check('阵列（repeat）也生效', geo.meshes >= 6, 'meshes=' + geo.meshes);

  console.log('=== 4. 节点契约 ===');
  const node = await page.evaluate(() => {
    const d = NODE_REGISTRY.modelBuild;
    /* seedNodeData 只给 data/params，不带 type —— 引脚解析要带 type 的节点对象 */
    const seed = Object.assign({ type: 'modelBuild' }, seedNodeData('modelBuild'));
    const pins = pinsForRender(seed);
    const again = seedNodeData('modelBuild');
    return {
      has: !!d,
      title: d && d.title,
      inKeys: pins.in.map(p => p.key),
      outKeys: pins.out.map(p => p.key),
      seedSpec: seed.data.spec,
      seedHeight: seed.data.height,
      sameShape: JSON.stringify(seed.data) === JSON.stringify(again.data),
      pinSpec: pinTypeOf(seed, 'spec'),
      pinModel: pinTypeOf(seed, 'model')
    };
  });
  check('节点已注册', node.has === true && node.title === '参数化建模', node.title);
  check('输入引脚含 spec 且类型是 string', node.inKeys.indexOf('spec') >= 0 && node.pinSpec === 'string', node.inKeys.join(',') + '/' + node.pinSpec);
  check('输出 model + text', node.outKeys.join(',') === 'model,text' && node.pinModel === 'model', node.outKeys.join(',') + '/' + node.pinModel);
  check('seed 与默认同形', node.seedSpec === '' && node.seedHeight === 0 && node.sameShape === true);

  console.log('=== 4.5 曲线 / 曲面三件套 ===');
  const CURVE_SPEC = {
    height: 1.6,
    parts: [
      /* tube：一段螺旋卷（发丝）——用基础体根本拼不出来 */
      { id: 'curl', shape: 'tube', size: [0.02, 0.004, 0], color: '#ddd7e8', seg: 10,
        points: [[0.18, 1.2, -0.05], [0.26, 1.05, 0.02], [0.3, 0.9, -0.06], [0.24, 0.78, 0.04], [0.15, 0.7, -0.02]] },
      /* lathe：一条腿的回转体 */
      { id: 'leg', shape: 'lathe', size: [1, 0, 0], color: '#f6dfd2', seg: 24, mirror: 'x',
        profile: [[0.055, 0.02], [0.07, 0.2], [0.062, 0.45], [0.055, 0.62], [0.075, 0.82], [0.08, 0.9]] },
      /* loft：躯干，截面沿高度变化 */
      { id: 'torso', shape: 'loft', size: [1, 0, 0], color: '#ffffff', seg: 24,
        sections: [{ y: 0.92, rx: 0.11, rz: 0.08 }, { y: 1.06, rx: 0.095, rz: 0.07 },
                   { y: 1.22, rx: 0.115, rz: 0.085, cz: 0.01 }, { y: 1.34, rx: 0.1, rz: 0.075 }] }
    ]
  };
  const curveBuilt = await page.evaluate(async (spec) => {
    const r = await Modeler.build(spec);
    const g = await new Promise((res, rej) => new THREE.GLTFLoader().load(r.dataURL, res, undefined, rej));
    g.scene.updateMatrixWorld(true);
    const names = [];
    g.scene.traverse(o => { if (o.isMesh) names.push(o.name); });
    const box = new THREE.Box3().setFromObject(g.scene);
    return { tris: r.stats.tris, meshes: r.stats.meshes, names, size: r.size, minY: +box.min.y.toFixed(3) };
  }, CURVE_SPEC);
  check('tube / lathe / loft 都建出了网格', curveBuilt.meshes >= 4, JSON.stringify(curveBuilt.names));
  check('曲线曲面有实际三角面', curveBuilt.tris > 500, String(curveBuilt.tris));
  check('整体尺寸合理（高≈1.6）', Math.abs(curveBuilt.size[1] - 1.6) < 0.05, curveBuilt.size.join('×'));
  check('依然落地', Math.abs(curveBuilt.minY) < 0.02, String(curveBuilt.minY));

  const curveErr = await page.evaluate(() => Modeler.compile({ parts: [{ shape: 'tube', size: [0.02, 0.01, 0] }] }));
  check('tube 缺 points 时明确报错', curveErr.ok === false && /points/.test(curveErr.errors[0] || ''), (curveErr.errors[0] || '').slice(0, 40));
  const latheErr = await page.evaluate(() => Modeler.compile({ parts: [{ shape: 'lathe', size: [1, 0, 0] }] }));
  check('lathe 缺 profile 时明确报错', latheErr.ok === false && /profile/.test(latheErr.errors[0] || ''));

  console.log('=== 5. 无规格时给出人话错误 ===');
  const errMsg = await page.evaluate(async () => {
    try { await Modeler.buildFromText('这是一段没有 JSON 的说明'); return 'no-error'; }
    catch (e) { return String(e && e.message); }
  });
  check('不是 JSON 时明确说清楚', /没有从输入里找到 JSON|规格不是合法 JSON/.test(errMsg), errMsg.slice(0, 60));

  console.log('=== 6. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})();
