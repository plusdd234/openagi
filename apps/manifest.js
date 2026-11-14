/* ============================================================
 * 自动生成，别手改 —— node tools/app-scan.js
 * App 清单：aisearch , browser , card , chara , chat , code , comfy , gallery , hello , imglab , live2d , modeldesk , models , multiview , player , store , studio
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
    'renrendoc.com', 'taodocs.com', '360doc.com', 'mbalib.com',
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
    [/材质/, 'material'], [/建模/, 'modeling'], [/动画/, 'animation'], [/服务端|服务器/, 'server']
  ];
  /* GitHub 检索是 AND 语义，词越多命中越少，所以准备一主一退化两条检索式：
     先用完整组合，没结果再退到核心词（去掉 template / framework 这类修饰）。
     注意 ai 不能被当过泛词删掉 —— 「AI 开发的游戏模板」里它是核心限定词。 */
  function githubQueries(q) {
    if (!GH_INTENT.test(q)) return [];
    var words = (String(q).match(/[a-z0-9][a-z0-9.+#-]*/gi) || [])
      .filter(function (w) { return w.length > 1 && !/^(the|and|for|of|in|to)$/i.test(w); });
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
    return out;
  }

  /* 仓库检索的两条规矩：
     ① 一次问完全部检索式再合并 —— 只取第一条有结果的，会把「131 个仓库」缩成 6 个；
     ② 每条检索式多拿一些（per_page=20），否则「有没有更多」这个判断本身就不成立。
     相关性按「除 template / engine 这类修饰词之外还命中了什么」来判：
     只因为出现 template 就混进来的排版模板、脚手架仓库，不能占射击模板的位置。 */
  var GH_MODIFIER = /^(template|framework|tool|plugin|example|tutorial|library|engine|boilerplate|starter|kit|demo)$/i;
  function githubResults(q, signal) {
    var queries = githubQueries(q);
    if (!queries.length) return Promise.resolve([]);
    var core = relevantTokens(q).filter(function (t) { return !GH_MODIFIER.test(t); });
    /* 英文里 FPS / shooter 是同一类说法：只认 shooter 会漏掉 SimpleFPSTemplate 这种仓库。 */
    if (/(射击|枪战|shooter|fps)/i.test(q) && core.indexOf('fps') < 0) core.push('fps');
    function one(qq) {
      var url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(qq)
        + '&sort=stars&order=desc&per_page=20';
      return fetchJson(url, signal).then(function (j) {
        return ((j && j.items) || []).map(function (x) {
          var desc = String(x.description || '').replace(/\s+/g, ' ').trim();
          return {
            title: clip(x.full_name + (desc ? ' · ' + desc : ''), 120),
            url: x.html_url,
            snippet: clip((desc || 'GitHub 仓库') + ' · ★' + (x.stargazers_count || 0)
              + (x.language ? ' · ' + x.language : ''), 360),
            repo: true
          };
        });
      }).catch(function () { return []; });
    }
    return Promise.all(queries.map(one)).then(function (groups) {
      var seen = Object.create(null);
      var all = [];
      groups.forEach(function (list) {
        list.forEach(function (r) {
          if (!r.url || seen[r.url]) return;
          seen[r.url] = 1;
          all.push(r);
        });
      });
      if (!all.length) return [];
      S.ghQuery = queries[0];
      var strong = core.length ? all.filter(function (r) {
        var text = (r.title + ' ' + r.snippet).toLowerCase();
        return core.some(function (t) { return t && text.indexOf(t) >= 0; });
      }) : all;
      /* 强相关太少时退回全集：宁可多给几条让用户自己挑，也不要因为筛得太狠又只剩个位数。 */
      return (strong.length >= 6 ? strong : all).slice(0, 20);
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
    pageCache: Object.create(null),
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
    return '';
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
    var tokens = relevantTokens(q);
    (list || []).forEach(function (raw) {
      var url = String(raw && raw.url || '').trim();
      var title = clip(raw.title || hostOf(url), 120);
      var why = blockedReason({ url: url, title: title });
      if (why) { dropped.push({ url: url, title: title, why: why }); return; }
      if (!relevantTo({ title: title, snippet: raw.snippet, url: url }, tokens)) {
        dropped.push({ url: url, title: title, why: '与问题无关' });
        return;
      }
      var norm = url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
      if (seenUrl[norm]) { dropped.push({ url: url, title: title, why: '重复结果' }); return; }
      seenUrl[norm] = 1;
      var key = hostOf(url).toLowerCase() + '|' + title.replace(/[\s\-_|｜:：]+/g, '').toLowerCase();
      if (seen[key]) { dropped.push({ url: url, title: title, why: '重复结果' }); return; }
      seen[key] = 1;
      kept.push({
        title: title,
        url: url,
        snippet: clip(raw.snippet || '', 360),
        host: hostOf(url),
        seed: !!raw.seed,
        repo: !!raw.repo,
        trusted: trustedHost(hostOf(url))
      });
    });
    /* 排序：人工种子 > 仓库 > 可信站 > 其他；同级保持搜索源名次。 */
    function rank(x) { return x.seed ? 3 : (x.repo ? 2 : (x.trusted ? 1 : 0)); }
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

  function fetchPage(url, signal, depth) {
    depth = depth || 0;
    /* 已经在限流冷却里的站直接跳过，别让整轮精读都卡在同一个被封的域名上。 */
    var cooling = hostCooling(url);
    if (cooling) return Promise.reject(new Error('站点按 IP 限流，约 ' + cooling + ' 后再试'));
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timedOut = false;
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, PAGE_TIMEOUT);
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
          /* 有些搜索站用 JS 跳转（window.location.replace）而不是 302，
             只回一张几百字节的空壳。识别出真实地址后再抓一次。 */
          var m = String(html || '').length < 1600
            ? /location\.(?:replace|href)\s*=\s*["']([^"']+)["']/i.exec(html)
            : null;
          if (m && depth < 1 && /^https?:\/\//i.test(m[1])) {
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
            finish(timedOut ? new Error('站点在 ' + Math.round(PAGE_TIMEOUT / 1000) + ' 秒内没有响应') : abortErr());
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
   * 只做「去标签 + 去导航」这一层，不引入 Readability 那种大依赖：
   * 目标是给模型一份能读的文字，不是还原网页排版。挑不到 article/main 就用整页，
   * 靠「短行丢弃 + 相邻去重」把菜单、版权、分享按钮过滤掉。 */
  function stripTags(html) {
    return decodeEnt(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  function extractPage(html) {
    var raw = String(html || '');
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

    var src = raw
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|template|iframe|object|embed|nav|aside|footer|header|form|button|select|input|textarea)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|blockquote|pre|dd|dt|figure|table)>/gi, '\n');

    var block = /<article\b[\s\S]*?<\/article>/i.exec(src) || /<main\b[\s\S]*?<\/main>/i.exec(src);
    if (block && stripTags(block[0]).length > 400) src = block[0];

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
    return { title: title, text: lines.join('\n').slice(0, MAX_PAGE_TEXT) };
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
    var seen = Object.create(null);
    var scored = [];
    (list || []).forEach(function (r, i) {
      var u = String(r.url || '').replace(/#.*$/, '');
      if (!u || seen[u]) return;
      seen[u] = 1;
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
      score += Math.max(0, 4 - Math.floor(i / 4));
      /* 外链候选没有搜索名次，必须自己挣到相关性，否则会混进一堆导航链接。 */
      if (r.link && score < 3) return;
      scored.push({ r: r, host: host, score: score, i: i });
    });
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var out = [];
    var siteCount = Object.create(null);
    scored.forEach(function (x) {
      if (out.length >= MAX_RESULTS) return;
      var site = siteOf(x.host);
      /* 备用源（360）的结果链接都指向 so.com 跳转，不能按站点配额压掉。
         仓库页不设小配额：搜「开源 xx 模板」时，真正的答案就是这一串仓库。 */
      var cap = x.r.alt ? MAX_RESULTS : (/(^|\.)github\.com$/.test(site) ? MAX_RESULTS : 2);
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
      s.status = 'loading';
      renderSources();
      var ready = S.pageCache[s.url];
      var page = ready ? Promise.resolve(ready) : fetchPage(s.url, signal).then(function (html) {
        S.pageCache[s.url] = html;
        return html;
      });
      return page.then(function (html) {
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

  /* 顺着线索再读两篇：从已读页面的出站链接里挑与问题最相关、且不在已读站点内的，
     再抓一轮。很多工具站不会直接出现在搜索结果里，但会出现在「XX 工具清单」页的链接里。 */
  function followTrail(q, signal) {
    var tokens = relevantTokens(q);
    var kwTokens = (S.skim && S.skim.keywords) || [];
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
        if (!u || urls[u]) return;
        var host = hostOf(u);
        if (!host || hosts[host] || sites[siteOf(host)]) return;
        if (pickedSites[siteOf(host)]) return;
        if (blockedReason({ url: u, title: l.text })) return;
        var low = (l.text + ' ' + u).toLowerCase();
        var score = 0;
        tokens.forEach(function (t) { if (low.indexOf(t) >= 0) score += t.length > 3 ? 3 : 2; });
        /* 粗读捞到的关键词是「同义线索」：不要求它出现在问题里，命中就加权。 */
        kwTokens.forEach(function (t) { if (t.length > 2 && low.indexOf(t) >= 0) score += 2; });
        /* 官网链接的锚文本常常只写品牌名（Meshy / Tripo / OpenRA），不含问题里的词。
           这类链接恰恰是我们要找的，所以可信域名单独给分，不强制词命中。 */
        if (trustedHost(host)) score += 3;
        if (!score) return;
        urls[u] = 1;
        pickedSites[siteOf(host)] = 1;
        cands.push({ url: u, text: l.text, host: host, score: score });
      });
    });
    cands.sort(function (a, b) { return b.score - a.score; });
    var picks = cands.slice(0, 2);
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
      + '7. 今天是 ' + today() + '；涉及时效的信息要注明资料的日期或「资料未注明日期」。';
  }

  function userPrompt(q, sources) {
    var usable = sources.filter(function (s) { return s.text; });
    var kw = (S.skim && S.skim.keywords) || [];
    var list = usable.map(function (s) {
      var head = '[' + s.idx + '] ' + s.title + '\n';
      if (S.mode === 'media') {
        var site = mediaSite(s.host);
        head += '平台：' + (site ? site.name : s.host) + '｜页面判定：' + MEDIA_STATUS[s.media || 'unknown'] + '\n';
      }
      var base = pickRelevant(s.text, q, PROMPT_PER_SOURCE);
      /* 补充精读：粗读捞到的关键词再做一遍段落检索，把「同义但没出现问题词」的部分补上。 */
      var extra = kw.length ? supplementText(s.text, base, kw, PROMPT_EXTRA) : '';
      return head + s.url + '\n' + base + (extra ? '\n（补充摘录）\n' + extra : '');
    }).join('\n\n');
    return '用户问题：' + q + '\n\n资料（共 ' + usable.length + ' 篇，已去除广告与导航）：\n' + list;
  }

  /* 没有模型时的降级：不假装给了答案，只把正文摘录摆出来，并说明如何配置。 */
  function fallbackAnswer(sources) {
    var usable = sources.filter(function (s) { return s.text; });
    var out = ['**未能生成 AI 摘要：语言模型未配置或暂时不可用。**', '', '下面是已抓取到的网页正文摘录，可直接点来源核对：'];
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

  /* ---------------- 意图理解 ----------------
   * 「找工具」和「查报错」需要完全不同的检索式与线索来源：
   * 找工具要多问「工具 / 推荐」，资源类要落到 GitHub，排错要找具体报错和解决帖。
   * 这一步决定接下来用哪种说法再问一次，而不是盲目短语料。 */
  var INTENTS = [
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
    S.pageCache = Object.create(null);
    S.answer = '';
    S.error = '';
    S.note = '';
    S.llmOff = false;
    S.folded = false;
    S.trailTried = Object.create(null);
    S.deepExhausted = false;

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
      function ask(qq, kind) {
        var gap = Math.max(0, 400 - (Date.now() - lastAsk));
        var viaRss = false;
        var viaAlt = false;
        lastAsk = Date.now() + gap;
        return delay(gap)
          .then(function () { return fetchOnce(qq); })
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
              text: qq + (viaRss ? '（RSS 备用源）' : viaAlt ? '（360 备用源）' : ''),
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
      [base, alt].forEach(function (x) { if (x) tried[String(x).toLowerCase()] = 1; });
      var smartDeadline = Date.now() + 60000;

      function coreWords(qq) {
        var s = String(qq).replace(/(最|的|了|吗|呢|啊|吧|请问|帮我|我想|什么|怎么|如何|哪个|哪些|为什么|多少|哪里|可以|有没有|是不是|到底|究竟|现在|最新|大全|推荐|哪个好)/g, ' ')
          .replace(/[，,。.!！?？、/|·:：()（）]+/g, ' ')
          .replace(/\s+/g, ' ').trim();
        return s || String(qq).trim();
      }
      function englishWords(qq) {
        var out = [];
        GH_WORDS.forEach(function (p) { if (p[0].test(qq) && out.indexOf(p[1]) < 0) out.push(p[1]); });
        (String(qq).match(/[a-z][a-z0-9.+#-]{1,}/gi) || []).forEach(function (w) {
          if (out.indexOf(w.toLowerCase()) < 0) out.push(w.toLowerCase());
        });
        return out.slice(0, 3).join(' ');
      }
      /* 每一轮给出不同的检索式组合；同一轮里最多问 2 条。 */
      function roundQueries(round) {
        var list = [];
        if (round === 0) {
          (intent.adds || []).forEach(function (w) { list.push((base + ' ' + w).trim()); });
        } else if (round === 1) {
          list.push(coreWords(base));
          var en = englishWords(q);
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
        if (round < 2) return ask(qq, '智搜');
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
          return askRound(qs[i], round).catch(function () { return []; }).then(function (list) {
            got = (got || []).concat(list || []);
            var j = judge(web.concat(got), q);
            trace({
              kind: '智搜',
              text: '第 ' + (round + 1) + ' 轮 · ' + qs[i],
              res: (list || []).length + ' 条' + (j.ok ? ' · 命中' : ' · 仍不相关'),
              ok: j.ok
            });
            if (j.ok) return got;
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
        if (repos.length) {
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
        return { results: all };
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
        } else {
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

        var picks = pickForRead(S.results, MAX_SOURCES);
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
     正文常因登录墙或反爬读不到，那时如果只认正文，「进一步搜索」就会变成一个点了没反应的按钮。 */
  function collectClues(q0) {
    var out = [];
    function add(k) {
      k = String(k || '').toLowerCase().trim();
      if (k.length >= 2 && out.indexOf(k) < 0) out.push(k);
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

  /* 进一步搜索：把这一轮里「稳定重复出现的新词」当线索，再搜一轮。
   * 线索来自粗读关键词、已读正文与结果标题，不是让模型空想；
   * 新结果先过三道筛：未出现过、不在黑名单、与问题或线索真的相关。
   * 剩下的才并进列表并重新精读，最后基于新旧资料重写答案。 */
  function deepenSearch() {
    var p;
    try {
      p = deepenRun();
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

  function deepenRun() {
    if (S.busy || S.phase !== 'done' || !S.results.length || S.mode !== 'web') return;
    var q0 = S.q;
    var clues = collectClues(q0);
    var core = primaryQuery(q0).split(/\s+/).slice(0, 3).join(' ');
    /* 没有新词时退一步：换一种问法再搜一轮，同样按「是否见过 / 是否相关」筛选。
       这样做至少能验证「确实没有更好的结果」，而不是什么都不做。 */
    var queries = [];
    if (clues.length) {
      /* 前两条线索常常搜索源也查不出东西，这里把 4 条线索都排进去，
         轮到哪条用哪条，不必因为前两条失效就整轮放弃。 */
      clues.forEach(function (k) {
        var qq = (k + ' ' + core).replace(/\s+/g, ' ').trim();
        if (queries.indexOf(qq) < 0) queries.push(qq);
      });
    } else {
      queries = [retryQuery(q0) || primaryQuery(q0)];
    }
    queries = queries.slice(0, 4);
    var label = clues.length ? clues.slice(0, 2).join(' / ') : queries[0];

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
      S.note = '线索「' + label + '」都搜过了，这一轮没有更多可挖的内容。换个更具体的问法能继续。';
      renderAnswer();
      setTools();
      return;
    }
    queries = fresh;

    S.busy = true;
    S.error = '';
    S.note = '';
    S.llmOff = false;
    S.phase = 'reading';
    S.startedAt = Date.now();
    setPhase('reading');
    note('用线索继续搜索：' + label);
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
        if (list.length) return list;
        return rssSearch(qq, ctrl.signal).then(function (l) {
          return l.length ? l : soSearch(qq, ctrl.signal);
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
          if (!hit) { dropped++; return; }
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
        S.note = '用「' + label + '」又搜了一轮，没有新的相关结果'
          + (dropped ? '（去掉 ' + dropped + ' 条重复 / 无关）' : '') + '。';
        trace({ kind: '深挖', text: '线索「' + label + '」', res: '无新增 · 去掉 ' + dropped + ' 条', ok: false });
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
        kind: '深挖',
        text: '线索「' + label + '」',
        res: '新增 ' + added.length + ' 条 · 去掉 ' + dropped + ' 条无关',
        ok: true
      });

      /* 只精读新增里最靠前的两条：线索用来补缺口，不重读一遍全部资料。 */
      var more = added.slice(0, 2).map(function (item, i) {
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

    return window.LLMRouter.complete({
      app: APP,
      sys: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(S.q, S.sources) }],
      onDelta: function (acc) {
        S.answer = String(acc == null ? '' : acc);
        scheduleAnswer();
      },
      opts: { signal: signal, temperature: 0.3, timeoutMs: 180000 }
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
      loadHist();
      bind(body);
      applyModeUI();
      renderHist();
      body.dataset.ready = '1';
      checkEnv();
      setTimeout(function () { focusInput(); }, 80);
    }
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
            <div class="l2d-tts">
              <select id="l2dVoiceSel" class="l2d-select" aria-label="音色"></select>
              <label class="l2d-range"><span>语速</span><input type="range" id="l2dRate" min="0.7" max="1.4" step="0.02" value="1.04"><em id="l2dRateVal">1.04</em></label>
              <label class="l2d-range"><span>音调</span><input type="range" id="l2dPitch" min="0.7" max="1.5" step="0.02" value="1.12"><em id="l2dPitchVal">1.12</em></label>
              <button type="button" class="l2d-btn" id="l2dVoiceTest">试听一句</button>
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
            <div class="l2d-credit">
              <b>鲸鱼娘 · c_0120</b>
              <span>形象：上善无形 / ZipZipPipe　模型：氵六青</span>
              <span>CC BY-NC-SA 4.0 · 仅非商业使用</span>
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
 * ⚠ file:// 下 XHR 读不了本地文件，所以 moc3 与全部 json 由 model/pack.js
 *   预打包（moc3 转 base64、json 直接是对象），再用 Live2DLoader 中间件喂给
 *   运行时装加载器；纹理仍按相对路径走 Image，file:// 下正常。
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

  /* 皮套与运行时都在 App 目录下，全部相对本页解析 */
  var RIG_DIR = 'apps/live2d/model/';
  var RIG_SCRIPTS = [
    'apps/live2d/vendor/pixi.min.js',
    'apps/live2d/vendor/live2dcubismcore.min.js',
    'apps/live2d/vendor/cubism4.min.js',
    'apps/live2d/model/pack.js'
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
      aff: 12
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
      msgs: S.msgs.slice(-MAX_MSGS).map(function (m) {
        return { r: m.r, t: m.t, ts: m.ts, emo: m.emo || '' };
      })
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch (e) { /* 配额满就只留在内存里 */ }
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
      emo: 'neutral',
      busy: false,
      abort: null,
      streamEl: null,
      streamTxt: '',
      voiceOn: loaded.persona.voice,
      mem: loaded.mem,
      memBusy: false,
      tab: 'chat',
      patCool: 0,
      lastPointerAt: 0,
      toastTimer: null,
      sayUntil: 0,
      rig: {
        ready: false, loading: false, error: '',
        app: null, model: null,
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
      voiceSel: b.querySelector('#l2dVoiceSel'),
      rate: b.querySelector('#l2dRate'),
      rateVal: b.querySelector('#l2dRateVal'),
      pitch: b.querySelector('#l2dPitch'),
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
    if (r.voiceTest) r.voiceTest.addEventListener('click', testSpeak);
    if (r.memNow) r.memNow.addEventListener('click', function () { summarizeNow(true); });
    if (r.memClear) r.memClear.addEventListener('click', clearMemory);
    if (r.exportBtn) r.exportBtn.addEventListener('click', exportChat);
    if (window.speechSynthesis) {
      try { window.speechSynthesis.addEventListener('voiceschanged', renderVoiceOptions); } catch (e) { /* 老引擎没有该事件 */ }
    }
    /* 模型商店里「设为默认语音」后即时同步下拉框，不用重开 App */
    window.addEventListener('hf-tts-changed', renderVoiceOptions);

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

  /* 表情名对应 model3.json 里的 exp3 文件名；空串 = 回到默认表情 */
  function setRigExpression(name) {
    var st = S.rig;
    if (!st.ready || !st.model) { st.expr = name || ''; return; }
    st.expr = name || '';
    var im = st.model.internalModel;
    var em = im && im.motionManager && im.motionManager.expressionManager;
    if (!em) return;
    if (!st.expr) { em.resetExpression(); return; }
    em.setExpression(st.expr);
  }

  function playMotion(group) {
    var st = S.rig;
    if (!st.ready || !st.model || !group) return;
    st.lastMotion = group;
    try { st.model.motion(group); } catch (e) { /* 动作缺失就只换表情 */ }
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
        browL: s.browL || 0
      };
    };

    /* 2.0 诊断钩子：语音设置 / 记忆 / 亲密度，供探针只读校验 */
    window.__l2dDiag = function () {
      if (!S) return null;
      return {
        speaking: !!S.rig.speaking,
        tts: { voice: S.persona.tts.voice, rate: S.persona.tts.rate, pitch: S.persona.tts.pitch },
        mem: { summary: S.mem.summary, at: S.mem.at, count: S.mem.count },
        aff: S.aff,
        msgs: S.msgs.length,
        busy: !!S.busy
      };
    };
    window.__l2dExportText = function () { return S ? buildExport() : ''; };
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
      setStreamText(sp.text);
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
          pushMsg('a', partial, detectEmo(partial));
          setEmotion(detectEmo(partial));
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
    var text = sp.text.trim();
    if (!text) text = '（她沉默了一下，好像在组织语言。）';
    var emo = sp.emo || detectEmo(text);
    setEmotion(emo);
    addAff(1);
    pushMsg('a', text, emo);
    showSay(text);
    maybeRemember();
    speakAloud(text);
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

  function voiceList() {
    if (!window.speechSynthesis) return [];
    try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
  }

  /* 模型商店的「设为默认」写在 hf_ttsVoice；人设没显式选音色时用它，
   * 这样在商店里挑的音色才能真的影响朗读。 */
  function storeVoice() {
    try { return String(localStorage.getItem('hf_ttsVoice') || ''); } catch (e) { return ''; }
  }

  /* 选中的音色优先；没选就挑中文女声，再退回第一个中文 */
  function pickVoice() {
    var list = voiceList();
    if (!list.length) return null;
    var want = (S && S.persona.tts) ? S.persona.tts.voice : '';
    if (!want) want = storeVoice();
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

  /* 商店里的本地音色有两种启用值：piper:<目录 id> 与 kokoro:<sid>。
   * 返回给朗读链路的结构要能直接变成 /tts/speak 的请求体。 */
  function localVoiceSpec() {
    var want = (S && S.persona.tts && S.persona.tts.voice) ? S.persona.tts.voice : storeVoice();
    if (!want) return null;
    var s = String(want);
    var head = s.indexOf('piper:') === 0 ? 'piper' : (s.indexOf('kokoro:') === 0 ? 'kokoro' : '');
    if (!head) return null;
    var item = (typeof catalogGet === 'function') ? catalogGet(s.slice(head.length + 1)) : null;
    if (!item) return null;
    if (item.engine === 'kokoro' && typeof item.sid === 'number') return { engine: 'kokoro', sid: item.sid, label: item.name };
    if (item.engine === 'piper' && item.voiceFile) return { engine: 'piper', voice: item.voiceFile, label: item.name };
    return null;
  }

  function renderVoiceOptions() {
    var sel = S && S.refs.voiceSel;
    if (!sel) return;
    var list = voiceList().filter(function (v) {
      return /zh|chinese|中文|普通话/i.test((v.lang || '') + ' ' + (v.name || ''));
    });
    var saved = S.persona.tts.voice || '';
    var cur = saved || storeVoice();
    sel.innerHTML = '';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = list.length ? '系统默认' : '系统默认（未检测到中文语音）';
    sel.appendChild(def);
    list.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name + (v.lang ? ' · ' + v.lang : '');
      sel.appendChild(o);
    });
    /* 商店里选的本地音色（Piper / Kokoro）不在系统语音列表里，
     * 单独补一项，否则下拉会显示成「系统默认」。 */
    var local = String(cur).indexOf('piper:') === 0 || String(cur).indexOf('kokoro:') === 0;
    if (local) {
      var po = document.createElement('option');
      po.value = cur;
      var spec = localVoiceSpec();
      po.textContent = spec ? ('本地语音 · ' + spec.label) : '本地语音（模型商店）';
      sel.appendChild(po);
    }
    sel.value = cur;
    /* 商店里选的可能是英文音色，下拉只列中文音色时选中会落空，退回人设值 */
    if (sel.value !== cur) sel.value = saved;
    sel.disabled = !list.length && !local;
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

  /* 商店里下载的本地音色（Piper / Kokoro）不在系统语音列表里：交给本地引擎桥合成 WAV 再播。
   * 引擎没起来（浏览器模式 / 被卸载）时退回系统语音，不让数字人整段静音。 */
  function speakLocal(clean, spec) {
    if (!spec || typeof fetch !== 'function' || typeof rtBase !== 'function' || typeof Audio !== 'function') return false;
    var base = rtBase();
    if (!base) return false;
    var tts = S.persona.tts || DEFAULT_PERSONA.tts;
    var rate = clamp(Number(tts.rate) || 1.04, 0.7, 1.4);
    var payload = { text: clean, engine: spec.engine, rate: rate };
    if (spec.engine === 'kokoro') payload.sid = spec.sid;
    else payload.voice = spec.voice;
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
      speakSystem(clean);
    });
    return true;
  }

  function speakAloud(text, force) {
    if (!S || (!S.voiceOn && !force) || !text) return;
    var clean = String(text).replace(/[【】\[\]]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {
      stopSpeech();
      var spec = localVoiceSpec();
      if (spec && speakLocal(clean, spec)) return;
      speakSystem(clean);
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
  function injectScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(el);
    });
  }

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  /* 模型加载器中间件：pack.js 里已有的文件不再走 XHR（file:// 下 XHR 读不到本地文件）。
     moc3 是 base64 → ArrayBuffer，其余 json 已经是对象。 */
  function serveFromPack(pack) {
    var mocUrl = pack.settings.FileReferences.Moc;
    var mocBuf = null;
    return function (ctx, next) {
      if (ctx.type === 'arraybuffer' && ctx.url === mocUrl) {
        if (!mocBuf) mocBuf = b64ToBuffer(pack.moc);
        ctx.result = mocBuf;
        return;
      }
      var data = pack.json[ctx.url];
      if (data) { ctx.result = data; return; }
      return next();
    };
  }

  function loadRig() {
    var st = S.rig;
    if (st.loading || st.ready) return;
    st.loading = true;
    if (S.refs.rigErr) S.refs.rigErr.hidden = true;

    var chain = Promise.resolve();
    RIG_SCRIPTS.forEach(function (src) {
      chain = chain.then(function () { return injectScript(src); });
    });

    chain.then(function () {
      var pack = window.L2D_PACK;
      if (!pack || !window.PIXI || !window.PIXI.live2d) throw new Error('运行时未就绪');
      if (window.PIXI.live2d.Live2DLoader) {
        window.PIXI.live2d.Live2DLoader.middlewares.unshift(serveFromPack(pack));
      }
      /* 构造时就要求 url 是字符串；纹理换成 data: URL，避免 file:// 下 CORS 拦图 */
      var refs = Object.assign({}, pack.settings.FileReferences, { Textures: pack.textures });
      var json = Object.assign({}, pack.settings, {
        FileReferences: refs,
        url: new URL(RIG_DIR, location.href).href
      });
      var settings = new window.PIXI.live2d.Cubism4ModelSettings(json);

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
          app.stage.addChild(model);
          st.app = app;
          st.model = model;

          /* 口型与嘴形在模型参数更新前写进去，表情/物理算完之后才不会被覆盖；
             顺手留一份参数快照，探针要读「本帧真实参与绘制的值」 */
          model.internalModel.on('beforeModelUpdate', function () {
            var cm = model.internalModel.coreModel;
            cm.setParameterValueById('ParamMouthOpenY', clamp(st.mouth, 0, 1));
            cm.setParameterValueById('ParamMouthForm', clamp(st.mouthForm, -1, 1));
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

          /* 模型自带的 idle 组名是 Idle，这里换成本项目注册的 idle */
          if (model.internalModel.motionManager) {
            model.internalModel.motionManager.groups.idle = 'idle';
          }

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
    }).catch(function (err) {
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
          <div class="st-playhead" id="stPlayhead"><b></b></div>
        </div>
      </div>
    </div>
  </div>

  <input type="file" id="stProjFile" accept=".hfstudio,.json,application/json" aria-label="导入项目文件" hidden>

  <div class="st-modal hidden" id="stLibModal">
    <div class="st-modal-card wide" role="dialog" aria-modal="true" aria-label="从视频库添加">
      <div class="st-modal-h">
        <b>从视频库添加</b>
        <button type="button" class="st-modal-x" data-close="stLibModal" aria-label="关闭">×</button>
      </div>
      <div class="st-modal-body">
        <div class="st-libsearch">
          <input type="search" id="stLibSearch" placeholder="搜索视频库…" aria-label="搜索视频库">
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
  const SAVE_VER = 2;
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
    kfVolume: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="M14.6 9.4a4 4 0 0 1 0 5.2M17.2 7.2a7.4 7.4 0 0 1 0 9.6"/>'
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
  function cssFilter(id) {
    const f = FILTERS.find((x) => x.id === id);
    return (f && f.css) || 'none';
  }

  /* ---------------- 项目模型（v2） ---------------- */
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

  /* v1 → v2：补齐轨道、标记、关键帧容器。对 v2 是恒等操作，可重复调用。 */
  function migrateProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ver = Number(raw.v) || 1;
    if (ver >= SAVE_VER) return raw;
    const out = JSON.parse(JSON.stringify(raw));
    out.v = SAVE_VER;
    out.sampleRate = 48000;
    out.tracks = defaultTracks();
    out.markers = [];
    out.meta = { createdAt: 0, updatedAt: 0, app: 'studio' };
    out.clips = (Array.isArray(out.clips) ? out.clips : []).map(function (c) {
      if (!c || typeof c !== 'object') return c;
      if (!c.kf) c.kf = {};
      return c;
    });
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
      filter: c.filter || 'none',
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
        source: m.source === 'library' ? 'library' : 'file',
        libId: m.libId ? String(m.libId) : ''
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
    trackSig: ''
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
    /* 只存视频库素材：文件素材的 objectURL 在下次启动必定失效 */
    copy.media = copy.media.filter(function (m) { return m.source === 'library'; });
    const keep = new Set(copy.media.map(function (m) { return m.id; }));
    copy.clips = copy.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    return copy;
  }

  function readSnaps() {
    try {
      const arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function snapshotProject() {
    /* 快照保留完整项目（含本会话的 blob/objectURL），用于崩溃后当场恢复；
       跨会话读取时 loadSaved 仍会剔除失效的文件素材。 */
    return { at: Date.now(), time: S.time, name: S.project.name, project: JSON.parse(JSON.stringify(S.project)) };
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

  /* ---------------- 历史 ---------------- */
  function snap() { return JSON.stringify(S.project); }
  function pushHistory() {
    S.hist.push(snap());
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
    S.future.push(snap());
    S.project = normalizeProject(JSON.parse(S.hist.pop()));
    afterRestore();
    return true;
  }
  function redo() {
    if (!S.future.length) return false;
    S.hist.push(snap());
    S.project = normalizeProject(JSON.parse(S.future.pop()));
    afterRestore();
    return true;
  }
  function afterRestore() {
    if (S.sel && !clipOf(S.sel)) S.sel = '';
    const alive = new Set(S.project.clips.map(function (c) { return c.id; }));
    Array.from(S.multi).forEach(function (id) {
      if (!alive.has(id)) S.multi.delete(id);
    });
    S.time = clamp(S.time, 0, Math.max(0, projectDuration(S.project)));
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
    el.style.filter = cssFilter(c.filter);
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
      v.playbackRate = clamp(c.speed, 0.25, 4);
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
    a.playbackRate = clamp(c.speed, 0.25, 4);
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
      if (t.kind === 'video') syncVisual(t.id, S.time, S.playing);
      else if (t.kind === 'audio') syncAudio(t.id, S.time, S.playing);
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

  function play() {
    const dur = projectDuration(S.project);
    if (dur <= 0.05) { toast('时间线还是空的，先把素材拖进轨道'); return; }
    if (S.time >= dur - 0.02) S.time = 0;
    ensureAudio();
    resumeAudio();
    applyMonitorGain();
    S.playing = true;
    S.last = 0;
    paintPlayIcon();
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(tick);
    applyTime();
  }

  function pause() {
    S.playing = false;
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
  }

  function togglePlay() { if (S.playing) pause(); else play(); }

  function tick(now) {
    if (!S.playing) { S.raf = 0; return; }
    if (!S.last) S.last = now;
    let dt = (now - S.last) / 1000;
    S.last = now;
    if (dt > 0.3) dt = 0.3;
    const dur = projectDuration(S.project);
    S.time += dt;
    if (S.time >= dur) {
      if (S.loop && !S.exportSession) {
        S.time = 0;
        S.last = 0;
        applyTime();
        S.raf = requestAnimationFrame(tick);
        return;
      }
      S.time = dur;
      applyTime();
      if (S.exportSession) { finishExportTick(); return; }
      pause();
      toast('已播放到结尾');
      return;
    }
    applyTime();
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
    const meta = showMeta ? '<span class="st-clip-meta">' + fmtDur(c.dur) +
      (c.speed !== 1 ? ' · ' + c.speed.toFixed(2) + 'x' : '') +
      (kfCount ? ' · ◆' + kfCount : '') + '</span>' : '';
    return '<div class="st-clip' + (isSelClip(c) ? ' sel' : '') + '" data-id="' + c.id +
      '" data-kind="' + c.kind + '" style="left:' + left.toFixed(1) + 'px;width:' + width.toFixed(1) + 'px" title="' +
      escHtml(c.name) + '">' +
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
    pushHistory();
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
    pushHistory();
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
    pushHistory();
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
    pushHistory();
    S.project.tracks = S.project.tracks.filter(function (x) { return x.id !== id; });
    if (S.sel && !clipOf(S.sel)) S.sel = '';
    rebuildTracks();
    toast('已删除空轨道');
    return true;
  }

  function setTrackFlag(id, key) {
    const t = trackOf(id);
    if (!t || ['locked', 'muted', 'solo', 'hidden'].indexOf(key) < 0) return;
    pushHistory();
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
    pushHistory();
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
    pushHistory();
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

  /* 把指定片段在时间 t 处切成两段（播放头分割与剃刀工具共用）。 */
  function splitClip(target, t) {
    if (!target) return null;
    if (t <= target.start + 0.04 || t >= target.start + target.dur - 0.04) return null;
    if (trackLocked(target.track)) { toast('轨道已锁定，先解锁'); return null; }
    pushHistory();
    const leftDur = t - target.start;
    const right = JSON.parse(JSON.stringify(target));
    right.id = uid('c');
    right.start = t;
    right.dur = target.dur - leftDur;
    right.in = round2(target.in + leftDur * target.speed);
    /* 关键帧按分割点切成两段，右段的时间轴归零 */
    right.kf = {};
    Object.keys(target.kf || {}).forEach(function (prop) {
      const arr = target.kf[prop];
      const left = arr.filter(function (k) { return k.t <= leftDur + 0.001; });
      const rightPts = arr.map(function (k) {
        return { t: round2(k.t - leftDur), v: k.v, ease: k.ease };
      }).filter(function (k) { return k.t >= -0.001; });
      if (left.length) target.kf[prop] = left;
      else delete target.kf[prop];
      if (rightPts.length) right.kf[prop] = rightPts;
    });
    target.dur = round2(leftDur);
    S.project.clips.push(right);
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
    pushHistory();
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
    pushHistory();
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
    pushHistory();
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

  function clipMenuItems(c) {
    const lock = trackLocked(c.track);
    const inClip = S.time > c.start + 0.04 && S.time < c.start + c.dur - 0.04;
    const detached = audioDetachedFor(c);
    return [
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
    pushHistory();
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
    pushHistory();
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
  function onTimelineDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const trim = e.target.closest('.st-trim');
    const clipNode = e.target.closest('.st-clip');
    const row = e.target.closest('.st-row');
    if (!clipNode) {
      if (!row) return;
      selectClip('');
      S.drag = { mode: 'scrub', pointerId: e.pointerId };
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
    pushHistory();
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
    if (d.mode === 'scrub') { seek(timeAtX(e.clientX)); return; }
    if (d.mode === 'height') {
      setTrackHeight(d.id, d.h0 + (e.clientY - d.y0));
      d.changed = true;
      return;
    }
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
    if (d.mode === 'scrub') return;
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
      (m.source === 'library' ? ' · 视频库' : '') + '</div></div>';
  }

  function renderMedia() {
    const grid = $('stMediaGrid');
    const empty = $('stMediaEmpty');
    if (!grid) return;
    const q = ($('stMediaSearch') && $('stMediaSearch').value || '').trim().toLowerCase();
    const list = S.project.media.filter(function (m) {
      return !q || m.name.toLowerCase().indexOf(q) >= 0;
    });
    grid.innerHTML = list.map(mediaCard).join('');
    if (empty) empty.classList.toggle('hidden', list.length > 0);
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
    pushHistory();
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

  /* ---------------- 视频库 ---------------- */
  async function openLibrary() {
    const modal = $('stLibModal');
    const list = $('stLibList');
    if (!modal || !list) return;
    S.libPick = new Set();
    modal.classList.remove('hidden');
    list.innerHTML = '<div class="st-modal-empty">正在读取视频库…</div>';
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

  function libUrl(f) {
    const pa = window.playerApp;
    if (pa && typeof pa._urlOf === 'function') return pa._urlOf(f);
    return '';
  }

  function renderLibList(q) {
    const list = $('stLibList');
    if (!list) return;
    const query = String(q || '').trim().toLowerCase();
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
        '<span class="st-libmeta">' + (added ? '已在素材库' : '点击选择') + '</span></div>';
    }).join('');
    updateLibAdd();
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
        libId: libId
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
      trackPanel() + snapshotPanel() +
      '<div class="st-insp-sec"><h4>操作提示</h4><div class="st-insp-empty"><ul>' +
      '<li>拖素材到轨道，或双击素材自动追加</li>' +
      '<li>Alt+拖边缘＝波纹裁剪，Ctrl+拖边缘＝滚动剪辑</li>' +
      '<li>Alt+拖片段＝滑移，Ctrl+拖片段＝滑动</li>' +
      '<li>Shift/Ctrl+点选多选，拖任意一个整体移动</li>' +
      '<li>空格播放，S 分割，M 打标记，Delete 删除</li>' +
      '<li>Shift+Delete 波纹删除，Ctrl+Z / Ctrl+Shift+Z 撤销重做</li>' +
      '</ul></div></div>';
  }

  function kfPanel(c) {
    const labels = { opacity: '透明', scale: '缩放', x: '水平', y: '垂直', rot: '旋转', volume: '音量' };
    const props = KF_PROPS.filter(function (p) { return c.kind !== 'text' || p !== 'volume'; });
    const sum = props.filter(function (p) { return c.kf && c.kf[p] && c.kf[p].length; })
      .map(function (p) { return labels[p] + ' ' + c.kf[p].length; }).join(' · ');
    return '<div class="st-insp-sec"><h4>关键帧</h4>' +
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
    if (!c) { box.innerHTML = projectPanel(); return; }
    const isText = c.kind === 'text';
    const isVisual = c.kind === 'video' || c.kind === 'image';
    const m = c.mediaId ? mediaOf(c.mediaId) : null;
    const multiN = S.multi.size;
    let html = '<div class="st-insp-sec"><h4>片段<em>' + kindLabel(c.kind) + (m ? ' · ' + escHtml(m.name) : '') +
      (multiN > 1 ? ' · 已选 ' + multiN + ' 个' : '') + '</em></h4>' +
      '<label class="st-field wide"><span>名称</span><input type="text" data-prop="name" value="' + escHtml(c.name) + '"></label>' +
      num('起点', 'start', c.start.toFixed(2), 0, 3600, 0.1, 's') +
      num('时长', 'dur', c.dur.toFixed(2), MIN_CLIP, 3600, 0.1, 's');
    if (!isText) html += num('入点', 'in', c.in.toFixed(2), 0, 3600, 0.1, 's');
    html += '</div>';

    if (isText) {
      html += '<div class="st-insp-sec"><h4>文字</h4>' +
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
        '</div>';
    }

    if (isVisual || isText) {
      html += '<div class="st-insp-sec"><h4>画面</h4>' +
        rng('缩放', 'scalePct', Math.round(c.scale * 100), 20, 300, 1, Math.round(c.scale * 100) + '%') +
        rng('水平', 'x', Math.round(c.x), -50, 50, 1, Math.round(c.x) + '%') +
        rng('垂直', 'y', Math.round(c.y), -50, 50, 1, Math.round(c.y) + '%') +
        rng('旋转', 'rot', Math.round(c.rot), -180, 180, 1, Math.round(c.rot) + '°') +
        rng('透明', 'opacityPct', Math.round(c.opacity * 100), 0, 100, 1, Math.round(c.opacity * 100) + '%');
      if (isVisual) {
        html += '<label class="st-field wide"><span>滤镜</span><select data-prop="filter">' +
          FILTERS.map(function (f) {
            return '<option value="' + f.id + '"' + (f.id === c.filter ? ' selected' : '') + '>' + f.name + '</option>';
          }).join('') + '</select></label>';
      }
      html += '</div>';
    }

    if (!isText) {
      html += '<div class="st-insp-sec"><h4>声音与速度</h4>' +
        rng('音量', 'volumePct', Math.round(c.volume * 100), 0, 100, 1, Math.round(c.volume * 100) + '%') +
        '<label class="st-checkrow"><input type="checkbox" data-prop="muted"' + (c.muted ? ' checked' : '') + '> 静音本片段</label>' +
        rng('速度', 'speed', c.speed, 0.25, 4, 0.05, c.speed.toFixed(2) + 'x') +
        '</div>';
    }

    html += '<div class="st-insp-sec"><h4>动画</h4>' +
      rng('淡入', 'fadeIn', c.fadeIn, 0, 5, 0.1, c.fadeIn.toFixed(1) + 's') +
      rng('淡出', 'fadeOut', c.fadeOut, 0, 5, 0.1, c.fadeOut.toFixed(1) + 's') +
      '</div>';

    html += kfPanel(c);

    html += '<div class="st-insp-act"><button type="button" class="st-ghost st-icobtn" data-act="dup" title="复制片段" aria-label="复制片段">' + ico('copy') + '</button>' +
      '<button type="button" class="st-ghost st-icobtn" data-act="del" title="删除片段" aria-label="删除片段">' + ico('trash') + '</button>' +
      '<button type="button" class="st-ghost st-icobtn" data-act="rdel" title="波纹删除" aria-label="波纹删除">' + ico('rippleDel') + '</button></div>';
    box.innerHTML = html;
    paintFxSel();
  }

  function paintFxSel() {
    const c = selected();
    document.querySelectorAll('#stFxGrid .st-fxcard').forEach(function (n) {
      n.classList.toggle('on', !!c && c.filter === n.dataset.fx);
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
      case 'filter': c.filter = String(v); break;
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
    if (S.inspSnap && snap() !== S.inspSnap) {
      S.hist.push(S.inspSnap);
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
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveNow(); toast('项目已保存到本机'); return; }
    if (mod) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
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
    ['空格', '播放 / 暂停'],
    ['V / B', '选择工具 / 剃刀工具'],
    ['S', '在播放头处分割'],
    ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'],
    ['Ctrl+D', '复制片段'],
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
        { label: '导出视频…', run: function () { $('stExport').click(); } }
      ] },
      { id: 'edit', items: [
        { label: '撤销', hint: 'Ctrl+Z', disabled: !S.hist.length, run: undo },
        { label: '重做', hint: 'Ctrl+Shift+Z', disabled: !S.future.length, run: redo },
        { sep: true },
        { label: '在播放头处分割', hint: 'S', run: function () { splitAt(); } },
        { label: '复制片段', hint: 'Ctrl+D', run: duplicateSelected },
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
        { label: '循环播放', checked: S.loop, run: function () { setLoop(!S.loop); } }
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
      pushHistory();
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

    $('stTextPresets').addEventListener('click', function (e) {
      const b = e.target.closest('[data-preset]');
      if (b) addTextClip(b.dataset.preset);
    });

    $('stFxGrid').addEventListener('click', function (e) {
      const card = e.target.closest('.st-fxcard');
      if (!card) return;
      const c = selected();
      if (!c || (c.kind !== 'video' && c.kind !== 'image')) {
        toast('先选中一个视频 / 图片片段');
        return;
      }
      pushHistory();
      c.filter = card.dataset.fx;
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
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'dup') duplicateSelected();
      else if (b.dataset.act === 'del') deleteSelected(false);
      else if (b.dataset.act === 'rdel') deleteSelected(true);
      else if (b.dataset.act === 'kfclear' && S.sel) clearKeyframes(S.sel);
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
    $('stLibSearch').addEventListener('input', function (e) { renderLibList(e.target.value); });
    $('stLibList').addEventListener('click', function (e) {
      const row = e.target.closest('.st-librow');
      if (!row || row.classList.contains('added')) return;
      const id = row.dataset.lib;
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
    /* 文件素材的 blob: 地址跨会话必失效，导入时只保留视频库素材与文字 */
    p.media = p.media.filter(function (m) { return m.source === 'library'; });
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
    S.time = 0;
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
      dur: dur,
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
    S.time = 0;
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

  function drawEl(ctx, el, c, W, H, kind) {
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
    const view = visualOf(c, S.time);
    const dw = mw * fit * view.scale;
    const dh = mh * fit * view.scale;
    ctx.save();
    ctx.globalAlpha = clamp(view.opacity * fadeFactor(c, S.time), 0, 1);
    const f = cssFilter(c.filter);
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

  function drawExportTexts(ctx, W, H) {
    const t = S.time;
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

  function drawExportFrame() {
    const v = S.exportSession;
    if (!v) return;
    const W = v.opts.w;
    const H = v.opts.h;
    const ctx = v.ctx;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    /* 轨道数组自上而下是「上层 → 下层」，绘制时反过来：下层先画、上层后盖 */
    const visualTracks = tracksOfKind('video').slice().reverse();
    visualTracks.forEach(function (tk) {
      if (!trackActive(tk)) return;
      const c = activeClipOn(tk.id, S.time);
      if (!c) return;
      const m = mediaOf(c.mediaId);
      const pool = S.pool[tk.id];
      if (!m || !pool) return;
      const el = m.kind === 'image' ? pool.img : pool.video;
      drawEl(ctx, el, c, W, H, m.kind);
    });
    drawExportTexts(ctx, W, H);
    ctx.restore();
  }

  function paintExportProgress() {
    const v = S.exportSession;
    if (!v) return;
    const now = performance.now();
    if (now - v.lastPaint < 120) return;
    v.lastPaint = now;
    const pct = clamp((S.time / v.dur) * 100, 0, 100);
    const bar = $('stExBar');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const txt = $('stExTxt');
    if (txt) {
      txt.textContent = '正在渲染 ' + fmtMmss(S.time) + ' / ' + fmtMmss(v.dur) + ' · ' + pct.toFixed(0) + '%';
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
          frameH: S.frameH
        };
      },
      project: function () { return JSON.parse(JSON.stringify(S.project)); },
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
        pushHistory();
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
