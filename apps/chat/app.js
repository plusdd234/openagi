/* AI 对话 —— 和其他 App 一样双击图标翻到 App 页，不再是独立的「第二页」。
 *
 * 原来它有一套自己的翻页规则（.desk-wall.chat-open + .desk-page-2），
 * 返回按钮、动效、页头全和别的 App 对不上 —— 统一成 App 之后全都同一套。
 *
 * ⚠ 底部那条输入 (#deskAiWrap) **不在这个 body 里**。它由 desk-chat-send.js 创建，
 *   按「窗口归属」在桌面底部 ↔ 对话窗口底部之间搬运（监听 openagi:app-mounted /
 *   app-restored）。所以别把输入条写进这里，否则会出现两条。
 */
(function () {
  'use strict';

  registerApp({
    id: 'chat',
    name: 'AI 对话',
    title: 'AI 对话',
    sub: '问点什么，或让它画一张',
    glyph: 'chat',
    order: 0,
    cls: 'chat',
    win: 'chatWin',
    body: `
        <!-- 模型 / 上下文 / 生图来源：原来是第二页页头的一排角标。
             页头删掉后，这三个角标留在对话区顶部——视觉上仍是一眼可扫的信息条。 -->
        <div class="dchat-meta">
          <span class="dchat-model" id="deskChatModel"></span>
          <span class="dchat-ctx" id="deskChatCtx" title="当前对话上下文"></span>
          <span class="dchat-imgsrc" id="deskChatImg" title="当前生图来源（点一下去设置）"></span>
        </div>
        <div class="dchat-log" id="deskChatLog"></div>
        <!-- 把这一轮探索压成流程的入口。只在「跑通了且有可固化步骤」时出现，
             不做弹窗强推 —— 它是筛选器，不是广告位。 -->
        <div class="dchat-saveflow hidden" id="deskChatSaveFlow">
          <span class="dcsf-text" id="deskChatSaveFlowText"></span>
          <button type="button" class="btn sm" id="btnChatSaveFlow">存成流程</button>
          <button type="button" class="dcsf-x" id="btnChatSaveFlowX" aria-label="这次不存" title="这次不存">×</button>
        </div>
        <div class="dchat-foot" id="deskChatFoot"></div>`,
    open: function () {
      if (typeof window.deskChat !== 'undefined' && typeof window.deskChat.open === 'function') window.deskChat.open();
    }
  });
})();
