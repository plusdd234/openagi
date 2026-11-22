'use strict';
/* 探针：建模 App 的「关卡系统」（对标 Unreal World / Level）
 * 用法：node tools/probe-md-levels.js
 *
 * 判据（全部数据级，不看截图）：
 *  ① Scene API：建/重命名/移入移出/归属查询/显隐联动 node.visible/删关回主关卡。
 *     任何操作都不丢节点与网格数据。
 *  ② 持久化：toSeedModel 带 levels；老文档（无 levels）normalize 后 = []；
 *     GLB 保存（injectSeedModel）→ readSeedModel → validate 往返后 levels 逐字段一致。
 *  ③ 单关导出：exportBytes({levelId}) 只含该关对象；全文档导出不受影响。
 *  ④ 锁定：lockedNodeIds 正确；锁定关卡对象在 applyNodeSelection 总闸被拒（不可选中）。
 *  ⑤ UI：大纲「关卡」页签渲染出关卡行与操作按钮。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-levels');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const step = (m) => { try { fs.appendFileSync(path.join(ROOT, '.workbuddy', 'runs', 'levels-steps.log'), m + '\n'); } catch (e) {} };
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
  await page.waitForTimeout(600);

  step('T1 begin');
  /* ---------- ① Scene API ---------- */
  const api = await page.evaluate(() => {
    const S = SeedModel.Scene;
    const doc = window.modelDesk.getDocument();
    const out = {};
    /* 场景基线：默认对象（立方体）+ 一个新球 */
    out.nodeCount0 = doc.nodes.length;
    const ids = doc.nodes.map((n) => n.id);

    /* 老文档语义：无 levels 字段 = 全部在主关卡 */
    out.oldDocLevels = (doc.levels || []).length;
    out.mainIds = S.levelNodeIds(doc, 'main').length;

    const lvA = S.levelCreate(doc, '场景A');
    const lvB = S.levelCreate(doc, '场景B');
    out.created = [lvA.name, lvB.name];
    out.lvAId = lvA.id;
    out.lvBId = lvB.id;
    /* 两个关卡的 id 必须不同（同毫秒连建时 Date.now 相同，序号必须模块级递增） */
    out.idsUnique = lvA.id !== lvB.id;
    /* 重名自动顺延 */
    const lvB2 = S.levelCreate(doc, '场景B');
    out.dupName = lvB2.name;

    S.levelAssign(doc, lvA.id, [ids[0]]);
    S.levelAssign(doc, lvB.id, ids.slice(1));
    out.nodeLv0 = S.nodeLevelId(doc, ids[0]);
    out.nodeLv1 = ids[1] ? S.nodeLevelId(doc, ids[1]) : null;
    /* 再移入 A = 自动从 B 摘除（一个节点只归一关） */
    if (ids[1]) {
      S.levelAssign(doc, lvA.id, [ids[1]]);
      out.nodeLv1After = S.nodeLevelId(doc, ids[1]);
      out.lvBCount = S.levelById(doc, lvB.id).nodes.length;
    }
    out.lvANodes = S.levelNodeIds(doc, lvA.id).length;
    out.mainAfter = S.levelNodeIds(doc, 'main').length;
    /* 显隐联动 */
    S.levelSetVisible(doc, lvA.id, false);
    out.node0Visible = doc.nodes[0].visible === false;
    S.levelSetVisible(doc, lvA.id, true);
    out.node0Restored = doc.nodes[0].visible !== false;
    /* 锁定清单 */
    lvA.locked = true;
    out.lockedIds = S.lockedNodeIds(doc).indexOf(ids[0]) >= 0;
    lvA.locked = false;
    /* 删关回主关卡（不丢节点） */
    const cnt0 = doc.nodes.length;
    const back = S.levelDelete(doc, lvA.id);
    out.deleteBack = back;
    out.nodeCountAfterDelete = doc.nodes.length;
    out.countKept = cnt0 === doc.nodes.length;
    out.node0MainAfter = S.nodeLevelId(doc, ids[0]);
    S.levelDelete(doc, lvB.id);
    S.levelDelete(doc, lvB2.id);
    out.levelsCleared = S.levelsOf(doc).length === 0;
    return out;
  });

  check(api.nodeCount0 >= 1, '①a 场景基线有对象（' + api.nodeCount0 + ' 个）');
  check(api.oldDocLevels === 0 && api.mainIds === api.nodeCount0,
    '①b 老文档语义：无 levels = 全部在主关卡');
  check(api.created[0] === '场景A' && api.created[1] === '场景B' && /^场景B/.test(api.dupName),
    '①c 建 / 重名顺延（' + api.dupName + '）');
  check(api.idsUnique === true, '①c2 同毫秒连建的两关 id 不撞车');
  check(api.nodeLv0 === api.lvAId && (api.nodeLv1 === null || api.nodeLv1 === api.lvBId),
    '①d 移入后归属正确（node0=场景A / 其余=场景B）');
  check(api.lvANodes === api.nodeCount0, '①e 再移入自动摘除旧关（A 有 ' + api.lvANodes + ' 个）');
  check(api.node0Visible === true && api.node0Restored === true,
    '①f 关卡显隐批量联动 node.visible，恢复无损');
  check(api.lockedIds === true, '①g lockedNodeIds 返回锁定关卡的对象');
  check(api.countKept === true && api.deleteBack >= 1 && api.node0MainAfter === 'main',
    '①h 删关：' + api.deleteBack + ' 个对象回主关卡，节点数不变（' + api.nodeCountAfterDelete + '）');
  check(api.levelsCleared === true, '①i 关卡清空后 levels=[]');

  step('T2 begin');
  /* ---------- ② 持久化 round-trip ---------- */
  const rt = await page.evaluate(async () => {
    const S = SeedModel.Scene;
    const doc = window.modelDesk.getDocument();
    /* 加个头模组件（带 comp.params）验证复杂数据也走 round-trip */
    const lv1 = S.levelCreate(doc, '角色');
    const lv2 = S.levelCreate(doc, '道具');
    const ids = doc.nodes.map((n) => n.id);
    S.levelAssign(doc, lv1.id, [ids[0]]);
    S.levelAssign(doc, lv2.id, ids.slice(1));
    lv2.locked = true;
    S.levelSetVisible(doc, lv2.id, false);
    /* 走保存同款管线：toSeedModel → injectSeedModel → readSeedModel → validate */
    const docJson = S.toSeedModel(doc);
    const b = await window.modelDesk.exportBytes();
    const withExtras = SeedGLB.injectSeedModel(b, docJson);
    const dataURL = SeedGLB.toDataURL(withExtras);
    const raw = SeedGLB.readSeedModel(SeedGLB.fromDataURL(dataURL));
    const v = S.validate(raw);
    const out = { ok: v.ok, err: v.errors };
    if (v.ok) {
      const d2 = v.doc;
      out.levels = (d2.levels || []).map((lv) => ({
        name: lv.name, n: lv.nodes.length, visible: lv.visible, locked: lv.locked
      }));
      /* 悬空引用清理：加一个节点入关、删掉它，关卡清单跟着缩 */
      S.addMeshNode(d2, { name: '临时对象', mesh: SeedModel.Mesh.fromBufferGeometry(new THREE.BoxGeometry(0.2, 0.2, 0.2), { slot: 0 }) });
      const tmpId = d2.nodes[d2.nodes.length - 1].id;
      S.levelAssign(d2, lv2.id, [tmpId]);
      out.beforeRemove = S.levelById(d2, lv2.id).nodes.length;
      S.removeNode(d2, tmpId);
      out.afterRemove = S.levelById(d2, lv2.id).nodes.length;
    }
    /* 老文档（无 levels）读入 = [] */
    const oldRaw = JSON.parse(JSON.stringify(docJson));
    delete oldRaw.levels;
    const vOld = S.validate(oldRaw);
    out.oldLevels = vOld.ok ? (vOld.doc.levels || []).length : -1;
    return out;
  });
  check(rt.ok === true, '②a GLB round-trip 后 validate 通过', Array.isArray(rt.err) ? rt.err[0] : '');
  check(Array.isArray(rt.levels) && rt.levels.length === 2 &&
    rt.levels[0].name === '角色' && rt.levels[0].visible === true && rt.levels[1].locked === true && rt.levels[1].visible === false,
    '②b levels 逐字段往返一致（' + JSON.stringify(rt.levels) + '）');
  check(rt.afterRemove === 0 && rt.beforeRemove === 1,
    '②c 删节点后关卡悬空引用被清（' + rt.beforeRemove + ' → ' + rt.afterRemove + '）');
  check(rt.oldLevels === 0, '②d 老文档（无 levels）读入 = []');

  step('T3 begin');
  /* ---------- ③ 单关导出 ---------- */
  const lvExp = await page.evaluate(async () => {
    const S = SeedModel.Scene;
    const doc = window.modelDesk.getDocument();
    const ids = doc.nodes.map((n) => n.id);
    /* 场景至少两个对象：立方体留在主关，第二个对象进「导出关」——
     * 过滤生效的判据是「导出的 GLB 少了对象」，单对象场景测不出过滤。 */
    const mesh2 = SeedModel.Mesh.fromBufferGeometry(new THREE.BoxGeometry(0.3, 0.4, 0.5), { slot: 0 });
    S.addMeshNode(doc, { name: '第二对象', mesh: mesh2 });
    window.modelDesk.reselect();
    const ids2 = doc.nodes.map((n) => n.id);
    const lv = S.levelCreate(doc, '导出关');
    S.levelAssign(doc, lv.id, [ids2[1]]);
    const prodAll = await window.modelDesk.exportLevelBytes(null);
    const prodLv = await window.modelDesk.exportLevelBytes(lv.id);
    const loader = new THREE.GLTFLoader();
    const gAll = await loader.parseAsync(prodAll.buffer, '');
    const gLv = await loader.parseAsync(prodLv.buffer, '');
    function meshesOf(g) {
      const out = [];
      g.scene.traverse((o) => { if (o.isMesh) out.push(o.name); });
      return out.length;
    }
    const raw = prodLv.docJson;
    const vLv = S.validate(raw);
    return {
      allMeshes: meshesOf(gAll),
      lvMeshes: meshesOf(gLv),
      seedName: raw.name || '',
      seedNodeCount: vLv.ok ? vLv.doc.nodes.length : -1,
      seedLvCount: vLv.ok ? S.levelsOf(vLv.doc).length : -1,
      seedLvName: vLv.ok && S.levelsOf(vLv.doc)[0] ? S.levelsOf(vLv.doc)[0].name : ''
    };
  });
  check(lvExp.lvMeshes >= 1 && lvExp.lvMeshes < lvExp.allMeshes,
    '③a 单关导出只含该关对象（' + lvExp.lvMeshes + ' < 全文档 ' + lvExp.allMeshes + '）');
  check(/_导出关$/.test(lvExp.seedName), '③b 单关 GLB 的文档名带关卡名（' + lvExp.seedName + '）');
  check(lvExp.seedNodeCount === 1 && lvExp.seedLvCount === 1 && lvExp.seedLvName === '导出关',
    '③c 单关 seedModel 只带该关节点与该关 levels（' + lvExp.seedNodeCount + ' 节点 / levels=' + lvExp.seedLvName + '）');

  step('T4 begin');
  /* ---------- ④ 锁定过滤（选择总闸） ---------- */
  const lock = await page.evaluate(async () => {
    const S = SeedModel.Scene;
    const doc = window.modelDesk.getDocument();
    const md = window.modelDesk;
    const ids = doc.nodes.map((n) => n.id);
    const lv = S.levelCreate(doc, '锁定关');
    S.levelAssign(doc, lv.id, [ids[0]]);
    lv.locked = true;
    /* 走真实选择入口（视口 / 大纲 / 全选都过它） */
    md.reselect();
    const r1 = md.selectNodeById(ids[0], 'replace');
    const st1 = (window.modelDesk.__debug().doc.selection || {});
    const sel1 = JSON.stringify(st1);
    /* 解锁后可选中 */
    lv.locked = false;
    md.selectNodeById(ids[0], 'replace');
    const sel2 = JSON.stringify(window.modelDesk.__debug().doc.selection || {});
    S.levelDelete(doc, lv.id);
    return { r1, sel1, sel2, changed: sel1 !== sel2 };
  });
  check(lock.changed === true, '④a 锁定关卡对象选择被总闸拒绝，解锁后可选中');

  step('T5 begin');
  /* ---------- ⑤ UI 渲染 ---------- */
  const ui = await page.evaluate(async () => {
    const S = SeedModel.Scene;
    const doc = window.modelDesk.getDocument();
    const lv = S.levelCreate(doc, '界面关');
    S.levelAssign(doc, lv.id, [doc.nodes[0].id]);
    document.querySelectorAll('[data-md-otab]').forEach((b) => {
      if (b.dataset.mdOtab === 'levels') b.click();
    });
    await new Promise((res) => setTimeout(res, 120));
    const list = document.querySelector('#mdOutlineList');
    const html = list ? list.innerHTML : '';
    return {
      hasRow: html.indexOf('界面关') >= 0,
      hasBtns: html.indexOf('data-md-lv="vis"') >= 0 && html.indexOf('data-md-lv="lock"') >= 0 &&
        html.indexOf('data-md-lv="delete"') >= 0 && html.indexOf('data-md-lv="export"') >= 0,
      hasCreate: html.indexOf('data-md-lv="create"') >= 0,
      hasMain: html.indexOf('主关卡') >= 0
    };
  });
  check(ui.hasRow && ui.hasBtns && ui.hasCreate && ui.hasMain, '⑤ 关卡页签渲染完整（行 / 操作钮 / 新建 / 主关行）');

  step('T6 done');
  check(errors.length === 0, '⑥ 页面零报错', errors.length ? errors[0].slice(0, 160) : '干净');
  await browser.close();
  RUN.finish(fails ? ['fail'] : []);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE FAIL', e); process.exit(1); });
