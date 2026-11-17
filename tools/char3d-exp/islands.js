#!/usr/bin/env node
/* 按岛隔离：把指定 UV 岛单独渲染出来，得到「去掉遮挡后」的完整轮廓
 *
 *   node tools/char3d-exp/islands.js --run <dir> [--views front,back]
 *
 * 做的事（全部在页面里用同一台正交相机完成，和 bake / parts 口径一致）：
 *   ① 逐三角投影 + 背面剔除 + 画家算法 → 视图编号图（哪个像素属于哪个岛）
 *   ② 岛按世界坐标高度带归类（与 parts.js 同一套阈值）
 *   ③ 按「带 + 岛色 + 可见像素数」选岛（头发 = head 带绿色岛；裙摆 = hip 带白色岛）
 *   ④ 只画选中的岛 → 完整轮廓；完整轮廓 − 原图可见像素 = 被遮挡的洞
 *
 * 输出到 <run>/islands/：
 *   <key>_<view>_iso.png         隔离渲染（白底、按岛色填充）
 *   <key>_<view>_silhouette.png  完整轮廓（白=岛）
 *   <key>_<view>_holes.png       只保留被挡住的区域（局部重绘用的掩膜）
 *   islands.json                 每岛面积 / 色值 / 统计
 *
 * 洞不是「猜」出来的：隔离渲染给出岛在该视角的最大投影，原图编号图给出它真正
 * 露出来的部分，两者相减就是被别的岛占掉的那一块。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { ROOT } = require('../probe-run');

const MODEL = path.join(ROOT, 'assets/models/mwdkldbx-8417b5c6.obj');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function runDirFromArg() {
  const r = arg('run');
  if (r) return path.resolve(r);
  const base = path.join(ROOT, '.workbuddy/runs');
  const list = fs.readdirSync(base).filter(d => /char3d-render$/.test(d)).sort();
  if (!list.length) throw new Error('没有 char3d-render 运行目录');
  return path.join(base, list[list.length - 1]);
}

/* 选择规则。test 在岛的平均色上判定：
 *   green  —— 头发那套浅绿（g ≥ r-4 且 g 明显高于 b）
 *   white  —— 白布（三通道都高且接近，排除肤色） */
const SELECTS = [
  /* centroidBands 用岛的质心带再兜一层：白袖子也有像素落在 hip 带，
   * 但它们质心在 torso，不兜这一层会把袖子当成裙摆。 */
  { key: 'hair', band: 'head', test: 'green', minPx: 20, centroidBands: null },
  { key: 'skirt', band: 'hip', test: 'white', minPx: 20, centroidBands: ['hip', 'legs'] }
];

