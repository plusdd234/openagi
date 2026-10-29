/* 单测：对话联网搜索的「解析 + 组装 + 降级」
 *
 * 覆盖：
 *   ① DDG 结果页解析（跳转链 uddg 解码、标题去标签/解实体、摘要、去重）
 *   ② SearXNG / Tavily 的 JSON 解析（字段名不同，要归一成同一形状）
 *   ③ contextBlock：编号、日期、用法约束、条数上限、超长摘要裁掉
 *   ④ run()：成功 / 失败都不抛；缺配置给可读错误；条数夹在 1..8
 *   ⑤ fetchAny：真·HTTP 错误不重试中转（403 换中转也没用），网络错误才回落
 *
 * 用法：node tools/desk-search.js
 */
const path = require('path');
require(path.join(__dirname, '..', 'js', 'desk-search.js'));
const S = globalThis.deskSearch;

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 一份贴近真实 DDG 结果页的片段：跳转链、实体、带标签的摘要、重复链接 */
const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenagi.dev%2Fdocs&amp;rut=abc">OpenAGI 文档 &amp; 快速开始</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenagi.dev%2Fdocs">开源 AI 工作流工作台，支持<b>可视化节点</b>与多引擎生图。</a>
</div>
<div class="result results_links">
  <h2 class="result__title"><a class="result__a" href="https://github.com/plusdd234/openagi">GitHub - plusdd234/openagi</a></h2>
  <a class="result__snippet">MIT licensed. 节点编排 / ComfyUI / 3D.</a>
</div>
<div class="result results_links">
  <h2 class="result__title"><a class="result__a" href="https://openagi.dev/docs/">重复的文档入口</a></h2>
  <a class="result__snippet">同一个页面的另一个链接。</a>
