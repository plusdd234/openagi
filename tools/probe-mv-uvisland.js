/* 探针：多视图「UV 岛着色」图层
 * 用法：node tools/probe-mv-uvisland.js
 * 产物：运行目录下的 island-*.png（见 tools/probe-run.js）
 *
 * 两个对照组，都是立方体，只差 UV：
 *   ① 每面一块独立 UV  → 6 只岛（每条空间边两侧 UV 不同 → 不连通）
 *   ② 8 个顶点共用一份 UV → 1 只岛（共享边两侧 UV 相同 → 全连通）
 * 算法对不对就看这两个数。顺便验「岛色是彩色的」「没 UV 的模型不崩」。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = require('./probe-run').runDir('probe-mv-uvisland');

const V = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const F = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];

/* separateUV=true：每个面自己一块 UV（6 只岛）；false：顶点共用 UV（1 只岛） */
function cubeObj(separateUV) {
  const L = V.map(p => 'v ' + p.join(' '));
  if (separateUV) {
    F.forEach((f, i) => {
      const cx = i % 3, cy = Math.floor(i / 3);
      const u0 = cx / 3 + 0.02, v0 = cy / 2 + 0.02;
      const u1 = cx / 3 + 0.29, v1 = cy / 2 + 0.44;
      L.push('vt ' + u0 + ' ' + v0, 'vt ' + u1 + ' ' + v0, 'vt ' + u1 + ' ' + v1, 'vt ' + u0 + ' ' + v1);
    });
    F.forEach((f, i) => {
      const b = i * 4 + 1;
      L.push('f ' + f.map((vi, k) => vi + '/' + (b + k)).join(' '));
    });
  } else {
    /* 用顶点的 x/y 当 UV：共享边的两个端点在两个面里 UV 一致 → 全连通 */
    V.forEach(p => L.push('vt ' + ((p[0] + 1) / 2) + ' ' + ((p[1] + 1) / 2)));
    F.forEach(f => L.push('f ' + f.map(vi => vi + '/' + vi).join(' ')));
  }
  return L.join('\n') + '\n';
}

/* 一点 UV 都不带的模型 */
function noUvCube() {
  const L = V.map(p => 'v ' + p.join(' '));
  F.forEach(f => L.push('f ' + f.join(' ')));
  return L.join('\n') + '\n';
}

const DATA_SEP = 'data:application/octet-stream;base64,' + Buffer.from(cubeObj(true)).toString('base64');
const DATA_SHARED = 'data:application/octet-stream;base64,' + Buffer.from(cubeObj(false)).toString('base64');
const DATA_NOUV = 'data:application/octet-stream;base64,' + Buffer.from(noUvCube()).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const run = async (name, src, opts) => {
    const r = await page.evaluate(async ([s, o]) => {
      const g = await Model3D.viewGrid(s, o);
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      /* 数「不同的颜色」：量化到 16 级再进集合，抗锯齿边缘不会把颜色数吹大 */
      const set = new Set();
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        opaque++;
        set.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
      }
      return { colors: set.size, opaque, island: g.uvisland, err: g.layerErr, png: g.png };
    }, [src, opts]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'island-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(12) + 'colors=' + String(r.colors).padEnd(5) + JSON.stringify(r.island) +
      (r.err ? '  layerErr=' + JSON.stringify(r.err) : ''));
    return r;
  };

  const base = { views: ['iso'], cell: 420, mode: 'shaded', wire: false, transparent: true };
  console.log('\n=== UV 岛着色 ===');
  const sep = await run('sep', DATA_SEP, Object.assign({ uvIsland: true }, base));
  const shared = await run('shared', DATA_SHARED, Object.assign({ uvIsland: true }, base));
  const off = await run('off', DATA_SEP, Object.assign({ uvIsland: false }, base));
  const withSeam = await run('with-seam', DATA_SEP, Object.assign({ uvIsland: true, uvEdge: true }, base));
  const noUv = await run('no-uv', DATA_NOUV, Object.assign({ uvIsland: true }, base));

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  console.log('\n=== 断言 ===');
  check(errs.length === 0, '页面零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(!!sep.island && sep.island.islands === 6, '每面独立 UV → 6 只岛', JSON.stringify(sep.island));
  check(!!shared.island && shared.island.islands === 1, '顶点共用 UV → 1 只岛', JSON.stringify(shared.island));
  check(sep.colors >= 4, '岛色是彩色的（至少 4 种颜色）', 'colors=' + sep.colors);
  check(off.colors <= 3, '不勾时是素模灰（颜色数很少）', 'colors=' + off.colors);
  check(withSeam.island && withSeam.island.islands === 6 && withSeam.colors >= 4,
    '和 UV 描边叠加：岛色与接缝线共存', 'colors=' + withSeam.colors);
  check(!!noUv.island && noUv.island.hasUV === false && noUv.island.islands === 0,
    '没有 UV 的模型：报 hasUV=false，不崩', JSON.stringify(noUv.island));
  check(!noUv.err, '没有 UV 时图层没有抛错', JSON.stringify(noUv.err));

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
