/* ============================================================
 * 多视图 App · 渲染与导出（mv-render）
 *
 * 这一层负责「把 state 变成一张图」以及「把图交出去」：
 *   渲染调度（串行 + 防抖）/ 整图下载 / 单格裁剪 / 预览弹层 /
 *   深度图 · 遮罩图 / 存入图库。
 *
 * 页面长什么样（paint*）不在这里——那是 mv-panels 的事。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-render.js 必须在 mv-state.js 之后加载');

  var state = MV.state;

  /* ---------- 渲染调度 ---------- */

  var running = false;
  var pending = false;
  var timer = 0;

  /* 拖动类控件的防抖。解析和几何现在都有缓存，一次渲染只要 ~45ms，
   * 所以这里不用再等 260ms —— 那是当年每次都要重新 parse 模型时的数值。 */
  var RENDER_DEBOUNCE = 110;
  function scheduleRender(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { render(); }, ms == null ? RENDER_DEBOUNCE : ms);
  }

  function cancelRenderTimer() { clearTimeout(timer); }

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
      MV.paint();
      return;
    }
    if (!Model3D.ready()) {
      state.error = '3D 渲染组件未就绪（three.js 没加载上）';
      setBusy('');
      MV.paint();
      return;
    }
    setBusy('render');
    try {
      var L = MV.exportLayout(state.views.length, state.exSize, state.gap, state.cols, state.compact);
      var o = await Model3D.viewGrid(state.cur.src, MV.renderOpts('color', L));
      state.out = o;
      state.stats = o.stats || null;
      state.uv = o.uv || null;
      state.pick = -1;
      state.error = '';
    } catch (e) {
      state.out = null;
      state.stats = null;
      state.error = '渲染失败：' + MV.friendly(e);
    }
    setBusy('');
    MV.paint();
  }

  function setBusy(kind) {
    state.busy = kind || '';
    var el = MV.$('mvInfo');
    if (!el) return;
    if (kind === 'render') el.textContent = '渲染中…';
    else if (kind === 'loading') el.textContent = '读取模型…';
    else if (kind === 'saving') el.textContent = '存入图库…';
    else if (kind === 'proj') el.textContent = '投射纹理中…';
    else MV.paintInfo();
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
    img.onerror = function () { state.error = '裁剪失败：结果图读不出来'; MV.paint(); };
    img.src = o.png;
  }

  /* ---------- 导出面板（对齐 AIGC工具包 的口径：固定画布 · 深度 · 遮罩） ---------- */

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
    var L = MV.exportLayout(state.views.length, state.exSize, state.exGap, state.cols, state.compact);
    setBusy('render');
    try {
      var o = await Model3D.viewGrid(state.cur.src, MV.renderOpts(pass, L, true));
      setBusy('');
      return o;
    } catch (e) {
      setBusy('');
      say('导出失败：' + MV.friendly(e));
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
      o.width + '×' + o.height + ' · ' + o.cells.length + ' 格 · 单格 ' + MV.cellTxt(o.cellW, o.cellH);
    el.classList.remove('hidden');
  }

  function closeExportOverlay() {
    if (xlEl) xlEl.classList.add('hidden');
    xlCur = null;
  }

  function isOverlayOpen() {
    return !!(xlEl && !xlEl.classList.contains('hidden'));
  }

  async function previewExport() {
    var o = await exportPNG('color');
    if (!o) return;
    openExportOverlay(o);
  }

  async function saveToLib() {
    if (!state.out) return;
    var d = MV.lib();
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
      say('入库失败：' + MV.friendly(e));
    }
    setBusy('');
  }

  var sayTimer = 0;
  function say(msg) {
    var el = MV.$('mvInfo');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-say');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(function () {
      if (el) el.classList.remove('is-say');
      MV.paintInfo();
    }, 2600);
  }

  MV.scheduleRender = scheduleRender;
  MV.cancelRenderTimer = cancelRenderTimer;
  MV.render = render;
  MV.setBusy = setBusy;
  MV.baseName = baseName;
  MV.saveBlob = saveBlob;
  MV.dataUrlToBlob = dataUrlToBlob;
  MV.downloadAll = downloadAll;
  MV.downloadCell = downloadCell;
  MV.exportPNG = exportPNG;
  MV.downloadExport = downloadExport;
  MV.closeExportOverlay = closeExportOverlay;
  MV.isOverlayOpen = isOverlayOpen;
  MV.previewExport = previewExport;
  MV.saveToLib = saveToLib;
  MV.say = say;
})();
