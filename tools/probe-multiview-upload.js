/* 最小化只读验证（不点「生成」、不消耗积分）：
 * 多视图上传落位：进页面 → 点多视图图标 → 4 槽位 → 四张带字测试图按 前/左/右/后 落位
 * → 立即校验各槽位 files.length + 截图。不做任何其它交互，缩短自动化时长。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '..', '.tripo-profile');
const PAGE_URL = 'https://studio.tripo3d.ai/zh/workspace/generate';
const TMP = path.join(ROOT, '..', 'tripo_tmp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null });
  const results = [];
  const check = (ok, name, extra) => { results.push(ok); console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : '')); };
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    await sleep(6000);

    // 多视图图标（与 tripo-web.js setMultiViewMode 同逻辑）
    const mvOn = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const els = Array.from(document.querySelectorAll('[class*="multi-view" i], [class*="multiView" i]'));
      for (const el of els) {
        if (!vis(el)) continue;
        (el.closest('button,[role=button],label') || el).click();
        return true;
      }
      return false;
    });
    await sleep(2000);

    const slotCount = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return Array.from(document.querySelectorAll('input[type=file]')).filter(el => {
        if (!vis(el)) return false;
        const a = (el.getAttribute('accept') || '').toLowerCase();
        return /image|png|jpe?g|webp/.test(a) && !/glb|fbx|obj|stl|model|video|mp4/.test(a);
      }).length;
    });
    check(mvOn && slotCount === 4, '多视图模式 4 个槽位', '图标点击=' + mvOn + ' 槽位数=' + slotCount);

    // 四张带字测试图：前=红 左=蓝 右=绿 后=橙
    fs.mkdirSync(TMP, { recursive: true });
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
    const labels = ['前', '左', '右', '后'];
    const files = [];
    for (let i = 0; i < 4; i++) {
      let dataUrl = null;
      try {
        dataUrl = await page.evaluate(({ c, label }) => {
          const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = c; ctx.fillRect(0, 0, 96, 96);
          ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(label, 48, 58);
          return cv.toDataURL('image/png');
        }, { c: colors[i], label: labels[i] });
      } catch (e) { console.log('  canvas evaluate 失败', i, e.message); }
      if (!dataUrl) break;
      const f = path.join(TMP, 'mv_test_' + i + '.png');
      fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
      files.push(f);
    }
    check(files.length === 4, '四张测试图已生成', files.map(f => path.basename(f)).join(','));

    if (files.length === 4) {
      // 与 tripo-web.js attachMultiView 相同：第 slot 个可见图片控件 ← 第 slot 张图
      const handles = await page.$$('input[type=file]');
      const visHandles = [];
      for (const h of handles) {
        const ok = await h.evaluate(el => {
          const b = el.getBoundingClientRect();
          if (!(b.width > 0 && b.height > 0)) return false;
          const a = (el.getAttribute('accept') || '').toLowerCase();
          return /image|png|jpe?g|webp/.test(a) && !/glb|fbx|obj|stl|model|video|mp4/.test(a);
        }).catch(() => false);
        if (ok) visHandles.push(h);
      }
      for (let i = 0; i < Math.min(4, visHandles.length); i++) {
        await visHandles[i].setInputFiles(files[i], { timeout: 8000 }).catch(e => console.log('  上传失败', i, e.message));
        await sleep(600);
      }
      await sleep(1200);
      const imgs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('img'))
          .map(i => ({ w: i.naturalWidth, src: (i.src || '').slice(0, 24) }))
          .filter(i => i.w > 0);
      });
      console.log('  上传后图片：', JSON.stringify(imgs));
      const perSlot = await page.evaluate(() => {
        // 上传后 Tripo 会移除原始 file 输入（仅剩模型上传输入），改以上预览图验证
        const blobImgs = Array.from(document.querySelectorAll('img')).filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0);
        return { blobCount: blobImgs.length, totalImgs: document.querySelectorAll('img').length };
      });
      console.log('  各槽位文件：', JSON.stringify(perSlot));
      await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_multiview_upload.png') });
      check(perSlot.blobCount >= 4, '四张图分别落入四个槽位', 'blob 预览图=' + perSlot.blobCount);
      files.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    }
  } finally {
    await context.close();
  }
  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('验证失败：', e.stack); process.exit(1); });
