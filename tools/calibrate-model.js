/* 只读校准：切到「智能网格」看 P2.0 / 自定义面数 / 数量 是否展开，并验证点击选择器能否命中。
   不点「生成」，不消耗积分。用完把模式切回「高精度模型」。 */
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.tripo-profile');
const PAGE_URL = 'https://studio.tripo3d.ai/zh/workspace/generate';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dumpOptions(page, tag) {
  const opts = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const sels = '[role="tab"],[role="radio"],[role="option"],[role="switch"],[role="button"],button,label,li,'
      + '[class*="tab-btn"],[class*="tab-item"],[class*="segmented"] button,[class*="option"],[class*="radio"],[class*="chip"],[class*="select"]';
    const out = [];
    for (const el of document.querySelectorAll(sels)) {
      const t = ((el.innerText) || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 24 || !vis(el)) continue;
      out.push(t);
    }
    return out;
  });
  console.log(`[${tag}] 可见控件文本（${opts.length}）：`);
  opts.forEach(t => console.log('   · ' + t));
  return opts;
}

// 与 tripo-web.js 的 clickTextEl 同逻辑
async function clickTextEl(page, patterns, opts = {}) {
  const sels = '[role="tab"],[role="radio"],[role="option"],[role="switch"],[role="button"],button,label,li,'
    + '[class*="tab-btn"],[class*="tab-item"],[class*="segmented"] button,[class*="option"],[class*="radio"],[class*="chip"],[class*="select"]';
  const maxLen = opts.maxLen || 24;
  const els = await page.$$(sels);
  for (const el of els) {
    const text = ((await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > maxLen) continue;
    if (!patterns.some(p => new RegExp(p, 'i').test(text))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 22 || box.height < 14) continue;
    await el.click({ timeout: 3000 }).catch(async () => { await el.click({ force: true, timeout: 3000 }).catch(() => {}); });
    await sleep(opts.wait || 700);
    return text;
  }
  return '';
}

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (!/\/workspace\/generate/i.test(page.url() || '')) {
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(4000);
    }
    await page.bringToFront().catch(() => {});
    await sleep(1500);

    await dumpOptions(page, '初始');

    const hit = await clickTextEl(page, ['^智能网格'], { maxLen: 12 });
    console.log('点击「智能网格」→', hit || '未命中');
    await sleep(1200);
    const after = await dumpOptions(page, '智能网格');

    const checks = [
      ['模式 智能网格', ['^智能网格$']],
      ['模式 高精度模型', ['^高精度模型$']],
      ['版本 P2.0', ['^P2\\.0$']],
      ['版本 P1.0', ['^P1\\.0$']],
      ['自定义面数', ['^自定义面数$']],
      ['数量 1', ['^1$']],
      ['数量 2', ['^2$']],
      ['数量 4', ['^4$']],
    ];
    console.log('\n—— 选择器命中检查（仅判断元素存在，不点击）——');
    for (const [name, pats] of checks) {
      const exists = after.some(t => pats.some(p => new RegExp(p, 'i').test(t)));
      console.log((exists ? '  ✓ ' : '  ✗ ') + name + (exists ? '' : ' （未出现）'));
    }

    // 切回高精度模型，保持页面原状
    const back = await clickTextEl(page, ['^高精度模型'], { maxLen: 12 });
    console.log('\n已切回：', back || '（未切回，无碍）');
  } finally {
    await context.close();
  }
})().catch(e => { console.error('校准失败：', e.message); process.exit(1); });
