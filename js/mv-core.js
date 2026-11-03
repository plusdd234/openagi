/* ============================================================
 * 多视图 App · 基础层（mv-core）
 *
 * 只放「谁都能用、且不依赖别的模块」的东西：常量表、纯函数、
 * 以及几个到处都是的小工具（$ / cls / esc）。
 * 这里**不碰 state**，也不碰任何 UI——拆模块的第一刀就从这里切。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV = window.MV || {};

  MV.SET_KEY = 'hf_mv_set';

  /* 视图顺序只在这里定义；真正的方向表在 Model3D.VIEWS，前端不抄第二份 */
  MV.VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'isoAlt'];

  MV.PRESETS = [
    { k: 'three', n: '三视图', v: ['front', 'left', 'right'] },
    { k: 'four',  n: '四视图', v: ['front', 'back', 'left', 'right'] },
    { k: 'six',   n: '六视图', v: ['front', 'back', 'left', 'right', 'top', 'bottom'] },
    { k: 'all',   n: '八视图', v: MV.VIEW_ORDER.slice() }
  ];

  /* 「线框」不再是模式之一，而是一个独立开关（见 FIELDS.wire）。
   * 模式只决定**面**怎么填：素模打光 / 自带材质 / 纯白平涂。
   * 这样「素模 + 线框」「材质 + 线框」才成立——四选一的做法做不到。 */
  MV.MODES = [
    { k: 'shaded',   n: '素模', t: '中性灰打光，最接近建模参考图' },
    { k: 'material', n: '材质', t: '模型自带的材质与贴图' },
    { k: 'solid',    n: '纯色', t: '平涂白面，不加明暗' }
  ];

  MV.CAMS = [
    { k: 'ortho', n: '正交', t: '各格比例一致，多视图必须正交' },
    { k: 'persp', n: '透视', t: '近大远小，适合出效果图' }
  ];

  /* 画布尺寸固定正方形（对齐 AI 生图 / AIGC工具包 的 2K·4K 口径）：
   * 预览和导出用的是同一张正方形画布，单格由布局算出来，不再单独挑。 */
  MV.EX_SIZES = [2048, 4096];
  MV.EX_GAPS = [0, 16, 32, 64];

  MV.COLS = [{ k: 0, n: '自动' }, { k: 2, n: '2 列' }, { k: 3, n: '3 列' }, { k: 4, n: '4 列' }];

  /* ---------- 小工具 ---------- */

  MV.$ = function (id) { return document.getElementById(id); };

  MV.cls = function (el, name, on) { if (el) el.classList[on ? 'add' : 'remove'](name); };

  MV.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  MV.fmtMB = function (b) {
    var n = Number(b) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  };

  /* 自动列数：先少空格，再接近正方，同分取大的列（宽屏更顺眼）。
   * 直接拿 ceil(√n) 会把 8 视图排成 3×3（右下空一格），比 4×2 难看得多。 */
  MV.autoCols = function (n) {
    n = Math.max(1, Math.min(16, Math.round(Number(n) || 1)));
    if (n === 1) return 1;
    var best = 1, bestScore = Infinity;
    for (var c = 1; c <= n; c++) {
      var r = Math.ceil(n / c);
      var score = (c * r - n) * 100 + Math.abs(c - r);
      if (score < bestScore || (score === bestScore && c > best)) { bestScore = score; best = c; }
    }
    return best;
  };

  MV.viewName = function (k) {
    var t = (window.Model3D && Model3D.VIEWS) || {};
    return (t[k] && t[k].name) || k;
  };

  MV.countLabel = function (n) {
    if (n === 1) return '单视图';
    if (n === 2) return '双视图';
    return n + ' 视图';
  };

  MV.friendly = function (e) {
    var m = String((e && e.message) || e || '未知错误');
    if (/three\.js 未就绪/.test(m)) return '3D 组件还没加载完，稍等一下再试';
    if (/包围盒为空/.test(m)) return '这个模型没有可渲染的网格（可能是空文件或纯点线）';
    if (/没有可渲染的网格/.test(m)) return '这个模型里没有网格，只有空节点';
    if (/画布过大/.test(m)) return '尺寸太大，画布撑爆了——换成 2K 画布或减少视图数量';
    if (/Failed to fetch|NetworkError/.test(m)) return '模型读不出来：文件可能已丢失，重新导入一次';
    return m;
  };

  /* 颜色字段的存档校验：只认 #rrggbb，别把 'red' / 'rgba(...)' 放进来 */
  MV.isHex = function (v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); };

  /* 参数默认值的深拷贝：数组和对象都要拷，否则改 state 会把 DEFAULTS 一起改掉 */
  MV.cloneDef = function (v) {
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
    return v;
  };

  MV.fmtN = function (n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  /**
   * 画布布局（纯逻辑，测试直接调）：画布固定正方形，格子铺满。
   * cell = (size - gap*(cols-1)) / cols 向下取整并保持偶数（与渲染核口径一致），
   * 画布永远 size×size —— AI 生图回流时按同一尺寸出图才能逐像素对齐。
   * gap 不限定枚举：预览用的是「间距」滑条（0–48），导出用的是导出面板的下拉。
   *
   * compact=true（「一键紧凑」）：格子改成矩形，宽 = size/列数、高 = size/行数，
   * 网格正好铺满正方形画布——2 视图时每格 1:2，不再上下留两条大黑边。
   * 非紧凑时仍是原来的正方形格（cellW = cellH = cell），老行为完全不变。
   */
  MV.exportLayout = function (nViews, size, gap, colsOpt, compact) {
    nViews = Math.max(1, Math.min(16, Math.round(Number(nViews) || 1)));
    size = MV.EX_SIZES.indexOf(Number(size)) >= 0 ? Number(size) : 2048;
    gap = Math.max(0, Math.min(256, Math.round(Number(gap) || 0)));
    var cols = Math.round(Number(colsOpt) || 0);
    if (cols < 1) cols = MV.autoCols(nViews);
    cols = Math.min(cols, nViews);
    var rows = Math.ceil(nViews / cols);
    var cellW, cellH;
    if (compact) {
      cellW = Math.floor((size - gap * (cols - 1)) / cols);
      cellH = Math.floor((size - gap * (rows - 1)) / rows);
      if (cellW % 2) cellW -= 1;
      if (cellH % 2) cellH -= 1;
    } else {
      var cell = Math.floor((size - gap * (cols - 1)) / cols);
      if (cell % 2) cell -= 1;
      cellW = cellH = cell;
    }
    /* cell 保留旧字段名（= 宽），老代码和测试只认它时行为不变 */
    return {
      cols: cols, rows: rows, cell: cellW, cellW: cellW, cellH: cellH,
      gap: gap, w: size, h: size, compact: !!compact
    };
  };

  /* 单格尺寸文案：正方形只报一个数，矩形报「宽×高」 */
  MV.cellTxt = function (w, h) {
    w = Math.round(Number(w) || 0);
    h = Math.round(Number(h) || 0);
    return (w && h && w !== h) ? (w + '×' + h) : String(w || h);
  };

  /* 深度描边的滑条值 → 归一化深度差阈值（0.1% ~ 40% 的视锥深度跨度）。
   * 对数映射：两端跨 400 倍，线性映射会让前 80% 的行程都挤在「一片糊」里。
   * 这条式子跟渲染核 js/model3d.js 的 drawDepthEdges 必须一致，改一处要改两处。 */
  MV.depthThreshOf = function (v) {
    var t = Math.max(0, Math.min(100, Number(v) || 0));
    return 0.001 * Math.pow(400, t / 100);
  };

  /* 阈值显示成百分比：0.10% ~ 40%，小数位随量级收，别出现「0.0590%」这种 */
  MV.fmtPct = function (v) {
    var p = MV.depthThreshOf(v) * 100;
    if (p >= 10) return p.toFixed(0) + '%';
    if (p >= 1) return p.toFixed(1) + '%';
    if (p >= 0.1) return p.toFixed(2) + '%';
    return p.toFixed(3) + '%';
  };

  /* 存档校验：按参数表里的类型 + min/max 走，特殊约束（枚举必须存在、颜色必须是
   * #rrggbb）用 f.check 钩子。以前每个字段一段 if，加字段必忘一处。 */
  MV.fieldValid = function (f, v) {
    if (f.check) return !!f.check(v);
    if (typeof f.def === 'boolean') return typeof v === 'boolean';
    if (typeof f.def === 'number') {
      if (typeof v !== 'number' || !isFinite(v)) return false;
      if (f.min != null && v < f.min) return false;
      if (f.max != null && v > f.max) return false;
      return true;
    }
    if (typeof f.def === 'string') return typeof v === 'string' && v.length <= 64;
    if (Array.isArray(f.def)) return Array.isArray(v);
    return false;
  };
})();
