/* 探针：衣柜 App（apps/wardrobe）——真实换装
 *
 * 覆盖的关键点：
 *   ① 桌面图标 → 窗口能打开，皮套在 canvas 上渲染出来；
 *   ② 鲸鱼娘：点衣橱槽位 → 参数真写进 Cubism（眼镜 / 发饰），不是只改界面；
 *   ③ 套装：保存 → 恢复默认 → 试穿后参数与部件一起回来；
 *   ④ 手动隐藏部件 → 模型透明度真的归零，取消后恢复；
 *   ⑤ 与数字人联动：数字人启动读到衣柜的 params，并穿到模型上；
 *   ⑥ 没有真实槽位的皮套（Haru）不进口袋衣柜，避免假换装；
 *   ⑦ 存档是 v2，look / params 都落盘；窄窗无横向溢出；
 *   ⑧ 全程无 pageerror / console error。
 *
 * 用法：node tools/probe-wardrobe.js [--shots]
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { createRun, ROOT } = require('./probe-run');

const run = createRun('probe-wardrobe');
let fails = 0;

function check(ok, name, extra) {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
}

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.classList.contains('hidden') && cs.display !== 'none' &&
    cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
}, sel);

const wd = (page) => page.evaluate(() => (window.__wdRig ? window.__wdRig() : null));

function slot(page, slotId, itemId) {
  return page.click('#wardrobeWin #wdSlots .wd-opt[data-slot="' + slotId + '"][data-item="' + itemId + '"]');
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => {
    /* 无头环境没有本地模型网关，连接被拒是预期噪声；资源缺失会报 ERR_FILE_NOT_FOUND */
    if (m.type() === 'error' && !/speech|voice|audio|ERR_CONNECTION_REFUSED/i.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  /* 每次从干净的本地状态开始 */
  await page.evaluate(() => {
    try {
      localStorage.removeItem('hf_wardrobe_state');
      localStorage.removeItem('hf_live2d_state');
    } catch (e) { /* 忽略 */ }
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1100);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="wardrobe"]')),
    '桌面出现「衣柜」图标');

  await page.evaluate(() => window.openDeskApp('wardrobe'));
  await page.waitForTimeout(600);
  check(await visible(page, '#wardrobeWin'), '衣柜窗口已打开');

  /* ② 皮套加载：moc3 2.1MB + 两张 2048 纹理，本地也要给足解析时间 */
  const loaded = await page.waitForFunction(
    () => window.__wdRig && window.__wdRig() && window.__wdRig().ready,
    null, { timeout: 30000 }
  ).then(() => true).catch(() => false);
  check(loaded, '皮套加载成功（moc3 + 纹理）');

  const first = await wd(page);
  check(!!first && first.partCount > 20, '读到部件清单',
    first ? first.partCount + ' 件 / ' + first.modelId : '没有部件');

  const cv = await page.evaluate(() => {
    const c = document.querySelector('#wdCanvas canvas');
    if (!c) return null;
    return {
      w: c.clientWidth,
      h: c.clientHeight,
      loading: !document.getElementById('wdLoading').hidden
    };
  });
  check(!!cv && cv.w > 100 && cv.h > 200, 'canvas 已挂载且尺寸合理',
    cv ? cv.w + '×' + cv.h : '无 canvas');
  check(!!cv && !cv.loading, '加载态已收起');
  check(await page.evaluate(() => document.getElementById('wdErr').hidden), '没有落进错误态');

  const slotCount = await page.evaluate(() => document.querySelectorAll('#wdSlots .wd-slot').length);
  check(slotCount >= 8, '衣橱槽位已渲染', slotCount + ' 组（鲸鱼娘）');

  /* ② 点槽位 → 参数真写进模型 */
  await slot(page, 'glasses', 'square');
  await page.waitForTimeout(260);
  let s = await wd(page);
  const opSquare = await page.evaluate(() => window.__wdParam('ParamCheek72'));
  check(!!s && s.params.ParamCheek72 === 1, '选「方眼镜」写进 params', JSON.stringify(s && s.params));
  check(opSquare !== null && Math.abs(opSquare - 1) < 0.02, '模型参数 ParamCheek72 实际为 1',
    'value=' + opSquare);

  await slot(page, 'hair', 'tail');
  await page.waitForTimeout(260);
  s = await wd(page);
  const opTail = await page.evaluate(() => window.__wdParam('fx1'));
  check(!!s && s.params.fx1 === 1, '选「单边马尾」写进 params', JSON.stringify(s && s.params));
  check(opTail !== null && Math.abs(opTail - 1) < 0.02, '模型参数 fx1 实际为 1', 'value=' + opTail);

  const st1 = await page.evaluate(() => window.__wdState());
  check(!!st1 && st1.v === 2 && st1.draft && st1.draft.params && st1.draft.params.fx1 === 1,
    '存档升级为 v2，params 已落盘', st1 ? 'v' + st1.v : '无存档');

  /* ③ 套装：保存 → 恢复默认 → 试穿恢复 */
  await page.fill('#wardrobeWin #wdOutfitName', '测试套装');
  await page.click('#wardrobeWin #wdSaveOutfit');
  await page.waitForTimeout(320);
  const saved = await wd(page);
  check(!!saved && saved.outfits.length === 1 && saved.activeId === saved.outfits[0].id,
    '套装已保存并高亮', saved ? saved.outfits.map((o) => o.name).join(' , ') : '无');
  check(!!saved && saved.outfits[0].params.fx1 === 1 &&
    saved.outfits[0].look.glasses === 'square', '套装里带着 look 与 params');
  check(await page.evaluate(() => document.querySelectorAll('#wdOutfits .wd-outfit').length === 1),
    '套装卡片出现在左栏');

  await page.click('#wardrobeWin #wdResetLook');
  await page.waitForTimeout(320);
  const reset = await wd(page);
  const opAfterReset = await page.evaluate(() => window.__wdParam('fx1'));
  check(!!reset && Object.keys(reset.params).length === 0, '「恢复默认搭配」清空 params');
  check(opAfterReset !== null && Math.abs(opAfterReset) < 0.02, '模型参数也被写回 0',
    'fx1=' + opAfterReset);

  await page.click('#wardrobeWin .wd-outfit[data-oid="' + saved.activeId + '"] .wd-outfit-top b');
  await page.waitForTimeout(420);
  const wore = await wd(page);
  check(!!wore && wore.params.fx1 === 1 && wore.params.ParamCheek72 === 1,
    '试穿套装恢复 look 与 params', JSON.stringify(wore && wore.params));

  /* ④ 应用给数字人（先落 draft，再开数字人，验证启动即穿） */
  await page.evaluate(() => document.getElementById('wdApplyHuman').click());
  await page.waitForTimeout(240);

  await page.evaluate(() => window.openDeskApp('live2d'));
  const l2ready = await page.waitForFunction(
    () => window.__l2dRig && window.__l2dRig() !== null,
    null, { timeout: 30000 }
  ).then(() => true).catch(() => false);
  check(l2ready, '数字人皮套加载成功');
  const l2 = await page.evaluate(() => window.__l2dRig());
  check(!!l2 && l2.params && l2.params.fx1 === 1 && l2.params.ParamCheek72 === 1,
    '数字人启动时穿上了衣柜的换装参数', l2 ? JSON.stringify(l2.params) : '读不到参数');

  /* ⑤ 皮套下拉只列出有槽位的皮套：官方 Haru 的 runtime 没有第二套服装部件，
     不做「点了变光头」的假换装，因此整个 Haru 不进口袋衣柜 */
  await page.evaluate(() => window.openDeskApp('wardrobe'));
  await page.waitForTimeout(400);
  const sel = await page.evaluate(() => ({
    opts: Array.from(document.querySelectorAll('#wdModelSel option')).map((o) => o.value),
    hasHaruPreset: !!(window.WD_PRESETS && window.WD_PRESETS.haru)
  }));
  check(sel.opts.length === 1 && sel.opts[0] === 'c_0120' && !sel.hasHaruPreset,
    '衣柜只列出有真实槽位的皮套（Haru 无槽位不展示）', JSON.stringify(sel.opts));

  /* ⑥ 高级部件：隐藏 / 恢复一件真实存在的部件，透明度真的写进 Cubism */
  await page.evaluate(() => { document.getElementById('wdAdv').open = true; });
  await page.waitForTimeout(160);
  const partId = 'Part29';
  const partBefore = await page.evaluate((id) => window.__wdPartOpacity(id), partId);
  await page.click('#wdParts input[data-pid="' + partId + '"]');
  await page.waitForTimeout(300);
  const partOff = await page.evaluate((id) => window.__wdPartOpacity(id), partId);
  check(partBefore !== null && partBefore > 0.9 && partOff !== null && partOff < 0.02,
    '手动隐藏部件真的落到模型透明度', partId + ' ' + partBefore + '→' + partOff);
  await page.click('#wdParts input[data-pid="' + partId + '"]');
  await page.waitForTimeout(300);
  const partBack = await page.evaluate((id) => window.__wdPartOpacity(id), partId);
  check(partBack !== null && partBack > 0.9, '取消隐藏后部件透明度恢复', partId + '=' + partBack);

  /* ⑦ 窄窗：容器查询把三栏改成上下排布 */
  await page.evaluate(() => { document.getElementById('wdAdv').open = false; });
  await page.waitForTimeout(160);
  const narrow = await page.evaluate(() => {
    const win = document.getElementById('wardrobeWin');
    const old = win.getAttribute('style');
    win.style.width = '700px';
    win.style.height = '760px';
    const app = document.querySelector('#wardrobeWin .wd-app');
    const main = document.querySelector('#wardrobeWin .wd-main');
    const slots = document.getElementById('wdSlots');
    const out = {
      dir: getComputedStyle(main).flexDirection,
      appOverflow: app.scrollWidth - app.clientWidth,
      stageH: Math.round(document.getElementById('wdStage').getBoundingClientRect().height),
      slotsH: Math.round(slots.getBoundingClientRect().height)
    };
    if (old === null) win.removeAttribute('style');
    else win.setAttribute('style', old);
    return out;
  });
  await page.waitForTimeout(260);
  check(narrow.dir === 'column' && narrow.appOverflow <= 1, '窄窗口改成上下排布且无横向溢出',
    'dir ' + narrow.dir + ' / 溢出 +' + narrow.appOverflow);
  check(narrow.stageH > 180 && narrow.slotsH > 80, '窄窗口下舞台与衣橱仍可用',
    '舞台 ' + narrow.stageH + 'px / 衣橱 ' + narrow.slotsH + 'px');

  /* 截图：整窗与窄窗各留一张，方便回看三栏与上下排布 */
  const wideEl = await page.$('#wardrobeWin');
  if (wideEl) await run.shot(wideEl, 'wardrobe-window.png');

  await page.evaluate(() => {
    const win = document.getElementById('wardrobeWin');
    window.__wdWinStyle = win.getAttribute('style');
    win.style.width = '700px';
    win.style.height = '760px';
  });
  await page.waitForTimeout(300);
  const winEl = await page.$('#wardrobeWin');
  if (winEl) await run.shot(winEl, 'wardrobe-narrow.png');
  await page.evaluate(() => {
    const win = document.getElementById('wardrobeWin');
    if (window.__wdWinStyle === null) win.removeAttribute('style');
    else win.setAttribute('style', window.__wdWinStyle);
    delete window.__wdWinStyle;
  });
  await page.waitForTimeout(260);

  await browser.close();
  check(errors.length === 0, '全程无 pageerror / console error', errors.join(' | '));

  run.finish(errors);
  console.log('\n' + (fails ? '❌ ' + fails + ' 项未通过' : '✅ 全部通过') + ' · 运行目录 ' + run.dir);
  process.exit(fails ? 1 : 0);
})().catch(async (err) => {
  console.error('探针异常：', (err && err.stack) || err);
  try { run.finish([err]); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
