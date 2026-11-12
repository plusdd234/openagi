/* 模型 —— 引擎与 Provider 的控制台。
 *
 * 它和别的 App 有一处不同：`open()` 里**自己再调一次 deskMountApp**。
 * 这不是多余的 —— models 这个入口原来就绕过了 openDeskApp 的通用路径
 * （见 desk-shell.js 里那句 `deskMountApp($('modelsWin'), m.title, m.sub)`），
 * 因为它要保证「先切页面，再渲染控制台」，而 renderModelsConsole 会重画整棵树。
 * 迁移时原样保留这条，否则会出现「翻过去了但内容还是上一轮的状态」。
 *
 * 四个宿主节点：硬件 / 引擎 / ComfyUI / 模型种类。
 */
(function () {
  'use strict';

  registerApp({
    id: 'models',
    name: '模型',
    title: '模型',
    barTitle: '模型控制台',
    sub: '引擎与 Provider',
    glyph: 'model',
    order: 10,
    win: 'modelsWin',
    body:
      '<div class="mc-hard" id="mcHard"></div>' +
      '<div class="mc-eng" id="mcEng"></div>' +
      '<div class="mc-eng" id="mcComfy"></div>' +
      '<div class="mc-kinds" id="mcKinds"></div>',
    open: function (win) {
      /* 用传进来的 win，不再按 id 反查 —— 少一次 getElementById，也避免名字改了两处不一致 */
      deskMountApp(win, '模型', '引擎与 Provider');
      if (typeof renderModelsConsole === 'function') renderModelsConsole();
    }
  });
})();
