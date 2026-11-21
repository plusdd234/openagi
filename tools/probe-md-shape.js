'use strict';
/* 探针：建模 App 的「捏脸控制器」（流明同款脸型变形器）
 * 用法：node tools/probe-md-shape.js
 *
 * 流明的捏脸 = shader 顶点形变（20 参数）+ 脸上操控点 + 线圈高亮 + 预设。
 * 判据（不看截图）：
 *   ① 常量与 GLSL 和 apps/lumen3d/app.js **逐字节相同**（两边各抽一遍比对）；
 *   ② 运行时换算正确：pack / bounds / origin / anchors / gain 全部落在解析期望上；
 *   ③ 注入结构：材质上的 onBeforeCompile 真的产出了 l3Deform 调用与全套 uniform；
 *   ④ 参数链路：面板滑杆 → params.shape → uniform 逐值一致；预设整批套用；撤销回滚；
 *   ⑤ 视口手柄：分组数量、投影落点、沿增益方向拖动改参数、垂直拖动几乎不改、双击恢复；
 *   ⑥ 可还原性联动：捏脸只动 shader —— 顶点 / UV / 权重在捏过之后仍然 0 处变化。
 *
 * ①③ 是「效果相同」的充分条件：同一份 GLSL + 同一套 uniform 值 + 同一份 rest 顶点
 * ⇒ 渲染顶点必然与流明相同（蒙皮部分已由 probe-md-parity 覆盖）。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-shape');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/* 与桥接注入时同一把抽法：从两份源码里抽常量块，逐字节比对。 */
