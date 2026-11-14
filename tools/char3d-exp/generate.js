#!/usr/bin/env node
/* 阶段 2：生成对照 + 自研「语义树多分辨率」方案。
 *
 * 对照组（同一 prompt / 同一 seed / 同一采样参数，只变条件）：
 *   A  纯文本 txt2img                      — 完全没有结构条件的下限
 *   B  素模 img2img d=0.60                  — 常规「结构图当参考图」
 *   C  素模 img2img d=0.85                  — 常规的另一个极端
 *   D  语义树多分辨率（自研）
 *       ① 底图 = 模型遮罩内的语义色块（原画各节点主色）—— 几何与模型 100% 对齐
 *       ② 每个节点从**模型原生 4K 渲染**裁切生成（不是放大上一级小图）
 *       ③ 羽化掩膜贴回底图，节点外像素不动
 *       ④ 输出再按模型遮罩锁轮廓，交给反投
 *
 * 产物：gen/*.png、gen.json（条件、树、度量）、bake_B.png / bake_D.png（2×2 反投源）
 *
 * 用法：node tools/char3d-exp/generate.js --run <run目录>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { ROOT } = require('../probe-run');
const comfy = require('./comfy');
const parts = require('./parts');
const { open, b64 } = require('./imgops');

const MODEL = path.join(ROOT, 'assets/models/mwdkldbx-8417b5c6.obj');
const ART = path.join(ROOT, 'assets/images/mwf1cizg-2b7010a2.png');
const VIEWS = ['front', 'left', 'back', 'right'];
const SEED = 20261113;
const PX = 512;

const POS = 'masterpiece, best quality, anime illustration, official art, 1girl, solo, ' +
  'full body, standing, arms outstretched, white background, long pale green hair, deer antlers, ' +
  'pointy elf ears, green and white fantasy dress, corset bodice, frilled skirt, long green cape, ' +
  'green high heels, cel shading, clean lineart, detailed eyes';
const NEG = 'lowres, worst quality, bad anatomy, bad hands, bad fingers, extra digits, extra limbs, ' +
  'missing limbs, mutated, cropped, out of frame, text, watermark, signature, blurry, ' +
  'photorealistic, 3d render, dark background, multiple views, sketch, monochrome';

const HEAD_PROMPT = 'close-up portrait, anime face, pale green hair, large deer antlers, pointy elf ears, ' +
  'green eyes, detailed hair strands, cel shading, clean lineart, white background, masterpiece';
const FACE_PROMPT = 'anime face close up, green eyes with highlights, small nose, small mouth, ' +
  'clean lineart, cel shading, symmetrical, masterpiece, best quality';
const TORSO_PROMPT = 'anime character upper body, white and green corset bodice, lace trim, ' +
  'ribbon bow at chest, small green gem, puff sleeves, cel shading, clean lineart, white background';
const SKIRT_PROMPT = 'anime character lower body, white layered frilled skirt, green lace trim, ' +
  'pleated hem with gold accents, cel shading, clean lineart, white background';
const LEGS_PROMPT = 'anime legs and feet, white thigh-high stockings with green garter, ' +
  'green strappy sandals, cel shading, clean lineart, white background';
/* 背视图没有五官：正面词（portrait / anime face）会把后脑勺直接画成一张脸。
 * 同一棵树按视角换叶子，是「特征随视角继承」的最小实现。 */
const BACK_HEAD_PROMPT = 'back view of the head, long pale green hair seen from behind, ' +
  'large deer antlers, braided hair strands, no face, cel shading, clean lineart, ' +
  'white background, masterpiece';
const SIDE_HEAD_PROMPT = 'anime head in profile, side view, pale green hair, deer antlers, ' +
  'pointy elf ear, cel shading, clean lineart, white background, masterpiece';
const SIDE_FACE_PROMPT = 'anime face in profile, side view, green eye, small nose, small mouth, ' +
  'clean lineart, cel shading, white background';
const NEG_FACE = NEG + ', face, eyes, nose, mouth, lips, portrait';

function runDirFromArg() {
  const i = process.argv.indexOf('--run');
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  const base = path.join(ROOT, '.workbuddy/runs');
  const list = fs.readdirSync(base).filter(d => /char3d-render$/.test(d)).sort();
  if (!list.length) throw new Error('没有 char3d-render 运行目录，先跑 render.js');
  return path.join(base, list[list.length - 1]);
}

const clamp01 = v => Math.max(0, Math.min(1, v));

function squareRect(r) {
  const side = Math.max(r.w, r.h);
  let x = Math.round(r.x + r.w / 2 - side / 2);
  let y = Math.round(r.y + r.h / 2 - side / 2);
  const s = Math.min(side, PX);
  x = Math.max(0, Math.min(PX - s, x));
  y = Math.max(0, Math.min(PX - s, y));
  return { x, y, w: s, h: s };
}

function saveUrl(file, url) {
  fs.writeFileSync(file, b64(url));
  return file;
}

