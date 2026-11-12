/*
 * st-own.map —— 建模 App 共享状态 `st` 的**域归属表**（唯一真源）
 *
 * 为什么需要这张表：
 *   `st` 是单 IIFE 里那块共享状态，现在 **98 个一级键**，没有任何所有权标注。
 *   谁用到谁往上塞 —— 于是出现了 32 个「某功能的私有临时状态」摊在一级
 *   （extrudeGizmo / extrudeDrag / extrudeHover 三件套、hbOpen / hbHover /
 *   hbZones / hbPanel 四件套、dockToken / dockLoading / dockErr 三件套…），
 *   还有 8 个键**定义块里根本没有**，是运行时第一处赋值挂上去的
 *   （toolSession / previewHost / toolsBooted…），读的时候 `undefined` 也照跑。
 *
 * 这张表不改变任何运行行为。它的作用是让两种事故**当场变红**：
 *   ① 有人往 `st` 塞一个没登记的键 → `tools/st-own.js` 报「未登记」
 *   ② 有人改了定义块（加键/删键）却没改这张表 → 报「与定义块不一致」
 *
 * 域（domain）就是以后切子对象的边界。别按字母切、别按行数切，
 * 按「这些键总是在一起被读写」切 —— 比如 quadMax / quadDown / quadClick
 * 三个永远只服务于四视图交互，它们就该一起走。
 *
 * `dyn: true` 的含义：**定义块里没有这个键**，它在运行期第一次赋值时才出现。
 * 守卫会双向核对（见 tools/st-own.js ③），所以 `dyn` 不是给人看的注释，是判据。
 *
 * 用法：node tools/st-own.js          （守卫，违规退出码 1）
 *       node tools/st-own.js --list   （按域打印现状）
 */
module.exports = {
  /* 域 → { title, keys }。顺序不代表优先级，只是阅读顺序。
   * 每个域以后的归宿：要么变成模块私有 state，要么变成 `st.<域>` 子对象。 */
  domains: {
    viewport: {
      title: '视口与渲染（宿主 DOM / 渲染器 / 相机 / 主循环）',
      keys: ['host', 'stage', 'canvas', 'overlay', 'statusEl', 'hudEl', 'renderer', 'scene',
        'camera', 'controls', 'running', 'raf', 'resizeObs', 'lights', 'edgeLines', 'vertPoints', 'navAlt']
    },
    doc: {
      title: '文档与当前对象（多对象 v2.1 的指针，不是真源）',
      keys: ['doc', 'node', 'mesh', 'pivot', 'selected', 'nodeIds', 'history',
        'editBefore', 'txBefore', 'pivots', 'autoName']
    },
    selection: {
      title: '选择与拾取态（S1）',
      keys: ['selMode', 'sel', 'selGroup', 'pickDown', 'noPick', 'isolate']
    },
    transform: {
      title: '变换与操纵器（模式 / 吸附 / 组件变换中间量）',
      keys: ['mode', 'space', 'snap', 'gizmo', 'compPivot', 'compIdx', 'compDrag', 'edgeRecs']
    },
    quad: {
      title: '四视图（V7）：每格一个控制器，只有激活那个 enable',
      keys: ['quad', 'quadCams', 'quadCtl', 'quadActive', 'quadMax', 'quadDown', 'quadClick', 'viewName']
    },
    view: {
      title: '显示与着色（平涂 / UV 岛着色 / 网格 / 大纲搜索）',
      keys: ['shading', 'showGrid', 'gridHelper', 'outlineQuery']
    },
    panels: {
      title: '面板 / 菜单 / 全局小状态（页签、浮层、忙锁、状态条计时器）',
      keys: ['rightTab', 'tbKind', 'menu', 'toolPanel', 'texOpen', 'prefs', 'uiReady', 'busy', 'statusTimer']
    },
    dock: {
      title: '内容浏览器（底部 dock）：token 用来作废旧请求',
      keys: ['dock', 'dockBody', 'dockOpen', 'dockLoading', 'dockAssets', 'dockErr', 'dockThumbs', 'dockToken']
    },
    tools: {
      title: '工具会话（M6a）+ 各工具的私有三件套 + 软选择 + 热盒',
      keys: ['toolSession', 'tool', 'gest', 'soft', 'softDrag', 'hbOpen', 'hbHover', 'hbZones',
        'hbPanel', 'pointer', 'uv', 'extrudeGizmo', 'extrudeDrag', 'extrudeHover'],
      /* ⚠ 这个域最该先拆：14 个键里 7 个是「某个工具的私有拖拽态」。
       * 每加一个工具就往这里长 3 个键，是当前最明确的增长热点。 */
      hot: true
    },
    cube: {
      title: 'ViewCube（拖拽 + 悬停 + 单击/双击判别）',
      keys: ['cube', 'cubeDrag', 'cubeClickTimer', 'cubeHover']
    },
    paint: { title: '绘画工作区（笔刷参数 + 工作副本 canvas）', keys: ['paint'] },
    prim: { title: '基础体面板（M5）', keys: ['prim'] },
    preview: {
      title: '工具预览替身（M6a 把真网格藏起来、临时画一份预览）',
      keys: ['previewHost', 'previewMesh', 'previewHiddenObjs']
    },
    iso: { title: '隔离显示（只影响视口，不写 node.visible）', keys: ['isoComp', 'isoFaceCount'] },
    misc: { title: '杂项（进了组件模式后回到物体模式用）', keys: ['lastCompMode', 'toolsBooted'] }
  },

  /* 定义块里没有、运行期才挂上去的键。守卫会核对：
   * 这里的键**必须**真的不在 `var st = {` 里；不在这里的键**必须**在定义块里。 */
  dynamic: ['toolSession', 'previewHost', 'previewMesh', 'previewHiddenObjs',
    'toolsBooted', 'isoComp', 'isoFaceCount', 'lastCompMode'],

  /* 建模 App 读 `st` 的文件。已抽出去的 7 个部件也是通过 ctx.st 读写同一份状态，
   * 所以它们必须一起扫 —— 只扫外壳会漏掉一半的写入方。 */
  files: ['js/model-desk.js', 'js/md-paint.js', 'js/md-isolate.js', 'js/md-history.js',
    'js/md-viewcube.js', 'js/md-objops.js', 'js/md-uv-editor.js', 'js/md-proj-bake.js',
    'js/md-texmix.js'],
  stateFile: 'js/model-desk.js'
};
