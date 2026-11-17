#!/usr/bin/env node
/* 头发拆件探针：验证「视图语义掩码 → UV 岛归属 → 几何拆件」这条路
 *
 * 跑法：
 *   node tools/probe-hair-split.js                    只出图（灰模视图 + 岛 ID 色调图）
 *   node tools/probe-hair-split.js --masks <dir>      带掩码，算出岛集合并导出 GLB
 *
 * 掩码文件：<dir>/mask-front.png / mask-left.png / mask-back.png / mask-right.png
 *   白（或高亮绿）= 头发，其余 = 非头发；尺寸可以不是 1024，页面里会缩放到画布尺寸。
 *
 * 为什么用「岛 ID 色调图」而不是几何投影：
 *   投影法只能判断「点是否落在屏幕区域里」，判断不了遮挡，也判断不了这个像素到底属于哪个岛。
 *   每个岛一种唯一 RGB、关抗锯齿渲染一张同机位色图后，掩码像素直接查表就是岛编号，
 *   像素级精确，多网格共享 UV 也不受影响。
 *
 * 产物（唯一运行目录）：view-*.png / id-*.png / islands.json / hair.glb / rest.glb / preview.png
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createRun, ROOT } = require('./probe-run');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.obj': 'text/plain', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json'
};

const HARNESS = '<!doctype html><meta charset="utf-8"><title>hair-split</title><body style="margin:0">' +
  ['three.min.js', 'fflate.js', 'NURBSUtils.js', 'NURBSCurve.js', 'OBJLoader.js',
    'GLTFLoader.js', 'FBXLoader.js', 'GLTFExporter.js']
    .map(f => '<script src="/vendor/' + f + '"></script>').join('') +
  ['model3d.js', 'modeltex.js', 'model-split.js']
    .map(f => '<script src="/js/' + f + '"></script>').join('');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : true;
}

const MODEL = String(arg('model', '/assets/models/mwknsjqg-c610820f.obj'));
const MASKS = arg('masks', '');
const MATERIAL = !!arg('material', false);   // 用模型自带贴图渲，而不是灰模
const SIZE = Math.max(256, Math.min(2048, Number(arg('size', 1024)) || 1024));
const VIEWS = String(arg('views', 'front,left,back,right')).split(',').filter(Boolean);

const run = createRun('hair-split');
const errors = [];
let server, browser;

function serve() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/__hair.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HARNESS);
        return;
      }
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403); res.end('no'); return; }
      fs.readFile(f, (e, buf) => {
        if (e) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function dataURLOf(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

/* ---------------- 页面内：分析 + 渲染 ---------------- */

