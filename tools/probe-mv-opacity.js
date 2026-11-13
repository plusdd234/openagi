/* 探针：多视图「图层不透明度」（像素级）
 * 用法：node tools/probe-mv-opacity.js
 * 产物：运行目录下的 op-*.png（见 tools/probe-run.js）
 *
 * 验三件事，缺一条就会「滑条能拖但看着没变」：
 *   ① 3D 层（线框 / 岛色）：材质里的 alpha 真的被乘了；
 *   ② 2D 层（外轮廓）：整层压 alpha，**不是**逐笔叠——描边是逐行 fillRect 叠出来的，
 *      相邻行有重叠，直接设 globalAlpha 会在重叠处发黑（这就是要离屏合成的原因）；
 *   ③ 深度灰：整幅铺的灰度也要能半透明（它走 ImageData，globalAlpha 对它无效）。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = require('./probe-run').runDir('probe-mv-opacity');

const V8 = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const F6 = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];

/* 每面一块独立 UV 的立方体：岛色要能画出来（没 UV 的模型岛色层直接不出图） */
function cubeUv() {
  const L = V8.map(p => 'v ' + p.join(' '));
  F6.forEach((f, i) => {
    const cx = i % 3, cy = Math.floor(i / 3);
    const u0 = cx / 3 + 0.02, v0 = cy / 2 + 0.02;
    const u1 = cx / 3 + 0.29, v1 = cy / 2 + 0.44;
    L.push('vt ' + u0 + ' ' + v0, 'vt ' + u1 + ' ' + v0, 'vt ' + u1 + ' ' + v1, 'vt ' + u0 + ' ' + v1);
  });
  F6.forEach((f, i) => {
    const b = i * 4 + 1;
    L.push('f ' + f.map((vi, k) => vi + '/' + (b + k)).join(' '));
  });
  return L.join('\n') + '\n';
}

