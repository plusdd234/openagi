#!/usr/bin/env node
/* tools/bench-paint.js —— 绘画链路性能基准（无头，长期资产）
 *
 * 为什么不是「画一笔看看卡不卡」：帧时、上传字节、整图合成次数必须是数字，
 * 每一期优化都用同一份基准对比，禁止用截图或体感验收。
 *
 * 场景：
 *   a = 默认立方体 + 贴图（回归基线）
 *   b = 高模（本 App 面数上限内尽可能密）+ 2048² 底座 + 3 层混合层（目标场景）
 *
 * 用法：
 *   node tools/bench-paint.js                 # 两个场景
 *   node tools/bench-paint.js --scene=b       # 只跑目标场景
 *   node tools/bench-paint.js --rounds=3 --moves=200
 *
 * 指标：
 *   frameP50 / frameP95 / frameMax   rAF 间隔（拖动期间的真实流畅度）
 *   renderP50 / renderP95            单次 renderer.render 的耗时
 *   flushP50 / flushP95              预览纹理上传（texSubImage2D / 整张）耗时
 *   uploadMB                         上传字节（含全量 / 局部拆分）
 *   composeCount                     混合模块整图重算次数（增量合成不计）
 *   commitMs                         抬笔到下一帧（含落盘调度）的停顿
 *
 * 产物只进 .workbuddy/runs/<runId>/。
 */
'use strict';

const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('bench-paint');
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const hit = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const SCENE = arg('scene', 'both');
const ROUNDS = Math.max(1, parseInt(arg('rounds', '3'), 10) || 3);
const MOVES = Math.max(10, parseInt(arg('moves', '200'), 10) || 200);

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const round = (v, n) => Math.round(v * Math.pow(10, n || 2)) / Math.pow(10, n || 2);

/* 打开建模 App（走真实桌面入口） */
async function openDesk(page) {
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.openDeskApp('modeldesk'));
  await page.waitForTimeout(2600);
}

/* 场景准备：换高模 + 写 3 层混合层配置，再让混合模块重新读一遍 */
async function setupScene(page, scene) {
  if (scene !== 'b') return page.evaluate(() => window.modelDesk.getState());
  return page.evaluate(() => {
    const API = window.modelDesk, T = window.THREE;
    /* 本 App 当前的面数上限是 50000 个三角面（seed-mesh-core.js MAX_FACES），
     * 所以「高模」取到上限附近；真正的 20 万面要等 P3 的 BIN 之后再评估。 */
    const geo = new T.SphereGeometry(1, 200, 120);   /* 200×120×2 = 48000 三角 */
    const mesh = window.SeedModel.Mesh.fromBufferGeometry(geo, { name: 'bench-hi' });
    geo.dispose();
    API.applyMesh(mesh, '基准高模');

    const doc = API.getDocument();
    const key = (doc.materials && doc.materials.textureConfigKey) || '';
    const sk = (doc.materials.slotIds || [])[0] || (doc.materials.slotNames || [])[0] || 'slot0';
    const mk = (c1, c2) => {
      const cv = document.createElement('canvas');
      cv.width = 1024; cv.height = 1024;
      const g = cv.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 1024, 1024);
      gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      g.fillStyle = gr; g.fillRect(0, 0, 1024, 1024);
      return cv.toDataURL('image/png');
    };
    const cfg = {
      v: 2, layers: [
        { id: 'bench-L1', name: 'bench1', src: mk('#ff8800', '#ff0088'), opacity: 0.45, blend: 'normal' },
        { id: 'bench-L2', name: 'bench2', src: mk('#0088ff', '#00ff88'), opacity: 0.35, blend: 'multiply' },
        { id: 'bench-L3', name: 'bench3', src: mk('#ffffff', '#000000'), opacity: 0.25, blend: 'screen' }
      ]
    };
    if (key) {
      let all = {};
      try { all = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}') || {}; } catch (e) { all = {}; }
      all[key] = all[key] || {};
      all[key][sk] = cfg;
      localStorage.setItem('openagi_model_tex_v1', JSON.stringify(all));
      /* 层解码是异步的：等合成完成再开始计量，否则测到的是「还没挂上贴图」的空场景 */
      return API.mixRefresh(0).then(() => API.getState());
    }
    return API.getState();
  });
}