async function initPage(page, model, size, views, material) {
  return page.evaluate(async ({ model, size, views, material }) => {
    const THREE = window.THREE;
    const a = await ModelTex.analyze(model);

    /* ---- 相机：同机位给灰模和 ID 图，两者逐像素对齐 ---- */
    const ext = a.box.getSize(new THREE.Vector3());
    const center = a.center;
    const radius = a.radius;

    function frameL(keys) {
      let best = 0;
      keys.forEach(key => {
        const v = Model3D.VIEWS[key];
        const dl = Math.hypot(v.dir[0], v.dir[1], v.dir[2]) || 1;
        const d = [v.dir[0] / dl, v.dir[1] / dl, v.dir[2] / dl];
        const ul = Math.hypot(v.up[0], v.up[1], v.up[2]) || 1;
        const up = [v.up[0] / ul, v.up[1] / ul, v.up[2] / ul];
        const r = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
        const rl = Math.hypot(r[0], r[1], r[2]) || 1;
        r[0] /= rl; r[1] /= rl; r[2] /= rl;
        const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
        const w = Math.abs(r[0]) * ext.x + Math.abs(r[1]) * ext.y + Math.abs(r[2]) * ext.z;
        const h = Math.abs(u[0]) * ext.x + Math.abs(u[1]) * ext.y + Math.abs(u[2]) * ext.z;
        if (Math.max(w, h) > best) best = Math.max(w, h);
      });
      return Math.max(best, 1e-6) * 1.08;
    }

    function camFor(key, L) {
      const v = Model3D.VIEWS[key];
      const dist = Math.max(radius * 4, 1e-3);
      const half = L / 2;
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, Math.max(dist * 0.004, 1e-4), dist * 4);
      cam.position.set(center.x - v.dir[0] * dist, center.y - v.dir[1] * dist, center.z - v.dir[2] * dist);
      cam.up.set(v.up[0], v.up[1], v.up[2]);
      cam.lookAt(center);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      return cam;
    }

    /* ---- 渲染器：ID 图必须关抗锯齿 + 线性输出，颜色才能原样查表 ---- */
    const rd = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: false });
    rd.setPixelRatio(1);
    rd.setSize(size, size, false);
    rd.outputEncoding = THREE.LinearEncoding;
    rd.toneMapping = THREE.NoToneMapping;
    document.body.appendChild(rd.domElement);

    /* 快照只负责「拷当前缓冲」，不再 clear——clear 放在 render 之前，
     * 否则刚渲完就被清成一张纯背景。 */
    function snapshot() {
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const ctx = cv.getContext('2d');
      ctx.drawImage(rd.domElement, 0, 0);
      return { url: cv.toDataURL('image/png'), ctx };
    }

    /* ---- 灰模场景：给人/给生图模型看的语义视图 ---- */
    const shade = new THREE.Scene();
    shade.background = new THREE.Color(0xeef1f5);
    /* 直接用 analyze 拿到的 root：GLB 带蒙皮时 clone 会丢骨架绑定，渲出来是空气。
     * 探针只跑一次，原地换材质没有副作用。 */
    const src = a.root;
    src.traverse(o => {
      if (!o.isMesh) return;
      if (!material) {
        o.material = new THREE.MeshStandardMaterial({ color: 0xd6dbe3, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      }
      o.frustumCulled = false;
    });
    shade.add(src);
    shade.add(new THREE.AmbientLight(0xffffff, 0.55));
    const l1 = new THREE.DirectionalLight(0xffffff, 0.75); l1.position.set(2, 4, 5); shade.add(l1);
    const l2 = new THREE.DirectionalLight(0xffffff, 0.3); l2.position.set(-3, 2, -4); shade.add(l2);

    /* ---- 岛 ID 几何：每个三角形整块一种颜色 ---- */
    function idColor(id) {
      return [(id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255];
    }
    let triTotal = 0;
    a.islands.forEach(o => { triTotal += o.tris.length; });
    const P = new Float32Array(triTotal * 9), C = new Float32Array(triTotal * 9);
    let p = 0;
    a.islands.forEach(o => {
      const c = idColor(o.id + 1);   // 0 留给背景
      o.tris.forEach(ref => {
        const part = a.parts[ref.part];
        const vi = k => part.idx ? part.idx.getX(ref.t * 3 + k) : ref.t * 3 + k;
        for (let k = 0; k < 3; k++) {
          const i = vi(k);
          const v = new THREE.Vector3(part.pos.getX(i), part.pos.getY(i), part.pos.getZ(i)).applyMatrix4(part.mw);
          P[p] = v.x; P[p + 1] = v.y; P[p + 2] = v.z;
          C[p] = c[0]; C[p + 1] = c[1]; C[p + 2] = c[2];
          p += 3;
        }
      });
    });
    const gid = new THREE.BufferGeometry();
    gid.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    gid.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const idScene = new THREE.Scene();
    idScene.add(new THREE.Mesh(gid, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));

    const L = frameL(views);
    const gl = rd.getContext();

    window.__H = { a, size, views, idPixels: {}, pal: new Map(), prepared: false };
    for (let id = 0; id < a.islands.length; id++) {
      const c = idColor(id + 1);
      window.__H.pal.set((Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255), id);
    }

    const viewsOut = [];
    const debug = [];
    a.root.traverse(o => {
      if (!o.isMesh) return;
      const bb = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
      debug.push({
        type: o.type, visible: o.visible,
        skinned: !!o.isSkinnedMesh,
        parentType: o.parent && o.parent.type,
        box: bb ? bb.min.toArray().concat(bb.max.toArray()).map(v => +v.toFixed(3)) : null,
        worldScale: o.getWorldScale(new THREE.Vector3()).toArray().map(v => +v.toFixed(3))
      });
    });
    for (const key of views) {
      const cam = camFor(key, L);
      rd.setClearColor(new THREE.Color(0xeef1f5), 1);
      rd.render(shade, cam);
      const shot = snapshot();
      /* 非背景像素数：为 0 说明灰模根本没画出来 */
      const sd = shot.ctx.getImageData(0, 0, size, size).data;
      let solid = 0;
      for (let i = 0; i < sd.length; i += 4) {
        if (Math.abs(sd[i] - 238) > 6 || Math.abs(sd[i + 1] - 241) > 6 || Math.abs(sd[i + 2] - 245) > 6) solid++;
      }
      console.log('[render] ' + key + ' 非背景像素=' + solid);

      rd.setClearColor(new THREE.Color(0x000000), 1);
      rd.render(idScene, cam);
      const px = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
      window.__H.idPixels[key] = px;
      const idUrl = snapshot().url;

      /* 每个岛在这个视图里占多少可见像素：后面算「头发像素占比」的分母 */
      const vis = {};
      let idSolid = 0, matched = 0;
      for (let i = 0; i < px.length; i += 4) {
        const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        if (!k) continue;
        idSolid++;
        const id = window.__H.pal.get(k);
        if (id != null) { matched++; vis[id] = (vis[id] || 0) + 1; }
      }
      console.log('[render] ' + key + ' ID 命中色表=' + matched + '/' + idSolid);
      viewsOut.push({ key, shaded: shot.url, id: idUrl, solid, idSolid, visible: vis });
    }
    window.__H.prepared = true;

    const sumArea = a.islands.reduce((s, o) => s + o.area, 0) || 1;
    const H = a.h || 1;
    const min = a.box.min;
    const norm = v => +((v - min.y) / H).toFixed(3);
    const normX = v => +((v - min.x) / Math.max(ext.x, 1e-6)).toFixed(3);

    return {
      tris: triTotal,
      parts: a.parts.length,
      islands: a.islands.length,
      debug,
      bbox: { min: a.box.min.toArray(), max: a.box.max.toArray() },
      list: a.islands.map(o => ({
        id: o.id,
        tris: o.tris.length,
        slot: o.tris[0] ? o.tris[0].part : 0,
        uvPct: +(o.area / sumArea * 100).toFixed(2),
        y: norm(o.centroid[1]),
        x: normX(o.centroid[0]),
        dy: +((o.bbox[4] - o.bbox[1]) / H).toFixed(3)
      })),
      views: viewsOut
    };
  }, { model, size, views, material });
}

