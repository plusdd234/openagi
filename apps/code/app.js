/* 编码 —— 工作台里唯一一个「改别处东西」的 App。
 *
 * 和别的 App 的根本区别是：它的作用对象在工作区里、不归应用所有，
 * 所以它的第一条设计约束是沙箱（见 electron/code-workspace.js），不是界面。
 *
 * 位置放名片之前：名片是收尾，不该有 App 排在它后面。
 * open() 返回 promise（等文件树真画出来），骨架会等它落定才撤。
 */
(function () {
  'use strict';

  registerApp({
    id: 'code',
    name: '编码',
    title: '编码',
    sub: '选定文件夹 · 浏览与改写代码',
    glyph: 'code',
    order: 12,
    cls: 'code',
    win: 'codeWin',
    body: '<div class="ca-app" id="codeApp"></div>',
    open: function () {
      if (typeof window.codeApp !== 'undefined' && typeof window.codeApp.open === 'function') return window.codeApp.open();
    }
  });
})();
