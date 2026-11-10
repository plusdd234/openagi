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
    { id: 'move', name: '移动', key: 'V', svg: '<path d="M12 3v18M3 12h18"/><path d="m9 6-3 3 3 3M15 6l3 3-3 3M9 18l-3-3 3-3M15 18l3-3-3-3"/>' },
    { id: 'select-rect', name: '矩形选区', key: 'M', svg: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 3"/>' },
    { id: 'select-ellipse', name: '椭圆选区', key: 'Shift+M', svg: '<ellipse cx="12" cy="12" rx="8" ry="6.5" stroke-dasharray="3 3"/>' },
    { id: 'select-lasso', name: '套索选区', key: 'L', svg: '<path d="M6 15c0-5 3.6-8 6-8s6 3 6 8c0 2-2 4-6 4-1.6 0-2.6-.4-3.3-1"/><path d="M9 20c-.4-.6-.6-1.4-.5-2.2"/>' },
    { id: 'crop', name: '裁剪', key: 'C', svg: '<path d="M6 3v12a3 3 0 0 0 3 3h12"/><path d="M18 21V9a3 3 0 0 0-3-3H3"/>' },
    { id: 'eyedropper', name: '吸管', key: 'I', svg: '<path d="m4 20 3-.8 9.4-9.4a2.3 2.3 0 0 0-3.2-3.2L3.8 16 3 20Z"/><path d="m13.6 6.4 2 2"/>' },
    { id: 'brush', name: '画笔', key: 'B', svg: '<path d="M14.5 4.5c1.6-1.2 4.4-1 4.9 1.4.5 2.3-1.7 3.6-3.6 4.8L9 15.5l-3-3 8.5-8Z"/><path d="m6 12.5 5.5 5.5c-.8 2.6-3 3.8-5.6 3.5-1.7-.2-2.8-1.3-2.9-3-.1-1.9.9-3.7 3-6Z"/>' },
    { id: 'eraser', name: '橡皮擦', key: 'E', svg: '<path d="m8.5 5.5 10 10-4 4H7.5l-3-3a2 2 0 0 1 0-2.8l4-8.2Z"/><path d="m8 10 6.5 6.5"/>' },
    { id: 'gradient', name: '渐变', key: 'G', svg: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 15h16M4 12h16" opacity=".45"/><path d="M4 9h16" opacity=".75"/>' },
    { id: 'fill', name: '油漆桶', key: 'K', svg: '<path d="m5 11 6-6 7 7-5 5a2 2 0 0 1-2.8 0L5 11.8A1.4 1.4 0 0 1 5 11Z"/><path d="m9 5 1.5-1.5"/><path d="M19 15s2 2.3 2 3.4a2 2 0 0 1-4 0c0-1.1 2-3.4 2-3.4Z"/>' },
    { id: 'text', name: '文字', key: 'T', svg: '<path d="M5 5h14M12 5v14M8 19h8"/>' }
  ];

  /* 参考图里工具箱还有一排本版本没实现的工具。它们只是**占位控件**：
   * 外形、位置、悬停态都照 PS 摆好，点一下只会在状态栏说明「未实现」，
   * 不会把当前工具切走。这样界面完整度接近参考图，又不会骗用户。 */
  var PH_TOOLS = [
    { name: '仿制图章', svg: '<path d="M12 3v6"/><rect x="8" y="9" width="8" height="5" rx="1"/><path d="M10 14v3h4v-3"/><path d="M6 21h12"/>' },
    { name: '模糊 / 锐化', svg: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z"/><path d="M9 15h6"/>' },
    { name: '减淡 / 加深', svg: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>' },
    { name: '钢笔', svg: '<path d="m12 3 7 7-9 10H4v-6l8-11Z"/><path d="m7 14 4 4"/>' },
    { name: '路径选择', svg: '<path d="m6 3 13 8.5-5.6 1.7-2 5.8L6 3Z"/>' },
    { name: '形状', svg: '<rect x="4" y="10" width="10" height="10" rx="1"/><path d="M14 10a5 5 0 1 0-5-5"/>' },
    { name: '抓手', svg: '<path d="M8 12V7a1.5 1.5 0 0 1 3 0V5.5a1.5 1.5 0 0 1 3 0V7a1.5 1.5 0 0 1 3 0v6.5c0 3.7-2.4 6.5-6 6.5-2.8 0-4.2-1.6-5.2-3.8L5 14"/>' },
    { name: '缩放', svg: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5M8 10.5h5M10.5 8v5"/>' }
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
      { sep: true },
      { label: '导出 PNG', hint: 'Ctrl+Shift+E', act: 'export:png' },
      { label: '导出 JPG', act: 'export:jpeg' },
      { label: '导出 WebP', act: 'export:webp' },
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
    noteTimer: 0,
    navAt: 0,
    navComp: null,
    navScratch: null,
    menuPop: null,
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

  /* ---------------- 界面装配 ---------------- */
  function ensureUI() {
    if (app.ui) return;
    var host = $id('psHost');
    if (!host) return;

    host.innerHTML =
      '<div class="ps-app" id="psApp">' +
        '<div class="ps-menubar" id="psMenuBar">' +
          '<div class="ps-menus" id="psMenus"></div>' +
          '<div class="ps-doc-title" id="psDocTitle">图像工坊</div>' +
          '<div class="ps-menubar-right"><span class="ps-engine-dot"></span>本地 · 瓦片渲染</div>' +
        '</div>' +
        '<div class="ps-body">' +
          '<aside class="ps-toolbar" id="psToolbar">' +
            '<div class="ps-tools" id="psTools"></div>' +
            '<div class="ps-tool-sep"></div>' +
            '<div class="ps-tools ps-tools-ph" id="psPhTools"></div>' +
            '<div class="ps-colorbox">' +
              '<label class="ps-swatch ps-swatch-fg" title="前景色"><input type="color" id="psFg" value="#000000"></label>' +
              '<label class="ps-swatch ps-swatch-bg" title="背景色"><input type="color" id="psBg" value="#ffffff"></label>' +
              '<button type="button" class="ps-swap" id="psSwap" title="交换前景 / 背景">⇄</button>' +
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
          '<aside class="ps-side">' +
            '<div class="ps-rail" id="psRail"></div>' +
            '<div class="ps-panels">' +
              '<section class="ps-card ps-history" id="psHistCard">' +
                '<div class="ps-tabs" id="psHistTabs">' +
                  '<button type="button" class="ps-tab is-on" data-htab="history">历史记录</button>' +
                  '<button type="button" class="ps-tab" data-htab="swatch">色板</button>' +
                  '<span class="ps-tab-n" id="psHistCount">0</span>' +
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
              '<section class="ps-card ps-info">' +
                '<div class="ps-card-h"><span>导航器</span></div>' +
                '<div class="ps-nav"><canvas id="psNavCanvas" width="248" height="148"></canvas></div>' +
                '<div class="ps-info-list" id="psInfo"></div>' +
              '</section>' +
            '</div>' +
          '</aside>' +
        '</div>' +
        '<div class="ps-statusbar">' +
          '<span class="ps-stat" id="psStatZoom">100%</span>' +
          '<span class="ps-stat" id="psStatSize">—</span>' +
          '<span class="ps-stat" id="psStatTiles">0 瓦片</span>' +
          '<span class="ps-stat" id="psStatFps">— FPS</span>' +
          '<span class="ps-stat" id="psStatMem">0 MB</span>' +
          '<span class="ps-status-note" id="psNote"></span>' +
          '<span class="ps-status-icons" id="psStatusIcons"></span>' +
        '</div>' +
      '</div>' +
      '<input type="file" id="psFile" accept="image/*" hidden>';

    app.host = $id('psApp');
    var e = app.els;
    ['psMenus', 'psDocTitle', 'psTools', 'psPhTools', 'psOptions', 'psOptPh', 'psStageHost', 'psLayerProps',
      'psLayerList', 'psLayerCount', 'psHistList', 'psHistCount', 'psInfo', 'psNavCanvas',
      'psStatZoom', 'psStatSize', 'psStatTiles', 'psStatFps', 'psStatMem', 'psNote',
      'psFg', 'psBg', 'psSwap', 'psFile', 'psRail', 'psSwatches', 'psStatusIcons',
      'psDocTabName', 'psLayersCard'].forEach(function (id) { e[id] = $id(id); });

    app.view = new PSView(e.psStageHost, { onStats: onStats });
    app.tools = PSTools.create(app.view, {
      doc: function () { return app.doc; },
      layer: function () { return app.doc ? PS.activeLayer(app.doc) : null; },
      colors: function () { return { fg: app.fg, bg: app.bg }; },
      status: setNote,
      change: function () { refreshAll(); },
      onColor: function (hex) {
        app.fg = hex;
        if (e.psFg) e.psFg.value = hex;
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
    app.ui = true;
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
      b.title = t.name + (t.key ? '（' + t.key + '）' : '');
      b.innerHTML = ico(t.svg);
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
      b.innerHTML = ico(t.svg);
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
        if (app.els.psFg) app.els.psFg.value = col;
        setNote('前景色已设为 ' + col.toUpperCase());
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


  function buildOptions() {
    var wrap = app.els.psOptions;
    var tool = app.tools.tool();
    var o = app.tools.options();
    var def = TOOLS.find(function (t) { return t.id === tool; }) || { name: '' };
    var html = '<div class="ps-opt-tool">' + esc(def.name) + '</div>';
    if (tool === 'brush' || tool === 'eraser') {
      html +=
        optRange('size', '大小', 1, 240, 1, o.size, 'px') +
        (tool === 'brush' ? optRange('hardness', '硬度', 0, 100, 1, o.hardness, '%') : '') +
        optRange('opacity', '不透明度', 5, 100, 1, o.opacity, '%') +
        '<div class="ps-opt-hint">按住 Shift 可沿直线；收笔时自动裁切到选区</div>';
    } else if (tool === 'fill') {
      html += optRange('tolerance', '容差', 0, 255, 1, o.tolerance, '') +
        '<div class="ps-opt-hint">点击填充 · 受选区限制</div>';
    } else if (tool === 'gradient') {
      html += '<label class="ps-opt-field"><span>类型</span><select data-opt="gradient">' +
        '<option value="fg2transparent"' + (o.gradient === 'fg2transparent' ? ' selected' : '') + '>前景色 → 透明</option>' +
        '<option value="fg2bg"' + (o.gradient === 'fg2bg' ? ' selected' : '') + '>前景色 → 背景色</option>' +
        '</select></label>';
    } else if (tool === 'move') {
      // 参考图里移动工具选项栏的样子：几个勾选 + 一个下拉，全部是占位控件，
      // 但勾选框本身可以点，视觉上是「真的」。
      html +=
        '<label class="ps-opt-check"><input type="checkbox" checked><span>自动选择</span></label>' +
        '<label class="ps-opt-check"><select title="自动选择的目标（占位控件）"><option>图层</option><option>组</option></select></label>' +
        '<label class="ps-opt-check"><input type="checkbox"><span>显示变换控件</span></label>' +
        '<label class="ps-opt-check"><input type="checkbox"><span>距离</span></label>' +
        '<div class="ps-opt-hint">拖动图层 · 滚轮平移 · Ctrl+滚轮缩放</div>';
    } else if (tool === 'crop') {
      html += '<div class="ps-opt-hint">拖出裁剪框，松手即生效（可撤销）</div>';
    } else if (tool === 'eyedropper') {
      html += '<div class="ps-opt-hint">点击画布取色，自动写入前景色</div>';
    } else if (tool === 'text') {
      html += '<div class="ps-opt-hint">点击画布放置文字基线</div>';
    } else {
      html += '<div class="ps-opt-hint">拖拽创建选区 · 选区外自动保护</div>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-opt]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var key = inp.dataset.opt;
        var val = key === 'gradient' ? inp.value : Number(inp.value);
        app.tools.setOption(key, val);
        var out = inp.parentNode.querySelector('b');
        if (out && key !== 'gradient') out.textContent = val + (inp.dataset.unit || '');
        if (key === 'size' && app.view.cursorOn && app.view.cursorDoc) {
          app.view.setCursor(app.view.cursorDoc.docX, app.view.cursorDoc.docY, val / 2);
        }
      });
      if (inp.type === 'range') inp.addEventListener('input', function () {
        var out = inp.parentNode.querySelector('b');
        if (out) out.textContent = inp.value + (inp.dataset.unit || '');
      });
    });
  }

  function optRange(key, label, min, max, step, value, unit) {
    return '<label class="ps-opt-field"><span>' + esc(label) + '</span>' +
      '<input type="range" data-opt="' + key + '" data-unit="' + esc(unit || '') + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '">' +
      '<b>' + value + esc(unit || '') + '</b></label>';
  }

  function bindEvents() {
    var e = app.els;
    var closeBtn = $id('btnImgLabClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (typeof global.deskCloseWin === 'function') global.deskCloseWin($id('imgLabWin'));
      });
    }
    e.psFg.addEventListener('input', function () { app.fg = e.psFg.value; });
    e.psBg.addEventListener('input', function () { app.bg = e.psBg.value; });
    e.psSwap.addEventListener('click', function () {
      var t = app.fg;
      app.fg = app.bg;
      app.bg = t;
      e.psFg.value = app.fg;
      e.psBg.value = app.bg;
    });

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
    e.psLayerList.addEventListener('dblclick', function (ev) {
      var row = ev.target.closest('.ps-lay');
      if (!row || !app.doc) return;
      var layer = PS.layerById(app.doc, row.dataset.id);
      if (!layer) return;
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
    });
    e.psHistList.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-idx]');
      if (!b || !app.doc) return;
      PS.historyJump(app.doc, Number(b.dataset.idx));
      refreshAll();
    });
    e.psFile.addEventListener('change', function () {
      var f = e.psFile.files && e.psFile.files[0];
      if (f) importFile(f);
      e.psFile.value = '';
    });

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
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) importFile(f);
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
    if (e.psStatTiles) e.psStatTiles.textContent = stats.tiles + ' 瓦片' + (stats.mips ? ' · ' + stats.mips + ' mip' : '');
    if (e.psStatFps) e.psStatFps.textContent = stats.fps + ' FPS';
    if (e.psStatSize) e.psStatSize.textContent = app.doc.width + ' × ' + app.doc.height;
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
      rows += '<div class="ps-lay' + (active ? ' is-on' : '') + (layer.visible ? '' : ' is-off') + '" data-id="' + esc(layer.id) + '">' +
        '<button type="button" class="ps-eye" data-vis="1" title="显示 / 隐藏">' + (layer.visible ? '◉' : '○') + '</button>' +
        '<canvas class="ps-lay-thumb" width="34" height="34"></canvas>' +
        '<div class="ps-lay-meta"><div class="ps-lay-name">' + esc(layer.name) + '</div>' +
        '<div class="ps-lay-kind">' + (layer.type === 'adjust' ? '调整 · ' + esc(PS.ADJUST_DEFS[layer.adjust.kind].name) : '像素 · ' + Math.round(layer.opacity * 100) + '%') + '</div></div>' +
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
    ctx.fillStyle = '#141519';
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
    ctx.strokeStyle = '#e8a13a';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      panX + vx0 * s + 0.5,
      panY + vy0 * s + 0.5,
      Math.max(2, (vx1 - vx0) * s),
      Math.max(2, (vy1 - vy0) * s)
    );
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.strokeRect(panX + 0.5, panY + 0.5, doc.width * s, doc.height * s);
  }

  /* ---------------- 动作 ---------------- */
  function doAction(act) {
    if (!app.doc && act !== 'new' && act !== 'open' && act !== 'about' && act !== 'shortcuts') return;
    var doc = app.doc;
    if (act === 'new') return newDocDialog();
    if (act === 'open') { app.els.psFile.click(); return; }
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
    if (act === 'export:png') return exportDoc('image/png');
    if (act === 'export:jpeg') return exportDoc('image/jpeg');
    if (act === 'export:webp') return exportDoc('image/webp');
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
      wrap.innerHTML = '<div class="ps-modal">' +
        '<div class="ps-modal-h">' + esc(cfg.title || '') + '</div>' +
        '<div class="ps-modal-b"></div>' +
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
      '导入上限：' + (PS.MAX_IMPORT_PIXELS / 1e6) + ' 百万像素 / 单边 ' + PS.MAX_IMPORT_DIM + ' px（超出自动降采样）'
    ];
    modal({ title: '图像信息', html: '<div class="ps-info-modal">' + rows.map(function (r) { return '<div>' + esc(r) + '</div>'; }).join('') + '</div>' });
  }

  function showShortcuts() {
    var html = '<div class="ps-info-modal">' +
      '<div><b>工具</b> V 移动 · M 矩形选区 · L 套索 · C 裁剪 · I 吸管 · B 画笔 · E 橡皮 · G 渐变 · K 油漆桶 · T 文字</div>' +
      '<div><b>编辑</b> Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+A 全选 · Ctrl+D 取消选区 · Ctrl+Shift+I 反选</div>' +
      '<div><b>图层</b> Ctrl+J 复制 · Ctrl+E 向下合并 · Ctrl+Shift+F 拼合</div>' +
      '<div><b>视图</b> Ctrl+0 适应 · Ctrl+1 实际像素 · Ctrl+= / - 缩放 · 空格拖拽平移 · Ctrl+滚轮缩放</div>' +
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
  async function importFile(file) {
    if (app.busy) return;
    app.busy = true;
    setNote('正在解码 ' + file.name + ' …');
    try {
      var loaded = await PS.loadBitmap(file);
      await openBitmap(loaded, file.name);
      loaded.release();
    } catch (e) {
      setNote('导入失败：' + ((e && e.message) || e), true);
    } finally {
      app.busy = false;
    }
  }

  async function openBitmap(loaded, name) {
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
    if (plan.limited) {
      setNote('已从 ' + loaded.width + ' × ' + loaded.height + ' 降采样到 ' + plan.width + ' × ' + plan.height + '（控制内存）');
    } else {
      setNote('已打开 ' + plan.width + ' × ' + plan.height);
    }
    return doc;
  }

  async function exportDoc(mime) {
    if (!app.doc) return null;
    if (app.busy) return null;
    app.busy = true;
    setNote('正在拼合并导出…');
    try {
      var flat = PS.renderFlatten(app.doc);
      var blob = await PS.canvasBlob(flat, mime, mime === 'image/jpeg' ? 0.92 : undefined);
      var ext = mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '.webp';
      var name = (app.doc.name || 'image').replace(/[\\/:*?"<>|]+/g, '_') + ext;
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 800);
      setNote('已导出 ' + name + '（' + fmtBytes(blob.size) + '）');
      return blob;
    } catch (e) {
      setNote('导出失败：' + ((e && e.message) || e), true);
      return null;
    } finally {
      app.busy = false;
    }
  }

  async function saveToLibrary() {
    var desk = global.openagiDesktop;
    if (!desk || typeof desk.assetPut !== 'function') {
      setNote('当前环境没有图库接口，请用「导出 PNG」', true);
      return null;
    }
    if (app.busy) return null;
    app.busy = true;
    setNote('正在写入图库…');
    try {
      var data = await PS.canvasDataURL(PS.renderFlatten(app.doc), 'image/png');
      var name = (app.doc.name || 'image').replace(/[\\/:*?"<>|]+/g, '_') + '.png';
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
    var k = String(e.key || '').toLowerCase();
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
    if (mod && k === 'o') { e.preventDefault(); app.els.psFile.click(); return; }
    if (mod && e.shiftKey && k === 'e') { e.preventDefault(); exportDoc('image/png'); return; }
    if (mod) return;
    var map = { v: 'move', m: 'select-rect', l: 'select-lasso', c: 'crop', i: 'eyedropper', b: 'brush', e: 'eraser', g: 'gradient', k: 'fill', t: 'text' };
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
    activeLayer: function () { var l = PS.activeLayer(app.doc); return l ? { id: l.id, name: l.name, type: l.type, tiles: l.tiles.size } : null; },
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
    exportBlob: async function (mime) {
      var flat = PS.renderFlatten(app.doc);
      var blob = await PS.canvasBlob(flat, mime || 'image/png');
      return { size: blob.size, type: blob.type, w: flat.w, h: flat.h };
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
    openFile: function () { if (app.els.psFile) app.els.psFile.click(); },
    __debug: __debug,
    __test: TEST,
    PS: PS,
    PSFilters: PSFilters
  };
})(window);
