/* 建模 App：常驻编辑窗口（外壳层 ⑨，M2 版）
 *
 * M2 在 M1 的「文档 + 网格内核」之上补齐视口层：
 *   - 渲染：实体面 + 拓扑边线（LineSegments）+ 顶点（Points），三种着色模式
 *   - 导航：Alt + 左/中/右键 = 环绕 / 平移 / 推拉；滚轮推拉
 *   - ViewCube：单击面切正视图，拖拽环绕，双击回默认轴测
 *   - 四视图：同一 scene / 同一文档，用四个正交相机 scissor 分屏，不另建模型
 *
 * 仍然刻意不碰：点/边/面拾取与选择集（M3）、挤出等拓扑算子（M6）、
 * 修改器栈 UI（P3）、材质编辑器（P3-3）。
 *
 * 对外（window.modelDesk）：
 *   open() / openAsset(id) / newDocument() / save() / undo() / redo()
 *   getDocument() / getState()
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var TEX_KEY = 'openagi_model_tex_v1';
  var LAST_KEY = 'openagi_modeldesk_last';
  var HISTORY_BUDGET = 64 * 1024 * 1024;
  var $ = function (id) { return document.getElementById(id); };

  var st = {
    host: null, stage: null, canvas: null, overlay: null, statusEl: null, hudEl: null,
    renderer: null, scene: null, camera: null, controls: null, gizmo: null,
    doc: null, node: null, mesh: null, pivot: null,
    running: false, raf: 0, resizeObs: null,
    mode: 'translate', space: 'world', snap: false,
    rightTab: 'props', outlineQuery: '', showGrid: true, gridHelper: null,
    shading: 'shaded-wire', quad: false, quadCams: null, viewName: '透视',
    /* 单独显示（隔离所选）：只影响视口，不写文档里的 node.visible */
    isolate: false,
    /* 右侧工具箱两个页签：建模 / 绘画。绘画 = 把笔刷颜色直接画进当前材质槽的基础色贴图 */
    tbKind: 'model',
    paint: {
      brush: 'soft', size: 42, opacity: 90, color: '#d94f4f',
      /* mask = 只画进落笔所在的 UV 岛（stroke 开始时按岛的多边形给 2D 上下文加 clip） */
      mask: false,
      stroke: null, doc: null, slot: -1, tex: null, canvas: null, ctx: null,
      clipCtx: null, clipped: false, clipPolys: 0
    },
    /* V7：四视图可交互 —— quadCtl 每格一个 OrbitControls，只 enable 激活那一个；
     * quadMax 非空时该格全屏；quadDown / quadClick 用来区分单击、拖拽与双击。 */
    quadCtl: null, quadActive: 'front', quadMax: null, quadDown: null, quadClick: null,
    edgeLines: null, vertPoints: null, navAlt: false, lights: [], noPick: false,
    cubeDrag: null, cubeClickTimer: 0, cube: null, cubeHover: -1,
    selected: 0,
    history: { undo: [], redo: [], bytes: 0 },
    editBefore: null, txBefore: null,
    uiReady: false, busy: false, statusTimer: 0, texOpen: false,
    menu: null,
    toolPanel: null,
    prefs: null,
    /* 内容浏览器（底部 dock）：收起时只留页签；assets 为 null 表示还没读过 */
    dock: null, dockBody: null, dockOpen: false, dockLoading: false,
    dockAssets: null, dockErr: '', dockThumbs: Object.create(null), dockToken: 0,
    /* 基础体面板（M5）：形状 / 三向尺寸 / 段数；autoName 表示名字还是系统起的 */
    prim: { shape: 'box', size: [1, 1, 1], seg: 16 },
    autoName: true,
    /* 选择（M3/S1）：模式 + 三组稳定 ID + 高亮组 */
    selMode: 'object',
    sel: { vertexIds: [], edgeIds: [], faceIds: [] },
    nodeIds: [],                 /* 大纲多选（结合/布尔用） */
    /* 软选择：开关 + 衰减半径（百分比）+ 曲面类型 + 自定义曲线点 */
    soft: { on: false, falloff: 'smooth', size: 65, custom: null },
    softDrag: -1,
    selGroup: null, pickDown: null,
    /* 组件变换：手柄挂在 compPivot 上，拖动时把「世界空间的增量」换算回网格局部坐标 */
    compPivot: null, compIdx: [], compDrag: null, edgeRecs: null,
    pivots: Object.create(null),
    /* 热盒：按住空格弹出，松开执行鼠标下的那一条 */
    hbOpen: false, hbHover: null, hbZones: [], hbPanel: null, pointer: { x: 0, y: 0 },
    /* 工具（竖条）：select / lasso / paint / move / rotate / scale；gest 是当前手势 */
    tool: 'select', gest: null,
    /* 挤出专用操纵器（箭头 + 轴心缩放柄）：只在 tool.extrude 会话里出现 */
    extrudeGizmo: null, extrudeDrag: null, extrudeHover: null,
    /* UV 编辑器（X5a–X5e）：窗口 + 二维画布 + 选择/变换状态。
     * corners 存的是**面角下标**（uvs 的一对值），不存 UV 点 ID ——
     * 点分组是派生的（同一顶点同一 UV），拓扑/UV 一改就重算。 */
    uv: {
      win: null, canvas: null, ctx: null, open: false,
      mode: 'point', transform: 'move', grid: true, ruler: true, snap: false,
      tex: false,
      /* X5g：底图。mapImg = 模型自己的基础色贴图（doc.materials.slotMaps 解码来的），
       * img 是用户临时载入的参考图；两者都只画在 0–1 贴图范围内，不写进文档。 */
      mapOn: false, mapImg: null, mapName: '', mapUrl: '',
      /* X5g：图片底图。img 是已解码的 Image，只画在 0–1 贴图范围内；不写进文档 */
      img: null, imgName: '',
      cu: 0.5, cv: 0.5, scale: 380,
      corners: [], cornerSet: Object.create(null), selFaces: [],
      syncedFaces: '', hover: null, drag: null, marquee: null, menu: null, drawRaf: 0, frameSkip: 0, lastMs: 0,
      faceCache: null
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 应用级渲染偏好（V1/V2） ----------------
   * 只放「换资产也不该变」的东西；文档级（变换 / 材质槽 / 选择）仍写 GLB。
   * P6 会把它挪进设置页，这里先把键占住 —— 别让将来出现第二份曝光值。 */
  var PREF_KEY = 'openagi_modeldesk_prefs';
  var PREF_DEF = {
    toneMapping: 'aces',      /* aces | reinhard | none */
    exposure: 1.00,
    edgeColor: '#0b0d10',
    vertCore: '#f7f9fb',
    vertHalo: '#14171b'
  };
  function prefs() {
    var raw = {};
    try { raw = JSON.parse(global.localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    var out = {}, k;
    for (k in PREF_DEF) out[k] = (raw[k] == null ? PREF_DEF[k] : raw[k]);
    out.exposure = Math.max(0.1, Math.min(2, Number(out.exposure) || 1));
    if (['aces', 'reinhard', 'none'].indexOf(out.toneMapping) < 0) out.toneMapping = 'aces';
    return out;
  }
  function savePrefs(patch) {
    var p = prefs(), k;
    for (k in patch) if (k in PREF_DEF) p[k] = patch[k];
    p.exposure = Math.max(0.1, Math.min(2, Number(p.exposure) || 1));
    if (['aces', 'reinhard', 'none'].indexOf(p.toneMapping) < 0) p.toneMapping = 'aces';
    /* 测试模式（?nostore=1）只禁写不禁读：改完内存生效，但不污染真实偏好 */
    if (typeof STORE_SYNC_OFF !== 'undefined' && STORE_SYNC_OFF) { st.prefs = p; return p; }
    try { global.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
    st.prefs = p;
    return p;
  }
  function toneConst(kind) {
    if (kind === 'none') return THREE.NoToneMapping;
    if (kind === 'reinhard') return THREE.ReinhardToneMapping != null ? THREE.ReinhardToneMapping : THREE.NoToneMapping;
    return THREE.ACESFilmicToneMapping != null ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  }
  function toneLabel(kind) {
    return kind === 'none' ? '无色调映射 (sRGB)'
      : kind === 'reinhard' ? 'Reinhard (sRGB)' : 'ACES Filmic (sRGB)';
  }
  function applyRenderTone() {
    if (!st.renderer) return;
    var p = st.prefs || prefs();
    st.prefs = p;
    st.renderer.toneMapping = toneConst(p.toneMapping);
    st.renderer.toneMappingExposure = p.exposure;
    if ('outputEncoding' in st.renderer) st.renderer.outputEncoding = THREE.sRGBEncoding;
    paintViewportReadout();
  }
  /* 视口标题行那两个数不是装饰：右边 = 曝光，右下角 = 真实色调映射。
   * 以前这里是写死的「ACES 1.0 SDR-video」，而渲染器根本没开 toneMapping。 */
  function paintViewportReadout() {
    var p = st.prefs || prefs();
    var nums = document.querySelectorAll('.md-vpnum .md-numb');
    if (nums[1]) nums[1].textContent = Number(p.exposure).toFixed(2);
    var style = document.querySelector('.md-vpstyle');
    if (style) style.innerHTML = esc(toneLabel(p.toneMapping)) + '<i>▾</i>';
  }
  function genId() {
    return 'mdl-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679616).toString(36);
  }
  function deskApi() {
    return (global.openagiDesktop && typeof global.openagiDesktop.assetPut === 'function') ? global.openagiDesktop : null;
  }
  function fmt(v) { return Number(v).toFixed(2); }

  /* ---------------- UI ---------------- */
  /* 左侧竖条的图标（Maya 那一列的还原）：内联 SVG，跟着 currentColor 变，选中态由 CSS 管。
   * 用文字符号（▣ ◉ ✥）替代不了：这些工具的形状本身就是说明。 */
  var TOOL_ICONS = {
    select: '<svg viewBox="0 0 24 24"><path d="M6.5 3.2 18 11.6l-5.2.7 3.1 5.3-2.5 1.4-3.1-5.4-3.5 2.9z" fill="currentColor" stroke="none"/></svg>',
    lasso: '<svg viewBox="0 0 24 24"><ellipse cx="11" cy="10" rx="7.2" ry="5.2" stroke-dasharray="2.6 2.2"/>' +
      '<path d="M8.6 14.6c-1.3 2.6-.6 4.8 1.4 6"/><path d="m10.6 21.4 3.2-1.2-2.2-1.9z" fill="currentColor" stroke="none"/></svg>',
    paint: '<svg viewBox="0 0 24 24"><path d="M13.2 4.6 18.4 9.4l-4.9 4.7-4.9-4.8z" fill="currentColor" stroke="none"/>' +
      '<path d="m14.8 6.2 4.6 4.4 2.4-2.2-4.7-4.5z"/><ellipse cx="9.4" cy="16.4" rx="5.1" ry="3.4" stroke-dasharray="2.6 2.2"/></svg>',
    move: '<svg viewBox="0 0 24 24"><path d="M12 2.8v18.4M2.8 12h18.4"/>' +
      '<path d="m9 5.6 3-3 3 3M9 18.4l3 3 3-3M5.6 9l-3 3 3 3M18.4 9l3 3-3 3"/>' +
      '<rect x="9.2" y="9.2" width="5.6" height="5.6" fill="currentColor" stroke="none"/></svg>',
    rotate: '<svg viewBox="0 0 24 24"><path d="M19.6 12a7.6 7.6 0 1 1-3-6.1"/><path d="M20.2 3.4v4.8h-4.8"/>' +
      '<rect x="9.4" y="9.4" width="5.2" height="5.2" transform="rotate(45 12 12)" fill="currentColor" stroke="none"/></svg>',
    scale: '<svg viewBox="0 0 24 24"><rect x="3.6" y="3.6" width="16.8" height="16.8" stroke-dasharray="2.6 2.2"/>' +
      '<rect x="3.6" y="13.2" width="7.2" height="7.2" fill="currentColor" stroke="none"/>' +
      '<path d="m14 10 5.4-5.4M19.4 4.6h-4.2M19.4 4.6v4.2"/></svg>'
  };

  /* 组件模式图标（建模工具箱里那一排）：对象 / 顶点 / 边 / 面 / UV 岛。
   * 橙色是 Maya 的强调色（被编辑的组件），蓝底 = 当前模式。 */
  var MODE_ICONS = {
    object: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z" fill="#d98b3f" stroke="#8a5a26" stroke-width="1"/>' +
      '<path d="M4 7.6 12 12l8-4.4M12 12v8.8" stroke="#8a5a26" stroke-width="1"/></svg>',
    vertex: '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" stroke="currentColor" stroke-width="1.2"/>' +
      '<g fill="#d98b3f"><rect x="3.4" y="3.4" width="5" height="5"/><rect x="15.6" y="3.4" width="5" height="5"/>' +
      '<rect x="3.4" y="15.6" width="5" height="5"/><rect x="15.6" y="15.6" width="5" height="5"/></g></svg>',
    edge: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.4 20.6 12 12 20.6 3.4 12z" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M12 3.4 20.6 12" stroke="#d98b3f" stroke-width="2.6"/></svg>',
    face: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.4 20 7.7v8.6L12 20.6 4 16.3V7.7z" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M12 12 20 7.7v8.6L12 20.6z" fill="#d98b3f"/></svg>',
    island: '<svg viewBox="0 0 24 24" fill="none"><rect x="3.6" y="3.6" width="16.8" height="16.8" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.6 2.2"/>' +
      '<g fill="currentColor"><circle cx="8" cy="8" r="1.15"/><circle cx="12" cy="8" r="1.15"/><circle cx="16" cy="8" r="1.15"/>' +
      '<circle cx="8" cy="12" r="1.15"/><circle cx="16" cy="12" r="1.15"/>' +
      '<circle cx="8" cy="16" r="1.15"/><circle cx="12" cy="16" r="1.15"/><circle cx="16" cy="16" r="1.15"/></g></svg>'
  };

  /* 工具箱行图标：统一 18×18 线条风格，语义对齐工具（不抄 Blender 图标文件）。
   * currentColor + 少量强调色，深浅主题都能读。 */
  var OP_ICONS = {
    join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3" y="3" width="11" height="11" rx="1"/><rect x="10" y="10" width="11" height="11" rx="1" opacity=".55"/><path d="M9.5 8.5h5v5" stroke-dasharray="1.5 1.5"/></svg>',
    separate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3" y="6" width="8" height="12" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1" opacity=".55"/><path d="M11.4 12h1.2" stroke-dasharray="1 1.4"/></svg>',
    islandSplit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3" y="3" width="9" height="9" stroke-dasharray="2.4 2"/><rect x="14" y="12" width="7" height="9" opacity=".55"/><path d="M11.8 7.5h5.4v4.2"/><path d="m15.4 9.9 1.8 1.8 1.8-1.8" opacity=".85"/></svg>',
    smooth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M4 15c3-7 6-9 8-9s5 2 8 9"/><path d="M4 18.5h16" opacity=".5"/><path d="M6.5 12.5h11" opacity=".5"/></svg>',
    boolean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6" opacity=".7"/><path d="M12 6.9c2.4 1.2 4 3 4 5.1s-1.6 3.9-4 5.1" opacity=".55"/></svg>',
    extrude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M4 13.5 12 18l8-4.5"/><path d="M4 16.5 12 21l8-4.5" opacity=".45"/><path d="M12 15V4M8.6 7.4 12 4l3.4 3.4"/></svg>',
    bevel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M7 3h8l6 6v8l-4 4H5V7z"/><path d="M15 3v6h6" stroke-dasharray="1.6 1.4"/><path d="M7 3 3 7" opacity=".55"/></svg>',
    bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M5 6c5 0 6 12 14 12"/><path d="M5 18c5 0 6-12 14-12" opacity=".6"/><path d="M5 6v12M19 6v12" opacity=".45"/></svg>',
    segments: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3.5" y="3.5" width="17" height="17"/><path d="M12 3.5v17M3.5 12h17" opacity=".6"/></svg>',
    knife: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M5 4.5c4 .5 8.5 3 11.5 6.5L7.5 20 5 4.5z"/><path d="M13 20.5 19 14.5" opacity=".55"/><path d="m5 4.5 14 14" stroke-dasharray="2 2" opacity=".7"/></svg>',
    targetWeld: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="6" cy="7" r="3"/><circle cx="18" cy="17" r="3"/><path d="m8.6 9.2 6.8 5.6M14 14.4l1.4 2.6M15.4 17h-2.8"/></svg>',
    connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="7" r="3"/><path d="m8.4 15.6 7.2-7.2"/><path d="M12 17H6M18 7v5" opacity=".35"/></svg>',
    loopcut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="4" y="4" width="16" height="16"/><path d="M4 12h16" stroke="#d98b3f" stroke-width="1.7"/><path d="M10.6 4v16M16 4v16" stroke-dasharray="2.4 2" opacity=".55"/></svg>',
    tris2quads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 5h7L3 15z"/><path d="M10 5v10H3" opacity=".5"/><path d="M11.2 10h3.6m-1.4-1.4L15 10l-1.6 1.4"/><rect x="16.2" y="4.8" width="4.8" height="10.4"/></svg>',
    quadDraw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M5 5h14v14H5z" stroke-dasharray="3 2.4"/><g fill="#d98b3f" stroke="none"><circle cx="5" cy="5" r="1.8"/><circle cx="19" cy="5" r="1.8"/><circle cx="19" cy="19" r="1.8"/><circle cx="5" cy="19" r="1.8"/></g></svg>',
    array: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.4" y="8.4" width="6.6" height="7.2" rx="1"/><rect x="8.7" y="8.4" width="6.6" height="7.2" rx="1" opacity=".62"/><rect x="15" y="8.4" width="6.6" height="7.2" rx="1" opacity=".34"/><path d="M5.7 6.2v1.4M12 6.2v1.4M18.3 6.2v1.4" opacity=".5"/></svg>',
    subdivOnce: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.5" y="3.5" width="17" height="17"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" opacity=".55"/></svg>',
    dissolve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 7.2 12 3.6 20 7.2v9.6L12 20.4 4 16.8z"/><path d="M4 7.2 12 11l8-3.8M12 11v9.4" opacity=".4"/><path d="M8.8 11h6.4" stroke="#d98b3f" stroke-width="1.9"/></svg>'
  };

  /* 工具架图标：原来这里混着两种东西 —— 文字字形（▣ ◉ ▤ ▭ ◎ ▲ ✦ ◍ ◑ ✑ ◫ ❖ ✷ ◈）
   * 和真 SVG。字形在不同字体里大小/粗细/基线都不一样，和 17px 的 SVG 排在一行时，
   * 一眼就能看出"这一排没对齐"。这里把整排换成同一套线性 SVG（同 24 视框、同 1.25 描边），
   * 顺带把"以后接入"的占位也画成图标 —— 占位不等于随便放个符号。 */
  var SHELF_ICONS = {
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M12 2.9 20.6 7.4v9.2L12 21.1 3.4 16.6V7.4z"/><path d="M3.4 7.4 12 11.9l8.6-4.5M12 11.9v9.2" opacity=".5"/></svg>',
    sphere: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="12" cy="12" r="8.7"/><ellipse cx="12" cy="12" rx="3.6" ry="8.7" opacity=".55"/><path d="M3.6 9.2h16.8M3.6 14.8h16.8" opacity=".55"/></svg>',
    cylinder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><ellipse cx="12" cy="6.2" rx="7" ry="2.9"/><path d="M5 6.2v11.6c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6.2"/><path d="M5 12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9" opacity=".4"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M2.8 15.4 9.4 5.2h11.8l-6.6 10.2z"/><path d="M6.1 10.3h11.8M9.4 5.2 6.1 15.4M15.2 5.2l-3.3 10.2" opacity=".4"/></svg>',
    torus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><ellipse cx="12" cy="12" rx="9" ry="6.4"/><ellipse cx="12" cy="12" rx="3.7" ry="2.2" opacity=".6"/><path d="M3.6 9.6c1.9 1.5 5 2.4 8.4 2.4s6.5-.9 8.4-2.4" opacity=".35"/></svg>',
    cone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M12 3.2 20 17.6c0 1.6-3.6 2.9-8 2.9s-8-1.3-8-2.9z"/><ellipse cx="12" cy="17.6" rx="8" ry="2.9"/><path d="M8 10.4h8" opacity=".35"/></svg>',
    retopo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.4 9.6 8 4.4h12.6l-4.6 5.2z" stroke-dasharray="2.4 2"/><path d="M3.4 9.6v9.8h12.6"/><path d="m16.6 17.4 4.6-5.2" stroke-dasharray="2.4 2" opacity=".6"/><circle cx="6.4" cy="14.4" r="1.3"/><circle cx="12.2" cy="17.6" r="1.3"/></svg>',
    texture: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3.2" y="4.4" width="17.6" height="15.2" rx="1.6"/><path d="M3.2 12.6h6.2v7H3.2zM9.4 4.4h6.2v8.2H9.4zM15.6 8.6h5.2v4.6h-5.2z" opacity=".45"/></svg>',
    uv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3" y="3.2" width="18" height="17.6" rx="1.2" stroke-dasharray="2.8 2.2"/><path d="M7 15.6 11.4 6.8h2.2l4.4 8.8" stroke-width="1.5"/><path d="M8.6 12.6h6.8" stroke-width="1.5"/></svg>',
    projbake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.4 5.2h10.2v10.2H3.4z" opacity=".75"/><path d="M10.4 18.6h10.2V8.4" opacity=".75"/><path d="M13.4 15.4 18.6 10" stroke-dasharray="2.2 1.8"/><path d="m18.6 13.4-.2-3.6-3.6-.2" stroke-width="1.4"/></svg>',
    curve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.6 18.4C6 8 10 18 20.4 6.2"/><circle cx="3.6" cy="18.4" r="1.7"/><circle cx="20.4" cy="6.2" r="1.7"/><path d="M8 9.6 12 6.8M15 12.6l3.6-2.2" opacity=".45" stroke-dasharray="1.6 1.4"/></svg>',
    surface: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.4 8c6-3.2 11.2-3.2 17.2 0"/><path d="M3.4 16.4c6-3.2 11.2-3.2 17.2 0"/><path d="M3.4 8v8.4M20.6 8v8.4M8.5 6.7v9.4M15.5 6.7v9.4" opacity=".4"/></svg>',
    anim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.4 16.4h4.2l4.4-8.8h3.6l4.9 8.8" stroke-dasharray="2.2 1.8"/><path d="M12 19.4v-4.2M9.9 17.3 12 19.4l2.1-2.1" opacity=".55"/><circle cx="7.6" cy="16.4" r="1.5"/><circle cx="16.4" cy="16.4" r="1.5" opacity=".55"/></svg>',
    render: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2M5.4 5.4l2.3 2.3M16.3 16.3l2.3 2.3M18.6 5.4l-2.3 2.3M7.7 16.3l-2.3 2.3" opacity=".65"/></svg>',
    dyn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="12" cy="12" r="2.4"/><ellipse cx="12" cy="12" rx="9.2" ry="4.2" transform="rotate(-32 12 12)"/><ellipse cx="12" cy="12" rx="9.2" ry="4.2" transform="rotate(32 12 12)" opacity=".55"/></svg>'
  };

  /* 工具箱面板：Blender 式分组 + 行状按钮（图标 + 名称），和截图一致 */
  var OP_GROUPS = [
    { id: 'mesh', title: '网格', items: [
      { op: 'join', label: '结合', icon: 'join', title: '把大纲中多选的对象合成一个网格' },
      { op: 'separate', label: '分离', icon: 'separate', title: '按连通块拆成多个对象' },
      { op: 'split-islands', label: '拆分岛', icon: 'islandSplit', title: '把选中的 UV 岛拆成一个独立对象（UV 岛模式 F12 选择）' },
      { op: 'smooth', label: '平滑', icon: 'smooth', title: '平滑选中顶点（不选 = 整体）' },
      { op: 'tris-to-quads', label: '三角转四边', icon: 'tris2quads', title: '把成对的共边三角面并成四边面（UV 接缝处不并）' },
      /* 阵列 / 细分一次都作用在**整份基础网格**：有修改器时先算 base，求值器再叠修改器 */
      { op: 'array', label: '阵列', icon: 'array', title: '线性复制多份（数量含原件；改间距实时预览）' },
      { op: 'subdivide-once', label: '细分一次', icon: 'subdivOnce', title: '整网格细分一级（四边→4 四边，三角→4 三角）' },
      { op: 'boolean', label: '布尔', icon: 'boolean', title: '对两个对象做差集（A − B）' }
    ] },
    { id: 'comp', title: '组件', items: [
      { op: 'extrude', label: '挤出', icon: 'extrude', title: '沿面法线挤出选中面' },
      { op: 'bevel', label: '倒角', icon: 'bevel', title: '选中面内缩成环 + 深度' },
      { op: 'bridge', label: '桥接', icon: 'bridge', title: '连接两个同边数的面' },
      { op: 'segments', label: '添加分段', icon: 'segments', title: '把选中面切成四份' },
      { op: 'dissolve', label: '溶解', icon: 'dissolve', title: '溶解选中的点 / 边 / 面（点需闭合扇形、边需恰好两面）' },
      { op: 'loopcut', label: '环切', icon: 'loopcut', title: '沿选中边所在的四边环切分；条数 / 滑移实时预览' }
    ] },
    { id: 'tool', title: '工具', items: [
      { op: 'knife', label: '多切割', icon: 'knife', title: '在视口拖一条线，用视平面切开网格' },
      { op: 'target-weld', label: '目标焊接', icon: 'targetWeld', title: '选中源点，最后选的点作目标' },
      { op: 'connect', label: '连接', icon: 'connect', title: '沿两个选中点切开共有面' },
      { op: 'quad-draw', label: '四边形绘制', icon: 'quadDraw', title: '按顺序选 4 个顶点生成四边形面' }
    ] }
  ];

  function toolboxHtml() {
    var soft = [
      '<section class="md-sec2 open" data-md-sec="soft">',
      '<button type="button" class="md-sec2-h" data-md-sectoggle="soft">',
      '<span class="md-sec2-arrow">▾</span><span>软选择</span><em id="mdSoftState">关</em></button>',
      '<div class="md-sec2-b">',
      '<label class="md-switch"><input type="checkbox" id="mdSoftOn"><i></i><span>软选择</span></label>',
      '<div class="md-soft-row">',
      '<span class="md-soft-lb">曲面</span>',
      '<select id="mdSoftFalloff" class="md-soft-sel" title="衰减曲面">',
      '<option value="smooth">平滑</option><option value="linear">线性</option>',
      '<option value="sharp">锐利</option><option value="sphere">球体</option>',
      '<option value="constant">常量</option><option value="custom">自定义</option>',
      '</select>',
      '<input id="mdSoftSize" class="md-soft-num" type="number" min="0" max="500" step="0.01" value="65.00" title="衰减半径（百分比）">',
      '</div>',
      '<div class="md-curve-wrap"><canvas id="mdSoftCurve" width="520" height="128"></canvas></div>',
      '<button type="button" class="md-soft-reset" data-md-softreset="1">重置曲线</button>',
      '</div>',
      '</section>'
    ].join('');
    var groups = OP_GROUPS.map(function (g) {
      var rows = g.items.map(function (it) {
        return '<button type="button" class="md-op" data-md-op="' + it.op + '" title="' + esc(it.title) + '">' +
          '<span class="md-op-i">' + (OP_ICONS[it.icon] || '') + '</span>' +
          '<span class="md-op-lb">' + esc(it.label) + '</span></button>';
      }).join('');
      return '<section class="md-sec2 open" data-md-sec="' + g.id + '">' +
        '<button type="button" class="md-sec2-h" data-md-sectoggle="' + g.id + '">' +
        '<span class="md-sec2-arrow">▾</span><span>' + g.title + '</span></button>' +
        '<div class="md-sec2-b"><div class="md-op-grid">' + rows + '</div></div>' +
        '</section>';
    }).join('');
    return soft + groups;
  }

  function ensureUI() {
    if (st.uiReady) return;
    var host = $('modelDeskHost');
    if (!host) return;
    st.host = host;
    /* 布局按 Maya 2024 还原：菜单条 / 状态行 / 工具架 / 主区（工具条 + 大纲 + 视口 + 右侧）/ 命令行。
     * 占位控件一律用 span（title 里写明接入里程碑），能点的才用 button + data-md-*。 */
    host.innerHTML = [
      '<div class="md-app">',
      '  <div class="md-menu">',
      '    <div class="md-menu-brand"><b>The seed</b><span>建模</span></div>',
      '    <nav class="md-menu-items">',
      '      <button type="button" class="md-mitem" data-md-menu="文件">文件</button>',
      '      <button type="button" class="md-mitem" data-md-menu="编辑">编辑</button>',
      '      <button type="button" class="md-mitem" data-md-menu="创建">创建</button>',
      '      <button type="button" class="md-mitem" data-md-menu="修改">修改</button>',
      '      <button type="button" class="md-mitem" data-md-menu="显示">显示</button>',
      '      <button type="button" class="md-mitem" data-md-menu="窗口">窗口</button>',
      '      <button type="button" class="md-mitem" data-md-menu="帮助">帮助</button>',
      '    </nav>',
      '    <div class="md-drop" id="mdDrop" hidden></div>',
      '    <div class="md-menu-right">',
      '      <span class="md-workspace">工作区：建模 · 标准</span>',
      '      <b class="md-name" id="mdName">未命名模型</b>',
      '      <span class="md-ver">MVP-1</span>',
      '    </div>',
      '  </div>',
      '  <div class="md-toolbar">',
      '    <div class="md-tb-left">',
      '      <span class="md-ico" title="选择工具：M2 起接入">➤</span>',
      '      <span class="md-sep"></span>',
      '      <button type="button" class="md-chip" data-md-mode="translate" title="移动手柄（W）">移动</button>',
      '      <button type="button" class="md-chip" data-md-mode="rotate" title="旋转手柄（E）">旋转</button>',
      '      <button type="button" class="md-chip" data-md-mode="scale" title="缩放手柄（R）">缩放</button>',
      '      <span class="md-sep"></span>',
      '      <button type="button" class="md-chip" data-md-space="world" id="mdSpace" title="切换世界 / 局部坐标">世界</button>',
      '      <button type="button" class="md-chip" data-md-act="snap" id="mdSnap" title="吸附：平移 0.05 / 旋转 15° / 缩放 0.1">吸附</button>',
      '      <span class="md-tbst">对齐：禁用</span>',
      '      <span class="md-tbst">单位：米</span>',
      '    </div>',
      '    <div class="md-tb-right">',
      '      <button type="button" class="md-act" data-md-act="new">新建</button>',
      '      <button type="button" class="md-act" data-md-act="open">打开</button>',
      '      <button type="button" class="md-act primary" data-md-act="save">保存 GLB</button>',
      '      <button type="button" class="md-act" data-md-act="undo" id="mdUndo">撤销</button>',
      '      <button type="button" class="md-act" data-md-act="redo" id="mdRedo">重做</button>',
      '      <span class="md-sep"></span>',
      '      <button type="button" class="md-act" data-md-act="quad" title="渲染前 / 后 / 左 / 右 四视图">四视图</button>',
      '      <button type="button" class="md-act" data-md-act="tex" title="打开 3D 查看器编辑贴图">材质槽</button>',
      '    </div>',
      '  </div>',
      '  <div class="md-shelf">',
      '    <div class="md-shelf-tabs">',
      '      <span class="md-stab on">多边形建模</span>',
      '      <span class="md-stab">曲线</span>',
      '      <span class="md-stab">曲面</span>',
      '      <span class="md-stab">动画</span>',
      '      <span class="md-stab">FX</span>',
      '      <span class="md-stab">渲染</span>',
      '      <span class="md-stab">动力学</span>',
      '    </div>',
      '    <div class="md-shelf-grid">',
      '      <button type="button" class="md-sico" style="--c:#c9a24e" title="立方体：新建并调尺寸" data-md-prim="box">' + SHELF_ICONS.box + '</button>',
      '      <button type="button" class="md-sico" style="--c:#7fa9d8" title="球体：新建并调半径 / 段数" data-md-prim="sphere">' + SHELF_ICONS.sphere + '</button>',
      '      <button type="button" class="md-sico" style="--c:#9ec27b" title="圆柱：新建并调上下半径 / 段数" data-md-prim="cylinder">' + SHELF_ICONS.cylinder + '</button>',
      '      <button type="button" class="md-sico" style="--c:#c98fb3" title="平面：新建并调宽高" data-md-prim="plane">' + SHELF_ICONS.plane + '</button>',
      '      <button type="button" class="md-sico" style="--c:#e0a13a" title="圆环：新建并调主半径 / 管半径" data-md-prim="torus">' + SHELF_ICONS.torus + '</button>',
      '      <button type="button" class="md-sico" style="--c:#d8a15a" title="圆锥：新建并调底半径 / 高" data-md-prim="cone">' + SHELF_ICONS.cone + '</button>',
      /* 分组分隔：二十多个图标连成一条时，用户要靠"数第几个"找工具。
       * 三条分隔把工具架切成「基础体 / 建模编辑 / 贴图 / 占位」四段。 */
      '      <span class="md-sico-sep" aria-hidden="true"></span>',
      '      <span class="md-sico" style="--c:#b8b8b8" title="重新拓扑（后续接入）">' + SHELF_ICONS.retopo + '</span>',
      '      <button type="button" class="md-sico" style="--c:#8cb6a6" data-md-op="knife" title="多切割：视口拖线切割">' + OP_ICONS.knife + '</button>',
      '      <button type="button" class="md-sico" style="--c:#d8b06a" data-md-op="target-weld" title="目标焊接：最后选中的点作目标">' + OP_ICONS.targetWeld + '</button>',
      '      <button type="button" class="md-sico" style="--c:#9aa8c9" data-md-op="bridge" title="桥接：两个同边数面">' + OP_ICONS.bridge + '</button>',
      '      <button type="button" class="md-sico" style="--c:#c7a0d6" data-md-op="extrude" title="挤出：沿法线挤出选中面">' + OP_ICONS.extrude + '</button>',
      '      <button type="button" class="md-sico" style="--c:#a8a8a8" data-md-op="bevel" title="倒角：选中面内缩 + 深度">' + OP_ICONS.bevel + '</button>',
      '      <button type="button" class="md-sico" style="--c:#d98b3f" data-md-op="loopcut" title="环切：沿选中边所在的四边环切分">' + OP_ICONS.loopcut + '</button>',
      '      <button type="button" class="md-sico" style="--c:#8fc7a8" data-md-op="tris-to-quads" title="三角转四边：成对三角并成四边面">' + OP_ICONS.tris2quads + '</button>',
      '      <button type="button" class="md-sico" style="--c:#8fb5b8" data-md-op="separate" title="分离（大纲多选后可用结合）">' + OP_ICONS.separate + '</button>',
      '      <button type="button" class="md-sico" style="--c:#8fb5b8" data-md-op="split-islands" title="拆分岛：把选中的 UV 岛拆成独立对象">' + OP_ICONS.islandSplit + '</button>',
      '      <button type="button" class="md-sico" style="--c:#c9b27c" data-md-op="smooth" title="平滑：选中顶点或整体">' + OP_ICONS.smooth + '</button>',
      '      <span class="md-sico-sep" aria-hidden="true"></span>',
      '      <span class="md-sico" style="--c:#c88a8a" title="纹理（M5 接入）">' + SHELF_ICONS.texture + '</span>',
      '      <button type="button" class="md-sico" style="--c:#9fc0e0" data-md-act="uv" title="UV 编辑器：二维 UV 视图 / 选择 / 变换 / 展开排布">' + SHELF_ICONS.uv + '</button>',
      '      <button type="button" class="md-sico" style="--c:#e0b06a" data-md-act="projbake" title="投射烘焙：把当前视角的 UV 岛拖到原画上重采样（修 AI 图糊掉的眼睛等细节）">' + SHELF_ICONS.projbake + '</button>',
      '      <span class="md-sico-sep" aria-hidden="true"></span>',
      '      <span class="md-sico" style="--c:#d0b080" title="曲线工具（后续接入）">' + SHELF_ICONS.curve + '</span>',
      '      <span class="md-sico" style="--c:#b0b0b0" title="曲面放样（后续接入）">' + SHELF_ICONS.surface + '</span>',
      '      <span class="md-sico" style="--c:#d8a15a" title="动画（M7 接入）">' + SHELF_ICONS.anim + '</span>',
      '      <span class="md-sico" style="--c:#d8c45a" title="渲染设置（M8 接入）">' + SHELF_ICONS.render + '</span>',
      '      <span class="md-sico" style="--c:#8fa8b6" title="动力学（M8 接入）">' + SHELF_ICONS.dyn + '</span>',
      '    </div>',
      '  </div>',
      '  <div class="md-hb" id="mdHotbox" aria-hidden="true"></div>',
      '  <div class="md-main">',
      '    <div class="md-strip" role="toolbar" aria-label="建模工具">',
      '      <button type="button" class="md-tool" data-md-tool="select" title="选择工具（Q）：点选；按住拖动 = 框选">' + TOOL_ICONS.select + '</button>',
      '      <button type="button" class="md-tool" data-md-tool="lasso" title="套索工具：按住画一圈，圈住的被选中">' + TOOL_ICONS.lasso + '</button>',
      '      <button type="button" class="md-tool" data-md-tool="paint" title="绘制选择：按住刷，刷过的被选中（按住 Ctrl 刷掉）">' + TOOL_ICONS.paint + '</button>',
      '      <span class="md-tool-sep"></span>',
      '      <button type="button" class="md-tool" data-md-tool="move" title="移动工具（W）">' + TOOL_ICONS.move + '</button>',
      '      <button type="button" class="md-tool" data-md-tool="rotate" title="旋转工具（E）">' + TOOL_ICONS.rotate + '</button>',
      '      <button type="button" class="md-tool" data-md-tool="scale" title="缩放工具（R）">' + TOOL_ICONS.scale + '</button>',
      '    </div>',
      '    <aside class="md-outline">',
      '      <div class="md-panel-h"><span>大纲视图</span><em id="mdOutlineCount">0 个对象</em></div>',
      '      <div class="md-otabs"><span class="md-otab on">显示</span><span class="md-otab">隐藏</span><span class="md-otab">帮助</span></div>',
      '      <div class="md-osearch"><input id="mdOutlineSearch" type="search" placeholder="按名称搜索节点" autocomplete="off" spellcheck="false"></div>',
      '      <div class="md-tree" id="mdOutlineList"></div>',
      '      <div class="md-hint">F8–F11 切对象 / 顶点 / 边 / 面，Shift 加选、Ctrl 减选；框选随 S3、挤出等算子随 M6。</div>',
      '    </aside>',
      '    <div class="md-center">',
      '      <div class="md-vpbar">',
      '        <span class="md-vplabel" id="mdViewLabel">透视 ▾</span>',
      '        <span class="md-vplabel">着色</span>',
      '        <select class="md-vpsel" id="mdShadeSel" title="着色模式">',
      '          <option value="shaded-wire">实体 + 线框</option>',
      '          <option value="shaded">实体</option>',
      '          <option value="wire">线框</option>',
      '          <option value="flat">平涂</option>',
      '          <option value="uv">UV 岛着色</option>',
      '        </select>',
      '        <button type="button" class="md-vpi" data-md-act="isolate" id="mdIsolateBtn" title="单独显示：只显示当前选中对象；面 / UV 岛模式下只显示选中的面（再点退出）">' +
      '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '            <rect x="2.6" y="2.6" width="18.8" height="18.8" stroke-dasharray="2.6 2.2" opacity=".75"/>' +
      '            <path d="M12 6.6 17 9.3v5.4L12 17.4 7 14.7V9.3z"/>' +
      '            <path d="M12 11.9 17 9.3v5.4L12 17.4z" fill="currentColor" stroke="none" opacity=".85"/>' +
      '          </svg></button>',
      '        <span class="md-vplabel">照明 ▾</span>',
      '        <span class="md-vplabel">显示 ▾</span>',
      '        <span class="md-vplabel">渲染器 ▾</span>',
      '        <span class="md-vplabel">面板 ▾</span>',
      '        <span class="md-sep"></span>',
      '        <button type="button" class="md-vpi" data-md-act="grid" id="mdGridBtn" title="显示 / 隐藏地面栅格">⌗</button>',
      '        <button type="button" class="md-vpi" data-md-act="shade-cycle" id="mdShadeBtn" title="切换着色模式（实体 / 实体+线框 / 线框）">▦</button>',
      '        <span class="md-vpi" title="透视视角（M4 接入）">◍</span>',
      '        <span class="md-vpnum"><span class="md-numb">0.00</span><i>/</i><span class="md-numb">1.00</span></span>',
      '        <span class="md-vpstyle">ACES 1.0 SDR-video (sRGB)<i>▾</i></span>',
      '      </div>',
      '      <div class="md-stage" id="mdStage">',
      '        <canvas id="mdCanvas"></canvas>',
      '        <div class="md-gest" id="mdGest" aria-hidden="true">',
      '          <div class="md-gest-box" id="mdGestBox"></div>',
      '          <svg class="md-gest-lasso" id="mdGestLasso" preserveAspectRatio="none"><polyline id="mdGestPoly" points=""></polyline></svg>',
      '          <div class="md-gest-brush" id="mdGestBrush"></div>',
      '        </div>',
      '        <div class="md-quad" aria-hidden="true">',
      '          <i class="md-quad-v"></i><i class="md-quad-h"></i>',
      '          <span class="md-quad-l tl" data-md-qcell="front">前视图</span>',
      '          <span class="md-quad-l tr" data-md-qcell="back">后视图</span>',
      '          <span class="md-quad-l bl" data-md-qcell="left">左视图</span>',
      '          <span class="md-quad-l br" data-md-qcell="right">右视图</span>',
      '        </div>',
      '        <div class="md-cube" id="mdCube" title="拖拽翻转视角 · 点面切正视图 · 箭头每次转 90° · 双击回轴测">',
      '          <canvas id="mdCubeCanvas"></canvas>',
      '          <b class="md-cube-turn top" data-md-turn="up" title="视图向上翻转 90°"></b>',
      '          <b class="md-cube-turn bottom" data-md-turn="down" title="视图向下翻转 90°"></b>',
      '          <b class="md-cube-turn left" data-md-turn="left" title="视图向左翻转 90°"></b>',
      '          <b class="md-cube-turn right" data-md-turn="right" title="视图向右翻转 90°"></b>',
      '        </div>',
      '        <div class="md-hud" id="mdHud"></div>',
      '      </div>',
      '    </div>',
      '    <aside class="md-right">',
      '      <div class="md-panel-h md-right-h"><span class="md-tbkinds">' +
      '        <button type="button" class="md-otab on" data-md-tbk="model" title="建模工具箱">建模工具箱</button>' +
      '        <button type="button" class="md-otab" data-md-tbk="paint" title="绘画工具箱：笔刷直接画进基础色贴图">绘画工具箱</button>' +
      '        <button type="button" class="md-otab" data-md-tbk="props" title="属性编辑器：变换 / 材质槽 / 操作历史">属性编辑器</button>' +
      '      </span><em id="mdTbMode">对象</em></div>',
      '      <section class="md-tb">',
      '        <div class="md-tb-tabs"><button type="button" class="md-otab md-tbtab on" data-md-tbtab="object">对象</button><button type="button" class="md-otab md-tbtab" data-md-tbtab="component">多组件</button></div>',
      '        <div class="md-modebar" id="mdModeBar">',
      '          <button type="button" class="md-mode" data-md-selmode="object" title="对象模式（F8）">' + MODE_ICONS.object + '</button>',
      '          <button type="button" class="md-mode" data-md-selmode="vertex" title="顶点模式（F9）">' + MODE_ICONS.vertex + '</button>',
      '          <button type="button" class="md-mode" data-md-selmode="edge" title="边模式（F10）">' + MODE_ICONS.edge + '</button>',
      '          <button type="button" class="md-mode" data-md-selmode="face" title="面模式（F11）">' + MODE_ICONS.face + '</button>',
      '          <button type="button" class="md-mode" data-md-selmode="island" title="UV 岛模式（F12）">' + MODE_ICONS.island + '</button>',
      '        </div>',
      '        <div class="md-mode-hint" id="mdModeHint">当前：对象</div>',
      '        <div class="md-tb-body md-tb-list" id="mdToolbox">',
      toolboxHtml(),
      '        </div>',
      '        <div class="md-paint" id="mdPaintBox" hidden>',
      '          <div class="md-paint-card">',
      '            <div class="md-paint-card-h"><i></i><span>笔刷</span><em>在模型表面拖动上色</em></div>',
      '            <div class="md-paint-row"><span>笔刷</span><select id="mdBrushSel">' +
      '              <option value="soft">圆形软笔</option><option value="hard">圆形硬笔</option>' +
      '              <option value="erase">橡皮擦</option></select></div>',
      '            <div class="md-paint-row"><span>大小</span><input type="range" id="mdBrushSize" min="6" max="180" step="1" value="42"><b id="mdBrushSizeVal">42 px</b></div>',
      '            <div class="md-paint-row"><span>不透明度</span><input type="range" id="mdBrushOpacity" min="5" max="100" step="1" value="90"><b id="mdBrushOpacityVal">90%</b></div>',
      '            <div class="md-paint-row"><span>颜色</span><input type="color" id="mdBrushColor" value="#d94f4f">',
      '              <label class="md-paint-chk" title="只画进落笔所在的 UV 岛，笔刷不会溢到相邻岛"><input type="checkbox" id="mdPaintMask">UV 岛遮罩</label></div>',
      '          </div>',
      '          <div class="md-paint-mix" id="mdMixBox"></div>',
      '          <div class="md-paint-hint">左键拖动上色，Alt+左键 / 中键导航；笔画写回基础色贴图，保存 GLB 时内嵌合成图。</div>',
      '        </div>',
      '      </section>',
      '      <section class="md-props">',
      '        <div class="md-ptabs">',
      '          <button type="button" class="md-ptab on" data-md-tab="props">属性编辑器</button>',
      '          <button type="button" class="md-ptab" data-md-tab="channels">通道盒</button>',
      '        </div>',
      '        <div class="md-pbody" id="mdParams"></div>',
      '      </section>',
      '    </aside>',
      '  </div>',
      /* 覆盖层（基础体 / 材质槽 / 打开列表）挂在 .md-app 上，**不是**挂在 .md-stage 里。
       * 原来它在视口里，坐标参照系就是视口：1280 宽时视口只有 446px，
       * 而「基础体」面板 min-width 420 + 两侧 padding 就撑破了，
       * 表现是面板左半边被视口的 overflow:hidden 裁掉（标题只剩半句、第一个字段看不见）。
       * 对话框本来就该盖住整个窗口，所以参照系必须是 .md-app。 */
      '  <div class="md-overlay" id="mdOverlay"></div>',
      '  <div class="md-dock" id="mdDock">',
      '    <div class="md-dock-tabs">',
      '      <button type="button" class="md-dock-tab" data-md-dock="toggle" id="mdDockTab" title="展开 / 收起内容浏览器">内容浏览器<i>▴</i></button>',
      '      <span class="md-dock-sub" id="mdDockSub">模型库</span>',
      '      <div class="md-dock-acts">',
      '        <button type="button" class="md-dock-mini" data-md-dock="refresh" title="重新读取模型库">刷新</button>',
      '      </div>',
      '    </div>',
      '    <div class="md-dock-body" id="mdDockBody"></div>',
      '  </div>',
      '  <div class="md-cmdrow">',
      '    <span class="md-cmd-l">命令行</span>',
      '    <input id="mdCmd" class="md-cmd" type="text" autocomplete="off" spellcheck="false" placeholder="输入命令后回车（M3 起接入）">',
      '    <div class="md-status" id="mdStatus"></div>',
      '  </div>',
      '</div>'
    ].join('\n');

    st.stage = $('mdStage');
    st.canvas = $('mdCanvas');
    st.overlay = $('mdOverlay');
    st.statusEl = $('mdStatus');
    st.hudEl = $('mdHud');
    st.dock = $('mdDock');
    st.dockBody = $('mdDockBody');
    paintDock();
    bindCube();

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('pointerdown', onSoftCurveDown);
    host.addEventListener('pointermove', onSoftCurveMove);
    host.addEventListener('pointerup', onSoftCurveUp);
    host.addEventListener('pointercancel', onSoftCurveUp);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('keydown', onKeyDown);
    global.addEventListener('keydown', onKeyLayer, false);

    /* 主菜单下拉：点外面 / 按 Esc 收起。捕获阶段处理，先于工具层的 Esc。 */
    document.addEventListener('pointerdown', function (e) {
      if (!st.menu) return;
      var tg = e.target;
      if (tg && tg.closest && (tg.closest('#mdDrop') || tg.closest('.md-mitem'))) return;
      mdCloseMenu();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (st.menu && (e.key === 'Escape' || e.key === 'Esc')) {
        mdCloseMenu();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    /* 窗口从 index.html 迁到 apps/modeldesk/app.js 后，关闭按钮由 registerApp 生成，
       id 统一成 btn<窗口id>Close —— 原来是 btnModelDeskClose（少了 Win）。
       这条绑定不能少：关窗之前要 closeOverlay() 把叠加层收掉。 */
    var closeBtn = $('btnModelDeskWinClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        closeOverlay();
        if (typeof global.deskCloseWin === 'function') global.deskCloseWin($('modelDeskWin'));
        else { var w = $('modelDeskWin'); if (w) w.classList.add('hidden'); }
      });
    }

    global.addEventListener('openagi:app-restored', function (e) {
      if (e && e.detail && e.detail.win === 'modelDeskWin') pause();
    });
    global.addEventListener('openagi:app-mounted', function (e) {
      if (e && e.detail && e.detail.win === 'modelDeskWin') resume();
    });

    if (MIX) MIX.init();
    st.uiReady = true;
  }

  function setStatus(text, isErr) {
    /* UV 编辑器浮在窗口中间时，状态行可能被它盖住：同步在画布上弹一条提示，
     * 保证点任何地方都有可见反馈。 */
    if (st.uv && st.uv.open) uvToast(text, isErr);
    if (!st.statusEl) return;
    clearTimeout(st.statusTimer);
    st.statusEl.textContent = text || '';
    st.statusEl.classList.toggle('err', !!isErr);
    if (!text) return;
    st.statusTimer = setTimeout(function () {
      if (st.statusEl && !st.statusEl.classList.contains('err')) st.statusEl.textContent = '';
    }, 4200);
  }

  function updateChrome() {
    if (!st.doc) return;
    var nameEl = $('mdName');
    if (nameEl) nameEl.textContent = st.doc.name;
    var undoBtn = $('mdUndo'), redoBtn = $('mdRedo');
    if (undoBtn) undoBtn.disabled = !st.history.undo.length;
    if (redoBtn) redoBtn.disabled = !st.history.redo.length;
    document.querySelectorAll('.md-chip[data-md-mode]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdMode === st.mode);
    });
    var space = $('mdSpace');
    if (space) {
      space.textContent = st.space === 'local' ? '局部' : '世界';
      space.classList.toggle('on', st.space === 'local');
    }
    var snap = $('mdSnap');
    if (snap) snap.classList.toggle('on', st.snap);
    var gridBtn = $('mdGridBtn');
    if (gridBtn) gridBtn.classList.toggle('on', st.showGrid);
    var shadeSel = $('mdShadeSel');
    if (shadeSel && shadeSel.value !== st.shading) shadeSel.value = st.shading;
    var shadeBtn = $('mdShadeBtn');
    if (shadeBtn) shadeBtn.classList.toggle('on', st.shading === 'wire');
    var quadBtn = document.querySelector('.md-act[data-md-act="quad"]');
    if (quadBtn) quadBtn.classList.toggle('on', st.quad);
    var isoBtn = $('mdIsolateBtn');
    if (isoBtn) {
      isoBtn.classList.toggle('on', st.isolate);
      isoBtn.disabled = !st.doc || !st.node;
    }
    var viewLabel = $('mdViewLabel');
    if (viewLabel) viewLabel.textContent = (st.quad ? quadViewText() : (st.viewName || '透视')) + ' ▾';
    document.querySelectorAll('.md-tool[data-md-tool]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTool === st.tool);
    });
    /* 组件模式条：五个图标 + 标题右侧的当前模式 + 对象/多组件页签 */
    document.querySelectorAll('.md-mode[data-md-selmode]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdSelmode === st.selMode);
    });
    var tbMode = $('mdTbMode');
    if (tbMode) tbMode.textContent = tbModeLabel();
    document.querySelectorAll('[data-md-tbk]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTbk === st.tbKind);
    });
    var modeHint = $('mdModeHint');
    if (modeHint) {
      var keys = { object: 'F8', vertex: 'F9', edge: 'F10', face: 'F11', island: 'F12' };
      modeHint.textContent = '当前：' + (SEL_NOUN[st.selMode] || '对象') + '（' + (keys[st.selMode] || 'F8') + '）';
    }
    document.querySelectorAll('.md-tbtab[data-md-tbtab]').forEach(function (b) {
      b.classList.toggle('on', (b.dataset.mdTbtab === 'object') === (st.selMode === 'object'));
    });
    document.querySelectorAll('.md-ptab[data-md-tab]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTab === st.rightTab);
    });
    document.querySelectorAll('.md-op[data-md-op]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdOp === 'knife' && st.tool === 'knife');
    });
    paintSoftPanel();
    paintViewportReadout();
  }

  function statsNow() {
    return st.mesh ? SeedModel.Mesh.stats(st.mesh) : { vertices: 0, faces: 0, edges: 0, triangles: 0 };
  }

  /* 算子的输入永远是**文档里的基础网格**，不是视口里的求值结果。
   * 有修改器时 st.mesh 是 evaluator 的输出（缓存共享）：拿它做拓扑算子再写回，
   * 等于偷偷把修改器烘焙进 base。算子算完 base，视口重建时修改器会重新叠上去。 */
  function baseMeshNow() {
    return (st.doc && SeedModel.Scene.getMesh(st.doc)) || st.mesh;
  }

  /* 大纲里固定这几行是 Maya 的默认节点：M1 没有透视视图 / 灯光集，
   * 它们是禁用占位，让树的层级看起来完整。 */
  var FAKE_OUTLINE = [
    { name: 'persp', type: '视图' },
    { name: 'top', type: '视图' },
    { name: 'front', type: '视图' },
    { name: 'side', type: '视图' },
    { name: 'defaultLightSet', type: '集' },
    { name: 'defaultObjectSet', type: '集' }
  ];

  /* B2b：大纲每行是一个**真节点**，行内是「名字 + 类型 + 面数 + 可见性」。
   * 行高亮跟着 doc.activeNodeId 走（不是 st.selected —— 那是老的单对象下标）。
   * 面数是**该节点自己的**，不能用 statsNow()（那是激活对象的）。
   * 父子 / 组 / 拖拽重排是 B2b 的 UI 扩展，先不进来。 */
  function paintOutline() {
    var list = $('mdOutlineList');
    if (!list || !st.doc) return;
    if (!st.nodeIds) st.nodeIds = [];
    if (!st.nodeIds.length && st.doc.activeNodeId) st.nodeIds = [st.doc.activeNodeId];
    var q = String(st.outlineQuery || '').trim().toLowerCase();
    var countEl = $('mdOutlineCount');
    if (countEl) countEl.textContent = st.doc.nodes.length + ' 个对象';
    var rows = FAKE_OUTLINE.filter(function (f) {
      return !q || f.name.toLowerCase().indexOf(q) >= 0;
    }).map(function (f) {
      return '<button type="button" class="md-part-row fake" disabled>' +
        '<i class="' + (f.type === '视图' ? 'md-vicon' : 'md-ficon') + '"></i>' +
        '<span class="md-part-id">' + esc(f.name) + '</span>' +
        '<span class="md-part-shape">' + esc(f.type) + '</span>' +
        '</button>';
    }).join('');
    rows += st.doc.nodes.map(function (n) {
      if (q && String(n.name).toLowerCase().indexOf(q) < 0) return '';
      var faces = 0;
      try {
        var m = SeedModel.Scene.getMesh(st.doc, n);
        faces = m ? SeedModel.Mesh.stats(m).faces : 0;
      } catch (e) {}
      var isAct = n.id === st.doc.activeNodeId;
      var inMulti = st.nodeIds && st.nodeIds.indexOf(n.id) >= 0;
      var vis = n.visible !== false;
      return '<button type="button" class="md-part-row' + (isAct ? ' sel' : '') + (inMulti && !isAct ? ' multi' : '') + (vis ? '' : ' off') + '" data-md-node="' + esc(n.id) + '">' +
        '<i class="md-nicon"></i>' +
        '<span class="md-part-id">' + esc(n.name) + '</span>' +
        '<span class="md-part-shape">' + esc(vis ? '网格' : '隐藏') + '</span>' +
        '<em>' + faces + ' 面</em>' +
        '</button>';
    }).join('');
    list.innerHTML = rows || '<div class="md-note">没有匹配的节点</div>';
  }

  /* 大纲点行 = 换激活对象（与视口里点另一个对象同一入口）。
   * 点已激活的行不动；换对象要清选择集，否则旧 ID 在新网格里会被 prune 掉、看着像丢选。 */
  function selectNodeById(id, add) {
    if (!st.doc || !id) return false;
    if (!st.nodeIds) st.nodeIds = [];
    var doc = st.doc;
    var target = id;
    if (add) {
      var at = st.nodeIds.indexOf(id);
      if (at >= 0) st.nodeIds.splice(at, 1);
      else st.nodeIds.push(id);
      if (!st.nodeIds.length) st.nodeIds = [id];
      target = st.nodeIds.indexOf(id) >= 0 ? id : st.nodeIds[st.nodeIds.length - 1];
    } else {
      st.nodeIds = [id];
    }
    var activeChanged = doc.activeNodeId !== target;
    if (activeChanged && !SeedModel.Scene.setActiveNode(doc, target)) return false;
    if (activeChanged) {
      st.sel = { vertexIds: [], edgeIds: [], faceIds: [] };
      syncSelectionDoc();
      rebuildModel(true);
    }
    paintAll();
    if (add || st.nodeIds.length > 1) {
      setStatus('已选 ' + st.nodeIds.length + ' 个对象（Ctrl/Shift 点击追加；结合 / 布尔使用）');
    } else if (activeChanged) {
      setStatus('已激活：' + (st.node ? st.node.name : target));
    }
    return true;
  }

  function slotHtml() {
    var mats = (st.doc && st.doc.materials) || {};
    var names = mats.slotNames || [];
    var colors = mats.slotColors || [];
    if (!names.length) return '<div class="md-note">还没有材质槽名</div>';
    /* 每个槽的面数：删槽 / 指派前能一眼看出改动落在哪。
     * 用基础网格而不是 evaluated —— 指派写的是基础网格的 faceSlots。 */
    var counts = [];
    var base = null;
    try { base = st.doc ? SeedModel.Scene.getMesh(st.doc) : null; } catch (e) { base = null; }
    if (base && base.faceSlots) {
      for (var k = 0; k < base.faceSlots.length; k++) {
        var s = base.faceSlots[k] || 0;
        counts[s] = (counts[s] || 0) + 1;
      }
    }
    var selN = (st.sel && st.sel.faceIds) ? st.sel.faceIds.length : 0;
    var rows = names.map(function (n, i) {
      var dis = selN ? '' : ' disabled';
      return '<div class="md-slot" data-md-slotrow="' + i + '">' +
        '<input type="color" class="md-slot-c" data-md-slot="' + i + '" data-md-slotf="color" value="' + esc(colors[i] || '#c9ccd4') + '" title="槽颜色">' +
        '<input type="text" class="md-slot-n" data-md-slot="' + i + '" data-md-slotf="name" value="' + esc(n) + '" maxlength="60" title="双击改名，回车确认">' +
        '<em class="md-slot-f" title="该槽的面数">' + (counts[i] || 0) + '</em>' +
        '<button class="md-slot-a" data-md-act="slot-assign" data-md-slot="' + i + '"' + dis + ' title="把当前选中的面指派到这个槽">指派</button>' +
        '<button class="md-slot-x" data-md-act="slot-del" data-md-slot="' + i + '"' + (names.length <= 1 ? ' disabled' : '') + ' title="删除该槽">✕</button>' +
        '</div>';
    }).join('');
    return '<div class="md-slots">' + rows +
      '<div class="md-slot-foot">' +
      '<button class="md-slot-add" data-md-act="slot-add">＋ 新槽</button>' +
      '<span class="md-note">' + (selN ? ('已选 ' + selN + ' 个面，可指派') : '面 / UV 岛模式选中后可指派') + '</span>' +
      '</div></div>';
  }

  function chRow(label, value) {
    return '<div class="md-ch"><span>' + label + '</span><em>' + esc(value) + '</em></div>';
  }

  /* ---------------- 修改器栈（属性编辑器里的「修改器」分区） ----------------
   * 数据格式与 js/seed-modifiers.js 对齐：node.modifiers = [{ type, ...参数 }]。
   * 每个改动都走 docEdit：快照 → 重建 → 一条历史；这里只碰数组本身。
   * evaluator 的缓存键里带参数和 revision，改完再 invalidate 一次，下一帧必定重算。 */
  var MOD_LABEL = {
    subdivision: '细分曲面', subdivide: '细分曲面',
    mirror: '镜像', solidify: '加厚', solid: '加厚'
  };

  function modType(m) { return String((m && (m.type || m.kind)) || '').toLowerCase(); }

  function modParam(m, key, dft) {
    if (m && m[key] != null) return m[key];
    if (m && m.params && m.params[key] != null) return m.params[key];
    return dft;
  }

  function modFieldsHtml(m, i) {
    var t = modType(m);
    if (t === 'subdivision' || t === 'subdivide') {
      var lv = Math.max(1, Math.min(3, Math.round(Number(modParam(m, 'level', 1)) || 1)));
      return '<label class="md-mod-f"><span>级别</span><select data-md-modp="level" data-md-modi="' + i + '">' +
        [1, 2, 3].map(function (n) {
          return '<option value="' + n + '"' + (n === lv ? ' selected' : '') + '>' + n + '</option>';
        }).join('') + '</select></label>';
    }
    if (t === 'mirror') {
      var ax = String(modParam(m, 'axis', 'x')).toLowerCase();
      var mg = Number(modParam(m, 'merge', 0.001));
      return '<label class="md-mod-f"><span>轴</span><select data-md-modp="axis" data-md-modi="' + i + '">' +
        ['x', 'y', 'z'].map(function (a) {
          return '<option value="' + a + '"' + (a === ax ? ' selected' : '') + '>' + a.toUpperCase() + '</option>';
        }).join('') + '</select></label>' +
        '<label class="md-mod-f"><span>焊接</span><input type="number" step="0.001" min="0" max="0.2" data-md-modp="merge" data-md-modi="' + i + '" value="' + mg + '"></label>';
    }
    if (t === 'solidify' || t === 'solid') {
      var th = Number(modParam(m, 'thickness', 0.02));
      var off = Number(modParam(m, 'offset', -1));
      return '<label class="md-mod-f"><span>厚度</span><input type="number" step="0.01" min="-2" max="2" data-md-modp="thickness" data-md-modi="' + i + '" value="' + th + '"></label>' +
        '<label class="md-mod-f"><span>偏移</span><input type="number" step="0.1" min="-1" max="1" data-md-modp="offset" data-md-modi="' + i + '" value="' + off + '"></label>';
    }
    return '';
  }

  function modsHtml() {
    var list = Array.isArray(st.node.modifiers) ? st.node.modifiers : [];
    var baseMesh = SeedModel.Scene.getMesh(st.doc, st.node) || st.mesh;
    var liveMesh = SeedModel.Evaluator.evaluate(st.doc, st.node) || baseMesh;
    var base = baseMesh ? SeedModel.Mesh.stats(baseMesh) : { vertices: 0, faces: 0 };
    var live = liveMesh ? SeedModel.Mesh.stats(liveMesh) : base;
    var rows = list.map(function (m, i) {
      var on = !(m.enabled === false || m.enabled === 0);
      var t = modType(m);
      return '<div class="md-mod-row' + (on ? '' : ' off') + '">' +
        '<label class="md-mod-en" title="启用 / 停用"><input type="checkbox" data-md-modon="' + i + '"' + (on ? ' checked' : '') + '><i></i></label>' +
        '<span class="md-mod-name">' + esc(MOD_LABEL[t] || m.type || '修改器') + '</span>' +
        '<span class="md-mod-ops">' +
        '<button type="button" data-md-act="mod-up" data-md-modi="' + i + '" title="上移">↑</button>' +
        '<button type="button" data-md-act="mod-down" data-md-modi="' + i + '" title="下移">↓</button>' +
        '<button type="button" data-md-act="mod-del" data-md-modi="' + i + '" title="删除">✕</button>' +
        '</span>' +
        '<div class="md-mod-p">' + modFieldsHtml(m, i) + '</div>' +
        '</div>';
    }).join('');
    return '<div class="md-sec">' +
      '<div class="md-h2">修改器 <em class="md-mod-count">' + list.length + '</em></div>' +
      '<div class="md-sec-b">' +
      (rows ? '<div class="md-mod-list">' + rows + '</div>'
        : '<div class="md-note">还没有修改器。添加后视口实时求值；要编辑组件先「应用修改器」。</div>') +
      '<div class="md-mod-add">' +
      '<button type="button" data-md-act="mod-add" data-md-mod="subdivision">细分</button>' +
      '<button type="button" data-md-act="mod-add" data-md-mod="mirror">镜像</button>' +
      '<button type="button" data-md-act="mod-add" data-md-mod="solidify">加厚</button>' +
      '</div>' +
      '<div class="md-note">求值：<b>' + live.faces + '</b> 面 / ' + live.vertices + ' 点' +
      (list.length ? '（基础 ' + base.faces + ' 面）' : '') + '</div>' +
      (list.length ? '<button type="button" class="md-wide" data-md-act="mod-apply">应用修改器（烘焙到网格）</button>' : '') +
      '</div></div>';
  }

  /* 所有修改器改动都从这里过：只改数组，快照 / 重建 / 历史交给 docEdit */
  function modEdit(label, fn) {
    if (!st.doc || !st.node) return false;
    var nodeId = st.node.id;
    var ok = docEdit(label, function () {
      if (!Array.isArray(st.node.modifiers)) st.node.modifiers = [];
      if (fn() === false) return false;
      SeedModel.Scene.revision(st.doc, 'modifiers');
      SeedModel.Evaluator.invalidate(nodeId);
      return true;
    });
    if (ok) {
      /* 生效的修改器会让「求值后网格」的组件选择失效（st.mesh 是缓存结果），
       * 直接退回对象模式，别让用户对着一个不能编辑的组件集拖手柄。 */
      if (st.selMode !== 'object' && modsBlockComponents()) setSelMode('object');
      setStatus(label + '（Ctrl+Z 可撤销）');
    }
    return ok;
  }

  function modAdd(type) {
    if (!st.doc || !st.node) { setStatus('先在视口或大纲里选中一个对象', true); return false; }
    var t = String(type || '').toLowerCase();
    var item = { type: t, enabled: true };
    if (t === 'subdivision') item.level = 1;
    else if (t === 'mirror') { item.axis = 'x'; item.merge = 0.001; }
    else if (t === 'solidify') { item.thickness = 0.02; item.offset = -1; }
    else return false;
    return modEdit('添加修改器：' + (MOD_LABEL[t] || t), function () {
      st.node.modifiers.push(item);
      return true;
    });
  }

  function modSetEnabled(i, on) {
    return modEdit(on ? '启用修改器' : '停用修改器', function () {
      var m = st.node.modifiers[i];
      if (!m) return false;
      m.enabled = !!on;
      return true;
    });
  }

  function modSetParam(i, key, value) {
    return modEdit('修改器参数：' + key, function () {
      var m = st.node.modifiers[i];
      if (!m) return false;
      m[key] = value;
      /* 允许两种写法（扁平键 / params 子对象）同时存在，改一处另一处跟着改，避免分叉 */
      if (m.params && m.params[key] != null) m.params[key] = value;
      return true;
    });
  }

  function modMove(i, dir) {
    return modEdit('调整修改器顺序', function () {
      var arr = st.node.modifiers, j = i + dir;
      if (!arr[i] || j < 0 || j >= arr.length) return false;
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      return true;
    });
  }

  function modDelete(i) {
    return modEdit('删除修改器', function () {
      if (!st.node.modifiers[i]) return false;
      st.node.modifiers.splice(i, 1);
      return true;
    });
  }

  /* 应用 = 把求值结果烘焙成基础网格、清空栈。之后组件编辑恢复正常 */
  function modApply() {
    if (!st.doc || !st.node) return false;
    var node = st.node;
    if (!nodeModsActive(node)) { setStatus('没有生效的修改器可应用', true); return false; }
    var out = SeedModel.Evaluator.evaluate(st.doc, node);
    if (!out) { setStatus('应用修改器失败：求值返回空（检查参数或面数上限）', true); return false; }
    var ok = docEdit('应用修改器', function () {
      SeedModel.Scene.setMesh(st.doc, SeedModel.Mesh.clone(out), st.node);
      SeedModel.Scene.revision(st.doc, 'mesh');
      st.node.modifiers = [];
      SeedModel.Scene.revision(st.doc, 'modifiers');
      SeedModel.Evaluator.invalidate(st.node.id);
      return true;
    });
    if (!ok) return false;
    setStatus('修改器已应用：烘焙为 ' + (out.faceIds ? out.faceIds.length : statsNow().faces) + ' 面，栈已清空（Ctrl+Z 可撤销）');
    return true;
  }

  function paintParams() {
    var box = $('mdParams');
    if (!box) return;
    document.querySelectorAll('.md-ptab[data-md-tab]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTab === st.rightTab);
    });
    if (!st.doc) {
      box.innerHTML = '<div class="md-note">还没有打开文档。</div>';
      return;
    }
    if (!st.node) {
      box.innerHTML = '<div class="md-note">场景是空的：用「新建」加一个对象，或在内容浏览器里「置于」一个模型。</div>';
      return;
    }
    var s = statsNow();
    var t = st.node.transform;
    var mats = st.doc.materials || {};
    var rot = [0, 0, 0];
    if (THREE) {
      var e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(t.rotation));
      rot = [
        Math.round(e.x * 180 / Math.PI), Math.round(e.y * 180 / Math.PI), Math.round(e.z * 180 / Math.PI)
      ];
    }
    var euler = THREE ? rot.join(', ') + '°' : '—';

    /* 通道盒：Maya 里就是属性名 + 数值框的密集列表，适合核对 transform */
    if (st.rightTab === 'channels') {
      box.innerHTML = [
        '<div class="md-sec">',
        '<div class="md-h2">变换</div>',
        '<div class="md-sec-b md-ch-list">',
        chRow('平移 X', fmt(t.position[0])),
        chRow('平移 Y', fmt(t.position[1])),
        chRow('平移 Z', fmt(t.position[2])),
        chRow('旋转 X', rot[0] + '°'),
        chRow('旋转 Y', rot[1] + '°'),
        chRow('旋转 Z', rot[2] + '°'),
        chRow('缩放 X', fmt(t.scale[0])),
        chRow('缩放 Y', fmt(t.scale[1])),
        chRow('缩放 Z', fmt(t.scale[2])),
        chRow('可见性', '开'),
        '</div>',
        '</div>',
        '<div class="md-sec">',
        '<div class="md-h2">节点</div>',
        '<div class="md-sec-b md-ch-list">',
        chRow('名称', st.node.name),
        chRow('类型', st.node.type),
        chRow('顶点', s.vertices),
        chRow('面', s.faces),
        chRow('边', s.edges),
        chRow('三角面', s.triangles),
        '</div>',
        '</div>',
        '<div class="md-sec">',
        '<div class="md-h2">文档</div>',
        '<div class="md-sec-b md-ch-list">',
        chRow('schema', 'v' + (st.doc.schemaVersion || 2)),
        chRow('文档版本', st.doc.revision.current),
        chRow('网格版本', st.doc.revision.mesh || 0),
        chRow('历史', '撤销 ' + st.history.undo.length + ' / 重做 ' + st.history.redo.length),
        '</div>',
        '</div>'
      ].join('');
      return;
    }

    box.innerHTML = [
      '<div class="md-sec">',
      '<div class="md-h2">对象</div>',
      '<div class="md-sec-b">',
      '<label class="md-row1"><span>名称</span><input type="text" data-md-global="name" value="' + esc(st.doc.name) + '"></label>',
      '<div class="md-note">类型：网格 · 文档 v' + (st.doc.schemaVersion || 2) + ' · 网格版本 ' + (st.doc.revision.mesh || 0) + '</div>',
      '<div class="md-note">' + s.vertices + ' 点 · ' + s.faces + ' 面 · ' + s.edges + ' 边 · ' + s.triangles + ' 三角面</div>',
      '</div>',
      '</div>',
      modsHtml(),
      '<div class="md-sec">',
      '<div class="md-h2">变换（手柄拖动）</div>',
      '<div class="md-sec-b md-ch-list">',
      chRow('位置', t.position.map(fmt).join(', ')),
      chRow('旋转', euler),
      chRow('缩放', t.scale.map(fmt).join(', ')),
      '</div>',
      '</div>',
      '<div class="md-sec">',
      '<div class="md-h2">材质槽</div>',
      '<div class="md-sec-b">',
      slotHtml(),
      '<div class="md-note">贴图配置 key：<b>' + esc(mats.textureConfigKey || st.doc.assetId || '—') + '</b>' +
      (mats.textureConfigMissing ? '<span class="md-warn">配置缺失（复制资产未迁移）</span>' : '') + '</div>',
      '<button type="button" class="md-wide" data-md-act="tex">在 3D 查看器里设置贴图</button>',
      '</div>',
      '</div>',
      '<div class="md-sec">',
      '<div class="md-h2">当前能力</div>',
      '<div class="md-sec-b">',
      '<div class="md-note">对象级变换 + 点 / 边 / 面拾取（F8–F11，Shift 加选、Ctrl 减选，选择集写进文档）。' +
      '框选（S3）、软选择、挤出等拓扑算子（M6）尚未接入；算子直接作用在这份 face-vertex 结构上，' +
      '并走 <b>applyMesh()</b> 进历史。</div>',
      '</div>',
      '</div>'
    ].join('');
  }

  function updateHud() {
    if (!st.hudEl || !st.doc) return;
    var s = statsNow();
    var t = st.node ? st.node.transform : null;
    st.hudEl.innerHTML =
      '<span>revision <b>' + st.doc.revision.current + '</b></span>' +
      '<span>网格 <b>' + st.doc.revision.mesh + '</b></span>' +
      '<span><b>' + s.vertices + '</b> 点 / <b>' + s.faces + '</b> 面 / <b>' + s.edges + '</b> 边</span>' +
      '<span>视图 <b>' + (st.quad ? quadViewText() : (st.viewName || '透视')) + '</b></span>' +
      '<span>着色 <b>' + shadeLabel(st.shading) + '</b></span>' +
      '<span>选择 <b>' + SEL_NOUN[st.selMode] +
        (st.selMode === 'object' ? '' : ' ' + selCount()) +
        (st.selMode === 'island' && st.sel.faceIds.length ? '（' + selectedIslandCount() + ' 岛）' : '') +
        '</b></span>' +
      (t ? '<span>位置 <b>' + t.position.map(fmt).join(', ') + '</b></span>' +
        '<span>缩放 <b>' + t.scale.map(fmt).join(', ') + '</b></span>' : '');
  }

  function paintAll() {
    paintOutline();
    paintParams();
    updateHud();
    updateChrome();
    /* UV 窗口打开时跟着外部选择 / 撤销 / 换对象刷新；uvRefresh 自己会做同步判断，
     * 不会反过来触发 paintAll，所以这里不存在递归。 */
    if (st.uv.open) uvRefresh();
  }

  /* ---------------- 选择（S1 拾取 + 高亮） ----------------
   * 拾取算法在 js/seed-selection.js（纯函数、不碰 DOM）；这里只负责
   * 「模式、ID 集合、高亮几何、写回文档」四件事。
   * 选择集存 ID 不存下标：拓扑一变下标就错位，而 ID 由网格内核保证永不复用。 */
  var SEL_NOUN = { object: '对象', vertex: '顶点', edge: '边', face: '面', island: 'UV 岛' };
  var SEL_COLOR = { vertex: 0xf59e0b, edge: 0x38bdf8, face: 0xf59e0b };

  /* UV 岛选择存的是「面 ID 集合」而不是岛 ID：岛是拓扑的派生结果（改一条接缝就变），
   * 面 ID 是稳定的。重开文件时岛身份会丢，但选中的面一个不差 —— 这是有意的取舍。 */
  function selKey() {
    if (st.selMode === 'vertex') return 'vertexIds';
    if (st.selMode === 'edge') return 'edgeIds';
    return 'faceIds';
  }

  function islandFacesOf(faceIndex) {
    if (!st.mesh) return [];
    var isl = SeedModel.Mesh.uvIslands(st.mesh);
    var iid = isl.faceIsland[faceIndex];
    return (iid != null && iid >= 0 && isl.islands[iid]) ? isl.islands[iid].faces.slice() : [faceIndex];
  }

  function selectedIslandCount() {
    if (!st.mesh || !st.sel.faceIds.length) return 0;
    var isl = SeedModel.Mesh.uvIslands(st.mesh);
    var want = Object.create(null);
    st.sel.faceIds.forEach(function (id) { want[id] = 1; });
    var seen = Object.create(null), n = 0;
    for (var f = 0; f < st.mesh.faceIds.length; f++) {
      if (!want[st.mesh.faceIds[f]]) continue;
      var iid = isl.faceIsland[f];
      if (iid == null || iid < 0) continue;
      if (!seen[iid]) { seen[iid] = 1; n++; }
    }
    return n;
  }

  /* 拓扑变化后旧 ID 会消失：每次画之前先剪掉不存在的，别让高亮指向空气 */
  function pruneSelection() {
    if (!st.mesh) return;
    var vs = Object.create(null), fs = Object.create(null), es = Object.create(null), i;
    for (i = 0; i < st.mesh.vertexIds.length; i++) vs[st.mesh.vertexIds[i]] = 1;
    for (i = 0; i < st.mesh.faceIds.length; i++) fs[st.mesh.faceIds[i]] = 1;
    var e = SeedModel.Mesh.ensureEdges(st.mesh);
    for (i = 0; i < e.edges.length; i++) es[e.edges[i].id] = 1;
    st.sel.vertexIds = st.sel.vertexIds.filter(function (id) { return vs[id]; });
    st.sel.faceIds = st.sel.faceIds.filter(function (id) { return fs[id]; });
    st.sel.edgeIds = st.sel.edgeIds.filter(function (id) { return es[id]; });
  }

  function disposeSelection() {
    if (!st.selGroup) return;
    if (st.selGroup.parent) st.selGroup.parent.remove(st.selGroup);
    st.selGroup.traverse(function (o) {
      if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
      if (o.material) { try { o.material.dispose(); } catch (e) {} }
    });
    st.selGroup = null;
  }

  /* 高亮三件套：面（半透明罩）、边（穿透过）、点（深环 + 亮芯，和顶点层同构）
   * mesh 可传预览网格：挤出拖动时高亮要跟着预览的顶面走，不能停在旧位置 */
  function paintSelection(mesh) {
    disposeSelection();
    var mm = mesh || st.mesh;
    if (!st.pivot || !mm) return;
    pruneSelection();
    var g = new THREE.Group();
    g.name = 'selection';
    g.userData.mdPart = 'sel';

    var fi = st.sel.faceIds;
    if (fi.length) {
      var byId = Object.create(null);
      for (var f = 0; f < mm.faceIds.length; f++) byId[mm.faceIds[f]] = f;
      var tris = [];
      for (var k = 0; k < fi.length; k++) {
        var face = byId[fi[k]];
        if (face == null) continue;
        var s = mm.faceOffsets[face], e = mm.faceOffsets[face + 1];
        for (var t = s + 1; t < e - 1; t++) {
          [mm.faceIndices[s], mm.faceIndices[t], mm.faceIndices[t + 1]].forEach(function (vi) {
            tris.push(mm.positions[vi * 3], mm.positions[vi * 3 + 1], mm.positions[vi * 3 + 2]);
          });
        }
      }
      if (tris.length) {
        var fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
        fg.computeBoundingSphere();
        var fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
          color: SEL_COLOR.face, transparent: true, opacity: 0.42,
          depthWrite: false, side: THREE.DoubleSide
        }));
        fm.renderOrder = 6;
        fm.userData.mdPart = 'sel';
        g.add(fm);
      }
    }

    var ei = st.sel.edgeIds;
    if (ei.length) {
      var edges = SeedModel.Mesh.ensureEdges(mm).edges;
      var want = Object.create(null), j;
      for (j = 0; j < ei.length; j++) want[ei[j]] = 1;
      var buf = [];
      for (j = 0; j < edges.length; j++) {
        var rec = edges[j];
        if (!want[rec.id]) continue;
        buf.push(
          mm.positions[rec.a * 3], mm.positions[rec.a * 3 + 1], mm.positions[rec.a * 3 + 2],
          mm.positions[rec.b * 3], mm.positions[rec.b * 3 + 1], mm.positions[rec.b * 3 + 2]
        );
      }
      if (buf.length) {
        var eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
        eg.computeBoundingSphere();
        var em = new THREE.LineBasicMaterial({ color: SEL_COLOR.edge, depthTest: false });
        var lines = new THREE.LineSegments(eg, em);
        lines.renderOrder = 7;
        lines.frustumCulled = false;
        lines.userData.mdPart = 'sel';
        g.add(lines);
      }
    }

    var vi = st.sel.vertexIds;
    if (vi.length) {
      var byVid = Object.create(null);
      for (var v = 0; v < mm.vertexIds.length; v++) byVid[mm.vertexIds[v]] = v;
      var pts = [];
      for (var q = 0; q < vi.length; q++) {
        var idx = byVid[vi[q]];
        if (idx == null) continue;
        pts.push(mm.positions[idx * 3], mm.positions[idx * 3 + 1], mm.positions[idx * 3 + 2]);
      }
      if (pts.length) {
        var vg = new THREE.BufferGeometry();
        vg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        vg.computeBoundingSphere();
        var dpr = Math.min(global.devicePixelRatio || 1, 2);
        [[SEL_COLOR.vertex, 9, 8], [0xfff6e8, 4.5, 9]].forEach(function (spec) {
          var mat = new THREE.PointsMaterial({
            color: spec[0], size: spec[1] * dpr, sizeAttenuation: false,
            transparent: true, depthWrite: false, depthTest: false
          });
          var p = new THREE.Points(vg, mat);
          p.renderOrder = spec[2];
          p.frustumCulled = false;
          p.userData.mdPart = 'sel';
          g.add(p);
        });
      }
    }

    /* 隔离显示时选择一变，替身网格跟着换（没选任何面就退回整只对象） */
    if (st.isolate) refreshIsoChild();
    if (!g.children.length) { syncGizmo(); return; }
    st.pivot.add(g);
    st.selGroup = g;
    syncGizmo();
  }

  /* ---------------- 组件变换（点 / 边 / 面 / UV 岛） ----------------
   * 思路：手柄永远只认一个 Object3D（compPivot），把它放在「选中组件的中心」。
   * 拖动时手柄按**世界坐标**改 compPivot 的 position/quaternion/scale，
   * 我们取 D = M_now · M_start⁻¹（世界空间的增量矩阵），再对每个顶点做：
   *     p世界 = pivotWorld · p局部 → p世界' = D · p世界 → p局部' = pivotWorld⁻¹ · p世界'
   * 这样平移 / 旋转 / 缩放、乃至对象本身被旋转过，都用同一条公式，不需要给三种模式各写一套。 */

  /* 当前选择涉及哪些顶点（局部下标）。边取两端、面取整圈、岛同理。 */
  function selVertexIndices() {
    if (!st.mesh) return [];
    var out = [], seen = Object.create(null);
    function add(vi) { if (seen[vi]) return; seen[vi] = 1; out.push(vi); }
    var i, f;
    if (st.selMode === 'vertex') {
      var map = Object.create(null);
      for (i = 0; i < st.mesh.vertexIds.length; i++) map[st.mesh.vertexIds[i]] = i;
      st.sel.vertexIds.forEach(function (id) { if (map[id] != null) add(map[id]); });
    } else if (st.selMode === 'edge') {
      var want = Object.create(null);
      st.sel.edgeIds.forEach(function (id) { want[id] = 1; });
      SeedModel.Mesh.ensureEdges(st.mesh).edges.forEach(function (rec) {
        if (want[rec.id]) { add(rec.a); add(rec.b); }
      });
    } else if (st.selMode === 'face' || st.selMode === 'island') {
      var byId = Object.create(null);
      for (f = 0; f < st.mesh.faceIds.length; f++) byId[st.mesh.faceIds[f]] = f;
      st.sel.faceIds.forEach(function (id) {
        var fi = byId[id];
        if (fi == null) return;
        var s0 = st.mesh.faceOffsets[fi], e0 = st.mesh.faceOffsets[fi + 1];
        for (var k = s0; k < e0; k++) add(st.mesh.faceIndices[k]);
      });
    }
    return out;
  }

  function compCenter(idx) {
    var p = st.mesh.positions, n = idx.length;
    if (!n) return null;
    var x = 0, y = 0, z = 0;
    for (var k = 0; k < n; k++) {
      var vi = idx[k];
      x += p[vi * 3]; y += p[vi * 3 + 1]; z += p[vi * 3 + 2];
    }
    return { x: x / n, y: y / n, z: z / n };
  }

  /* 有组件选择 → 手柄挂在组件中心；没有 → 回到对象（老行为） */
  function syncGizmo() {
    /* 绘画页签：手柄必须收起。它在 canvas 的捕获阶段抢 pointerdown（并且会 stopPropagation），
     * 否则在模型中心落笔会被「屏幕平移」手柄吃掉，画不上颜色还顺手挪了对象。 */
    if (st.tbKind === 'paint') {
      if (st.gizmo) st.gizmo.setTarget(null);
      return;
    }
    /* 会话自带操纵器时由它接管（挤出有专用法线箭头 + 轴心缩放柄）：变换手柄收起来，
     * 否则同位叠放、点箭头会变成移动组件。判据来自工具 spec 的 `ownsGizmo`，
     * **不再在外壳里认 id** —— 加一个自带手柄的工具不该要改这里。
     * SeedTools 还没加载 / 没有会话 → ownsGizmo() 为假，走正常分支（与旧行为一致）。 */
    if (global.SeedTools && global.SeedTools.ownsGizmo && global.SeedTools.ownsGizmo()) {
      if (st.gizmo) st.gizmo.setTarget(null);
      return;
    }
    if (!st.gizmo || !st.pivot || !THREE || !st.compPivot) return;
    /* 单独显示定格的是别的对象时，激活对象在视口里是隐藏的：手柄不能挂在它身上，
     * 否则会拖到看不见的东西。 */
    if (st.isolate && !ISO.nodeVisible(st.node ? st.node.id : '')) {
      st.gizmo.setTarget(null);
      return;
    }
    if (st.compDrag) return;                       /* 拖动中不要动目标，否则增量会跳 */
    var idx = (st.selMode === 'object') ? [] : selVertexIndices();
    st.compIdx = idx;
    if (!idx.length) {
      st.compPivot.visible = false;
      st.gizmo.setTarget(st.pivot);
      return;
    }
    var c = compCenter(idx);
    var w = st.pivot.localToWorld(new THREE.Vector3(c.x, c.y, c.z));
    st.compPivot.position.copy(w);
    st.compPivot.quaternion.set(0, 0, 0, 1);
    st.compPivot.scale.set(1, 1, 1);
    st.compPivot.updateMatrixWorld(true);
    st.compPivot.visible = true;
    st.gizmo.setTarget(st.compPivot);
  }

  /* 拖动中：按增量矩阵重写选中顶点的局部坐标（每帧从 base 重算，绝不叠乘） */
  function applyCompDelta() {
    var d = st.compDrag;
    if (!d) return;
    st.compPivot.updateMatrixWorld(true);
    var now = new THREE.Matrix4().copy(st.compPivot.matrixWorld);
    var D = now.multiply(new THREE.Matrix4().copy(d.m0).invert());
    var M = st.pivot.matrixWorld;
    var v = d._v || (d._v = new THREE.Vector3());
    for (var k = 0; k < d.idx.length; k++) {
      var vi = d.idx[k];
      v.set(d.base[k * 3], d.base[k * 3 + 1], d.base[k * 3 + 2]);
      v.applyMatrix4(M).applyMatrix4(D).applyMatrix4(d.minv);
      st.mesh.positions[vi * 3] = v.x;
      st.mesh.positions[vi * 3 + 1] = v.y;
      st.mesh.positions[vi * 3 + 2] = v.z;
    }
    /* 软选择：按权重把「完整变换」与原始位置做线性混合 */
    if (d.softIdx) {
      for (var s = 0; s < d.softIdx.length; s++) {
        var svi = d.softIdx[s], sb = s * 3, w = d.softW[s];
        var bx = d.softBase[sb], by = d.softBase[sb + 1], bz = d.softBase[sb + 2];
        v.set(bx, by, bz).applyMatrix4(M).applyMatrix4(D).applyMatrix4(d.minv);
        st.mesh.positions[svi * 3] = bx + (v.x - bx) * w;
        st.mesh.positions[svi * 3 + 1] = by + (v.y - by) * w;
        st.mesh.positions[svi * 3 + 2] = bz + (v.z - bz) * w;
      }
    }
    SeedModel.Mesh.bump(st.mesh);
    liveRefresh();
  }

  /* 拖动中的即时显示：只改缓冲区里的坐标，不重建几何对象（否则每帧都在建 BufferGeometry） */
  function liveRefresh() {
    var i;
    /* 有 UV 的网格在 buildGeometry 里按 (顶点, UV) 拆过点：渲染顶点和原顶点不再一一对应，
     * 必须按 geo.userData.mdOrig 映射回写，否则拖面时整块网格会炸开 */
    if (st.pivot) {
      st.pivot.traverse(function (o) {
        if (!o.userData || o.userData.mdPart !== 'solid') return;
        var geo = o.geometry;
        if (!geo || !geo.attributes.position) return;
        var ga = geo.attributes.position, arr = ga.array;
        var map = geo.userData && geo.userData.mdOrig;
        var n = map ? Math.min(map.length, arr.length / 3)
          : Math.min(st.mesh.positions.length, arr.length);
        for (var r = 0; r < n; r++) {
          var oi = (map ? map[r] : r) * 3, ri = r * 3;
          arr[ri] = st.mesh.positions[oi];
          arr[ri + 1] = st.mesh.positions[oi + 1];
          arr[ri + 2] = st.mesh.positions[oi + 2];
        }
        ga.needsUpdate = true;
        geo.computeBoundingSphere();
        geo.computeVertexNormals();
      });
    }
    if (st.vertPoints && st.vertPoints.children && st.vertPoints.children[0]) {
      var vg = st.vertPoints.children[0].geometry.attributes.position;
      if (vg) {
        /* 顶点叠加层是按原顶点直接建的，恒等拷贝即可 */
        for (i = 0; i < st.mesh.positions.length && i < vg.array.length; i++) vg.array[i] = st.mesh.positions[i];
        vg.needsUpdate = true;
      }
    }
    if (st.edgeLines && st.edgeRecs) {
      var eg = st.edgeLines.geometry;
      var earr = eg.attributes.position.array;
      for (i = 0; i < st.edgeRecs.length; i++) {
        var rec = st.edgeRecs[i];
        var a = rec.a * 3, b = rec.b * 3;
        earr[i * 6] = st.mesh.positions[a];
        earr[i * 6 + 1] = st.mesh.positions[a + 1];
        earr[i * 6 + 2] = st.mesh.positions[a + 2];
        earr[i * 6 + 3] = st.mesh.positions[b];
        earr[i * 6 + 4] = st.mesh.positions[b + 1];
        earr[i * 6 + 5] = st.mesh.positions[b + 2];
      }
      eg.attributes.position.needsUpdate = true;
      eg.computeBoundingSphere();
    }
    paintSelection();
    updateHud();
  }

  function restoreCompBase() {
    var d = st.compDrag;
    if (!d) return;
    for (var k = 0; k < d.idx.length; k++) {
      var vi = d.idx[k];
      st.mesh.positions[vi * 3] = d.base[k * 3];
      st.mesh.positions[vi * 3 + 1] = d.base[k * 3 + 1];
      st.mesh.positions[vi * 3 + 2] = d.base[k * 3 + 2];
    }
    if (d.softIdx) {
      for (var s = 0; s < d.softIdx.length; s++) {
        var svi = d.softIdx[s];
        st.mesh.positions[svi * 3] = d.softBase[s * 3];
        st.mesh.positions[svi * 3 + 1] = d.softBase[s * 3 + 1];
        st.mesh.positions[svi * 3 + 2] = d.softBase[s * 3 + 2];
      }
    }
    SeedModel.Mesh.bump(st.mesh);
    liveRefresh();
  }

  function syncSelectionDoc() {
    if (!st.doc) return;
    SeedModel.Scene.setSelection(st.doc, {
      mode: st.selMode,
      nodeIds: st.node ? [st.node.id] : [],
      vertexIds: st.sel.vertexIds,
      edgeIds: st.sel.edgeIds,
      faceIds: st.sel.faceIds
    });
  }

  /* 打开文档时把选择集读回内存：文档里存的是 ID，重建后由 pruneSelection 剔掉不存在的 */
  function loadSelection(doc) {
    var s = (doc && doc.selection) || {};
    st.selMode = ['object', 'vertex', 'edge', 'face', 'island'].indexOf(s.mode) >= 0 ? s.mode : 'object';
    st.sel = {
      vertexIds: Array.isArray(s.vertexIds) ? s.vertexIds.slice() : [],
      edgeIds: Array.isArray(s.edgeIds) ? s.edgeIds.slice() : [],
      faceIds: Array.isArray(s.faceIds) ? s.faceIds.slice() : []
    };
  }

  function selCount() {
    return st.selMode === 'vertex' ? st.sel.vertexIds.length
      : st.selMode === 'edge' ? st.sel.edgeIds.length : st.sel.faceIds.length;
  }

  function setSelMode(mode) {
    if (!SEL_NOUN[mode] || st.selMode === mode) return;
    /* 修改器生效时组件编辑会写坏求值缓存：先挡住，别让用户白拖一帧 */
    if (mode !== 'object' && modsBlockComponents()) {
      setStatus('该对象有修改器：先「应用修改器」或删掉修改器，再编辑组件', true);
      return;
    }
    if (mode === 'island' && st.mesh) SeedModel.Mesh.ensureUV(st.mesh);
    /* 换模式不清空：按包含关系转换（点→边→面→岛；对象模式不带组件信息）。
     * 转换是纯数据动作，失败（内核缺席 / 无网格）才退回空集。 */
    var prevMode = st.selMode;
    var conv = (global.SeedSelection && st.mesh)
      ? global.SeedSelection.convertSelection(st.mesh, prevMode, mode, st.sel)
      : null;
    st.selMode = mode;
    if (mode !== 'object') st.lastCompMode = mode;
    st.sel = conv || { vertexIds: [], edgeIds: [], faceIds: [] };
    syncSelectionDoc();
    applyShading();          /* 顶点层的显隐跟着选择模式走 */
    paintSelection();
    updateHud();
    updateChrome();          /* 模式条 / 页签 / 标题上的「当前模式」都靠它同步 */
    setStatus('选择模式：' + SEL_NOUN[mode] + '（F8 对象 / F9 点 / F10 边 / F11 面 / F12 UV 岛）');
  }

  function applyPick(hit, add, toggle) {
    if (!st.doc) return;
    if (st.selMode !== 'object' && modsBlockComponents()) {
      setStatus('该对象有修改器：先「应用修改器」或删掉修改器，再编辑组件', true);
      return;
    }
    if (st.selMode === 'object') {
      setStatus(hit ? '已选中对象：' + (st.node ? st.node.name : '') : '没有点中对象');
      paintAll();
      return;
    }
    /* UV 岛模式：命中一个面 → 整个岛（共享边 UV 连续的一串面）一起选 */
    if (st.selMode === 'island') {
      var ids = [];
      if (hit) {
        ids = islandFacesOf(hit.index).map(function (f) { return st.mesh.faceIds[f]; });
      }
      var cur = st.sel.faceIds.slice();
      if (!ids.length) {
        if (!add && !toggle) st.sel.faceIds = [];
      } else if (toggle) {
        var has = cur.indexOf(ids[0]) >= 0;
        if (has) {
          var drop = Object.create(null);
          ids.forEach(function (x) { drop[x] = 1; });
          st.sel.faceIds = cur.filter(function (x) { return !drop[x]; });
        } else {
          st.sel.faceIds = cur.concat(ids.filter(function (x) { return cur.indexOf(x) < 0; }));
        }
      } else if (add) {
        st.sel.faceIds = cur.concat(ids.filter(function (x) { return cur.indexOf(x) < 0; }));
      } else {
        st.sel.faceIds = ids;
      }
      syncSelectionDoc();
      paintSelection();
      paintAll();
      var nf = st.sel.faceIds.length;
      setStatus(nf
        ? ('已选 ' + nf + ' 个面 · ' + selectedIslandCount() + ' 个 UV 岛')
        : '选择已清空');
      return;
    }

    var key = selKey();
    var list = st.sel[key].slice();
    if (!hit) {
      if (!add && !toggle) st.sel[key] = [];
    } else if (toggle) {
      var at = list.indexOf(hit.id);
      if (at >= 0) list.splice(at, 1); else list.push(hit.id);
      st.sel[key] = list;
    } else if (add) {
      if (list.indexOf(hit.id) < 0) list.push(hit.id);
      st.sel[key] = list;
    } else {
      st.sel[key] = [hit.id];
    }
    syncSelectionDoc();
    paintSelection();
    paintAll();
    var n = selCount();
    setStatus(n ? ('已选 ' + n + ' 个' + SEL_NOUN[st.selMode]) : '选择已清空');
  }

  /* 工具手势：点选 / 框选 / 套索 / 绘制选择。
   * 统一成「pointerdown 记起点 → pointermove 更新覆盖层 → pointerup 提交」，
   * 因为三种选择工具只差最后那一步的判定（点 / 矩形 / 多边形 / 圆形笔刷）。 */
  function canvasPoint(e) {
    var r = st.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }

  function gestNodes() {
    return {
      root: $('mdGest'), box: $('mdGestBox'),
      svg: $('mdGestLasso'), poly: $('mdGestPoly'), brush: $('mdGestBrush')
    };
  }

  function gestClear() {
    var n = gestNodes();
    if (n.root) n.root.className = 'md-gest';
    if (n.poly) n.poly.setAttribute('points', '');
    if (n.box) n.box.style.cssText = '';
    if (n.brush) n.brush.style.cssText = '';
  }

  /* 笔刷圈常驻（Maya 也是：选了绘制选择就能看到圈） */
  function brushFollow(e) {
    if (st.tool !== 'paint' && st.tbKind !== 'paint') return;
    var n = gestNodes();
    if (!n.brush) return;
    var p = canvasPoint(e);
    var R = st.tbKind === 'paint' ? Math.max(3, st.paint.size * 0.5) : 22;
    n.brush.style.display = 'block';
    n.brush.style.width = n.brush.style.height = (R * 2) + 'px';
    n.brush.style.left = (p.x - R) + 'px';
    n.brush.style.top = (p.y - R) + 'px';
    if (st.tbKind === 'paint') {
      /* 画笔环直接染成当前颜色，软笔描虚线、橡皮用灰环 */
      n.brush.style.borderColor = st.paint.brush === 'erase' ? '#9aa0a6' : st.paint.color;
      n.brush.style.borderStyle = st.paint.brush === 'hard' ? 'solid' : 'dashed';
    } else {
      n.brush.style.borderColor = '';
      n.brush.style.borderStyle = '';
    }
  }

  /* 多切割：屏幕线段 → 相机射线平面 → 转成网格局部平面 → 切面。
   * 透视相机用两条射线叉乘；正交（四视图）射线平行，退化为「视线 × 屏幕线方向」。 */
  function knifeCutFromScreen(g, r) {
    if (!THREE || !st.camera || !st.pivot) return false;
    /* 激活对象在视口里被藏起来时不许切：切割落在看不见的网格上没有意义 */
    if (!ISO.visibleMesh(st.node ? st.node.id : '')) {
      setStatus('多切割：当前对象在视口里不可见，先退出单独显示', true);
      return false;
    }
    var d1 = new THREE.Vector2((g.x0 / r.width) * 2 - 1, -((g.y0 / r.height) * 2 - 1));
    var d2 = new THREE.Vector2((g.x / r.width) * 2 - 1, -((g.y / r.height) * 2 - 1));
    var rc = new THREE.Raycaster();
    rc.setFromCamera(d1, st.camera);
    var dir1 = rc.ray.direction.clone(), origin = rc.ray.origin.clone();
    rc.setFromCamera(d2, st.camera);
    var dir2 = rc.ray.direction.clone();
    var n = new THREE.Vector3().crossVectors(dir1, dir2);
    if (n.lengthSq() < 1e-8) {
      /* 正交相机：用相机的右 / 上基 + 屏幕线方向构造平面法线 */
      var me = st.camera.matrixWorld.elements;
      var right = new THREE.Vector3(me[0], me[1], me[2]);
      var up = new THREE.Vector3(me[4], me[5], me[6]);
      var fwd = new THREE.Vector3(-me[8], -me[9], -me[10]);
      var dx = g.x - g.x0, dy = g.y - g.y0;
      var lineDir = right.multiplyScalar(dx).add(up.multiplyScalar(-dy));
      n = new THREE.Vector3().crossVectors(lineDir, fwd);
      origin = st.camera.getWorldPosition(new THREE.Vector3());
    }
    if (n.lengthSq() < 1e-10) { setStatus('切割线太短，请拖长一点', true); return false; }
    n.normalize();
    var dWorld = n.dot(origin);

    /* n_local = Mᵀ · n_world（因为 n_world·(M x) = (Mᵀ n_world)·x） */
    var mw = st.pivot.matrixWorld.elements;
    var nl = new THREE.Vector3(
      mw[0] * n.x + mw[1] * n.y + mw[2] * n.z,
      mw[4] * n.x + mw[5] * n.y + mw[6] * n.z,
      mw[8] * n.x + mw[9] * n.y + mw[10] * n.z
    );
    var lineLen = nl.length();
    if (lineLen < 1e-8) return false;
    nl.multiplyScalar(1 / lineLen);
    var plane = { nx: nl.x, ny: nl.y, nz: nl.z, d: dWorld / lineLen };

    var cut = global.SeedOps.knifePlaneCut(baseMeshNow(), { plane: plane });
    if (!cut) { setStatus('多切割：这条线没有穿过当前网格', true); return false; }
    applyMesh(cut, '多切割');
    setStatus('多切割：已沿视平面切开');
    return true;
  }

  /* ---------------- 绘画工具箱：把颜色画进基础色贴图 ----------------
   * 贴图真源仍是 doc.materials.slotMaps（data URL）。笔刷落在 UV 坐标上：
   * 工作副本是一张 canvas（打开时把已有贴图解码进来），笔画结束再编码回文档。
   * 这样不用改材质系统，也天然跟着 seedModel 存进 GLB。 */
  /* ---------------- 绘画（已拆到 js/md-paint.js） ---------------- */
  /* 外壳只留门面：落笔 / 拖动 / 抬笔 / 取消 / 撤销补丁。
   * 贴图工作区（canvas / 上下文 / 当前槽）仍在共享 st.paint 里，UI 直接改参数。 */
  var PAINT = global.MDPaint.create({
    st: st, THREE: THREE, SeedModel: SeedModel,
    sharedTexture: sharedTexture,
    setStatus: setStatus, updateChrome: updateChrome,
    rebuildModel: rebuildModel, paintAll: paintAll,
    uvRefreshSolidGeometry: uvRefreshSolidGeometry,
    /* 修改器生效时不能给求值网格「补 UV」：那份网格是 evaluator 的缓存 */
    nodeModsActive: nodeModsActive,
    /* 绘画和拾取共用同一条可见性口径：面级隔离时画到的就是视口里那份替身网格 */
    visibleMesh: function (id) { return ISO.visibleMesh(id); },
    totalBytes: totalBytes, syncBytes: syncBytes, historyBudget: HISTORY_BUDGET,
    /* 材质落点与纹理混合：笔迹画在基础画布上，材质上挂的是「合成结果」 */
    applySlotTexture: applySlotTexture,
    baseImageFor: function (slot) { return MIX ? MIX.baseImageFor(slot) : null; },
    /* 底图兜底：材质上真正挂着的那张（贴图只挂在 map 上、slotMaps 是空的老资产） */
    liveSlotImage: liveSlotImage,
    onPaintBase: function (slot) { if (MIX) MIX.schedule(slot); },
    onPaintInk: function (slot) { if (MIX) MIX.schedule(slot); },
    onPaintReset: function (slot) { if (MIX) MIX.schedule(slot); },
    onPaintSlot: function (slot) { if (MIX) MIX.selectSlot(slot); },
    /* 纹理混合要读当前绘画工作区：正在画这一槽时，笔迹必须参与合成 */
    paintCanvasFor: function (slot) {
      var p = st.paint;
      return (st.doc && p.doc === st.doc && p.slot === slot && p.canvas) ? p.canvas : null;
    },
    paintTexFor: function (slot) {
      var p = st.paint;
      return (st.doc && p.doc === st.doc && p.slot === slot && p.tex) ? p.tex : null;
    }
  });
  function paintStrokeBegin(e) { return PAINT.begin(e); }
  function paintStrokeMove(e) { return PAINT.move(e); }
  function paintStrokeEnd() { return PAINT.end(); }
  function paintClipRelease() { return PAINT.cancel(); }
  function applyPaintPatch(patch, side) { return PAINT.applyPatch(patch, side); }

  /* ---------------- 纹理混合（已拆到 js/md-texmix.js） ----------------
   * 配置真源是模型库同一份 localStorage（openagi_model_tex_v1），
   * 图片由资产库保管；这里只负责解码、合成、挂材质、配置编辑 UI 与撤销补丁。 */
  var MIX = null;
  function applyMixPatch(patch, side) { if (MIX) MIX.applyPatch(patch, side); }
  if (global.MDTexMix) {
    MIX = global.MDTexMix.create({
      st: st, THREE: THREE, SeedModel: SeedModel,
      setStatus: setStatus, updateChrome: updateChrome,
      sharedTexture: sharedTexture,
      applySlotTexture: applySlotTexture,
      liveSlotImage: liveSlotImage,
      totalBytes: totalBytes, syncBytes: syncBytes, historyBudget: HISTORY_BUDGET,
      paintCanvasFor: function (slot) {
        var p = st.paint;
        return (st.doc && p.doc === st.doc && p.slot === slot && p.canvas) ? p.canvas : null;
      },
      paintTexFor: function (slot) {
        var p = st.paint;
        return (st.doc && p.doc === st.doc && p.slot === slot && p.tex) ? p.tex : null;
      },
      /* 3D 遮罩绘制要走和画笔同一套射线：命中槽 / 面 / UV 的口径必须一致 */
      paintRayHit: function (x, y) { return PAINT.rayHit(x, y); },
      setMaskPaintMode: setMaskPaintMode
    });
  }

  /* 纹理来源统一读取（js/tex-source.js）：把「这一槽的底图到底是哪张」收成一处。
   * 绘画 / 混合 / 投射烘焙 / UV 编辑器四个读者都问它，不再各答各的 ——
   * 以前的答案是四份不同的，同一个动作会因 slotMaps 空不空而走向相反的错误。 */
  if (global.TexSource) {
    global.TexSource.bind({
      doc: function () { return st.doc; },
      sharedTexture: sharedTexture,
      liveSlotImage: liveSlotImage,
      bakedOf: function (slot) { return MIX ? MIX.bakedImageFor(slot) : null; },
      /* 合成图不能当底座（不透明、每帧都可能变），见 tex-source.js 第 4 步。
       * ⚠ 返回的是 **image**，不是 Texture —— liveSlotImage 给的也是 image，
       * 拿 Texture 和 image 比永远不相等，排除逻辑会静默失效。 */
      composedOf: function (slot) {
        var t = MIX && MIX.texFor(slot);
        return (t && t.image) || null;
      }
    });
  }

  /* 视口进入「遮罩绘制」：关掉选择/画笔的落笔判定与 OrbitControls，
   * 指针事件由 MDTexMix 自己在 capture 阶段接管（否则绘画页签一按就落笔）。 */
  function setMaskPaintMode(on) {
    st.noPick = !!on;
    if (st.controls) st.controls.enabled = !on;
    if (st.canvas) st.canvas.style.cursor = on ? 'crosshair' : '';
  }

  /* ---------------- 材质槽（P5） ----------------
   * 槽改动不进 Scene 快照：slotMaps 是贴图 data URL，每步历史都深拷贝会瞬间吃满预算。
   * 这里只做「浅快照」（字符串按引用共享），随 entry.mats 入栈，撤销时整体替换三份数组。 */
  function matsSnap() {
    var m = (st.doc && st.doc.materials) || {};
    return {
      slotNames: (m.slotNames || []).slice(),
      slotColors: (m.slotColors || []).slice(),
      slotMaps: (m.slotMaps || []).slice(),
      textureConfigKey: m.textureConfigKey || ''
    };
  }
  /* 编辑层栈补丁（投射 / 固化）：ops 数组整体替换，可选同时换一张 slotMaps。
   * 与 mats 补丁分开的原因：mats 快照里带三份数组，用它来撤「投射」会顺手
   * 覆盖槽名 / 槽色（applyMatsPatch 缺字段就清空），代价太大。 */
  function applyTexPatch(patch, side) {
    if (!st.doc || !patch) return;
    if (global.TexStack && patch.slot != null) {
      global.TexStack.setOps(st.doc, patch.slot, patch[side] || []);
      var mapSide = patch[side + 'Map'];
      if (mapSide != null) {
        var m = st.doc.materials || (st.doc.materials = {});
        var arr = m.slotMaps || (m.slotMaps = []);
        while (arr.length <= patch.slot) arr.push('');
        arr[patch.slot] = mapSide;
      }
    }
    /* 绘画工作区必须跟着作废：那张画布是「底座 ⊕ 层」的快照，
     * 栈变了它就不再成立。不作废的话撤销完笔迹还留在画布上，
     * 下一次落笔又把它当底座提交一遍（症状：撤销后笔迹更浓）。 */
    st.paint.tex = null; st.paint.canvas = null; st.paint.ctx = null;
    st.paint.ink = null; st.paint.inkCtx = null; st.paint.inkDirty = false;
    st.paint.slot = -1; st.paint.doc = null;
    /* 同步重合成：撤销后不该等异步解码才看到结果 */
    if (MIX) MIX.composeNow(patch.slot);
  }

  function applyMatsPatch(patch, side) {
    if (!st.doc || !patch) return;
    var v = patch[side];
    if (!v) return;
    var m = st.doc.materials || (st.doc.materials = {});
    m.slotNames = (v.slotNames || []).slice();
    m.slotColors = (v.slotColors || []).slice();
    m.slotMaps = (v.slotMaps || []).slice();
    if (v.textureConfigKey) m.textureConfigKey = v.textureConfigKey;
    /* 贴图可能整组换过：绘画工作区按旧 URL 建的 canvas 不能继续复用 */
    st.paint.tex = null; st.paint.canvas = null; st.paint.ctx = null;
    st.paint.clipCtx = null; st.paint.slot = -1; st.paint.doc = null;
  }
  function slotEdit(label, fn) {
    if (!st.doc) return false;
    var before = snap(), matsBefore = matsSnap();
    var ok = fn();
    if (ok === false) return false;
    st.node = SeedModel.Scene.nodeOf(st.doc);
    st.mesh = SeedModel.Scene.getMesh(st.doc);
    rebuildModel(true);
    paintAll();
    var after = snap(), matsAfter = matsSnap();
    return HIST.pushEntry({
      before: before, after: after,
      mats: { before: matsBefore, after: matsAfter },
      label: label || '材质槽编辑'
    });
  }
  function slotAdd() {
    var idx = -1;
    var ok = slotEdit('新增材质槽', function () {
      idx = SeedModel.Scene.addSlot(st.doc);
      return idx >= 0;
    });
    if (ok && MIX) MIX.selectSlot(idx);
    if (!ok) setStatus('新增材质槽失败', true);
  }
  function slotRename(i, name) {
    var ok = slotEdit('重命名材质槽', function () {
      return SeedModel.Scene.renameSlot(st.doc, i, name);
    });
    if (!ok) paintAll();
  }
  function slotSetColor(i, color) {
    slotEdit('材质槽颜色', function () {
      var m = st.doc.materials;
      var colors = m.slotColors || (m.slotColors = []);
      while (colors.length <= i) colors.push('#c9ccd4');
      colors[i] = color;
      return true;
    });
  }
  function slotDelete(i) {
    var ok = slotEdit('删除材质槽', function () {
      return SeedModel.Scene.removeSlot(st.doc, i);
    });
    if (!ok) setStatus('至少保留一个材质槽', true);
  }
  function slotAssignFaces(i) {
    var ids = (st.sel && st.sel.faceIds) || [];
    if (!ids.length) {
      setStatus('先在面或 UV 岛模式下选中要指派的面', true);
      return;
    }
    var n = 0;
    docEdit('指派面到材质槽', function () {
      n = SeedModel.Scene.assignSlot(st.doc, st.node, ids, i);
      if (!n) return false;
      SeedModel.Scene.revision(st.doc, 'mesh');
      st.mesh = SeedModel.Scene.getMesh(st.doc);
      return true;
    });
    setStatus(n ? ('已把 ' + n + ' 个面指派到「' + slotNameAt(i) + '」') : '这些面已经在该槽里');
  }
  function slotNameAt(i) {
    var names = (st.doc && st.doc.materials && st.doc.materials.slotNames) || [];
    return names[i] || ('插槽 ' + (i + 1));
  }

  /* 右侧栏三个页签共用一行：建模工具箱 / 绘画工具箱 / 属性编辑器。
   * 同时只显示一个，属性编辑器不再跟工具箱上下分摊高度。 */
  function tbModeLabel() {
    if (st.tbKind === 'paint') return '贴图绘制';
    if (st.tbKind === 'props') return '属性编辑';
    return SEL_NOUN[st.selMode] || '对象';
  }

  function setTbKind(kind) {
    st.tbKind = (kind === 'paint' || kind === 'props') ? kind : 'model';
    var right = document.querySelector('.md-right');
    if (right) right.classList.toggle('is-props', st.tbKind === 'props');
    var sec = document.querySelector('.md-tb');
    if (sec) sec.classList.toggle('is-paint', st.tbKind === 'paint');
    var box = $('mdPaintBox');
    if (box) box.hidden = st.tbKind !== 'paint';
    var tb = $('mdTbMode');
    if (tb) tb.textContent = tbModeLabel();
    document.querySelectorAll('[data-md-tbk]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTbk === st.tbKind);
    });
    if (st.canvas) st.canvas.style.cursor = st.tbKind === 'paint' ? 'crosshair' : '';
    syncGizmo();
    if (st.tbKind !== 'paint') {
      st.paint.stroke = null;
      paintClipRelease();
      var n = gestNodes();
      if (n.brush) n.brush.style.cssText = '';
    }
    setStatus(st.tbKind === 'paint'
      ? '绘画工具箱：按住左键在模型上画，颜色写进当前材质槽的基础色贴图'
      : st.tbKind === 'props'
        ? '属性编辑器：变换 / 材质槽 / 操作历史（点左上页签切回工具箱）'
        : '已切回建模工具箱');
  }

  function onPickDown(e) {
    if (st.noPick) return;
    if (e.button || e.altKey || !st.doc) { st.pickDown = null; return; }
    /* 绘画页签激活时，左键按下就是落笔（工具会话进行中让位给工具，免得抢操作） */
    if (st.tbKind === 'paint' && !st.quad &&
        !(global.SeedTools && global.SeedTools.isLive && global.SeedTools.isLive())) {
      paintStrokeBegin(e);
      return;
    }
    /* 挤出专用手柄优先：点在箭头上 = 拖厚度，点在根部方柄 = 左右拖缩放顶面 */
    if (global.SeedTools && global.SeedTools.isLive && global.SeedTools.isLive('tool.extrude') && !st.quad) {
      var gh = extrudeGizmoHit(e);
      if (gh && beginExtrudeGizmoDrag(gh, e)) {
        st.pickDown = { x: e.clientX, y: e.clientY, gizmo: true };
        return;
      }
    }
    var gizmoBusy = !!(st.gizmo && st.gizmo.drag);
    st.pickDown = { x: e.clientX, y: e.clientY, gizmo: gizmoBusy };
    if (gizmoBusy) return;
    var t = st.tool;
    if (t === 'knife') {
      var pk = canvasPoint(e);
      st.gest = {
        tool: 'knife', x0: pk.x, y0: pk.y, x: pk.x, y: pk.y,
        pts: [[pk.x, pk.y], [pk.x, pk.y]], moved: false, w: pk.w, h: pk.h
      };
      return;
    }
    if (t === 'select' || t === 'lasso' || t === 'paint') {
      var p = canvasPoint(e);
      st.gest = {
        tool: t, x0: p.x, y0: p.y, x: p.x, y: p.y,
        pts: [[p.x, p.y]], moved: false, w: p.w, h: p.h, last: 0
      };
      if (t === 'paint') { paintAt(st.gest, e.ctrlKey || e.metaKey); brushFollow(e); }
    }
  }

  function onPickMove(e) {
    if (st.noPick) return;
    if (!st.doc) return;
    st.pointer.x = e.clientX;
    st.pointer.y = e.clientY;
    brushFollow(e);
    /* 绘画笔画进行中：每次移动都按 UV 往画布上补一段，忽略选中/手柄逻辑 */
    if (st.tbKind === 'paint' && st.paint.stroke) {
      paintStrokeMove(e);
      return;
    }
    /* 挤出会话：悬停箭头 / 轴心方柄给出可拖动光标。只在命中时写，离开时只清自己写的那次，
     * 免得把变换手柄（capture 阶段）设的 grab 覆盖掉 */
    if (global.SeedTools && global.SeedTools.isLive && global.SeedTools.isLive('tool.extrude') &&
        !st.extrudeDrag && !st.gest) {
      var eh = extrudeGizmoHit(e);
      if (eh) {
        st.extrudeHover = eh;
        st.canvas.style.cursor = eh === 'root' ? 'ew-resize' : 'grab';
      } else if (st.extrudeHover) {
        st.extrudeHover = null;
        st.canvas.style.cursor = '';
      }
    }
    var g = st.gest;
    if (!g) return;
    var p = canvasPoint(e);
    g.x = p.x; g.y = p.y;
    if (!g.moved && (Math.abs(p.x - g.x0) + Math.abs(p.y - g.y0)) > 3) g.moved = true;
    if (!g.moved) return;
    var n = gestNodes();
    if (g.tool === 'select') {
      if (!n.root) return;
      n.root.className = 'md-gest on box';
      var x1 = Math.min(g.x0, p.x), y1 = Math.min(g.y0, p.y);
      n.box.style.cssText = 'left:' + x1 + 'px;top:' + y1 + 'px;width:' + Math.abs(p.x - g.x0) + 'px;height:' + Math.abs(p.y - g.y0) + 'px;';
    } else if (g.tool === 'lasso') {
      if (!n.root) return;
      n.root.className = 'md-gest on lasso';
      g.pts.push([p.x, p.y]);
      n.poly.setAttribute('points', g.pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '));
    } else if (g.tool === 'paint') {
      paintAt(g, e.ctrlKey || e.metaKey);
    } else if (g.tool === 'knife') {
      if (!n.root) return;
      n.root.className = 'md-gest on lasso knife';
      n.poly.setAttribute('points', g.x0.toFixed(1) + ',' + g.y0.toFixed(1) + ' ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
    }
  }

  function onPickUp(e) {
    if (st.noPick) return;
    var d = st.pickDown;
    var g = st.gest;
    st.pickDown = null;
    st.gest = null;
    if (d && d.paint) { paintStrokeEnd(); gestClear(); return; }
    if (!d || e.button || e.altKey || !st.doc || !st.mesh || !st.pivot || !st.camera) { gestClear(); return; }
    if (d.gizmo) { gestClear(); return; }
    var r = st.canvas.getBoundingClientRect();

    /* 多切割：拖动出来的屏幕线 + 相机 = 一个切平面，直接切当前对象 */
    if (g && g.moved && g.tool === 'knife') {
      gestClear();
      knifeCutFromScreen(g, r);
      return;
    }

    /* 拖动过的框选 / 套索：按区域提交 */
    if (g && g.moved && (g.tool === 'select' || g.tool === 'lasso')) {
      var sel = global.SeedSelection;
      var rm = ISO.visibleMesh(st.node ? st.node.id : '');
      if (!rm) { gestClear(); return; }
      var base = {
        mesh: rm, matrix: st.pivot.matrixWorld, camera: st.camera,
        rect: { width: r.width, height: r.height }, mode: regionMode()
      };
      var hit = null;
      if (g.tool === 'select') {
        base.box = {
          x1: Math.min(g.x0, g.x), y1: Math.min(g.y0, g.y),
          x2: Math.max(g.x0, g.x), y2: Math.max(g.y0, g.y)
        };
        hit = sel.pickBox(base);
      } else {
        base.polygon = g.pts;
        hit = sel.pickLasso(base);
      }
      gestClear();
      if (hit) applyRegion(hit, e.shiftKey, e.ctrlKey || e.metaKey);
      return;
    }
    gestClear();

    /* 没拖动 = 点选（原有逻辑） */
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) return;
    if (!global.SeedSelection) return;
    if (!r.width || !r.height) return;
    /* 对象模式：要跨所有对象拾取，否则点了另一个对象没反应 */
    if (st.selMode === 'object') {
      var px = e.clientX - r.left, py = e.clientY - r.top;
      var best = null;
      SeedModel.Scene.nodesOf(st.doc).forEach(function (n) {
        var pv = st.pivots[n.id];
        /* 视口可见性只有一个口径：被「单独显示」藏起来的对象不能被点穿 */
        if (!pv || !ISO.nodeVisible(n.id)) return;
        /* 拾取用的网格必须和 pivot 里画的是同一份（有修改器时是求值结果） */
        var mesh = SeedModel.Evaluator.evaluate(st.doc, n) || SeedModel.Scene.getMesh(st.doc, n);
        if (!mesh) return;
        var h = global.SeedSelection.pick({
          mesh: mesh, matrix: pv.matrixWorld, camera: st.camera,
          rect: { width: r.width, height: r.height }, x: px, y: py, mode: 'object'
        });
        if (h && (!best || h.distance < best.dist)) best = { id: n.id, name: n.name, dist: h.distance };
      });
      if (best && (!st.node || best.id !== st.node.id)) {
        SeedModel.Scene.setActiveNode(st.doc, best.id);
        /* 点中另一个对象 = 换选（不是追加）：nodeIds 必须跟激活对象一致，
         * 否则「单独显示」会按旧多选集合算可见对象。 */
        st.nodeIds = [best.id];
        st.node = SeedModel.Scene.nodeOf(st.doc);
        st.mesh = SeedModel.Scene.getMesh(st.doc);
        st.sel = { vertexIds: [], edgeIds: [], faceIds: [] };
        syncSelectionDoc();
        rebuildModel(true);
        paintAll();
        setStatus('已选中对象：' + best.name + '（共 ' + SeedModel.Scene.nodesOf(st.doc).length + ' 个）');
        return;
      }
    }

    /* 拾取只认视口里真正显示的那份网格：面级隔离时是替身网格，
     * 激活对象被藏起来时直接返回 —— 这样才不会点到看不见的物体 / 看不见的面。 */
    var pickMesh = ISO.visibleMesh(st.node ? st.node.id : '');
    if (!pickMesh) return;
    var pick = global.SeedSelection.pick({
      mesh: pickMesh,
      matrix: st.pivot.matrixWorld,
      camera: st.camera,
      rect: { width: r.width, height: r.height },
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      /* UV 岛模式本质是「点一个面，选中它所在的岛」——拾取内核只要给面号 */
      mode: st.selMode === 'island' ? 'face' : st.selMode,
      through: false
    });
    applyPick(pick, e.shiftKey, e.ctrlKey || e.metaKey);
  }

  /* 边循环选择：双击拾取到的边 → 整圈；没有指针时用当前选中边 */
  function applyEdgeLoopIds(ids, add) {
    if (!ids || !ids.length) return false;
    if (add) {
      var cur = st.sel.edgeIds.slice();
      for (var i = 0; i < ids.length; i++) if (cur.indexOf(ids[i]) < 0) cur.push(ids[i]);
      st.sel.edgeIds = cur;
    } else {
      st.sel.edgeIds = ids.slice();
    }
    syncSelectionDoc();
    paintSelection();
    paintAll();
    setStatus('已选边循环：' + st.sel.edgeIds.length + ' 条边');
    return true;
  }

  function selectEdgeLoopAt(clientX, clientY, add) {
    var SS = global.SeedSelection;
    if (!st.mesh || st.selMode !== 'edge' || !SS) return false;
    var pickMesh = ISO.visibleMesh(st.node ? st.node.id : '');
    if (!pickMesh) return false;
    var r = st.canvas.getBoundingClientRect();
    var hit = SS.pick({
      mesh: pickMesh, matrix: st.pivot.matrixWorld, camera: st.camera,
      rect: { width: r.width, height: r.height },
      x: clientX - r.left, y: clientY - r.top, mode: 'edge', through: false
    });
    if (!hit || hit.kind !== 'edge') return false;
    return applyEdgeLoopIds(SS.edgeLoop(st.mesh, hit.id), add);
  }

  function selectEdgeLoopFromSelection(add) {
    var SS = global.SeedSelection;
    if (!st.mesh || st.selMode !== 'edge' || !SS || !st.sel.edgeIds.length) {
      setStatus('循环边：请在边模式选中一条边（或双击边）', true);
      return false;
    }
    return applyEdgeLoopIds(SS.edgeLoop(st.mesh, st.sel.edgeIds[0]), add);
  }

  /* 双击边 = 选中整圈（Maya 习惯）。单击 / 拖拽仍然是普通选择。 */
  function bindEdgeLoopDblClick() {
    if (!st.canvas) return;
    st.canvas.addEventListener('dblclick', function (ev) {
      if (!st.doc || st.selMode !== 'edge' || st.tool !== 'select') return;
      if (selectEdgeLoopAt(ev.clientX, ev.clientY, ev.shiftKey)) ev.preventDefault();
    });
  }

  /* 区域选择与点选共用同一个「模式 → 拾取类型」映射 */
  function regionMode() {
    return (st.selMode === 'object' || st.selMode === 'island') ? 'face' : st.selMode;
  }

  /* 绘制选择的每一次刷：把圆心 R 内的元素并进选择（Ctrl 是刷掉） */
  function paintAt(g, erase) {
    if (!st.mesh || !st.pivot || !global.SeedSelection) return;
    var now = performance.now();
    if (g.last && now - g.last < 26) return;     /* 节流：投影全表不便宜 */
    g.last = now;
    var R = 22;
    var bm = ISO.visibleMesh(st.node ? st.node.id : '');
    if (!bm) return;
    var hit = global.SeedSelection.pickRegion({
      mesh: bm, matrix: st.pivot.matrixWorld, camera: st.camera,
      rect: { width: g.w, height: g.h }, mode: regionMode(),
      test: function (x, y) {
        var dx = x - g.x, dy = y - g.y;
        return dx * dx + dy * dy <= R * R;
      }
    });
    if (!hit || !hit.ids.length) return;
    mergeSelection(hit.ids, erase ? 'remove' : 'add');
  }

  /* 把一批 ID 并进 / 移出选择集；岛模式下先把面展开成整岛 */
  function mergeSelection(ids, how) {
    if (!st.doc || !st.mesh || !ids.length) return 0;
    if (st.selMode === 'object') { paintAll(); return 0; }
    var list = ids.slice();
    if (st.selMode === 'island') {
      var set = Object.create(null);
      list.forEach(function (fid) {
        var fi = st.mesh.faceIds.indexOf(fid);
        if (fi < 0) return;
        islandFacesOf(fi).forEach(function (f) { set[st.mesh.faceIds[f]] = 1; });
      });
      list = Object.keys(set).map(Number);
    }
    var key = selKey();
    var cur = st.sel[key].slice();
    if (how === 'replace') {
      st.sel[key] = list;
    } else if (how === 'remove') {
      var drop = Object.create(null);
      list.forEach(function (x) { drop[x] = 1; });
      st.sel[key] = cur.filter(function (x) { return !drop[x]; });
    } else {
      var seen = Object.create(null);
      cur.forEach(function (x) { seen[x] = 1; });
      st.sel[key] = cur.concat(list.filter(function (x) { return !seen[x]; }));
    }
    syncSelectionDoc();
    paintSelection();
    paintAll();
    setStatus(selCount() ? ('已选 ' + selCount() + ' 个' + SEL_NOUN[st.selMode]) : '选择已清空');
    return st.sel[key].length;
  }

  function applyRegion(hit, add, toggle) {
    if (!hit) return;
    if (st.selMode === 'object') {
      setStatus(hit.ids.length ? ('区域内 ' + hit.ids.length + ' 个面（对象模式不改选择）') : '区域内没有元素');
      return;
    }
    if (!hit.ids.length) {
      if (!add && !toggle) { mergeSelection([], 'replace'); }
      else setStatus('区域内没有元素');
      return;
    }
    mergeSelection(hit.ids, toggle ? 'remove' : add ? 'add' : 'replace');
  }

  /* ---------------- 着色 / 四视图 / ViewCube ---------------- */
  /* ---------------- 视口 ---------------- */
  function ensureViewport() {
    if (st.renderer || !THREE) return;
    st.renderer = new THREE.WebGLRenderer({ canvas: st.canvas, antialias: true, alpha: false });
    st.renderer.debug.checkShaderErrors = false;
    st.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    if ('outputEncoding' in st.renderer) st.renderer.outputEncoding = THREE.sRGBEncoding;

    st.scene = new THREE.Scene();
    st.scene.background = new THREE.Color('#5a5d61');
    /* 灯光配比（V1）：环境 0.18 只负责不死黑，主光 0.85 定形体，补光/轮廓 0.26/0.19 保住背面。
     * 实测三个可见面 ≈ 219 / 181 / 168（背景 93），峰谷差 50 级、不过曝。 */
    var ambient = new THREE.AmbientLight(0xffffff, 0.18);
    st.scene.add(ambient);
    var key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 1.2, 1);
    st.scene.add(key);
    var fill = new THREE.DirectionalLight(0xdce6ff, 0.26);
    fill.position.set(-1.1, 0.5, 0.7);
    st.scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffffff, 0.19);
    rim.position.set(0.2, 0.6, -1.2);
    st.scene.add(rim);
    /* 灯光开关（A4）用：记下出厂强度，关灯时只留环境光，别把形体照成全黑 */
    st.lights = [ambient, key, fill, rim];
    st.lights.forEach(function (l) { l.userData.mdBaseIntensity = l.intensity; });

    /* 栅格压暗（V2）：这个 three 构建没开 ColorManagement，GridHelper 顶点色会被当线性值
     * 再走一遍 ACES + sRGB 编码，实测比给定色亮 ~1.5 档。 */
    var grid = new THREE.GridHelper(8, 16, 0x53565a, 0x45484c);
    grid.position.y = 0;
    /* 栅格显隐的唯一来源是显示开关表（A4）；st.showGrid 只是给 UI 高亮读的镜像 */
    st.showGrid = global.SeedViewFlags ? global.SeedViewFlags.get('grid') !== false : st.showGrid;
    grid.visible = st.showGrid;
    /* 先画栅格、且不写深度：默认立方体是**居中**的，地面 y=0 正好把模型切成两半，
     * 那条交线与模型侧面共面 → 深度打架 → 栅格线「透过」模型印在面上（实测像多出一条对角线）。
     * 改成「先画、不写深度」后，模型后画必然盖住它，既保留地面网格又不会穿透。 */
    if (grid.material) {
      grid.material.depthWrite = false;
      grid.material.transparent = false;
    }
    grid.renderOrder = -1;
    st.gridHelper = grid;
    st.scene.add(grid);

    applyRenderTone();   /* 色调映射必须在第一次 render 之前设好 */

    st.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 400);
    st.camera.position.set(2.2, 1.6, 3.2);
    st.controls = new THREE.OrbitControls(st.camera, st.canvas);
    st.controls.enableDamping = true;
    st.controls.dampingFactor = 0.08;
    st.controls.target.set(0, 0.8, 0);
    syncNavModifier(false);
    global.addEventListener('keydown', onNavKeyDown, true);
    global.addEventListener('keyup', onNavKeyUp, true);
    global.addEventListener('blur', onNavBlur);
    /* 捕获阶段：window 比 canvas 先拿到事件，OrbitControls 读到的就是这一帧的真实 Alt 状态 */
    global.addEventListener('pointerdown', syncNavFromPointer, true);
    global.addEventListener('pointerup', syncNavFromPointer, true);
    st.controls.update();

    /* 组件手柄的载体：必须是 scene 的直接子节点（手柄的平移量按世界坐标写进 target.position），
     * 每帧再由 st.pivot.matrixWorld 换算回网格局部坐标。 */
    st.compPivot = new THREE.Object3D();
    st.compPivot.name = 'comp-pivot';
    st.scene.add(st.compPivot);

    st.quadCams = buildQuadCameras();
    st.quadCtl = buildQuadControls();
    syncNavModifier(st.navAlt);   /* OrbitControls 的 mouseButtons 门控要补到新建的四个 pane 上 */

    st.gizmo = new global.ModelTransformGizmo({
      scene: st.scene, camera: st.camera, canvas: st.canvas, controls: st.controls,
      onStart: onTransformStart,
      onChange: onTransformChange,
      onEnd: onTransformEnd,
      onStatus: function (t) { setStatus(t, false); }
    });
    st.gizmo.setMode(st.mode);
    st.gizmo.setSpace(st.space);
    st.gizmo.setSnap(st.snap);
    /* 吸附开关只有一个状态：工具条的 st.snap 写进 SeedSnap，手柄只读偏好 */
    if (global.SeedSnap) global.SeedSnap.setEnabled(st.snap);

    global.addEventListener('keydown', onSpaceDown, false);
    global.addEventListener('keyup', onSpaceUp, false);

    st.canvas.addEventListener('pointerdown', onPickDown);
    st.canvas.addEventListener('pointermove', onPickMove);
    st.canvas.addEventListener('pointerup', onPickUp);
    bindEdgeLoopDblClick();
    st.canvas.addEventListener('pointercancel', function () {
      /* 画笔被打断也要收尾：否则岛剪裁会一直留在上下文里 */
      if (st.paint.stroke) paintStrokeEnd();
      st.gest = null; st.pickDown = null; gestClear();
    });
    st.canvas.addEventListener('pointerleave', function () {
      var n = gestNodes();
      if (n.brush) n.brush.style.display = 'none';
    });
    bindQuadNav();

    st.resizeObs = new ResizeObserver(function () { resize(); });
    st.resizeObs.observe(st.stage);
    resize();
  }

  /* Alt 组合键的门控：OrbitControls 只在 Alt 按住时拿到鼠标动作。
   * ⚠ 不能只靠 keydown：真实浏览器/Electron 里第一次按 Alt 常被窗口菜单抢走，
   * 症状就是「按下 Alt 的第一次拖拽无效，第二次才生效」。
   * 所以真正说了算的是指针事件自带的 altKey，在 window 捕获阶段先同步一次。 */
  function syncNavModifier(on) {
    st.navAlt = !!on;
    if (!THREE) return;
    /* 主视口的 controls 与四视图四格的 controls 用同一套 Alt 门控；
     * 未按 Alt 时把动作设成 null，OrbitControls 就会原地不动（滚轮 zoom 不受影响）。 */
    var list = [];
    if (st.controls) list.push(st.controls);
    Object.keys(st.quadCtl || {}).forEach(function (k) {
      if (st.quadCtl[k]) list.push(st.quadCtl[k]);
    });
    list.forEach(function (ctl) {
      var mb = ctl.mouseButtons;
      mb.LEFT = on ? THREE.MOUSE.ROTATE : null;
      mb.MIDDLE = on ? THREE.MOUSE.PAN : null;
      mb.RIGHT = on ? THREE.MOUSE.DOLLY : null;
    });
  }
  function syncNavFromPointer(e) {
    var alt = !!e.altKey;
    if (alt !== !!st.navAlt) syncNavModifier(alt);
  }
  function onNavKeyDown(e) {
    if (e.key === 'Alt') syncNavModifier(true);
  }
  function onNavKeyUp(e) {
    if (e.key === 'Alt') syncNavModifier(false);
  }
  function onNavBlur() {
    syncNavModifier(false);
  }

  /* 四视图相机：正交、共用同一个 scene。aspect 在 updateQuadCameras 里按分屏尺寸算。 */
  var QUAD_LABEL = { front: '前视图', back: '后视图', left: '左视图', right: '右视图' };

  function buildQuadCameras() {
    if (!THREE) return null;
    var dirs = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] };
    var cams = {};
    Object.keys(dirs).forEach(function (k) {
      var c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 400);
      c.userData.mdDir = dirs[k];
      /* 先给非零机位：OrbitControls 构造里会立刻 update()，距离 0 会算出 NaN 球坐标 */
      c.position.set(dirs[k][0] * 3, dirs[k][1] * 3, dirs[k][2] * 3);
      c.lookAt(0, 0, 0);
      c.updateMatrixWorld(true);
      cams[k] = c;
    });
    return cams;
  }

  /* V7：每一格一个 OrbitControls，绑同一个 canvas。同一时刻只 enable 当前激活的那一个，
   * 主视口的 controls 在四视图期间保持 disabled；未按 Alt 时的鼠标动作由 syncNavModifier 置空。 */
  function buildQuadControls() {
    if (!THREE || !st.quadCams || !st.canvas) return null;
    var list = {};
    Object.keys(st.quadCams).forEach(function (k) {
      var ctl = new THREE.OrbitControls(st.quadCams[k], st.canvas);
      ctl.enableDamping = true;
      ctl.dampingFactor = 0.08;
      ctl.enabled = false;
      ctl.target.set(0, 0, 0);
      ctl.update();
      list[k] = ctl;
    });
    return list;
  }

  function quadKey() { return st.quadMax || st.quadActive || 'front'; }

  function syncQuadControls() {
    var active = quadKey();
    Object.keys(st.quadCtl || {}).forEach(function (k) {
      if (st.quadCtl[k]) st.quadCtl[k].enabled = !!st.quad && k === active;
    });
  }

  function quadViewText() {
    return '四视图 · ' + (QUAD_LABEL[quadKey()] || '前视图') + (st.quadMax ? '（最大化）' : '');
  }

  /* active 格的角标高亮 + 最大化时隐藏分隔线/标签（分隔线由 CSS 按 .quad-max 隐藏） */
  function updateQuadChrome() {
    if (!st.stage) return;
    st.stage.classList.toggle('quad-max', !!(st.quad && st.quadMax));
    var labels = st.stage.querySelectorAll('.md-quad-l');
    for (var i = 0; i < labels.length; i++) {
      var k = labels[i].dataset ? labels[i].dataset.mdQcell : '';
      labels[i].classList.toggle('on', !!st.quad && k === quadKey());
    }
  }

  /* reset=true 才回到「按包围球框显」的预设机位（进出四视图 / F 框显时用）；
   * 平时 resize、切激活格只更新视锥，不要把用户导航过的机位抹掉。 */
  function updateQuadCameras(reset) {
    if (!st.quadCams) return;
    var center = new THREE.Vector3(0, 0, 0), radius = 0.5;
    if (st.pivot && st.scene) {
      st.pivot.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(st.pivot);
      if (!box.isEmpty()) {
        var sphere = box.getBoundingSphere(new THREE.Sphere());
        center.copy(sphere.center);
        radius = sphere.radius;
      }
    }
    var r = Math.max(radius * 1.15, 0.5);
    /* 每格占 stage 的 1/2 × 1/2，aspect 与整块 stage 相同；最大化时就是全屏。
     * 按实际格子宽高算（不做 floor），避免半像素差异把画面拉斜。 */
    var w = st.stage ? st.stage.clientWidth : 0;
    var h = st.stage ? st.stage.clientHeight : 0;
    var pw = st.quadMax ? w : w / 2;
    var ph = st.quadMax ? h : h / 2;
    var aspect = (pw && ph) ? (pw / ph) : 1;
    Object.keys(st.quadCams).forEach(function (k) {
      var cam = st.quadCams[k];
      cam.left = -r * aspect;
      cam.right = r * aspect;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 0.01;
      cam.far = Math.max(r * 40, 100);
      cam.updateProjectionMatrix();
      if (!reset) return;
      var d = cam.userData.mdDir;
      cam.zoom = 1;
      cam.up.set(0, 1, 0);
      cam.position.set(center.x + d[0] * r * 3, center.y + d[1] * r * 3, center.z + d[2] * r * 3);
      cam.lookAt(center);
      cam.updateProjectionMatrix();
      var ctl = st.quadCtl && st.quadCtl[k];
      if (ctl) { ctl.target.copy(center); ctl.update(); }
    });
    syncQuadControls();
  }

  function renderQuad() {
    if (!st.renderer || !st.scene || !st.quadCams || !st.stage) return;
    var w = st.stage.clientWidth, h = st.stage.clientHeight;
    if (!w || !h) return;
    /* 最大化：该格相机全屏单视图，不再走 scissor 分屏 */
    if (st.quadMax) {
      var cam = st.quadCams[st.quadMax];
      st.renderer.setScissorTest(false);
      st.renderer.setViewport(0, 0, w, h);
      if (cam) st.renderer.render(st.scene, cam);
      return;
    }
    var hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    var views = [
      { cam: st.quadCams.front, x: 0, y: hh },
      { cam: st.quadCams.back, x: hw, y: hh },
      { cam: st.quadCams.left, x: 0, y: 0 },
      { cam: st.quadCams.right, x: hw, y: 0 }
    ];
    st.renderer.setScissorTest(true);
    views.forEach(function (v) {
      st.renderer.setViewport(v.x, v.y, hw, hh);
      st.renderer.setScissor(v.x, v.y, hw, hh);
      st.renderer.render(st.scene, v.cam);
    });
    st.renderer.setScissorTest(false);
    st.renderer.setViewport(0, 0, w, h);
  }

  /* ---------------- V7：四视图指针导航 ----------------
   * 事件挂在 stage 的捕获阶段（stage 是 canvas 的祖先），保证在 canvas 上的
   * OrbitControls 收到 pointerdown 之前就把激活格切好；否则点到 B 格时仍是 A 格在接管拖动。
   * 拖拽阈值 5px 内、间隔 320ms 内的两次左键才算双击，拖拽不会误触发最大化。 */
  var QUAD_DRAG_PX = 5;
  var QUAD_DBL_MS = 320;

  function quadPaneAt(e) {
    if (!st.stage) return 'front';
    if (st.quadMax) return st.quadMax;
    var r = st.stage.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    /* renderer viewport 原点在左下、DOM 在左上：屏幕上半 = 前/后，下半 = 左/右 */
    var rightSide = x >= r.width / 2, bottomSide = y >= r.height / 2;
    if (!bottomSide) return rightSide ? 'back' : 'front';
    return rightSide ? 'right' : 'left';
  }

  function setQuadActive(key, silent) {
    if (!st.quad || !st.quadCams || !st.quadCams[key]) return;
    if (st.quadMax) key = st.quadMax;
    if (st.quadActive === key) { syncQuadControls(); return; }
    st.quadActive = key;
    syncQuadControls();
    updateQuadChrome();
    updateChrome();
    updateHud();
    if (!silent && !st.quadMax) setStatus(quadViewText());
  }

  function exitQuadMax() {
    if (!st.quadMax) return;
    var k = st.quadMax;
    st.quadMax = null;
    st.quadActive = k;
    st.quadClick = null;
    updateQuadCameras();
    updateQuadChrome();
    updateChrome();
    updateHud();
    setStatus(quadViewText());
  }

  function toggleQuadMax(key) {
    if (st.quadMax) { exitQuadMax(); return; }
    if (!st.quad || !st.quadCams || !st.quadCams[key]) return;
    st.quadMax = key;
    st.quadActive = key;
    st.quadClick = null;
    updateQuadCameras();
    updateQuadChrome();
    updateChrome();
    updateHud();
    setStatus('四视图 · ' + QUAD_LABEL[key] + '（最大化，双击或 Esc 返回）');
  }

  function onQuadDown(e) {
    st.quadDown = null;
    if (!st.quad || !st.doc || e.button !== 0) return;
    var key = quadPaneAt(e);
    st.quadDown = { x: e.clientX, y: e.clientY, key: key, moved: false };
    if (!st.quadMax) setQuadActive(key);
  }

  function onQuadMove(e) {
    var d = st.quadDown;
    if (d) {
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > QUAD_DRAG_PX) d.moved = true;
      return;   /* 拖拽中不换格：换了会把正在进行的拖动交给另一个相机 */
    }
    if (!st.quad || st.quadMax || e.buttons) return;
    var key = quadPaneAt(e);
    if (key !== quadKey()) setQuadActive(key, true);
  }

  function onQuadUp(e) {
    var d = st.quadDown;
    st.quadDown = null;
    if (!st.quad || !d || e.button !== 0) return;
    var moved = d.moved || (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > QUAD_DRAG_PX);
    if (moved || e.altKey) { st.quadClick = null; return; }
    var now = Date.now();
    var last = st.quadClick;
    if (last && now - last.t < QUAD_DBL_MS && last.key === d.key &&
        Math.abs(e.clientX - last.x) < 8 && Math.abs(e.clientY - last.y) < 8) {
      st.quadClick = null;
      toggleQuadMax(d.key);
      return;
    }
    st.quadClick = { t: now, x: e.clientX, y: e.clientY, key: d.key };
  }

  function onQuadWheel(e) {
    if (!st.quad || st.quadMax) return;
    setQuadActive(quadPaneAt(e), true);
  }

  function onQuadCancel() { st.quadDown = null; }

  /* 冒泡阶段再写一次状态行：canvas 上的拾取回调（onPickUp）会写「没有点中对象」之类，
   * 捕获阶段写的四视图文案会被它盖掉，所以这里在事件走完 canvas 之后补最后一次。 */
  function onQuadUpSync(e) {
    if (!st.quad || e.button !== 0) return;
    setStatus(st.quadMax
      ? '四视图 · ' + QUAD_LABEL[st.quadMax] + '（最大化，双击或 Esc 返回）'
      : quadViewText());
  }

  function bindQuadNav() {
    if (!st.stage) return;
    st.stage.addEventListener('pointerdown', onQuadDown, true);
    st.stage.addEventListener('pointermove', onQuadMove, true);
    st.stage.addEventListener('pointerup', onQuadUp, true);
    st.stage.addEventListener('pointerup', onQuadUpSync, false);
    st.stage.addEventListener('pointercancel', onQuadCancel, true);
    st.stage.addEventListener('wheel', onQuadWheel, { capture: true, passive: true });
  }

  function resize() {
    if (!st.renderer || !st.stage) return;
    var w = st.stage.clientWidth, h = st.stage.clientHeight;
    if (!w || !h) return;
    st.renderer.setSize(w, h, false);
    st.renderer.setScissorTest(false);
    st.renderer.setViewport(0, 0, w, h);
    st.camera.aspect = w / h;
    st.camera.updateProjectionMatrix();
    if (st.quad) updateQuadCameras(false);
  }

  function resume() {
    if (!st.renderer) return;
    resize();
    if (!st.running) { st.running = true; tick(); }
  }
  function pause() {
    st.running = false;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
  }
  function tick() {
    if (!st.running) return;
    st.raf = requestAnimationFrame(tick);
    /* UV 编辑器基本盖住视口，底下 3D 还在全速画就是白烧 GPU：
     * 开着 UV 窗口时 3D 降到约 30fps，留出预算给画布重绘和指针响应。 */
    if (st.uv.open) {
      st.uv.frameSkip = (st.uv.frameSkip + 1) & 1;
      if (st.uv.frameSkip) return;
    }
    if (st.controls && !st.quad) st.controls.update();
    if (st.gizmo) st.gizmo.update();
    /* 挤出会话每帧同步专用手柄：参数可能从面板 / 热盒 / 键盘任何一路改 */
    updateExtrudeGizmo();
    if (!st.renderer || !st.scene || !st.camera) return;
    if (st.quad) {
      /* 只 update 激活格的 controls（阻尼需要每帧推进），其他格被动也不许被带动 */
      var qctl = st.quadCtl && st.quadCtl[quadKey()];
      if (qctl) qctl.update();
      renderQuad();
    } else {
      st.renderer.setScissorTest(false);
      st.renderer.setViewport(0, 0, st.stage.clientWidth, st.stage.clientHeight);
      st.renderer.render(st.scene, st.camera);
      /* 立方体每帧跟着主相机朝向重画：不订阅 controls 事件，
       * 因为相机还可能被键盘、滚轮、视图预设改掉，逐帧同步最省心。 */
      drawCube();
    }
  }

  function frameCamera() {
    if (!st.pivot || !st.controls) return;
    st.pivot.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(st.pivot);
    if (box.isEmpty()) return;
    var sphere = box.getBoundingSphere(new THREE.Sphere());
    var r = Math.max(sphere.radius, 0.2);
    var d = r * 3;
    st.camera.near = Math.max(r / 100, 0.001);
    st.camera.far = Math.max(r * 50, 100);
    st.camera.updateProjectionMatrix();
    st.controls.target.copy(sphere.center);
    st.camera.position.set(sphere.center.x + d * 0.6, sphere.center.y + d * 0.45, sphere.center.z + d * 0.9);
    st.viewName = '透视';
    st.controls.update();
    if (st.quad) updateQuadCameras(true);
  }

  /* ---------------- 网格 → 场景对象 ---------------- */
  function maxUsedSlot(mesh) {
    var m = 0;
    for (var i = 0; i < mesh.faceSlots.length; i++) m = Math.max(m, mesh.faceSlots[i]);
    return m;
  }

  /* 基础色贴图按 data URL 全局共享。
   * 拖动挤出时预览网格会反复重建材质，如果每次都 new Texture 重新解码一串 data URL，
   * 解码完成前的那几帧就是黑的 —— 用户看到的「拖坐标轴时贴图短暂变黑」。
   * 共享后同一张贴图只解码一次，新材质挂上去立刻就有像素。 */
  var TEX_CACHE = Object.create(null);
  function sharedTexture(url) {
    var tex = TEX_CACHE[url];
    if (tex) return tex;
    tex = new THREE.TextureLoader().load(url);
    if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    tex.userData.mdShared = true;
    TEX_CACHE[url] = tex;
    return tex;
  }

  /* 共享贴图不能跟着单个材质一起释放，否则别的对象下一次渲染直接黑 */
  function disposeMap(m) {
    if (!m || !m.map) return;
    if (m.map.userData && m.map.userData.mdShared) return;
    try { m.map.dispose(); } catch (e) {}
  }

  /* 把一张贴图挂到所有对象「第 slot 个材质」上（含平涂缓存材质）。
   * 画笔与纹理混合共用这条路径：谁最后决定材质上放哪张图，都由调用方算好。
   * mdBaseMap 一起换，显示开关「贴图」关掉再打开才不会回到上一张旧图。 */
  function applySlotTexture(slot, tex) {
    eachViewPivot(function (pv) {
      pv.traverse(function (o) {
        if (!o.userData || o.userData.mdPart !== 'solid') return;
        if (o.material) {
          var arr = Array.isArray(o.material) ? o.material : [o.material];
          var m = arr[slot];
          if (m) {
            if (!m.userData.mdPaintOrig) m.userData.mdPaintOrig = m.map || null;
            m.map = tex || null;
            m.userData.mdBaseMap = tex || null;
            m.needsUpdate = true;
          }
        }
        if (o.userData.mdFlatMats) {
          var fm = o.userData.mdFlatMats[slot];
          if (fm) { fm.map = tex || null; fm.userData.mdBaseMap = tex || null; fm.needsUpdate = true; }
        }
      });
    });
  }

  /* 「视口里这一槽现在真正显示的那张图」。
   * 为什么不能只读 doc.materials.slotMaps：材质上的 map 还有别的来源 ——
   * 纹理混合（MIX.texFor 合成出来的 canvas）、绘画工具写回、外部导入只挂了
   * material.map 的老资产。烘焙 / 绘画工作区的**底图**必须是这一张：
   * 取不到就会拿槽位底色起一张空画布，写回后整片贴图被洗掉。 */
  function liveSlotImage(slot) {
    var out = null;
    eachViewPivot(function (pv) {
      if (out) return;
      pv.traverse(function (o) {
        if (out || !o.userData || o.userData.mdPart !== 'solid') return;
        var arr = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        var m = arr[slot];
        var img = m && m.map && m.map.image;
        if (img && (img.width || img.naturalWidth)) out = img;
      });
    });
    return out;
  }

  function makeMaterials() {
    var mats = st.doc.materials || {};
    var names = mats.slotNames || [];
    var colors = mats.slotColors || [];
    var maps = mats.slotMaps || [];
    var count = Math.max(names.length, maxUsedSlot(st.mesh) + 1, 1);
    var list = [];
    for (var i = 0; i < count; i++) {
      var mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors[i] || '#c9ccd4'),
        roughness: 0.72,
        metalness: 0.06,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        name: names[i] || (i === 0 ? '默认材质' : '插槽 ' + (i + 1))
      });
      /* 有合成纹理就优先用它：重建材质（撤销 / 修改器）后混合层不能「消失」；
       * 没有才回到导入时抽出来的基础色贴图。 */
      var mixTex = (MIX && MIX.texFor(i)) || null;
      if (mixTex) mat.map = mixTex;
      else if (maps[i]) mat.map = sharedTexture(maps[i]);
      /* 显示开关要能还原：材质本色 / 原始贴图在这里留底（见 applyViewFlags） */
      mat.userData.mdBaseColor = colors[i] || '#c9ccd4';
      mat.userData.mdBaseMap = mat.map || null;
      list.push(mat);
    }
    return list;
  }

  function applyNodeTransform(pivot) {
    var t = st.node && st.node.transform;
    if (!t) return;
    pivot.position.fromArray(t.position);
    pivot.quaternion.fromArray(t.rotation);
    pivot.scale.fromArray(t.scale);
    pivot.updateMatrixWorld(true);
  }

  function disposeObject(root) {
    if (!root) return;
    root.traverse(function (o) {
      if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
      var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      mats.forEach(function (m) {
        if (!m) return;
        disposeMap(m);
        try { m.dispose(); } catch (e) {}
      });
      /* 平涂用的 unlit 材质是缓存出来的，当前材质可能是另一套，两个都要释放 */
      var flat = o.userData && o.userData.mdFlatMats;
      if (flat) {
        (Array.isArray(flat) ? flat : [flat]).forEach(function (m) {
          if (!m || mats.indexOf(m) >= 0) return;
          try { m.dispose(); } catch (e) {}
        });
      }
    });
  }

  function disposeMaterials(root) {
    if (!root) return;
    root.traverse(function (o) {
      var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      mats.forEach(function (m) {
        if (!m) return;
        disposeMap(m);
        try { m.dispose(); } catch (e) {}
      });
    });
  }

  /* 按节点建 pivot：一个对象一个 Group（几何来自它自己的网格，缓存按 mesh.version 复用） */
  function makePivotFor(node, mesh, cache) {
    var geo = SeedModel.Mesh.buildGeometry(mesh, { cache: cache !== false });
    var child = new THREE.Mesh(geo, makeMaterials());
    child.name = node.name;
    child.userData.mdPart = 'solid';
    var pivot = new THREE.Group();
    pivot.name = node.name + '_pivot';
    pivot.userData.mdNode = node.id;
    pivot.add(child);
    pivot.visible = node.visible !== false;
    var t = node.transform;
    pivot.position.fromArray(t.position);
    pivot.quaternion.fromArray(t.rotation);
    pivot.scale.fromArray(t.scale);
    pivot.updateMatrixWorld(true);
    return pivot;
  }

  /* ---------------- 视口叠加层：真实边线 + 顶点 ---------------- */
  /* 线框只按**网格拓扑**画：每张面有几条边就画几条，n 边面不会出现扇形三角化的对角线。
   * 不要再按「相邻面法线夹角」过滤内部边 —— 那会让同一平面上的分段线（环切 / 细分出来的边）
   * 整条消失，看起来像面没有被切开，也无法判断拓扑密度（Maya / Blender 的 wireframe 都画满拓扑边）。 */
  function buildEdgeLines() {
    var lines = buildEdgeLinesFor(st.mesh, 'topology-edges');
    st.edgeRecs = lines.userData.mdEdges;  /* 拖动组件时按这份记录原地改坐标，省掉重算平面过滤 */
    return lines;
  }

  /* 任意网格的拓扑边线（预览也和正式模型用同一套画法，线框模式颜色同步） */
  function buildEdgeLinesFor(mesh, name) {
    var e = SeedModel.Mesh.ensureEdges(mesh);
    var visible = e.edges;
    var buf = new Float32Array(visible.length * 6);
    for (var i = 0; i < visible.length; i++) {
      var rec = visible[i];
      var a = rec.a * 3, b = rec.b * 3;
      buf[i * 6] = mesh.positions[a];
      buf[i * 6 + 1] = mesh.positions[a + 1];
      buf[i * 6 + 2] = mesh.positions[a + 2];
      buf[i * 6 + 3] = mesh.positions[b];
      buf[i * 6 + 4] = mesh.positions[b + 1];
      buf[i * 6 + 5] = mesh.positions[b + 2];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
    geo.computeBoundingSphere();
    var p = st.prefs || prefs();
    var mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(st.shading === 'wire' ? '#d7dde3' : p.edgeColor),
      /* 不透明 + 不混合：透明管线会把 1px 线再压一层，实测对比度掉 20 左右 */
      transparent: false,
      depthWrite: false
    });
    var lines = new THREE.LineSegments(geo, mat);
    lines.name = name;
    lines.userData.mdPart = 'edges';
    lines.userData.mdEdges = visible;
    lines.renderOrder = 1;
    lines.frustumCulled = false;
    return lines;
  }

  /* 顶点用「深色底盘 + 浅色芯」两层点（V2）：单色点总有一头隐形。 */
  function buildVertexPoints() {
    var buf = new Float32Array(st.mesh.positions.length);
    for (var i = 0; i < st.mesh.positions.length; i++) buf[i] = st.mesh.positions[i];
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
    geo.computeBoundingSphere();

    var p = st.prefs || prefs();
    var dpr = Math.min(global.devicePixelRatio || 1, 2);

    function layer(color, size, order) {
      var mat = new THREE.PointsMaterial({
        color: new THREE.Color(color),
        size: size * dpr,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.97,
        depthWrite: false
      });
      var pts = new THREE.Points(geo, mat);
      pts.renderOrder = order;
      pts.frustumCulled = false;
      pts.userData.mdPart = 'verts';
      return pts;
    }

    var group = new THREE.Group();
    group.name = 'topology-vertices';
    group.userData.mdPart = 'verts';
    group.add(layer(p.vertHalo, 5.6, 2));
    group.add(layer(p.vertCore, 3.0, 3));
    return group;
  }

  function addOverlays(pivot) {
    if (!pivot || !st.mesh) return;
    st.edgeLines = buildEdgeLines();
    st.vertPoints = buildVertexPoints();
    pivot.add(st.edgeLines);
    pivot.add(st.vertPoints);
    applyShading();
  }

  function disposeOverlays(root) {
    if (!root) return;
    root.traverse(function (o) {
      var part = o.userData && o.userData.mdPart;
      if (!part || part === 'solid') return;
      if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
      if (o.material) { try { o.material.dispose(); } catch (e) {} }
    });
  }

  function shadeLabel(mode) {
    return mode === 'shaded' ? '实体'
      : mode === 'wire' ? '线框'
      : mode === 'flat' ? '平涂'
      : mode === 'uv' ? 'UV 岛着色'
      : '实体 + 线框';
  }

  /* 显示开关的唯一读取口：表缺席时按默认（全开）处理 */
  function vfOn(name) {
    var VF = global.SeedViewFlags;
    return VF ? VF.get(name) !== false : true;
  }

  /* 视口里所有 pivot（多对象时 applyShading 不能只作用在激活对象上） */
  function eachViewPivot(fn) {
    var ids = st.pivots ? Object.keys(st.pivots) : [];
    if (!ids.length) { if (st.pivot) fn(st.pivot); return; }
    for (var i = 0; i < ids.length; i++) {
      var pv = st.pivots[ids[i]];
      if (pv) fn(pv);
    }
  }

  /* backface / material / texture / lighting → 材质与灯光。
   * 只在开关变化时调用（不在渲染循环里分支）。 */
  var CLAY = '#c9ccd4';
  function applyViewFlags() {
    var side = vfOn('backface') ? THREE.DoubleSide : THREE.FrontSide;
    var useMat = vfOn('material'), useTex = vfOn('texture'), lit = vfOn('lighting');
    eachViewPivot(function (pv) {
      pv.traverse(function (o) {
        if (!o.userData || o.userData.mdPart !== 'solid' || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          if (!m) return;
          if (m.side !== side) { m.side = side; m.needsUpdate = true; }
          var want = useMat ? (m.userData.mdBaseColor || CLAY) : CLAY;
          m.color.set(want);
          var baseMap = m.userData.mdBaseMap;
          var nextMap = useTex ? (baseMap === undefined ? null : baseMap) : null;
          if (m.map !== nextMap) { m.map = nextMap; m.needsUpdate = true; }
        });
      });
    });
    /* 关灯只保留环境光：主/补/轮廓归零，形体变平但不会全黑 */
    (st.lights || []).forEach(function (l) {
      var base = l.userData.mdBaseIntensity;
      if (base == null) { base = l.intensity; l.userData.mdBaseIntensity = base; }
      l.intensity = lit ? base : (l.isAmbientLight ? base : 0);
    });
  }

  /* ---------------- 着色风格：平涂 / UV 岛着色 ----------------
   * 参考模型库里的材质预览做法：
   *   平涂 = 换成 unlit 材质（基本色 + 可选贴图），不吃灯光，像设计图上的纯色块；
   *   UV 岛 = 每个岛一个随机色，写在**非索引几何**的顶点色上（索引几何的顶点会被
   *           相邻岛共享，没法按面给色）。
   * 两者都只是「怎么画」：不改网格、不写文档、不进历史。 */
  var ISLAND_COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#e6beff', '#9a6324'
  ];

  /* 实体在「平涂 / 受光」之间切换：原材质记在 mdLitMats，unlit 版本按需生成一份 */
  function applySolidLook(o, unlit) {
    if (!o || !o.material) return;
    if (!o.userData.mdLitMats) o.userData.mdLitMats = o.material;
    var lit = o.userData.mdLitMats;
    if (!unlit) {
      if (o.material !== lit) o.material = lit;
      return;
    }
    if (!o.userData.mdFlatMats) {
      var src = Array.isArray(lit) ? lit : [lit];
      var made = src.map(function (m) {
        var f = new THREE.MeshBasicMaterial({
          color: (m.userData && m.userData.mdBaseColor) || CLAY,
          map: (m.userData && m.userData.mdBaseMap) || null,
          side: m.side,
          toneMapped: false   /* 平涂要的是原色，不要再被 ACES 压一道 */
        });
        f.userData.mdBaseColor = (m.userData && m.userData.mdBaseColor) || CLAY;
        f.userData.mdBaseMap = (m.userData && m.userData.mdBaseMap) || null;
        return f;
      });
      o.userData.mdFlatMats = Array.isArray(lit) ? made : made[0];
    }
    if (o.material !== o.userData.mdFlatMats) o.material = o.userData.mdFlatMats;
  }

  /* pivot → 它自己的网格（多对象时每个对象的 UV 岛都不一样） */
  function meshForPivot(pv) {
    if (!pv || !st.doc || !global.SeedModel || !SeedModel.Scene) return null;
    var id = pv.userData && pv.userData.mdNode;
    var nodes = SeedModel.Scene.nodesOf(st.doc);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) {
        /* 视口里画的必须是求值后的网格：有修改器时 base 只是输入，
         * 画 base 会让「加了细分却看不到细分」 */
        return SeedModel.Evaluator.evaluate(st.doc, nodes[i]) || SeedModel.Scene.getMesh(st.doc, nodes[i]);
      }
    }
    return null;
  }

  /* 修改器生效时，st.mesh 是求值结果（且被 evaluator 缓存共享），
   * 组件编辑会原地写坏它（applyCompDelta / restoreCompBase 直接改 positions）。
   * 所以组件模式与组件拾取统一在这里挡一道，提示先「应用修改器」。 */
  function nodeModsActive(node) {
    if (!node || !Array.isArray(node.modifiers) || !node.modifiers.length) return false;
    var mods = global.SeedModifiers;
    if (!mods || typeof mods.isActive !== 'function') return false;
    for (var i = 0; i < node.modifiers.length; i++) if (mods.isActive(node.modifiers[i])) return true;
    return false;
  }
  function modsBlockComponents() { return nodeModsActive(st.node); }

  function buildIslandOverlay(mesh, side) {
    var info = SeedModel.Mesh.uvIslands(mesh);
    var pos = [], col = [], rgb = new THREE.Color();
    for (var f = 0; f < mesh.faceIds.length; f++) {
      var islandId = info.faceIsland[f] >= 0 ? info.faceIsland[f] : 0;
      rgb.set(ISLAND_COLORS[islandId % ISLAND_COLORS.length]);
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      for (var t = s + 1; t < e - 1; t++) {
        [mesh.faceIndices[s], mesh.faceIndices[t], mesh.faceIndices[t + 1]].forEach(function (vi) {
          pos.push(mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]);
          col.push(rgb.r, rgb.g, rgb.b);
        });
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: side, toneMapped: false });
    var obj = new THREE.Mesh(geo, mat);
    obj.name = 'uv-island-layer';
    obj.userData.mdPart = 'uvisland';
    obj.renderOrder = 2;
    obj.frustumCulled = false;
    return obj;
  }

  /* 岛色层按网格版本缓存：拖动组件 / 环切后网格变了才重建，切着色模式时可以复用 */
  function ensureIslandOverlay(pv, side) {
    var mesh = meshForPivot(pv);
    if (!mesh) return null;
    var have = pv.userData.mdIslandLayer;
    if (have && pv.userData.mdIslandVersion === mesh.version) {
      if (have.material) have.material.side = side;
      return have;
    }
    if (have) {
      if (have.parent) have.parent.remove(have);
      if (have.geometry) have.geometry.dispose();
      if (have.material) have.material.dispose();
    }
    var layer = buildIslandOverlay(mesh, side);
    pv.add(layer);
    pv.userData.mdIslandLayer = layer;
    pv.userData.mdIslandVersion = mesh.version;
    return layer;
  }

  function applyShading() {
    if (!st.pivot) return;
    var p = st.prefs || prefs();
    var mode = st.shading;
    var islands = mode === 'uv';
    var unlit = mode === 'flat';
    var showFaces = mode !== 'wire' && !islands;
    var showEdges = mode !== 'shaded' && vfOn('edges');
    /* 组件隔离（面 / 岛）时只显示替身网格，原件的面、边线、顶点一律让位 */
    var isoComp = !!st.isoComp;
    var side = vfOn('backface') ? THREE.DoubleSide : THREE.FrontSide;
    if (st.edgeLines) {
      st.edgeLines.material.color.set(mode === 'wire' ? '#d7dde3' : p.edgeColor);
    }
    /* 顶点只在顶点模式下显示（Maya 的行为）：816 面的球体上每个点都画会糊成一片 */
    var showVerts = st.selMode === 'vertex' && vfOn('verts');
    eachViewPivot(function (pv) {
      /* UV 岛着色是按每个对象自己的网格算的：多对象场景里不能只画激活那个 */
      var layer = islands ? ensureIslandOverlay(pv, side) : pv.userData.mdIslandLayer;
      pv.traverse(function (o) {
        var part = o.userData && o.userData.mdPart;
        var off = !!(o.userData && o.userData.mdPreviewOff);
        if (part === 'solid') {
          if (showFaces) applySolidLook(o, unlit);
          o.visible = showFaces && !off && (!isoComp || !!o.userData.mdIsolate);
        } else if (part === 'edges') {
          o.visible = showEdges && !off && (!isoComp || !!o.userData.mdIsolate);
        } else if (part === 'verts') o.visible = showVerts && !isoComp;
        else if (part === 'uvisland') o.visible = islands;
      });
      if (layer && layer.material) layer.material.side = side;
    });
    /* 预览和正式模型一样吃着色开关（线框模式下实体收、边线亮） */
    if (st.previewHost) {
      st.previewHost.traverse(function (o) {
        var part = o.userData && o.userData.mdPart;
        if (part === 'solid') {
          /* UV 岛模式正式对象换成岛色，预览没有 UV 分层：用平涂色保持「无光照」的一致观感 */
          applySolidLook(o, unlit || islands);
          o.visible = mode !== 'wire';
        } else if (part === 'edges') {
          o.visible = showEdges;
          if (o.material) o.material.color.set(mode === 'wire' ? '#d7dde3' : p.edgeColor);
        }
      });
    }
    applyViewFlags();
  }

  function releaseView() {
    /* 新建 / 打开 / 切换文档：四视图与最大化状态一并清干净，别把 pane controls 留在 enable 状态 */
    if (st.quad || st.quadMax) {
      st.quad = false;
      st.quadMax = null;
      st.quadDown = null;
      st.quadClick = null;
      if (st.stage) {
        st.stage.classList.remove('quad');
        st.stage.classList.remove('quad-max');
      }
      syncQuadControls();
      updateQuadChrome();
    }
    if (st.controls) st.controls.enabled = true;
    var pivots = st.pivots ? Object.keys(st.pivots) : [];
    pivots.forEach(function (id) {
      var p = st.pivots[id];
      if (p && st.scene) st.scene.remove(p);
      if (p) disposeObject(p);
    });
    st.pivots = Object.create(null);
    st.pivot = null;
    st.edgeLines = null;
    st.vertPoints = null;
    st.selGroup = null;
    if (st.gizmo) st.gizmo.setTarget(null);
  }

  /* ---------------- 单独显示（已拆到 js/md-isolate.js） ---------------------------- */
  /* 隔离只影响视口（pivot.visible），文档里的 node.visible 一律不动；
   * 面 / 岛模式下模块会临时建一份只含选中面的替身，退出时扔掉。
   * 外壳保留同名门面，原来的调用点（rebuildModel / 点击 / 菜单）一行都不用改。 */
  var ISO = global.MDIsolate.create({
    st: st, THREE: THREE, SeedModel: SeedModel,
    applyShading: applyShading, makeMaterials: makeMaterials,
    buildEdgeLinesFor: buildEdgeLinesFor,
    setStatus: setStatus, updateChrome: updateChrome
  });
  function applyIsolation() { return ISO.apply(); }
  function refreshIsoChild() { return ISO.refresh(); }
  function toggleIsolate() { return ISO.toggle(); }

  /* 多对象渲染：文档里每个可见节点各一个 pivot；叠加层（边线/顶点）只画在**激活对象**上。
   * 以前只建一个 pivot，所以「删掉最后一个对象」时旧模型留在场景里、「新建球体」看起来像替换。 */
  function rebuildModel(keepCamera) {
    if (!st.doc) return false;
    try {
      st.node = SeedModel.Scene.nodeOf(st.doc);
      /* 对象选择只有一个口径：nodeIds。换文档 / 撤销 / 新建 / 删除后旧 id 会失效，
       * 这里收敛到真实存在的节点，并保证激活对象一定在集合里 ——
       * 「单独显示」靠这个集合算可见对象，漏了就会显示空场景 / 多显示一个。 */
      var aliveIds = Object.create(null);
      SeedModel.Scene.nodesOf(st.doc).forEach(function (n) { aliveIds[n.id] = 1; });
      st.nodeIds = (st.nodeIds || []).filter(function (id) { return aliveIds[id]; });
      if (st.node && st.nodeIds.indexOf(st.node.id) < 0) st.nodeIds.push(st.node.id);
      st.mesh = st.node
        ? (SeedModel.Evaluator.evaluate(st.doc, st.node) || SeedModel.Scene.getMesh(st.doc))
        : null;

      var old = st.pivots || Object.create(null);
      Object.keys(old).forEach(function (id) {
        var p = old[id];
        if (p && st.scene) st.scene.remove(p);
        if (p) { disposeOverlays(p); disposeObject(p); }
      });
      st.pivots = Object.create(null);
      st.pivot = null;

      var nodes = SeedModel.Scene.nodesOf(st.doc);
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        /* 视口只画求值结果：修改器栈是「输入 → 输出」的黑盒，
         * base 只用来编辑，显示 / 拾取 / 边线都必须读 evaluate 的输出。 */
        var mesh = SeedModel.Evaluator.evaluate(st.doc, n) || SeedModel.Scene.getMesh(st.doc, n);
        if (!mesh) continue;
        var pv = makePivotFor(n, mesh, true);
        st.scene.add(pv);
        st.pivots[n.id] = pv;
        if (st.node && n.id === st.node.id) { st.pivot = pv; st.mesh = mesh; }
      }
      applyIsolation();
      if (!st.pivot) {
        /* 空场景不是错误：删掉最后一个对象后，文档里确实一个网格也没有。
         * 收手柄、清叠加层、HUD 归零，相机保持不动，等用户从「新建」再建一个。 */
        st.gizmo.setTarget(null);
        paintSelection();
        applyShading();
        updateHud();
        if (!keepCamera) frameCamera();
        if (st.quad) updateQuadCameras(false);
        if (MIX) MIX.refresh();
        return true;
      }

      addOverlays(st.pivot);          /* 叠加层读 st.mesh（此刻= 激活对象的网格） */
      /* 走 syncGizmo 而不是直接 setTarget：绘画页签下撤销 / 重做会走到这里，
       * 直接挂上去会把手柄重新亮出来，下一笔又会被「屏幕平移」手柄吃掉。 */
      syncGizmo();
      /* ⚠ 必须在这里再 applyShading 一次：addOverlays 里那次读的是旧 st.pivot */
      applyShading();
      paintSelection();
      updateHud();
      if (!keepCamera) frameCamera();
      if (st.quad) updateQuadCameras(false);
      /* 材质刚被重建过：把该槽的纹理混合重新挂回来（有配置才动，没有就什么都不做） */
      if (MIX) MIX.refresh();
      return true;
    } catch (e) {
      setStatus('网格构建失败：' + ((e && e.message) || e), true);
      return false;
    }
  }

  /* ---------------- 历史（已拆到 js/md-history.js） ---------------- */
  /* 外壳只留门面：快照 / 入栈 / 清空 / 应用 / 撤销 / 重做，原调用点一行都不用改。
   * 网格副本表跟着模块走，这里不要再建第二份。 */
  var HIST = global.MDHistory.create({
    st: st, SeedModel: SeedModel,
    historyBudget: HISTORY_BUDGET,
    applyPaintPatch: applyPaintPatch,
    applyMixPatch: applyMixPatch,
    applyMatsPatch: applyMatsPatch,
    applyTexPatch: applyTexPatch,
    rebuildModel: rebuildModel, paintAll: paintAll,
    updateChrome: updateChrome, setStatus: setStatus
  });
  function meshHashOf(mesh) { return HIST.hashOf(mesh); }
  function ensureMeshCopy(mesh) { return HIST.registerMesh(mesh); }
  function snap() { return HIST.snap(); }
  function pushHistory(before, after, label) { return HIST.push(before, after, label); }
  function clearHistory(reason) { return HIST.clear(reason); }
  function totalBytes() { return HIST.totalBytes(); }
  function syncBytes() { return HIST.syncBytes(); }

  /* M6 的算子走这个口：换网格 → 网格版本 +1 → 一次历史。 */
  function applyMesh(mesh, label, name) {
    if (!st.doc || !mesh) return false;
    var before = snap();
    SeedModel.Scene.setMesh(st.doc, mesh);
    SeedModel.Scene.revision(st.doc, 'mesh');
    /* 改名必须和换网格在同一条历史里：分成两步的话撤销一次只会撤掉名字 */
    if (name) SeedModel.Scene.setName(st.doc, name);
    st.mesh = SeedModel.Scene.getMesh(st.doc);
    rebuildModel(true);
    var after = snap();
    var ok = pushHistory(before, after, label || '网格编辑');
    paintAll();
    return ok;
  }

  /* ============================================================
   * M6a：工具会话框架（假工具 = 整条链路跑通，不算子）
   *
   * 「假工具」是「沿法线挤一点点」的预览：begin/drag 只改预览 mesh，
   * commit 才 applyMesh（一条历史），cancel 丢预览（文档逐字节不变）。
   * 用它把 seed-commands / seed-tools / seed-snap / seed-view-flags 串起来，
   * M6b 的真算子（挤出/内插/删除面/合并顶点）就换成同一条骨架。
   *
   * ⚠ 预览只进 `st.previewMesh`，**不碰 st.mesh / 不碰 doc.meshes**。
   *   commit 走 applyMesh（已带 snap/pushHistory/paintAll），cancel 不留痕。
   * ============================================================ */

  function previewParent() {
    if (!st.previewHost) {
      st.previewHost = new THREE.Group();
      st.previewHost.name = 'tool-preview';
      if (st.scene) st.scene.add(st.previewHost);
    }
    return st.previewHost;
  }

  function clearToolPreview(silent) {
    st.previewMesh = null;
    /* 预览期间收起来的正式实体 / 边线要放回去（silent 用于「换成下一帧预览」时避免闪烁） */
    var hidden = st.previewHiddenObjs || [];
    for (var i = 0; i < hidden.length; i++) {
      var o = hidden[i];
      if (!o) continue;
      if (o.userData) delete o.userData.mdPreviewOff;
      o.visible = true;
    }
    st.previewHiddenObjs = [];
    if (st.previewHost && st.previewHost.parent) {
      while (st.previewHost.children.length) {
        var c = st.previewHost.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          (Array.isArray(c.material) ? c.material : [c.material]).forEach(function (m) {
            if (m) m.dispose();
          });
        }
        var flat = c.userData && c.userData.mdFlatMats;
        if (flat) {
          (Array.isArray(flat) ? flat : [flat]).forEach(function (m) {
            if (m && m !== c.material) m.dispose();
          });
        }
      }
    }
    if (st.previewHost && st.scene) st.scene.remove(st.previewHost);
    st.previewHost = null;
    if (!silent) {
      if (st.pivot) applyShading();
      if (st.mesh) paintSelection();
    }
  }

  /* 把一份「只在视口里」的预览网格挂出来（不进文档）。
   * 预览用的是**正式模型同一套材质和边线**，不再盖一层青色半透明罩：
   * 罩会把整只模型染成一个颜色，挤出 / 内插时根本看不清形体变化。 */
  function showToolPreview(mesh, opts) {
    if (!THREE) return false;
    clearToolPreview(true);
    if (!mesh) return false;
    var geo = SeedModel.Mesh.buildGeometry(mesh, { cache: false });
    var obj = new THREE.Mesh(geo, makeMaterials());
    obj.name = 'tool-preview-mesh';
    obj.userData.mdPart = 'solid';
    var host = previewParent();
    host.add(obj);
    host.add(buildEdgeLinesFor(mesh, 'preview-edges'));
    /* 同一个对象的原实体 / 原边线先收起来：两套几何叠着会深度打架、边线也会停在旧拓扑 */
    if (st.pivot) {
      var hidden = st.previewHiddenObjs = [];
      st.pivot.traverse(function (o) {
        var part = o.userData && o.userData.mdPart;
        if (part !== 'solid' && part !== 'edges') return;
        o.userData.mdPreviewOff = true;
        o.visible = false;
        hidden.push(o);
      });
      /* 预览挂在激活 pivot 的同一坐标系下（手柄在世界系，预览跟着走） */
      host.position.copy(st.pivot.position);
      host.quaternion.copy(st.pivot.quaternion);
      host.scale.copy(st.pivot.scale);
      host.updateMatrixWorld(true);
    }
    st.previewMesh = mesh;
    if (!(opts && opts.keepSelection === false)) paintSelection(mesh);
    return true;
  }

  /* 会话上下文：给工具的是「只读快照 + 一个 apply 钩子」，不是整个 st。
   * 快照必须是 base 网格：工具结果最终要写回文档，不能把视口求值结果当输入。 */
  function toolCtx() {
    return {
      doc: st.doc,
      mesh: baseMeshNow(),
      node: st.node,
      selection: {
        mode: st.selMode,
        vertexIds: st.sel.vertexIds.slice(),
        edgeIds: st.sel.edgeIds.slice(),
        faceIds: st.sel.faceIds.slice()
      },
      preview: null,
      params: null,
      /* 工具自己算出新网格后，调这个把它挂进视口（不写文档） */
      showPreview: function (m) { return showToolPreview(m); },
      /* 提交：唯一允许写文档的口子 */
      apply: function (m, label) { return applyMesh(m, label || '工具'); },
      status: function (t, isErr) { setStatus(t, isErr); }
    };
  }

  /* 假工具：沿法线整体外推 d（米）。d 来自 params.offset。
   * 拖动期间只改 preview，commit 才 apply。 */
  function registerFakeTool() {
    var SeedTools = global.SeedTools, SeedCommands = global.SeedCommands;
    if (!SeedTools || !SeedCommands) return;

    SeedTools.register({
      id: 'tool.inflate',
      label: '沿法线外推（演示工具）',
      params: [
        { key: 'offset', label: '外推量 (m)', value: 0.05, min: -1, max: 1, step: 0.01 }
      ],
      begin: function (ctx) {
        if (!ctx.mesh) return false;
        ctx.base = SeedModel.Mesh.clone(ctx.mesh);
        ctx.preview = SeedModel.Mesh.clone(ctx.mesh);
        inflateMesh(ctx.preview, Number(ctx.params.offset) || 0);
        ctx.showPreview(ctx.preview);
        ctx.status('工具会话：开始（拖动改预览，松手提交，Esc 取消）');
        return true;
      },
      drag: function (ctx) {
        if (!ctx.base) return;
        ctx.preview = SeedModel.Mesh.clone(ctx.base);
        inflateMesh(ctx.preview, Number(ctx.params.offset) || 0);
        ctx.showPreview(ctx.preview);
      },
      commit: function (ctx) {
        if (!ctx.preview) return false;
        var m = SeedModel.Mesh.clone(ctx.preview);
        var ok = ctx.apply(m, '沿法线外推 ' + (Number(ctx.params.offset) || 0).toFixed(2) + ' m');
        if (ok) ctx.status('已提交：沿法线外推');
        return ok;
      },
      cancel: function (ctx) {
        ctx.base = null;
        ctx.preview = null;
        clearToolPreview();
        ctx.status('已取消（文档未改动）');
      }
    });

    /* 命令入口：菜单 / 命令行 / 快捷键都查这一条 */
    SeedCommands.define({
      id: 'tool.inflate',
      label: '沿法线外推',
      group: 'mesh',
      key: 'B',
      order: 100,
      when: function () { return !!(st.doc && st.mesh); },
      run: function () {
        return beginTool('tool.inflate');
      }
    });

    /* 显示开关也归一到一张表（A4） */
    var VF = global.SeedViewFlags;
    if (VF) {
      VF.onChange(function (name, v) {
        if (name === 'wireframe') { setShading(v ? 'wire' : 'shaded'); return; }
        st.showGrid = VF.get('grid') !== false;
        if (st.gridHelper) st.gridHelper.visible = st.showGrid;
        applyShading();          /* edges / verts / backface / material / texture / lighting 一次收口 */
        updateChrome();
      });
    }
  }

  /* 沿顶点法线外推（假工具的几何动作，M6b 换成真挤出/内插） */
  function inflateMesh(mesh, d) {
    if (!mesh || !d) return mesh;
    var vCount = mesh.positions.length / 3;
    var fCount = mesh.faceOffsets.length - 1;
    for (var i = 0; i < vCount; i++) {
      /* 顶点「外推方向」= 从质心指向它（演示够用；真算子用面法线） */
      var cx = 0, cy = 0, cz = 0, cnt = 0;
      for (var f = 0; f < fCount; f++) {
        var st0 = mesh.faceOffsets[f], en = mesh.faceOffsets[f + 1];
        for (var k = st0; k < en; k++) {
          if (mesh.faceIndices[k] === i) {
            cx += mesh.positions[mesh.faceIndices[st0] * 3];
            cy += mesh.positions[mesh.faceIndices[st0] * 3 + 1];
            cz += mesh.positions[mesh.faceIndices[st0] * 3 + 2];
            cnt++;
          }
        }
      }
      if (!cnt) continue;
      cx /= cnt; cy /= cnt; cz /= cnt;
      var vx = mesh.positions[i * 3], vy = mesh.positions[i * 3 + 1], vz = mesh.positions[i * 3 + 2];
      var dx = vx - cx, dy = vy - cy, dz = vz - cz;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      mesh.positions[i * 3] = vx + (dx / len) * d;
      mesh.positions[i * 3 + 1] = vy + (dy / len) * d;
      mesh.positions[i * 3 + 2] = vz + (dz / len) * d;
    }
    if (SeedModel.Mesh.bump) SeedModel.Mesh.bump(mesh);
    return mesh;
  }

  /* ============================================================
   * M6b：真算子（挤出 / 内插 / 删除面 / 合并顶点）
   *
   * 与「假工具」同一条骨架：begin/drag 只改预览、commit 才 applyMesh（一条历史）、
   * Esc 无痕。差别是几何动作换成 SeedOps 里的真拓扑算子，
   * 并且**选中组件**才是算子的操作对象（没选就拒绝开会话）。
   * ============================================================ */

  /* 当前选择的面 ID / 顶点 ID（island 模式当面用） */
  function selFaceIds() {
    return (st.selMode === 'face' || st.selMode === 'island') ? st.sel.faceIds.slice() : [];
  }
  function selVertexIds() {
    return st.selMode === 'vertex' ? st.sel.vertexIds.slice() : [];
  }
  /* 选中边里的第一条 → 两端顶点 ID（环切 / 循环边的起点）。
   * 用 base 网格：环切最终写回文档，不能拿求值结果里的边去套 base 的面。 */
  function selEdgePair() {
    var base = baseMeshNow();
    if (!base || !st.sel.edgeIds.length || !SeedModel.Mesh) return null;
    var tbl = SeedModel.Mesh.ensureEdges(base);
    for (var i = 0; i < st.sel.edgeIds.length; i++) {
      var rec = tbl.edgeById[st.sel.edgeIds[i]];
      if (rec) return { aId: rec.aId, bId: rec.bId };
    }
    return null;
  }
  /* 环切前置条件：边模式 + 至少一条边 + 该边在全四边环上。返回空串=可以开始 */
  function loopCutBlocked() {
    if (st.selMode !== 'edge' || !selEdgePair()) return '环切：先在边模式选中一条边';
    var pair = selEdgePair();
    if (!global.SeedOps || !global.SeedOps.edgeRing(baseMeshNow(), pair.aId, pair.bId)) {
      return '环切：选中边不在全四边环上（先把相邻三角面转成四边，或换一条边）';
    }
    return '';
  }

  /* 三角转四边：整网格一次性算子。成对共边三角并成四边，UV 接缝 / 折叠处不动。
   * 没有一对可并时返回 null 并由状态行说明原因，不静默吞掉。 */
  function trisToQuadsNow() {
    if (!global.SeedOps || !global.SeedOps.trisToQuads || !baseMeshNow()) return false;
    var base = baseMeshNow();
    var out = global.SeedOps.trisToQuads(base, { tolDeg: 40 });
    if (!out) {
      setStatus('三角转四边：没有可合并的三角面（需要成对共边、同材质、凸四边形且 UV 连续）', true);
      return false;
    }
    var merged = base.faceIds.length - out.faceIds.length;
    applyMesh(out, '三角转四边');
    setStatus('三角转四边：合并 ' + merged + ' 对三角，面数 ' + out.faceIds.length);
    return true;
  }

  /* 溶解：把选中的点 / 边 / 面并进邻接面。
   * 合法性（闭合扇形 / 恰好两面 / 唯一边界）全在算子层判，失败返回 null + lastOpError。 */
  function dissolveNow() {
    var SeedOps = global.SeedOps;
    var base = baseMeshNow();
    if (!SeedOps || !SeedOps.dissolve || !base) {
      setStatus('溶解：当前没有可编辑的网格', true);
      return false;
    }
    var kind = 'face', ids = [];
    if (st.selMode === 'vertex') { kind = 'vertex'; ids = selVertexIds(); }
    else if (st.selMode === 'edge') { kind = 'edge'; ids = st.sel.edgeIds.slice(); }
    else { ids = selFaceIds(); }
    var noun = kind === 'vertex' ? '点' : (kind === 'edge' ? '边' : '面');
    if (!ids.length) {
      setStatus('溶解：先在' + noun + '模式下选中要溶解的组件', true);
      return false;
    }
    var out = SeedOps.dissolve(base, { kind: kind, ids: ids });
    if (!out) {
      setStatus('溶解失败：' + (SeedOps.lastOpError || '选择不满足条件（点需闭合扇形、边需恰好两面、面区域需唯一边界）'), true);
      return false;
    }
    applyMesh(out, '溶解');
    setStatus('溶解：处理 ' + ids.length + ' 个' + noun + '，面数 ' + out.faceIds.length);
    return true;
  }

  /* 细分一次：整网格一级 simple 细分（和「添加分段」不同，那个只切选中面） */
  function subdivideOnceNow() {
    var SeedOps = global.SeedOps;
    var base = baseMeshNow();
    if (!SeedOps || !SeedOps.subdivideOnce || !base) {
      setStatus('细分一次：当前没有可编辑的网格', true);
      return false;
    }
    var out = SeedOps.subdivideOnce(base, { simple: true });
    if (!out) {
      setStatus('细分一次失败：' + (SeedOps.lastOpError || '网格为空或面数超出上限'), true);
      return false;
    }
    applyMesh(out, '细分一次');
    setStatus('细分一次：' + base.faceIds.length + ' 面 → ' + out.faceIds.length + ' 面');
    return true;
  }

  /* 通用：算子会话骨架。op(mesh, params) → 新 mesh | null */
  function makeOpTool(id, label, op, paramSchema, hintText, opts) {
    return {
      id: id,
      label: label,
      params: paramSchema,
      /* 自带操纵器的工具（目前只有挤出）要在 spec 里声明，外壳据此把变换手柄收起来。
       * 别改回「外壳里判 id」—— 那等于加一个自带手柄的工具就要改外壳。 */
      ownsGizmo: !!(opts && opts.ownsGizmo),
      begin: function (ctx) {
        if (!ctx.mesh) return false;
        ctx.base = SeedModel.Mesh.clone(ctx.mesh);
        ctx.preview = op(ctx.base, ctx.params);
        if (!ctx.preview) return false;
        ctx.showPreview(ctx.preview);
        ctx.status(hintText);
        return true;
      },
      drag: function (ctx) {
        if (!ctx.base) return;
        ctx.preview = op(ctx.base, ctx.params);
        if (ctx.preview) ctx.showPreview(ctx.preview);
      },
      commit: function (ctx) {
        if (!ctx.preview) return false;
        var m = SeedModel.Mesh.clone(ctx.preview);
        var ok = ctx.apply(m, label);
        if (ok) ctx.status('已提交：' + label);
        return ok;
      },
      cancel: function (ctx) {
        ctx.base = null;
        ctx.preview = null;
        clearToolPreview();
        ctx.status('已取消（文档未改动）');
      }
    };
  }

  /* 命令入口：when 判「有没有对应的组件选择」，没有就灰显 */
  function defineOpCommand(id, label, group, key, order, when, toolId) {
    var SeedCommands = global.SeedCommands;
    if (!SeedCommands) return;
    SeedCommands.define({
      id: id,
      label: label,
      group: group,
      key: key,
      order: order,
      when: when,
      run: function () { return beginTool(toolId || id); }
    });
  }

  /* 注册四个真算子（挤出 / 内插 / 删除面 / 合并顶点） */
  function registerOperators() {
    var SeedTools = global.SeedTools;
    var SeedOps = global.SeedOps;
    if (!SeedTools || !SeedOps) return;

    /* 挤出：选中面 → 沿法线长出侧壁；无面选择时退化为整体外推。
     * 五个参数对应 Maya polyExtrudeFace：厚度 / 局部平移 Z / 偏移 / 分段 / 保持面的连续性 */
    SeedTools.register(makeOpTool(
      'tool.extrude', '挤出',
      function (base, p) {
        return SeedOps.extrudeFaces(base, {
          faceIds: selFaceIds(),
          dist: Number(p.dist) || 0,
          localZ: Number(p.localZ) || 0,
          offset: Number(p.offset) || 0,
          divisions: Number(p.divisions) || 1,
          keepTogether: Number(p.keep) !== 0
        });
      },
      [
        { key: 'dist', label: '厚度', value: 0.1, min: -2, max: 2, step: 0.01 },
        { key: 'localZ', label: '局部平移 Z', value: 0, min: -2, max: 2, step: 0.01 },
        { key: 'offset', label: '偏移', value: 0, min: -2, max: 2, step: 0.01 },
        { key: 'divisions', label: '分段', value: 1, min: 1, max: 8, step: 1 },
        { key: 'keep', label: '保持面的连续性', value: 1, min: 0, max: 1, step: 1, type: 'toggle' }
      ],
      '工具会话：挤出（改厚度看预览，Enter 提交，Esc 取消）',
      { ownsGizmo: true }
    ));
    defineOpCommand('mesh.extrude', '挤出', 'mesh', 'Ctrl+E', 10,
      function () { return !!(st.doc && st.mesh && selFaceIds().length); }, 'tool.extrude');

    /* 内插：选中面 → 向质心缩一圈 */
    SeedTools.register(makeOpTool(
      'tool.inset', '内插',
      function (base, p) {
        return SeedOps.insetFaces(base, { faceIds: selFaceIds(), thick: Number(p.thick) || 0 });
      },
      [{ key: 'thick', label: '厚度', value: 0.2, min: 0, max: 0.95, step: 0.01 }],
      '工具会话：内插（改「厚度」看预览，Enter 提交，Esc 取消）'
    ));
    defineOpCommand('mesh.inset', '内插', 'mesh', '', 11,
      function () { return !!(st.doc && st.mesh && selFaceIds().length); }, 'tool.inset');

    /* 删除面：选中面整块删掉，可选清理孤立点 */
    SeedTools.register(makeOpTool(
      'tool.deleteFaces', '删除面',
      function (base, p) {
        return SeedOps.deleteFaces(base, { faceIds: selFaceIds(), clean: !!Number(p.clean) });
      },
      [{ key: 'clean', label: '清理孤立点 (0/1)', value: 1, min: 0, max: 1, step: 1 }],
      '工具会话：删除面（Esc 取消，Enter 提交）'
    ));
    defineOpCommand('mesh.deleteFaces', '删除面', 'mesh', 'Del', 12,
      function () { return !!(st.doc && st.mesh && selFaceIds().length); }, 'tool.deleteFaces');

    /* 合并顶点：选中顶点焊到质心 */
    SeedTools.register(makeOpTool(
      'tool.mergeVertices', '合并顶点',
      function (base, p) {
        return SeedOps.mergeVertices(base, { vertexIds: selVertexIds(), thr: Number(p.thr) || 0 });
      },
      [{ key: 'thr', label: '阈值 (m)', value: 0, min: 0, max: 1, step: 0.005 }],
      '工具会话：合并顶点（Esc 取消，Enter 提交）'
    ));
    defineOpCommand('mesh.mergeVertices', '合并顶点', 'mesh', '', 13,
      function () { return !!(st.doc && st.mesh && selVertexIds().length); }, 'tool.mergeVertices');

    /* 平滑：选中点 → 拉普拉斯平滑；不选 = 整体平滑 */
    SeedTools.register(makeOpTool(
      'tool.smooth', '平滑',
      function (base, p) {
        return SeedOps.smoothVertices(base, {
          vertexIds: selVertexIds(),
          strength: Number(p.strength),
          iterations: Number(p.iterations)
        });
      },
      [
        { key: 'strength', label: '强度', value: 0.5, min: 0, max: 1, step: 0.01 },
        { key: 'iterations', label: '次数', value: 1, min: 1, max: 10, step: 1 }
      ],
      '工具会话：平滑（不选点 = 整体；Enter 提交，Esc 取消）'
    ));
    defineOpCommand('mesh.smooth', '平滑', 'mesh', '', 14,
      function () { return !!(st.doc && st.mesh); }, 'tool.smooth');

    /* 面倒角：内缩环 + 法线偏移 */
    SeedTools.register(makeOpTool(
      'tool.bevel', '倒角',
      function (base, p) {
        return SeedOps.bevelFaces(base, {
          faceIds: selFaceIds(), width: Number(p.width), depth: Number(p.depth), seg: Number(p.seg)
        });
      },
      [
        { key: 'width', label: '宽度', value: 0.08, min: 0.001, max: 0.45, step: 0.005 },
        { key: 'depth', label: '深度 (m)', value: 0, min: -0.5, max: 0.5, step: 0.01 },
        { key: 'seg', label: '分段', value: 1, min: 1, max: 4, step: 1 }
      ],
      '工具会话：面倒角（选中面内缩成环；Enter 提交，Esc 取消）'
    ));
    defineOpCommand('mesh.bevel', '倒角', 'mesh', '', 15,
      function () { return !!(st.doc && st.mesh && selFaceIds().length); }, 'tool.bevel');

    /* 桥接：两个同顶点数的面 */
    SeedTools.register(makeOpTool(
      'tool.bridge', '桥接',
      function (base, p) {
        return SeedOps.bridgeFaces(base, { faceIds: selFaceIds(), segments: Number(p.segments) });
      },
      [{ key: 'segments', label: '分段', value: 1, min: 1, max: 8, step: 1 }],
      '工具会话：桥接（选中恰好两个同边数面；Enter 提交）'
    ));
    defineOpCommand('mesh.bridge', '桥接', 'mesh', '', 16,
      function () { return !!(st.doc && st.mesh && selFaceIds().length === 2); }, 'tool.bridge');

    /* 添加分段：选中面切一刀 */
    SeedTools.register(makeOpTool(
      'tool.subdivide', '添加分段',
      function (base) { return SeedOps.subdivideFaces(base, { faceIds: selFaceIds() }); },
      [],
      '工具会话：添加分段（每个选中面切四份；Enter 提交）'
    ));
    defineOpCommand('mesh.subdivide', '添加分段', 'mesh', '', 17,
      function () { return !!(st.doc && st.mesh && selFaceIds().length); }, 'tool.subdivide');

    /* 连接：两个顶点切面 */
    SeedTools.register(makeOpTool(
      'tool.connect', '连接',
      function (base) { return SeedOps.connectVertices(base, { vertexIds: selVertexIds() }); },
      [],
      '工具会话：连接（选中两个顶点；在共有面上切开；Enter 提交）'
    ));
    defineOpCommand('mesh.connect', '连接', 'mesh', '', 18,
      function () { return !!(st.doc && st.mesh && selVertexIds().length === 2); }, 'tool.connect');

    /* 目标焊接：最后一个选中的点 = 目标 */
    SeedTools.register(makeOpTool(
      'tool.targetWeld', '目标焊接',
      function (base) { return SeedOps.targetWeld(base, { vertexIds: selVertexIds() }); },
      [],
      '工具会话：目标焊接（先选源点、最后选目标点；Enter 提交）'
    ));
    defineOpCommand('mesh.targetWeld', '目标焊接', 'mesh', '', 19,
      function () { return !!(st.doc && st.mesh && selVertexIds().length >= 2); }, 'tool.targetWeld');

    /* 四边形绘制：4 个选中点成面 */
    SeedTools.register(makeOpTool(
      'tool.quadDraw', '四边形绘制',
      function (base) { return SeedOps.createQuadFace(base, { vertexIds: selVertexIds() }); },
      [],
      '工具会话：四边形绘制（按选择顺序用 4 个顶点成面）'
    ));
    defineOpCommand('mesh.quadDraw', '四边形绘制', 'mesh', '', 20,
      function () { return !!(st.doc && st.mesh && selVertexIds().length === 4); }, 'tool.quadDraw');

    /* 环切：四边边环 → 每条环边插点，每张四边面切成 count+1 条。
     * 起点是选中边；滑移只改切点位置，拓扑结构不变，所以能当 live 预览反复调。 */
    SeedTools.register(makeOpTool(
      'tool.loopcut', '环切',
      function (base, p) {
        var pair = selEdgePair();
        if (!pair) return null;
        return SeedOps.loopCut(base, {
          aId: pair.aId, bId: pair.bId,
          count: Number(p.count), slide: Number(p.slide)
        });
      },
      [
        { key: 'count', label: '条数', value: 1, min: 1, max: 8, step: 1 },
        { key: 'slide', label: '滑移', value: 0, min: -1, max: 1, step: 0.01 }
      ],
      '工具会话：环切（只处理全四边环；改条数 / 滑移看预览，Enter 提交，Esc 取消）'
    ));

    /* 阵列：整份基础网格线性复制（count 含原件；merge 焊接重合点）。
     * 放工具会话里，改数量 / 间距能反复看预览，Enter 才提交。 */
    SeedTools.register(makeOpTool(
      'tool.array', '阵列',
      function (base, p) {
        return SeedOps.arrayMesh(base, {
          mode: 'linear',
          count: Number(p.count),
          offset: [Number(p.dx) || 0, Number(p.dy) || 0, Number(p.dz) || 0],
          merge: Number(p.merge) !== 0
        });
      },
      [
        { key: 'count', label: '数量（含原件）', value: 3, min: 1, max: 200, step: 1 },
        { key: 'dx', label: '间距 X', value: 1.2, min: -20, max: 20, step: 0.01 },
        { key: 'dy', label: '间距 Y', value: 0, min: -20, max: 20, step: 0.01 },
        { key: 'dz', label: '间距 Z', value: 0, min: -20, max: 20, step: 0.01 },
        { key: 'merge', label: '焊接重合点', value: 0, min: 0, max: 1, step: 1, type: 'toggle' }
      ],
      '工具会话：阵列（数量含原件；改间距看预览，Enter 提交，Esc 取消）'
    ));
    defineOpCommand('mesh.array', '阵列', 'mesh', '', 23,
      function () { return !!(st.doc && st.mesh); }, 'tool.array');

    var SeedCommands = global.SeedCommands;
    if (SeedCommands) {
      SeedCommands.define({
        id: 'mesh.loopcut', label: '环切', group: 'mesh', key: '', order: 21,
        when: function () { return st.selMode === 'edge' && st.sel.edgeIds.length > 0; },
        run: function () {
          var msg = loopCutBlocked();
          if (msg) { setStatus(msg, true); return false; }
          return beginTool('tool.loopcut');
        }
      });
      SeedCommands.define({
        id: 'mesh.trisToQuads', label: '三角转四边', group: 'mesh', key: '', order: 22,
        when: function () { return !!(st.doc && st.mesh); },
        run: function () { return trisToQuadsNow(); }
      });
      /* 溶解 / 细分一次是一次性命令：没有参数，失败原因由算子层给出 */
      SeedCommands.define({
        id: 'mesh.dissolve', label: '溶解', group: 'mesh', key: '', order: 24,
        when: function () {
          return !!(st.doc && baseMeshNow()
            && (selVertexIds().length || st.sel.edgeIds.length || selFaceIds().length));
        },
        run: function () { return dissolveNow(); }
      });
      SeedCommands.define({
        id: 'mesh.subdivideOnce', label: '细分一次', group: 'mesh', key: '', order: 25,
        when: function () { return !!(st.doc && baseMeshNow()); },
        run: function () { return subdivideOnceNow(); }
      });
    }
  }

  /* 统一的工具会话入口（键盘 / 命令行 / 命令表都走它） */
  function beginTool(id) {
    var SeedTools = global.SeedTools;
    if (!SeedTools) return false;
    var r = SeedTools.begin(id, toolCtx());
    if (!r.ok) {
      setStatus('工具无法启动：' + (r.reason || '未知原因'), true);
      return false;
    }
    /* 会话状态只有一份：SeedTools 内部的 live。这里不再往 st 存镜像
     * （以前有 st.toolSession，与 live 双写，两处不同步时症状极难查）。
     * 手柄收不收也由 syncGizmo 按 spec 判，不再在这里认 id。 */
    syncGizmo();
    openToolPanel();
    return true;
  }

  /* 工具参数面板（Maya 的 polyExtrudeFace 通道盒）：
   * 工具一启动就弹出来，改数字 / 切开关立刻重算预览；Enter 提交、Esc 取消时一起收起。
   * 参数表来自 SeedTools.listParams()，所以只给「有参数的算子」弹。 */
  function openToolPanel() {
    closeToolPanel();
    var SeedTools = global.SeedTools;
    if (!SeedTools || !SeedTools.isLive()) return;
    var cur = SeedTools.current();
    var list = SeedTools.listParams();
    if (!list.length) return;
    var impl = SeedTools.lookup(cur.id) || {};
    var rows = list.map(function (p, i) {
      if (p.type === 'toggle') {
        var on = Number(p.value) !== 0;
        return '<div class="md-hbp-row"><span>' + esc(p.label) + '</span>' +
          '<button type="button" class="md-tp-sw' + (on ? ' on' : '') + '" data-tp="' + i +
          '">' + (on ? '启用' : '禁用') + '</button></div>';
      }
      return '<label class="md-hbp-row"><span>' + esc(p.label) + '</span>' +
        '<input type="number" data-tp="' + i + '" value="' + (Number(p.value) || 0) + '"' +
        (p.min != null ? ' min="' + p.min + '"' : '') + (p.max != null ? ' max="' + p.max + '"' : '') +
        ' step="' + (p.step != null ? p.step : 0.01) + '"></label>';
    }).join('');
    var box = document.createElement('div');
    box.className = 'md-hbp md-toolpanel';
    box.id = 'mdToolPanel';
    box.innerHTML =
      '<div class="md-hbp-h"><b>' + esc((impl.label || '工具') + '属性') + '</b>' +
        '<button type="button" data-tp-act="close">×</button></div>' +
      '<div class="md-hbp-b">' + rows + '</div>' +
      '<div class="md-hbp-f"><button type="button" class="md-hbp-apply" data-tp-act="done">完成 (Enter)</button></div>';
    document.body.appendChild(box);
    /* 面板挂在 body 上（避免被窗口的 overflow 裁掉），但位置要贴住**当前窗口**右上角：
     * 以前 CSS 写死 right:18 / top:96，窗口没最大化时面板会跑到屏幕角落去，看起来像没弹出来。 */
    var winEl = document.getElementById('modelDeskWin');
    if (winEl) {
      var wr = winEl.getBoundingClientRect();
      var pr = box.getBoundingClientRect();
      box.style.left = Math.max(8, Math.round(wr.right - pr.width - 18)) + 'px';
      box.style.top = Math.max(8, Math.round(wr.top + 96)) + 'px';
      box.style.right = 'auto';
    }
    st.toolPanel = box;

    box.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || !el.dataset || el.dataset.tp == null) return;
      var p = list[+el.dataset.tp];
      var v = Number(el.value);
      if (!p || !isFinite(v)) return;
      var patch = {};
      patch[p.key] = v;
      dragTool({ params: patch });
    });
    box.addEventListener('click', function (ev) {
      var sw = ev.target.closest ? ev.target.closest('.md-tp-sw') : null;
      if (sw) {
        var p = list[+sw.dataset.tp];
        var on = !sw.classList.contains('on');
        sw.classList.toggle('on', on);
        sw.textContent = on ? '启用' : '禁用';
        var patch = {};
        patch[p.key] = on ? 1 : 0;
        dragTool({ params: patch });
        return;
      }
      var b = ev.target.closest ? ev.target.closest('button') : ev.target;
      if (!b) return;
      var act = b.dataset.tpAct;
      if (act === 'done') commitTool();
      else if (act === 'close') cancelTool();
    });
  }

  function closeToolPanel() {
    if (st.toolPanel && st.toolPanel.parentNode) st.toolPanel.parentNode.removeChild(st.toolPanel);
    st.toolPanel = null;
  }

  function dragTool(update) {
    var SeedTools = global.SeedTools;
    if (!SeedTools || !SeedTools.isLive()) return false;
    return SeedTools.drag(update || {});
  }

  function commitTool() {
    var SeedTools = global.SeedTools;
    if (!SeedTools || !SeedTools.isLive()) return false;
    var r = SeedTools.commit();
    closeToolPanel();
    clearToolPreview();
    hideExtrudeGizmo();
    if (st.gizmo) syncGizmo();
    return r;
  }

  function cancelTool() {
    var SeedTools = global.SeedTools;
    if (!SeedTools || !SeedTools.isLive()) return false;
    var r = SeedTools.cancel();
    closeToolPanel();
    clearToolPreview();
    hideExtrudeGizmo();
    if (st.gizmo) syncGizmo();
    return r;
  }

  /* ============================================================
   * 挤出工具专用操纵器：法线箭头 + 轴心缩放柄
   *
   * 对照 Maya 的 polyExtrudeFace 手柄：一根沿面法线的箭头，拖动 = 厚度；
   * 箭头根部的方柄左右拖 = 顶面外扩（右）/ 收缩（左），也就是 offset 参数。
   * 手柄画在 world 空间（scene 下），每帧按相机距离保持屏幕尺寸；
   * 只在 tool.extrude 会话里可见，提交 / 取消立即收起。
   *
   * 为什么不用 ModelTransformGizmo：它绑的是对象/组件的 TRS，
   * 而这里要驱动的是**工具参数**（dist / offset），预览由 SeedTools 重算。
   * 自己画还能保证「拖手柄 = 改参数」只有一条路径，不会和变换手柄互相抢事件。
   * ============================================================ */

  function liveParamValue(key, def) {
    var SeedTools = global.SeedTools;
    if (SeedTools && SeedTools.isLive && SeedTools.isLive()) {
      var list = SeedTools.listParams();
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === key) return Number(list[i].value);
      }
    }
    return def;
  }

  function ensureExtrudeGizmo() {
    if (st.extrudeGizmo || !st.scene || !THREE) return st.extrudeGizmo;
    var matArrow = new THREE.MeshBasicMaterial({ color: 0xffb64a, depthTest: false, transparent: true, opacity: 0.97 });
    var matRoot = new THREE.MeshBasicMaterial({ color: 0xffd45e, depthTest: false, transparent: true, opacity: 0.95 });
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 1, 8, 1, true), matArrow);
    shaft.position.y = 0.55;                    /* 圆柱原点在中心，抬半个长度让根部落在原点 */
    var head = new THREE.Mesh(new THREE.ConeGeometry(0.072, 0.22, 14), matArrow);
    head.position.y = 1.21;                     /* 杆 0–1.1，锥体从 1.1 起 */
    var root = new THREE.Group();
    var ring = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.016, 6, 28), matRoot);
    var core = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.012), matRoot);
    root.add(ring); root.add(core);
    var group = new THREE.Group();
    group.name = '__extrude_gizmo';
    group.visible = false;
    group.renderOrder = 11;
    group.add(shaft); group.add(head); group.add(root);
    st.scene.add(group);
    st.extrudeGizmo = { group: group, shaft: shaft, head: head, root: root, radius: 0.5, basePx: null, tipPx: null };
    return st.extrudeGizmo;
  }

  function hideExtrudeGizmo() {
    st.extrudeDrag = null;
    st.extrudeHover = null;
    if (st.canvas) st.canvas.style.cursor = '';
    if (st.extrudeGizmo) st.extrudeGizmo.group.visible = false;
  }

  /* 选中面的世界中心 / 平均法线 / 半径（用文档网格，预览网格只是临时壳） */
  function extrudeSelectionWorld() {
    if (!st.mesh || !st.pivot || !SeedModel.Mesh) return null;
    var ids = selFaceIds();
    if (!ids.length) return null;
    var M = SeedModel.Mesh, pm = st.pivot.matrixWorld;
    var c = [0, 0, 0], nrm = [0, 0, 1], tmpN = [0, 0, 0];
    var count = 0, rad = 0;
    for (var k = 0; k < ids.length; k++) {
      var fi = -1;
      for (var q = 0; q < st.mesh.faceIds.length; q++) {
        if (st.mesh.faceIds[q] === ids[k]) { fi = q; break; }
      }
      if (fi < 0) continue;
      var s = st.mesh.faceOffsets[fi], e = st.mesh.faceOffsets[fi + 1], nv = e - s;
      if (nv < 3) continue;
      var fx = 0, fy = 0, fz = 0, c2, c3, vj, dx, dy, dz;
      for (c2 = s; c2 < e; c2++) {
        vj = st.mesh.faceIndices[c2];
        fx += st.mesh.positions[vj * 3]; fy += st.mesh.positions[vj * 3 + 1]; fz += st.mesh.positions[vj * 3 + 2];
      }
      fx /= nv; fy /= nv; fz /= nv;
      M.triNormal(st.mesh, fi, tmpN);
      c[0] += fx; c[1] += fy; c[2] += fz;
      nrm[0] += tmpN[0]; nrm[1] += tmpN[1]; nrm[2] += tmpN[2];
      count++;
      for (c3 = s; c3 < e; c3++) {
        vj = st.mesh.faceIndices[c3];
        dx = st.mesh.positions[vj * 3] - fx;
        dy = st.mesh.positions[vj * 3 + 1] - fy;
        dz = st.mesh.positions[vj * 3 + 2] - fz;
        rad = Math.max(rad, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    if (!count) return null;
    c[0] /= count; c[1] /= count; c[2] /= count;
    var nl = Math.sqrt(nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]) || 1;
    var center = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(pm);
    var normal = new THREE.Vector3(nrm[0] / nl, nrm[1] / nl, nrm[2] / nl).transformDirection(pm).normalize();
    var ps = new THREE.Vector3(), pq = new THREE.Quaternion(), sc = new THREE.Vector3();
    pm.decompose(ps, pq, sc);
    return {
      center: center, normal: normal,
      radius: Math.max(rad * Math.max(sc.x, sc.y, sc.z), 0.05)
    };
  }

  function gizmoProject(v, rect) {
    var p = v.clone().project(st.camera);
    return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
  }

  function worldPerPixelAt(worldPos) {
    var cam = st.camera, h = st.canvas.clientHeight || 1;
    if (!cam) return 0.01;
    if (cam.isPerspectiveCamera) {
      var d = Math.max(cam.position.distanceTo(worldPos), 1e-4);
      return 2 * d * Math.tan((cam.fov * Math.PI / 180) / 2) / h;
    }
    return ((cam.top - cam.bottom) / (cam.zoom || 1)) / h;
  }

  function updateExtrudeGizmo() {
    var SeedTools = global.SeedTools;
    var live = !!(SeedTools && SeedTools.isLive && SeedTools.isLive('tool.extrude'));
    if (!live) { if (st.extrudeGizmo) st.extrudeGizmo.group.visible = false; return; }
    /* 四视图的指针走分屏自己的交互，主视口的屏幕坐标不成立；先收起，回单视图再出现 */
    if (st.quad) { if (st.extrudeGizmo) st.extrudeGizmo.group.visible = false; return; }
    var fr = extrudeSelectionWorld();
    if (!fr || !st.camera || !st.canvas) { if (st.extrudeGizmo) st.extrudeGizmo.group.visible = false; return; }
    var g = ensureExtrudeGizmo();
    if (!g) return;
    var dist = liveParamValue('dist', 0.1);
    /* 箭头根部 = 顶面中心：厚度改多少，箭头就跟着走多少 */
    var base = fr.center.clone().addScaledVector(fr.normal, dist);
    var camD = st.camera.position.distanceTo(base);
    var S = Math.max(camD * 0.16, 0.05);
    g.group.visible = true;
    g.group.position.copy(base);
    g.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), fr.normal);
    g.group.scale.setScalar(S);
    /* 轴心方柄永远面向相机，转到侧面也能看见左右拖拽方向 */
    g.root.quaternion.copy(g.group.quaternion).invert().multiply(st.camera.quaternion);
    g.radius = fr.radius;
    var r = st.canvas.getBoundingClientRect();
    g.basePx = gizmoProject(base, r);
    /* 1.32 = 锥头尖端（杆 1.1 + 锥高 0.22）：命中线段要盖住看得见的箭头尖 */
    g.tipPx = gizmoProject(base.clone().addScaledVector(fr.normal, S * 1.32), r);
    g.wpp = worldPerPixelAt(base);
  }

  function extrudeGizmoHit(e) {
    var g = st.extrudeGizmo;
    if (!g || !g.group.visible || !g.basePx) return null;
    var r = st.canvas.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.sqrt((x - g.basePx.x) * (x - g.basePx.x) + (y - g.basePx.y) * (y - g.basePx.y)) <= 15) return 'root';
    var vx = g.tipPx.x - g.basePx.x, vy = g.tipPx.y - g.basePx.y;
    var len2 = vx * vx + vy * vy || 1;
    var t = ((x - g.basePx.x) * vx + (y - g.basePx.y) * vy) / len2;
    if (t < -0.05 || t > 1.05) return null;
    t = Math.max(0, Math.min(1, t));
    var px = g.basePx.x + vx * t, py = g.basePx.y + vy * t;
    return Math.sqrt((x - px) * (x - px) + (y - py) * (y - py)) <= 10 ? 'arrow' : null;
  }

  function beginExtrudeGizmoDrag(mode, e) {
    var g = st.extrudeGizmo;
    if (!g) return false;
    var ax = g.tipPx.x - g.basePx.x, ay = g.tipPx.y - g.basePx.y;
    var al = Math.sqrt(ax * ax + ay * ay) || 1;
    st.extrudeDrag = {
      mode: mode, x0: e.clientX, y0: e.clientY,
      dist0: liveParamValue('dist', 0.1),
      offset0: liveParamValue('offset', 0),
      axis: { x: ax / al, y: ay / al },
      wpp: g.wpp || 0.01, radius: g.radius || 0.5
    };
    st.canvas.style.cursor = mode === 'root' ? 'ew-resize' : 'grabbing';
    try { st.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    global.addEventListener('pointermove', onExtrudeGizmoMove, true);
    global.addEventListener('pointerup', onExtrudeGizmoUp, true);
    e.preventDefault();
    setStatus(mode === 'arrow'
      ? '挤出：沿箭头拖 = 厚度，Enter 提交'
      : '挤出：左右拖轴心方柄 = 顶面缩小 / 放大，Enter 提交');
    return true;
  }

  function onExtrudeGizmoMove(e) {
    var d = st.extrudeDrag;
    if (!d) return;
    e.preventDefault();
    var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    var patch, label;
    if (d.mode === 'arrow') {
      var along = dx * d.axis.x + dy * d.axis.y;
      var v = Math.max(-2, Math.min(2, d.dist0 + along * d.wpp));
      patch = { dist: Math.round(v * 1000) / 1000 };
      label = '厚度 ' + patch.dist.toFixed(2);
    } else {
      var v2 = Math.max(-2, Math.min(2, d.offset0 + dx * (d.radius / 180)));
      patch = { offset: Math.round(v2 * 1000) / 1000 };
      label = '顶面偏移 ' + patch.offset.toFixed(2);
    }
    if (global.SeedTools) global.SeedTools.drag({ params: patch });
    syncToolPanelInputs();
    setStatus('挤出：' + label + '（Enter 提交，Esc 取消）');
  }

  function onExtrudeGizmoUp() {
    if (!st.extrudeDrag) return;
    st.extrudeDrag = null;
    st.extrudeHover = null;
    st.pickDown = null;
    global.removeEventListener('pointermove', onExtrudeGizmoMove, true);
    global.removeEventListener('pointerup', onExtrudeGizmoUp, true);
    if (st.canvas) st.canvas.style.cursor = '';
  }

  /* 拖动箭头时把面板里的数字同步过去（不然手柄改了、输入框还停在旧值） */
  function syncToolPanelInputs() {
    var box = st.toolPanel, SeedTools = global.SeedTools;
    if (!box || !SeedTools || !SeedTools.isLive()) return;
    var list = SeedTools.listParams();
    var inputs = box.querySelectorAll('input[data-tp]');
    for (var i = 0; i < inputs.length; i++) {
      var p = list[+inputs[i].dataset.tp];
      if (!p || !isFinite(p.value) || document.activeElement === inputs[i]) continue;
      var v = Number(p.value);
      inputs[i].value = (v === Math.round(v)) ? String(v) : String(Math.round(v * 1000) / 1000);
    }
  }

  /* 撤销 / 重做只留转发：栈与网格副本都在 md-history.js 里 */
  function undo() { return HIST.undo(); }
  function redo() { return HIST.redo(); }

  /* ---------------- 变换（对象 / 组件共用一套回调） ---------------- */
  function gizmoOnComponents() {
    return !!(st.gizmo && st.compPivot && st.gizmo.target === st.compPivot);
  }

  function onTransformStart() {
    /* 组件：记下选中顶点的原始坐标 + 起始矩阵；对象：还是老一套 */
    if (gizmoOnComponents() && st.compIdx.length) {
      var idx = st.compIdx.slice();
      var base = new Float32Array(idx.length * 3);
      for (var k = 0; k < idx.length; k++) {
        var vi = idx[k];
        base[k * 3] = st.mesh.positions[vi * 3];
        base[k * 3 + 1] = st.mesh.positions[vi * 3 + 1];
        base[k * 3 + 2] = st.mesh.positions[vi * 3 + 2];
      }
      st.compPivot.updateMatrixWorld(true);
      st.compDrag = {
        idx: idx,
        base: base,
        m0: new THREE.Matrix4().copy(st.compPivot.matrixWorld),
        minv: new THREE.Matrix4().copy(st.pivot.matrixWorld).invert(),
        before: snap()
      };
      /* 软选择：给半径内的非选中顶点算权重（离选中点越远越接近 0） */
      if (st.soft.on) {
        var radius = Math.max(0.0001, Number(st.soft.size) / 100);
        var rr = radius * radius;
        var p = st.mesh.positions;
        var picked = Object.create(null);
        var centers = [];
        for (var s = 0; s < idx.length; s++) picked[idx[s]] = 1;
        for (var s2 = 0; s2 < idx.length; s2++) {
          var si = idx[s2] * 3;
          centers.push(p[si], p[si + 1], p[si + 2]);
        }
        var softIdx = [], softW = [], softBase = [];
        for (var v = 0; v < st.mesh.vertexIds.length; v++) {
          if (picked[v]) continue;
          var vx = p[v * 3], vy = p[v * 3 + 1], vz = p[v * 3 + 2];
          var best = Infinity;
          for (var c = 0; c < centers.length; c += 3) {
            var dx = vx - centers[c], dy = vy - centers[c + 1], dz = vz - centers[c + 2];
            var dd = dx * dx + dy * dy + dz * dz;
            if (dd < best) best = dd;
          }
          if (best > rr) continue;
          var w = softWeightAt(Math.sqrt(best) / radius);
          if (w <= 0.001) continue;
          softIdx.push(v); softW.push(w);
          softBase.push(vx, vy, vz);
        }
        st.compDrag.softIdx = softIdx;
        st.compDrag.softW = softW;
        st.compDrag.softBase = softBase;
      }
      st.txBefore = st.compDrag.before;
      return;
    }
    st.txBefore = snap();
  }

  function onTransformChange() {
    if (!st.doc || !st.pivot) return;
    if (st.compDrag) { applyCompDelta(); return; }
    if (!st.node) return;
    SeedModel.Scene.setNodeTransform(st.doc, st.node, st.pivot.position, st.pivot.quaternion, st.pivot.scale);
    updateHud();
  }

  function onTransformEnd(info) {
    if (!st.doc || !st.pivot) return;

    /* 组件变换：一次拖动 = 一条「组件变换」历史（before 是拖动前抓的快照） */
    if (st.compDrag) {
      var d = st.compDrag;
      st.compDrag = null;
      st.txBefore = null;
      if (!info || !info.changed) {
        st.compDrag = d;                 /* restoreCompBase 要用它 */
        restoreCompBase();
        st.compDrag = null;
        syncGizmo();
        setStatus('未移动（取消）');
        return;
      }
      SeedModel.Scene.revision(st.doc, 'mesh');
      var afterComp = snap();
      pushHistory(d.before, afterComp, '组件变换');
      rebuildModel(true);
      syncGizmo();
      setStatus('已变换 ' + d.idx.length + ' 个顶点' +
        (d.softIdx && d.softIdx.length ? '，软选择影响 ' + d.softIdx.length + ' 个' : ''));
      return;
    }

    if (!st.node) return;
    var before = st.txBefore;
    st.txBefore = null;
    if (!info || !info.changed) {
      applyNodeTransform(st.pivot);
      return;
    }
    SeedModel.Scene.revision(st.doc, 'transform');
    var after = snap();
    pushHistory(before, after, '变换');
    updateHud();
    updateChrome();
  }

  /* ---------------- 命名 / 输入 ---------------- */
  function onFocusIn(e) {
    if (!st.doc) return;
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    if (el.dataset.mdGlobal) {
      if (!st.editBefore) st.editBefore = snap();
    }
  }

  function applyName(el) {
    if (!st.doc) return;
    st.autoName = false;
    SeedModel.Scene.setName(st.doc, el.value);
    var n = $('mdName'); if (n) n.textContent = st.doc.name;
  }

  function onInput(e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    if (el.id === 'mdOutlineSearch') {
      st.outlineQuery = el.value;
      paintOutline();
      return;
    }
    if (el.id === 'mdSoftSize') {
      var sv = Number(el.value);
      if (isFinite(sv)) {
        st.soft.size = Math.max(0, Math.min(500, sv));
        if (st.soft.on) setStatus('软选择半径：' + st.soft.size.toFixed(2) + '（×1m）');
      }
      drawSoftCurve();
      return;
    }
    if (el.id === 'mdBrushSize') {
      st.paint.size = Math.max(6, Math.min(180, Math.round(Number(el.value) || 42)));
      var bsv = $('mdBrushSizeVal');
      if (bsv) bsv.textContent = st.paint.size + ' px';
      return;
    }
    if (el.id === 'mdBrushOpacity') {
      st.paint.opacity = Math.max(5, Math.min(100, Math.round(Number(el.value) || 90)));
      var bov = $('mdBrushOpacityVal');
      if (bov) bov.textContent = st.paint.opacity + '%';
      return;
    }
    if (el.id === 'mdBrushColor') {
      st.paint.color = el.value || '#d94f4f';
      return;
    }
    if (el.dataset.mdPsize != null) {
      st.prim.size[Number(el.dataset.mdPsize)] = Number(el.value);
      return;
    }
    if (el.dataset.mdPseg != null) {
      st.prim.seg = Math.max(6, Math.min(64, Math.round(Number(el.value) || 16)));
      return;
    }
    if (el.dataset.mdGlobal !== 'name') return;
    if (!st.editBefore) st.editBefore = snap();
    applyName(el);
  }

  function onKeyDown(e) {
    var el = e.target;
    if (!el || el.id !== 'mdCmd' || e.key !== 'Enter') return;
    var v = String(el.value || '').trim();
    el.value = '';
    if (!v) { setStatus('M1 命令行为占位，M3 起接入'); return; }
    /* M6a：命令行查同一张命令表（菜单 / Shelf / 工具箱 / 快捷键同源） */
    var SeedCommands = global.SeedCommands;
    if (SeedCommands) {
      var r = SeedCommands.run(v, {});
      if (r.ok) { setStatus('已执行：' + (SeedCommands.lookup(v) || {}).label || v); return; }
      if (r.reason === 'no-such-command') {
        /* 支持「id 参数」的写法（M6b 算子用） */
        var parts = v.split(/\s+/);
        var r2 = SeedCommands.run(parts[0], { args: parts.slice(1) });
        if (r2.ok) { setStatus('已执行：' + parts[0]); return; }
      }
      setStatus('命令不可用：' + v + (r.reason === 'not-available' ? '（当前上下文不满足）' : '（未注册）'), true);
      return;
    }
    setStatus(v ? '命令行「' + v + '」：M1 命令行为占位，M3 起接入' : 'M1 命令行为占位，M3 起接入');
  }

  /* ---------------- 快捷键层（S4） ---------------- */
  function deskOnTop() {
    var w = $('modelDeskWin');
    if (!w) return false;
    var r = w.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return false;
    var el = document.elementFromPoint(r.left + Math.min(60, r.width / 2), r.top + 12);
    return !!(el && w.contains(el));
  }

  function typingIn(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKeyLayer(e) {
    if (e.defaultPrevented || !st.doc || !st.uiReady) return;
    if (e.altKey) return;
    if (typingIn(e.target)) return;
    if (!deskOnTop()) return;
    var k = String(e.key || '').toLowerCase();

    if (e.ctrlKey || e.metaKey) {
      var hit = true;
      if (k === 'z') { if (!undo()) setStatus('没有可撤销的操作'); }
      else if (k === 'y') { if (!redo()) setStatus('没有可重做的操作'); }
      else if (k === 's') { save(); }
      else if (k === 'n') {
        if (st.history.undo.length && global.confirm && !global.confirm('新建会丢弃当前未保存的修改，继续？')) return;
        newDocument();
      }
      else if (k === 'o') { showOpenDialog(); }
      else if (k === 'd') { duplicateNode(); }
      else if (k === 'e') {
        /* Ctrl+E = 挤出（M6b）；有会话时先提交 */
        if (global.SeedTools && global.SeedTools.isLive()) commitTool();
        else beginTool('tool.extrude');
      }
      else if (k === 'r') {
        /* Ctrl+R = 环切（Blender 习惯）；边不通四边环时状态行说明原因 */
        var cutMsg = loopCutBlocked();
        if (cutMsg) setStatus(cutMsg, true);
        else beginTool('tool.loopcut');
      }
      else hit = false;
      if (hit) { e.preventDefault(); }
      return;
    }

    switch (k) {
      case 'f8': setSelMode('object'); break;
      case 'f9': setSelMode('vertex'); break;
      case 'f10': setSelMode('edge'); break;
      case 'f11': setSelMode('face'); break;
      case 'f12': setSelMode('island'); break;
      case 'q': setTool('select'); break;
      case 'k': setKnifeMode(); break;
      case 'w': setMode('translate'); break;
      case 'e': setMode('rotate'); break;
      case 'r': setMode('scale'); break;
      case 'delete':
      case 'backspace':
        /* 组件模式下 Del = 删选中组件（M6b）；对象模式还是删整个对象 */
        if (global.SeedTools && global.SeedTools.isLive()) { commitTool(); break; }
        if (st.selMode === 'face' || st.selMode === 'island') {
          if (st.sel.faceIds.length) { beginTool('tool.deleteFaces'); break; }
        }
        if (st.selMode === 'vertex' && st.sel.vertexIds.length) {
          beginTool('tool.mergeVertices');
          break;
        }
        deleteActiveNode();
        break;
      case 'h':
        toggleActiveVisible();
        break;
      case 'f':
      case 'a':
        frameCamera();
        setStatus(k === 'f' ? '已框显所选（F）' : '已框显全部（A）');
        break;
      case '`': {
        var c = $('mdCmd');
        if (c) { c.focus(); c.select(); }
        break;
      }
      case 'escape':
        /* M6a：有工具会话时先 cancel 它（Esc 无痕），再走原来的浮层/四视图；
         * V7：最大化时 Esc 只回四视图，不直接退出四视图。 */
        if (global.SeedTools && global.SeedTools.isLive()) { cancelTool(); break; }
        if (st.tool === 'knife') { setTool('select'); setStatus('已退出多切割'); break; }
        if (st.quadMax) exitQuadMax();
        else if (st.overlay && st.overlay.className.indexOf('on') >= 0) closeOverlay();
        else if (st.quad) setQuad(false);
        else return;
        break;
      case 'enter':
        /* M6b：工具会话中 Enter = 提交（松手即一条历史） */
        if (global.SeedTools && global.SeedTools.isLive()) { commitTool(); break; }
        return;
      case 'b':
        /* M6a 假工具（演示工具会话链路）；M6b 换成真算子 */
        if (global.SeedTools && global.SeedTools.isLive()) commitTool();
        else beginTool('tool.inflate');
        break;
      default: return;
    }
    e.preventDefault();
  }

  function onChange(e) {
    var el = e.target;
    if (!el) return;
    /* 修改器栈的参数：checkBox = 启用/停用，select/number = 参数本身。
     * 只在 change 上处理（input 会每敲一个字符重建一次面板，还会丢焦点）。 */
    if (el.dataset.mdModon != null) {
      modSetEnabled(Number(el.dataset.mdModon) || 0, !!el.checked);
      return;
    }
    if (el.dataset.mdModp != null) {
      var mv = el.type === 'number' ? Number(el.value) : el.value;
      if (el.type === 'number' && !isFinite(mv)) return;
      modSetParam(Number(el.dataset.mdModi) || 0, el.dataset.mdModp, mv);
      return;
    }
    if (el.id === 'mdBrushSel') {
      st.paint.brush = ['soft', 'hard', 'erase'].indexOf(el.value) >= 0 ? el.value : 'soft';
      var names = { soft: '圆形软笔', hard: '圆形硬笔', erase: '橡皮擦' };
      setStatus('笔刷：' + names[st.paint.brush] + ' · ' + st.paint.size + ' px');
      return;
    }
    if (el.id === 'mdPaintMask') {
      st.paint.mask = !!el.checked;
      setStatus(st.paint.mask
        ? 'UV 岛遮罩开：笔刷只画进落笔所在的 UV 岛'
        : 'UV 岛遮罩关：笔刷可画到整张贴图');
      return;
    }
    if (el.id === 'mdSoftOn') {
      st.soft.on = !!el.checked;
      paintSoftPanel();
      setStatus(st.soft.on ? '软选择开：拖动组件时会按曲线权重带动周围顶点' : '软选择关');
      return;
    }
    if (el.tagName === 'SELECT' && el.id === 'mdSoftFalloff') {
      st.soft.falloff = el.value;
      if (el.value === 'custom') ensureSoftCustom();
      paintSoftPanel();
      setStatus('软选择曲面：' + (SOFT_LABEL[el.value] || el.value));
      return;
    }
    if (el.tagName === 'SELECT' && el.id === 'mdShadeSel') {
      setShading(el.value);
      return;
    }
    if (el.dataset.mdSlotf) {
      var si = Number(el.dataset.mdSlot) || 0;
      if (el.dataset.mdSlotf === 'name') slotRename(si, el.value);
      else if (el.dataset.mdSlotf === 'color') slotSetColor(si, el.value);
      return;
    }
    if (el.tagName !== 'INPUT') return;
    if (el.dataset.mdGlobal !== 'name') return;
    applyName(el);
    var before = st.editBefore;
    st.editBefore = null;
    if (!before || !st.doc) return;
    pushHistory(before, snap(), '命名');
    paintAll();
  }

  function setShading(mode) {
    if (['shaded', 'wire', 'flat', 'uv'].indexOf(mode) < 0) mode = 'shaded-wire';
    st.shading = mode;
    applyShading();
    updateChrome();
    updateHud();
    setStatus('着色模式：' + shadeLabel(st.shading));
    /* UV 岛着色要有 UV 才分得出岛：没 UV 就说清楚，别让人以为是着色坏了 */
    if (mode === 'uv' && st.mesh) {
      var info = SeedModel.Mesh.uvIslands(st.mesh);
      if (!info.islands.length) {
        setStatus('UV 岛着色：该网格还没有 UV，整体按一个岛显示（先用 UV 编辑器做投影）', true);
      } else if (info.islands.length === 1) {
        setStatus('UV 岛着色：当前网格只有 1 个 UV 岛（1 个颜色）');
      }
    }
  }

  /* 工具与手柄模式是同一件事的两面：
   * 竖条上的 move/rotate/scale 决定手柄模式，工具行上的三个 chip 是同一命令的另一个入口。 */
  var TOOL_LABEL = { select: '选择', lasso: '套索', paint: '绘制选择', move: '移动', rotate: '旋转', scale: '缩放' };
  var TOOL_GIZMO = { move: 'translate', rotate: 'rotate', scale: 'scale' };
  var GIZMO_TOOL = { translate: 'move', rotate: 'rotate', scale: 'scale' };
  var MODE_LABEL = { translate: '移动', rotate: '旋转', scale: '缩放' };

  function setTool(tool) {
    if (!TOOL_LABEL[tool]) return;
    st.tool = tool;
    if (TOOL_GIZMO[tool]) {
      st.mode = TOOL_GIZMO[tool];
      if (st.gizmo) st.gizmo.setMode(st.mode);
    }
    updateChrome();
    var key = tool === 'move' ? 'W' : tool === 'rotate' ? 'E' : tool === 'scale' ? 'R' : tool === 'select' ? 'Q' : '';
    setStatus('工具：' + TOOL_LABEL[tool] + (key ? '（' + key + '）' : '') +
      (tool === 'select' ? ' · 按住拖动 = 框选' : tool === 'lasso' ? ' · 按住画一圈' : tool === 'paint' ? ' · 按住刷，Ctrl 刷掉' : ''));
  }

  /* 老入口（工具行的三个 chip、F8–F12 之前的 W/E/R）继续可用 */
  function setMode(mode) {
    if (!GIZMO_TOOL[mode]) return;
    setTool(GIZMO_TOOL[mode]);
  }

  /* ---------------- 软选择面板 ----------------
   * 衰减半径 = size% × 1m；曲线横轴 = 到选中点的距离（0~半径），纵轴 = 权重。
   * 曲线编辑只改权重形状；真正生效在组件手柄拖动时（见 applyCompDelta）。 */
  var SOFT_LABEL = { smooth: '平滑', linear: '线性', sharp: '锐利', sphere: '球体', constant: '常量', custom: '自定义' };

  function falloffWeight(kind, x) {
    x = Math.max(0, Math.min(1, x));
    if (kind === 'constant') return 1;
    if (kind === 'linear') return 1 - x;
    if (kind === 'sharp') { var a = 1 - x; return a * a * a; }
    if (kind === 'sphere') return Math.sqrt(Math.max(0, 1 - x * x));
    /* smooth：smoothstep 的反向 */
    return 1 - (x * x * (3 - 2 * x));
  }

  function customWeightAt(x) {
    var pts = st.soft.custom;
    if (!pts || !pts.length) return falloffWeight('smooth', x);
    var t = Math.max(0, Math.min(1, x)) * (pts.length - 1);
    var i = Math.floor(t), f = t - i;
    if (i >= pts.length - 1) return pts[pts.length - 1];
    return pts[i] * (1 - f) + pts[i + 1] * f;
  }

  function softWeightAt(x) {
    if (st.soft.falloff === 'custom') return customWeightAt(x);
    return falloffWeight(st.soft.falloff, x);
  }

  function ensureSoftCustom() {
    if (st.soft.custom && st.soft.custom.length === 9) return;
    var arr = [];
    for (var i = 0; i < 9; i++) arr.push(falloffWeight(st.soft.falloff === 'custom' ? 'smooth' : st.soft.falloff, i / 8));
    st.soft.custom = arr;
  }

  function drawSoftCurve() {
    var c = $('mdSoftCurve');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d');
    var W = c.width, H = c.height;
    var padX = 10, padY = 10;
    ctx.clearRect(0, 0, W, H);
    /* 网格 */
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    for (var g = 1; g < 4; g++) {
      var gy = padY + (H - padY * 2) * g / 4;
      ctx.beginPath(); ctx.moveTo(padX, gy); ctx.lineTo(W - padX, gy); ctx.stroke();
    }
    for (var gx = 1; gx < 4; gx++) {
      var gx2 = padX + (W - padX * 2) * gx / 4;
      ctx.beginPath(); ctx.moveTo(gx2, padY); ctx.lineTo(gx2, H - padY); ctx.stroke();
    }
    /* 曲线 + 填充 */
    var pts = [];
    for (var s = 0; s <= 48; s++) {
      var t = s / 48;
      pts.push([padX + t * (W - padX * 2), padY + (1 - softWeightAt(t)) * (H - padY * 2)]);
    }
    ctx.fillStyle = 'rgba(217,146,58,.12)';
    ctx.beginPath();
    ctx.moveTo(padX, H - padY);
    for (var f = 0; f < pts.length; f++) ctx.lineTo(pts[f][0], pts[f][1]);
    ctx.lineTo(W - padX, H - padY);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = st.soft.on ? '#e0a13a' : '#aab3bd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var p = 0; p < pts.length; p++) {
      if (p) ctx.lineTo(pts[p][0], pts[p][1]); else ctx.moveTo(pts[p][0], pts[p][1]);
    }
    ctx.stroke();
    /* 自定义曲线的控制点 */
    if (st.soft.falloff === 'custom') {
      ensureSoftCustom();
      for (var i = 0; i < 9; i++) {
        var cx = padX + (i / 8) * (W - padX * 2);
        var cy = padY + (1 - st.soft.custom[i]) * (H - padY * 2);
        ctx.fillStyle = i === st.softDrag ? '#f5c26b' : '#d8dde3';
        ctx.beginPath(); ctx.arc(cx, cy, i === st.softDrag ? 5 : 3.2, 0, Math.PI * 2); ctx.fill();
        if (i === st.softDrag) {
          ctx.strokeStyle = '#f5c26b'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
  }

  function paintSoftPanel() {
    var on = $('mdSoftOn');
    if (!on) return;
    var sel = $('mdSoftFalloff'), num = $('mdSoftSize'), badge = $('mdSoftState');
    on.checked = !!st.soft.on;
    if (sel && sel.value !== st.soft.falloff) sel.value = st.soft.falloff;
    if (num && document.activeElement !== num) num.value = Number(st.soft.size).toFixed(2);
    if (badge) {
      badge.textContent = st.soft.on ? '开' : '关';
      badge.classList.toggle('on', !!st.soft.on);
    }
    drawSoftCurve();
  }

  function resetSoftCurve() {
    st.soft.custom = null;
    st.soft.falloff = 'smooth';
    st.softDrag = -1;
    paintSoftPanel();
    setStatus('软选择曲线已重置为「平滑」');
  }

  function softCurvePoint(e) {
    var c = $('mdSoftCurve');
    if (!c) return null;
    var r = c.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var t = (e.clientX - r.left) / r.width;
    var w = 1 - (e.clientY - r.top) / r.height;
    return { t: Math.max(0, Math.min(1, t)), w: Math.max(0, Math.min(1, w)) };
  }

  function onSoftCurveDown(e) {
    var c = $('mdSoftCurve');
    if (!c || e.target !== c || e.button) return;
    var p = softCurvePoint(e);
    if (!p) return;
    ensureSoftCustom();
    if (st.soft.falloff !== 'custom') {
      var arr = [];
      for (var i = 0; i < 9; i++) arr.push(falloffWeight(st.soft.falloff, i / 8));
      st.soft.custom = arr;
      st.soft.falloff = 'custom';
    }
    st.softDrag = Math.max(0, Math.min(8, Math.round(p.t * 8)));
    st.soft.custom[st.softDrag] = p.w;
    try { c.setPointerCapture(e.pointerId); } catch (e2) {}
    paintSoftPanel();
    e.preventDefault();
  }

  function onSoftCurveMove(e) {
    if (st.softDrag < 0) return;
    var p = softCurvePoint(e);
    if (!p) return;
    st.soft.custom[st.softDrag] = p.w;
    drawSoftCurve();
    e.preventDefault();
  }

  function onSoftCurveUp() {
    if (st.softDrag < 0) return;
    st.softDrag = -1;
    drawSoftCurve();
  }

  function toggleSection(id) {
    var sec = document.querySelector('.md-sec2[data-md-sec="' + id + '"]');
    if (!sec) return;
    sec.classList.toggle('open');
  }

  /* ---------------- 工具箱入口 ---------------- */
  var TOOLBOX_TOOL = {
    extrude: 'tool.extrude', smooth: 'tool.smooth', bevel: 'tool.bevel', bridge: 'tool.bridge',
    segments: 'tool.subdivide', 'target-weld': 'tool.targetWeld', connect: 'tool.connect',
    'quad-draw': 'tool.quadDraw'
  };

  /* 一次性算子：开会话后立刻提交（预览只闪一帧，历史仍然只有一条） */
  function runToolNow(id) {
    if (global.SeedTools && global.SeedTools.isLive()) cancelTool();
    if (!beginTool(id)) return false;
    var r = commitTool();
    if (!r || !r.ok) {
      setStatus('算子没有提交成功（当前选择不满足条件）', true);
      return false;
    }
    return true;
  }

  function setKnifeMode() {
    st.tool = 'knife';
    st.gest = null;
    updateChrome();
    setStatus('多切割：在视口按住拖动一条线，松开后按视平面切开当前对象（Esc 退出）');
  }

  function runToolboxOp(op) {
    if (!st.doc || !st.mesh) { setStatus('先打开一个模型', true); return; }
    switch (op) {
      case 'join': joinSelectedNodes(); return;
      case 'separate': separateActiveNode(); return;
      case 'split-islands': splitSelectedIslands(); return;
      case 'boolean': booleanSelectedNodes(); return;
      case 'knife': setKnifeMode(); return;
      case 'loopcut':
        /* 环切是 live 工具：不自动提交，让条数 / 滑移在参数面板里反复预览 */
        var msg = loopCutBlocked();
        if (msg) { setStatus(msg, true); return; }
        beginTool('tool.loopcut');
        return;
      case 'tris-to-quads':
        trisToQuadsNow();
        return;
      case 'array':
        /* 阵列也是 live 工具（数量 / 间距可反复预览），别用 runToolNow 立刻提交 */
        if (beginTool('tool.array')) {
          setStatus('阵列：在参数面板调数量 / 间距看预览，Enter 提交，Esc 取消');
        }
        return;
      case 'subdivide-once':
        subdivideOnceNow();
        return;
      case 'dissolve':
        dissolveNow();
        return;
      case 'smooth':
        /* 平滑是整网格命令，不选点也能用 */
        if (runToolNow('tool.smooth')) setStatus('已平滑' + (selVertexIds().length ? '选中顶点' : '整个网格'));
        return;
      case 'extrude':
        /* 挤出是「工具」不是「一次性命令」：从货架 / 工具箱点进来要留下
         * polyExtrudeFace 参数面板（厚度 / 局部平移 Z / 偏移 / 分段 / 保持连续性），
         * 改参数实时预览，Enter 提交、Esc 取消。别用 runToolNow —— 它会立刻提交，
         * 面板只闪一帧（用户看不到）。 */
        if (beginTool('tool.extrude')) {
          setStatus('挤出：在参数面板调厚度 / 偏移 / 分段看预览，Enter 提交，Esc 取消');
        }
        return;
      default:
        if (TOOLBOX_TOOL[op]) {
          if (runToolNow(TOOLBOX_TOOL[op])) setStatus('已执行：' + op);
        }
        return;
    }
  }

  function setQuad(on) {
    on = !!on;
    if (!on) {
      /* 退出四视图时同时清掉最大化与半截手势，避免残留禁用控件 / 错误相机 */
      st.quadMax = null;
      st.quadDown = null;
      st.quadClick = null;
    }
    st.quad = on;
    if (st.stage) st.stage.classList.toggle('quad', st.quad);
    if (st.controls) st.controls.enabled = !st.quad;
    if (st.gizmo) st.gizmo.setTarget((st.quad || (st.isolate && !ISO.nodeVisible(st.node ? st.node.id : ''))) ? null : st.pivot);
    if (st.quad) {
      st.quadActive = 'front';
      updateQuadCameras(true);
    } else {
      resize();
    }
    syncQuadControls();
    updateQuadChrome();
    updateChrome();
    updateHud();
    setStatus(st.quad
      ? quadViewText() + '（Alt+左键环绕 / Alt+中键平移 / Alt+右键推拉，双击某格最大化）'
      : '已返回透视视图');
  }

  function toggleQuad() {
    if (!st.doc) return;
    setQuad(!st.quad);
  }

  /* ViewCube 拖拽 = 自己绕 controls.target 转球坐标，避免被 HTML 覆盖层吃掉
   * 画布的 OrbitControls 事件；单击（位移 < 3px）才切正视图。 */
  function tumbleBy(dx, dy) {
    if (!st.camera || !st.controls || !THREE) return;
    var off = st.camera.position.clone().sub(st.controls.target);
    var sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= dx * 0.007;
    sph.phi -= dy * 0.007;
    sph.phi = Math.max(0.08, Math.min(Math.PI - 0.08, sph.phi));
    off.setFromSpherical(sph);
    st.camera.position.copy(st.controls.target).add(off);
    st.camera.lookAt(st.controls.target);
    st.controls.update();
  }

  /* 立方体四边的三角：绕目标点一次翻 1/4 圈。
   * 走球坐标而不是拼像素：90° 的转身不管当前相机在哪都能落在正方向上，
   * 拖拽那种「按像素估角度」的做法转两次就会歪掉。 */
  var TURN_LABEL = { up: '向上', down: '向下', left: '向左', right: '向右' };
  function turnBy(kind) {
    if (!st.camera || !st.controls || !THREE || !TURN_LABEL[kind]) return;
    var off = st.camera.position.clone().sub(st.controls.target);
    var sph = new THREE.Spherical().setFromVector3(off);
    var step = Math.PI / 2;
    if (kind === 'left') sph.theta += step;
    else if (kind === 'right') sph.theta -= step;
    else if (kind === 'up') sph.phi -= step;
    else sph.phi += step;
    /* 顶 / 底是极点，上下和左右要分开处理：
     *   - 上下翻越过极点：把方位翻到对面、phi 折回 [0, π]，接着往上/下翻会落到对称的正视图
     *     （底视图再按「向下」→ 后视图）。落到极点时 theta 归零，否则 lookAt 时 up 会和视线
     *     平行、自己挑一个旋转角，出来就是「歪的顶视图」。
     *   - 顶 / 底视图里按左右：绝不能把 theta 归零——上一版就是这么写的，等于什么都没做，
     *     所以「到底视图后左、右按钮失效」。这里保留 theta，phi 压在极点上，
     *     效果是画面原地转 90°（和 Maya 在极点按左右一致）。 */
    if (kind === 'up' || kind === 'down') {
      if (sph.phi < 0) { sph.phi = -sph.phi; sph.theta += Math.PI; }
      else if (sph.phi > Math.PI) { sph.phi = Math.PI * 2 - sph.phi; sph.theta += Math.PI; }
      if (sph.phi <= 0.0005) { sph.phi = 0.0005; sph.theta = 0; }
      else if (sph.phi >= Math.PI - 0.0005) { sph.phi = Math.PI - 0.0005; sph.theta = 0; }
    } else {
      if (sph.phi <= 0.0005) sph.phi = 0.0005;
      else if (sph.phi >= Math.PI - 0.0005) sph.phi = Math.PI - 0.0005;
    }
    /* 先摆正 up 再摆位置：上一帧若是顶/底视图，up 会被 lookAt 修正过，
     * 不清掉的话下一次环绕会绕着歪轴转 */
    st.camera.up.set(0, 1, 0);
    var pos = new THREE.Vector3().setFromSpherical(sph);
    st.camera.position.copy(st.controls.target).add(pos);
    st.camera.lookAt(st.controls.target);
    st.controls.update();
    /* 90° 转身的结果又落在轴上：按轴叫名字，别一律写「自由」 */
    var n = pos.normalize();
    var ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    var axis = Math.max(ax, ay, az) > 0.999
      ? (ay >= ax && ay >= az ? (n.y > 0 ? 'top' : 'bottom')
        : ax >= az ? (n.x > 0 ? 'right' : 'left')
          : (n.z > 0 ? 'front' : 'back'))
      : '';
    st.viewName = axis ? VP_LABEL[axis] : '自由';
    updateChrome();
    updateHud();
    setStatus(axis ? '视图：' + st.viewName : '视图已' + TURN_LABEL[kind] + '翻转 90°');
  }

  var VP_LABEL = { front: '前视图', back: '后视图', left: '左视图', right: '右视图', top: '顶视图', bottom: '底视图', iso: '轴测' };
  function viewFromPreset(kind) {
    if (!st.doc || !st.pivot || !st.camera || !st.controls || !THREE) return;
    if (st.quad) setQuad(false);
    st.pivot.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(st.pivot);
    if (box.isEmpty()) return;
    var sphere = box.getBoundingSphere(new THREE.Sphere());
    var center = sphere.center.clone();
    var r = Math.max(sphere.radius, 0.2);
    var d = r * 3;
    var dirs = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      /* 顶 / 底视图给一点点 Z 偏移，避免 lookAt 时视线与 up 完全平行 */
      top: [0, 1, 0.0001],
      bottom: [0, -1, 0.0001],
      iso: [0.6, 0.45, 0.9]
    };
    var dir = dirs[kind] || dirs.iso;
    var v = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    st.camera.near = Math.max(r / 100, 0.001);
    st.camera.far = Math.max(r * 50, 100);
    st.camera.up.set(0, 1, 0);
    st.camera.position.copy(center).add(v.multiplyScalar(d));
    st.controls.target.copy(center);
    st.camera.lookAt(center);
    st.camera.updateProjectionMatrix();
    st.controls.update();
    st.viewName = VP_LABEL[kind] || '透视';
    updateChrome();
    updateHud();
    setStatus('视图：' + st.viewName);
  }

  /* ---------------- ViewCube（已拆到 js/md-viewcube.js） ---------------- */
  /* 外壳只留两个门面：bind（初始化 + 绑指针）/ draw（每帧跟相机重画）。 */
  var CUBE = global.MDViewCube.create({
    st: st, THREE: THREE, $: $,
    updateChrome: updateChrome, updateHud: updateHud, setStatus: setStatus,
    turnBy: turnBy, tumbleBy: tumbleBy, viewFromPreset: viewFromPreset
  });
  function bindCube() { return CUBE.bind(); }
  function drawCube() { return CUBE.draw(); }

  /* ================= 主菜单条（📁 编辑…） =================
   * 之前这七个按钮只 setStatus 一句「在 M5 接入」—— 点了等于没反应。
   * 这里改成真的下拉菜单：每条都指向已经存在的命令（不外挂新的行为），
   * 撤销 / 重做在栈空时灰显，避免「点了还是没变化」。 */
  var MD_MENUS = [
    { k: '文件', items: [
      { t: '新建场景', c: 'new', s: 'Ctrl+N' },
      { t: '打开资产…', c: 'open', s: 'Ctrl+O' },
      { t: '保存 GLB', c: 'save', s: 'Ctrl+S' },
      { sep: 1 },
      { t: '关闭建模窗口', c: 'closeWin' }
    ] },
    { k: '编辑', items: [
      { t: '撤销', c: 'undo', s: 'Ctrl+Z', off: function () { return !st.history.undo.length; } },
      { t: '重做', c: 'redo', s: 'Ctrl+Y', off: function () { return !st.history.redo.length; } },
      { sep: 1 },
      { t: '复制对象', c: 'dup', s: 'Ctrl+D' },
      { t: '删除对象', c: 'del', s: 'Del' },
      { t: '隐藏 / 显示对象', c: 'hide', s: 'H' }
    ] },
    { k: '创建', items: [
      { t: '立方体…', c: 'prim:box' },
      { t: '球体…', c: 'prim:sphere' },
      { t: '圆柱…', c: 'prim:cylinder' },
      { t: '圆锥…', c: 'prim:cone' },
      { t: '圆环…', c: 'prim:torus' },
      { t: '平面…', c: 'prim:plane' }
    ] },
    { k: '修改', items: [
      { t: '移动工具', c: 'modeTranslate', s: 'W' },
      { t: '旋转工具', c: 'modeRotate', s: 'E' },
      { t: '缩放工具', c: 'modeScale', s: 'R' },
      { sep: 1 },
      { t: '切换世界 / 局部坐标', c: 'space' },
      { t: '吸附', c: 'snap' },
      { sep: 1 },
      { t: '合并选中顶点', c: 'mergeVertices' }
    ] },
    { k: '显示', items: [
      { t: '四视图', c: 'quad' },
      { sep: 1 },
      { t: '着色：实体 + 线框', c: 'shade:shaded-wire' },
      { t: '着色：实体', c: 'shade:shaded' },
      { t: '着色：线框', c: 'shade:wire' },
      { t: '着色：平涂', c: 'shade:flat' },
      { t: '着色：UV 岛着色', c: 'shade:uv' },
      { sep: 1 },
      { t: '显示 / 隐藏栅格', c: 'grid' },
      { t: '单独显示所选（隔离）', c: 'isolate' },
      { t: '框显所选 / 全部', c: 'frameAll', s: 'F' },
      { t: '材质槽（3D 查看器）', c: 'tex' }
    ] },
    { k: '窗口', items: [
      { t: 'UV 编辑器', c: 'uv' },
      { t: '投射烘焙…', c: 'projbake' },
      { t: '材质槽', c: 'tex' },
      { sep: 1 },
      { t: '内容浏览器', c: 'dock' },
      { t: '右侧：属性面板', c: 'tabProps' },
      { t: '右侧：通道盒', c: 'tabChannels' },
      { sep: 1 },
      { t: '关闭 UV 编辑器', c: 'uvClose' }
    ] },
    { k: '帮助', items: [
      { t: '快捷键与操作说明', c: 'help' },
      { t: '关于本版本', c: 'about' }
    ] }
  ];

  function mdCloseMenu() {
    var drop = $('mdDrop');
    if (drop) { drop.hidden = true; drop.innerHTML = ''; }
    st.menu = null;
    var items = document.querySelectorAll('.md-mitem.open');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('open');
  }

  function mdOpenMenu(key, btn) {
    var drop = $('mdDrop');
    if (!drop || !btn) return;
    if (st.menu === key) { mdCloseMenu(); return; }
    var spec = null, i;
    for (i = 0; i < MD_MENUS.length; i++) if (MD_MENUS[i].k === key) spec = MD_MENUS[i];
    if (!spec) return;
    var html = '<div class="md-mtitle">' + esc(key) + '</div>';
    spec.items.forEach(function (it) {
      if (it.sep) { html += '<i class="md-msep"></i>'; return; }
      var off = !!(it.off && it.off());
      html += '<button type="button" class="md-mi' + (off ? ' off' : '') + '" data-mdcmd="' + esc(it.c) + '">' +
        '<span>' + esc(it.t) + '</span><b>' + esc(it.s || '') + '</b></button>';
    });
    drop.innerHTML = html;
    drop.hidden = false;
    /* 夹在菜单条宽度内，靠右的「帮助」菜单不会溢出窗口 */
    var menu = document.querySelector('.md-menu'), mr = menu.getBoundingClientRect(), br = btn.getBoundingClientRect();
    var left = br.left - mr.left;
    var maxLeft = mr.width - drop.offsetWidth - 4;
    drop.style.left = Math.max(4, Math.min(left, maxLeft)) + 'px';
    drop.style.top = (br.bottom - mr.top) + 'px';
    st.menu = key;
    var all = document.querySelectorAll('.md-mitem');
    for (i = 0; i < all.length; i++) all[i].classList.remove('open');
    btn.classList.add('open');
  }

  function mdRun(c) {
    mdCloseMenu();
    var m;
    if ((m = /^prim:(\w+)$/.exec(c))) { openPrimitiveDialog(m[1]); return; }
    if ((m = /^shade:(.+)$/.exec(c))) { setShading(m[1]); return; }
    switch (c) {
      case 'new': clickAct('new'); break;
      case 'open': clickAct('open'); break;
      case 'save': clickAct('save'); break;
      case 'undo': clickAct('undo'); break;
      case 'redo': clickAct('redo'); break;
      case 'snap': clickAct('snap'); break;
      case 'grid': clickAct('grid'); break;
      case 'quad': clickAct('quad'); break;
      case 'uv': clickAct('uv'); break;
      case 'projbake': openProjBake(); break;
      case 'tex': clickAct('tex'); break;
      case 'dup': duplicateNode(); break;
      case 'del': deleteActiveNode(); break;
      case 'hide': toggleActiveVisible(); break;
      case 'modeTranslate': setMode('translate'); break;
      case 'modeRotate': setMode('rotate'); break;
      case 'modeScale': setMode('scale'); break;
      case 'space': {
        st.space = st.space === 'world' ? 'local' : 'world';
        if (st.gizmo) st.gizmo.setSpace(st.space);
        updateChrome();
        setStatus('坐标系：' + (st.space === 'local' ? '局部' : '世界'));
        break;
      }
      case 'mergeVertices': runOp('mesh.mergeVertices'); break;
      case 'frameAll': frameCamera(); setStatus('已框显（F）'); break;
      case 'isolate': toggleIsolate(); break;
      case 'dock': setDock(!st.dockOpen); break;
      /* 属性编辑器现在是右侧第三个页签：这两个命令还得把页签切过去，否则面板仍是隐藏的 */
      case 'tabProps': setTbKind('props'); st.rightTab = 'props'; paintParams(); updateChrome(); setStatus('右侧：属性面板'); break;
      case 'tabChannels': setTbKind('props'); st.rightTab = 'channels'; paintParams(); updateChrome(); setStatus('右侧：通道盒'); break;
      case 'uvClose':
        if (!st.uv.open) { setStatus('UV 编辑器没有打开', true); break; }
        closeUVEditor(); setStatus('UV 编辑器已关闭');
        break;
      case 'help': setStatus('W/E/R 移动/旋转/缩放 · F 框显 · H 隐藏 · F8–F12 对象/点/边/面/UV 岛 · Ctrl+Z/Y 撤销/重做 · Alt+左/中/右键 环绕/平移/推拉 · 空格 热盒'); break;
      case 'about': setStatus('The seed 建模 · MVP-1 · 桌面式建模工作台（UV 编辑器 / 拓扑算子 / 四视图已可用）'); break;
      case 'closeWin': {
        var cb = $('btnModelDeskWinClose');
        if (cb) cb.click();
        break;
      }
      default: break;
    }
  }

  /* 复用工具条 / 视图角标上已经存在的按钮：菜单和它们必须是同一条命令，不另写一份实现 */
  function clickAct(act) {
    var b = document.querySelector('[data-md-act="' + act + '"]');
    if (b) { b.click(); return; }
    setStatus('命令「' + act + '」当前不可用', true);
  }

  function onClick(e) {
    var t = e.target;
    /* 按钮里有 SVG / span 时，e.target 是那个子节点 —— 必须往上找按钮，
     * 否则「点图标」永远点不到（竖条那六个工具按钮就踩过这个坑）。 */
    if (t && t.tagName !== 'BUTTON' && t.closest) t = t.closest('button');
    if (!t || t.tagName !== 'BUTTON') return;
    if (t.dataset.mdTbk) {
      setTbKind(t.dataset.mdTbk);
      updateChrome();
      return;
    }
    if (t.dataset.mdcmd) {
      mdRun(t.dataset.mdcmd);
      return;
    }
    if (t.dataset.mdTab) {
      st.rightTab = t.dataset.mdTab === 'channels' ? 'channels' : 'props';
      paintParams();
      return;
    }
    if (t.dataset.mdMenu) {
      mdOpenMenu(t.dataset.mdMenu, t);
      return;
    }
    var act = t.dataset.mdAct;
    if (t.dataset.mdMode) {
      setMode(t.dataset.mdMode);
      return;
    }
    if (t.dataset.mdSpace) {
      st.space = st.space === 'world' ? 'local' : 'world';
      if (st.gizmo) st.gizmo.setSpace(st.space);
      updateChrome();
      return;
    }
    if (t.dataset.mdTool) {
      setTool(t.dataset.mdTool);
      return;
    }
    if (t.dataset.mdSelmode) {
      setSelMode(t.dataset.mdSelmode);
      return;
    }
    if (t.dataset.mdTbtab) {
      /* 两个页签就是「对象模式 / 上次的组件模式」，不是两套面板 */
      setSelMode(t.dataset.mdTbtab === 'object' ? 'object' : (st.lastCompMode || 'face'));
      return;
    }
    if (t.dataset.mdPrim) {
      openPrimitiveDialog(t.dataset.mdPrim);
      return;
    }
    if (t.dataset.mdNode != null) {
      /* B2b：点行 = 换激活对象，不只是高亮；Ctrl/Shift 追加多选（结合/布尔用） */
      selectNodeById(String(t.dataset.mdNode), e && (e.shiftKey || e.ctrlKey || e.metaKey));
      return;
    }
    if (t.dataset.mdSectoggle) {
      toggleSection(t.dataset.mdSectoggle);
      return;
    }
    if (t.dataset.mdDock) {
      /* refresh 必须先展开：收起状态的按钮是隐藏的，这里只是兜底 */
      if (t.dataset.mdDock === 'refresh') { setDock(true); return; }
      setDock(!st.dockOpen);
      return;
    }
    if (t.dataset.mdCbPlace) {
      placeAsset(t.dataset.mdCbPlace);
      return;
    }
    if (t.dataset.mdCbOpen) {
      openAssetById(t.dataset.mdCbOpen);
      return;
    }
    if (t.dataset.mdSoftreset) {
      resetSoftCurve();
      return;
    }
    if (t.dataset.mdOp) {
      runToolboxOp(t.dataset.mdOp);
      return;
    }
    if (!act) return;
    switch (act) {
      case 'slot-add': slotAdd(); break;
      case 'slot-del': slotDelete(Number(t.dataset.mdSlot) || 0); break;
      case 'slot-assign': slotAssignFaces(Number(t.dataset.mdSlot) || 0); break;
      case 'new': newDocument(); break;
      case 'open': showOpenDialog(); break;
      case 'save': save(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'snap': {
        st.snap = !st.snap;
        if (st.gizmo) st.gizmo.setSnap(st.snap);
        if (global.SeedSnap) global.SeedSnap.setEnabled(st.snap);
        updateChrome();
        var sp = global.SeedSnap ? global.SeedSnap.getPrefs() : { move: 0.05, rotate: 15, scale: 0.1 };
        setStatus(st.snap
          ? ('吸附开：平移 ' + sp.move + ' m / 旋转 ' + sp.rotate + '° / 缩放 ' + sp.scale)
          : '吸附关');
        break;
      }
      case 'grid':
        if (global.SeedViewFlags) {
          global.SeedViewFlags.toggle('grid');
        } else {
          st.showGrid = !st.showGrid;
          if (st.gridHelper) st.gridHelper.visible = st.showGrid;
          updateChrome();
        }
        setStatus(st.showGrid ? '视图栅格已显示' : '视图栅格已隐藏');
        break;
      case 'shade-cycle': {
        var order = ['shaded-wire', 'shaded', 'wire'];
        var next = order[(order.indexOf(st.shading) + 1) % order.length];
        setShading(next);
        break;
      }
      case 'quad': toggleQuad(); break;
      case 'isolate': toggleIsolate(); break;
      case 'uv': openUVEditor(); break;
      case 'projbake': openProjBake(); break;
      case 'tex': openTextureEditor(); break;
      case 'prim-create': createPrimitive(); break;
      case 'close-overlay': closeOverlay(); break;
      /* 修改器栈（属性编辑器）：添加 / 排序 / 删除 / 应用 */
      case 'mod-add': modAdd(t.dataset.mdMod); break;
      case 'mod-del': modDelete(Number(t.dataset.mdModi) || 0); break;
      case 'mod-up': modMove(Number(t.dataset.mdModi) || 0, -1); break;
      case 'mod-down': modMove(Number(t.dataset.mdModi) || 0, 1); break;
      case 'mod-apply': modApply(); break;
      default: break;
    }
  }

  /* ---------------- 热盒（Maya 的 marking menu） ----------------
   * 按住空格弹出，鼠标移到哪条就高亮，松开空格执行那一条。
   * 原则：**只放真实可用的命令** —— 热盒是最容易被做成装饰的地方，
   * 每一项都必须是 F8–F12 / 工具条 / 显示菜单上已经有的同一个命令。 */
  /* off = 占位：灰色不可执行，点一下只在状态行说明「还没接入」+ 计划表编号。
   * 这样热盒能先把 Maya 的结构摆出来，又不会让人以为点了会生效。 */
  /* 行图标：Maya 每一行左边有个小图标。这里用同一套 12px 内联 SVG，按语义挑一个。 */
  var HB_ICONS = {
    cube: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2 13.5 5v6L8 14 2.5 11V5z" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 5 8 8l5.5-3M8 8v6" stroke="currentColor" stroke-width=".8"/></svg>',
    vert: '<svg viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" stroke="currentColor" stroke-width="1"/><g fill="#d98b3f"><rect x="2" y="2" width="3" height="3"/><rect x="11" y="2" width="3" height="3"/><rect x="2" y="11" width="3" height="3"/><rect x="11" y="11" width="3" height="3"/></g></svg>',
    edge: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2 14 8 8 14 2 8z" stroke="currentColor" stroke-width="1"/><path d="M8 2 14 8" stroke="#d98b3f" stroke-width="2"/></svg>',
    face: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2 13.5 5v6L8 14 2.5 11V5z" stroke="currentColor" stroke-width="1"/><path d="M8 8l5.5-3v6L8 14z" fill="#d98b3f"/></svg>',
    island: '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" stroke-dasharray="2 1.6" stroke-width="1"/><g fill="currentColor"><circle cx="6" cy="6" r=".9"/><circle cx="10" cy="6" r=".9"/><circle cx="6" cy="10" r=".9"/><circle cx="10" cy="10" r=".9"/></g></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="8" height="8" stroke="currentColor" stroke-width="1"/><path d="M5.5 13.5h8v-8" stroke="currentColor" stroke-width="1"/></svg>',
    del: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8" stroke="currentColor" stroke-width="1"/></svg>',
    eye: '<svg viewBox="0 0 16 16" fill="none"><path d="M1.8 8s2.3-3.6 6.2-3.6S14.2 8 14.2 8s-2.3 3.6-6.2 3.6S1.8 8 1.8 8z" stroke="currentColor" stroke-width="1"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
    group: '<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" stroke="currentColor" stroke-width="1"/><rect x="9" y="9" width="5" height="5" stroke="currentColor" stroke-width="1"/><path d="M7 4.5h2.5v2.5M9 11.5H6.5V9" stroke="currentColor" stroke-width=".9"/></svg>',
    tool: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1"/><path d="m6 4 2-2 2 2M6 12l2 2 2-2M4 6l-2 2 2 2M12 6l2 2-2 2" stroke="currentColor" stroke-width=".9"/></svg>',
    view: '<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" stroke="currentColor" stroke-width="1"/><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width=".8" stroke-dasharray="1.5 1.2"/></svg>',
    undo: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 7.5h6a3.5 3.5 0 1 1 0 7H6" stroke="currentColor" stroke-width="1"/><path d="m6 4.5-3 3 3 3" stroke="currentColor" stroke-width="1"/></svg>',
    redo: '<svg viewBox="0 0 16 16" fill="none"><path d="M12.5 7.5h-6a3.5 3.5 0 1 0 0 7H10" stroke="currentColor" stroke-width="1"/><path d="m10 4.5 3 3-3 3" stroke="currentColor" stroke-width="1"/></svg>'
  };

  /* 一项 = 图标 + 名字 + 右侧小方框。方框点击 → 进这个工具的参数面板（Maya 的 option box）。 */
  function hbItem(label, hint, run, isOn, off, note, keepOpen, opt) {
    var o = opt || {};
    return {
      label: label, hint: hint || '', run: run, isOn: !!isOn, off: !!off, note: note || '',
      keepOpen: !!keepOpen, icon: o.icon || 'cube', panel: o.panel || null
    };
  }
  function hbTodo(label, note, icon, panel) {
    return hbItem(label, '占位', null, false, true, note, false, { icon: icon, panel: panel });
  }

  /* 热盒点「挤出/内插/删除面/合并顶点」时走命令表（与命令行/快捷键同源） */
  function runOp(id) {
    var C = global.SeedCommands;
    if (!C) return;
    var r = C.run(id, {});
    if (!r.ok) setStatus('「' + id + '」当前不可用（' + (r.reason || '') + '）', true);
  }

  /* 四个区里，**右侧是「当前模式的专属操作」**：对象模式给对象操作、面模式给拓扑操作、
   * 顶点/边/UV 岛各给各自的那一套。这正是 Maya 热盒的做法 —— 显示的是「现在能干什么」，
   * 而不是把全软件的菜单一次铺在屏幕上。没有实现的动作仍然是灰的占位（带计划编号）。 */
  /* 各工具的参数表（Maya 的 option box 内容）。已接入的用真参数，未接入的灰显 + 计划编号。 */
  var HB_PANEL = {
    copy: function () {
      return hbPanelSpec('复制对象', [
        { key: 'count', label: '数量', value: 1, min: 1, max: 20, step: 1 },
        { key: 'offset', label: '偏移 (m)', value: 0.4, min: 0, max: 2, step: 0.05 }
      ], function (v) { dupNodes(v.count, v.offset); }, '沿对象自身 X 轴依次错开。');
    },
    extrude: function () {
      return hbPanelSpec('挤出', [
        { key: 'dist', label: '厚度', value: 0.1, min: -2, max: 2, step: 0.01 },
        { key: 'localZ', label: '局部平移 Z', value: 0, min: -2, max: 2, step: 0.01 },
        { key: 'offset', label: '偏移', value: 0, min: -2, max: 2, step: 0.01 },
        { key: 'divisions', label: '分段', value: 1, min: 1, max: 8, step: 1 }
      ], function (v) {
        var patch = { dist: v.dist, localZ: v.localZ, offset: v.offset, divisions: v.divisions };
        if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams(patch);
        else {
          beginTool('tool.extrude');
          if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams(patch);
        }
      }, '保持面的连续性在工具属性面板里切换；Enter 提交、Esc 取消。');
    },
    inset: function () {
      return hbPanelSpec('内插', [
        { key: 'thick', label: '厚度', value: 0.2, min: 0, max: 0.95, step: 0.01 }
      ], function (v) {
        if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ thick: v.thick });
        else { beginTool('tool.inset'); if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ thick: v.thick }); }
      }, '向质心缩一圈新边，中间留出内插面。');
    },
    bevel: function () {
      return hbPanelSpec('倒角', [
        { key: 'width', label: '宽度', value: 0.08, min: 0.001, max: 0.45, step: 0.005 },
        { key: 'depth', label: '深度 (m)', value: 0, min: -0.5, max: 0.5, step: 0.01 },
        { key: 'seg', label: '分段', value: 1, min: 1, max: 4, step: 1 }
      ], function (v) {
        if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ width: v.width, depth: v.depth, seg: v.seg });
        else {
          beginTool('tool.bevel');
          if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ width: v.width, depth: v.depth, seg: v.seg });
        }
      }, '面倒角：选中面内缩成环并沿法线偏移；改参数后 Enter 提交。');
    },
    loopcut: function () {
      return hbPanelSpec('环切', [
        { key: 'count', label: '条数', value: 1, min: 1, max: 8, step: 1 },
        { key: 'slide', label: '滑移', value: 0, min: -1, max: 1, step: 0.01 }
      ], function (v) {
        var msg = loopCutBlocked();
        if (msg) { setStatus(msg, true); return; }
        if (global.SeedTools && global.SeedTools.isLive('tool.loopcut')) {
          global.SeedTools.setParams({ count: v.count, slide: v.slide });
        } else {
          beginTool('tool.loopcut');
          if (global.SeedTools && global.SeedTools.isLive('tool.loopcut')) {
            global.SeedTools.setParams({ count: v.count, slide: v.slide });
          }
        }
      }, '沿选中边所在的四边环切分；条数 / 滑移实时预览，Enter 提交。');
    },
    bridge: function () {
      return hbPanelSpec('桥接', [
        { key: 'seg', label: '分段', value: 1, min: 1, max: 8, step: 1 }
      ], function (v) {
        if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ segments: v.seg });
        else {
          beginTool('tool.bridge');
          if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ segments: v.seg });
        }
      }, '桥接两个同边数的面；分段 = 中间插几圈；Enter 提交。');
    },
    merge: function () {
      return hbPanelSpec('合并顶点', [
        { key: 'thr', label: '阈值 (m)', value: 0, min: 0, max: 1, step: 0.005 }
      ], function (v) {
        if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ thr: v.thr });
        else { beginTool('tool.mergeVertices'); if (global.SeedTools && global.SeedTools.isLive()) global.SeedTools.setParams({ thr: v.thr }); }
      }, '把选中顶点焊到质心；阈值 > 0 时顺带焊掉邻近点。');
    },
    soft: function () {
      return hbPanelSpec('软选择', [
        { key: 'size', label: '半径 (%)', value: st.soft.size, min: 0, max: 500, step: 0.01 }
      ], function (v) {
        st.soft.size = v.size;
        paintSoftPanel();
      }, '开 / 关在右侧工具箱「软选择」里；拖组件手柄时按衰减曲线带动周围顶点。');
    },
    uv: function (title, a, b) {
      return hbPanelSpec(title, [
        { key: 'a', label: a, value: 0, min: 0, max: 1, off: true },
        { key: 'b', label: b, value: 0, min: 0, max: 1, off: true }
      ], null, '分离 UV 壳尚未接入（计划表 X5g）；展开 / 排布 / 缝合已在 UV 编辑器里可用。');
    }
  };

  function hbCtxObject() {
    return [
      hbItem('复制对象', 'Ctrl+D', function () { duplicateNode(); }, false, false, '', false, { icon: 'copy', panel: HB_PANEL.copy() }),
      hbItem('删除对象', 'Del', function () { deleteActiveNode(); }, false, false, '', false, { icon: 'del', panel: hbPanelSpec('删除对象', [], null, '删掉当前对象；网格没人引用时自动回收。') }),
      hbItem(st.node && st.node.visible === false ? '显示对象' : '隐藏对象', 'H', function () { toggleActiveVisible(); }, false, false, '', false, { icon: 'eye', panel: hbPanelSpec('隐藏 / 显示', [], null, '隐藏只影响视口显示，不写几何。') }),
      hbTodo('分组', 'B6', 'group', hbPanelSpec('分组', [{ key: 'n', label: '组名', value: 0, min: 0, max: 1, step: 1, off: true }], null, '分组尚未接入（计划表 B6）。')),
      hbTodo('父子', 'B2b', 'group', hbPanelSpec('父子关系', [], null, '层级尚未接入（计划表 B2b）。')),
      hbTodo('隔离', 'B6', 'eye', hbPanelSpec('隔离显示', [], null, '隔离尚未接入（计划表 B6）。'))
    ];
  }

  function hbCtxVertex() {
    return [
      hbItem('移动工具', 'W', function () { setTool('move'); }, st.tool === 'move', false, '', false, { icon: 'tool', panel: hbPanelSpec('移动工具', [{ key: 'snap', label: '吸附步长', value: 0.05, min: 0, max: 1, off: true }], null, '步长配置随 P6 设置页接入。') }),
      hbItem('合并顶点', '', function () { runOp('mesh.mergeVertices'); }, false, false, '', false, { icon: 'vert', panel: HB_PANEL.merge() }),
      hbItem('目标焊接', '', function () { runOp('mesh.targetWeld'); }, false, false, '', false, { icon: 'vert', panel: hbPanelSpec('目标焊接', [], null, '选中若干源点，最后点中的点作为目标；Enter 提交。') }),
      hbItem('连接', '', function () { runOp('mesh.connect'); }, false, false, '', false, { icon: 'edge', panel: hbPanelSpec('连接', [], null, '选中两个顶点，在共有面上沿连线切开；Enter 提交。') }),
      hbItem('四边形绘制', '', function () { runOp('mesh.quadDraw'); }, false, false, '', false, { icon: 'face', panel: hbPanelSpec('四边形绘制', [], null, '按选择顺序用 4 个顶点生成一个四边形面。') }),
      hbItem('删除顶点', 'Del', function () { runOp('mesh.deleteFaces'); }, false, false, '', false, { icon: 'del', panel: hbPanelSpec('删除顶点', [], null, '删除选中顶点及其相邻面。') }),
      hbItem(st.soft.on ? '软选择 (开)' : '软选择 (关)', '', function () {
        st.soft.on = !st.soft.on;
        paintSoftPanel();
        setStatus(st.soft.on ? '软选择开' : '软选择关');
      }, st.soft.on, false, '', false, { icon: 'vert', panel: HB_PANEL.soft() })
    ];
  }

  function hbCtxEdge() {
    return [
      hbItem('移动工具', 'W', function () { setTool('move'); }, st.tool === 'move', false, '', false, { icon: 'tool', panel: hbPanelSpec('移动工具', [{ key: 'snap', label: '吸附步长', value: 0.05, min: 0, max: 1, off: true }], null, '步长配置随 P6 设置页接入。') }),
      hbItem('循环边', '双击', function () { selectEdgeLoopFromSelection(false); }, false, false, '', false, { icon: 'edge', panel: hbPanelSpec('循环边', [], null, '在边模式双击一条边即可选中整圈（四边面上按对边行走）。') }),
      hbItem('环切', 'Ctrl+R', function () {
        var msg = loopCutBlocked();
        if (msg) { setStatus(msg, true); return; }
        beginTool('tool.loopcut');
      }, false, false, '', false, { icon: 'edge', panel: HB_PANEL.loopcut() }),
      hbTodo('倒角', 'A12', 'edge', hbPanelSpec('倒角', [], null, '边倒角尚未接入；请用面倒角（面模式）。')),
      hbTodo('桥接', 'A12', 'edge', hbPanelSpec('桥接', [], null, '边桥接尚未接入；请用面桥接（选中两个面）。')),
      hbTodo('删除边', 'B4', 'del', hbPanelSpec('删除边', [], null, '算子尚未接入（计划表 B4）。'))
    ];
  }

  function hbCtxFace() {
    return [
      hbItem('移动工具', 'W', function () { setTool('move'); }, st.tool === 'move', false, '', false, { icon: 'tool', panel: hbPanelSpec('移动工具', [{ key: 'snap', label: '吸附步长', value: 0.05, min: 0, max: 1, off: true }], null, '步长配置随 P6 设置页接入。') }),
      hbItem('挤出', 'Ctrl+E', function () { runOp('mesh.extrude'); }, false, false, '', false, { icon: 'face', panel: HB_PANEL.extrude() }),
      hbItem('内插', '', function () { runOp('mesh.inset'); }, false, false, '', false, { icon: 'face', panel: HB_PANEL.inset() }),
      hbItem('倒角', '', function () { runOp('mesh.bevel'); }, false, false, '', false, { icon: 'face', panel: HB_PANEL.bevel() }),
      hbItem('桥接', '', function () { runOp('mesh.bridge'); }, false, false, '', false, { icon: 'face', panel: HB_PANEL.bridge() }),
      hbItem('添加分段', '', function () { runOp('mesh.subdivide'); }, false, false, '', false, { icon: 'face', panel: hbPanelSpec('添加分段', [], null, '把选中面切四份；Enter 提交。') }),
      hbItem('三角转四边', '', function () { runOp('mesh.trisToQuads'); }, false, false, '', false,
        { icon: 'face', panel: hbPanelSpec('三角转四边', [], null, '成对共边的三角并成四边面；UV 接缝 / 折叠处保持三角，面数不减少时会提示。') }),
      hbItem('删除面', 'Del', function () { runOp('mesh.deleteFaces'); }, false, false, '', false, { icon: 'del', panel: hbPanelSpec('删除面', [{ key: 'clean', label: '清理孤立点 (0/1)', value: 1, min: 0, max: 1, step: 1 }], null, '删掉选中的面，可选清理孤立顶点。') })
    ];
  }

  function hbCtxIsland() {
    return [
      hbItem('材质槽', '', function () { openTextureEditor(); }, false, false, '', false, { icon: 'view', panel: hbPanelSpec('材质槽 / 贴图', [], null, '在 3D 查看器里设置贴图（已接入）。') }),
      hbItem('展开', '', function () { openUVEditor(); uvCommand('unwrap'); }, false, false, '', false,
        { icon: 'island', panel: hbPanelSpec('展开 UV', [], null, '打开 UV 编辑器并按壳的主平面拍平，然后装箱到 0–1。') }),
      hbItem('排布', '', function () { openUVEditor(); uvCommand('pack'); }, false, false, '', false,
        { icon: 'island', panel: hbPanelSpec('排布 UV', [], null, '货架装箱：按壳高度排序后从左到右摆进 0–1，间距 2%。') }),
      hbTodo('分离', 'X5g', 'island', HB_PANEL.uv('分离 UV', '缝隙', '—')),
      hbItem('缝合', '', function () { openUVEditor(); uvCommand('stitch'); }, false, false, '', false,
        { icon: 'island', panel: hbPanelSpec('缝合 UV', [], null, '把 2% 容差内的选中 UV 点并到平均位置；先在 UV 编辑器里选点。') }),
      hbItem('投影', '', function () { openUVEditor(); uvCommand('projBox'); }, false, false, '', false,
        { icon: 'island', panel: hbPanelSpec('UV 投影', [], null, '盒式投影：按面法线主轴分到 6 个 tile，重新生成 UV。') })
    ];
  }

  var HB_CTX = {
    object: { title: '对象操作', items: hbCtxObject },
    vertex: { title: '顶点操作', items: hbCtxVertex },
    edge: { title: '边操作', items: hbCtxEdge },
    face: { title: '面操作', items: hbCtxFace },
    island: { title: 'UV 岛操作', items: hbCtxIsland }
  };

  function hotboxZones() {
    var ctx = HB_CTX[st.selMode] || HB_CTX.object;
    return [
      { k: 'n', title: '组件模式', items: [
        hbItem('对象', 'F8', function () { switchHbMode('object'); }, st.selMode === 'object', false, '', true),
        hbItem('顶点', 'F9', function () { switchHbMode('vertex'); }, st.selMode === 'vertex', false, '', true),
        hbItem('边', 'F10', function () { switchHbMode('edge'); }, st.selMode === 'edge', false, '', true),
        hbItem('面', 'F11', function () { switchHbMode('face'); }, st.selMode === 'face', false, '', true),
        hbItem('UV 岛', 'F12', function () { switchHbMode('island'); }, st.selMode === 'island', false, '', true)
      ] },
      { k: 'e', title: ctx.title, items: ctx.items() },
      { k: 's', title: '工具', items: [
        hbItem('选择', 'Q', function () { setTool('select'); }, st.tool === 'select'),
        hbItem('套索', '', function () { setTool('lasso'); }, st.tool === 'lasso'),
        hbItem('绘制选择', '', function () { setTool('paint'); }, st.tool === 'paint'),
        hbItem('多切割', 'K', function () { setKnifeMode(); }, st.tool === 'knife'),
        hbItem('移动', 'W', function () { setTool('move'); }, st.tool === 'move'),
        hbItem('旋转', 'E', function () { setTool('rotate'); }, st.tool === 'rotate'),
        hbItem('缩放', 'R', function () { setTool('scale'); }, st.tool === 'scale')
      ] },
      { k: 'w', title: '显示 / 编辑', items: [
        hbItem('实体 + 线框', '', function () { setShading('shaded-wire'); }, st.shading === 'shaded-wire'),
        hbItem('实体', '', function () { setShading('shaded'); }, st.shading === 'shaded'),
        hbItem('线框', '', function () { setShading('wire'); }, st.shading === 'wire'),
        hbItem('平涂', '', function () { setShading('flat'); }, st.shading === 'flat'),
        hbItem('UV 岛着色', '', function () { setShading('uv'); }, st.shading === 'uv'),
        hbItem('四视图', '', function () { toggleQuad(); }, st.quad),
        hbItem('撤销', 'Ctrl+Z', function () { undo(); }),
        hbItem('重做', 'Ctrl+Y', function () { redo(); })
      ] },
      { k: 'c', title: '热盒', core: true }
    ];
  }

  /* 在热盒里切模式：不关闭热盒，直接换成新模式的那一层（这就是「自动切换显示层」） */
  function switchHbMode(mode) {
    setSelMode(mode);
    if (st.hbOpen) openHotbox();
  }

  function hotboxHtml() {
    return hotboxZones().map(function (z) {
      if (z.core) {
        return '<div class="md-hb-core"><span>' + (SEL_NOUN[st.selMode] || '对象') + '</span>' +
          '<i>按住空格 · 松开执行</i></div>';
      }
      var items = z.items.map(function (it, i) {
        var cls = it.off ? 'off' : (it.isOn ? 'on' : '');
        return '<div class="md-hb-row' + (cls ? ' ' + cls : '') + '">' +
          '<button type="button" class="md-hb-run" data-hb="' + z.k + ':' + i + '" title="' + (it.off ? '尚未接入' : (it.hint || it.label)) + '">' +
            '<i class="md-hb-ico">' + (HB_ICONS[it.icon] || HB_ICONS.cube) + '</i>' +
            '<span>' + it.label + '</span>' +
            (it.hint ? '<em>' + it.hint + '</em>' : '') +
          '</button>' +
          '<button type="button" class="md-hb-opt" data-opt="' + z.k + ':' + i + '" title="' + it.label + ' 的选项">□</button>' +
        '</div>';
      }).join('');
      return '<div class="md-hb-zone md-hb-' + z.k + '"><b>' + z.title + '</b>' + items + '</div>';
    }).join('');
  }

  function openHotbox() {
    var box = $('mdHotbox'), host = $('modelDeskHost');
    if (!box || !host || !st.doc) return;
    st.hbZones = hotboxZones();
    box.innerHTML = hotboxHtml();
    var size = 484;
    var px = st.pointer.x || (global.innerWidth / 2);
    var py = st.pointer.y || (global.innerHeight / 2);
    box.style.left = Math.min(Math.max(8, px - size / 2), Math.max(8, global.innerWidth - size - 8)) + 'px';
    box.style.top = Math.min(Math.max(8, py - size / 2), Math.max(8, global.innerHeight - size - 8)) + 'px';
    box.classList.add('on');
    st.hbOpen = true;
    st.hbHover = null;
    Array.prototype.forEach.call(box.querySelectorAll('[data-hb]'), function (btn) {
      var parts = btn.dataset.hb.split(':');
      var zone = st.hbZones[zoneIndex(parts[0])];
      var item = zone && zone.items ? zone.items[Number(parts[1])] : null;
      btn.addEventListener('mouseenter', function () {
        Array.prototype.forEach.call(box.querySelectorAll('[data-hb]'), function (b) { b.classList.remove('hover'); });
        btn.classList.add('hover');
        st.hbHover = item;
      });
      btn.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!item) { closeHotbox(); return; }
        if (item.off) {
          closeHotbox();
          setStatus('「' + item.label + '」尚未接入（计划表 ' + item.note + '）', true);
          st.hbHover = null;
          return;
        }
        /* 切模式不关热盒：直接换成新模式的那一层，正好演示「按当前模式切换显示层」 */
        if (item.keepOpen) { st.hbHover = null; item.run(); return; }
        closeHotbox();
        st.hbHover = null;
        if (item.run) item.run();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-opt]'), function (opt) {
      opt.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var parts = opt.dataset.opt.split(':');
        var zone = st.hbZones[zoneIndex(parts[0])];
        var item = zone && zone.items ? zone.items[Number(parts[1])] : null;
        var at = opt.getBoundingClientRect();
        st.pointer.x = at.left;
        st.pointer.y = at.top;
        closeHotbox();               /* 先收热盒，再弹参数面板（Maya 也是这个顺序） */
        if (item) openHbPanel(item);
      });
    });
  }

  function zoneIndex(k) {
    for (var i = 0; i < st.hbZones.length; i++) if (st.hbZones[i].k === k) return i;
    return 0;
  }

  /* 参数面板（Maya 的 option box）：标题 + 若干可调项 + 应用/关闭。
   * 没接入的算子也照样弹面板 —— 参数项灰显并注明计划编号，这是「先做占位」的落点。 */
  function hbPanelSpec(title, fields, apply, note) {
    return { title: title, fields: fields || [], apply: apply || null, note: note || '' };
  }

  function openHbPanel(item) {
    closeHbPanel();
    var spec = item.panel || hbPanelSpec(item.label, [], null, '该命令没有可调参数。');
    var fields = spec.fields.map(function (f, i) {
      return '<label class="md-hbp-row"><span>' + f.label + '</span>' +
        '<input type="number" data-hbp="' + i + '" value="' + (f.value != null ? f.value : 0) + '"' +
        (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') +
        ' step="' + (f.step != null ? f.step : 0.05) + '"' + (f.off ? ' disabled' : '') + '></label>';
    }).join('');
    var box = document.createElement('div');
    box.className = 'md-hbp';
    box.id = 'mdHbPanel';
    box.innerHTML =
      '<div class="md-hbp-h"><b>' + spec.title + '</b><button type="button" data-hbp-act="close">×</button></div>' +
      '<div class="md-hbp-b">' + (fields || '<div class="md-hbp-note">该命令没有可调参数。</div>') +
        (spec.note ? '<div class="md-hbp-note">' + spec.note + '</div>' : '') + '</div>' +
      '<div class="md-hbp-f"><button type="button" class="md-hbp-apply" data-hbp-act="apply"' + (spec.apply ? '' : ' disabled') + '>应用</button></div>';
    var px = Math.min(Math.max(12, st.pointer.x + 24), global.innerWidth - 268);
    var py = Math.min(Math.max(12, st.pointer.y - 40), global.innerHeight - 220);
    box.style.left = px + 'px';
    box.style.top = py + 'px';
    document.body.appendChild(box);
    st.hbPanel = box;
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button') : ev.target;
      if (!b) return;
      var act = b.dataset.hbpAct;
      if (act === 'close') { closeHbPanel(); return; }
      if (act !== 'apply' || !spec.apply) return;
      var vals = {};
      spec.fields.forEach(function (f, i) {
        var el = box.querySelector('[data-hbp="' + i + '"]');
        vals[f.key] = el ? Number(el.value) : f.value;
      });
      closeHbPanel();
      spec.apply(vals);
    });
  }

  function closeHbPanel() {
    if (st.hbPanel && st.hbPanel.parentNode) st.hbPanel.parentNode.removeChild(st.hbPanel);
    st.hbPanel = null;
  }

  function closeHotbox() {
    closeHbPanel();
    var box = $('mdHotbox');
    if (box) { box.classList.remove('on'); box.innerHTML = ''; }
    st.hbOpen = false;
  }

  function onSpaceDown(e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.repeat || st.hbOpen) return;
    if (!st.doc || !st.uiReady || typingIn(e.target) || !deskOnTop()) return;
    e.preventDefault();
    openHotbox();
  }

  function onSpaceUp(e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (!st.hbOpen) return;
    e.preventDefault();
    var item = st.hbHover;
    closeHotbox();
    st.hbHover = null;
    if (item && item.off) setStatus('「' + item.label + '」尚未接入（计划表 ' + item.note + '）', true);
    else if (item && item.run) item.run();
  }

  /* ---------------- 对象级编辑 / 算子（已拆到 js/md-objops.js） ----------------
   * 复制 / 删除 / 隐藏 / 结合 / 分离 / 布尔共用一条 docEdit 流水线：
   * 抓快照 → 改文档 → 重建视口 → 记一条历史。
   * 外壳保留同名门面，快捷键 / 热盒 / 菜单的调用点一行都不用改。 */
  var OBJOPS = global.MDObjOps.create({
    st: st, THREE: THREE,
    SeedModel: global.SeedModel, SeedOps: global.SeedOps,
    snap: snap, pushHistory: pushHistory, rebuildModel: rebuildModel,
    paintAll: paintAll, paintSelection: paintSelection,
    syncSelectionDoc: syncSelectionDoc, syncGizmo: syncGizmo,
    modsBlockComponents: modsBlockComponents,
    setStatus: setStatus
  });
  function docEdit(label, fn) { return OBJOPS.docEdit(label, fn); }
  function duplicateNode() { return OBJOPS.duplicateNode(); }
  function dupNodes(count, offset) { return OBJOPS.dupNodes(count, offset); }
  function deleteActiveNode() { return OBJOPS.deleteActiveNode(); }
  function joinSelectedNodes() { return OBJOPS.joinSelectedNodes(); }
  function separateActiveNode() { return OBJOPS.separateActiveNode(); }
  function splitSelectedIslands() { return OBJOPS.splitSelectedIslands(); }
  function booleanSelectedNodes() { return OBJOPS.booleanSelectedNodes(); }
  function toggleActiveVisible() { return OBJOPS.toggleActiveVisible(); }

  function toggleGrid() {
    if (global.SeedViewFlags) {
      global.SeedViewFlags.toggle('grid');
      setStatus(st.showGrid ? '视图栅格已显示' : '视图栅格已隐藏');
      return;
    }
    st.showGrid = !st.showGrid;
    if (st.gridHelper) st.gridHelper.visible = st.showGrid;
    updateChrome();
    setStatus(st.showGrid ? '视图栅格已显示' : '视图栅格已隐藏');
  }

  /* ---------------- 新建 / 打开 ---------------- */  /* ---------------- 新建 / 打开 ---------------- */
  /* M1 新建资产 = 一个立方体（通用建模软件的默认起点），
   * 不经过参数化 spec：Mesh.fromBufferGeometry 焊接后就是一张连通的 8 点 / 12 面网格。 */
  function newDocument() {
    var id = genId();
    var geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
    var mesh = SeedModel.Mesh.fromBufferGeometry(geo, { slot: 0, weld: true });
    geo.dispose();

    releaseView();
    st.autoName = true;
    st.isolate = false;        /* 换文档就退出单独显示，别让旧状态把新场景藏起来 */
    st.prim = { shape: 'box', size: [1, 1, 1], seg: 16 };
    st.doc = SeedModel.Scene.createDoc({
      assetId: id,
      name: '立方体',
      mesh: mesh,
      materials: { slotNames: ['默认材质'], slotColors: ['#c9ccd4'], textureConfigKey: id },
      historyBoundary: { historyResetReason: 'new' }
    });
    st.node = SeedModel.Scene.nodeOf(st.doc);
    st.nodeIds = st.node ? [st.node.id] : [];
    st.selMode = 'object';
    st.sel = { vertexIds: [], edgeIds: [], faceIds: [] };
    st.selected = 0;
    st.editBefore = null;
    st.txBefore = null;
    rebuildModel(false);
    if (st.gizmo) { st.gizmo.setMode(st.mode); st.gizmo.setSpace(st.space); st.gizmo.setSnap(st.snap); }
    clearHistory('new');
    paintAll();
    setStatus('已新建立方体网格（资产 id ' + st.doc.assetId + '）');
    return st.doc;
  }

  /* ---------------- 基础体（M5） ----------------
   * 面板只做三件事：选形状、填尺寸、按创建。
   * 几何一律走 Modeler.geometryOf（与 parts 共用同一张 SHAPES 表，语义不会走样），
   * 落文档一律走 applyMesh —— 所以「新建球体」也是一次可撤销的编辑，不是不可逆操作。 */
  var PRIM = {
    box:      { name: '立方体', size: [1, 1, 1],       labels: ['宽', '高', '深'],          seg: false },
    sphere:   { name: '球体',   size: [0.5, 0.5, 0.5], labels: ['半径X', '半径Y', '半径Z'], seg: true },
    cylinder: { name: '圆柱',   size: [0.5, 1, 0.5],   labels: ['上半径', '高', '下半径'],   seg: true },
    cone:     { name: '圆锥',   size: [0.5, 1, 0],     labels: ['底半径', '高', '—'],       seg: true },
    torus:    { name: '圆环',   size: [0.35, 0.12, 0], labels: ['主半径', '管半径', '—'],   seg: true },
    plane:    { name: '平面',   size: [1, 1, 0],       labels: ['宽', '高', '—'],           seg: false }
  };

  /* 名字还是「系统起的」吗？只靠一个布尔标记不够：改名后又撤销，
   * 文档名回到默认值、标记却已经翻成 false，新建基础体就不会跟着改名了。
   * 所以再叠一条「当前名就是某个基础体默认名」的判据。 */
  var AUTO_NAMES = { '立方体': 1, '未命名模型': 1, '球体': 1, '圆柱': 1, '圆锥': 1, '圆环': 1, '平面': 1 };
  function nameIsAuto() {
    return !!(st.doc && AUTO_NAMES[st.doc.name]);
  }

  function primDialogHtml() {
    var p = st.prim, meta = PRIM[p.shape];
    var tabs = Object.keys(PRIM).map(function (k) {
      return '<button type="button" class="md-prim-tab' + (k === p.shape ? ' on' : '') +
        '" data-md-prim="' + k + '">' + PRIM[k].name + '</button>';
    }).join('');
    var fields = [0, 1, 2].map(function (i) {
      var off = meta.labels[i] === '—';
      return '<label class="md-pf"><span>' + meta.labels[i] + '</span>' +
        '<input type="number" step="0.05" min="0.01" data-md-psize="' + i + '"' +
        ' value="' + p.size[i] + '"' + (off ? ' disabled' : '') + '></label>';
    }).join('');
    /* 段数放进同一行网格里（第 4 格），否则它会独占一行拉满宽度，看起来像两种控件 */
    var segCell = meta.seg
      ? '<label class="md-pf"><span>段数</span><input type="number" min="6" max="64" step="1" data-md-pseg value="' + p.seg + '"></label>'
      : '<label class="md-pf"><span>段数</span><input type="number" value="—" disabled></label>';
    return [
      '<div class="md-ov-head"><b>新建基础体</b>',
      '<span class="md-ov-sub">几何走 Modeler 同一张表 · 尺寸单位：米</span>',
      '<button type="button" class="md-ov-x" data-md-act="close-overlay">×</button></div>',
      '<div class="md-ov-body"><div class="md-prim">',
      '<div class="md-prim-tabs">' + tabs + '</div>',
      '<div class="md-prim-fields">' + fields + segCell + '</div>',
      '<button type="button" class="md-wide md-prim-go" data-md-act="prim-create">创建' + meta.name + '</button>',
      '<div class="md-note">会<strong>新增一个对象</strong>并记一条历史（Ctrl+Z 退回），不再替换当前对象；' +
      '新对象按已有数量沿 X 排开并自动成为激活对象。段数越高越圆滑，面数上限 1 万。</div>',
      '</div></div>'
    ].join('');
  }

  function openPrimitiveDialog(shape) {
    if (!st.doc) return;
    if (shape && PRIM[shape] && st.prim.shape !== shape) {
      st.prim.shape = shape;
      st.prim.size = PRIM[shape].size.slice();
    }
    overlayShow(primDialogHtml(), 'prim');
    var first = st.overlay.querySelector('[data-md-psize="0"]:not([disabled])');
    if (first) { try { first.focus(); first.select(); } catch (e) {} }
  }

  /* shape 可显式指定（测试 / 菜单直接建）；不传就用面板当前选中的那个。
   * ⚠ 别再让调用方「先 openPrimitive(shape) 再 createPrimitive()」——
   * 那条路只在面板打开时才改 st.prim.shape，直接调 API 会建出默认立方体。 */
  function createPrimitive(shape) {
    if (shape && PRIM[shape]) {
      st.prim.shape = shape;
      st.prim.size = PRIM[shape].size.slice();
    }
    var p = st.prim, meta = PRIM[p.shape];
    var btns = st.overlay ? st.overlay.querySelectorAll('[data-md-act="prim-create"]') : [];
    btns.forEach(function (b) { b.disabled = true; b.textContent = '生成中…'; });

    var bad = [0, 1, 2].some(function (i) {
      return meta.labels[i] !== '—' && !(Number(p.size[i]) > 0);
    });
    if (bad) {
      setStatus('尺寸必须是正数', true);
      btns.forEach(function (b) { b.disabled = false; b.textContent = '创建' + meta.name; });
      return false;
    }
    if (!global.Modeler || typeof global.Modeler.geometryOf !== 'function') {
      setStatus('Modeler 未加载，无法生成基础体', true);
      return false;
    }
    var mesh;
    var geo = null;
    try {
      geo = global.Modeler.geometryOf(p.shape, p.size, p.seg);
      mesh = SeedModel.Mesh.fromBufferGeometry(geo, { slot: 0, weld: true });
    } catch (e) {
      setStatus('生成失败：' + ((e && e.message) || e), true);
      btns.forEach(function (b) { b.disabled = false; b.textContent = '创建' + meta.name; });
      return false;
    } finally {
      if (geo && geo.dispose) geo.dispose();
    }
    if (!mesh) { setStatus('网格构建失败', true); return false; }
    /* 把新网格先登记进历史模块的副本表，否则 snap() 不会存它的指纹、撤销回不到几何 */
    ensureMeshCopy(mesh);
    var auto = st.autoName || nameIsAuto();
    var ok = docEdit('新建' + meta.name, function () {
      /* 多对象：新建 = 追加一个节点，而不是替换当前对象的网格。
       * 位置按已有对象数沿 X 排开，否则新球体会整个躲进旧立方体里、看着像没加成功。 */
      var at = SeedModel.Scene.nodesOf(st.doc).length;
      var node = SeedModel.Scene.addMeshNode(st.doc, {
        name: meta.name,
        mesh: mesh,
        transform: { position: [at * 1.2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
      });
      if (!node) return false;
      SeedModel.Scene.setActiveNode(st.doc, node.id);
      if (auto) {
        /* 只在「文档还没名字」时才连文档一起改；否则只改节点名，
         * 免得每个新对象都把文档名冲掉（对象名撞了会被 Scene 加「副本 N」） */
        if (!st.doc.name || AUTO_NAMES[st.doc.name]) SeedModel.Scene.setName(st.doc, meta.name);
        else node.name = meta.name;
      }
      st.autoName = false;
      return true;
    });
    closeOverlay();
    if (!ok) { setStatus('新建失败', true); return false; }
    setStatus('已新建' + meta.name + '（' + SeedModel.Mesh.stats(mesh).faces + ' 面 · 共 ' +
      SeedModel.Scene.nodesOf(st.doc).length + ' 个对象，Ctrl+Z 可撤销）');
    paintAll();
    return true;
  }

  function texConfigExists(key) {
    if (!key) return false;
    try {
      var all = JSON.parse(global.localStorage.getItem(TEX_KEY) || '{}');
      return !!(all[key] && Object.keys(all[key]).length);
    } catch (e) { return false; }
  }

  /* 普通 GLB / OBJ（模型库、Tripo 等外部产物）：没有 seedModel，就地把几何烘成可编辑网格。
   * 世界变换烘进顶点，节点变换保持单位阵；材质按对象取一个槽，颜色跟着进 slotColors（不导入贴图）。
   *
   * 同一个物体常被导出器拆成多块**同名**网格（16 位索引 65535 顶点上限、或按材质拆 primitive）。
   * 直接「一个 Mesh 一个节点」会让大纲里出现两个 Body，移动一个只带动半个身体。
   * 所以先按「名字 + 材质槽」分组：同组碎片拼成一份几何再 weld（共享边并点、跨块合并四边形）
   * 成一个节点；不同材质仍分开（合并会把面槽揉乱）；合起来超面数上限时退回分块，
   * 免得整份资产因为超限而导不进来。 */
  function triCountOf(geo) {
    if (!geo) return 0;
    var index = geo.getIndex ? geo.getIndex() : null;
    var pos = geo.getAttribute ? geo.getAttribute('position') : null;
    return index ? Math.floor(index.count / 3) : (pos ? Math.floor(pos.count / 3) : 0);
  }

  /* clone 后烘矩阵：Model3D 的缓存里几何是共享的，直接 applyMatrix4 会污染缓存 */
  function bakeImportGeometry(o) {
    var geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    return geo;
  }

  /* 碎片拼成一份非索引几何：只留 position / uv，法线由 SeedMesh 重算（导入本来就不认原法线）。 */
  function concatImportGeometries(geos) {
    var flat = [], temp = [];
    geos.forEach(function (g) {
      if (g.index && typeof g.toNonIndexed === 'function') {
        var ng = g.toNonIndexed();
        flat.push(ng);
        temp.push(ng);
      } else {
        flat.push(g);
      }
    });
    var total = 0, hasUv = false;
    flat.forEach(function (g) {
      total += g.getAttribute('position').count;
      if (g.getAttribute('uv')) hasUv = true;
    });
    var pos = new Float32Array(total * 3);
    var uv = hasUv ? new Float32Array(total * 2) : null;
    var off = 0;
    flat.forEach(function (g) {
      var p = g.getAttribute('position');
      for (var i = 0; i < p.count; i++) {
        pos[(off + i) * 3] = p.getX(i);
        pos[(off + i) * 3 + 1] = p.getY(i);
        pos[(off + i) * 3 + 2] = p.getZ(i);
      }
      /* 缺 UV 的碎片补 0：不能让 uvs 数组和面角数量对不上 */
      var t = g.getAttribute('uv');
      if (uv && t) {
        for (var k = 0; k < t.count; k++) {
          uv[(off + k) * 2] = t.getX(k);
          uv[(off + k) * 2 + 1] = t.getY(k);
        }
      }
      off += p.count;
    });
    temp.forEach(function (g) { g.dispose(); });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  }

  /* 把材质上的基础色贴图压成 data URL：导入模型只有贴图没有槽色时，
   * 不抽这一张就只能看到一片灰。上限 1024，够看清颜色又不至于把文档撑爆。 */
  function textureDataURL(tex) {
    return new Promise(function (resolve) {
      var img = tex && tex.image;
      var w = img && (img.width || img.videoWidth);
      var h = img && (img.height || img.videoHeight);
      if (!w || !h) return resolve('');
      var scale = Math.min(1, 1024 / Math.max(w, h));
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * scale));
      cv.height = Math.max(1, Math.round(h * scale));
      var ctx = cv.getContext('2d');
      try {
        /* glTF / FBX 的贴图约定 v=0 在图片顶部（flipY=false），而 TextureLoader 默认
         * 当成底部。这里在编码时就把图像上下翻过来，读取端沿用默认 flipY 才不会上下颠倒。 */
        if (tex.flipY === false) {
          ctx.translate(0, cv.height);
          ctx.scale(1, -1);
        }
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        /* 跨域贴图会 taint canvas，抽不出来就退回槽色 */
        resolve('');
      }
    });
  }

  async function importPlainModel(src, name) {
    var m3 = global.Model3D;
    if (!m3 || typeof m3.load !== 'function') throw new Error('3D 解析器未就绪，无法导入');
    var model;
    try { model = await m3.load(src); }
    catch (e) { throw new Error('模型解析失败：' + ((e && e.message) || e)); }
    var root = model.root;
    root.updateMatrixWorld(true);

    var parts = [];
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      if (typeof o.geometry.getAttribute !== 'function' || !o.geometry.getAttribute('position')) return;
      parts.push(o);
    });
    if (!parts.length) throw new Error('这个模型里没有可编辑的网格');

    var slotNames = [], slotColors = [], slotKeys = [], slotMats = [];
    function slotOf(mat) {
      var nm = (mat && mat.name) || '默认材质';
      var col = (mat && mat.color && mat.color.isColor) ? '#' + mat.color.getHexString() : '#c9ccd4';
      var key = nm + '|' + col;
      var i = slotKeys.indexOf(key);
      if (i < 0) {
        i = slotKeys.length;
        slotKeys.push(key);
        slotNames.push(nm);
        slotColors.push(col);
        slotMats.push(mat);
      }
      return i;
    }

    /* 先按「网格名 + 材质槽」分组：同名同材质的碎片是同一个物体被导出器拆开的。
     * GLTFLoader 会给重名节点自动加 _1 / _2 后缀（three 的 createUniqueName），
     * 所以名字要先剥掉这层后缀再比 —— 否则 GLB 的同名碎片永远合不起来。 */
    function nameKeyOf(nm) {
      var m = /^(.+)_(\d+)$/.exec(nm);
      return m ? m[1] : nm;
    }
    var groups = [], gmap = Object.create(null);
    parts.forEach(function (o) {
      var mat = Array.isArray(o.material) ? o.material[0] : o.material;
      var slot = slotOf(mat);
      var nm = String(o.name || '');
      var base = nameKeyOf(nm);
      var key = base + '\u0000' + slot;
      var g = gmap[key];
      if (!g) { g = gmap[key] = { name: nm, base: base, slot: slot, parts: [] }; groups.push(g); }
      g.parts.push(o);
    });

    /* 合起来会撞面数上限的，宁可保持分块：报错会让整份资产都导不进来 */
    var cap = SeedModel.Mesh.MAX_FACES || 50000;
    var jobs = [];
    groups.forEach(function (g) {
      if (g.parts.length === 1) { jobs.push(g); return; }
      var tris = 0;
      g.parts.forEach(function (o) { tris += triCountOf(o.geometry); });
      if (tris > cap) {
        g.parts.forEach(function (o) { jobs.push({ name: g.name, base: g.base, slot: g.slot, parts: [o] }); });
      } else {
        jobs.push(g);
      }
    });

    var built = jobs.map(function (g) {
      var geos = g.parts.map(bakeImportGeometry);
      var geo = geos.length === 1 ? geos[0] : concatImportGeometries(geos);
      if (geos.length > 1) geos.forEach(function (x) { x.dispose(); });
      var mesh;
      try { mesh = SeedModel.Mesh.fromBufferGeometry(geo, { slot: g.slot, quadOpts: { tolDeg: 40, shapeTol: 80 } }); }
      catch (e) { throw new Error((g.name || '网格') + '：' + ((e && e.message) || e)); }
      geo.dispose();
      /* 合并后的节点用去掉后缀的原名；单独一块就保留它自己的名字 */
      return { name: g.parts.length > 1 ? (g.base || g.name) : g.name, mesh: mesh };
    });

    var title = String(name || '').replace(/\.(glb|gltf|obj|fbx)$/i, '') || '导入模型';
    /* 贴图抽取放在分块之后：一个槽只留第一张基础色贴图，避免同名材质重复编码 */
    var slotMaps = await Promise.all(slotMats.map(function (mm) {
      return textureDataURL(mm && mm.map);
    }));
    var doc = SeedModel.Scene.createDoc({
      name: title,
      mesh: built[0].mesh,
      nodeName: built[0].name || title,
      materials: { slotNames: slotNames, slotColors: slotColors, slotMaps: slotMaps }
    });
    var firstNode = SeedModel.Scene.nodeOf(doc);
    firstNode.materialSlots = slotNames.slice();
    for (var i = 1; i < built.length; i++) {
      var node = SeedModel.Scene.addMeshNode(doc, {
        name: built[i].name || (title + ' ' + (i + 1)),
        mesh: built[i].mesh
      });
      if (node) node.materialSlots = slotNames.slice();
    }
    SeedModel.Scene.setActiveNode(doc, firstNode.id);
    return doc;
  }

  /* 老资产补色：v2.0 的 seedModel 只存了槽名，没存 slotColors（打开后整只模型都是默认灰）。
   * 这里从 GLB 自己的材质把显示色 / 基础色贴图补回来：先按材质名配，配不上按槽顺序。
   * fillFrom = 文档里已有的有效槽色数量，只补它后面的，别覆盖用户改过的颜色。 */
  async function backfillMaterials(doc, dataURL, fillFrom) {
    var mats = doc && doc.materials;
    var names = (mats && mats.slotNames) || [];
    if (!names.length) return false;
    var m3 = global.Model3D;
    if (!m3 || typeof m3.load !== 'function') return false;
    var model;
    try { model = await m3.load(dataURL); } catch (e) { return false; }
    var found = [], byName = Object.create(null);
    model.root.updateMatrixWorld(true);
    model.root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (mm) {
        if (!mm) return;
        var nm = String(mm.name || '');
        if (nm && byName[nm] == null) byName[nm] = found.length;
        found.push(mm);
      });
    });
    if (!found.length) return false;

    var colors = (mats.slotColors || []).slice();
    var maps = (mats.slotMaps || []).slice();
    var picks = [], jobs = [];
    for (var i = 0; i < names.length; i++) {
      var idx = byName[names[i]];
      var mm = idx != null ? found[idx] : (i < found.length ? found[i] : null);
      picks.push(mm);
      /* 槽色已经有的不覆盖；贴图缺的仍然补（老文档根本没写过 slotMaps） */
      if (mm && !maps[i]) jobs.push(i);
    }
    /* 贴图抽成 data URL 是异步的，先并发编码再统一写回，避免逐张 await 拖慢打开 */
    var extracted = await Promise.all(jobs.map(function (j) {
      return textureDataURL(picks[j] && picks[j].map);
    }));
    var changed = false;
    for (var q = 0; q < names.length; q++) {
      var mm2 = picks[q];
      if (!mm2 || q < fillFrom) continue;
      if (mm2.color && mm2.color.isColor) colors[q] = '#' + mm2.color.getHexString();
      else if (typeof mm2.color === 'number') colors[q] = '#' + new THREE.Color(mm2.color).getHexString();
      else colors[q] = '#c9ccd4';
      changed = true;
    }
    jobs.forEach(function (j, k) {
      if (extracted[k]) { maps[j] = extracted[k]; changed = true; }
    });
    if (!changed) return false;
    while (colors.length < names.length) colors.push('#c9ccd4');
    while (maps.length < names.length) maps.push('');
    mats.slotColors = colors.slice(0, names.length);
    mats.slotMaps = maps.slice(0, names.length);
    return true;
  }

  function assetNameOf(id) {
    var list = st.dockAssets || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return '';
  }

  /* 读资产 → 建模文档。「打开」和「置于」共用这一条路径，只在这里解析 GLB。 */
  async function readAssetDoc(id) {
    id = String(id || '');
    if (!id) throw new Error('缺少资产 id');
    var d = deskApi();
    if (!d) throw new Error('网页版没有资产库');
    var r = await d.assetRead(id);
    if (!r || !r.ok || !r.dataURL) throw new Error((r && (r.error || r.message)) || '资产缺失');
    /* 只有真正的 GLB 才可能带 seedModel；OBJ / FBX 都会在这一步抛，直接当普通模型导入 */
    var raw = null;
    try { raw = SeedGLB.readSeedModel(SeedGLB.fromDataURL(r.dataURL)); } catch (e) { raw = null; }
    if (!raw) {
      /* 没有 seedModel = 普通模型库资产：转成可编辑网格，别直接判死 */
      var imported = await importPlainModel(r.dataURL, assetNameOf(id));
      imported.assetId = id;
      imported.materials.textureConfigKey = id;
      imported.materials.textureConfigMissing = false;
      return { id: id, raw: null, doc: imported, converted: true, imported: true, warn: '' };
    }

    var doc, converted = false, warn = '';
    if (SeedModel.Scene.isV1(raw)) {
      var baked = SeedModel.Scene.fromV1(raw);
      if (!baked.ok) throw new Error('v1 文档烘焙失败：' + baked.errors.join('；'));
      doc = baked.doc;
      converted = true;
      warn = (baked.warnings || []).join('；');
    } else {
      var v = SeedModel.Scene.validate(raw);
      if (!v.ok) throw new Error('建模文档损坏：' + v.errors.join('；'));
      doc = v.doc;
      warn = (v.warnings || []).join('；');
    }
    /* 老文档（v2.0 只写了槽名、没写槽色/槽贴图）打开后整只模型是默认灰：
     * 从 GLB 自己的材质把颜色和基础色贴图补回来。v1 烘焙时颜色已经写进文档，不动。 */
    if (!converted && doc.materials && doc.materials.slotNames.length) {
      var rawMats = raw.materials || {};
      var haveColors = Array.isArray(rawMats.slotColors) ? rawMats.slotColors.length : 0;
      var haveMaps = Array.isArray(rawMats.slotMaps) ? rawMats.slotMaps.filter(Boolean).length : 0;
      if (haveColors < doc.materials.slotNames.length || haveMaps < doc.materials.slotNames.length) {
        var filled = await backfillMaterials(doc, r.dataURL, haveColors);
        if (filled) warn = (warn ? warn + '；' : '') + '已从原模型补回材质颜色';
      }
    }
    return { id: id, raw: raw, doc: doc, converted: converted, warn: warn };
  }

  async function openAsset(id) {
    var pack = await readAssetDoc(id);
    id = pack.id;
    var raw = pack.raw, doc = pack.doc, converted = pack.converted, warn = pack.warn;

    /* assetId 与 GLB 里的 id 不同 = 复制过的资产：不迁移贴图配置，
     * 保留原 key 并标缺，别让用户以为贴图还在。 */
    var sameId = raw ? String(raw.assetId || '') === id : false;
    doc.assetId = id;
    if (raw && raw.assetId && !sameId) {
      doc.materials.textureConfigKey = String((raw.materials && raw.materials.textureConfigKey) || raw.assetId);
      doc.materials.textureConfigMissing = !texConfigExists(doc.materials.textureConfigKey);
    } else {
      doc.materials.textureConfigKey = id;
      doc.materials.textureConfigMissing = false;
    }

    releaseView();
    st.doc = doc;
    st.isolate = false;        /* 打开新资产时回到全场景显示 */
    st.node = SeedModel.Scene.nodeOf(doc);
    st.nodeIds = st.node ? [st.node.id] : [];
    st.mesh = SeedModel.Scene.getMesh(doc);
    loadSelection(doc);
    st.autoName = false;
    st.selected = 0;
    st.editBefore = null;
    st.txBefore = null;
    if (!rebuildModel(false)) throw new Error('网格构建失败');
    clearHistory('reopen');
    paintAll();
    try { global.localStorage.setItem(LAST_KEY, id); } catch (e) {}
    setStatus('已打开：' + doc.name +
      (pack.imported ? '（普通模型已转为可编辑网格）' : (converted ? '（v1 已烘焙为网格）' : '')) +
      (doc.materials.textureConfigMissing ? '（贴图配置缺失）' : '') +
      (warn && !converted ? ' · ' + warn : ''));
    return doc;
  }

  /* 「置于」= 追加：把资产的网格节点并入当前文档，不清空、一条历史。
   * 整份资产沿 X 错开，避免和已有对象完全重叠、看起来像没加成功。 */
  async function appendAsset(id) {
    if (!st.doc) throw new Error('还没有可编辑场景');
    var pack = await readAssetDoc(id);
    var src = pack.doc;
    var srcNodes = SeedModel.Scene.nodesOf(src).map(function (n) {
      var mesh = SeedModel.Scene.getMesh(src, n);
      return mesh ? { node: n, mesh: mesh } : null;
    }).filter(Boolean);
    if (!srcNodes.length) throw new Error('资产里没有可编辑网格');

    var offset = SeedModel.Scene.nodesOf(st.doc).length;
    var added = 0;
    var ok = docEdit('置于：' + (src.name || pack.id), function () {
      var first = null;
      srcNodes.forEach(function (it) {
        var t = it.node.transform || {};
        var node = SeedModel.Scene.addMeshNode(st.doc, {
          name: it.node.name,
          mesh: SeedModel.Mesh.clone(it.mesh),
          transform: {
            position: [Number(t.position[0] || 0) + offset * 1.2,
              Number(t.position[1] || 0), Number(t.position[2] || 0)],
            rotation: (t.rotation || [0, 0, 0, 1]).slice(),
            scale: (t.scale || [1, 1, 1]).slice()
          }
        });
        if (!node) return;
        node.visible = it.node.visible !== false;
        if (!first) first = node;
        added++;
      });
      if (first) SeedModel.Scene.setActiveNode(st.doc, first.id);
      return !!first;
    });
    if (!ok) throw new Error('追加失败');
    closeOverlay();
    return { name: src.name || pack.id, nodes: added };
  }

  function openAssetById(id) {
    openAsset(id).then(function () {
      if (st.dockOpen) refreshDockAssets();
    }).catch(function (e) { setStatus('打开失败：' + ((e && e.message) || e), true); });
  }

  function placeAsset(id) {
    if (st.busy) { setStatus('正在保存中，稍后再置于', true); return; }
    appendAsset(id).then(function (r) {
      setStatus('已置于：' + r.name + '（' + r.nodes + ' 个对象，当前共 ' +
        SeedModel.Scene.nodesOf(st.doc).length + ' 个，Ctrl+Z 可撤销）');
    }).catch(function (e) {
      setStatus('置于失败：' + ((e && e.message) || e), true);
    });
  }

  /* ---------------- 内容浏览器（底部 dock） ----------------
   * 收起的页签就是入口；展开后按 updated 倒序列出模型库资产。
   * 后续建模 App 的功能（贴图 / 材质 / 预设）都以「选项卡」长在这个 dock 上。 */
  function setDock(open) {
    st.dockOpen = !!open;
    if (st.dock) st.dock.classList.toggle('on', st.dockOpen);
    var tab = $('mdDockTab');
    if (tab) tab.classList.toggle('on', st.dockOpen);
    if (st.dockOpen) refreshDockAssets();
    else { st.dockToken++; st.dockLoading = false; paintDock(); }
  }

  /* 建模内核目前只读这四种；其它格式在模型库 App 里能预览，但进不了可编辑场景，
   * 卡片上直接标出来，别让用户点「打开」才看到失败。 */
  var CB_EXTS = { glb: 1, gltf: 1, obj: 1, fbx: 1 };
  function dockAssetHtml(a) {
    var th = st.dockThumbs[a.id];
    var ext = String(a.ext || '').toLowerCase();
    var editable = CB_EXTS[ext] === 1;
    var meta = [];
    if (a.updated) { try { meta.push(new Date(a.updated).toLocaleDateString()); } catch (e) {} }
    if (a.size) meta.push((a.size / 1024).toFixed(0) + ' KB');
    var acts = editable
      ? '<div class="md-cb-acts">' +
        '<button type="button" class="md-cb-btn" data-md-cb-place="' + esc(a.id) + '" title="追加到当前场景">置于</button>' +
        '<button type="button" class="md-cb-btn primary" data-md-cb-open="' + esc(a.id) + '" title="清空场景并载入这个模型">打开</button>' +
      '</div>'
      : '<div class="md-cb-acts"><span class="md-cb-tag" title="暂只支持 GLB / GLTF / OBJ">暂不支持 ' + esc(ext.toUpperCase() || '该格式') + '</span></div>';
    return '<article class="md-cb-card" data-md-cb-id="' + esc(a.id) + '">' +
      '<div class="md-cb-thumb" data-md-cb-thumb="' + esc(a.id) + '">' +
        (th ? '<img alt="" src="' + esc(th) + '">' : '<span>GLB</span>') + '</div>' +
      '<div class="md-cb-meta"><b title="' + esc(a.name) + '">' + esc(a.name) + '</b>' +
        '<span>' + esc(meta.join(' · ')) + '</span></div>' + acts + '</article>';
  }

  function paintDock() {
    if (!st.dockBody) return;
    var d = deskApi();
    var body;
    if (!d) body = '<div class="md-cb-empty">网页版没有模型库。桌面端保存的模型会出现在这里。</div>';
    else if (st.dockLoading) body = '<div class="md-cb-empty">正在读取模型库…</div>';
    else if (st.dockErr) body = '<div class="md-cb-empty err">' + esc(st.dockErr) + '</div>';
    else if (!st.dockAssets) body = '<div class="md-cb-empty">展开「内容浏览器」以读取模型库。</div>';
    else if (!st.dockAssets.length) {
      body = '<div class="md-cb-empty">模型库里还没有模型。先在视口里建一个，再「保存 GLB」。</div>';
    } else body = '<div class="md-cb-grid">' + st.dockAssets.map(dockAssetHtml).join('') + '</div>';
    st.dockBody.innerHTML = body;
    var sub = $('mdDockSub');
    if (sub) sub.textContent = !d ? '不可用' : (st.dockAssets ? st.dockAssets.length + ' 个模型' : '模型库');
  }

  function refreshDockAssets() {
    var d = deskApi();
    if (!d) { st.dockAssets = null; st.dockErr = ''; st.dockLoading = false; paintDock(); return; }
    var token = ++st.dockToken;
    st.dockLoading = true;
    st.dockErr = '';
    paintDock();
    Promise.resolve(d.assetList()).then(function (l) {
      if (token !== st.dockToken) return;
      var list = (l && l.assets) ? l.assets.filter(function (a) { return a.kind === 'model'; }) : [];
      list.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
      st.dockAssets = list;
      st.dockLoading = false;
      paintDock();
      loadDockThumbs(token);
    }).catch(function (e) {
      if (token !== st.dockToken) return;
      st.dockLoading = false;
      st.dockErr = (e && e.message) || String(e);
      paintDock();
    });
  }

  /* 缩略图有就补一张（保存时写过 assetThumb）；没有就保留 GLB 字样，不现场渲染。 */
  function loadDockThumbs(token) {
    var d = deskApi();
    if (!d || typeof d.assetThumb !== 'function' || !st.dockAssets) return;
    st.dockAssets.forEach(function (a) {
      if (st.dockThumbs[a.id]) return;
      Promise.resolve(d.assetThumb(a.id)).then(function (t) {
        if (!t || !t.ok || !t.dataURL) return;
        st.dockThumbs[a.id] = t.dataURL;
        if (token !== st.dockToken || !st.dockBody) return;
        var boxes = st.dockBody.querySelectorAll('[data-md-cb-thumb]');
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i].dataset.mdCbThumb !== a.id) continue;
          boxes[i].innerHTML = '<img alt="" src="' + esc(t.dataURL) + '">';
        }
      }).catch(function () {});
    });
  }

  /* 工具行的「打开」改成展开 dock：打开模型库和「置于」在同一个地方选。 */
  function showOpenDialog() {
    setDock(true);
    if (!deskApi()) setStatus('网页版没有模型库（桌面端可打开本地模型）', true);
  }

  /* ---------------- 导出 / 保存 ---------------- */
  function exportGLB(root) {
    if (!THREE.GLTFExporter) return Promise.reject(new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）'));
    root.updateMatrixWorld(true);
    return new Promise(function (res, rej) {
      new THREE.GLTFExporter().parse(root, res, rej, { binary: true, onlyVisible: true });
    });
  }

  /* 导出根：把每个可见对象各建一个 pivot 挂到同一个 Group 下（B2d 的多节点导出）。
   * 只导出激活对象会让「新建的两个球」在 GLB 里少一个，和视口不一致。 */
  function buildExportRoot() {
    var root = new THREE.Group();
    root.name = st.doc.name || 'model';
    var nodes = SeedModel.Scene.nodesOf(st.doc);
    nodes.forEach(function (n) {
      if (n.visible === false) return;
      var mesh = SeedModel.Scene.getMesh(st.doc, n);
      if (!mesh) return;
      root.add(makePivotFor(n, mesh, false));
    });
    if (!root.children.length && st.mesh) root.add(makePivotFor(st.node, st.mesh, false));
    /* 视口的 map 是 TextureLoader 异步解出来的：打开后立刻保存时 map.image 可能还是空的，
     * 直接交给 GLTFExporter 会抛「No valid image data found」。所以先摘掉它，
     * 再挂上「导出专用」的、同步有像素的贴图（见 prepareExportMaps）。
     * ⚠ 别再只摘不挂：那样导出的 GLB 里 images/textures 全空，自家 App 靠
     * extras.seedModel.slotMaps 能还原，但 Blender / 3D 查看器 / 任何标准 glTF 阅读器
     * 打开都是白模 —— 用户说的「导出 glb 不带贴图」就是它。 */
    var maps = GLB_MAPS || [];
    root.traverse(function (o) {
      if (!o.userData || o.userData.mdPart !== 'solid' || !o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m, mi) {
        if (!m) return;
        if (m.map) { disposeMap(m); m.map = null; m.needsUpdate = true; }
        var t = maps[mi];
        if (t) { m.map = t; m.needsUpdate = true; }
      });
    });
    return root;
  }

  /* ---------------- 导出贴图：标准 glTF baseColorTexture ----------------
   * 按 slotMaps 的 URL 预先解成 canvas，给每个槽备一张**同步有像素**的贴图。
   * save() 里 glbTexSwap() 已经把「底座 ⊕ 投射层」的合成图临时写进 slotMaps，
   * 所以这里读到的就是最终视觉；不固化文档，也不依赖 TEX_CACHE 的解码时机。
   * flipY 与 sharedTexture 一致（three.js 默认 true）：GLTFExporter 会据此在写
   * 出 PNG 时上下翻一次，外部查看器看到的才和视口一样。
   * 解不出来的槽留空（宁可这一槽没贴图，也不能让整次保存失败）。 */
  var GLB_MAPS = null;
  async function prepareExportMaps() {
    var mats = (st.doc && st.doc.materials) || {};
    var arr = mats.slotMaps || [];
    var n = Math.max(arr.length, (mats.slotNames || []).length, 1);
    var out = [];
    for (var i = 0; i < n; i++) {
      var img = null;
      if (arr[i]) {
        try {
          img = await new Promise(function (res) {
            var im = new Image();
            im.onload = function () { res(im); };
            im.onerror = function () { res(null); };
            im.src = arr[i];
          });
        } catch (e) { img = null; }
        if (img && !img.naturalWidth) img = null;
      }
      /* 老资产可能只在视口材质上挂了图、slotMaps 是空的；或者 URL 已经失效。
       * 这时以「视口现在显示的那张」为准（liveSlotImage 是视口贴图的唯一真源），
       * 不能让这一槽导出成白模。 */
      if (!img) {
        try {
          var lv = liveSlotImage(i);
          if (lv && (lv.naturalWidth || lv.width)) img = lv;
        } catch (e) { /* 视口还没起来就跳过 */ }
      }
      if (!img) { out.push(null); continue; }
      try {
        var cv = document.createElement('canvas');
        cv.width = img.naturalWidth || img.width;
        cv.height = img.naturalHeight || img.height;
        cv.getContext('2d').drawImage(img, 0, 0);
        var tex = new THREE.CanvasTexture(cv);
        if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
        tex.flipY = true;
        tex.userData.mdExport = true;
        out.push(tex);
      } catch (e) { out.push(null); /* 单槽失败不影响整次导出 */ }
    }
    return out;
  }

  async function currentGLB() {
    /* 空场景也允许导出：GLB 里只有 scene 与 seedModel，重开时按空文档还原 */
    if (!st.doc) throw new Error('还没有文档');
    /* exportBytes() 这条测试路径也走这里，所以贴图不能只挂在 save() 上 */
    var owns = !GLB_MAPS;
    if (owns) GLB_MAPS = await prepareExportMaps();
    var root = buildExportRoot();
    try {
      return await exportGLB(root);
    } finally {
      disposeObject(root);
      if (owns) {
        for (var i = 0; i < GLB_MAPS.length; i++) {
          try { if (GLB_MAPS[i]) GLB_MAPS[i].dispose(); } catch (e) {}
        }
        GLB_MAPS = null;
      }
    }
  }

  /* 导出期间临时把「底座 ⊕ 投射层」的合成图塞进 slotMaps。
   * GLB 只能带一张 baseColor，层结构带不过去；但**不能顺手固化文档** ——
   * 自动保存也会走 save()，固化一次用户就没法再调落位了。
   * 所以：换上去 → 导出 / toSeedModel → 立刻换回来。 */
  function glbTexSwap() {
    if (!global.TexStack || !st.doc) return function () {};
    var mats = st.doc.materials || (st.doc.materials = {});
    var arr = mats.slotMaps || (mats.slotMaps = []);
    var saved = [];
    var n = Math.max((mats.slotNames || []).length, arr.length, 1);
    for (var i = 0; i < n; i++) {
      if (!global.TexStack.has(st.doc, i)) continue;
      /* 这一槽原本有贴图、却读不出像素：宁可导出旧 URL，也**不许**写一张
       * 「槽位灰 + 几个岛」的花图 —— 那正是「导出后贴图不见了」的形态。 */
      var r0 = global.TexSource ? global.TexSource.resolveBase(i) : null;
      var origUrl = arr[i] || '';
      if (origUrl && (!r0 || r0.from !== 'slot')) continue;
      var base = r0 ? r0.img : null;
      var cv = global.TexStack.flatten(st.doc, i, {
        base: base,
        slotColor: (mats.slotColors || [])[i] || '#c9ccd4',
        cap: global.TexStack.MAX_SIDE
      });
      if (!cv) continue;
      try {
        while (arr.length <= i) arr.push('');
        saved.push({ i: i, url: arr[i] || '' });
        arr[i] = cv.toDataURL('image/png');
      } catch (e) {
        if (saved.length && saved[saved.length - 1].i === i) saved.pop();
      }
    }
    return function () {
      for (var k = 0; k < saved.length; k++) arr[saved[k].i] = saved[k].url;
    };
  }

  async function save() {
    if (!st.doc || st.busy) return { ok: false, error: '正在保存中' };
    st.busy = true;
    setStatus('正在导出 GLB…');
    try {
      if (!st.doc.assetId) st.doc.assetId = genId();
      if (!st.doc.materials.textureConfigKey) st.doc.materials.textureConfigKey = st.doc.assetId;
      /* 首次保存才拿到资产 id：把本会话攒下的纹理混合配置迁到这个 key，
       * 不然关掉页面就丢（模型库那边也靠同一个 key 读配置）。 */
      if (MIX) MIX.rekey(st.doc, st.doc.materials.textureConfigKey);
      if (!st.doc.materials.slotNames.length) {
        st.doc.materials.slotNames = ['默认材质'];
        st.doc.materials.slotColors = ['#c9ccd4'];
      }
      /* 把内存里的网格写回 meshes（现在真源是 doc.meshes；这步是幂等的） */
      SeedModel.Scene.setMesh(st.doc, st.mesh);
      /* 投射层 → 合成图（见 glbTexSwap 的说明）。try/finally 保证异常也换回来 */
      var restoreTex = glbTexSwap();
      var buf, docJson;
      try {
        buf = await currentGLB();
        docJson = SeedModel.Scene.toSeedModel(st.doc);
      } finally {
        restoreTex();
      }
      var withExtras = SeedGLB.injectSeedModel(buf, docJson);
      var dataURL = SeedGLB.toDataURL(withExtras);
      var d = deskApi();
      if (!d) {
        Model3D.saveDataURL((st.doc.name || 'model') + '.glb', dataURL);
        setStatus('网页版没有模型库，已改为下载 GLB');
        return { ok: true, dataURL: dataURL, downloaded: true };
      }
      var r = await d.assetPut({
        id: st.doc.assetId,
        kind: 'model',
        ext: 'glb',
        name: (st.doc.name || 'model') + '.glb',
        data: dataURL,
        source: 'modeldesk'
      });
      if (!(r && r.ok && r.asset && r.asset.id)) throw new Error((r && r.message) || '入库失败');
      if (r.asset.id !== st.doc.assetId) st.doc.assetId = r.asset.id;
      try { global.localStorage.setItem(LAST_KEY, st.doc.assetId); } catch (e) {}
      setStatus('已保存到模型库：' + r.asset.name + '（' + (withExtras.length / 1024).toFixed(0) + ' KB）');
      if (st.dockOpen) refreshDockAssets();
      /* 缩略图顺手补一张；失败不影响保存结果 */
      try {
        if (typeof d.assetThumbSave === 'function') {
          var th = await Model3D.renderThumb(dataURL, { size: 256 });
          if (th && th.dataURL) await d.assetThumbSave(st.doc.assetId, th.dataURL);
        }
      } catch (e2) {}
      return { ok: true, asset: r.asset, dataURL: dataURL, bytes: withExtras.length };
    } catch (e) {
      var msg = (e && e.message) || String(e);
      setStatus('保存失败：' + msg, true);
      return { ok: false, error: msg };
    } finally {
      st.busy = false;
    }
  }

  /* ---------------- 覆盖层（四视图 / 材质槽 / 打开列表） ---------------- */
  function overlayShow(html, cls) {
    if (!st.overlay) return;
    st.overlay.className = 'md-overlay on' + (cls ? ' ' + cls : '');
    st.overlay.innerHTML = '<div class="md-ov">' + html + '</div>';
  }
  function closeOverlay() {
    if (st.texOpen) {
      try { Model3D.closePreview(); } catch (e) {}
      st.texOpen = false;
    }
    if (st.overlay) {
      st.overlay.className = 'md-overlay';
      st.overlay.innerHTML = '';
    }
  }

  async function openTextureEditor() {
    if (!st.doc || st.busy) return;
    var saved = await save();
    if (!saved.ok) return;
    closeOverlay();
    overlayShow(
      '<div class="md-ov-head"><b>材质槽 · ' + esc(st.doc.name) + '</b>' +
      '<span class="md-ov-sub">贴图配置按 assetId 恢复（' + esc(st.doc.assetId) + '）</span>' +
      '<button type="button" class="md-ov-x" data-md-act="close-overlay">×</button></div>' +
      '<div class="md-ov-body md-tex-host" id="mdTexHost"></div>',
      'tex'
    );
    var host = $('mdTexHost');
    try {
      st.texOpen = true;
      await Model3D.openPreview(saved.dataURL, {
        title: st.doc.name,
        host: host,
        chrome: false,
        assetId: st.doc.assetId
      });
    } catch (e) {
      setStatus('3D 查看器打开失败：' + ((e && e.message) || e), true);
      st.texOpen = false;
    }
  }

  /* ---------------- 打开入口 ---------------- */
  function open() {
    ensureUI();
    if (!st.uiReady) return;
    ensureViewport();
    /* M6a：命令表 / 工具会话的注册只跑一次 */
    if (!st.toolsBooted) {
      st.toolsBooted = true;
      try { registerFakeTool(); } catch (e) {
        setStatus('工具框架初始化失败：' + ((e && e.message) || e), true);
      }
      try { registerOperators(); } catch (e) {
        setStatus('拓扑算子初始化失败：' + ((e && e.message) || e), true);
      }
    }
    resume();
    if (!st.doc) {
      var last = null;
      try { last = global.localStorage.getItem(LAST_KEY); } catch (e) {}
      if (last) {
        openAsset(last).catch(function () { newDocument(); });
      } else {
        newDocument();
      }
    } else {
      paintAll();
    }
  }

  /* ============================================================
   * UV 编辑器（X5a–X5e）
   * ------------------------------------------------------------
   * 对应截图里的 Maya UV 编辑器：浮动窗口 / 11 个菜单 / 工具栏 /
   * 带标尺与 0–1 网格的二维画布 / 右侧「UV 工具包」折叠组。
   *
   * 分工：
   *   - js/seed-uv.js：点分组、拾取、岛、变换、投影、展开、排布（纯函数）
   *   - 这一段：窗口 DOM、画布绘制、指针交互、与 3D 选择联动、历史
   *
   * 铁律：
   *   - 拖动过程中只改 uvs + 重画画布，不 bump、不记历史（每帧 clone 会卡）
   *   - 松手时 bump 一次，再 pushHistory（before 在按下时 snap）
   *   - UV 改动不进 rebuildModel：3D 几何不读 UV，没必要重建
   * ============================================================ */

  /* ---------------- UV 编辑器（已拆到 js/md-uv-editor.js） ---------------- */
  /* 外壳只留一层门面：内部仍用同一份 st.uv 状态，原来的调用点一行都不用改。 */
  var UVED = global.MDUvEditor.create({
    st: st, $: $, esc: esc, SeedModel: SeedModel,
    setStatus: setStatus, updateChrome: updateChrome, updateHud: updateHud,
    undo: undo, redo: redo, snap: snap, pushHistory: pushHistory,
    paintAll: paintAll, paintSelection: paintSelection, applyShading: applyShading,
    syncSelectionDoc: syncSelectionDoc, islandFacesOf: islandFacesOf,
    /* UV 窗口「图像 → 投射烘焙」跳转：函数声明提升，这里拿得到后面的 openProjBake */
    openProjBake: openProjBake,
    /* UV 编辑器直接改 st.mesh.uvs：有修改器时 st.mesh 是求值结果，必须挡在门外 */
    nodeModsActive: nodeModsActive
  });
  function openUVEditor() { return UVED.open(); }
  function closeUVEditor() { return UVED.close(); }
  function uvCommand(cmd) { return UVED.command(cmd); }
  function uvRefresh() { return UVED.refresh(); }
  function uvToast(text, isErr) { return UVED.toast(text, isErr); }
  /* 下面两个是外壳自己的调用点（getState / 绘画起笔）用到的查询，转发给模块。 */
  function uvSelectedFaceIds() { return UVED.selectedFaceIds(); }
  function uvRefreshSolidGeometry() { return UVED.refreshSolidGeometry(); }

  /* ---------------- 投射烘焙（已拆到 js/md-proj-bake.js） ----------------
   * 只读网格 + 写材质槽贴图：不碰 uvs，所以不用 docEdit / applyMesh，
   * 历史走「贴图补丁」（和绘画工具箱同一条出口 applyPaintPatch）。 */
  var PB = global.MDProjBake ? global.MDProjBake.create({
    st: st, $: $, THREE: THREE, SeedModel: SeedModel, esc: esc,
    setStatus: setStatus, updateChrome: updateChrome,
    paintAll: paintAll, rebuildModel: rebuildModel,
    sharedTexture: sharedTexture, applySlotTexture: applySlotTexture,
    /* 烘焙/绘画工作区的底图：取「视口里真实显示的那张」，不只是 slotMaps */
    liveSlotImage: liveSlotImage,
    /* 投射把结果推进编辑层栈之后，视口要靠混合管线重新合成才会更新
     * （切片二：烘焙不再写 slotMaps，材质上挂的是合成图） */
    mixRefresh: function (slot) { if (MIX) MIX.refreshSlot(slot, true); },
    mixComposeNow: function (slot) { if (MIX) MIX.composeNow(slot); },
    /* 这一槽当前材质上挂的是不是「混合合成图」：是的话不能当底座写回文档 */
    mixComposed: function (slot) {
      var t = MIX && MIX.texFor(slot);
      return (t && t.image) || null;
    },
    /* 「重建 UV」要换整份网格：必须走 applyMesh（新 mesh + 一条历史），
     * 不能在旧 mesh 上原地改 uvs —— 那会让指纹指向被改过的数据 */
    applyMesh: applyMesh,
    nodeModsActive: nodeModsActive,
    totalBytes: totalBytes, syncBytes: syncBytes, historyBudget: HISTORY_BUDGET
  }) : null;
  function openProjBake() {
    if (!PB) { setStatus('投射烘焙模块没加载（js/md-proj-bake.js）', true); return false; }
    return PB.open();
  }
  /* 测试钩：探针要读模块内部状态（岛数 / 绑定 / 相机图 / 缓存尺寸） */
  function projBakeModule() { return PB; }


  global.modelDesk = {
    open: open,
    openAsset: openAsset,
    newDocument: newDocument,
    save: save,
    undo: undo,
    redo: redo,
    /* M6 的算子入口：换一份新网格 + 记一条历史（不要在旧 mesh 上原地改） */
    applyMesh: applyMesh,
    /* 把一张贴图挂到某一槽（探针 / 外部脚本用：模拟「贴图只在材质上、
     * 不在 slotMaps 里」的老资产）。真源仍是 slotMaps，这里只改材质。 */
    applySlotTexture: applySlotTexture,
    /* 探针 / 外部脚本用：按「刚打开页面」的口径重新读取 v4 的编辑层栈。
     * 页面自己不需要它（ensureSlot 会自动灌一次），但「刷新后笔迹还在不在」
     * 只能靠这条显式路径验证。 */
    rehydrateOps: function (slot) { return MIX ? MIX.rehydrate(slot) : Promise.resolve(0); },
    /* M5：基础体面板（菜单 / Shelf / 测试都从这里进） */
    openPrimitive: openPrimitiveDialog,
    createPrimitive: createPrimitive,
    /* B2b：大纲点行 = 换激活对象（与视口跨对象点选同一条路） */
    selectNodeById: selectNodeById,
    closeOverlay: closeOverlay,
    getDocument: function () { return st.doc; },
    getState: function () {
      /* 统计一律从「当前激活节点」取：docEdit 换激活对象后 st.mesh 可能还指着旧网格
       * （表现为新建球体后面数还是 6、组件手柄挂错对象） */
      var live = st.doc ? (SeedModel.Evaluator.evaluate(st.doc, SeedModel.Scene.nodeOf(st.doc)) || SeedModel.Scene.getMesh(st.doc)) : null;
      if (live && live !== st.mesh) {
        st.node = SeedModel.Scene.nodeOf(st.doc);
        st.mesh = live;
      }
      var s = statsNow();
      return {
        hasDoc: !!st.doc,
        schemaVersion: st.doc && st.doc.schemaVersion,
        mode: st.doc && st.doc.mode,
        revision: st.doc && st.doc.revision.current,
        meshRevision: st.doc && st.doc.revision.mesh,
        nodes: st.doc ? st.doc.nodes.length : 0,
        vertices: s.vertices,
        faces: s.faces,
        edges: s.edges,
        triangles: s.triangles,
        gizmoMode: st.mode,
        space: st.space,
        snap: st.snap,
        shading: st.shading,
        /* 单独显示：探针按 isolate / visibleObjects 断言隔离真的只留一个对象 */
        isolate: !!st.isolate,
        /* 组件隔离：面 / 岛选择下只显示替身网格 */
        isoComp: !!st.isoComp,
        isoFaces: st.isoFaceCount || 0,
        visibleObjects: st.pivots ? Object.keys(st.pivots).filter(function (id) {
          return st.pivots[id] && st.pivots[id].visible;
        }).length : 0,
        quad: st.quad,
        quadActive: st.quadActive,
        quadMax: st.quadMax,
        viewName: st.viewName,
        edgeObjects: !!st.edgeLines,
        vertexObjects: !!st.vertPoints,
        undo: st.history.undo.length,
        redo: st.history.redo.length,
        historyBytes: st.history.bytes,
        meshHash: meshHashOf(st.mesh),
        meshStates: HIST.meshStates(),
        nodeCount: st.doc ? SeedModel.Scene.nodesOf(st.doc).length : 0,
        /* 视口里真实挂出来的 pivot 数（多对象渲染的回归口径：必须 == nodeCount） */
        sceneObjects: st.pivots ? Object.keys(st.pivots).length : 0,
        status: st.statusEl ? st.statusEl.textContent : '',
        /* M6a：工具会话状态（探针按它断言「预览中 / 已提交 / 已取消」） */
        toolLive: !!(global.SeedTools && global.SeedTools.isLive()),
        toolId: (global.SeedTools && global.SeedTools.isLive()) ? global.SeedTools.current().id : null,
        toolPreview: !!st.previewMesh,
        /* B2b：大纲渲染结果（探针按它断言行数 / 高亮 / 隐藏态） */
        outline: (function () {
          var list = $('mdOutlineList');
          var rows = list ? list.querySelectorAll('.md-part-row') : [];
          return {
            rows: rows.length,
            fake: list ? list.querySelectorAll('.md-part-row.fake').length : 0,
            real: list ? list.querySelectorAll('.md-part-row[data-md-node]').length : 0,
            sel: list ? (list.querySelector('.md-part-row.sel') || {}).textContent || '' : '',
            off: list ? list.querySelectorAll('.md-part-row.off').length : 0,
            count: ($('mdOutlineCount') || {}).textContent || ''
          };
        })(),
        nodeVisible: !!(st.node && st.node.visible !== false),
        docNodes: st.doc ? st.doc.nodes.map(function (n) { return { id: n.id, name: n.name, visible: n.visible !== false, meshRef: n.meshRef || '' }; }) : [],
        meshCount: st.doc ? SeedModel.Scene.meshIds(st.doc).length : 0,
        activeNodeId: st.doc ? st.doc.activeNodeId : '',
        navAlt: !!st.navAlt,
        tool: st.tool,
        primShape: st.prim.shape,
        primSeg: st.prim.seg,
        autoName: !!st.autoName,
        selMode: st.selMode,
        selVertex: st.sel.vertexIds.length,
        selEdge: st.sel.edgeIds.length,
        selFace: st.sel.faceIds.length,
        selHighlight: !!(st.selGroup && st.selGroup.children.length),
        soft: { on: !!st.soft.on, falloff: st.soft.falloff, size: st.soft.size, custom: !!st.soft.custom },
        texKey: st.doc && st.doc.materials.textureConfigKey,
        slotNames: st.doc ? st.doc.materials.slotNames.slice() : [],
        exposure: st.renderer ? st.renderer.toneMappingExposure : null,
        toneMapping: st.renderer ? st.renderer.toneMapping : null,
        toneMappingName: (st.prefs || prefs()).toneMapping,
        /* X5a–X5e：UV 编辑器状态（探针断言用） */
        uvOpen: !!st.uv.open,
        uvMode: st.uv.mode,
        uvTransform: st.uv.transform,
        uvGrid: !!(st.uv.open && st.uv.grid),
        uvRuler: !!(st.uv.open && st.uv.ruler),
        uvSnap: !!(st.uv.open && st.uv.snap),
        uvTex: !!(st.uv.open && st.uv.tex),
        uvSelCorners: st.uv.open ? st.uv.corners.length : 0,
        uvSelFaces: st.uv.open ? uvSelectedFaceIds().length : 0,
        uvIslands: (st.mesh && SeedModel.Mesh) ? SeedModel.Mesh.uvIslands(st.mesh).islands.length : 0,
        uvSeams: (st.mesh && SeedModel.Mesh) ? SeedModel.Mesh.seamCount(st.mesh) : 0,
        uvImage: !!(st.uv.open && st.uv.img),
        uvImageName: st.uv.open ? st.uv.imgName : '',
        uvMap: !!(st.uv.open && st.uv.mapImg),
        uvMapName: st.uv.open ? st.uv.mapName : '',
        uvMapOn: !!(st.uv.open && st.uv.mapOn && st.uv.mapImg),
        uvScale: st.uv.open ? st.uv.scale : 0,
        uvView: { cu: st.uv.cu, cv: st.uv.cv, scale: st.uv.scale },
        /* 右侧工具箱页签 + 绘画笔刷（探针用它断言状态，不点 UI 也能读） */
        tbKind: st.tbKind,
        brush: st.paint.brush,
        brushSize: st.paint.size,
        brushColor: st.paint.color,
        brushOpacity: st.paint.opacity,
        paintSlot: st.paint.slot,
        paintMask: st.paint.mask,
        paintClipped: st.paint.clipped,
        paintClipPolys: st.paint.clipPolys
      };
    },
    /* X5：UV 编辑器入口（Shelf 图标 / 探针 / 快捷键都走这里） */
    openUVEditor: openUVEditor,
    openProjBake: openProjBake,
    projBake: projBakeModule,
    closeUVEditor: closeUVEditor,
    uvCommand: uvCommand,
    uvState: function () {
      return {
        open: !!st.uv.open,
        mode: st.uv.mode,
        transform: st.uv.transform,
        grid: st.uv.grid,
        ruler: st.uv.ruler,
        snap: st.uv.snap,
        tex: st.uv.tex,
        image: st.uv.imgName || '',
        seams: st.mesh ? SeedModel.Mesh.seamCount(st.mesh) : 0,
        corners: st.uv.corners.slice(),
        faces: uvSelectedFaceIds(),
        view: { cu: st.uv.cu, cv: st.uv.cv, scale: st.uv.scale },
        canvas: st.uv.canvas ? { w: st.uv.canvas.clientWidth, h: st.uv.canvas.clientHeight } : null
      };
    },
    /* V1：渲染风格是应用级配置，改完立刻生效并落 localStorage（P6 搬进设置页） */
    setRenderTone: function (patch) {
      savePrefs(patch || {});
      applyRenderTone();
      applyShading();
      return st.prefs;
    },
    getPrefs: function () { return prefs(); },
    /* 测试用：只导出当前文档，不落盘 */
    exportBytes: async function () {
      if (!st.doc) throw new Error('没有文档');
      return currentGLB();
    },
    /* M6a：命令表 / 工具会话 / 吸附 / 显示开关（外壳只暴露四个口，不长算子分支） */
    commands: function () { return global.SeedCommands || null; },
    tools: function () { return global.SeedTools || null; },
    snap: function () { return global.SeedSnap || null; },
    viewFlags: function () { return global.SeedViewFlags || null; },
    /* 工具会话四个口（菜单/命令行/快捷键都走它们，不在外壳里写 if） */
    beginTool: beginTool,
    dragTool: dragTool,
    commitTool: commitTool,
    cancelTool: cancelTool,
    /* 探针用：把 doc.selection 读回内存并重画（测试直接改文档选择集后调它） */
    reselect: function () {
      if (!st.doc) return false;
      /* 先把 st.mesh 对齐到当前激活节点，否则组件变换会写到旧对象的网格上 */
      st.node = SeedModel.Scene.nodeOf(st.doc);
      st.mesh = SeedModel.Evaluator.evaluate(st.doc, st.node) || SeedModel.Scene.getMesh(st.doc);
      loadSelection(st.doc);
      pruneSelection();
      paintSelection();
      syncGizmo();
      updateHud();
      return true;
    },
    /* 探针用：只读地暴露视口内部 */
    __debug: function () {
      return {
        camera: st.camera, pivot: st.pivot, gizmo: st.gizmo, canvas: st.canvas,
        compPivot: st.compPivot, compIdx: st.compIdx, compDrag: st.compDrag,
        renderer: st.renderer, scene: st.scene, stage: st.stage, controls: st.controls,
        quadCams: st.quadCams, quadCtl: st.quadCtl,
        quadActive: st.quadActive, quadMax: st.quadMax,
        edgeLines: st.edgeLines, vertPoints: st.vertPoints,
        lights: st.lights,
        cube: st.cube,
        pivots: st.pivots,
        extrudeGizmo: st.extrudeGizmo,
        uv: st.uv,
        mesh: st.mesh, doc: st.doc
      };
    }
  };
})(window);
