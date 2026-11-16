#!/usr/bin/env node
/* 真实运行：用本机当前生效的 DeepSeek 账户跑一次「监督重绘」。
 *
 * 会消耗账户额度，默认不跑；必须显式开启：
 *   PROBE_LIVE=1 node tools/live-visionlab.js
 *
 * 只读取当前生效的 base / model / key（key 不打印、不落盘）：
 *   优先从本地中转 http://127.0.0.1:8787/store.js（应用正在用的那份），
 *   中转不可用时才回落到仓库里的 openagi-store.json（可能是旧快照）。
 * 再通过 addInitScript 注入页面 localStorage，走 App 自己的 llmConn() / llmStreamRequest。
 *
 * 产物：.workbuddy/runs/<runId>/live.json（工具调用、语义名、指标、模型文本）
 */
'use strict';

if (process.env.PROBE_LIVE !== '1') {
  console.log('跳过：真实模型运行会消耗账户额度，需要 PROBE_LIVE=1 显式开启');
  process.exit(0);
}

const { chromium } = require('playwright-core');
const { createRun } = require('./probe-run');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const run = createRun('live-visionlab');
const errors = [];

/* 取当前生效配置：中转 > 磁盘快照 */
async function loadCfg() {
  try {
    const r = await fetch('http://127.0.0.1:8787/store.js');
    const t = await r.text();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      const d = JSON.parse(t.slice(a, b + 1));
      if (d.hf_llmKey) return { src: 'relay', data: d };
    }
  } catch (e) {}
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'openagi-store.json'), 'utf8'));
  return { src: 'file', data: d };
}

