/* ============================================================
 * 多视图 App · 视图层（mv-panels）
 *
 * 负责「state → 屏幕」：模型列表 / 视图 chips / 预设 / 信息条 /
 * 导出条 / 正方形舞台 / 点图选格，以及总入口 paint()。
 * 这里不写业务逻辑，只负责显示和命中。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-panels.js 必须在 mv-state.js 之后加载');

  var state = MV.state;
  var $ = MV.$;
  var cls = MV.cls;
  var esc = MV.esc;

  function paintModels() {
    var box = $('mvList');
    if (!box) return;

    if (!state.models.length) {
      var hint = state.error ? esc(state.error)
        : (MV.hasDesk()
          ? '模型库还没有 3D 资产。<br>用下面「打开模型库」导入 glb / obj，或者直接把文件拖进来。'
          : '把 glb / gltf / obj 拖进来，或点上面「＋ 文件」。<br>OBJ 的四边形面按原始拓扑画线框，不会出现三角化的对角线。');
      box.innerHTML = '<div class="mv-none">' + hint + '</div>';
      return;
    }

    box.innerHTML = state.models.map(function (a) {
      var on = state.cur && state.cur.id === a.id ? ' is-on' : '';
      var ext = String(a.ext || MV.modelExt(a.name) || '').toUpperCase();
      return '<button type="button" class="mv-item' + on + '" data-mv-id="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
        '<span class="mv-item-ext">' + esc(ext) + '</span>' +
        '<span class="mv-item-main">' +
          '<span class="mv-item-n">' + esc(a.name) + '</span>' +
          '<span class="mv-item-m">' + MV.fmtMB(a.size) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-mv-id]'), function (b) {
      b.addEventListener('click', function () { MV.pickModel(b.dataset.mvId); });
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
    host.innerHTML = MV.PRESETS.map(function (p) {
      /* 一条预设「生效」= 当前选中的视图集合与它完全一致 */
      var same = p.v.length === state.views.length && p.v.every(function (k) { return state.views.indexOf(k) >= 0; });
      return '<button type="button" class="mv-chip mv-preset' + (same ? ' is-on' : '') + '" data-mv-preset="' + p.k + '">' +
        esc(p.n) + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-mv-preset]'), function (b) {
      b.addEventListener('click', function () {
        var p = MV.PRESETS.filter(function (x) { return x.k === b.dataset.mvPreset; })[0];
        if (!p) return;
        state.views = p.v.slice();
        MV.saveSet();
        paintPresets();
        paintViews();
        MV.render();
      });
    });
  }

  function paintViews() {
    var host = $('mvViews');
    if (!host) return;
    host.innerHTML = MV.VIEW_ORDER.map(function (k) {
      var on = state.views.indexOf(k) >= 0;
      return '<button type="button" class="mv-chip' + (on ? ' is-on' : '') + '" data-mv-view="' + k + '" ' +
        'aria-pressed="' + on + '" title="' + esc(MV.viewName(k)) + '">' + esc(MV.viewName(k)) + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-mv-view]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.mvView;
        var i = state.views.indexOf(k);
        if (i < 0) {
          /* 按 VIEW_ORDER 插入，不按点击顺序 —— 否则布局会随点击次序跳，
           * 同一组视图每次渲出来格子位置都不一样。 */
          var at = MV.VIEW_ORDER.indexOf(k);
          var next = state.views.slice();
          next.push(k);
          next.sort(function (a, b2) { return MV.VIEW_ORDER.indexOf(a) - MV.VIEW_ORDER.indexOf(b2); });
          state.views = next;
          void at;
        } else {
          if (state.views.length <= 1) { MV.say('至少留一个视图'); return; }
          state.views.splice(i, 1);
        }
        MV.saveSet();
        paintPresets();
        paintViews();
        MV.render();
      });
    });
  }

  function paintInfo() {
    var el = $('mvInfo');
    if (!el) return;
    if (state.busy === 'render') { el.textContent = '渲染中…'; return; }
    if (state.busy === 'loading') { el.textContent = '读取模型…'; return; }
    if (state.busy === 'saving') { el.textContent = '存入图库…'; return; }
    if (state.busy === 'proj') { el.textContent = '投射纹理中…'; return; }
    if (state.error) { el.textContent = state.error; el.classList.add('is-err'); return; }
    el.classList.remove('is-err');
    if (!state.out) { el.textContent = ''; return; }
    var o = state.out;
    /* 深度灰模式下颜色通道根本不渲，线框/描边的勾选状态是「存着但没画」，
     * 报在信息条上会让人以为坏了——这里只报深度灰自己的参数。 */
    if (state.depthGray) {
      el.textContent = o.cells.length + ' 张 · ' + o.width + '×' + o.height +
        ' · 单格 ' + MV.cellTxt(o.cellW, o.cellH) + ' · 深度灰（近白远黑）· 范围 ' +
        Math.round(state.depthGrayRange) + '%';
      return;
    }
    var m = MV.MODES.filter(function (x) { return x.k === state.mode; })[0];
    el.textContent = o.cells.length + ' 张 · ' + o.width + '×' + o.height +
      ' · 单格 ' + MV.cellTxt(o.cellW, o.cellH) + ' · ' + (m ? m.n : state.mode) +
      (state.wireAngle
        ? ' + 角度线框 ≥' + Math.round(state.wireAngleDeg) + '°' +
          (Math.abs(state.creaseScale - 1) > 0.001 ? ' · ' + state.creaseScale.toFixed(1) + '×' : '') +
          (state.creaseTaper > 0 ? ' · 随角度 ' + Math.round(state.creaseTaper) + '%' : '') +
          (o.crease ? '（' + o.crease.edges + ' 条边）' : '')
        : (state.wire ? ' + 线框' : '')) +
      (state.uvIsland ? ' + UV 岛着色' + (o.uvisland ? '(' + o.uvisland.islands + ' 岛)' : '') : '') +
      (state.uvEdge ? (state.uv && state.uv.hasUV === false ? ' + UV 描边（模型无 UV）' : (state.uv && state.uv.drawn === false ? ' + UV 描边（无接缝）' : ' + UV 描边')) : '') +
      (state.outline ? ' + 外轮廓' : '') +
      (state.depthEdge ? ' + 深度描边 ≥' + MV.fmtPct(state.depthEdgeThresh) : '') +
      ' · ' + (state.cam === 'persp' ? '透视' : '正交');
  }

  /* 画布显示区固定正方形：量外层的可用宽高，取小值定边长。
   * 只负责「看起来是正方形」——真正出图的画布尺寸由 exportLayout 固定 2K/4K。 */
  function fitStage() {
    var host = $('mvStageHost');
    var stage = $('mvStage');
    if (!host || !stage) return;
    var w = host.clientWidth, h = host.clientHeight;
    if (w < 2 || h < 2) return;               // 窗口还没显示出来，等 ResizeObserver 再来一遍
    var side = Math.max(120, Math.floor(Math.min(w, h)) - 20);
    stage.style.width = side + 'px';
    stage.style.height = side + 'px';
  }

  function paintPick() {
    fitStage();                                 // 每次重绘都对齐一次，拖动窗口也不会变形
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
   * 画布尺寸是预览和导出共用的（2K/4K 正方形），改它要重渲；间距只影响导出画面，
   * 这里只反映状态。 */
  function paintExport() {
    var has = !!state.cur && !!state.cur.src && !state.busy;
    ['mvExPreview', 'mvExColor', 'mvExDepth', 'mvExMask', 'mvProj'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = !has;
    });

    /* 导出反馈：按钮文字 + 面板内状态行（黄点忙碌 / 绿点成功 / 红点失败） */
    var es = MV.exportStatus ? MV.exportStatus() : { kind: '', txt: '', log: null };
    var EX_BTN = {
      color: ['mvExColor', '导出视图 PNG', '导出中…'],
      depth: ['mvExDepth', '导出深度图', '导出中…'],
      mask: ['mvExMask', '导出遮罩图', '导出中…'],
      preview: ['mvExPreview', '预览导出结果', '生成预览中…']
    };
    for (var bk in EX_BTN) {
      if (!Object.prototype.hasOwnProperty.call(EX_BTN, bk)) continue;
      var bb = $(EX_BTN[bk][0]);
      if (!bb) continue;
      var on = es.kind === bk;
      bb.textContent = on ? EX_BTN[bk][2] : EX_BTN[bk][1];
      cls(bb, 'is-busy', on);
    }
    var stBox = $('mvExStatus'), stTxt = $('mvExStatusTxt');
    if (stBox) {
      var show = !!(es.kind || es.log);
      cls(stBox, 'hidden', !show);
      cls(stBox, 'is-busy', !!es.kind);
      cls(stBox, 'is-ok', !!(es.log && es.log.ok));
      cls(stBox, 'is-err', !!(es.log && !es.log.ok));
      if (stTxt) stTxt.textContent = es.kind ? es.txt : (es.log ? es.log.txt : '');
    }
    var sizeSel = $('mvExSize');
    if (sizeSel && sizeSel.value !== String(state.exSize)) sizeSel.value = String(state.exSize);
    var gapSel = $('mvExGap');
    if (gapSel && gapSel.value !== String(state.exGap)) gapSel.value = String(state.exGap);
    /* 工具栏「画布」段跟导出的下拉是同一个 state.exSize，这边改了那边要跟上 */
    var sizeHost = $('mvSizes');
    if (sizeHost) {
      Array.prototype.forEach.call(sizeHost.querySelectorAll('[data-mv-val]'), function (b) {
        cls(b, 'is-on', String(b.dataset.mvVal) === String(state.exSize));
      });
    }

    var info = $('mvExInfo');
    if (info) {
      if (!state.cur) info.textContent = '';
      else {
        var L = MV.exportLayout(state.views.length, state.exSize, state.exGap, state.cols, state.compact);
        info.textContent = state.views.length + '视图 ' + L.cols + '×' + L.rows +
          ' · 画布 ' + L.w + '×' + L.h + ' · 单格 ' + MV.cellTxt(L.cellW, L.cellH);
      }
    }
    var st = $('mvExStats');
    if (st) {
      var s = state.stats;
      st.textContent = s && s.meshes
        ? '顶点 ' + MV.fmtN(s.verts) + ' · 三角面 ' + MV.fmtN(s.tris) + ' · UV ' + s.uv
        : '';
    }

    /* 舞台工具栏的导出按钮也吃同一套禁止态：导出中不能连开第二个下载 */
    var cellBtn = $('mvDlCell');
    if (cellBtn) cellBtn.disabled = !(state.out && state.pick >= 0) || !!state.busy;
    var allBtn = $('mvDlAll');
    if (allBtn) allBtn.disabled = !state.out || !!state.busy;
    var libBtn = $('mvSaveLib');
    if (libBtn) {
      /* 独立页没有图库，这个按钮留着只会点出一句「存不进」。直接不显示。 */
      cls(libBtn, 'hidden', !MV.hasDesk());
      libBtn.disabled = !state.out || !MV.hasDesk() || !!state.busy;
    }
  }

  /* 右栏三个工作页签：layer / export / proj。只切显示，不销毁 DOM
   * （图层参数控件的迁移、导出按钮的禁用状态都不受影响）。 */
  function setRightTab(name) {
    var keys = ['layers', 'export', 'proj'];
    if (keys.indexOf(name) < 0) name = 'layers';
    state.rightTab = name;
    var tabs = $('mvRightTabs');
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll('[data-mv-tab]'), function (b) {
        var on = b.dataset.mvTab === name;
        cls(b, 'is-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.mv-right-pane[data-pane]'), function (p) {
      var on = p.getAttribute('data-pane') === name;
      cls(p, 'is-on', on);
      cls(p, 'hidden', !on);
    });
  }

  /* 舞台左上角的上下文条：模型名 + 视图/网格/相机/画布。 */
  function paintHud() {
    var box = $('mvStageHud');
    if (!box) return;
    if (!state.cur) { box.hidden = true; return; }
    box.hidden = false;
    var name = $('mvHudName'), meta = $('mvHudMeta');
    if (name) name.textContent = state.cur.name || '未命名';
    if (meta) {
      var L = MV.exportLayout(state.views.length, state.exSize, state.exGap, state.cols, state.compact);
      meta.textContent = state.views.length + ' 视图 · ' + L.cols + '×' + L.rows +
        ' · ' + (state.cam === 'ortho' ? '正交' : '透视') +
        ' · ' + (state.exSize >= 4096 ? '4K' : '2K') + '画布';
    }
  }

  function paint() {
    paintModels();
    paintPresets();
    paintViews();
    paintInfo();
    paintExport();
    paintHud();
    setRightTab(state.rightTab);
    MV.paintLayers();

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

    var rBtn = $('mvRender');
    if (rBtn) {
      rBtn.disabled = !state.cur || state.busy === 'render' || state.busy === 'loading';
      rBtn.textContent = state.busy === 'render' ? '渲染中…' : '重新渲染';
    }
    var pvBtn = $('mvPreview');
    if (pvBtn) pvBtn.disabled = !state.cur;
    /* AI 拆件要有模型才点得动：它要先分析 UV 岛、再读图，没模型时按钮亮着
     * 只会点出一句「先选一个模型」。 */
    var spBtn = $('mvSplit');
    if (spBtn) spBtn.disabled = !state.cur;

    paintPick();
    if (window.MVProject && MVProject.paint) MVProject.paint();
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
    var cellW = o.cellW || o.cell, cellH = o.cellH || o.cell;
    var stepX = cellW + o.gap, stepY = cellH + o.gap;
    var col = Math.floor(x / stepX);
    var row = Math.floor(y / stepY);
    if (col < 0 || row < 0 || col >= o.cols || row >= o.rows) return -1;
    // 点在格间距里不算任何一格
    if (x - col * stepX > cellW || y - row * stepY > cellH) return -1;
    var idx = row * o.cols + col;
    return idx < o.cells.length ? idx : -1;
  }

  MV.paintModels = paintModels;
  MV.seg = seg;
  MV.paintPresets = paintPresets;
  MV.paintViews = paintViews;
  MV.paintInfo = paintInfo;
  MV.fitStage = fitStage;
  MV.paintPick = paintPick;
  MV.paintExport = paintExport;
  MV.paint = paint;
  MV.setRightTab = setRightTab;
  MV.paintHud = paintHud;
  MV.cellAt = cellAt;
})();
