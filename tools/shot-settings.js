/* 截图：设置面板（重做后）
 * 用法：node tools/shot-settings.js
 * 产物：tools/shots/set-*.png
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  /* 模拟一份「配了一半」的真实状态：总览才有话可说，全空的时候六张卡长得一样 */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('hf_llmKey', 'sk-or-v1-demo-key');
      localStorage.setItem('hf_llmModel', 'deepseek-chat');
      localStorage.setItem('hf_llmBaseUrl', 'https://api.deepseek.com/v1');
      localStorage.setItem('hf_genEngine', 'openai');
      localStorage.setItem('hf_wsProvider', 'searxng');
      localStorage.setItem('hf_wsBase', 'https://searx.example.com');
      /* 复选框存的是布尔，localStorage 会写成 'true'/'false' */
      localStorage.setItem('hf_relayOn', 'true');
      localStorage.setItem('mc_scope_image', 'online');
    } catch (e) { }
  });
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const shoot = async (name, tab) => {
    await page.evaluate(t => { if (t) switchTab(t); openSettings(t || 'overview'); }, tab || '');
    await page.waitForTimeout(420);
    const box = await page.locator('.settings2').boundingBox();
    const f = path.join(OUT, 'set-' + name + '.png');
    await page.screenshot({ path: f, clip: box });
    console.log('  →', path.relative(process.cwd(), f));
  };

  await shoot('overview');
  await shoot('llm', 'llm');
  await shoot('image', 'image');
  await shoot('search', 'search');
  await shoot('assets', 'assets');

  /* 窄屏：导航要变成横向滚动条，两列 grid 要收单列 */
  await page.setViewportSize({ width: 720, height: 860 });
  await page.evaluate(() => openSettings('overview'));
  await page.waitForTimeout(420);
  const f2 = path.join(OUT, 'set-narrow.png');
  await page.screenshot({ path: f2 });
  console.log('  →', path.relative(process.cwd(), f2));

  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
