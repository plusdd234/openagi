/* 探针：多视图「深度描边」在**真实模型**上的观感（像素级）
 * 用法：node tools/probe-mv-depth-real.js
 * 可选：MV_MODEL=assets/models/xxx.obj node tools/probe-mv-depth-real.js
 * 产物：tools/shots/real-depth-*.png
 *
 * 为什么还要单独测一遍：合成盒子只验证「逻辑对不对」，验证不了「糊不糊」。
 * 模型库里的模型是 AI 生成的，普遍有重叠面片、薄片头发、双层裙摆——
 * 这类几何在深度上有大量像素级跳变，早期版本会把整个模型涂成黑块。
 * 判据就是：默认阈值下暗像素占比要落在「有结构线但不糊」的区间。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'shots');
const LANE = process.env.MV_MODEL || 'assets/models/mvvjq461-74f758de.obj';

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const buf = fs.readFileSync(path.join(ROOT, LANE));
  const DATA = 'data:application/octet-stream;base64,' + buf.toString('base64');
  console.log('模型 ' + LANE + ' · ' + (buf.length / 1048576).toFixed(1) + 'MB');

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(ROOT, 'multiview.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const shot = async (name, opts) => {
    const r = await page.evaluate(async ([src, o]) => {
      const g = await Model3D.viewGrid(src, o);
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = g.png; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      /* 暗像素 = 描出来的线。素模本身是浅灰（#c2c9d6 打光后 >170），
       * 所以「<90」这个阈值只吃线，不吃面。 */
      let dark = 0, opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        opaque++;
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
      }
      return { dark, opaque, rate: opaque ? dark / opaque : 0, de: g.depthEdge, png: g.png };
    }, [DATA, opts]);
    if (r.png) {
      fs.writeFileSync(path.join(OUT, 'real-depth-' + name + '.png'),
        Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      delete r.png;
    }
    console.log('  ' + name.padEnd(12) + 'dark=' + String(r.dark).padEnd(7) +
      'opaque=' + String(r.opaque).padEnd(7) + 'rate=' + (r.rate * 100).toFixed(1) + '%');
    return r;
  };

  const V = { views: ['iso'], cell: 560, mode: 'shaded', wire: false, outline: false, transparent: true };
  console.log('\n=== 素模 · 轴测 · 560 ===');
  const off = await shot('off', Object.assign({ depthEdge: false }, V));
  const on = await shot('de40', Object.assign({ depthEdge: true, depthEdgeThresh: 40 }, V));
  const low = await shot('de0', Object.assign({ depthEdge: true, depthEdgeThresh: 0 }, V));
  const high = await shot('de100', Object.assign({ depthEdge: true, depthEdgeThresh: 100 }, V));

  console.log('\n=== 断言 ===');
  check(errs.length === 0, '页面零报错', errs.slice(0, 2).join(' | ') || 'clean');
  check(off.dark / off.opaque < 0.15, '不勾时画面干净（素模的暗面不算线）',
    (off.dark / off.opaque * 100).toFixed(1) + '%');
  check(on.dark > off.dark, '勾上后出现结构线', off.dark + ' → ' + on.dark);
  /* 这条是老版本的失败点：深度缓冲读错时整个模型被涂黑（rate ≈ 98%） */
  check(on.rate < 0.6, '默认阈值没有糊成一片（≤60% 像素是线）', (on.rate * 100).toFixed(1) + '%');
  check(on.rate > 0.08, '默认阈值确实画出了线（≥8%）', (on.rate * 100).toFixed(1) + '%');
  check(low.dark >= on.dark, '阈值拖到最左 → 线只会更多', low.dark + ' vs ' + on.dark);
  check(high.dark < on.dark, '阈值拖到最右 → 线变少', on.dark + ' → ' + high.dark);

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
