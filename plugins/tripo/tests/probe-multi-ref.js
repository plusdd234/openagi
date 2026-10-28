/* 真实页面只读验证（不点「生成」、不消耗积分）：
 * Tripo 生图页的多参考图上传：直接调用生产代码 tripo-web.js 的 attachReferences，
 * 往页面里那个 accept=image/* 且带 multiple 的 file 输入一次性写入 3 张测试图，
 * 再核对「控件内文件数」与「新增预览图数」，并截图。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '..', '.tripo-profile');
const PAGE_URL = 'https://studio.tripo3d.ai/zh/workspace/generate-image';
const TMP = path.join(ROOT, '..', 'tripo_tmp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const bridge = require(path.join(ROOT, '..', 'tripo-web.js'));
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null });
  const results = [];
  const check = (ok, name, extra) => { results.push(ok); console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : '')); };
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    await sleep(7000);

    const url = page.url();
    check(/\/generate-image/.test(url), '已进 Tripo 生图页', url.slice(0, 60));

    // 页面上带 multiple 的图片文件输入
    const info = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const els = Array.from(document.querySelectorAll('input[type=file]')).filter(el => {
        if (!vis(el)) return false;
        const a = (el.getAttribute('accept') || '').toLowerCase();
        return /image|png|jpe?g|webp/.test(a) && !/glb|fbx|obj|stl|model|video|mp4/.test(a);
      });
      return els.map(el => ({ accept: el.getAttribute('accept'), multiple: !!el.multiple }));
    });
    console.log('  可见图片文件输入：', JSON.stringify(info));
    check(info.length > 0 && info[0].multiple === true, '存在带 multiple 的图片上传控件', JSON.stringify(info));

    // 三张带字测试图
    fs.mkdirSync(TMP, { recursive: true });
    const colors = ['#e74c3c', '#3498db', '#2ecc71'];
    const labels = ['1', '2', '3'];
    const files = [];
    for (let i = 0; i < 3; i++) {
      const dataUrl = await page.evaluate(({ c, label }) => {
        const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = c; ctx.fillRect(0, 0, 96, 96);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(label, 48, 58);
        return cv.toDataURL('image/png');
      }, { c: colors[i], label: labels[i] }).catch(() => null);
      if (!dataUrl) break;
      const f = path.join(TMP, 'ref_test_' + i + '.png');
      fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
      files.push(f);
    }
    check(files.length === 3, '三张测试图已生成', files.map(f => path.basename(f)).join(','));

    if (files.length === 3) {
      const before = await bridge.visibleImageSrcs(page);
      const r = await bridge.attachReferences(page, files);
      check(r.ok, 'attachReferences 上传成功', JSON.stringify(r));
      check(r.uploaded === 3, '报告上传 3 张', 'uploaded=' + r.uploaded);

      const state = await page.evaluate(() => {
        const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const inputs = Array.from(document.querySelectorAll('input[type=file]')).filter(el => {
          if (!vis(el)) return false;
          const a = (el.getAttribute('accept') || '').toLowerCase();
          return /image|png|jpe?g|webp/.test(a) && !/glb|fbx|obj|stl|model|video|mp4/.test(a);
        });
        const blobImgs = Array.from(document.querySelectorAll('img'))
          .filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0)
          .map(i => {
            const b = i.getBoundingClientRect();
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
          });
        return {
          fileCounts: inputs.map(el => (el.files ? el.files.length : -1)),
          blobCount: blobImgs.length,
          blobRects: blobImgs,
          imgCount: document.querySelectorAll('img').length,
        };
      });
      console.log('  上传后状态：', JSON.stringify(state));
      const after = await bridge.visibleImageSrcs(page);
      const grew = after.filter(s => !before.includes(s)).length;
      console.log('  新增可见图像源：', grew);
      check(grew >= 3, '页面新增 3 个参考图预览', '新增源=' + grew);
      check(state.blobCount >= 3, 'DOM 中 3 个 blob 预览图', 'blob=' + state.blobCount);
      // 三张图应有各自的可见位置（不重叠在同一处）
      const uniqPos = new Set(state.blobRects.map(r => r.x + ',' + r.y)).size;
      check(uniqPos >= 2, '参考图分别布局在不同位置', '不同位置数=' + uniqPos + ' 位置=' + JSON.stringify(state.blobRects));

      await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_multi_ref.png') });
      // 左栏参考图区域放大截图
      const clip = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img')).filter(i => /^blob:/.test(i.src || ''));
        if (!imgs.length) return null;
        const rs = imgs.map(i => i.getBoundingClientRect());
        const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
        const x2 = Math.max(...rs.map(r => r.right)), y2 = Math.max(...rs.map(r => r.bottom));
        return { x: Math.max(0, x - 30), y: Math.max(0, y - 30), width: Math.min(1400, x2 - x + 60), height: Math.min(500, y2 - y + 60) };
      });
      if (clip) {
        await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_multi_ref_area.png'), clip });
        console.log('  参考图区域截图：', JSON.stringify(clip));
      }
      files.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    }
  } finally {
    await context.close();
  }
  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('验证失败：', e.stack); process.exit(1); });
