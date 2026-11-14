/* AI 搜索的窗口 DOM。
 *
 * 单独放 body.js 的原因：首页 + 结果页的结构比一个模板 App 长得多，
 * 塞进 app.js 会读不下去。app-scan 会自动把它排在 app.js 之前内联。
 *
 * 这里只有骨架，列表 / 摘要 / 来源全部由 app.js 填。
 * 不写内联样式与内联事件，样式见 app.css，行为见 app.js。 */
window.AIS_BODY = `
<div class="ais-root" data-mode="home">
  <header class="ais-head">
    <button type="button" class="ais-brand" data-act="home" title="回到首页">
      <span class="ais-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10.6" cy="10.6" r="6.6"/>
          <path d="m15.6 15.6 4.2 4.2"/>
          <path d="M7.9 10.6h5.4M10.6 7.9v5.4"/>
        </svg>
      </span>
      <span class="ais-word">智搜</span>
      <span class="ais-beta">AI</span>
    </button>

    <div class="ais-modes" role="tablist" aria-label="搜索模式">
      <button type="button" class="ais-mode is-on" data-mode="web" role="tab">网页</button>
      <button type="button" class="ais-mode" data-mode="media" role="tab">影视</button>
    </div>

    <form class="ais-form" autocomplete="off">
      <span class="ais-mag" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <circle cx="10.6" cy="10.6" r="6.4"/>
          <path d="m15.4 15.4 4.4 4.4"/>
        </svg>
      </span>
      <input class="ais-input" type="search" spellcheck="false" aria-label="搜索"
             placeholder="输入问题，AI 会去读原文再回答" />
      <button type="button" class="ais-clear hidden" data-act="clear" aria-label="清空">×</button>
      <button type="submit" class="ais-go">搜索</button>
    </form>

    <div class="ais-headtools">
      <span class="ais-net" data-act="net" title="联网检索与语言模型状态">
        <i class="ais-dot"></i><span class="ais-net-txt">联网</span>
      </span>
    </div>
  </header>

  <main class="ais-main">
    <section class="ais-hero">
      <div class="ais-hero-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10.6" cy="10.6" r="6.6"/>
          <path d="m15.6 15.6 4.2 4.2"/>
          <path d="M7.9 10.6h5.4M10.6 7.9v5.4"/>
        </svg>
      </div>
      <h1 class="ais-hero-h">智搜</h1>
      <p class="ais-hero-p">先读原文，再给答案。自动滤掉广告、下载站与搬运内容。</p>

      <form class="ais-hero-form" autocomplete="off">
        <span class="ais-mag" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <circle cx="10.6" cy="10.6" r="6.4"/>
            <path d="m15.4 15.4 4.4 4.4"/>
          </svg>
        </span>
        <input class="ais-hero-input" type="search" spellcheck="false" aria-label="搜索"
               placeholder="搜索任何问题，例如：DeepSeek 最新模型有什么变化" />
        <button type="submit" class="ais-hero-go">搜索</button>
      </form>

      <div class="ais-chips">
        <button type="button" class="ais-chip" data-q="DeepSeek 最新模型有什么变化">DeepSeek 最新模型</button>
        <button type="button" class="ais-chip" data-q="React 19 有哪些新特性">React 19 新特性</button>
        <button type="button" class="ais-chip" data-q="如何挑选适合自己的机械键盘">机械键盘怎么选</button>
        <button type="button" class="ais-chip" data-q="2026 年诺贝尔物理学奖">诺贝尔物理学奖</button>
      </div>

      <div class="ais-hero-foot">
        <span class="ais-feat"><i>1</i>只读网页正文，不加载广告脚本</span>
        <span class="ais-feat"><i>2</i>答案标注来源编号，可逐条核对</span>
        <span class="ais-feat"><i>3</i>广告 / 下载站 / 盗版资源自动过滤</span>
      </div>
      <p class="ais-hero-note">检索经本地中转（127.0.0.1:8787）转发；未启动时请在 设置 → 本地中转 中启动。</p>
    </section>

    <section class="ais-result hidden">
      <div class="ais-progress">
        <div class="ais-progress-row">
          <span class="ais-step" data-step="search"><i></i>检索网页</span>
          <span class="ais-arrow">›</span>
          <span class="ais-step" data-step="read"><i></i>精读正文</span>
          <span class="ais-arrow">›</span>
          <span class="ais-step" data-step="write"><i></i>生成摘要</span>
          <span class="ais-status" aria-live="polite"></span>
        </div>
        <div class="ais-bar"><span class="ais-bar-in"></span></div>
      </div>

      <div class="ais-grid">
        <div class="ais-col">
          <article class="ais-answer">
            <div class="ais-answer-head">
              <span class="ais-spark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3.6 13.8 9l5.4 1.8-5.4 1.8L12 18l-1.8-5.4L4.8 10.8 10.2 9 12 3.6Z"/>
                  <path d="M18.6 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>
                </svg>
              </span>
              <span class="ais-answer-title">AI 摘要</span>
              <span class="ais-answer-state"></span>
              <span class="ais-answer-tools">
                <button type="button" class="ais-mini" data-act="stop" hidden>停止</button>
                <button type="button" class="ais-mini" data-act="regen" hidden>重新生成</button>
                <button type="button" class="ais-mini" data-act="copy" hidden>复制</button>
              </span>
            </div>
            <div class="ais-answer-body" data-empty="1">
              <div class="ais-answer-idle">输入问题后，这里会先显示 AI 读完原文的结论。</div>
            </div>
            <div class="ais-answer-foot"></div>
          </article>

          <details class="ais-trace hidden">
            <summary class="ais-trace-head">
              <span class="ais-trace-cap">检索思路</span>
              <span class="ais-trace-brief"></span>
            </summary>
            <ol class="ais-trace-list"></ol>
            <p class="ais-trace-note">每轮先判断结果是否真的回答了问题；不相关就换检索式、换检索源，或顺着已读页面的链接继续找。</p>
          </details>

          <div class="ais-plats hidden">
            <div class="ais-plats-h">
              <span>官方平台直达</span>
              <span class="ais-plats-sub">点开即站内搜索，不经过聚合站</span>
            </div>
            <div class="ais-plats-grid"></div>
            <p class="ais-plats-note">仅收录官方视频平台与公共版权库；非官方来源单独列出，网页在受保护的浏览器中打开。部分平台有地区限制。</p>
          </div>

          <div class="ais-listhead">
            <span class="ais-listtitle">网页结果</span>
            <span class="ais-filtered"></span>
            <span class="ais-listtools">
              <button type="button" class="ais-mini" data-act="deepen" hidden>进一步搜索</button>
              <button type="button" class="ais-mini" data-act="fold" hidden>收起</button>
            </span>
          </div>
          <div class="ais-list"></div>

          <section class="ais-extra hidden">
            <div class="ais-extra-h">
              <span>非官方来源</span>
              <span class="ais-extra-sub">视频只给直链 · 网页走安全打开</span>
            </div>
            <div class="ais-extra-list"></div>
            <p class="ais-extra-note">非官方来源未经核实，请自行判断版权与风险；网页只能在受保护的内置浏览器中打开，磁力与网盘链接不收录。</p>
          </section>
        </div>

        <aside class="ais-side">
          <div class="ais-card">
            <div class="ais-card-h">
              <span>参考来源</span>
              <span class="ais-card-n"></span>
            </div>
            <div class="ais-sources">
              <div class="ais-side-idle">回答引用的网页会按编号列在这里。</div>
            </div>
          </div>

          <div class="ais-card ais-histcard hidden">
            <div class="ais-card-h">
              <span>最近搜索</span>
              <button type="button" class="ais-mini" data-act="clearhist">清空</button>
            </div>
            <div class="ais-hist"></div>
          </div>

          <div class="ais-card ais-tipcard">
            <div class="ais-card-h"><span>为什么更干净</span></div>
            <ul class="ais-tips">
              <li>只抓 HTML 正文，不执行页面脚本，弹窗与浮层进不来。</li>
              <li>广告域名、文库摘录页、下载/盗版站直接剔除。</li>
              <li>同站重复标题合并，官网与一手来源优先。</li>
            </ul>
          </div>
        </aside>
      </div>
    </section>
  </main>
</div>
`;
