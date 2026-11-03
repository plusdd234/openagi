/* 图像转 SVG：多层测试跑测（F / I / C / D 的基础设施验收）
 *
 * 做什么：把 js/svg-fixtures.js 的合成夹具逐张喂给工具层，用一条**固定的脚本流程**
 * （inspect → 逐层 trace → 写文字 → compare → layer_report(消融) → validate）
 * 产出 SVG，再把结果和分层真值比对。
 *
 * 为什么不用模型：这里验收的是工具/渲染/度量，不是 Astra 的画功。
 * 输入固定 → 结果必须逐字节一致；任何抖动都说明基础设施有问题。
 *
 * 产出：tools/shots/svg-multilayer-report.json（含 DET 版本、每层 IoU、遮挡、消融、
 * 导出字节、确定性结论），控制台打印一张表。
 *
 * 跑法：node tools/svg-multilayer.js [--verbose]
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TARGET = pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1';
const OUT_DIR = path.join(__dirname, 'shots');
const OUT_FILE = path.join(OUT_DIR, 'svg-multilayer-report.json');
const VERBOSE = process.argv.includes('--verbose');
/* 脚本流程的及格线：低于它说明工具链路已经坏了，不是「模型画得不够好」 */
const MIN_SCORE = 0.55;

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + ((e && e.message) || e)));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(
    () => typeof window.svgToolRun === 'function' && typeof window.svgFixtureTruth === 'function',
    null, { timeout: 20000 });

  const det = await page.evaluate(() => window.svgDeterminism());

  const report = await page.evaluate(async (minScore) => {
    const LAYERS = window.svgLayerIds;

    function loadImage(url) {
      return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('图片解码失败'));
        img.src = url;
      });
    }

    /* 统一把任意 PNG 开到比对分辨率，再取 alpha 掩膜（与运行时 minAlpha 一致） */
    async function maskAt(url, cw, ch) {
      const img = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, cw, ch);
      const d = g.getImageData(0, 0, cw, ch).data;
      const m = new Uint8Array(cw * ch);
      let painted = 0;
      for (let p = 0; p < m.length; p++) {
        if (d[p * 4 + 3] >= window.SVG_DET.minAlpha) { m[p] = 1; painted++; }
      }
      return { mask: m, painted: painted, px: cw * ch };
    }

    /* 三层指标：IoU 看整体重合，precision 看「多画了多少」，recall 看「漏了多少」。
       分层 IoU 被污染时会很低，precision/recall 才能说清是画多了还是没画到。
       真值层是空的（painted=0）时这三个比值都没有意义，一律记 null，不参与断言。 */
    function overlap(a, b) {
      let inter = 0, union = 0, onlySvg = 0, onlyTruth = 0;
      for (let i = 0; i < a.length; i++) {
        const t = a[i], s = b[i];
        if (t && s) inter++;
        else if (s) onlySvg++;
        else if (t) onlyTruth++;
        if (t || s) union++;
      }
      const hasTruth = inter + onlyTruth;
      const hasSvg = inter + onlySvg;
      return {
        iou: union ? Math.round(inter / union * 1000) / 1000 : null,
        precision: hasSvg ? Math.round(inter / hasSvg * 1000) / 1000 : null,
        recall: hasTruth ? Math.round(inter / hasTruth * 1000) / 1000 : null,
        extra: onlySvg, missed: onlyTruth
      };
    }

    function textMarkup(fid, lay) {
      const bb = lay.bbox;
      const size = Math.max(10, Math.round(bb.h * 0.8));
      return '<text data-text="' + (lay.text || fid) + '" data-source-bbox="'
        + [bb.x, bb.y, bb.w, bb.h].join(',') + '"'
        + ' x="' + bb.x + '" y="' + (bb.y + bb.h) + '"'
        + ' font-family="sans-serif" font-size="' + size + '"'
        + ' fill="#233240">' + (lay.text || fid) + '</text>';
    }

    /* 固定脚本流程：不调用模型。层归属直接用真值的分层包围盒，专测工具链路。 */
    async function runPipeline(fid) {
      const truth = window.svgFixtureTruth(fid);
      const img = await loadImage(truth.dataUrl);
      window.svgSetSource(img, { name: fid });
      const draft = window.svgDraftNew(truth.w, truth.h, { name: fid });
      const calls = [];
      const call = async (name, args) => {
        const r = await window.svgToolRun(name, Object.assign({ draft_id: draft }, args || {}));
        calls.push(name);
        return r;
      };

      await call('inspect_raster');
      for (const lay of truth.layers) {
        if (!lay.painted || !lay.bbox) continue;
        if (lay.id === 'layer-text') {
          await call('validate_svg', { append: { layer: 'layer-text', markup: textMarkup(fid, lay) } });
          continue;
        }
        await call('trace_region', {
          region: lay.bbox,
          layer: lay.id,
          palette_size: Math.min(16, Math.max(2, lay.colors.length + 2)),
          simplify: window.SVG_DET.simplify,
          min_area: 20,
          max_paths: 160
        });
      }
      const compare = await call('render_svg_compare');
      const layerReport = await call('layer_report', { with_ablation: true });
      const validate = await call('validate_svg');
      return {
        truth: truth, draft: draft, calls: calls,
        compare: compare, layerReport: layerReport, validate: validate,
        svg: window.svgDraftToSvg(draft)
      };
    }

    async function measure(fid) {
      const a = await runPipeline(fid);
      const b = await runPipeline(fid);      // 同输入再跑一遍：必须逐字节一致
      const sameSvg = a.svg === b.svg;
      const sameScore = a.compare.global_score === b.compare.global_score
        && JSON.stringify(a.layerReport.ablation) === JSON.stringify(b.layerReport.ablation);

      const cw = b.compare.evaluated_at[0], ch = b.compare.evaluated_at[1];
      const layerRows = [];
      for (const lay of b.truth.layers) {
        const tm = await maskAt(lay.layerPng, cw, ch);
        const png = await window.svgDraftPng(b.draft, { layer: lay.id, maxSide: window.SVG_DET.refMaxSide, transparent: true });
        const pm = await maskAt(png, cw, ch);
        const st = b.layerReport.layers.find(l => l.layer === lay.id) || {};
        const ov = overlap(tm.mask, pm.mask);
        layerRows.push({
          id: lay.id,
          empty_truth: tm.painted === 0,
          truth_painted: tm.painted,
          svg_painted: pm.painted,
          truth_ratio: lay.ratio,
          svg_ratio: Math.round(pm.painted / pm.px * 1000) / 1000,
          iou: ov.iou,
          precision: ov.precision,
          recall: ov.recall,
          extra_px: ov.extra,
          missed_px: ov.missed,
          truth_bbox: lay.bbox,
          svg_bbox: st.bbox || null,
          ablation_delta: (b.layerReport.ablation.find(x => x.hidden === lay.id) || {}).delta
        });
      }

      const structure = window.svgDraftLayers(b.draft);
      const merged = window.svgDraftExport(b.draft, {});
      const layerExports = LAYERS.map(id => window.svgDraftExport(b.draft, { layer: id }));
      const idAttr = (b.svg.match(/data-path-id="[^"]+"/g) || []);
      const uniqIds = new Set(idAttr);

      /* 图层面板也是基础设施：刷新后面板必须能重建 4 行、每层两个导出按钮、一个叠加预览 */
      window.img2svgApp.refresh();
      const panel = {
        rows: document.querySelectorAll('#img2svgLayersBody .isvg-layer-row').length,
        exports: document.querySelectorAll('#img2svgLayersBody .isvg-mini').length,
        overlay: document.querySelectorAll('#img2svgLayersBody .isvg-overlay-svg').length,
        foot: document.querySelectorAll('#img2svgLayersBody .isvg-layers-foot .btn').length
      };

      const checks = {
        validate_no_errors: (b.validate.errors || []).length === 0,
        no_duplicate_path_ids: idAttr.length === uniqIds.size,
        oob_zero: (b.validate.stats.out_of_bounds || 0) === 0,
        determinism_same_svg: sameSvg,
        determinism_same_score: sameScore,
        exports_layer_only: layerExports.every(e =>
          (e.svg.match(/id="layer-/g) || []).length === 1),
        /* 真值为空的层不许凭空画出东西（例如透明底夹具的背景层） */
        empty_truth_no_paint: layerRows.every(r => !r.empty_truth || r.svg_painted === 0),
        /* 面板：4 行 × (SVG + PNG) + 叠加预览 + 合并/消融两个入口 */
        panel_rows: panel.rows === 4,
        panel_exports: panel.exports === 8,
        panel_overlay: panel.overlay === 1,
        panel_foot: panel.foot === 2,
        score_min: b.compare.global_score >= minScore
      };

      return {
        id: fid,
        name: b.truth.name,
        size: [b.truth.w, b.truth.h],
        calls: b.calls,
        score: {
          global_score: b.compare.global_score,
          pixel_error: b.compare.pixel_error,
          edge_error: b.compare.edge_error,
          verdict: b.compare.verdict
        },
        structure: {
          bytes: merged.bytes,
          layer_bytes: structure.layers.map(l => ({ id: l.id, bytes: l.bytes })),
          paths: structure.totals.paths,
          texts: structure.totals.texts,
          path_ids: uniqIds.size,
          deduped: b.layerReport.deduped || 0
        },
        validate: {
          ok: b.validate.ok,
          errors: b.validate.errors,
          warnings: b.validate.warnings,
          layers_detail: b.validate.stats.layers_detail
        },
        layers: layerRows,
        occlusion: {
          truth: b.truth.occlusion.map(o => ({ layer: o.layer, ratio: o.ratio })),
          svg: b.layerReport.occlusion.map(o => ({ layer: o.layer, ratio: o.ratio }))
        },
        ablation: b.layerReport.ablation,
        exports: {
          merged_bytes: merged.bytes,
          layer_bytes: layerExports.map(e => ({ layer: e.layer, bytes: e.bytes })),
          png_bytes: layerRows.map(r => ({ layer: r.id, png: r.svg_painted ? 1 : 0 }))
        },
        panel: panel,
        determinism: { same_svg: sameSvg, same_score: sameScore, svg_bytes: a.svg.length },
        checks: checks
      };
    }

    const ids = window.SVG_FIXTURES.map(f => f.id);
    const out = [];
    for (const id of ids) out.push(await measure(id));

    return {
      generatedAt: new Date().toISOString(),
      target: 'index.html?nostore=1',
      minScore: minScore,
      fixtures: out,
      summary: {
        total: out.length,
        failed: out.filter(r => !Object.values(r.checks).every(Boolean)).map(r => r.id)
      }
    };
  }, MIN_SCORE);

  report.det = det;
  await browser.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');

  /* ---- 控制台摘要 ---- */
  console.log('=== 多层 SVG 基础设施测试 ===');
  console.log('尺子 DET v' + det.det.version + ' · refMaxSide=' + det.det.refMaxSide
    + ' · minAlpha=' + det.det.minAlpha + ' · blockSize=' + det.det.blockSize);
  console.log('');
  console.log('夹具'.padEnd(18) + 'score'.padEnd(8) + 'paths'.padEnd(8) + '层级 IoU (bg/sj/dt/tx)'.padEnd(30) + '消融最大 delta');
  report.fixtures.forEach(f => {
    const ious = f.layers.map(l => (l.iou == null ? '—' : l.iou.toFixed(2))).join('/');
    const ab = f.ablation.length ? Math.max.apply(null, f.ablation.map(a => a.delta)).toFixed(3) : '-';
    console.log((f.id + ' (' + f.size.join('x') + ')').padEnd(18)
      + String(f.score.global_score).padEnd(8)
      + String(f.structure.paths).padEnd(8)
      + ious.padEnd(30)
      + ab);
  });
  console.log('');
  report.fixtures.forEach(f => {
    const bad = Object.keys(f.checks).filter(k => !f.checks[k]);
    console.log((bad.length ? 'FAIL ' : 'PASS ') + f.id
      + (bad.length ? ' → ' + bad.join(', ') : '')
      + (f.validate.errors.length ? ' errors: ' + f.validate.errors.slice(0, 2).join(' | ') : ''));
  });
  if (errors.length) {
    console.log('\n页面错误 (' + errors.length + ')：');
    errors.slice(0, 10).forEach(e => console.log(' - ' + e));
  } else {
    console.log('\n页面错误：无');
  }
  console.log('\n报告：' + OUT_FILE);

  if (VERBOSE) console.log(JSON.stringify(report, null, 2));

  const failed = report.summary.failed;
  process.exit(failed.length || errors.length ? 1 : 0);
})().catch(e => {
  console.error('MULTILAYER TEST FAILED:', e);
  process.exit(2);
});
