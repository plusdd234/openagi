#!/usr/bin/env node
/* 阶段 1：把资产库里的模型渲成「结构参考图」，并量出语义分割用的轮廓剖面。
 *
 * 产物（全部进本次运行目录，不写死路径）：
 *   struct/color_4v.png   素模（黏土）四视图，白底 —— 喂 img2img 的外观底子
 *   struct/line_4v.png    结构线（外轮廓 + 折角线）—— 喂结构与人工核对
 *   struct/mask_4v.png    遮罩（黑底白模）—— 轮廓 IoU 的唯一真值
 *   struct/depth_4v.png   深度（近白远黑）—— 前后关系参考
 *   struct/manifest.json  每格矩形 + 模型统计 + 轮廓宽度剖面 + 语义节点
 *
 * 用法：node tools/char3d-exp/render.js [模型路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { createRun } = require('../probe-run');

const ROOT = path.resolve(__dirname, '..', '..');
const MODEL = path.resolve(process.argv[2] || path.join(ROOT, 'assets/models/mwdkldbx-8417b5c6.obj'));
const VIEWS = ['front', 'left', 'back', 'right'];
const CELL = 1024;

function dataUrlOf(file, mime) {
  return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
}

/* 与 mv-project 反投时同一份导出布局：4 视图 2×2、无间距、2048 画布。
 * 生图按这个格子出，反投才不会错位。 */
const LAYOUT = { views: VIEWS, cell: CELL, cols: 2, gap: 0, canvasSize: CELL * 2 };