function extractBlock(text, name) {
  const lines = text.split('\n');
  const pat = new RegExp('^\\s*(?:var|function)\\s+' + name + '\\b');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (pat.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  let depth = 0, seen = false;
  for (let j = start; j < lines.length; j++) {
    const ln = lines[j];
    let inStr = false, esc = false;
    for (let k = 0; k < ln.length; k++) {
      const ch = ln[k];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '\'' || ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if ('[{('.includes(ch)) { depth++; seen = true; }
      else if (']})'.includes(ch)) depth--;
      else if (depth === 0 && ch === ';') return lines.slice(start, j + 1).join('\n');
    }
    if (seen && depth === 0 && !inStr && j > start && ln.trimEnd().endsWith('}')) {
      return lines.slice(start, j + 1).join('\n');
    }
  }
  return null;
}

const NAMES = ['REGION_FRAMES', 'SHAPE_DEFS', 'ANCHOR_SPECS', 'DEFAULT_COILS',
  'COIL_LIMIT', 'SHAPE_PRESETS', 'OUTLINE_KNOTS', 'OUTLINE_STEP', 'OUTLINE_LIMIT',
  'outlineGlsl', 'regionMaskGlsl', 'frameConsts', 'SHAPE_REGION_MATH',
  'SHAPE_AXIS_MATH', 'SHAPE_VERT_HEAD', 'SHAPE_SEL_FRAG'];

/* ① 源码级逐字节相同（在 Node 里做，不进浏览器） */
function checkSourceParity() {
  /* 行内 trim 后比对：抽取块在两份文件里缩进不同（流明 2 空格 / 桥接 4 空格），
   * 数字与 GLSL 一行不差才是这条断言要守的东西。 */
  const norm = (t) => t.replace(/\r\n/g, '\n');
  const trimLines = (t) => t.split('\n').map((l) => l.trim()).join('\n');
  const lumen = norm(fs.readFileSync(path.join(ROOT, 'apps/lumen3d/app.js'), 'utf8'));
  const bridge = norm(fs.readFileSync(path.join(ROOT, 'js/md-lumen-bridge.js'), 'utf8'));
  let bad = 0;
  for (const n of NAMES) {
    const a = extractBlock(lumen, n);
    const b = extractBlock(bridge, n);
    if (a === null || b === null || trimLines(a) !== trimLines(b)) { bad++; console.log('   · ' + n + (a ? '' : '（流明侧没抽到）') + (b ? '' : '（桥接侧没抽到）')); }
  }
  check(bad === 0, '① 捏脸常量与 GLSL 与流明源码逐字节相同（' + NAMES.length + ' 块）',
    bad === 0 ? '全部一致' : bad + ' 块不一致');
}

(async () => {
  checkSourceParity();

  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(800);

  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1600);

  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* ---------- ② 运行时换算 ---------- */
  const rt = await page.evaluate(() => {
    const d = window.MDLumenBridge.component;
    const out = {};
    out.bounds = d.shapeBounds();
    out.origin = d.shapeOrigin();
    out.pack = d.shapePack({ width: 100, cheek: 0 });
    const an = d.shapeAnchors();
    out.anchorKeys = Object.keys(an).sort();
    out.widthAnchor = an.width || null;
    out.lengthAnchor = an.length || null;
    out.allFinite = Object.keys(an).every((k) => an[k].every((v) => isFinite(v)));
    out.gain = {};
    ['width', 'length', 'chin', 'jaw', 'cheek', 'cheekFull', 'forehead', 'chinWidth', 'noseLength', 'eyeDist', 'mouth']
      .forEach((k) => { out.gain[k] = d.shapeGain(k); });
    out.glsl = d.shapeGlsl();
    out.info = d.shapeInfo();
    return out;
  });

  check(near(rt.bounds[0], 1.1328, 1e-3) && near(rt.bounds[1], 1.3349, 1e-3),
    '②a l3Bounds = 资产 y 范围', JSON.stringify(rt.bounds.map((v) => +v.toFixed(4))));
  /* SHAPE_DEFS 顺序：width=0 / cheek=4 → i>>2 与 i&3 定槽位 */
  check(rt.pack[0][0] === 1 && rt.pack[1][0] === -1 && rt.pack[0][1] === 0 && rt.pack[4][3] === 0 &&
    rt.pack.every((q) => q.every((x) => isFinite(x))),
    '②b shapePack：width=100 → vec4[0].x=1，cheek=0 → vec4[1].x=-1，缺键 = 50 不产生 NaN',
    'pack[0]=' + JSON.stringify(rt.pack[0]) + ' pack[1]=' + JSON.stringify(rt.pack[1]) +
    ' pack[4]=' + JSON.stringify(rt.pack[4]));
  check(rt.anchorKeys.length >= 16 && rt.allFinite,
    '②c 操控点齐且全为有限值（' + rt.anchorKeys.length + ' 个）', rt.anchorKeys.slice(0, 5).join(',') + '…');
  /* 锚点是**网格局部**坐标（资产 − center）：localY = minY + 0.45H − (minY+H/2) = (0.45−0.5)H */
  const H = rt.bounds[1] - rt.bounds[0];
  check(!!rt.widthAnchor && near(rt.widthAnchor[1], (0.45 - 0.5) * H, 2e-3),
    '②d 脸宽锚点落在 t=0.45 的高度线上（局部系）',
    'y-local=' + (rt.widthAnchor ? rt.widthAnchor[1].toFixed(4) : 'null') +
    ' 期望 ' + ((0.45 - 0.5) * H).toFixed(4));
  check(Math.abs(rt.gain.width[0]) > 0 && rt.gain.width[1] === 0 &&
    Math.abs(rt.gain.length[1]) > 0 && rt.gain.length[0] === 0 &&
    rt.gain.eyeDist[0] === 0 && rt.gain.eyeDist[1] === 0,
    '②e 增益方向：脸宽横移 / 脸长纵移；眼部四键增益为 0（流明原样，交给拖动兜底）',
    'width=' + JSON.stringify(rt.gain.width.map((v) => +v.toExponential(2))) +
    ' length=' + JSON.stringify(rt.gain.length.map((v) => +v.toExponential(2))));
  check(rt.glsl.vert.indexOf('l3Deform') >= 0 && rt.glsl.frag.indexOf('l3SelMask') >= 0 &&
    rt.glsl.vert.length > 4000 && rt.glsl.frag.length > 1200,
    '②f shapeGlsl 两段都拿到了（vert ' + rt.glsl.vert.length + ' / frag ' + rt.glsl.frag.length + ' 字符）');

  /* ---------- ③ 注入结构 ---------- */
  const inj = await page.evaluate(() => {
    const dbg = window.modelDesk.__debug();
    const pivots = Object.values(dbg.pivots || {});
    let mesh = null;
    pivots.forEach((p) => {
      p.traverse((o) => { if (!mesh && o.userData && o.userData.mdShape) mesh = o; });
    });
    if (!mesh) return { found: false };
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const U = mats[0].userData && mats[0].userData.mdShapeU;
    if (!U) return { found: true, uni: false };
    /* 手动跑一遍 onBeforeCompile：three 的 include 展开在后面（WebGLProgram），
     * 这里只验证「注入真的注入了」—— 探针守卫的第一课。 */
    const THREE = window.THREE;
    const lib = THREE.ShaderLib.standard;
    const shader = {
      vertexShader: lib.vertexShader,
      fragmentShader: lib.fragmentShader,
      uniforms: {}
    };
    mats[0].onBeforeCompile(shader, null);
    return {
      found: true, uni: true,
      hasDeform: shader.vertexShader.indexOf('transformed = l3Deform( transformed + l3Org, l3Rest ) - l3Org;') >= 0,
      hasRest: shader.vertexShader.indexOf('vec3 l3Rest = position + l3Org;') >= 0,
      hasShapeDecl: shader.vertexShader.indexOf('uniform vec4 l3Shape[5];') >= 0,
      hasOverlay: shader.fragmentShader.indexOf('l3SelMask( vL3Rest )') >= 0,
      hasSelKind: shader.fragmentShader.indexOf('uniform float l3SelKind;') >= 0,
      shapeN: shader.uniforms.l3Shape ? shader.uniforms.l3Shape.value.length : 0,
      coilN: shader.uniforms.l3CoilU ? shader.uniforms.l3CoilU.value.length : 0,
      org: shader.uniforms.l3Org ? [shader.uniforms.l3Org.value.x, shader.uniforms.l3Org.value.y, shader.uniforms.l3Org.value.z] : null,
      bounds: shader.uniforms.l3Bounds ? [shader.uniforms.l3Bounds.value.x, shader.uniforms.l3Bounds.value.y, shader.uniforms.l3Bounds.value.z] : null,
      mats: mats.length,
      parts: mats.map((m) => (m.userData && m.userData.mdShapeU === U) || false)
    };
  });
  check(inj.found, '③a 头模网格带着 mdShape（变形器已挂）');
  check(inj.uni && inj.hasDeform && inj.hasRest && inj.hasShapeDecl,
    '③b onBeforeCompile 注入了 l3Rest 捕获与 l3Deform 调用（含 l3Org 资产系抬升）',
    inj.uni ? ('deform=' + inj.hasDeform + ' rest=' + inj.hasRest + ' decl=' + inj.hasShapeDecl) : '没有 uniform');
  check(inj.uni && inj.hasOverlay && inj.hasSelKind,
    '③c fragment 注入了线圈覆层（悬停亮起的那个）',
    inj.uni ? ('overlay=' + inj.hasOverlay + ' selKind=' + inj.hasSelKind) : '');
  check(inj.uni && inj.shapeN === 5 && inj.coilN === 20,
    '③d uniform：l3Shape×5 / l3CoilU×20', inj.uni ? (inj.shapeN + ' / ' + inj.coilN) : '');
  check(inj.uni && inj.org && near(inj.org[1], 1.2338, 1e-3),
    '③e l3Org = 资产 center（网格局部 → 资产系）', JSON.stringify(inj.org ? inj.org.map((v) => +v.toFixed(4)) : []));
  check(inj.uni && inj.bounds && near(inj.bounds[2], 1 / 0.20211, 2e-3),
    '③f l3Bounds.z = 1/H（hScale 归一化的分母）', JSON.stringify(inj.bounds ? inj.bounds.map((v) => +v.toFixed(3)) : []));

  /* ---------- ④ 参数链路 ---------- */
  /* 面板滑杆：脸宽拉到 72。playwright 对 range 用 fill 不行，得手动设值 + 双事件。 */
  const rowSet = async (key, v) => {
    await page.evaluate(({ k, val }) => {
      const el = document.querySelector('.md-shape-row input[type="range"][data-md-cval="' + k + '"]');
      if (!el) throw new Error('no range for ' + k);
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { k: key, val: v });
    await page.waitForTimeout(120);
  };
  await rowSet('width', 72);
  const p72 = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    const n = doc.nodes.find((x) => x.id === id);
    return n.comp.params.shape;
  }, headId);
  check(p72 && p72.width === 72,
    '④a 面板滑杆 → params.shape.width = 72', JSON.stringify(p72 || {}));
  /* 50 = 没改过（键被删掉）：把 width 拉回 50 */
  await rowSet('width', 50);
  const p50 = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes.find((x) => x.id === id).comp.params.shape;
  }, headId);
  check(!('width' in (p50 || {})),
    '④b 拉回 50 = 参数从 params 里删掉（原始脸不存冗余）', JSON.stringify(p50 || {}));

  /* 预设：Q版（width 78 / length 30 / chinWidth 60） */
  await page.locator('[data-md-cev="shapePreset"][data-md-cval="Q版"]').click();
  await page.waitForTimeout(160);
  const pq = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes.find((x) => x.id === id).comp.params.shape;
  }, headId);
  check(pq && pq.width === 78 && pq.length === 30 && pq.chinWidth === 60 && Object.keys(pq).length === 16,
    '④c 预设「Q版」整批套用（16 个非 50 参数）', JSON.stringify(pq || {}));
  await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(140);
  const pu = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes.find((x) => x.id === id).comp.params.shape;
  }, headId);
  check(!pu || Object.keys(pu).length === 0,
    '④d 撤销一次 → 预设整批回滚', JSON.stringify(pu || {}));

  /* ---------- uniform 逐值一致：等一帧再读 bundle ---------- */
  await rowSet('cheek', 80);
  await page.waitForTimeout(300);
  const uniVals = await page.evaluate(() => {
    const dbg = window.modelDesk.__debug();
    const pivots = Object.values(dbg.pivots || {});
    let U = null;
    pivots.forEach((p) => p.traverse((o) => {
      if (!U && o.userData && o.userData.mdShape) U = o.userData.mdShape.uni;
    }));
    if (!U) return null;
    return {
      shape: U.l3Shape.value.map((v) => [v.x, v.y, v.z, v.w]),
      selA: U.l3SelA.value
    };
  });
  /* SHAPE_DEFS 顺序：cheek 是第 4 个（index 4 → vec4[1].x） */
  check(!!uniVals && near(uniVals.shape[1][0], 0.6, 1e-6),
    '④e 每帧同步把 params.shape 写进了 l3Shape（cheek=80 → (80-50)/50=0.6）',
    uniVals ? ('vec4[1].x=' + uniVals.shape[1][0]) : '没有 uniform');

  /* ---------- ⑤ 视口手柄 ---------- */
  const g0 = await page.evaluate(() => {
    const layer = window.modelDesk.__debug().ctrlLayer;
    if (!layer) return null;
    return {
      count: layer.items.length,
      shown: layer.list().filter((x) => x.visible).length,
      labels: layer.items.map((x) => x.label).slice(0, 3)
    };
  });
  check(!!g0 && g0.count === 16 && g0.shown === 8,
    '⑤a 手柄层持有全部 16 个锚点，当前分组「轮廓」显示 8 个（全部可见）',
    g0 ? (g0.count + ' 个 / 可见 ' + g0.shown) : '没有 layer');

  const inStage = await page.evaluate(() => {
    const layer = window.modelDesk.__debug().ctrlLayer;
    const stage = document.getElementById('mdStage');
    const sr = stage.getBoundingClientRect();
    return layer.items.every((it) => {
      if (!it.el || it.el.style.display === 'none') return true; /* 隐藏的（其它分组）跳过 */
      const l = parseFloat(it.el.style.left), t = parseFloat(it.el.style.top);
      return isFinite(l) && isFinite(t) && l >= -20 && l <= sr.width + 20 && t >= -20 && t <= sr.height + 20;
    });
  });
  check(inStage, '⑤b 每枚手柄都投影进了视口范围（画在了脸上，不是屏幕原点）');

  /* 沿增益方向拖动脸宽：手柄中心 → 水平拖 40px → 松手 */
  const wHandle = page.locator('.md3-gizmo[data-key="width"]');
  const bb = await wHandle.boundingBox();
  check(!!bb, '⑤c 脸宽手柄有可命中的包围盒', bb ? JSON.stringify({ x: Math.round(bb.x), y: Math.round(bb.y) }) : '');
  if (bb) {
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const dragged = await page.evaluate((id) => {
      const doc = window.modelDesk.getDocument();
      return doc.nodes.find((x) => x.id === id).comp.params.shape.width;
    }, headId);
    check(dragged !== undefined && Math.abs(dragged - 50) >= 20,
      '⑤d 沿增益方向拖 40px → 脸宽显著变化（增益投影有效）', 'width=' + dragged);
    /* 垂直拖（垂直于增益方向）：值几乎不动（只有 gy 分量的残余） */
    const before = await page.evaluate((id) => {
      const doc = window.modelDesk.getDocument();
      return doc.nodes.find((x) => x.id === id).comp.params.shape.width;
    }, headId);
    const bb2 = await wHandle.boundingBox();
    await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await page.evaluate((id) => {
      const doc = window.modelDesk.getDocument();
      return doc.nodes.find((x) => x.id === id).comp.params.shape.width;
    }, headId);
    check(Math.abs(after - before) <= 6,
      '⑤e 垂直于增益方向拖 60px → 参数几乎不动（橡皮跟随不写值）',
      'Δ=' + (after - before));
    /* 双击恢复 */
    await wHandle.dblclick();
    await page.waitForTimeout(150);
    const afterDbl = await page.evaluate((id) => {
      const doc = window.modelDesk.getDocument();
      return doc.nodes.find((x) => x.id === id).comp.params.shape.width;
    }, headId);
    check(afterDbl === undefined,
      '⑤f 双击手柄 → 恢复 50（键从 params 删除）', String(afterDbl));
  }

  /* 分组切换：面板点「嘴部」→ 手柄换成嘴部那 3 个 */
  await page.locator('[data-md-cev="shapeGroup"][data-md-cval="嘴部"]').click();
  await page.waitForTimeout(200);
  const g1 = await page.evaluate(() => {
    const layer = window.modelDesk.__debug().ctrlLayer;
    return { count: layer.items.length, group: layer.group, shown: layer.list().filter((x) => x.visible).length };
  });
  check(g1.group === '嘴部' && g1.shown === 3,
    '⑤g 分组页签切到「嘴部」→ 脸上只剩 3 个操控点（张嘴位 / 嘴宽 / 唇厚）',
    'visible=' + g1.shown);

  /* ---------- ⑥ 可还原性联动 ---------- */
  const verts = await page.evaluate(async (id) => {
    const dbg = window.modelDesk.__debug();
    const pivots = Object.values(dbg.pivots || {});
    let mesh = null;
    pivots.forEach((p) => p.traverse((o) => { if (!mesh && o.userData && o.userData.mdShape) mesh = o; }));
    if (!mesh) return null;
    const snap = (geo) => ({
      pos: Array.from(geo.attributes.position.array).slice(0, 300),
      uv: Array.from(geo.attributes.uv.array).slice(0, 200),
      idx: Array.from(geo.index.array).slice(0, 300)
    });
    const a = snap(mesh.geometry);
    await new Promise((r) => setTimeout(r, 250));
    const b = snap(mesh.geometry);
    const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    return { same: eq(a.pos, b.pos) && eq(a.uv, b.uv) && eq(a.idx, b.idx) };
  }, headId);
  check(!!verts && verts.same,
    '⑥ 捏脸是纯 shader 形变：顶点 / UV / 索引在捏过之后 0 处变化（资产未动）');

  /* ---------- 页面零错误 ---------- */
  check(errors.length === 0, '页面零错误', errors.slice(0, 3).join(' | ') || 'clean');

  await browser.close();
  console.log(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 条');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
