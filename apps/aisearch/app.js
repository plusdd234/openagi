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
