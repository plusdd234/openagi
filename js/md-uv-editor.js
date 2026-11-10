/* 建模 App · UV 编辑器（从 model-desk.js 抽出的独立模块，约 1.5k 行）
 *
 * 为什么要有这个文件：UV 窗口的绘制、拾取、变换、命令全是一套自洽的东西，
 * 但它当时长在外壳里，让 model-desk.js 变成了 8 千行的单文件。
 * 这里只搬位置、不改逻辑：模块通过 ctx 拿到 st 和外壳动作，
 * 外部调用点仍是 openUVEditor / closeUVEditor / uvCommand / uvRefresh / uvToast。
 *
 * 加载顺序：先于 js/model-desk.js。别在别的文件里重复定义这些 uv* 函数。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, $ = ctx.$;
    var esc = ctx.esc, SeedModel = ctx.SeedModel;
    var setStatus = ctx.setStatus, updateChrome = ctx.updateChrome, updateHud = ctx.updateHud;
    var undo = ctx.undo, redo = ctx.redo, snap = ctx.snap, pushHistory = ctx.pushHistory;
    var paintAll = ctx.paintAll, paintSelection = ctx.paintSelection, applyShading = ctx.applyShading;
    var syncSelectionDoc = ctx.syncSelectionDoc, islandFacesOf = ctx.islandFacesOf;

    var UV_SNAP = 0.1;          /* 网格吸附步长（与画布 0.1 网格一致） */
    var UV_ROT_SNAP = 15;       /* 旋转吸附角度 */
    var UV_SCALE_SNAP = 0.05;   /* 缩放的吸附步长 */

    var UV_ICONS = {
      point: '<svg viewBox="0 0 18 18" fill="none"><rect x="6" y="6" width="6" height="6" fill="currentColor"/>' +
        '<path d="M9 1.6v3.8M9 12.6v3.8M1.6 9h3.8M12.6 9h3.8" stroke="currentColor" stroke-width="1"/></svg>',
      edge: '<svg viewBox="0 0 18 18" fill="none"><path d="M4 14 14 4" stroke="currentColor" stroke-width="1.5"/>' +
        '<rect x="2.2" y="12.2" width="3.6" height="3.6" fill="currentColor"/>' +
        '<rect x="12.2" y="2.2" width="3.6" height="3.6" fill="currentColor"/></svg>',
      shell: '<svg viewBox="0 0 18 18" fill="none"><path d="M4.2 5.4 9 3l4.8 2.4v6.6L9 15l-4.8-3z" stroke="currentColor" stroke-width="1.1"/>' +
        '<path d="M4.2 5.4 9 8l4.8-2.6M9 8V15" stroke="currentColor" stroke-width=".8" opacity=".75"/></svg>',
      move: '<svg viewBox="0 0 18 18" fill="none"><path d="M9 2.4v13.2M2.4 9h13.2" stroke="currentColor" stroke-width="1.2"/>' +
        '<path d="m6.8 4.6 2.2-2.2 2.2 2.2M6.8 13.4l2.2 2.2 2.2-2.2M4.6 6.8 2.4 9l2.2 2.2M13.4 6.8 15.6 9l-2.2 2.2" stroke="currentColor" stroke-width="1"/></svg>',
      rotate: '<svg viewBox="0 0 18 18" fill="none"><path d="M15 9a6 6 0 1 1-2.4-4.8" stroke="currentColor" stroke-width="1.2"/>' +
        '<path d="M15.2 2.4v4h-4" stroke="currentColor" stroke-width="1.1"/></svg>',
      scale: '<svg viewBox="0 0 18 18" fill="none"><rect x="3" y="3" width="12" height="12" stroke="currentColor" stroke-width=".9" stroke-dasharray="2 1.6"/>' +
        '<rect x="3" y="10.4" width="4.6" height="4.6" fill="currentColor"/>' +
        '<path d="m10 8 5-5M15 3h-3.4M15 3v3.4" stroke="currentColor" stroke-width="1"/></svg>'
    };

    /* 菜单只放**已经能用**的命令；截图里有、还没做的项标 todo，点一下只在状态行说明计划编号。
     * 这样「分析截图 UI」和「不撒谎」两件事能同时成立。 */
    var UV_MENUS = [
      { k: '编辑', items: [
        { t: '撤销', c: 'undo', s: 'Ctrl+Z' }, { t: '重做', c: 'redo', s: 'Ctrl+Y' }, { sep: 1 },
        { t: '全选 UV', c: 'selAll', s: 'Ctrl+A' }, { t: '清除选择', c: 'selNone' }, { t: '反向选择', c: 'selInvert' }
      ] },
      { k: '创建', items: [
        { t: '平面投影（XZ）', c: 'projXZ' }, { t: '平面投影（XY）', c: 'projXY' }, { t: '平面投影（ZY）', c: 'projZY' },
        { t: '圆柱投影（绕 Y）', c: 'projCyl' }, { t: '球形投影（绕 Y）', c: 'projSphere' },
        { t: '盒式投影', c: 'projBox' }, { sep: 1 }, { t: '自动展开', c: 'unwrap' }
      ] },
      { k: '选择', items: [
        { t: '点模式', c: 'modePoint', s: '1' }, { t: '边模式', c: 'modeEdge', s: '2' }, { t: '壳模式', c: 'modeShell', s: '3' },
        { sep: 1 }, { t: '全选', c: 'selAll' }, { t: '清除选择', c: 'selNone' }, { t: '反向选择', c: 'selInvert' },
        { t: '扩选到整个壳', c: 'growShell' }
      ] },
      { k: '切割/缝合', items: [
        { t: '沿边切割', c: 'seamCut' }, { t: '缝合 UV', c: 'stitch' }, { t: '分离 UV 壳', c: 'sepShells' }
      ] },
      { k: '修改', items: [
        { t: '对齐 U 最小', c: 'alignU0' }, { t: '对齐 U 中心', c: 'alignUC' }, { t: '对齐 U 最大', c: 'alignU1' },
        { t: '对齐 V 最小', c: 'alignV0' }, { t: '对齐 V 中心', c: 'alignVC' }, { t: '对齐 V 最大', c: 'alignV1' },
        { sep: 1 }, { t: '反转 U', c: 'flipU' }, { t: '反转 V', c: 'flipV' }, { t: '旋转 90°', c: 'rot90' },
        { t: '统一尺寸', c: 'normalize' }, { t: '排布 UV', c: 'pack' }
      ] },
      { k: '工具', items: [
        { t: '移动 UV', c: 'tmMove', s: 'W' }, { t: '旋转 UV', c: 'tmRotate', s: 'E' }, { t: '缩放 UV', c: 'tmScale', s: 'R' },
        { sep: 1 }, { t: '网格吸附 0.1', c: 'snap' }
      ] },
      { k: '视图', items: [
        { t: '适应视图', c: 'fit', s: 'F' }, { t: '放大', c: 'zoomIn' }, { t: '缩小', c: 'zoomOut' },
        { sep: 1 }, { t: '显示网格', c: 'grid' }, { t: '显示标尺', c: 'ruler' }
      ] },
      { k: '图像', items: [
        { t: '载入图片', c: 'imgLoad' }, { t: '清除图片', c: 'imgClear' }, { sep: 1 },
        { t: '棋盘格底图', c: 'checkerToggle' }
      ] },
      { k: '纹理', items: [
        { t: '模型贴图', c: 'mapTex' }, { t: '棋盘格底图', c: 'checkerToggle' },
        { sep: 1 }, { t: '刷新画布', c: 'refresh' }
      ] },
      { k: 'UV 集', items: [
        { t: '默认 UV 集', c: 'uvsetNone' }, { t: '新建 UV 集（待做）', todo: 'X5g' }
      ] },
      { k: '帮助', items: [{ t: '快捷键与操作说明', c: 'help' }] }
    ];

    function uvWin() { return $('mdUvWin'); }

    /* 画布内的轻提示：2.2 秒淡出。所有命令 / 未实现项 / 空点选择都走这里，
     * 避免「点了没反应」的错觉。 */
    var uvToastTimer = 0;
    function uvToast(text, isErr) {
      var el = $('mdUvToast');
      if (!el) return;
      clearTimeout(uvToastTimer);
      if (!text) { el.classList.remove('on'); return; }
      el.textContent = text;
      el.classList.toggle('err', !!isErr);
      el.classList.add('on');
      uvToastTimer = setTimeout(function () {
        var now = $('mdUvToast');
        if (now) now.classList.remove('on');
      }, 2200);
    }
    function uvMeshReady() {
      if (!st.mesh || !st.doc) return false;
      if (global.SeedUV) global.SeedUV.ensure(st.mesh);
      return true;
    }

    /* ---------- 窗口 DOM ---------- */
    function uvModeBtn(mode, label) {
      var cmd = 'mode' + mode.charAt(0).toUpperCase() + mode.slice(1);
      return '<button type="button" class="md-uv-tbtn" data-uvact="' + cmd + '" title="' + label + '模式">' +
        UV_ICONS[mode] + '<span>' + label + '</span></button>';
    }

    function uvKitGroup(key, title, body, open) {
      return '<div class="md-uvk-grp' + (open ? ' open' : '') + '" data-uvgrp="' + key + '">' +
        '<button type="button" class="md-uvk-gt" data-uvsec="' + key + '"><i>▸</i><span>' + title + '</span></button>' +
        '<div class="md-uvk-gb">' + body + '</div></div>';
    }

    function uvKitHtml() {
      var selBtns = uvModeBtn('point', '点') + uvModeBtn('edge', '边') + uvModeBtn('shell', '壳');
      return [
        '<div class="md-uvk-head"><b>UV 工具包</b><button type="button" class="md-uvk-help" data-uvact="help" title="操作说明">帮助</button></div>',
        '<div class="md-uvk-sec">',
        '  <div class="md-uvk-title">选择</div>',
        '  <div class="md-uvk-grid">' + selBtns + '</div>',
        '  <div class="md-uvk-row"><span>拾取</span><b>点 / 边 / 壳</b></div>',
        '  <div class="md-uvk-row"><span>框选</span><b>空白处拖矩形</b></div>',
        '  <div class="md-uvk-row"><span>对象</span><b class="off">禁用</b></div>',
        '  <div class="md-uvk-row"><span>选择约束</span><b class="off">禁用</b></div>',
        '  <div class="md-uvk-acts">',
        '    <button type="button" data-uvact="selAll">全部</button>',
        '    <button type="button" data-uvact="selNone">清除</button>',
        '    <button type="button" data-uvact="selInvert">反向选择</button>',
        '  </div>',
        '</div>',
        uvKitGroup('pin', '固定', '<div class="md-uvk-note">固定 / 释放 UV（计划 X5g）</div>', false),
        uvKitGroup('type', '按类型选择', '<div class="md-uvk-note">按面 / 边 / 壳类型过滤（计划 X5g）</div>', false),
        uvKitGroup('soft', '软选择', '<div class="md-uvk-note">UV 软选择衰减（计划 X5g）</div>', false),
        uvKitGroup('transform', '变换', [
          '<div class="md-uvk-grid">' +
          '<button type="button" class="md-uv-tbtn" data-uvact="tmMove">' + UV_ICONS.move + '<span>移动</span></button>' +
          '<button type="button" class="md-uv-tbtn" data-uvact="tmRotate">' + UV_ICONS.rotate + '<span>旋转</span></button>' +
          '<button type="button" class="md-uv-tbtn" data-uvact="tmScale">' + UV_ICONS.scale + '<span>缩放</span></button>' +
          '</div>',
          '<div class="md-uvk-acts">',
          '<button type="button" data-uvact="flipU">反转 U</button>',
          '<button type="button" data-uvact="flipV">反转 V</button>',
          '<button type="button" data-uvact="rot90">旋转 90°</button>',
          '</div>'
        ].join(''), true),
        uvKitGroup('create', '创建', [
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="projXZ">平面 XZ</button>',
          '<button type="button" data-uvact="projXY">平面 XY</button>',
          '<button type="button" data-uvact="projZY">平面 ZY</button>',
          '</div>',
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="projCyl">圆柱</button>',
          '<button type="button" data-uvact="projSphere">球形</button>',
          '<button type="button" data-uvact="projBox">盒式</button>',
          '</div>'
        ].join(''), false),
        uvKitGroup('seam', '切割和缝合', [
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="seamCut">沿边切割</button>',
          '<button type="button" data-uvact="stitch">缝合 UV</button>',
          '</div>',
          '<div class="md-uvk-acts"><button type="button" data-uvact="sepShells">分离 UV 壳</button></div>',
          '<div class="md-uvk-row"><span>缝合容差</span><b>2%</b></div>'
        ].join(''), false),
        uvKitGroup('unwrap', '展开', [
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="unwrap">自动展开</button>',
          '<button type="button" data-uvact="projBox">盒式投影</button>',
          '</div>',
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="projXZ">平面 XZ</button>',
          '<button type="button" data-uvact="projXY">平面 XY</button>',
          '<button type="button" data-uvact="projZY">平面 ZY</button>',
          '</div>'
        ].join(''), true),
        uvKitGroup('align', '对齐和捕捉', [
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="alignU0">U 最小</button>',
          '<button type="button" data-uvact="alignUC">U 中心</button>',
          '<button type="button" data-uvact="alignU1">U 最大</button>',
          '</div>',
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="alignV0">V 最小</button>',
          '<button type="button" data-uvact="alignVC">V 中心</button>',
          '<button type="button" data-uvact="alignV1">V 最大</button>',
          '</div>',
          '<div class="md-uvk-acts"><button type="button" data-uvact="snap">网格吸附</button></div>'
        ].join(''), true),
        uvKitGroup('layout', '排列和布局', [
          '<div class="md-uvk-acts wide">',
          '<button type="button" data-uvact="pack">排布 UV</button>',
          '<button type="button" data-uvact="normalize">统一尺寸</button>',
          '</div>',
          '<div class="md-uvk-row"><span>装箱间距</span><b>2%</b></div>'
        ].join(''), true)
      ].join('');
    }

    function uvWindowHtml() {
      var menus = UV_MENUS.map(function (m) {
        return '<button type="button" class="md-uv-mitem" data-uvmenuopen="' + m.k + '">' + m.k + '</button>';
      }).join('');
      return [
        '<div class="md-uv-head" data-uvdrag="win">',
        '  <b>UV 编辑器</b><span class="md-uv-target" id="mdUvTarget"></span>',
        '  <span class="md-uv-headbtns">',
        '    <button type="button" class="md-uv-hbtn" data-uvact="fit" title="适应视图（F）">适应</button>',
        '    <button type="button" class="md-uv-hbtn" data-uvact="close" title="关闭">×</button>',
        '  </span>',
        '</div>',
        '<div class="md-uv-menubar" id="mdUvMenu">' + menus + '</div>',
        '<div class="md-uv-drop" id="mdUvDrop" hidden></div>',
        '<div class="md-uv-tools">',
        '  <div class="md-uv-tgrp">' + uvModeBtn('point', '点') + uvModeBtn('edge', '边') + uvModeBtn('shell', '壳') + '</div>',
        '  <span class="md-uv-tsep"></span>',
        '  <div class="md-uv-tgrp">',
        '    <button type="button" class="md-uv-tbtn" data-uvact="tmMove" title="移动（W）">' + UV_ICONS.move + '</button>',
        '    <button type="button" class="md-uv-tbtn" data-uvact="tmRotate" title="旋转（E）">' + UV_ICONS.rotate + '</button>',
        '    <button type="button" class="md-uv-tbtn" data-uvact="tmScale" title="缩放（R）">' + UV_ICONS.scale + '</button>',
        '  </div>',
        '  <span class="md-uv-tsep"></span>',
        '  <div class="md-uv-tgrp">',
        '    <button type="button" class="md-uv-tbtn txt" data-uvact="grid" title="显示 / 隐藏网格">网格</button>',
        '    <button type="button" class="md-uv-tbtn txt" data-uvact="ruler" title="显示 / 隐藏标尺">标尺</button>',
        '    <button type="button" class="md-uv-tbtn txt" data-uvact="snap" title="拖动时吸附到 0.1 网格">吸附</button>',
        '  </div>',
        '  <span class="md-uv-tsep"></span>',
        '  <button type="button" class="md-uv-tbtn txt" data-uvact="fit" title="适应视图（F）">适应</button>',
        '  <button type="button" class="md-uv-tbtn txt" data-uvact="zoomOut" title="缩小">−</button>',
        '  <button type="button" class="md-uv-tbtn txt" data-uvact="zoomIn" title="放大">+</button>',
        '  <span class="md-uv-tread" id="mdUvRead"></span>',
        '  <button type="button" class="md-uv-tex" id="mdUvTex" data-uvact="texToggle" title="切换棋盘格底图">无纹理</button>',
        '</div>',
        '<div class="md-uv-body">',
        '  <div class="md-uv-cvwrap"><canvas id="mdUvCanvas"></canvas>' +
          '<div class="md-uv-toast" id="mdUvToast"></div><div class="md-uv-hint" id="mdUvHint"></div></div>',
        '  <aside class="md-uv-kit" id="mdUvKit">' + uvKitHtml() + '</aside>',
        '</div>',
        '<input type="file" id="mdUvFile" accept="image/*" hidden>',
        '<i class="md-uv-rs" data-uvresize="br" title="拖动调整窗口大小"></i>'
      ].join('');
    }

    function openUVEditor() {
      if (!st.doc || !st.mesh) { setStatus('UV 编辑器：先新建或打开一个模型', true); return false; }
      /* 修改器生效时 st.mesh 是求值网格（缓存共享），UV 命令会原地改 uvs 写坏它。
       * 要么先应用修改器，要么删掉修改器；不做「偷偷把求值结果当 base」。 */
      if (ctx.nodeModsActive && ctx.nodeModsActive(st.node)) {
        setStatus('UV 编辑器：该对象有修改器，先「应用修改器」或删掉修改器，再编辑 UV', true);
        return false;
      }
      if (st.uv.win) {
        st.uv.win.classList.add('pulse');
        setTimeout(function () { if (st.uv.win) st.uv.win.classList.remove('pulse'); }, 260);
        setStatus('UV 编辑器已经打开（点窗口里的按钮即可操作）');
        return true;
      }
      var app = st.host && st.host.querySelector('.md-app');
      if (!app) return false;
      uvMeshReady();
      var box = document.createElement('div');
      box.className = 'md-uvwin';
      box.id = 'mdUvWin';
      box.tabIndex = -1;
      box.innerHTML = uvWindowHtml();
      app.appendChild(box);
      st.uv.win = box;
      st.uv.open = true;
      st.uv.canvas = $('mdUvCanvas');
      st.uv.ctx = st.uv.canvas ? st.uv.canvas.getContext('2d') : null;
      st.uv.corners = [];
      st.uv.cornerSet = Object.create(null);
      st.uv.syncedFaces = '';
      st.uv.drag = null;
      st.uv.marquee = null;
      st.uv.hover = null;
      uvBind(box);
      /* 图片底图：菜单 / 工具包只负责触发，真正的解码走这里。
       * input 必须挂在窗口里（不在画面外），否则部分浏览器会拒绝 click()。 */
      var fileInput = $('mdUvFile');
      if (fileInput) {
        fileInput.addEventListener('change', function () {
          uvLoadImageFile(fileInput.files && fileInput.files[0]);
          fileInput.value = '';          /* 同一张图再选一次也要能触发 change */
        });
      }
      /* 焦点可能落在画布/工具包里，键盘监听挂在 document 捕获阶段，
       * 这样 W/E/R、1/2/3、F、Esc 不管点过哪里都生效；关闭时移除。 */
      document.addEventListener('keydown', uvKeyDown, true);
      box.focus();
      /* 首帧布局还没算出来，等一帧再 fit；同时先同步 3D 选择 */
      global.requestAnimationFrame(function () {
        if (!st.uv.open) return;
        uvFit();
        uvRefresh();
      });
      uvRefresh();
      /* 模型有基础色贴图就默认铺成底图（没有的话画面保持原样，按钮仍显示「无纹理」） */
      st.uv.mapOn = true;
      uvSyncModelMap();
      setStatus('UV 编辑器已打开：点/边/壳选择，空白拖框选；Alt+左键或中键平移，滚轮缩放');
      return true;
    }

    function closeUVEditor() {
      document.removeEventListener('keydown', uvKeyDown, true);
      uvCancelDrag(true);
      uvCancelPendingDraw();
      uvCloseMenu();
      if (st.uv.win && st.uv.win.parentNode) st.uv.win.parentNode.removeChild(st.uv.win);
      st.uv.win = null;
      st.uv.canvas = null;
      st.uv.ctx = null;
      st.uv.open = false;
      st.uv.drag = null;
      st.uv.marquee = null;
      st.uv.hover = null;
      setStatus('UV 编辑器已关闭');
      return true;
    }

    /* ---------- 菜单 ---------- */
    function uvCloseMenu() {
      var drop = $('mdUvDrop');
      if (drop) { drop.hidden = true; drop.innerHTML = ''; }
      st.uv.menu = null;
    }

    function uvOpenMenu(key, btn) {
      var drop = $('mdUvDrop');
      if (!drop || !st.uv.win) return;
      if (st.uv.menu === key) { uvCloseMenu(); return; }
      var spec = null;
      for (var i = 0; i < UV_MENUS.length; i++) if (UV_MENUS[i].k === key) spec = UV_MENUS[i];
      if (!spec) return;
      var html = '<div class="md-uv-mtitle">' + esc(key) + '</div>';
      spec.items.forEach(function (it) {
        if (it.sep) { html += '<i class="md-uv-msep"></i>'; return; }
        var dis = !!it.todo;
        html += '<button type="button" class="md-uv-mi' + (dis ? ' off' : '') + '"' +
          (dis ? ' data-uvtodo="' + esc(it.todo) + '"' : ' data-uvcmd="' + it.c + '"') + '>' +
          '<span>' + esc(it.t) + '</span><b>' + esc(it.s || '') + '</b></button>';
      });
      drop.innerHTML = html;
      var wr = st.uv.win.getBoundingClientRect();
      var br = btn.getBoundingClientRect();
      drop.style.left = Math.max(4, br.left - wr.left) + 'px';
      drop.style.top = (br.bottom - wr.top) + 'px';
      drop.hidden = false;
      st.uv.menu = key;
    }

    /* ---------- 选择集 ---------- */
    function uvSetCornersRaw(arr) {
      var set = Object.create(null), out = [];
      for (var i = 0; i < (arr || []).length; i++) {
        var c = arr[i];
        if (set[c]) continue;
        set[c] = 1;
        out.push(c);
      }
      st.uv.corners = out;
      st.uv.cornerSet = set;
    }

    function uvAllCorners() {
      if (!st.mesh || !global.SeedUV) return [];
      return global.SeedUV.cornersForFaces(st.mesh, null);
    }

    function uvSelectedFaceIds() {
      if (!st.mesh || !global.SeedUV) return [];
      return global.SeedUV.faceIdsOfCorners(st.mesh, st.uv.corners);
    }

    /* 把 UV 选择写回 3D：点/边 → 面模式，壳 → 岛模式；这是「联动」的唯一入口 */
    function uvSyncFromCorners() {
      if (!st.mesh || !st.doc) return;
      var ids = uvSelectedFaceIds();
      var mode = st.uv.mode === 'shell' ? 'island' : 'face';
      st.selMode = mode;
      st.lastCompMode = mode;
      st.sel = { vertexIds: [], edgeIds: [], faceIds: ids };
      st.uv.syncedFaces = ids.slice().sort().join(',');
      syncSelectionDoc();
      applyShading();
      paintSelection();
      updateHud();
      updateChrome();
      uvUpdateChrome();
      uvDraw();
    }

    function uvApplyCorners(arr, op) {
      var set = st.uv.cornerSet;
      if (op === 'replace') {
        uvSetCornersRaw(arr);
      } else if (op === 'add') {
        var out = st.uv.corners.slice();
        for (var i = 0; i < arr.length; i++) if (!set[arr[i]]) { set[arr[i]] = 1; out.push(arr[i]); }
        uvSetCornersRaw(out);
      } else {
        for (var k = 0; k < arr.length; k++) {
          if (set[arr[k]]) delete set[arr[k]]; else set[arr[k]] = 1;
        }
        uvSetCornersRaw(Object.keys(set).map(function (x) { return Number(x); }));
      }
      uvSyncFromCorners();
    }

    function uvIslandCornersOfFace(faceIndex) {
      var idxs = islandFacesOf(faceIndex);
      var ids = [];
      for (var i = 0; i < idxs.length; i++) ids.push(st.mesh.faceIds[idxs[i]]);
      return global.SeedUV.cornersForFaces(st.mesh, ids);
    }

    function uvHitSelection(hit) {
      if (!hit) return [];
      if (hit.kind === 'point' || hit.kind === 'edge') return hit.corners;
      if (hit.kind === 'face') return uvIslandCornersOfFace(hit.face);
      return [];
    }

    function uvPickAt(lx, ly) {
      if (!st.mesh || !global.SeedUV) return null;
      var p = uvScreenToUV(lx, ly);
      var tol = 7 / Math.max(1, st.uv.scale);
      if (st.uv.mode === 'point') return global.SeedUV.pickPoint(st.mesh, p.u, p.v, tol);
      if (st.uv.mode === 'edge') return global.SeedUV.pickEdge(st.mesh, p.u, p.v, tol);
      return global.SeedUV.pickFace(st.mesh, p.u, p.v);
    }

    /* ---------- 坐标系 ---------- */
    /* 尺寸只在 uvResizeCanvas 里量一次。
     * 以前这里每次都读 clientWidth/clientHeight —— 而 uvProject 每个面角都要调一次，
     * 一个 3000 面的球就是上万次强制布局，单帧直接 40ms，看起来就是「打开 UV 很卡」。 */
    function uvSize() {
      var c = st.uv.canvas;
      if (st.uv.w && st.uv.h) return { w: st.uv.w, h: st.uv.h };
      return {
        w: (c && c.clientWidth) || 800,
        h: (c && c.clientHeight) || 600
      };
    }
    function uvProject(u, v) {
      var w = st.uv.w, h = st.uv.h;
      if (!w || !h) { var s = uvSize(); w = s.w; h = s.h; }
      return [w / 2 + (u - st.uv.cu) * st.uv.scale, h / 2 - (v - st.uv.cv) * st.uv.scale];
    }
    function uvScreenToUV(x, y) {
      var w = st.uv.w, h = st.uv.h;
      if (!w || !h) { var s = uvSize(); w = s.w; h = s.h; }
      return { u: st.uv.cu + (x - w / 2) / st.uv.scale, v: st.uv.cv - (y - h / 2) / st.uv.scale };
    }

    function uvFit() {
      if (!st.uv.open) return;
      var minU = 0, maxU = 1, minV = 0, maxV = 1;
      if (st.mesh && global.SeedUV) {
        var b = global.SeedUV.boundsOf(st.mesh, uvAllCorners());
        if (b) {
          minU = Math.min(minU, b.u0); maxU = Math.max(maxU, b.u1);
          minV = Math.min(minV, b.v0); maxV = Math.max(maxV, b.v1);
        }
      }
      var s = uvSize();
      var spanU = Math.max(1e-6, maxU - minU), spanV = Math.max(1e-6, maxV - minV);
      st.uv.cu = (minU + maxU) / 2;
      st.uv.cv = (minV + maxV) / 2;
      st.uv.scale = Math.max(24, Math.min(20000, Math.min((s.w - 54) / spanU, (s.h - 54) / spanV)));
      uvUpdateChrome();
      uvDraw();
    }

    function uvZoomAt(factor, x, y, defer) {
      var s = uvSize();
      var before = uvScreenToUV(x == null ? s.w / 2 : x, y == null ? s.h / 2 : y);
      st.uv.scale = Math.max(24, Math.min(20000, st.uv.scale * factor));
      st.uv.cu = before.u - ((x == null ? s.w / 2 : x) - s.w / 2) / st.uv.scale;
      st.uv.cv = before.v + ((y == null ? s.h / 2 : y) - s.h / 2) / st.uv.scale;
      uvUpdateChrome();
      if (defer) uvRequestDraw(); else uvDraw();
    }

    /* ---------- 画布绘制 ---------- */
    function uvResizeCanvas(force) {
      var c = st.uv.canvas;
      if (!c) return;
      var w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
      if (!force && w === st.uv.w && h === st.uv.h) return;
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      st.uv.w = w;
      st.uv.h = h;
      st.uv.dpr = dpr;
      if (st.uv.ctx) st.uv.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function uvDrawGrid(ctx, w, h) {
      if (!st.uv.grid) return;
      var step = 0.1;
      var p0 = uvScreenToUV(0, 0), p1 = uvScreenToUV(w, h);
      var minU = Math.min(p0.u, p1.u), maxU = Math.max(p0.u, p1.u);
      var minV = Math.min(p0.v, p1.v), maxV = Math.max(p0.v, p1.v);
      var i0 = Math.floor(minU / step), i1 = Math.ceil(maxU / step);
      var j0 = Math.floor(minV / step), j1 = Math.ceil(maxV / step);
      /* 0–1 的空白区域铺一层浅色，提示贴图范围 */
      var a = uvProject(0, 0), b = uvProject(1, 1);
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.lineWidth = 1;
      for (var i = i0; i <= i1; i++) {
        var u = i * step;
        var x = Math.round(uvProject(u, 0)[0]) + .5;
        if (Math.abs(u) < 1e-9 || Math.abs(u - 1) < 1e-9) ctx.strokeStyle = '#7d7d7d';
        else if (i % 5 === 0) ctx.strokeStyle = '#4a4a4a';
        else ctx.strokeStyle = '#343434';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (var j = j0; j <= j1; j++) {
        var v = j * step;
        var y = Math.round(uvProject(0, v)[1]) + .5;
        if (Math.abs(v) < 1e-9 || Math.abs(v - 1) < 1e-9) ctx.strokeStyle = '#7d7d7d';
        else if (j % 5 === 0) ctx.strokeStyle = '#4a4a4a';
        else ctx.strokeStyle = '#343434';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      /* 0–1 方框再压一道，方便判断 UV 是否越界 */
      ctx.strokeStyle = '#9a9a9a';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }

    /* 棋盘格底图：只铺 0–1 范围，8×8 格。放在网格线下面，方便看 UV 与贴图的对应 */
    function uvDrawTexture(ctx) {
      if (!st.uv.tex) return;
      var a = uvProject(0, 0), b = uvProject(1, 1);
      var x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
      var w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (w < 2 || h < 2) return;
      var N = 8;
      for (var i = 0; i < N; i++) {
        for (var j = 0; j < N; j++) {
          ctx.fillStyle = ((i + j) & 1) ? 'rgba(148,172,188,.16)' : 'rgba(226,232,238,.12)';
          ctx.fillRect(x0 + i * w / N, y0 + j * h / N, w / N + .5, h / N + .5);
        }
      }
      ctx.strokeStyle = 'rgba(180,200,214,.35)';
      ctx.strokeRect(x0, y0, w, h);
    }

    /* 图片底图：铺满 0–1 贴图范围，压在网格 / 棋盘格之上、UV 面层之下。
     * 半透明是为了既看得清图、也看得清 UV 线。 */
    function uvDrawImage(ctx) {
      var a = uvProject(0, 0), b = uvProject(1, 1);
      var x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
      var w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (w < 2 || h < 2) return;
      function draw(img) {
        if (!img || !img.naturalWidth) return;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, x0, y0, w, h);
        ctx.restore();
      }
      /* 模型贴图先铺，用户载入的参考图后铺（参考图优先，方便对照） */
      if (st.uv.mapOn) draw(st.uv.mapImg);
      draw(st.uv.img);
    }

    /* 模型自己的基础色贴图（导入时从 GLB 抽出来的 data URL）：打开 UV 编辑器就自动铺上，
     * 否则对着空网格调 UV，根本看不出贴图对应关系。多材质槽取第一张非空贴图。 */
    function uvSyncModelMap() {
      var mats = (st.doc && st.doc.materials) || {};
      var list = mats.slotMaps || [];
      var url = '', idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i]) { url = list[i]; idx = i; break; }
      }
      if (!url) {
        st.uv.mapImg = null; st.uv.mapName = ''; st.uv.mapUrl = '';
        uvSyncTexButton();
        return;
      }
      if (url === st.uv.mapUrl) { uvSyncTexButton(); return; }
      st.uv.mapUrl = url;
      var img = new Image();
      img.onload = function () {
        st.uv.mapImg = img;
        st.uv.mapName = (mats.slotNames && mats.slotNames[idx]) || '模型贴图';
        uvSyncTexButton();
        uvDraw();
      };
      img.onerror = function () {
        st.uv.mapImg = null; st.uv.mapName = '';
        uvSyncTexButton();
      };
      img.src = url;
    }

    /* 工具栏那颗「纹理」按钮的文案只反映当前真实状态：模型贴图 / 棋盘格 / 无 */
    function uvSyncTexButton() {
      var btn = $('mdUvTex');
      if (!btn) return;
      var hasMap = !!st.uv.mapImg;
      var shown = hasMap ? st.uv.mapOn : st.uv.tex;
      btn.textContent = hasMap ? (shown ? '模型贴图' : '无纹理') : (shown ? '棋盘格' : '无纹理');
      btn.title = hasMap ? '切换模型贴图底图（' + (st.uv.mapName || '') + '）' : '切换棋盘格底图';
      btn.classList.toggle('on', !!shown);
    }

    /* 载入 / 清除图片底图：读成 Image 只存在内存（st.uv.img），不写文档。
     * 这样「看参考图对 UV」不会悄悄改资产，也不用 File 对象留在 state 里。 */
    function uvPickImage() {
      var f = $('mdUvFile');
      if (!f) { uvToast('图片选择器不可用', true); return; }
      f.click();
    }

    function uvLoadImageFile(file) {
      if (!file) return;
      if (!/^image\//.test(file.type || '')) { uvToast('请选择图片文件', true); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          st.uv.img = img;
          st.uv.imgName = file.name || '图片';
          /* 图片优先：棋盘格会让底图看起来发花，载入时自动关掉 */
          st.uv.tex = false;
          uvSyncTexButton();
          uvUpdateChrome();
          uvDraw();
          uvToast('已载入图片底图：' + st.uv.imgName);
          setStatus('UV 底图：' + st.uv.imgName + '（' + img.naturalWidth + '×' + img.naturalHeight + '）');
        };
        img.onerror = function () { uvToast('图片解码失败', true); };
        img.src = String(fr.result);
      };
      fr.onerror = function () { uvToast('读取图片失败', true); };
      fr.readAsDataURL(file);
    }

    function uvClearImage() {
      if (!st.uv.img) { uvToast('当前没有图片底图'); return; }
      st.uv.img = null;
      st.uv.imgName = '';
      uvUpdateChrome();
      uvDraw();
      uvToast('已清除图片底图');
    }

    function uvDrawRulers(ctx, w, h) {
      if (!st.uv.ruler) return;
      var step = st.uv.scale > 260 ? 0.1 : 0.5;
      var p0 = uvScreenToUV(0, 0), p1 = uvScreenToUV(w, h);
      var minU = Math.min(p0.u, p1.u), maxU = Math.max(p0.u, p1.u);
      var minV = Math.min(p0.v, p1.v), maxV = Math.max(p0.v, p1.v);
      var TOP = 18, LEFT = 20;
      ctx.fillStyle = 'rgba(24,24,24,.92)';
      ctx.fillRect(0, 0, w, TOP);
      ctx.fillRect(0, 0, LEFT, h);
      ctx.strokeStyle = '#141414';
      ctx.beginPath(); ctx.moveTo(0, TOP + .5); ctx.lineTo(w, TOP + .5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(LEFT + .5, 0); ctx.lineTo(LEFT + .5, h); ctx.stroke();
      ctx.fillStyle = '#9fb6c8';
      ctx.strokeStyle = '#6f9cba';
      ctx.font = '9px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.textBaseline = 'middle';
      var i0 = Math.floor(minU / step), i1 = Math.ceil(maxU / step);
      for (var i = i0; i <= i1; i++) {
        var u = i * step, x = Math.round(uvProject(u, 0)[0]);
        if (x < LEFT) continue;
        var major = Math.abs(Math.round(u * 10) % 5) === 0;
        ctx.beginPath(); ctx.moveTo(x + .5, TOP); ctx.lineTo(x + .5, TOP - (major ? 6 : 3)); ctx.stroke();
        if (major) ctx.fillText(u.toFixed(1), x - 8, TOP - 4);
      }
      var j0 = Math.floor(minV / step), j1 = Math.ceil(maxV / step);
      for (var j = j0; j <= j1; j++) {
        var v = j * step, y = Math.round(uvProject(0, v)[1]);
        if (y < TOP) continue;
        var majorV = Math.abs(Math.round(v * 10) % 5) === 0;
        ctx.beginPath(); ctx.moveTo(LEFT, y + .5); ctx.lineTo(LEFT - (majorV ? 6 : 3), y + .5); ctx.stroke();
        if (majorV) ctx.fillText(v.toFixed(1), 2, y - 6);
      }
    }

    /* 重网格（>400 面）把「面」这一层画进一张 UV 空间的离屏位图：
     * 画布路径 API 在这个环境里每条约 2–3µs，3000 个四边形光建路径就要 30ms+，
     * 平移 / 缩放时每帧重建必卡。位图只需在网格版本变化时重建，之后 drawImage 一次就够。
     * 选中的面仍然按屏幕坐标实时画在上面，避免「点一个点就整张重建」。 */
    function uvFaceCache(mesh) {
      var key = mesh.version + '|' + mesh.faceIds.length;
      var fc = st.uv.faceCache;
      if (fc && fc.key === key && fc.mesh === mesh) return fc;
      var eminU = Infinity, eminV = Infinity, emaxU = -Infinity, emaxV = -Infinity;
      for (var c = 0; c < mesh.uvs.length; c += 2) {
        var u = mesh.uvs[c] || 0, v = mesh.uvs[c + 1] || 0;
        if (u < eminU) eminU = u;
        if (u > emaxU) emaxU = u;
        if (v < eminV) eminV = v;
        if (v > emaxV) emaxV = v;
      }
      if (!isFinite(eminU)) { eminU = 0; emaxU = 1; eminV = 0; emaxV = 1; }
      var du = Math.max(1e-3, emaxU - eminU), dv = Math.max(1e-3, emaxV - eminV);
      var pad = Math.max(du, dv) * 0.02;
      var u0 = eminU - pad, u1 = emaxU + pad, v0 = eminV - pad, v1 = emaxV + pad;
      du = u1 - u0; dv = v1 - v0;
      var W = 2048;
      var H = Math.max(128, Math.min(2048, Math.round(W * dv / du)));
      if (dv / du < 0.125) { H = 256; W = Math.min(2048, Math.round(H * du / dv)); }
      if (!fc) { fc = st.uv.faceCache = { cv: document.createElement('canvas'), ctx: null, key: '' }; }
      if (fc.cv.width !== W || fc.cv.height !== H) { fc.cv.width = W; fc.cv.height = H; }
      var cx = fc.cv.getContext('2d');
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.clearRect(0, 0, W, H);
      /* 位图 1px 对应多少屏幕像素：反推线宽，避免缩到屏幕上细得看不见 */
      var pxPerUnit = W / du;
      var lw = Math.max(1.2, Math.min(8, pxPerUnit / Math.max(1, st.uv.scale) * 1.2));
      var path = typeof global.Path2D === 'function' ? new global.Path2D() : null;
      var mx = function (uu) { return (uu - u0) / du * W; };
      var my = function (vv) { return (v1 - vv) / dv * H; };
      for (var f = 0; f < mesh.faceIds.length; f++) {
        var s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1];
        if (e0 - s0 < 3) continue;
        var pts = [];
        for (var k = s0; k < e0; k++) pts.push(mx(mesh.uvs[k * 2] || 0), my(mesh.uvs[k * 2 + 1] || 0));
        if (path) {
          path.moveTo(pts[0], pts[1]);
          for (var i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
          path.closePath();
        } else {
          cx.beginPath();
          cx.moveTo(pts[0], pts[1]);
          for (var j = 2; j < pts.length; j += 2) cx.lineTo(pts[j], pts[j + 1]);
          cx.closePath();
        }
      }
      cx.fillStyle = 'rgba(53,131,148,.14)';
      cx.strokeStyle = '#45c7dc';
      cx.lineWidth = lw;
      cx.lineJoin = 'round';
      if (path) { cx.fill(path); cx.stroke(path); } else { cx.fill(); cx.stroke(); }
      fc.key = key; fc.mesh = mesh; fc.u0 = u0; fc.u1 = u1; fc.v0 = v0; fc.v1 = v1;
      return fc;
    }

    function uvDrawFaceCache(ctx, s, mesh) {
      var fc = uvFaceCache(mesh);
      var dx = s.w / 2 + (fc.u0 - st.uv.cu) * st.uv.scale;
      var dy = s.h / 2 - (fc.v1 - st.uv.cv) * st.uv.scale;
      var dw = (fc.u1 - fc.u0) * st.uv.scale;
      var dh = (fc.v1 - fc.v0) * st.uv.scale;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fc.cv, dx, dy, dw, dh);
    }

    function uvDraw() {
      var t0 = global.performance ? global.performance.now() : 0;
      var c = st.uv.canvas, ctx = st.uv.ctx;
      if (!st.uv.open || !c || !ctx) return;
      uvResizeCanvas();
      var s = uvSize();
      ctx.save();
      ctx.fillStyle = '#232323';
      ctx.fillRect(0, 0, s.w, s.h);
      uvDrawGrid(ctx, s.w, s.h);
      uvDrawTexture(ctx);
      uvDrawImage(ctx);

      var mesh = st.mesh;
      if (!mesh || !mesh.faceIds.length) {
        ctx.restore();
        uvDrawRulers(ctx, s.w, s.h);
        if (t0) st.uv.lastMs = global.performance.now() - t0;
        return;
      }
      var P = global.performance;
      var tBuild = P ? P.now() : 0;
      var set = st.uv.cornerSet;
      var selCount = st.uv.corners.length;
      var f, c0, e0, i, k;
      /* 重网格走位图缓存；只有正在拖 UV 点（UV 每帧在变）时才整层实时画 */
      var heavy = mesh.faceIds.length > 400;
      var liveAll = !heavy || !!(st.uv.drag && st.uv.drag.kind === 'transform');
      if (!liveAll) uvDrawFaceCache(ctx, s, mesh);

      function faceLive(f2, fill, stroke, lw) {
        c0 = mesh.faceOffsets[f2]; e0 = mesh.faceOffsets[f2 + 1];
        if (e0 - c0 < 3) return;
        ctx.beginPath();
        for (k = c0; k < e0; k++) {
          var pt = uvProject(mesh.uvs[k * 2], mesh.uvs[k * 2 + 1]);
          if (k === c0) ctx.moveTo(pt[0], pt[1]); else ctx.lineTo(pt[0], pt[1]);
        }
        ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
      }

      if (!liveAll) {
        for (f = 0; f < mesh.faceIds.length; f++) {
          c0 = mesh.faceOffsets[f]; e0 = mesh.faceOffsets[f + 1];
          if (e0 - c0 < 3) continue;
          var anySel = false, allSel = true;
          for (k = c0; k < e0; k++) { if (set[k]) anySel = true; else allSel = false; }
          if (!anySel) continue;
          faceLive(f, allSel ? 'rgba(201,143,53,.30)' : 'rgba(201,143,53,.12)',
            allSel ? '#ffcf86' : '#c98f35', allSel ? 1.7 : 1.2);
        }
        if (P) st.uv.parts = { build: +(P.now() - tBuild).toFixed(1), paint: 0, cache: true };
      } else {
      var hasPath = typeof global.Path2D === 'function';
      var pNone = hasPath ? new global.Path2D() : null;
      var pPart = hasPath ? new global.Path2D() : null;
      var pFull = hasPath ? new global.Path2D() : null;
      for (f = 0; f < mesh.faceIds.length; f++) {
        c0 = mesh.faceOffsets[f]; e0 = mesh.faceOffsets[f + 1];
        if (e0 - c0 < 3) continue;
        var any = false, all = true;
        for (k = c0; k < e0; k++) {
          if (set[k]) any = true; else all = false;
        }
        var pts = [];
        for (k = c0; k < e0; k++) {
          var p = uvProject(mesh.uvs[k * 2], mesh.uvs[k * 2 + 1]);
          pts.push(p);
        }
        if (hasPath) {
          var path = !any ? pNone : (all ? pFull : pPart);
          path.moveTo(pts[0][0], pts[0][1]);
          for (i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
          path.closePath();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        if (any) {
          ctx.fillStyle = all ? 'rgba(201,143,53,.30)' : 'rgba(201,143,53,.12)';
          ctx.fill();
          ctx.strokeStyle = all ? '#ffcf86' : '#c98f35';
          ctx.lineWidth = all ? 1.7 : 1.2;
        } else {
          ctx.fillStyle = 'rgba(53,131,148,.10)';
          ctx.fill();
          ctx.strokeStyle = '#45c7dc';
          ctx.lineWidth = 1;
        }
        ctx.stroke();
      }
      if (hasPath) {
        var tA = P ? P.now() : 0;
        ctx.fillStyle = 'rgba(53,131,148,.10)'; ctx.fill(pNone);
        ctx.strokeStyle = '#45c7dc'; ctx.lineWidth = 1; ctx.stroke(pNone);
        ctx.fillStyle = 'rgba(201,143,53,.12)'; ctx.fill(pPart);
        ctx.strokeStyle = '#c98f35'; ctx.lineWidth = 1.2; ctx.stroke(pPart);
        ctx.fillStyle = 'rgba(201,143,53,.30)'; ctx.fill(pFull);
        ctx.strokeStyle = '#ffcf86'; ctx.lineWidth = 1.7; ctx.stroke(pFull);
        if (P) st.uv.parts = { build: +(tA - tBuild).toFixed(1), paint: +(P.now() - tA).toFixed(1), cache: false };
      }
      }


      /* 选中边：两个端点都在集合里才画，避免点模式下满屏白线 */
      if (st.uv.mode === 'edge' && selCount) {
        ctx.strokeStyle = '#fff4d6';
        ctx.lineWidth = 2;
        for (f = 0; f < mesh.faceIds.length; f++) {
          c0 = mesh.faceOffsets[f]; e0 = mesh.faceOffsets[f + 1];
          for (k = c0; k < e0; k++) {
            var nk = (k + 1 < e0) ? k + 1 : c0;
            if (!set[k] || !set[nk]) continue;
            var pa = uvProject(mesh.uvs[k * 2], mesh.uvs[k * 2 + 1]);
            var pb = uvProject(mesh.uvs[nk * 2], mesh.uvs[nk * 2 + 1]);
            ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
          }
        }
      }

      /* UV 点：点模式全画，其它模式只在放大后画淡点 */
      if (global.SeedUV) {
        var pg = global.SeedUV.pointGroups(mesh);
        var show = st.uv.mode === 'point';
        var tiny = st.uv.scale > 500;
        for (i = 0; i < pg.groups.length; i++) {
          var g = pg.groups[i];
          var sp = uvProject(g.u, g.v);
          var gsel = false;
          for (k = 0; k < g.corners.length; k++) if (set[g.corners[k]]) { gsel = true; break; }
          if (gsel) {
            ctx.fillStyle = '#ffcf86';
            ctx.fillRect(sp[0] - 2.5, sp[1] - 2.5, 5, 5);
            ctx.strokeStyle = '#5a4420';
            ctx.lineWidth = 1;
            ctx.strokeRect(sp[0] - 2.5, sp[1] - 2.5, 5, 5);
          } else if (show || tiny) {
            ctx.fillStyle = show ? '#9ad9e6' : 'rgba(154,217,230,.45)';
            ctx.fillRect(sp[0] - 1.2, sp[1] - 1.2, 2.4, 2.4);
          }
        }
      }

      /* 悬停反馈 */
      var hv = st.uv.hover;
      if (hv && !st.uv.drag) {
        if (hv.kind === 'point' && hv.group) {
          var hp = uvProject(hv.group.u, hv.group.v);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(hp[0], hp[1], 6, 0, Math.PI * 2); ctx.stroke();
        } else if (hv.kind === 'edge') {
          ctx.strokeStyle = 'rgba(255,255,255,.75)';
          ctx.lineWidth = 2;
          var q1 = uvProject(mesh.uvs[hv.c0 * 2], mesh.uvs[hv.c0 * 2 + 1]);
          var q2 = uvProject(mesh.uvs[hv.c1 * 2], mesh.uvs[hv.c1 * 2 + 1]);
          ctx.beginPath(); ctx.moveTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]); ctx.stroke();
        } else if (hv.kind === 'face') {
          var fs = mesh.faceOffsets[hv.face], fe = mesh.faceOffsets[hv.face + 1];
          ctx.strokeStyle = 'rgba(255,207,134,.85)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (k = fs; k < fe; k++) {
            var hq = uvProject(mesh.uvs[k * 2], mesh.uvs[k * 2 + 1]);
            if (k === fs) ctx.moveTo(hq[0], hq[1]); else ctx.lineTo(hq[0], hq[1]);
          }
          ctx.closePath(); ctx.stroke();
        }
      }

      /* 框选预览 */
      if (st.uv.marquee && st.uv.marquee.active) {
        var m = st.uv.marquee;
        var x0 = Math.min(m.x, m.x2), y0 = Math.min(m.y, m.y2);
        var w0 = Math.abs(m.x2 - m.x), h0 = Math.abs(m.y2 - m.y);
        ctx.fillStyle = 'rgba(201,143,53,.10)';
        ctx.fillRect(x0, y0, w0, h0);
        ctx.strokeStyle = '#c98f35';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + .5, y0 + .5, w0, h0);
        ctx.setLineDash([]);
      }
      ctx.restore();
      uvDrawRulers(ctx, s.w, s.h);
      if (t0) st.uv.lastMs = global.performance.now() - t0;
    }

    /* 指针连续操作（框选 / 平移 / 变换 / 悬停）每帧最多重绘一次。
     * 一次 pointermove 里可能连着调 uvDraw 两三次，复杂模型上会直接把一帧拖到几十毫秒。 */
    function uvRequestDraw() {
      if (st.uv.drawRaf) return;
      st.uv.drawRaf = global.requestAnimationFrame(function () {
        st.uv.drawRaf = 0;
        uvDraw();
      });
    }

    function uvCancelPendingDraw() {
      if (st.uv.drawRaf) { global.cancelAnimationFrame(st.uv.drawRaf); st.uv.drawRaf = 0; }
    }

    /* ---------- 状态文本 ---------- */
    function uvUpdateChrome() {
      var t = $('mdUvTarget'), read = $('mdUvRead'), hint = $('mdUvHint');
      var mesh = st.mesh;
      var islCount = 0;
      if (mesh && SeedModel.Mesh) {
        try { islCount = SeedModel.Mesh.uvIslands(mesh).islands.length; } catch (e) { islCount = 0; }
      }
      var groupSel = 0;
      if (mesh && global.SeedUV) {
        var pg = global.SeedUV.pointGroups(mesh);
        for (var i = 0; i < pg.groups.length; i++) {
          var g = pg.groups[i];
          for (var k = 0; k < g.corners.length; k++) if (st.uv.cornerSet[g.corners[k]]) { groupSel++; break; }
        }
      }
      if (t) {
        t.textContent = (st.node ? st.node.name : '—') + ' · ' +
          (mesh ? mesh.faceIds.length + ' 面 / ' + islCount + ' 岛' : '无网格');
      }
      if (read) {
        read.textContent = '选中 ' + groupSel + ' 点 · ' + st.uv.corners.length + ' 角 · ' +
          Math.round(st.uv.scale / 3.8) + '%';
      }
      if (hint) {
        var modeTxt = st.uv.mode === 'point' ? '点' : st.uv.mode === 'edge' ? '边' : '壳';
        var tmTxt = st.uv.transform === 'move' ? '移动' : st.uv.transform === 'rotate' ? '旋转' : '缩放';
        hint.textContent = '选择：' + modeTxt + ' · 变换：' + tmTxt +
          (st.uv.snap ? ' · 吸附 0.1' : '') +
          '　左键点选 / 拖拽，Shift 加选，Ctrl 减选，空白拖框选；Alt+左键或中键平移，滚轮缩放';
      }
      var box = st.uv.win;
      if (!box) return;
      var acts = box.querySelectorAll('[data-uvact]');
      for (var a = 0; a < acts.length; a++) {
        var act = acts[a].getAttribute('data-uvact');
        var on = (act === 'mode' + (st.uv.mode.charAt(0).toUpperCase() + st.uv.mode.slice(1))) ||
          (act === 'tm' + (st.uv.transform.charAt(0).toUpperCase() + st.uv.transform.slice(1))) ||
          (act === 'grid' && st.uv.grid) || (act === 'ruler' && st.uv.ruler) || (act === 'snap' && st.uv.snap);
        acts[a].classList.toggle('on', !!on);
      }
    }

    /* ---------- 刷新 / 外部选择同步 ---------- */
    function uvRefresh() {
      if (!st.uv.open || !st.uv.win) return;
      if (st.mesh) uvMeshReady();
      var key = st.sel.faceIds.slice().sort().join(',');
      /* 撤销 / 拓扑算子会把面角长度改掉：先丢掉越界角号，再按 3D 选择重建 */
      var stale = false;
      if (st.mesh && !st.uv.drag && st.uv.corners.length) {
        var maxCorner = st.mesh.faceIndices.length;
        for (var i = 0; i < st.uv.corners.length; i++) if (st.uv.corners[i] >= maxCorner) { stale = true; break; }
      }
      if (!st.uv.drag && (stale || key !== st.uv.syncedFaces)) {
        st.uv.syncedFaces = key;
        st.uv.corners = [];
        st.uv.cornerSet = Object.create(null);
        if (st.mesh && global.SeedUV) uvSetCornersRaw(global.SeedUV.cornersForFaces(st.mesh, st.sel.faceIds));
      }
      uvUpdateChrome();
      if (!st.uv.drag) uvDraw();
    }

    /* ---------- 变换 / 历史 ---------- */
    function uvCancelDrag(silent) {
      var d = st.uv.drag;
      if (!d || d.kind !== 'transform') { st.uv.drag = null; if (!silent) uvDraw(); return; }
      for (var i = 0; i < d.corners.length; i++) {
        st.mesh.uvs[d.corners[i] * 2] = d.base[i * 2];
        st.mesh.uvs[d.corners[i] * 2 + 1] = d.base[i * 2 + 1];
      }
      SeedModel.Mesh.bump(st.mesh);
      st.uv.drag = null;
      uvRefreshSolidGeometry();
      if (!silent) {
        uvUpdateChrome();
        uvDraw();
        setStatus('已取消本次 UV 变换');
      }
    }

    function uvBeginTransform(x, y) {
      if (!st.mesh || !st.uv.corners.length) return false;
      var b = global.SeedUV.boundsOf(st.mesh, st.uv.corners);
      if (!b) return false;
      var pivotPix = uvProject(b.cu, b.cv);
      var before = snap();
      st.uv.drag = {
        kind: 'transform',
        x: x, y: y,
        corners: st.uv.corners.slice(),
        base: global.SeedUV.baseOf(st.mesh, st.uv.corners),
        pivot: { u: b.cu, v: b.cv },
        pivotPix: pivotPix,
        startAngle: Math.atan2(y - pivotPix[1], x - pivotPix[0]),
        startDist: Math.sqrt(Math.pow(x - pivotPix[0], 2) + Math.pow(y - pivotPix[1], 2)) || 1,
        before: before,
        moved: false
      };
      return true;
    }

    function uvRefreshSolidGeometry() {
      if (!st.mesh || !st.pivot) return;
      var solid = null;
      st.pivot.traverse(function (o) {
        if (!solid && o.userData && o.userData.mdPart === 'solid') solid = o;
      });
      if (!solid || !solid.geometry) return;
      var next = SeedModel.Mesh.buildGeometry(st.mesh, { cache: true });
      if (next === solid.geometry) return;
      var old = solid.geometry;
      solid.geometry = next;
      try { old.dispose(); } catch (e) {}
    }

    function uvFinishTransform() {
      var d = st.uv.drag;
      st.uv.drag = null;
      if (!d || d.kind !== 'transform') return;
      if (!d.moved) { uvDraw(); return; }
      if (!st.mesh || !st.doc) return;
      SeedModel.Mesh.bump(st.mesh);
      SeedModel.Scene.revision(st.doc, 'mesh');
      uvRefreshSolidGeometry();
      var after = snap();
      var label = 'UV ' + (st.uv.transform === 'move' ? '移动' : st.uv.transform === 'rotate' ? '旋转' : '缩放');
      pushHistory(d.before, after, label);
      paintAll();
      setStatus(label + '完成（Ctrl+Z 可撤销）');
    }

    /* ---------- 指针交互 ---------- */
    function uvLocal(e) {
      var r = st.uv.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function uvMarqueeCorners(rectUV) {
      var out = [];
      var pg = global.SeedUV.pointGroups(st.mesh);
      var i, k;
      if (st.uv.mode === 'point') {
        for (i = 0; i < pg.groups.length; i++) {
          var g = pg.groups[i];
          if (g.u >= rectUV.u0 && g.u <= rectUV.u1 && g.v >= rectUV.v0 && g.v <= rectUV.v1) {
            for (k = 0; k < g.corners.length; k++) out.push(g.corners[k]);
          }
        }
      } else if (st.uv.mode === 'edge') {
        var mesh = st.mesh;
        for (var f = 0; f < mesh.faceIds.length; f++) {
          var s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1];
          for (k = s0; k < e0; k++) {
            var nk = (k + 1 < e0) ? k + 1 : s0;
            var mu = (mesh.uvs[k * 2] + mesh.uvs[nk * 2]) / 2;
            var mv = (mesh.uvs[k * 2 + 1] + mesh.uvs[nk * 2 + 1]) / 2;
            if (mu < rectUV.u0 || mu > rectUV.u1 || mv < rectUV.v0 || mv > rectUV.v1) continue;
            var g1 = pg.groups[pg.cornerGroup[k]], g2 = pg.groups[pg.cornerGroup[nk]];
            if (g1) for (i = 0; i < g1.corners.length; i++) out.push(g1.corners[i]);
            if (g2) for (i = 0; i < g2.corners.length; i++) out.push(g2.corners[i]);
          }
        }
      } else {
        for (var f2 = 0; f2 < st.mesh.faceIds.length; f2++) {
          var cs = st.mesh.faceOffsets[f2], ce = st.mesh.faceOffsets[f2 + 1];
          if (ce - cs < 3) continue;
          var cu = 0, cv = 0;
          for (k = cs; k < ce; k++) { cu += st.mesh.uvs[k * 2]; cv += st.mesh.uvs[k * 2 + 1]; }
          cu /= (ce - cs); cv /= (ce - cs);
          if (cu < rectUV.u0 || cu > rectUV.u1 || cv < rectUV.v0 || cv > rectUV.v1) continue;
          var islandCs = uvIslandCornersOfFace(f2);
          for (i = 0; i < islandCs.length; i++) out.push(islandCs[i]);
        }
      }
      return out;
    }

    function uvPointerDown(e) {
      if (!st.mesh || !st.uv.open) return;
      uvCancelPendingDraw();
      uvCloseMenu();
      var l = uvLocal(e);
      if (st.uv.canvas.setPointerCapture) {
        try { st.uv.canvas.setPointerCapture(e.pointerId); } catch (err) {}
      }
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        st.uv.drag = { kind: 'pan', x: l.x, y: l.y, cu: st.uv.cu, cv: st.uv.cv };
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      var hit = uvPickAt(l.x, l.y);
      var add = e.shiftKey, toggle = e.ctrlKey || e.metaKey;
      if (hit) {
        var picked = uvHitSelection(hit);
        var wasSel = picked.length > 0;
        for (var i = 0; i < picked.length; i++) if (!st.uv.cornerSet[picked[i]]) { wasSel = false; break; }
        if (!wasSel || add || toggle) uvApplyCorners(picked, add ? 'add' : toggle ? 'toggle' : 'replace');
        if (!add && !toggle) {
          if (st.uv.corners.length) uvBeginTransform(l.x, l.y);
        }
      } else {
        var hadSel = st.uv.corners.length;
        if (!add && !toggle) uvApplyCorners([], 'replace');
        if (hadSel && !st.uv.corners.length) setStatus('已清除 UV 选择（拖空白可框选）');
        st.uv.marquee = { active: true, x: l.x, y: l.y, x2: l.x, y2: l.y, add: add, toggle: toggle };
      }
      uvDraw();
      e.preventDefault();
    }

    function uvPointerMove(e) {
      if (!st.uv.open) return;
      var l = uvLocal(e);
      var drag = st.uv.drag;
      if (st.uv.marquee) {
        st.uv.marquee.x2 = l.x;
        st.uv.marquee.y2 = l.y;
        uvRequestDraw();
        return;
      }
      if (drag) {
        if (drag.kind === 'pan') {
          st.uv.cu = drag.cu - (l.x - drag.x) / st.uv.scale;
          st.uv.cv = drag.cv + (l.y - drag.y) / st.uv.scale;
          uvUpdateChrome();
          uvRequestDraw();
          return;
        }
        if (drag.kind === 'transform') {
          var dx = l.x - drag.x, dy = l.y - drag.y;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
          if (!drag.moved) return;
          if (st.uv.transform === 'move') {
            global.SeedUV.writeMoved(st.mesh, drag.corners, drag.base,
              dx / st.uv.scale, -dy / st.uv.scale, st.uv.snap ? UV_SNAP : 0);
          } else if (st.uv.transform === 'rotate') {
            var a = Math.atan2(l.y - drag.pivotPix[1], l.x - drag.pivotPix[0]) - drag.startAngle;
            global.SeedUV.writeRotated(st.mesh, drag.corners, drag.base, -a, drag.pivot,
              st.uv.snap ? UV_ROT_SNAP : 0);
          } else {
            var dist = Math.sqrt(Math.pow(l.x - drag.pivotPix[0], 2) + Math.pow(l.y - drag.pivotPix[1], 2));
            global.SeedUV.writeScaled(st.mesh, drag.corners, drag.base, dist / drag.startDist,
              drag.pivot, st.uv.snap ? UV_SCALE_SNAP : 0);
          }
          uvUpdateChrome();
          uvRequestDraw();
          return;
        }
      }
      var hit = uvPickAt(l.x, l.y);
      var same = (!hit && !st.uv.hover) ||
        (hit && st.uv.hover && hit.kind === st.uv.hover.kind &&
          ((hit.kind === 'point' && hit.group === st.uv.hover.group) ||
           (hit.kind !== 'point' && hit.face === st.uv.hover.face)));
      if (!same) {
        st.uv.hover = hit;
        st.uv.canvas.style.cursor = hit ? 'crosshair' : 'default';
        uvRequestDraw();
      }
    }

    function uvPointerUp(e) {
      if (!st.uv.open) return;
      uvCancelPendingDraw();
      var l = uvLocal(e);
      if (st.uv.canvas.releasePointerCapture) {
        try { st.uv.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      if (st.uv.marquee) {
        var m = st.uv.marquee;
        st.uv.marquee = null;
        if (Math.abs(m.x2 - m.x) > 3 || Math.abs(m.y2 - m.y) > 3) {
          var a = uvScreenToUV(m.x, m.y), b = uvScreenToUV(m.x2, m.y2);
          var rect = {
            u0: Math.min(a.u, b.u), u1: Math.max(a.u, b.u),
            v0: Math.min(a.v, b.v), v1: Math.max(a.v, b.v)
          };
          var cs = uvMarqueeCorners(rect);
          uvApplyCorners(cs, m.add ? 'add' : m.toggle ? 'toggle' : 'replace');
        }
        uvDraw();
        return;
      }
      if (st.uv.drag) {
        uvFinishTransform();
        uvDraw();
      }
    }

    function uvWheel(e) {
      if (!st.uv.open) return;
      e.preventDefault();
      var l = uvLocal(e);
      uvZoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, l.x, l.y, true);
    }

    /* 窗口拖动 / 缩放（用 pointer capture，拖到窗口外也不丢） */
    function uvBindDrag(handle, onMove, state, redraw) {
      handle.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        /* 标题栏上的「适应 / ×」是真按钮：不能把它们当拖动手柄，
         * 否则 pointerdown 被 preventDefault + capture，click 被重定向到标题栏，× 永远关不掉。 */
        var t = e.target;
        if (t && t.closest && t.closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        var win = st.uv.win;
        if (!win) return;
        state.x = e.clientX; state.y = e.clientY;
        state.w = win.offsetWidth; state.h = win.offsetHeight;
        state.left = win.offsetLeft; state.top = win.offsetTop;
        if (handle.setPointerCapture) { try { handle.setPointerCapture(e.pointerId); } catch (err) {} }
      });
      handle.addEventListener('pointermove', function (e) {
        if (state.x == null || !st.uv.win) return;
        onMove(e);
        /* 只移动窗口时画布内容没变，不必重绘；缩放才需要（尺寸变了）。
         * 每帧重绘 2D 画布是「拖窗口很卡」的主要原因。 */
        if (redraw) uvRequestDraw();
      });
      handle.addEventListener('pointerup', function (e) {
        state.x = null;
        if (handle.releasePointerCapture) { try { handle.releasePointerCapture(e.pointerId); } catch (err) {} }
        if (!redraw) return;
        uvResizeCanvas(true);
        uvUpdateChrome();
        uvDraw();
      });
    }

    function uvBind(box) {
      var c = st.uv.canvas;
      if (c) {
        c.addEventListener('pointerdown', uvPointerDown);
        c.addEventListener('pointermove', uvPointerMove);
        c.addEventListener('pointerup', uvPointerUp);
        c.addEventListener('pointercancel', function () { uvCancelDrag(true); st.uv.marquee = null; uvDraw(); });
        c.addEventListener('pointerleave', function () {
          if (!st.uv.drag && !st.uv.marquee && st.uv.hover) { st.uv.hover = null; uvRequestDraw(); }
        });
        c.addEventListener('wheel', uvWheel, { passive: false });
        c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      }

      var head = box.querySelector('[data-uvdrag]');
      if (head) {
        var dragState = { x: null, y: null, left: 0, top: 0, w: 0, h: 0 };
        uvBindDrag(head, function (e) {
          var win = st.uv.win;
          if (!win) return;
          var host = win.offsetParent;
          var maxL = host ? Math.max(0, host.clientWidth - dragState.w) : 1e6;
          var maxT = host ? Math.max(0, host.clientHeight - dragState.h) : 1e6;
          win.style.right = 'auto';
          win.style.bottom = 'auto';
          win.style.width = dragState.w + 'px';
          win.style.height = dragState.h + 'px';
          /* 夹住窗口，别把标题栏的 × 拖到 .md-app 之外 —— 拖出去后 overflow:hidden 会把它裁掉，看起来就「关不掉」 */
          win.style.left = Math.max(0, Math.min(maxL, dragState.left + (e.clientX - dragState.x))) + 'px';
          win.style.top = Math.max(0, Math.min(maxT, dragState.top + (e.clientY - dragState.y))) + 'px';
        }, dragState, false);
      }

      var rs = box.querySelector('[data-uvresize]');
      if (rs) {
        var rsState = { x: null, y: null, left: 0, top: 0, w: 0, h: 0 };
        uvBindDrag(rs, function (e) {
          var win = st.uv.win;
          if (!win) return;
          var host = win.offsetParent;
          var maxW = host ? Math.max(480, host.clientWidth - win.offsetLeft) : 1e6;
          var maxH = host ? Math.max(320, host.clientHeight - win.offsetTop) : 1e6;
          win.style.right = 'auto';
          win.style.bottom = 'auto';
          win.style.width = Math.max(480, Math.min(maxW, rsState.w + (e.clientX - rsState.x))) + 'px';
          win.style.height = Math.max(320, Math.min(maxH, rsState.h + (e.clientY - rsState.y))) + 'px';
        }, rsState, true);
      }

      box.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest) t = t.closest('button');
        if (!t) {
          /* 折叠组里的「计划 X5g」灰条也点得动：给出可见提示，别让点击像没反应 */
          var note = e.target.closest && e.target.closest('.md-uvk-note');
          if (note) {
            uvCloseMenu();
            setStatus('尚未接入：' + note.textContent.trim());
            return;
          }
          /* 点空白处关菜单 */
          if (!e.target.closest || !e.target.closest('.md-uv-drop')) uvCloseMenu();
          return;
        }
        if (t.dataset.uvmenuopen) { uvOpenMenu(t.dataset.uvmenuopen, t); return; }
        if (t.dataset.uvtodo) {
          uvCloseMenu();
          setStatus('「' + t.querySelector('span').textContent + '」尚未接入（计划表 ' + t.dataset.uvtodo + '）', true);
          return;
        }
        if (t.dataset.uvcmd) { uvCommand(t.dataset.uvcmd); return; }
        if (t.dataset.uvact) { uvCommand(t.dataset.uvact); return; }
        if (t.dataset.uvsec) {
          var grp = t.parentNode;
          if (grp && grp.classList) grp.classList.toggle('open');
          return;
        }
        uvCloseMenu();
      });
    }

    function uvKeyDown(e) {
      if (!st.uv.open) return;
      var el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      var key = e.key;
      if (key === 'Escape') {
        if (st.uv.drag) { uvCancelDrag(); e.preventDefault(); e.stopPropagation(); return; }
        if (st.uv.menu) { uvCloseMenu(); e.preventDefault(); e.stopPropagation(); return; }
        closeUVEditor();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (st.uv.drag || e.ctrlKey || e.metaKey || e.altKey) return;
      var handled = true;
      if (key === '1') uvCommand('modePoint');
      else if (key === '2') uvCommand('modeEdge');
      else if (key === '3') uvCommand('modeShell');
      else if (key === 'w' || key === 'W') uvCommand('tmMove');
      else if (key === 'e' || key === 'E') uvCommand('tmRotate');
      else if (key === 'r' || key === 'R') uvCommand('tmScale');
      else if (key === 'f' || key === 'F') uvCommand('fit');
      else if (key === 'g' || key === 'G') uvCommand('grid');
      else if (key === 's' || key === 'S') uvCommand('snap');
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    /* ---------- 命令 ---------- */
    function uvApplyEdit(label, fn, okNote) {
      if (!uvMeshReady()) { setStatus('UV 编辑器：没有可编辑的网格', true); return false; }
      var before = snap();
      var r = fn(st.mesh);
      if (r === false || r === 0 || r == null) { setStatus(label + '：没有可处理的 UV 面', true); return false; }
      SeedModel.Mesh.bump(st.mesh);
      SeedModel.Scene.revision(st.doc, 'mesh');
      uvRefreshSolidGeometry();
      var after = snap();
      pushHistory(before, after, label);
      paintAll();
      setStatus(label + '：' + (okNote || '完成（Ctrl+Z 可撤销）'));
      return true;
    }

    function uvSelectedOrAllFaceIds() {
      var ids = uvSelectedFaceIds();
      return ids.length ? ids : null;
    }

    function uvSelectAll() {
      if (!st.mesh) return;
      uvSetCornersRaw(uvAllCorners());
      uvSyncFromCorners();
      setStatus('已全选 UV（' + st.uv.corners.length + ' 个面角）');
    }

    function uvSelectNone() {
      uvSetCornersRaw([]);
      uvSyncFromCorners();
      setStatus('已清除 UV 选择');
    }

    function uvInvertSelection() {
      if (!st.mesh || !global.SeedUV) return;
      if (st.uv.mode === 'shell') {
        var cur = Object.create(null);
        uvSelectedFaceIds().forEach(function (id) { cur[id] = 1; });
        var rest = [];
        for (var i = 0; i < st.mesh.faceIds.length; i++) {
          var id = st.mesh.faceIds[i];
          if (!cur[id]) rest.push(id);
        }
        uvSetCornersRaw(global.SeedUV.cornersForFaces(st.mesh, rest));
      } else {
        var set = st.uv.cornerSet, out = [];
        var all = uvAllCorners();
        for (var k = 0; k < all.length; k++) if (!set[all[k]]) out.push(all[k]);
        uvSetCornersRaw(out);
      }
      uvSyncFromCorners();
      setStatus('已反向选择 UV');
    }

    function uvGrowToShells() {
      if (!st.mesh || !global.SeedUV) return;
      var ids = uvSelectedFaceIds();
      if (!ids.length) { setStatus('先选中一些 UV 面角，再扩选到整个壳', true); return; }
      var keep = Object.create(null);
      ids.forEach(function (id) { keep[id] = 1; });
      var grown = Object.create(null), out = [];
      for (var i = 0; i < st.mesh.faceIds.length; i++) {
        if (!keep[st.mesh.faceIds[i]]) continue;
        var cs = uvIslandCornersOfFace(i);
        for (var k = 0; k < cs.length; k++) if (!grown[cs[k]]) { grown[cs[k]] = 1; out.push(cs[k]); }
      }
      uvSetCornersRaw(out);
      uvSyncFromCorners();
      setStatus('已扩选到整个 UV 壳');
    }

    function uvFlip(axis) {
      uvApplyEdit(axis === 'u' ? '反转 U' : '反转 V', function (mesh) {
        return global.SeedUV.flip(mesh, st.uv.corners, axis);
      });
    }

    function uvAlign(mode) {
      if (!st.uv.corners.length) { setStatus('对齐需要先选中 UV 点/壳', true); return; }
      uvApplyEdit('UV 对齐', function (mesh) {
        return global.SeedUV.align(mesh, st.uv.corners, mode);
      });
    }

    function uvCommand(cmd) {
      if (!st.uv.open && cmd !== 'close') return false;
      uvCloseMenu();
      var S = global.SeedUV;
      switch (cmd) {
        case 'close': closeUVEditor(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'modePoint': st.uv.mode = 'point'; st.uv.hover = null; uvUpdateChrome(); uvDraw(); setStatus('UV 选择模式：点'); break;
        case 'modeEdge': st.uv.mode = 'edge'; st.uv.hover = null; uvUpdateChrome(); uvDraw(); setStatus('UV 选择模式：边'); break;
        case 'modeShell': st.uv.mode = 'shell'; st.uv.hover = null; uvUpdateChrome(); uvDraw(); setStatus('UV 选择模式：壳'); break;
        case 'tmMove': st.uv.transform = 'move'; uvUpdateChrome(); setStatus('UV 变换：移动（拖动选中点）'); break;
        case 'tmRotate': st.uv.transform = 'rotate'; uvUpdateChrome(); setStatus('UV 变换：旋转（左右拖动绕选择中心）'); break;
        case 'tmScale': st.uv.transform = 'scale'; uvUpdateChrome(); setStatus('UV 变换：缩放（拖动改变半径）'); break;
        case 'grid': st.uv.grid = !st.uv.grid; uvUpdateChrome(); uvDraw(); setStatus(st.uv.grid ? 'UV 网格开' : 'UV 网格关'); break;
        case 'ruler': st.uv.ruler = !st.uv.ruler; uvUpdateChrome(); uvDraw(); setStatus(st.uv.ruler ? 'UV 标尺开' : 'UV 标尺关'); break;
        case 'snap': st.uv.snap = !st.uv.snap; uvUpdateChrome(); setStatus(st.uv.snap ? 'UV 吸附开：移动 0.1 / 旋转 15° / 缩放 0.05' : 'UV 吸附关'); break;
        case 'fit': uvFit(); setStatus('UV 视图已适应'); break;
        case 'zoomIn': uvZoomAt(1.25); break;
        case 'zoomOut': uvZoomAt(1 / 1.25); break;
        case 'selAll': uvSelectAll(); break;
        case 'selNone': uvSelectNone(); break;
        case 'selInvert': uvInvertSelection(); break;
        case 'growShell': uvGrowToShells(); break;
        case 'projBox': uvApplyEdit('盒式投影', function (mesh) { return S.boxProject(mesh); }); break;
        case 'projXZ': uvApplyEdit('平面投影 XZ', function (mesh) {
          return S.projectPlanar(mesh, { axis: 'y', faceIds: uvSelectedOrAllFaceIds() });
        }, '完成（沿 Y 轴拍平到 0–1）'); break;
        case 'projXY': uvApplyEdit('平面投影 XY', function (mesh) {
          return S.projectPlanar(mesh, { axis: 'z', faceIds: uvSelectedOrAllFaceIds() });
        }, '完成（沿 Z 轴拍平到 0–1）'); break;
        case 'projZY': uvApplyEdit('平面投影 ZY', function (mesh) {
          return S.projectPlanar(mesh, { axis: 'x', faceIds: uvSelectedOrAllFaceIds() });
        }, '完成（沿 X 轴拍平到 0–1）'); break;
        case 'projCyl': uvApplyEdit('圆柱投影', function (mesh) {
          return S.projectCylindrical(mesh, { axis: 'y', faceIds: uvSelectedOrAllFaceIds() });
        }, '沿 Y 轴圆周展开，高度归一化到 0–1'); break;
        case 'projSphere': uvApplyEdit('球形投影', function (mesh) {
          return S.projectSpherical(mesh, { axis: 'y', faceIds: uvSelectedOrAllFaceIds() });
        }, '经度 → U、纬度 → V；极点附近会有挤压'); break;
        case 'stitch':
          if (!st.uv.corners.length) { setStatus('缝合需要先选中 UV 点或壳', true); break; }
          uvApplyEdit('缝合 UV', function (mesh) {
            return S.stitch(mesh, st.uv.corners, 0.02);
          }, '2% 容差内的选中 UV 点已并到平均位置');
          break;
        case 'seamCut': {
          var cutIds = uvSelectedOrAllFaceIds();
          if (!cutIds) { setStatus('沿边切割：先选中要切出的面', true); uvToast('先选面再切割', true); break; }
          uvApplyEdit('沿边切割', function (mesh) {
            return S.cutSeams(mesh, cutIds);
          }, '选中面的边界已标为 UV 缝（岛按缝重算，UV 坐标未动）');
          break;
        }
        case 'sepShells': {
          var sepIds = uvSelectedOrAllFaceIds();
          if (!sepIds) { setStatus('分离 UV 壳：先选中要分离的面', true); uvToast('先选面再分离', true); break; }
          uvApplyEdit('分离 UV 壳', function (mesh) {
            return S.separateShells(mesh, sepIds, 0.02);
          }, '壳边界已切开，所有岛按 2% 间隙重新排布');
          break;
        }
        case 'imgLoad': uvPickImage(); break;
        case 'imgClear': uvClearImage(); break;
        /* 工具栏那颗按钮 = 智能切换：有模型贴图就切贴图，没有就切棋盘格 */
        case 'texToggle':
          if (st.uv.mapImg) {
            st.uv.mapOn = !st.uv.mapOn;
            uvSyncTexButton(); uvDraw();
            setStatus(st.uv.mapOn ? '已显示模型贴图底图' : '已关闭模型贴图底图');
          } else {
            st.uv.tex = !st.uv.tex;
            uvSyncTexButton(); uvDraw();
            setStatus(st.uv.tex ? '已显示棋盘格底图（0–1 贴图范围）' : '已关闭棋盘格底图');
          }
          break;
        case 'mapTex':
          if (!st.uv.mapImg) {
            uvToast('当前模型没有基础色贴图（可在「图像 → 载入图片」放参考图）', true);
            setStatus('当前模型没有基础色贴图', true);
            break;
          }
          st.uv.mapOn = !st.uv.mapOn;
          uvSyncTexButton(); uvDraw();
          setStatus(st.uv.mapOn ? '已显示模型贴图底图：' + st.uv.mapName : '已关闭模型贴图底图');
          break;
        case 'checkerToggle':
          st.uv.tex = !st.uv.tex;
          uvSyncTexButton(); uvDraw();
          setStatus(st.uv.tex ? '已显示棋盘格底图（0–1 贴图范围）' : '已关闭棋盘格底图');
          break;
        case 'unwrap':
          uvApplyEdit('自动展开', function (mesh) {
            var r = S.unwrap(mesh, { faceIds: uvSelectedOrAllFaceIds(), gap: 0.02 });
            return r ? true : false;
          }, '每壳按主平面拍平后装箱（壳之间不重叠）');
          break;
        case 'pack':
          uvApplyEdit('排布 UV', function (mesh) {
            return S.pack(mesh, { faceIds: uvSelectedOrAllFaceIds(), gap: 0.02 });
          }, '已按货架装箱排布到 0–1');
          break;
        case 'normalize':
          uvApplyEdit('统一尺寸', function (mesh) {
            return S.normalizeIslands(mesh, uvSelectedOrAllFaceIds(), 0.35);
          }, '每个壳的最长边统一为 0.35');
          break;
        case 'alignU0': uvAlign('u0'); break;
        case 'alignUC': uvAlign('uc'); break;
        case 'alignU1': uvAlign('u1'); break;
        case 'alignV0': uvAlign('v0'); break;
        case 'alignVC': uvAlign('vc'); break;
        case 'alignV1': uvAlign('v1'); break;
        case 'flipU': uvFlip('u'); break;
        case 'flipV': uvFlip('v'); break;
        case 'rot90':
          uvApplyEdit('旋转 90°', function (mesh) {
            return S.rotate90(mesh, st.uv.corners, 1);
          });
          break;
        case 'uvsetNone': setStatus('当前使用默认 UV 集（多 UV 集在计划 X5g）'); break;
        case 'refresh': uvRefresh(); setStatus('UV 画布已刷新'); break;
        case 'help':
          setStatus('UV 编辑器：左键点选/拖拽，Shift 加选、Ctrl 减选；空白拖矩形框选；Alt+左键或中键平移，滚轮缩放；1/2/3 点/边/壳，W/E/R 移动/旋转/缩放，F 适应，Esc 关闭。');
          break;
        default: break;
      }
      return true;
    }

    return {
      open: openUVEditor,
      close: closeUVEditor,
      command: uvCommand,
      refresh: uvRefresh,
      toast: uvToast,
      windowHtml: uvWindowHtml,
      draw: uvDraw,
      requestDraw: uvRequestDraw,
      updateChrome: uvUpdateChrome,
      syncModelMap: uvSyncModelMap,
      syncTexButton: uvSyncTexButton,
      keyDown: uvKeyDown,
      selectedFaceIds: uvSelectedFaceIds,
      refreshSolidGeometry: uvRefreshSolidGeometry
    };
  }

  global.MDUvEditor = { create: create };
})(window);
