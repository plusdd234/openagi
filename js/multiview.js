/* ============================================================
 * 多视图 App：把一个 3D 模型渲成一组**严格等比例**的视图组图
 *
 * 跟工作流里那个「3D 模型转四视图」节点的关系：
 *   节点是流水线里的一步（固定四视图、固定 2K，交给下游生 3D）；
 *   这个 App 是给人**看和用**的：挑视图、切模式、调底色、只下一张、
 *   存进图库当参考图。两者共用同一个渲染核 Model3D.viewGrid，不各写一份。
 *
 * 四个设计取舍：
 *   ① 默认**正交**相机。多视图的全部意义是比例，透视会让各视图互相矛盾，
 *      那种图拿去做建模参考是负资产。透视只在「出效果图」时才选。
 *   ② 默认**素模**。模型自带材质十有八九是全黑或丢贴图（尤其 OBJ），
 *      直接渲出来一片糊；中性灰打光才看得清结构。
 *   ③ 参数改动**自动重渲**（防抖 260ms）+ 串行执行。连点滑块时后一次不该
 *      等前一次渲完才排队，也不该让两个 WebGL 上下文同时存在。
 *   ④ 单格靠**裁剪整图**得到，不重新渲染。重渲一次要新建 renderer，
 *      而裁剪只是一次 drawImage——差距在「导出八张」时非常明显。
 * ============================================================ */
