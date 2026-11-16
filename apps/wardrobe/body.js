/* 衣柜 App 的窗口 DOM（app-scan 会把它排在 app.js 之前内联）。
 *
 * 三栏：左边套装、中间皮套预览、右边部件清单。
 * 皮套来自 apps/live2d/model/，由 tools/pack-live2d.js 预打包；
 * 预览运行时在同目录 rig.js 里（window.WD_RIG）。
 */
window.WD_BODY = `
<div class="wd-app" id="wdApp">
  <header class="wd-top">
    <div class="wd-brand">
      <span class="wd-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 7.4V5.6a1.8 1.8 0 1 1 3.6 0"/>
          <path d="M12 7.4 3.6 13.1a1.5 1.5 0 0 0 .8 2.8h15.2a1.5 1.5 0 0 0 .8-2.8L12 7.4Z"/>
        </svg>
      </span>
      <div class="wd-brand-txt">
        <b>衣柜</b>
        <span>给数字人换皮套、挑部件、存套装</span>
      </div>
    </div>
    <div class="wd-tools">
      <label class="wd-model">
        <span>皮套</span>
        <select id="wdModelSel" aria-label="皮套"></select>
      </label>
      <button type="button" class="wd-btn primary" id="wdApplyHuman" title="把当前搭配同步到数字人">应用到数字人</button>
    </div>
  </header>

  <div class="wd-main">
    <aside class="wd-left">
      <div class="wd-pane-head">
        <h3>套装</h3>
        <span class="wd-pane-num" id="wdOutfitCount">0</span>
      </div>
      <div class="wd-new">
        <input type="text" id="wdOutfitName" maxlength="12" placeholder="套装名，如 校服" spellcheck="false">
        <button type="button" class="wd-btn" id="wdSaveOutfit">保存当前</button>
      </div>
      <div class="wd-outfits" id="wdOutfits"></div>
      <p class="wd-hint">套装 = 皮套 + 隐藏的部件。点卡片试穿，点「穿上」同步给数字人。</p>
    </aside>

    <section class="wd-stage" id="wdStage">
      <div class="wd-bg" aria-hidden="true">
        <i class="wd-glow g1"></i>
        <i class="wd-glow g2"></i>
        <i class="wd-dots"></i>
        <i class="wd-floor"></i>
      </div>

      <div class="wd-canvas" id="wdCanvas"></div>

      <div class="wd-state" id="wdLoading"><i></i><span>正在穿上皮套…</span></div>
      <div class="wd-state is-err" id="wdErr" hidden><b>皮套加载失败</b><span></span></div>

      <div class="wd-hud">
        <span class="wd-chip" id="wdChip">等待皮套…</span>
        <span class="wd-hud-gap"></span>
        <button type="button" class="wd-mini" id="wdShowAll">全部显示</button>
        <span class="wd-part-total" id="wdPartCount"></span>
      </div>

      <div class="wd-toast" id="wdToast" hidden></div>
    </section>

    <aside class="wd-right">
      <div class="wd-pane-head">
        <h3>部件</h3>
        <span class="wd-pane-num" id="wdHiddenCount">隐藏 0</span>
      </div>
      <div class="wd-search">
        <input type="text" id="wdSearch" placeholder="搜索部件名 / ID" spellcheck="false">
        <button type="button" class="wd-btn" id="wdReset" title="取消所有隐藏">重置</button>
      </div>
      <div class="wd-parts" id="wdParts"></div>
    </aside>
  </div>
</div>
`;
