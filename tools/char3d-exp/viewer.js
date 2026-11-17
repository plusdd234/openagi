#!/usr/bin/env node
/* 生成自包含的 3D 查看器：OBJ + 两张 2048 贴图 + 逐岛高亮层，全部内嵌
 *
 *   node tools/char3d-exp/viewer.js --run <dir> [--shot]
 *
 * 为什么内嵌而不是引用文件：OBJLoader 走 fetch，file:// 下会被浏览器拦掉。
 * 把 OBJ 转成 base64 塞进 <script>，再用 OBJLoader.parse 解析，双击就能看；
 * 贴图走 data URL，CanvasTexture 不需要网络。
 *
 * 高亮层是 UV 空间的：把选中岛的 UV 三角直接画到 2048 画布上（v 轴按 OBJ 的
 * flipY 约定翻转），运行时和贴图合成，所以切贴图时高亮不会丢。
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
  return path.join(base, list[list.length - 1]);
}

const HILITE = String.raw`
async function (args) {
  const { src, hair, skirt, size } = args;
  const a = await ModelTex.analyze(src);
  const H = new Set(hair), S = new Set(skirt);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const offs = [];
  let tot = 0;
  for (const p of a.parts) { offs.push(tot); tot += p.tri; }
  const tri = (p, t, k) => p.idx ? p.idx.getX(t * 3 + k) : t * 3 + k;
  let nH = 0, nS = 0;
  for (let pi = 0; pi < a.parts.length; pi++) {
    const p = a.parts[pi];
    if (!p.uv) continue;
    for (let t = 0; t < p.tri; t++) {
      const id = a.triIsland[offs[pi] + t];
      const isH = H.has(id), isS = S.has(id);
      if (!isH && !isS) continue;
      if (isH) nH++; else nS++;
      g.fillStyle = isH ? 'rgba(46,204,113,0.62)' : 'rgba(52,152,219,0.62)';
      g.beginPath();
      for (let k = 0; k < 3; k++) {
        const vi = tri(p, t, k);
        /* OBJ 约定 flipY=true：UV v=0 在画布底边 */
        const x = p.uv.getX(vi) * size;
        const y = (1 - p.uv.getY(vi)) * size;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
    }
  }
  return { url: c.toDataURL('image/png'), nH: nH, nS: nS, hasUv: !!a.parts[0].uv };
}`;

const MAIN = String.raw`
(function () {
  var D = window.DATA;
  var cv = document.getElementById('cv');
  var renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  else if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x171b20);
  var cam = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.01, 4000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  var key = new THREE.DirectionalLight(0xffffff, 0.55); key.position.set(1.2, 2.2, 2.4); scene.add(key);
  var rim = new THREE.DirectionalLight(0xbfe3ff, 0.35); rim.position.set(-2, 1.2, -1.6); scene.add(rim);

  /* 贴图合成画布：切贴图 / 开高亮都只是重画这一张 */
  var W = 2048;
  var tc = document.createElement('canvas');
  tc.width = tc.height = W;
  var tctx = tc.getContext('2d');
  var tex = new THREE.CanvasTexture(tc);
  tex.flipY = true;
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;

  var mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, side: THREE.DoubleSide });

  var imgs = {};
  var ready = 0;
  ['A', 'B', 'HL'].forEach(function (k) {
    var im = new Image();
    im.onload = function () { ready++; if (ready === 3) start(); };
    im.src = D['tex' + k];
    imgs[k] = im;
  });

  var state = { tex: 'B', hl: false };
  function paint() {
    tctx.clearRect(0, 0, W, W);
    tctx.drawImage(imgs[state.tex], 0, 0, W, W);
    if (state.hl) tctx.drawImage(imgs.HL, 0, 0, W, W);
    tex.needsUpdate = true;
  }

  var root, ctl;
  function start() {
    var bin = atob(D.obj);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    var txt = new TextDecoder('utf-8').decode(u8);
    root = new THREE.OBJLoader().parse(txt);
    root.traverse(function (o) { if (o.isMesh) { o.material = mat; } });
    scene.add(root);

    var box = new THREE.Box3().setFromObject(root);
    var size = box.getSize(new THREE.Vector3());
    var ctr = box.getCenter(new THREE.Vector3());
    root.position.sub(ctr);

    var grid = new THREE.GridHelper(Math.max(size.x, size.z) * 2.4, 24, 0x2a3038, 0x22272d);
    grid.position.y = -size.y / 2;
    scene.add(grid);

    /* 这个模型正面朝 +Z（贴图烘焙用的也是这套视图）。
     * 用包围球算距离，比按最大边长拍脑袋稳：任何比例都不会切头切脚。 */
    var d = Math.max(size.x, size.y, size.z);
    var r = box.getBoundingSphere(new THREE.Sphere()).radius;
    var dist = r / Math.sin(cam.fov * Math.PI / 360) * 1.02;
    cam.position.set(dist * 0.12, dist * 0.03, dist);
    ctl = new THREE.OrbitControls(cam, renderer.domElement);
    ctl.target.set(0, 0, 0);
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.08;
    ctl.minDistance = d * 0.25;
    ctl.maxDistance = d * 4.5;
    ctl.update();

    paint();
    document.getElementById('load').style.display = 'none';
    animate();
  }

  function animate() {
    requestAnimationFrame(animate);
    if (ctl) ctl.update();
    renderer.render(scene, cam);
  }

  window.addEventListener('resize', function () {
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  document.getElementById('btnTex').onclick = function () {
    state.tex = state.tex === 'B' ? 'A' : 'B';
    this.textContent = state.tex === 'B' ? '贴图：补全版' : '贴图：原始版';
    this.className = state.tex === 'B' ? 'on' : '';
    paint();
  };
  document.getElementById('btnHl').onclick = function () {
    state.hl = !state.hl;
    this.className = state.hl ? 'on' : '';
    this.textContent = state.hl ? '逐岛高亮：开' : '逐岛高亮：关';
    paint();
  };
})();
`;

const CSS = `
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#171b20;overflow:hidden;
font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#e8edf3}
#cv{display:block;width:100%;height:100%}
#hud{position:fixed;left:18px;bottom:18px;z-index:5;background:rgba(22,27,33,.86);
border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px 16px;min-width:250px;
backdrop-filter:blur(8px);box-shadow:0 8px 30px rgba(0,0,0,.45)}
#hud h1{font-size:14px;margin:0 0 4px;font-weight:600;letter-spacing:.02em}
#hud p{font-size:11.5px;margin:0 0 10px;color:#93a1b0;line-height:1.6}
#hud button{display:block;width:100%;margin:6px 0 0;padding:8px 10px;border-radius:8px;cursor:pointer;
border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#dfe7ef;font-size:12px;
transition:background .15s,border-color .15s}
#hud button:hover{background:rgba(255,255,255,.1)}
#hud button.on{background:rgba(70,180,120,.22);border-color:rgba(70,180,120,.55);color:#c9f3dc}
#stat{margin:10px 0 0;font-size:11px;color:#8b98a6;line-height:1.7;border-top:1px solid rgba(255,255,255,.08);padding-top:9px}
#stat b{color:#cfe3f5;font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
#hint{position:fixed;right:16px;bottom:14px;font-size:11px;color:#6f7d8c;z-index:5}
#load{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
background:#171b20;color:#8b98a6;font-size:13px;z-index:9}
`;

async function main() {
  const RUN = runDirFromArg();
  const isl = JSON.parse(fs.readFileSync(path.join(RUN, 'islands.json'), 'utf8'));
  const cmp = JSON.parse(fs.readFileSync(path.join(RUN, 'complete.json'), 'utf8'));
  const hair = isl.selects.hair.ids;
  const skirt = isl.selects.skirt.ids;

  const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(pathToFileURL(path.join(ROOT, 'multiview.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.Model3D && Model3D.ready && Model3D.ready()), null, { timeout: 30000 });
  const src = 'data:text/plain;base64,' + fs.readFileSync(MODEL).toString('base64');
  const hl = await page.evaluate('(' + HILITE + ')(' + JSON.stringify({ src, hair, skirt, size: 2048 }) + ')');
  fs.writeFileSync(path.join(RUN, 'bake/highlight.png'), Buffer.from(hl.url.split(',')[1], 'base64'));
  console.log('高亮层：头发三角 ' + hl.nH + ' · 裙摆三角 ' + hl.nS);

  const texA = 'data:image/png;base64,' + fs.readFileSync(path.join(RUN, 'bake/H_texture.png')).toString('base64');
  const texB = 'data:image/png;base64,' + fs.readFileSync(path.join(RUN, 'bake/IS_texture.png')).toString('base64');
  const obj = fs.readFileSync(MODEL).toString('base64');
  const vendor = name => fs.readFileSync(path.join(ROOT, 'vendor', name), 'utf8');

  const steps = cmp.steps.map(s =>
    s.part + '/' + s.view + ' 洞 ' + s.holePx + 'px · 色差 ' + s.dist
  ).join(' ｜ ');

  const html = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>角色 3D · UV 岛遮挡补全对照</title><style>' + CSS + '</style></head><body>' +
    '<canvas id="cv"></canvas>' +
    '<div id="hud"><h1>UV 岛遮挡补全 · 对照</h1>' +
    '<p>补全只改被别的岛挡住的那一块，可见像素保持原样。<br>绿=头发岛，蓝=裙摆岛。</p>' +
    '<button id="btnTex" class="on">贴图：补全版</button>' +
    '<button id="btnHl">逐岛高亮：关</button>' +
    '<div id="stat"><span class="dot" style="background:#2ecc71"></span>头发岛 <b>' + hair.length + '</b> 个 · ' +
    '<span class="dot" style="background:#3498db"></span>裙摆岛 <b>' + skirt.length + '</b> 个<br>' + steps + '</div></div>' +
    '<div id="hint">左键旋转 · 滚轮缩放 · 右键平移</div>' +
    '<div id="load">正在加载模型…</div>' +
    '<script>' + vendor('three.min.js') + '</script>' +
    '<script>' + vendor('OBJLoader.js') + '</script>' +
    '<script>' + vendor('OrbitControls.js') + '</script>' +
    '<script>window.DATA={obj:"' + obj + '",texA:"' + texA + '",texB:"' + texB + '",texHL:"' + hl.url + '"};</script>' +
    '<script>' + MAIN + '</script>' +
    '</body></html>';

  const out = path.join(RUN, 'viewer.html');
  fs.writeFileSync(out, html);
  console.log('查看器：' + out + '（' + (html.length / 1048576).toFixed(1) + ' MB）');

  if (process.argv.indexOf('--shot') > 0) {
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = [];
    p2.on('pageerror', e => errs.push(String((e && e.message) || e)));
    await p2.goto(pathToFileURL(out).href, { waitUntil: 'load' });
    await p2.waitForTimeout(5000);
    const shots = [];
    const snap = async name => {
      const f = path.join(RUN, name);
      await p2.screenshot({ path: f });
      shots.push(path.basename(f));
    };
    await snap('viewer_done.png');
    await p2.click('#btnTex'); await p2.waitForTimeout(500);
    await snap('viewer_base.png');
    await p2.click('#btnTex'); await p2.click('#btnHl'); await p2.waitForTimeout(500);
    await snap('viewer_hl.png');
    const ok = await p2.evaluate(() => {
      const l = document.getElementById('load');
      return { loading: l && l.style.display !== 'none', canvas: !!document.querySelector('#cv') };
    });
    console.log('截图：' + shots.join(' / ') + ' ' + JSON.stringify(ok) + (errs.length ? ' 错误：' + errs.join(' | ') : ''));
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
