'use strict';
/* 探针：AI 材质（选中对象 → 生图 → 贴图）本地链路。
 * 用法：node tools/probe-md-aitex.js
 *
 * 不依赖 Tripo 服务（8790）：生成按钮只验证「无服务时的友好报错」，
 * 应用链路走 setNodeSurface（= slotEdit，与 doGenMaterial 完全同一条
 * 落库路径：一条历史 + rebuildModel → makePivotFor → applyNodeSurface）。
 * 判据照项目口径：材质 .map 真挂上、GLB 里真有图，不看截图。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-aitex');

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

  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(1000);

  /* 内存假资产库（存盘重开 round-trip 用，与 probe-md-reimport 同款） */
  await page.evaluate(() => {
    const store = Object.create(null);
    window.openagiDesktop = {
      assetPut: async (rec) => {
        const id = rec && rec.id ? String(rec.id) : 'ast-' + Date.now();
        store[id] = { id, dataURL: rec.data || rec.dataURL, name: rec.name || id, updated: Date.now() };
        return { ok: true, asset: { id, name: store[id].name } };
      },
      assetRead: async (id) => store[id] ? { ok: true, dataURL: store[id].dataURL } : { ok: false, error: 'missing' },
      assetList: async () => ({ ok: true, assets: Object.values(store) })
    };
  });

  const rid = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return (window.SeedModel.Scene.nodesOf(doc)[0] || doc.nodes[0]).id;
  });
  check(!!rid, '① 默认文档有一个网格节点', rid);

  /* ---------- ② UI：AI 材质分区渲染 ---------- */
  const ui = await page.evaluate(() => {
    const sec = Array.from(document.querySelectorAll('.md-h2')).find((x) => /AI 材质/.test(x.textContent));
    return {
      shown: !!sec,
      prompt: !!document.querySelector('[data-md-aitex="prompt"]'),
      src: !!document.querySelector('[data-md-aitex="src"]'),
      ref: !!document.querySelector('[data-md-aitex="ref"]'),
      gen: !!document.querySelector('[data-md-act="ai-tex-gen"]')
    };
  });
  check(ui.shown && ui.prompt && ui.src && ui.ref && ui.gen,
    '② 属性面板有 AI 材质分区（描述 / 来源 / 参考 / 生成钮）', JSON.stringify(ui));

  /* ---------- ③ setNodeSurface（slotEdit 真链路）→ 材质立刻吃到覆盖 ---------- */
  const applied = await page.evaluate(async (id) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const cx = cv.getContext('2d');
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      cx.fillStyle = (x + y) % 2 ? '#d33d2b' : '#2b6fd3';
      cx.fillRect(x * 16, y * 16, 16, 16);
    }
    const dataUrl = cv.toDataURL('image/png');
    const ok = window.modelDesk.setNodeSurface(id, dataUrl, '#ffffff');
    await new Promise((r) => setTimeout(r, 400)); /* 共享纹理异步解码 */
    const obj = window.modelDesk.nodeObject(id);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const m0 = mats[0];
    const img = m0.map && m0.map.image;
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id);
    return {
      ok,
      surfaceOn: !!(node.surface && node.surface.map && node.surface.map.indexOf('data:image/png') === 0),
      mapOnMat: !!m0.map && !!m0.userData.mdBaseMap,
      px: img ? (img.width || img.naturalWidth) : 0,
      color: m0.color.getHexString()
    };
  }, rid);
  check(applied.ok && applied.surfaceOn, '③ setNodeSurface 落库（slotEdit 一条历史）',
    JSON.stringify({ ok: applied.ok, surfaceOn: applied.surfaceOn }));
  check(applied.mapOnMat && applied.px === 64 && applied.color === 'ffffff',
    '③b 重建后材质真的挂着 AI 贴图（64px 有像素 / 底色白）',
    'map=' + applied.mapOnMat + ' px=' + applied.px + ' color=' + applied.color);

  /* ---------- ④ 撤销 / 重做：覆盖进历史，整张可退 ---------- */
  const undoRes = await page.evaluate(async (id) => {
    window.modelDesk.undo();
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id) || doc.nodes[0];
    const obj = window.modelDesk.nodeObject(node.id);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    return { surfaceGone: !(node.surface && node.surface.map), mapGone: !mats[0].map };
  }, rid);
  check(undoRes.surfaceGone && undoRes.mapGone, '④ undo 后覆盖退掉、材质回到槽底图', JSON.stringify(undoRes));
  const redoRes = await page.evaluate(async (id) => {
    window.modelDesk.redo();
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id) || doc.nodes[0];
    return { surfaceBack: !!(node.surface && node.surface.map) };
  }, rid);
  check(redoRes.surfaceBack, '④b redo 后覆盖回来', JSON.stringify(redoRes));

  /* ---------- ⑤ 存盘 → 重开：surface 过 seedModel 往返 ---------- */
  const saveRes = await page.evaluate(() => window.modelDesk.save());
  check(!!(saveRes && saveRes.ok), '⑤ save() 成功', saveRes ? (saveRes.error || (saveRes.bytes / 1024).toFixed(0) + ' KB') : '无返回');
  const assetId = saveRes && saveRes.asset ? saveRes.asset.id : null;
  await page.evaluate((id) => window.modelDesk.openAsset(id), assetId);
  await page.waitForTimeout(1400);
  const reopened = await page.evaluate(async (id) => {
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id) || doc.nodes[0];
    const obj = window.modelDesk.nodeObject(node.id);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const img = mats[0].map && mats[0].map.image;
    return {
      surfaceAlive: !!(node.surface && node.surface.map),
      mapOnMat: !!mats[0].map,
      px: img ? (img.width || img.naturalWidth) : 0
    };
  }, rid);
  check(reopened.surfaceAlive && reopened.mapOnMat && reopened.px === 64,
    '⑤ 重开后 surface 存活 + 材质挂图（nodeOfRaw 白名单收了 surface）',
    JSON.stringify(reopened));

  /* ---------- ⑥ 导出：GLB 里节点贴图真的带出去 ---------- */
  const glbCheck = await page.evaluate(async () => {
    const r = await window.modelDesk.exportBytes({});
    const buf = new Uint8Array(r);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const txt = new TextDecoder().decode(buf.subarray(20, 20 + jsonLen));
    const json = JSON.parse(txt);
    const mats = json.materials || [];
    return {
      images: (json.images || []).length,
      textures: (json.textures || []).length,
      /* ⚠ baseColorTexture 在 pbrMetallicRoughness 里，不在 material 顶层 */
      baseColorBound: mats.some((m) => m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture != null)
    };
  });
  check(glbCheck.images >= 1 && glbCheck.baseColorBound,
    '⑥ GLB 导出带节点贴图（images / baseColorTexture 绑定）', JSON.stringify(glbCheck));

  /* ---------- ⑦ 生成按钮：报错链路（stub 生成函数，确定性验证） ----------
   * 本机 8790 若真的在跑（桌面端常开），真调用会等 1–3 分钟真生成 ——
   * 探针不能依赖服务状态：临时替换 wfTripoWebImage（model-desk 调的是
   * window 全局，运行时查名），验证「失败 → 友好报错 + 按钮恢复」。 */
  const genFail = await page.evaluate(async () => {
    const el = document.querySelector('[data-md-aitex="prompt"]');
    if (el) { el.value = '青铜'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    const real = window.wfTripoWebImage;
    window.wfTripoWebImage = () => Promise.reject(new Error('模拟断线（探针）'));
    let out;
    try {
      const btn = document.querySelector('[data-md-act="ai-tex-gen"]');
      if (!btn) { out = { clicked: false }; }
      else {
        btn.click();
        await new Promise((r) => setTimeout(r, 600));
        const status = document.querySelector('#mdStatus');
        out = { clicked: true, status: status ? status.textContent : '', busyBack: !btn.disabled };
      }
    } finally {
      window.wfTripoWebImage = real;
    }
    return out;
  });
  check(genFail.clicked && /AI 材质失败/.test(genFail.status || '') &&
      /模拟断线/.test(genFail.status || '') && genFail.busyBack,
    '⑦ 生成失败给出友好报错且按钮恢复（stub 断线）', genFail.status);

  /* ---------- ⑧ 页面零报错 ---------- */
  check(errors.length === 0, '⑧ 全程页面零报错', errors.slice(0, 3).join(' | ').slice(0, 300));

  await RUN.shot(page, 'aitex.png');
  await browser.close();

  console.log(fails ? ('\n❌ ' + fails + ' 条失败 · ' + RUN.dir) : ('\n✅ 全部通过 · ' + RUN.dir));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(1); });
