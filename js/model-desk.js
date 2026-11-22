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
    /* 按需渲染：没有输入 / 脏块 / 动画时不调 renderer.render。
     * holdUntil = 还要保持渲染到哪个时间点（指针悬停、拖拽反馈用）；
     * frameSig = 上一帧的场景指纹，变了才画。 */
    holdUntil: 0, frameSig: '',
    mode: 'translate', space: 'world', snap: false,
    rightTab: 'props', outlineQuery: '', showGrid: true, gridHelper: null,
    shading: 'shaded', quad: false, quadCams: null, viewName: '透视',
    /* 视口条上的下拉：灯光预设 / 大纲页签 / 工具架页签 / 面板显隐 */
    lightingPreset: 'default', outlineTab: 'all', shelfTab: 'poly',
    panels: { outline: true, right: true, shelf: true },
    pop: null, popItems: null,
    /* 单独显示（隔离所选）：只影响视口，不写文档里的 node.visible */
    isolate: false,
    /* 右侧工具箱两个页签：建模 / 绘画。绘画 = 把笔刷颜色直接画进当前材质槽的基础色贴图 */
    tbKind: 'model',
    /* 绘画工具箱内部的两个页签：paint = 笔刷参数，layers = 材质图层列表 */
    paintTab: 'paint',
    /* 编辑器模式（建模 / 绘制）：两套界面共用同一份 DOM 与状态，只换显隐与工具条。
     * 模式只在左上角切换；右侧栏标题跟着模式走。 */
    editor: 'model',
    paint: {
      brush: 'soft', size: 42, opacity: 90, color: '#d94f4f',
      /* tool = 绘制模式左侧工具栏选中的工具：brush / pencil / eraser / blur / smudge /
       * picker / wand。工具只决定手势语义，笔刷的形状与颜色仍由 brush / shape / color 管。 */
      tool: 'brush',
      /* lockIsland = 魔棒锁定的 UV 岛（存 faceId）；-1 = 不锁定，按落笔所在的岛裁 */
      lockIsland: -1,
      /* shape = 笔尖形状：round / square / diamond / star / custom（图片 alpha） */
      shape: 'round',
      /* customBrush = 用户载入的笔尖图：{ img, url, name, rev }；只放内存，不写文档 */
      customBrush: null,
      /* mask = 只画进落笔所在的 UV 岛（stroke 开始时按岛的多边形给 2D 上下文加 clip） */
      mask: false,
      /* userSlot = 显式选定的材质槽；-1 = 自动（按落笔面所属槽） */
      userSlot: -1,
      stroke: null, doc: null, slot: -1, tex: null, canvas: null, ctx: null,
      clipCtxs: null, clipped: false, clipPolys: 0,
      /* 脏块：previewBox = 工作副本自上次上传后改过的范围；
       * inkBox = 这一笔的总范围（入栈时写进层里）；inkFrameBox = 自上次合成后的增量 */
      previewBox: null, inkBox: null, inkFrameBox: null
    },
    /* V7：四视图可交互 —— quadCtl 每格一个 OrbitControls，只 enable 激活那一个；
     * quadMax 非空时该格全屏；quadDown / quadClick 用来区分单击、拖拽与双击。 */
    quadCtl: null, quadActive: 'front', quadMax: null, quadDown: null, quadClick: null,
    edgeLines: null, vertPoints: null, navAlt: false, lights: [], noPick: false,
    cube: null,
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
    /* 组件面板：只存「用户在上次面板里的选择」，参数本身由组件源定义。
     * target = '' 表示「新增一个」；有值表示正在调**已经加进场景的那个对象**。
     * 加进文档的组件参数在 node.comp.params 里（纯数据），这里只是面板的草稿。 */
    comp: { kind: 'lumen-head', preset: 'standard', params: null, paramsFor: '', target: '', loadSeq: 0,
      /* host = 这份「面板草稿」正被谁在编：''（没人在编）/ 'overlay'（添加/调整对话框）
       * / 'props'（属性面板里的控制器）。同一时刻只能有一个宿主 ——
       * 两处同时编同一个节点，后写的一方会把前一方的手工值覆盖掉。 */
      host: '',
      /* 控制器的一次编辑事务（拖动中只改内存，松手才记一条历史）。见 compTxnBegin */
      txn: null },
    /* 组件的「运行时状态」：**不存盘、不进历史、不进撤销**。
     * 与 node.comp.params（持久参数）严格分离。眨眼 / 呼吸 / 头发飘这类东西
     * 一旦写进文档，存盘会把当前相位带进去 —— 重开文件就停在「半闭眼」，
     * 而且每帧一次改动会把撤销栈冲成几十条。键 = 节点 id，值由组件自报。 */
    compLive: Object.create(null),
    /* 视口里的 3D 捏脸控制器（js/md-ctrl-layer.js）。ctrlSig = 当前摆的是「谁的一套杆」，
     * 变了才重建几何；值的变化不走它（值由 syncCtrlValues 直写旋钮）。 */
    ctrlLayer: null, ctrlSig: '', ctrlHi: null,
    autoName: true,
    /* 选择（M3/S1）：模式 + 三组稳定 ID + 高亮组 */
    selMode: 'object',
    sel: { vertexIds: [], edgeIds: [], faceIds: [] },
    nodeIds: [],                 /* 大纲多选（结合/布尔用） */
    /* 软选择：开关 + 距离口径（体积 = 欧氏 / 表面 = 沿网格测地）+ 衰减半径（米）
     * + 曲面类型 + 自定义曲线点 + 热力图开关 */
    soft: { on: false, mode: 'volume', falloff: 'smooth', size: 0.65, custom: null, heatmap: true },
    softDrag: -1, softInfo: { mode: 'volume', radius: 0.65, count: 0 },
    selGroup: null, pickDown: null,
    /* 对象选择的 12 棱包围盒高亮（挂在 scene 上，多选跨 pivot） + 组件预选幽灵 */
    objSelGroup: null, hoverPick: null, hoverAt: 0,
    /* 组件变换：手柄挂在 compPivot 上，拖动时把「世界空间的增量」换算回网格局部坐标 */
    compPivot: null, compIdx: [], compDrag: null, edgeRecs: null,
    pivots: Object.create(null),
    /* 热盒：按住空格弹出，松开执行鼠标下的那一条 */
    hbOpen: false, hbHover: null, hbZones: [], hbPanel: null, pointer: { x: 0, y: 0 },
    /* 工具（竖条）：select / lasso / paint / move / rotate / scale；gest 是当前手势 */
    tool: 'select', gest: null,
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

  /* ---------------- 状态分区（P0：按所有者拆分） ----------------
   * st 曾经是所有人共用的一张表：视口、选择、面板、绘画全挤在一起，谁都能写，
   * 读 undefined 也不报错。这里先按所有者把字段收进三个分区：
   *   st.view  视口 / 场景（渲染层写）
   *   st.edit  编辑态（选择、工具、软选择、组件变换）
   *   st.panel 外壳 UI（DOM、停靠、面板、状态栏）
   * 迁移期为兼容旧调用点，st 上保留同名访问器，映射到分区里的真值；两者是同一字段，
   * 不复制值。新代码一律写 st.view.* / st.edit.* / st.panel.*，旧调用点逐模块迁走。
   * paint / uv / history 属于各自功能模块，等模块接管状态时再从 st 一级挪走。 */
  var ST_GROUPS = {
    view: ['host', 'stage', 'canvas', 'overlay', 'renderer', 'scene', 'camera', 'controls',
      'gizmo', 'doc', 'node', 'mesh', 'pivot', 'running', 'raf', 'resizeObs', 'holdUntil',
      'frameSig', 'showGrid', 'gridHelper', 'shading', 'quad', 'quadCams', 'viewName',
      'isolate', 'lightingPreset', 'edgeLines', 'vertPoints', 'navAlt', 'lights', 'noPick',
      'cube', 'pivots', 'quadCtl', 'quadActive', 'quadMax', 'quadDown', 'quadClick',
      'objSelGroup', 'hoverPick', 'hoverAt'],
    edit: ['selected', 'mode', 'space', 'snap', 'selMode', 'sel', 'nodeIds', 'soft', 'softDrag',
      'softInfo', 'selGroup', 'pickDown', 'compPivot', 'compIdx', 'compDrag', 'edgeRecs',
      'editBefore', 'txBefore', 'editor', 'tbKind', 'tool', 'gest'],
    panel: ['statusEl', 'hudEl', 'uiReady', 'busy', 'statusTimer', 'texOpen', 'menu', 'toolPanel',
      'prefs', 'dock', 'dockBody', 'dockOpen', 'dockLoading', 'dockAssets', 'dockErr',
      'dockThumbs', 'dockToken', 'prim', 'autoName', 'rightTab', 'outlineQuery', 'outlineTab',
      'shelfTab', 'panels', 'pop', 'popItems', 'paintTab', 'hbOpen', 'hbHover', 'hbZones',
      'hbPanel', 'pointer']
  };
  (function partitionState() {
    Object.keys(ST_GROUPS).forEach(function (name) {
      var keys = ST_GROUPS[name];
      var box = st[name] = {};
      keys.forEach(function (k) {
        /* 拼错的分区键直接暴露出来：静默丢字段比报错更难查 */
        if (!(k in st)) { box[k] = undefined; return; }
        box[k] = st[k];
        Object.defineProperty(st, k, {
          enumerable: true, configurable: true,
          get: function () { return box[k]; },
          set: function (v) { box[k] = v; }
        });
      });
    });
  })();

  /* 材质槽贴图的读写、解码状态、底图读取统一收在 MDMaterialStore（js/md-material-store.js）。
   * 外壳只保留材质工厂与释放：不再自己缓存贴图，也不再直接回答「底图从哪来」。 */
  var STORE = global.MDMaterialStore.create({
    THREE: THREE,
    requestRender: requestRender,
    eachViewPivot: eachViewPivot,
    doc: function () { return st.doc; }
  });
  var sharedTexture = STORE.sharedTexture;
  var applySlotTexture = STORE.applySlotTexture;
  var liveSlotImage = STORE.liveSlotImage;
  var liveSlotTexture = STORE.liveSlotTexture;
  var slotBaseLoading = STORE.baseLoading;

  /* 挤出专用操纵器的私有状态（箭头 + 轴心缩放柄）。
   * 为什么不放 st：三个键和文档、选择、四视图全无关系，只属于这一个工具；
   * 放 st 一级 = 没有主人（谁都能读、谁都能写，读 undefined 也不报错）。
   * 为什么不放 SeedTools 的 ctx：gizmo 组要跨会话复用（THREE 几何不该每次开会话重建），
   * 而 ctx 每次 begin 都是新对象。drag/hover 虽是瞬时的，但和 gizmo 共用同一组命中测试，
   * 拆两处反而更容易不同步。 */
  var EXGZ = { gizmo: null, drag: null, hover: null };

  /* 3×3 笔刷形状槽：8 个内置 + 1 个自定义（空槽点击载入图片）。
   * 顺序直接决定面板里的排列，改顺序前先想想用户肌肉记忆。 */
  var PAINT_SHAPES = ['round', 'square', 'diamond', 'star', 'triangle', 'pentagon', 'ring', 'cross', 'custom'];
  var PAINT_SHAPE_NAME = {
    round: '圆形', square: '方形', diamond: '菱形', star: '星形',
    triangle: '三角形', pentagon: '五边形', ring: '环形', cross: '十字', custom: '自定义'
  };

  function paintShapeSlotsHtml() {
    var out = '';
    for (var i = 0; i < PAINT_SHAPES.length; i++) {
      var sh = PAINT_SHAPES[i];
      out += '<button type="button" class="md-brush-slot" data-md-brushshape="' + sh + '"' +
        ' title="' + PAINT_SHAPE_NAME[sh] + (sh === 'custom' ? '：点击载入图片' : '') + '">' +
        '<i class="md-brush-slot-ic"></i><em>' + PAINT_SHAPE_NAME[sh] + '</em></button>';
    }
    return out;
  }

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
    dyn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="12" cy="12" r="2.4"/><ellipse cx="12" cy="12" rx="9.2" ry="4.2" transform="rotate(-32 12 12)"/><ellipse cx="12" cy="12" rx="9.2" ry="4.2" transform="rotate(32 12 12)" opacity=".55"/></svg>',
    /* 法线：一条曲面 + 朝外的箭头（统一朝向 / 重算法线） */
    normals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.4 17.2c4.4-5.6 12.8-5.6 17.2 0"/><path d="M12 12.6V4.2"/><path d="m8.9 7.3 3.1-3.1 3.1 3.1"/><path d="M6.4 13.6 4.8 10M17.6 13.6l1.6-3.6" opacity=".5"/></svg>'
  };

  /* 工具箱面板：Blender 式分组 + 行状按钮（图标 + 名称），和截图一致 */
  var OP_GROUPS = [
    { id: 'mesh', title: '网格', items: [
      { op: 'join', label: '结合', icon: 'join', title: '把大纲中多选的对象合成一个网格' },
      { op: 'separate', label: '分离', icon: 'separate', title: '按连通块拆成多个对象' },
      { op: 'split-islands', label: '拆分岛', icon: 'islandSplit', title: '把选中的 UV 岛拆成一个独立对象（UV 岛模式 F12 选择）' },
      { op: 'smooth', label: '平滑', icon: 'smooth', title: '平滑选中顶点（不选 = 整体）' },
      { op: 'tris-to-quads', label: '三角转四边', icon: 'tris2quads', title: '把成对的共边三角面并成四边面（UV 接缝处不并）' },
      { op: 'unify-normals', label: '统一法线', icon: 'normals', title: '把绕序不一致的面翻成统一朝外（修纯色黑块），并按 60° 平滑法线' },
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
      '<input id="mdSoftSize" class="md-soft-num" type="number" min="0" max="5" step="0.01" value="0.65" title="衰减半径（米）">',
      '</div>',
      '<div class="md-soft-row">',
      '<span class="md-soft-lb">距离</span>',
      '<select id="mdSoftMode" class="md-soft-sel" title="体积 = 空间直线距离；表面 = 沿网格边走的测地距离">',
      '<option value="volume">体积（欧氏）</option><option value="surface">表面（测地）</option>',
      '</select>',
      '<label class="md-soft-ck" title="用蓝→红热力图在视口显示权重"><input type="checkbox" id="mdSoftHeat" checked><span>热力图</span></label>',
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
      '    <div class="md-menu-brand"><b>The seed</b><span id="mdBrandMode">建模</span></div>',
      /* 编辑器模式开关：整套界面只有这一个真源（st.editor），
       * 建模模式显示工具架 / 竖条 / 大纲 / 建模工具箱，绘制模式换成笔刷条 + 绘画工具箱。 */
      '    <div class="md-editorsw" role="group" aria-label="编辑器模式">',
      '      <button type="button" class="md-edbtn on" data-md-editor-btn="model" title="建模模式：基础体、拓扑算子、UV 与材质槽">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2.8 20 7v10l-8 4.2L4 17V7z"/><path d="M4 7l8 4.2L20 7M12 11.2v10"/></svg>' +
      '        <span>建模</span></button>',
      '      <button type="button" class="md-edbtn" data-md-editor-btn="paint" title="绘制模式：笔刷直接画进材质贴图">' +
      '        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14.6 3.4 20.6 8l-9 8.6-4.9-4.6z"/><path d="M5 13.8c1.9-.3 3.5.7 3.8 2.5.3 1.9-.9 3.5-2.8 3.8-1 .2-1.8.1-2.6-.2.9-.6 1.2-1.4 1.2-2.4 0-1.6.5-2.9 1.4-3.7z"/></svg>' +
      '        <span>绘制</span></button>',
      '    </div>',
      '    <nav class="md-menu-items">',
      '      <button type="button" class="md-mitem" data-md-menu="文件">文件</button>',
      '      <button type="button" class="md-mitem" data-md-menu="编辑">编辑</button>',
      '      <button type="button" class="md-mitem" data-md-menu="创建">创建</button>',
      '      <button type="button" class="md-mitem" data-md-menu="修改">修改</button>',
      '      <button type="button" class="md-mitem" data-md-menu="选择">选择</button>',
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
      /* 工具与变换手柄统一由左侧工具条进入（图标 + 名称 + 快捷键），
       * 这里只保留坐标 / 吸附这类「设置」，避免同一动作出现两个入口。 */
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
      /* 绘制模式的专用工具条：只在绘制模式出现，替代建模模式里那排变换 / 吸附控件。
       * 这里的大小 / 浓度 / 颜色 / 笔刷都是**同一份 st.paint** 的快捷入口，
       * 由 updatePaintUi() 双向同步，不是第二套状态。 */
      '  <div class="md-paintbar" id="mdPaintBar" hidden>',
      '    <span class="md-pb-title"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14.6 3.4 20.6 8l-9 8.6-4.9-4.6z"/><path d="M5 13.8c1.9-.3 3.5.7 3.8 2.5.3 1.9-.9 3.5-2.8 3.8-1 .2-1.8.1-2.6-.2.9-.6 1.2-1.4 1.2-2.4 0-1.6.5-2.9 1.4-3.7z"/></svg>绘制工具</span>',
      '    <span class="md-pb-sep"></span>',
      '    <div class="md-pb-group" role="group" aria-label="笔刷类型">',
      '      <button type="button" class="md-pb-btn on" data-md-pbrush="soft" title="软边笔刷：边缘渐隐">软边</button>',
      '      <button type="button" class="md-pb-btn" data-md-pbrush="hard" title="硬边笔刷：边缘清晰">硬边</button>',
      '      <button type="button" class="md-pb-btn" data-md-pbrush="erase" title="橡皮擦：擦回透明">橡皮</button>',
      '    </div>',
      '    <span class="md-pb-sep"></span>',
      '    <label class="md-pb-field" title="笔刷大小"><span>大小</span>' +
      '      <input type="range" id="mdBrushSizeBar" min="6" max="180" step="1" value="42"><b id="mdBrushSizeBarVal">42</b></label>',
      '    <label class="md-pb-field" title="笔刷不透明度"><span>浓度</span>' +
      '      <input type="range" id="mdBrushOpacityBar" min="5" max="100" step="1" value="90"><b id="mdBrushOpacityBarVal">90%</b></label>',
      '    <input type="color" id="mdBrushColorBar" value="#d94f4f" title="笔刷颜色">',
      '    <button type="button" class="md-pb-btn" data-md-pmask title="只画进落笔所在的 UV 岛，笔刷不会溢到相邻岛">UV 遮罩</button>',
      '    <span class="md-pb-meta" id="mdPaintBarMeta">槽：自动</span>',
      '    <div class="md-pb-right">',
      '      <button type="button" class="md-act" data-md-act="tex" title="材质槽：管理基础色贴图">材质槽</button>',
      '      <button type="button" class="md-act" data-md-act="uv" title="UV 编辑器：查看 / 排布 UV 岛">UV 编辑器</button>',
      '    </div>',
      '  </div>',
      '  <div class="md-shelf">',
      '    <div class="md-shelf-tabs">',
      '      <button type="button" class="md-stab on" data-md-stab="poly">多边形建模</button>',
      '      <button type="button" class="md-stab" data-md-stab="curve">曲线</button>',
      '      <button type="button" class="md-stab" data-md-stab="surface">曲面</button>',
      '      <button type="button" class="md-stab" data-md-stab="anim">动画</button>',
      '      <button type="button" class="md-stab" data-md-stab="fx">FX</button>',
      '      <button type="button" class="md-stab" data-md-stab="render">渲染</button>',
      '      <button type="button" class="md-stab" data-md-stab="dyn">动力学</button>',
      '    </div>',
      '    <div class="md-shelf-grid">',
      '      <span class="md-shelf-note" id="mdShelfNote" hidden></span>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#c9a24e" title="立方体：新建并调尺寸" data-md-prim="box">' + SHELF_ICONS.box + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#7fa9d8" title="球体：新建并调半径 / 段数" data-md-prim="sphere">' + SHELF_ICONS.sphere + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#9ec27b" title="圆柱：新建并调上下半径 / 段数" data-md-prim="cylinder">' + SHELF_ICONS.cylinder + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#c98fb3" title="平面：新建并调宽高" data-md-prim="plane">' + SHELF_ICONS.plane + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#e0a13a" title="圆环：新建并调主半径 / 管半径" data-md-prim="torus">' + SHELF_ICONS.torus + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#d8a15a" title="圆锥：新建并调底半径 / 高" data-md-prim="cone">' + SHELF_ICONS.cone + '</button>',
      /* 分组分隔：二十多个图标连成一条时，用户要靠"数第几个"找工具。
       * 三条分隔把工具架切成「基础体 / 建模编辑 / 贴图 / 占位」四段。 */
      '      <span class="md-sico-sep" data-shelf="poly" aria-hidden="true"></span>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#b8b8b8" data-md-todo="重新拓扑" data-md-plan="B7" title="重新拓扑：尚未接入（计划表 B7）">' + SHELF_ICONS.retopo + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#8cb6a6" data-md-op="knife" title="多切割：视口拖线切割">' + OP_ICONS.knife + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#d8b06a" data-md-op="target-weld" title="目标焊接：最后选中的点作目标">' + OP_ICONS.targetWeld + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#9aa8c9" data-md-op="bridge" title="桥接：两个同边数面">' + OP_ICONS.bridge + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#c7a0d6" data-md-op="extrude" title="挤出：沿法线挤出选中面">' + OP_ICONS.extrude + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#a8a8a8" data-md-op="bevel" title="倒角：选中面内缩 + 深度">' + OP_ICONS.bevel + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#d98b3f" data-md-op="loopcut" title="环切：沿选中边所在的四边环切分">' + OP_ICONS.loopcut + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#8fc7a8" data-md-op="tris-to-quads" title="三角转四边：成对三角并成四边面">' + OP_ICONS.tris2quads + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#9db4d8" data-md-op="unify-normals" title="统一法线：绕序不一致的面翻成朝外，修纯色黑块">' + OP_ICONS.normals + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#8fb5b8" data-md-op="separate" title="分离（大纲多选后可用结合）">' + OP_ICONS.separate + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#8fb5b8" data-md-op="split-islands" title="拆分岛：把选中的 UV 岛拆成独立对象">' + OP_ICONS.islandSplit + '</button>',
      '      <button type="button" class="md-sico" data-shelf="poly" style="--c:#c9b27c" data-md-op="smooth" title="平滑：选中顶点或整体">' + OP_ICONS.smooth + '</button>',
      '      <span class="md-sico-sep" data-shelf="render" aria-hidden="true"></span>',
      '      <button type="button" class="md-sico" data-shelf="render" style="--c:#c88a8a" data-md-act="tex" title="材质槽 / 纹理：打开 3D 查看器编辑贴图">' + SHELF_ICONS.texture + '</button>',
      '      <button type="button" class="md-sico" data-shelf="render" style="--c:#9fc0e0" data-md-act="uv" title="UV 编辑器：二维 UV 视图 / 选择 / 变换 / 展开排布">' + SHELF_ICONS.uv + '</button>',
      '      <button type="button" class="md-sico" data-shelf="render" style="--c:#e0b06a" data-md-act="projbake" title="投射烘焙：把当前视角的 UV 岛拖到原画上重采样（修 AI 图糊掉的眼睛等细节）">' + SHELF_ICONS.projbake + '</button>',
      '      <span class="md-sico-sep" data-shelf="curve" aria-hidden="true"></span>',
      '      <button type="button" class="md-sico" data-shelf="curve" style="--c:#d0b080" data-md-todo="曲线工具" data-md-plan="M7" title="曲线工具：尚未接入（计划表 M7）">' + SHELF_ICONS.curve + '</button>',
      '      <button type="button" class="md-sico" data-shelf="surface" style="--c:#b0b0b0" data-md-todo="曲面放样" data-md-plan="M7" title="曲面放样：尚未接入（计划表 M7）">' + SHELF_ICONS.surface + '</button>',
      '      <button type="button" class="md-sico" data-shelf="anim" style="--c:#d8a15a" data-md-todo="动画" data-md-plan="M7" title="动画：尚未接入（计划表 M7）">' + SHELF_ICONS.anim + '</button>',
      '      <button type="button" class="md-sico" data-shelf="render" style="--c:#d8c45a" data-md-todo="渲染设置" data-md-plan="M8" title="渲染设置：尚未接入（计划表 M8）">' + SHELF_ICONS.render + '</button>',
      '      <button type="button" class="md-sico" data-shelf="dyn" style="--c:#8fa8b6" data-md-todo="动力学" data-md-plan="M8" title="动力学：尚未接入（计划表 M8）">' + SHELF_ICONS.dyn + '</button>',
      '    </div>',
      '  </div>',
      '  <div class="md-hb" id="mdHotbox" aria-hidden="true"></div>',
      '  <div class="md-main">',
      /* 绘制模式的左侧专业工具栏：只在绘制模式出现，替代建模模式的竖条。
       * 每个按钮都对应一条真实手势（见 md-paint.js 的 tool 分派），不是占位。 */
      '    <div class="md-paintrail" id="mdPaintRail" hidden role="toolbar" aria-label="绘制工具">',
      '      <button type="button" class="md-prbtn on" data-md-ptool="brush" title="画笔：按右侧笔刷设置上色">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15.2 3.6l5.2 5.2-8.4 8.4-5.2-5.2z" fill="currentColor" stroke="none"/><path d="M5.4 12.8l5.8 5.8c-1.2 2.2-3.1 3-6.2 3 .9-1 .9-2.3.9-3.6 0-1.9-.5-3.5-.5-5.2z"/></svg><span class="md-prname">画笔<kbd>B</kbd></span></button>',
      '      <button type="button" class="md-prbtn" data-md-ptool="pencil" title="铅笔：硬边笔尖，边缘不收窄">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20l3.2-.6L20 6.6 17.4 4 4.6 16.8z"/><path d="M14.8 6.6l2.6 2.6M4.6 16.8L4 20l3.2-.6z" fill="currentColor" stroke="none"/></svg><span class="md-prname">铅笔<kbd>P</kbd></span></button>',
      '      <button type="button" class="md-prbtn" data-md-ptool="eraser" title="橡皮：按笔刷形状擦回透明">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8.4 19.6 3.8 15l8.6-8.6 4.6 4.6-6.8 6.8z" fill="currentColor" stroke="none"/><path d="M7.2 19.8h12.4"/><path d="M10.4 8.4l4.6 4.6"/></svg><span class="md-prname">橡皮<kbd>E</kbd></span></button>',
      '      <span class="md-prsep"></span>',
      '      <button type="button" class="md-prbtn" data-md-ptool="blur" title="模糊工具：糊开笔刷覆盖到的贴图纹素">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3.2c3 3.6 5.2 6.4 5.2 9a5.2 5.2 0 0 1-10.4 0c0-2.6 2.2-5.4 5.2-9z" fill="currentColor" stroke="none" opacity=".85"/><path d="M6.2 18.8c1 .6 2 .9 3 .9M15 19.4c1-.2 1.9-.6 2.7-1.2" stroke-linecap="round"/></svg><span class="md-prname">模糊<kbd>R</kbd></span></button>',
      '      <button type="button" class="md-prbtn" data-md-ptool="smudge" title="涂抹工具：把落笔处的贴图往笔尖方向带">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.2 16.6c3.4 0 5.2-1.6 7.6-3.4 2-1.5 4-2.8 6.4-2.8 1.4 0 2.4.5 3 1.2"/><path d="M4.4 20c3.8 0 5.6-1.8 8-3.6" stroke-dasharray="2.4 2.2"/><circle cx="17.4" cy="7.2" r="2.6" fill="currentColor" stroke="none"/></svg><span class="md-prname">涂抹<kbd>T</kbd></span></button>',
      '      <span class="md-prsep"></span>',
      '      <button type="button" class="md-prbtn" data-md-ptool="picker" title="吸管：从贴图上取颜色作为笔刷色">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15.8 3.8l4.4 4.4-2.2 2.2-4.4-4.4z" fill="currentColor" stroke="none"/><path d="M13 7.4l3.6 3.6-7.8 7.8-4.2 1.2 1.2-4.2z"/><path d="M8.2 15.8l-1.6 1.6"/></svg><span class="md-prname">吸管<kbd>I</kbd></span></button>',
      '      <button type="button" class="md-prbtn" data-md-ptool="wand" title="魔棒：点模型锁定一整块 UV 岛，笔画只写进这一岛；再点一次解除">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.4 19.6 14 10l-1.8-1.8L2.6 17.8z" fill="currentColor" stroke="none"/><path d="M17 2.6l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9zM19.8 13.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/></svg><span class="md-prname">魔棒<kbd>W</kbd></span></button>',
      '      <span class="md-prsep"></span>',
      /* 岛填充是**动作**不是手势工具：点一下立刻把当前选中的 UV 岛填成笔刷色，
       * 之后仍停留在原来的工具上，不会把笔刷语义改掉。 */
      '      <button type="button" class="md-prbtn" data-md-pfill title="岛填充：用当前颜色铺满选中的 UV 岛（F12 选岛；按材质槽写入，Ctrl+Z 可撤销）">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M9.6 3.8 19.4 13.6l-6.2 6.2a1.7 1.7 0 0 1-2.4 0L3.1 12.1a1.7 1.7 0 0 1 0-2.4z" fill="currentColor" stroke="none" opacity=".9"/><path d="M3.4 12.2h16.2"/><path d="M8.4 5.2 6.6 3.4"/><path d="M17.4 16.6c0 1.2-.9 2.1-2.1 2.1s-2.1-.9-2.1-2.1c0-1.4 2.1-3.7 2.1-3.7s2.1 2.3 2.1 3.7z" fill="currentColor" stroke="none"/></svg><span class="md-prname">岛填充<kbd>G</kbd></span></button>',
      '      <span class="md-prspacer"></span>',
      '      <span class="md-prsw" id="mdPaintRailSw" title="当前笔刷颜色"></span>',
      '    </div>',
      '    <div class="md-strip" role="toolbar" aria-label="建模工具">',
      '      <button type="button" class="md-tool" data-md-tool="select" title="选择工具（Q）：点选；按住拖动 = 框选">' + TOOL_ICONS.select + '<span class="md-toolname">选择<kbd>Q</kbd></span></button>',
      '      <button type="button" class="md-tool" data-md-tool="lasso" title="套索工具：按住画一圈，圈住的被选中">' + TOOL_ICONS.lasso + '<span class="md-toolname">套索</span></button>',
      '      <button type="button" class="md-tool" data-md-tool="paint" title="绘制选择：按住刷，刷过的被选中（按住 Ctrl 刷掉）">' + TOOL_ICONS.paint + '<span class="md-toolname">绘制选择</span></button>',
      '      <span class="md-tool-sep"></span>',
      '      <button type="button" class="md-tool" data-md-tool="move" title="移动工具（W）">' + TOOL_ICONS.move + '<span class="md-toolname">移动<kbd>W</kbd></span></button>',
      '      <button type="button" class="md-tool" data-md-tool="rotate" title="旋转工具（E）">' + TOOL_ICONS.rotate + '<span class="md-toolname">旋转<kbd>E</kbd></span></button>',
      '      <button type="button" class="md-tool" data-md-tool="scale" title="缩放工具（R）">' + TOOL_ICONS.scale + '<span class="md-toolname">缩放<kbd>R</kbd></span></button>',
      '    </div>',
      '    <aside class="md-outline">',
      '      <div class="md-panel-h"><span>大纲视图</span><em id="mdOutlineCount">0 个对象</em></div>',
      '      <div class="md-otabs"><button type="button" class="md-otab on" data-md-otab="all">显示</button><button type="button" class="md-otab" data-md-otab="hidden">隐藏</button><button type="button" class="md-otab" data-md-otab="levels">关卡</button><button type="button" class="md-otab" data-md-otab="help">帮助</button>' +
      '        <button type="button" class="md-otab md-otab-add" id="mdAddCompBtn" data-md-act="comp-open" title="添加组件：把现成零件（二次元头模等）并进当前场景">＋ 组件</button></div>',
      '      <div class="md-osearch"><input id="mdOutlineSearch" type="search" placeholder="按名称搜索节点" autocomplete="off" spellcheck="false"></div>',
      '      <div class="md-tree" id="mdOutlineList"></div>',
      '      <div class="md-hint">F8–F11 切对象 / 顶点 / 边 / 面，Shift 加选、Ctrl 减选；框选随 S3、挤出等算子随 M6。</div>',
      '    </aside>',
      '    <div class="md-center">',
      '      <div class="md-vpbar">',
      '        <button type="button" class="md-vplabel md-popbtn" id="mdViewLabel" data-md-pop="view" title="切换相机视图">透视 ▾</button>',
      '        <span class="md-vplabel">着色</span>',
      '        <select class="md-vpsel" id="mdShadeSel" title="着色模式">',
      '          <option value="shaded">实体</option>',
      '          <option value="flat">平涂</option>',
      '          <option value="normals">法线</option>',
      '          <option value="uv">UV 岛着色</option>',
      '        </select>',
      /* 线框不再是「着色模式」，而是叠在当前着色之上的一层：可与实体 / 平涂 / 法线 / 岛色任意组合 */
      '        <label class="md-vpck" title="线框叠加：在当前着色模式上显示拓扑边线（可与任意着色模式同时开）">' +
      '          <input type="checkbox" id="mdWireChk"><span>线框</span></label>',
      '        <button type="button" class="md-vpi" data-md-act="isolate" id="mdIsolateBtn" title="单独显示：只显示当前选中对象；面 / UV 岛模式下只显示选中的面（再点退出）">' +
      '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '            <rect x="2.6" y="2.6" width="18.8" height="18.8" stroke-dasharray="2.6 2.2" opacity=".75"/>' +
      '            <path d="M12 6.6 17 9.3v5.4L12 17.4 7 14.7V9.3z"/>' +
      '            <path d="M12 11.9 17 9.3v5.4L12 17.4z" fill="currentColor" stroke="none" opacity=".85"/>' +
      '          </svg></button>',
      '        <button type="button" class="md-vplabel md-popbtn" data-md-pop="light" id="mdLightLabel" title="切换灯光预设">照明 ▾</button>',
      '        <button type="button" class="md-vplabel md-popbtn" data-md-pop="display" title="显示开关：栅格 / 边线 / 顶点 / 背面 / 材质 / 纹理 / 光照 / 线框">显示 ▾</button>',
      '        <button type="button" class="md-vplabel md-popbtn" data-md-pop="render" title="渲染器：色调映射与曝光">渲染器 ▾</button>',
      '        <button type="button" class="md-vplabel md-popbtn" data-md-pop="panel" title="显示 / 隐藏面板">面板 ▾</button>',
      '        <span class="md-sep"></span>',
      '        <button type="button" class="md-vpi" data-md-act="grid" id="mdGridBtn" title="显示 / 隐藏地面栅格">⌗</button>',
      '        <button type="button" class="md-vpi" data-md-act="shade-cycle" id="mdShadeBtn" title="切换着色模式（实体 / 平涂 / 法线 / UV 岛）">▦</button>',
      '        <button type="button" class="md-vpi" data-md-act="view-iso" title="复位到轴测视图（与双击 ViewCube 同效果）">◍</button>',
      '        <span class="md-vpnum"><span class="md-numb">0.00</span><i>/</i><span class="md-numb">1.00</span></span>',
      '        <button type="button" class="md-vpstyle md-popbtn" data-md-pop="render">ACES 1.0 SDR-video (sRGB)<i>▾</i></button>',
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
      '      <div class="md-panel-h md-right-h"><span class="md-right-t" id="mdRightTitle">建模工具箱</span><em id="mdTbMode">对象</em>' +
      '        <button type="button" class="md-otab md-propstog" id="mdPropsToggle" title="属性编辑器：变换 / 材质槽 / 操作历史">属性</button></div>',
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
      /* 顶部两个页签：笔刷参数与图层列表都很长，分段显示比一条长滚动更容易找 */
      '          <div class="md-paint-tabs" role="tablist" aria-label="绘画工具箱">',
      '            <button type="button" class="md-paint-tab on" role="tab" data-md-ptab="paint" aria-selected="true">绘画工具箱</button>',
      '            <button type="button" class="md-paint-tab" role="tab" data-md-ptab="layers" aria-selected="false">图层</button>',
      '          </div>',
      '          <div class="md-paint-pane" data-md-pane="paint">',
      /* 预览条：笔刷当前状态一眼可读（形状 / 大小 / 不透明度 / 颜色 / 目标槽），
       * 棋盘底表示「笔迹是带透明的」；数值与下方滑杆保持同一份状态。 */
      '          <div class="md-paint-prev">',
      '            <div class="md-paint-prev-stage"><i id="mdPaintPrevDot"></i></div>',
      '            <div class="md-paint-prev-info">',
      '              <b id="mdPaintPrevName">圆形软笔</b>',
      '              <span id="mdPaintPrevMeta">42 px · 90% · 自动槽</span>',
      '            </div>',
      '          </div>',
      '          <div class="md-paint-card">',
      '            <div class="md-paint-card-h"><i></i><span>笔刷设置</span><em>在模型表面拖动上色</em></div>',
      '            <div class="md-paint-row"><span>材质槽</span><select id="mdPaintSlotSel" title="选定后笔迹只写进这一槽；自动 = 按落笔面所属的槽">' +
      '              <option value="-1">自动（落笔面所在槽）</option></select>' +
      '              <i class="md-paint-slotdot" id="mdPaintSlotDot" title="自动：按落笔面所属的槽"></i></div>',
      '            <div class="md-paint-row"><span>笔刷</span><select id="mdBrushSel">' +
      '              <option value="soft">软边</option><option value="hard">硬边</option>' +
      '              <option value="erase">橡皮擦</option></select></div>',
      '            <div class="md-paint-row md-paint-row-shapes"><span>形状</span>' +
      '              <div class="md-brush-grid" id="mdBrushGrid" role="group" aria-label="笔刷形状">' +
      paintShapeSlotsHtml() +
      '              </div></div>',
      /* 自定义笔尖：只在形状 = 自定义时出现，图片只放内存，不写进文档 / 资产库 */
      '            <div class="md-paint-row md-paint-custom" id="mdBrushCustomRow" hidden>' +
      '              <span>笔尖图</span>' +
      '              <button type="button" class="md-paint-file" data-md-brushfile>载入图片…</button>' +
      '              <i class="md-paint-brushtmb" id="mdBrushTmb" hidden></i>' +
      '              <em id="mdBrushCustomName">未载入</em></div>',
      '            <div class="md-paint-row"><span>大小</span><input type="range" id="mdBrushSize" min="6" max="180" step="1" value="42"><b id="mdBrushSizeVal">42 px</b></div>',
      '            <div class="md-paint-row"><span>不透明度</span><input type="range" id="mdBrushOpacity" min="5" max="100" step="1" value="90"><b id="mdBrushOpacityVal">90%</b></div>',
      '            <div class="md-paint-row"><span>颜色</span><input type="color" id="mdBrushColor" value="#d94f4f">',
      '              <label class="md-paint-chk" title="只画进落笔所在的 UV 岛，笔刷不会溢到相邻岛"><input type="checkbox" id="mdPaintMask">UV 岛遮罩</label></div>',
      '            <div class="md-paint-swatches" role="group" aria-label="常用颜色">',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#d94f4f" style="--c:#d94f4f" title="朱红 #d94f4f"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#e88a00" style="--c:#e88a00" title="橙黄 #e88a00"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#e8c53a" style="--c:#e8c53a" title="金黄 #e8c53a"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#4caf72" style="--c:#4caf72" title="草绿 #4caf72"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#2b7cd3" style="--c:#2b7cd3" title="湖蓝 #2b7cd3"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#7a5cd6" style="--c:#7a5cd6" title="紫罗兰 #7a5cd6"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#d65ca8" style="--c:#d65ca8" title="品红 #d65ca8"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#1f2328" style="--c:#1f2328" title="墨黑 #1f2328"></button>',
      '              <button type="button" class="md-paint-sw" data-md-swatch="#ffffff" style="--c:#ffffff" title="白色 #ffffff"></button>',
      '            </div>',
      '          </div>',
      /* 提示放在笔刷卡片下面、纹理混合上面：右栏是整条滚动，
       * 放最后会被长图层列表推到看不见的地方。 */
      '          <div class="md-paint-hint"><b>操作：</b>左键拖动上色；<b>按住 Shift 拖动 = 模糊笔</b>（糊开笔刷覆盖到的纹素）；Alt+左键 / 中键导航。先在「材质槽」里选槽（默认自动 = 落笔面所在槽），笔画只写进选中的槽。</div>',
      '          </div>',
      '          <div class="md-paint-pane" data-md-pane="layers" hidden>',
      '            <div class="md-paint-mix" id="mdMixBox"></div>',
      '          </div>',
      '          <input type="file" id="mdBrushFile" accept="image/png,image/webp,image/jpeg" hidden>',
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
      '    <input id="mdCmd" class="md-cmd" type="text" autocomplete="off" spellcheck="false" placeholder="输入命令：camera front / shading wire / display grid off / tone aces / exposure 1.2 / mesh.extrude">',
      '    <div class="md-status" id="mdStatus"></div>',
      '  </div>',
      '  <div class="md-keybar" id="mdKeyBar" role="note" aria-label="工具快捷键"></div>',
      '</div>'
    ].join('\n');

    /* 首次挂载就按 st.editor 落一次模式标记（重开窗口时保留上次所处的模式） */
    applyEditorChrome(st.editor);
    /* 重开窗口时把绘制条 / 右侧面板拉回当前笔刷状态（不是 HTML 里的默认值） */
    updatePaintUi();

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

    /* 主菜单下拉 / 视口条下拉：点外面 / 按 Esc 收起。捕获阶段处理，先于工具层的 Esc。 */
    document.addEventListener('pointerdown', function (e) {
      var tg = e.target;
      if (st.pop && !(tg && tg.closest && (tg.closest('.md-pop') || tg.closest('.md-popbtn')))) closePop();
      if (!st.menu) return;
      if (tg && tg.closest && (tg.closest('#mdDrop') || tg.closest('.md-mitem'))) return;
      mdCloseMenu();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (st.pop && (e.key === 'Escape' || e.key === 'Esc')) {
        closePop();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
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
    setPaintTab(st.paintTab);
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

  /* ---------------- 底部快捷键提示条 ----------------
   * 常驻窗底，显示当前可用的工具快捷键；当前工具 / 选择模式对应的那一项高亮。
   * 键位只写 onKeyLayer 里真实存在的，两边必须同源 —— 提示里出现按了没反应的键，
   * 比不提示更糟。换了编辑器（建模 / 绘制）就整条换内容，不显示用不上的键。 */
  function kbChip(key, label, on, tip) {
    return '<span class="md-kb-chip' + (on ? ' on' : '') + '"' +
      (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
      '<kbd>' + esc(key) + '</kbd><i>' + esc(label) + '</i></span>';
  }
  function paintKeyBar() {
    var bar = $('mdKeyBar');
    if (!bar) return;
    var sig = st.editor + '|' + st.tool + '|' + st.selMode;
    if (bar.dataset.sig === sig) return;
    bar.dataset.sig = sig;
    var html = '<span class="md-kb-l">快捷键</span>';
    if (st.editor === 'paint') {
      html += kbChip('左键', '上色') +
        kbChip('Shift', '模糊笔') +
        '<i class="md-kb-sep"></i>' +
        kbChip('Alt+左键', '环绕') +
        kbChip('Alt+中键', '平移') +
        kbChip('滚轮', '推拉') +
        '<i class="md-kb-sep"></i>' +
        kbChip('Ctrl+Z', '撤销') +
        kbChip('Ctrl+S', '保存');
    } else {
      html += kbChip('Q', '选择', st.tool === 'select') +
        kbChip('W', '移动', st.tool === 'move') +
        kbChip('E', '旋转', st.tool === 'rotate') +
        kbChip('R', '缩放', st.tool === 'scale') +
        '<i class="md-kb-sep"></i>' +
        kbChip('F8', '对象', st.selMode === 'object') +
        kbChip('F9', '顶点', st.selMode === 'vertex') +
        kbChip('F10', '边', st.selMode === 'edge') +
        kbChip('F11', '面', st.selMode === 'face') +
        kbChip('F12', '岛', st.selMode === 'island') +
        '<i class="md-kb-sep"></i>' +
        kbChip('空格', '热盒') +
        kbChip('K', '多切割', st.tool === 'knife') +
        kbChip('Ctrl+Z', '撤销') +
        kbChip('Ctrl+S', '保存');
    }
    bar.innerHTML = html;
  }

  function updateChrome() {
    paintKeyBar();
    if (!st.doc) return;
    var nameEl = $('mdName');
    if (nameEl) nameEl.textContent = st.doc.name;
    var undoBtn = $('mdUndo'), redoBtn = $('mdRedo');
    if (undoBtn) undoBtn.disabled = !st.history.undo.length;
    if (redoBtn) redoBtn.disabled = !st.history.redo.length;
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
    var wireChk = $('mdWireChk');
    if (wireChk) wireChk.checked = vfOn('wireframe');
    var shadeBtn = $('mdShadeBtn');
    if (shadeBtn) shadeBtn.classList.toggle('on', st.shading === 'normals');
    var quadBtn = document.querySelector('.md-act[data-md-act="quad"]');
    if (quadBtn) quadBtn.classList.toggle('on', st.quad);
    var isoBtn = $('mdIsolateBtn');
    if (isoBtn) {
      isoBtn.classList.toggle('on', st.isolate);
      isoBtn.disabled = !st.doc || !st.node;
    }
    var viewLabel = $('mdViewLabel');
    if (viewLabel) viewLabel.textContent = (st.quad ? quadViewText() : (st.viewName || '透视')) + ' ▾';
    var lightLabel = $('mdLightLabel');
    if (lightLabel && LIGHT_PRESETS && LIGHT_PRESETS[st.lightingPreset]) {
      lightLabel.textContent = '照明：' + LIGHT_PRESETS[st.lightingPreset].label + ' ▾';
    }
    document.querySelectorAll('.md-tool[data-md-tool]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTool === st.tool);
    });
    document.querySelectorAll('.md-ico[data-md-tool]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdTool === st.tool);
    });
    document.querySelectorAll('[data-md-otab]').forEach(function (b) {
      b.classList.toggle('on', (b.dataset.mdOtab || 'all') === (st.outlineTab || 'all'));
    });
    document.querySelectorAll('[data-md-stab]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdStab === (st.shelfTab || 'poly'));
    });
    /* 组件模式条：五个图标 + 标题右侧的当前模式 + 对象/多组件页签 */
    document.querySelectorAll('.md-mode[data-md-selmode]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdSelmode === st.selMode);
    });
    var tbMode = $('mdTbMode');
    if (tbMode) tbMode.textContent = tbModeLabel();
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

  /* 大纲里固定这几行是 Maya 的默认节点：视图行可点击切换相机，
   * 灯光集 / 对象集没有对应后端，保持禁用占位。 */
  var FAKE_OUTLINE = [
    { name: 'persp', type: '视图' },
    { name: 'top', type: '视图' },
    { name: 'front', type: '视图' },
    { name: 'side', type: '视图' },
    { name: 'defaultLightSet', type: '集' },
    { name: 'defaultObjectSet', type: '集' }
  ];
  var OUTLINE_VIEW = { persp: 'iso', top: 'top', front: 'front', side: 'right' };

  /* B2b：大纲每行是一个**真节点**，行内是「名字 + 类型 + 面数 + 可见性」。
   * 行高亮跟着 doc.activeNodeId 走（不是 st.selected —— 那是老的单对象下标）。
   * 面数是**该节点自己的**，不能用 statsNow()（那是激活对象的）。
   * 父子 / 组 / 拖拽重排是 B2b 的 UI 扩展，先不进来。 */
  function paintOutline() {
    var list = $('mdOutlineList');
    if (!list || !st.doc) return;
    if (!st.nodeIds) st.nodeIds = [];
    var q = String(st.outlineQuery || '').trim().toLowerCase();
    var tab = st.outlineTab || 'all';
    var countEl = $('mdOutlineCount');
    if (countEl) countEl.textContent = st.doc.nodes.length + ' 个对象';
    if (tab === 'help') {
      list.innerHTML = '<div class="md-note">显示：列出相机与全部对象<br>隐藏：只看隐藏对象<br>关卡：分组管理对象（显隐 / 锁定 / 单关导出）<br>双击对象行可重命名；搜索框按名称过滤。</div>';
      return;
    }
    if (tab === 'levels') {
      list.innerHTML = paintLevelsPanel();
      return;
    }
    var rows = tab === 'all' ? FAKE_OUTLINE.filter(function (f) {
      return !q || f.name.toLowerCase().indexOf(q) >= 0;
    }).map(function (f) {
      var vk = f.type === '视图' ? OUTLINE_VIEW[f.name] : null;
      return '<button type="button" class="md-part-row fake' + (vk ? ' view' : '') + '"' +
        (vk ? ' data-md-view="' + vk + '" title="切换到 ' + esc(f.name) + ' 视图"' : ' disabled') + '>' +
        '<i class="' + (f.type === '视图' ? 'md-vicon' : 'md-ficon') + '"></i>' +
        '<span class="md-part-id">' + esc(f.name) + '</span>' +
        '<span class="md-part-shape">' + esc(f.type) + '</span>' +
        '</button>';
    }).join('') : '';
    rows += st.doc.nodes.map(function (n) {
      if (q && String(n.name).toLowerCase().indexOf(q) < 0) return '';
      var vis = n.visible !== false;
      if (tab === 'hidden' && vis) return '';
      var faces = 0;
      try {
        var m = SeedModel.Scene.getMesh(st.doc, n);
        faces = m ? SeedModel.Mesh.stats(m).faces : 0;
      } catch (e) {}
      var isAct = n.id === st.doc.activeNodeId;
      var inMulti = st.nodeIds && st.nodeIds.indexOf(n.id) >= 0;
      /* 带组件身份的节点要和普通网格分开：图标换组件图标、第三列写「组件」。
       * 第三列不写零件名 —— 名称列已经是 def.name 了（添加时自动命名），再写一遍只是重复。
       * 组件源被删 / 改名时回落成 id 原文，**不能画成空白**：空白和「本来没有组件」
       * 长得一样，用户只会以为这个对象坏了。 */
      var cid = (n.comp && n.comp.id) ? String(n.comp.id) : '';
      var cdef = cid ? componentDefById(cid) : null;
      var kindTxt = vis ? (cid ? '组件' : '网格') : '隐藏';
      var tip = cid ? '组件：' + (cdef ? cdef.name : cid + '（组件源未加载）') : '';
      /* 关卡徽标：子关卡对象在对象行标出归属（主关卡不标，省视觉噪音） */
      var lvId = SeedModel.Scene.nodeLevelId(st.doc, n.id);
      var lvTag = '';
      if (lvId && lvId !== 'main') {
        var lv = SeedModel.Scene.levelById(st.doc, lvId);
        if (lv) {
          lvTag = '<b class="md-lvtag' + (lv.locked ? ' lock' : '') + '" title="所属关卡：' + esc(lv.name) + '">' +
            esc(lv.name.slice(0, 4)) + (lv.locked ? ' 🔒' : '') + '</b>';
        }
      }
      return '<button type="button" class="md-part-row' + (cid ? ' comp' : '') +
        (isAct ? ' sel' : '') + (inMulti && !isAct ? ' multi' : '') + (vis ? '' : ' off') +
        '" data-md-node="' + esc(n.id) + '"' +
        (cid ? ' data-md-comp-row="' + esc(cid) + '"' : '') +
        (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
        '<i class="' + (cid ? 'md-cicon' : 'md-nicon') + '"></i>' +
        '<span class="md-part-id">' + esc(n.name) + '</span>' +
        '<span class="md-part-shape">' + esc(kindTxt) + '</span>' +
        lvTag +
        '<em>' + faces + ' 面</em>' +
        '</button>';
    }).join('');
    list.innerHTML = rows || '<div class="md-note">' + (tab === 'hidden' ? '没有隐藏对象' : '没有匹配的节点') + '</div>';
  }

  /* ---------------- 关卡面板（对标 Unreal 的 Levels 窗口） ----------------
   * 关卡 = 节点引用清单，只做三件事：显隐（批量 node.visible）、锁定（拾取过滤）、
   * 单关导出 GLB。删关卡 = 对象回主关卡，任何操作都不丢网格数据。 */
  function paintLevelsPanel() {
    if (!st.doc) return '<div class="md-note">没有文档</div>';
    var S = SeedModel.Scene;
    var selCount = (st.nodeIds || []).length;
    var rows = '<div class="md-lvrow main">' +
      '<span class="md-lvname">主关卡</span>' +
      '<span class="md-lvmeta">' + S.levelNodeIds(st.doc, 'main').length + ' 个未分配对象</span>' +
      '</div>';
    S.levelsOf(st.doc).forEach(function (lv) {
      var cnt = (lv.nodes || []).length;
      var isTgt = st.levelsTargetId === lv.id;
      rows += '<div class="md-lvrow' + (lv.visible ? '' : ' off') + (lv.locked ? ' lock' : '') + (isTgt ? ' tgt' : '') + '">' +
        '<button type="button" class="md-lvname" data-md-lv="rename" data-md-lvid="' + esc(lv.id) + '" title="点击重命名">' + esc(lv.name) + '</button>' +
        '<span class="md-lvmeta">' + cnt + ' 对象</span>' +
        '<button type="button" class="md-lvbtn' + (isTgt ? ' on' : '') + '" data-md-lv="pick" data-md-lvid="' + esc(lv.id) + '" title="设为「移入目标」">☑</button>' +
        '<button type="button" class="md-lvbtn" data-md-lv="vis" data-md-lvid="' + esc(lv.id) + '" title="' + (lv.visible ? '隐藏整关' : '显示整关') + '">' + (lv.visible ? '👁' : '🚫') + '</button>' +
        '<button type="button" class="md-lvbtn" data-md-lv="lock" data-md-lvid="' + esc(lv.id) + '" title="' + (lv.locked ? '解锁（恢复拾取编辑）' : '锁定（不可拾取/变换）') + '">' + (lv.locked ? '🔒' : '🔓') + '</button>' +
        '<button type="button" class="md-lvbtn" data-md-lv="export" data-md-lvid="' + esc(lv.id) + '" title="只把这一关导出为 GLB">⬇</button>' +
        '<button type="button" class="md-lvbtn del" data-md-lv="delete" data-md-lvid="' + esc(lv.id) + '" title="删除关卡（对象全部回主关卡，不删数据）">✕</button>' +
        '</div>';
    });
    rows += '<div class="md-lvops">' +
      '<button type="button" class="md-lvop" data-md-lv="create">＋ 新建关卡</button>' +
      '<button type="button" class="md-lvop" data-md-lv="assign" ' + (selCount ? '' : 'disabled') + ' title="把选中的对象移入选中的关卡（点关卡名选中）">移入选中对象（' + selCount + '）</button>' +
      '<button type="button" class="md-lvop" data-md-lv="unassign" ' + (selCount ? '' : 'disabled') + '>选中对象移回主关卡</button>' +
      '</div>' +
      '<div class="md-note">锁定 = 对象不可被视口拾取 / 变换（数据不动）。删除关卡只是解除分组，对象原样保留。</div>';
    return rows;
  }

  /* 关卡显隐 / 删关后的轻量同步：node.visible → pivot.visible。
   * 不走 rebuildModel（那是重量级全量重建）；关卡显隐只改每个 pivot 的开关。 */
  function syncNodeVisibilities() {
    if (!st.doc) return;
    SeedModel.Scene.nodesOf(st.doc).forEach(function (n) {
      var pv = st.pivots && st.pivots[n.id];
      if (pv) pv.visible = n.visible !== false;
    });
    paintOutline();
  }

  /* 单关导出 GLB（Unreal 的 Save Level）：只带这一关的对象 + 按关裁剪的 seedModel。 */
  async function exportLevelBytesImpl(levelId) {
    var restoreTex = glbTexSwap();
    var buf, docJson;
    try {
      EXPORT_LEVEL = levelId || null;
      buf = await currentGLB();
      docJson = exportDocJson(buf, levelId || null);
    } finally {
      EXPORT_LEVEL = null;
      restoreTex();
    }
    var withExtras = SeedGLB.injectSeedModel(buf, docJson);
    return { buffer: buf, docJson: docJson, dataURL: SeedGLB.toDataURL(withExtras) };
  }

  async function exportLevelGLB(lvid) {
    if (!st.doc || st.busy) return { ok: false };
    var S = SeedModel.Scene;
    var lv = S.levelById(st.doc, lvid);
    var ids = S.levelNodeIds(st.doc, lvid);
    if (!lv) return { ok: false };
    if (!ids.length) { setStatus('「' + lv.name + '」里没有对象可导出', true); return { ok: false }; }
    st.busy = true;
    var name = String(st.doc.name || 'model').replace(/[\\/:*?"<>|]/g, '_') +
      '_' + String(lv.name).replace(/[\\/:*?"<>|]/g, '_');
    setStatus('正在导出关卡「' + lv.name + '」…');
    try {
      var dataURL = (await exportLevelBytesImpl(lvid)).dataURL;
      var d = global.openagiDesktop;
      if (!d || typeof d.fileSave !== 'function') {
        Model3D.saveDataURL(name + '.glb', dataURL);
        setStatus('网页版没有磁盘写入权限，已改为下载关卡 GLB（' + ids.length + ' 个对象）');
        return { ok: true, downloaded: true };
      }
      var r = await d.fileSave({ name: name + '.glb', ext: 'glb', dataURL: dataURL });
      if (r && r.cancelled) { setStatus('已取消导出'); return { ok: false, cancelled: true }; }
      if (!(r && r.ok)) throw new Error((r && r.message) || '写入失败');
      setStatus('已导出关卡「' + lv.name + '」（' + ids.length + ' 个对象）到：' + r.path);
      return { ok: true, path: r.path };
    } catch (e) {
      var msg = (e && e.message) || String(e);
      setStatus('关卡导出失败：' + msg, true);
      return { ok: false, error: msg };
    } finally {
      st.busy = false;
    }
  }

  /* 关卡面板的当前「移入目标」（点关卡名选中，Assign 落到这里） */
  function levelsPanelAction(act, lvid) {
    if (!st.doc) return;
    var S = SeedModel.Scene;
    if (act === 'create') {
      var lv = S.levelCreate(st.doc, '');
      if (lv) { setStatus('已新建「' + lv.name + '」：选中对象后点「移入选中对象」'); }
      paintOutline();
      return;
    }
    if (act === 'rename') {
      var target = S.levelById(st.doc, lvid);
      if (!target) return;
      var nm = window.prompt('关卡名称：', target.name);
      if (nm != null && S.levelRename(st.doc, lvid, nm)) paintOutline();
      return;
    }
    if (act === 'vis') {
      var target2 = S.levelById(st.doc, lvid);
      if (!target2) return;
      S.levelSetVisible(st.doc, lvid, !target2.visible);
      syncNodeVisibilities();
      paintOutline();
      return;
    }
    if (act === 'lock') {
      var target3 = S.levelById(st.doc, lvid);
      if (!target3) return;
      target3.locked = !target3.locked;
      paintOutline();
      return;
    }
    if (act === 'delete') {
      var target4 = S.levelById(st.doc, lvid);
      if (!target4) return;
      var back = S.levelDelete(st.doc, lvid);
      setStatus('已删除「' + target4.name + '」，' + back + ' 个对象回到主关卡');
      syncNodeVisibilities();
      paintOutline();
      return;
    }
    if (act === 'assign') {
      var tgtId = st.levelsTargetId;
      if (!tgtId || !S.levelById(st.doc, tgtId)) { setStatus('先点一个关卡名（选中它作为移入目标）', true); return; }
      var moved = S.levelAssign(st.doc, tgtId, (st.nodeIds || []).slice());
      if (moved) setStatus('已把 ' + (st.nodeIds || []).length + ' 个对象移入「' + S.levelById(st.doc, tgtId).name + '」');
      paintOutline();
      return;
    }
    if (act === 'unassign') {
      S.levelUnassign(st.doc, (st.nodeIds || []).slice());
      paintOutline();
      return;
    }
    if (act === 'export') {
      exportLevelGLB(lvid);
      return;
    }
    if (act === 'pick') {
      /* 「☑」= 设为「移入目标」：之后点「移入选中对象」就把当前选择落进这一关 */
      var lv5 = S.levelById(st.doc, lvid);
      if (!lv5) return;
      st.levelsTargetId = lvid;
      paintOutline();
      setStatus('移入目标 = 「' + lv5.name + '」：选中对象后点「移入选中对象」');
      return;
    }
  }

  /* 大纲 / 视口共用的对象选择入口。
   * how = replace（默认：点谁选谁）/ add（Shift 追加）/ toggle（Ctrl 切换）/ remove。
   * Node 2 兼容：老调用点还是传布尔值，true 按 add 处理。
   * 空选是合法状态：没有选中对象时激活对象保持不变（大纲高亮 / 属性面板仍指向它），
   * 但变换手柄与对象高亮收起。 */
  function selectNodeById(id, how) {
    if (!st.doc || !id) return false;
    var mode = (how === 'add' || how === 'toggle' || how === 'remove' || how === 'replace')
      ? how : (how ? 'add' : 'replace');
    return applyNodeSelection([id], mode, id);
  }

  /* 批量提交对象选择（视口点选 / 框选 / 套索 / 大纲 / 菜单全选都走这里）。
   * 只改 st.nodeIds 与激活对象；选择集变化 → 组件选择清空（旧 ID 在新网格里没有意义）。 */
  function applyNodeSelection(ids, how, activeHint) {
    if (!st.doc) return false;
    var nodes = SeedModel.Scene.nodesOf(st.doc);
    var alive = Object.create(null);
    nodes.forEach(function (n) { alive[n.id] = 1; });
    var list = [];
    (ids || []).forEach(function (id) {
      id = String(id);
      if (alive[id] && list.indexOf(id) < 0) list.push(id);
    });
    /* 锁定关卡的对象不可选中（Unreal 的 Level Lock 语义）：视口单点 / 框选 /
     * 套索 / 大纲 / 全选全部走这里 —— 总闸一处过滤，锁定对象就摸不到变换手柄。 */
    var locked = null;
    try {
      var lids = SeedModel.Scene.lockedNodeIds(st.doc);
      if (lids && lids.length) {
        locked = Object.create(null);
        lids.forEach(function (id) { locked[id] = 1; });
      }
    } catch (e) { locked = null; }
    if (locked) {
      var blocked = 0;
      var un = [];
      list.forEach(function (id) {
        if (locked[id]) { blocked++; return; }
        un.push(id);
      });
      if (blocked && un.length !== list.length) setStatus('有 ' + blocked + ' 个对象在锁定关卡里，不可选中', true);
      list = un;
    }
    var cur = (st.nodeIds || []).filter(function (id) { return alive[id]; });
    var next;
    if (how === 'add') {
      next = cur.slice();
      list.forEach(function (id) { if (next.indexOf(id) < 0) next.push(id); });
    } else if (how === 'toggle') {
      next = cur.slice();
      list.forEach(function (id) {
        var at = next.indexOf(id);
        if (at >= 0) next.splice(at, 1); else next.push(id);
      });
    } else if (how === 'remove') {
      next = cur.filter(function (id) { return list.indexOf(id) < 0; });
    } else {
      next = list.slice();
    }

    var curActive = (st.node && alive[st.node.id]) ? st.node.id : (st.doc.activeNodeId || '');
    var target;
    if (!next.length) {
      /* 空选合法：不把激活对象塞回选择集。激活对象单独保存（doc.activeNodeId），
       * 所以属性面板 / 大纲仍有落点，手柄和高亮由 syncGizmo / paintObjectSelection 收起。 */
      target = curActive;
    } else if (activeHint && next.indexOf(activeHint) >= 0) {
      target = activeHint;
    } else if (next.indexOf(curActive) >= 0) {
      target = curActive;
    } else {
      target = next[next.length - 1];
    }
    if (!target && next.length) target = next[next.length - 1];

    /* 换激活对象之前，先把控制器里没提交的改动落掉：
     * activeChanged 会重建整个视口，缓存网格被丢弃，之后再 setMesh 写的已经是新对象。 */
    compTxnCommit();

    var activeChanged = !!target && st.doc.activeNodeId !== target;
    if (activeChanged && !SeedModel.Scene.setActiveNode(st.doc, target)) return false;
    st.nodeIds = next;
    if (activeChanged) {
      st.sel = { vertexIds: [], edgeIds: [], faceIds: [] };
      st.hoverPick = null;
      rebuildModel(true);
    }
    syncSelectionDoc();
    paintAll();
    if (!next.length) {
      setStatus('选择已清空（0 个对象）');
    } else if (next.length > 1) {
      setStatus('已选 ' + next.length + ' 个对象（激活：' + (st.node ? st.node.name : target) + '）');
    } else if (activeChanged) {
      setStatus('已激活：' + (st.node ? st.node.name : target));
    }
    return true;
  }

  /* ---------------- 全选 / 反选 / 清除（Ctrl+A · Ctrl+I · Esc） ----------------
   * 三条命令对五种模式都成立：对象模式改 nodeIds，组件模式改对应的 ID 列表。 */
  function allNodeIds() {
    if (!st.doc) return [];
    return SeedModel.Scene.nodesOf(st.doc).filter(function (n) {
      return st.pivots[n.id] && ISO.nodeVisible(n.id);
    }).map(function (n) { return n.id; });
  }

  function allComponentIds() {
    if (!st.mesh) return [];
    if (st.selMode === 'vertex') return st.mesh.vertexIds.slice();
    if (st.selMode === 'edge') {
      return SeedModel.Mesh.ensureEdges(st.mesh).edges.map(function (e) { return e.id; });
    }
    return st.mesh.faceIds.slice();
  }

  function selectAll() {
    if (!st.doc) return 0;
    if (st.selMode === 'object') {
      var ids = allNodeIds();
      if (!ids.length) { setStatus('没有可选对象', true); return 0; }
      applyNodeSelection(ids, 'replace', ids[0]);
      setStatus('已全选 ' + ids.length + ' 个对象');
      return ids.length;
    }
    var all = allComponentIds();
    st.sel[selKey()] = all;
    syncSelectionDoc();
    paintSelection();
    paintAll();
    setStatus('已全选 ' + all.length + ' 个' + SEL_NOUN[st.selMode]);
    return all.length;
  }

  function invertSelection() {
    if (!st.doc || !st.mesh) return 0;
    if (st.selMode === 'object') {
      var cur = st.nodeIds || [];
      var next = allNodeIds().filter(function (id) { return cur.indexOf(id) < 0; });
      applyNodeSelection(next, 'replace', next[0]);
      setStatus(next.length ? ('已反选 ' + next.length + ' 个对象') : '反选后没有对象（已清空选择）');
      return next.length;
    }
    var all = allComponentIds();
    var have = Object.create(null);
    (st.sel[selKey()] || []).forEach(function (id) { have[id] = 1; });
    var inv = all.filter(function (id) { return !have[id]; });
    st.sel[selKey()] = inv;
    syncSelectionDoc();
    paintSelection();
    paintAll();
    setStatus(inv.length ? ('已反选 ' + inv.length + ' 个' + SEL_NOUN[st.selMode]) : '反选后没有' + SEL_NOUN[st.selMode]);
    return inv.length;
  }

  function clearSelection() {
    if (!st.doc) return 0;
    st.hoverPick = null;
    if (st.selMode === 'object') {
      /* 对象模式也能空选：清掉 nodeIds，激活对象保留给属性面板 / 组件入口。
       * 手柄 / 对象高亮由 syncGizmo / paintObjectSelection 跟着选择集收起。 */
      applyNodeSelection([], 'replace');
      setStatus('选择已清空');
      return 0;
    }
    st.sel[selKey()] = [];
    syncSelectionDoc();
    paintSelection();
    paintAll();
    setStatus('选择已清空');
    return 0;
  }

  function slotHtml() {
    var mats = (st.doc && st.doc.materials) || {};
    var names = mats.slotNames || [];
    var colors = mats.slotColors || [];
    if (!names.length) return '<div class="md-note">还没有材质槽名</div>';
    /* 材质库是文档级的，但槽是「当前对象自己的」：
     * 两个模型置于到同一场景时，这里只列当前对象用到的槽，避免误改别人的材质。 */
    var owned = [];
    try { owned = st.doc && st.node ? SeedModel.Scene.slotsOf(st.doc, st.node) : []; } catch (e) { owned = []; }
    if (!owned.length) owned = names.map(function (_, i) { return i; });
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
    var rows = owned.map(function (i) {
      var dis = selN ? '' : ' disabled';
      return '<div class="md-slot" data-md-slotrow="' + i + '">' +
        '<input type="color" class="md-slot-c" data-md-slot="' + i + '" data-md-slotf="color" value="' + esc(colors[i] || '#c9ccd4') + '" title="槽颜色">' +
        '<input type="text" class="md-slot-n" data-md-slot="' + i + '" data-md-slotf="name" value="' + esc(names[i] || ('插槽 ' + (i + 1))) + '" maxlength="60" title="双击改名，回车确认">' +
        '<em class="md-slot-f" title="该槽的面数">' + (counts[i] || 0) + '</em>' +
        '<button class="md-slot-a" data-md-act="slot-assign" data-md-slot="' + i + '"' + dis + ' title="把当前选中的面指派到这个槽">指派</button>' +
        '<button class="md-slot-x" data-md-act="slot-del" data-md-slot="' + i + '"' + (owned.length <= 1 ? ' disabled' : '') + ' title="从当前对象删除该槽">✕</button>' +
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
      componentSectionHtml(),
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
      '<div class="md-note">对象级变换 + 点 / 边 / 面 / UV 岛拾取（F8–F12）：Shift 加选、Ctrl 切换（减选），' +
      '拖出矩形 = 框选、按住画一圈 = 套索；对象模式同样支持框选与 Shift/Ctrl 多选，' +
      '选中的对象在视口里画包围盒（激活对象亮蓝、其余淡蓝）。' +
      '全选 / 反选 / 清除见「选择」菜单（Ctrl+A / Ctrl+I / Esc），选择集写进文档。</div>',
      '</div>',
      '</div>'
    ].join('');
  }

  /* 属性面板里的「组件」区：只有带 comp 身份的节点才有。
   * 这是「流明头模不是普通网格」在 UI 上的落点 —— 它一直知道自己是谁、有哪套参数，
   * 而且能从这里直接调（控制器改的就是这个对象，不新增、不重建）。
   *
   * 有 panel 的组件把 panel 直接嵌进来（= 控制器），不再重复画 props 摘要 ——
   * 摘要说的是「现在什么表情」，panel 里的 chips 已经在说同一件事，两处并排只会打架。 */
  function componentSectionHtml() {
    var node = st.node;
    if (!node || !node.comp || !node.comp.id) return '';
    var def = componentDefById(node.comp.id);
    var info = (def && typeof def.info === 'function') ? def.info() : null;
    var hasPanel = !!(def && typeof def.panel === 'function');
    var detail = '';
    if (!def) {
      detail = '<div class="md-note">组件源「' + esc(node.comp.id) + '」未加载，参数只读。</div>';
    } else if (!hasPanel && typeof def.props === 'function') {
      detail = def.props(node) || '';
    }
    var src = info && info.source ? String(info.source) : '';
    if (src.length > 64) src = src.slice(0, 61) + '…';
    return '<div class="md-sec">' +
      '<div class="md-h2">组件</div>' +
      '<div class="md-sec-b">' +
      '<div class="md-md-name">' + esc(def ? def.name : node.comp.id) +
        '<em>' + esc(def ? (def.note || '') : '') + '</em></div>' +
      detail +
      /* 控制器容器：data-md-ctl 带着节点 id，事件回到 componentEvent(type, el, nodeId)。
       * 容器 id 只用于「重铺这一块」，不参与选择逻辑。 */
      '<div class="md-ctl" data-md-ctl="' + esc(node.id) + '">' + controllerHtml(node) + '</div>' +
      (info ? '<div class="md-note">来源 ' + esc(src || '—') + ' · 许可 ' + esc(info.license || '—') +
        '<br>' + (info.verts || 0) + ' 点 · ' + (info.morphs || 0) + ' 个形态键 · ' +
        (info.groups || 0) + ' 个材质槽</div>' : '') +
      '<button type="button" class="md-wide" data-md-act="comp-edit"' +
        (def ? '' : ' disabled') + '>' + (hasPanel ? '在大面板里编辑（带预览）' : '调整组件属性') + '</button>' +
      '</div></div>';
  }

  function updateHud() {    if (!st.hudEl || !st.doc) return;
    var s = statsNow();
    var t = st.node ? st.node.transform : null;
    st.hudEl.innerHTML =
      '<span>revision <b>' + st.doc.revision.current + '</b></span>' +
      '<span>网格 <b>' + st.doc.revision.mesh + '</b></span>' +
      '<span><b>' + s.vertices + '</b> 点 / <b>' + s.faces + '</b> 面 / <b>' + s.edges + '</b> 边</span>' +
      '<span>视图 <b>' + (st.quad ? quadViewText() : (st.viewName || '透视')) + '</b></span>' +
      '<span>着色 <b>' + shadeLabel(st.shading) + (vfOn('wireframe') ? ' + 线框' : '') + '</b></span>' +
      '<span>选择 <b>' + SEL_NOUN[st.selMode] +
        (st.selMode === 'object' ? ' ' + (st.nodeIds ? st.nodeIds.length : 0) : ' ' + selCount()) +
        (st.selMode === 'island' && st.sel.faceIds.length ? '（' + selectedIslandCount() + ' 岛）' : '') +
        '</b></span>' +
      (t ? '<span>位置 <b>' + t.position.map(fmt).join(', ') + '</b></span>' +
        '<span>缩放 <b>' + t.scale.map(fmt).join(', ') + '</b></span>' : '');
  }

  function paintAll() {
    /* 视口的一切可见状态几乎都会走这里重画（选择 / 撤销 / 换对象 / 拓扑），
     * 按需渲染下它就是「请求下一帧」的统一入口。 */
    requestRender(0);
    paintOutline();
    paintParams();
    updateHud();
    updateChrome();
    /* 对象多选高亮跟选择集走：大纲 / 视口 / 菜单三处入口都只改 st.nodeIds，
     * 统一在这里重画，免得每个调用点各记一次。 */
    paintObjectSelection();
    /* 手柄目标也跟着选择集走：空选要收起、多选切换激活对象要换宿主。
     * 以前只有 paintSelection 会调 syncGizmo，空选 / 大纲换对象时手柄会留在原地。 */
    syncGizmo();
    /* UV 窗口打开时跟着外部选择 / 撤销 / 换对象刷新；uvRefresh 自己会做同步判断，
     * 不会反过来触发 paintAll，所以这里不存在递归。 */
    if (st.uv.open) uvRefresh();
    /* 绘画页签的材质槽下拉跟着当前对象 / 材质变化刷新（签名相同直接返回） */
    if (st.tbKind === 'paint') { syncPaintSlots(); updatePaintUi(); }
  }

  /* ---------------- 选择（S1 拾取 + 高亮） ----------------
   * 拾取算法在 js/seed-selection.js（纯函数、不碰 DOM）；这里只负责
   * 「模式、ID 集合、高亮几何、写回文档」四件事。
   * 选择集存 ID 不存下标：拓扑一变下标就错位，而 ID 由网格内核保证永不复用。 */
  var SEL_NOUN = { object: '对象', vertex: '顶点', edge: '边', face: '面', island: 'UV 岛' };
  /* UV 岛用青绿，和面（橙）分开：岛模式下选中的其实是一整块面，颜色必须能说明
   * 「这是按岛选的」，否则和面模式的高亮看起来一模一样。 */
  var SEL_COLOR = { vertex: 0xf59e0b, edge: 0x38bdf8, face: 0xf59e0b, island: 0x2dd4bf };

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

  /* ---------------- 对象选择高亮（多选） ----------------
   * 对象模式没有「组件」可画，最容易出现「选了但看不出来」。
   * 这里给**次选对象**画一圈包围盒棱（淡蓝）：激活对象已经有变换手柄 + 大纲高亮，
   * 再给它套一层盒线只会盖住自己的棱和顶点，反而看不清模型。
   * 每根棱框挂在自己的 pivot 上、用局部坐标：拖动 / 旋转 / 缩放对象时
   * 高亮天然跟着变换走，不需要每帧重建几何。 */
  var BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  function disposeObjectSelection() {
    if (!st.objSelGroup) return;
    st.objSelGroup.forEach(function (o) {
      if (o.parent) o.parent.remove(o);
      if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
      if (o.material) { try { o.material.dispose(); } catch (e) {} }
    });
    st.objSelGroup = null;
  }

  function solidOf(pv) {
    var solid = null;
    pv.traverse(function (o) {
      if (!solid && o.userData && o.userData.mdPart === 'solid' && o.geometry) solid = o;
    });
    return solid;
  }

  function localBoxOf(pv) {
    var solid = solidOf(pv);
    if (!solid) return null;
    var geo = solid.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    var b = geo.boundingBox;
    return (b && !b.isEmpty()) ? b : null;
  }

  function boxCorner(b, i, out) {
    return (out || new THREE.Vector3()).set(
      (i & 1) ? b.max.x : b.min.x,
      (i & 2) ? b.max.y : b.min.y,
      (i & 4) ? b.max.z : b.min.z
    );
  }

  /* 对象包围盒的 8 角 + 12 棱中点 + 中心（世界坐标），给对象框选 / 套索判定「在不在区域内」用 */
  function nodeBoxPoints(pv) {
    var solid = solidOf(pv);
    var b = localBoxOf(pv);
    if (!b) return null;
    var corners = [], i;
    for (i = 0; i < 8; i++) {
      corners.push(boxCorner(b, i).applyMatrix4(solid.matrixWorld));
    }
    var mids = BOX_EDGES.map(function (e) {
      return corners[e[0]].clone().add(corners[e[1]]).multiplyScalar(0.5);
    });
    var center = new THREE.Vector3();
    for (i = 0; i < 8; i++) center.add(corners[i]);
    center.multiplyScalar(1 / 8);
    return { corners: corners, mids: mids, center: center };
  }

  function paintObjectSelection() {
    disposeObjectSelection();
    if (!THREE || !st.doc || st.selMode !== 'object') return;
    var active = st.node ? st.node.id : '';
    var out = [];
    (st.nodeIds || []).forEach(function (id) {
      var pv = st.pivots[id];
      if (!pv || !pv.visible) return;
      if (id === active) return;      /* 激活对象由手柄表示，不再套盒线 */
      var b = localBoxOf(pv);
      if (!b) return;
      var buf = [];
      BOX_EDGES.forEach(function (e) {
        var a = boxCorner(b, e[0]), c = boxCorner(b, e[1]);
        buf.push(a.x, a.y, a.z, c.x, c.y, c.z);
      });
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
      geo.computeBoundingSphere();
      var lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0x2b7cd3,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false
      }));
      lines.renderOrder = 8;
      lines.frustumCulled = false;
      lines.userData.mdPart = 'objsel';
      pv.add(lines);
      out.push(lines);
    });
    st.objSelGroup = out.length ? out : null;
  }

  /* 高亮三件套：面（半透明罩）、边（穿透过）、点（深环 + 亮芯，和顶点层同构）
   * mesh 可传预览网格：挤出拖动时高亮要跟着预览的顶面走，不能停在旧位置 */
  function paintSelection(mesh) {
    disposeSelection();
    paintObjectSelection();
    var mm = mesh || st.mesh;
    if (!st.pivot || !mm) return;
    pruneSelection();
    /* 选择一变，软选择热力图的「种点」就变了：按新选择重算 / 隐藏 */
    refreshSoftHeat();
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
          color: st.selMode === 'island' ? SEL_COLOR.island : SEL_COLOR.face, transparent: true, opacity: 0.42,
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

    /* 预选幽灵：鼠标悬停在某个点 / 边 / 面上时先给一层淡高亮，点下去之前就知道会选中谁。
     * 只在「正式网格」上画（拖挤出时传进来的是预览网格，hover 没有意义）。
     * 画不出来说明那个 ID 已被拓扑改掉，顺手清掉预选。 */
    if (!mesh && st.hoverPick && !paintHoverGhost(mm, g, st.hoverPick)) st.hoverPick = null;

    /* 隔离显示时选择一变，替身网格跟着换（没选任何面就退回整只对象） */
    if (st.isolate) refreshIsoChild();
    if (!g.children.length) { syncGizmo(); return; }
    st.pivot.add(g);
    st.selGroup = g;
    syncGizmo();
  }

  /* 预选幽灵：只画形状，不进选择集。
   * 颜色刻意比选中态淡一档（面 0.20 / 边 0.9 / 点 0.85），避免和「已选中」混淆。 */
  function paintHoverGhost(mm, g, hp) {
    if (hp.kind === 'face') {
      var f = mm.faceIds.indexOf(hp.id);
      if (f < 0) return false;
      var s = mm.faceOffsets[f], e = mm.faceOffsets[f + 1], tris = [];
      for (var t = s + 1; t < e - 1; t++) {
        [mm.faceIndices[s], mm.faceIndices[t], mm.faceIndices[t + 1]].forEach(function (vi) {
          tris.push(mm.positions[vi * 3], mm.positions[vi * 3 + 1], mm.positions[vi * 3 + 2]);
        });
      }
      if (!tris.length) return false;
      var fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
      fg.computeBoundingSphere();
      var fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
        color: 0xffb74d, transparent: true, opacity: 0.20,
        depthWrite: false, side: THREE.DoubleSide
      }));
      fm.renderOrder = 5;
      fm.userData.mdPart = 'hover';
      g.add(fm);
      return true;
    }
    if (hp.kind === 'edge') {
      var edges = SeedModel.Mesh.ensureEdges(mm).edges, rec = null, i;
      for (i = 0; i < edges.length; i++) if (edges[i].id === hp.id) { rec = edges[i]; break; }
      if (!rec) return false;
      var eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute([
        mm.positions[rec.a * 3], mm.positions[rec.a * 3 + 1], mm.positions[rec.a * 3 + 2],
        mm.positions[rec.b * 3], mm.positions[rec.b * 3 + 1], mm.positions[rec.b * 3 + 2]
      ], 3));
      eg.computeBoundingSphere();
      var lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
        color: 0xfde68a, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false
      }));
      lines.renderOrder = 8;
      lines.frustumCulled = false;
      lines.userData.mdPart = 'hover';
      g.add(lines);
      return true;
    }
    if (hp.kind === 'vertex') {
      var vi = mm.vertexIds.indexOf(hp.id);
      if (vi < 0) return false;
      var vg = new THREE.BufferGeometry();
      vg.setAttribute('position', new THREE.Float32BufferAttribute([
        mm.positions[vi * 3], mm.positions[vi * 3 + 1], mm.positions[vi * 3 + 2]
      ], 3));
      vg.computeBoundingSphere();
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      var pts = new THREE.Points(vg, new THREE.PointsMaterial({
        color: 0xffd166, size: 9 * dpr, sizeAttenuation: false,
        transparent: true, opacity: 0.85, depthWrite: false, depthTest: false
      }));
      pts.renderOrder = 8;
      pts.frustumCulled = false;
      pts.userData.mdPart = 'hover';
      g.add(pts);
      return true;
    }
    return false;
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
    /* 对象模式空选：没有「选中对象」可挂手柄。激活对象还在（属性面板要用），
     * 但不能让手柄孤零零地挂在视口中央。 */
    if (st.selMode === 'object' && !(st.nodeIds || []).length) {
      st.compPivot.visible = false;
      st.gizmo.setTarget(null);
      return;
    }
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
  /* ---------------- 视口 3D 捏脸控制器 ----------------
   * 摆什么：激活节点带组件、组件自报 controls()、当前在主视口的建模页签。
   * 摆在哪：组件给的局部坐标（由资产顶点簇量出来的质心），这里只做 localToWorld ——
   *         所以对象被移动 / 缩放 / 旋转之后，杆自动跟着脸走，不需要任何重算。
   * 值从哪来：node.comp.params.weights（面板是唯一真源），拖动写回同一个地方。
   *
   * ⚠ 只在「建模页签 + 主视口」出现：
   *   绘画页签左键就是落笔，杆抢了事件就画不上；
   *   四视图一格一个相机，杆只认主相机，摆进去会在四格里画在错的地方。 */
  function ctrlAllowed() {
    if (st.tbKind === 'paint') return false;
    if (st.quad) return false;
    return !!(st.node && st.node.id);
  }

  /* ---------------- 视口捏脸控制器（流明同款） ----------------
   * 摆什么：激活节点是头模时，当前分组的**脸上操控点**（shapeInfo × anchors）。
   * 摆在哪：锚点是组件从资产顶点量出来的（网格局部坐标），这里只做投影 ——
   *         对象被移动 / 旋转之后，点自动跟着脸走。
   * 值从哪来：node.comp.params.shape（面板是唯一真源），拖动写回同一个地方。
   * 悬停 / 拖动时写 st.ctrlHi，每帧的 syncShapeOf 把线圈高亮（l3Hi/l3SelA）送进 shader。 */
  function ctrlItemsOf(node, info, anchors) {
    var shp = (node.comp.params && node.comp.params.shape) || {};
    return info.defs.map(function (d) {
      return {
        id: d.key, key: d.key, label: d.label, group: d.group,
        at: anchors[d.key] || null,
        value: Math.round(Number(shp[d.key]) || 50)
      };
    }).filter(function (x) { return !!x.at; });
  }

  function syncCtrlLayer() {
    var layer = st.ctrlLayer;
    if (!layer) return false;
    var node = st.node;
    var def = (node && node.comp && node.comp.id) ? componentDefById(node.comp.id) : null;
    var info = (def && ctrlAllowed() && ISO.nodeVisible(node.id) &&
      typeof def.shapeInfo === 'function') ? def.shapeInfo() : null;
    var anchors = (info && typeof def.shapeAnchors === 'function') ? def.shapeAnchors() : null;
    var host = (info && anchors && Object.keys(anchors).length) ? morphObjectOf(node.id) : null;
    var group = (info && typeof def.shapeGroup === 'function') ? def.shapeGroup() : null;
    var sig = host ? (node.id + '|' + info.defs.length + '|' + group) : '';
    if (sig === st.ctrlSig) { if (host) layer.setGroup(group); return !!host; }
    st.ctrlSig = sig;
    if (!host) { layer.clear(); return false; }
    layer.setItems(ctrlItemsOf(node, info, anchors));
    layer.setGroup(group);
    layer.setVisible(true);
    return true;
  }

  /* 值变了（面板滑杆 / 数值框 / 撤销 / 读盘 / 拖动手柄）只改数据；
   * 手柄位置每帧由 update() 重投影，值写在 items 里，update 顺带保持。 */
  function syncCtrlValues() {
    var layer = st.ctrlLayer;
    if (!layer || !st.node || layer.isDragging()) return;
    var node = st.node;
    var def = (node.comp && node.comp.id) ? componentDefById(node.comp.id) : null;
    if (!def || typeof def.shapeInfo !== 'function') return;
    var info = def.shapeInfo();
    var anchors = def.shapeAnchors();
    if (!anchors) return;
    var items = ctrlItemsOf(node, info, anchors);
    for (var i = 0; i < items.length; i++) layer.setValue(items[i].id, items[i].value);
  }

  /* 增益：该参数 +1 格时锚点在**屏幕上**的位移方向（照抄 gizmoGain 的投影半截）。
   * 组件给资产系的 (dx, dy)，这里乘 host 世界旋转、投影两点成像素。 */
  var CTRL_TMP = null;
  function ctrlGainOf(item) {
    var node = st.node;
    var def = (node && node.comp && node.comp.id) ? componentDefById(node.comp.id) : null;
    var host = morphObjectOf(node.id);
    if (!def || !host || !st.camera) return [0, 0];
    var g = def.shapeGain(item.key);
    if (!g || (!g[0] && !g[1])) return [0, 0];
    if (!CTRL_TMP) CTRL_TMP = { a: new THREE.Vector3(), b: new THREE.Vector3(), q: new THREE.Quaternion() };
    host.getWorldQuaternion(CTRL_TMP.q);
    CTRL_TMP.a.set(item.at[0], item.at[1], item.at[2]);
    /* ⚠ 增益只有两个分量 (dx, dy)：z 抄 g[2] 是 undefined → NaN，
     *   整条投影失效，拖动全部掉进 (dx−dy)×0.6 的兜底启发式。 */
    CTRL_TMP.b.set(item.at[0] + g[0], item.at[1] + g[1], item.at[2]);
    host.localToWorld(CTRL_TMP.a);
    host.localToWorld(CTRL_TMP.b);
    CTRL_TMP.a.project(st.camera);
    CTRL_TMP.b.project(st.camera);
    var r = st.canvas.getBoundingClientRect();
    return [
      (CTRL_TMP.b.x - CTRL_TMP.a.x) * 0.5 * r.width,
      -(CTRL_TMP.b.y - CTRL_TMP.a.y) * 0.5 * r.height
    ];
  }

  /* 投影 + 背面隐藏：点在「头中心」背面时就地藏起（照抄 projectAnchor 的 facing）。
   * 头中心用网格局部包围盒中心（rest 姿态不变，可以缓存）。 */
  var CTRL_FACING = null;
  function ctrlProjectAt(at) {
    var host = morphObjectOf(st.node.id);
    if (!host || !st.camera || !st.canvas) return null;
    if (!CTRL_FACING) CTRL_FACING = { w: new THREE.Vector3(), c: new THREE.Vector3(), dir: new THREE.Vector3(), p: new THREE.Vector3() };
    CTRL_FACING.w.set(at[0], at[1], at[2]);
    host.localToWorld(CTRL_FACING.w);
    var bb = host.geometry && host.geometry.boundingBox;
    if (bb) {
      CTRL_FACING.c.copy(bb.getCenter(CTRL_FACING.p));
      host.localToWorld(CTRL_FACING.c);
      CTRL_FACING.dir.copy(CTRL_FACING.w).sub(CTRL_FACING.c);
      st.camera.getWorldDirection(CTRL_FACING.p);
      /* 点在脸心中线之后就被脸挡住，不再显示手柄 */
      if (CTRL_FACING.dir.dot(CTRL_FACING.p) >= 0.015) return { x: 0, y: 0, visible: false };
    }
    CTRL_FACING.p.copy(CTRL_FACING.w).project(st.camera);
    var r = st.canvas.getBoundingClientRect();
    var host2 = st.stage ? st.stage.getBoundingClientRect() : r;
    return {
      x: r.left + (CTRL_FACING.p.x * 0.5 + 0.5) * r.width - host2.left,
      y: r.top + (-CTRL_FACING.p.y * 0.5 + 0.5) * r.height - host2.top,
      visible: CTRL_FACING.p.z < 1
    };
  }

  /* 悬停 / 拖动 → 线圈高亮。strength 口径照抄流明：悬停 0.5 / 拖动 0.85。 */
  function ctrlHi(it, strength) {
    st.ctrlHi = it ? { key: it.key, strength: strength } : null;
    requestRender(60);
  }

  /* 拖动 / 悬停时状态栏说清楚「这个点是什么、现在多少」。
   * 不走 setStatus（它 4.2 秒自动清空）：悬停要一直显示，离开才收。 */
  function ctrlStatus(it) {
    if (!st.statusEl) return;
    clearTimeout(st.statusTimer);
    st.statusEl.classList.remove('err');
    st.statusEl.textContent = it
      ? (it.label + ' · ' + Math.round(it.value || 0) +
        '（50 = 原始 · 顺着箭头方向拖 · 双击恢复）')
      : '';
  }

  function ctrlSend(item, v, type) {
    if (!item || !st.node || !st.node.comp) return;
    var pct = Math.round(v < 0 ? 0 : (v > 100 ? 100 : v));
    dispatchComponent({ type: type, act: 'shape', arg: item.key, value: pct, el: null }, st.node.id);
    if (type === 'change') compTxnCommit();
  }

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
        /* 热力图是三角面展开的独立层：顶点被拖动时按 mdSoftPick 回写坐标，
         * 权重不重算（和 Blender 一样，一次拖动的衰减在按下时就定住）。 */
        if (o.userData && o.userData.mdSoftPick && o.geometry) {
          var sg = o.geometry.attributes.position;
          if (sg) {
            var sp = o.userData.mdSoftPick, sa = sg.array;
            for (var q = 0; q < sp.length; q++) {
              var so = sp[q] * 3, sr = q * 3;
              sa[sr] = st.mesh.positions[so];
              sa[sr + 1] = st.mesh.positions[so + 1];
              sa[sr + 2] = st.mesh.positions[so + 2];
            }
            sg.needsUpdate = true;
            o.geometry.computeBoundingSphere();
          }
        }
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
    /* 对象多选要整组落盘：以前只存激活对象，重开文档多选就丢了。
     * 空选也是要保存的状态：不能因为存在激活对象就补回 1 个，
     * 否则「点空白清空选择 → 保存 → 重开」会自己恢复成选中。 */
    var ids = (st.nodeIds || []).slice();
    if (ids.length && st.node && ids.indexOf(st.node.id) < 0) ids.push(st.node.id);
    SeedModel.Scene.setSelection(st.doc, {
      mode: st.selMode,
      nodeIds: ids,
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
    var alive = Object.create(null);
    (SeedModel.Scene.nodesOf(doc) || []).forEach(function (n) { alive[n.id] = 1; });
    st.nodeIds = (Array.isArray(s.nodeIds) ? s.nodeIds : []).filter(function (id) {
      return alive[String(id)];
    }).map(String);
    /* 不补激活对象：空选是文档里明确保存过的状态，重开要原样恢复 */
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
    st.hoverPick = null;      /* 预选是「当前模式」的概念，换模式必须作废 */
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
    var R = 22;
    if (st.tbKind === 'paint') {
      /* 光圈 = 笔刷设置的屏幕直径：固定屏幕空间尺寸，不随落点深度 / texel 密度忽大忽小。
       * 落笔时 md-paint 会把同一屏幕尺寸换算成贴图尺寸，所以圈和笔迹仍然对得上。 */
      R = Math.max(3, st.paint.size * 0.5);
    }
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
  /* 预览纹理的唯一上传通道：画笔工作副本与混合合成图共用，只传脏块。
   * 放在这里而不是各模块内部 new，是为了让「一张纹理只有一个上传者」。 */
  var UPLOAD = global.MDPaintUpload ? global.MDPaintUpload.create({
    renderer: function () { return st.renderer; }
  }) : null;

  var PAINT = global.MDPaint.create({
    st: st, THREE: THREE, SeedModel: SeedModel,
    sharedTexture: sharedTexture,
    upload: UPLOAD,
    setStatus: setStatus, updateChrome: updateChrome,
    rebuildModel: rebuildModel, paintAll: paintAll,
    uvRefreshSolidGeometry: uvRefreshSolidGeometry,
    /* 修改器生效时不能给求值网格「补 UV」：那份网格是 evaluator 的缓存 */
    nodeModsActive: nodeModsActive,
    /* 绘画和拾取共用同一条可见性口径：面级隔离时画到的就是视口里那份替身网格 */
    visibleMesh: function (id) { return ISO.visibleMesh(id); },
    /* 拾取的剔背面口径跟视口一致：显示里「背面」开着（默认）就是双面渲染，
     * 此时不能按绕序剔面，否则统一法线把开口网格翻到内侧后笔只能落到远面。 */
    cullBackfaces: function () { return !vfOn('backface'); },
    paintScope: function (mesh) { return ISO.paintScope(mesh); },
    totalBytes: totalBytes, syncBytes: syncBytes, historyBudget: HISTORY_BUDGET,
    /* 材质落点与纹理混合：笔迹画在基础画布上，材质上挂的是「合成结果」 */
    applySlotTexture: applySlotTexture,
    baseImageFor: function (slot) { return MIX ? MIX.baseImageFor(slot) : null; },
    /* 纹理混合的合成图（底座 + 图层）。绘画工作副本**不能**拿它当底座：
     * 那会把图层像素永久烙进工作副本，之后隐藏 / 删除图层时
     * composeAndApply 会把这个工作副本当成最终像素（adoptPaintCanvas），颜色退不掉。 */
    composedImageFor: function (slot) {
      return (MIX && MIX.composedCanvas) ? MIX.composedCanvas(slot) : null;
    },
    /* 底图兜底：材质上真正挂着的那张（贴图只挂在 map 上、slotMaps 是空的老资产） */
    liveSlotImage: liveSlotImage,
    /* 这一槽的底图还在解码：绘画据此拒绝建平铺底工作副本（吸管吸白 / 抬笔洗白模型） */
    baseLoading: slotBaseLoading,
    /* 老格式撤销补丁 / 落盘兜底：slotMaps 的读写也走仓储，模块不再自己拼数组 */
    slotMap: STORE.slotMap,
    setSlotMap: STORE.setSlotMap,
    onPaintBase: function (slot) { if (MIX) MIX.schedule(slot); },
    onPaintInk: function (slot) { if (MIX) MIX.schedule(slot); },
    onPaintReset: function (slot) { if (MIX) MIX.schedule(slot); },
    onPaintSlot: function (slot) { if (MIX) MIX.selectSlot(slot); },
    /* 吸管 / 魔棒在绘制链内部改状态后回调，让顶部条与右侧面板立刻跟上 */
    setPaintColor: setPaintColor,
    updatePaintUi: updatePaintUi,
    /* 显式材质槽：-1 = 自动（落笔面所在槽）。笔迹只写进这一槽，跨槽拖动也不中断。 */
    forceSlot: function () { return st.paint.userSlot; },
    slotName: slotNameAt,
    slotFaceCount: function (slot) {
      var m = st.mesh;
      if (!m || !m.faceSlots) return 0;
      var n = 0;
      for (var i = 0; i < m.faceSlots.length; i++) if ((m.faceSlots[i] | 0) === slot) n++;
      return n;
    },
    /* 多对象场景里正在画的常常不是激活对象：先问视口「指针下面是哪个对象」，
     * 命中别的对象就切过去再落笔。否则只会提示「没点到模型」，看起来就是没反应。 */
    nodeUnderPointer: function (x, y) { return pickVisibleNodeAt(x, y); },
    activateNode: function (id) { return selectNodeById(id, 'replace'); },
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
  /* 落笔期间把 pointermove 合并成一帧一次：高采样率鼠标一秒能发几百个事件，
   * 每个事件都要对整份网格做一次射线求交，同步全跑会把主线程塞满。
   * 相邻采样点之间本来就按 UV 插值补段，合并到 rAF 不丢笔迹，只少做几十次求交。 */
  function paintMoveSchedule(e) {
    var p = st.paint;
    p.pendingMove = e;
    if (p.moveRaf) return;
    p.moveRaf = global.requestAnimationFrame(function () {
      p.moveRaf = 0;
      var ev = p.pendingMove;
      p.pendingMove = null;
      if (ev && p.stroke) paintStrokeMove(ev);
    });
  }
  function paintMoveFlush() {
    var p = st.paint;
    if (p.moveRaf) { global.cancelAnimationFrame(p.moveRaf); p.moveRaf = 0; }
    var ev = p.pendingMove;
    p.pendingMove = null;
    if (ev && p.stroke) paintStrokeMove(ev);
  }

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
      upload: UPLOAD,
      totalBytes: totalBytes, syncBytes: syncBytes, historyBudget: HISTORY_BUDGET,
      paintCanvasFor: function (slot) {
        var p = st.paint;
        return (st.doc && p.doc === st.doc && p.slot === slot && p.canvas) ? p.canvas : null;
      },
      paintTexFor: function (slot) {
        var p = st.paint;
        return (st.doc && p.doc === st.doc && p.slot === slot && p.tex) ? p.tex : null;
      },
      /* 绘画工作副本是不是拿「合成图」当底座建的。是的话它含图层像素，
       * 混合同步时不能把它当最终像素（否则隐藏 / 删除图层后颜色退不掉）。 */
      paintSeedComposed: function (slot) {
        var p = st.paint;
        return !!(st.doc && p.doc === st.doc && p.slot === slot && p.seedComposed);
      },
      /* 正在画的这一笔：还没入栈，合成时要单独盖到混合层之上。
       * type:'blur'（Shift 模糊笔）传的是遮罩 + 模糊半径，合成时按遮罩糊结果。
       * box = 自上次合成之后新增的像素：混合模块据此只补这一块（整笔范围另存 inkBox）。 */
      paintInkFor: function (slot) {
        var p = st.paint;
        if (!(st.doc && p.doc === st.doc && p.slot === slot && p.ink)) return null;
        var box = p.inkFrameBox;
        /* 取走即清空：下一帧的「新增」从这里重新累计 */
        p.inkFrameBox = null;
        if (p.inkBlur) {
          return { canvas: p.ink, mode: 'normal', type: 'blur',
            radius: Math.max(1, p.blurRad || 1), box: box };
        }
        return { canvas: p.ink, mode: p.inkErase ? 'erase' : 'normal', type: 'stroke', box: box };
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
      slotIds: (m.slotIds || []).slice(),
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
      if (mapSide != null) STORE.setSlotMap(patch.slot, mapSide);
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
    m.slotIds = (v.slotIds || []).slice();
    if (v.textureConfigKey) m.textureConfigKey = v.textureConfigKey;
    /* 贴图可能整组换过：绘画工作区按旧 URL 建的 canvas 不能继续复用 */
    st.paint.tex = null; st.paint.canvas = null; st.paint.ctx = null;
    st.paint.clipCtxs = null; st.paint.slot = -1; st.paint.doc = null;
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
      idx = SeedModel.Scene.addSlot(st.doc, { node: st.node });
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
      return STORE.setSlotColor(i, color);
    });
  }
  function slotDelete(i) {
    var ok = slotEdit('删除材质槽', function () {
      return SeedModel.Scene.removeSlot(st.doc, i, { node: st.node });
    });
    if (!ok) setStatus('当前对象至少保留一个材质槽', true);
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

  /* 绘画页签的「材质槽」下拉：自动 + 每个槽（槽名 / 当前对象用到的面数 / 有没有贴图）。
   * 用户反馈「有贴图的模型上画了没反应」，最常见的原因是自动取到的槽不是眼前那张
   * 贴图所在的槽（多槽模型落笔面常常属于一个与可见贴图不同的槽）。把槽摆到明面上，
   * 选中哪一槽就只画哪一槽，问题至少变成可控的。 */
  function paintSlotSig() {
    var m = (st.doc && st.doc.materials) || {};
    var maps = m.slotMaps || [];
    return (m.slotNames || []).join('\u0001') + '|' +
      maps.map(function (u) { return u ? 1 : 0; }).join('') + '|' +
      (st.node ? st.node.id : '') + '|' + (st.mesh ? st.mesh.version : 0);
  }
  function syncPaintSlots() {
    var sel = $('mdPaintSlotSel');
    if (!sel) return;
    var sig = paintSlotSig();
    if (sel.dataset.mdSig === sig) return;
    var m = (st.doc && st.doc.materials) || {};
    var names = m.slotNames || [], maps = m.slotMaps || [];
    var used = Object.create(null);
    var mesh = st.mesh;
    if (mesh && mesh.faceSlots) {
      for (var f = 0; f < mesh.faceSlots.length; f++) {
        var s = mesh.faceSlots[f] | 0;
        used[s] = (used[s] || 0) + 1;
      }
    }
    var html = '<option value="-1">自动（落笔面所在槽）</option>';
    for (var i = 0; i < names.length; i++) {
      html += '<option value="' + i + '">' + esc(slotNameAt(i)) +
        (used[i] ? ' · ' + used[i] + ' 面' : ' · 本对象没用') +
        (maps[i] ? ' · 有贴图' : ' · 无贴图') + '</option>';
    }
    var keep = st.paint.userSlot;
    sel.innerHTML = html;
    if (keep >= 0 && keep < names.length) sel.value = String(keep);
    else { st.paint.userSlot = -1; sel.value = '-1'; }
    sel.dataset.mdSig = sig;
  }

  /* 笔刷预览条：把 st.paint 目前的状态翻译成「看得见的东西」。
   * 棋盘底 + 圆点同时表达颜色与不透明度；材质槽缩略图说明「笔迹会进哪张贴图」。
   * 所有数值都从 st.paint 现读，不做第二份状态。 */
  function hexToRgba(hex, a) {
    var s = String(hex || '').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n) || s.length !== 6) return 'rgba(217,79,79,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  var PAINT_BRUSH_NAME = { soft: '软边', hard: '硬边', erase: '橡皮擦' };
  var PAINT_TOOL_NAME = {
    brush: '画笔', pencil: '铅笔', eraser: '橡皮',
    blur: '模糊工具', smudge: '涂抹工具', picker: '吸管', wand: '魔棒'
  };
  /* 绘制工具快捷键：键位对齐主流绘画软件（B 画笔 / P 铅笔 / E 橡皮 / I 吸管 /
   * W 魔棒 / G 填充）。W / E / R 在建模模式是变换手柄，所以只在绘制模式下接管。 */
  var PAINT_KEYS = {
    b: 'brush', p: 'pencil', e: 'eraser', r: 'blur', t: 'smudge', i: 'picker', w: 'wand'
  };
  function setPaintTool(tool) {
    var v = Object.prototype.hasOwnProperty.call(PAINT_TOOL_NAME, tool) ? tool : 'brush';
    st.paint.tool = v;
    st.paint.stampKey = ''; st.paint.stampCv = null;
    /* 笔刷下拉与工具保持同一套语义：橡皮 / 硬边铅笔要能在面板上看到对应笔尖 */
    if (v === 'eraser') st.paint.brush = 'erase';
    else if (v === 'pencil') st.paint.brush = 'hard';
    else if (st.paint.brush === 'erase') st.paint.brush = 'soft';
    updatePaintUi();
    setStatus('绘制工具：' + PAINT_TOOL_NAME[v] +
      (v === 'wand' ? '（点模型锁定 UV 岛；再点同一岛解除）' : ''));
  }

  /* 笔刷状态的**唯一写入点**：右侧面板、顶部绘制条、色板、快捷键都走这几个函数，
   * 再由 updatePaintUi() 反向刷新所有控件，避免两套界面各自记一份值。 */
  function setPaintBrush(kind) {
    var v = ['soft', 'hard', 'erase'].indexOf(kind) >= 0 ? kind : 'soft';
    st.paint.brush = v;
    st.paint.tool = v === 'erase' ? 'eraser' : 'brush';
    st.paint.stampKey = ''; st.paint.stampCv = null;
    updatePaintUi();
    setStatus('笔刷：' + (PAINT_BRUSH_NAME[v] || '软边') + ' · ' + st.paint.size + ' px');
  }
  function setPaintSize(v) {
    st.paint.size = Math.max(6, Math.min(180, Math.round(Number(v) || 42)));
    updatePaintUi();
  }
  function setPaintOpacity(v) {
    st.paint.opacity = Math.max(5, Math.min(100, Math.round(Number(v) || 90)));
    updatePaintUi();
  }
  function setPaintColor(v) {
    st.paint.color = String(v || '').trim() || '#d94f4f';
    updatePaintUi();
  }
  function togglePaintMask() {
    st.paint.mask = !st.paint.mask;
    updatePaintUi();
    setStatus(st.paint.mask
      ? 'UV 岛遮罩开：笔刷只画进落笔所在的 UV 岛'
      : 'UV 岛遮罩关：笔刷可画到整张贴图');
  }

  /* 把「形状 + 颜色」画到一个 DOM 元素上：主预览和 9 个槽位共用同一套口径，
   * 色块、热力色、橡皮灰都用同一条路径，避免两处预览长得不一样。 */
  function paintShapeStyle(el, shape, colorCss, ringW, opacity, center, customUrl) {
    if (!el) return;
    var s = el.style;
    s.background = 'none';
    s.backgroundColor = 'transparent';
    s.backgroundImage = 'none';
    s.backgroundRepeat = 'no-repeat';
    s.backgroundPosition = 'center';
    s.border = '0';
    s.borderRadius = '0';
    s.boxSizing = 'border-box';
    s.transform = center ? 'translate(-50%, -50%)' : 'none';
    s.clipPath = 'none';
    s.webkitMaskImage = ''; s.maskImage = '';
    s.webkitMaskSize = ''; s.maskSize = '';
    s.webkitMaskRepeat = ''; s.maskRepeat = '';
    s.webkitMaskPosition = ''; s.maskPosition = '';
    s.opacity = (opacity == null) ? '' : String(opacity);
    s.backgroundColor = colorCss;
    if (shape === 'round') {
      s.borderRadius = '50%';
    } else if (shape === 'square') {
      s.borderRadius = '2px';
    } else if (shape === 'diamond') {
      s.transform = (center ? 'translate(-50%, -50%) ' : '') + 'rotate(45deg)';
    } else if (shape === 'star') {
      s.clipPath = 'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)';
    } else if (shape === 'triangle') {
      s.clipPath = 'polygon(50% 2%,100% 98%,0% 98%)';
    } else if (shape === 'pentagon') {
      s.clipPath = 'polygon(50% 0%,100% 38%,82% 100%,18% 100%,0% 38%)';
    } else if (shape === 'cross') {
      s.clipPath = 'polygon(36% 0%,64% 0%,64% 36%,100% 36%,100% 64%,64% 64%,64% 100%,36% 100%,36% 64%,0% 64%,0% 36%,36% 36%)';
    } else if (shape === 'ring') {
      s.backgroundColor = 'transparent';
      s.borderRadius = '50%';
      s.border = (ringW || 3) + 'px solid ' + colorCss;
    } else if (shape === 'custom') {
      if (customUrl) {
        s.backgroundColor = colorCss;
        s.webkitMaskImage = 'url("' + customUrl + '")';
        s.maskImage = 'url("' + customUrl + '")';
        s.webkitMaskSize = 'contain'; s.maskSize = 'contain';
        s.webkitMaskRepeat = 'no-repeat'; s.maskRepeat = 'no-repeat';
        s.webkitMaskPosition = 'center'; s.maskPosition = 'center';
      } else {
        s.backgroundColor = 'transparent';
        s.border = '1px dashed rgba(120,130,145,.55)';
        s.borderRadius = '4px';
      }
    }
  }

  function setPaintShape(sh) {
    if (PAINT_SHAPES.indexOf(sh) < 0) return;
    st.paint.shape = sh;
    updatePaintUi();
    setStatus('笔刷形状：' + (PAINT_SHAPE_NAME[sh] || sh));
  }

  function updatePaintUi() {
    var p = st.paint;
    /* 绘制条与右侧面板共用同一份状态：这里把控件值拉回状态，
     * 从任一侧改动都不会让另一侧显示成旧值。 */
    var brushSel = $('mdBrushSel');
    if (brushSel && brushSel.value !== p.brush) brushSel.value = p.brush;
    var sizeIn = $('mdBrushSize');
    if (sizeIn && Number(sizeIn.value) !== p.size) sizeIn.value = String(p.size);
    var sizeVal = $('mdBrushSizeVal');
    if (sizeVal) sizeVal.textContent = p.size + ' px';
    var sizeBar = $('mdBrushSizeBar');
    if (sizeBar && Number(sizeBar.value) !== p.size) sizeBar.value = String(p.size);
    var sizeBarVal = $('mdBrushSizeBarVal');
    if (sizeBarVal) sizeBarVal.textContent = String(p.size);
    var opIn = $('mdBrushOpacity');
    if (opIn && Number(opIn.value) !== p.opacity) opIn.value = String(p.opacity);
    var opVal = $('mdBrushOpacityVal');
    if (opVal) opVal.textContent = p.opacity + '%';
    var opBar = $('mdBrushOpacityBar');
    if (opBar && Number(opBar.value) !== p.opacity) opBar.value = String(p.opacity);
    var opBarVal = $('mdBrushOpacityBarVal');
    if (opBarVal) opBarVal.textContent = p.opacity + '%';
    var colIn = $('mdBrushColor');
    if (colIn && String(colIn.value).toLowerCase() !== String(p.color).toLowerCase()) colIn.value = p.color;
    var colBar = $('mdBrushColorBar');
    if (colBar && String(colBar.value).toLowerCase() !== String(p.color).toLowerCase()) colBar.value = p.color;
    var maskIn = $('mdPaintMask');
    if (maskIn) maskIn.checked = !!p.mask;
    document.querySelectorAll('[data-md-pbrush]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdPbrush === p.brush);
    });
    var maskBtn = document.querySelector('[data-md-pmask]');
    if (maskBtn) maskBtn.classList.toggle('on', !!p.mask);
    /* 左侧工具条：选中态跟着同一个 st.paint.tool 走 */
    document.querySelectorAll('[data-md-ptool]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdPtool === p.tool);
    });
    var railSw = $('mdPaintRailSw');
    if (railSw) railSw.style.background = p.color;
    var barMeta = $('mdPaintBarMeta');
    if (barMeta) {
      barMeta.textContent = '槽：' + (p.userSlot >= 0 ? slotNameAt(p.userSlot) : '自动') +
        (p.lockIsland >= 0 ? ' · 岛锁定' : '');
    }

    var dot = $('mdPaintPrevDot');
    if (dot) {
      /* 6–180 px 映射到 6–40 的预览直径：小笔也能看见，大笔不撑破 52px 的框 */
      var dia = Math.round(6 + (Math.max(6, Math.min(180, p.size)) - 6) / 174 * 34);
      var shape = p.shape || 'round';
      var customUrl = (p.customBrush && p.customBrush.url) ? p.customBrush.url : '';
      var prevColor = (p.brush === 'erase')
        ? 'rgba(154,160,166,0.24)'
        : hexToRgba(p.color, Math.max(0.15, p.opacity / 100));
      dot.style.width = dia + 'px';
      dot.style.height = dia + 'px';
      paintShapeStyle(dot, shape, prevColor, Math.max(2, Math.round(dia * 0.12)), null, true, customUrl);
    }

    /* 3×3 形状槽：选中态 + 每个槽用自己的形状和当前颜色做小预览；
     * 自定义槽没载入图片时显示成可点的空槽（+）。 */
    var slots = document.querySelectorAll('[data-md-brushshape]');
    for (var si = 0; si < slots.length; si++) {
      var sb = slots[si];
      var sh = sb.dataset.mdBrushshape;
      var hasCustom = !!(p.customBrush && p.customBrush.url);
      var emptyCustom = sh === 'custom' && !hasCustom;
      sb.classList.toggle('on', sh === (p.shape || 'round'));
      sb.classList.toggle('is-empty', emptyCustom);
      var ic = sb.querySelector('.md-brush-slot-ic');
      if (!ic) continue;
      ic.textContent = emptyCustom ? '+' : '';
      paintShapeStyle(ic, sh, emptyCustom ? 'transparent' : hexToRgba(p.color, 0.95),
        3, null, false, hasCustom ? p.customBrush.url : '');
    }
    var nameEl = $('mdPaintPrevName');
    if (nameEl) {
      var shapeName = PAINT_SHAPE_NAME[p.shape] || PAINT_SHAPE_NAME.round;
      nameEl.textContent = p.shape === 'custom'
        ? ('自定义 · ' + (p.customBrush ? p.customBrush.name : '未载入'))
        : (shapeName + ' · ' + (PAINT_BRUSH_NAME[p.brush] || PAINT_BRUSH_NAME.soft));
    }
    var customRow = $('mdBrushCustomRow');
    if (customRow) customRow.hidden = (p.shape || 'round') !== 'custom';
    var tmb = $('mdBrushTmb');
    if (tmb) {
      var hasCustom = !!(p.customBrush && p.customBrush.url);
      tmb.hidden = !hasCustom;
      if (hasCustom) tmb.style.backgroundImage = 'url("' + p.customBrush.url + '")';
      else tmb.style.backgroundImage = '';
    }
    var customName = $('mdBrushCustomName');
    if (customName) customName.textContent = p.customBrush ? p.customBrush.name : '未载入';
    var metaEl = $('mdPaintPrevMeta');
    if (metaEl) {
      var slotText = p.userSlot >= 0 ? slotNameAt(p.userSlot) : '自动槽';
      metaEl.textContent = p.size + ' px · ' + p.opacity + '% · ' + p.color + ' · ' + slotText;
    }
    var sws = document.querySelectorAll('.md-paint-sw');
    for (var i = 0; i < sws.length; i++) {
      sws[i].classList.toggle('is-on',
        String(sws[i].dataset.mdSwatch || '').toLowerCase() === String(p.color || '').toLowerCase());
    }
    var sd = $('mdPaintSlotDot');
    if (sd) {
      var mats = (st.doc && st.doc.materials) || {};
      var idx = p.userSlot;
      var url = idx >= 0 ? ((mats.slotMaps || [])[idx] || '') : '';
      var color = idx >= 0 ? (((mats.slotColors || [])[idx]) || '#c9ccd4') : '';
      /* 同一张 data URL 不重复写回 style，避免拖滑杆时无谓地重新解析大图；
       * 自动槽清空内联背景，让 CSS 的斜切半调底露出来。 */
      var key = idx < 0 ? 'auto' : (url || color);
      if (sd.dataset.mdKey !== key) {
        sd.dataset.mdKey = key;
        sd.style.backgroundImage = idx < 0 ? '' : (url ? 'url("' + url + '")' : 'none');
        sd.style.backgroundColor = idx < 0 ? '' : color;
      }
      sd.classList.toggle('is-auto', idx < 0);
      sd.title = idx < 0
        ? '自动：按落笔面所属的槽'
        : (slotNameAt(idx) + (url ? ' · 自带贴图' : ' · 纯色底'));
    }
  }

  /* 载入自定义笔尖：只保留解码后的 Image 与 data URL（预览 / 图章都要用），
   * 不写文档、不入资产库 —— 换文档后仍留在本次会话里，避免每画一笔都要重选。 */
  function setCustomBrushFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { setStatus('笔尖图：请选择 PNG / WebP / JPG 图片', true); return; }
    if (file.size > 8 * 1024 * 1024) { setStatus('笔尖图：图片不要超过 8 MB', true); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var url = String(fr.result || '');
      var img = new Image();
      img.onload = function () {
        st.paint.customBrush = { img: img, url: url, name: file.name, rev: Date.now() };
        st.paint.shape = 'custom';
        st.paint.stampKey = ''; st.paint.stampCv = null;
        updatePaintUi();
        setStatus('笔尖图：' + file.name + '（' + img.naturalWidth + '×' + img.naturalHeight + '，透明区域不落色）');
      };
      img.onerror = function () { setStatus('笔尖图：图片解码失败', true); };
      img.src = url;
    };
    fr.onerror = function () { setStatus('笔尖图：读取文件失败', true); };
    fr.readAsDataURL(file);
  }

  /* 指针下面的视口对象（尊重隔离 / 隐藏）：绘画落笔前用它确认「该画哪个对象」。
   * 导入的多材质模型往往拆成多个节点，激活对象不是鼠标下那个时，射线只会打空。 */
  function pickVisibleNodeAt(px, py) {
    if (!st.camera || !st.canvas) return '';
    var r = st.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return '';
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((px / r.width) * 2 - 1, -((py / r.height) * 2 - 1)), st.camera);
    var best = null;
    eachViewPivot(function (pv) {
      if (!pv.visible) return;
      pv.traverse(function (o) {
        if (!o.visible || !o.userData || o.userData.mdPart !== 'solid') return;
        var hits = rc.intersectObject(o, false);
        if (hits.length && (!best || hits[0].distance < best.t)) {
          best = { t: hits[0].distance, id: pv.userData.mdNode };
        }
      });
    });
    return best ? best.id : '';
  }

  /* ---------------- 编辑器模式（建模 / 绘制） ----------------
   * 两套界面不是两份 DOM：同一套控件，靠 .md-app[data-md-editor] 决定显隐，
   * 所以切换不丢选择、不丢笔刷、不丢文档。 */
  function applyEditorChrome(kind) {
    st.editor = kind === 'paint' ? 'paint' : 'model';
    var app = document.querySelector('.md-app');
    if (app) app.dataset.mdEditor = st.editor;
    document.querySelectorAll('[data-md-editor-btn]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdEditorBtn === st.editor);
    });
    var brand = $('mdBrandMode');
    if (brand) brand.textContent = st.editor === 'paint' ? '绘制' : '建模';
    var bar = $('mdPaintBar');
    if (bar) bar.hidden = st.editor !== 'paint';
    var rail = $('mdPaintRail');
    if (rail) rail.hidden = st.editor !== 'paint';
    /* 两种编辑器可用的键位不同：切模式时重画底部提示条 */
    paintKeyBar();
    /* 热力图只属于建模视口：切到绘制模式立刻收掉，切回来按当前选择重建 */
    refreshSoftHeat();
  }

  /* 模式只从左上角切换：绘制 = 绘画工具箱，建模 = 建模工具箱。 */
  function setEditor(kind) {
    if (kind === 'paint') {
      setTbKind('paint');
      updatePaintUi();
      setStatus('绘制模式：左键拖动上色 · Shift 拖动模糊 · Alt+左键 / 中键导航 · 右侧可换笔刷与材质槽');
    } else {
      setTbKind('model');
      setStatus('建模模式：F8–F12 切换对象 / 顶点 / 边 / 面 / UV 岛 · 工具架取基础体与算子');
    }
  }

  /* 模式只有左上角一个入口：右侧栏标题跟着模式走，页签只在「工具箱 ↔ 属性」之间切换。 */
  function tbModeLabel() {
    if (st.tbKind === 'paint') return '';   /* 标题已是「绘画工具箱」，不再重复口径 */
    return SEL_NOUN[st.selMode] || '对象';
  }

  function syncRightChrome() {
    var title = $('mdRightTitle');
    if (title) {
      title.textContent = st.tbKind === 'props' ? '属性编辑器'
        : st.tbKind === 'paint' ? '绘画工具箱' : '建模工具箱';
    }
    var tog = $('mdPropsToggle');
    if (tog) {
      tog.textContent = st.tbKind === 'props' ? '工具箱' : '属性';
      tog.classList.toggle('on', st.tbKind === 'props');
      tog.title = st.tbKind === 'props'
        ? '返回' + (st.editor === 'paint' ? '绘画' : '建模') + '工具箱'
        : '属性编辑器：变换 / 材质槽 / 操作历史';
    }
    var tb = $('mdTbMode');
    if (tb) tb.textContent = tbModeLabel();
  }

  /* 绘画工具箱内部只有两个页签：笔刷参数 / 材质图层。
   * 两个 pane 都在 DOM 里，切页签只换 hidden —— 笔刷状态与图层列表都不重建。 */
  function setPaintTab(tab) {
    st.paintTab = tab === 'layers' ? 'layers' : 'paint';
    var box = $('mdPaintBox');
    if (!box) return;
    box.querySelectorAll('[data-md-ptab]').forEach(function (b) {
      var on = b.dataset.mdPtab === st.paintTab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    box.querySelectorAll('[data-md-pane]').forEach(function (p) {
      p.hidden = p.dataset.mdPane !== st.paintTab;
    });
    /* 图层面板在隐藏时也能渲染，但切回来时重画一次能拿到最新的槽列表 */
    if (st.paintTab === 'layers' && MIX && MIX.renderUi) {
      try { MIX.renderUi(); } catch (e) {}
    }
  }

  function setTbKind(kind) {
    /* 属性编辑器只属于建模上下文：绘制模式没有变换手柄 / 网格统计，
     * 材质槽与笔刷参数都在绘画工具箱里，所以绘制模式下拒绝切到属性。 */
    if (kind === 'props' && st.editor === 'paint') kind = 'paint';
    st.tbKind = (kind === 'paint' || kind === 'props') ? kind : 'model';
    applyEditorChrome(st.tbKind === 'paint' ? 'paint' : 'model');
    var right = document.querySelector('.md-right');
    if (right) right.classList.toggle('is-props', st.tbKind === 'props');
    var sec = document.querySelector('.md-tb');
    if (sec) sec.classList.toggle('is-paint', st.tbKind === 'paint');
    var box = $('mdPaintBox');
    if (box) box.hidden = st.tbKind !== 'paint';
    syncRightChrome();
    if (st.canvas) st.canvas.style.cursor = st.tbKind === 'paint' ? 'crosshair' : '';
    if (st.tbKind === 'paint') { syncPaintSlots(); updatePaintUi(); }
    syncGizmo();
    if (st.tbKind !== 'paint') {
      st.paint.stroke = null;
      st.paint.pendingMove = null;
      if (st.paint.moveRaf) { global.cancelAnimationFrame(st.paint.moveRaf); st.paint.moveRaf = 0; }
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
    requestRender(250);
    if (e.button || e.altKey || !st.doc) { st.pickDown = null; return; }
    /* 落手就收掉预选幽灵：点中的元素马上会变成选中态，两个一起画会重影 */
    if (st.hoverPick) clearHoverPick();
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
    /* 悬停反馈（光圈 / 预选高亮 / 手柄光标）都不改场景指纹，靠这条保持可画 */
    requestRender(160);
    st.pointer.x = e.clientX;
    st.pointer.y = e.clientY;
    brushFollow(e);
    /* 绘画笔画进行中：每次移动都按 UV 往画布上补一段，忽略选中/手柄逻辑 */
    if (st.tbKind === 'paint' && st.paint.stroke) {
      paintMoveSchedule(e);
      return;
    }
    /* 预选反馈：选择工具、没在拖动时才算；其余情况把旧幽灵收掉 */
    if (!st.gest && st.tool === 'select') hoverPickAt(e);
    else if (st.hoverPick) clearHoverPick();
    /* 挤出会话：悬停箭头 / 轴心方柄给出可拖动光标。只在命中时写，离开时只清自己写的那次，
     * 免得把变换手柄（capture 阶段）设的 grab 覆盖掉 */
    if (global.SeedTools && global.SeedTools.isLive && global.SeedTools.isLive('tool.extrude') &&
        !EXGZ.drag && !st.gest) {
      var eh = extrudeGizmoHit(e);
      if (eh) {
        EXGZ.hover = eh;
        st.canvas.style.cursor = eh === 'root' ? 'ew-resize' : 'grab';
      } else if (EXGZ.hover) {
        EXGZ.hover = null;
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
    requestRender(250);
    var d = st.pickDown;
    var g = st.gest;
    st.pickDown = null;
    st.gest = null;
    if (d && d.paint) { paintMoveFlush(); paintStrokeEnd(); gestClear(); return; }
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
      /* 对象模式：框到的整只对象，不是面。Ctrl 减选 / Shift 加选 / 直接拖 = 换选 */
      if (st.selMode === 'object') {
        var oids = nodesInRegion(g);
        var ohow = (e.ctrlKey || e.metaKey) ? 'remove' : (e.shiftKey ? 'add' : 'replace');
        gestClear();
        if (!oids.length && ohow !== 'replace') { setStatus('区域内没有对象'); return; }
        applyNodeSelection(oids, ohow, oids[0]);
        if (!oids.length) setStatus('区域内没有对象（已清空选择）', true);
        return;
      }
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
      if (best) {
        /* 视口多选：Shift 追加、Ctrl/Cmd 切换（与大纲一致），否则换选 */
        var ohow2 = (e.ctrlKey || e.metaKey) ? 'toggle' : (e.shiftKey ? 'add' : 'replace');
        applyNodeSelection([best.id], ohow2, best.id);
        setStatus('已选中对象：' + best.name + '（已选 ' + (st.nodeIds ? st.nodeIds.length : 0) + ' 个）');
        return;
      }
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
        /* 点空白 = 空选（对象模式也允许零个选中；激活对象单独保留） */
        applyNodeSelection([], 'replace');
        setStatus('没有点中对象（已清空选择）');
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
      /* 对象模式走 nodesInRegion（onPickUp 里已经分支），这里只兜底 */
      setStatus(hit.ids.length ? ('区域内 ' + hit.ids.length + ' 个面（对象模式不改组件选择）') : '区域内没有元素');
      return;
    }
    if (!hit.ids.length) {
      if (!add && !toggle) { mergeSelection([], 'replace'); }
      else setStatus('区域内没有元素');
      return;
    }
    mergeSelection(hit.ids, toggle ? 'remove' : add ? 'add' : 'replace');
  }

  /* 对象模式的区域选择：把每个可见对象的包围盒采样点投影到屏幕，
   * 任一点落在区域内就选中（8 角 + 12 棱中点 + 中心 = 21 点/对象）。
   * 逐对象 21 点比逐顶点投影便宜一个量级，而对象框选本来就不需要像素级精度。 */
  function nodesInRegion(g) {
    if (!st.doc || !st.camera || !global.SeedSelection || !THREE) return [];
    var r = st.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return [];
    var box = null, poly = null;
    if (g.tool === 'select') {
      box = {
        x1: Math.min(g.x0, g.x), y1: Math.min(g.y0, g.y),
        x2: Math.max(g.x0, g.x), y2: Math.max(g.y0, g.y)
      };
    } else {
      poly = (g.pts && g.pts.length >= 3) ? g.pts : null;
      if (!poly) return [];
    }
    function inside(x, y) {
      if (box) return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
      return global.SeedSelection.pointInPolygon(x, y, poly);
    }
    var out = [], v = new THREE.Vector3();
    SeedModel.Scene.nodesOf(st.doc).forEach(function (n) {
      var pv = st.pivots[n.id];
      if (!pv || !ISO.nodeVisible(n.id)) return;
      pv.updateMatrixWorld(true);
      var pts = nodeBoxPoints(pv);
      if (!pts) return;
      var all = pts.corners.concat(pts.mids, [pts.center]);
      for (var i = 0; i < all.length; i++) {
        v.copy(all[i]).project(st.camera);
        if (inside((v.x * 0.5 + 0.5) * r.width, (-v.y * 0.5 + 0.5) * r.height)) {
          out.push(n.id);
          return;
        }
      }
    });
    return out;
  }

  /* ---------------- 组件预选（hover） ----------------
   * 鼠标停在点 / 边 / 面上时先画一层淡色幽灵，点下去前就知道会选中谁。
   * 只做「选择工具 + 组件模式 + 无手势」：框选拖动、绘画、工具会话里都不预选。 */
  function clearHoverPick() {
    if (!st.hoverPick) return;
    st.hoverPick = null;
    paintSelection();
  }

  function hoverPickAt(e) {
    if (!st.doc || !st.mesh || !st.pivot || !st.camera || !global.SeedSelection) return;
    if (st.quad || st.selMode === 'object' || st.tool !== 'select' || st.tbKind === 'paint') return;
    if (global.SeedTools && global.SeedTools.isLive && global.SeedTools.isLive()) return;
    var now = performance.now();
    if (now - (st.hoverAt || 0) < 60) return;      /* 节流：投影全表不便宜 */
    st.hoverAt = now;
    var pickMesh = ISO.visibleMesh(st.node ? st.node.id : '');
    if (!pickMesh) { clearHoverPick(); return; }
    var r = st.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) { clearHoverPick(); return; }
    var hit = global.SeedSelection.pick({
      mesh: pickMesh, matrix: st.pivot.matrixWorld, camera: st.camera,
      rect: { width: r.width, height: r.height }, x: x, y: y,
      mode: st.selMode === 'island' ? 'face' : st.selMode, through: false
    });
    /* 已选中的元素不再画幽灵：否则看起来像「选中态掉色了」 */
    if (hit) {
      var list = st.sel[selKey()] || [];
      if (list.indexOf(hit.id) >= 0) hit = null;
    }
    var sig = hit ? (hit.kind + ':' + hit.id) : '';
    var old = st.hoverPick ? (st.hoverPick.kind + ':' + st.hoverPick.id) : '';
    if (sig === old) return;
    st.hoverPick = hit;
    paintSelection();
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
    st.scene.background = new THREE.Color('#dfe4ea');
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
    /* 工具架页签 / 面板显隐 / 照明预设标签在视口就绪时对齐一次 */
    setShelfTab(st.shelfTab || 'poly');
    syncPanels();

    /* 栅格压暗（V2）：这个 three 构建没开 ColorManagement，GridHelper 顶点色会被当线性值
     * 再走一遍 ACES + sRGB 编码，实测比给定色亮 ~1.5 档。
     * 浅色皮肤下给的是中灰，显示出来才是一道不抢模型的浅灰线。 */
    var grid = new THREE.GridHelper(8, 16, 0xa8b1bd, 0xc3cad3);
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

    /* 视口捏脸控制器：独立一层，不参与变换手柄的模式切换（translate / rotate / scale 与它无关）。
     * 它在 canvas 的捕获阶段抢 pointerdown —— 命中才算它的，没命中一律放行，
     * 所以选对象、按 Alt 环绕、框选都照旧。 */
    if (global.MDCtrlLayer) {
      st.ctrlLayer = new global.MDCtrlLayer({
        hostEl: st.stage,
        projectAt: ctrlProjectAt,
        gainOf: ctrlGainOf,
        onStart: function (it) { ctrlHi(it, 0.85); ctrlStatus(it); },
        onDrag: function (it, v) { ctrlSend(it, v, 'input'); },
        onEnd: function (it, v) { ctrlSend(it, v, 'change'); ctrlHi(null); ctrlStatus(null); },
        onReset: function (it) { ctrlSend(it, 50, 'change'); },
        onHover: function (it) { ctrlHi(it, 0.5); ctrlStatus(it); },
        onNeedRender: function () { requestRender(120); }
      });
    }

    global.addEventListener('keydown', onSpaceDown, false);
    global.addEventListener('keyup', onSpaceUp, false);

    st.canvas.addEventListener('pointerdown', onPickDown);
    st.canvas.addEventListener('pointermove', onPickMove);
    st.canvas.addEventListener('pointerup', onPickUp);
    bindEdgeLoopDblClick();
    st.canvas.addEventListener('pointercancel', function () {
      /* 画笔被打断也要收尾：否则岛剪裁会一直留在上下文里 */
      paintMoveFlush();
      if (st.paint.stroke) paintStrokeEnd();
      st.gest = null; st.pickDown = null; gestClear();
    });
    st.canvas.addEventListener('pointerleave', function () {
      var n = gestNodes();
      if (n.brush) n.brush.style.display = 'none';
      if (st.hoverPick) clearHoverPick();
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
    requestRender(0);
  }

  function resume() {
    if (!st.renderer) return;
    resize();
    /* 恢复视口时先画两帧，避免「切回来一片空白」等下一条输入 */
    requestRender(200);
    if (!st.running) { st.running = true; tick(); }
  }
  function pause() {
    st.running = false;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
  }

  /* 按需渲染的显式请求：任何「DOM 之外、签名看不出来」的画面变化都调它。
   * holdMs = 需要持续渲染多久（悬停 / 拖拽反馈），0 = 只画下一帧。 */
  function requestRender(holdMs) {
    var now = global.performance ? global.performance.now() : Date.now();
    /* 至少要覆盖下一帧：只记 now 的话，tick 真正跑到时已经「过期」，
     * 又会被签名判断挡掉（requestRender(0) 等于没请求）。
     * 2 帧的余量给 30fps 的 UV 降频路径也留了位置。 */
    var t = now + Math.max(holdMs || 0, 34);
    if (t > st.holdUntil) st.holdUntil = t;
  }

  /* 场景指纹：画不画由它决定。只取「矩阵 / 版本号 / 开关」这类廉价量，
   * 不遍历场景 —— 每帧一次的开销必须远小于一次 render。 */
  function frameSig() {
    var c = st.camera, s = '';
    if (c) {
      var e = c.matrixWorld.elements, p = c.projectionMatrix.elements;
      s = e[0].toFixed(3) + ',' + e[1].toFixed(3) + ',' + e[2].toFixed(3) + ',' +
        e[4].toFixed(3) + ',' + e[5].toFixed(3) + ',' + e[6].toFixed(3) + ',' +
        e[8].toFixed(3) + ',' + e[9].toFixed(3) + ',' + e[10].toFixed(3) + ',' +
        e[12].toFixed(3) + ',' + e[13].toFixed(3) + ',' + e[14].toFixed(3) +
        '|' + p[0].toFixed(4) + ',' + p[5].toFixed(4);
    }
    var sel = st.sel || { vertexIds: [], edgeIds: [], faceIds: [] };
    s += '|m' + (st.mesh ? st.mesh.version : -1);
    s += '|r' + ((st.doc && st.doc.revision && st.doc.revision.current) || 0);
    s += '|p' + ((st.paint && st.paint.tex && st.paint.tex.version) || 0);
    s += '|s' + sel.vertexIds.length + ',' + sel.edgeIds.length + ',' + sel.faceIds.length +
      ',' + (sel.vertexIds[0] || 0) + ',' + (sel.faceIds[0] || 0);
    s += '|n' + (st.nodeIds ? st.nodeIds.length : 0) + ',' + (st.node ? st.node.id : '') +
      ',' + (st.selected | 0);
    s += '|g' + (st.gizmo && st.gizmo.group && st.gizmo.group.visible ? 1 : 0);
    s += '|v' + st.shading + (st.showGrid ? 1 : 0) + (st.isolate ? 1 : 0) +
      (st.quad ? 1 : 0) + (st.quadMax || '') + (st.hoverPick ? 1 : 0) +
      (vfOn('wireframe') ? 'w' : '');
    s += '|e' + ((st.edgeLines && st.edgeLines.material && st.edgeLines.material.opacity) || 0).toFixed(2);
    /* 形态键权重：只取版本号，不逐帧拼接 112 个数字 */
    s += '|m' + ((st.mesh && st.mesh._morphVersion) || 0);
    /* 软选择：开关 / 距离口径 / 半径 / 曲面 / 热力图 任一变化都要重画一帧 */
    s += '|so' + (st.soft.on ? 1 : 0) + (st.soft.heatmap ? 1 : 0) + st.soft.mode +
      Number(st.soft.size).toFixed(2) + st.soft.falloff +
      (st.pivot && st.pivot.userData.mdSoftSig ? '1' : '0');
    return s;
  }

  function tick() {
    if (!st.running) return;
    st.raf = requestAnimationFrame(tick);
    /* 组件的运行时状态（眨眼）在降频与按需渲染**之前**推进：
     * 它是时间驱动的，跟着跳帧只会让相位错乱，省不下任何开销。
     * 要不要画由 applyLive 自己 requestRender，这里不用管。 */
    applyLive();
    /* UV 编辑器基本盖住视口，底下 3D 还在全速画就是白烧 GPU：
     * 开着 UV 窗口时 3D 降到约 30fps，留出预算给画布重绘和指针响应。 */
    if (st.uv.open) {
      st.uv.frameSkip = (st.uv.frameSkip + 1) & 1;
      if (st.uv.frameSkip) return;
    }
    var now = global.performance ? global.performance.now() : Date.now();
    var moving = false;
    if (st.controls && !st.quad) { if (st.controls.update()) moving = true; }
    if (st.gizmo) st.gizmo.update();
    /* 捏脸控制器：结构那一层每帧对齐（内部按签名短路，签名没变就只做一次字符串比较），
     * 值那一层由 syncMorphWeightsOf 推，不在这里重复算。 */
    if (st.ctrlLayer) { syncCtrlLayer(); st.ctrlLayer.update(); }
    /* 挤出会话每帧同步专用手柄：参数可能从面板 / 热盒 / 键盘任何一路改 */
    updateExtrudeGizmo();
    if (!st.renderer || !st.scene || !st.camera) return;
    if (st.quad) {
      /* 只 update 激活格的 controls（阻尼需要每帧推进），其他格被动也不许被带动 */
      var qctl = st.quadCtl && st.quadCtl[quadKey()];
      if (qctl && qctl.update()) moving = true;
    }
    /* 笔刷刚落的像素还没写进纹理：先按块上传，再决定这一帧画不画 */
    var paintDirty = !!(PAINT && PAINT.hasPendingUpload && PAINT.hasPendingUpload());
    if (PAINT && PAINT.flushPreview) PAINT.flushPreview();
    var interacting = !!(st.gest || st.pickDown || st.paint.stroke ||
      (st.gizmo && st.gizmo.drag) || (st.ctrlLayer && st.ctrlLayer.isDragging()) ||
      st.quadDown || EXGZ.drag || st.busy);
    var sig = frameSig();
    /* 场景没变、没有输入、没有待上传像素 → 这一帧什么也不用做。
     * 静止时 GPU / CPU 都归零，拖动时照旧每帧渲染。 */
    if (!interacting && !moving && !paintDirty && now > st.holdUntil && sig === st.frameSig) return;
    st.frameSig = sig;
    if (st.quad) {
      renderQuad();
    } else {
      st.renderer.setScissorTest(false);
      st.renderer.setViewport(0, 0, st.stage.clientWidth, st.stage.clientHeight);
      st.renderer.render(st.scene, st.camera);
      /* 立方体每帧跟着主相机朝向重画：不订阅 controls 事件，
       * 因为相机还可能被键盘、滚轮 / 视图预设改掉，逐帧同步最省心。 */
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

  /* 贴图缓存 / 解码状态 / 挂图 / 底图读取都已搬到 js/md-material-store.js（STORE）：
   * 写路径只留一个入口，绘画、混合、投射、UV 编辑器不再各自摸 material.map。 */

  /* 共享贴图不能跟着单个材质一起释放，否则别的对象下一次渲染直接黑 */
  function disposeMap(m) {
    if (!m || !m.map) return;
    if (m.map.userData && m.map.userData.mdShared) return;
    try { m.map.dispose(); } catch (e) {}
  }

  /* 挂图 / 读图 / 解码状态见 js/md-material-store.js（STORE）。 */

  function makeMaterials(forMesh) {
    var mats = st.doc.materials || {};
    var names = mats.slotNames || [];
    var colors = mats.slotColors || [];
    var maps = mats.slotMaps || [];
    /* ⚠ 槽数必须按「这份网格自己用到的」算，不是激活节点。
     * buildExportRoot 会给每个可见节点各建一份材质 —— 以前一律按 st.mesh
     * （激活节点）算，非激活对象的面引用了更后面的槽就拿到 undefined 材质：
     * 视口里静默坏面，交给 GLTFExporter 直接崩（materials[idx] undefined）。 */
    var count = Math.max(names.length, maxUsedSlot(forMesh || st.mesh) + 1, 1);
    var list = [];
    for (var i = 0; i < count; i++) {
      var mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors[i] || '#c9ccd4'),
        roughness: 0.72,
        metalness: 0.06,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        /* 与视口「背面」开关同口径：视口默认双面渲染，材质创建时就得是双面。
         * 只靠 applyViewFlags 补不行 —— 导出用的 pivot 是新建的材质、不会再走
         * 一遍视口开关，单面材质的 GLB 到了外部查看器会把开口 / 翻内绕序的面
         * （面部、发片、布料）整片剔掉：视口好好的，导出后「脸没了」。
         * 反过来，用户关掉「背面」时导出也应是单面，所以这里跟随开关而不是写死。 */
        side: vfOn('backface') ? THREE.DoubleSide : THREE.FrontSide,
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

  /* 组件自报的材质组语义（可选口）。组件不认识 three，只交纯数据：
   * { transparent, opacity, alphaTest, depthWrite, doubleSide }[]。 */
  function componentGroupMats(node) {
    if (!node || !node.comp || !node.comp.id) return null;
    var def = componentDefById(node.comp.id);
    if (!def || typeof def.groupMats !== 'function') return null;
    try { return def.groupMats(node); } catch (e) { return null; }
  }

  /* 组件几何按 group 声明了自己的材质语义（groupMats，见 md-lumen-bridge）。
   * 文档里的材质槽数量是**用户**决定的（新建文档只有一个默认槽），跟组数不一定对得上，
   * 所以这里按组补齐：不足就克隆最后一份，再逐组套上清单里的渲染开关。
   *
   * ⚠ 头模的眼睛是**独立一层几何**（FaceEyes，1800 三角，与皮肤几乎共面），
   *   清单里它是 `transparent + depthWrite:false`。若按不透明渲染，皮肤先写深度、
   *   眼睛整片被剔掉 —— 转眼球骨骼时屏幕上的眼睛纹丝不动，看起来就是「没看向相机」。
   *   流明建材质时就是照清单设的这几个开关（apps/lumen3d/app.js:948）。 */
  function fitGroupMaterials(mats, defs) {
    if (!defs || !defs.length) return mats;
    var need = defs.length;
    var list = (mats || []).slice();
    if (!list.length) list.push(new THREE.MeshStandardMaterial({ color: 0xc9ccd4 }));
    while (list.length < need) list.push(list[list.length - 1].clone());
    for (var k = 0; k < defs.length && k < list.length; k++) {
      var d = defs[k], m = list[k];
      if (!d || !m) continue;
      if (d.transparent) {
        m.transparent = true;
        m.depthWrite = false;
        /* 透明层默认后画：皮肤在同一深度先落色，眼睛再叠上去 */
        m.renderOrder = 2;
      } else {
        m.transparent = false;
        m.depthWrite = true;
      }
      m.opacity = d.opacity == null ? 1 : d.opacity;
      m.alphaTest = d.alphaTest || 0;
      if (d.doubleSide) m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
    return list;
  }

  /* ---------------- 眼片位移：让「画在脸上的眼睛」真的看向相机 ---------------- */
  /* 结论先行（全部实测，见 .workbuddy/runs 里的染色 / 形态键量测）：
   *   ① 屏幕上那双眼睛**不是**眼球几何画的。把 mats[1]（FaceEyes，1800 三角）染红 +
   *      不透明 + 写深度，屏幕上一点红都没有；把 mats[0] 染绿，整颗头连眼睛一起变绿。
   *      也就是说那两颗眼球几何被皮肤整片挡住 —— 流明自己的注释也这么写
   *      （apps/lumen3d/app.js:455「FaceEyes 那块几何整块被皮肤挡住」）。
   *   ② 所以转左/右眼骨骼在画面上是**零效果**，这正是「眼球完全没动」的根因。
   *   ③ 作者给眼睛留的转向通道是 eyeshighlight_move_L / _R 两个形态键：
   *      288 顶点、位移均值 (−2.25,0,0) / (+2.89,0,0) mm、标准差 0.00 —— 纯刚体平移。
   *
   * 于是这里照抄流明 l3Deform 的做法（apps/lumen3d/app.js:989）：在
   * `#include <skinning_vertex>` **之后**位移顶点，掩码用原始 position 现算。
   * 贴图骑着顶点走，虹膜就跟着动了 —— 而位移是连续的（跟着 sin(yaw) / sin(pitch)），
   * 所以相机一转眼睛就跟着转，不是开关。椭圆中心 / 半径 / 正脸闸门全部来自组件
   * eyeSheet()（数值出处是资产自己的形态键，桥里有推导）。
   *
   * ⚠ 注入点必须是 skinning_vertex **之后**：放 begin_vertex 会被蒙皮再乘一次权重，
   *   而眼周顶点是 0.5 眼球 + 0.5 Head，位移会凭空减半（流明也是放在后面）。
   * ⚠ 掩码算 `length()` 而不是分轴比：分轴会让椭圆四角变成方形，边界出现折角。
   * ⚠ 过渡带是 0.82→1.0，不是 0.35→1.0：资产的 eyeshighlight_move_* 是**刚性平移**
   *   （288 顶点位移标准差 0.00），所以掩码在贴片内必须恒等于 1，只在外圈一圈收敛。
   *   用 0.35 起过渡会把有效位移砍到一半（实测眼片平均权重 0.45），
   *   表现就是「明明给了 4mm，画面上只挪了 2mm」。 */
  var MD_GAZE_VERT = [
    '  {',
    '    float mdZ = smoothstep(uMdEyeZ.x, uMdEyeZ.y, position.z);',
    '    if (mdZ > 0.001) {',
    '      vec2 mdD = vec2(abs(position.x) - uMdEyeC.x, position.y - uMdEyeC.y) / uMdEyeC.zw;',
    '      float mdM = 1.0 - smoothstep(0.72, 1.0, length(mdD));',
    '      transformed.xy += uMdGaze * (mdM * mdZ);',
    '    }',
    '  }'
  ].join('\n');

  /* 组件自报的眼片规格（纯数据；没声明的组件返回 null，一个 shader 都不挂）。
   * { center:[cx,cy], radius:[rx,ry], zGate:[lo,hi], sway:[ax,ay] } */
  function componentEyeSheet(node) {
    if (!node || !node.comp || !node.comp.id) return null;
    var def = componentDefById(node.comp.id);
    if (!def || typeof def.eyeSheet !== 'function') return null;
    var s = null;
    try { s = def.eyeSheet(); } catch (e) { s = null; }
    if (!s || !s.center || !s.radius || !s.zGate || !s.sway) return null;
    return s;
  }

  /* 把眼片位移挂到一组材质上。uniform 对象存在 mat.userData 里，
   * 材质重编译（onBeforeCompile 再跑一遍）时复用同一个引用 —— 否则每帧新建的
   * uniform 会把上一帧写的角度丢掉，表现是「眼睛只动一下然后弹回正中」。 */
  function applyGazeShader(mats, sheet) {
    if (!sheet || !mats || !mats.length) return;
    var C = new THREE.Vector4(sheet.center[0], sheet.center[1], sheet.radius[0], sheet.radius[1]);
    var Z = new THREE.Vector2(sheet.zGate[0], sheet.zGate[1]);
    for (var i = 0; i < mats.length; i++) {
      (function (m) {
        if (!m || (m.userData && m.userData.mdGazeU)) return;
        var U = { value: new THREE.Vector2(0, 0) };
        if (!m.userData) m.userData = {};
        m.userData.mdGazeU = U;
        var prev = m.onBeforeCompile;
        m.onBeforeCompile = function (shader, renderer) {
          if (typeof prev === 'function') { try { prev.call(this, shader, renderer); } catch (e) {} }
          shader.uniforms.uMdGaze = U;
          shader.uniforms.uMdEyeC = { value: C };
          shader.uniforms.uMdEyeZ = { value: Z };
          shader.vertexShader = 'uniform vec2 uMdGaze;\nuniform vec4 uMdEyeC;\nuniform vec2 uMdEyeZ;\n' +
            shader.vertexShader;
          var at = '#include <skinning_vertex>';
          if (shader.vertexShader.indexOf(at) >= 0) {
            shader.vertexShader = shader.vertexShader.replace(at, at + '\n' + MD_GAZE_VERT);
          }
        };
        m.needsUpdate = true;
      })(mats[i]);
    }
  }

  /* ---------------- 捏脸：脸型变形器（shader） ----------------
   * 组件给两段 GLSL（与流明逐字节相同）+ 资产系偏移，App 负责建 uniform 并挂到材质上。
   * 关键：建模 App 的网格顶点是「资产 − center」，而 GLSL 里的绝对 z 阈值是资产系的数 ——
   * 注入时用 l3Org 把顶点抬回资产系变形、算完减回来，GLSL 一个字不动。
   * uniform 引用存在 mat.userData.mdShapeU：材质重编译时复用同一引用（与 gaze 同一套理由）。 */
  function applyShapeShader(node, mats, groups) {
    if (!node || !node.comp || !node.comp.id || !mats || !mats.length) return null;
    var def = componentDefById(node.comp.id);
    if (!def || typeof def.shapeGlsl !== 'function') return null;
    var glsl = def.shapeGlsl();
    var origin = def.shapeOrigin();
    var bounds = def.shapeBounds();
    if (!glsl || !glsl.vert || !origin || !bounds) return null;
    /* 全部材质共用一份 uniform bundle（流明也这么做）：App 写一处，所有材质同步。 */
    var U = {
      l3Shape: { value: [0, 1, 2, 3, 4].map(function () { return new THREE.Vector4(); }) },
      l3CoilU: { value: null },
      l3Bounds: { value: new THREE.Vector3(bounds[0], bounds[1], 1 / Math.max(bounds[1] - bounds[0], 1e-6)) },
      l3Hi: { value: new THREE.Vector4(0.5, 0.5, 0.5, 0.2) },
      l3SelKind: { value: 0 },
      l3SelColor: { value: new THREE.Color(0.62, 0.78, 1.0) },
      l3SelA: { value: 0 },
      l3Out: { value: [new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 0)] },
      l3EyeX: { value: new THREE.Vector4(0, 0, 0, 1) },
      l3MouthX: { value: new THREE.Vector4(0, 0, 0, 1) },
      l3EyeC: { value: new THREE.Vector3(0.42, 0, 0) },
      l3EyeR: { value: new THREE.Vector3(0.03, 0.02, 0.03) },
      l3MouthC: { value: new THREE.Vector3(0, 0, 0) },
      l3MouthR: { value: new THREE.Vector3(0.03, 0.02, 0.04) },
      l3Org: { value: new THREE.Vector3(origin[0], origin[1], origin[2]) }
    };
    if (typeof def.shapeInfo === 'function') {
      var defs = def.shapeInfo().defs || [];
      U.l3CoilU = { value: defs.map(function (d) {
        var c = (typeof def.shapeCoilOf === 'function') ? def.shapeCoilOf(d.key) : null;
        return new THREE.Vector4(c ? c[0] : 0, c ? c[1] : 0, c ? c[2] : 0, c ? c[3] : 0);
      }) };
    }
    for (var i = 0; i < mats.length; i++) {
      (function (m) {
        if (!m) return;
        if (m.userData && m.userData.mdShapeU) return;
        if (!m.userData) m.userData = {};
        m.userData.mdShapeU = U;
        /* FaceEyes 材质用另一档更大的眼椭圆（照抄流明的 l3EyePart 口径）。
         * 材质对象自己的 name 来自文档插槽（「默认材质」），不是组的名字 ——
         * 组名从 groupMats 的配置里按**同一下标**取。 */
        var part = { value: /faceeyes/i.test((groups && groups[i] && groups[i].name) || '') ? 1 : 0 };
        var prev = m.onBeforeCompile;
        m.onBeforeCompile = function (shader, renderer) {
          if (typeof prev === 'function') { try { prev.call(this, shader, renderer); } catch (e) {} }
          Object.keys(U).forEach(function (k) { shader.uniforms[k] = U[k]; });
          shader.uniforms.l3EyePart = part;
          /* ⚠ l3Org 必须在这里声明：它是建模 App 的坐标系桥（网格局部 → 资产系），
           * 不属于流明的 GLSL —— SHAPE_VERT_HEAD 与流明逐字节相同（探针守卫），
           * 不能把声明塞进去。漏了这行就是「program not valid」刷屏、
           * shader 形变整个静默失效（实测：编译失败只报 INVALID_OPERATION，
           * 脸不变形、界面不报错 —— 探针不看 console 根本发现不了）。 */
          shader.vertexShader = 'uniform vec3 l3Org;\n' + glsl.vert + shader.vertexShader;
          shader.vertexShader = shader.vertexShader
            .replace('#include <begin_vertex>',
              '#include <begin_vertex>\n  vec3 l3Rest = position + l3Org;\n  vL3Rest = l3Rest;')
            .replace('#include <skinning_vertex>',
              '#include <skinning_vertex>\n  transformed = l3Deform( transformed + l3Org, l3Rest ) - l3Org;');
          shader.fragmentShader = glsl.frag + shader.fragmentShader
            .replace('#include <dithering_fragment>',
              '#include <dithering_fragment>\n' +
              '  if ( l3SelA > 0.002 && gl_FrontFacing ) {\n' +
              '    float l3sel = l3SelMask( vL3Rest );\n' +
              '    float l3core = smoothstep( 0.46, 0.56, l3sel ) * l3SelA;\n' +
              '    gl_FragColor.rgb = mix( gl_FragColor.rgb, l3SelColor, l3core );\n' +
              '  }');
        };
        m.needsUpdate = true;
      })(mats[i]);
    }
    return U;
  }

  /* 每帧：params.shape → uniform；悬停 / 拖动的线圈高亮也在这里送。
   * 每帧全量写（20 个数 + 一个 selA）而不是差量：改参数的路径太多
   * （面板 / 手柄 / 撤销 / 读盘 / 换代），差量迟早漏一路。 */
  function syncShapeOf(obj, node) {
    if (!obj || !node) return;
    var gz = obj.userData && obj.userData.mdShape;
    if (!gz || !gz.uni) return;
    var U = gz.uni;
    var p = (node.comp && node.comp.params) || {};
    var packed = null;
    var def = componentDefById(node.comp.id);
    if (def && typeof def.shapePack === 'function') {
      try { packed = def.shapePack(p.shape); } catch (e) { packed = null; }
    }
    if (packed) {
      for (var i = 0; i < 5 && i < U.l3Shape.value.length; i++) {
        var q = U.l3Shape.value[i], v = packed[i];
        q.set(v[0], v[1], v[2], v[3]);
      }
    }
    var hi = st.ctrlHi;
    if (hi && def && typeof def.shapeCoilOf === 'function') {
      var c = def.shapeCoilOf(hi.key);
      if (c) {
        U.l3Hi.value.set(c[0], c[1], c[2], c[3]);
        U.l3SelKind.value = 0;
        U.l3SelA.value = hi.strength == null ? 0.78 : hi.strength;
      }
    } else {
      U.l3SelA.value = 0;
    }
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

  /* 形态键：three 的渲染开关挂在 Mesh 上（morphTargetInfluences），不在几何上。
   * 名字表由 SeedModel.Mesh.buildGeometry 按稳定顺序挂在 geo.userData 上，
   * 这里只负责把「名字 → 下标」和初始权重搬上去。 */
  function attachMorphs(obj, geo) {
    var names = geo && geo.userData && geo.userData.mdMorphNames;
    if (!names || !names.length) return;
    var w = geo.userData.mdMorphWeights || [];
    obj.morphTargetInfluences = names.map(function (name, i) { return Number(w[i]) || 0; });
    var dict = Object.create(null);
    names.forEach(function (name, i) { if (!(name in dict)) dict[name] = i; });
    obj.morphTargetDictionary = dict;
  }

  /* 某个 pivot 里那颗带形态键的 solid。pivot 是「一个对象一个 Group」，
   * solid 是它的子网格（mdPart 标记）。 */
  function solidOfPivot(pv) {
    if (!pv) return null;
    var found = null;
    pv.traverse(function (o) {
      if (!found && o.isMesh && o.userData && o.userData.mdPart === 'solid') found = o;
    });
    return found;
  }

  /* 按节点 id 找那颗 solid；nodeId 省略时用激活对象。
   * ⚠ 早先只读 st.pivot，等于「只有激活对象能改表情」。多对象同时眨眼必须按 id 取，
   *   否则后台那个头永远不动 —— 而用户看不见它不动的原因。 */
  function morphObjectOf(nodeId) {
    var id = nodeId || (st.node && st.node.id);
    return solidOfPivot(id ? st.pivots[id] : st.pivot);
  }
  function morphObjectFor() { return morphObjectOf(''); }

  /* 节点的网格数据（缓存对象，不是 doc.meshes 里的 JSON 副本）。
   * 激活对象走 st.mesh，省掉为它再 evaluate 一次修改器栈。 */
  function meshOfNode(nodeId) {
    var id = nodeId || (st.node && st.node.id);
    if (!id) return null;
    if (st.node && st.node.id === id && st.mesh) return st.mesh;
    var n = st.doc ? SeedModel.Scene.nodeById(st.doc, id) : null;
    return n ? SeedModel.Scene.getMesh(st.doc, n) : null;
  }

  /* 运行时覆盖：组件自报的 live 值（眨眼…）按名字写进 influences。
   * 叠加口径是 **max 不是相加** —— 流明里「闭眼」= max(表情自己的眼形, 眨眼)，
   * 相加会让眼睛和嘴同时被拉到两倍（140% 的怪相）。
   * ⚠ 只写 three 的数组，**绝不回写 mesh.morphs[].weight**：那是存盘数据。 */
  function applyMorphOverlay(obj, map) {
    if (!obj || !obj.morphTargetInfluences || !map) return false;
    var dict = obj.morphTargetDictionary || {};
    var any = false;
    Object.keys(map).forEach(function (name) {
      var i = dict[name];
      if (i == null) return;
      var v = Number(map[name]);
      if (!isFinite(v)) return;
      if (v < 0) v = 0; else if (v > 1) v = 1;
      if (v > obj.morphTargetInfluences[i]) { obj.morphTargetInfluences[i] = v; any = true; }
    });
    return any;
  }

  /* 把 live 叠到这一帧的 influences 上。基线永远是 mesh.morphs 的持久权重，
   * 不在上一帧结果上累加 —— max 是单调的，累加会让「眨完眼」回不到睁开。 */
  function applyLiveOverlay(nodeId, obj) {
    var live = st.compLive[nodeId];
    if (!live || !live.map || !live.map.weight) return false;
    applyMorphOverlay(obj, live.map.weight);
    return true;
  }

  /* 按网格里记的权重刷新 three 的 influences，并请求重画一帧。
   * 权重不重建几何（几何没变），只改一个数组 —— 所以别走 applyMesh。 */
  function syncMorphWeightsOf(nodeId) {
    var id = nodeId || (st.node && st.node.id);
    var obj = morphObjectOf(id);
    if (!obj || !obj.morphTargetInfluences) return 0;
    var mesh = meshOfNode(id);
    var morphs = (mesh && mesh.morphs) || [];
    var n = 0;
    for (var i = 0; i < morphs.length && i < obj.morphTargetInfluences.length; i++) {
      obj.morphTargetInfluences[i] = clamp01(morphs[i].weight);
      n++;
    }
    applyLiveOverlay(id, obj);
    if (mesh) {
      /* 版本号进 frameSig：按需渲染只认签名，权重不进签名就会出现
       * 「拖了滑杆、画面不动」——那正是形态键最容易被判定成「没生效」的样子。
       * ⚠ 这一行早先引用了未声明的 `mesh`：文件是 'use strict'，那三个
       *   setMorph* 接口一调就 ReferenceError，等于从来没通过。现在显式用上面那份。 */
      mesh._morphVersion = (mesh._morphVersion || 0) + 1;
    }
    requestRender(60);
    /* 面板 / 撤销 / 读盘改的是同一份 params：旋钮必须跟着走，
     * 否则会出现「右边数字 40%、脸上那根杆还在 0」这种两个真源。 */
    syncCtrlValues();
    return n;
  }
  function syncMorphWeights() { return syncMorphWeightsOf(''); }

  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : (n > 1 ? 1 : n);
  }

  /* ---------------- 组件的运行时状态（眨眼 / 呼吸 / 眼神 这类不存盘的东西） ----------------
   * 契约：组件自报 tickLive(dt, ctx)，返回值有两种写法（都认）：
   *   ① { eye_close: 0.6 }                       —— 形态键覆盖表（最早那版）
   *   ② { weight: { eye_close: 0.6 }, shift: { du, dv } }
   *                                              —— 形态键 + 贴图位移，一起交
   * 建模 App 不认得「眨眼」「眼神」，只负责按帧调用、按 max 叠到 influences 上、
   * 按 smoothstep 扭 uv、要一帧渲染。
   *
   * ⚠ 为什么单开一层而不直接改 weight：weight 进文档、进历史、进存盘。
   *   每帧改一次 = 撤销栈爆炸 + 存盘停在半闭眼。这条线对应虚幻的 UPROPERTY Transient。
   *
   * ctx 里给组件的东西全是**纯数据**（数组 + 节点对象），不是 three 对象：
   *   { state, params, node, doc, gaze: { dir:[x,y,z], dist } }
   *   gaze.dir 是「相机在网格本地坐标系里的方向」，已归一化。
   *   组件拿它算 yaw/pitch 就行，不需要知道相机在哪、也不需要碰矩阵。
   */
  function liveStateOf(nodeId, def) {
    var live = st.compLive[nodeId];
    if (!live) live = st.compLive[nodeId] = { id: '', state: null, map: null };
    /* 节点被改成别的零件 → 旧状态作废，按新组件重建（形态键名字都不一样了） */
    if (live.id !== def.id) {
      live.id = def.id;
      live.state = (typeof def.liveState === 'function') ? (def.liveState() || {}) : {};
      live.map = null;
    }
    return live;
  }

  /* 把组件返回的两种写法归一成 { weight, shift }，其余一律 null。
   * 归一在这里做一次，后面所有判断（比较、叠加、重铺）就只有一个形状。 */
  function normLive(out) {
    if (!out) return null;
    if (out.weight || out.look) {
      return { weight: out.weight || null, look: out.look || null };
    }
    return { weight: out, look: null };
  }

  /* 这一帧的覆盖和上一帧是不是「一样」—— 一样就别重铺、别重画。
   * 没有这道闸，眼神跟随会让「相机静止时 GPU 归零」直接失效：
   * 组件每帧返回同一个值，App 每帧都当它变了。 */
  function liveSame(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    var wa = a.weight, wb = b.weight;
    if (!!wa !== !!wb) return false;
    if (wa) {
      var ka = Object.keys(wa), kb = Object.keys(wb);
      if (ka.length !== kb.length) return false;
      for (var i = 0; i < ka.length; i++) {
        if (Math.abs((Number(wa[ka[i]]) || 0) - (Number(wb[ka[i]]) || 0)) > 0.002) return false;
      }
    }
    var la = a.look, lb = b.look;
    if (!!la !== !!lb) return false;
    if (la) {
      /* 角度阈值 0.2°：再细就会每帧都判「变了」，静止时 GPU 归零立刻失效 */
      if (Math.abs((la.yaw || 0) - (lb.yaw || 0)) > 0.0035) return false;
      if (Math.abs((la.pitch || 0) - (lb.pitch || 0)) > 0.0035) return false;
    }
    return true;
  }

  /* 「看」的方向：相机在世界里，眼睛在网格本地里。
   * 为什么让 App 算而不让组件算：组件只拿到纯数据，它没有矩阵也没法把
   * worldToLocal 做对（对象可能被旋转/缩放/挂在父级下）。这件事只有 App 做得对。
   *
   * 锚点由组件自报（gazeAnchor() → 本地坐标的点）；没报就用包围盒中心。
   * 用中心而不是原点：原点可能在下巴或颈部，那样算出来的 pitch 会整体偏。 */
  var GAZE = null;
  function gazeOf(obj, def) {
    if (!st.camera || !obj || !THREE) return null;
    if (!GAZE) {
      GAZE = {
        cam: new THREE.Vector3(), loc: new THREE.Vector3(), ctr: new THREE.Vector3()
      };
    }
    st.camera.getWorldPosition(GAZE.cam);
    obj.updateWorldMatrix(true, false);
    GAZE.loc.copy(GAZE.cam);
    obj.worldToLocal(GAZE.loc);
    var a = (typeof def.gazeAnchor === 'function') ? def.gazeAnchor() : null;
    if (a && a.length >= 3) {
      GAZE.loc.x -= Number(a[0]) || 0;
      GAZE.loc.y -= Number(a[1]) || 0;
      GAZE.loc.z -= Number(a[2]) || 0;
    } else if (obj.geometry && obj.geometry.boundingBox) {
      obj.geometry.boundingBox.getCenter(GAZE.ctr);
      GAZE.loc.sub(GAZE.ctr);
    }
    var len = GAZE.loc.length();
    if (len < 1e-6) return null;
    return { dir: [GAZE.loc.x / len, GAZE.loc.y / len, GAZE.loc.z / len], dist: len };
  }

  /* ---------------- 眼球：蒙皮驱动 ---------------- */
  /* 组件的运行时角度 → 骨骼旋转。组件给的永远是纯数据 { yaw, pitch }（弧度）：
   * 它不知道自己有没有骨骼、骨骼叫什么，也不该知道。
   *
   * 为什么是骨骼而不是贴图位移：第一版拿 uv 平移模拟眼神，被资产本身否掉了 ——
   * 这颗头的虹膜几乎占满眼眶，uv 偏 0.03 就露出眼睑（眼睛看起来像闭上了）。
   * 而清单里本来就有 leftEye / rightEye 两个关节和逐顶点权重，转 8° 让 448 个
   * 顶点（左右眼各 224）位移 6.9mm ≈ 眼宽的 27% —— 眼睛是真的在三维里转。
   *
   * ⚠ 每帧必须**先从 rest 复位再乘**：在上一帧结果上叠加会越转越大（和眨眼 max 同源）。
   * ⚠ 改完骨骼要立刻 updateMatrixWorld：骨骼矩阵在渲染时读，不更新会落后一帧。 */
  var LOOK_Q = null, LOOK_E = null;
  function applyLook(obj, look) {
    var sk = obj && obj.userData && obj.userData.mdSkin;
    if (!sk || !sk.left || !sk.right) return false;
    var yaw = look ? (Number(look.yaw) || 0) : 0;
    var pitch = look ? (Number(look.pitch) || 0) : 0;
    if (Math.abs(sk.yaw - yaw) < 1e-6 && Math.abs(sk.pitch - pitch) < 1e-6) return false;
    sk.yaw = yaw;
    sk.pitch = pitch;
    if (!LOOK_Q) { LOOK_Q = new THREE.Quaternion(); LOOK_E = new THREE.Euler(0, 0, 0, 'YXZ'); }
    /* ⚠ 符号取反：骨骼树挂在 `root.scale.z = -1` 的父级下（照抄流明），
     * 局部绕 Y 转 θ 在世界里看起来是绕 Y 转 −θ（镜像把 z 翻了个手性）。
     * 组件给的是「世界里该朝哪」（+yaw = 朝 +X），所以这里喂 −yaw / −pitch。
     * 不取反的症状是「看向反方向」——左右镜像那种，rest 看不出来。 */
    var q = LOOK_Q.setFromEuler(LOOK_E.set(-pitch, -yaw, 0, 'YXZ'));
    sk.left.quaternion.copy(sk.restL).multiply(q);
    sk.right.quaternion.copy(sk.restR).multiply(q);
    if (sk.root) sk.root.updateMatrixWorld(true);
    /* 视觉的**主力**在这里：把角度写给眼片位移（着色器），见 applyGazeShader 上面那段。
     *
     * ⚠ 上面那两个骨骼旋转在画面上是**看不见的**（眼球几何被皮肤整片挡住，染色实测），
     *   保留它有两个理由：① 与流明 createCameraGaze 的驱动结构保持一致，探针读的是
     *   同一组 lookYaw / lookPitch；② 将来若把皮肤换成带眼窝开口的版本，骨骼立刻就能用。
     *   真正让眼睛动的是下面这四行 —— 别以为「骨骼转了就等于看得见」，
     *   这正是上一版「眼球完全没动」的坑。
     *
     * 符号：yaw>0 = 目标在 +X 侧 → 贴片朝 +X 走；pitch>0 = 相机在下方 → 眼睛往下看 → 贴片往 −Y。
     * 归一：除以 sin(限幅)，所以「组件给的 sway」正好是画面上能看到的最大位移 ——
     * 不除会让 yaw 打到限幅也只走 28%（sin 16°），看着还是「没动」。 */
    var gz = obj.userData && obj.userData.mdGaze;
    if (gz && gz.sheet && gz.mats) {
      var lim = gz.sheet.swayAt || [1, 1];
      var kx = Math.sin(lim[0]) ? Math.sin(yaw) / Math.sin(lim[0]) : yaw;
      var ky = Math.sin(lim[1]) ? Math.sin(pitch) / Math.sin(lim[1]) : pitch;
      /* 面板把幅度开到 150% 时 k 会超过 1，给个硬上限免得贴片滑出眼眶 */
      kx = kx < -1.2 ? -1.2 : (kx > 1.2 ? 1.2 : kx);
      ky = ky < -1.2 ? -1.2 : (ky > 1.2 ? 1.2 : ky);
      var sx = gz.sheet.sway[0] * kx;
      var sy = -gz.sheet.sway[1] * ky;
      for (var i = 0; i < gz.mats.length; i++) {
        var m = gz.mats[i];
        var U = m && m.userData && m.userData.mdGazeU;
        if (U) U.value.set(sx, sy);
      }
    }
    return true;
  }

  /* 蒙皮绑定：把「对象的摆放变换」正确地接进蒙皮公式。
   *
   * three 的蒙皮是在 **bind 空间**里算的：
   *     out = bindMatrixInverse · Σw(boneWorld · boneInverse) · bindMatrix · v
   * 只有 bindMatrix / bindMatrixInverse 是**对象自己世界矩阵的一对互逆**，
   * 骨矩阵里自带的世界平移才会被抵消掉。
   *
   * ⚠ 早先这里传的是单位阵（"骨骼逆矩阵已经自己吸收了 pivot"），
   *   后果不是「偏一点」：骨矩阵是**世界空间**的，却拿去乘**本地空间**的顶点。
   *   这批头挂在 x=0.64 / y=−1.23 的位置上，于是 7° 的转动被放大成 40mm 的位移
   *   —— 眼睛顶穿脸皮、屏幕上是一片穿插和半透明叠影，而 rest 姿态完全正常
   *   （单位阵时 rest 恰好也是对的），所以死活看不出来是这里错了。
   *
   * boneInverse 不用清单里的 inverseBind：那是另一个（带镜像的）坐标系的东西。
   * 直接把骨骼摆回 rest 实测一遍 —— boneInverse = 该骨骼 rest 世界矩阵的逆，
   * 这样 rest 严格还原、pivot 怎么摆都自动适配，也不必去猜符号。
   * pivot 会随用户拖动 / 撤销改变，所以每帧比一次（7 个矩阵，成本可忽略）。 */
  function syncSkinBind(obj) {
    var sk = obj && obj.userData && obj.userData.mdSkin;
    if (!sk || !sk.skeleton) return;
    obj.updateWorldMatrix(true, false);
    var W = obj.matrixWorld;
    if (!sk.bindM) sk.bindM = new THREE.Matrix4();
    else if (sk.bindM.equals(W)) return;
    sk.bindM.copy(W);
    obj.bindMatrix.copy(W);
    obj.bindMatrixInverse.copy(W).invert();

    var qi = null;
    /* 眼球先复位，量到的才是 rest 姿态。 */
    if (sk.left && sk.right && sk.restL && sk.restR) {
      qi = [sk.left.quaternion.clone(), sk.right.quaternion.clone()];
      sk.left.quaternion.copy(sk.restL);
      sk.right.quaternion.copy(sk.restR);
    }
    sk.root.updateMatrixWorld(true);
    var list = sk.skeleton.boneInverses;
    var br = sk.skeleton.bones;
    for (var i = 0; i < list.length && i < br.length; i++) {
      list[i].copy(br[i].matrixWorld).invert();
    }
    /* 恢复刚才为了测量临时复位的眼球角度（调用方马上会按当前 look 重设一次） */
    if (qi) {
      sk.left.quaternion.copy(qi[0]);
      sk.right.quaternion.copy(qi[1]);
    }
    sk.root.updateMatrixWorld(true);
    sk.skeleton.update();
  }

  /* 组件声明了蒙皮（skin()）就给它一副骨架。返回 null = 这个对象没有骨架。
   *
   * ⚠ 顶点数必须和 skinIndex 对得上：用户编辑（挤出 / 细分 / 合并）之后顶点会变，
   *   那时索引全是错位的，强行蒙皮会得到一片乱飞的顶点。对不上就**降级为静态网格**，
   *   并把原因写在 geometry.userData 上（面板据此提示，而不是悄悄失效）。
   * ⚠ 骨骼必须挂在 pivot 里，不能挂 scene 根：模型移动 / 旋转时眼球要跟着走。 */
  function makeSkinFor(node, geo) {
    if (!node.comp || !node.comp.id) return null;
    var def = componentDefById(node.comp.id);
    if (!def || typeof def.skin !== 'function') return null;
    var s = null;
    try { s = def.skin(); } catch (e) { s = null; }
    if (!s || !s.nodes || !s.nodes.length || !s.bones || !s.bones.length) return null;
    if (!s.index || !s.weight || !s.inverseBind) return null;
    var vc = (geo.attributes.position && geo.attributes.position.count) || 0;
    /* ⚠ 组件给的 skinIndex / skinWeight 是按**资产顶点序**排的，而这里的渲染顶点
     * 已经被 buildGeometry 按 (顶点, UV) 拆过、顺序也换成面遍历序（见 seed-mesh-core
     * 的 uvVert / origOut）。两者之间的对应表就是 geo.userData.mdOrig —— 形态键位移
     * 早就靠它重排过了，权重却漏了：结果是一半的眼睛权重落在随便哪个顶点上，
     * 转视角时整张脸都在抖，而 rest 姿态照样「严格还原」（rest 恒等，任何置换都看不出来）。
     * tools/probe-md-parity.js 的 ⑨ 就是拿这个当判据抓出来的。 */
    var orig = geo.userData && geo.userData.mdOrig;
    var nAsset = s.index.length / 4;
    if (!vc || s.weight.length !== nAsset * 4 || (orig ? orig.length !== vc : nAsset !== vc)) {
      geo.userData.mdSkinLost = '顶点数已变（' + vc + '），索引对不上';
      return null;
    }
    var ixA = s.index, wtA = s.weight;
    if (orig) {
      ixA = new Float32Array(vc * 4);
      wtA = new Float32Array(vc * 4);
      for (var r0 = 0; r0 < vc; r0++) {
        var o0 = orig[r0] * 4;
        if (!(o0 >= 0 && o0 + 3 < s.index.length)) {
          geo.userData.mdSkinLost = '渲染顶点映射越界';
          return null;
        }
        for (var k0 = 0; k0 < 4; k0++) { ixA[r0 * 4 + k0] = s.index[o0 + k0]; wtA[r0 * 4 + k0] = s.weight[o0 + k0]; }
      }
    }
    var bones = s.nodes.map(function (n) {
      var b = new THREE.Bone();
      b.name = n.name || '';
      b.position.fromArray(n.position || [0, 0, 0]);
      b.quaternion.fromArray(n.rotation || [0, 0, 0, 1]);
      b.scale.fromArray(n.scale || [1, 1, 1]);
      return b;
    });
    var root = new THREE.Group();
    root.name = 'mdBones';
    /* 顶点过桥时被平移到包围盒中心（组件自己做的），骨骼必须跟着平移同样的量，
     * 否则 rest 姿态就会整体偏出一个头的位置。 */
    var c = s.center || [0, 0, 0];
    root.position.set(-c[0], -c[1], -c[2]);
    /* ⚠ 父级镜像：清单里的骨架是「脸朝 −Z」（LeftEye z=−0.032），而顶点是「脸朝 +Z」
     *   （眼球质心 z=+0.040）。流明靠 `model.scale.z = -1` 让**骨架和网格一起翻**
     *   （apps/lumen3d/app.js:739），局部变换一个都不用改 —— 整树镜像时每个节点的
     *   局部变换是不变的，镜像由父级承担。
     *
     *   照抄这一步，而不是去挪单个关节：早先只把眼球关节 placeJoint 到顶点质心，
     *   看着 rest 也对（rest 由实测逆矩阵保证恒等），但枢轴实测仍在脑后 80mm ——
     *   转眼球 = 整颗平移，画面上就是「没有看向相机」，还会顶穿脸皮。
     *   父级镜像后枢轴偏差 8.0mm（眼球半径内），12° 位移 5.09mm（真自转）。 */
    if (s.flipZ) root.scale.z = -1;
    s.nodes.forEach(function (n, i) {
      var p = (n.parent >= 0) ? bones[n.parent] : null;
      (p || root).add(bones[i]);
    });
    /* 清单里的 inverseBind 属于「脸朝 −Z」那套坐标系；root 镜像之后由 syncSkinBind
     * 把骨骼摆回 rest 实测一遍，得到严格互逆的一对矩阵 —— 这正是流明靠
     * `model.scale.z=-1` 让清单 inverseBind 自洽的等价泛化（镜像矩阵自逆，
     * 所以它不用改 inverseBind；我们多了 center 平移，只能实测）。 */
    var ident = s.bones.map(function () { return new THREE.Matrix4(); });
    var skeleton = new THREE.Skeleton(s.bones.map(function (i) { return bones[i]; }), ident);
    geo.setAttribute('skinIndex', new THREE.Float32BufferAttribute(ixA, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wtA, 4));
    var ji = s.joints || {};
    var li = (ji.leftEye != null) ? bones[ji.leftEye] : null;
    var ri = (ji.rightEye != null) ? bones[ji.rightEye] : null;
    if (!li || !ri) return null;
    return {
      root: root,
      skeleton: skeleton,
      bindM: null,
      left: li,
      right: ri,
      restL: li.quaternion.clone(),
      restR: ri.quaternion.clone(),
      yaw: 0,
      pitch: 0
    };
  }

  var liveLast = 0;
  function applyLive() {
    var now = global.performance ? global.performance.now() : Date.now();
    /* dt 上限 0.1s：标签页切回来 / 长时间不渲染时，别让相位一次跳完整个周期 */
    var dt = liveLast ? Math.min((now - liveLast) / 1000, 0.1) : 0;
    liveLast = now;
    var doc = st.doc;
    if (!doc || !doc.nodes) return;
    var dirty = false;
    var alive = null;
    /* ⚠ 驱动源是**文档里的节点**，不是 st.compLive 自己。
     *   早先写成 `Object.keys(st.compLive)` 再遍历 —— 表一开始是空的，于是永远进不去，
     *   永远不初始化第一份 live 状态（眨眼一次都不会发生，而且没有任何报错）。 */
    for (var i = 0; i < doc.nodes.length; i++) {
      var node = doc.nodes[i];
      if (!node.comp || !node.comp.id) continue;
      var def = componentDefById(node.comp.id);
      if (!def || typeof def.tickLive !== 'function') continue;
      if (!alive) alive = Object.create(null);
      alive[node.id] = 1;
      var live = liveStateOf(node.id, def);
      var obj = morphObjectOf(node.id);
      if (!obj) continue;
      /* 每帧对一次 pivot 变换（7 个矩阵比较）：用户拖动 / 撤销改了摆放位置时，
       * 骨骼逆矩阵必须跟着翻新，否则蒙皮会重复叠加位移（整脸被拉扯）。 */
      syncSkinBind(obj);
      var out = null;
      try {
        out = def.tickLive(dt, {
          state: live.state, params: node.comp.params || {}, node: node, doc: doc,
          gaze: gazeOf(obj, def)
        });
      } catch (e) { out = null; }
      if (out === undefined) out = null;
      var map = normLive(out);
      /* 从「有覆盖」变成「没有覆盖」也要重铺一次，否则最后一帧的覆盖留在脸上。
       * 眼球角度同理：归零那一帧必须真写一遍 0，光「不应用」会让眼球停在最后那个角度。 */
      /* 捏脸 uniform 每帧全量送（见 syncShapeOf 注释）：改参数的路径太多，差量必漏 */
      syncShapeOf(obj, node);
      var changed = !liveSame(map, live.map);
      /* 渲染目标换代（几何重建 / 切对象 / applyMesh）也必须重铺：
       * 新对象带着**全新的骨骼**（初值 = rest），而相机不动时 map 一模一样，
       * 只看 map 就会判「没变」→ 眼球回正中，而且再也不动，页面上零报错。 */
      if (live.geo !== obj.geometry) {
        live.geo = obj.geometry;
        changed = true;
      }
      /* ⚠ 基线只能在**真的应用了**之后前进。早先这里无条件写 `live.map = map`，
       *   于是「变化幅度小于阈值」的那些帧被跳过、基线却跟着走掉了 ——
       *   漂移再也追不回来。症状：指数平滑收尾时每帧只差 0.18°（阈值 0.2°），
       *   连续几帧都不应用，眼球永远停在最后那 0.9° 上（关掉视线也不回正）。 */
      if (!changed) continue;
      live.map = map;
      /* 基线永远是持久权重，再叠 live —— 与 syncMorphWeightsOf 同一口径 */
      if (obj.morphTargetInfluences) {
        var mesh = meshOfNode(node.id);
        var morphs = (mesh && mesh.morphs) || [];
        for (var k = 0; k < morphs.length && k < obj.morphTargetInfluences.length; k++) {
          obj.morphTargetInfluences[k] = clamp01(morphs[k].weight);
        }
        applyMorphOverlay(obj, map && map.weight);
      }
      applyLook(obj, map && map.look);
      dirty = true;
    }
    /* 节点被删 / 被撤销掉：状态跟着清，否则这张表只增不减 */
    if (alive) {
      Object.keys(st.compLive).forEach(function (id) { if (!alive[id]) delete st.compLive[id]; });
    } else if (Object.keys(st.compLive).length) {
      st.compLive = Object.create(null);
    }
    if (dirty) requestRender(60);
  }

  /* 组件自带的「表面」：贴图 / 底色 / 透明，由组件源自报，这里只往材质上贴。
   * 为什么不写进 doc.materials.slotMaps —— 那是**文档级**材质库，按槽索引；
   * 头模用槽 0，立方体也用槽 0，写进去等于给立方体贴一张脸。
   * 材质本身是每个对象新建的（makeMaterials），所以后置改 map 不会串到别人身上。
   * ⚠ mdBaseColor / mdBaseMap 必须一起写：视口的「纹理 / 材质」开关靠它们还原，
   *   只改 map 的话，用户切一次显示模式再切回来，脸就白了。 */
  function applyComponentSurface(child, node) {
    if (!child || !node || !node.comp || !node.comp.id) return;
    var def = componentDefById(node.comp.id);
    if (!def || typeof def.surface !== 'function') return;
    var list = null;
    try { list = def.surface(node); } catch (e) { list = null; }
    if (!list || !list.length) return;
    var mats = Array.isArray(child.material) ? child.material : [child.material];
    /* 组件只报一份表面（同一张脸皮贴图），而几何可能分成多个材质组
     * （皮肤 + 眼睛透明层）。只有一份时广播到所有组 —— 否则眼睛那组没有 map，
     * 会画成一片纯白板，正好盖在脸上。组件若真有多份表面，就按序各管各的。 */
    var spread = list.length === 1 && mats.length > 1;
    for (var i = 0; i < mats.length; i++) {
      var s = spread ? list[0] : list[i];
      var m = mats[i];
      if (!s || !m || !m.color) continue;
      if (s.color) m.color.set(s.color);
      if (s.map) m.map = sharedTexture(s.map);
      m.userData.mdBaseColor = s.color || '#ffffff';
      m.userData.mdBaseMap = m.map || null;
      m.needsUpdate = true;
    }
  }

  /* 按节点建 pivot：一个对象一个 Group（几何来自它自己的网格，缓存按 mesh.version 复用）
   * 有蒙皮（组件声明了 skin()）就建成 SkinnedMesh —— 眼球是**真的绕关节转**，
   * 不能靠贴图平移（那颗头的虹膜几乎占满眼眶，偏一点就露眼睑）。 */
  function makePivotFor(node, mesh, cache) {
    var geo = SeedModel.Mesh.buildGeometry(mesh, { cache: cache !== false });
    var skin = makeSkinFor(node, geo);
    var compGroups = componentGroupMats(node);
    var mats = fitGroupMaterials(makeMaterials(mesh), compGroups);
    /* 眼片位移：只有声明了 eyeSheet() 的组件才挂（头模）。
     * 两组材质都挂 —— 皮肤上那块贴片是主体；被遮住的眼球几何一起挪，
     * 免得它在偏移后的皮肤下面顶出来（这是「转视角穿模」的一种来源）。 */
    var sheet = componentEyeSheet(node);
    applyGazeShader(mats, sheet);
    /* 捏脸：脸型变形器挂在同一批材质上（链在 gaze 的 onBeforeCompile 之后） */
    var shapeU = applyShapeShader(node, mats, compGroups);
    var child = skin ? new THREE.SkinnedMesh(geo, mats) : new THREE.Mesh(geo, mats);
    if (skin) {
      /* 真正的一对 bindMatrix / bindMatrixInverse 由 syncSkinBind 按对象的世界矩阵写入
       * （它在这段之后紧跟一次 pivot.updateMatrixWorld 就跑）。这里只负责挂上骨架。 */
      child.bind(skin.skeleton, new THREE.Matrix4());
      /* ⚠ 必须 detached：默认的 'attached' 会在每次 updateMatrixWorld 里把
       * bindMatrixInverse 覆写成 matrixWorld 的逆，而 bindMatrix 还留着旧值 ——
       * 一对不再互逆的矩阵会让蒙皮整体偏出去。 */
      child.bindMode = 'detached';
      /* 蒙皮对象的包围盒是 rest 姿态的，转个眼球就可能被判成「出视野」而整颗消失 */
      child.frustumCulled = false;
      child.userData.mdSkin = skin;
    }
    attachMorphs(child, geo);
    applyComponentSurface(child, node);
    child.name = node.name;
    child.userData.mdPart = 'solid';
    /* applyLook 要靠这份索引找到「写哪几个 uniform」：材质可能被重建，
     * 所以每次从当前材质上现取，不在闭包里存旧引用。 */
    if (sheet) child.userData.mdGaze = { sheet: sheet, mats: mats };
    if (shapeU) child.userData.mdShape = { mats: mats, uni: shapeU };
    var pivot = new THREE.Group();
    pivot.name = node.name + '_pivot';
    pivot.userData.mdNode = node.id;
    pivot.add(child);
    /* 骨骼和网格同级（不是挂在网格里）：模型移动 / 旋转时骨骼跟着走，
     * 但网格顶点位置仍由骨骼矩阵决定 —— 这正是蒙皮的定义。 */
    if (skin) pivot.add(skin.root);
    pivot.visible = node.visible !== false;
    var t = node.transform;
    pivot.position.fromArray(t.position);
    pivot.quaternion.fromArray(t.rotation);
    pivot.scale.fromArray(t.scale);
    pivot.updateMatrixWorld(true);
    /* 首次绑定：把 pivot 的摆放变换扣进骨骼逆矩阵（否则第一帧就会整脸错位） */
    if (skin) syncSkinBind(child);
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
      color: new THREE.Color(p.edgeColor),
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
      : mode === 'flat' ? '平涂'
      : mode === 'normals' ? '法线'
      : mode === 'uv' ? 'UV 岛着色'
      : '实体';
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
  /* 视口条「照明」菜单的四个预设：默认 / 双灯 / 仅主光 / 环境光。
   * 强度顺序固定对应 st.lights = [ambient, key, fill, rim]（见视口初始化）。 */
  var LIGHT_PRESETS = {
    default: { label: '默认', ambient: 0.18, key: 0.85, fill: 0.26, rim: 0.19 },
    two: { label: '双灯', ambient: 0.30, key: 0.95, fill: 0.45, rim: 0 },
    key: { label: '仅主光', ambient: 0.10, key: 1.15, fill: 0.06, rim: 0.05 },
    ambient: { label: '环境光', ambient: 0.95, key: 0, fill: 0, rim: 0 }
  };
  function applyLighting() {
    var preset = LIGHT_PRESETS[st.lightingPreset] || LIGHT_PRESETS.default;
    var lit = vfOn('lighting');
    var keys = ['ambient', 'key', 'fill', 'rim'];
    (st.lights || []).forEach(function (l, i) {
      var base = preset[keys[i]] != null ? preset[keys[i]] : l.userData.mdBaseIntensity;
      l.userData.mdBaseIntensity = base;
      l.intensity = lit ? base : (l.isAmbientLight ? base : 0);
    });
  }
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
          /* 法线材质没有 color / map：法线色本身就是数据，别被材质 / 纹理开关改写 */
          if (!m.color || typeof m.color.set !== 'function') return;
          var want = useMat ? (m.userData.mdBaseColor || CLAY) : CLAY;
          m.color.set(want);
          var baseMap = m.userData.mdBaseMap;
          var nextMap = useTex ? (baseMap === undefined ? null : baseMap) : null;
          if (m.map !== nextMap) { m.map = nextMap; m.needsUpdate = true; }
        });
      });
    });
    /* 关灯只保留环境光：主/补/轮廓归零，形体变平但不会全黑 */
    applyLighting();
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

  /* 实体在「受光 / 平涂 / 法线」之间切换：原材质记在 mdLitMats，
   * unlit 与法线版本各按需生成一份，切回来不会丢贴图与颜色。
   * look：null = 受光（原材质）、'flat' = 平涂、'normals' = 法线。 */
  function applySolidLook(o, look) {
    if (!o || !o.material) return;
    if (!o.userData.mdLitMats) o.userData.mdLitMats = o.material;
    var lit = o.userData.mdLitMats;
    if (look === 'normals') {
      if (!o.userData.mdNormalMats) {
        var srcN = Array.isArray(lit) ? lit : [lit];
        var madeN = srcN.map(function (m) {
          var n = new THREE.MeshNormalMaterial({
            side: m.side,
            toneMapped: false   /* 法线色是数据，不要被 ACES 压色 */
          });
          n.userData.mdBaseColor = (m.userData && m.userData.mdBaseColor) || CLAY;
          n.userData.mdBaseMap = (m.userData && m.userData.mdBaseMap) || null;
          return n;
        });
        o.userData.mdNormalMats = Array.isArray(lit) ? madeN : madeN[0];
      }
      if (o.material !== o.userData.mdNormalMats) o.material = o.userData.mdNormalMats;
      return;
    }
    if (look !== 'flat') {
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

  /* ---------------- 软选择热力图 ----------------
   * 权重内核在 js/md-soft.js；这里只负责把权重画成视口叠加层。
   * 用「三角面 + 顶点色」单独一层：实体材质保持原样，关掉热力图立刻恢复；
   * 只在建模模式的表面（非线框）且当前有组件选择时显示；绘制模式 / 线框 /
   * 隔离替身不叠加（绘制模式要让位给贴图，替身只画选中面）。 */
  function softHeatWanted() {
    return !!(st.soft.on && st.soft.heatmap && st.mesh && st.pivot &&
      st.editor !== 'paint' && st.selMode !== 'object' && !st.isoComp &&
      global.MDSoft);
  }

  function softMapSig() {
    if (!softHeatWanted()) return '';
    var idx = selVertexIndices();
    if (!idx.length) return '';
    var cs = (st.soft.falloff === 'custom' && st.soft.custom) ? st.soft.custom.join(',') : '';
    return [
      st.mesh.version, st.soft.mode, Number(st.soft.size).toFixed(3),
      st.soft.falloff, cs, global.MDSoft.hashIndices(idx)
    ].join('|');
  }

  function buildSoftHeatmap(sig) {
    var idx = selVertexIndices();
    var res = global.MDSoft.weights(st.mesh, idx, {
      mode: st.soft.mode,
      radius: Math.max(1e-5, Number(st.soft.size) || 0),
      falloff: st.soft.falloff,
      custom: st.soft.custom
    });
    st.softInfo = { mode: res.mode, radius: res.radius, count: res.count };
    var w = res.w, p = st.mesh.positions;
    var pos = [], col = [], pick = [], rgb = [0, 0, 0];
    for (var f = 0; f < st.mesh.faceIds.length; f++) {
      var s = st.mesh.faceOffsets[f], e = st.mesh.faceOffsets[f + 1];
      for (var t = s + 1; t < e - 1; t++) {
        var ia = st.mesh.faceIndices[s], ib = st.mesh.faceIndices[t], ic = st.mesh.faceIndices[t + 1];
        var wa = w[ia], wb = w[ib], wc = w[ic];
        if (wa <= 1e-4 && wb <= 1e-4 && wc <= 1e-4) continue;
        var tri = [ia, ib, ic], tw = [wa, wb, wc];
        for (var k = 0; k < 3; k++) {
          var vi = tri[k];
          pos.push(p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]);
          global.MDSoft.heatColor(tw[k], rgb);
          col.push(rgb[0], rgb[1], rgb[2]);
          pick.push(vi);
        }
      }
    }
    if (!pos.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.72,
      depthWrite: false, side: vfOn('backface') ? THREE.DoubleSide : THREE.FrontSide,
      toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    var obj = new THREE.Mesh(geo, mat);
    obj.name = 'soft-heatmap';
    obj.userData.mdPart = 'softmap';
    obj.userData.mdSoftPick = pick;
    obj.userData.mdSoftSig = sig;
    obj.renderOrder = 2;
    obj.frustumCulled = false;
    return obj;
  }

  function disposeSoftLayer(pv) {
    var layer = pv && pv.userData && pv.userData.mdSoftLayer;
    if (layer) {
      if (layer.parent) layer.parent.remove(layer);
      if (layer.geometry) { try { layer.geometry.dispose(); } catch (e) {} }
      if (layer.material) { try { layer.material.dispose(); } catch (e2) {} }
    }
    if (pv && pv.userData) {
      pv.userData.mdSoftLayer = null;
      pv.userData.mdSoftSig = '';
    }
  }

  /* 只给激活对象画：选择集属于它；其他 pivot 上残留的旧层一律清掉。 */
  function ensureSoftHeatmap(pv) {
    if (!pv) return null;
    var wanted = (pv === st.pivot) ? softMapSig() : '';
    var have = pv.userData && pv.userData.mdSoftLayer;
    if (!wanted) {
      if (have) disposeSoftLayer(pv);
      return null;
    }
    if (have && pv.userData.mdSoftSig === wanted) {
      if (have.material) have.material.side = vfOn('backface') ? THREE.DoubleSide : THREE.FrontSide;
      return have;
    }
    if (have) disposeSoftLayer(pv);
    var layer = buildSoftHeatmap(wanted);
    if (!layer) return null;
    pv.add(layer);
    pv.userData.mdSoftLayer = layer;
    pv.userData.mdSoftSig = wanted;
    requestRender(0);
    return layer;
  }

  function refreshSoftHeat() {
    if (!st.pivot) return;
    ensureSoftHeatmap(st.pivot);
    requestRender(0);
  }

  function applyShading() {
    if (!st.pivot) return;
    var p = st.prefs || prefs();
    var mode = st.shading;
    var islands = mode === 'uv';
    /* look 只决定实体怎么画；线框是独立叠加层，不参与这里的判断 */
    var look = mode === 'flat' ? 'flat' : mode === 'normals' ? 'normals' : null;
    var showFaces = !islands;
    /* 线框叠加 = 「线框」勾选 × 边线总开关；与当前着色模式无关 */
    var showEdges = vfOn('wireframe') && vfOn('edges');
    /* 组件隔离（面 / 岛）时只显示替身网格，原件的面、边线、顶点一律让位 */
    var isoComp = !!st.isoComp;
    var side = vfOn('backface') ? THREE.DoubleSide : THREE.FrontSide;
    var edgeColor = mode === 'normals' ? '#e6edf6' : p.edgeColor;
    if (st.edgeLines) {
      st.edgeLines.material.color.set(edgeColor);
    }
    /* 顶点只在顶点模式下显示（Maya 的行为）：816 面的球体上每个点都画会糊成一片 */
    var showVerts = st.selMode === 'vertex' && vfOn('verts');
    eachViewPivot(function (pv) {
      /* UV 岛着色是按每个对象自己的网格算的：多对象场景里不能只画激活那个 */
      var layer = islands ? ensureIslandOverlay(pv, side) : pv.userData.mdIslandLayer;
      /* 热力图只叠激活对象；ensureSoftHeatmap 会顺手清掉其他 pivot 上的旧层 */
      var heat = ensureSoftHeatmap(pv);
      pv.traverse(function (o) {
        var part = o.userData && o.userData.mdPart;
        var off = !!(o.userData && o.userData.mdPreviewOff);
        if (part === 'solid') {
          if (showFaces) applySolidLook(o, look);
          /* 法线材质没有 color / map，applyViewFlags 会跳过它，这里单独同步背面开关 */
          if (showFaces && look === 'normals' && o.material) {
            var nms = Array.isArray(o.material) ? o.material : [o.material];
            nms.forEach(function (mm) {
              if (mm && mm.side !== side) { mm.side = side; mm.needsUpdate = true; }
            });
          }
          o.visible = showFaces && !off && (!isoComp || !!o.userData.mdIsolate);
        } else if (part === 'edges') {
          o.visible = showEdges && !off && (!isoComp || !!o.userData.mdIsolate);
        } else if (part === 'verts') o.visible = showVerts && !isoComp;
        else if (part === 'uvisland') o.visible = islands;
        else if (part === 'softmap') o.visible = showFaces && !isoComp;
      });
      if (layer && layer.material) layer.material.side = side;
      if (heat && heat.material) heat.material.side = side;
    });
    /* 预览和正式模型一样吃着色开关（面永远在，线框按勾选叠上去） */
    if (st.previewHost) {
      st.previewHost.traverse(function (o) {
        var part = o.userData && o.userData.mdPart;
        if (part === 'solid') {
          /* UV 岛模式正式对象换成岛色，预览没有 UV 分层：用平涂色保持「无光照」的一致观感 */
          applySolidLook(o, look || (islands ? 'flat' : null));
          o.visible = true;
        } else if (part === 'edges') {
          o.visible = showEdges;
          if (o.material) o.material.color.set(edgeColor);
        }
      });
    }
    applyViewFlags();
  }

  function releaseView() {
    /* 换文档前先把绘画状态收干净：工作副本 / 显式材质槽 / 魔棒锁岛 / 粘面缓存
     * 都属于上一份网格。留到新文档里，轻则笔落在一张无关的岛上「画不上」，
     * 重则抬笔时把旧画布提交进新文档的材质栈。 */
    if (PAINT && typeof PAINT.dropDoc === 'function') PAINT.dropDoc();
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
    disposeObjectSelection();
    st.hoverPick = null;
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
       * 这里收敛到真实存在的节点；只有本来就选着东西时才保证激活对象在集合里 ——
       * 空选是合法状态，不能靠重建把选择集补回 1 个。 */
      var aliveIds = Object.create(null);
      SeedModel.Scene.nodesOf(st.doc).forEach(function (n) { aliveIds[n.id] = 1; });
      st.nodeIds = (st.nodeIds || []).filter(function (id) { return aliveIds[id]; });
      if (st.nodeIds.length && st.node && st.nodeIds.indexOf(st.node.id) < 0) st.nodeIds.push(st.node.id);
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
        st.showGrid = VF.get('grid') !== false;
        if (st.gridHelper) st.gridHelper.visible = st.showGrid;
        applyShading();          /* edges / verts / backface / material / texture / lighting / wireframe 一次收口 */
        updateChrome();
        /* 线框 / 边线只改 visible，材质与帧指纹都不变，必须显式要一帧 */
        requestRender(0);
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

  /* 统一法线朝向：修「面结构正常但纯色发黑」——导入模型的三角形绕序不一致，
   * 渲染法线按绕序重算后有一半朝内，光照里就是黑块。
   * 只改绕序（UV / 材质槽 / 拓扑都不动），并把平滑角设成 60°，
   * 避免重叠的头发卡片被焊成一根长度≈0 的法线。 */
  function unifyNormalsNow() {
    var SeedOps = global.SeedOps;
    var base = baseMeshNow();
    if (!SeedOps || !SeedOps.unifyWinding || !base) {
      setStatus('统一法线朝向：当前没有可编辑的网格', true);
      return false;
    }
    var out = SeedOps.unifyWinding(base);
    if (!out) {
      setStatus('统一法线朝向：网格里没有面', true);
      return false;
    }
    var flipped = out._flipped || 0;
    delete out._flipped;
    out.smoothAngle = 60;
    applyMesh(out, '统一法线朝向');
    setStatus('统一法线朝向：翻转 ' + flipped + ' 个面，并按 60° 平滑法线');
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
        { key: 'dist', label: '厚度', value: 0, min: -2, max: 2, step: 0.01 },
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
      /* 修法线：导入模型绕序不一致时，视口里纯色会出现黑色三角形块 */
      SeedCommands.define({
        id: 'mesh.unifyNormals', label: '统一法线朝向', group: 'mesh', key: '', order: 26,
        when: function () { return !!(st.doc && baseMeshNow()); },
        run: function () { return unifyNormalsNow(); }
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

  /* 参数读数：按 step 决定小数位（0.01 → 两位，1 → 整数），滑条和读数共用一份格式 */
  function paramText(v, step) {
    var s = Math.abs(Number(step));
    var dec = (!isFinite(s) || s <= 0) ? 2 : (s >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log(s) / Math.LN10)));
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    return n.toFixed(dec);
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
      /* 数值参数一律用滑条：拖操纵器时读数实时跟着变，手不用离开视口 */
      var v = Number(p.value) || 0;
      var step = p.step != null ? p.step : 0.01;
      var mn = p.min != null ? p.min : -1;
      var mx = p.max != null ? p.max : 1;
      if (!(mx > mn)) mx = mn + 1;
      return '<label class="md-hbp-row md-tp-slider"><span>' + esc(p.label) + '</span>' +
        '<input type="range" data-tp="' + i + '" value="' + v + '" min="' + mn + '" max="' + mx +
        '" step="' + step + '">' +
        '<b data-tp-out="' + i + '">' + paramText(v, step) + '</b></label>';
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
      var out = box.querySelector('[data-tp-out="' + el.dataset.tp + '"]');
      if (out) out.textContent = paramText(v, p.step);
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
    if (EXGZ.gizmo || !st.scene || !THREE) return EXGZ.gizmo;
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
    EXGZ.gizmo = { group: group, shaft: shaft, head: head, root: root, radius: 0.5, basePx: null, tipPx: null };
    return EXGZ.gizmo;
  }

  function hideExtrudeGizmo() {
    EXGZ.drag = null;
    EXGZ.hover = null;
    if (st.canvas) st.canvas.style.cursor = '';
    if (EXGZ.gizmo) EXGZ.gizmo.group.visible = false;
  }

  /* 选中面的世界中心 / 平均法线 / 半径（用文档网格，预览网格只是临时壳） */
  function extrudeSelectionWorld() {
    if (!st.mesh || !st.pivot || !SeedModel.Mesh) return null;
    var ids = selFaceIds();
    if (!ids.length) return null;
    var M = SeedModel.Mesh, pm = st.pivot.matrixWorld;
    /* 法线必须从零向量开始累加：旧代码把初值写成 [0,0,1]，选中 +X 面时得到 [1,0,1]，
     * 归一化后箭头变成 45° 斜向，和面法线对不上。 */
    var c = [0, 0, 0], nrm = [0, 0, 0], tmpN = [0, 0, 0];
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
    var nl = Math.sqrt(nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]);
    if (!(nl > 1e-9)) { nrm[0] = 0; nrm[1] = 0; nrm[2] = 1; nl = 1; }
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
    if (!live) { if (EXGZ.gizmo) EXGZ.gizmo.group.visible = false; return; }
    /* 四视图的指针走分屏自己的交互，主视口的屏幕坐标不成立；先收起，回单视图再出现 */
    if (st.quad) { if (EXGZ.gizmo) EXGZ.gizmo.group.visible = false; return; }
    var fr = extrudeSelectionWorld();
    if (!fr || !st.camera || !st.canvas) { if (EXGZ.gizmo) EXGZ.gizmo.group.visible = false; return; }
    var g = ensureExtrudeGizmo();
    if (!g) return;
    var dist = liveParamValue('dist', 0);
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
    var g = EXGZ.gizmo;
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
    var g = EXGZ.gizmo;
    if (!g) return false;
    var ax = g.tipPx.x - g.basePx.x, ay = g.tipPx.y - g.basePx.y;
    var al = Math.sqrt(ax * ax + ay * ay) || 1;
    EXGZ.drag = {
      mode: mode, x0: e.clientX, y0: e.clientY,
      dist0: liveParamValue('dist', 0),
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
    var d = EXGZ.drag;
    if (!d) return;
    e.preventDefault();
    var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    var patch, label;
    if (d.mode === 'arrow') {
      var along = dx * d.axis.x + dy * d.axis.y;
      var v = Math.max(-2, Math.min(2, d.dist0 + along * d.wpp));
      patch = { dist: Math.round(v * 100) / 100 };
      label = '厚度 ' + patch.dist.toFixed(2);
    } else {
      var v2 = Math.max(-2, Math.min(2, d.offset0 + dx * (d.radius / 180)));
      patch = { offset: Math.round(v2 * 100) / 100 };
      label = '顶面偏移 ' + patch.offset.toFixed(2);
    }
    if (global.SeedTools) global.SeedTools.drag({ params: patch });
    syncToolPanelInputs();
    setStatus('挤出：' + label + '（Enter 提交，Esc 取消）');
  }

  function onExtrudeGizmoUp() {
    if (!EXGZ.drag) return;
    EXGZ.drag = null;
    EXGZ.hover = null;
    st.pickDown = null;
    global.removeEventListener('pointermove', onExtrudeGizmoMove, true);
    global.removeEventListener('pointerup', onExtrudeGizmoUp, true);
    if (st.canvas) st.canvas.style.cursor = '';
  }

  /* 拖动箭头时把面板里的滑条与读数同步过去（不然手柄改了、滑条还停在旧位置） */
  function syncToolPanelInputs() {
    var box = st.toolPanel, SeedTools = global.SeedTools;
    if (!box || !SeedTools || !SeedTools.isLive()) return;
    var list = SeedTools.listParams();
    var inputs = box.querySelectorAll('input[data-tp]');
    for (var i = 0; i < inputs.length; i++) {
      var p = list[+inputs[i].dataset.tp];
      if (!p || !isFinite(p.value) || document.activeElement === inputs[i]) continue;
      var v = Number(p.value);
      inputs[i].value = String(v);
      var out = box.querySelector('[data-tp-out="' + inputs[i].dataset.tp + '"]');
      if (out) out.textContent = paramText(v, p.step);
    }
  }

  /* 撤销 / 重做只留转发：栈与网格副本都在 md-history.js 里 */
  /* ⚠ 撤销/重做前必须丢掉控制器里未提交的事务：
   * 快照已经换了，再拿旧 before 去比会记出一条根本没发生的「改动」。 */
  function undo() { st.comp.txn = null; return HIST.undo(); }
  function redo() { st.comp.txn = null; return HIST.redo(); }

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
      /* 软选择：交给 md-soft.js 统一算权重（体积 / 表面两种距离口径）。
       * 选中点自身权重恒 1，不放进 softIdx；周围顶点按曲线衰减。 */
      if (st.soft.on && global.MDSoft) {
        var res = global.MDSoft.weights(st.mesh, idx, {
          mode: st.soft.mode,
          radius: Math.max(1e-5, Number(st.soft.size) || 0),
          falloff: st.soft.falloff,
          custom: st.soft.custom
        });
        var softIdx = [], softW = [], softBase = [];
        var pp = st.mesh.positions;
        for (var a = 0; a < res.affected.length; a++) {
          var svi = res.affected[a];
          softIdx.push(svi);
          softW.push(res.w[svi]);
          softBase.push(pp[svi * 3], pp[svi * 3 + 1], pp[svi * 3 + 2]);
        }
        st.compDrag.softIdx = softIdx;
        st.compDrag.softW = softW;
        st.compDrag.softBase = softBase;
        st.compDrag.softMode = res.mode;
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
        (d.softIdx && d.softIdx.length
          ? '，软选择（' + (d.softMode === 'surface' ? '表面' : '体积') + '）影响 ' + d.softIdx.length + ' 个'
          : ''));
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
        st.soft.size = Math.max(0, Math.min(5, sv));
        if (st.soft.on) {
          setStatus('软选择半径：' + st.soft.size.toFixed(2) + ' m · ' +
            (st.soft.mode === 'surface' ? '表面（测地）' : '体积（欧氏）'));
        }
      }
      drawSoftCurve();
      refreshSoftHeat();
      return;
    }
    if (el.id === 'mdBrushSize' || el.id === 'mdBrushSizeBar') {
      setPaintSize(el.value);
      return;
    }
    if (el.id === 'mdBrushOpacity' || el.id === 'mdBrushOpacityBar') {
      setPaintOpacity(el.value);
      return;
    }
    if (el.id === 'mdBrushColor' || el.id === 'mdBrushColorBar') {
      setPaintColor(el.value);
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
    if (el.dataset.mdCp) {
      setComponentParam(el.dataset.mdCp, el.value, ctlHostOf(el));
      return;
    }
    /* 组件自画面板上的滑杆（流明头模的形态键强度）：拖动时只重画剪影，不重铺面板 */
    if (el.dataset.mdCev) {
      componentEvent('input', el, ctlHostOf(el));
      return;
    }
    if (el.dataset.mdGlobal !== 'name') return;
    if (!st.editBefore) st.editBefore = snap();
    applyName(el);
  }

  /* 命令行里的「视图 / 显示 / 渲染器」快捷命令。
   * 这些不是网格算子，没有进 SeedCommands 表，所以在查表前先拦截。
   * 返回 true = 已处理，false = 继续走 SeedCommands。 */
  function runDeskCommand(v) {
    var parts = String(v || '').trim().split(/\s+/);
    var k = (parts[0] || '').toLowerCase();
    var a = (parts[1] || '').toLowerCase();
    var b = (parts[2] || '').toLowerCase();
    if (k === 'camera' || k === 'view') {
      var map = { persp: 'iso', perspective: 'iso', iso: 'iso', front: 'front', back: 'back',
        left: 'left', right: 'right', top: 'top', bottom: 'bottom' };
      if (!map[a]) { setStatus('camera 参数：persp / iso / front / back / left / right / top / bottom', true); return true; }
      viewFromPreset(map[a]);
      return true;
    }
    if (k === 'shading' || k === 'shade') {
      /* 保留 wire / shaded-wire 两个旧值：它们现在等于「打开线框叠加」，不再是一种独立着色 */
      if (['shaded', 'flat', 'normals', 'uv', 'wire', 'shaded-wire'].indexOf(a) < 0) {
        setStatus('shading 参数：shaded / flat / normals / uv（线框用 display wireframe）', true);
        return true;
      }
      setShading(a);
      return true;
    }
    if (k === 'display') {
      var VF = global.SeedViewFlags;
      var names = VF ? VF.all().map(function (f) { return f.name; }) : [];
      if (names.indexOf(a) < 0) {
        setStatus('display 参数：' + (names.join(' / ') || '栅格 / 边线 / 顶点 / 背面 / 材质 / 纹理 / 光照 / 线框'), true);
        return true;
      }
      var cur = !!VF.get(a);
      var next = b === 'off' || b === '0' || b === 'false' ? false
        : b === 'on' || b === '1' || b === 'true' ? true : !cur;
      VF.set(a, next);
      setStatus('显示：' + a + ' = ' + (next ? '开' : '关'));
      return true;
    }
    if (k === 'tone' || k === 'tonemapping') {
      if (['aces', 'reinhard', 'none'].indexOf(a) < 0) {
        setStatus('tone 参数：aces / reinhard / none', true);
        return true;
      }
      savePrefs({ toneMapping: a });
      applyRenderTone();
      setStatus('色调映射：' + toneLabel(a));
      return true;
    }
    if (k === 'exposure') {
      var n = Number(parts[1]);
      if (!isFinite(n)) { setStatus('exposure 需要一个数字，例如 exposure 1.2', true); return true; }
      n = Math.max(0.05, Math.min(4, n));
      savePrefs({ exposure: n });
      applyRenderTone();
      setStatus('曝光：' + n.toFixed(2));
      return true;
    }
    if (k === 'select') {
      if (['object', 'vertex', 'edge', 'face', 'island'].indexOf(a) < 0) {
        setStatus('select 参数：object / vertex / edge / face / island', true);
        return true;
      }
      setSelMode(a);
      return true;
    }
    if (k === 'isolate') { toggleIsolate(); return true; }
    if (k === 'uv') { openUVEditor(); return true; }
    if (k === 'tex' || k === 'texture') { openTextureEditor(); return true; }
    if (k === 'projbake') { openProjBake(); return true; }
    return false;
  }

  function onKeyDown(e) {
    var el = e.target;
    if (!el || el.id !== 'mdCmd' || e.key !== 'Enter') return;
    var v = String(el.value || '').trim();
    el.value = '';
    if (!v) {
      setStatus('命令示例：camera front / shading wire / display grid off / tone aces / exposure 1.2 / mesh.extrude');
      return;
    }
    if (runDeskCommand(v)) return;
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
    setStatus(v ? '命令行「' + v + '」：未注册（可以是注册命令或 camera / shading / display / tone / exposure / select / isolate / uv）' : '');
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
      else if (k === 'a') { selectAll(); }
      else if (k === 'i') { invertSelection(); }
      else hit = false;
      if (hit) { e.preventDefault(); }
      return;
    }

    /* 绘制模式：工具快捷键先于建模键位生效（B / P / E / R / T / I / W，G = 岛填充）。
     * 这些键在建模模式另有含义（W / E / R = 变换、F = 框显），只在这里接管，
     * 切回建模模式立刻恢复原语义，不存在两套同时生效的键位。 */
    if (st.editor === 'paint') {
      if (k === 'g') {
        if (PAINT && PAINT.fillIslands) PAINT.fillIslands();
        e.preventDefault();
        return;
      }
      if (PAINT_KEYS[k]) {
        setPaintTool(PAINT_KEYS[k]);
        e.preventDefault();
        return;
      }
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
        else if (st.hoverPick) { clearHoverPick(); break; }
        else if (st.selMode !== 'object' && selCount()) { clearSelection(); break; }
        else if (st.selMode === 'object' && st.nodeIds.length) { clearSelection(); break; }
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
    /* 组件自己的下拉（流明头模的形态键 / 表情切换）：change 才处理，
     * 一次选择只重铺一次面板 */
    if (el.dataset.mdCev) {
      var ctlId = ctlHostOf(el);
      componentEvent('change', el, ctlId);
      /* 下拉 / 复选框选完 = 一次完整操作，在这里把事务落成一条历史。
       * 拖动滑杆不会走到这里（input 不提交），松手时浏览器才补一个 change。 */
      if (ctlId) compTxnCommit();
      return;
    }
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
      setPaintBrush(el.value);
      return;
    }
    if (el.id === 'mdBrushFile') {
      setCustomBrushFile(el.files && el.files[0]);
      return;
    }
    if (el.id === 'mdPaintSlotSel') {
      var us = Number(el.value);
      st.paint.userSlot = (isFinite(us) && us >= 0) ? us : -1;
      updatePaintUi();
      setStatus(st.paint.userSlot >= 0
        ? ('绘画材质槽：只画进「' + slotNameAt(st.paint.userSlot) + '」')
        : '绘画材质槽：自动（按落笔面所在的槽）');
      return;
    }
    if (el.id === 'mdPaintMask') {
      st.paint.mask = !!el.checked;
      updatePaintUi();
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
    if (el.tagName === 'SELECT' && el.id === 'mdSoftMode') {
      st.soft.mode = el.value === 'surface' ? 'surface' : 'volume';
      paintSoftPanel();
      setStatus('软选择距离：' + (st.soft.mode === 'surface'
        ? '表面（沿网格边的测地距离）' : '体积（空间欧氏距离）'));
      return;
    }
    if (el.id === 'mdSoftHeat') {
      st.soft.heatmap = !!el.checked;
      paintSoftPanel();
      setStatus(st.soft.heatmap ? '软选择热力图：开（蓝→红表示权重）' : '软选择热力图：关');
      return;
    }
    if (el.tagName === 'SELECT' && el.id === 'mdShadeSel') {
      setShading(el.value);
      return;
    }
    if (el.id === 'mdWireChk') {
      var VFW = global.SeedViewFlags;
      if (VFW) VFW.set('wireframe', !!el.checked);
      else { applyShading(); requestRender(0); }
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
    /* 线框已从着色模式里移出：旧值 / 旧命令统一翻译成「实体 + 线框叠加」 */
    if (mode === 'wire' || mode === 'shaded-wire') {
      var VF0 = global.SeedViewFlags;
      if (VF0) VF0.set('wireframe', true);
      mode = 'shaded';
    }
    if (['shaded', 'flat', 'normals', 'uv'].indexOf(mode) < 0) mode = 'shaded';
    st.shading = mode;
    applyShading();
    updateChrome();
    updateHud();
    setStatus('着色模式：' + shadeLabel(st.shading) + (vfOn('wireframe') ? ' + 线框' : ''));
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
   * 衰减半径按米（场景单位）；曲线横轴 = 到选中点的距离（0~半径），纵轴 = 权重。
   * 距离口径与权重计算在 js/md-soft.js：体积 = 欧氏，表面 = 沿网格边测地。
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
    var mode = $('mdSoftMode'), heat = $('mdSoftHeat');
    on.checked = !!st.soft.on;
    if (sel && sel.value !== st.soft.falloff) sel.value = st.soft.falloff;
    if (mode && mode.value !== st.soft.mode) mode.value = st.soft.mode;
    if (heat) heat.checked = !!st.soft.heatmap;
    if (num && document.activeElement !== num) num.value = Number(st.soft.size).toFixed(2);
    if (badge) {
      badge.textContent = st.soft.on ? '开' : '关';
      badge.classList.toggle('on', !!st.soft.on);
    }
    drawSoftCurve();
    refreshSoftHeat();
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
    /* 曲线拖动过程中只重画曲线；松手后一次重算热力图，避免每个 pointermove 重建几何 */
    refreshSoftHeat();
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
      case 'unify-normals':
        unifyNormalsNow();
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
      { t: '导出到电脑…', c: 'exportPc' },
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
      { t: '合并选中顶点', c: 'mergeVertices' },
      { sep: 1 },
      { t: '统一法线朝向（修纯黑面）', c: 'unifyNormals' }
    ] },
    { k: '选择', items: [
      { t: '全选', c: 'selAll', s: 'Ctrl+A' },
      { t: '反选', c: 'selInvert', s: 'Ctrl+I' },
      { t: '清除选择', c: 'selClear', s: 'Esc' },
      { sep: 1 },
      { t: '对象模式', c: 'sel:object', s: 'F8' },
      { t: '顶点模式', c: 'sel:vertex', s: 'F9' },
      { t: '边模式', c: 'sel:edge', s: 'F10' },
      { t: '面模式', c: 'sel:face', s: 'F11' },
      { t: 'UV 岛模式', c: 'sel:island', s: 'F12' }
    ] },
    { k: '显示', items: [
      { t: '四视图', c: 'quad' },
      { sep: 1 },
      { t: '着色：实体', c: 'shade:shaded' },
      { t: '着色：平涂', c: 'shade:flat' },
      { t: '着色：法线', c: 'shade:normals' },
      { t: '着色：UV 岛着色', c: 'shade:uv' },
      { t: '线框叠加', c: 'wireframe' },
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

  /* 视口条下拉（相机 / 照明 / 显示 / 渲染器 / 面板）：与主菜单共用 .md-drop 外观，
   * 但挂在 .md-app 上按按钮实测坐标定位，所以不会撑开菜单条。 */
  function closePop() {
    if (st.pop && st.pop.parentNode) st.pop.parentNode.removeChild(st.pop);
    st.pop = null; st.popItems = null; st.popAnchor = null;
  }
  function syncPanels() {
    var o = document.querySelector('.md-outline');
    var r = document.querySelector('.md-right');
    var s = document.querySelector('.md-shelf');
    if (o) o.hidden = !st.panels.outline;
    if (r) r.hidden = !st.panels.right;
    if (s) s.hidden = !st.panels.shelf;
  }
  function setShelfTab(key) {
    if (!key) return;
    st.shelfTab = key;
    document.querySelectorAll('[data-md-stab]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mdStab === key);
    });
    var shown = 0;
    document.querySelectorAll('.md-shelf-grid [data-shelf]').forEach(function (el) {
      var on = el.dataset.shelf === key;
      el.hidden = !on;
      if (on && el.classList.contains('md-sico')) shown++;
    });
    var note = $('mdShelfNote');
    if (note) {
      note.hidden = shown > 0;
      if (!shown) note.textContent = key === 'fx' ? 'FX 工具尚未接入（计划表 M8）' : '该页签工具尚未接入';
    }
  }
  function popSpec(kind) {
    if (kind === 'view') {
      var views = [['轴测', 'iso'], ['前视图', 'front'], ['后视图', 'back'], ['左视图', 'left'],
        ['右视图', 'right'], ['顶视图', 'top'], ['底视图', 'bottom']];
      return {
        title: '相机视图', items: views.map(function (v) {
          return {
            label: v[0], on: st.viewName === VP_LABEL[v[1]],
            run: function () { viewFromPreset(v[1]); }
          };
        })
      };
    }
    if (kind === 'light') {
      return {
        title: '照明预设', items: Object.keys(LIGHT_PRESETS).map(function (k) {
          return {
            label: LIGHT_PRESETS[k].label, on: st.lightingPreset === k,
            run: function () {
              st.lightingPreset = k;
              applyViewFlags();
              var lb = $('mdLightLabel');
              if (lb) lb.textContent = '照明：' + LIGHT_PRESETS[k].label + ' ▾';
              setStatus('照明：' + LIGHT_PRESETS[k].label);
            }
          };
        })
      };
    }
    if (kind === 'display') {
      var VF = global.SeedViewFlags;
      return {
        title: '显示开关', items: VF ? VF.all().map(function (f) {
          return {
            label: f.label, on: !!f.value,
            run: function () { VF.set(f.name, !f.value); }
          };
        }) : []
      };
    }
    if (kind === 'render') {
      var p = st.prefs || prefs();
      var setTone = function (k) {
        return function () {
          savePrefs({ toneMapping: k });
          applyRenderTone();
          setStatus('色调映射：' + toneLabel(k));
        };
      };
      var setExp = function (n) {
        return function () {
          savePrefs({ exposure: n });
          applyRenderTone();
          setStatus('曝光：' + n.toFixed(2));
        };
      };
      return {
        title: '渲染器 · 色调 / 曝光', items: [
          { label: 'ACES Filmic', on: p.toneMapping === 'aces', run: setTone('aces') },
          { label: 'Reinhard', on: p.toneMapping === 'reinhard', run: setTone('reinhard') },
          { label: '无色调映射', on: p.toneMapping === 'none', run: setTone('none') },
          { sep: 1 },
          { label: '曝光 0.75', on: Math.abs(p.exposure - 0.75) < 1e-6, run: setExp(0.75) },
          { label: '曝光 1.00', on: Math.abs(p.exposure - 1) < 1e-6, run: setExp(1) },
          { label: '曝光 1.25', on: Math.abs(p.exposure - 1.25) < 1e-6, run: setExp(1.25) },
          { label: '曝光 1.50', on: Math.abs(p.exposure - 1.5) < 1e-6, run: setExp(1.5) }
        ]
      };
    }
    if (kind === 'panel') {
      var flip = function (k, label) {
        return function () {
          st.panels[k] = !st.panels[k];
          syncPanels();
          setStatus((st.panels[k] ? '显示' : '隐藏') + '：' + label);
        };
      };
      return {
        title: '面板', items: [
          { label: '大纲视图', on: !!st.panels.outline, run: flip('outline', '大纲视图') },
          { label: '右侧工具箱', on: !!st.panels.right, run: flip('right', '右侧工具箱') },
          { label: '工具架', on: !!st.panels.shelf, run: flip('shelf', '工具架') },
          { sep: 1 },
          { label: '内容浏览器', on: !!st.dockOpen, run: function () { setDock(!st.dockOpen); } }
        ]
      };
    }
    return null;
  }
  function openPop(btn, kind) {
    if (st.pop && st.popAnchor === btn) { closePop(); return; }
    closePop();
    var spec = popSpec(kind);
    var app = document.querySelector('.md-app');
    if (!spec || !app) return;
    var box = document.createElement('div');
    box.className = 'md-drop md-pop';
    box.dataset.mdPop = kind;
    var html = '<div class="md-mtitle">' + esc(spec.title) + '</div>';
    spec.items.forEach(function (it, i) {
      if (it.sep) { html += '<i class="md-msep"></i>'; return; }
      html += '<button type="button" class="md-mi" data-md-pi="' + i + '">' +
        '<i class="md-chk">' + (it.on ? '✓' : '') + '</i>' +
        '<span>' + esc(it.label) + '</span><b>' + esc(it.hint || '') + '</b></button>';
    });
    box.innerHTML = html;
    app.appendChild(box);
    var ar = btn.getBoundingClientRect(), ap = app.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(ar.left - ap.left, app.clientWidth - box.offsetWidth - 4)) + 'px';
    box.style.top = (ar.bottom - ap.top + 3) + 'px';
    st.pop = box; st.popItems = spec.items; st.popAnchor = btn;
    box.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-md-pi]') : null;
      if (!b) return;
      var it = st.popItems && st.popItems[Number(b.dataset.mdPi)];
      if (!it || it.sep) return;
      closePop();
      if (it.run) it.run();
    });
  }

  function mdRun(c) {
    mdCloseMenu();
    var m;
    if ((m = /^prim:(\w+)$/.exec(c))) { openPrimitiveDialog(m[1]); return; }
    if ((m = /^shade:(.+)$/.exec(c))) { setShading(m[1]); return; }
    if ((m = /^sel:(\w+)$/.exec(c))) { setSelMode(m[1]); return; }
    switch (c) {
      case 'selAll': selectAll(); break;
      case 'selInvert': invertSelection(); break;
      case 'selClear': clearSelection(); break;
      case 'new': clickAct('new'); break;
      case 'open': clickAct('open'); break;
      case 'save': clickAct('save'); break;
      case 'exportPc': openExportDialog(); break;
      case 'undo': clickAct('undo'); break;
      case 'redo': clickAct('redo'); break;
      case 'snap': clickAct('snap'); break;
      case 'grid': clickAct('grid'); break;
      case 'wireframe': {
        var VFWc = global.SeedViewFlags;
        if (VFWc) VFWc.toggle('wireframe');
        else { applyShading(); requestRender(0); }
        setStatus('线框叠加：' + (vfOn('wireframe') ? '开' : '关'));
        break;
      }
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
      case 'unifyNormals': runOp('mesh.unifyNormals'); break;
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
    if (t.id === 'mdPropsToggle') {
      setTbKind(st.tbKind === 'props' ? (st.editor === 'paint' ? 'paint' : 'model') : 'props');
      updateChrome();
      return;
    }
    /* 组件自画面板上的按钮（表情预设 / 移除某个形态键）：只认 data-md-cev，
     * 具体含义由组件解释 —— 建模 App 不知道「微笑」是哪几个键。 */
    if (t.dataset.mdCev) {
      var ctlBtn = ctlHostOf(t);
      componentEvent('click', t, ctlBtn);
      /* 控制器里点一下（表情预设 / 移除某个键）= 一次完整操作，立刻落历史 */
      if (ctlBtn) compTxnCommit();
      return;
    }
    if (t.dataset.mdEditorBtn) {
      setEditor(t.dataset.mdEditorBtn);
      return;
    }
    if (t.dataset.mdPbrush) {
      setPaintBrush(t.dataset.mdPbrush);
      return;
    }
    if (t.dataset.mdPtool) {
      setPaintTool(t.dataset.mdPtool);
      return;
    }
    if (t.dataset.mdPmask !== undefined) {
      togglePaintMask();
      return;
    }
    if (t.dataset.mdPfill !== undefined) {
      /* 动作按钮：执行完不切换当前手势工具，用户可以继续画 */
      if (PAINT && PAINT.fillIslands) PAINT.fillIslands();
      return;
    }
    if (t.dataset.mdcmd) {
      mdRun(t.dataset.mdcmd);
      return;
    }
    if (t.dataset.mdPop) {
      openPop(t, t.dataset.mdPop);
      return;
    }
    if (t.dataset.mdStab) {
      setShelfTab(t.dataset.mdStab);
      return;
    }
    if (t.dataset.mdOtab) {
      st.outlineTab = t.dataset.mdOtab;
      paintOutline();
      updateChrome();
      return;
    }
    if (t.dataset.mdLv) {
      /* 关卡面板：按钮走对应动作；点关卡名本身 = 选中该关（移入目标 + 全选整关对象） */
      if (t.dataset.mdLv === 'pick') levelsPanelAction('pick', t.dataset.mdLvid);
      else levelsPanelAction(t.dataset.mdLv, t.dataset.mdLvid);
      return;
    }
    if (t.dataset.mdView) {
      viewFromPreset(t.dataset.mdView);
      return;
    }
    if (t.dataset.mdTodo) {
      setStatus('「' + t.dataset.mdTodo + '」尚未接入' +
        (t.dataset.mdPlan ? '（计划表 ' + t.dataset.mdPlan + '）' : ''), true);
      return;
    }
    if (t.dataset.mdPtab) {
      setPaintTab(t.dataset.mdPtab);
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
    if (t.dataset.mdBrushshape) {
      var bsh = t.dataset.mdBrushshape;
      /* 空的自定义槽：点它就是选文件；载入后点它只是切回该形状，
       * 想换图用下面那行「载入图片…」 */
      if (bsh === 'custom' && !(st.paint.customBrush && st.paint.customBrush.url)) {
        var bf = $('mdBrushFile');
        if (bf) bf.click();
        return;
      }
      st.paint.stampKey = ''; st.paint.stampCv = null;
      setPaintShape(bsh);
      return;
    }
    if (t.dataset.mdBrushfile != null) {
      var fi = $('mdBrushFile');
      if (fi) fi.click();
      return;
    }
    if (t.dataset.mdSwatch) {
      setPaintColor(t.dataset.mdSwatch);
      setStatus('笔刷颜色：' + st.paint.color);
      return;
    }
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
    if (t.dataset.mdComp) {
      /* 切组件类别：参数要跟着换成那个组件自己的默认值 */
      var defC = global.MDComponents && global.MDComponents.get ? global.MDComponents.get(t.dataset.mdComp) : null;
      if (defC) {
        st.comp.kind = defC.id;
        st.comp.preset = (defC.presets && defC.presets[0]) ? defC.presets[0].id : '';
        st.comp.params = defC.paramsOf(st.comp.preset);
        overlayShow(componentDialogHtml(), 'comp');
      }
      return;
    }
    if (t.dataset.mdCpreset) {
      setComponentPreset(t.dataset.mdCpreset);
      return;
    }
    if (t.dataset.mdNode != null) {
      /* B2b：点行 = 换激活对象；Ctrl/Cmd 切换多选、Shift 追加（与视口一致） */
      selectNodeById(String(t.dataset.mdNode),
        e && (e.ctrlKey || e.metaKey) ? 'toggle' : (e && e.shiftKey ? 'add' : 'replace'));
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
    if (t.dataset.mdExpFmt) {
      /* 导出格式切换：只重画页签与说明，文件名输入框的内容保留（用户可能刚改过） */
      st.expFmt = EXPORT_FORMATS[t.dataset.mdExpFmt] ? t.dataset.mdExpFmt : 'glb';
      var fmts = Array.prototype.slice.call(document.querySelectorAll('[data-md-exp-fmt]'));
      fmts.forEach(function (b) { b.classList.toggle('on', b.dataset.mdExpFmt === st.expFmt); });
      var desc = $('mdExpDesc');
      if (desc) desc.textContent = EXPORT_FORMATS[st.expFmt].desc;
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
      case 'export-go': runExport(); break;
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
        var order = ['shaded', 'flat', 'normals', 'uv'];
        var next = order[(order.indexOf(st.shading) + 1) % order.length];
        setShading(next);
        break;
      }
      case 'quad': toggleQuad(); break;
      case 'view-iso': viewFromPreset('iso'); break;
      case 'isolate': toggleIsolate(); break;
      case 'uv': openUVEditor(); break;
      case 'projbake': openProjBake(); break;
      case 'tex': openTextureEditor(); break;
      case 'prim-create': createPrimitive(); break;
      case 'comp-open': openComponentDialog(); break;
      case 'comp-add': addComponent(); break;
      /* 属性面板里「调整这个组件的参数」：带着当前节点进面板，改的是它本人 */
      case 'comp-edit': openComponentDialog(st.node && st.node.id); break;
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
        { key: 'dist', label: '厚度', value: 0, min: -2, max: 2, step: 0.01 },
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
        { key: 'size', label: '半径 (m)', value: st.soft.size, min: 0, max: 5, step: 0.01 }
      ], function (v) {
        st.soft.size = v.size;
        paintSoftPanel();
      }, '开 / 关、体积 / 表面距离和热力图在右侧工具箱「软选择」里；拖组件手柄时按衰减曲线带动周围顶点。');
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
      hbItem('隔离', 'B6', function () { toggleIsolate(); }, st.isolate, false, '', false,
        { icon: 'eye', panel: hbPanelSpec('隔离显示', [], null, '只显示当前对象；再执行一次恢复全部。等价于视口工具条的「隔离」。') })
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
      hbItem('删除边', 'B4', function () { runOp('mesh.dissolve'); }, false, false, '', false,
        { icon: 'del', panel: hbPanelSpec('删除边', [], null, '溶解选中边：边必须恰好被两个面共享，两邻面会并成一个面（B4 轻量实现）。') })
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
      hbItem('分离', 'X5g', function () { openUVEditor(); uvCommand('sepShells'); }, false, false, '', false,
        { icon: 'island', panel: hbPanelSpec('分离 UV', [], null, '把选中的 UV 岛从原壳拆成独立壳；先在 UV 编辑器里选中 UV 点 / 面。') }),
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
        hbItem('实体', '', function () { setShading('shaded'); }, st.shading === 'shaded'),
        hbItem('平涂', '', function () { setShading('flat'); }, st.shading === 'flat'),
        hbItem('法线', '', function () { setShading('normals'); }, st.shading === 'normals'),
        hbItem('UV 岛着色', '', function () { setShading('uv'); }, st.shading === 'uv'),
        hbItem('线框叠加', '', function () {
          var VFh = global.SeedViewFlags;
          if (VFh) VFh.toggle('wireframe');
        }, vfOn('wireframe')),
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
  /* Three.js 的 BoxGeometry 给每个面各铺满 0–1 —— 六个面在 UV 上完全重叠。
   * 结果是一张面落笔等于六张面一起上色，面级隔离也挡不住（贴图上根本没有区分）。
   * 专业软件的默认立方体是盒式展开（六块互不重叠的岛），这里丢掉拷贝来的 uv，
   * 交给 ensureUV 重新摊开。只用于基础体，导入资产自己的 UV 一律不碰。 */
  function boxUnwrapUV(mesh) {
    if (!mesh) return mesh;
    mesh.uvs = [];
    SeedModel.Mesh.ensureUV(mesh);
    SeedModel.Mesh.bump(mesh);
    return mesh;
  }

  /* M1 新建资产 = 一个立方体（通用建模软件的默认起点），
   * 不经过参数化 spec：Mesh.fromBufferGeometry 焊接后就是一张连通的 8 点 / 12 面网格。 */
  function newDocument() {
    var id = genId();
    var geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
    var mesh = boxUnwrapUV(SeedModel.Mesh.fromBufferGeometry(geo, { slot: 0, weld: true }));
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

  /* ---------------- 添加组件：把成品零件并进场景 ----------------
   * 和「新建基础体」是同一种写入（往 doc 加一个节点），区别只在几何从哪来：
   * 基础体来自 Modeler 的图元表，组件来自 window.MDComponents 里各自的来源。
   * 这里**不认识任何具体形状** —— 名称 / 备注 / 预设 / 字段 / 剪影 / 说明都由组件源自报，
   * 所以将来接「身体 / 手 / 头发」只需要多一份组件源文件，这块一行都不用改。
   *
   * ⚠ 组件是「桥」，不是「再造一份」：现在的头模直接读流明 3D 的 model/ 数据包
   *   （js/md-lumen-bridge.js），顶点与 112 个形态键都是同一份，名字对得上才能原路回去。
   *   桥的接缝只有一条「文件路径」，本文件不 require 任何 app id ——
   *   删掉桥文件，这里只会说「没有可用的组件源」，不会把流明拖下水。 */
  function componentDefs() {
    var reg = global.MDComponents;
    return (reg && reg.list && reg.list.length) ? reg.list : [];
  }
  function componentDef() {
    var list = componentDefs();
    for (var i = 0; i < list.length; i++) if (list[i].id === st.comp.kind) return list[i];
    return list[0] || null;
  }
  function componentDefById(id) {
    var list = componentDefs();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ---------------- 参数合并 / 编辑事务 / 控制器宿主 ----------------
   * 这一组是「对话框」和「属性面板控制器」共用的地基：
   *   · 对话框编辑 st.comp.params（草稿），点「应用到对象」才写节点；
   *   · 控制器直接编辑 node.comp.params（真身），靠事务攒成一条历史。
   * 渲染是同一份 def.panel()，区别只在 params 是谁、重绘到哪。
   */

  /* 旧文档 / 组件升级后的参数合并：以组件当前默认值打底，只覆盖用户存过的键。
   * 默认值里没有的键一律丢弃 —— 组件删掉的参数留在节点上，面板画不出来，
   * 导出时还会跟着跑出去。 */
  function mergeSavedParams(def, saved) {
    var base = (def && typeof def.paramsOf === 'function') ? def.paramsOf(st.comp.preset) : {};
    if (!base || typeof base !== 'object') base = {};
    saved = (saved && typeof saved === 'object') ? saved : {};
    Object.keys(base).forEach(function (k) { if (saved[k] != null) base[k] = saved[k]; });
    return base;
  }

  /* 节点自己的参数对象：缺键就补齐并写回**同一个引用**。
   * ⚠ 引用必须稳定：def.panel(ctx) 直接把 ctx.params 当可变对象用，
   *   每次重铺都换新对象的话，外面持有的引用立刻过期（拖的是影子，改不进文档）。 */
  function ensureNodeCompParams(node) {
    if (!node || !node.comp || !node.comp.id) return null;
    var def = componentDefById(node.comp.id);
    if (!def) return null;
    var cur = node.comp.params;
    var base = (typeof def.paramsOf === 'function') ? def.paramsOf(st.comp.preset) : {};
    var keys = Object.keys(base || {});
    var missing = !cur || keys.some(function (k) { return !(k in cur); });
    if (missing) node.comp.params = mergeSavedParams(def, cur);
    return node.comp.params;
  }

  /* 控制器的一次编辑事务：拖动期间只改内存，松手（change / 切节点 / 关面板）才记一条历史。
   * ⚠ 为什么不用 docEdit：它每条都 snap + rebuildModel(true)，拖一次滑杆会变成
   *   60 条历史 + 60 次网格重建 —— 卡死，而且撤销一次退不回「拖之前」。
   * 这里只做两件事：begin 存一份 before；commit 比一次 params、写回网格、记一条。 */
  function compTxnBegin(nodeId) {
    if (!st.doc || !nodeId) return null;
    var node = SeedModel.Scene.nodeById(st.doc, nodeId);
    if (!node || !node.comp) return null;
    var t = st.comp.txn;
    if (t && t.nodeId === nodeId) return t;
    compTxnCommit();   /* 上一个节点还没落地的改动先提交，不能丢 */
    var def = componentDefById(node.comp.id);
    st.comp.txn = {
      nodeId: nodeId,
      label: '调整' + (def ? def.name : '组件') + '参数',
      before: snap(),
      beforeJson: JSON.stringify(node.comp.params || null)
    };
    return st.comp.txn;
  }

  function compTxnCommit() {
    var t = st.comp.txn;
    st.comp.txn = null;
    if (!t || !st.doc) return false;
    var node = SeedModel.Scene.nodeById(st.doc, t.nodeId);
    if (!node || !node.comp) return false;
    var json = JSON.stringify(node.comp.params || null);
    if (json === t.beforeJson) return false;   /* 点一下又点回来，不记空历史 */
    /* 权重在拖动期间只改了缓存对象，这里补一次写回，快照才抓得到 */
    var mesh = meshOfNode(node.id);
    if (mesh) SeedModel.Scene.setMesh(st.doc, mesh, node);
    pushHistory(t.before, snap(), t.label || '调整组件参数');
    syncMorphWeightsOf(node.id);
    updateHud();
    return true;
  }

  /* 控制器改了参数之后**立刻**反映到视口：applyTo 只动权重 / 材质，不重建几何。
   * 大纲不重铺 —— 面数不随表情变，拖滑杆时重建整张列表只会闪。 */
  function refreshNodeComp(nodeId) {
    var node = nodeId ? SeedModel.Scene.nodeById(st.doc, nodeId) : null;
    if (!node || !node.comp) return false;
    var def = componentDefById(node.comp.id);
    if (!def) return false;
    if (typeof def.applyTo === 'function') {
      var mesh = meshOfNode(node.id);
      if (mesh) {
        try { def.applyTo(mesh, node.comp.params || {}); } catch (e) { return false; }
      }
    }
    syncMorphWeightsOf(node.id);
    return true;
  }

  /* 属性面板里的控制器 HTML：整块交给组件自报的 panel()。
   * 没有 panel 的组件（只有标量 fields）不在这里出现 —— 那种零件的字段
   * 已经由通用滑杆画好，再来一份就是双份控件。 */
  function controllerHtml(node) {
    if (!node || !node.comp) return '';
    /* 对话框开着时控制器退成一行提示，**不渲染可操作控件**。
     * 理由不是省事：两套同构控件同时在 DOM 里，Tab 键能穿过遮罩摸到后台那套，
     * 回车一下改的就是「看不见的地方」；脚本按类名全局查也会串到另一套。
     * 同一时刻只允许一个编辑宿主 —— 这就是 st.comp.host 存在的意义。 */
    if (st.comp.host === 'overlay') {
      return '<div class="md-note">正在「组件」大面板里编辑这个零件，关掉它之后回到这里调。</div>';
    }
    var def = componentDefById(node.comp.id);
    if (!def) {
      /* 组件源没了不能画成空白（空白和「本来就没有控制器」长得一样） */
      return '<div class="md-note md-ctl-miss">组件源「' + esc(node.comp.id) +
        '」未加载：参数仍保存在节点上，但暂时没有可用的控制器。</div>';
    }
    if (typeof def.panel !== 'function') return '';
    var params = ensureNodeCompParams(node);
    try {
      return def.panel({ def: def, params: params, esc: esc, fmt: fmtNum, doc: st.doc, node: node }) || '';
    } catch (e) {
      return '<div class="md-note">控制器渲染失败：' + esc((e && e.message) || e) + '</div>';
    }
  }
  /* 面板现在是不是在「调一个已经存在的对象」。判据是 st.comp.target 指向的节点
   * 还带着 comp 身份；节点被删了 / 换了文档就自动当新增处理，不会去调空气。
   * ⚠ 不要用 try/catch 兜住查找：API 写错时异常会被吞成 null，
   *   表现是「点了调整却变成新增一个」，而页面上一条错误都没有。 */
  function componentEditNode() {
    if (!st.comp.target || !st.doc) return null;
    var n = SeedModel.Scene.nodeById(st.doc, st.comp.target);
    return (n && n.comp && n.comp.id) ? n : null;
  }
  /* 参数只在「首次打开面板」时从预设展开；之后用户改过的值一直留着，
   * 这样来回切预设 / 切组件再切回来不会把手工调的数字冲掉。 */
  function componentParams(def) {
    /* 组件换了就重取：上一个组件残留的键（比如 morph 名字）在新组件里没有意义。
     * 用 paramsFor 记归属，不往 params 里塞 __for —— params 是要存进文档的纯数据，
     * 混进一个内部标记，将来序列化到 GLB 侧边栏时会跟着跑出去。 */
    if (!st.comp.params || st.comp.paramsFor !== def.id) {
      st.comp.params = def.paramsOf(st.comp.preset);
      st.comp.paramsFor = def.id;
    }
    return st.comp.params;
  }
  /* 交给组件面板的回调环境：params 是同一个对象引用，组件改了就是改了。
   * 组件只认识数据和自己那几行 HTML，不认识 st / 文档 / 历史。 */
  function componentCtx(def) {
    return { def: def, params: componentParams(def), esc: esc, fmt: fmtNum, doc: st.doc };
  }
  /* 字段表可能是数组，也可能是函数 —— 异步组件源（流明头模）要等资产载入后
   * 才知道形态键有哪些，字段表只能到那时现算。面板不关心差别，一律走这里取。 */
  function componentFields(def) {
    var f = def && def.fields;
    if (typeof f === 'function') {
      try { f = f(); } catch (e) { f = null; }
    }
    return f || [];
  }
  function fmtNum(v, dec) {
    var d = dec == null ? 2 : dec;
    var n = Number(v);
    return (isFinite(n) ? n : 0).toFixed(d);
  }

  function componentPreviewHtml(def, p) {
    /* 异步组件源还没载入时没有剪影可画（silhouette 返回 null）。
     * 这里必须给一段占位文字而不是空 div —— 空 div 和「载入失败」在屏幕上长得一样。 */
    var s = def.silhouette ? def.silhouette(p, 132) : null;
    if (!s) return '<div class="md-comp-wait">正在读取流明资产…</div>';
    return '<svg viewBox="0 0 ' + s.w + ' ' + s.h + '" width="' + s.w + '" height="' + s.h + '" aria-hidden="true">' +
      '<path class="md-comp-front" d="' + s.front + '"/>' +
      '<path class="md-comp-side" d="' + s.side + '"/>' +
      /* 标签放顶部（剪影自己留了 13px）：放底部时基线压在画布边上，7px 的字看不见 */
      '<text class="md-comp-tag" x="' + s.frontCx.toFixed(1) + '" y="9" text-anchor="middle">正视图</text>' +
      '<text class="md-comp-tag" x="' + s.sideCx.toFixed(1) + '" y="9" text-anchor="middle">侧视图</text>' +
      '</svg>';
  }

  /* 一个字段 → 一行控件。两种类型就用两种控件，不为「统一」把下拉塞进滑杆：
   * range 给连续量（强度），select 给枚举（112 个形态键，按部位分组）。 */
  function componentFieldHtml(def, f, p) {
    var val = p[f.key];
    if (f.type === 'select') {
      var opts = f.options || [];
      var cur = val == null ? '' : String(val);
      var body = '<option value="">（基础 / rest）</option>';
      if (f.groups && opts.length) {
        var buckets = Object.create(null), order = [];
        opts.forEach(function (o) {
          var g = o.group || 'other';
          if (!buckets[g]) { buckets[g] = []; order.push(g); }
          buckets[g].push(o);
        });
        order.forEach(function (g) {
          body += '<optgroup label="' + esc(f.groups[g] || g) + '">';
          buckets[g].forEach(function (o) {
            body += '<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' +
              esc(o.label) + '</option>';
          });
          body += '</optgroup>';
        });
      } else {
        opts.forEach(function (o) {
          body += '<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' +
            esc(o.label) + '</option>';
        });
      }
      return '<label class="md-comp-field' + (f.wide ? ' wide' : '') + '"><span>' + esc(f.label) + '</span>' +
        '<select data-md-cp="' + esc(f.key) + '">' + body + '</select></label>';
    }
    var n = Number(val);
    return '<label class="md-comp-field"><span>' + esc(f.label) + '</span>' +
      '<input type="range" data-md-cp="' + esc(f.key) + '" min="' + f.min + '" max="' + f.max +
      '" step="' + f.step + '" value="' + (isFinite(n) ? n : 0) + '">' +
      '<b data-md-cpv="' + esc(f.key) + '">' + fmtNum(val, f.dec) + '</b></label>';
  }

  function componentDialogHtml() {
    var def = componentDef();
    var editing = componentEditNode();
    var head = '<div class="md-ov-head"><b>' + (editing ? '调整组件' : '添加组件') + '</b>' +
      '<span class="md-ov-sub">' + (editing
        ? '改的是场景里那个对象 · 不新增副本'
        : '成品零件 · 加进场景后仍是组件，能继续调') + '</span>' +
      '<button type="button" class="md-ov-x" data-md-act="close-overlay">×</button></div>';
    if (!def) {
      return head + '<div class="md-ov-body"><div class="md-note">' +
        '没有可用的组件源（js/md-lumen-bridge.js 未加载）。</div></div>';
    }
    var p = componentParams(def);
    var ready = !(def.async && !def.ready());
    var cards = componentDefs().map(function (c) {
      return '<button type="button" class="md-comp-card' + (c.id === def.id ? ' on' : '') +
        '" data-md-comp="' + esc(c.id) + '"' + (editing ? ' disabled' : '') + '><b>' + esc(c.name) + '</b>' +
        '<em>' + esc(c.note || '') + '</em></button>';
    }).join('');
    var presets = (def.presets || []).map(function (ps) {
      return '<button type="button" class="md-prim-tab' + (ps.id === st.comp.preset ? ' on' : '') +
        '" data-md-cpreset="' + esc(ps.id) + '" title="' + esc(ps.note || '') + '">' +
        esc(ps.name) + '</button>';
    }).join('');
    /* 两种参数区：
     *   · 组件自报 panel（流明头模）→ 整块交给它，建模 App 不认得里面任何控件；
     *   · 否则按 fields 画通用滑杆 / 下拉（给将来那些「只有一组静态参数」的零件）。 */
    var special = (ready && typeof def.panel === 'function')
      ? '<div class="md-comp-special">' + def.panel(componentCtx(def)) + '</div>' : '';
    var fields = special ? '' : componentFields(def).map(function (f) {
      return componentFieldHtml(def, f, p);
    }).join('');
    var blurb = typeof def.blurb === 'function' ? def.blurb() : (def.blurb || '');
    return [
      head,
      '<div class="md-ov-body"><div class="md-comp">',
      '  <div class="md-comp-side">', cards,
      '    <div class="md-comp-soon">身体 / 手 / 头发<br>后续接入</div>',
      '  </div>',
      '  <div class="md-comp-main">',
      '    <div class="md-comp-preview" id="mdCompPreview">' + componentPreviewHtml(def, p) + '</div>',
      (presets ? '    <div class="md-prim-tabs md-comp-presets">' + presets + '</div>' : ''),
      special,
      (fields ? '    <div class="md-comp-fields">' + fields + '</div>' : ''),
      '    <button type="button" class="md-wide md-prim-go" data-md-act="comp-add"' +
      (ready ? '' : ' disabled') + '>' +
      (ready ? (editing ? '应用到对象' : '添加到场景') : '读取中…') + '</button>',
      (blurb ? '    <div class="md-note">' + blurb + '</div>' : ''),
      '  </div>',
      '</div></div>'
    ].join('');
  }

  /* nodeId 有值 = 调这个已有对象（参数先从那对象身上恢复），否则 = 新增。
   * 两件事走同一个面板，因为用户的心智是「改这个头的表情」，不是「再生成一个头」。 */
  function openComponentDialog(nodeId) {
    if (!st.doc) return;
    if (!componentDefs().length) { setStatus('没有可用的组件源', true); return; }
    /* 属性面板控制器里还没提交的改动先落地：一间屋子里不能两处同时编同一个节点，
     * 后写的一方会把前一方的手工值盖掉（而且没有任何提示）。 */
    compTxnCommit();
    st.comp.host = 'overlay';
    var node = null;
    if (nodeId) node = SeedModel.Scene.nodeById(st.doc, nodeId);
    st.comp.target = (node && node.comp && node.comp.id) ? node.id : '';
    if (node && node.comp) {
      /* 从对象身上恢复参数：只认纯数据，缺字段就按默认补，
       * 这样旧文档（参数结构变过）打开也不会崩在面板里。 */
      var d0 = componentDefById(node.comp.id);
      if (d0) {
        st.comp.kind = d0.id;
        /* 合并逻辑只有一份（mergeSavedParams）：属性面板控制器走的也是它。
         * 两处各写一遍的话，「旧文档缺字段怎么补」迟早长成两种口径。 */
        st.comp.params = mergeSavedParams(d0, node.comp.params);
        st.comp.paramsFor = d0.id;
      }
    }
    var def = componentDef();
    componentParams(def);
    overlayShow(componentDialogHtml(), 'comp');
    /* 属性面板里的控制器要让位（见 controllerHtml）：重画一次，把可操作控件换成提示。 */
    paintParams();
    /* 异步组件源：先把空面板摆出来（用户立刻看到「正在读取」），读完再整块重铺一次。
     * 代次号用来作废旧请求：面板关了又开、或者期间换了组件，回来的结果直接丢掉。 */
    if (def.async && !def.ready()) {
      var seq = (st.comp.loadSeq = (st.comp.loadSeq || 0) + 1);
      var pending = def.load ? def.load() : Promise.reject(new Error('组件源没有 load()'));
      pending.then(function () {
        if (st.comp.loadSeq !== seq) return;
        if (!st.overlay || st.overlay.className.indexOf('comp') < 0) return;
        overlayShow(componentDialogHtml(), 'comp');
      }).catch(function (e) {
        if (st.comp.loadSeq !== seq) return;
        var host = st.overlay && st.overlay.querySelector('.md-comp-main');
        if (host) {
          host.innerHTML = '<div class="md-note">读取失败：' + esc((e && e.message) || e) +
            '<br>数据包在 apps/lumen3d/model/ 下（face-meta.js + face-geometry.js）。</div>';
        }
        setStatus('读取流明资产失败：' + ((e && e.message) || e), true);
      });
    }
  }

  /* 改参数只重画缩略图 + 数字，**不重铺整个面板**：
   * 重铺会让滑杆丢焦点，拖到一半就断，看起来像「拖着拖着不动了」。 */
  function paintComponentPreview() {
    var def = componentDef();
    if (!def || !st.overlay) return;
    var host = st.overlay.querySelector('#mdCompPreview');
    if (host) host.innerHTML = componentPreviewHtml(def, componentParams(def));
  }

  /* 参数区重画的两种粒度，由组件 onEvent 的返回值决定：
   *   'full'    → 整块重铺（换主键 / 点表情：滑杆值、chips、剪影全要跟着变）
   *   'preview' → 只重画剪影（拖强度：重铺会让滑杆丢焦点，拖着拖着就断）
   * nodeId 有值 = 属性面板里的控制器。
   * ⚠ 控制器里没有剪影可画，所以 'preview' **什么都不重铺**，数字由 paintCompNumber 更新。
   *   如果这里连 'preview' 也重铺，拖滑杆时滑杆元素被换掉，焦点丢失 ——
   *   表现是「拖一下就断」，和当初对话框踩的是同一个坑。 */
  /* 重铺参数区时把焦点留在原处。
   * 为什么必须有：组件的面板里可能有输入框（流明头模的形态键搜索），重铺一次
   * innerHTML 就等于把用户正在敲的字连光标一起删掉 —— 表现是「打一个字就跳走」。
   * 这里只认 data-md-cev（控件自报的 id），不认具体组件，所以对谁都成立。 */
  function focusKeeper(root) {
    var af = document && document.activeElement;
    if (!af || !af.dataset || !af.dataset.mdCev || !root || !root.contains(af)) return null;
    /* data-md-cval 要一起记：同一个 act 可能有多个控件（每个叠加键各有一个数值框），
     * 只按 act 找回来永远命中第一个 —— 表现是「改第二个键的数值，改完焦点跳到第一个」。 */
    return {
      act: af.dataset.mdCev, arg: af.dataset.mdCval || '',
      pos: af.selectionStart, val: af.value, tag: af.tagName
    };
  }
  function focusRestore(root, keep) {
    if (!keep || !root) return;
    var sel = '[data-md-cev="' + keep.act + '"]';
    if (keep.arg) sel += '[data-md-cval="' + String(keep.arg).replace(/"/g, '\\"') + '"]';
    var el = root.querySelector(sel);
    if (!el) return;
    if (keep.val != null && 'value' in el && el.value !== keep.val) el.value = keep.val;
    el.focus();
    if (keep.pos != null && el.setSelectionRange) {
      try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) { /* number/range 不支持，忽略 */ }
    }
  }

  /* 参数区重画的两种粒度，由组件 onEvent 的返回值决定：
   *   'full'    → 整块重铺（换主键 / 点表情：滑杆值、chips、剪影全要跟着变）
   *   'preview' → 只重画剪影（拖强度：重铺会让滑杆丢焦点，拖着拖着就断）
   * nodeId 有值 = 属性面板里的控制器：没有剪影，两种粒度都只重铺控制器那一块。 */
  function repaintComponent(how, nodeId) {
    if (!how) return;
    if (nodeId) {
      if (how !== 'full') return;
      var box = document.querySelector('[data-md-ctl="' + nodeId + '"]');
      if (!box) return;
      var kp = focusKeeper(box);
      box.innerHTML = controllerHtml(SeedModel.Scene.nodeById(st.doc, nodeId));
      focusRestore(box, kp);
      return;
    }
    if (how === 'full') {
      if (st.overlay && st.overlay.className.indexOf('comp') >= 0) {
        var ko = focusKeeper(st.overlay);
        overlayShow(componentDialogHtml(), 'comp');
        focusRestore(st.overlay, ko);
      }
      return;
    }
    paintComponentPreview();
  }

  /* 拖强度时数字要跟着走，但面板不能重铺（重铺 = 滑杆丢焦点，拖着拖着就断）。
   * 两个宿主共用这一份：对话框在 st.overlay 里找标签，控制器在属性面板里找。
   * 早先这里写死了 act === 'w'（流明头模的强度键名），换个组件就失效。 */
  function paintCompNumber(hostEl, act, el) {
    if (!hostEl || !act) return;
    var lab = hostEl.querySelector('[data-md-cpv="' + act + '"]');
    if (!lab) return;
    var v = String(Math.round(Number(el.value) || 0));
    /* 数字宿主有两种：`<b>` 文本（通用字段）和 number 输入框（流明头模的精确强度）。
     * 判 tagName 而不是「有没有 value 属性」—— 给 <b> 赋 value 会静默成功、显示不变，
     * 症状是「拖滑杆时数值框不动」，而且一行报错都没有。 */
    if (lab.tagName === 'INPUT') lab.value = v; else lab.textContent = v;
  }

  /* 这个事件是不是发生在属性面板的控制器里？是就返回节点 id，否则 ''。
   * 控制器和对话框共用同一套 data-md-cev，靠 DOM 祖先区分 —— 不靠全局开关：
   * 对话框开着的时候属性面板也在下面，用全局标记会把两边搞混。 */
  function ctlHostOf(el) {
    var box = el && el.closest ? el.closest('[data-md-ctl]') : null;
    return box ? (box.dataset.mdCtl || '') : '';
  }

  /* 组件自画面板上的交互，统一从 DOM 上的 data-md-cev / data-md-cval 取。
   * 建模 App 不认识「表情」「形态键」这些概念，只负责把事件原样递过去。
   * nodeId 有值 = 属性面板控制器：改的是 node.comp.params 真身，并开一次编辑事务。 */
  function componentEvent(type, el, nodeId) {
    if (!el) return false;
    var ev = {
      type: type,
      act: el.dataset.mdCev || '',
      /* checkbox 要给布尔：默认的 el.value 是 'on'，组件拿到 'on' 当真假会一律为真，
       * 关不掉（而且这种 bug 在界面上表现为「点了没反应」）。
       * ⚠ data-md-cval 只在**按钮**上顶替 value：输入框上的 cval 是「附带参数」
       *   （比如叠加键数值框的键名），它的真值在 el.value 里，抢过来就成 NaN 了。 */
      value: (el.type === 'checkbox') ? !!el.checked
        : (el.dataset.mdCval != null && (el.tagName === 'BUTTON' || el.value == null)) ? el.dataset.mdCval
          : el.value,
      /* 一个控件同时要「键名 + 数值」时（叠加键上的数值框），键名走 data-md-cval、
       * 数值走 el.value —— 上面那个 value 只能给一个。单独开一个字段比改 value
       * 的语义安全：已有的按钮全靠 value 拿 data-md-cval，动它会把它们全弄坏。 */
      arg: el.dataset.mdCval,
      /* 数字跟着滑杆走的那条路需要一个 DOM 宿主；3D 控制器没有控件，传 null */
      el: el
    };
    return dispatchComponent(ev, nodeId);
  }

  /* 把一个**已经拼好的事件**交给组件。
   * 抽出来的理由只有一个：视口里的 3D 控制器没有 DOM 控件，但它必须和面板写同一份参数、
   * 走同一个 onEvent、开同一个事务。两条派发路径各写一遍的话，
   * 「拖动要不要镜像」「松手要不要重铺」迟早长成两种口径。 */
  function dispatchComponent(ev, nodeId) {
    if (!ev) return false;
    var node = nodeId ? SeedModel.Scene.nodeById(st.doc, nodeId) : null;
    var def = node ? componentDefById(node.comp && node.comp.id) : componentDef();
    if (!def || typeof def.onEvent !== 'function') return false;
    var params = node ? ensureNodeCompParams(node) : componentParams(def);
    if (!params) return false;
    var ctx = node
      ? { def: def, params: params, esc: esc, fmt: fmtNum, doc: st.doc, node: node }
      : componentCtx(def);
    /* 控制器的第一次改动开事务：拖动中只改内存，松手（change / 切节点 / 关面板）才落历史 */
    if (node) compTxnBegin(node.id);
    var how = def.onEvent(ev, ctx);
    if (node) {
      refreshNodeComp(node.id);
      if (ev.type === 'input' && ev.el) paintCompNumber($('mdParams'), ev.act, ev.el);
    } else if (ev.type === 'input' && ev.el) {
      paintCompNumber(st.overlay, ev.act, ev.el);
    }
    /* 面板 / 手柄 / 撤销任何一路改了参数，脸上的操控点都要跟上（值不重建 DOM） */
    syncCtrlValues();
    repaintComponent(how, node ? node.id : '');
    return !!how;
  }

  /* 通用字段（没有 panel 的组件）改参数。nodeId 有值 = 属性面板控制器。 */
  function setComponentParam(key, value, nodeId) {
    var node = nodeId ? SeedModel.Scene.nodeById(st.doc, nodeId) : null;
    var def = node ? componentDefById(node.comp && node.comp.id) : componentDef();
    if (!def) return;
    var params = node ? ensureNodeCompParams(node) : componentParams(def);
    if (!params) return;
    if (node) compTxnBegin(node.id);
    /* 组件自己能处理参数（流明头模的参数是「若干形态键各自的权重」，
     * 不是一个 key 对应一个值，通用那套 Number() 会把它洗坏）。 */
    if (typeof def.onEvent === 'function') {
      var ctx = node
        ? { def: def, params: params, esc: esc, fmt: fmtNum, doc: st.doc, node: node }
        : componentCtx(def);
      var how = def.onEvent({ type: 'param', key: key, value: value }, ctx);
      if (node) refreshNodeComp(node.id);
      repaintComponent(how, node ? node.id : '');
      return;
    }
    var step = null;
    componentFields(def).forEach(function (f) { if (f.key === key) step = f; });
    /* 下拉选的是字符串（形态键名字），不能被下面那套 Number() 洗成 0 */
    if (step && step.type === 'select') {
      params[key] = value == null ? '' : String(value);
      if (node) { refreshNodeComp(node.id); repaintComponent('preview', node.id); return; }
      paintComponentPreview();
      return;
    }
    var v = Number(value);
    if (!isFinite(v)) return;
    if (step && step.int) v = Math.round(v);
    params[key] = v;
    if (node) { refreshNodeComp(node.id); repaintComponent('preview', node.id); return; }
    if (step && st.overlay) {
      var lab = st.overlay.querySelector('[data-md-cpv="' + key + '"]');
      if (lab) lab.textContent = fmtNum(v, step.dec);
    }
    paintComponentPreview();
  }

  function setComponentPreset(presetId) {
    var def = componentDef();
    if (!def) return;
    st.comp.preset = presetId;
    st.comp.params = def.paramsOf(presetId);
    /* 预设换掉 = 所有字段都变，这时必须整块重铺（滑杆值要跟着走） */
    if (st.overlay && st.overlay.className.indexOf('comp') >= 0) {
      overlayShow(componentDialogHtml(), 'comp');
    }
  }

  /* 只把相机对准这一小块：组件可能被摆在离原点几米外（按已有对象排开），
   * 沿用 frameCamera() 会框住整个场景，新加的头会小成一个点。 */
  function focusOnPoint(cx, cy, cz, radius) {
    if (!st.controls || !st.camera) return;
    var r = Math.max(Number(radius) || 0.12, 0.05);
    var d = r * 4.2;
    st.camera.near = Math.max(r / 100, 0.001);
    st.camera.far = Math.max(r * 60, 100);
    st.camera.updateProjectionMatrix();
    st.controls.target.set(cx, cy, cz);
    st.camera.position.set(cx + d * 0.30, cy + d * 0.18, cz + d * 0.94);
    st.viewName = '透视';
    st.controls.update();
    if (st.quad) updateQuadCameras(true);
  }

  /* 新零件往哪放：沿 +X 找已有对象的右边界再让开一点。
   * ⚠ 不能用「节点数 × 间距」：默认文档里是一个 1m 的立方体，头只有 0.23m，
   *   按数量排开时头正好落在立方体**内部**，加完屏幕上什么都没有（实测染色整屏红，
   *   挡在人眼前的是立方体）。按包围盒避让才不管旧对象多大。 */
  function freeSpotX(halfWidth) {
    var pad = Math.max(Number(halfWidth) || 0.1, 0.08) + 0.06;
    if (!THREE || !st.pivots) return 0;
    var maxX = null;
    Object.keys(st.pivots).forEach(function (id) {
      var pv = st.pivots[id];
      if (!pv) return;
      var b = new THREE.Box3().setFromObject(pv);
      if (b.isEmpty()) return;
      maxX = maxX == null ? b.max.x : Math.max(maxX, b.max.x);
    });
    return maxX == null ? 0 : maxX + pad;
  }

  function addComponent() {
    if (!st.doc) return false;
    var def = componentDef();
    if (!def) { setStatus('没有可用的组件源', true); return false; }
    if (!global.SeedModel || !SeedModel.Mesh || !SeedModel.Scene) {
      setStatus('SeedModel 未加载，无法生成组件', true);
      return false;
    }
    var btn = st.overlay ? st.overlay.querySelector('[data-md-act="comp-add"]') : null;
    /* 面板是从「属性 → 调整组件」进来的，就走**改现有对象**这条路：
     * 不新增副本、不重建网格，只把参数应用到那个节点上。 */
    var editing = componentEditNode();
    function restore() {
      if (btn) { btn.disabled = false; btn.textContent = editing ? '应用到对象' : '添加到场景'; }
    }
    /* 异步组件源（流明头模）：先把资产读进来再走下面同一段提交逻辑。
     * 只在这一处等，commit() / applyToNode() 里不再区分同步 / 异步。 */
    if (def.async && !def.ready()) {
      if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
      setStatus('正在读取' + def.name + '…');
      var p0 = def.load ? def.load() : Promise.reject(new Error('组件源没有 load()'));
      p0.then(function () { return editing ? applyToNode() : commit(); }).catch(function (e) {
        restore();
        setStatus(def.name + '读取失败：' + ((e && e.message) || e), true);
      });
      return true;
    }
    return editing ? applyToNode() : commit();

    /* 改已有对象：组件的 applyTo 只动它自己那部分（头模 = 形态键权重），
     * 拓扑、UV、用户改过的顶点一概不碰 —— 这才叫「属性」，不是「重新生成」。 */
    function applyToNode() {
      var node = componentEditNode();
      if (!node) return commit();
      var d2 = componentDef();
      if (typeof d2.applyTo !== 'function') {
        restore();
        setStatus(d2.name + ' 的参数只能在添加时设定', true);
        return false;
      }
      var p = componentParams(d2);
      var snapshot = JSON.parse(JSON.stringify(p));
      if (btn) { btn.disabled = true; btn.textContent = '应用中…'; }
      var ok = docEdit('调整' + d2.name, function () {
        var mesh = SeedModel.Scene.getMesh(st.doc, node);
        if (!mesh) return false;
        if (d2.applyTo(mesh, p) === false) return false;
        /* 形态键权重住在 mesh.morphs 里，必须写回 doc.meshes 才存得住
         * （只改内存对象的话，存盘重开表情就没了）。 */
        SeedModel.Scene.setMesh(st.doc, mesh, node);
        node.comp = { id: d2.id, params: snapshot };
        return true;
      });
      if (!ok) { restore(); setStatus('应用失败', true); return false; }
      closeOverlay();
      setTbKind('props');
      setStatus('已更新' + d2.name + '的参数 · Ctrl+Z 可撤销');
      paintAll();
      return true;
    }

    function commit() {
      var p = componentParams(def);
      if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

      var geo = null, mesh = null;
      try {
        geo = def.buildGeometry(p);
        /* weld:false —— 组件自带 UV 缝与形态键，一焊就只剩一份 UV / 一份位移，
         * 那一列面会横跨整张贴图拉出色带。和「带形态键的模型」同一个口径。 */
        var opts = { slot: 0, weld: false };
        /* 形态键原样过桥：名字与位移都由组件源给（流明的 112 个），
         * 建模 App 只是把它们搬进自己的 mesh.morphs —— 这就是「桥」而不是「重做」。 */
        if (geo.userData && geo.userData.morphNames && geo.userData.morphNames.length) {
          opts.morphNames = geo.userData.morphNames;
          opts.morphWeights = geo.userData.morphWeights;
        }
        mesh = SeedModel.Mesh.fromBufferGeometry(geo, opts);
      } catch (e) {
        restore();
        setStatus(def.name + '生成失败：' + ((e && e.message) || e), true);
        return false;
      }
      if (!mesh) { if (geo && geo.dispose) geo.dispose(); restore(); setStatus('网格构建失败', true); return false; }

      /* 新网格要先登记进历史模块的副本表，否则撤销回不到几何（与新建基础体同一处坑） */
      ensureMeshCopy(mesh);
      var px = freeSpotX(halfWidthOf(mesh));
      var ok = docEdit('添加' + def.name, function () {
        var node = SeedModel.Scene.addMeshNode(st.doc, {
          name: def.name,
          mesh: mesh,
          transform: { position: [px, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
        });
        if (!node) return false;
        SeedModel.Scene.setActiveNode(st.doc, node.id);
        /* 记下「这是哪个组件、参数是什么」（纯数据）。
         * 没有这一笔，这个头加进场景就只是一块普通网格：
         * 存盘重开之后再想改表情，连它来自哪里都无从查起。 */
        node.comp = { id: def.id, params: JSON.parse(JSON.stringify(p)) };
        /* 沿 X 排开时如果当前文档还是「立方体 / 未命名模型」这类系统名，
         * 就跟着改成新零件名 —— 否则存出来的文档名和内容是两回事 */
        if (AUTO_NAMES[st.doc.name]) SeedModel.Scene.setName(st.doc, def.name);
        return true;
      });
      if (geo && geo.dispose) geo.dispose();
      if (!ok) { restore(); setStatus('添加失败', true); return false; }

      closeOverlay();
      /* 加完就把右栏切到属性：这个零件有自己的一套参数（表情 / 形态键），
       * 停在工具箱上等于把「它还能继续调」这件事藏起来了。 */
      setTbKind('props');
      var box = meshBox(mesh);
      var st2 = SeedModel.Mesh.stats(mesh);
      /* 视点对准网格自己的中心（各组件原点位置不统一：头模是居中在原点，
       * 别的零件未必），半径取包围盒对角的一半，别让新零件在屏幕外。 */
      focusOnPoint(px + box.cx, box.cy, box.cz, Math.max(box.r, 0.05));
      var extra = mesh.morphs && mesh.morphs.length ? ' · ' + mesh.morphs.length + ' 个形态键' : '';
      setStatus('已添加' + def.name + '（' + st2.faces + ' 面 · ' + st2.vertices + ' 顶点' + extra + ' · 共 ' +
        SeedModel.Scene.nodesOf(st.doc).length + ' 个对象，Ctrl+Z 可撤销）');
      paintAll();
      return true;
    }
  }

  /* 组件摆放用的两个量都从**真实网格**算，不问组件要：
   * 组件的「尺寸参数」是它自己的事，可能根本没有（流明头模就没有 width 参数）。 */
  function meshBox(mesh) {
    var p = (mesh && mesh.positions) || [];
    var n = p.length / 3;
    if (!n) return { cx: 0, cy: 0, cz: 0, r: 0.1, hw: 0.1 };
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < 3; k++) {
        var v = p[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    var cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
    var dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
    return {
      cx: cx, cy: cy, cz: cz,
      hw: dx / 2,
      r: Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
    };
  }
  function halfWidthOf(mesh) { return meshBox(mesh).hw; }

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
      /* 立方体走盒式展开：BoxGeometry 的面 UV 全重叠，绘制时分不清是哪一面 */
      if (String(p.shape).toLowerCase() === 'box') boxUnwrapUV(mesh);
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

  /* 形态键的名字与默认权重：three 把它们挂在 Mesh 上（morphTargetDictionary /
   * morphTargetInfluences），几何里没有。字典是「名字 → 下标」，这里翻回有序数组。 */
  function morphNamesOf(obj) {
    var dict = obj && obj.morphTargetDictionary;
    var inf = obj && obj.morphTargetInfluences;
    if (!dict || !inf || !inf.length) return null;
    var names = new Array(inf.length);
    Object.keys(dict).forEach(function (key) {
      var i = dict[key];
      if (i >= 0 && i < names.length) names[i] = key;
    });
    for (var i = 0; i < names.length; i++) if (!names[i]) names[i] = 'morph ' + (i + 1);
    return { names: names, weights: Array.prototype.slice.call(inf) };
  }

  /* clone 后烘矩阵：Model3D 的缓存里几何是共享的，直接 applyMatrix4 会污染缓存 */
  function bakeImportGeometry(o) {
    var geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    /* three 的 applyMatrix4 只搬 position / normal，**不碰 morphAttributes**。
     * 形态键存的是位移向量，必须跟着同一个线性的部分（旋转 + 缩放）转一遍，
     * 否则「父级转过 90° 的模型」表情会往错方向动 —— 而且看起来像模型本身有 bug。 */
    bakeMorphMatrix(geo, o.matrixWorld);
    return geo;
  }

  /* 把 3×3 线性部分应用到每个形态键的 delta 上（glTF 的 morph 一律是相对值） */
  function bakeMorphMatrix(geo, matrix) {
    var list = geo.morphAttributes && geo.morphAttributes.position;
    if (!list || !list.length || !matrix) return;
    var m = matrix.elements;
    var e0 = m[0], e1 = m[1], e2 = m[2], e4 = m[4], e5 = m[5], e6 = m[6], e8 = m[8], e9 = m[9], e10 = m[10];
    /* 纯平移 / 单位矩阵：不动，省掉 112 × 顶点数 × 9 次乘法 */
    if (e0 === 1 && e1 === 0 && e2 === 0 && e4 === 0 && e5 === 1 && e6 === 0 && e8 === 0 && e9 === 0 && e10 === 1) return;
    list.forEach(function (attr) {
      for (var i = 0; i < attr.count; i++) {
        var x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i);
        attr.setXYZ(i,
          x * e0 + y * e4 + z * e8,
          x * e1 + y * e5 + z * e9,
          x * e2 + y * e6 + z * e10);
      }
      attr.needsUpdate = true;
    });
  }

  /* 碎片拼成一份非索引几何：position / uv / 形态键，法线由 SeedMesh 重算（导入本来就不认原法线）。
   * 形态键只在「各碎片的形态键数量一致」时保留 —— 对不上说明是不同资产被并到了一起，
   * 硬拼会让权重错位，宁可整组丢掉（并且让面板看不到它，而不是给它一堆假滑杆）。 */
  function concatImportGeometries(geos) {
    var flat = [], temp = [];
    geos.forEach(function (g) {
      if (g.index && typeof g.toNonIndexed === 'function') {
        /* ⚠ toNonIndexed 会把 morphAttributes 按新顶点序展开（three 自己处理），
         * 所以展开后再取，别在原始的索引几何上取。 */
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
    var first = flat[0] && flat[0].morphAttributes && flat[0].morphAttributes.position;
    var morphCount = first ? first.length : 0;
    var morphOk = morphCount > 0 && flat.every(function (g) {
      var list = g.morphAttributes && g.morphAttributes.position;
      return !!(list && list.length === morphCount && list.every(function (a) {
        return a.count === g.getAttribute('position').count;
      }));
    });
    var pos = new Float32Array(total * 3);
    var uv = hasUv ? new Float32Array(total * 2) : null;
    var morphOut = morphOk ? first.map(function () { return new Float32Array(total * 3); }) : null;
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
      if (morphOut) {
        var ml = g.morphAttributes.position;
        for (var mi = 0; mi < ml.length; mi++) {
          var a = ml[mi], dst = morphOut[mi];
          for (var vi = 0; vi < a.count; vi++) {
            var o3 = (off + vi) * 3;
            dst[o3] = a.getX(vi); dst[o3 + 1] = a.getY(vi); dst[o3 + 2] = a.getZ(vi);
          }
        }
      }
      off += p.count;
    });
    temp.forEach(function (g) { g.dispose(); });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (morphOut) {
      out.morphTargetsRelative = true;
      out.morphAttributes.position = morphOut.map(function (arr) { return new THREE.Float32BufferAttribute(arr, 3); });
    }
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

    var slotNames = [], slotColors = [], slotKeys = [], slotMats = [], slotTexs = [];
    /* 贴图身份也要进槽的去重 key。多对象模型里「一张图一个对象」非常常见，而材质名和
     * 底色往往一模一样（Tripo 导出的每个对象都叫 Material_tripo_…、底色都是纯白，
     * 只有 baseColorTexture 不同）。只按「名字 + 底色」去重会把这些材质并成一个槽，
     * 于是第二个对象贴上第一张图、第二张图彻底丢失 —— 用户看到的就是「多 object
     * 带不同贴图时导出贴图错位」。同一个 Texture 实例才算同一张图（GLTFLoader 按
     * texture 下标复用实例），没有贴图的材质仍按名字合并。 */
    function slotTexKey(mat) {
      var tex = mat && mat.map;
      if (!tex) return '';
      var k = slotTexs.indexOf(tex);
      if (k < 0) { k = slotTexs.length; slotTexs.push(tex); }
      return '#t' + k;
    }
    function slotOf(mat) {
      var nm = (mat && mat.name) || '默认材质';
      var col = (mat && mat.color && mat.color.isColor) ? '#' + mat.color.getHexString() : '#c9ccd4';
      var key = nm + '|' + col + '|' + slotTexKey(mat);
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
      var morphMeta = morphNamesOf(g.parts[0]);
      try {
        mesh = SeedModel.Mesh.fromBufferGeometry(geo, {
          slot: g.slot, quadOpts: { tolDeg: 40, shapeTol: 80 },
          /* 形态键的名字和默认权重只在 three 的 Mesh 上有，几何里没有 —— 必须在这里交班 */
          morphNames: morphMeta ? morphMeta.names : null,
          morphWeights: morphMeta ? morphMeta.weights : null
        });
      }
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
    for (var i = 1; i < built.length; i++) {
      SeedModel.Scene.addMeshNode(doc, {
        name: built[i].name || (title + ' ' + (i + 1)),
        mesh: built[i].mesh
      });
    }
    SeedModel.Scene.setActiveNode(doc, firstNode.id);
    /* 新导入的模型默认选中第一个对象：它没有「用户清空过选择」的历史，
     * 空手打开会让人以为没打开成功（空选只从用户主动 Ctrl+点击空白 / Esc 产生）。 */
    SeedModel.Scene.setSelection(doc, { mode: 'object', nodeIds: [firstNode.id] });
    return doc;
  }

  /* 老资产补色：v2.0 的 seedModel 只存了槽名，没存 slotColors（打开后整只模型都是默认灰）。
   * 这里从 GLB 自己的材质把显示色 / 基础色贴图补回来：先按材质名配，配不上按槽顺序。
   * fillFrom = 文档里已有的有效槽色数量，只补它后面的，别覆盖用户改过的颜色。 */
  async function backfillMaterials(doc, dataURL, fillFrom, skipMaps) {
    var mats = doc && doc.materials;
    var names = (mats && mats.slotNames) || [];
    if (!names.length) return false;
    var m3 = global.Model3D;
    if (!m3 || typeof m3.load !== 'function') return false;
    var model;
    try { model = await m3.load(dataURL); } catch (e) { return false; }
    var found = [], byName = Object.create(null), byMesh = Object.create(null);
    model.root.updateMatrixWorld(true);
    model.root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var arr = Array.isArray(o.material) ? o.material : [o.material];
      arr.forEach(function (mm) {
        if (!mm) return;
        var nm = String(mm.name || '');
        if (nm && byName[nm] == null) byName[nm] = found.length;
        found.push(mm);
      });
      if (o.name && byMesh[o.name] == null) byMesh[o.name] = arr;
    });
    if (!found.length) return false;

    /* 槽 → 材质最可靠的配对是「节点名」。
     * 材质名在 Tripo 模型里几乎全是同一个（一个对象一份），靠名字只能兜底；
     * 而 GLTFLoader 返回网格的顺序并不稳定（贴图异步解析，实测同一次导入
     * 两次运行会翻转），按遍历下标硬配会把别的对象的贴图补进来 ——
     * 用户看到的就是「贴图错乱」。seed 文档的节点名就是导入时的网格名，
     * 能一对一定位到那份 GLB 的材质。 */
    var pickBySlot = [];
    try {
      SeedModel.Scene.nodesOf(doc).forEach(function (n) {
        var list = n && n.name ? byMesh[n.name] : null;
        if (!list || !list.length) return;
        var own = [];
        try { own = SeedModel.Scene.meshSlotsOf(doc, n) || []; } catch (e) { own = []; }
        own.forEach(function (s, k) {
          if (pickBySlot[s] === undefined) pickBySlot[s] = list.length === 1 ? list[0] : (list[k] || null);
        });
      });
    } catch (e) { pickBySlot = []; }

    var colors = (mats.slotColors || []).slice();
    var maps = (mats.slotMaps || []).slice();
    var picks = [], jobs = [];
    /* 先按节点名配对；配不上再按材质名，最后按剩余顺序兜底。
     * 每份材质只能被一个槽占用：否则两个同材质名的槽会拿到同一张贴图。 */
    var used = Object.create(null);
    for (var i = 0; i < names.length; i++) {
      var pick = pickBySlot[i] || null;
      var at = pick ? found.indexOf(pick) : -1;
      if (at < 0 || used[at]) {
        pick = null;
        at = byName[names[i]] != null ? byName[names[i]] : -1;
        if (at >= 0 && used[at]) at = -1;
        if (at >= 0) pick = found[at];
      }
      if (!pick) {
        for (var k = 0; k < found.length; k++) {
          if (!used[k]) { at = k; pick = found[k]; break; }
        }
      }
      if (at >= 0) used[at] = 1;
      picks.push(pick);
      /* 槽色已经有的不覆盖；贴图缺的仍然补（老文档根本没写过 slotMaps）。
       * skipMaps 里的槽是「笔迹底座本来就是空」的——GLB 里那张是合成图，
       * 拿它当底座会让下次打开把笔迹再叠一遍，所以宁可这一槽没有底图。 */
      if (pick && !maps[i] && !(skipMaps && skipMaps[i])) jobs.push(i);
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
      /* 有编辑层的槽：底座要是空的，就不能从 GLB 的合成图补（会重复叠笔迹） */
      var skipMaps = null;
      if (Array.isArray(rawMats.slotPainted) && rawMats.slotPainted.length) {
        skipMaps = Object.create(null);
        rawMats.slotPainted.forEach(function (k) { skipMaps[Number(k)] = 1; });
      }
      if (haveColors < doc.materials.slotNames.length || haveMaps < doc.materials.slotNames.length) {
        var filled = await backfillMaterials(doc, r.dataURL, haveColors, skipMaps);
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
    if (MIX && MIX.migrateLegacy) MIX.migrateLegacy(doc);
    st.doc = doc;
    st.isolate = false;        /* 打开新资产时回到全场景显示 */
    st.node = SeedModel.Scene.nodeOf(doc);
    st.nodeIds = st.node ? [st.node.id] : [];
    st.mesh = SeedModel.Scene.getMesh(doc);
    loadSelection(doc);
    /* v1 烘焙出来的文档没有「选择集」概念：给它选中第一个对象，
     * 避免打开后看不到手柄。用户明确清空过的 v2 文档仍按空选恢复。 */
    if (converted && !st.nodeIds.length && st.node) st.nodeIds = [st.node.id];
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
   * 材质必须整体后移并重映射 faceSlots：材质库是文档级的，
   * 直接复用源的槽下标会让两个模型落到同一批槽上（就是「材质串通」）。
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

    var xOff = SeedModel.Scene.nodesOf(st.doc).length;
    var added = 0;
    var ok = slotEdit('置于：' + (src.name || pack.id), function () {
      /* 1) 源材质整体并入目标材质库：每个槽拿新 id，不和已有模型共享 */
      var merge = SeedModel.Scene.adoptMaterials(st.doc, src);
      var offset = merge.offset;
      var first = null;
      srcNodes.forEach(function (it) {
        var t = it.node.transform || {};
        var own = [];
        try { own = SeedModel.Scene.meshSlotsOf(src, it.node) || []; } catch (e) { own = []; }
        var node = SeedModel.Scene.addMeshNode(st.doc, {
          name: it.node.name,
          /* 2) 克隆后把面的槽下标整体后移，落到刚并入的那批材质上 */
          mesh: SeedModel.Scene.remapSlotIndices(SeedModel.Mesh.clone(it.mesh), offset),
          slots: own.map(function (s) { return s + offset; }),
          transform: {
            position: [Number(t.position[0] || 0) + xOff * 1.2,
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
      /* 3) 源资产里每个材质的纹理栈也搬过来（按稳定 id → 旧槽名兜底） */
      if (MIX && MIX.adoptSlot) {
        for (var i = 0; i < merge.count; i++) {
          MIX.adoptSlot(st.doc, offset + i, merge.textureConfigKey,
            [merge.srcIds[i], merge.srcNames[i]]);
        }
      }
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
  /* 单关导出的过滤开关（set/reset 成对出现在 exportLevelGLB / exportBytes 里）：
   * null = 全文档。开启时 buildExportRoot 只放行该关卡的节点。 */
  var EXPORT_LEVEL = null;
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
    /* 单关导出：只放行该关卡的对象，文件名带上关卡名（Unreal 的 Save Level 语义） */
    var allowed = null;
    if (EXPORT_LEVEL) {
      allowed = Object.create(null);
      SeedModel.Scene.levelNodeIds(st.doc, EXPORT_LEVEL).forEach(function (id) { allowed[id] = 1; });
      var lv = SeedModel.Scene.levelById(st.doc, EXPORT_LEVEL);
      if (lv && lv.name) root.name = (st.doc.name || 'model') + '_' + lv.name;
    }
    var nodes = SeedModel.Scene.nodesOf(st.doc);
    nodes.forEach(function (n) {
      if (n.visible === false) return;
      if (allowed && !allowed[n.id]) return;
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
    bakeShapeIntoExportRoot(root);
    return root;
  }

  /* ---------------- 捏脸烘焙（导出） ----------------
   * 捏脸形变住在顶点着色器里 —— geometry.position 永远是原始脸。而 GLB / OBJ /
   * STL / FBX 全都只读 position，不烘焙的话外部软件看到的永远是没捏过的脸。
   * 烘焙口径（与视口一致）：bind pose 下蒙皮恒等（probe-md-parity 已证），
   * shader 注入在 skinning_vertex 之后 ⇒ baked = l3Deform(rest, rest)。
   * ① position = 烘焙后的顶点（「实际的捏脸后的顶点数据」，任何阅读器直接可见）；
   * ② 通用形态键：每个改过的参数一条 `mdShape_<key>`（delta = 单参数效果 − 原始 rest，
   *    Blender 形态键的标准语义），外加 `mdShape_Rest`（原始脸，拉 1 可回捏前）。
   *    three 的 morphTargetsRelative=true ⇒ GLTFExporter 原样写 delta，
   *    不做 absolute→relative 转换（base 是烘焙后 position，转换语义就错了）。
   * ③ mesh.userData.mdShapeBaked 记参数与 targetNames（GLB extras），
   *    自家 App 重导入时据此把形态键名对上、params 不再二次形变。
   * ⚠ 只动导出 pivot：geometry 换成新副本（position/normal 新数组），其余 attribute
   *   （uv / skinIndex / skinWeight / 色层）共享缓存几何的引用 —— 绝不污染视口缓存。 */
  function bakeShapeIntoExportRoot(root) {
    if (!st.doc) return;
    var nodesById = {};
    SeedModel.Scene.nodesOf(st.doc).forEach(function (n) { nodesById[n.id] = n; });
    var warned = false;
    root.children.forEach(function (pivot) {
      var node = nodesById[pivot.userData.mdNode];
      if (!node || !node.comp || !node.comp.id) return;
      var def = componentDefById(node.comp.id);
      if (!def || typeof def.shapeDeform !== 'function' || typeof def.shapeInfo !== 'function') return;
      var shape = (node.comp.params && node.comp.params.shape) || {};
      var active = (def.shapeInfo().defs || []).filter(function (d) {
        var v = Number(shape[d.key]);
        return isFinite(v) && v !== 50;
      });
      if (!active.length) return;   /* 全 50 = 原始脸：烘焙与形态键都不需要 */
      pivot.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.userData || o.userData.mdPart !== 'solid') return;
        if (o.userData.mdShapeBaked) return;
        var geo = o.geometry;
        var pos = geo.attributes.position;
        if (!pos || !pos.count) return;
        var rest = new Float32Array(pos.count * 3);
        rest.set(pos.array.subarray(0, pos.count * 3));
        var baked = def.shapeDeform(rest, shape);
        if (!baked) {
          if (!warned) { setStatus('捏脸烘焙求值不可用，导出的是原始脸（参数仍保存在文档里）', true); warned = true; }
          return;
        }
        var g2 = new THREE.BufferGeometry();
        g2.morphTargetsRelative = true;
        g2.setAttribute('position', new THREE.BufferAttribute(baked, 3));
        Object.keys(geo.attributes).forEach(function (k) {
          if (k === 'position') return;
          g2.setAttribute(k, geo.attributes[k]);   /* 共享引用，不复制 */
        });
        if (geo.index) g2.setIndex(geo.index);
        if (geo.groups && geo.groups.length) {
          g2.groups = geo.groups.map(function (gr) {
            return { start: gr.start, count: gr.count, materialIndex: gr.materialIndex || 0 };
          });
        }
        /* 法线跟着烘焙重算：先复制（不写共享 attribute），再按面遍历重算 */
        if (geo.attributes.normal) {
          g2.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(geo.attributes.normal.array), 3));
          g2.computeVertexNormals();
        }
        /* 通用形态键 */
        var names = [], infl = [], targets = [];
        active.forEach(function (d) {
          var t = def.shapeDeform(rest, (function () { var s = {}; s[d.key] = shape[d.key]; return s; })());
          if (!t) return;
          /* delta = 单参数效果 − 原始 rest（相对 rest 的标准形态键 delta） */
          var delta = new Float32Array(t.length);
          for (var i = 0; i < t.length; i++) delta[i] = t[i] - rest[i];
          targets.push(new THREE.BufferAttribute(delta, 3));
          names.push('mdShape_' + d.key);
          infl.push(0);
        });
        {
          /* mdShape_Rest：原始脸（delta = rest − baked）。参数怎么捏的都可逆。 */
          var rd = new Float32Array(rest.length);
          for (var r2 = 0; r2 < rest.length; r2++) rd[r2] = rest[r2] - baked[r2];
          var rdMax = 0;
          for (var r3 = 0; r3 < rest.length; r3++) rdMax = Math.max(rdMax, Math.abs(rd[r3]));
          if (rdMax > 1e-6) {
            targets.unshift(new THREE.BufferAttribute(rd, 3));
            names.unshift('mdShape_Rest');
            infl.unshift(0);
          }
        }
        if (targets.length) {
          g2.morphAttributes.position = targets;
          o.morphTargetInfluences = infl;
          var dict = {};
          names.forEach(function (nm, ni) { dict[nm] = ni; });
          o.morphTargetDictionary = dict;
        }
        o.geometry = g2;
        /* ⚠ mdShapeBaked 必须放 geometry.userData（→ GLB 的 primitive.extras）：
         * mesh.userData 带 mdSkin（骨骼引用，循环结构）无法 JSON.stringify，
         * 而 meshDef.extras 被 GLTFExporter 独占给 targetNames。primitive.extras
         * Blender 等外部工具读得到；自家导入不依赖它 —— targetNames 已携带
         * 「这些形态键是捏脸键」的全部语义（权重 0 + 无组件 = 不会二次形变）。 */
        g2.userData.mdShapeBaked = { version: 1, params: shape, targetNames: names };
      });
    });
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
      /* 视口当前显示的这张才是最终视觉：纹理混合 / 绘画写回的合成图都挂在
       * material.map 上，slotMaps 只是它的底座。底座优先会导出「旧的」那张图 ——
       * 用户配好的混合层在 GLB 里看不到，就是这条顺序造成的。 */
      var img = null;
      /* 保存前已由 MIX.bakeForSave() 合成到最新：直接取那张画布，
       * 不依赖视口是否渲染过 / 材质上挂的是哪张。 */
      try {
        if (MIX && MIX.composedCanvas) img = MIX.composedCanvas(i);
      } catch (e) { img = null; }
      if (!img) {
        try {
          var lv0 = liveSlotImage(i);
          if (lv0 && (lv0.naturalWidth || lv0.width)) img = lv0;
        } catch (e) { /* 视口还没起来就跳过 */ }
      }
      if (!img && arr[i]) {
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
    /* 保存前自动烘焙：把每个材质槽的「底座 + 图层 + 笔迹」合成到最新。
     * 放在这里而不是 save() 里，是因为导出到电脑（GLB/GLTF）也走同一条路径。 */
    if (MIX && MIX.bakeForSave) {
      try { await MIX.bakeForSave(); } catch (e) { /* 单槽失败不阻断保存 */ }
    }
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
      /* 有材质图层 / 烘焙图的槽：底座保持原样，交给 MIX.bakeForSave() 一次性合成
       * 「底座 ⊕ 图层 ⊕ 笔迹」。这里再换一次会把笔迹叠两遍（半透明笔会变深）。 */
      if (MIX && MIX.needsBake && MIX.needsBake(i)) continue;
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

  /* 写进 GLB 的 extras：slotMaps 必须是「笔迹 / 混合层之下的底座」。
   * 旧顺序在 glbTexSwap 换图期间序列化，extras 里存的是「底座 ⊕ 笔迹」的合成图 ——
   * 重开时再把 ops 叠一遍，同一笔会画两次；同一张图还在 GLB images 里存了第二份。
   * 现在改成：
   *   - 先还原、再序列化（底座就是底座）；
   *   - 没叠过混合层 / 笔迹的槽，extras 不再存一份（GLB 的 baseColorTexture 就是它）；
   *   - 叠过的槽保留底座，并标记 slotPainted，重开时不会拿合成图当底座。
   * 这次导出一张图都没带上时不做任何瘦身 —— 宁可文件大，不能丢贴图。 */
  function exportDocJson(buf, levelId) {
    var docJson = SeedModel.Scene.toSeedModel(st.doc);
    /* 单关导出：seedModel 也按关裁剪 —— 只留该关节点、它引用的网格、它自己。
     * 不裁的话 GLB 网格只有一关，seedModel 却把别的关的数据全带上，
     * 导入回 App 会「半恢复」出幽灵对象（有节点有网格、不在 GLB 场景里）。 */
    if (levelId) docJson = filterDocJsonForLevel(docJson, levelId);
    try {
      var mats = docJson && docJson.materials;
      var maps = mats && mats.slotMaps;
      if (!maps || !maps.length) return docJson;
      var imgCount = 0;
      try { imgCount = ((SeedGLB.readJson(buf) || {}).images || []).length; } catch (e) { imgCount = 0; }
      if (!imgCount) return docJson;
      var TS = global.TexStack;
      var painted = [];
      for (var i = 0; i < maps.length; i++) {
        var hasOps = !!(TS && TS.has && TS.has(st.doc, i));
        var layered = !!(MIX && ((typeof MIX.needsBake === 'function' && MIX.needsBake(i)) ||
          (typeof MIX.hasLayers === 'function' && MIX.hasLayers(i))));
        if (!hasOps && !layered) {
          /* 没叠过任何东西：GLB 的 baseColorTexture 就是这张底座本身，重开时
           * backfill 会从 images 解回来，extras 不再存第二份。 */
          maps[i] = '';
          continue;
        }
        /* 有混合层 / 笔迹：slotMaps 是它们的底座，必须保留 —— GLB 里那张是
         * 「底座 ⊕ 叠加」的合成图，拿它当底座会让重开时再叠一遍。
         * 底座为空（从白底开始画）也要留个标记，别让 backfill 用合成图补上。 */
        painted.push(i);
      }
      /* 有编辑层的槽：重开时不许从 GLB 的合成图补底座（会重复叠笔迹） */
      if (painted.length) mats.slotPainted = painted;
    } catch (e) { /* 元数据瘦身失败不影响导出本身 */ }
    return docJson;
  }

  /* 单关 seedModel 裁剪：nodes / meshes / levels / activeNodeId / name 全部收到该关。
   * 网格按「留下的节点还引用谁」回收 —— 没人用的网格不能跟着走（白白翻倍文件）。 */
  function filterDocJsonForLevel(docJson, levelId) {
    var S = SeedModel.Scene;
    var keep = Object.create(null);
    S.levelNodeIds(st.doc, levelId).forEach(function (id) { keep[id] = 1; });
    docJson.nodes = (docJson.nodes || []).filter(function (n) { return keep[n.id]; });
    var used = Object.create(null);
    docJson.nodes.forEach(function (n) { if (n.meshRef) used[n.meshRef] = 1; });
    Object.keys(docJson.meshes || {}).forEach(function (id) {
      if (!used[id]) delete docJson.meshes[id];
    });
    var lv = null;
    (docJson.levels || []).forEach(function (l) {
      if (l.id === levelId) lv = l;
    });
    docJson.levels = lv ? [{ id: lv.id, name: lv.name, nodes: (lv.nodes || []).filter(function (id) { return keep[id]; }), visible: lv.visible !== false, locked: lv.locked === true }] : [];
    docJson.activeNodeId = docJson.nodes[0] ? docJson.nodes[0].id : '';
    var lvName = lv ? lv.name : '关卡';
    docJson.name = String((st.doc.name || 'model')) + '_' + lvName;
    return docJson;
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
      /* 投射层 → 合成图（见 glbTexSwap 的说明）。try/finally 保证异常也换回来；
       * extras 必须在换回来之后再序列化，否则存进 GLB 的是合成图而不是底座。 */
      var restoreTex = glbTexSwap();
      var buf;
      try {
        buf = await currentGLB();
      } finally {
        restoreTex();
      }
      var docJson = exportDocJson(buf);
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

  /* ---------------- 导出到电脑（不经过资产库） ----------------
   * 和「保存 GLB」的区别：保存写的是模型库（App 内资产），导出直接把文件
   * 写到用户选的磁盘位置。支持 GLB / GLTF / OBJ / STL 四种格式；
   * 文件名不做唯一性校验（允许重名），桌面端遇到同名文件自动顺延 (2)(3)…，
   * 绝不静默覆盖用户已有文件。 */
  var EXPORT_FORMATS = {
    glb: { label: 'GLB', ext: 'glb', mime: 'model/gltf-binary', desc: '二进制 glTF，单文件带贴图' },
    gltf: { label: 'GLTF', ext: 'gltf', mime: 'model/gltf+json', desc: 'JSON glTF，贴图内嵌为 data URI' },
    obj: { label: 'OBJ', ext: 'obj', mime: 'text/plain', desc: '通用网格格式（不带贴图）' },
    stl: { label: 'STL', ext: 'stl', mime: 'model/stl', desc: '打印常用格式（不带贴图）' },
    /* 压缩包：模型 + 贴图分开存。OBJ 用 MTL 指路，FBX 用 Texture/Video 节点指路，
     * 贴图统一放 textures/，解压后直接打开模型文件即可看到贴图。 */
    objz: { label: 'OBJ 包', ext: 'zip', mime: 'application/zip', desc: 'OBJ + MTL + PNG 贴图压缩包' },
    fbxz: { label: 'FBX 包', ext: 'zip', mime: 'application/zip', desc: 'FBX + PNG 贴图压缩包（ASCII 7.4）' }
  };
  function expNum(n) {
    if (!isFinite(n)) return '0';
    var r = Math.round(n * 1e6) / 1e6;
    return String(r);
  }
  /* OBJ：默认只写几何；opt.usemtl 时按几何分组写 usemtl，配 MTL 就能带贴图。
   * mtllibName 写进文件头，外部查看器 / Blender 打开时会自动找同名 .mtl。 */
  function exportOBJText(root, opt) {
    opt = opt || {};
    root.updateMatrixWorld(true);
    var out = ['# modeldesk OBJ export'];
    if (opt.mtllibName) out.push('mtllib ' + opt.mtllibName);
    out.push('o ' + String((st.doc && st.doc.name) || 'model').replace(/\s+/g, '_'));
    var vBase = 1, tBase = 1, nBase = 1;
    var v = new THREE.Vector3();
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.userData || o.userData.mdPart !== 'solid') return;
      var g = o.geometry, pos = g.attributes.position, uv = g.attributes.uv, nor = g.attributes.normal;
      if (!pos) return;
      var m = o.matrixWorld, i;
      for (i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        out.push('v ' + expNum(v.x) + ' ' + expNum(v.y) + ' ' + expNum(v.z));
      }
      if (uv) for (i = 0; i < uv.count; i++) out.push('vt ' + expNum(uv.getX(i)) + ' ' + expNum(uv.getY(i)));
      if (nor) {
        var nm = new THREE.Matrix3().getNormalMatrix(m);
        for (i = 0; i < nor.count; i++) {
          v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
          out.push('vn ' + expNum(v.x) + ' ' + expNum(v.y) + ' ' + expNum(v.z));
        }
      }
      var seq = g.index ? g.index.array : null;
      var count = seq ? seq.length : pos.count;
      function faceRange(start, end, mi) {
        if (opt.usemtl) out.push('usemtl slot_' + (mi || 0));
        for (var f = start; f + 2 < end; f += 3) {
          var face = [];
          for (var k = 0; k < 3; k++) {
            var b = f + k;
            var vi = (seq ? seq[b] : b) + vBase;
            var ti = (seq ? seq[b] : b) + tBase;
            var ni = (seq ? seq[b] : b) + nBase;
            face.push(uv && nor ? (vi + '/' + ti + '/' + ni) : uv ? (vi + '/' + ti) : nor ? (vi + '//' + ni) : String(vi));
          }
          out.push('f ' + face.join(' '));
        }
      }
      var groups = g.groups || [];
      if (groups.length) {
        for (var gi = 0; gi < groups.length; gi++) {
          var gr = groups[gi];
          faceRange(gr.start, Math.min(gr.start + gr.count, count), gr.materialIndex || 0);
        }
      } else {
        faceRange(0, count, 0);
      }
      vBase += pos.count;
      if (uv) tBase += uv.count;
      if (nor) nBase += nor.count;
    });
    return out.join('\n') + '\n';
  }

  /* MTL：一个材质槽一条 newmtl，有贴图的槽用相对路径 textures/tex_<槽>.png。
   * Kd 用槽颜色（贴图缺失时外部查看器仍能看到正确底色）。 */
  function exportMTLText(hasTex) {
    var mats = (st.doc && st.doc.materials) || {};
    var names = mats.slotNames || [], colors = mats.slotColors || [];
    var n = Math.max(names.length, colors.length, hasTex.length, 1);
    var out = ['# modeldesk MTL export'];
    for (var i = 0; i < n; i++) {
      out.push('newmtl slot_' + i);
      var c = hexToRGB(colors[i] || '#c9ccd4');
      out.push('Ka 0 0 0');
      out.push('Kd ' + expNum(c[0]) + ' ' + expNum(c[1]) + ' ' + expNum(c[2]));
      out.push('Ks 0 0 0');
      out.push('d 1');
      out.push('illum 2');
      if (hasTex[i]) out.push('map_Kd textures/tex_' + i + '.png');
      out.push('');
    }
    return out.join('\n');
  }
  function hexToRGB(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    var n = m ? parseInt(m[1], 16) : 0xc9ccd4;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* ---------------- FBX（ASCII 7.4）----------------
   * three.js 没有 FBX 导出器，这里写一份最小的 ASCII FBX：几何 + 逐面材质 +
   * Texture/Video 节点指到压缩包里的 PNG。目标是 Blender / Maya / 3ds Max
   * 能直接打开；不写动画、骨骼、相机这些建模 App 不产出的东西。 */
  function exportFBXText(root, hasTex) {
    root.updateMatrixWorld(true);
    var mats = (st.doc && st.doc.materials) || {};
    var slotNames = mats.slotNames || [], slotColors = mats.slotColors || [];
    var nSlots = Math.max(slotNames.length, slotColors.length, hasTex.length, 1);
    var nextId = 1000000;
    var records = [];
    var v = new THREE.Vector3();
    var nm = new THREE.Matrix3();

    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.userData || o.userData.mdPart !== 'solid') return;
      var g = o.geometry, pos = g.attributes.position;
      if (!pos) return;
      var uv = g.attributes.uv, nor = g.attributes.normal;
      var seq = g.index ? g.index.array : null;
      var count = seq ? seq.length : pos.count;
      var polys = Math.floor(count / 3);
      if (!polys) return;
      var m = o.matrixWorld;
      nm.getNormalMatrix(m);
      var verts = [], pvi = [], normals = [], uvs = [], polyMat = [];
      for (var i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        verts.push(v.x, v.y, v.z);
      }
      var groups = g.groups || [];
      for (var p = 0; p < polys; p++) {
        var mi = 0;
        for (var gi = 0; gi < groups.length; gi++) {
          var gr = groups[gi];
          if (p * 3 >= gr.start && p * 3 < gr.start + gr.count) { mi = gr.materialIndex || 0; break; }
        }
        polyMat.push(mi);
        var ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0;
        for (var k = 0; k < 3; k++) {
          var b = p * 3 + k, idx = seq ? seq[b] : b;
          pvi.push(k === 2 ? -(idx + 1) : idx);
          if (uv) uvs.push(uv.getX(idx), uv.getY(idx));
          if (nor) {
            v.fromBufferAttribute(nor, idx).applyMatrix3(nm).normalize();
            normals.push(v.x, v.y, v.z);
          } else if (k === 0) { ax = verts[idx * 3]; ay = verts[idx * 3 + 1]; az = verts[idx * 3 + 2]; }
          else if (k === 1) { bx = verts[idx * 3]; by = verts[idx * 3 + 1]; bz = verts[idx * 3 + 2]; }
          else { cx = verts[idx * 3]; cy = verts[idx * 3 + 1]; cz = verts[idx * 3 + 2]; }
        }
        if (!nor) {
          var ux = bx - ax, uy = by - ay, uz = bz - az;
          var vx = cx - ax, vy = cy - ay, vz = cz - az;
          var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;
          for (var k2 = 0; k2 < 3; k2++) normals.push(nx, ny, nz);
        }
      }
      var mid = nextId++, gid = nextId++;
      records.push({
        name: fbxName(o.name || ('Mesh' + records.length)),
        mid: mid, gid: gid,
        verts: verts, pvi: pvi, normals: normals, uvs: uvs, polyMat: polyMat
      });
    });

    var matsOut = [], texsOut = [], vidsOut = [];
    for (var mi = 0; mi < nSlots; mi++) {
      var mid = nextId++;
      var c = hexToRGB(slotColors[mi] || '#c9ccd4');
      matsOut.push({ id: mid, name: fbxName(slotNames[mi] || ('slot_' + mi)), color: c });
      if (hasTex[mi]) {
        var tid = nextId++, vid = nextId++;
        var png = 'textures/tex_' + mi + '.png';
        texsOut.push({ id: tid, vid: vid, mat: mid, name: fbxName(slotNames[mi] || ('slot_' + mi)), file: png });
        vidsOut.push({ id: vid, name: fbxName(slotNames[mi] || ('slot_' + mi)), file: png });
      }
    }

    var out = [];
    out.push('; FBX 7.4.0 project file');
    out.push('; Generated by modeldesk');
    out.push('FBXHeaderExtension:  {');
    out.push('  FBXHeaderVersion: 1003');
    out.push('  FBXVersion: 7400');
    out.push('  Creator: "modeldesk"');
    out.push('}');
    out.push('GlobalSettings:  {');
    out.push('  Version: 1000');
    out.push('  Properties70:  {');
    out.push('    P: "UpAxis", "int", "Integer", "",1');
    out.push('    P: "UpAxisSign", "int", "Integer", "",1');
    out.push('    P: "FrontAxis", "int", "Integer", "",2');
    out.push('    P: "FrontAxisSign", "int", "Integer", "",1');
    out.push('    P: "CoordAxis", "int", "Integer", "",0');
    out.push('    P: "CoordAxisSign", "int", "Integer", "",1');
    out.push('    P: "UnitScaleFactor", "double", "Number", "",1');
    out.push('  }');
    out.push('}');
    out.push('Definitions:  {');
    out.push('  Version: 100');
    out.push('  Count: ' + (1 + records.length * 2 + matsOut.length + texsOut.length * 2));
    out.push('  ObjectType: "GlobalSettings" {');
    out.push('    Count: 1');
    out.push('  }');
    out.push('  ObjectType: "Model" {');
    out.push('    Count: ' + records.length);
    out.push('  }');
    out.push('  ObjectType: "Geometry" {');
    out.push('    Count: ' + records.length);
    out.push('  }');
    out.push('  ObjectType: "Material" {');
    out.push('    Count: ' + matsOut.length);
    out.push('  }');
    out.push('  ObjectType: "Texture" {');
    out.push('    Count: ' + texsOut.length);
    out.push('  }');
    out.push('  ObjectType: "Video" {');
    out.push('    Count: ' + vidsOut.length);
    out.push('  }');
    out.push('}');
    out.push('Objects:  {');
    records.forEach(function (r) {
      out.push('  Geometry: ' + r.gid + ', "Geometry::' + r.name + '", "Mesh" {');
      out.push('    GeometryVersion: 124');
      out.push('    Vertices: *' + r.verts.length + ' {');
      out.push('      a: ' + r.verts.map(expNum).join(','));
      out.push('    }');
      out.push('    PolygonVertexIndex: *' + r.pvi.length + ' {');
      out.push('      a: ' + r.pvi.join(','));
      out.push('    }');
      out.push('    LayerElementNormal: 0 {');
      out.push('      Version: 101');
      out.push('      Name: ""');
      out.push('      MappingInformationType: "ByPolygonVertex"');
      out.push('      ReferenceInformationType: "Direct"');
      out.push('      Normals: *' + r.normals.length + ' {');
      out.push('        a: ' + r.normals.map(expNum).join(','));
      out.push('      }');
      out.push('    }');
      if (r.uvs.length) {
        out.push('    LayerElementUV: 0 {');
        out.push('      Version: 101');
        out.push('      Name: "UVMap"');
        out.push('      MappingInformationType: "ByPolygonVertex"');
        out.push('      ReferenceInformationType: "Direct"');
        out.push('      UV: *' + r.uvs.length + ' {');
        out.push('        a: ' + r.uvs.map(expNum).join(','));
        out.push('      }');
        out.push('    }');
      }
      out.push('    LayerElementMaterial: 0 {');
      out.push('      Version: 101');
      out.push('      Name: ""');
      out.push('      MappingInformationType: "ByPolygon"');
      out.push('      ReferenceInformationType: "IndexToDirect"');
      out.push('      Materials: *' + r.polyMat.length + ' {');
      out.push('        a: ' + r.polyMat.join(','));
      out.push('      }');
      out.push('    }');
      out.push('    Layer: 0 {');
      out.push('      Version: 100');
      out.push('      LayerElement:  {');
      out.push('        Type: "LayerElementNormal"');
      out.push('        TypedIndex: 0');
      out.push('      }');
      if (r.uvs.length) {
        out.push('      LayerElement:  {');
        out.push('        Type: "LayerElementUV"');
        out.push('        TypedIndex: 0');
        out.push('      }');
      }
      out.push('      LayerElement:  {');
      out.push('        Type: "LayerElementMaterial"');
      out.push('        TypedIndex: 0');
      out.push('      }');
      out.push('    }');
      out.push('  }');
      out.push('  Model: ' + r.mid + ', "Model::' + r.name + '", "Mesh" {');
      out.push('    Version: 232');
      out.push('    Properties70:  {');
      out.push('      P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0');
      out.push('      P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0');
      out.push('      P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1');
      out.push('      P: "Visibility", "Visibility", "", "A",1');
      out.push('    }');
      out.push('    Shading: true');
      out.push('    Culling: "CullingOff"');
      out.push('  }');
    });
    matsOut.forEach(function (mt) {
      out.push('  Material: ' + mt.id + ', "Material::' + mt.name + '", "" {');
      out.push('    Version: 102');
      out.push('    ShadingModel: "phong"');
      out.push('    MultiLayer: 0');
      out.push('    Properties70:  {');
      out.push('      P: "DiffuseColor", "Color", "", "A",' + expNum(mt.color[0]) + ',' + expNum(mt.color[1]) + ',' + expNum(mt.color[2]));
      out.push('      P: "DiffuseFactor", "Number", "", "A",1');
      out.push('      P: "SpecularColor", "Color", "", "A",0,0,0');
      out.push('      P: "Shininess", "Number", "", "A",20');
      out.push('      P: "Opacity", "Number", "", "A",1');
      out.push('    }');
      out.push('  }');
    });
    texsOut.forEach(function (t) {
      out.push('  Texture: ' + t.id + ', "Texture::' + t.name + '", "" {');
      out.push('    Type: "TextureVideoClip"');
      out.push('    Version: 202');
      out.push('    TextureName: "Texture::' + t.name + '"');
      out.push('    Media: "Video::' + t.name + '"');
      out.push('    FileName: "' + t.file + '"');
      out.push('    RelativeFilename: "' + t.file + '"');
      out.push('    ModelUVTranslation: 0,0');
      out.push('    ModelUVScaling: 1,1');
      out.push('    Texture_Alpha_Source: "None"');
      out.push('    Cropping: 0,0,0,0');
      out.push('  }');
    });
    vidsOut.forEach(function (vv) {
      out.push('  Video: ' + vv.id + ', "Video::' + vv.name + '", "Clip" {');
      out.push('    Type: "Clip"');
      out.push('    Version: 202');
      out.push('    UseMipMap: 0');
      out.push('    Filename: "' + vv.file + '"');
      out.push('    RelativeFilename: "' + vv.file + '"');
      out.push('  }');
    });
    out.push('}');
    out.push('Connections:  {');
    records.forEach(function (r) {
      out.push('  C: "OO",' + r.mid + ',0');
      out.push('  C: "OO",' + r.gid + ',' + r.mid);
    });
    matsOut.forEach(function (mt) {
      records.forEach(function (r) {
        if (r.polyMat.indexOf(matsOut.indexOf(mt)) < 0) return;
        out.push('  C: "OO",' + mt.id + ',' + r.mid);
      });
    });
    texsOut.forEach(function (t) {
      out.push('  C: "OP",' + t.id + ',' + t.mat + ', "DiffuseColor"');
      out.push('  C: "OO",' + t.vid + ',' + t.id);
    });
    out.push('}');
    return out.join('\n') + '\n';
  }
  function fbxName(s) {
    return String(s == null ? '' : s).replace(/[\r\n"]/g, ' ').trim() || 'Object';
  }

  /* ---------------- 压缩包 ----------------
   * fflate 已在 index.html 里加载（vendor/fflate.js）。level 6 对文本有效，
   * PNG 本身已压缩，不会再变大多少。 */
  function textBytes(s) { return new TextEncoder().encode(String(s)); }
  function dataURLBytes(url) {
    var b64 = String(url || '').split(',')[1] || '';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToDataURL(bytes, mime) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }
  function exportTextureFiles() {
    var files = [], has = [];
    for (var i = 0; i < GLB_MAPS.length; i++) {
      var tex = GLB_MAPS[i];
      var cv = tex && tex.image;
      if (!cv || typeof cv.toDataURL !== 'function') { has.push(false); continue; }
      try {
        files.push({ name: 'textures/tex_' + i + '.png', bytes: dataURLBytes(cv.toDataURL('image/png')) });
        has.push(true);
      } catch (e) { has.push(false); }
    }
    return { files: files, has: has };
  }
  function makeZip(files) {
    var F = global.fflate;
    if (!F || typeof F.zipSync !== 'function') throw new Error('fflate 未加载（vendor/fflate.js）');
    var input = {};
    files.forEach(function (f) { input[f.name] = f.bytes; });
    return F.zipSync(input, { level: 6 });
  }
  /* STL 专用：把每个面拆成世界坐标三角形，统一算法线 */
  function eachExportTriangle(root, cb) {
    root.updateMatrixWorld(true);
    var v = new THREE.Vector3();
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.userData || o.userData.mdPart !== 'solid') return;
      var g = o.geometry, pos = g.attributes.position;
      if (!pos) return;
      var m = o.matrixWorld, idx = g.index, seq = idx ? idx.array : null;
      var count = seq ? seq.length : pos.count;
      for (var i = 0; i + 2 < count; i += 3) {
        var tri = [];
        for (var k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, seq ? seq[i + k] : (i + k)).applyMatrix4(m);
          tri.push([v.x, v.y, v.z]);
        }
        cb(tri, o);
      }
    });
  }
  function exportSTLText(root) {
    var name = String((st.doc && st.doc.name) || 'model').replace(/\s+/g, '_');
    var out = ['solid ' + name];
    eachExportTriangle(root, function (t) {
      var ax = t[1][0] - t[0][0], ay = t[1][1] - t[0][1], az = t[1][2] - t[0][2];
      var bx = t[2][0] - t[0][0], by = t[2][1] - t[0][1], bz = t[2][2] - t[0][2];
      var nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      out.push('facet normal ' + expNum(nx / len) + ' ' + expNum(ny / len) + ' ' + expNum(nz / len));
      out.push('  outer loop');
      for (var k = 0; k < 3; k++) {
        out.push('    vertex ' + expNum(t[k][0]) + ' ' + expNum(t[k][1]) + ' ' + expNum(t[k][2]));
      }
      out.push('  endloop');
      out.push('endfacet');
    });
    out.push('endsolid ' + name);
    return out.join('\n') + '\n';
  }
  function exportGLTFText(root) {
    if (!THREE.GLTFExporter) return Promise.reject(new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）'));
    root.updateMatrixWorld(true);
    return new Promise(function (res, rej) {
      new THREE.GLTFExporter().parse(root, function (g) {
        res(JSON.stringify(g, null, 2));
      }, rej, { binary: false, onlyVisible: true });
    });
  }
  /* 按格式产出导出数据。GLB 返回 ArrayBuffer，其余返回文本；
   * 压缩包返回 Uint8Array（bytes）与文件名清单（files，探针 / 调试用）。
   * 贴图准备与 save() 共用 prepareExportMaps（导出专用、同步有像素的贴图）。 */
  async function buildExportData(format, baseName) {
    if (!st.doc) throw new Error('还没有文档');
    format = EXPORT_FORMATS[format] ? format : 'glb';
    /* 导出前自动烘焙：OBJ/FBX 包也要拿到图层叠加后的最终贴图 */
    if (MIX && MIX.bakeForSave) {
      try { await MIX.bakeForSave(); } catch (e) { /* 单槽失败不阻断导出 */ }
    }
    var owns = !GLB_MAPS;
    if (owns) GLB_MAPS = await prepareExportMaps();
    var root = buildExportRoot();
    var base = String(baseName || (st.doc && st.doc.name) || 'model')
      .replace(/[\\/:*?"<>|]/g, '_').trim() || 'model';
    try {
      if (format === 'obj') return { text: exportOBJText(root), mime: EXPORT_FORMATS.obj.mime };
      if (format === 'stl') return { text: exportSTLText(root), mime: EXPORT_FORMATS.stl.mime };
      if (format === 'gltf') return { text: await exportGLTFText(root), mime: EXPORT_FORMATS.gltf.mime };
      if (format === 'objz') {
        var ot = exportTextureFiles();
        var objText = exportOBJText(root, { mtllibName: base + '.mtl', usemtl: true });
        var mtlText = exportMTLText(ot.has);
        var objFiles = [{ name: base + '.obj', bytes: textBytes(objText) },
          { name: base + '.mtl', bytes: textBytes(mtlText) }].concat(ot.files);
        return {
          bytes: makeZip(objFiles), mime: EXPORT_FORMATS.objz.mime,
          files: objFiles.map(function (f) { return f.name; }),
          texts: { obj: objText, mtl: mtlText }
        };
      }
      if (format === 'fbxz') {
        var ft = exportTextureFiles();
        var fbxText = exportFBXText(root, ft.has);
        var fbxFiles = [{ name: base + '.fbx', bytes: textBytes(fbxText) }].concat(ft.files);
        return {
          bytes: makeZip(fbxFiles), mime: EXPORT_FORMATS.fbxz.mime,
          files: fbxFiles.map(function (f) { return f.name; }),
          texts: { fbx: fbxText }
        };
      }
      return { buffer: await exportGLB(root), mime: EXPORT_FORMATS.glb.mime };
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
  /* 文本 → data URL（桌面主进程按同一个 data URL 直接落盘） */
  function textToDataURL(text, mime) {
    var bytes = new TextEncoder().encode(String(text));
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }
  function openExportDialog() {
    if (!st.doc) { setStatus('还没有文档', true); return false; }
    st.expFmt = EXPORT_FORMATS[st.expFmt] ? st.expFmt : 'glb';
    var tabs = Object.keys(EXPORT_FORMATS).map(function (k) {
      return '<button type="button" class="md-prim-tab' + (k === st.expFmt ? ' on' : '') +
        '" data-md-exp-fmt="' + k + '">' + EXPORT_FORMATS[k].label + '</button>';
    }).join('');
    overlayShow([
      '<div class="md-ov-head"><b>导出到电脑</b>',
      '<span class="md-ov-sub">GLB / GLTF / OBJ / STL · 或 OBJ / FBX 压缩包（模型 + 贴图）</span>',
      '<button type="button" class="md-ov-x" data-md-act="close-overlay">×</button></div>',
      '<div class="md-ov-body"><div class="md-prim">',
      '<div class="md-prim-tabs">' + tabs + '</div>',
      '<label class="md-pf"><span>文件名（可重名；桌面端同名会自动加序号）</span>' +
      '<input id="mdExpName" type="text" value="' + esc(st.doc.name || 'model') + '"></label>',
      '<button type="button" class="md-wide md-prim-go" data-md-act="export-go">导出到电脑</button>',
      '<div class="md-note" id="mdExpDesc">' + esc(EXPORT_FORMATS[st.expFmt].desc) +
      '<br><b>GLB / GLTF</b> 带内嵌材质贴图；<b>OBJ 包 / FBX 包</b> 把模型和 textures/ 里的 PNG 一起打包，解压后直接打开模型文件；<b>OBJ / STL</b> 单文件只写几何。网页版会走浏览器下载。</div>',
      '</div></div>'
    ].join(''), 'export');
    return true;
  }
  async function runExport() {
    if (!st.doc || st.busy) return { ok: false, error: '正在导出中' };
    var fmt = EXPORT_FORMATS[st.expFmt] ? st.expFmt : 'glb';
    var meta = EXPORT_FORMATS[fmt];
    var nameEl = $('mdExpName');
    /* 允许重名：只做文件系统非法字符清洗，不做唯一性校验 */
    var name = String((nameEl && nameEl.value) || st.doc.name || 'model')
      .replace(/[\\/:*?"<>|]/g, '_').trim() || 'model';
    if (new RegExp('\\.' + meta.ext + '$', 'i').test(name)) name = name.slice(0, -(meta.ext.length + 1));
    st.busy = true;
    setStatus('正在导出 ' + meta.label + '…');
    try {
      var restoreTex = glbTexSwap();
      var data, docJson;
      try {
        data = await buildExportData(fmt, name);
      } finally { restoreTex(); }
      docJson = data.buffer ? exportDocJson(data.buffer) : null;
      var dataURL;
      if (data.buffer) {
        /* GLB 自带 seedModel，重新导回本 App 时能恢复可编辑网格与材质槽 */
        var withExtras = SeedGLB.injectSeedModel(data.buffer, docJson);
        dataURL = SeedGLB.toDataURL(withExtras);
      } else if (data.bytes) {
        dataURL = bytesToDataURL(data.bytes, data.mime);
      } else {
        dataURL = textToDataURL(data.text, data.mime);
      }
      var d = global.openagiDesktop;
      if (!d || typeof d.fileSave !== 'function') {
        Model3D.saveDataURL(name + '.' + meta.ext, dataURL);
        setStatus('网页版没有磁盘写入权限，已改为下载 ' + meta.label);
        return { ok: true, downloaded: true };
      }
      var r = await d.fileSave({ name: name, ext: meta.ext, dataURL: dataURL });
      if (r && r.cancelled) { setStatus('已取消导出'); return { ok: false, cancelled: true }; }
      if (!(r && r.ok)) throw new Error((r && r.message) || '写入失败');
      setStatus('已导出到电脑：' + r.path);
      closeOverlay();
      return { ok: true, path: r.path, bytes: r.bytes };
    } catch (e) {
      var msg = (e && e.message) || String(e);
      setStatus('导出失败：' + msg, true);
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
    /* 关面板 = 宿主退场，属性面板里的控制器重新成为唯一编辑入口。
     * 重画一次右栏，把「正在大面板里编辑」那句换回真正的控件。 */
    var hadHost = !!st.comp.host;
    st.comp.host = '';
    if (st.texOpen) {
      try { Model3D.closePreview(); } catch (e) {}
      st.texOpen = false;
    }
    if (st.overlay) {
      st.overlay.className = 'md-overlay';
      st.overlay.innerHTML = '';
    }
    if (hadHost) paintParams();
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
    /* slotMaps 的读写统一走仓储：投射的兜底 / 固化 / 采纳底图都不自己拼数组 */
    slotMap: STORE.slotMap, setSlotMap: STORE.setSlotMap,
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
    /* 导出到电脑：对话框 + 各格式的原始数据（探针只取数据，不真写盘） */
    openExport: openExportDialog,
    exportPayload: buildExportData,
    runExport: runExport,
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
    /* 性能基准 / 探针用：外部改了 `openagi_model_tex_v1` 之后，按新配置重解码并合成。
     * 返回 Promise（层解码是异步的），调用方等它 resolve 再测帧时。 */
    mixRefresh: function (slot) {
      return MIX ? MIX.refreshSlot(slot | 0, true) : Promise.resolve(0);
    },
    /* 性能基准：混合模块的整图合成次数（增量合成不计） */
    mixStats: function () { return MIX ? MIX.stats() : null; },
    /* M5：基础体面板（菜单 / Shelf / 测试都从这里进） */
    openPrimitive: openPrimitiveDialog,
    createPrimitive: createPrimitive,
    /* 视图预设（iso / front / side / top …）：探针要「正面一张、侧面一张」才比得了几何。
     * 页面自己走 ViewCube 和视口下拉，不需要这个口子。 */
    viewPreset: viewFromPreset,
    /* 添加组件：面板入口 + 直接添加 + 目录 / 当前参数。
     * 组件源在 window.MDComponents（js/md-lumen-bridge.js 注册 = 流明头模的桥），
     * 这里只转发，不认识具体零件，也不认识流明。 */
    openComponent: openComponentDialog,
    addComponent: addComponent,
    componentCatalog: function () {
      return componentDefs().map(function (c) {
        return {
          id: c.id,
          name: c.name,
          presets: (c.presets || []).map(function (x) { return x.id; }),
          fields: componentFields(c).map(function (x) {
            return { key: x.key, type: x.type || 'range', options: x.options ? x.options.length : 0 };
          }),
          async: !!c.async,
          ready: c.ready ? !!c.ready() : true,
          /* panel / applyTo / props 说明它是不是「特殊组件」：
           * 有自己的面板、能改已有对象、有自己那套属性 */
          panel: typeof c.panel === 'function',
          applyTo: typeof c.applyTo === 'function',
          props: typeof c.props === 'function',
          surface: typeof c.surface === 'function',
          info: c.info ? c.info() : null
        };
      });
    },
    componentState: function () {
      return {
        kind: st.comp.kind,
        preset: st.comp.preset,
        target: st.comp.target || '',
        editing: !!componentEditNode(),
        params: st.comp.params ? JSON.parse(JSON.stringify(st.comp.params)) : null
      };
    },
    setComponentPreset: setComponentPreset,
    setComponentParam: setComponentParam,
    /* B2b：大纲点行 = 换激活对象（与视口跨对象点选同一条路） */
    selectNodeById: selectNodeById,
    /* 批量对象选择（how: replace / add / toggle / remove）与三支选择命令 */
    applyNodeSelection: applyNodeSelection,
    selectAll: selectAll,
    invertSelection: invertSelection,
    clearSelection: clearSelection,
    closeOverlay: closeOverlay,
    getDocument: function () { return st.doc; },
    /* 只读：节点对应的 three 对象（那颗 solid 子网格）。
     * 有它才能验证「运行时到底改了渲染副本的哪个属性」—— 形态键看 influences、
     * 眼神偏移看 uv。没有这个口的话，探针只能靠截图猜，而截图没法断言数值。 */
    nodeObject: function (nodeId) { return morphObjectOf(nodeId); },
    /* 形态键（只读资产）：列出名字 / 权重 / 顶点数，供面板与探针用。
     * 只从激活节点的网格读 —— 形态键不跨对象。 */
    morphs: function (nodeId) {
      /* nodeId 可选：不传就是激活对象（页面自己的用法），传了就能读任意节点。
       * 多对象各自眨眼必须能分别读 —— 只测激活对象会漏掉「后台那个头根本不动」。 */
      var id = nodeId || (st.node && st.node.id);
      var mesh = meshOfNode(id);
      if (!mesh || !mesh.morphs || !mesh.morphs.length) return null;
      var obj = morphObjectOf(id);
      return {
        count: mesh.morphs.length,
        vertexCount: mesh.positions.length / 3,
        /* three 真的挂上了才算「能渲染」：几何里有 delta、对象上没有 influences，
         * 屏幕上什么都不会变（这正是这一版最容易出现的假成功） */
        live: !!(obj && obj.morphTargetInfluences && obj.morphTargetInfluences.length === mesh.morphs.length),
        items: mesh.morphs.map(function (m, i) {
          return {
            index: i,
            name: m.name,
            weight: Number(m.weight) || 0,
            influence: obj && obj.morphTargetInfluences ? Number(obj.morphTargetInfluences[i]) || 0 : null
          };
        })
      };
    },
    /* 写权重：只改数组，不重建几何。返回真正写进 three 的个数。 */
    setMorphWeight: function (index, weight) {
      var mesh = st.mesh;
      if (!mesh || !mesh.morphs || !mesh.morphs[index]) return 0;
      mesh.morphs[index].weight = clamp01(weight);
      return syncMorphWeights();
    },
    setMorphWeights: function (list) {
      var mesh = st.mesh;
      if (!mesh || !mesh.morphs || !mesh.morphs.length) return 0;
      var data = Array.isArray(list) ? list : [];
      for (var i = 0; i < mesh.morphs.length; i++) {
        if (data[i] != null) mesh.morphs[i].weight = clamp01(data[i]);
      }
      return syncMorphWeights();
    },
    clearMorphs: function () {
      var mesh = st.mesh;
      if (!mesh || !mesh.morphs) return 0;
      for (var i = 0; i < mesh.morphs.length; i++) mesh.morphs[i].weight = 0;
      return syncMorphWeights();
    },
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
        wireframe: vfOn('wireframe'),
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
        /* 视口条下拉：照明预设 / 显示开关 / 面板显隐 / 大纲与工具架页签 */
        lightingPreset: st.lightingPreset,
        lightIntensity: (st.lights || []).map(function (l) { return l.intensity; }),
        prefs: (function () {
          var p = st.prefs || prefs();
          return { toneMapping: p.toneMapping, exposure: p.exposure };
        })(),
        outlineTab: st.outlineTab,
        shelfTab: st.shelfTab,
        panels: { outline: !!st.panels.outline, right: !!st.panels.right, shelf: !!st.panels.shelf, dock: !!st.dockOpen },
        texOpen: !!st.texOpen,
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
        /* 稳定面 ID（探针按它反查 UV 岛，验证整岛填充的落点） */
        selFaceIds: st.sel.faceIds.slice(),
        selHighlight: !!(st.selGroup && st.selGroup.children.length),
        /* 对象多选：集合 / 激活对象 / 视口包围盒高亮条数（探针按它断言多选高亮） */
        nodeIds: (st.nodeIds || []).slice(),
        objSelCount: (st.nodeIds || []).length,
        objSelHighlight: !!(st.objSelGroup && st.objSelGroup.length),
        hoverPick: st.hoverPick ? (st.hoverPick.kind + ':' + st.hoverPick.id) : '',
        /* 当前模式的高亮色（探针按它断言 UV 岛与面用不同颜色） */
        selColor: '#' + (SEL_COLOR[st.selMode] || 0).toString(16).padStart(6, '0'),
        soft: {
          on: !!st.soft.on, mode: st.soft.mode, falloff: st.soft.falloff,
          size: st.soft.size, custom: !!st.soft.custom, heatmap: !!st.soft.heatmap,
          info: { mode: st.softInfo.mode, radius: st.softInfo.radius, count: st.softInfo.count },
          heatLayer: !!(st.pivot && st.pivot.userData && st.pivot.userData.mdSoftLayer)
        },
        texKey: st.doc && st.doc.materials.textureConfigKey,
        slotNames: st.doc ? st.doc.materials.slotNames.slice() : [],
        slotIds: st.doc ? (st.doc.materials.slotIds || []).slice() : [],
        activeSlots: st.doc ? SeedModel.Scene.slotsOf(st.doc, st.node) : [],
        meshSlots: st.doc ? JSON.parse(JSON.stringify(st.doc.meshSlots || {})) : {},
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
        editor: st.editor,
        brush: st.paint.brush,
        brushShape: st.paint.shape,
        brushCustom: st.paint.customBrush ? st.paint.customBrush.name : '',
        brushSize: st.paint.size,
        brushColor: st.paint.color,
        brushOpacity: st.paint.opacity,
        paintSlot: st.paint.slot,
        paintUserSlot: st.paint.userSlot,
        paintSlotName: st.paint.slot >= 0 ? slotNameAt(st.paint.slot) : '',
        paintMask: st.paint.mask,
        paintTool: st.paint.tool,
        paintLockIsland: st.paint.lockIsland,
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
    /* 测试用：只导出当前文档，不落盘。opts.levelId = 只导出该关卡（单关导出）。 */
    exportBytes: async function (opts) {
      if (!st.doc) throw new Error('没有文档');
      EXPORT_LEVEL = (opts && opts.levelId) || null;
      try { return await currentGLB(); }
      finally { EXPORT_LEVEL = null; }
    },
    /* 测试用：单关导出全产物（GLB bytes + 按关裁剪后的 seedModel）。
     * exportLevelGLB 的保存走 fileSave 会弹框，探针从这里拿数据。 */
    exportLevelBytes: async function (levelId) {
      if (!st.doc) throw new Error('没有文档');
      return exportLevelBytesImpl(levelId);
    },
    /* 测试用：产出 OBJ/FBX 压缩包结构（不落盘，只回文件名与文本头） */
    exportPackage: async function (format, name) {
      if (!st.doc) throw new Error('没有文档');
      var restoreTex = glbTexSwap();
      try {
        var d = await buildExportData(format, name || st.doc.name || 'test');
        return {
          mime: d.mime, size: d.bytes ? d.bytes.length : 0,
          files: d.files || [], texts: d.texts || null,
          /* 探针解包用：zip 以 data URL 回传，避免把二进制塞进 JSON 数组 */
          zip: d.bytes ? bytesToDataURL(d.bytes, d.mime) : ''
        };
      } finally { restoreTex(); }
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
        extrudeGizmo: EXGZ.gizmo,
        uv: st.uv,
        mesh: st.mesh, doc: st.doc,
        /* 视口捏脸控制器：探针要按真实射线命中 / 读锚点屏幕坐标，
         * 而不是靠截图里「好像有个杆」判断 */
        ctrlLayer: st.ctrlLayer,
        /* 状态分区：view / edit / panel。st.doc 与 stateGroups.view.doc 是同一字段，
         * 探针用它守住「分区只是换归属、不复制值」这条约定。 */
        stateGroups: { view: st.view, edit: st.edit, panel: st.panel },
        store: STORE,
        /* 性能基准直接读这两项：上传字节数 / 合成次数不再靠估算 */
        paint: PAINT, upload: UPLOAD, paintState: st.paint, mix: MIX, renderStats: function () {
          var i = st.renderer && st.renderer.info;
          return { frame: i ? i.render.frame : 0, tris: i ? i.render.triangles : 0, calls: i ? i.render.calls : 0 };
        }
      };
    }
  };
})(window);
