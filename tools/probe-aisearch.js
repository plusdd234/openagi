/* 探针：智搜（AI 搜索）是否真能从桌面打开，并把「检索 → 读正文 → 生成摘要」这条链走通。
 * 用法：node tools/probe-aisearch.js
 *
 * 为什么把网络替身全部打成桩：
 *   ① 搜索源在公网，离线/墙内会偶发失败，不该让这条测试时红时绿；
 *   ② 本地中转 8787 不是每个环境都开着，探针不该假设它独占；
 *   ③ 这里要验的是 App 自己的过滤、抽取、渲染与幂等，不是 Bing 的可用性。
 *   真网络另有 tools/probe-search-live.js 负责。
 *
 * 覆盖：
 *   ① 桌面有「智搜」图标，点进去是首页而不是空白；
 *   ② 搜索后进入结果页，广告站 / 文库页 / 同站重复标题被剔除；
 *   ③ 正文抓取成功与失败分别落到「已精读」「仅摘要」；
 *   ④ AI 摘要有来源编号，点编号能定位到右侧来源卡；
 *   ⑤ 模型输出里的 HTML 被转义，不会执行；
 *   ⑥ 切回桌面再打开，当前问题与摘要还在（mount 幂等）；
 *   ⑦ 影视模式只留官方平台；非官方视频只给直链，网页只能转交内置浏览器安全打开；
 *   ⑧ 全程无 pageerror。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const run = createRun('probe-aisearch');
let fails = 0;
const failed = [];
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) { fails++; failed.push(name + (extra ? ' · ' + extra : '')); }
};

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.classList.contains('hidden') && cs.display !== 'none' &&
    cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
}, sel);

const LONG = 'DeepSeek 官方文档说明：模型支持 128K 上下文窗口，并给出推理模型与通用模型的差异、'
  + '定价方式、接口兼容性以及常见问题。这一段文字足够长，用来模拟真实网页里可读的正文段落。';

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1100);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="aisearch"]')),
    '桌面上的「智搜」图标存在');

  /* ---- 网络替身：健康检查、网页抓取、搜索源、语言模型 ---- */
  await page.evaluate(() => {
    window.fetch = function (url, init) {
      const u = String(url);
      if (/\/health$/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' }
        }));
      }
      if (/\/proxy$/.test(u)) {
        const h = (init && init.headers) || {};
        const target = h['X-Relay-Target'] || h['x-relay-target'] || '';
        if (/api\.github\.com\/search\/repositories/.test(target)) {
          /* 仓库检索的桩：一次给 12 个，用来验证「不能只取 6 条就下结论」。 */
          const items = Array.from({ length: 12 }, (_, i) => ({
            full_name: 'stub/shooter-template-' + i,
            description: 'open source shooter game template ' + i,
            html_url: 'https://github.com/stub/shooter-template-' + i,
            stargazers_count: 900 - i,
            language: 'C#'
          }));
          return Promise.resolve(new Response(JSON.stringify({ items }), {
            status: 200, headers: { 'content-type': 'application/json' }
          }));
        }
        let html = '<html><head><title>资料页</title></head><body><article>';
        if (/api-docs/.test(target)) {
          html += '<h1>DeepSeek 模型文档</h1><p>' + 'A'.repeat(10) + '</p>';
          html += '<p>' + 'DeepSeek 的上下文窗口为 128K，并支持函数调用与 JSON 输出。这一段是正文，足够长以便通过抽取阈值。'.repeat(4) + '</p>';
        } else if (/example\.org/.test(target)) {
          html += '<p>' + '更新说明：本次发布调整了价格并新增了推理模型，旧模型继续可用。'.repeat(6) + '</p>';
        } else if (/v\.qq\.com/.test(target)) {
          html += '<h1>流浪地球2</h1><p>' + '流浪地球2 正片免费观看，高清画质，片头含广告。腾讯视频提供免费观看与会员抢先看两种方式。'.repeat(4) + '</p>';
        } else if (/iqiyi\.com/.test(target)) {
          html += '<h1>流浪地球2 在线观看</h1><p>' + '本片为 VIP 会员专享，1080P 高清，非会员可免费试看前 6 分钟。'.repeat(4) + '</p>';
        } else if (/archive\.org/.test(target)) {
          html += '<h1>Free Movie</h1><p>' + 'This public domain film is free to watch online. 公共版权影片，免费观看，无需注册。'.repeat(4) + '</p>';
        } else {
          html += '<p>短</p>';
        }
        html += '</article><nav><a>首页</a><a>登录</a></nav></body></html>';
        return Promise.resolve(new Response(html, {
          status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }
        }));
      }
      if (/api\.github\.com\/search\/repositories/.test(u)) {
        /* 仓库检索的桩：一次给 12 个，用来验证「不能只取 6 条就下结论」。 */
        const items = Array.from({ length: 12 }, (_, i) => ({
          full_name: 'stub/shooter-template-' + i,
          description: 'open source shooter game template ' + i,
          html_url: 'https://github.com/stub/shooter-template-' + i,
          stargazers_count: 900 - i,
          language: 'C#'
        }));
        return Promise.resolve(new Response(JSON.stringify({ items }), {
          status: 200, headers: { 'content-type': 'application/json' }
        }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };
    window.deskSearch = {
      run: function (q) {
        if (/在线观看/.test(String(q || ''))) {
          return Promise.resolve({
            ok: true, provider: 'stub', ms: 8,
            results: [
              { title: '流浪地球2 免费观看_腾讯视频', url: 'https://v.qq.com/x/cover/mzc00200.html', snippet: '高清正片 免费观看（含广告）' },
              { title: '流浪地球2 在线观看 - 爱奇艺', url: 'https://www.iqiyi.com/v_abc.html', snippet: 'VIP会员专享，1080P' },
              { title: '流浪地球 2 · Free Movie · Internet Archive', url: 'https://archive.org/details/example-film', snippet: '公共版权，免费观看' },
              { title: '流浪地球2 1080P 高清下载', url: 'https://cdn.example-media.com/vod/wandering-earth-2-1080p.mp4', snippet: 'MP4 视频直链' },
              { title: '流浪地球2 免费高清完整版下载', url: 'https://www.123movie-pirate.com/x', snippet: '迅雷下载 磁力' },
              { title: '流浪地球2 - 豆瓣', url: 'https://movie.douban.com/subject/1', snippet: '剧情简介与演职员' }
            ]
          });
        }
        /* 第一轮返回固定清单；「进一步搜索」再问时多给一条新结果，
           用来验证去重 / 相关性筛选之后，新命中确实会并进列表并打上「深挖」。 */
        const round = window.__stubSearchCalls || 0;
        window.__stubSearchCalls = round + 1;
        const results = [
          { title: 'DeepSeek 模型文档', url: 'https://api-docs.deepseek.com/zh-cn/', snippet: '官方文档：上下文窗口 128K' },
          { title: 'DeepSeek 发布说明', url: 'https://example.org/news/release', snippet: '价格调整与模型更新' },
          { title: '破解版 DeepSeek 绿色版 高速下载', url: 'https://pc6.com/soft/123', snippet: '下载站广告' },
          { title: 'DeepSeek 介绍 - 百度文库', url: 'https://wenku.baidu.com/view/1', snippet: '登录后查看' },
          { title: 'DeepSeek 使用心得', url: 'https://news.example.com/p/1', snippet: '一篇普通文章' },
          { title: 'DeepSeek 使用心得', url: 'https://news.example.com/p/2', snippet: '同站重复标题' }
        ];
        if (round > 0) {
          results.push(
            { title: 'DeepSeek 上下文窗口 128K 详解', url: 'https://example.org/news/extra', snippet: '模型上下文与接口说明' },
            { title: 'DeepSeek 使用心得', url: 'https://news.example.com/p/1', snippet: '一篇普通文章' }
          );
        }
        return Promise.resolve({ ok: true, provider: 'stub', ms: 8, results: results });
      }
    };
    window.llmConn = function () { return { base: 'http://stub/v1', key: 'stub', model: 'stub-model' }; };
    window.LLMRouter = window.LLMRouter || {};
    window.LLMRouter.complete = function (o) {
      window.__llmLast = { sys: String(o.sys || ''), user: String((o.messages && o.messages[0] && o.messages[0].content) || '') };
      const media = /影视来源助手/.test(window.__llmLast.sys);
      const parts = media ? [
        '**结论**：《流浪地球 2》在腾讯视频可以免费观看（含广告）[1]，爱奇艺需要会员[2]。',
        '\n\n- 腾讯视频：免费正片[1]；',
        '\n- 爱奇艺：VIP 会员专享[2]；',
        '\n- Internet Archive 有公共版权副本[3]。',
        '\n\n<script>window.__aisXss = 1</script>'
      ] : [
        '**结论**：DeepSeek 的上下文窗口为 128K[1]。',
        '\n\n- 官方文档给出了能力与接口说明[1]；',
        '\n- 发布说明提到价格调整[2]；',
        '\n- 第三篇资料内容较少，只作补充[3]。',
        '\n\n<script>window.__aisXss = 1</script>'
      ];
      let acc = '';
      let i = 0;
      return new Promise(function (resolve) {
        (function step() {
          if (i >= parts.length) { resolve(acc); return; }
          acc += parts[i++];
          if (o.onDelta) o.onDelta(acc, parts[i - 1]);
          setTimeout(step, 12);
        })();
      });
    };
  });

  await page.evaluate(() => window.openDeskApp('aisearch'));
  await page.waitForTimeout(1200);

  /* 模式会持久化在 localStorage 里，上一次真人使用可能停在影视模式。
     这里显式切回网页模式，保证探针不依赖机器上的旧状态。 */
  await page.evaluate(() => {
    const b = document.querySelector('#aisearchWin .ais-mode[data-mode="web"]');
    if (b && !b.classList.contains('is-on')) b.click();
  });
  await page.waitForTimeout(200);

  check(await visible(page, '#aisearchWin'), '智搜窗口已翻到前台');
  check(await visible(page, '#aisearchWin .ais-hero'), '首次打开停在首页');
  check(await page.evaluate(() => document.querySelectorAll('#aisearchWin .ais-chip').length >= 4),
    '首页示例问题已铺开');
  check(await page.evaluate(() => !!document.querySelector('#aisearchWin .ais-hero-input')),
    '首页搜索框存在');

  /* ---- 1. 搜索 ---- */
  await page.fill('#aisearchWin .ais-hero-input', 'DeepSeek 最新模型');
  await page.press('#aisearchWin .ais-hero-input', 'Enter');
  await page.waitForTimeout(300);
  check(await visible(page, '#aisearchWin .ais-result'), '提交后进入结果页');
  check(!(await visible(page, '#aisearchWin .ais-hero')), '首页让位给结果页');

  await page.waitForFunction(() => document.querySelectorAll('#aisearchWin .ais-hit').length >= 3, null, { timeout: 8000 });
  const hits = await page.evaluate(() => [...document.querySelectorAll('#aisearchWin .ais-hit')].map((el) => ({
    title: el.querySelector('.ais-hit-title').textContent,
    url: el.querySelector('.ais-hit-url').textContent
  })));
  check(hits.length === 3, '保留 3 条可用结果', hits.map(h => h.title).join(' / ').slice(0, 60));
  check(!hits.some(h => /pc6|wenku/.test(h.url)), '下载站 / 文库摘录页已剔除');
  check(!hits.some(h => h.url.includes('/p/2')), '同站重复标题已合并');
  const filtered = await page.evaluate(() => (document.querySelector('#aisearchWin .ais-filtered').textContent || '').trim());
  check(/已过滤\s*3/.test(filtered), '过滤条给出数量与原因', filtered);

  /* ---- 2. 正文抓取与来源状态 ---- */
  await page.waitForFunction(() => {
    const s = [...document.querySelectorAll('#aisearchWin .ais-src')];
    return s.length >= 3 && s.every(x => /is-read|is-snippet/.test(x.className));
  }, null, { timeout: 9000 });
  const srcs = await page.evaluate(() => [...document.querySelectorAll('#aisearchWin .ais-src')].map((el) => ({
    cls: el.className,
    meta: el.querySelector('.ais-src-meta').textContent
  })));
  check(srcs.filter(s => s.cls.includes('is-read')).length >= 2, '至少两篇正文读取成功', JSON.stringify(srcs.map(s => s.meta)));
  check(srcs.some(s => s.cls.includes('is-snippet')), '抓取失败的一篇降级为「仅摘要」');

  /* ---- 3. AI 摘要与引用 ---- */
  await page.waitForFunction(() => {
    const b = document.querySelector('#aisearchWin .ais-answer-body');
    return b && b.textContent.includes('结论');
  }, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const answer = await page.evaluate(() => document.querySelector('#aisearchWin .ais-answer-body').textContent);
  check(answer.includes('128K'), '摘要读到了正文里的关键事实');
  const cites = await page.evaluate(() => document.querySelectorAll('#aisearchWin .ais-cite').length);
  check(cites >= 2, '摘要带来源编号', cites + ' 个');

  /* ---- 4. XSS：模型输出里的脚本只应作为文字出现 ---- */
  const xss = await page.evaluate(() => ({
    flag: window.__aisXss === 1,
    scripts: document.querySelectorAll('#aisearchWin .ais-answer-body script').length,
    text: document.querySelector('#aisearchWin .ais-answer-body').textContent
  }));
  check(!xss.flag && xss.scripts === 0, '模型输出里的 <script> 被转义，没有执行');
  check(xss.text.includes('<script>'), '脚本以纯文本显示（证明确实转义而不是丢弃）');

  /* ---- 5. 编号 → 来源卡定位 ---- */
  await page.evaluate(() => document.querySelector('#aisearchWin .ais-cite').click());
  await page.waitForTimeout(150);
  check(await page.evaluate(() => {
    const s = document.querySelector('#aisearchWin #ais-src-1');
    return !!s && s.classList.contains('is-flash');
  }), '点击编号能定位并高亮对应来源');

  /* ---- 6. 幂等：切回桌面再打开 ---- */
  const before = await page.evaluate(() => ({
    q: document.querySelector('#aisearchWin .ais-input').value,
    ans: document.querySelector('#aisearchWin .ais-answer-body').textContent
  }));
  await page.evaluate(() => window.deskAppLeave());
  await page.waitForTimeout(450);
  await page.evaluate(() => window.openDeskApp('aisearch'));
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    q: document.querySelector('#aisearchWin .ais-input').value,
    ans: document.querySelector('#aisearchWin .ais-answer-body').textContent
  }));
  check(after.q === before.q && after.ans === before.ans, '重新打开后问题与摘要都还在（mount 幂等）');
  check(await visible(page, '#aisearchWin .ais-result'), '重新打开仍停在结果页');

  /* ---- 6.5 进一步搜索：用线索再搜一轮，无关 / 重复的要去掉 ---- */
  const deepBtn = await page.evaluate(() => {
    const b = document.querySelector('#aisearchWin [data-act="deepen"]');
    return b ? { exists: true, hidden: b.hidden } : { exists: false };
  });
  check(deepBtn.exists && !deepBtn.hidden, '读完一轮后出现「进一步搜索」');
  if (deepBtn.exists && !deepBtn.hidden) {
    await page.evaluate(() => document.querySelector('#aisearchWin [data-act="deepen"]').click());
    /* 先等深挖这一步落进链路，再等这一轮读完 —— 点击瞬间状态本来就已经是「完成」。 */
    await page.waitForFunction(() => [...document.querySelectorAll('#aisearchWin .ais-trace-kind')]
      .some((el) => /深挖/.test(el.textContent || '')), null, { timeout: 12000 });
    await page.waitForFunction(() => {
      const s = document.querySelector('#aisearchWin .ais-status');
      return s && /完成|未找到|失败/.test(s.textContent || '');
    }, null, { timeout: 12000 });
    const deep = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#aisearchWin .ais-hit')];
      const extra = items.find((el) => /news\/extra/.test(el.querySelector('.ais-hit-url').textContent));
      return {
        steps: [...document.querySelectorAll('#aisearchWin .ais-trace-item')]
          .filter((el) => /深挖/.test(el.querySelector('.ais-trace-kind').textContent)).length,
        once: document.querySelector('#aisearchWin [data-act="deepen"]').hidden,
        added: !!extra,
        badge: !!(extra && extra.querySelector('.ais-badge.is-deep')),
        dup: items.filter((el) => /news\.example\.com\/p\/1/.test(el.querySelector('.ais-hit-url').textContent)).length
      };
    });
    check(deep.steps >= 1, '深挖一轮写进了检索思路');
    check(deep.added && deep.badge, '深挖命中并进列表，并标出来自深挖');
    check(deep.dup === 1, '深挖时重复结果被去掉', '同一条出现 ' + deep.dup + ' 次');
    check(!deep.once, '深挖结束后按钮仍可用（可以继续追问线索）');
  }

  /* ---- 6.6 仓库检索要一次取够：搜「开源射击模板」不能只回 6 条就下结论 ---- */
  await page.evaluate(() => {
    const home = document.querySelector('#aisearchWin .ais-brand');
    if (home) home.click();
  });
  await page.waitForTimeout(250);
  await page.fill('#aisearchWin .ais-hero-input', '开源的射击游戏模板');
  await page.press('#aisearchWin .ais-hero-input', 'Enter');
  await page.waitForFunction(() => {
    const s = document.querySelector('#aisearchWin .ais-status');
    return s && /完成|未找到|失败/.test(s.textContent || '');
  }, null, { timeout: 20000 });
  const repoHits = await page.evaluate(() => [...document.querySelectorAll('#aisearchWin .ais-hit')]
    .map((el) => el.querySelector('.ais-hit-url').textContent));
  check(repoHits.filter((u) => /github\.com/.test(u)).length >= 8,
    '仓库检索一次取够（不再只给 6 条）', repoHits.length + ' 条结果');

  /* ---- 7. 回首页 ---- */
  await page.evaluate(() => document.querySelector('#aisearchWin .ais-brand').click());
  await page.waitForTimeout(250);
  check(await visible(page, '#aisearchWin .ais-hero'), '品牌按钮能回到首页');

  /* ---- 8. 影视模式：只留官方平台，标出免费 / 试看，并给出官方直达 ---- */
  await page.click('#aisearchWin .ais-mode[data-mode="media"]');
  await page.waitForTimeout(250);
  check(await page.evaluate(() => (document.querySelector('#aisearchWin .ais-hero-h').textContent || '').trim() === '影视资源'),
    '切到影视模式后首页文案已更换');
  check(await page.evaluate(() => [...document.querySelectorAll('#aisearchWin .ais-chip')].some(c => /流浪地球/.test(c.textContent))),
    '影视模式示例换成了片名');

  await page.fill('#aisearchWin .ais-hero-input', '流浪地球 2');
  await page.press('#aisearchWin .ais-hero-input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('#aisearchWin .ais-hit.is-media').length >= 3, null, { timeout: 9000 });

  const media = await page.evaluate(() => ({
    hits: [...document.querySelectorAll('#aisearchWin .ais-hit.is-media')].map(el => ({
      title: el.querySelector('.ais-hit-title').textContent,
      url: el.querySelector('.ais-hit-url').textContent,
      site: el.querySelector('.ais-plat-badge').textContent,
      avail: el.querySelector('.ais-avail').textContent
    })),
    plats: document.querySelectorAll('#aisearchWin .ais-plat').length,
    watch: document.querySelectorAll('#aisearchWin .ais-watch').length,
    extra: {
      shown: (() => { const el = document.querySelector('#aisearchWin .ais-extra'); return !!el && !el.classList.contains('hidden'); })(),
      files: [...document.querySelectorAll('#aisearchWin .ais-extra .ais-dl')].map(a => ({
        title: a.closest('.ais-extra-item').querySelector('.ais-extra-title').textContent,
        href: a.href,
        download: a.hasAttribute('download'),
        text: a.textContent
      })),
      opens: [...document.querySelectorAll('#aisearchWin .ais-extra .ais-open')].map(b => ({
        title: b.closest('.ais-extra-item').querySelector('.ais-extra-title').textContent,
        url: b.getAttribute('data-open')
      })),
      links: [...document.querySelectorAll('#aisearchWin .ais-extra a')].map(a => a.getAttribute('href'))
    },
    bannedLinks: [...document.querySelectorAll('#aisearchWin a')]
      .map(a => a.getAttribute('href') || '')
      .filter(h => /123movie|douban/.test(h)),
    filtered: (document.querySelector('#aisearchWin .ais-filtered').textContent || '').trim(),
    llm: window.__llmLast || {}
  }));
  check(media.hits.length === 3, '影视结果只留 3 条官方来源', media.hits.map(h => h.site).join(' / '));
  check(media.hits.every(h => !/120$|腾讯视频$|爱奇艺$/.test(h.title)),
    '标题里的平台后缀已清理', media.hits.map(h => h.title).join(' / '));
  check(!media.hits.some(h => /123movie|douban/.test(h.url)), '盗版站与聚合站被白名单挡掉');
  check(media.extra.shown && media.extra.files.length === 1 && media.extra.files[0].href.endsWith('.mp4'),
    '非官方视频直链单独成栏', media.extra.files.map(i => i.href).join(' / '));
  check(media.extra.files.every(i => i.download && /下载视频/.test(i.text)), '直链只给下载入口');
  check(media.bannedLinks.length === 0, '非官方网页不给裸链接', media.bannedLinks.join(' / '));
  check(media.extra.links.every(h => /\.(mp4|m4v|mkv|webm|mov|avi|flv|ts|m3u8)$/i.test(h)),
    '非官方栏里没有网页地址');
  check(media.extra.opens.length === 2 && media.extra.opens.every(o => /^https?:\/\//.test(o.url)),
    '非官方网页只能安全打开', media.extra.opens.map(o => o.url).join(' / '));
  check(media.plats >= 10, '官方平台直达入口已铺开', media.plats + ' 个');
  check(media.watch === 3, '每条结果都有官方观看入口');
  check(media.hits.some(h => h.avail === '免费') && media.hits.some(h => /试看|需会员/.test(h.avail)),
    '免费与受限片源被分开标注', media.hits.map(h => h.avail).join(' / '));
  check(/非官方 3 条已单列/.test(media.filtered), '过滤条给出官方与非官方的分栏数量', media.filtered);

  /* 安全打开：不产生裸跳转，而是把地址交给内置浏览器（Electron 侧有 guest 护栏） */
  await page.evaluate(() => {
    window.__openedApp = '';
    window.openDeskApp = function (id) { window.__openedApp = id; };
    document.querySelector('#aisearchWin .ais-open').click();
  });
  await page.waitForTimeout(150);
  const guard = await page.evaluate(() => ({
    app: window.__openedApp || '',
    url: window.__bwPendingUrl || ''
  }));
  check(guard.app === 'browser' && /^https?:\/\//.test(guard.url) && /123movie/.test(guard.url),
    '非官方网页被转交内置浏览器', guard.app + ' ' + guard.url);

  await page.waitForFunction(() => {
    const b = document.querySelector('#aisearchWin .ais-answer-body');
    return b && b.textContent.includes('流浪地球');
  }, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const mediaAnswer = await page.evaluate(() => ({
    text: document.querySelector('#aisearchWin .ais-answer-body').textContent,
    cites: document.querySelectorAll('#aisearchWin .ais-cite').length
  }));
  check(mediaAnswer.text.includes('免费观看') && mediaAnswer.cites >= 2,
    '影视摘要给出可看结论并带引用', mediaAnswer.cites + ' 个引用');
  check(/影视来源助手/.test(media.llm.sys || '') && /平台：腾讯视频/.test(media.llm.user || ''),
    '影视模式使用了专用提示词与平台标注');
  check(/不推荐任何非官方站点/.test(media.llm.sys || '') && /不提供下载、磁力、网盘链接/.test(media.llm.sys || ''),
    '影视提示词明确禁止非官方站点与下载链接');

  check(errors.length === 0, '全程无 pageerror', errors.join(' | ').slice(0, 200));

  console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 全部通过');
  run.finish(failed);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
