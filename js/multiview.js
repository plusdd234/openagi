/* ============================================================
 * 多视图 App · 入口（multiview.js）
 *
 * 把一个 3D 模型渲成一组**严格等比例**的视图组图。
 * 跟工作流里「3D 模型转四视图」节点的关系：节点是流水线里的一步，
 * 这个 App 是给人看和用的；两者共用同一个渲染核 Model3D.viewGrid。
 *
 * 模块拆分（加载顺序就是依赖顺序，两份壳里的 script 顺序必须一致）：
 *   mv-core.js         常量 + 纯函数（无 state、无 UI）
 *   mv-layers.js       图层定义 / 默认顺序 / 不透明度归一（纯数据）
 *   mv-state.js        FIELDS 参数表 + state + 存档 + renderOpts
 *   mv-models.js       模型来源（模型库 / 拖文件）
 *   mv-render.js       渲染调度 / 下载 / 导出 / 预览弹层 / 存图库
 *   mv-layer-panel.js  图层面板 + 每层属性面板
 *   mv-panels.js       模型列表 / 视图 chips / 信息条 / 导出条 / 舞台
 *   mv-bind.js         所有 DOM 事件绑定 + 控件回填
 *   multiview.js       本文件：只负责开关窗口与对外 API
 *
 * 四个设计取舍：
 *   ① 默认**正交**相机。多视图的全部意义是比例，透视会让各视图互相矛盾。
 *   ② 默认**纯色**面 + 线框（线框是独立开关，不占模式）。
 *   ③ 参数改动**自动重渲**（防抖 110ms）+ 串行执行。
 *   ④ 单格靠**裁剪整图**得到，不重新渲染。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('multiview.js 必须在 mv-core.js ~ mv-bind.js 之后加载');

  var state = MV.state;

  /* ---------- 打开 / 关闭 ---------- */

  async function open() {
    var win = MV.$('mvWin');
    if (!win) return false;
    /* 顺序很重要：applySet 先把存档灌进 state，bind 里的 syncInputs / seg 才有真值可用。
     * 反过来（旧写法）会让勾选框、滑杆显示**默认值**而渲染按存档值走——
     * 用户以为没勾上、图里却有线，是最难自查的一类不同步。 */
    MV.applySet(MV.loadSet());
    MV.bind();
    /* bind 有 bound 守卫，第二次 open 不会再跑，syncInputs 也就不会回填；
     * 这里每次都同步一遍：存档 → 控件显示，永远跟渲染用的 state 一致。 */
    MV.syncInputs();
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
    MV.paint();

    await MV.loadModels();
    MV.paint();
    if (typeof deskSkelHide === 'function') deskSkelHide();

    /* 没有当前模型时自动选第一个：进来就能看到东西，比一块空画布强 */
    if (!state.cur && state.models.length) MV.pickModel(state.models[0].id);
    else if (state.cur) MV.render();

    return true;
  }

  function close() {
    var win = MV.$('mvWin');
    if (!win) return;
    state.open = false;
    MV.cancelRenderTimer();
    if (window.Model3D && typeof Model3D.closePreview === 'function') {
      try { Model3D.closePreview(); } catch (e) {}
    }
    if (window.ModelSplit && typeof ModelSplit.close === 'function') ModelSplit.close();
    /* 走统一退场：× 和 << 都要经过它，否则窗口会被留在 App 页里一起隐藏，
     * 下次打开时 parentElement 还是 deskAppHost，位置就错了。 */
    if (typeof deskAppLeave === 'function' && win.parentElement && win.parentElement.id === 'deskAppHost') {
      deskAppLeave();
    } else {
      win.classList.add('hidden');
    }
  }

  /* 窗口关闭按钮由 mv-bind 绑定，它只认 MV.close；对外仍是 window.multiview.close */
  MV.close = close;

  window.multiview = {
    open: open,
    close: close,
    render: MV.render,
    state: state,
    /* 纯逻辑导出：测试直接调，不用碰 DOM */
    _pure: {
      autoCols: MV.autoCols, fmtMB: MV.fmtMB, viewName: MV.viewName, countLabel: MV.countLabel,
      exportLayout: MV.exportLayout, fmtN: MV.fmtN, depthThreshOf: MV.depthThreshOf, fmtPct: MV.fmtPct,
      normalizeLayerOrder: MV.normalizeLayerOrder
    },
    /* 参数表本身：测试要拿它校验「表里声明的控件 id 在两份壳里都存在」 */
    _fields: MV.FIELDS
  };
})();
