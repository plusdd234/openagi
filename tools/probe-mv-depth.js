/* 探针：多视图「深度描边」（像素级）
 * 用法：node tools/probe-mv-depth.js
 * 产物：tools/shots/mv-depth-*.png
 *
 * 场景刻意用**两个前后错开的盒子**，看正视图：小盒子挡在大盒子中间。
 * 这时画面上只有一条「小盒子的外框」——它是物体**内部**的遮挡边界，
 * 剪影描边（outline）永远拿不到，只有深度差能看见。这正是这个开关的判据：
 *   关掉 → 一条线都没有（纯色白面，画面全白）
 *   打开 → 小盒子四周出现一圈线
 *   阈值调大 → 线变少（只剩最强的边）
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');

/* 一个轴对齐盒子：c=中心，s=尺寸 */
function box(c, s) {
  const [cx, cy, cz] = c, [sx, sy, sz] = s.map(v => v / 2);
  const v = [
    [cx - sx, cy - sy, cz - sz], [cx + sx, cy - sy, cz - sz],
    [cx + sx, cy + sy, cz - sz], [cx - sx, cy + sy, cz - sz],
    [cx - sx, cy - sy, cz + sz], [cx + sx, cy - sy, cz + sz],
    [cx + sx, cy + sy, cz + sz], [cx - sx, cy + sy, cz + sz]
  ];
  const f = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
  return { v, f };
}

/* 拼成一份 OBJ；后面的盒子索引要整体偏移 */
function merge(boxes) {
  const lines = [];
  let base = 0;
  for (const b of boxes) {
    b.v.forEach(p => lines.push('v ' + p.map(n => n.toFixed(4)).join(' ')));
    b.f.forEach(f => lines.push('f ' + f.map(i => i + base).join(' ')));
    base += b.v.length;
  }
  return lines.join('\n') + '\n';
}

const OBJ = merge([
  box([0, 0, -2], [4, 4, 1]),     // 后面的大板
  box([0, 0, 0.5], [1.6, 1.6, 1]) // 前面的小盒子（正视图里挡在中间）
]);
const DATA = 'data:text/plain;base64,' + Buffer.from(OBJ).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));
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
      let dark = 0, opaque = 0;
      /* 只看每条横线的**中间行**：正视图下面就是两条水平线（小盒子的上下边）
       * 加两条竖线。中间行的暗像素数 ≈ 两条竖线的宽度 → 最干净的量。 */
      const midRow = Math.floor(c.height / 2);
      let midDark = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (midRow * c.width + x) * 4;
        if (d[i + 3] < 8) continue;
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) midDark++;
      }
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        opaque++;
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
      }
      return { dark, opaque, midDark, depthEdge: g.depthEdge, w: c.width, png: g.png };
    }, [DATA, opts]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'mv-depth-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(14) + JSON.stringify(r));
    return r;
  };

  /* 纯色白面 + 不画线框 + 不画外轮廓：画面里除了深度描边不该有别的黑 */
  const V = { views: ['front'], cell: 320, mode: 'solid', wire: false, outline: false, transparent: true };
  console.log('\n=== 前视图 · 前后两个盒子 · 纯色 ===');
  const off = await run('off', Object.assign({ depthEdge: false }, V));
  const on = await run('on-40', Object.assign({ depthEdge: true, depthEdgeThresh: 40 }, V));
  const loose = await run('on-100', Object.assign({ depthEdge: true, depthEdgeThresh: 100 }, V));
  const tight = await run('on-0', Object.assign({ depthEdge: true, depthEdgeThresh: 0 }, V));

  console.log('\n=== 多视图 · 2×2（每格各自描，不串门） ===');
  await run('quad', {
    views: ['front', 'back', 'left', 'right'], cell: 240, cols: 2,
    mode: 'solid', wire: false, outline: false, transparent: true,
    depthEdge: true, depthEdgeThresh: 40
  });

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  console.log('\n=== 断言 ===');
  check(off.depthEdge === false, '不勾时渲染核不报 depthEdge', String(off.depthEdge));
  check(off.dark < 200, '不勾时画面上没有线（纯色白面）', 'dark=' + off.dark);
  check(on.depthEdge && on.depthEdge.hits > 0, '勾上时渲染核报告命中的边数', JSON.stringify({hits:on.depthEdge&&on.depthEdge.hits, silhouette:on.depthEdge&&on.depthEdge.silhouette}));
  check(on.dark > off.dark + 400, '勾上后挡住的地方出现内部线', off.dark + ' → ' + on.dark);
  check(on.midDark >= 2, '中线行上能扫到竖边（小盒子左右两条）', 'midDark=' + on.midDark);
  check(tight.dark >= on.dark, '阈值调到最小 → 线只会更多', tight.dark + ' vs ' + on.dark);
  check(loose.dark < on.dark, '阈值调到最大 → 线变少（只留最强边）', on.dark + ' → ' + loose.dark);
  check(loose.dark < tight.dark * 0.8, '滑条对整个量级有控制力', tight.dark + ' → ' + loose.dark);
  check(on.opaque > 20000, '面仍然实心（描边没把模型擦掉）', 'opaque=' + on.opaque);

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