</div>
`;

(async () => {
  console.log('\n=== 1. DDG 结果页解析 ===');
  const ddg = S._parse.ddg(DDG_HTML);
  check(ddg.length === 2, '去重后剩 2 条（/docs 与 /docs/ 算同一个）', 'got ' + ddg.length);
  check(ddg[0] && ddg[0].url === 'https://openagi.dev/docs', 'uddg 跳转链解码成真实地址', ddg[0] && ddg[0].url);
  check(ddg[0] && ddg[0].title === 'OpenAGI 文档 & 快速开始', '标题去标签 + 解实体（&amp; → &）', ddg[0] && ddg[0].title);
  check(ddg[0] && /可视化节点/.test(ddg[0].snippet), '摘要去掉 <b> 标签后保留文字', ddg[0] && ddg[0].snippet);
  check(ddg[1] && ddg[1].url === 'https://github.com/plusdd234/openagi', '直链原样保留', ddg[1] && ddg[1].url);
  check(ddg.every(r => r.host && !/^www\./.test(r.host)), '每条都带 host（给卡片做兜底标题）');

  const empty = S._parse.ddg('<html><body>no results</body></html>');
  check(Array.isArray(empty) && empty.length === 0, '解析不到结果时返回空数组，不抛');

  console.log('\n=== 2. SearXNG / Tavily 归一 ===');
  const searx = S._parse.searx({ results: [
    { title: 'A', url: 'https://a.example.com/x', content: '摘要 A' },
    { title: 'B', url: 'https://a.example.com/x', content: '重复' },
    { title: 'C', url: 'not-a-url', content: '坏链接' }
  ] });
  check(searx.length === 1, 'SearXNG：去重 + 丢掉非 http 链接', 'got ' + searx.length);
  check(searx[0].snippet === '摘要 A', 'SearXNG：content → snippet');

  const tav = S._parse.tavily({ results: [{ title: 'T', url: 'https://t.example.com/p', content: '来自 Tavily 的正文' }] });
  check(tav.length === 1 && tav[0].snippet === '来自 Tavily 的正文', 'Tavily：content → snippet');

  console.log('\n=== 3. contextBlock（拼给模型的那一段） ===');
  const block = S.contextBlock(ddg);
  check(/【联网搜索结果】/.test(block), '有明确的分区标题（模型才知道这是新取的资料）');
  check(/\[\d\]/.test(block) && /\[1\]/.test(block), '每条带编号，供模型标 [1]');
  check(/\d{4}-\d{2}-\d{2}/.test(block), '带检索日期（时效问题要靠它判断新旧）');
  check(/无关就忽略/.test(block) && /没搜到可靠信息/.test(block), '写明「无关忽略 / 没搜到就说没搜到」');
  check(block.indexOf('https://openagi.dev/docs') > 0, '带原始链接（可回溯）');
  const long = [{ title: 'x', url: 'https://x.example.com', snippet: '长'.repeat(2000) }];
  check(S.contextBlock(long).length < 900, '超长摘要会被裁到 300 字', 'len=' + S.contextBlock(long).length);
  check(S.contextBlock([]) === '', '空结果返回空串（不往系统提示里塞一个空标题）');

  console.log('\n=== 4. run()：成功 / 失败 / 缺配置 ===');
  const okRun = await S.run('OpenAGI 是什么', {
    cfg: { provider: 'ddg', base: '', key: '', count: 5 },
    fetch: async () => DDG_HTML
  });
  check(okRun.ok && okRun.results.length === 2, 'ddg 成功路径', JSON.stringify({ ok: okRun.ok, n: okRun.results.length }));
  check(typeof okRun.ms === 'number', '带耗时（设置页要显示）');

  const badRun = await S.run('随便', {
    cfg: { provider: 'ddg' },
    fetch: async () => { throw new Error('HTTP 403'); }
  });
  check(badRun.ok === false && /403/.test(badRun.error), '取回失败折成 ok:false，不抛', badRun.error);
  check(Array.isArray(badRun.results) && badRun.results.length === 0, '失败时 results 是空数组（调用方不用判空）');

  const noBase = await S.run('q', { cfg: { provider: 'searxng', base: '', key: '', count: 3 } });
  check(noBase.ok === false && /SearXNG 地址/.test(noBase.error), 'SearXNG 没填地址 → 可读错误', noBase.error);

  const noKey = await S.run('q', { cfg: { provider: 'tavily', base: '', key: '', count: 3 } });
  check(noKey.ok === false && /Tavily/.test(noKey.error), 'Tavily 没填 Key → 可读错误', noKey.error);

  let sentBody = null;
  const tavRun = await S.run('q', {
    cfg: { provider: 'tavily', key: 'tvly-x', base: '', count: 3 },
    fetch: async (url, init) => {
      sentBody = { url, init };
      return JSON.stringify({ results: [{ title: 'T', url: 'https://t.example.com', content: 'c' }] });
    }
  });
  check(tavRun.ok && /api\.tavily\.com\/search/.test(sentBody.url), 'Tavily 打到官方 search 端点', sentBody.url);
  const parsed = JSON.parse(sentBody.init.body);
  check(parsed.api_key === 'tvly-x' && parsed.query === 'q' && parsed.max_results === 3, 'Tavily 请求体字段正确');

  const clamp = await S.run('q', {
    cfg: { provider: 'ddg', count: 99 },
    fetch: async () => DDG_HTML
  });
  check(clamp.ok, 'count 超界不影响调用');
  const c = S.cfg();
  check(c.count >= 1 && c.count <= 8, 'cfg() 把条数夹在 1..8', String(c.count));

  console.log('\n=== 5. fetchAny：HTTP 错误不换中转重试 ===');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (/html\.duckduckgo\.com/.test(String(url))) {
      const e = new Error('HTTP 403');
      e.http = 403;
      throw e;
    }
    return { ok: true, text: async () => 'relay-body' };
  };
  let err = null;
  try{
    await S._fetchAny('https://html.duckduckgo.com/html/?q=x', {}, 3000);
  }catch(e){ err = e; }
  check(!!err && /403/.test(err.message), '403 直接抛出，不去打 8787', err && err.message);
  check(calls.length === 1, '只打了一次（没有多余的中转重试）', 'calls=' + calls.length);

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (/html\.duckduckgo\.com/.test(String(url))) throw new TypeError('Failed to fetch');
    return { ok: true, text: async () => 'relay-body' };
  };
  let got = '';
  try{ got = await S._fetchAny('https://html.duckduckgo.com/html/?q=x', {}, 3000); }catch(e){ got = 'ERR:' + e.message; }
  check(got === 'relay-body', 'CORS / 网络失败 → 回落本地中转并拿到内容', got);
  check(calls.some(u => /:8787\/proxy$/.test(u)), '回落的是 relay 的 /proxy', calls.join(' , '));

  globalThis.fetch = realFetch;

  console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有 ' + fails + ' 项未通过'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
