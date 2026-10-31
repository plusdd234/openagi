/* 探针：多视图「深度灰」（模型表面到相机的距离 → 灰度）
 * 用法：node tools/probe-mv-depthgray.js
 * 产物：tools/shots/depthgray-*.png
 *
 * 场景是**四条竖板，前后错开成 4 档**：
 * 正视图下就是 4 条灰度不同的竖带，越靠相机越白。
 * 比拿一个球体做场景好在「每档的期望灰度是能算出来的」，滑条一动就知道偏了多少。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');

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
function merge(bs) {
  const L = []; let b = 0;
  for (const x of bs) {
    x.v.forEach(p => L.push('v ' + p.map(n => n.toFixed(4)).join(' ')));
    x.f.forEach(f => L.push('f ' + f.map(i => i + b).join(' ')));
    b += x.v.length;
  }
  return L.join('\n') + '\n';
}

/* 4 条竖板，z 从 -2 依次 +0.55 → 越靠右越靠近相机 */
const SLABS = [-2, -1.45, -0.9, -0.35];
const OBJ = merge(SLABS.map((z, i) => box([-1.5 + i * 1.0, 0, z], [0.7, 3.2, 0.12])));
const DATA = 'data:text/plain;base64,' + Buffer.from(OBJ).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const run = async (name, opts, probes) => {
    const r = await page.evaluate(async ([src, o, xs]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      const mid = Math.floor(c.height / 2);
      const pick = xs.map(fx => {
        const x = Math.round(c.width * fx);
        const i = (mid * c.width + x) * 4;
        return { x: fx, r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
      });
      /* 纯灰？把整幅里所有不透明像素的 RGB 一致性数一遍 */
      let grayOk = 0, grayBad = 0, black = 0, opaque = 0, red = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        opaque++;
        if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) { black++; continue; }
        if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
        if (d[i] === d[i + 1] && d[i + 1] === d[i + 2]) grayOk++; else grayBad++;
      }
      /* 角上一定是背景 */
      const corner = [d[0], d[1], d[2], d[3]];
      return { pick, corner, grayOk, grayBad, black, opaque, red, dg: g.depthGray, w: c.width, png: g.png };
    }, [DATA, opts, probes]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'depthgray-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(12) + 'gray=' + JSON.stringify(r.pick.map(p => p.r)) +
      '  corner=' + JSON.stringify(r.corner) + '  bad=' + r.grayBad + '  red=' + r.red);
    return r;
  };

  /* 四条竖带的中心在画面里的横向比例：视锥宽 3.7×1.08≈4.0，板心 x=-1.5/-0.5/0.5/1.5 */
  const XS = [0.125, 0.375, 0.625, 0.875];
  const V = { views: ['front'], cell: 480, mode: 'shaded', wire: false, transparent: true };

  console.log('\n=== 四档深度 · 正视图 ===');
  const off = await run('off', Object.assign({ depthGray: false }, V), XS);
  const on = await run('on', Object.assign({ depthGray: true, depthGrayRange: 1 }, V), XS);
  const half = await run('range50', Object.assign({ depthGray: true, depthGrayRange: 0.5 }, V), XS);
  const narrow = await run('range15', Object.assign({ depthGray: true, depthGrayRange: 0.15 }, V), XS);
  /* 深度灰 + 角度线框：灰度是面、线是结构，两个必须同时看得见（用户报过线被盖掉） */
  const mixed = await run('gray+crease', Object.assign({
    depthGray: true, depthGrayRange: 1,
    wireAngle: true, wireAngleDeg: 0, creaseScale: 2, creaseTaper: 0, creaseColor: '#ff2020'
  }, V), XS);
  /* 深度灰 + 普通线框：走的另一条线载体（重心坐标 mesh），单独验一遍。
   * ⚠ V 必须放前面：它自带 wire:false，放后面会把这里的 wire:true 覆盖掉。 */
  const mixed2 = await run('gray+wire', Object.assign({}, V, {
    depthGray: true, depthGrayRange: 1, wire: true, lineColor: '#20a0ff'
  }), XS);

  /* 导出通道（pass='depth'）必须和屏幕上看到的是同一套算法——
   * 用户报过「导出的深度图里没有深度」，根因就是它当时还走 MeshDepthMaterial +
   * 整个视锥归一化，出来是一张几乎纯色的片。 */
  const exp = await run('export-depth', Object.assign({}, V, {
    pass: 'depth', depthGray: false, transparent: false
  }), XS);

  /* 无限远处的颜色 */
  const bgWhite = await run('bg-white', Object.assign({}, V, {
    depthGray: true, depthGrayRange: 1, depthGrayBg: '#ffffff'
  }), XS);
  const bgGray = await run('bg-gray', Object.assign({}, V, {
    depthGray: true, depthGrayRange: 1, depthGrayBg: '#808080'
  }), XS);

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  console.log('\n=== 断言 ===');
  const g0 = on.pick.map(p => p.r);
  check(errs.length === 0, '页面零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(!off.dg && off.pick[0].r > 100, '不勾时还是原色（不是灰度）', JSON.stringify(off.pick.map(p => p.r)));
  check(!!on.dg, '勾上后渲染核报告 depthGray', JSON.stringify(on.dg));
  check(on.grayBad === 0, '整幅没有「带彩的」像素（R=G=B）', 'bad=' + on.grayBad);
  check(on.corner[0] === 0 && on.corner[3] === 255, '背景是黑底（不透明）', JSON.stringify(on.corner));
  /* 四条带由远到近，灰度必须单调递增（近 = 白） */
  const mono = g0[0] < g0[1] && g0[1] < g0[2] && g0[2] < g0[3];
  check(mono, '越靠近相机的板越白（4 档单调）', g0.join(' < '));
  check(g0[3] > 200, '最近那档接近纯白', 'g=' + g0[3]);
  check(g0[0] < 60, '最远那档接近纯黑', 'g=' + g0[0]);

  /* 滑条：窗口收窄 → 远景被压黑，近景仍是白 */
  const g50 = half.pick.map(p => p.r);
  const g15 = narrow.pick.map(p => p.r);
  check(g50[0] <= g0[0] + 4 && g50[1] < g0[1], '范围收到 50% → 中远档变暗',
    g0.slice(0, 3).join(',') + ' → ' + g50.slice(0, 3).join(','));
  check(g50[3] > 200, '范围收到 50% → 最近一档还是白', 'g=' + g50[3]);
  check(g15[0] === 0 && g15[1] === 0, '范围收到 15% → 前两档全黑', g15.slice(0, 3).join(','));
  check(g15[3] > 200, '范围收到 15% → 最近一档仍能看清', 'g=' + g15[3]);
  check(g15[2] < g50[2], '范围越窄中间档越暗（滑条是连续的）', g50[2] + ' → ' + g15[2]);

  /* 线不能被灰度盖掉 */
  check(mixed.red > 200, '深度灰之上仍看得见角度线框（红色线还在）', 'red=' + mixed.red);
  check(mixed.grayBad > 200, '线是上了色的，不是被灰度吞掉', 'bad=' + mixed.grayBad);
  const m2 = mixed2.pick.map(p => p.b);
  check(mixed2.grayBad > 200, '深度灰 + 普通线框也叠得上（重心坐标那层）',
    'bad=' + mixed2.grayBad + ' b=' + m2.join(','));

  /* 导出的深度图应当和「深度灰」逐档一致（同一份线性深度 + 同一套归一化） */
  const e = exp.pick.map(p => p.r);
  check(e.join(',') === g0.join(','), '导出深度图的灰度档位与屏幕上的深度灰一致',
    e.join(',') + ' vs ' + g0.join(','));
  check(exp.grayBad === 0, '导出深度图是纯灰度（没有彩色混进来）', 'bad=' + exp.grayBad);
  check(exp.corner[0] === 0 && exp.corner[3] === 255, '导出深度图黑底不透明', JSON.stringify(exp.corner));

  /* 「无限远」的颜色可调：背景 + 格间距都跟着它走，模型表面不受影响 */
  check(bgWhite.corner[0] === 255 && bgWhite.corner[1] === 255 && bgWhite.corner[2] === 255,
    '远景色设白 → 背景就是白', JSON.stringify(bgWhite.corner));
  check(bgWhite.grayBad === 0, '远景色设白 → 模型表面仍是纯灰度（没被背景色染）', 'bad=' + bgWhite.grayBad);
  check(Math.abs(bgGray.corner[0] - 128) <= 2, '远景色设灰 → 背景就是那个灰',
    JSON.stringify(bgGray.corner));
  check(bgWhite.pick.map(p => p.r).join(',') === g0.join(','),
    '换远景色不影响模型表面的灰度档位', bgWhite.pick.map(p => p.r).join(','));

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
