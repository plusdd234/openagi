/* 裸聊 —— 同一条链路的最小对照组。
 *
 * 它不带 system、不带上下文、不带历史，输入 token ≈ 你打的字。
 * 单独成 App 而不是给对话条加开关，就是为了「测出的差值干净」：
 * 混在主链路里会带上 IMG_SYS / contextText / 全量历史，差值就没意义了。
 * 界面里的气泡只是本地显示，从不回传（见 js/bare-chat.js）。
 *
 * 它的 open() **不调 deskMountApp** —— openDeskApp 已经翻页挂载过了，
 * 这里只负责聚焦输入框。
 */
(function () {
  'use strict';

  registerApp({
    id: 'bare',
    name: '裸聊',
    title: '裸聊',
    sub: '无 system / 无上下文 / 无历史',
    glyph: 'bare',
    order: 1,
    cls: 'bare',
    win: 'bareWin',
    body: `
        <div class="bchat-meta" id="bareMeta"></div>
        <div class="dchat-log" id="bareLog"></div>
        <div class="bchat-bar" id="bareBar">
          <textarea class="bchat-text" id="bareText" rows="1" placeholder="只发这一句，不带任何上下文…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="button" class="bchat-tplbtn" id="bareTplBtn" title="展开为 OpenAI 兼容的请求体（可编辑）">{ }</button>
          <button type="button" class="dai-send" id="bareSend" title="发送（Enter）">Send</button>
        </div>
        <!-- OpenAI 兼容模板：把这一句展开成可直接编辑的请求体。
             messages 里有什么就发什么，system 可自行加；model 可覆盖本次模型。 -->
        <div class="bchat-tpl hidden" id="bareTpl">
          <div class="bchat-tpl-head">
            <span>OpenAI 兼容请求体（可编辑后直接发送）</span>
            <button type="button" class="bchat-tpl-back" id="bareTplBack">收起</button>
          </div>
          <textarea class="bchat-tpl-text" id="bareTplText" spellcheck="false" wrap="off"></textarea>
          <div class="bchat-tpl-foot">
            <span class="bchat-tpl-note" id="bareTplNote">temperature 0.3 / stream true 由运行时固定</span>
            <button type="button" class="dai-send" id="bareTplSend">Send</button>
          </div>
        </div>`,
    open: function () {
      if (typeof window.bareChatApp !== 'undefined' && typeof window.bareChatApp.focus === 'function') window.bareChatApp.focus();
    }
  });
})();
