/* 探针：背景层永远在最底下（用户报「背景图层总是显示在最上面」）
 * 用法：node tools/probe-mv-bg.js
 * 产物：tools/shots/mv-bg-*.png
 *
 * 背景层是「底色」：它一旦压在模型上面，模型就整块被盖掉，
 * 用户看到的是「模型不见了」，而不是「层序不对」。
 * 所以它跟后期处理层（grade，永远在最上）对称，做成**固定位**：
 *   渲染核：LAYER_TABLE 里 bottom:true → orderedLayers 强制甩到序列开头
 *   App 端：LAYER_META.bg.fixed='bottom' → 不可拖、带「底」锁标
 *   存档：normalizeLayerOrder 强制 unshift 到最前
 *
 * 这个探针把「背景在最底」从五个角度各验一遍（缺一不可）：
 *   ① 渲染核层序：layers[0] 必须是 bg
 *   ② 画面像素：角落是背景色、中心是模型色（背景没盖住模型）
 *   ③ 图层面板行序：背景那一行必须在最后一行（最底）
 *   ④ 导出 PNG：导出走的是 renderOpts(pass, layout)，layout 分支单独验
 *   ⑤ 老存档：缺 bg / bg 写错位置的存档都要收敛到「背景在最底」
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');

/* 立方体（每面独立 UV，岛色能画出来） */
const V8 = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const F6 = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
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

