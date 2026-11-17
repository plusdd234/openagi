#!/usr/bin/env node
/* 遮挡补全：只重绘「被别的岛挡住」的那一块，再按掩膜贴回原视图
 *
 *   node tools/char3d-exp/complete.js --run <dir> [--parts hair,skirt] [--views front,back]
 *
 * 输入：
 *   gen/base_<v>.png              逐岛原画底图（取色依据）
 *   gen/H_<v>_final.png           当前四视图成品（补全的底与回投的目标）
 *   islands/<key>_<v>_holes.png   被遮挡区域（islands.js 产出）
 *   islands/<key>_<v>_silhouette.png  完整轮廓（仅用于 A/B 对照）
 *
 * 输出：
 *   gen/IS_<v>_<key>.png          该部件补全后的整视图
 *   gen/IS_<v>_final.png          该视图所有部件补全后的成品
 *   gen/bake_IS.png               2×2 四视图（反投源，交给 bake.js）
 *   complete.json                 每步的洞面积 / 实际改动像素 / 补全区与原可见区的色差
 *
 * 为什么默认用「洞」而不是「整岛轮廓」：
 *   洞是 island 轮廓减去它真正露出来的像素，正好是遮挡物占的位置；
 *   把整岛贴回去会把这些像素从别的岛手里抢走（前视裙摆 1267px、头发 854px），
 *   那些岛在 bake 里也要从这张图取色，等于用裙摆涂掉了盖在它前面的头发。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { ROOT } = require('../probe-run');
const comfy = require('./comfy');

const MODEL = path.join(ROOT, 'assets/models/mwdkldbx-8417b5c6.obj');
const PX = 512;

const NEG = 'lowres, worst quality, bad anatomy, bad hands, bad fingers, extra digits, extra limbs, ' +
  'missing limbs, mutated, cropped, out of frame, text, watermark, signature, blurry, ' +
  'photorealistic, 3d render, dark background, multiple views, sketch, monochrome';

/* 洞在头发里，提示词就不要再写 portrait / face —— 那会把后脑勺或发缝画成一张脸 */
const PROMPT = {
  hair: {
    front: 'long pale green hair strands, detailed hair, cel shading, clean lineart, white background, masterpiece',
    back: 'back view, long pale green hair seen from behind, detailed hair strands, no face, ' +
      'cel shading, clean lineart, white background, masterpiece',
    neg: NEG + ', face, eyes, nose, mouth, lips, portrait'
  },
  skirt: {
    front: 'white layered frilled skirt, green lace trim, pleated hem with gold accents, ' +
      'cel shading, clean lineart, white background, masterpiece',
    back: 'back view of a white layered frilled skirt, green lace trim, pleated hem, ' +
      'cel shading, clean lineart, white background, masterpiece',
    neg: NEG
  }
};

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function runDirFromArg() {
  const r = arg('run');
  if (r) return path.resolve(r);
  const base = path.join(ROOT, '.workbuddy/runs');
  const list = fs.readdirSync(base).filter(d => /char3d-render$/.test(d)).sort();
  return path.join(base, list[list.length - 1]);
}

const b64 = u => Buffer.from(String(u).split(',')[1], 'base64');

