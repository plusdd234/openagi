/* 体检：多视图工具（结构 + 渲染参数）
 * 用法：node tools/multiview.js
 *
 * 只测「两边一致 / 控件还在 / 参数传对」，像素级另见 probe-mv-wire.js。
 * 最容易坏的是**两份壳对不上**：桌面 App 的 #mvWin 与 multiview.html 是两处
 * 一模一样的标记，靠人肉同步，漏一个 id 就是「App 里能点、独立页点不动」。
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

/* 两份壳里所有 mv* 的 id 必须完全一致 */
function idsOf(html) {
  return [...html.matchAll(/\bid="(mv[A-Za-z0-9_]*)"/g)].map(m => m[1]).sort();
}

(async () => {
  const root = path.join(__dirname, '..');
  const appHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const saHtml = fs.readFileSync(path.join(root, 'multiview.html'), 'utf8');

  console.log('\n=== 1. 两份壳的 id 对齐 ===');
  const a = idsOf(appHtml), s = idsOf(saHtml);
  const onlyA = a.filter(x => s.indexOf(x) < 0);
  const onlyS = s.filter(x => a.indexOf(x) < 0);
  check(onlyA.length === 0, 'index.html 独有的 id', onlyA.length ? onlyA.join(',') : '无');
  check(onlyS.length === 0, 'multiview.html 独有的 id', onlyS.length ? onlyS.join(',') : '无');
  check(a.length >= 28, 'id 总数', String(a.length));

  const browser = await chromium.launch({ channel: 'msedge' });

  const load = async (url) => {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    p.on('pageerror', e => errs.push(String(e && e.message)));
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForTimeout(800);
    return { p, errs };
  };

  /* ---------- 独立页 ---------- */
  console.log('\n=== 2. 独立页 multiview.html ===');
  const sa = await load(pathToFileURL(path.join(root, 'multiview.html')).href);
  const saState = await sa.p.evaluate(() => ({
    wired: !!(window.multiview && typeof multiview.open === 'function'),
    modes: document.querySelectorAll('#mvModes [data-mv-val]').length,
    modeVals: [...document.querySelectorAll('#mvModes [data-mv-val]')].map(b => b.dataset.mvVal),
    hasBgs: !!document.getElementById('mvBgs'),
    hasWire: !!document.getElementById('mvWire'),
    wireChecked: document.getElementById('mvWire') && document.getElementById('mvWire').checked,
    onWireVisible: (() => {
      const l = document.querySelector('.mv-check');
      if (!l) return false;
      const r = l.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    })()
  }));
  check(saState.wired, '脚本已挂上（multiview.open 存在）');
  check(saState.modes === 3, '模式只有 3 档（线框已移出）', saState.modeVals.join(','));
  check(!saState.hasBgs, '底色选择器已移除');
  check(saState.hasWire, '线框勾选框存在');
  check(saState.wireChecked === true, '线框默认勾上（等同旧版「线框」模式）');
  check(saState.onWireVisible, '线框勾选框在可视区内');
  check(sa.errs.length === 0, '独立页零报错', sa.errs.slice(0, 2).join(' | ') || 'clean');
  await sa.p.close();

  /* ---------- 桌面 App ---------- */
  console.log('\n=== 3. 桌面 App（#mvWin） ===');
  const app = await load(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1');
  await app.p.evaluate(() => multiview.open());
  await app.p.waitForTimeout(500);
  const win = await app.p.evaluate(() => {
    const w = document.getElementById('mvWin');
    const r = w.getBoundingClientRect();
    const over = [...w.querySelectorAll('.mv-ctl button, .mv-ctl label, .mv-ctl input, .mv-ctl select')]
      .filter(e => e.getBoundingClientRect().right > r.right - 2)
      .map(e => (e.textContent || e.id).trim().slice(0, 10));
    return {
      open: !w.classList.contains('hidden'),
      w: Math.round(r.width),
      over,
      ctl: (() => { const e = w.querySelector('.mv-ctl'); return e ? e.clientWidth : 0; })(),
      ctlScroll: (() => { const e = w.querySelector('.mv-ctl'); return e ? e.scrollWidth : 0; })()
    };
  });
  check(win.open, '窗口打开了');
  check(win.over.length === 0, '工具栏没有控件被裁到窗口外', win.over.length ? win.over.join(',') : '全部在框内');
  check(win.ctlScroll <= win.ctl + 1, '工具栏内容没有横向溢出',
    'client=' + win.ctl + ' scroll=' + win.ctlScroll);

  /* 底色透明度：渲染核必须收到 transparent:true，且不再传 bgColor/bgOpacity */
  const opts = await app.p.evaluate(async () => {
    const real = Model3D.viewGrid;
    let seen = null;
    Model3D.viewGrid = function (src, o) { seen = JSON.parse(JSON.stringify(o || {})); return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true }); };
    try {
      if (multiview.state.cur) multiview.render();
      else {
        multiview.state.cur = { id: 'probe', name: 'probe.obj', src: 'data:text/plain;base64,' };
        await multiview.render();
      }
    } catch (e) { /* 渲染失败无所谓，只看参数 */ }
    Model3D.viewGrid = real;
    return seen;
  });
  check(!!opts, '渲染参数能抓到');
  if (opts) {
    check(opts.transparent === true, '底色 transparent=true', String(opts.transparent));
    check(opts.bgColor === undefined && opts.bgOpacity === undefined, '不再传 bgColor / bgOpacity',
      JSON.stringify({ bgColor: opts.bgColor, bgOpacity: opts.bgOpacity }));
    check(typeof opts.wire === 'boolean', 'wire 参数传下去了', String(opts.wire));
    check(['shaded', 'material', 'solid'].indexOf(opts.mode) >= 0, 'mode 是三种之一', opts.mode);
  }

  check(app.errs.length === 0, 'App 零报错', app.errs.slice(0, 2).join(' | ') || 'clean');
  await app.p.close();

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
