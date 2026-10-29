/* 截图：多视图 App（工具栏 / 线框开关 / 透明底）
 * 用法：node tools/shot-multiview.js
 * 产物：tools/shots/mv-{app,side,wire-off,bare}.png
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');
const TMP = path.join(__dirname, '_mv-sample');
/* 样例模型：立方体，但每个面切成 2×2 个四边形（共 24 个四边面）。
 * 为什么不直接用 6 面立方体：正对镜头时它是四个纯色方块，线框只剩外轮廓，
 * 截图看不出「四边面 / 没有三角对角线」这件事。切碎之后每个面内部都有线，
 * 一旦退化回三角化，立刻能看到对角斜线。 */
function quadCube() {
  const lines = [];
  const verts = [];
  const idx = new Map();
  const v = (x, y, z) => {
    const k = x + ',' + y + ',' + z;
    if (!idx.has(k)) { verts.push([x, y, z]); idx.set(k, verts.length); }
    return idx.get(k);
  };
  /* 每个面用「法线 + 两个切向」参数化，2×2 各格单独成 f（四个点，保持原始四边形） */
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],    // +X
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],   // -X
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],    // +Y
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],   // -Y
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],    // +Z
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]]    // -Z
  ];
  faces.forEach(([n, u, w]) => {
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const pt = (i, j) => {
          const s = i / 2 - 0.5, t = j / 2 - 0.5;
          return [0, 1, 2].map(c => n[c] + u[c] * s * 2 + w[c] * t * 2);
        };
        const p1 = pt(a, b), p2 = pt(a + 1, b), p3 = pt(a + 1, b + 1), p4 = pt(a, b + 1);
        lines.push('f ' + [p1, p2, p3, p4].map(p => v(...p.map(x => Math.round(x * 2) / 2))).join(' '));
      }
    }
  });
  return verts.map(p => 'v ' + p.join(' ')).join('\n') + '\n' + lines.join('\n') + '\n';
}
const OBJ = quadCube();

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
  const objFile = path.join(TMP, 'cube-quad.obj');
  fs.writeFileSync(objFile, OBJ, 'utf8');

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  await page.evaluate(() => multiview.open());
  await page.waitForTimeout(400);
  await page.setInputFiles('#mvFile', objFile);
  await page.waitForTimeout(1200);

  /* ⚠ 先把「留白 / 间距」摆回常用值再拍。
   * 存在 localStorage 里的老设置可能是留白 100 + 间距 0：格子与格子严丝合缝，
   * 纯色（白面）模式下整张图就是一片白，缩略显示时**看着像渲染失败**——
   * 曾经就这么误判过一次。截图工具必须自己保证画面可读。 */
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('mvMargin', 108);
    set('mvGap', 8);
  });
  await page.waitForTimeout(1300);

  const win = await page.locator('#mvWin').boundingBox();
  await page.screenshot({ path: path.join(OUT, 'mv-app.png'), clip: win });
  console.log('  → tools/shots/mv-app.png');

  const ctl = await page.locator('#mvWin .mv-ctl').boundingBox();
  await page.screenshot({ path: path.join(OUT, 'mv-toolbar.png'), clip: ctl });
  console.log('  → tools/shots/mv-toolbar.png');

  /* 关掉线框，同样的视角再拍一张，肉眼能直接对比 */
  await page.evaluate(() => {
    const w = document.getElementById('mvWire');
    w.checked = false;
    w.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'mv-noline.png'), clip: win });
  console.log('  → tools/shots/mv-noline.png');

  /* 切素模 + 线框：旧版做不到的组合 */
  await page.evaluate(() => {
    const w = document.getElementById('mvWire');
    w.checked = true;
    w.dispatchEvent(new Event('change', { bubbles: true }));
    const b = [...document.querySelectorAll('#mvModes [data-mv-val]')].find(x => x.dataset.mvVal === 'shaded');
    if (b) b.click();
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'mv-shaded-wire.png'), clip: win });
  console.log('  → tools/shots/mv-shaded-wire.png');

  /* 原始成品图单独存一份：App 里那张是按 CSS 宽度缩略显示的，
   * 1.4px 的线降采样之后基本看不见，只有看原图才能确认线框真的画上了。 */
  const raw = await page.evaluate(() => {
    const img = document.getElementById('mvOut');
    return img && img.naturalWidth ? { src: img.src, w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  if (raw && raw.src.indexOf('data:image') === 0) {
    fs.writeFileSync(path.join(OUT, 'mv-raw.png'), Buffer.from(raw.src.split(',')[1], 'base64'));
    console.log('  → tools/shots/mv-raw.png · ' + raw.w + '×' + raw.h + '（原图，看线框用这张）');
  }

  /* 工具栏是否溢出：窗口右边界里所有控件都得在框内 */
  const fit = await page.evaluate(() => {
    const w = document.getElementById('mvWin').getBoundingClientRect();
    const bad = [...document.querySelectorAll('#mvWin .mv-ctl button, #mvWin .mv-ctl label, #mvWin .mv-ctl input')]
      .map(e => ({ t: (e.textContent || e.id || '').trim().slice(0, 8), r: e.getBoundingClientRect().right }))
      .filter(o => o.r > w.right - 2);
    return { win: Math.round(w.right), over: bad };
  });
  console.log('\n控件越界：' + (fit.over.length ? JSON.stringify(fit.over) : '无（全部在窗口内）'));

  const modeCount = await page.evaluate(() => document.querySelectorAll('#mvModes [data-mv-val]').length);
  const hasBgs = await page.evaluate(() => !!document.getElementById('mvBgs'));
  const hasWire = await page.evaluate(() => !!document.getElementById('mvWire'));
  console.log('模式按钮 ' + modeCount + ' 个 · 底色选择器' + (hasBgs ? '仍存在 ❌' : '已移除 ✅') +
    ' · 线框勾选框' + (hasWire ? '存在 ✅' : '缺失 ❌'));

  fs.rmSync(TMP, { recursive: true, force: true });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