/* ---------------- 页面内：掩码 → 岛 ---------------- */

async function applyMasks(page, masks) {
  return page.evaluate(async (masks) => {
    const H = window.__H;
    if (!H || !H.prepared) throw new Error('页面还没准备');

    function loadMask(dataURL) {
      return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = H.size; cv.height = H.size;
          const ctx = cv.getContext('2d');
          ctx.drawImage(im, 0, 0, H.size, H.size);
          resolve(ctx.getImageData(0, 0, H.size, H.size));
        };
        im.onerror = () => reject(new Error('掩码图读不出来'));
        im.src = dataURL;
      });
    }

    const perView = {};
    for (const key of Object.keys(masks)) {
      if (!H.idPixels[key] || !masks[key]) continue;
      const img = await loadMask(masks[key]);
      const d = img.data, px = H.idPixels[key];
      const hit = {}, vis = {};
      const N = H.size * H.size;
      /* 掩码判定：白 / 高亮绿 / 任何高饱和亮色都算「选中」；
       * 生图模型给的掩码常常不是纯色，这里按亮度 + 饱和度双条件放宽。 */
      for (let i = 0; i < N; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const inMask = (g > 140 && g > r + 40 && g > b + 40) || (r > 200 && g > 200 && b > 200);
        const j = (i * 4);
        /* readPixels 是自下而上，掩码图是自上而下：翻一行 */
        const row = Math.floor(i / H.size), col = i % H.size;
        const k = ((H.size - 1 - row) * H.size + col) * 4;
        const key2 = (px[k] << 16) | (px[k + 1] << 8) | px[k + 2];
        if (!key2) continue;
        const id = H.pal.get(key2);
        if (id == null) continue;
        vis[id] = (vis[id] || 0) + 1;
        if (inMask) hit[id] = (hit[id] || 0) + 1;
      }
      perView[key] = { hit, vis };
    }

    /* 每岛跨视图汇总：像素加权占比，比「逐视图平均」更稳（大视图更可信） */
    const rows = [];
    for (let id = 0; id < H.a.islands.length; id++) {
      let hit = 0, vis = 0;
      const per = {};
      Object.keys(perView).forEach(k => {
        const h = perView[k].hit[id] || 0, v = perView[k].vis[id] || 0;
        if (v >= 24) per[k] = +(h / v).toFixed(3);
        hit += h; vis += v;
      });
      if (!vis) continue;
      rows.push({ id, hit, vis, frac: +(hit / vis).toFixed(3), perView: per });
    }
    rows.sort((x, y) => y.frac - x.frac || y.vis - x.vis);
    H.maskRows = rows;
    return { rows: rows, viewCount: Object.keys(perView).length };
  }, masks);
}

/* ---------------- 页面内：拆件 + 导出 ---------------- */

