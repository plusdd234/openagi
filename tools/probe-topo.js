/* 探查 Tripo 生模型页：拓扑面板（四边面/三角面 + 面数滑杆）与多视图槽位（前/左侧/右侧/后）
   只读探查 + 尝试填写面数，不点「生成」。 */
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '..', '.tripo-profile');
const PAGE_URL = 'https://studio.tripo3d.ai/zh/workspace/generate';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (!/\/workspace\/generate/i.test(page.url() || '')) {
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(5000);
    }
    await page.bringToFront().catch(() => {});
    await sleep(1500);

    const dump = async (tag) => {
      const d = await page.evaluate(() => {
        const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const desc = el => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            cls: String(el.className || '').slice(0, 60),
            text: ((el.innerText) || '').trim().replace(/\s+/g, ' ').slice(0, 40),
            type: el.getAttribute('type') || '',
            accept: el.getAttribute('accept') || '',
            role: el.getAttribute('role') || '',
            min: el.getAttribute('min') || '', max: el.getAttribute('max') || '',
            value: el.value !== undefined ? String(el.value).slice(0, 20) : '',
            ariaLabel: el.getAttribute('aria-label') || '',
            size: Math.round(r.width) + 'x' + Math.round(r.height),
            x: Math.round(r.x), y: Math.round(r.y)
          };
        };
        const inputs = Array.from(document.querySelectorAll('input, textarea, [role=slider], [role=spinbutton]'))
          .filter(vis).map(desc);
        const slots = Array.from(document.querySelectorAll('[class*="upload"], [class*="slot"], [class*="view"], [class*="drop"]'))
          .filter(vis).map(desc).slice(0, 40);
        const texts = Array.from(document.querySelectorAll('button,[role=button],[role=tab],[role=radio],[role=option],[role=switch],label,li,[class*="option"],[class*="chip"]'))
          .filter(vis).map(el => ((el.innerText) || '').trim().replace(/\s+/g, ' ')).filter(t => t && t.length <= 20);
        return { inputs, slots, texts: Array.from(new Set(texts)) };
      });
      console.log(`\n===== [${tag}] =====`);
      console.log('-- inputs --'); d.inputs.forEach(i => console.log('  ' + JSON.stringify(i)));
      console.log('-- slots --'); d.slots.forEach(s => console.log('  ' + JSON.stringify(s)));
      console.log('-- texts --'); console.log('  ' + d.texts.join(' | '));
      return d;
    };

    // 1) 初始 + 切到智能网格（展开版本/数量）
    await dump('初始');
    const smart = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button],[role=tab],[role=radio]')) {
        const t = ((el.innerText) || '').trim();
        if (t === '智能网格' && vis(el)) { el.click(); return t; }
      }
      return '';
    });
    console.log('\n点击智能网格 →', smart);
    await sleep(1500);
    await dump('智能网格');

    // 2) 打开拓扑面板
    const topo = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button],label,li,[class*="row"],[class*="item"],[class*="setting"]')) {
        const t = ((el.innerText) || '').trim().replace(/\s+/g, ' ');
        if (t === '拓扑' && vis(el)) { el.click(); return t; }
      }
      return '';
    });
    console.log('\n点击「拓扑」行 →', topo);
    await sleep(1500);
    const panel = await dump('拓扑面板');

    // 3) 面数：找数字输入框并尝试填写
    const face = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const cands = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width < 200 && (x.el.type === 'number' || x.el.type === 'text' || x.el.inputMode === 'numeric' || x.el.inputMode === 'decimal'));
      if (!cands.length) return { found: 0 };
      // 取最右上一个（通常是滑杆右侧的数值框）
      cands.sort((a, b) => (b.r.x - a.r.x) || (a.r.y - b.r.y));
      const el = cands[0].el;
      const before = el.value;
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: cands.length, before, cls: String(el.className).slice(0, 50), type: el.type };
    });
    console.log('\n面数输入框：', JSON.stringify(face));
    await sleep(800);

    // 4) 关闭面板（点 × 或 Esc）
    const closed = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button],[aria-label]')) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        const t = ((el.innerText) || '').trim();
        if (vis(el) && (al.includes('close') || al.includes('关闭') || t === '×' || t === '✕')) { el.click(); return al || t; }
      }
      return '';
    });
    console.log('关闭面板 →', closed || '（未找到，按 Esc）');
    if (!closed) await page.keyboard.press('Escape');
    await sleep(800);
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_topo.png') });
    console.log('\n截图：samples/probe_topo.png');
  } finally {
    await context.close();
  }
})().catch(e => { console.error('探查失败：', e.stack); process.exit(1); });
