/* ============================================================
 * 多视图 App · 参数与状态（mv-state）
 *
 * 参数表 FIELDS 是**唯一真源**：默认值 / state 初值 / 存档读写 / 控件回填 /
 * 事件绑定 / 传给渲染核的参数，全由它生成。以前加一个参数要动 8 个地方，
 * 漏一处就是「A 处能配、B 处不生效」。
 *
 * 字段说明：
 *   k        state 字段名，同时也是传给 viewGrid 的 opts 名
 *   def      默认值（数组会浅拷贝）
 *   ui       'check' | 'range' | 'color' | 'none'（none = 由 seg / chips 自己管）
 *   id       控件 id；label 是显示值的元素 id
 *   scale    控件值 = state 值 × scale（线宽用十分位、留白用百分比那类）
 *   div      state 值 ÷ div 才是渲染核要的（界面用 0~100，核要 0~1）
 *   pass     true = 传给 viewGrid；colorOnly = 只在彩色通道传（导出深度/遮罩时不带）
 *   ly       属于哪个图层（对应 LAYER_META 的 key）。写了它，控件就搬到那层的属性
 *            面板里；不写 = 画布级参数（列数 / 间距 / 留白 / 线宽）。
 *   txt      显示值怎么格式化
 *   onChange 绑定后的额外副作用（两个线框互斥、勾上就摊开这层的属性面板）
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-state.js 必须在 mv-core.js / mv-layers.js 之后加载');
  var $ = MV.$;
  var MODES = MV.MODES;
  var COLS = MV.COLS;
  var CAMS = MV.CAMS;

  /* 纯界面状态（selected / openLayer / busy / error）不进存档；
   * 渲染参数全部来自参数表，state 里不再手抄一遍默认值。 */
  var state = MV.state = {
    open: false,
    models: [],
    cur: null,            // { id, name, src }
    uv: null,             // 上一次描边的结果 { edges, hasUV, drawn }
    out: null,            // viewGrid 结果
    pick: -1,
    selLayer: '',         // 图层面板里选中的那一层（只影响参数区，不进存档）
    openLayer: '',        // 属性面板展开的是哪一层（同上，纯界面状态）
    rightTab: 'layers',   // 右栏当前页签：layers / export / proj（纯界面状态）
    proj: null,           // 投射纹理结果 { png, canvas, size, painted, occCount, pct, islands, perView, root }
    projSrc: null,        // 上一次导入的生图 { dataUrl, name, w, h }：支持改参数重新投射
    projProg: null,       // 投射进度 { pct, txt }
    busy: '',
    error: '',
    loaded: false
  };

  var FIELDS = MV.FIELDS = [
    /* --- 视图与画布（chips / seg 自己管，不进通用绑定） --- */
    { k: 'views', def: ['front', 'back', 'left', 'right'], ui: 'none' },
    { k: 'mode',  def: 'solid', ui: 'none', pass: true,
      check: function (v) { return MODES.some(function (m) { return m.k === v; }); } },
    { k: 'cols',  def: 0, ui: 'none', int: true,
      check: function (v) { return COLS.some(function (m) { return m.k === Number(v); }); } },
    /* 一键紧凑：格子改矩形、网格铺满正方形画布（UI 由 mvCompacts 分段按钮管） */
    { k: 'compact', def: false, ui: 'none' },
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
    { k: 'creaseColor', def: '#2b2b2b', ui: 'color', id: 'mvCreaseColor', ly: 'crease', pass: true, colorOnly: true, check: MV.isHex },

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
      txt: function (v) { return MV.fmtPct(v); } },
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
    { k: 'depthGrayBg', def: '#000000', ui: 'color', id: 'mvDepthGrayBg', ly: 'dgray', pass: true, check: MV.isHex },

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
      pass: true, colorOnly: true, check: MV.isHex },

    /* --- 杂项 --- */
    { k: 'labels', def: true, ui: 'check', id: 'mvLabels', pass: true, colorOnly: true },
    { k: 'exSize', def: 2048, ui: 'none', int: true,
      check: function (v) { return MV.EX_SIZES.indexOf(Number(v)) >= 0; } },
    { k: 'exGap', def: 0, ui: 'none', int: true,
      check: function (v) { return MV.EX_GAPS.indexOf(Number(v)) >= 0; } },
    /* 图层绘制顺序（图层面板拖出来的结果）。数组，按「先画的在前」存 */
    { k: 'layerOrder', def: MV.LAYER_ORDER_DEF, ui: 'none', pass: true,
      check: function (v) { return Array.isArray(v); } },
    /* 每层不透明度（%，键 = LAYER_META 的 k）。**不进 pass**：渲染核要的是
     * 0~1 的 layerOpacity，换算在 renderOpts 里统一做一次，免得核里再除一遍。 */
    { k: 'opacity', def: MV.defaultOpacity(), ui: 'none',
      check: function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); },
      fix: MV.normalizeOpacity }
  ];

  /* 渲染参数全部来自参数表：state 里不再手抄一遍默认值 */
  FIELDS.forEach(function (f) { state[f.k] = MV.cloneDef(f.def); });

  /* ---------- 设置持久化 ---------- */

  function loadSet() {
    var d = {};
    FIELDS.forEach(function (f) { d[f.k] = MV.cloneDef(f.def); });
    try {
      var raw = JSON.parse(localStorage.getItem(MV.SET_KEY) || '{}') || {};
      FIELDS.forEach(function (f) {
        var v = raw[f.k];
        if (v === undefined || !MV.fieldValid(f, v)) return;
        d[f.k] = f.fix ? f.fix(v) : (f.int ? Math.round(v) : v);
      });
      /* 老版本的 mode='line'（白面 + 黑线）拆成了两个维度：面 = 纯色、线 = 勾上。
       * 迁移过来视觉上完全一样，不会让人以为设置丢了。 */
      if (raw.mode === 'line') { d.mode = 'solid'; d.wire = true; }
      /* 老存档的图层顺序如果是「上一版的默认」，换成这一版的默认。
       * 用户手动拖过（不等于旧默认）就尊重他的顺序，不动。 */
      if (Array.isArray(d.layerOrder) &&
        (d.layerOrder.join() === MV.LAYER_ORDER_OLD.join() || d.layerOrder.join() === MV.LAYER_ORDER_OLD2.join())) {
        d.layerOrder = MV.LAYER_ORDER_DEF.slice();
      }
      /* 视图组要按 VIEW_ORDER 归一：老存档可能是任意顺序、也可能带着已删掉的视图 */
      if (Array.isArray(raw.views) && raw.views.length) {
        var v2 = MV.VIEW_ORDER.filter(function (k) { return raw.views.indexOf(k) >= 0; });
        if (v2.length) d.views = v2;
      }
      /* ⚠ 图层顺序**必须**归一后才能用：存档里存的是「用户拖出来的 k 序列」，
       * 新加的层（bg / grade）在老存档里根本没有 → 渲染核排序时给它们的 rank 是 999
       * （= 最上层）→ 白色背景直接盖住整个模型。
       * 所以这里补齐：bg 补到最底下，grade 补到最上面。 */
      d.layerOrder = MV.normalizeLayerOrder(d.layerOrder);
    } catch (e) { /* 坏数据就整份用默认，别让窗口打不开 */ }
    return d;
  }

  function saveSet() {
    var o = {};
    FIELDS.forEach(function (f) { o[f.k] = state[f.k]; });
    try { localStorage.setItem(MV.SET_KEY, JSON.stringify(o)); } catch (e) { /* 配额满了不该让 UI 崩 */ }
  }

  /* 「恢复默认参数」：只重置带控件的参数与每层不透明度。
   * 不改视图组 / 相机 / 画布列数（那是工作区选择，不是参数），
   * 也不动图层顺序（用户手动拖过的顺序要保留）。 */
  function resetSet() {
    FIELDS.forEach(function (f) {
      if (f.ui === 'none') return;
      state[f.k] = MV.cloneDef(f.def);
    });
    state.opacity = MV.defaultOpacity();
    if (state.wire && state.wireAngle) state.wire = false;
    saveSet();
  }
  MV.resetSet = resetSet;

  function applySet(d) {
    FIELDS.forEach(function (f) {
      if (d[f.k] === undefined) return;
      state[f.k] = MV.cloneDef(d[f.k]);
    });
    /* 存档里理论上不该两个线框都真，但手工改过 / 老配置可能这样：收敛到「角度线框」 */
    if (state.wire && state.wireAngle) state.wire = false;
    /* ⚠ 图层顺序在这里**再**归一一次，不只靠 loadSet：
     * applySet 是唯一把磁盘上的东西写进 state 的入口，只要有人绕过 loadSet
     * 调它（未来的导入 / 迁移 / 插件），顺序就可能没归一过 ——
     * 而「背景层不在最底」的后果是**白底盖住整个模型**（用户以为模型坏了）。
     * 归一是纯函数、幂等，多调一次没有代价。 */
    state.layerOrder = MV.normalizeLayerOrder(state.layerOrder);
  }

  /* 渲染参数：表里 pass:true 的字段按名字直接对齐 viewGrid 的 opts。
   *   div       界面值 ÷ div 才是核要的（0~100 → 0~1）
   *   colorOnly 深度/遮罩通道一律传 false（那是喂 AI 的数据，线是脏东西）
   * 以前这份参数在「预览」和「导出」各写一遍，加字段必漏其中一处。
   * layout    画布布局（exportLayout 的结果）：预览和导出都按正方形画布走，
   *           预览只比导出多烧一层视图标签。
   * forExport 导出图不烧标签；深度/遮罩通道与材质模式无关。 */
  function renderOpts(pass, layout, forExport) {
    var o = {
      views: state.views.slice(),
      /* cell 是「单格宽」，老参数名；紧凑模式下宽高不同，另传 cellW / cellH */
      cell: layout ? layout.cell : 768,
      cellW: layout ? (layout.cellW || layout.cell) : 768,
      cellH: layout ? (layout.cellH || layout.cell) : 768,
      cols: layout ? layout.cols : (state.cols || MV.autoCols(state.views.length)),
      /* 底色永远透明：这套图的用途是叠到别处，带底还得再抠一遍 */
      transparent: pass === 'color',
      pass: pass,
      /* 画布始终是 2K/4K 正方形：紧凑模式下网格铺满，否则网格居中含白边 */
      canvasSize: layout ? layout.w : 0
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
    /* 间距从 layout 来：预览用画布区「间距」滑条，导出用导出面板的间距 */
    if (layout) o.gap = layout.gap;
    if (forExport) {
      o.labels = false;             // 导出图不烧标签：拿去当参考图时标签是脏像素
      if (pass !== 'color') o.mode = 'solid';   // 深度/遮罩只看轮廓，跟材质模式无关
    }
    return o;
  }

  MV.loadSet = loadSet;
  MV.saveSet = saveSet;
  MV.applySet = applySet;
  MV.renderOpts = renderOpts;
})();