/* 老版本的默认顺序（没有背景层 / 没有后期处理层） */
const OLD = ['uvisland', 'wire', 'crease', 'uvseam', 'dgray', 'outline', 'dedge', 'labels'];

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  /* 在页面里渲一张图，量角落 / 中心像素
   * ⚠ 采样点必须落在**某���格内部**：两格图的正中正好是格间距（那里本来就是背景色），
   * 取整张图的正中会误判成「模型被背景盖住了」。 */
  const render = async (name, opts) => {
    const r = await page.evaluate(async ([src, o]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const at = (px, py) => Array.from(cx.getImageData(px, py, 1, 1).data);
      /* 第一格的中心（cell 0 在左上角，格间距在右/下） */
      const cell = g.cells && g.cells[0] ? g.cells[0] : { x: 0, y: 0, w: c.width, h: c.height };
      return {
        layers: g.layers,
        err: g.layerErr || null,
        w: c.width, h: c.height,
        corner: at(3, 3),
        center: at(Math.floor(cell.x + cell.w / 2), Math.floor(cell.y + cell.h / 2)),
        png: g.png
      };
    }, [DATA, opts]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'mv-bg-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(16) + JSON.stringify({
      layers: r.layers, corner: r.corner, center: r.center
    }));
    return r;
  };

  const base = {
    views: ['iso'], cell: 300, mode: 'shaded', transparent: true,
    bg: true, bgColor: '#ff0000', wire: true
  };

  console.log('\n=== ① 渲染核层序：背景必须是第一层 ===');
  const r1 = await render('normal', Object.assign({}, base));
  const r2 = await render('bg-last', Object.assign({}, base, {
    /* 故意把 bg 写到顺序最后：渲染核必须把它拉回最底 */
    layerOrder: ['wire', 'uvisland', 'bg', 'crease', 'uvseam', 'outline', 'dedge', 'labels', 'grade']
  }));
  const r3 = await render('old-order', Object.assign({}, base, {
    /* 老存档：压根没有 bg 这一层 → 渲染核要按表里的默认位置插回去（最底，不是最上） */
    layerOrder: OLD
  }));

  console.log('\n=== ④ 导出路径（layout 分支） ===');
  const r4 = await render('export', Object.assign({}, base, {
    views: ['front', 'back'], cols: 2, gap: 16, labels: false
  }));

  console.log('\n=== ② 画面像素：背景色在角落、模型在中心 ===');
  /* 判据不是「模型是某个具体灰度」（光照/视角一变灰度就变），而是两条否定：
   *   中心**不是**背景色  → 背景没把模型盖住
   *   中心**不是**纯白    → 老存档缺层时那种「白底盖死模型」的回归 */
  const isRed = p => p[0] > 200 && p[1] < 60 && p[2] < 60;
  const isWhite = p => p[0] > 250 && p[1] > 250 && p[2] > 250;
  const modelVisible = p => p[3] > 200 && !isRed(p) && !isWhite(p);

  console.log('\n=== ⑤ 存档归一化 ===');
  const norm = await page.evaluate((old) => {
    const N = multiview._pure.normalizeLayerOrder;
    return {
      old: N(old),
      bgLast: N(['wire', 'bg', 'uvisland']),
      bad: N(['grade', 'wire', 'uvisland', 'bg']),
      def: N([])
    };
  }, OLD);
  console.log('  归一化：', JSON.stringify(norm));

  console.log('\n=== ③ 图层面板行序（App 内） ===');
  const app = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const appErrs = [];
  app.on('pageerror', e => appErrs.push(String(e && e.message)));
  await app.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await app.waitForTimeout(900);
  /* 探针自包含：先写一份确定值再 open()（hydrate 会把服务端存档灌回 localStorage） */
  await app.evaluate(() => {
    localStorage.setItem('hf_mv_set', JSON.stringify({
      views: ['front'], mode: 'shaded', wire: true, cell: 512, labels: false, bg: true, bgColor: '#ff0000'
    }));
  });
  await app.evaluate(() => multiview.open());
  await app.waitForTimeout(600);
  const panel = await app.evaluate(() => {
    const rows = [...document.querySelectorAll('#mvLayerList .mv-ly-item')];
    const bg = rows.find(r => r.getAttribute('data-ly') === 'bg');
    return {
      rows: rows.map(r => r.getAttribute('data-ly')),
      bgIndex: rows.indexOf(bg),
      total: rows.length,
      bgDraggable: bg ? bg.getAttribute('draggable') : null,
      bgLock: !!(bg && bg.querySelector('.mv-ly-lock')),
      bgLockText: bg && bg.querySelector('.mv-ly-lock') ? bg.querySelector('.mv-ly-lock').textContent : null,
      order: multiview.state.layerOrder.slice()
    };
  });
  console.log('  面板行序：', panel.rows.join(' , '));
  console.log('  state.layerOrder：', panel.order.join(' , '));

  console.log('\n=== 断言 ===');
  check(errs.length === 0, '独立页零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(appErrs.length === 0, 'App 零报错', appErrs.slice(0, 2).join(' | ') || 'clean');
  check(!r1.err && !r2.err && !r3.err && !r4.err, '没有图层抛错',
    JSON.stringify({ r1: r1.err, r2: r2.err, r3: r3.err, r4: r4.err }));

  /* ① 渲染核层序 */
  check(r1.layers && r1.layers[0] === 'bg', '正常顺序 → bg 是第一层（最底）', String(r1.layers));
  check(r2.layers && r2.layers[0] === 'bg', '把 bg 写到顺序最后 → 渲染核仍把它拉回最底', String(r2.layers));
  check(r3.layers && r3.layers[0] === 'bg', '老存档（没有 bg）→ bg 按默认位置插回最底', String(r3.layers));
  check(r3.layers && r3.layers.indexOf('bg') < r3.layers.indexOf('wire'),
    '老存档补回的 bg 在 wire 下面（不是最上）', String(r3.layers));

  /* ② 像素 */
  check(isRed(r1.corner), '正常：角落是背景红', r1.corner.join(','));
  check(modelVisible(r1.center), '正常：中心是模型（背景没盖住模型）', r1.center.join(','));
  check(isRed(r2.corner) && modelVisible(r2.center),
    'bg 写错位置时角落仍是背景色、中心仍是模型', r2.corner.join(',') + ' / ' + r2.center.join(','));
  check(isRed(r3.corner) && modelVisible(r3.center),
    '老存档缺 bg 时：角落背景色、中心是模型（不能是纯白盖死）',
    r3.corner.join(',') + ' / ' + r3.center.join(','));

  /* ④ 导出 */
  check(r4.layers && r4.layers[0] === 'bg', '导出路径：bg 也在最底', String(r4.layers));
  check(isRed(r4.corner), '导出：角落是背景色', r4.corner.join(','));
  check(modelVisible(r4.center), '导出：格内中心是模型（背景没盖住模型）', r4.center.join(','));

  /* ⑤ 归一化 */
  check(norm.old[0] === 'bg', '老存档补齐 → bg 在最前', norm.old.join(','));
  check(norm.old[norm.old.length - 1] === 'grade', '老存档补齐 → grade 在最后', norm.old.join(','));
  check(norm.bgLast[0] === 'bg', 'bg 写在中间 → 归一化挪到最前', norm.bgLast.join(','));
  check(norm.bad[0] === 'bg' && norm.bad[norm.bad.length - 1] === 'grade',
    '乱序存档也收敛（bg 最底 / grade 最上）', norm.bad.join(','));

  /* ③ 面板 */
  check(panel.total === 10, '图层面板 10 层', String(panel.total));
  check(panel.bgIndex === panel.total - 1,
    '背景那一行在面板最后一行（= 最底）', 'index=' + panel.bgIndex + '/' + panel.total);
  check(panel.rows[0] === 'grade', '面板第一行是后期处理（= 最上）', panel.rows[0]);
  check(panel.bgDraggable === 'false', '背景层不可拖动', String(panel.bgDraggable));
  check(panel.bgLock && panel.bgLockText === '底', '背景层带「底」锁标', String(panel.bgLockText));
  check(panel.order[0] === 'bg', 'state.layerOrder 第一项是 bg（绘制顺序最底）', panel.order.join(','));

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
