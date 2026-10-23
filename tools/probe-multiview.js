/* 探查 2：多视图模式——点 multi-view 图标后槽位结构，以及一次多图上传如何落位 */
const path = require('path');
const fs = require('fs');
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

    const dumpCard = async (tag) => {
      const d = await page.evaluate(() => {
        const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const desc = el => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 70),
            text: ((el.innerText) || '').trim().replace(/\s+/g, ' ').slice(0, 30),
            type: el.getAttribute('type') || '', accept: (el.getAttribute('accept') || '').slice(0, 40),
            multiple: el.multiple === true, max: el.getAttribute('max') || '',
            size: Math.round(r.width) + 'x' + Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y)
          };
        };
        // 上传卡片区域：左半边页面
        const inputs = Array.from(document.querySelectorAll('input[type=file]')).filter(vis).map(desc);
        const views = Array.from(document.querySelectorAll('[class*="view"], [class*="slot"], [class*="angle"], [class*="face"]'))
          .filter(vis).map(desc).slice(0, 30);
        const texts = Array.from(document.querySelectorAll('button,[role=button],[role=tab],[role=radio],label,li'))
          .filter(vis).map(el => ((el.innerText) || '').trim().replace(/\s+/g, ' ')).filter(t => t && t.length <= 12);
        return { inputs, views, texts: Array.from(new Set(texts)) };
      });
      console.log(`\n===== [${tag}] =====`);
      console.log('-- file inputs --'); d.inputs.forEach(i => console.log('  ' + JSON.stringify(i)));
      console.log('-- view/slot 元素 --'); d.views.forEach(v => console.log('  ' + JSON.stringify(v)));
      console.log('-- texts --'); console.log('  ' + d.texts.join(' | '));
      return d;
    };

    await dumpCard('初始(单图模式)');

    // 点 multi-view 图标
    const mv = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const els = Array.from(document.querySelectorAll('[class*="multi-view"], [class*="multiView"]'));
      for (const el of els) {
        if (vis(el)) {
          const clickable = el.closest('button,[role=button],label') || el;
          clickable.click();
          return String(el.className);
        }
      }
      return '';
    });
    console.log('\n点击 multi-view 图标 →', mv);
    await sleep(2000);
    await dumpCard('多视图模式');
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_multiview.png') });

    // 多视图模式下，看 前/左侧/右侧/后 槽位是否各自有 file input，或共用一个
    const slotInputs = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return Array.from(document.querySelectorAll('input[type=file]'))
        .filter(vis)
        .map(el => {
          const r = el.getBoundingClientRect();
          const parentText = ((el.closest('[class*="view"],[class*="slot"],[class*="card"],[class*="upload"]') || el.parentElement)?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
          return { accept: (el.getAttribute('accept') || '').slice(0, 40), multiple: el.multiple === true, x: Math.round(r.x), y: Math.round(r.y), parentText };
        });
    });
    console.log('\n多视图模式 file inputs:'); slotInputs.forEach(s => console.log('  ' + JSON.stringify(s)));

    // 用一张测试图写进第一个 file input，看预览落在哪个槽
    const testImg = path.join(ROOT, 'tripo_tmp');
    let sample = null;
    try { sample = fs.readdirSync(testImg).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).map(f => path.join(testImg, f))[0] || null; } catch (e) {}
    if (!sample) {
      // 造一张 64x64 纯色 png
      const { createCanvas } = (() => { try { return require('canvas'); } catch (e) { return {}; } })();
      console.log('\n（tripo_tmp 无测试图，跳过上传实验）');
    } else {
      console.log('\n用测试图上传：', sample);
      const before = await page.evaluate(() => document.querySelectorAll('img').length);
      const inputs = await page.$$('input[type=file]');
      let done = '';
      for (const el of inputs) {
        const v = await el.isVisible().catch(() => false);
        if (!v) continue;
        try { await el.setInputFiles(sample); done = 'ok'; break; } catch (e) { done = e.message; }
      }
      await sleep(2500);
      const after = await page.evaluate(() => Array.from(document.querySelectorAll('img')).map(i => ({ src: (i.src || '').slice(0, 30), w: i.naturalWidth, x: Math.round(i.getBoundingClientRect().x), y: Math.round(i.getBoundingClientRect().y) })).filter(i => i.w > 0).slice(0, 10));
      console.log('上传结果:', done, '| img 数', before, '→', after.length);
      after.forEach(i => console.log('   ' + JSON.stringify(i)));
      await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_multiview_uploaded.png') });
    }
  } finally {
    await context.close();
  }
})().catch(e => { console.error('探查失败：', e.stack); process.exit(1); });
