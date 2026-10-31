/* 探针：多视图「角度线框」的粗细 / 随角度渐变 / 颜色（像素级）
 * 用法：node tools/probe-mv-crease.js
 * 产物：tools/shots/crease-*.png
 *
 * 场景用一段**折扇**（4 片薄面，相邻夹角 25° / 45° / 75°）：
 * 立方体做不到这件事——它全是 90°，"随角度变粗"在 90° 上退化成"全都一样粗"，
 * 测了也看不出滑条有没有接线。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');

/* 折扇：angles 是相邻两片的夹角（度）。返回 OBJ 文本。
 * 顶点按「每条折边两个点（下/上）」排，面按统一绕序生成，法线才都朝同一侧
 * ——否则相邻面法线反向，折角会被算成 180-angle，阈值一筛就乱。 */
function fan(angles, w, h) {
  const pts = [{ x: 0, z: 0 }];
  let a = 0;
  for (const deg of angles) {
    a += deg * Math.PI / 180;
    const p = pts[pts.length - 1];
    pts.push({ x: p.x + Math.cos(a) * w, z: p.z + Math.sin(a) * w });
  }
  const L = [];
  for (const p of pts) {
    L.push('v ' + p.x.toFixed(5) + ' 0 ' + p.z.toFixed(5));
    L.push('v ' + p.x.toFixed(5) + ' ' + h + ' ' + p.z.toFixed(5));
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const b0 = 2 * i + 1, t0 = 2 * i + 2, t1 = 2 * i + 4, b1 = 2 * i + 3;
    L.push('f ' + [b0, t0, t1, b1].join(' '));
  }
  return L.join('\n') + '\n';
}

const OBJ = fan([25, 45, 75], 2.2, 1.6);
const DATA = 'data:text/plain;base64,' + Buffer.from(OBJ).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const run = async (name, opts) => {
    const r = await page.evaluate(async ([src, o]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0, opaque = 0, red = 0, dark = 0;
      let rSum = 0, gSum = 0, bSum = 0, nInk = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        opaque++;
        /* 素模是浅灰（打光后 >170），所以「不是浅灰」的像素就是线 */
        if (!(d[i] > 150 && d[i + 1] > 150 && d[i + 2] > 150)) {
          ink++;
          rSum += d[i]; gSum += d[i + 1]; bSum += d[i + 2]; nInk++;
          if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
          else dark++;
          continue;
        }
      }
      return {
        ink, opaque, red, dark,
        avg: nInk ? [Math.round(rSum / nInk), Math.round(gSum / nInk), Math.round(bSum / nInk)] : null,
        crease: g.crease, png: g.png
      };
    }, [DATA, opts]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'crease-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(12) + 'ink=' + String(r.ink).padEnd(6) +
      'avg=' + JSON.stringify(r.avg) + '  ' + JSON.stringify(r.crease));
    return r;
  };

  /* 纯色白面（solid）+ 角度线框：素模有背光的暗面，会把「深灰」和「线」混在一起，
   * 白面才分得清。阈值 0 让 25/45/75 三条折边全留下 */
  const V = {
    views: ['iso'], cell: 480, mode: 'solid', wire: false, wireAngle: true, wireAngleDeg: 0,
    transparent: true, lineWidth: 1.4
  };
  console.log('\n=== 折扇（25°/45°/75°）· 轴测 ===');
  const base = await run('base', Object.assign({ creaseScale: 1, creaseTaper: 0, creaseColor: '#2b2b2b' }, V));
  const fat = await run('scale2', Object.assign({ creaseScale: 2, creaseTaper: 0, creaseColor: '#2b2b2b' }, V));
  const fat3 = await run('scale3', Object.assign({ creaseScale: 3, creaseTaper: 0, creaseColor: '#2b2b2b' }, V));
  const taper0 = await run('taper0', Object.assign({ creaseScale: 1, creaseTaper: 0, creaseColor: '#2b2b2b' }, V));
  const taper0b = await run('taper0-16', Object.assign({ creaseScale: 1.6, creaseTaper: 0, creaseColor: '#2b2b2b' }, V));
  const taper100 = await run('taper100', Object.assign({ creaseScale: 1.6, creaseTaper: 1, creaseColor: '#2b2b2b' }, V));
  const blue = await run('blue', Object.assign({ creaseScale: 2, creaseTaper: 0, creaseColor: '#1a6dff' }, V));
  const redC = await run('red', Object.assign({ creaseScale: 2, creaseTaper: 0, creaseColor: '#ff2020' }, V));
  /* 回归：普通线框不该被 creaseColor 带着变色 */
  const plain = await run('plain-wire', {
    views: ['iso'], cell: 480, mode: 'solid', wire: true, wireAngle: false,
    transparent: true, lineWidth: 1.4, creaseColor: '#ff2020'
  });

  let fails = 0;
  const check = (ok, name, extra) => {
    console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
    if (!ok) fails++;
  };
  console.log('\n=== 断言 ===');
  check(errs.length === 0, '页面零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(base.crease && base.crease.drawn, '角度线框画出来了', JSON.stringify(base.crease));
  check(base.crease.edges >= 3, '25°/45°/75° 三条折边都在（含边界边更多）', String(base.crease.edges));

  /* 粗细：整体倍率 */
  check(fat.ink > base.ink * 1.3, '粗细 2× → 线的像素明显变多', base.ink + ' → ' + fat.ink);
  check(fat3.ink > fat.ink * 1.2, '粗细 3× → 继续变多', fat.ink + ' → ' + fat3.ink);

  /* 随角度：**同倍率**下对比才说明问题——总墨水少掉的那部分，
   * 只能来自「折角小的边被调细了」。 */
  check(taper100.ink < taper0b.ink * 0.85, '同 1.6× 下，开「随角度」后总墨水明显变少（细边省下来了）',
    'taper0=' + taper0b.ink + ' taper100=' + taper100.ink);
  check(taper100.ink > taper0.ink, '1.6× + 随角度 仍比 1.0× 等宽粗（渐变没有把线压没）',
    taper0.ink + ' → ' + taper100.ink);

  /* 颜色 */
  /* 余下的 dark 是抗锯齿边缘（红线掺白变成粉红，G/B 落在 90~170 之间不算纯红），
   * 所以这里留 30% 的余量，判的是「主体已经是红」而不是「一个灰像素都没有」 */
  check(redC.red > 300 && redC.dark < redC.ink * 0.3, '换成红色 → 线真的是红的',
    'red=' + redC.red + ' dark=' + redC.dark + '/' + redC.ink);
  check(blue.avg && blue.avg[2] > blue.avg[0] + 40, '换成蓝色 → 线偏蓝（B 通道最高）',
    JSON.stringify(blue.avg));
  check(plain.dark > 500 && plain.red === 0, '普通线框不受角度线色影响（仍是深灰）',
    'dark=' + plain.dark + ' red=' + plain.red);

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