async function main() {
  const RUN = createRun('char3d-render');
  const dir = path.join(RUN.dir, 'struct');
  fs.mkdirSync(dir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'msedge',
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.goto(pathToFileURL(path.join(ROOT, 'multiview.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.Model3D && Model3D.ready && Model3D.ready()), null, { timeout: 30000 });

  const src = dataUrlOf(MODEL, 'text/plain');
  const sm = fs.statSync(MODEL);

  const renders = [
    ['color', { pass: 'color', mode: 'shaded', bg: true, bgColor: '#ffffff', clayColor: '#cfd3da' }],
    ['line', {
      pass: 'color', mode: 'solid', bg: true, bgColor: '#ffffff',
      fillColor: '#ffffff', wire: false, wireAngle: true, wireAngleDeg: 32,
      lineColor: '#1b1b1b', outline: true, lineWidth: 1.6
    }],
    ['mask', { pass: 'mask', mode: 'solid' }],
    ['depth', { pass: 'depth', mode: 'solid' }]
  ];

  const report = { model: path.relative(ROOT, MODEL), bytes: sm.size, layout: LAYOUT, renders: {} };

  for (const [name, opt] of renders) {
    const t0 = Date.now();
    const o = await page.evaluate(async ({ src, opt, LAYOUT }) => {
      const res = await window.Model3D.viewGrid(src, Object.assign({}, opt, {
        views: LAYOUT.views, cell: LAYOUT.cell, cols: LAYOUT.cols,
        gap: LAYOUT.gap, canvasSize: LAYOUT.canvasSize, labels: false
      }));
      return {
        png: res.png, width: res.width, height: res.height,
        cells: res.cells, stats: res.stats, format: res.format,
        padX: res.padX, padY: res.padY
      };
    }, { src, opt, LAYOUT });
    const buf = Buffer.from(String(o.png).split(',')[1], 'base64');
    fs.writeFileSync(path.join(dir, name + '_4v.png'), buf);
    report.renders[name] = {
      file: 'struct/' + name + '_4v.png', bytes: buf.length,
      width: o.width, height: o.height, ms: Date.now() - t0
    };
    report.cells = o.cells;
    report.stats = o.stats;
    report.format = o.format;
    console.log('[render] ' + name + ' ' + o.width + 'x' + o.height + ' ' +
      (buf.length / 1024).toFixed(0) + 'KB ' + (Date.now() - t0) + 'ms');
  }

  /* ---- 语义树：从遮罩的逐行宽度剖面推关键分割位 ----
   * 不写死比例，让轮廓自己说话：脖子 = 上段最细处，肩 = 脖子下方最宽处，
   * 腰 = 中段最细处，髋 = 腰下方最宽处，脚踝 = 末段最细处。
   * 结果只保存**相对包围盒的比例**，换任何分辨率 / 换到原画坐标系都能直接映射。 */
  const maskB64 = fs.readFileSync(path.join(dir, 'mask_4v.png')).toString('base64');
  const profiles = await page.evaluate(async ({ b64, cells }) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = 'data:image/png;base64,' + b64;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const out = {};
    for (const cell of cells) {
      const d = g.getImageData(cell.x, cell.y, cell.w, cell.h).data;
      const rows = [];
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (let y = 0; y < cell.h; y++) {
        let n = 0, sx = 0, lo = 1e9, hi = -1;
        for (let x = 0; x < cell.w; x++) {
          if (d[(y * cell.w + x) * 4] <= 127) continue;
          n++; sx += x;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        if (hi >= 0) {
          if (lo < x0) x0 = lo;
          if (hi > x1) x1 = hi;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        rows.push(hi >= 0 ? { n: n, lo: lo, hi: hi, cx: Math.round(sx / n) } : { n: 0, lo: -1, hi: -1, cx: -1 });
      }
      out[cell.key] = { w: cell.w, h: cell.h, bbox: { x0, x1, y0, y1 }, rows };
    }
    return out;
  }, { b64: maskB64, cells: report.cells });

  /* 单视图剖面 → 语义节点（比例坐标，0~1 相对包围盒） */
  function landmarks(p) {
    const b = p.bbox, H = b.y1 - b.y0 + 1;
    const W = p.w;
    const at = f => Math.max(0, Math.min(p.h - 1, Math.round(b.y0 + f * H)));
    const widthAt = y => (p.rows[y].n ? p.rows[y].hi - p.rows[y].lo + 1 : 0);
    const pick = (f0, f1, mode) => {
      let best = at(f0), bestV = mode === 'min' ? 1e9 : -1;
      for (let y = at(f0); y <= at(f1); y++) {
        const v = widthAt(y);
        if (!v) continue;
        if (mode === 'min' ? v < bestV : v > bestV) { bestV = v; best = y; }
      }
      return (best - b.y0) / H;
    };
    const f = {};
    f.top = 0;
    /* 颈部搜索必须从 0.10 起：鹿角/发顶比头还宽，从 0.13 起会把「头顶最细处」
     * 误当脖子，导致 head 节点只到大角，脸被切在外面。 */
    f.neck = pick(0.10, 0.32, 'min');
    f.shoulder = pick(f.neck, Math.min(0.98, f.neck + 0.13), 'max');
    f.waist = pick(0.40, 0.60, 'min');
    f.hip = pick(f.waist, Math.min(0.98, f.waist + 0.13), 'max');
    f.ankle = pick(0.86, 0.99, 'min');
    f.bottom = 1;
    /* 横向：按行区间内的左右边界给每个部件的 x 区间，避免手写比例 */
    const span = (fa, fb) => {
      let lo = W, hi = -1;
      for (let y = at(fa); y <= at(fb); y++) {
        const r = p.rows[y];
        if (!r.n) continue;
        if (r.lo < lo) lo = r.lo;
        if (r.hi > hi) hi = r.hi;
      }
      return { x0: +(lo / W).toFixed(4), x1: +((hi + 1) / W).toFixed(4) };
    };
    return {
      bboxFrac: { x0: +(b.x0 / W).toFixed(4), x1: +((b.x1 + 1) / W).toFixed(4), y0: 0, y1: 1 },
      y: {
        head: [f.top, f.neck], shoulder: [f.neck, f.shoulder],
        torso: [f.shoulder, f.hip], hip: [f.hip, f.hip + 0.06],
        legs: [f.hip + 0.06, f.ankle], feet: [f.ankle, f.bottom]
      },
      x: {
        head: span(f.top, f.neck), shoulder: span(f.shoulder, f.shoulder + 0.01),
        torso: span(f.shoulder, f.hip), legs: span(f.hip + 0.06, f.ankle)
      },
      raw: f
    };
  }

  report.profile = {};
  report.tree = {};
  for (const k of VIEWS) {
    const p = profiles[k];
    if (!p || p.bbox.x1 < 0) { report.profile[k] = null; continue; }
    const b = p.bbox;
    /* 只保留每 4 行一条，manifest 不该有 4×1024 条数据 */
    report.profile[k] = {
      w: p.w, h: p.h, bbox: b,
      rows: p.rows.filter((_, i) => i % 4 === 0).map(r => [r.n, r.lo, r.hi])
    };
    report.tree[k] = landmarks(p);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(report, null, 2));
  await browser.close();
  RUN.finish(errors, { dir: RUN.dir });
  console.log('run dir: ' + RUN.dir);
  if (errors.length) console.log('page errors: ' + errors.slice(0, 3).join(' | '));
}

main().catch(e => { console.error(e); process.exit(1); });