/* 跑一段拖动，采帧时 / 渲染 / 上传 / 合成 */
async function measure(page, rounds, moves) {
  return page.evaluate(async ({ rounds, moves }) => {
    const API = window.modelDesk, d = API.__debug(), T = window.THREE;
    const tb = document.querySelector('[data-md-editor-btn="paint"]');
    if (tb) tb.click();
    const set = (id, v, ev) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event(ev, { bubbles: true }));
    };
    set('mdBrushColor', '#ff0000', 'input');
    set('mdBrushOpacity', '100', 'input');
    set('mdBrushSize', '120', 'input');

    const m = d.mesh, canvas = d.canvas, r = canvas.getBoundingClientRect();
    /* 命中测试单独计时：它与帧时解耦，才能判断「高模下 CPU 求交是不是瓶颈」。
     * 在画布上扫一遍网格点（每次换面，粘面快路径不生效），取 p50/p95。 */
    const hitMs = [];
    for (let gy = 0; gy < 10; gy++) {
      for (let gx = 0; gx < 12; gx++) {
        const px = r.width * (0.2 + 0.6 * gx / 11);
        const py = r.height * (0.2 + 0.6 * gy / 9);
        const h0 = performance.now();
        d.paint.rayHit(px, py);
        hitMs.push(performance.now() - h0);
      }
    }
    const camPos = d.camera.getWorldPosition(new T.Vector3());
    /* 找正对相机的那张面的中心：从那里下笔，命中率最高 */
    let bestDot = -Infinity, bestC = null;
    for (let f = 0; f < m.faceIds.length; f++) {
      const s = m.faceOffsets[f], e = m.faceOffsets[f + 1];
      if (e - s < 3) continue;
      const c = new T.Vector3();
      for (let k = s; k < e; k++) {
        const vi = m.faceIndices[k] * 3;
        c.x += m.positions[vi]; c.y += m.positions[vi + 1]; c.z += m.positions[vi + 2];
      }
      c.multiplyScalar(1 / (e - s));
      const a0 = m.faceIndices[s] * 3, a1 = m.faceIndices[s + 1] * 3, a2 = m.faceIndices[s + 2] * 3;
      const v1 = new T.Vector3(m.positions[a1] - m.positions[a0], m.positions[a1 + 1] - m.positions[a0 + 1], m.positions[a1 + 2] - m.positions[a0 + 2]);
      const v2 = new T.Vector3(m.positions[a2] - m.positions[a0], m.positions[a2 + 1] - m.positions[a0 + 1], m.positions[a2 + 2] - m.positions[a0 + 2]);
      const n = new T.Vector3().crossVectors(v1, v2).normalize().transformDirection(d.pivot.matrixWorld);
      const wc = d.pivot.localToWorld(c.clone());
      const dot = n.dot(camPos.clone().sub(wc).normalize());
      if (dot > bestDot) { bestDot = dot; bestC = wc; }
    }
    if (!bestC) return { skip: true };
    const pc = bestC.clone().project(d.camera);
    const x = r.left + (pc.x * 0.5 + 0.5) * r.width;
    const y = r.top + (-pc.y * 0.5 + 0.5) * r.height;

    /* 采样器：帧间隔 / render / 上传 */
    const frames = [], renders = [], flushes = [];
    let raf = 0, stop = false, last = performance.now();
    const loop = (t) => { frames.push(t - last); last = t; if (!stop) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    const origRender = d.renderer.render.bind(d.renderer);
    d.renderer.render = function (sc, cam) {
      const t0 = performance.now();
      origRender(sc, cam);
      renders.push(performance.now() - t0);
    };
    const up = d.upload;
    const origFlush = up ? up.flush.bind(up) : null;
    if (up) {
      up.flush = function () {
        const t0 = performance.now();
        origFlush();
        flushes.push(performance.now() - t0);
      };
      up.resetStats();
    }
    const mix0 = (API.mixStats() || {}).compose || 0;

    const send = (type, cx, cy) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: type === 'pointerup' ? 0 : 0,
      buttons: type === 'pointerup' ? 0 : 1, pointerId: 94, clientX: cx, clientY: cy
    }));
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    let commitMs = 0, commitSyncMs = 0;
    for (let k = 0; k < rounds; k++) {
      /* 每一轮换个起点，避免笔迹全叠在同一块 */
      const sx = x + (k - 1) * 30, sy = y + (k - 1) * 12;
      send('pointerdown', sx, sy);
      await sleep(40);
      for (let i = 1; i <= moves; i++) {
        const t = i / moves;
        send('pointermove', sx + 70 * t, sy + 34 * Math.sin(t * Math.PI));
        await sleep(16);
      }
      /* 同步段（pointerup 全部监听器：入栈 / 历史 / 调度）单独计时：
       * commitMs 里还包含等 2 帧的 ~33ms 下限，不能直接当「主线程停顿」看 */
      const t1 = performance.now();
      send('pointerup', sx + 70, sy);
      commitSyncMs = Math.max(commitSyncMs, performance.now() - t1);
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      commitMs = Math.max(commitMs, performance.now() - t1);
      await sleep(120);
    }
    stop = true;
    if (raf) cancelAnimationFrame(raf);
    await sleep(200);

    d.renderer.render = origRender;
    if (up && origFlush) up.flush = origFlush;
    const upStats = up ? up.stats() : null;
    const mix1 = (API.mixStats() || {}).compose || 0;
    const hs = hitMs.slice().sort((a, b) => a - b);
    const hitP50 = hs.length ? hs[Math.floor(hs.length * 0.5)] : 0;
    const hitP95 = hs.length ? hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.95))] : 0;
    return {
      frameP50: frames.length ? frames.slice().sort((a, b) => a - b)[Math.floor(frames.length * 0.5)] : 0,
      frameP95: frames.length ? frames.slice().sort((a, b) => a - b)[Math.floor(frames.length * 0.95)] : 0,
      frameMax: frames.length ? Math.max.apply(null, frames) : 0,
      frameN: frames.length,
      hitP50, hitP95,
      renderP50: renders.length ? renders.slice().sort((a, b) => a - b)[Math.floor(renders.length * 0.5)] : 0,
      renderP95: renders.length ? renders.slice().sort((a, b) => a - b)[Math.floor(renders.length * 0.95)] : 0,
      flushP50: flushes.length ? flushes.slice().sort((a, b) => a - b)[Math.floor(flushes.length * 0.5)] : 0,
      flushP95: flushes.length ? flushes.slice().sort((a, b) => a - b)[Math.floor(flushes.length * 0.95)] : 0,
      upload: upStats,
      uploadMB: upStats ? +(upStats.bytes / 1048576).toFixed(2) : -1,
      composeCount: mix1 - mix0,
      commitMs: +commitMs.toFixed(1),
      commitSyncMs: +commitSyncMs.toFixed(2),
      tris: m.triCount || (m.faceIndices ? m.faceIndices.length : 0)
    };
  }, { rounds, moves });
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => {
    const m = String(e && e.message);
    /* 合成 PointerEvent 没有真实的指针捕获：OrbitControls 的 releasePointerCapture
     * 会抛 NotFoundError。这是基准的注入方式造成的，不是 App 的缺陷。 */
    if (/releasePointerCapture|setPointerCapture/.test(m)) return;
    errors.push(m);
  });
  const out = {};
  try {
    const scenes = SCENE === 'both' ? ['a', 'b'] : [SCENE];
    for (const s of scenes) {
      await openDesk(page);
      const st = await setupScene(page, s);
      const raw = await measure(page, ROUNDS, MOVES);
      if (raw.skip) { errors.push('场景 ' + s + '：找不到可落笔的面'); continue; }
      out[s] = {
        scene: s, faces: st.faces, vertices: st.vertices,
        frameP50: round(raw.frameP50), frameP95: round(raw.frameP95), frameMax: round(raw.frameMax),
        hitP50: round(raw.hitP50, 3), hitP95: round(raw.hitP95, 3),
        renderP50: round(raw.renderP50, 3), renderP95: round(raw.renderP95, 3),
        flushP50: round(raw.flushP50, 3), flushP95: round(raw.flushP95, 3),
        uploadMB: raw.uploadMB,
        uploadFullMB: raw.upload ? round(raw.upload.fullBytes / 1048576, 2) : -1,
        uploadPartialMB: raw.upload ? round(raw.upload.partialBytes / 1048576, 2) : -1,
        uploads: raw.upload ? raw.upload.uploads : -1,
        uploadPartialEnabled: raw.upload ? raw.upload.enabled : false,
        composeCount: raw.composeCount,
        commitMs: raw.commitMs,
        commitSyncMs: raw.commitSyncMs
      };
      console.log('[' + s + '] ' + JSON.stringify(out[s]));
    }
  } catch (e) {
    errors.push(e && (e.stack || e.message));
  }
  await browser.close().catch(() => {});
  const ok = RUN.finish(errors, { scenes: out, rounds: ROUNDS, moves: MOVES });
  console.log('\n结果：' + path.relative(ROOT, RUN.artifact('result.json')));
  process.exit(ok ? 0 : 1);
})();
