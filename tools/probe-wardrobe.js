/* 探针：衣柜 App（apps/wardrobe）
 *
 * 覆盖的关键点：
 *   ① 桌面图标 → 窗口能打开，皮套在 canvas 上渲染出来；
 *   ② 部件清单来自皮套 cdi3，勾掉后部件透明度压到 0，并落进 hf_wardrobe_state；
 *   ③ 套装：保存 → 卡片出现 → 改乱部件后试穿能恢复；
 *   ④ 与数字人联动：数字人启动读到衣柜搭配；衣柜「应用到数字人」即时改隐藏部件；
 *   ⑤ 窄窗口改成上下排布且无横向溢出；
 *   ⑥ 全程无 pageerror / console error。
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

  /* 找一件带「发」的部件，没有就退到第一件 */
  const target = await page.evaluate(() => {
    const list = window.__wdRig().parts;
    return list.filter((p) => /发/.test(p.name))[0] || list[0];
  });
  check(!!target && !!target.id, '找到可换部件', target ? target.name + ' · ' + target.id : '无');

  await page.click('#wardrobeWin #wdParts input[data-pid="' + target.id + '"]');
  await page.waitForTimeout(360);
  const afterHide = await page.evaluate((id) => ({
    wd: window.__wdRig(),
    op: window.__wdPartOpacity(id),
    st: window.__wdState()
  }), target.id);
  check(afterHide.wd.hidden.indexOf(target.id) >= 0, '勾掉后进入隐藏列表', target.id);
  check(afterHide.op !== null && afterHide.op < 0.02, '部件透明度被压到 0',
    'opacity=' + afterHide.op);
  check(!!(afterHide.st && afterHide.st.draft &&
    afterHide.st.draft.hidden.indexOf(target.id) >= 0), '隐藏状态落进 hf_wardrobe_state');
  check(await page.evaluate(() => {
    const el = document.getElementById('wdHiddenCount');
    return !!el && /隐藏\s*1/.test(el.textContent);
  }), '右栏隐藏计数同步');

  /* ③ 套装：保存 → 卡片出现 → 改乱部件 → 试穿恢复 */
  await page.fill('#wardrobeWin #wdOutfitName', '测试套装');
  await page.click('#wardrobeWin #wdSaveOutfit');
  await page.waitForTimeout(320);
  const saved = await wd(page);
  check(!!saved && saved.outfits.length === 1 && saved.activeId === saved.outfits[0].id,
    '套装已保存并高亮', saved ? saved.outfits.map((o) => o.name).join(' , ') : '无');
  check(await page.evaluate(() => document.querySelectorAll('#wdOutfits .wd-outfit').length === 1),
    '套装卡片出现在左栏');

  await page.click('#wardrobeWin #wdShowAll');
  await page.waitForTimeout(260);
  const shown = await wd(page);
  check(!!shown && shown.hidden.length === 0, '「全部显示」清空隐藏');

  await page.click('#wardrobeWin .wd-outfit[data-oid="' + saved.activeId + '"] .wd-outfit-top b');
  await page.waitForTimeout(420);
  const wore = await wd(page);
  check(!!wore && wore.hidden.indexOf(target.id) >= 0 && wore.activeId === saved.outfits[0].id,
    '试穿套装恢复隐藏部件');

  /* ④ 打开数字人：启动时应当读到衣柜的当前搭配 */
  await page.evaluate(() => window.openDeskApp('live2d'));
  const l2ready = await page.waitForFunction(
    () => window.__l2dRig && window.__l2dRig() !== null,
    null, { timeout: 30000 }
  ).then(() => true).catch(() => false);
  check(l2ready, '数字人皮套加载成功');
  const l2 = await page.evaluate(() => window.__l2dRig());
  check(!!l2 && l2.hidden.indexOf(target.id) >= 0, '数字人启动时穿上了衣柜搭配',
    l2 ? 'hidden ' + l2.hidden.length : '参数不可读');

  /* 衣柜里改成「全部显示」再应用到数字人：隐藏部件应当即时清空 */
  /* 数字人窗口在前台时衣柜是隐藏的，这里直接派发 DOM click，不依赖可见性 */
  await page.evaluate(() => document.getElementById('wdShowAll').click());
  await page.waitForTimeout(220);
  await page.evaluate(() => document.getElementById('wdApplyHuman').click());
  await page.waitForTimeout(420);
  const l2after = await page.evaluate(() => window.__l2dRig());
  check(!!l2after && l2after.hidden.length === 0, '「应用到数字人」即时清空隐藏部件',
    l2after ? 'hidden ' + l2after.hidden.length : '参数不可读');
  const stAfter = await page.evaluate(() => window.__wdState());
  check(!!stAfter && stAfter.draft && stAfter.draft.hidden.length === 0,
    '当前搭配（draft）已落盘');

  /* ⑤ 窄窗：容器查询把三栏改成上下排布 */
  /* 把衣柜切回前台再量尺寸 */
  await page.evaluate(() => window.openDeskApp('wardrobe'));
  await page.waitForTimeout(450);
  const narrow = await page.evaluate(() => {
    const win = document.getElementById('wardrobeWin');
    const old = win.getAttribute('style');
    win.style.width = '700px';
    win.style.height = '760px';
    const app = document.querySelector('#wardrobeWin .wd-app');
    const main = document.querySelector('#wardrobeWin .wd-main');
    const parts = document.getElementById('wdParts');
    const out = {
      dir: getComputedStyle(main).flexDirection,
      appOverflow: app.scrollWidth - app.clientWidth,
      stageH: Math.round(document.getElementById('wdStage').getBoundingClientRect().height),
      partsH: Math.round(parts.getBoundingClientRect().height)
    };
    if (old === null) win.removeAttribute('style');
    else win.setAttribute('style', old);
    return out;
  });
  await page.waitForTimeout(260);
  check(narrow.dir === 'column' && narrow.appOverflow <= 1, '窄窗口改成上下排布且无横向溢出',
    'dir ' + narrow.dir + ' / 溢出 +' + narrow.appOverflow);
  check(narrow.stageH > 180 && narrow.partsH > 60, '窄窗口下舞台与部件栏仍可用',
    '舞台 ' + narrow.stageH + 'px / 部件 ' + narrow.partsH + 'px');

  /* 窄窗截图另存一份，方便回看排布（默认 PROBE_SHOTS=0 时不产生文件） */
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

  const wideEl = await page.$('#wardrobeWin');
  if (wideEl) await run.shot(wideEl, 'wardrobe-window.png');

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
