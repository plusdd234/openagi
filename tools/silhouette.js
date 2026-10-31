/* 剪影对图内核体检：归一化 / IoU / 分带宽度 / 文字过滤
 * 全部用合成剪影，不依赖任何图片文件。用法：node tools/silhouette.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Silhouette !== 'undefined', null, { timeout: 15000 });

  console.log('=== 1. 归一化：按身高缩放 + 以 bbox 为准（不偏移）===');
  const norm = await page.evaluate(() => {
    // 一个 100×200 的竖条，故意放在画布右侧，验证归一化后 bbox 从 0 开始
    const W = 400, H = 300;
    const mask = new Uint8Array(W * H);
    for (let y = 40; y < 240; y++) for (let x = 300; x < 340; x++) mask[y * W + x] = 1;
    const m = { w: W, h: H, mask, count: 40 * 200 };
    const n = Silhouette.normalize(m, 480);
    let firstCol = -1;
    for (let x = 0; x < n.w && firstCol < 0; x++) for (let y = 0; y < n.h; y++) if (n.mask[y * n.w + x]) { firstCol = x; break; }
    return { w: n.w, h: n.h, firstCol };
  });
  check('高度归一到 480', norm.h === 480, String(norm.h));
  check('宽度按比例（40/200×480≈96）', Math.abs(norm.w - 96) <= 2, String(norm.w));
  check('以 bbox 左边界为准（不残留原图偏移）', norm.firstCol === 0, String(norm.firstCol));

  console.log('=== 2. 自己跟自己比：IoU = 1 ===');
  const self = await page.evaluate(() => {
    const W = 200, H = 400;
    const mask = new Uint8Array(W * H);
    for (let y = 20; y < 380; y++) {
      const half = 20 + 30 * Math.sin((y - 20) / 360 * Math.PI);
      for (let x = 100 - half; x < 100 + half; x++) mask[y * W + x] = 1;
    }
    const m = { w: W, h: H, mask, count: 0 };
    const r = Silhouette.compare(m, m, { height: 320 });
    return r;
  });
  check('IoU 等于 1', Math.abs(self.iou - 1) < 1e-6, String(self.iou));
  check('每个高度带比值为 1、偏差 0（空带跳过）', self.bands.every(b => b.ratio == null || (Math.abs(b.ratio - 1) < 0.02 && Math.abs(b.deltaPct) < 2)), JSON.stringify(self.bands.slice(0, 4)));

  console.log('=== 3. 同一个形状换分辨率：结论不该变 ===');
  const scaled = await page.evaluate(() => {
    const build = (k) => {
      const W = 200 * k, H = 400 * k;
      const mask = new Uint8Array(W * H);
      for (let y = 20 * k; y < 380 * k; y++) {
        const half = (20 + 30 * Math.sin((y / k - 20) / 360 * Math.PI)) * k;
        for (let x = 100 * k - half; x < 100 * k + half; x++) mask[y * W + x | 0] = 1;
      }
      return { w: W, h: H, mask, count: 0 };
    };
    const a = build(1), b = build(2);
    return Silhouette.compare(a, b, { height: 320 });
  });
  check('2× 分辨率的同一形状 IoU > 0.97', scaled.iou > 0.97, String(scaled.iou));

  console.log('=== 4. 变窄的模型：分带比值要能指出来 ===');
  const narrow = await page.evaluate(() => {
    const mk = (widthAt) => {
      const W = 300, H = 400;
      const mask = new Uint8Array(W * H);
      for (let y = 20; y < 380; y++) {
        const half = widthAt(y);
        for (let x = 150 - half; x < 150 + half; x++) mask[y * W + x] = 1;
      }
      return { w: W, h: H, mask, count: 0 };
    };
    /* 参考：上半身宽 60，下半身也宽 60；模型：上半身不变，下半身（y>200）只宽 20 */
    const ref = mk(() => 60);
    const model = mk(y => (y > 200 ? 20 : 60));
    return Silhouette.compare(ref, model, { height: 400 });
  });
  const lower = narrow.bands.filter(b => b.yFrom >= 0.5);
  const upper = narrow.bands.filter(b => b.yTo <= 0.45);
  check('下半身比值明显小于 1', lower.every(b => b.ratio < 0.6), JSON.stringify(lower.map(b => b.ratio)));
  check('上半身比值接近 1', upper.every(b => Math.abs(b.ratio - 1) < 0.15), JSON.stringify(upper.map(b => b.ratio)));
  check('最差的那几段都在下半身', narrow.worst.every(b => b.yFrom >= 0.45), JSON.stringify(narrow.worst.map(b => [b.yFrom, b.deltaPct])));

  console.log('=== 5. 参考图上的文字标注要被剔除 ===');
  const text = await page.evaluate(() => {
    // 白底 + 一个人形色块 + 一块「文字」（矮而宽，和主体不相连）
    const W = 400, H = 400;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#c8c8c8';
    c.fillRect(160, 40, 80, 330);           // 主体：高 330
    c.fillRect(20, 12, 120, 14);            // 标注：高 14
    const m = Silhouette.maskFromImage(c.getImageData(0, 0, W, H));
    return { count: m.count, bbox: m.bbox };
  });
  check('主体还在', text.count > 3000, String(text.count));
  check('文字没有把 bbox 拉到左上角', text.bbox[1] > 30, JSON.stringify(text.bbox));

  console.log('=== 6. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})();
