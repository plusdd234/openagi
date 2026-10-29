/* 对话联网搜索：把「刚搜到的网页摘要」塞进这一轮的系统提示
 *
 * 这里只做「取回 + 解析 + 组织成上下文」，不碰任何聊天 DOM，方便单测：
 *   ① cfg            —— 读配置（来源 / 地址 / Key / 条数）
 *   ② run            —— 按来源取回结果，**失败也不抛**，让对话继续往下走
 *   ③ parse*         —— 各家返回的解析（DDG 的 HTML / SearXNG 的 JSON / Tavily 的 JSON）
 *   ④ contextBlock   —— 拼成给人看的检索块（带编号，模型引用时标 [n]）
 *
 * 为什么必须「失败不阻塞」：联网只是给答案加一层事实，搜不到还照常聊才是对的；
 * 一次 403 / 超时就挂掉整条回复，用户会觉得「开了联网就连话都不能说了」。
 *
 * 为什么默认 DDG 而不是某家搜索 API：它免 Key、能立刻用。缺点也写清楚——
 * 页面可能是反爬页、也可能被墙，所以设置里备了 SearXNG（自建实例）与 Tavily（要 Key）两条更稳的路。
 */
(function(){
  const root = (typeof window !== 'undefined') ? window : globalThis;

  /* ---------------- 配置 ---------------- */
  function readLS(k){
    try{ return localStorage.getItem('hf_' + k) || ''; }catch(e){ return ''; }
  }
  function cfg(){
    const n = Number(readLS('wsCount')) || 4;
    return {
      /* 默认 bing：免 Key 且国内可达。ddg 只在能直连外网的环境下有用，
       * 拿它当默认 = 第一次联网就 20 秒超时失败。 */
      provider: readLS('wsProvider') || 'bing',
      base: readLS('wsBase').trim(),
      key: readLS('wsKey').trim(),
      count: Math.max(1, Math.min(8, Math.round(n)))
    };
  }

  /* ---------------- 取回（直连失败就借本地中转绕 CORS） ---------------- */
  function relayProxy(){
    try{
      if(typeof relayBase === 'function') return relayBase() + '/proxy';
    }catch(e){}
    return 'http://127.0.0.1:8787/proxy';
  }

  async function once(url, init, ms){
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 15000);
    try{
      const r = await fetch(url, Object.assign({}, init || {}, { signal: ctl.signal }));
      if(!r.ok){
        const err = new Error('HTTP ' + r.status);
        err.http = r.status;
        throw err;
      }
      return await r.text();
    }catch(e){
      if(e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round((ms || 15000) / 1000) + ' 秒）');
      throw e;
    }finally{
      clearTimeout(timer);
    }
  }

  /* 直连 → 中转。
   * ⚠ 页面跑在 file:// / app://（Electron 是 app://openagi）下，直连第三方网页
   *   **一定**是 CORS 拒（origin: null）。以前每次搜索都先白试一次直连，除了多等一个来回，
   *   还会在失败信息里多出一条「直连 Failed to fetch」，看着像两个毛病叠在一起。
   *   这两种 origin 下直接走中继；真跑在 http(s) 上（调试用）才先试直连。 */
  function needRelay(){
    try{ return /^(file|app|chrome-extension|moz-extension|edge):$/.test(location.protocol); }
    /* 没有 location（node 里跑单测）＝普通 http 环境，直连是能过的，先试直连 */
    catch(e){ return false; }
  }

  function isTimeout(e){ return !!(e && /超时/.test(String(e.message || ''))); }

  /* 「中转没起来」和「中转起来了但上游不通」是两回事，以前一律加一句
   * 「中转要先在设置里启用并启动服务」——中转明明活着的时候这就是假话，
   * 用户会跑去反复点「启动中转」（实测踩过：8787 /health 正常、转发 example.com 200ms，
   * 真正连不上的是上游 DuckDuckGo，20 秒拿不到连接）。 */
  function relayErrMsg(e, ms){
    if(e && e.http) return '搜索源返回 HTTP ' + e.http;
    if(isTimeout(e)){
      return '本地中转正常，但搜索源 ' + Math.round(ms / 1000) + ' 秒内没响应（该站点在当前网络可能连不上）';
    }
    return '本地中转连不上（' + relayProxy() + '）：' + ((e && e.message) || '未知原因')
      + '，到 设置 → 本地中转 里启动它';
  }

  async function fetchAny(url, init, ms){
    const t = ms || 12000;
    if(needRelay()){
      const headers = Object.assign({}, (init && init.headers) || {}, { 'X-Relay-Target': url });
      try{
        return await once(relayProxy(), Object.assign({}, init || {}, { headers }), t);
      }catch(e){
        throw new Error(relayErrMsg(e, t));
      }
    }
    try{
      return await once(url, init, t);
    }catch(e1){
      /* 真·HTTP 错误（403/429）不再重试：中转也救不了被站点拦掉的请求，重试只是多打一次。 */
      if(e1 && e1.http) throw e1;
      const headers = Object.assign({}, (init && init.headers) || {}, { 'X-Relay-Target': url });
      try{
        return await once(relayProxy(), Object.assign({}, init || {}, { headers }), t);
      }catch(e2){
        throw new Error(relayErrMsg(e2, t) + '（直连也失败：' + ((e1 && e1.message) || '未知') + '）');
      }
    }
  }

  /* ---------------- 文本工具 ---------------- */
  function decodeEntities(s){
    return String(s || '')
      .replace(/&#(\d+);/g, (_, d) => { try{ return String.fromCharCode(Number(d)); }catch(e){ return ''; } })
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try{ return String.fromCharCode(parseInt(h, 16)); }catch(e){ return ''; } })
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }
  function plain(s){
    return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  function clip(s, n){
    const t = String(s || '').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function host(url){
    try{ return new URL(url).hostname.replace(/^www\./i, ''); }catch(e){ return ''; }
  }
  function dedupe(list){
    const seen = new Set();
    const out = [];
    (list || []).forEach(r => {
      const url = String((r && r.url) || '').trim();
      if(!/^https?:\/\//i.test(url)) return;
      const k = url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
      if(seen.has(k)) return;
      seen.add(k);
      out.push({
        title: clip(plain(r.title) || host(url), 120),
        url,
        snippet: clip(plain(r.snippet), 400),
        host: host(url)
      });
    });
    return out;
  }

  /* ---------------- 解析 ---------------- */
  /* 结果链是 //duckduckgo.com/l/?uddg=<编码后的真实地址>&rut=…，必须解开，
     否则模型引用到的是一串跳转链接，用户点开还要再跳一次。 */
  function decodeDdg(href){
    let h = String(href || '').trim();
    if(!h) return '';
    if(h.indexOf('//') === 0) h = 'https:' + h;
    if(/^https?:\/\/(www\.)?duckduckgo\.com\/l\//i.test(h)){
      const q = h.split('?')[1] || '';
      const m = /(?:^|&)uddg=([^&]+)/.exec(q);
      if(m){ try{ return decodeURIComponent(m[1]); }catch(e){ return ''; } }
      return '';
    }
    return /^https?:\/\//i.test(h) ? h : '';
  }

  /* Bing：`<li class="b_algo">` 里 `<h2><a href="真实地址">标题</a></h2>` + 首个 `<p>` 作摘要。
   * 链接是真实地址（不像百度那样藏一层 link 跳转，省一次跟随），免 Key。
   * 这是**国内可用**的那个免 Key 源——DDG 网页版与公开 SearXNG 实例在墙内基本连不上，
   * 默认给一个连不上的源 = 开箱即失败（实测 20 秒拿不到连接，用户只看到「联网失败」）。 */
  function parseBing(html){
    const blocks = String(html || '').split('<li class="b_algo"').slice(1);
    const out = [];
    for(const b of blocks){
      const h = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(b);
      if(!h) continue;
      const a = /<a[^>]+href="([^"]+)"/i.exec(h[1]);
      if(!a) continue;
      const url = decodeEntities(a[1]);
      if(!/^https?:\/\//i.test(url)) continue;
      const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
      out.push({
        title: plain(h[1].replace(/<a\b[^>]*>/gi, '')),
        url,
        snippet: p ? plain(p[1]) : ''
      });
    }
    return dedupe(out);
  }

  function parseDDG(html){
    const src = String(html || '');
    const out = [];
    const re = /<a\b([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while((m = re.exec(src))){
      const tag = m[1];
      const title = plain(m[2]);
      const hm = /href="([^"]+)"/i.exec(tag);
      const url = decodeDdg(hm ? hm[1] : '');
      if(!url || !title) continue;
      const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 2400);
      const sm = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest);
      out.push({ title, url, snippet: sm ? plain(sm[1]) : '' });
    }
    return dedupe(out);
  }

  function parseSearx(json){
    const list = (json && (json.results || (json.web && json.web.results))) || [];
    return dedupe(list.map(r => ({
      title: r.title || r.name,
      url: r.url || r.link,
      snippet: r.content || r.snippet || r.description || ''
    })));
  }

  function parseTavily(json){
    const list = (json && json.results) || [];
    return dedupe(list.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content || r.raw_content || r.snippet || ''
    })));
  }

  /* ---------------- 来源 ---------------- */
  const PROVIDERS = {
    bing: {
      label: 'Bing（免 Key · 国内可达）',
      need: 'none',
      async run(q, c, f){
        const u = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&ensearch=0';
        const html = await f(u, {
          headers: {
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9'
          }
        }, 12000);
        return parseBing(html).slice(0, c.count);
      }
    },
    ddg: {
      label: 'DuckDuckGo（免 Key）',
      need: 'none',
      async run(q, c, f){
        const u = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=cn-zh';
        const html = await f(u, { headers: { 'Accept': 'text/html,application/xhtml+xml' } }, 12000);
        return parseDDG(html).slice(0, c.count);
      }
    },
    searxng: {
      label: 'SearXNG 实例（自建 / 私有）',
      need: 'base',
      async run(q, c, f){
        const base = String(c.base || '').replace(/\/$/, '');
        if(!base) throw new Error('没填 SearXNG 地址（形如 https://searx.example.com）');
        const u = base + '/search?q=' + encodeURIComponent(q) + '&format=json&language=zh-CN&safesearch=0';
        const txt = await f(u, { headers: { 'Accept': 'application/json' } }, 10000);
        let json;
        try{ json = JSON.parse(txt); }catch(e){ throw new Error('SearXNG 没返回 JSON（实例可能没开 format=json）'); }
        return parseSearx(json).slice(0, c.count);
      }
    },
    tavily: {
      label: 'Tavily（需 Key）',
      need: 'key',
      async run(q, c, f){
        if(!c.key) throw new Error('没填 Tavily API Key');
        const body = JSON.stringify({
          api_key: c.key, query: q, max_results: c.count,
          search_depth: 'basic', include_answer: false
        });
        const txt = await f('https://api.tavily.com/search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body
        }, 20000);
        let json;
        try{ json = JSON.parse(txt); }catch(e){ throw new Error('Tavily 返回的不是 JSON（Key 无效时常见）'); }
        return parseTavily(json).slice(0, c.count);
      }
    }
  };

  /* ---------------- 对外：跑一次搜索 ---------------- */
  /* 绝不抛：任何失败都折成 { ok:false, error }，由调用方决定怎么降级。
     opts.fetch 可注入（单测用），opts.cfg 可覆盖配置（设置页「测试搜索」用）。 */
  /* ---------------- 失败熔断 ----------------
   * 上游不可达时，**每一句话**都会白等一次超时（实测：DDG 在本机 20 秒拿不到连接，
   * 用户发一条消息卡一条，还以为是模型慢）。所以记住「这个来源 + 这个地址」最近一次失败，
   * 5 分钟内直接回上次的原因、不再发请求。
   * key 里带 base，**改地址/换来源会换 key，立刻恢复重试**——别让熔断把用户锁死。 */
  const BREAK_MS = 5 * 60 * 1000;
  let breaker = { key: '', until: 0, error: '' };

  function keyOf(c){ return c.provider + '|' + (c.base || '') + '|' + (c.key ? 'k' + c.key.length : ''); }

  /* 只给**慢**失败熔断：超时（12 秒那种）和中转连不上。
   * 「没填地址 / 没填 Key / HTTP 403」都是毫秒级返回，不值得缓存，
   * 缓存了反而坏事——用户刚补上配置，却被上一条的旧结论拦住说「5 分钟内不再重试」。 */
  function worthBreaking(msg){
    return /超时/.test(msg) || /连不上/.test(msg) || /没响应/.test(msg);
  }

  async function run(query, opts){
    const o = opts || {};
    const q = String(query || '').replace(/\s+/g, ' ').trim();
    const c = Object.assign({}, cfg(), o.cfg || {});
    const t0 = Date.now();
    if(!q) return { ok: false, provider: c.provider, query: '', results: [], error: '问题为空', ms: 0 };
    const key = keyOf(c);
    const tripped = (!o.force && breaker.key === key && Date.now() < breaker.until) ? breaker : null;
    const f = o.fetch || fetchAny;

    /* 免 Key 的两个源（ddg / bing）可以互相兜底：ddg 在墙内基本连不上，
     * 但用户选它往往只是图「免 Key」。所以 ddg 失败**自动试 bing**，
     * 并把「换了源」写进返回值，让界面说出来——不静默替换，
     * 否则用户会以为 DDG 通了，下次换台机器又莫名其妙失败。
     * searxng / tavily 是用户明确配过的（地址 / Key），失败就是失败，不替他换。 */
    const canFallback = (c.provider === 'ddg' && o.fallback !== false);

    async function tryBing(why){
      try{
        const results = await PROVIDERS.bing.run(q.slice(0, 200), Object.assign({}, c, { provider: 'bing' }), f);
        return { ok: true, provider: 'bing', fellBackFrom: c.provider, fellBackWhy: why,
                 query: q, results: results || [], ms: Date.now() - t0 };
      }catch(e){ return null; }
    }

    if(tripped){
      /* 熔断期间：ddg 直接走 bing，不再去撞那个 12 秒超时。
       * **不要在这里续期**——续期会让「最后一次失败 + 5 分钟」变成
       * 「最后一次发消息 + 5 分钟」，一直聊天就永远不会重试原来源。 */
      if(canFallback){
        const fb = await tryBing(tripped.error);
        if(fb) return fb;
      }
      const left = Math.max(1, Math.ceil((tripped.until - Date.now()) / 60000));
      return {
        ok: false, provider: c.provider, query: q, results: [], ms: 0, cached: true,
        error: tripped.error + '（' + left + ' 分钟内不再重试；换来源或改地址会立刻重试）'
      };
    }

    const p = PROVIDERS[c.provider] || PROVIDERS.bing;
    try{
      const results = await p.run(q.slice(0, 200), c, f);
      breaker = { key: '', until: 0, error: '' };        // 通了就清掉
      return { ok: true, provider: c.provider, query: q, results: results || [], ms: Date.now() - t0 };
    }catch(e){
      const error = (e && e.message) || String(e);
      const slow = worthBreaking(error);
      /* ddg 失败不立刻记熔断：先用 bing 兜底，兜底成功就把熔断挂在 ddg 头上，
       * 这样 5 分钟内后续消息直接走 bing（不再每条都白等 12 秒）。 */
      if(canFallback){
        const fb = await tryBing(error);
        if(fb){
          if(slow) breaker = { key: key, until: Date.now() + BREAK_MS, error: error };
          return fb;
        }
      }
      if(slow) breaker = { key: key, until: Date.now() + BREAK_MS, error: error };
      return {
        ok: false, provider: c.provider, query: q, results: [],
        error: error, ms: Date.now() - t0
      };
    }
  }

  /* ---------------- 对外：拼成系统提示里的一段 ----------------
   * 只给「素材 + 用法」，不替模型写答案。编号是给引用用的；
   * 明说「无关就忽略、没搜到就说没搜到」，否则小模型会把不相关的结果硬编成事实。 */
  function contextBlock(results, opts){
    const list = (results || []).slice(0, (opts && opts.max) || 5);
    if(!list.length) return '';
    const date = new Date().toISOString().slice(0, 10);
    let s = '\n【联网搜索结果】' + date + ' 实时检索，共 ' + list.length + ' 条。'
      + '使用时：只把与问题相关的条目当作事实依据，引用时在句末标注 [序号]；'
      + '与问题无关就忽略它们，直接说「没搜到可靠信息」，不要用旧知识硬凑。\n';
    let budget = 2600;
    for(let i = 0; i < list.length; i++){
      const r = list[i];
      const body = clip(r.snippet || '（无摘要）', 300);
      const seg = '[' + (i + 1) + '] ' + clip(r.title, 90) + '\n' + r.url + '\n' + body + '\n';
      if(seg.length > budget) break;
      budget -= seg.length;
      s += seg;
    }
    return s;
  }

  const api = {
    run: run,
    cfg: cfg,
    contextBlock: contextBlock,
    providers: Object.keys(PROVIDERS).map(k => ({ id: k, label: PROVIDERS[k].label, need: PROVIDERS[k].need })),
    labelOf: id => (PROVIDERS[id] || PROVIDERS.bing).label,
    /* 熔断状态只给测试看，业务代码不需要关心 */
    _breaker: () => ({ key: breaker.key, until: breaker.until, error: breaker.error }),
    _resetBreaker: () => { breaker = { key: '', until: 0, error: '' }; },
    /* 失败文案的分因逻辑单独暴露：文案对不对，用户比谁都先感觉到 */
    _errText: relayErrMsg,
    /* 单测用的解析器与取回实现 */
    _parse: { bing: parseBing, ddg: parseDDG, searx: parseSearx, tavily: parseTavily, decodeDdg: decodeDdg, plain: plain },
    _fetchAny: fetchAny
  };
  root.deskSearch = api;
})();