const RASTER = String.raw`
async function (args) {
  const { src, views, size, margin, selects, specs, base, bandMasks } = args;
  const bandOf = t => t >= 0.795 ? 'head' : t >= 0.60 ? 'torso' : t >= 0.42 ? 'hip' : t >= 0.10 ? 'legs' : 'feet';
  const SC = 4;                       /* 超采样倍数：和 parts.js 一致，去掉画多边形的 AA 边 */
  const a = await ModelTex.analyze(src);
  const m = await Model3D.load(src);
  const bb = a.box, HH = bb.max.y - bb.min.y;
  const band = [];
  a.islands.forEach(o => { band[o.id] = bandOf((o.centroid[1] - bb.min.y) / HH); });

  const v3 = new THREE.Vector3();
  const parts = a.parts.map(p => {
    const n = p.pos.count;
    const w = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v3.set(p.pos.getX(i), p.pos.getY(i), p.pos.getZ(i)).applyMatrix4(p.mw);
      w[i * 3] = v3.x; w[i * 3 + 1] = v3.y; w[i * 3 + 2] = v3.z;
    }
    return { w: w, idx: p.idx, tri: p.tri };
  });
  const offs = [];
  let tot = 0;
  for (const p of parts) { offs.push(tot); tot += p.tri; }

  const load = u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const grab = async u => {
    const im = await load(u);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0, size, size);
    return g.getImageData(0, 0, size, size).data;
  };

  /* 4× 画 → 每 4×4 块取众数（mode=id）或覆盖率过半（mode=cover） */
  function raster4(list, mode, pick) {
    const bc = document.createElement('canvas');
    bc.width = bc.height = size * SC;
    const bg = bc.getContext('2d');
    bg.scale(SC, SC);
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      bg.fillStyle = pick(q);
      bg.beginPath();
      bg.moveTo(q[0], q[1]); bg.lineTo(q[2], q[3]); bg.lineTo(q[4], q[5]);
      bg.closePath(); bg.fill();
    }
    const big = bg.getImageData(0, 0, size * SC, size * SC).data;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const id = g.createImageData(size, size);
    const cov = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cnt = {};
        let bestV = -1, bestN = 0, cover = 0, firstP = -1;
        for (let dy = 0; dy < SC; dy++) {
          const by = (y * SC + dy) * size * SC;
          for (let dx = 0; dx < SC; dx++) {
            const p = (by + x * SC + dx) * 4;
            if (big[p + 3] < 250) continue;
            if (firstP < 0) firstP = p;
            if (mode === 'cover') { cover++; continue; }
            const v = big[p] | (big[p + 1] << 8);
            const n = (cnt[v] || 0) + 1;
            cnt[v] = n;
            if (n > bestN) { bestN = n; bestV = v; }
          }
        }
        const o = (y * size + x) * 4;
        if (mode === 'cover') {
          if (cover * 2 < SC * SC || firstP < 0) continue;
          cov[y * size + x] = 1;
          id.data[o] = big[firstP]; id.data[o + 1] = big[firstP + 1]; id.data[o + 2] = big[firstP + 2];
        } else {
          if (bestV < 0) continue;
          id.data[o] = bestV & 255;
          id.data[o + 1] = (bestV >> 8) & 255;
        }
        id.data[o + 3] = 255;
      }
    }
    g.putImageData(id, 0, 0);
    return { data: id.data, cov: cov, canvas: c, png: c.toDataURL('image/png') };
  }

  function dilate(mask, r) {
    const out = new Uint8Array(mask);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!mask[y * size + x]) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < size && xx >= 0 && xx < size) out[yy * size + xx] = 1;
          }
        }
      }
    }
    return out;
  }

  /* 去掉面积小于 min 的连通块：掩膜边缘的 1~2 像素毛刺不值得送去重绘 */
  function filterSmall(mask, min) {
    const seen = new Uint8Array(size * size);
    const out = new Uint8Array(mask);
    const stack = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || seen[i]) continue;
      const comp = [];
      stack.length = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        comp.push(p);
        const x = p % size, y = (p / size) | 0;
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < size - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && mask[p - size] && !seen[p - size]) { seen[p - size] = 1; stack.push(p - size); }
        if (y < size - 1 && mask[p + size] && !seen[p + size]) { seen[p + size] = 1; stack.push(p + size); }
      }
      if (comp.length < min) for (const p of comp) out[p] = 0;
    }
    return out;
  }

  const maskPng = m2 => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const id = g.createImageData(size, size);
    for (let i = 0; i < m2.length; i++) {
      const o = i * 4;
      id.data[o] = id.data[o + 1] = id.data[o + 2] = m2[i] ? 255 : 0;
      id.data[o + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  };

  /* ---------- 第一遍：每视图的编号图 + 可见像素 / 岛色 ---------- */
  const viewData = {};
  for (const v of views) {
    const cam = Model3D.gridCameras(m, [v], { cellW: 1024, cellH: 1024, margin: margin })[0];
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const mvp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const v4 = new THREE.Vector4();
    const proj = parts.map(p => {
      const n = p.w.length / 3;
      const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        v4.set(p.w[i * 3], p.w[i * 3 + 1], p.w[i * 3 + 2], 1).applyMatrix4(mvp);
        const iw = 1 / (v4.w || 1);
        sx[i] = (v4.x * iw * 0.5 + 0.5) * size;
        sy[i] = (-v4.y * iw * 0.5 + 0.5) * size;
        sz[i] = v4.z * iw;
      }
      return { sx: sx, sy: sy, sz: sz };
    });
    const vdir = new THREE.Vector3();
    cam.getWorldDirection(vdir);
    const list = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi], q = proj[pi];
      for (let t = 0; t < p.tri; t++) {
        const i0 = p.idx ? p.idx.getX(t * 3) : t * 3;
        const i1 = p.idx ? p.idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = p.idx ? p.idx.getX(t * 3 + 2) : t * 3 + 2;
        /* 背面剔除：不剔的话「去掉遮挡」会把背面岛也算进来，
         * 洞的面积会被算大一倍。 */
        const ax = p.w[i0 * 3], ay = p.w[i0 * 3 + 1], az = p.w[i0 * 3 + 2];
        const bx = p.w[i1 * 3], by = p.w[i1 * 3 + 1], bz = p.w[i1 * 3 + 2];
        const cx = p.w[i2 * 3], cy = p.w[i2 * 3 + 1], cz = p.w[i2 * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const wx = cx - ax, wy = cy - ay, wz = cz - az;
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        if (nx * vdir.x + ny * vdir.y + nz * vdir.z < 0) continue;
        list.push([q.sx[i0], q.sy[i0], q.sx[i1], q.sy[i1], q.sx[i2], q.sy[i2],
          (q.sz[i0] + q.sz[i1] + q.sz[i2]) / 3, a.triIsland[offs[pi] + t]]);
      }
    }
    list.sort((A, B) => A[6] - B[6]);

    const map = raster4(list, 'id', q => 'rgb(' + (q[7] & 255) + ',' + ((q[7] >> 8) & 255) + ',0)');
    const baseD = await grab(base[v]);
    const vis = {};
    for (let p = 0; p < size * size; p++) {
      const id = map.data[p * 4] | (map.data[p * 4 + 1] << 8);
      if (!id) continue;
      const e = vis[id] || (vis[id] = { px: 0, r: 0, g: 0, b: 0 });
      e.px++;
      e.r += baseD[p * 4]; e.g += baseD[p * 4 + 1]; e.b += baseD[p * 4 + 2];
    }
    const colors = {};
    for (const id of Object.keys(vis)) {
      const e = vis[id];
      colors[id] = [Math.round(e.r / e.px), Math.round(e.g / e.px), Math.round(e.b / e.px)];
    }
    viewData[v] = { list: list, map: map.data, vis: vis, colors: colors, base: baseD };
  }

  /* ---------- 选岛 ----------
   * 判据和一次性探针完全一致：**在带掩膜里的可见像素**够多 + 岛色像不像。
   * 不能用「岛的质心落在哪个带」来判：长发岛的质心常掉到躯干带，
   * 但它明明在头部区域露出很大一块，按质心筛会把它漏掉。 */
  const bandD = {};
  for (const v of views) {
    bandD[v] = {};
    for (const b of Array.from(new Set(specs.map(s => s.band)))) {
      const u = bandMasks[v] && bandMasks[v][b];
      bandD[v][b] = u ? await grab(u) : null;
    }
  }
  const pass = specs.map(sel => {
    if (!selects.includes(sel.key)) return null;
    const acc = {};
    for (const v of views) {
      const vd = viewData[v], bm = bandD[v][sel.band];
      if (!bm) continue;
      for (let p = 0; p < size * size; p++) {
        if (bm[p * 4] < 128) continue;
        const id = vd.map[p * 4] | (vd.map[p * 4 + 1] << 8);
        if (!id) continue;
        const e = acc[id] || (acc[id] = { px: 0, r: 0, g: 0, b: 0, v: v });
        e.px++;
        e.r += vd.base[p * 4]; e.g += vd.base[p * 4 + 1]; e.b += vd.base[p * 4 + 2];
      }
    }
    const ids = [], why = {};
    for (const id of Object.keys(acc)) {
      const e = acc[id];
      if (e.px < sel.minPx) continue;
      const c = [e.r / e.px, e.g / e.px, e.b / e.px];
      if (sel.centroidBands && sel.centroidBands.indexOf(band[id]) < 0) continue;
      /* green：绿不弱于红、且明显高于蓝（浅绿发均值约 147,140,120；
       * 皮肤 / 鹿角是 r 高 g 低，用 g-r 这一条就能把耳朵剔出去）。
       * white：三通道都亮且接近（白裙均值约 216,210,188，不是纯白）。 */
      const ok = sel.test === 'green'
        ? (c[1] - c[0] >= -8 && c[1] - c[2] > 12)
        : (Math.min(c[0], c[1], c[2]) >= 180 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 32);
      if (!ok) continue;
      ids.push(+id);
      why[id] = e.v;
    }
    return { key: sel.key, ids: ids.sort((x, y) => x - y), why: why, bandPx: acc };
  }).filter(Boolean);

  /* ---------- 第二遍：隔离渲染 + 三种掩膜 ---------- */
  const out = { islands: a.islands.length, tris: tot, views: {} };
  for (const v of views) {
    const vd = viewData[v];
    const res = { select: {}, px: size };
    for (const sel of pass) {
      const keep = new Set(sel.ids);
      const tris = vd.list.filter(q => keep.has(q[7]));
      if (!tris.length) continue;
      /* 岛色：优先本视图可见色，没有就借同一岛在别的视图的颜色 */
      const colOf = id => {
        let c = vd.colors[id];
        if (!c) for (const v2 of views) { c = viewData[v2].colors[id]; if (c) break; }
        return c || [190, 190, 190];
      };
      const iso = raster4(tris, 'cover', q => {
        const c = colOf(q[7]);
        return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      });
      /* 白裙和白底几乎同色，隔离图垫灰底才看得见轮廓 */
      const isoPng = (() => {
        const cc = document.createElement('canvas');
        cc.width = cc.height = size;
        const cg = cc.getContext('2d');
        cg.fillStyle = '#9aa0a6';
        cg.fillRect(0, 0, size, size);
        cg.drawImage(iso.canvas, 0, 0);
        return cc.toDataURL('image/png');
      })();
      const sil = iso.cov;

      const visMask = new Uint8Array(size * size);
      let visPx = 0;
      for (let p = 0; p < visMask.length; p++) {
        const id = vd.map[p * 4] | (vd.map[p * 4 + 1] << 8);
        if (!id || !keep.has(id)) continue;
        visMask[p] = 1; visPx++;
      }
      /* 可见区先外扩 2px 再相减：编号图和轮廓图在边界上各有半像素误差，
       * 不相减会把一整圈抗锯齿边当成「洞」送进重绘。 */
      const visDil = dilate(visMask, 1);
      let holes = new Uint8Array(size * size);
      let silPx = 0, holePx = 0;
      for (let p = 0; p < holes.length; p++) {
        if (!sil[p]) continue;
        silPx++;
        if (!visDil[p]) holes[p] = 1;
      }
      holes = filterSmall(holes, 12);
      for (let p = 0; p < holes.length; p++) if (holes[p]) holePx++;

      res.select[sel.key] = {
        ids: sel.ids.length,
        isoPx: silPx,
        visPx: visPx,
        holePx: holePx,
        holePct: silPx ? +(100 * holePx / silPx).toFixed(1) : 0,
        tris: tris.length,
        isoUrl: isoPng,
        silUrl: maskPng(sil),
        holeUrl: maskPng(holes)
      };
    }
    /* 逐岛明细：给阈值调参和文档用 */
    res.islands = Object.keys(vd.vis).map(id => ({
      id: +id, band: band[id], px: vd.vis[id].px, rgb: vd.colors[id]
    })).filter(o => o.px >= 20).sort((A, B) => B.px - A.px);
    out.views[v] = res;
  }
  out.selects = pass.map(s => ({ key: s.key, ids: s.ids, why: s.why }));
  return out;
}`;

