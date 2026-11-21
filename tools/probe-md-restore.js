'use strict';
/* 探针：头模的「顶点数据能不能还原」
 * 用法：node tools/probe-md-restore.js
 *
 * 出发点：眼睛会动、脸会表情，这些都必须是**渲染期**的事。
 * 底层那份资产（position / normal / uv / index / 蒙皮权重 / 112 个形态键位移）
 * 一个字节都不许被改写 —— 否则「同一份资产」「可导出」「可撤销」全都塌了。
 *
 * 验七件事：
 *   ① 开视线 + 转全身 ±18°/±30° + 眨眼跑起来 → position 逐值不变；
 *   ② 同上，normal / uv / skinIndex / skinWeight / index 不变；
 *   ③ 形态键位移（morphAttributes.position）不变，键数不变；
 *   ④ 关掉视线（角度回 0）之后仍然不变 —— 不是「回正了但差一点点」；
 *   ⑤ 组划分（geometry.groups）不变（材质槽靠它，变了眼睛那层就没了）；
 *   ⑥ 文档里没有被视角污染：comp.params 不含角度、节点 transform 没被视线改过；
 *   ⑦ 下发给导出/下游的那份 mesh（SeedModel.Scene.getMesh）与运行时快照一致。
 *
 * ⚠ 这条探针不验「眼睛转得好不好看」—— 那是观感，靠截图。
 *   它只回答一个可判定的事实：**数据有没有被偷偷改掉**。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-restore');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 逐值比较两份数组：返回变化个数与最大差 */
