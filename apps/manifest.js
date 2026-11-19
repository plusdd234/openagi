/* ============================================================
 * 自动生成，别手改 —— node tools/app-scan.js
 * App 清单：aisearch , arm101 , browser , card , chara , chat , code , comfy , gallery , hello , imglab , live2d , maildesk , modeldesk , models , multiview , player , store , studio , tunnel , visionlab , wardrobe
 *
 * 加一个 App = 建 apps/<id>/app.js（参考 apps/hello）+ 跑一次 app-scan。
 * index.html 与 desk-shell.js 都不用碰，所以多路 AI 并行时不会互相踩。
 * ============================================================ */
/* ---- apps/aisearch/body.js ---- */
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
      <button type="button" class="ais-assist is-on" data-act="assist" aria-pressed="true"
              title="AI 辅助脚本：开启（点击关闭）">
        <i></i><span>辅助脚本</span>
      </button>
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

/* ---- apps/aisearch/app.js ---- */
/* 智搜 —— AI 搜索 App
 *
 * 做的事：用户提一个问题 → 走 deskSearch 取回搜索结果 → 经本地中转抓取前几篇网页正文
 * → 剔除广告 / 下载站 / 搬运内容 → 交给语言模型生成带来源编号的摘要。
 *
 * 三条边界（和 AGENTS.md 一致）：
 * ① 整个文件包在 IIFE 里；② mount() 幂等，状态跟着窗口活着；③ 不碰 window.openagiDesktop，
 *    不读 localStorage 的 llmKey；模型调用只走 LLMRouter，检索只走 deskSearch / 本地中转。
 *
 * 为什么自己抓正文，而不是直接用搜索摘要：
 *   摘要里混着站点描述和推广文案，模型只读摘要会复述广告话术；正文才能核对事实。
 *   抓取失败不阻塞回答 —— 退化成「仅摘要」，并在来源里标出来，让用户知道哪条没读到。
 */
(function () {
  'use strict';

  var APP = 'aisearch';
  var LS_HIST = 'hf_aisearch_hist';
  var LS_ASSIST = 'hf_aisearch_assist';
  var MAX_SOURCES = 6;          // 最多精读几篇（并发 3，超出的留摘要）
  var SCAN_MAX = 120;           // 一轮最多筛读多少条候选（含边扫边扩出来的外链）
  var SCAN_BATCH = 10;          // 每 10 条压成一组交给模型判断
  var SCAN_CONCURRENCY = 4;     // 组内同时抓几页：一次 10 个并发会把本地中转和站点都打满
  var SCAN_DEADLINE = 45000;    // 扫描总时长上限：超时先用已选中的结果作答
  var PICK_TARGET = 16;         // 攒够这么多「值得读」就不再翻
  var MAX_RESULTS = 10;         // 候选池再大，最终只处理最有希望的 10 条
  var MAX_PAGE_TEXT = 5200;     // 单页正文上限，避免一次塞爆上下文
  var PROMPT_PER_SOURCE = 2600; // 送进模型的单页上限
  var PROMPT_EXTRA = 900;       // 精读补充：按新关键词再摘一段，避免只看开头
  var SKIM_MAX = 4;             // 粗读几篇（不进来源列表，只用来找关键词与线索）
  var PAGE_TIMEOUT = 9000;      // 单页抓取超时：超过 9 秒的站基本也读不出正文
  var CRAWL_CONCURRENCY = 3;

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="10.6" cy="10.6" r="6.6"/>' +
      '<path d="m15.6 15.6 4.2 4.2"/>' +
      '<path d="M7.9 10.6h5.4M10.6 7.9v5.4"/>' +
    '</svg>';

  /* ---------------- 结果清洗 ----------------
   * 这张表是这个 App 的核心承诺之一：不是「排序靠后」，而是**直接不出现**。
   * 只放确定性高的域名：广告投放、文库摘录（点开是登录墙）、下载站、盗版书影音站。
   * 误杀比漏杀更伤 —— 用户搜技术问题时，CSDN / 知乎这类站再差也可能有答案，不在这里拦。 */
  var BLOCK_HOSTS = [
    /* 广告 / 跳转 / 联盟 */
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'cpro.baidu.com', 'pos.baidu.com', 'union-click.jd.com', 's.click.taobao.com', 'uland.taobao.com',
    /* 文库 / 知道 / 文档搬运：正文读不到，只剩登录墙与广告 */
    'wenku.baidu.com', 'zhidao.baidu.com', 'docin.com', 'doc88.com', 'book118.com',
    'renrendoc.com', 'taodocs.com', '360doc.com', 'mbalib.com', 'wenku.so.com',
    /* 软件下载站：标题常带「破解版 / 绿色版 / 高速下载」，且整页是下载器广告 */
    'pc6.com', 'cr173.com', 'downxia.com', 'xiazaizhijia.com', 'onlinedown.net',
    'duote.com', 'ddooo.com', 'xiazai.zol.com.cn',
    /* 盗版书 / 影视 / 种子站 */
    'libgen.is', 'libgen.rs', 'libgen.st', 'z-lib.org', 'zlibrary.to', 'annas-archive.org',
    'piratebay.org', '1337x.to', 'rarbg.to', 'yts.mx', 'torrentz2.eu'
  ];

  /* 标题信号：命中就丢。只在措辞足够明确时启用，避免把「破解 Wi-Fi 密码的原理」这种正常内容误伤。 */
  var PIRATE_TITLE = /(破解版|绿色版|免安装版|迅雷下载|磁力下载|BT下载|全集下载|网盘资源|代下服务|内部优惠券|加微信领取)/i;

  /* 可信来源加权：官网 / 政府 / 高校 / 百科 / 代码托管优先排在前面，
   * 只影响排序，不做硬过滤 —— 排序错了还能往下翻，过滤错了就永远看不到。 */
  var TRUSTED = [
    /\.gov\.cn$/i, /\.edu\.cn$/i, /\.edu$/i, /\.gov$/i,
    /(^|\.)wikipedia\.org$/i, /(^|\.)github\.com$/i, /(^|\.)gitlab\.com$/i,
    /(^|\.)developer\.mozilla\.org$/i, /(^|\.)arxiv\.org$/i, /(^|\.)nature\.com$/i,
    /(^|\.)openai\.com$/i, /(^|\.)deepseek\.com$/i, /(^|\.)microsoft\.com$/i,
    /(^|\.)apple\.com$/i, /(^|\.)python\.org$/i, /(^|\.)nodejs\.org$/i,
    /(^|\.)reactjs\.org$/i, /(^|\.)sspai\.com$/i, /(^|\.)36kr\.com$/i,
    /(^|\.)zhihu\.com$/i, /(^|\.)juejin\.cn$/i,
    /* 主流 AI 创作工具的官网：搜工具/贴图/建模时优先露出 */
    /(^|\.)meshy\.ai$/i, /(^|\.)tripo3d\.ai$/i, /(^|\.)kaedim3d\.com$/i,
    /(^|\.)v2fun\.ai$/i, /(^|\.)hanyuai\.com$/i, /(^|\.)normalmap\.ai$/i,
    /(^|\.)aitexture\.ai$/i
  ];

  /* ---------------- 检索增强 ----------------
   * 搜索源对长中文问句很不友好：「AI 生成贴图 网站」会退化成一堆泛 AI 导航页，
   * 而「AI 生成贴图」和英文 «AI texture generator» 才能命中真正做贴图的站点。
   * 所以这里做三件事：
   *   ① 拆掉「网站 / 推荐 / 大全」这类会污染检索的尾巴；
   *   ② 按命中词拼一条英文检索式；
   *   ③ 对确切的工具型问题，补一份已知官网清单，避免大站被搜索源漏掉。 */
  var QUERY_NOISE = /(网站|推荐|大全|排行|排名|平台|有哪些|哪个好|怎么选|哪个)/g;

  var TOOL_SEEDS = [
    {
      key: /(3d\s*模型|3d\s*建模|建模|贴图|纹理|材质|texture|meshy|tripo)/i,
      sites: [
        { title: 'Meshy AI 官网：文本 / 图片生成 3D 模型与贴图', url: 'https://www.meshy.ai/zh', snippet: 'Meshy 提供 AI 3D 模型生成与 AI 贴图 / PBR 材质，支持文本和图片输入。' },
        { title: 'Tripo AI 官网：文本 / 图片生成 3D 模型', url: 'https://www.tripo3d.ai/', snippet: 'Tripo 是 AI 3D 生成平台，支持建模、贴图与导出。' },
        { title: 'Kaedim 官网：AI 辅助 3D 建模', url: 'https://www.kaedim3d.com/', snippet: '从图片生成可用于生产的 3D 模型，面向游戏与电商资产。' },
        { title: 'V2Fun 官网：AI 贴图生成', url: 'https://v2fun.ai/zh-CN/features/ai-texturing', snippet: '为 3D 模型生成 8K PBR 材质贴图。' },
        { title: 'HANYUAI 官网：AI 材质贴图生成', url: 'https://www.hanyuai.com/zh/image-generator/ai-material-texture', snippet: '免费在线生成 PBR 材质贴图。' },
        { title: 'NormalMap AI：无缝贴图与法线贴图生成', url: 'https://normalmap.ai/zh-CN/', snippet: '生成可平铺纹理、法线贴图与 PBR 材质。' }
      ]
    }
  ];

  /* 主检索式：拆掉「网站 / 推荐 / 大全」这类会污染检索的尾巴。 */
  function primaryQuery(q) {
    var s = String(q || '').replace(QUERY_NOISE, ' ').replace(/\s+/g, ' ').trim() || q;
    /* 「开源rts游戏模板」这类中英黏连会被检索源当成一个怪词，
       把中文与拉丁字母之间补一个空格，命中率明显更稳。 */
    s = s.replace(/([\u4e00-\u9fa5])([a-z0-9])/gi, '$1 $2')
         .replace(/([a-z0-9])([\u4e00-\u9fa5])/gi, '$1 $2');
    return s.replace(/\s+/g, ' ').trim() || q;
  }

  /* 备用检索式：搜索源对措辞极敏感 —— 「AI 贴图生成器」只会回泛 AI 导航页，
     而「AI 生成贴图」能直接命中做贴图的站。所以主句失效时换一种说法重问一次：
     先把「贴图生成器」拆成「生成贴图」，不行再去掉「工具 / 官网」这类尾巴。 */
  function retryQuery(q) {
    var s = primaryQuery(q);
    var out = s.replace(/\s*([^\s]+)生成器\s*$/, ' 生成$1');
    if (out === s) out = s.replace(/\s*(工具|软件|官网|网站|平台|推荐|排行|大全)\s*$/, '');
    out = out.replace(/\s+/g, ' ').trim();
    return out === s ? '' : out;
  }

  /* 搜索源低置信时的固定回退页：AI 工具集、IBM、Google AI、Kimi、千问、Ai2……
     它不是广告，但和问题毫无关系；留着会挤掉真正相关的结果，整批丢掉再换句重问。 */
  var FALLBACK_HOSTS = [
    'ai-bot.cn', 'ibm.com', 'developers.google.cn', 'kimi.com',
    'qianwen.com', 'ai.tencent.com', 'allenai.org'
  ];
  function isFallbackList(list) {
    if (!list || list.length < 5) return false;
    var hit = 0;
    list.forEach(function (r) {
      var host = hostOf(r && r.url).toLowerCase();
      for (var i = 0; i < FALLBACK_HOSTS.length; i++) {
        var b = FALLBACK_HOSTS[i];
        if (host === b || host.slice(-(b.length + 1)) === '.' + b) { hit++; break; }
      }
    });
    return hit >= 4;
  }

  function seedResults(q) {
    var out = [];
    TOOL_SEEDS.forEach(function (g) {
      if (!g.key.test(q)) return;
      g.sites.forEach(function (s) {
        out.push({ title: s.title, url: s.url, snippet: s.snippet, seed: true });
      });
    });
    return out;
  }

  /* ---------------- 代码 / 开源检索 ----------------
   * 通用搜索源对「开源 xx 模板」这类问句几乎失效：百度式索引只会返回
   * 「什么是开源」「开源中国」这类泛页面，真正的仓库一个都不给。
   * 而 GitHub 的仓库搜索接口恰好直接回答这类问题（无需 Key），
   * 所以只要问题里有开源/代码意图，就并行查一次仓库，并把仓库排在网页前面。 */
  var GH_INTENT = /(开源|源码|代码|仓库|github|gitee|项目|框架|引擎|模板|插件|sdk|api|库)/i;
  var GH_WORDS = [
    [/游戏/, 'game'], [/模板/, 'template'], [/射击|枪战/, 'shooter'], [/第一人称/, 'fps'],
    [/俯视/, 'top-down'], [/引擎/, 'engine'], [/框架/, 'framework'],
    [/插件/, 'plugin'], [/工具/, 'tool'], [/示例/, 'example'], [/教程/, 'tutorial'],
    [/多人/, 'multiplayer'], [/地图/, 'map'], [/战斗/, 'combat'], [/贴图/, 'texture'],
    [/材质/, 'material'], [/建模/, 'modeling'], [/动画/, 'animation'], [/服务端|服务器/, 'server'],
    /* 以下三条由实测补：只查 ai / readability 时找不到爬虫与正文抽取项目。 */
    [/爬虫/, 'crawler'], [/正文/, 'content'], [/抽取/, 'extract']
  ];
  /* 「找人 / 要邮箱」类问题：中文检索很难把 YouTube 频道页顶上来，
     这里把问题里的中文概念翻成英文，供相关性判断与英文检索式复用。 */
  var CONTACT_WORDS = [
    [/油管|youtube/i, 'youtube'],
    [/策略|strategy/i, 'strategy'],
    [/主播|博主|达人|streamer|youtuber/i, 'streamer'],
    [/邮箱|邮件|e-?mail/i, 'email'],
    [/游戏|game/i, 'game']
  ];
  /* 「策略游戏」在 YouTube 上不只叫 strategy game：grand strategy / total war
     都是同一品类的常用说法，检索与相关性判断都要认这些词。 */
  var CONTACT_SYNONYM = [
    [/strategy\s*games?|策略/i, ['grand strategy', 'total war', '4x strategy']]
  ];
  function contactSyn(q) {
    var out = [];
    CONTACT_SYNONYM.forEach(function (p) {
      if (!p[0].test(q)) return;
      p[1].forEach(function (w) { if (out.indexOf(w) < 0) out.push(w); });
    });
    return out;
  }
  /* 中文问句里的概念词翻成英文检索词：中文索引很难把油管 / 主播这类页面顶上来，
     英文检索式才是这类任务真正出结果的那条路。 */
  function englishQuery(q) {
    var out = [];
    function add(w) { if (w && out.indexOf(w) < 0) out.push(w); }
    CONTACT_WORDS.forEach(function (p) { if (p[0].test(q)) add(p[1]); });
    GH_WORDS.forEach(function (p) { if (p[0].test(q)) add(p[1]); });
    (String(q).match(/[a-z][a-z0-9.+#-]{1,}/gi) || []).forEach(function (w) {
      add(w.toLowerCase());
    });
    return out.slice(0, 3).join(' ');
  }
  /* 联系方式任务的排序标志：频道页、榜单页、含联系方式的页面优先。 */
  var CONTACT_HINT = /(youtube|youtu\.be|频道|主播|博主|up主|邮箱|邮件|contact|business|合作|联系)/i;
  /* 判「是否真的答上」要严得多：只有出现联系方式、邮箱或真正的频道页才算，
     否则一篇「游戏主播营销策略」也会被当成结果，把英文检索轮次直接掐掉。 */
  var CONTACT_ANSWER = /(邮箱|邮件|e-?mail|contact|business|商务|合作|联系|@[a-z0-9.-]+\.[a-z]{2,})/i;
  var YT_CHANNEL = /youtube\.com\/(@[^/?#]+|channel\/|c\/|user\/)/i;
  /* GitHub 检索是 AND 语义，词越多命中越少，所以准备三档检索式：
     ① 主档：完整组合；② 核心档：去掉 template / framework 这类修饰词；
     ③ 宽松档：再去掉最短的实词（通常是 2d / ai 这种限定词）。
     ③ 只在①②合计仍不足 GH_MIN 时才发 —— 每次请求都吃「未登录 60 次/小时」的额度。
     注意 ai 不能被当过泛词直接删掉 —— 「AI 开发的游戏模板」里它是核心限定词。 */
  function githubQueries(q) {
    if (!GH_INTENT.test(q)) return [];
    /* github / open source 这类词是「去哪找」而不是「找什么」：
       把它们拼进检索式会让 AND 语义直接落空（实测只回 ★0 的边角仓库）。 */
    var GH_NOISE = /^(github|gitee|open|source|site|http|https|www)$/i;
    var words = (String(q).match(/[a-z0-9][a-z0-9.+#-]*/gi) || [])
      .filter(function (w) { return w.length > 1 && !/^(the|and|for|of|in|to)$/i.test(w) && !GH_NOISE.test(w); });
    GH_WORDS.forEach(function (p) { if (p[0].test(q)) words.push(p[1]); });
    var seen = Object.create(null);
    var list = words.filter(function (w) {
      var k = w.toLowerCase();
      return seen[k] ? false : (seen[k] = 1);
    }).slice(0, 6);
    if (!list.length) return [];
    var out = [list.join(' ')];
    var core = list.filter(function (w) {
      return !/^(template|framework|tool|plugin|example|tutorial|library|engine)$/i.test(w);
    });
    if (core.length && core.length < list.length) out.push(core.join(' '));
    if (core.length > 2) {
      var drop = core.slice().sort(function (a, b) { return a.length - b.length; })[0];
      var relax = core.filter(function (w) { return w !== drop; }).join(' ');
      if (relax && out.indexOf(relax) < 0) out.push(relax);
    }
    return out;
  }

  /* 仓库检索的规矩：
     ① 全部检索式都问完再合并 —— 只取第一条有结果的，会把「131 个仓库」缩成 6 个；
     ② 每条检索式 per_page=20，否则「有没有更多」这个判断本身就不成立；
     ③ 主档按 star 排拿「大而全」，核心档按最佳匹配拿「小而准」，合并后重排；
     ④ 归档仓库不参与（archived:false + 客户端兜底过滤）；
     ⑤ 同一检索式 10 分钟内复用 —— 未登录只有 60 次/小时，重复搜索不该再打一遍。 */
  var GH_MODIFIER = /^(template|framework|tool|plugin|example|tutorial|library|engine|boilerplate|starter|kit|demo)$/i;
  var GH_MIN = 6;                 // 少于这个数就再放宽一档
  var GH_CACHE_TTL = 10 * 60000;
  var GH_CACHE = Object.create(null);
  var GH_COOL_UNTIL = 0;

  /* 仓库打分：先看「除修饰词之外命中了什么」，再看星数与最近更新。
     只按 stars 排序会把 awesome-list、CMS 这类高星泛仓库顶到真正的模板前面；
     星数用 log 缩放，避免 9 万星的清单页把一个几百星但精确命中的模板压死。 */
  function repoScore(x, core) {
    var name = String(x.full_name || '').toLowerCase();
    var desc = String(x.description || '').toLowerCase();
    var topics = (x.topics || []).map(function (t) { return String(t).toLowerCase(); });
    var covered = 0, nameHit = 0, topicHit = 0;
    core.forEach(function (t) {
      var w = String(t || '').toLowerCase();
      if (!w) return;
      var inName = name.indexOf(w) >= 0;
      var inDesc = desc.indexOf(w) >= 0;
      var inTopic = topics.indexOf(w) >= 0;
      if (!inName && !inDesc && !inTopic) return;
      covered++;
      if (inName) nameHit++;
      if (inTopic) topicHit++;
    });
    var score = covered * 20 + nameHit * 4 + topicHit * 4;
    score += Math.log10((Number(x.stargazers_count) || 0) + 1) * 2.5;
    var pushed = Date.parse(x.pushed_at || '');
    if (!isNaN(pushed)) {
      var days = (Date.now() - pushed) / 86400000;
      if (days <= 400) score += 6;
      else if (days <= 1100) score += 3;
      else if (days > 1800) score -= 2;
    }
    return { score: score, hits: covered };
  }

  function dedupeRepos(groups) {
    var seen = Object.create(null);
    var out = [];
    (groups || []).forEach(function (list) {
      (list || []).forEach(function (x) {
        var u = x && x.html_url;
        if (!u || seen[u] || x.archived) return;
        seen[u] = 1;
        out.push(x);
      });
    });
    return out;
  }

  function toRepoResult(x) {
    var desc = String(x.description || '').replace(/\s+/g, ' ').trim();
    var meta = ['★' + (Number(x.stargazers_count) || 0)];
    if (x.language) meta.push(String(x.language));
    var pushed = String(x.pushed_at || '').slice(0, 7);
    if (pushed) meta.push('更新 ' + pushed);
    var topics = (x.topics || []).slice(0, 3);
    if (topics.length) meta.push(topics.map(function (t) { return '#' + t; }).join(' '));
    return {
      title: clip(x.full_name + (desc ? ' · ' + desc : ''), 120),
      url: x.html_url,
      snippet: clip((desc || 'GitHub 仓库') + ' · ' + meta.join(' · '), 360),
      repo: true
    };
  }

  function ghSearch(qq, mode, signal) {
    var key = qq + '|' + mode;
    var hit = GH_CACHE[key];
    var fresh = hit && Date.now() - hit.at < GH_CACHE_TTL;
    if (fresh) return Promise.resolve(hit.items);
    /* 已经撞过限流：这一轮不再打，有旧缓存就先用旧缓存。 */
    if (GH_COOL_UNTIL > Date.now()) return Promise.resolve(hit ? hit.items : []);
    var url = 'https://api.github.com/search/repositories?q='
      + encodeURIComponent(qq + ' archived:false') + '&per_page=20'
      + (mode === 'stars' ? '&sort=stars&order=desc' : '');
    return fetchJson(url, signal).then(function (j) {
      var items = (j && j.items) || [];
      GH_CACHE[key] = { at: Date.now(), items: items };
      return items;
    }).catch(function (e) {
      /* 403 / 429 基本都是「未登录 60 次/小时」用完了：记 10 分钟冷却，
         同一检索式之前拿到的缓存还能继续用，不至于整轮空手。 */
      if (/HTTP\s+(403|429)/.test(String(e && e.message || ''))) {
        GH_COOL_UNTIL = Date.now() + GH_CACHE_TTL;
        S.ghRateLimited = true;
      }
      return hit ? hit.items : [];
    });
  }

  function githubResults(q, signal) {
    var queries = githubQueries(q);
    if (!queries.length) return Promise.resolve([]);
    var core = relevantTokens(q).filter(function (t) { return !GH_MODIFIER.test(t); });
    /* 英文里 FPS / shooter 是同一类说法：只认 shooter 会漏掉 SimpleFPSTemplate 这种仓库。 */
    if (/(射击|枪战|shooter|fps)/i.test(q) && core.indexOf('fps') < 0) core.push('fps');
    var plans = queries.slice(0, 2).map(function (qq, i) {
      return ghSearch(qq, i === 0 ? 'stars' : 'match', signal);
    });
    return Promise.all(plans).then(function (groups) {
      var all = dedupeRepos(groups);
      if (all.length >= GH_MIN || queries.length <= 2 || S.ghRateLimited) return all;
      return ghSearch(queries[2], 'match', signal).then(function (list) {
        return dedupeRepos([all, list]);
      });
    }).then(function (all) {
      if (!all.length) return [];
      S.ghQuery = queries[0];
      var ranked = all.map(function (x) {
        var s = repoScore(x, core);
        return { x: x, score: s.score, hits: s.hits };
      });
      var strong = ranked.filter(function (r) { return r.hits > 0; });
      /* 强相关太少时退回全集：宁可多给几条让用户自己挑，也不要筛得太狠只剩个位数。 */
      if (strong.length >= GH_MIN) ranked = strong;
      ranked.sort(function (a, b) { return b.score - a.score; });
      return ranked.slice(0, 20).map(function (r) { return toRepoResult(r.x); });
    });
  }

  /* 同一会话里重复的说法不再重复请求：既省时间，也少给检索源添一次限流机会。 */
  var SEARCH_CACHE = Object.create(null);
  function searchCacheGet(q) {
    var hit = SEARCH_CACHE[String(q).toLowerCase()];
    return hit && Date.now() - hit.at < 600000 ? hit.list : null;
  }
  function searchCachePut(q, list) {
    SEARCH_CACHE[String(q).toLowerCase()] = { at: Date.now(), list: list };
  }

  /* 查询分词：中文按二元组，英文按单词，用来给段落和线索打分。 */
  function queryTokens(q) {
    var tokens = [];
    var text = String(q || '').toLowerCase();
    var words = text.match(/[a-z0-9][a-z0-9.+#-]{1,}/g) || [];
    words.forEach(function (w) { if (w.length > 1) tokens.push(w); });
    var cjk = text.replace(/[^\u4e00-\u9fa5]+/g, ' ');
    cjk.split(/\s+/).forEach(function (run) {
      if (run.length < 2) return;
      for (var i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    });
    var seen = Object.create(null);
    return tokens.filter(function (t) { return seen[t] ? false : (seen[t] = 1); });
  }

  /* RAG 轻量版：不再整篇截断，而是按问题词命中选择相关段落，
     既压住上下文长度，也让模型先看到真正回答问题的那几段。
     extraTokens 是粗读捞到的新关键词 —— 用它们做第二遍检索，
     可以把「问题词没出现、但其实在讲同一件事」的段落也捞上来。 */
  function pickRelevant(text, q, maxLen, extraTokens) {
    var tokens = queryTokens(q).concat(extraTokens || []);
    if (!tokens.length) return String(text || '').slice(0, maxLen);
    var paras = String(text || '').split('\n').filter(function (p) { return p.trim().length > 8; });
    var scored = paras.map(function (p, i) {
      var low = p.toLowerCase();
      var score = 0;
      tokens.forEach(function (t) { if (low.indexOf(t) >= 0) score += t.length > 3 ? 3 : 2; });
      return { p: p, i: i, score: score };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.i - b.i;
    });
    var out = [];
    var used = 0;
    /* 一个词都没命中（常见于英文频道页 vs 中文提问）时，别只丢第一段，
       否则模型只能看到频道名，没法判断这个频道到底播什么。 */
    if (!scored.length || !scored[0].score) return String(text || '').slice(0, maxLen);
    for (var j = 0; j < scored.length; j++) {
      if (!scored[j].score && out.length) continue;
      if (used + scored[j].p.length + 1 > maxLen) continue;
      out.push(scored[j].p);
      used += scored[j].p.length + 1;
      if (used >= maxLen - 120) break;
    }
    return out.join('\n').slice(0, maxLen) || String(text || '').slice(0, maxLen);
  }

  /* 粗读：页面已经抓下来了，但不当资料用，只做两件事 ——
     ① 捞出问题里没有、却在多篇里反复出现的词（新线索）；
     ② 收集出站链接，交给线索追踪继续跟。
     它和精读是两条预算：精读 5 篇进模型，粗读 3 篇只用来扩线索，不烧上下文。 */
  var KW_STOP = {
    'the': 1, 'and': 1, 'for': 1, 'with': 1, 'that': 1, 'this': 1, 'you': 1, 'are': 1,
    'from': 1, 'your': 1, 'have': 1, 'will': 1, 'can': 1, 'not': 1, 'all': 1, 'game': 1,
    'more': 1, 'about': 1, 'https': 1, 'http': 1, 'html': 1, 'github': 1, 'com': 1,
    /* 代码托管页面的通用构件：出现频率极高，但对「找线索」没有信息量 */
    'repository': 1, 'repo': 1, 'project': 1, 'readme': 1, 'license': 1, 'branch': 1,
    'commit': 1, 'release': 1, 'fork': 1, 'issue': 1, 'request': 1, 'navigation': 1,
    'files': 1, 'code': 1, 'docs': 1, 'stars': 1, 'watch': 1, 'report': 1,
    '我们': 1, '可以': 1, '一个': 1, '这个': 1, '就是': 1, '以及': 1, '如果': 1,
    '没有': 1, '需要': 1, '使用': 1, '支持': 1, '通过': 1, '进行': 1, '相关': 1,
    /* 页面构件词：搜索结果与正文里到处都是，当线索只会把下一轮检索带偏 */
    '图片': 1, '输入': 1, '搜索': 1, '登录': 1, '注册': 1, '首页': 1, '网页': 1,
    '结果': 1, '查看': 1, '更多': 1, '点击': 1, '下载': 1, '评论': 1, '分享': 1,
    '推荐': 1, '网站': 1, '内容': 1, '页面': 1, '用户': 1, '信息': 1, '问题': 1,
    '免费': 1, '最新': 1, '全部': 1, '知道': 1, '百科': 1, '导航': 1
  };
  /* 含纯虚词的二元组一律不要：真正有信息量的线索是「瑶海」「房租」「均价」，
     而不是「的租」「区的」这类只由语法词拼出来的碎片。
     只收「基本不参与构词」的字，避免把「用户」「会议」「中关村」误伤掉。 */
  var KW_JUNK = /[的了是在和与及我你他她它这那个吗呢吧啊嘛哦呀]/;
  function harvestKeywords(text, q) {
    var known = Object.create(null);
    relevantTokens(q).forEach(function (t) { known[t] = 1; });
    var counts = Object.create(null);
    var low = String(text || '').toLowerCase();
    (low.match(/[a-z][a-z0-9.+#-]{2,}/g) || []).forEach(function (w) {
      if (known[w] || KW_STOP[w] || /^\d+$/.test(w)) return;
      counts[w] = (counts[w] || 0) + 1;
    });
    low.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/).forEach(function (run) {
      if (run.length < 3) return;
      for (var i = 0; i < run.length - 1; i++) {
        var g = run.slice(i, i + 2);
        if (known[g] || KW_STOP[g] || KW_JUNK.test(g)) continue;
        counts[g] = (counts[g] || 0) + 1;
      }
    });
    return Object.keys(counts)
      .filter(function (k) { return counts[k] >= 2 && !KW_JUNK.test(k); })
      .sort(function (a, b) { return counts[b] - counts[a] || b.length - a.length; })
      .slice(0, 8);
  }

  function skimSources(list, signal) {
    /* 粗读要的是「不同来源的说法」，不是又一堆同站页面：
       ① 社区 / 问答页优先 —— 里面常写着别人推荐的具体工具名；
       ② 每个站点最多一篇，已精读过的站点直接跳过。
       只读三篇，但能覆盖三种口径，关键词才有对比价值。 */
    var sites = Object.create(null);
    S.sources.forEach(function (s) {
      var h = s.host || hostOf(s.url);
      if (h) sites[siteOf(h)] = 1;
    });
    var ranked = (list || []).slice().sort(function (a, b) {
      return (isCommunity(a.url) ? 0 : 1) - (isCommunity(b.url) ? 0 : 1);
    });
    var cands = [];
    ranked.forEach(function (r) {
      if (cands.length >= SKIM_MAX) return;
      var h = hostOf(r.url);
      if (!h || sites[siteOf(h)]) return;
      sites[siteOf(h)] = 1;
      cands.push(r);
    });
    if (!cands.length) return Promise.resolve({ pages: 0, keywords: [], links: [], urls: [] });
    var kw = Object.create(null);
    var links = [];
    return Promise.all(cands.map(function (c) {
      var ready = S.pageCache[c.url];
      var p = ready ? Promise.resolve(ready) : fetchPage(c.url, signal).then(function (html) {
        S.pageCache[c.url] = html;
        return html;
      });
      return p.then(function (html) {
        if (S.intentKind === 'contact') recordEmails(html, { idx: 0, title: c.title, url: c.url });
        var page = extractPage(html);
        harvestKeywords(page.text, S.query).forEach(function (k) { kw[k] = (kw[k] || 0) + 1; });
        links = links.concat(extractLinks(html, c.url));
      }).catch(function () { /* 粗读失败不影响主流程 */ });
    })).then(function () {
      /* 只留被两篇以上页面同时提到的词：单篇独有的多半是页面自己的导航/品牌词。 */
      var keywords = Object.keys(kw).filter(function (k) { return kw[k] >= 2; }).slice(0, 6);
      if (!keywords.length) keywords = Object.keys(kw).slice(0, 4);
      return { pages: cands.length, keywords: keywords, links: links, urls: cands.map(function (c) { return c.url; }) };
    });
  }

  /* 精读补充：在已选段落之外，再按新关键词捞一段，避免模型只看到页面前半部分。
     门槛比第一遍高：段落要够长、且命中两个以上关键词，否则很容易捞到导航条。 */
  function supplementText(text, base, tokens, maxLen) {
    if (!tokens.length) return '';
    var paras = String(text || '').split('\n').filter(function (p) {
      var t = p.trim();
      return t.length >= 24 && base.indexOf(t) < 0;
    });
    var picked = [];
    var used = 0;
    paras.forEach(function (p) {
      if (used >= maxLen) return;
      var low = p.toLowerCase();
      var hit = 0;
      tokens.forEach(function (t) { if (low.indexOf(t) >= 0) hit++; });
      if (hit < 2) return;
      if (used + p.length + 1 > maxLen) return;
      picked.push(p);
      used += p.length + 1;
    });
    return picked.join('\n').slice(0, maxLen);
  }

  /* ---------------- 影视模式 ----------------
   * 影视模式只认「能合法播放的官方平台」：官方视频站、电视台、公共版权库。
   * 这不是靠关键词黑名单，而是**白名单**：不在表里的域名一律不出现。
   * 目的很明确：帮用户找到官方免费片源，而不是把盗版站换个入口再给一遍。
   * search 是各站自己的搜索地址，拼上片名，用户点开就是站内结果，不经过聚合站。 */
  var MEDIA_PLATFORMS = [
    { key: 'qq',        name: '腾讯视频',        host: /(^|\.)v\.qq\.com$/i,                  search: 'https://v.qq.com/x/search/?q=',                   color: '#22b573' },
    { key: 'iqiyi',     name: '爱奇艺',          host: /(^|\.)iqiyi\.com$/i,                 search: 'https://so.iqiyi.com/so/q_',                      color: '#00be06' },
    { key: 'youku',     name: '优酷',            host: /(^|\.)youku\.com$/i,                 search: 'https://so.youku.com/search_video/q_',            color: '#1b9af7' },
    { key: 'mgtv',      name: '芒果TV',          host: /(^|\.)mgtv\.com$/i,                  search: 'https://so.mgtv.com/so?k=',                       color: '#f28200' },
    { key: 'bilibili',  name: '哔哩哔哩',        host: /(^|\.)bilibili\.com$/i,              search: 'https://search.bilibili.com/all?keyword=',        color: '#fb7299' },
    { key: 'bangumi',   name: 'B站番剧',         host: /(^|\.)bilibili\.com$/i,              search: 'https://search.bilibili.com/bangumi?keyword=',    color: '#fb7299' },
    { key: 'acfun',     name: 'AcFun',           host: /(^|\.)acfun\.cn$/i,                  search: 'https://www.acfun.cn/search?keyword=',            color: '#fd4c5d' },
    { key: 'bahamut',   name: '巴哈动画疯',      host: /(^|\.)gamer\.com\.tw$/i,             search: 'https://ani.gamer.com.tw/search.php?keyword=',    color: '#1e88e5' },
    { key: 'crunchyroll', name: 'Crunchyroll',   host: /(^|\.)crunchyroll\.com$/i,           search: 'https://www.crunchyroll.com/search?q=',           color: '#f47521' },
    { key: 'prime',     name: 'Prime Video',     host: /(^|\.)primevideo\.com$/i,            search: 'https://www.primevideo.com/search?phrase=',       color: '#00a8e1' },
    { key: 'netflix',   name: 'Netflix',         host: /(^|\.)netflix\.com$/i,               search: 'https://www.netflix.com/search?q=',               color: '#e50914' },
    { key: '1905',      name: '1905电影网',      host: /(^|\.)1905\.com$/i,                  search: 'https://www.1905.com/search/?q=',                 color: '#c62f2f' },
    { key: 'cctv',      name: '央视频 / 央视网', host: /(^|\.)(cctv|cntv)\.(com|cn)$/i,      search: 'https://search.cctv.com/search.php?qtext=',       color: '#e02020' },
    { key: 'youtube',   name: 'YouTube',         host: /(^|\.)youtube\.com$/i,               search: 'https://www.youtube.com/results?search_query=',   color: '#ff3d3d' },
    { key: 'archive',   name: 'Internet Archive',host: /(^|\.)archive\.org$/i,                search: 'https://archive.org/search?query=',               color: '#6b7280' },
    { key: 'tubi',      name: 'Tubi',            host: /(^|\.)tubitv\.com$/i,                 search: 'https://tubitv.com/search/',                      color: '#f97316' },
    { key: 'pluto',     name: 'Pluto TV',        host: /(^|\.)pluto\.tv$/i,                   search: 'https://pluto.tv/en/search/',                     color: '#ca8a04' },
    { key: 'roku',      name: 'The Roku Channel',host: /(^|\.)therokuchannel\.roku\.com$/i,   search: 'https://therokuchannel.roku.com/search/',         color: '#7c3aed' },
    { key: 'plex',      name: 'Plex',            host: /(^|\.)watch\.plex\.tv$/i,             search: 'https://watch.plex.tv/search?q=',                 color: '#d99a00' }
  ];

  var MEDIA_STATUS = { free: '免费', trial: '免费试看', vip: '需会员', trailer: '仅预告', unknown: '待确认' };

  /* 非官方结果只认「视频文件直链」：命中扩展名才收，网页地址一律不给入口。
     这样既不把用户送进盗版站的广告与弹窗，也不会凭空编一个下载地址。 */
  var VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|flv|ts|m3u8)$/i;

  var WEB_CHIPS = ['DeepSeek 最新模型有什么变化', 'React 19 有哪些新特性', '如何挑选适合自己的机械键盘', '2026 年诺贝尔物理学奖'];
  var MEDIA_CHIPS = ['流浪地球 2', '庆余年 第二季', '葬送的芙莉莲', '肖申克的救赎'];

  function mediaSite(host) {
    for (var i = 0; i < MEDIA_PLATFORMS.length; i++) {
      if (MEDIA_PLATFORMS[i].host.test(host)) return MEDIA_PLATFORMS[i];
    }
    return null;
  }

  /* 从页面正文判断「免费 / 试看 / 会员 / 预告」。顺序有讲究：
     「免费试看」里也含「免费」，所以试看必须排在免费前面判断。 */
  function mediaStatus(text) {
    var t = String(text || '');
    if (/(免费试看|试看\d+分钟|免费看前\d+|限免)/.test(t)) return 'trial';
    if (/(免费观看|免费播放|免费在线|限时免费|无需会员|完全免费|免费正片)/.test(t)) return 'free';
    if (/(VIP|会员专享|会员观看|付费观看|超前点播|购买观看|需要会员)/i.test(t)) return 'vip';
    if (/(预告|花絮|片段|抢先看|制作特辑)/.test(t)) return 'trailer';
    return 'unknown';
  }

  function mediaTitle(title, siteName) {
    var t = String(title || '').replace(
      new RegExp('\\s*[-_|｜]\\s*(' + MEDIA_PLATFORMS.map(function (p) { return p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ').*$', 'i'),
      ''
    );
    return clip(t, 120) || siteName;
  }

  function videoExt(url) {
    try {
      var m = new URL(url).pathname.match(VIDEO_EXT);
      return m ? m[1].toLowerCase() : '';
    } catch (e) { return ''; }
  }

  /* 影视结果清洗：
   *   ① 官方平台 → 正常来源卡，参与摘要与引用；
   *   ② 非官方但地址是视频文件 → 单列「视频直链」，只给下载入口；
   *   ③ 非官方网页 → 单列「网页」，只能经内置浏览器安全打开，不给裸链接。 */
  function cleanMediaResults(list) {
    var kept = [];
    var other = [];
    var pages = [];
    var dropped = [];
    var seen = Object.create(null);
    var seenOther = Object.create(null);
    var seenPage = Object.create(null);
    (list || []).forEach(function (raw) {
      var url = String(raw && raw.url || '').trim();
      var host = hostOf(url).toLowerCase();
      var title = clip(raw && raw.title, 120);
      var site = mediaSite(host);
      if (!site) {
        var ext = videoExt(url);
        if (!ext) {
          if (seenPage[url]) {
            dropped.push({ url: url, title: title, why: '重复网页' });
            return;
          }
          seenPage[url] = 1;
          pages.push({ title: title, url: url, host: host });
          return;
        }
        if (seenOther[url]) {
          dropped.push({ url: url, title: title, why: '重复直链' });
          return;
        }
        seenOther[url] = 1;
        other.push({ title: title, url: url, host: host, ext: ext });
        return;
      }
      var cleanTitle = mediaTitle(raw && raw.title, site.name);
      var key = site.key + '|' + cleanTitle.replace(/[\s\-_|｜:：]+/g, '').toLowerCase();
      if (seen[key]) {
        dropped.push({ url: url, title: cleanTitle, why: '同平台重复页' });
        return;
      }
      seen[key] = 1;
      kept.push({
        title: cleanTitle,
        url: url,
        snippet: clip(raw && raw.snippet || '', 360),
        host: hostOf(url),
        site: site.name,
        siteKey: site.key,
        trusted: true
      });
    });
    return { kept: kept, other: other, pages: pages, dropped: dropped };
  }

  var S = {
    body: null,
    mode: 'web',
    q: '',
    phase: 'idle',
    busy: false,
    streaming: false,
    results: [],
    other: [],
    pages: [],
    dropped: [],
    sources: [],
    trace: [],
    skim: { pages: 0, keywords: [], links: [] },
    liveNote: '',
    ghQuery: '',
    ghRateLimited: false,
    pageCache: Object.create(null),
    emails: [],
    intentKind: '',
    assistOn: true,
    assistScript: null,
    autoTried: false,
    answer: '',
    error: '',
    note: '',
    llmOff: false,
    folded: false,
    startedAt: 0,
    ctrl: null,
    raf: 0,
    hist: []
  };

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function decodeEnt(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, function (_, d) { try { return String.fromCharCode(Number(d)); } catch (e) { return ''; } })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ''; } })
      .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
  }
  function pathOf(url) {
    try {
      var u = new URL(url);
      var p = (u.pathname || '/') + (u.search || '');
      return p.length > 48 ? p.slice(0, 47) + '…' : p;
    } catch (e) { return ''; }
  }
  function clip(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function today() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function msText(ms) {
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' 秒';
  }
  function trustedHost(h) {
    for (var i = 0; i < TRUSTED.length; i++) { if (TRUSTED[i].test(h)) return true; }
    return false;
  }
  /* 站内功能页不是资料：搜索源会把 GitHub 的登录 / 提交记录 / 标签页当成正文页，
     点开全是导航文字，还会挤掉真正的仓库。按「主机 + 路径」拦，不误伤仓库主页。 */
  var CHROME_HOSTS = ['help.github.com', 'fanyi.so.com'];
  /* 这些路径都来自实测混进结果的站内功能页；没观察到的路径不预先拦，避免误伤。 */
  var GH_CHROME_PATH = new RegExp(
    '^/(?:login|signup|events|features|team|customer-stories)(?:/|$)'
    + '|^/[^/]+/[^/]+/(?:actions|tags|projects|commits|security|activity|forks|tree)(?:/|$)', 'i');
  function chromeReason(url) {
    var host = hostOf(url).toLowerCase();
    for (var i = 0; i < CHROME_HOSTS.length; i++) {
      var h = CHROME_HOSTS[i];
      if (host === h || host.slice(-(h.length + 1)) === '.' + h) return '站内功能页 / 插件页';
    }
    if (/(^|\.)github\.com$/.test(host)) {
      var p = '';
      try { p = new URL(url).pathname; } catch (e) { p = ''; }
      if (GH_CHROME_PATH.test(p)) return 'GitHub 站内功能页';
    }
    return '';
  }

  function blockedReason(r) {
    var url = String(r && r.url || '');
    var host = hostOf(url).toLowerCase();
    if (!/^https?:\/\//i.test(url)) return '地址无效';
    /* 百度的 link?url= 跳转：先过一层联盟/广告，真实地址还不一定和标题一致 */
    if (/(^|\.)baidu\.com$/.test(host) && /\/link\?/i.test(url)) return '百度跳转广告链';
    for (var i = 0; i < BLOCK_HOSTS.length; i++) {
      var b = BLOCK_HOSTS[i];
      if (host === b || host.slice(-(b.length + 1)) === '.' + b) return '广告 / 低质站点';
    }
    if (PIRATE_TITLE.test(String(r.title || ''))) return '下载站 / 盗版资源';
    return chromeReason(url);
  }

  /* 与问题无关的结果要丢掉：搜索源（尤其百度式索引）很爱把「开源」这种词
     单独拿出来，回一堆「什么是开源」「开源中国」「开源社」；它们读起来像资料，
     实际一点信息量都没有，还会把真正相关的仓库挤出精读名额。
     判断只看实词：去掉「开源 / 工具 / 网站」这类谁都命中的泛词后，一个都不剩就丢。 */
  var GENERIC_TOKENS = {
    '开源': 1, '代码': 1, '项目': 1, '工具': 1, '网站': 1, '平台': 1, '免费': 1,
    '推荐': 1, '最新': 1, '什么': 1, '怎么': 1, '如何': 1, '哪些': 1, '官方': 1, '下载': 1
  };
  function distinctiveTokens(q) {
    return queryTokens(q).filter(function (t) {
      return t.length > 1 && !GENERIC_TOKENS[t] && !/^(ai|the|and|for|of|to|in|is)$/.test(t);
    });
  }

  /* 相关性判断不能只看中文词：GitHub 仓库的标题/描述是英文的，
     「游戏模板」得同时承认 game / template 才算命中。 */
  function relevantTokens(q) {
    var out = distinctiveTokens(q);
    GH_WORDS.forEach(function (p) { if (p[0].test(q)) out.push(p[1]); });
    /* 联系方式任务必须承认英文频道页 / 榜单页，否则它们会被当成「与问题无关」整批丢掉。 */
    if (inferIntent(q).kind === 'contact') {
      CONTACT_WORDS.forEach(function (p) {
        if (p[0].test(q) && out.indexOf(p[1]) < 0) out.push(p[1]);
      });
      contactSyn(q).forEach(function (w) { if (out.indexOf(w) < 0) out.push(w); });
    }
    return out;
  }
  function relevantTo(r, tokens) {
    if (!tokens.length) return true;
    var text = (String(r.title || '') + ' ' + String(r.snippet || '') + ' ' + String(r.url || '')).toLowerCase();
    for (var i = 0; i < tokens.length; i++) {
      if (text.indexOf(tokens[i]) >= 0) return true;
    }
    return false;
  }

  /* 同站同标题只留一条：搬运站最常见的手法是原文标题原样复制。 */
  function cleanResults(list, q) {
    var kept = [];
    var dropped = [];
    var seen = Object.create(null);
    var seenUrl = Object.create(null);
    var seenTitle = Object.create(null);
    var tokens = relevantTokens(q);
    var contact = inferIntent(q).kind === 'contact';
    (list || []).forEach(function (raw) {
      var url = String(raw && raw.url || '').trim();
      var title = clip(raw.title || hostOf(url), 120);
      var why = blockedReason({ url: url, title: title });
      if (why) { dropped.push({ url: url, title: title, why: why }); return; }
      /* 联系人任务里，YouTube 频道页本身就是答案载体：频道名往往不含问题里的
         「strategy」，但它是按对应检索式拿到的，不能按字面相关度丢掉。 */
      var isChannel = contact && YT_CHANNEL.test(url);
      if (!isChannel && !relevantTo({ title: title, snippet: raw.snippet, url: url }, tokens)) {
        dropped.push({ url: url, title: title, why: '与问题无关' });
        return;
      }
      var norm = url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
      if (seenUrl[norm]) { dropped.push({ url: url, title: title, why: '重复结果' }); return; }
      seenUrl[norm] = 1;
      var key = hostOf(url).toLowerCase() + '|' + title.replace(/[\s\-_|｜:：]+/g, '').toLowerCase();
      if (seen[key]) { dropped.push({ url: url, title: title, why: '重复结果' }); return; }
      seen[key] = 1;
      /* 找人任务里，同一篇「如何找主播」会被搬运到十几个站，标题一字不差；
         只按站点去重会让 6 个精读名额全被同一篇文章占满。 */
      if (contact) {
        var tk = title.replace(/[\s\-_|｜:：,，。.!！?？"'“”‘’()（）\[\]【】]+/g, '').toLowerCase();
        if (tk && seenTitle[tk]) { dropped.push({ url: url, title: title, why: '重复标题' }); return; }
        if (tk) seenTitle[tk] = 1;
      }
      kept.push({
        title: title,
        url: url,
        snippet: clip(raw.snippet || '', 360),
        host: hostOf(url),
        seed: !!raw.seed,
        repo: !!raw.repo,
        /* 备用源（360）的结果链接都指向 so.com 跳转：这个标记必须带下去，
           否则排序时会被当成同一个站点，10 条只留下 2 条。 */
        alt: !!raw.alt,
        /* 频道检索结果里直接带出了简介邮箱：留在结果上，排序与作答都要用。 */
        email: raw.email || '',
        trusted: trustedHost(hostOf(url))
      });
    });
    /* 排序：人工种子 > 仓库 > 可信站 > 其他；同级保持搜索源名次。
       联系方式任务把「榜单 / 频道 / 邮箱」类结果整体提到前面，「如何找主播」这类教程往后放。 */
    function rank(x) {
      var base = x.seed ? 3 : (x.repo ? 2 : (x.trusted ? 1 : 0));
      if (contact) {
        var t = String(x.title || '') + ' ' + String(x.snippet || '') + ' ' + String(x.url || '');
        if (CONTACT_HINT.test(t)) base += 4;
        if (/(best|top|榜单|排行|频道|channels|邮箱|e-?mail|contact)/i.test(t)) base += 3;
        if (/(如何|怎么|教程|攻略|指南|推广策略)/.test(t)) base -= 3;
      }
      return base;
    }
    kept.sort(function (a, b) { return rank(b) - rank(a); });
    return { kept: kept, dropped: dropped };
  }

  /* ---------------- 状态存取 ---------------- */
  function loadHist() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_HIST) || '[]');
      S.hist = Array.isArray(raw) ? raw.filter(function (x) { return x && x.q; }).slice(0, 8) : [];
    } catch (e) { S.hist = []; }
  }
  function saveHist() {
    try { localStorage.setItem(LS_HIST, JSON.stringify(S.hist.slice(0, 8))); } catch (e) { /* 配额满不影响搜索 */ }
  }
  function addHist(q) {
    S.hist = [{ q: q, at: Date.now() }].concat(S.hist.filter(function (x) { return x.q !== q; })).slice(0, 8);
    saveHist();
    renderHist();
  }

  /* ---------------- 本地中转 ---------------- */
  function relayEndpoint() {
    try { if (typeof relayBase === 'function') return relayBase() + '/proxy'; } catch (e) { /* 继续用默认 */ }
    return 'http://127.0.0.1:8787/proxy';
  }
  function relayHealthUrl() {
    return relayEndpoint().replace(/\/proxy$/, '') + '/health';
  }
  /* 页面跑在 file:// / app:// 下，直连第三方网页一定是 CORS 拒；这两种 origin 直接走中转。
     http(s) 调试环境才先试直连，失败再退中转。 */
  function needRelay() {
    try { return /^(file|app|chrome-extension|moz-extension|edge):$/.test(location.protocol); }
    catch (e) { return false; }
  }
  function abortErr() {
    var e = new Error('已停止');
    e.name = 'AbortError';
    return e;
  }

  /* 站点按 IP 限流后的本地冷却表：host -> 解禁时间。
     中转已经会对 403 / 429 判冷却，这里再记一份，避免同一轮里同一站被反复排队等待。 */
  var HOST_BLOCK = Object.create(null);
  function hostCooling(url) {
    var h = hostOf(url).toLowerCase();
    var until = HOST_BLOCK[h];
    if (!until) return '';
    if (until <= Date.now()) { delete HOST_BLOCK[h]; return ''; }
    return Math.ceil((until - Date.now()) / 60000) + ' 分钟';
  }
  function coolHost(url, msg) {
    var m = /(\d+)\s*分钟/.exec(String(msg || ''));
    HOST_BLOCK[hostOf(url).toLowerCase()] = Date.now() + (m ? Number(m[1]) : 10) * 60000;
  }

  /* 登录墙 / 反爬校验页：知乎、百度百科抓不到正文时常常回的是一整页「请登录后查看」。
     这种文字既不能当正文，也不能拿去抽关键词，只能降级成摘要。 */
  var LOGIN_WALL = /(登录后(?:查看|阅读|继续)|请先?登录|扫码登录|登录查看全文|安全验证|完成验证|请输入验证码|访问过于频繁)/;
  function looksLikeLoginWall(text) {
    var t = String(text || '');
    return t.length < 1500 && LOGIN_WALL.test(t);
  }

  /* YouTube 在浏览器指纹下会回超大响应头，本地中转解析不了（502 Header overflow）；
     Jina Reader 能把频道页转成纯文本，/about 里的商务邮箱仍然保留。
     联系人任务只读 YouTube 频道页，这里统一绕行。 */
  var JINA = 'https://r.jina.ai/';
  function isYouTube(url) {
    return /(^|\.)youtube\.com$/i.test(hostOf(url));
  }
  function readViaJina(url, signal) {
    return fetchPage(JINA + url, signal);
  }

  function fetchPage(url, signal, depth) {
    depth = depth || 0;
    if (S.intentKind === 'contact' && isYouTube(url) && String(url).indexOf(JINA) !== 0) {
      url = JINA + url;
    }
    /* 已经在限流冷却里的站直接跳过，别让整轮精读都卡在同一个被封的域名上。 */
    var cooling = hostCooling(url);
    if (cooling) return Promise.reject(new Error('站点按 IP 限流，约 ' + cooling + ' 后再试'));
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timedOut = false;
      /* YouTube 频道检索 / 关于页都有大段内联 JSON，默认超时经常卡在下载中途；
         Jina Reader 这边还要先回源抓取 YouTube，再给更宽的时间。 */
      var wait = String(url).indexOf(JINA) === 0 ? PAGE_TIMEOUT * 4
        : (/(^|\.)youtube\.com\//i.test(url) ? PAGE_TIMEOUT * 2 : PAGE_TIMEOUT);
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, wait);
      function onAbort() { ctrl.abort(); }
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); reject(abortErr()); return; }
        signal.addEventListener('abort', onAbort);
      }
      var headers = {
        'Accept': 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
      };
      var relay = relayEndpoint();
      var attempts = needRelay() ? [relay] : [url, relay];

      function finish(err, html) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(html);
      }

      (function next(i) {
        if (i >= attempts.length) { finish(new Error('抓取失败')); return; }
        var target = attempts[i];
        var init = { headers: headers, signal: ctrl.signal, redirect: 'follow' };
        if (target === relay) {
          init.headers = Object.assign({}, headers, { 'X-Relay-Target': url });
          /* 搜索引擎的结果跳转链接（so.com / sogou.com 的 /link）需要中转跟随 302，
             否则只能拿到一张空跳转页。只对这类链接开启，避免影响普通抓取。 */
          if (/^https?:\/\/(www\.)?(so|sogou)\.com\/link/i.test(url)) init.headers['X-Relay-Follow'] = '1';
        }
        fetch(target, init).then(function (res) {
          if (!res.ok) {
            /* 中转会把「按 IP 限流 / 站点拒绝」的原因写在 X-Relay-Error 里，
               比一句 HTTP 403 更能告诉用户该等多久、该换哪条路。 */
            var reason = '';
            try {
              var raw = res.headers.get('X-Relay-Error') || '';
              reason = raw ? decodeURIComponent(raw) : '';
            } catch (e) { reason = ''; }
            if (reason) {
              if (/站点按 IP/.test(reason)) coolHost(url, reason);
              throw new Error(reason);
            }
            throw new Error('HTTP ' + res.status);
          }
          var ct = String(res.headers.get('content-type') || '').toLowerCase();
          if (ct && !/text\/html|application\/xhtml|text\/plain/.test(ct)) throw new Error('不是网页正文');
          return res.text();
        }).then(function (html) {
          /* 有些搜索站用 JS 跳转（window.location.replace(...)）而不是 302，
             只回一张几百字节的空壳。识别出真实地址后再抓一次。
             注意 replace 是函数调用，不是赋值：旧正则只认 location.replace = "..."，
             结果 360 的 /link 空壳一直没被跟进去，线索从源头就断了。 */
          var htmls = String(html || '');
          var m = htmls.length < 1600
            ? (/location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']\s*\)/i.exec(htmls)
              || /location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(htmls)
              || /http-equiv=["']refresh["'][^>]*content=["'][^"']*?url=([^"'>\s]+)/i.exec(htmls))
            : null;
          if (m && m[1] && depth < 2 && /^https?:\/\//i.test(m[1])) {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fetchPage(m[1], signal, depth + 1).then(resolve, reject);
            return;
          }
          finish(null, html);
        }).catch(function (e) {
          if (ctrl.signal.aborted) {
            /* 超时和用户点「停止」都会 abort，必须分开：前者算「这篇没读到」，
               后者要整轮退出。混在一起会让超时的那篇永远停在「等待读取」。 */
            finish(timedOut ? new Error('站点在 ' + Math.round(wait / 1000) + ' 秒内没有响应') : abortErr());
            return;
          }
          if (i + 1 < attempts.length) next(i + 1);
          else finish(new Error(relayHint(e)));
        });
      })(0);
    });
  }

  /* JSON 接口（GitHub 仓库搜索）：和网页抓取走同一条中转，只是不校验 content-type。 */
  function fetchJson(url, signal) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, PAGE_TIMEOUT);
    function onAbort() { ctrl.abort(); }
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return Promise.reject(abortErr()); }
      signal.addEventListener('abort', onAbort);
    }
    var relay = relayEndpoint();
    var headers = { 'Accept': 'application/vnd.github+json' };
    var init = { headers: headers, signal: ctrl.signal, redirect: 'follow' };
    var target = url;
    if (needRelay()) {
      target = relay;
      init.headers = Object.assign({}, headers, { 'X-Relay-Target': url });
    }
    return fetch(target, init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).finally(function () {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    });
  }

  function relayHint(e) {
    var name = String(e && e.name || '');
    var msg = String(e && e.message || '未知原因');
    if (/HTTP\s+403|HTTP\s+429/.test(msg)) return '站点拒绝抓取（' + msg + '）';
    if (/AbortError/i.test(name) || /超时|timeout/i.test(msg)) {
      return '站点在 ' + Math.round(PAGE_TIMEOUT / 1000) + ' 秒内没有响应';
    }
    /* 这里不武断说「中转没启动」：中转活着、只是目标站连不上时，浏览器拿到的
       也是同一种 TypeError。中转的真实状态由右上角状态灯负责。 */
    if (/Failed to fetch|NetworkError|Load failed|连不上/i.test(msg)) {
      return '抓取失败：站点拒绝连接或本地中转未响应';
    }
    return msg;
  }

  /* ---------------- 正文抽取 ----------------
   * 目标是给模型一份能读的文字，不是还原网页排版；但「有 article 就用、没有就整页」
   * 会把导航、相关阅读、评论区一起送进去（GitHub 仓库页就是典型）。这里按
   * Readability / trafilatura 的思路做：先整块剥掉典型外壳（class / id 命中导航、
   * 推荐、评论等），再在 article → main → 带正文语义的 div/section 里按 <p> 文字量
   * 挑主块。 */
  function stripTags(html) {
    return decodeEnt(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  function plainLen(html) {
    return stripTags(html).length;
  }

  var BOILER_ATTR = /(^|[-_\s])(nav|navbar|menu|breadcrumb|sidebar|side-bar|related|recommend|comment|comments|footer|header|share|social|copyright|advert)([-_\s]|$)/i;
  function stripBoiler(html) {
    return String(html || '').replace(/<(div|section|ul|ol)\b([^>]*)>([\s\S]*?)<\/\1>/gi, function (m, tag, attrs) {
      var a = /(?:id|class)\s*=\s*["']([^"']*)["']/i.exec(attrs);
      return a && BOILER_ATTR.test(a[1]) ? ' ' : m;
    });
  }

  /* 只数 <p> 里的文字：导航、文件列表、相关阅读多用 <li> / <a>，不进正文分。
     这样 `<main>` 这种整页包裹层不会因为「含得多」而稳压内部真正的正文块。 */
  function paraLen(html) {
    var n = 0;
    String(html || '').replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, function (m, inner) {
      n += plainLen(inner);
      return m;
    });
    return n;
  }

  function blockScore(html) {
    var p = paraLen(html);
    if (p < 300 || plainLen(html) < 400) return 0;
    return p;
  }

  function pickTag(src, tag) {
    var re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi');
    var best = '', bestScore = 0, m;
    while ((m = re.exec(src))) {
      var s = blockScore(m[0]);
      if (s > bestScore) { bestScore = s; best = m[0]; }
    }
    return best;
  }

  function pickMainBlock(src) {
    /* article / main 是明确的正文语义，优先采用；
       只有站点用 <div id="content"> 这类写法时，才退回按分数挑 div。 */
    var art = pickTag(src, 'article');
    if (art) return art;
    var main = pickTag(src, 'main');
    if (main) return main;
    var best = '', bestScore = 0, bestLen = 0, m;
    var re = /<(div|section)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:article|content|post|entry|main|text|body)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
    while ((m = re.exec(src))) {
      var s = blockScore(m[0]);
      if (s <= 0) continue;
      var len = plainLen(m[0]);
      if (s > bestScore || (s > bestScore * 0.85 && len < bestLen)) {
        bestScore = Math.max(bestScore, s);
        best = m[0];
        bestLen = len;
      }
    }
    return best;
  }

  function extractPage(html) {
    var raw = String(html || '');
    /* Jina Reader 输出的是 markdown：正文前面压着大量导航、头像与「Subscribe」，
       直接按前 5200 字截断会把频道简介（邮箱通常就在里面）挤掉，这里先清一遍噪音。 */
    if (raw.indexOf('Markdown Content:') >= 0) {
      raw = raw.split('\n').filter(function (line) {
        var t = line.trim();
        if (!t) return false;
        if (/^(Skip navigation|Search|Search with your voice|Sign in|Subscribe|Back|Show more|NaN \/ NaN|Live|Home|Shorts|Subscriptions)$/i.test(t)) return false;
        if (/accounts\.google\.com|yt3\.ggpht\.com|encrypted-tbn\d*\.gstatic\.com|googleusercontent/.test(t)) return false;
        if (/^\[?!\[Image \d+\]/i.test(t)) return false;
        return true;
      }).join('\n');
    }
    var title = '';
    var tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    if (tm) title = clip(decodeEnt(tm[1].replace(/<[^>]+>/g, ' ')), 120);
    if (!title) {
      var og = /<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(raw) ||
               /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i.exec(raw);
      if (og) title = clip(decodeEnt(og[1]), 120);
    }
    if (!title) {
      var h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(raw);
      if (h1) title = clip(decodeEnt(h1[1].replace(/<[^>]+>/g, ' ')), 120);
    }

    /* 外壳块 / 主内容块都必须在「闭合标签转换行」之前处理，否则拿不到完整的 <div>…</div>。 */
    var src = raw
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|template|iframe|object|embed|nav|aside|footer|header|form|button|select|input|textarea)\b[\s\S]*?<\/\1>/gi, ' ');
    src = stripBoiler(src);
    var block = pickMainBlock(src);
    if (block) src = block;
    src = src
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|blockquote|pre|dd|dt|figure|table)>/gi, '\n');

    var text = decodeEnt(src.replace(/<[^>]+>/g, ' '));
    var lines = [];
    text.split('\n').forEach(function (line) {
      var t = line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
      if (t.length < 12) return;
      /* 页眉页脚与功能条：短、且是站点通用话术 */
      if (t.length < 30 && /^(首页|导航|登录|注册|版权|联系我们|广告|分享到|相关推荐|热门推荐|上一篇|下一篇|返回顶部|扫码|关注我们)/.test(t)) return;
      if (lines.length && lines[lines.length - 1] === t) return;
      lines.push(t);
    });
    var body = lines.join('\n');
    return { title: title, text: body.slice(0, MAX_PAGE_TEXT) };
  }

  /* 从正文页里抽出可追踪的线索链接（绝对地址），供第二轮「顺着线索再读两篇」使用。 */
  function extractLinks(raw, baseUrl) {
    var out = [];
    var re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(raw)) && out.length < 80) {
      var href = decodeEnt(m[1]).trim();
      if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
      var abs;
      try { abs = new URL(href, baseUrl).href; } catch (e) { continue; }
      if (!/^https?:\/\//i.test(abs)) continue;
      out.push({ url: abs, text: clip(decodeEnt(m[2].replace(/<[^>]+>/g, ' ')), 90) });
    }
    return out;
  }

  /* 搜索源被限流时，HTML 结果页会整段变空。RSS 出口通常不受影响，
     而且解析成本低（只有标题 / 链接 / 摘要），正好当备用检索源。 */
  function rssSearch(q, signal) {
    var url = 'https://cn.bing.com/search?format=rss&q=' + encodeURIComponent(q);
    return fetchPage(url, signal).then(function (xml) {
      var out = [];
      String(xml || '').replace(/<item>([\s\S]*?)<\/item>/g, function (_, body) {
        var t = /<title>([\s\S]*?)<\/title>/i.exec(body);
        var l = /<link>([\s\S]*?)<\/link>/i.exec(body);
        var d = /<description>([\s\S]*?)<\/description>/i.exec(body);
        var u = l ? decodeEnt(l[1]).trim() : '';
        if (!u || !/^https?:/i.test(u)) return '';
        var desc = decodeEnt(String(d ? d[1] : '')).replace(/<[^>]+>/g, ' ');
        out.push({
          title: clip(decodeEnt(t ? t[1] : u), 120),
          url: u,
          snippet: clip(desc, 360),
          host: hostOf(u),
          rss: true
        });
        return '';
      });
      return out;
    }).catch(function () { return []; });
  }

  /* 第三个出口：360 搜索。Bing 在同一出口连续命中多次会短暂限流，
     换成 360 通常还能拿到结果；结果链接是 /link?m= 跳转，抓正文时由中转跟随。 */
  function soSearch(q, signal) {
    var url = 'https://www.so.com/s?q=' + encodeURIComponent(q);
    return fetchPage(url, signal).then(function (html) {
      var out = [];
      String(html || '').split(/class="res-list/).slice(1).forEach(function (blk) {
        var h = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(blk);
        if (!h) return;
        var link = decodeEnt(h[1]).trim();
        if (!/^https?:\/\//i.test(link)) return;
        /* 360 会在结果区塞图片 / AI 问答的 onebox：它们的正文是「您也可以将图片拖至此处」，
           既不是资料，也会把这种模板文案当成线索带进下一轮检索。 */
        if (/^https?:\/\/(image|pic|ai)\.so\.com\//i.test(link)) return;
        var title = clip(stripTags(h[2]), 120);
        if (!title || /360图片|图片搜索|截屏|上传图片/.test(title)) return;
        var desc = /<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/i.exec(blk);
        var cite = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(blk);
        var host = '';
        var m = /^https?:\/\/([^/?#]+)/i.exec(link);
        if (m) host = m[1].toLowerCase();
        var ct = stripTags(cite ? cite[1] : '').trim().toLowerCase();
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(ct)) host = ct;
        out.push({
          title: title,
          url: link,
          snippet: clip(stripTags(desc ? desc[1] : ''), 360),
          host: host,
          alt: true
        });
      });
      return out;
    }).catch(function () { return []; });
  }

  /* 英文检索式在中文索引里经常只得到词典释义；DDG 的 html 出口对
     「best strategy game youtubers」这类榜单式英文查询稳定得多，作为联系人任务的备用源。 */
  function ddgSearch(q, signal) {
    var url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
    function real(href) {
      var h = decodeEnt(href || '').trim();
      var m = /[?&]uddg=([^&]+)/.exec(h);
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* ignore */ } }
      if (h.indexOf('//') === 0) return 'https:' + h;
      return h;
    }
    return fetchPage(url, signal).then(function (html) {
      var out = [];
      String(html || '').split(/<div class="result results_links/).slice(1).forEach(function (blk) {
        var a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(blk);
        if (!a) return;
        var link = real(a[1]);
        if (!/^https?:\/\//i.test(link) || /duckduckgo\.com\/y\.js/i.test(link)) return;
        var title = clip(stripTags(a[2]), 120);
        if (!title) return;
        var sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(blk);
        out.push({
          title: title,
          url: link,
          snippet: clip(stripTags(sn ? sn[1] : ''), 360),
          host: hostOf(link),
          alt: false,
          ddg: true
        });
      });
      return out.slice(0, 10);
    }).catch(function () { return []; });
  }

  /* 直接问 YouTube：用频道筛选（sp=EgIQAg==）搜「strategy game youtuber」，
     结果就是频道本身，绕开英文搜索站的反爬验证页。浏览器 UA 直连会 502，
     所以统一经 Jina Reader 转成文本；频道名 / @handle 从 markdown 链接里取。 */
  function youtubeChannels(q, signal) {
    var url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAg%253D%253D';
    function push(list, seen, name, link, email, desc) {
      var n = String(name || '').trim();
      /* Jina 的链接文字会把头像 alt 与频道名拼在一起（「X X」），折半去重。 */
      var half = Math.floor(n.length / 2);
      if (n.length % 2 === 0 && half > 1 && n.slice(0, half) === n.slice(half)) n = n.slice(0, half);
      if (!n || n.length < 2 || /^!/.test(n)) return;
      var base = String(link || '').replace(/^http:/, 'https:')
        .replace(/\/(videos|shorts|streams|playlists)$/i, '')
        .replace(/\/about\/?$/i, '')
        .replace(/\/$/, '');
      if (!base || seen[base]) return;
      seen[base] = 1;
      list.push({
        title: clip(n, 80),
        url: base + '/about',
        /* 频道简介能说明「播什么」，判断是不是策略游戏主播全靠它。 */
        snippet: clip(n + (desc ? ' · ' + desc : '') + ' · YouTube 频道', 180),
        host: 'www.youtube.com',
        alt: false,
        yt: true,
        email: email || ''
      });
    }
    function parseMarkdown(text) {
      var out = [];
      var seen = Object.create(null);
      var re = /\[([^\]\n]{2,260})\]\((https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[A-Za-z0-9_.-]+|channel\/UC[A-Za-z0-9_-]+))(?:[^)]*)\)/g;
      var m;
      while ((m = re.exec(String(text || '')))) {
        var txt = decodeEnt(m[1]).replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*/, '');
        var name = txt
          .replace(/\s+@[A-Za-z0-9_.-]+[\s\S]*$/, '')
          .replace(/\s*•[\s\S]*$/, '');
        var desc = txt.replace(/^[\s\S]*?subscribers\s*/i, '').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').trim();
        /* 频道简介里的邮箱就是频道的对外联系方式：不再要求附近出现
           business / email 字样（很多频道只写「Incredibly uninformed. xxx@…」）。 */
        var em = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(m[1]);
        var email = em && emailUsable(em[0]) ? em[0].toLowerCase() : '';
        push(out, seen, name, m[2], email, clip(desc, 120));
      }
      return out;
    }
    function parseHtml(html) {
      var out = [];
      var seen = Object.create(null);
      var re = /"channelRenderer":\{"channelId":"(UC[^"]+)"[\s\S]{0,700}?"title":\{"simpleText":"([^"]+)"/g;
      var m;
      while ((m = re.exec(String(html || '')))) {
        var seg = html.slice(m.index, m.index + 1800);
        var h = /"canonicalBaseUrl":"(\/@[^"]+)"/.exec(seg);
        var name = decodeEnt(m[2]).replace(/\\u([0-9a-f]{4})/gi, function (_, x) {
          return String.fromCharCode(parseInt(x, 16));
        }).replace(/\\"/g, '"');
        push(out, seen, name, h ? 'https://www.youtube.com' + h[1] : 'https://www.youtube.com/channel/' + m[1]);
      }
      return out;
    }
    return readViaJina(url, signal).then(function (text) {
      var out = parseMarkdown(text);
      if (!out.length) out = parseHtml(text);
      /* 检索结果页里的邮箱已经和频道名绑好了，先记下来；
         后续 /about 抓取成功时再按邮箱去重补充来源编号。 */
      out.forEach(function (r) {
        if (!r.email || S.emails.some(function (x) { return x.email === r.email; })) return;
        S.emails.push({ email: r.email, idx: 0, title: r.title, url: r.url, yt: true });
      });
      /* 带着公开邮箱的频道优先排进来，别在截断处被普通频道挤掉。 */
      out.sort(function (a, b) { return (b.email ? 1 : 0) - (a.email ? 1 : 0); });
      return out.slice(0, 12);
    }).catch(function () { return []; });
  }

  /* ---------------- 候选池扫描（程序筛 + AI 判） ----------------
   * 搜索源一次只给十来条，而真正的答案常藏在「工具清单 / 对比帖 / 资源汇总」的外链里。
   * 这里不做整篇精读，而是把每个候选页压成一份「词表」：
   *   标题 + 摘要 + 正文里反复出现的关键词，正文读完就丢。
   * 每 10 条一组交给模型判断「这页值不值得读」，只有被判值得的才进入精读。
   * 分工：程序负责取样与预筛（黑名单、字数、token 命中、外链去重），AI 负责取舍。
   * 这样候选池能放大到上百条，而上下文只随「选中数」增长，不随候选数增长。 */
  /* 候选池可能上百条，HTML 只留最近 60 页：精读还要用，再多就只占内存。 */
  function cacheHtml(url, html) {
    S.pageCache[url] = html;
    var keys = Object.keys(S.pageCache);
    if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(function (k) { delete S.pageCache[k]; });
  }

  function profilePage(item, signal) {
    var ready = S.pageCache[item.url];
    var page = ready ? Promise.resolve(ready)
      : fetchPage(item.url, signal).then(function (html) { cacheHtml(item.url, html); return html; });
    return page.then(function (html) {
      var ex = extractPage(html);
      var text = String((ex && ex.text) || '');
      /* 正文太短的多半是登录墙 / 跳转壳页，连词表都没有，直接判死。 */
      if (text.length < 80 || looksLikeLoginWall(text)) return null;
      return {
        item: item,
        words: harvestKeywords(text, S.query).slice(0, 8),
        links: extractLinks(html, item.url)
      };
    }).catch(function () { return null; });
  }

  function profileScore(p, tokens) {
    var text = (String(p.item.title || '') + ' ' + String(p.item.snippet || '') + ' '
      + p.words.join(' ')).toLowerCase();
    var s = 0;
    tokens.forEach(function (t) { if (t && text.indexOf(t) >= 0) s += 3; });
    if (trustedHost(hostOf(p.item.url))) s += 2;
    if (isCommunity(p.item.url)) s += 1;
    if (p.item.repo) s += 2;
    return s;
  }

  /* 一组 10 条交给模型做取舍。返回 null 表示模型不可用 / 没按格式回答，
     由调用方退回「按词表重合度排序」的纯程序路径。 */
  function judgeBatch(profiles, q) {
    var conn = llmConnSafe();
    if (!profiles.length) return Promise.resolve([]);
    if (!window.LLMRouter || typeof window.LLMRouter.complete !== 'function'
      || !conn || !conn.base || !conn.key || !conn.model) {
      return Promise.resolve(null);
    }
    var lines = profiles.map(function (p, i) {
      return (i + 1) + '. ' + clip(p.item.title || hostOf(p.item.url), 90)
        + ' | ' + hostOf(p.item.url) + ' | ' + (p.words.join(' ') || '无高频词');
    }).join('\n');
    return window.LLMRouter.complete({
      app: APP,
      sys: '你是搜索结果筛选器。判断给出的每篇网页值不值得为回答问题而精读，不写摘要。'
        + '只看标题、站点和页面高频词做判断。输出一行 JSON 数组，元素是值得读的编号，最多 6 个；'
        + '都不值得就输出 []。除了 JSON 不要输出任何文字。',
      messages: [{
        role: 'user',
        content: '问题：' + q + '\n\n候选页（编号 | 标题 | 站点 | 页面高频词）：\n' + lines
          + '\n\n只输出 JSON 数组，例如 [1,3,5]。'
      }],
      opts: { temperature: 0, timeoutMs: 20000 }
    }).then(function (out) {
      var m = String(out || '').match(/\[[\d,\s]*\]/);
      if (!m) return null;
      var idx;
      try { idx = JSON.parse(m[0]); } catch (e) { return null; }
      if (!idx || !idx.length) return [];
      var out2 = [];
      idx.forEach(function (n) {
        var p = profiles[Number(n) - 1];
        if (p && out2.indexOf(p) < 0) out2.push(p);
      });
      return out2;
    }).catch(function () { return null; });
  }

  function expandPool(list, signal) {
    var tokens = relevantTokens(S.query).concat((S.skim && S.skim.keywords) || []);
    var queue = [];
    var seen = Object.create(null);
    var links = [];
    var picked = [];
    var pages = 0;
    var batches = 0;
    var scanned = 0;
    var judged = 0;
    var llmOk = false;
    var startedAt = Date.now();

    function enqueue(items) {
      (items || []).forEach(function (r) {
        if (!r || queue.length >= SCAN_MAX) return;
        var u = String(r.url || '').replace(/#.*$/, '');
        if (!u || seen[u]) return;
        if (blockedReason({ url: u, title: r.title })) return;
        /* 找人任务：YouTube 频道页体积大、扫描价值低，统一交给 crawlSources 走 /about 取邮箱。 */
        if (S.intentKind === 'contact' && /(^|\.)youtube\.com$/i.test(hostOf(u))) return;
        var text = (String(r.title || '') + ' ' + String(r.snippet || '') + ' ' + String(r.link ? '' : u)).toLowerCase();
        var hit = tokens.some(function (t) { return t && text.indexOf(t) >= 0; });
        if (!hit && !r.seed && !r.repo && !r.link && !trustedHost(hostOf(u)) && !isCommunity(u)) return;
        seen[u] = 1;
        queue.push({ title: r.title, url: u, host: r.host || hostOf(u), snippet: r.snippet || '', link: r.link, repo: r.repo, seed: r.seed });
      });
    }
    enqueue(list);

    function scanOne(item) {
      return profilePage(item, signal).then(function (p) {
        scanned++;
        if (p) pages++;
        return p;
      });
    }
    /* 组内也限并发：10 个同时开抓会把中转连接池和站点一起吃满，反而全超时。 */
    function runLimited(items, limit, fn) {
      var out = new Array(items.length);
      var i = 0;
      function worker() {
        if (i >= items.length) return Promise.resolve();
        var k = i++;
        return fn(items[k]).then(function (r) { out[k] = r; return worker(); });
      }
      var ws = [];
      for (var j = 0; j < Math.min(limit, items.length); j++) ws.push(worker());
      return Promise.all(ws).then(function () { return out; });
    }
    function step() {
      if (signal.aborted || !queue.length || picked.length >= PICK_TARGET) return Promise.resolve();
      if (Date.now() - startedAt > SCAN_DEADLINE) return Promise.resolve();
      var batch = queue.splice(0, SCAN_BATCH);
      batches++;
      return runLimited(batch, SCAN_CONCURRENCY, scanOne).then(function (profiles) {
        var ok = profiles.filter(Boolean);
        note('筛读 ' + scanned + ' / ' + (scanned + queue.length) + ' 条 · 选中 ' + picked.length);
        ok.forEach(function (p) { links = links.concat(p.links || []); });
        /* 边扫边扩：本组读到的外链，下一组就能用上。 */
        enqueue(links.map(function (l) {
          return { title: l.text || l.url, url: l.url, host: hostOf(l.url), link: true };
        }));
        return judgeBatch(ok, S.query).then(function (verdict) {
          if (verdict) {
            llmOk = true;
            judged += ok.length;
            verdict.forEach(function (p) { if (picked.indexOf(p) < 0) picked.push(p); });
          } else {
            ok.slice().sort(function (a, b) { return profileScore(b, tokens) - profileScore(a, tokens); })
              .forEach(function (p) {
                if (picked.length < PICK_TARGET && picked.indexOf(p) < 0
                  && profileScore(p, tokens) >= 3) picked.push(p);
              });
          }
          return step();
        });
      });
    }

    return step().then(function () {
      var kw = Object.create(null);
      picked.forEach(function (p) {
        p.words.forEach(function (k) { kw[k] = (kw[k] || 0) + 1; });
      });
      var keys = Object.keys(kw);
      var keywords = keys.filter(function (k) { return kw[k] >= 2; }).slice(0, 6);
      if (!keywords.length) keywords = keys.slice(0, 4);
      /* 一页都没读出来时（反爬 / 超时 / 登录墙），线索只能来自搜索结果本身：
         标题与摘要里反复出现的词，仍然是「下一轮该搜什么」的有效线索，
         否则整个线索追踪会因为抓不到正文而直接断掉。 */
      if (!keywords.length) {
        keywords = harvestKeywords((list || []).map(function (r) {
          return (r.title || '') + ' ' + (r.snippet || '');
        }).join('\n'), S.query).slice(0, 6);
        /* 只在一条结果里出现过的词不算线索：那多半是某个页面的模板文案
           （「您也可以使用 Chrome…」这类），拿去当下一轮检索式只会越跑越偏。
           要求至少在两条不同结果里出现。 */
        var rows = (list || []).map(function (r) {
          return ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
        });
        keywords = keywords.filter(function (k) {
          var hit = 0;
          for (var j = 0; j < rows.length; j++) {
            if (rows[j].indexOf(k.toLowerCase()) >= 0) hit++;
          }
          return hit >= 2;
        });
      }
      var linkCands = [];
      var seenL = Object.create(null);
      links.forEach(function (l) {
        var host = hostOf(l.url);
        if (!l.text || l.text.length < 4 || !host) return;
        if (seenL[l.url] || blockedReason({ url: l.url, title: l.text })) return;
        seenL[l.url] = 1;
        linkCands.push({ title: clip(l.text, 120), url: l.url, host: host, link: true });
      });
      /* 被选中的页要留给精读，别让缓存淘汰把它们挤掉（否则又要重抓一遍）。 */
      picked.forEach(function (p) {
        var u = p.item.url;
        if (!S.pageCache[u]) return;
        var html = S.pageCache[u];
        delete S.pageCache[u];
        S.pageCache[u] = html;
      });
      return {
        pages: pages,
        batches: batches,
        judged: judged,
        llm: llmOk,
        keywords: keywords,
        links: linkCands,
        cands: linkCands,
        picks: picked.map(function (p) { return p.item; }),
        urls: Object.keys(seen)
      };
    });
  }

  /* 候选池打分：实词命中 > 粗读关键词 > 可信域名 > 社区口碑，
     再叠加搜索名次衰减；每站最多两条，避免榜单被同一站刷满。 */
  function rankPool(list, q) {
    var tokens = relevantTokens(q);
    var kws = (S.skim && S.skim.keywords) || [];
    var contact = inferIntent(q).kind === 'contact';
    var seen = Object.create(null);
    var seenTitle = Object.create(null);
    var scored = [];
    (list || []).forEach(function (r, i) {
      var u = String(r.url || '').replace(/#.*$/, '');
      if (!u || seen[u]) return;
      seen[u] = 1;
      /* 外链候选没经过 cleanResults：同一篇教程被多个搬运站收录时标题一字不差，
         按标题再去一次，避免精读名额被同一篇文章占满。 */
      var tk = String(r.title || '').replace(/[\s\-_|｜:：,，。.!！?？"'“”‘’()（）\[\]【】]+/g, '').toLowerCase();
      if (tk.length > 8) {
        /* 用前缀做键：搬运站会截断长标题，后半段不同但其实是同一篇。 */
        var key = tk.slice(0, 30);
        if (seenTitle[key]) return;
        seenTitle[key] = 1;
      }
      var host = r.host || hostOf(u);
      var text = (String(r.title || '') + ' ' + String(r.snippet || '') + ' ' + u).toLowerCase();
      var score = 0;
      tokens.forEach(function (t) { if (text.indexOf(t) >= 0) score += 3; });
      kws.forEach(function (t) { if (t.length > 2 && text.indexOf(t) >= 0) score += 2; });
      if (trustedHost(host)) score += 3;
      if (r.seed) score += 5;
      if (r.repo) score += 4;
      if (isCommunity(u)) score += 1;
      /* 筛读阶段被 AI 判为「值得读」的，优先进入结果与精读名单。 */
      if (r.pick) score += 6;
      /* AI 辅助脚本给出的加权：只影响排序，不改变结果是否保留。 */
      if (r.assistScore) score += r.assistScore;
      /* 找人 / 邮箱：频道页、榜单页、含联系方式的页面优先，否则会被泛新闻挤出精读名额。 */
      if (contact) {
        if (CONTACT_HINT.test(text)) score += 7;
        if (/(best|top|榜单|排行|频道|channels|邮箱|e-?mail|contact)/i.test(text)) score += 4;
        if (/(如何|怎么|教程|攻略|指南|推广策略)/.test(text)) score -= 4;
        /* 简介里已经写明商务邮箱的频道，就是最直接的答案。 */
        if (r.email) score += 8;
      }
      score += Math.max(0, 4 - Math.floor(i / 4));
      /* 外链候选没有搜索名次，必须自己挣到相关性，否则会混进一堆导航链接。 */
      if (r.link && score < 3) return;
      scored.push({ r: r, host: host, score: score, i: i });
    });
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var out = [];
    var siteCount = Object.create(null);
    scored.forEach(function (x) {
      /* 找人任务要读一串频道，10 条不够把「像目标品类」和「有公开邮箱」两类都覆盖到。 */
      if (out.length >= (contact ? 12 : MAX_RESULTS)) return;
      var site = siteOf(x.host);
      /* 备用源（360）的结果链接都指向 so.com 跳转，不能按站点配额压掉。
         仓库页不设小配额：搜「开源 xx 模板」时，真正的答案就是这一串仓库。 */
      var cap = x.r.alt ? MAX_RESULTS : (/(^|\.)github\.com$/.test(site) ? MAX_RESULTS : 2);
      /* 找主播邮箱时，多个频道页同属 youtube.com，每个频道都是一条独立答案。 */
      if (contact && /(^|\.)youtube\.com$/.test(site)) cap = 12;
      if ((siteCount[site] || 0) >= cap) return;
      siteCount[site] = (siteCount[site] || 0) + 1;
      out.push(x.r);
    });
    return out;
  }

  /* 抓取队列：并发 3，每读完一篇就刷新来源状态，用户能看到进度而不是干等。 */
  function crawlSources(list, signal) {
    var cursor = 0;
    var workers = [];
    var n = Math.min(CRAWL_CONCURRENCY, list.length);
    function worker() {
      if (cursor >= list.length) return Promise.resolve();
      var s = list[cursor++];
      if (signal.aborted) return Promise.resolve();
      /* 找人任务抓到的是频道主页：主页没有商务邮箱，直接改抓同一频道的 /about。 */
      if (S.intentKind === 'contact') {
        var about = channelAbout(s.url);
        if (about) s.url = about;
      }
      s.status = 'loading';
      renderSources();
      var ready = S.pageCache[s.url];
      var page = ready ? Promise.resolve(ready) : fetchPage(s.url, signal).then(function (html) {
        S.pageCache[s.url] = html;
        return html;
      });
      return page.then(function (html) {
        if (S.intentKind === 'contact') recordEmails(html, s);
        var ex = extractPage(html);
        s.links = extractLinks(html, s.url);
        /* 知乎 / 百科在未登录时会给一整页「登录后查看」：不能当正文，也不能拿去抽词。 */
        var wall = looksLikeLoginWall(ex.text);
        if (ex.text && ex.text.length >= 160 && !wall) {
          s.text = ex.text;
          s.title = ex.title || s.title;
          s.chars = ex.text.length;
          s.status = 'read';
        } else {
          s.text = s.snippet || '';
          s.chars = s.text.length;
          s.status = 'snippet';
          s.err = wall ? '需要登录 / 反爬校验' : '正文过短';
        }
      }).catch(function (e) {
        if (e && e.name === 'AbortError') { s.status = 'pending'; return; }
        s.text = s.snippet || '';
        s.chars = s.text.length;
        s.status = 'snippet';
        s.err = (e && e.message) || '抓取失败';
      }).then(function () {
        renderSources();
        renderResults();
        updatePhaseText();
        return worker();
      });
    }
    for (var i = 0; i < n; i++) workers.push(worker());
    return Promise.all(workers);
  }

  /* 站内链接不是线索：github.com 页面里的 docs.github.com / learn.github.com
     属于同一站点，追过去只会多读两篇导航页。按后两段域名粗判同站。 */
  function siteOf(host) {
    var parts = String(host || '').toLowerCase().split('.');
    return parts.slice(-2).join('.');
  }

  /* YouTube 频道主页不会直接暴露商务邮箱，/about 页才会；
     顺着榜单页找到频道链接后，统一补成 /about 再抓一次。 */
  function channelAbout(u) {
    if (!/(^|\.)youtube\.com$/i.test(hostOf(u))) return '';
    var p = '';
    try { p = new URL(u).pathname || ''; } catch (e) { return ''; }
    if (/\/about\/?$/i.test(p)) return 'https://www.youtube.com' + p.replace(/\/$/, '');
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/i.test(p)) {
      return 'https://www.youtube.com' + p.replace(/\/$/, '') + '/about';
    }
    return '';
  }

  /* 顺着线索再读两篇：从已读页面的出站链接里挑与问题最相关、且不在已读站点内的，
     再抓一轮。很多工具站不会直接出现在搜索结果里，但会出现在「XX 工具清单」页的链接里。 */
  function followTrail(q, signal) {
    var tokens = relevantTokens(q);
    var kwTokens = (S.skim && S.skim.keywords) || [];
    var contact = inferIntent(q).kind === 'contact';
    var hosts = Object.create(null);
    var sites = Object.create(null);
    var urls = Object.create(null);
    S.sources.forEach(function (s) {
      var h = s.host || hostOf(s.url);
      hosts[h] = 1;
      sites[siteOf(h)] = 1;
      urls[String(s.url).replace(/#.*$/, '')] = 1;
    });
    /* 粗读过的页面也算「读过了」：不再重复抓，也不把它自己的站内链接当线索。 */
    ((S.skim && S.skim.urls) || []).forEach(function (u) {
      var h = hostOf(u);
      if (h) { hosts[h] = 1; sites[siteOf(h)] = 1; }
      urls[String(u).replace(/#.*$/, '')] = 1;
    });
    var pools = S.sources.map(function (s) { return { links: s.links || [], url: s.url, host: s.host }; });
    if (S.skim && S.skim.links && S.skim.links.length) {
      pools.push({ links: S.skim.links });
    }
    var cands = [];
    var pickedSites = Object.create(null);
    pools.forEach(function (s) {
      (s.links || []).forEach(function (l) {
        var u = String(l.url || '').replace(/#.*$/, '');
        if (!u) return;
        /* 联系方式任务：频道根路径直接改抓 /about；其余链接按原逻辑走。 */
        var about = contact ? channelAbout(u) : '';
        var target = about || u;
        if (urls[target]) return;
        var host = hostOf(target);
        if (!host) return;
        /* 找人任务只跟频道 /about，不跟视频页（视频页没有联系方式且体积极大）。 */
        if (contact && /(^|\.)youtube\.com$/i.test(host) && !about) return;
        /* 普通任务按站点去重；找人任务允许多个 YouTube 频道同站并存。 */
        if (!contact && (hosts[host] || sites[siteOf(host)])) return;
        if (contact && !about && (hosts[host] || sites[siteOf(host)])) return;
        if (!contact && pickedSites[siteOf(host)]) return;
        if (blockedReason({ url: target, title: l.text })) return;
        var low = (l.text + ' ' + u).toLowerCase();
        var score = 0;
        tokens.forEach(function (t) { if (low.indexOf(t) >= 0) score += t.length > 3 ? 3 : 2; });
        /* 粗读捞到的关键词是「同义线索」：不要求它出现在问题里，命中就加权。 */
        kwTokens.forEach(function (t) { if (t.length > 2 && low.indexOf(t) >= 0) score += 2; });
        /* 官网链接的锚文本常常只写品牌名（Meshy / Tripo / OpenRA），不含问题里的词。
           这类链接恰恰是我们要找的，所以可信域名单独给分，不强制词命中。 */
        if (trustedHost(host)) score += 3;
        if (about) score += 8;
        if (!score) return;
        urls[target] = 1;
        if (!contact) pickedSites[siteOf(host)] = 1;
        cands.push({ url: target, text: l.text, host: host, score: score });
      });
    });
    cands.sort(function (a, b) { return b.score - a.score; });
    var picks = cands.slice(0, contact ? 3 : 2);
    if (!picks.length) return Promise.resolve();
    var extra = picks.map(function (c, i) {
      return {
        idx: S.sources.length + i + 1, title: c.text || c.host, url: c.url, host: c.host,
        snippet: '', text: '', chars: 0, status: 'pending', err: '', trail: true
      };
    });
    S.sources = S.sources.concat(extra);
    renderSources();
    return crawlSources(extra, signal);
  }

  /* ---------------- 提示词 ---------------- */
  function systemPrompt() {
    if (S.mode === 'media') {
      return '你是「智搜」的影视来源助手。用户想找一部电影或剧集的免费观看渠道，资料只来自官方视频平台或公共版权库。\n'
        + '请遵守：\n'
        + '1. 只依据资料回答，不要凭记忆补片源；资料里没有就直说「没有找到官方片源」。\n'
        + '2. 简体中文。先用一句话给结论（哪个官方平台可免费看 / 需会员 / 只有预告），再按平台分点。\n'
        + '3. 每个结论的句末标注来源编号，例如 [1]；编号只能来自资料列表。\n'
        + '4. 严格区分：免费（可能含广告）、免费试看、需会员、仅预告、待确认。\n'
        + '5. 不推荐任何非官方站点，不提供下载、磁力、网盘链接。\n'
        + '6. 提醒地区限制与版权变动；资料未注明日期就说明。\n'
        + '7. 不要输出网址列表（平台卡片由界面负责），正文里只保留编号引用。\n'
        + '8. 今天是 ' + today() + '。';
    }
    return '你是「智搜」的阅读助手。用户提出一个问题，系统已经抓取了若干网页正文作为资料。\n'
      + '请遵守：\n'
      + '1. 只依据资料回答，不要用训练时的旧知识补细节；资料不足就直说「资料不足以确定」，并说明缺什么。\n'
      + '2. 简体中文。先用 2–4 句给出结论，再用短列表展开关键信息。\n'
      + '3. 每个关键事实的句末标注来源编号，例如 [1] 或 [2][4]；编号只能来自资料列表。\n'
      + '4. 资料互相矛盾时并列说明分歧，不要强行统一。\n'
      + '5. 不复述原文超过两句，用转述；不写「根据资料」「以下是」这类空话。\n'
      + '6. 不要输出网址列表（来源卡片由界面负责），正文里只保留编号引用。\n'
      + '7. 今天是 ' + today() + '；涉及时效的信息要注明资料的日期或「资料未注明日期」。'
      + (S.intentKind === 'contact'
        ? '\n8. 用户要的是具体人物 / 团队的联系方式：只列与目标人物或频道明确绑定的公开邮箱，并标来源编号；不要把平台客服、站点投稿、无关公司的邮箱当作答案；找不到就直说「没有找到公开邮箱」。'
        : '');
  }

  function userPrompt(q, sources, local) {
    var usable = sources.filter(function (s) { return s.text; });
    /* 本机模型（Ollama 等）多跑在 CPU / 小显存上，6000 字上下文要等十几分钟，
       所以本地连接只喂最靠前的 3 篇、每篇 1200 字；邮箱清单不受影响，仍然完整附上。 */
    var perSource = local ? 1200 : PROMPT_PER_SOURCE;
    if (local) usable = usable.slice(0, 3);
    var kw = (S.skim && S.skim.keywords) || [];
    var list = usable.map(function (s) {
      var head = '[' + s.idx + '] ' + s.title + '\n';
      if (S.mode === 'media') {
        var site = mediaSite(s.host);
        head += '平台：' + (site ? site.name : s.host) + '｜页面判定：' + MEDIA_STATUS[s.media || 'unknown'] + '\n';
      }
      var base = pickRelevant(s.text, q, perSource,
        S.intentKind === 'contact' ? relevantTokens(q) : []);
      /* 补充精读：粗读捞到的关键词再做一遍段落检索，把「同义但没出现问题词」的部分补上。 */
      var extra = (!local && kw.length) ? supplementText(s.text, base, kw, PROMPT_EXTRA) : '';
      return head + s.url + '\n' + base + (extra ? '\n（补充摘录）\n' + extra : '');
    }).join('\n\n');
    return '用户问题：' + q + '\n\n资料（共 ' + usable.length + ' 篇，已去除广告与导航）：\n' + list + (S.intentKind === 'contact' ? emailBlock() : '');
  }

  /* 没有模型时的降级：不假装给了答案，只把正文摘录摆出来，并说明如何配置。 */
  function fallbackAnswer(sources) {
    var usable = sources.filter(function (s) { return s.text; });
    var out = ['**未能生成 AI 摘要：语言模型未配置或暂时不可用。**', '', '下面是已抓取到的网页正文摘录，可直接点来源核对：'];
    if (S.intentKind === 'contact' && S.emails.length) {
      out.push('', '**程序从页面抽到的公开邮箱：**');
      S.emails.forEach(function (x) {
        var n = emailIdx(x);
        out.push('- ' + x.email + ' ← ' + (n ? '[' + n + '] ' : '') + x.title);
      });
    }
    usable.forEach(function (s) {
      out.push('');
      out.push('**[' + s.idx + '] ' + s.title + '**');
      out.push('> ' + clip(s.text, 320));
    });
    return out.join('\n');
  }

  function llmConnSafe() {
    try {
      if (typeof llmConn === 'function') return llmConn();
    } catch (e) { /* 未配置 */ }
    return null;
  }

  /* 本机模型判定：只认回环地址，别把内网自建的推理服务误当成「慢机器」。 */
  function isLocalBase(base) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(String(base || ''));
  }

  /* ---------------- 邮箱抽取 ----------------
   * 找人任务真正要交付的是「哪个频道 → 哪个邮箱」。模型只能读摘要，
   * 所以程序先把页面里的公开邮箱抽出来，连同来源一起交给模型判断归属。 */
  function cfEmails(raw) {
    var out = [];
    var re = /data-cfemail="([0-9a-f]+)"/gi;
    var m;
    while ((m = re.exec(raw))) {
      try {
        var k = parseInt(m[1].slice(0, 2), 16);
        var s = '';
        for (var i = 2; i < m[1].length; i += 2) {
          s += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16) ^ k);
        }
        out.push({ email: s, at: m.index });
      } catch (e) { /* ignore */ }
    }
    return out;
  }
  function emailUsable(e) {
    e = String(e || '').toLowerCase().replace(/^mailto:/, '');
    if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false;
    if (/\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$/.test(e)) return false;
    var domain = e.split('@')[1];
    /* 平台客服 / 法务邮箱不是主播邮箱，留着只会污染答案。 */
    if (/^(youtube\.com|google\.com|gstatic\.com|bilibili\.com|douyin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com)$/.test(domain)) return false;
    var local = e.split('@')[0];
    if (/^(noreply|no-reply|donotreply|privacy|abuse|postmaster|webmaster|dmca)$/.test(local)) return false;
    return true;
  }
  function recordEmails(html, s) {
    if (!html || !s) return;
    var raw = String(html);
    var found = [];
    var re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    var m;
    while ((m = re.exec(raw))) found.push({ email: m[0], at: m.index });
    cfEmails(raw).forEach(function (x) { found.push(x); });
    found.forEach(function (f) {
      var email = String(f.email || '').toLowerCase();
      if (!emailUsable(email)) return;
      var ctx = raw.slice(Math.max(0, f.at - 140), f.at + email.length + 140);
      var contactish = /business|contact|inquir|合作|商务|联系|邮箱|e-?mail|mailto/i.test(ctx);
      if (!contactish) return;
      if (S.emails.some(function (x) { return x.email === email; })) return;
      S.emails.push({
        email: email,
        idx: s.idx || 0,
        title: s.title || hostOf(s.url) || '',
        url: s.url || '',
        yt: /(^|\.)youtube\.com$/i.test(hostOf(s.url) || '')
      });
    });
  }
  /* 频道检索阶段记下的邮箱还没有来源编号：按 URL 回 S.sources 里找对应编号。 */
  function emailIdx(x) {
    if (x.idx) return x.idx;
    var u = String(x.url || '').replace(/\/about\/?$/i, '');
    var hit = (S.sources || []).filter(function (s) {
      return s && String(s.url || '').replace(/\/about\/?$/i, '') === u;
    })[0];
    return hit ? hit.idx : 0;
  }
  function emailBlock() {
    if (!S.emails.length) return '';
    var seen = Object.create(null);
    var lines = [];
    S.emails.forEach(function (x) {
      if (seen[x.email]) return;
      seen[x.email] = 1;
      var n = emailIdx(x);
      lines.push('- ' + x.email + ' ← ' + (n ? '[' + n + '] ' : '') + x.title + (x.yt ? '（YouTube 频道页）' : ''));
    });
    return '\n\n程序从抓取页面中抽到的公开邮箱（可能混有站点邮箱，只保留属于目标人物的）：\n' + lines.join('\n');
  }

  /* ---------------- 意图理解 ----------------
   * 「找工具」和「查报错」需要完全不同的检索式与线索来源：
   * 找工具要多问「工具 / 推荐」，资源类要落到 GitHub，排错要找具体报错和解决帖。
   * 这一步决定接下来用哪种说法再问一次，而不是盲目短语料。 */
  var INTENTS = [
    { kind: 'contact', label: '找人 / 联系方式', re: /(邮箱|邮件|联系方式|商务合作|合作邮箱|contact|e-?mail|inquir)/i, adds: ['商务合作 邮箱'] },
    { kind: 'tool', label: '找工具 / 选型', re: /(工具|网站|平台|软件|生成器|在线|推荐|哪个|好用|替代)/i, adds: ['工具', '推荐'] },
    { kind: 'trouble', label: '排查 / 解决', re: /(报错|错误|失败|无法|不能|解决|修复|崩溃|闪退)/i, adds: ['解决', '教程'] },
    { kind: 'learn', label: '学习 / 上手', re: /(怎么|如何|教程|入门|学习|配置|安装|使用)/i, adds: ['教程', '入门'] },
    { kind: 'resource', label: '找资源 / 源码', re: /(下载|资源|模板|素材|开源|源码|项目|仓库)/i, adds: ['开源', 'github'] }
  ];
  function inferIntent(q) {
    for (var i = 0; i < INTENTS.length; i++) {
      if (INTENTS[i].re.test(q)) {
        return { kind: INTENTS[i].kind, label: INTENTS[i].label, adds: INTENTS[i].adds };
      }
    }
    return { kind: 'general', label: '通用资料', adds: ['经验'] };
  }

  /* 「找主播邮箱」这类任务，中文检索只能拿到平台新闻；真正有邮箱的是
     YouTube 频道 /about 页，所以先把品类译成英文，再用榜单式检索式找频道。 */
  var CONTACT_SUBJECT = [
    [/策略游戏|策略类|strategy\s*games?/i, 'strategy game'],
    [/射击游戏|shooter/i, 'shooter game'],
    [/角色扮演|rpg/i, 'rpg'],
    [/沙盒|sandbox/i, 'sandbox game'],
    [/赛车|racing/i, 'racing game'],
    [/游戏|game/i, 'game']
  ];
  function contactSubject(q) {
    for (var i = 0; i < CONTACT_SUBJECT.length; i++) {
      if (CONTACT_SUBJECT[i][0].test(q)) return CONTACT_SUBJECT[i][1];
    }
    return '';
  }
  function contactQueries(q) {
    var subj = contactSubject(q);
    if (!subj) return [];
    var role = /(主播|博主|up主|youtuber|streamer|创作者|creator)/i.test(q) ? 'youtuber' : 'creator';
    return [
      'best ' + subj + ' ' + role + 's',
      /* 去掉 best、用单数，YouTube 反而更认品类词：会回这个品类本身的频道，
         而不是被「best」带偏到泛游戏 / 手游频道。 */
      subj + ' ' + role
    ].concat(contactSyn(q).map(function (w) { return w + ' ' + role; })).slice(0, 4);
  }

  /* 社区页（贴吧 / 知乎 / 豆瓣 / Reddit / V2EX / Stack Overflow）的价值不在正文，
     而在「大家都提到哪个工具、换成什么就好了」—— 这些词才是下一轮检索式。 */
  var COMMUNITY_HOST = /(^|\.)(tieba\.baidu\.com|zhihu\.com|douban\.com|reddit\.com|v2ex\.com|stackoverflow\.com|nga\.cn|ngabbs\.com|bilibili\.com|juejin\.cn|csdn\.net)$/i;
  function isCommunity(url) {
    return COMMUNITY_HOST.test(hostOf(url));
  }

  /* ---------------- 自主尝试 ----------------
   * 检索不是「发一次请求就完事」：每一轮先判断结果是否真的回答了问题，
   * 不理想就换措辞、换检索源，或顺着已读页面的链接继续找。
   * 每步都写进 S.trace，用户展开「检索思路」就能看到为什么换了问法。 */
  function judge(list, q) {
    var tokens = relevantTokens(q);
    var hit = 0;
    (list || []).forEach(function (r) {
      if (relevantTo({ title: r.title, snippet: r.snippet, url: r.url }, tokens)) hit++;
    });
    /* 联系方式任务不能只按中文字面判命中：一篇「主播新闻」也会命中「主播」，
       但它给不了邮箱。必须看到频道 / 邮箱 / 联系这类信号才算真的答上。 */
    if (inferIntent(q).kind === 'contact') {
      var strong = 0;
      (list || []).forEach(function (r) {
        var t = String(r.title || '') + ' ' + String(r.snippet || '') + ' ' + String(r.url || '');
        if (CONTACT_ANSWER.test(t) || YT_CHANNEL.test(String(r.url || ''))) strong++;
      });
      return { total: (list || []).length, hit: strong, ok: strong >= 2 || (strong >= 1 && (list || []).length <= 2) };
    }
    var ok = hit >= 2 || (hit >= 1 && list.length <= 2);
    return { total: (list || []).length, hit: hit, ok: ok };
  }

  function trace(step) {
    step.ms = S.startedAt ? Date.now() - S.startedAt : 0;
    S.trace.push(step);
    renderTrace();
  }

  /* 诊断一步：把「失败现象 → 本质原因 → 下一步动作」写进链路，
     用户能看到它为什么失败、正在换什么办法，而不是只看到一句「失败」。 */
  function diag(text, reason, action) {
    trace({ kind: '诊断', text: text + '：' + reason, res: action, ok: false });
  }

  /* 实时进度：检索/粗读的过程中把「正在做什么」写进状态栏，页面始终可交互。 */
  function note(text) {
    S.liveNote = text;
    updatePhaseText();
  }

  function renderTrace() {
    var box = $('.ais-trace');
    if (!box) return;
    box.classList.toggle('hidden', !S.trace.length);
    var brief = $('.ais-trace-brief');
    if (brief) {
      var ok = S.trace.filter(function (t) { return t.ok; }).length;
      brief.textContent = S.trace.length ? S.trace.length + ' 步 · ' + ok + ' 步有收获' : '';
    }
    var list = $('.ais-trace-list');
    if (!list) return;
    list.innerHTML = S.trace.map(function (t) {
      return '<li class="ais-trace-item is-' + (t.ok ? 'ok' : 'miss') + '">' +
        '<span class="ais-trace-kind">' + esc(t.kind) + '</span>' +
        '<span class="ais-trace-text">' + esc(t.text) + '</span>' +
        '<span class="ais-trace-res">' + esc(t.res) + '</span>' +
        (t.ms ? '<span class="ais-trace-ms">' + (t.ms / 1000).toFixed(1) + 's</span>' : '') +
      '</li>';
    }).join('');
  }

  /* 精读名额：官网种子最多占两篇。Meshy / Tripo 这类站经常卡到超时，
     五个名额全押在种子上，结果就是「一篇正文都没读到」。 */
  function pickForRead(list, n) {
    var out = [];
    var seeds = 0;
    list.forEach(function (r) {
      if (out.length >= n) return;
      if (r.seed) {
        if (seeds >= 2) return;
        seeds++;
      }
      out.push(r);
    });
    return out;
  }

  /* ---------------- AI 辅助脚本 ----------------
   * 让语言模型在检索阶段写一段临时 JavaScript（补充检索式 / 淘汰页面 / 打分）。
   * 代码不在本页执行：App 与桌面桥同渲染进程，eval 或 new Function 能直接读
   * localStorage 与 window.openagiDesktop。这里把代码丢进 sandbox iframe：
   *   · 没有 allow-same-origin → 独立的不透明源，摸不到父页存储；
   *   · 内嵌 CSP default-src 'none' → 没有网络、没有外部资源；
   *   · 只喂候选页的纯数据，2 秒超时，超时或异常都退回原结果。
   * 模型返回值仍要过一遍结构校验：检索式长度、URL 必须真实存在于候选池。 */
  var ASSIST_MAX_QUERIES = 3;
  var ASSIST_SCORE_MIN = -5;
  var ASSIST_SCORE_MAX = 5;
  var ASSIST_TIMEOUT = 2000;

  /* 沙箱载荷：只放纯数据，不放 DOM、不放连接、不放全局对象引用。 */
  function assistCandidates(results) {
    return (results || []).slice(0, 24).map(function (r, i) {
      return {
        i: i,
        title: clip(r.title || r.url || '', 120),
        url: String(r.url || ''),
        site: hostOf(r.url),
        snippet: clip(r.snippet || '', 160)
      };
    });
  }

  function assistScriptPrompt(q, results) {
    var lines = assistCandidates(results).map(function (c) {
      return c.i + '. ' + c.title + ' | ' + c.site + ' | ' + (c.snippet || '暂无摘要');
    }).join('\n');
    return {
      sys: '你是智搜的检索辅助脚本生成器。你输出一段 JavaScript 函数体，系统会在隔离沙箱里用候选数据调用它。\n'
        + '只输出 JSON：{"name":"不超过16字","code":"JavaScript 函数体"}\n'
        + '沙箱里没有网络、没有存储、没有 DOM，只有参数 data，必须同步 return 一个对象。\n'
        + 'data = {"question":原问题,"primary":主检索式,"results":[{"i","title","url","site","snippet"}]}\n'
        + '返回结构：{"queries":[补充检索式],"drop":[要淘汰的 url],"score":{"url":分值}}\n'
        + '规则：\n'
        + '1. queries 最多 3 条，要提出比原问题更具体的新方向（版本号、专有名词、对比、官方文档等），不能复述原句；\n'
        + '2. drop 只能写 data.results 里真实存在的 url，只淘汰明显无关的页（排行榜、下载站、其他主题）；\n'
        + '3. score 只给 data.results 里真实存在的 url，分值 -5 到 5，直接决定最终排序；\n'
        + '4. code 里不要用反引号，不要输出解释文字；没有把握就返回空数组 / 空对象；\n'
        + '5. 你必须先读标题与摘要再判断，不要凭空编造页面。\n'
        + '示例：{"name":"补官方文档","code":"var out=[];data.results.forEach(function(r){if(/官方|文档/.test(r.title))out.push(r.url)});return {queries:[\'React 19 useActionState 官方文档\'],drop:[],score:out.reduce(function(m,u){m[u]=3;return m},{})}"}',
      user: '用户问题：' + q + '\n\n候选页（编号 | 标题 | 站点 | 摘要）：\n' + (lines || '（无）')
        + '\n\n只输出 JSON。'
    };
  }

  /* 模型输出可能夹带解释文字：取第一个大括号块，只接受 {name, code}。 */
  function parseAssistScript(raw) {
    var m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    var o;
    try { o = JSON.parse(m[0]); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    var code = String(o.code || '').trim();
    if (!code || code.length > 4000) return null;
    /* 死循环会把沙箱所在线程占满，超时定时器也跟着停摆；显式拦掉最常见的两种写法。 */
    if (/while\s*\(\s*(true|1)\s*\)/i.test(code) || /for\s*\(\s*;\s*;\s*\)/i.test(code)) return null;
    return { name: clip(o.name || '检索辅助', 24), code: code };
  }

  /* 沙箱执行：srcdoc 里注册一次性的 message 监听，用 new Function 跑模型代码。
     父页只等一条带 token 的回包，超时直接拆掉 iframe。 */
  function runAssistSandbox(code, payload, timeoutMs) {
    return new Promise(function (resolve) {
      var token = 'as_' + Math.random().toString(36).slice(2);
      var done = false;
      function finish(out) {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        try { if (frame.parentNode) frame.parentNode.removeChild(frame); } catch (e) { /* 忽略 */ }
        resolve(out);
      }
      function onMsg(e) {
        if (!e.data || e.data.__assist !== token) return;
        finish(e.data.ok ? { ok: true, out: e.data.out } : { ok: false, err: e.data.err });
      }
      var html = '<!doctype html><meta charset="utf-8">'
        + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'">'
        + '<script>'
        + 'window.addEventListener("message",function(ev){'
        + 'var d=ev.data||{};if(!d.__run)return;'
        + 'function back(ok,v){parent.postMessage({__assist:d.token,ok:ok,out:ok?v:undefined,err:ok?undefined:v},"*");}'
        + 'function run(code){var f=new Function("data",code);return f(d.payload);}'
        + 'function deliver(r){if(r&&typeof r.then==="function"){r.then(function(v){back(true,v)},function(e){back(false,String(e&&e.message||e))});}else back(true,r);}'
        + 'try{deliver(run(d.code));}catch(err){'
        /* 模型偶尔多写一个收尾大括号；只在首次语法失败后去掉末尾一个 } 重试。 */
        + 'try{deliver(run(String(d.code).replace(/\}\\s*$/,"")));}catch(e2){back(false,String(err&&err.message||err));}'
        + '}});'
        + '<\/script>';
      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0';
      frame.srcdoc = html;
      /* srcdoc 的内联脚本在解析期就注册好监听，load 之后再投递不会丢。 */
      frame.onload = function () {
        try {
          frame.contentWindow.postMessage({ __run: 1, token: token, code: code, payload: payload }, '*');
        } catch (e) { finish({ ok: false, err: 'postMessage failed' }); }
      };
      window.addEventListener('message', onMsg);
      document.body.appendChild(frame);
      setTimeout(function () { finish({ ok: false, err: 'timeout' }); }, timeoutMs || ASSIST_TIMEOUT);
    });
  }

  /* 结构校验：只接受候选池里真实存在的 URL；检索式不许复述原句；分值夹在 -5~5。 */
  function acceptAssistResult(out, results, q) {
    if (!out || typeof out !== 'object') return null;
    var urls = Object.create(null);
    (results || []).forEach(function (r) { urls[r.url] = 1; });

    var queries = [];
    (Array.isArray(out.queries) ? out.queries : []).forEach(function (x) {
      var s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
      if (s.length < 2 || s.length > 60) return;
      var low = s.toLowerCase();
      if (low === String(q || '').toLowerCase()) return;
      if (queries.some(function (y) { return y.toLowerCase() === low; })) return;
      if (queries.length < ASSIST_MAX_QUERIES) queries.push(s);
    });

    var drop = [];
    (Array.isArray(out.drop) ? out.drop : []).forEach(function (u) {
      var s = String(u || '').trim();
      if (!urls[s] || drop.indexOf(s) >= 0) return;
      drop.push(s);
    });

    var score = Object.create(null);
    var scored = 0;
    if (out.score && typeof out.score === 'object') {
      Object.keys(out.score).forEach(function (u) {
        if (!urls[u]) return;
        var n = Number(out.score[u]);
        if (!isFinite(n)) return;
        n = Math.max(ASSIST_SCORE_MIN, Math.min(ASSIST_SCORE_MAX, n));
        if (!n) return;
        score[u] = n;
        scored++;
      });
    }

    if (!queries.length && !drop.length && !scored) return null;
    return { queries: queries, drop: drop, score: score };
  }

  /* 应用脚本结果：drop 不能把候选清空（真删光就整批保留）；打分累加进 rankPool。 */
  function applyAssistResult(act, results) {
    var dropSet = Object.create(null);
    act.drop.forEach(function (u) { dropSet[u] = 1; });
    var keepAll = !(results || []).some(function (r) { return !dropSet[r.url]; });

    var dropped = 0;
    var boosted = 0;
    var kept = [];
    (results || []).forEach(function (r) {
      if (!keepAll && dropSet[r.url]) { dropped++; return; }
      var add = act.score[r.url] || 0;
      if (add) { r.assistScore = (r.assistScore || 0) + add; boosted++; }
      kept.push(r);
    });
    return { list: kept, drop: dropped, boost: boosted };
  }

  /* 只在检索阶段接一次：模型不可用、脚本非法、超时或用户关掉开关时，
     原样返回主流程的结果，不产生额外请求也不改变排序。 */
  function aiAssistScript(q, results, askFn, signal) {
    if (!S.assistOn || S.mode !== 'web' || signal.aborted) return Promise.resolve(results);
    var conn = llmConnSafe();
    if (!window.LLMRouter || typeof window.LLMRouter.complete !== 'function'
      || !conn || !conn.base || !conn.key || !conn.model) return Promise.resolve(results);

    var p = assistScriptPrompt(q, results);
    var local = isLocalBase(conn.base);
    return window.LLMRouter.complete({
      app: APP,
      sys: p.sys,
      messages: [{ role: 'user', content: p.user }],
      opts: { signal: signal, temperature: 0, timeoutMs: local ? 120000 : 30000 }
    }).then(function (out) {
      if (signal.aborted) return results;
      var script = parseAssistScript(out);
      if (!script) return results;
      return runAssistSandbox(script.code, {
        question: q,
        primary: primaryQuery(q),
        results: assistCandidates(results)
      }, ASSIST_TIMEOUT).then(function (res) {
        if (signal.aborted || !res.ok) return results;
        var act = acceptAssistResult(res.out, results, q);
        if (!act) return results;
        S.assistScript = { name: script.name, queries: act.queries, drop: act.drop, score: act.score };

        /* 补充检索式整轮最多 2 条：模型可以给 3 条，但多发一轮就多一次抓取与等待。 */
        var extraQueries = act.queries.filter(function (qq) {
          var key = String(qq).toLowerCase();
          if (S.trailTried[key]) return false;
          S.trailTried[key] = 1;
          return true;
        }).slice(0, 2);

        var seq = Promise.resolve([]);
        extraQueries.forEach(function (qq) {
          seq = seq.then(function (acc) {
            if (signal.aborted) return acc;
            return askFn(qq, '脚本').catch(function () { return []; }).then(function (list) {
              return acc.concat(list || []);
            });
          });
        });
        return seq.then(function (extra) {
          if (signal.aborted) return results;
          var applied = applyAssistResult(act, results.concat(extra));
          trace({
            kind: '脚本',
            text: 'AI 辅助脚本「' + script.name + '」'
              + (extraQueries.length ? '：' + extraQueries.join(' / ') : ''),
            res: '新增 ' + extra.length + ' 条 · 加权 ' + applied.boost + ' · 过滤 ' + applied.drop,
            ok: extra.length > 0 || applied.boost > 0 || applied.drop > 0
          });
          return applied.list;
        });
      });
    }).catch(function () { return results; });
  }

  /* ---------------- 主流程 ---------------- */
  function runSearch(raw) {
    var q = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!q) { focusInput(); return; }
    abortAll();

    var ctrl = new AbortController();
    S.ctrl = ctrl;
    S.q = q;
    S.busy = true;
    S.streaming = false;
    S.phase = 'searching';
    S.startedAt = Date.now();
    S.results = [];
    S.other = [];
    S.pages = [];
    S.dropped = [];
    S.sources = [];
    S.trace = [];
    S.skim = { pages: 0, keywords: [], links: [], urls: [] };
    S.liveNote = '';
    S.ghQuery = '';
    S.ghRateLimited = false;
    S.pageCache = Object.create(null);
    S.emails = [];
    S.intentKind = '';
    S.assistScript = null;
    S.answer = '';
    S.error = '';
    S.note = '';
    S.llmOff = false;
    S.folded = false;
    S.trailTried = Object.create(null);
    S.deepExhausted = false;
    S.autoTried = false;

    syncInputs(q);
    showResult(true);
    renderAll(q);
    addHist(q);
    setPhase('searching');

    /* 影视模式走白名单 + 独立的片源判定流程；两条链路共用后面的摘要与来源渲染。 */
    if (S.mode === 'media') { startMedia(q, ctrl); return; }

    var p;
    if (!window.deskSearch || typeof window.deskSearch.run !== 'function') {
      p = Promise.reject(new Error('联网搜索模块未就绪：请刷新页面后重试'));
    } else {
      /* 自主检索链路：判断意图 → 主检索式 → 改写再试 → 未命中时自动三轮智搜 →
         代码类问题并行查仓库 → 人工种子兜底 → 读正文 → 粗读找关键词 → 顺链接补读。 */
      var seeds = seedResults(q);
      var base = primaryQuery(q);
      var alt = retryQuery(q);
      var intent = inferIntent(q);
      S.intentKind = intent.kind;
      var web = [];

      trace({
        kind: '意图',
        text: intent.label,
        res: intent.kind === 'tool' ? '多问「工具 / 推荐」'
          : intent.kind === 'resource' ? '落到仓库与源码'
          : intent.kind === 'trouble' ? '找解决帖与报错' : '按资料类型补问',
        ok: true
      });

      /* 检索源会限流：短时间连发多次会整段返回空页（实测第 5 个问题起连续失败）。
         所以这里做三件事：每次请求之间留间隔、空手时隔一拍重试一次、整轮最多 3 条检索式。
         单次失败不当作「没有结果」，否则会出现莫名其妙的全空。 */
      var lastAsk = 0;
      function delay(ms) {
        return new Promise(function (res) { setTimeout(res, ms); });
      }
      function fetchOnce(qq) {
        var hit = searchCacheGet(qq);
        if (hit) return Promise.resolve(hit);
        return Promise.resolve()
          .then(function () { return window.deskSearch.run(qq, { cfg: { count: 10 } }); })
          .then(function (r) {
            var list = r && r.ok && r.results ? r.results : [];
            if (list.length) searchCachePut(qq, list);
            return list;
          })
          .catch(function () { return []; });
      }
      function ask(qq, kind, useDdg) {
        var gap = Math.max(0, 400 - (Date.now() - lastAsk));
        var viaRss = false;
        var viaAlt = false;
        var viaDdg = false;
        var viaYt = false;
        lastAsk = Date.now() + gap;
        return delay(gap)
          .then(function () { return fetchOnce(qq); })
          .then(function (list) {
            if (ctrl.signal.aborted || !useDdg) return list;
            /* 联系人任务：主源给的往往还是「怎么找主播」这类教程；真正带邮箱的是
               频道页，所以不管主源有没有结果，都再问一次 YouTube 频道检索并合并。 */
            return youtubeChannels(qq, ctrl.signal).then(function (yt) {
              viaYt = yt.length > 0;
              var merged = (list || []).concat(yt || []);
              if (merged.length) return merged;
              diag('主源与 YouTube 频道检索都没结果', '英文查询在中文索引里被当成词典词', '改问 DDG 英文结果');
              return ddgSearch(qq, ctrl.signal).then(function (ddg) {
                viaDdg = ddg.length > 0;
                return ddg;
              });
            });
          })
          .then(function (list) {
            if (ctrl.signal.aborted || list.length) return list;
            /* 主出口空手：先换 RSS 出口，通常能立刻拿到结果。 */
            diag('主检索源返回 0 条', '多为限流或结果页变体', '切到 RSS 备用源');
            return rssSearch(qq, ctrl.signal).then(function (rss) {
              viaRss = rss.length > 0;
              return rss;
            });
          })
          .then(function (list) {
            if (ctrl.signal.aborted || list.length) return list;
            /* Bing 两个出口都被限流时，换 360 再试一次。 */
            return soSearch(qq, ctrl.signal).then(function (alt) {
              viaAlt = alt.length > 0;
              return alt;
            });
          })
          .then(function (list) {
            if (ctrl.signal.aborted || list.length) return list;
            lastAsk = Date.now() + 6000;
            note('检索源限流，等待 6 秒重试…');
            return delay(6000).then(function () { return fetchOnce(qq); });
          })
          .then(function (list) {
            if (ctrl.signal.aborted || list.length) return list;
            return rssSearch(qq, ctrl.signal).then(function (rss) {
              viaRss = viaRss || rss.length > 0;
              return rss;
            });
          })
          .then(function (list) {
            if (ctrl.signal.aborted) return [];
            list = list || [];
            if (isFallbackList(list)) {
              diag('结果全是泛化导航页', '这个说法被搜索源当成了泛需求', '丢弃整批，改写检索式');
              trace({ kind: kind || '网页', text: qq, res: '搜索源给的是泛化兜底页，整批丢弃', ok: false });
              return [];
            }
            if (!list.length) {
              diag('主源与备用源都为空', '检索词过长或该源暂时不可用', '按意图换说法 / 交给仓库接口');
            }
            var j = judge(list, q);
            trace({
              kind: kind || '网页',
              text: qq + (viaYt ? '（YouTube 频道检索）' : viaDdg ? '（DDG 备用源）' : viaRss ? '（RSS 备用源）' : viaAlt ? '（360 备用源）' : ''),
              res: j.total + ' 条 · 相关 ' + j.hit + ' 条',
              ok: j.ok
            });
            return list;
          });
      }

      /* 三轮智搜：主检索式没命中时，不把「没命中」直接丢给用户，而是自动换三种手段再找：
         ① 按意图换说法（工具 / 推荐 / 解决…）；② 拆掉虚词、补英文关键词；③ 换 360 索引。
         每轮只要判定命中就停，整轮最多花 60 秒，避免在限流时空转。 */
      var tried = Object.create(null);
      [base, alt].forEach(function (x) {
        if (!x) return;
        tried[String(x).toLowerCase()] = 1;
        S.trailTried[String(x).toLowerCase()] = 1;
      });
      var smartDeadline = Date.now() + 60000;

      function coreWords(qq) {
        var s = String(qq).replace(/(最|的|了|吗|呢|啊|吧|请问|帮我|我想|什么|怎么|如何|哪个|哪些|为什么|多少|哪里|可以|有没有|是不是|到底|究竟|现在|最新|大全|推荐|哪个好)/g, ' ')
          .replace(/[，,。.!！?？、/|·:：()（）]+/g, ' ')
          .replace(/\s+/g, ' ').trim();
        return s || String(qq).trim();
      }

      /* 每一轮给出不同的检索式组合；同一轮里最多问 2 条。 */
      function roundQueries(round) {
        var list = [];
        if (intent.kind === 'contact') {
          var cq = contactQueries(q);
          if (cq.length) {
            /* 第一轮把品类词与同义词一次问完：只问一条会捞到同一类频道。 */
            var pick = round === 0 ? cq.slice(0, 4) : cq.slice(round * 2 + 2, round * 2 + 4);
            if (pick.length) return pick;
          }
        }
        if (round === 0) {
          (intent.adds || []).forEach(function (w) { list.push((base + ' ' + w).trim()); });
        } else if (round === 1) {
          list.push(coreWords(base));
          var en = intent.kind === 'contact' ? '' : englishQuery(q);
          if (en) list.push(en);
        } else {
          list.push(coreWords(base));
        }
        return list.filter(function (x, i) { return x && list.indexOf(x) === i; }).slice(0, 2);
      }
      function roundKey(qq, round) {
        return (round === 2 ? 'so|' : '') + String(qq).toLowerCase();
      }
      /* 第 3 轮换 360 索引：Bing 给了但都不相关时，换一个索引往往才有答案。 */
      function askRound(qq, round) {
        if (round < 2) return ask(qq, '智搜', intent.kind === 'contact');
        return delay(400).then(function () {
          return soSearch(qq, ctrl.signal).then(function (list) {
            if (list && list.length) searchCachePut(qq, list);
            return list || [];
          });
        }).catch(function () { return []; });
      }

      function smartRound(round, got) {
        if (round >= 3 || ctrl.signal.aborted) return Promise.resolve(got || []);
        if (Date.now() > smartDeadline) {
          trace({ kind: '智搜', text: '三轮还没命中', res: '已到 60 秒预算，先用现有结果作答', ok: false });
          return Promise.resolve(got || []);
        }
        var qs = roundQueries(round).filter(function (qq) {
          var key = roundKey(qq, round);
          return tried[key] ? false : (tried[key] = 1);
        });
        if (!qs.length) return smartRound(round + 1, got);

        function step(i) {
          if (i >= qs.length || ctrl.signal.aborted) return Promise.resolve(got || []);
          /* 记下这轮真问过的检索式：自动补搜 / 手动深挖都靠它避开重复搜索。 */
          S.trailTried[String(qs[i]).toLowerCase()] = 1;
          return askRound(qs[i], round).catch(function () { return []; }).then(function (list) {
            got = (got || []).concat(list || []);
            var j = judge(web.concat(got), q);
            trace({
              kind: '智搜',
              text: '第 ' + (round + 1) + ' 轮 · ' + qs[i],
              res: (list || []).length + ' 条' + (j.ok ? ' · 命中' : ' · 仍不相关'),
              ok: j.ok
            });
            /* 联系人任务第一条就能「命中」频道，但一个查询只会捞到同一类频道；
               先把这一轮两条问完，再决定停手。 */
            if (j.ok && !(intent.kind === 'contact' && round === 0)) return got;
            return step(i + 1);
          });
        }
        return step(0).then(function (res) {
          if (!res || judge(web.concat(res), q).ok) return res;
          return smartRound(round + 1, res);
        });
      }

      p = ask(base).then(function (list) {
        if (ctrl.signal.aborted) return null;
        web = list || [];
        if (judge(web, q).ok) return null;
        if (web.length) {
          diag('结果与问题不匹配', '命中的都是同一主题的泛介绍页，没有回答具体问题', '换实词说法 / 去社区与仓库找线索');
        }
        if (!alt) return null;
        trace({ kind: '改写', text: '命中不足，换成「' + alt + '」', res: '再问一次', ok: false });
        return ask(alt, '改写');
      }).then(function (list2) {
        if (ctrl.signal.aborted) return null;
        if (list2 && list2.length) web = web.concat(list2);
        /* 主检索已经足够好时不再多问：多发一次检索既慢，又容易撞上检索源限流。
           只有在命中不足时才按意图换说法，去社区里找线索。 */
        if (judge(web, q).ok) return null;
        return smartRound(0, []);
      }).then(function (list3) {
        if (ctrl.signal.aborted) return null;
        if (list3 && list3.length) web = web.concat(list3);
        return githubResults(q, ctrl.signal);
      }).then(function (gh) {
        if (ctrl.signal.aborted) return null;
        var repos = gh || [];
        if (S.ghRateLimited && !repos.length) {
          trace({ kind: '仓库', text: 'GitHub 检索被限流（未登录 60 次/小时）', res: '本轮回退到网页结果', ok: false });
        } else if (repos.length) {
          trace({ kind: '仓库', text: 'GitHub 搜「' + (S.ghQuery || '') + '」', res: repos.length + ' 个仓库', ok: true });
        }
        if (seeds.length) {
          trace({ kind: '官网', text: '命中 ' + seeds.length + ' 个已知工具官网', res: '直接置顶', ok: true });
        }
        var all = seeds.concat(repos).concat(web);
        if (!all.length) {
          diag('主源、RSS 与重试都没有结果', '检索源正在限流，或这批说法都问不出结果', '稍等片刻再搜；换个更短的说法');
          throw new Error('检索源暂时不可用（限流），不是「没有结果」——请稍后重试或换个说法');
        }
        if (!repos.length && !seeds.length && !judge(web, q).ok) {
          trace({ kind: '判断', text: '没有真正相关的资料', res: '继续读页面找出站链接', ok: false });
        }
        /* 检索告一段落：让模型写一份临时辅助脚本，补检索式 / 加权 / 过滤候选页。
           这一步只加强候选池，不改写正文与答案；失败时原样返回。 */
        return aiAssistScript(q, all, ask, ctrl.signal).then(function (finalList) {
          return { results: finalList };
        });
      });
    }

    p.then(function (r) {
      if (!r || ctrl.signal.aborted) return;
      var clean = cleanResults(r.results || [], q);
      S.results = clean.kept;
      S.dropped = clean.dropped;
      renderResults();
      var community = S.results.filter(function (r) { return isCommunity(r.url); }).length;
      if (community) {
        trace({ kind: '社区', text: '命中 ' + community + ' 条贴吧 / 知乎 / 问答页', res: '当口碑线索读', ok: true });
      }
      if (!S.results.length) {
        throw new Error(clean.dropped.length
          ? '结果全部被过滤（' + clean.dropped.length + ' 条广告 / 下载站 / 无关内容）'
          : '没有找到可用的网页结果');
      }
      S.phase = 'reading';
      setPhase('reading');

      /* 先把搜索结果粗读一遍，把页面里的外链并进候选池，再挑出最有希望的 10 条处理。
         这样「读哪些页」不再由搜索名次决定，而是由相关度决定。 */
      /* 影视模式只认官方平台，不能把官方页外链并进候选池，否则又会混入聚合站。 */
      var step = S.mode === 'media'
        ? Promise.resolve({ pages: 0, keywords: [], links: [], cands: [] })
        : expandPool(S.results, ctrl.signal);
      return step.then(function (exp) {
        if (ctrl.signal.aborted) return;
        if (exp.pages) {
          S.skim = exp;
          trace({
            kind: '筛读',
            text: '扫 ' + exp.pages + ' 页 / ' + exp.batches + ' 组 · '
              + (exp.llm ? 'AI 选中 ' + exp.picks.length + ' 篇' : '词表命中 ' + exp.picks.length + ' 篇'),
            res: '候选池 ' + (S.results.length + exp.links.length) + ' 条',
            ok: true
          });
        } else if (S.intentKind !== 'contact') {
          /* 联系人任务本来就跳过 YouTube 扫描（频道页统一在精读阶段读），不是反爬。 */
          diag('候选页一页都没读出来', '目标站反爬、超时或需要登录', '改用搜索摘要，继续用仓库与种子');
        }
        /* 被 AI 判为「值得读」的，排到前面；其余仍按相关度排。 */
        var pickSet = Object.create(null);
        (exp.picks || []).forEach(function (p) { pickSet[p.url] = 1; });
        S.results.concat(exp.cands || []).forEach(function (r) {
          if (pickSet[r.url]) r.pick = true;
        });
        var pool = rankPool(S.results.concat(exp.cands || []), q);
        if (pool.length) S.results = pool;
        renderResults();

        /* 找人任务要读的是「一串频道」：只读 6 个频道经常一个邮箱都碰不到。 */
        var picks = pickForRead(S.results, S.intentKind === 'contact' ? 12 : MAX_SOURCES);
        S.sources = picks.map(function (item, i) {
          return {
            idx: i + 1, title: item.title, url: item.url, host: item.host,
            snippet: item.snippet, text: '', chars: 0, status: 'pending', err: ''
          };
        });
        renderSources();
        renderResults();
        return crawlSources(S.sources, ctrl.signal).then(function () {
          if (ctrl.signal.aborted) return;
          var read = S.sources.filter(function (s) { return s.status === 'read'; }).length;
          if (S.sources.length && !read) {
            diag('正文一篇都没读到', '目标站拒绝抓取、正文过短或需要登录', '退回搜索摘要作答，并保留可点链接');
          }
          /* 粗读：剩下的候选页只扫关键词和链接，不占精读名额；
             扩展阶段读过的页面直接走缓存，不会重复抓。 */
          var rest = S.results.filter(function (r) {
            return !S.sources.some(function (s) { return s.url === r.url; });
          });
          return skimSources(rest, ctrl.signal).then(function (skim) {
            if (ctrl.signal.aborted) return;
            var prev = S.skim || { pages: 0, keywords: [], links: [], urls: [] };
            var kws = (prev.keywords || []).concat((skim.keywords || []).filter(function (k) {
              return (prev.keywords || []).indexOf(k) < 0;
            })).slice(0, 8);
            S.skim = {
              pages: (prev.pages || 0) + skim.pages,
              keywords: kws,
              links: (prev.links || []).concat(skim.links || []),
              urls: (prev.urls || []).concat(skim.urls || [])
            };
            if (skim.pages) {
              trace({
                kind: '粗读',
                text: skim.keywords.length
                  ? '扫读 ' + skim.pages + ' 篇，新关键词：' + skim.keywords.join(' / ')
                  : '扫读 ' + skim.pages + ' 篇，没有发现新关键词',
                res: skim.links.length ? skim.links.length + ' 条线索' : '无链接',
                ok: skim.keywords.length > 0
              });
            }
            var before = S.sources.length;
            return followTrail(q, ctrl.signal).then(function () {
              var added = S.sources.length - before;
              trace({
                kind: '线索',
                text: added ? '顺着已读 / 粗读页面的出站链接补读' : '没有值得追的出站链接',
                res: added ? added + ' 篇' : '跳过',
                ok: !!added
              });
              if (S.intentKind === 'contact') {
                trace({
                  kind: '邮箱',
                  text: S.emails.length
                    ? '从频道 / 联系页抽到 ' + S.emails.length + ' 个公开邮箱'
                    : '没有抽到公开邮箱',
                  res: S.emails.length ? '已并入作答' : '保留频道页供核对',
                  ok: S.emails.length > 0
                });
              }
            });
          });
        });
      });
    }).then(function () {
      if (ctrl.signal.aborted) return;
      S.phase = 'writing';
      setPhase('writing');
      return writeAnswer(ctrl.signal);
    }).then(function () {
      if (ctrl.signal.aborted) return;
      S.busy = false;
      S.phase = 'done';
      setPhase('done');
      renderAnswer();
      /* 资料读完仍没答上：自动按「可执行建议」再补搜一轮，不用等用户点按钮。 */
      autoFollowUp();
    }).catch(function (e) {
      if (ctrl.signal.aborted) return;
      S.busy = false;
      S.phase = 'error';
      S.error = (e && e.message) || String(e);
      setPhase('error');
      renderAnswer();
      renderSources();
    });
  }

  /* 影视检索：先搜官方播放页，再抓页面判定免费 / 会员 / 预告。
   * 找不到官方来源时不硬编答案，只保留平台直达入口并说明情况。 */
  function startMedia(q, ctrl) {
    /* 检索式只用「片名 + 在线观看」：实测带上「免费观看 / 官方」反而会让搜索源
       混进更多盗版聚合页，白名单过滤后官方命中更少。 */
    var full = q + ' 在线观看';
    var p;
    if (!window.deskSearch || typeof window.deskSearch.run !== 'function') {
      p = Promise.reject(new Error('联网搜索模块未就绪：请刷新页面后重试'));
    } else {
      /* 影视检索同样要防限流：空手时先走 RSS 备用源，再隔一拍重问一次，
         别直接把「没找到官方来源」给用户。 */
      function once() {
        return window.deskSearch.run(full, { cfg: { count: 12 } }).catch(function () { return null; });
      }
      p = once().then(function (r) {
        if (ctrl.signal.aborted || (r && r.ok && (r.results || []).length)) return r;
        return rssSearch(full, ctrl.signal).then(function (rss) {
          if (rss.length) return { ok: true, results: rss };
          return soSearch(full, ctrl.signal).then(function (alt) {
            if (alt.length) return { ok: true, results: alt };
            return new Promise(function (res) { setTimeout(res, 1200); }).then(once);
          });
        });
      }).then(function (r) {
        if (ctrl.signal.aborted) return null;
        if (!r || !r.ok) throw new Error((r && r.error) || '搜索源没有返回结果');
        return r;
      });
    }

    p.then(function (r) {
      if (!r || ctrl.signal.aborted) return;
      var clean = cleanMediaResults(r.results || []);
      S.results = clean.kept;
      S.other = clean.other;
      S.pages = clean.pages;
      S.dropped = clean.dropped;
      renderResults();
      if (!S.results.length) {
        S.busy = false;
        S.phase = 'done';
        S.note = '没有在官方平台找到「' + q + '」的播放页。可以直接用下方平台站内搜索，或换一个片名再试。'
          + (S.other.length ? '非官方直链已单列在下方，仅视频文件地址，请自行核验。' : '')
          + (S.pages.length ? '非官方网页已单列，可用内置浏览器安全打开（会拦截广告与弹窗）。' : '');
        setPhase('done', '未找到官方来源');
        renderAnswer();
        return;
      }
      S.phase = 'reading';
      setPhase('reading');
      S.sources = S.results.slice(0, MAX_SOURCES).map(function (item, i) {
        return {
          idx: i + 1, title: item.title, url: item.url, host: item.host,
          snippet: item.snippet, text: '', chars: 0, status: 'pending', err: '', media: 'unknown'
        };
      });
      renderSources();
      renderResults();
      return crawlSources(S.sources, ctrl.signal).then(function () {
        if (ctrl.signal.aborted) return;
        /* 正文到手后再判一次：抓不到正文时用搜索摘要兜底，至少能看出「会员 / 预告」。 */
        S.sources.forEach(function (s) {
          s.media = mediaStatus(s.text + ' ' + s.snippet);
        });
        renderSources();
        renderResults();
      });
    }).then(function () {
      if (ctrl.signal.aborted || !S.sources.length) return;
      S.phase = 'writing';
      setPhase('writing');
      return writeAnswer(ctrl.signal);
    }).then(function () {
      if (ctrl.signal.aborted || !S.sources.length) return;
      S.busy = false;
      S.phase = 'done';
      setPhase('done');
      renderAnswer();
    }).catch(function (e) {
      if (ctrl.signal.aborted) return;
      S.busy = false;
      S.phase = 'error';
      S.error = (e && e.message) || String(e);
      setPhase('error');
      renderAnswer();
      renderSources();
    });
  }

  /* 线索来源按可靠性排序：粗读捞到的重复词 → 已读正文里的重复词 → 标题 / 摘要里的重复说法。
     正文常因登录墙或反爬读不到，那时如果只认正文，「进一步搜索」就会变成一个点了没反应的按钮。
     但摘要里混着大量广告词：不筛掉就会把「唯美 / 礼包」当线索，越挖越偏。 */
  var CLUE_NOISE = /(唯美|礼包|福利|充值|首充|折扣|私服|破解|免费看|高清全集|抖音|快手|小说|漫画|广告|下载)/;
  var CLUE_HOSTS = /^(so|baidu|bing|duckduckgo|bilibili|douyin|163|sina|qq|youtube|google)\.(com|cn)$/i;
  var CLUE_STOP = /^(www|com|cn|http|https|html|php|net|org|the|and|for|with|from)$/;
  function clueUsable(k, contact) {
    k = String(k || '').toLowerCase().trim();
    if (k.length < 2 || CLUE_NOISE.test(k) || CLUE_HOSTS.test(k) || CLUE_STOP.test(k)) return false;
    /* 找人任务只认「实体 / 联系方式」类线索：英文频道名、域名、邮箱词、合作词；
       中文广告二元组（三国 / 唯美）一律不进检索式。 */
    if (contact) {
      if (/^(youtube|google|bilibili|douyin|facebook|twitter|instagram)$/.test(k)) return false;
      return /^[a-z0-9][a-z0-9._@+-]*$/.test(k) || /(邮箱|邮件|联系|商务|合作|频道|主播|博主|作者|达人)/.test(k);
    }
    return true;
  }
  function collectClues(q0) {
    var contact = inferIntent(q0).kind === 'contact';
    var out = [];
    function add(k) {
      k = String(k || '').toLowerCase().trim();
      if (clueUsable(k, contact) && out.indexOf(k) < 0) out.push(k);
    }
    if (S.skim && S.skim.keywords) S.skim.keywords.forEach(add);
    harvestKeywords(S.sources.map(function (s) { return s.text || ''; }).join('\n'), q0).forEach(add);
    if (!out.length) {
      var corpus = S.results.map(function (r) {
        return String(r.title || '') + ' ' + String(r.snippet || '');
      }).join('\n');
      harvestKeywords(corpus, q0).forEach(add);
    }
    return out.slice(0, 4);
  }

  /* 答不上来的判定：找人任务只看有没有抽到邮箱；其他任务看模型是否自己说
     「资料不足 / 无法确定」。 */
  function answerWeak() {
    if (S.intentKind === 'contact') return !S.emails.length;
    return /(无法(可靠)?(找|确定|得出|判断|回答)|资料(不足|中没有|里没有)|没有(找到|给出)|未能找到|缺少(足够|相关))/i
      .test(String(S.answer || ''));
  }

  /* 把答案末尾的「可执行建议」落成真正能执行的检索式：
     不去解析模型那段自由文本，而是按任务类型给出等价、可执行的下一步。 */
  function nextQueries(q) {
    var out = [];
    function add(s) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    }
    if (S.intentKind === 'contact') {
      var sub = contactSubject(q) || 'game';
      add(sub + ' youtube channels');
      add('best ' + sub + ' streamers');
      contactSyn(q).forEach(function (w) { add(w + ' youtuber'); });
      add(sub + ' youtuber contact email');
    } else {
      add(retryQuery(q));
      var en = englishQuery(q);
      /* 英文检索词排在线索前面：中文索引对「油管 / 主播」这类词几乎不命中，
         实测英文检索式才回得到能用的页面。线索只用前两条，且不再拼整条中文长问句。 */
      if (en) add(en);
      collectClues(q).slice(0, 2).forEach(function (k) {
        add(en ? k + ' ' + en : k);
      });
      if (!out.length) out.push(primaryQuery(q));
    }
    return out.slice(0, 4);
  }

  /* 10 篇资料读完仍没答上时，不等用户点按钮：自动按上面的建议补搜一轮。
     每题只补一次，避免模型一直说「资料不足」时无限重试。 */
  function autoFollowUp() {
    if (S.autoTried || S.busy || S.mode !== 'web' || S.phase !== 'done' || !S.results.length) return;
    if (!answerWeak()) return;
    var qs = nextQueries(S.q);
    if (!qs.length) return;
    S.autoTried = true;
    trace({
      kind: '自动补搜',
      text: '资料没答上 → 按建议再搜：' + qs[0],
      res: qs.length + ' 条建议检索式',
      ok: true
    });
    S.note = '现有 ' + S.sources.length + ' 篇资料没答上，正在自动按建议补搜…';
    renderAnswer();
    deepenSearch(qs);
  }

  /* 进一步搜索：把这一轮里「稳定重复出现的新词」当线索，再搜一轮。
   * 线索来自粗读关键词、已读正文与结果标题，不是让模型空想；
   * 新结果先过三道筛：未出现过、不在黑名单、与问题或线索真的相关。
   * 剩下的才并进列表并重新精读，最后基于新旧资料重写答案。 */
  function deepenSearch(extra) {
    var p;
    try {
      p = deepenRun(extra);
    } catch (e) {
      deepenStop(e);
      return;
    }
    /* 深挖是在主答案之外追加的一轮：它失败只能降级提示，
       不能冒泡成整页错误块，也不能让 S.busy 永远挂着。 */
    if (p && typeof p.catch === 'function') p.catch(deepenStop);
  }

  function deepenStop(e) {
    if (S.ctrl && S.ctrl.signal.aborted) return;
    S.busy = false;
    S.streaming = false;
    S.phase = 'done';
    setPhase('done');
    S.note = '这次深挖没有完成：' + ((e && e.message) || '未知原因') + '。现有答案不受影响，可以再点一次。';
    renderAnswer();
    setTools();
  }

  function deepenRun(extra) {
    if (S.busy || S.phase !== 'done' || !S.results.length || S.mode !== 'web') return;
    var q0 = S.q;
    var clues = collectClues(q0);
    var core = primaryQuery(q0).split(/\s+/).slice(0, 3).join(' ');
    /* 没有新词时退一步：换一种问法再搜一轮，同样按「是否见过 / 是否相关」筛选。
       这样做至少能验证「确实没有更好的结果」，而不是什么都不做。 */
    var queries = [];
    (extra || []).forEach(function (qq) {
      qq = String(qq || '').replace(/\s+/g, ' ').trim();
      if (qq && queries.indexOf(qq) < 0) queries.push(qq);
    });
    if (clues.length) {
      /* 前两条线索常常搜索源也查不出东西，这里把 4 条线索都排进去，
         轮到哪条用哪条，不必因为前两条失效就整轮放弃。 */
      clues.forEach(function (k) {
        var qq = (k + ' ' + core).replace(/\s+/g, ' ').trim();
        if (queries.indexOf(qq) < 0) queries.push(qq);
      });
    } else if (!queries.length) {
      queries = [retryQuery(q0) || primaryQuery(q0)];
    }
    queries = queries.slice(0, 4);
    var label = (extra && extra.length) ? extra[0]
      : (clues.length ? clues.slice(0, 2).join(' / ') : queries[0]);

    /* 同一条线索不重复搜：重复跑同一句只会把同一批结果再筛一遍，白等两轮。 */
    S.trailTried = S.trailTried || Object.create(null);
    var fresh = queries.filter(function (qq) {
      var key = qq.toLowerCase();
      return S.trailTried[key] ? false : (S.trailTried[key] = 1);
    });
    if (!fresh.length) {
      /* 线索用完不是故障：不写红色失败行，只提示换问法，并把深挖按钮收起来，
         免得每次点击都再刷一条「已经搜过」。 */
      S.deepExhausted = true;
      S.phase = 'done';
      S.busy = false;
      S.note = (extra && extra.length)
        ? '按建议要搜的几组检索式，这一轮都已经搜过了；换一个更具体的问法能继续。'
        : '线索「' + label + '」都搜过了，这一轮没有更多可挖的内容。换个更具体的问法能继续。';
      renderAnswer();
      setTools();
      return;
    }
    queries = fresh;
    /* 建议里的前几条可能这一轮已经搜过，被筛掉后剩下来的那条才是真正要搜的。 */
    if (extra && extra.length) label = fresh[0];

    S.busy = true;
    S.error = '';
    S.note = '';
    S.llmOff = false;
    S.phase = 'reading';
    /* 自动补搜是同一题的续跑，用时继续累计；手动深挖才重新计时。 */
    if (!(extra && extra.length)) S.startedAt = Date.now();
    setPhase('reading');
    note((extra && extra.length ? '按建议补搜：' : '用线索继续搜索：') + label);
    setTools();
    renderAnswer();
    var ctrl = new AbortController();
    S.ctrl = ctrl;
    var known = Object.create(null);
    S.results.forEach(function (r) { known[String(r.url).replace(/#.*$/, '')] = 1; });
    var tokens = relevantTokens(q0).concat(clues.map(function (k) { return k.toLowerCase(); }));
    var added = [];
    var dropped = 0;

    function grab(qq) {
      return window.deskSearch.run(qq, { cfg: { count: 10 } }).then(function (r) {
        var list = (r && r.ok && r.results) || [];
        var chain = list.length ? Promise.resolve(list)
          : rssSearch(qq, ctrl.signal).then(function (l) {
              return l.length ? l : soSearch(qq, ctrl.signal);
            });
        return chain.then(function (base) {
          /* 找人任务：真正的答案在 YouTube 频道页，补搜也必须再问一次频道检索。 */
          if (S.intentKind !== 'contact') return base;
          return youtubeChannels(qq, ctrl.signal).then(function (yt) {
            return (base || []).concat(yt);
          });
        });
      }).catch(function () { return []; });
    }
    function next(i) {
      if (i >= queries.length || ctrl.signal.aborted) return Promise.resolve();
      return grab(queries[i]).then(function (list) {
        list.forEach(function (r) {
          var u = String(r.url || '').replace(/#.*$/, '');
          if (!u || known[u]) { dropped++; return; }
          if (blockedReason({ url: u, title: r.title })) { dropped++; return; }
          var text = (String(r.title || '') + ' ' + String(r.snippet || '') + ' ' + u).toLowerCase();
          var hit = tokens.some(function (t) { return t && text.indexOf(t) >= 0; });
          /* 找人任务里频道页本身就是目标，不能按字面词命中把它筛掉。 */
          if (!hit && !(S.intentKind === 'contact' && YT_CHANNEL.test(u))) { dropped++; return; }
          known[u] = 1;
          r.url = u;
          r.host = r.host || hostOf(u);
          r.deep = true;
          added.push(r);
        });
        return next(i + 1);
      });
    }

    return next(0).then(function () {
      if (ctrl.signal.aborted) return;
      if (!added.length) {
        S.busy = false;
        S.phase = 'done';
        setPhase('done');
        S.note = (extra && extra.length)
          ? '已按建议自动补搜一轮（' + label + '），没有新的相关结果；现有答案仍缺少直接依据，建议换更具体的问法。'
          : '用「' + label + '」又搜了一轮，没有新的相关结果'
            + (dropped ? '（去掉 ' + dropped + ' 条重复 / 无关）' : '') + '。';
        trace({ kind: (extra && extra.length) ? '自动补搜' : '深挖', text: '检索「' + label + '」', res: '无新增 · 去掉 ' + dropped + ' 条', ok: false });
        renderAnswer();
        setTools();
        return;
      }
      var merged = S.results.concat(added);
      var ranked = rankPool(merged, q0);
      added.forEach(function (a) {
        if (ranked.length < 12 && !ranked.some(function (x) { return x.url === a.url; })) ranked.push(a);
      });
      S.results = ranked;
      trace({
        kind: (extra && extra.length) ? '自动补搜' : '深挖',
        text: '检索「' + label + '」',
        res: '新增 ' + added.length + ' 条 · 去掉 ' + dropped + ' 条无关',
        ok: true
      });

      /* 只精读新增里最靠前的几条：线索用来补缺口，不重读一遍全部资料。
         找人任务多读两页：邮箱只在少数频道页上，读两页很容易刚好错过。 */
      var more = added.slice(0, S.intentKind === 'contact' ? 4 : 2).map(function (item, i) {
        return {
          idx: S.sources.length + i + 1, title: item.title, url: item.url, host: item.host,
          snippet: item.snippet, text: '', chars: 0, status: 'pending', err: ''
        };
      });
      S.sources = S.sources.concat(more);
      renderResults();
      renderSources();
      return crawlSources(more, ctrl.signal).then(function () {
        if (ctrl.signal.aborted) return;
        return writeAnswer(ctrl.signal);
      }).then(function () {
        if (ctrl.signal.aborted) return;
        S.busy = false;
        S.phase = 'done';
        setPhase('done');
        /* 自动补搜只有一次预算：补完仍然没答上就明确收尾，不再偷偷重试。 */
        if (extra && extra.length && answerWeak()) {
          S.note = '已按建议自动补搜一轮，仍未找到直接答案；可以换更具体的问法继续。';
        }
        renderAnswer();
        renderResults();
        setTools();
      }).catch(function () {
        if (ctrl.signal.aborted) return;
        S.busy = false;
        S.phase = 'done';
        setPhase('done');
        setTools();
      });
    });
  }

  function writeAnswer(signal) {
    var usable = S.sources.filter(function (s) { return s.text; });
    if (!usable.length) {
      S.answer = '';
      S.note = '没有抓到可读正文：先看网页结果与摘要，或换一个更具体的问法。';
      renderAnswer();
      return Promise.resolve();
    }
    if (!window.LLMRouter || typeof window.LLMRouter.complete !== 'function') {
      S.llmOff = true;
      S.answer = fallbackAnswer(S.sources);
      renderAnswer();
      return Promise.resolve();
    }
    var conn = llmConnSafe();
    if (!conn || !conn.base || !conn.key || !conn.model) {
      S.llmOff = true;
      S.answer = fallbackAnswer(S.sources);
      renderAnswer();
      return Promise.resolve();
    }

    S.streaming = true;
    S.answer = '';
    renderAnswer();

    /* 本机模型（Ollama / LM Studio）出字慢得多：上下文减半、超时放宽，
       否则 180 秒必然被掐断，用户只看到「生成中断」而拿不到任何答案。 */
    var local = isLocalBase(conn.base);

    return window.LLMRouter.complete({
      app: APP,
      sys: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(S.q, S.sources, local) }],
      onDelta: function (acc) {
        S.answer = String(acc == null ? '' : acc);
        scheduleAnswer();
      },
      opts: { signal: signal, temperature: 0.3, timeoutMs: local ? 600000 : 180000 }
    }).then(function (out) {
      if (!S.answer && out) S.answer = String(out);
    }).catch(function (e) {
      if (signal.aborted) return;
      if (!S.answer) {
        S.llmOff = true;
        S.answer = fallbackAnswer(S.sources);
        S.note = '生成中断：' + ((e && e.message) || '未知原因');
      }
    }).then(function () {
      S.streaming = false;
      renderAnswer();
    });
  }

  function abortAll() {
    if (S.ctrl) {
      try { S.ctrl.abort(); } catch (e) { /* 已结束 */ }
      S.ctrl = null;
    }
    S.busy = false;
    S.streaming = false;
  }

  function stopSearch() {
    abortAll();
    S.phase = 'done';
    setPhase('done', '已停止');
    renderAnswer();
    renderSources();
  }

  /* ---------------- 视图 ---------------- */
  function $(sel) { return S.body ? S.body.querySelector(sel) : null; }
  function $$(sel) { return S.body ? Array.prototype.slice.call(S.body.querySelectorAll(sel)) : []; }

  function showResult(on) {
    var root = $('.ais-root');
    if (!root) return;
    root.dataset.mode = on ? 'result' : 'home';
    var hero = $('.ais-hero');
    var res = $('.ais-result');
    if (hero) hero.classList.toggle('hidden', on);
    if (res) res.classList.toggle('hidden', !on);
    var head = $('.ais-head');
    if (head) head.classList.toggle('is-compact', on);
  }

  function syncInputs(q) {
    ['.ais-input', '.ais-hero-input'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.value = q;
    });
    var clear = $('[data-act="clear"]');
    if (clear) clear.classList.toggle('hidden', !q);
  }

  function focusInput() {
    var el = $('.ais-hero').classList.contains('hidden') ? $('.ais-input') : $('.ais-hero-input');
    if (el) { try { el.focus(); } catch (e) { /* 忽略 */ } }
  }

  /* 辅助脚本开关：只影响下一轮检索，不改已有结果。 */
  function applyAssistUI() {
    var b = $('[data-act="assist"]');
    if (!b) return;
    b.classList.toggle('is-on', !!S.assistOn);
    b.setAttribute('aria-pressed', S.assistOn ? 'true' : 'false');
    b.title = S.assistOn
      ? 'AI 辅助脚本：开启（点击关闭）'
      : 'AI 辅助脚本：关闭（点击开启）';
  }

  /* 模式切换只改「找什么」，不改视觉体系。影视模式换掉的只有文案、示例与结果区。 */
  function applyModeUI() {
    var media = S.mode === 'media';
    $$('.ais-mode').forEach(function (b) {
      var on = b.getAttribute('data-mode') === S.mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var root = $('.ais-root');
    if (root) root.classList.toggle('is-media', media);
    var h = $('.ais-hero-h');
    if (h) h.textContent = media ? '影视资源' : '智搜';
    var p = $('.ais-hero-p');
    if (p) {
      p.textContent = media
        ? '只从官方平台与公共版权库找片，标清免费 / 会员 / 预告；非官方来源单独列出，网页走受保护的浏览器打开。'
        : '先读原文，再给答案。自动滤掉广告、下载站与搬运内容。';
    }
    $$('.ais-input, .ais-hero-input').forEach(function (el) {
      el.setAttribute('placeholder', media ? '输入电影或剧集名，例如：流浪地球 2' : '输入问题，AI 会去读原文再回答');
    });
    var chips = $('.ais-chips');
    if (chips) {
      chips.innerHTML = (media ? MEDIA_CHIPS : WEB_CHIPS).map(function (q) {
        return '<button type="button" class="ais-chip" data-q="' + esc(q) + '">' + esc(q) + '</button>';
      }).join('');
    }
    var note = $('.ais-hero-note');
    if (note) {
      note.textContent = media
        ? '影视模式只聚合官方视频平台与公共版权库；非官方来源单独列出，网页在受保护的浏览器中打开。检索经本地中转（127.0.0.1:8787）转发。'
        : '检索经本地中转（127.0.0.1:8787）转发；未启动时请在 设置 → 本地中转 中启动。';
    }
  }

  function setMode(m) {
    m = m === 'media' ? 'media' : 'web';
    if (S.mode === m) return;
    abortAll();
    S.mode = m;
    S.busy = false;
    S.streaming = false;
    S.q = '';
    S.results = [];
    S.other = [];
    S.pages = [];
    S.dropped = [];
    S.sources = [];
    S.answer = '';
    S.error = '';
    S.note = '';
    try { localStorage.setItem('hf_aisearch_mode', m); } catch (e) { /* 忽略 */ }
    applyModeUI();
    showResult(false);
    syncInputs('');
    renderPlatforms('');
    renderHist();
    focusInput();
  }

  function renderAll(q) {
    var status = $('.ais-status');
    if (status) status.textContent = '';
    var body = $('.ais-answer-body');
    if (body) {
      body.dataset.empty = '1';
      body.innerHTML = '<div class="ais-answer-idle">' +
        (S.mode === 'media' ? '正在检索「' + esc(q) + '」的官方播放页…' : '正在检索「' + esc(q) + '」…') +
      '</div>';
    }
    var foot = $('.ais-answer-foot');
    if (foot) foot.textContent = '';
    var list = $('.ais-list');
    if (list) list.innerHTML = '';
    var extra = $('.ais-extra');
    if (extra) extra.classList.add('hidden');
    var extraList = $('.ais-extra-list');
    if (extraList) extraList.innerHTML = '';
    var lt = $('.ais-listtitle');
    if (lt) lt.textContent = S.mode === 'media' ? '官方来源' : '网页结果';
    var filtered = $('.ais-filtered');
    if (filtered) filtered.textContent = '';
    var srcs = $('.ais-sources');
    if (srcs) {
      srcs.innerHTML = '<div class="ais-side-idle">' +
        (S.mode === 'media' ? '抓取到的官方播放页会按编号列在这里。' : '检索到网页后按编号列在这里。') +
      '</div>';
    }
    var len = $('.ais-card-n');
    if (len) len.textContent = '';
    renderTrace();
    renderPlatforms(q);
    setTools();
  }

  /* 官方平台直达：不管检索有没有命中，这排入口都可用。
   * 这是影视模式最稳的一条路 —— 各站自己的搜索页永远比第三方聚合站新。 */
  function renderPlatforms(q) {
    var wrap = $('.ais-plats');
    if (!wrap) return;
    var media = S.mode === 'media';
    wrap.classList.toggle('hidden', !media);
    if (!media) return;
    var grid = $('.ais-plats-grid');
    if (!grid) return;
    var query = String(q || S.q || '');
    grid.innerHTML = MEDIA_PLATFORMS.map(function (p) {
      var url = p.search + encodeURIComponent(query);
      return '<a class="ais-plat" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
        'title="在' + esc(p.name) + '搜索「' + esc(query) + '」">' +
        '<i style="background:' + p.color + '"></i>' +
        '<span>' + esc(p.name) + '</span><em>搜索 ›</em>' +
      '</a>';
    }).join('');
  }

  function setPhase(p, override) {
    S.phase = p;
    var order = { searching: 0, reading: 1, writing: 2, done: 3, error: 3 };
    var at = order[p] == null ? 0 : order[p];
    $$('.ais-step').forEach(function (el, i) {
      el.classList.toggle('is-done', p !== 'error' && i < at);
      el.classList.toggle('is-active', p !== 'error' && i === at);
      el.classList.toggle('is-fail', p === 'error' && i >= at);
    });
    var bar = $('.ais-bar-in');
    if (bar) {
      var pct = p === 'searching' ? 12 : p === 'reading' ? 40 : p === 'writing' ? 82 : p === 'done' ? 100 : 100;
      if (p === 'reading') {
        var done = S.sources.filter(function (s) { return s.status === 'read' || s.status === 'snippet'; }).length;
        pct = 40 + Math.round(40 * (S.sources.length ? done / S.sources.length : 0));
      }
      bar.style.width = pct + '%';
      bar.classList.toggle('is-fail', p === 'error');
    }
    var st = $('.ais-status');
    if (st) st.textContent = override || phaseText();
    updatePhaseText(override);
    setTools();
  }

  function phaseText() {
    if (S.phase === 'searching') return S.mode === 'media' ? '正在检索官方片源…' : '正在检索相关网页…';
    if (S.phase === 'reading') {
      var done = S.sources.filter(function (s) { return s.status === 'read' || s.status === 'snippet'; }).length;
      var tail = S.liveNote ? ' · ' + S.liveNote : '';
      return (S.mode === 'media' ? '正在核对平台页面 ' : '正在精读正文 ') + done + ' / ' + S.sources.length + '…' + tail;
    }
    if (S.phase === 'writing') {
      if (S.mode === 'media') return S.streaming ? '正在汇总免费 / 会员 / 预告…' : '正在准备片源结论…';
      return S.streaming ? '正在依据正文生成摘要…' : '正在准备摘要…';
    }
    if (S.phase === 'done') {
      return S.mode === 'media'
        ? '完成 · ' + S.results.length + ' 个官方来源 · ' + msText(Date.now() - S.startedAt)
        : '完成 · ' + S.results.length + ' 条结果 · ' + msText(Date.now() - S.startedAt);
    }
    if (S.phase === 'error') return '失败';
    return '';
  }

  function updatePhaseText(override) {
    var st = $('.ais-status');
    if (st && !override) st.textContent = phaseText();
  }

  function setTools() {
    var stop = $('[data-act="stop"]');
    var regen = $('[data-act="regen"]');
    var copy = $('[data-act="copy"]');
    if (stop) stop.hidden = !(S.busy && S.streaming);
    if (regen) regen.hidden = !(!!S.answer && !S.busy);
    if (copy) copy.hidden = !(!!S.answer && !S.streaming);
    var fold = $('[data-act="fold"]');
    if (fold) {
      fold.hidden = !S.results.length;
      fold.textContent = S.folded ? '展开' : '收起';
    }
    var deep = $('[data-act="deepen"]');
    if (deep) {
      /* 只有「这一轮已经读完了」才允许继续深挖：线索得先存在；
         线索确实用完时收起按钮，避免重复点击只刷出「已经搜过」。 */
      deep.hidden = !(S.mode === 'web' && S.results.length && S.phase === 'done' && !S.busy)
        || !!S.deepExhausted;
      deep.textContent = S.deepExhausted ? '线索已用完' : '进一步搜索';
    }
  }

  function renderHist() {
    var card = $('.ais-histcard');
    var box = $('.ais-hist');
    if (!card || !box) return;
    card.classList.toggle('hidden', !S.hist.length);
    box.innerHTML = S.hist.map(function (h) {
      return '<button type="button" class="ais-histitem" data-hist="' + esc(h.q) + '" title="' + esc(h.q) + '">' +
        '<span class="ais-histq">' + esc(h.q) + '</span>' +
        '<span class="ais-histtime">' + esc(timeAgo(h.at)) + '</span>' +
      '</button>';
    }).join('');
  }

  function timeAgo(at) {
    var d = Date.now() - Number(at || 0);
    if (!at || d < 0) return '';
    var m = Math.floor(d / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  /* 每个站点一个稳定的色相：扫列表时靠颜色分辨来源，比一排灰色小字快 */
  function hostTint(host) {
    var n = 0;
    for (var i = 0; i < host.length; i++) n = (n * 31 + host.charCodeAt(i)) % 360;
    return 'hsl(' + n + ' 58% 94%)';
  }
  function hostInk(host) {
    var n = 0;
    for (var i = 0; i < host.length; i++) n = (n * 31 + host.charCodeAt(i)) % 360;
    return 'hsl(' + n + ' 46% 34%)';
  }

  function highlight(text, q) {
    var out = esc(text);
    var terms = String(q || '').split(/\s+/).filter(function (t) { return t.length > 1; }).slice(0, 4);
    terms.forEach(function (t) {
      var safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        out = out.replace(new RegExp('(' + esc(safe) + ')', 'gi'), '<mark>$1</mark>');
      } catch (e) { /* 特殊字符忽略 */ }
    });
    return out;
  }

  function renderResults() {
    if (S.mode === 'media') { renderMediaResults(); return; }
    var box = $('.ais-list');
    if (!box) return;
    if (!S.results.length) { box.innerHTML = ''; return; }
    var srcMap = {};
    S.sources.forEach(function (s) { srcMap[s.url] = s; });

    box.innerHTML = S.results.map(function (r) {
      var src = srcMap[r.url];
      var badges = [];
      if (src) badges.push('<span class="ais-badge is-src">来源 [' + src.idx + ']</span>');
      if (src && src.status === 'read') badges.push('<span class="ais-badge is-ok">已精读</span>');
      if (src && src.status === 'snippet') badges.push('<span class="ais-badge is-warn">仅摘要</span>');
      if (r.trusted) badges.push('<span class="ais-badge is-trust">高可信</span>');
      if (r.deep) badges.push('<span class="ais-badge is-deep">深挖</span>');
      return '<article class="ais-hit">' +
        '<div class="ais-hit-top">' +
          '<span class="ais-fav" style="background:' + hostTint(r.host) + ';color:' + hostInk(r.host) + '">' +
            esc((r.host || '?').charAt(0).toUpperCase()) + '</span>' +
          '<a class="ais-hit-title" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' +
            esc(r.title) + '</a>' +
        '</div>' +
        '<div class="ais-hit-url">' + esc(r.host) + '<span class="ais-hit-path">' + esc(pathOf(r.url)) + '</span></div>' +
        (r.snippet ? '<p class="ais-hit-sn">' + highlight(r.snippet, S.q) + '</p>' : '') +
        (badges.length ? '<div class="ais-hit-tags">' + badges.join('') + '</div>' : '') +
      '</article>';
    }).join('');

    renderFilteredText(false);
    var list = $('.ais-list');
    if (list) list.classList.toggle('is-folded', S.folded);
    setTools();
  }

  /* 影视结果：平台徽标 + 可播放性标签 + 官方跳转。
   * 判定结果来自抓到的页面正文，抓不到时退到搜索摘要；两者都没有证据就标「待确认」。 */
  function renderMediaResults() {
    var box = $('.ais-list');
    if (!box) return;
    if (!S.results.length) { box.innerHTML = ''; renderFilteredText(true); renderUnofficial(); return; }
    var srcMap = {};
    S.sources.forEach(function (s) { srcMap[s.url] = s; });

    box.innerHTML = S.results.map(function (r) {
      var site = mediaSite(r.host) || { name: '官方平台', color: '#6b7280' };
      var src = srcMap[r.url];
      var st = (src && src.media) || mediaStatus(r.snippet);
      var tags = ['<span class="ais-avail is-' + st + '">' + MEDIA_STATUS[st] + '</span>'];
      if (src) tags.push('<span class="ais-badge is-src">来源 [' + src.idx + ']</span>');
      tags.push('<span class="ais-badge is-trust">官方平台</span>');
      return '<article class="ais-hit is-media">' +
        '<div class="ais-hit-top">' +
          '<span class="ais-plat-badge" style="--pc:' + site.color + '"><i></i>' + esc(site.name) + '</span>' +
          '<a class="ais-hit-title" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' +
            esc(r.title) + '</a>' +
        '</div>' +
        '<div class="ais-hit-url">' + esc(r.host) + '<span class="ais-hit-path">' + esc(pathOf(r.url)) + '</span></div>' +
        (r.snippet ? '<p class="ais-hit-sn">' + highlight(r.snippet, S.q) + '</p>' : '') +
        '<div class="ais-hit-tags">' + tags.join('') +
          '<a class="ais-watch" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">去官方观看 ›</a>' +
        '</div>' +
      '</article>';
    }).join('');

    renderFilteredText(true);
    renderUnofficial();
    box.classList.toggle('is-folded', S.folded);
    setTools();
  }

  /* 非官方来源单独一栏，分两块：
   *   · 视频直链：只给文件地址与下载入口；
   *   · 网页：不给裸链接，只能经内置浏览器「安全打开」，由它拦截广告与追踪、弹窗、下载和权限申请。
   * 磁力、网盘、种子一律不收。 */
  function renderUnofficial() {
    var wrap = $('.ais-extra');
    if (!wrap) return;
    var files = S.other || [];
    var pages = S.pages || [];
    var show = S.mode === 'media' && (files.length + pages.length) > 0;
    wrap.classList.toggle('hidden', !show);
    if (!show) return;
    var box = $('.ais-extra-list');
    if (!box) return;
    var html = '';
    if (files.length) {
      html += '<div class="ais-extra-cap">视频直链 · 仅下载</div>' + files.map(function (it) {
        return '<div class="ais-extra-item">' +
          '<div class="ais-extra-main">' +
            '<span class="ais-extra-title">' + esc(it.title) + '</span>' +
            '<span class="ais-extra-meta">' + esc(it.host) + ' · ' + esc(String(it.ext).toUpperCase()) + '</span>' +
          '</div>' +
          '<a class="ais-dl" href="' + esc(it.url) + '" download target="_blank" rel="nofollow noopener noreferrer">下载视频</a>' +
        '</div>';
      }).join('');
    }
    if (pages.length) {
      html += '<div class="ais-extra-cap">网页 · 安全打开</div>' + pages.map(function (it) {
        return '<div class="ais-extra-item">' +
          '<div class="ais-extra-main">' +
            '<span class="ais-extra-title">' + esc(it.title) + '</span>' +
            '<span class="ais-extra-meta">' + esc(it.host) + ' · 非官方</span>' +
          '</div>' +
          '<button type="button" class="ais-open" data-open="' + esc(it.url) + '" title="在受保护的内置浏览器中打开">安全打开</button>' +
        '</div>';
      }).join('');
    }
    box.innerHTML = html;
  }

  function renderFilteredText(media) {
    var filtered = $('.ais-filtered');
    if (!filtered) return;
    if (media) {
      var extra = (S.other || []).length + (S.pages || []).length;
      var bits = [];
      if (S.dropped.length) {
        var mwhy = {};
        S.dropped.forEach(function (d) { mwhy[d.why] = (mwhy[d.why] || 0) + 1; });
        bits.push('已过滤 <b>' + S.dropped.length + '</b> 条 ' +
          esc(Object.keys(mwhy).map(function (k) { return k + ' ' + mwhy[k]; }).join(' · ')));
      }
      if (extra) bits.push('非官方 <b>' + extra + '</b> 条已单列');
      filtered.innerHTML = bits.length ? bits.join(' · ') : '<span class="ais-why">结果均来自官方平台</span>';
      return;
    }
    if (!S.dropped.length) {
      filtered.innerHTML = '<span class="ais-why">未发现广告 / 下载站结果</span>';
      return;
    }
    var why = {};
    S.dropped.forEach(function (d) { why[d.why] = (why[d.why] || 0) + 1; });
    var parts = Object.keys(why).map(function (k) { return k + ' ' + why[k]; });
    filtered.innerHTML = '已过滤 <b>' + S.dropped.length + '</b> 条 <span class="ais-why">' +
      esc(parts.join(' · ')) + '</span>';
  }

  function srcStatusText(s) {
    if (s.status === 'read') return '已读 ' + (s.chars > 999 ? (s.chars / 1000).toFixed(1) + 'k' : s.chars) + ' 字';
    if (s.status === 'loading') return '读取中…';
    if (s.status === 'snippet') return s.err ? ('仅摘要 · ' + s.err) : '仅摘要';
    return '等待读取';
  }

  function renderSources() {
    var box = $('.ais-sources');
    if (!box) return;
    var n = $('.ais-card-n');
    if (n) n.textContent = S.sources.length ? (S.sources.filter(function (s) { return s.status === 'read'; }).length + ' / ' + S.sources.length + ' 篇已读') : '';
    if (!S.sources.length) {
      box.innerHTML = '<div class="ais-side-idle">检索到网页后按编号列在这里。</div>';
      return;
    }
    box.innerHTML = S.sources.map(function (s) {
      return '<a class="ais-src is-' + esc(s.status) + '" id="ais-src-' + s.idx + '" href="' + esc(s.url) +
        '" target="_blank" rel="noopener noreferrer" title="' + esc(s.title) + '">' +
        '<span class="ais-src-idx">' + s.idx + '</span>' +
        '<span class="ais-src-main">' +
          '<span class="ais-src-title">' + esc(s.title) + '</span>' +
          '<span class="ais-src-meta">' + esc(s.host) + ' · ' + esc(srcStatusText(s)) + '</span>' +
        '</span>' +
      '</a>';
    }).join('');
    if (S.phase === 'reading') updatePhaseText();
  }

  function scheduleAnswer() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(function () {
      S.raf = 0;
      renderAnswer();
    });
  }

  function renderAnswer() {
    var body = $('.ais-answer-body');
    var foot = $('.ais-answer-foot');
    var state = $('.ais-answer-state');
    if (!body) return;

    if (S.error) {
      body.dataset.empty = '0';
      body.innerHTML = errorBlock(S.error);
      if (foot) foot.textContent = '';
      if (state) state.textContent = '失败';
      setTools();
      return;
    }

    if (!S.answer) {
      body.dataset.empty = '1';
      body.innerHTML = '<div class="ais-answer-idle">' +
        esc(S.note || (S.busy ? '正在读正文，稍后在这里给出摘要…' : '输入问题后，这里会先显示 AI 读完原文的结论。')) +
      '</div>';
      if (foot) foot.textContent = '';
      if (state) state.textContent = S.busy ? '准备中' : (S.note ? '无正文' : '');
      setTools();
      return;
    }

    body.dataset.empty = '0';
    body.innerHTML = renderMarkdown(S.answer) + (S.streaming ? '<span class="ais-caret"></span>' : '');
    if (state) {
      state.textContent = S.streaming ? '生成中' : (S.llmOff ? '未配置模型' : '已生成');
      state.className = 'ais-answer-state' + (S.llmOff ? ' is-warn' : '');
    }
    if (foot) {
      var bits = [];
      if (S.sources.length) {
        var read = S.sources.filter(function (s) { return s.status === 'read'; }).length;
        bits.push('阅读 ' + read + ' / ' + S.sources.length + ' 篇正文');
      }
      if (S.startedAt) bits.push('用时 ' + msText(Date.now() - S.startedAt));
      bits.push('内容可能有误，请点来源核对');
      foot.innerHTML = esc(bits.join(' · ')) +
        (S.note ? '<span class="ais-note">' + esc(S.note) + '</span>' : '') +
        (S.llmOff ? '<span class="ais-note">语言模型未配置：到 设置 → 语言模型 填好接口后可生成摘要。</span>' : '');
    }
    setTools();
  }

  function errorBlock(msg) {
    var hint = '';
    if (/中转|连不上|网络|超时|fetch/i.test(msg)) {
      hint = '<span class="ais-err-hint">联网检索经本地中转（127.0.0.1:8787）转发。请到 设置 → 本地中转 启动服务后重试。</span>';
    }
    return '<div class="ais-err">' +
      '<div class="ais-err-t">检索没有完成</div>' +
      '<div class="ais-err-m">' + esc(msg) + '</div>' + hint +
      '<button type="button" class="ais-retry" data-act="retry">重试</button>' +
    '</div>';
  }

  /* ---------------- Markdown 渲染 ----------------
   * 只支持摘要会用到的子集：标题、列表、引用、粗体、行内代码、链接、来源编号。
   * 所有文本先转义再拼标签，模型输出里的 HTML 不会被执行。 */
  function inlineMd(raw) {
    var t = esc(raw);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/\[(\d{1,2})\]/g, function (m, n) {
      return '<a class="ais-cite" href="#ais-src-' + n + '" data-cite="' + n + '">[' + n + ']</a>';
    });
    return t;
  }

  function renderMarkdown(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var h = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line);
      if (h) { out.push('<h3>' + inlineMd(h[2]) + '</h3>'); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        var bq = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) bq.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + bq.map(inlineMd).join('<br>') + '</blockquote>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) ul.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
        out.push('<ul>' + ul.map(function (x) { return '<li>' + inlineMd(x) + '</li>'; }).join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+[.、)]\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.、)]\s+/.test(lines[i])) ol.push(lines[i++].replace(/^\s*\d+[.、)]\s+/, ''));
        out.push('<ol>' + ol.map(function (x) { return '<li>' + inlineMd(x) + '</li>'; }).join('') + '</ol>');
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s{0,3}#{1,4}\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+[.、)]\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*```/.test(lines[i])) {
        para.push(lines[i++]);
      }
      out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
    }
    return out.join('');
  }

  /* 非官方网页不给裸链接：转交内置浏览器打开。
     Electron 里它是独立 webview，主进程对 guest 会话做了广告/追踪拦截、
     弹窗拒绝、下载拦截与权限拒绝（见 electron/main.js 的 hardenGuestSession）。 */
  function openGuarded(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    window.__bwPendingUrl = url;
    if (typeof window.openDeskApp === 'function') {
      window.openDeskApp('browser');
    } else {
      S.note = '内置浏览器不可用，未打开该页面。';
      renderAnswer();
    }
  }

  /* ---------------- 环境状态 ---------------- */
  function checkEnv() {
    var net = $('.ais-net');
    if (!net) return;
    var conn = llmConnSafe();
    var llmOk = !!(conn && conn.base && conn.key && conn.model);
    var applied = false;
    function apply(relayOk) {
      if (applied) return;
      applied = true;
      net.classList.toggle('is-ok', !!relayOk);
      net.classList.toggle('is-bad', !relayOk);
      net.classList.toggle('is-llm', llmOk);
      var txt = $('.ais-net-txt');
      if (txt) txt.textContent = (relayOk ? '联网就绪' : '中转未启动') + (llmOk ? ' · 模型就绪' : '');
      net.title = '本地中转 127.0.0.1:8787：' + (relayOk ? '正常' : '未启动') + '\n语言模型：' + (llmOk ? '已配置' : '未配置');
    }
    var timer = setTimeout(function () { apply(false); }, 2500);
    fetch(relayHealthUrl(), { signal: AbortSignal.timeout(2400) })
      .then(function (r) { clearTimeout(timer); apply(r.ok); })
      .catch(function () { clearTimeout(timer); apply(false); });
  }

  /* ---------------- 事件 ---------------- */
  function bind(body) {
    body.addEventListener('submit', function (e) {
      if (!e.target.classList.contains('ais-form') && !e.target.classList.contains('ais-hero-form')) return;
      e.preventDefault();
      var input = e.target.querySelector('input');
      runSearch(input ? input.value : '');
    });

    body.addEventListener('input', function (e) {
      if (!e.target.classList || !e.target.classList.contains('ais-input') && !e.target.classList.contains('ais-hero-input')) return;
      var clear = $('[data-act="clear"]');
      if (clear) clear.classList.toggle('hidden', !e.target.value);
    });

    body.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (S.busy) { stopSearch(); e.preventDefault(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        focusInput();
      }
    });

    body.addEventListener('click', function (e) {
      /* 只认模式按钮上的 data-mode：结果区根节点也用 data-mode 标记 home/result，
         范围放大就会把任意点击当成切换模式。 */
      var el = e.target.closest ? e.target.closest('[data-act],[data-q],[data-hist],[data-cite],[data-open],.ais-mode[data-mode]') : null;
      if (!el) return;
      var act = el.getAttribute('data-act');
      if (el.hasAttribute('data-mode')) {
        setMode(el.getAttribute('data-mode'));
        return;
      }
      if (el.hasAttribute('data-q')) {
        var q = el.getAttribute('data-q');
        syncInputs(q);
        runSearch(q);
        return;
      }
      if (el.hasAttribute('data-hist')) {
        var hq = el.getAttribute('data-hist');
        syncInputs(hq);
        runSearch(hq);
        return;
      }
      if (el.hasAttribute('data-open')) {
        openGuarded(el.getAttribute('data-open'));
        return;
      }
      if (el.hasAttribute('data-cite')) {
        var n = el.getAttribute('data-cite');
        var target = document.getElementById('ais-src-' + n);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.remove('is-flash');
          void target.offsetWidth;
          target.classList.add('is-flash');
        }
        return;
      }
      if (act === 'home') {
        abortAll();
        showResult(false);
        focusInput();
      } else if (act === 'clear') {
        syncInputs('');
        focusInput();
      } else if (act === 'stop') {
        stopSearch();
      } else if (act === 'deepen') {
        deepenSearch();
      } else if (act === 'regen') {
        if (!S.busy && S.sources.length) {
          S.busy = true;
          S.streaming = false;
          S.answer = '';
          S.error = '';
          S.note = '';
          S.llmOff = false;
          S.phase = 'writing';
          S.startedAt = Date.now();
          setPhase('writing');
          renderAnswer();
          var ctrl = new AbortController();
          S.ctrl = ctrl;
          writeAnswer(ctrl.signal).then(function () {
            if (ctrl.signal.aborted) return;
            S.busy = false;
            S.phase = 'done';
            setPhase('done');
            renderAnswer();
          });
        }
      } else if (act === 'copy') {
        copyAnswer(el);
      } else if (act === 'retry') {
        runSearch(S.q);
      } else if (act === 'fold') {
        S.folded = !S.folded;
        var list = $('.ais-list');
        if (list) list.classList.toggle('is-folded', S.folded);
        setTools();
      } else if (act === 'clearhist') {
        S.hist = [];
        saveHist();
        renderHist();
      } else if (act === 'assist') {
        S.assistOn = !S.assistOn;
        try { localStorage.setItem(LS_ASSIST, S.assistOn ? '1' : '0'); } catch (e) { /* 忽略 */ }
        applyAssistUI();
      } else if (act === 'net') {
        checkEnv();
      }
    });
  }

  function copyAnswer(btn) {
    var text = S.answer || '';
    if (!text) return;
    function done() {
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    try { ta.select(); document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  /* ---------------- 注册 ---------------- */
  registerApp({
    id: 'aisearch',
    name: '智搜',
    title: '智搜 · AI 搜索',
    sub: '读原文、滤广告；也能找官方免费片源',
    cls: 'aisearch',
    order: 25,
    icon: ICON,
    css: ['apps/aisearch/app.css'],

    mount: function (body) {
      if (body.dataset.ready === '1') {
        /* 切回来只刷新历史与环境状态，不重建 DOM —— 当前问题和摘要必须还在 */
        renderHist();
        checkEnv();
        return;
      }
      body.innerHTML = window.AIS_BODY || '<div class="ais-root"><div class="ais-err">缺少 body.js</div></div>';
      S.body = body;
      try { S.mode = localStorage.getItem('hf_aisearch_mode') === 'media' ? 'media' : 'web'; }
      catch (e) { S.mode = 'web'; }
      try { S.assistOn = localStorage.getItem(LS_ASSIST) !== '0'; }
      catch (e) { S.assistOn = true; }
      loadHist();
      bind(body);
      applyModeUI();
      applyAssistUI();
      renderHist();
      body.dataset.ready = '1';
      checkEnv();
      setTimeout(function () { focusInput(); }, 80);
    }
  });
})();

/* ---- apps/arm101/body.js ---- */
/* 101 机械臂控制台的窗口 DOM。
 *
 * 单独放 body.js 是因为结构比模板 App 长；app-scan 会自动把它排在 app.js 之前内联。
 * 这里只有骨架：关节行由 app.js 按 JOINTS 生成，三维场景画在 .arm101-canvas 上。
 */
window.ARM101_BODY = `
<div class="arm101-root">
  <section class="arm101-stage" data-stage>
    <canvas class="arm101-canvas" data-canvas></canvas>

    <div class="arm101-topbar">
      <div class="arm101-brand">
        <span class="arm101-brand-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 20.5h7"/>
            <path d="M8 20.5v-2.6"/>
            <circle cx="8.2" cy="16.2" r="1.7"/>
            <path d="m9.6 15.1 3.9-4.6"/>
            <circle cx="14.8" cy="9" r="1.7"/>
            <path d="m16.1 7.9 2.4-1.9"/>
            <path d="m18.1 6.4 2.2 2.1"/>
            <path d="m18.7 6.6-1.2 2.8"/>
          </svg>
        </span>
        <span class="arm101-brand-txt"><b>SO-101</b><i>六轴机械臂 · 数字孪生</i></span>
      </div>
      <span class="arm101-conn" data-conn><i></i><b>串口未连接</b></span>
    </div>

    <div class="arm101-readout">
      <div class="arm101-stat"><label>TIP X</label><b data-tip-x>—</b><i>mm</i></div>
      <div class="arm101-stat"><label>TIP Y</label><b data-tip-y>—</b><i>mm</i></div>
      <div class="arm101-stat"><label>TIP Z</label><b data-tip-z>—</b><i>mm</i></div>
      <div class="arm101-stat"><label>PACKETS</label><b data-pkts>0</b><i>帧</i></div>
    </div>

    <div class="arm101-stagefoot">
      <span class="arm101-hint">拖拽旋转 · 滚轮缩放</span>
      <button type="button" class="arm101-ghost" data-act="view">重置视角</button>
    </div>

    <div class="arm101-estop-banner" data-estop hidden>急停已触发 · 舵机力矩已切断</div>
    <div class="arm101-fallback" data-fallback hidden>当前环境无法创建 WebGL 上下文</div>
  </section>

  <aside class="arm101-panel">
    <header class="arm101-phead">
      <div>
        <h1>101 机械臂 <span>控制台</span></h1>
        <p>6 自由度 · STS3215 总线舵机 · 1 Mbps</p>
      </div>
      <button type="button" class="arm101-link" data-act="link">断开串口</button>
    </header>

    <div class="arm101-sechead">
      <span>关节指令</span>
      <span class="arm101-secmeta">ID 01–06 · 4096 ticks</span>
    </div>
    <div class="arm101-joints" data-joints></div>

    <div class="arm101-speed">
      <span>运动速度</span>
      <input type="range" min="1" max="10" step="1" value="5" data-speed aria-label="运动速度">
      <b data-speed-v>5</b>
    </div>

    <div class="arm101-actions">
      <button type="button" class="arm101-btn arm101-btn-main" data-act="send">发送信号</button>
      <button type="button" class="arm101-btn" data-act="home">回到 Home</button>
      <button type="button" class="arm101-btn" data-act="demo">演示序列</button>
      <button type="button" class="arm101-btn arm101-btn-danger" data-act="estop">急停</button>
    </div>

    <div class="arm101-sechead arm101-sechead-log">
      <span>信号监视器</span>
      <span class="arm101-secmeta">SCS · 8N1</span>
    </div>
    <div class="arm101-log" data-log aria-live="polite"></div>
  </aside>
</div>
`;

/* ---- apps/arm101/app.js ---- */
/* 101 机械臂控制台 —— 等比例 3D 孪生 + 总线舵机信号仿真。
 *
 * 机型参照开源 SO-101（LeRobot）六轴桌面臂：5 个旋转关节 + 1 个夹爪，
 * 舵机按 Feetech STS3215 建模，通信按 SCS 总线帧（FF FF ID LEN INSTR ... CHK）。
 * 这里不连接真实硬件：滑杆 → 目标角 → 位置指令 → 3D 臂平滑跟随，
 * 信号监视器里能看到实际拼出来的十六进制帧，方便对照真机协议。
 *
 * 三维场景用 index.html 里已加载的全局 THREE + OrbitControls（r149）。
 */
(function () {
  'use strict';

  /* ---------- 机型参数 ----------
   * 关节顺序、行程与零位取自 SO-ARM100 官方 URDF（so101_new_calib.urdf）：
   * shoulder_pan ±110°、shoulder_lift ±100°、elbow_flex ±96.8°、
   * wrist_flex ±95°、wrist_roll −157.2°…162.8°、gripper −10°…100°。
   * 连杆长度：肩→肘 116 mm，肘→腕 135 mm，腕→腕转 61.1 mm，腕转→夹持点 98.1 mm。
   */
  var JOINTS = [
    { key: 'pan',   id: 1, label: '底座回转', en: 'shoulder_pan',  min: -110, max: 110, unit: '°' },
    { key: 'lift',  id: 2, label: '大臂俯仰', en: 'shoulder_lift', min: -100, max: 100, unit: '°' },
    { key: 'elbow', id: 3, label: '小臂俯仰', en: 'elbow_flex',    min: -97,  max: 97,  unit: '°' },
    { key: 'wrist', id: 4, label: '腕部俯仰', en: 'wrist_flex',    min: -95,  max: 95,  unit: '°' },
    { key: 'roll',  id: 5, label: '腕部旋转', en: 'wrist_roll',    min: -157, max: 163, unit: '°' },
    { key: 'grip',  id: 6, label: '夹爪开合', en: 'gripper',       min: 0,    max: 100, unit: '%' }
  ];

  /* 零位是「大臂竖直、小臂水平前伸」的 L 形，肘角为正 = 小臂向下折，lift 为负 = 整条臂上抬。
   * 下面这些姿态都用官方 URDF 正运动学校核过：HOME 末端在 (277, 153, 0) mm，
   * 抓取位在 (238, 16, 0) mm 且工具朝下，夹指正好落在 30 mm 工件的两侧。 */
  var HOME_POSE = { pan: 0, lift: -36, elbow: 24, wrist: 50, roll: 0, grip: 35 };

  var PICK_POSE = { pan: 0, lift: 0, elbow: 26, wrist: 55, roll: 0, grip: 60 };

  /* 夹爪：0% 合拢（夹指内距约 10 mm）、100% 全开约 63 mm；
   * 夹住 30 mm 工件时舵轴停在 12°（按官方 STL 实测内距≈30 mm） */
  var GRIP_CLOSED = -7;
  var GRIP_SPAN = 50;
  var GRASP_DEG = 12;

  var PIECE_HOME = { x: 0.25, y: 0.015, z: 0 };

  var DEMO = [
    { label: '观察位 · 抬臂张开夹爪', pose: { pan: 0,   lift: -36, elbow: 24,  wrist: 50, roll: 0, grip: 85 } },
    { label: '接近工件 · 移至上方',   pose: { pan: 0,   lift: 0,   elbow: 20,  wrist: 62, roll: 0, grip: 85 } },
    { label: '下探 · 对准夹取点',     pose: { pan: 0,   lift: 0,   elbow: 26,  wrist: 55, roll: 0, grip: 85 } },
    { label: '夹持 · 闭合夹爪',       pose: PICK_POSE },
    { label: '抬升 · 保持夹持',       pose: { pan: 0,   lift: 0,   elbow: -10, wrist: 80, roll: 0, grip: 60 } },
    { label: '转移 · 底座回转',       pose: { pan: -28, lift: 0,   elbow: -10, wrist: 80, roll: 0, grip: 60 } },
    { label: '下放 · 下降到位',       pose: { pan: -28, lift: 0,   elbow: 26,  wrist: 55, roll: 0, grip: 60 } },
    { label: '释放 · 张开夹爪',       pose: { pan: -28, lift: 0,   elbow: 26,  wrist: 55, roll: 0, grip: 88 } },
    { label: '复位 · 回到 Home',      pose: HOME_POSE }
  ];

  /* ---------- 运行状态 ---------- */
  var S = {
    body: null, win: null, stage: null, canvas: null,
    refs: {}, rig: null, scene: null, camera: null, renderer: null, controls: null,
    cur: {}, goal: {}, speed: 5,
    linked: true, estop: false, demo: false, demoStep: 0, demoTimer: 0,
    packets: 0, lastTs: 0, lastTip: 0, raf: 0, started: false,
    view0: null, tmp: null, piece: null, held: false
  };

  /* ---------- 小工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad4(n) { return ('0000' + n).slice(-4); }
  function hex8(n) { return ('0' + (n & 255).toString(16).toUpperCase()).slice(-2); }
  function nowStr() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + ('00' + d.getMilliseconds()).slice(-3);
  }
  function ticksFor(j, value) {
    return Math.round(clamp((value - j.min) / (j.max - j.min), 0, 1) * 4095);
  }

  /* ---------- SCS 总线帧（Feetech 兼容） ---------- */
  function frameWrite(id, ticks) {
    var params = [0x2A, ticks & 255, (ticks >> 8) & 255];
    var len = params.length + 2;
    var sum = id + len + 0x03;
    for (var i = 0; i < params.length; i++) sum += params[i];
    var all = [0xFF, 0xFF, id, len, 0x03].concat(params, [(~sum) & 255]);
    return all.map(hex8).join(' ');
  }

  function frameSync(list) {
    var params = [0x2A, 0x02];
    list.forEach(function (x) {
      params.push(x.id, x.ticks & 255, (x.ticks >> 8) & 255);
    });
    var len = params.length + 2;
    var sum = 0xFE + len + 0x83;
    for (var i = 0; i < params.length; i++) sum += params[i];
    var all = [0xFF, 0xFF, 0xFE, len, 0x83].concat(params, [(~sum) & 255]);
    return all.map(hex8).join(' ');
  }

  function syncList() {
    return JOINTS.map(function (j) {
      return { id: j.id, ticks: ticksFor(j, S.goal[j.key]) };
    });
  }

  /* ---------- 信号监视器 ---------- */
  function log(kind, text) {
    var el = S.refs.log;
    if (!el) return;
    var stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 26;
    var line = document.createElement('div');
    line.className = 'arm101-line is-' + kind;
    var tag = kind === 'tx' ? 'TX' : kind === 'rx' ? 'RX' : kind === 'err' ? 'STOP' : 'SYS';
    line.innerHTML = '<span class="arm101-time"></span><span class="arm101-tag"></span><span class="arm101-msg"></span>';
    line.querySelector('.arm101-time').textContent = nowStr();
    line.querySelector('.arm101-tag').textContent = tag;
    line.querySelector('.arm101-msg').textContent = text;
    el.appendChild(line);
    while (el.children.length > 140) el.removeChild(el.firstChild);
    if (stick) el.scrollTop = el.scrollHeight;
  }

  /* ---------- 三维模型 ----------
   * 打印件与舵机直接用 SO-101 官方 STL（parts.js，int16 量化 0.1 mm）。
   * 关节原点 / 视件 origin 均按官方 URDF（so101_new_calib.urdf）摆放：
   *   URDF 是 Z 轴朝上，这里把整机挂在一个绕 X 轴 −90° 的组里，场景仍然是 Y 轴朝上。
   */
  var M = null;
  var ZAXIS = new THREE.Vector3(0, 0, 1);
  var _q = new THREE.Quaternion();

  function buildMaterials() {
    return {
      body:   new THREE.MeshStandardMaterial({ color: 0xeae6dc, roughness: 0.6,  metalness: 0.03 }),
      body2:  new THREE.MeshStandardMaterial({ color: 0xd6d0c3, roughness: 0.7,  metalness: 0.03 }),
      servo:  new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.44, metalness: 0.32 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xef9f3c, roughness: 0.4,  metalness: 0.24 }),
      dark:   new THREE.MeshStandardMaterial({ color: 0x3b414a, roughness: 0.62, metalness: 0.18 }),
      mat:    new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.94, metalness: 0.04 }),
      piece:  new THREE.MeshStandardMaterial({ color: 0xd9544a, roughness: 0.52, metalness: 0.08 })
    };
  }

  function roundedGeo(w, h, d, r) {
    var s = new THREE.Shape();
    var x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    var geo = new THREE.ExtrudeGeometry(s, {
      depth: d, bevelEnabled: true,
      bevelThickness: Math.min(r * 0.55, d * 0.22),
      bevelSize: Math.min(r * 0.55, 0.0016),
      bevelSegments: 2, curveSegments: 5
    });
    geo.center();
    return geo;
  }

  function ring(parent, radius, tube, mat, y) {
    var m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 72), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    parent.add(m);
    return m;
  }

  /* URDF 的 rpy = Rz(yaw) · Ry(pitch) · Rx(roll) */
  function quatRpy(r, p, y) {
    var m = new THREE.Matrix4();
    m.multiplyMatrices(
      new THREE.Matrix4().makeRotationZ(y),
      new THREE.Matrix4().makeRotationY(p)
    ).multiply(new THREE.Matrix4().makeRotationX(r));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  function partAt(parent, xyz, rpy) {
    var g = new THREE.Group();
    g.position.set(xyz[0], xyz[1], xyz[2]);
    if (rpy) g.quaternion.copy(quatRpy(rpy[0], rpy[1], rpy[2]));
    parent.add(g);
    return g;
  }

  /* 关节组：记住初始姿态，后面绕自身 Z 轴叠加转角 */
  function jointAt(parent, xyz, rpy) {
    var g = partAt(parent, xyz, rpy);
    g.userData.base = g.quaternion.clone();
    return g;
  }

  function spin(g, deg) {
    if (!g || !g.userData.base) return;
    _q.setFromAxisAngle(ZAXIS, deg * Math.PI / 180);
    g.quaternion.copy(g.userData.base).multiply(_q);
  }

  /* parts.js 按需加载：只有打开本 App 才付这 2.6 MB 的解析成本 */
  function loadParts(done) {
    if (window.ARM101_PARTS) { done(true); return; }
    var s = document.createElement('script');
    s.src = 'apps/arm101/parts.js';
    s.onload = function () { done(!!window.ARM101_PARTS); };
    s.onerror = function () { done(false); };
    document.head.appendChild(s);
  }

  var geoCache = {};

  /* int16（0.1 mm）→ Float32 米制顶点；三角面法线在运行时算一次 */
  function partGeo(key) {
    if (geoCache[key]) return geoCache[key];
    var rec = window.ARM101_PARTS && window.ARM101_PARTS[key];
    if (!rec) return null;
    var bin = atob(rec.b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var q = new Int16Array(bytes.buffer);
    var pos = new Float32Array(q.length);
    for (var k = 0; k < q.length; k++) pos[k] = q[k] * 0.0001;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geoCache[key] = geo;
    return geo;
  }

  /* 按 URDF 视件 origin 摆一个 STL 零件 */
  function partMesh(parent, key, xyz, rpy, mat) {
    var geo = partGeo(key);
    if (!geo) return null;
    var g = partAt(parent, xyz, rpy);
    var m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return g;
  }

  /* ---------- 机体：底座 / 旋转座 / 大臂 / 小臂 / 腕 / 夹爪 ---------- */

  function buildBase(parent, ledMat) {
    /* base_link：底板 + 电机座 + 底盘舵机 */
    partMesh(parent, 'base', [-0.00636471, 0, -0.0024], [Math.PI / 2, 0, Math.PI / 2], M.body);
    partMesh(parent, 'baseHolder', [-0.00636471, -0.0000994414, -0.0024], [Math.PI / 2, 0, Math.PI / 2], M.body2);
    partMesh(parent, 'servo', [0.0263353, 0, 0.0437], [0, 0, 0], M.servo);

    /* 状态指示灯：嵌在底座前立面，正对默认视角 */
    var led = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 14, 12), ledMat);
    led.position.set(0.0645, -0.035, 0.009);
    parent.add(led);
    return { led: led };
  }

  function buildPan(pan) {
    /* shoulder_link：肩部舵机 + 电机座 + 俯仰拱架 */
    partMesh(pan, 'motorHolderBase', [-0.0675992, -0.000177759, 0.0158499], [Math.PI / 2, -Math.PI / 2, 0], M.body2);
    partMesh(pan, 'rotationPitch', [0.0122008, 0.0000222413, 0.0464], [-Math.PI / 2, 0, 0], M.body);
    partMesh(pan, 'servo', [-0.0303992, 0.000422241, -0.0417], [Math.PI / 2, Math.PI / 2, 0], M.servo);
  }

  function buildUpperArm(lift) {
    /* upper_arm_link：142.1 × 24.5 × 67.3 mm 打印件 + 肘部舵机 */
    partMesh(lift, 'upperArm', [-0.065085, 0.012, 0.0182], [Math.PI, 0, 0], M.body);
    partMesh(lift, 'servo', [-0.11257, -0.0155, 0.0187], [-Math.PI, 0, -Math.PI / 2], M.servo);
  }

  function buildLowerArm(elbow) {
    /* lower_arm_link：小臂打印件 + 腕部电机座 + 腕部舵机 */
    partMesh(elbow, 'underArm', [-0.0648499, -0.032, 0.0182], [Math.PI, 0, 0], M.body);
    partMesh(elbow, 'motorHolderWrist', [-0.0648499, -0.032, 0.018], [-Math.PI, 0, 0], M.body2);
    partMesh(elbow, 'servo', [-0.1224, 0.0052, 0.0187], [-Math.PI, 0, -Math.PI], M.servo);
  }

  function buildWrist(wrist) {
    /* wrist_link：俯仰叉架 + 腕转舵机（官方用 no_horn 版，现有 STL 带舵盘，藏在叉架内） */
    partMesh(wrist, 'wristRollPitch', [0, -0.028, 0.0181], [-Math.PI / 2, -Math.PI / 2, 0], M.body);
    partMesh(wrist, 'servo', [0, -0.0424, 0.0306], [Math.PI / 2, Math.PI / 2, 0], M.servo);
  }

  function buildGripper(roll) {
    /* gripper_link：腕转从动件（含固定夹指）+ 第 6 轴舵机 */
    partMesh(roll, 'wristRollFollower', [0, -0.000218214, 0.000949706], [-Math.PI, 0, 0], M.body);
    partMesh(roll, 'servo', [0.0077, 0.0001, -0.0234], [-Math.PI / 2, 0, 0], M.servo);

    /* 指尖参考系：URDF gripper_frame_joint */
    var tip = new THREE.Object3D();
    tip.position.set(-0.0079, -0.000218121, -0.0981274);
    tip.rotation.y = Math.PI;
    roll.add(tip);
    return tip;
  }

  function buildMovingJaw(jaw) {
    /* 动夹指：绕自身 Z 轴摆动的摇臂 */
    partMesh(jaw, 'movingJaw', [0, 0, 0.0189], [0, 0, 0], M.body2);
  }

  function buildRig() {
    var root = new THREE.Group();
    var urdf = new THREE.Group();
    urdf.rotation.x = -Math.PI / 2;          /* URDF Z-up → 场景 Y-up */
    root.add(urdf);

    var ledMat = new THREE.MeshStandardMaterial({
      color: 0x36e07f, emissive: 0x36e07f, emissiveIntensity: 2.4, roughness: 0.4
    });

    buildBase(urdf, ledMat);

    /* shoulder_pan */
    var pan = jointAt(urdf, [0.0388353, 0, 0.0624], [Math.PI, 0, -Math.PI]);
    buildPan(pan);

    /* shoulder_lift */
    var lift = jointAt(pan, [-0.0303992, -0.0182778, -0.0542], [-Math.PI / 2, -Math.PI / 2, 0]);
    buildUpperArm(lift);

    /* elbow_flex */
    var elbow = jointAt(lift, [-0.11257, -0.028, 0], [0, 0, Math.PI / 2]);
    buildLowerArm(elbow);

    /* wrist_flex */
    var wrist = jointAt(elbow, [-0.1349, 0.0052, 0], [0, 0, -Math.PI / 2]);
    buildWrist(wrist);

    /* wrist_roll */
    var roll = jointAt(wrist, [0, -0.0611, 0.0181], [Math.PI / 2, 0.0486795, Math.PI]);
    var tip = buildGripper(roll);

    /* gripper（动夹指） */
    var jaw = jointAt(roll, [0.0202, 0.0188, -0.0234], [Math.PI / 2, 0, 0]);
    buildMovingJaw(jaw);

    return {
      root: root, urdf: urdf, pan: pan, lift: lift, elbow: elbow,
      wrist: wrist, roll: roll, jaw: jaw, tip: tip, led: ledMat
    };
  }


  /* ---------- 场景 ---------- */
  function initScene() {
    if (!window.THREE || typeof THREE.WebGLRenderer !== 'function') {
      showFallback('三维引擎未加载');
      return;
    }
    var stage = S.stage;
    var canvas = S.canvas;
    M = buildMaterials();

    try {
      S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    } catch (e) {
      showFallback('当前环境无法创建 WebGL 上下文');
      return;
    }

    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.shadowMap.enabled = true;
    S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if ('outputEncoding' in S.renderer) S.renderer.outputEncoding = THREE.sRGBEncoding;
    if ('toneMapping' in S.renderer) {
      S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      S.renderer.toneMappingExposure = 1.0;
    }

    S.scene = new THREE.Scene();
    S.camera = new THREE.PerspectiveCamera(34, 1, 0.01, 20);
    S.camera.position.set(0.68, 0.46, 0.72);

    S.controls = new THREE.OrbitControls(S.camera, canvas);
    S.controls.enableDamping = true;
    S.controls.dampingFactor = 0.075;
    S.controls.enablePan = false;
    S.controls.minDistance = 0.35;
    S.controls.maxDistance = 2.6;
    S.controls.maxPolarAngle = Math.PI * 0.495;
    S.controls.target.set(0.2, 0.17, -0.02);
    S.controls.update();

    S.view0 = { pos: S.camera.position.clone(), target: S.controls.target.clone() };

    /* 灯光 */
    S.scene.add(new THREE.HemisphereLight(0xf1f5ff, 0x14171c, 0.9));

    var key = new THREE.DirectionalLight(0xfff4e6, 2.05);
    key.position.set(0.7, 1.2, 0.55);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.05;
    key.shadow.camera.far = 2.6;
    key.shadow.camera.left = -0.62;
    key.shadow.camera.right = 0.62;
    key.shadow.camera.top = 0.8;
    key.shadow.camera.bottom = -0.12;
    key.shadow.bias = -0.0005;
    key.shadow.radius = 3;
    S.scene.add(key);

    var fill = new THREE.DirectionalLight(0x9db9dd, 0.6);
    fill.position.set(-0.62, 0.45, -0.52);
    S.scene.add(fill);

    var rim = new THREE.DirectionalLight(0xffc68a, 0.95);
    rim.position.set(-0.3, 0.34, 0.7);
    S.scene.add(rim);

    /* 工作台：半径 500 mm，够放整条臂的伸展范围 */
    var mat = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.014, 80), M.mat);
    mat.position.y = -0.007;
    mat.receiveShadow = true;
    S.scene.add(mat);

    ring(S.scene, 0.492, 0.0018, M.accent, 0.0014).material = new THREE.MeshStandardMaterial({
      color: 0xef9f3c, emissive: 0xef9f3c, emissiveIntensity: 0.45, roughness: 0.6
    });
    var r1 = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.0008, 6, 96), M.dark);
    r1.rotation.x = -Math.PI / 2;
    r1.position.y = 0.0014;
    S.scene.add(r1);

    /* 工件：抓取点正下方 */
    var piece = new THREE.Mesh(roundedGeo(0.03, 0.03, 0.03, 0.004), M.piece);
    piece.position.set(PIECE_HOME.x, PIECE_HOME.y, PIECE_HOME.z);
    piece.castShadow = true;
    piece.receiveShadow = true;
    S.scene.add(piece);
    S.piece = piece;
    S.held = false;

    var pad = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.0015, 8, 48), M.accent);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(PIECE_HOME.x, 0.0016, PIECE_HOME.z);
    S.scene.add(pad);

    /* 放置位标记：pan −28° 时 TCP 落点 (221, −97) mm */
    var pad2Mat = new THREE.MeshStandardMaterial({
      color: 0xef9f3c, emissive: 0xef9f3c, emissiveIntensity: 0.5, roughness: 0.7
    });
    var pad2 = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.0012, 8, 48), pad2Mat);
    pad2.rotation.x = -Math.PI / 2;
    pad2.position.set(0.221, 0.0016, -0.097);
    S.scene.add(pad2);

    S.tmp = new THREE.Vector3();
    resizeCanvas();

    /* 官方 STL 数据体积大，按需加载；加载完再建机关 */
    loadParts(function (ok) {
      if (!ok) {
        log('err', '模型数据 parts.js 加载失败');
        showFallback('模型数据加载失败');
        return;
      }
      S.rig = buildRig();
      S.scene.add(S.rig.root);
      applyPose();
      updateTip();
      updateGrab();
      syncUI();
    });
  }

  function showFallback(msg) {
    var el = S.refs.fallback;
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    if (S.canvas) S.canvas.style.display = 'none';
  }

  function resizeCanvas() {
    if (!S.renderer || !S.stage) return;
    var w = S.stage.clientWidth, h = S.stage.clientHeight;
    if (!w || !h) return;
    var size = S.renderer.getSize(new THREE.Vector2());
    if (Math.round(size.x) === w && Math.round(size.y) === h) return;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
  }

  function applyPose() {
    if (!S.rig) return;
    spin(S.rig.pan, S.cur.pan);
    spin(S.rig.lift, S.cur.lift);
    spin(S.rig.elbow, S.cur.elbow);
    spin(S.rig.wrist, S.cur.wrist);
    spin(S.rig.roll, S.cur.roll);
    /* 动夹指绕竖直舵轴摆动；夹着工件时停在工件宽度处，不穿模 */
    var jaw = GRIP_CLOSED + (S.cur.grip / 100) * GRIP_SPAN;
    if (S.held && jaw < GRASP_DEG) jaw = GRASP_DEG;
    spin(S.rig.jaw, jaw);
  }

  /* 夹爪与工件的接触判定：闭合到位且 TCP 靠近工件 → 夹起；张开 → 落到台面 */
  function updateGrab() {
    if (!S.rig || !S.piece) return;
    S.rig.tip.updateWorldMatrix(true, false);
    S.tmp.setFromMatrixPosition(S.rig.tip.matrixWorld);

    if (!S.held) {
      /* 只在夹指收到工件宽度附近时判定，避免一进画面就吸住 */
      if (S.cur.grip < 50 || S.cur.grip > 78) return;
      var dx = S.tmp.x - S.piece.position.x;
      var dy = S.tmp.y - S.piece.position.y;
      var dz = S.tmp.z - S.piece.position.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 0.075) return;
      S.rig.roll.attach(S.piece);
      S.held = true;
      log('sys', '夹爪闭合 · 工件已夹持');
    } else if (S.cur.grip > 80) {
      S.scene.attach(S.piece);
      S.piece.position.y = PIECE_HOME.y;
      S.held = false;
      log('sys', '夹爪张开 · 工件落于工作台');
    }
  }

  function resetPiece() {
    if (!S.piece) return;
    if (S.held) {
      S.scene.attach(S.piece);
      S.held = false;
    }
    S.piece.position.set(PIECE_HOME.x, PIECE_HOME.y, PIECE_HOME.z);
    S.piece.rotation.set(0, 0, 0);
  }

  function updateTip() {
    if (!S.rig || !S.tmp || !S.refs.tipX) return;
    S.rig.tip.updateWorldMatrix(true, false);
    S.tmp.setFromMatrixPosition(S.rig.tip.matrixWorld);
    S.refs.tipX.textContent = Math.round(S.tmp.x * 1000);
    S.refs.tipY.textContent = Math.round(S.tmp.y * 1000);
    S.refs.tipZ.textContent = Math.round(S.tmp.z * 1000);
  }

  /* ---------- 渲染循环 ---------- */
  function frame(ts) {
    S.raf = requestAnimationFrame(frame);
    var dt = S.lastTs ? Math.min(0.06, (ts - S.lastTs) / 1000) : 0.016;
    S.lastTs = ts;

    if (S.rig && !S.estop) {
      var k = 1 - Math.exp(-dt * (4 + S.speed * 1.7));
      var moving = false;
      for (var i = 0; i < JOINTS.length; i++) {
        var key = JOINTS[i].key;
        var d = S.goal[key] - S.cur[key];
        if (Math.abs(d) < 0.04) {
          S.cur[key] = S.goal[key];
        } else {
          S.cur[key] += d * k;
          moving = true;
        }
      }
      if (moving || S.needPose) {
        applyPose();
        updateGrab();
        S.needPose = false;
      }
    }

    /* 窗口没有铺开（还在桌面上 / 已关闭）时不渲染，省 GPU */
    if (!S.stage || !S.stage.clientWidth) return;
    resizeCanvas();
    S.controls.update();
    S.renderer.render(S.scene, S.camera);

    if (ts - S.lastTip > 120) {
      S.lastTip = ts;
      updateTip();
    }
  }

  /* ---------- 关节行 ---------- */
  function buildJointRows() {
    var host = S.refs.joints;
    S.refs.inputs = {};
    S.refs.vals = {};

    JOINTS.forEach(function (j) {
      var row = document.createElement('div');
      row.className = 'arm101-joint';

      var head = document.createElement('div');
      head.className = 'arm101-jrow';
      head.innerHTML = '<span class="arm101-jid">ID ' + pad2(j.id) + '</span>' +
        '<span class="arm101-jname">' + j.label + '<em>' + j.en + '</em></span>' +
        '<b class="arm101-jval"><span></span><i>' + j.unit + '</i></b>';
      row.appendChild(head);

      var input = document.createElement('input');
      input.type = 'range';
      input.className = 'arm101-range';
      input.min = j.min;
      input.max = j.max;
      input.step = 1;
      input.value = HOME_POSE[j.key];
      input.setAttribute('aria-label', j.label);
      row.appendChild(input);

      host.appendChild(row);

      var val = head.querySelector('.arm101-jval span');
      val.textContent = HOME_POSE[j.key];
      S.refs.inputs[j.key] = input;
      S.refs.vals[j.key] = val;

      input.addEventListener('input', function () {
        if (!S.linked || S.estop) return;
        stopDemo(true);
        S.goal[j.key] = +input.value;
        val.textContent = +input.value;
      });

      input.addEventListener('change', function () {
        if (!S.linked || S.estop) return;
        sendJoint(j, +input.value);
      });
    });
  }

  function setPose(pose, send) {
    JOINTS.forEach(function (j) {
      S.goal[j.key] = pose[j.key];
      if (S.refs.inputs[j.key]) {
        S.refs.inputs[j.key].value = pose[j.key];
        S.refs.vals[j.key].textContent = pose[j.key];
      }
    });
    if (send) sendAll();
  }

  function sendJoint(j, value) {
    if (!S.linked || S.estop) return;
    var ticks = ticksFor(j, value);
    S.packets += 1;
    updatePackets();
    log('tx', 'ID ' + pad2(j.id) + ' ← ' + pad4(ticks) + ' · ' + value + j.unit + '   ' + frameWrite(j.id, ticks));
    var lat = 3.1 + Math.random() * 2.9;
    setTimeout(function () {
      if (S.linked && !S.estop) log('rx', 'ID ' + pad2(j.id) + ' ACK · ' + lat.toFixed(1) + ' ms');
    }, 70 + Math.random() * 70);
  }

  function sendAll() {
    if (!S.linked || S.estop) return;
    var list = syncList();
    S.packets += list.length;
    updatePackets();
    var lat = 3.4 + Math.random() * 2.6;
    log('tx', 'SYNC_WRITE 6 servos · ' + list.length * 3 + ' B   ' + frameSync(list));
    setTimeout(function () {
      if (S.linked && !S.estop) log('rx', 'SYNC ACK 6/6 · ' + lat.toFixed(1) + ' ms');
    }, 90 + Math.random() * 60);
  }

  function updatePackets() {
    if (S.refs.pkts) S.refs.pkts.textContent = S.packets;
  }

  /* ---------- 演示序列 ---------- */
  function toggleDemo() {
    if (S.demo) {
      stopDemo(true);
      return;
    }
    if (!S.linked || S.estop) return;
    resetPiece();
    S.demo = true;
    S.demoStep = 0;
    S.refs.demoBtn.textContent = '停止演示';
    log('sys', '演示序列开始 · ' + DEMO.length + ' 步');
    runDemo();
  }

  function demoDelay() {
    return 1250 + (10 - S.speed) * 90;
  }

  function runDemo() {
    if (!S.demo) return;
    if (S.demoStep >= DEMO.length) {
      S.demoTimer = setTimeout(function () {
        stopDemo(true);
        log('sys', '序列完成 · 六轴保持末位姿');
      }, 1400);
      return;
    }
    var step = DEMO[S.demoStep];
    setPose(step.pose);
    log('sys', 'DEMO ' + pad2(S.demoStep + 1) + '/' + pad2(DEMO.length) + ' · ' + step.label);
    sendAll();
    S.demoStep += 1;
    S.demoTimer = setTimeout(runDemo, demoDelay());
  }

  function stopDemo(logIt) {
    if (!S.demo) return;
    S.demo = false;
    clearTimeout(S.demoTimer);
    if (S.refs.demoBtn) S.refs.demoBtn.textContent = '演示序列';
    if (logIt) log('sys', '演示已停止 · 保持当前位姿');
  }

  /* ---------- 电源 / 急停 ---------- */
  function setLinked(on) {
    S.linked = on;
    if (!on) {
      stopDemo(false);
      S.estop = false;
      log('sys', 'SERIAL CLOSED · 舵机失能');
    } else {
      log('sys', 'SERIAL OPEN · /dev/ttyACM0 @ 1000000 8N1');
      log('sys', '舵机 6/6 应答 · 力矩 ON · 已载入中位 2048');
    }
    syncUI();
  }

  function toggleEstop() {
    if (!S.linked) return;
    S.estop = !S.estop;
    if (S.estop) {
      stopDemo(false);
      log('err', 'EMERGENCY STOP · 力矩 OFF · 目标位置冻结');
    } else {
      log('sys', 'TORQUE ON · 驱动器就绪 · 继续跟踪目标');
    }
    syncUI();
  }

  function syncUI() {
    var root = S.refs.root;
    root.dataset.link = S.linked ? 'on' : 'off';
    root.dataset.estop = S.estop ? '1' : '0';

    S.refs.conn.innerHTML = '<i></i><b>' + (S.linked ? '串口已连接 · 1 Mbps' : '串口未连接') + '</b>';
    S.refs.linkBtn.textContent = S.linked ? '断开串口' : '连接串口';
    S.refs.estopBtn.textContent = S.estop ? '解除急停' : '急停';
    S.refs.estopBanner.hidden = !S.estop;
    S.refs.demoBtn.textContent = S.demo ? '停止演示' : '演示序列';

    var lock = !S.linked || S.estop;
    JOINTS.forEach(function (j) {
      if (S.refs.inputs[j.key]) S.refs.inputs[j.key].disabled = lock;
    });
    S.refs.sendBtn.disabled = lock;
    S.refs.homeBtn.disabled = lock;
    S.refs.demoBtn.disabled = lock;
    S.refs.estopBtn.disabled = !S.linked;

    if (S.rig && S.rig.led) {
      var c = S.estop ? 0xff3b30 : S.linked ? 0x36e07f : 0xffa41f;
      S.rig.led.color.setHex(c);
      S.rig.led.emissive.setHex(c);
    }
  }

  function resetView() {
    if (!S.controls || !S.view0) return;
    S.camera.position.copy(S.view0.pos);
    S.controls.target.copy(S.view0.target);
    S.controls.update();
  }

  /* ---------- 挂载 ---------- */
  function mount(body, win) {
    S.body = body;
    S.win = win;

    if (body.dataset.ready === '1') {
      syncUI();
      return;
    }

    S.refs.root = body.querySelector('.arm101-root');
    S.refs.stage = body.querySelector('[data-stage]');
    S.refs.canvas = body.querySelector('[data-canvas]');
    S.refs.conn = body.querySelector('[data-conn]');
    S.refs.joints = body.querySelector('[data-joints]');
    S.refs.log = body.querySelector('[data-log]');
    S.refs.fallback = body.querySelector('[data-fallback]');
    S.refs.tipX = body.querySelector('[data-tip-x]');
    S.refs.tipY = body.querySelector('[data-tip-y]');
    S.refs.tipZ = body.querySelector('[data-tip-z]');
    S.refs.pkts = body.querySelector('[data-pkts]');
    S.refs.linkBtn = body.querySelector('[data-act="link"]');
    S.refs.sendBtn = body.querySelector('[data-act="send"]');
    S.refs.homeBtn = body.querySelector('[data-act="home"]');
    S.refs.demoBtn = body.querySelector('[data-act="demo"]');
    S.refs.estopBtn = body.querySelector('[data-act="estop"]');
    S.refs.estopBanner = body.querySelector('[data-estop]');
    S.refs.speed = body.querySelector('[data-speed]');
    S.refs.speedV = body.querySelector('[data-speed-v]');
    S.stage = S.refs.stage;
    S.canvas = S.refs.canvas;

    S.cur = {}; S.goal = {};
    JOINTS.forEach(function (j) {
      S.cur[j.key] = HOME_POSE[j.key];
      S.goal[j.key] = HOME_POSE[j.key];
    });

    buildJointRows();
    initScene();

    S.refs.linkBtn.addEventListener('click', function () { setLinked(!S.linked); });
    S.refs.estopBtn.addEventListener('click', toggleEstop);
    S.refs.sendBtn.addEventListener('click', sendAll);
    S.refs.demoBtn.addEventListener('click', toggleDemo);
    S.refs.homeBtn.addEventListener('click', function () {
      stopDemo(false);
      resetPiece();
      setPose(HOME_POSE);
      log('sys', 'HOME 位姿');
      sendAll();
    });
    S.refs.speed.addEventListener('input', function () {
      S.speed = +S.refs.speed.value;
      S.refs.speedV.textContent = S.speed;
    });
    body.querySelector('[data-act="view"]').addEventListener('click', resetView);

    body.dataset.ready = '1';
    syncUI();

    log('sys', 'SERIAL OPEN · /dev/ttyACM0 @ 1000000 8N1');
    log('sys', '舵机 6/6 应答 · 力矩 ON · 已载入中位 2048');
    log('sys', '数字孪生就绪 · 拖拽滑杆下发位置指令');

    if (!S.started) {
      S.started = true;
      S.raf = requestAnimationFrame(frame);
    }
  }

  registerApp({
    id: 'arm101',
    name: '101机械臂',
    title: '101 机械臂 · 控制台',
    sub: '六轴桌面臂 · 3D 孪生 · 总线信号仿真',
    order: 18,
    css: ['apps/arm101/app.css'],
    body: window.ARM101_BODY,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4.5 20.5h7"/><path d="M8 20.5v-2.6"/>' +
      '<circle cx="8.2" cy="16.2" r="1.7"/>' +
      '<path d="m9.6 15.1 3.9-4.6"/><circle cx="14.8" cy="9" r="1.7"/>' +
      '<path d="m16.1 7.9 2.4-1.9"/><path d="m18.1 6.4 2.2 2.1"/>' +
      '<path d="m18.7 6.6-1.2 2.8"/></svg>',
    mount: mount
  });
})();

/* ---- apps/browser/app.js ---- */
/* 浏览器 —— 在 App 窗口里直接打开网页。
 *
 * 两种容器，按运行环境自动选：
 *   · Electron（主进程开了 webviewTag）→ <webview>。它是独立的 guest 页面（等价于顶层导航），
 *     X-Frame-Options / CSP frame-ancestors 管不到它 —— Tripo 这类禁止内嵌的站只有走这条路才进得来。
 *   · 普通浏览器 / 探针 → <iframe>，只能显示允许内嵌的站。
 *
 * ⚠ iframe 读不到网页内容 —— 跨域之后连标题都拿不到。所以地址栏历史是本 App 自己记的
 *   URL 栈（不碰 iframe 的 history）。webview 能收到 did-navigate，页面内跳转时地址栏会跟着变。
 *
 * ⚠ 被站点拒绝内嵌时 iframe 里是一张空白错误页，父页面**收不到任何信号**（load 照样触发）。
 *   http(s)/app:// 父页面下这张空白页的 contentDocument 同源可访问且 body 空 —— 可据此明确提示。
 *   ⚠ 但 file:// 父页面的 origin 是 opaque，跨域 iframe 的 contentDocument 一律为 null
 *   （正常站也一样读不到），此时**无法分辨**「空白」与「正常」，只给条件式出口、绝不下断言。
 *
 * ⚠ Electron 的 <webview> **必须带一个初始 src**（about:blank）。没有 src 时它不创建 guest、
 *   也不派发 dom-ready，之后任何 loadURL 都会抛 "The WebView must be attached to the DOM and
 *   the dom-ready event emitted" —— 症状就是整块白屏，状态栏只留一闪而过的报错。
 *   2026-11-13 用真实 Electron guest 复现并确认；别把这行 src 删掉。
 */
(function () {
  'use strict';

  const HOME = '';
  const SEARCH = 'https://www.bing.com/search?q=';
  /* app: 必须认得 —— Electron 发行版的页面 origin 就是 app://openagi，
     本地页地址（apps/browser/demo.html）解析出来是 app:// 开头。漏了它，
     用户手输本地地址会被当成搜索词拼到必应去。 */
  const SCHEME = /^(https?|file|ftp|data|about|app):/i;
  const BLOCKED_SCHEME = /^(javascript|vbscript|blob):/i;

  const SVG = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const ICO = {
    back: SVG('<path d="M15 4.5 7.5 12 15 19.5"/>'),
    fwd: SVG('<path d="M9 4.5 16.5 12 9 19.5"/>'),
    reload: SVG('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5V9h-5.5"/>'),
    home: SVG('<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10.3V20h11v-9.7"/>'),
    ext: SVG('<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v6H4V6h6"/>'),
    lock: SVG('<rect x="5.5" y="10" width="13" height="9" rx="2"/><path d="M8.5 10V7.6a3.5 3.5 0 0 1 7 0V10"/>'),
    go: SVG('<path d="M5 12h12.5"/><path d="m13 7.5 4.5 4.5-4.5 4.5"/>'),
    globe: SVG('<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.5 2.4 3.9 5.4 3.9 8.6s-1.4 6.2-3.9 8.6c-2.5-2.4-3.9-5.4-3.9-8.6s1.4-6.2 3.9-8.6Z"/>')
  };

  function localUrl(rel){
    try { return new URL(rel, location.href).href; } catch (e) { return rel; }
  }

  /* 起始页导航：按用途分组。图标用单字/缩写瓷贴，颜色按站点气质取，
     不引外部 favicon —— 断网打开时不会出现一排破图。
     url 都是站点首页，直达功能页（如抠图）用对应的深链。 */
  const NAV = [
    {
      title: '3D 生成',
      hint: '文本 / 图片 → 模型',
      items: [
        { name: 'Tripo 国际版', mark: 'T', badge: '国际版', note: '文生 / 图生 3D', url: 'https://www.tripo3d.ai/', tint: '#e9f1ff', ink: '#2f6ad0' },
        { name: 'Meshy', mark: 'M', note: '建模 · 贴图 · 动画', url: 'https://www.meshy.ai/', tint: '#f0ecff', ink: '#6a4ed1' },
        { name: '混元 3D', mark: '混', badge: '腾讯', note: '混元 · 文生 3D', url: 'https://3d.hunyuan.tencent.com/', tint: '#e6f7f9', ink: '#0c7c93' },
        { name: 'Hyper3D Rodin', mark: 'R', note: '高质量 3D 生成', url: 'https://hyper3d.ai/', tint: '#fff0e8', ink: '#c0641f' },
        { name: 'Luma Genie', mark: 'L', note: '文生 3D 场景', url: 'https://lumalabs.ai/genie', tint: '#f2f4f7', ink: '#4a5568' },
        { name: 'CSM 3D', mark: 'C', note: '图生 3D 场景', url: 'https://3d.csm.ai/', tint: '#eaf7ef', ink: '#237a4c' }
      ]
    },
    {
      title: '图像处理',
      hint: '抠图 / 压缩 / 修复',
      items: [
        { name: '佐糖 AI 抠图', mark: '扣', badge: '推荐', note: '一键去背景', url: 'https://picwish.cn/remove-background', tint: '#e7f6ed', ink: '#1f7a4d' },
        { name: '佐糖工具箱', mark: '糖', note: '图片处理工具箱', url: 'https://picwish.cn/', tint: '#eaf7f3', ink: '#1c7a6b' },
        { name: 'remove.bg', mark: 'bg', note: '通用在线抠图', url: 'https://www.remove.bg/', tint: '#eef2f8', ink: '#3c5a8a' },
        { name: 'TinyPNG', mark: 'T', note: '在线图片压缩', url: 'https://tinypng.com/', tint: '#fff5e3', ink: '#a5761a' }
      ]
    },
    {
      title: '素材与设计',
      hint: '模型 / 材质 / 网页 3D',
      items: [
        { name: 'Sketchfab', mark: 'S', note: '3D 模型社区', url: 'https://sketchfab.com/', tint: '#e8f3ff', ink: '#2b6cb0' },
        { name: 'Poly Haven', mark: 'P', note: 'HDRI · 材质 · 模型', url: 'https://polyhaven.com/', tint: '#eaf7ef', ink: '#2f7d4f' },
        { name: 'Spline', mark: 'S', note: '网页 3D 设计', url: 'https://spline.design/', tint: '#fdeef4', ink: '#b03a6b' }
      ]
    },
    {
      title: '通用',
      hint: '搜索 / 文档 / 离线验证',
      items: [
        { name: '必应', mark: 'B', note: '网页搜索', url: 'https://www.bing.com/', tint: '#e9f2ff', ink: '#2563b8' },
        { name: '维基百科', mark: 'W', note: '中文百科', url: 'https://zh.wikipedia.org/', tint: '#f1f3f6', ink: '#4a5568' },
        { name: 'MDN', mark: 'M', note: 'Web 文档', url: 'https://developer.mozilla.org/zh-CN/', tint: '#edf1f5', ink: '#33475c' },
        { name: '本地示例页', mark: '本', badge: '离线', note: '验证内嵌是否正常', url: localUrl('apps/browser/demo.html'), tint: '#fdf6e6', ink: '#a5761a' }
      ]
    }
  ];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* 单实例状态：窗口节点在切回桌面时只是被藏起来，状态必须跟着它活着。
     再次 mount 只做同步，不重建 DOM —— 否则当前网页会被冲掉（README 的幂等约束）。 */
  let S = null;

  function looksLikeUrl(s){
    if (/^localhost(:\d+)?([/?#]|$)/i.test(s)) return true;
    if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#]|$)/.test(s)) return true;
    return /^[^\s/]+\.[^\s/]{2,}([/?#]|$)/.test(s);
  }

  /* 网址规整：能看出是地址就补 https://，否则当搜索词。
     返回 null 表示拒绝（javascript: 之类会让 iframe 在父页面上下文里执行）。 */
  function normalize(raw){
    const s = String(raw || '').trim();
    if (!s) return HOME;
    if (BLOCKED_SCHEME.test(s)) return null;
    if (SCHEME.test(s)) return s;
    if (looksLikeUrl(s)){
      /* 本机地址默认 http：https 在 localhost 上十有八九连不上 */
      if (/^(localhost|127\.|192\.168\.|10\.)/i.test(s)) return 'http://' + s;
      return 'https://' + s;
    }
    return SEARCH + encodeURIComponent(s);
  }

  function buildState(body){
    return {
      body: body,
      app: body.querySelector('.bw-app'),
      frame: null,          /* iframe 或 webview，mount 时按运行环境决定 */
      web: false,           /* true = Electron webview（不受 X-Frame-Options 限制） */
      frameReady: true,     /* webview 要等 dom-ready 才允许 loadURL */
      pending: null,
      start: body.querySelector('.bw-start'),
      addr: body.querySelector('.bw-input'),
      sec: body.querySelector('.bw-sec'),
      statusUrl: body.querySelector('.bw-status-url'),
      statusMsg: body.querySelector('.bw-status-msg'),
      back: body.querySelector('[data-act="back"]'),
      fwd: body.querySelector('[data-act="forward"]'),
      reloadBtn: body.querySelector('[data-act="reload"]'),
      externals: Array.prototype.slice.call(body.querySelectorAll('[data-act="external"]')),
      hist: [HOME],
      at: 0,
      url: HOME,
      loading: false,
      msgTimer: 0,
      pendingWatch: 0,     /* guest 迟迟不 dom-ready 时的诊断计时 */
      frameCheck: 0,       /* iframe 空白页判定计时 */
      zoom: 1,             /* webview 缩放系数，1 = 100% */
      zoomTouched: false,  /* 用户手动调过后不再自动适应 */
      fitTimer: 0,         /* did-stop-loading 后延迟测宽 */
      zoomVal: body.querySelector('.bw-zoom-val'),
      zoomFit: body.querySelector('.bw-zoom-fit')
    };
  }

  /* ms=0 表示常驻：XFO 白屏提示要一直挂着，一闪而过等于没提示 */
  function flash(st, text, ms){
    st.statusMsg.textContent = text;
    clearTimeout(st.msgTimer);
    if (ms === 0) return;
    st.msgTimer = setTimeout(() => { st.statusMsg.textContent = ''; }, ms || 2600);
  }
  function clearMsg(st){
    clearTimeout(st.msgTimer);
    st.statusMsg.textContent = '';
  }

  function sync(st){
    const home = st.url === HOME;
    st.back.disabled = st.at <= 0;
    st.fwd.disabled = st.at >= st.hist.length - 1;
    st.reloadBtn.disabled = home;
    st.app.classList.toggle('is-loading', !!st.loading && !home);
    st.statusUrl.textContent = home ? '起始页' : st.url;
    st.statusUrl.title = home ? '' : st.url;
    st.externals.forEach(b => { b.disabled = home; });
    const secure = /^https:/i.test(st.url);
    st.sec.classList.toggle('is-warn', !secure && !home);
    st.sec.title = home ? '地址' : (secure ? 'HTTPS 加密连接' : '非加密连接');
  }

  function setAddr(st, v){
    st.addr.value = v;
  }

  /* 刷新必须绕过「src 赋同值不重载」：先试 location.href（跨域允许写），
     不行再退回 about:blank → 原地址 的两拍。 */
  function loadFrame(st, url, reload){
    if (reload){
      try {
        st.frame.contentWindow.location.href = url;
        return;
      } catch (e) { /* 跨域读失败就退回下面的写法 */ }
      st.frame.src = 'about:blank';
      setTimeout(() => { if (st.url === url) st.frame.src = url; }, 0);
      return;
    }
    st.frame.src = url;
  }

  /* Electron 的 webview：它是独立 guest，X-Frame-Options 管不到它。
     loadURL 要等 dom-ready，没就绪的请求先排队（用户点得快时会发生）。 */
  function loadWebview(st, url, reload){
    if (!st.frameReady){
      st.pending = { url: url, reload: !!reload };
      /* 旧版在这里挂了一个「1600ms 后强行 loadURL」的兜底。那是错的：guest 没发过
         dom-ready 时 loadURL 必然抛错，结果就是白屏 + 一闪而过的一行报错。
         dom-ready 是唯一可信的放行信号；这里只做「迟迟没来」的诊断提示。 */
      clearTimeout(st.pendingWatch);
      st.pendingWatch = setTimeout(() => {
        if (st.pending) flash(st, '网页容器未就绪，可点「在系统浏览器打开」', 0);
      }, 2500);
      return;
    }
    try {
      if (reload) st.frame.reload();
      else st.frame.loadURL(url);
    } catch (e) {
      flash(st, '网页加载失败：' + ((e && e.message) || e));
    }
  }

  /* webview 不能用 display:none：guest 会被压成 0 尺寸，部分站点会直接白屏。
     所以两种容器的「收起」语义不同，统一收到这里。 */
  function showFrame(st, on){
    if (st.web) st.frame.classList.toggle('is-off', !on);
    else st.frame.classList.toggle('hidden', !on);
  }

  /* iframe 白屏判定：XFO 拒绝内嵌后是一张空白错误页。
     两档，别把「读不到」当成「空白」：
       ① contentDocument 可读且 body 空、无子节点 → 可确定，给明确诊断（XFO 白屏）；
       ② contentDocument 读不到（file:// 父页面下所有跨域站都如此）→ 无法分辨，
          只给「若空白 → 系统浏览器打开」的条件出口，绝不写「禁止被内嵌」。
     本地 file:// 页不参与判定（本地页不可能有 XFO，且它自身也读不到）。
     只给提示、不假装能修复；webview 有真实事件，不需要猜。 */
  function armFrameCheck(st){
    clearTimeout(st.frameCheck);
    if (st.web || st.url === HOME || /^file:/i.test(st.url)) return;
    st.frameCheck = setTimeout(() => {
      if (st.url === HOME) return;
      let doc = null;
      try { doc = st.frame.contentDocument; } catch (e) { doc = null; }
      if (!doc){
        flash(st, '若此页空白，点右下「在系统浏览器打开」', 0);
        return;
      }
      const b = doc.body;
      if (b && !String(b.innerText || '').trim() && b.children.length === 0){
        flash(st, '该站点禁止被内嵌，页面为空白 · 点右下「在系统浏览器打开」', 0);
      }
    }, 1800);
  }

  /* ---- 缩放 / 适应宽度 ----
     站点常带固定最小宽度（Tripo 工作台实测 1280px）。工作台窗口比它窄时右侧内容
     直接进不了可视区；App 页的窗口是铺满画布的，拉宽主窗口也未必够（实测画布上限 ~1200）。
     webview 的 setZoomFactor 等价于浏览器 Ctrl+-：缩小后 window.innerWidth 变大，
     页面按更多 CSS 像素重排，横向溢出随之消失。iframe 没有这个能力，控件对它隐藏。 */
  const ZOOM_MIN = 0.5, ZOOM_MAX = 1.6, ZOOM_STEP = 0.1;

  function setZoom(st, f){
    if (!st.web || !st.frame) return;
    f = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(f * 100) / 100));
    st.zoom = f;
    try { st.frame.setZoomFactor(f); }
    catch (e) { flash(st, '缩放失败：' + ((e && e.message) || e)); return; }
    if (st.zoomVal) st.zoomVal.textContent = Math.round(f * 100) + '%';
    if (st.zoomFit) st.zoomFit.classList.remove('is-on');
  }

  /* 读 guest 的「内容宽 / 视口宽」，算刚好塞得下的缩放系数。
     zoom 之后 innerWidth = 物理视口宽 / zoom，故 100% 视口宽 = innerWidth * 当前 zoom。 */
  function fitWidth(st, auto){
    if (!st.web || !st.frame || typeof st.frame.executeJavaScript !== 'function') return;
    let p;
    try {
      p = st.frame.executeJavaScript(
        '({iw:window.innerWidth,' +
        'sw:Math.max(document.documentElement.scrollWidth,' +
        '(document.body?document.body.scrollWidth:0))})'
      );
    } catch (e) { return; }
    Promise.resolve(p).then(m => {
      if (!m || !m.iw || !m.sw) return;
      const baseW = m.iw * st.zoom;
      const f = Math.min(1, baseW / m.sw);
      if (f >= 0.985){
        if (!auto) flash(st, '页面已完整显示，无需缩放');
        if (st.zoomFit) st.zoomFit.classList.add('is-on');
        return;
      }
      setZoom(st, Math.max(ZOOM_MIN, f));
      if (st.zoomFit) st.zoomFit.classList.add('is-on');
      if (!auto) flash(st, '已缩放至 ' + Math.round(st.zoom * 100) + '% 以适应窗口');
    }).catch(() => {});
  }

  /* 运行环境决定容器：
     · Electron（主进程开了 webviewTag）→ <webview>，能进禁止内嵌的站；
     · 普通浏览器 / 探针 → <iframe>，允许内嵌的站照常显示。 */
  function makeFrame(){
    try {
      const wv = document.createElement('webview');
      if (wv && typeof wv.loadURL === 'function'){
        wv.className = 'bw-frame bw-webview is-off';
        wv.setAttribute('title', '网页内容');
        wv.setAttribute('webpreferences', 'nodeIntegration=no, contextIsolation=yes');
        /* 没有 src 的 webview 不会创建 guest、也不会派发 dom-ready —— loadURL 必抛错、白屏。
           about:blank 让 guest 在 append 后立刻就绪，dom-ready 才会把 frameReady 解锁。 */
        wv.setAttribute('src', 'about:blank');
        return wv;
      }
    } catch (e) { /* 普通浏览器里没有 webview */ }
    const f = document.createElement('iframe');
    f.className = 'bw-frame hidden';
    f.setAttribute('title', '网页内容');
    f.setAttribute('referrerpolicy', 'no-referrer');
    return f;
  }

  function apply(st, url, reload){
    st.url = url;
    /* 每次导航都把上一次的提示 / 计时作废，否则「白屏提示」会挂到下一个正常页面上 */
    clearMsg(st);
    clearTimeout(st.frameCheck);
    clearTimeout(st.pendingWatch);
    clearTimeout(st.fitTimer);   /* 上一页的适应测量不能落到新页面上 */
    if (url === HOME){
      st.pending = null;
      st.loading = false;
      st.start.classList.remove('hidden');
      showFrame(st, false);
      if (st.web){
        try { st.frame.loadURL('about:blank'); } catch (e) { /* 还没 dom-ready，下次再清 */ }
      } else if (st.frame.getAttribute('src') !== 'about:blank'){
        st.frame.src = 'about:blank';
      }
      setAddr(st, '');
    } else {
      st.start.classList.add('hidden');
      showFrame(st, true);
      st.loading = true;
      setAddr(st, url);
      if (st.web) loadWebview(st, url, reload);
      else { loadFrame(st, url, reload); armFrameCheck(st); }
    }
    sync(st);
  }

  function navigate(st, url, opts){
    opts = opts || {};
    const cur = st.hist[st.at];
    const same = url === cur && url !== HOME;
    if (!opts.replace && url !== cur){
      st.hist = st.hist.slice(0, st.at + 1);
      st.hist.push(url);
      st.at = st.hist.length - 1;
    }
    apply(st, url, same || !!opts.reload);
  }

  function step(st, delta){
    const next = st.at + delta;
    if (next < 0 || next >= st.hist.length) return;
    st.at = next;
    apply(st, st.hist[next], false);
  }

  function fromInput(st){
    const url = normalize(st.addr.value);
    if (url === null){
      setAddr(st, st.url);
      flash(st, '已拦截不安全的地址');
      return;
    }
    if (url === st.url && url !== HOME) apply(st, url, true);
    else navigate(st, url);
  }

  function openExternal(st){
    if (!st.url) return;
    try {
      window.open(st.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      flash(st, '打开失败：' + ((e && e.message) || e));
    }
  }

  function doAct(st, act){
    if (act === 'back') step(st, -1);
    else if (act === 'forward') step(st, 1);
    else if (act === 'reload') { if (st.url !== HOME) apply(st, st.url, true); }
    else if (act === 'home') navigate(st, HOME);
    else if (act === 'external') openExternal(st);
    else if (act === 'zoom-out'){ st.zoomTouched = true; setZoom(st, st.zoom - ZOOM_STEP); }
    else if (act === 'zoom-in'){ st.zoomTouched = true; setZoom(st, st.zoom + ZOOM_STEP); }
    else if (act === 'zoom-reset'){ st.zoomTouched = true; setZoom(st, 1); }
    else if (act === 'zoom-fit'){ st.zoomTouched = true; fitWidth(st, false); }
  }

  /* load 事件在「被 X-Frame-Options 拦掉」时也会触发，所以它只能当「加载结束」用，
     不能当「加载成功」用。跨域时 location 读不到 → 地址栏保持最后一次明确导航的 URL。 */
  function onFrameLoad(st){
    let href = '';
    let cross = false;
    try { href = st.frame.contentWindow.location.href; }
    catch (e) { cross = true; }
    if (!cross && (!href || href === 'about:blank')) return;   // 初始空文档，忽略
    st.loading = false;
    if (href && href !== st.url){
      st.url = href;
      st.hist[st.at] = href;     // 页面内部跳转 / 重定向：只更新当前条目
      setAddr(st, href);
    }
    sync(st);
  }

  /* webview 版：did-navigate / did-navigate-in-page 会带上真实地址，
     连 SPA 路由变化都能同步到地址栏（iframe 做不到这件事）。 */
  function syncFromGuest(st, url){
    if (!url || url === 'about:blank') return;
    st.url = url;
    st.hist[st.at] = url;
    setAddr(st, url);
    sync(st);
  }

  function wireFrame(st){
    if (st.web){
      st.frame.addEventListener('dom-ready', () => {
        st.frameReady = true;
        clearTimeout(st.pendingWatch);
        if (st.pending){
          const p = st.pending;
          st.pending = null;
          loadWebview(st, p.url, p.reload);
        }
      });
      st.frame.addEventListener('did-start-loading', () => { st.loading = true; sync(st); });
      st.frame.addEventListener('did-stop-loading', () => {
        st.loading = false;
        sync(st);
        /* 页面内容常是异步渲染的，停载后稍等再量宽；用户手动调过缩放就不再自动改。 */
        clearTimeout(st.fitTimer);
        if (!st.zoomTouched && st.url !== HOME){
          st.fitTimer = setTimeout(() => fitWidth(st, true), 650);
        }
      });
      st.frame.addEventListener('did-navigate', (e) => syncFromGuest(st, e.url));
      st.frame.addEventListener('did-navigate-in-page', (e) => syncFromGuest(st, e.url));
      st.frame.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3) return;   // -3 = 用户主动中止 / 切换地址
        st.loading = false;
        flash(st, '加载失败：' + (e.errorDescription || e.errorCode));
        sync(st);
      });
      /* 不设「到点强行 loadURL」的兜底：src=about:blank 保证 dom-ready 会来；
         万一没来，loadWebview 里那条 pendingWatch 会给出诊断提示，而不是制造白屏。 */
      return;
    }
    st.frame.addEventListener('load', () => onFrameLoad(st));
  }

  function drawNav(st){
    const wrap = st.body.querySelector('#bwQuick');
    wrap.innerHTML = NAV.map(g =>
      '<section class="bw-group">' +
        '<div class="bw-group-head">' +
          '<h2 class="bw-group-title">' + esc(g.title) + '</h2>' +
          (g.hint ? '<span class="bw-group-hint">' + esc(g.hint) + '</span>' : '') +
        '</div>' +
        '<div class="bw-quick">' +
          g.items.map(it =>
            '<button type="button" class="bw-link" data-url="' + esc(it.url) + '" title="' + esc(it.url) + '">' +
              '<span class="bw-link-ico" style="--tint:' + esc(it.tint) + ';--ink:' + esc(it.ink) + '">' + esc(it.mark) + '</span>' +
              '<span class="bw-link-main">' +
                '<span class="bw-link-top">' +
                  '<span class="bw-link-name">' + esc(it.name) + '</span>' +
                  (it.badge ? '<span class="bw-link-badge">' + esc(it.badge) + '</span>' : '') +
                '</span>' +
                '<span class="bw-link-note">' + esc(it.note) + '</span>' +
              '</span>' +
              '<span class="bw-link-go" aria-hidden="true">↗</span>' +
            '</button>').join('') +
        '</div>' +
      '</section>').join('');
  }

  function wire(st){
    st.addr.form.addEventListener('submit', (e) => {
      e.preventDefault();
      fromInput(st);
    });

    /* 一个委托监听同时管按钮和起始页的常用入口，省掉逐个绑定 */
    st.app.addEventListener('click', (e) => {
      const link = e.target.closest('[data-url]');
      if (link){
        const url = link.getAttribute('data-url');
        setAddr(st, url);
        navigate(st, url);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) doAct(st, act.getAttribute('data-act'));
    });

    st.app.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'l'){
        e.preventDefault();
        st.addr.focus();
        st.addr.select();
      } else if (e.key === 'Escape' && document.activeElement === st.addr){
        setAddr(st, st.url);
        st.addr.blur();
      }
    });
  }

  const HTML = `
    <div class="bw-app">
      <div class="bw-bar">
        <button type="button" class="bw-btn" data-act="back" title="后退" aria-label="后退">${ICO.back}</button>
        <button type="button" class="bw-btn" data-act="forward" title="前进" aria-label="前进">${ICO.fwd}</button>
        <button type="button" class="bw-btn" data-act="reload" title="刷新" aria-label="刷新">${ICO.reload}</button>
        <button type="button" class="bw-btn" data-act="home" title="起始页" aria-label="起始页">${ICO.home}</button>
        <form class="bw-addr" autocomplete="off">
          <span class="bw-sec" aria-hidden="true">${ICO.lock}</span>
          <input class="bw-input" type="text" spellcheck="false" placeholder="输入网址或搜索词，回车前往" aria-label="地址栏">
          <button class="bw-go" type="submit" title="前往" aria-label="前往">${ICO.go}</button>
        </form>
        <button type="button" class="bw-btn bw-btn-ext" data-act="external" title="在系统浏览器打开" aria-label="在系统浏览器打开">${ICO.ext}</button>
      </div>

      <div class="bw-view">
        <div class="bw-start">
          <div class="bw-start-in">
            <div class="bw-hero">
              <span class="bw-hero-ico">${ICO.globe}</span>
              <div>
                <h1>AI 创作导航</h1>
                <p>3D 生成、AI 抠图与常用站点，点一下直达。</p>
              </div>
            </div>
            <div class="bw-hero-tip">地址栏也可以直接输入网址或搜索词</div>
            <div class="bw-nav" id="bwQuick"></div>
            <div class="bw-note">
              <b>部分站点会显示空白。</b>Tripo、Meshy 等用 X-Frame-Options / CSP 禁止被别的页面内嵌。
              桌面版走的是 webview，不受这条限制；在普通浏览器里打开时如果空白，
              点状态栏右下的「在系统浏览器打开」。
            </div>
          </div>
        </div>
      </div>

      <div class="bw-status">
        <span class="bw-status-url">起始页</span>
        <span class="bw-status-msg" aria-live="polite"></span>
        <span class="bw-guard" title="已拦截广告与追踪、弹窗、下载与权限申请">防护中</span>
        <span class="bw-zoom" aria-label="网页缩放">
          <button type="button" class="bw-zoom-btn" data-act="zoom-out" title="缩小">−</button>
          <button type="button" class="bw-zoom-val" data-act="zoom-reset" title="恢复 100%">100%</button>
          <button type="button" class="bw-zoom-btn" data-act="zoom-in" title="放大">+</button>
          <button type="button" class="bw-zoom-fit" data-act="zoom-fit" title="缩放以适应窗口宽度">适应</button>
        </span>
        <button type="button" class="bw-status-ext" data-act="external">在系统浏览器打开 ↗</button>
      </div>
    </div>`;

  registerApp({
    id: 'browser',
    name: '浏览器',
    title: '浏览器',
    sub: '内嵌网页 · 地址栏与前进后退',
    icon: deskSvg('globe'),
    order: 14,
    cls: 'browser',
    win: 'browserWin',
    css: ['apps/browser/app.css'],
    mount: function (body){
      /* 其他 App 可以先把地址放进 __bwPendingUrl，再 openDeskApp('browser')：
         这里在挂载/复用后统一导航，避免外部直接摸 webview 的内部状态。 */
      const pending = window.__bwPendingUrl;
      window.__bwPendingUrl = '';
      if (body.dataset.ready === '1' && S && S.body === body){
        sync(S);          // 已经画过：只同步按钮状态，不重建（否则当前网页被冲掉）
        if (pending) navigate(S, pending);
        return;
      }
      body.innerHTML = HTML;
      S = buildState(body);
      S.frame = makeFrame();
      S.web = S.frame.tagName.toLowerCase() === 'webview';
      S.app.classList.toggle('is-web', S.web);   /* iframe 模式隐藏缩放控件 */
      S.frameReady = !S.web;
      body.querySelector('.bw-view').appendChild(S.frame);
      drawNav(S);
      wireFrame(S);
      wire(S);
      body.dataset.ready = '1';
      sync(S);
      if (pending) navigate(S, pending);
      else setTimeout(() => S.addr.focus(), 80);
    }
  });
})();

/* ---- apps/card/app.js ---- */
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
              <h2 class="cd-h2">关于我<span class="cd-h2-en">Profile</span></h2>
              <div class="cd-about" id="cdAbout"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">在做的四条线<span class="cd-h2-en">Tracks</span></h2>
              <div class="cd-tracks" id="cdTracks"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">合集与代表作<span class="cd-h2-en">Selected Works</span><span class="cd-h2-note">右侧为该集播放量</span></h2>
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

/* ---- apps/chara/app.js ---- */
/* 角色工坊 —— 插画 → 部位图 → 三视图 → Tripo 3D 候选 → 导出。
 *
 * 工作流设计借鉴开源套件 Charakuru（nanocle/Charakuru，source-available）的
 * 「分阶段 + 确认点」理念：每个阶段产出可检查的中间物，用户点了「确认并继续」
 * 才放行下一阶段；本实现全部用本项目已有的能力（云生图 / Tripo API / Model3D），
 * 未搬运其任何代码或素材。VRM 的骨骼与权重需要 Blender，本项目导出 GLB 与制作包。
 *
 * 状态存 localStorage（hf_charaProj），大图走 blob-store 外置（blobPack 存根）。
 */
(function () {
  'use strict';

  var STORE_KEY = 'hf_charaProj';
  var byId = function (id) { return document.getElementById(id); };

  /* ---------- 阶段定义 ---------- */
  var STAGES = [
    { id: 'src',    name: '原画',    desc: '导入一张有权使用的全身角色插画' },
    { id: 'parts',  name: '部位图',  desc: '头部 / 身体各四视图，共 8 张' },
    { id: 'views',  name: '三视图',  desc: '全身 正 / 侧 / 背，建模参考' },
    { id: 'model',  name: '3D 候选', desc: 'Tripo 生成模型，你来挑' },
    { id: 'export', name: '预览导出', desc: '3D 预览 · 四视图 · 导出' }
  ];

  /* 部位图 8 张的提示词模板（英文直出，不再走翻译链）。
   * 部位图的目标是「喂给 Tripo 的干净参考」，不是插画再创作。 */
  var PARTS = [
    { key: 'head.front',  label: '头 · 正面',  prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), front view, centered on plain light gray background, keep the exact hairstyle, face and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.threeq', label: '头 · 四分之三', prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), three-quarter view, centered on plain light gray background, keep the exact hairstyle, face and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.side',   label: '头 · 侧面',  prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), side profile view, centered on plain light gray background, keep the exact hairstyle and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.back',   label: '头 · 背面',  prompt: 'character design reference sheet: the back of the character\'s HEAD ONLY (hair only, no face, no body), back view, centered on plain light gray background, keep the exact hairstyle and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.front',  label: '身 · 正面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), front view, A-pose with arms slightly away, plain light gray background, keep the exact outfit, colors and proportions of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.threeq', label: '身 · 四分之三', prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), three-quarter view, A-pose, plain light gray background, keep the exact outfit, colors and proportions of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.side',   label: '身 · 侧面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), side profile view, A-pose, plain light gray background, keep the exact outfit and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.back',   label: '身 · 背面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), back view, A-pose, plain light gray background, keep the exact outfit and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' }
  ];

  var VIEWS = [
    { key: 'front', label: '全身 · 正面', prompt: 'character turnaround reference sheet: FULL BODY front view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'side',  label: '全身 · 侧面', prompt: 'character turnaround reference sheet: FULL BODY side profile view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'back',  label: '全身 · 背面', prompt: 'character turnaround reference sheet: FULL BODY back view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' }
  ];

  /* ---------- 状态 ---------- */
  function blankPart() { return { img: '', status: '' }; }

  var state = {
    stage: 0,
    src: '', srcName: '', srcInfo: '',
    parts: {},                    // key → {img:stub|dataURL, status}
    views: {},                    // key → {img, status}
    mode: 'full',                 // full=整体 | split=头身分离
    modelSrc: 'views.front',      // 整体建模的输入图
    candN: 2,
    cands: { full: [], head: [], body: [] },   // [{model,preview,credits,version,src}]
    pick: { full: -1, head: -1, body: -1 }
  };
  PARTS.forEach(function (p) { state.parts[p.key] = blankPart(); });
  VIEWS.forEach(function (v) { state.views[v.key] = blankPart(); });

  var busy = {};                // key → true（生成中的格子）
  var candBusy = [];            // 'full' | 'head' | 'body'
  var footMsg = '';

  /* ---------- 存取 ---------- */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, stage: state.stage, mode: state.mode, modelSrc: state.modelSrc,
        candN: state.candN, pick: state.pick,
        src: blobPack(state.src), srcName: state.srcName, srcInfo: state.srcInfo,
        parts: state.parts, views: state.views,
        cands: state.cands
      }));
    } catch (e) { /* 配额满时宁可丢草稿也不打断流程 */ }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || d.v !== 1) return;
    state.stage = Math.min(Math.max(d.stage | 0, 0), STAGES.length - 1);
    state.mode = d.mode === 'split' ? 'split' : 'full';
    state.modelSrc = typeof d.modelSrc === 'string' ? d.modelSrc : 'views.front';
    state.candN = Math.min(Math.max(d.candN | 0, 1), 3);
    state.pick = d.pick && typeof d.pick === 'object' ? d.pick : state.pick;
    state.srcName = d.srcName || '';
    state.srcInfo = d.srcInfo || '';
    state.src = typeof d.src === 'string' ? d.src : '';
    if (d.parts && typeof d.parts === 'object') {
      Object.keys(state.parts).forEach(function (k) {
        if (d.parts[k]) state.parts[k] = { img: d.parts[k].img || '', status: d.parts[k].status || '' };
      });
    }
    if (d.views && typeof d.views === 'object') {
      Object.keys(state.views).forEach(function (k) {
        if (d.views[k]) state.views[k] = { img: d.views[k].img || '', status: d.views[k].status || '' };
      });
    }
    if (d.cands && typeof d.cands === 'object') state.cands = d.cands;
  }

  /* 存根 → 可显示的 dataURL / URL */
  function resolveImg(s) {
    if (!s) return '';
    if (typeof blobResolve === 'function') {
      try { return blobResolve(s, new WeakSet()); } catch (e) {}
    }
    return s;
  }

  /* ---------- 图片工具 ---------- */
  function shrink(dataURL, maxSide) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, (maxSide || 1600) / Math.max(w, h));
        if (scale >= 1) { res(dataURL); return; }
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { res(c.toDataURL('image/webp', 0.85)); } catch (e) { res(dataURL); }
      };
      img.onerror = function () { res(dataURL); };
      img.src = dataURL;
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  /* 远程图尽量转 dataURL（持久化更稳）；跨域拿不到就原样保留 URL */
  function toDataURL(url) {
    if (!url || url.indexOf('data:') === 0) return Promise.resolve(url);
    return apiFetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (b) {
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = function () { res(url); };
        fr.readAsDataURL(b);
      });
    }).catch(function () { return url; });
  }

  /* ---------- 生图（云 API / Tripo 重绘） ---------- */
  function genImage(prompt, srcImg, onProgress) {
    if (confGet('genEngine') === 'tripo') {
      var src0 = resolveImg(srcImg);
      if (!src0) throw new Error('Tripo 重绘必须有输入图');
      var tModel = confGet('imgModel') || 'seedream_v5';
      return tripoUpload(src0).then(function (token) {
        if (onProgress) onProgress('上传完成，提交任务…');
        return tripoCall('/generation/image-to-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: tModel, input: token, prompt: prompt, size: '2K', output_format: 'png' })
        });
      }).then(function (task) {
        return tripoPoll(task.task_id, function (p) { if (onProgress) onProgress(p + '%'); });
      }).then(function (done) {
        var url = done.output && done.output.generated_image_url;
        if (!url) throw new Error('Tripo 任务完成但未返回图片');
        return toDataURL(url);
      });
    }
    if (typeof imgMode === 'function' && imgMode() === 'local') {
      return Promise.reject(new Error('角色工坊需要云生图或 Tripo（设置 → 生图引擎）；本地 ComfyUI 无图生图编辑链路'));
    }
    var base = (confGet('imgBaseUrl') || confGet('llmBaseUrl') || '').replace(/\/$/, '');
    var model = confGet('imgModel') || confGet('llmModel');
    var key = confGet('imgKey') || confGet('llmKey');
    var endpoint = confGet('imgEndpoint');
    var size = confGet('imgSize') || '1024x1024';
    if (!base || !model || !key) {
      return Promise.reject(new Error('请先在设置里填写生图 Base URL / Model / API Key'));
    }
    var src = resolveImg(srcImg);
    var useImage = !!src && state.refSource !== false;
    var p;
    if (useImage && /edit/i.test(endpoint || '')) {
      /* OpenAI 兼容 /images/edits：必须 multipart/form-data（与工作台 generate() 同款） */
      p = fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: (function () {
          var fd = new FormData();
          fd.append('model', model); fd.append('prompt', prompt); fd.append('size', size);
          var bin = atob(src.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          fd.append('image', new Blob([arr], { type: 'image/png' }), 'source.png');
          return fd;
        })()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ': 生成请求失败');
        return r.json();
      });
    } else {
      var body = { model: model, prompt: prompt, size: size };
      if (useImage) body.image = src.split(',')[1];
      p = post(base, key, endpoint, body);
    }
    return p.then(function (data) {
      var url = lookupPath(data, confGet('respPath') || 'data[0].url');
      if (!url) {
        var b64 = lookupPath(data, 'data[0].b64_json');
        if (b64) url = 'data:image/png;base64,' + b64;
      }
      if (!url) throw new Error('未找到图片地址（可在设置 → 高级里调整响应路径）');
      return toDataURL(url);
    });
  }

  /* ---------- Tripo 建模候选 ---------- */
  function genCandidate(srcImg, onProgress) {
    var src = resolveImg(srcImg);
    if (!src) return Promise.reject(new Error('缺少建模输入图'));
    var version = confGet('tripoVersion');
    if (!confGet('tripoKey')) return Promise.reject(new Error('请先在设置里填写 Tripo API Key'));
    return tripoUpload(src).then(function (token) {
      if (onProgress) onProgress('上传完成，提交建模任务…');
      return tripoCall('/generation/image-to-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: version, input: token, texture: true, pbr: true })
      });
    }).then(function (task) {
      return tripoPoll(task.task_id, function (p) { if (onProgress) onProgress(p + '%'); });
    }).then(function (done) {
      var out = done.output || {};
      return {
        model: out.model_url || out.pbr_model || '',
        preview: out.rendered_image_url || '',
        credits: done.credits_consumed,
        version: version
      };
    });
  }

  /* ---------- 渲染 ---------- */
  var host = null, stageEl = null, railEl = null, footEl = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    if (!host) return;
    renderRail();
    renderStage();
    renderFoot();
  }

  function stageDone(i) {
    if (i === 0) return !!state.src;
    if (i === 1) return !!(state.parts['head.front'] && state.parts['head.front'].img &&
                            state.parts['body.front'] && state.parts['body.front'].img);
    if (i === 2) return !!(state.views.front && state.views.front.img);
    if (i === 3) return (state.mode === 'full' ? state.pick.full >= 0 : state.pick.head >= 0 && state.pick.body >= 0);
    return true;
  }

  function renderRail() {
    var html = STAGES.map(function (s, i) {
      var cls = 'chara-step' + (i === state.stage ? ' cur' : '') + (stageDone(i) ? ' done' : '');
      return '<button type="button" class="' + cls + '" data-act="goto" data-i="' + i + '">' +
        '<span class="chara-step-dot"></span>' +
        '<span class="chara-step-txt"><b>' + (i + 1) + '. ' + esc(s.name) + '</b><i>' + esc(s.desc) + '</i></span>' +
        '</button>';
    }).join('');
    railEl.innerHTML = '<div class="chara-rail-t">制作流程</div>' + html +
      '<div class="chara-rail-foot">' +
      '<button type="button" class="btn sm ghost" data-act="reset">新建项目</button>' +
      (state.srcInfo ? '<div class="chara-projinfo">' + esc(state.srcInfo) + '</div>' : '') +
      '</div>';
  }

  function cellHTML(key, item, label, actKind) {
    var busyKey = actKind + ':' + key;
    var img = resolveImg(item.img);
    var isBusy = !!busy[busyKey];
    var body;
    if (isBusy) {
      body = '<div class="chara-cell-busy"><span class="chara-spin"></span><i>' + esc(item.status || '生成中…') + '</i></div>';
    } else if (img) {
      body = '<img src="' + esc(img) + '" alt="' + esc(label) + '" draggable="false">';
    } else {
      body = '<div class="chara-cell-empty">' + esc(item.status || '未生成') + '</div>';
    }
    return '<div class="chara-cell">' +
      '<div class="chara-cell-img">' + body + '</div>' +
      '<div class="chara-cell-bar"><span>' + esc(label) + '</span>' +
      '<button type="button" class="btn sm' + (img ? ' ghost' : '') + '" data-act="' + actKind + '" data-key="' + key + '"' +
      (isBusy ? ' disabled' : '') + '>' + (img ? '重生成' : '生成') + '</button></div>' +
      '</div>';
  }

  function renderStageSrc() {
    var img = resolveImg(state.src);
    return '<div class="chara-grid-2">' +
      '<div class="chara-drop' + (img ? ' has' : '') + '" data-act="dropzone">' +
      (img
        ? '<img src="' + esc(img) + '" alt="原画" draggable="false">'
        : '<div class="chara-drop-hint"><b>点击选择或拖入图片</b><i>PNG / JPEG / WebP，建议全身角色图</i></div>') +
      '</div>' +
      '<div class="chara-src-side">' +
      '<div class="chara-note"><b>开工前</b>' +
      '<ul><li>使用你有权使用的插画；输出模型的使用范围跟随原画授权。</li>' +
      '<li>全身、站姿、道具少，Tripo 的成功率最高。</li>' +
      '<li>图片会压缩到长边 1600 再使用，原图不会上传到任何服务。</li></ul></div>' +
      '<div class="chara-row">' +
      '<button type="button" class="btn sm" data-act="pick-src">选择图片</button>' +
      (img ? '<button type="button" class="btn sm ghost" data-act="clear-src">移除</button>' : '') +
      '</div>' +
      '<div class="chara-hint">生图走「设置 → 生图引擎」里的云 API；重绘也可以选 Tripo。</div>' +
      '</div>' +
      '</div>' +
      '<input type="file" id="charaSrcFile" accept="image/*" hidden>';
  }

  function renderStageParts() {
    var head = PARTS.filter(function (p) { return p.key.indexOf('head.') === 0; })
      .map(function (p) { return cellHTML(p.key, state.parts[p.key], p.label, 'gen-part'); }).join('');
    var body = PARTS.filter(function (p) { return p.key.indexOf('body.') === 0; })
      .map(function (p) { return cellHTML(p.key, state.parts[p.key], p.label, 'gen-part'); }).join('');
    return '<div class="chara-sec"><div class="chara-sec-t">头部（含发型）<span>喂给建模的头件参考</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="head">生成整排</button></div>' +
      '<div class="chara-grid-4">' + head + '</div></div>' +
      '<div class="chara-sec"><div class="chara-sec-t">身体（颈部以下）<span>喂给建模的身件参考</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="body">生成整排</button></div>' +
      '<div class="chara-grid-4">' + body + '</div></div>' +
      '<div class="chara-hint">提示词已按「参考图同款设计 + 纯色底 + 单部件」写死；建模最低要求头·正面与身·正面两张，其余可后补。</div>';
  }

  function renderStageViews() {
    var cells = VIEWS.map(function (v) { return cellHTML(v.key, state.views[v.key], v.label, 'gen-view'); }).join('');
    return '<div class="chara-sec"><div class="chara-sec-t">全身三视图<span>整体建模的主输入</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="views">生成整排</button></div>' +
      '<div class="chara-grid-3">' + cells + '</div></div>' +
      '<div class="chara-hint">三视图用于「整体建模」路线；走「头身分离」时只用部位图。</div>';
  }

  function srcPickList() {
    var opts = [];
    VIEWS.forEach(function (v) {
      if (state.views[v.key] && state.views[v.key].img) opts.push({ k: 'views.' + v.key, n: v.label });
    });
    PARTS.forEach(function (p) {
      if (state.parts[p.key] && state.parts[p.key].img) opts.push({ k: 'parts.' + p.key, n: p.label });
    });
    if (state.src) opts.push({ k: 'src', n: '原画' });
    return opts;
  }

  function candListHTML(kind) {
    var list = state.cands[kind] || [];
    if (!list.length) return '<div class="chara-cell-empty chara-cand-empty">还没有候选</div>';
    return '<div class="chara-cands">' + list.map(function (c, i) {
      var on = state.pick[kind] === i;
      return '<button type="button" class="chara-cand' + (on ? ' on' : '') + '" data-act="pick-cand" data-kind="' + kind + '" data-i="' + i + '">' +
        (c.preview ? '<img src="' + esc(c.preview) + '" alt="候选 ' + (i + 1) + '" draggable="false">' : '<div class="chara-cell-empty">无预览图</div>') +
        '<span class="chara-cand-tag">候选 ' + (i + 1) + (c.credits != null ? ' · ' + c.credits + ' 积分' : '') + '</span>' +
        '<span class="chara-cand-ver">' + esc(c.version || '') + '</span>' +
        (on ? '<b class="chara-cand-ok">已选</b>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  function renderStageModel() {
    var opts = srcPickList();
    var splitReady = !!(state.parts['head.front'] && state.parts['head.front'].img &&
                          state.parts['body.front'] && state.parts['body.front'].img);
    var modeFull = state.mode === 'full';
    var inputHtml;
    if (modeFull) {
      inputHtml = opts.length
        ? '<div class="chara-inputs">' + opts.map(function (o) {
            return '<label class="chara-radio"><input type="radio" name="chara-msrc" value="' + o.k + '"' +
              (state.modelSrc === o.k ? ' checked' : '') + '> ' + esc(o.n) + '</label>';
          }).join('') + '</div>'
        : '<div class="chara-cell-empty">前几阶段还没有图：先生成三视图或部位图</div>';
    } else {
      inputHtml = splitReady
        ? '<div class="chara-inputs"><label class="chara-radio"><input type="radio" checked disabled> 头·正面 + 身·正面（分别建模，后期拼装）</label></div>'
        : '<div class="chara-cell-empty">头身分离需要部位图的「头·正面」和「身·正面」</div>';
    }
    return '<div class="chara-sec"><div class="chara-sec-t">建模路线<span>整体 = 一个模型直接出；分离 = 头 / 身各建再拼</span></div>' +
      '<div class="chara-modes">' +
      '<button type="button" class="chara-mode' + (modeFull ? ' on' : '') + '" data-act="mode" data-v="full"><b>整体建模</b><i>用一张全身图，简单直接</i></button>' +
      '<button type="button" class="chara-mode' + (!modeFull ? ' on' : '') + '" data-act="mode" data-v="split"><b>头身分离</b><i>Tripo 对单部件效果更好，需要后期拼装</i></button>' +
      '</div></div>' +
      '<div class="chara-sec"><div class="chara-sec-t">输入图<span>' + (modeFull ? '选一张作为建模输入' : '固定使用两张部位正面图') + '</span></div>' +
      inputHtml + '</div>' +
      '<div class="chara-sec"><div class="chara-sec-t">候选' +
      '<label class="chara-candn">数量 <select id="charaCandN">' +
      [1, 2, 3].map(function (n) { return '<option value="' + n + '"' + (state.candN === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
      '</select></label>' +
      '<button type="button" class="btn sm" data-act="gen-cand"' + (candBusy.indexOf(state.mode) >= 0 ? ' disabled' : '') + '>' +
      (candBusy.indexOf(state.mode) >= 0 ? '生成中…' : '生成候选') + '</button></div>' +
      candListHTML(modeFull ? 'full' : 'head') +
      (!modeFull ? '<div class="chara-subt">身体候选</div>' + candListHTML('body') : '') +
      '<div class="chara-hint">候选由你挑选，软件不会替你做视觉判断；每次生成消耗 Tripo 积分。</div>';
  }

  function renderStageExport() {
    var modeFull = state.mode === 'full';
    var picked = [];
    if (modeFull && state.pick.full >= 0 && state.cands.full[state.pick.full]) {
      picked.push({ kind: '整体模型', c: state.cands.full[state.pick.full] });
    }
    if (!modeFull) {
      if (state.pick.head >= 0 && state.cands.head[state.pick.head]) picked.push({ kind: '头部', c: state.cands.head[state.pick.head] });
      if (state.pick.body >= 0 && state.cands.body[state.pick.body]) picked.push({ kind: '身体', c: state.cands.body[state.pick.body] });
    }
    var pickedHtml = picked.length
      ? picked.map(function (p) {
          return '<div class="chara-out-row"><b>' + esc(p.kind) + '</b>' +
            (p.c.model ? '<a class="btn sm" href="' + esc(p.c.model) + '" download="chara_model.glb">下载 GLB</a>' +
              '<button type="button" class="btn sm ghost" data-act="preview3d" data-url="' + esc(p.c.model) + '">3D 预览</button>' +
              '<button type="button" class="btn sm ghost" data-act="quad" data-url="' + esc(p.c.model) + '">导出四视图</button>'
              : '<span class="chara-hint">该候选缺少模型文件</span>') +
            '</div>';
        }).join('')
      : '<div class="chara-cell-empty">上一阶段还没挑选候选</div>';
    return '<div class="chara-sec"><div class="chara-sec-t">模型产物</div>' + pickedHtml + '</div>' +
      '<div class="chara-sec"><div class="chara-sec-t">制作包<span>所有中间图 + 选择记录，一键带走</span></div>' +
      '<div class="chara-row"><button type="button" class="btn sm" data-act="export-json">导出项目 JSON</button>' +
      '<button type="button" class="btn sm ghost" data-act="export-parts">打包部位图</button></div></div>' +
      '<div class="chara-note"><b>关于 VRM</b>' +
      '<ul><li>本项目导出 GLB 与制作包；VRM 的骨骼绑定、权重和弹簧物理需要 Blender + VRM 插件完成。</li>' +
      '<li>把制作包交给编码助手，按「权重传递 → 弹簧骨骼 → VRM 导出」的顺序可完成最后一步。</li></ul></div>';
  }

  var STAGE_RENDER = [renderStageSrc, renderStageParts, renderStageViews, renderStageModel, renderStageExport];

  function renderStage() {
    stageEl.innerHTML = STAGE_RENDER[state.stage]();
    var file = byId('charaSrcFile');
    if (file) file.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importSrc(e.target.files[0]);
    });
    var sel = byId('charaCandN');
    if (sel) sel.addEventListener('change', function () { state.candN = sel.value | 0; save(); });
    var radios = stageEl.querySelectorAll('input[name="chara-msrc"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () { state.modelSrc = this.value; save(); });
    }
  }

  function footReq() {
    if (state.stage === 0) return state.src ? '原画就绪' : '请先导入原画';
    if (state.stage === 1) return stageDone(1) ? '部位图最低要求已满足' : '至少生成 头·正面 与 身·正面';
    if (state.stage === 2) return stageDone(2) ? '三视图就绪' : '至少生成 正面 视图（走分离路线可跳过）';
    if (state.stage === 3) return stageDone(3) ? '已选定候选' : '请挑选一个候选';
    return '可随时导出';
  }

  function renderFoot() {
    var last = state.stage === STAGES.length - 1;
    footEl.innerHTML =
      '<span class="chara-foot-msg">' + esc(footMsg || footReq()) + '</span>' +
      '<div class="chara-foot-btns">' +
      (state.stage > 0 ? '<button type="button" class="btn sm ghost" data-act="back">上一阶段</button>' : '') +
      (!last ? '<button type="button" class="btn sm" data-act="next"' + (stageDone(state.stage) ? '' : ' disabled') + '>确认并继续 →</button>' : '') +
      '</div>';
  }

  /* ---------- 交互 ---------- */
  function importSrc(file) {
    if (!file || !/^image\//.test(file.type)) { footMsg = '请选择图片文件'; render(); return; }
    readAsDataURL(file).then(shrink).then(function (durl) {
      state.src = durl;
      state.srcName = file.name || '';
      state.srcInfo = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
      footMsg = '';
      save(); render();
    }).catch(function (e) { footMsg = '导入失败：' + e.message; render(); });
  }

  function setCell(kind, key, patch) {
    var bag = kind === 'part' ? state.parts : state.views;
    if (!bag[key]) bag[key] = blankPart();
    Object.keys(patch).forEach(function (k) { bag[key][k] = patch[k]; });
  }

  function genRow(group) {
    var items;
    if (group === 'views') items = VIEWS.map(function (v) { return ['view', v.key, 'gen-view']; });
    else items = PARTS.filter(function (p) { return p.key.indexOf(group + '.') === 0; })
      .map(function (p) { return ['part', p.key, 'gen-part']; });
    /* 整排串行生成：同时打 4 个请求容易触发限流，串行也方便逐张检查 */
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () { return genCellWait(it[0], it[1], it[2]); });
    });
  }

  function genCellWait(kind, key, actKind) {
    var busyKey = actKind + ':' + key;
    if (busy[busyKey]) return Promise.resolve();
    var bag = kind === 'part' ? state.parts : state.views;
    var item = bag[key];
    var prompt = null;
    PARTS.forEach(function (p) { if (p.key === key) prompt = p.prompt; });
    VIEWS.forEach(function (v) { if (v.key === key) prompt = v.prompt; });
    if (!prompt) return Promise.resolve();
    if (!state.src) { footMsg = '先在阶段 1 导入原画'; render(); return Promise.resolve(); }
    busy[busyKey] = true;
    setCell(kind, key, { status: '生成中…' });
    render();
    return genImage(prompt, state.src, function (msg) {
      setCell(kind, key, { status: typeof msg === 'number' ? '生成中 ' + msg : msg });
      render();
    }).then(function (durl) {
      return shrink(durl, 1280).then(function (small) {
        setCell(kind, key, { img: blobPack(small), status: '' });
      });
    }).catch(function (e) {
      setCell(kind, key, { status: '失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : e.message) });
    }).then(function () {
      busy[busyKey] = false;
      save(); render();
    });
  }

  function genCandidates() {
    var kind = state.mode;                       // 'full' | 'split'
    if (candBusy.indexOf(kind) >= 0) return;
    var jobs = [];                               // [{ck, srcKey}]
    if (kind === 'full') {
      jobs.push({ ck: 'full', srcKey: state.modelSrc });
    } else {
      jobs.push({ ck: 'head', srcKey: 'parts.head.front' });
      jobs.push({ ck: 'body', srcKey: 'parts.body.front' });
    }
    /* 输入图检查 */
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var img = j.srcKey === 'src' ? state.src : (j.srcKey.indexOf('views.') === 0 ? (state.views[j.srcKey.slice(6)] || {}).img : (state.parts[j.srcKey.slice(6)] || {}).img);
      if (!img) { footMsg = '缺少输入图：' + j.srcKey; render(); return; }
      j.src = img;
    }
    candBusy.push(kind);
    footMsg = '';
    render();

    var chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        var list = state.cands[j.ck] = state.cands[j.ck] || [];
        var n = state.candN;
        var seq = Promise.resolve();
        for (var i = 0; i < n; i++) {
          (function (idx) {
            seq = seq.then(function () {
              footMsg = '候选 ' + (idx + 1) + '/' + n + ' 建模中…';
              render();
              return genCandidate(j.src, function (m) {
                footMsg = '候选 ' + (idx + 1) + '/' + n + '：' + m;
                render();
              }).then(function (cand) {
                list.push(cand);
                if (state.pick[j.ck] < 0) state.pick[j.ck] = 0;
                save(); render();
              });
            });
          })(i);
        }
        return seq;
      });
    });
    chain.catch(function (e) {
      footMsg = '建模失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : e.message);
    }).then(function () {
      candBusy = candBusy.filter(function (k) { return k !== kind; });
      if (!footMsg) footMsg = '候选生成完毕，请挑选';
      save(); render();
    });
  }

  function exportJSON() {
    var out = {
      kit: 'openagi-chara', v: 1,
      created: new Date().toISOString(),
      source: { name: state.srcName, info: state.srcInfo, image: resolveImg(state.src) },
      parts: {}, views: {}, mode: state.mode, picks: state.pick,
      models: state.cands
    };
    Object.keys(state.parts).forEach(function (k) {
      out.parts[k] = { image: resolveImg(state.parts[k].img) };
    });
    Object.keys(state.views).forEach(function (k) {
      out.views[k] = { image: resolveImg(state.views[k].img) };
    });
    var url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'chara-project.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    footMsg = '项目 JSON 已导出';
    render();
  }

  function exportParts() {
    var imgs = [];
    Object.keys(state.parts).forEach(function (k) {
      var v = resolveImg(state.parts[k].img);
      if (v) imgs.push([k, v]);
    });
    Object.keys(state.views).forEach(function (k) {
      var v = resolveImg(state.views[k].img);
      if (v) imgs.push(['views.' + k, v]);
    });
    if (!imgs.length) { footMsg = '还没有可导出的图'; render(); return; }
    var seq = Promise.resolve();
    imgs.forEach(function (it) {
      seq = seq.then(function () {
        return new Promise(function (res) {
          var a = document.createElement('a');
          a.href = it[1];
          a.download = 'chara_' + it[0].replace('.', '_') + '.png';
          a.click();
          setTimeout(res, 350);   /* 连续下载给浏览器留间隔，防止被弹窗拦截吞掉 */
        });
      });
    });
    seq.then(function () { footMsg = '已导出 ' + imgs.length + ' 张图'; render(); });
  }

  function resetProject() {
    if (!window.confirm('新建项目会清空当前进度（原画、部位图、候选选择），确定？')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    state.stage = 0; state.src = ''; state.srcName = ''; state.srcInfo = '';
    PARTS.forEach(function (p) { state.parts[p.key] = blankPart(); });
    VIEWS.forEach(function (v) { state.views[v.key] = blankPart(); });
    state.mode = 'full'; state.modelSrc = 'views.front';
    state.cands = { full: [], head: [], body: [] };
    state.pick = { full: -1, head: -1, body: -1 };
    footMsg = '已新建项目';
    save(); render();
  }

  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'goto') { state.stage = el.getAttribute('data-i') | 0; footMsg = ''; save(); render(); return; }
    if (act === 'next') { if (stageDone(state.stage)) { state.stage++; footMsg = ''; save(); render(); } return; }
    if (act === 'back') { if (state.stage > 0) { state.stage--; footMsg = ''; save(); render(); } return; }
    if (act === 'reset') { resetProject(); return; }
    if (act === 'pick-src') { var f = byId('charaSrcFile'); if (f) f.click(); return; }
    if (act === 'clear-src') { state.src = ''; state.srcName = ''; state.srcInfo = ''; save(); render(); return; }
    if (act === 'dropzone') { var f2 = byId('charaSrcFile'); if (f2) f2.click(); return; }
    if (act === 'gen-part') { genCellWait('part', el.getAttribute('data-key'), 'gen-part'); return; }
    if (act === 'gen-view') { genCellWait('view', el.getAttribute('data-key'), 'gen-view'); return; }
    if (act === 'gen-row') { genRow(el.getAttribute('data-key')); return; }
    if (act === 'mode') {
      state.mode = el.getAttribute('data-v') === 'split' ? 'split' : 'full';
      save(); render(); return;
    }
    if (act === 'gen-cand') { genCandidates(); return; }
    if (act === 'pick-cand') {
      var kind = el.getAttribute('data-kind'), i = el.getAttribute('data-i') | 0;
      state.pick[kind] = i; footMsg = ''; save(); render(); return;
    }
    if (act === 'preview3d') {
      var url = el.getAttribute('data-url');
      if (window.Model3D && Model3D.ready()) {
        footMsg = '3D 预览已打开';
        Model3D.openPreview(url, { title: '角色模型预览' }).catch(function (e2) { footMsg = '预览失败：' + friendlyErr(e2); render(); });
      } else footMsg = '3D 组件未就绪';
      render(); return;
    }
    if (act === 'quad') {
      var qurl = el.getAttribute('data-url');
      if (!(window.Model3D && Model3D.ready())) { footMsg = '3D 组件未就绪'; render(); return; }
      el.disabled = true;
      Model3D.quadViews(qurl, { size: 2048, mode: 'line' }).then(function (u) {
        var a = document.createElement('a');
        a.href = u; a.download = 'chara_quad_views.png'; a.click();
        footMsg = '四视图已导出';
      }).catch(function (e2) { footMsg = '四视图失败：' + friendlyErr(e2); })
        .then(function () { render(); });
      return;
    }
    if (act === 'export-json') { exportJSON(); return; }
    if (act === 'export-parts') { exportParts(); return; }
  }

  /* ---------- 装配 ---------- */
  function open() {
    host = byId('charaHost');
    if (!host || host.dataset.ready === '1') return;
    host.dataset.ready = '1';
    if (typeof blobEnsure === 'function') { try { blobEnsure(); } catch (e) {} }
    load();
    host.innerHTML =
      '<div class="chara-layout">' +
      '<aside class="chara-rail" id="charaRail"></aside>' +
      '<section class="chara-main">' +
      '<header class="chara-head"><b>角色工坊</b><span>插画 → 部位图 → 三视图 → 3D 候选 → 导出</span></header>' +
      '<div class="chara-body" id="charaStage"></div>' +
      '<footer class="chara-foot" id="charaFoot"></footer>' +
      '</section></div>';
    railEl = byId('charaRail');
    stageEl = byId('charaStage');
    footEl = byId('charaFoot');
    host.addEventListener('click', onClick);
    /* 拖放导入 */
    host.addEventListener('dragover', function (e) { e.preventDefault(); });
    host.addEventListener('drop', function (e) {
      e.preventDefault();
      if (state.stage !== 0) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importSrc(f);
    });
    render();
  }

  window.charaKit = { open: open };

  registerApp({
    id: 'chara',
    name: '角色工坊',
    title: '角色工坊',
    sub: '插画 → 部位图 → 3D 候选',
    glyph: 'chara',
    order: 15,
    cls: 'chara',
    win: 'charaWin',
    css: ['apps/chara/app.css'],
    body: '<div class="chara-host" id="charaHost"></div>',
    open: function () { open(); }
  });
})();

/* ---- apps/chat/app.js ---- */
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

/* ---- apps/code/app.js ---- */
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

/* ---- apps/comfy/app.js ---- */
/* 本地生图 —— ComfyUI 引擎。
 *
 * 单独成 App 而不是塞进模型控制台的小方块：它自带安装 / 启动 / 端口 / 网页界面，
 * 塞进控制台里用户既不知道点哪里也看不清状态。装生图模型前先把它跑起来是最自然的顺序。
 *
 * body 里的 #cfApp 是宿主节点，界面由 js/comfy-app.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'comfy',
    name: '本地生图',
    title: '本地生图',
    /* 标签要短（切换条上塞不下「本地生图 · ComfyUI」），窗口标题栏保留完整名字 */
    barTitle: '本地生图 · ComfyUI',
    sub: 'ComfyUI 引擎',
    glyph: 'comfy',
    order: 4,
    cls: 'comfy',
    win: 'comfyWin',
    /* ComfyUI 本身就是一个网页界面（8188）。这里把它内嵌进窗口：
     * 顶部状态条管引擎的启动 / 停止 / 重载，下面直接显示工作流画布，
     * 不用每次再去系统浏览器单开一个标签页。 */
    css: ['apps/comfy/app.css'],
    body: '<div class="cf-app" id="cfApp"></div>',
    open: function () {
      if (typeof openComfyApp === 'function') openComfyApp();
    }
  });
})();

/* ---- apps/gallery/app.js ---- */
/* 图库 / 模型库 —— 两个入口共用一个窗口 #libWin。
 *
 * 为什么合在一个文件：它们的窗口是同一个，只是 `openLibrary(mode)` 传的 mode 不同
 * （image → 生成结果与素材，model → 本机模型文件）。拆成两个目录就会出现
 * 「窗口 body 在两处各写一份、谁先加载谁说了算」的隐式顺序依赖，比放一起更脆。
 * 目录名取主入口 gallery，tools/app-scan.js 校验的是「目录名在注册的 id 里」。
 *
 * body 里的 #libBody 是模块的宿主节点 —— js/library.js 会整块接管它。
 */
(function () {
  'use strict';

  const BODY = '<div class="lib-body" id="libBody"></div>';

  registerApp({
    id: 'gallery',
    name: '图库',
    title: '图库',
    sub: '生成结果与素材',
    glyph: 'gallery',
    order: 5,
    cls: 'lib',
    win: 'libWin',
    body: BODY,
    open: function () {
      if (typeof openLibrary === 'function') openLibrary('image');
    }
  });

  /* 第二个注册时 #libWin 已经存在，registerApp 会复用它、不再写 body ——
     所以这里不重复声明 body（写了也不会生效，纯噪音）。 */
  registerApp({
    id: 'modelLib',
    name: '模型库',
    title: '模型库',
    sub: '本机模型文件',
    glyph: 'modelLib',
    order: 6,
    win: 'libWin',
    open: function () {
      if (typeof openLibrary === 'function') openLibrary('model');
    }
  });
})();

/* ---- apps/hello/app.js ---- */
/* 模板 App：你好
 *
 * 复制这个目录改名就是新 App 的全部工作：
 *   1. 改 id / name / title（id 必须全项目唯一，它是标签和注册表的键）
 *   2. 改 mount() 里的界面
 *   3. 跑一次 node tools/app-scan.js 生成清单
 * index.html、desk-shell.js 一行都不用碰。
 *
 * ⚠ 三条最容易踩的（都不是语法问题，是「看着能跑但会坏」的那种）：
 * ① 整个文件包在 IIFE 里。不然这里的顶层函数会挂到那个 1165 个名字共享的 window 作用域上，
 *    和别的 App 撞名时 git 不报错、运行时时静默覆盖（用 node tools/ns-guard.js 能查出来）。
 * ② mount() 必须幂等。openDeskApp 每次翻到这个 App 都会调 open() → mount()，
 *    不是只调第一次。直接重建 innerHTML 会把用户刚输入的、刚滚动到的位置全冲掉。
 *    判据用 body.dataset.ready，画过一次就只做「刷新」不做「重建」。
 * ③ 不许写盘、不许碰 window.openagiDesktop。第三方的 App 将来会跑在同一个渲染进程里，
 *    这条线现在靠自觉，以后再收紧到能力白名单。
 */
(function () {
  'use strict';

  let openCount = 0;

  function stat(text) {
    const lines = text.length ? text.split('\n').length : 0;
    return { chars: text.length, lines: lines };
  }

  function render(body) {
    const ta = body.querySelector('.hello-in');
    const out = body.querySelector('.hello-out');
    const meta = body.querySelector('.hello-meta');
    const text = ta.value;

    /* 演示「一次能力调用」的位置：真正接 AI 时这里换成 llmConn() + 流式写 out */
    out.textContent = text ? text.split('').reverse().join('') : '（上面输入点什么）';

    const s = stat(text);
    meta.textContent = s.chars + ' 字 · ' + s.lines + ' 行 · 本会话打开 ' + openCount + ' 次';
  }

  registerApp({
    id: 'hello',
    name: '你好',
    title: '你好 · 模板 App',
    sub: '新 App 的骨架，复制即用',
    icon: deskSvg('hello'),
    css: ['apps/hello/app.css'],

    mount: function (body) {
      openCount++;

      /* 已经画过：只刷新数据，不重建 DOM（否则用户输入和滚动位置全丢） */
      if (body.dataset.ready === '1') {
        render(body);
        return;
      }

      body.innerHTML =
        '<div class="hello-wrap">' +
          '<div class="hello-head">' +
            '<div class="hello-h">你好</div>' +
            '<div class="hello-p">这是一个模板 App：窗口、样式、脚本、图标全由它自己声明，index.html 里没有它的任何代码。</div>' +
          '</div>' +
          '<textarea class="hello-in" spellcheck="false" placeholder="在这里输入，右边会把它倒过来。"></textarea>' +
          '<div class="hello-out" aria-live="polite"></div>' +
          '<div class="hello-foot">' +
            '<span class="hello-meta"></span>' +
            '<button type="button" class="hello-btn">清空</button>' +
          '</div>' +
        '</div>';

      const ta = body.querySelector('.hello-in');
      ta.addEventListener('input', () => render(body));
      body.querySelector('.hello-btn').addEventListener('click', () => { ta.value = ''; render(body); ta.focus(); });

      body.dataset.ready = '1';
      render(body);
      setTimeout(() => ta.focus(), 60);
    }
  });
})();

/* ---- apps/imglab/app.js ---- */
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

/* ---- apps/live2d/body.js ---- */
/* 数字人 App 的窗口 DOM（app-scan 会把它排在 app.js 之前内联）。
 *
 * 角色是真正的 Cubism 4 皮套（鲸鱼娘 c_0120），由 pixi-live2d-display 渲染在
 * #l2dCanvas 里的 canvas 上：呼吸、眨眼、物理摆发、44 个表情、8 组动作全部由
 * moc3 自带。模型与运行时都在 apps/live2d/ 下，file:// 断网也能跑。
 */
window.L2D_BODY = `
<div class="l2d-app" id="l2dApp">
  <div class="l2d-main">

    <section class="l2d-stage" id="l2dStage">
      <div class="l2d-bg" aria-hidden="true">
        <div class="l2d-glow g1"></div>
        <div class="l2d-glow g2"></div>
        <div class="l2d-glow g3"></div>
        <div class="l2d-dots"></div>
        <div class="l2d-petal p1"></div>
        <div class="l2d-petal p2"></div>
        <div class="l2d-petal p3"></div>
        <div class="l2d-petal p4"></div>
        <div class="l2d-floor"></div>
      </div>

      <div class="l2d-hud">
        <div class="l2d-id">
          <span class="l2d-livedot" id="l2dLiveDot"></span>
          <span class="l2d-nm" id="l2dName">鲸鱼娘</span>
          <span class="l2d-mood" id="l2dMood">平静</span>
        </div>
        <div class="l2d-aff" id="l2dAff" title="亲密度">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4S3.8 15.6 3.8 9.7A4.6 4.6 0 0 1 12 6.4a4.6 4.6 0 0 1 8.2 3.3c0 5.9-8.2 10.7-8.2 10.7Z"/></svg>
          <span class="l2d-aff-bar"><i id="l2dAffFill"></i></span>
          <span class="l2d-aff-txt" id="l2dAffTxt">初识</span>
        </div>
      </div>

      <div class="l2d-rig" id="l2dRig">
        <!-- 皮套：Cubism 4 模型在 canvas 里渲染，SVG 骨架已退役 -->
        <div class="l2d-canvas" id="l2dCanvas"></div>
        <div class="l2d-rig-state" id="l2dRigLoading"><i></i><span>正在唤醒皮套…</span></div>
        <div class="l2d-rig-state is-err" id="l2dRigErr" hidden>
          <b>皮套加载失败</b>
          <span>检查 apps/live2d/model 下的 moc3 与纹理是否完整</span>
        </div>
        <div class="l2d-hit l2d-hit-head" data-part="head" title="摸摸头"></div>
        <div class="l2d-hit l2d-hit-body" data-part="body" title="戳一下"></div>
      </div>

      <div class="l2d-tip" id="l2dTip">移动鼠标，她会看着你 · 点她一下试试</div>

      <div class="l2d-say" id="l2dSay" hidden title="点一下收起">
        <div class="l2d-say-txt" id="l2dSayTxt"></div>
        <i class="l2d-say-tail" aria-hidden="true"></i>
      </div>

      <div class="l2d-acts" role="group" aria-label="动作">
        <button type="button" class="l2d-act" data-act="greet">打招呼</button>
        <button type="button" class="l2d-act" data-act="selfie">自拍</button>
        <button type="button" class="l2d-act" data-act="bubble">吹泡泡</button>
        <button type="button" class="l2d-act" data-act="ketchup">挤番茄酱</button>
        <button type="button" class="l2d-act" data-act="splash">喷水</button>
        <button type="button" class="l2d-act" data-act="openLid">开盖</button>
      </div>
    </section>

    <aside class="l2d-side">
      <div class="l2d-tabs">
        <button type="button" class="l2d-tab on" data-tab="chat">对话</button>
        <button type="button" class="l2d-tab" data-tab="persona">角色</button>
        <span class="l2d-conn" id="l2dConn" title="语言模型连接状态">检测中…</span>
      </div>

      <div class="l2d-pane l2d-pane-chat" data-pane="chat">
        <div class="l2d-log" id="l2dLog" aria-live="polite"></div>

        <div class="l2d-typing hidden" id="l2dTyping">
          <span class="l2d-typing-dots"><i></i><i></i><i></i></span>
          <span class="l2d-typing-txt">正在组织语言…</span>
        </div>

        <div class="l2d-quick" id="l2dQuick">
          <button type="button" data-quick="夸夸我今天的样子">夸夸我</button>
          <button type="button" data-quick="随便陪我聊两句吧">陪我聊聊</button>
          <button type="button" data-quick="给我讲个冷笑话">讲个笑话</button>
        </div>

        <div class="l2d-compose">
          <textarea id="l2dInput" rows="1" spellcheck="false" placeholder="和她说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="button" class="l2d-send" id="l2dSend" aria-label="发送">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12 20 4.5 15.4 20l-3.1-6.3L4.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </button>
        </div>

        <div class="l2d-foot">
          <button type="button" class="l2d-mini on" id="l2dVoice" title="语音朗读">朗读 开</button>
          <button type="button" class="l2d-mini" id="l2dClear">清空对话</button>
          <span class="l2d-count" id="l2dCount"></span>
        </div>
      </div>

      <div class="l2d-pane l2d-pane-persona hidden" data-pane="persona">
        <div class="l2d-form">
          <label class="l2d-field">
            <span class="l2d-lab">名字</span>
            <input type="text" id="l2dFName" maxlength="12" placeholder="琉音">
          </label>
          <label class="l2d-field">
            <span class="l2d-lab">怎么称呼你</span>
            <input type="text" id="l2dFUser" maxlength="12" placeholder="主人">
          </label>
          <label class="l2d-field l2d-field-grow">
            <span class="l2d-lab">人设 / 说话方式</span>
            <textarea id="l2dFPersona" rows="6" spellcheck="false"></textarea>
          </label>

          <div class="l2d-field">
            <span class="l2d-lab">朗读声音</span>
            <div class="l2d-tts" id="l2dTts">
              <div class="l2d-tts-head">
                <span class="l2d-tag" id="l2dVoiceEngine">系统语音</span>
                <div class="l2d-tts-tools">
                  <button type="button" class="l2d-mini" id="l2dVoiceRefresh" title="重新检测系统语音与本地模型">检测</button>
                  <button type="button" class="l2d-mini" id="l2dVoiceOpen" title="打开系统语音合成设置">设置</button>
                </div>
              </div>
              <label class="l2d-tts-row">
                <span class="l2d-tts-key">音色</span>
                <select id="l2dVoiceSel" class="l2d-select" aria-label="音色"></select>
              </label>
              <!-- 选中支持韵律的本地音色时出现：决定朗读是交给 AI 控节奏，还是原样整句读 -->
              <div class="l2d-tts-row l2d-ai hidden" id="l2dAiCtrl">
                <span class="l2d-tts-key">方式</span>
                <div class="l2d-ai-modes" role="radiogroup" aria-label="AI 语音控制方式">
                  <button type="button" class="l2d-ai-btn on" data-l2d-ai="ai" role="radio" aria-checked="true">AI 控制</button>
                  <button type="button" class="l2d-ai-btn" data-l2d-ai="direct" role="radio" aria-checked="false">直接朗读</button>
                </div>
              </div>
              <div class="l2d-stats" id="l2dVoiceStatus">检测中…</div>
              <div class="l2d-tts-params">
                <label class="l2d-range" id="l2dRateRow"><span>语速</span><input type="range" id="l2dRate" min="0.7" max="1.4" step="0.02" value="1.04"><em id="l2dRateVal">1.04</em></label>
                <label class="l2d-range" id="l2dPitchRow"><span>音调</span><input type="range" id="l2dPitch" min="0.7" max="1.5" step="0.02" value="1.12"><em id="l2dPitchVal">1.12</em></label>
              </div>
              <button type="button" class="l2d-btn l2d-tts-test" id="l2dVoiceTest">试听一句</button>
              <p class="l2d-tts-hint" id="l2dVoiceHint"></p>
            </div>
          </div>

          <div class="l2d-field">
            <span class="l2d-lab">长期记忆</span>
            <div class="l2d-mem">
              <p class="l2d-mem-txt" id="l2dMemText">还没有整理过记忆。</p>
              <div class="l2d-mem-acts">
                <button type="button" class="l2d-btn" id="l2dMemNow">整理记忆</button>
                <button type="button" class="l2d-btn" id="l2dMemClear">清空记忆</button>
                <button type="button" class="l2d-btn" id="l2dExport">导出对话</button>
              </div>
            </div>
          </div>

          <div class="l2d-field">
            <span class="l2d-lab">皮套</span>
            <select id="l2dModelSel" class="l2d-select" aria-label="皮套"></select>
            <div class="l2d-credit">
              <b id="l2dCreditName">鲸鱼娘 · c_0120</b>
              <span id="l2dCreditAuthor">形象：上善无形 / ZipZipPipe　模型：氵六青</span>
              <span id="l2dCreditLicense">CC BY-NC-SA 4.0 · 仅非商业使用</span>
            </div>
          </div>

          <div class="l2d-field">
            <span class="l2d-lab">表情试演</span>
            <div class="l2d-exprs" id="l2dExprs">
              <button type="button" data-emo="neutral">平静</button>
              <button type="button" data-emo="happy">开心</button>
              <button type="button" data-emo="shy">害羞</button>
              <button type="button" data-emo="sad">难过</button>
              <button type="button" data-emo="angry">生气</button>
              <button type="button" data-emo="surprise">惊讶</button>
              <button type="button" data-emo="think">思考</button>
            </div>
            <div class="l2d-exprs l2d-exprs-extra" id="l2dExprsExtra">
              <button type="button" data-exp="heart-eyes">爱心眼</button>
              <button type="button" data-exp="star-eyes">星星眼</button>
              <button type="button" data-exp="tongue">吐舌</button>
              <button type="button" data-exp="sweat">流汗</button>
              <button type="button" data-exp="dizzy">晕晕</button>
              <button type="button" data-exp="sunglasses">墨镜</button>
            </div>
          </div>

          <div class="l2d-form-acts">
            <button type="button" class="l2d-btn primary" id="l2dSave">保存角色</button>
            <button type="button" class="l2d-btn" id="l2dReset">恢复默认</button>
          </div>
          <p class="l2d-note">人设与对话只存在本机；模型连接沿用工作站的统一配置（设置 → 语言模型）。</p>
        </div>
      </div>
    </aside>
  </div>
</div>
`;

/* ---- apps/live2d/app.js ---- */
/* 数字人 —— Live2D 风格的桌面对话角色。
 *
 * 角色是真正的 Cubism 4 皮套（鲸鱼娘 c_0120，moc3 + 2 张 2048 纹理）：
 *   · 呼吸 / 眨眼 / 物理摆发 / 口型参数全部由模型自带，运行时是
 *     pixi.min.js + live2dcubismcore + pixi-live2d-display（都在 vendor/ 下）；
 *   · 表情：44 个 exp3 里挑 7 个映射到对话情绪，角色面板还能手动试演；
 *   · 动作：8 组 motion3 挂在动作条上；
 *   · 视线：鼠标位置喂给 focusController，头和眼珠会跟着走；
 *   · 口型：模型流式输出时按字符切音节，逐字驱动 ParamMouthOpenY。
 *
 * ⚠ file:// 下 XHR 读不了本地文件，所以每个皮套由 tools/pack-live2d.js
 *   预打包成 model/<id>/pack.js（moc3 转 base64、json 直接是对象），
 *   model/models.js 是皮套清单，运行时按需加载并可在角色面板里换装。
 *
 * 2.0 在皮套之上补了语音与记忆：朗读的音色/语速/音调可调，口型优先吃引擎的
 * 词边界事件；长期记忆摘要可以手动整理，也会在每 12 条消息后自动更新。
 *
 * 对话走工作站统一的 llmStreamRequest（网关 / 本地 Key / 多 Key 路由都覆盖），
 * 人设、亲密度、聊天记录与记忆只存本机 localStorage（hf_live2d_state）。
 */
(function () {
  'use strict';

  var BODY_HTML = window.L2D_BODY || '';

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="9.2" r="5"/><path d="M7.4 6.1c1.1-1.4 2.7-2.2 4.6-2.2s3.5.8 4.6 2.2"/>' +
    '<path d="M5.6 20.6c.5-3.6 3-5.7 6.4-5.7s5.9 2.1 6.4 5.7"/></svg>';

  /* ---------- 人设 / 皮套 ---------- */
  var DEFAULT_PERSONA = {
    name: '鲸鱼娘',
    userCall: '主人',
    persona: '温柔、活泼、略带一点小俏皮。说话像认识很久的朋友，会关心用户的近况，偶尔撒娇，但不过分黏人。',
    voice: true,
    tts: { voice: '', rate: 1.04, pitch: 1.12 }
  };

  /* 皮套与运行时都在 App 目录下，全部相对本页解析；皮套按 model/<id>/ 一套一个目录 */
  var MODEL_DIR = 'apps/live2d/model/';
  var MODELS_SRC = MODEL_DIR + 'models.js';
  var RIG_SCRIPTS = [
    'apps/live2d/vendor/pixi.min.js',
    'apps/live2d/vendor/live2dcubismcore.min.js',
    'apps/live2d/vendor/cubism4.min.js'
  ];
  /* 皮套在舞台上占的高度比例；1 刚好不裁切 */
  var RIG_FIT = 0.97;

  /* 情绪 → 模型表情。空串表示回到中性（重置当前表情）。 */
  var EXPR = {
    neutral:  { mood: '平静', expr: '' },
    happy:    { mood: '开心', expr: 'excited' },
    shy:      { mood: '害羞', expr: 'blush' },
    sad:      { mood: '难过', expr: 'sad' },
    angry:    { mood: '生气', expr: 'angry' },
    surprise: { mood: '惊讶', expr: 'exclaim' },
    think:    { mood: '思考', expr: 'question' }
  };

  var EMO_ALIAS = {
    '开心': 'happy', '高兴': 'happy', '兴奋': 'happy', '得意': 'happy',
    '害羞': 'shy', '脸红': 'shy', '羞': 'shy',
    '难过': 'sad', '伤心': 'sad', '委屈': 'sad', '低落': 'sad',
    '生气': 'angry', '愤怒': 'angry', '不满': 'angry',
    '惊讶': 'surprise', '吃惊': 'surprise', '意外': 'surprise',
    '思考': 'think', '认真': 'think', '疑惑': 'think',
    '平静': 'neutral', '正常': 'neutral', 'neutral': 'neutral'
  };

  var STORE_KEY = 'hf_live2d_state';
  var STORE_VER = 2;
  /* 衣柜里的「当前搭配」：启动时按它换皮套、隐藏部件 */
  var WARDROBE_KEY = 'hf_wardrobe_state';
  var MAX_MSGS = 60;
  var MAX_HISTORY = 12;
  /* 每累计这么多条新消息，后台自动整理一次长期记忆 */
  var MEM_EVERY = 12;
  var MEM_MAX = 600;

  var ACT_LINES = {
    greet:   { emo: 'happy', motion: 'special', lines: ['嗨～你来啦。', '我在这里呢，今天想聊点什么？', '诶，你终于看我了。'] },
    selfie:  { emo: 'happy', motion: 'selfie', lines: ['来，看镜头～', '先让我摆个姿势。', '这张要发给我哦。'] },
    bubble:  { emo: 'happy', motion: 'bubble', lines: ['噗——你看，泡泡。', '要比谁吹得大吗？', '泡泡糖只剩最后一颗了。'] },
    ketchup: { emo: 'think', motion: 'ketchup', lines: ['蛋包饭要挤番茄酱才好看。', '写字还是画爱心呢……', '别催，我在创作。'] },
    splash:  { emo: 'surprise', motion: 'splash', lines: ['呜啊，喷到你了？', '鲸鱼是会喷水的，别靠近。', '这算打招呼的方式吧。'] },
    openLid: { emo: 'think', motion: 'open-lid', lines: ['盖子打开了。', '里面是什么……我也想知道。', '要不要一起看看？'] }
  };

  var PAT_LINES = ['头发要乱啦。', '唔……再摸一下下就好。', '你手好暖。', '被摸头会变笨的……大概。'];
  var BODY_LINES = ['诶？有什么事吗？', '我在听哦。', '想聊天的话，坐近一点嘛。'];

  /* ---------- 运行时 ---------- */
  var S = null;

  function id(v) { return document.getElementById(v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(d) { d = d || new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  function loadState() {
    var out = {
      persona: JSON.parse(JSON.stringify(DEFAULT_PERSONA)),
      msgs: [],
      mem: { summary: '', at: 0, count: 0 },
      aff: 12,
      modelId: ''
    };
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return out;
    var d = null;
    try { d = JSON.parse(raw); } catch (e) { return out; }
    if (!d || (d.v !== 1 && d.v !== STORE_VER)) return out;
    if (d.persona && typeof d.persona === 'object') {
      Object.keys(DEFAULT_PERSONA).forEach(function (k) {
        if (d.persona[k] !== undefined && d.persona[k] !== null) out.persona[k] = d.persona[k];
      });
      out.persona.name = String(out.persona.name || DEFAULT_PERSONA.name).slice(0, 12);
      out.persona.userCall = String(out.persona.userCall || DEFAULT_PERSONA.userCall).slice(0, 12);
      out.persona.persona = String(out.persona.persona || '').slice(0, 800);
      out.persona.voice = out.persona.voice !== false;
    }
    if (d.persona && d.persona.tts && typeof d.persona.tts === 'object') {
      var t = d.persona.tts;
      out.persona.tts.voice = String(t.voice || '');
      out.persona.tts.rate = clamp(Number(t.rate) || 1.04, 0.7, 1.4);
      out.persona.tts.pitch = clamp(Number(t.pitch) || 1.12, 0.7, 1.5);
    }
    if (Array.isArray(d.msgs)) {
      out.msgs = d.msgs.filter(function (m) {
        return m && (m.r === 'u' || m.r === 'a') && typeof m.t === 'string';
      }).slice(-MAX_MSGS);
    }
    out.aff = clamp(Number(d.aff) || 12, 0, 100);
    out.modelId = typeof d.modelId === 'string' ? d.modelId : '';
    if (d.mem && typeof d.mem === 'object') {
      out.mem.summary = String(d.mem.summary || '').slice(0, MEM_MAX);
      out.mem.at = Number(d.mem.at) || 0;
      out.mem.count = Math.max(0, Number(d.mem.count) || 0);
    }
    return out;
  }

  function saveState() {
    if (!S) return;
    var payload = {
      v: STORE_VER,
      persona: S.persona,
      mem: { summary: S.mem.summary, at: S.mem.at, count: S.mem.count },
      aff: S.aff,
      modelId: S.modelId || '',
      msgs: S.msgs.slice(-MAX_MSGS).map(function (m) {
        return { r: m.r, t: m.t, ts: m.ts, emo: m.emo || '' };
      })
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch (e) { /* 配额满就只留在内存里 */ }
  }

  /* 读衣柜存下的当前搭配；没配过衣柜就返回 null。
     v2 多了 params（作者预留的换装参数），v1 只有 hidden，都兼容。 */
  function readWardrobeWear() {
    var raw = null;
    try { raw = localStorage.getItem(WARDROBE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    var d = null;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!d || (d.v !== 1 && d.v !== 2) || !d.draft || typeof d.draft !== 'object') return null;
    var params = {};
    if (d.draft.params && typeof d.draft.params === 'object') {
      Object.keys(d.draft.params).forEach(function (k) {
        var v = Number(d.draft.params[k]);
        if (k && isFinite(v)) params[k] = v;
      });
    }
    return {
      modelId: typeof d.draft.modelId === 'string' ? d.draft.modelId : '',
      hidden: Array.isArray(d.draft.hidden) ? d.draft.hidden.filter(function (x) {
        return typeof x === 'string' && x;
      }).slice(0, 300) : [],
      shown: Array.isArray(d.draft.shown) ? d.draft.shown.filter(function (x) {
        return typeof x === 'string' && x;
      }).slice(0, 300) : [],
      params: params
    };
  }

  function affLevel() {
    var a = S ? S.aff : 0;
    if (a >= 90) return '心照不宣';
    if (a >= 70) return '默契';
    if (a >= 45) return '亲近';
    if (a >= 20) return '熟悉';
    return '初识';
  }

  /* ---------- 启动 ---------- */
  function boot(body) {
    var loaded = loadState();

    S = {
      body: body,
      win: body.closest ? body.closest('.os-win') : null,
      persona: loaded.persona,
      msgs: loaded.msgs,
      aff: loaded.aff,
      models: [],
      modelId: loaded.modelId,
      /* 衣柜当前搭配里隐藏的部件（Cubism 部件 id）；换装时按它压透明度 */
      hiddenParts: [],
      /* 衣柜要求整组显示的部件（Haru 另一套服装默认 opacity 为 0） */
      shownParts: [],
      /* 衣柜写下的换装参数（作者预留的开关），每帧写回 */
      outfitParams: {},
      emo: 'neutral',
      busy: false,
      abort: null,
      streamEl: null,
      streamTxt: '',
      voiceOn: loaded.persona.voice,
      voiceProbed: false,
      mem: loaded.mem,
      memBusy: false,
      tab: 'chat',
      patCool: 0,
      lastPointerAt: 0,
      toastTimer: null,
      sayUntil: 0,
      rig: {
        ready: false, loading: false, error: '',
        app: null, model: null, gen: 0,
        t: 0, last: 0,
        focusX: 0, focusY: 0, focusTX: 0, focusTY: 0, lastPointerAt: 0,
        anchorX: 0, anchorY: 0,
        speakQ: '', speakAcc: 0, mouthPulse: 0, pulseUntil: 0, mouth: 0, mouthForm: 0.3,
        ttsUntil: 0,
        speaking: false, nod: 0,
        expr: '',
        lastMotion: ''
      },
      refs: {}
    };

    cacheRefs();

    /* 衣柜里保存的搭配优先：换皮套 + 隐藏部件，进门就是上次穿好的样子 */
    var wear = readWardrobeWear();
    if (wear) {
      if (wear.modelId) S.modelId = wear.modelId;
      S.hiddenParts = wear.hidden;
      S.shownParts = wear.shown || [];
      S.outfitParams = wear.params || {};
    }

    applyPersonaUI();
    bindEvents();
    renderLog();
    syncAff();
    syncVoice();
    syncTabs();
    checkConn();

    body.dataset.ready = '1';

    /* 首次打开：先给一个欢迎气泡与开心的表情，不写进聊天记录 */
    if (!S.msgs.length) {
      setEmotion('happy');
      setTimeout(function () { if (S && !S.msgs.length) setEmotion('neutral'); }, 2600);
    } else {
      setEmotion(lastEmotion() || 'neutral');
    }

    loadRig();
    installProbe();
    startLoop();
  }

  function cacheRefs() {
    var b = S.body;
    S.refs = {
      log: b.querySelector('#l2dLog'),
      input: b.querySelector('#l2dInput'),
      send: b.querySelector('#l2dSend'),
      typing: b.querySelector('#l2dTyping'),
      count: b.querySelector('#l2dCount'),
      name: b.querySelector('#l2dName'),
      mood: b.querySelector('#l2dMood'),
      affFill: b.querySelector('#l2dAffFill'),
      affTxt: b.querySelector('#l2dAffTxt'),
      conn: b.querySelector('#l2dConn'),
      voice: b.querySelector('#l2dVoice'),
      stage: b.querySelector('#l2dStage'),
      say: b.querySelector('#l2dSay'),
      sayTxt: b.querySelector('#l2dSayTxt'),
      tip: b.querySelector('#l2dTip'),
      fName: b.querySelector('#l2dFName'),
      fUser: b.querySelector('#l2dFUser'),
      fPersona: b.querySelector('#l2dFPersona'),
      exprs: b.querySelector('#l2dExprs'),
      exprsExtra: b.querySelector('#l2dExprsExtra'),
      modelSel: b.querySelector('#l2dModelSel'),
      creditName: b.querySelector('#l2dCreditName'),
      creditAuthor: b.querySelector('#l2dCreditAuthor'),
      creditLicense: b.querySelector('#l2dCreditLicense'),
      voiceSel: b.querySelector('#l2dVoiceSel'),
      aiCtrl: b.querySelector('#l2dAiCtrl'),
      voiceRefresh: b.querySelector('#l2dVoiceRefresh'),
      voiceEngine: b.querySelector('#l2dVoiceEngine'),
      voiceStatus: b.querySelector('#l2dVoiceStatus'),
      voiceOpen: b.querySelector('#l2dVoiceOpen'),
      voiceHint: b.querySelector('#l2dVoiceHint'),
      rate: b.querySelector('#l2dRate'),
      rateRow: b.querySelector('#l2dRateRow'),
      rateVal: b.querySelector('#l2dRateVal'),
      pitch: b.querySelector('#l2dPitch'),
      pitchRow: b.querySelector('#l2dPitchRow'),
      pitchVal: b.querySelector('#l2dPitchVal'),
      voiceTest: b.querySelector('#l2dVoiceTest'),
      memText: b.querySelector('#l2dMemText'),
      memNow: b.querySelector('#l2dMemNow'),
      memClear: b.querySelector('#l2dMemClear'),
      exportBtn: b.querySelector('#l2dExport'),
      quick: b.querySelector('#l2dQuick'),
      canvas: b.querySelector('#l2dCanvas'),
      rigLoading: b.querySelector('#l2dRigLoading'),
      rigErr: b.querySelector('#l2dRigErr')
    };
  }

  /* ---------- 绑定 ---------- */
  function bindEvents() {
    var r = S.refs;

    r.send.addEventListener('click', function () {
      if (S.busy) abortSend(); else sendMessage();
    });

    r.input.addEventListener('input', growInput);
    r.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!S.busy) sendMessage();
      }
    });

    r.voice.addEventListener('click', function () {
      S.voiceOn = !S.voiceOn;
      S.persona.voice = S.voiceOn;
      if (!S.voiceOn) stopSpeech();
      syncVoice();
      saveState();
      toast(S.voiceOn ? '朗读已开启' : '朗读已关闭');
    });

    /* 快捷话题：点一下等于把文案发出去 */
    if (r.quick) {
      r.quick.addEventListener('click', function (e) {
        var b = e.target.closest('[data-quick]');
        if (!b || S.busy) return;
        r.input.value = b.getAttribute('data-quick');
        growInput();
        sendMessage();
      });
    }

    /* 朗读设置：滑块即时生效并落盘，音色列表随系统语音异步就绪 */
    [r.rate, r.pitch].forEach(function (el) {
      if (el) el.addEventListener('input', applyTtsForm);
    });
    if (r.voiceSel) r.voiceSel.addEventListener('change', applyTtsForm);
    /* AI 语音控制 / 直接朗读：对所有支持韵律的本地音色生效 */
    if (r.aiCtrl) {
      r.aiCtrl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-l2d-ai]');
        if (!b) return;
        setAiCtrlMode(b.getAttribute('data-l2d-ai'));
        paintAiCtrlBtns();
        paintVoiceHint();
      });
    }
    if (r.voiceTest) r.voiceTest.addEventListener('click', testSpeak);
    if (r.voiceRefresh) r.voiceRefresh.addEventListener('click', function () { refreshVoices(true); });
    if (r.voiceOpen) r.voiceOpen.addEventListener('click', openVoiceSettings);
    if (r.memNow) r.memNow.addEventListener('click', function () { summarizeNow(true); });
    if (r.memClear) r.memClear.addEventListener('click', clearMemory);
    if (r.exportBtn) r.exportBtn.addEventListener('click', exportChat);
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.addEventListener('voiceschanged', function () { renderVoiceOptions(); });
      } catch (e) { /* 老引擎没有该事件 */ }
    }
    /* 设置页 / 模型商店改过默认音色，或本地引擎刚探测完：即时同步下拉框 */
    window.addEventListener('hf-tts-changed', function () { renderVoiceOptions(); });
    window.addEventListener('hf-tts-status', function () { renderVoiceOptions(); });

    id('l2dClear').addEventListener('click', function () {
      S.msgs = [];
      hideSay();
      saveState();
      renderLog();
      setEmotion('neutral');
      toast('对话已清空');
    });

    S.body.querySelectorAll('.l2d-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        S.tab = btn.getAttribute('data-tab');
        syncTabs();
      });
    });

    S.body.querySelectorAll('.l2d-act').forEach(function (btn) {
      btn.addEventListener('click', function () { doAction(btn.getAttribute('data-act')); });
    });

    S.body.querySelectorAll('.l2d-hit').forEach(function (hit) {
      hit.addEventListener('click', function () { interact(hit.getAttribute('data-part')); });
    });

    document.addEventListener('pointermove', onPointer);
    r.stage.addEventListener('pointerleave', function () { S.rig.focusTX = 0; S.rig.focusTY = 0; });
    if (r.say) r.say.addEventListener('click', hideSay);

    /* 角色面板 */
    id('l2dSave').addEventListener('click', savePersonaForm);
    id('l2dReset').addEventListener('click', resetPersona);
    r.exprs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-emo]');
      if (!b) return;
      setEmotion(b.getAttribute('data-emo'), true);
    });
    r.exprsExtra.addEventListener('click', function (e) {
      var b = e.target.closest('[data-exp]');
      if (!b) return;
      var name = b.getAttribute('data-exp');
      setRigExpression(name);
      S.emo = '';
      S.refs.mood.textContent = b.textContent;
      toast('表情：' + b.textContent);
    });

    if (r.modelSel) {
      r.modelSel.addEventListener('change', function () { switchModel(r.modelSel.value); });
    }

    S.body.querySelectorAll('.l2d-field input, .l2d-field textarea').forEach(function (el) {
      el.addEventListener('input', function () {
        if (el === r.fName) r.name.textContent = r.fName.value.trim() || DEFAULT_PERSONA.name;
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopSpeech();
    });

    /* Esc：先停朗读；正在生成时等同于点停止 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !S || !S.win || S.win.classList.contains('hidden')) return;
      if (S.busy) abortSend(); else stopSpeech();
    });
  }

  function onPointer(e) {
    if (!S || !S.refs.stage) return;
    var box = S.refs.stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var st = S.rig;
    /* 原点取模型眼睛的屏幕位置，而不是舞台中心：舞台比皮套宽得多，
       按舞台归一化会让「鼠标停在脸上」也变成低头。
       focusController 的 y 轴向上为正，和屏幕坐标相反，所以用 cy - clientY。 */
    var cx = box.left + (st.anchorX || box.width / 2);
    var cy = box.top + (st.anchorY || box.height * 0.34);
    st.focusTX = clamp((e.clientX - cx) / (box.width * 0.5), -1, 1);
    st.focusTY = clamp((cy - e.clientY) / (box.height * 0.45), -1, 1);
    st.lastPointerAt = performance.now();
  }

  function growInput() {
    var el = S.refs.input;
    el.style.height = 'auto';
    el.style.height = Math.min(112, Math.max(38, el.scrollHeight)) + 'px';
  }

  /* ---------- 标签 / 状态 ---------- */
  function syncTabs() {
    S.body.querySelectorAll('.l2d-tab').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === S.tab);
    });
    S.body.querySelectorAll('.l2d-pane').forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-pane') !== S.tab);
    });
    if (S.tab === 'persona') {
      var inp = S.refs.fName;
      if (inp && !inp.value) fillPersonaForm();
      /* 首次进角色页时探测一次本地引擎，之后就沿用缓存，避免每次切页都发请求 */
      if (!S.voiceProbed) { S.voiceProbed = true; refreshVoices(true); }
    }
  }

  function syncVoice() {
    var b = S.refs.voice;
    if (!b) return;
    b.textContent = S.voiceOn ? '朗读 开' : '朗读 关';
    b.classList.toggle('on', !!S.voiceOn);
  }

  function syncAff() {
    S.refs.affFill.style.width = clamp(S.aff, 0, 100) + '%';
    S.refs.affTxt.textContent = affLevel();
    S.refs.affFill.classList.toggle('hot', S.aff >= 70);
  }

  function addAff(n) {
    S.aff = clamp(S.aff + n, 0, 100);
    syncAff();
    saveState();
  }

  function checkConn() {
    var chip = S.refs.conn;
    if (!chip) return;
    var c = null;
    try { if (typeof llmConn === 'function') c = llmConn(); } catch (e) { c = null; }
    var ok = !!(c && c.key && c.base && c.model);
    chip.textContent = ok ? '模型已就绪' : '未配置模型';
    chip.classList.toggle('off', !ok);
    chip.title = ok
      ? (c.via === 'gateway' ? '云端网关 · ' : '本地 Key · ') + c.model
      : '点这里打开「设置 → 语言模型」进行配置';
    if (!ok) {
      chip.onclick = function () {
        if (typeof openSettings === 'function') openSettings('llm');
        else toast('请到设置面板配置语言模型');
      };
    }
  }

  /* ---------- 表情 / 动作 ---------- */
  function setEmotion(name, fromUser) {
    var key = EXPR[name] ? name : 'neutral';
    S.emo = key;
    S.refs.mood.textContent = EXPR[key].mood;
    setRigExpression(EXPR[key].expr);
    if (fromUser) toast('表情：' + EXPR[key].mood);
  }

  /* 表情名对应 model3.json 里的 exp3 文件名；空串 = 回到默认表情。
     换皮套后旧表情名可能不存在，缺就静默跳过，不影响换模型。 */
  function setRigExpression(name) {
    var st = S.rig;
    if (!st.ready || !st.model) { st.expr = name || ''; return; }
    st.expr = name || '';
    var im = st.model.internalModel;
    var em = im && im.motionManager && im.motionManager.expressionManager;
    if (!em) return;
    try {
      if (!st.expr) { if (em.resetExpression) em.resetExpression(); return; }
      em.setExpression(st.expr);
    } catch (e) { /* 该皮套没有这张表情 */ }
  }

  function playMotion(group) {
    var st = S.rig;
    if (!st.ready || !st.model || !group) return;
    st.lastMotion = group;
    try {
      var p = st.model.motion(group);
      if (p && p.catch) p.catch(function () { /* 动作组缺失就当没点 */ });
    } catch (e) { /* 动作缺失就只换表情 */ }
  }

  /* 探针只读钩子：无头测试读模型参数用，不参与任何业务逻辑 */
  function installProbe() {
    if (window.__l2dRig) return;
    window.__l2dRig = function () {
      var m = S && S.rig && S.rig.model;
      if (!m) return null;
      var s = S.rig.snap || {};
      return {
        t: S.rig.t,
        expr: S.rig.expr,
        motion: S.rig.lastMotion || '',
        mouth: s.mouth || 0,
        mouthForm: s.mouthForm || 0,
        angleX: s.angleX || 0,
        angleY: s.angleY || 0,
        angleZ: s.angleZ || 0,
        anchorX: S.rig.anchorX || 0,
        anchorY: S.rig.anchorY || 0,
        headTop: S.rig.headTop || 0,
        breath: s.breath || 0,
        eyeL: s.eyeL === undefined ? 1 : s.eyeL,
        browL: s.browL || 0,
        hidden: (S.hiddenParts || []).slice(),
        shown: (S.shownParts || []).slice(),
        params: Object.assign({}, S.outfitParams || {})
      };
    };

    /* 2.0 诊断钩子：语音设置 / 记忆 / 亲密度，供探针只读校验 */
    window.__l2dDiag = function () {
      if (!S) return null;
      return {
        speaking: !!S.rig.speaking,
        tts: { voice: S.persona.tts.voice, rate: S.persona.tts.rate, pitch: S.persona.tts.pitch },
        aiCtrl: { on: aiCtrlOn(), mode: aiCtrlMode(), prosody: prosodyEngine(localVoiceSpec()) },
        mem: { summary: S.mem.summary, at: S.mem.at, count: S.mem.count },
        aff: S.aff,
        msgs: S.msgs.length,
        busy: !!S.busy
      };
    };
    window.__l2dExportText = function () { return S ? buildExport() : ''; };
    /* 衣柜「穿上」的入口：同一个页面时即时换装 */
    window.__l2dApplyOutfit = function (outfit) { return applyOutfit(outfit); };
  }

  function doAction(act) {
    var conf = ACT_LINES[act];
    if (!conf) return;
    setEmotion(conf.emo);
    playMotion(conf.motion);
    if (act === 'greet') addAff(1);
    localSay(pick(conf.lines), conf.emo);
  }

  function interact(part) {
    var now = Date.now();
    if (now - S.patCool < 1200) return;
    S.patCool = now;
    if (part === 'head') {
      addAff(3);
      setEmotion('shy');
      localSay(pick(PAT_LINES), 'shy');
    } else {
      addAff(1);
      setEmotion('happy');
      localSay(pick(BODY_LINES), 'happy');
    }
  }

  function localSay(text, emo) {
    speechFeed(text);
    pushMsg('a', text, emo || 'neutral');
    showSay(text);
    maybeRemember();
    speakAloud(text);
  }

  /* ---------- 舞台气泡框 ---------- */
  /* 角色说话时，把同一句回复贴在头顶的气泡里；点一下或超时自动收起 */
  function showSay(text, hold) {
    if (!S || !S.refs.say) return;
    var clean = stripEmo(text, true).text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    S.refs.sayTxt.textContent = clean;
    S.refs.say.hidden = false;
    fitSay();
    S.sayUntil = hold === 0 ? 0 : performance.now() + Math.max(4600, Math.min(15000, clean.length * 240));
  }

  function hideSay() {
    if (!S || !S.refs.say) return;
    S.refs.say.hidden = true;
    S.sayUntil = 0;
  }

  /* 气泡底边贴着头顶；舞台太矮（窄窗）时改成底部浮层，避开名牌与亲密度条 */
  function fitSay() {
    var el = S && S.refs.say;
    var stage = S && S.refs.stage;
    if (!el || !stage) return;
    var h = stage.clientHeight;
    var top = S.rig.headTop || h * 0.16;
    /* 头顶到舞台顶不足一条气泡（含 12px 间距）时，退到底部浮层 */
    var tight = top < 72;
    el.classList.toggle('is-tight', tight);
    if (tight) {
      el.style.top = 'auto';
      el.style.bottom = '62px';
      el.style.maxHeight = Math.round(Math.max(52, Math.min(h * 0.42, h - 110))) + 'px';
    } else {
      el.style.top = 'auto';
      el.style.bottom = Math.round(h - top + 12) + 'px';
      el.style.maxHeight = Math.round(Math.max(72, h - top - 18)) + 'px';
    }
  }

  /* ---------- 聊天渲染 ---------- */
  function lastEmotion() {
    for (var i = S.msgs.length - 1; i >= 0; i--) {
      if (S.msgs[i].r === 'a' && S.msgs[i].emo && EXPR[S.msgs[i].emo]) return S.msgs[i].emo;
    }
    return '';
  }

  function pushMsg(role, text, emo) {
    S.msgs.push({ r: role, t: text, ts: Date.now(), emo: emo || '' });
    if (S.msgs.length > MAX_MSGS) S.msgs = S.msgs.slice(-MAX_MSGS);
    saveState();
    renderLog();
  }

  function avatarChar() {
    return (S.persona.name || '琉').slice(0, 1);
  }

  function bubbleEl(role, text, ts) {
    var wrap = document.createElement('div');
    wrap.className = 'l2d-msg ' + (role === 'u' ? 'u' : (role === 's' ? 's' : 'a'));
    if (role !== 'u') {
      var ava = document.createElement('span');
      ava.className = 'l2d-ava';
      ava.textContent = role === 's' ? '!' : avatarChar();
      wrap.appendChild(ava);
    }
    var box = document.createElement('div');
    box.className = 'l2d-bubble';
    var t = document.createElement('span');
    t.className = 'l2d-bubble-txt';
    t.textContent = text;
    box.appendChild(t);
    wrap.appendChild(box);
    if (ts) {
      var time = document.createElement('span');
      time.className = 'l2d-time';
      time.textContent = hhmm(new Date(ts));
      wrap.appendChild(time);
    }
    return wrap;
  }

  function renderLog() {
    var log = S.refs.log;
    if (!log) return;
    log.innerHTML = '';
    S.streamEl = null;

    if (!S.msgs.length) {
      var w = document.createElement('div');
      w.className = 'l2d-welcome';
      w.innerHTML =
        '<b>你好呀，我是' + escapeHtml(S.persona.name) + '。</b>' +
        '<span>点下面的动作打个招呼，或者直接和我说点什么。我会眨眼、看你、说话的嘴型也会跟着动。</span>';
      log.appendChild(w);
    }

    S.msgs.forEach(function (m) {
      log.appendChild(bubbleEl(m.r === 'u' ? 'u' : (m.r === 's' ? 's' : 'a'), m.t, m.ts));
    });

    S.refs.count.textContent = S.msgs.length ? S.msgs.length + ' 条' : '还没有对话';
    scrollLog();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function scrollLog() {
    var log = S.refs.log;
    if (!log) return;
    requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
  }

  function ensureStreamBubble() {
    if (S.streamEl) return S.streamEl;
    var el = bubbleEl('a', '', 0);
    el.classList.add('is-stream');
    S.refs.log.appendChild(el);
    S.streamEl = el;
    return el;
  }

  function setStreamText(text) {
    var el = ensureStreamBubble();
    var t = el.querySelector('.l2d-bubble-txt');
    t.textContent = text;
    var sp = stripEmo(text, false);
    if (sp.text) showSay(sp.text, 0);
    var dots = el.querySelector('.l2d-stream-dots');
    if (!dots) {
      dots = document.createElement('span');
      dots.className = 'l2d-stream-dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      el.querySelector('.l2d-bubble').appendChild(dots);
    }
    scrollLog();
  }

  function setTyping(on) {
    S.refs.typing.classList.toggle('hidden', !on);
  }

  function setBusy(on) {
    S.busy = !!on;
    S.refs.send.classList.toggle('stop', !!on);
    S.refs.send.setAttribute('aria-label', on ? '停止生成' : '发送');
    S.refs.send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12 20 4.5 15.4 20l-3.1-6.3L4.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    S.refs.input.disabled = !!on;
  }

  /* ---------- 对话 ---------- */
  function stripEmo(raw, final) {
    var s = String(raw || '');
    var m = s.match(/^\s*[【\[]\s*([^】\]]{1,6})\s*[】\]]\s*/);
    if (m) {
      var word = m[1].trim();
      return { text: s.slice(m[0].length), emo: EMO_ALIAS[word] || '' };
    }
    if (!final && /^\s*[【\[]/.test(s)) return { text: '', emo: '' };
    return { text: s, emo: '' };
  }

  /* 朗读标记只给 TTS 看：气泡、聊天记录、长期记忆里都不应该出现。
   * 流式输出时标记可能只到一半，先藏到 [[ 之前，避免气泡里闪出「[[p=0」 */
  function stripProsody(s, partial) {
    var t = String(s || '').replace(/\[\[[^\]]*\]\]/g, '');
    if (partial) {
      var i = t.indexOf('[[');
      if (i >= 0) t = t.slice(0, i);
    }
    return t.replace(/[ \t]{2,}/g, ' ').trim();
  }

  /* AI 语音控制：模型在回复里插 [[r=]] / [[p=]] / [[t=]]，桥接层逐段合成。
   * 目前支持 Piper / Kokoro / MeloTTS / VITS / 参数合成；ZipVoice 与系统语音不走这条路。
   * 状态键与设置页共用 hf_ttsAiMode。 */
  function aiCtrlMode() {
    try { return localStorage.getItem('hf_ttsAiMode') === 'direct' ? 'direct' : 'ai'; }
    catch (e) { return 'ai'; }
  }
  function setAiCtrlMode(m) {
    try { localStorage.setItem('hf_ttsAiMode', m === 'direct' ? 'direct' : 'ai'); } catch (e) { /* 隐私模式 */ }
  }
  function prosodyEngine(spec) {
    /* param 是纯 JS 参数合成，[[f]]/[[e]] 也能直接用上，所以和神经引擎一起算支持韵律 */
    return !!(spec && /^(piper|kokoro|melo|vits|param|sys)$/.test(String(spec.engine || '')));
  }
  /* 只有「本地 + 支持韵律 + AI 控制」才让模型去写节奏标记；直接朗读时写标记只会被剥掉 */
  function aiCtrlOn() {
    return prosodyEngine(localVoiceSpec()) && aiCtrlMode() === 'ai';
  }

  function detectEmo(text) {
    var t = String(text || '');
    if (/[【\[]\s*(开心|高兴|兴奋)/.test(t)) return 'happy';
    if (/(哈哈|嘿嘿|太好了|好呀|喜欢|开心)/.test(t)) return 'happy';
    if (/(害羞|脸红|不好意思|别这样)/.test(t)) return 'shy';
    if (/(难过|伤心|对不起|呜呜|舍不得)/.test(t)) return 'sad';
    if (/(生气|讨厌|哼[！!]|不行[！!]|不理你)/.test(t)) return 'angry';
    if (/(诶[？?]|真的吗|什么[！!]|惊讶|居然)/.test(t)) return 'surprise';
    if (/(让我想想|我想想|唔…|大概|也许)/.test(t)) return 'think';
    return 'neutral';
  }

  /* 亲密度分层：同一句回复，刚认识与心照不宣的分寸应该不一样 */
  function intimacyRule() {
    var a = S.aff;
    if (a >= 90) return '亲密度很高：可以自然撒娇、用昵称，主动问用户今天过得怎么样。';
    if (a >= 70) return '已经很默契：省掉客套，偶尔开小玩笑，主动接话。';
    if (a >= 45) return '关系亲近：语气放松，可以追问细节，但不越界。';
    if (a >= 20) return '彼此熟悉：友好但保持分寸，先回应对方，再带一句自己的感受。';
    return '刚认识：礼貌、有分寸，不要自来熟，不要用过分亲昵的称呼。';
  }

  function buildSystem() {
    var p = S.persona;
    var lines = [
      '你是「' + p.name + '」，一个住在用户桌面里的 Live2D 数字人，正在和用户面对面聊天。',
      '你的人设与说话方式：' + (p.persona || DEFAULT_PERSONA.persona),
      '你称呼用户为「' + (p.userCall || '主人') + '」。',
      '你们当前的亲密度是 ' + Math.round(S.aff) + '/100（' + affLevel() + '）。' + intimacyRule()
    ];
    if (S.mem && S.mem.summary) lines.push('长期记忆备忘（之前聊到过的用户信息）：' + S.mem.summary);
    lines.push(
      '回复规则：',
      '1. 用中文口语，像真人说话，1~3 句，总共不超过 70 字，适合朗读。',
      '2. 不要使用 Markdown、列表、括号动作描写或颜文字。',
      '3. 回复最开头用【情绪】标注一次，只能从：开心、害羞、难过、生气、惊讶、思考、平静 中选择。',
      '4. 不要重复用户的原话，不要自称 AI、语言模型或助手。'
    );
    /* 只要是支持韵律的本地音色且开着 AI 控制，就让模型写节奏标记；
     * 系统语音、ZipVoice 或直接朗读模式下不注入，避免标记被念出来。 */
    if (aiCtrlOn()) {
      /* 参数合成的音高 / 重音由运行时直接改波形，可以让模型一起控制；
       * 神经引擎只支持分段语速与停顿，别给它压做不到的参数。 */
      var aiSpec = localVoiceSpec();
      var paramVoice = !!(aiSpec && aiSpec.engine === 'param');
      lines.push(
        '5. 想控制朗读节奏时可以插入标记（显示时会自动隐藏）：[[r=0.9]] 之后放慢（0.8~1.2），[[p=0.4]] 停 0.4 秒，' +
          (paramVoice ? '[[f=1.1]] 之后提高音调（0.8~1.2），[[e=1.2]] 下一句加重（1~1.3），' : '') +
          '[[t=0.3]] 句尾拖 0.3 秒。一条回复最多 2 个，不要连续堆叠。',
        '6. 想表现思考时可以自然地说「嗯……」「那个……」，但不要每句都用。'
      );
    }
    return lines.join('\n');
  }

  function sendMessage() {
    if (S.busy) return;
    var text = S.refs.input.value.trim();
    if (!text) { S.refs.input.focus(); return; }

    hideSay();
    S.refs.input.value = '';
    growInput();
    pushMsg('u', text);
    addAff(1);
    setEmotion('think');

    S.busy = true;
    setBusy(true);
    setTyping(true);

    var history = S.msgs.slice(-MAX_HISTORY).filter(function (m) { return m.r === 'u' || m.r === 'a'; })
      .map(function (m) { return { role: m.r === 'u' ? 'user' : 'assistant', content: m.t }; });

    var acc = '';
    var ctrl = new AbortController();
    S.abort = ctrl;

    if (typeof llmStreamRequest !== 'function') {
      failSend('语言模型模块没有加载（llmStreamRequest 不可用）。');
      return;
    }

    llmStreamRequest(buildSystem(), history, function (full, delta) {
      acc = full;
      var sp = stripEmo(acc, false);
      setTyping(false);
      setStreamText(stripProsody(sp.text, true));
      if (sp.emo) setEmotion(sp.emo);
      if (delta) speechFeed(delta);
    }, { app: 'live2d', signal: ctrl.signal }).then(function (finalText) {
      var raw = (typeof finalText === 'string' && finalText) ? finalText : acc;
      finishSend(raw);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        var partial = stripEmo(acc, true).text.trim();
        S.abort = null;
        setBusy(false);
        setTyping(false);
        removeStream();
        if (partial) {
          var shown = stripProsody(partial);
          pushMsg('a', shown, detectEmo(shown));
          setEmotion(detectEmo(shown));
          speakAloud(partial);
        } else {
          toast('已停止生成');
        }
        return;
      }
      failSend(err && err.message ? err.message : String(err));
    });
  }

  function finishSend(raw) {
    S.abort = null;
    S.busy = false;
    setBusy(false);
    setTyping(false);
    removeStream();

    var sp = stripEmo(raw, true);
    /* speechText 保留 [[...]] 交给本地 TTS；text 是给人看的纯文本 */
    var speechText = sp.text.trim();
    if (!speechText) speechText = '（她沉默了一下，好像在组织语言。）';
    var text = stripProsody(speechText) || '（她沉默了一下，好像在组织语言。）';
    var emo = sp.emo || detectEmo(text);
    setEmotion(emo);
    addAff(1);
    pushMsg('a', text, emo);
    showSay(text);
    maybeRemember();
    speakAloud(speechText);
  }

  function failSend(msg) {
    S.abort = null;
    S.busy = false;
    if (S.refs && S.refs.send) setBusy(false);
    if (S.refs && S.refs.typing) setTyping(false);
    removeStream();
    if (!S.msgs) return;
    setEmotion('sad');
    pushMsg('s', '连接模型失败：' + msg);
    toast('检查「设置 → 语言模型」后重试');
  }

  function removeStream() {
    if (S.streamEl && S.streamEl.parentNode) S.streamEl.parentNode.removeChild(S.streamEl);
    S.streamEl = null;
  }

  function abortSend() {
    if (S.abort) {
      try { S.abort.abort(); } catch (e) { /* 已经结束 */ }
    }
    stopSpeech();
  }

  /* ---------- 语音 ---------- */
  var voiceCache = null;

  /* 语音桥由 js/settings-tts.js 提供：音色清单、本地引擎状态、克隆入口都在那边探测。
   * 拿不到时退回本文件里的系统语音实现，保证 App 单独跑也不哑。 */
  function ttsApi() {
    var b = window.ttsBridge;
    return (b && typeof b.catalog === 'function') ? b : null;
  }

  function voiceList() {
    if (!window.speechSynthesis) return [];
    try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
  }

  /* 模型商店 / 设置页的「默认音色」写在 hf_ttsVoice；人设没显式选音色时用它，
   * 这样在商店里挑的音色才能真的影响朗读。 */
  function storeVoice() {
    try { return String(localStorage.getItem('hf_ttsVoice') || ''); } catch (e) { return ''; }
  }

  /* 实际会用的音色：人设优先，没选就跟随全局默认 */
  function effectiveVoice() {
    var own = (S && S.persona && S.persona.tts) ? S.persona.tts.voice : '';
    return own || storeVoice();
  }

  /* 选中的音色优先；没选就挑中文女声，再退回第一个中文 */
  function pickVoice() {
    var list = voiceList();
    if (!list.length) return null;
    var want = effectiveVoice();
    if (want) {
      var hit = list.filter(function (v) { return v.name === want || v.voiceURI === want; })[0];
      if (hit) return hit;
    }
    if (voiceCache) return voiceCache;
    var zh = list.filter(function (v) {
      return /zh|chinese|中文|普通话/i.test((v.lang || '') + ' ' + (v.name || ''));
    });
    voiceCache = zh.filter(function (v) {
      return /female|xiaoxiao|huihui|tingting|yaoyao|女/i.test(v.name || '');
    })[0] || zh[0] || null;
    return voiceCache;
  }

  /* 商店里的本地音色有五种启用值：piper:<目录 id>、kokoro:<sid>、
   * melo:zh_en、vits:theresa、zipvoice:clone。返回给朗读链路的结构要能直接变成 /tts/speak 的请求体。 */
  function localVoiceSpec() {
    var want = effectiveVoice();
    if (!want) return null;
    var api = ttsApi();
    if (api && typeof api.spec === 'function') {
      var spy = api.spec(want);
      if (!spy) return null;
      spy.label = api.label ? api.label(want) : want;
      return spy;
    }
    var s = String(want);
    var head = s.indexOf('piper:') === 0 ? 'piper'
      : (s.indexOf('kokoro:') === 0 ? 'kokoro'
        : (s.indexOf('melo:') === 0 ? 'melo'
          : (s.indexOf('vits:') === 0 ? 'vits'
            : (s.indexOf('zipvoice:') === 0 ? 'zipvoice'
              : (s.indexOf('param:') === 0 ? 'param'
                : (s.indexOf('sys:') === 0 ? 'sys' : ''))))));
    if (!head) return null;
    /* melo / vits / zipvoice 是单一份共享模型，启用值里没有可查的目录 id */
    if (head === 'melo') return { engine: 'melo', label: 'MeloTTS · 中英混读女声' };
    if (head === 'vits') return { engine: 'vits', label: 'VITS · 海星 · 俏皮甜美（近似）' };
    if (head === 'sys') return { engine: 'sys', label: '系统机械音 · SAPI' };
    if (head === 'zipvoice') return { engine: 'zipvoice', label: 'ZipVoice · 我的克隆声音' };
    if (head === 'param') return { engine: 'param', label: '参数合成 · 快问快答' };
    var item = (typeof catalogGet === 'function') ? catalogGet(s.slice(head.length + 1)) : null;
    if (!item) return null;
    if (item.engine === 'kokoro' && typeof item.sid === 'number') return { engine: 'kokoro', sid: item.sid, label: item.name };
    if (item.engine === 'piper' && item.voiceFile) return { engine: 'piper', voice: item.voiceFile, label: item.name };
    return null;
  }

  /* 音色下拉：系统语音全量 + 本地模型（未就绪的带后缀），与设置页同一份清单 */
  function renderVoiceOptions(snapshot) {
    var sel = S && S.refs.voiceSel;
    if (!sel) return;
    var api = ttsApi();
    var snap = snapshot || (api ? api.catalog() : null);
    var cur = effectiveVoice();
    var system = [];
    var local = [];
    if (snap) {
      system = snap.system || [];
      local = snap.local || [];
    } else {
      system = voiceList().map(function (v) {
        return { value: v.name, name: v.name, lang: v.lang || '' };
      });
    }

    sel.innerHTML = '';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = system.length ? '系统默认（自动挑中文音色）' : '系统默认（未检测到系统语音）';
    sel.appendChild(def);

    if (system.length) {
      var g1 = document.createElement('optgroup');
      g1.label = '系统语音';
      system.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.value;
        o.textContent = v.name + (v.lang ? ' · ' + v.lang : '');
        g1.appendChild(o);
      });
      sel.appendChild(g1);
    }

    if (local.length) {
      var g = document.createElement('optgroup');
      g.label = '本地模型';
      local.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.value;
        o.textContent = v.name + (v.ready ? '' : (v.needRef ? '（缺参考录音）' : '（未就绪）'));
        g.appendChild(o);
      });
      sel.appendChild(g);
    }

    /* 已存音色不在清单里（模型刚卸载 / 引擎还没探测到）也补一项，别让下拉悄悄退回系统默认 */
    var listed = system.some(function (v) { return v.value === cur; }) ||
      local.some(function (v) { return v.value === cur; });
    if (cur && !listed) {
      var keep = document.createElement('option');
      keep.value = cur;
      keep.textContent = (api ? api.label(cur) : cur) + '（未就绪）';
      sel.appendChild(keep);
    }

    sel.value = cur;
    if (sel.value !== cur) sel.value = '';
    sel.disabled = !system.length && !local.length;
    paintVoiceMeta(snap);
  }

  function paintAiCtrlBtns() {
    var r = S && S.refs;
    if (!r || !r.aiCtrl) return;
    var mode = aiCtrlMode();
    r.aiCtrl.querySelectorAll('[data-l2d-ai]').forEach(function (b) {
      var on = b.getAttribute('data-l2d-ai') === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* 引擎标签、音调可用性与状态行 */
  function paintVoiceMeta(snapshot) {
    var r = S && S.refs;
    if (!r) return;
    var api = ttsApi();
    var spec = api ? api.spec(effectiveVoice()) : localVoiceSpec();
    var isLocal = !!spec;
    if (r.voiceEngine) {
      r.voiceEngine.textContent = isLocal ? '本地模型' : '系统语音';
      r.voiceEngine.classList.toggle('is-local', isLocal);
    }
    /* AI 控制对所有支持韵律的本地音色都可用；系统语音与 ZipVoice 隐藏这一行 */
    if (r.aiCtrl) r.aiCtrl.classList.toggle('hidden', !prosodyEngine(spec));
    paintAiCtrlBtns();
    /* 参数合成的音调由运行时改波形，和系统语音一样可调；神经音色仍由权重决定 */
    var pitchOk = !isLocal || !!(spec && spec.engine === 'param');
    if (r.pitch) r.pitch.disabled = !pitchOk;
    if (r.pitchRow) {
      r.pitchRow.classList.toggle('is-off', !pitchOk);
      var lab = r.pitchRow.querySelector('span');
      if (lab) lab.textContent = pitchOk ? '音调' : '音调 · 仅系统语音';
    }
    paintVoiceStatus(snapshot);
    paintVoiceHint(snapshot);
  }

  function paintVoiceStatus(snapshot) {
    var el = S && S.refs && S.refs.voiceStatus;
    if (!el) return;
    var api = ttsApi();
    var snap = snapshot || (api ? api.catalog() : null);
    var sys = snap ? (snap.system || []).length : voiceList().length;
    var st = snap ? snap.status : null;
    var items = [{ label: '系统语音 ' + sys, on: sys > 0, title: '系统内置语音 ' + sys + ' 个' }];
    if (st) {
      items.push({ label: 'Piper', on: st.piper, title: st.piper ? 'Piper 就绪' : 'Piper 未安装' });
      items.push({ label: 'Kokoro', on: st.kokoro, title: st.kokoro ? 'Kokoro 就绪' : 'Kokoro 未安装' });
      items.push({ label: 'MeloTTS', on: st.melo, title: st.melo ? 'MeloTTS 就绪' : 'MeloTTS 未安装' });
      items.push({ label: '角色音色', on: st.vits, title: st.vits ? 'VITS 角色音色就绪' : 'VITS 角色音色未安装' });
      items.push({
        label: 'ZipVoice',
        on: !!(st.zipvoice && st.clone),
        title: st.zipvoice ? (st.clone ? 'ZipVoice 克隆声音就绪' : 'ZipVoice 缺参考录音') : 'ZipVoice 未安装'
      });
      items.push({
        label: '快速合成',
        on: !!st.param,
        title: st.param ? '参数音库已蒸馏，运行时不加载语音模型' : '参数音库未蒸馏：运行 node tools/distill-voice.js'
      });
    } else {
      items.push({ label: '本地模型需桌面端', on: false, title: '未连上桌面端，本地引擎状态未知' });
    }
    el.innerHTML = '';
    items.forEach(function (it) {
      var chip = document.createElement('span');
      chip.className = 'l2d-stat' + (it.on ? ' is-on' : ' is-off');
      chip.title = it.title || '';
      chip.appendChild(document.createElement('i'));
      chip.appendChild(document.createTextNode(it.label));
      el.appendChild(chip);
    });
    el.classList.toggle('is-err', !!(st && !st.probed));
  }

  function paintVoiceHint(snapshot) {
    var el = S && S.refs && S.refs.voiceHint;
    if (!el) return;
    var api = ttsApi();
    var own = (S && S.persona && S.persona.tts) ? S.persona.tts.voice : '';
    var cur = effectiveVoice();
    var spec = api ? api.spec(cur) : localVoiceSpec();
    var snap = snapshot || (api ? api.catalog() : null);
    var st = snap ? snap.status : null;
    var text;
    if (prosodyEngine(spec)) {
      var isParam = spec.engine === 'param';
      var extra = isParam ? '参数合成不加载大语音模型，由 LLM 的语速 / 停顿 / 音调 / 重音参数直接驱动波形。' : '';
      var ability = isParam ? '停顿、变速、音调与重音' : '停顿、变速与句尾拖音';
      text = aiCtrlMode() === 'ai'
        ? extra + 'AI 语音控制：模型按语义插入' + ability + '；标记只影响朗读，不会显示在气泡里。'
        : extra + '直接朗读：整句原样读出，不解析任何节奏标记。';
    } else if (spec) {
      if (spec.engine === 'zipvoice' && st && !st.clone) {
        text = 'ZipVoice 还缺参考录音：到「语音设置 → 声音克隆」录一段 5-15 秒清晰人声，在此之前会退回系统语音；该音色暂不支持 AI 节奏控制。';
      } else if (st && !st.probed) {
        text = '本地引擎状态未知：确认桌面端与运行时已启动，再点「检测」；该音色暂不支持 AI 节奏控制。';
      } else if (spec.engine === 'zipvoice') {
        text = '该音色暂不支持 AI 节奏控制；可在「语音设置」换成 Piper、Kokoro、MeloTTS 或角色音色。';
      } else {
        text = '本地模型按自身音色朗读，只有语速生效，音调已停用。';
      }
    } else if (!own && cur) {
      text = '未单独选择，跟随默认音色：' + (api ? api.label(cur) : cur) +
        '。系统语音不支持 AI 节奏控制，换成 Piper / Kokoro / MeloTTS / 角色音色即可。';
    } else if (!snap || !(snap.system || []).length) {
      text = '没有检测到系统语音：可在「语音设置 / 模型商店」下载本地模型，或安装系统语音包。';
    } else {
      text = '系统语音可调语速与音调，但不支持 AI 节奏控制；下载本地音色后即可启用。';
    }
    el.textContent = text;
  }

  /* force=true 时重新探测本地引擎（按钮 / 首次进角色页）；否则只按现有状态重画 */
  function refreshVoices(force) {
    var api = ttsApi();
    var r = S && S.refs;
    if (!api || !force) {
      renderVoiceOptions();
      return Promise.resolve();
    }
    if (r && r.voiceRefresh) r.voiceRefresh.disabled = true;
    if (r && r.voiceStatus) r.voiceStatus.textContent = '正在检测本地引擎…';
    return api.catalog({ refresh: true }).then(function (snap) {
      if (r && r.voiceRefresh) r.voiceRefresh.disabled = false;
      if (S) renderVoiceOptions(snap);
    }, function () {
      if (r && r.voiceRefresh) r.voiceRefresh.disabled = false;
      if (S) renderVoiceOptions();
    });
  }

  function openVoiceSettings() {
    var api = ttsApi();
    if (api && typeof api.openSettings === 'function') { api.openSettings(); return; }
    if (typeof window.openSettings === 'function') window.openSettings('tts');
  }

  function syncTtsLabels() {
    var r = S.refs;
    if (r.rateVal) r.rateVal.textContent = Number(S.persona.tts.rate).toFixed(2).replace(/0$/, '');
    if (r.pitchVal) r.pitchVal.textContent = Number(S.persona.tts.pitch).toFixed(2).replace(/0$/, '');
  }

  function syncTtsUI() {
    var r = S.refs;
    if (!r.rate) return;
    r.rate.value = S.persona.tts.rate;
    r.pitch.value = S.persona.tts.pitch;
    syncTtsLabels();
    renderVoiceOptions();
  }

  /* 滑块/下拉一变就写进人设并落盘，探针直接读 localStorage 校验 */
  function applyTtsForm() {
    var r = S.refs;
    if (!r.rate) return;
    S.persona.tts.rate = clamp(Number(r.rate.value) || 1.04, 0.7, 1.4);
    S.persona.tts.pitch = clamp(Number(r.pitch.value) || 1.12, 0.7, 1.5);
    S.persona.tts.voice = r.voiceSel ? r.voiceSel.value : '';
    syncTtsLabels();
    paintVoiceMeta();
    saveState();
  }

  function stopSpeech() {
    if (!S) return;
    S.rig.ttsUntil = 0;
    S.rig.speaking = false;
    if (S.rig.ttsAudio) {
      try { S.rig.ttsAudio.pause(); } catch (e) { /* 已结束 */ }
      S.rig.ttsAudio = null;
    }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 没有语音引擎 */ }
  }

  function speakSystem(clean) {
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      window.speechSynthesis.cancel();
      var tts = S.persona.tts || DEFAULT_PERSONA.tts;
      var rate = clamp(Number(tts.rate) || 1.04, 0.7, 1.4);
      var u = new SpeechSynthesisUtterance(clean);
      u.lang = 'zh-CN';
      u.rate = rate;
      u.pitch = clamp(Number(tts.pitch) || 1.12, 0.7, 1.5);
      var v = pickVoice();
      if (v) u.voice = v;

      /* 引擎不派发 onstart 时也要有嘴型：按字数估一个时间窗兜底 */
      S.rig.speaking = true;
      S.rig.ttsUntil = S.rig.t + Math.min(30, Math.max(1.4, clean.length / (5.4 * rate)));
      u.onstart = function () {
        if (S) S.rig.ttsUntil = Math.max(S.rig.ttsUntil, S.rig.t + 0.8);
      };
      /* 词边界比按字数切更贴合真实语速；没有 boundary 的引擎继续走字符节拍 */
      u.onboundary = function (ev) {
        if (!S) return;
        var len = (ev && ev.charLength) || 2;
        S.rig.mouthPulse = clamp(0.45 + len * 0.12 + Math.random() * 0.25, 0, 1);
        S.rig.pulseUntil = S.rig.t + 0.16;
        S.rig.ttsUntil = Math.max(S.rig.ttsUntil, S.rig.t + 0.6);
      };
      u.onend = function () {
        if (!S) return;
        S.rig.speaking = false;
        S.rig.ttsUntil = Math.min(S.rig.ttsUntil, S.rig.t + 0.25);
      };
      u.onerror = function () {
        if (S) { S.rig.speaking = false; S.rig.ttsUntil = 0; }
      };
      window.speechSynthesis.speak(u);
    } catch (e) { S.rig.speaking = false; }
  }

  /* 商店里下载的本地音色（Piper / Kokoro / MeloTTS / 角色音色 / ZipVoice）不在系统语音列表里：交给本地引擎桥合成 WAV 再播。
   * 引擎没起来（浏览器模式 / 被卸载）时退回系统语音，不让数字人整段静音。 */
  function speakLocal(clean, spec) {
    if (!spec || typeof fetch !== 'function' || typeof rtBase !== 'function' || typeof Audio !== 'function') return false;
    var base = rtBase();
    if (!base) return false;
    var tts = S.persona.tts || DEFAULT_PERSONA.tts;
    var rate = clamp(Number(tts.rate) || 1.04, 0.7, 1.4);
    var payload = { text: clean, engine: spec.engine, rate: rate };
    if (spec.engine === 'kokoro') payload.sid = spec.sid;
    else if (spec.engine === 'piper') payload.voice = spec.voice;
    else if (spec.engine === 'param') payload.pitch = clamp(Number(tts.pitch) || 1, 0.7, 1.5);

    S.rig.speaking = true;
    S.rig.ttsUntil = S.rig.t + Math.min(30, Math.max(1.4, clean.length / (5.4 * rate)));
    fetch(base + '/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
      }
      return r.blob();
    }).then(function (blob) {
      if (!S || !blob || !blob.size) throw new Error('没有返回音频');
      var obj = URL.createObjectURL(blob);
      var audio = new Audio(obj);
      S.rig.ttsAudio = audio;
      audio.onended = audio.onerror = function () {
        if (!S) return;
        S.rig.speaking = false;
        S.rig.ttsUntil = Math.min(S.rig.ttsUntil, S.rig.t + 0.25);
        S.rig.ttsAudio = null;
        try { URL.revokeObjectURL(obj); } catch (e) { /* 已释放 */ }
      };
      var p = audio.play();
      if (p && p.catch) p.catch(function () { if (S) S.rig.speaking = false; });
    }).catch(function () {
      if (S) S.rig.speaking = false;
      speakSystem(stripProsody(clean));
    });
    return true;
  }

  function speakAloud(text, force) {
    if (!S || (!S.voiceOn && !force) || !text) return;
    /* 保留 [[...]] 韵律标记给本地 TTS；只清掉旧的情绪标记与单层方括号 */
    var clean = String(text)
      .replace(/【[^】]*】/g, '')
      .replace(/(?<!\[)\[(?!\[)[^\]]*\](?!\])/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    var spec = localVoiceSpec();
    /* AI 控制关闭、系统语音或引擎不支持韵律时，先剥掉标记，免得被断句念出来 */
    if (!aiCtrlOn()) clean = stripProsody(clean);
    if (!clean) return;
    try {
      stopSpeech();
      if (spec && speakLocal(clean, spec)) return;
      speakSystem(stripProsody(clean));
    } catch (e) { S.rig.speaking = false; }
  }

  function testSpeak() {
    speakAloud('你好呀，我是' + (S.persona.name || '鲸鱼娘') + '，很高兴见到你。', true);
    toast('试听中…');
  }

  /* ---------- 长期记忆 ---------- */
  function memPrompt() {
    return [
      '你负责整理「数字人」与用户之间的长期记忆。',
      '把对话里关于用户的稳定信息压缩成一段不超过 120 字的中文备忘：称呼、喜好、近期状态、约定。',
      '不要编造，不要寒暄，不要列表，直接输出备忘正文。'
    ].join('\n');
  }

  function syncMemText() {
    var el = S && S.refs.memText;
    if (!el) return;
    var s = (S.mem && S.mem.summary) || '';
    el.textContent = s || '还没有整理过记忆。';
    el.classList.toggle('empty', !s);
  }

  function summarizeNow(manual) {
    if (!S || S.memBusy) return Promise.resolve(false);
    if (typeof llmStreamRequest !== 'function') {
      if (manual) toast('语言模型模块没有加载');
      return Promise.resolve(false);
    }
    var history = S.msgs.filter(function (m) { return m.r === 'u' || m.r === 'a'; })
      .slice(-40)
      .map(function (m) { return { role: m.r === 'u' ? 'user' : 'assistant', content: m.t }; });
    if (history.length < 2) {
      if (manual) toast('先聊两句，才有东西可记');
      return Promise.resolve(false);
    }

    S.memBusy = true;
    var count = S.msgs.length;
    return llmStreamRequest(memPrompt(), history, function () {}, { app: 'live2d', tag: 'memory' })
      .then(function (raw) {
        S.memBusy = false;
        var text = String(raw || '').replace(/[【】\[\]]/g, '').trim().slice(0, MEM_MAX);
        if (!text) {
          if (manual) toast('这次没整理出什么');
          return false;
        }
        S.mem = { summary: text, at: Date.now(), count: count };
        syncMemText();
        saveState();
        if (manual) toast('记忆已更新');
        return true;
      })
      .catch(function () {
        S.memBusy = false;
        if (manual) toast('整理失败，稍后再试');
        return false;
      });
  }

  function clearMemory() {
    if (!S) return;
    S.mem = { summary: '', at: 0, count: 0 };
    syncMemText();
    saveState();
    toast('记忆已清空');
  }

  /* 攒够一批新消息就顺手更新一次；失败不留痕，不打扰对话 */
  function maybeRemember() {
    if (!S || S.memBusy || !S.mem) return;
    if (S.msgs.length - (S.mem.count || 0) < MEM_EVERY) return;
    summarizeNow(false);
  }

  /* ---------- 导出 ---------- */
  function buildExport() {
    var lines = [];
    var d = new Date();
    lines.push('# 与' + (S.persona.name || '数字人') + '的对话');
    lines.push('');
    lines.push('- 导出时间：' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hhmm(d));
    lines.push('- 亲密度：' + Math.round(S.aff) + '/100（' + affLevel() + '）');
    lines.push('- 共 ' + S.msgs.length + ' 条');
    lines.push('');
    if (!S.msgs.length) {
      lines.push('_还没有对话。_');
      return lines.join('\n');
    }
    var lastDay = '';
    S.msgs.forEach(function (m) {
      var dt = new Date(m.ts || Date.now());
      var day = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
      if (day !== lastDay) {
        lastDay = day;
        lines.push('## ' + day);
        lines.push('');
      }
      var who = m.r === 'u' ? '你' : (m.r === 's' ? '系统' : (S.persona.name || '数字人'));
      lines.push('**' + who + '**（' + hhmm(dt) + '）：' + m.t);
      lines.push('');
    });
    return lines.join('\n');
  }

  function exportChat() {
    var text = buildExport();
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '数字人对话-' + new Date().toISOString().slice(0, 10) + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast('对话已导出');
    } catch (e) {
      toast('导出失败');
    }
  }

  /* ---------- 人设面板 ---------- */
  function fillPersonaForm() {
    var r = S.refs;
    r.fName.value = S.persona.name;
    r.fUser.value = S.persona.userCall;
    r.fPersona.value = S.persona.persona;
  }

  function applyPersonaUI() {
    if (!S) return;
    S.refs.name.textContent = S.persona.name;
    fillPersonaForm();
    syncTtsUI();
    syncMemText();
  }

  function savePersonaForm() {
    var r = S.refs;
    var name = r.fName.value.trim().slice(0, 12) || DEFAULT_PERSONA.name;
    S.persona.name = name;
    S.persona.userCall = r.fUser.value.trim().slice(0, 12) || DEFAULT_PERSONA.userCall;
    S.persona.persona = r.fPersona.value.trim().slice(0, 800) || DEFAULT_PERSONA.persona;
    S.persona.voice = S.voiceOn;
    saveState();
    applyPersonaUI();
    renderLog();
    toast('角色已保存');
  }

  function resetPersona() {
    S.persona = JSON.parse(JSON.stringify(DEFAULT_PERSONA));
    S.voiceOn = S.persona.voice;
    S.msgs = [];
    S.aff = 12;
    S.mem = { summary: '', at: 0, count: 0 };
    hideSay();
    applyPersonaUI();
    syncVoice();
    syncAff();
    renderLog();
    setEmotion('neutral');
    /* 皮套也回到清单里的第一个 */
    if (S.models.length && S.modelId !== S.models[0].id) {
      S.modelId = S.models[0].id;
      syncModelUI();
      disposeRig();
      loadRig();
    }
    saveState();
    toast('已恢复默认角色');
  }

  /* ---------- 提示条 ---------- */
  function toast(text) {
    if (!S) return;
    var el = S.body.querySelector('.l2d-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'l2d-toast';
      S.body.querySelector('.l2d-stage').appendChild(el);
    }
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { el.classList.remove('on'); }, 1800);
  }

  /* ---------- 口型 ---------- */
  function speechFeed(text) {
    if (!S || !text) return;
    S.rig.speakQ += String(text);
    if (S.rig.speakQ.length > 120) S.rig.speakQ = S.rig.speakQ.slice(-120);
  }

  function viseme(ch) {
    if (/[\s，。！？、,.!?…~～—：；]/.test(ch)) return 0;
    var table = [0.9, 0.55, 1.0, 0.4, 0.75, 0.5, 0.85];
    return table[ch.charCodeAt(0) % table.length];
  }

  /* ---------- 皮套加载 ---------- */
  /* 脚本只注入一次；缓存挂在 window 上，衣柜 App 复用同一套 pixi / Cubism 运行时 */
  var scriptCache = window.__L2D_SCRIPT_CACHE || (window.__L2D_SCRIPT_CACHE = {});
  function injectScript(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(el);
    });
    return scriptCache[src];
  }

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  /* 模型加载器中间件：只回答「settings 上挂了 __l2dPack」的请求。
     衣柜 App 也装了自己的中间件，两边按 settings 归属分流 ——
     不再用全局「当前包」，两个 App 同时开着换皮套也不会串包。 */
  function ensurePackHook() {
    var loader = window.PIXI.live2d.Live2DLoader;
    if (!loader || loader.__l2dPackHook) return;
    loader.__l2dPackHook = true;
    loader.middlewares.unshift(function (ctx, next) {
      var p = ctx.settings && ctx.settings.__l2dPack;
      if (!p) return next();
      var mocUrl = p.settings.FileReferences.Moc;
      if (ctx.type === 'arraybuffer' && ctx.url === mocUrl) {
        ctx.result = b64ToBuffer(p.moc);
        return;
      }
      var data = p.json[ctx.url];
      if (data) { ctx.result = data; return; }
      return next();
    });
  }

  function loadRig() {
    var st = S.rig;
    if (st.loading || st.ready) return;
    st.loading = true;
    var gen = ++st.gen;
    if (S.refs.rigErr) S.refs.rigErr.hidden = true;

    var chain = Promise.resolve();
    RIG_SCRIPTS.forEach(function (src) {
      chain = chain.then(function () { return injectScript(src); });
    });

    chain.then(function () {
      if (window.L2D_MODELS) return null;
      return injectScript(MODELS_SRC);
    }).then(function () {
      if (!window.PIXI || !window.PIXI.live2d) throw new Error('运行时未就绪');
      var models = (window.L2D_MODELS || []).filter(function (m) { return m && m.id && m.pack; });
      if (!models.length) throw new Error('没有可用的皮套：model/models.js 为空');
      S.models = models;

      var def = null;
      models.forEach(function (m) { if (m.id === S.modelId) def = m; });
      if (!def) { def = models[0]; S.modelId = def.id; }
      renderModels();

      return injectScript(def.pack).then(function () {
        if (st.gen !== gen) return;
        var pack = window.L2D_PACKS && window.L2D_PACKS[def.id];
        if (!pack) throw new Error('皮套数据包缺失：' + def.pack);
        return mountModel(def, pack, gen);
      });
    }).catch(function (err) {
      if (st.gen !== gen) return;
      st.loading = false;
      st.error = (err && err.message) || String(err);
      if (S.refs.rigLoading) S.refs.rigLoading.hidden = true;
      if (S.refs.rigErr) {
        S.refs.rigErr.hidden = false;
        var span = S.refs.rigErr.querySelector('span');
        if (span) span.textContent = st.error;
      }
    });
  }

  /* 把一份 pack 挂到舞台上；换皮套时先 disposeRig() 再调这里 */
  function mountModel(def, pack, gen) {
    var st = S.rig;
    ensurePackHook();

    /* 构造时就要求 url 是字符串；纹理换成 data: URL，避免 file:// 下 CORS 拦图 */
    var refs = Object.assign({}, pack.settings.FileReferences, { Textures: pack.textures });
    var json = Object.assign({}, pack.settings, {
      FileReferences: refs,
      url: new URL(def.dir, location.href).href
    });
    var settings = new window.PIXI.live2d.Cubism4ModelSettings(json);
    /* 中间件靠这个标记认领本模型的 moc / json */
    settings.__l2dPack = pack;

    var host = S.refs.canvas;
    var app = new window.PIXI.Application({
      transparent: true,
      antialias: true,
      autoStart: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      backgroundAlpha: 0
    });
    app.view.className = 'l2d-cvs';
    host.appendChild(app.view);

    return window.PIXI.live2d.Live2DModel.from(settings, { autoUpdate: false, autoInteract: false })
      .then(function (model) {
        /* 加载途中被换皮套 / 重置顶掉：丢掉这次结果，别往舞台上叠第二个模型 */
        if (st.gen !== gen) {
          try { app.destroy(true); } catch (e) { /* 已销毁 */ }
          return;
        }
        app.stage.addChild(model);
        st.app = app;
        st.model = model;

        /* 口型与嘴形在模型参数更新前写进去，表情/物理算完之后才不会被覆盖；
           顺手留一份参数快照，探针要读「本帧真实参与绘制的值」 */
        model.internalModel.on('beforeModelUpdate', function () {
          var cm = model.internalModel.coreModel;
          cm.setParameterValueById('ParamMouthOpenY', clamp(st.mouth, 0, 1));
          cm.setParameterValueById('ParamMouthForm', clamp(st.mouthForm, -1, 1));
          /* 衣柜里隐藏的部件：每帧压回 0，动作 / pose 把它拉起来也盖得住 */
          if (S.hiddenParts && S.hiddenParts.length) {
            for (var hi = 0; hi < S.hiddenParts.length; hi++) {
              cm.setPartOpacityById(S.hiddenParts[hi], 0);
            }
          }
          if (S.shownParts && S.shownParts.length) {
            for (var si = 0; si < S.shownParts.length; si++) {
              cm.setPartOpacityById(S.shownParts[si], 1);
            }
          }
          /* 衣柜的换装参数：写绝对值，压住动作 / pose 的覆盖 */
          if (S.outfitParams) {
            Object.keys(S.outfitParams).forEach(function (pid) {
              cm.setParameterValueById(pid, S.outfitParams[pid]);
            });
          }
          /* 说话时轻轻点头：叠加在模型自己算出的头部角度上 */
          if (Math.abs(st.nod) > 0.01) {
            var z = cm.getParameterValueById('ParamAngleZ') || 0;
            cm.setParameterValueById('ParamAngleZ', z + st.nod);
          }
          st.snap = {
            mouth: cm.getParameterValueById('ParamMouthOpenY'),
            mouthForm: cm.getParameterValueById('ParamMouthForm'),
            angleX: cm.getParameterValueById('ParamAngleX'),
            angleY: cm.getParameterValueById('ParamAngleY'),
            angleZ: cm.getParameterValueById('ParamAngleZ'),
            breath: cm.getParameterValueById('ParamBreath'),
            eyeL: cm.getParameterValueById('ParamEyeLOpen'),
            browL: cm.getParameterValueById('ParamBrowLForm')
          };
        });

        /* idle 组一般叫 Idle；本项目皮套注册成 idle，有就优先用 */
        var mm = model.internalModel.motionManager;
        if (mm && mm.definitions && mm.definitions.idle) mm.groups.idle = 'idle';

        st.ready = true;
        st.loading = false;
        if (S.refs.rigLoading) S.refs.rigLoading.hidden = true;
        fitRig();
        if (window.ResizeObserver) {
          st.ro = new ResizeObserver(function () { fitRig(); });
          st.ro.observe(host);
        }
        if (st.expr) setRigExpression(st.expr);
      });
  }

  /* 卸载当前皮套：销毁 PIXI 应用、断开尺寸监听，保留表情/口型等瞬时状态 */
  function disposeRig() {
    var st = S.rig;
    st.gen++;
    if (st.ro) { st.ro.disconnect(); st.ro = null; }
    if (st.app) {
      try { st.app.destroy(true, { children: true, texture: false }); }
      catch (e) { try { st.app.destroy(true); } catch (e2) { /* 已销毁 */ } }
    }
    if (S.refs.canvas) S.refs.canvas.innerHTML = '';
    st.app = null;
    st.model = null;
    st.snap = null;
    st.ready = false;
    st.loading = false;
    st.error = '';
    st.anchorX = 0;
    st.anchorY = 0;
    st.headTop = 0;
    if (S.refs.rigLoading) S.refs.rigLoading.hidden = false;
    if (S.refs.rigErr) S.refs.rigErr.hidden = true;
  }

  function renderModels() {
    var sel = S.refs.modelSel;
    if (!sel) return;
    sel.innerHTML = '';
    S.models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      sel.appendChild(o);
    });
    syncModelUI();
  }

  /* 皮套名字与版权跟着当前模型走 */
  function syncModelUI() {
    var sel = S.refs.modelSel;
    var def = null;
    S.models.forEach(function (m) { if (m.id === S.modelId) def = m; });
    if (sel && def && sel.value !== def.id) sel.value = def.id;
    if (!def) return;
    if (S.refs.creditName) S.refs.creditName.textContent = def.name + ' · ' + def.id;
    if (S.refs.creditAuthor) S.refs.creditAuthor.textContent = def.author || '';
    if (S.refs.creditLicense) S.refs.creditLicense.textContent = def.license || '';
  }

  function switchModel(id) {
    if (!id || id === S.modelId) return;
    var hit = null;
    S.models.forEach(function (m) { if (m.id === id) hit = m; });
    if (!hit || !S.rig.ready) { syncModelUI(); return; }
    S.modelId = id;
    /* 手动换皮套：上一条搭配的部件 / 参数 id 不再适用 */
    S.hiddenParts = [];
    S.shownParts = [];
    S.outfitParams = {};
    saveState();
    syncModelUI();
    hideSay();
    disposeRig();
    loadRig();
    toast('已换上皮套：' + (hit.name || hit.id));
  }

  /* 衣柜点「穿上」时调用：换皮套 + 隐藏部件 + 换装参数，数字人开着就即时生效 */
  function applyOutfit(outfit) {
    if (!S || !outfit) return false;
    S.hiddenParts = Array.isArray(outfit.hidden) ? outfit.hidden.filter(function (x) {
      return typeof x === 'string' && x;
    }).slice(0, 300) : [];
    S.shownParts = Array.isArray(outfit.shown) ? outfit.shown.filter(function (x) {
      return typeof x === 'string' && x;
    }).slice(0, 300) : [];
    var params = {};
    if (outfit.params && typeof outfit.params === 'object') {
      Object.keys(outfit.params).forEach(function (k) {
        var v = Number(outfit.params[k]);
        if (k && isFinite(v)) params[k] = v;
      });
    }
    S.outfitParams = params;
    var mid = typeof outfit.modelId === 'string' && outfit.modelId ? outfit.modelId : S.modelId;
    if (mid !== S.modelId) {
      S.modelId = mid;
      saveState();
      syncModelUI();
      hideSay();
      disposeRig();
      loadRig();
    }
    toast('已穿上：' + (outfit.name || '新套装'));
    return true;
  }

  function fitRig() {
    var st = S.rig;
    if (!st.ready || !st.app || !st.model) return;
    var host = S.refs.canvas;
    var w = host.clientWidth;
    var h = host.clientHeight;
    if (!w || !h) return;
    st.app.renderer.resize(w, h);

    /* internalModel 的宽高就是模型画布尺寸（未乘缩放），先量再缩放 */
    var bw = st.model.internalModel.width || st.model.width;
    var bh = st.model.internalModel.height || st.model.height;
    if (!bw || !bh) return;
    var s = Math.min(w / bw, h / bh) * RIG_FIT;
    st.model.scale.set(s);
    st.model.x = (w - bw * s) / 2;
    st.model.y = h - bh * s;

    /* 视线原点：皮套眼睛的位置（模型高度约 70% 处），供 onPointer 归一化 */
    st.anchorX = st.model.x + bw * s * 0.5;
    st.anchorY = h - bh * s * 0.70;
    /* 头顶位置，给舞台气泡框留位 */
    st.headTop = Math.max(40, st.anchorY - h * 0.17);
    fitSay();
  }

  /* ---------- 动画主循环 ---------- */
  function startLoop() {
    if (S.loopStarted) return;
    S.loopStarted = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!S || document.hidden) return;
    var st = S.rig;
    var dt = st.last ? Math.min(0.06, (now - st.last) / 1000) : 0.016;
    st.last = now;

    var win = S.win;
    if (!win || win.classList.contains('hidden') || !win.offsetWidth) return;

    /* 气泡到点自动收起；点击收起与发送前隐藏走 hideSay() */
    if (S.sayUntil && now > S.sayUntil) hideSay();

    st.t += dt;
    var t = st.t;

    /* 鼠标停下几秒后眼神自己飘一飘，别一直死盯着一个点 */
    if (now - st.lastPointerAt > 3200) {
      st.focusTX = Math.sin(t * 0.55) * 0.35;
      st.focusTY = Math.sin(t * 0.74 + 1.1) * 0.22;
    }
    st.focusX += (st.focusTX - st.focusX) * Math.min(1, dt * 5);
    st.focusY += (st.focusTY - st.focusY) * Math.min(1, dt * 5);

    /* 口型：流式文本按字切音节 */
    if (st.speakQ) {
      st.speakAcc += dt * 15.5;
      while (st.speakAcc >= 1 && st.speakQ.length) {
        st.speakAcc -= 1;
        var ch = st.speakQ.charAt(0);
        st.speakQ = st.speakQ.slice(1);
        st.mouthPulse = viseme(ch);
        st.pulseUntil = t + 0.12;
      }
    }
    var ttsOn = t < st.ttsUntil;
    if (ttsOn && t >= (st.ttsTick || 0)) {
      st.mouthPulse = 0.45 + Math.random() * 0.45;
      st.ttsTick = t + 0.12;
    }
    if (!ttsOn) st.ttsTick = 0;

    var mouthTarget = (t < st.pulseUntil || ttsOn) ? st.mouthPulse : 0;
    st.mouth += (mouthTarget - st.mouth) * Math.min(1, dt * 22);

    /* 嘴形：开心/害羞时嘴角上扬，难过/生气时向下 */
    var formTarget = (S.emo === 'happy' || S.emo === 'shy') ? 0.55
      : ((S.emo === 'sad' || S.emo === 'angry') ? -0.5 : 0.15);
    st.mouthForm += (formTarget - st.mouthForm) * Math.min(1, dt * 4);

    /* 说话时点头，停下后回正 */
    st.nod = (t < st.ttsUntil)
      ? Math.sin(t * 7.2) * 1.5
      : st.nod * Math.max(0, 1 - dt * 6);

    /* 呼吸、眨眼、物理、动作都由模型自己算，这里只喂视线与口型。
       ⚠ Live2DModel.update() 吃的是毫秒，不是秒 —— 传秒会让物理慢 1000 倍。 */
    if (st.ready && st.model) {
      var im = st.model.internalModel;
      if (im.focusController) im.focusController.focus(st.focusX, st.focusY);
      st.model.update(dt * 1000);
    }
  }

  /* ---------- 注册 ---------- */
  registerApp({
    id: 'live2d',
    name: '数字人',
    title: '数字人 · Live2D 对话',
    sub: '会眨眼、会看你、会跟着说话的数字人',
    icon: ICON,
    order: 16,
    cls: 'live2d',
    win: 'live2dWin',
    css: ['apps/live2d/app.css'],
    body: BODY_HTML,
    mount: function (body) {
      if (body.dataset.ready === '1' && S && S.body === body) {
        /* 切回来只同步数据，不重建 DOM：动画循环、聊天记录、输入框都保持原样 */
        syncAff();
        syncVoice();
        syncTabs();
        checkConn();
        return;
      }
      boot(body);
    }
  });
})();

/* ---- apps/maildesk/body.js ---- */
/* 邮箱台的窗口骨架。
 *
 * 这里只有**静态 DOM**，所有数据由 app.js 渲染。放在 body.js 是因为三栏界面
 * （信箱 / 收件箱 / 正文）的标签太多，塞进 app.js 会读不下去；
 * app-scan 会自动把这份文件排在 app.js 之前内联，不需要改 index.html。
 *
 * ⚠ 不是 App：这里没有 registerApp，只有 window.MAILDESK_BODY 字符串。 */
window.MAILDESK_BODY =
  '<div class="md-root">' +
    '<header class="md-head">' +
      '<div class="md-brand">' +
        '<span class="md-logo">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="5.4" width="18" height="13.2" rx="2.4"/><path d="m3.8 7.2 8.2 5.8 8.2-5.8"/></svg>' +
        '</span>' +
        '<div class="md-brand-text">' +
          '<div class="md-word">邮箱台<span class="md-tag">MAIL</span></div>' +
          '<div class="md-sub">批量申请临时信箱 · 集中收验证码与链接</div>' +
        '</div>' +
      '</div>' +
      '<div class="md-stats" aria-label="邮箱统计">' +
        '<div class="md-stat"><b id="mdStatBoxes">0</b><span>信箱</span></div>' +
        '<div class="md-stat is-accent"><b id="mdStatUnread">0</b><span>未读</span></div>' +
        '<div class="md-stat" id="mdStatIssuesWrap"><b id="mdStatIssues">0</b><span>异常</span></div>' +
      '</div>' +
      '<div class="md-head-right">' +
        '<div class="md-net" id="mdNet"><i></i><span>本地中转检测中</span></div>' +
        '<button type="button" class="md-btn md-ai-btn" id="mdAiToggle" title="打开 AI 邮箱管理助手">AI 助手</button>' +
      '</div>' +
    '</header>' +

    '<div class="md-bar">' +
      '<div class="md-group">' +
        '<label class="md-field">服务' +
          '<select id="mdProvider" title="信箱服务商">' +
            '<option value="mailtm">mail.tm</option>' +
            '<option value="guerrilla">Guerrilla</option>' +
            '<option value="mailgw">mail.gw</option>' +
            '<option value="demo">演示（离线）</option>' +
          '</select>' +
        '</label>' +
        '<label class="md-field">数量' +
          '<input type="number" id="mdCount" min="1" max="20" step="1" value="3" title="一次申请几个（1–20）">' +
        '</label>' +
        '<label class="md-field">前缀' +
          '<input type="text" id="mdPrefix" placeholder="留空随机，如 test" spellcheck="false" maxlength="12">' +
        '</label>' +
        '<button type="button" class="md-btn md-primary" id="mdCreate">批量申请</button>' +
      '</div>' +
      '<span class="md-div"></span>' +
      '<div class="md-group">' +
        '<label class="md-switch"><input type="checkbox" id="mdAuto"><span>自动收取</span></label>' +
        '<select class="md-sec" id="mdAutoSec" title="自动收取间隔">' +
          '<option value="15">15 秒</option>' +
          '<option value="30">30 秒</option>' +
          '<option value="60">60 秒</option>' +
          '<option value="120">2 分钟</option>' +
        '</select>' +
        '<button type="button" class="md-btn" id="mdSyncAll">全部刷新</button>' +
      '</div>' +
      '<div class="md-group md-group-end">' +
        '<button type="button" class="md-btn" id="mdImport" title="批量粘贴 地址----口令----client_id----refresh_token">导入</button>' +
        '<button type="button" class="md-btn" id="mdExport" title="导出 地址----口令（不含令牌）">导出</button>' +
      '</div>' +
    '</div>' +

    '<div class="md-main">' +
      '<aside class="md-side">' +
        '<div class="md-side-head">' +
          '<span class="md-side-title">信箱 <b id="mdBoxCount">0</b></span>' +
          '<span class="md-side-acts">' +
            '<button type="button" class="md-mini" id="mdAdd" title="手动登记一个已有邮箱">添加</button>' +
            '<button type="button" class="md-mini" id="mdCopyAll" title="把所有地址按行复制，方便逐个粘贴">复制地址</button>' +
          '</span>' +
        '</div>' +
        '<div class="md-filters" id="mdFilters">' +
          '<button type="button" data-filter="all" class="is-on">全部<b>0</b></button>' +
          '<button type="button" data-filter="unread">未读<b>0</b></button>' +
          '<button type="button" data-filter="pass">有口令<b>0</b></button>' +
          '<button type="button" data-filter="error">异常<b>0</b></button>' +
        '</div>' +
        '<div class="md-search-wrap">' +
          '<input type="search" id="mdSearch" placeholder="搜索地址" spellcheck="false">' +
        '</div>' +
        '<div class="md-add" id="mdAddPanel" hidden>' +
          '<input type="text" id="mdAddAddr" placeholder="name@example.com" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdAddPass" placeholder="口令（用于 IMAP 收信）" spellcheck="false" autocomplete="off">' +
          '<div class="md-add-acts">' +
            '<button type="button" class="md-mini" id="mdAddCancel">取消</button>' +
            '<button type="button" class="md-btn md-primary" id="mdAddSave">保存</button>' +
          '</div>' +
        '</div>' +
        '<div class="md-batch" id="mdBatch">' +
          '<label class="md-selall"><input type="checkbox" id="mdSelectAll"><span>全选</span></label>' +
          '<span class="md-batch-count" id="mdSelCount">未选择</span>' +
          '<span class="md-batch-acts">' +
            '<button type="button" class="md-mini" id="mdBatchRefresh" disabled>刷新</button>' +
            '<button type="button" class="md-mini" id="mdBatchCopy" disabled>复制</button>' +
            '<button type="button" class="md-mini md-danger" id="mdBatchRemove" disabled>移除</button>' +
          '</span>' +
        '</div>' +
        '<div class="md-boxes" id="mdBoxes"></div>' +
      '</aside>' +

      '<section class="md-inbox">' +
        '<div class="md-inbox-head">' +
          '<div class="md-inbox-id">' +
            '<div class="md-inbox-top">' +
              '<span class="md-inbox-addr" id="mdAddr" title="当前信箱">未选择信箱</span>' +
              '<span class="md-prov" id="mdProv" hidden></span>' +
            '</div>' +
            '<div class="md-inbox-pass" id="mdPassRow" hidden>' +
              '<span class="md-pass-k">凭证</span><b id="mdPass">—</b>' +
            '</div>' +
          '</div>' +
          '<div class="md-inbox-acts">' +
            '<button type="button" class="md-mini" id="mdCompose" disabled>写邮件</button>' +
            '<button type="button" class="md-mini" id="mdCred" disabled>凭证</button>' +
            '<button type="button" class="md-mini" id="mdCopyAddr" disabled>复制地址</button>' +
            '<button type="button" class="md-mini" id="mdCopyPass" disabled>复制口令</button>' +
            '<button type="button" class="md-mini" id="mdSyncOne" disabled>刷新</button>' +
            '<button type="button" class="md-mini md-danger" id="mdRemove" disabled>移除</button>' +
          '</div>' +
        '</div>' +
        '<div class="md-list-bar">' +
          '<span class="md-list-count" id="mdMsgCount">0 封</span>' +
          '<input type="search" id="mdMsgSearch" placeholder="搜索本信箱邮件" spellcheck="false" disabled>' +
        '</div>' +
        '<div class="md-msgs" id="mdMsgs"></div>' +
      '</section>' +

      '<article class="md-read" id="mdRead"></article>' +
    '</div>' +

    '<div class="md-ai" id="mdAi" hidden>' +
      '<div class="md-ai-head">' +
        '<span class="md-ai-title">AI 邮箱助手</span>' +
        '<span class="md-ai-note" id="mdAiNote">可汇总未读、检查凭证、刷新收信、代写信件</span>' +
        '<span class="md-ai-head-acts">' +
          '<button type="button" class="md-mini" id="mdAiClear">清空</button>' +
          '<button type="button" class="md-mini" id="mdAiClose">收起</button>' +
        '</span>' +
      '</div>' +
      '<div class="md-ai-log" id="mdAiLog"></div>' +
      '<div class="md-ai-quick">' +
        '<button type="button" class="md-mini" data-ai-q="汇总每个信箱的未读来信和验证码">汇总未读</button>' +
        '<button type="button" class="md-mini" data-ai-q="检查哪些信箱没有口令、没有 OAuth2 凭证或者收取失败">检查凭证</button>' +
        '<button type="button" class="md-mini" data-ai-q="我有卡密，怎么用令牌登录导入">卡密登录</button>' +
        '<button type="button" class="md-mini" data-ai-q="检查哪些信箱没有口令或者收取失败">检查异常</button>' +
        '<button type="button" class="md-mini" data-ai-q="列出没有来信且没有口令的空信箱，准备清理">找出空信箱</button>' +
        '<button type="button" class="md-mini" data-ai-q="按服务商统计一下现在的信箱数量和未读情况">服务商统计</button>' +
      '</div>' +
      '<div class="md-ai-input">' +
        '<textarea id="mdAiText" rows="2" spellcheck="false" ' +
          'placeholder="例：把没有口令的空信箱删掉；或者：我现在有哪些未读？"></textarea>' +
        '<button type="button" class="md-btn md-primary" id="mdAiSend">发送</button>' +
      '</div>' +
    '</div>' +

    '<div class="md-status">' +
      '<span id="mdStatus">就绪</span>' +
      '<span class="md-hint" id="mdHint">口令与 OAuth2 令牌只存本机，收发信经本地中转</span>' +
    '</div>' +

    '<div class="md-modal" id="mdImportModal" hidden>' +
      '<div class="md-modal-card" role="dialog" aria-modal="true" aria-label="批量导入信箱">' +
        '<div class="md-modal-head">' +
          '<b>批量导入信箱</b>' +
          '<span>每行一个：地址----口令----client_id----refresh_token</span>' +
        '</div>' +
        '<textarea id="mdImportText" spellcheck="false" ' +
          'placeholder="name@outlook.com----password----client-id----refresh-token&#10;other@example.com----password"></textarea>' +
        '<div class="md-modal-note">前两段是地址与口令，可选第三、四段为 OAuth2 的 client_id 与 refresh_token（Outlook 密码登录已关闭时必须用后者）；第 5 段起忽略。凭证只存本机，不随导出外泄。</div>' +
        '<div class="md-modal-acts">' +
          '<button type="button" class="md-mini" id="mdImportCancel">取消</button>' +
          '<button type="button" class="md-btn md-primary" id="mdImportSave">导入</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="md-modal" id="mdComposeModal" hidden>' +
      '<div class="md-modal-card" role="dialog" aria-modal="true" aria-label="写邮件">' +
        '<div class="md-modal-head">' +
          '<b>写邮件</b>' +
          '<span id="mdComposeFrom">未选择发件信箱</span>' +
        '</div>' +
        '<div class="md-form">' +
          '<input type="email" id="mdComposeTo" placeholder="收件人 name@example.com" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdComposeSubject" placeholder="主题" spellcheck="false" maxlength="200">' +
          '<textarea id="mdComposeBody" spellcheck="false" placeholder="正文（纯文本，最多 20KB）"></textarea>' +
        '</div>' +
        '<div class="md-modal-note">有口令或 OAuth2 凭证的手动邮箱可发信；邮件只经本机中转发送，不保存副本。</div>' +
        '<div class="md-modal-acts">' +
          '<button type="button" class="md-mini" id="mdComposeCancel">取消</button>' +
          '<button type="button" class="md-btn md-primary" id="mdComposeSend">发送</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="md-modal" id="mdCredModal" hidden>' +
      '<div class="md-modal-card" role="dialog" aria-modal="true" aria-label="更新凭证">' +
        '<div class="md-modal-head">' +
          '<b>更新凭证</b>' +
          '<span id="mdCredAddr">—</span>' +
        '</div>' +
        '<div class="md-form">' +
          '<input type="text" id="mdCredPass" placeholder="新口令（留空不修改）" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdCredClient" placeholder="OAuth2 client_id（可选）" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdCredToken" placeholder="OAuth2 refresh_token（可选）" spellcheck="false" autocomplete="off">' +
        '</div>' +
        '<div class="md-modal-note">留空表示不修改；OAuth2 两项需要同时填写。旧值不会回显，保存后立即用于 IMAP / SMTP。</div>' +
        '<div class="md-modal-note md-cred-msg" id="mdCredMsg" hidden></div>' +
        '<div class="md-modal-acts">' +
          '<button type="button" class="md-mini md-danger" id="mdCredClear">清除凭证</button>' +
          '<button type="button" class="md-mini" id="mdCredTest">测试令牌</button>' +
          '<span class="md-act-spacer"></span>' +
          '<button type="button" class="md-mini" id="mdCredCancel">取消</button>' +
          '<button type="button" class="md-btn md-primary" id="mdCredSave">保存</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';

/* ---- apps/maildesk/app.js ---- */
/* 邮箱台 —— 批量申请临时信箱，集中收取验证码与链接。
 *
 * 定位：注册、联调、演练时要「一次开好几个信箱，然后盯着它们收信」；
 * 浏览器里一个个开网页、记地址、翻验证码太碎，这里把三件事收进一个窗口：
 *   ① 批量申请（一次 1–20 个，服务商侧真实创建，不是本地占位）
 *   ② 集中收取（单箱刷新 / 全部刷新 / 定时自动收）
 *   ③ 读信（验证码与链接自动挑出来，点一下就复制）
 *
 * 服务商：mail.tm / mail.gw（同一套 REST 协议，互为备用）与「演示」（完全离线，
 * 用来试流程和跑无头探针 —— 默认测试不许碰真实网络）。
 *
 * 网络：页面跑在 file:// / app:// 下，直连第三方接口一定是 CORS 拒（origin: null），
 * 所以与 aisearch 一样借本地中转（relay）的 /proxy，用 X-Relay-Target 指定上游。
 * 中转没起来时只报「请求失败」，不会让人以为信箱服务坏了。
 *
 * ⚠ 三条硬约束（和别的 App 一样，见 apps/README.md）：
 *   ① 整个文件包在 IIFE 里；
 *   ② mount() 幂等：画过一次只刷新数据，不重建 DOM（否则用户正在读的信会被冲掉）；
 *   ③ 不碰 window.openagiDesktop，不读 llmKey。
 */
(function () {
  'use strict';

  const LS_KEY = 'hf_maildesk_v1';
  const DOMAIN_KEY = 'hf_maildesk_domains';
  const BODY = window.MAILDESK_BODY;
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.4"/>' +
    '<path d="m3.6 7.2 8.4 6 8.4-6"/><path d="M6.6 15.6h4.2"/></svg>';

  /* 演示服务不联网：信箱与来信都在本机生成，用来试流程与跑回归。 */
  const PROVIDERS = {
    mailtm: { label: 'mail.tm', base: 'https://api.mail.tm' },
    guerrilla: { label: 'Guerrilla', base: 'https://api.guerrillamail.com/ajax.php' },
    mailgw: { label: 'mail.gw', base: 'https://api.mail.gw' },
    demo: { label: '演示', base: '' },
    /* 手动登记：保存地址与口令，常见邮箱可通过本地中转走 IMAP 收信。 */
    manual: { label: '手动', base: '' }
  };

  /* 手动登记的邮箱按域名推断 IMAP 主机：地址与口令都在本机，收信时才发给本地中转。
   * 表里没有的域名只做地址/口令保管，不尝试收信。 */
  const IMAP_PRESETS = [
    { re: /@(outlook|hotmail|live|msn)\.com$/i, host: 'outlook.office365.com', port: 993 },
    { re: /@foxmail\.com$/i, host: 'imap.qq.com', port: 993 },
    { re: /@qq\.com$/i, host: 'imap.qq.com', port: 993 },
    { re: /@gmail\.com$/i, host: 'imap.gmail.com', port: 993 },
    { re: /@163\.com$/i, host: 'imap.163.com', port: 993 },
    { re: /@126\.com$/i, host: 'imap.126.com', port: 993 },
    { re: /@sina\.com$/i, host: 'imap.sina.com', port: 993 },
    { re: /@yahoo\.com$/i, host: 'imap.mail.yahoo.com', port: 993 },
    { re: /@(icloud|me)\.com$/i, host: 'imap.mail.me.com', port: 993 }
  ];

  function imapPreset(address) {
    const a = String(address || '');
    for (let i = 0; i < IMAP_PRESETS.length; i++) {
      if (IMAP_PRESETS[i].re.test(a)) return IMAP_PRESETS[i];
    }
    return null;
  }

  /* OAuth2 凭证：卡密里的 client_id + refresh_token。
   * 只存本机，不展示、不导出、不进模型上下文；刷新令牌由本地中转换取访问令牌。 */
  function hasOauth(b) {
    return !!(b && b.clientId && b.refreshToken);
  }

  /* 手动邮箱的 SMTP 发信主机：与 IMAP 表对应。
   * secure=true 用 465 直连 TLS，false 用 587 + STARTTLS。 */
  const SMTP_PRESETS = [
    { re: /@(outlook|hotmail|live|msn)\.com$/i, host: 'smtp.office365.com', port: 587, secure: false },
    { re: /@foxmail\.com$/i, host: 'smtp.qq.com', port: 465, secure: true },
    { re: /@qq\.com$/i, host: 'smtp.qq.com', port: 465, secure: true },
    { re: /@gmail\.com$/i, host: 'smtp.gmail.com', port: 465, secure: true },
    { re: /@163\.com$/i, host: 'smtp.163.com', port: 465, secure: true },
    { re: /@126\.com$/i, host: 'smtp.126.com', port: 465, secure: true },
    { re: /@sina\.com$/i, host: 'smtp.sina.com', port: 465, secure: true },
    { re: /@yahoo\.com$/i, host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    { re: /@(icloud|me)\.com$/i, host: 'smtp.mail.me.com', port: 587, secure: false }
  ];

  function smtpPreset(address) {
    const a = String(address || '');
    for (let i = 0; i < SMTP_PRESETS.length; i++) {
      if (SMTP_PRESETS[i].re.test(a)) return SMTP_PRESETS[i];
    }
    return null;
  }

  function canSend(b) {
    return !!b && b.provider === 'manual' && (!!b.password || hasOauth(b)) && !!smtpPreset(b.address);
  }

  function manualFetchable(b) {
    return !!b && b.provider === 'manual' && (!!b.password || hasOauth(b)) && !!imapPreset(b.address);
  }

  /* 地址前缀词表：只求「读得出来、看得出是测试号」，不做花哨命名。 */
  const WORDS = ['amber', 'brisk', 'coral', 'dusky', 'ember', 'frost', 'glide', 'hazel',
    'ivory', 'jade', 'lumen', 'maple', 'nimbus', 'onyx', 'pearl', 'quartz', 'raven',
    'sable', 'tide', 'umber', 'vivid', 'willow', 'xenon', 'yarrow', 'zephyr'];

  const DOMAIN_CACHE = { mailtm: { at: 0, list: [] }, mailgw: { at: 0, list: [] } };

  let S = loadState();
  let els = null;
  let busy = false;
  let timer = null;
  let saveTimer = null;
  /* 筛选 / 选中 / 邮件搜索都只活在本次打开期间，不写进 localStorage：
   * 这些是「看的时候的视角」，不是信箱数据。 */
  let FILTER = 'all';
  let MSGQ = '';
  let batchConfirm = false;
  let batchTimer = null;
  const SEL = new Set();

  /* ================= 基础工具 ================= */

  function now() { return Date.now(); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function msgOf(e) { return String((e && e.message) || e || '未知错误'); }

  function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function fmtAgo(ts) {
    if (!ts) return '从未';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    const diff = now() - d.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtFull(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function providerLabel(p) { return (PROVIDERS[p] && PROVIDERS[p].label) || p; }
  function baseOf(p) { return (PROVIDERS[p] && PROVIDERS[p].base) || ''; }

  /* ================= 状态 ================= */

  function blankState() {
    return {
      provider: 'mailtm', count: 3, prefix: '', auto: false, autoSec: 30,
      boxes: [], activeId: '', lastAutoAt: 0
    };
  }

  function normMessage(m) {
    const from = m && m.from && typeof m.from === 'object'
      ? { name: String(m.from.name || ''), address: String(m.from.address || '') }
      : null;
    return {
      id: String((m && m.id) || ''),
      subject: String((m && m.subject) || ''),
      intro: String((m && m.intro) || ''),
      from: from,
      seen: !!(m && m.seen),
      createdAt: String((m && m.createdAt) || ''),
      text: String((m && m.text) || '').slice(0, 4000),
      loaded: !!(m && m.loaded)
    };
  }

  function normBox(b) {
    return {
      id: String((b && b.id) || uid()),
      provider: PROVIDERS[b && b.provider] ? b.provider : 'mailtm',
      address: String((b && b.address) || ''),
      password: String((b && b.password) || ''),
      clientId: String((b && b.clientId) || ''),
      refreshToken: String((b && b.refreshToken) || ''),
      token: String((b && b.token) || ''),
      createdAt: Number(b && b.createdAt) || now(),
      lastSync: Number(b && b.lastSync) || 0,
      error: String((b && b.error) || ''),
      activeMsgId: String((b && b.activeMsgId) || ''),
      messages: Array.isArray(b && b.messages)
        ? b.messages.filter(function (m) { return m && m.id; }).slice(0, 20).map(normMessage)
        : []
    };
  }

  function loadState() {
    const st = blankState();
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return st;
    st.provider = PROVIDERS[raw.provider] ? raw.provider : 'mailtm';
    st.count = clamp(parseInt(raw.count, 10) || 3, 1, 20);
    st.prefix = String(raw.prefix || '').slice(0, 12);
    st.auto = !!raw.auto;
    st.autoSec = [15, 30, 60, 120].indexOf(Number(raw.autoSec)) >= 0 ? Number(raw.autoSec) : 30;
    st.boxes = Array.isArray(raw.boxes) ? raw.boxes.filter(function (b) { return b && b.address; }).map(normBox) : [];
    st.activeId = st.boxes.some(function (b) { return b.id === raw.activeId; }) ? raw.activeId : (st.boxes[0] ? st.boxes[0].id : '');
    return st;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          provider: S.provider, count: S.count, prefix: S.prefix,
          auto: S.auto, autoSec: S.autoSec, activeId: S.activeId,
          boxes: S.boxes.map(normBox)
        }));
      } catch (e) { /* 配额满就只留在内存里，不阻断收信 */ }
    }, 180);
  }

  function loadDomainCache() {
    try {
      const o = JSON.parse(localStorage.getItem(DOMAIN_KEY) || 'null');
      if (!o) return;
      Object.keys(DOMAIN_CACHE).forEach(function (k) {
        if (o[k] && Array.isArray(o[k].list) && o[k].list.length) DOMAIN_CACHE[k] = { at: Number(o[k].at) || 0, list: o[k].list };
      });
    } catch (e) { /* 缓存坏了就当没有 */ }
  }

  function saveDomainCache() {
    try { localStorage.setItem(DOMAIN_KEY, JSON.stringify(DOMAIN_CACHE)); } catch (e) { /* 忽略 */ }
  }

  /* ================= 网络 ================= */

  function relayBaseSafe() {
    try { if (typeof relayBase === 'function') return relayBase().replace(/\/+$/, ''); } catch (e) { /* 用默认 */ }
    return 'http://127.0.0.1:8787';
  }

  function relayEndpoint() { return relayBaseSafe() + '/proxy'; }
  function relayHealthUrl() { return relayBaseSafe() + '/health'; }
  function needRelay() {
    try { return /^(file|app|chrome-extension|moz-extension|edge):$/.test(location.protocol); }
    catch (e) { return false; }
  }

  function friendlyHttp(status, msg) {
    if (status === 429) return '服务限流，稍等 1 分钟再试';
    if (status === 401) return '登录态失效';
    if (status === 404) return '资源不存在（可能已被服务端清理）';
    if (status >= 500) return '服务端异常（HTTP ' + status + '）';
    return msg || ('HTTP ' + status);
  }

  function pickErr(data) {
    if (!data || typeof data !== 'object') return '';
    return String(data['hydra:description'] || data.detail || data.message || data.error || '');
  }

  /* 直连优先；file:// / app:// 下默认走本地中转。
   * Guerrilla 的接口带 Access-Control-Allow-Origin: *，传 preferDirect=true 时先直连，
   * 省掉对本地中转的依赖。真实 HTTP 错误（429/401/404）不再换通道重试。 */
  async function httpJson(url, opts, ms, preferDirect) {
    const init = Object.assign({ cache: 'no-store', redirect: 'follow' }, opts || {});
    const headers = Object.assign({ Accept: 'application/json' }, init.headers || {});
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 20000);
    const relay = relayEndpoint();
    const targets = (needRelay() && !preferDirect) ? [relay] : [url, relay];
    try {
      for (let i = 0; i < targets.length; i++) {
        const viaRelay = targets[i] === relay;
        const h = viaRelay ? Object.assign({}, headers, { 'X-Relay-Target': url }) : headers;
        let res;
        try {
          res = await fetch(targets[i], Object.assign({}, init, { headers: h, signal: ctl.signal }));
        } catch (e) {
          if (i + 1 < targets.length) continue;
          if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round((ms || 20000) / 1000) + ' 秒）');
          throw new Error('请求失败：接口不可达或本地中转未启动');
        }
        const raw = await res.text().catch(function () { return ''; });
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
          const err = new Error(friendlyHttp(res.status, pickErr(data)));
          err.http = res.status;
          throw err;
        }
        return data;
      }
      throw new Error('请求失败');
    } finally {
      clearTimeout(timerId);
    }
  }

  function hydraList(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d['hydra:member'] || d.member || d.items || [];
  }

  /* 手动邮箱收信：地址与口令（或 OAuth2 凭证）只发给本机中转的 /mail/imap，
   * 由它代连 IMAP。中转必须在本机运行；这里不把凭证写进任何日志或提示。
   * 超时给 70 秒：OAuth2 换令牌 + IMAP 收信各有一段独立预算。 */
  async function relayMailFetch(payload, ms) {
    const url = relayBaseSafe() + '/mail/imap';
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 70000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      const raw = await res.text().catch(function () { return ''; });
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || ('本地中转 HTTP ' + res.status));
      }
      if (!data || data.ok !== true) {
        throw new Error((data && data.error) || '本地中转没有返回邮件');
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('收信超时（' + Math.round((ms || 70000) / 1000) + ' 秒）');
      }
      if (e && e.name === 'TypeError') {
        throw new Error('本地中转未启动或不可达：手动邮箱收信需要本地中转');
      }
      throw e;
    } finally {
      clearTimeout(timerId);
    }
  }

  /* 发信：凭证与正文只发给本机中转的 /mail/smtp，由它代连 SMTP。 */
  async function relayMailSend(payload, ms) {
    const url = relayBaseSafe() + '/mail/smtp';
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 70000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      const raw = await res.text().catch(function () { return ''; });
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && (data.error || data.message)) || ('本地中转 HTTP ' + res.status));
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('发信超时（' + Math.round((ms || 70000) / 1000) + ' 秒）');
      }
      if (e && e.name === 'TypeError') {
        throw new Error('本地中转未启动或不可达：手动邮箱发信需要本地中转');
      }
      throw e;
    } finally {
      clearTimeout(timerId);
    }
  }

  /* 令牌体检：只换 access_token 并读权限，不发信、不收信、不返回令牌。 */
  async function relayOauthCheck(payload, ms) {
    const url = relayBaseSafe() + '/mail/oauth/check';
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 30000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      const raw = await res.text().catch(function () { return ''; });
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      if (!data || typeof data !== 'object') throw new Error('本地中转返回了无法识别的内容');
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('令牌校验超时（30 秒）');
      if (e && e.name === 'TypeError') throw new Error('本地中转未启动或不可达');
      throw e;
    } finally {
      clearTimeout(timerId);
    }
  }

  async function loadDomains(provider, force) {
    const c = DOMAIN_CACHE[provider];
    if (!force && c.list.length && now() - c.at < 10 * 60 * 1000) return c.list;
    const d = await httpJson(baseOf(provider) + '/domains', {}, 15000);
    const list = hydraList(d)
      .filter(function (x) { return x && x.domain && x.isActive !== false; })
      .map(function (x) { return x.domain; });
    if (!list.length) throw new Error('服务端没有返回可用域名，稍后再试');
    c.list = list;
    c.at = now();
    saveDomainCache();
    return list;
  }

  async function mtLogin(provider, address, password) {
    const tok = await httpJson(baseOf(provider) + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, password: password })
    }, 20000);
    if (!tok || !tok.token) throw new Error('登录令牌获取失败');
    return tok.token;
  }

  async function mtCreateAccount(provider, address, password) {
    await httpJson(baseOf(provider) + '/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, password: password })
    }, 20000);
    return mtLogin(provider, address, password);
  }

  /* 令牌过期（401）时用本地保存的口令重登一次；口令是申请时自己生成的，只存本机。 */
  async function withRelogin(box, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.http !== 401 || !box.password) throw e;
      box.token = await mtLogin(box.provider, box.address, box.password);
      return fn();
    }
  }

  function listMessages(box) {
    return withRelogin(box, function () {
      return httpJson(baseOf(box.provider) + '/messages?page=1', {
        headers: { Authorization: 'Bearer ' + box.token }
      }, 20000);
    }).then(hydraList);
  }

  function readMessage(box, id) {
    return withRelogin(box, function () {
      return httpJson(baseOf(box.provider) + '/messages/' + encodeURIComponent(id), {
        headers: { Authorization: 'Bearer ' + box.token }
      }, 20000);
    });
  }

  function markSeen(box, id) {
    if (box.provider === 'demo' || box.provider === 'guerrilla') return;
    httpJson(baseOf(box.provider) + '/messages/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + box.token,
        'Content-Type': 'application/merge-patch+json'
      },
      body: JSON.stringify({ seen: true })
    }, 12000).catch(function () { /* 标记已读失败不影响本地显示 */ });
  }

  /* ---- Guerrilla Mail ----
   * 无需账号：一次 get_email_address 就是一个独立会话（sid_token 代替口令），
   * set_email_user 可以把本地部分改成自己的前缀；读信用 fetch_email。
   * 注意：每个新会话自带一封官方欢迎信，列表里过滤掉，不占用未读数。 */
  function gUrl(qs) {
    return baseOf('guerrilla') + '?' + qs + '&lang=en&site=guerrillamail.com&agent=maildesk';
  }

  async function guerrillaCreate(prefix) {
    const a = await httpJson(gUrl('f=get_email_address'), {}, 20000, true);
    if (!a || !a.email_addr || !a.sid_token) throw new Error('没能拿到临时地址（服务可能限流）');
    const sid = String(a.sid_token);
    let address = String(a.email_addr);
    if (prefix) {
      const local = prefix + String(Math.floor(1000 + Math.random() * 9000));
      try {
        const s = await httpJson(gUrl('f=set_email_user&email_user=' + encodeURIComponent(local) +
          '&sid_token=' + encodeURIComponent(sid)), {}, 20000, true);
        if (s && s.email_addr && !s.alias_error) address = String(s.email_addr);
      } catch (e) { /* 前缀没改成就用随机地址，不影响收信 */ }
    }
    return { address: address, sid: sid };
  }

  async function guerrillaList(box) {
    const d = await httpJson(gUrl('f=get_email_list&offset=0&sid_token=' + encodeURIComponent(box.token)), {}, 20000, true);
    if (!d) return [];
    if (Array.isArray(d.list)) return d.list;
    if (d.error) throw new Error(String(d.error));
    return [];
  }

  async function guerrillaRead(box, id) {
    const d = await httpJson(gUrl('f=fetch_email&email_id=' + encodeURIComponent(id) +
      '&sid_token=' + encodeURIComponent(box.token)), {}, 25000, true);
    if (!d || d.mail_body == null) throw new Error('没取到正文（会话可能已过期）');
    return {
      subject: String(d.mail_subject || ''),
      from: parseFrom(d.mail_from),
      text: htmlToText(d.mail_body)
    };
  }

  /* ================= 解析邮件内容 ================= */

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, function (_, d) { try { return String.fromCharCode(Number(d)); } catch (e) { return ''; } })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ''; } })
      .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  }

  function htmlToText(html) {
    return decodeEntities(String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textOf(detail) {
    if (detail && detail.text && String(detail.text).trim()) return String(detail.text);
    const html = Array.isArray(detail && detail.html) ? detail.html.join('\n') : ((detail && detail.html) || '');
    return htmlToText(html);
  }

  /* 验证码：先找「验证码 / code / OTP」附近的 4–8 位数字，再兜底裸 6 位数字。
   * 只认数字 —— 带字母的码各站格式千奇百怪，硬猜会把订单号当验证码。 */
  function extractCodes(raw) {
    const s = String(raw || '');
    const out = [];
    const push = function (v) {
      const c = String(v || '').trim();
      if (c && out.indexOf(c) < 0) out.push(c);
    };
    const near = /(?:验证码|校验码|动态码|确认码|verification\s*code|verify\s*code|one[-\s]?time\s*code|\bcode\b|\bOTP\b|\bPIN\b)[^0-9]{0,20}([0-9]{4,8})/gi;
    let m;
    while ((m = near.exec(s)) && out.length < 4) push(m[1]);
    const bare = /(^|[^0-9])([0-9]{6})(?![0-9])/g;
    while ((m = bare.exec(s)) && out.length < 4) push(m[2]);
    return out.slice(0, 4);
  }

  function extractLinks(raw) {
    const out = [];
    const re = /https?:\/\/[^\s<>"'）)，。、]+/g;
    let m;
    while ((m = re.exec(String(raw || ''))) && out.length < 6) {
      const u = m[0].replace(/[.,;:!?\]}]+$/, '');
      if (out.indexOf(u) < 0) out.push(u);
    }
    return out;
  }

  function fromText(from) {
    if (!from) return '未知发件人';
    if (from.name && from.address) return from.name + ' <' + from.address + '>';
    return from.name || from.address || '未知发件人';
  }

  /* Guerrilla 的 mail_from 常是 "Name <addr>" 一整串，统一拆成结构。 */
  function parseFrom(s) {
    const str = String(s || '').trim();
    const m = str.match(/^(.*?)<([^>]+)>$/);
    if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() };
    return { name: '', address: str };
  }

  function isGuerrillaWelcome(x) {
    return /guerrillamail/i.test(String(x.mail_from || '')) &&
      /^welcome to guerrilla mail/i.test(String(x.mail_subject || ''));
  }

  /* ================= 演示服务 ================= */

  function randLocal() {
    return WORDS[Math.floor(Math.random() * WORDS.length)] + String(Math.floor(1000 + Math.random() * 9000));
  }

  function randPassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 14; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function demoSeed(address) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    return [{
      id: ('demo-' + uid()),
      from: { name: '邮箱台演示', address: 'noreply@demo.maildesk' },
      subject: '欢迎使用邮箱台 · 验证码 ' + code,
      intro: '这是一封演示来信，用来验证收信列表、验证码识别与复制流程。',
      seen: false,
      createdAt: new Date().toISOString(),
      text: '你好：\n\n这是演示信箱 ' + address + ' 收到的示例邮件，不会真的走网络。\n\n' +
        '你的验证码是 ' + code + '，5 分钟内有效。\n\n' +
        '如需走完整个流程，可以打开 https://example.com/verify?code=' + code + ' 查看效果。\n\n' +
        '— 邮箱台演示服务',
      loaded: true
    }];
  }

  function addDemoBox() {
    let address = '';
    for (let i = 0; i < 5; i++) {
      const a = randLocal() + '@demo.maildesk';
      if (!S.boxes.some(function (b) { return b.address === a; })) { address = a; break; }
    }
    if (!address) address = 'demo' + uid() + '@demo.maildesk';
    const box = {
      id: uid(), provider: 'demo', address: address, password: '', token: '',
      createdAt: now(), lastSync: now(), error: '', activeMsgId: '', messages: demoSeed(address)
    };
    box.activeMsgId = box.messages[0] ? box.messages[0].id : '';
    S.boxes.unshift(box);
    S.activeId = box.id;
    return box;
  }

  /* ================= 业务：申请 / 收取 / 读信 ================= */

  function activeBox() {
    for (let i = 0; i < S.boxes.length; i++) if (S.boxes[i].id === S.activeId) return S.boxes[i];
    return null;
  }

  function unreadOf(b) {
    return b.messages.filter(function (m) { return !m.seen; }).length;
  }

  function selectedBoxes() {
    return S.boxes.filter(function (b) { return SEL.has(b.id); });
  }

  function activeMsg() {
    const b = activeBox();
    if (!b || !b.activeMsgId) return null;
    for (let i = 0; i < b.messages.length; i++) {
      if (b.messages[i].id === b.activeMsgId) return b.messages[i];
    }
    return null;
  }

  /* 选中集合只保留仍存在的信箱，避免筛选 / 移除后留下幽灵 id。 */
  function pruneSelection() {
    const live = new Set(S.boxes.map(function (b) { return b.id; }));
    Array.from(SEL).forEach(function (id) { if (!live.has(id)) SEL.delete(id); });
  }

  function toggleSel(id, on) {
    if (on) SEL.add(id); else SEL.delete(id);
    resetBatchConfirm();
    renderBoxes();
  }

  function boxVisible(b) {
    if (FILTER === 'unread' && !unreadOf(b)) return false;
    if (FILTER === 'pass' && !b.password && !hasOauth(b)) return false;
    if (FILTER === 'error' && !b.error) return false;
    const q = String(els && els.search ? els.search.value : '').trim().toLowerCase();
    return !q || b.address.toLowerCase().indexOf(q) >= 0;
  }

  function exportText(list) {
    return list.map(function (b) {
      return b.address + (b.password ? '----' + b.password : '');
    }).join('\n');
  }

  /* 导入识别两种写法：
   *   ① 卡密四段：address----password----client_id----refresh_token（第 5 段起忽略）
   *   ② 老格式：地址 + 空格/制表符 + 口令
   * 令牌类字段只存本机：不展示、不写日志、不进模型上下文，也不随导出外泄。 */
  function clipLen(s, n) {
    const t = String(s == null ? '' : s).trim();
    return t.length > n ? t.slice(0, n) : t;
  }

  function parseImport(text) {
    const out = [];
    const bad = [];
    const seen = {};
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
      const line = raw.trim();
      if (!line || /^(#|\/\/)/.test(line)) return;
      const m = line.match(/[a-z0-9._%+-]+@[a-z0-9]+(?:[.-][a-z0-9]+)+/i);
      if (!m) { bad.push(line); return; }
      const address = m[0].toLowerCase();
      const rest = line.slice(line.indexOf(m[0]) + m[0].length).replace(/^[>\s]+/, '');
      const segs = rest.split(/\s*(?:----|\t|,|;|\|)\s*/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s; });
      if (seen[address]) return;
      seen[address] = true;
      out.push({
        address: address,
        password: clipLen(segs[0], 80),
        clientId: clipLen(segs[1], 120),
        refreshToken: clipLen(segs[2], 4096)
      });
    });
    return { list: out, bad: bad };
  }

  function importBoxes(text) {
    const r = parseImport(text);
    let added = 0;
    let updated = 0;
    let dup = 0;
    r.list.forEach(function (x) {
      const exist = S.boxes.filter(function (b) {
        return b.provider === 'manual' && b.address.toLowerCase() === x.address;
      })[0];
      if (exist) {
        let changed = false;
        if (x.password && x.password !== exist.password) { exist.password = x.password; changed = true; }
        if (x.clientId && x.clientId !== exist.clientId) { exist.clientId = x.clientId; changed = true; }
        if (x.refreshToken && x.refreshToken !== exist.refreshToken) { exist.refreshToken = x.refreshToken; changed = true; }
        if (changed) {
          exist.error = '';
          save();
          updated++;
        } else {
          dup++;
        }
        return;
      }
      const res = addManualBox(x.address, x.password, x.clientId, x.refreshToken);
      if (res.error) dup++;
      else added++;
    });
    return { added: added, updated: updated, dup: dup, bad: r.bad.length };
  }

  function downloadText(name, text) {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }, 1200);
      return true;
    } catch (e) {
      return false;
    }
  }

  function resetBatchConfirm() {
    batchConfirm = false;
    clearTimeout(batchTimer);
    if (els && els.batchRemove) {
      els.batchRemove.textContent = '移除';
      els.batchRemove.classList.remove('is-confirm');
    }
  }

  function mergeMessages(box, incoming) {
    const old = {};
    box.messages.forEach(function (m) { old[m.id] = m; });
    const out = incoming.map(function (x) {
      const prev = old[x.id] || {};
      return normMessage({
        id: x.id,
        from: x.from || prev.from || null,
        subject: x.subject || prev.subject || '',
        intro: x.intro || prev.intro || '',
        seen: prev.seen === true || x.seen === true,
        createdAt: x.createdAt || prev.createdAt || '',
        text: x.text || prev.text || '',
        loaded: x.loaded === true || prev.loaded === true
      });
    });
    out.sort(function (a, b) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    box.messages = out.slice(0, 20);
    if (box.activeMsgId && !box.messages.some(function (m) { return m.id === box.activeMsgId; })) {
      box.activeMsgId = '';
    }
  }

  /* mail.tm / mail.gw 的 hydra 摘要 → 统一消息结构 */
  function mergeSummaries(box, list) {
    mergeMessages(box, list.map(function (x) {
      return {
        id: x.id,
        from: x.from,
        subject: x.subject,
        intro: x.intro,
        seen: x.seen === true,
        createdAt: x.createdAt
      };
    }));
  }

  /* Guerrilla 的邮件摘要 → 统一消息结构（mail_timestamp 是秒） */
  function mergeGuerrilla(box, list) {
    mergeMessages(box, list.filter(function (x) { return !isGuerrillaWelcome(x); }).map(function (x) {
      return {
        id: String(x.mail_id),
        from: parseFrom(x.mail_from),
        subject: String(x.mail_subject || ''),
        intro: String(x.mail_excerpt || ''),
        seen: Number(x.mail_read) === 1,
        createdAt: x.mail_timestamp ? new Date(Number(x.mail_timestamp) * 1000).toISOString() : ''
      };
    }));
  }

  /* 手动邮箱走 IMAP：只读最近 8 封，不删除、不改服务端已读状态。
   * 有 client_id + refresh_token 就走 OAuth2（XOAUTH2），否则用口令登录。 */
  async function syncManual(box) {
    const preset = imapPreset(box.address);
    if (!preset) throw new Error('这个域名还没有内置 IMAP 收信配置');
    const oauth = hasOauth(box);
    if (!box.password && !oauth) throw new Error('没有口令或 OAuth2 令牌，无法登录收信');
    setStatus('正在通过 IMAP' + (oauth ? '（OAuth2）' : '') + '收取 ' + box.address + '…');
    const payload = {
      address: box.address,
      host: preset.host,
      port: preset.port,
      secure: true,
      limit: 8
    };
    if (oauth) {
      payload.clientId = box.clientId;
      payload.refreshToken = box.refreshToken;
    } else {
      payload.password = box.password;
    }
    const data = await relayMailFetch(payload);
    mergeMessages(box, Array.isArray(data.messages) ? data.messages : []);
    box.lastSync = now();
    box.error = '';
    save();
  }

  /* 发信：凭证与正文只发给本机中转，不保存副本、不写已发送列表。 */
  async function sendMail(box, to, subject, body) {
    if (!canSend(box)) {
      throw new Error('这个信箱没有可用的发信凭证（需要口令或 OAuth2 令牌，且域名在发信列表里）');
    }
    const preset = smtpPreset(box.address);
    const target = String(to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) throw new Error('收件人地址不正确');
    const text = String(body || '');
    if (!text.trim()) throw new Error('正文不能为空');
    const payload = {
      address: box.address,
      to: target,
      subject: String(subject || '').trim().slice(0, 200),
      body: text.slice(0, 20 * 1024),
      host: preset.host,
      port: preset.port,
      secure: preset.secure
    };
    const oauth = hasOauth(box);
    if (oauth) {
      payload.clientId = box.clientId;
      payload.refreshToken = box.refreshToken;
    } else {
      payload.password = box.password;
    }
    setStatus('正在通过 SMTP' + (oauth ? '（OAuth2）' : '') + ' 发送到 ' + target + '…');
    await relayMailSend(payload);
    box.error = '';
    save();
  }

  /* 凭证工具：按字段更新当前手动邮箱，留空表示保留旧值；旧值不回显。 */
  function applyCredential(box, password, clientId, refreshToken) {
    if (!box || box.provider !== 'manual') return { error: '只有手动邮箱可以更新凭证' };
    const pass = clipLen(password, 80);
    const cid = clipLen(clientId, 120);
    const rt = clipLen(refreshToken, 4096);
    if (!pass && !cid && !rt) return { error: '三项都为空，没有可保存的内容' };
    if ((cid && !rt) || (!cid && rt)) return { error: 'OAuth2 需要同时填写 client_id 与 refresh_token' };
    if (pass) box.password = pass;
    if (cid && rt) {
      box.clientId = cid;
      box.refreshToken = rt;
    }
    box.error = '';
    save();
    return { ok: true };
  }

  function clearCredential(box) {
    if (!box) return { error: '没有选中的信箱' };
    box.password = '';
    box.clientId = '';
    box.refreshToken = '';
    box.error = '';
    save();
    return { ok: true };
  }

  async function syncBox(box) {
    if (box.provider === 'demo') {
      box.lastSync = now();
      box.error = '';
      return;
    }
    if (box.provider === 'manual') {
      await syncManual(box);
      return;
    }
    if (box.provider === 'guerrilla') {
      mergeGuerrilla(box, await guerrillaList(box));
    } else {
      mergeSummaries(box, await listMessages(box));
    }
    box.lastSync = now();
    box.error = '';
    save();
  }

  async function syncAll(silent) {
    if (busy) return;
    const list = S.boxes.filter(function (b) {
      return b.provider === 'mailtm' || b.provider === 'mailgw' ||
        b.provider === 'guerrilla' || manualFetchable(b);
    });
    if (!list.length) {
      if (!silent) setStatus(S.boxes.length ? '当前没有可收信的信箱（手动邮箱需要口令或 OAuth2 令牌，且域名在收信列表里）' : '还没有信箱，先批量申请');
      return;
    }
    busy = true;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let lastErr = '';
    for (let i = 0; i < list.length; i++) {
      setStatus('正在收取 ' + (i + 1) + ' / ' + list.length + '：' + list[i].address);
      try {
        await syncBox(list[i]);
        ok++;
      } catch (e) {
        fail++;
        lastErr = msgOf(e);
        list[i].error = lastErr;
      }
      renderBoxes();
      renderMsgs();
    }
    busy = false;
    setBusy(false);
    save();
    setStatus('收取完成：' + ok + ' 个成功' + (fail ? '，' + fail + ' 个失败（' + lastErr + '）' : ''),
      fail ? 'err' : 'ok');
  }

  async function createBatch() {
    if (busy) return;
    const provider = S.provider;
    const n = clamp(parseInt(els.count.value, 10) || 1, 1, 20);
    const prefix = String(els.prefix.value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    S.count = n;
    S.prefix = prefix;
    save();

    busy = true;
    setBusy(true);
    try {
      if (provider === 'demo') {
        for (let i = 0; i < n; i++) addDemoBox();
        renderAll();
        save();
        setStatus('已创建 ' + n + ' 个演示信箱（离线模拟，不会真的收信）', 'ok');
        return;
      }

      /* Guerrilla 不需要账号体系：一个会话就是一份信箱，创建更轻。 */
      if (provider === 'guerrilla') {
        const madeG = [];
        let failG = 0;
        let lastErrG = '';
        for (let i = 0; i < n; i++) {
          setStatus('正在申请 ' + (i + 1) + ' / ' + n + ' 个 Guerrilla 信箱…');
          try {
            const r = await guerrillaCreate(prefix);
            const box = {
              id: uid(), provider: 'guerrilla', address: r.address, password: '', token: r.sid,
              createdAt: now(), lastSync: 0, error: '', activeMsgId: '', messages: []
            };
            S.boxes.unshift(box);
            S.activeId = box.id;
            madeG.push(box);
            save();
            renderAll();
          } catch (e) {
            failG++;
            lastErrG = msgOf(e);
          }
          if (i < n - 1) await sleep(900);
        }
        for (let i = 0; i < madeG.length; i++) {
          try { await syncBox(madeG[i]); } catch (e) { madeG[i].error = msgOf(e); }
        }
        renderAll();
        save();
        setStatus('申请完成：' + madeG.length + ' 个成功' + (failG ? '，' + failG + ' 个失败（' + lastErrG + '）' : ''),
          failG ? 'err' : 'ok');
        return;
      }

      setStatus('正在获取可用域名…');
      const domains = await loadDomains(provider);
      const made = [];
      let fail = 0;
      let lastErr = '';

      for (let i = 0; i < n; i++) {
        setStatus('正在申请 ' + (i + 1) + ' / ' + n + ' 个信箱…');
        const domain = domains[i % domains.length];
        let address = '';
        for (let t = 0; t < 4; t++) {
          const local = prefix
            ? prefix + String(Math.floor(100 + Math.random() * 900))
            : randLocal();
          const a = local + '@' + domain;
          if (!S.boxes.some(function (b) { return b.address === a; })) { address = a; break; }
        }
        if (!address) { fail++; lastErr = '生成的地址重复'; continue; }

        const password = randPassword();
        try {
          const token = await mtCreateAccount(provider, address, password);
          const box = {
            id: uid(), provider: provider, address: address, password: password, token: token,
            createdAt: now(), lastSync: 0, error: '', activeMsgId: '', messages: []
          };
          S.boxes.unshift(box);
          S.activeId = box.id;
          made.push(box);
          save();
          renderAll();
        } catch (e) {
          fail++;
          lastErr = msgOf(e);
        }
        if (i < n - 1) await sleep(1100);
      }

      /* 刚建好的信箱顺手收一次（多半为空，但能立刻验证口令有效）。 */
      for (let i = 0; i < made.length; i++) {
        setStatus('正在收取新信箱 ' + (i + 1) + ' / ' + made.length + '…');
        try { await syncBox(made[i]); } catch (e) { made[i].error = msgOf(e); }
      }
      renderAll();
      save();
      setStatus('申请完成：' + made.length + ' 个成功' + (fail ? '，' + fail + ' 个失败（' + lastErr + '）' : ''),
        fail ? 'err' : 'ok');
    } catch (e) {
      setStatus('申请失败：' + msgOf(e), 'err');
    } finally {
      busy = false;
      setBusy(false);
      renderAll();
    }
  }

  /* 手动登记：保存地址、口令，以及可选的 OAuth2（client_id + refresh_token）。
   * 常见邮箱可走 IMAP 收信；两项凭证都只存本机。 */
  function addManualBox(address, password, clientId, refreshToken) {
    const addr = String(address == null ? '' : address).trim().toLowerCase();
    const pass = clipLen(password, 80);
    const cid = clipLen(clientId, 120);
    const rt = clipLen(refreshToken, 4096);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return { error: '地址格式不对，例：name@example.com' };
    }
    if (S.boxes.some(function (b) { return b.address.toLowerCase() === addr; })) {
      return { error: '这个地址已经在列表里：' + addr };
    }
    const box = {
      id: uid(), provider: 'manual', address: addr, password: pass,
      clientId: cid, refreshToken: rt, token: '',
      createdAt: now(), lastSync: 0, error: '', activeMsgId: '', messages: []
    };
    S.boxes.unshift(box);
    S.activeId = box.id;
    save();
    return { box: box };
  }

  function findBox(address) {
    const addr = String(address == null ? '' : address).trim().toLowerCase();
    if (!addr) return null;
    for (let i = 0; i < S.boxes.length; i++) {
      if (S.boxes[i].address.toLowerCase() === addr) return S.boxes[i];
    }
    return null;
  }

  function removeBox(b) {
    if (!b) return;
    S.boxes = S.boxes.filter(function (x) { return x.id !== b.id; });
    S.activeId = S.boxes[0] ? S.boxes[0].id : '';
    save();
    renderAll();
    setStatus('已从列表移除：' + b.address +
      (b.provider === 'manual' ? '（本机记录已删除）' : '（服务端账号会自行过期）'));
  }

  function selectBox(id) {
    S.activeId = id;
    MSGQ = '';
    if (els && els.msgSearch) els.msgSearch.value = '';
    save();
    renderBoxes();
    renderMsgs();
    renderRead();
  }

  function toggleSeen() {
    const b = activeBox();
    const m = activeMsg();
    if (!b || !m) return;
    m.seen = !m.seen;
    if (m.seen) markSeen(b, m.id);
    save();
    renderMsgs();
    renderRead();
    renderStats();
    renderFilters();
    setStatus(m.seen ? '已标记为已读' : '已标记为未读', 'ok');
  }

  async function batchRefresh() {
    if (busy) return;
    const list = selectedBoxes().filter(function (b) {
      return b.provider === 'mailtm' || b.provider === 'mailgw' ||
        b.provider === 'guerrilla' || manualFetchable(b);
    });
    if (!list.length) {
      setStatus('选中的信箱不支持收信（演示 / 未配置口令或 OAuth2 令牌的手动邮箱）', 'err');
      return;
    }
    busy = true;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length; i++) {
      setStatus('正在收取 ' + (i + 1) + ' / ' + list.length + '：' + list[i].address);
      try {
        await syncBox(list[i]);
        ok++;
      } catch (e) {
        fail++;
        list[i].error = msgOf(e);
      }
      renderBoxes();
      renderMsgs();
      renderRead();
    }
    busy = false;
    setBusy(false);
    save();
    setStatus('批量收取完成：' + ok + ' 个成功' + (fail ? '，' + fail + ' 个失败' : ''), fail ? 'err' : 'ok');
  }

  function batchCopy() {
    const list = selectedBoxes();
    if (!list.length) return;
    copyThenStatus(exportText(list), list.length + ' 个信箱（地址+口令）');
  }

  function batchRemove() {
    if (busy) return;
    const list = selectedBoxes();
    if (!list.length) return;
    if (!batchConfirm) {
      batchConfirm = true;
      els.batchRemove.textContent = '确认移除 ' + list.length + ' 个';
      els.batchRemove.classList.add('is-confirm');
      setStatus('再次点击「确认移除」才会删除这些本机记录');
      clearTimeout(batchTimer);
      batchTimer = setTimeout(resetBatchConfirm, 4000);
      return;
    }
    resetBatchConfirm();
    const ids = list.map(function (b) { return b.id; });
    S.boxes = S.boxes.filter(function (b) { return ids.indexOf(b.id) < 0; });
    ids.forEach(function (id) { SEL.delete(id); });
    if (S.boxes.every(function (b) { return b.id !== S.activeId; })) {
      S.activeId = S.boxes[0] ? S.boxes[0].id : '';
    }
    save();
    renderAll();
    setStatus('已移除 ' + ids.length + ' 个信箱（仅删本机记录）', 'ok');
  }

  function openImport() {
    if (!els) return;
    els.importModal.hidden = false;
    els.importText.value = '';
    setTimeout(function () { try { els.importText.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function closeImport() {
    if (!els) return;
    els.importModal.hidden = true;
    els.importText.value = '';
  }

  function runImport() {
    const r = importBoxes(els.importText.value);
    if (!r.added && !r.updated && !r.dup && !r.bad) {
      setStatus('没有可导入的内容：每行一个「地址----口令----client_id----refresh_token」', 'err');
      return;
    }
    closeImport();
    renderAll();
    const needOauth = S.boxes.filter(function (b) {
      return b.provider === 'manual' && /@(outlook|hotmail|live|msn)\.com$/i.test(b.address) && !hasOauth(b);
    }).length;
    setStatus('导入完成：新增 ' + r.added + ' 个' +
      (r.updated ? '，更新凭证 ' + r.updated + ' 个' : '') +
      (r.dup ? '，跳过重复 ' + r.dup + ' 个' : '') +
      (r.bad ? '，' + r.bad + ' 行无法识别' : '') +
      (needOauth ? '；' + needOauth + ' 个 Outlook 邮箱仍缺 OAuth2 凭证，请点「凭证」补齐 client_id 与 refresh_token' : ''),
      (r.added || r.updated) ? 'ok' : 'err');
  }

  /* ---- 写邮件 ---- */

  function openCompose() {
    if (!els) return;
    const b = activeBox();
    if (!b) { setStatus('先选一个手动邮箱', 'err'); return; }
    if (!canSend(b)) {
      setStatus('这个信箱不能发信：需要手动邮箱 + 口令或 OAuth2 凭证', 'err');
      return;
    }
    els.composeFrom.textContent = b.address;
    els.composeModal.hidden = false;
    setTimeout(function () { try { els.composeTo.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function closeCompose() {
    if (!els) return;
    els.composeModal.hidden = true;
    els.composeTo.value = '';
    els.composeSubject.value = '';
    els.composeBody.value = '';
  }

  async function runCompose() {
    const b = activeBox();
    if (!b) { setStatus('先选一个手动邮箱', 'err'); return; }
    const to = String(els.composeTo.value || '').trim();
    const subject = String(els.composeSubject.value || '').trim();
    const body = String(els.composeBody.value || '');
    if (!to) { setStatus('请填写收件人', 'err'); els.composeTo.focus(); return; }
    if (!body.trim()) { setStatus('请填写正文', 'err'); els.composeBody.focus(); return; }
    if (busy) return;
    setBusy(true);
    els.composeSend.disabled = true;
    try {
      await sendMail(b, to, subject, body);
      closeCompose();
      setStatus('已通过 SMTP 发送到 ' + to, 'ok');
    } catch (e) {
      setStatus('发信失败：' + msgOf(e), 'err');
    } finally {
      els.composeSend.disabled = false;
      setBusy(false);
    }
  }

  /* ---- 凭证工具 ---- */

  function openCred() {
    if (!els) return;
    const b = activeBox();
    if (!b || b.provider !== 'manual') {
      setStatus('只有手动登记的邮箱可以管理凭证', 'err');
      return;
    }
    els.credAddr.textContent = b.address;
    els.credPass.value = '';
    els.credClient.value = '';
    els.credToken.value = '';
    showCredMsg('', '');
    els.credModal.hidden = false;
    setTimeout(function () { try { els.credPass.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function closeCred() {
    if (!els) return;
    els.credModal.hidden = true;
    els.credPass.value = '';
    els.credClient.value = '';
    els.credToken.value = '';
  }

  function saveCred() {
    const b = activeBox();
    const r = applyCredential(b, els.credPass.value, els.credClient.value, els.credToken.value);
    if (r.error) { setStatus(r.error, 'err'); return; }
    closeCred();
    renderAll();
    setStatus('凭证已更新：' + b.address + (hasOauth(b) ? '（OAuth2）' : ''), 'ok');
  }

  function showCredMsg(text, kind) {
    els.credMsg.hidden = !text;
    els.credMsg.textContent = text || '';
    els.credMsg.className = 'md-modal-note md-cred-msg' + (kind ? ' is-' + kind : '');
  }

  /* 只验证 refresh_token 能否换到 access_token，并显示授权范围；不发信、不收信。 */
  async function testCred() {
    const b = activeBox();
    if (!b) return;
    const cid = String(els.credClient.value || '').trim() || b.clientId;
    const rt = String(els.credToken.value || '').trim() || b.refreshToken;
    if (!cid || !rt) {
      showCredMsg('需要 client_id 与 refresh_token 才能测试；也可以先在导入里粘贴完整卡密。', 'err');
      return;
    }
    els.credTest.disabled = true;
    showCredMsg('正在用 refresh_token 换取访问令牌…', '');
    try {
      const r = await relayOauthCheck({ clientId: cid, refreshToken: rt });
      if (r.ok) {
        showCredMsg('令牌有效' + (Array.isArray(r.scopes) && r.scopes.length
          ? '；授权范围：' + r.scopes.join('、')
          : '') + '。保存后即可用它自动登录 IMAP / SMTP。', 'ok');
      } else {
        showCredMsg('令牌无效：' + (r.error || '未知错误'), 'err');
      }
    } catch (e) {
      showCredMsg('测试失败：' + msgOf(e), 'err');
    } finally {
      els.credTest.disabled = false;
    }
  }

  function clearCred() {
    const b = activeBox();
    if (!b) return;
    const ok = window.confirm
      ? window.confirm('清除 ' + b.address + ' 的口令与 OAuth2 令牌？清除后无法收信 / 发信。')
      : true;
    if (!ok) return;
    clearCredential(b);
    closeCred();
    renderAll();
    setStatus('已清除凭证：' + b.address, 'ok');
  }

  function saveManualBox() {
    const r = addManualBox(els.addAddr.value, els.addPass.value);
    if (r.error) {
      setStatus(r.error, 'err');
      try { els.addAddr.focus(); } catch (e) { /* 忽略 */ }
      return;
    }
    els.addPanel.hidden = true;
    els.addAddr.value = '';
    els.addPass.value = '';
    renderAll();
    setStatus('已添加手动邮箱：' + r.box.address, 'ok');
  }

  async function openMessage(box, m) {
    box.activeMsgId = m.id;
    if (!m.seen) {
      m.seen = true;
      markSeen(box, m.id);
    }
    renderMsgs();
    renderRead();
    renderStats();
    renderFilters();
    save();
    if (m.loaded || box.provider === 'demo') return;

    setStatus('正在读取正文…');
    try {
      const d = box.provider === 'guerrilla'
        ? await guerrillaRead(box, m.id)
        : await readMessage(box, m.id);
      m.text = textOf(d).slice(0, 4000);
      m.subject = String((d && d.subject) || m.subject || '');
      m.from = (d && d.from) || m.from;
      m.loaded = true;
      renderRead();
      save();
      setStatus('已读取正文', 'ok');
    } catch (e) {
      setStatus('读取正文失败：' + msgOf(e), 'err');
    }
  }

  /* ================= 渲染 ================= */

  function monogram(s) {
    const t = String(s == null ? '' : s).replace(/^[<"']+/, '').trim();
    return esc(t ? t.charAt(0).toUpperCase() : '?');
  }

  function boxHtml(b) {
    const unread = unreadOf(b);
    const on = b.id === S.activeId;
    const checked = SEL.has(b.id);
    return '<div class="md-box p-' + esc(b.provider) + (on ? ' is-on' : '') +
      (checked ? ' is-checked' : '') + '" role="button" tabindex="0" ' +
      'data-box="' + esc(b.id) + '" title="' + esc(b.address) + '">' +
      '<input type="checkbox" class="md-box-check" data-check="' + esc(b.id) + '"' +
        (checked ? ' checked' : '') + ' aria-label="选择 ' + esc(b.address) + '">' +
      '<span class="md-box-avatar">' + monogram(b.address) + '</span>' +
      '<span class="md-box-main">' +
        '<span class="md-box-addr">' + esc(b.address) + '</span>' +
        '<span class="md-box-meta">' +
          (b.provider === 'demo' || b.provider === 'manual'
            ? ''
            : '<span class="md-box-prov">' + esc(providerLabel(b.provider)) + '</span>') +
          esc(b.provider === 'demo' ? '本地演示'
            : (b.provider === 'manual'
              ? ('手动登记' + (hasOauth(b) ? ' · OAuth2' : (b.password ? ' · 口令' : ' · 无凭证')))
              : fmtAgo(b.lastSync || b.createdAt))) +
          (b.error ? ' · <em class="md-err">收取失败</em>' : '') +
        '</span>' +
      '</span>' +
      (unread ? '<span class="md-badge">' + unread + '</span>' : '') +
      '</div>';
  }

  function renderStats() {
    if (!els) return;
    let unread = 0;
    let issues = 0;
    S.boxes.forEach(function (b) {
      unread += unreadOf(b);
      if (b.error) issues++;
    });
    els.statBoxes.textContent = String(S.boxes.length);
    els.statUnread.textContent = String(unread);
    els.statIssues.textContent = String(issues);
    els.statIssuesWrap.classList.toggle('is-bad', issues > 0);
  }

  function renderFilters() {
    if (!els) return;
    let unread = 0;
    let pass = 0;
    let error = 0;
    S.boxes.forEach(function (b) {
      if (unreadOf(b)) unread++;
      if (b.password || hasOauth(b)) pass++;
      if (b.error) error++;
    });
    const counts = { all: S.boxes.length, unread: unread, pass: pass, error: error };
    const btns = els.filters.querySelectorAll('[data-filter]');
    for (let i = 0; i < btns.length; i++) {
      const f = btns[i].getAttribute('data-filter');
      btns[i].classList.toggle('is-on', f === FILTER);
      const num = btns[i].querySelector('b');
      if (num) num.textContent = String(counts[f] || 0);
    }
  }

  function updateBatchBar(list) {
    if (!els || !els.batch) return;
    const n = SEL.size;
    els.batch.classList.toggle('is-empty', !n);
    els.batchCount.textContent = n ? ('已选 ' + n + ' 个') : '勾选后可批量操作';
    els.batchRefresh.disabled = !n || busy;
    els.batchCopy.disabled = !n;
    els.batchRemove.disabled = !n || busy;
    const visible = list || [];
    const allChecked = visible.length > 0 && visible.every(function (b) { return SEL.has(b.id); });
    els.selectAll.checked = allChecked;
    els.selectAll.indeterminate = !allChecked && visible.some(function (b) { return SEL.has(b.id); });
    if (!n) resetBatchConfirm();
  }

  function renderBoxes() {
    if (!els) return;
    pruneSelection();
    const list = S.boxes.filter(boxVisible);
    const top = els.boxes.scrollTop;
    els.boxCount.textContent = String(S.boxes.length);
    els.boxes.innerHTML = list.length
      ? list.map(boxHtml).join('')
      : '<div class="md-empty">' + (S.boxes.length
        ? '当前筛选下没有信箱<span>换个筛选条件，或清空搜索</span>'
        : '还没有信箱<span>选好服务与数量，点「批量申请」</span>') + '</div>';
    els.boxes.scrollTop = top;
    els.copyAll.disabled = !S.boxes.length || busy;
    renderFilters();
    renderStats();
    updateBatchBar(list);
  }

  function senderName(m) {
    return (m.from && (m.from.name || m.from.address)) || '未知发件人';
  }

  function msgRow(b, m) {
    const raw = (m.subject || '') + '\n' + (m.intro || '') + '\n' + (m.text || '');
    const hasCode = extractCodes(raw).length > 0;
    return '<button type="button" class="md-msg' + (m.id === b.activeMsgId ? ' is-on' : '') +
      (m.seen ? ' is-read' : '') + '" data-msg="' + esc(m.id) + '">' +
      '<span class="md-msg-avatar" aria-hidden="true">' + monogram(senderName(m)) + '</span>' +
      '<span class="md-msg-main">' +
        '<span class="md-msg-top">' +
          '<span class="md-msg-from">' + esc(senderName(m)) + '</span>' +
          '<span class="md-msg-time">' + esc(fmtAgo(m.createdAt)) + '</span>' +
        '</span>' +
        '<span class="md-msg-subject">' + esc(m.subject || '(无主题)') + '</span>' +
        (m.intro ? '<span class="md-msg-intro">' + esc(m.intro) + '</span>' : '') +
        (hasCode ? '<span class="md-msg-tag">含验证码</span>' : '') +
      '</span>' +
      '</button>';
  }

  function msgMatches(m) {
    if (!MSGQ) return true;
    const from = m.from ? (String(m.from.name || '') + ' ' + String(m.from.address || '')) : '';
    return (String(m.subject || '') + ' ' + from + ' ' + String(m.intro || ''))
      .toLowerCase().indexOf(MSGQ) >= 0;
  }

  function renderMsgs() {
    if (!els) return;
    const b = activeBox();
    els.addr.textContent = b ? b.address : '未选择信箱';
    els.addr.title = b ? b.address : '';
    els.prov.hidden = !b;
    els.prov.textContent = b
      ? (b.provider === 'manual' ? '手动登记' : (b.provider === 'demo' ? '本地演示' : providerLabel(b.provider)))
      : '';
    const pass = b ? String(b.password || '') : '';
    const oauth = !!b && hasOauth(b);
    els.passRow.hidden = !pass && !oauth;
    els.pass.textContent = pass || (oauth ? 'OAuth2（令牌已保存）' : '—');
    els.pass.title = pass ? '信箱口令：' + pass : (oauth ? 'OAuth2 刷新令牌已保存在本机，不在界面显示' : '');
    els.copyAddr.disabled = !b || busy;
    els.copyPass.disabled = !pass || busy;
    const manual = !!b && b.provider === 'manual';
    const preset = manual ? imapPreset(b.address) : null;
    const canFetch = manual ? (!!preset && (!!b.password || oauth)) : true;
    els.syncOne.disabled = !b || (manual && !canFetch) || busy;
    els.syncOne.title = manual
      ? (canFetch
        ? '通过 IMAP' + (oauth ? '（OAuth2）' : '') + '收取：' + preset.host
        : (!preset ? '这个域名还没有内置 IMAP 收信配置' : '没有口令或 OAuth2 令牌，无法收信'))
      : '';
    const smtp = manual ? smtpPreset(b.address) : null;
    const canMail = manual ? (canSend(b)) : false;
    els.compose.disabled = !canMail || busy;
    els.compose.title = canMail
      ? '用 ' + b.address + ' 发信：' + smtp.host
      : '这个信箱没有可用的发信凭证';
    els.cred.disabled = !manual || busy;
    els.cred.title = manual ? '更新或清除这个邮箱的口令 / OAuth2 凭证' : '只有手动邮箱可以管理凭证';
    els.remove.disabled = !b || busy;
    if (!b) {
      els.msgCount.textContent = '0 封';
      els.msgSearch.disabled = true;
      els.msgs.innerHTML = '<div class="md-empty">左侧选一个信箱<span>或先批量申请几个</span></div>';
      return;
    }
    const unread = unreadOf(b);
    els.msgCount.textContent = b.messages.length + ' 封' + (unread ? ' · 未读 ' + unread : '');
    els.msgSearch.disabled = !b.messages.length;
    const list = b.messages.filter(msgMatches);
    const top = els.msgs.scrollTop;
    els.msgs.innerHTML = list.length
      ? list.map(function (m) { return msgRow(b, m); }).join('')
      : '<div class="md-empty">' + (b.messages.length
        ? '没有匹配的邮件<span>换个关键词试试</span>'
        : (manual
          ? (canFetch
            ? '这个信箱还没有来信<span>点「刷新」通过 IMAP 收取</span>'
            : '这个域名暂时不能收信<span>可复制地址与凭证，到目标站点使用</span>')
          : '这个信箱还没有来信<span>把地址填到目标站点，再点「刷新」收取</span>')) + '</div>';
    els.msgs.scrollTop = top;
  }

  function renderRead() {
    if (!els) return;
    const b = activeBox();
    const m = activeMsg();
    if (!b || !m) {
      els.read.innerHTML = '<div class="md-empty">点开一封信<span>正文、验证码与链接会显示在这里</span></div>';
      return;
    }
    const text = m.text || m.intro || '（这封信没有可读正文，点「刷新」后再试试）';
    const codes = extractCodes((m.subject || '') + '\n' + text);
    const links = extractLinks((m.subject || '') + '\n' + text);

    els.read.innerHTML =
      '<div class="md-read-bar">' +
        '<span class="md-read-badge">' + esc(providerLabel(b.provider)) + '</span>' +
        '<span class="md-read-acts">' +
          '<button type="button" class="md-mini" data-read-act="copy-body">复制正文</button>' +
          '<button type="button" class="md-mini" data-read-act="toggle-seen">' +
            (m.seen ? '标为未读' : '标为已读') + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="md-read-head">' +
        '<div class="md-read-subject">' + esc(m.subject || '(无主题)') + '</div>' +
        '<div class="md-read-meta">' +
          '<span class="md-read-from">' + esc(fromText(m.from)) + '</span>' +
          '<span class="md-read-sep">·</span>' +
          '<span>' + esc(fmtFull(m.createdAt)) + '</span>' +
        '</div>' +
      '</div>' +
      (codes.length
        ? '<div class="md-codes"><div class="md-codes-h">识别到的验证码 · 点击复制</div>' +
          codes.map(function (c) {
            return '<button type="button" class="md-code" data-copy="' + esc(c) + '" title="复制 ' + esc(c) + '">' + esc(c) + '</button>';
          }).join('') + '</div>'
        : '') +
      (links.length
        ? '<div class="md-links"><div class="md-links-h">邮件里的链接</div>' +
          links.map(function (u) {
            return '<div class="md-link-row">' +
              '<span class="md-link" title="' + esc(u) + '">' + esc(clip(u, 72)) + '</span>' +
              '<button type="button" class="md-mini" data-copy="' + esc(u) + '">复制</button>' +
              '<button type="button" class="md-mini" data-open="' + esc(u) + '">打开</button>' +
              '</div>';
          }).join('') + '</div>'
        : '') +
      '<div class="md-read-body"><pre class="md-body">' + esc(text) + '</pre></div>';
  }

  function renderAll() {
    if (!els) return;
    renderBoxes();
    renderMsgs();
    renderRead();
    updateHint();
  }

  function updateHint() {
    if (!els) return;
    els.hint.textContent = S.provider === 'demo'
      ? '演示模式：信箱只在本机模拟'
      : (S.provider === 'guerrilla'
        ? 'Guerrilla 免账号，会话过期后需重新申请'
        : '口令与 OAuth2 令牌只保存在本机，收发信经本地中转');
  }

  function setStatus(text, tone) {
    if (!els) return;
    els.status.textContent = text;
    els.statusBar.classList.remove('is-ok', 'is-err');
    if (tone === 'ok') els.statusBar.classList.add('is-ok');
    if (tone === 'err') els.statusBar.classList.add('is-err');
  }

  function setBusy(on) {
    busy = on;
    if (!els) return;
    els.root.classList.toggle('is-busy', on);
    els.create.disabled = on;
    els.syncAll.disabled = on;
    renderBoxes();
    renderMsgs();
  }

  function setNet(text, tone) {
    if (!els || !els.netText) return;
    els.netText.textContent = text;
    els.net.className = 'md-net' + (tone ? ' is-' + tone : '');
  }

  async function checkNet() {
    if (!els) return;
    if (S.provider === 'demo') { setNet('离线演示', 'demo'); return; }
    try {
      const r = await fetch(relayHealthUrl(), { cache: 'no-store' });
      setNet(r.ok ? '本地中转在线' : '本地中转异常', r.ok ? 'ok' : 'bad');
    } catch (e) {
      setNet('本地中转未启动', 'bad');
    }
  }

  /* ================= 剪贴板 / 打开链接 ================= */

  async function copyText(text) {
    const s = String(text == null ? '' : text);
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }

  async function copyThenStatus(text, label) {
    const ok = await copyText(text);
    if (ok) setStatus('已复制' + (label ? '：' + clip(label, 60) : ''), 'ok');
    else setStatus('复制失败：浏览器拒绝了剪贴板权限', 'err');
  }

  function openInBrowser(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    if (typeof window.openDeskApp === 'function') {
      window.__bwPendingUrl = url;
      window.openDeskApp('browser');
      setStatus('已转交内置浏览器打开', 'ok');
    } else {
      copyThenStatus(url, url);
    }
  }

  /* ================= AI 邮箱助手 =================
   * 把当前信箱清单（地址、未读、是否有口令、最近来信与识别到的验证码）交给模型，
   * 模型只返回一份操作计划；删除等动作必须由用户点「执行」后才落到本机。
   * 口令与 OAuth2 令牌永远不进模型上下文；模型只返回操作计划，执行由用户确认。
   */
  const AI = { open: false, busy: false, log: [] };

  const AI_SYS = [
    '你是「邮箱台」里的邮箱管理助手，帮助用户查看、添加、选择、刷新、清理信箱，以及代写并发信。',
    '只输出一个 JSON 对象，不要 Markdown，不要在 JSON 之外写任何文字。',
    '格式：{"reply":"中文答复","actions":[...]}',
    '可用动作：',
    '{"type":"add","address":"name@example.com","password":"可选"}',
    '{"type":"import"}',
    '{"type":"remove","address":"name@example.com"}',
    '{"type":"select","address":"name@example.com"}',
    '{"type":"refresh","address":"可选；为空表示全部"}',
    '{"type":"send","address":"发件信箱，可选；为空用当前信箱","to":"收件人","subject":"主题","body":"纯文本正文"}',
    '能力说明：手动邮箱支持两种登录方式——口令，或 OAuth2（client_id + refresh_token）自动登录；',
    '用户提到「卡密 / 令牌登录 / refresh_token」时，要回答系统支持令牌登录，并引导用户点「导入」粘贴整行卡密',
    '（格式 地址----口令----client_id----refresh_token），或调用 {"type":"import"} 帮他打开导入面板；',
    '令牌只能由用户在导入/凭证弹层里自行填写，助手不接收、不回显、不索要；不要让用户把 refresh_token 发到对话里。',
    '规则：只能引用状态清单里存在的地址；用户没有明确要求删除时不要生成 remove；',
    '只有用户明确要求发信时才生成 send，正文要完整可发送，不要虚构凭证或验证码；',
    '不要编造地址、口令或来信内容；不需要执行动作时 actions 用空数组；reply 控制在 80 字内。'
  ].join('\n');

  function llmConnSafe() {
    try {
      if (typeof llmConn === 'function') return llmConn();
    } catch (e) { /* 未配置 */ }
    return null;
  }

  function aiReady() {
    const conn = llmConnSafe();
    return !!(window.LLMRouter && typeof window.LLMRouter.complete === 'function'
      && conn && conn.base && conn.key && conn.model);
  }

  function aiContext() {
    const lines = ['时间：' + fmtFull(new Date().toISOString()) + '；信箱数：' + S.boxes.length];
    S.boxes.slice(0, 40).forEach(function (b, i) {
      const unread = b.messages.filter(function (m) { return !m.seen; }).length;
      const recent = b.messages.slice(0, 3).map(function (m) {
        const codes = extractCodes((m.subject || '') + '\n' + (m.text || m.intro || ''));
        return '「' + clip(m.subject || '(无主题)', 40) + '」' +
          (codes.length ? ' 码:' + codes.join('/') : '');
      }).join('');
      lines.push((i + 1) + '. ' + b.address + ' | ' + providerLabel(b.provider) +
        ' | 未读 ' + unread + ' | ' + (b.password ? '有口令' : (hasOauth(b) ? 'OAuth2 已配置' : '无口令')) +
        (b.provider === 'manual' ? (manualFetchable(b) ? ' | IMAP 可收信' : ' | 不可收信') : '') +
        (b.provider === 'manual' && canSend(b) ? ' | SMTP 可发信' : '') +
        (b.error ? ' | 收取失败' : '') + (recent ? ' | 来信 ' + recent : ''));
    });
    if (!S.boxes.length) lines.push('（列表为空）');
    return lines.join('\n');
  }

  function parseAiPlan(raw) {
    let t = String(raw == null ? '' : raw).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return { reply: t || '（模型没有返回内容）', actions: [] };
    let obj;
    try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { return { reply: t.slice(a, b + 1), actions: [] }; }
    const allowed = { add: 1, import: 1, remove: 1, select: 1, refresh: 1, send: 1 };
    const actions = Array.isArray(obj.actions) ? obj.actions.filter(function (x) {
      if (!x || !allowed[x.type]) return false;
      if (x.type === 'refresh' || x.type === 'import') return true;
      if (x.type === 'send') return !!String(x.to || '').trim() && !!String(x.body || '').trim();
      return !!String(x.address || '').trim();
    }).slice(0, 12) : [];
    return { reply: String(obj.reply || '').trim(), actions: actions };
  }

  function actionLabel(a) {
    const addr = String(a.address || '');
    if (a.type === 'add') return '添加手动邮箱 ' + addr + (a.password ? '（含口令）' : '（无口令）');
    if (a.type === 'import') return '打开导入面板，粘贴卡密';
    if (a.type === 'remove') return '移除 ' + addr;
    if (a.type === 'select') return '选中 ' + addr;
    if (a.type === 'refresh') return addr ? ('刷新 ' + addr) : '刷新全部可收信信箱';
    if (a.type === 'send') {
      return '用 ' + (addr || '当前信箱') + ' 发到 ' + String(a.to || '') +
        (a.subject ? '：' + clip(a.subject, 30) : '');
    }
    return '未知动作';
  }

  function aiMsgHtml(item, i) {
    if (item.role === 'user') return '<div class="md-ai-msg is-user">' + esc(item.text) + '</div>';
    if (item.role === 'err') return '<div class="md-ai-msg is-err">' + esc(item.text) + '</div>';
    let html = '<div class="md-ai-msg is-agent">' + esc(item.text);
    if (item.actions && item.actions.length) {
      html += '<div class="md-ai-plan">' + item.actions.map(function (a) {
        return '<div class="md-ai-act">' + esc(actionLabel(a)) + '</div>';
      }).join('');
      if (!item.done) {
        html += '<div class="md-ai-plan-acts">' +
          '<button type="button" class="md-mini" data-ai-skip="' + i + '">忽略</button>' +
          '<button type="button" class="md-btn md-primary" data-ai-run="' + i + '">执行</button>' +
          '</div>';
      } else if (item.results && item.results.length) {
        html += '<div class="md-ai-results">' + item.results.map(function (r) {
          return '<div>' + esc(r) + '</div>';
        }).join('') + '</div>';
      }
      html += '</div>';
    }
    return html + '</div>';
  }

  function renderAi() {
    if (!els || !els.ai) return;
    els.ai.hidden = !AI.open;
    els.aiToggle.classList.toggle('is-on', AI.open);
    els.aiToggle.textContent = AI.open ? '收起助手' : 'AI 助手';
    if (!AI.open) return;
    els.aiNote.textContent = aiReady() ? '操作计划需确认后执行' : '未配置语言模型';
    els.aiSend.disabled = AI.busy;
    const nearBottom = els.aiLog.scrollHeight - els.aiLog.scrollTop - els.aiLog.clientHeight < 48;
    els.aiLog.innerHTML = AI.log.length
      ? AI.log.map(aiMsgHtml).join('')
      : '<div class="md-ai-empty">问它「现在有哪些未读」，或让它帮你清理空信箱。</div>';
    if (nearBottom || AI.log.length <= 1) els.aiLog.scrollTop = els.aiLog.scrollHeight;
  }

  function setAiOpen(on) {
    AI.open = !!on;
    if (AI.open && !AI.log.length) {
      AI.log.push({
        role: 'agent',
        text: '我可以汇总未读、检查凭证与异常、刷新收信、添加或清理信箱，也能代写并发信。支持口令和卡密（OAuth2 令牌）两种登录；令牌请粘到「导入」里，不用发给我。说出要求，我先给计划，你确认后再执行。',
        actions: []
      });
    }
    renderAi();
    if (AI.open) setTimeout(function () { try { els.aiText.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function askAgent(text) {
    const q = String(text == null ? '' : text).trim();
    if (!q || AI.busy) return;
    if (!aiReady()) {
      AI.log.push({ role: 'err', text: '还没有可用的语言模型：请先在「设置 → 模型」里配置接口与 Key。' });
      renderAi();
      return;
    }
    const history = AI.log.filter(function (x) {
      return x.role === 'user' || x.role === 'agent';
    }).slice(-6).map(function (x) {
      return { role: x.role === 'user' ? 'user' : 'assistant', content: x.text };
    });
    AI.log.push({ role: 'user', text: q });
    AI.busy = true;
    renderAi();
    window.LLMRouter.complete({
      app: 'maildesk',
      sys: AI_SYS,
      messages: history.concat([{
        role: 'user',
        content: '当前信箱状态：\n' + aiContext() + '\n\n用户指令：' + q
      }]),
      opts: { temperature: 0.2, timeoutMs: 60000 }
    }).then(function (out) {
      const plan = parseAiPlan(out);
      AI.log.push({
        role: 'agent', text: plan.reply || '（模型没有给出说明）',
        actions: plan.actions, done: false, results: null
      });
    }).catch(function (e) {
      AI.log.push({ role: 'err', text: '助手调用失败：' + msgOf(e) });
    }).then(function () {
      AI.busy = false;
      renderAi();
    });
  }

  async function aiRefresh(address) {
    const box = address ? findBox(address) : null;
    if (address && !box) return '没找到：' + address;
    if (box && (box.provider === 'demo' || (box.provider === 'manual' && !manualFetchable(box)))) {
      return box.address + ' 不支持收信';
    }
    if (!box) {
      const any = S.boxes.some(function (b) {
        return b.provider === 'mailtm' || b.provider === 'mailgw' ||
          b.provider === 'guerrilla' || manualFetchable(b);
      });
      if (!any) return '没有可收信的信箱';
      await syncAll(false);
      return '已刷新全部可收信信箱';
    }
    if (busy) return '正在刷新，稍后再试';
    busy = true;
    setBusy(true);
    try {
      await syncBox(box);
      renderMsgs();
      renderRead();
      save();
      return '已刷新 ' + box.address;
    } catch (e) {
      box.error = msgOf(e);
      return '刷新失败：' + box.error;
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  async function runAiActions(i) {
    const item = AI.log[i];
    if (!item || item.done || !item.actions) return;
    item.done = true;
    item.results = [];
    for (let k = 0; k < item.actions.length; k++) {
      const a = item.actions[k];
      try {
        if (a.type === 'add') {
          const r = addManualBox(a.address, a.password);
          item.results.push(r.error || ('已添加 ' + r.box.address));
        } else if (a.type === 'import') {
          openImport();
          item.results.push('已打开导入面板，请粘贴卡密（地址----口令----client_id----refresh_token）');
        } else if (a.type === 'remove') {
          const box = findBox(a.address);
          if (!box) item.results.push('没找到：' + a.address);
          else { const addr = box.address; removeBox(box); item.results.push('已移除 ' + addr); }
        } else if (a.type === 'select') {
          const box = findBox(a.address);
          if (!box) item.results.push('没找到：' + a.address);
          else { selectBox(box.id); item.results.push('已选中 ' + box.address); }
        } else if (a.type === 'refresh') {
          item.results.push(await aiRefresh(a.address));
        } else if (a.type === 'send') {
          const box = a.address ? findBox(a.address) : activeBox();
          if (!box) item.results.push('没找到发件信箱：' + (a.address || '当前信箱'));
          else if (!canSend(box)) item.results.push(box.address + ' 没有可用的发信凭证');
          else {
            try {
              await sendMail(box, a.to, a.subject, a.body);
              item.results.push('已用 ' + box.address + ' 发送到 ' + a.to);
            } catch (e) {
              item.results.push('发信失败：' + msgOf(e));
            }
          }
        }
      } catch (e) {
        item.results.push('失败：' + msgOf(e));
      }
    }
    renderAll();
    renderAi();
  }

  function sendAiInput(text) {
    const v = text == null ? els.aiText.value : text;
    els.aiText.value = '';
    askAgent(v);
  }

  /* ================= 自动收取 ================= */

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(function () {
      if (!els || !S.auto || busy) return;
      const win = document.getElementById('maildeskWin');
      if (win && win.classList.contains('hidden')) return;
      const gap = (Number(S.autoSec) || 30) * 1000;
      if (now() - (S.lastAutoAt || 0) < gap) return;
      S.lastAutoAt = now();
      syncAll(true);
    }, 5000);
  }

  /* ================= 事件 ================= */

  function cacheEls(body) {
    const q = function (s) { return body.querySelector(s); };
    els = {
      root: q('.md-root'),
      net: q('#mdNet'),
      netText: q('#mdNet span'),
      statBoxes: q('#mdStatBoxes'),
      statUnread: q('#mdStatUnread'),
      statIssues: q('#mdStatIssues'),
      statIssuesWrap: q('#mdStatIssuesWrap'),
      provider: q('#mdProvider'),
      count: q('#mdCount'),
      prefix: q('#mdPrefix'),
      create: q('#mdCreate'),
      auto: q('#mdAuto'),
      autoSec: q('#mdAutoSec'),
      syncAll: q('#mdSyncAll'),
      importBtn: q('#mdImport'),
      exportBtn: q('#mdExport'),
      boxCount: q('#mdBoxCount'),
      filters: q('#mdFilters'),
      addBtn: q('#mdAdd'),
      addPanel: q('#mdAddPanel'),
      addAddr: q('#mdAddAddr'),
      addPass: q('#mdAddPass'),
      addSave: q('#mdAddSave'),
      addCancel: q('#mdAddCancel'),
      copyAll: q('#mdCopyAll'),
      search: q('#mdSearch'),
      batch: q('#mdBatch'),
      batchCount: q('#mdSelCount'),
      selectAll: q('#mdSelectAll'),
      batchRefresh: q('#mdBatchRefresh'),
      batchCopy: q('#mdBatchCopy'),
      batchRemove: q('#mdBatchRemove'),
      boxes: q('#mdBoxes'),
      addr: q('#mdAddr'),
      prov: q('#mdProv'),
      passRow: q('#mdPassRow'),
      pass: q('#mdPass'),
      copyAddr: q('#mdCopyAddr'),
      copyPass: q('#mdCopyPass'),
      compose: q('#mdCompose'),
      cred: q('#mdCred'),
      syncOne: q('#mdSyncOne'),
      remove: q('#mdRemove'),
      msgCount: q('#mdMsgCount'),
      msgSearch: q('#mdMsgSearch'),
      msgs: q('#mdMsgs'),
      read: q('#mdRead'),
      status: q('#mdStatus'),
      statusBar: q('.md-status'),
      hint: q('#mdHint'),
      ai: q('#mdAi'),
      aiToggle: q('#mdAiToggle'),
      aiNote: q('#mdAiNote'),
      aiLog: q('#mdAiLog'),
      aiQuick: q('.md-ai-quick'),
      aiText: q('#mdAiText'),
      aiSend: q('#mdAiSend'),
      aiClear: q('#mdAiClear'),
      aiClose: q('#mdAiClose'),
      importModal: q('#mdImportModal'),
      importText: q('#mdImportText'),
      importSave: q('#mdImportSave'),
      importCancel: q('#mdImportCancel'),
      composeModal: q('#mdComposeModal'),
      composeFrom: q('#mdComposeFrom'),
      composeTo: q('#mdComposeTo'),
      composeSubject: q('#mdComposeSubject'),
      composeBody: q('#mdComposeBody'),
      composeSend: q('#mdComposeSend'),
      composeCancel: q('#mdComposeCancel'),
      credModal: q('#mdCredModal'),
      credAddr: q('#mdCredAddr'),
      credPass: q('#mdCredPass'),
      credClient: q('#mdCredClient'),
      credToken: q('#mdCredToken'),
      credSave: q('#mdCredSave'),
      credCancel: q('#mdCredCancel'),
      credClear: q('#mdCredClear'),
      credTest: q('#mdCredTest'),
      credMsg: q('#mdCredMsg')
    };
  }

  function syncForm() {
    els.provider.value = S.provider;
    els.count.value = String(S.count);
    els.prefix.value = S.prefix;
    els.auto.checked = !!S.auto;
    els.autoSec.value = String(S.autoSec);
  }

  function wire() {
    els.provider.addEventListener('change', function () {
      S.provider = PROVIDERS[els.provider.value] ? els.provider.value : 'mailtm';
      save();
      updateHint();
      checkNet();
    });

    function readCount() {
      const n = clamp(parseInt(els.count.value, 10) || 1, 1, 20);
      S.count = n;
      els.count.value = String(n);
      save();
    }
    els.count.addEventListener('change', readCount);
    els.count.addEventListener('blur', readCount);

    els.prefix.addEventListener('input', function () {
      S.prefix = String(els.prefix.value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      save();
    });

    els.create.addEventListener('click', function () { createBatch(); });

    els.syncAll.addEventListener('click', function () { syncAll(false); });

    els.auto.addEventListener('change', function () {
      S.auto = !!els.auto.checked;
      S.lastAutoAt = 0;
      save();
      setStatus(S.auto ? '已开启自动收取（每 ' + S.autoSec + ' 秒）' : '已关闭自动收取');
    });

    els.autoSec.addEventListener('change', function () {
      S.autoSec = Number(els.autoSec.value) || 30;
      S.lastAutoAt = 0;
      save();
    });

    els.search.addEventListener('input', function () { renderBoxes(); });

    els.filters.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      FILTER = btn.getAttribute('data-filter') || 'all';
      renderBoxes();
    });

    els.selectAll.addEventListener('change', function () {
      const list = S.boxes.filter(boxVisible);
      if (els.selectAll.checked) list.forEach(function (b) { SEL.add(b.id); });
      else list.forEach(function (b) { SEL.delete(b.id); });
      renderBoxes();
    });

    els.batchRefresh.addEventListener('click', function () { batchRefresh(); });
    els.batchCopy.addEventListener('click', function () { batchCopy(); });
    els.batchRemove.addEventListener('click', function () { batchRemove(); });

    els.msgSearch.addEventListener('input', function () {
      MSGQ = String(els.msgSearch.value || '').trim().toLowerCase();
      renderMsgs();
    });

    els.importBtn.addEventListener('click', openImport);
    els.importCancel.addEventListener('click', closeImport);
    els.importSave.addEventListener('click', runImport);

    els.importModal.addEventListener('click', function (e) {
      if (e.target === els.importModal) closeImport();
    });

    els.compose.addEventListener('click', function () { openCompose(); });
    els.composeCancel.addEventListener('click', closeCompose);
    els.composeSend.addEventListener('click', runCompose);
    els.composeModal.addEventListener('click', function (e) {
      if (e.target === els.composeModal) closeCompose();
    });

    els.cred.addEventListener('click', function () { openCred(); });
    els.credCancel.addEventListener('click', closeCred);
    els.credSave.addEventListener('click', saveCred);
    els.credTest.addEventListener('click', testCred);
    els.credClear.addEventListener('click', clearCred);
    els.credModal.addEventListener('click', function (e) {
      if (e.target === els.credModal) closeCred();
    });
    els.composeBody.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCompose();
    });
    els.credToken.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCred();
    });

    els.exportBtn.addEventListener('click', function () {
      const list = SEL.size ? selectedBoxes() : S.boxes;
      if (!list.length) { setStatus('还没有可导出的信箱', 'err'); return; }
      const text = exportText(list);
      if (downloadText('maildesk-' + Date.now() + '.txt', text)) {
        setStatus('已导出 ' + list.length + ' 个信箱（地址+口令，不含令牌）', 'ok');
      } else {
        copyThenStatus(text, list.length + ' 个信箱（地址+口令）');
      }
    });

    els.addBtn.addEventListener('click', function () {
      els.addPanel.hidden = !els.addPanel.hidden;
      if (!els.addPanel.hidden) {
        els.addAddr.value = '';
        els.addPass.value = '';
        setTimeout(function () { try { els.addAddr.focus(); } catch (e) { /* 忽略 */ } }, 30);
      }
    });

    els.addCancel.addEventListener('click', function () { els.addPanel.hidden = true; });

    els.addSave.addEventListener('click', saveManualBox);

    els.addPass.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveManualBox();
    });

    els.addAddr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') els.addPass.focus();
    });

    els.aiToggle.addEventListener('click', function () { setAiOpen(!AI.open); });
    els.aiClose.addEventListener('click', function () { setAiOpen(false); });

    els.aiClear.addEventListener('click', function () {
      AI.log = [];
      setAiOpen(true);
    });

    els.aiSend.addEventListener('click', function () { sendAiInput(); });

    els.aiText.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiInput();
      }
    });

    els.aiQuick.addEventListener('click', function (e) {
      const b = e.target.closest('[data-ai-q]');
      if (b) sendAiInput(b.getAttribute('data-ai-q'));
    });

    els.aiLog.addEventListener('click', function (e) {
      const run = e.target.closest('[data-ai-run]');
      if (run) {
        runAiActions(Number(run.getAttribute('data-ai-run')));
        return;
      }
      const skip = e.target.closest('[data-ai-skip]');
      if (skip) {
        const item = AI.log[Number(skip.getAttribute('data-ai-skip'))];
        if (item && !item.done) {
          item.done = true;
          item.results = ['已忽略本次计划'];
          renderAi();
        }
      }
    });

    els.copyAll.addEventListener('click', function () {
      if (!S.boxes.length) return;
      copyThenStatus(S.boxes.map(function (b) { return b.address; }).join('\n'),
        S.boxes.length + ' 个地址');
    });

    els.copyAddr.addEventListener('click', function () {
      const b = activeBox();
      if (b) copyThenStatus(b.address, b.address);
    });

    els.copyPass.addEventListener('click', function () {
      const b = activeBox();
      if (b && b.password) copyThenStatus(b.password, b.password);
    });

    els.syncOne.addEventListener('click', async function () {
      const b = activeBox();
      if (!b || busy) return;
      if (b.provider === 'demo') { setStatus('演示信箱不需要刷新'); return; }
      busy = true;
      setBusy(true);
      setStatus('正在收取：' + b.address);
      try {
        await syncBox(b);
        renderMsgs();
        renderRead();
        setStatus('收取完成：' + b.messages.length + ' 封信', 'ok');
      } catch (e) {
        b.error = msgOf(e);
        setStatus('收取失败：' + b.error, 'err');
      } finally {
        busy = false;
        setBusy(false);
        save();
      }
    });

    els.remove.addEventListener('click', function () {
      const b = activeBox();
      if (!b) return;
      removeBox(b);
    });

    els.boxes.addEventListener('click', function (e) {
      const chk = e.target.closest('[data-check]');
      if (chk) {
        toggleSel(chk.getAttribute('data-check'), chk.checked);
        return;
      }
      const el = e.target.closest('[data-box]');
      if (!el) return;
      selectBox(el.getAttribute('data-box'));
    });

    els.boxes.addEventListener('keydown', function (e) {
      const el = e.target.closest('[data-box]');
      if (!el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      selectBox(el.getAttribute('data-box'));
    });

    els.msgs.addEventListener('click', function (e) {
      const el = e.target.closest('[data-msg]');
      if (!el) return;
      const b = activeBox();
      if (!b) return;
      const id = el.getAttribute('data-msg');
      let m = null;
      for (let i = 0; i < b.messages.length; i++) if (b.messages[i].id === id) m = b.messages[i];
      if (m) openMessage(b, m);
    });

    els.root.addEventListener('click', function (e) {
      const act = e.target.closest('[data-read-act]');
      if (act) {
        e.preventDefault();
        const kind = act.getAttribute('data-read-act');
        if (kind === 'toggle-seen') toggleSeen();
        if (kind === 'copy-body') {
          const m = activeMsg();
          if (m) copyThenStatus(m.text || m.intro || '', '邮件正文');
        }
        return;
      }
      const c = e.target.closest('[data-copy]');
      if (c) {
        e.preventDefault();
        copyThenStatus(c.getAttribute('data-copy'), c.getAttribute('data-copy'));
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) {
        e.preventDefault();
        openInBrowser(o.getAttribute('data-open'));
      }
    });
  }

  /* ================= 注册 ================= */

  registerApp({
    id: 'maildesk',
    name: '邮箱台',
    title: '邮箱台 · 批量信箱与收件',
    sub: '批量申请临时信箱，集中收取验证码与链接',
    icon: ICON,
    order: 18,
    cls: 'maildesk',
    win: 'maildeskWin',
    css: ['apps/maildesk/app.css'],

    mount: function (body) {
      /* 已经画过：只刷新数据，不重建 DOM —— 否则正在读的那封信、滚动位置、
         输入框里的前缀都会被冲掉。 */
      if (body.dataset.ready === '1' && els && els.root && body.contains(els.root)) {
        renderAll();
        renderAi();
        checkNet();
        ensureTimer();
        return;
      }

      loadDomainCache();
      body.innerHTML = BODY;
      cacheEls(body);
      wire();
      syncForm();
      body.dataset.ready = '1';

      renderAll();
      renderAi();
      ensureTimer();
      checkNet();
      if (S.boxes.length) setStatus('已恢复 ' + S.boxes.length + ' 个信箱');
      setTimeout(function () { try { els.count.focus(); } catch (e) { /* 忽略 */ } }, 80);
    }
  });
})();

/* ---- apps/modeldesk/app.js ---- */
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

/* ---- apps/models/app.js ---- */
/* 模型 —— 引擎与 Provider 的控制台。
 *
 * 它和别的 App 有一处不同：`open()` 里**自己再调一次 deskMountApp**。
 * 这不是多余的 —— models 这个入口原来就绕过了 openDeskApp 的通用路径
 * （见 desk-shell.js 里那句 `deskMountApp($('modelsWin'), m.title, m.sub)`），
 * 因为它要保证「先切页面，再渲染控制台」，而 renderModelsConsole 会重画整棵树。
 * 迁移时原样保留这条，否则会出现「翻过去了但内容还是上一轮的状态」。
 *
 * 四个宿主节点：硬件 / 引擎 / ComfyUI / 模型种类。
 */
(function () {
  'use strict';

  registerApp({
    id: 'models',
    name: '模型',
    title: '模型',
    barTitle: '模型控制台',
    sub: '引擎与 Provider',
    glyph: 'model',
    order: 10,
    win: 'modelsWin',
    body:
      '<div class="mc-hard" id="mcHard"></div>' +
      '<div class="mc-eng" id="mcEng"></div>' +
      '<div class="mc-eng" id="mcComfy"></div>' +
      '<div class="mc-kinds" id="mcKinds"></div>',
    open: function (win) {
      /* 用传进来的 win，不再按 id 反查 —— 少一次 getElementById，也避免名字改了两处不一致 */
      deskMountApp(win, '模型', '引擎与 Provider');
      if (typeof renderModelsConsole === 'function') renderModelsConsole();
    }
  });
})();

/* ---- apps/multiview/body.js ---- */
/* 视图工坊（多视图）的窗口 DOM —— 桌面 App 与独立页 multiview.html **共用这一份**。
 *
 * 为什么单独放一个文件：这个 App 是唯一同时有独立页的（multiview.html，双击就能用、
 * 不需要桌面）。以前 index.html 和 multiview.html 里各抄了一份 .mv-wrap（209 / 220 行、
 * 96 个 id），改一个控件要改两处，漏一处就是「桌面能用、独立页少个按钮」。
 * 现在两边都从这里取，**只有一份**。
 *
 * ⚠ 两份原来只差空态的两句文案（独立页写「点左上「＋ 文件」」，但那个按钮其实在左侧栏里，
 *   文案是错的）。统一成桌面版的说法：左边选一个 -> ＋ 文件 -> 拖进来，三种入口都覆盖到。
 *
 * ⚠ 桌面侧由 apps/multiview/app.js 的 registerApp() 取用（tools/app-scan.js 会把本文件
 *   先内联进 manifest）；独立页自己 <script src="apps/multiview/body.js"> 再赋给宿主。
 *   所以这里**只定义常量，不调 registerApp** —— 独立页没有那个函数。
 *
 * 全篇没有反引号 / ${ / 反斜杠（生成时校验过），所以能直接放进模板字符串。
 */
window.MV_BODY = `
<div class="mv-wrap">

          <aside class="mv-side">
            <div class="mv-side-head">
              <span class="mv-side-t">模型</span>
              <button type="button" class="mv-mini" id="mvOpenFile" title="打开本机的 glb / gltf / obj">＋ 文件</button>
            </div>
            <div class="mv-list" id="mvList"></div>
            <div class="mv-side-foot">
              <button type="button" class="mv-mini wide" id="mvOpenLib">打开模型库</button>
            </div>
            <input type="file" id="mvFile" class="hidden" accept=".glb,.gltf,.obj">
          </aside>

          <section class="mv-main">
            <div class="mv-ctl">
              <div class="mv-row">
                <span class="mv-lab">视图</span>
                <div class="mv-chips" id="mvPresets"></div>
                <div class="mv-chips" id="mvViews"></div>
              </div>
              <div class="mv-row">
                <span class="mv-lab">模式</span>
                <div class="mv-seg" id="mvModes"></div>
                <span class="mv-lab">相机</span>
                <div class="mv-seg" id="mvCams"></div>
                <span class="mv-lab">画布</span>
                <div class="mv-seg" id="mvSizes"></div>
              </div>
            </div>

            <details class="mv-more" id="mvMore">
              <summary title="画布级参数：列数、间距、留白、线宽——它们不属于任何一层">画布</summary>
              <div class="mv-more-body">
                <div class="mv-field"><span>列数</span><div class="mv-seg" id="mvCols"></div></div>
                <div class="mv-field"><span>铺满</span><div class="mv-seg" id="mvCompacts"></div></div>
                <div class="mv-field"><span>间距</span><input type="range" id="mvGap" min="0" max="48" step="2"><b id="mvGapV">0</b></div>
                <div class="mv-field"><span>留白</span><input type="range" id="mvMargin" min="100" max="160" step="2"><b id="mvMarginV">108</b></div>
                <div class="mv-field"><span>线宽</span><input type="range" id="mvLineW" min="4" max="60" step="2"><b id="mvLineWV">14</b></div>
                <button type="button" class="mv-mini" id="mvReset" title="把画布与各层参数恢复默认（不动已载入的模型）">恢复默认参数</button>
              </div>
            </details>

            <div class="mv-stage-wrap" id="mvStageHost">
              <div class="mv-stage" id="mvStage">
                <div class="mv-stage-hud" id="mvStageHud">
                  <b id="mvHudName">未载入</b>
                  <i id="mvHudMeta">等待模型</i>
                </div>
                <div class="mv-empty" id="mvEmpty">
                  <div class="mv-empty-t">左边选一个模型，或拖一个 glb / obj 进来</div>
                  <div class="mv-empty-s">OBJ 的四边形面按原始拓扑画线框，不会出现三角化的对角线。</div>
                </div>
                <img id="mvOut" alt="多视图结果" draggable="false" class="hidden">
                <div class="mv-pick hidden" id="mvPick"></div>
              </div>
            </div>

            <div class="mv-bar">
              <span class="mv-info" id="mvInfo"></span>
              <button type="button" class="btn sm" id="mvPreview">3D 预览</button>
              <button type="button" class="btn sm" id="mvSplit" disabled>AI 拆件</button>
              <button type="button" class="btn sm" id="mvSaveLib">存入图库</button>
              <button type="button" class="btn sm" id="mvDlCell" disabled>下载这格</button>
              <button type="button" class="btn sm" id="mvDlAll" disabled>下载整图</button>
              <button type="button" class="btn sm primary" id="mvRender">重新渲染</button>
            </div>
          </section>

          <!-- 右：图层 / 导出 / 投射 三个工作面板。做成互斥页签，
               一列堆三块面板时导出按钮会被挤到滚动区外，专业工具不该这样。 -->
      <aside class="mv-right">
        <div class="mv-right-tabs" id="mvRightTabs" role="tablist">
          <button type="button" class="mv-rtab is-on" data-mv-tab="layers" role="tab" aria-selected="true">图层</button>
          <button type="button" class="mv-rtab" data-mv-tab="export" role="tab" aria-selected="false">导出</button>
          <button type="button" class="mv-rtab" data-mv-tab="proj" role="tab" aria-selected="false">投射</button>
        </div>
        <div class="mv-right-panes">

          <!-- ① 图层：上层盖下层的心理模型，与 PS 一致 -->
          <div class="mv-right-pane is-on" data-pane="layers">
            <div class="mv-layers">
              <div class="mv-ly-head">图层<span class="mv-ly-hint" title="点一行展开它自己的属性面板；拖动可以任意换序，3D 和 2D 之间也能互换">点行调属性 · 随便拖</span></div>
              <div class="mv-ly-list" id="mvLayerList"></div>
            </div>
            <!-- 图层的眼睛驱动这些 input；留在这里是为了「state 只有一条写入口」 -->
            <div class="mv-hidden-checks">
      <input type="checkbox" id="mvWire">
      <input type="checkbox" id="mvAngleWire">
      <input type="checkbox" id="mvUvEdge">
      <input type="checkbox" id="mvUvIsland">
      <input type="checkbox" id="mvOutline">
      <input type="checkbox" id="mvDepthEdge">
      <input type="checkbox" id="mvDepthGray">
      <input type="checkbox" id="mvLabels">
      <input type="checkbox" id="mvBg">
      <input type="checkbox" id="mvGrade">
            </div>
            <!-- 层参数的控件都住在这里，被选中/展开的那一层才搬进它自己的面板。
                 不另建一套 input：id 仍是 FIELDS 认的那一个，写入口只有一条。 -->
            <div class="mv-prop-pool" id="mvPropPool">
          <div class="mv-field"><span>背景色</span><input type="color" id="mvBgColor" value="#ffffff"></div>
          <div class="mv-field"><span>折角</span><input type="range" id="mvWireAngle" min="0" max="90" step="1"><b id="mvWireAngleV">30°</b></div>
          <div class="mv-field" title="角度线框的整体粗细（相对「线宽」的倍率）。只想让结构线更醒目、又不想把普通线框一起加粗时用它"><span>角度粗细</span><input type="range" id="mvCreaseWidth" min="20" max="300" step="10"><b id="mvCreaseWidthV">1.0×</b></div>
          <div class="mv-field" title="随折角的粗细梯度：0% 所有结构线等宽；100% 折得越狠越粗（90° 硬边最粗，刚过阈值的平缓边约 1/4 宽）"><span>随角度</span><input type="range" id="mvCreaseTaper" min="0" max="100" step="5"><b id="mvCreaseTaperV">50%</b></div>
          <div class="mv-field" title="角度线框的颜色：换个颜色才分得清「哪几条是结构线、哪几条是普通线框」"><span>角度线色</span><input type="color" id="mvCreaseColor" value="#2b2b2b"></div>
          <div class="mv-field" title="相邻像素的深度差阈值（占整个视锥深度的百分比）：往左描得更多，往右只留最强的边。分辨率变了会自动补偿，换单格尺寸不用重调"><span>深度差</span><input type="range" id="mvDepthThresh" min="0" max="100" step="1"><b id="mvDepthThreshV">1.1%</b></div>
          <div class="mv-field" title="深度灰的映射窗口：100% 用模型完整的前后跨度，调小只保留靠近相机的一段（远处压成黑）。模型前后差得小、灰图看不出一层一层时，把它调小"><span>深度范围</span><input type="range" id="mvDepthGrayRange" min="10" max="100" step="5"><b id="mvDepthGrayRangeV">100%</b></div>
          <div class="mv-field" title="「无限远」的颜色：背景（没有表面）和格间距都填它。默认黑，跟「近白远黑」接得上；改成白就得到反过来的那一版（近黑远白）"><span>远景色</span><input type="color" id="mvDepthGrayBg" value="#000000"></div>
          <div class="mv-field" title="饱和度：0 是黑白，100% 是原样，200% 是色彩更艳。后期处理层调的是最终输出图像"><span>饱和度</span><input type="range" id="mvGradeSat" min="0" max="200" step="5"><b id="mvGradeSatV">100%</b></div>
          <div class="mv-field" title="对比度：100% 是原样，往上更硬朗、往下更灰雾"><span>对比度</span><input type="range" id="mvGradeContrast" min="0" max="200" step="5"><b id="mvGradeContrastV">100%</b></div>
          <div class="mv-field" title="亮度：正值提亮、负值压暗，范围 ±100"><span>亮度</span><input type="range" id="mvGradeBright" min="-100" max="100" step="5"><b id="mvGradeBrightV">0</b></div>
            </div>
          </div>

          <!-- ② 导出：画布固定正方形 2K/4K，深度 / 遮罩供 AI 回流 -->
          <div class="mv-right-pane hidden" data-pane="export">
            <aside class="mv-export">
              <div class="mv-ex-head">导出</div>
              <div class="mv-ex-row">
                <select class="mv-sel" id="mvExSize" title="画布尺寸（正方形）· 预览与导出一致">
                  <option value="2048">2K · 2048</option>
                  <option value="4096">4K · 4096</option>
                </select>
                <select class="mv-sel" id="mvExGap" title="格间距">
                  <option value="0">无间距</option>
                  <option value="16">16 px</option>
                  <option value="32">32 px</option>
                  <option value="64">64 px</option>
                </select>
              </div>
              <div class="mv-ex-info" id="mvExInfo"></div>
              <div class="mv-ex-stats" id="mvExStats"></div>
              <!-- 导出反馈：忙碌时黄点+扫光进度，成功绿点，失败红点，结果留到下一次导出 -->
              <div class="mv-ex-status hidden" id="mvExStatus"><i></i><span id="mvExStatusTxt"></span></div>
              <button type="button" class="btn sm primary" id="mvExPreview" disabled>预览导出结果</button>
              <button type="button" class="btn sm" id="mvExColor" disabled>导出视图 PNG</button>
              <button type="button" class="btn sm" id="mvExDepth" disabled>导出深度图</button>
              <button type="button" class="btn sm" id="mvExMask" disabled>导出遮罩图</button>
            </aside>
          </div>

          <!-- ③ 投射：生图 → UV 贴图。参数常驻在这里，重新投射不必重选文件 -->
          <div class="mv-right-pane hidden" data-pane="proj">
            <aside class="mv-export mv-proj-entry">
              <div class="mv-ex-head">投射纹理</div>
              <div class="mv-ex-info">AI 生成的网格图逐格反投回模型，按 UV 岛归类采样，烘成一张贴图</div>
              <div class="mv-ex-row">
                <select class="mv-sel" id="mvProjSize" title="贴图分辨率（UV 空间）">
                  <option value="1024">1K · 1024</option>
                  <option value="2048" selected>2K · 2048</option>
                  <option value="4096">4K · 4096</option>
                </select>
                <button type="button" class="btn sm primary" id="mvProj" disabled title="选一张 AI 生成的网格图（或直接 Ctrl+V 粘贴截图）">导入生图投射</button>
                <button type="button" class="btn sm" id="mvProjReproj" disabled title="用上次导入的图按当前参数重新烘一次">重新投射上次的图</button>
              </div>
              <input type="file" id="mvProjFile" class="hidden" accept="image/*">
              <div class="mv-ex-head">投射参数</div>
              <div class="mv-proj-set">
                <div class="mv-field" title="岛的边界往内缩多少 texel：躲开 AI 重绘造成的轮廓漂移。0 = 完全贴边，边缘更容易串色"><span>边缘内缩</span><input type="range" id="mvProjInset" min="0" max="4" step="1"><b id="mvProjInsetV">1 px</b></div>
                <div class="mv-field" title="次优视图补角的触发门槛（占最佳视图暴露面积的比例）。0 = 只从最佳视图采样；调高 = 少补、边缘更硬"><span>补角阈值</span><input type="range" id="mvProjFill" min="0" max="60" step="5"><b id="mvProjFillV">15%</b></div>
                <div class="mv-field" title="把岛边缘的颜色向外扩散几个 texel，抵消实时渲染的接缝。0 = 严格保持透明边界"><span>接缝扩散</span><input type="range" id="mvProjBleed" min="0" max="8" step="1"><b id="mvProjBleedV">0 px</b></div>
                <label class="mv-check mv-proj-check" title="有些模型的 UV V 轴与导出图相反：贴图上下颠倒时勾上它"><input type="checkbox" id="mvProjFlipV"> V 轴翻转</label>
              </div>
              <div class="mv-ex-info" id="mvProjQuick">选一张与当前导出布局对齐的生图</div>
            </aside>
          </div>

        </div>
      </aside>

          <!-- AI 拆件弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvSplitPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">AI 拆件</span>
                <span class="mv-split-sub" id="mvSplitSub"></span>
                <button type="button" class="mv-split-x" id="mvSplitClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-split-row">
                  <span class="mv-split-lab">分成</span>
                  <input type="text" id="mvSplitParts" class="mv-split-in" placeholder="面部和脖子、头发和头饰、身体">
                  <span class="mv-split-lab">候选岛</span>
                  <input type="range" id="mvSplitMax" min="20" max="240" step="10" value="120">
                  <b id="mvSplitMaxV">120</b>
                  <button type="button" class="btn sm primary" id="mvSplitRun">开始拆件</button>
                </div>
                <div class="mv-split-note" id="mvSplitInfo"></div>
                <div class="mv-split-imgs">
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">候选 UV 岛（编号给 AI 寻址）</span>
                    <img id="mvSplitAtlas" alt="候选 UV 岛图" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">拆件结果（颜色对应部件）</span>
                    <img id="mvSplitViews" alt="拆件结果预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-list" id="mvSplitList"></div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm" id="mvSplitDlGlb" disabled>下载整件 GLB</button>
                  <button type="button" class="btn sm" id="mvSplitSaveLib" disabled>存入模型库</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 投射纹理弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvProjPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">投射纹理</span>
                <span class="mv-split-sub" id="mvProjSub"></span>
                <button type="button" class="mv-split-x" id="mvProjClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-proj-body">
                  <aside class="mv-proj-side">
                    <span class="mv-split-cap">生图源</span>
                    <div class="mv-proj-src" id="mvProjSrcBox">
                      <img id="mvProjSrc" alt="生图源">
                      <em id="mvProjSrcEmpty">还没有导入</em>
                    </div>
                    <div class="mv-proj-stat" id="mvProjStats"></div>
                    <div class="mv-proj-tip">参数在右侧「投射」页调整<br>改完点「重新投射」即可复烘</div>
                  </aside>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">UV 贴图（透明 = 未投射的区域）</span>
                    <img id="mvProjOut" alt="投射纹理结果" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">上色预览（材质模式 · 自动生成）</span>
                    <img id="mvProjPrev" alt="投射上色预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-note" id="mvProjInfo"></div>
                <div class="mv-ex-status hidden" id="mvProjStatus"><i></i><span id="mvProjStatusTxt"></span></div>
                <div class="mv-proj-prog hidden" id="mvProjProg">
                  <i id="mvProjProgBar"></i>
                  <span id="mvProjProgTxt">投射中…</span>
                </div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm primary" id="mvProjDl" disabled>下载贴图 PNG</button>
                  <button type="button" class="btn sm" id="mvProjGlb" disabled>下载上色 GLB</button>
                  <button type="button" class="btn sm" id="mvProjLib" disabled>存入图库</button>
                  <button type="button" class="btn sm" data-mv-proj-reproj disabled title="按右侧「投射」页的当前参数重新烘一次">重新投射</button>
                </div>
              </div>
            </div>
          </div>
          </div>
`;

/* ---- apps/multiview/app.js ---- */
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

/* ---- apps/player/app.js ---- */
/* 视频库 —— 收「已经攒到本地」的影音，并就地播放。
 *
 * 文件不进浏览器存储（一集就几个 G），而是落在 userData/media，
 * 由主进程的 openagi-media:// 协议流式读——这样进度条能拖，内存也不涨。
 *
 * 和图库配对：图库里是「造出来的图」，视频库里是「攒下来的影音」。
 * 它只播本地已有的文件（媒体库目录），不负责去网上抓内容 —— 那个「直链下载」
 * 是给人下自己有权保存的东西的入口，不是搜索器。
 *
 * ⚠ 它被切走时会 stopPlayback()（见 js/player.js）：那是它自己的生命周期决策，
 *   迁移只搬 DOM，不碰行为。
 */
(function () {
  'use strict';

  registerApp({
    id: 'player',
    name: '视频库',
    title: '视频库',
    sub: '本地的视频与音频',
    glyph: 'video',
    order: 9,
    cls: 'player',
    win: 'playerWin',
    body: `
        <div class="pl-wrap">
          <div class="pl-stage" id="plStage">
            <div class="pl-screen" id="plScreen">
              <video id="plVideo" playsinline preload="metadata"></video>

              <div class="pl-empty" id="plEmpty">
                <div class="pl-empty-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/><path d="M4.4 8.2h1.1M4.4 12h1.1M4.4 15.8h1.1M18.5 8.2h1.1M18.5 12h1.1M18.5 15.8h1.1"/></svg>
                </div>
                <div class="pl-empty-t">视频库还是空的</div>
                <div class="pl-empty-s">用右边「导入文件夹」加一整部，或「＋ 直链」下一集进来</div>
                <div class="pl-empty-acts">
                  <button class="pl-empty-btn primary" id="plEmptyImport">导入文件</button>
                  <button class="pl-empty-btn" id="plEmptyDir">导入文件夹</button>
                </div>
              </div>

              <div class="pl-osd" id="plOsd" aria-live="polite"></div>

              <div class="pl-help hidden" id="plHelp">
                <div class="pl-help-card" role="dialog" aria-label="快捷键">
                  <div class="pl-help-h">
                    <span>快捷键</span>
                    <button class="pl-help-x" id="plHelpX" type="button" aria-label="关闭">×</button>
                  </div>
                  <div class="pl-help-grid">
                    <kbd>空格</kbd><span>播放 / 暂停</span>
                    <kbd>← →</kbd><span>快退 / 快进 5 秒</span>
                    <kbd>J L</kbd><span>快退 / 快进 10 秒</span>
                    <kbd>↑ ↓</kbd><span>音量 +5% / −5%</span>
                    <kbd>M</kbd><span>静音切换</span>
                    <kbd>C</kbd><span>字幕开关</span>
                    <kbd>&lt; &gt;</kbd><span>减速 / 加速</span>
                    <kbd>PgUp PgDn</kbd><span>上一集 / 下一集</span>
                    <kbd>F2</kbd><span>重命名选中项</span>
                    <kbd>Delete</kbd><span>移到回收站</span>
                    <kbd>F</kbd><span>全屏</span>
                    <kbd>?</kbd><span>打开这张面板</span>
                  </div>
                  <div class="pl-help-foot">双击画面也能进全屏；F 或 Esc 退出。</div>
                </div>
              </div>
            </div>

            <div class="pl-head">
              <div class="pl-head-l">
                <div class="pl-head-t" id="plHeadTitle">未选择媒体</div>
                <div class="pl-head-s" id="plHeadSub">从右侧列表选一集开始播放</div>
              </div>
              <div class="pl-head-r">
                <span class="pl-badge" id="plHeadKind">视频</span>
                <span class="pl-badge" id="plHeadSize">—</span>
              </div>
            </div>

            <div class="pl-ctrl" id="plCtrl">
              <div class="pl-ctrl-seek">
                <div class="pl-seek-wrap" id="plSeekWrap">
                  <div class="pl-seek-rail">
                    <i class="pl-seek-buf" id="plSeekBuf"></i>
                    <i class="pl-seek-fill" id="plSeekFill"></i>
                  </div>
                  <input type="range" class="pl-seek" id="plSeek" min="0" max="1000" value="0" step="1" aria-label="播放进度">
                  <span class="pl-seek-tip" id="plSeekTip">0:00</span>
                </div>
                <span class="pl-time" id="plTime">0:00 / 0:00</span>
              </div>

              <div class="pl-ctrl-row">
                <div class="pl-ctrl-l">
                  <button class="pl-btn" id="plPrev" title="上一集（PgUp）" aria-label="上一集">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7 5h2.2v14H7zM19 5.6v12.8L9.6 12z"/></svg>
                  </button>
                  <button class="pl-btn pl-btn-main" id="plPlay" title="播放 / 暂停（空格）" aria-label="播放">
                    <svg class="pl-ico-play" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.4 19 12 8 18.6z"/></svg>
                    <svg class="pl-ico-pause hidden" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z"/></svg>
                  </button>
                  <button class="pl-btn" id="plNext" title="下一集（PgDn）" aria-label="下一集">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M14.8 5H17v14h-2.2zM5 5.6 14.4 12 5 18.4z"/></svg>
                  </button>
                  <span class="pl-ctrl-sep" aria-hidden="true"></span>
                  <button class="pl-btn pl-btn-skip" id="plBack10" title="后退 10 秒（J）" aria-label="后退 10 秒">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M11 6 5.2 12 11 18zM18 6l-5.8 6 5.8 6z"/></svg>
                  </button>
                  <button class="pl-btn pl-btn-skip" id="plFwd10" title="快进 10 秒（L）" aria-label="快进 10 秒">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M13 6l5.8 6L13 18zM6 6l5.8 6L6 18z"/></svg>
                  </button>
                </div>

                <div class="pl-ctrl-r">
                  <button class="pl-btn pl-cc is-off" id="plCc" title="字幕（C）" aria-label="字幕" aria-pressed="false" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.6" y="5" width="18.8" height="14" rx="3.2"/><text x="12" y="15.4" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none" font-family="Segoe UI,Arial,sans-serif">CC</text></svg>
                  </button>
                  <div class="pl-pop">
                    <button class="pl-btn pl-rate" id="plRate" title="播放速度（&lt; &gt;）" aria-haspopup="true" aria-expanded="false">1×</button>
                    <div class="pl-menu hidden" id="plRateMenu" role="menu" aria-label="播放速度">
                      <button type="button" class="pl-menu-i" data-rate="0.5" role="menuitem">0.5×</button>
                      <button type="button" class="pl-menu-i" data-rate="0.75" role="menuitem">0.75×</button>
                      <button type="button" class="pl-menu-i" data-rate="1" role="menuitem">1×</button>
                      <button type="button" class="pl-menu-i" data-rate="1.25" role="menuitem">1.25×</button>
                      <button type="button" class="pl-menu-i" data-rate="1.5" role="menuitem">1.5×</button>
                      <button type="button" class="pl-menu-i" data-rate="2" role="menuitem">2×</button>
                    </div>
                  </div>
                  <div class="pl-vol-wrap">
                    <button class="pl-btn" id="plMute" title="静音（M）" aria-label="静音">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3L11 6v12L7 14.5H4z"/><path class="pl-ico-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.4 7.4 0 0 1 0 10.4"/><path class="pl-ico-mute hidden" d="m15 10 4 4m0-4-4 4"/></svg>
                    </button>
                    <input type="range" class="pl-vol" id="plVol" min="0" max="100" value="100" step="1" aria-label="音量">
                  </div>
                  <button class="pl-btn" id="plPip" title="画中画" aria-label="画中画">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.8" y="4.8" width="18.4" height="14.4" rx="2.6"/><rect x="12.2" y="11.4" width="7" height="5.4" rx="1.4" fill="currentColor" stroke="none" opacity=".85"/></svg>
                  </button>
                  <button class="pl-btn" id="plFull" title="全屏（F）" aria-label="全屏">
                    <svg class="pl-ico-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
                    <svg class="pl-ico-exit hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <aside class="pl-side">
            <div class="pl-side-head">
              <div class="pl-side-title">
                <span class="pl-side-name">视频库</span>
                <span class="pl-count" id="plCount"></span>
              </div>
              <label class="pl-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.6 15.6 4.2 4.2"/></svg>
                <input type="search" id="plSearch" class="pl-search-in" placeholder="搜索文件名…" aria-label="搜索媒体">
                <button type="button" class="pl-search-x hidden" id="plSearchX" aria-label="清空搜索">×</button>
              </label>
              <div class="pl-folders" id="plFolders" role="tablist" aria-label="分组"></div>
            </div>
            <div class="pl-list-bar">
              <span class="pl-list-lab">播放列表</span>
              <button class="pl-sort" id="plSort" title="切换排序：名称 / 时间 / 大小">名称</button>
              <button class="pl-mini" id="plHelpBtn" title="快捷键（?）" aria-label="快捷键">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M9.7 9.4a2.4 2.4 0 1 1 3.1 2.3c-.7.3-.9.8-.9 1.5v.3"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/></svg>
              </button>
            </div>
            <div class="pl-list" id="plList" aria-label="播放列表"></div>
            <div class="pl-dl hidden" id="plDl">
              <input type="url" id="plDlUrl" class="pl-in" placeholder="粘贴视频直链（http/https，自己有权下载的）" aria-label="下载地址">
              <input type="text" id="plDlName" class="pl-in" placeholder="保存名（可留空，自动取链接末尾）" aria-label="保存名">
              <div class="pl-dl-row">
                <button class="btn sm primary" id="plDlGo">下载到本地</button>
                <button class="btn sm" id="plDlCancel">关闭</button>
                <span class="pl-dl-hint">只下你有权保存的内容</span>
              </div>
            </div>
            <div class="pl-prog hidden" id="plProg">
              <div class="pl-prog-bar"><i id="plProgBar"></i></div>
              <span class="pl-prog-txt" id="plProgTxt"></span>
              <button class="pl-prog-x" id="plProgX" title="取消下载">取消</button>
            </div>
            <div class="pl-foot">
              <button class="btn sm" id="plImport" title="从磁盘选文件（可多选）">导入文件</button>
              <button class="btn sm" id="plImportDir" title="选一个文件夹，按子文件夹分组成剧集">导入文件夹</button>
              <button class="btn sm" id="plDlOpen" title="粘贴直链下载">＋ 直链</button>
              <button class="btn sm" id="plDir" title="在资源管理器里打开媒体库目录">目录</button>
            </div>
          </aside>

          <!-- 文件操作菜单：右键或行尾「⋯」打开。只在桌面版显示改名 / 删除 / 定位 -->
          <div class="pl-ctx hidden" id="plCtx" role="menu" aria-label="文件操作">
            <button type="button" class="pl-ctx-i" data-act="play" role="menuitem">播放</button>
            <button type="button" class="pl-ctx-i" data-act="rename" role="menuitem">重命名<kbd>F2</kbd></button>
            <button type="button" class="pl-ctx-i" data-act="reveal" role="menuitem">在文件夹中显示</button>
            <button type="button" class="pl-ctx-i" data-act="copy" role="menuitem">复制文件名</button>
            <div class="pl-ctx-sep" role="separator"></div>
            <button type="button" class="pl-ctx-i danger" data-act="remove" role="menuitem">移到回收站<kbd>Del</kbd></button>
          </div>

          <!-- 删除确认：不用 window.confirm —— 它会把整个 App 卡住，也没法写清「进回收站」 -->
          <div class="pl-dialog hidden" id="plDialog">
            <div class="pl-dialog-card" role="dialog" aria-modal="true" aria-labelledby="plDialogT">
              <div class="pl-dialog-t" id="plDialogT"></div>
              <div class="pl-dialog-s" id="plDialogS"></div>
              <div class="pl-dialog-acts">
                <button type="button" class="pl-dialog-btn" id="plDialogCancel">取消</button>
                <button type="button" class="pl-dialog-btn danger" id="plDialogOk">移到回收站</button>
              </div>
            </div>
          </div>
        </div>
        <!-- 浏览器里打开（没有 Electron 媒体库）时的降级入口：只能临时播内存里的文件 -->
        <input type="file" id="plFile" class="hidden" multiple accept="video/*,audio/*">`,
    open: function () {
      if (typeof window.playerApp !== 'undefined' && typeof window.playerApp.open === 'function') window.playerApp.open();
    }
  });
})();

/* ---- apps/store/app.js ---- */
/* 模型商店 —— 用 Ollama 的羊驼头做图标。
 *
 * 那张 png 是「本地模型」这件事的通用符号，比再画一个抽象图标更容易一眼认出来，
 * 所以这里用 icon（整段 HTML）而不是 glyph（内置 SVG 图形）。
 *
 * body 里的 #mcStore 是宿主节点，卡片由 js/model-store.js 渲染。
 */
(function () {
  'use strict';

  registerApp({
    id: 'store',
    name: '模型商店',
    title: '模型商店',
    sub: '本地模型 · 语音 · 一键安装',
    icon: '<img class="desk-app-img" src="vendor/ollama-llama.png" alt="" draggable="false">',
    order: 3,
    cls: 'store',
    win: 'storeWin',
    body: '<div class="mc-store" id="mcStore"></div>',
    open: function () {
      if (typeof openModelStore === 'function') openModelStore();
    }
  });
})();

/* ---- apps/studio/body.js ---- */
/* 剪辑台的窗口 DOM。逻辑在 app.js，样式在 app.css。
 *
 * 结构沿用专业剪辑器的四区布局：
 *   顶栏（项目 / 撤销 / 分割 / 导出）
 *   左素材区（媒体 / 文字 / 音频 / 滤镜）
 *   中预览（画面 + 播放控制）
 *   右检查器（选中片段的画面 / 音频 / 动画参数）
 *   底时间线（标尺 + 四条轨道 + 播放头）
 * 只写 DOM，不写内联样式与内联事件 —— 样式全部走 .st-* 前缀的 app.css。
 */
window.STUDIO_BODY = `
<div class="st-app" id="stApp">
  <header class="st-top">
    <div class="st-brand">
      <span class="st-brand-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4"/><path d="M8.2 4.6v14.8M15.8 4.6v14.8"/><path d="m5.2 9.4 3.2 4.2M5.2 15.4l3.2-4.2"/></svg>
      </span>
      <div class="st-brand-txt">
        <b>剪辑台</b>
        <span id="stProjName">未命名项目</span>
      </div>
    </div>

    <div class="st-top-tools">
      <button type="button" class="st-tbtn" id="stUndo" title="撤销（Ctrl+Z）" aria-label="撤销">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5h9.3a5.2 5.2 0 0 1 0 10.4H9.6"/></svg>
      </button>
      <button type="button" class="st-tbtn" id="stRedo" title="重做（Ctrl+Shift+Z）" aria-label="重做">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7l4.5 4.5L15 16"/><path d="M19.5 11.5h-9.3a5.2 5.2 0 0 0 0 10.4H15"/></svg>
      </button>
      <i class="st-vsep" aria-hidden="true"></i>
      <button type="button" class="st-tbtn" id="stSplit" title="在播放头处分割（S）" aria-label="分割">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6M12 15v6"/><circle cx="7" cy="18.2" r="2.3"/><circle cx="17" cy="18.2" r="2.3"/><path d="M8.7 16.3 15.4 5.8M15.3 16.3 8.6 5.8"/></svg>
      </button>
      <button type="button" class="st-tbtn" id="stDup" title="复制片段（Ctrl+D）" aria-label="复制片段">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.2"/><path d="M15.6 5.4H6.6a2.2 2.2 0 0 0-2.2 2.2v9"/></svg>
      </button>
      <button type="button" class="st-tbtn" id="stDel" title="删除片段（Delete）" aria-label="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 6.8h14.4"/><path d="M9.6 6.8V4.6h4.8v2.2"/><path d="m6.6 6.8.9 12.4a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.9-12.4"/><path d="M10.4 10.4v6.6M13.6 10.4v6.6"/></svg>
      </button>
    </div>

    <div class="st-top-right">
      <span class="st-savestate" id="stSaveState">已保存</span>
      <button type="button" class="st-mini st-icomin" id="stProjExport" title="把整个项目导出为 .hfstudio 文件" aria-label="导出项目">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8h7.2l4.4 4.4v12H6.2z"/><path d="M13.4 3.8v4.4h4.4"/><path d="M12 11v5.2"/><path d="m9.6 13.8 2.4 2.4 2.4-2.4"/></svg>
      </button>
      <button type="button" class="st-mini st-icomin" id="stProjImport" title="导入 .hfstudio / .json 项目文件" aria-label="导入项目">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8h7.2l4.4 4.4v12H6.2z"/><path d="M13.4 3.8v4.4h4.4"/><path d="M12 16.4v-5.2"/><path d="m9.6 13.6 2.4-2.4 2.4 2.4"/></svg>
      </button>
      <button type="button" class="st-ghost st-icomin" id="stNew" title="新建项目" aria-label="新建项目">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8h7.2l4.4 4.4v12H6.2z"/><path d="M13.4 3.8v4.4h4.4"/><path d="M12 10.8v5.4M9.3 13.5h5.4"/></svg>
      </button>
      <button type="button" class="st-primary" id="stExport">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.6 10.6 4.4 4.4 4.4-4.4"/><path d="M4.6 19.4h14.8"/></svg>
        导出
      </button>
    </div>
  </header>

  <nav class="st-menubar" id="stMenuBar" aria-label="菜单栏">
    <button type="button" class="st-menu-btn" data-menu="file">文件</button>
    <button type="button" class="st-menu-btn" data-menu="edit">编辑</button>
    <button type="button" class="st-menu-btn" data-menu="view">视图</button>
    <button type="button" class="st-menu-btn" data-menu="help">帮助</button>
    <span class="st-menubar-note">本地剪辑 · 素材不上传</span>
  </nav>

  <div class="st-main">
    <aside class="st-left">
      <div class="st-tabs" id="stTabs" role="tablist" aria-label="素材面板">
        <button type="button" class="st-tab on" data-panel="media" role="tab" aria-selected="true">媒体</button>
        <button type="button" class="st-tab" data-panel="text" role="tab" aria-selected="false">文字</button>
        <button type="button" class="st-tab" data-panel="audio" role="tab" aria-selected="false">音频</button>
        <button type="button" class="st-tab" data-panel="fx" role="tab" aria-selected="false">滤镜</button>
      </div>

      <div class="st-panels">
        <section class="st-panel" data-panel="media">
          <div class="st-libbar">
            <label class="st-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.6 15.6 4.2 4.2"/></svg>
              <input type="search" id="stMediaSearch" placeholder="搜索素材…" aria-label="搜索素材">
            </label>
            <button type="button" class="st-mini st-icomin" id="stLibOpen" title="从视频库添加" aria-label="从视频库添加">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.2" width="7.4" height="13.6" rx="1.6"/><rect x="13.6" y="5.2" width="7.4" height="13.6" rx="1.6"/><path d="M6.7 8.8v2.2M17.3 8.8v2.2"/></svg>
            </button>
          </div>
          <div class="st-fchips" id="stMediaFilter" role="group" aria-label="素材类型筛选">
            <button type="button" class="st-fchip on" data-fk="all" aria-pressed="true">全部</button>
            <button type="button" class="st-fchip" data-fk="video" aria-pressed="false">视频</button>
            <button type="button" class="st-fchip" data-fk="image" aria-pressed="false">图片</button>
            <button type="button" class="st-fchip" data-fk="audio" aria-pressed="false">音频</button>
          </div>
          <button type="button" class="st-ghost st-wide" id="stImport">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v10"/><path d="m8 9 4-4 4 4"/><path d="M4.6 15.4v2.6a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.6"/></svg>
            导入文件
          </button>
          <div class="st-media" id="stMediaGrid"></div>
          <div class="st-empty" id="stMediaEmpty">
            <div class="st-empty-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/></svg>
            </div>
            <b>还没有素材</b>
            <span>导入本机视频 / 音频，或从「视频库」挑一条</span>
          </div>
        </section>

        <section class="st-panel hidden" data-panel="text">
          <div class="st-hint">点一个预设，文字会落在播放头位置。</div>
          <div class="st-presets" id="stTextPresets"></div>
          <div class="st-hint">字幕：导入 SRT / VTT 自动落到字幕文字轨，导出按文字片段生成 SRT。</div>
          <div class="st-srtrow">
            <button type="button" class="st-ghost st-wide" id="stSrtImport">导入字幕（SRT / VTT）</button>
            <button type="button" class="st-ghost st-wide" id="stSrtExport">导出字幕（SRT）</button>
          </div>
          <input type="file" id="stSrtFile" accept=".srt,.vtt,text/plain" aria-label="选择字幕文件" hidden>
        </section>

        <section class="st-panel hidden" data-panel="audio">
          <div class="st-hint">音频素材与「媒体」共用；导入的音频会直接进素材库。</div>
          <button type="button" class="st-ghost st-wide" id="stImportAudio">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.4 17.2V6.2l8-1.6v10.6"/><circle cx="7" cy="17.6" r="2.4"/><circle cx="15" cy="15.6" r="2.4"/></svg>
            导入音频
          </button>
          <div class="st-media" id="stAudioGrid"></div>
        </section>

        <section class="st-panel hidden" data-panel="fx">
          <div class="st-hint">先选中时间线上的视频 / 图片片段，再点滤镜。</div>
          <div class="st-fxgrid" id="stFxGrid"></div>
        </section>
      </div>
    </aside>

    <section class="st-center">
      <div class="st-prev">
        <div class="st-frame" id="stFrame">
          <div class="st-layer" data-track="v1"></div>
          <div class="st-layer" data-track="v2"></div>
          <div class="st-texts" id="stTexts"></div>
          <div class="st-safe" id="stSafe" aria-hidden="true"></div>
          <div class="st-prev-empty" id="stPrevEmpty">
            <div class="st-empty-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/></svg>
            </div>
            <b>时间线还是空的</b>
            <span>把左侧素材拖到下面轨道，或双击素材自动追加</span>
          </div>
        </div>
      </div>

      <div class="st-transport">
        <div class="st-tc" id="stTc">00:00:00.00</div>
        <div class="st-trans-mid">
          <button type="button" class="st-tbtn" id="stGoStart" title="回到开头（Home）" aria-label="回到开头">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5.6 5h2.2v14H5.6zM19 5.6v12.8L9.4 12z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stPrevFrame" title="上一帧（,）" aria-label="上一帧">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8.4 6.4h2v11.2h-2zM17.6 6.4v11.2L9.8 12z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stBack1s" title="后退 1 秒（Shift+←）" aria-label="后退一秒">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M11 6 5.2 12 11 18zM18 6l-5.8 6 5.8 6z"/></svg>
          </button>
          <button type="button" class="st-play" id="stPlay" title="播放 / 暂停（空格）" aria-label="播放">
            <svg class="st-ico-play" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.4 19 12 8 18.6z"/></svg>
            <svg class="st-ico-pause hidden" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stFwd1s" title="前进 1 秒（Shift+→）" aria-label="前进一秒">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 6l5.8 6L13 18zM6 6l5.8 6L6 18z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stNextFrame" title="下一帧（.）" aria-label="下一帧">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13.6 6.4h2v11.2h-2zM6.4 6.4v11.2L14.2 12z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stGoEnd" title="跳到结尾（End）" aria-label="跳到结尾">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M16.2 5H18.4v14h-2.2zM5 5.6v12.8L14.6 12z"/></svg>
          </button>
        </div>
        <div class="st-trans-right">
          <button type="button" class="st-tbtn" id="stLoop" title="循环播放" aria-label="循环播放">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 9.4A5.4 5.4 0 0 1 10 4h7.4"/><path d="m14.6 1.8 2.8 2.2-2.8 2.2"/><path d="M19.4 14.6A5.4 5.4 0 0 1 14 20H6.6"/><path d="m9.4 22.2-2.8-2.2 2.8-2.2"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stMute" title="静音预览" aria-label="静音预览">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3L11 6v12L7 14.5H4z"/><path class="st-ico-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.4 7.4 0 0 1 0 10.4"/><path class="st-ico-mute hidden" d="m15 10 4 4m0-4-4 4"/></svg>
          </button>
          <input type="range" class="st-vol" id="stVol" min="0" max="100" step="1" value="100" aria-label="预览音量">
          <div class="st-level" id="stLevel" title="主输出电平（仅在播放时跳动）" aria-label="主输出电平"><i></i></div>
        </div>
      </div>
    </section>

    <aside class="st-right">
      <div class="st-insp" id="stInspector"></div>
    </aside>
  </div>

  <div class="st-tl" id="stTimeline">
    <div class="st-tl-bar">
      <div class="st-tl-name">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 6.4h16.8M3.6 12h16.8M3.6 17.6h16.8"/><circle cx="9" cy="6.4" r="1.7" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="7.4" cy="17.6" r="1.7" fill="currentColor" stroke="none"/></svg>
        时间线
        <span class="st-dur" id="stDur">00:00</span>
      </div>
      <div class="st-tl-tools">
        <button type="button" class="st-tbtn sm on" id="stToolSelect" title="选择工具（V）" aria-label="选择工具">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 3.4 18.2 12l-5.1.9 2.9 6.1-2.2 1-2.9-6.1L6 17.6z"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stToolBlade" title="剃刀工具（B）：点击片段在指针处分割" aria-label="剃刀工具">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4v6.2M12 14.4v6.2"/><circle cx="7.4" cy="17.6" r="2.2"/><circle cx="16.6" cy="17.6" r="2.2"/><path d="m9 15.8 6.2-9.2M15 15.8 8.8 6.6"/></svg>
        </button>
        <span class="st-vsep" aria-hidden="true"></span>
        <button type="button" class="st-tbtn sm" id="stAddV" title="新增视频轨" aria-label="新增视频轨">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="5.2" width="12.2" height="13.6" rx="2.2"/><path d="M6.6 5.2v13.6M11.2 5.2v13.6"/><path d="M19 8.8v6.8M15.6 12.2h6.8"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stAddT" title="新增文字轨" aria-label="新增文字轨">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 5.4h9.6M9.4 5.4v13.2M7 18.6h4.8"/><path d="M19 8.8v6.8M15.6 12.2h6.8"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stAddA" title="新增音频轨" aria-label="新增音频轨">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 10.4v3.2M6.4 8v8M9.6 5.6v12.8M12.8 8.8v6.4"/><path d="M19 8.8v6.8M15.6 12.2h6.8"/></svg>
        </button>
        <span class="st-vsep" aria-hidden="true"></span>
        <button type="button" class="st-tbtn sm on" id="stSnap" title="磁吸对齐（吸附播放头、标记与相邻片段边缘）" aria-label="磁吸对齐">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 4.6v6.8a6.8 6.8 0 0 0 13.6 0V4.6"/><path d="M5.2 9.2h4.2M14.6 9.2h4.2"/></svg>
        </button>
        <span class="st-tlhint">滚轮平移 · Ctrl+滚轮缩放</span>
        <button type="button" class="st-tbtn sm" id="stZoomFit" title="适配时间线（F）" aria-label="适配时间线">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 8.4V4.8h3.6M19.8 8.4V4.8h-3.6M4.2 15.6v3.6h3.6M19.8 15.6v3.6h-3.6"/><path d="M8.6 12h6.8"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stZoomOut" title="缩小" aria-label="缩小">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="5.8"/><path d="m14.8 14.8 4.4 4.4M8.4 10.6h4.4"/></svg>
        </button>
        <input type="range" class="st-zoom" id="stZoom" min="32" max="240" step="4" value="80" aria-label="时间线缩放">
        <button type="button" class="st-tbtn sm" id="stZoomIn" title="放大" aria-label="放大">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="5.8"/><path d="m14.8 14.8 4.4 4.4M8.4 10.6h4.4M10.6 8.4v4.4"/></svg>
        </button>
        <span class="st-zoomval" id="stZoomVal">80</span>
      </div>
    </div>
    <div class="st-tl-body">
      <div class="st-heads" id="stHeads"></div>
      <div class="st-scroll" id="stScroll">
        <div class="st-inner" id="stInner">
          <div class="st-ruler" id="stRuler"></div>
          <div class="st-rows" id="stRows"></div>
          <div class="st-drop hidden" id="stDrop"></div>
          <div class="st-range hidden" id="stRange" aria-hidden="true"><b class="st-range-in"></b><b class="st-range-out"></b></div>
          <div class="st-marquee hidden" id="stMarquee" aria-hidden="true"></div>
          <div class="st-playhead" id="stPlayhead"><b></b></div>
        </div>
      </div>
    </div>
  </div>

  <footer class="st-status" id="stStatus" aria-label="状态栏">
    <span class="st-st-dot" aria-hidden="true"></span>
    <span id="stStClips">0 片段</span>
    <span class="st-st-sep" aria-hidden="true"></span>
    <span id="stStSel">未选中</span>
    <span class="st-st-sep" aria-hidden="true"></span>
    <span id="stStTracks">4 轨道</span>
    <span class="st-st-grow"></span>
    <span id="stStTool">选择工具</span>
    <span class="st-st-sep" aria-hidden="true"></span>
    <span id="stStZoom">80 px/s</span>
    <span class="st-st-sep" aria-hidden="true"></span>
    <span id="stStDur2">00:00</span>
  </footer>

  <input type="file" id="stProjFile" accept=".hfstudio,.json,application/json" aria-label="导入项目文件" hidden>

  <div class="st-modal hidden" id="stLibModal">
    <div class="st-modal-card wide" role="dialog" aria-modal="true" aria-label="从视频库添加">
      <div class="st-modal-h">
        <b>添加素材</b>
        <button type="button" class="st-modal-x" data-close="stLibModal" aria-label="关闭">×</button>
      </div>
      <div class="st-libtabs" role="tablist" aria-label="素材来源">
        <button type="button" class="st-libtab on" data-libtab="media" role="tab" aria-selected="true">视频库</button>
        <button type="button" class="st-libtab" data-libtab="asset" role="tab" aria-selected="false">图库</button>
      </div>
      <div class="st-modal-body">
        <div class="st-libsearch">
          <input type="search" id="stLibSearch" placeholder="搜索素材…" aria-label="搜索素材">
          <span class="st-mut" id="stLibCount"></span>
        </div>
        <div class="st-liblist" id="stLibList"></div>
      </div>
      <div class="st-modal-f">
        <button type="button" class="st-ghost" data-close="stLibModal">取消</button>
        <button type="button" class="st-primary" id="stLibAdd" disabled>加入素材库</button>
      </div>
    </div>
  </div>

  <div class="st-modal hidden" id="stExportModal">
    <div class="st-modal-card" role="dialog" aria-modal="true" aria-label="导出视频">
      <div class="st-modal-h">
        <b>导出视频</b>
        <button type="button" class="st-modal-x" data-close="stExportModal" aria-label="关闭">×</button>
      </div>
      <div class="st-modal-body">
        <label class="st-form-row"><span>文件名</span><input type="text" id="stExName" value="未命名项目"></label>
        <label class="st-form-row"><span>分辨率</span>
          <select id="stExRes">
            <option value="1920x1080">1080p · 1920 × 1080</option>
            <option value="1280x720">720p · 1280 × 720</option>
            <option value="854x480">480p · 854 × 480</option>
            <option value="1080x1920">竖屏 · 1080 × 1920</option>
          </select>
        </label>
        <label class="st-form-row"><span>帧率</span>
          <select id="stExFps">
            <option value="30">30 fps</option>
            <option value="25">25 fps</option>
            <option value="24">24 fps</option>
          </select>
        </label>
        <label class="st-form-row"><span>画质</span>
          <select id="stExBr">
            <option value="12">高 · 12 Mbps</option>
            <option value="8" selected>标准 · 8 Mbps</option>
            <option value="4">轻量 · 4 Mbps</option>
          </select>
        </label>
        <label class="st-form-row"><span>导出范围</span>
          <label class="st-check" for="stExRange"><input type="checkbox" id="stExRange"> 仅导出入出点区间</label>
        </label>
        <div class="st-exnote">导出为 WebM（浏览器实时渲染并编码，时长越长等待越久；导出期间不要切走页面）。</div>
        <div class="st-progress hidden" id="stExProg">
          <div class="st-progress-bar"><i id="stExBar"></i></div>
          <div class="st-progress-txt" id="stExTxt">准备中…</div>
        </div>
        <div class="st-exresult hidden" id="stExResult">
          <b id="stExResultT"></b>
          <span id="stExResultS"></span>
          <a id="stExLink" class="st-primary" download>下载到本机</a>
        </div>
      </div>
      <div class="st-modal-f">
        <button type="button" class="st-ghost" id="stExCancel" data-close="stExportModal">取消</button>
        <button type="button" class="st-primary" id="stExStart">开始导出</button>
      </div>
    </div>
  </div>

  <div class="st-modal hidden" id="stConfirmModal">
    <div class="st-modal-card sm" role="dialog" aria-modal="true" aria-label="确认">
      <div class="st-modal-h"><b id="stConfirmT">确认</b></div>
      <div class="st-modal-body"><div class="st-confirm-msg" id="stConfirmS"></div></div>
      <div class="st-modal-f">
        <button type="button" class="st-ghost" id="stConfirmNo">取消</button>
        <button type="button" class="st-primary" id="stConfirmYes">确定</button>
      </div>
    </div>
  </div>

  <div class="st-toast hidden" id="stToast" role="status" aria-live="polite"></div>
  <input type="file" id="stFile" class="hidden" multiple accept="video/*,audio/*,image/*">
  <input type="file" id="stFileAudio" class="hidden" multiple accept="audio/*">
</div>
`;

/* ---- apps/studio/app.js ---- */
/* 剪辑台 —— 对标万兴喵影的时间线视频剪辑器。
 *
 * 定位：把「视频库」攒下来的素材，按时间线剪成一条能导出的片子。
 * 结构：素材池（导入 / 视频库）→ 四条轨道（主视频 / 画中画 / 文字 / 音频）
 *      → 预览（所见即所得）→ 导出（Canvas + MediaRecorder 实时渲染 WebM）。
 *
 * 三条要守的：
 *   ① 预览与导出共用同一份 project 数据，不做两套渲染逻辑；
 *   ② 所有拖拽都先快照再改，松手才落历史，撤销一次能整步回退；
 *   ③ 文件素材用 objectURL，只活在当前会话；重开项目时自动剔除，
 *      视频库素材走 openagi-media:// 才能跨会话恢复。
 *
 * 与视频库的关系：只通过 window.playerApp.files() / _urlOf() 读它的媒体清单，
 * 不碰 window.openagiDesktop（AGENTS.md 6.1 禁令）。
 */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  const SAVE_KEY = 'hf_studio_project_v1';
  const SNAP_KEY = 'hf_studio_snaps_v1';
  const SAVE_VER = 3;
  const SNAP_MAX = 5;
  const SNAP_MS = 5 * 60 * 1000;
  const RULER_H = 26;
  const MIN_CLIP = 0.1;
  const MAX_HIST = 80;
  const TRACK_ICON = {
    video: '<rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.8 14.8 12l-4.6 2.2V9.8Z" fill="currentColor" stroke="none"/>',
    text: '<path d="M5 5.4h14"/><path d="M12 5.4v13.2"/><path d="M9 18.6h6"/>',
    audio: '<path d="M4 10.2v3.6M7.2 7.6v8.8M10.4 5.4v13.2M13.6 8.4v7.2M16.8 6.4v11.2M20 9.4v5.2"/>'
  };
  const TRACK_PREFIX = { video: 'v', text: 't', audio: 'a' };
  const DEFAULT_TRACKS = [
    { id: 'v2', kind: 'video', name: '画中画' },
    { id: 'v1', kind: 'video', name: '主视频' },
    { id: 't1', kind: 'text', name: '文字' },
    { id: 'a1', kind: 'audio', name: '音频' }
  ];
  const KF_PROPS = ['opacity', 'scale', 'x', 'y', 'rot', 'volume'];
  const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
  const FILTERS = [
    { id: 'none', name: '原片', css: 'none' },
    { id: 'warm', name: '暖阳', css: 'sepia(0.32) saturate(1.25) contrast(1.02)' },
    { id: 'cool', name: '冷调', css: 'hue-rotate(-10deg) saturate(1.15) brightness(1.02)' },
    { id: 'bw', name: '黑白', css: 'grayscale(1) contrast(1.06)' },
    { id: 'film', name: '胶片', css: 'sepia(0.38) contrast(1.14) saturate(0.88)' },
    { id: 'vivid', name: '鲜艳', css: 'saturate(1.45) contrast(1.1)' },
    { id: 'soft', name: '柔光', css: 'brightness(1.08) saturate(0.9) contrast(0.92)' },
    { id: 'high', name: '高反差', css: 'contrast(1.3) saturate(1.05)' }
  ];
  const TEXT_PRESETS = [
    { id: 'title', name: '大标题', note: '居中 · 64px · 白字', style: { size: 78, color: '#ffffff', bg: 'rgba(0,0,0,0)', bold: true, align: 'center' } },
    { id: 'sub', name: '副标题', note: '居中 · 40px · 半透明底', style: { size: 40, color: '#f2f5fa', bg: 'rgba(0,0,0,.45)', bold: false, align: 'center' } },
    { id: 'caption', name: '字幕条', note: '底部 · 36px · 深底', style: { size: 36, color: '#ffffff', bg: 'rgba(0,0,0,.62)', bold: false, align: 'center', y: 32 } },
    { id: 'quote', name: '金句', note: '居中 · 56px · 金色', style: { size: 56, color: '#f0b429', bg: 'rgba(0,0,0,.3)', bold: true, align: 'center' } }
  ];
  const RES_PRESETS = [
    { id: '1920x1080', name: '1920 × 1080（横屏 16:9）' },
    { id: '1280x720', name: '1280 × 720（横屏 16:9）' },
    { id: '1080x1920', name: '1080 × 1920（竖屏 9:16）' },
    { id: '1080x1080', name: '1080 × 1080（方形 1:1）' }
  ];

  /* ---------------- 小工具 ---------------- */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  const round3 = (v) => Math.round(v * 1000) / 1000;
  let seq = 0;
  const uid = (p) => p + Date.now().toString(36) + (seq++).toString(36);
  const svgWrap = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  /* 统一的小图标库：24×24、currentColor，供轨道头 / 检查器 / 关键帧按钮复用。 */
  const ICON = {
    lock: '<rect x="5" y="10.2" width="14" height="9.8" rx="2.4"/><path d="M8.2 10.2V7.6a3.8 3.8 0 0 1 7.6 0v2.6"/>',
    mute: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="m15.2 10 4.4 4.4M19.6 10l-4.4 4.4"/>',
    sound: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="M14.6 9.4a4 4 0 0 1 0 5.2M17.2 7.2a7.4 7.4 0 0 1 0 9.6"/>',
    solo: '<path d="M4.4 13.2v-1a7.6 7.6 0 0 1 15.2 0v1"/><rect x="3.2" y="12.8" width="4" height="6.6" rx="2"/><rect x="16.8" y="12.8" width="4" height="6.6" rx="2"/>',
    eye: '<path d="M3.6 12S7 6.8 12 6.8 20.4 12 20.4 12 17 17.2 12 17.2 3.6 12 3.6 12Z"/><circle cx="12" cy="12" r="2.6"/>',
    eyeOff: '<path d="M3.6 12S7 6.8 12 6.8c1.2 0 2.3.3 3.3.8M20.4 12s-3.4 5.2-8.4 5.2c-1.2 0-2.3-.3-3.3-.8"/><path d="m4.4 4.4 15.2 15.2"/><path d="M10.4 10.4a2.3 2.3 0 0 0 3.2 3.2"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.2"/><path d="M15.6 5.4H6.6a2.2 2.2 0 0 0-2.2 2.2v9"/>',
    trash: '<path d="M4.8 6.8h14.4"/><path d="M9.6 6.8V4.6h4.8v2.2"/><path d="m6.6 6.8.9 12.4a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.9-12.4"/><path d="M10.4 10.4v6.6M13.6 10.4v6.6"/>',
    rippleDel: '<path d="M4.8 6.8h11"/><path d="M9.6 6.8V4.6h4.8v2.2"/><path d="m6.4 6.8.8 12.4a1.8 1.8 0 0 0 1.8 1.7h3.2"/><path d="M19.4 14.4h-5.6M16.6 11.6v5.6"/>',
    eraser: '<path d="m4.6 14.6 7.2-8.2a2 2 0 0 1 3-.1l3.2 2.8a2 2 0 0 1 .1 3L11.4 20H7.2z"/><path d="M8.4 17.2h11.2"/>',
    film: '<rect x="2.8" y="5.2" width="12.4" height="13.6" rx="2.2"/><path d="M6.6 5.2v13.6M11.2 5.2v13.6"/><path d="M19 8.8v6.8M15.6 12.2H22"/>',
    text: '<path d="M4.6 5.4h9.6M9.4 5.4v13.2M7 18.6h4.8"/><path d="M19 8.8v6.8M15.6 12.2H22"/>',
    audio: '<path d="M3.2 10.4v3.2M6.4 8v8M9.6 5.6v12.8M12.8 8.8v6.4"/><path d="M19 8.8v6.8M15.6 12.2H22"/>',
    kfOpacity: '<circle cx="12" cy="12" r="7.4"/><path d="M12 4.6a7.4 7.4 0 0 1 0 14.8z" fill="currentColor" stroke="none"/>',
    kfScale: '<path d="M14 4.6h5.4V10M19.4 4.6 13.8 10.2M10 19.4H4.6V14M4.6 19.4l5.6-5.6"/>',
    kfX: '<path d="M4 12h16"/><path d="m7.4 8.4-3.4 3.6 3.4 3.6M16.6 8.4l3.4 3.6-3.4 3.6"/>',
    kfY: '<path d="M12 4v16"/><path d="m8.4 7.4 3.6-3.4 3.6 3.4M8.4 16.6l3.6 3.4 3.6-3.4"/>',
    kfRot: '<path d="M19 12a7 7 0 1 1-2.6-5.4"/><path d="M19.4 4.6v4.6h-4.6"/>',
    kfVolume: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="M14.6 9.4a4 4 0 0 1 0 5.2M17.2 7.2a7.4 7.4 0 0 1 0 9.6"/>',
    mic: '<rect x="9.2" y="3.4" width="5.6" height="10.4" rx="2.8"/><path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0"/><path d="M12 18v2.6M9 20.6h6"/>'
  };
  const ico = (name) => svgWrap(ICON[name] || '');

  function fmtTc(sec, fps) {
    const t = Math.max(0, Number(sec) || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const f = Math.floor((t - Math.floor(t)) * (fps || 30));
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + '.' + String(f).padStart(2, '0');
  }
  function fmtMmss(sec) {
    const t = Math.max(0, Math.round(Number(sec) || 0));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  function fmtDur(sec) {
    const t = Math.max(0, Number(sec) || 0);
    if (t < 60) return t.toFixed(1) + 's';
    return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  }
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
    return v + ' B';
  }
  /* 效果栈：可叠加 / 可排序 / 可逐项开关。
     预览（DOM style.filter）与导出（ctx.filter）只允许通过 effectsCss 取串，
     避免出现第二套效果拼装逻辑。 */
  const EFFECT_MAX = 8;
  const ADJUST_DEFS = [
    { key: 'brightness', name: '亮度', min: 0.3, max: 2, step: 0.01 },
    { key: 'contrast', name: '对比度', min: 0.3, max: 2, step: 0.01 },
    { key: 'saturate', name: '饱和度', min: 0, max: 2.5, step: 0.01 }
  ];
  function presetOf(id) {
    return FILTERS.find(function (x) { return x.id === id; }) || null;
  }
  function normalizeEffects(raw, legacy) {
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (e) {
      if (!e || typeof e !== 'object' || out.length >= EFFECT_MAX) return;
      if (e.type === 'preset') {
        const f = presetOf(e.preset);
        if (!f || f.id === 'none') return;
        out.push({ id: String(e.id || uid('fx')), type: 'preset', preset: f.id, enabled: e.enabled !== false });
      } else if (e.type === 'adjust') {
        const src = e.params || {};
        const params = {};
        ADJUST_DEFS.forEach(function (d) {
          const n = Number(src[d.key]);
          params[d.key] = isFinite(n) ? clamp(n, d.min, d.max) : 1;
        });
        out.push({ id: String(e.id || uid('fx')), type: 'adjust', enabled: e.enabled !== false, params: params });
      } else if (e.type === 'blur') {
        const n = Number((e.params || {}).px);
        out.push({ id: String(e.id || uid('fx')), type: 'blur', enabled: e.enabled !== false, params: { px: isFinite(n) ? clamp(n, 0, 40) : 4 } });
      }
    });
    if (!out.length && legacy && legacy !== 'none') {
      const f = presetOf(legacy);
      if (f) out.push({ id: uid('fx'), type: 'preset', preset: f.id, enabled: true });
    }
    return out;
  }
  function effectName(e) {
    if (!e) return '';
    if (e.type === 'preset') { const f = presetOf(e.preset); return f ? f.name : '滤镜'; }
    if (e.type === 'adjust') return '调色';
    if (e.type === 'blur') return '模糊';
    return '效果';
  }
  function effectsCss(c) {
    const parts = [];
    ((c && c.effects) || []).forEach(function (e) {
      if (!e || e.enabled === false) return;
      if (e.type === 'preset') {
        const f = presetOf(e.preset);
        if (f && f.css && f.css !== 'none') parts.push(f.css);
      } else if (e.type === 'adjust') {
        const p = e.params || {};
        const b = Number(p.brightness), ct = Number(p.contrast), sa = Number(p.saturate);
        if (isFinite(b) && Math.abs(b - 1) > 0.005) parts.push('brightness(' + round3(b) + ')');
        if (isFinite(ct) && Math.abs(ct - 1) > 0.005) parts.push('contrast(' + round3(ct) + ')');
        if (isFinite(sa) && Math.abs(sa - 1) > 0.005) parts.push('saturate(' + round3(sa) + ')');
      } else if (e.type === 'blur') {
        const px = Number((e.params || {}).px);
        if (isFinite(px) && px > 0) parts.push('blur(' + round3(px) + 'px)');
      }
    });
    return parts.length ? parts.join(' ') : 'none';
  }

  /* ---------------- 项目模型（v3） ---------------- */
  function defaultTracks() {
    return DEFAULT_TRACKS.map(function (t) {
      return {
        id: t.id,
        kind: t.kind,
        name: t.name,
        locked: false,
        muted: false,
        solo: false,
        hidden: false,
        height: 46
      };
    });
  }

  function blankProject() {
    return {
      v: SAVE_VER,
      name: '未命名项目',
      w: 1920,
      h: 1080,
      fps: 30,
      sampleRate: 48000,
      media: [],
      tracks: defaultTracks(),
      clips: [],
      markers: [],
      meta: { createdAt: Date.now(), updatedAt: Date.now(), app: 'studio' }
    };
  }

  function normalizeKf(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    KF_PROPS.forEach(function (prop) {
      const arr = Array.isArray(raw[prop]) ? raw[prop] : [];
      const pts = arr.filter(function (k) {
        return k && isFinite(Number(k.t)) && isFinite(Number(k.v));
      }).map(function (k) {
        return {
          t: Math.max(0, round2(Number(k.t))),
          v: Number(k.v),
          ease: EASES.indexOf(k.ease) >= 0 ? k.ease : 'linear'
        };
      }).sort(function (a, b) { return a.t - b.t; });
      const uniq = [];
      pts.forEach(function (p) {
        if (uniq.length && Math.abs(uniq[uniq.length - 1].t - p.t) < 0.001) uniq[uniq.length - 1] = p;
        else uniq.push(p);
      });
      if (uniq.length) out[prop] = uniq.slice(0, 200);
    });
    return out;
  }

  function normalizeTracks(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    src.forEach(function (t) {
      if (!t || !t.id) return;
      const id = String(t.id);
      const kind = t.kind === 'video' || t.kind === 'text' || t.kind === 'audio' ? t.kind : '';
      if (!kind || seen.has(id)) return;
      seen.add(id);
      out.push({
        id: id,
        kind: kind,
        name: String(t.name || ({ video: '视频', text: '文字', audio: '音频' })[kind]),
        locked: !!t.locked,
        muted: !!t.muted,
        solo: !!t.solo,
        hidden: !!t.hidden,
        height: clamp(Number(t.height) || 46, 32, 120)
      });
    });
    return out.length ? out : defaultTracks();
  }

  function normalizeMarkers(raw) {
    return (Array.isArray(raw) ? raw : []).filter(function (m) {
      return m && isFinite(Number(m.t));
    }).map(function (m, i) {
      return {
        t: Math.max(0, round2(Number(m.t))),
        name: String(m.name || ('标记 ' + (i + 1))),
        color: /^#[0-9a-f]{6}$/i.test(String(m.color || '')) ? String(m.color) : '#f0b429'
      };
    }).sort(function (a, b) { return a.t - b.t; });
  }

  /* v1 → v2：补齐轨道、标记、关键帧容器。
     v2 → v3：把单值 filter 迁进 effects 栈，删除旧字段。
     分版本增量迁移，对当前版本是恒等操作，可重复调用。 */
  function migrateProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ver = Number(raw.v) || 1;
    if (ver >= SAVE_VER) return raw;
    const out = JSON.parse(JSON.stringify(raw));
    if (ver < 2) {
      out.sampleRate = 48000;
      out.tracks = defaultTracks();
      out.markers = [];
      out.meta = { createdAt: 0, updatedAt: 0, app: 'studio' };
      out.clips = (Array.isArray(out.clips) ? out.clips : []).map(function (c) {
        if (!c || typeof c !== 'object') return c;
        if (!c.kf) c.kf = {};
        return c;
      });
    }
    if (ver < 3) {
      out.clips = (Array.isArray(out.clips) ? out.clips : []).map(function (c) {
        if (!c || typeof c !== 'object') return c;
        c.effects = normalizeEffects(c.effects, c.filter);
        delete c.filter;
        return c;
      });
    }
    out.v = SAVE_VER;
    return out;
  }

  function makeClip(opt) {
    const c = opt || {};
    return {
      id: c.id || uid('c'),
      track: c.track || 'v1',
      kind: c.kind || 'video',
      mediaId: c.mediaId || '',
      name: c.name || '片段',
      start: Number(c.start) || 0,
      dur: Math.max(MIN_CLIP, Number(c.dur) || 5),
      in: Math.max(0, Number(c.in) || 0),
      speed: Number(c.speed) || 1,
      x: Number(c.x) || 0,
      y: Number(c.y) || 0,
      scale: c.scale == null ? 1 : Number(c.scale),
      rot: Number(c.rot) || 0,
      opacity: c.opacity == null ? 1 : Number(c.opacity),
      volume: c.volume == null ? 1 : Number(c.volume),
      muted: !!c.muted,
      fadeIn: c.fadeIn == null ? 0 : Number(c.fadeIn),
      fadeOut: c.fadeOut == null ? 0 : Number(c.fadeOut),
      effects: normalizeEffects(c.effects, c.filter),
      kf: normalizeKf(c.kf),
      text: {
        content: (c.text && c.text.content) || '标题文字',
        size: (c.text && c.text.size) || 64,
        color: (c.text && c.text.color) || '#ffffff',
        bg: (c.text && c.text.bg) || 'rgba(0,0,0,0)',
        bold: !(c.text && c.text.bold === false),
        align: (c.text && c.text.align) || 'center'
      }
    };
  }

  function normalizeProject(raw) {
    const p = blankProject();
    const src = migrateProject(raw);
    if (!src) return p;
    p.name = String(src.name || p.name);
    p.w = Math.max(320, Number(src.w) || 1920);
    p.h = Math.max(180, Number(src.h) || 1080);
    p.fps = [24, 25, 30, 50, 60].indexOf(Number(src.fps)) >= 0 ? Number(src.fps) : 30;
    p.sampleRate = [44100, 48000].indexOf(Number(src.sampleRate)) >= 0 ? Number(src.sampleRate) : 48000;
    p.tracks = normalizeTracks(src.tracks);
    p.markers = normalizeMarkers(src.markers);
    p.meta = {
      createdAt: Number(src.meta && src.meta.createdAt) || 0,
      updatedAt: Number(src.meta && src.meta.updatedAt) || 0,
      app: 'studio'
    };
    p.media = (Array.isArray(src.media) ? src.media : []).filter(function (m) {
      return m && m.id && (m.kind === 'video' || m.kind === 'audio' || m.kind === 'image');
    }).map(function (m) {
      return {
        id: String(m.id),
        name: String(m.name || '素材'),
        kind: m.kind,
        url: String(m.url || ''),
        dur: Math.max(0, Number(m.dur) || 0),
        source: m.source === 'library' || m.source === 'asset' || m.source === 'tts' ? m.source : 'file',
        libId: m.libId ? String(m.libId) : '',
        assetId: m.assetId ? String(m.assetId) : '',
        tts: m.tts && m.tts.text ? {
          text: String(m.tts.text),
          voice: String(m.tts.voice || ''),
          rate: Number(m.tts.rate) || 1
        } : null
      };
    });
    const ids = new Set(p.media.map(function (m) { return m.id; }));
    const trackMap = {};
    p.tracks.forEach(function (t) { trackMap[t.id] = t; });
    p.clips = (Array.isArray(src.clips) ? src.clips : []).filter(function (c) {
      if (!c || !c.id || !trackMap[c.track]) return false;
      const tk = trackMap[c.track].kind;
      const want = c.kind === 'text' ? 'text' : c.kind === 'audio' ? 'audio' : 'video';
      if (tk !== want) return false;
      return c.kind === 'text' || ids.has(c.mediaId);
    }).map(function (c) { return makeClip(c); });
    return p;
  }

  /* ---------------- 关键帧采样（纯函数） ---------------- */
  function easeVal(t, ez) {
    if (ez === 'easeIn') return t * t;
    if (ez === 'easeOut') return 1 - (1 - t) * (1 - t);
    if (ez === 'easeInOut') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    return t;
  }

  function sampleTrack(keys, localT) {
    if (!Array.isArray(keys) || !keys.length) return null;
    if (!isFinite(localT)) return keys[0].v;
    if (localT <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (localT >= last.t) return last.v;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (localT >= a.t && localT <= b.t) {
        const span = b.t - a.t;
        const f = span > 0 ? (localT - a.t) / span : 1;
        return a.v + (b.v - a.v) * easeVal(f, a.ease || 'linear');
      }
    }
    return last.v;
  }

  function propAt(c, prop, t) {
    const base = { opacity: c.opacity, scale: c.scale, x: c.x, y: c.y, rot: c.rot, volume: c.volume }[prop];
    const k = c.kf && c.kf[prop];
    if (!k || !k.length) return base;
    const v = sampleTrack(k, t - c.start);
    return v == null ? base : v;
  }

  function projectDuration(p) {
    let d = 0;
    for (const c of p.clips) d = Math.max(d, c.start + c.dur);
    return round2(d);
  }

  /* ---------------- 状态 ---------------- */
  const S = {
    inited: false,
    project: blankProject(),
    time: 0,
    playing: false,
    sel: '',
    multi: new Set(),
    mediaSel: '',
    pps: 80,
    vol: 1,
    muted: false,
    snap: true,
    tool: 'select',
    loop: false,
    mediaKind: 'all',
    inspTab: 'basic',
    panel: 'media',
    hist: [],
    future: [],
    inspSnap: '',
    raf: 0,
    last: 0,
    exportSession: null,
    exportUrl: '',
    pool: {},
    textNodes: new Map(),
    textSig: '',
    toastTimer: 0,
    saveTimer: 0,
    libFiles: [],
    libPick: new Set(),
    libTab: 'media',
    libAssets: [],
    assetThumbs: {},
    libTimer: 0,
    frameW: 0,
    frameH: 0,
    drag: null,
    drop: null,
    pressed: false,
    lsOk: true,
    steps: 0,
    snapshots: [],
    lastSnapAt: 0,
    snapStep: 0,
    trackSig: '',
    /* 序列入出点（null = 未设置） */
    rngIn: null,
    rngOut: null,
    /* 播放速率与方向：J 倒放时 dir = -1，L 连按提速到 4× */
    rate: 1,
    dir: 1,
    /* 片段剪贴板：{ base, items } */
    clipboard: null,
    /* 音频峰值缓存与并发解码任务 */
    peaks: new Map(),
    peakJobs: new Map(),
    marquee: null,
    lastReverseSeek: 0
  };

  function tracks() { return S.project.tracks; }
  function trackOf(id) {
    for (const t of S.project.tracks) if (t.id === id) return t;
    return null;
  }
  function tracksOfKind(kind) {
    return S.project.tracks.filter(function (t) { return t.kind === kind; });
  }
  function anySolo() {
    return S.project.tracks.some(function (t) { return t.solo; });
  }
  function trackActive(t) {
    if (!t || t.hidden) return false;
    return !anySolo() || t.solo;
  }
  function clipKindTrack(kind) {
    return kind === 'text' ? 'text' : kind === 'audio' ? 'audio' : 'video';
  }

  function winEl() { return $('studioWin'); }
  function isShown() {
    const w = winEl();
    return !!w && !w.classList.contains('hidden') && w.offsetParent !== null;
  }
  function mediaOf(id) {
    for (const m of S.project.media) if (m.id === id) return m;
    return null;
  }
  function clipOf(id) {
    for (const c of S.project.clips) if (c.id === id) return c;
    return null;
  }
  function selected() { return S.sel ? clipOf(S.sel) : null; }
  function sortedClips() {
    return S.project.clips.slice().sort(function (a, b) { return a.start - b.start; });
  }
  function trackEnd(track) {
    let d = 0;
    for (const c of S.project.clips) if (c.track === track) d = Math.max(d, c.start + c.dur);
    return d;
  }

  /* ---------------- 本地存档 / 快照 ---------------- */
  function cleanForStore(p) {
    const copy = JSON.parse(JSON.stringify(p));
    /* 只存视频库 / 图库素材：文件素材的 objectURL 在下次启动必定失效。
       图库素材只留 assetId，dataURL 启动时从资产库重新水合，避免撑爆 localStorage。 */
    copy.media = copy.media.filter(function (m) {
      return m.source === 'library' || m.source === 'asset' || m.source === 'tts';
    }).map(function (m) {
      return (m.source === 'asset' || m.source === 'tts') ? Object.assign({}, m, { url: '' }) : m;
    });
    const keep = new Set(copy.media.map(function (m) { return m.id; }));
    copy.clips = copy.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    return copy;
  }

  /* 图库素材的 dataURL 不进存档：启动 / 恢复快照 / 导入项目后按 assetId 重新读回。 */
  async function hydrateAssetMedia() {
    const bridge = window.assetBridge;
    if (!bridge || typeof bridge.read !== 'function') return;
    const need = S.project.media.filter(function (m) { return m.assetId && !m.url; });
    if (!need.length) return;
    let changed = false;
    for (const m of need) {
      let url = '';
      try { url = await bridge.read(m.assetId); } catch (e) { url = ''; }
      if (url) { m.url = url; changed = true; }
    }
    if (changed) { renderAll(); applyTime(); }
  }

  /* 配音素材同理：只存文本 + 音色，启动后按需重新合成。 */
  async function hydrateTtsMedia() {
    const bridge = window.ttsBridge;
    if (!bridge || typeof bridge.speak !== 'function') return;
    const need = S.project.media.filter(function (m) {
      return m.source === 'tts' && m.tts && !m.url;
    });
    if (!need.length) return;
    let changed = false;
    for (const m of need) {
      try {
        const r = await bridge.speak(m.tts.text, { voice: m.tts.voice, rate: m.tts.rate });
        if (r && r.url) { m.url = r.url; changed = true; }
      } catch (e) { /* 引擎没装好就先留空，下一次启动再试 */ }
    }
    if (changed) { renderAll(); applyTime(); }
  }

  async function hydrateMedia() {
    await hydrateAssetMedia();
    await hydrateTtsMedia();
  }

  function readSnaps() {
    try {
      const arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function snapshotProject() {
    /* 快照保留完整项目（含本会话的 blob/objectURL），用于崩溃后当场恢复；
       跨会话读取时 loadSaved 仍会剔除失效的文件素材。
       图库素材剥掉 dataURL，避免五份快照把配额吃满。 */
    const p = JSON.parse(JSON.stringify(S.project));
    p.media.forEach(function (m) {
      if (m.source === 'asset' || m.source === 'tts') m.url = '';
    });
    return { at: Date.now(), time: S.time, name: S.project.name, project: p };
  }

  function saveSnapshot() {
    S.snapshots.push(snapshotProject());
    if (S.snapshots.length > SNAP_MAX) S.snapshots = S.snapshots.slice(-SNAP_MAX);
    S.lastSnapAt = Date.now();
    S.snapStep = S.steps;
    if (typeof STORE_SYNC_OFF !== 'undefined' && STORE_SYNC_OFF) return;
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(S.snapshots)); } catch (e) { /* 配额满就只留内存 */ }
  }

  function maybeSnapshot() {
    if (!S.lastSnapAt) { S.lastSnapAt = Date.now(); S.snapStep = S.steps; return; }
    if (Date.now() - S.lastSnapAt >= SNAP_MS || S.steps - S.snapStep >= 50) saveSnapshot();
  }

  function restoreSnapshot(i) {
    const s = S.snapshots[i];
    if (!s || !s.project) return false;
    S.project = normalizeProject(s.project);
    S.time = clamp(Number(s.time) || 0, 0, Math.max(0, projectDuration(S.project)));
    S.sel = '';
    S.multi.clear();
    S.hist = [];
    S.future = [];
    afterRestore();
    hydrateMedia();
    toast('已恢复快照：' + (s.name || '未命名项目'));
    return true;
  }

  function loadSaved() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); }
    catch (e) { raw = null; }
    S.snapshots = readSnaps();
    if (!raw || !raw.project) {
      /* 主存档缺失时用最近一份快照兜底（崩溃恢复） */
      const last = S.snapshots[S.snapshots.length - 1];
      if (!last || !last.project) return null;
      raw = { project: last.project, time: last.time };
    }
    const p = normalizeProject(raw.project);
    /* 文件素材的 objectURL 跨刷新必然失效：剔除素材，同时剔除引用它的片段，
       而不是留一堆播不出来的黑片段。 */
    const keep = new Set(p.media.map(function (m) { return m.id; }));
    p.clips = p.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    return { project: p, time: Math.max(0, Number(raw.time) || 0) };
  }

  function markSaveState(text, busy) {
    const el = $('stSaveState');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function saveNow() {
    clearTimeout(S.saveTimer);
    S.saveTimer = 0;
    /* ?nostore=1 是测试模式：只禁写不禁读（js/config.js 的 STORE_SYNC_OFF） */
    if (typeof STORE_SYNC_OFF !== 'undefined' && STORE_SYNC_OFF) {
      markSaveState('测试模式 · 不落盘', false);
      return;
    }
    try {
      S.project.meta = S.project.meta || {};
      S.project.meta.updatedAt = Date.now();
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: SAVE_VER, project: cleanForStore(S.project), time: S.time, at: Date.now()
      }));
      markSaveState('已保存', false);
      maybeSnapshot();
    } catch (e) {
      S.lsOk = false;
      markSaveState('未存档', false);
    }
  }

  function scheduleSave() {
    markSaveState('保存中…', true);
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 650);
  }

  /* ---------------- 历史（语义化：每条带动作名） ---------------- */
  function snap() { return JSON.stringify(S.project); }
  function pushHistory(label) {
    S.hist.push({ label: String(label || '编辑'), snap: snap() });
    if (S.hist.length > MAX_HIST) S.hist.shift();
    S.future.length = 0;
    S.steps += 1;
    paintUndo();
  }
  function dropHistory() {
    if (S.hist.length) S.hist.pop();
    paintUndo();
  }
  function undo() {
    if (!S.hist.length) return false;
    const item = S.hist.pop();
    S.future.push({ label: item.label, snap: snap() });
    S.project = normalizeProject(JSON.parse(item.snap));
    afterRestore();
    return true;
  }
  function redo() {
    if (!S.future.length) return false;
    const item = S.future.pop();
    S.hist.push({ label: item.label, snap: snap() });
    S.project = normalizeProject(JSON.parse(item.snap));
    afterRestore();
    return true;
  }
  /* 历史面板跳转：回到第 i 条历史之前的状态（i = 0 表示最初） */
  function goHistory(i) {
    if (i < 0 || i >= S.hist.length) return false;
    S.future.push({ label: '回到：' + S.hist[i].label, snap: snap() });
    S.project = normalizeProject(JSON.parse(S.hist[i].snap));
    S.hist = S.hist.slice(0, i);
    afterRestore();
    return true;
  }
  function afterRestore() {
    if (S.sel && !clipOf(S.sel)) S.sel = '';
    const alive = new Set(S.project.clips.map(function (c) { return c.id; }));
    Array.from(S.multi).forEach(function (id) {
      if (!alive.has(id)) S.multi.delete(id);
    });
    const dur = Math.max(0, projectDuration(S.project));
    S.time = clamp(S.time, 0, dur);
    if (S.rngIn != null) S.rngIn = clamp(S.rngIn, 0, dur);
    if (S.rngOut != null) S.rngOut = clamp(S.rngOut, 0, dur);
    if (S.rngIn != null && S.rngOut != null && S.rngOut <= S.rngIn) S.rngOut = null;
    renderAll();
    applyTime();
    scheduleSave();
    paintUndo();
  }
  function paintUndo() {
    const u = $('stUndo');
    const r = $('stRedo');
    if (u) u.disabled = !S.hist.length;
    if (r) r.disabled = !S.future.length;
    const box = $('stHistList');
    if (!box) return;
    const rows = S.hist.slice(-8).map(function (h, k) {
      const idx = S.hist.length - Math.min(8, S.hist.length) + k;
      return '<button class="st-histrow" data-hist="' + idx + '" title="回到这一步之前">' +
        '<span>' + escHtml(h.label) + '</span><em>#' + (idx + 1) + '</em></button>';
    }).reverse().join('');
    box.innerHTML = rows || '<div class="st-hint">还没有可撤销的动作</div>';
  }

  /* ---------------- 提示 ---------------- */
  function toast(msg) {
    const el = $('stToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.classList.add('hidden'); }, 180);
    }, 2200);
  }

  function askConfirm(title, msg, onYes) {
    const m = $('stConfirmModal');
    if (!m) { onYes(); return; }
    $('stConfirmT').textContent = title;
    $('stConfirmS').textContent = msg;
    m.classList.remove('hidden');
    m.dataset.on = '1';
    S._confirmYes = onYes;
  }

  /* ---------------- 初始化 ---------------- */
  function init(body) {
    if (S.inited) {
      /* 幂等：再次翻到本 App 只刷新素材与画面，不重建 DOM，保住滚动与选中 */
      refreshPreviewLayout();
      renderMedia();
      applyTime();
      return;
    }
    S.inited = true;

    const saved = loadSaved();
    if (saved) {
      S.project = saved.project;
      S.time = clamp(saved.time, 0, Math.max(0, projectDuration(S.project)));
    }

    buildTextPresets();
    buildFilters();
    bindAll();
    fitFrame();

    renderAll();
    applyTime();
    paintUndo();
    saveNow();
    hydrateMedia();

    /* 首次打开时，如果本地存档被过滤空了素材，给一句说明 */
    if (saved && !saved.project.media.length && saved.project.clips.length === 0) {
      /* 什么都不提示：空项目是正常初态 */
    }
    void body;
  }

  function buildPools() {
    const app = $('stApp');
    const frame = $('stFrame');
    const textHost = $('stTexts');
    if (!app || !frame || !textHost) return;
    frame.querySelectorAll('.st-layer[data-track]').forEach(function (n) { n.remove(); });
    Object.keys(S.pool).forEach(function (id) {
      const p = S.pool[id];
      if (p.video) p.video.remove();
      if (p.img) p.img.remove();
      if (p.audio) p.audio.remove();
      if (p.layer) p.layer.remove();
    });
    S.pool = {};
    tracks().forEach(function (t, i) {
      if (t.kind === 'video') {
        const layer = document.createElement('div');
        layer.className = 'st-layer';
        layer.dataset.track = t.id;
        layer.style.zIndex = String(50 - i);
        frame.insertBefore(layer, textHost);
        const v = document.createElement('video');
        v.playsInline = true;
        v.preload = 'auto';
        v.className = 'st-media-el';
        v.muted = false;
        layer.appendChild(v);
        const img = document.createElement('img');
        img.className = 'st-media-el hidden';
        img.alt = '';
        layer.appendChild(img);
        S.pool[t.id] = { layer: layer, video: v, img: img, clipId: '', kind: '' };
      } else if (t.kind === 'audio') {
        const a = document.createElement('audio');
        a.preload = 'auto';
        a.className = 'st-hidden-el';
        a.style.display = 'none';
        app.appendChild(a);
        S.pool[t.id] = { audio: a, clipId: '', kind: '' };
      }
    });
  }

  function headButtons(t) {
    const defs = [
      ['lock', 'lock', '锁定轨道', t.locked],
      ['mute', t.muted ? 'mute' : 'sound', '静音轨道', t.muted],
      ['solo', 'solo', '独奏轨道', t.solo],
      ['hidden', t.hidden ? 'eyeOff' : 'eye', '隐藏轨道', t.hidden]
    ];
    return defs.map(function (d) {
      return '<button type="button" class="st-thb' + (d[3] ? ' on' : '') + '" data-tt="' + d[0] +
        '" data-track="' + t.id + '" title="' + d[2] + '" aria-pressed="' + (d[3] ? 'true' : 'false') + '">' + ico(d[1]) + '</button>';
    }).join('');
  }

  function buildTrackHeads() {
    const heads = $('stHeads');
    if (!heads) return;
    heads.innerHTML = '<div class="st-head-ruler"></div><div class="st-heads-inner" id="stHeadsInner">' +
      tracks().map(function (t) {
        const count = S.project.clips.filter(function (c) { return c.track === t.id; }).length;
        const del = count === 0 && tracks().length > 1 ?
          '<button type="button" class="st-thdel" data-del="' + t.id + '" title="删除空轨道" aria-label="删除空轨道">' + ico('trash') + '</button>' :
          '<i class="st-th-count" data-count="' + t.id + '">' + count + '</i>';
        return '<div class="st-th" data-track="' + t.id + '" data-kind="' + t.kind + '"' +
          ' data-locked="' + (t.locked ? 1 : 0) + '" data-hidden="' + (t.hidden ? 1 : 0) + '"' +
          ' style="height:' + t.height + 'px">' + svgWrap(TRACK_ICON[t.kind]) +
          '<b title="' + escHtml(t.name) + '">' + escHtml(t.name) + '</b>' +
          '<span class="st-th-btns">' + headButtons(t) + '</span>' + del +
          '<span class="st-th-grip" data-grip="' + t.id + '" title="拖动调整轨道高度"></span></div>';
      }).join('') + '</div>';
  }

  function buildTextPresets() {
    const box = $('stTextPresets');
    if (!box) return;
    box.innerHTML = TEXT_PRESETS.map(function (p) {
      return '<button type="button" class="st-preset" data-preset="' + p.id + '">' +
        '<i style="color:' + (p.style.color === '#ffffff' ? '#e9edf5' : p.style.color) + '">Aa</i>' +
        '<div><b>' + p.name + '</b><span>' + p.note + '</span></div></button>';
    }).join('');
  }

  function buildFilters() {
    const box = $('stFxGrid');
    if (!box) return;
    box.innerHTML = FILTERS.map(function (f) {
      return '<div class="st-fxcard" data-fx="' + f.id + '"><div class="st-fxprev"></div>' +
        '<div class="st-fxname">' + f.name + '</div></div>';
    }).join('');
  }

  function fitFrame() {
    const prev = document.querySelector('.st-prev');
    const frame = $('stFrame');
    if (!prev || !frame) return;
    const aw = Math.max(120, prev.clientWidth - 32);
    const ah = Math.max(80, prev.clientHeight - 22);
    const p = S.project;
    const k = Math.min(aw / p.w, ah / p.h);
    const w = Math.max(120, Math.round(p.w * k));
    const h = Math.max(68, Math.round(p.h * k));
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    S.frameW = w;
    S.frameH = h;
    S.textSig = '';
    paintTexts(true);
  }

  function refreshPreviewLayout() {
    fitFrame();
  }

  /* ---------------- 音频图（预览与导出共用） -----------------
   * 元素一旦被 createMediaElementSource 接管，声音就走 WebAudio：
   *   element.volume → master → monitor → 扬声器
   *                          └→ recDest → MediaRecorder
   * 导出时把 monitor 拉 0（否则会一边录一边外放），但 recDest 仍拿到完整声音。 */
  const AUD = { ctx: null, master: null, monitor: null, recDest: null, srcMap: new Map() };

  function ensureAudio() {
    if (AUD.ctx) return AUD.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      const monitor = ctx.createGain();
      master.connect(monitor);
      monitor.connect(ctx.destination);
      let dest = null;
      try {
        dest = ctx.createMediaStreamDestination();
        master.connect(dest);
      } catch (e) { dest = null; }
      AUD.ctx = ctx;
      AUD.master = master;
      AUD.monitor = monitor;
      AUD.recDest = dest;
      hookAnalyser();
    } catch (e) { return null; }
    return AUD.ctx;
  }
  function resumeAudio() {
    if (AUD.ctx && AUD.ctx.state === 'suspended') {
      const p = AUD.ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  }
  function hookEl(el) {
    if (!el) return;
    if (!ensureAudio()) return;
    if (AUD.srcMap.has(el)) return;
    try {
      const src = AUD.ctx.createMediaElementSource(el);
      src.connect(AUD.master);
      AUD.srcMap.set(el, src);
    } catch (e) { /* 已经被别的图接管过时忽略 */ }
  }
  function applyMonitorGain() {
    if (!AUD.monitor) return;
    AUD.monitor.gain.value = (S.muted || S.exportSession) ? 0 : 1;
  }
  /* 主输出电平表：master 旁挂一个 AnalyserNode，只观察不参与链路。 */
  function hookAnalyser() {
    if (AUD.analyser || !AUD.ctx || !AUD.master) return;
    try {
      const an = AUD.ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.45;
      AUD.master.connect(an);
      AUD.analyser = an;
      AUD.levelBuf = new Uint8Array(an.fftSize);
    } catch (e) { AUD.analyser = null; }
  }
  function paintLevel() {
    const box = $('stLevel');
    if (!box) return;
    const bar = box.querySelector('i');
    let peak = 0;
    if (AUD.analyser && S.playing && S.dir > 0) {
      try {
        AUD.analyser.getByteTimeDomainData(AUD.levelBuf);
        for (let i = 0; i < AUD.levelBuf.length; i++) {
          const d = Math.abs(AUD.levelBuf[i] - 128) / 128;
          if (d > peak) peak = d;
        }
      } catch (e) { peak = 0; }
    }
    const pct = Math.round(clamp(peak * 130, 0, 100));
    if (bar) bar.style.height = pct + '%';
    box.classList.toggle('hot', pct > 88);
  }

  /* ---------------- 音频波形 ----------------
   * 只保留每秒 100 点的峰值，解码缓冲用完即丢；解码失败静默降级为空波形。 */
  const PEAK_RATE = 100;
  function peaksOf(mediaId) {
    const p = S.peaks.get(mediaId);
    return p && p.data ? p : null;
  }
  function ensureVisiblePeaks() {
    if (!S.inited) return;
    const ids = new Set();
    S.project.clips.forEach(function (c) {
      if (c.kind === 'audio' && c.mediaId) ids.add(c.mediaId);
    });
    ids.forEach(function (id) { loadPeaks(id); });
  }
  function loadPeaks(mediaId) {
    if (S.peaks.has(mediaId)) {
      const p = peaksOf(mediaId);
      return Promise.resolve(p ? p.data.length : 0);
    }
    /* 同一素材并发请求复用同一个任务，避免重复解码。 */
    if (S.peakJobs.has(mediaId)) return S.peakJobs.get(mediaId);
    const m = mediaOf(mediaId);
    if (!m || !m.url || m.kind === 'image') return Promise.resolve(0);
    const ctx = ensureAudio();
    if (!ctx || !window.fetch) { S.peaks.set(mediaId, { data: null }); return Promise.resolve(0); }
    const job = fetch(m.url)
      .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (buf) {
        if (!buf) throw new Error('fetch failed');
        return new Promise(function (res, rej) {
          const p = ctx.decodeAudioData(buf.slice(0), res, rej);
          if (p && p.catch) p.catch(rej);
        });
      })
      .then(function (audio) {
        const n = Math.max(1, Math.ceil(audio.duration * PEAK_RATE));
        const data = new Float32Array(n);
        const ch = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(ch.length / n));
        for (let i = 0; i < n; i++) {
          let peak = 0;
          const s = i * step;
          const e = Math.min(ch.length, s + step);
          for (let j = s; j < e; j++) {
            const a = Math.abs(ch[j]);
            if (a > peak) peak = a;
          }
          data[i] = peak;
        }
        S.peaks.set(mediaId, { data: data, dur: audio.duration });
        paintWaves();
        return n;
      })
      .catch(function () { S.peaks.set(mediaId, { data: null }); return 0; });
    S.peakJobs.set(mediaId, job);
    job.then(function () { S.peakJobs.delete(mediaId); });
    return job;
  }
  function paintWaves() {
    const nodes = document.querySelectorAll('#stRows .st-clip[data-kind="audio"]');
    nodes.forEach(function (node) {
      const c = clipOf(node.dataset.id);
      const cv = node.querySelector('canvas.st-wave');
      if (!c || !cv) return;
      const fullW = Math.max(1, Math.round(c.dur * S.pps));
      /* Canvas 单边有上限：超长片段按比例降采样，避免 width 赋值失败后画不出来。 */
      const w = Math.min(4096, fullW);
      const scale = w / fullW;
      const h = Math.max(10, node.clientHeight);
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      const g = cv.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, w, h);
      const pk = peaksOf(c.mediaId);
      if (!pk) return;
      g.fillStyle = 'rgba(224,255,244,.6)';
      for (let x = 0; x < w; x++) {
        const clipPx = x / scale;
        const srcT = c.in + (clipPx / Math.max(1, S.pps)) * c.speed;
        const idx = Math.floor(srcT * PEAK_RATE);
        if (idx < 0 || idx >= pk.data.length) continue;
        const bh = Math.max(1, Math.min(1, pk.data[idx] * 1.6) * (h - 6));
        g.fillRect(x, (h - bh) / 2, 1, bh);
      }
    });
  }

  /* ---------------- 预览同步 ---------------- */
  function activeClipOn(track, t) {
    let best = null;
    for (const c of S.project.clips) {
      if (c.track !== track) continue;
      if (t >= c.start - 1e-4 && t < c.start + c.dur - 1e-4) {
        if (!best || c.start >= best.start) best = c;
      }
    }
    return best;
  }

  function fadeFactor(c, t) {
    let f = 1;
    if (c.fadeIn > 0) f = Math.min(f, (t - c.start) / c.fadeIn);
    if (c.fadeOut > 0) f = Math.min(f, (c.start + c.dur - t) / c.fadeOut);
    return clamp(f, 0, 1);
  }

  function visualOf(c, t) {
    return {
      x: propAt(c, 'x', t),
      y: propAt(c, 'y', t),
      scale: propAt(c, 'scale', t),
      rot: propAt(c, 'rot', t),
      opacity: propAt(c, 'opacity', t)
    };
  }

  function applyVisual(el, c, t) {
    if (!el) return;
    const v = visualOf(c, t);
    const dx = (v.x / 100) * S.frameW;
    const dy = (v.y / 100) * S.frameH;
    el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' +
      v.scale.toFixed(3) + ') rotate(' + v.rot + 'deg)';
    el.style.opacity = String(clamp(v.opacity * fadeFactor(c, t), 0, 1));
    el.style.filter = effectsCss(c);
  }

  function hideVisual(pool) {
    if (!pool) return;
    if (pool.video) {
      pool.video.classList.add('hidden');
      try { pool.video.pause(); } catch (e) {}
    }
    if (pool.img) pool.img.classList.add('hidden');
    pool.clipId = '';
    pool.kind = '';
  }

  function syncVisual(trackId, t, playing) {
    const pool = S.pool[trackId];
    if (!pool || !pool.video) return;
    const tk = trackOf(trackId);
    const c = trackActive(tk) ? activeClipOn(trackId, t) : null;
    if (!c) { hideVisual(pool); return; }
    const m = mediaOf(c.mediaId);
    if (!m || !m.url) { hideVisual(pool); return; }
    const mediaKind = m.kind === 'image' ? 'image' : 'video';

    if (pool.clipId !== c.id || pool.kind !== mediaKind) {
      pool.clipId = c.id;
      pool.kind = mediaKind;
      if (mediaKind === 'image') {
        pool.video.classList.add('hidden');
        try { pool.video.pause(); } catch (e) {}
        pool.video.removeAttribute('src');
        try { pool.video.load(); } catch (e) {}
        pool.img.src = m.url;
        pool.img.classList.remove('hidden');
      } else {
        pool.img.classList.add('hidden');
        pool.img.removeAttribute('src');
        pool.video.classList.remove('hidden');
        pool.video.src = m.url;
        try { pool.video.load(); } catch (e) {}
        hookEl(pool.video);
      }
    }

    const fade = fadeFactor(c, t);
    if (mediaKind === 'video') {
      const v = pool.video;
      const mediaDur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      let srcT = (t - c.start) * c.speed + c.in;
      if (mediaDur) srcT = clamp(srcT, 0, Math.max(0, mediaDur - 0.03));
      else srcT = Math.max(0, srcT);
      const vol = propAt(c, 'volume', t);
      v.playbackRate = clamp(c.speed * (S.dir > 0 ? S.rate : 1), 0.25, 4);
      v.volume = clamp(vol * S.vol * fade, 0, 1);
      v.muted = !!c.muted || !!tk.muted || vol <= 0;
      if (playing) {
        if (v.readyState >= 1 && Math.abs(v.currentTime - srcT) > 0.3) {
          try { v.currentTime = srcT; } catch (e) {}
        }
        if (v.paused) {
          const pr = v.play();
          if (pr && pr.catch) pr.catch(function () {});
        }
      } else {
        if (!v.paused) v.pause();
        if (v.readyState >= 1 && Math.abs(v.currentTime - srcT) > 0.04) {
          try { v.currentTime = srcT; } catch (e) {}
        }
      }
      applyVisual(v, c, t);
    } else {
      applyVisual(pool.img, c, t);
    }
  }

  function syncAudio(trackId, t, playing) {
    const pool = S.pool[trackId];
    if (!pool || !pool.audio) return;
    const a = pool.audio;
    const tk = trackOf(trackId);
    const c = trackActive(tk) ? activeClipOn(trackId, t) : null;
    if (!c) {
      if (pool.clipId) {
        try { a.pause(); } catch (e) {}
        pool.clipId = '';
      }
      return;
    }
    const m = mediaOf(c.mediaId);
    if (!m || !m.url) { try { a.pause(); } catch (e) {} pool.clipId = ''; return; }
    if (pool.clipId !== c.id) {
      pool.clipId = c.id;
      a.src = m.url;
      try { a.load(); } catch (e) {}
      hookEl(a);
    }
    const fade = fadeFactor(c, t);
    const vol = propAt(c, 'volume', t);
    const mediaDur = isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    let srcT = (t - c.start) * c.speed + c.in;
    if (mediaDur) srcT = clamp(srcT, 0, Math.max(0, mediaDur - 0.03));
    a.playbackRate = clamp(c.speed * (S.dir > 0 ? S.rate : 1), 0.25, 4);
    a.volume = clamp(vol * S.vol * fade, 0, 1);
    a.muted = !!c.muted || !!tk.muted || vol <= 0;
    if (playing) {
      if (a.readyState >= 1 && Math.abs(a.currentTime - srcT) > 0.3) {
        try { a.currentTime = srcT; } catch (e) {}
      }
      if (a.paused) {
        const pr = a.play();
        if (pr && pr.catch) pr.catch(function () {});
      }
    } else {
      if (!a.paused) a.pause();
      if (a.readyState >= 1 && Math.abs(a.currentTime - srcT) > 0.04) {
        try { a.currentTime = srcT; } catch (e) {}
      }
    }
  }

  /* ---------------- 文字层 ---------------- */
  function textSigOf(active) {
    return active.map(function (c) {
      return [c.id, c.track, c.text.content, c.text.size, c.text.color, c.text.bg,
        c.text.bold ? 1 : 0, c.text.align, c.x, c.y, c.rot, c.scale].join('|');
    }).join('~') + '@' + S.frameW + 'x' + S.frameH + '@' + S.project.w + 'x' + S.project.h;
  }

  function activeTextsAt(t) {
    const out = [];
    S.project.tracks.forEach(function (tk) {
      if (tk.kind !== 'text' || !trackActive(tk)) return;
      S.project.clips.forEach(function (c) {
        if (c.track === tk.id && t >= c.start - 1e-4 && t < c.start + c.dur - 1e-4) out.push(c);
      });
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  function paintTexts(force) {
    const host = $('stTexts');
    if (!host) return;
    const t = S.time;
    const active = activeTextsAt(t);
    const sig = textSigOf(active);
    if (force) S.textSig = '';
    if (sig !== S.textSig) {
      S.textSig = sig;
      host.innerHTML = '';
      S.textNodes.clear();
      active.forEach(function (c) {
        const d = document.createElement('div');
        d.className = 'st-text-item';
        d.textContent = c.text.content;
        d.style.color = c.text.color;
        d.style.background = c.text.bg;
        d.style.fontWeight = c.text.bold ? '700' : '400';
        d.style.textAlign = c.text.align;
        d.style.fontSize = Math.max(6, c.text.size * (S.frameW || 640) / S.project.w).toFixed(2) + 'px';
        d.style.left = (50 + propAt(c, 'x', t)) + '%';
        d.style.top = (50 + propAt(c, 'y', t)) + '%';
        d.style.transform = 'translate(-50%,-50%) rotate(' + propAt(c, 'rot', t) + 'deg) scale(' + propAt(c, 'scale', t) + ')';
        host.appendChild(d);
        S.textNodes.set(c.id, d);
      });
    }
    active.forEach(function (c) {
      const d = S.textNodes.get(c.id);
      if (!d) return;
      d.style.left = (50 + propAt(c, 'x', t)) + '%';
      d.style.top = (50 + propAt(c, 'y', t)) + '%';
      d.style.transform = 'translate(-50%,-50%) rotate(' + propAt(c, 'rot', t) + 'deg) scale(' + propAt(c, 'scale', t) + ')';
      d.style.opacity = String(clamp(propAt(c, 'opacity', t) * fadeFactor(c, t), 0, 1));
    });
    S.textNodes.forEach(function (node, id) {
      if (!active.some(function (c) { return c.id === id; })) {
        node.remove();
        S.textNodes.delete(id);
      }
    });
  }

  /* ---------------- 播放 / 定位 ---------------- */
  function paintPlayIcon() {
    const btn = $('stPlay');
    if (!btn) return;
    const play = btn.querySelector('.st-ico-play');
    const pause = btn.querySelector('.st-ico-pause');
    if (play) play.classList.toggle('hidden', S.playing);
    if (pause) pause.classList.toggle('hidden', !S.playing);
    btn.setAttribute('aria-label', S.playing ? '暂停' : '播放');
  }

  function updateEmpty() {
    const box = $('stPrevEmpty');
    if (!box) return;
    const t = S.time;
    let any = false;
    for (const c of S.project.clips) {
      if (t >= c.start - 1e-4 && t < c.start + c.dur - 1e-4) { any = true; break; }
    }
    box.classList.toggle('hidden', any);
  }

  function paintPlayhead() {
    const ph = $('stPlayhead');
    if (!ph) return;
    ph.style.left = (S.time * S.pps).toFixed(1) + 'px';
    const sc = $('stScroll');
    if (sc && S.playing) {
      const x = S.time * S.pps;
      if (x > sc.scrollLeft + sc.clientWidth - 70) {
        sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.45);
      }
    }
  }

  function paintTc() {
    const tc = $('stTc');
    if (tc) tc.textContent = fmtTc(S.time, S.project.fps);
    const d = $('stDur');
    if (d) d.textContent = fmtMmss(projectDuration(S.project));
  }

  function applyTime() {
    tracks().forEach(function (t) {
      if (t.kind === 'video') syncVisual(t.id, S.time, S.playing && S.dir > 0);
      else if (t.kind === 'audio') syncAudio(t.id, S.time, S.playing && S.dir > 0);
    });
    paintTexts(false);
    paintPlayhead();
    paintTc();
    updateEmpty();
  }

  function seek(t) {
    S.time = clamp(Number(t) || 0, 0, Math.max(0, projectDuration(S.project)));
    S.last = 0;
    applyTime();
  }

  function seekBy(d) { seek(S.time + d); }

  /* 入出点：null 表示未设置。区间优先级高于整片。 */
  function playStart() {
    const d = projectDuration(S.project);
    return S.rngIn == null ? 0 : clamp(S.rngIn, 0, d);
  }
  function playEnd() {
    const d = projectDuration(S.project);
    return S.rngOut == null ? d : clamp(S.rngOut, 0, d);
  }
  function setRangeEdge(edge, t) {
    const d = projectDuration(S.project);
    const v = clamp(Number(t), 0, d);
    if (edge === 'in') {
      S.rngIn = round2(v);
      if (S.rngOut != null && S.rngOut <= S.rngIn) S.rngOut = null;
    } else {
      S.rngOut = round2(v);
      if (S.rngIn != null && S.rngIn >= S.rngOut) S.rngIn = null;
    }
    paintRange();
    paintStatus();
    return edge === 'in' ? S.rngIn : S.rngOut;
  }
  function clearInOut() {
    S.rngIn = null;
    S.rngOut = null;
    paintRange();
    paintStatus();
  }
  function paintRange() {
    const el = $('stRange');
    if (!el) return;
    const has = S.rngIn != null || S.rngOut != null;
    el.classList.toggle('hidden', !has);
    if (!has) return;
    const a = S.rngIn == null ? 0 : clamp(S.rngIn, 0, projectDuration(S.project));
    const b = S.rngOut == null ? projectDuration(S.project) : clamp(S.rngOut, 0, projectDuration(S.project));
    el.style.left = (a * S.pps) + 'px';
    el.style.width = Math.max(2, (b - a) * S.pps) + 'px';
    const i = el.querySelector('.st-range-in');
    const o = el.querySelector('.st-range-out');
    if (i) i.classList.toggle('hidden', S.rngIn == null);
    if (o) o.classList.toggle('hidden', S.rngOut == null);
  }

  function play() {
    const dur = projectDuration(S.project);
    if (dur <= 0.05) { toast('时间线还是空的，先把素材拖进轨道'); return; }
    ensureAudio();
    resumeAudio();
    applyMonitorGain();
    S.dir = 1;
    const end = playEnd();
    if (S.time >= end - 0.02) S.time = playStart();
    else if (S.rngIn != null && S.time < S.rngIn) S.time = playStart();
    S.playing = true;
    S.last = 0;
    paintPlayIcon();
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(tick);
    applyTime();
  }

  /* JKL：L 播放并逐次提速，K 停止复位，J 倒放（逐帧回退）。 */
  function shuttle(dir) {
    if (dir < 0) {
      const dur = projectDuration(S.project);
      if (dur <= 0.05) { toast('时间线还是空的，先把素材拖进轨道'); return; }
      if (S.time <= (S.rngIn == null ? 0 : S.rngIn) + 0.02 && S.rngOut == null) { toast('已经在开头'); return; }
      ensureAudio();
      applyMonitorGain();
      S.dir = -1;
      S.rate = 1;
      S.playing = true;
      S.last = 0;
      paintPlayIcon();
      cancelAnimationFrame(S.raf);
      S.raf = requestAnimationFrame(tick);
      applyTime();
      return;
    }
    if (!S.playing || S.dir < 0) {
      S.rate = 1;
      play();
      return;
    }
    S.rate = S.rate >= 4 ? 1 : S.rate * 2;
    applyTime();
    paintStatus();
  }

  function pause() {
    S.playing = false;
    S.dir = 1;
    S.rate = 1;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.last = 0;
    paintPlayIcon();
    tracks().forEach(function (t) {
      const p = S.pool[t.id];
      if (p && p.video) { try { p.video.pause(); } catch (e) {} }
      if (p && p.audio) { try { p.audio.pause(); } catch (e) {} }
    });
    applyTime();
    paintLevel();
  }

  function togglePlay() { if (S.playing) pause(); else play(); }

  function tick(now) {
    if (!S.playing) { S.raf = 0; return; }
    if (!S.last) S.last = now;
    let dt = (now - S.last) / 1000;
    S.last = now;
    if (dt > 0.3) dt = 0.3;
    /* 倒放不做解码播放，逐帧回退；限制 seek 频率，避免高码率素材拖死主线程。 */
    if (S.dir < 0 && now - S.lastReverseSeek < 30) {
      S.raf = requestAnimationFrame(tick);
      return;
    }
    if (S.dir < 0) S.lastReverseSeek = now;
    const start = S.exportSession ? S.exportSession.a : playStart();
    const end = S.exportSession ? S.exportSession.b : playEnd();
    const speed = S.dir < 0 ? 1 : Math.max(0.25, S.rate || 1);
    S.time += dt * speed * S.dir;
    if (S.dir < 0 && S.time <= start) {
      S.time = start;
      applyTime();
      pause();
      return;
    }
    if (S.time >= end) {
      if (S.loop && !S.exportSession) {
        S.time = start;
        S.last = 0;
        applyTime();
        S.raf = requestAnimationFrame(tick);
        return;
      }
      S.time = end;
      applyTime();
      if (S.exportSession) { finishExportTick(); return; }
      pause();
      toast('已播放到结尾');
      return;
    }
    applyTime();
    paintLevel();
    if (S.exportSession) {
      drawExportFrame();
      paintExportProgress();
    }
    S.raf = requestAnimationFrame(tick);
  }

  /* ---------------- 时间线渲染 ---------------- */
  function innerWidth() {
    const sc = $('stScroll');
    const view = sc ? sc.clientWidth : 800;
    const need = Math.max(projectDuration(S.project) + 2.4, view / S.pps);
    return Math.max(320, Math.ceil(need * S.pps) + 60);
  }

  function fmtTick(t, step) {
    if (step < 1) return t.toFixed(1) + 's';
    return fmtMmss(t);
  }

  function renderRuler() {
    const inner = $('stInner');
    const ruler = $('stRuler');
    if (!inner || !ruler) return;
    const W = innerWidth();
    inner.style.width = W + 'px';
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = steps[steps.length - 1];
    for (const s of steps) { if (s * S.pps >= 72) { major = s; break; } }
    const minor = major / 5;
    /* 超长项目 × 最大缩放时，整条标尺可能有几万像素；刻度只画到 24000px
       （足够覆盖任何可视窗口），避免一次生成上万个节点把窗口卡住。 */
    const paintW = Math.min(W, 24000);
    const total = paintW / S.pps;
    let html = '';
    const count = Math.floor(total / minor) + 1;
    for (let i = 0; i < count; i++) {
      const t = i * minor;
      const x = t * S.pps;
      if (x > W) break;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += '<i class="st-rtick' + (isMajor ? ' major' : '') + '" style="left:' + x.toFixed(1) + 'px"></i>';
      if (isMajor) {
        html += '<span class="st-rlabel" style="left:' + (x + 4).toFixed(1) + 'px">' + fmtTick(t, major) + '</span>';
      }
    }
    S.project.markers.forEach(function (m) {
      const x = m.t * S.pps;
      if (x > W) return;
      html += '<b class="st-mk" data-mk="' + m.t + '" title="' + escHtml(m.name) + '（Alt+点击删除）"' +
        ' style="left:' + x.toFixed(1) + 'px;background:' + m.color + '"></b>';
    });
    ruler.innerHTML = html;
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function kindLabel(k) {
    return k === 'audio' ? '音频' : k === 'text' ? '文字' : k === 'image' ? '图片' : '视频';
  }

  function isSelClip(c) {
    return S.sel === c.id || S.multi.has(c.id);
  }

  function clipEl(c) {
    const left = c.start * S.pps;
    const width = Math.max(14, c.dur * S.pps);
    const showMeta = width > 78;
    const kfCount = Object.keys(c.kf || {}).length;
    const fxCount = (c.effects || []).length;
    const meta = showMeta ? '<span class="st-clip-meta">' + fmtDur(c.dur) +
      (c.speed !== 1 ? ' · ' + c.speed.toFixed(2) + 'x' : '') +
      (fxCount ? ' · fx' + fxCount : '') +
      (kfCount ? ' · ◆' + kfCount : '') + '</span>' : '';
    return '<div class="st-clip' + (isSelClip(c) ? ' sel' : '') + '" data-id="' + c.id +
      '" data-kind="' + c.kind + '" style="left:' + left.toFixed(1) + 'px;width:' + width.toFixed(1) + 'px" title="' +
      escHtml(c.name) + '">' +
      (c.kind === 'audio' ? '<canvas class="st-wave"></canvas>' : '') +
      '<b class="st-clip-pattern"></b>' +
      '<span class="st-clip-name">' + escHtml(c.name) + '</span>' + meta +
      '<b class="st-trim" data-edge="l"></b><b class="st-trim" data-edge="r"></b></div>';
  }

  function renderRows() {
    const box = $('stRows');
    if (!box) return;
    box.innerHTML = tracks().map(function (t) {
      return '<div class="st-row" data-track="' + t.id + '" data-kind="' + t.kind +
        '" style="height:' + t.height + 'px"></div>';
    }).join('');
    tracks().forEach(function (t) {
      const row = box.querySelector('.st-row[data-track="' + t.id + '"]');
      if (!row) return;
      S.project.clips.filter(function (c) { return c.track === t.id; })
        .sort(function (a, b) { return a.start - b.start; })
        .forEach(function (c) { row.insertAdjacentHTML('beforeend', clipEl(c)); });
    });
    updateCounts();
    ensureVisiblePeaks();
    paintWaves();
  }

  function updateCounts() {
    tracks().forEach(function (t) {
      const el = document.querySelector('.st-th[data-track="' + t.id + '"] [data-count]');
      if (!el) return;
      el.textContent = String(S.project.clips.filter(function (c) { return c.track === t.id; }).length);
    });
  }

  function renderTimeline() {
    renderRuler();
    renderRows();
    paintRange();
  }

  function liveClipEl(c) {
    const node = document.querySelector('.st-clip[data-id="' + c.id + '"]');
    if (!node) return;
    node.style.left = (c.start * S.pps).toFixed(1) + 'px';
    node.style.width = Math.max(14, c.dur * S.pps).toFixed(1) + 'px';
    const meta = node.querySelector('.st-clip-meta');
    if (meta) meta.textContent = fmtDur(c.dur) + (c.speed !== 1 ? ' · ' + c.speed.toFixed(2) + 'x' : '');
  }

  function selectedIds() {
    if (S.multi.size) return Array.from(S.multi);
    return S.sel ? [S.sel] : [];
  }

  function paintSel() {
    document.querySelectorAll('#stRows .st-clip').forEach(function (n) {
      const c = clipOf(n.dataset.id);
      n.classList.toggle('sel', !!c && isSelClip(c));
    });
  }

  function selectClip(id, additive) {
    if (additive) {
      if (!id) {
        S.multi.clear();
        S.sel = '';
      } else {
        if (!S.multi.size && S.sel) S.multi.add(S.sel);
        if (S.multi.has(id)) {
          S.multi.delete(id);
          if (S.sel === id) S.sel = Array.from(S.multi).pop() || '';
        } else {
          S.multi.add(id);
          S.sel = id;
        }
        if (S.multi.size < 2) S.multi.clear();
      }
    } else {
      S.multi.clear();
      S.sel = id || '';
    }
    paintSel();
    renderInspector();
    paintFxSel();
  }

  function timeAtX(clientX) {
    const base = $('stRows') || $('stInner');
    if (!base) return 0;
    const rect = base.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / S.pps);
  }

  function trackAtY(clientY) {
    const rows = $('stRows');
    if (!rows) return '';
    const rect = rows.getBoundingClientRect();
    let y = clientY - rect.top;
    const list = tracks();
    for (const t of list) {
      if (y < t.height) return t.id;
      y -= t.height;
    }
    return list.length ? list[list.length - 1].id : '';
  }

  function rowTopOf(trackId) {
    let top = 0;
    for (const t of tracks()) {
      if (t.id === trackId) return top;
      top += t.height;
    }
    return 0;
  }

  function trackCompat(kind, trackId) {
    const tk = trackOf(trackId);
    if (!tk) return false;
    return tk.kind === clipKindTrack(kind);
  }

  function trackLocked(trackId) {
    const tk = trackOf(trackId);
    return !!(tk && tk.locked);
  }

  function snapValue(v, ignoreId, dur) {
    if (!S.snap) return v;
    const th = 8 / S.pps;
    const cands = [0, S.time];
    S.project.markers.forEach(function (m) { cands.push(m.t); });
    S.project.clips.forEach(function (c) {
      if (c.id === ignoreId) return;
      cands.push(c.start, c.start + c.dur);
    });
    let best = v;
    let bestD = th;
    cands.forEach(function (t) {
      const d1 = Math.abs(v - t);
      if (d1 < bestD) { bestD = d1; best = t; }
      if (dur) {
        const d2 = Math.abs(v + dur - t);
        if (d2 < bestD) { bestD = d2; best = t - dur; }
      }
    });
    return Math.max(0, best);
  }

  function maxDurFor(c, inPoint) {
    if (c.kind === 'text') return 3600;
    const m = mediaOf(c.mediaId);
    if (!m || m.kind === 'image' || !m.dur) return 3600;
    return Math.max(MIN_CLIP, (m.dur - inPoint) / (c.speed || 1));
  }

  /* ---------------- 时间线标记 ---------------- */
  function addMarker(atT) {
    const t = clamp(atT == null ? S.time : Number(atT) || 0, 0, Math.max(0, projectDuration(S.project)));
    if (S.project.markers.some(function (m) { return Math.abs(m.t - t) < 0.02; })) {
      toast('这里已经有标记');
      return null;
    }
    pushHistory('添加标记');
    const m = { t: round2(t), name: '标记 ' + (S.project.markers.length + 1), color: '#f0b429' };
    S.project.markers.push(m);
    S.project.markers.sort(function (a, b) { return a.t - b.t; });
    renderRuler();
    renderInspector();
    scheduleSave();
    toast('已添加标记：' + fmtMmss(t));
    return m;
  }

  function removeMarker(t) {
    const hit = S.project.markers.some(function (m) { return Math.abs(m.t - Number(t)) < 0.02; });
    if (!hit) return false;
    pushHistory('删除标记');
    S.project.markers = S.project.markers.filter(function (m) {
      return Math.abs(m.t - Number(t)) >= 0.02;
    });
    renderRuler();
    renderInspector();
    scheduleSave();
    toast('已删除标记');
    return true;
  }

  /* ---------------- 轨道管理 ---------------- */
  function insertTrack(kind) {
    const prefix = TRACK_PREFIX[kind] || 'v';
    let n = 1;
    while (trackOf(prefix + n)) n++;
    const id = prefix + n;
    const label = kind === 'video' ? '视频' : kind === 'text' ? '文字' : '音频';
    const t = {
      id: id, kind: kind, name: label + ' ' + n,
      locked: false, muted: false, solo: false, hidden: false, height: 46
    };
    if (kind === 'video') {
      S.project.tracks.unshift(t);
    } else {
      let idx = -1;
      S.project.tracks.forEach(function (x, i) { if (x.kind === kind) idx = i; });
      if (idx >= 0) S.project.tracks.splice(idx + 1, 0, t);
      else S.project.tracks.push(t);
    }
    return t;
  }

  function ensureTrackOfKind(kind) {
    const found = tracksOfKind(kind)[0];
    return found ? found.id : insertTrack(kind).id;
  }

  function preferredTrack(kind) {
    const pref = kind === 'video' ? 'v1' : kind === 'audio' ? 'a1' : 't1';
    const t = trackOf(pref);
    if (t && t.kind === kind) return pref;
    const list = tracksOfKind(kind);
    return list.length ? list[0].id : '';
  }

  function rebuildTracks() {
    S.textSig = '';
    S.textNodes.clear();
    S.trackSig = '';
    renderAll();
    applyTime();
    scheduleSave();
  }

  function addTrack(kind) {
    pushHistory('新建轨道');
    const t = insertTrack(kind);
    rebuildTracks();
    toast('已新增轨道：' + t.name);
    return t;
  }

  function removeTrack(id) {
    const t = trackOf(id);
    if (!t) return false;
    if (tracks().length <= 1) { toast('至少保留一条轨道'); return false; }
    if (S.project.clips.some(function (c) { return c.track === id; })) {
      toast('轨道上还有片段，先删掉片段'); return false;
    }
    pushHistory('删除轨道');
    S.project.tracks = S.project.tracks.filter(function (x) { return x.id !== id; });
    if (S.sel && !clipOf(S.sel)) S.sel = '';
    rebuildTracks();
    toast('已删除空轨道');
    return true;
  }

  function setTrackFlag(id, key) {
    const t = trackOf(id);
    if (!t || ['locked', 'muted', 'solo', 'hidden'].indexOf(key) < 0) return;
    pushHistory('切换轨道开关');
    t[key] = !t[key];
    buildTrackHeads();
    applyTime();
    scheduleSave();
  }

  function setTrackHeight(id, h) {
    const t = trackOf(id);
    if (!t) return;
    t.height = clamp(Math.round(h), 32, 120);
    const head = document.querySelector('.st-th[data-track="' + id + '"]');
    const row = document.querySelector('.st-row[data-track="' + id + '"]');
    if (head) head.style.height = t.height + 'px';
    if (row) row.style.height = t.height + 'px';
  }

  /* ---------------- 片段增删改 ---------------- */
  function addMediaClip(mediaId, track, start, silent) {
    const m = mediaOf(mediaId);
    if (!m) return null;
    const wantKind = clipKindTrack(m.kind);
    let tr = track && trackCompat(m.kind, track) ? track : '';
    if (!tr) tr = preferredTrack(wantKind);
    if (tr && trackLocked(tr)) {
      if (!silent) toast('轨道已锁定，先解锁');
      return null;
    }
    const needTrack = !tr;
    const dur = m.kind === 'image' ? 5 : Math.max(MIN_CLIP, m.dur || 5);
    pushHistory('添加片段');
    if (needTrack) tr = insertTrack(wantKind).id;
    const at = start == null ? trackEnd(tr) : Math.max(0, start);
    const c = makeClip({
      track: tr,
      kind: m.kind,
      mediaId: m.id,
      name: m.name,
      start: at,
      dur: Math.min(dur, maxDurFor({ kind: m.kind, mediaId: m.id, speed: 1 }, 0)),
      volume: m.kind === 'audio' ? 0.9 : 1
    });
    S.project.clips.push(c);
    S.sel = c.id;
    S.multi.clear();
    if (needTrack) rebuildTracks();
    else { renderTimeline(); renderInspector(); applyTime(); scheduleSave(); }
    if (!silent) toast('已加入时间线：' + m.name);
    return c;
  }

  function addTextClip(presetId, opts) {
    const p = TEXT_PRESETS.find(function (x) { return x.id === presetId; }) || TEXT_PRESETS[0];
    const st = p.style;
    const at = opts && opts.start != null ? opts.start : S.time;
    const needTrack = !tracksOfKind('text').length;
    pushHistory('添加文字');
    const trackId = needTrack ? insertTrack('text').id : tracksOfKind('text')[0].id;
    if (trackLocked(trackId)) { dropHistory(); toast('文字轨道已锁定'); return null; }
    const c = makeClip({
      track: trackId,
      kind: 'text',
      name: (opts && opts.name) || p.name,
      start: Math.max(0, at),
      dur: (opts && opts.dur) || 4,
      text: {
        content: (opts && opts.content) || (p.id === 'caption' ? '这是一句字幕' : '输入标题文字'),
        size: st.size,
        color: st.color,
        bg: st.bg,
        bold: st.bold,
        align: st.align
      }
    });
    c.y = st.y || 0;
    S.project.clips.push(c);
    S.sel = c.id;
    S.multi.clear();
    if (needTrack) rebuildTracks();
    else { renderTimeline(); renderInspector(); applyTime(); scheduleSave(); }
    toast('已添加文字，可在右侧改内容');
    return c;
  }

  function splitAt(t) {
    t = t == null ? S.time : t;
    let target = null;
    if (S.sel) {
      const c = clipOf(S.sel);
      if (c && t > c.start + 0.04 && t < c.start + c.dur - 0.04) target = c;
    }
    if (!target) {
      for (const c of S.project.clips) {
        if (t > c.start + 0.04 && t < c.start + c.dur - 0.04) {
          if (!target || c.start > target.start) target = c;
        }
      }
    }
    if (!target) { toast('把播放头放在片段中间再分割'); return null; }
    return splitClip(target, t);
  }

  /* 关键帧按局部时间段切片：from/to 都是相对片段起点的时间。 */
  function kfSlice(kf, from, to) {
    const out = {};
    Object.keys(kf || {}).forEach(function (prop) {
      const arr = kf[prop] || [];
      const pts = arr.map(function (k) {
        return { t: round2(k.t - from), v: k.v, ease: k.ease };
      }).filter(function (k) { return k.t >= -0.001 && k.t <= (to - from) + 0.001; });
      if (pts.length) out[prop] = pts;
    });
    return out;
  }

  /* 纯数据切割：不改历史、不重绘，供分割 / 覆盖 / 粘贴共用。 */
  function cutClip(target, t) {
    if (!target) return null;
    const leftDur = t - target.start;
    const right = JSON.parse(JSON.stringify(target));
    right.id = uid('c');
    right.start = round2(t);
    right.dur = round2(target.dur - leftDur);
    right.in = round2(target.in + leftDur * target.speed);
    right.kf = kfSlice(target.kf, leftDur, target.dur);
    target.kf = kfSlice(target.kf, 0, leftDur);
    target.dur = round2(leftDur);
    S.project.clips.push(right);
    return right;
  }

  /* 在播放头一次切开所有未锁定轨道；一次历史、一次重绘。 */
  function splitAllAt(t) {
    const at = t == null ? S.time : Number(t);
    const targets = S.project.clips.filter(function (c) {
      return !trackLocked(c.track) && at > c.start + 0.04 && at < c.start + c.dur - 0.04;
    });
    if (!targets.length) { toast('播放头没有可切割的片段'); return 0; }
    pushHistory('在播放头切开所有轨道');
    const made = targets.map(function (c) { return cutClip(c, at); }).filter(Boolean);
    S.multi = new Set(made.map(function (c) { return c.id; }));
    if (S.multi.size < 2) S.multi.clear();
    S.sel = made.length ? made[made.length - 1].id : '';
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast('已切开 ' + made.length + ' 个片段');
    return made.length;
  }

  /* 把指定片段在时间 t 处切成两段（播放头分割与剃刀工具共用）。 */
  function splitClip(target, t) {
    if (!target) return null;
    if (t <= target.start + 0.04 || t >= target.start + target.dur - 0.04) return null;
    if (trackLocked(target.track)) { toast('轨道已锁定，先解锁'); return null; }
    pushHistory('分割片段');
    const right = cutClip(target, t);
    S.sel = right.id;
    S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast('已在 ' + fmtMmss(t) + ' 处分割');
    return right;
  }

  function duplicateSelected() {
    const ids = selectedIds();
    const group = ids.map(clipOf).filter(Boolean);
    if (!group.length) { toast('先选中片段'); return null; }
    pushHistory('复制片段');
    const end = Math.max.apply(null, group.map(function (c) { return c.start + c.dur; }));
    const minStart = Math.min.apply(null, group.map(function (c) { return c.start; }));
    const made = [];
    group.forEach(function (c) {
      const copy = JSON.parse(JSON.stringify(c));
      copy.id = uid('c');
      copy.start = round2(end + (c.start - minStart));
      copy.name = c.name + ' 副本';
      S.project.clips.push(copy);
      made.push(copy);
    });
    S.multi = new Set(made.map(function (c) { return c.id; }));
    S.sel = made[made.length - 1].id;
    if (S.multi.size < 2) S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast(made.length > 1 ? '已复制 ' + made.length + ' 个片段' : '已复制片段');
    return made[made.length - 1];
  }

  function shiftTrackAfter(trackId, fromT, delta, exceptId) {
    if (!delta) return;
    S.project.clips.forEach(function (x) {
      if (x.track !== trackId || x.id === exceptId) return;
      if (x.start >= fromT - 1e-4) x.start = round2(Math.max(0, x.start + delta));
    });
  }

  function deleteSelected(ripple) {
    const ids = selectedIds();
    if (!ids.length) { toast('先选中片段'); return false; }
    const group = ids.map(clipOf).filter(Boolean);
    if (group.some(function (c) { return trackLocked(c.track); })) {
      toast('选中片段所在轨道已锁定');
      return false;
    }
    pushHistory(ripple ? '波纹删除片段' : '删除片段');
    const removedByTrack = {};
    group.forEach(function (c) {
      (removedByTrack[c.track] = removedByTrack[c.track] || []).push(c);
    });
    const drop = new Set(ids);
    S.project.clips = S.project.clips.filter(function (c) { return !drop.has(c.id); });
    if (ripple) {
      S.project.clips.forEach(function (c) {
        const rs = removedByTrack[c.track] || [];
        let shift = 0;
        rs.forEach(function (r) { if (r.start + r.dur <= c.start + 1e-4) shift += r.dur; });
        if (shift) c.start = round2(Math.max(0, c.start - shift));
      });
    }
    S.sel = '';
    S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast(ripple ? '已波纹删除 ' + group.length + ' 个片段' : '已删除 ' + group.length + ' 个片段');
    return true;
  }

  /* ---------------- 覆盖 / 插入 / 剪贴板 ---------------- */
  /* 清空某轨在 [a,b) 内的内容：完全覆盖的删除，部分覆盖的裁切，跨中间的切开。 */
  function clearRange(trackId, a, b) {
    if (!(b > a)) return 0;
    let touched = 0;
    S.project.clips.slice().forEach(function (c) {
      if (c.track !== trackId) return;
      const s = c.start;
      const e = c.start + c.dur;
      if (e <= a + 1e-4 || s >= b - 1e-4) return;
      touched += 1;
      if (s >= a - 1e-4 && e <= b + 1e-4) {
        S.project.clips = S.project.clips.filter(function (x) { return x.id !== c.id; });
        return;
      }
      if (s < a - 1e-4 && e > b + 1e-4) cutClip(c, b);
      if (s < a - 1e-4) {
        c.kf = kfSlice(c.kf, 0, a - s);
        c.dur = round2(a - s);
      } else {
        const shift = b - s;
        c.kf = kfSlice(c.kf, shift, c.dur);
        c.start = round2(b);
        c.in = round2(c.in + shift * c.speed);
        c.dur = round2(e - b);
      }
    });
    return touched;
  }

  /* 插入编辑：先切开跨越插入点的片段，再把插入点之后的片段整体后移（同步锁语义）。 */
  function shiftAllTracksAfter(at, dur) {
    if (!dur) return;
    S.project.clips.slice().forEach(function (c) {
      if (trackLocked(c.track)) return;
      if (c.start < at - 1e-4 && c.start + c.dur > at + 1e-4) cutClip(c, at);
    });
    S.project.clips.forEach(function (c) {
      if (trackLocked(c.track)) return;
      if (c.start >= at - 1e-4) c.start = round2(c.start + dur);
    });
  }

  /* 素材落点：insert = 撑开空隙，overwrite = 清空目标区间。 */
  function placeMedia(mediaId, mode) {
    const m = mediaOf(mediaId);
    if (!m) return null;
    const want = m.kind === 'text' ? 'text' : m.kind === 'audio' ? 'audio' : 'video';
    const tr0 = preferredTrack(want);
    if (tr0 && trackLocked(tr0)) { toast('目标轨道已锁定，先解锁'); return null; }
    const dur = round2(m.kind === 'image' ? 5 : Math.max(MIN_CLIP, m.dur || 5));
    const at = round2(S.time);
    pushHistory(mode === 'insert' ? '插入素材' : '覆盖素材');
    const tr = tr0 || insertTrack(want).id;
    if (mode === 'insert') shiftAllTracksAfter(at, dur);
    else clearRange(tr, at, at + dur);
    const c = makeClip({
      track: tr,
      kind: m.kind,
      mediaId: m.id,
      name: m.name,
      start: at,
      dur: Math.min(dur, maxDurFor({ kind: m.kind, mediaId: m.id, speed: 1 }, 0)),
      volume: m.kind === 'audio' ? 0.9 : 1
    });
    S.project.clips.push(c);
    S.sel = c.id;
    S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast((mode === 'insert' ? '已插入：' : '已覆盖：') + m.name);
    return c;
  }

  function copySelected() {
    const group = selectedIds().map(clipOf).filter(Boolean);
    if (!group.length) { toast('先选中片段'); return 0; }
    const base = Math.min.apply(null, group.map(function (c) { return c.start; }));
    S.clipboard = { base: round2(base), items: JSON.parse(JSON.stringify(group)) };
    toast('已复制 ' + group.length + ' 个片段，Ctrl+V 粘贴到播放头');
    return group.length;
  }

  function pasteAt(t) {
    if (!S.clipboard || !S.clipboard.items.length) { toast('剪贴板是空的'); return 0; }
    const cb = S.clipboard;
    const anchor = Math.max(0, t == null ? S.time : Number(t));
    const offset = Math.max(anchor - cb.base, -cb.base);
    const made = [];
    let skipped = 0;
    pushHistory('粘贴片段');
    cb.items.forEach(function (src) {
      const c = JSON.parse(JSON.stringify(src));
      const want = c.kind === 'text' ? 'text' : c.kind === 'audio' ? 'audio' : 'video';
      const tr = trackOf(c.track) ? c.track : preferredTrack(want);
      if (!tr || trackLocked(tr)) { skipped += 1; return; }
      c.id = uid('c');
      c.track = tr;
      c.start = round2(Math.max(0, src.start + offset));
      clearRange(tr, c.start, c.start + c.dur);
      S.project.clips.push(c);
      made.push(c);
    });
    if (!made.length) {
      dropHistory();
      toast('没有可粘贴的轨道');
      return 0;
    }
    S.multi = new Set(made.map(function (c) { return c.id; }));
    if (S.multi.size < 2) S.multi.clear();
    S.sel = made[made.length - 1].id;
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast('已粘贴 ' + made.length + ' 个片段' + (skipped ? '，跳过 ' + skipped + ' 个锁定轨道' : ''));
    return made.length;
  }

  /* ---------------- 右键菜单 / 分离音频 ---------------- */
  function canDetachAudio(c) {
    if (!c || c.kind !== 'video') return false;
    const m = mediaOf(c.mediaId);
    return !!(m && m.kind === 'video' && m.url);
  }

  function audioDetachedFor(c) {
    return S.project.clips.some(function (x) {
      return x.kind === 'audio' && x.mediaId === c.mediaId &&
        Math.abs(x.start - c.start) < 0.02 && Math.abs(x.dur - c.dur) < 0.02;
    });
  }

  /* 把视频片段的音轨分离到音频轨：原片段静音，音频片段共用同一素材与入点。 */
  function detachAudio(id) {
    const c = clipOf(id);
    if (!canDetachAudio(c)) { toast('这条片段没有可分离的音频'); return null; }
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return null; }
    if (audioDetachedFor(c)) { toast('这条片段的音频已经分离过'); return null; }
    let tr = preferredTrack('audio');
    if (tr && trackLocked(tr)) { toast('音频轨道已锁定，先解锁'); return null; }
    const needTrack = !tr;
    pushHistory('分离音频');
    if (needTrack) tr = insertTrack('audio').id;
    const a = makeClip({
      track: tr,
      kind: 'audio',
      mediaId: c.mediaId,
      name: c.name + ' · 音频',
      start: c.start,
      dur: c.dur,
      in: c.in,
      speed: c.speed,
      volume: c.volume,
      muted: c.muted,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut
    });
    if (c.kf && c.kf.volume) a.kf.volume = JSON.parse(JSON.stringify(c.kf.volume));
    S.project.clips.push(a);
    c.muted = true;
    S.sel = a.id;
    S.multi.clear();
    if (needTrack) rebuildTracks();
    else { renderTimeline(); renderInspector(); applyTime(); scheduleSave(); }
    toast('已分离音频到「' + trackOf(tr).name + '」');
    return a;
  }

  /* 文字转语音：把文字片段念成音频，落到音频轨，作为普通片段参与播放与导出。 */
  async function generateVoice(id) {
    const c = clipOf(id);
    if (!c || c.kind !== 'text') return null;
    const text = String((c.text && c.text.content) || '').trim();
    if (!text) { toast('文字片段是空的'); return null; }
    const bridge = window.ttsBridge;
    if (!bridge || typeof bridge.speak !== 'function') { toast('当前环境没有语音合成模块'); return null; }
    if (!bridge.isLocal()) {
      toast('当前音色是系统语音，去模型商店下载本地音色后才能生成配音');
      return null;
    }
    toast('正在合成配音…');
    let r = null;
    try {
      r = await bridge.speak(text, { rate: bridge.defaultRate ? bridge.defaultRate() : 1 });
    } catch (e) {
      toast('配音失败：' + ((e && e.message) || e));
      return null;
    }
    if (!r || !r.url) { toast('配音失败：没有返回音频'); return null; }
    const dur = Math.max(MIN_CLIP, (await probeDuration(r.url, 'audio')) || 5);
    pushHistory('生成配音');
    const media = {
      id: 'tts:' + uid('m'),
      name: '配音 · ' + (c.name || '文字'),
      kind: 'audio',
      url: r.url,
      dur: round2(dur),
      source: 'tts',
      libId: '',
      assetId: '',
      tts: { text: text, voice: String(r.voice || ''), rate: Number(r.rate) || 1 }
    };
    S.project.media.push(media);
    const trackId = ensureTrackOfKind('audio');
    const clip = makeClip({
      track: trackId, kind: 'audio', mediaId: media.id, name: media.name,
      start: c.start, dur: round2(dur), in: 0, volume: 1, kf: {}
    });
    S.project.clips.push(clip);
    S.sel = clip.id;
    S.multi.clear();
    rebuildTracks();
    toast('已生成 ' + fmtDur(dur) + ' 配音到「' + trackOf(trackId).name + '」');
    return clip;
  }

  function clipMenuItems(c) {
    const lock = trackLocked(c.track);
    const inClip = S.time > c.start + 0.04 && S.time < c.start + c.dur - 0.04;
    const detached = audioDetachedFor(c);
    const items = [
      {
        id: 'split', label: '在播放头处分割', hint: 'S', disabled: !inClip || lock,
        run: function () { splitAt(S.time); }
      },
      {
        id: 'detach', label: detached ? '音频已分离' : '分离音频轨道',
        disabled: lock || !canDetachAudio(c) || detached,
        run: function () { detachAudio(c.id); }
      },
      {
        id: 'mute', label: c.muted ? '取消静音' : '静音', disabled: lock,
        run: function () { setClipProps(c.id, { muted: !c.muted }); }
      },
      { sep: true },
      { id: 'dup', label: '复制片段', hint: 'Ctrl+D', run: duplicateSelected },
      { id: 'del', label: '删除', hint: 'Del', run: function () { deleteSelected(false); } },
      { id: 'rdel', label: '波纹删除', hint: 'Shift+Del', run: function () { deleteSelected(true); } }
    ];
    if (c.kind === 'text') {
      items.splice(2, 0, {
        id: 'voice', label: '生成配音（文字转语音）',
        disabled: lock || !String((c.text && c.text.content) || '').trim(),
        run: function () { generateVoice(c.id); }
      });
    }
    return items;
  }

  function closeClipMenu() {
    const el = $('stCtx');
    if (el) el.remove();
  }

  function openClipMenu(c, x, y) {
    closeClipMenu();
    if (!c) return;
    if (!isSelClip(c)) selectClip(c.id);
    const menu = document.createElement('div');
    menu.className = 'st-ctx';
    menu.id = 'stCtx';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = clipMenuItems(c).map(function (it) {
      if (it.sep) return '<span class="st-ctx-sep"></span>';
      return '<button type="button" role="menuitem" data-mi="' + it.id + '"' +
        (it.disabled ? ' disabled' : '') + '>' + escHtml(it.label) +
        (it.hint ? '<span class="st-ctx-hint">' + it.hint + '</span>' : '') + '</button>';
    }).join('');
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    const items = clipMenuItems(c);
    menu.addEventListener('click', function (e) {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const it = items.filter(function (x) { return x.id === b.dataset.mi; })[0];
      closeClipMenu();
      if (it && !it.disabled && it.run) it.run();
    });
  }

  function openMediaMenu(m, x, y) {
    closeClipMenu();
    if (!m) return;
    const menu = document.createElement('div');
    menu.className = 'st-ctx';
    menu.id = 'stCtx';
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<button type="button" role="menuitem" data-mi="append">追加到时间线</button>' +
      '<button type="button" role="menuitem" data-mi="insert">插入到播放头（波纹）</button>' +
      '<button type="button" role="menuitem" data-mi="overwrite">覆盖到播放头</button>';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    menu.addEventListener('click', function (e) {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      closeClipMenu();
      if (b.dataset.mi === 'append') addMediaClip(m.id, null, null);
      else placeMedia(m.id, b.dataset.mi);
    });
  }

  function setClipProps(id, patch) {
    const c = clipOf(id);
    if (!c) return null;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return c; }
    Object.keys(patch || {}).forEach(function (k) {
      if (k === 'text') {
        Object.keys(patch.text || {}).forEach(function (tk) { c.text[tk] = patch.text[tk]; });
      } else if (k === 'kf') {
        c.kf = normalizeKf(patch.kf);
      } else if (k in c) {
        c[k] = patch[k];
      }
    });
    c.dur = Math.max(MIN_CLIP, Number(c.dur) || MIN_CLIP);
    c.start = Math.max(0, Number(c.start) || 0);
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
    return c;
  }

  /* ---------------- 关键帧写入 ---------------- */
  function addKeyframe(id, prop, atT) {
    const c = clipOf(id);
    if (!c || KF_PROPS.indexOf(prop) < 0) return null;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return null; }
    const local = clamp((atT == null ? S.time : atT) - c.start, 0, c.dur);
    const v = propAt(c, prop, c.start + local);
    pushHistory('添加关键帧');
    c.kf = c.kf || {};
    const arr = (c.kf[prop] || []).filter(function (k) { return Math.abs(k.t - local) > 0.02; });
    arr.push({ t: round2(local), v: Math.round(v * 1000) / 1000, ease: 'linear' });
    arr.sort(function (a, b) { return a.t - b.t; });
    c.kf[prop] = arr;
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
    toast('已在 ' + fmtDur(local) + ' 处打点：' + prop);
    return c.kf[prop];
  }

  function clearKeyframes(id, prop) {
    const c = clipOf(id);
    if (!c) return false;
    pushHistory('清除关键帧');
    if (prop) delete c.kf[prop];
    else c.kf = {};
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
    return true;
  }

  /* ---------------- 剪辑手势（预览与测试共用） ---------------- */
  function trimClip(c, edge, dx, base, ripple) {
    const speed = c.speed || 1;
    if (edge === 'l') {
      if (ripple) {
        const d = clamp(dx, -base.in / speed, base.dur - MIN_CLIP);
        c.in = round2(Math.max(0, base.in + d * speed));
        c.dur = round2(base.dur - d);
        shiftTrackAfter(c.track, base.start + base.dur, -d, c.id);
      } else {
        let ns = clamp(base.start + dx, 0, base.start + base.dur - MIN_CLIP);
        ns = snapValue(ns, c.id, 0);
        const d = clamp(ns - base.start, -base.in / speed, base.dur - MIN_CLIP);
        c.start = round2(Math.max(0, base.start + d));
        c.in = round2(Math.max(0, base.in + d * speed));
        c.dur = round2(Math.max(MIN_CLIP, base.dur - d));
      }
    } else {
      let end = base.start + base.dur + dx;
      end = snapValue(end, c.id, 0);
      const dur = clamp(end - base.start, MIN_CLIP, maxDurFor(c, base.in));
      const d = dur - base.dur;
      c.dur = round2(dur);
      if (ripple) shiftTrackAfter(c.track, base.start + base.dur, d, c.id);
    }
    return c;
  }

  function rollClip(c, edge, dx, base) {
    const speed = c.speed || 1;
    if (edge === 'r') {
      const endT = base.start + base.dur;
      const next = S.project.clips.filter(function (x) {
        return x.track === c.track && x.id !== c.id && Math.abs(x.start - endT) < 0.06;
      })[0];
      if (!next) return trimClip(c, 'r', dx, base, false);
      const lo = Math.max(-base.dur + MIN_CLIP, -next.in / speed);
      const hi = Math.min(maxDurFor(c, base.in) - base.dur, next.dur - MIN_CLIP);
      const d = clamp(dx, lo, hi);
      c.dur = round2(base.dur + d);
      next.start = round2(next.start + d);
      next.in = round2(Math.max(0, next.in + d * speed));
      next.dur = round2(Math.max(MIN_CLIP, next.dur - d));
    } else {
      const prev = S.project.clips.filter(function (x) {
        return x.track === c.track && x.id !== c.id && Math.abs(x.start + x.dur - base.start) < 0.06;
      })[0];
      if (!prev) return trimClip(c, 'l', dx, base, false);
      const lo = Math.max(-prev.dur + MIN_CLIP, -base.in / speed);
      const hi = Math.min(base.dur - MIN_CLIP, maxDurFor(prev, prev.in) - prev.dur);
      const d = clamp(dx, lo, hi);
      c.start = round2(base.start + d);
      c.in = round2(Math.max(0, base.in + d * speed));
      c.dur = round2(base.dur - d);
      prev.dur = round2(prev.dur + d);
    }
    return c;
  }

  function slipClip(c, dx, baseIn) {
    if (c.kind === 'text') return c;
    const m = mediaOf(c.mediaId);
    if (!m || m.kind === 'image' || !m.dur) return c;
    const speed = c.speed || 1;
    const maxIn = Math.max(0, m.dur - c.dur * speed);
    c.in = round2(clamp((baseIn == null ? c.in : baseIn) + dx * speed, 0, maxIn));
    return c;
  }

  function slideClip(c, dx) {
    const speed = c.speed || 1;
    const start = c.start;
    const end = c.start + c.dur;
    const next = S.project.clips.filter(function (x) {
      return x.track === c.track && x.id !== c.id && Math.abs(x.start - end) < 0.06;
    })[0];
    const prev = S.project.clips.filter(function (x) {
      return x.track === c.track && x.id !== c.id && Math.abs(x.start + x.dur - start) < 0.06;
    })[0];
    let lo = -start;
    let hi = Infinity;
    if (prev) lo = Math.max(lo, -(prev.dur - MIN_CLIP));
    if (next) {
      lo = Math.max(lo, -next.in / speed);
      hi = Math.min(hi, next.dur - MIN_CLIP);
    }
    const d = clamp(dx, lo, hi);
    c.start = round2(start + d);
    if (prev) prev.dur = round2(prev.dur + d);
    if (next) {
      next.start = round2(next.start + d);
      next.in = round2(Math.max(0, next.in + d * speed));
      next.dur = round2(next.dur - d);
    }
    return c;
  }

  /* ---------------- 时间线拖拽 ---------------- */
  function paintMarquee() {
    const el = $('stMarquee');
    const m = S.marquee;
    if (!el) return;
    if (!m) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.style.left = Math.min(m.x0, m.x1) + 'px';
    el.style.top = Math.min(m.y0, m.y1) + 'px';
    el.style.width = Math.abs(m.x1 - m.x0) + 'px';
    el.style.height = Math.abs(m.y1 - m.y0) + 'px';
  }
  /* 框选命中：时间区间相交 + 轨道行区间相交。 */
  function marqueeHits(m) {
    const a = Math.min(m.x0, m.x1) / S.pps;
    const b = Math.max(m.x0, m.x1) / S.pps;
    const y0 = Math.min(m.y0, m.y1) - RULER_H;
    const y1 = Math.max(m.y0, m.y1) - RULER_H;
    const hits = [];
    let top = 0;
    tracks().forEach(function (t) {
      const bottom = top + t.height;
      if (Math.min(y1, bottom) > Math.max(y0, top)) {
        S.project.clips.forEach(function (c) {
          if (c.track !== t.id) return;
          if (c.start + c.dur < a || c.start > b) return;
          hits.push(c);
        });
      }
      top = bottom;
    });
    return hits;
  }
  function paintMarqueeSel() {
    const m = S.marquee;
    if (!m) return;
    const hit = marqueeHits(m);
    const base = S.drag && S.drag.baseSel ? S.drag.baseSel : [];
    S.multi = new Set(base);
    hit.forEach(function (c) { S.multi.add(c.id); });
    if (S.multi.size < 2) S.multi.clear();
    S.sel = hit.length ? hit[0].id : (S.multi.size ? Array.from(S.multi).pop() : '');
    paintSel();
  }
  /* 拖到时间线边缘时自动滚动：跟随指针移动事件，不做后台动画。 */
  function autoScroll(cx, cy) {
    const sc = $('stScroll');
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    const zone = 44;
    if (cx < r.left + zone) sc.scrollLeft = Math.max(0, sc.scrollLeft - Math.ceil((r.left + zone - cx) / 3));
    else if (cx > r.right - zone) sc.scrollLeft += Math.ceil((cx - (r.right - zone)) / 3);
    if (cy < r.top + zone) sc.scrollTop = Math.max(0, sc.scrollTop - Math.ceil((r.top + zone - cy) / 3));
    else if (cy > r.bottom - zone) sc.scrollTop += Math.ceil((cy - (r.bottom - zone)) / 3);
  }

  function onTimelineDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const trim = e.target.closest('.st-trim');
    const clipNode = e.target.closest('.st-clip');
    const row = e.target.closest('.st-row');
    if (!clipNode) {
      if (!row) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!additive) selectClip('');
      const inner = $('stInner');
      const ir = inner ? inner.getBoundingClientRect() : { left: 0, top: 0 };
      S.drag = {
        mode: 'scrub',
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        ix0: e.clientX - ir.left,
        iy0: e.clientY - ir.top,
        baseSel: Array.from(S.multi),
        moved: false
      };
      try { $('stRows').setPointerCapture(e.pointerId); } catch (err) {}
      seek(timeAtX(e.clientX));
      e.preventDefault();
      return;
    }
    const c = clipOf(clipNode.dataset.id);
    if (!c) return;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return; }
    if (S.tool === 'blade') {
      const at = timeAtX(e.clientX);
      if (at <= c.start + 0.04 || at >= c.start + c.dur - 0.04) {
        toast('点在片段中间才能切割');
      } else {
        splitClip(c, at);
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const additive = e.shiftKey || ((e.ctrlKey || e.metaKey) && !isSelClip(c));
    if (additive) selectClip(c.id, true);
    else if (!isSelClip(c)) selectClip(c.id);
    else { S.sel = c.id; paintSel(); renderInspector(); }

    const edge = trim ? trim.dataset.edge : '';
    let mode = 'move';
    if (edge) {
      if (e.altKey) mode = edge === 'l' ? 'rippleL' : 'rippleR';
      else if (e.ctrlKey || e.metaKey) mode = edge === 'l' ? 'rollL' : 'rollR';
      else mode = edge === 'l' ? 'trimL' : 'trimR';
    } else if (e.altKey) mode = 'slip';
    else if ((e.ctrlKey || e.metaKey) && !additive) mode = 'slide';

    const group = selectedIds().map(clipOf).filter(Boolean);
    pushHistory(mode === 'blade' ? '切分片段'
      : mode === 'trim' ? '修剪片段'
      : mode === 'roll' ? '滚动剪辑'
      : mode === 'slip' ? '滑移片段'
      : mode === 'slide' ? '滑动片段'
      : '移动片段');
    S.drag = {
      mode: mode,
      id: c.id,
      x0: e.clientX,
      y0: e.clientY,
      start0: c.start,
      dur0: c.dur,
      in0: c.in,
      track0: c.track,
      items: group.map(function (x) { return { id: x.id, start: x.start, track: x.track }; }),
      changed: false,
      pointerId: e.pointerId
    };
    try { $('stRows').setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    const d = S.drag;
    if (!d) return;
    if (d.mode === 'scrub') {
      const dist = Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0);
      if (!d.moved && dist < 6) return;
      const inner = $('stInner');
      const ir = inner ? inner.getBoundingClientRect() : { left: 0, top: 0 };
      if (!d.moved) {
        d.moved = true;
        S.marquee = { x0: d.ix0, y0: d.iy0, x1: d.ix0, y1: d.iy0 };
      }
      S.marquee.x1 = e.clientX - ir.left;
      S.marquee.y1 = e.clientY - ir.top;
      paintMarquee();
      paintMarqueeSel();
      autoScroll(e.clientX, e.clientY);
      return;
    }
    if (d.mode === 'height') {
      setTrackHeight(d.id, d.h0 + (e.clientY - d.y0));
      d.changed = true;
      return;
    }
    autoScroll(e.clientX, e.clientY);
    const c = clipOf(d.id);
    if (!c) { S.drag = null; return; }
    const dx = (e.clientX - d.x0) / S.pps;

    if (d.mode === 'move') {
      if (d.items.length > 1) {
        const anchor = snapValue(d.start0 + dx, c.id, c.dur);
        const delta = anchor - d.start0;
        d.items.forEach(function (it) {
          const x = clipOf(it.id);
          if (x) x.start = round2(Math.max(0, it.start + delta));
        });
      } else {
        const tr = trackAtY(e.clientY);
        if (tr && tr !== c.track && trackCompat(c.kind, tr) && !trackLocked(tr) &&
          Math.abs(e.clientY - d.y0) > 12) {
          c.track = tr;
        }
        c.start = round2(Math.max(0, snapValue(d.start0 + dx, c.id, c.dur)));
      }
    } else if (d.mode === 'trimL' || d.mode === 'trimR') {
      trimClip(c, d.mode === 'trimL' ? 'l' : 'r', dx,
        { start: d.start0, dur: d.dur0, in: d.in0 }, false);
    } else if (d.mode === 'rippleL' || d.mode === 'rippleR') {
      trimClip(c, d.mode === 'rippleL' ? 'l' : 'r', dx,
        { start: d.start0, dur: d.dur0, in: d.in0 }, true);
    } else if (d.mode === 'rollL' || d.mode === 'rollR') {
      rollClip(c, d.mode === 'rollL' ? 'l' : 'r', dx,
        { start: d.start0, dur: d.dur0, in: d.in0 });
    } else if (d.mode === 'slip') {
      slipClip(c, dx, d.in0);
    } else if (d.mode === 'slide') {
      slideClip(c, dx);
    }
    d.changed = true;
    if (d.mode === 'move' && d.items.length > 1) {
      renderRows();
    } else {
      liveClipEl(c);
    }
    applyTime();
  }

  function onPointerUp() {
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    if (d.mode === 'scrub') {
      if (d.moved) {
        S.marquee = null;
        paintMarquee();
        renderInspector();
        paintFxSel();
        const n = S.multi.size || (S.sel ? 1 : 0);
        if (n > 1) toast('已框选 ' + n + ' 个片段');
      }
      return;
    }
    if (!d.changed) { dropHistory(); return; }
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
  }

  /* ---------------- 从素材池拖进轨道 ---------------- */
  function clearDrop() {
    S.drop = null;
    const line = $('stDrop');
    if (line) line.classList.add('hidden');
    document.querySelectorAll('.st-row.dragover,.st-row.dropbad').forEach(function (r) {
      r.classList.remove('dragover', 'dropbad');
    });
  }

  function onTimelineDragOver(e) {
    if (!S.dragMediaId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const m = mediaOf(S.dragMediaId);
    const tr = trackAtY(e.clientY);
    const tk = trackOf(tr);
    const ok = !!m && trackCompat(m.kind, tr) && !trackLocked(tr);
    S.drop = { track: tr, time: timeAtX(e.clientX), ok: ok };
    document.querySelectorAll('.st-row').forEach(function (r) {
      r.classList.toggle('dragover', ok && r.dataset.track === tr);
      r.classList.toggle('dropbad', !ok && r.dataset.track === tr);
    });
    const line = $('stDrop');
    if (line) {
      line.classList.remove('hidden');
      line.style.left = (S.drop.time * S.pps).toFixed(1) + 'px';
      line.style.top = (RULER_H + rowTopOf(tr)) + 'px';
      line.style.height = (tk ? tk.height : 46) + 'px';
      line.style.background = ok ? '' : '#d9534f';
    }
  }

  function onTimelineDrop(e) {
    if (!S.dragMediaId) return;
    e.preventDefault();
    const id = S.dragMediaId;
    const drop = S.drop;
    S.dragMediaId = '';
    clearDrop();
    if (!drop) return;
    if (!drop.ok) { toast('这条轨道放不下该素材'); return; }
    addMediaClip(id, drop.track, drop.time);
  }

  /* ---------------- 素材池 ---------------- */
  function mediaCard(m) {
    const kindTxt = m.kind === 'video' ? 'VIDEO' : m.kind === 'audio' ? 'AUDIO' : 'IMAGE';
    let thumb;
    if (m.kind === 'image') {
      thumb = '<img src="' + escHtml(m.url) + '" alt="">';
    } else if (m.kind === 'video') {
      thumb = '<video src="' + escHtml(m.url) + '" muted preload="metadata"></video>';
    } else {
      thumb = '<span class="st-mico">' + svgWrap('<path d="M4 10.2v3.6M7.2 7.6v8.8M10.4 5.4v13.2M13.6 8.4v7.2M16.8 6.4v11.2M20 9.4v5.2"/>') + '</span>';
    }
    return '<div class="st-mcard' + (S.mediaSel === m.id ? ' sel' : '') + '" draggable="true" data-id="' + m.id +
      '" title="双击加入时间线">' +
      '<div class="st-mthumb">' + thumb + '<span class="st-mkind">' + kindTxt + '</span>' +
      '<button type="button" class="st-madd" data-add="' + m.id + '" title="加入时间线">＋</button></div>' +
      '<div class="st-mname">' + escHtml(m.name) + '</div>' +
      '<div class="st-mmeta">' + (m.kind === 'image' ? '图片 · 默认 5 秒' : fmtDur(m.dur)) +
      (m.source === 'library' ? ' · 视频库' : m.source === 'asset' ? ' · 图库' : '') + '</div></div>';
  }

  function renderMedia() {
    const grid = $('stMediaGrid');
    const empty = $('stMediaEmpty');
    if (!grid) return;
    const q = ($('stMediaSearch') && $('stMediaSearch').value || '').trim().toLowerCase();
    const kind = S.mediaKind || 'all';
    const list = S.project.media.filter(function (m) {
      return (kind === 'all' || m.kind === kind) && (!q || m.name.toLowerCase().indexOf(q) >= 0);
    });
    grid.innerHTML = list.map(mediaCard).join('');
    if (empty) {
      empty.classList.toggle('hidden', list.length > 0);
      const b = empty.querySelector('b');
      const s = empty.querySelector('span');
      const has = S.project.media.length > 0;
      if (b) b.textContent = has ? '没有匹配的素材' : '还没有素材';
      if (s) s.textContent = has ? '换个关键词或素材类型试试' : '导入本机视频 / 音频，或从「视频库」挑一条';
    }
    grid.querySelectorAll('video').forEach(function (v) {
      v.addEventListener('loadedmetadata', function () {
        try { v.currentTime = Math.min(0.8, Math.max(0.1, v.duration * 0.15)); } catch (e) {}
      }, { once: true });
    });
    const ag = $('stAudioGrid');
    if (ag) {
      const auds = S.project.media.filter(function (m) { return m.kind === 'audio'; });
      ag.innerHTML = auds.map(mediaCard).join('');
      if (!auds.length) ag.innerHTML = '<div class="st-empty"><b>还没有音频</b><span>导入音频后，会出现在这里和「媒体」面板</span></div>';
    }
  }

  function probeDuration(url, kind) {
    return new Promise(function (resolve) {
      if (kind === 'image' || !url) { resolve(0); return; }
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { el.removeAttribute('src'); el.load(); } catch (e) {}
        resolve(Math.max(0, Number(v) || 0));
      };
      const timer = setTimeout(function () { finish(0); }, 6000);
      el.preload = 'metadata';
      el.onloadedmetadata = function () { finish(isFinite(el.duration) ? el.duration : 0); };
      el.onerror = function () { finish(0); };
      el.src = url;
    });
  }

  function kindOfFile(file) {
    const t = String(file.type || '');
    if (/^video\//.test(t)) return 'video';
    if (/^audio\//.test(t)) return 'audio';
    if (/^image\//.test(t)) return 'image';
    const n = String(file.name || '').toLowerCase();
    if (/\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(n)) return 'video';
    if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(n)) return 'audio';
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(n)) return 'image';
    return '';
  }

  async function importFiles(files) {
    const arr = Array.prototype.slice.call(files || []);
    const usable = arr.map(function (f) { return { f: f, kind: kindOfFile(f) }; })
      .filter(function (x) { return !!x.kind; });
    if (!usable.length) { toast('没有可用的视频 / 音频 / 图片文件'); return []; }
    toast('正在导入 ' + usable.length + ' 个素材…');
    pushHistory('导入素材');
    const out = [];
    for (const item of usable) {
      const url = URL.createObjectURL(item.f);
      const dur = item.kind === 'image' ? 5 : (await probeDuration(url, item.kind)) || 5;
      const m = {
        id: uid('m'),
        name: item.f.name || ('素材' + (out.length + 1)),
        kind: item.kind,
        url: url,
        dur: round2(dur),
        source: 'file',
        libId: ''
      };
      S.project.media.push(m);
      out.push(m);
    }
    renderAll();
    scheduleSave();
    toast('已导入 ' + out.length + ' 个素材，双击可加入时间线（文件素材不会写进项目存档）');
    return out;
  }

  /* ---------------- 字幕：SRT / VTT ----------------
   * 解析与生成是纯函数，导入/导出只负责落到文字轨与下载。 */
  function parseSubs(text) {
    if (!text) return [];
    let src = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    src = src.replace(/^WEBVTT[^\n]*\n/i, '').replace(/^NOTE\b[\s\S]*?\n\n/gm, '');
    const out = [];
    const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})[^\n]*\n?([\s\S]*?)(?=\n\s*\n|$)/g;
    let m;
    while ((m = re.exec(src))) {
      const a = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + Number('0.' + m[4]);
      const b = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + Number('0.' + m[8]);
      const body = m[9]
        .split('\n')
        .filter(function (ln) { return !/^\s*$/.test(ln); })
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (!body || !(b > a)) continue;
      out.push({ start: round2(a), end: round2(b), text: body });
    }
    return out;
  }
  function srtTime(sec) {
    const ms = Math.max(0, Math.round(Number(sec) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    const two = function (n) { return String(n).padStart(2, '0'); };
    return two(h) + ':' + two(m) + ':' + two(s) + ',' + String(r).padStart(3, '0');
  }
  function buildSrt(clips) {
    const list = (clips || []).filter(function (c) {
      return c && c.kind === 'text' && String((c.text && c.text.content) || '').trim();
    }).slice().sort(function (a, b) { return a.start - b.start; });
    return list.map(function (c, i) {
      return (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.start + c.dur) + '\n' +
        String(c.text.content).trim() + '\n';
    }).join('\n');
  }
  function importSubs(text) {
    const cues = parseSubs(text);
    if (!cues.length) { toast('没有解析到字幕条目'); return 0; }
    pushHistory('导入字幕');
    let tr = tracksOfKind('text')[0];
    if (tr && trackLocked(tr.id)) { dropHistory(); toast('字幕轨道已锁定，先解锁'); return 0; }
    if (!tr) tr = insertTrack('text');
    const made = [];
    cues.forEach(function (q, i) {
      const c = makeClip({
        track: tr.id,
        kind: 'text',
        name: '字幕 ' + (i + 1),
        start: q.start,
        dur: Math.max(0.3, round2(q.end - q.start)),
        y: 32,
        text: {
          content: q.text,
          size: 54,
          color: '#ffffff',
          bg: 'rgba(0,0,0,0.35)',
          bold: true,
          align: 'center'
        }
      });
      S.project.clips.push(c);
      made.push(c);
    });
    S.sel = made[0].id;
    S.multi.clear();
    renderAll();
    applyTime();
    scheduleSave();
    toast('已导入 ' + made.length + ' 条字幕');
    return made.length;
  }
  function subsText() {
    return buildSrt(S.project.clips.filter(function (c) { return c.kind === 'text'; }));
  }
  function exportSubs() {
    const txt = subsText();
    if (!txt) { toast('时间线上没有文字片段'); return ''; }
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(S.project.name || '字幕').replace(/[\\/:*?"<>|]+/g, '_') + '.srt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    toast('已导出 SRT 字幕');
    return txt;
  }

  /* ---------------- 素材弹层：视频库 / 图库 ---------------- */
  async function openLibrary() {
    const modal = $('stLibModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    await setLibTab(S.libTab || 'media');
  }

  async function setLibTab(tab) {
    S.libTab = tab === 'asset' ? 'asset' : 'media';
    document.querySelectorAll('#stLibModal [data-libtab]').forEach(function (b) {
      const on = b.dataset.libtab === S.libTab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const s = $('stLibSearch');
    if (s) {
      s.value = '';
      s.placeholder = S.libTab === 'asset' ? '搜索图库…' : '搜索视频库…';
    }
    S.libPick = new Set();
    updateLibAdd();
    const list = $('stLibList');
    if (list) {
      list.innerHTML = '<div class="st-modal-empty">正在读取' + (S.libTab === 'asset' ? '图库' : '视频库') + '…</div>';
    }
    if (S.libTab === 'asset') await loadAssetTab();
    else await loadMediaTab();
  }

  async function loadMediaTab() {
    const list = $('stLibList');
    if (!list) return;
    const pa = window.playerApp;
    let files = [];
    if (!pa) {
      list.innerHTML = '<div class="st-modal-empty">当前页面没有加载视频库模块，请直接「导入文件」。</div>';
      return;
    }
    try {
      if (typeof pa.hasLib === 'function' && !pa.hasLib()) {
        list.innerHTML = '<div class="st-modal-empty">浏览器环境读不到视频库。<br>请用桌面版，或直接用「导入文件」。</div>';
        return;
      }
      if (typeof pa.refresh === 'function') await pa.refresh();
      if (typeof pa.files === 'function') files = pa.files() || [];
    } catch (e) { files = []; }
    S.libFiles = files.filter(function (f) {
      return f && (f.kind === 'video' || f.kind === 'audio' || f.kind === 'image');
    });
    renderLibList('');
  }

  /* 图库走 js/library.js 暴露的 window.assetBridge：
     App 不直接摸 window.openagiDesktop（AGENTS.md 2 节硬规则）。 */
  async function loadAssetTab() {
    const list = $('stLibList');
    if (!list) return;
    const bridge = window.assetBridge;
    if (!bridge || typeof bridge.available !== 'function' || !bridge.available()) {
      S.libAssets = [];
      list.innerHTML = '<div class="st-modal-empty">图库需要桌面版。<br>浏览器环境读不到资产库，请直接「导入文件」。</div>';
      updateLibAdd();
      return;
    }
    let assets = [];
    try { assets = await bridge.list('image'); } catch (e) { assets = []; }
    S.libAssets = (assets || []).filter(function (a) {
      return a && a.id && (a.kind || 'image') === 'image' && !a.missing;
    });
    renderLibList('');
  }

  function libUrl(f) {
    const pa = window.playerApp;
    if (pa && typeof pa._urlOf === 'function') return pa._urlOf(f);
    return '';
  }

  function renderLibList(q) {
    const list = $('stLibList');
    if (!list) return;
    const query = String(q || '').trim().toLowerCase();
    if (S.libTab === 'asset') { renderAssetList(list, query); return; }
    const files = S.libFiles.filter(function (f) {
      return !query || String(f.name || '').toLowerCase().indexOf(query) >= 0;
    });
    const cnt = $('stLibCount');
    if (cnt) cnt.textContent = '共 ' + files.length + ' 条';
    if (!files.length) {
      list.innerHTML = '<div class="st-modal-empty">视频库里还没有素材。<br>先到「视频库」导入文件，再回来挑。</div>';
      updateLibAdd();
      return;
    }
    list.innerHTML = files.map(function (f) {
      const added = S.project.media.some(function (m) { return m.libId === String(f.id); });
      const on = S.libPick.has(String(f.id));
      return '<div class="st-librow' + (on ? ' on' : '') + (added ? ' added' : '') + '" data-lib="' + escHtml(String(f.id)) + '">' +
        '<span class="st-libico">' + (f.kind === 'video' ? 'VID' : f.kind === 'audio' ? 'AUD' : 'IMG') + '</span>' +
        '<span class="st-libname">' + escHtml(f.name || '素材') + '</span>' +
        '<span class="st-libmeta">' + (added ? '已在素材库' : (f.kind === 'image' ? '图片' : fmtDur(f.dur || 0))) + '</span></div>';
    }).join('');
    updateLibAdd();
  }

  function renderAssetList(list, query) {
    const assets = S.libAssets.filter(function (a) {
      return !query || String(a.name || '').toLowerCase().indexOf(query) >= 0;
    });
    const cnt = $('stLibCount');
    if (cnt) cnt.textContent = '共 ' + assets.length + ' 张';
    if (!assets.length) {
      list.innerHTML = '<div class="st-modal-empty">图库里还没有图片。<br>先在生成流程里出图，或用图库的「导入」收图。</div>';
      updateLibAdd();
      return;
    }
    list.innerHTML = assets.map(function (a) {
      const id = String(a.id);
      const added = S.project.media.some(function (m) { return m.assetId === id; });
      const on = S.libPick.has(id);
      return '<div class="st-librow' + (on ? ' on' : '') + (added ? ' added' : '') + '" data-asset="' + escHtml(id) + '">' +
        '<span class="st-libico" data-thumb="' + escHtml(id) + '">IMG</span>' +
        '<span class="st-libname">' + escHtml(a.name || '图库素材') + '</span>' +
        '<span class="st-libmeta">' + (added ? '已在素材库' : fmtBytes(a.size)) + '</span></div>';
    }).join('');
    updateLibAdd();
    const bridge = window.assetBridge;
    if (!bridge || typeof bridge.thumb !== 'function') return;
    list.querySelectorAll('[data-thumb]').forEach(function (el) {
      const id = el.dataset.thumb;
      const paint = function (url) {
        if (!url) return;
        el.innerHTML = '<img class="st-libthumb" src="' + url + '" alt="">';
      };
      if (S.assetThumbs[id]) { paint(S.assetThumbs[id]); return; }
      bridge.thumb(id).then(function (url) {
        if (!url) return;
        S.assetThumbs[id] = url;
        paint(url);
      }).catch(function () {});
    });
  }

  function updateLibAdd() {
    const btn = $('stLibAdd');
    if (!btn) return;
    const n = S.libPick.size;
    btn.disabled = n === 0;
    btn.textContent = n ? '加入素材库（' + n + '）' : '加入素材库';
  }

  async function addFromLibrary() {
    if (!S.libPick.size) return;
    if (S.libTab === 'asset') { await addAssetsFromLibrary(); return; }
    const pa = window.playerApp;
    const picks = S.libFiles.filter(function (f) { return S.libPick.has(String(f.id)); });
    toast('正在加入 ' + picks.length + ' 个素材…');
    const newMedia = [];
    for (const f of picks) {
      const libId = String(f.id);
      if (S.project.media.some(function (m) { return m.libId === libId; })) continue;
      const url = libUrl(f);
      if (!url) continue;
      const kind = f.kind;
      const dur = kind === 'image' ? 5 : (await probeDuration(url, kind)) || 5;
      newMedia.push({
        id: 'lib:' + libId,
        name: String(f.name || '素材'),
        kind: kind,
        url: url,
        dur: round2(dur),
        source: 'library',
        libId: libId,
        assetId: ''
      });
    }
    if (newMedia.length) {
      S.project.media = S.project.media.concat(newMedia);
      renderAll();
      scheduleSave();
    }
    $('stLibModal').classList.add('hidden');
    toast(newMedia.length ? ('已加入 ' + newMedia.length + ' 个视频库素材') : '这些素材已经在素材库里了');
    void pa;
  }

  /* 图库素材：只把 assetId 写进项目，dataURL 在内存里用，启动时重新水合。 */
  async function addAssetsFromLibrary() {
    const bridge = window.assetBridge;
    const picks = S.libAssets.filter(function (a) { return S.libPick.has(String(a.id)); });
    if (!bridge || typeof bridge.read !== 'function' || !picks.length) return;
    toast('正在加入 ' + picks.length + ' 张图库素材…');
    const out = [];
    for (const a of picks) {
      const assetId = String(a.id);
      if (S.project.media.some(function (m) { return m.assetId === assetId; })) continue;
      let url = '';
      try { url = await bridge.read(assetId); } catch (e) { url = ''; }
      if (!url) continue;
      out.push({
        id: 'ast:' + assetId,
        name: String(a.name || '图库素材'),
        kind: 'image',
        url: url,
        dur: 5,
        source: 'asset',
        libId: '',
        assetId: assetId
      });
    }
    if (out.length) {
      S.project.media = S.project.media.concat(out);
      renderAll();
      scheduleSave();
    }
    $('stLibModal').classList.add('hidden');
    toast(out.length ? ('已加入 ' + out.length + ' 张图库素材') : '这些图已经在素材库里了');
  }

  /* ---------------- 检查器 ---------------- */
  function rng(label, prop, val, min, max, step, display) {
    return '<label class="st-field"><span>' + label + '</span>' +
      '<input type="range" data-prop="' + prop + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
      '<i class="st-fval" data-fval="' + prop + '">' + display + '</i></label>';
  }
  function num(label, prop, val, min, max, step, unit) {
    return '<label class="st-field"><span>' + label + '</span>' +
      '<input type="number" data-prop="' + prop + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
      '<i class="st-fval">' + (unit || '') + '</i></label>';
  }

  function trackPanel() {
    return '<div class="st-insp-sec"><h4>轨道<em>' + tracks().length + ' 条</em></h4>' +
      tracks().map(function (t) {
        return '<div class="st-tkrow" data-tk="' + t.id + '"><b>' + escHtml(t.name) + '</b>' +
          ['locked', 'muted', 'solo', 'hidden'].map(function (k) {
            const icon = k === 'locked' ? 'lock' :
              k === 'muted' ? (t.muted ? 'mute' : 'sound') :
                k === 'solo' ? 'solo' : (t.hidden ? 'eyeOff' : 'eye');
            const label = { locked: '锁定轨道', muted: '静音轨道', solo: '独奏轨道', hidden: '隐藏轨道' }[k];
            return '<button type="button" class="st-tkb' + (t[k] ? ' on' : '') + '" data-tkf="' + k +
              '" data-tk="' + t.id + '" title="' + label + '" aria-label="' + label + '">' + ico(icon) + '</button>';
          }).join('') +
          '<button type="button" class="st-tkb del" data-tkdel="' + t.id + '" title="删除空轨道" aria-label="删除空轨道">' + ico('trash') + '</button></div>';
      }).join('') +
      '<div class="st-tkadd"><button type="button" class="st-ghost st-tkbtn" data-addtk="video" title="新增视频轨" aria-label="新增视频轨">' + ico('film') + '</button>' +
      '<button type="button" class="st-ghost st-tkbtn" data-addtk="text" title="新增文字轨" aria-label="新增文字轨">' + ico('text') + '</button>' +
      '<button type="button" class="st-ghost st-tkbtn" data-addtk="audio" title="新增音频轨" aria-label="新增音频轨">' + ico('audio') + '</button></div></div>';
  }

  function snapshotPanel() {
    if (!S.snapshots.length) {
      return '<div class="st-insp-sec"><h4>快照<em>0</em></h4>' +
        '<div class="st-insp-empty">编辑过程中每 5 分钟自动留一份快照，用于崩溃恢复。</div></div>';
    }
    const list = S.snapshots.map(function (s, i) { return { s: s, i: i }; }).slice(-3).reverse();
    return '<div class="st-insp-sec"><h4>快照<em>' + S.snapshots.length + '</em></h4>' +
      list.map(function (x) {
        const d = new Date(x.s.at);
        const hm = String(d.getMinutes()).padStart(2, '0');
        const label = d.getMonth() + 1 + '/' + d.getDate() + ' ' + d.getHours() + ':' + hm;
        return '<button type="button" class="st-ghost st-wide" data-snap="' + x.i + '">恢复 ' + label +
          ' · ' + fmtMmss(projectDuration(normalizeProject(x.s.project))) + '</button>';
      }).join('') + '</div>';
  }

  function projectPanel() {
    const resId = S.project.w + 'x' + S.project.h;
    const opts = RES_PRESETS.map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === resId ? ' selected' : '') + '>' + r.name + '</option>';
    }).join('') + (RES_PRESETS.some(function (r) { return r.id === resId; }) ? '' :
      '<option value="' + resId + '" selected>' + S.project.w + ' × ' + S.project.h + '</option>');
    const fps = [24, 25, 30, 50, 60].map(function (f) {
      return '<option value="' + f + '"' + (f === S.project.fps ? ' selected' : '') + '>' + f + ' fps</option>';
    }).join('');
    return '<div class="st-insp-sec"><h4>项目<em>' + fmtMmss(projectDuration(S.project)) + '</em></h4>' +
      '<label class="st-field wide"><span>名称</span><input type="text" data-proj="name" value="' + escHtml(S.project.name) + '"></label>' +
      '<label class="st-field wide"><span>画布</span><select data-proj="res">' + opts + '</select></label>' +
      '<label class="st-field wide"><span>帧率</span><select data-proj="fps">' + fps + '</select></label>' +
      '<div class="st-insp-empty">素材 ' + S.project.media.length + ' 个 · 片段 ' + S.project.clips.length +
      ' 条 · 标记 ' + S.project.markers.length + ' 个</div></div>' +
      trackPanel() + snapshotPanel() + histPanel() +
      '<div class="st-insp-sec"><h4>操作提示</h4><div class="st-insp-empty"><ul>' +
      '<li>拖素材到轨道，或双击素材自动追加；右键素材可插入 / 覆盖到播放头</li>' +
      '<li>Alt+拖边缘＝波纹裁剪，Ctrl+拖边缘＝滚动剪辑</li>' +
      '<li>Alt+拖片段＝滑移，Ctrl+拖片段＝滑动</li>' +
      '<li>空白处拖拽＝框选，Shift/Ctrl+点选多选</li>' +
      '<li>J/K/L 倒放 / 停 / 播放加速，I / O 设入出点，X 清除区间</li>' +
      '<li>空格播放，S 分割，Ctrl+K 切开全部轨道，M 打标记</li>' +
      '<li>Ctrl+C / Ctrl+V 以播放头粘贴，Shift+Delete 波纹删除</li>' +
      '</ul></div></div>';
  }

  function histPanel() {
    return '<div class="st-insp-sec"><h4>历史<em>点条目回退</em></h4>' +
      '<div class="st-histlist" id="stHistList"></div></div>';
  }

  function kfPanel(c) {
    const labels = { opacity: '透明', scale: '缩放', x: '水平', y: '垂直', rot: '旋转', volume: '音量' };
    const props = KF_PROPS.filter(function (p) { return c.kind !== 'text' || p !== 'volume'; });
    const sum = props.filter(function (p) { return c.kf && c.kf[p] && c.kf[p].length; })
      .map(function (p) { return labels[p] + ' ' + c.kf[p].length; }).join(' · ');
    return '<div class="st-insp-sec" data-g="kf"><h4>关键帧</h4>' +
      '<div class="st-kfrow">' + props.map(function (p) {
        const icon = { opacity: 'kfOpacity', scale: 'kfScale', x: 'kfX', y: 'kfY', rot: 'kfRot', volume: 'kfVolume' }[p];
        return '<button type="button" class="st-kfbtn" data-kf="' + p +
          '" title="在播放头为「' + labels[p] + '」打关键帧" aria-label="为' + labels[p] + '打关键帧">' + ico(icon) + '</button>';
      }).join('') + '</div>' +
      '<div class="st-kfsum">' + (sum || '暂无关键帧，打点后可做补间动画') +
      (sum ? ' <button type="button" class="st-kfclear" data-act="kfclear" title="清除关键帧" aria-label="清除关键帧">' + ico('eraser') + '</button>' : '') + '</div></div>';
  }

  function renderInspector() {
    const box = $('stInspector');
    if (!box) return;
    const c = selected();
    if (!c) { box.innerHTML = projectPanel(); paintStatus(); paintUndo(); return; }
    const isText = c.kind === 'text';
    const isVisual = c.kind === 'video' || c.kind === 'image';
    const m = c.mediaId ? mediaOf(c.mediaId) : null;
    const multiN = S.multi.size;
    const tabs = [['basic', '基础'], ['visual', '画面']];
    if (!isText) tabs.push(['audio', '声音']);
    tabs.push(['motion', '动画'], ['kf', '关键帧']);
    const active = tabs.some(function (t) { return t[0] === S.inspTab; }) ? S.inspTab : 'basic';
    S.inspTab = active;
    box.dataset.itab = active;
    let html = '<div class="st-insp-tabs" role="tablist">' + tabs.map(function (t) {
      return '<button type="button" class="st-insp-tab' + (t[0] === active ? ' on' : '') +
        '" data-itab="' + t[0] + '" role="tab" aria-selected="' + (t[0] === active ? 'true' : 'false') + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    html += '<div class="st-insp-sec" data-g="basic"><h4>片段<em>' + kindLabel(c.kind) + (m ? ' · ' + escHtml(m.name) : '') +
      (multiN > 1 ? ' · 已选 ' + multiN + ' 个' : '') + '</em></h4>' +
      '<label class="st-field wide"><span>名称</span><input type="text" data-prop="name" value="' + escHtml(c.name) + '"></label>' +
      num('起点', 'start', c.start.toFixed(2), 0, 3600, 0.1, 's') +
      num('时长', 'dur', c.dur.toFixed(2), MIN_CLIP, 3600, 0.1, 's');
    if (!isText) html += num('入点', 'in', c.in.toFixed(2), 0, 3600, 0.1, 's');
    html += '</div>';

    if (isText) {
      html += '<div class="st-insp-sec" data-g="basic"><h4>文字</h4>' +
        '<textarea data-prop="textContent" placeholder="输入文字…">' + escHtml(c.text.content) + '</textarea>' +
        '<label class="st-field"><span>字号</span><input type="range" data-prop="textSize" min="10" max="220" step="1" value="' + c.text.size + '"><i class="st-fval" data-fval="textSize">' + c.text.size + 'px</i></label>' +
        '<div class="st-colorfield"><input type="color" data-prop="textColor" value="' + (/^#[0-9a-f]{6}$/i.test(c.text.color) ? c.text.color : '#ffffff') + '"><input type="text" data-prop="textColor" value="' + escHtml(c.text.color) + '"></div>' +
        '<label class="st-field wide"><span>底色</span><select data-prop="textBg">' +
        ['rgba(0,0,0,0)', 'rgba(0,0,0,.45)', 'rgba(0,0,0,.62)', 'rgba(255,255,255,.82)'].map(function (bg) {
          return '<option value="' + bg + '"' + (bg === c.text.bg ? ' selected' : '') + '>' +
            (bg === 'rgba(0,0,0,0)' ? '透明' : bg === 'rgba(255,255,255,.82)' ? '浅色底' : '深色底') + '</option>';
        }).join('') + '</select></label>' +
        '<label class="st-field wide"><span>对齐</span><select data-prop="textAlign">' +
        [['center', '居中'], ['left', '左对齐'], ['right', '右对齐']].map(function (a) {
          return '<option value="' + a[0] + '"' + (a[0] === c.text.align ? ' selected' : '') + '>' + a[1] + '</option>';
        }).join('') + '</select></label>' +
        '<label class="st-checkrow"><input type="checkbox" data-prop="textBold"' + (c.text.bold ? ' checked' : '') + '> 加粗</label>' +
        '<button type="button" class="st-ghost st-wide st-voice-btn" data-act="voice">' + ico('mic') + ' 生成配音</button>' +
        '</div>';
    }

    if (isVisual || isText) {
      html += '<div class="st-insp-sec" data-g="visual"><h4>画面</h4>' +
        rng('缩放', 'scalePct', Math.round(c.scale * 100), 20, 300, 1, Math.round(c.scale * 100) + '%') +
        rng('水平', 'x', Math.round(c.x), -50, 50, 1, Math.round(c.x) + '%') +
        rng('垂直', 'y', Math.round(c.y), -50, 50, 1, Math.round(c.y) + '%') +
        rng('旋转', 'rot', Math.round(c.rot), -180, 180, 1, Math.round(c.rot) + '°') +
        rng('透明', 'opacityPct', Math.round(c.opacity * 100), 0, 100, 1, Math.round(c.opacity * 100) + '%');
      if (isVisual) {
        html += fxStackPanel(c);
      }
      html += '</div>';
    }

    if (!isText) {
      html += '<div class="st-insp-sec" data-g="audio"><h4>声音与速度</h4>' +
        rng('音量', 'volumePct', Math.round(c.volume * 100), 0, 100, 1, Math.round(c.volume * 100) + '%') +
        '<label class="st-checkrow"><input type="checkbox" data-prop="muted"' + (c.muted ? ' checked' : '') + '> 静音本片段</label>' +
        rng('速度', 'speed', c.speed, 0.25, 4, 0.05, c.speed.toFixed(2) + 'x') +
        '</div>';
    }

    html += '<div class="st-insp-sec" data-g="motion"><h4>动画</h4>' +
      rng('淡入', 'fadeIn', c.fadeIn, 0, 5, 0.1, c.fadeIn.toFixed(1) + 's') +
      rng('淡出', 'fadeOut', c.fadeOut, 0, 5, 0.1, c.fadeOut.toFixed(1) + 's') +
      '</div>';

    html += kfPanel(c);

    html += '<div class="st-insp-act"><button type="button" class="st-ghost st-icobtn" data-act="dup" title="复制片段" aria-label="复制片段">' + ico('copy') + '</button>' +
      '<button type="button" class="st-ghost st-icobtn" data-act="del" title="删除片段" aria-label="删除片段">' + ico('trash') + '</button>' +
      '<button type="button" class="st-ghost st-icobtn" data-act="rdel" title="波纹删除" aria-label="波纹删除">' + ico('rippleDel') + '</button></div>';
    box.innerHTML = html;
    paintFxSel();
    paintStatus();
  }

  /* 效果栈面板：顺序即渲染顺序，开关只影响该条。 */
  function fxStackPanel(c) {
    const list = c.effects || [];
    const rows = list.map(function (e) {
      let params = '';
      if (e.type === 'adjust') {
        params = ADJUST_DEFS.map(function (d) {
          const v = Number(e.params[d.key]);
          return '<label class="st-field"><span>' + d.name + '</span>' +
            '<input type="range" data-fxparam="' + e.id + ':' + d.key + '" min="' + d.min + '" max="' + d.max +
            '" step="' + d.step + '" value="' + v + '"><i class="st-fval">' + v.toFixed(2) + '</i></label>';
        }).join('');
      } else if (e.type === 'blur') {
        params = '<label class="st-field"><span>半径</span>' +
          '<input type="range" data-fxparam="' + e.id + ':px" min="0" max="40" step="1" value="' + e.params.px +
          '"><i class="st-fval">' + e.params.px + 'px</i></label>';
      }
      return '<div class="st-fxrow' + (e.enabled === false ? ' off' : '') + '" data-fxrow="' + e.id + '">' +
        '<label class="st-fxtoggle"><input type="checkbox" data-fxtoggle="' + e.id + '"' +
        (e.enabled !== false ? ' checked' : '') + '></label>' +
        '<b>' + escHtml(effectName(e)) + '</b>' +
        '<span class="st-fxrow-act">' +
        '<button type="button" data-fxmove="-1" data-fxid="' + e.id + '" title="上移">↑</button>' +
        '<button type="button" data-fxmove="1" data-fxid="' + e.id + '" title="下移">↓</button>' +
        '<button type="button" data-fxdel="' + e.id + '" title="移除">×</button></span>' +
        (params ? '<div class="st-fxparams">' + params + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="st-insp-sec" data-g="visual"><h4>效果栈<em>' + list.length + ' / ' + EFFECT_MAX + '</em></h4>' +
      (rows || '<div class="st-hint">还没有效果。可在「滤镜」面板添加，或点下面按钮。</div>') +
      '<div class="st-fxadd"><button type="button" class="st-ghost" data-fxadd="adjust">+ 调色</button>' +
      '<button type="button" class="st-ghost" data-fxadd="blur">+ 模糊</button></div></div>';
  }

  function addEffect(id, type) {
    const c = clipOf(id);
    if (!c) return null;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return null; }
    if ((c.effects || []).length >= EFFECT_MAX) { toast('效果最多 ' + EFFECT_MAX + ' 个'); return null; }
    pushHistory(type === 'blur' ? '添加模糊' : '添加调色');
    const e = type === 'blur'
      ? { id: uid('fx'), type: 'blur', enabled: true, params: { px: 4 } }
      : { id: uid('fx'), type: 'adjust', enabled: true, params: { brightness: 1, contrast: 1, saturate: 1 } };
    c.effects = (c.effects || []).concat([e]);
    renderInspector();
    applyTime();
    scheduleSave();
    return e;
  }
  function setEffectEnabled(id, fxId, on) {
    const c = clipOf(id);
    if (!c || trackLocked(c.track)) return false;
    const e = (c.effects || []).filter(function (x) { return x.id === fxId; })[0];
    if (!e) return false;
    e.enabled = !!on;
    renderInspector();
    applyTime();
    scheduleSave();
    return true;
  }
  function moveEffect(id, fxId, dir) {
    const c = clipOf(id);
    if (!c || trackLocked(c.track)) return false;
    const list = c.effects || [];
    const i = list.findIndex(function (x) { return x.id === fxId; });
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    renderInspector();
    applyTime();
    scheduleSave();
    return true;
  }
  function removeEffect(id, fxId) {
    const c = clipOf(id);
    if (!c || trackLocked(c.track)) return false;
    const before = (c.effects || []).length;
    c.effects = (c.effects || []).filter(function (x) { return x.id !== fxId; });
    if (c.effects.length === before) return false;
    renderInspector();
    applyTime();
    scheduleSave();
    return true;
  }
  function setFxParam(pair, value) {
    const parts = String(pair || '').split(':');
    const c = selected();
    if (!c || !parts[0]) return false;
    const e = (c.effects || []).filter(function (x) { return x.id === parts[0]; })[0];
    if (!e || !e.params) return false;
    if (e.type === 'adjust') {
      const d = ADJUST_DEFS.filter(function (x) { return x.key === parts[1]; })[0];
      if (!d) return false;
      e.params[d.key] = clamp(Number(value) || 0, d.min, d.max);
    } else if (e.type === 'blur') {
      e.params.px = clamp(Number(value) || 0, 0, 40);
    }
    const out = document.querySelector('[data-fxparam="' + pair + '"]');
    if (out && out.parentNode) {
      const fv = out.parentNode.querySelector('.st-fval');
      if (fv) fv.textContent = e.type === 'blur' ? e.params.px + 'px' : Number(e.params[parts[1]]).toFixed(2);
    }
    applyTime();
    scheduleSave();
    return true;
  }

  function paintFxSel() {
    const c = selected();
    const used = c ? (c.effects || []).filter(function (e) {
      return e.type === 'preset' && e.enabled !== false;
    }).map(function (e) { return e.preset; }) : [];
    document.querySelectorAll('#stFxGrid .st-fxcard').forEach(function (n) {
      n.classList.toggle('on', used.indexOf(n.dataset.fx) >= 0);
    });
  }

  function setFVal(prop, target, c) {
    const out = document.querySelector('[data-fval="' + prop + '"]');
    if (!out) return;
    if (prop === 'scalePct') out.textContent = Math.round(c.scale * 100) + '%';
    else if (prop === 'opacityPct') out.textContent = Math.round(c.opacity * 100) + '%';
    else if (prop === 'volumePct') out.textContent = Math.round(c.volume * 100) + '%';
    else if (prop === 'rot') out.textContent = Math.round(c.rot) + '°';
    else if (prop === 'x' || prop === 'y') out.textContent = Math.round(prop === 'x' ? c.x : c.y) + '%';
    else if (prop === 'speed') out.textContent = c.speed.toFixed(2) + 'x';
    else if (prop === 'fadeIn') out.textContent = c.fadeIn.toFixed(1) + 's';
    else if (prop === 'fadeOut') out.textContent = c.fadeOut.toFixed(1) + 's';
    else if (prop === 'textSize') out.textContent = c.text.size + 'px';
    void target;
  }

  function onInspectorInput(e) {
    const target = e.target;
    if (!target || !target.dataset) return;
    if (target.dataset.proj) { onProjectInput(target); return; }
    if (target.dataset.fxparam) { setFxParam(target.dataset.fxparam, target.value); return; }
    const prop = target.dataset.prop;
    if (!prop) return;
    const c = selected();
    if (!c) return;
    const v = target.type === 'checkbox' ? !!target.checked : target.value;
    switch (prop) {
      case 'name': c.name = String(v).trim() || '片段'; break;
      case 'start': c.start = Math.max(0, Number(v) || 0); break;
      case 'dur': c.dur = clamp(Number(v) || MIN_CLIP, MIN_CLIP, maxDurFor(c, c.in)); break;
      case 'in': c.in = clamp(Number(v) || 0, 0, Math.max(0, (mediaOf(c.mediaId) || {}).dur || 0)); break;
      case 'scalePct': c.scale = clamp(Number(v), 20, 300) / 100; break;
      case 'x': c.x = clamp(Number(v) || 0, -50, 50); break;
      case 'y': c.y = clamp(Number(v) || 0, -50, 50); break;
      case 'rot': c.rot = clamp(Number(v) || 0, -180, 180); break;
      case 'opacityPct': c.opacity = clamp(Number(v), 0, 100) / 100; break;
      case 'volumePct': c.volume = clamp(Number(v), 0, 100) / 100; break;
      case 'muted': c.muted = !!v; break;
      case 'speed': c.speed = clamp(Number(v) || 1, 0.25, 4); break;
      case 'fadeIn': c.fadeIn = clamp(Number(v) || 0, 0, 5); break;
      case 'fadeOut': c.fadeOut = clamp(Number(v) || 0, 0, 5); break;
      case 'textContent': c.text.content = String(v); break;
      case 'textSize': c.text.size = clamp(Number(v) || 64, 10, 220); break;
      case 'textColor': c.text.color = String(v); break;
      case 'textBg': c.text.bg = String(v); break;
      case 'textBold': c.text.bold = !!v; break;
      case 'textAlign': c.text.align = String(v); break;
    }
    setFVal(prop, target, c);
    if (prop === 'name' || prop === 'start' || prop === 'dur' || prop === 'in' || prop === 'speed') {
      renderRows();
      liveClipEl(c);
    }
    applyTime();
    scheduleSave();
  }

  function onInspectorChange(e) {
    const target = e.target;
    if (!target || !target.dataset) return;
    if (target.dataset.fxtoggle) {
      setEffectEnabled(S.sel, target.dataset.fxtoggle, target.checked);
      return;
    }
    if (S.inspSnap && snap() !== S.inspSnap) {
      S.hist.push({ label: '调整参数', snap: S.inspSnap });
      if (S.hist.length > MAX_HIST) S.hist.shift();
      S.future.length = 0;
      paintUndo();
    }
    S.inspSnap = '';
    if (target.dataset.prop === 'name') renderInspector();
    scheduleSave();
  }

  function onProjectInput(el) {
    const key = el.dataset.proj;
    if (key === 'name') {
      S.project.name = String(el.value).trim() || '未命名项目';
      $('stProjName').textContent = S.project.name;
    } else if (key === 'res') {
      const parts = String(el.value).split('x');
      S.project.w = Math.max(320, Number(parts[0]) || 1920);
      S.project.h = Math.max(180, Number(parts[1]) || 1080);
      fitFrame();
      S.textSig = '';
      applyTime();
    } else if (key === 'fps') {
      S.project.fps = Number(el.value) || 30;
      paintTc();
    }
    scheduleSave();
  }

  /* ---------------- 统一渲染 ---------------- */
  function trackSig() {
    return tracks().map(function (t) { return t.id + ':' + t.kind + ':' + t.height; }).join('|');
  }

  function ensureTrackDom() {
    const sig = trackSig();
    if (sig === S.trackSig) return;
    S.trackSig = sig;
    buildPools();
    buildTrackHeads();
  }

  function renderAll() {
    ensureTrackDom();
    const pn = $('stProjName');
    if (pn) pn.textContent = S.project.name || '未命名项目';
    setTool(S.tool);
    const zv = $('stZoomVal');
    if (zv) zv.textContent = String(Math.round(S.pps));
    const lb = $('stLoop');
    if (lb) lb.classList.toggle('on', S.loop);
    renderMedia();
    renderTimeline();
    renderInspector();
    paintUndo();
    paintTc();
    paintStatus();
    updateEmpty();
  }

  /* ---------------- 交互绑定 ---------------- */
  function setZoom(v) {
    const sc = $('stScroll');
    const center = sc ? (sc.scrollLeft + sc.clientWidth / 2) / S.pps : 0;
    S.pps = clamp(Number(v) || 80, 32, 240);
    const z = $('stZoom');
    if (z) z.value = S.pps;
    const zv = $('stZoomVal');
    if (zv) zv.textContent = String(Math.round(S.pps));
    renderTimeline();
    if (sc) sc.scrollLeft = Math.max(0, center * S.pps - sc.clientWidth / 2);
    applyTime();
    paintStatus();
  }

  /* 适配时间线：把整条片子的时长铺满时间线可视宽度。 */
  function fitTimeline() {
    const sc = $('stScroll');
    const dur = Math.max(1, projectDuration(S.project));
    const w = Math.max(240, (sc ? sc.clientWidth : 800) - 32);
    setZoom(w / (dur + 0.6));
    if (sc) sc.scrollLeft = 0;
  }

  function setTool(name) {
    S.tool = name === 'blade' ? 'blade' : 'select';
    const a = $('stToolSelect');
    const b = $('stToolBlade');
    if (a) a.classList.toggle('on', S.tool === 'select');
    if (b) b.classList.toggle('on', S.tool === 'blade');
    const rows = $('stRows');
    if (rows) rows.classList.toggle('blade', S.tool === 'blade');
    paintStatus();
  }

  function selectAllClips() {
    if (!S.project.clips.length) { toast('时间线上还没有片段'); return 0; }
    S.multi = new Set(S.project.clips.map(function (c) { return c.id; }));
    S.sel = '';
    paintSel();
    renderInspector();
    toast('已全选 ' + S.multi.size + ' 个片段');
    return S.multi.size;
  }

  function stepFrame(dir) {
    seek(S.time + (Number(dir) || 1) / S.project.fps);
  }

  function setLoop(on) {
    S.loop = !!on;
    const b = $('stLoop');
    if (b) {
      b.classList.toggle('on', S.loop);
      b.setAttribute('aria-pressed', S.loop ? 'true' : 'false');
    }
    toast(S.loop ? '循环播放已开启' : '循环播放已关闭');
  }

  function setMediaKind(kind) {
    S.mediaKind = ['all', 'video', 'image', 'audio'].indexOf(kind) >= 0 ? kind : 'all';
    document.querySelectorAll('#stMediaFilter .st-fchip').forEach(function (b) {
      const on = b.dataset.fk === S.mediaKind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderMedia();
  }

  function setInspTab(name) {
    S.inspTab = name || 'basic';
    const box = $('stInspector');
    if (!box) return;
    box.dataset.itab = S.inspTab;
    box.querySelectorAll('[data-itab]').forEach(function (b) {
      const on = b.dataset.itab === S.inspTab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  /* 底部状态栏：片段 / 选中 / 轨道 / 工具 / 缩放 / 总时长 */
  function paintStatus() {
    const n = S.project.clips.length;
    const sc = $('stStClips');
    if (!sc) return;
    sc.textContent = n + ' 片段';
    const selN = S.multi.size || (S.sel ? 1 : 0);
    const sel = $('stStSel');
    if (sel) sel.textContent = selN ? '已选 ' + selN + ' 个' : '未选中';
    const tr = $('stStTracks');
    if (tr) tr.textContent = tracks().length + ' 轨道';
    const tool = $('stStTool');
    if (tool) tool.textContent = S.tool === 'blade' ? '剃刀工具' : '选择工具';
    const z = $('stStZoom');
    if (z) z.textContent = Math.round(S.pps) + ' px/s';
    const d = $('stStDur2');
    if (d) d.textContent = fmtMmss(projectDuration(S.project));
  }

  function setTab(name) {
    S.panel = name;
    document.querySelectorAll('#stTabs .st-tab').forEach(function (b) {
      const on = b.dataset.panel === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.st-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.dataset.panel !== name);
    });
  }

  function bindMediaGrid(grid) {
    if (!grid) return;
    grid.addEventListener('click', function (e) {
      const add = e.target.closest('[data-add]');
      if (add) {
        e.stopPropagation();
        addMediaClip(add.dataset.add, null, null);
        return;
      }
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      S.mediaSel = card.dataset.id;
      grid.querySelectorAll('.st-mcard').forEach(function (n) {
        n.classList.toggle('sel', n === card);
      });
    });
    grid.addEventListener('dblclick', function (e) {
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      const m = mediaOf(card.dataset.id);
      if (!m) return;
      addMediaClip(m.id, null, null);
    });
    grid.addEventListener('contextmenu', function (e) {
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      e.preventDefault();
      openMediaMenu(mediaOf(card.dataset.id), e.clientX, e.clientY);
    });
    grid.addEventListener('dragstart', function (e) {
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      S.dragMediaId = card.dataset.id;
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', 'stm:' + card.dataset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }
    });
    grid.addEventListener('dragend', function () {
      S.dragMediaId = '';
      clearDrop();
    });
  }

  function onKey(e) {
    if (!isShown()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Escape') {
      if ($('stCtx')) { closeClipMenu(); return; }
      if ($('stMenuPop')) { closeMenuPop(); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); return; }
    if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAllClips(); return; }
    if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySelected(); return; }
    if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteAt(S.time); return; }
    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); splitAllAt(S.time); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveNow(); toast('项目已保存到本机'); return; }
    if (mod) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); shuttle(-1); return; }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); pause(); return; }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); shuttle(1); return; }
    if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      if (e.altKey) { S.rngIn = null; paintRange(); paintStatus(); }
      else setRangeEdge('in', S.time);
      return;
    }
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      if (e.altKey) { S.rngOut = null; paintRange(); paintStatus(); }
      else setRangeEdge('out', S.time);
      return;
    }
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); clearInOut(); return; }
    if (e.key === 'v' || e.key === 'V') { e.preventDefault(); setTool('select'); return; }
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setTool('blade'); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitTimeline(); return; }
    if (e.key === ',') { e.preventDefault(); stepFrame(-1); return; }
    if (e.key === '.') { e.preventDefault(); stepFrame(1); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected(!!e.shiftKey);
      return;
    }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitAt(); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); addMarker(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(e.shiftKey ? -1 : -1 / S.project.fps); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(e.shiftKey ? 1 : 1 / S.project.fps); return; }
    if (e.key === 'Home') { e.preventDefault(); seek(0); return; }
    if (e.key === 'End') { e.preventDefault(); seek(projectDuration(S.project)); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(S.pps * 1.2); return; }
    if (e.key === '-') { e.preventDefault(); setZoom(S.pps / 1.2); return; }
    if (e.key === 'Escape') {
      const open = document.querySelector('.st-modal:not(.hidden)');
      if (open) { open.classList.add('hidden'); return; }
      selectClip('');
    }
  }

  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.add('hidden');
  }

  /* ---------------- 菜单栏 / 快捷键面板 ---------------- */
  const SHORTCUTS = [
    ['空格 / K', '播放 / 停止'],
    ['J / L', '倒放 / 播放（连按 L 加速 2×、4×）'],
    ['V / B', '选择工具 / 剃刀工具'],
    ['S / Ctrl+K', '分割选中片段 / 切开所有轨道'],
    ['I / O / X', '设入点 / 设出点 / 清除区间'],
    ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'],
    ['Ctrl+C / Ctrl+V', '复制片段 / 粘贴到播放头'],
    ['Ctrl+D', '复制片段（紧随其后）'],
    ['Delete / Shift+Delete', '删除 / 波纹删除'],
    ['Ctrl+A', '全选片段'],
    ['M', '在播放头打标记'],
    ['← / →', '逐帧后退 / 前进'],
    ['Shift+← / Shift+→', '后退 / 前进 1 秒'],
    [', / .', '上一帧 / 下一帧'],
    ['Home / End', '回到开头 / 结尾'],
    ['+ / −', '放大 / 缩小时间线'],
    ['F', '适配时间线'],
    ['Alt+边缘 / Ctrl+边缘', '波纹裁剪 / 滚动剪辑'],
    ['Alt+片段 / Ctrl+片段', '滑移 / 滑动'],
    ['Shift+点击 / Ctrl+点击', '多选片段'],
    ['空白处拖拽', '框选片段'],
    ['Esc', '关闭菜单 / 取消选中']
  ];

  function closeMenuPop() {
    const el = $('stMenuPop');
    if (el) el.remove();
    document.querySelectorAll('#stMenuBar .st-menu-btn').forEach(function (b) {
      b.classList.remove('on');
    });
  }

  function menuDefs() {
    return [
      { id: 'file', items: [
        { label: '新建项目', run: function () { $('stNew').click(); } },
        { label: '导入项目…', run: function () { $('stProjImport').click(); } },
        { label: '导出项目', run: function () { $('stProjExport').click(); } },
        { sep: true },
        { label: '导入素材…', run: function () { $('stImport').click(); } },
        { label: '导出视频…', run: function () { $('stExport').click(); } },
        { label: '导出当前帧（PNG）', run: exportStill }
      ] },
      { id: 'edit', items: [
        { label: '撤销', hint: 'Ctrl+Z', disabled: !S.hist.length, run: undo },
        { label: '重做', hint: 'Ctrl+Shift+Z', disabled: !S.future.length, run: redo },
        { sep: true },
        { label: '在播放头处分割', hint: 'S', run: function () { splitAt(); } },
        { label: '切开所有轨道', hint: 'Ctrl+K', run: function () { splitAllAt(S.time); } },
        { label: '复制片段', hint: 'Ctrl+D', run: duplicateSelected },
        { label: '复制到剪贴板', hint: 'Ctrl+C', run: copySelected },
        { label: '粘贴到播放头', hint: 'Ctrl+V', run: function () { pasteAt(S.time); } },
        { label: '删除', hint: 'Del', run: function () { deleteSelected(false); } },
        { label: '波纹删除', hint: 'Shift+Del', run: function () { deleteSelected(true); } },
        { sep: true },
        { label: '全选片段', hint: 'Ctrl+A', run: selectAllClips }
      ] },
      { id: 'view', items: [
        { label: '适配时间线', hint: 'F', run: fitTimeline },
        { label: '放大时间线', hint: '+', run: function () { setZoom(S.pps * 1.25); } },
        { label: '缩小时间线', hint: '−', run: function () { setZoom(S.pps / 1.25); } },
        { sep: true },
        { label: '磁吸对齐', hint: '开 / 关', checked: S.snap, run: function () { $('stSnap').click(); } },
        { label: '循环播放', checked: S.loop, run: function () { setLoop(!S.loop); } },
        { sep: true },
        { label: '设入点', hint: 'I', checked: S.rngIn != null, run: function () { setRangeEdge('in', S.time); } },
        { label: '设出点', hint: 'O', checked: S.rngOut != null, run: function () { setRangeEdge('out', S.time); } },
        { label: '清除入出点', hint: 'X', run: clearInOut },
        { label: '循环播放选区', hint: '开 / 关', checked: S.loop && S.rngIn != null && S.rngOut != null,
          run: function () { if (S.rngIn == null || S.rngOut == null) { toast('先按 I / O 设入出点'); return; } setLoop(true); seek(S.rngIn); } }
      ] },
      { id: 'help', items: [
        { label: '快捷键一览', run: openHelp },
        { label: '关于剪辑台', run: function () { toast('剪辑台 · 本地时间线剪辑器'); } }
      ] }
    ];
  }

  function openMenuBar(btn) {
    const id = btn.dataset.menu;
    const def = menuDefs().filter(function (m) { return m.id === id; })[0];
    if (!def) return;
    const already = $('stMenuPop');
    if (already) {
      const same = already.dataset.menu === id;
      closeMenuPop();
      if (same) return;
    }
    document.querySelectorAll('#stMenuBar .st-menu-btn').forEach(function (b) {
      b.classList.toggle('on', b === btn);
    });
    const pop = document.createElement('div');
    pop.className = 'st-mpop';
    pop.id = 'stMenuPop';
    pop.dataset.menu = id;
    pop.setAttribute('role', 'menu');
    pop.innerHTML = def.items.map(function (it, i) {
      if (it.sep) return '<span class="st-mpop-sep"></span>';
      return '<button type="button" role="menuitem" data-mi="' + i + '"' +
        (it.disabled ? ' disabled' : '') + '>' +
        '<span class="st-mpop-check">' + (it.checked ? '✓' : '') + '</span>' +
        '<span class="st-mpop-label">' + escHtml(it.label) + '</span>' +
        (it.hint ? '<span class="st-mpop-hint">' + it.hint + '</span>' : '') +
        '</button>';
    }).join('');
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pr.width - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pr.height - 8) + 'px';
    pop.addEventListener('click', function (e) {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const it = def.items[Number(b.dataset.mi)];
      closeMenuPop();
      if (it && !it.disabled && it.run) it.run();
    });
  }

  function openHelp() {
    closeMenuPop();
    let m = $('stHelpModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'st-modal hidden';
      m.id = 'stHelpModal';
      m.innerHTML = '<div class="st-modal-card wide" role="dialog" aria-modal="true" aria-label="快捷键">' +
        '<div class="st-modal-h"><b>快捷键与操作</b>' +
        '<button type="button" class="st-modal-x" data-help-close aria-label="关闭">×</button></div>' +
        '<div class="st-modal-body"><div class="st-keys">' +
        SHORTCUTS.map(function (row) {
          return '<div class="st-keyrow"><kbd>' + escHtml(row[0]) + '</kbd><span>' + escHtml(row[1]) + '</span></div>';
        }).join('') +
        '</div></div>' +
        '<div class="st-modal-f"><button type="button" class="st-ghost" data-help-close>知道了</button></div></div>';
      m.addEventListener('click', function (e) {
        if (e.target.closest('[data-help-close]')) m.classList.add('hidden');
      });
      $('stApp').appendChild(m);
    }
    m.classList.remove('hidden');
  }

  function bindAll() {
    $('stPlay').addEventListener('click', togglePlay);
    $('stGoStart').addEventListener('click', function () { seek(0); });
    $('stGoEnd').addEventListener('click', function () { seek(projectDuration(S.project)); });
    $('stBack1s').addEventListener('click', function () { seekBy(-1); });
    $('stFwd1s').addEventListener('click', function () { seekBy(1); });
    $('stPrevFrame').addEventListener('click', function () { stepFrame(-1); });
    $('stNextFrame').addEventListener('click', function () { stepFrame(1); });
    $('stLoop').addEventListener('click', function () { setLoop(!S.loop); });
    $('stToolSelect').addEventListener('click', function () { setTool('select'); });
    $('stToolBlade').addEventListener('click', function () { setTool('blade'); });
    $('stZoomFit').addEventListener('click', fitTimeline);
    $('stMute').addEventListener('click', function () {
      S.muted = !S.muted;
      const wave = document.querySelector('#stMute .st-ico-wave');
      const mute = document.querySelector('#stMute .st-ico-mute');
      if (wave) wave.classList.toggle('hidden', S.muted);
      if (mute) mute.classList.toggle('hidden', !S.muted);
      applyMonitorGain();
      toast(S.muted ? '预览已静音' : '预览已恢复声音');
    });
    $('stVol').addEventListener('input', function (e) {
      S.vol = clamp(Number(e.target.value) / 100, 0, 1);
      applyTime();
    });

    $('stUndo').addEventListener('click', undo);
    $('stRedo').addEventListener('click', redo);
    $('stSplit').addEventListener('click', function () { splitAt(); });
    $('stDup').addEventListener('click', duplicateSelected);
    $('stDel').addEventListener('click', function () { deleteSelected(false); });

    [['stAddV', 'video'], ['stAddT', 'text'], ['stAddA', 'audio']].forEach(function (pair) {
      const btn = $(pair[0]);
      if (btn) btn.addEventListener('click', function () { addTrack(pair[1]); });
    });

    $('stHeads').addEventListener('click', function (e) {
      const b = e.target.closest('[data-tt]');
      if (b) { setTrackFlag(b.dataset.track, b.dataset.tt); return; }
      const del = e.target.closest('[data-del]');
      if (del) removeTrack(del.dataset.del);
    });
    $('stHeads').addEventListener('pointerdown', function (e) {
      const grip = e.target.closest('[data-grip]');
      if (!grip) return;
      const t = trackOf(grip.dataset.grip);
      if (!t) return;
      pushHistory('调整轨道高度');
      S.drag = { mode: 'height', id: t.id, y0: e.clientY, h0: t.height, changed: false, pointerId: e.pointerId };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    const projOut = $('stProjExport');
    if (projOut) projOut.addEventListener('click', exportProjectFile);
    const projIn = $('stProjImport');
    if (projIn) projIn.addEventListener('click', function () { $('stProjFile').click(); });
    const projFile = $('stProjFile');
    if (projFile) projFile.addEventListener('change', function (e) {
      importProjectFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });

    $('stNew').addEventListener('click', function () {
      askConfirm('新建项目', '当前时间线会被清空，素材池里的导入素材也会移除（视频库原文件不受影响）。确定新建？', function () {
        S.project = blankProject();
        S.sel = '';
        S.multi.clear();
        S.time = 0;
        S.hist = [];
        S.future = [];
        S.textSig = '';
        S.mediaSel = '';
        renderAll();
        applyTime();
        saveNow();
        toast('已新建项目');
      });
    });

    $('stExport').addEventListener('click', openExport);

    $('stTabs').addEventListener('click', function (e) {
      const b = e.target.closest('.st-tab');
      if (b) setTab(b.dataset.panel);
    });

    $('stMediaFilter').addEventListener('click', function (e) {
      const b = e.target.closest('[data-fk]');
      if (b) setMediaKind(b.dataset.fk);
    });

    $('stInspector').addEventListener('click', function (e) {
      const b = e.target.closest('[data-itab]');
      if (b) setInspTab(b.dataset.itab);
    });

    const search = $('stMediaSearch');
    if (search) search.addEventListener('input', renderMedia);

    $('stImport').addEventListener('click', function () { $('stFile').click(); });
    $('stImportAudio').addEventListener('click', function () { $('stFileAudio').click(); });
    $('stFile').addEventListener('change', function (e) {
      importFiles(e.target.files);
      e.target.value = '';
    });
    $('stFileAudio').addEventListener('change', function (e) {
      importFiles(e.target.files);
      e.target.value = '';
    });

    bindMediaGrid($('stMediaGrid'));
    bindMediaGrid($('stAudioGrid'));

    $('stSrtImport').addEventListener('click', function () { $('stSrtFile').click(); });
    $('stSrtExport').addEventListener('click', exportSubs);
    $('stSrtFile').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () { importSubs(String(reader.result || '')); };
      reader.onerror = function () { toast('字幕文件读取失败'); };
      reader.readAsText(f, 'utf-8');
    });

    $('stTextPresets').addEventListener('click', function (e) {
      const b = e.target.closest('[data-preset]');
      if (b) addTextClip(b.dataset.preset);
    });

    $('stFxGrid').addEventListener('click', function (e) {
      const card = e.target.closest('.st-fxcard');
      if (!card) return;
      const fxId = card.dataset.fx;
      const c = selected();
      if (!c || (c.kind !== 'video' && c.kind !== 'image')) {
        toast('先选中一个视频 / 图片片段');
        return;
      }
      if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return; }
      if (fxId === 'none') {
        pushHistory('清除滤镜');
        c.effects = [];
      } else {
        const has = (c.effects || []).some(function (e) { return e.type === 'preset' && e.preset === fxId; });
        if (has) {
          pushHistory('移除滤镜');
          c.effects = (c.effects || []).filter(function (e) { return !(e.type === 'preset' && e.preset === fxId); });
        } else {
          if ((c.effects || []).length >= EFFECT_MAX) { toast('效果最多 ' + EFFECT_MAX + ' 个'); return; }
          pushHistory('添加滤镜');
          c.effects = normalizeEffects((c.effects || []).concat([{ type: 'preset', preset: fxId, enabled: true }]));
        }
      }
      renderInspector();
      applyTime();
      scheduleSave();
    });

    $('stRows').addEventListener('pointerdown', onTimelineDown);
    $('stRows').addEventListener('contextmenu', function (e) {
      const node = e.target.closest('.st-clip');
      if (!node) return;
      const c = clipOf(node.dataset.id);
      if (!c) return;
      e.preventDefault();
      openClipMenu(c, e.clientX, e.clientY);
    });
    document.addEventListener('pointerdown', function (e) {
      const menu = $('stCtx');
      if (menu && !menu.contains(e.target)) closeClipMenu();
      const pop = $('stMenuPop');
      if (pop && !pop.contains(e.target) && !e.target.closest('#stMenuBar')) closeMenuPop();
    }, true);
    window.addEventListener('blur', function () { closeClipMenu(); closeMenuPop(); });
    const mb = $('stMenuBar');
    if (mb) {
      mb.addEventListener('click', function (e) {
        const b = e.target.closest('[data-menu]');
        if (b) openMenuBar(b);
      });
      mb.addEventListener('mouseover', function (e) {
        if (!$('stMenuPop')) return;
        const b = e.target.closest('[data-menu]');
        if (b && !b.classList.contains('on')) openMenuBar(b);
      });
    }
    const scrollBox = $('stScroll');
    if (scrollBox) {
      scrollBox.addEventListener('scroll', function () {
        closeClipMenu();
        closeMenuPop();
        const hi = $('stHeadsInner');
        if (hi) hi.style.transform = 'translateY(' + (-scrollBox.scrollTop) + 'px)';
      });
    }
    $('stRuler').addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const mk = e.target.closest('.st-mk');
      if (mk) {
        const t = Number(mk.dataset.mk) || 0;
        if (e.altKey) removeMarker(t);
        else seek(t);
        e.preventDefault();
        return;
      }
      S.drag = { mode: 'scrub', pointerId: e.pointerId };
      seek(timeAtX(e.clientX));
      e.preventDefault();
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      $('stRows').addEventListener(ev, onTimelineDragOver);
    });
    $('stRows').addEventListener('dragleave', function (e) {
      if (e.target === $('stRows')) clearDrop();
    });
    $('stRows').addEventListener('drop', onTimelineDrop);

    $('stSnap').addEventListener('click', function () {
      S.snap = !S.snap;
      $('stSnap').classList.toggle('on', S.snap);
      toast(S.snap ? '磁吸已开启' : '磁吸已关闭');
    });
    $('stZoom').addEventListener('input', function (e) { setZoom(e.target.value); });
    $('stZoomIn').addEventListener('click', function () { setZoom(S.pps * 1.2); });
    $('stZoomOut').addEventListener('click', function () { setZoom(S.pps / 1.2); });

    const sc = $('stScroll');
    sc.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(S.pps * (e.deltaY < 0 ? 1.12 : 0.9));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    $('stInspector').addEventListener('focusin', function (e) {
      if (e.target.matches('input,select,textarea')) S.inspSnap = snap();
    });
    $('stInspector').addEventListener('input', onInspectorInput);
    $('stInspector').addEventListener('change', onInspectorChange);
    $('stInspector').addEventListener('click', function (e) {
      const kf = e.target.closest('[data-kf]');
      if (kf) {
        const c = selected();
        if (c) addKeyframe(c.id, kf.dataset.kf);
        return;
      }
      const snapBtn = e.target.closest('[data-snap]');
      if (snapBtn) { restoreSnapshot(Number(snapBtn.dataset.snap)); return; }
      const addTk = e.target.closest('[data-addtk]');
      if (addTk) { addTrack(addTk.dataset.addtk); return; }
      const tkf = e.target.closest('[data-tkf]');
      if (tkf) { setTrackFlag(tkf.dataset.tk, tkf.dataset.tkf); return; }
      const tkdel = e.target.closest('[data-tkdel]');
      if (tkdel) { removeTrack(tkdel.dataset.tkdel); return; }
      const fxAdd = e.target.closest('[data-fxadd]');
      if (fxAdd) { if (S.sel) addEffect(S.sel, fxAdd.dataset.fxadd); return; }
      const fxDel = e.target.closest('[data-fxdel]');
      if (fxDel) { if (S.sel) removeEffect(S.sel, fxDel.dataset.fxdel); return; }
      const fxMove = e.target.closest('[data-fxmove]');
      if (fxMove) { if (S.sel) moveEffect(S.sel, fxMove.dataset.fxid, Number(fxMove.dataset.fxmove)); return; }
      const histBtn = e.target.closest('[data-hist]');
      if (histBtn) { goHistory(Number(histBtn.dataset.hist)); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'dup') duplicateSelected();
      else if (b.dataset.act === 'del') deleteSelected(false);
      else if (b.dataset.act === 'rdel') deleteSelected(true);
      else if (b.dataset.act === 'kfclear' && S.sel) clearKeyframes(S.sel);
      else if (b.dataset.act === 'voice' && S.sel) generateVoice(S.sel);
    });

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (S.exportSession && b.dataset.close === 'stExportModal') {
          cancelExport();
          return;
        }
        closeModal(b.dataset.close);
      });
    });

    $('stLibOpen').addEventListener('click', openLibrary);
    $('stLibModal').addEventListener('click', function (e) {
      const b = e.target.closest('[data-libtab]');
      if (b) setLibTab(b.dataset.libtab);
    });
    $('stLibSearch').addEventListener('input', function (e) { renderLibList(e.target.value); });
    $('stLibList').addEventListener('click', function (e) {
      const row = e.target.closest('.st-librow');
      if (!row || row.classList.contains('added')) return;
      const id = row.dataset.asset || row.dataset.lib;
      if (!id) return;
      if (S.libPick.has(id)) S.libPick.delete(id);
      else S.libPick.add(id);
      row.classList.toggle('on', S.libPick.has(id));
      updateLibAdd();
    });
    $('stLibAdd').addEventListener('click', addFromLibrary);

    $('stConfirmNo').addEventListener('click', function () { closeModal('stConfirmModal'); });
    $('stConfirmYes').addEventListener('click', function () {
      const fn = S._confirmYes;
      S._confirmYes = null;
      closeModal('stConfirmModal');
      if (fn) fn();
    });

    bindExport();

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', fitFrame);

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () { fitFrame(); });
      const prev = document.querySelector('.st-prev');
      if (prev) ro.observe(prev);
    }

    setTab('media');
  }

  /* ---------------- 项目文件导入 / 导出 ---------------- */
  function exportProjectJSON() {
    S.project.meta = S.project.meta || {};
    S.project.meta.updatedAt = Date.now();
    return JSON.stringify(S.project, null, 2);
  }

  function safeFileName(name) {
    return String(name || '未命名项目').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || '项目';
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
  }

  function exportProjectFile() {
    const blob = new Blob([exportProjectJSON()], { type: 'application/json' });
    downloadBlob(blob, safeFileName(S.project.name) + '.hfstudio');
    toast('项目文件已导出');
  }

  function importProjectJSON(text, fileName) {
    let raw = null;
    try { raw = JSON.parse(String(text || '')); }
    catch (e) { toast('项目文件不是合法 JSON'); return false; }
    const p = normalizeProject(raw);
    /* 文件素材的 blob: 地址跨会话必失效，导入时只保留视频库 / 图库 / 配音素材与文字 */
    p.media = p.media.filter(function (m) {
      return m.source === 'library' || m.source === 'asset' || m.source === 'tts';
    });
    const keep = new Set(p.media.map(function (m) { return m.id; }));
    p.clips = p.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    if (fileName && (!raw.name || p.name === '未命名项目')) p.name = String(fileName).replace(/\.(hfstudio|json)$/i, '');
    S.project = p;
    S.time = 0;
    S.sel = '';
    S.multi.clear();
    S.hist = [];
    S.future = [];
    S.textSig = '';
    rebuildTracks();
    renderAll();
    applyTime();
    saveNow();
    hydrateMedia();
    toast('已导入项目：' + p.name);
    return true;
  }

  function importProjectFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = function () { importProjectJSON(r.result, file.name); };
    r.onerror = function () { toast('读取项目文件失败'); };
    r.readAsText(file);
  }

  /* ---------------- 导出（Canvas + MediaRecorder） ---------------- */
  function pickMime() {
    const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const m of list) {
        try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
      }
    }
    return 'video/webm';
  }

  function readExportOpts() {
    const res = String(($('stExRes') || {}).value || '1920x1080').split('x');
    let w = clamp(Number(res[0]) || 1920, 320, 3840);
    let h = clamp(Number(res[1]) || 1080, 180, 3840);
    if (w % 2) w += 1;
    if (h % 2) h += 1;
    const fps = Number(($('stExFps') || {}).value) || 30;
    const mb = Number(($('stExBr') || {}).value) || 8;
    const name = String(($('stExName') || {}).value || '').trim() || S.project.name || '未命名项目';
    return { w: w, h: h, fps: fps, bitrate: mb * 1000 * 1000, name: name };
  }

  function openExport() {
    const modal = $('stExportModal');
    if (!modal) return;
    $('stExName').value = (S.project.name || '未命名项目') + '-' + new Date().toISOString().slice(0, 10);
    $('stExProg').classList.add('hidden');
    $('stExResult').classList.add('hidden');
    $('stExStart').disabled = false;
    $('stExStart').textContent = '开始导出';
    $('stExCancel').textContent = '取消';
    modal.classList.remove('hidden');
  }

  function waitForPreview() {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      const check = function () {
        const els = [];
        Object.keys(S.pool).forEach(function (id) {
          const p = S.pool[id];
          if (!p) return;
          if (p.video && p.video.src) els.push(p.video);
          if (p.audio && p.audio.src) els.push(p.audio);
        });
        const ok = els.every(function (el) { return el.readyState >= 2; });
        if (ok || Date.now() - t0 > 2600) resolve();
        else setTimeout(check, 90);
      };
      check();
    });
  }

  async function startExport() {
    if (S.exportSession) return;
    const dur = projectDuration(S.project);
    if (dur <= 0.05) { toast('时间线还是空的，先加一段素材'); return; }
    if (!window.MediaRecorder || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      toast('当前环境不支持视频编码（缺少 MediaRecorder）');
      return;
    }
    const opts = readExportOpts();
    /* 入出点是会话级状态，可能残留在已缩短的时间线上：先夹到当前时长再判断。 */
    const rIn = S.rngIn == null ? null : clamp(S.rngIn, 0, dur);
    const rOut = S.rngOut == null ? null : clamp(S.rngOut, 0, dur);
    const wantRange = rIn != null && rOut != null && rOut - rIn > 0.05 &&
      !!($('stExRange') && $('stExRange').checked);
    const a = wantRange ? rIn : 0;
    const b = wantRange ? rOut : dur;
    const canvas = document.createElement('canvas');
    canvas.width = opts.w;
    canvas.height = opts.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { toast('无法创建导出画布'); return; }

    ensureAudio();
    resumeAudio();
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.dir = 1;
    S.rate = 1;
    S.time = a;
    S.last = 0;
    applyTime();
    $('stExProg').classList.remove('hidden');
    $('stExResult').classList.add('hidden');
    $('stExBar').style.width = '0%';
    $('stExTxt').textContent = '准备渲染…';
    $('stExStart').disabled = true;
    $('stExStart').textContent = '导出中…';
    $('stExCancel').textContent = '取消导出';

    await waitForPreview();

    const stream = canvas.captureStream(opts.fps);
    if (AUD.recDest) {
      try {
        AUD.recDest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
      } catch (e) {}
    }
    let rec = null;
    try {
      rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: opts.bitrate });
    } catch (e) {
      try { rec = new MediaRecorder(stream); }
      catch (err) { toast('无法创建编码器：' + (err.message || err)); resetExportUI(); return; }
    }

    const view = {
      opts: opts,
      ctx: ctx,
      canvas: canvas,
      a: a,
      b: b,
      dur: Math.max(0.05, b - a),
      chunks: [],
      rec: rec,
      stream: stream,
      lastPaint: 0,
      cancelled: false,
      finalized: false
    };
    S.exportSession = view;
    rec.ondataavailable = function (e) {
      if (e.data && e.data.size) view.chunks.push(e.data);
    };
    rec.onstop = function () { finalizeExport(view); };
    try { rec.start(200); } catch (e) { toast('录制启动失败：' + (e.message || e)); S.exportSession = null; resetExportUI(); return; }

    applyMonitorGain();
    S.time = a;
    applyTime();
    S.playing = true;
    S.last = 0;
    paintPlayIcon();
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(tick);
    toast('开始导出，期间请不要切走页面');
  }

  function resetExportUI() {
    const start = $('stExStart');
    if (start) { start.disabled = false; start.textContent = '开始导出'; }
    const cancel = $('stExCancel');
    if (cancel) cancel.textContent = '取消';
  }

  function drawEl(ctx, el, c, W, H, kind, t) {
    if (!el) return;
    if (kind === 'image') {
      if (!el.complete || !el.naturalWidth) return;
    } else if (el.readyState < 2 || !el.videoWidth) {
      return;
    }
    const mw = kind === 'image' ? el.naturalWidth : el.videoWidth;
    const mh = kind === 'image' ? el.naturalHeight : el.videoHeight;
    if (!mw || !mh) return;
    const fit = Math.min(W / mw, H / mh);
    const view = visualOf(c, t);
    const dw = mw * fit * view.scale;
    const dh = mh * fit * view.scale;
    ctx.save();
    ctx.globalAlpha = clamp(view.opacity * fadeFactor(c, t), 0, 1);
    const f = effectsCss(c);
    if (f && f !== 'none') ctx.filter = f;
    ctx.translate(W / 2 + (view.x / 100) * W, H / 2 + (view.y / 100) * H);
    ctx.rotate((view.rot * Math.PI) / 180);
    try { ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh); } catch (e) {}
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    String(text || '').split('\n').forEach(function (line) {
      let cur = '';
      const chars = Array.from(line);
      for (const ch of chars) {
        const test = cur + ch;
        if (ctx.measureText(test).width > maxW && cur) { out.push(cur); cur = ch; }
        else cur = test;
      }
      out.push(cur);
    });
    return out;
  }

  function drawTexts(ctx, W, H, t) {
    activeTextsAt(t).forEach(function (c) {
      const view = visualOf(c, t);
      const fs = c.text.size * (W / S.project.w) * view.scale;
      if (fs <= 0.5) return;
      ctx.save();
      ctx.globalAlpha = clamp(view.opacity * fadeFactor(c, t), 0, 1);
      ctx.font = (c.text.bold ? '700 ' : '400 ') + fs + 'px "Microsoft YaHei","PingFang SC",Arial,sans-serif';
      ctx.textBaseline = 'middle';
      const lines = wrapText(ctx, c.text.content, W * 0.86);
      const lh = fs * 1.28;
      const cx = W / 2 + (view.x / 100) * W;
      const cy = H / 2 + (view.y / 100) * H;
      const blockH = lines.length * lh;
      let maxLineW = 0;
      lines.forEach(function (l) { maxLineW = Math.max(maxLineW, ctx.measureText(l).width); });
      const padX = fs * 0.32;
      const padY = fs * 0.16;
      ctx.translate(cx, cy);
      ctx.rotate((view.rot * Math.PI) / 180);
      if (c.text.bg && c.text.bg !== 'rgba(0,0,0,0)' && c.text.bg !== 'transparent') {
        ctx.fillStyle = c.text.bg;
        roundRect(ctx, -maxLineW / 2 - padX, -blockH / 2 - padY,
          maxLineW + padX * 2, blockH + padY * 2, fs * 0.12);
        ctx.fill();
      }
      ctx.fillStyle = c.text.color;
      lines.forEach(function (ln, i) {
        let x = 0;
        if (c.text.align === 'left') { ctx.textAlign = 'left'; x = -maxLineW / 2; }
        else if (c.text.align === 'right') { ctx.textAlign = 'right'; x = maxLineW / 2; }
        else { ctx.textAlign = 'center'; }
        ctx.fillText(ln, x, -blockH / 2 + lh / 2 + i * lh);
      });
      ctx.restore();
    });
  }

  /* 唯一合成入口：预览抓帧、导出、当前帧 PNG 都走这里。
     参数只依赖 (W,H,t)，不读全局时间，保证任意帧可重放。 */
  function renderFrame(ctx, W, H, t) {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    /* 轨道数组自上而下是「上层 → 下层」，绘制时反过来：下层先画、上层后盖 */
    tracksOfKind('video').slice().reverse().forEach(function (tk) {
      if (!trackActive(tk)) return;
      const c = activeClipOn(tk.id, t);
      if (!c) return;
      const m = mediaOf(c.mediaId);
      const pool = S.pool[tk.id];
      if (!m || !pool) return;
      const el = m.kind === 'image' ? pool.img : pool.video;
      drawEl(ctx, el, c, W, H, m.kind, t);
    });
    drawTexts(ctx, W, H, t);
    ctx.restore();
  }

  function grabFrame(t) {
    const W = S.project.w || 1280;
    const H = S.project.h || 720;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    if (!g) return '';
    renderFrame(g, W, H, t == null ? S.time : t);
    try { return cv.toDataURL('image/png'); } catch (e) { return ''; }
  }

  function exportStill() {
    const url = grabFrame(S.time);
    if (!url) { toast('当前帧抓取失败'); return ''; }
    const a = document.createElement('a');
    a.href = url;
    a.download = '剪辑台-帧-' + String(round2(S.time)).replace('.', '_') + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已导出当前帧');
    return url;
  }

  function drawExportFrame() {
    const v = S.exportSession;
    if (!v) return;
    renderFrame(v.ctx, v.opts.w, v.opts.h, S.time);
  }

  function paintExportProgress() {
    const v = S.exportSession;
    if (!v) return;
    const now = performance.now();
    if (now - v.lastPaint < 120) return;
    v.lastPaint = now;
    const pct = clamp(((S.time - v.a) / v.dur) * 100, 0, 100);
    const bar = $('stExBar');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const txt = $('stExTxt');
    if (txt) {
      txt.textContent = '正在渲染 ' + fmtMmss(S.time - v.a) + ' / ' + fmtMmss(v.dur) + ' · ' + pct.toFixed(0) + '%';
    }
  }

  function finishExportTick() {
    const v = S.exportSession;
    if (!v) return;
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.last = 0;
    paintPlayIcon();
    drawExportFrame();
    try {
      if (v.rec && v.rec.state !== 'inactive') v.rec.stop();
      else finalizeExport(v);
    } catch (e) { finalizeExport(v); }
  }

  function finalizeExport(v) {
    if (!v || v.finalized) return;
    v.finalized = true;
    if (S.exportSession === v) S.exportSession = null;
    applyMonitorGain();
    if (v.stream) {
      try { v.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    }
    const blob = new Blob(v.chunks, { type: (v.rec && v.rec.mimeType) || 'video/webm' });
    if (v.cancelled) {
      $('stExTxt').textContent = '已取消导出';
      resetExportUI();
      toast('已取消导出');
      S.time = 0;
      applyTime();
      return;
    }
    if (!blob.size) {
      $('stExTxt').textContent = '导出失败：编码器没有返回数据';
      resetExportUI();
      toast('导出失败，当前环境可能不支持 WebM 编码');
      S.time = 0;
      applyTime();
      return;
    }
    if (S.exportUrl) {
      try { URL.revokeObjectURL(S.exportUrl); } catch (e) {}
    }
    S.exportUrl = URL.createObjectURL(blob);
    const safeName = String(v.opts.name || '导出视频').replace(/[\\/:*?"<>|]+/g, '_');
    const link = $('stExLink');
    if (link) {
      link.href = S.exportUrl;
      link.download = safeName + '.webm';
    }
    $('stExResultT').textContent = '导出完成：' + safeName + '.webm';
    $('stExResultS').textContent = fmtBytes(blob.size) + ' · ' + fmtMmss(v.dur) + ' · ' +
      v.opts.w + '×' + v.opts.h + ' · ' + v.opts.fps + ' fps';
    $('stExResult').classList.remove('hidden');
    $('stExBar').style.width = '100%';
    $('stExTxt').textContent = '已完成 100%';
    resetExportUI();
    $('stExStart').textContent = '再导一次';
    $('stExCancel').textContent = '关闭';
    S.time = 0;
    applyTime();
    toast('导出完成，点「下载到本机」保存');
  }

  function cancelExport() {
    const v = S.exportSession;
    if (!v) { closeModal('stExportModal'); return; }
    if (v.cancelled) return;
    v.cancelled = true;
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.last = 0;
    paintPlayIcon();
    try {
      if (v.rec && v.rec.state !== 'inactive') v.rec.stop();
      else finalizeExport(v);
    } catch (e) { finalizeExport(v); }
  }

  function bindExport() {
    $('stExStart').addEventListener('click', startExport);
  }

  /* ---------------- 注册 ---------------- */
  const APP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4"/><path d="M8.2 4.6v14.8M15.8 4.6v14.8"/><path d="m5.2 9.4 3.2 4.2M5.2 15.4l3.2-4.2"/></svg>';

  if (typeof registerApp === 'function') {
    registerApp({
      id: 'studio',
      name: '剪辑台',
      title: '剪辑台',
      sub: '时间线视频剪辑',
      order: 11,
      cls: 'studio',
      icon: APP_ICON,
      body: window.STUDIO_BODY,
      css: ['apps/studio/app.css'],
      mount: function (body) { init(body); }
    });
  }

  /* ---------------- 供探针使用 ---------------- */
  window.studioApp = {
    __test: {
      state: function () {
        return {
          time: S.time,
          playing: S.playing,
          tool: S.tool,
          loop: S.loop,
          sel: S.sel,
          multi: Array.from(S.multi),
          pps: S.pps,
          duration: projectDuration(S.project),
          media: S.project.media.length,
          clips: S.project.clips.length,
          tracks: S.project.tracks.length,
          markers: S.project.markers.length,
          snaps: S.snapshots.length,
          steps: S.steps,
          hist: S.hist.length,
          future: S.future.length,
          exporting: !!S.exportSession,
          frameW: S.frameW,
          frameH: S.frameH,
          rngIn: S.rngIn,
          rngOut: S.rngOut,
          rate: S.rate,
          dir: S.dir,
          clipboard: S.clipboard ? S.clipboard.items.length : 0
        };
      },
      project: function () { return JSON.parse(JSON.stringify(S.project)); },
      clean: function (p) { return cleanForStore(p || S.project); },
      tracks: function () { return JSON.parse(JSON.stringify(S.project.tracks)); },
      addMedia: function (m) {
        const item = {
          id: m.id || uid('m'),
          name: m.name || '测试素材',
          kind: m.kind || 'image',
          url: m.url || '',
          dur: Number(m.dur) || 5,
          source: 'file',
          libId: ''
        };
        pushHistory('加入素材');
        S.project.media.push(item);
        renderAll();
        scheduleSave();
        return item;
      },
      addClip: function (mediaId, track, start) {
        return addMediaClip(mediaId, track, start, true);
      },
      addText: function (opts) {
        return addTextClip((opts && opts.preset) || 'title', opts || {});
      },
      seek: function (t) { seek(t); return S.time; },
      select: function (id) { selectClip(id || ''); return S.sel; },
      selectMany: function (ids) {
        S.multi = new Set((ids || []).filter(function (id) { return !!clipOf(id); }));
        S.sel = (ids && ids.length) ? ids[ids.length - 1] : '';
        if (S.multi.size < 2) S.multi.clear();
        paintSel();
        renderInspector();
        return selectedIds();
      },
      split: function (t) { return splitAt(t); },
      undo: function () { return undo(); },
      redo: function () { return redo(); },
      duplicate: function () { return duplicateSelected(); },
      remove: function (ripple) { return deleteSelected(!!ripple); },
      setClip: function (id, patch) { return setClipProps(id, patch); },
      clipEls: function () { return document.querySelectorAll('#stRows .st-clip').length; },
      textEls: function () { return document.querySelectorAll('#stTexts .st-text-item').length; },
      previewEl: function () {
        const ids = tracksOfKind('video').map(function (t) { return t.id; });
        const p = S.pool['v1'] || S.pool[ids[0]];
        if (!p) return null;
        return {
          video: !!p.video && !p.video.classList.contains('hidden') && !!p.video.src,
          img: !!p.img && !p.img.classList.contains('hidden') && !!p.img.src,
          ready: p.video ? p.video.readyState : 0
        };
      },
      migrate: function (raw) { return JSON.parse(JSON.stringify(migrateProject(raw))); },
      normalize: function (raw) { return JSON.parse(JSON.stringify(normalizeProject(raw))); },
      sample: function (keys, t) { return sampleTrack(keys, t); },
      propAt: function (id, prop, t) {
        const c = clipOf(id);
        return c ? propAt(c, prop, t) : null;
      },
      addTrack: function (kind) { return addTrack(kind); },
      removeTrack: function (id) { return removeTrack(id); },
      toggleTrack: function (id, key) { setTrackFlag(id, key); return JSON.parse(JSON.stringify(trackOf(id))); },
      addMarker: function (t) { return addMarker(t); },
      removeMarker: function (t) { return removeMarker(t); },
      markers: function () { return JSON.parse(JSON.stringify(S.project.markers)); },
      markerEls: function () { return document.querySelectorAll('#stRuler .st-mk').length; },
      snapTime: function (t) { return snapValue(Number(t) || 0, '', 0); },
      snapshotNow: function () { saveSnapshot(); return S.snapshots.length; },
      snapshots: function () {
        return S.snapshots.map(function (s) { return { at: s.at, name: s.name, clips: s.project.clips.length }; });
      },
      restoreSnapshot: function (i) { return restoreSnapshot(i); },
      exportProjectJSON: exportProjectJSON,
      importProjectJSON: function (text, name) { return importProjectJSON(text, name); },
      addKeyframe: function (id, prop, t) { return addKeyframe(id, prop, t == null ? S.time : t); },
      clearKeyframes: function (id, prop) { return clearKeyframes(id, prop); },
      ctxMenu: function () {
        const el = $('stCtx');
        if (!el) return null;
        return Array.from(el.querySelectorAll('[data-mi]')).map(function (b) {
          return { id: b.dataset.mi, label: b.textContent, disabled: !!b.disabled };
        });
      },
      openCtx: function (id, x, y) {
        const c = clipOf(id);
        if (!c) return false;
        openClipMenu(c, x == null ? 40 : x, y == null ? 40 : y);
        return true;
      },
      clickCtx: function (id) {
        const el = $('stCtx');
        if (!el) return false;
        const b = el.querySelector('[data-mi="' + id + '"]');
        if (!b || b.disabled) return false;
        b.click();
        return true;
      },
      closeCtx: closeClipMenu,
      detachAudio: function (id) { return detachAudio(id); },
      setTool: setTool,
      setZoom: setZoom,
      tool: function () { return S.tool; },
      setLoop: setLoop,
      loop: function () { return S.loop; },
      selectAll: selectAllClips,
      fit: fitTimeline,
      bladeAt: function (id, t) { return splitClip(clipOf(id), Number(t)); },
      splitAll: function (t) { return splitAllAt(t == null ? S.time : t); },
      effects: function (id) {
        const c = clipOf(id);
        return c ? JSON.parse(JSON.stringify(c.effects || [])) : null;
      },
      effectsCss: function (id) {
        const c = clipOf(id);
        return c ? effectsCss(c) : '';
      },
      setEffects: function (id, list) {
        const c = clipOf(id);
        if (!c) return null;
        c.effects = normalizeEffects(list, '');
        renderInspector();
        applyTime();
        scheduleSave();
        return JSON.parse(JSON.stringify(c.effects));
      },
      addEffect: function (id, type) {
        const e = addEffect(id, type);
        return e ? JSON.parse(JSON.stringify(e)) : null;
      },
      toggleEffect: function (id, fxId, on) { return setEffectEnabled(id, fxId, on); },
      fxParam: function (id, fxId, key, v) {
        const c = clipOf(id);
        if (!c) return null;
        const e = (c.effects || []).filter(function (x) { return x.id === fxId; })[0];
        if (!e || !e.params) return null;
        e.params[key] = Number(v);
        applyTime();
        scheduleSave();
        return JSON.parse(JSON.stringify(e.params));
      },
      moveEffect: function (id, fxId, dir) { return moveEffect(id, fxId, dir); },
      grabFrame: function (t) { return grabFrame(t); },
      exportStill: exportStill,
      setRange: function (edge, t) { return setRangeEdge(edge, t); },
      range: function () { return { in: S.rngIn, out: S.rngOut }; },
      clearRange: function () { clearInOut(); return true; },
      trimRange: function (trackId, a, b) {
        const n = clearRange(trackId, a, b);
        renderAll();
        applyTime();
        scheduleSave();
        return n;
      },
      copy: function () { return copySelected(); },
      paste: function (t) { return pasteAt(t); },
      place: function (mediaId, mode) {
        const c = placeMedia(mediaId, mode);
        return c ? c.id : null;
      },
      parseSubs: parseSubs,
      buildSrt: function () { return subsText(); },
      importSubs: function (text) { return importSubs(text); },
      history: function () { return S.hist.map(function (h) { return h.label; }); },
      goHistory: function (i) { return goHistory(i); },
      peaks: function (mediaId) {
        const p = peaksOf(mediaId);
        if (!p) return null;
        let max = 0;
        for (let i = 0; i < p.data.length; i++) if (p.data[i] > max) max = p.data[i];
        return { n: p.data.length, max: max };
      },
      loadPeaks: function (mediaId) { return loadPeaks(mediaId); },
      level: function () {
        const el = $('stLevel');
        const bar = el && el.querySelector('i');
        return bar ? bar.style.height || '0%' : '';
      },
      shuttle: function (dir) { shuttle(dir); return { rate: S.rate, dir: S.dir, playing: S.playing }; },
      pause: pause,
      playEnd: playEnd,
      playStart: playStart,
      openMenu: function (name) {
        const b = document.querySelector('#stMenuBar [data-menu="' + name + '"]');
        if (!b) return false;
        openMenuBar(b);
        return true;
      },
      menuBar: function () {
        const pop = $('stMenuPop');
        if (!pop) return null;
        return {
          id: pop.dataset.menu,
          items: Array.from(pop.querySelectorAll('[data-mi]')).map(function (x) {
            return {
              label: (x.querySelector('.st-mpop-label') || {}).textContent || '',
              hint: (x.querySelector('.st-mpop-hint') || {}).textContent || '',
              disabled: !!x.disabled,
              checked: (x.querySelector('.st-mpop-check') || {}).textContent || ''
            };
          })
        };
      },
      clickMenu: function (label) {
        const pop = $('stMenuPop');
        if (!pop) return false;
        const b = Array.from(pop.querySelectorAll('[data-mi]')).filter(function (x) {
          return ((x.querySelector('.st-mpop-label') || {}).textContent || '') === label;
        })[0];
        if (!b || b.disabled) return false;
        b.click();
        return true;
      },
      closeMenu: closeMenuPop,
      helpOpen: function () {
        const m = $('stHelpModal');
        return !!m && !m.classList.contains('hidden');
      },
      edit: {
        trim: function (id, edge, dx, ripple) {
          const c = clipOf(id);
          if (!c) return null;
          return trimClip(c, edge, dx, { start: c.start, dur: c.dur, in: c.in }, !!ripple);
        },
        roll: function (id, edge, dx) {
          const c = clipOf(id);
          if (!c) return null;
          return rollClip(c, edge, dx, { start: c.start, dur: c.dur, in: c.in });
        },
        slip: function (id, dx) {
          const c = clipOf(id);
          return c ? slipClip(c, dx, c.in) : null;
        },
        slide: function (id, dx) {
          const c = clipOf(id);
          return c ? slideClip(c, dx) : null;
        }
      },
      exportSupported: function () {
        return !!(window.MediaRecorder && typeof HTMLCanvasElement.prototype.captureStream === 'function');
      },
      openExport: openExport,
      startExport: startExport,
      cancelExport: cancelExport,
      exportState: function () {
        const res = $('stExResult');
        return {
          busy: !!S.exportSession,
          done: !!res && !res.classList.contains('hidden'),
          href: ($('stExLink') && $('stExLink').href) || '',
          text: ($('stExTxt') && $('stExTxt').textContent) || '',
          bar: ($('stExBar') && $('stExBar').style.width) || '0%'
        };
      }
    }
  };
})();

/* ---- apps/tunnel/app.js ---- */
/* 分享与反馈 —— 一键把本机变成「可上传、可反馈」的公网入口。
 *
 * 服务本身在 plugins/tunnel/tunnel.js（主进程按 plugins/manifest.json 拉起），
 * 这里只是控制面板：启动 / 停止隧道、看公网地址、管口令与上限、看收到的文件和反馈。
 *
 * 端口来源：桌面壳通过 ?tunnel=http://127.0.0.1:<port> 注入（被占用时端口会顺延）。
 * 用 file:// 直接打开时没有这个参数，退回默认 8796。
 */
(function () {
  'use strict';

  const BASE = (function () {
    try {
      const v = new URLSearchParams(location.search).get('tunnel');
      return v ? decodeURIComponent(v).replace(/\/+$/, '') : 'http://127.0.0.1:8796';
    } catch (e) { return 'http://127.0.0.1:8796'; }
  })();

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>';

  const BODY =
    '<div class="tn-wrap">' +
      '<div class="tn-head">' +
        '<div class="tn-title">' +
          '<div class="tn-h">分享与反馈</div>' +
          '<div class="tn-sub">启动后，任何拿到链接的人都能上传资源、提交意见，文件直接落在你这台机器上。</div>' +
        '</div>' +
        '<div class="tn-badge" id="tnBadge"><i></i><span>服务未连接</span></div>' +
      '</div>' +

      '<section class="tn-hero">' +
        '<div class="tn-url-line">' +
          '<div class="tn-url" id="tnUrl">尚未生成公网地址</div>' +
          '<button type="button" class="tn-btn" id="tnCopy" disabled>复制</button>' +
          '<button type="button" class="tn-btn" id="tnOpen" disabled>打开</button>' +
        '</div>' +
        '<div class="tn-actions">' +
          '<button type="button" class="tn-btn tn-primary" id="tnToggle">启动分享</button>' +
          '<span class="tn-state" id="tnState">未启动</span>' +
        '</div>' +
        '<div class="tn-meta" id="tnMeta"></div>' +
        '<div class="tn-warn">公网地址每次启动都会变；链接相当于门钥匙，请只发给信任的人。</div>' +
      '</section>' +

      '<div class="tn-grid">' +
        '<section class="tn-card">' +
          '<div class="tn-card-h">访问口令</div>' +
          '<label class="tn-switch"><input type="checkbox" id="tnKeyOn"><span>启用口令保护</span></label>' +
          '<div class="tn-key-row">' +
            '<input type="text" id="tnKey" readonly spellcheck="false">' +
            '<button type="button" class="tn-btn tn-mini" id="tnRegen">换一个</button>' +
          '</div>' +
          '<div class="tn-tip">分享链接会自动带上口令。关掉口令后，任何人只要有链接就能上传。</div>' +
        '</section>' +

        '<section class="tn-card">' +
          '<div class="tn-card-h">接收设置</div>' +
          '<label class="tn-field"><span>单文件上限</span>' +
            '<input type="number" id="tnMax" min="1" max="2048" step="10"> <em>MB</em></label>' +
          '<label class="tn-switch"><input type="checkbox" id="tnFbOn"><span>开放意见反馈</span></label>' +
          '<label class="tn-field tn-field-col"><span>页面说明</span>' +
            '<input type="text" id="tnNote" maxlength="300" placeholder="写给访问者的一句话"></label>' +
          '<div class="tn-save-row"><button type="button" class="tn-btn tn-primary tn-mini" id="tnSave">保存设置</button>' +
          '<button type="button" class="tn-btn tn-mini" id="tnReveal">打开上传目录</button></div>' +
        '</section>' +
      '</div>' +

      '<div class="tn-tabs">' +
        '<button type="button" class="tn-tab on" data-tab="up">收到的文件 <b id="tnUpCount">0</b></button>' +
        '<button type="button" class="tn-tab" data-tab="fb">意见反馈 <b id="tnFbCount">0</b></button>' +
      '</div>' +
      '<div class="tn-panel" id="tnPanel"><div class="tn-empty">还没有内容。</div></div>' +

      '<details class="tn-log">' +
        '<summary>运行日志</summary>' +
        '<pre id="tnLogs">—</pre>' +
      '</details>' +
    '</div>';

  let timer = null;
  let busy = false;
  let tab = 'up';
  let lastList = { up: '', fb: '' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    const v = Number(n || 0);
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function api(path, opts) {
    const r = await fetch(BASE + path, Object.assign({ cache: 'no-store' }, opts || {}));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  function shareUrl(st) {
    if (!st || !st.tunnel || !st.tunnel.url) return '';
    const k = st.config && st.config.keyOn && st.config.key ? ('?k=' + encodeURIComponent(st.config.key)) : '';
    return st.tunnel.url + '/' + k;
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function setState(body, st) {
    body._st = st;
    const url = shareUrl(st);
    const urlEl = body.querySelector('#tnUrl');
    const copyBtn = body.querySelector('#tnCopy');
    const openBtn = body.querySelector('#tnOpen');
    const badge = body.querySelector('#tnBadge');
    const stateEl = body.querySelector('#tnState');
    const metaEl = body.querySelector('#tnMeta');
    const toggle = body.querySelector('#tnToggle');

    urlEl.textContent = url || '尚未生成公网地址';
    urlEl.classList.toggle('on', !!url);
    copyBtn.disabled = !url;
    openBtn.disabled = !url;

    const t = st.tunnel || {};
    const running = t.status === 'running';
    const starting = t.status === 'starting';
    badge.className = 'tn-badge' + (running ? ' ok' : starting ? ' wait' : t.status === 'error' ? ' err' : '');
    badge.querySelector('span').textContent = running ? '公网可访问' : starting ? '正在启动' : t.status === 'error' ? '启动失败' : '未启动';

    toggle.textContent = running || starting ? '停止分享' : '启动分享';
    toggle.classList.toggle('tn-stop', running || starting);

    if (st.download && st.download.running) {
      stateEl.textContent = '正在下载 cloudflared ' + (st.download.pct || 0) + '%' +
        (st.download.bytesPerSec ? ' · ' + Math.max(1, Math.round(st.download.bytesPerSec / 1024)) + ' KB/s' : '') +
        (st.download.source ? ' · ' + st.download.source : '');
    } else if (starting) {
      stateEl.textContent = '正在协商公网地址…';
    } else if (running) {
      stateEl.textContent = '已连接 Cloudflare';
    } else if (t.status === 'error') {
      stateEl.textContent = t.error || '启动失败';
    } else {
      stateEl.textContent = '未启动';
    }
    stateEl.classList.toggle('bad', t.status === 'error');

    const c = st.config || {};
    metaEl.textContent = '本地服务 ' + (st.local || '') + ' · 上传文件 ' +
      ((st.counts && st.counts.uploads) || 0) + ' 份 · 反馈 ' + ((st.counts && st.counts.feedback) || 0) + ' 条';

    const keyOn = body.querySelector('#tnKeyOn');
    if (document.activeElement !== keyOn) keyOn.checked = c.keyOn !== false;
    const keyEl = body.querySelector('#tnKey');
    if (document.activeElement !== keyEl) keyEl.value = c.key || '';
    const maxEl = body.querySelector('#tnMax');
    if (document.activeElement !== maxEl) maxEl.value = c.maxMB || 200;
    const fbEl = body.querySelector('#tnFbOn');
    if (document.activeElement !== fbEl) fbEl.checked = c.feedbackOn !== false;
    const noteEl = body.querySelector('#tnNote');
    if (document.activeElement !== noteEl) noteEl.value = c.note || '';

    body.querySelector('#tnUpCount').textContent = String((st.counts && st.counts.uploads) || 0);
    body.querySelector('#tnFbCount').textContent = String((st.counts && st.counts.feedback) || 0);

    const logEl = body.querySelector('#tnLogs');
    const logs = (st.logs || []).map(x => fmtTime(x.at) + '  ' + x.text).join('\n');
    if (logEl.textContent !== logs) logEl.textContent = logs || '—';
  }

  function offline(body, err) {
    body._st = null;
    const badge = body.querySelector('#tnBadge');
    badge.className = 'tn-badge err';
    badge.querySelector('span').textContent = '服务未连接';
    body.querySelector('#tnState').textContent = '无法连接本地服务（' + BASE + '）';
    body.querySelector('#tnState').classList.add('bad');
    body.querySelector('#tnMeta').textContent = '桌面端启动时会自动拉起该服务；浏览器直开 index.html 时没有它。';
    body.querySelector('#tnUrl').textContent = '尚未生成公网地址';
    body.querySelector('#tnCopy').disabled = true;
    body.querySelector('#tnOpen').disabled = true;
    body.querySelector('#tnToggle').textContent = '启动分享';
    body.querySelector('#tnLogs').textContent = err ? String(err.message || err) : '—';
  }

  function renderList(body, st, up, fb) {
    const panel = body.querySelector('#tnPanel');
    if (tab === 'up') {
      const items = (up && up.items) || [];
      const key = 'u' + items.length + '|' + items.map(x => x.name + x.size + x.at).join(',');
      if (lastList.up === key) return;
      lastList.up = key;
      if (!items.length) {
        panel.innerHTML = '<div class="tn-empty">还没有收到文件。把链接发给朋友后，这里会出现他们的上传。</div>';
        return;
      }
      panel.innerHTML = items.map(x =>
        '<div class="tn-item">' +
          '<div class="tn-item-main">' +
            '<div class="tn-item-name" title="' + esc(x.name) + '">' + esc(x.name) + '</div>' +
            '<div class="tn-item-sub">' + fmtSize(x.size) + ' · ' + fmtTime(x.at) +
              (x.note ? ' · ' + esc(x.note) : '') + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
    } else {
      const items = (fb && fb.items) || [];
      const key = 'f' + items.length + '|' + items.map(x => x.at + x.text.length).join(',');
      if (lastList.fb === key) return;
      lastList.fb = key;
      if (!items.length) {
        panel.innerHTML = '<div class="tn-empty">还没有收到反馈。</div>';
        return;
      }
      panel.innerHTML = items.map(x =>
        '<div class="tn-item">' +
          '<div class="tn-item-main">' +
            '<div class="tn-item-sub">' + esc(x.name || '匿名') +
              (x.contact ? ' · ' + esc(x.contact) : '') + ' · ' + fmtTime(x.at) + '</div>' +
            '<div class="tn-item-text">' + esc(x.text) + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
    }
  }

  async function refresh(body, opts) {
    try {
      const st = await api('/api/status');
      setState(body, st);
      if (opts && opts.list) {
        const [up, fb] = await Promise.all([
          api('/api/uploads').catch(() => ({ items: [] })),
          api('/api/feedback').catch(() => ({ items: [] }))
        ]);
        renderList(body, st, up, fb);
      } else if (st.counts) {
        // 计数变化时才拉列表，避免每 3 秒重建 DOM
        const changed = Number(body.dataset.upN || 0) !== Number(st.counts.uploads || 0) ||
          Number(body.dataset.fbN || 0) !== Number(st.counts.feedback || 0);
        if (changed) {
          body.dataset.upN = String(st.counts.uploads || 0);
          body.dataset.fbN = String(st.counts.feedback || 0);
          const [up, fb] = await Promise.all([
            api('/api/uploads').catch(() => ({ items: [] })),
            api('/api/feedback').catch(() => ({ items: [] }))
          ]);
          renderList(body, st, up, fb);
        }
      }
    } catch (e) {
      offline(body, e);
    }
  }

  async function withBusy(body, fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) {
      body.querySelector('#tnState').textContent = e.message || String(e);
      body.querySelector('#tnState').classList.add('bad');
    }
    busy = false;
  }

  function bind(body) {
    body.querySelector('#tnToggle').addEventListener('click', () => withBusy(body, async () => {
      const st = body._st;
      const on = st && st.tunnel && (st.tunnel.status === 'running' || st.tunnel.status === 'starting');
      await api(on ? '/api/tunnel/stop' : '/api/tunnel/start', { method: 'POST' });
      await new Promise(r => setTimeout(r, 400));
      await refresh(body, { list: true });
    }));

    body.querySelector('#tnCopy').addEventListener('click', async () => {
      const st = body._st;
      const url = shareUrl(st);
      if (!url) return;
      const ok = await copyText(url);
      const el = body.querySelector('#tnState');
      el.textContent = ok ? '链接已复制' : '复制失败，请手动选中地址';
      el.classList.toggle('bad', !ok);
      setTimeout(() => refresh(body), 1600);
    });

    body.querySelector('#tnOpen').addEventListener('click', () => {
      const url = shareUrl(body._st);
      if (url) window.open(url, '_blank');
    });

    body.querySelector('#tnRegen').addEventListener('click', () => withBusy(body, async () => {
      await api('/api/key/regen', { method: 'POST' });
      await refresh(body);
    }));

    body.querySelector('#tnSave').addEventListener('click', () => withBusy(body, async () => {
      await api('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyOn: body.querySelector('#tnKeyOn').checked,
          feedbackOn: body.querySelector('#tnFbOn').checked,
          maxMB: Number(body.querySelector('#tnMax').value) || 200,
          note: body.querySelector('#tnNote').value
        })
      });
      const el = body.querySelector('#tnState');
      el.textContent = '设置已保存';
      el.classList.remove('bad');
      setTimeout(() => refresh(body), 1400);
    }));

    body.querySelector('#tnReveal').addEventListener('click', () => {
      api('/api/reveal', { method: 'POST' }).catch(() => {});
    });

    body.querySelectorAll('.tn-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab;
        body.querySelectorAll('.tn-tab').forEach(b => b.classList.toggle('on', b === btn));
        lastList.up = '';
        lastList.fb = '';
        refresh(body, { list: true });
      });
    });
  }

  registerApp({
    id: 'tunnel',
    name: '分享与反馈',
    title: '分享与反馈',
    barTitle: '分享与反馈 · 免费内网穿透',
    sub: '把本机变成上传与反馈入口',
    icon: ICON,
    order: 62,
    css: ['apps/tunnel/app.css'],

    mount: function (body) {
      if (body.dataset.ready === '1') {
        refresh(body, { list: true });
        return;
      }
      body.innerHTML = BODY;
      bind(body);
      body.dataset.ready = '1';
      refresh(body, { list: true });
      if (!timer) {
        timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return;
          if (body.isConnected) refresh(body);
        }, 3000);
      }
    }
  });
})();

/* ---- apps/visionlab/body.js ---- */
/* visionlab 的窗口 DOM。app-scan 会自动排在 app.js 之前内联。 */
window.VL_BODY = '' +
'<div class="vl-wrap">' +
  '<div class="vl-bar">' +
    '<div class="vl-group">' +
      '<button type="button" class="vl-btn vl-primary" data-act="open">打开图片</button>' +
      '<input type="file" accept="image/*" data-ref="file" hidden>' +
      '<button type="button" class="vl-btn" data-act="extract">提取线稿</button>' +
      '<button type="button" class="vl-btn" data-act="only">只看重绘</button>' +
      '<button type="button" class="vl-btn" data-act="ckpt">控制点</button>' +
      '<button type="button" class="vl-btn" data-act="reset">重置</button>' +
    '</div>' +
    '<div class="vl-group">' +
      '<button type="button" class="vl-btn vl-ai" data-act="run">监督重绘</button>' +
      '<button type="button" class="vl-btn vl-danger" data-act="stop" disabled>停止</button>' +
    '</div>' +
    '<span class="vl-spacer"></span>' +
    '<span class="vl-status"><i class="vl-dot" data-ref="dot"></i><span class="vl-stat" data-ref="stat">未载入图像</span></span>' +
    '<button type="button" class="vl-btn vl-ghost" data-act="export">导出记录</button>' +
  '</div>' +
  '<div class="vl-main">' +
    '<div class="vl-stage" data-ref="stage">' +
      '<canvas class="vl-canvas" data-ref="canvas"></canvas>' +
      '<div class="vl-empty" data-ref="empty">' +
        '<div class="vl-empty-t">拖入图片 / 粘贴截图 / 点「打开图片」</div>' +
        '<div class="vl-empty-s">载入后拖出一个框选区，再点「提取线稿」。不框选就按整图处理。</div>' +
      '</div>' +
      '<div class="vl-hud">拖拽框选 · 不选则整图</div>' +
      '<div class="vl-legend" data-ref="legend"></div>' +
      '<div class="vl-param">' +
        '<span class="vl-param-t">提取</span>' +
        '<label>形态 ' +
          '<select data-ref="shape">' +
            '<option value="auto">自动</option>' +
            '<option value="contour">轮廓</option>' +
            '<option value="center">中线</option>' +
          '</select>' +
        '</label>' +
        '<label>取线 ' +
          '<select data-ref="src">' +
            '<option value="auto">自动</option>' +
            '<option value="edge">边缘</option>' +
            '<option value="dark">暗线</option>' +
            '<option value="color">色块</option>' +
          '</select>' +
        '</label>' +
        '<label>阈值 <input type="range" min="5" max="60" step="1" value="20" data-ref="threshold"><b data-ref="thresholdV">20</b></label>' +
        '<label>简化 <input type="range" min="0" max="3" step="0.1" value="0.5" data-ref="simplify"><b data-ref="simplifyV">0.5</b></label>' +
        '<label>最短段 <input type="range" min="0" max="60" step="1" value="8" data-ref="minLen"><b data-ref="minLenV">8</b></label>' +
        '<label class="vl-fill">填色 <input type="checkbox" data-ref="fill" checked></label>' +
      '</div>' +
    '</div>' +
    '<div class="vl-side">' +
      '<div class="vl-tabs">' +
        '<button type="button" class="vl-tab is-on" data-tab="parts">线稿<b data-ref="partsN">0</b></button>' +
        '<button type="button" class="vl-tab" data-tab="sup">监督</button>' +
        '<button type="button" class="vl-tab" data-tab="lab">实验</button>' +
      '</div>' +
      '<div class="vl-pane" data-pane="parts">' +
        '<div class="vl-layers" data-ref="layers" hidden></div>' +
        '<div class="vl-parts" data-ref="partsList"><div class="vl-none">还没有线段。先载入图片并提取线稿。</div></div>' +
      '</div>' +
      '<div class="vl-pane" data-pane="sup" hidden>' +
        '<div class="vl-sup-head">' +
          '<span class="vl-phase" data-ref="phase">待命</span>' +
          '<span class="vl-round" data-ref="round"></span>' +
        '</div>' +
        '<div class="vl-metrics" data-ref="metrics" hidden></div>' +
        '<div class="vl-sup" data-ref="sup"></div>' +
      '</div>' +
      '<div class="vl-pane" data-pane="lab" hidden>' +
        '<div class="vl-lab-h">改良方案</div>' +
        '<div class="vl-variants" data-ref="variants"></div>' +
        '<div class="vl-lab-h">运行记录</div>' +
        '<div class="vl-runs" data-ref="runs"><div class="vl-none">还没有记录。</div></div>' +
      '</div>' +
    '</div>' +
  '</div>' +
'</div>';

/* ---- apps/visionlab/app.js ---- */
/* 线稿重绘台（visionlab）
 *
 * 做的事：位图 → 中线折线 + 线宽（矢量化线稿） → DeepSeek 用工具重新描绘 → 回读指标验证。
 *
 * 只做线稿层，不做填充层。原因：
 *   位图里没有「线」，只有覆盖率。填充件是零宽区域边界，线稿是「中线 + 厚度」，
 *   两者几何对象不同，指标也不同，混在一个 IoU 里必然误判。
 *
 * 依赖既有共享模块：Tracer / Segmenter / toolLoopRun / llmStreamRequest / llmConn。
 * 模型只传 key 与样式，几何一律由程序从提取结果直接复制；创作入口除外，且限 16 个控制点。
 */
(function () {
  'use strict';

  var MAX_EXTRACT = 2048;    // 提取时最长边上限（轮廓模式直接按像素边界取，缩图就是丢精度）
  var MAX_CHECK = 1600;      // 回读栅格化上限
  var STORE_KEY = 'vl.lineRun.v1';

  var S = {
    img: null, imgName: '', w: 0, h: 0,
    region: null,
    strokes: [],          // {key,path,width,color,length,bbox,cx,cy,name,...}
    lexicon: {},
    ops: new Map(),
    view: { s: 1, ox: 0, oy: 0 }, zoomed: false,
    onlyDraw: false,
    ckpt: false,
    drag: null,
    opt: { shape: 'auto', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8, background: 238, tolerance: 26, fill: true },
    lastMode: '', autoStats: null, srcStats: null,
    groups: [], drop: {},
    layers: [], hidden: {},
    activeKey: '',
    busy: false, ctrl: null, stub: false, stubMsgs: null, stubFirst: null,
    metrics: null, best: null, calls: [], runs: [], round: 0,
    customSeq: 0, variant: '', form: 'auto', ready: false, lastReview: ''
  };

  var R = {};
  var CV = null, CTX = null;
  var savedLLM = null;

  /* ---------------- 基础工具 ---------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function fmtK(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(Math.round(n));
    return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hexOf(rgb) {
    return '#' + rgb.map(function (v) {
      var h = clamp(Math.round(v), 0, 255).toString(16);
      return ('0' + h).slice(-2);
    }).join('');
  }
  function rgbOf(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [40, 40, 40];
  }
  /* 线稿颜色：把浅色区域的平均色直接画在白底上等于没画（浅蓝发丝、白纱都是这样）。
   * 亮度高于 150 就按比例压暗，保留色相；深色原样返回。 */
  function inkColor(hex) {
    var c = rgbOf(hex);
    var l = lum(c[0], c[1], c[2]);
    if (l > 150) {
      var k = 110 / l;
      c = c.map(function (v) { return Math.round(v * k); });
    }
    return hexOf(c);
  }
  function hueBucket(hex) {
    var c = rgbOf(hex), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.08) return 0;
    var h;
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return Math.floor(h * 12);
  }
  function lum(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[a.length >> 1];
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[clamp(Math.round((a.length - 1) * p), 0, a.length - 1)];
  }
  function bboxOfPath(path) {
    var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    path.forEach(function (p) {
      if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
      if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
    });
    return [mnx, mny, mxx, mxy];
  }
  function pathLength(path) {
    var L = 0;
    for (var i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    return L;
  }
  function distToSeg(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var wx = p[0] - a[0], wy = p[1] - a[1];
    var L2 = vx * vx + vy * vy;
    var t = L2 ? clamp((wx * vx + wy * vy) / L2, 0, 1) : 0;
    return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
  }

  /* ---------------- 画布 ---------------- */

  function resizeCanvas() {
    if (!CV || !R.stage) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, R.stage.clientWidth), h = Math.max(1, R.stage.clientHeight);
    CV.width = Math.round(w * dpr); CV.height = Math.round(h * dpr);
    CV.style.width = w + 'px'; CV.style.height = h + 'px';
    CTX.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.cw = w; S.ch = h;
  }

  function fitView() {
    if (!S.img) return;
    var pad = 26;
    var s = clamp(Math.min((S.cw - pad * 2) / S.w, (S.ch - pad * 2) / S.h), 0.05, 8);
    S.view.s = s;
    S.view.ox = (S.cw - S.w * s) / 2;
    S.view.oy = (S.ch - S.h * s) / 2;
    S.zoomed = false;
  }

  /* 窗口是可拖拽缩放的浮动面板，缩放时画布尺寸变了但视图没变，
   * 图会按旧比例被裁掉。重排后重新适配；用户自己滚轮缩放过就不打断他。 */
  function syncStage() {
    if (!R.stage || R.wrap.offsetParent === null) return;
    var w = R.stage.clientWidth, h = R.stage.clientHeight;
    if (w === S.cw && h === S.ch) return;
    resizeCanvas();
    if (!S.zoomed) fitView();
    drawScene();
  }

  function canvasPt(ev) {
    var r = CV.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  function toImg(cx, cy) { return [(cx - S.view.ox) / S.view.s, (cy - S.view.oy) / S.view.s]; }
  function toCanvas(ix, iy) { return [ix * S.view.s + S.view.ox, iy * S.view.s + S.view.oy]; }

  function opOf(key) { return S.ops.get(key) || null; }

  /* 线宽上限跟着区域尺寸走：37px 图标上给 4px 线，等于把画面涂掉。
   * 下限 1.2px 保证小图仍能看见，上限 16px 给大图留空间。 */
  function widthCap() {
    var r = S.region || { w: S.w, h: S.h };
    return clamp(Math.min(r.w || 1, r.h || 1) / 24, 1.2, 16);
  }
  function safeWidth(v, fallback) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) n = fallback;
    return clamp(n, 0.35, widthCap());
  }

  function sortedOps() {
    var list = [];
    S.strokes.forEach(function (p) {
      var op = opOf(p.key);
      /* drop = 明确判定为无意义碎块，不参与绘制，也不计入已描绘 */
      if (!op || S.drop[p.key]) return;
      list.push({ part: p, op: op });
    });
    list.sort(function (a, b) {
      var oa = a.op.order != null ? a.op.order : a.part.area;
      var ob = b.op.order != null ? b.op.order : b.part.area;
      return oa - ob;
    });
    return list;
  }

  /* 在指定变换下描一条线：几何用区域坐标，厚度用区域像素 */
  function strokeOne(g, p, op) {
    var bb = p.bbox;
    var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    g.save();
    g.translate(cx + (op.dx || 0), cy + (op.dy || 0));
    if (op.rot) g.rotate(op.rot);
    if (op.sc && op.sc !== 1) g.scale(op.sc, op.sc);
    g.translate(-cx, -cy);
    g.beginPath();
    var path = p.path;
    if (p.region) {
      if (!bezPath(g, p.bez)) curvePath(g, p.path, true);
      (p.holes || []).forEach(function (hp, i) {
        if (!bezPath(g, (p.holeBez || [])[i])) curvePath(g, hp, true);
      });
    } else {
      for (var i = 0; i < path.length; i++) {
        if (i === 0) g.moveTo(path[i][0], path[i][1]); else g.lineTo(path[i][0], path[i][1]);
      }
      if (p.closed) g.closePath();
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(0.35, (op.width != null ? op.width : p.width));
    g.strokeStyle = inkColor(op.color || p.color);
    g.stroke();
    g.restore();
  }

  /* 闭合轮廓默认填色：字是实心块，只描边等于画了个空心框。
   * 孔洞（A 的三角孔）按包含关系挂到外轮廓上，用 evenodd 挖掉。 */
  function pointInPoly(x, y, path) {
    var inside = false;
    for (var i = 0, j = path.length - 1; i < path.length; j = i++) {
      var xi = path[i][0], yi = path[i][1], xj = path[j][0], yj = path[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function addPath(g, path) {
    for (var i = 0; i < path.length; i++) {
      if (i === 0) g.moveTo(path[i][0], path[i][1]); else g.lineTo(path[i][0], path[i][1]);
    }
    g.closePath();
  }

  /* 向心 Catmull-Rom（alpha=0.5）。均匀参数化在锚点疏密不均时会打结、鼓包——
   * 抽稀出来的锚点正好疏密不均（直段一个点、弯处连着一串），所以必须用向心参数化，
   * 否则曲线会「甩出去」再绕回来，看起来就是扭曲。 */
  function crPoint(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; }

  function catmullRomCentripetal(points, closed, steps) {
    var pts = [];
    for (var i = 0; i < points.length; i++) {
      var q = points[i], last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q);
    }
    if (pts.length < 3) return pts;
    var seq = closed === false
      ? [pts[0]].concat(pts, [pts[pts.length - 1]])
      : [pts[pts.length - 1]].concat(pts, [pts[0], pts[1]]);
    var out = [];
    for (var j = 0; j < seq.length - 3; j++) {
      var p0 = seq[j], p1 = seq[j + 1], p2 = seq[j + 2], p3 = seq[j + 3];
      var t0 = 0;
      var t1 = t0 + Math.max(1e-4, Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])));
      var t2 = t1 + Math.max(1e-4, Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
      var t3 = t2 + Math.max(1e-4, Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])));
      for (var s = 0; s < steps; s++) {
        var t = t1 + (t2 - t1) * (s / steps);
        var A1 = crPoint(p0, p1, (t - t0) / (t1 - t0));
        var A2 = crPoint(p1, p2, (t - t1) / (t2 - t1));
        var A3 = crPoint(p2, p3, (t - t2) / (t3 - t2));
        var B1 = crPoint(A1, A2, (t - t0) / (t2 - t0));
        var B2 = crPoint(A2, A3, (t - t1) / (t3 - t1));
        out.push(crPoint(B1, B2, (t - t1) / (t2 - t1)));
      }
    }
    return out;
  }

  /* 闭合区域的落笔口径：锚点是控制点，用 Catmull-Rom 采样成曲线再描。
   * 直接 lineTo 会把 1px 台阶放大成一圈折线，再填色就是「像素图」的观感；
   * 采样后控制点仍只有十几个，可单独拖动，形状是曲线而不是多边形。 */
  function curvePath(g, path, closed) {
    if (!path || path.length < 3) { if (path && path.length) addPath(g, path); return; }
    var pts = catmullRomCentripetal(path, closed !== false, 8);
    for (var i = 0; i < pts.length; i++) {
      if (i === 0) g.moveTo(pts[i][0], pts[i][1]); else g.lineTo(pts[i][0], pts[i][1]);
    }
    if (closed !== false) g.closePath();
  }

  function fillGroups(list) {
    var items = list.map(function (it) {
      var bb = it.part.bbox;
      return { it: it, bb: bb, area: Math.max(1, (bb[2] - bb[0]) * (bb[3] - bb[1])), parent: null };
    });
    items.forEach(function (a) {
      var best = null;
      items.forEach(function (b) {
        if (a === b || b.area <= a.area) return;
        if (a.bb[0] < b.bb[0] || a.bb[1] < b.bb[1] || a.bb[2] > b.bb[2] || a.bb[3] > b.bb[3]) return;
        var p0 = a.it.part.path[0];
        if (!p0 || !pointInPoly(p0[0], p0[1], b.it.part.path)) return;
        if (!best || b.area < best.area) best = b;
      });
      a.parent = best;
    });
    var roots = items.filter(function (a) { return !a.parent; }).map(function (a) {
      return { outer: a.it, holes: [] };
    });
    items.forEach(function (a) {
      if (!a.parent) return;
      var root = a.parent, guard = 0;
      while (root.parent && guard++ < 8) root = root.parent;
      var g = roots.filter(function (r) { return r.outer === root.it; })[0];
      if (g) g.holes.push(a.it);
    });
    return roots;
  }

  function fillOne(g, grp) {
    var p = grp.outer.part, op = grp.outer.op;
    var bb = p.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    g.save();
    g.translate(cx + (op.dx || 0), cy + (op.dy || 0));
    if (op.rot) g.rotate(op.rot);
    if (op.sc && op.sc !== 1) g.scale(op.sc, op.sc);
    g.translate(-cx, -cy);
    g.beginPath();
    addPath(g, p.path);
    grp.holes.forEach(function (h) { addPath(g, h.part.path); });
    g.fillStyle = inkColor(op.color || p.color);
    g.fill('evenodd');
    g.restore();
  }

  /* 色块：外轮廓 + 孔洞一次 evenodd 填完，颜色用区域原色（不压暗）。
   * 边界走曲线：色块锚点本来就少，用折线填出来是一圈多边形，看着像像素图。
   * 多色图靠「面积从大到小逐块盖上去」还原层次：大块打底，小块（嘴、脚、眼）后盖。 */
  function fillRegion(g, p, op) {
    var bb = p.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    g.save();
    g.translate(cx + (op.dx || 0), cy + (op.dy || 0));
    if (op.rot) g.rotate(op.rot);
    if (op.sc && op.sc !== 1) g.scale(op.sc, op.sc);
    g.translate(-cx, -cy);
    g.beginPath();
    if (!bezPath(g, p.bez)) curvePath(g, p.path, true);
    (p.holes || []).forEach(function (hp, i) {
      if (!bezPath(g, (p.holeBez || [])[i])) curvePath(g, hp, true);
    });
    g.fillStyle = op.color || p.color;
    g.fill('evenodd');
    g.restore();
  }

  /* 语义分组：同一部位的碎块（围巾本体 + 阴影、眼白 + 瞳孔）并成一组。
   * 关键约束：只有「套在别的块里面」的成员才当孔洞挖掉，同级并列的成员各自填。
   * 之前把所有非最大成员都当孔洞，两只脚并成一组时右脚会整块消失——
   * 那不是「并部位」，是「吞掉部位」。 */
  function groupedParts(list) {
    var byKey = {}, used = {}, out = [];
    list.forEach(function (it) { if (it.part.region) byKey[it.part.key] = it; });

    S.groups.forEach(function (grp) {
      var members = (grp.keys || []).map(function (k) { return byKey[k]; }).filter(Boolean);
      if (!members.length) return;
      members.forEach(function (m) { used[m.part.key] = 1; });
      members.sort(function (a, b) { return (b.part.area || 0) - (a.part.area || 0); });

      /* 谁是孔：first point 落在另一个更大的成员环内 */
      var parent = {};
      members.forEach(function (m) {
        var p0 = m.part.path[0], best = null;
        if (!p0) return;
        members.forEach(function (o) {
          if (o === m || (o.part.area || 0) <= (m.part.area || 0)) return;
          if (!pointInPoly(p0[0], p0[1], o.part.path)) return;
          if (!best || (o.part.area || 0) < (best.part.area || 0)) best = o;
        });
        parent[m.part.key] = best;
      });

      members.forEach(function (m) {
        if (parent[m.part.key]) return;
        var holes = (m.part.holes || []).slice();
        var holeBez = (m.part.holeBez || []).slice();
        members.forEach(function (c) {
          if (parent[c.part.key] === m) { holes.push(c.part.path); holeBez.push(c.part.bez); }
        });
        out.push({
          area: m.part.area || 0,
          part: {
            path: m.part.path, holes: holes, bbox: m.part.bbox,
            bez: m.part.bez, holeBez: holeBez, tol: m.part.tol,
            color: grp.color || m.part.color
          },
          op: grp.color ? Object.assign({}, m.op, { color: grp.color }) : m.op
        });
      });
    });
    list.forEach(function (it) {
      if (!it.part.region || used[it.part.key]) return;
      out.push({ area: it.part.area || 0, part: it.part, op: it.op });
    });
    return out;
  }

  /* 色块 → 先按语义组填，再补未分组块，最后按面积降序；线仍走原分支 */
  function paintOps(g, list) {
    var hid = {};
    S.layers.forEach(function (l) {
      if (!S.hidden[l.id]) return;
      l.keys.forEach(function (k) { hid[k] = 1; });
    });
    var live = list.filter(function (it) { return !S.drop[it.part.key] && !hid[it.part.key]; });
    var regs = [], strokes = [], fills = [];
    live.forEach(function (it) {
      if (it.part.region) regs.push(it);
      else if (S.opt.fill && it.part.closed && it.part.path.length > 2) fills.push(it);
      else strokes.push(it);
    });
    if (regs.length) {
      groupedParts(live).sort(function (a, b) { return b.area - a.area; })
        .forEach(function (x) { fillRegion(g, x.part, x.op); });
    }
    if (fills.length) fillGroups(fills).forEach(function (grp) { fillOne(g, grp); });
    strokes.forEach(function (it) { strokeOne(g, it.part, it.op); });
  }

  function drawScene() {
    if (!CTX) return;
    CTX.clearRect(0, 0, S.cw, S.ch);
    if (!S.img) return;
    if (S.onlyDraw) {
      /* 只看重绘：遮掉原图，用来判断「单独看还认不认得出」。
       * 色块模式里有白色部件（白肚、白底板），纯白底会把它们吃掉，改用浅灰。 */
      CTX.fillStyle = S.lastMode === 'color' ? '#eef1f5' : '#ffffff';
      CTX.fillRect(0, 0, S.cw, S.ch);
    } else {
      CTX.save();
      CTX.translate(S.view.ox, S.view.oy);
      CTX.scale(S.view.s, S.view.s);
      CTX.imageSmoothingQuality = 'high';
      CTX.drawImage(S.img, 0, 0, S.w, S.h);
      CTX.restore();
    }

    if (S.region && !S.onlyDraw) {
      var a = toCanvas(S.region.x, S.region.y);
      var b = toCanvas(S.region.x + S.region.w, S.region.y + S.region.h);
      CTX.save();
      CTX.setLineDash([5, 4]);
      CTX.lineWidth = 1.4;
      CTX.strokeStyle = '#5b8fd9';
      CTX.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      CTX.restore();
    }

    /* 参考层：还没被描绘的线，淡虚线。
     * 它只是对照——画布上的实线只能来自模型调用 vl_draw_parts，
     * 提取完就自动全量画上去等于「程序画的」，看不出模型到底画了什么。 */
    if (S.strokes.length) {
      CTX.save();
      CTX.translate(S.view.ox, S.view.oy);
      CTX.scale(S.view.s, S.view.s);
      var unit = 1 / S.view.s;
      CTX.setLineDash([3 * unit, 3 * unit]);
      CTX.lineWidth = unit;
      CTX.lineCap = 'round';
      CTX.strokeStyle = 'rgba(120,138,162,.5)';
      S.strokes.forEach(function (p) {
        if (S.ops.has(p.key)) return;
        var path = p.path;
        CTX.beginPath();
        if (p.region) { curvePath(CTX, path, true); }
        else {
          for (var i = 0; i < path.length; i++) {
            if (i === 0) CTX.moveTo(path[i][0], path[i][1]); else CTX.lineTo(path[i][0], path[i][1]);
          }
          if (p.closed) CTX.closePath();
        }
        CTX.stroke();
      });
      CTX.restore();
    }

    CTX.save();
    CTX.translate(S.view.ox, S.view.oy);
    CTX.scale(S.view.s, S.view.s);
    paintOps(CTX, sortedOps());
    CTX.restore();

    if (!S.onlyDraw) drawLabels();
    if (S.ckpt) drawAnchors();

    if (S.drag && S.drag.rect) {
      var d = S.drag.rect;
      var p1 = toCanvas(d.x, d.y), p2 = toCanvas(d.x + d.w, d.y + d.h);
      CTX.save();
      CTX.fillStyle = 'rgba(91,143,217,.12)';
      CTX.fillRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
      CTX.setLineDash([4, 3]);
      CTX.strokeStyle = '#5b8fd9';
      CTX.lineWidth = 1.2;
      CTX.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
      CTX.restore();
    }
  }

  function drawLabels() {
    if (S.view.s < 0.35) return;
    CTX.save();
    CTX.font = '11px ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif';
    CTX.textBaseline = 'middle';
    S.strokes.forEach(function (p) {
      if (!opOf(p.key)) return;
      var bb = p.bbox;
      var c = toCanvas((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
      var name = partName(p);
      var tw = CTX.measureText(name).width + 8;
      CTX.globalAlpha = 0.9;
      CTX.fillStyle = p.key === S.activeKey ? '#5b8fd9' : 'rgba(255,255,255,.88)';
      CTX.fillRect(c[0] - tw / 2, c[1] - 8, tw, 16);
      CTX.strokeStyle = 'rgba(91,143,217,.35)';
      CTX.lineWidth = 1;
      CTX.strokeRect(c[0] - tw / 2, c[1] - 8, tw, 16);
      CTX.fillStyle = p.key === S.activeKey ? '#fff' : '#3a4653';
      CTX.fillText(name, c[0] - tw / 2 + 4, c[1] + 0.5);
    });
    CTX.restore();
  }

  /* 控制点模式：把每个部位的锚点画出来，选中的部位实心、其余半透明。
   * 锚点就是曲线要穿过的点，拖动即改形状；控制点数量由提取时的抽稀口径决定。 */
  function drawAnchors() {
    if (S.view.s < 0.2) return;
    CTX.save();
    S.strokes.forEach(function (p) {
      var hot = !S.activeKey || p.key === S.activeKey;
      CTX.fillStyle = hot ? 'rgba(91,143,217,.95)' : 'rgba(91,143,217,.35)';
      CTX.strokeStyle = '#fff';
      CTX.lineWidth = 1;
      p.path.forEach(function (q) {
        var c = toCanvas(q[0], q[1]);
        CTX.beginPath();
        CTX.arc(c[0], c[1], hot ? 3.2 : 2.2, 0, Math.PI * 2);
        CTX.fill();
        if (hot) CTX.stroke();
      });
    });
    CTX.restore();
  }

  /* 抓最近的控制点（屏幕 10px 以内），选中的部位优先 */
  function nearestAnchor(ip) {
    var best = null, bestD = Math.pow(10 / Math.max(0.01, S.view.s), 2);
    S.strokes.forEach(function (p) {
      var bonus = (!S.activeKey || p.key === S.activeKey) ? 1 : 0.6;
      p.path.forEach(function (q, i) {
        var d = (Math.pow(q[0] - ip[0], 2) + Math.pow(q[1] - ip[1], 2)) * bonus;
        if (d <= bestD) { bestD = d; best = { key: p.key, idx: i }; }
      });
    });
    return best;
  }

  /* ---------------- 图像 ---------------- */

  function setImage(img, name) {
    S.img = img; S.imgName = name || 'image';
    S.w = img.naturalWidth || img.width;
    S.h = img.naturalHeight || img.height;
    S.region = null; S.strokes = []; S.ops = new Map(); S.metrics = null; S.best = null;
    /* 语义分组属于上一张图，换图必须清掉，否则旧 key 会串到新图 */
    S.groups = []; S.drop = {};
    S.activeKey = ''; S.lexicon = {};
    if (R.empty) R.empty.hidden = true;
    resizeCanvas(); fitView(); drawScene();
    renderParts(); updateStat();
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type || '')) return Promise.reject(new Error('不是图片文件'));
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); setImage(img, file.name); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  /* 演示图：粗体文字 + 一条细线。文字用来验证「轮廓模式能不能一笔认出字」，
   * 细线用来验证「中线模式」还活着。 */
  function loadDemo() {
    return new Promise(function (res) {
      var c = document.createElement('canvas');
      c.width = 480; c.height = 360;
      var g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 480, 360);
      g.fillStyle = '#1f2630';
      g.font = 'bold 150px "Microsoft YaHei","PingFang SC",sans-serif';
      g.textBaseline = 'alphabetic';
      g.fillText('字 A', 30, 220);
      g.strokeStyle = '#cb2129'; g.lineWidth = 4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(40, 300); g.lineTo(430, 300); g.stroke();
      var img = new Image();
      img.onload = function () { setImage(img, 'demo'); res(true); };
      img.src = c.toDataURL('image/png');
    });
  }

  function cropData(rect, maxSide) {
    var m = Math.max(1, Math.max(rect.w, rect.h));
    var scale = Math.min(1, maxSide / m);
    var w = Math.max(2, Math.round(rect.w * scale));
    var h = Math.max(2, Math.round(rect.h * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    /* 必须先铺白底：透明像素的 RGB 是 0,0,0，直接读会被当成墨，
     * 图标外围的透明区域就变成一整圈「黑边」，里面反而成了孔。 */
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.drawImage(S.img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    return { data: g.getImageData(0, 0, w, h), scale: scale, w: w, h: h };
  }

  /* 把框选区域缩成一张小图给模型看。
   * 矢量只说明「哪里有墨水」，认不出「这是企鹅」；语义必须回到位图。
   * 尺寸压到 768 以内，JPEG 0.82，避免把几 MB 的截图塞进上下文。 */
  function regionImageURL(maxSide) {
    if (!S.img) return '';
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var m = Math.max(1, Math.max(r.w, r.h));
    var scale = Math.min((maxSide || 768) / m, Math.max(1, 512 / m));
    var w = Math.max(2, Math.round(r.w * scale));
    var h = Math.max(2, Math.round(r.h * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(S.img, r.x, r.y, r.w, r.h, 0, 0, w, h);
    try { return c.toDataURL('image/jpeg', 0.82); } catch (e) { return ''; }
  }

  /* ---------------- 取线：暗线 / 边缘 / 自动 ---------------- */

  function darkThreshold(v) {
    /* 滑杆 5..60 在暗线模式映射成 40..200 的亮度阈值 */
    return clamp(Math.round(60 + (v - 20) * 2), 40, 200);
  }

  function buildLineMask(data, w, h, src, threshold) {
    var seg = Segmenter.segment(data, {
      mode: 'light', background: S.opt.background, tolerance: S.opt.tolerance,
      barrier: 'edge', lineThreshold: 0
    });
    var fg = seg.fg.mask;
    var wall = seg.wall;

    function darkMask(th) {
      var m = new Uint8Array(w * h), d = data.data;
      for (var i = 0; i < w * h; i++) {
        if (!fg[i]) continue;
        if (lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < th) m[i] = 1;
      }
      return m;
    }
    function edgeMask() {
      var m = new Uint8Array(w * h);
      for (var i = 0; i < w * h; i++) if (fg[i] && wall[i]) m[i] = 1;
      return m;
    }

    var mode = src;
    if (mode === 'auto') {
      /* 判据：暗像素面积 vs 边界像素面积。
       * 线稿 / 黑块：暗面本身就是主体，暗像素 ≥ 边界；柔边彩图：暗像素只剩零星深色
       * （眼睛、发丝），真正的结构全在色块边界上。用厚度判据会把人像判成 dark，
       * 实测只提出 31 条碎线，画出来是空白；改成面积比后判 edge，提出 109 条完整轮廓。 */
      var dm = darkMask(darkThreshold(threshold));
      var em = edgeMask();
      var dn = 0, en = 0;
      for (var i = 0; i < w * h; i++) { if (dm[i]) dn++; if (em[i]) en++; }
      mode = (dn > 0 && dn >= en * 0.5) ? 'dark' : 'edge';
      S.srcStats = { dark: dn, edge: en, ratio: en ? round2(dn / en) : 0, mode: mode };
    }
    var mask = mode === 'dark' ? darkMask(darkThreshold(threshold)) : edgeMask();
    return { mask: mask, mode: mode, seg: seg };
  }

  function distTransform(mask, w, h) {
    var INF = 1e9;
    var d = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
    var D1 = 1, D2 = Math.SQRT2;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (d[k] === 0) continue;
        var best = d[k];
        if (x > 0) best = Math.min(best, d[k - 1] + D1);
        if (y > 0) {
          best = Math.min(best, d[k - w] + D1);
          if (x > 0) best = Math.min(best, d[k - w - 1] + D2);
          if (x < w - 1) best = Math.min(best, d[k - w + 1] + D2);
        }
        d[k] = best;
      }
    }
    for (var y2 = h - 1; y2 >= 0; y2--) {
      for (var x2 = w - 1; x2 >= 0; x2--) {
        var k2 = y2 * w + x2;
        if (d[k2] === 0) continue;
        var b2 = d[k2];
        if (x2 < w - 1) b2 = Math.min(b2, d[k2 + 1] + D1);
        if (y2 < h - 1) {
          b2 = Math.min(b2, d[k2 + w] + D1);
          if (x2 < w - 1) b2 = Math.min(b2, d[k2 + w + 1] + D2);
          if (x2 > 0) b2 = Math.min(b2, d[k2 + w - 1] + D2);
        }
        d[k2] = b2;
      }
    }
    return d;
  }

  /* Zhang-Suen 细化：把「线带」压成 1px 中线 */
  function thin(src, w, h) {
    var img = src.slice();
    var changed = true, guard = 0;
    function nb(x, y) {
      var i = y * w + x;
      return [
        img[i - w], img[i - w + 1], img[i + 1], img[i + w + 1],
        img[i + w], img[i + w - 1], img[i - 1], img[i - w - 1]
      ];
    }
    while (changed && guard++ < 80) {
      changed = false;
      for (var step = 0; step < 2; step++) {
        var del = [];
        for (var y = 1; y < h - 1; y++) {
          for (var x = 1; x < w - 1; x++) {
            var i = y * w + x;
            if (!img[i]) continue;
            var p = nb(x, y);
            var B = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
            if (B < 2 || B > 6) continue;
            var A = 0;
            for (var t = 0; t < 8; t++) if (!p[t] && p[(t + 1) % 8]) A++;
            if (A !== 1) continue;
            if (step === 0) {
              if (p[0] * p[2] * p[4] !== 0) continue;
              if (p[2] * p[4] * p[6] !== 0) continue;
            } else {
              if (p[0] * p[2] * p[6] !== 0) continue;
              if (p[0] * p[4] * p[6] !== 0) continue;
            }
            del.push(i);
          }
        }
        if (del.length) { changed = true; del.forEach(function (i) { img[i] = 0; }); }
      }
    }
    return img;
  }

  function neighborsOf(i, w, h, arr) {
    var x = i % w, y = (i / w) | 0, out = [];
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var j = yy * w + xx;
        if (arr[j]) out.push(j);
      }
    }
    return out;
  }

  function traceSkeleton(skel, w, h) {
    var used = new Uint8Array(w * h);
    var lines = [];

    function degOf(i) { return neighborsOf(i, w, h, skel).length; }

    function walk(start) {
      var pts = [[start % w, (start / w) | 0]];
      used[start] = 1;
      var cur = start, prev = -1;
      for (var guard = 0; guard < w * h; guard++) {
        var cands = neighborsOf(cur, w, h, skel).filter(function (j) { return !used[j]; });
        if (!cands.length) break;
        var pick = cands[0];
        if (cands.length > 1 && prev >= 0) {
          var px = prev % w, py = (prev / w) | 0;
          var cx = cur % w, cy = (cur / w) | 0;
          var vx = cx - px, vy = cy - py;
          var bestDot = -1e9;
          cands.forEach(function (j) {
            var jx = j % w, jy = (j / w) | 0;
            var wx = jx - cx, wy = jy - cy;
            var dot = vx * wx + vy * wy;
            if (dot > bestDot) { bestDot = dot; pick = j; }
          });
        }
        used[pick] = 1;
        pts.push([pick % w, (pick / w) | 0]);
        prev = cur; cur = pick;
        if (degOf(cur) >= 3 && pts.length > 2) break;
      }
      return pts;
    }

    var i;
    for (i = 0; i < w * h; i++) if (skel[i] && degOf(i) === 1) lines.push(walk(i));
    for (i = 0; i < w * h; i++) if (skel[i] && !used[i]) lines.push(walk(i));
    return lines;
  }

  function rdp(points, eps) {
    if (points.length < 3) return points;
    var first = points[0], last = points[points.length - 1];
    var maxD = -1, idx = -1;
    for (var i = 1; i < points.length - 1; i++) {
      var d = distToSeg(points[i], first, last);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
      var left = rdp(points.slice(0, idx + 1), eps);
      var right = rdp(points.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  /* ---------------- 轮廓：闭合环 ---------------- */

  /* 沿前景掩膜的像素边界（crack boundary）追闭合环：每个字形一圈，天生完整。
   * 中线（骨架）在交叉处必须断开，文字会碎成一堆短段；轮廓没有这个问题。
   * 边按「前景在右手边」定向；一个点上出现多条边（对角相接）时优先右转，
   * 这样两个只在对角碰到的字形不会被缝成一个。 */
  function traceContours(mask, w, h) {
    var edges = [];
    var starts = new Map();
    function at(x, y) { return (x >= 0 && y >= 0 && x < w && y < h) ? mask[y * w + x] : 0; }
    function addEdge(x1, y1, x2, y2) {
      var i = edges.length;
      edges.push({ a: [x1, y1], b: [x2, y2], used: false });
      var k = x1 + ',' + y1;
      var list = starts.get(k);
      if (!list) { list = []; starts.set(k, list); }
      list.push(i);
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (!at(x, y - 1)) addEdge(x, y, x + 1, y);
        if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
        if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
        if (!at(x - 1, y)) addEdge(x, y + 1, x, y);
      }
    }

    var loops = [];
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].used) continue;
      var loop = [];
      var e = edges[i];
      for (var guard = 0; e && !e.used && guard <= edges.length; guard++) {
        e.used = true;
        loop.push(e.a);
        var dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
        var nextList = starts.get(e.b[0] + ',' + e.b[1]) || [];
        var pick = -1;
        if (nextList.length === 1) {
          if (!edges[nextList[0]].used) pick = nextList[0];
        } else {
          var best = -1e9;
          nextList.forEach(function (j) {
            if (edges[j].used) return;
            var ex = edges[j].b[0] - edges[j].a[0], ey = edges[j].b[1] - edges[j].a[1];
            /* 屏幕坐标 y 向下：cross > 0 是顺时针（右转） */
            var score = (dx * ey - dy * ex) * 2 + (dx * ex + dy * ey);
            if (score > best) { best = score; pick = j; }
          });
        }
        e = pick >= 0 ? edges[pick] : null;
      }
      if (loop.length >= 4) loops.push(loop);
    }
    return loops;
  }

  /* Chaikin 角切：每轮把每条边切成 1/4、3/4 两点，闭环不做端点补齐。
   * 用来消掉小图轮廓上的 1px 像素台阶。 */
  function chaikin(pts, iters) {
    var list = pts.slice();
    for (var k = 0; k < iters; k++) {
      var n = list.length;
      if (n < 3) return list;
      var out = [];
      for (var i = 0; i < n; i++) {
        var a = list[i], b = list[(i + 1) % n];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      list = out;
    }
    return list;
  }

  function rdpClosed(loop, eps) {
    if (loop.length < 3) return loop.slice();
    /* 闭环不能从同一个点起收：先找离起点最远的点，从它切成两段各自抽稀，
       否则起点附近的转角不会被判定为「偏离」。 */
    var far = 0, best = -1;
    for (var i = 1; i < loop.length; i++) {
      var d = Math.pow(loop[i][0] - loop[0][0], 2) + Math.pow(loop[i][1] - loop[0][1], 2);
      if (d > best) { best = d; far = i; }
    }
    var a = rdp(loop.slice(0, far + 1), eps);
    var b = rdp(loop.slice(far).concat([loop[0]]), eps);
    return a.concat(b.slice(1, b.length - 1));
  }

  /* ---- 三次贝塞尔拟合（不是插值） ----
   * 像素边界直接上 Catmull-Rom，控制点全落在台阶拐角上，画出来是一圈波浪。
   * 这里用最小二乘拟合：每段在容差内贴合点集，台阶会被平均成直线 / 弧，
   * 只有误差超限才二分。输出是真正的三次贝塞尔段（c1 / c2），落笔用 bezierCurveTo。 */
  function bezAt(p0, c1, c2, p3, t) {
    var mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
      a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
  }

  function lineSeg(p0, p3) {
    return [p0, [p0[0] + (p3[0] - p0[0]) / 3, p0[1] + (p3[1] - p0[1]) / 3],
      [p0[0] + (p3[0] - p0[0]) * 2 / 3, p0[1] + (p3[1] - p0[1]) * 2 / 3], p3];
  }

  function fitRun(pts, tol, out, depth) {
    var n = pts.length;
    if (n < 2) return;
    var p0 = pts[0], p3 = pts[n - 1];
    var chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    /* 闭环首尾是同一点，弦长为 0。直接出直线会得到一条退化曲线（整块消失），
     * 必须在中点切成两段再各自拟合。 */
    if (chord < 1e-6) {
      if (n > 3) {
        var mid = Math.floor((n - 1) / 2);
        fitRun(pts.slice(0, mid + 1), tol, out, depth + 1);
        fitRun(pts.slice(mid), tol, out, depth + 1);
      }
      return;
    }
    if (n === 2) { out.push(lineSeg(p0, p3)); return; }

    var u = new Array(n), i;
    u[0] = 0;
    for (i = 1; i < n; i++) u[i] = u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    var total = u[n - 1] || 1;
    for (i = 0; i < n; i++) u[i] /= total;

    var t1 = [pts[1][0] - p0[0], pts[1][1] - p0[1]];
    var t2 = [pts[n - 2][0] - p3[0], pts[n - 2][1] - p3[1]];
    var l1 = Math.hypot(t1[0], t1[1]), l2 = Math.hypot(t2[0], t2[1]);
    if (!l1 || !l2) { out.push(lineSeg(p0, p3)); return; }
    t1 = [t1[0] / l1, t1[1] / l1];
    t2 = [t2[0] / l2, t2[1] / l2];

    var c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    var dot12 = t1[0] * t2[0] + t1[1] * t2[1];
    for (i = 0; i < n; i++) {
      var t = u[i], mt = 1 - t;
      var b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      c00 += b1 * b1; c01 += b1 * b2 * dot12; c11 += b2 * b2;
      var bx = p0[0] * (b0 + b1) + p3[0] * (b2 + b3);
      var by = p0[1] * (b0 + b1) + p3[1] * (b2 + b3);
      var dx = pts[i][0] - bx, dy = pts[i][1] - by;
      x0 += b1 * (t1[0] * dx + t1[1] * dy);
      x1 += b2 * (t2[0] * dx + t2[1] * dy);
    }
    var det = c00 * c11 - c01 * c01;
    var a1 = det ? (x0 * c11 - x1 * c01) / det : chord / 3;
    var a2 = det ? (c00 * x1 - c01 * x0) / det : chord / 3;
    /* 解出负手柄 = 这段本来就不该是一条单弧（尖角 / S 弯），退回直线再靠二分 */
    if (!isFinite(a1) || !isFinite(a2) || a1 < 0 || a2 < 0) { a1 = chord / 3; a2 = chord / 3; }
    var c1 = [p0[0] + t1[0] * a1, p0[1] + t1[1] * a1];
    var c2 = [p3[0] + t2[0] * a2, p3[1] + t2[1] * a2];

    var worst = 0, at = -1;
    for (i = 0; i < n; i++) {
      var q = bezAt(p0, c1, c2, p3, u[i]);
      var dd = (q[0] - pts[i][0]) * (q[0] - pts[i][0]) + (q[1] - pts[i][1]) * (q[1] - pts[i][1]);
      if (dd > worst) { worst = dd; at = i; }
    }
    if (worst <= tol * tol || depth >= 14 || at <= 0 || at >= n - 1) {
      out.push([p0, c1, c2, p3]);
      return;
    }
    fitRun(pts.slice(0, at + 1), tol, out, depth + 1);
    fitRun(pts.slice(at), tol, out, depth + 1);
  }

  /* 闭环 → 贝塞尔段：把首点再补一次当作收尾，接缝处按同一方向拟合，不会多一个折角。 */
  function bezTurn(a, b, c) {
    var v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
    var l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (!l1 || !l2) return 0;
    return Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * 180 / Math.PI;
  }

  function fitBezLoop(points, tol) {
    var pts = [];
    for (var i = 0; i < points.length; i++) {
      var q = points[i], last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q);
    }
    if (pts.length < 3) return [];
    /* 闭环必然在某处接缝。把起点挪到拐角最大的点，接缝落在角上，
     * 就不会在平滑段中间多出一个折痕。 */
    var n = pts.length, bi = 0, ba = -1;
    for (i = 0; i < n; i++) {
      var ang = bezTurn(pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
      if (ang > ba) { ba = ang; bi = i; }
    }
    if (bi > 0) pts = pts.slice(bi).concat(pts.slice(0, bi));
    var out = [];
    fitRun(pts.concat([[pts[0][0], pts[0][1]]]), Math.max(0.3, tol), out, 0);
    return out;
  }

  function bezPath(g, segs) {
    if (!segs || !segs.length) return false;
    g.moveTo(segs[0][0][0], segs[0][0][1]);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      g.bezierCurveTo(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
    }
    g.closePath();
    return true;
  }

  /* 前景掩膜的边界像素（至少一个 4 邻域在掩膜外）。轮廓模式的回读参照系。 */
  function boundaryMask(mask, w, h) {
    var b = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (!mask[k]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            !mask[k - 1] || !mask[k + 1] || !mask[k - w] || !mask[k + w]) b[k] = 1;
      }
    }
    return b;
  }

  /* 一圈轮廓的颜色 = 这圈包围盒里掩膜像素的均色（内孔环落在笔画环上，取到的仍是笔画色） */
  function loopColor(loop, mask, data, w, h) {
    var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    loop.forEach(function (p) {
      if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
      if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
    });
    var r = 0, g = 0, b = 0, n = 0;
    for (var y = Math.max(0, mny); y < Math.min(h, mxy); y++) {
      for (var x = Math.max(0, mnx); x < Math.min(w, mxx); x++) {
        var k = y * w + x;
        if (!mask[k]) continue;
        r += data[k * 4]; g += data[k * 4 + 1]; b += data[k * 4 + 2]; n++;
      }
    }
    if (!n) return '#2b3440';
    return hexOf([r / n, g / n, b / n]);
  }

  function contourStrokes(mask, w, h, inv, data, o) {
    var loops = traceContours(mask, w, h);
    var out = [];
    loops.forEach(function (loop) {
      if (loop.length < 4) return;
      /* 小图的原生边界是 1px 台阶，直接画在放大视图里就是一根根方角黑条。
       * Chaikin 两轮把台阶磨成连续曲线，再抽稀，形状偏差 <0.5px。 */
      var pts = rdpClosed(chaikin(loop, 2), o.simplify);
      if (pts.length < 3) return;
      var len = 0;
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length];
        len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      if (len * inv < o.minLen) return;
      var path = pts.map(function (p) { return [p[0] * inv, p[1] * inv]; });
      out.push({
        path: path,
        width: Math.max(0.8, inv),
        color: loopColor(loop, mask, data, w, h),
        length: len * inv,
        anchors: path.length,
        closed: true,
        bbox: bboxOfPath(path)
      });
    });
    out.sort(function (a, b) { return b.length - a.length; });
    return out;
  }

  /* ---------------- 色块：多色区域逐块取轮廓 ---------------- */

  /* 多色图不能按「暗不暗」取线：深色底会把整块画布判成前景，红色 / 黄色这类亮部件
   * 又不在暗掩膜里，最后只剩黑白反相。这里直接用平面分件的结果，
   * 每个色块取自己的闭合环，填色用区域原色。 */

  /* 背景 = 贴着画布边、面积够大、颜色与主背景接近的块。背景不填充，
   * 否则四周一圈会被涂成实心，图看起来像被框住。 */
  function bgLabels(seg, st, w, h) {
    var edge = new Set();
    function push(x, y) { var L = seg.labels[y * w + x]; if (L) edge.add(L); }
    for (var x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (var y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

    var bg = new Set(), best = 0;
    edge.forEach(function (L) { if (st.area[L] > best) best = st.area[L]; });
    if (best < w * h * 0.12) return bg;   /* 边缘没有占主导的色块：整幅都算图形 */
    var ref = null;
    edge.forEach(function (L) { if (st.area[L] === best) ref = L; });
    var rc = [st.sr[ref] / best, st.sg[ref] / best, st.sb[ref] / best];
    edge.forEach(function (L) {
      var a = st.area[L];
      if (!a) return;
      var c = [st.sr[L] / a, st.sg[L] / a, st.sb[L] / a];
      var dd = Math.pow(c[0] - rc[0], 2) + Math.pow(c[1] - rc[1], 2) + Math.pow(c[2] - rc[2], 2);
      if (dd <= 1600) bg.add(L);   /* 与主背景色差 40 级以内算同一片背景 */
    });
    return bg;
  }

  function lumOfLabel(st, L) {
    var n = Math.max(1, st.area[L]);
    return (st.sr[L] + st.sg[L] + st.sb[L]) / 3 / n;
  }

  function meanOfLabel(st, L) {
    var n = Math.max(1, st.area[L]);
    return [st.sr[L] / n, st.sg[L] / n, st.sb[L] / n];
  }

  function dist2(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  /* 小块是不是「真实细节」：瞳孔、眼睛高光都只有几十像素，67px 图标上就是 1~2 个像素。
   * 判据三条：不贴画布边、不与背景相邻（被包住）、亮度是局部极值（比所有邻居都暗或都亮）。
   * 抗锯齿产生的过渡色亮度夹在两个邻居之间，第三条会把它挡掉——这是细节与噪点的分界。 */
  function isDetail(seg, st, bg, L, w, h) {
    if (st.area[L] < 16) return false;
    var x0 = st.minX[L], y0 = st.minY[L], x1 = st.maxX[L], y1 = st.maxY[L];
    if (x0 <= 0 || y0 <= 0 || x1 >= w - 1 || y1 >= h - 1) return false;
    var mine = lumOfLabel(st, L);
    var lo = Infinity, hi = -1;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (seg.labels[y * w + x] !== L) continue;
        var nb = [seg.labels[y * w + x - 1], seg.labels[y * w + x + 1],
          seg.labels[(y - 1) * w + x], seg.labels[(y + 1) * w + x]];
        for (var i = 0; i < 4; i++) {
          var N = nb[i];
          if (!N || N === L) continue;
          if (bg.has(N)) return false;
          var v = lumOfLabel(st, N);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (lo === Infinity) return false;
    return mine <= lo - 25 || mine >= hi + 25;
  }

  /* 抗锯齿碎块归并：小于「块」下限的色块分两种处理。
   *   · 过渡色 → 并进颜色最近的邻居（否则放大后的图标会被切成上百个 6×6 灰块，
   *     眼白、围巾这些部位全被切碎，画出来是碎片）；
   *   · 局部极值 → 原样保留（瞳孔被并进眼白就没有瞳孔了）。
   * Segmenter.cleanupSmall 不做这个区分，一刀切 260 会把瞳孔一起并掉。 */
  function mergeNoise(seg, w, h) {
    var minArea = Math.max(24, Math.round(w * h * 0.001));
    for (var round = 0; round < 6; round++) {
      var st = Segmenter.labelStats(seg);
      var bg = bgLabels(seg, st, w, h);
      var labels = seg.labels;
      var small = [];
      for (var L = 1; L <= st.maxL; L++) {
        if (!st.area[L] || st.area[L] >= minArea || bg.has(L)) continue;
        if (isDetail(seg, st, bg, L, w, h)) continue;
        small.push(L);
      }
      if (!small.length) break;

      var want = new Set(small);
      var adj = new Map();
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var a = labels[y * w + x];
          if (!a || !want.has(a)) continue;
          var nb = [];
          if (x > 0) nb.push(labels[y * w + x - 1]);
          if (x < w - 1) nb.push(labels[y * w + x + 1]);
          if (y > 0) nb.push(labels[(y - 1) * w + x]);
          if (y < h - 1) nb.push(labels[(y + 1) * w + x]);
          for (var j = 0; j < nb.length; j++) {
            var b = nb[j];
            if (!b || b === a) continue;
            var m = adj.get(a);
            if (!m) { m = new Map(); adj.set(a, m); }
            m.set(b, (m.get(b) || 0) + 1);
          }
        }
      }

      var changed = 0;
      small.forEach(function (s) {
        var m = adj.get(s);
        if (!m || !m.size) return;
        var own = meanOfLabel(st, s), pick = 0, bestD = Infinity;
        m.forEach(function (cnt, c) {
          var dd = dist2(own, meanOfLabel(st, c));
          if (dd < bestD) { bestD = dd; pick = c; }
        });
        if (!pick) return;
        for (var i = 0; i < labels.length; i++) if (labels[i] === s) labels[i] = pick;
        changed++;
      });
      if (!changed) break;
    }
    return seg;
  }

  /* 同色孤岛归并：像素图里被黑线隔开的同色小岛其实是同一部位（围巾在下巴处露出的
   * 一小块红、被喙挡住的巾角）。只按面积/亮度判噪点会把它们留成独立部位，
   * 模型只能硬起名字——「舌尖红点」就是这么来的。
   * 条件：面积小、与某个至少大 4 倍的块颜色接近、两块包围盒相距 ≤4px；背景不参与。 */
  function mergeIslands(seg, w, h) {
    var st = Segmenter.labelStats(seg);
    var bg = bgLabels(seg, st, w, h);
    var minArea = Math.max(24, Math.round(w * h * 0.001));
    var lim = minArea * 2.5;
    var list = [];
    for (var L = 1; L <= st.maxL; L++) if (st.area[L] && !bg.has(L)) list.push(L);
    var labels = seg.labels, changed = 0;

    list.forEach(function (s) {
      if (st.area[s] >= lim) return;
      var own = meanOfLabel(st, s);
      var sx0 = st.minX[s], sy0 = st.minY[s], sx1 = st.maxX[s], sy1 = st.maxY[s];
      var pick = 0, bestA = 0;
      list.forEach(function (t) {
        if (t === s || st.area[t] < st.area[s] * 4) return;
        if (dist2(own, meanOfLabel(st, t)) > 900) return;
        var gx = Math.max(0, Math.max(sx0 - st.maxX[t], st.minX[t] - sx1));
        var gy = Math.max(0, Math.max(sy0 - st.maxY[t], st.minY[t] - sy1));
        if (Math.hypot(gx, gy) > 4) return;
        if (st.area[t] > bestA) { bestA = st.area[t]; pick = t; }
      });
      if (!pick) return;
      for (var i = 0; i < labels.length; i++) if (labels[i] === s) labels[i] = pick;
      changed++;
    });
    return changed;
  }

  function colorSeg(data, w, h, o) {
    var seg = Segmenter.segment(data, {
      mode: 'light', background: o.background, tolerance: o.tolerance,
      barrier: 'edge', lineThreshold: 0
    });
    Segmenter.mergeAdjacent(seg, { mergeTol: o.mergeTol != null ? o.mergeTol : 22 });
    mergeNoise(seg, w, h);
    mergeIslands(seg, w, h);
    /* 墙像素（描边 / 抗锯齿）分给邻居，否则块与块之间留 1~3px 空缝，填出来是碎边 */
    Segmenter.absorbWalls(seg);
    Segmenter.compact(seg);
    var st = Segmenter.labelStats(seg);
    return { seg: seg, st: st, bg: bgLabels(seg, st, w, h) };
  }

  function shoelace(path) {
    var a = 0;
    for (var i = 0, j = path.length - 1; i < path.length; j = i++) {
      a += path[j][0] * path[i][1] - path[i][0] * path[j][1];
    }
    return a / 2;
  }

  /* 单个色块的闭合环：按块包围盒裁出来再描，整图逐块扫会慢一个量级。
   * 面积最大的环是外轮廓，其余是孔（眼睛、白肚这类被别的块盖住的洞）。
   * 抽稀容差按「块」给：按整图尺寸一刀切会把 20px 的眼睛也砍掉 3px，小部位直接被抹成斑；
   * 上限仍由整图尺寸兜底，防止大块把台阶点全留下。 */
  function regionLoops(seg, st, L, simplify) {
    var w = seg.w, h = seg.h, labels = seg.labels;
    var x0 = st.minX[L], y0 = st.minY[L], x1 = st.maxX[L], y1 = st.maxY[L];
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    /* 容差跟着「块」的大小走：台阶宽度是固定的（这张图放大 6 倍 = 6px），
     * 大块必须给到 5px 以上才消得掉，小块给大了就抹成一块斑。 */
    var eps = clamp(Math.max(Number(simplify) || 0, Math.min(bw, bh) * 0.06), 0.4, 16);
    var mask = new Uint8Array(bw * bh);
    var n = 0;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (labels[y * w + x] !== L) continue;
        mask[(y - y0) * bw + (x - x0)] = 1; n++;
      }
    }
    if (!n) return [];
    var loops = traceContours(mask, bw, bh);
    return loops.map(function (lp) {
      var full = lp.map(function (q) { return [q[0] + x0, q[1] + y0]; });
      return rdpClosed(chaikin(full, 2), eps);
    }).filter(function (lp) { return lp.length >= 3; });
  }

  function colorExtract(cd, o) {
    var w = cd.w, h = cd.h, inv = 1 / cd.scale;
    var got = colorSeg(cd.data, w, h, o);
    var st = got.st, bg = got.bg;
    /* 小碎块（抗锯齿边、压缩噪点）不进入参考线：26 块里有一半是这种，
     * 逐块让模型重绘只会把预算花在看不见的地方。局部极值的小块是例外（瞳孔、眼睛高光）。 */
    var minArea = Math.max(24, Math.round(w * h * 0.001));
    var out = [];

    for (var L = 1; L <= st.maxL; L++) {
      if (!st.area[L] || bg.has(L)) continue;
      if (st.area[L] < minArea && !isDetail(got.seg, st, bg, L, w, h)) continue;
      var loops = regionLoops(got.seg, st, L, o.simplify);
      if (!loops.length) continue;
      /* 一个色块可能被拆成多个不连通的片，最大的那圈当外轮廓 */
      var oi = 0, oa = 0;
      loops.forEach(function (lp, i) {
        var a = Math.abs(shoelace(lp));
        if (a > oa) { oa = a; oi = i; }
      });
      var outer = loops[oi].map(function (q) { return [q[0] * inv, q[1] * inv]; });
      var holes = loops.filter(function (_, i) { return i !== oi; })
        .map(function (lp) { return lp.map(function (q) { return [q[0] * inv, q[1] * inv]; }); });
      var a2 = Math.max(1, st.area[L]);
      /* 拟合容差跟着块走：大块的台阶高，容差要盖过台阶才能被平均成直线；
       * 小块（眼睛、脚掌）容差压在 1~2px，否则形状被抹圆。 */
      var tol = clamp(Math.min(st.maxX[L] - st.minX[L], st.maxY[L] - st.minY[L]) * 0.05, 0.5, 10) * inv;
      out.push({
        path: outer,
        holes: holes,
        bez: fitBezLoop(outer, tol),
        holeBez: holes.map(function (hp) { return fitBezLoop(hp, tol); }),
        tol: tol,
        closed: true,
        region: true,
        area: a2 * inv * inv,
        color: hexOf([st.sr[L] / a2, st.sg[L] / a2, st.sb[L] / a2]),
        width: Math.max(0.8, inv),
        length: pathLength(outer),
        anchors: outer.length,
        bbox: bboxOfPath(outer)
      });
    }
    out.sort(function (a, b) { return b.area - a.area; });
    return { strokes: out, mode: 'color', auto: null, cw: w, ch: h, inv: inv };
  }

  /* 色块模式的回读参照：所有「非背景」像素的并集。
   * 与填色轮廓同口径——问的是「这块画面有没有被覆盖」，不是「边界描得准不准」。 */
  function colorRefMask(data, w, h, o) {
    var got = colorSeg(data, w, h, o);
    var m = new Uint8Array(w * h);
    for (var i = 0; i < m.length; i++) {
      var L = got.seg.labels[i];
      if (L && !got.bg.has(L)) m[i] = 1;
    }
    return m;
  }

  /* ---------------- 提取 ---------------- */

  /* 判断前景是「笔画网络」还是「实心区域」，给「自动」形态用。
   * 笔画网络：骨架几乎铺满外接框（字、线条画）；实心区域：骨架缩成一根脊，线宽接近短边。 */
  function skelStats(mask, w, h, dt, lines) {
    var x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    var bw = Math.max(1, x1 - x0 + 1), bh = Math.max(1, y1 - y0 + 1);
    var perim = 2 * (bw + bh);
    var skelLen = 0, ws = [];
    lines.forEach(function (line) {
      for (var i = 1; i < line.length; i++) {
        skelLen += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      }
      line.forEach(function (p) { ws.push(dt[p[1] * w + p[0]] * 2); });
    });
    var mw = median(ws) || 0;
    var short = Math.min(bw, bh);
    var ratio = perim ? skelLen / perim : 0;
    /* 细线（≤2.5px）才是线稿：中线 + 线宽能还原；再粗就是实心块，
     * 骨架只是它的中轴，描出来是一根圆头面条，必须走闭合轮廓（填色）。 */
    var pick = (ratio >= 0.45 && mw <= 2.5) ? 'center' : 'contour';
    return {
      ratio: round2(ratio), w: round2(mw), short: short,
      skel: Math.round(skelLen), perim: perim, area: area, pick: pick
    };
  }

  function extractRect(rect, over) {
    var o = {};
    Object.keys(S.opt).forEach(function (k) { o[k] = S.opt[k]; });
    Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });

    var cd = cropData(rect, MAX_EXTRACT);
    /* 色块模式不经过「暗线 / 边缘」掩膜：多色图按颜色分块才有意义 */
    if (o.src === 'color') return colorExtract(cd, o);

    var w = cd.w, h = cd.h, inv = 1 / cd.scale;
    var built = buildLineMask(cd.data, w, h, o.src, o.threshold);
    var mask = built.mask;
    var shape = o.shape;
    var dt = null, lines = null, auto = null;

    /* 「自动」= 判断这块区域是「笔画网络」还是「实心区域」。
     * 实心字（粗体文字）用轮廓只能描出一圈外沿，笔画全糊成一条带子；
     * 中线才能把每一笔拆开。反过来，实心图标用中线会被抽成一根脊。
     * 判据：骨架总长 / 外接框周长（笔画网络接近 1）与 中位线宽 / 短边（实心区域很大）。 */
    if (shape !== 'contour') {
      dt = distTransform(mask, w, h);
      var skel = thin(mask, w, h);
      lines = traceSkeleton(skel, w, h);
      auto = skelStats(mask, w, h, dt, lines);
      if (shape === 'auto') shape = auto.pick;
    }

    if (shape === 'contour') {
      return { strokes: contourStrokes(mask, w, h, inv, cd.data.data, o), mode: 'contour', auto: auto, cw: w, ch: h, inv: inv };
    }

    var out = [];
    var src = cd.data.data;
    lines.forEach(function (line) {
      if (line.length < 2) return;
      var pts = rdp(line, o.simplify);
      if (pts.length < 2) return;
      var len = 0;
      for (var i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len * inv < o.minLen) return;

      var ws = [], rgb = [0, 0, 0], n = 0;
      line.forEach(function (p) {
        ws.push(dt[p[1] * w + p[0]] * 2);
        var q = (p[1] * w + p[0]) * 4;
        rgb[0] += src[q]; rgb[1] += src[q + 1]; rgb[2] += src[q + 2]; n++;
      });
      var width = clamp(median(ws) || 1, 0.8, 16);
      var color = hexOf(rgb.map(function (v) { return v / Math.max(1, n); }));

      var path = pts.map(function (p) { return [p[0] * inv, p[1] * inv]; });
      out.push({
        path: path,
        width: width * inv,
        color: color,
        length: len * inv,
        anchors: path.length,
        bbox: bboxOfPath(path)
      });
    });
    out.sort(function (a, b) { return b.length - a.length; });
    return { strokes: out, mode: 'center', auto: auto, cw: w, ch: h, inv: inv };
  }

  function stableKey(p, used) {
    var bb = p.bbox;
    var base = 'l' + Math.round(p.length) + '-' + Math.round((bb[0] + bb[2]) / 2) + '-' +
      Math.round((bb[1] + bb[3]) / 2) + '-' + hueBucket(p.color);
    var key = base, i = 2;
    while (used[key]) { key = base + '-' + (i++); }
    used[key] = 1;
    return key;
  }

  /* 提取层的默认名。真正的语义（围巾 / 眼睛 / 白肚）只有模型能给——
   * 走 vl_group_parts / vl_name_parts 才会写进 lexicon。这里只把测出来的东西翻成
   * 人能读的字：颜色 + 位置（+ 内孔数），来源标记仍是 heuristic，不冒充语义。 */
  function defaultName(p, n) {
    if (!p.region) return '线段' + n;
    var bb = p.bbox;
    var r = S.region || { x: 0, y: 0, w: S.w || 1, h: S.h || 1 };
    var t = colorTone(p.color) + '·' + placeText(
      (((bb[0] + bb[2]) / 2) - r.x) / Math.max(1, r.w),
      (((bb[1] + bb[3]) / 2) - r.y) / Math.max(1, r.h));
    var hn = (p.holes || []).length;
    if (hn) t += '·' + hn + '孔';
    return t;
  }

  function finalizeStrokes(raw, rect) {
    var used = {};
    return raw.map(function (p) {
      var item = Object.assign({}, p);
      item.key = stableKey(item, used);
      var lex = S.lexicon[item.key];
      item.name = (lex && lex.name) || defaultName(item, Object.keys(used).length);
      item.en = (lex && lex.en) || '';
      item.conf = (lex && lex.conf) || 0.3;
      item.source = (lex && lex.source) || 'heuristic';
      /* 色块自带像素面积（决定填充顺序），不要被长度覆盖 */
      item.area = item.area || item.length;
      item.cx = ((item.bbox[0] + item.bbox[2]) / 2) / rect.w;
      item.cy = ((item.bbox[1] + item.bbox[3]) / 2) / rect.h;
      return item;
    });
  }

  function extractStrokes() {
    if (!S.img) return 0;
    if (!S.region) S.region = { x: 0, y: 0, w: S.w, h: S.h };

    var got = extractRect(S.region, null);
    S.lastMode = got.mode;
    S.autoStats = got.auto || null;
    S.strokes = finalizeStrokes(got.strokes, S.region);
    /* 提取只产生「参考线」，不落笔。实线必须由模型调 vl_draw_parts 才有，
       否则画布上是程序自己画满的成品，监督就失去意义。 */
    S.ops = new Map();
    /* 分组/忽略是上一张图的语义，图变了就作废 */
    S.groups = []; S.drop = {}; S.layers = []; S.hidden = {};
    S.metrics = null;   /* 几何变了，上一轮的指标作废；但「最好一轮」的回滚点要保留 */
    renderParts(); drawScene(); updateStat();
    if (!S.strokes.length) {
      note('没提到线段：把「阈值」调低（边缘模式）或调高（暗线模式），或者换个大一点的框选区域。', true);
    } else {
      note('提到 ' + S.strokes.length + ' 条参考线（淡虚线）。点「监督重绘」，让模型自己决定画哪些。');
    }
    return S.strokes.length;
  }

  /* ---------------- 命名 ---------------- */

  function partName(p) { return (p && p.name) || (p && p.key) || ''; }

  function setLex(key, name, en, source, conf) {
    var p = S.strokes.filter(function (x) { return x.key === key; })[0];
    if (p) { p.name = name; p.en = en || ''; p.source = source; p.conf = conf == null ? 1 : conf; }
    S.lexicon[key] = { name: name, en: en || '', source: source, conf: conf == null ? 1 : conf };
  }

  async function nameUnknown(keys) {
    var list = (keys && keys.length) ? keys.slice() : S.strokes.map(function (p) { return p.key; });
    list = list.filter(function (k) {
      var lex = S.lexicon[k];
      return !lex || lex.source !== 'user';
    });
    if (!list.length) return { named: 0, source: 'none' };

    function fallback(k) {
      var p = S.strokes.filter(function (x) { return x.key === k; })[0];
      return p ? ('线段') : '线段';
    }
    if (S.stub) {
      list.forEach(function (k) { setLex(k, fallback(k), '', 'heuristic', 0.3); });
      return { named: list.length, source: 'heuristic' };
    }

    var conn = null;
    try { conn = (typeof llmConn === 'function') ? llmConn() : null; } catch (e) { conn = null; }
    if (!conn || !conn.base) {
      list.forEach(function (k) { if (!S.lexicon[k]) setLex(k, fallback(k), '', 'heuristic', 0.3); });
      return { named: list.length, source: 'heuristic', reason: '模型未配置' };
    }

    var payload = list.map(function (k) {
      var p = S.strokes.filter(function (x) { return x.key === k; })[0];
      if (!p) return null;
      return {
        key: p.key, length: Math.round(p.length), width: round2(p.width), color: p.color,
        bbox: p.bbox.map(function (v) { return Math.round(v); }),
        cx: round2(p.cx), cy: round2(p.cy)
      };
    }).filter(Boolean);

    var sys = [
      '你是线稿分段命名器。输入是一组线段的中线几何摘要（JSON 数组），外加框选区域的位图。',
      '先看图确认画面主体（例如「企鹅」「字 A」「线稿人像」），再按几何位置判断每条线是主体的哪个部位。',
      '只输出一个 JSON 对象：{"<key>":"中文名称"}，不要解释、不要代码块。',
      '名称必须带主体：例如「企鹅·身体外轮廓」「企鹅·左翅」「企鹅·嘴」。',
      '不要用「左侧小环」「主体外轮廓（内层闭环）」这类纯几何叫法——那样的名字说明没认出画的是什么。'
    ].join('\n');
    var content = [{ type: 'text', text: JSON.stringify(payload) }];
    var shot = regionImageURL(640);
    if (shot) content.push({ type: 'image_url', image_url: { url: shot } });
    var text = await llmStreamRequest(sys, [{ role: 'user', content: content }], null, { conn: conn, app: 'visionlab' });
    var map = {};
    try {
      var m = /{[\s\S]*}/.exec(String(text || ''));
      map = m ? JSON.parse(m[0]) : {};
    } catch (e) { map = {}; }
    var named = 0;
    list.forEach(function (k) {
      var name = map[k];
      if (typeof name === 'string' && name.trim()) { setLex(k, name.trim(), '', 'llm', 0.8); named++; }
      else if (!S.lexicon[k]) setLex(k, fallback(k), '', 'heuristic', 0.3);
    });
    renderParts(); drawScene();
    return { named: named, total: list.length, source: 'llm' };
  }

  /* ---------------- 回读：Chamfer + 覆盖率 ---------------- */

  function rasterizeDrawn(w, h, k) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.scale(k, k);
    paintOps(g, sortedOps());
    return { canvas: c, data: g.getImageData(0, 0, w, h).data };
  }

  function renderCheck() {
    if (!S.img || !S.region) return { error: '没有可校验的区域' };
    if (!S.strokes.length) return { error: '还没有提取线段' };

    var rect = S.region;
    var cd = cropData(rect, MAX_CHECK);
    var W = cd.w, H = cd.h;
    var k = W / rect.w;

    /* 色块模式的参照是「非背景像素的并集」，不是暗掩膜 */
    var isColor = S.lastMode === 'color';
    var built = isColor ? null : buildLineMask(cd.data, W, H, S.opt.src, S.opt.threshold);
    var srcMask = isColor ? colorRefMask(cd.data, W, H, S.opt) : built.mask;
    /* auto 解析后的实际形态才是口径：S.opt.shape 可能还是 auto */
    var isContour = S.lastMode === 'contour';
    /* 填色轮廓画的是整块区域，参照用前景掩膜；只有空心描边才用掩膜边界 */
    var filled = isColor || (isContour && S.opt.fill);
    if (isContour && !filled) srcMask = boundaryMask(srcMask, W, H);

    var drawn = rasterizeDrawn(W, H, k);
    var dd = drawn.data;
    var dMask = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) dMask[i] = dd[i * 4 + 3] > 12 ? 1 : 0;

    /* 距离变换算的是「到最近的 0 像素」。要问的是「离最近的线有多远」，
       所以两边都要先取反，否则漏画/多画的方向会反。 */
    var invSrc = new Uint8Array(W * H), invDraw = new Uint8Array(W * H);
    for (var j = 0; j < W * H; j++) {
      invSrc[j] = srcMask[j] ? 0 : 1;
      invDraw[j] = dMask[j] ? 0 : 1;
    }
    var dtD = distTransform(invDraw, W, H);  // 原图像素 → 最近的绘制像素：漏画距离
    var dtS = distTransform(invSrc, W, H);   // 绘制像素 → 最近的原图像素：多画距离

    var near = [], far = [];
    var srcPix = 0, hit = 0;
    for (var p = 0; p < W * H; p++) {
      if (srcMask[p]) {
        srcPix++;
        var d1 = dtD[p];
        near.push(d1);
        if (d1 <= 1.5) hit++;
      }
      if (dMask[p]) far.push(dtS[p]);
    }
    var chamfer = near.length ? near.reduce(function (a, b) { return a + b; }, 0) / near.length : 0;
    var recall = srcPix ? hit / srcPix : 0;
    var precSum = 0;
    for (var q = 0; q < far.length; q++) if (far[q] <= 1.5) precSum++;
    var precision = far.length ? precSum / far.length : 0;
    var f = (precision + recall) ? (2 * precision * recall / (precision + recall)) : 0;

    /* 逐条归因：模型自己提过「只有全局 Chamfer，看不出 4 段里哪段拖后腿，只能盲改」。
     * miss = 这条线自己的点到参照掩膜的平均距离；off = 离参照线超过容差的点占比。 */
    var per = [];
    S.strokes.forEach(function (sp) {
      if (!S.ops.has(sp.key)) return;
      var sum = 0, mx = 0, off = 0, cnt = 0;
      var step = Math.max(1, Math.floor(sp.path.length / 40));
      for (var t = 0; t < sp.path.length; t += step) {
        var xc = Math.round((sp.path[t][0] - rect.x) * k);
        var yc = Math.round((sp.path[t][1] - rect.y) * k);
        if (xc < 0 || yc < 0 || xc >= W || yc >= H) continue;
        var dv = dtD[yc * W + xc];
        sum += dv; if (dv > mx) mx = dv; if (dv > 1.5) off++;
        cnt++;
      }
      if (!cnt) return;
      per.push({
        key: sp.key, name: partName(sp), miss: +(sum / cnt).toFixed(2),
        max: +mx.toFixed(1), off: +(off / cnt).toFixed(2), len: Math.round(sp.len)
      });
    });
    per.sort(function (a, b) { return b.miss - a.miss; });
    var worst = per.filter(function (r) { return r.miss > 1.2 || r.off > 0.25; }).slice(0, 6);
    var undrawn = S.strokes.filter(function (sp) { return !S.ops.has(sp.key); })
      .sort(function (a, b) { return b.len - a.len; })
      .slice(0, 6)
      .map(function (sp) { return { key: sp.key, name: partName(sp), len: Math.round(sp.len) }; });

    var m = {
      chamfer: +chamfer.toFixed(3),
      chamferP95: +percentile(near, 0.95).toFixed(2),
      recall: +recall.toFixed(4),
      precision: +precision.toFixed(4),
      f: +f.toFixed(4),
      segments: S.strokes.length,
      drawn: sortedOps().length,
      total: S.strokes.length,
      medianWidth: +median(S.strokes.map(function (s) { return s.width; })).toFixed(2),
      mode: isColor ? 'color' : (isContour ? 'contour' : built.mode),
      shape: isColor ? 'color' : (isContour ? 'contour' : 'center'),
      filled: !!filled,
      px: W + '×' + H,
      worst: worst,
      undrawn: undrawn,
      at: new Date().toISOString()
    };
    /* 最好的一轮：模型上一轮把 5.108 改到 7.306 才收口，中间没有回滚点 */
    if (m.drawn > 0 && (!S.best || m.chamfer < S.best.m.chamfer)) {
      S.best = { round: S.round, m: m, snap: snapRun() };
    }
    m.bestRound = S.best ? S.best.round : null;
    m.bestChamfer = S.best ? S.best.m.chamfer : null;
    /* 这一刻比最好那轮更差、且不是同一轮：模型据此收口或回滚（它自己在复盘里要过这个信号） */
    m.noProgress = !!(S.best && S.round > S.best.round && m.chamfer > S.best.m.chamfer + 0.01);
    S.metrics = m;
    showMetrics(m);
    return m;
  }

  /* 回滚点：操作项 + 整份线段几何。只存操作项不够：
   * 模型一旦 force 重提取，key 全换了，只还原 ops 会一条都画不出来。 */
  function snapRun() {
    var ops = [];
    S.ops.forEach(function (op, key) { ops.push([key, JSON.parse(JSON.stringify(op))]); });
    return { ops: ops, strokes: JSON.parse(JSON.stringify(S.strokes)) };
  }

  function restoreBest() {
    if (!S.best) return { error: '还没有可回滚的一轮（需要先校验过一次）' };
    var snap = S.best.snap;
    if (snap.strokes) S.strokes = JSON.parse(JSON.stringify(snap.strokes));
    S.ops = new Map();
    snap.ops.forEach(function (e) { S.ops.set(e[0], e[1]); });
    drawScene(); renderParts(); updateStat();
    var m = renderCheck();
    return { restored: true, round: S.best.round, chamfer: m.chamfer, recall: m.recall, precision: m.precision };
  }

  /* ---------------- 工具 ---------------- */

  function regionInfo() {
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    return [r.x, r.y, r.w, r.h].map(function (v) { return Math.round(v); });
  }

  /* 色块的颜色与位置必须能被模型直接读懂：只给十六进制和 bbox 数字，
   * 模型会把肚子里两条浅色竖条命名成「眼睛」，再把真的白眼涂成瞳孔色。
   * tone / where / holes 都是测量值，不替模型下结论。 */
  function colorTone(hex) {
    var c = rgbOf(hex), l = lum(c[0], c[1], c[2]);
    var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    if (mx - mn < 26) return l > 225 ? '白' : (l > 170 ? '浅灰' : (l > 90 ? '灰' : (l > 40 ? '深灰' : '黑')));
    return hueBucket(hex) < 1 ? '红' : (hueBucket(hex) < 2 ? '橙' : (hueBucket(hex) < 3 ? '黄' :
      (hueBucket(hex) < 5 ? '绿' : (hueBucket(hex) < 7 ? '青' : (hueBucket(hex) < 9 ? '蓝' :
        (hueBucket(hex) < 10 ? '紫' : '粉'))))));
  }
  function placeText(nx, ny) {
    var v = ny < 0.34 ? '上' : (ny < 0.67 ? '中' : '下');
    var h = nx < 0.34 ? '左' : (nx < 0.67 ? '中' : '右');
    return v + h;
  }

  function strokeBrief(p) {
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var bb = p.bbox;
    var b = {
      key: p.key, name: partName(p),
      len: Math.round(p.length),
      w: round2(p.width),
      color: p.color,
      bbox: bb.map(function (v) { return Math.round(v); }),
      anchors: p.anchors,
      closed: !!p.closed,
      region: !!p.region,
      conf: round2(p.conf || 0),
      src: p.source
    };
    if (p.region) {
      b.tone = colorTone(p.color);
      b.where = placeText(((bb[0] + bb[2]) / 2 - r.x) / Math.max(1, r.w),
        ((bb[1] + bb[3]) / 2 - r.y) / Math.max(1, r.h));
      b.holes = (p.holes || []).length;
      /* 像素面积：判断「这是独立部位还是描边残条」用面积 + 长宽比，比只看周长可靠 */
      b.area = Math.round(p.area || 0);
    }
    return b;
  }

  /* 沿折线按弧长均匀取 n 个点。给模型看形状用——只有长度和包围盒看不出曲线怎么弯。 */
  function samplePath(path, closed, n) {
    if (!path || path.length < 2) return (path || []).slice();
    var pts = closed ? path.concat([path[0]]) : path.slice();
    var seg = [], total = 0;
    for (var i = 1; i < pts.length; i++) {
      var d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d); total += d;
    }
    if (!total) return [pts[0]];
    var out = [], k = 0, acc = 0, steps = closed ? n : n - 1;
    for (var j = 0; j < n; j++) {
      var target = total * j / Math.max(1, steps);
      while (k < seg.length - 1 && acc + seg[k] < target) { acc += seg[k]; k++; }
      var t = seg[k] ? (target - acc) / seg[k] : 0;
      var a = pts[k], b = pts[k + 1] || pts[k];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
  }

  /* 采样点数按周长自适应。轮廓的 RDP 顶点常在 200 以上，上限必须够大：
   * 企鹅图实测 32 点（周长 5028）P95 偏差 37px、Chamfer 6.0，画出来是带尖刺的三角形。
   * 上限 128 仍能一次传回，10 条约 12KB。 */
  function sampleCount(p) {
    /* 1 点 / 12px，下限 12、上限 128。
     * 实测把预算从周长/24 提到周长/4（演示图暗面环 23 → 25 点）Chamfer 只从 1.09 降到 1.04，
     * 说明 RDP 顶点数量此时不是瓶颈（114 顶点里保形点本来只有 25 个）；
     * 真正的残差是「少量点 + 均匀 Catmull-Rom」在尖角处的过冲，见 §4.4。 */
    return clamp(Math.round((p.length || 100) / 12), 12, 128);
  }

  /* 给模型的控制点候选 = 按预算抽稀的 RDP 顶点。
   * 均匀采样会漏尖角（把角切圆），拐点吸附又会在密集顶点里制造来回跳的尖刺；
   * RDP 的 ε 保证「抽稀后的折线离原线不超过 ε」，保形性最好。 */
  function controlSamples(path, closed, maxN) {
    if (!path || path.length < 3) return (path || []).slice();
    var out;
    if (path.length <= maxN) {
      out = path.slice();
    } else {
      var lo = 0, hi = 1e6, best = null;
      for (var it = 0; it < 18; it++) {
        var mid = (lo + hi) / 2;
        var pts = rdp(path, mid);
        if (pts.length <= maxN) { best = pts; hi = mid; }
        else { lo = mid; }
      }
      out = (best && best.length >= 3) ? best : samplePath(path, closed, maxN);
    }
    return densify(out, closed, Math.min(maxN, 12));
  }

  /* 顶点太少时在最长边上补中点：保留尖角，又给样条足够约束，
   * 否则 4 个顶点会被 Catmull-Rom 拉成椭圆。 */
  function densify(pts, closed, minN) {
    var list = (pts || []).slice();
    var guard = 0;
    while (list.length < minN && guard++ < 256) {
      var segs = closed ? list.length : list.length - 1;
      var bi = 0, bl = -1;
      for (var i = 0; i < segs; i++) {
        var a = list[i], b = list[(i + 1) % list.length];
        var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l > bl) { bl = l; bi = i; }
      }
      var p = list[bi], q = list[(bi + 1) % list.length];
      list.splice(bi + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    }
    return list;
  }

  function viewRegion(args) {
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var palette = [];
    S.strokes.forEach(function (p) { if (palette.indexOf(p.color) < 0) palette.push(p.color); });
    var from = clamp(Number((args && args.from) || 0) | 0, 0, S.strokes.length);
    var limit = clamp(Number((args && args.limit) || 32) | 0, 1, 64);
    var slice = S.strokes.slice(from, from + limit);
    return {
      image: { w: S.w, h: S.h, name: S.imgName },
      region: [r.x, r.y, r.w, r.h].map(function (v) { return Math.round(v); }),
      count: S.strokes.length,
      from: from,
      returned: slice.length,
      mode: S.lastMode,
      palette: palette.slice(0, 8),
      /* 坐标一律归一化到 0–1000（相对区域），模型回传也用这个口径 */
      coord: '各点坐标是相对区域归一化的 0–1000；重绘时把坐标按同一口径传回 vl_redraw_parts',
      strokes: slice.map(function (p) {
        var b = strokeBrief(p);
        b.samples = controlSamples(p.path, p.closed, sampleCount(p)).map(function (q) {
          return [Math.round((q[0] - r.x) / Math.max(1, r.w) * 1000), Math.round((q[1] - r.y) / Math.max(1, r.h) * 1000)];
        });
        /* 贝塞尔切段建议：长线给分段点，模型只补「往哪转」的手柄（B 组） */
        var bk = bezierBreaks(p.path, p.closed, 16);
        if (bk) b.breaks = bk.breaks.map(normPx);
        return b;
      })
    };
  }

  function drawStrokes(args) {
    var ops = Array.isArray(args && args.ops) ? args.ops : [];
    var applied = 0;
    ops.forEach(function (o, i) {
      if (!o) return;
      var targets = (!o.key || o.key === '*' || o.key === 'all') ? S.strokes.slice()
        : S.strokes.filter(function (x) { return x.key === o.key; });
      targets.forEach(function (p) {
        var cur = opOf(p.key) || {};
        S.ops.set(p.key, {
          color: o.color || cur.color || p.color,
          width: safeWidth(o.width != null ? o.width : (cur.width != null ? cur.width : p.width), p.width),
          order: o.order != null ? Number(o.order) : i,
          dx: 0, dy: 0, sc: 1, rot: 0
        });
        applied++;
      });
    });
    renderParts(); drawScene(); updateStat();
    return { applied: applied, drawn: sortedOps().length };
  }

  /* 语义分组：模型把碎块归到「部位」并命名、给统一颜色；
   * 无意义碎块（抗锯齿暗带、压缩噪点）用 drop 丢掉。
   * 这是色块模式从「像素拼贴」变成「围巾像围巾、眼睛像眼睛」的关键一步。
   *
   * 颜色是测量值，语义不能改写它：模型给的组色离实测平均色太远时直接拒收，
   * 保留各块原色。真实运行里模型把白眼块命名成瞳孔并给 #111111，眼睛就黑了。 */
  var GROUP_COLOR_MAX_DIST = 60;

  function groupMeasuredColor(keys, valid) {
    var r = 0, g = 0, b = 0, w = 0;
    keys.forEach(function (k) {
      var p = valid[k];
      if (!p) return;
      var c = rgbOf(p.color), kk = Math.max(1, p.area || p.length || 1);
      r += c[0] * kk; g += c[1] * kk; b += c[2] * kk; w += kk;
    });
    return w ? hexOf([r / w, g / w, b / w]) : '';
  }
  function colorDist(a, b) {
    var x = rgbOf(a), y = rgbOf(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }

  function groupParts(args) {
    if (S.lastMode !== 'color') return { error: '分组只用于色块模式（取线源=色块）' };
    var raw = Array.isArray(args && args.groups) ? args.groups : [];
    var valid = {};
    S.strokes.forEach(function (p) { if (p.region) valid[p.key] = p; });
    var seen = {}, groups = [], dropped = 0, fixed = [];

    /* 顶层 drop：真实运行里模型就把 drop 写在主参数上（{"drop":[…],"groups":[…]}），
     * 只支持组内 drop 会静默吞掉这条指令，于是「未分组 2」一直清不掉，模型反复重分组直到轮次耗尽。 */
    if (Array.isArray(args && args.drop)) {
      args.drop.forEach(function (k) {
        if (valid[k] && !seen[k] && !S.drop[k]) { S.drop[k] = 1; dropped++; }
      });
    }

    raw.forEach(function (g, i) {
      if (!g) return;
      var keys = (Array.isArray(g.keys) ? g.keys : []).filter(function (k) {
        return valid[k] && !seen[k];
      });
      keys.forEach(function (k) { seen[k] = 1; });
      if (Array.isArray(g.drop)) {
        g.drop.forEach(function (k) {
          if (valid[k] && !seen[k] && !S.drop[k]) { S.drop[k] = 1; dropped++; }
        });
      }
      if (!keys.length) return;
      var given = g.color || '';
      var used = given;
      if (given) {
        var measured = groupMeasuredColor(keys, valid);
        if (measured && colorDist(given, measured) > GROUP_COLOR_MAX_DIST) {
          used = '';
          fixed.push({
            name: String(g.name || '未命名部位'),
            given: given, measured: measured,
            why: '组色与实测色差 ' + Math.round(colorDist(given, measured)) + '，超过 ' + GROUP_COLOR_MAX_DIST + '，按实测保留'
          });
        }
      }
      groups.push({
        id: 'g' + (i + 1), name: String(g.name || '未命名部位'),
        keys: keys, color: used, given: given
      });
    });

    S.groups = groups;
    /* 分图层：每个语义组就是一层，按组的顺序落笔（先大后小）。图层可以单独隐藏，
     * 用来检查「这个部位画对没有」，而不是所有色块糊在一张画布上没法分辨。 */
    S.layers = groups.map(function (g, i) {
      var m = S.strokes.filter(function (p) { return (g.keys || []).indexOf(p.key) >= 0; })[0];
      return {
        id: 'L' + i, name: g.name || ('部位' + (i + 1)),
        color: g.color || (m ? m.color : '#c8d4e2'),
        keys: (g.keys || []).slice()
      };
    });
    /* 组名就是部位语义：写进每条线，参考线列表和锚点标签才显示「企鹅·白色肚子」而不是「白·中中」。
     * 用户手改过的名字（source='user'）不覆盖；其余用模型给的组名，source='model'。 */
    groups.forEach(function (g) {
      if (!g.name || g.name === '未命名部位') return;
      g.keys.forEach(function (k) {
        var lex = S.lexicon[k];
        if (lex && lex.source === 'user') return;
        setLex(k, g.name, '', 'model', 0.8);
      });
    });
    /* 分组即落笔：几何是精确的区域边界，复制不需要模型再花一轮。
     * 之前模型分完组又反复 view_region，轮次耗尽时 0 条描绘，画面全空。 */
    var drawn = 0;
    if (!args || args.draw !== false) {
      var ops = [];
      groups.forEach(function (g) {
        g.keys.forEach(function (k) {
          /* 组色被拒时显式回落到该块原色，免得沿用上一轮的旧组色 */
          ops.push({ key: k, color: g.color || (valid[k] && valid[k].color) || '', order: ops.length });
        });
      });
      if (ops.length) drawn = drawStrokes({ ops: ops }).applied;
    }
    renderParts(); drawScene(); updateStat();
    var m = renderCheck();
    return {
      groups: groups.length,
      grouped: Object.keys(seen).length,
      drawn: drawn,
      dropped: dropped,
      colorFixed: fixed,
      ungrouped: S.strokes.filter(function (p) { return p.region && !seen[p.key] && !S.drop[p.key]; }).length,
      chamfer: m.chamfer, recall: m.recall, precision: m.precision
    };
  }

  /* 语义合理性自检：每块是否都有归属、有没有重复归组、有没有漏掉的噪声碎块。
   * 指标只说明「画到了」，这一步回答「画对了没有」。 */
  function semanticCheck() {
    var used = {}, dup = [], total = 0;
    S.strokes.forEach(function (p) { total += (p.area || 0); });
    S.groups.forEach(function (g) {
      (g.keys || []).forEach(function (k) {
        if (used[k]) dup.push(k);
        used[k] = 1;
      });
    });

    var ungrouped = [], noise = [];
    S.strokes.forEach(function (p) {
      if (!p.region || used[p.key] || S.drop[p.key]) return;
      var brief = { key: p.key, color: p.color, area: Math.round(p.area || 0), bbox: p.bbox.map(function (v) { return Math.round(v); }) };
      ungrouped.push(brief);
      if ((p.area || 0) < total * 0.004) noise.push(brief);
    });

    /* 同一组里颜色跨度太大 = 很可能把两个部位并成一组（白眼睛 + 黑瞳孔）。
     * 这类错并会让「一組只填一次」盖掉内部细节，必须在收口前拆开。 */
    var byKey = {};
    S.strokes.forEach(function (p) { if (p.region) byKey[p.key] = p; });
    var clash = [];
    S.groups.forEach(function (g) {
      var cols = (g.keys || []).map(function (k) { return byKey[k] && byKey[k].color; }).filter(Boolean);
      var spread = 0;
      for (var i = 0; i < cols.length; i++) {
        for (var j = i + 1; j < cols.length; j++) spread = Math.max(spread, colorDist(cols[i], cols[j]));
      }
      if (spread > 90) clash.push({ name: g.name, spread: Math.round(spread), colors: cols });
    });

    var m = renderCheck();
    var hint = ungrouped.length
      ? '还有色块没归组：直接在 vl_group_parts 里补一组（或并进现有组）；确认是无意义碎块（抗锯齿暗带/噪点）再用 drop。不要再 view_region。'
      : (clash.length
        ? '有组内颜色跨度太大：同一组只填一次，会把里面的小件盖掉（白眼 + 瞳孔、围巾 + 牙齿都会被压平）。拆成两个部位重新 group。'
        : '全部色块都有归属，组内颜色一致。');
    return {
      mode: S.lastMode,
      groups: S.groups.map(function (g) {
        return { name: g.name, blocks: g.keys.length, color: g.color || '', given: g.given || '' };
      }),
      unnamed: S.groups.filter(function (g) { return !g.name || g.name === '未命名部位'; }).length,
      duplicates: dup,
      dropped: Object.keys(S.drop).length,
      ungrouped: ungrouped,
      noise: noise,
      clash: clash,
      colorFixed: S.groups.filter(function (g) { return g.given && !g.color; }).map(function (g) {
        return { name: g.name, given: g.given };
      }),
      hint: hint,
      chamfer: m.chamfer, recall: m.recall, precision: m.precision, drawn: m.drawn
    };
  }

  /* 精确重绘：模型给控制点，程序只做 Catmull-Rom 拟合与落笔。
   * 与 vl_draw_parts 的区别：那个是「按参考几何复制」，这个是「模型自己给曲线」。 */
  function distToPolyline(p, path, closed) {
    var best = 1e9;
    for (var i = 1; i < path.length; i++) best = Math.min(best, distToSeg(p, path[i - 1], path[i]));
    if (closed && path.length > 2) best = Math.min(best, distToSeg(p, path[path.length - 1], path[0]));
    return best;
  }

  function projOnSeg(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var L2 = vx * vx + vy * vy;
    var t = L2 ? clamp(((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2, 0, 1) : 0;
    var q = [a[0] + vx * t, a[1] + vy * t];
    return { t: t, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
  }

  /* 模型给的点通常落在参考线上，但顺序可能被它按角度/坐标重排过。
   * 对一条已知的参考折线来说，正确顺序就是弧长顺序：按投影弧长排序可复原。
   * 返回是否真的改过顺序，供监督页显示。 */
  function orderAlongPolyline(pts, path, closed) {
    var segs = [], acc = 0;
    function push(a, b) {
      var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push({ a: a, b: b, l0: acc, l: l });
      acc += l;
    }
    for (var i = 1; i < path.length; i++) push(path[i - 1], path[i]);
    if (closed && path.length > 2) push(path[path.length - 1], path[0]);
    if (!segs.length) return { pts: pts, changed: false };
    var tagged = pts.map(function (q, idx) {
      var best = { d: 1e9, s: 0 };
      segs.forEach(function (sg) {
        var pr = projOnSeg(q, sg.a, sg.b);
        if (pr.d < best.d) best = { d: pr.d, s: sg.l0 + pr.t * sg.l };
      });
      return { p: q, s: best.s, i: idx };
    });
    tagged.sort(function (x, y) { return x.s - y.s; });
    var changed = false;
    tagged.forEach(function (x, k) { if (x.i !== k) changed = true; });
    return { pts: tagged.map(function (x) { return x.p; }), changed: changed };
  }

  function redrawParts(args) {
    var ops = Array.isArray(args && args.ops) ? args.ops : [];
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var keys = [], missing = [], devs = [], reordered = 0;
    var bez = { n: 0, segs: 0, clamped: 0, fitted: 0, gap: 0 };
    ops.forEach(function (o, i) {
      if (!o || !o.key) return;
      var targets = (o.key === '*' || o.key === 'all') ? S.strokes.slice()
        : S.strokes.filter(function (x) { return x.key === o.key; });
      if (!targets.length) { missing.push(o.key); return; }
      targets.forEach(function (p) {
        /* 参考线固定为提取结果，不随上一轮重绘漂移，诊断才有基准 */
        if (!p.ref) p.ref = p.path.slice();
        var closed = (o.closed != null) ? !!o.closed : !!p.closed;
        var useBez = (o.form === 'bezier') || (Array.isArray(o.segs) && o.segs.length > 0);
        if (useBez) {
          /* B / C 组：模型给端点 + 手柄。缺手柄时由 fitHandles 从参考线上最小二乘解出来（C 组）。
           * 手柄长度上限 0.85×弦长，超过就夹紧——否则三次贝塞尔会在段内自交出环。 */
          var start = normPt(o.start) || (Array.isArray(o.points) && normPt(o.points[0]));
          var segsIn = Array.isArray(o.segs) ? o.segs : [];
          var segs = [], cur = start, perClamp = 0, perFit = 0;
          /* 参考线在「弧长空间」里逐段前进：RDP 之后顶点间距可达 12px，
           * 按最近顶点取子路径会把端点前后错开一格，切向直接反号；
           * 轮廓又会在窄颈处自相近，全局最近点会跳到环的另一侧（实测 chord 51px 配了 320px 弧长）。 */
          var tb = p.refTB || (p.refTB = arcTable(p.ref, p.closed));
          var startS = start ? arcProject(tb, 0, start, tb.total, p.closed).s : 0;
          var curS = startS;
          segsIn.forEach(function (sg) {
            if (!sg || !cur) return;
            var end = normPt(sg.end);
            if (!end) return;
            var c1 = normPt(sg.c1), c2 = normPt(sg.c2);
            var chord = Math.hypot(end[0] - cur[0], end[1] - cur[1]) || 1;
            var cap = 0.85 * chord;
            /* 向前窗口按弦长给：真弧长一般 ≤1.6×弦长，2.5×+30 足够用，
             * 但能挡住「绕到环的另一侧」那种成倍的假弧长。 */
            var pa = arcProject(tb, curS, end, 2.5 * chord + 30, p.closed);
            var sEnd = Math.max(pa.s, curS + 0.5);
            if (!c1 || !c2) {
              var f = fitHandles(cur, end, sampleSubArc(tb, curS, sEnd));
              if (!c1) c1 = f.c1;
              if (!c2) c2 = f.c2;
              if (f.fitted) perFit++;
            }
            var l1 = Math.hypot(c1[0] - cur[0], c1[1] - cur[1]);
            if (l1 > cap) {
              c1 = [cur[0] + (c1[0] - cur[0]) * cap / l1, cur[1] + (c1[1] - cur[1]) * cap / l1];
              perClamp++;
            }
            var l2 = Math.hypot(c2[0] - end[0], c2[1] - end[1]);
            if (l2 > cap) {
              c2 = [end[0] + (c2[0] - end[0]) * cap / l2, end[1] + (c2[1] - end[1]) * cap / l2];
              perClamp++;
            }
            segs.push({ c1: c1, c2: c2, end: end });
            cur = end;
            curS = p.closed ? (sEnd % tb.total) : Math.min(sEnd, tb.total);
          });
          if (start && segs.length) {
            /* 闭合环：最后一段回到起点。模型常常只给到 breaks 的末点，
             * 这里沿参考线补一段（C 组同款最小二乘），避免收口变成一条直弦。 */
            if (closed) {
              var lst = segs[segs.length - 1].end;
              var gapArc = (startS - curS + tb.total) % tb.total;
              if (gapArc > 1 && gapArc < tb.total - 1) {
                var fc = fitHandles(lst, start, sampleSubArc(tb, curS, curS + gapArc));
                segs.push({ c1: fc.c1, c2: fc.c2, end: start.slice() });
                if (fc.fitted) perFit++;
                bez.gap++;
              }
            }
            var curve = bezierPath(start, segs, 8);
            var ends = [start].concat(segs.map(function (s) { return s.end; }));
            devs.push(percentile(ends.map(function (q) { return distToPolyline(q, p.ref, p.closed); }), 0.5));
            p.path = curve;
            p.anchors = segs.length + 1;
            if (p.region) p.bez = fitBezLoop(curve, p.tol || 2);
            p.closed = closed;
            p.form = 'bezier';
            p.length = pathLength(closed ? curve.concat([curve[0]]) : curve);
            p.bbox = bboxOfPath(curve);
            p.source = 'model';
            p.redrawn = true;
            bez.n++; bez.segs += segs.length; bez.clamped += perClamp; bez.fitted += perFit;
          }
        } else if (Array.isArray(o.points) && o.points.length >= 2) {
          var pts = o.points.map(function (q) {
            if (!Array.isArray(q) || q.length < 2) return null;
            var x = Number(q[0]), y = Number(q[1]);
            return (isFinite(x) && isFinite(y)) ? [r.x + x / 1000 * r.w, r.y + y / 1000 * r.h] : null;
          }).filter(Boolean);
          if (pts.length >= 2) {
            /* 控制点离参考线多远：给模型一个能自我纠正的数，而不是只看最终 Chamfer */
            var ds = pts.map(function (q) { return distToPolyline(q, p.ref, p.closed); });
            devs.push(percentile(ds, 0.5));
            /* 点对但顺序错（按角度重排）会把凹轮廓拉成横跨内部的弦，这里按弧长复原 */
            var ordered = orderAlongPolyline(pts, p.ref, closed);
            if (ordered.changed) reordered++;
            var smooth = catmullRom(ordered.pts, closed, 6);
            p.path = smooth;
            p.anchors = ordered.pts.length;
            if (p.region) p.bez = fitBezLoop(smooth, p.tol || 2);
            p.closed = closed;
            p.form = 'poly';
            p.length = pathLength(closed ? smooth.concat([smooth[0]]) : smooth);
            p.bbox = bboxOfPath(smooth);
            p.source = 'model';
            p.redrawn = true;
          }
        }
        if (o.width != null) p.width = safeWidth(o.width, p.width);
        if (o.color) p.color = o.color;
        if (o.name) p.name = o.name;
        var curOp = opOf(p.key) || {};
        S.ops.set(p.key, {
          color: o.color || curOp.color || p.color,
          width: safeWidth(o.width != null ? o.width : (curOp.width != null ? curOp.width : p.width), p.width),
          order: o.order != null ? Number(o.order) : (curOp.order != null ? curOp.order : i),
          dx: 0, dy: 0, sc: 1, rot: 0
        });
        keys.push(p.key);
      });
    });
    S.metrics = null;   /* 几何变了，上一轮的指标作废；但「最好一轮」的回滚点要保留 */
    renderParts(); drawScene(); updateStat();
    return {
      redrawn: keys.length, keys: keys.slice(0, 20), drawn: sortedOps().length,
      dev: devs.length ? round2(percentile(devs, 0.5)) : null,
      maxDev: devs.length ? round2(Math.max.apply(null, devs)) : null,
      reordered: reordered,
      bezier: bez.n, segs: bez.segs, clamped: bez.clamped, fitted: bez.fitted, gap: bez.gap,
      missing: missing.slice(0, 8)
    };
  }

  function catmullRom(points, closed, steps) {
    if (!points || points.length < 2) return points || [];
    var pts = points.slice();
    if (closed) pts = [pts[pts.length - 1]].concat(pts, [pts[0], pts[1]]);
    else pts = [pts[0]].concat(pts, [pts[pts.length - 1]]);
    var out = [];
    for (var i = 0; i < pts.length - 3; i++) {
      var p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];
      for (var j = 0; j < steps; j++) {
        var t = j / steps, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    return out;
  }

  /* ---------------- 贝塞尔（B / C 组） ---------------- */

  function regionRect() { return S.region || { x: 0, y: 0, w: S.w, h: S.h }; }

  /* 0–1000 归一化坐标 → 区域像素；非法返回 null */
  function normPt(v) {
    if (!Array.isArray(v) || v.length < 2) return null;
    var x = Number(v[0]), y = Number(v[1]);
    if (!isFinite(x) || !isFinite(y)) return null;
    var r = regionRect();
    return [r.x + x / 1000 * r.w, r.y + y / 1000 * r.h];
  }

  function normPx(q) {
    var r = regionRect();
    return [Math.round((q[0] - r.x) / Math.max(1, r.w) * 1000), Math.round((q[1] - r.y) / Math.max(1, r.h) * 1000)];
  }

  /* 三次贝塞尔采样：start 与 segs 都是区域像素坐标 */
  function bezierPath(start, segs, steps) {
    if (!start || !segs || !segs.length) return null;
    var out = [start.slice()], cur = start;
    segs.forEach(function (sg) {
      for (var k = 1; k <= steps; k++) {
        var t = k / steps, u = 1 - t;
        out.push([
          u * u * u * cur[0] + 3 * u * u * t * sg.c1[0] + 3 * u * t * t * sg.c2[0] + t * t * t * sg.end[0],
          u * u * u * cur[1] + 3 * u * u * t * sg.c1[1] + 3 * u * t * t * sg.c2[1] + t * t * t * sg.end[1]
        ]);
      }
      cur = sg.end;
    });
    return out;
  }

  function arcTable(path, closed) {
    var pts = path.slice();
    if (closed && pts.length > 2) pts = pts.concat([pts[0]]);
    var segs = [], acc = 0;
    for (var i = 1; i < pts.length; i++) {
      var l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      segs.push({ a: pts[i - 1], b: pts[i], l0: acc, l: l });
      acc += l;
    }
    return { segs: segs, total: acc };
  }

  function pointAtArc(tb, s) {
    s = clamp(s, 0, tb.total);
    for (var i = 0; i < tb.segs.length; i++) {
      var sg = tb.segs[i];
      if (s <= sg.l0 + sg.l || i === tb.segs.length - 1) {
        var t = sg.l ? clamp((s - sg.l0) / sg.l, 0, 1) : 0;
        return {
          p: [sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t],
          d: sg.l ? [(sg.b[0] - sg.a[0]) / sg.l, (sg.b[1] - sg.a[1]) / sg.l] : [1, 0]
        };
      }
    }
    return { p: tb.segs[0].a.slice(), d: [1, 0] };
  }

  /* 每个顶点的累计弧长与转角，用来把切段点吸到拐角上 */
  function vertexTurns(path, closed) {
    var n = path.length, tb = arcTable(path, closed), out = [];
    for (var i = 0; i < n; i++) {
      var s = i < tb.segs.length ? tb.segs[i].l0 : tb.total;
      if (!closed && (i === 0 || i === n - 1)) { out.push({ s: s, turn: 0 }); continue; }
      var a = path[(i - 1 + n) % n], b = path[i], c = path[(i + 1) % n];
      var ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      var lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
      out.push({ s: s, turn: Math.acos(clamp((ux * vx + uy * vy) / (lu * lv), -1, 1)) });
    }
    return out;
  }

  /* 切段建议：段长目标 60px，2–16 段；段界优先落在拐角上。
   * 60px 是实测下限：再长，一段三次贝塞尔跨过拐角就会偏 8–19px（§4.5）。 */
  function bezierBreaks(path, closed, maxSegs) {
    if (!path || path.length < 3) return null;
    var tb = arcTable(path, closed);
    if (tb.total < 90) return null;
    var n = clamp(Math.round(tb.total / 60), 2, maxSegs || 16);
    var turns = vertexTurns(path, closed);
    var out = [pointAtArc(tb, 0).p];
    var prev = 0;
    for (var k = 1; k < n; k++) {
      var ideal = k * tb.total / n, win = 0.35 * tb.total / n, best = null;
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        if (t.s <= prev + 1 || t.s < ideal - win || t.s > ideal + win) continue;
        if (!best || t.turn > best.turn) best = t;
      }
      var s = best ? best.s : ideal;
      /* 必须严格递增：吸到拐角后可能落到上一段之前，那样「正向前进」的子路径会绕整圈，
       * 最小二乘用错方向的参考点（实测某段 chord 51px 却走了 320px 弧长）。 */
      if (s <= prev + 1) s = prev + Math.max(2, tb.total / n / 2);
      if (s >= tb.total - 2) break;
      out.push(pointAtArc(tb, s).p);
      prev = s;
    }
    return { breaks: out, segs: out.length, total: tb.total };
  }

  /* 从弧长 fromS 向前找 q 在参考线上的投影位置（含段内插值，精度到亚像素）。
   * 只在 [fromS, fromS+win] 里找：轮廓自相近时，全局最近点会落到环的另一侧。
   * closed 时允许窗口跨过 total，用 ±total 的副本参与比较。 */
  function arcProject(tb, fromS, q, win, closed) {
    var total = tb.total, toS = fromS + Math.max(0.5, Math.min(win || total, total));
    var best = null;
    tb.segs.forEach(function (sg) {
      var pr = projOnSeg(q, sg.a, sg.b);
      var s0 = sg.l0 + pr.t * sg.l;
      for (var rep = 0; rep < (closed ? 2 : 1); rep++) {
        var s = s0 + rep * total;
        if (s < fromS - 1e-6 || s > toS) continue;
        if (!best || pr.d < best.d) best = { s: s, d: pr.d };
      }
    });
    return best || { s: fromS, d: 1e9 };
  }

  /* 弧长 s0→s1 的密采样子路径（约 2px 一点）。closed 时 s1 可以超过 total，按环取模。 */
  function sampleSubArc(tb, s0, s1) {
    var total = tb.total, len = Math.max(0.5, s1 - s0);
    var n = clamp(Math.ceil(len / 2), 2, 400), out = [];
    for (var i = 0; i <= n; i++) {
      var s = s0 + len * i / n;
      if (total > 0) s = ((s % total) + total) % total;
      out.push(pointAtArc(tb, clamp(s, 0, total)).p);
    }
    return out;
  }

  /* C 组：端点已定，手柄长度用最小二乘解（方向取参考线的切向，只解两个长度标量） */
  function fitHandles(start, end, sub) {
    var chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
    var flat = { c1: start.slice(), c2: end.slice(), fitted: false };
    if (chord < 1 || !sub || sub.length < 2) return flat;
    var tb = arcTable(sub, false);
    if (tb.total < 1) return flat;
    var d0 = pointAtArc(tb, 0).d, d1 = pointAtArc(tb, tb.total).d;
    var n = Math.max(8, Math.round(tb.total / 6));
    var aa = 0, ab = 0, bb = 0, ra = 0, rb = 0;
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      var q = pointAtArc(tb, tb.total * t).p;
      var b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      /* c1 = A + a·d0、c2 = B − b·d1，所以残差是 B1·a·d0 − B2·b·d1 */
      var rx = q[0] - (b0 + b1) * start[0] - (b2 + b3) * end[0];
      var ry = q[1] - (b0 + b1) * start[1] - (b2 + b3) * end[1];
      var ax = b1 * d0[0], ay = b1 * d0[1];
      var bx = -b2 * d1[0], by = -b2 * d1[1];
      aa += ax * ax + ay * ay;
      ab += ax * bx + ay * by;
      bb += bx * bx + by * by;
      ra += ax * rx + ay * ry;
      rb += bx * rx + by * ry;
    }
    var det = aa * bb - ab * ab, a = 0, b = 0;
    if (Math.abs(det) > 1e-9) { a = (ra * bb - rb * ab) / det; b = (rb * aa - ra * ab) / det; }
    var cap = 0.85 * chord;
    a = clamp(a, 0, cap); b = clamp(b, 0, cap);
    return { c1: [start[0] + d0[0] * a, start[1] + d0[1] * a], c2: [end[0] - d1[0] * b, end[1] - d1[1] * b], fitted: true, a: a, b: b, subLen: tb.total };
  }

  function drawPaths(args) {
    var paths = Array.isArray(args && args.paths) ? args.paths : [];
    var keys = [];
    paths.forEach(function (pp) {
      var pts = (pp && pp.points) || [];
      if (pts.length < 2) return;
      if (pts.length > 16) pts = pts.slice(0, 16);
      var path = catmullRom(pts.map(function (q) { return [Number(q[0]) || 0, Number(q[1]) || 0]; }), pp.closed === true, 8);
      S.customSeq++;
      var key = 'c' + S.customSeq;
      var bbox = bboxOfPath(path);
      var part = {
        key: key, path: path,
        width: pp.width != null ? Number(pp.width) : 1.5,
        color: pp.color || '#2b3440',
        length: pathLength(path),
        anchors: pts.length,
        bbox: bbox,
        name: pp.name || ('新线' + S.customSeq),
        en: '', conf: 0.5, source: 'model',
        cx: 0, cy: 0, area: pathLength(path)
      };
      S.strokes.push(part);
      S.ops.set(key, {
        color: part.color, width: part.width,
        order: 1e7 + S.customSeq, dx: 0, dy: 0, sc: 1, rot: 0
      });
      keys.push(key);
    });
    drawScene(); renderParts();
    return { created: keys.length, keys: keys };
  }

  function editStrokes(args) {
    var ops = Array.isArray(args && args.ops) ? args.ops : [];
    var applied = 0;
    ops.forEach(function (o) {
      if (!o || !o.key) return;
      var cur = opOf(o.key);
      if (!cur) return;
      if (o.dx != null) cur.dx = (cur.dx || 0) + Number(o.dx);
      if (o.dy != null) cur.dy = (cur.dy || 0) + Number(o.dy);
      if (o.sc != null) cur.sc = (cur.sc || 1) * Number(o.sc);
      if (o.rot != null) cur.rot = (cur.rot || 0) + Number(o.rot);
      if (o.width != null) cur.width = safeWidth(o.width, cur.width);
      if (o.color) cur.color = o.color;
      if (o.order != null) cur.order = Number(o.order);
      S.ops.set(o.key, cur);
      applied++;
    });
    drawScene(); renderParts(); updateStat();
    return { applied: applied };
  }

  function measure(args) {
    var a = args && args.a, b = args && args.b;
    function midOf(key) {
      var p = S.strokes.filter(function (x) { return x.key === key; })[0];
      if (!p) return null;
      return [(p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2];
    }
    if (args && args.aKey) a = midOf(args.aKey) || a;
    if (args && args.bKey) b = midOf(args.bKey) || b;
    if (!a || !b) return { error: '需要 a/b 两个点，或 aKey/bKey' };
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var dist = Math.sqrt(dx * dx + dy * dy);
    var r = S.region || { w: S.w, h: S.h };
    return {
      dx: round2(dx), dy: round2(dy), dist: round2(dist),
      distRatio: +((dist / Math.sqrt(r.w * r.w + r.h * r.h)) * 100).toFixed(2),
      angleDeg: +((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1))
    };
  }

  var TOOLS = [
    {
      type: 'function', function: {
        name: 'vl_view_region',
        description: '看当前区域的线稿摘要：每条线段的中线 key、名称、长度、线宽、颜色、包围盒、锚点数、samples（轮廓采样点）、breaks（贝塞尔切段建议），以及取线模式。一次最多返回 64 条，用 from 翻页。开工第一步调它。',
        parameters: {
          type: 'object', properties: {
            from: { type: 'number', description: '从第几条开始（默认 0）' },
            limit: { type: 'number', description: '本次返回多少条（默认 32，上限 64）' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_trace',
        description: '重新提取线稿。可覆盖 shape（contour/center）、src（auto/edge/dark/color）、threshold、simplify、minLen，用来对比不同取线口径。',
        parameters: {
          type: 'object', properties: {
            shape: { type: 'string', description: 'contour=每个字形/图形一圈闭合轮廓, center=中线 + 线宽' },
            src: { type: 'string', description: 'auto=自动判断, edge=按颜色边缘取线, dark=按暗像素取线, color=色块（多色图标/插画，逐块取轮廓并原色填充）' },
            threshold: { type: 'number', description: '取线阈值。边缘模式越小抓得越多；暗线模式映射为亮度阈值' },
            simplify: { type: 'number', description: '抽稀容差（像素）' },
            minLen: { type: 'number', description: '最短线段（像素），短的直接丢' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_draw_parts',
        description: '按参考几何复制线段（只传 key / 线宽 / 颜色 / 顺序，不传坐标）。这一步不改几何，适合「线已经是你要的形状」。要改形状用 vl_redraw_parts。',
        parameters: {
          type: 'object', properties: {
            ops: {
              type: 'array', items: {
                type: 'object', properties: {
                  key: { type: 'string' }, width: { type: 'number' }, color: { type: 'string' }, order: { type: 'number' }
                }, required: ['key']
              }
            }
          }, required: ['ops']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_group_parts',
        description: '色块模式专用：把色块归到「语义部位」并命名；无意义碎块（抗锯齿暗带、压缩噪点）用 drop 丢掉。同级碎块各自填，只有整个套在另一块里面的成员才当孔洞挖掉；默认自动落笔（draw:false 可关）。先分组，再自检。',
        parameters: {
          type: 'object', properties: {
            groups: {
              type: 'array', items: {
                type: 'object', properties: {
                  name: { type: 'string', description: '中文部位名，格式「主体·部位」，例如「企鹅·红围巾」「企鹅·左眼」' },
                  keys: { type: 'array', items: { type: 'string' }, description: '属于这个部位的色块 key（先看 tone / where / holes 再归组）' },
                  color: { type: 'string', description: '可选。留空 = 沿用每块实测原色（推荐）；只有需要统一同色相碎块时才给，且必须贴近实测色，差太远会被拒收并在 colorFixed 回报' },
                  drop: { type: 'array', items: { type: 'string' }, description: '确认无意义的碎块 key，直接不画（也可以写在顶层 drop）' }
                }, required: ['name', 'keys']
              }
            },
            drop: {
              type: 'array', items: { type: 'string' },
              description: '顶层写法：无意义碎块（抗锯齿暗带、细窄残条、噪点）的 key，不参与绘制也不计入已描绘'
            }
          }, required: ['groups']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_redraw_parts',
        description: '精确重绘。两种形态：① points 折线（3–128 个控制点，程序 Catmull-Rom 拟合）；② form:"bezier" 端点+手柄（start + segs，适合头发、衣褶这类长而平滑的弧）。一次最多 8 条，超过要分多批调用。坐标都用 vl_view_region 的 samples 同一口径（相对区域 0–1000）。',
        parameters: {
          type: 'object', properties: {
            ops: {
              type: 'array', items: {
                type: 'object', properties: {
                  key: { type: 'string' },
                  form: { type: 'string', description: 'poly=折线控制点（默认）；bezier=三次贝塞尔（端点 + 手柄）' },
                  points: {
                    type: 'array', description: '折线控制点 [[x,y], …]，0–1000 归一化；沿参考线取点，曲率大的地方多取',
                    items: { type: 'array', items: { type: 'number' } }
                  },
                  start: { type: 'array', description: 'bezier 起点 [x,y]，0–1000；可省略 segs[0] 之前的点', items: { type: 'number' } },
                  segs: {
                    type: 'array',
                    description: 'bezier 段序列。每段 {c1,c2,end}：c1/c2 是手柄（0–1000 坐标），手柄长度不要超过该段弦长的 0.85 倍；不传 c1/c2 时由程序从参考线最小二乘求出',
                    items: {
                      type: 'object', properties: {
                        c1: { type: 'array', items: { type: 'number' } },
                        c2: { type: 'array', items: { type: 'number' } },
                        end: { type: 'array', items: { type: 'number' } }
                      }, required: ['end']
                    }
                  },
                  closed: { type: 'boolean' },
                  width: { type: 'number' },
                  color: { type: 'string' },
                  name: { type: 'string', description: '中文语义名，格式「主体·部位」，例如「企鹅·左翅」' },
                  order: { type: 'number' }
                }, required: ['key']
              }
            }
          }, required: ['ops']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_edit_parts',
        description: '微调已描绘的线段：位移（像素）、缩放、旋转（弧度）、改线宽、改色、改层级。',
        parameters: {
          type: 'object', properties: {
            ops: {
              type: 'array', items: {
                type: 'object', properties: {
                  key: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' },
                  sc: { type: 'number' }, rot: { type: 'number' }, width: { type: 'number' },
                  color: { type: 'string' }, order: { type: 'number' }
                }, required: ['key']
              }
            }
          }, required: ['ops']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_draw_paths',
        description: '创作新线：给 8-16 个控制点（区域像素坐标），程序会拟合平滑曲线并给指定线宽。',
        parameters: {
          type: 'object', properties: {
            paths: {
              type: 'array', items: {
                type: 'object', properties: {
                  points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                  closed: { type: 'boolean' }, width: { type: 'number' }, color: { type: 'string' }, name: { type: 'string' }
                }, required: ['points']
              }
            }
          }, required: ['paths']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_measure',
        description: '量两点距离/角度，或两条线段中点之间的距离。坐标都是区域内的像素坐标。',
        parameters: {
          type: 'object', properties: {
            a: { type: 'array', items: { type: 'number' } },
            b: { type: 'array', items: { type: 'number' } },
            aKey: { type: 'string' }, bKey: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_name_parts',
        description: '给线段起语义名（外轮廓 / 领口 / 发丝…）。只对需要命名的 key 调用。',
        parameters: {
          type: 'object', properties: {
            keys: { type: 'array', items: { type: 'string' }, description: '留空表示所有未手改过的线段' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_render_check',
        description: '回读校验：把当前描绘栅格化，与原图线稿比 Chamfer 距离、覆盖率召回/精度、中位线宽。每次画完都要调。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_check_semantics',
        description: '语义自检：每个色块是否都有归属、组名是否完整、有没有重复归组、组内颜色跨度是否过大（clash）、有没有被拒收的组色（colorFixed）、还剩多少未分组噪声碎块。色块模式每次分组后都要调。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_restore_best',
        description: '回滚到目前 Chamfer 最好的一轮（连几何一起还原）。改坏了、或者收口前想保住最好结果时调用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_finish',
        description: '收口：说明这次重新描绘做了什么、指标如何、还有哪里没对齐。',
        parameters: {
          type: 'object', properties: { summary: { type: 'string' } }, required: ['summary']
        }
      }
    }
  ];

  async function execTool(name, args) {
    switch (name) {
      case 'vl_view_region': return viewRegion(args);
      case 'vl_trace': {
        var changed = false;
        ['shape', 'src', 'threshold', 'simplify', 'minLen'].forEach(function (k) {
          if (args && args[k] != null && args[k] !== S.opt[k]) changed = true;
        });
        /* 已经画上线还改参数：重提取会把画布清空。实测模型会连改三次参数，
         * 把已经画好的 31 条抹成 0，最后只来得及画 12 条。默认拦住。 */
        if (changed && S.ops.size && !(args && args.force)) {
          return {
            count: S.strokes.length, mode: S.lastMode, blocked: true, cleared: 0,
            hint: '已描绘 ' + S.ops.size + ' 条；改参数会清空它们。先完成重绘；确实要重来请传 force:true。'
          };
        }
        /* 一条都没画就反复对比取线口径：实测模型在 24/5/18/5 段之间来回切，
         * 8 轮全花在重提取上，最后 0 条描绘。初提取已经给了参考线，先画再换。 */
        if (changed && !S.ops.size && S.strokes.length && !(args && args.force)) {
          return {
            count: S.strokes.length, mode: S.lastMode, blocked: true, cleared: 0,
            auto: S.autoStats || null,
            hint: '还没画任何线。先用当前参考线重绘并校验，再换口径；确实要重提取请传 force:true。'
          };
        }
        ['shape', 'src', 'threshold', 'simplify', 'minLen'].forEach(function (k) {
          if (args && args[k] != null) S.opt[k] = args[k];
        });
        /* 参数没变的重复提取结果必然一样，但会把模型已经画上去的线全部清空。
         * 直接当空操作返回，避免模型「重提取一次看看」把自己的工作抹掉。 */
        if (!changed && S.strokes.length) {
          return { count: S.strokes.length, mode: S.lastMode, unchanged: true };
        }
        var had = S.ops.size;
        var before = S.strokes.length;
        var n = extractStrokes();
        return {
          count: n, mode: S.lastMode, cleared: had, delta: n - before,
          auto: S.autoStats || null,
          strokes: S.strokes.slice(0, 12).map(strokeBrief)
        };
      }
      case 'vl_draw_parts': return drawStrokes(args);
      case 'vl_redraw_parts': return redrawParts(args);
      case 'vl_edit_parts': return editStrokes(args);
      case 'vl_draw_paths': return drawPaths(args);
      case 'vl_measure': return measure(args);
      case 'vl_name_parts': return await nameUnknown((args && args.keys) || []);
      case 'vl_render_check': return renderCheck();
      case 'vl_group_parts': return groupParts(args);
      case 'vl_check_semantics': return semanticCheck();
      case 'vl_restore_best': return restoreBest();
      case 'vl_finish':
        if (args && args.summary) note(String(args.summary));
        setPhase('完成', '');
        return {
          ok: true, strokes: S.strokes.length, drawn: S.ops.size,
          chamfer: S.metrics ? S.metrics.chamfer : null,
          recall: S.metrics ? S.metrics.recall : null,
          precision: S.metrics ? S.metrics.precision : null,
          medianWidth: S.metrics ? S.metrics.medianWidth : null
        };
      default: return { error: '未知工具：' + name };
    }
  }

  function digestOf(name, res) {
    if (!res) return '';
    if (res.error) return '失败';
    if (name === 'vl_view_region') return (res.count || 0) + ' 段 · ' + res.mode;
    /* 分组 / 语义自检以前没有摘要，账本里只剩「r2 vl_group_parts：」一行空白，
     * 模型因此以为这两个工具没返回内容，反复重调。字段必须进账本。 */
    if (name === 'vl_group_parts') {
      var gp = (res.groups || 0) + ' 组 · 归组 ' + (res.grouped || 0) + ' 块 · 落笔 ' + (res.drawn || 0);
      if (res.dropped) gp += ' · drop ' + res.dropped;
      if (res.ungrouped) gp += ' · 未分组 ' + res.ungrouped;
      if (res.colorFixed && res.colorFixed.length) gp += ' · 拒收组色 ' + res.colorFixed.length;
      if (res.chamfer != null) gp += ' · Chamfer ' + res.chamfer;
      return gp;
    }
    if (name === 'vl_check_semantics') {
      var bad = [];
      if (res.ungrouped && res.ungrouped.length) bad.push('未分组 ' + res.ungrouped.length);
      if (res.duplicates && res.duplicates.length) bad.push('重复归组 ' + res.duplicates.length);
      if (res.unnamed) bad.push('未命名组 ' + res.unnamed);
      if (res.clash && res.clash.length) bad.push('组内色跨度大 ' + res.clash.length);
      if (res.colorFixed && res.colorFixed.length) bad.push('拒收组色 ' + res.colorFixed.length);
      return (bad.length ? bad.join(' · ') : '通过')
        + ' · ' + (res.groups ? res.groups.length : 0) + ' 组 · 已画 ' + (res.drawn || 0)
        + (res.chamfer != null ? ' · Chamfer ' + res.chamfer : '');
    }
    if (name === 'vl_trace') return res.blocked ? ('已拦截：画布上有 ' + res.count + ' 条，未清空')
      : (res.unchanged ? '参数未变，未重提取' : ((res.count || 0) + ' 段 · ' + res.mode + (res.cleared ? '（画布已清空）' : '')));
    if (name === 'vl_draw_parts') return (res.applied || 0) + ' 段已画';
    if (name === 'vl_redraw_parts') {
      var s = (res.redrawn || 0) + ' 段已重绘';
      if (res.bezier) s += ' · 贝塞尔 ' + res.bezier + ' 条/' + res.segs + ' 段';
      if (res.fitted) s += ' · 程序拟合手柄 ' + res.fitted;
      if (res.clamped) s += ' · 手柄夹紧 ' + res.clamped;
      if (res.dev != null) s += '（偏离参考 ' + res.dev + 'px）';
      if (res.reordered) s += ' · 重排 ' + res.reordered + ' 条';
      if (res.missing && res.missing.length) s += ' · ' + res.missing.length + ' 个 key 不存在';
      return s;
    }
    if (name === 'vl_edit_parts') return (res.applied || 0) + ' 段已调';
    if (name === 'vl_draw_paths') return (res.created || 0) + ' 条新线';
    if (name === 'vl_measure') return res.dist != null ? ('距离 ' + res.dist) : '无结果';
    if (name === 'vl_name_parts') return (res.named || 0) + '/' + (res.total || res.named || 0) + ' 已命名';
    if (name === 'vl_render_check') {
      var c = 'Chamfer ' + (res.chamfer != null ? res.chamfer : '—')
        + ' · 召回 ' + res.recall + ' / 精度 ' + res.precision + ' · 线宽 ' + res.medianWidth;
      if (res.bestChamfer != null) c += '（最好 ' + res.bestChamfer + ' / 第 ' + (res.bestRound + 1) + ' 轮）';
      if (res.noProgress) c += ' · 比最好那轮更差，考虑 vl_restore_best 或停止改动';
      if (res.worst && res.worst.length) {
        c += ' · 最差 ' + res.worst.slice(0, 3).map(function (w) {
          return w.key + ' miss ' + w.miss + (w.off ? ' off ' + w.off : '');
        }).join(', ');
      }
      if (res.undrawn && res.undrawn.length) c += ' · 未画 ' + res.undrawn.length + ' 条（' + res.undrawn.slice(0, 3).map(function (u) { return u.key; }).join(',') + '）';
      return c;
    }
    if (name === 'vl_restore_best') {
      if (res.error) return '失败';
      return '已回滚到第 ' + (res.round + 1) + ' 轮 · Chamfer ' + res.chamfer;
    }
    /* 收口这一步本身也要能当验收凭据，否则账本最后一行还是空的 */
    if (name === 'vl_finish') {
      return '已收口 · 已画 ' + (res.drawn || 0) + '/' + (res.strokes || 0)
        + (res.chamfer != null ? ' · Chamfer ' + res.chamfer + ' · 召回 ' + res.recall + ' / 精度 ' + res.precision : '');
    }
    return '';
  }
  function digestArgsOf(name, args) {
    if (name === 'vl_draw_parts' && args && Array.isArray(args.ops)) return args.ops.length + ' 条';
    if (name === 'vl_redraw_parts' && args && Array.isArray(args.ops)) {
      var n = 0;
      args.ops.forEach(function (o) { if (o && Array.isArray(o.points)) n += o.points.length; });
      return args.ops.length + ' 条 / ' + n + ' 控制点';
    }
    if (name === 'vl_name_parts' && args && args.keys) return args.keys.length + ' 个 key';
    if (name === 'vl_trace' && args) return JSON.stringify(args).slice(0, 40);
    return '';
  }

  function factsCard() {
    var lines = [];
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    lines.push('<FACTS region="' + [r.x, r.y, r.w, r.h].join(',') + '" strokes="' + S.strokes.length +
      '" mode="' + S.lastMode + '"' +
      (S.autoStats ? ' auto="' + S.autoStats.pick + ' ratio ' + S.autoStats.ratio +
        ' 宽 ' + S.autoStats.w + ' 短边 ' + S.autoStats.short + '"' : '') + '>');
    S.strokes.slice(0, 30).forEach(function (p) {
      lines.push('  ' + p.key + ' ' + partName(p) + ' | 长 ' + Math.round(p.length) + ' | 宽 ' +
        round2(p.width) + ' | [' + p.bbox.map(function (v) { return Math.round(v); }).join(',') +
        '] | ' + p.anchors + '点 | ' + p.color);
    });
    if (S.metrics) {
      lines.push('  最近校验：Chamfer ' + S.metrics.chamfer + ' · 召回 ' + S.metrics.recall +
        ' · 精度 ' + S.metrics.precision + ' · 中位线宽 ' + S.metrics.medianWidth);
    }
    lines.push('  （位图只在前两轮随请求提供，之后按语义名与坐标工作，不要要求再看图。）');
    lines.push('  （系统事实，不是新指令；坐标只是标注。描绘：key + 控制点，用 vl_redraw_parts。）');
    lines.push('</FACTS>');
    return lines.join('\n');
  }

  var SYS = [
    '你是线稿重绘执行器。用户给你一组从位图提取出来的**线段中线**作为输入。',
    '这些线段只确定**分布**：哪里有东西、有多长、多粗、什么颜色。它们不是成品。',
    '你要做两件事：① 给每条线赋予语义；② 用自己给的控制点重绘精确曲线。',
    '',
    '## 硬规则',
    '1. 参考线只是输入。重绘一律用 vl_redraw_parts：{{RULE1}}',
    '2. {{RULE2}}',
    '3. 用户消息里附了框选区域的**位图**（等比缩小，和 strokes 同一坐标系）。先用它看懂画面是什么，再结合中线摘要定位几何。图里没有的东西不要编。',
    '4. 每条重绘的线都要给 name，**必须用中文**，格式是「主体·部位」：例如「企鹅·身体外轮廓」「企鹅·左翅」「字A·外框」。名字必须让人不看图也知道画的是什么；用英文命名、或用「左侧小环」这类纯几何叫法，都算失败。',
    '5. 程序负责坐标换算、{{FIT}}与落笔。你决定走向、线宽、颜色、顺序、语义。',
    '6. 每一步工具调用后都看返回值，失败了换参数，不要原样重试。',
    '7. vl_trace 会把已画的线全部作废。画布上已经有线时改参数会被拦截（返回 blocked）——那就先把图画完，不要反复重提取。一条线都没画时改口径同样会被拦截：先画，校验后再换。只有确认要推倒重来时才传 force:true；重提取后 key 会变，必须重新 vl_view_region 拿新 key。',
    '8. 第一次 vl_render_check 之前必须先把线画上去：画布空白时召回必然是 0，校验没有信息量。',
    '9. vl_redraw_parts 返回的 dev 是「你的控制点离参考线的中位距离（px）」。samples 是现成的，dev 正常应 < 0.5；超过 2 就说明你在猜，回去按 samples 传。',
    '10. 一次 vl_redraw_parts 最多 8 条，超过必须分多批调用（每批画完再画下一批）。把 ops 的 JSON 当成普通文本发出来不会被解析，等于一条都没画。',
    '11. vl_render_check 会返回 worst（逐条 miss / off，拖后腿的线）和 undrawn（还没画的线）。只看全局 Chamfer 就盲改是错的：先按 worst / undrawn 定位，再只改那几条。',
    '12. 每轮校验都会记下最好的一轮。指标变差时用 vl_restore_best 回滚，收口前也要确认当前不是比最好那轮更差。',
    '',
    '## 标准流程',
    '⓪ 先看图：一句话说清主体是什么（企鹅 / 字 / 人像 / 线稿），以及画面由哪几块组成。看错了后面全错。',
    '① vl_view_region 拿 samples → ② 逐条想语义名（主体·部位） → ③ {{FLOW}}',
    '④ vl_render_check',
    '⑤ Chamfer > 1.5 或召回 < 0.9：先判断是哪类线漏了/偏了（短碎段、细线、控制点太少），',
    '   用 vl_redraw_parts 补控制点重画，或用 vl_trace 换取线口径。仅当「几何已经对、只想改粗细颜色」才用 vl_draw_parts。',
    '⑥ 达标就 vl_finish。只要 Chamfer ≤ 1.5 且召回 ≥ 0.9，立刻收口，重画一遍不会更好。',
    '',
    '## 关于形态',
    '`auto`（默认）提取时按骨架长度 / 外接框周长与中位线宽自动选择下面两种，结果写在 FACTS 的 mode 与 auto 字段里；',
    '形态不需要你比较：先按当前参考线重绘，校验之后再决定要不要换口径（未画任何线时改动会被拦截）。',
    '`contour`（轮廓）给的是每个字形/图形的一圈闭合环，可能带内孔。它天生完整，',
    '不要把它拆成多段，也不要因为「这条线很长」就以为是错误。文字、实心笔画用这个。',
    '`center`（中线）给的是笔画骨架，交叉处会被切断，所以段数偏多、短段多；',
    '短段通常不是错误，是线的分叉与端点。',
    '`color`（色块，仅当取线源设为色块时）给的是**每个色块**的一圈外轮廓 + 内孔，颜色就是该块的平均色；',
    '填充按面积从大到小逐块盖上去。多色图标 / 插画用这个，不要按「暗线」口径去理解它——',
    '色块不是线，是面，不要试图给它们设线宽。',
    '色块模式按「部位」而不是「像素块」交付，顺序固定：vl_view_region → vl_group_parts（自动落笔）→ vl_redraw_parts（逐部位重画平滑曲线，每批 ≤8）→ vl_check_semantics → vl_finish。',
    '· 分组即落笔：几何已经是精确的区域边界，系统会自动复制，不需要再调 vl_draw_parts（draw:false 才需要手动画）。',
    '· 认部位看四项测量值：`tone`（白/黑/红/橙…）、`where`（上左/中中/下右）、`holes`（内孔数）、`area`（像素面积）。',
    '  眼白是「浅色 + 在头部 + 通常带 1 个孔（瞳孔）」；肚子里两侧的细长浅色条是描边残条，面积小又细长，不是眼睛。',
    '  面积只占几个百分点、形状是一条细带的块，先并进相邻部位或 drop，不要给它编一个独立部位名。',
    '· 分组：同一部位的碎块并成一组（围巾本体 + 阴影），给中文名「主体·部位」；',
    '  同级碎块各自填，只有整个套在另一块里面的成员才当孔洞挖掉（所以眼白 + 瞳孔要分成两组，不要并成一组）。',
    '· 组色默认**留空**：留空 = 沿用每块的实测原色，这是色彩还原的正确做法。',
    '  只有组内确实需要统一（同一色相被抗锯齿拆成几块）才给 color，且必须贴近实测色；',
    '  与实测差太远的组色会被程序拒收并在 colorFixed 里回报——不要靠改色去「修正」命名。',
    '· 丢弃：抗锯齿暗带、细窄残条、压缩噪点这类画出来只会是「混乱像素」的碎块，写进**顶层** `drop:[key,…]`（与 groups 平级）；',
    '  但眼睛、瞳孔、嘴、脚这类小件必须单独成组，不要当噪声丢掉，也不要并进身体。',
    '· 遮挡：先大后小（底板 → 身体 → 围巾/嘴/脚 → 眼睛 → 瞳孔），同一部位不要拆成多组。',
    '· 收口前必须调 vl_check_semantics：未分组块 0，duplicates 空，unnamed 0，colorFixed 空。',
    '  clash 只是提示：两块都大（占比 ≥1%）才需要拆开；细窄残条并进相邻部位看不出来，不必为它反复重分组。',
    '· 分组一次成型：除非 vl_check_semantics 报了 ungrouped / clash / colorFixed，否则不要再调 vl_group_parts 改名字。',
    '  名字错了但颜色和几何都对时，画面不会变；反复改名只烧轮次。',
    '分组落笔的是「区域边界」本身，像素台阶会原样保留，看起来就是歪歪扭扭的折线。',
    '所以分组之后必须用 vl_redraw_parts 按部位重画一遍：每个部位给 8~20 个控制点，',
    '按部位的整体形状画成平滑闭合曲线（身体是一圈、围巾是一条带），samples 只用来定位，不要逐像素照抄；',
    '一批最多 8 条，分多批画完。重画后旧指标作废，最后再 vl_render_check。',
  ].join('\n');

  /* 曲线形态的实验分组。auto=模型自选，bezier=B 组（模型给手柄），
   * poly=A 组对照（强制折线），fit=C 组（只给端点，手柄由程序最小二乘求）。 */
  var FORM_NOTES = {
    auto: [
      '## 两种重绘形态（自选）',
      '· 折线 `points`：折角多、短、细节线。',
      '· 贝塞尔 `form:"bezier"`：长而平滑的弧（头发外沿、衣褶、轮廓弧）。用 vl_view_region 给的 `breaks` 当段端点，',
      '  你只补每段的 `c1` / `c2` 手柄：手柄方向 = 该端点处的切线，长度不超过本段弦长的 0.85 倍（超过会被夹紧）。',
      '· 判断依据：看不出明显折角 → 贝塞尔；有明显尖角（字形、图标、直角）→ 折线。',
    ].join('\n'),
    bezier: [
      '## 本组固定：贝塞尔（B 组）',
      '所有线都用 `form:"bezier"`：`start` + `segs`（每段 `end` + `c1` / `c2`）。',
      '`breaks` 已经是切段建议，直接用；你只负责手柄的方向与长度（≤ 段弦长 0.85 倍）。不要用 `points`。',
    ].join('\n'),
    poly: [
      '## 本组固定：折线（A 组）',
      '所有线都用 `points` 折线（samples 原样回传），不要用 `form:"bezier"`。',
    ].join('\n'),
    fit: [
      '## 本组固定：程序拟合手柄（C 组）',
      '所有线都用 `form:"bezier"`，但你只给 `start` 与每段的 `end`（按 `breaks` 切段），**不要给 `c1` / `c2`**。',
      '手柄由程序用参考线做最小二乘求解；你只决定在哪切段、每条线是什么。',
    ].join('\n')
  };

  /* 分组时把「给几何」的口径整段换掉。真实运行暴露过：末尾的分组说明压不过开头的硬规则，
   * 模型 5 次重绘全部照旧传 points，一次 bezier 都没有。 */
  var GEOM = {
    auto: {
      rule1: 'key 指向参考线，points 是你给的控制点（3–128 个，相对区域 0–1000，与 samples 同口径）；长而平滑的弧也可以改用 form:"bezier" 给端点与手柄。',
      rule2: 'samples 是按形状抽稀好的轮廓顶点（最多 128 个），保形性已经验证过：直接把 samples 原样传回 points，不要删点、不要按角度重排、不要自己重算坐标。只有确实要改形状时才微调个别点。',
      fit: 'Catmull-Rom 拟合',
      flow: 'vl_redraw_parts（key + points + name + width + color + order）'
    },
    bezier: {
      rule1: '**必须**写 form:"bezier"，给 key + start + segs（每段 end 与 c1 / c2，坐标同样是 0–1000）；本组不要用 points。',
      rule2: 'breaks 是程序按目标段长（约 60px）切好的段端点，直接用，不要自己另选切点；你只决定每段手柄的方向与长度（长度 ≤ 本段弦长的 0.85 倍，超出会被夹紧）。',
      fit: '三次贝塞尔落笔',
      flow: 'vl_redraw_parts（key + form:"bezier" + start + segs + name + width + color + order）'
    },
    poly: {
      rule1: 'key + points（samples 原样回传）；本组不要用 form:"bezier"。',
      rule2: 'samples 是抽稀好的轮廓顶点，直接原样传回 points，不要删点、不要重排、不要重算坐标。',
      fit: 'Catmull-Rom 拟合',
      flow: 'vl_redraw_parts（key + points + name + width + color + order）'
    },
    fit: {
      rule1: '**必须**写 form:"bezier"，给 key + start + 每段 end（照 breaks 切段）；**不要给 c1 / c2**，也不要给 points。',
      rule2: 'breaks 是程序切好的段端点，直接用；手柄由程序按参考线做最小二乘求解，你只决定在哪切段、每条线是什么。',
      fit: '三次贝塞尔落笔（手柄由程序求）',
      flow: 'vl_redraw_parts（key + form:"bezier" + start + segs[只给 end] + name + width + color + order）'
    }
  };

  /* 工具描述也要跟着分组走：模型先读 description，口径不一致时它会按老的写 */
  var FORM_TOOL = {
    bezier: '精确重绘（本组固定贝塞尔）。必须写 form:"bezier"，给 start 与 segs[{end,c1,c2}]，坐标是相对区域 0–1000；不要传 points。手柄长度不超过本段弦长的 0.85 倍。',
    fit: '精确重绘（本组固定贝塞尔 + 程序拟合手柄）。必须写 form:"bezier"，给 start 与 segs[{end}]，不要给 c1 / c2、不要传 points；手柄由程序求解。',
    poly: '精确重绘（本组固定折线）。给 key + points（0–1000 控制点）+ name，不要用 form:"bezier"。'
  };

  function sysText() {
    var g = GEOM[S.form] || GEOM.auto;
    var base = SYS.replace('{{RULE1}}', g.rule1)
      .replace('{{RULE2}}', g.rule2)
      .replace('{{FIT}}', g.fit)
      .replace('{{FLOW}}', g.flow);
    return base + '\n\n' + (FORM_NOTES[S.form] || FORM_NOTES.auto);
  }

  function toolsFor(form) {
    if (!form || form === 'auto' || !FORM_TOOL[form]) return TOOLS;
    return TOOLS.map(function (t) {
      if (!t.function || t.function.name !== 'vl_redraw_parts') return t;
      var d = JSON.parse(JSON.stringify(t));
      d.function.description = FORM_TOOL[form];
      return d;
    });
  }

  /* ---------------- 界面 ---------------- */

  function note(text, warn) {
    var d = document.createElement('div');
    d.className = 'vl-say';
    if (warn) d.style.color = '#b4453a';
    d.textContent = text;
    R.sup.appendChild(d);
    R.sup.scrollTop = R.sup.scrollHeight;
    return d;
  }

  function setPhase(text, cls) {
    R.phase.textContent = text || '';
    R.phase.className = 'vl-phase' + (cls ? ' ' + cls : '');
  }

  function clearSup() {
    R.sup.innerHTML = '';
    R.metrics.hidden = true;
    R.round.textContent = '';
    S.calls = [];
  }

  function addToolCard(name, args) {
    var el = document.createElement('div');
    el.className = 'vl-tool';
    el.dataset.tool = name;
    el.innerHTML =
      '<div class="vl-tool-h"><span class="vl-tool-name">' + esc(name) + '</span>' +
      '<span class="vl-chip">执行中</span><span class="vl-tool-ms"></span></div>' +
      '<div class="vl-tool-a">' + esc(JSON.stringify(args || {}).slice(0, 220)) + '</div>' +
      '<div class="vl-tool-r" hidden></div>';
    R.sup.appendChild(el);
    R.sup.scrollTop = R.sup.scrollHeight;
    S.openCard = el;
    return el;
  }

  function fillToolCard(el, rec) {
    if (!el) return;
    var chip = el.querySelector('.vl-chip');
    var ms = el.querySelector('.vl-tool-ms');
    var box = el.querySelector('.vl-tool-r');
    if (ms) ms.textContent = (rec.ms || 0) + 'ms';
    if (chip) {
      chip.textContent = rec.error ? '失败' : 'ok';
      chip.className = 'vl-chip ' + (rec.error ? 'err' : 'ok');
    }
    if (box) {
      box.hidden = false;
      box.textContent = (rec.error ? ('错误：' + rec.error) : JSON.stringify(rec.result)).slice(0, 320);
    }
    R.sup.scrollTop = R.sup.scrollHeight;
  }

  function showMetrics(m) {
    if (!m) return;
    function cls(v, good, bad, reverse) {
      if (v == null) return '';
      if (reverse) return v <= good ? 'is-good' : (v >= bad ? 'is-bad' : 'is-warn');
      return v >= good ? 'is-good' : (v <= bad ? 'is-bad' : 'is-warn');
    }
    R.metrics.hidden = false;
    var note = [];
    if (m.bestChamfer != null && m.bestRound != null) {
      note.push('<span class="vl-tag is-good">最好 ' + m.bestChamfer + ' · 第 ' + (m.bestRound + 1) + ' 轮</span>');
    }
    if (m.noProgress) note.push('<span class="vl-tag is-bad">比最好那轮差 · 可回滚</span>');
    if (m.chamferP95 != null) note.push('<span class="vl-tag">P95 ' + m.chamferP95 + '</span>');
    if (m.drawn != null) note.push('<span class="vl-tag">已画 ' + m.drawn + '/' + m.total + '</span>');
    if (m.undrawn && m.undrawn.length) note.push('<span class="vl-tag is-warn">未画 ' + m.undrawn.length + '</span>');
    R.metrics.innerHTML =
      '<div class="vl-metric-grid">' +
        '<div class="vl-metric ' + cls(m.chamfer, 1.5, 3, true) + '"><b>' + (m.chamfer != null ? m.chamfer : '—') + '</b><span>Chamfer px</span></div>' +
        '<div class="vl-metric ' + cls(m.recall, 0.9, 0.7) + '"><b>' + (m.recall != null ? round3(m.recall) : '—') + '</b><span>召回</span></div>' +
        '<div class="vl-metric ' + cls(m.precision, 0.9, 0.7) + '"><b>' + (m.precision != null ? round3(m.precision) : '—') + '</b><span>精度</span></div>' +
        '<div class="vl-metric"><b>' + (m.medianWidth != null ? m.medianWidth : '—') + '</b><span>中位线宽</span></div>' +
      '</div>' +
      (note.length ? '<div class="vl-metric-note">' + note.join('') + '</div>' : '');
  }

  function renderParts() {
    if (!R.partsList) return;
    R.partsN.textContent = String(S.strokes.length);
    if (!S.strokes.length) {
      R.partsList.innerHTML = '<div class="vl-none">还没有线段。先载入图片并提取。</div>';
      R.legend.innerHTML = '';
      if (R.layers) { R.layers.hidden = true; R.layers.innerHTML = ''; }
      return;
    }
    /* 图层 = 语义组。组名、颜色、包含几块都列出来，点一行单独隐藏/显示，
     * 用来核对每个部位各自的形状，而不是只能看一张糊在一起的画。 */
    if (R.layers) {
      if (!S.layers.length) {
        R.layers.hidden = true; R.layers.innerHTML = '';
      } else {
        R.layers.hidden = false;
        R.layers.innerHTML = '<div class="vl-legend-t">图层</div>' + S.layers.map(function (l) {
          var off = !!S.hidden[l.id];
          return '<div class="vl-part' + (off ? ' is-off' : '') + '" data-layer="' + esc(l.id) + '">' +
            '<span class="vl-sw" style="background:' + esc(l.color) + '"></span>' +
            '<div class="vl-part-main"><div class="vl-part-name">' + esc(l.name) + '</div>' +
            '<div class="vl-part-meta"><span>' + l.keys.length + ' 块</span><span>' + (off ? '已隐藏' : '显示中') + '</span></div></div>' +
            '</div>';
        }).join('');
      }
    }
    R.partsList.innerHTML = S.strokes.map(function (p) {
      var src = p.source === 'user' ? '手改' : (p.source === 'model' ? '模型' : (p.source === 'llm' ? '模型' : '默认'));
      var drawn = S.ops.has(p.key);
      return '<div class="vl-part' + (p.key === S.activeKey ? ' is-on' : '') + '" data-key="' + esc(p.key) + '">' +
        '<span class="vl-sw" style="background:' + esc(p.color) + '"></span>' +
        '<div class="vl-part-main">' +
          '<input class="vl-name" data-name="' + esc(p.key) + '" value="' + esc(partName(p)) + '">' +
          '<div class="vl-part-meta"><span>长 ' + Math.round(p.length) + '</span><span>宽 ' + round2(p.width) +
          '</span><span>' + p.anchors + ' 锚点</span><span class="vl-src">' + src + '</span></div>' +
        '</div>' +
        '<span class="vl-state' + (drawn ? ' is-drawn' : '') + '">' + (drawn ? '已画' : '参考') + '</span>' +
        '</div>';
    }).join('');

    R.legend.innerHTML = '<div class="vl-legend-t">参考线</div>' + S.strokes.slice(0, 5).map(function (p) {
      return '<div class="vl-legend-row"><i style="background:' + esc(p.color) + '"></i>' +
        esc(partName(p)) + ' 长' + Math.round(p.length) + '</div>';
    }).join('');
  }

  function updateStat() {
    if (!R.stat) return;
    R.stat.textContent = S.img
      ? (S.imgName + ' · ' + S.w + '×' + S.h +
        (S.region ? (' · 区域 ' + Math.round(S.region.w) + '×' + Math.round(S.region.h)) : '') +
        (S.lastMode ? (' · ' + (S.lastMode === 'contour' ? '轮廓' : S.lastMode === 'dark' ? '中线·暗线' : '中线·边缘')) : '') +
        (S.strokes.length ? (' · 已描绘 ' + S.ops.size + '/' + S.strokes.length) : ''))
      : '未载入图像';
    if (R.dot) {
      R.dot.className = 'vl-dot' + (S.busy ? ' is-live' : (S.img ? ' is-ready' : ''));
    }
  }

  function setBusyUI(on) {
    var open = R.wrap.querySelector('[data-act="open"]');
    var run = R.wrap.querySelector('[data-act="run"]');
    var stop = R.wrap.querySelector('[data-act="stop"]');
    var ext = R.wrap.querySelector('[data-act="extract"]');
    if (open) open.disabled = on;
    if (run) run.disabled = on;
    if (ext) ext.disabled = on;
    if (stop) stop.disabled = !on;
  }

  function readOpts() {
    if (R.shape) S.opt.shape = R.shape.value;
    if (R.src) S.opt.src = R.src.value;
    if (R.threshold) S.opt.threshold = Number(R.threshold.value);
    if (R.simplify) S.opt.simplify = Number(R.simplify.value);
    if (R.minLen) S.opt.minLen = Number(R.minLen.value);
    if (R.fill) S.opt.fill = !!R.fill.checked;
    if (R.thresholdV) R.thresholdV.textContent = String(S.opt.threshold);
    if (R.simplifyV) R.simplifyV.textContent = String(S.opt.simplify);
    if (R.minLenV) R.minLenV.textContent = String(S.opt.minLen);
  }

  /* ---------------- 主流程 ---------------- */

  async function startRedraw(variantId) {
    if (S.busy) return;
    if (!S.img) { setPhase('先载入图片', 'is-err'); return; }
    if (!S.strokes.length) extractStrokes();

    var conn = null;
    try { conn = (typeof llmConn === 'function') ? llmConn() : null; } catch (e) { conn = null; }
    if (!conn && !S.stub) {
      setPhase('未配置语言模型', 'is-err');
      note('还没有可用的语言模型。去「设置」里填接口地址 / Key / 模型，或登录云端账号。', true);
      return;
    }

    readOpts();
    S.busy = true; S.ctrl = new AbortController(); S.variant = variantId || '';
    S.metrics = null; S.best = null;
    /* 每次运行从空白开始：画布上的实线只能是这一轮模型自己画的 */
    S.ops = new Map();
    drawScene();
    clearSup();
    setBusyUI(true);
    setPhase('思考中…', 'is-run');
    S.round = 0;
    R.round.textContent = '';
    switchTab('sup');

    var t0 = Date.now();
    var roundBubble = null;
    var res = null, err = null, review = '';
    /* 位图必须随第一条消息发出去：矢量只说明墨在哪，认出「企鹅」只能靠看图。 */
    var firstContent = [{
      type: 'text',
      text: '框选区域已提取 ' + S.strokes.length + ' 条参考线。附是该区域的原始位图（等比缩小，坐标与 strokes 一致）。先看清主体是什么，再逐条命名并重绘。'
    }];
    var shot = regionImageURL(768);
    if (shot) firstContent.push({ type: 'image_url', image_url: { url: shot } });
    try {
      res = await toolLoopRun({
        sys: sysText(),
        messages: [{ role: 'user', content: firstContent }],
        tools: toolsFor(S.form),
        maxRounds: 8,
        keepRounds: 2,
        /* 位图只在首两轮随请求发出：后面每轮都重发同一张图，输入费用按轮次线性涨 */
        stripImagesAfterRound: 2,
        app: 'visionlab',
        conn: conn,
        signal: S.ctrl.signal,
        executor: execTool,
        digest: digestOf,
        digestArgs: digestArgsOf,
        facts: factsCard,
        onDelta: function (acc, delta) {
          if (!roundBubble) {
            roundBubble = document.createElement('div');
            roundBubble.className = 'vl-say';
            R.sup.appendChild(roundBubble);
          }
          /* llmStreamRequest 的第一个参数是累计全文，第二个才是增量。
           * 以前按增量拼累计值，长回答会指数级膨胀。 */
          roundBubble.textContent = (typeof acc === 'string' && acc)
            ? acc
            : ((roundBubble.textContent || '') + (delta || ''));
          R.sup.scrollTop = R.sup.scrollHeight;
        },
        onRound: function (r) {
          S.round = r.round;
          R.round.textContent = r.phase === 'final' ? '收口轮'
            : ('第 ' + (r.round + 1) + ' 轮' + (r.maxRounds != null ? ' / ' + (r.maxRounds + 1) : ''));
          roundBubble = null;
          if (r.phase === 'request') setPhase('第 ' + (r.round + 1) + ' 轮：请求中', 'is-run');
          if (r.phase === 'tools') setPhase('第 ' + (r.round + 1) + ' 轮：执行工具', 'is-run');
        },
        onToolStart: function (c) { addToolCard(c.name, c.args); },
        onTool: function (rec) {
          S.calls.push({ name: rec.name, args: rec.args, ms: rec.ms, error: rec.error || '', result: rec.result });
          fillToolCard(S.openCard, rec);
        }
      });
      /* 模型 force 重提取把线全清了、又没来得及重画：最好一轮别丢（快照里是模型自己画的线） */
      if (!S.ops.size && S.best) {
        try {
          restoreBest();
          note('结束时画布为空，已自动回到最好一轮（Chamfer ' + (S.metrics ? S.metrics.chamfer : '?') + '）。');
        } catch (e4) {}
      }
      /* 模型最后一笔常常就是重绘；此时指标被清空，收口前补算一次，别让监督页停在「无指标」 */
      if (!S.metrics && S.ops.size) { try { renderCheck(); } catch (e2) {} }
      if (res && res.exhausted) note('达到工具轮次上限，已强制收口。');
      if (res && res.text) note(String(res.text));
      if (res && res.requests) {
        /* 字符数不是 token：各家中转口径不同，只有「相对大小」是可靠的。
         * 中文约 1.5 字/token、JSON 坐标约 3 字/token，这里按 2.5 粗估。 */
        note('本次 ' + res.requests + ' 次请求，上下文合计 ' + fmtK(res.ctxChars) +
          ' 字符（≈' + fmtK(Math.round((res.ctxChars || 0) / 2.5)) + ' tokens，粗估）。');
      }
      review = await askReview(res, conn);
    } catch (e) {
      err = e;
      var msg = String((e && e.message) || e);
      if (/abort|停止/i.test(msg) && S.ctrl && S.ctrl.signal.aborted) {
        setPhase('已停止', 'is-err');
        note('已停止。');
      } else {
        /* 与正常结束同一口径：画布被清空时先回滚最好一轮，再判断是否收口 */
        if (!S.ops.size && S.best) { try { restoreBest(); } catch (e5) {} }
        if (!S.metrics && S.ops.size) { try { renderCheck(); } catch (e3) {} }
        if (S.calls.length && S.metrics) {
          setPhase('已收口 · Chamfer ' + S.metrics.chamfer, 'is-run');
          note('模型最后一轮没有给出结论（' + msg + '），已按当前描绘结果收口。');
          err = null;
        } else {
          setPhase('出错', 'is-err');
          note('出错：' + msg, true);
        }
      }
    } finally {
      S.busy = false; S.ctrl = null;
      setBusyUI(false);
      if (!err) setPhase(S.metrics ? ('完成 · Chamfer ' + S.metrics.chamfer) : '完成', 'is-run');

      S.runs.unshift({
        ts: new Date().toISOString(),
        variant: variantId || '手控',
        params: Object.assign({}, S.opt),
        mode: S.lastMode,
        strokes: S.strokes.length,
        rounds: res ? res.rounds : S.round,
        calls: (res && res.calls) ? res.calls.length : S.calls.length,
        chamfer: S.metrics ? S.metrics.chamfer : null,
        recall: S.metrics ? S.metrics.recall : null,
        precision: S.metrics ? S.metrics.precision : null,
        width: S.metrics ? S.metrics.medianWidth : null,
        ms: Date.now() - t0,
        requests: res && res.requests != null ? res.requests : null,
        ctxChars: res && res.ctxChars != null ? res.ctxChars : null,
        review: review || '',
        error: err ? String((err && err.message) || err) : ''
      });
      if (S.runs.length > 30) S.runs.pop();
      saveRuns(); renderRuns(); renderParts(); drawScene();
    }
  }

  /* 跑完复盘：循环内的上下文只有最近两轮原文，所以退出后单独发一条请求
   * （只挂一个 vl_review 工具），输入是这一轮的压缩账本 + 失败记录 + 最终指标，
   * 让它以使用者身份指出工具哪里难用。用 ledger 而不是回放全量消息，成本只有几百 token。 */
  async function askReview(res, conn) {
    if (S.stub || !res || !res.calls || !res.calls.length) return '';
    var mem = res.memory || {};
    var m = S.metrics;
    var fact = m
      ? ('Chamfer ' + m.chamfer + ' / 召回 ' + m.recall + ' / 精度 ' + m.precision + ' / 中位线宽 ' + m.medianWidth)
      : '未校验';
    var ask = [
      '这一轮重绘已经结束。下面是你刚才的调用账本与最终指标，不要继续画。',
      '<WORK_LOG>', (mem.ledger || []).join('\n') || '(空)', '</WORK_LOG>',
      '<REJECTED>', (mem.negatives || []).join('\n') || '(无)', '</REJECTED>',
      '曲线口径：' + S.form + '；参考线 ' + S.strokes.length + ' 条，已描绘 ' + S.ops.size + ' 条；最终 ' + fact + '。',
      '',
      '请以「刚用过这套工具的人」的身份复盘，只通过 vl_review 工具提交，不要写正文：',
      'friction 至少 2 条，每条要引用账本里的具体数字或返回字段；missing 写最缺的一个能力；keep 写最该保留的一条设定。'
    ].join('\n');
    /* 复盘也走工具调用：这台中转在「自由续写」上会退化成逐字加长的重复
     * （实测把「最难用的一步：」重复了上千次，输出 600KB），而工具参数没出现过这个问题。 */
    var tool = {
      type: 'function',
      function: {
        name: 'vl_review',
        description: '提交本轮工具使用的复盘',
        parameters: {
          type: 'object',
          properties: {
            friction: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string', description: '工具名或指令条目' },
                  what: { type: 'string', description: '哪里难用 / 哪里自相矛盾' },
                  evidence: { type: 'string', description: '账本里的具体数字或返回字段' },
                  fix: { type: 'string', description: '具体改法' }
                },
                required: ['tool', 'what', 'fix']
              }
            },
            missing: { type: 'string', description: '最缺的一个能力' },
            keep: { type: 'string', description: '最该保留的一条设定' }
          },
          required: ['friction', 'missing', 'keep']
        }
      }
    };
    var out = null;
    try {
      out = await llmStreamRequest('', [{ role: 'user', content: ask }], function () {},
        { conn: conn, app: 'visionlab', tools: [tool] });
    } catch (e) { return ''; }
    var calls = (out && Array.isArray(out.toolCalls)) ? out.toolCalls : [];
    if (!calls.length) return '';
    var args = null;
    try { args = JSON.parse(calls[0].function.arguments || '{}'); } catch (e) { args = null; }
    if (!args) return '';
    var txt = JSON.stringify(args);
    S.lastReview = txt;
    note('【模型复盘】' + txt);
    return txt;
  }

  function stopRun() { if (S.ctrl) S.ctrl.abort(); }

  /* ---------------- 实验 ---------------- */

  var VARIANTS = [
    { id: 'A', name: 'A 轮廓基线', desc: '轮廓模式（每字一圈闭合环），抽稀 0.5。文字 / 实心笔画首选。', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } },
    { id: 'B', name: 'B 轮廓强抽稀', desc: '轮廓 + 抽稀 1.8：锚点少、折角明显。检验可读性的锚点下限。', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 1.8, minLen: 8 } },
    { id: 'C', name: 'C 轮廓弱抽稀', desc: '轮廓 + 抽稀 0.3：锚点多、最贴边。与 B 形成锚点预算对照。', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.3, minLen: 8 } },
    { id: 'D', name: 'D 中线基线', desc: '中线 + 线宽，阈值 20、抽稀 0.8。单线手绘 / 线稿用它。', opt: { shape: 'center', src: 'auto', threshold: 20, simplify: 0.8, minLen: 8 } },
    { id: 'E', name: 'E 中线低阈值', desc: '中线 + 阈值 12，抓更多淡线。检验召回与碎段数量的取舍。', opt: { shape: 'center', src: 'auto', threshold: 12, simplify: 0.8, minLen: 8 } },
    { id: 'F', name: 'F 中线强抽稀', desc: '中线 + 抽稀 1.8，锚点少。检验几何精度下限与 Chamfer 的关系。', opt: { shape: 'center', src: 'auto', threshold: 20, simplify: 1.8, minLen: 8 } },
    { id: 'G', name: 'G 贝塞尔（B 组）', desc: '强制 form:bezier：模型给端点与手柄，程序直接落三次贝塞尔。对照曲线表示法。', form: 'bezier', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } },
    { id: 'H', name: 'H 折线（A 组）', desc: '强制 points 折线 + Catmull-Rom。与 G 同图同参，只差曲线表示法。', form: 'poly', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } },
    { id: 'I', name: 'I 程序拟合手柄（C 组）', desc: '模型只给端点（按 breaks 切段），手柄由程序最小二乘求。用来分离「模型判断」与「程序拟合」。', form: 'fit', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } }
  ];

  function applyVariant(v) {
    S.form = v.form || 'auto';
    Object.keys(v.opt).forEach(function (k) { S.opt[k] = v.opt[k]; });
    if (R.shape) R.shape.value = S.opt.shape;
    if (R.src) R.src.value = S.opt.src;
    if (R.threshold) R.threshold.value = String(S.opt.threshold);
    if (R.simplify) R.simplify.value = String(S.opt.simplify);
    if (R.minLen) R.minLen.value = String(S.opt.minLen);
    readOpts();
    extractStrokes();
  }

  function renderVariants() {
    if (!R.variants) return;
    R.variants.innerHTML = VARIANTS.map(function (v, i) {
      return '<div class="vl-variant">' +
        '<span class="vl-variant-no">' + (i + 1) + '</span>' +
        '<div class="vl-variant-body"><div class="vl-variant-t">' + esc(v.name) + '</div>' +
        '<div class="vl-variant-d">' + esc(v.desc) + '</div></div>' +
        '<button type="button" class="vl-btn" data-variant="' + v.id + '">跑</button></div>';
    }).join('');
  }

  async function runVariant(id) {
    var v = VARIANTS.filter(function (x) { return x.id === id; })[0];
    if (!v) return;
    if (!S.img) { setPhase('先载入图片', 'is-err'); switchTab('sup'); return; }
    applyVariant(v);
    await startRedraw(v.id);
  }

  function renderRuns() {
    if (!R.runs) return;
    if (!S.runs.length) {
      R.runs.innerHTML = '<div class="vl-none">还没有记录。跑一次重绘后这里会出现指标。</div>';
      return;
    }
    R.runs.innerHTML = '<div class="vl-runs-h"><span>方案</span><span>时间 / 调用 / 上下文</span><span>Chamfer</span></div>' +
      S.runs.map(function (r) {
        var t = String(r.ts || '').slice(11, 19);
        var ctx = r.ctxChars ? ' / ≈' + fmtK(Math.round(r.ctxChars / 2.5)) + 't' : '';
        return '<div class="vl-run"><b>' + esc(r.variant) + '</b><span>' + t + ' · ' + r.strokes + '段/' + r.calls + '调用' + ctx + '</span>' +
          '<span class="vl-run-ch">' + (r.chamfer == null ? '—' : r.chamfer) + '</span></div>';
      }).join('');
  }

  function saveRuns() {
    if (/[?&]nostore=1/.test(location.search)) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S.runs.slice(0, 30))); } catch (e) {}
  }
  function loadRuns() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) S.runs = JSON.parse(raw) || [];
    } catch (e) { S.runs = []; }
  }

  function exportRun() {
    var data = {
      tool: 'visionlab',
      kind: 'line',
      at: new Date().toISOString(),
      image: { name: S.imgName, w: S.w, h: S.h },
      region: S.region,
      params: S.opt,
      mode: S.lastMode,
      strokes: S.strokes.map(strokeBrief),
      metrics: S.metrics,
      runs: S.runs
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'visionlab-line-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    note('已导出运行记录 JSON。');
  }

  /* ---------------- 交互 ---------------- */

  function switchTab(name) {
    R.wrap.querySelectorAll('.vl-tab').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.tab === name);
    });
    R.wrap.querySelectorAll('.vl-pane').forEach(function (p) {
      p.hidden = p.dataset.pane !== name;
    });
  }

  function bindCanvas() {
    CV.addEventListener('pointerdown', function (ev) {
      if (!S.img || S.busy) return;
      CV.setPointerCapture(ev.pointerId);
      var cp = canvasPt(ev);
      if (ev.shiftKey || ev.button === 1) {
        S.drag = { mode: 'pan', x: cp[0], y: cp[1], ox: S.view.ox, oy: S.view.oy };
        return;
      }
      if (ev.button !== 0) return;
      var ip = toImg(cp[0], cp[1]);
      if (S.ckpt) {
        /* 控制点模式：优先抓最近的控制点，抓空了不重提取（避免误把选区清掉） */
        var hit = nearestAnchor(ip);
        if (hit) { S.drag = { mode: 'ckpt', key: hit.key, idx: hit.idx, moved: false }; return; }
        return;
      }
      S.drag = { mode: 'rect', x0: clamp(ip[0], 0, S.w), y0: clamp(ip[1], 0, S.h), rect: null };
      drawScene();
    });

    CV.addEventListener('pointermove', function (ev) {
      if (!S.drag) return;
      var cp = canvasPt(ev);
      if (S.drag.mode === 'pan') {
        S.view.ox = S.drag.ox + (cp[0] - S.drag.x);
        S.view.oy = S.drag.oy + (cp[1] - S.drag.y);
        drawScene();
        return;
      }
      var ip = toImg(cp[0], cp[1]);
      if (S.drag.mode === 'ckpt') {
        var part = S.strokes.filter(function (q) { return q.key === S.drag.key; })[0];
        if (part && part.path[S.drag.idx]) {
          part.path[S.drag.idx] = [clamp(ip[0], 0, S.w), clamp(ip[1], 0, S.h)];
          part.bbox = bboxOfPath(part.path);
          if (part.region) part.bez = fitBezLoop(part.path, part.tol || 2);
          S.drag.moved = true;
          drawScene();
        }
        return;
      }
      var x0 = S.drag.x0, y0 = S.drag.y0;
      var x1 = clamp(ip[0], 0, S.w), y1 = clamp(ip[1], 0, S.h);
      S.drag.rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      drawScene();
    });

    CV.addEventListener('pointerup', function () {
      if (!S.drag) return;
      var d = S.drag;
      S.drag = null;
      if (d.mode === 'ckpt') {
        if (d.moved) {
          /* 几何改了，旧指标就不再对应这张图，先清掉等下一次回读 */
          S.metrics = null; S.best = null;
          R.metrics.hidden = true;
          renderParts();
          note('控制点已调整。点「回读校验」或「监督重绘」再量一次 Chamfer。');
        }
        drawScene();
        return;
      }
      if (d.mode === 'rect' && d.rect && d.rect.w >= 6 && d.rect.h >= 6) {
        S.region = {
          x: Math.round(d.rect.x), y: Math.round(d.rect.y),
          w: Math.round(d.rect.w), h: Math.round(d.rect.h)
        };
        updateStat();
        extractStrokes();
      }
      drawScene();
    });

    CV.addEventListener('wheel', function (ev) {
      if (!S.img) return;
      ev.preventDefault();
      var cp = canvasPt(ev);
      var before = toImg(cp[0], cp[1]);
      var k = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      S.view.s = clamp(S.view.s * k, 0.05, 12);
      S.view.ox = cp[0] - before[0] * S.view.s;
      S.view.oy = cp[1] - before[1] * S.view.s;
      S.zoomed = true;
      drawScene();
    }, { passive: false });
  }

  function bindStage() {
    R.stage.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    R.stage.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) loadFile(f).catch(function (e) { note(e.message, true); });
    });
    document.addEventListener('paste', function (ev) {
      if (R.wrap.offsetParent === null) return;
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { loadFile(f).catch(function (e) { note(e.message, true); }); ev.preventDefault(); }
          break;
        }
      }
    });
  }

  function bindUI() {
    R.wrap.addEventListener('click', function (ev) {
      var act = ev.target.closest('[data-act]');
      if (act) {
        var a = act.dataset.act;
        if (a === 'open') R.file.click();
        else if (a === 'only') {
          S.onlyDraw = !S.onlyDraw;
          act.classList.toggle('is-on', S.onlyDraw);
          drawScene();
        }
        else if (a === 'ckpt') {
          /* 控制点模式：画布上的锚点可以直接拖，拖完几何就是新的。
           * 和「框选提取」冲突，所以做成互斥的开关，而不是常驻。 */
          S.ckpt = !S.ckpt;
          act.classList.toggle('is-on', S.ckpt);
          drawScene();
          note(S.ckpt ? '控制点模式：拖动圆点即可改曲线，改动只影响几何。'
            : '已退出控制点模式。');
        }
        else if (a === 'extract') extractStrokes();
        else if (a === 'reset') {
          /* 清空描绘：把画布还给「参考线」，不替模型补画 */
          S.ops = new Map();
          S.metrics = null; S.best = null; R.metrics.hidden = true;
          drawScene(); renderParts(); updateStat();
          note('已清空描绘。画布上剩下的淡虚线只是参考，不是成品。');
        } else if (a === 'run') startRedraw('');
        else if (a === 'stop') stopRun();
        else if (a === 'export') exportRun();
        return;
      }
      var tab = ev.target.closest('.vl-tab');
      if (tab) { switchTab(tab.dataset.tab); return; }
      var vbtn = ev.target.closest('[data-variant]');
      if (vbtn) { runVariant(vbtn.dataset.variant); return; }
      var part = ev.target.closest('.vl-part');
      if (part && !ev.target.closest('.vl-name')) {
        S.activeKey = S.activeKey === part.dataset.key ? '' : part.dataset.key;
        renderParts(); drawScene();
      }
    });

    R.file.addEventListener('change', function () {
      var f = R.file.files && R.file.files[0];
      if (f) loadFile(f).catch(function (e) { note(e.message, true); });
      R.file.value = '';
    });

    R.partsList.addEventListener('change', function (ev) {
      var inp = ev.target.closest('[data-name]');
      if (!inp) return;
      var key = inp.dataset.name;
      var val = inp.value.trim();
      if (!val) return;
      setLex(key, val, '', 'user', 1);
      renderParts();
    });

    if (R.layers) {
      R.layers.addEventListener('click', function (ev) {
        var row = ev.target.closest('[data-layer]');
        if (!row) return;
        var id = row.dataset.layer;
        S.hidden[id] = !S.hidden[id];
        renderParts(); drawScene();
      });
    }

    ['threshold', 'simplify', 'minLen'].forEach(function (k) {
      var el = R[k];
      if (!el) return;
      el.addEventListener('input', function () { readOpts(); });
      el.addEventListener('change', function () { readOpts(); if (S.img) extractStrokes(); });
    });
    if (R.src) R.src.addEventListener('change', function () { readOpts(); if (S.img) extractStrokes(); });
    if (R.shape) R.shape.addEventListener('change', function () { readOpts(); if (S.img) extractStrokes(); });
    if (R.fill) R.fill.addEventListener('change', function () {
      readOpts(); drawScene();
      /* 填色改变「画出来的面积」，指标要跟着重算，否则监督页停在旧口径 */
      if (S.ops.size) renderCheck();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(syncStage).observe(R.stage);
    } else {
      window.addEventListener('resize', syncStage);
    }
  }

  /* ---------------- 注册 ---------------- */

  registerApp({
    id: 'visionlab',
    name: '线稿重绘台',
    title: '线稿重绘台 · 中线 + 线宽',
    sub: '从位图提中线与线宽，监督模型重新描绘线稿并回读 Chamfer',
    order: 95,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 17c4-1 5-9 9-9s5 8 9 7"/><path d="M3 12h3M18 12h3"/>' +
      '<circle cx="7" cy="6" r="1.2"/><circle cx="17" cy="6" r="1.2"/></svg>',
    css: ['apps/visionlab/app.css'],
    body: window.VL_BODY,

    mount: function (body) {
      R.wrap = body.querySelector('.vl-wrap');
      ['stage', 'canvas', 'empty', 'legend', 'stat', 'dot', 'file', 'partsList', 'partsN', 'layers',
        'phase', 'round', 'metrics', 'sup', 'variants', 'runs',
        'shape', 'src', 'threshold', 'thresholdV', 'simplify', 'simplifyV', 'minLen', 'minLenV', 'fill'
      ].forEach(function (k) { R[k] = body.querySelector('[data-ref="' + k + '"]'); });

      CV = R.canvas;
      CTX = CV.getContext('2d');
      S.ready = true;

      if (body.dataset.ready === '1') {
        resizeCanvas(); fitView(); drawScene(); renderParts(); updateStat();
        return;
      }
      body.dataset.ready = '1';

      loadRuns();
      renderVariants();
      renderRuns();
      readOpts();
      resizeCanvas();
      bindCanvas();
      bindStage();
      bindUI();
      drawScene();
      setPhase('待命', '');
    }
  });

  /* ---------------- 测试钩子 ---------------- */

  window.vlLab = {
    __debug: function () {
      return {
        ready: S.ready,
        visible: !!(R.wrap && R.wrap.offsetParent !== null),
        image: !!S.img,
        w: S.w, h: S.h,
        view: { s: S.view.s, ox: S.view.ox, oy: S.view.oy },
        ckpt: S.ckpt,
        region: S.region,
        strokes: S.strokes.length,
        mode: S.lastMode,
        auto: S.autoStats || null,
        drawn: sortedOps().length,
        metrics: S.metrics,
        runs: S.runs.length,
        calls: S.calls.length,
        busy: S.busy,
        stub: S.stub,
        opts: Object.assign({}, S.opt)
      };
    },
    __test: {
      loadDemo: function () { return loadDemo(); },
      loadFile: function (f) { return loadFile(f); },
      loadDataURL: function (url) {
        return new Promise(function (res, rej) {
          var img = new Image();
          img.onload = function () { setImage(img, 'pasted'); res(true); };
          img.onerror = function () { rej(new Error('图片解码失败')); };
          img.src = url;
        });
      },
      setOnly: function (v) { S.onlyDraw = !!v; drawScene(); return S.onlyDraw; },
      setOpt: function (o) {
        Object.keys(o || {}).forEach(function (k) { if (k in S.opt) S.opt[k] = o[k]; });
        /* 先写 DOM 再读回来：readOpts 会从控件取值，反过来会把刚设的值盖掉 */
        if (R.shape) R.shape.value = S.opt.shape;
        if (R.src) R.src.value = S.opt.src;
        if (R.threshold) R.threshold.value = String(S.opt.threshold);
        if (R.simplify) R.simplify.value = String(S.opt.simplify);
        if (R.minLen) R.minLen.value = String(S.opt.minLen);
        if (R.fill) R.fill.checked = !!S.opt.fill;
        readOpts();
        return Object.assign({}, S.opt);
      },
      setRegion: function (r) { S.region = r; updateStat(); return extractStrokes(); },
      extract: function () { return extractStrokes(); },
      autoDraw: function () {
        return drawStrokes({
          ops: S.strokes.map(function (p, i) {
            return { key: p.key, width: p.width, color: p.color, order: i };
          })
        });
      },
      bez: function (key) {
        var p = S.strokes.filter(function (x) { return x.key === key; })[0];
        if (!p) return null;
        return { tol: p.tol, segs: (p.bez || []).length, holeSegs: (p.holeBez || []).map(function (a) { return a.length; }),
          first: (p.bez || [])[0] };
      },
      check: function () { return renderCheck(); },
      parts: function () { return S.strokes.map(strokeBrief); },
      path: function (key) {
        var p = S.strokes.filter(function (x) { return x.key === key; })[0]
          || S.strokes.filter(function (x) { return x.key === S.activeKey; })[0]
          || S.strokes[0];
        if (!p) return null;
        var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
        return {
          key: p.key, points: p.path.length, anchors: p.anchors,
          closed: !!p.closed, source: p.source, redrawn: !!p.redrawn,
          bbox: p.bbox, width: p.width, name: partName(p),
          /* 与 vl_view_region 同口径：相对区域 0–1000 */
          samples: controlSamples(p.path, p.closed, sampleCount(p)).map(function (q) {
            return [Math.round((q[0] - r.x) / Math.max(1, r.w) * 1000),
              Math.round((q[1] - r.y) / Math.max(1, r.h) * 1000)];
          }),
          head: p.path.slice(0, 3),
          form: p.form || '',
          breaks: (function () {
            var bk = bezierBreaks(p.path, p.closed, 16);
            return bk ? { segs: bk.segs, points: bk.breaks.map(normPx) } : null;
          })()
        };
      },
      setForm: function (f) { S.form = FORM_NOTES[f] ? f : 'auto'; return S.form; },
      /* 探针用它验证：分组提示词里不能残留 {{...}} 占位符 */
      sys: function () { return sysText(); },
      tools: function (f) { return toolsFor(f || S.form); },
      lastReview: function () { return S.lastReview || ''; },
      best: function () { return S.best ? { round: S.best.round, chamfer: S.best.m.chamfer } : null; },
      restoreBest: function () { return restoreBest(); },
      region: function () { return S.region; },
      raw: function (key) {
        var p = S.strokes.filter(function (x) { return x.key === key; })[0] || S.strokes[0];
        return p ? { key: p.key, closed: !!p.closed, width: p.width, path: p.path } : null;
      },
      redraw: function (args) { return redrawParts(args); },
      ops: function () { return sortedOps().map(function (it) { return { key: it.part.key, op: it.op }; }); },
      variant: function (id) { return runVariant(id); },
      calls: function () {
        return S.calls.map(function (c) { return { name: c.name, args: c.args, ms: c.ms, error: c.error || '', result: c.result }; });
      },
      run: function () { return startRedraw(''); },
      tool: function (name, args) { return execTool(name, args || {}); },
      group: function (args) { return groupParts(args); },
      semantics: function () { return semanticCheck(); },
      groups: function () { return S.groups.map(function (g) { return { name: g.name, keys: g.keys.slice(), color: g.color }; }); },
      /* 直接采样栅格化结果（与指标同口径），不受画布缩放/底图影响 */
      sampleDraw: function (x, y) {
        var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
        var W = Math.max(1, Math.round(r.w)), H = Math.max(1, Math.round(r.h));
        var d = rasterizeDrawn(W, H, 1).data;
        var px = Math.round(x), py = Math.round(y);
        if (px < 0 || py < 0 || px >= W || py >= H) return '';
        var i = (py * W + px) * 4;
        return hexOf([d[i], d[i + 1], d[i + 2]]);
      },
      /* 采样画布上的最终像素（区域坐标），用来断言「这一块最后是什么颜色」 */
      sample: function (x, y) {
        var dpr = window.devicePixelRatio || 1;
        var cx = Math.round((x * S.view.s + S.view.ox) * dpr);
        var cy = Math.round((y * S.view.s + S.view.oy) * dpr);
        var d = CTX.getImageData(cx, cy, 1, 1).data;
        return hexOf([d[0], d[1], d[2]]);
      },
      name: function (keys) { return nameUnknown(keys || []); },
      viewImage: function (maxSide) { return regionImageURL(maxSide); },
      lastUserParts: function () {
        var m = S.stubMsgs && S.stubMsgs[0];
        if (!m || !Array.isArray(m.content)) return [];
        return m.content.map(function (p) { return p && p.type; });
      },
      firstUserParts: function () {
        var m = S.stubFirst && S.stubFirst[0];
        if (!m || !Array.isArray(m.content)) return [];
        return m.content.map(function (p) { return p && p.type; });
      },
      stubLLM: function (script) {
        S.stub = true;
        S.stubFirst = null;
        var i = 0;
        if (!savedLLM) savedLLM = window.llmStreamRequest;
        window.llmStreamRequest = async function (sys, msgs) {
          S.stubMsgs = msgs;
          if (!S.stubFirst) S.stubFirst = msgs;
          var step = script[i++];
          if (!step || step.finish) return { text: '（测试桩：完成）', toolCalls: [] };
          return {
            text: '',
            toolCalls: [{
              id: 'stub-' + i, type: 'function',
              function: { name: step.tool, arguments: JSON.stringify(step.args || {}) }
            }]
          };
        };
        return true;
      },
      restoreLLM: function () {
        S.stub = false;
        if (savedLLM) { window.llmStreamRequest = savedLLM; savedLLM = null; }
      },
      reset: function () {
        S.ops = new Map();
        S.strokes = []; S.region = null; S.metrics = null; S.best = null; S.img = null;
        S.runs = []; S.calls = []; S.lastMode = '';
        S.groups = []; S.drop = {};
        if (R.empty) R.empty.hidden = false;
        renderParts(); drawScene(); updateStat();
      }
    }
  };
})();

/* ---- apps/wardrobe/body.js ---- */
/* 衣柜 App 的窗口 DOM（app-scan 会把它排在 app.js 之前内联）。
 *
 * 三栏：左边套装、中间皮套预览、右边「衣橱」槽位（高级里可逐部件微调）。
 * 皮套来自 apps/live2d/model/，由 tools/pack-live2d.js 预打包；
 * 预览运行时在同目录 rig.js 里（window.WD_RIG），槽位定义在 presets.js。
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
        <span>作者预留的配饰 / 道具 / 配色开关</span>
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
        <input type="text" id="wdOutfitName" maxlength="12" placeholder="套装名，如 眼镜马尾" spellcheck="false">
        <button type="button" class="wd-btn" id="wdSaveOutfit">保存当前</button>
      </div>
      <div class="wd-outfits" id="wdOutfits"></div>
      <p class="wd-hint">套装 = 皮套 + 衣橱选择 + 部件微调。点卡片试穿，点「穿上」同步给数字人。</p>
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
        <button type="button" class="wd-mini" id="wdResetLook">恢复默认搭配</button>
        <span class="wd-part-total" id="wdPartCount"></span>
      </div>

      <div class="wd-toast" id="wdToast" hidden></div>
    </section>

    <aside class="wd-right">
      <div class="wd-pane-head">
        <h3>衣橱</h3>
        <span class="wd-pane-num" id="wdSlotCount"></span>
      </div>
      <p class="wd-note" id="wdNote"></p>
      <div class="wd-slots" id="wdSlots"></div>

      <details class="wd-adv" id="wdAdv">
        <summary>
          <span>高级：部件微调</span>
          <i id="wdHiddenCount">隐藏 0</i>
        </summary>
        <div class="wd-search">
          <input type="text" id="wdSearch" placeholder="搜索部件名 / ID" spellcheck="false">
          <button type="button" class="wd-btn" id="wdReset" title="清空所有微调">重置</button>
        </div>
        <div class="wd-parts" id="wdParts"></div>
      </details>
    </aside>
  </div>
</div>
`;

/* ---- apps/wardrobe/app.js ---- */
/* 衣柜 —— 数字人皮套的真实换装台。
 *
 * 左边套装、中间预览、右边衣橱。皮套清单与数据包都复用数字人 App 的
 * apps/live2d/model/（由 tools/pack-live2d.js 生成），预览运行时是 rig.js 的
 * window.WD_RIG，槽位定义在 presets.js 的 window.WD_PRESETS —— 这个文件只管界面与状态，
 * 不直接碰 Cubism，也不猜参数：槽位里只出现模型作者实际预留的开关。
 *
 * 数据只存本机（v2；读到 v1 会自动迁移）：
 *   hf_wardrobe_state = {
 *     v: 2,
 *     modelId,                    // 上次预览的皮套
 *     activeId,                   // 最近穿上的套装（仅用于高亮）
 *     outfits: [{ id, name, modelId, look, extra, showManual, hidden, shown, params, ts }],
 *     draft: { modelId, look, extra, showManual, hidden, shown, params }
 *   }
 * look  = { slotId: itemId }，衣橱槽位的选择；
 * extra = 手动隐藏的部件，showManual = 手动强制显示的部件，两者是槽位之外的微调；
 * shown = 展开后的最终显示列表（槽位要求整组显示时用；当前鲸鱼娘没有这种槽位）。
 *
 * 皮套下拉只列出 presets.js 里真的有槽位的模型：没有作者预留开关的皮套
 * （例如官方 Haru）不放进衣柜，避免「点进去什么都没有」。
 *
 * 「应用到数字人」写 draft 并调 window.__l2dApplyOutfit（数字人开着就即时生效，
 * 没开就等它下次启动读 draft）。
 */
(function () {
  'use strict';

  var BODY_HTML = window.WD_BODY || '';

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 7.4V5.6a1.8 1.8 0 1 1 3.6 0"/>' +
    '<path d="M12 7.4 3.6 13.1a1.5 1.5 0 0 0 .8 2.8h15.2a1.5 1.5 0 0 0 .8-2.8L12 7.4Z"/></svg>';

  var STORE_KEY = 'hf_wardrobe_state';
  var STORE_VER = 2;
  var L2D_KEY = 'hf_live2d_state';

  /* 高级部件分组：按 cdi3 的中文名归类；匹配不到落到「其他」 */
  var PART_CATS = [
    { key: 'hair', label: '头发 / 头饰', re: /发|角|耳|帽|头饰|蝴蝶结|呆毛|兽耳/ },
    { key: 'face', label: '面部 / 表情', re: /脸|眉|眼|嘴|口|腮|舌|泪|痣|表情/ },
    { key: 'hand', label: '手 / 手臂', re: /手|爪|臂|指|腕/ },
    { key: 'cloth', label: '服装', re: /衣|裙|裤|袜|鞋|领|袖|披风|围巾|制服|泳装|腕|body|arm/i },
    { key: 'prop', label: '道具 / 场景', re: /饭|板|手机|包|桌|杯|盘|笔|书|伞|道具|麦克风|椅|床|背景|下绘|rough/i },
    { key: 'fx', label: '特效 / 贴图', re: /特效|贴图|光|晕|符号|阴影/ },
    { key: 'other', label: '其他', re: /[\s\S]*/ }
  ];

  var S = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function readJson(key) {
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function cleanIds(list) {
    return (Array.isArray(list) ? list : []).filter(function (id) {
      return typeof id === 'string' && id;
    }).slice(0, 300);
  }

  function cleanLook(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      if (typeof obj[k] === 'string' && obj[k]) out[k] = obj[k];
    });
    return out;
  }

  function cleanParams(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      var v = Number(obj[k]);
      if (k && isFinite(v)) out[k] = v;
    });
    return out;
  }

  /* ---------- 存档 ---------- */
  function emptyDraft() {
    return { modelId: '', look: {}, extra: [], showManual: [], hidden: [], shown: [], params: {} };
  }

  function loadState() {
    var out = { modelId: '', activeId: '', outfits: [], draft: emptyDraft() };
    var d = readJson(STORE_KEY);
    if (!d || (d.v !== 1 && d.v !== STORE_VER)) {
      /* 第一次用衣柜：沿用数字人当前的皮套，不硬切回第一套 */
      var l2 = readJson(L2D_KEY);
      if (l2 && typeof l2.modelId === 'string') out.modelId = l2.modelId;
      return out;
    }
    if (typeof d.modelId === 'string') out.modelId = d.modelId;
    if (typeof d.activeId === 'string') out.activeId = d.activeId;

    function fix(o, v1) {
      var hidden = cleanIds(o.hidden);
      var manual = cleanIds(o.manualShow);
      /* 早期 v2 把「手动显示」放在 shown 里，这里兼容读一次 */
      if (!manual.length && Array.isArray(o.shown)) manual = cleanIds(o.shown);
      return {
        modelId: typeof o.modelId === 'string' ? o.modelId : '',
        look: v1 ? {} : cleanLook(o.look),
        extra: v1 ? hidden : cleanIds(o.extra),
        showManual: v1 ? [] : manual,
        hidden: hidden,
        shown: cleanIds(o.shown),
        params: v1 ? {} : cleanParams(o.params)
      };
    }

    if (d.draft && typeof d.draft === 'object') out.draft = fix(d.draft, d.v === 1);
    if (Array.isArray(d.outfits)) {
      var presets = window.WD_PRESETS || {};
      out.outfits = d.outfits.filter(function (o) {
        /* 旧版本可能存过没有真实槽位的皮套（例如 Haru 的假「制服」），读档时丢掉 */
        return o && typeof o.id === 'string' && o.id && presets[o.modelId];
      }).map(function (o) {
        var f = fix(o, d.v === 1);
        f.id = o.id;
        f.name = String(o.name || '未命名').slice(0, 16);
        f.ts = Number(o.ts) || 0;
        return f;
      }).slice(0, 60);
    }
    if (out.activeId && !out.outfits.some(function (o) { return o.id === out.activeId; })) {
      out.activeId = '';
    }
    return out;
  }

  function draftOf() {
    return {
      modelId: S.modelId || '',
      look: Object.assign({}, S.look),
      extra: S.extra.slice(),
      shown: S.showParts.slice(),
      manualShow: S.showManual.slice(),
      hidden: S.hidden.slice(),
      params: Object.assign({}, S.params)
    };
  }

  function saveState() {
    if (!S) return;
    var payload = {
      v: STORE_VER,
      modelId: S.modelId || '',
      activeId: S.activeId || '',
      outfits: S.outfits.map(function (o) {
        return {
          id: o.id, name: o.name, modelId: o.modelId,
          look: Object.assign({}, o.look), extra: o.extra.slice(), shown: o.shown.slice(),
          manualShow: o.showManual.slice(), hidden: o.hidden.slice(),
          params: Object.assign({}, o.params), ts: o.ts
        };
      }),
      draft: draftOf()
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); }
    catch (e) { /* 配额满就只留在内存里 */ }
  }

  /* ---------- 启动 ---------- */
  function boot(body) {
    var loaded = loadState();

    S = {
      body: body,
      win: body.closest ? body.closest('.os-win') : null,
      models: [],
      modelId: loaded.modelId || '',
      look: loaded.draft.look,
      extra: loaded.draft.extra,
      showManual: loaded.draft.showManual,
      showParts: [],
      hidden: loaded.draft.hidden,
      params: loaded.draft.params,
      outfits: loaded.outfits,
      activeId: loaded.activeId,
      rig: null,
      ready: false,
      loading: true,
      error: '',
      loadSeq: 0,
      toastTimer: null,
      refs: {}
    };

    cacheRefs();
    bindEvents();
    compose();
    renderSlots();
    renderOutfits();
    syncHiddenUI();
    body.dataset.ready = '1';

    if (!window.WD_RIG) {
      S.loading = false;
      S.error = '预览运行时没加载：检查 apps/wardrobe/rig.js';
      setStageState();
      return;
    }

    S.rig = window.WD_RIG.create(S.refs.canvas, {});
    installProbe();

    window.WD_RIG.runtime().then(function (models) {
      var presets = window.WD_PRESETS || {};
      S.models = (models || []).filter(function (m) {
        return m && m.id && m.pack && presets[m.id];
      });
      renderModels();
      if (!S.models.length) {
        S.loading = false;
        S.error = '没有可换装的皮套：先在 apps/wardrobe/presets.js 里为模型补槽位';
        setStageState();
        return;
      }

      var def = null;
      S.models.forEach(function (m) { if (m.id === S.modelId) def = m; });
      if (!def) {
        def = S.models[0];
        S.modelId = def.id;
        /* 皮套变了，旧槽位 / 微调都没有意义 */
        S.look = {};
        S.extra = [];
        S.showManual = [];
        S.activeId = '';
        compose();
        renderSlots();
      }
      if (S.refs.modelSel) S.refs.modelSel.value = S.modelId;
      S.rig.setParams(S.params);
      S.rig.setHidden(S.hidden);
      S.rig.setShown(S.showParts);
      loadModel(S.modelId);
    }).catch(function (err) {
      S.loading = false;
      S.error = (err && err.message) || String(err);
      setStageState();
    });
  }

  function cacheRefs() {
    var b = S.body;
    S.refs = {
      modelSel: b.querySelector('#wdModelSel'),
      applyHuman: b.querySelector('#wdApplyHuman'),
      outfitCount: b.querySelector('#wdOutfitCount'),
      outfitName: b.querySelector('#wdOutfitName'),
      saveOutfit: b.querySelector('#wdSaveOutfit'),
      outfits: b.querySelector('#wdOutfits'),
      stage: b.querySelector('#wdStage'),
      canvas: b.querySelector('#wdCanvas'),
      loading: b.querySelector('#wdLoading'),
      err: b.querySelector('#wdErr'),
      chip: b.querySelector('#wdChip'),
      resetLook: b.querySelector('#wdResetLook'),
      partCount: b.querySelector('#wdPartCount'),
      toast: b.querySelector('#wdToast'),
      slotCount: b.querySelector('#wdSlotCount'),
      note: b.querySelector('#wdNote'),
      slots: b.querySelector('#wdSlots'),
      adv: b.querySelector('#wdAdv'),
      hiddenCount: b.querySelector('#wdHiddenCount'),
      search: b.querySelector('#wdSearch'),
      reset: b.querySelector('#wdReset'),
      parts: b.querySelector('#wdParts')
    };
  }

  /* ---------- 事件 ---------- */
  function bindEvents() {
    var r = S.refs;

    r.modelSel.addEventListener('change', function () {
      changeModel(r.modelSel.value);
    });

    r.applyHuman.addEventListener('click', function () {
      var name = activeOutfit() ? activeOutfit().name : '当前搭配';
      pushToHuman(name);
    });

    r.saveOutfit.addEventListener('click', function () {
      saveOutfit(r.outfitName.value);
    });
    r.outfitName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveOutfit(r.outfitName.value); }
    });

    r.outfits.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.wd-outfit') : null;
      if (!card) return;
      var id = card.getAttribute('data-oid');
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (btn && btn.hasAttribute('data-del')) { removeOutfit(id); return; }
      if (btn && btn.hasAttribute('data-human')) { wearOutfit(id, true); return; }
      wearOutfit(id, false);
    });

    r.slots.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.wd-opt') : null;
      if (!btn) return;
      choose(btn.getAttribute('data-slot'), btn.getAttribute('data-item'));
    });

    r.resetLook.addEventListener('click', function () {
      resetLook();
    });
    r.reset.addEventListener('click', function () {
      r.search.value = '';
      resetLook(true);
    });

    var searchTimer = 0;
    r.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderParts, 90);
    });

    r.parts.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.type !== 'checkbox') return;
      var id = input.getAttribute('data-pid');
      if (!id) return;
      togglePart(id, input.checked);
    });

    r.parts.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-solo]') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      isolatePart(btn.getAttribute('data-solo'));
    });

    /* 窗口从最小化 / 关标签回来时，舞台尺寸可能变过 */
    if (window.ResizeObserver) {
      S.refs.stageObserver = new ResizeObserver(function () {
        if (S && S.rig) S.rig.fit();
      });
      S.refs.stageObserver.observe(r.stage);
    }
  }

  /* ---------- 皮套 ---------- */
  function renderModels() {
    var sel = S.refs.modelSel;
    if (!sel) return;
    sel.innerHTML = '';
    S.models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      sel.appendChild(o);
    });
    if (S.modelId) sel.value = S.modelId;
  }

  function modelName(id) {
    var hit = '';
    S.models.forEach(function (m) { if (m.id === id) hit = m.name || m.id; });
    return hit || id || '';
  }

  function loadModel(id, done) {
    if (!S || !S.rig) return;
    var seq = ++S.loadSeq;
    S.loading = true;
    S.ready = false;
    S.error = '';
    setStageState();
    S.rig.setParams(S.params);
    S.rig.setHidden(S.hidden);
    S.rig.setShown(S.showParts);

    S.rig.load(id).then(function (info) {
      if (seq !== S.loadSeq) return;
      S.loading = false;
      S.ready = !!(info && info.ready);
      S.error = (info && info.error) || '';
      if (info && info.modelId) S.modelId = info.modelId;
      if (S.refs.modelSel) S.refs.modelSel.value = S.modelId;
      if (S.ready) {
        S.rig.setHidden(S.hidden);
        S.rig.setShown(S.showParts);
        S.rig.setParams(S.params);
      }
      saveState();
      renderParts();
      syncHiddenUI();
      setStageState();
      if (done) done();
    });
  }

  function changeModel(id) {
    if (!id || id === S.modelId) return;
    S.modelId = id;
    S.look = {};
    S.extra = [];
    S.showManual = [];
    S.activeId = '';
    compose();
    renderSlots();
    saveState();
    renderOutfits();
    loadModel(id, function () {
      toast('已换上皮套：' + modelName(id));
    });
  }

  function setStageState() {
    var r = S.refs;
    if (!r) return;
    if (r.loading) r.loading.hidden = !S.loading;
    if (r.err) {
      r.err.hidden = !S.error;
      if (S.error) {
        var span = r.err.querySelector('span');
        if (span) span.textContent = S.error;
      }
    }
    if (r.chip) {
      r.chip.textContent = S.ready
        ? modelName(S.modelId)
        : (S.error ? '皮套不可用' : '正在穿上皮套…');
      r.chip.classList.toggle('is-err', !!S.error);
    }
  }

  function toast(text) {
    var el = S && S.refs ? S.refs.toast : null;
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.add('on');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      el.classList.remove('on');
      el.hidden = true;
    }, 2000);
  }

  /* ---------- 衣橱槽位 ---------- */
  function preset() {
    var all = window.WD_PRESETS || {};
    return all[S.modelId] || null;
  }

  function slotDef(p, slotId) {
    var hit = null;
    ((p && p.slots) || []).forEach(function (s) { if (s.id === slotId) hit = s; });
    return hit;
  }

  function itemOf(slot, itemId) {
    var hit = null;
    (slot.items || []).forEach(function (it) { if (it.id === itemId) hit = it; });
    return hit || (slot.items || [])[0] || null;
  }

  /* 把 look 展开成最终的 hidden / shown / params；look 里没有的槽位用默认项 */
  function compose() {
    var p = preset();
    var hidden = p && p.defaultHidden ? p.defaultHidden.slice() : [];
    var show = [];
    var params = {};
    ((p && p.slots) || []).forEach(function (slot) {
      var it = itemOf(slot, S.look[slot.id]);
      if (!it) return;
      if (it.hide) hidden = hidden.concat(it.hide);
      if (it.show) show = show.concat(it.show);
      if (it.params) Object.keys(it.params).forEach(function (k) { params[k] = it.params[k]; });
    });
    hidden = hidden.concat(S.extra);
    show = show.concat(S.showManual);
    var showSet = {};
    var showList = [];
    show.forEach(function (id) {
      if (!id || showSet[id]) return;
      showSet[id] = 1;
      showList.push(id);
    });
    var seen = {};
    S.hidden = hidden.filter(function (id) {
      if (!id || seen[id] || showSet[id]) return false;
      seen[id] = 1;
      return true;
    });
    S.showParts = showList;
    S.params = params;
  }

  function applyLook() {
    compose();
    if (S.rig) {
      S.rig.setHidden(S.hidden);
      S.rig.setShown(S.showParts);
      S.rig.setParams(S.params);
    }
    saveState();
    syncHiddenUI();
  }

  function choose(slotId, itemId) {
    var slot = slotDef(preset(), slotId);
    if (!slot) return;
    var it = itemOf(slot, itemId);
    if (!it) return;
    S.look[slotId] = it.id;
    S.activeId = '';
    /* 换了槽位就清掉这一槽位相关的手动微调，避免旧部件残留 */
    var rel = {};
    (slot.items || []).forEach(function (x) {
      (x.hide || []).forEach(function (id) { rel[id] = 1; });
      (x.show || []).forEach(function (id) { rel[id] = 1; });
    });
    if (Object.keys(rel).length) {
      S.extra = S.extra.filter(function (id) { return !rel[id]; });
      S.showManual = S.showManual.filter(function (id) { return !rel[id]; });
    }
    applyLook();
    renderSlots();
    renderOutfits();
    toast(slot.label + '：' + it.name);
  }

  function resetLook(silent) {
    S.look = {};
    S.extra = [];
    S.showManual = [];
    S.activeId = '';
    applyLook();
    renderSlots();
    renderOutfits();
    renderParts();
    if (!silent) toast('已恢复默认搭配');
  }

  function renderSlots() {
    var box = S.refs.slots;
    if (!box) return;
    var p = preset();
    if (!p) {
      box.innerHTML = '<p class="wd-empty">这个皮套没有作者预留的换装槽位。</p>';
      if (S.refs.note) S.refs.note.textContent = '';
      if (S.refs.slotCount) S.refs.slotCount.textContent = '';
      return;
    }
    if (S.refs.note) S.refs.note.textContent = p.note || '';
    if (S.refs.slotCount) S.refs.slotCount.textContent = p.slots.length + ' 组';

    var html = '';
    p.slots.forEach(function (slot) {
      var cur = itemOf(slot, S.look[slot.id]);
      var curId = cur ? cur.id : '';
      html += '<section class="wd-slot" data-slot="' + esc(slot.id) + '">' +
        '<div class="wd-slot-h"><b>' + esc(slot.label) + '</b><span>' +
          esc(cur ? cur.name : '—') + '</span></div>' +
        '<div class="wd-opts">';
      (slot.items || []).forEach(function (it) {
        html += '<button type="button" class="wd-opt' + (it.id === curId ? ' is-on' : '') +
          '" data-slot="' + esc(slot.id) + '" data-item="' + esc(it.id) + '">' +
          esc(it.name) + '</button>';
      });
      html += '</div></section>';
    });
    box.innerHTML = html;
  }

  /* ---------- 高级：部件微调 ---------- */
  function hiddenMap() {
    var m = {};
    (S ? S.hidden : []).forEach(function (id) { m[id] = 1; });
    return m;
  }

  function syncHiddenUI() {
    var hidden = hiddenMap();
    var all = S.rig ? S.rig.parts() : [];
    var n = 0;
    all.forEach(function (p) { if (hidden[p.id]) n++; });

    if (S.refs.hiddenCount) {
      S.refs.hiddenCount.textContent = n ? ('隐藏 ' + n) : '隐藏 0';
    }
    if (S.refs.partCount) {
      S.refs.partCount.textContent = '部件 ' + all.length + (n ? ' · 隐藏 ' + n : '');
    }
    if (S.refs.outfitCount) S.refs.outfitCount.textContent = String(S.outfits.length);

    /* 只同步勾选与灰态，不重建列表 —— 保住滚动位置 */
    var inputs = S.refs.parts ? S.refs.parts.querySelectorAll('input[data-pid]') : [];
    for (var i = 0; i < inputs.length; i++) {
      var id = inputs[i].getAttribute('data-pid');
      var on = !hidden[id];
      inputs[i].checked = on;
      var row = inputs[i].closest ? inputs[i].closest('.wd-part') : null;
      if (row) row.classList.toggle('is-off', !on);
    }
  }

  function groupParts(list) {
    var buckets = PART_CATS.map(function (c) { return { cat: c, items: [] }; });
    list.forEach(function (p) {
      for (var i = 0; i < buckets.length; i++) {
        if (buckets[i].cat.re.test(p.name) || buckets[i].cat.re.test(p.id)) {
          buckets[i].items.push(p);
          return;
        }
      }
    });
    return buckets.filter(function (b) { return b.items.length; });
  }

  function renderParts() {
    var box = S.refs.parts;
    if (!box) return;
    var all = S.rig ? S.rig.parts() : [];
    var hidden = hiddenMap();
    var q = (S.refs.search && S.refs.search.value || '').trim().toLowerCase();

    if (!all.length) {
      box.innerHTML = '<p class="wd-empty">' +
        (S.loading ? '正在读取部件…' : '这个皮套没有可列出的部件') + '</p>';
      return;
    }

    var list = all.filter(function (p) {
      if (!q) return true;
      return p.name.toLowerCase().indexOf(q) >= 0 || p.id.toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      box.innerHTML = '<p class="wd-empty">没有匹配「' + esc(q) + '」的部件</p>';
      return;
    }

    var html = '';
    groupParts(list).forEach(function (g) {
      html += '<section class="wd-group">' +
        '<h4 class="wd-group-h"><span>' + esc(g.cat.label) + '</span><i>' + g.items.length + '</i></h4>';
      g.items.forEach(function (p) {
        var on = !hidden[p.id];
        html += '<div class="wd-part' + (on ? '' : ' is-off') + '" data-pid="' + esc(p.id) + '">' +
          '<label class="wd-part-main">' +
            '<input type="checkbox" data-pid="' + esc(p.id) + '"' + (on ? ' checked' : '') +
              ' aria-label="显示 ' + esc(p.name) + '">' +
            '<span class="wd-part-name">' + esc(p.name) + '</span>' +
            '<span class="wd-part-id">' + esc(p.id) + '</span>' +
          '</label>' +
          '<button type="button" class="wd-part-solo" data-solo="' + esc(p.id) + '" title="只显示这一件">只</button>' +
        '</div>';
      });
      html += '</section>';
    });
    box.innerHTML = html;
  }

  function togglePart(id, show) {
    if (!id) return;
    if (show) {
      S.extra = S.extra.filter(function (x) { return x !== id; });
      S.showManual = S.showManual.filter(function (x) { return x !== id; });
      /* 槽位本身会隐藏它：记一条「强制显示」 */
      if (S.hidden.indexOf(id) >= 0) S.showManual.push(id);
    } else {
      S.showManual = S.showManual.filter(function (x) { return x !== id; });
      if (S.extra.indexOf(id) < 0) S.extra.push(id);
    }
    S.activeId = '';
    applyLook();
  }

  function isolatePart(id) {
    if (!id) return;
    var all = S.rig ? S.rig.parts() : [];
    var base = S.hidden.filter(function (x) { return x !== id; });
    var baseSet = {};
    base.forEach(function (x) { baseSet[x] = 1; });
    S.extra = all.filter(function (p) { return p.id !== id && !baseSet[p.id]; })
      .map(function (p) { return p.id; });
    S.showManual = [id];
    S.activeId = '';
    applyLook();
    renderParts();
    var name = id;
    all.forEach(function (p) { if (p.id === id) name = p.name; });
    toast('只显示：' + name);
  }

  /* ---------- 套装 ---------- */
  function activeOutfit() {
    var hit = null;
    S.outfits.forEach(function (o) { if (o.id === S.activeId) hit = o; });
    return hit;
  }

  function outfitSummary(o) {
    var p = (window.WD_PRESETS || {})[o.modelId] || null;
    if (!p) return '';
    var names = [];
    p.slots.forEach(function (slot) {
      var it = itemOf(slot, (o.look || {})[slot.id]);
      if (!it) return;
      var first = (slot.items || [])[0];
      if (first && it.id === first.id) return;
      names.push(it.name);
    });
    var n = (o.extra || []).length;
    if (n) names.push('微调 ' + n);
    return names.join(' · ');
  }

  function saveOutfit(name) {
    var nm = String(name || '').trim();
    if (!nm) nm = '套装 ' + (S.outfits.length + 1);
    var o = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: nm.slice(0, 16),
      modelId: S.modelId,
      look: Object.assign({}, S.look),
      extra: S.extra.slice(),
      shown: S.showParts.slice(),
      showManual: S.showManual.slice(),
      hidden: S.hidden.slice(),
      params: Object.assign({}, S.params),
      ts: Date.now()
    };
    S.outfits.unshift(o);
    S.activeId = o.id;
    S.refs.outfitName.value = '';
    saveState();
    renderOutfits();
    syncHiddenUI();
    toast('已保存套装：' + o.name);
  }

  function removeOutfit(id) {
    var gone = null;
    S.outfits = S.outfits.filter(function (o) {
      if (o.id === id) { gone = o; return false; }
      return true;
    });
    if (!gone) return;
    if (S.activeId === id) S.activeId = '';
    saveState();
    renderOutfits();
    toast('已删除套装：' + gone.name);
  }

  function wearOutfit(id, toHuman) {
    var o = null;
    S.outfits.forEach(function (x) { if (x.id === id) o = x; });
    if (!o) return;

    S.activeId = o.id;
    S.look = Object.assign({}, o.look);
    S.extra = o.extra.slice();
    S.showManual = (o.showManual || []).slice();
    compose();
    renderSlots();

    function after() {
      if (S.rig) {
        S.rig.setHidden(S.hidden);
        S.rig.setShown(S.showParts);
        S.rig.setParams(S.params);
      }
      saveState();
      renderParts();
      syncHiddenUI();
      if (toHuman) pushToHuman(o.name);
      else toast('试穿：' + o.name);
    }

    if (o.modelId && o.modelId !== S.modelId) {
      S.modelId = o.modelId;
      if (S.refs.modelSel) S.refs.modelSel.value = o.modelId;
      loadModel(o.modelId, after);
      return;
    }

    renderOutfits();
    after();
  }

  function renderOutfits() {
    var box = S.refs && S.refs.outfits;
    if (!box) return;
    if (S.refs.outfitCount) S.refs.outfitCount.textContent = String(S.outfits.length);
    if (!S.outfits.length) {
      box.innerHTML = '<p class="wd-empty">还没有套装。在右边衣橱里挑好，点「保存当前」。</p>';
      return;
    }
    var html = '';
    S.outfits.forEach(function (o) {
      var sum = outfitSummary(o);
      html += '<article class="wd-outfit' + (o.id === S.activeId ? ' is-on' : '') + '" data-oid="' + esc(o.id) + '">' +
        '<div class="wd-outfit-top">' +
          '<b>' + esc(o.name) + '</b>' +
          '<span>' + esc(modelName(o.modelId) || '未记录皮套') + '</span>' +
        '</div>' +
        '<div class="wd-outfit-meta">' + esc(sum || '默认搭配') + '</div>' +
        '<div class="wd-outfit-acts">' +
          '<button type="button" class="wd-mini" data-human="' + esc(o.id) + '">穿上</button>' +
          '<button type="button" class="wd-mini ghost" data-del="' + esc(o.id) + '" title="删除套装">删除</button>' +
        '</div>' +
      '</article>';
    });
    box.innerHTML = html;
  }

  /* 把当前搭配同步给数字人；数字人开着就即时生效，没开就等它下次启动读 draft */
  function pushToHuman(name) {
    var payload = {
      name: name || '当前搭配',
      modelId: S.modelId,
      hidden: S.hidden.slice(),
      shown: S.showParts.slice(),
      params: Object.assign({}, S.params)
    };
    saveState();
    var fn = window.__l2dApplyOutfit;
    if (typeof fn === 'function') {
      fn(payload);
      toast('数字人已穿上：' + payload.name);
    } else {
      toast('已保存搭配，打开「数字人」就会穿上');
    }
  }

  /* 探针只读钩子：无头测试读槽位、参数、隐藏状态与存档用 */
  function installProbe() {
    if (!window.__wdRig) {
      window.__wdRig = function () {
        if (!S) return null;
        var info = S.rig ? S.rig.info() : { ready: false, loading: true, error: '', parts: [], hidden: [] };
        return {
          ready: !!info.ready,
          loading: !!info.loading,
          error: info.error || '',
          modelId: S.modelId,
          parts: (info.parts || []).map(function (p) { return { id: p.id, name: p.name }; }),
          partCount: (info.parts || []).length,
          look: Object.assign({}, S.look),
          hidden: S.hidden.slice(),
          shown: S.showParts.slice(),
          applied: (info.hidden || []).slice(),
          params: Object.assign({}, S.params),
          activeId: S.activeId,
          outfits: S.outfits.map(function (o) {
            return {
              id: o.id, name: o.name, modelId: o.modelId,
              look: Object.assign({}, o.look), hidden: o.hidden.slice(), params: Object.assign({}, o.params)
            };
          })
        };
      };
    }
    if (!window.__wdPartOpacity) {
      window.__wdPartOpacity = function (id) {
        return S && S.rig ? S.rig.partOpacity(id) : null;
      };
    }
    if (!window.__wdParam) {
      window.__wdParam = function (id) {
        return S && S.rig ? S.rig.paramValue(id) : null;
      };
    }
    if (!window.__wdState) {
      window.__wdState = function () { return readJson(STORE_KEY); };
    }
    if (!window.__wdModel) {
      window.__wdModel = function () { return S && S.rig ? S.rig.model() : null; };
    }
  }

  /* ---------- 注册 ---------- */
  registerApp({
    id: 'wardrobe',
    name: '衣柜',
    title: '衣柜 · 真实换装',
    sub: '作者预留的配饰 / 道具 / 配色开关，存套装',
    icon: ICON,
    order: 17,
    cls: 'wardrobe',
    win: 'wardrobeWin',
    css: ['apps/wardrobe/app.css'],
    scripts: ['apps/wardrobe/presets.js', 'apps/wardrobe/rig.js'],
    body: BODY_HTML,
    mount: function (body) {
      if (body.dataset.ready === '1' && S && S.body === body) {
        /* 切回来只同步状态与尺寸，不重建 DOM，预览也不重载 */
        syncHiddenUI();
        setStageState();
        if (S.rig) S.rig.fit();
        return;
      }
      boot(body);
    }
  });
})();
