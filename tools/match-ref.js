/* 对图：模型剪影 vs 参考图剪影，出精确差值表（不靠截图观感）
 *
 * 用法：
 *   node tools/match-ref.js --ref=<参考图> [--spec=tools/_out/sv2/spec-r2.json] [--out=dir]
 *   node tools/match-ref.js --ref=<参考图> --glb=<模型.glb>
 * 产物：metrics.json（IoU / 分带宽度比 / 最差 4 段）+ overlay.png（绿=参考 红=模型 琥珀=重合）
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const REF = arg('ref', '');
const SPEC = arg('spec', '');
const GLB = arg('glb', '');
const OUT = path.resolve(ROOT, arg('out', 'tools/_out/match'));

(async () => {
  if (!REF) throw new Error('缺少 --ref=<参考图>');
  if (!SPEC && !GLB) throw new Error('需要 --spec=<规格.json> 或 --glb=<模型.glb>');
  fs.mkdirSync(OUT, { recursive: true });

  const b = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 900, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e && e.message)));
  await p.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await p.waitForFunction(() => typeof Silhouette !== 'undefined' && typeof Modeler !== 'undefined', null, { timeout: 20000 });

  /* 模型剪影：正交相机 + 纯黑材质 + 透明背景。
   * 为什么用黑色而不是白色：剪影提取走「亮=背景」的泛洪，白模型会被当成背景吞掉。 */
  const modelMask = await p.evaluate(async ([spec, glbData]) => {
    let dataURL = glbData;
    if (!dataURL) {
      const built = await Modeler.build(spec);
      dataURL = built.dataURL;
    }
    const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(dataURL, res, undefined, rej));
    const root = gltf.scene;
    root.traverse(o => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: 0x000000 }); });
    const S = 900;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setSize(S, S); renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(root);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    const pad = 1.02;
    const halfH = (size.y / 2) * pad;
    const halfW = Math.max(size.x / 2, size.y / 2) * pad;   // 保持方形视口，避免非等比
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 1000);
    cam.position.set(ctr.x, ctr.y, box.max.z + Math.max(size.z, 1) * 2);
    cam.lookAt(ctr.x, ctr.y, ctr.z);
    renderer.render(scene, cam);
    /* WebGL 画布没有 2d context，必须 drawImage 到一张 2D 画布上再取像素 */
    const flat = document.createElement('canvas');
    flat.width = renderer.domElement.width; flat.height = renderer.domElement.height;
    const fctx = flat.getContext('2d');
    fctx.drawImage(renderer.domElement, 0, 0);
    const img = fctx.getImageData(0, 0, flat.width, flat.height);
    /* 只留 alpha：剪影边界由 alpha 决定，天然抗锯齿 */
    const m = Silhouette.maskFromImage(img);
    return { mask: Array.from(m.mask), w: m.w, h: m.h, count: m.count, bbox: m.bbox };
  }, [SPEC ? JSON.parse(fs.readFileSync(path.resolve(ROOT, SPEC), 'utf8')) : null, GLB ? 'data:model/gltf-binary;base64,' + fs.readFileSync(path.resolve(ROOT, GLB)).toString('base64') : '']);

  const refURL = 'data:image/' + (/\.png$/i.test(REF) ? 'png' : 'jpeg') + ';base64,' + fs.readFileSync(REF).toString('base64');
  const PICK = Math.max(0, Number(arg('pick', 0)) || 0);
  /* 参考图常常是「正面 + 背面」并排。整图取剪影会把两个人连成一块，
   * 宽度直接翻倍、所有比值全错。先按「空列」把画面切成若干个人物，再取指定的那个。 */
  const refMask = await p.evaluate(async ([url, pick]) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const probe = Silhouette.maskFromImage(ctx.getImageData(0, 0, cv.width, cv.height));
    const colHas = new Array(probe.w).fill(0);
    for (let y = 0; y < probe.h; y++) for (let x = 0; x < probe.w; x++) if (probe.mask[y * probe.w + x]) colHas[x] = 1;
    const gapMin = Math.max(6, Math.round(probe.w * 0.01));
    const segs = [];
    let start = -1, gap = 0;
    for (let x = 0; x < probe.w; x++) {
      if (colHas[x]) { if (start < 0) start = x; gap = 0; }
      else if (start >= 0) { gap++; if (gap >= gapMin) { segs.push([start, x - gap]); start = -1; gap = 0; } }
    }
    if (start >= 0) segs.push([start, probe.w - 1]);
    let out = probe;
    if (segs.length > 1) {
      const seg = segs[Math.min(pick, segs.length - 1)];
      const cw = seg[1] - seg[0] + 1;
      const sub = document.createElement('canvas');
      sub.width = cw; sub.height = probe.h;
      sub.getContext('2d').drawImage(cv, seg[0], 0, cw, probe.h, 0, 0, cw, probe.h);
      out = Silhouette.maskFromImage(sub.getContext('2d').getImageData(0, 0, cw, probe.h));
    }
    return { mask: Array.from(out.mask), w: out.w, h: out.h, count: out.count, bbox: out.bbox, segs: segs.length };
  }, [refURL, PICK]);

  const toMask = o => ({ mask: Uint8Array.from(o.mask), w: o.w, h: o.h, count: o.count, bbox: o.bbox });

  const result = await p.evaluate(([a, b2]) => {
    const A = { mask: Uint8Array.from(a.mask), w: a.w, h: a.h, count: a.count, bbox: a.bbox };
    const B = { mask: Uint8Array.from(b2.mask), w: b2.w, h: b2.h, count: b2.count, bbox: b2.bbox };
    const m = Silhouette.compare(A, B, { height: 480 });
    const cv = Silhouette.overlay(A, B, 480);
    return { metrics: m, png: cv.toDataURL('image/png') };
  }, [refMask, modelMask]);

  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(result.metrics, null, 1));
  fs.writeFileSync(path.join(OUT, 'overlay.png'), Buffer.from(result.png.split(',')[1], 'base64'));

  const M = result.metrics;
  console.log('参考剪影 ' + refMask.count + ' px · 模型剪影 ' + modelMask.count + ' px');
  console.log('IoU ' + M.iou + ' · 覆盖参考 ' + (M.coverOfRef * 100).toFixed(1) + '% · 溢出 ' + (M.spillOver * 100).toFixed(1) + '%');
  console.log('体量：参考 ' + M.fillRef + ' vs 模型 ' + M.fillModel + ' · 宽高比 参考 ' + M.refAspect + ' vs 模型 ' + M.modelAspect);
  console.log('最宽处：参考 ' + M.widest.ref.w + '@y' + M.widest.ref.y + ' · 模型 ' + M.widest.model.w + '@y' + M.widest.model.y);
  console.log('\n高度带(y=0 头顶)   参考宽   模型宽   比值   偏差');
  M.bands.forEach(x => {
    const pct = x.deltaPct == null ? '  —' : (x.deltaPct > 0 ? '+' : '') + x.deltaPct + '%';
    console.log(('  ' + x.yFrom.toFixed(2) + '–' + x.yTo.toFixed(2)).padEnd(18) +
      String(x.refW).padEnd(9) + String(x.modelW).padEnd(9) + String(x.ratio == null ? '—' : x.ratio).padEnd(7) + pct);
  });
  console.log('\n差得最多的四段：');
  M.worst.forEach(x => console.log('  ' + x.yFrom.toFixed(2) + '–' + x.yTo.toFixed(2) + '　' + (x.deltaPct > 0 ? '宽了 ' : '窄了 ') + Math.abs(x.deltaPct) + '%'));
  console.log('\n→ ' + OUT + '（metrics.json / overlay.png）');
  if (errs.length) console.log('页面错误：' + errs.join(' | '));
  await b.close();
})();
