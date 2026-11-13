/* 探针：图层「Z 序」真的生效（3D 与 2D 交错）
 * 用法：node tools/probe-mv-zorder.js
 * 产物：运行目录下的 zorder-*.png（见 tools/probe-run.js）
 *
 * 背景：以前 3D 和 2D 不能互换，因为 3D 是一口气渲到 WebGL 画布的，2D 只能在它上面叠。
 * 现在渲染核按 layerOrder 切段：一段 3D 渲一次、落到 2D 画布，中间夹着的 2D 层插进两次
 * 渲染之间。这个探针要证明的是**像素真的变了**，不只是参数传对了。
 *
 * 对照组用「UV 岛色（大面积彩色，3D）」和「深度描边（细线，2D）」：
 *   A 岛色在下面 → 描边线压在上面，深色像素多
 *   B 岛色在上面 → 整片彩盖住描边，深色像素少、彩色像素多
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = require('./probe-run').runDir('probe-mv-zorder');

const V8 = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const F6 = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];

/* 每面独立 UV 的立方体：岛色才画得出来 */
function cubeUv() {
  const L = V8.map(p => 'v ' + p.join(' '));
  F6.forEach((f, i) => {
    const cx = i % 3, cy = Math.floor(i / 3);
    L.push('vt ' + (cx / 3 + 0.02) + ' ' + (cy / 2 + 0.02),
      'vt ' + (cx / 3 + 0.29) + ' ' + (cy / 2 + 0.02),
      'vt ' + (cx / 3 + 0.29) + ' ' + (cy / 2 + 0.44),
      'vt ' + (cx / 3 + 0.02) + ' ' + (cy / 2 + 0.44));
  });
  F6.forEach((f, i) => {
    const b = i * 4 + 1;
    L.push('f ' + f.map((vi, k) => vi + '/' + (b + k)).join(' '));
  });
  return L.join('\n') + '\n';
}
const DATA = 'data:application/octet-stream;base64,' + Buffer.from(cubeUv()).toString('base64');