/* 页面里的三件事：合成、改动像素计数、补全区与可见区的色差 */
const PAGE = String.raw`
window.__c3 = {
  load: u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; }),
  canvas: async u => {
    const im = await window.__c3.load(u);
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0, 512, 512);
    return c;
  },
  data: c => c.getContext('2d').getImageData(0, 0, 512, 512).data,
  compose: async (baseUrl, overUrl, maskUrl, silUrl, feather) => {
    const b = await window.__c3.canvas(baseUrl);
    const o = await window.__c3.canvas(overUrl);
    const m = await window.__c3.canvas(maskUrl);
    const sm = await window.__c3.canvas(silUrl);
    /* 白黑掩膜 → alpha 掩膜 */
    const ac = document.createElement('canvas');
    ac.width = ac.height = 512;
    const ag = ac.getContext('2d');
    ag.drawImage(m, 0, 0);
    const md = ag.getImageData(0, 0, 512, 512);
    for (let i = 0; i < md.data.length; i += 4) {
      const v = md.data[i];
      md.data[i] = md.data[i + 1] = md.data[i + 2] = 255;
      md.data[i + 3] = v;
    }
    ag.putImageData(md, 0, 0);

    const tc = document.createElement('canvas');
    tc.width = tc.height = 512;
    const tg = tc.getContext('2d');
    tg.drawImage(o, 0, 0);
    tg.globalCompositeOperation = 'destination-in';
    if (feather) tg.filter = 'blur(' + feather + 'px)';
    tg.drawImage(ac, 0, 0);

    /* 颜色回灌：补全只负责结构与明暗，色相取「同一座岛原本露出来的像素」。
     * SD 补出来的洞常偏绿 / 偏灰，逐通道增益把整块拉回岛自己的均值，
     * 洞内的相对明暗变化保留（gain 是按三个通道分别算的，不是整块涂平）。 */
    {
      /* 注意用转换后的 alpha 掩膜 ac：原掩膜已经被写成 RGB=255 的 alpha 图，
       * 直接读红通道会变成「全图都是洞」。 */
      const B = window.__c3.data(b), S = window.__c3.data(sm), HA = window.__c3.data(ac);
      let r1 = 0, g1 = 0, b1 = 0, n1 = 0;
      for (let i = 0; i < B.length; i += 4) {
        if (S[i] < 128 || HA[i + 3] > 128) continue;
        r1 += B[i]; g1 += B[i + 1]; b1 += B[i + 2]; n1++;
      }
      const td = tg.getImageData(0, 0, 512, 512);
      let r2 = 0, g2 = 0, b2 = 0, n2 = 0;
      for (let i = 0; i < td.data.length; i += 4) {
        if (td.data[i + 3] < 128) continue;
        r2 += td.data[i]; g2 += td.data[i + 1]; b2 += td.data[i + 2]; n2++;
      }
      var DBG = { n1: n1, n2: n2 };
      if (n1 && n2) {
        const gain = [(r1 / n1) / (r2 / n2), (g1 / n1) / (g2 / n2), (b1 / n1) / (b2 / n2)]
          .map(x => Math.max(0.6, Math.min(1.7, x)));
        DBG.gain = gain.map(x => +x.toFixed(2));
        DBG.vis = [r1 / n1, g1 / n1, b1 / n1].map(x => Math.round(x));
        DBG.raw = [r2 / n2, g2 / n2, b2 / n2].map(x => Math.round(x));
        for (let i = 0; i < td.data.length; i += 4) {
          if (td.data[i + 3] < 8) continue;
          td.data[i] = Math.min(255, td.data[i] * gain[0]);
          td.data[i + 1] = Math.min(255, td.data[i + 1] * gain[1]);
          td.data[i + 2] = Math.min(255, td.data[i + 2] * gain[2]);
        }
        tg.putImageData(td, 0, 0);
      }
    }

    const oc = document.createElement('canvas');
    oc.width = oc.height = 512;
    const og = oc.getContext('2d');
    og.drawImage(b, 0, 0);
    og.drawImage(tc, 0, 0);
    return { url: oc.toDataURL('image/png'), dbg: DBG };
  },
  stats: (baseUrl, doneUrl, holeUrl, silUrl) => Promise.all([
    window.__c3.canvas(baseUrl), window.__c3.canvas(doneUrl),
    window.__c3.canvas(holeUrl), window.__c3.canvas(silUrl)
  ]).then(([b, d, h, s]) => {
    const B = window.__c3.data(b), D = window.__c3.data(d), H = window.__c3.data(h), S = window.__c3.data(s);
    let hole = 0, changed = 0, n1 = 0, n2 = 0;
    let r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0;
    for (let i = 0; i < B.length; i += 4) {
      const inHole = H[i] > 128;
      const inSil = S[i] > 128;
      if (inHole) {
        hole++;
        if (Math.abs(B[i] - D[i]) + Math.abs(B[i + 1] - D[i + 1]) + Math.abs(B[i + 2] - D[i + 2]) > 6) changed++;
        r2 += D[i]; g2 += D[i + 1]; b2 += D[i + 2]; n2++;
      } else if (inSil) {
        /* 参照：同一座岛原本露出来的像素 */
        r1 += B[i]; g1 += B[i + 1]; b1 += B[i + 2]; n1++;
      }
    }
    const m1 = n1 ? [r1 / n1, g1 / n1, b1 / n1] : null;
    const m2 = n2 ? [r2 / n2, g2 / n2, b2 / n2] : null;
    const dist = m1 && m2 ? Math.hypot(m1[0] - m2[0], m1[1] - m2[1], m1[2] - m2[2]) : null;
    return { holePx: hole, changedPx: changed, visMean: m1, fillMean: m2, dist: dist == null ? null : +dist.toFixed(1) };
  })
};`;

