/* 探针：多视图「线框开关 + 透明底」（像素级）
 * 用法：node tools/probe-mv-wire.js
 * 产物：tools/shots/mv-wire-*.png
 *
 * ⚠ 用**轴测视角**量线像素，别用前视图：
 *   立方体正对镜头时，四边面线框只剩外轮廓那 4 条边，内部一条线都没有
 *   （对角已被四边面算法隐掉，这是对的）。此时「线框开/关」的暗像素数只差
 *   几个抗锯齿像素，换个画布尺寸就从小数变成 0 —— 会让人误判成「线框坏了」。
 *   轴测视角能看到三个面 + 三条接缝，线像素才稳定。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');
const OBJ = [
  'v -1 -1 -1', 'v 1 -1 -1', 'v 1 1 -1', 'v -1 1 -1',
  'v -1 -1 1', 'v 1 -1 1', 'v 1 1 1', 'v -1 1 1',
  'f 1 2 3 4', 'f 5 6 7 8', 'f 1 2 6 5',
  'f 2 3 7 6', 'f 3 4 8 7', 'f 4 1 5 8'
].join('\n') + '\n';
const DATA = 'data:text/plain;base64,' + Buffer.from(OBJ).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const run = async (name, opts) => {
    const r = await page.evaluate(async ([src, o, wantPng]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0, clear = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) { clear++; continue; }
        opaque++;
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
      }
      return { opaque, clear, dark, quad: g.quad, w: c.width, png: wantPng ? g.png : '' };
    }, [DATA, opts, true]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'mv-wire-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(12) + JSON.stringify(r));
    return r;
  };

  const V = { views: ['iso'], cell: 320, transparent: true };
  console.log('\n=== 轴测 · 320 · 透明底 ===');
  const solidOff = await run('solid-off', Object.assign({ mode: 'solid', wire: false }, V));
  const solidOn = await run('solid-on', Object.assign({ mode: 'solid', wire: true }, V));
  const shadedOff = await run('shaded-off', Object.assign({ mode: 'shaded', wire: false }, V));
  const shadedOn = await run('shaded-on', Object.assign({ mode: 'shaded', wire: true }, V));
  const matOn = await run('material-on', Object.assign({ mode: 'material', wire: true }, V));
  const legacy = await run('legacy-line', Object.assign({ mode: 'line' }, V));
  await run('quad-4', { views: ['front', 'back', 'left', 'right'], cell: 240, mode: 'shaded', wire: true, transparent: true });

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  console.log('\n=== 断言 ===');
  check(solidOff.dark < 300, '不勾线框时没有线', 'dark=' + solidOff.dark);
  check(solidOn.dark > solidOff.dark + 800, '纯色 + 勾线框 → 出线', solidOff.dark + ' → ' + solidOn.dark);
  check(shadedOn.dark > shadedOff.dark + 800, '素模 + 勾线框 → 出线（旧版做不到）',
    shadedOff.dark + ' → ' + shadedOn.dark);
  check(matOn.dark > 800, '材质 + 勾线框 → 出线（旧版做不到）', 'dark=' + matOn.dark);
  check(legacy.dark > 800, '老 mode=line 仍画线（向后兼容）', 'dark=' + legacy.dark);
  check(solidOn.clear > 1000, '底色透明（存在 alpha=0 像素）', 'clear=' + solidOn.clear);
  check(solidOn.opaque > 50000, '实体本身仍不透明', 'opaque=' + solidOn.opaque);

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
