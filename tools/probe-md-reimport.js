'use strict';
/* 探针：保存 → 资产库 → 打开 的真实 round-trip（用户报「打开后只有线框 + 拖控制器无反应」）
 * 用法：node tools/probe-md-reimport.js
 *
 * ⚠ 必须走 save() 的真实链路：currentGLB → exportDocJson(toSeedModel) → injectSeedModel →
 *   assetPut（假资产库）。exportBytes() 测试口**不嵌 seedModel**，走它会假复现「comp 丢失」。
 * 打开走 modelDesk.openAsset(id)（桌面端 dock「打开」同一条 readAssetDoc / seedModel 恢复）。
 *
 * 渲染真值判据（不许看截图，像素是数据）：
 *   · capture() 用 __debug().renderer 渲到 RenderTarget 读回 RGBA；
 *   · width=50 与 width=100 两帧 diff 像素数 > 1000 = 形变真的画出来了；
 *   · 非背景像素覆盖率 = solid 面真的在画（只剩 wire 时覆盖率极低）。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-reimport');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(800);

  /* 内存假资产库 —— assetPut 用 save() 的真实入参形状 */
  await page.evaluate(() => {
    const store = Object.create(null);
    window.__assetStore = store;
    window.openagiDesktop = {
      assetPut: async (rec) => {
        const id = rec && rec.id ? String(rec.id) : 'ast-test-' + Date.now();
        store[id] = { id, dataURL: rec.data || rec.dataURL, name: rec.name || id, updated: Date.now(), kind: rec.kind || 'model' };
        return { ok: true, asset: { id, name: store[id].name } };
      },
      assetRead: async (id) => {
        const a = store[id];
        return a ? { ok: true, dataURL: a.dataURL } : { ok: false, error: 'missing' };
      },
      assetList: async () => ({ ok: true, assets: Object.values(store) })
    };
  });

  /* ---------- ① 加头模 + 捏脸 ---------- */
  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1600);
  const headId0 = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });
  const rowSet = async (key, v) => {
    await page.evaluate(({ k, val }) => {
      const el = document.querySelector('.md-shape-row input[type="range"][data-md-cval="' + k + '"]');
      if (!el) throw new Error('no range for ' + k);
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { k: key, val: v });
    await page.waitForTimeout(150);
  };
  await rowSet('chinWidth', 100);
  await rowSet('width', 50);
  await page.waitForTimeout(300);

  /* ---------- 渲染真值：RenderTarget 读回 ---------- */
  await page.evaluate(() => {
    window.__capture = () => {
      const THREE = window.THREE;
      const dbg = window.modelDesk.__debug();
      const r = dbg.renderer, scene = dbg.scene, cam = dbg.camera;
      const w = r.domElement.width, h = r.domElement.height;
      const rt = new THREE.WebGLRenderTarget(w, h);
      const oldBg = scene.background;
      r.setRenderTarget(rt);
      r.render(scene, cam);
      r.setRenderTarget(null);
      const buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      rt.dispose();
      scene.background = oldBg;
      return { w, h, buf };
    };
    window.__pxStat = (cap) => {
      const { w, h, buf } = cap;
      let fg = 0;
      /* 背景取四角平均 */
      const corner = (x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
      const c0 = corner(2, 2), c1 = corner(w - 3, 2), c2 = corner(2, h - 3);
      const bg = [0, 1, 2].map((k) => (c0[k] + c1[k] + c2[k]) / 3);
      for (let i = 0; i < w * h; i++) {
        const dr = Math.abs(buf[i * 4] - bg[0]) + Math.abs(buf[i * 4 + 1] - bg[1]) + Math.abs(buf[i * 4 + 2] - bg[2]);
        if (dr > 30) fg++;
      }
      return { fg, total: w * h };
    };
    window.__pxDiff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.buf.length; i += 4) {
        const d = Math.abs(a.buf[i] - b.buf[i]) + Math.abs(a.buf[i + 1] - b.buf[i + 1]) + Math.abs(a.buf[i + 2] - b.buf[i + 2]);
        if (d > 24) n++;
      }
      return n;
    };
  });

  const statBefore = await page.evaluate(() => window.__pxStat(window.__capture()));
  check(statBefore.fg > statBefore.total * 0.01,
    '① 打开态 solid 有实际覆盖（不是只剩线框）',
    (statBefore.fg / statBefore.total * 100).toFixed(1) + '% 非背景');

  /* 形变真值（打开态）：width 50 ↔ 100 两帧 diff。
   * 同时读 params / uniform：区分「参数没写进」「uniform 没跟上」「GPU 程序没吃 uniform」。 */
  const shapeURead = () => page.evaluate(() => {
    const dbg = window.modelDesk.__debug();
    let U = null, params = null;
    Object.values(dbg.pivots || {}).forEach((p) => {
      p.traverse((o) => {
        if (!o.isMesh || !o.userData || !o.userData.mdShape || U) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const u = mats[0] && mats[0].userData && mats[0].userData.mdShapeU;
        if (u) U = { shape0: u.l3Shape ? Array.from(u.l3Shape.value[0]) : null };
      });
    });
    const doc = window.modelDesk.getDocument();
    const n = doc.nodes.find((x) => x.comp && x.comp.id);
    if (n && n.comp && n.comp.params) params = n.comp.params.shape;
    return { U, params };
  });
  await rowSet('width', 50);
  await page.waitForTimeout(350);
  const capA0 = null;
  const freshMid = await shapeURead();
  await rowSet('width', 100);
  await page.waitForTimeout(350);
  const freshHi = await shapeURead();
  check(!!(freshHi.params && freshHi.params.width === 100), '①b width=100 写进 params',
    JSON.stringify(freshHi.params || {}));
  check(!!(freshHi.U && freshHi.U.shape0 && Math.abs(freshHi.U.shape0[0] - 1) < 1e-3),
    '①c 每帧同步把 width 写进 l3Shape[0].x（=1）',
    JSON.stringify({ before: freshMid.U && freshMid.U.shape0, after: freshHi.U && freshHi.U.shape0 }));
  const deformsOpen = await page.evaluate(async () => {
    /* width 已在 100：diff 100 帧 vs 50 帧 */
    const setW = (v) => {
      const el = document.querySelector('.md-shape-row input[type="range"][data-md-cval="width"]');
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setW(50);
    await new Promise((r) => setTimeout(r, 350));
    const A = window.__capture();
    setW(100);
    await new Promise((r) => setTimeout(r, 350));
    const B = window.__capture();
    setW(50);
    return window.__pxDiff(A, B);
  });
  check(deformsOpen > 1000, '①d 打开态（未导入）捏脸真的画出来了（width 50↔100 渲染 diff）',
    'diff=' + deformsOpen + ' px');
  await rowSet('width', 50);
  await page.waitForTimeout(300);

  /* ---------- ② save() 真实链路（嵌 seedModel）→ openAsset ---------- */
  const saveRes = await page.evaluate(() => window.modelDesk.save());
  check(!!(saveRes && saveRes.ok), '② save() 成功（injectSeedModel → assetPut）',
    saveRes ? (saveRes.error || (saveRes.bytes / 1024).toFixed(0) + ' KB') : '无返回');
  const assetId = saveRes && saveRes.asset ? saveRes.asset.id : null;
  check(!!assetId, '②b 拿到资产 id', String(assetId));

  const openErr = await page.evaluate((id) => window.modelDesk.openAsset(id), assetId)
    .then(() => null).catch((e) => (e && e.message) || String(e));
  check(!openErr, '③ openAsset 成功返回', openErr || '');
  await page.waitForTimeout(1400);

  const rid = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const n = doc.nodes.find((x) => x.comp && x.comp.id) || doc.nodes[doc.nodes.length - 1];
    return n.id;
  });
  const compState = await page.evaluate((id) => {
    const n = window.modelDesk.getDocument().nodes.find((x) => x.id === id);
    return { hasComp: !!(n && n.comp && n.comp.id), compId: n && n.comp ? n.comp.id : '', shape: n && n.comp && n.comp.params ? n.comp.params.shape : null };
  }, rid);
  check(compState.hasComp && compState.compId === 'lumen-head', '③b seedModel 恢复：comp 身份还在',
    JSON.stringify(compState));
  check(!!(compState.shape && compState.shape.chinWidth === 100),
    '③c 捏脸参数原样回来', JSON.stringify(compState.shape || {}));

  /* ---------- ④ 恢复后的 solid 对象 / 材质（数组安全） ---------- */
  const solid = await page.evaluate((id) => {
    const obj = window.modelDesk.nodeObject(id);
    if (!obj) return null;
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    return {
      type: obj.type, visible: obj.visible,
      verts: obj.geometry.attributes.position ? obj.geometry.attributes.position.count : 0,
      matN: mats.length,
      mats: mats.map((m) => ({ type: m.type, name: m.name || '', hasShapeU: !!(m.userData && m.userData.mdShapeU), hasObc: typeof m.onBeforeCompile === 'function' })),
      morphN: obj.geometry.morphAttributes && obj.geometry.morphAttributes.position ? obj.geometry.morphAttributes.position.length : 0
    };
  }, rid);
  check(!!solid && solid.verts > 1000, '④a 恢复后 solid 网格在（' + (solid ? solid.verts : 0) + ' 顶点）',
    solid ? JSON.stringify({ verts: solid.verts, type: solid.type }) : 'nodeObject 为空');
  check(!!solid && solid.matN > 0 && solid.mats.every((m) => m.hasShapeU),
    '④b 每个材质槽都带 mdShapeU（形变 uniform 挂上了）',
    solid ? JSON.stringify(solid.mats) : '无对象');

  /* ---------- ⑤ 渲染真值（打开后）---------- */
  const statAfter = await page.evaluate(() => window.__pxStat(window.__capture()));
  check(statAfter.fg > statAfter.total * 0.01,
    '⑤a 打开后 solid 有实际覆盖（不是只剩线框）',
    (statAfter.fg / statAfter.total * 100).toFixed(1) + '% 非背景 · 打开前 ' +
    (statBefore.fg / statBefore.total * 100).toFixed(1) + '%');

  /* 形变真值：width 50 ↔ 100 渲染像素 diff（>1000 = 形变真的画出来了）。
   * ⚠ width=50 = 键从 params 删除（原始脸不存冗余）——params / uniform 的
   *   「跟着变」必须在 100 的状态下读，不能用最后落在 50 的状态断言。 */
  const deform = await page.evaluate(async (rid) => {
    const setW = (v) => {
      const el = document.querySelector('.md-shape-row input[type="range"][data-md-cval="width"]');
      if (!el) throw new Error('no width range');
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await new Promise((r) => setTimeout(r, 150));
    const A = window.__capture();
    setW(100);
    await new Promise((r) => setTimeout(r, 350));
    const B = window.__capture();
    const out = { __rid: rid, diff: window.__pxDiff(A, B) };
    /* 100 状态下读 params 与 uniform —— 精确按恢复后的节点 id 读，
     * 不做「第一个 mdShape 就用」的遍历（遗留 pivot 的旧 uniform 会冒充）。 */
    const dbg = window.modelDesk.__debug();
    const obj = window.modelDesk.nodeObject(out.__rid);
    let shape0 = null;
    if (obj) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const u = mats[0] && mats[0].userData && mats[0].userData.mdShapeU;
      if (u && u.l3Shape) shape0 = Array.from(u.l3Shape.value[0]);
    }
    const doc2 = window.modelDesk.getDocument();
    const n2 = doc2.nodes.find((x) => x.id === out.__rid);
    out.pivotsKeys = Object.keys(dbg.pivots || {});
    out.docNodeIds = doc2.nodes.map((x) => x.id);
    /* 时序采样：width 若在 350→600ms 之间被删，采样会抓到删除时刻。
     * 同时对 params 做引用标记（canary）：区分「对象被换成克隆」和「键被删」。 */
    out.series = [];
    const readNode = () => {
      const d = window.modelDesk.getDocument();
      return d.nodes.find((x) => x.id === out.__rid);
    };
    let markN = readNode();
    if (markN) markN.__probeMark = 1;
    const readU0 = () => {
      const obj = window.modelDesk.nodeObject(out.__rid);
      const mats = obj ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      const u = mats[0] && mats[0].userData && mats[0].userData.mdShapeU;
      return u && u.l3Shape ? Array.from(u.l3Shape.value[0]) : null;
    };
    for (let t = 0; t < 5; t++) {
      await new Promise((r) => setTimeout(r, t === 0 ? 60 : 150));
      const nn = readNode();
      out.series.push({
        t: t * 150 + (t === 0 ? 60 : 90),
        shape: nn && nn.comp && nn.comp.params ? JSON.parse(JSON.stringify(nn.comp.params.shape || {})) : null,
        mark: !!(nn && nn.__probeMark),
        u0: readU0()
      });
    }
    const n3 = readNode();
    delete (n3 || {}).__probeMark;
    /* ⚠ 必须快照：结尾的 setW(50) 会把 width 从 params 删掉（=50 是「没改过」），
     * live 引用要等 evaluate 返回、playwright 序列化那一刻才取值 —— 那时 width 已被删。
     * 早先 ⑤c「params 缺 width 而 uniform=1」的假失败就是这里自伤，产品代码无恙。 */
    out.paramsAt100 = n3 && n3.comp && n3.comp.params
      ? JSON.parse(JSON.stringify(n3.comp.params.shape || {})) : null;
    /* 行状态 / 行归属：data-md-node 指向谁（面板写的是哪个节点） */
    const elW = document.querySelector('.md-shape-row input[type="range"][data-md-cval="width"]');
    const rowHost = elW ? elW.closest('[data-md-node]') : null;
    out._dbg = {
      rowValue: elW ? elW.value : null,
      rowConnected: elW ? elW.isConnected : false,
      rowNode: rowHost ? rowHost.getAttribute('data-md-node') : null,
      rowCount: document.querySelectorAll('.md-shape-row input[type="range"][data-md-cval="width"]').length
    };
    setW(50);
    return out;
  }, rid);
  check(deform.diff > 1000, '⑤b 打开后捏脸真的画出来了（width 50↔100 渲染 diff）',
    'diff=' + deform.diff + ' px');
  const lastS = deform.series ? deform.series[deform.series.length - 1] : null;
  check(!!(deform.paramsAt100 && deform.paramsAt100.width === 100) &&
    !!(lastS && lastS.u0 && Math.abs(lastS.u0[0] - 1) < 1e-3),
    '⑤c 恢复后 width=100 时 params 与 l3Shape uniform 同步跟上',
    JSON.stringify({ params: deform.paramsAt100, last: lastS, dbg: deform._dbg, pivots: deform.pivotsKeys, nodes: deform.docNodeIds }).slice(0, 700));

  /* ---------- ⑥ shader / 运行期报错 ---------- */
  const shaderErrs = errors.filter((e) => /SHADER|program|GLSL|WebGL|l3/i.test(e));
  check(shaderErrs.length === 0, '⑥a 控制台零 shader 报错', shaderErrs.slice(0, 3).join(' | ').slice(0, 500));
  check(errors.length === 0, '⑥b 全程页面零报错', errors.slice(0, 3).join(' | ').slice(0, 300));

  await RUN.shot(page, 'after-reopen.png');
  await browser.close();

  console.log(fails ? ('\n❌ ' + fails + ' 条失败 · ' + RUN.dir) : ('\n✅ 全部通过 · ' + RUN.dir));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(1); });