async function main() {
  const RUN = runDirFromArg();
  const genDir = path.join(RUN, 'gen');
  const islDir = path.join(RUN, 'islands');
  const parts = arg('parts', 'hair,skirt').split(',').map(s => s.trim()).filter(Boolean);
  const views = arg('views', 'front,back').split(',').map(s => s.trim()).filter(Boolean);
  const tag = arg('tag', 'IS');
  const denoise = Number(arg('denoise', '0.85'));
  const grow = Number(arg('grow', '4'));
  const seed = Number(arg('seed', '20261113'));

  const isl = JSON.parse(fs.readFileSync(path.join(RUN, 'islands.json'), 'utf8'));
  const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  await page.goto('about:blank');
  await page.addScriptTag({ content: PAGE });

  const report = { denoise, grow, seed, steps: [], views: {} };
  const finals = {};

  for (const v of views) {
    let baseFile = path.join(genDir, 'H_' + v + '_final.png');
    if (!fs.existsSync(baseFile)) throw new Error('缺少底图 ' + baseFile);
    for (const key of parts) {
      const holeFile = path.join(islDir, key + '_' + v + '_holes.png');
      const silFile = path.join(islDir, key + '_' + v + '_silhouette.png');
      if (!fs.existsSync(holeFile)) { console.log('跳过 ' + key + '/' + v + '：没有洞掩膜'); continue; }
      const st = isl.perView[v] && isl.perView[v][key];
      if (!st || !st.holePx) { console.log('跳过 ' + key + '/' + v + '：洞面积 0'); continue; }

      const imgName = comfy.pushInput(baseFile, 'c3c_' + key + '_' + v + '_base.png');
      const mskName = comfy.pushInput(holeFile, 'c3c_' + key + '_' + v + '_holes.png');
      const pr = PROMPT[key];
      const t0 = Date.now();
      const r = await comfy.run(comfy.inpaint({
        positive: pr[v] || pr.front, negative: pr.neg,
        image: imgName, mask: mskName, denoise, seed, grow,
        prefix: 'c3_complete_' + key + '_' + v
      }));
      const outFile = path.join(genDir, tag + '_' + v + '_' + key + '_inpaint.png');
      fs.writeFileSync(outFile, comfy.readOutput(r.images[0]));

      const baseUrl = 'data:image/png;base64,' + fs.readFileSync(baseFile).toString('base64');
      const overUrl = 'data:image/png;base64,' + fs.readFileSync(outFile).toString('base64');
      const holeUrl = 'data:image/png;base64,' + fs.readFileSync(holeFile).toString('base64');
      const silUrl = 'data:image/png;base64,' + fs.readFileSync(silFile).toString('base64');
      const composed = await page.evaluate(({ b, o, m, s }) => window.__c3.compose(b, o, m, s, 1),
        { b: baseUrl, o: overUrl, m: holeUrl, s: silUrl });
      const stats = await page.evaluate(({ b, d, h, s }) => window.__c3.stats(b, d, h, s), {
        b: baseUrl, d: composed.url, h: holeUrl, s: silUrl
      });
      const outView = path.join(genDir, tag + '_' + v + '_' + key + '.png');
      fs.writeFileSync(outView, b64(composed.url));

      report.steps.push(Object.assign({ part: key, view: v, ms: Date.now() - t0 }, stats));
      console.log('[' + key + '/' + v + '] 洞 ' + stats.holePx + 'px · 改动 ' + stats.changedPx +
        'px · 补全区均值 ' + (stats.fillMean || []).map(x => x.toFixed(0)).join(',') +
        ' · 原可见区均值 ' + (stats.visMean || []).map(x => x.toFixed(0)).join(',') +
        ' · 色差 ' + stats.dist + ' · ' + (Date.now() - t0) + 'ms');
      baseFile = outView;
    }
    const finalFile = path.join(genDir, tag + '_' + v + '_final.png');
    fs.copyFileSync(baseFile, finalFile);
    finals[v] = finalFile;
    report.views[v] = path.basename(finalFile);
  }

  /* ---------- 2×2 四视图：没补全的视图沿用 H_final ---------- */
  const manifest = JSON.parse(fs.readFileSync(path.join(RUN, 'struct/manifest.json'), 'utf8'));
  const cells = manifest.cells;
  const items = [];
  for (const c of cells) {
    const f = finals[c.key] || path.join(genDir, 'H_' + c.key + '_final.png');
    items.push({
      key: c.key, x: c.x, y: c.y, w: c.w, h: c.h,
      img: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'),
      mask: 'data:image/png;base64,' + fs.readFileSync(path.join(genDir, 'in_' + c.key + '_mask.png')).toString('base64')
    });
  }
  const sheet = await page.evaluate(async items => {
    const S = 2048;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const load = u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
    for (const it of items) {
      const im = await load(it.img);
      g.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight, it.x, it.y, it.w, it.h);
    }
    /* 整张遮罩 → alpha：四格背景一次性抠掉 */
    const ac = document.createElement('canvas');
    ac.width = ac.height = S;
    const ag = ac.getContext('2d');
    for (const it of items) {
      const im = await load(it.mask);
      ag.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight, it.x, it.y, it.w, it.h);
    }
    const id = ag.getImageData(0, 0, S, S);
    for (let i = 0; i < id.data.length; i += 4) id.data[i + 3] = id.data[i];
    ag.putImageData(id, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(ac, 0, 0);
    return c.toDataURL('image/png');
  }, items);
  const sheetFile = path.join(genDir, 'bake_' + tag + '.png');
  fs.writeFileSync(sheetFile, b64(sheet));
  console.log('四视图反投源：' + sheetFile);

  fs.writeFileSync(path.join(RUN, 'complete.json'), JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
