/* 名片 —— 「我是谁」这件事在桌面上有个正经去处。
 *
 * 内容全部由 js/dev-card.js 的 CD 常量渲染，改文案只改那一处；
 * 这里只有骨架（头图、几块 section、右侧赞赏码 / 群 / 链接）。
 *
 * 一张图兜底一处：头像和两张二维码都带 fb 占位（图没放时显示一块说明，
 * 而不是一个破图裂图标）——放图的位置写在 fb 文案里，用户自己就能补。
 */
(function () {
  'use strict';

  registerApp({
    id: 'card',
    name: '名片',
    title: '名片',
    sub: '作者与联系方式',
    glyph: 'card',
    order: 13,
    cls: 'card',
    win: 'cardWin',
    body: `
        <div class="cd-wrap">
          <div class="cd-main">
            <div class="cd-hero">
              <div class="cd-ava">
                <img id="cdAva" src="img/avatar.jpg" alt="虚幻茅场 的头像" draggable="false">
                <span class="cd-ava-fb" aria-hidden="true">虚</span>
              </div>
              <div class="cd-id">
                <div class="cd-name-row">
                  <h1 class="cd-name" id="cdName">虚幻茅场</h1>
                  <span class="cd-lv" id="cdLv">LV5</span>
                </div>
                <div class="cd-tag" id="cdTag"></div>
                <div class="cd-uid">
                  <span class="cd-uid-v" id="cdUid">UID 641892012</span>
                  <button type="button" class="cd-copy" id="cdCopyUid" data-copy="641892012" title="复制 UID">复制</button>
                </div>
              </div>
            </div>

            <div class="cd-stats" id="cdStats"></div>

            <section class="cd-sec">
              <h2 class="cd-h2">关于我</h2>
              <div class="cd-about" id="cdAbout"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">在做的四条线</h2>
              <div class="cd-tracks" id="cdTracks"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">合集与代表作<span class="cd-h2-note">右侧为该集播放量</span></h2>
              <div class="cd-works" id="cdWorks"></div>
            </section>
          </div>

          <aside class="cd-side">
            <div class="cd-pay">
              <div class="cd-pay-h" id="cdPayTitle">请我喝杯咖啡</div>
              <div class="cd-qr" id="cdQrBox">
                <img id="cdQr" src="img/pay-qr.png" alt="微信赞赏码" draggable="false">
                <div class="cd-qr-fb" id="cdQrFb">把赞赏码放到 img/pay-qr.png</div>
              </div>
              <div class="cd-pay-s" id="cdPayS">微信扫码赞赏 · 感谢每一份充电</div>
            </div>

            <!-- 技术交流群：和赞赏码是同一类动作（扫码 / 找号码），所以并排放在一起 -->
            <div class="cd-group">
              <div class="cd-group-h" id="cdGroupName">虚幻引擎蓝图笔记3群</div>
              <div class="cd-qr cd-qr-sm">
                <img id="cdGroupQr" src="img/qq-group.png" alt="技术交流群 QQ 二维码" draggable="false">
                <div class="cd-qr-fb" id="cdGroupFb">把 QQ 群二维码放到 img/qq-group.png</div>
              </div>
              <div class="cd-group-foot">
                <span class="cd-group-id" id="cdGroupId">群号 1108459704</span>
                <button type="button" class="cd-copy" id="cdCopyGroup" data-copy="1108459704" title="复制群号">复制</button>
              </div>
            </div>

            <div class="cd-links" id="cdLinks"></div>

            <div class="cd-foot" id="cdFoot"></div>
          </aside>
        </div>`,
    open: function () {
      if (typeof window.devCard !== 'undefined' && typeof window.devCard.open === 'function') window.devCard.open();
    }
  });
})();
