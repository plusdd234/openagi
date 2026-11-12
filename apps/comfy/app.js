/* 本地生图 —— ComfyUI 引擎。
 *
 * 单独成 App 而不是塞进模型控制台的小方块：它自带安装 / 启动 / 端口 / 网页界面，
 * 塞进控制台里用户既不知道点哪里也看不清状态。装生图模型前先把它跑起来是最自然的顺序。
 *
 * body 里的 #cfApp 是宿主节点，界面由 js/comfy-app.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'comfy',
    name: '本地生图',
    title: '本地生图',
    /* 标签要短（切换条上塞不下「本地生图 · ComfyUI」），窗口标题栏保留完整名字 */
    barTitle: '本地生图 · ComfyUI',
    sub: 'ComfyUI 引擎',
    glyph: 'comfy',
    order: 4,
    cls: 'comfy',
    win: 'comfyWin',
    body: '<div class="cf-app" id="cfApp"></div>',
    open: function () {
      if (typeof openComfyApp === 'function') openComfyApp();
    }
  });
})();
