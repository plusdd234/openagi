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
    /* 「线框」这个勾选框已经移进图层面板：工具栏里不再摆一排 checkbox，
     * 由图层行的眼睛驱动（input 还在 DOM 里当唯一写入口，但不可见）。 */
    layerRows: document.querySelectorAll('.mv-ly-item').length,
    wireRow: !!document.querySelector('.mv-ly-item[data-ly="wire"]'),
    wireRowOn: (() => {
      const r = document.querySelector('.mv-ly-item[data-ly="wire"]');
      return !!r && r.classList.contains('is-on');
    })(),
    checkHidden: (() => {
      const b = document.getElementById('mvWire');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return r.width === 0 && r.height === 0;
    })(),
    noToolbarCheck: !document.querySelector('.mv-ctl .mv-check')
  }));
  check(saState.wired, '脚本已挂上（multiview.open 存在）');
  check(saState.modes === 3, '模式只有 3 档（线框已移出）', saState.modeVals.join(','));
  check(!saState.hasBgs, '底色选择器已移除');
  check(saState.hasWire, '线框勾选框存在');
  check(saState.wireChecked === true, '线框默认勾上（等同旧版「线框」模式）');
  check(saState.layerRows === 10, '图层面板有 10 层', String(saState.layerRows));
  check(saState.wireRow, '「线框」是图层面板里的一行');
  check(saState.wireRowOn === true, '线框那一行默认是亮的');
  check(saState.checkHidden === true, '原勾选框已隐藏（只当写入口，不再占位）', String(saState.checkHidden));
  check(saState.noToolbarCheck, '工具栏里不再有一排勾选框');
  check(sa.errs.length === 0, '独立页零报错', sa.errs.slice(0, 2).join(' | ') || 'clean');
  await sa.p.close();

  /* ---------- 桌面 App ---------- */
  console.log('\n=== 3. 桌面 App（#mvWin） ===');
  const app = await load(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1');
  /* 先抹掉多视图的本地存档：这组断言要验证「默认值」，而浏览器 profile 里的
   * 存档是上一次跑测试留下的（change 会 saveSet）。不抹的话第二次跑必红。 */
  await app.p.evaluate(() => { try { localStorage.removeItem('hf_mv_set'); } catch (e) {} });
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
    check(opts.bgOpacity === undefined, '不再传 bgOpacity（底色改由「背景层」管）',
      JSON.stringify({ bgOpacity: opts.bgOpacity }));
    /* bgColor 现在有正当用途：它是「背景层」的颜色（旧版是给整张图垫底）。
     * 渲染核内部仍拿它当抗锯齿的清屏色，这是内部实现细节，不算「垫底」。 */
    check(opts.bgColor === undefined || /^#[0-9a-f]{6}$/i.test(opts.bgColor), 'bgColor 只传合法颜色',
      String(opts.bgColor));
    check(typeof opts.wire === 'boolean', 'wire 参数传下去了', String(opts.wire));
    check(['shaded', 'material', 'solid'].indexOf(opts.mode) >= 0, 'mode 是三种之一', opts.mode);
  }

  check(app.errs.length === 0, 'App 零报错', app.errs.slice(0, 2).join(' | ') || 'clean');

  /* === 3.5 深度描边：默认关，勾上要把参数传进渲染核 === */
  console.log('\n=== 3.5 深度描边 ===');
  const de = await app.p.evaluate(async () => {
    const box = document.getElementById('mvDepthEdge');
    const rng = document.getElementById('mvDepthThresh');
    const lab = document.getElementById('mvDepthThreshV');
    const before = { checked: box.checked, label: lab.textContent, state: !!multiview.state.depthEdge };
    const real = Model3D.viewGrid;
    let seen = null;
    Model3D.viewGrid = function (src, o) {
      seen = JSON.parse(JSON.stringify(o || {}));
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    try { await multiview.render(); } catch (e) { /* 只看参数 */ }
    Model3D.viewGrid = real;
    /* 收尾复原：change 会 saveSet 写 localStorage，不还原的话
     * 下次跑测试开局就是「已勾选」，一跑就红——而且那也不是用户的真实设置。
     * 注意 state 要在复原**之前**取，否则读到的是复原后的值。 */
    const out = {
      before, seen,
      state: !!multiview.state.depthEdge,
      hasRange: !!rng,
      thresh: multiview.state.depthEdgeThresh,
      pctState: multiview._pure.fmtPct(multiview.state.depthEdgeThresh),
      pct0: multiview._pure.fmtPct(0),
      pct100: multiview._pure.fmtPct(100),
      th0: multiview._pure.depthThreshOf(0),
      th100: multiview._pure.depthThreshOf(100)
    };
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    return out;
  });
  check(de.before.checked === false && de.before.state === false, '深度描边默认不勾', JSON.stringify(de.before));
  check(de.hasRange, '阈值滑条存在');
  check(de.state === true, '勾上后 state 变成 true');
  check(de.seen && de.seen.depthEdge === true, '渲染核收到 depthEdge=true', String(de.seen && de.seen.depthEdge));
  check(de.seen && typeof de.seen.depthEdgeThresh === 'number', '阈值作为数字传下去', String(de.seen && de.seen.depthEdgeThresh));
  /* 标签是「给人看的百分比」，必须和 state 里的原值对得上：两处各算一遍是最常见的不同步 */
  check(de.before.label === de.pctState, '滑条标签 = 当前阈值的百分比文案',
    de.before.label + ' vs ' + de.pctState + '（原值 ' + de.thresh + '）');
  check(de.th0 > 0 && de.th100 > de.th0 * 100, '阈值映射跨两个数量级（滑条才不会前 80% 无效）',
    de.th0 + ' → ' + de.th100);
  check(/^\d/.test(de.pct0) && /%$/.test(de.pct100), '端点有可读的百分比文案', de.pct0 + ' / ' + de.pct100);

  /* === 3.6 角度线框的粗细 / 渐变 / 颜色 === */
  console.log('\n=== 3.6 角度线框观感 ===');
  const cr = await app.p.evaluate(async () => {
    const aw = document.getElementById('mvAngleWire');
    const cw = document.getElementById('mvCreaseWidth');
    const ct = document.getElementById('mvCreaseTaper');
    const cc = document.getElementById('mvCreaseColor');
    const cwL = document.getElementById('mvCreaseWidthV');
    const ctL = document.getElementById('mvCreaseTaperV');
    const before = {
      w: cw.value, t: ct.value, color: cc.value,
      wLabel: cwL.textContent, tLabel: ctL.textContent,
      scale: multiview.state.creaseScale, taper: multiview.state.creaseTaper,
      color_state: multiview.state.creaseColor
    };
    const real = Model3D.viewGrid;
    let seen = null;
    Model3D.viewGrid = function (src, o) {
      seen = JSON.parse(JSON.stringify(o || {}));
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    /* 先把角度线框打开（两个线框互斥，顺手把普通线框关掉）。open 那次渲染要先
     * 跑完——render 是串行的，不等它结束就改参数，seen 抓到的还是旧快照。 */
    aw.checked = true; aw.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 350));
    cw.value = '220'; cw.dispatchEvent(new Event('input'));
    ct.value = '80'; ct.dispatchEvent(new Event('input'));
    cc.value = '#ff0000'; cc.dispatchEvent(new Event('input'));
    /* 滑条是防抖重渲（260ms），等它落地再读参数 */
    await new Promise(r => setTimeout(r, 600));
    Model3D.viewGrid = real;
    const out = {
      before, seen,
      wLabel: cwL.textContent, tLabel: ctL.textContent,
      scale: multiview.state.creaseScale, taper: multiview.state.creaseTaper,
      color: multiview.state.creaseColor
    };
    /* 复原：这一段的 change 会 saveSet 写本地存档；勾角度线框时普通线框被互斥关掉了，
     * 也要一起恢复，否则下一次跑测试的「线框」断言会莫名其妙变红 */
    aw.checked = false; aw.dispatchEvent(new Event('change'));
    const wr = document.getElementById('mvWire');
    if (wr) { wr.checked = true; wr.dispatchEvent(new Event('change')); }
    cw.value = '100'; cw.dispatchEvent(new Event('input'));
    ct.value = '50'; ct.dispatchEvent(new Event('input'));
    cc.value = '#2b2b2b'; cc.dispatchEvent(new Event('input'));
    return out;
  });
  check(cr.before.w === '100' && Math.abs(cr.before.scale - 1) < 1e-6, '粗细默认 1.0×',
    cr.before.scale + ' / label ' + cr.before.wLabel);
  check(cr.before.t === '50' && cr.before.taper === 50, '随角度默认 50%', cr.before.t + ' / ' + cr.before.tLabel);
  check(/^#[0-9a-f]{6}$/i.test(cr.before.color), '颜色控件有初始值', cr.before.color);
  check(cr.wLabel === '2.2×' && Math.abs(cr.scale - 2.2) < 1e-6, '拖粗细 → 2.2×（标签同步）', cr.wLabel);
  check(cr.tLabel === '80%' && cr.taper === 80, '拖随角度 → 80%', cr.tLabel);
  check(cr.color === '#ff0000', '换颜色 → state 跟上', cr.color);
  check(cr.seen && cr.seen.creaseScale === 2.2, '渲染核收到 creaseScale', String(cr.seen && cr.seen.creaseScale));
  /* 界面按百分比，渲染核按 0~1：这里防的是「忘了 /100」 */
  check(cr.seen && Math.abs(cr.seen.creaseTaper - 0.8) < 1e-6, 'creaseTaper 传下去是 0~1（不是 80）',
    String(cr.seen && cr.seen.creaseTaper));
  check(cr.seen && cr.seen.creaseColor === '#ff0000', '渲染核收到 creaseColor', String(cr.seen && cr.seen.creaseColor));

  /* === 3.7 深度灰（把距离画成灰度） === */
  console.log('\n=== 3.7 深度灰 ===');
  const dgz = await app.p.evaluate(async () => {
    const g = document.getElementById('mvDepthGray');
    const rg = document.getElementById('mvDepthGrayRange');
    const bgc = document.getElementById('mvDepthGrayBg');
    const more = document.getElementById('mvMore');
    more.open = false;
    const before = { checked: g.checked, range: rg.value, bg: bgc.value, state: !!multiview.state.depthGray };
    const real = Model3D.viewGrid;
    let seen = null;
    Model3D.viewGrid = function (src, o) {
      seen = JSON.parse(JSON.stringify(o || {}));
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    g.checked = true; g.dispatchEvent(new Event('change'));
    await new Promise(x => setTimeout(x, 200));
    /* 两个参数现在住在这层自己的属性面板里：勾上要摊开的是「图层属性」，
     * 不是上面那个「画布」折叠区（那里面已经没有任何层参数了）。 */
    const autoOpen = {
      canvas: more.open,
      layer: multiview.state.openLayer,
      panel: !document.querySelector('#mvWin .mv-ly-props[data-for="dgray"]').hidden
    };
    rg.value = '30'; rg.dispatchEvent(new Event('input'));
    bgc.value = '#ffffff'; bgc.dispatchEvent(new Event('input'));
    await new Promise(x => setTimeout(x, 500));
    Model3D.viewGrid = real;
    const out = {
      before, seen, autoOpen,
      rangeLabel: document.getElementById('mvDepthGrayRangeV').textContent,
      range: multiview.state.depthGrayRange,
      bg: multiview.state.depthGrayBg
    };
    g.checked = false; g.dispatchEvent(new Event('change'));
    rg.value = '100'; rg.dispatchEvent(new Event('input'));
    bgc.value = '#000000'; bgc.dispatchEvent(new Event('input'));
    return out;
  });
  check(dgz.before.checked === false && dgz.before.state === false, '深度灰默认不勾', JSON.stringify(dgz.before));
  check(dgz.before.range === '100', '范围默认 100%（用完整前后跨度）', dgz.before.range);
  check(dgz.before.bg === '#000000', '远景色默认黑', dgz.before.bg);
  check(dgz.autoOpen.layer === 'dgray' && dgz.autoOpen.panel === true && dgz.autoOpen.canvas === false,
    '勾上深度灰 → 摊开它自己的属性面板（不是把「画布」撑开）', JSON.stringify(dgz.autoOpen));
  check(dgz.seen && dgz.seen.depthGray === true, '渲染核收到 depthGray=true', String(dgz.seen && dgz.seen.depthGray));
  /* 界面是 10~100 的百分数，渲染核要 0.05~1 */
  check(dgz.seen && Math.abs(dgz.seen.depthGrayRange - 0.3) < 1e-6, 'depthGrayRange 传下去是 0~1（不是 30）',
    String(dgz.seen && dgz.seen.depthGrayRange));
  check(dgz.rangeLabel === '30%' && dgz.range === 30, '滑条标签同步', dgz.rangeLabel);
  check(dgz.bg === '#ffffff' && dgz.seen && dgz.seen.depthGrayBg === '#ffffff',
    '远景色改白 → state 和渲染核都跟上', dgz.bg + ' / ' + (dgz.seen && dgz.seen.depthGrayBg));

  /* === 3.8 导出要和「看到的」一致 === */
  console.log('\n=== 3.8 导出跟随显示 ===');
  const exp = await app.p.evaluate(async () => {
    const g = document.getElementById('mvDepthGray');
    const real = Model3D.viewGrid;
    const seen = [];
    const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    Model3D.viewGrid = function (src, o) {
      seen.push(JSON.parse(JSON.stringify(o || {})));
      return Promise.resolve({
        png: PNG1, cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1,
        cells: [{ key: 'front', name: '前', col: 0, row: 0, x: 0, y: 0, w: 1, h: 1 }],
        quad: true, pass: (o && o.pass) || 'color'
      });
    };
    g.checked = true; g.dispatchEvent(new Event('change'));
    await new Promise(x => setTimeout(x, 250));
    /* 先把范围设成非默认值，才能证明导出「跟着滑条走」而不是永远传 100 */
    const rg = document.getElementById('mvDepthGrayRange');
    rg.value = '30'; rg.dispatchEvent(new Event('input'));
    await new Promise(x => setTimeout(x, 400));
    try { document.getElementById('mvExColor').click(); } catch (e) {}
    await new Promise(x => setTimeout(x, 400));
    try { document.getElementById('mvExDepth').click(); } catch (e) {}
    await new Promise(x => setTimeout(x, 400));
    Model3D.viewGrid = real;
    g.checked = false; g.dispatchEvent(new Event('change'));
    rg.value = '100'; rg.dispatchEvent(new Event('input'));
    return seen;
  });
  const viewCall = exp.filter(o => o.pass !== 'depth' && o.pass !== 'mask').pop();
  const depthCall = exp.filter(o => o.pass === 'depth').pop();
  check(!!viewCall, '点「导出视图 PNG」走到了渲染核', 'calls=' + exp.length);
  check(viewCall && viewCall.depthGray === true, '深度灰开着 → 导出的视图 PNG 也是灰度',
    String(viewCall && viewCall.depthGray));
  check(viewCall && Math.abs(viewCall.depthGrayRange - 0.3) < 1e-6, '导出带上深度范围（0~1）',
    String(viewCall && viewCall.depthGrayRange));
  check(!!depthCall, '点「导出深度图」走到 pass=depth', depthCall ? 'ok' : 'missing');

  /* === 3.9 参数表自洽 ===
   * 解耦以后「加一个参数」只改表和两份 HTML。最容易出的错是：
   * 表里写了 id，HTML 忘了加 -> 控件永远不出现，也没有任何报错。 */
  console.log('\n=== 3.9 参数表自洽 ===');
  const tbl = await app.p.evaluate(() => {
    const F = multiview._fields || [];
    const missing = [], noId = [];
    F.forEach(f => {
      if (f.ui && f.ui !== 'none' && !f.id) noId.push(f.k);
      if (f.id && !document.getElementById(f.id)) missing.push(f.id);
      if (f.label && !document.getElementById(f.label)) missing.push(f.label);
    });
    return {
      n: F.length,
      missing, noId,
      withUi: F.filter(f => f.id).length,
      passed: F.filter(f => f.pass).length
    };
  });
  check(tbl.missing.length === 0, '表里声明的控件 id 全都存在于 DOM', tbl.missing.join(',') || '无缺失');
  check(tbl.noId.length === 0, '有 UI 的字段都写了 id', tbl.noId.join(',') || '都写了');
  check(tbl.n >= 20 && tbl.withUi >= 15, '参数表规模合理', tbl.n + ' 项，其中 ' + tbl.withUi + ' 项带控件');
  check(tbl.passed >= 15, '过半字段标了 pass（会传给渲染核）', String(tbl.passed));

  /* === 3.10 图层面板 + 每层独立的属性面板 === */
  console.log('\n=== 3.10 图层面板 / 属性面板 ===');
  const lay = await app.p.evaluate(async () => {
    const real = Model3D.viewGrid;
    Model3D.viewGrid = function () {
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    const win = document.getElementById('mvWin');
    const row = (k) => win.querySelector('.mv-ly-item[data-ly="' + k + '"]');
    const panel = (k) => win.querySelector('.mv-ly-props[data-for="' + k + '"]');
    const ids = (root) => Array.from(root.querySelectorAll('.mv-field input')).map(e => e.id).sort();
    const pool = document.getElementById('mvPropPool');
    const row0 = row('uvisland');
    const eye = row0.querySelector('.mv-ly-eye');
    const box = document.getElementById('mvUvIsland');
    const before = { on: row0.classList.contains('is-on'), checked: box.checked, state: !!multiview.state.uvIsland };

    const s0 = {
      rows: win.querySelectorAll('.mv-ly-item').length,
      panels: win.querySelectorAll('.mv-ly-props').length,
      allHidden: Array.from(win.querySelectorAll('.mv-ly-props')).every(p => p.hidden),
      carets: win.querySelectorAll('.mv-ly-caret').length,
      canvasIds: ids(document.querySelector('#mvMore .mv-more-body')),
      poolIds: ids(pool)
    };

    eye.click();                       // 开 UV 岛色
    await new Promise(r => setTimeout(r, 140));
    const afterEye = { on: row0.classList.contains('is-on'), checked: box.checked, state: !!multiview.state.uvIsland };

    row('crease').querySelector('.mv-ly-name').click();
    await new Promise(r => setTimeout(r, 80));
    const cr = {
      open: multiview.state.openLayer,
      hidden: panel('crease').hidden,
      rowOpen: row('crease').classList.contains('is-open'),
      ids: ids(panel('crease').querySelector('.mv-ly-fields')),
      desc: (panel('crease').querySelector('.mv-ly-desc') || {}).textContent || '',
      shown: Array.from(win.querySelectorAll('.mv-ly-props')).filter(p => !p.hidden).length,
      poolHasCrease: ids(pool).filter(x => /^mv(Crease|WireAngle)/.test(x)).length,
      dup: document.querySelectorAll('#mvWin #mvWireAngle').length
    };

    row('dgray').querySelector('.mv-ly-name').click();
    await new Promise(r => setTimeout(r, 80));
    const dg = {
      open: multiview.state.openLayer,
      creaseHidden: panel('crease').hidden,
      dgrayHidden: panel('dgray').hidden,
      creaseBack: ids(pool).filter(x => /^mv(Crease|WireAngle)/.test(x)).length,
      dgrayInPanel: ids(panel('dgray').querySelector('.mv-ly-fields')).length
    };

    row('dgray').querySelector('.mv-ly-name').click();   // 再点一次 = 收起
    await new Promise(r => setTimeout(r, 80));
    const off = {
      open: multiview.state.openLayer,
      hidden: Array.from(win.querySelectorAll('.mv-ly-props')).every(p => p.hidden),
      poolIds: ids(pool).length
    };

    /* 开关联动：勾上自动摊开这层，关掉自动收起 */
    const dEye = row('dgray').querySelector('.mv-ly-eye');
    dEye.click();
    await new Promise(r => setTimeout(r, 140));
    const autoOpen = { open: multiview.state.openLayer, hidden: panel('dgray').hidden, on: !!multiview.state.depthGray };
    dEye.click();
    await new Promise(r => setTimeout(r, 140));
    const autoClose = { open: multiview.state.openLayer, hidden: panel('dgray').hidden, on: !!multiview.state.depthGray };

    /* 层关着的时候展开面板：应当给出「点这里打开」的入口，而不是一片没反应的滑条 */
    row('dgray').querySelector('.mv-ly-name').click();
    await new Promise(r => setTimeout(r, 80));
    const hEl = panel('dgray').querySelector('.mv-ly-off-hint');
    const offLayer = { visible: !hEl.hidden, on: !!multiview.state.depthGray };
    hEl.click();
    await new Promise(r => setTimeout(r, 160));
    const afterHint = { on: !!multiview.state.depthGray, hintHidden: hEl.hidden, open: multiview.state.openLayer };
    const dgBox = document.getElementById('mvDepthGray');
    dgBox.checked = false; dgBox.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 140));

    eye.click();                       // UV 岛色关回去，别把状态留给下一次
    await new Promise(r => setTimeout(r, 140));
    Model3D.viewGrid = real;
    return { before, s0, afterEye, cr, dg, off, autoOpen, autoClose, offLayer, afterHint, back: !!multiview.state.uvIsland };
  });

  check(lay.before.on === false && lay.before.checked === false, 'UV 岛色默认关（行是暗的）', JSON.stringify(lay.before));
  check(lay.afterEye.state === true && lay.afterEye.checked === true && lay.afterEye.on === true,
    '点眼睛 → 真的打开了这一层（写进 state 和 input）', JSON.stringify(lay.afterEye));
  check(lay.back === false, '再点一次眼睛 → 关回去');

  check(lay.s0.rows === 10 && lay.s0.panels === 10, '每个图层各有一块自己的属性面板',
    'rows=' + lay.s0.rows + ' panels=' + lay.s0.panels);
  check(lay.s0.allHidden === true, '默认全部收起（不占地方）');
  check(lay.s0.carets === 10, '每层都有展开箭头（不透明度是每层都有的）', 'carets=' + lay.s0.carets);
  check(lay.s0.canvasIds.join(',') === 'mvGap,mvLineW,mvMargin',
    '「画布」区只剩画布参数（层参数已搬走）', lay.s0.canvasIds.join(','));
  check(lay.s0.poolIds.length === 11, '11 个层参数控件住在池里等被认领', lay.s0.poolIds.join(','));

  check(lay.cr.open === 'crease' && lay.cr.hidden === false && lay.cr.rowOpen === true,
    '点行 → 展开这一层的面板（行也标成展开态）', JSON.stringify({ o: lay.cr.open, h: lay.cr.hidden, r: lay.cr.rowOpen }));
  check(lay.cr.ids.join(',') === 'mvCreaseColor,mvCreaseTaper,mvCreaseWidth,mvWireAngle',
    '面板里正好是「角度线框」那 4 个参数', lay.cr.ids.join(','));
  check(lay.cr.desc.length > 10, '面板头部有一句说明（不然滑条看不出区别）', lay.cr.desc.slice(0, 24));
  check(lay.cr.shown === 1, '同时只展开一块面板', 'shown=' + lay.cr.shown);
  check(lay.cr.poolHasCrease === 0 && lay.cr.dup === 1,
    '控件是「搬」不是「复制」：池里没有、页面上 id 唯一',
    'pool=' + lay.cr.poolHasCrease + ' dup=' + lay.cr.dup);

  check(lay.dg.open === 'dgray' && lay.dg.creaseHidden === true && lay.dg.dgrayHidden === false,
    '点另一层 → 上一块自动收起', JSON.stringify({ o: lay.dg.open, c: lay.dg.creaseHidden, d: lay.dg.dgrayHidden }));
  check(lay.dg.creaseBack === 4, '收起的层把控件还回池里', 'back=' + lay.dg.creaseBack);
  check(lay.dg.dgrayInPanel === 2, '深度灰面板里有 2 个参数', 'n=' + lay.dg.dgrayInPanel);

  check(lay.off.open === '' && lay.off.hidden === true && lay.off.poolIds === 11,
    '再点一次 → 全部收起，控件全回池里', JSON.stringify(lay.off));

  check(lay.autoOpen.open === 'dgray' && lay.autoOpen.hidden === false && lay.autoOpen.on === true,
    '勾上深度灰 → 自动摊开它的面板', JSON.stringify(lay.autoOpen));
  check(lay.autoClose.open === '' && lay.autoClose.hidden === true && lay.autoClose.on === false,
    '关掉深度灰 → 面板自动收起（不留一排看着还生效的滑条）', JSON.stringify(lay.autoClose));
  check(lay.offLayer.visible === true && lay.offLayer.on === false,
    '层关着时展开面板 → 出现「点这里打开」的入口', JSON.stringify(lay.offLayer));
  check(lay.afterHint.on === true && lay.afterHint.hintHidden === true && lay.afterHint.open === 'dgray',
    '点那条入口 → 真的打开了这一层，提示自动消失', JSON.stringify(lay.afterHint));


  /* === 3.10b 图层不透明度 === */
  console.log('\n=== 3.10b 图层不透明度 ===');
  const opq = await app.p.evaluate(async () => {
    const real = Model3D.viewGrid;
    let seen = null;
    Model3D.viewGrid = function (src, o) {
      seen = JSON.parse(JSON.stringify(o || {}));
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    const win = document.getElementById('mvWin');
    const panel = (k) => win.querySelector('.mv-ly-props[data-for="' + k + '"]');
    const row = (k) => win.querySelector('.mv-ly-item[data-ly="' + k + '"]');

    const sliders = win.querySelectorAll('.mv-op-range').length;
    const defs = Array.from(win.querySelectorAll('.mv-op-range')).map(e => e.value);
    const badge0 = row('crease').querySelector('.mv-ly-op-badge').hidden;

    row('crease').querySelector('.mv-ly-name').click();      // 展开角度线框
    await new Promise(r => setTimeout(r, 80));
    const el = panel('crease').querySelector('.mv-op-range');
    el.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const after = {
      state: multiview.state.opacity.crease,
      label: panel('crease').querySelector('.mv-op-val').textContent,
      badge: row('crease').querySelector('.mv-ly-op-badge').textContent,
      badgeHidden: row('crease').querySelector('.mv-ly-op-badge').hidden,
      seen: seen && seen.layerOpacity ? seen.layerOpacity.crease : null,
      others: seen && seen.layerOpacity ? seen.layerOpacity.wire : null
    };

    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const back = {
      state: multiview.state.opacity.crease,
      badgeHidden: row('crease').querySelector('.mv-ly-op-badge').hidden,
      seen: seen && seen.layerOpacity ? seen.layerOpacity.crease : null
    };
    Model3D.viewGrid = real;
    return { sliders, defs, badge0, after, back };
  });
  check(opq.sliders === 10, '10 层各有一条不透明度滑条', 'n=' + opq.sliders);
  check(opq.defs.every(v => v === '100'), '默认全是 100%', opq.defs.join(','));
  check(opq.badge0 === true, '满不透明时行上不挂百分比小标');
  check(opq.after.state === 40, '拖到 40 → state 跟上', String(opq.after.state));
  check(opq.after.label === '40%' && opq.after.badge === '40%' && opq.after.badgeHidden === false,
    '面板数值和行上小标都跟着变', opq.after.label + ' / ' + opq.after.badge);
  /* 界面 0~100，渲染核 0~1：这里防的是「忘了 /100」 */
  check(opq.after.seen != null && Math.abs(opq.after.seen - 0.4) < 1e-6,
    'layerOpacity 传给渲染核的是 0~1（不是 40）', String(opq.after.seen));
  check(opq.after.others != null && opq.after.others === 1,
    '没动过的层仍然是 1（不会连带被改）', String(opq.after.others));
  check(opq.back.state === 100 && opq.back.badgeHidden === true && Math.abs(opq.back.seen - 1) < 1e-6,
    '拖回 100 → 小标消失、渲染核收到 1', JSON.stringify(opq.back));

  /* === 3.11 图层拖拽换序（任意两层都能换，含 3D↔2D） === */
  console.log('\n=== 3.11 图层拖拽 ===');
  const drag = await app.p.evaluate(async () => {
    const real = Model3D.viewGrid;
    let seenOrder = null;
    Model3D.viewGrid = function (src, o) {
      seenOrder = o && o.layerOrder ? o.layerOrder.slice() : null;
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    const list = document.getElementById('mvLayerList');
    const rows = () => [...list.querySelectorAll('.mv-ly-item')].map(r => r.getAttribute('data-ly'));
    const before = rows();

    const fire = (el, type, extra) => el.dispatchEvent(new DragEvent(type,
      Object.assign({ bubbles: true, cancelable: true, dataTransfer: dt }, extra)));
    const dt = new DataTransfer();

    /* ① 3D 组内：UV 岛色拖到线框上面（列表里岛色在最下，线框在它上面） */
    const src = list.querySelector('[data-ly="uvisland"]');
    const dst = list.querySelector('[data-ly="wire"]');
    const r1 = dst.getBoundingClientRect();
    fire(src, 'dragstart');
    fire(dst, 'dragover', { clientY: r1.top + 2 });
    fire(dst, 'drop', { clientY: r1.top + 2 });
    fire(src, 'dragend');
    await new Promise(r => setTimeout(r, 200));
    const after3d = rows();
    const order3d = (multiview.state.layerOrder || []).slice();

    /* ② 跨组：把外轮廓（2D）拖到线框（3D）上面 → 现在**允许**了。
     * 渲染核会按这个顺序切段，2D 层真的会压在那几个 3D 层之上。 */
    const src2 = list.querySelector('[data-ly="outline"]');
    const dst2 = list.querySelector('[data-ly="wire"]');
    const r2 = dst2.getBoundingClientRect();
    fire(src2, 'dragstart');
    fire(dst2, 'dragover', { clientY: r2.top + 2 });
    fire(dst2, 'drop', { clientY: r2.top + 2 });
    fire(src2, 'dragend');
    await new Promise(r => setTimeout(r, 260));
    const afterCross = rows();
    const orderCross = (multiview.state.layerOrder || []).slice();
    const seenCross = seenOrder ? seenOrder.slice() : null;

    Model3D.viewGrid = real;
    /* 复原默认顺序：拖拽会 saveSet，不还原的话下次跑测试开局就是换过的顺序 */
    const defOrder = multiview._fields.filter(f => f.k === 'layerOrder')[0].def;
    multiview.state.layerOrder = defOrder.slice();
    multiview.render();
    await new Promise(r => setTimeout(r, 120));
    return { before, after3d, order3d, afterCross, orderCross, seenCross };
  });
  check(drag.before[0] === 'grade' && drag.before[1] === 'labels' && drag.before[drag.before.length - 1] === 'bg',
    '默认顺序：后期处理在最上、背景在最下', drag.before.join('>'));
  check(drag.after3d.indexOf('uvisland') < drag.after3d.indexOf('wire'),
    '3D 组内拖拽 → UV 岛色跑到线框上面', drag.after3d.join('>'));
  /* 面板是倒序显示的，所以 state 里（先画的在前）应该反过来 */
  check(drag.order3d.indexOf('wire') < drag.order3d.indexOf('uvisland'),
    'state.layerOrder 存的是绘制序（先画的在前）', drag.order3d.join('>'));
  check(drag.afterCross.indexOf('outline') < drag.afterCross.indexOf('wire'),
    '跨组拖拽也生效：2D 的外轮廓跑到 3D 线框上面', drag.afterCross.join('>'));
  check(drag.seenCross && drag.seenCross.join('>') === drag.orderCross.join('>'),
    '交错顺序原样传给渲染核（不再被「阶段优先」掰回去）',
    String(drag.seenCross && drag.seenCross.join('>')));

  /* 光传进去不算数：渲染核要真的按这个顺序排。用真渲染返回的 layers 对一次，
   * 两次只差 layerOrder 的前后。 */
  const realOrder = await app.p.evaluate(async () => {
    /* 不碰 state.cur：前面的用例把它换成了空模型。这里现搓一个立方体 */
    const obj = ['v -1 -1 -1','v 1 -1 -1','v 1 1 -1','v -1 1 -1','v -1 -1 1','v 1 -1 1','v 1 1 1','v -1 1 1',
      'f 1 2 3 4','f 5 6 7 8','f 1 2 6 5','f 2 3 7 6','f 3 4 8 7','f 4 1 5 8'].join('\n') + '\n';
    const src = 'data:text/plain;base64,' + btoa(obj);
    /* 用两个 2D 后处理层做对照：不依赖 UV、也不受「两个线框互斥」影响 */
    const base = { views: ['front'], cell: 160, mode: 'shaded', depthEdge: true, outline: true };
    const a = await Model3D.viewGrid(src, Object.assign({ layerOrder: ['dedge', 'outline'] }, base));
    const b = await Model3D.viewGrid(src, Object.assign({ layerOrder: ['outline', 'dedge'] }, base));
    return { a: a.layers, b: b.layers, err: a.layerErr || b.layerErr };
  });
  check(!!realOrder && realOrder.a.join(',') === 'dedge,outline',
    '渲染核按传入顺序排（深度描边在前）', realOrder ? realOrder.a.join(',') : 'skipped');
  check(!!realOrder && realOrder.b.join(',') === 'outline,dedge',
    '换个顺序 → 渲染核跟着换（外轮廓在前）', realOrder ? realOrder.b.join(',') : 'skipped');

  /* === 4. 导出布局（纯逻辑）：固定正方形画布，格子铺满，偶数单格 === */
  console.log('\n=== 4. 导出布局 ===');
  const pure = await app.p.evaluate(() => ({
    L4: multiview._pure.exportLayout(4, 2048, 0, 2),
    L4g: multiview._pure.exportLayout(4, 2048, 16, 2),
    L8: multiview._pure.exportLayout(8, 4096, 0, 4),
    L1: multiview._pure.exportLayout(1, 4096, 0, 0),
    LAuto: multiview._pure.exportLayout(6, 2048, 0, 0)
  }));
  check(pure.L4.cols === 2 && pure.L4.rows === 2 && pure.L4.cell === 1024 && pure.L4.w === 2048,
    '四视图 2×2 · 2K 画布单格 1024', JSON.stringify(pure.L4));
  check(pure.L4g.cell === 1016, '间距 16 时单格 1016（2×1016+16=2048 铺满）', String(pure.L4g.cell));
  check(pure.L8.cols === 4 && pure.L8.rows === 2 && pure.L8.cell === 1024, '八视图 4×2 · 4K 画布', JSON.stringify(pure.L8));
  check(pure.L1.cols === 1 && pure.L1.cell === 4096, '单视图 4K 用满整幅（渲染核单格上限已放宽到 4096）', JSON.stringify(pure.L1));
  check(pure.LAuto.cols * pure.LAuto.rows >= 6 && pure.LAuto.cell % 2 === 0, '自动列数铺得下 + 单格保持偶数', JSON.stringify(pure.LAuto));

  /* === 3.12 背景层 + 后期处理层（始终最顶） === */
  console.log('\n=== 3.12 背景层 / 后期处理层 ===');
  const bgGrade = await app.p.evaluate(async () => {
    const real = Model3D.viewGrid;
    let seen = null;
    Model3D.viewGrid = function (src, o) {
      seen = JSON.parse(JSON.stringify(o || {}));
      return Promise.resolve({ png: '', cols: 1, rows: 1, cell: 1, gap: 0, width: 1, height: 1, cells: [], quad: true });
    };
    const win = document.getElementById('mvWin');
    const row = (k) => win.querySelector('.mv-ly-item[data-ly="' + k + '"]');
    const bgBox = document.getElementById('mvBg');
    const bgColor = document.getElementById('mvBgColor');
    const gBox = document.getElementById('mvGrade');
    const gSat = document.getElementById('mvGradeSat');
    const gCon = document.getElementById('mvGradeContrast');
    const gBri = document.getElementById('mvGradeBright');

    const before = {
      bg: bgBox.checked, bgState: !!multiview.state.bg,
      grade: gBox.checked, gradeState: !!multiview.state.grade,
      sat: multiview.state.gradeSat, con: multiview.state.gradeContrast, bri: multiview.state.gradeBright,
      gradeRowTop: win.querySelectorAll('.mv-ly-item')[0].getAttribute('data-ly'),
      gradeDraggable: row('grade').getAttribute('draggable'),
      gradeLock: !!row('grade').querySelector('.mv-ly-lock'),
      bgDraggable: row('bg').getAttribute('draggable'),
      bgLock: !!row('bg').querySelector('.mv-ly-lock'),
      bgRowBottom: win.querySelectorAll('.mv-ly-item')[win.querySelectorAll('.mv-ly-item').length - 1]
        .getAttribute('data-ly')
    };

    bgBox.checked = true; bgBox.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    bgColor.value = '#123456'; bgColor.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 300));
    const bgSeen = seen ? JSON.parse(JSON.stringify(seen)) : null;

    gBox.checked = true; gBox.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    gSat.value = '150'; gSat.dispatchEvent(new Event('input'));
    gCon.value = '120'; gCon.dispatchEvent(new Event('input'));
    gBri.value = '25'; gBri.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 400));
    const gradeSeen = seen ? JSON.parse(JSON.stringify(seen)) : null;
    const labels = {
      sat: document.getElementById('mvGradeSatV').textContent,
      con: document.getElementById('mvGradeContrastV').textContent,
      bri: document.getElementById('mvGradeBrightV').textContent
    };
    /* 后期处理层永远在最上：state.layerOrder 里它必须在最后 */
    const order = (multiview.state.layerOrder || []).slice();

    Model3D.viewGrid = real;
    /* 复原 */
    bgBox.checked = false; bgBox.dispatchEvent(new Event('change'));
    bgColor.value = '#ffffff'; bgColor.dispatchEvent(new Event('input'));
    gBox.checked = false; gBox.dispatchEvent(new Event('change'));
    gSat.value = '100'; gSat.dispatchEvent(new Event('input'));
    gCon.value = '100'; gCon.dispatchEvent(new Event('input'));
    gBri.value = '0'; gBri.dispatchEvent(new Event('input'));
    return { before, bgSeen, gradeSeen, labels, order };
  });
  check(bgGrade.before.bg === false && bgGrade.before.bgState === false, '背景层默认关', JSON.stringify(bgGrade.before));
  check(bgGrade.before.grade === false && bgGrade.before.gradeState === false, '后期处理层默认关');
  check(bgGrade.before.sat === 1 && bgGrade.before.con === 1 && bgGrade.before.bri === 0,
    '后期参数默认都是中性（不改画面）', JSON.stringify({ s: bgGrade.before.sat, c: bgGrade.before.con, b: bgGrade.before.bri }));
  check(bgGrade.before.gradeRowTop === 'grade', '后期处理层排在图层面板最上面（第一行）', String(bgGrade.before.gradeRowTop));
  check(bgGrade.before.gradeDraggable === 'false' && bgGrade.before.gradeLock === true,
    '后期处理层不可拖动（带锁标）', JSON.stringify({ d: bgGrade.before.gradeDraggable, l: bgGrade.before.gradeLock }));
  check(bgGrade.before.bgDraggable === 'false' && bgGrade.before.bgLock === true,
    '背景层也不可拖动（带锁标）——拖到模型上面会把模型整块盖掉',
    JSON.stringify({ d: bgGrade.before.bgDraggable, l: bgGrade.before.bgLock }));
  check(bgGrade.before.bgRowBottom === 'bg', '背景层排在图层面板最下面（最后一行）',
    String(bgGrade.before.bgRowBottom));
  check(bgGrade.order[bgGrade.order.length - 1] === 'grade', 'state.layerOrder 里「后期处理」固定在最后（= 最上层）',
    bgGrade.order.join('>'));
  check(bgGrade.order[0] === 'bg', 'state.layerOrder 里「背景」固定在最前（= 最底层）',
    bgGrade.order.join('>'));
  check(bgGrade.bgSeen && bgGrade.bgSeen.bg === true, '渲染核收到 bg=true', String(bgGrade.bgSeen && bgGrade.bgSeen.bg));
  check(bgGrade.bgSeen && bgGrade.bgSeen.bgColor === '#123456', '背景色传下去了',
    String(bgGrade.bgSeen && bgGrade.bgSeen.bgColor));
  check(bgGrade.gradeSeen && bgGrade.gradeSeen.grade === true, '渲染核收到 grade=true',
    String(bgGrade.gradeSeen && bgGrade.gradeSeen.grade));
  check(bgGrade.gradeSeen && Math.abs(bgGrade.gradeSeen.gradeSat - 1.5) < 1e-6, '饱和度传下去是倍数（1.5 不是 150）',
    String(bgGrade.gradeSeen && bgGrade.gradeSeen.gradeSat));
  check(bgGrade.gradeSeen && Math.abs(bgGrade.gradeSeen.gradeContrast - 1.2) < 1e-6, '对比度传下去是倍数',
    String(bgGrade.gradeSeen && bgGrade.gradeSeen.gradeContrast));
  check(bgGrade.gradeSeen && Math.abs(bgGrade.gradeSeen.gradeBright - 0.25) < 1e-6, '亮度传下去是倍数',
    String(bgGrade.gradeSeen && bgGrade.gradeSeen.gradeBright));
  check(bgGrade.labels.sat === '150%' && bgGrade.labels.con === '120%' && bgGrade.labels.bri === '+25',
    '三个滑条的标签都同步', JSON.stringify(bgGrade.labels));

  /* === 3.12b 后期处理层 / 背景层在渲染核里真的作用到像素 === */
  const px = await app.p.evaluate(async () => {
    const obj = ['v -1 -1 -1','v 1 -1 -1','v 1 1 -1','v -1 1 -1','v -1 -1 1','v 1 -1 1','v 1 1 1','v -1 1 1',
      'f 1 2 3 4','f 5 6 7 8','f 1 2 6 5','f 2 3 7 6','f 3 4 8 7','f 4 1 5 8'].join('\n') + '\n';
    const src = 'data:text/plain;base64,' + btoa(obj);
    const base = { views: ['front'], cell: 120, mode: 'material' };
    /* 取角落像素（格子之外 = 纯背景），这样背景层 / 调色的效果看得最清楚 */
    const corner = async (opts) => {
      const r = await Model3D.viewGrid(src, Object.assign({}, base, opts));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = r.png; });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(2, 2, 1, 1).data;
      return { png: r.png, px: [d[0], d[1], d[2], d[3]], layers: r.layers, err: r.layerErr || null };
    };
    const bg = await corner({ bg: true, bgColor: '#ff0000' });
    const bgGray = await corner({ bg: true, bgColor: '#ff0000', grade: true, gradeSat: 0 });
    const bgDark = await corner({ bg: true, bgColor: '#ff0000', grade: true, gradeBright: -0.5 });
    const bgBright = await corner({ bg: true, bgColor: '#808080', grade: true, gradeBright: 0.5 });
    return { bg, bgGray, bgDark, bgBright };
  });
  check(!!px.bg && px.bg.png, '带背景层的渲染成功');
  check(px.bg.px[0] > 200 && px.bg.px[1] < 60 && px.bg.px[2] < 60, '背景层开 → 角落是背景红',
    px.bg.px.join(','));
  check(px.bgGray.px[0] === px.bgGray.px[1] && px.bgGray.px[1] === px.bgGray.px[2],
    '饱和度 0 → 背景红变灰（调色真的作用到像素了）', px.bgGray.px.join(','));
  check(px.bgDark.px[0] < px.bg.px[0], '亮度 -50% → 变暗', px.bgDark.px.join(',') + ' vs ' + px.bg.px.join(','));
  check(px.bgBright.px[0] > 0x80, '亮度 +50% → 变亮', px.bgBright.px.join(','));

  /* === 3.12c 老存档缺层时的图层顺序（回归） ===
   * 背景层是「白底」：它一旦被排到最上层，整张图就白了，模型直接看不见。
   * 存档里存的是用户拖出来的 k 序列，老存档根本没有 bg 这一层 →
   * 渲染核排序时给它 999（= 最上层）→ 白底盖住模型。
   * 现在缺层按表里的默认位置插回去。 */
  const miss = await app.p.evaluate(async () => {
    const obj = ['v -1 -1 -1','v 1 -1 -1','v 1 1 -1','v -1 1 -1','v -1 -1 1','v 1 -1 1','v 1 1 1','v -1 1 1',
      'f 1 2 3 4','f 5 6 7 8','f 1 2 6 5','f 2 3 7 6','f 3 4 8 7','f 4 1 5 8'].join('\n') + '\n';
    const src = 'data:text/plain;base64,' + btoa(obj);
    /* 老存档：只有 8 层，没有 bg，也没有 grade */
    const old = ['uvisland', 'wire', 'crease', 'uvseam', 'dgray', 'outline', 'dedge', 'labels'];
    const r = await Model3D.viewGrid(src, {
      views: ['front'], cell: 120, mode: 'material', bg: true, bgColor: '#ffffff',
      uvIsland: true,
      layerOrder: old
    });
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = r.png; });
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    /* 中心那个立方体（有模型的地方）不该是纯白 */
    const c = cx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
    return { layers: r.layers, center: [c[0], c[1], c[2], c[3]] };
  });
  check(miss.layers && miss.layers.length && miss.layers[0] === 'bg',
    '老存档缺「背景层」→ 它被补到最底下，不是最上面',
    String(miss.layers));
  check(miss.center[0] < 250 || miss.center[1] < 250 || miss.center[2] < 250,
    '老存档缺「背景层」也不会白底盖住模型（中心像素不是纯白）', miss.center.join(','));

  /* App 端同一件事：loadSet 里要把缺层补齐（背景补最底、后期处理补最上） */
  const norm = await app.p.evaluate(() => {
    const N = multiview._pure.normalizeLayerOrder;
    const old8 = ['uvisland', 'wire', 'crease', 'uvseam', 'dgray', 'outline', 'dedge', 'labels'];
    const withGrade = old8.concat(['grade']);
    const bad = ['grade', 'wire', 'uvisland', 'bg'];
    return {
      old8: N(old8),
      withGrade: N(withGrade),
      bad: N(bad),
      def: N(['bg', 'uvisland', 'dgray', 'wire', 'crease', 'uvseam', 'outline', 'dedge', 'labels', 'grade'])
    };
  });
  check(norm.old8[0] === 'bg' && norm.old8[norm.old8.length - 1] === 'grade',
    '老存档（8 层）补齐 → 背景在最底、后期处理在最上', norm.old8.join(','));
  check(norm.withGrade[norm.withGrade.length - 1] === 'grade',
    '后期处理层无论写在哪儿都挪到最后', norm.withGrade.join(','));
  check(norm.bad[0] === 'bg' && norm.bad[norm.bad.length - 1] === 'grade',
    '乱序存档也要收敛（背景在最底、后期处理在最上）', norm.bad.join(','));

  /* 背景层是**固定位**（跟后期处理层对称）：不可拖、带锁标。
   * 用户报「背景图层总是显示在最上面」——那要么是层序错了，要么是它能被拖到上面。
   * 后者要靠「不可拖 + 锁标」挡住。 */
  const bgFix = await app.p.evaluate(() => {
    const rows = [...document.querySelectorAll('#mvLayerList .mv-ly-item')];
    const bg = rows.find(r => r.getAttribute('data-ly') === 'bg');
    const grade = rows.find(r => r.getAttribute('data-ly') === 'grade');
    const lockText = el => el && el.querySelector('.mv-ly-lock') ? el.querySelector('.mv-ly-lock').textContent : null;
    return {
      rows: rows.map(r => r.getAttribute('data-ly')),
      bgIndex: rows.indexOf(bg),
      gradeIndex: rows.indexOf(grade),
      bgDraggable: bg ? bg.getAttribute('draggable') : null,
      gradeDraggable: grade ? grade.getAttribute('draggable') : null,
      bgLock: lockText(bg),
      gradeLock: lockText(grade)
    };
  });
  check(bgFix.bgIndex === bgFix.rows.length - 1,
    '面板里「背景」那一行在最后一行（= 最底）', 'index=' + bgFix.bgIndex + '/' + bgFix.rows.length);
  check(bgFix.gradeIndex === 0, '面板里「后期处理」在第一行（= 最上）', 'index=' + bgFix.gradeIndex);
  check(bgFix.bgDraggable === 'false', '背景层不可拖动（拖到模型上面会盖死模型）', String(bgFix.bgDraggable));
  check(bgFix.gradeDraggable === 'false', '后期处理层不可拖动', String(bgFix.gradeDraggable));
  check(bgFix.bgLock === '底' && bgFix.gradeLock === '顶',
    '两个固定位各带自己的锁标（底 / 顶）', JSON.stringify({ bg: bgFix.bgLock, grade: bgFix.gradeLock }));

  /* === 5. 导出条控件存在，可用态跟「有没有当前模型」一致 === */
  const exUi = await app.p.evaluate(() => ({
    missing: ['mvExSize', 'mvExGap', 'mvExInfo', 'mvExStats', 'mvExPreview', 'mvExColor', 'mvExDepth', 'mvExMask']
      .filter(id => !document.getElementById(id)),
    hasCur: !!multiview.state.cur,
    disabled: ['mvExPreview', 'mvExColor', 'mvExDepth', 'mvExMask'].map(id => document.getElementById(id).disabled),
    info: document.getElementById('mvExInfo').textContent
  }));
  check(exUi.missing.length === 0, '导出条 8 个控件都在两份壳里', exUi.missing.join(','));
  check(exUi.disabled.every(d => d === !exUi.hasCur), '导出按钮可用态跟当前模型一致（App 自动选了模型 → 启用）',
    JSON.stringify({ hasCur: exUi.hasCur, disabled: exUi.disabled }));
  check(/画布 \d+×\d+/.test(exUi.info), '布局信息已算出（N视图 CxR · 画布 · 单格）', exUi.info);

  await app.p.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