function cmp(a, b) {
  if (!a && !b) return { n: 0, max: 0, ok: true };
  if (!a || !b || a.length !== b.length) return { n: -1, max: NaN, ok: false };
  let n = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) { n++; if (d > max) max = d; }
  }
  return { n, max, ok: n === 0 };
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
  await page.waitForTimeout(1800);

  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* 快照：只取「资产本身」的字段，派生量（drawRange / boundingSphere）不算 */
  const snap = () => page.evaluate((id) => {
    const obj = window.modelDesk.nodeObject(id);
    const g = obj.geometry;
    const arr = (a) => (a && a.array ? Array.from(a.array) : null);
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes.filter((n) => n.id === id)[0];
    const meshId = window.SeedModel.Scene.meshIdOfNode(doc, id);
    const m = meshId ? window.SeedModel.Scene.getMesh(doc, meshId) : null;
    return {
      pos: arr(g.attributes.position),
      normal: arr(g.attributes.normal),
      uv: arr(g.attributes.uv),
      skinIndex: arr(g.attributes.skinIndex),
      skinWeight: arr(g.attributes.skinWeight),
      index: g.index ? Array.from(g.index.array) : null,
      groups: (g.groups || []).map((x) => [x.start, x.count, x.materialIndex]),
      morphs: (g.morphAttributes.position || []).map((a) => Array.from(a.array)),
      docMeshPos: m && m.position ? Array.from(m.position) : null,
      params: node && node.comp ? JSON.parse(JSON.stringify(node.comp.params || {})) : null,
      transform: node ? JSON.parse(JSON.stringify(node.transform)) : null,
      verts: g.attributes.position.count
    };
  }, headId);

  const base = await snap();
  check(base.pos && base.pos.length > 0, '拿到头模顶点（基准快照）',
    base.verts + ' 顶点 · ' + (base.morphs || []).length + ' 形态键');

  /* ---- 把该动的都动起来：视线、眨眼、全身转动、幅度拉满 ---- */
  await page.evaluate(() => {
    const d = window.modelDesk.getDocument();
    const n = d.nodes.filter((x) => x.comp && x.comp.id).pop();
    window.__pivot = window.modelDesk.nodeObject(n.id).parent;
    const bl = document.querySelector('[data-md-cev="blink"]');
    if (bl && !bl.checked) { bl.checked = true; bl.dispatchEvent(new Event('change', { bubbles: true })); }
    const gz = document.querySelector('[data-md-cev="gaze"]');
    if (gz && !gz.checked) { gz.checked = true; gz.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(500);

  for (const rad of [0.314, -0.314, 0.524, -0.524, 0]) {
    await page.evaluate((r) => {
      window.__pivot.rotation.y = r;
      window.__pivot.updateMatrixWorld(true);
    }, rad);
    await page.waitForTimeout(420);
  }
  /* 幅度拉到 150%（面板上限）再跑一段，让位移尽可能大地作用在 GPU 上 */
  await page.evaluate(() => {
    try { window.modelDesk.setComponentParam('gazeAmt', 150); } catch (e) {}
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__pivot.rotation.y = 0.4;
    window.__pivot.updateMatrixWorld(true);
  });
  await page.waitForTimeout(1200);

  const live = await snap();

  /* ---- ①~⑤ 逐字段比 ---- */
  const fields = [
    ['pos', '顶点坐标 position'],
    ['normal', '法线 normal'],
    ['uv', 'UV'],
    ['skinIndex', '蒙皮索引 skinIndex'],
    ['skinWeight', '蒙皮权重 skinWeight'],
    ['index', '三角形索引'],
    ['docMeshPos', '文档里的 mesh 顶点（导出源）']
  ];
  for (const [k, name] of fields) {
    const r = cmp(base[k], live[k]);
    check(r.ok, '视线/眨眼/转动之后 ' + name + ' 逐值不变',
      r.n === 0 ? '0 处变化' : (r.n + ' 处变化 · 最大差 ' + r.max));
  }

  const gSame = JSON.stringify(base.groups) === JSON.stringify(live.groups);
  check(gSame, '组划分不变（材质槽靠它）', JSON.stringify(live.groups));

  const morphN = base.morphs.length === live.morphs.length;
  let morphBad = 0, morphMax = 0;
  for (let i = 0; i < Math.min(base.morphs.length, live.morphs.length); i++) {
    const r = cmp(base.morphs[i], live.morphs[i]);
    if (!r.ok) { morphBad++; if (r.max > morphMax) morphMax = r.max; }
  }
  check(morphN && morphBad === 0, '形态键位移不变（' + base.morphs.length + ' 个键）',
    morphBad ? morphBad + ' 个键被改 · 最大差 ' + morphMax : '0 个键被改');

  /* ---- ⑥ 文档没被污染 ---- */
  const pv = live.params || {};
  const hasAngle = ['yaw', 'pitch', 'look', 'gazeYaw', 'gazePitch'].some((k) => k in pv);
  check(!hasAngle, '参数里没有角度（角度是运行时状态，不进文档）',
    '键：' + Object.keys(pv).join(','));
  const tSame = JSON.stringify(base.transform) === JSON.stringify(live.transform);
  check(tSame, '节点 transform 没被视线改过',
    tSame ? '与基准一致' : JSON.stringify(live.transform));

  /* ---- ⑦ 关掉视线：角度回 0 之后仍然逐值不变 ---- */
  await page.evaluate(() => {
    const gz = document.querySelector('[data-md-cev="gaze"]');
    if (gz && gz.checked) { gz.checked = false; gz.dispatchEvent(new Event('change', { bubbles: true })); }
    const bl = document.querySelector('[data-md-cev="blink"]');
    if (bl && bl.checked) { bl.checked = false; bl.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    window.__pivot.rotation.y = 0;
    window.__pivot.updateMatrixWorld(true);
  });
  await page.waitForTimeout(900);

  const after = await snap();
  const rPos = cmp(base.pos, after.pos);
  check(rPos.ok, '关掉视线后 position 仍然逐值不变（不是「回正但差一点」）',
    rPos.n === 0 ? '0 处变化' : rPos.n + ' 处变化 · 最大差 ' + rPos.max);
  const rMorph = after.morphs.length === base.morphs.length &&
    after.morphs.every((a, i) => cmp(a, base.morphs[i]).ok);
  check(rMorph, '关掉后形态键也不变', after.morphs.length + ' 个键');

  /* 顶点数不能变（拓扑被重建就是另一条红灯） */
  check(after.verts === base.verts, '顶点数不变', base.verts + ' → ' + after.verts);

  /* 视线关掉后，眼片 uniform 必须归零 —— 否则「关掉」只是视觉上关掉 */
  const uni = await page.evaluate((id) => {
    const obj = window.modelDesk.nodeObject(id);
    const mats = [].concat(obj.material);
    const m = mats.filter((x) => x && x.userData && x.userData.mdGazeU)[0];
    return m ? [+m.userData.mdGazeU.value.x.toFixed(6), +m.userData.mdGazeU.value.y.toFixed(6)] : null;
  }, headId);
  check(uni && Math.abs(uni[0]) < 1e-6 && Math.abs(uni[1]) < 1e-6,
    '关掉视线后眼片位移归零（GPU 侧也没有残留）', JSON.stringify(uni));

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  RUN.finish(errors, { fails: fails });
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 条失败 · ' + RUN.dir : '✅ 全部通过 · ' + RUN.dir);
  process.exit(fails ? 1 : 0);
})();