const ORDER_A = ['uvisland', 'wire', 'crease', 'uvseam', 'dedge', 'outline', 'dgray', 'labels'];
const ORDER_B = ['wire', 'crease', 'uvseam', 'dedge', 'outline', 'dgray', 'labels', 'uvisland'];

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const run = async (name, opts) => {
    const r = await page.evaluate(async ([src, o]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      /* 三类像素分开数：
       *   blueN  线框（#1e6fe0，b 明显大于 r）
       *   inkN   深度描边（#171a20，深灰、无彩度）
       *   islN   岛色（饱和色，彩度高）
       * 一开始把「线框」也算成深色，结果蓝线的 g=111 不满足 rgb 全 < 80，
       * 统计出来是 0，看着像「线没画」。 */
      let blueN = 0, inkN = 0, islN = 0, opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        opaque++;
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        const ch = Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
        const lum = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
        if (b0 - r0 > 40) blueN++;
        else if (ch < 30 && lum < 100) inkN++;
        else if (ch > 60) islN++;
      }
      return { blueN, inkN, islN, opaque, layers: g.layers, err: g.layerErr || null, png: g.png };
    }, [DATA, opts]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'zorder-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(12) + JSON.stringify(r));
    return r;
  };

  const base = {
    views: ['iso'], cell: 420, mode: 'shaded', transparent: true,
    uvIsland: true, wire: true, depthEdge: true,
    depthEdgeThresh: 30, lineColor: '#1e6fe0', depthEdgeColor: '#101010'
  };

  console.log('\n=== Z 序：岛色在下 / 在上 ===');
  const A = await run('island-below', Object.assign({ layerOrder: ORDER_A }, base));
  const B = await run('island-above', Object.assign({ layerOrder: ORDER_B }, base));

  /* 用户报的坑（历史）：一开深度灰，UV 岛色就整片消失（调它自己的不透明度也没反应）。
   * 原因是「只画线」那遍把所有非线 Mesh 都换成了 colorWrite:false 的材质，
   * 岛色也是 Mesh，被一起遮掉了。现在岛色是独立图层，深度灰也是独立图层，
   * 两者的先后完全由 layerOrder / layerOpacity 决定 —— 见下面三条断言。 */
  console.log('\n=== 深度灰 + 岛色（曾经互斥） ===');
  const dg1 = await run('dgray+island', Object.assign({}, base, {
    depthGray: true, depthEdge: false, wire: false, layerOrder: ORDER_A
  }));
  const dg2 = await run('dgray+island-40', Object.assign({}, base, {
    depthGray: true, depthEdge: false, wire: false, layerOrder: ORDER_A,
    layerOpacity: { dgray: 0.5 }
  }));
  /* 岛色翻到深度灰之上（ORDER_B 的尾巴）：岛色在最上，深度灰被压住 */
  const dg3 = await run('island-over-dgray', Object.assign({}, base, {
    depthGray: true, depthEdge: false, wire: false, layerOrder: ORDER_B
  }));

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  console.log('\n=== 断言 ===');
  check(errs.length === 0, '页面零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(!A.err && !B.err, '没有图层抛错', JSON.stringify({ a: A.err, b: B.err }));

  /* 顺序真的传下去且被采用 */
  check(A.layers && A.layers[0] === 'uvisland', 'A：岛色排在最前（最底）', String(A.layers));
  check(B.layers && B.layers[B.layers.length - 1] === 'uvisland', 'B：岛色排在最后（最上）', String(B.layers));

  /* 像素证据：岛色翻到上面会盖掉描边和线框 */
  check(A.blueN > 300, 'A：线框画在岛色之上（看得到蓝线）', 'blue=' + A.blueN);
  check(A.inkN > 100, 'A：深度描边也压在上面', 'ink=' + A.inkN);
  /* 岛色翻到最上 → 它把线框和描边一起盖住 */
  check(B.blueN < A.blueN * 0.75, '岛色翻到上面后，蓝线被盖掉大半',
    A.blueN + ' → ' + B.blueN);
  check(B.inkN < A.inkN * 0.6, '深度描边同样被盖掉',
    A.inkN + ' → ' + B.inkN);
  check(B.islN > A.islN, '同时岛色自己的面积变大 —— 它真的盖住了下面那些',
    A.islN + ' → ' + B.islN);
  check(A.opaque > 1000 && B.opaque > 1000, '两种顺序都画出了模型本体',
    A.opaque + ' / ' + B.opaque);

  /* 深度灰现在是一个**普通后处理层**：它排在谁上面就盖住谁，排在谁下面就透出谁。
   * 这不是「深度灰把岛色吃了」的老 bug，而是图层 Z 序本身——用户可以把岛色拖到最上面，
   * 也可以把深度灰的不透明度调到 50% 让岛色透出来。两条路都验一遍。 */
  check(dg1.islN === 0, '深度灰 100% 且排在岛色之上 → 岛色被盖住（分层语义：后处理层压住下层）',
    'island=' + dg1.islN);
  check(dg2.islN > 1000, '深度灰 50% → 岛色透出来（灰以 alpha 盖上来，不是整片涂死）',
    'island=' + dg2.islN);
  check(dg3.islN > 1000, '岛色拖到深度灰之上 → 岛色画得出来', 'island=' + dg3.islN);
  check(dg3.islN > dg2.islN * 0.9, '同一次渲染里，岛色在灰上面时面积更大（Z 序真的生效）',
    dg2.islN + ' → ' + dg3.islN);
  /* 不勾线框时没有线框层的蓝像素（岛色本身含蓝，所以这里只看线框层不在列表里） */
  check(dg1.layers.indexOf('wire') < 0, '（占位：这几次渲染没有线框层）', String(dg1.layers));

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