const DATA = 'data:application/octet-stream;base64,' + Buffer.from(cubeUv()).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const run = async (name, opts, pick) => {
    const r = await page.evaluate(async ([src, o, pick]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      /* 线条和岛色都画在**不透明的面之上**，PNG 的 alpha 恒为 255，
       * 不透明度体现在颜色上（往底色靠）；只有深度灰是整幅覆盖，alpha 才会真的变。
       * 所以两套指标一起采：颜色类看「最饱和的那个像素」（抗锯齿边缘会把均值带偏），
       * 描边类看「暗像素的 alpha」（线落在透明背景上那部分）。
       * inkN = 与底色不同的像素数，用来判断「线变淡了」还是「线变少了」。 */
      let n = 0, sumA = 0, maxA = 0, minA = 255;
      let blueMax = 0, chromaSum = 0, chromaMax = 0, inkN = 0;
      let darkN = 0, darkASum = 0, darkAMax = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], bb = d[i + 2], a = d[i + 3];
        if (a <= 8) continue;
        const L = 0.299 * r + 0.587 * gg + 0.114 * bb;
        const ch = Math.max(r, gg, bb) - Math.min(r, gg, bb);
        const bd = bb - r;
        if (!(r > 250 && gg > 250 && bb > 250)) inkN++;
        if (L < 80) { darkN++; darkASum += a; if (a > darkAMax) darkAMax = a; }
        if (ch > chromaMax) chromaMax = ch;
        if (bd > blueMax) blueMax = bd;
        /* 蓝线判据放宽到 8：40% 时线变淡，不能因为这个把像素漏掉 */
        if (pick === 'blue' && bd <= 8) continue;
        n++; sumA += a; chromaSum += ch;
        if (a > maxA) maxA = a;
        if (a < minA) minA = a;
      }
      const div = n || 1;
      const corner = d[((img.naturalHeight > 8 ? 6 : 0) * c.width + 6) * 4 + 3];
      return {
        n, inkN,
        meanA: Math.round(sumA / div), maxA, minA,
        blueMax,
        chroma: Math.round(chromaSum / div), chromaMax,
        darkN,
        darkA: darkN ? Math.round(darkASum / darkN) : 0,
        darkAMax,
        corner, err: g.layerErr || null
      };
    }, [DATA, opts, pick]);
    const png = await page.evaluate(async ([src, o]) => {
      const g = await Model3D.viewGrid(src, o);
      return g.png;
    }, [DATA, opts]);
    if (png) {
      fs.writeFileSync(path.join(OUT, 'op-' + name + '.png'),
        Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    }
    console.log('  ' + name.padEnd(14) + JSON.stringify(r));
    return r;
  };

  const V = { views: ['iso'], cell: 360, transparent: true };
  const BLUE = '#1e6fe0';

  console.log('\n=== 3D 层：线框 ===');
  const w1 = await run('wire-100', Object.assign({ mode: 'solid', wire: true, lineColor: BLUE, layerOpacity: { wire: 1 } }, V), 'blue');
  const w4 = await run('wire-40', Object.assign({ mode: 'solid', wire: true, lineColor: BLUE, layerOpacity: { wire: 0.4 } }, V), 'blue');

  console.log('\n=== 3D 层：UV 岛色 ===');
  const i1 = await run('island-100', Object.assign({ mode: 'shaded', wire: false, uvIsland: true, layerOpacity: { uvisland: 1 } }, V), 'ink');
  const i3 = await run('island-30', Object.assign({ mode: 'shaded', wire: false, uvIsland: true, layerOpacity: { uvisland: 0.3 } }, V), 'ink');

  console.log('\n=== 2D 层：外轮廓（逐行 fillRect，测有没有叠加加深） ===');
  const o1 = await run('outline-100', Object.assign({ mode: 'solid', wire: false, outline: true, layerOpacity: { outline: 1 } }, V), 'ink');
  const o5 = await run('outline-50', Object.assign({ mode: 'solid', wire: false, outline: true, layerOpacity: { outline: 0.5 } }, V), 'ink');

  console.log('\n=== 2D 层：深度灰（整幅 ImageData，globalAlpha 对它无效） ===');
  const g1 = await run('dgray-100', Object.assign({ mode: 'shaded', wire: false, depthGray: true, depthGrayBg: '#000000', layerOpacity: { dgray: 1 } }, V), 'ink');
  const g5 = await run('dgray-50', Object.assign({ mode: 'shaded', wire: false, depthGray: true, depthGrayBg: '#000000', layerOpacity: { dgray: 0.5 } }, V), 'ink');

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  console.log('\n=== 断言 ===');
  check(errs.length === 0, '页面零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(!w1.err && !o1.err && !g1.err, '图层没有抛错', JSON.stringify({ w: w1.err, o: o1.err, g: g1.err }));

  /* 线框：白底上的蓝线。用「最饱和像素的蓝度」比均值稳——抗锯齿边缘会把均值带偏 */
  check(w1.blueMax > 180, '100% 时线是饱和的蓝', 'blueMax=' + w1.blueMax);
  check(w4.inkN > w1.inkN * 0.9, '调低不透明度不会让线变少（只是变淡）', w1.inkN + ' → ' + w4.inkN);
  /* 3D 是逐图元混合：同一条棱被相邻两个面各画一次，40% 会叠成 1-(1-0.4)² = 64%。
   * 所以这里只要求「明显变淡」并留出这条上限；真要精确就得每层渲到 RT 再合成。 */
  const wRatio = w4.blueMax / w1.blueMax;
  check(wRatio > 0.45 && wRatio < 0.78, '线框 40% → 线明显变淡（3D 逐图元混合，重叠处约 6 成半）',
    w1.blueMax + ' → ' + w4.blueMax + '（' + wRatio.toFixed(2) + '）');

  /* 岛色：彩度跟不透明度成正比 */
  check(i1.chroma > 60, '100% 时岛色是饱和的', 'chroma=' + i1.chroma);
  check(near(i3.chroma / i1.chroma, 0.3, 0.14), '岛色 30% → 彩度约为 3 成',
    i1.chroma + ' → ' + i3.chroma);

  /* 外轮廓：线一半落在白面上、一半落在透明背景上。
   * 落在透明处的那部分（暗像素）直接反映这层的 alpha —— 100% 实心、50% 半透明。 */
  check(o1.darkN > 200 && o1.darkA > 240, '100% 时外轮廓是不透明的黑',
    'dark=' + o1.darkN + ' a=' + o1.darkA);
  /* 外轮廓正好画在模型 alpha 边界上，那里底下本来就有半透明的边缘像素，
   * 所以合成后的 alpha 会略高于 128（0.5 + 边缘 0.25 × 0.5 ≈ 0.63）。 */
  check(o5.darkA > 100 && o5.darkA < 200, '外轮廓 50% → 线本身变成半透明',
    o1.darkA + ' → ' + o5.darkA);
  /* 重点：逐笔 globalAlpha 会在相邻行重叠处叠深 —— 那样「均值和最大值」会拉开差距。
   * 整层合成的结果是同一条线上处处一样浅。 */
  check(o5.darkAMax - o5.darkA < 12, '同一条线处处一样半透明（整层合成，不是逐笔压 alpha）',
    'mean=' + o5.darkA + ' max=' + o5.darkAMax);

  /* 深度灰：整幅铺 ImageData，globalAlpha 对它无效，必须走离屏合成 */
  check(g1.corner === 255, '100% 时深度灰的远景色不透明', 'corner=' + g1.corner);
  check(near(g5.corner, 128, 12), '深度灰 50% → 背景（无限远）也变成半透明', 'corner=' + g5.corner);
  /* 深度灰现在跟别的 2D 层一样是「alpha 合成」：它是**盖在**已有画面上的一层，
   * 所以底下模型本体仍然是不透明的（alpha 255），变的只是盖上去的灰有多浓。
   * 真正变 alpha 的是**透明背景**那一块（角落），那里从 255 掉到 ~128。 */
  check(g5.maxA === 255, '深度灰 50% 不改变底下模型本体的不透明度（它是盖上去的一层）',
    'max=' + g5.maxA);
  check(near(g5.minA, 128, 12), '深度灰 50% → 透明底那一块的 alpha 变成一半（盖上去时 alpha 被拉低）',
    'min=' + g5.minA);

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
