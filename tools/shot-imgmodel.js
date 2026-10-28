/* 截图：输入条上的「生图模型」下拉（触发器 + 展开的菜单）
 * 用法：node tools/shot-imgmodel.js
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
  await page.waitForTimeout(1400);

  /* 给一个确定的清单，免得截图内容随本机引擎状态变。 */
  await page.evaluate(() => {
    try {
      const base = (document.getElementById('imgBaseUrl').value.trim()
        || document.getElementById('llmBaseUrl').value.trim()).replace(/\/$/, '');
      IMG_MODEL_CACHE = { base, list: [{ id: 'seedream_v5' }, { id: 'nano-banana-pro' }, { id: 'gpt-image-1' }] };
      document.getElementById('imgModel').value = 'nano-banana-pro';
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('hf-img-source-changed'));
  });
  await page.waitForTimeout(600);

  const bar = await page.locator('#deskAiWrap').boundingBox();
  if (bar) {
    await page.screenshot({
      path: path.join(out, 'imgmodel-1-bar.png'),
      clip: { x: Math.max(0, bar.x - 8), y: Math.max(0, bar.y - 8), width: Math.min(1440, bar.width + 16), height: bar.height + 16 }
    });
  }

  /* 展开菜单 */
  await page.click('#deskAiImgBtn');
  await page.waitForTimeout(420);
  const menu = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll('.dai-menu')).find(x => !x.classList.contains('hidden'));
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (menu) {
    await page.screenshot({
      path: path.join(out, 'imgmodel-2-menu.png'),
      clip: { x: Math.max(0, menu.x - 12), y: Math.max(0, menu.y - 12), width: menu.w + 24, height: menu.h + 24 }
    });
  }

  /* 三角定位：整个工具栏一行，看两个下拉的相对位置 */
  await page.evaluate(() => { document.body.click(); });
  await page.waitForTimeout(200);
  const bar2 = await page.locator('.dai-bar').boundingBox();
  if (bar2) {
    await page.screenshot({
      path: path.join(out, 'imgmodel-3-toolbar.png'),
      clip: { x: Math.max(0, bar2.x - 4), y: Math.max(0, bar2.y - 10), width: Math.min(1440, bar2.width + 8), height: bar2.height + 20 }
    });
  }

  await browser.close();
  console.log('截图已存到 .workbuddy/shots/：imgmodel-1-bar / imgmodel-2-menu / imgmodel-3-toolbar');
})().catch(e => { console.error(e); process.exit(1); });
