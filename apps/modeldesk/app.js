/* 建模 —— 网格资产工作站。摆在模型库旁边：一个是「造」，一个是「存」。
 *
 * MVP-1 用可编辑 face-vertex 网格；点线面工具随后续里程碑接入。
 * body 里只有 #modelDeskHost 一个宿主，整个三维工作台由 js/model-desk.js 铺开。
 *
 * ⚠ 这个 App 被切走时会主动 pause()（见 js/model-desk.js），这是它自己的生命周期决策，
 *   别在注册层替它改 —— 迁移只搬 DOM，不碰行为。
 */
(function () {
  'use strict';

  registerApp({
    id: 'modeldesk',
    name: '建模',
    title: '建模',
    sub: '网格资产工作站 · 变换 · 材质槽',
    glyph: 'modeler',
    order: 8,
    cls: 'modeldesk',
    win: 'modelDeskWin',
    body: '<div id="modelDeskHost" class="md-host"></div>',
    open: function () {
      if (typeof window.modelDesk !== 'undefined' && typeof window.modelDesk.open === 'function') window.modelDesk.open();
    }
  });
})();
