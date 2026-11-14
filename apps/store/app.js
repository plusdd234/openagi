/* 模型商店 —— 用 Ollama 的羊驼头做图标。
 *
 * 那张 png 是「本地模型」这件事的通用符号，比再画一个抽象图标更容易一眼认出来，
 * 所以这里用 icon（整段 HTML）而不是 glyph（内置 SVG 图形）。
 *
 * body 里的 #mcStore 是宿主节点，卡片由 js/model-store.js 渲染。
 */
(function () {
  'use strict';

  registerApp({
    id: 'store',
    name: '模型商店',
    title: '模型商店',
    sub: '本地模型 · 语音 · 一键安装',
    icon: '<img class="desk-app-img" src="vendor/ollama-llama.png" alt="" draggable="false">',
    order: 3,
    cls: 'store',
    win: 'storeWin',
    body: '<div class="mc-store" id="mcStore"></div>',
    open: function () {
      if (typeof openModelStore === 'function') openModelStore();
    }
  });
})();
