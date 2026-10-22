const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, 'index.html')).href;

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message) + '\n    stack: ' + String((e && e.stack) || '').split('\n').slice(0, 4).join(' | ')));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => ({
    title: document.title,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    cssSheets: document.styleSheets.length,
    cssRules: (() => { try { return document.styleSheets[0].cssRules.length; } catch (e) { return -1; } })(),
    scriptSrcs: Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src')),
    dom: {
      status: !!document.getElementById('status'),
      bpCanvas: !!document.getElementById('bpCanvas'),
      brandHome: !!document.getElementById('brandHome'),
    },
    globals: {
      NODE_DEFS: typeof NODE_DEFS,
      executeNodeFn: (typeof runFlow) ,
      hasAnalyze: typeof analyze,
      hasGenerate3D: typeof generate3D,
    },
  }));

  console.log('=== 页面信息 ===');
  console.log(JSON.stringify(info, null, 2));

  const fatal = errors.filter(e => /ReferenceError|SyntaxError|is not defined|is not a function|Unexpected/.test(e));
  console.log('\n=== 所有控制台/页面错误 (' + errors.length + ') ===');
  errors.slice(0, 15).forEach(e => console.log(' - ' + e));
  console.log('\n=== 致命错误(引用/语法) (' + fatal.length + ') ===');
  fatal.forEach(e => console.log(' !! ' + e));

  await browser.close();
  process.exit(fatal.length ? 1 : 0);
})().catch(e => { console.error('SMOKE FAILED:', e); process.exit(2); });
