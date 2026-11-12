/* ============================================================
 * 多视图 App · 事件绑定（mv-bind）
 *
 * 只做一件事：把 DOM 事件接到 state 上。控件绑定全部按参数表生成，
 * 互斥（两个线框）、勾上自动展开属性面板这类业务副作用写在 FIELDS.onChange。
 * 这里不再出现「某个具体参数」的分支，加参数只改 mv-state.js + 两份 HTML。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-bind.js 必须在 mv-state.js / mv-layer-panel.js / mv-panels.js 之后加载');

  var state = MV.state;
  var $ = MV.$;
  var cls = MV.cls;
  var FIELDS = MV.FIELDS;

  var render = MV.render;
  var saveSet = MV.saveSet;
  var scheduleRender = MV.scheduleRender;
  var paint = MV.paint;
  var paintLayers = MV.paintLayers;
  var paintExport = MV.paintExport;
  var paintPick = MV.paintPick;
  var fitStage = MV.fitStage;
  var closePropsIf = MV.closePropsIf;
  var layerKeyOf = MV.layerKeyOf;
  var syncOpacityUI = MV.syncOpacityUI;
  var say = MV.say;

  var bound = false;

  /* 控件回填：全部按参数表生成，加字段不用再来这里补一行 */
  function syncInputs() {
    FIELDS.forEach(function (f) {
      if (!f.id || f.ui === 'none') return;
      var el = $(f.id);
      if (!el) return;
      if (f.ui === 'check') el.checked = !!state[f.k];
      else if (f.ui === 'color') el.value = state[f.k];
      else if (f.ui === 'range') el.value = Math.round(state[f.k] * (f.scale || 1));
    });
    syncRangeLabels();
    syncOpacityUI();
  }

  function syncRangeLabels() {
    FIELDS.forEach(function (f) {
      if (!f.label || !f.txt) return;
      var el = $(f.label);
      if (el) el.textContent = f.txt(state[f.k]);
    });
  }

  function bind() {
    if (bound) return;
    bound = true;

    /* 舞台大小变了（拖窗口 / 侧栏收起）就重新定正方形边长 */
    var stageHost = $('mvStageHost');
    if (stageHost && typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(fitStage).observe(stageHost); } catch (e) {}
    }

    var closeBtn = $('btnMvWinClose');
    if (closeBtn) closeBtn.addEventListener('click', function () { MV.close(); });

    MV.seg($('mvModes'), MV.MODES, state.mode, function (v) { state.mode = v; saveSet(); render(); });
    MV.seg($('mvCams'), MV.CAMS, state.cam, function (v) { state.cam = v; saveSet(); render(); });
    /* 画布始终是正方形：只挑边长（2K / 4K），单格由布局算 */
    MV.seg($('mvSizes'), MV.EX_SIZES.map(function (n) {
      return { k: n, n: n === 4096 ? '4K' : '2K', t: '正方形画布 ' + n + '×' + n };
    }), state.exSize, function (v) {
      state.exSize = MV.EX_SIZES.indexOf(Number(v)) >= 0 ? Number(v) : 2048;
      saveSet();
      paintExport();
      render();
    });
    MV.seg($('mvCols'), MV.COLS, state.cols, function (v) { state.cols = Number(v) || 0; saveSet(); render(); });
    /* 一键紧凑：矩形格铺满正方形画布（割掉网格上下/左右的白边）。
     * 导出面板的单格尺寸跟着变，所以顺手刷一次 paintExport。 */
    MV.seg($('mvCompacts'), [
      { k: 0, n: '标准', t: '正方形格子，网格居中，四周留白（默认）' },
      { k: 1, n: '一键紧凑', t: '矩形格子铺满画布，同样的画布能装下更大的模型' }
    ], state.compact ? 1 : 0, function (v) {
      state.compact = !!Number(v);
      saveSet();
      paintExport();
      render();
    });

    /* 控件绑定：全部按参数表生成。 */
    FIELDS.forEach(function (f) {
      if (!f.id || f.ui === 'none') return;
      var el = $(f.id);
      if (!el) return;
      if (f.ui === 'check') {
        el.addEventListener('change', function () {
          state[f.k] = !!el.checked;
          if (f.onChange) f.onChange();
          /* 关掉一层就收起它的属性面板：面板还摊着会让人以为它仍然生效。
           * 面板要就地重画，不能等 render 回来——没模型时 render 直接返回，
           * 那只眼睛就会「点了没反应」。 */
          if (!state[f.k]) closePropsIf(layerKeyOf(f.k));
          saveSet(); paintLayers(); render();
        });
      } else if (f.ui === 'color') {
        el.addEventListener('input', function () {
          state[f.k] = el.value || f.def;
          if (f.onChange) f.onChange();
          saveSet(); scheduleRender();
        });
      } else {
        el.addEventListener('input', function () {
          var v = Number(el.value);
          if (!isFinite(v)) v = f.def;
          state[f.k] = Math.max(f.min, Math.min(f.max, v / (f.scale || 1)));
          if (f.onChange) f.onChange();
          syncRangeLabels(); saveSet(); scheduleRender();
        });
      }
    });

    var rBtn = $('mvRender');
    if (rBtn) rBtn.addEventListener('click', function () { render(); });

    var allBtn = $('mvDlAll');
    if (allBtn) allBtn.addEventListener('click', MV.downloadAll);

    var cellBtn = $('mvDlCell');
    if (cellBtn) cellBtn.addEventListener('click', function () {
      if (state.pick >= 0) MV.downloadCell(state.pick);
    });

    var libBtn = $('mvSaveLib');
    if (libBtn) libBtn.addEventListener('click', MV.saveToLib);

    var pvBtn = $('mvPreview');
    if (pvBtn) pvBtn.addEventListener('click', function () {
      if (!state.cur) return;
      if (window.Model3D && typeof Model3D.openPreview === 'function') {
        Model3D.openPreview(state.cur.src, { title: state.cur.name, uvEdge: state.uvEdge }).catch(function (e) {
          say('预览打不开：' + MV.friendly(e));
        });
      }
    });

    /* AI 拆件的面板逻辑在 js/model-split.js（它同时给独立页用），这里只把当前模型递过去 */
    var spBtn = $('mvSplit');
    if (spBtn) spBtn.addEventListener('click', function () {
      if (!state.cur) return;
      if (!window.ModelSplit) { say('AI 拆件模块未加载（js/model-split.js）'); return; }
      ModelSplit.open(state.cur);
    });

    /* 投射纹理：入口在导出面板，弹层按钮与关闭都交给 MVProject（js/mv-project.js） */
    var pjBtn = $('mvProj');
    var pjFile = $('mvProjFile');
    if (pjBtn && pjFile) pjBtn.addEventListener('click', function () { pjFile.click(); });
    if (pjFile) pjFile.addEventListener('change', function () {
      var f = pjFile.files && pjFile.files[0];
      pjFile.value = '';        // 同一文件选第二次也要触发 change
      if (f && window.MVProject) MVProject.fromFile(f);
    });
    var pjClose = $('mvProjClose');
    if (pjClose) pjClose.addEventListener('click', function () {
      if (window.MVProject) MVProject.close();
    });
    var pjDl = $('mvProjDl');
    if (pjDl) pjDl.addEventListener('click', function () {
      if (window.MVProject) MVProject.downloadPNG();
    });
    var pjGlb = $('mvProjGlb');
    if (pjGlb) pjGlb.addEventListener('click', function () {
      if (window.MVProject) MVProject.downloadGLB();
    });
    var pjLib = $('mvProjLib');
    if (pjLib) pjLib.addEventListener('click', function () {
      if (window.MVProject) MVProject.saveLib();
    });

    /* 生图结果常直接躺在剪贴板里（截图 / 生图页复制）：Ctrl+V 也能投。
     * 焦点在输入框里不抢粘贴。 */
    document.addEventListener('paste', function (ev) {
      if (!state.open || !window.MVProject) return;
      var t = ev.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it && it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
          var f = it.getAsFile();
          if (f) { ev.preventDefault(); MVProject.fromFile(f); }
          return;
        }
      }
    });

    /* 导出条：画布尺寸是预览和导出共用的（改了要重渲预览），
     * 间距只改导出口径，不动屏幕画布 */
    var exSize = $('mvExSize');
    if (exSize) exSize.addEventListener('change', function () {
      state.exSize = MV.EX_SIZES.indexOf(Number(exSize.value)) >= 0 ? Number(exSize.value) : 2048;
      saveSet();
      paintExport();
      render();
    });
    var exGap = $('mvExGap');
    if (exGap) exGap.addEventListener('change', function () {
      state.exGap = MV.EX_GAPS.indexOf(Number(exGap.value)) >= 0 ? Number(exGap.value) : 0;
      saveSet();
      paintExport();
    });

    var exPreview = $('mvExPreview');
    if (exPreview) exPreview.addEventListener('click', MV.previewExport);
    var exColor = $('mvExColor');
    if (exColor) exColor.addEventListener('click', function () { MV.downloadExport('color'); });
    var exDepth = $('mvExDepth');
    if (exDepth) exDepth.addEventListener('click', function () { MV.downloadExport('depth'); });
    var exMask = $('mvExMask');
    if (exMask) exMask.addEventListener('click', function () { MV.downloadExport('mask'); });

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
      MV.takeFile(f);
    });

    var out = $('mvOut');
    if (out) {
      out.addEventListener('click', function (ev) {
        var i = MV.cellAt(ev);
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
        MV.takeFile(f);
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (!state.open) return;
      if (ev.key !== 'Escape') return;
      // 投射纹理弹层开着时先关它
      if (window.MVProject && MVProject.isOpen()) {
        MVProject.close();
        return;
      }
      // 有导出预览弹层时先关它
      if (MV.isOverlayOpen()) {
        MV.closeExportOverlay();
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
      if (i >= 0 && MV.MODES[i]) {
        var host = $('mvModes');
        if (!host) return;
        state.mode = MV.MODES[i].k;
        saveSet();
        Array.prototype.forEach.call(host.querySelectorAll('[data-mv-val]'), function (b) {
          cls(b, 'is-on', b.dataset.mvVal === state.mode);
        });
        render();
      }
    });
  }

  MV.bind = bind;
  MV.syncInputs = syncInputs;
  MV.syncRangeLabels = syncRangeLabels;
})();
