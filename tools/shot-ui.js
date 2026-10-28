/* 截图：应用页（骨架 / 就绪 / 头部）+ 蓝图界面 + 工作台→蓝图转场
 * 用法：node tools/shot-ui.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

(async () => {
  const out = path.join(__dirname, '..', '.workbuddy', 'shots');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // 1) 骨架（把商店放慢才截得到）
  await page.evaluate(() => { window.openModelStore = () => new Promise(r => setTimeout(r, 2600)); openDeskApp('store'); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'ui-1-skeleton.png'), clip: { x: 240, y: 100, width: 1180, height: 420 } });
  await page.waitForTimeout(2000);

  // 2) 就绪后的头部（<<< 在左、名称在右）
  await page.screenshot({ path: path.join(out, 'ui-2-app-head.png'), clip: { x: 0, y: 40, width: 1440, height: 60 } });
  await page.hover('#deskAppBack');
  await page.waitForTimeout(340);
  await page.screenshot({ path: path.join(out, 'ui-3-app-head-hover.png'), clip: { x: 0, y: 40, width: 1440, height: 110 } });
  await page.evaluate(() => document.getElementById('deskAppBack').click());
  await page.waitForTimeout(700);

  // 3) 工作台 → 蓝图转场中途
  await page.evaluate(() => openFlow(FLOWS[0].id));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(out, 'ui-4-transition.png') });
  await page.waitForTimeout(900);
  await page.evaluate(() => flushViewSwap());
  await page.waitForTimeout(500);

  // 4) 蓝图整页
  await page.screenshot({ path: path.join(out, 'ui-5-blueprint.png') });
  await page.screenshot({ path: path.join(out, 'ui-6-bp-top.png'), clip: { x: 0, y: 40, width: 1440, height: 66 } });
  await page.screenshot({ path: path.join(out, 'ui-7-bp-side.png'), clip: { x: 10, y: 108, width: 210, height: 430 } });
  await page.screenshot({ path: path.join(out, 'ui-8-bp-bottom.png'), clip: { x: 700, y: 770, width: 740, height: 130 } });
  console.log('shots ok');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
