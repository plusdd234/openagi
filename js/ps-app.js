/* 图像工坊 · App 外壳（window.psLab）
 *
 * 桌面 App「图像工坊」的全部界面：菜单、工具箱、选项栏、图层面板、历史、导航器、状态栏。
 * 像素逻辑在 ps-core / ps-filters / ps-tools，视口在 ps-view，这里只做装配与交互。
 *
 * 第一次打开会生成一张 1600×1000 的演示稿（渐变 + 金色光斑 + 标题），
 * 方便直接试笔刷、选区、滤镜；之后的导入会按图片尺寸新建文档。
 */
(function (global) {
  'use strict';

  var $id = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtBytes(b) {
    var n = Number(b) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function ico(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  var TOOLS = [
    { id: 'move', name: '移动', key: 'V', group: 1, svg: '<path d="M12 3.5v17M3.5 12h17"/><path d="m9.2 6.3 2.8-2.8 2.8 2.8M9.2 17.7l2.8 2.8 2.8-2.8M6.3 9.2 3.5 12l2.8 2.8M17.7 9.2 20.5 12l-2.8 2.8"/>' },
    { id: 'select-rect', name: '矩形选区', key: 'M', group: 2, svg: '<rect x="4" y="6" width="16" height="12" rx="2" stroke-dasharray="3.2 2.8"/>' },
    { id: 'select-ellipse', name: '椭圆选区', key: 'Shift+M', group: 2, svg: '<ellipse cx="12" cy="12" rx="8" ry="6.2" stroke-dasharray="3.2 2.8"/>' },
    { id: 'select-lasso', name: '套索选区', key: 'L', group: 2, svg: '<path d="M12 18.8c-4.5 0-8-2.6-8-6.2S7.5 6.4 12 6.4s8 2.6 8 6.2c0 2.6-1.9 4.8-4.6 5.7"/><path d="M9.2 18.2c-.9.9-1.2 2-.7 2.8"/>' },
    { id: 'magic-wand', name: '魔棒', key: 'W', group: 2, svg: '<path d="m4 20 9-9"/><path d="m13.8 5.6 4.6 4.6-2.6 2.6-4.6-4.6z"/><path d="M6 4v3M4.5 5.5h3M19 16.5v2.5M17.8 17.8h2.4"/>' },
    { id: 'crop', name: '裁剪', key: 'C', group: 3, svg: '<path d="M7 3.5v12A2.5 2.5 0 0 0 9.5 18h11"/><path d="M17 20.5v-12A2.5 2.5 0 0 0 14.5 6h-11"/>' },
    { id: 'eyedropper', name: '吸管', key: 'I', group: 3, svg: '<path d="m3.6 20.4 1-3.3L14 7.7l2.3 2.3L7 19.4z"/><path d="m13.3 6.4 2-2a2.5 2.5 0 0 1 3.5 0l.8.8a2.5 2.5 0 0 1 0 3.5l-2 2"/>' },
    { id: 'brush', name: '画笔', key: 'B', group: 4, svg: '<path d="m14.5 4.5 5 5"/><path d="m12.8 6.2 5 5-7 7a2.6 2.6 0 0 1-3.7 0l-1.3-1.3a2.6 2.6 0 0 1 0-3.7z"/><path d="m9.2 15.2 3-3"/>' },
    { id: 'eraser', name: '橡皮擦', key: 'E', group: 4, svg: '<rect x="4.2" y="9.4" width="15.6" height="7.4" rx="2" transform="rotate(-42 12 13.1)"/><path d="m8.7 8.9 6.2 6.2"/>' },
    { id: 'gradient', name: '渐变', key: 'G', group: 4, svg: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9.6h16M4 14.6h16" opacity=".45"/>' },
    { id: 'fill', name: '油漆桶', key: 'K', group: 4, svg: '<path d="m5.2 11.2 6.4-6.4a1.6 1.6 0 0 1 2.3 0l5.3 5.3a1.6 1.6 0 0 1 0 2.3l-4.6 4.6a2 2 0 0 1-2.8 0L5.2 13.5a1.6 1.6 0 0 1 0-2.3Z"/><path d="m9.2 5.2 1.6-1.6"/><path d="M19 15.5s2 2.2 2 3.3a2 2 0 0 1-4 0c0-1.1 2-3.3 2-3.3Z"/>' },
    { id: 'pen', name: '钢笔', key: 'P', group: 5, svg: '<path d="M9 3.5h6l1.5 9L12 20.5 7.5 12.5 9 3.5Z"/><circle cx="12" cy="10" r="1.8"/><path d="M12 11.8v5"/>' },
    { id: 'shape', name: '形状', key: 'U', group: 5, svg: '<rect x="4" y="10" width="10.5" height="10" rx="1.8"/><circle cx="14.8" cy="9.2" r="4.8"/>' },
    { id: 'path-select', name: '路径选择', key: 'A', group: 5, svg: '<path d="m6 4 13 8.2-5.7 1.7-1.8 5.8L6 4Z"/>' },
    { id: 'text', name: '文字', key: 'T', group: 6, svg: '<path d="M5.5 6.5V5h13v1.5M12 5v14.5M8.6 19.5h6.8"/>' }
  ];

  /* 参考图里工具箱还有一排本版本没实现的工具。它们只是**占位控件**：
   * 外形、位置、悬停态都照 PS 摆好，点一下只会在状态栏说明「未实现」，
   * 不会把当前工具切走。这样界面完整度接近参考图，又不会骗用户。 */
  var PH_TOOLS = [
    { name: '仿制图章', svg: '<rect x="8" y="9" width="8" height="5" rx="1.2"/><path d="M12 4.5V9M10 4.5h4"/><path d="M7 20.5h10M9.5 14v3.5h5V14"/>' },
    { name: '模糊 / 锐化', svg: '<path d="M12 3.8c3.4 4 6 7.2 6 10.4a6 6 0 0 1-12 0c0-3.2 2.6-6.4 6-10.4Z"/><path d="M9.2 14.5a2.8 2.8 0 0 0 2.8 2.8"/>' },
    { name: '减淡 / 加深', svg: '<circle cx="12" cy="12" r="3.6"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/>' },
    { name: '抓手', svg: '<path d="M8.5 12.5V6.8a1.7 1.7 0 0 1 3.4 0v4.4-5.9a1.7 1.7 0 0 1 3.4 0v5.9-4.9a1.7 1.7 0 0 1 3.4 0v7.9c0 3.4-2.5 5.9-6 5.9-2.6 0-4.1-1.4-5.1-3.5l-2.1-4.3a1.6 1.6 0 0 1 2.9-1.3l.5 1.1"/>' },
    { name: '缩放', svg: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.4 15.4 4.3 4.3M8.4 10.8h4.8M10.8 8.4v4.8"/>' }
  ];

  /* 右侧面板图标槽：参考图最右那列竖排小图标 */
  var RAIL = [
    { name: '历史记录', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.4 2"/>' },
    { name: '信息', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v.2M12 11v6"/>' },
    { name: '画笔预设', svg: '<path d="M15 4.5c1.4-1.1 3.8-.9 4.2 1.2.4 2-1.5 3.2-3.1 4.2L9 15l-2.5-2.5 8.5-8Z"/><path d="M6.5 12.5c-.7 2.3-2.6 3.3-4.5 3.1.3-1.9 1.3-3.8 4.5-3.1Z"/>' },
    { name: '字符', svg: '<path d="M5 5h14M12 5v14M8 19h8"/>' },
    { name: '图层', svg: '<path d="m12 4 8 4.5-8 4.5-8-4.5L12 4Z"/><path d="m4 12.5 8 4.5 8-4.5"/>' },
    { name: '调整', svg: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="17" r="2"/>' },
    { name: '通道', svg: '<rect x="4" y="4" width="10" height="10" rx="1"/><rect x="10" y="10" width="10" height="10" rx="1"/>' },
    { name: '路径', svg: '<path d="M5 18c6-1 4-10 14-10"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="8" r="2"/>' }
  ];

  var LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

  var MENUS = [
    { id: 'file', name: '文件', items: [
      { label: '新建…', hint: 'Ctrl+N', act: 'new' },
      { label: '打开图片…', hint: 'Ctrl+O', act: 'open' },
      { label: '置入图片…', hint: 'Ctrl+Shift+O', act: 'place' },
      { label: '从图库置入…', act: 'libraryPlace' },
      { label: '粘贴为图层', hint: 'Ctrl+V', act: 'paste' },
      { sep: true },
      { label: '打开工程…', act: 'openProject' },
      { label: '保存工程…', hint: 'Ctrl+S', act: 'saveProject' },
      { sep: true },
      { label: '导出…', hint: 'Ctrl+Shift+E', act: 'export' },
      { label: '快速导出 PNG', act: 'export:png' },
      { label: '复制图像', hint: 'Ctrl+Shift+C', act: 'copyImage' },
      { sep: true },
      { label: '存入图库', act: 'library' },
      { label: '拼合图像', hint: 'Ctrl+Shift+F', act: 'flatten' }
    ] },
    { id: 'edit', name: '编辑', items: [
      { label: '撤销', hint: 'Ctrl+Z', act: 'undo' },
      { label: '重做', hint: 'Ctrl+Shift+Z', act: 'redo' },
      { sep: true },
      { label: '复制图层', hint: 'Ctrl+J', act: 'dupLayer' },
      { label: '向下合并', hint: 'Ctrl+E', act: 'mergeDown' }
    ] },
    { id: 'image', name: '图像', items: [
      { label: '图像信息…', act: 'docInfo' },
      { label: '裁剪到选区', act: 'cropSelection' },
      { sep: true },
      { label: '拼合图像', act: 'flatten' }
    ] },
    { id: 'layer', name: '图层', items: [
      { label: '新建图层', hint: 'Ctrl+Shift+N', act: 'addLayer' },
      { label: '复制图层', hint: 'Ctrl+J', act: 'dupLayer' },
      { label: '删除图层', act: 'delLayer' },
      { sep: true },
      { label: '新建调整层…', act: 'addAdjust' },
      { label: '向下合并', hint: 'Ctrl+E', act: 'mergeDown' }
    ] },
    { id: 'select', name: '选择', items: [
      { label: '全选', hint: 'Ctrl+A', act: 'selectAll' },
      { label: '取消选区', hint: 'Ctrl+D', act: 'selectNone' },
      { label: '反选', hint: 'Ctrl+Shift+I', act: 'selectInvert' }
    ] },
    { id: 'filter', name: '滤镜', items: [
      { label: '亮度…', act: 'filter:brightness' },
      { label: '对比度…', act: 'filter:contrast' },
      { label: '饱和度…', act: 'filter:saturate' },
      { label: '色相…', act: 'filter:hue' },
      { sep: true },
      { label: '高斯模糊…', act: 'filter:blur' },
      { label: '锐化…', act: 'filter:sharpen' },
      { label: '像素化…', act: 'filter:pixelate' },
      { label: '噪点…', act: 'filter:noise' },
      { sep: true },
      { label: '去色', act: 'filter:grayscale' },
      { label: '反相', act: 'filter:invert' }
    ] },
    { id: 'view', name: '视图', items: [
      { label: '适应窗口', hint: 'Ctrl+0', act: 'fit' },
      { label: '实际像素', hint: 'Ctrl+1', act: 'actual' },
      { label: '放大', hint: 'Ctrl+=', act: 'zoomIn' },
      { label: '缩小', hint: 'Ctrl+-', act: 'zoomOut' },
      { sep: true },
      { label: '专注模式（收起全部面板）', hint: 'Tab', act: 'focusMode' },
      { label: '显示 / 隐藏工具箱', act: 'toggleTools' },
      { label: '显示 / 隐藏选项栏', act: 'toggleOptions' },
      { label: '显示 / 隐藏右侧面板', act: 'toggleSide' },
      { label: '显示 / 隐藏状态栏', act: 'toggleStatus' },
      { label: '重置工作区', act: 'resetWorkspace' },
      { sep: true },
      { label: '显示网格', act: 'toggleGrid' },
      { label: '显示瓦片边界', act: 'toggleTiles' }
    ] },
    { id: 'help', name: '帮助', items: [
      { label: '快捷键…', act: 'shortcuts' },
      { label: '关于图像工坊', act: 'about' }
    ] }
  ];

  var APP_NAME = '图像工坊';

  var app = {
    ui: false,
    host: null,
    view: null,
    tools: null,
    doc: null,
    els: {},
    fg: '#000000',
    bg: '#ffffff',
    histTab: 'history',
    layerTab: 'layers',
    busy: false,
    pendingPlace: false,
    layerDragId: null,
    noteTimer: 0,
    navAt: 0,
    navComp: null,
    navScratch: null,
    menuPop: null,
    layerMenu: null,
    keyBound: false
  };

  /* ---------------- 演示稿 ---------------- */
  function buildDemo() {
    var doc = PS.createDoc(1600, 1000, '演示作品 · 1600 × 1000', { fill: false });

    var bg = PS.createLayer(doc, { name: '背景渐变' });
    PS.fillLayerGradient(bg, [
      { at: 0, color: '#111318' },
      { at: 0.52, color: '#232637' },
      { at: 1, color: '#3a2d1b' }
    ], 0, 0, 1600, 1000);
    PS.touch(bg);

    var disc = PS.createLayer(doc, { name: '金色光斑' });
    var cx = 980;
    var cy = 430;
    var radius = 360;
    PS.ensureAllTiles(disc).forEach(function (t) {
      if (!t) return;
      // 瓦片的 ctx 用本地坐标（0,0 就是该瓦片左上角），先把原点平移到文档坐标，
      // 否则圆心 980,430 落在 256 见方的画布外，整层画不出东西。
      t.ctx.save();
      t.ctx.translate(-t.x, -t.y);
      var g = t.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, 'rgba(255,226,160,.96)');
      g.addColorStop(0.42, 'rgba(240,184,82,.72)');
      g.addColorStop(0.75, 'rgba(206,134,40,.24)');
      g.addColorStop(1, 'rgba(180,110,30,0)');
      t.ctx.fillStyle = g;
      t.ctx.beginPath();
      t.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      t.ctx.fill();
      t.ctx.restore();
    });
    PS.touch(disc);

    var text = PS.createLayer(doc, { name: '标题文字' });
    app.tools.drawText(doc, text, {
      text: 'IMAGE LAB', x: 118, y: 700, size: 168, color: '#f3c56b', weight: 800
    });
    app.tools.drawText(doc, text, {
      text: '瓦片 · 图层 · 选区 · 滤镜', x: 124, y: 886, size: 46, color: 'rgba(238,232,220,.72)', weight: 500
    });

    doc.activeId = disc.id;
    doc.history.entries = [];
    doc.history.index = -1;
    doc.history.bytes = 0;
    PS.requestMips(doc);
    return doc;
  }

  /* ---------------- 工作区收纳状态 ----------------
   * 面板显隐、卡片折叠、右侧宽度都记在 localStorage，下次打开保持一致。
   * 注意：只存布局偏好，不碰文档内容。
   */
  var UI_KEY = 'ps.workspace.v3';
  var uiState = {
    tools: true, options: true, side: true, status: true,
    /* 历史记录默认收起，把高度让给图层面板 */
    cards: { hist: true, layers: false, nav: false },
    sideW: 312
  };

  function loadUiState() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(UI_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (!s) return;
      ['tools', 'options', 'side', 'status'].forEach(function (k) {
        if (typeof s[k] === 'boolean') uiState[k] = s[k];
      });
      if (s.cards) {
        ['hist', 'layers', 'nav'].forEach(function (k) {
          if (typeof s.cards[k] === 'boolean') uiState.cards[k] = s.cards[k];
        });
      }
      if (typeof s.sideW === 'number' && s.sideW >= 240 && s.sideW <= 560) uiState.sideW = s.sideW;
    } catch (e) { /* 忽略损坏的本地偏好 */ }
  }

  function saveUiState() {
    try {
      if (global.localStorage) global.localStorage.setItem(UI_KEY, JSON.stringify(uiState));
    } catch (e) { /* 隐私模式 / 配额满时静默失败 */ }
  }

  function cardEl(key) {
    if (key === 'hist') return app.els.psHistCard;
    if (key === 'layers') return app.els.psLayersCard;
    if (key === 'nav') return app.els.psNavCard;
    return null;
  }

  function applyUiState() {
    var host = app.host;
    if (!host) return;
    host.classList.toggle('is-hide-tools', !uiState.tools);
    host.classList.toggle('is-hide-options', !uiState.options);
    host.classList.toggle('is-hide-side', !uiState.side);
    host.classList.toggle('is-hide-status', !uiState.status);
    host.style.setProperty('--ps-side-w', uiState.sideW + 'px');
    Array.prototype.forEach.call(host.querySelectorAll('[data-ws]'), function (b) {
      var on = !!uiState[b.dataset.ws];
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    ['hist', 'layers', 'nav'].forEach(function (k) {
      var el = cardEl(k);
      if (el) el.classList.toggle('is-collapsed', !!uiState.cards[k]);
    });
    if (app.view) app.view.schedule();
  }

  function toggleWorkspace(key) {
    if (typeof uiState[key] !== 'boolean') return;
    uiState[key] = !uiState[key];
    saveUiState();
    applyUiState();
    var labels = { tools: '工具箱', options: '选项栏', side: '右侧面板', status: '状态栏' };
    setNote(labels[key] + (uiState[key] ? '已显示' : '已收起') + '（菜单「视图」可恢复）');
  }

  function toggleFocusMode() {
    var allOn = uiState.tools && uiState.options && uiState.side && uiState.status;
    uiState.tools = uiState.options = uiState.side = uiState.status = !allOn;
    saveUiState();
    applyUiState();
    setNote(allOn ? '专注模式：已收起工具箱、选项栏、面板与状态栏（按 Tab 恢复）' : '已恢复完整工作区');
  }

  function toggleCard(key) {
    if (!cardEl(key)) return;
    uiState.cards[key] = !uiState.cards[key];
    saveUiState();
    applyUiState();
  }

  function resetWorkspace() {
    uiState.tools = uiState.options = uiState.side = uiState.status = true;
    uiState.cards = { hist: true, layers: false, nav: false };
    uiState.sideW = 312;
    saveUiState();
    applyUiState();
    setNote('工作区已恢复默认布局');
  }

  function bindWorkspace() {
    var host = app.host;
    Array.prototype.forEach.call(host.querySelectorAll('[data-ws]'), function (b) {
      b.addEventListener('click', function () { toggleWorkspace(b.dataset.ws); });
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-col]'), function (b) {
      b.addEventListener('click', function () { toggleCard(b.dataset.col); });
    });
    [['psHistTabs', 'hist'], ['psLayerTabs', 'layers']].forEach(function (pair) {
      var tabs = $id(pair[0]);
      if (!tabs) return;
      tabs.addEventListener('dblclick', function (ev) {
        if (ev.target.closest('.ps-tab-col')) return;
        toggleCard(pair[1]);
      });
    });

    var rz = app.els.psSideResize;
    if (rz) {
      var drag = null;
      rz.addEventListener('pointerdown', function (ev) {
        if (!uiState.side) return;
        drag = { x: ev.clientX, w: uiState.sideW };
        try { rz.setPointerCapture(ev.pointerId); } catch (e) {}
        ev.preventDefault();
      });
      rz.addEventListener('pointermove', function (ev) {
        if (!drag) return;
        var w = Math.min(560, Math.max(240, drag.w - (ev.clientX - drag.x)));
        uiState.sideW = Math.round(w);
        host.style.setProperty('--ps-side-w', uiState.sideW + 'px');
      });
      var endDrag = function () {
        if (!drag) return;
        drag = null;
        saveUiState();
        app.view.schedule();
      };
      rz.addEventListener('pointerup', endDrag);
      rz.addEventListener('pointercancel', endDrag);
      rz.addEventListener('dblclick', function () {
        uiState.sideW = 312;
        saveUiState();
        applyUiState();
      });
    }

    var zoomCtl = app.els.psZoomCtl;
    if (zoomCtl) {
      zoomCtl.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-zoom]');
        if (!b || !app.doc) return;
        if (b.dataset.zoom === 'in') app.view.setZoom(app.view.zoom * 1.35);
        else if (b.dataset.zoom === 'out') app.view.setZoom(app.view.zoom / 1.35);
        else if (b.dataset.zoom === 'fit') app.view.fit();
      });
    }
    var zval = app.els.psStatZoom;
    if (zval) zval.addEventListener('click', function () { openZoomMenu(zval); });
  }

  function openZoomMenu(btn) {
    closeMenu();
    if (!app.doc) return;
    var pop = document.createElement('div');
    pop.className = 'ps-menu-pop ps-zoom-pop';
    [[0.25, '25%'], [0.5, '50%'], [1, '100%'], [2, '200%'], [4, '400%'], [8, '800%']].forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-menu-item';
      b.innerHTML = '<span>' + it[1] + '</span>';
      b.addEventListener('click', function () { closeMenu(); app.view.setZoom(it[0]); });
      pop.appendChild(b);
    });
    var sep = document.createElement('div');
    sep.className = 'ps-menu-sep';
    pop.appendChild(sep);
    var fit = document.createElement('button');
    fit.type = 'button';
    fit.className = 'ps-menu-item';
    fit.innerHTML = '<span>适应窗口</span><em>Ctrl+0</em>';
    fit.addEventListener('click', function () { closeMenu(); app.view.fit(); });
    pop.appendChild(fit);
    app.host.appendChild(pop);
    var rect = btn.getBoundingClientRect();
    var hostRect = app.host.getBoundingClientRect();
    pop.style.left = Math.max(6, rect.left - hostRect.left - 40) + 'px';
    pop.style.top = 'auto';
    pop.style.bottom = (hostRect.bottom - rect.top + 6) + 'px';
    app.menuPop = pop;
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(ev) {
        if (!pop.contains(ev.target)) { closeMenu(); document.removeEventListener('pointerdown', h); }
      });
    }, 0);
  }

  /* ---------------- 界面装配 ---------------- */
  function ensureUI() {
    if (app.ui) return;
    var host = $id('psHost');
    if (!host) return;
    loadUiState();

    host.innerHTML =
      '<div class="ps-app" id="psApp">' +
        '<div class="ps-menubar" id="psMenuBar">' +
          '<span class="ps-brand" title="图像工坊"><b>IL</b><i>LAB</i></span>' +
          '<div class="ps-menus" id="psMenus"></div>' +
          '<div class="ps-doc-title" id="psDocTitle">图像工坊</div>' +
          '<div class="ps-menubar-right">' +
            '<span class="ps-workspace" id="psWorkspace">' +
              '<button type="button" class="ps-ws-btn" data-ws="tools" title="显示 / 隐藏工具箱"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16"/></svg></button>' +
              '<button type="button" class="ps-ws-btn" data-ws="options" title="显示 / 隐藏选项栏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h4M15 12h2"/></svg></button>' +
              '<button type="button" class="ps-ws-btn" data-ws="side" title="显示 / 隐藏右侧面板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>' +
              '<button type="button" class="ps-ws-btn" data-ws="status" title="显示 / 隐藏状态栏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16h18"/></svg></button>' +
            '</span>' +
            '<span class="ps-engine-dot"></span><span class="ps-engine-chip">本地引擎 · 瓦片渲染</span>' +
          '</div>' +
        '</div>' +
        '<div class="ps-body">' +
          '<aside class="ps-toolbar" id="psToolbar">' +
            '<div class="ps-tools-scroll">' +
              '<div class="ps-tools" id="psTools"></div>' +
              '<div class="ps-tool-sep"></div>' +
              '<div class="ps-tools ps-tools-ph" id="psPhTools"></div>' +
            '</div>' +
            '<div class="ps-colorbox" id="psColorBox">' +
              '<div class="ps-color-lab"><span>主色</span><span>副色</span></div>' +
              '<div class="ps-color-pair">' +
                '<label class="ps-swatch ps-swatch-fg" title="主色（前景色）"><input type="color" id="psFg" value="#000000"></label>' +
                '<label class="ps-swatch ps-swatch-bg" title="副色（背景色）"><input type="color" id="psBg" value="#ffffff"></label>' +
              '</div>' +
              '<div class="ps-color-foot">' +
                '<button type="button" class="ps-swap" id="psSwap" title="交换主副色">⇄</button>' +
                '<span class="ps-color-hex" id="psColorHex">#000000</span>' +
              '</div>' +
            '</div>' +
          '</aside>' +
          '<div class="ps-center">' +
            '<div class="ps-options">' +
              '<div class="ps-options-main" id="psOptions"></div>' +
              '<div class="ps-options-ph" id="psOptPh"></div>' +
            '</div>' +
            '<div class="ps-doctabs">' +
              '<button type="button" class="ps-doctab is-on" id="psDocTab" title="当前文档">' +
                '<span id="psDocTabName">演示作品.psd</span>' +
                '<i class="ps-doctab-x" title="关闭标签（占位控件）">×</i>' +
              '</button>' +
            '</div>' +
            '<div class="ps-stage-host" id="psStageHost"></div>' +
          '</div>' +
          '<div class="ps-side-resize" id="psSideResize" title="拖动调整面板宽度，双击复位"></div>' +
          '<aside class="ps-side">' +
            '<div class="ps-rail" id="psRail"></div>' +
            '<div class="ps-panels">' +
              '<section class="ps-card ps-history" id="psHistCard">' +
                '<div class="ps-tabs" id="psHistTabs">' +
                  '<button type="button" class="ps-tab is-on" data-htab="history">历史记录</button>' +
                  '<button type="button" class="ps-tab" data-htab="swatch">色板</button>' +
                  '<span class="ps-tab-n" id="psHistCount">0</span>' +
                  '<button type="button" class="ps-tab-col" data-col="hist" title="收起 / 展开面板">▴</button>' +
                '</div>' +
                '<div class="ps-hist-list" id="psHistList"></div>' +
                '<div class="ps-swatches hidden" id="psSwatches"></div>' +
              '</section>' +
              '<section class="ps-card ps-layers" id="psLayersCard">' +
                '<div class="ps-tabs" id="psLayerTabs">' +
                  '<button type="button" class="ps-tab is-on" data-ltab="layers">图层</button>' +
                  '<button type="button" class="ps-tab" data-ltab="channels">通道</button>' +
                  '<button type="button" class="ps-tab" data-ltab="paths">路径</button>' +
                  '<span class="ps-tab-n" id="psLayerCount">0</span>' +
                  '<button type="button" class="ps-tab-col" data-col="layers" title="收起 / 展开面板">▴</button>' +
                '</div>' +
                '<div class="ps-layer-props" id="psLayerProps"></div>' +
                '<div class="ps-layer-list" id="psLayerList"></div>' +
                '<div class="ps-layer-acts">' +
                  '<button type="button" class="ps-mini" data-lay="add" title="新建图层">＋</button>' +
                  '<button type="button" class="ps-mini" data-lay="dup" title="复制图层">⧉</button>' +
                  '<button type="button" class="ps-mini" data-lay="adj" title="新建调整层">◐</button>' +
                  '<button type="button" class="ps-mini" data-lay="merge" title="向下合并">⤓</button>' +
                  '<button type="button" class="ps-mini" data-lay="del" title="删除图层">×</button>' +
                '</div>' +
              '</section>' +
              '<section class="ps-card ps-info" id="psNavCard">' +
                '<div class="ps-card-h"><span>导航器</span><span class="ps-card-actions">' +
                  '<button type="button" class="ps-mini" id="psNavFit" title="适应窗口（Ctrl+0）">适应</button>' +
                  '<button type="button" class="ps-mini" id="psNav100" title="实际像素（Ctrl+1）">1:1</button>' +
                  '<button type="button" class="ps-tab-col" data-col="nav" title="收起 / 展开面板">▴</button>' +
                '</span></div>' +
                '<div class="ps-nav"><canvas id="psNavCanvas" width="248" height="148"></canvas></div>' +
                '<div class="ps-nav-zoom"><span id="psNavZoom">100%</span><span class="ps-nav-zoom-lab">缩放</span></div>' +
                '<div class="ps-info-list" id="psInfo"></div>' +
              '</section>' +
            '</div>' +
          '</aside>' +
        '</div>' +
        '<div class="ps-statusbar">' +
          '<span class="ps-zoomctl" id="psZoomCtl">' +
            '<button type="button" class="ps-zbtn" data-zoom="out" title="缩小（Ctrl+-）">−</button>' +
            '<button type="button" class="ps-zbtn ps-zval" id="psStatZoom" title="点击选择缩放比例">100%</button>' +
            '<button type="button" class="ps-zbtn" data-zoom="in" title="放大（Ctrl+=）">＋</button>' +
            '<button type="button" class="ps-zbtn" data-zoom="fit" title="适应窗口（Ctrl+0）">适应</button>' +
          '</span>' +
          '<span class="ps-stat" id="psStatSize">—</span>' +
          '<span class="ps-stat" id="psStatTiles">0 瓦片</span>' +
          '<span class="ps-stat" id="psStatFps">— FPS</span>' +
          '<span class="ps-stat" id="psStatMem">0 MB</span>' +
          '<span class="ps-status-note" id="psNote"></span>' +
          '<span class="ps-status-icons" id="psStatusIcons"></span>' +
        '</div>' +
      '</div>' +
      '<input type="file" id="psFile" accept="image/*" multiple hidden>' +
      '<input type="file" id="psProjFile" accept=".ilab,.json,application/json" hidden>';

    app.host = $id('psApp');
    var e = app.els;
    ['psMenus', 'psDocTitle', 'psTools', 'psPhTools', 'psOptions', 'psOptPh', 'psStageHost', 'psLayerProps',
      'psLayerList', 'psLayerCount', 'psHistList', 'psHistCount', 'psInfo', 'psNavCanvas',
      'psStatZoom', 'psStatSize', 'psStatTiles', 'psStatFps', 'psStatMem', 'psNote',
      'psFg', 'psBg', 'psSwap', 'psColorHex', 'psFile', 'psProjFile', 'psRail', 'psSwatches', 'psStatusIcons',
      'psDocTabName', 'psLayersCard', 'psHistCard', 'psNavCard', 'psSideResize', 'psWorkspace', 'psZoomCtl'
    ].forEach(function (id) { e[id] = $id(id); });

    var navFit = $id('psNavFit');
    var nav100 = $id('psNav100');
    if (navFit) navFit.addEventListener('click', function () { app.view.fit(); });
    if (nav100) nav100.addEventListener('click', function () { app.view.setZoom(1); });

    app.view = new PSView(e.psStageHost, { onStats: onStats });
    app.tools = PSTools.create(app.view, {
      doc: function () { return app.doc; },
      layer: function () { return app.doc ? PS.activeLayer(app.doc) : null; },
      colors: function () { return { fg: app.fg, bg: app.bg }; },
      status: setNote,
      change: function () { refreshAll(); },
      onColor: function (hex) {
        app.fg = hex;
        syncColorUI();
        refreshAll();
      },
      onText: function (pt) { promptText(pt); }
    });

    buildMenus();
    buildToolbar();
    buildPlaceholderTools();
    buildRail();
    buildOptionsPh();
    buildSwatches();
    buildStatusIcons();
    buildOptions();
    bindStageDrops();
    bindEvents();
    bindWorkspace();
    app.ui = true;
    applyUiState();
  }

  function buildMenus() {
    var wrap = app.els.psMenus;
    MENUS.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-menu';
      b.textContent = m.name;
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openMenu(m, b);
      });
      wrap.appendChild(b);
    });
  }

  function closeMenu() {
    if (app.menuPop) {
      app.menuPop.remove();
      app.menuPop = null;
    }
  }

  function openMenu(menu, btn) {
    closeMenu();
    var pop = document.createElement('div');
    pop.className = 'ps-menu-pop';
    menu.items.forEach(function (it) {
      if (it.sep) {
        var sp = document.createElement('div');
        sp.className = 'ps-menu-sep';
        pop.appendChild(sp);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-menu-item';
      b.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.hint ? '<em>' + esc(it.hint) + '</em>' : '');
      b.addEventListener('click', function () {
        closeMenu();
        doAction(it.act);
      });
      pop.appendChild(b);
    });
    app.host.appendChild(pop);
    var rect = btn.getBoundingClientRect();
    var hostRect = app.host.getBoundingClientRect();
    pop.style.left = Math.max(6, rect.left - hostRect.left) + 'px';
    pop.style.top = Math.max(6, rect.bottom - hostRect.top + 4) + 'px';
    app.menuPop = pop;
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(ev) {
        if (!pop.contains(ev.target)) { closeMenu(); document.removeEventListener('pointerdown', h); }
      });
    }, 0);
  }

  function buildToolbar() {
    var wrap = app.els.psTools;
    TOOLS.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-tool' + (t.id === app.tools.tool() ? ' is-on' : '');
      b.dataset.tool = t.id;
      b.title = t.name + (t.key ? ' · ' + t.key : '');
      b.innerHTML = '<span class="ps-tool-ico">' + ico(t.svg) + '</span>' +
        '<span class="ps-tool-name">' + esc(t.name) + '</span>' +
        '<span class="ps-tool-key">' + esc(t.key || '') + '</span>';
      b.addEventListener('click', function () { selectTool(t.id); });
      wrap.appendChild(b);
    });
  }

  function selectTool(id) {
    app.tools.setTool(id);
    Array.prototype.forEach.call(app.els.psTools.children, function (b) {
      b.classList.toggle('is-on', b.dataset.tool === id);
    });
    buildOptions();
    app.view.schedule();
  }

  /* 占位工具按钮：只为还原 PS 的工具位，点击不改当前工具 */
  function buildPlaceholderTools() {
    var wrap = app.els.psPhTools;
    if (!wrap) return;
    PH_TOOLS.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-tool is-ph';
      b.title = t.name + '（占位控件）';
      b.innerHTML = '<span class="ps-tool-ico">' + ico(t.svg) + '</span>' +
        '<span class="ps-tool-name">' + esc(t.name) + '</span>' +
        '<span class="ps-tool-key"></span>';
      b.addEventListener('click', function () {
        setNote('「' + t.name + '」是占位控件：当前版本未实现，保留它只为对齐参考图的工具位。');
      });
      wrap.appendChild(b);
    });
  }

  function buildRail() {
    var wrap = app.els.psRail;
    if (!wrap) return;
    RAIL.forEach(function (r, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-rail-btn' + (i === 0 ? ' is-on' : '');
      b.title = r.name + '面板（占位控件）';
      b.innerHTML = ico(r.svg);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(wrap.children, function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        setNote(r.name + '面板：占位控件，用于还原参考图的右侧图标槽。');
      });
      wrap.appendChild(b);
    });
  }

  /* 选项栏右侧的对齐 / 分布图标：参考图那一排，纯占位 */
  function buildOptionsPh() {
    var wrap = app.els.psOptPh;
    if (!wrap) return;
    var icons = [
      { name: '左对齐', svg: '<path d="M4 4v16M8 8h10M8 16h7"/>' },
      { name: '居中', svg: '<path d="M12 3v18M7 7h10M8.5 13h7"/>' },
      { name: '右对齐', svg: '<path d="M20 4v16M6 8h10M9 16h7"/>' },
      { name: '水平分布', svg: '<path d="M4 4v16M20 4v16M9 9v6M15 9v6"/>' },
      { name: '垂直居中', svg: '<path d="M3 12h18M7 7v10M13 8.5v7"/>' },
      { name: '垂直分布', svg: '<path d="M4 4h16M4 20h16M9 9h6M9 15h6"/>' }
    ];
    icons.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-oph';
      b.title = it.name + '（占位控件）';
      b.innerHTML = ico(it.svg);
      b.addEventListener('click', function () { setNote(it.name + '：占位控件，未与图层对齐逻辑联动。'); });
      wrap.appendChild(b);
    });
  }

  var SWATCH_COLORS = [
    '#000000', '#3f3f3f', '#787878', '#b2b2b2', '#ffffff', '#7f0000', '#ff0000', '#ff7f00',
    '#ffff00', '#7fff00', '#00ff00', '#00ff7f', '#00ffff', '#007fff', '#0000ff', '#7f00ff',
    '#ff00ff', '#ff007f', '#7f3f00', '#ffbf7f', '#ffffbf', '#bfff7f', '#7fffbf', '#7fffff',
    '#7fbfff', '#7f7fff', '#bf7fff', '#ff7fbf', '#4d1a1a', '#805533', '#b38f66', '#e6cbb3'
  ];

  function syncColorUI() {
    var e = app.els;
    if (e.psFg) e.psFg.value = app.fg;
    if (e.psBg) e.psBg.value = app.bg;
    if (e.psColorHex) e.psColorHex.textContent = String(app.fg).toUpperCase();
  }

  function buildSwatches() {
    var wrap = app.els.psSwatches;
    if (!wrap) return;
    SWATCH_COLORS.forEach(function (col) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-swatch-cell';
      b.title = col.toUpperCase();
      b.style.background = col;
      b.addEventListener('click', function () {
        app.fg = col;
        syncColorUI();
        setNote('主色已设为 ' + col.toUpperCase());
      });
      wrap.appendChild(b);
    });
  }

  function buildStatusIcons() {
    var wrap = app.els.psStatusIcons;
    if (!wrap) return;
    var icons = [
      { name: '刷新视图', svg: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>' },
      { name: '网格', svg: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10h16M4 15h16M10 4v16M15 4v16"/>' },
      { name: '瓦片边界', svg: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>' },
      { name: '帮助', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2-2.5 3.6M12 17.5v.2"/>' }
    ];
    icons.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-sicon';
      b.title = it.name + '（占位控件）';
      b.innerHTML = ico(it.svg);
      b.addEventListener('click', function () { setNote(it.name + '：占位控件。'); });
      wrap.appendChild(b);
    });
  }


  /* ---------------- 选项栏 ----------------
   * 每个工具一组专业参数：数值 = 滑杆 + 可直接输入的数字框，枚举 = 分段按钮或下拉。
   * 所有 data-opt 控件共用一套绑定，改动即时写回工具层。
   */
  function optNum(key, label, min, max, step, value, unit) {
    var v = value == null ? min : value;
    return '<label class="ps-opt-field"><span>' + esc(label) + '</span>' +
      '<input type="range" data-opt="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v + '">' +
      '<input type="number" class="ps-opt-num" data-opt="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v + '">' +
      '<i>' + esc(unit || '') + '</i></label>';
  }

  function optVal(key, label, min, max, step, value, unit) {
    return '<label class="ps-opt-field"><span>' + esc(label) + '</span>' +
      '<input type="number" class="ps-opt-num" data-opt="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '">' +
      '<i>' + esc(unit || '') + '</i></label>';
  }

  function optCheck(key, label, on) {
    return '<label class="ps-opt-check"><input type="checkbox" data-opt="' + key + '"' + (on ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
  }

  function optColor(key, label, on, value) {
    return '<label class="ps-opt-color' + (on ? '' : ' is-off') + '"><span>' + esc(label) + '</span>' +
      '<input type="color" data-opt="' + key + '" value="' + esc(value) + '"></label>';
  }

  function optSelect(key, label, value, options) {
    return '<label class="ps-opt-field"><span>' + esc(label) + '</span><select data-opt="' + key + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(value) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></label>';
  }

  function optSeg(key, values, value) {
    return '<span class="ps-seg">' + values.map(function (v) {
      return '<button type="button" class="ps-seg-btn' + (String(value) === v[0] ? ' is-on' : '') +
        '" data-seg="' + key + '" data-val="' + esc(v[0]) + '">' + esc(v[1]) + '</button>';
    }).join('') + '</span>';
  }

  function buildOptions() {
    var wrap = app.els.psOptions;
    var tool = app.tools.tool();
    var o = app.tools.options();
    var def = TOOLS.find(function (t) { return t.id === tool; }) || { name: '', svg: '' };
    var html = '<div class="ps-opt-tool">' +
      (def.svg ? '<span class="ps-opt-tool-ico">' + ico(def.svg) + '</span>' : '') +
      '<span>' + esc(def.name) + '</span></div>';
    if (tool === 'brush' || tool === 'eraser') {
      html += optNum('size', '大小', 1, 240, 1, o.size, 'px') +
        optVal('spacing', '间距', 1, 200, 1, o.spacing, '%') +
        '<span class="ps-opt-sep"></span>' +
        (tool === 'brush' ? optVal('hardness', '硬度', 0, 100, 1, o.hardness, '%') : '') +
        optVal('opacity', '不透明度', 5, 100, 1, o.opacity, '%') +
        '<div class="ps-opt-hint">Shift 画直线 · 间距按笔刷直径的百分比 · 松手写入历史</div>';
    } else if (tool === 'select-rect' || tool === 'select-ellipse' || tool === 'select-lasso') {
      html += optNum('feather', '羽化', 0, 200, 1, o.feather, 'px') +
        '<div class="ps-opt-hint">拖拽创建选区 · 羽化让选区边缘按遮罩柔和过渡</div>';
    } else if (tool === 'magic-wand') {
      html += optNum('tolerance', '容差', 0, 255, 1, o.tolerance, '') +
        optVal('feather', '羽化', 0, 200, 1, o.feather, 'px') +
        '<span class="ps-opt-sep"></span>' +
        optCheck('wandContiguous', '连续', o.wandContiguous) +
        optCheck('wandMerged', '取样合并图层', o.wandMerged) +
        '<div class="ps-opt-hint">按颜色容差取样 · 选区是矢量轮廓，可直接绘制与裁剪</div>';
    } else if (tool === 'fill') {
      html += optNum('fillTolerance', '容差', 0, 255, 1, o.fillTolerance, '') +
        optVal('fillOpacity', '不透明度', 5, 100, 1, o.fillOpacity, '%') +
        optCheck('fillContiguous', '连续', o.fillContiguous) +
        '<div class="ps-opt-hint">点击填充 · 关闭连续则替换整层同色像素 · 受选区限制</div>';
    } else if (tool === 'gradient') {
      html += optSeg('gradKind', [['linear', '线性'], ['radial', '径向']], o.gradKind) +
        optSelect('gradient', '色彩', o.gradient, [
          ['fg2transparent', '前景色 → 透明'], ['fg2bg', '前景色 → 背景色']
        ]) +
        optVal('gradOpacity', '不透明度', 5, 100, 1, o.gradOpacity, '%') +
        '<div class="ps-opt-hint">拖拽方向决定渐变轴 · 受选区限制</div>';
    } else if (tool === 'eyedropper') {
      html += optSeg('eyeSize', [['1', '1×1'], ['3', '3×3'], ['5', '5×5']], String(o.eyeSize)) +
        optCheck('eyeMerged', '合并图层取样', o.eyeMerged) +
        '<div class="ps-opt-hint">点击画布取色，自动写入前景色</div>';
    } else if (tool === 'crop') {
      html += optSeg('cropRatio', [['free', '自由'], ['1:1', '1:1'], ['4:3', '4:3'], ['16:9', '16:9']], o.cropRatio) +
        '<div class="ps-opt-hint">拖出裁剪框，松手即生效 · 按住 Shift 临时锁定 1:1</div>';
    } else if (tool === 'pen' || tool === 'shape') {
      if (tool === 'shape') {
        html += optSelect('vectorKind', '形状', o.vectorKind, [
          ['rect', '矩形'], ['ellipse', '椭圆'], ['line', '直线']
        ]) + '<span class="ps-opt-sep"></span>';
      }
      html +=
        optCheck('fillOn', '填充', o.fillOn) +
        optColor('fillColor', '色', o.fillOn, o.fillColor) +
        optCheck('strokeOn', '描边', o.strokeOn) +
        optColor('strokeColor', '色', o.strokeOn, o.strokeColor) +
        optNum('strokeWidth', '宽度', 0, 40, 1, o.strokeWidth, 'px') +
        '<div class="ps-opt-hint">' + (tool === 'pen'
          ? '单击落锚点 · 拖动拉出控制柄 · 点回起点或 Enter 闭合 · Esc 取消'
          : '拖拽创建矢量形状 · Shift 等比 · 缩放不失真') + '</div>';
    } else if (tool === 'path-select') {
      html += '<div class="ps-opt-hint">点击矢量路径选中图层 · 拖动锚点改形 · 拖动路径整体移动</div>';
    } else if (tool === 'move') {
      html += optCheck('autoSelect', '自动选择', o.autoSelect) +
        '<div class="ps-opt-hint">按下时选中光标下最上层的不透明图层 · 滚轮平移 · Ctrl+滚轮缩放</div>';
    } else if (tool === 'text') {
      html += '<div class="ps-opt-hint">点击画布放置文字基线，再填写内容、字号与颜色</div>';
    } else {
      html += '<div class="ps-opt-hint">拖拽创建选区 · 选区外自动保护</div>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-opt]').forEach(function (inp) {
      var key = inp.dataset.opt;
      var field = inp.closest('.ps-opt-field');
      function apply() {
        var val;
        if (inp.type === 'checkbox') val = inp.checked;
        else if (inp.type === 'range' || inp.type === 'number') {
          val = Number(inp.value);
          if (inp.value === '' || !isFinite(val)) return;
          val = Math.max(Number(inp.min), Math.min(Number(inp.max), val));
        } else val = inp.value;
        app.tools.setOption(key, val);
        // 滑杆与数字框互相同步
        if (field) {
          field.querySelectorAll('[data-opt="' + key + '"]').forEach(function (x) {
            if (x !== inp) x.value = inp.value;
          });
        }
        if (key === 'size' && app.view.cursorOn && app.view.cursorDoc) {
          app.view.setCursor(app.view.cursorDoc.docX, app.view.cursorDoc.docY, val / 2);
        }
      }
      inp.addEventListener('input', apply);
      if (inp.type === 'checkbox' || inp.tagName === 'SELECT') {
        inp.addEventListener('change', function () {
          apply();
          if (key === 'fillOn' || key === 'strokeOn' || key === 'vectorKind') buildOptions();
        });
      }
    });
    wrap.querySelectorAll('[data-seg]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.seg;
        var raw = btn.dataset.val;
        app.tools.setOption(key, /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
        wrap.querySelectorAll('[data-seg="' + key + '"]').forEach(function (x) {
          x.classList.toggle('is-on', x === btn);
        });
      });
    });
  }

  function bindEvents() {
    var e = app.els;
    /* 窗口迁到 apps/imglab/app.js 后由 registerApp 生成，id 统一成 btn<窗口id>Close */
    var closeBtn = $id('btnImgLabWinClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (typeof global.deskCloseWin === 'function') global.deskCloseWin($id('imgLabWin'));
      });
    }
    e.psFg.addEventListener('input', function () {
      app.fg = e.psFg.value;
      syncColorUI();
    });
    e.psBg.addEventListener('input', function () {
      app.bg = e.psBg.value;
      syncColorUI();
    });
    e.psSwap.addEventListener('click', function () {
      var t = app.fg;
      app.fg = app.bg;
      app.bg = t;
      syncColorUI();
    });
    syncColorUI();

    Array.prototype.forEach.call(app.host.querySelectorAll('[data-lay]'), function (b) {
      b.addEventListener('click', function () { layerAction(b.dataset.lay); });
    });

    e.psLayerList.addEventListener('click', function (ev) {
      var row = ev.target.closest('.ps-lay');
      if (!row || !app.doc) return;
      var layer = PS.layerById(app.doc, row.dataset.id);
      if (!layer) return;
      if (ev.target.closest('[data-vis]')) {
        PS.setLayerProp(app.doc, layer, 'visible', !layer.visible);
        refreshAll();
        return;
      }
      app.doc.activeId = layer.id;
      refreshAll();
    });
    e.psLayerList.addEventListener('dragstart', function (ev) {
      var row = ev.target.closest('.ps-lay');
      if (!row || !app.doc) return;
      app.layerDragId = row.dataset.id;
      row.classList.add('is-dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', row.dataset.id); } catch (err) {}
      }
    });
    e.psLayerList.addEventListener('dragover', function (ev) {
      if (!app.layerDragId || !app.doc) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      var row = ev.target.closest('.ps-lay');
      Array.prototype.forEach.call(e.psLayerList.querySelectorAll('.ps-lay'), function (r) {
        r.classList.remove('is-drop-before', 'is-drop-after');
      });
      if (!row || row.dataset.id === app.layerDragId) return;
      var rect = row.getBoundingClientRect();
      row.classList.add(ev.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
    });
    e.psLayerList.addEventListener('dragleave', function (ev) {
      if (ev.target !== e.psLayerList) return;
      Array.prototype.forEach.call(e.psLayerList.querySelectorAll('.ps-lay'), function (r) {
        r.classList.remove('is-drop-before', 'is-drop-after');
      });
    });
    var clearLayerDrag = function () {
      app.layerDragId = null;
      Array.prototype.forEach.call(e.psLayerList.querySelectorAll('.ps-lay'), function (r) {
        r.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
      });
    };
    e.psLayerList.addEventListener('dragend', clearLayerDrag);
    e.psLayerList.addEventListener('drop', function (ev) {
      if (!app.layerDragId || !app.doc) return;
      ev.preventDefault();
      var dragId = app.layerDragId;
      var row = ev.target.closest('.ps-lay');
      clearLayerDrag();
      if (!row || row.dataset.id === dragId) return;
      var rows = Array.prototype.slice.call(e.psLayerList.querySelectorAll('.ps-lay'));
      var remaining = rows.filter(function (r) { return r.dataset.id !== dragId; });
      var ti = remaining.indexOf(row);
      if (ti < 0) return;
      var rect = row.getBoundingClientRect();
      var dropPos = ti + (ev.clientY > rect.top + rect.height / 2 ? 1 : 0);
      var layer = PS.layerById(app.doc, dragId);
      var docIndex = (app.doc.layers.length - 1) - dropPos;
      if (layer && PS.moveLayer(app.doc, layer, docIndex)) {
        refreshAll();
        setNote('已调整图层顺序（Ctrl+Z 可撤销）');
      }
    });
    e.psLayerList.addEventListener('contextmenu', function (ev) {
      var row = ev.target.closest('.ps-lay');
      if (!row || !app.doc) return;
      ev.preventDefault();
      var layer = PS.layerById(app.doc, row.dataset.id);
      if (!layer) return;
      app.doc.activeId = layer.id;
      refreshAll();
      showLayerMenu(layer, ev.clientX, ev.clientY);
    });
    e.psLayerList.addEventListener('dblclick', function (ev) {
      var row = ev.target.closest('.ps-lay');
      if (!row || !app.doc) return;
      var layer = PS.layerById(app.doc, row.dataset.id);
      if (!layer) return;
      renameLayer(layer);
    });
    e.psHistList.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-idx]');
      if (!b || !app.doc) return;
      PS.historyJump(app.doc, Number(b.dataset.idx));
      refreshAll();
    });
    e.psFile.addEventListener('change', function () {
      var files = Array.prototype.slice.call(e.psFile.files || []);
      var place = app.pendingPlace;
      app.pendingPlace = false;
      e.psFile.value = '';
      if (files.length) importFiles(files, { forcePlace: place, label: place ? '置入图片' : '导入图片' });
    });
    if (e.psProjFile) {
      e.psProjFile.addEventListener('change', function () {
        var f = e.psProjFile.files && e.psProjFile.files[0];
        e.psProjFile.value = '';
        if (f) openProjectFile(f);
      });
    }

    /* 历史记录 / 色板 切换：色板是可用的（点色块设前景色），
     * 只是没有 PS 的「新建色板 / 存储色板」那套管理。 */
    var histTabs = $id('psHistTabs');
    if (histTabs) {
      histTabs.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-htab]');
        if (!b) return;
        app.histTab = b.dataset.htab;
        Array.prototype.forEach.call(histTabs.querySelectorAll('[data-htab]'), function (x) {
          x.classList.toggle('is-on', x === b);
        });
        var showSw = app.histTab === 'swatch';
        e.psHistList.classList.toggle('hidden', showSw);
        e.psSwatches.classList.toggle('hidden', !showSw);
        if (e.psHistCount) e.psHistCount.style.visibility = showSw ? 'hidden' : '';
        if (showSw) setNote('色板：点击色块可直接设置前景色。');
      });
    }

    /* 图层 / 通道 / 路径 切换：后两个是占位面板 */
    var layerTabs = $id('psLayerTabs');
    if (layerTabs) {
      layerTabs.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-ltab]');
        if (!b) return;
        app.layerTab = b.dataset.ltab;
        Array.prototype.forEach.call(layerTabs.querySelectorAll('[data-ltab]'), function (x) {
          x.classList.toggle('is-on', x === b);
        });
        if (app.layerTab !== 'layers') {
          setNote('「' + (app.layerTab === 'channels' ? '通道' : '路径') + '」面板是占位控件：当前版本只用图层合成。');
        } else {
          setNote('图层面板');
        }
        renderLayers();
      });
    }

    var docTabX = app.host.querySelector('.ps-doctab-x');
    if (docTabX) {
      docTabX.addEventListener('click', function (ev) {
        ev.stopPropagation();
        setNote('关闭标签是占位控件；要收起窗口请点右上角的 ×。');
      });
    }

    if (!app.keyBound) {
      app.keyBound = true;
      window.addEventListener('keydown', onKey);
      /* 系统剪贴板里的图片：Ctrl+V 直接置入当前文档（没有文档就新建）。
       * 浏览器只把图片作为 File 放进 clipboardData，这里按文件路径复用导入逻辑。 */
      window.addEventListener('paste', function (ev) {
        var win = $id('imgLabWin');
        if (!win || win.classList.contains('hidden')) return;
        var tag = ev.target && ev.target.tagName;
        if (tag && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
        var dt = ev.clipboardData;
        if (!dt) return;
        var files = [];
        Array.prototype.forEach.call(dt.items || [], function (it) {
          if (it.kind === 'file' && /^image\//.test(it.type)) {
            var f = it.getAsFile();
            if (f) files.push(f);
          }
        });
        if (!app.doc) {
          Array.prototype.forEach.call(dt.files || [], function (f) {
            if (files.indexOf(f) < 0 && /^image\//.test(f.type)) files.push(f);
          });
        }
        if (!files.length) return;
        ev.preventDefault();
        importFiles(files, { forcePlace: !!app.doc, label: '粘贴图片' });
      });
    }
  }

  function bindStageDrops() {
    var wrap = app.view.wrap;
    wrap.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      wrap.classList.add('is-drop');
    });
    wrap.addEventListener('dragleave', function () { wrap.classList.remove('is-drop'); });
    wrap.addEventListener('drop', function (ev) {
      ev.preventDefault();
      wrap.classList.remove('is-drop');
      var files = ev.dataTransfer && ev.dataTransfer.files
        ? Array.prototype.slice.call(ev.dataTransfer.files) : [];
      if (files.length) importFiles(files);
    });
  }

  /* ---------------- 状态 / 刷新 ---------------- */
  function setNote(msg, err) {
    var el = app.els.psNote;
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-err', !!err);
    if (msg) {
      clearTimeout(app.noteTimer);
      app.noteTimer = setTimeout(function () {
        if (el.textContent === msg) { el.textContent = ''; el.classList.remove('is-err'); }
      }, 5200);
    }
  }

  function onStats(stats) {
    var e = app.els;
    if (!app.doc) return;
    if (e.psStatZoom) e.psStatZoom.textContent = Math.round(stats.zoom * 100) + '%';
    if (e.psStatTiles) e.psStatTiles.textContent = stats.tiles + ' 瓦片' + (stats.mips ? ' · ' + stats.mips + ' mip' : '') + (stats.shapes ? ' · ' + stats.shapes + ' 路径' : '');
    if (e.psStatFps) e.psStatFps.textContent = stats.fps + ' FPS';
    if (e.psStatSize) e.psStatSize.textContent = app.doc.width + ' × ' + app.doc.height;
    var navZoom = $id('psNavZoom');
    if (navZoom) navZoom.textContent = Math.round(stats.zoom * 100) + '%';
    var now = performance.now();
    if (now - app.navAt > 380) {
      app.navAt = now;
      renderNav();
    }
  }

  function refreshAll() {
    if (!app.doc) return;
    renderDocTitle();
    renderLayers();
    renderLayerProps();
    renderHistory();
    renderInfo();
    renderNav();
    updateMem();
    app.view.schedule();
  }

  function renderDocTitle() {
    var d = app.doc;
    var el = app.els.psDocTitle;
    if (el) el.textContent = d.name + '  ·  ' + d.width + ' × ' + d.height;
    if (app.els.psDocTabName) app.els.psDocTabName.textContent = docTabName(d);
  }

  /* 标签页文字：像 PS 一样用文件名。演示稿名字里带「· 尺寸」，截取前半段 */
  function docTabName(d) {
    var n = String(d.name || '未命名');
    if (n.indexOf('·') >= 0) n = n.split('·')[0].trim();
    if (/\.(psd|png|jpg|jpeg|webp|gif|bmp)$/i.test(n)) return n;
    return n + '.psd';
  }

  function updateMem() {
    var el = app.els.psStatMem;
    if (el && app.doc) el.textContent = fmtBytes(PS.memBytes(app.doc));
  }

  function renderLayers() {
    var doc = app.doc;
    var list = app.els.psLayerList;
    if (!list) return;
    var alt = app.layerTab !== 'layers';
    if (app.els.psLayersCard) app.els.psLayersCard.classList.toggle('is-alt', alt);
    if (alt) {
      var label = app.layerTab === 'channels' ? '通道' : '路径';
      list.innerHTML = '<div class="ps-empty-panel">' + label + '面板 · 占位控件<br>' +
        '<span>当前版本只用图层合成，' + label + '留作参考图的结构位</span></div>';
      if (app.els.psLayerCount) app.els.psLayerCount.textContent = '0';
      return;
    }
    var count = doc.layers.length;
    if (app.els.psLayerCount) app.els.psLayerCount.textContent = String(count);
    var rows = '';
    doc.layers.slice().reverse().forEach(function (layer) {
      var active = layer.id === doc.activeId;
      var kindText = layer.type === 'adjust'
        ? '调整 · ' + esc(PS.ADJUST_DEFS[layer.adjust.kind].name)
        : layer.type === 'shape'
          ? '矢量 · ' + ((layer.shapes && layer.shapes.length) || 0) + ' 个形状'
          : '像素 · ' + Math.round(layer.opacity * 100) + '%';
      rows += '<div class="ps-lay' + (active ? ' is-on' : '') + (layer.visible ? '' : ' is-off') + '" draggable="true" data-id="' + esc(layer.id) + '">' +
        '<button type="button" class="ps-eye" data-vis="1" title="显示 / 隐藏">' + (layer.visible ? '◉' : '○') + '</button>' +
        '<canvas class="ps-lay-thumb" width="34" height="34"></canvas>' +
        '<div class="ps-lay-meta"><div class="ps-lay-name">' + esc(layer.name) + '</div>' +
        '<div class="ps-lay-kind' + (layer.type === 'shape' ? ' is-vector' : '') + '">' + kindText + '</div></div>' +
        '<span class="ps-lay-lock" title="图层锁定（占位控件）">' + LOCK_SVG + '</span>' +
        '</div>';
    });
    list.innerHTML = rows;
    // 缩略图：OffscreenCanvas 画到普通 canvas 上
    Array.prototype.forEach.call(list.querySelectorAll('.ps-lay'), function (row) {
      var layer = PS.layerById(doc, row.dataset.id);
      var cv = row.querySelector('.ps-lay-thumb');
      if (!layer || !cv) return;
      var ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, 34, 34);
      var pv = PS.layerPreview(layer, 68);
      var s = Math.min(34 / pv.width, 34 / pv.height, 1);
      ctx.drawImage(pv, (34 - pv.width * s) / 2, (34 - pv.height * s) / 2, pv.width * s, pv.height * s);
    });
  }

  function renderLayerProps() {
    var wrap = app.els.psLayerProps;
    if (!wrap) return;
    var doc = app.doc;
    var layer = PS.activeLayer(doc);
    if (!layer) {
      wrap.innerHTML = '<div class="ps-opt-hint">没有图层</div>';
      return;
    }
    var blendOptions = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'color-dodge', 'soft-light', 'luminosity'];
    var blendNames = { normal: '正常', multiply: '正片叠底', screen: '滤色', overlay: '叠加', darken: '变暗', lighten: '变亮', difference: '差值', 'color-dodge': '颜色减淡', 'soft-light': '柔光', luminosity: '明度' };
    var lockNames = ['透明像素', '图像像素', '位置', '全部'];
    var html = '<div class="ps-lp-row">' +
      '<select id="psBlend" title="混合模式">' +
      blendOptions.map(function (b) { return '<option value="' + b + '"' + (layer.blend === b ? ' selected' : '') + '>' + blendNames[b] + '</option>'; }).join('') +
      '</select>' +
      '<span class="ps-lp-lab">不透明度：</span>' +
      '<input id="psOpacity" type="range" min="0" max="100" step="1" value="' + Math.round(layer.opacity * 100) + '">' +
      '<b id="psOpacityVal">' + Math.round(layer.opacity * 100) + '%</b></div>' +
      '<div class="ps-lp-row ps-lp-lockrow">' +
      '<span class="ps-lp-lab">锁定：</span>' +
      lockNames.map(function (n) {
        return '<button type="button" class="ps-lock-btn" data-lock="' + n + '" title="锁定' + n + '（占位控件）">' + LOCK_SVG + '</button>';
      }).join('') +
      '<span class="ps-lp-lab ps-lp-fill">填充：</span><b>100%</b></div>';
    if (layer.type === 'shape') {
      html += '<div class="ps-lp-row ps-vector-row"><span class="ps-vec-badge">VECTOR</span>' +
        '<span class="ps-vec-txt">' + ((layer.shapes && layer.shapes.length) || 0) + ' 个形状 · 缩放不失真</span>' +
        '<button type="button" class="ps-mini" data-rasterize="1" title="把矢量烘焙为像素，之后可画笔与滤镜">转为像素</button></div>';
    }
    if (layer.type === 'adjust') {
      var def = PS.ADJUST_DEFS[layer.adjust.kind];
      var v = layer.adjust.params.value;
      html += '<div class="ps-lp-row ps-adjust-row"><span>' + esc(def.name) + '</span>' +
        '<input id="psAdjVal" type="range" min="' + def.min + '" max="' + def.max + '" step="' + def.step + '" value="' + v + '"><b id="psAdjOut">' + v + esc(def.unit || '') + '</b></div>';
    }
    wrap.innerHTML = html;

    Array.prototype.forEach.call(wrap.querySelectorAll('.ps-lock-btn'), function (b) {
      b.addEventListener('click', function () {
        b.classList.toggle('is-on');
        setNote('锁定「' + b.dataset.lock + '」：占位控件，不会真的锁住像素。');
      });
    });

    var rasterBtn = wrap.querySelector('[data-rasterize]');
    if (rasterBtn) {
      rasterBtn.addEventListener('click', function () { rasterizeLayer(layer); });
    }

    var blend = $id('psBlend');
    blend.addEventListener('change', function () {
      PS.setLayerProp(doc, layer, 'blend', blend.value);
      refreshAll();
    });
    var op = $id('psOpacity');
    op.addEventListener('input', function () {
      layer.opacity = Number(op.value) / 100;
      layer.version++;
      doc.version++;
      $id('psOpacityVal').textContent = op.value + '%';
      app.view.schedule();
    });
    op.addEventListener('change', function () {
      var now = Number(op.value) / 100;
      var old = Number(op.dataset.old || layer.opacity);
      PS.pushEntry(doc, {
        label: '图层不透明度', touched: [layer],
        undo: function () { layer.opacity = old; layer.version++; doc.version++; },
        redo: function () { layer.opacity = now; layer.version++; doc.version++; }
      });
      refreshAll();
    });
    op.addEventListener('pointerdown', function () { op.dataset.old = String(layer.opacity); });
    if (layer.type === 'adjust') {
      var adj = $id('psAdjVal');
      var out = $id('psAdjOut');
      var def2 = PS.ADJUST_DEFS[layer.adjust.kind];
      adj.dataset.old = String(layer.adjust.params.value);
      adj.addEventListener('input', function () {
        var val = Number(adj.value);
        layer.adjust.params.value = val;
        layer.version++;
        doc.version++;
        out.textContent = val + (def2.unit || '');
        app.view.schedule();
      });
      adj.addEventListener('change', function () {
        var now2 = Number(adj.value);
        var old2 = Number(adj.dataset.old || now2);
        PS.pushEntry(doc, {
          label: '调整层参数', touched: [layer],
          undo: function () { layer.adjust.params.value = old2; layer.version++; doc.version++; },
          redo: function () { layer.adjust.params.value = now2; layer.version++; doc.version++; }
        });
      });
    }
  }

  function renderHistory() {
    var doc = app.doc;
    var list = app.els.psHistList;
    if (!list) return;
    var h = doc.history;
    if (app.els.psHistCount) app.els.psHistCount.textContent = String(h.entries.length);
    var html = '<button type="button" class="ps-hist' + (h.index < 0 ? ' is-on' : '') + '" data-idx="-1">打开文档</button>';
    h.entries.forEach(function (en, i) {
      html += '<button type="button" class="ps-hist' + (i === h.index ? ' is-on' : '') + (i > h.index ? ' is-future' : '') + '" data-idx="' + i + '">' + esc(en.label) + '</button>';
    });
    list.innerHTML = html;
  }

  function renderInfo() {
    var doc = app.doc;
    if (!doc) return;
    var layer = PS.activeLayer(doc);
    var tiles = 0;
    var mip = 0;
    doc.layers.forEach(function (l) {
      tiles += l.tiles.size;
      mip += l.mips.length;
    });
    var sel = doc.selection;
    var selText = '无';
    if (sel.active) {
      var b = PS.boundsOfShape(sel.shape);
      selText = (sel.invert ? '反选 · ' : '') + (b ? Math.round(b.w) + ' × ' + Math.round(b.h) : '');
    }
    var rows = [
      ['画布', doc.width + ' × ' + doc.height],
      ['图层', doc.layers.length + ' · ' + (layer ? layer.name : '—')],
      ['瓦片', tiles + (mip ? ' · mip ' + mip : '')],
      ['选区', selText],
      ['内存', fmtBytes(PS.memBytes(doc))]
    ];
    app.els.psInfo.innerHTML = rows.map(function (r) {
      return '<div class="ps-info-row"><span>' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>';
    }).join('');
  }

  function renderNav() {
    var canvas = app.els.psNavCanvas;
    if (!canvas || !app.doc) return;
    var ctx = canvas.getContext('2d');
    var doc = app.doc;
    var w = canvas.width;
    var h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f5f6f8';
    ctx.fillRect(0, 0, w, h);
    var s = Math.min(w * 0.92 / doc.width, h * 0.92 / doc.height, 1);
    var panX = (w - doc.width * s) / 2;
    var panY = (h - doc.height * s) / 2;
    if (!app.navComp) app.navComp = PS.makeCanvas(w, h);
    if (!app.navScratch) app.navScratch = PS.makeCanvas(w, h);
    var comp = app.navComp;
    comp.ctx.setTransform(1, 0, 0, 1, 0, 0);
    comp.ctx.clearRect(0, 0, w, h);
    PS.composite(comp.ctx, doc, {
      zoom: s, panX: panX, panY: panY, dpr: 1,
      width: w, height: h, scratch: app.navScratch, useMips: true
    });
    ctx.drawImage(comp.canvas, 0, 0);
    // 视口框
    var v = app.view;
    var vx0 = -v.panX / v.zoom;
    var vy0 = -v.panY / v.zoom;
    var vx1 = (v.cssW - v.panX) / v.zoom;
    var vy1 = (v.cssH - v.panY) / v.zoom;
    ctx.strokeStyle = '#5b8fd9';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      panX + vx0 * s + 0.5,
      panY + vy0 * s + 0.5,
      Math.max(2, (vx1 - vx0) * s),
      Math.max(2, (vy1 - vy0) * s)
    );
    ctx.strokeStyle = 'rgba(28,38,60,.18)';
    ctx.strokeRect(panX + 0.5, panY + 0.5, doc.width * s, doc.height * s);
  }

  /* ---------------- 动作 ---------------- */
  function doAction(act) {
    if (!app.doc && act !== 'new' && act !== 'open' && act !== 'place' && act !== 'openProject'
      && act !== 'paste' && act !== 'about' && act !== 'shortcuts' && act !== 'libraryPlace'
      && act !== 'focusMode' && act !== 'toggleTools' && act !== 'toggleOptions'
      && act !== 'toggleSide' && act !== 'toggleStatus' && act !== 'resetWorkspace') return;
    var doc = app.doc;
    if (act === 'focusMode') return toggleFocusMode();
    if (act === 'resetWorkspace') return resetWorkspace();
    if (act === 'toggleTools') return toggleWorkspace('tools');
    if (act === 'toggleOptions') return toggleWorkspace('options');
    if (act === 'toggleSide') return toggleWorkspace('side');
    if (act === 'toggleStatus') return toggleWorkspace('status');
    if (act === 'new') return newDocDialog();
    if (act === 'open') { app.pendingPlace = false; app.els.psFile.click(); return; }
    if (act === 'place') { app.pendingPlace = true; app.els.psFile.click(); return; }
    if (act === 'openProject') { if (app.els.psProjFile) app.els.psProjFile.click(); return; }
    if (act === 'saveProject') return saveProject();
    if (act === 'libraryPlace') return placeFromLibrary();
    if (act === 'paste') return pasteFromClipboard();
    if (act === 'undo') { PS.undo(doc); refreshAll(); return; }
    if (act === 'redo') { PS.redo(doc); refreshAll(); return; }
    if (act === 'fit') { app.view.fit(); return; }
    if (act === 'actual') { app.view.actual(); return; }
    if (act === 'zoomIn') { app.view.setZoom(app.view.zoom * 1.35); return; }
    if (act === 'zoomOut') { app.view.setZoom(app.view.zoom / 1.35); return; }
    if (act === 'toggleGrid') {
      app.view.showGrid = !app.view.showGrid;
      app.view.schedule();
      setNote('网格 ' + (app.view.showGrid ? '开' : '关'));
      return;
    }
    if (act === 'toggleTiles') {
      app.view.showTiles = !app.view.showTiles;
      app.view.schedule();
      setNote('瓦片边界 ' + (app.view.showTiles ? '开' : '关'));
      return;
    }
    if (act === 'selectAll') { PS.selectAll(doc); refreshAll(); return; }
    if (act === 'selectNone') { PS.clearSelection(doc); refreshAll(); return; }
    if (act === 'selectInvert') { PS.invertSelection(doc); refreshAll(); return; }
    if (act === 'addLayer') { PS.addLayer(doc, { name: '图层 ' + (doc.layers.length + 1) }); refreshAll(); return; }
    if (act === 'dupLayer') { PS.duplicateLayer(doc, PS.activeLayer(doc)); refreshAll(); return; }
    if (act === 'delLayer') {
      var l = PS.activeLayer(doc);
      if (l && doc.layers.length > 1) PS.removeLayer(doc, l);
      refreshAll();
      return;
    }
    if (act === 'mergeDown') {
      var lm = PS.activeLayer(doc);
      if (!lm || !PS.mergeDown(doc, lm)) setNote('下面没有可合并的像素图层', true);
      refreshAll();
      return;
    }
    if (act === 'addAdjust') { askAdjustKind(); return; }
    if (act === 'flatten') { PS.flatten(doc); refreshAll(); setNote('已拼合为一个图层'); return; }
    if (act === 'docInfo') { showDocInfo(); return; }
    if (act === 'cropSelection') return cropToSelection();
    if (act === 'export') return exportDialog();
    if (act === 'export:png') return exportDoc('image/png');
    if (act === 'export:jpeg') return exportDoc('image/jpeg');
    if (act === 'export:webp') return exportDoc('image/webp');
    if (act === 'copyImage') return copyImage();
    if (act === 'library') return saveToLibrary();
    if (act === 'shortcuts') return showShortcuts();
    if (act === 'about') return showAbout();
    if (act.indexOf('filter:') === 0) return runFilter(act.slice(7));
    if (act === 'help') return showShortcuts();
  }

  function layerAction(kind) {
    if (!app.doc) return;
    if (kind === 'add') { PS.addLayer(app.doc, { name: '图层 ' + (app.doc.layers.length + 1) }); refreshAll(); }
    else if (kind === 'dup') { PS.duplicateLayer(app.doc, PS.activeLayer(app.doc)); refreshAll(); }
    else if (kind === 'adj') askAdjustKind();
    else if (kind === 'merge') {
      var l = PS.activeLayer(app.doc);
      if (!l || !PS.mergeDown(app.doc, l)) setNote('下面没有可合并的像素图层', true);
      refreshAll();
    } else if (kind === 'del') {
      var l2 = PS.activeLayer(app.doc);
      if (l2 && app.doc.layers.length > 1) PS.removeLayer(app.doc, l2);
      refreshAll();
    }
  }

  function rasterizeLayer(layer) {
    if (!app.doc || !layer) return;
    if (PS.rasterizeShapeLayer(app.doc, layer)) {
      setNote('矢量图层已栅格化，可继续画笔、橡皮与滤镜。');
      refreshAll();
    }
  }

  function renameLayer(layer) {
    if (!app.doc || !layer) return;
    var name = global.prompt('图层名称', layer.name);
    if (name == null) return;
    name = String(name).trim();
    if (!name || name === layer.name) return;
    var old = layer.name;
    layer.name = name;
    PS.pushEntry(app.doc, {
      label: '重命名图层', touched: [layer],
      undo: function () { layer.name = old; },
      redo: function () { layer.name = name; }
    });
    refreshAll();
  }

  function closeLayerMenu() {
    if (app.layerMenu) {
      app.layerMenu.remove();
      app.layerMenu = null;
    }
  }

  /* 图层面板右键菜单：常用图层操作都收在这里，省得去顶部菜单找 */
  function showLayerMenu(layer, clientX, clientY) {
    closeLayerMenu();
    var items = [
      { label: '重命名…', act: function () { renameLayer(layer); } },
      { sep: true },
      { label: '新建图层', act: function () { layerAction('add'); } },
      { label: '复制图层', act: function () { layerAction('dup'); } },
      { label: '新建调整层…', act: function () { layerAction('adj'); } },
      { sep: true },
      { label: '向下合并', act: function () { layerAction('merge'); } }
    ];
    if (layer.type === 'shape') {
      items.push({ label: '转为像素', act: function () { rasterizeLayer(layer); } });
    }
    items.push({ sep: true });
    items.push({
      label: '删除图层',
      disabled: app.doc.layers.length <= 1,
      act: function () { layerAction('del'); }
    });

    var pop = document.createElement('div');
    pop.className = 'ps-menu-pop ps-layer-menu';
    items.forEach(function (it) {
      if (it.sep) {
        var sp = document.createElement('div');
        sp.className = 'ps-menu-sep';
        pop.appendChild(sp);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-menu-item';
      if (it.disabled) b.disabled = true;
      b.innerHTML = '<span>' + esc(it.label) + '</span>';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeLayerMenu();
        it.act();
      });
      pop.appendChild(b);
    });
    app.host.appendChild(pop);
    var hostRect = app.host.getBoundingClientRect();
    var left = clientX - hostRect.left;
    var top = clientY - hostRect.top;
    pop.style.left = Math.max(6, Math.min(left, hostRect.width - pop.offsetWidth - 6)) + 'px';
    pop.style.top = Math.max(6, Math.min(top, hostRect.height - pop.offsetHeight - 6)) + 'px';
    app.layerMenu = pop;
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(ev) {
        if (!pop.contains(ev.target)) {
          closeLayerMenu();
          document.removeEventListener('pointerdown', h);
        }
      });
    }, 0);
  }

  function cropToSelection() {
    var doc = app.doc;
    if (!doc.selection.active) { setNote('先建立选区再裁剪', true); return; }
    var b = PS.boundsOfShape(doc.selection.shape);
    if (!b) return;
    if (PS.cropDoc(doc, b)) {
      app.view.fit();
      refreshAll();
      setNote('已裁剪到选区');
    }
  }

  /* ---------------- 对话框 ---------------- */
  function modal(cfg) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'ps-modal-wrap';
      wrap.innerHTML = '<div class="ps-modal' + (cfg.wide ? ' ps-modal-wide' : '') + '">' +
        '<div class="ps-modal-h">' + esc(cfg.title || '') + '</div>' +
        '<div class="ps-modal-b"></div>' +
        (cfg.note ? '<div class="ps-modal-note">' + esc(cfg.note) + '</div>' : '') +
        '<div class="ps-modal-f"><button type="button" class="ps-btn" data-m="cancel">取消</button>' +
        '<button type="button" class="ps-btn ps-btn-gold" data-m="ok">确定</button></div>' +
        '</div>';
      var body = wrap.querySelector('.ps-modal-b');
      var values = {};
      if (cfg.html) {
        body.innerHTML = cfg.html;
      } else {
        (cfg.fields || []).forEach(function (f) {
          values[f.key] = f.value;
          var row = document.createElement('label');
          row.className = 'ps-field';
          var label = '<span>' + esc(f.label) + '</span>';
          if (f.type === 'range') {
            row.innerHTML = label + '<input type="range" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + f.value + '"><b>' + f.value + '</b>';
            var inp = row.querySelector('input');
            var out = row.querySelector('b');
            inp.addEventListener('input', function () { values[f.key] = Number(inp.value); out.textContent = inp.value; });
          } else if (f.type === 'select') {
            row.innerHTML = label + '<select>' + (f.options || []).map(function (o) {
              return '<option value="' + esc(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
            }).join('') + '</select>';
            var sel = row.querySelector('select');
            sel.addEventListener('change', function () { values[f.key] = sel.value; });
          } else if (f.type === 'color') {
            row.innerHTML = label + '<input type="color" value="' + esc(f.value || '#e8a13a') + '">';
            var col = row.querySelector('input');
            col.addEventListener('input', function () { values[f.key] = col.value; });
          } else if (f.type === 'number') {
            row.innerHTML = label + '<input type="number" min="' + (f.min || 1) + '" max="' + (f.max || 99999) + '" step="1" value="' + f.value + '">';
            var num = row.querySelector('input');
            num.addEventListener('input', function () { values[f.key] = Number(num.value); });
          } else {
            row.innerHTML = label + '<input type="text" value="' + esc(f.value || '') + '">';
            var txt = row.querySelector('input');
            txt.addEventListener('input', function () { values[f.key] = txt.value; });
          }
          body.appendChild(row);
        });
      }
      document.body.appendChild(wrap);
      function close(v) {
        wrap.remove();
        document.removeEventListener('keydown', onEsc, true);
        resolve(v);
      }
      function onEsc(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(null); }
      }
      document.addEventListener('keydown', onEsc, true);
      wrap.querySelector('[data-m="cancel"]').addEventListener('click', function () { close(null); });
      wrap.querySelector('[data-m="ok"]').addEventListener('click', function () { close(cfg.html ? true : values); });
      wrap.addEventListener('pointerdown', function (ev) { if (ev.target === wrap) close(null); });
      var first = wrap.querySelector('input,select');
      if (first) setTimeout(function () { first.focus(); }, 30);
    });
  }

  function newDocDialog() {
    modal({
      title: '新建文档',
      fields: [
        { key: 'w', label: '宽度', type: 'number', value: 1600, min: 8, max: 8192 },
        { key: 'h', label: '高度', type: 'number', value: 1000, min: 8, max: 8192 },
        { key: 'bg', label: '背景色', type: 'color', value: '#ffffff' },
        { key: 'name', label: '名称', type: 'text', value: '未命名作品' }
      ]
    }).then(function (v) {
      if (!v) return;
      var w = Math.max(8, Math.min(8192, Math.round(v.w || 1600)));
      var h = Math.max(8, Math.min(8192, Math.round(v.h || 1000)));
      var doc = PS.createDoc(w, h, v.name || '未命名作品', { fill: v.bg || '#ffffff' });
      app.doc = doc;
      app.view.setDoc(doc);
      refreshAll();
      setNote('新建 ' + w + ' × ' + h);
    });
  }

  function askAdjustKind() {
    var options = Object.keys(PS.ADJUST_DEFS).map(function (k) { return { value: k, label: PS.ADJUST_DEFS[k].name }; });
    modal({
      title: '新建调整层',
      fields: [{ key: 'kind', label: '类型', type: 'select', value: 'brightness', options: options }]
    }).then(function (v) {
      if (!v) return;
      var layer = PS.addAdjustLayer(app.doc, v.kind);
      if (layer) refreshAll();
    });
  }

  function promptText(pt) {
    modal({
      title: '写入文字',
      fields: [
        { key: 'text', label: '内容', type: 'text', value: '标题文字' },
        { key: 'size', label: '字号', type: 'range', min: 8, max: 400, step: 1, value: 96 },
        { key: 'color', label: '颜色', type: 'color', value: app.fg }
      ]
    }).then(function (v) {
      if (!v) return;
      app.tools.drawText(app.doc, PS.activeLayer(app.doc), {
        text: v.text, x: pt.x, y: pt.y, size: v.size, color: v.color
      });
      refreshAll();
    });
  }

  function showDocInfo() {
    var d = app.doc;
    var flat = null;
    var rows = [
      '画布：' + d.width + ' × ' + d.height + ' px（' + (d.width * d.height / 1e6).toFixed(1) + ' 百万像素）',
      '图层：' + d.layers.length + ' 个',
      '瓦片：' + d.layers.reduce(function (n, l) { return n + l.tiles.size; }, 0) + ' 块（256 px）',
      '历史：' + d.history.entries.length + ' 步 · ' + fmtBytes(d.history.bytes),
      '内存：' + fmtBytes(PS.memBytes(d)),
      '工程格式：.ilab（图层 PNG + 矢量 / 调整层结构；不含历史）',
      '导入上限：' + (PS.MAX_IMPORT_PIXELS / 1e6) + ' 百万像素 / 单边 ' + PS.MAX_IMPORT_DIM + ' px（超出自动降采样）'
    ];
    modal({ title: '图像信息', html: '<div class="ps-info-modal">' + rows.map(function (r) { return '<div>' + esc(r) + '</div>'; }).join('') + '</div>' });
  }

  function showShortcuts() {
    var html = '<div class="ps-info-modal">' +
      '<div><b>文件</b> Ctrl+O 打开图片 · Ctrl+Shift+O 置入图片 · Ctrl+V 粘贴为图层 · Ctrl+Shift+E 导出 · Ctrl+S 保存工程 · Ctrl+Shift+C 复制图像</div>' +
      '<div><b>工具</b> V 移动 · M 矩形选区 · L 套索 · <b>W 魔棒</b> · C 裁剪 · I 吸管 · B 画笔 · E 橡皮 · G 渐变 · K 油漆桶 · <b>P 钢笔</b> · <b>U 形状</b> · <b>A 路径选择</b> · T 文字</div>' +
      '<div><b>矢量</b> 钢笔：单击落点 · 拖动出曲线 · 点回起点或 Enter 闭合 · Esc 取消；路径选择可拖动锚点改形</div>' +
      '<div><b>编辑</b> Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+A 全选 · Ctrl+D 取消选区 · Ctrl+Shift+I 反选</div>' +
      '<div><b>图层</b> Ctrl+J 复制 · Ctrl+E 向下合并 · Ctrl+Shift+F 拼合</div>' +
      '<div><b>视图</b> Ctrl+0 适应 · Ctrl+1 实际像素 · Ctrl+= / - 缩放 · 空格拖拽平移 · Ctrl+滚轮缩放</div>' +
      '<div><b>工作区</b> Tab 专注模式（收起全部面板）· 右上角四个按钮分别收纳工具箱 / 选项栏 / 面板 / 状态栏 · 双击面板标签可折叠</div>' +
      '<div><b>笔刷</b> [ / ] 调整大小 · 自由滚轮平移画布</div>' +
      '</div>';
    modal({ title: '快捷键', html: html });
  }

  function showAbout() {
    modal({
      title: '关于图像工坊',
      html: '<div class="ps-info-modal">' +
        '<div><b>' + APP_NAME + '</b> · 对标 Photoshop 的网页图像工作站</div>' +
        '<div>瓦片化图层存储 + 视口裁剪合成 + mip 缩略层 + 脏瓦片历史。</div>' +
        '<div>大图导入自动降采样到 4800 万像素以内，避免画布尺寸超限。</div>' +
        '<div>所有处理在主线程分片完成，不依赖 Web Worker。</div>' +
        '</div>'
    });
  }

  /* ---------------- 导入 / 导出 ---------------- */
  var IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
  var PROJECT_EXT = /\.(ilab|json)$/i;
  var EXPORT_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

  function fileBase(name) {
    var s = String(name || '').replace(/\.[^.]+$/, '').trim();
    return s || '导入图片';
  }

  function docBase() {
    var n = String((app.doc && app.doc.name) || '未命名');
    n = n.split('·')[0].trim();
    n = n.replace(/\.[a-z0-9]+$/i, '');
    return n || '未命名';
  }

  function safeName(s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  }

  function imageFileOk(f) {
    if (!f) return false;
    return /^image\//i.test(f.type || '') || IMAGE_EXT.test(f.name || '');
  }

  function projectFileOk(f) {
    if (!f) return false;
    return PROJECT_EXT.test(f.name || '') || /json/i.test(f.type || '');
  }

  function askImportMode(count) {
    return modal({
      title: '导入 ' + count + ' 张图片',
      note: '当前已有文档：置入会保留现有图层；新建文档会替换当前画布，建议先保存工程。',
      fields: [{
        key: 'mode', label: '方式', type: 'select', value: 'place',
        options: [
          { value: 'place', label: '置入当前文档（新图层）' },
          { value: 'open', label: '新建文档打开（替换画布）' }
        ]
      }]
    }).then(function (v) { return v ? v.mode : null; });
  }

  /* 统一的导入入口：图片 / 工程混拖、多选、粘贴、图库都走这里。
   * 多图时第一张建文档，其余依次置入为图层。 */
  async function importFiles(files, opts) {
    opts = opts || {};
    if (!files || !files.length) return null;
    if (app.busy) { setNote('正在处理上一个任务，请稍候', true); return null; }
    var projects = [];
    var images = [];
    var skipped = [];
    Array.prototype.forEach.call(files, function (f) {
      if (projectFileOk(f) && !imageFileOk(f)) projects.push(f);
      else if (imageFileOk(f)) images.push(f);
      else skipped.push(f.name || '未命名文件');
    });
    if (skipped.length) {
      setNote('已跳过不支持的文件：' + skipped.slice(0, 2).join('、') + (skipped.length > 2 ? ' 等' : ''), true);
    }
    if (projects.length) {
      if (images.length) setNote('同时拖入了工程与图片，本次优先打开工程', true);
      return openProjectFile(projects[0]);
    }
    if (!images.length) return null;

    var hasDoc = !!(app.doc && app.doc.layers.length);
    var mode = 'open';
    if (hasDoc) {
      if (opts.forcePlace) {
        mode = 'place';
      } else {
        mode = await askImportMode(images.length);
        if (!mode) return null;
      }
    }

    app.busy = true;
    var target = mode === 'place' ? app.doc : null;
    var lastPlan = null;
    try {
      for (var i = 0; i < images.length; i++) {
        var f = images[i];
        setNote('导入 ' + (i + 1) + '/' + images.length + '：' + f.name);
        var loaded = null;
        try {
          loaded = await PS.loadBitmap(f);
          if (!target) {
            target = await openBitmap(loaded, fileBase(f.name), { quiet: true });
          } else {
            var res = PS.placeImageLayer(target, loaded.bitmap, {
              name: fileBase(f.name),
              sourceW: loaded.width,
              sourceH: loaded.height,
              label: (opts.label || '置入图片') + ' · ' + fileBase(f.name)
            });
            lastPlan = res.plan;
            app.doc = target;
            refreshAll();
          }
        } catch (e) {
          setNote('「' + f.name + '」导入失败：' + ((e && e.message) || e), true);
        } finally {
          if (loaded) loaded.release();
        }
      }
    } finally {
      app.busy = false;
    }
    if (lastPlan && lastPlan.limited) {
      setNote('已置入 ' + images.length + ' 张；大图已降采样到 4800 万像素以内（控制内存）');
    } else if (images.length > 1) {
      setNote('已导入 ' + images.length + ' 张图片（第一张为文档，其余为图层）');
    }
    return target;
  }

  async function openBitmap(loaded, name, opts) {
    opts = opts || {};
    var plan = PS.planImport(loaded.width, loaded.height);
    var doc = PS.createDoc(plan.width, plan.height, name || '导入图片', { fill: false });
    var placed = PS.placeImage(doc, loaded.bitmap, {
      name: name || '导入图片',
      sourceW: loaded.width,
      sourceH: loaded.height
    });
    doc.activeId = placed.layer.id;
    app.doc = doc;
    app.view.setDoc(doc);
    refreshAll();
    PS.requestMips(doc, function () { app.view.schedule(); });
    if (!opts.quiet) {
      if (plan.limited) {
        setNote('已从 ' + loaded.width + ' × ' + loaded.height + ' 降采样到 ' + plan.width + ' × ' + plan.height + '（控制内存）');
      } else {
        setNote('已打开 ' + plan.width + ' × ' + plan.height);
      }
    }
    return doc;
  }

  /* 导出选区：按选区外接矩形裁一块，再用选区遮罩抠出形状（羽化边缘一并保留）。 */
  function selectionRegion(doc) {
    var sel = doc.selection;
    if (!sel || !sel.active) return null;
    var b = sel.invert ? { x: 0, y: 0, w: doc.width, h: doc.height } : PS.boundsOfShape(sel.shape);
    if (!b) return null;
    var pad = Math.ceil((sel.feather || 0) * 2);
    var x0 = Math.max(0, Math.floor(b.x - pad));
    var y0 = Math.max(0, Math.floor(b.y - pad));
    var x1 = Math.min(doc.width, Math.ceil(b.x + b.w + pad));
    var y1 = Math.min(doc.height, Math.ceil(b.y + b.h + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function buildExportCanvas(scope) {
    var doc = app.doc;
    if (scope === 'layer') {
      var layer = PS.activeLayer(doc);
      if (!layer) throw new Error('没有可导出的图层');
      return PS.renderLayer(layer);
    }
    var flat = PS.renderFlatten(doc);
    if (scope !== 'selection' || !doc.selection.active) return flat;
    var reg = selectionRegion(doc);
    if (!reg) throw new Error('当前选区为空');
    var cv = PS.makeCanvas(reg.w, reg.h);
    cv.ctx.drawImage(flat.canvas, reg.x, reg.y, reg.w, reg.h, 0, 0, reg.w, reg.h);
    var mask = PS.makeCanvas(reg.w, reg.h);
    PS.drawSelectionMask(mask.ctx, doc, reg.x, reg.y, reg.w, reg.h);
    cv.ctx.globalCompositeOperation = 'destination-in';
    cv.ctx.drawImage(mask.canvas, 0, 0);
    cv.ctx.globalCompositeOperation = 'source-over';
    return cv;
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 800);
  }

  /* opts: { quality 0-1, scale, scope: doc|layer|selection, bg, filename, download } */
  async function exportDoc(mime, opts) {
    opts = opts || {};
    if (!app.doc) return null;
    if (app.busy) return null;
    app.busy = true;
    setNote('正在拼合并导出…');
    try {
      var scope = opts.scope || 'doc';
      var src = buildExportCanvas(scope);
      var scale = Math.max(0.05, Math.min(8, Number(opts.scale) || 1));
      var outW = Math.max(1, Math.round(src.w * scale));
      var outH = Math.max(1, Math.round(src.h * scale));
      var target = src;
      if (scale !== 1 || mime === 'image/jpeg') {
        target = PS.makeCanvas(outW, outH);
        if (mime === 'image/jpeg') {
          target.ctx.fillStyle = opts.bg || '#ffffff';
          target.ctx.fillRect(0, 0, outW, outH);
        }
        target.ctx.imageSmoothingEnabled = true;
        target.ctx.imageSmoothingQuality = 'high';
        target.ctx.drawImage(src.canvas, 0, 0, outW, outH);
      }
      var quality = mime === 'image/png' ? undefined
        : (typeof opts.quality === 'number' ? Math.max(0.05, Math.min(1, opts.quality)) : 0.92);
      var blob = await PS.canvasBlob(target, mime, quality);
      var ext = mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '.webp';
      var name = (safeName(opts.filename || docBase()) || 'image') + ext;
      if (opts.download !== false) downloadBlob(blob, name);
      setNote('已导出 ' + name + '（' + outW + '×' + outH + ' · ' + fmtBytes(blob.size) + '）');
      return { blob: blob, name: name, w: outW, h: outH, size: blob.size, type: blob.type, mime: mime };
    } catch (e) {
      setNote('导出失败：' + ((e && e.message) || e), true);
      return null;
    } finally {
      app.busy = false;
    }
  }

  function exportDialog() {
    if (!app.doc || app.busy) return;
    var hasSel = !!app.doc.selection.active;
    modal({
      title: '导出图像',
      wide: true,
      note: 'PNG / WebP 保留透明；JPG 不支持透明，会先填充背景色。选择「选区」时按选区外接矩形裁剪。',
      fields: [
        { key: 'name', label: '文件名', type: 'text', value: docBase() },
        {
          key: 'format', label: '格式', type: 'select', value: 'png',
          options: [
            { value: 'png', label: 'PNG · 无损 / 透明' },
            { value: 'jpeg', label: 'JPG · 有损 / 体积小' },
            { value: 'webp', label: 'WebP · 高压缩 / 透明' }
          ]
        },
        { key: 'quality', label: '质量', type: 'range', min: 10, max: 100, step: 1, value: 92 },
        {
          key: 'scale', label: '缩放', type: 'select', value: '1',
          options: [
            { value: '2', label: '200%' },
            { value: '1', label: '100%' },
            { value: '0.75', label: '75%' },
            { value: '0.5', label: '50%' },
            { value: '0.25', label: '25%' }
          ]
        },
        {
          key: 'scope', label: '范围', type: 'select', value: 'doc',
          options: [
            { value: 'doc', label: '整幅图像' },
            { value: 'layer', label: '当前图层' },
            { value: 'selection', label: hasSel ? '选区' : '选区（当前无选区）' }
          ]
        },
        { key: 'bg', label: '背景色', type: 'color', value: app.bg || '#ffffff' }
      ]
    }).then(function (v) {
      if (!v) return;
      var scope = v.scope === 'selection' && !app.doc.selection.active ? 'doc' : v.scope;
      if (v.scope === 'selection' && scope !== 'selection') setNote('当前没有选区，已改为导出整幅图像', true);
      exportDoc(EXPORT_MIME[v.format] || 'image/png', {
        quality: Number(v.quality) / 100,
        scale: Number(v.scale),
        scope: scope,
        bg: v.bg,
        filename: v.name
      });
    });
  }

  async function copyImage() {
    if (!app.doc || app.busy) return null;
    app.busy = true;
    setNote('正在复制到剪贴板…');
    try {
      var flat = PS.renderFlatten(app.doc);
      var blob = await PS.canvasBlob(flat, 'image/png');
      if (!navigator.clipboard || typeof global.ClipboardItem === 'undefined') {
        throw new Error('当前环境不支持写入图片剪贴板');
      }
      await navigator.clipboard.write([new global.ClipboardItem({ 'image/png': blob })]);
      setNote('已复制图像到剪贴板');
      return blob;
    } catch (e) {
      setNote('复制失败：' + ((e && e.message) || e) + '，可改用「导出…」', true);
      return null;
    } finally {
      app.busy = false;
    }
  }

  /* 菜单里的「粘贴为图层」：主动读剪贴板需要权限，多数环境会失败，
   * 所以失败时提示用户直接用 Ctrl+V（系统粘贴事件不受这个限制）。 */
  async function pasteFromClipboard() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      setNote('当前环境不允许主动读取剪贴板，请直接按 Ctrl+V 粘贴', true);
      return null;
    }
    try {
      var items = await navigator.clipboard.read();
      for (var i = 0; i < items.length; i++) {
        var types = items[i].types || [];
        var type = null;
        for (var k = 0; k < types.length; k++) {
          if (/^image\//.test(types[k])) { type = types[k]; break; }
        }
        if (!type) continue;
        var blob = await items[i].getType(type);
        var ext = type.split('/')[1] || 'png';
        var file = new File([blob], '剪贴板图片.' + ext, { type: type });
        return importFiles([file], { forcePlace: !!app.doc, label: '粘贴图片' });
      }
      setNote('剪贴板里没有图片', true);
      return null;
    } catch (e) {
      setNote('读取剪贴板失败：' + ((e && e.message) || e) + '，请直接按 Ctrl+V', true);
      return null;
    }
  }

  /* ---------------- 工程存取 ---------------- */
  async function saveProject() {
    if (!app.doc || app.busy) return null;
    app.busy = true;
    setNote('正在打包工程（像素图层转 PNG）…');
    try {
      var payload = await PS.serializeDoc(app.doc);
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      var name = (safeName(docBase()) || '未命名') + '.ilab';
      downloadBlob(blob, name);
      setNote('已保存工程 ' + name + '（' + fmtBytes(blob.size) + '）');
      return payload;
    } catch (e) {
      setNote('保存工程失败：' + ((e && e.message) || e), true);
      return null;
    } finally {
      app.busy = false;
    }
  }

  async function openProjectFile(file) {
    if (app.busy) { setNote('正在处理上一个任务，请稍候', true); return null; }
    if (app.doc && app.doc.layers.length) {
      var yes = await modal({
        title: '打开工程会替换当前画布',
        note: '当前文档（' + app.doc.layers.length + ' 图层）尚未保存的修改会丢失，建议先「保存工程」。',
        fields: []
      });
      if (!yes) return null;
    }
    app.busy = true;
    setNote('正在读取工程 ' + (file.name || '') + ' …');
    try {
      var text = await file.text();
      var data = JSON.parse(text);
      var doc = await PS.deserializeDoc(data);
      app.doc = doc;
      app.view.setDoc(doc);
      refreshAll();
      PS.requestMips(doc, function () { app.view.schedule(); });
      setNote('已打开工程 ' + doc.name + '（' + doc.layers.length + ' 图层 · ' + doc.width + ' × ' + doc.height + '）');
      return doc;
    } catch (e) {
      setNote('打开工程失败：' + ((e && e.message) || e), true);
      return null;
    } finally {
      app.busy = false;
    }
  }

  /* ---------------- 图库 ---------------- */
  async function placeFromLibrary() {
    var desk = global.openagiDesktop;
    if (!desk || typeof desk.assetList !== 'function') {
      setNote('当前环境没有图库接口，请用「打开图片…」', true);
      return;
    }
    if (app.busy) return;
    app.busy = true;
    setNote('正在读取图库…');
    var assets = [];
    try {
      var r = await desk.assetList();
      assets = ((r && r.assets) || []).filter(function (a) { return a.kind === 'image' && !a.missing; });
    } catch (e) {
      app.busy = false;
      setNote('读取图库失败：' + ((e && e.message) || e), true);
      return;
    } finally {
      app.busy = false;
    }
    if (!assets.length) { setNote('图库里还没有图片资产', true); return; }
    assets = assets.slice(0, 120);

    var chosen = null;
    var html = '<div class="ps-lib-grid" id="psLibGrid">' + assets.map(function (a, i) {
      return '<button type="button" class="ps-lib-card" data-idx="' + i + '" title="' + esc(a.name || '') + '">' +
        '<span class="ps-lib-thumb"></span><b>' + esc(a.name || ('资产 ' + a.id)) + '</b></button>';
    }).join('') + '</div>';
    var p = modal({
      title: '从图库置入', wide: true, html: html,
      note: '点选一张图片后确定：已有文档时置入为新图层，否则新建文档打开。'
    });
    var grid = $id('psLibGrid');
    if (grid) {
      grid.addEventListener('click', function (ev) {
        var card = ev.target.closest('.ps-lib-card');
        if (!card) return;
        Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('is-on'); });
        card.classList.add('is-on');
        chosen = assets[Number(card.dataset.idx)] || null;
      });
      if (typeof desk.assetThumb === 'function') {
        assets.forEach(function (a, i) {
          var card = grid.children[i];
          if (!card) return;
          var thumb = card.querySelector('.ps-lib-thumb');
          Promise.resolve(desk.assetThumb(a.id)).then(function (t) {
            if (t && t.ok && t.dataURL) thumb.style.backgroundImage = 'url("' + t.dataURL + '")';
          }).catch(function () {});
        });
      }
    }
    var ok = await p;
    if (!ok || !chosen) return;

    app.busy = true;
    setNote('正在载入图库图片…');
    var loaded = null;
    try {
      var rr = await desk.assetRead(chosen.id);
      var dataURL = rr && (rr.dataURL || rr.data);
      if (!dataURL) throw new Error((rr && rr.message) || '读取资产失败');
      loaded = await PS.loadBitmap(dataURL);
      if (app.doc && app.doc.layers.length) {
        var res = PS.placeImageLayer(app.doc, loaded.bitmap, {
          name: fileBase(chosen.name || '图库图片'),
          sourceW: loaded.width,
          sourceH: loaded.height,
          label: '图库置入 · ' + (chosen.name || '')
        });
        app.doc.activeId = res.layer.id;
        refreshAll();
        setNote('已置入 ' + (chosen.name || '图库图片') + (res.plan.limited ? '（已降采样）' : ''));
      } else {
        await openBitmap(loaded, fileBase(chosen.name || '图库图片'));
      }
    } catch (e) {
      setNote('图库置入失败：' + ((e && e.message) || e), true);
    } finally {
      if (loaded) loaded.release();
      app.busy = false;
    }
  }

  async function saveToLibrary() {
    var desk = global.openagiDesktop;
    if (!desk || typeof desk.assetPut !== 'function') {
      setNote('当前环境没有图库接口，请用「导出…」', true);
      return null;
    }
    if (app.busy) return null;
    app.busy = true;
    setNote('正在写入图库…');
    try {
      var data = await PS.canvasDataURL(PS.renderFlatten(app.doc), 'image/png');
      var name = (safeName(docBase()) || 'image') + '.png';
      var r = await desk.assetPut({ kind: 'image', data: data, name: name, source: 'ps', ext: 'png' });
      if (!r || !r.ok) throw new Error((r && r.message) || '写入失败');
      if (typeof global.libForgetThumb === 'function') global.libForgetThumb('');
      if (typeof global.libRefresh === 'function') global.libRefresh();
      setNote('已存入图库：' + name);
      return r;
    } catch (e) {
      setNote('存入图库失败：' + ((e && e.message) || e), true);
      return null;
    } finally {
      app.busy = false;
    }
  }

  /* ---------------- 滤镜 ---------------- */
  async function runFilter(id) {
    var spec = PSFilters.specOf(id);
    if (!spec) return;
    var layer = PS.activeLayer(app.doc);
    if (!layer || layer.type !== 'pixel') { setNote('请先选中像素图层', true); return; }
    var params = {};
    if (spec.fields && spec.fields.length) {
      var v = await modal({ title: spec.name, fields: spec.fields });
      if (!v) return;
      params = v;
    }
    app.busy = true;
    setNote(spec.name + ' 处理中…');
    try {
      var res = await PSFilters.apply(app.doc, layer, id, params, {
        onProgress: function (done, total, name) {
          if (done % 6 === 0 || done === total) setNote(name + ' ' + done + '/' + total + ' 瓦片');
        }
      });
      if (!res.ok) setNote(res.reason || '滤镜失败', true);
      else setNote(res.name + ' 完成 · ' + res.tiles + ' 块瓦片');
    } catch (e) {
      setNote('滤镜失败：' + ((e && e.message) || e), true);
    } finally {
      app.busy = false;
      refreshAll();
    }
  }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    var win = $id('imgLabWin');
    if (!win || win.classList.contains('hidden')) return;
    var tag = e.target && e.target.tagName;
    if (tag && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    var mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && app.tools.penActive()) {
      e.preventDefault();
      app.tools.finishPen(false);
      refreshAll();
      return;
    }
    if (e.key === 'Escape') {
      app.tools.cancel();
      return;
    }
    var k = String(e.key || '').toLowerCase();
    if (!mod && !e.shiftKey && k === 'tab') { e.preventDefault(); toggleFocusMode(); return; }
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) PS.redo(app.doc); else PS.undo(app.doc);
      refreshAll();
      return;
    }
    if (mod && k === 'y') { e.preventDefault(); PS.redo(app.doc); refreshAll(); return; }
    if (mod && k === 'a') { e.preventDefault(); PS.selectAll(app.doc); refreshAll(); return; }
    if (mod && k === 'd') { e.preventDefault(); PS.clearSelection(app.doc); refreshAll(); return; }
    if (mod && e.shiftKey && k === 'i') { e.preventDefault(); PS.invertSelection(app.doc); refreshAll(); return; }
    if (mod && k === 'j') { e.preventDefault(); PS.duplicateLayer(app.doc, PS.activeLayer(app.doc)); refreshAll(); return; }
    if (mod && k === 'e') { e.preventDefault(); var lm = PS.activeLayer(app.doc); if (lm) PS.mergeDown(app.doc, lm); refreshAll(); return; }
    if (mod && e.shiftKey && k === 'f') { e.preventDefault(); PS.flatten(app.doc); refreshAll(); return; }
    if (mod && k === '0') { e.preventDefault(); app.view.fit(); return; }
    if (mod && k === '1') { e.preventDefault(); app.view.actual(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); app.view.setZoom(app.view.zoom * 1.35); return; }
    if (mod && k === '-') { e.preventDefault(); app.view.setZoom(app.view.zoom / 1.35); return; }
    if (mod && k === 'n') { e.preventDefault(); newDocDialog(); return; }
    if (mod && k === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && e.shiftKey && k === 'o') {
      e.preventDefault();
      app.pendingPlace = true;
      app.els.psFile.click();
      return;
    }
    if (mod && e.shiftKey && k === 'c') { e.preventDefault(); copyImage(); return; }
    if (mod && k === 'o') { e.preventDefault(); app.els.psFile.click(); return; }
    if (mod && e.shiftKey && k === 'e') { e.preventDefault(); exportDialog(); return; }
    if (mod) return;
    var map = { v: 'move', m: 'select-rect', l: 'select-lasso', w: 'magic-wand', c: 'crop', i: 'eyedropper', b: 'brush', e: 'eraser', g: 'gradient', k: 'fill', p: 'pen', u: 'shape', a: 'path-select', t: 'text' };
    if (map[k]) {
      e.preventDefault();
      selectTool(map[k]);
      return;
    }
    if (k === '[') {
      var s1 = Math.max(1, app.tools.options().size - 6);
      app.tools.setOption('size', s1);
      buildOptions();
      return;
    }
    if (k === ']') {
      var s2 = Math.min(240, app.tools.options().size + 6);
      app.tools.setOption('size', s2);
      buildOptions();
    }
  }

  /* ---------------- 打开 ---------------- */
  function open() {
    ensureUI();
    if (!app.ui) return;
    if (!app.doc) {
      app.doc = buildDemo();
      app.view.setDoc(app.doc);
    } else {
      app.view.doc = app.doc;
      app.view.resize();
      app.view.schedule();
    }
    refreshAll();
    setNote('图像工坊 · 瓦片图层 / 选区 / 滤镜 · 滚轮平移，Ctrl+滚轮缩放');
  }

  function __debug() {
    var doc = app.doc;
    var win = $id('imgLabWin');
    if (!doc) return { ready: false };
    var tiles = 0;
    var mips = 0;
    doc.layers.forEach(function (l) { tiles += l.tiles.size; mips += l.mips.length; });
    return {
      ready: true,
      visible: !!win && !win.classList.contains('hidden'),
      zoom: app.view ? app.view.zoom : 0,
      pan: app.view ? { x: app.view.panX, y: app.view.panY } : null,
      stats: app.view ? app.view.stats : null,
      doc: {
        w: doc.width, h: doc.height, name: doc.name,
        layers: doc.layers.length,
        active: doc.activeId,
        types: doc.layers.map(function (l) { return l.type; }),
        names: doc.layers.map(function (l) { return l.name; })
      },
      tiles: tiles,
      mips: mips,
      history: { index: doc.history.index, length: doc.history.entries.length, bytes: doc.history.bytes },
      selection: doc.selection.active ? {
        active: true, invert: doc.selection.invert,
        bounds: PS.boundsOfShape(doc.selection.shape)
      } : { active: false },
      cursor: app.view ? {
        on: app.view.cursorOn, inside: app.view.pointerInside,
        x: app.view.cursorDoc ? app.view.cursorDoc.docX : null,
        y: app.view.cursorDoc ? app.view.cursorDoc.docY : null,
        r: app.view.cursorRadius
      } : null,
      memory: PS.memBytes(doc),
      busy: app.busy
    };
  }

  var TEST = {
    undo: function () { var r = PS.undo(app.doc); refreshAll(); return r; },
    redo: function () { var r = PS.redo(app.doc); refreshAll(); return r; },
    selectRect: function (r) {
      PS.setSelectionShape(app.doc, { type: 'rect', bounds: r }, false);
      refreshAll();
      return true;
    },
    selectClear: function () { PS.clearSelection(app.doc); refreshAll(); return true; },
    fillAt: function (x, y, color) {
      return app.tools.fillAt(app.doc, PS.activeLayer(app.doc), x, y, color || app.fg);
    },
    brushAt: function (x, y) {
      return app.tools.paintDot(app.doc, PS.activeLayer(app.doc), x, y);
    },
    sample: function (x, y) { return PS.samplePixel(app.doc, x, y); },
    flattenSample: function (x, y) {
      var cv = PS.renderFlatten(app.doc);
      var d = cv.ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    },
    magicWand: function (x, y, opts) {
      var l = PS.activeLayer(app.doc);
      var res = PS.magicWand(app.doc, l, x, y, opts || {});
      if (res.ok) PS.setSelectionShape(app.doc, res.shape, false);
      refreshAll();
      return {
        ok: res.ok, count: res.count,
        polygons: res.shape ? res.shape.polygons.length : 0,
        type: res.shape ? res.shape.type : null,
        bounds: res.shape ? res.shape.bounds : null,
        reason: res.reason || ''
      };
    },
    selectionContains: function (x, y) { return PS.selectionContains(app.doc, x, y); },
    tool: function () { return app.tools.tool(); },
    setOption: function (key, value) { app.tools.setOption(key, value); return app.tools.options(); },
    options: function () { return app.tools.options(); },
    preview: function () {
      return {
        vector: app.view ? !!app.view.previewVector : false,
        path: app.view ? (app.view.previewPath ? app.view.previewPath.pts.length : 0) : 0
      };
    },
    addShape: function (shape, name) {
      var l = PS.addShapeLayer(app.doc, [shape], { name: name || '测试形状' });
      refreshAll();
      return l ? l.id : null;
    },
    rasterize: function () {
      var l = PS.activeLayer(app.doc);
      var ok = PS.rasterizeShapeLayer(app.doc, l);
      refreshAll();
      return ok;
    },
    hitShape: function (x, y) {
      var h = PS.hitShapeLayer(app.doc, x, y, 8);
      return h ? { id: h.layer.id, anchor: h.anchor, kind: h.shape.kind } : null;
    },
    activeLayer: function () { var l = PS.activeLayer(app.doc); return l ? { id: l.id, name: l.name, type: l.type, tiles: l.tiles.size, shapes: l.shapes ? l.shapes.length : 0, x: l.x, y: l.y } : null; },
    addAdjust: function (kind) {
      var l = PS.addAdjustLayer(app.doc, kind);
      refreshAll();
      return l ? l.id : null;
    },
    filter: async function (id, params) {
      var res = await PSFilters.apply(app.doc, PS.activeLayer(app.doc), id, params || {}, {});
      refreshAll();
      return res;
    },
    exportBlob: async function (mime, opts) {
      var res = await exportDoc(mime || 'image/png', Object.assign({ download: false }, opts || {}));
      return res ? { size: res.size, type: res.type, w: res.w, h: res.h, name: res.name } : null;
    },
    serialize: function () { return PS.serializeDoc(app.doc); },
    deserialize: async function (payload) {
      var doc = await PS.deserializeDoc(payload);
      app.doc = doc;
      app.view.setDoc(doc);
      refreshAll();
      PS.requestMips(doc, function () { app.view.schedule(); });
      return { w: doc.width, h: doc.height, layers: doc.layers.length, name: doc.name, types: doc.layers.map(function (l) { return l.type; }) };
    },
    placeDataURL: async function (url, name) {
      var loaded = await PS.loadBitmap(url);
      var res = PS.placeImageLayer(app.doc, loaded.bitmap, {
        name: name || '置入测试', sourceW: loaded.width, sourceH: loaded.height
      });
      loaded.release();
      app.doc.activeId = res.layer.id;
      refreshAll();
      return { id: res.layer.id, layers: app.doc.layers.length };
    },
    importDataURL: async function (url, name) {
      var loaded = await PS.loadBitmap(url);
      var doc = await openBitmap(loaded, name || '导入图片');
      loaded.release();
      return { w: doc.width, h: doc.height, layers: doc.layers.length };
    },
    setZoom: function (z) { app.view.setZoom(z); return app.view.stats; },
    planImport: function (w, h) { return PS.planImport(w, h); },
    historyJump: function (i) { var r = PS.historyJump(app.doc, i); refreshAll(); return r; }
  };

  global.psLab = {
    open: open,
    newDocument: newDocDialog,
    openFile: function () { app.pendingPlace = false; if (app.els.psFile) app.els.psFile.click(); },
    placeFile: function () { app.pendingPlace = true; if (app.els.psFile) app.els.psFile.click(); },
    openProject: function () { if (app.els.psProjFile) app.els.psProjFile.click(); },
    saveProject: saveProject,
    exportDialog: exportDialog,
    copyImage: copyImage,
    libraryPlace: placeFromLibrary,
    __debug: __debug,
    __test: TEST,
    PS: PS,
    PSFilters: PSFilters
  };
})(window);
