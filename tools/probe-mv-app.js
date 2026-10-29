/* 探针：多视图 App 里「渲染出来的那几张图」到底有没有内容
 * 用法：node tools/probe-mv-app.js
 *
 * 为什么需要它：`probe-mv-wire` 直接调 `viewGrid` 证明渲染核没问题，
 * 但 App 成品图是不是空白的、线框有没有真的印在图上，只有把输出的图再解一遍才知道。
 * （截图肉眼看不准：白面 + 透明底 + 缩略显示，四条边全都可能糊掉）
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 2×2 细分的立方体：正对镜头时内部也有线，一旦退化三角化立刻出现对角线 */
function quadCube() {
  const lines = [], verts = [], idx = new Map();
  const v = (x, y, z) => {
    const k = x + ',' + y + ',' + z;
    if (!idx.has(k)) { verts.push([x, y, z]); idx.set(k, verts.length); }
    return idx.get(k);
  };
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]
  ];
  faces.forEach(([n, u, w]) => {
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const pt = (i, j) => {
          const s = i / 2 - 0.5, t = j / 2 - 0.5;
          return [0, 1, 2].map(c => n[c] + u[c] * s * 2 + w[c] * t * 2);
        };
        lines.push('f ' + [pt(a, b), pt(a + 1, b), pt(a + 1, b + 1), pt(a, b + 1)]
          .map(p => v(...p)).join(' '));
      }
    }
  });
  return verts.map(p => 'v ' + p.join(' ')).join('\n') + '\n' + lines.join('\n') + '\n';
}

(async () => {
  const TMP = path.join(__dirname, '_mv-probe');
  fs.mkdirSync(TMP, { recursive: true });
  const objFile = path.join(TMP, 'cube-quad.obj');
  fs.writeFileSync(objFile, quadCube(), 'utf8');

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  console.log('\n=== 1. 打开 App 并载入样例 ===');
  await page.evaluate(() => multiview.open());
  await page.waitForTimeout(400);
  await page.setInputFiles('#mvFile', objFile);
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    /* ⚠ #mvOut 是**一整张图**（4 格拼在一起），不是 4 个格子的容器 */
    const img = document.getElementById('mvOut');
    return {
      has: !!img,
      src: img ? img.src.slice(0, 22) : null,
      list: [...document.querySelectorAll('#mvList .mv-item')].map(e => e.textContent.trim().slice(0, 20)),
      state: window.multiview && multiview.state ? {
        views: multiview.state.views.length, mode: multiview.state.mode, wire: multiview.state.wire
      } : null
    };
  });
  check(info.has && info.src.indexOf('data:image') === 0, '输出是一张 dataURL 图', String(info.src));
  check(!!(info.state && info.state.wire === true), '状态里 wire 为 true', JSON.stringify(info.state));
  console.log('     左列表：', JSON.stringify(info.list));

  console.log('\n=== 2. 把成品图解一遍，数像素 ===');
  const px = await page.evaluate(async () => {
    const img = document.getElementById('mvOut');
    if (!img || !img.naturalWidth) return { err: '成品图还没出来' };
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let dark = 0, opaque = 0, clear = 0, mid = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3], lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (a === 0) { clear++; continue; }
      if (a > 250) opaque++;
      if (lum < 110) dark++;
      else if (lum < 245) mid++;
    }
    return { w: c.width, h: c.height, dark, opaque, clear, mid };
  });

  if (px.err) {
    check(false, '成品图可解析', px.err);
  } else {
    check(px.w >= 1000 && px.h >= 1000, '整图尺寸正常', px.w + '×' + px.h);
    check(px.clear > 0, '底色透明（存在 alpha=0 像素）', 'clear=' + px.clear);
    check(px.mid + px.dark > 0, '画到东西了（不是空白）',
      'dark=' + px.dark + ' mid=' + px.mid + ' opaque=' + px.opaque);
    check(px.dark > 500, '有线（暗像素）', 'dark=' + px.dark);
  }

  console.log('\n=== 3. 关掉线框应当变少 ===');
  const after = await page.evaluate(async () => {
    const w = document.getElementById('mvWire');
    w.checked = false;
    w.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
    const img = document.getElementById('mvOut');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 110) dark++;
    }
    return dark;
  });
  const withWire = px.err ? -1 : px.dark;
  check(after < withWire, '关掉线框后暗像素变少', withWire + ' → ' + after);

  check(errors.length === 0, '页面零报错', errors.length ? errors.slice(0, 2).join(' | ') : 'clean');

  fs.rmSync(TMP, { recursive: true, force: true });
  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