async function main() {
  const RUN = runDirFromArg();
  const genDir = path.join(RUN, 'gen');
  const outDir = path.join(RUN, 'islands');
  fs.mkdirSync(outDir, { recursive: true });
  const views = (arg('views', 'front,back')).split(',').map(s => s.trim()).filter(Boolean);
  const keys = (arg('sel', 'hair,skirt')).split(',').map(s => s.trim()).filter(Boolean);

  const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => console.error('[pageerror] ' + ((e && e.message) || e)));
  await page.goto(pathToFileURL(path.join(ROOT, 'multiview.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.Model3D && Model3D.ready && Model3D.ready()), null, { timeout: 30000 });

  const src = 'data:text/plain;base64,' + fs.readFileSync(MODEL).toString('base64');
  const base = {};
  const bandMasks = {};
  for (const v of views) {
    const f = path.join(genDir, 'base_' + v + '.png');
    if (!fs.existsSync(f)) throw new Error('缺少底图 ' + f);
    base[v] = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    bandMasks[v] = {};
    for (const b of new Set(SELECTS.map(s => s.band))) {
      const mf = path.join(RUN, 'parts', v + '_' + b + '.png');
      if (fs.existsSync(mf)) bandMasks[v][b] = 'data:image/png;base64,' + fs.readFileSync(mf).toString('base64');
    }
  }
  const t0 = Date.now();
  const r = await page.evaluate('(' + RASTER + ')(' + JSON.stringify({
    src, views, size: 512, margin: 1.08, selects: keys, specs: SELECTS, base, bandMasks
  }) + ')');

  const summary = { model: path.basename(MODEL), views, islands: r.islands, tris: r.tris, ms: Date.now() - t0, selects: {}, perView: {} };
  for (const s of r.selects) {
    summary.selects[s.key] = { n: s.ids.length, ids: s.ids };
    console.log('[' + s.key + '] 选出 ' + s.ids.length + ' 个岛');
  }
  for (const v of views) {
    const rv = r.views[v];
    summary.perView[v] = {};
    for (const k of Object.keys(rv.select)) {
      const e = rv.select[k];
      for (const [field, suffix] of [['isoUrl', '_iso'], ['silUrl', '_silhouette'], ['holeUrl', '_holes']]) {
        fs.writeFileSync(path.join(outDir, k + '_' + v + suffix + '.png'), Buffer.from(String(e[field]).split(',')[1], 'base64'));
        delete e[field];
      }
      summary.perView[v][k] = e;
      console.log('[' + k + ' / ' + v + '] 岛 ' + e.ids + ' 个 · 完整轮廓 ' + e.isoPx +
        'px · 原图可见 ' + e.visPx + 'px · 被遮挡 ' + e.holePx + 'px (' + e.holePct + '%) · 三角 ' + e.tris);
    }
    fs.writeFileSync(path.join(outDir, 'dump_' + v + '.json'), JSON.stringify(rv.islands, null, 1));
  }
  fs.writeFileSync(path.join(RUN, 'islands.json'), JSON.stringify(summary, null, 2));
  console.log('产物：' + outDir);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