async function main() {
  const RUN_DIR = runDirFromArg();
  const structDir = path.join(RUN_DIR, 'struct');
  const genDir = path.join(RUN_DIR, 'gen');
  fs.mkdirSync(genDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(structDir, 'manifest.json'), 'utf8'));
  const runTag = path.basename(RUN_DIR).replace(/[^\w-]/g, '').slice(-10);

  /* 512 像素包围盒 */
  for (const v of VIEWS) {
    const b = manifest.profile[v].bbox;
    manifest.tree[v].bboxPx = {
      x0: Math.round(b.x0 * 0.5), x1: Math.round(b.x1 * 0.5),
      y0: Math.round(b.y0 * 0.5), y1: Math.round(b.y1 * 0.5)
    };
  }

  /* ---------- 逐视图 4K 原生结构图（一次生成，后面所有节点裁切都吃它） ---------- */
  const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const rp = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await rp.goto(pathToFileURL(path.join(ROOT, 'multiview.html')).href + '?nostore=1', { waitUntil: 'load' });
  await rp.waitForFunction(() => !!(window.Model3D && Model3D.ready && Model3D.ready()), null, { timeout: 30000 });
  const srcModel = 'data:text/plain;base64,' + fs.readFileSync(MODEL).toString('base64');
  /* 三种 4K 原生结构图：
   *   color  素模明暗        —— 老口径，img2img 的对照组
   *   mask   纯白遮罩        —— 部件投影 / 轮廓锁定
   *   line   描边 + 角度线框 —— 用户实际在视图工坊里的用法：白底、折角线、
   *          深度描边勾内部前后分界、UV 岛色 23% 淡淡铺一层分件色。
   *          这种图接近动画分镜线稿，SD 更容易当线稿来上色。 */
  const HI_PASSES = [
    ['color', { pass: 'color', mode: 'shaded', bg: true, bgColor: '#ffffff', clayColor: '#cfd3da' }],
    ['mask', { pass: 'mask', mode: 'solid' }],
    ['line', {
      pass: 'color', mode: 'solid', fillColor: '#ffffff', fillOpacity: 1,
      wire: false, wireAngle: true, wireAngleDeg: 30, creaseScale: 1, creaseTaper: 0.5,
      creaseColor: '#2b2b2b', depthEdge: true, depthEdgeThresh: 52, outline: false,
      uvIsland: true, layerOpacity: { uvisland: 0.23 },
      bg: true, bgColor: '#ffffff', labels: false
    }]
  ];
  for (const v of VIEWS) {
    for (const [suffix, opt] of HI_PASSES) {
      const file = path.join(structDir, 'hi_' + v + '_' + suffix + '.png');
      if (fs.existsSync(file)) continue;
      const png = await rp.evaluate(async ({ src, opt, v }) => {
        const r = await window.Model3D.viewGrid(src, Object.assign({}, opt, {
          views: [v], cell: 4096, cols: 1, gap: 0, labels: false
        }));
        return r.png;
      }, { src: srcModel, opt, v });
      saveUrl(file, png);
      console.log('[hi-res] ' + v + ' / ' + suffix + ' 4096 就绪');
    }
  }

  /* ---------- UV 岛 → 语义部件掩膜（借用 ModelTex.analyze + gridCameras） ---------- */
  const partsDir = path.join(RUN_DIR, 'parts');
  fs.mkdirSync(partsDir, { recursive: true });
  const pm = await parts.build(rp, srcModel, VIEWS, { size: PX, margin: 1.08 });
  for (const v of VIEWS) {
    for (const b of pm.bands) {
      saveUrl(path.join(partsDir, v + '_' + b + '.png'), pm.views[v].masks[b]);
    }
    saveUrl(path.join(partsDir, v + '_bands.png'), pm.views[v].debug);
    saveUrl(path.join(partsDir, v + '_islands.png'), pm.views[v].islandMap);
  }
  console.log('[parts] 岛 ' + pm.islands + ' / 三角 ' + pm.tris + ' / 部件 ' + pm.bands.join(','));
  await rp.close();

  /* ---------- 算子页面 ---------- */
  const loadList = [
    { name: 'color4', url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'color_4v.png')).toString('base64') },
    { name: 'mask4', url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'mask_4v.png')).toString('base64') },
    { name: 'line4', url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'line_4v.png')).toString('base64') },
    { name: 'depth4', url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'depth_4v.png')).toString('base64') },
    { name: 'art', url: 'data:image/png;base64,' + fs.readFileSync(ART).toString('base64') }
  ];
  for (const v of VIEWS) {
    loadList.push({ name: 'hi_' + v, url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'hi_' + v + '_color.png')).toString('base64') });
    loadList.push({ name: 'him_' + v, url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'hi_' + v + '_mask.png')).toString('base64') });
    loadList.push({ name: 'hl_' + v, url: 'data:image/png;base64,' + fs.readFileSync(path.join(structDir, 'hi_' + v + '_line.png')).toString('base64') });
    for (const b of pm.bands) loadList.push({ name: 'pm_' + v + '_' + b, url: pm.views[v].masks[b] });
    loadList.push({ name: 'im_' + v, url: pm.views[v].islandMap });
  }
  const ops = await open(loadList);

  const recon = {
    run: path.basename(RUN_DIR), seed: SEED, prompt: { positive: POS, negative: NEG },
    method: '', conditions: {}, metrics: {}, tree: manifest.tree,
    art: {}, native: {}, layout: manifest.layout
  };

  /* 原画包围盒 + 语义调色板 */
  const artBox = await ops.page.evaluate(() => {
    const im = window.BUF.art;
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        if (mn > 238 && mx - mn < 12) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return { x0, x1, y0, y1, w: W, h: H };
  });
  recon.art.bbox = artBox;
  recon.art.palette = await ops.palette('art', manifest.tree.front, artBox);

  /* 原画按「部件高度带」取主色：带界与 UV 岛归并用的完全同一套 */
  const BAND_Y = { feet: [0, 0.10], legs: [0.10, 0.42], hip: [0.42, 0.60], torso: [0.60, 0.795], head: [0.795, 1] };
  const bandColor = await ops.page.evaluate(({ bands, y }) => {
    const im = window.BUF.art;
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    /* 原画包围盒 */
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const i = (yy * W + xx) * 4;
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        if (mn > 238 && mx - mn < 12) continue;
        if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
        if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
      }
    }
    const BH = y1 - y0 + 1;
    const out = {};
    for (const b of bands) {
      const sy = Math.round(y0 + BH * y[b][0]), ey = Math.round(y0 + BH * y[b][1]);
      const map = {};
      for (let yy = sy; yy < ey; yy += 2) {
        for (let xx = x0; xx <= x1; xx += 2) {
          const i = (yy * W + xx) * 4;
          const r = d[i], gg = d[i + 1], bb = d[i + 2], a = d[i + 3];
          if (a < 200) continue;
          const mn = Math.min(r, gg, bb), mx = Math.max(r, gg, bb);
          if (mn > 236) continue;
          if (mx - mn < 10 && mx > 198) continue;
          const k = (r >> 4) + ',' + (gg >> 4) + ',' + (bb >> 4);
          const e = map[k] || (map[k] = { n: 0, r: 0, g: 0, b: 0 });
          e.n++; e.r += r; e.g += gg; e.b += bb;
        }
      }
      const list = Object.keys(map).map(k => map[k]).sort((A, B) => B.n - A.n);
      const hex = e => '#' + [e.r, e.g, e.b].map(v => ('0' + Math.round(v / e.n).toString(16)).slice(-2)).join('');
      out[b] = list.length ? hex(list[0]) : '#cccccc';
      /* 第二主色：主色接近白时（白裙），裙摆 / 靴子的绿会被吃掉，留一个备选 */
      out[b + '2'] = list.length > 1 ? hex(list[1]) : out[b];
    }
    return out;
  }, { bands: pm.bands, y: BAND_Y });
  recon.art.bandColor = bandColor;

  const pal = recon.art.palette;
  /* 部位剥离得到的主色。head 尤其不能用 bandColor：原画头部区域内脸占的面积
   * 比头发大，按高度带取主色拿到的是肤色，拼 "… hair" 时等于告诉模型画肤色头发。 */
  let hairHex = null;
  const colorOf = n => (n === 'head' && hairHex) ? hairHex
    : (bandColor[n] || ((pal[n] || [])[0] || {}).hex || '#cccccc');

  /* ---------- 部位剥离：UV 岛掩膜 → 原画像素 ----------
   * 原画是正面 T-pose 插画、白底，和模型正视图同一姿态；把原画包围盒归一化
   * 映射到模型包围盒，就得到与岛编号图逐像素对齐的「原画视图」artw。
   * 之后用部件掩膜直接抠像素：取色范围只落在该部件的岛内，不会被旁边的
   * 脸 / 衣服 / 背景拉偏（按岛质心取窗口做不到这一点——同一个窗口里就有脸）。 */
  const figBox = v => {
    const b = manifest.profile[v].bbox;
    return {
      x: Math.round(b.x0 * 0.5), y: Math.round(b.y0 * 0.5),
      w: Math.round((b.x1 - b.x0) * 0.5), h: Math.round((b.y1 - b.y0) * 0.5)
    };
  };

  async function warpArt(v) {
    const fb = figBox(v);
    const mirror = v !== 'front';
    const url = await ops.page.evaluate(({ artB, fb, S, mirror }) => {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, S, S);
      const dx = mirror ? S - (fb.x + fb.w) : fb.x;
      g.drawImage(window.BUF.art, artB.x0, artB.y0, artB.x1 - artB.x0 + 1, artB.y1 - artB.y0 + 1,
        dx, fb.y, fb.w, fb.h);
      return c.toDataURL('image/png');
    }, { artB: artBox, fb, S: PX, mirror });
    return saveUrl(path.join(genDir, 'artw_' + v + '.png'), url);
  }

  async function peelParts(v) {
    const info = await ops.page.evaluate(({ v, S, BANDS }) => {
      const grab = name => {
        const im = window.BUF[name];
        if (!im) throw new Error('缺少图：' + name);
        const c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d');
        g.drawImage(im, 0, 0, S, S);
        return g.getImageData(0, 0, S, S).data;
      };
      const artw = grab('artw_' + v);
      const flat = grab('flat_' + v);
      const bandMaps = BANDS.map(b => grab('pm_' + v + '_' + b));

      /* 语义三分类（与 uvSeam 同口径）：0 皮肤 / 1 头发·绿饰 / 2 白布 / 3 其它 */
      const cls = i => {
        const r = flat[i], g = flat[i + 1], b = flat[i + 2];
        if (r > g && r - b > 14) return 0;
        if (g + 4 >= r && g - b > 6) return 1;
        if (Math.max(r, g, b) - Math.min(r, g, b) <= 14 && Math.min(r, g, b) > 170) return 2;
        return 3;
      };
      const bandOf = new Int8Array(S * S).fill(-1);
      for (let i = 0; i < S * S; i++) {
        for (let k = 0; k < bandMaps.length; k++) {
          if (bandMaps[k][i * 4 + 3] > 127) { bandOf[i] = k; break; }
        }
      }
      /* 头部种子：head 带里所有非皮肤像素（发丝、鹿角、发饰） */
      const headHair = new Uint8Array(S * S);
      let headN = 0;
      for (let i = 0; i < S * S; i++) {
        if (bandOf[i] !== BANDS.indexOf('head')) continue;
        headN++;
        if (cls(i * 4) !== 0) headHair[i] = 1;
      }

      const hexOf = (r, g, b) => '#' + [r, g, b].map(x => ('0' + Math.round(x).toString(16)).slice(-2)).join('');
      /* 只统计掩膜内像素；dropSkin 让 head 带排除脸，dropWhite 排除白底/高光 */
      const paletteOf = (mask, opt) => {
        const map = {};
        let tot = 0, sr = 0, sg = 0, sb = 0;
        for (let i = 0; i < S * S; i++) {
          if (!mask[i]) continue;
          const p = i * 4;
          const r = artw[p], g = artw[p + 1], b = artw[p + 2];
          /* 直接按原画像素判肤色：flat 是量化后的色块，边界像素会被判成非皮肤 */
          if (opt.dropSkin && r > g && r - b > 14) continue;
          if (opt.dropWhite) {
            const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
            if (mn > 238 && mx - mn < 14) continue;
          }
          const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
          const e = map[k] || (map[k] = { n: 0, r: 0, g: 0, b: 0 });
          e.n++; e.r += r; e.g += g; e.b += b;
          sr += r; sg += g; sb += b; tot++;
        }
        const list = Object.keys(map).map(k => map[k]).sort((A, B) => B.n - A.n).slice(0, 6);
        return {
          px: tot,
          mean: tot ? hexOf(sr / tot, sg / tot, sb / tot) : null,
          palette: list.map(e => ({
            hex: hexOf(e.r / e.n, e.g / e.n, e.b / e.n),
            rgb: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)],
            w: +(e.n / Math.max(1, tot)).toFixed(3)
          }))
        };
      };

      /* 头发只用 head 带的非皮肤像素。
       * 试过按岛色把长发岛一起匹配进来（长发质心落在 torso/hip 带），但本角色的
       * 披风/裙摆也是同一个浅绿，颜色匹配会把整片披风涂成头发——比漏掉长发更糟。
       * 长发本来就不会和「脸」混淆（它在脸的下方），真正需要隔离的是 head 带。 */
      /* 再按原画像素过一遍：语义底图是量化色块，头带边界处会把脸/耳朵判成非皮肤，
       * 直接抠会把五官带进「头发参考」。只保留真正的浅绿发丝像素。 */
      const hair = new Uint8Array(S * S);
      let hairN = 0;
      for (let i = 0; i < S * S; i++) {
        if (!headHair[i]) continue;
        const p = i * 4;
        const r = artw[p], g = artw[p + 1], b = artw[p + 2];
        if (r > g && r - b > 14) continue;                                  // 皮肤
        const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
        if (mn > 238 && mx - mn < 14) continue;                              // 白底 / 高光
        hair[i] = 1; hairN++;
      }

      const PART_RGB = { feet: [255, 79, 216], legs: [255, 212, 0], hip: [47, 123, 255], torso: [34, 197, 94], head: [154, 160, 166] };
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        return c;
      };
      /* 纯色剥离图：头发纯红、其余部位灰；五色部件图：一部件一色 */
      const pc = mk(), qc = mk(), rc = mk();
      const pg = pc.getContext('2d'), qg = qc.getContext('2d'), rg = rc.getContext('2d');
      const pd = pg.createImageData(S, S), qd = qg.createImageData(S, S), rd = rg.createImageData(S, S);
      pg.fillStyle = '#ffffff'; pg.fillRect(0, 0, S, S);
      qg.fillStyle = '#ffffff'; qg.fillRect(0, 0, S, S);
      for (let i = 0; i < S * S; i++) {
        const p = i * 4;
        if (bandOf[i] >= 0) {
          const hex = PART_RGB[BANDS[bandOf[i]]];
          qd.data[p] = hex[0]; qd.data[p + 1] = hex[1]; qd.data[p + 2] = hex[2]; qd.data[p + 3] = 255;
          pd.data[p] = pd.data[p + 1] = pd.data[p + 2] = 217; pd.data[p + 3] = 255;
        }
        if (hair[i]) {
          pd.data[p] = 255; pd.data[p + 1] = pd.data[p + 2] = 0; pd.data[p + 3] = 255;
          qd.data[p] = 255; qd.data[p + 1] = qd.data[p + 2] = 0; qd.data[p + 3] = 255;
          rd.data[p] = artw[p]; rd.data[p + 1] = artw[p + 1];
          rd.data[p + 2] = artw[p + 2]; rd.data[p + 3] = 255;
        }
      }
      pg.putImageData(pd, 0, 0);
      qg.putImageData(qd, 0, 0);
      rg.putImageData(rd, 0, 0);
      /* 参考裁切的白底版：方便直接看图 */
      const wc = mk(), wg = wc.getContext('2d');
      wg.fillStyle = '#ffffff'; wg.fillRect(0, 0, S, S);
      wg.drawImage(rc, 0, 0);

      const bands = {};
      for (let k = 0; k < BANDS.length; k++) {
        const m = new Uint8Array(S * S);
        for (let i = 0; i < S * S; i++) if (bandOf[i] === k) m[i] = 1;
        bands[BANDS[k]] = paletteOf(m, { dropSkin: true, dropWhite: BANDS[k] === 'head' });
      }
      return {
        peelHair: pc.toDataURL('image/png'),
        peelParts: qc.toDataURL('image/png'),
        hairRef: rc.toDataURL('image/png'),
        hairRefWhite: wc.toDataURL('image/png'),
        hair: Object.assign(paletteOf(headHair, { dropSkin: true, dropWhite: true }), {
          coverage: +(hairN / Math.max(1, headN)).toFixed(3),
          headPx: headN
        }),
        bands
      };
    }, { v, S: PX, BANDS: pm.bands });

    const files = {
      peelHair: saveUrl(path.join(genDir, 'peel_' + v + '_hair.png'), info.peelHair),
      peelParts: saveUrl(path.join(genDir, 'peel_' + v + '_parts.png'), info.peelParts),
      hairRef: saveUrl(path.join(genDir, 'ref_' + v + '_hair.png'), info.hairRef),
      hairRefWhite: saveUrl(path.join(genDir, 'ref_' + v + '_hair_white.png'), info.hairRefWhite)
    };
    return { hair: info.hair, bands: info.bands, files };
  }

  /* 剥离一次，四个视图共用：front 抠原画，back 用镜像原画验证「继承头发」。 */
  await flatBase('front');
  await flatBase('back');
  const peel = {};
  for (const v of ['front', 'back']) {
    const wf = await warpArt(v);
    await ops.load([{ name: 'artw_' + v, url: 'data:image/png;base64,' + fs.readFileSync(wf).toString('base64') }]);
    peel[v] = await peelParts(v);
  }
  recon.peel = peel;
  const hairPal = peel.front.hair.palette;
  if (hairPal && hairPal.length) {
    hairHex = hairPal[0].hex;
    await ops.page.evaluate(list => { window.HAIR_REF = list; }, hairPal.map(c => c.rgb));
    /* 用剥离出的原画头发色重算底图：head 带的头发岛吸附到这些颜色，
     * 背视图中原本被判成皮肤的岛也改成头发色（特征随视角继承）。 */
    await flatBase('front');
    await flatBase('back');
  }
  console.log('[peel] hair ' + (hairHex || '-') + ' / 覆盖 ' + peel.front.hair.coverage +
    ' / 像素 ' + peel.front.hair.px + ' / 色板 ' + hairPal.map(c => c.hex + ':' + c.w).join(' '));

  /* ---------- 每视图 512 输入 ---------- */
  const inputs = {};
  for (let vi = 0; vi < VIEWS.length; vi++) {
    const v = VIEWS[vi];
    const cell = manifest.cells.find(c => c.key === v);
    for (const [suffix, src, bg] of [['color', 'color4', '#ffffff'], ['mask', 'mask4', null], ['line', 'line4', '#ffffff'], ['depth', 'depth4', '#000000']]) {
      const url = await ops.crop('in_' + v + '_' + suffix, src, cell.x, cell.y, cell.w, cell.h, PX, PX, bg);
      saveUrl(path.join(genDir, 'in_' + v + '_' + suffix + '.png'), url);
    }
    inputs[v] = {
      color: comfy.pushInput(path.join(genDir, 'in_' + v + '_color.png'), 'c3_' + runTag + '_' + v + '_color.png'),
      mask: comfy.pushInput(path.join(genDir, 'in_' + v + '_mask.png'), 'c3_' + runTag + '_' + v + '_mask.png'),
      depth: comfy.pushInput(path.join(genDir, 'in_' + v + '_depth.png'), 'c3_' + runTag + '_' + v + '_depth.png'),
      wire: comfy.pushInput(path.join(genDir, 'in_' + v + '_line.png'), 'c3_' + runTag + '_' + v + '_wire.png')
    };
    /* 线稿条件的 512 输入：直接用 4K 线稿整幅缩到 512（取景与 mask 完全一致） */
    const lineUrl = await ops.crop('in_' + v + '_lineart', 'hl_' + v, 0, 0, 4096, 4096, PX, PX, '#ffffff');
    saveUrl(path.join(genDir, 'in_' + v + '_lineart.png'), lineUrl);
    inputs[v].line = comfy.pushInput(path.join(genDir, 'in_' + v + '_lineart.png'), 'c3_' + runTag + '_' + v + '_line.png');
  }

  /* 语义底图：**逐 UV 岛去原画同位置取色**
   *
   * 岛编号图里 R/G 存的是岛 id，每个岛的屏幕质心换算成「包围盒内归一化坐标」，
   * 再到原画的同一相对位置取一个小窗口的颜色均值——绿发岛拿到绿，白裙岛拿到白，
   * 靴子拿到蓝灰。这比「一个部件一个纯色」多保留了原画的纵向配色，侧面/背面也能
   * 沾到正确的色相；窗口取均值和 3×3 中值滤波是为了压掉单岛取色的噪点。
   * 取不到有效像素（窗口里全是背景）时，退回该岛所属部件的主色兜底。
   */
  async function flatBase(v) {
    const url = await ops.page.evaluate(({ name, v, BANDS, bandColor, artB, figB, islands, S }) => {
      const map = window.BUF['im_' + v];
      const mc = document.createElement('canvas');
      mc.width = mc.height = S;
      const mg = mc.getContext('2d');
      mg.drawImage(map, 0, 0, S, S);
      const mdata = mg.getImageData(0, 0, S, S).data;

      const ac = document.createElement('canvas');
      ac.width = ac.height = S;
      const ag = ac.getContext('2d');
      ag.drawImage(window.BUF.art, 0, 0, S, S);
      const adata = ag.getImageData(0, 0, S, S).data;
      const as = S / window.BUF.art.naturalWidth;

      const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
      const fx = figB.x0 / S, fw = (figB.x1 - figB.x0) / S;
      const fy = figB.y0 / S, fh = (figB.y1 - figB.y0) / S;

      /* 原画取色：以点为中心取窗口内「有效像素」的均值。
       * 单点取色会踩到描边/高光/背景，2491 个岛各错一次就是满屏噪点。 */
      function sampleAt(ax, ay, R) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -R; dy <= R; dy++) {
          const yy = ay + dy;
          if (yy < 0 || yy >= S) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = ax + dx;
            if (xx < 0 || xx >= S) continue;
            const p = (yy * S + xx) * 4;
            if (adata[p + 3] < 200) continue;
            const mn = Math.min(adata[p], adata[p + 1], adata[p + 2]);
            const mx = Math.max(adata[p], adata[p + 1], adata[p + 2]);
            if (mn > 234) continue;                     // 白背景
            if (mx - mn < 10 && mx > 196) continue;     // 灰白高光
            r += adata[p]; g += adata[p + 1]; b += adata[p + 2]; n++;
          }
        }
        return n >= 4 ? [r / n, g / n, b / n] : null;
      }

      const table = {};
      const bandOf = {};
      for (const it of islands) {
        let nx = Math.max(0, Math.min(1, (it.cx - fx) / fw));
        const ny = Math.max(0, Math.min(1, (it.cy - fy) / fh));
        /* 侧面 / 背面的横向位置和原画对不上：往中线收，只保留纵向配色信息 */
        if (v !== 'front') nx = 0.5 + (nx - 0.5) * 0.4;
        const ax = Math.round((artB.x0 + nx * (artB.x1 - artB.x0)) * as);
        const ay = Math.round((artB.y0 + ny * (artB.y1 - artB.y0)) * as);
        let c = sampleAt(ax, ay, Math.max(3, Math.round(S * 0.012)));
        if (!c) c = sampleAt(ax, ay, Math.max(8, Math.round(S * 0.03)));
        if (!c) c = hex2rgb(bandColor[it.band] || '#cccccc');
        table[it.id] = c;
        bandOf[it.id] = it.band;
      }

      const skinOf = c => c && c[0] > c[1] && c[0] - c[2] > 14;
      /* 部位剥离得到的头发色板（原画里 head 岛内非皮肤像素的真实颜色）。
       * 按岛质心取样时，发丝内侧的岛会取到脸/耳朵的颜色；这里把 head 带的
       * 非皮肤岛全部吸附到这个色板的最近色，取色范围被限制在「头发自己的像素」里。 */
      const hairRef = window.HAIR_REF || null;
      if (hairRef && hairRef.length) {
        for (const it of islands) {
          if (it.band !== 'head') continue;
          const c = table[it.id];
          if (!c || skinOf(c)) continue;
          let best = c, bd = Infinity;
          for (const h of hairRef) {
            const d = (c[0] - h[0]) ** 2 + (c[1] - h[1]) ** 2 + (c[2] - h[2]) ** 2;
            if (d < bd) { bd = d; best = h; }
          }
          if (bd < 2500) table[it.id] = best;   // 色差 > 50 视为「不是头发」，保持原色
        }
      }

      /* 每个部件把岛色聚成 5 档（k-means，6 轮足够）。
       * 2491 个岛各带一个原始色，相邻岛差 2~3 级灰度也会被 SD 放大成噪点纹理；
       * 量化之后部件内部变成大色块，既保留原画配色又不会满屏颗粒。 */
      const QK = 5;
      const palettes = {};
      for (const b of BANDS) {
        const ids = Object.keys(bandOf).filter(id => bandOf[id] === b).map(Number);
        if (!ids.length) { palettes[b] = []; continue; }
        /* head 已经吸附到头发色板，再跑 k-means 会把肤色岛当成一个簇，
         * 把头发色心往皮肤方向拉（这正是「背视图画出脸」的配色根源）。 */
        if (b === 'head' && hairRef && hairRef.length) { palettes[b] = hairRef.slice(); continue; }
        const pts = ids.map(id => table[id]);
        const cents = [];
        for (let k = 0; k < Math.min(QK, pts.length); k++) {
          cents.push(pts[Math.floor(k * pts.length / Math.min(QK, pts.length))].slice());
        }
        for (let it = 0; it < 6; it++) {
          const sum = cents.map(() => [0, 0, 0, 0]);
          for (const p of pts) {
            let bi = 0, bd = Infinity;
            for (let k = 0; k < cents.length; k++) {
              const dr = p[0] - cents[k][0], dg = p[1] - cents[k][1], db = p[2] - cents[k][2];
              const d = dr * dr + dg * dg + db * db;
              if (d < bd) { bd = d; bi = k; }
            }
            sum[bi][0] += p[0]; sum[bi][1] += p[1]; sum[bi][2] += p[2]; sum[bi][3]++;
          }
          for (let k = 0; k < cents.length; k++) {
            if (sum[k][3]) cents[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]];
          }
        }
        palettes[b] = cents;
        for (const id of ids) {
          const p = table[id];
          let best = p, bd = Infinity;
          for (const c of cents) {
            const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
            if (d < bd) { bd = d; best = c; }
          }
          table[id] = best;
        }
      }

      /* 本视图真正可见的岛：岛编号图里有像素的才算（岛列表本身包含被挡住的岛） */
      const vis = new Set();
      for (let i = 0; i < mdata.length; i += 4) {
        if (mdata[i + 3] < 128) continue;
        vis.add(mdata[i] | (mdata[i + 1] << 8));
      }

      /* 同一块表面不该因为「哪个相机在看」而换颜色：front 真见过的岛按 id 查表。
       * 但 front 看不到的岛绝不能拿 front 的色——后脑勺的岛在 front 投影下质心
       * 落回原画脸上，取到的就是皮肤色，于是背视图被画出一张脸。
       * 这里做一次轻量「像素→特征」关联：背面独有的岛保留自己的取色，
       * 若在 head 带且被判成皮肤，则继承该带最常见的非皮肤色（头发）。 */
      if (v === 'front') {
        window.ISLCOL = table;
        window.VIS_FRONT = vis;
      } else if (window.ISLCOL) {
        const fv = window.VIS_FRONT || new Set();
        for (const it of islands) {
          if (fv.has(it.id) && window.ISLCOL[it.id]) table[it.id] = window.ISLCOL[it.id];
        }
        const headIds = islands.filter(it => it.band === 'head');
        const tint = {};
        for (const it of headIds) {
          if (!fv.has(it.id)) continue;
          const c = table[it.id];
          if (!c || skinOf(c)) continue;
          const k = c[0] + ',' + c[1] + ',' + c[2];
          tint[k] = (tint[k] || 0) + 1;
        }
        const keys = Object.keys(tint).sort((a, b) => tint[b] - tint[a]);
        /* 优先用剥离出来的原画头发主色；没有剥离结果才退回「该带最常见的非皮肤色」 */
        const hair = (hairRef && hairRef.length) ? hairRef[0]
          : (keys.length ? keys[0].split(',').map(Number) : null);
        if (hair) {
          for (const it of headIds) {
            if (fv.has(it.id)) continue;
            if (skinOf(table[it.id])) table[it.id] = hair;
          }
        }
      }

      const od = new ImageData(S, S);
      for (let i = 0; i < mdata.length; i += 4) {
        if (mdata[i + 3] < 128) continue;
        const iid = mdata[i] | (mdata[i + 1] << 8);
        const c = table[iid];
        if (!c) continue;
        od.data[i] = c[0]; od.data[i + 1] = c[1]; od.data[i + 2] = c[2];
        od.data[i + 3] = 255;
      }

      /* 岛缝：编号图在抗锯齿边缘会混出第三个 id（拿到完全无关的颜色）。
       * 先做 3×3 中值滤波吃掉这些孤立点，再补行内两段实心之间的缝——
       * 绝不越过该行最左/最右的实心像素，否则整行会被拉成横条纹。 */
      const d0 = od.data;
      const med = new Uint8ClampedArray(S * S * 4);
      med.set(d0);
      const win = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let y = 1; y < S - 1; y++) {
        for (let x = 1; x < S - 1; x++) {
          const i = (y * S + x) * 4;
          if (!d0[i + 3]) continue;
          let k = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const j = ((y + dy) * S + (x + dx)) * 4;
              win[k++] = d0[j + 3] ? d0[j + 1] : 0;  // 用绿通道选顺序足够
            }
          }
          win.sort((a, b) => a - b);
          const pick = win[4];
          /* 中值只在绿通道上选，具体 RGB 取最近的那个邻居 */
          let best = -1, bd = 1e9;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const j = ((y + dy) * S + (x + dx)) * 4;
              if (!d0[j + 3]) continue;
              const dd = Math.abs(d0[j + 1] - pick) + Math.abs(d0[j] - d0[i]) + Math.abs(d0[j + 2] - d0[i + 2]);
              if (dd < bd) { bd = dd; best = j; }
            }
          }
          if (best >= 0) {
            med[i] = d0[best]; med[i + 1] = d0[best + 1]; med[i + 2] = d0[best + 2];
          }
        }
      }
      /* 只补 ≤2px 的缝：再宽就不是「岛缝」而是真实镂空（发缝 / 手臂与身体之间），
       * 一补就会把整行连成横条纹。 */
      for (let y = 0; y < S; y++) {
        let first = -1, last = -1;
        for (let x = 0; x < S; x++) {
          if (med[(y * S + x) * 4 + 3]) { if (first < 0) first = x; last = x; }
        }
        if (first < 0) continue;
        let run = 0;
        for (let x = first; x <= last; x++) {
          const i = (y * S + x) * 4;
          if (med[i + 3]) { run = 0; continue; }
          run++;
          const nxt = (y * S + Math.min(S - 1, x + 1)) * 4;
          if (run > 2 || !med[nxt + 3]) continue;
          const j = (y * S + (x - run)) * 4;
          for (let k = 1; k <= run; k++) {
            const q = (y * S + (x - run + k)) * 4;
            med[q] = med[j]; med[q + 1] = med[j + 1]; med[q + 2] = med[j + 2]; med[q + 3] = 255;
          }
          run = 0;
        }
      }
      const out = document.createElement('canvas');
      out.width = out.height = S;
      out.getContext('2d').putImageData(new ImageData(med, S, S), 0, 0);
      const bg = document.createElement('canvas');
      bg.width = bg.height = S;
      const bgg = bg.getContext('2d');
      bgg.fillStyle = '#ffffff';
      bgg.fillRect(0, 0, S, S);
      bgg.drawImage(out, 0, 0);
      window.BUF[name] = bg;
      return bg.toDataURL('image/png');
    }, {
      name: 'flat_' + v, v, BANDS: pm.bands,
      bandColor: Object.fromEntries(pm.bands.map(b => [b, bandColor[b]])),
      artB: artBox, S: PX,
      islands: pm.views[v].islands,
      figB: (() => {
        const b = manifest.profile[v].bbox;
        return { x0: Math.round(b.x0 * 0.5), y0: Math.round(b.y0 * 0.5), x1: Math.round(b.x1 * 0.5), y1: Math.round(b.y1 * 0.5) };
      })()
    });
    return saveUrl(path.join(genDir, 'base_' + v + '.png'), url);
  }

  const prefix = 'c3/' + runTag;

  /* UV 分割硬轮廓条件图，三层线，越往外越硬：
   *   1) 语义边界（细，1px）——皮肤 / 头发+绿饰 / 白布 三类之间的界
   *      这一层回答「描边只能看出轮廓、分不出头发和身体」：先把底图按颜色
   *      剥成语义区，再只画区与区的界，所以发-脸、发-衣的界一定有线。
   *   2) 部件带边界（2px）——feet/legs/hip/torso/head 的分界
   *   3) 外轮廓（2px）——模型遮罩的边，兜底：没有它，ControlNet 只被内部线约束，
   *      外沿会自由外扩（CNU 的 precision 0.84 vs CND 0.87 就是这个缺口）。
   * 交给 lineart ControlNet 在每一步采样里读，等于把 UV 分割 + 语义分区当成条件。 */
  async function uvSeam(v) {
    const r = await ops.page.evaluate(({ v, S, BANDS }) => {
      const grab = name => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d');
        g.drawImage(window.BUF[name], 0, 0, S, S);
        return g.getImageData(0, 0, S, S).data;
      };
      const isl = grab('im_' + v);
      const sil = grab('in_' + v + '_mask');
      const flat = grab('flat_' + v);
      const bandMaps = BANDS.map(b => grab('pm_' + v + '_' + b));

      const solid = (x, y) => sil[(y * S + x) * 4] > 127;       // 模型轮廓内
      const bandAt = (x, y) => {
        const i = (y * S + x) * 4;
        if (isl[i + 3] < 128) return -1;
        for (let k = 0; k < bandMaps.length; k++) if (bandMaps[k][i + 3] > 127) return k;
        return -2;
      };
      /* 语义三分类：0 皮肤 / 1 头发·绿饰 / 2 白布 / 3 其它 */
      const cls = (x, y) => {
        const i = (y * S + x) * 4;
        const r = flat[i], g = flat[i + 1], b = flat[i + 2];
        if (r > g && r - b > 14) return 0;
        if (g + 4 >= r && g - b > 6) return 1;
        if (Math.max(r, g, b) - Math.min(r, g, b) <= 14 && Math.min(r, g, b) > 170) return 2;
        return 3;
      };

      const out = document.createElement('canvas');
      out.width = out.height = S;
      const og = out.getContext('2d');
      og.fillStyle = '#ffffff';
      og.fillRect(0, 0, S, S);
      const od = og.getImageData(0, 0, S, S);
      const px = (x, y, val) => {
        if (x < 0 || y < 0 || x >= S || y >= S) return;
        const i = (y * S + x) * 4;
        od.data[i] = od.data[i + 1] = od.data[i + 2] = val;
      };
      const thick = (x, y, val, t) => {
        for (let dy = 0; dy < t; dy++) for (let dx = 0; dx < t; dx++) px(x + dx, y + dy, val);
      };
      let seam = 0, band = 0, edge = 0;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (!solid(x, y)) continue;
          if (x < S - 1 && solid(x + 1, y) && cls(x, y) !== cls(x + 1, y)) { px(x, y, 90); px(x + 1, y, 90); seam++; }
          if (y < S - 1 && solid(x, y + 1) && cls(x, y) !== cls(x, y + 1)) { px(x, y, 90); px(x, y + 1, 90); seam++; }
          if (x < S - 1) {
            const ba = bandAt(x, y), bb = bandAt(x + 1, y);
            if (ba >= 0 && bb >= 0 && ba !== bb) { thick(x, y, 60, 2); band++; }
          }
          if (y < S - 1) {
            const ba = bandAt(x, y), bb = bandAt(x, y + 1);
            if (ba >= 0 && bb >= 0 && ba !== bb) { thick(x, y, 60, 2); band++; }
          }
          /* 外轮廓：轮廓内、四邻有轮廓外 → 2px 黑线 */
          const out4 = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1);
          if (out4) { thick(x, y, 20, 2); edge++; }
        }
      }
      og.putImageData(od, 0, 0);
      window.BUF['uvseam_' + v] = out;
      return { url: out.toDataURL('image/png'), seam, band, edge };
    }, { v, S: PX, BANDS: pm.bands });
    return { file: saveUrl(path.join(genDir, 'in_' + v + '_uvseam.png'), r.url), px: r.seam, band: r.band, edge: r.edge };
  }
  async function gen(wf, tag) {
    const r = await comfy.run(wf);
    const file = path.join(genDir, tag + '.png');
    fs.writeFileSync(file, comfy.readOutput(r.images[0]));
    console.log('[gen] ' + tag + ' ' + r.ms + 'ms');
    return { file, ms: r.ms };
  }

  /* ---------- A / B / BL / C（front） ---------- */
  /* --only-cn：只跑 CNU / CNUS 两组，其余对照组直接复用已存在的图。
   * 调条件图（比如补外轮廓）时不必重跑整套 4 视图级联。 */
  const ONLY_CN = process.argv.includes('--only-cn');
  /* --only-peel：只跑「部位剥离 + P 组（front/back 两套级联）」，其余图全部复用。
   * 验证「原画像素直接当参考」对头发的影响时，不必重跑整套对照组。 */
  const ONLY_PEEL = process.argv.includes('--only-peel');
  const REUSE = ONLY_CN || ONLY_PEEL;
  const front = inputs.front;
  const CN_LINE = 'control_v11p_sd15_lineart_fp16.safetensors';
  const CN_DEPTH = 'control_v11f1p_sd15_depth_fp16.safetensors';

  /* ---------- --cn-lab：ControlNet 强化矩阵 ----------
   * 固定同一底图 / seed / denoise，只动「注入强度、第二路权重、生效步区间」。
   * 对照组 d90 与 CND 完全同参，用来确认矩阵本身可复现。 */
  if (process.argv.includes('--cn-lab')) {
    const seam = await uvSeam('front');
    const seamName = comfy.pushInput(seam.file, 'c3_' + runTag + '_uvseam_front.png');
    const D = { image: front.depth, cnet: CN_DEPTH, strength: 0.9 };
    const LABS = [
      ['d90', Object.assign({}, D)],
      ['d100', Object.assign({}, D, { strength: 1.0 })],
      ['d110', Object.assign({}, D, { strength: 1.1 })],
      ['d90_l35', Object.assign({}, D, { image2: front.line, cnet2: CN_LINE, strength2: 0.35 })],
      ['d90_u35', Object.assign({}, D, { image2: seamName, cnet2: CN_LINE, strength2: 0.35 })],
      ['d90_u70', Object.assign({}, D, { image2: seamName, cnet2: CN_LINE, strength2: 0.7 })],
      ['d90_u90', Object.assign({}, D, { image2: seamName, cnet2: CN_LINE, strength2: 0.9 })],
      ['d90_end75', Object.assign({}, D, { end: 0.75 })],
      ['d90_end50', Object.assign({}, D, { end: 0.5 })],
      ['d90_u70_end75', Object.assign({}, D, { image2: seamName, cnet2: CN_LINE, strength2: 0.7, end2: 0.75 })]
    ];
    const lab = {};
    for (const [name, opt] of LABS) {
      lab[name] = await gen(comfy.controlnet(Object.assign({
        positive: POS, negative: NEG, base: front.line, latent: true, denoise: 0.6,
        seed: SEED, prefix: prefix + '_LAB_' + name, w: PX, h: PX
      }, opt)), 'LAB_' + name);
    }
    await ops.load(Object.keys(lab).map(k => ({
      name: 'LAB_' + k, url: 'data:image/png;base64,' + fs.readFileSync(lab[k].file).toString('base64')
    })));
    const treeFront = manifest.tree.front;
    const rows = {};
    for (const k of Object.keys(lab)) {
      rows[k] = await ops.measure('LAB_' + k, 'in_front_mask', { x: 0, y: 0, w: PX, h: PX }, treeFront);
      console.log('[cnlab] ' + k + ' ' + JSON.stringify(rows[k]));
    }
    fs.writeFileSync(path.join(RUN_DIR, 'cnlab.json'), JSON.stringify({ seed: SEED, rows }, null, 2));
    await ops.close();
    return;
  }

  /* ---------- --pick：推理期一致性选择（ControlNet++ 的免训练版） ----------
   * ControlNet++（arXiv:2404.07987）的核心是「从生成图里反推条件，再和输入条件算
   * 循环一致性」；不训练时最直接的用法是把它当验证器：多 seed 采样 N 张，
   * 用轮廓一致性 + 边缘一致性挑一张。depth 权重用 §5.7 选出的 1.0。 */
  const pickIdx = process.argv.indexOf('--pick');
  if (pickIdx > 0) {
    const N = Math.max(2, Math.min(12, +(process.argv[pickIdx + 1] || 6) || 6));
    const seeds = Array.from({ length: N }, (_, k) => SEED + k * 104729);
    const cand = [];
    for (const s of seeds) {
      const r = await gen(comfy.controlnet({
        positive: POS, negative: NEG, image: front.depth, cnet: CN_DEPTH, strength: 1.0,
        base: front.line, latent: true, denoise: 0.6, seed: s, prefix: prefix + '_PICK_' + s, w: PX, h: PX
      }), 'PICK_' + s);
      cand.push({ seed: s, file: r.file, ms: r.ms });
    }
    await ops.load(cand.map((c, i) => ({
      name: 'PICK_' + i, url: 'data:image/png;base64,' + fs.readFileSync(c.file).toString('base64')
    })));
    const treeFront = manifest.tree.front;
    for (let i = 0; i < cand.length; i++) {
      cand[i].m = await ops.measure('PICK_' + i, 'in_front_mask', { x: 0, y: 0, w: PX, h: PX }, treeFront);
      cand[i].score = +(0.7 * cand[i].m.iou + 0.3 * Math.min(1, cand[i].m.edgeRatio)).toFixed(4);
    }
    cand.sort((a, b) => b.score - a.score);
    fs.copyFileSync(cand[0].file, path.join(genDir, 'BEST_front.png'));
    fs.writeFileSync(path.join(RUN_DIR, 'pick.json'), JSON.stringify({
      n: N, score: '0.7*iou + 0.3*min(1,edgeRatio)',
      cand: cand.map(c => Object.assign({ seed: c.seed, file: path.basename(c.file), score: c.score }, c.m))
    }, null, 2));
    for (const c of cand) {
      console.log('[pick] ' + c.seed + ' score ' + c.score + ' iou ' + c.m.iou +
        ' head ' + c.m.regions.head.detail + ' feet ' + c.m.regions.feet.detail);
    }
    console.log('[pick] best ' + cand[0].seed + ' → gen/BEST_front.png');
    await ops.close();
    return;
  }

  const reuse = {
    A: { file: path.join(genDir, 'A_txt2img.png'), ms: 0 },
    B: { file: path.join(genDir, 'B_img2img60.png'), ms: 0 },
    BL: { file: path.join(genDir, 'BL_line60.png'), ms: 0 },
    C: { file: path.join(genDir, 'C_img2img85.png'), ms: 0 },
    CNL: { file: path.join(genDir, 'CNL_line.png'), ms: 0 },
    CND: { file: path.join(genDir, 'CND_depth.png'), ms: 0 },
    CNLD: { file: path.join(genDir, 'CNLD_line_depth.png'), ms: 0 }
  };
  const A = REUSE ? reuse.A : await gen(comfy.txt2img({ positive: POS, negative: NEG, w: PX, h: PX, seed: SEED, prefix: prefix + '_A' }), 'A_txt2img');
  const B = REUSE ? reuse.B : await gen(comfy.img2img({ positive: POS, negative: NEG, image: front.color, denoise: 0.6, seed: SEED, prefix: prefix + '_B' }), 'B_img2img60');
  /* BL = 线稿条件（描边 + 角度线框 + 深度描边），同参数，只换条件图 */
  const BL = REUSE ? reuse.BL : await gen(comfy.img2img({ positive: POS, negative: NEG, image: front.line, denoise: 0.6, seed: SEED, prefix: prefix + '_BL' }), 'BL_line60');
  const C = REUSE ? reuse.C : await gen(comfy.img2img({ positive: POS, negative: NEG, image: front.color, denoise: 0.85, seed: SEED, prefix: prefix + '_C' }), 'C_img2img85');

  /* ---------- CN：ControlNet = 结构图在每一步采样里都注入（闭环的内环） ----------
   * 和 BL 的区别只有一处：结构图不再只在初始 latent 里出现一次，而是每次 UNet
   * 预测都读一遍，误差在采样过程中被逐步拉回。 */
  /* 与 BL 完全同底图、同 seed、同 denoise，唯一变量：结构图是否每一步都参与。
   * 这样两组的差就是「开环 vs 逐步闭环」的差。 */
  const CNL = REUSE ? reuse.CNL : await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: front.wire, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_LINE, strength: 0.9,
    seed: SEED, prefix: prefix + '_CNL', w: PX, h: PX
  }), 'CNL_line');
  const CND = REUSE ? reuse.CND : await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: front.depth, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_DEPTH, strength: 0.9,
    seed: SEED, prefix: prefix + '_CND', w: PX, h: PX
  }), 'CND_depth');
  const CNLD = REUSE ? reuse.CNLD : await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: front.wire, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_LINE, strength: 0.85,
    image2: front.depth, cnet2: CN_DEPTH, strength2: 0.55,
    seed: SEED, prefix: prefix + '_CNLD', w: PX, h: PX
  }), 'CNLD_line_depth');

  /* ---------- CNU / CNUS：把 UV 分割的硬轮廓混入，并补语义部位 ----------
   * 与 CNL/CND 完全同底图 / 同 seed / 同 denoise，只换「掺进去的结构」：
   *   CNU  = UV 岛接缝图（硬分件边界）走 lineart ControlNet
   *   CNUS = 同上 + 每个部件自己的提示词，用 ConditioningSetMask 限定在部件掩膜里
   * 前者回答「硬轮廓有没有用」，后者回答「部位语义强化有没有用」。 */
  /* 语义底图在剥离阶段已经算过（并用剥离出的头发色重算），这里直接出条件图。 */
  const seam = await uvSeam('front');
  const seamName = comfy.pushInput(seam.file, 'c3_' + runTag + '_uvseam_front.png');
  console.log('[uvseam] front 接缝 ' + seam.px + ' / 带界 ' + seam.band + ' / 外轮廓 ' + seam.edge);

  let CNU, CNUS, CNUD, CNUDS;
  if (ONLY_PEEL) {
    const f = n => ({ file: path.join(genDir, n), ms: 0 });
    CNU = f('CNU_uvseam.png');
    CNUS = f('CNUS_uvseam_parts.png');
    CNUD = f('CNUD_depth_seam.png');
    CNUDS = f('CNUDS_depth_seam_parts.png');
  } else {
  CNU = await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: seamName, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_LINE, strength: 0.85,
    seed: SEED, prefix: prefix + '_CNU', w: PX, h: PX
  }), 'CNU_uvseam');

  /* 部件提示词：UV 岛归并出的 5 个高度带，每个带用自己的词 + 自己的原画主色 */
  const PART_SPEC = [
    { band: 'head', prompt: HEAD_PROMPT + ', ' + colorOf('head') + ' hair', strength: 0.8 },
    { band: 'torso', prompt: TORSO_PROMPT + ', ' + colorOf('torso'), strength: 0.8 },
    { band: 'hip', prompt: SKIRT_PROMPT + ', ' + colorOf('hip'), strength: 0.75 },
    { band: 'legs', prompt: LEGS_PROMPT + ', ' + colorOf('legs'), strength: 0.7 },
    { band: 'feet', prompt: 'anime feet, ' + colorOf('feet') + ' high heels, clean lineart, white background', strength: 0.6 }
  ];
  const partsConds = PART_SPEC.map(p => ({
    prompt: p.prompt,
    strength: p.strength,
    mask: comfy.pushInput(path.join(partsDir, 'front_' + p.band + '.png'), 'c3_' + runTag + '_pm_front_' + p.band + '.png')
  }));
  CNUS = await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: seamName, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_LINE, strength: 0.85, parts: partsConds,
    seed: SEED, prefix: prefix + '_CNUS', w: PX, h: PX
  }), 'CNUS_uvseam_parts');

  /* 硬轮廓只给「分件在哪」，体量还是得靠 depth：两路一起掺。
   * 顺序上 depth 权重 0.9 保体量，UV 接缝 0.5 只负责把分件边界钉住。 */
  CNUD = await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: front.depth, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_DEPTH, strength: 0.9,
    image2: seamName, cnet2: CN_LINE, strength2: 0.5,
    seed: SEED, prefix: prefix + '_CNUD', w: PX, h: PX
  }), 'CNUD_depth_seam');
  CNUDS = await gen(comfy.controlnet({
    positive: POS, negative: NEG, image: front.depth, base: front.line, latent: true,
    denoise: 0.6, cnet: CN_DEPTH, strength: 0.9, parts: partsConds,
    image2: seamName, cnet2: CN_LINE, strength2: 0.5,
    seed: SEED, prefix: prefix + '_CNUDS', w: PX, h: PX
  }), 'CNUDS_depth_seam_parts');
  }

  /* ---------- D：每个视图一套「色块底图 → 节点级联」 ---------- */
  /* tag：产物前缀。D = 原语义底图；P = 部位剥离（头发色来自原画像素）后的对照。 */
  async function cascade(v, withFace, tag) {
    const TG = tag || 'D';
    const t = manifest.tree[v];
    const baseFile = await flatBase(v);
    const flatName = comfy.pushInput(baseFile, 'c3_' + runTag + '_flat_' + v + '.png');
    const d0 = await gen(comfy.img2img({
      positive: POS, negative: NEG, image: flatName, denoise: 0.4, seed: SEED, prefix: prefix + '_' + TG + '0_' + v
    }), TG + '_' + v + '_0base');
    await ops.load([{ name: TG + '_' + v, url: 'data:image/png;base64,' + fs.readFileSync(d0.file).toString('base64') }]);

    /* 节点矩形 = 该部件掩膜的屏幕包围盒（UV 岛归并的结果，不是按比例切的框） */
    const st = pm.views[v].stats;
    const figB = manifest.profile[v].bbox;
    const figH = (figB.y1 - figB.y0 + 1) * 0.5;
    function partRect(band, pad) {
      const bb = st[band] && st[band].bbox;
      if (!bb) return null;
      const w = bb.x1 - bb.x0 + 1, h = bb.y1 - bb.y0 + 1;
      const p = Math.round((pad || 0) * Math.max(w, h));
      return { x: bb.x0 - p, y: bb.y0 - p, w: w + p * 2, h: h + p * 2 };
    }
    const headBox = partRect('head', 0.05);
    /* 长发岛会把 head 带的包围盒拉得很长；头节点只取上段 34% 身高 */
    headBox.h = Math.min(headBox.h, Math.round(figH * 0.34));
    const headR = squareRect(headBox);
    const faceR = squareRect({
      x: headBox.x + headBox.w * 0.28, w: headBox.w * 0.44,
      y: headBox.y + headBox.h * 0.42, h: headBox.h * 0.58
    });
    /* 躯干去掉手臂：横向宽度参考 hip 带，纵向用 torso 带 */
    const torsoBox = partRect('torso', 0.02) || headBox;
    const hipB = st.hip && st.hip.bbox;
    if (hipB) {
      torsoBox.x = hipB.x0;
      torsoBox.w = hipB.x1 - hipB.x0 + 1;
    }
    const torsoR = squareRect(torsoBox);
    /* UV 岛面积最大的两块「没人管」的区域：裙摆（hip）与腿/鞋（legs）。
     * 只取部件包围盒、不做正方形外扩——外扩出来的方块会盖住头/躯干，
     * 后面再贴回去等于把已经做好的细节又糊了一遍。 */
    const skirtBox = partRect('hip', 0.02);
    const legsBox = partRect('legs', 0.02);
    const skirtR = skirtBox;
    const legsR = legsBox;

    /* 顺序 = 覆盖优先级：粗的在前，细的在后。head/face 必须最后落笔。
     * band 决定「贴回时允许改哪些像素」：只改该部件（UV 岛归并）掩膜覆盖的地方，
     * 不再按整条轮廓糊一整块——否则裙摆节点会把路过的手 / 发尾一起重画。 */
    const isBack = v === 'back';
    const isSide = v === 'left' || v === 'right';
    const steps = [
      { key: 'skirt', band: 'hip', r: skirtR, prompt: SKIRT_PROMPT + ', ' + colorOf('hip'), denoise: 0.55, need: !!skirtR },
      { key: 'legs', band: 'legs', r: legsR, prompt: LEGS_PROMPT + ', ' + colorOf('legs') + ' and ' + colorOf('feet'), denoise: 0.55, need: !!legsR },
      { key: 'torso', band: 'torso', r: torsoR, prompt: TORSO_PROMPT + ', ' + colorOf('torso') + ' and ' + colorOf('shoulder'), denoise: 0.55, need: !!withFace },
      {
        key: 'head', band: 'head', r: headR, denoise: 0.62, need: true,
        prompt: (isBack ? BACK_HEAD_PROMPT : isSide ? SIDE_HEAD_PROMPT : HEAD_PROMPT) + ', ' + colorOf('head') + ' hair',
        neg: isBack ? NEG_FACE : NEG
      },
      {
        key: 'face', band: 'head', r: faceR, denoise: 0.55, need: !!withFace,
        prompt: isSide ? SIDE_FACE_PROMPT : FACE_PROMPT
      }
    ];
    let cur = TG + '_' + v;
    const seq = [];
    for (const st of steps) {
      if (!st.need) continue;
      const r = st.r;
      /* 4K 原生裁切：r 是 512 坐标（一格 512 = 相机取景框），
       * hi_<v> 是 4096 单视图，换算比例 = 4096 / 512 = 8（不是 4）。 */
      const NAT = 4096 / PX;
      const cropUrl = await ops.crop('node_' + v + '_' + st.key, 'hl_' + v, r.x * NAT, r.y * NAT, r.w * NAT, r.h * NAT, PX, PX, '#ffffff');
      const f = saveUrl(path.join(genDir, 'in_' + v + '_' + st.key + '_native.png'), cropUrl);
      const name = comfy.pushInput(f, 'c3_' + runTag + '_' + v + '_' + st.key + '.png');
      const g = await gen(comfy.img2img({
        positive: st.prompt, negative: st.neg || NEG, image: name, denoise: st.denoise, seed: SEED,
        prefix: prefix + '_' + TG + '_' + v + '_' + st.key
      }), TG + '_' + v + '_' + st.key);
      await ops.load([{ name: 'node_out_' + v + '_' + st.key, url: 'data:image/png;base64,' + fs.readFileSync(g.file).toString('base64') }]);
      await ops.crop('patch_' + v + '_' + st.key, 'node_out_' + v + '_' + st.key, 0, 0, PX, PX, r.w, r.h, null);
      /* 贴回用「部件掩膜」而不是整条人形掩膜：节点只对它负责的那部分岛有写权限 */
      await ops.crop('pmask_' + v + '_' + st.key, 'pm_' + v + '_' + st.band, r.x, r.y, r.w, r.h, r.w, r.h, '#000000');
      const out = await ops.compose('cmp_' + v + '_' + st.key, cur, 'patch_' + v + '_' + st.key, r, 'pmask_' + v + '_' + st.key, 2);
      saveUrl(path.join(genDir, TG + '_' + v + '_' + st.key + '_composite.png'), out);
      cur = 'cmp_' + v + '_' + st.key;
      seq.push({ key: st.key, rect: r, ms: g.ms });
    }
    /* 最后一步的合成结果 = 原始成品；
     * 再做「语义配色回灌」：结构/明暗取生成图，色相取 UV 岛底图——SD 会把灰模重绘成
     * 自己的默认配色（灰紫发、灰蓝裙），底图里每个岛的原画颜色才是这个角色的颜色。
     */
    const rawUrl = await ops.page.evaluate(n => window.BUF[n].toDataURL('image/png'), cur);
    const rawFile = saveUrl(path.join(genDir, TG + '_' + v + '_raw.png'), rawUrl);
    /* P：回灌底图换成「剥离出的原画头发像素」。
     * 岛掩膜保证只在这一块取原画颜色，头发不会再去参照旁边的脸和衣服；
     * 因为是逐像素而不是 5 档量化色，发丝的浅绿层次能原样带回来。 */
    let baseName = 'flat_' + v;
    if (TG === 'P') {
      const refFile = path.join(genDir, 'ref_' + v + '_hair.png');
      if (fs.existsSync(refFile)) {
        await ops.load([{ name: 'hairref_' + v, url: 'data:image/png;base64,' + fs.readFileSync(refFile).toString('base64') }]);
        await ops.page.evaluate(({ b, o, out, S }) => {
          const c = document.createElement('canvas');
          c.width = c.height = S;
          const g = c.getContext('2d');
          g.drawImage(window.BUF[b], 0, 0, S, S);
          g.drawImage(window.BUF[o], 0, 0, S, S);
          window.BUF[out] = c;
        }, { b: 'flat_' + v, o: 'hairref_' + v, out: 'recolbase_' + v, S: PX });
        baseName = 'recolbase_' + v;
      }
    }
    const recUrl = await ops.page.evaluate(({ srcName, baseName, maskName, outName }) => {
      const im = window.BUF[srcName];
      const S = im.naturalWidth || im.width;
      const mk = (name) => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d');
        g.drawImage(window.BUF[name], 0, 0, S, S);
        return { c, d: g.getImageData(0, 0, S, S).data };
      };
      const gen = mk(srcName), base = mk(baseName), m = mk(maskName);
      const out = document.createElement('canvas');
      out.width = out.height = S;
      const og = out.getContext('2d');
      const od = og.createImageData(S, S);
      for (let i = 0; i < gen.d.length; i += 4) {
        if (m.d[i] < 128) continue;
        const lb = 0.299 * base.d[i] + 0.587 * base.d[i + 1] + 0.114 * base.d[i + 2];
        const lg = 0.299 * gen.d[i] + 0.587 * gen.d[i + 1] + 0.114 * gen.d[i + 2];
        /* 亮度比（生成 / 底图）只调明暗，色相完全来自底图 */
        const k = Math.max(0.55, Math.min(1.9, (lg + 8) / (Math.max(lb, 20) + 8)));
        for (let c = 0; c < 3; c++) {
          od.data[i + c] = Math.min(255, Math.round(base.d[i + c] * k));
        }
        od.data[i + 3] = 255;
      }
      og.putImageData(od, 0, 0);
      window.BUF[outName] = out;
      return out.toDataURL('image/png');
    }, { srcName: cur, baseName, maskName: 'in_' + v + '_mask', outName: 'rec_' + v });
    const recFile = saveUrl(path.join(genDir, TG + '_' + v + '_recolor.png'), recUrl);
    const lockedUrl = await ops.page.evaluate(({ srcName, maskName }) => {
      const im = window.BUF[srcName];
      const S = im.naturalWidth || im.width;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0, S, S);
      const m = window.BUF[maskName];
      const ac = document.createElement('canvas');
      ac.width = ac.height = S;
      const ag = ac.getContext('2d');
      ag.drawImage(m, 0, 0, S, S);
      const id = ag.getImageData(0, 0, S, S);
      for (let i = 0; i < id.data.length; i += 4) id.data[i + 3] = id.data[i];
      ag.putImageData(id, 0, 0);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(ac, 0, 0);
      window.BUF[srcName + '_lock'] = c;
      return c.toDataURL('image/png');
    }, { srcName: 'rec_' + v, maskName: 'in_' + v + '_mask' });
    const finalFile = saveUrl(path.join(genDir, TG + '_' + v + '_final.png'), lockedUrl);
    return { file: finalFile, raw: recFile, pre: rawFile, seq, base: d0.file, ms: seq.reduce((a, b) => a + b.ms, 0) + d0.ms };
  }

  const Dfront = REUSE
    ? { file: path.join(genDir, 'D_front_final.png'), raw: path.join(genDir, 'D_front_recolor.png'), ms: 0, seq: [] }
    : await cascade('front', true);

  /* ---------- P：部位剥离对照组（只跑 front / back） ---------- */
  const Pfront = ONLY_PEEL ? await cascade('front', true, 'P') : null;
  const Pback = ONLY_PEEL ? await cascade('back', false, 'P') : null;

  /* ---------- 度量（front，全部对原始生成图） ---------- */
  await ops.load([
    { name: 'A_img', url: 'data:image/png;base64,' + fs.readFileSync(A.file).toString('base64') },
    { name: 'B_img', url: 'data:image/png;base64,' + fs.readFileSync(B.file).toString('base64') },
    { name: 'C_img', url: 'data:image/png;base64,' + fs.readFileSync(C.file).toString('base64') },
    { name: 'BL_img', url: 'data:image/png;base64,' + fs.readFileSync(BL.file).toString('base64') },
    { name: 'CNL_img', url: 'data:image/png;base64,' + fs.readFileSync(CNL.file).toString('base64') },
    { name: 'CND_img', url: 'data:image/png;base64,' + fs.readFileSync(CND.file).toString('base64') },
    { name: 'CNLD_img', url: 'data:image/png;base64,' + fs.readFileSync(CNLD.file).toString('base64') },
    { name: 'CNU_img', url: 'data:image/png;base64,' + fs.readFileSync(CNU.file).toString('base64') },
    { name: 'CNUS_img', url: 'data:image/png;base64,' + fs.readFileSync(CNUS.file).toString('base64') },
    { name: 'CNUD_img', url: 'data:image/png;base64,' + fs.readFileSync(CNUD.file).toString('base64') },
    { name: 'CNUDS_img', url: 'data:image/png;base64,' + fs.readFileSync(CNUDS.file).toString('base64') },
    { name: 'D_img', url: 'data:image/png;base64,' + fs.readFileSync(Dfront.raw).toString('base64') },
    { name: 'D_lock', url: 'data:image/png;base64,' + fs.readFileSync(Dfront.file).toString('base64') }
  ]);
  if (Pfront) {
    await ops.load([
      { name: 'P_img', url: 'data:image/png;base64,' + fs.readFileSync(Pfront.raw).toString('base64') },
      { name: 'P_lock', url: 'data:image/png;base64,' + fs.readFileSync(Pfront.file).toString('base64') }
    ]);
  }
  const tree = manifest.tree.front;
  const metrics = {};
  const metricPairs = [['A', 'A_img'], ['B', 'B_img'], ['BL', 'BL_img'], ['C', 'C_img'],
    ['CNL', 'CNL_img'], ['CND', 'CND_img'], ['CNLD', 'CNLD_img'],
    ['CNU', 'CNU_img'], ['CNUS', 'CNUS_img'], ['CNUD', 'CNUD_img'], ['CNUDS', 'CNUDS_img'],
    ['D', 'D_img'], ['Dlock', 'D_lock']];
  if (Pfront) metricPairs.push(['P', 'P_img'], ['Plock', 'P_lock']);
  for (const [k, n] of metricPairs) {
    metrics[k] = await ops.measure(n, 'in_front_mask', { x: 0, y: 0, w: PX, h: PX }, tree);
  }
  recon.metrics = metrics;
  recon.conditions = {
    A: { file: 'gen/A_txt2img.png', ms: A.ms, desc: '纯文本 txt2img（无结构条件）' },
    B: { file: 'gen/B_img2img60.png', ms: B.ms, desc: '素模 img2img d=0.60' },
    BL: { file: 'gen/BL_line60.png', ms: BL.ms, desc: '描边+角度线框+深度描边 img2img d=0.60（视图工坊默认图层组合）' },
    C: { file: 'gen/C_img2img85.png', ms: C.ms, desc: '素模 img2img d=0.85' },
    CNL: { file: 'gen/CNL_line.png', ms: CNL.ms, desc: 'ControlNet lineart 0.9（每一步注入结构）' },
    CND: { file: 'gen/CND_depth.png', ms: CND.ms, desc: 'ControlNet depth 0.9（每一步注入结构）' },
    CNLD: { file: 'gen/CNLD_line_depth.png', ms: CNLD.ms, desc: 'ControlNet lineart 0.85 + depth 0.55 叠加' },
    CNU: { file: 'gen/CNU_uvseam.png', ms: CNU.ms, desc: 'ControlNet lineart 0.85 + UV 岛硬轮廓（分件接缝）条件图' },
    CNUS: { file: 'gen/CNUS_uvseam_parts.png', ms: CNUS.ms, desc: 'CNU + 5 个部件提示词各自用 ConditioningSetMask 限定在部件掩膜内' },
    CNUD: { file: 'gen/CNUD_depth_seam.png', ms: CNUD.ms, desc: 'depth 0.9 + UV 岛硬轮廓 0.5 双路叠加' },
    CNUDS: { file: 'gen/CNUDS_depth_seam_parts.png', ms: CNUDS.ms, desc: 'CNUD + 部件提示词按掩膜限定' },
    D: { file: 'gen/D_front_final.png', ms: Dfront.ms, desc: '自研：语义色块底图 + 节点 4K 原生结构 + 羽化回贴', steps: Dfront.seq }
  };
  if (Pfront) {
    recon.conditions.P = {
      file: 'gen/P_front_final.png', ms: Pfront.ms, back: Pback ? 'gen/P_back_final.png' : null,
      desc: 'D + 部位剥离：head 带头发色改为「UV 岛掩膜从原画抠出的像素」统计，提示词也用该主色'
    };
  }

  /* ---------- 四视图成品：反投源（B / D） ---------- */
  /* 把 4 个视图装进 2048 画布，再用整张遮罩锁成透明底 */
  async function bakeSheet(tag, files) {
    const items = [];
    for (const v of VIEWS) {
      await ops.load([{ name: 'sheet_src_' + v, url: 'data:image/png;base64,' + fs.readFileSync(files[v]).toString('base64') }]);
      items.push({ key: v, name: 'sheet_src_' + v });
    }
    const url = await ops.page.evaluate(({ items, cells }) => {
      const S = 2048;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      for (const it of items) {
        const im = window.BUF[it.name];
        const cell = cells[it.key];
        g.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight, cell.x, cell.y, cell.w, cell.h);
      }
      /* 整张遮罩 → alpha，一次性把四格背景抠掉 */
      const m = window.BUF.mask4;
      const ac = document.createElement('canvas');
      ac.width = ac.height = S;
      const ag = ac.getContext('2d');
      ag.drawImage(m, 0, 0, S, S);
      const id = ag.getImageData(0, 0, S, S);
      for (let i = 0; i < id.data.length; i += 4) {
        id.data[i + 3] = id.data[i];
      }
      ag.putImageData(id, 0, 0);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(ac, 0, 0);
      return c.toDataURL('image/png');
    }, { items, cells: Object.fromEntries(manifest.cells.map(c => [c.key, c])) });
    return saveUrl(path.join(genDir, tag + '.png'), url);
  }

  /* B 的其它三视图：线稿条件 + 同参数 img2img（与 BL 同一口径） */
  if (!REUSE) {
    const bFiles = { front: BL.file };
    for (const v of ['left', 'back', 'right']) {
      const r = await gen(comfy.img2img({ positive: POS, negative: NEG, image: inputs[v].line, denoise: 0.6, seed: SEED, prefix: prefix + '_BL_' + v }), 'BL_' + v);
      bFiles[v] = r.file;
    }
    recon.bake = { B: await bakeSheet('bake_B', bFiles) };

    const dFiles = { front: Dfront.file };
    for (const v of ['left', 'back', 'right']) dFiles[v] = (await cascade(v, false)).file;
    recon.bake.D = await bakeSheet('bake_D', dFiles);
  }

  const jsonFile = path.join(RUN_DIR, 'gen.json');
  if (ONLY_CN) {
    /* 只跑 CN 组时保留上一轮的对照组与反投结果，只替换度量与这两条条件 */
    const old = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    old.metrics = recon.metrics;
    old.conditions.CNU = recon.conditions.CNU;
    old.conditions.CNUS = recon.conditions.CNUS;
    old.conditions.CNUD = recon.conditions.CNUD;
    old.conditions.CNUDS = recon.conditions.CNUDS;
    fs.writeFileSync(jsonFile, JSON.stringify(old, null, 2));
    console.log('[metrics] ' + JSON.stringify({ CNU: metrics.CNU, CNUS: metrics.CNUS, CNUD: metrics.CNUD, CNUDS: metrics.CNUDS }));
  } else if (ONLY_PEEL) {
    /* 只跑剥离对照时保留上一轮的反投结果，补上 peel / P */
    const old = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    old.metrics = recon.metrics;
    old.peel = recon.peel;
    old.conditions.P = recon.conditions.P;
    fs.writeFileSync(jsonFile, JSON.stringify(old, null, 2));
    console.log('[metrics] P ' + JSON.stringify(metrics.P));
    console.log('[metrics] D ' + JSON.stringify(metrics.D));
  } else {
    fs.writeFileSync(jsonFile, JSON.stringify(recon, null, 2));
    console.log('[metrics] ' + JSON.stringify(metrics));
    console.log('bake sources: ' + recon.bake.B + ' | ' + recon.bake.D);
  }
  await ops.close();
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
