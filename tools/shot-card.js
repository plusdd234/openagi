/* 截图：名片 App
 * 用法：node tools/shot-card.js  → tools/shots/card-*.png
 *
 * 名片是纯静态页面，除了「换过码」这一种状态没有别的分支，
 * 所以只截两版：默认（仓库里那张码）+ 换码后的提示态。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url);
  await page.waitForSelector('#cardWin', { state: 'attached' });

  await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'card');
    if (app) app.open();
  });
  await page.waitForTimeout(1300);

  await page.screenshot({ path: path.join(OUT, 'card-1-full.png') });
  console.log('✅ card-1-full.png（整页：身份 / 数字 / 四条线 / 合集 / 赞赏）');

  /* 桌面图标：只截第一页的图标区，确认新 App 有位置且图标没变形 */
  await page.evaluate(() => { if (typeof deskAppLeave === 'function') deskAppLeave(); });
  await page.waitForTimeout(760);
  await page.screenshot({ path: path.join(OUT, 'card-2-icon.png'), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  console.log('✅ card-2-icon.png（桌面图标位）');

  /* 回到名片，触发一次 toast，看反馈条的样子 */
  await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'card');
    if (app) app.open();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const b = document.getElementById('cdCopyUid');
    if (b) b.click();
  });
  await page.waitForTimeout(320);
  /* toast 挂在窗口底部居中（bottom:18px）。窗口底边在 CSS 坐标 ~807，
   * 别按截图（被缩放过）的像素去推 clip。 */
  await page.screenshot({ path: path.join(OUT, 'card-3-toast.png'), clip: { x: 420, y: 690, width: 620, height: 150 } });
  console.log('✅ card-3-toast.png（复制反馈条）');

  /* 窄窗（<=880px 断点）：右侧栏掉到下面、合集改单列。
   * 小笔记本分屏就长这样，最容易挤坏的一档。 */
  const ctxS = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });
  const pageS = await ctxS.newPage();
  await pageS.goto(url);
  await pageS.waitForSelector('#cardWin', { state: 'attached' });
  await pageS.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'card');
    if (app) app.open();
  });
  await pageS.waitForTimeout(1300);
  await pageS.screenshot({ path: path.join(OUT, 'card-4-narrow.png') });
  console.log('✅ card-4-narrow.png（窄窗单列）');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
