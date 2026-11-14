#!/usr/bin/env node
/* UV 岛 → 语义部件（借用视图工坊里已经写好的两件事）
 *
 *   ① ModelTex.analyze：跨 mesh 的 UV 岛并查集，每岛带 3D 质心 / 包围盒 / UV 面积
 *   ② Model3D.gridCameras：与 viewGrid 完全同一份取景（ortho · margin 1.08）
 *
 * 做的是视图工坊没做的那一步：把「岛」按**世界坐标高度带**归并成语义部件，
 * 再用同一台相机把每个部件投影成屏幕掩膜。岛是天然的分件单位（头发、裙摆、
 * 鞋各自成岛），比按比例切矩形精确得多；投影掩膜又能直接给色块底图 / 级联裁切
 * / 部件度量共用。
 *
 * 部件高度带（相对模型包围盒，0=脚底）：
 *   feet <0.10 · legs 0.10–0.42 · hip 0.42–0.60 · torso 0.60–0.795 · head ≥0.795
 *
 * 输出：每个视图 5 张 512 白黑掩膜 + 调试彩图 + 每部件包围盒/像素数。
 */
'use strict';

const BANDS = ['feet', 'legs', 'hip', 'torso', 'head'];

/* 页面内执行：投影 + 画家算法 + 编号光栅化 + 拆掩膜 */
const RASTER = String.raw`
async function (args) {
  const { src, views, size, margin } = args;
  const a = await ModelTex.analyze(src);
  const m = await Model3D.load(src);
  const bb = a.box;
  const H = bb.max.y - bb.min.y;
  const BANDS = ['feet', 'legs', 'hip', 'torso', 'head'];
  const RV = { feet: 40, legs: 80, hip: 120, torso: 160, head: 200 };
  const BAND_COLOR = { feet: '#ff4fd8', legs: '#ffe14f', hip: '#4f8bff', torso: '#4fff8b', head: '#ff5a4f' };
  const bandOf = t => t >= 0.795 ? 'head' : t >= 0.60 ? 'torso' : t >= 0.42 ? 'hip' : t >= 0.10 ? 'legs' : 'feet';

  const islBand = new Array(a.islands.length);
  a.islands.forEach(o => { islBand[o.id] = bandOf((o.centroid[1] - bb.min.y) / H); });

  /* 每 part 的世界坐标（一次算好，四个视图共用） */
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
  /* 全局三角形偏移，用来查 triIsland */
  const offs = [];
  let tot = 0;
  for (const p of parts) { offs.push(tot); tot += p.tri; }

  const viewOut = {};
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
      return { sx, sy, sz };
    });

    /* 画家算法：远的先画，近的后画（T-pose 前后遮挡靠这一步） */
    const list = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi], q = proj[pi];
      for (let t = 0; t < p.tri; t++) {
        const i0 = p.idx ? p.idx.getX(t * 3) : t * 3;
        const i1 = p.idx ? p.idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = p.idx ? p.idx.getX(t * 3 + 2) : t * 3 + 2;
        const band = islBand[a.triIsland[offs[pi] + t]];
        list.push([q.sx[i0], q.sy[i0], q.sx[i1], q.sy[i1], q.sx[i2], q.sy[i2],
          (q.sz[i0] + q.sz[i1] + q.sz[i2]) / 3, RV[band], a.triIsland[offs[pi] + t]]);
      }
    }
    list.sort((A, B) => A[6] - B[6]);

    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      g.fillStyle = 'rgb(' + q[7] + ',0,0)';
      g.beginPath();
      g.moveTo(q[0], q[1]); g.lineTo(q[2], q[3]); g.lineTo(q[4], q[5]);
      g.closePath();
      g.fill();
    }
    const src32 = g.getImageData(0, 0, size, size).data;

    /* 岛编号图：R=id&255, G=id>>8（2491 个岛，12 位足够）。
     * 有了它，配色可以按「每个岛在原画里的对应位置」取色，而不是一个部件一个纯色。
     *
     * 必须先 4 倍超采样再按块取众数：canvas 画多边形永远带抗锯齿，两条岛边之间的
     * 混色像素会解出**第三个无关的岛 id**，2491 个岛各错一遍就是满屏彩色噪点。
     * 4× 下 AA 只占 1/4 像素、且 alpha<250 被剔除，按 4×4 块取众数就得到无锯齿 id。 */
    const SC = 4;
    const bc = document.createElement('canvas');
    bc.width = bc.height = size * SC;
    const bg4 = bc.getContext('2d');
    bg4.scale(SC, SC);
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      bg4.fillStyle = 'rgb(' + (q[8] & 255) + ',' + ((q[8] >> 8) & 255) + ',0)';
      bg4.beginPath();
      bg4.moveTo(q[0], q[1]); bg4.lineTo(q[2], q[3]); bg4.lineTo(q[4], q[5]);
      bg4.closePath();
      bg4.fill();
    }
    const big = bg4.getImageData(0, 0, size * SC, size * SC).data;
    const ic = document.createElement('canvas');
    ic.width = ic.height = size;
    const ig = ic.getContext('2d');
    const iid = ig.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cnt = {};
        let bestId = -1, bestN = 0;
        for (let dy = 0; dy < SC; dy++) {
          const by = (y * SC + dy) * size * SC;
          for (let dx = 0; dx < SC; dx++) {
            const p = (by + x * SC + dx) * 4;
            if (big[p + 3] < 250) continue;
            const v = big[p] | (big[p + 1] << 8);
            const n = (cnt[v] || 0) + 1;
            cnt[v] = n;
            if (n > bestN) { bestN = n; bestId = v; }
          }
        }
        const o = (y * size + x) * 4;
        if (bestId < 0) continue;
        iid.data[o] = bestId & 255;
        iid.data[o + 1] = (bestId >> 8) & 255;
        iid.data[o + 3] = 255;
      }
    }
    ig.putImageData(iid, 0, 0);

    /* 每岛屏幕质心（岛内三角顶点均值），给 Node 端去原画上取色 */
    const acc = {};
    for (let i = 0; i < list.length; i++) {
      const q = list[i], id = q[8];
      const e = acc[id] || (acc[id] = { n: 0, x: 0, y: 0 });
      e.n++; e.x += (q[0] + q[2] + q[4]) / 3; e.y += (q[1] + q[3] + q[5]) / 3;
    }
    const isl = Object.keys(acc).map(k => ({
      id: +k, px: acc[k].n, band: islBand[+k],
      cx: +(acc[k].x / acc[k].n / size).toFixed(4),
      cy: +(acc[k].y / acc[k].n / size).toFixed(4)
    }));
    /* 编号图只在最后画一次；上面那份按带号画的图只用来拆部件掩膜 */
    const islandUrl = ic.toDataURL('image/png');

    /* 编号 → 5 张掩膜（白=该部件），同时算包围盒/像素数 */
    const masks = {};
    const stats = {};
    for (const b of BANDS) {
      const mc = document.createElement('canvas');
      mc.width = mc.height = size;
      const mg = mc.getContext('2d');
      const id = mg.createImageData(size, size);
      const dd = id.data;
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
      const rv = RV[b];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          if (src32[i + 3] < 128) continue;
          if (Math.abs(src32[i] - rv) > 20) continue;
          dd[i] = dd[i + 1] = dd[i + 2] = 255; dd[i + 3] = 255;
          n++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      mg.putImageData(id, 0, 0);
      masks[b] = mc.toDataURL('image/png');
      stats[b] = n ? { px: n, bbox: { x0, x1, y0, y1 } } : { px: 0, bbox: null };
    }

    /* 调试彩图 */
    const dc = document.createElement('canvas');
    dc.width = dc.height = size;
    const dg = dc.getContext('2d');
    dg.fillStyle = '#ffffff';
    dg.fillRect(0, 0, size, size);
    const dm = dg.createImageData(size, size);
    for (let i = 0; i < src32.length; i += 4) {
      if (src32[i + 3] < 128) { dm.data[i] = dm.data[i + 1] = dm.data[i + 2] = 255; continue; }
      const b = BANDS[Math.round((src32[i] - 40) / 40)] || 'torso';
      const hex = BAND_COLOR[b];
      dm.data[i] = parseInt(hex.slice(1, 3), 16);
      dm.data[i + 1] = parseInt(hex.slice(3, 5), 16);
      dm.data[i + 2] = parseInt(hex.slice(5, 7), 16);
      dm.data[i + 3] = 255;
    }
    dg.putImageData(dm, 0, 0);

    viewOut[v] = {
      masks: masks, stats: stats,
      debug: dc.toDataURL('image/png'),
      islandMap: islandUrl, islands: isl,
      tris: list.length
    };
  }
  return { bands: BANDS, islands: a.islands.length, tris: tot, views: viewOut };
}
`;

async function build(page, src, views, opts) {
  opts = opts || {};
  await page.addScriptTag({ content: 'window.__partsRaster = ' + RASTER + ';' });
  return page.evaluate(a => window.__partsRaster(a), {
    src, views, size: opts.size || 512, margin: opts.margin || 1.08
  });
}

module.exports = { build, BANDS };