async function exportParts(page, hairIds, name) {
  return page.evaluate(async ({ hairIds, name }) => {
    const H = window.__H;
    const built = ModelSplit.build(H.a, [
      { name: name || '头发', islands: hairIds },
      { name: '其余', islands: [] }
    ]);
    function bufToB64(buf) {
      const u8 = new Uint8Array(buf);
      let s = '', CH = 8192;
      for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      return btoa(s);
    }
    const hair = await ModelSplit.toPartGLB(built, 0);
    const rest = await ModelSplit.toPartGLB(built, 1);
    const preview = ModelSplit.preview(built);
    return {
      hair: bufToB64(hair),
      rest: bufToB64(rest),
      preview,
      stats: built.stats,
      list: built.list.map(p => ({ name: p.name, islands: p.ids.length, tris: p.tris }))
    };
  }, { hairIds, name });
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const port = await serve();
  browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', e => { errors.push(String(e && e.message)); console.error('[pageerror]', e.message); });
  page.on('console', m => {
    if (m.type() === 'error') console.error('[page]', m.text().slice(0, 300));
    else if (/\[render\]/.test(m.text())) console.log('[page]', m.text());
  });

  await page.goto('http://127.0.0.1:' + port + '/__hair.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.THREE && window.Model3D && window.ModelTex && window.ModelSplit, null, { timeout: 30000 });

  console.log('模型:', MODEL, '/ 尺寸:', SIZE, '/ 视图:', VIEWS.join(','));
  const info = await initPage(page, MODEL, SIZE, VIEWS, MATERIAL);
  console.log('三角形:', info.tris, '/ 网格:', info.parts, '/ UV 岛:', info.islands);
  console.log('网格结构:', JSON.stringify(info.debug));

  fs.writeFileSync(run.artifact('islands.json'), JSON.stringify(info.list, null, 2), 'utf8');
  info.views.forEach(v => {
    console.log('  ' + v.key + ' 灰模像素=' + v.solid + ' ID 图像素=' + v.idSolid);
    fs.writeFileSync(run.artifact('view-' + v.key + '.png'), Buffer.from(v.shaded.split(',')[1], 'base64'));
    fs.writeFileSync(run.artifact('id-' + v.key + '.png'), Buffer.from(v.id.split(',')[1], 'base64'));
  });
  console.log('灰模视图 →', run.dir);

  if (!MASKS) {
    await browser.close(); server.close();
    console.log('未给 --masks，只出图。');
    run.finish(errors, { phase: 'render', model: MODEL, islands: info.islands, tris: info.tris });
    process.exit(errors.length ? 1 : 0);
  }

  const masks = {};
  info.views.forEach(v => {
    const f = path.join(String(MASKS), 'mask-' + v.key + '.png');
    if (fs.existsSync(f)) masks[v.key] = dataURLOf(f);
  });
  if (!Object.keys(masks).length) throw new Error('掩码目录里没有 mask-<view>.png：' + MASKS);

  const res = await applyMasks(page, masks);
  const hairIds = res.rows.filter(r => r.frac >= 0.5).map(r => r.id);
  console.log('掩码视图:', Object.keys(masks).join(','));
  console.log('头发候选岛:', hairIds.length, '/ 有可见像素的岛:', res.rows.length);
  console.log('占比最高的 12 个岛:');
  res.rows.slice(0, 12).forEach(r => {
    console.log('  #' + r.id, 'frac=' + r.frac, 'hit=' + r.hit, 'vis=' + r.vis, JSON.stringify(r.perView));
  });
  if (!hairIds.length) throw new Error('掩码没有命中任何岛（检查掩码颜色口径或机位对齐）');

  const out = await exportParts(page, hairIds, '头发');
  fs.writeFileSync(run.artifact('hair.glb'), Buffer.from(out.hair, 'base64'));
  fs.writeFileSync(run.artifact('rest.glb'), Buffer.from(out.rest, 'base64'));
  fs.writeFileSync(run.artifact('preview.png'), Buffer.from(out.preview.split(',')[1], 'base64'));
  run.writeJson('mask-rows.json', res.rows);
  console.log('部件:', JSON.stringify(out.list), '统计:', JSON.stringify(out.stats));
  console.log('产物 →', run.dir);

  await browser.close(); server.close();
  run.finish(errors, {
    phase: 'split', model: MODEL, islands: info.islands, tris: info.tris,
    hairIslands: hairIds.length, parts: out.list
  });
  process.exit(errors.length ? 1 : 0);
})().catch(async e => {
  console.error('失败:', e && e.message || e);
  errors.push(String(e && e.stack || e));
  try { if (browser) await browser.close(); } catch (e2) { }
  try { if (server) server.close(); } catch (e2) { }
  run.finish(errors);
  process.exit(1);
});
