#!/usr/bin/env node
/* 阶段 3：反投烘贴图（直接用视图工坊现成的 MVProject.bakeProject 链路）
 *
 * 输入：gen/bake_B.png / gen/bake_D.png —— 与导出布局同尺寸的 2×2 四视图
 * 输出：贴图 PNG、带贴图的四视图预览 PNG、覆盖率 / 岛数 / 丢岛数
 *
 * 口径与 App 内完全一致：state.views / exSize / exGap / cols / cam / margin
 * 必须和生成结构图时用的布局一模一样，否则整片错位。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { ROOT } = require('../probe-run');

const MODEL = path.join(ROOT, 'assets/models/mwdkldbx-8417b5c6.obj');

function runDirFromArg() {
  const i = process.argv.indexOf('--run');
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  const base = path.join(ROOT, '.workbuddy/runs');
  const list = fs.readdirSync(base).filter(d => /char3d-render$/.test(d)).sort();
  return path.join(base, list[list.length - 1]);
}

async function main() {
  const RUN_DIR = runDirFromArg();
  const genDir = path.join(RUN_DIR, 'gen');
  const outDir = path.join(RUN_DIR, 'bake');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String((e && e.message) || e)));
  await page.goto(pathToFileURL(path.join(ROOT, 'multiview.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.Model3D && Model3D.ready() && window.MV && window.MVProject), null, { timeout: 30000 });

  /* 载入模型（走 App 自己的文件入口，等于用户点「选择模型」） */
  await page.setInputFiles('#mvFile', MODEL);
  await page.waitForFunction(() => !!(window.MV.state.cur && MV.state.cur.src), null, { timeout: 60000 });

  /* 布局写死成和结构图导出时一致的那一套 */
  const setLayout = () => page.evaluate(() => {
    MV.state.views = ['front', 'left', 'back', 'right'];
    MV.state.exSize = 1024;
    MV.state.exGap = 0;
    MV.state.cols = 2;
    MV.state.compact = false;
    MV.state.cam = 'ortho';
    MV.state.margin = 1.08;
  });
  await setLayout();

  const results = {};
  for (const tag of ['B', 'D']) {
    const src = path.join(genDir, 'bake_' + tag + '.png');
    if (!fs.existsSync(src)) { console.log('缺少 ' + src); continue; }
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
    await setLayout();
    const t0 = Date.now();
    const r = await page.evaluate(async ({ dataUrl, tag }) => {
      await window.MVProject.runImage(dataUrl, 'bake_' + tag);
      /* genPreview 是 runImage 里不 await 的后续动作，要等它把预览画出来 */
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        if (MV.state.proj && MV.state.proj.preview) break;
        await new Promise(r2 => setTimeout(r2, 200));
      }
      const pr = MV.state.proj;
      if (!pr) return { error: '投射没有产出结果' };
      return {
        pct: pr.pct, occ: pr.occCount, painted: pr.painted,
        islands: pr.islands, lost: pr.lost, offScale: pr.offScale,
        size: pr.size, perView: pr.perView,
        texture: pr.png, preview: pr.preview || null,
        note: pr.name
      };
    }, { dataUrl, tag });
    if (r.error) { console.log('[' + tag + '] ' + r.error); errs.push(tag + ': ' + r.error); continue; }
    fs.writeFileSync(path.join(outDir, tag + '_texture.png'), Buffer.from(String(r.texture).split(',')[1], 'base64'));
    if (r.preview) fs.writeFileSync(path.join(outDir, tag + '_preview.png'), Buffer.from(String(r.preview).split(',')[1], 'base64'));
    delete r.texture; delete r.preview;
    r.ms = Date.now() - t0;
    results[tag] = r;
    console.log('[' + tag + '] 覆盖率 ' + r.pct + '% · 岛 ' + r.islands + ' · 丢 ' + r.lost +
      ' · 贴图 ' + r.size + ' · ' + r.ms + 'ms');
  }

  fs.writeFileSync(path.join(RUN_DIR, 'bake.json'), JSON.stringify({ results, errs }, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
