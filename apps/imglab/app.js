/* 图像工坊 —— 对标 Photoshop 的多图层图像工作站。
 *
 * 图库负责收，它负责改：多图层、选区、滤镜和大尺寸瓦片渲染。
 * 和上一代只做快速修正的图片编辑器（#imgEditWin，那个是弹窗不是 App）分工不同。
 *
 * body 里只有 #psHost 一个宿主，界面与像素逻辑由 js/ps-app.js / ps-core.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'imglab',
    name: '图像工坊',
    title: '图像工坊',
    sub: '图层 · 选区 · 滤镜 · 瓦片大图',
    glyph: 'ps',
    order: 7,
    cls: 'imglab',
    win: 'imgLabWin',
    body: '<div class="ps-host" id="psHost"></div>',
    open: function () {
      if (typeof window.psLab !== 'undefined' && typeof window.psLab.open === 'function') window.psLab.open();
    }
  });
})();
