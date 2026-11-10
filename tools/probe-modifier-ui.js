/* 探针：修改器面板（UI 接线，真点按钮，不直接调内部函数）
 * 用法：node tools/probe-modifier-ui.js
 *
 * 为什么还要一个 UI 探针：数据层 probe-modifiers.js 已经证明「求值器算得对」，
 * 但这里要证明「用户点得到、改得动、能撤销」——按钮有没有渲染、change 事件有没有
 * 接上、应用后 base 是否真的换成了求值结果、撤销能否把栈和网格一起还回来。
 *
 * 口径：
 *   - 默认文档是一个 6 面盒子；细分级 1/2/3 = 24 / 96 / 384 面；
 *   - 勾掉启用 = 立刻回到基础网格；删除修改器 = 栈清空；
 *   - 「应用修改器」后：栈空、基础网格变成求值结果、视口读到的仍是同一份；
 *   - Ctrl+Z（modelDesk.undo）把修改器栈和基础网格一起还原。
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

  const read = () => page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const node = SeedModel.Scene.nodeOf(d.doc);
    return {
      faces: window.modelDesk.getState().faces || 0,
      mods: node && node.modifiers ? node.modifiers.map(m => m.type + (m.level != null ? ':' + m.level : '')) : [],
      panelRows: document.querySelectorAll('.md-mod-row').length,
      evalText: (document.querySelector('.md-mod-list') ? '有列表' : '空'),
      evalFaces: d.mesh ? d.mesh.faceIds.length : 0
    };
  });

  /* 面板入口：属性编辑器里必须有「修改器」分区和三个添加按钮 */
  const sec = await page.evaluate(() => ({
    hasSec: !!Array.from(document.querySelectorAll('.md-h2')).find(h => h.textContent.indexOf('修改器') >= 0),
    adds: Array.from(document.querySelectorAll('.md-mod-add button')).map(b => b.dataset.mdMod),
    hadDocFace: window.modelDesk.getState().faces
  }));
  check(sec.hasSec, '属性编辑器里有「修改器」分区', '');
  check(sec.adds.join(',') === 'subdivision,mirror,solidify', '细分 / 镜像 / 加厚三个入口都在',
    sec.adds.join(','));
  check(sec.hadDocFace === 6, '默认文档是 6 面盒子', sec.hadDocFace + ' 面');

  const click = sel => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);

  /* 1. 点「细分」：真按钮 → 文档里出现修改器 → 视口读到 24 面 */
  check(await click('.md-mod-add button[data-md-mod="subdivision"]'), '点「细分」按钮', '');
  await page.waitForTimeout(500);
  let a = await read();
  check(a.mods.length === 1 && a.mods[0] === 'subdivision:1', '修改器栈写入文档（subdivision L1）', a.mods.join('|'));
  check(a.faces === 24 && a.evalFaces === 24, '视口求值结果 = 24 面（不是基础 6 面）',
    a.faces + ' 面 / mesh ' + a.evalFaces);
  check(a.panelRows === 1, '面板渲染出 1 行修改器', a.panelRows + ' 行');

  /* 2. 改级别 select：change 事件必须接上，并且缓存失效 */
  await page.evaluate(() => {
    const s = document.querySelector('select[data-md-modp="level"]');
    s.value = '3';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  a = await read();
  check(a.mods[0] === 'subdivision:3' && a.faces === 384, '级别下拉改到 3 → 求值 384 面',
    a.mods[0] + ' / ' + a.faces + ' 面');

  /* 3. 勾掉启用：求值立刻退回基础网格，但修改器还在栈里 */
  await page.evaluate(() => {
    const c = document.querySelector('input[data-md-modon="0"]');
    c.checked = false;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  a = await read();
  check(a.mods.length === 1 && a.faces === 6, '停用修改器：视口回 6 面，栈里仍保留', a.faces + ' 面');
  check(await page.evaluate(() => {
    const c = document.querySelector('input[data-md-modon="0"]');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }), '重新启用', '');
  await page.waitForTimeout(600);
  a = await read();
  check(a.faces === 384, '重新启用 → 回到 384 面', a.faces + ' 面');

  /* 4. 点行尾 ✕ 删除：栈清空、视口回基础网格 */
  check(await click('.md-mod-ops button[data-md-act="mod-del"]'), '点行尾 ✕', '');
  await page.waitForTimeout(500);
  a = await read();
  check(a.mods.length === 0 && a.faces === 6 && a.panelRows === 0, '删除修改器：栈空、回到 6 面',
    a.mods.length + ' 个 / ' + a.faces + ' 面');

  /* 5. 镜像 + 应用：base 必须换成求值结果，栈清空 */
  check(await click('.md-mod-add button[data-md-mod="mirror"]'), '点「镜像」', '');
  await page.waitForTimeout(700);
  a = await read();
  check(a.mods[0] && a.mods[0].indexOf('mirror') === 0 && a.faces === 12, '镜像后求值 12 面（整盒复制）',
    a.mods[0] + ' / ' + a.faces + ' 面');
  check(await click('button[data-md-act="mod-apply"]'), '点「应用修改器」', '');
  await page.waitForTimeout(700);
  a = await read();
  check(a.mods.length === 0 && a.faces === 12, '应用后：栈清空，网格烘焙为 12 面',
    a.mods.length + ' 个 / ' + a.faces + ' 面');
  const afterApply = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    return {
      baseFaces: SeedModel.Scene.getMesh(d.doc, SeedModel.Scene.nodeOf(d.doc)).faceIds.length,
      same: SeedModel.Scene.getMesh(d.doc, SeedModel.Scene.nodeOf(d.doc)) === d.mesh
    };
  });
  check(afterApply.baseFaces === 12 && afterApply.same,
    '应用后基础网格真的是 12 面，且视口读同一份', 'base=' + afterApply.baseFaces + ' same=' + afterApply.same);

  /* 6. 撤销：修改器栈和网格一起回来 */
  const undone = await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(700);
  a = await read();
  check(undone && a.mods.length === 1 && a.faces === 12, 'Ctrl+Z 撤销「应用」→ 栈回来、网格回 12 面',
    a.mods.join('|') + ' / ' + a.faces + ' 面');

  check(errors.length === 0, '无 pageerror', errors.join(' | '));

  await browser.close();
  console.log(fails ? '\n❌ ' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(1);
});