(function () {
  'use strict';

  var SET_KEY = 'hf_mv_set';
  var BUSY_NS = 'mvBusyAt';

  /* 视图顺序只在这里定义；真正的方向表在 Model3D.VIEWS，前端不抄第二份 */
  var VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'isoAlt'];

  var PRESETS = [
    { k: 'three', n: '三视图', v: ['front', 'left', 'right'] },
    { k: 'four',  n: '四视图', v: ['front', 'back', 'left', 'right'] },
    { k: 'six',   n: '六视图', v: ['front', 'back', 'left', 'right', 'top', 'bottom'] },
    { k: 'all',   n: '八视图', v: VIEW_ORDER.slice() }
  ];

  /* 「线框」不再是模式之一，而是一个独立开关（见 DEFAULTS.wire）。
   * 模式只决定**面**怎么填：素模打光 / 自带材质 / 纯白平涂。
   * 这样「素模 + 线框」「材质 + 线框」才成立——四选一的做法做不到。 */
  var MODES = [
    { k: 'shaded',   n: '素模', t: '中性灰打光，最接近建模参考图' },
    { k: 'material', n: '材质', t: '模型自带的材质与贴图' },
    { k: 'solid',    n: '纯色', t: '平涂白面，不加明暗' }
  ];

  var CAMS = [
    { k: 'ortho', n: '正交', t: '各格比例一致，多视图必须正交' },
    { k: 'persp', n: '透视', t: '近大远小，适合出效果图' }
  ];

  var SIZES = [512, 768, 1024, 1536];

  /* 导出面板：画布固定正方形（对齐参考实现的 2K/4K 口径），
   * AI 生图回流时按同一尺寸出图才能逐像素对齐。 */
  var EX_SIZES = [2048, 4096];
  var EX_GAPS = [0, 16, 32, 64];

  var COLS = [{ k: 0, n: '自动' }, { k: 2, n: '2 列' }, { k: 3, n: '3 列' }, { k: 4, n: '4 列' }];

  /* 底色**固定透明**：这套图的用途是贴到别的底上（AI 出图参考、排版、贴图对齐），
   * 带白底反而要再抠一遍。所以不再给「白 / 深 / 透明」开关。 */
  var DEFAULTS = {
    views: ['front', 'back', 'left', 'right'],
    mode: 'solid',
    wire: true,
    cam: 'ortho',
    cell: 768,
    cols: 0,
    gap: 0,
    margin: 1.08,
    lineWidth: 1.4,
    labels: true,
    exSize: 2048,
    exGap: 0
  };

  var state = {
    open: false,
    models: [],
    cur: null,            // { id, name, src }
    views: DEFAULTS.views.slice(),
    mode: DEFAULTS.mode,
    wire: DEFAULTS.wire,
    cam: DEFAULTS.cam,
    cell: DEFAULTS.cell,
    cols: DEFAULTS.cols,
    gap: DEFAULTS.gap,
    margin: DEFAULTS.margin,
    lineWidth: DEFAULTS.lineWidth,
    labels: DEFAULTS.labels,
    exSize: DEFAULTS.exSize,   // 导出画布 2048 / 4096（正方形）
    exGap: DEFAULTS.exGap,     // 导出间距 0 / 16 / 32 / 64
    out: null,            // viewGrid 结果
    pick: -1,
    busy: '',
    error: '',
    loaded: false
  };

  function $(id) { return document.getElementById(id); }
  function cls(el, name, on) { if (el) el.classList[on ? 'add' : 'remove'](name); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMB(b) {
    var n = Number(b) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  /* 自动列数：先少空格，再接近正方，同分取大的列（宽屏更顺眼）。
   * 直接拿 ceil(√n) 会把 8 视图排成 3×3（右下空一格），比 4×2 难看得多。 */
  function autoCols(n) {
    n = Math.max(1, Math.min(16, Math.round(Number(n) || 1)));
    if (n === 1) return 1;
    var best = 1, bestScore = Infinity;
    for (var c = 1; c <= n; c++) {
      var r = Math.ceil(n / c);
      var score = (c * r - n) * 100 + Math.abs(c - r);
      if (score < bestScore || (score === bestScore && c > best)) { bestScore = score; best = c; }
    }
    return best;
  }

  function viewName(k) {
    var t = (window.Model3D && Model3D.VIEWS) || {};
    return (t[k] && t[k].name) || k;
  }

  function countLabel(n) {
    if (n === 1) return '单视图';
    if (n === 2) return '双视图';
    return n + ' 视图';
  }

  function friendly(e) {
    var m = String((e && e.message) || e || '未知错误');
    if (/three\.js 未就绪/.test(m)) return '3D 组件还没加载完，稍等一下再试';
    if (/包围盒为空/.test(m)) return '这个模型没有可渲染的网格（可能是空文件或纯点线）';
    if (/没有可渲染的网格/.test(m)) return '这个模型里没有网格，只有空节点';
    if (/画布过大/.test(m)) return '尺寸太大，画布撑爆了——把单格调到 1024 以内';
    if (/Failed to fetch|NetworkError/.test(m)) return '模型读不出来：文件可能已丢失，重新导入一次';
    return m;
  }

  /* ---------- 设置持久化 ---------- */

  function loadSet() {
    var d = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      var raw = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
      if (Array.isArray(raw.views) && raw.views.length) {
        var v = VIEW_ORDER.filter(function (k) { return raw.views.indexOf(k) >= 0; });
        if (v.length) d.views = v;
      }
      /* 老版本的 mode='line'（白面 + 黑线）拆成了两个维度：
       * 面 = 纯色、线 = 勾上。迁移过来视觉上完全一样，不会让人以为设置丢了。 */
      if (raw.mode === 'line') { d.mode = 'solid'; d.wire = true; }
      else if (MODES.some(function (m) { return m.k === raw.mode; })) d.mode = raw.mode;
      if (typeof raw.wire === 'boolean') d.wire = raw.wire;
      if (CAMS.some(function (m) { return m.k === raw.cam; })) d.cam = raw.cam;
      if (SIZES.indexOf(Number(raw.cell)) >= 0) d.cell = Number(raw.cell);
      if (COLS.some(function (m) { return m.k === Number(raw.cols); })) d.cols = Number(raw.cols);
      if (typeof raw.gap === 'number' && raw.gap >= 0 && raw.gap <= 48) d.gap = Math.round(raw.gap);
      if (typeof raw.margin === 'number' && raw.margin >= 1 && raw.margin <= 1.6) d.margin = raw.margin;
      if (typeof raw.lineWidth === 'number' && raw.lineWidth >= 0.4 && raw.lineWidth <= 6) d.lineWidth = raw.lineWidth;
      if (typeof raw.labels === 'boolean') d.labels = raw.labels;
      if (EX_SIZES.indexOf(Number(raw.exSize)) >= 0) d.exSize = Number(raw.exSize);
      if (EX_GAPS.indexOf(Number(raw.exGap)) >= 0) d.exGap = Number(raw.exGap);
    } catch (e) { /* 坏数据就整份用默认，别让窗口打不开 */ }
    return d;
  }

  function saveSet() {
    try {
      localStorage.setItem(SET_KEY, JSON.stringify({
        views: state.views, mode: state.mode, wire: state.wire, cam: state.cam, cell: state.cell,
        cols: state.cols, gap: state.gap, margin: state.margin,
        lineWidth: state.lineWidth, labels: state.labels,
        exSize: state.exSize, exGap: state.exGap
      }));
    } catch (e) { /* 配额满了不该让 UI 崩 */ }
  }

  function applySet(d) {
    state.views = d.views.slice();
    state.mode = d.mode;
    state.wire = d.wire;
    state.cam = d.cam;
    state.cell = d.cell;
    state.cols = d.cols;
    state.gap = d.gap;
    state.margin = d.margin;
    state.lineWidth = d.lineWidth;
    state.labels = d.labels;
    state.exSize = d.exSize;
    state.exGap = d.exGap;
  }

  /* ---------- 模型来源 ---------- */

  /* 同一个脚本跑在两种壳里：
   *   桌面 App  → window.openagiDesktop 在（能读模型库、能存图库）
   *   独立页    → 没有（只能拖文件 / 打开文件，导出走下载）
   * 用函数而不是常量：preload 的注入时机比页面脚本早，但测试里用 addInitScript
   * 补注入时会晚一步，读一次就写死的写法在测试里会拿到错误答案。 */
  function hasDesk() {
    var d = window.openagiDesktop;
    return !!(d && typeof d.assetList === 'function');
  }

  function lib() {
    var d = window.openagiDesktop;
    return (d && typeof d.assetList === 'function') ? d : null;
  }

  function modelExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  async function loadModels() {
    var d = lib();
    if (!d) {
      state.models = [];
      state.error = '';
      state.loaded = true;
      return;
    }
    try {
      var r = await d.assetList();
      var all = (r && r.assets) || [];
      state.models = all.filter(function (a) { return a && a.kind === 'model' && !a.missing; });
      state.loaded = true;
      state.error = '';
    } catch (e) {
      state.models = [];
      state.error = '读模型库失败：' + friendly(e);
    }
  }

  async function pickModel(id) {
    var d = lib();
    if (!d) { state.error = '桌面端才能读本地模型库'; paint(); return; }
    var m = state.models.filter(function (a) { return a.id === id; })[0];
    if (!m) return;
    setBusy('loading');
    try {
      var r = await d.assetRead(id);
      if (!r || !r.ok || !r.dataURL) throw new Error('文件已丢失');
      state.cur = { id: id, name: m.name, src: r.dataURL };
      state.error = '';
      paintModels();
      render();                     // 选完立刻出图：改参数会自动重渲，选模型也该一样
    } catch (e) {
      state.error = '打不开「' + m.name + '」：' + friendly(e);
      setBusy('');
      paint();
    }
  }

  function takeFile(file) {
    if (!file) return;
    var ext = modelExt(file.name);
    if (['glb', 'gltf', 'obj'].indexOf(ext) < 0) {
      state.error = '只认 glb / gltf / obj（' + (ext ? '.' + ext : '无扩展名') + ' 解析不了）';
      paint();
      return;
    }
    setBusy('loading');
    var rd = new FileReader();
    rd.onload = function () {
      state.cur = { id: '', name: file.name, src: String(rd.result || '') };
      state.error = '';
      paintModels();
      render();
    };
    rd.onerror = function () {
      state.error = '读不了这个文件';
      setBusy('');
      paint();
    };
    rd.readAsDataURL(file);
  }

  /* ---------- 渲染 ---------- */

  var running = false;
  var pending = false;
  var timer = 0;

  function scheduleRender(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { render(); }, ms == null ? 260 : ms);
  }

  async function render() {
    if (!state.cur || !state.cur.src) return;
    /* 串行：同时开两个渲染 = 同时存在两个 WebGL 上下文，
     * 而且后一次的结果可能先回来把前一次的覆盖掉。 */
    if (running) { pending = true; return; }
    running = true;
    try {
      do {
        pending = false;
        await renderOnce();
      } while (pending);
    } finally {
      running = false;
    }
  }

  async function renderOnce() {
    if (!window.Model3D || typeof Model3D.viewGrid !== 'function') {
      state.error = '3D 渲染组件未就绪（three.js 没加载上）';
      setBusy('');
      paint();
      return;
    }
    if (!Model3D.ready()) {
      state.error = '3D 渲染组件未就绪（three.js 没加载上）';
      setBusy('');
      paint();
      return;
    }
    setBusy('render');
    try {
      var o = await Model3D.viewGrid(state.cur.src, {
        views: state.views.slice(),
        cell: state.cell,
        cols: state.cols || autoCols(state.views.length),
        gap: state.gap,
        cam: state.cam,
        mode: state.mode,
        /* 底色永远是透明的：这套图的用途是叠到别处，带底还得再抠一遍 */
        transparent: true,
        wire: state.wire,
        labels: state.labels,
        margin: state.margin,
        lineWidth: state.lineWidth
      });
      state.out = o;
      state.stats = o.stats || null;
      state.pick = -1;
      state.error = '';
    } catch (e) {
      state.out = null;
      state.stats = null;
      state.error = '渲染失败：' + friendly(e);
    }
    setBusy('');
    paint();
  }

  function setBusy(kind) {
    state.busy = kind || '';
    var el = $('mvInfo');
    if (!el) return;
    if (kind === 'render') el.textContent = '渲染中…';
    else if (kind === 'loading') el.textContent = '读取模型…';
    else paintInfo();
  }

  /* ---------- 下载 ---------- */

  function baseName() {
    var n = (state.cur && state.cur.name) || 'model';
    return String(n).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'model';
  }

  function saveBlob(blob, filename) {
    if (!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function dataUrlToBlob(u) {
    var i = String(u || '').indexOf(',');
    if (i < 0) return null;
    var head = u.slice(0, i), body = u.slice(i + 1);
    var mime = /:(.*?);/.exec(head);
    var bin = atob(body);
    var arr = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return new Blob([arr], { type: (mime && mime[1]) || 'image/png' });
  }

  function downloadAll() {
    if (!state.out) return;
    saveBlob(dataUrlToBlob(state.out.png), baseName() + '_' + state.out.cells.length + '视图.png');
    say('已导出整图 · ' + state.out.width + '×' + state.out.height);
  }

  /* 单格靠裁剪得到：只 drawImage 一次，不重新渲染。
   * 重渲要新建 WebGLRenderer（几百毫秒 + 一个上下文），裁一张只要几毫秒。 */
  function downloadCell(idx) {
    var o = state.out;
    if (!o) return;
    var c = o.cells[idx];
    if (!c) return;
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement('canvas');
      cv.width = c.w;
      cv.height = c.h;
      var cx = cv.getContext('2d');
      /* 透明背景要保留 alpha，所以不能先填白底 */
      cx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
      cv.toBlob(function (blob) {
        saveBlob(blob, baseName() + '_' + c.key + '.png');
        say('已导出「' + c.name + '」视图 · ' + c.w + '×' + c.h);
      }, 'image/png');
    };
    img.onerror = function () { state.error = '裁剪失败：结果图读不出来'; paint(); };
    img.src = o.png;
  }

  /* ---------- 导出面板（对齐 AIGC工具包 的口径：固定画布 · 深度 · 遮罩） ---------- */

  /**
   * 导出布局（纯逻辑，测试直接调）：画布固定正方形，格子尽量铺满。
   * cell = (size - gap*(cols-1)) / cols 向下取整并保持偶数（与渲染核口径一致），
   * 画布永远 size×size —— AI 生图回流时按同一尺寸出图才能逐像素对齐。
   */
  function exportLayout(nViews, size, gap, colsOpt) {
    nViews = Math.max(1, Math.min(16, Math.round(Number(nViews) || 1)));
    size = EX_SIZES.indexOf(Number(size)) >= 0 ? Number(size) : 2048;
    gap = EX_GAPS.indexOf(Number(gap)) >= 0 ? Number(gap) : 0;
    var cols = Math.round(Number(colsOpt) || 0);
    if (cols < 1) cols = autoCols(nViews);
    cols = Math.min(cols, nViews);
    var rows = Math.ceil(nViews / cols);
    var cell = Math.floor((size - gap * (cols - 1)) / cols);
    if (cell % 2) cell -= 1;
    return { cols: cols, rows: rows, cell: cell, w: size, h: size };
  }

  function fmtN(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var EX_SUFFIX = { color: '', depth: '_depth', mask: '_mask' };
  var EX_LABEL = { color: '视图', depth: '深度图', mask: '遮罩图' };

  /* 导出渲染：深度/遮罩只看轮廓与前后关系，与材质模式无关（渲染核里被 overrideMaterial 盖掉）；
   * 导出图一律不烧标签 —— 拿去当 AI 参考图时标签是脏像素。 */
  async function exportPNG(pass) {
    if (!state.cur || !state.cur.src) { say('先选一个模型'); return null; }
    if (!window.Model3D || typeof Model3D.viewGrid !== 'function' || !Model3D.ready()) {
      say('3D 渲染组件未就绪（three.js 没加载上）');
      return null;
    }
    var L = exportLayout(state.views.length, state.exSize, state.exGap, state.cols);
    setBusy('render');
    try {
      var o = await Model3D.viewGrid(state.cur.src, {
        views: state.views.slice(),
        cell: L.cell,
        cols: L.cols,
        gap: state.exGap,
        cam: state.cam,
        mode: pass === 'color' ? state.mode : 'solid',
        wire: pass === 'color' ? state.wire : false,
        transparent: pass === 'color',
        labels: false,
        margin: state.margin,
        lineWidth: state.lineWidth,
        pass: pass
      });
      setBusy('');
      return o;
    } catch (e) {
      setBusy('');
      say('导出失败：' + friendly(e));
      return null;
    }
  }

  async function downloadExport(pass) {
    var o = await exportPNG(pass);
    if (!o) return;
    saveBlob(dataUrlToBlob(o.png), baseName() + '_' + o.cells.length + '视图' + EX_SUFFIX[pass] + '.png');
    say('已导出' + EX_LABEL[pass] + ' · ' + o.width + '×' + o.height + (pass === 'depth' ? ' · 近白远黑' : pass === 'mask' ? ' · 黑底白模' : ''));
  }

  /* 预览导出结果：弹层里先看大图，确认了再下载。 */
  var xlEl = null;
  var xlCur = null;

  function ensureOverlay() {
    if (xlEl) return xlEl;
    xlEl = document.createElement('div');
    xlEl.className = 'mv-xl hidden';
    xlEl.innerHTML =
      '<div class="mv-xl-card" role="dialog" aria-label="导出预览">' +
        '<div class="mv-xl-head"><span class="mv-xl-t">导出预览</span>' +
          '<button type="button" class="mv-xl-x" aria-label="关闭">×</button></div>' +
        '<div class="mv-xl-body"><img class="mv-xl-img" alt="导出预览" draggable="false"></div>' +
        '<div class="mv-xl-foot"><span class="mv-xl-info"></span>' +
          '<button type="button" class="btn sm primary mv-xl-dl">下载 PNG</button></div>' +
      '</div>';
    document.body.appendChild(xlEl);
    xlEl.addEventListener('mousedown', function (ev) { if (ev.target === xlEl) closeExportOverlay(); });
    xlEl.querySelector('.mv-xl-x').addEventListener('click', closeExportOverlay);
    xlEl.querySelector('.mv-xl-dl').addEventListener('click', function () {
      if (xlCur) saveBlob(dataUrlToBlob(xlCur.png), baseName() + '_' + xlCur.cells.length + '视图.png');
    });
    return xlEl;
  }

  function openExportOverlay(o) {
    var el = ensureOverlay();
    xlCur = o;
    el.querySelector('.mv-xl-img').src = o.png;
    el.querySelector('.mv-xl-info').textContent =
      o.width + '×' + o.height + ' · ' + o.cells.length + ' 格 · 单格 ' + o.cell;
    el.classList.remove('hidden');
  }

  function closeExportOverlay() {
    if (xlEl) xlEl.classList.add('hidden');
    xlCur = null;
  }

  async function previewExport() {
    var o = await exportPNG('color');
    if (!o) return;
    openExportOverlay(o);
  }

  async function saveToLib() {
    if (!state.out) return;
    var d = lib();
    if (!d || typeof d.assetPut !== 'function') {
      say('浏览器里存不进图库，用「下载整图」');
      return;
    }
    setBusy('saving');
    try {
      var r = await d.assetPut({
        kind: 'image',
        name: baseName() + '_' + state.out.cells.length + '视图.png',
        ext: 'png',
        data: state.out.png,
        source: 'multiview'
      });
      if (r && r.ok) say('已存入图库 · 图库里能看到这张');
      else say('入库失败：' + ((r && r.message) || '未知原因'));
    } catch (e) {
      say('入库失败：' + friendly(e));
    }
    setBusy('');
  }

  var sayTimer = 0;
  function say(msg) {
    var el = $('mvInfo');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-say');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(function () {
      if (el) el.classList.remove('is-say');
      paintInfo();
    }, 2600);
  }

  /* ---------- 绘制 ---------- */

  function paintModels() {
    var box = $('mvList');
    if (!box) return;

    if (!state.models.length) {
      var hint = state.error ? esc(state.error)
        : (hasDesk()
          ? '模型库还没有 3D 资产。<br>用下面「打开模型库」导入 glb / obj，或者直接把文件拖进来。'
          : '把 glb / gltf / obj 拖进来，或点上面「＋ 文件」。<br>OBJ 的四边形面按原始拓扑画线框，不会出现三角化的对角线。');
      box.innerHTML = '<div class="mv-none">' + hint + '</div>';
      return;
    }

    box.innerHTML = state.models.map(function (a) {
      var on = state.cur && state.cur.id === a.id ? ' is-on' : '';
      var ext = String(a.ext || modelExt(a.name) || '').toUpperCase();
      return '<button type="button" class="mv-item' + on + '" data-mv-id="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
        '<span class="mv-item-ext">' + esc(ext) + '</span>' +
        '<span class="mv-item-main">' +
          '<span class="mv-item-n">' + esc(a.name) + '</span>' +
          '<span class="mv-item-m">' + fmtMB(a.size) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-mv-id]'), function (b) {
      b.addEventListener('click', function () { pickModel(b.dataset.mvId); });
    });
  }

  function seg(host, items, cur, onPick, labelKey) {
    if (!host) return;
    var k = labelKey || 'n';
    host.innerHTML = items.map(function (it) {
      var on = String(it.k) === String(cur) ? ' is-on' : '';
      return '<button type="button" class="mv-seg-b' + on + '" data-mv-val="' + esc(it.k) + '"' +
        (it.t ? ' title="' + esc(it.t) + '"' : '') + '>' + esc(it[k]) + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-mv-val]'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(host.querySelectorAll('.mv-seg-b'), function (x) { cls(x, 'is-on', false); });
        b.classList.add('is-on');
        onPick(b.dataset.mvVal);
      });
    });
  }

  function paintPresets() {
    var host = $('mvPresets');
    if (!host) return;
    host.innerHTML = PRESETS.map(function (p) {
      /* 一条预设「生效」= 当前选中的视图集合与它完全一致 */
      var same = p.v.length === state.views.length && p.v.every(function (k) { return state.views.indexOf(k) >= 0; });
      return '<button type="button" class="mv-chip mv-preset' + (same ? ' is-on' : '') + '" data-mv-preset="' + p.k + '">' +
        esc(p.n) + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-mv-preset]'), function (b) {
      b.addEventListener('click', function () {
        var p = PRESETS.filter(function (x) { return x.k === b.dataset.mvPreset; })[0];
        if (!p) return;
        state.views = p.v.slice();
        saveSet();
        paintPresets();
        paintViews();
        render();
      });
    });
  }

  function paintViews() {
    var host = $('mvViews');
    if (!host) return;
    host.innerHTML = VIEW_ORDER.map(function (k) {
      var on = state.views.indexOf(k) >= 0;
      return '<button type="button" class="mv-chip' + (on ? ' is-on' : '') + '" data-mv-view="' + k + '" ' +
        'aria-pressed="' + on + '" title="' + esc(viewName(k)) + '">' + esc(viewName(k)) + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-mv-view]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.mvView;
        var i = state.views.indexOf(k);
        if (i < 0) {
          /* 按 VIEW_ORDER 插入，不按点击顺序 —— 否则布局会随点击次序跳，
           * 同一组视图每次渲出来格子位置都不一样。 */
          var at = VIEW_ORDER.indexOf(k);
          var next = state.views.slice();
          next.push(k);
          next.sort(function (a, b2) { return VIEW_ORDER.indexOf(a) - VIEW_ORDER.indexOf(b2); });
          state.views = next;
          void at;
        } else {
          if (state.views.length <= 1) { say('至少留一个视图'); return; }
          state.views.splice(i, 1);
        }
        saveSet();
        paintPresets();
        paintViews();
        render();
      });
    });
  }

  function paintInfo() {
    var el = $('mvInfo');
    if (!el) return;
    if (state.busy === 'render') { el.textContent = '渲染中…'; return; }
    if (state.busy === 'loading') { el.textContent = '读取模型…'; return; }
    if (state.busy === 'saving') { el.textContent = '存入图库…'; return; }
    if (state.error) { el.textContent = state.error; el.classList.add('is-err'); return; }
    el.classList.remove('is-err');
    if (!state.out) { el.textContent = ''; return; }
    var o = state.out;
    var m = MODES.filter(function (x) { return x.k === state.mode; })[0];
    el.textContent = o.cells.length + ' 张 · ' + o.width + '×' + o.height +
      ' · 单格 ' + o.cell + ' · ' + (m ? m.n : state.mode) + (state.wire ? ' + 线框' : '') +
      ' · ' + (state.cam === 'persp' ? '透视' : '正交');
  }

  function paintPick() {
    var box = $('mvPick');
    var img = $('mvOut');
    if (!box || !img) return;
    var o = state.out;
    var c = o && o.cells[state.pick];
    if (!c) { box.classList.add('hidden'); return; }
    /* 高亮框落在 img 的**实际绘制区**里：img 是 object-fit:contain，
     * 有留白（letterbox），直接用 img 的 rect 会让框偏出去。 */
    var r = img.getBoundingClientRect();
    var wrap = img.parentElement ? img.parentElement.getBoundingClientRect() : r;
    var nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
    var s = Math.min(r.width / nw, r.height / nh);
    var ox = r.left - wrap.left + (r.width - nw * s) / 2;
    var oy = r.top - wrap.top + (r.height - nh * s) / 2;
    box.style.left = (ox + c.x * s) + 'px';
    box.style.top = (oy + c.y * s) + 'px';
    box.style.width = (c.w * s) + 'px';
    box.style.height = (c.h * s) + 'px';
    box.classList.remove('hidden');
  }

  /* 导出条：画布 / 间距选择、布局信息、模型统计、四个按钮的可用态。
   * 只反映状态，不触发重渲 —— 导出画布跟屏幕画布是两套尺寸，改导出参数不用重渲。 */
  function paintExport() {
    var has = !!state.cur && !!state.cur.src && !state.busy;
    ['mvExPreview', 'mvExColor', 'mvExDepth', 'mvExMask'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = !has;
    });
    var sizeSel = $('mvExSize');
    if (sizeSel && sizeSel.value !== String(state.exSize)) sizeSel.value = String(state.exSize);
    var gapSel = $('mvExGap');
    if (gapSel && gapSel.value !== String(state.exGap)) gapSel.value = String(state.exGap);

    var info = $('mvExInfo');
    if (info) {
      if (!state.cur) info.textContent = '';
      else {
        var L = exportLayout(state.views.length, state.exSize, state.exGap, state.cols);
        info.textContent = state.views.length + '视图 ' + L.cols + '×' + L.rows +
          ' · 画布 ' + L.w + '×' + L.h + ' · 单格 ' + L.cell;
      }
    }
    var st = $('mvExStats');
    if (st) {
      var s = state.stats;
      st.textContent = s && s.meshes
        ? '顶点 ' + fmtN(s.verts) + ' · 三角面 ' + fmtN(s.tris) + ' · UV ' + s.uv
        : '';
    }
  }

  function paint() {
    paintModels();
    paintPresets();
    paintViews();
    paintInfo();
    paintExport();

    var img = $('mvOut');
    var empty = $('mvEmpty');
    if (state.out && img) {
      if (img.getAttribute('src') !== state.out.png) img.src = state.out.png;
      img.classList.remove('hidden');
      if (empty) empty.classList.add('hidden');
    } else if (img) {
      img.classList.add('hidden');
      if (empty) {
        empty.classList.remove('hidden');
        var t = empty.querySelector('.mv-empty-t');
        var s2 = empty.querySelector('.mv-empty-s');
        if (state.error) {
          if (t) t.textContent = '没能渲出来';
          if (s2) s2.textContent = state.error;
        } else if (state.cur) {
          if (t) t.textContent = '正在渲染…';
          if (s2) s2.textContent = '';
        } else {
          if (t) t.textContent = '左边选一个模型，或拖一个 glb 进来';
          if (s2) s2.textContent = '三视图 / 六视图 / 八视图一次渲完，各格严格等比例';
        }
      }
    }

    var cellBtn = $('mvDlCell');
    if (cellBtn) cellBtn.disabled = !(state.out && state.pick >= 0);
    var allBtn = $('mvDlAll');
    if (allBtn) allBtn.disabled = !state.out;
    var libBtn = $('mvSaveLib');
    if (libBtn) {
      /* 独立页没有图库，这个按钮留着只会点出一句「存不进」。直接不显示。 */
      cls(libBtn, 'hidden', !hasDesk());
      libBtn.disabled = !state.out || !hasDesk();
    }
    var rBtn = $('mvRender');
    if (rBtn) {
      rBtn.disabled = !state.cur || state.busy === 'render' || state.busy === 'loading';
      rBtn.textContent = state.busy === 'render' ? '渲染中…' : '重新渲染';
    }
    var pvBtn = $('mvPreview');
    if (pvBtn) pvBtn.disabled = !state.cur;

    paintPick();
  }

  /* ---------- 命中：点图上某一格 ---------- */

  function cellAt(ev) {
    var img = $('mvOut');
    var o = state.out;
    if (!img || !o) return -1;
    var r = img.getBoundingClientRect();
    var nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
    var s = Math.min(r.width / nw, r.height / nh);
    if (!s) return -1;
    var ox = (r.width - nw * s) / 2;
    var oy = (r.height - nh * s) / 2;
    var x = (ev.clientX - r.left - ox) / s;
    var y = (ev.clientY - r.top - oy) / s;
    var step = o.cell + o.gap;
    var col = Math.floor(x / step);
    var row = Math.floor(y / step);
    if (col < 0 || row < 0 || col >= o.cols || row >= o.rows) return -1;
    // 点在格间距里不算任何一格
    if (x - col * step > o.cell || y - row * step > o.cell) return -1;
    var idx = row * o.cols + col;
    return idx < o.cells.length ? idx : -1;
  }

  /* ---------- 绑定 ---------- */

  var bound = false;

  function bind() {
    if (bound) return;
    bound = true;

    var closeBtn = $('btnMvWinClose');
    if (closeBtn) closeBtn.addEventListener('click', close);

    seg($('mvModes'), MODES, state.mode, function (v) { state.mode = v; saveSet(); render(); });
    seg($('mvCams'), CAMS, state.cam, function (v) { state.cam = v; saveSet(); render(); });
    seg($('mvSizes'), SIZES.map(function (n) { return { k: n, n: String(n) }; }), state.cell, function (v) {
      state.cell = Number(v) || 768; saveSet(); render();
    });
    seg($('mvCols'), COLS, state.cols, function (v) { state.cols = Number(v) || 0; saveSet(); render(); });

    /* 线框是独立开关，不是模式之一 —— 勾上就在当前模式的面之上叠线 */
    var wire = $('mvWire');
    if (wire) wire.addEventListener('change', function () {
      state.wire = !!wire.checked; saveSet(); render();
    });

    var gap = $('mvGap');
    if (gap) gap.addEventListener('input', function () {
      state.gap = Math.max(0, Math.min(48, Number(gap.value) || 0));
      syncRangeLabels();
      saveSet(); scheduleRender(320);
    });

    var mg = $('mvMargin');
    if (mg) mg.addEventListener('input', function () {
      state.margin = Math.max(1, Math.min(1.6, (Number(mg.value) || 108) / 100));
      syncRangeLabels();
      saveSet(); scheduleRender(320);
    });

    var lw = $('mvLineW');
    if (lw) lw.addEventListener('input', function () {
      state.lineWidth = Math.max(0.4, Math.min(6, (Number(lw.value) || 14) / 10));
      syncRangeLabels();
      saveSet(); scheduleRender(320);
    });

    var lab = $('mvLabels');
    if (lab) lab.addEventListener('change', function () {
      state.labels = !!lab.checked; saveSet(); render();
    });

    var rBtn = $('mvRender');
    if (rBtn) rBtn.addEventListener('click', function () { render(); });

    var allBtn = $('mvDlAll');
    if (allBtn) allBtn.addEventListener('click', downloadAll);

    var cellBtn = $('mvDlCell');
    if (cellBtn) cellBtn.addEventListener('click', function () {
      if (state.pick >= 0) downloadCell(state.pick);
    });

    var libBtn = $('mvSaveLib');
    if (libBtn) libBtn.addEventListener('click', saveToLib);

    var pvBtn = $('mvPreview');
    if (pvBtn) pvBtn.addEventListener('click', function () {
      if (!state.cur) return;
      if (window.Model3D && typeof Model3D.openPreview === 'function') {
        Model3D.openPreview(state.cur.src, { title: state.cur.name }).catch(function (e) {
          say('预览打不开：' + friendly(e));
        });
      }
    });

    /* 导出条：画布 / 间距改的是导出口径，不动屏幕画布，所以只 saveSet + 刷新信息，不重渲 */
    var exSize = $('mvExSize');
    if (exSize) exSize.addEventListener('change', function () {
      state.exSize = EX_SIZES.indexOf(Number(exSize.value)) >= 0 ? Number(exSize.value) : 2048;
      saveSet();
      paintExport();
    });
    var exGap = $('mvExGap');
    if (exGap) exGap.addEventListener('change', function () {
      state.exGap = EX_GAPS.indexOf(Number(exGap.value)) >= 0 ? Number(exGap.value) : 0;
      saveSet();
      paintExport();
    });

    var exPreview = $('mvExPreview');
    if (exPreview) exPreview.addEventListener('click', previewExport);
    var exColor = $('mvExColor');
    if (exColor) exColor.addEventListener('click', function () { downloadExport('color'); });
    var exDepth = $('mvExDepth');
    if (exDepth) exDepth.addEventListener('click', function () { downloadExport('depth'); });
    var exMask = $('mvExMask');
    if (exMask) exMask.addEventListener('click', function () { downloadExport('mask'); });

    var openLib = $('mvOpenLib');
    if (openLib) openLib.addEventListener('click', function () {
      if (typeof openLibrary === 'function') openLibrary('model');
    });

    var fileBtn = $('mvOpenFile');
    var fileIn = $('mvFile');
    if (fileBtn && fileIn) fileBtn.addEventListener('click', function () { fileIn.click(); });
    if (fileIn) fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      fileIn.value = '';        // 清掉：同一文件选第二次也要触发 change
      takeFile(f);
    });

    var out = $('mvOut');
    if (out) {
      out.addEventListener('click', function (ev) {
        var i = cellAt(ev);
        state.pick = i;
        paint();
        if (i >= 0 && state.out) say('已选「' + state.out.cells[i].name + '」· 再点「下载这格」');
      });
    }

    var stage = $('mvStage');
    if (stage) {
      stage.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        stage.classList.add('is-drop');
      });
      stage.addEventListener('dragleave', function () { stage.classList.remove('is-drop'); });
      stage.addEventListener('drop', function (ev) {
        ev.preventDefault();
        stage.classList.remove('is-drop');
        var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        takeFile(f);
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (!state.open) return;
      if (ev.key !== 'Escape') return;
      // 有导出预览弹层时先关它
      if (xlEl && !xlEl.classList.contains('hidden')) {
        closeExportOverlay();
        return;
      }
      // 有 3D 预览弹层时先关弹层，不要再把整个窗口也关掉
      if (window.Model3D && Model3D.closePreview && document.querySelector('.mv-pv-open')) {
        Model3D.closePreview();
        return;
      }
    });

    window.addEventListener('resize', function () { if (state.open) paintPick(); });

    /* 控件初值：state 是 applySet 之后的真值，滑杆必须跟着走，
     * 否则界面显示「间距 0」而实际按上次存的 24 渲——这类不同步最难发现。 */
    syncInputs();

    /* 快捷键。桌面 App 只在窗口开着时响应；
     * 焦点在输入框里时不抢键（滑杆用方向键调值，空格会误触重渲）。 */
    document.addEventListener('keydown', function (ev) {
      if (!state.open) return;
      var t = ev.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (ev.key === ' ' || ev.code === 'Space') {
        if (!state.cur) return;
        ev.preventDefault();
        render();
        return;
      }
      var i = '123'.indexOf(ev.key);
      if (i >= 0 && MODES[i]) {
        var host = $('mvModes');
        if (!host) return;
        state.mode = MODES[i].k;
        saveSet();
        Array.prototype.forEach.call(host.querySelectorAll('[data-mv-val]'), function (b) {
          cls(b, 'is-on', b.dataset.mvVal === state.mode);
        });
        render();
      }
    });
  }

  function syncInputs() {
    var gap = $('mvGap'), mg = $('mvMargin'), lw = $('mvLineW'), lab = $('mvLabels'), wire = $('mvWire');
    if (gap) gap.value = state.gap;
    if (mg) mg.value = Math.round(state.margin * 100);
    if (lw) lw.value = Math.round(state.lineWidth * 10);
    if (lab) lab.checked = !!state.labels;
    if (wire) wire.checked = !!state.wire;
    syncRangeLabels();
  }

  function syncRangeLabels() {
    var g = $('mvGapV'), m = $('mvMarginV'), l = $('mvLineWV');
    if (g) g.textContent = String(state.gap);
    if (m) m.textContent = String(Math.round(state.margin * 100));
    if (l) l.textContent = (Math.round(state.lineWidth * 10) / 10).toFixed(1);
  }

  /* ---------- 打开 / 关闭 ---------- */

  async function open() {
    var win = $('mvWin');
    if (!win) return false;
    bind();
    applySet(loadSet());

    var meta = (typeof DESK_APP_META !== 'undefined' && DESK_APP_META.multiview) ||
      { title: '多视图', sub: '3D 模型 → 三视图 / 六视图 / 八视图' };

    if (typeof deskSkelShow === 'function') deskSkelShow();
    if (typeof deskMountApp === 'function') deskMountApp(win, meta.title, meta.sub);
    else win.classList.remove('hidden');
    state.open = true;

    /* 先把已有数据画出来（第二次打开应该是瞬时的），再去补读磁盘 */
    paint();

    await loadModels();
    paint();
    if (typeof deskSkelHide === 'function') deskSkelHide();

    /* 没有当前模型时自动选第一个：进来就能看到东西，比一块空画布强 */
    if (!state.cur && state.models.length) pickModel(state.models[0].id);
    else if (state.cur) render();

    return true;
  }

  function close() {
    var win = $('mvWin');
    if (!win) return;
    state.open = false;
    clearTimeout(timer);
    if (window.Model3D && typeof Model3D.closePreview === 'function') {
      try { Model3D.closePreview(); } catch (e) {}
    }
    /* 走统一退场：× 和 << 都要经过它，否则窗口会被留在 App 页里一起隐藏，
     * 下次打开时 parentElement 还是 deskAppHost，位置就错了。 */
    if (typeof deskAppLeave === 'function' && win.parentElement && win.parentElement.id === 'deskAppHost') {
      deskAppLeave();
    } else {
      win.classList.add('hidden');
    }
  }

  window.multiview = {
    open: open,
    close: close,
    render: render,
    state: state,
    /* 纯逻辑导出：测试直接调，不用碰 DOM */
    _pure: { autoCols, fmtMB, viewName, countLabel, exportLayout, fmtN }
  };
})();
