/* 图像转 SVG —— 模型只看得到工具摘要，SVG 草稿留在本地。
 *
 * 摆在裸聊旁边，因为两者是同一条链路的两端：裸聊测「一句话能返回什么」，
 * 这里测「模型能不能靠工具把图还原成分层矢量」。
 *
 * ⚠ body 上有额外的 class `isvg-body`（别的 App 都是裸的 os-win-body）。
 *   那不是装饰：这块里画布要吃掉剩余高度、日志收成底部一条，
 *   布局规则全挂在 .isvg-body 上，漏了它整块就退回普通流式排布。
 */
(function () {
  'use strict';

  registerApp({
    id: 'img2svg',
    name: '图像转 SVG',
    title: '图像转 SVG',
    sub: '工具调用 + 本地分层草稿',
    glyph: 'i2s',
    order: 2,
    cls: 'isvg',
    win: 'img2svgWin',
    bodyCls: 'isvg-body',
    body: `
        <div class="isvg-meta" id="img2svgMeta"></div>
        <div class="isvg-src">
          <button type="button" class="btn sm" id="img2svgPick">选择图片</button>
          <img class="isvg-thumb hidden" id="img2svgThumb" alt="">
          <div class="isvg-srcinfo" id="img2svgSrcInfo">未选择图片（也可以把图拖进窗口）</div>
          <button type="button" class="btn sm isvg-clear hidden" id="img2svgClear">清除</button>
          <input type="file" id="img2svgFile" accept="image/*" hidden>
        </div>
        <!-- 画布与图层面板并排：横屏时画布吃满剩余高度，面板跟着变高；
             执行日志收成底部一条，不和画布抢纵向空间。 -->
        <div class="isvg-work">
          <!-- 实时画布：AI 每次写路径后立刻重绘，SVG 直接盖在原图上看「正在画什么」。
               状态条常驻左上角：阶段 / 轮次 / 当前工具 / 分数 / 用时。 -->
          <div class="isvg-stage" id="img2svgStage">
            <div class="isvg-stage-status">
              <span class="isvg-stage-badge idle" id="img2svgStageBadge">待开始</span>
              <span class="isvg-stage-round" id="img2svgStageRound">—</span>
              <span class="isvg-stage-tool" id="img2svgStageTool">选一张图，按 Send 开始</span>
              <span class="isvg-stage-score hidden" id="img2svgStageScore"></span>
              <span class="isvg-stage-time hidden" id="img2svgStageTime">00:00</span>
            </div>
            <div class="isvg-stage-stack">
              <img class="isvg-stage-src" id="img2svgStageSrc" alt="">
              <img class="isvg-stage-svg" id="img2svgStageSvg" alt="">
              <div class="isvg-stage-empty" id="img2svgStageEmpty">选一张图，按 Send 开始</div>
            </div>
          </div>
          <!-- 图层面板：四层可见性 / 隔离预览 / 每层统计 / 导出 / 消融。
               内容全部由 img2svg-app.js 的 refreshLayers 生成，这里只放骨架。 -->
          <aside class="isvg-layers" id="img2svgLayers">
            <div class="isvg-layers-head">
              <span class="isvg-layers-title">图层</span>
              <button type="button" class="isvg-layers-toggle" id="img2svgUndo"
                      disabled title="撤销上一次工具写入（每次调用一步）">撤销</button>
              <button type="button" class="isvg-layers-toggle" id="img2svgLayersToggle"
                      aria-pressed="false" title="收起 / 展开图层面板">收起</button>
            </div>
            <div class="isvg-layers-body" id="img2svgLayersBody"></div>
          </aside>
        </div>
        <div class="dchat-log isvg-log" id="img2svgLog"></div>
        <div class="bchat-bar" id="img2svgBar">
          <textarea class="bchat-text" id="img2svgText" rows="1" placeholder="描述要求（可留空），Enter 发送，Shift+Enter 换行"></textarea>
          <button type="button" class="dai-send" id="img2svgSend" title="发送（Enter）">Send</button>
        </div>`,
    open: function () {
      if (typeof window.img2svgApp !== 'undefined' && typeof window.img2svgApp.open === 'function') window.img2svgApp.open();
    }
  });
})();
