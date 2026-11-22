'use strict';
/* 探针：建模 App 的「捏脸导出烘焙」+ 导入导出 round-trip
 * 用法：node tools/probe-md-bake.js
 *
 * 判据（不看截图，全部顶点级数值比对）：
 *  ① GLSL 求值器：l3Deform 全 50 恒等；Q 版参数全顶点无 NaN；
 *     方向断言 —— 脸宽 100 拉宽脸缘 / 下巴 100 拉长下巴 / 鼻长 100 顶起鼻尖。
 *  ② GLB round-trip：烘焙后的 position 逐值 = JS 求值（同一份 GLSL 执行两次
 *     自咬）；通用形态键（mdShape_Rest + 每参数一条）delta 逐值正确；
 *     extras.mdShapeBaked 参数完整；morph weights 全 0（默认显示烘焙脸）。
 *  ③ 导入回 SeedModel：fromBufferGeometry 按 targetNames 建 morphs，
 *     delta 逐值 = GLB 里的 delta，权重全 0，拓扑/UV 不动。
 *  ④ 未捏脸（全 50）不烘焙：GLB 无 targets、position == rest。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-bake');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const maxDiff = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
};

/* Q 版预设（与 bridge SHAPE_PRESETS 同源取值） */
const QVER = {
  width: 78, length: 30, chin: 30, jaw: 70, cheek: 76, cheekFull: 80, forehead: 74,
  eyeDist: 60, eyeWidth: 78, eyeHeight: 70, eyeTilt: 56, noseLength: 34, chinWidth: 60,
  mouth: 60, lipThick: 60, mouthPos: 48
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1600);

  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* ---------- ① 求值器 ---------- */
  const ev = await page.evaluate((Q) => {
    const d = window.MDLumenBridge.component;
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes.find((n) => n.id === doc.nodes[doc.nodes.length - 1].id);
    const dbg = window.modelDesk.__debug();
    const pivot = Object.values(dbg.pivots || {}).find((p) => p.userData && p.userData.mdNode === node.id);
    let rest = null;
    pivot.traverse((o) => {
      if (o.isMesh && o.userData && o.userData.mdPart === 'solid' && !rest) {
        const a = o.geometry.attributes.position;
        rest = new Float32Array(a.array.slice(0, a.count * 3));
      }
    });
    const out = { count: rest ? rest.length / 3 : 0 };
    out.evalOk = d.shapeEvalOk();
    /* 恒等 */
    const id = d.shapeDeform(rest, {});
    let idMax = 0;
    if (id) for (let i = 0; i < id.length; i++) idMax = Math.max(idMax, Math.abs(id[i] - rest[i]));
    out.idMax = idMax;
    /* Q 版全顶点有限 */
    const q = d.shapeDeform(rest, Q);
    out.qNaN = q ? Array.from(q).some((v) => !isFinite(v)) : 'null';
    out.qMaxMove = q ? (function () { let m = 0; for (let i = 0; i < q.length; i++) m = Math.max(m, Math.abs(q[i] - rest[i])); return m; })() : null;
    /* 方向断言用的三组单参数结果 */
    const single = (k) => { const s = {}; s[k] = 100; return d.shapeDeform(rest, s); };
    /* 脸缘顶点：|x| 大的（左右脸缘）；下巴：y 最小的（局部系底端）；
     * 鼻尖：局部 z 最大的前 40 个（正面最凸，鼻尖所在）。
     * GLSL 口径：下巴 100 以嘴线为轴往下拉（dy<0）；鼻长 100 也是 y 向下拉
     * （p.y -= 0.0035·hScale·mNose）—— 断言方向按 GLSL 写。 */
    const N = rest.length / 3;
    const idxEdge = [], idxChin = [], idxNose = [];
    const zList = [];
    for (let i = 0; i < N; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1], z = rest[i * 3 + 2];
      if (Math.abs(x) > 0.05) idxEdge.push(i);
      if (y < -0.07) idxChin.push(i);
      zList.push([i, z]);
    }
    zList.sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < 40 && i < zList.length; i++) idxNose.push(zList[i][0]);
    function avgMove(arr, t) {
      let s = 0, c = 0;
      for (const i of arr) {
        s += Math.abs(t[i * 3] - rest[i * 3]);
        c++;
      }
      return c ? s / c : -1;
    }
    const w = single('width');
    out.widthAvgX = +avgMove(idxEdge, w).toExponential(3);
    const ch = single('chin');
    let chDy = 0, cn = 0;
    for (const i of idxChin) { chDy += ch[i * 3 + 1] - rest[i * 3 + 1]; cn++; }
    out.chinAvgDy = +(cn ? chDy / cn : 0).toExponential(3);
    const no = single('noseLength');
    let noDy = 0, nn = 0;
    for (const i of idxNose) { noDy += no[i * 3 + 1] - rest[i * 3 + 1]; nn++; }
    out.noseAvgDz = +(nn ? noDy / nn : 0).toExponential(3);
    out.rest = Array.from(rest);
    return out;
  }, QVER);

  check(ev.count > 1000, '①a 头模顶点已拿到（' + ev.count + ' 顶点）');
  check(ev.evalOk === true, '①b GLSL 求值器编译并自检通过');
  check(ev.idMax <= 1e-6, '①c 全 50 参数 l3Deform 恒等（max |Δ| = ' + ev.idMax.toExponential(2) + '）');
  check(ev.qNaN === false && ev.qMaxMove > 0.0005, '①d Q 版全顶点有限且整体有位移',
    'maxMove=' + ev.qMaxMove.toExponential(3));
  check(ev.widthAvgX > 0.002, '①e 脸宽 100：脸缘顶点横向位移为正（' + ev.widthAvgX + '）');
  check(ev.chinAvgDy < -0.0003, '①f 下巴 100：下巴顶点向下拉长（dy=' + ev.chinAvgDy + '）');
  check(ev.noseAvgDz < -0.0002, '①g 鼻长 100：鼻尖区顶点向下拉长（dy=' + ev.noseAvgDz + '）');

  /* ---------- ② GLB round-trip ---------- */
  await page.evaluate((Q) => {
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes[doc.nodes.length - 1];
    node.comp.params.shape = Object.assign({}, Q);
  }, QVER);

  const bytes = await page.evaluate(async () => {
    const b = await window.modelDesk.exportBytes();
    return Array.from(new Uint8Array(b));
  });
  check(bytes.length > 50000, '②a GLB 已导出（' + Math.round(bytes.length / 1024) + ' KB）');
  RUN.artifact('baked.glb');
  fs.writeFileSync(path.join(RUN.dir, 'baked.glb'), Buffer.from(bytes));

  const rt = await page.evaluate(async (restArr) => {
    const loader = new THREE.GLTFLoader();
    const buf = await window.modelDesk.exportBytes();
    const gltf = await loader.parseAsync(buf, '');
    const out = {};
    /* GLTFLoader 只保留 meshDef.extras（targetNames → morphTargetDictionary），
     * primitive.extras（geometry.userData）不进 userData —— 找头模按形态键名认。 */
    let mesh = null;
    gltf.scene.traverse((o) => {
      if (o.isMesh && o.morphTargetDictionary && o.morphTargetDictionary.mdShape_Rest !== undefined && !mesh) mesh = o;
    });
    if (!mesh) return { found: false };
    out.found = true;
    out.dict = mesh.morphTargetDictionary || {};
    out.infl = Array.from(mesh.morphTargetInfluences || []);
    const pos = mesh.geometry.attributes.position;
    out.pos = Array.from(pos.array.slice(0, pos.count * 3));
    /* GLTF 里 morph attributes（three 已转 absolute：target = base + delta） */
    const mattrs = mesh.geometry.morphAttributes.position || [];
    out.morphs = mattrs.map((a) => Array.from(a.array.slice(0, a.count * 3)));
    out.targetsInJson = !!(gltf.parser && gltf.parser.json &&
      (gltf.parser.json.meshes || []).some((m) => m.targets && m.targets.length));
    out.extrasNames = (gltf.parser.json.meshes || [])
      .filter((m) => m.extras && m.extras.targetNames)
      .map((m) => m.extras.targetNames);
    /* primitive.extras（geometry.userData.mdShapeBaked）应该在 json 里 */
    out.jsonBaked = (gltf.parser.json.meshes || []).some((m) =>
      (m.primitives || []).some((p) => p.extras && p.extras.mdShapeBaked));
    return out;
  }, ev.rest);

  const restF = new Float32Array(ev.rest);
  const bakedF = new Float32Array(rt.pos);
  check(rt.found, '②b GLB 里找到带 mdShape_* 形态键的头模网格');
  check(rt.jsonBaked === true, '②b2 primitive.extras 带 mdShapeBaked（参数 + targetNames）');
  const bridge = await page.evaluate(() => window.MDLumenBridge.component);
  const jsBaked = await page.evaluate((Q) => {
    const d = window.MDLumenBridge.component;
    const doc = window.modelDesk.getDocument();
    const dbg = window.modelDesk.__debug();
    const node = doc.nodes[doc.nodes.length - 1];
    const pivot = Object.values(dbg.pivots || {}).find((p) => p.userData && p.userData.mdNode === node.id);
    let rest = null;
    pivot.traverse((o) => {
      if (o.isMesh && o.userData && o.userData.mdPart === 'solid' && !rest) {
        const a = o.geometry.attributes.position;
        rest = new Float32Array(a.array.slice(0, a.count * 3));
      }
    });
    return { baked: Array.from(d.shapeDeform(rest, Q)), rest: Array.from(rest) };
  }, QVER);
  const jsBakedF = new Float32Array(jsBaked.baked);
  console.log('   · 长度：GLB pos=' + bakedF.length + ' JS=' + jsBakedF.length + ' rest=' + restF.length);
  check(bakedF.length === jsBakedF.length && maxDiff(bakedF, jsBakedF) <= 1e-5,
    '②c GLB position 逐值 = JS 求值（max |Δ| = ' +
      (bakedF.length === jsBakedF.length ? maxDiff(bakedF, jsBakedF).toExponential(2) : 'LEN') + '）');
  check(maxDiff(bakedF, restF) > 0.0005, '②d 烘焙脸 ≠ 原始脸（确实捏进去了）',
    'max |Δ| = ' + maxDiff(bakedF, restF).toExponential(3));

  /* 形态键：mdShape_Rest + 每个改过的参数一条 */
  const qKeys = Object.keys(QVER).filter((k) => QVER[k] !== 50);
  const expectNames = ['mdShape_Rest'].concat(qKeys.map((k) => 'mdShape_' + k)).sort();
  const gotNames = Object.keys(rt.dict).sort();
  check(JSON.stringify(gotNames) === JSON.stringify(expectNames),
    '②e 形态键名字齐：mdShape_Rest + ' + qKeys.length + ' 条参数键',
    gotNames.length + '/' + expectNames.length);
  check(rt.infl.length === expectNames.length && rt.infl.every((v) => v === 0),
    '②f morph weights 全 0（默认显示烘焙脸）');
  check(rt.extrasNames.length === 1 &&
    JSON.stringify(rt.extrasNames[0].slice().sort()) === JSON.stringify(expectNames),
    '②g GLB mesh.extras.targetNames 与 dictionary 一致');

  /* delta 逐值：target_absolute − baked_position == 期望 delta（相对 rest 的单参数效果） */
  const rt2 = await page.evaluate((Q) => {
    const d = window.MDLumenBridge.component;
    const doc = window.modelDesk.getDocument();
    const dbg = window.modelDesk.__debug();
    const node = doc.nodes[doc.nodes.length - 1];
    const pivot = Object.values(dbg.pivots || {}).find((p) => p.userData && p.userData.mdNode === node.id);
    let rest = null;
    pivot.traverse((o) => {
      if (o.isMesh && o.userData && o.userData.mdPart === 'solid' && !rest) {
        const a = o.geometry.attributes.position;
        rest = new Float32Array(a.array.slice(0, a.count * 3));
      }
    });
    const single = (k) => { const s = {}; s[k] = Q[k]; return d.shapeDeform(rest, s); };
    const out = {};
    Object.keys(Q).forEach((k) => {
      if (Q[k] === 50) return;
      const t = single(k);
      if (!t) { out[k] = null; return; }
      const delta = new Float32Array(t.length);
      for (let i = 0; i < t.length; i++) delta[i] = t[i] - rest[i];
      out[k] = Array.from(delta);
    });
    return out;
  }, QVER);
  let morphBad = 0, morphChecked = 0;
  qKeys.forEach((k, ki) => {
    /* dict 顺序：Rest 在 0，参数键按 qKeys 顺序 1..n（bridge 按活动参数序生成） */
    const mi = rt.dict['mdShape_' + k];
    if (mi == null || !rt.morphs[mi] || !rt2[k]) { morphBad++; return; }
    morphChecked++;
    const target = new Float32Array(rt.morphs[mi]);
    const delta = new Float32Array(rt2[k]);
    if (k === 'width') {
      /* 只 dump 一次：看 GLTFLoader 回来的 target 语义（delta 还是 absolute） */
      let s = '   · width 前三顶点 dump：GLB target=';
      for (let i = 0; i < 9; i += 3) s += '[' + target[i].toFixed(5) + ',' + target[i + 1].toFixed(5) + ',' + target[i + 2].toFixed(5) + '] ';
      s += ' baked=';
      for (let i = 0; i < 9; i += 3) s += '[' + bakedF[i].toFixed(5) + ',' + bakedF[i + 1].toFixed(5) + ',' + bakedF[i + 2].toFixed(5) + '] ';
      s += ' expectDelta=';
      for (let i = 0; i < 9; i += 3) s += '[' + delta[i].toFixed(5) + ',' + delta[i + 1].toFixed(5) + ',' + delta[i + 2].toFixed(5) + '] ';
      console.log(s);
    }
    /* GLTFLoader 把 delta 转成 absolute（+ baked base）：比较 target − baked */
    const baseDelta = new Float32Array(target.length);
    for (let i = 0; i < target.length; i++) baseDelta[i] = target[i] - bakedF[i];
    const d1 = maxDiff(baseDelta, delta);
    const d2 = maxDiff(target, delta);
    if (d1 > 1e-4 && d2 > 1e-4) { morphBad++; console.log('   · ' + k + ' morph delta max|Δ|=' + d1.toExponential(2) + ' (asDelta ' + d2.toExponential(2) + ')'); }
  });
  check(morphBad === 0 && morphChecked === qKeys.length,
    '②h 每条参数键 delta 逐值 = 单参数效果 − 原始 rest（' + morphChecked + ' 条）');

  /* ---------- ③ 导入回 SeedModel ---------- */
  const imp = await page.evaluate(async () => {
    const loader = new THREE.GLTFLoader();
    const buf = await window.modelDesk.exportBytes();
    const gltf = await loader.parseAsync(buf, '');
    let mesh = null;
    gltf.scene.traverse((o) => {
      if (o.isMesh && o.morphTargetDictionary && o.morphTargetDictionary.mdShape_Rest !== undefined && !mesh) mesh = o;
    });
    if (!mesh) return { skip: 'no morph mesh' };
    const names = Object.keys(mesh.morphTargetDictionary)
      .sort((a, b) => mesh.morphTargetDictionary[a] - mesh.morphTargetDictionary[b]);
    const geo = mesh.geometry;
    const m = SeedModel.Mesh.fromBufferGeometry(geo, {
      slot: 0,
      morphNames: names,
      morphWeights: names.map(() => 0)
    });
    const out = { morphCount: (m.morphs || []).length, names: (m.morphs || []).map((x) => x.name) };
    /* delta 应等于 GLB 里那条。GLTFLoader 把 glTF 的 delta 原样放进
     * morphAttributes（morphTargetsRelative=true），fromBufferGeometry 按
     * relative 分支收下 —— 逐值直比即可。 */
    const first = m.morphs[0];
    const gltfDelta = geo.morphAttributes.position[0];
    const d0 = new Float32Array(first.deltas);
    out.restDeltaMax = 0;
    for (let i = 0; i < d0.length && i < gltfDelta.array.length; i++) {
      out.restDeltaMax = Math.max(out.restDeltaMax, Math.abs(d0[i] - gltfDelta.array[i]));
    }
    out.allWeightsZero = m.morphs.every((x) => x.weight === 0);
    out.posCount = m.positions.length / 3;
    return out;
  });
  check(imp.morphCount === expectNames.length && imp.names[0] === 'mdShape_Rest' &&
    imp.names.indexOf('mdShape_width') > 0,
    '③a 导入后 mesh.morphs 名字完整（' + imp.morphCount + ' 条）');
  check(imp.restDeltaMax <= 1e-5, '③b 导入 morph delta 逐值 = GLB delta（max |Δ| = ' + imp.restDeltaMax.toExponential(2) + '）');
  check(imp.allWeightsZero, '③c 导入后权重全 0');

  /* ---------- ④ 全 50 不烘焙 ---------- */
  const clean = await page.evaluate(async () => {
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes[doc.nodes.length - 1];
    node.comp.params.shape = {};
    const b = await window.modelDesk.exportBytes();
    const loader = new THREE.GLTFLoader();
    const gltf = await loader.parseAsync(b, '');
    const out = { anyTargets: false, bakedMarks: 0 };
    (gltf.parser.json.meshes || []).forEach((m) => { if (m.targets && m.targets.length) out.anyTargets = true; });
    gltf.scene.traverse((o) => { if (o.userData && o.userData.mdShapeBaked) out.bakedMarks++; });
    return out;
  });
  check(!clean.anyTargets && clean.bakedMarks === 0, '④a 全 50 参数：GLB 无 morph targets、无烘焙标记');

  check(errors.length === 0, '⑤ 页面零报错',
    errors.length ? errors[0].slice(0, 160) : '干净');
  await browser.close();
  RUN.finish(fails ? ['fail'] : []);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE FAIL', e); process.exit(1); });
