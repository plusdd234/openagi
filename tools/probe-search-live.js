/* 探针（要真网络）：联网搜索到底通不通
 * 用法：node tools/probe-search-live.js
 *
 * 为什么需要它：这条链路上游在公网，离线测试只能证明「解析器能读懂 fixture」，
 * 证明不了「点开联网真能搜到」。实测过的坑：8787 中转一切正常、转发 example.com 200ms，
 * 但默认源 DuckDuckGo 在国内 20 秒拿不到连接 —— 界面上只写「联网搜索失败」，
 * 于是被当成「中转没启动」查了半天，真正的问题是没有一个国内可达的源。
 *
 * 判定口径：
 *   · 8787 必须在跑（搜索全走它转发，直连必被 CORS 拒）
 *   · 默认源（bing）必须真取回结果 —— 它挂了就等于「开箱联网不可用」，直接失败
 *   · 其它源只报告不判死：能不能连通取决于用户所在网络，不该让测试红
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const QUERY = '今天北京天气';

(async () => {
  /* ① 中转 */
  let relay = null;
  try{
    const r = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(3000) });
    relay = await r.json();
  }catch(e){ relay = null; }
  console.log('\n=== 1. 本地中转 ===');
  check(!!(relay && relay.ok), '8787 /health 正常', relay ? JSON.stringify(relay.stats || {}) : '连不上');
  if(!(relay && relay.ok)){
    console.log('\n❌ 中转没起来，联网搜索一定是失败的（先 `node server/relay.js` 或点「启动中转」）');
    process.exit(1);
  }

  /* ② 各来源真打一次 */
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const list = await page.evaluate(() => window.deskSearch.providers.map(p => p.id));
  console.log('\n=== 2. 各来源实连（查询：' + QUERY + '） ===');
  const out = {};
  for(const prov of list){
    const need = await page.evaluate(id => {
      const p = window.deskSearch.providers.find(x => x.id === id) || {};
      return p.need || 'none';
    }, prov);
    if(need !== 'none'){
      console.log('  ' + prov.padEnd(8) + ' 跳过（要先填' + (need === 'base' ? '实例地址' : ' Key') + '）');
      continue;
    }
    const r = await page.evaluate(async (args) => {
      window.deskSearch._resetBreaker();
      const o = await window.deskSearch.run(args.q, {
        cfg: { provider: args.p, base: '', key: '', count: 3 },
        force: true, fallback: false
      });
      return {
        ok: o.ok, err: o.error, ms: o.ms,
        n: (o.results || []).length,
        first: (o.results || [])[0] ? { t: o.results[0].title, u: o.results[0].url } : null
      };
    }, { q: QUERY, p: prov });
    out[prov] = r;
    console.log('  ' + prov.padEnd(8) + (r.ok ? '✅ ' + r.ms + 'ms · ' + r.n + ' 条 · ' + (r.first ? r.first.t.slice(0, 28) : '') : '✗ ' + r.err));
  }

  console.log('\n=== 3. 判定 ===');
  const bing = out.bing || { ok: false, err: '未测' };
  check(bing.ok, '默认源 bing 真能取回结果', bing.ok ? (bing.ms + 'ms · ' + bing.n + ' 条') : bing.err);
  check(!!(bing.first && bing.first.u), '第一条带真实地址', bing.first ? bing.first.u : '无');
  if(out.ddg && !out.ddg.ok){
    console.log('  ℹ ddg 不通（' + out.ddg.err + '）—— 这就是要把它从默认位上撤下来的原因；' +
      '用户选了 ddg 时已自动用 bing 兜底并说明。');
  }
  check(errors.length === 0, '页面零报错', errors.length ? errors.slice(0, 2).join(' | ') : 'clean');

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