(async () => {
  const picked = await loadCfg();
  const src = picked.data;
  const cfg = {
    llmBaseUrl: String(src.hf_llmBaseUrl || ''),
    llmKey: String(src.hf_llmKey || ''),
    llmModel: String(src.hf_llmModel || ''),
    mode: String(src.hf_llm_mode || '')
  };
  if (!cfg.llmKey) throw new Error('没有读到 hf_llmKey，先在设置里填 Key');
  console.log('配置来源：' + (picked.src === 'relay' ? '本地中转 8787（当前生效）' : 'openagi-store.json（可能是旧快照）'));
  console.log('模型：' + cfg.llmModel + '  ·  地址：' + cfg.llmBaseUrl + (cfg.mode ? '  ·  模式：' + cfg.mode : ''));

  const browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(c => {
    try {
      localStorage.setItem('hf_llmBaseUrl', c.llmBaseUrl);
      localStorage.setItem('hf_llmKey', c.llmKey);
      localStorage.setItem('hf_llmModel', c.llmModel);
      localStorage.setItem('hf_relayOn', 'true');
      if (c.mode) localStorage.setItem('hf_llm_mode', c.mode);
    } catch (e) {}
  }, cfg);

  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.message)));

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const conn = await page.evaluate(() => {
    const c = (typeof llmConn === 'function') ? llmConn() : null;
    return c ? { base: c.base, model: c.model, hasKey: !!c.key, keyLen: (c.key || '').length, mode: (typeof llmMode === 'function' ? llmMode() : '') } : null;
  });
  console.log('页面连接：' + (conn ? (conn.model + ' @ ' + conn.base + ' · key ' + (conn.hasKey ? '已读(' + conn.keyLen + ')' : '缺失') + ' · ' + conn.mode) : '未取到'));
  if (!conn || !conn.hasKey) throw new Error('页面里拿不到模型连接');
  if (conn.base !== cfg.llmBaseUrl || conn.model !== cfg.llmModel) {
    console.log('⚠️ 页面实际连接与读取到的配置不一致，按页面实际值继续');
  }

  await page.evaluate(() => window.openDeskApp('visionlab'));
  await page.waitForTimeout(1200);

  /* PROBE_LIVE_IMAGE=<png/jpg> 可换成任意测试图；不传就跑内置演示图 */
  const imgPath = process.env.PROBE_LIVE_IMAGE || '';
  if (imgPath) {
    const ext = (path.extname(imgPath).slice(1) || 'png').toLowerCase();
    const url = 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' +
      fs.readFileSync(imgPath).toString('base64');
    await page.evaluate(u => window.vlLab.__test.loadDataURL(u), url);
    console.log('图片：' + imgPath);
  } else {
    await page.evaluate(() => window.vlLab.__test.loadDemo());
  }
  await page.waitForTimeout(300);

  /* PROBE_LIVE_SRC=auto|edge|dark|color 取线源；color=色块，用于多色图标 */
  const srcMode = (process.env.PROBE_LIVE_SRC || '').toLowerCase();
  if (srcMode) {
    const o = await page.evaluate(s => window.vlLab.__test.setOpt({ src: s }), srcMode);
    console.log('取线源：' + o.src);
  }

  /* 截图只取画布区，用来做文档里的「原图 / 重绘」对比 */
  const stageBox = await page.evaluate(() => {
    const el = document.querySelector('[data-ref="stage"]');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await run.shot(page, 'origin.png', { clip: stageBox });

  const size = await page.evaluate(() => {
    const d = window.vlLab.__debug();
    return { w: d.w, h: d.h };
  });
  const n = await page.evaluate(s => window.vlLab.__test.setRegion({ x: 0, y: 0, w: s.w, h: s.h }), size);
  console.log('提取：' + n + ' 条参考线（只落淡虚线，不落实线）');

  /* PROBE_LIVE_FORM=bezier|fit|poly|auto 切换曲线形态口径（B / C / A 组） */
  const form = (process.env.PROBE_LIVE_FORM || 'auto').toLowerCase();
  const formNow = await page.evaluate(f => window.vlLab.__test.setForm(f), form);
  console.log('曲线口径：' + formNow);

  await page.evaluate(() => { window.vlLab.__test.run(); });
  /* 轮询代替 waitForFunction：真实运行可能很久，超时时至少能看到「卡在第几轮、调了几次」 */
  const tRun = Date.now();
  let lastLog = 0;
  for (;;) {
    const st = await page.evaluate(() => {
      const d = window.vlLab.__debug();
      return { busy: d.busy, calls: d.calls, round: (document.querySelector('[data-ref="round"]') || {}).textContent || '' };
    });
    if (!st.busy) break;
    if (Date.now() - tRun > 540000) throw new Error('真实运行超时：' + st.round + '，已调用 ' + st.calls + ' 次');
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      console.log('  … ' + (st.round || '等待中') + ' · 已调用 ' + st.calls + ' 次');
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(500);

  const out = await page.evaluate(() => {
    const d = window.vlLab.__debug();
    const parts = window.vlLab.__test.parts();
    return {
      debug: d,
      metrics: d.metrics,
      parts: parts.map(p => ({ key: p.key, name: p.name, len: p.len, w: p.w, closed: p.closed, anchors: p.anchors, src: p.src })),
      calls: window.vlLab.__test.calls(),
      tools: Array.from(document.querySelectorAll('[data-ref="sup"] .vl-tool-name')).map(e => e.textContent),
      says: Array.from(document.querySelectorAll('[data-ref="sup"] .vl-say')).map(e => e.textContent.slice(0, 4000)),
      review: window.vlLab.__test.lastReview(),
      round: (document.querySelector('[data-ref="round"]') || {}).textContent || ''
    };
  });

  await page.evaluate(() => window.vlLab.__test.setOnly(true));
  await run.shot(page, 'only-draw.png', { clip: stageBox });
  await page.evaluate(() => window.vlLab.__test.setOnly(false));
  await page.waitForTimeout(200);
  await run.shot(page, 'overlay.png', { clip: stageBox });

  const redrawn = out.parts.filter(p => p.src === 'model');
  const summary = {
    model: cfg.llmModel,
    base: cfg.llmBaseUrl,
    form: formNow,
    strokes: out.parts.length,
    drawn: out.debug.drawn,
    redrawn: redrawn.length,
    names: redrawn.slice(0, 20).map(p => p.name),
    metrics: out.metrics,
    calls: out.calls,
    tools: out.tools,
    round: out.round,
    review: out.review,
    says: out.says.slice(-6),
    parts: out.parts
  };
  const file = run.writeJson('live.json', summary);

  console.log('\n工具调用：' + out.calls.map(c => c.name).join(' → '));
  out.calls.forEach(c => {
    let extra = '';
    if (c.result && typeof c.result === 'object') {
      if (c.name === 'vl_render_check') {
        extra = ' → ' + JSON.stringify({ chamfer: c.result.chamfer, recall: c.result.recall, precision: c.result.precision, drawn: c.result.drawn, error: c.result.error });
      } else if (c.name === 'vl_redraw_parts') {
        extra = ' → ' + JSON.stringify({
          redrawn: c.result.redrawn || 0, bezier: c.result.bezier, segs: c.result.segs,
          fitted: c.result.fitted, clamped: c.result.clamped
        });
      } else if (c.name === 'vl_trace') {
        extra = ' → ' + JSON.stringify({ count: c.result.count, cleared: c.result.cleared, unchanged: c.result.unchanged });
      }
    }
    if (c.error) extra += ' ⚠ ' + c.error;
    console.log('  ' + c.name + ' ' + (c.args ? JSON.stringify(c.args).slice(0, 120) : '') + extra);
  });
  console.log('已描绘 ' + out.debug.drawn + '/' + out.parts.length + ' · 模型重绘 ' + redrawn.length);
  console.log('语义名：' + (summary.names.join(' / ') || '（无）'));
  if (out.metrics) {
    console.log('指标：Chamfer ' + out.metrics.chamfer + ' · 召回 ' + out.metrics.recall +
      ' · 精度 ' + out.metrics.precision + ' · 中位线宽 ' + out.metrics.medianWidth);
  }
  console.log('模型最后的话：\n' + (out.says.slice(-2).join('\n---\n') || '（无）'));
  console.log('\n模型复盘：\n' + (out.review || '（无）'));
  console.log('\n产物：' + path.relative(ROOT, file));

  if (!out.metrics) errors.push('没有回读指标（模型可能没调用 vl_render_check）');
  if (!out.calls.length) errors.push('没有任何工具调用');

  await browser.close();
  const ok = run.finish(errors, { model: cfg.llmModel, metrics: out.metrics, redrawn: redrawn.length });
  console.log(ok ? '\n真实运行完成' : '\n真实运行有问题：' + errors.join('；'));
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error(e);
  run.finish([String((e && e.stack) || e)]);
  process.exit(1);
});
