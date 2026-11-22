'use strict';
/* 探针：捏脸形变必须同样作用到视口叠加层（线框 / 顶点）
 * 用法：node tools/probe-md-wire.js
 *
 * 背景（2026-11-22 用户截图报「网格和模型不一致」）：捏脸形变住在 GPU
 * （applyShapeShader 把 l3Deform 注进 solid 材质），而线框/顶点叠加层的
 * buffer 直接拷底模 positions、材质是普通 Line/Points 材质 —— solid 一修好
 * （fragment 拼接缺换行那次），叠加层画的是**未变形底模**这件事立刻暴露。
 *
 * 判据（不看截图）：
 *   ① 结构：叠加层材质与 solid 共享**同一个** uniform bundle 引用（U 逐值同源，
 *      syncShapeOf 写一处三方同步），且 onBeforeCompile 注入真的产出了
 *      begin_vertex 上的 l3Deform 调用（守卫第一课：验证注入真的注入了）；
 *   ② 充分性：同一份 GLSL + 同一份 U + 同一份底模顶点 ⇒ 骨骼静止时叠加层
 *      顶点与 solid 逐值相同（蒙皮/gaze 的眼周偏差另行记录，不在此断言）；
 *   ③ 像素真值：藏掉 solid 只渲染线框，width 50 ↔ 100 两帧 diff > 200px
 *      —— 线框真的跟着形变，不是底模。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-wire');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
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
  await page.waitForTimeout(800);

  /* 加头模（组件）——与 probe-md-shape 同一条链路 */
  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1600);
  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* 像素捕捉（与 probe-md-reimport 同一套：RenderTarget 读回，背景取四角） */
  await page.evaluate(() => {
    window.__capture = () => {
      const THREE = window.THREE;
      const dbg = window.modelDesk.__debug();
      const r = dbg.renderer, scene = dbg.scene, cam = dbg.camera;
      const w = r.domElement.width, h = r.domElement.height;
      const rt = new THREE.WebGLRenderTarget(w, h);
      r.setRenderTarget(rt);
      r.render(scene, cam);
      r.setRenderTarget(null);
      const buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      rt.dispose();
      return { w, h, buf };
    };
    window.__pxDiff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.buf.length; i += 4) {
        const d = Math.abs(a.buf[i] - b.buf[i]) + Math.abs(a.buf[i + 1] - b.buf[i + 1]) + Math.abs(a.buf[i + 2] - b.buf[i + 2]);
        if (d > 24) n++;
      }
      return n;
    };
    window.__pxStat = (cap) => {
      const { w, h, buf } = cap;
      const corner = (x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
      const c0 = corner(2, 2), c1 = corner(w - 3, 2), c2 = corner(2, h - 3);
      const bg = [0, 1, 2].map((k) => (c0[k] + c1[k] + c2[k]) / 3);
      let fg = 0;
      for (let i = 0; i < w * h; i++) {
        const dr = Math.abs(buf[i * 4] - bg[0]) + Math.abs(buf[i * 4 + 1] - bg[1]) + Math.abs(buf[i * 4 + 2] - bg[2]);
        if (dr > 30) fg++;
      }
      return { fg, total: w * h };
    };
    window.__setSolids = (vis) => {
      const dbg = window.modelDesk.__debug();
      Object.values(dbg.pivots || {}).forEach((p) => p.traverse((o) => {
        if (o.userData && o.userData.mdPart === 'solid') o.visible = vis;
      }));
    };
  });

  /* ---------- ① 结构：同一份 U + 注入真的存在 ---------- */
  const struct = await page.evaluate(() => {
    const dbg = window.modelDesk.__debug();
    const pv = dbg.pivots[Object.keys(dbg.pivots).find((k) => {
      const p = dbg.pivots[k];
      let has = false;
      p.traverse((o) => { if (o.userData && o.userData.mdShape) has = true; });
      return has;
    })];
    if (!pv) return { found: false };
    let solid = null;
    pv.traverse((o) => { if (!solid && o.userData && o.userData.mdPart === 'solid') solid = o; });
    if (!solid) return { found: true, solid: false };
    const sMats = Array.isArray(solid.material) ? solid.material : [solid.material];
    const U = sMats[0].userData && sMats[0].userData.mdShapeU;
    if (!U) return { found: true, solid: true, uni: false };
    const edges = pv.children.find((o) => o.userData && o.userData.mdPart === 'edges');
    const verts = pv.children.find((o) => o.userData && o.userData.mdPart === 'verts');
    if (!edges || !verts) return { found: true, solid: true, uni: true, edges: false };
    const vMats = verts.children.map((c) => c.material);
    /* 手动跑一遍注入（对 LineBasicMaterial 用 ShaderLib.basic，对 PointsMaterial
     * 用 ShaderLib.points —— include 展开在 WebGLProgram，这里只验注入本身） */
    const THREE = window.THREE;
    const run = (mat, lib) => {
      const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} };
      mat.onBeforeCompile(shader, null);
      return {
        deform: shader.vertexShader.indexOf('transformed = l3Deform( transformed + l3Org, l3Rest ) - l3Org;') >= 0,
        rest: shader.vertexShader.indexOf('vec3 l3Rest = position + l3Org;') >= 0,
        noSkinHook: shader.vertexShader.indexOf('#include <skinning_vertex>\n  transformed = l3Deform') < 0,
        selUniform: !!shader.uniforms.l3Shape
      };
    };
    return {
      found: true, solid: true, uni: true,
      edgeU: edges.material.userData && edges.material.userData.mdShapeU === U,
      vertU: vMats.every((m) => m.userData && m.userData.mdShapeU === U),
      edge: run(edges.material, THREE.ShaderLib.basic),
      vert: run(vMats[0], THREE.ShaderLib.points)
    };
  });
  check(struct.found && struct.solid && struct.uni, '①a 头模 solid 带着形变 uniform bundle', JSON.stringify(struct).slice(0, 120));
  check(!!struct.edgeU && !!struct.vertU,
    '①b 线框与顶点材质共享 solid 的同一个 U 引用（不是自建副本）',
    'edgeU=' + struct.edgeU + ' vertU=' + struct.vertU);
  check(struct.edge && struct.edge.deform && struct.edge.rest,
    '①c 线框材质 onBeforeCompile 注入了 begin_vertex 上的 l3Deform',
    struct.edge ? ('deform=' + struct.edge.deform + ' rest=' + struct.edge.rest) : '');
  check(struct.vert && struct.vert.deform && struct.vert.rest,
    '①d 顶点材质同样注入', struct.vert ? ('deform=' + struct.vert.deform) : '');
  check(struct.edge && struct.edge.noSkinHook,
    '①e 叠加层变体没有误挂蒙皮链替换（线框没有 skinning_vertex 语境）');

  /* ---------- ③ 像素真值：线框-only，width 50 ↔ 100 ---------- */
  const rowSet = async (key, v) => {
    await page.evaluate(({ k, val }) => {
      const el = document.querySelector('.md-shape-row input[type="range"][data-md-cval="' + k + '"]');
      if (!el) throw new Error('no range for ' + k);
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { k: key, val: v });
    await page.waitForTimeout(300);
  };

  await page.evaluate(() => window.__setSolids(false));
  await rowSet('width', 50);
  const a50 = await page.evaluate(() => window.__capture());
  await rowSet('width', 100);
  const b100 = await page.evaluate(() => window.__capture());
  const diff = await page.evaluate((x) => window.__pxDiff(x.a, x.b), { a: a50, b: b100 });
  await page.evaluate(() => window.__setSolids(true));
  check(diff > 200,
    '② 藏掉 solid 只渲染线框：width 50 ↔ 100 渲染 diff > 200px（线框真的跟着形变）',
    'diff=' + diff + 'px（对照：全显 diff 见 probe-md-reimport ①d）');

  /* 恢复常态后：同机位下「全显」前景覆盖必须远大于「线框-only」——
   * 证明 ② 的两帧真的没有 solid 参与（solid 是大面积着色，藏掉后前景骤减；
   * 注意不能用 diff 大小做这个判据：1px 深色线框挪动的逐像素变化，
   * 天然大于平滑着色大面积的挪动）。 */
  await rowSet('width', 100);
  const fullStat = await page.evaluate(() => window.__pxStat(window.__capture()));
  await page.evaluate(() => window.__setSolids(false));
  const wireStat = await page.evaluate(() => window.__pxStat(window.__capture()));
  await page.evaluate(() => window.__setSolids(true));
  check(wireStat.fg < fullStat.fg * 0.75 && wireStat.fg > fullStat.total * 0.005,
    '③ 藏 solid 后前景覆盖骤减（② 的线框-only 前提成立）',
    'full=' + (fullStat.fg / fullStat.total * 100).toFixed(1) + '% wire=' + (wireStat.fg / wireStat.total * 100).toFixed(1) + '%');
  await rowSet('width', 50);

  check(errors.length === 0, '④ 页面零报错', errors.slice(0, 3).join(' | '));

  await browser.close();
  if (fails) { console.log('FAIL ' + fails); process.exit(1); }
  console.log('PASS probe-md-wire');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
