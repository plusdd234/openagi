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

  /* ---------- 参数表：唯一真源 ----------
   * 一个可调参数在这里声明一次，下面这些东西全由它生成：
   *   DEFAULTS / state 初值 / 存档读写 / 控件回填 / 事件绑定 / 渲染参数
   * 以前加一个参数要动 8 个地方（默认值、state、load/save/apply、sync、bind、传参），
   * 漏一处就是「A 处能配、B 处不生效」。
   *
   *   k        state 字段名，同时也是传给 viewGrid 的 opts 名
   *   def      默认值（数组会浅拷贝）
   *   ui       'check' | 'range' | 'color' | 'none'（none = 由 seg / chips 自己管）
   *   id       控件 id；label 是显示值的元素 id
   *   scale    控件值 = state 值 × scale（线宽用十分位、留白用百分比那类）
   *   div      state 值 ÷ div 才是渲染核要的（界面用 0~100，核要 0~1）
   *   pass     true = 传给 viewGrid；colorOnly = 只在彩色通道传（导出深度/遮罩时不带）
   *   ly       属于哪个图层（对应 LAYER_META 的 key）。写了它，控件就搬到那层的属性
   *            面板里；不写 = 画布级参数（列数 / 间距 / 留白 / 线宽）。这也是「哪层有
   *            参数、面板里放哪几个」的唯一真源，HTML 里不要再标一遍。
   *   txt      显示值怎么格式化
   *   onChange 绑定后的额外副作用（两个线框互斥、勾上就摊开这层的属性面板）
   */
  /* 颜色字段的存档校验：只认 #rrggbb，别把 'red' / 'rgba(...)' 放进来 */
  function isHex(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }

  /* ---------- 图层元信息 ----------
   * tag 只是显示用的角标（3D / 2D），**不再限制拖动**：任意两层都能互换。
   * 渲染核按 layerOrder 切段——相邻的 3D 层合成一段渲一次，2D 层夹在两次渲染之间。
   * 顺序真源是 state.layerOrder（**绘制先后**，先画的在前）；
   * 面板倒着显示（上层在上），跟 PS 的直觉一致。
   * d 是每层属性面板顶上那句说明：滑条名字都很短（「深度差」vs「深度范围」），
   * 没有这句过两天就分不清哪个是干嘛的。 */
  var LAYER_META = {
    grade:    { n: '后期处理', f: 'grade',      tag: '2D', fixed: 'top',
      d: '调最终输出图像的饱和度 / 对比度 / 亮度。它永远在最上面，不参与拖拽——放在中间就不是「后期」了。' },
    bg:       { n: '背景',     f: 'bg',         tag: '2D', fixed: 'bottom',
      d: '整幅铺一层纯色底（含格间距）。默认关着——这套图本来就是透明底、方便叠到别处。它固定在最底下：拖到模型上面会把模型整块盖掉。' },
    labels:   { n: '视图标签', f: 'labels',     tag: '2D',
      d: '每格左下角烘一个视角名。它是画上去的字，导出的 PNG 不带。' },
    dedge:    { n: '深度描边', f: 'depthEdge',  tag: '2D',
      d: '相邻像素的前后距离差超过阈值就描线。剪影之外还能描出遮挡边界和硬折角。' },
    outline:  { n: '外轮廓',   f: 'outline',    tag: '2D',
      d: '沿「模型 / 背景」的交界描一圈，纯剪影，不管物体内部结构。' },
    dgray:    { n: '深度灰',   f: 'depthGray',  tag: '2D',
      d: '把表面到相机的距离画成灰度（近白远黑），用来看前后层次。' },
    uvseam:   { n: 'UV 描边',  f: 'uvEdge',     tag: '3D',
      d: '沿 UV 岛边界画线：岛内部不画，只有被撕开的接缝才画。用来检查展 UV。' },
    crease:   { n: '角度线框', f: 'wireAngle',  tag: '3D',
      d: '只画折角大于阈值的边，按折角给粗细——结构线，不是全部骨架。' },
    wire:     { n: '线框',     f: 'wire',       tag: '3D',
      d: '所有边都画、粗细一致。跟「角度线框」是同一个开关的两档，只能开一个。' },
    uvisland: { n: 'UV 岛色',  f: 'uvIsland',   tag: '3D',
      d: '每只 UV 岛一个颜色，一眼看出 UV 切得碎不碎。' }
  };
  /* 绘制顺序（先画的在前）。深度灰排在线的下面：它是底色，线才是结构。
   * 半透明时下面那几层就会透出来——这才是图层该有的样子。
   * 末尾的 grade 是「后期处理」层：它永远在最上面，排序时会被强制甩到末尾。 */
  var LAYER_ORDER_DEF = ['bg', 'uvisland', 'dgray', 'wire', 'crease', 'uvseam', 'outline', 'dedge', 'labels', 'grade'];
  /* 老版本的默认顺序（深度灰在线的上面）。存档里如果还是这一份，静默换成新的：
   * 那是「深度灰强制盖住线」的旧行为，留着的话升级后灰度图上就没有线了。
   * 第二份是加了背景层、还没加后期处理层的中间版本，同样迁。 */
  var LAYER_ORDER_OLD = ['uvisland', 'wire', 'crease', 'uvseam', 'dgray', 'outline', 'dedge', 'labels'];
  var LAYER_ORDER_OLD2 = ['bg', 'uvisland', 'dgray', 'wire', 'crease', 'uvseam', 'outline', 'dedge', 'labels'];

  /* 每层默认不透明度（%）。键 = LAYER_META 的 k，加图层不用再来这里补一行 */
  function defaultOpacity() {
    var o = {};
    for (var k in LAYER_META) o[k] = 100;
    return o;
  }

  /* 存档里可能缺层（老版本存的）或带脏值：补齐 + 夹到 0~100 */
  function normalizeOpacity(raw) {
    var d = defaultOpacity();
    if (!raw || typeof raw !== 'object') return d;
    for (var k in d) {
      var v = Number(raw[k]);
      if (isFinite(v)) d[k] = Math.max(0, Math.min(100, Math.round(v)));
    }
    return d;
  }

  /* 参数默认值的深拷贝：数组和对象都要拷，否则改 state 会把 DEFAULTS 一起改掉 */
  function cloneDef(v) {
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
    return v;
  }

  /* 存档里的顺序可能缺层（老版本存的）或多层（改过名）：补默认、去重复。
   * 两个「固定位」：bg 永远在最底下（它是底色，盖住模型就没意义了），
   * grade 永远在最上面（它是后期处理，必须在所有层之后）。 */
  function normalizeLayerOrder(arr) {
    var out = [], seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (k) {
      if (LAYER_META[k] && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    LAYER_ORDER_DEF.forEach(function (k) {
      if (seen[k]) return;
      /* 背景补在最底下：老存档里没有这一层，补到末尾会变成「盖住一切」 */
      if (k === 'bg') out.unshift(k);
      else out.push(k);
    });
    /* 固定位收敛：不管存档里写在哪，背景在最底、后期处理在最上。
     * 背景被拖到模型上面 → 整块盖掉模型（用户会以为模型坏了）。 */
    var bi = out.indexOf('bg');
    if (bi > 0) { out.splice(bi, 1); out.unshift('bg'); }
    var gi = out.indexOf('grade');
    if (gi >= 0) { out.splice(gi, 1); out.push('grade'); }
    return out;
  }

  var FIELDS = [
    /* --- 视图与画布（chips / seg 自己管，不进通用绑定） --- */
    { k: 'views', def: ['front', 'back', 'left', 'right'], ui: 'none' },
    { k: 'mode',  def: 'solid', ui: 'none', pass: true,
      check: function (v) { return MODES.some(function (m) { return m.k === v; }); } },
    { k: 'cell',  def: 768, ui: 'none', int: true,
      check: function (v) { return SIZES.indexOf(Number(v)) >= 0; } },
    { k: 'cols',  def: 0, ui: 'none', int: true,
      check: function (v) { return COLS.some(function (m) { return m.k === Number(v); }); } },
    { k: 'cam',   def: 'ortho', ui: 'none', pass: true,
      check: function (v) { return CAMS.some(function (m) { return m.k === v; }); } },

    /* --- 布局 --- */
    { k: 'gap', def: 0, ui: 'range', id: 'mvGap', label: 'mvGapV', min: 0, max: 48, pass: true, int: true,
      txt: function (v) { return String(v); } },
    { k: 'margin', def: 1.08, ui: 'range', id: 'mvMargin', label: 'mvMarginV',
      min: 1, max: 1.6, scale: 100, pass: true,
      txt: function (v) { return String(Math.round(v * 100)); } },
    { k: 'lineWidth', def: 1.4, ui: 'range', id: 'mvLineW', label: 'mvLineWV',
      min: 0.4, max: 6, scale: 10, pass: true,
      txt: function (v) { return v.toFixed(1); } },

    /* --- 线框 --- */
    { k: 'wire', def: true, ui: 'check', id: 'mvWire', pass: true, colorOnly: true,
      onChange: function () {
        /* 两个线框互斥：角度线框是普通线框的子集，两盏一起点亮等于亮的还是普通线框 */
        if (state.wire && state.wireAngle) {
          state.wireAngle = false;
          var a = $('mvAngleWire'); if (a) a.checked = false;
        }
      } },
    { k: 'wireAngle', def: false, ui: 'check', id: 'mvAngleWire', pass: true, colorOnly: true,
      onChange: function () {
        if (state.wireAngle && state.wire) {
          state.wire = false;
          var w = $('mvWire'); if (w) w.checked = false;
        }
      } },
    { k: 'wireAngleDeg', def: 30, ui: 'range', id: 'mvWireAngle', label: 'mvWireAngleV', ly: 'crease',
      min: 0, max: 90, pass: true, colorOnly: true, int: true,
      txt: function (v) { return Math.round(v) + '°'; } },
    /* 角度线框的观感三件套：它跟普通线框是两套东西——普通线框是骨架（要均匀），
     * 角度线框是结构线（折得越狠越该醒目） */
    { k: 'creaseScale', def: 1, ui: 'range', id: 'mvCreaseWidth', label: 'mvCreaseWidthV', ly: 'crease',
      min: 0.2, max: 3, scale: 100, pass: true, colorOnly: true,
      txt: function (v) { return v.toFixed(1) + '×'; } },
    { k: 'creaseTaper', def: 50, ui: 'range', id: 'mvCreaseTaper', label: 'mvCreaseTaperV', ly: 'crease',
      min: 0, max: 100, div: 100, pass: true, colorOnly: true, int: true,
      txt: function (v) { return Math.round(v) + '%'; } },
    { k: 'creaseColor', def: '#2b2b2b', ui: 'color', id: 'mvCreaseColor', ly: 'crease', pass: true, colorOnly: true, check: isHex },

    /* --- UV 检查 --- */
    { k: 'uvEdge', def: false, ui: 'check', id: 'mvUvEdge', pass: true, colorOnly: true },
    /* UV 岛着色：每只岛一个颜色，检查展 UV 切得碎不碎 / 有没有该断没断 */
    { k: 'uvIsland', def: false, ui: 'check', id: 'mvUvIsland', pass: true, colorOnly: true },

    /* --- 描边 --- */
    { k: 'outline', def: false, ui: 'check', id: 'mvOutline', pass: true, colorOnly: true },

    /* --- 深度 --- */
    /* 深度描边：相邻像素深度差超过阈值就描。跟外轮廓不是一回事——外轮廓只认
     * 「模型 / 背景」的交界，物体内部的前后分界线只有深度能拿到。 */
    { k: 'depthEdge', def: false, ui: 'check', id: 'mvDepthEdge', pass: true, colorOnly: true },
    { k: 'depthEdgeThresh', def: 40, ui: 'range', id: 'mvDepthThresh', label: 'mvDepthThreshV', ly: 'dedge',
      min: 0, max: 100, pass: true, colorOnly: true, int: true,
      txt: function (v) { return fmtPct(v); } },
    /* 深度灰：把「模型表面到相机的距离」画成灰度（近白远黑）。灰度是面，
     * 线框照常叠在上面；外轮廓和标签在这个模式下不画（黑底上会糊）。 */
    { k: 'depthGray', def: false, ui: 'check', id: 'mvDepthGray', pass: true, colorOnly: true,
      onChange: function () {
        /* 勾上就把这层的属性面板摊开：滑条藏在面板里，不展开的话
         * 只看到一张灰图，不知道「深度范围」去哪里调。 */
        if (state.depthGray) { state.selLayer = 'dgray'; state.openLayer = 'dgray'; }
      } },
    { k: 'depthGrayRange', def: 100, ui: 'range', id: 'mvDepthGrayRange', label: 'mvDepthGrayRangeV', ly: 'dgray',
      min: 10, max: 100, div: 100, pass: true, int: true,
      txt: function (v) { return Math.round(v) + '%'; } },
    /* 「无限远」的颜色：背景和格间距都填它。默认黑跟「近白远黑」接得上 */
    { k: 'depthGrayBg', def: '#000000', ui: 'color', id: 'mvDepthGrayBg', ly: 'dgray', pass: true, check: isHex },

    /* --- 后期处理（永远最上面的一层） ---
     * 调的是**最终输出图像**：饱和度 / 对比度 / 亮度。
     * 三个值都用「倍数」口径：1 = 原样（饱和度、对比度），0 = 不变（亮度）。
     * 只在彩色通道生效——深度图 / 遮罩图是喂 AI 的数据，调色会把数值改坏。 */
    { k: 'grade', def: false, ui: 'check', id: 'mvGrade', pass: true, colorOnly: true,
      onChange: function () {
        if (state.grade) { state.selLayer = 'grade'; state.openLayer = 'grade'; }
      } },
    { k: 'gradeSat', def: 1, ui: 'range', id: 'mvGradeSat', label: 'mvGradeSatV', ly: 'grade',
      min: 0, max: 2, scale: 100, pass: true, colorOnly: true,
      txt: function (v) { return Math.round(v * 100) + '%'; } },
    { k: 'gradeContrast', def: 1, ui: 'range', id: 'mvGradeContrast', label: 'mvGradeContrastV', ly: 'grade',
      min: 0, max: 2, scale: 100, pass: true, colorOnly: true,
      txt: function (v) { return Math.round(v * 100) + '%'; } },
    { k: 'gradeBright', def: 0, ui: 'range', id: 'mvGradeBright', label: 'mvGradeBrightV', ly: 'grade',
      min: -1, max: 1, scale: 100, pass: true, colorOnly: true,
      txt: function (v) { return (v > 0 ? '+' : '') + Math.round(v * 100); } },

    /* --- 背景 --- */
    { k: 'bg', def: false, ui: 'check', id: 'mvBg', pass: true, colorOnly: true },
    { k: 'bgColor', def: '#ffffff', ui: 'color', id: 'mvBgColor', ly: 'bg',
      pass: true, colorOnly: true, check: isHex },

    /* --- 杂项 --- */
    { k: 'labels', def: true, ui: 'check', id: 'mvLabels', pass: true, colorOnly: true },
    { k: 'exSize', def: 2048, ui: 'none', int: true,
      check: function (v) { return EX_SIZES.indexOf(Number(v)) >= 0; } },
    { k: 'exGap', def: 0, ui: 'none', int: true,
      check: function (v) { return EX_GAPS.indexOf(Number(v)) >= 0; } },
    /* 图层绘制顺序（图层面板拖出来的结果）。数组，按「先画的在前」存 */
    { k: 'layerOrder', def: LAYER_ORDER_DEF, ui: 'none', pass: true,
      check: function (v) { return Array.isArray(v); } },
    /* 每层不透明度（%，键 = LAYER_META 的 k）。**不进 pass**：渲染核要的是
     * 0~1 的 layerOpacity，换算在 renderOpts 里统一做一次，免得核里再除一遍。 */
    { k: 'opacity', def: defaultOpacity(), ui: 'none',
      check: function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); },
      fix: normalizeOpacity }
  ];

  var DEFAULTS = {};
  FIELDS.forEach(function (f) { DEFAULTS[f.k] = cloneDef(f.def); });

  var state = {
    open: false,
    models: [],
    cur: null,            // { id, name, src }
    uv: null,             // 上一次描边的结果 { edges, hasUV, drawn }
    out: null,            // viewGrid 结果
    pick: -1,
    selLayer: '',         // 图层面板里选中的那一层（只影响参数区，不进存档）
    openLayer: '',        // 属性面板展开的是哪一层（同上，纯界面状态）
    busy: '',
    error: '',
    loaded: false
  };
  /* 渲染参数全部来自参数表：state 里不再手抄一遍默认值 */
  FIELDS.forEach(function (f) { state[f.k] = cloneDef(f.def); });

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

  /* 存档校验：按参数表里的类型 + min/max 走，特殊约束（枚举必须存在、颜色必须是
   * #rrggbb）用 f.check 钩子。以前每个字段一段 if，加字段必忘一处。 */
  function fieldValid(f, v) {
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
  }

  function loadSet() {
    var d = {};
    FIELDS.forEach(function (f) { d[f.k] = cloneDef(f.def); });
    try {
      var raw = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
      FIELDS.forEach(function (f) {
        var v = raw[f.k];
        if (v === undefined || !fieldValid(f, v)) return;
        d[f.k] = f.fix ? f.fix(v) : (f.int ? Math.round(v) : v);
      });
      /* 老版本的 mode='line'（白面 + 黑线）拆成了两个维度：面 = 纯色、线 = 勾上。
       * 迁移过来视觉上完全一样，不会让人以为设置丢了。 */
      if (raw.mode === 'line') { d.mode = 'solid'; d.wire = true; }
      /* 老存档的图层顺序如果是「上一版的默认」，换成这一版的默认。
       * 用户手动拖过（不等于旧默认）就尊重他的顺序，不动。 */
      if (Array.isArray(d.layerOrder) &&
        (d.layerOrder.join() === LAYER_ORDER_OLD.join() || d.layerOrder.join() === LAYER_ORDER_OLD2.join())) {
        d.layerOrder = LAYER_ORDER_DEF.slice();
      }
      /* 视图组要按 VIEW_ORDER 归一：老存档可能是任意顺序、也可能带着已删掉的视图 */
      if (Array.isArray(raw.views) && raw.views.length) {
        var v2 = VIEW_ORDER.filter(function (k) { return raw.views.indexOf(k) >= 0; });
        if (v2.length) d.views = v2;
      }
      /* ⚠ 图层顺序**必须**归一后才能用：存档里存的是「用户拖出来的 k 序列」，
       * 新加的层（bg / grade）在老存档里根本没有 → 渲染核排序时给它们的 rank 是 999
       * （= 最上层）→ 白色背景直接盖住整个模型。
       * 所以这里补齐：bg 补到最底下，grade 补到最上面。 */
      d.layerOrder = normalizeLayerOrder(d.layerOrder);
    } catch (e) { /* 坏数据就整份用默认，别让窗口打不开 */ }
    return d;
  }

  function saveSet() {
    var o = {};
    FIELDS.forEach(function (f) { o[f.k] = state[f.k]; });
    try { localStorage.setItem(SET_KEY, JSON.stringify(o)); } catch (e) { /* 配额满了不该让 UI 崩 */ }
  }

  function applySet(d) {
    FIELDS.forEach(function (f) {
      if (d[f.k] === undefined) return;
      state[f.k] = cloneDef(d[f.k]);
    });
    /* 存档里理论上不该两个线框都真，但手工改过 / 老配置可能这样：收敛到「角度线框」 */
    if (state.wire && state.wireAngle) state.wire = false;
    /* ⚠ 图层顺序在这里**再**归一一次，不只靠 loadSet：
     * applySet 是唯一把磁盘上的东西写进 state 的入口，只要有人绕过 loadSet
     * 调它（未来的导入 / 迁移 / 插件），顺序就可能没归一过 ——
     * 而「背景层不在最底」的后果是**白底盖住整个模型**（用户以为模型坏了）。
     * 归一是纯函数、幂等，多调一次没有代价。 */
    state.layerOrder = normalizeLayerOrder(state.layerOrder);
  }

  /* 渲染参数：表里 pass:true 的字段按名字直接对齐 viewGrid 的 opts。
   *   div       界面值 ÷ div 才是核要的（0~100 → 0~1）
   *   colorOnly 深度/遮罩通道一律传 false（那是喂 AI 的数据，线是脏东西）
   * 以前这份参数在「预览」和「导出」各写一遍，加字段必漏其中一处。 */
  function renderOpts(pass, layout) {
    var o = {
      views: state.views.slice(),
      cell: layout ? layout.cell : state.cell,
      cols: layout ? layout.cols : (state.cols || autoCols(state.views.length)),
      /* 底色永远透明：这套图的用途是叠到别处，带底还得再抠一遍 */
      transparent: pass === 'color',
      pass: pass
    };
    FIELDS.forEach(function (f) {
      if (!f.pass) return;
      var v = f.div ? state[f.k] / f.div : state[f.k];
      if (f.colorOnly && pass !== 'color') v = false;
      o[f.k] = v;
    });
    /* 每层不透明度：界面是 0~100 的百分数，渲染核要 0~1。
     * 预览和导出都走这里，所以「看着 50%、下载下来 100%」不会发生。 */
    o.layerOpacity = {};
    for (var lk in state.opacity) {
      o.layerOpacity[lk] = Math.max(0, Math.min(100, Number(state.opacity[lk]) || 0)) / 100;
    }
    /* 下面三条要盖在表循环之后：它们在表里也有 pass，但导出口径不同 */
    if (layout) {
      o.gap = state.exGap;          // 导出用导出间距，不是屏幕 grid 的间距
      o.labels = false;             // 导出图不烧标签：拿去当参考图时标签是脏像素
      if (pass !== 'color') o.mode = 'solid';   // 深度/遮罩只看轮廓，跟材质模式无关
    }
    return o;
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

  /* 拖动类控件的防抖。解析和几何现在都有缓存，一次渲染只要 ~45ms，
   * 所以这里不用再等 260ms —— 那是当年每次都要重新 parse 模型时的数值。 */
  var RENDER_DEBOUNCE = 110;
  function scheduleRender(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { render(); }, ms == null ? RENDER_DEBOUNCE : ms);
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
      var o = await Model3D.viewGrid(state.cur.src, renderOpts('color', null));
      state.out = o;
      state.stats = o.stats || null;
      state.uv = o.uv || null;
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

  /* 深度描边的滑条值 → 归一化深度差阈值（0.1% ~ 40% 的视锥深度跨度）。
   * 对数映射：两端跨 400 倍，线性映射会让前 80% 的行程都挤在「一片糊」里。
   * 这条式子跟渲染核 js/model3d.js 的 drawDepthEdges 必须一致，改一处要改两处。 */
  function depthThreshOf(v) {
    var t = Math.max(0, Math.min(100, Number(v) || 0));
    return 0.001 * Math.pow(400, t / 100);
  }

  /* 阈值显示成百分比：0.10% ~ 40%，小数位随量级收，别出现「0.0590%」这种 */
  function fmtPct(v) {
    var p = depthThreshOf(v) * 100;
    if (p >= 10) return p.toFixed(0) + '%';
    if (p >= 1) return p.toFixed(1) + '%';
    if (p >= 0.1) return p.toFixed(2) + '%';
    return p.toFixed(3) + '%';
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
      var o = await Model3D.viewGrid(state.cur.src, renderOpts(pass, L));
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
    /* 深度灰模式下颜色通道根本不渲，线框/描边的勾选状态是「存着但没画」，
     * 报在信息条上会让人以为坏了——这里只报深度灰自己的参数。 */
    if (state.depthGray) {
      el.textContent = o.cells.length + ' 张 · ' + o.width + '×' + o.height +
        ' · 单格 ' + o.cell + ' · 深度灰（近白远黑）· 范围 ' +
        Math.round(state.depthGrayRange) + '%';
      return;
    }
    var m = MODES.filter(function (x) { return x.k === state.mode; })[0];
    el.textContent = o.cells.length + ' 张 · ' + o.width + '×' + o.height +
      ' · 单格 ' + o.cell + ' · ' + (m ? m.n : state.mode) +
      (state.wireAngle
        ? ' + 角度线框 ≥' + Math.round(state.wireAngleDeg) + '°' +
          (Math.abs(state.creaseScale - 1) > 0.001 ? ' · ' + state.creaseScale.toFixed(1) + '×' : '') +
          (state.creaseTaper > 0 ? ' · 随角度 ' + Math.round(state.creaseTaper) + '%' : '') +
          (o.crease ? '（' + o.crease.edges + ' 条边）' : '')
        : (state.wire ? ' + 线框' : '')) +
      (state.uvIsland ? ' + UV 岛着色' + (o.uvisland ? '(' + o.uvisland.islands + ' 岛)' : '') : '') +
      (state.uvEdge ? (state.uv && state.uv.hasUV === false ? ' + UV 描边（模型无 UV）' : (state.uv && state.uv.drawn === false ? ' + UV 描边（无接缝）' : ' + UV 描边')) : '') +
      (state.outline ? ' + 外轮廓' : '') +
      (state.depthEdge ? ' + 深度描边 ≥' + fmtPct(state.depthEdgeThresh) : '') +
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

  /* ---------- 图层面板 ----------
   * 一行 = 一个效果。面板**倒着显示** state.layerOrder（上层在上，PS 直觉），
   * 同 tag 之间可以拖拽换序；跨 tag 拖不动（3D 必在 2D 之前，见 LAYER_META 注释）。
   * 眼睛驱动的是隐藏 input 的 checked —— state 仍然只有那一条写入口。 */
  function fieldOf(k) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].k === k) return FIELDS[i];
    return null;
  }

  /* 面板上的显示顺序 = 绘制顺序反过来（后画的在上） */
  function layerView() {
    return normalizeLayerOrder(state.layerOrder).slice().reverse();
  }

  /* 这一层有哪些数值参数（开关不算：开关就是行上那只眼睛）。
   * 顺序 = FIELDS 里的顺序，所以面板里的控件排布不用另外维护。 */
  function propsOf(k) {
    return FIELDS.filter(function (f) { return f.ly === k && f.ui && f.ui !== 'check'; });
  }

  /* 控件节点 = input 外面那层 .mv-field（整行带标签一起搬，不然只剩个滑条） */
  function fieldNode(f) {
    if (!f.id) return null;
    var el = $(f.id);
    if (!el) return null;
    return el.closest ? el.closest('.mv-field') : el.parentNode;
  }

  /* 把所有被搬进图层面板的控件收回池里。重建列表之前必须走一遍：
   * 设 innerHTML='' 会把面板连同里面的 input 一起扔掉，FIELDS 就再也找不到 id 了。 */
  function recycleProps() {
    var pool = $('mvPropPool');
    if (!pool) return;
    var nodes = document.querySelectorAll('.mv-ly-fields .mv-field');
    for (var i = 0; i < nodes.length; i++) pool.appendChild(nodes[i]);
  }

  /* 展开的那一层把它的控件搬进自己的面板，其余收回池里。
   * 搬节点而不是克隆：id 只能有一个，写入口也只能有一条。 */
  function syncProps() {
    var pool = $('mvPropPool');
    if (!pool) return;
    var open = state.openLayer || '';
    var panels = document.querySelectorAll('.mv-ly-props');
    for (var i = 0; i < panels.length; i++) {
      var k = panels[i].getAttribute('data-for');
      var isOpen = !!open && k === open;
      panels[i].hidden = !isOpen;
      cls(panels[i].previousElementSibling, 'is-open', isOpen);
      var offHint = panels[i].querySelector('.mv-ly-off-hint');
      if (offHint) offHint.hidden = !(isOpen && !state[LAYER_META[k].f]);
      if (!isOpen) {
        var inner = panels[i].querySelector('.mv-ly-fields');
        var kids = inner ? inner.querySelectorAll('.mv-field') : [];
        for (var j = 0; j < kids.length; j++) pool.appendChild(kids[j]);
        continue;
      }
      var box = panels[i].querySelector('.mv-ly-fields');
      if (!box) continue;
      propsOf(k).forEach(function (f) {
        var n = fieldNode(f);
        if (n) box.appendChild(n);       // 已经在里面就等价于挪到末尾，DOM 不会重复
      });
    }
  }

  function paintLayers() {
    var list = $('mvLayerList');
    if (!list) return;
    var view = layerView();

    /* 行按当前顺序排；数量不对就整片重建（拖拽过、或者存档里少一层） */
    if (list.children.length !== view.length * 2) {
      recycleProps();                    // 先救出控件，再清 DOM
      list.innerHTML = '';
      view.forEach(function (k) {
        var L = LAYER_META[k];
        var op = Math.round(state.opacity[k] == null ? 100 : state.opacity[k]);
        var row = document.createElement('div');
        row.className = 'mv-ly-item' + (L.fixed ? ' is-fixed' : '');
        row.setAttribute('data-ly', k);
        /* 固定位不给拖：后期处理层永远在最上面，背景层永远在最底下 */
        row.setAttribute('draggable', L.fixed ? 'false' : 'true');
        row.innerHTML = '<button type="button" class="mv-ly-eye" title="显示 / 隐藏这一层"></button>' +
          '<span class="mv-ly-name">' + esc(L.n) + '</span>' +
          '<span class="mv-ly-op-badge"' + (op >= 100 ? ' hidden' : '') + '>' + op + '%</span>' +
          '<span class="mv-ly-tag">' + L.tag + '</span>' +
          (L.fixed ? '<span class="mv-ly-lock" title="' +
            (L.fixed === 'bottom' ? '固定在最底层，不能拖动' : '固定在最上层，不能拖动') + '">' +
            (L.fixed === 'bottom' ? '底' : '顶') + '</span>' : '') +
          '<span class="mv-ly-caret" title="展开这一层的属性"></span>';
        list.appendChild(row);

        /* 每层一块自己的面板，紧跟在行下面（PS 里的「图层效果」那种形态）。
         * 控件是搬进来的，所以面板本身只有说明 + 一个空容器。
         * 不透明度是**每层都有**的，直接写死在面板里，不走 FIELDS 那套搬运。 */
        var props = document.createElement('div');
        props.className = 'mv-ly-props';
        props.setAttribute('data-for', k);
        props.hidden = true;
        props.innerHTML = '<div class="mv-ly-desc">' + esc(L.d || '') + '</div>' +
          /* 层关着的时候面板照样能调（先调好再打开是常用顺序），
           * 但得说清楚「现在看不到效果」，并给一个就地打开的入口。 */
          '<button type="button" class="mv-ly-off-hint" hidden>这一层是关着的 · 点这里打开</button>' +
          '<div class="mv-field mv-op">' +
            '<span>不透明度</span>' +
            '<input type="range" class="mv-op-range" data-ly-op="' + k + '" min="0" max="100" step="1" value="' + op + '">' +
            '<b class="mv-op-val">' + op + '%</b>' +
          '</div>' +
          '<div class="mv-ly-fields"></div>';
        list.appendChild(props);
      });
      bindLayerDrag(list);
    } else {
      /* 顺序变了（拖完）但数量没变：按 view 重排，不重建节点（保住 hover / 选中）。
       * 行和它的面板是一对，得成对搬，否则面板会跑到别的层下面去。 */
      view.forEach(function (k) {
        var row = list.querySelector('.mv-ly-item[data-ly="' + k + '"]');
        var props = list.querySelector('.mv-ly-props[data-for="' + k + '"]');
        if (row) list.appendChild(row);
        if (props) list.appendChild(props);
      });
    }

    view.forEach(function (k) {
      var L = LAYER_META[k];
      var row = list.querySelector('.mv-ly-item[data-ly="' + k + '"]');
      if (!row) return;
      cls(row, 'is-on', !!state[L.f]);
      cls(row, 'is-sel', state.selLayer === k);
      cls(row, 'is-open', state.openLayer === k);
      paintOpBadge(row, k);
    });
    syncProps();
  }

  /* 行上那个「50%」小标：满不透明时不显示（8 行全挂着 100% 纯属噪音） */
  function paintOpBadge(row, k) {
    if (!row) return;
    var badge = row.querySelector('.mv-ly-op-badge');
    if (!badge) return;
    var v = Math.round(state.opacity[k] == null ? 100 : state.opacity[k]);
    badge.textContent = v + '%';
    badge.hidden = v >= 100;
  }

  /* 面板里的不透明度滑条回填（第二次打开窗口时行是复用的，得刷一遍） */
  function syncOpacityUI() {
    var nodes = document.querySelectorAll('.mv-op-range');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-ly-op');
      if (!k) continue;
      var v = Math.round(state.opacity[k] == null ? 100 : state.opacity[k]);
      nodes[i].value = v;
      var b = nodes[i].parentNode.querySelector('.mv-op-val');
      if (b) b.textContent = v + '%';
      paintOpBadge(nodes[i].closest('.mv-ly-props').previousElementSibling, k);
    }
  }

  /* 点行：眼睛 = 开关，别处 = 选中。点击绑在容器上（事件委托），
   * 这样重排/重建都不用重新绑。 */
  function bindLayerDrag(list) {
    list.addEventListener('click', function (e) {
      /* 面板里的「这层是关着的」提示条：点一下就打开这一层 */
      var hint = e.target && e.target.closest ? e.target.closest('.mv-ly-off-hint') : null;
      if (hint) {
        var pk = hint.parentNode && hint.parentNode.getAttribute('data-for');
        var pf = pk && LAYER_META[pk] ? fieldOf(LAYER_META[pk].f) : null;
        var pb = pf && pf.id ? $(pf.id) : null;
        if (pb) { pb.checked = true; pb.dispatchEvent(new Event('change')); }
        return;
      }
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      var k = row.getAttribute('data-ly');
      var L = LAYER_META[k];
      if (!L) return;
      if (e.target.classList && e.target.classList.contains('mv-ly-eye')) {
        var f = fieldOf(L.f);
        var box = f && f.id ? $(f.id) : null;
        if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); }
        return;
      }
      /* 点行本身 = 展开/收起这一层自己的属性面板（展开的同时选中）。
       * 判断依据用 openLayer 而不是 selLayer：眼睛关掉一层会收起面板但保留高亮，
       * 那时若按 selLayer 判断，再点这一行会变成「取消选中」，看起来像点不动。
       * 每层都至少有不透明度，所以每层都能展开。 */
      if (state.openLayer === k) {
        state.openLayer = '';
        state.selLayer = '';
      } else {
        state.openLayer = k;
        state.selLayer = k;
      }
      paintLayers();
    });

    /* 面板里的「不透明度」滑条：也是事件委托（面板会被重建）。
     * 它不属于 FIELDS 那套一维字段，所以单独接；但落盘/重渲的口径跟别的滑条一样。 */
    list.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute || !el.getAttribute('data-ly-op')) return;
      var k = el.getAttribute('data-ly-op');
      var v = Math.max(0, Math.min(100, Math.round(Number(el.value) || 0)));
      if (!state.opacity) state.opacity = defaultOpacity();
      state.opacity[k] = v;
      var b = el.parentNode.querySelector('.mv-op-val');
      if (b) b.textContent = v + '%';
      paintOpBadge(el.closest('.mv-ly-props').previousElementSibling, k);
      saveSet(); scheduleRender();
    });

    /* 拖拽换序：只有同 tag（3D 之间 / 2D 之间）能换。
     * 跨 tag 时 dragover 不 preventDefault，浏览器自己就显示「禁止」光标。 */
    var dragK = '';
    list.addEventListener('dragstart', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      var k = row.getAttribute('data-ly');
      /* 固定位不给拖：后期处理层永远在最上面，背景层永远在最底下 */
      if (!k || !LAYER_META[k] || LAYER_META[k].fixed) { e.preventDefault(); return; }
      dragK = k;
      row.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragK); } catch (err) {}
      }
    });
    list.addEventListener('dragend', function () {
      dragK = '';
      var rows = list.querySelectorAll('.mv-ly-item');
      for (var i = 0; i < rows.length; i++) {
        cls(rows[i], 'is-dragging', false);
        cls(rows[i], 'is-drop-before', false);
        cls(rows[i], 'is-drop-after', false);
      }
    });
    list.addEventListener('dragover', function (e) {
      if (!dragK) return;
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      var k = row.getAttribute('data-ly');
      if (!k || !LAYER_META[k]) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var r = row.getBoundingClientRect();
      var after = e.clientY > r.top + r.height / 2;
      var rows = list.querySelectorAll('.mv-ly-item');
      for (var i = 0; i < rows.length; i++) {
        cls(rows[i], 'is-drop-before', false);
        cls(rows[i], 'is-drop-after', false);
      }
      cls(row, after ? 'is-drop-after' : 'is-drop-before', true);
    });
    list.addEventListener('drop', function (e) {
      if (!dragK) return;
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      e.preventDefault();
      var k = row.getAttribute('data-ly');
      if (!k) return;
      var r = row.getBoundingClientRect();
      var after = e.clientY > r.top + r.height / 2;
      moveLayer(dragK, k, after);
      dragK = '';
    });
  }

  /* 把 src 插到 dst 的前/后。返回 false = 同一个 / 认不出的层。
   * 3D 与 2D 之间**也能换**：渲染核会把相邻的 3D 层合成一段、渲完落到 2D 画布，
   * 中间的 2D 层插在两次渲染之间，所以顺序是真的。
   * 代价只有一个：交错的段数越多，每段多一次全屏渲染（默认顺序只有一段，不额外花钱）。 */
  function moveLayer(src, dst, after) {
    if (!src || !dst || src === dst) return false;
    if (!LAYER_META[src] || !LAYER_META[dst]) return false;
    /* 固定位不参与换序：后期处理层必须永远在最上面，背景层必须永远在最底下 */
    if (LAYER_META[src].fixed || LAYER_META[dst].fixed) return false;
    var view = layerView();
    var a = view.indexOf(src);
    var b = view.indexOf(dst);
    if (a < 0 || b < 0) return false;
    view.splice(a, 1);
    b = view.indexOf(dst);
    view.splice(after ? b + 1 : b, 0, src);
    state.layerOrder = view.slice().reverse();   // 存回「先画的在前」
    saveSet(); paintLayers(); render();
    return true;
  }

  /* 状态字段名 → 图层 key（'depthEdge' → 'dedge'）。图层表是唯一真源，反查一次即可，
   * 不在别处再维护一份对照。 */
  function layerKeyOf(f) {
    for (var k in LAYER_META) if (LAYER_META[k].f === f) return k;
    return '';
  }

  /* 关了某一层就顺手收起它的面板：眼睛亮不亮和面板开不开是两件事，
   * 但「关掉了还摊着一排参数」很容易以为它还生效。 */
  function closePropsIf(k) {
    if (k && state.openLayer === k) state.openLayer = '';
  }

  function paint() {
    paintModels();
    paintPresets();
    paintViews();
    paintInfo();
    paintExport();
    paintLayers();

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

    /* 控件绑定：全部按参数表生成。互斥（两个线框）、勾上自动展开这一层的属性
     * 这类业务副作用写在各自字段的 onChange 里，不再散在这一大段。 */
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
        Model3D.openPreview(state.cur.src, { title: state.cur.name, uvEdge: state.uvEdge }).catch(function (e) {
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

  /* ---------- 打开 / 关闭 ---------- */

  async function open() {
    var win = $('mvWin');
    if (!win) return false;
    /* 顺序很重要：applySet 先把存档灌进 state，bind 里的 syncInputs / seg 才有真值可用。
     * 反过来（旧写法）会让勾选框、滑杆显示**默认值**而渲染按存档值走——
     * 用户以为没勾上、图里却有线，是最难自查的一类不同步。 */
    applySet(loadSet());
    bind();
    /* bind 有 bound 守卫，第二次 open 不会再跑，syncInputs 也就不会回填；
     * 这里每次都同步一遍：存档 → 控件显示，永远跟渲染用的 state 一致。 */
    syncInputs();
    /* 图层选中/展开是纯界面状态，不进存档：关掉再打开不该停在上次选的那层 */
    state.selLayer = '';
    state.openLayer = '';

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
    _pure: { autoCols, fmtMB, viewName, countLabel, exportLayout, fmtN, depthThreshOf, fmtPct,
      normalizeLayerOrder },
    /* 参数表本身：测试要拿它校验「表里声明的控件 id 在两份壳里都存在」 */
    _fields: FIELDS
  };
})();
