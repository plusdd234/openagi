/* 视图工坊 —— 模型多视图出图 / 深度遮罩 / 贴图回投。
 *
 * 它同时是**桌面 App** 和**独立工具页**（multiview.html，双击就能用、不需要桌面）。
 * 所以它的窗口 DOM 单独放在 apps/multiview/body.js 里，两边共用同一份 ——
 * 以前是两份拷贝（209 + 220 行、96 个 id），改一个控件要改两处。
 *
 * 窗口本身仍由 registerApp 生成（os-win-bar 在 App 页是隐藏的），
 * body 直接取 window.MV_BODY。tools/app-scan.js 会把 body.js 先内联进 manifest，
 * 所以这里执行时它一定已经定义好了。
 */
(function () {
  'use strict';

  registerApp({
    id: 'multiview',
    name: '视图工坊',
    title: '视图工坊',
    sub: '多视图出图 · 深度遮罩 · 贴图回投',
    glyph: 'mv',
    order: 11,
    cls: 'mv',
    win: 'mvWin',
    body: window.MV_BODY,
    open: function () {
      if (typeof window.multiview !== 'undefined' && typeof window.multiview.open === 'function') window.multiview.open();
    }
  });
})();
