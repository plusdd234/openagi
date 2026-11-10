/* 探针：工具箱新入口（阵列 / 细分一次 / 溶解）是否真的接上
 * 用法：node tools/probe-ops-ui.js
 *
 * 为什么单独一个：probe-ops2.js 证明算子算得对，这里证明「用户点得到、
 * 预览不改文档、Enter 才提交、撤销能回来、没选择时有明确提示」。
 *
 * 口径：
 *   - 默认 6 面盒子；
 *   - 阵列：默认数量 3、间距 X 1.2 → 提交后 18 面（预览期间文档仍 6 面）；
 *   - 细分一次：每张四边面 → 4 张，6 → 24 面；
 *   - 溶解：没有组件选择时应拒绝并给提示，不改网格。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.openDeskApp('modeldesk'));
  await page.waitForTimeout(2400);

  const opBtn = async op => page.evaluate(o => {
    const el = document.querySelector('.md-op[data-md-op="' + o + '"]');
    if (!el) return false;
    el.click();
    return true;
  }, op);

  const state = () => page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const node = SeedModel.Scene.nodeOf(d.doc);
    const base = SeedModel.Scene.getMesh(d.doc, node);
    return {
      baseFaces: base ? base.faceIds.length : -1,
      viewFaces: window.modelDesk.getState().faces,
      status: (document.getElementById('mdStatus') || {}).textContent || '',
      panel: !!document.querySelector('.md-toolpanel')
    };
  });

  /* 三个入口必须在工具箱里 */
  const btns = await page.evaluate(() => ['array', 'subdivide-once', 'dissolve'].map(o => !!document.querySelector('.md-op[data-md-op="' + o + '"]')));
  check(btns.every(Boolean), '工具箱里有 阵列 / 细分一次 / 溶解', JSON.stringify(btns));

  /* 1. 阵列：live 预览不写文档，Enter 才提交 */
  check(await opBtn('array'), '点「阵列」', '');
  await page.waitForTimeout(600);
  let s = await state();
  check(s.panel && s.status.indexOf('阵列') >= 0, '阵列进入工具会话（参数面板已出现）', s.status);
  check(s.baseFaces === 6, '预览期间基础网格仍是 6 面（没偷偷写文档）', s.baseFaces + ' 面');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  s = await state();
  check(s.baseFaces === 18 && s.viewFaces === 18, 'Enter 提交后阵列生效（3 份 × 6 面 = 18）',
    'base ' + s.baseFaces + ' / view ' + s.viewFaces);
  const undo1 = await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(500);
  s = await state();
  check(undo1 && s.baseFaces === 6, '撤销阵列 → 回到 6 面', undo1 + ' / ' + s.baseFaces + ' 面');

  /* 2. 细分一次：整网格 6 → 24 面 */
  check(await opBtn('subdivide-once'), '点「细分一次」', '');
  await page.waitForTimeout(600);
  s = await state();
  check(s.baseFaces === 24 && s.viewFaces === 24, '细分一次：6 面 → 24 面',
    'base ' + s.baseFaces + ' / view ' + s.viewFaces);
  check(await page.evaluate(() => window.modelDesk.undo()), '撤销细分一次', '');
  await page.waitForTimeout(500);
  s = await state();
  check(s.baseFaces === 6, '撤销后回到 6 面', s.baseFaces + ' 面');

  /* 3. 溶解：无选择 → 拒绝 + 提示，网格不变 */
  check(await opBtn('dissolve'), '点「溶解」', '');
  await page.waitForTimeout(500);
  s = await state();
  check(s.baseFaces === 6 && s.status.indexOf('溶解') >= 0 && s.status.indexOf('选中') >= 0,
    '无组件选择时拒绝溶解并给出提示', s.status);

  /* 4. 拆分岛：没选 → 提示不改；选中 → 真的拆出一个独立对象；撤销能回来 */
  check(await page.evaluate(() => !!document.querySelector('.md-op[data-md-op="split-islands"]')),
    '工具箱 / 工具架有「拆分岛」入口', '');
  check(await opBtn('split-islands'), '点「拆分岛」（当前无选择）', '');
  await page.waitForTimeout(400);
  s = await state();
  const noSelNodes = await page.evaluate(() => window.modelDesk.getState().nodes);
  check(noSelNodes === 1 && s.status.indexOf('UV 岛') >= 0 && s.baseFaces === 6,
    '没选岛时点「拆分岛」：给出提示、对象数 / 面数都不变', noSelNodes + ' 个对象 / ' + s.status);

  /* 直接写文档选择集再 reselect，等价于在视口里点中一个岛（不依赖相机落点） */
  const pick = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const mesh = SeedModel.Scene.getMesh(d.doc);
    const isl = SeedModel.Mesh.uvIslands(mesh);
    const useIsland = isl.islands.length >= 2;
    const faces = (useIsland ? isl.islands[0].faces : [0]).map(f => mesh.faceIds[f]);
    d.doc.selection = {
      mode: useIsland ? 'island' : 'face', nodeIds: [d.doc.activeNodeId],
      vertexIds: [], edgeIds: [], faceIds: faces
    };
    window.modelDesk.reselect();
    return { islands: isl.islands.length, mode: useIsland ? 'island' : 'face', faces: faces.length };
  });
  check(pick.faces > 0, '选中一个 UV 岛（岛数 ' + pick.islands + '，选中 ' + pick.faces + ' 面）', JSON.stringify(pick));

  check(await opBtn('split-islands'), '点「拆分岛」（已有岛选择）', '');
  await page.waitForTimeout(700);
  const afterSplit = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const nodes = SeedModel.Scene.nodesOf(d.doc);
    const active = SeedModel.Scene.nodeOf(d.doc);
    const activeMesh = SeedModel.Scene.getMesh(d.doc, active);
    const other = nodes.filter(n => n.id !== active.id).map(n => {
      const m = SeedModel.Scene.getMesh(d.doc, n);
      return { name: n.name, faces: m ? m.faceIds.length : -1 };
    });
    return {
      nodes: nodes.length,
      activeFaces: activeMesh ? activeMesh.faceIds.length : -1,
      other: other,
      outlineRows: window.modelDesk.getState().outline.real,
      status: document.getElementById('mdStatus').textContent,
      selFace: window.modelDesk.getState().selFace
    };
  });
  check(afterSplit.nodes === 2 && afterSplit.outlineRows === 2,
    '拆分后场景里真的多了 1 个对象（大纲 2 行）',
    afterSplit.nodes + ' 个对象 / 大纲 ' + afterSplit.outlineRows + ' 行');
  check(afterSplit.activeFaces === pick.faces && afterSplit.other[0] && afterSplit.other[0].faces === 6 - pick.faces,
    '面按选择切开：新对象 = 选中的面，原对象 = 剩下的面',
    'new ' + afterSplit.activeFaces + ' / keep ' + (afterSplit.other[0] || {}).faces);
  check(afterSplit.selFace === 0 && afterSplit.status.indexOf('拆成独立对象') >= 0,
    '拆分后清空组件选择并给出提示', afterSplit.status);

  check(await page.evaluate(() => window.modelDesk.undo()), '撤销拆分', '');
  await page.waitForTimeout(700);
  const afterUndo = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const mesh = SeedModel.Scene.getMesh(d.doc, SeedModel.Scene.nodeOf(d.doc));
    return {
      nodes: SeedModel.Scene.nodesOf(d.doc).length,
      faces: mesh ? mesh.faceIds.length : -1
    };
  });
  check(afterUndo.nodes === 1 && afterUndo.faces === 6,
    '撤销拆分 → 回到 1 个对象 / 6 面', JSON.stringify(afterUndo));
  check(errors.length === 0, '无 pageerror', errors.join(' | '));

  await browser.close();
  console.log(fails ? '\n❌ ' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(1);
});
