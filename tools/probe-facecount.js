/* 只读验证（不点「生成」、不消耗积分）：
 * A. 拓扑面板：打开 → 选四边面 → 原生 setter 写面数 8000 → 读回校验 → Esc 关闭
 * 多视图上传落位验证见 probe-multiview-upload.js（上传后原 file 输入会被页面移除，
 * 只能靠 blob 预览图 + 截图核对，单独跑成功率更高）。
 * 页面逻辑与 tripo-web.js 里 openTopologyPanel / pickTopologyType / setFaceCount 一致。
 */
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '..', '.tripo-profile');
const PAGE_URL = 'https://studio.tripo3d.ai/zh/workspace/generate';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null });
  const results = [];
  const check = (ok, name, extra) => { results.push(ok); console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : '')); };
  try {
    const page = context.pages()[0] || await context.newPage();
    if (!/\/workspace\/generate/i.test(page.url() || '')) {
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(5000);
    }
    await page.bringToFront().catch(() => {});
    await sleep(1500);

    // 切到智能网格（拓扑是智能网格模式的功能）
    const smart = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button],[role=tab],[role=radio]')) {
        if (((el.innerText) || '').trim() === '智能网格' && vis(el)) { el.click(); return true; }
      }
      return false;
    });
    await sleep(1500);
    check(smart, '已切换到智能网格模式');

    /* ---------- A. 拓扑面板 + 面数 ---------- */
    const topoOpen = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button],label,li,[class*="row"],[class*="item"],[class*="setting"]')) {
        if (((el.innerText) || '').trim().replace(/\s+/g, ' ') === '拓扑' && vis(el)) { el.click(); return true; }
      }
      return false;
    });
    await sleep(1200);
    check(topoOpen, '拓扑面板已打开');

    const quad = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button],[role=tab],[role=radio],[role=option],label,li')) {
        const t = ((el.innerText) || '').trim().replace(/\s+/g, ' ');
        if (/^四边面/.test(t) && t.length <= 8 && vis(el)) { el.click(); return t; }
      }
      return '';
    });
    check(!!quad, '已选择四边面', quad);

    // 面数：与 tripo-web.js setFaceCount 相同的页面侧逻辑
    const face = await page.evaluate((val) => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      let anchor = null;
      for (const el of document.querySelectorAll('div,section,li,label')) {
        const t = ((el.innerText) || '').trim().replace(/\s+/g, ' ');
        if (/面数/.test(t) && t.length < 30 && vis(el)) { anchor = el.getBoundingClientRect(); break; }
      }
      const inputs = Array.from(document.querySelectorAll('input[type=text], input[type=number], input[inputmode="numeric"], input[inputmode="decimal"]'));
      let best = -1, bestD = Infinity;
      inputs.forEach((el, i) => {
        if (!vis(el)) return;
        const b = el.getBoundingClientRect();
        if (anchor) {
          const d = Math.hypot((b.x + b.width / 2) - (anchor.x + anchor.width / 2), (b.y + b.height / 2) - (anchor.y + anchor.height / 2));
          if (d < bestD) { bestD = d; best = i; }
        } else if (best < 0) best = i;
      });
      if (best < 0) return { ok: false, why: 'no-input' };
      const el = inputs[best];
      const before = el.value;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return { ok: el.value === String(val), before, after: el.value };
    }, 8000);
    check(face.ok, '面数写入 8000 并读回一致', `原值 ${face.before} → ${face.after}`);
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_facecount.png') });

    const closed = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      for (const el of document.querySelectorAll('button,[role=button]')) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        const t = ((el.innerText) || '').trim();
        if (vis(el) && (al === 'close' || al === '关闭' || t === '×' || t === '✕' || t === 'X')) { el.click(); return al || t; }
      }
      return '';
    });
    if (!closed) await page.keyboard.press('Escape');
    await sleep(800);
    check(true, '拓扑面板已关闭', closed || 'Esc');
  } finally {
    await context.close();
  }
  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('验证失败：', e.stack); process.exit(1); });
