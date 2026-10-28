/* 翻页流畅度探针：量「动画期」与「加载期」的真实帧间隔
 * 用法：node tools/app-flip-perf.js
 * 目的：证明 openDeskApp 已改为「先翻页、后加载」——
 *       翻页那 520ms 内不应出现 >50ms 的长帧（卡顿阈值），重活都挪到 520ms 之后。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const outDir = path.join(__dirname, '..', '.workbuddy', 'shots');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n=== 1. 装帧探针 ===');
  await page.evaluate(() => {
    window.__flipFrames = [];
    let last = 0;
    const loop = t => {
      if (last) window.__flipFrames.push(t - last);
      last = t;
      window.__flipRaf = requestAnimationFrame(loop);
    };
    window.__flipRaf = requestAnimationFrame(loop);
    // 记录模块「重活」真正产出 DOM 的时刻：卡片一出现就记下，和翻页起点比
    window.__flipT0 = 0;
    window.__loadAt = 0;
    const win = document.getElementById('storeWin');
    if (win && window.MutationObserver) {
      new MutationObserver(() => {
        if (!window.__loadAt && win.querySelector('.ms-card')) {
          window.__loadAt = performance.now();
        }
      }).observe(win, { childList: true, subtree: true });
    }
  });
  check(await page.evaluate(() => typeof window.__flipRaf === 'number'), 'rAF 帧探针已启动');

  console.log('\n=== 2. 冷开「模型商店」并采样 ===');
  // 冷开：清掉 loaded 标记，走完整骨架 → 加载路径
  await page.evaluate(() => {
    const w = document.getElementById('storeWin');
    if (w) delete w.dataset.loaded;
    document.getElementById('storeWin')?.classList.remove('app-loading');
  });
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__flipT0 = performance.now(); openDeskApp('store'); });
  // 状态先读：骨架只有「翻页期间」在，采样要 540ms 会把窗口占满
  const midState = await page.evaluate(() => {
    const wall = document.getElementById('deskWall');
    const win = document.getElementById('storeWin');
    const sk = document.getElementById('deskAppSkel');
    const row = sk && sk.querySelector('.sk-row');
    const bar = sk && sk.querySelector('.sk-bar > i');
    return {
      appOpen: wall.classList.contains('app-open'),
      loading: !!win && win.classList.contains('app-loading'),
      hostHasWin: !!(win && win.parentElement && win.parentElement.id === 'deskAppHost'),
      cards: document.querySelectorAll('#storeWin .ms-card').length,
      skHidden: !sk || sk.hidden,
      skOpacity: sk ? getComputedStyle(sk).opacity : '',
      rowAnim: row ? getComputedStyle(row, '::after').animationName : '',
      barAnim: bar ? getComputedStyle(bar).animationName : '',
    };
  });
  check(midState.appOpen === true, '翻页状态类已挂上 app-open');
  check(midState.hostHasWin === true, '窗口已搬进应用页宿主');
  check(midState.loading === true, '首次打开显示骨架（载入中…）');
  check(midState.cards === 0, '骨架期间模块还没开工（卡片 0 张）', String(midState.cards));
  check(midState.skHidden === false && midState.skOpacity === '1', '骨架已上屏且不透明', midState.skOpacity);
  // 旧版是 background-position 扫光（主线程一忙就冻住）；现在是 transform 关键帧
  check(midState.rowAnim === 'skShimmer' && midState.barAnim === 'skBar',
    '骨架动画走 transform 关键帧（合成器跑，不占主线程）', midState.rowAnim + '/' + midState.barAnim);

  /* 一趟采样同时收两件事：翻页角度 + 骨架微光位移。
     分开跑会各自占满 520ms 的翻页窗口（第一趟跑完动画已经结束了）。 */
  const samples = await page.evaluate(async () => {
    const p3 = document.getElementById('deskPageApps');
    const p1 = document.querySelector('.desk-page-1');
    const row = document.querySelector('#deskAppSkel .sk-row');
    const deg = el => {
      const t = getComputedStyle(el).transform;
      const m = t.match(/matrix3d\(([^)]+)\)/);
      if(!m) return 0;
      const n = m[1].split(',').map(Number);
      return Math.round(Math.atan2(-n[2], n[0]) * 180 / Math.PI);
    };
    const skx = () => {
      if(!row) return NaN;
      const m = getComputedStyle(row, '::after').transform.match(/matrix\(([^)]+)\)/);
      return m ? Math.round(parseFloat(m[1].split(',')[4])) : NaN;
    };
    const out = [];
    for(let i = 0; i < 5; i++){
      out.push({ t: Math.round(performance.now() - window.__flipT0), p3: deg(p3), p1: deg(p1), sk: skx() });
      await new Promise(r => setTimeout(r, 90));
    }
    return out;
  });
  console.log('   · 应用页角度 ' + samples.map(s => s.t + 'ms:' + s.p3 + '°').join(' → '));
  console.log('   · 桌面页角度 ' + samples.map(s => s.t + 'ms:' + s.p1 + '°').join(' → '));
  console.log('   · 微光位移 ' + samples.map(s => s.sk).join(' → '));
  check(samples.some(s => Math.abs(s.p3) > 8 && Math.abs(s.p3) < 80), '翻转过程有中间态（不是一帧跳到位）');
  check(samples.filter(s => Math.abs(s.p1) > 8).length >= 2, '桌面页同时在退场（双向翻转）');
  const moving = samples.filter((s, i) => i > 0 && s.sk !== samples[i - 1].sk).length;
  check(moving >= 3, '微光持续位移（不会卡在中间）', moving + '/4 次变化');
  await page.screenshot({ path: path.join(outDir, 'flip-mid.png') });

  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, 'flip-done.png') });
  const doneState = await page.evaluate(() => {
    const win = document.getElementById('storeWin');
    return {
      loading: win.classList.contains('app-loading'),
      loaded: win.dataset.loaded === '1',
      cards: document.querySelectorAll('#storeWin .ms-card').length,
      frames: window.__flipFrames.slice(),
    };
  });
  check(doneState.loading === false, '加载完成后骨架已撤掉');
  check(doneState.loaded === true, '窗口标记为已加载');
  check(doneState.cards > 0, '商店卡片已渲染', doneState.cards + ' 张');

  console.log('\n=== 3. 帧间隔统计 ===');
  const f = doneState.frames;
  check(f.length > 30, '采到足够帧数', f.length + ' 帧');
  // 前 ~520ms 属于翻页动画窗口，重活不应落在其中
  const flipFrames = f.slice(0, Math.round(520 / 16.7));
  const longAll = f.filter(d => d > 50).length;
  const longFlip = flipFrames.filter(d => d > 50).length;
  const maxAll = Math.round(Math.max.apply(null, f));
  const maxFlip = flipFrames.length ? Math.round(Math.max.apply(null, flipFrames)) : 0;
  const avg = Math.round(f.reduce((a, b) => a + b, 0) / f.length);
  console.log('   · 全程 平均 ' + avg + 'ms / 最长 ' + maxAll + 'ms / 长帧(>50ms) ' + longAll + ' 个');
  console.log('   · 翻页窗口 最长 ' + maxFlip + 'ms / 长帧 ' + longFlip + ' 个');
  check(maxFlip <= 50, '翻页动画期间无长帧（≤50ms）', maxFlip + 'ms');

  console.log('\n=== 4. 回来 & 二次打开（热路径） ===');
  await page.evaluate(() => { window.__flipFrames.length = 0; });
  await page.click('#deskAppBack');
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__flipFrames.length = 0; openDeskApp('gallery'); });
  await page.waitForTimeout(1300);
  const warm = await page.evaluate(() => ({
    frames: window.__flipFrames.slice(),
    loading: document.getElementById('libWin').classList.contains('app-loading'),
    title: document.getElementById('deskAppTitle').textContent.trim(),
  }));
  const wf = warm.frames.slice(0, Math.round(520 / 16.7));
  const warmMaxFlip = wf.length ? Math.round(Math.max.apply(null, wf)) : 0;
  check(warm.title === '图库', '二次打开标题正确', warm.title);
  check(warmMaxFlip <= 50, '热路径翻页无长帧', warmMaxFlip + 'ms');
  await page.screenshot({ path: path.join(outDir, 'flip-gallery.png') });

  console.log('\n=== 5. 对照：旧路径（翻页与加载同一帧） ===');
  // 直接调模块入口 = 旧行为：deskMountApp 立刻搬节点，紧接着同步建卡。量它的长帧。
  await page.evaluate(() => { window.__flipFrames.length = 0; });
  await page.evaluate(() => { document.getElementById('deskAppBack').click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__flipFrames.length = 0; });
  const oldStart = await page.evaluate(async () => {
    const t = performance.now();
    await openModelStore();          // ← 旧路径：搬页 + 建卡 + 探测都在同一批任务里
    return Math.round(performance.now() - t);
  });
  await page.waitForTimeout(500);
  const oldFrames = await page.evaluate(() => window.__flipFrames.slice());
  const of = oldFrames.slice(0, 40);          // 前 ~650ms
  const oldMax = of.length ? Math.round(Math.max.apply(null, of)) : 0;
  const oldLong = of.filter(d => d > 50).length;
  console.log('   · 旧路径同步耗时 ' + oldStart + 'ms，前 650ms 最长帧 ' + oldMax + 'ms / 长帧 ' + oldLong + ' 个');
  console.log('   · 新路径同区间最长帧 ' + maxFlip + 'ms / 长帧 ' + longFlip + ' 个');
  console.log('   · 结论：' + (oldMax > maxFlip ? '新路径把长帧压掉了 ' + (oldMax - maxFlip) + 'ms' : '本次两者接近（本机够快）'));

  console.log('\n=== 6. 页面错误 ===');
  check(errors.length === 0, '无 JS 报错', errors.slice(0, 3).join(' | ') || '干净');

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项未通过 ❌'));
  await browser.close();
  if (fails) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
