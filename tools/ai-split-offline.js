/* AI 拆件 · 离线验收（不联网）
 * 用脚本替身顶掉 DeepSeek：只验证「四视图画框 → 求交 → 确认 → 锁定」这条链路，
 * 以及几何结果是否合理。等这里全绿，再拿真模型跑 tools/ai-split.js。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
let PORT = 0;   // listen(0) 后取真实端口
const OUT = require('./probe-run').runDir('ai-split-offline');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  fs.readFile(path.join(ROOT, p), (e, buf) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto('http://127.0.0.1:' + PORT + '/multiview.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.ModelSplit && Model3D.ready(), null, { timeout: 20000 });

  const out = await page.evaluate(async () => {
    const b = await (await fetch('/assets/models/mvvd80i5-f2df38c4.glb')).blob();
    const src = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });

    /* 先单测「四视图求交」：只给三个视图必须报错（中途会给模型一次补画的机会） */
    const prep = await ModelSplit.prepare(src, { maxCandidates: 120 });
    const threeViews = ['front', 'left', 'back'].map(v => ({ part: 'x', view: v, box: [0, 0, 1, 1], mode: 'in' }));
    let threeErr = '', threeTries = 0;
    try {
      await ModelSplit.settleMarks(null, prep, {
        restIds: prep.candidateIds, frame: prep.frame, names: ['x'],
        locked: [], atlases: [], atlasSlots: [], someIds: () => true
      }, {
        withImages: false,
        answer: async () => { threeTries++; return JSON.stringify({ marks: threeViews }); }
      }, () => { }, threeViews);
    } catch (e) { threeErr = e.message; }

    /* 命中单测：头部的框应该命中最高处的岛 */
    const topBox = { part: 'head', view: 'front', box: [0, 0, 1, 0.26], mode: 'in' };
    const hits = ModelSplit.pickRegion(prep.a, prep.candidateIds, topBox, prep.frame);

    /* 正式跑：替身按部件画四个框 */
    const marks = (part, y1) => ['front', 'left', 'back', 'right'].map(v => ({ part, view: v, box: [0, 0, 1, y1], mode: 'in' }));
    let calls = 0;
    const progress = [];
    const answer = async (msgs, ctx) => {
      calls++;
      if (ctx.confirm) return JSON.stringify({ ok: true, part: ctx.confirm.part, confidence: 0.8 });
      const part = ctx.names[0];
      if (/面/.test(part)) return JSON.stringify({ marks: marks(part, 0.26) });
      if (/发/.test(part)) return JSON.stringify({ marks: marks(part, 0.62) });
      return JSON.stringify({ parts: [{ part: part, islands: [], confidence: 0.5 }] });
    };
    const t0 = Date.now();
    const r = await ModelSplit.run(src, {
      names: ['面部和脖子', '头发和头饰', '身体'],
      answer: answer, maxRounds: 3
    }, (kind, msg, extra) => { progress.push({ kind, msg, views: extra && extra.views }); });

    const conf = progress.filter(p => p.kind === 'confirm' && p.views);
    const per = r.parts.map(p => {
      const ids = p.islands.map(id => r.prep.a.islands[id]);
      const ys = ids.map(o => o.centroid[1]);
      const mean = ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 0;
      const tris = ids.reduce((s, o) => s + o.tris.length, 0);
      return { name: p.name, islands: p.islands.length, tris, yMean: +mean.toFixed(3), yMax: +Math.max(0, ...ys).toFixed(3) };
    });

    return {
      threeErr, threeTries, hitCount: hits.length,
      hitTop: hits.length ? +Math.max(...hits.map(id => prep.a.islands[id].centroid[1])).toFixed(3) : 0,
      calls, ms: Date.now() - t0,
      per, leftover: r.leftover, stats: r.stats,
      confirmImgs: conf.map(p => p.views.length),
      lastConfirm: conf.length ? conf[conf.length - 1].views : '',

      /* 也把替身那次的第一张四视图拿出来，确认画框的网格线生效 */
      rest: r.views
    };
  });

  const fails = [];
  const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { fails.push(msg); console.log('  ✗ ' + msg); } };

  console.log('\n四视框选 · 离线验收');
  console.log('  准备：candidates=' + out.per.reduce((s, p) => s + p.islands, 0) + ' 岛，用时 ' + out.ms + 'ms，AI 调用 ' + out.calls + ' 次');

  ok(/四个视图/.test(out.threeErr), '只给三个视图时被拒绝：' + (out.threeErr || '(没有报错)'));
  ok(out.threeTries === 1, '漏视图时先让模型补画一次再报错（补了 ' + out.threeTries + ' 次）');
  ok(out.hitCount > 0 && out.hitTop > 0.85, '头顶的框命中 ' + out.hitCount + ' 个岛，最高 y=' + out.hitTop);
  ok(out.per.length === 3, '拆出 3 个部件');
  out.per.forEach(p => ok(p.islands > 0, '「' + p.name + '」' + p.islands + ' 岛 / ' + p.tris + ' tri / y均值 ' + p.yMean));

  const head = out.per[0], hair = out.per[1], body = out.per[2];
  ok(head.yMean > body.yMean, '头部 y 均值高于身体（' + head.yMean + ' vs ' + body.yMean + '）');
  ok(out.confirmImgs.length >= 2, '每个框选部件都有确认图（' + out.confirmImgs.length + ' 张）');

  if (out.lastConfirm) fs.writeFileSync(path.join(OUT, 'confirm.jpg'), Buffer.from(out.lastConfirm.split(',')[1], 'base64'));
  if (out.rest) fs.writeFileSync(path.join(OUT, 'rest.jpg'), Buffer.from(out.rest.split(',')[1], 'base64'));

  console.log('\n失败 ' + fails.length + ' 项');
  await browser.close();
  server.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
