/* 检索评测台：10 类真实问题，跑完整链路（搜索 → 过滤 → 扩展 → 精读 → 线索），
 * 输出每题的结果数、期望关键词命中、检索思路与过滤说明。
 *
 * 这是「真实联网」测试，默认不跑；显式开启：
 *   AISEARCH_LIVE=1 node tools/bench-aisearch.js
 * 前提：本地中转（默认 8787）在运行；LLM 用桩，不消耗模型额度。
 *
 * 设计原则：
 *   · 10 题覆盖不同意图：找工具 / 开源资源 / 排错 / 事实 / 对比 / 本地信息 / 消费决策 / 影视；
 *   · 每题给「期望出现的词」，只判断结果里有没有，不判断排名（排名由人看）；
 *   · 题间停 5 秒：搜索源会限流，连发不是真实用法，会把备源也一起打挂。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const CASES = [
  { id: 'T1', q: 'AI 生成 3D 模型 网站', expect: ['meshy', 'tripo', '3d'], mode: 'web' },
  { id: 'T2', q: '开源 2D 射击游戏 模板', expect: ['game', 'template', 'shooter'], mode: 'web' },
  { id: 'T3', q: 'Node 报错 ERR_OSSL_EVP_UNSUPPORTED 怎么解决', expect: ['node', 'openssl', 'err'], mode: 'web' },
  { id: 'T4', q: '2024 年诺贝尔文学奖 得主是谁', expect: ['诺贝尔', '文学奖', '韩江'], mode: 'web' },
  { id: 'T5', q: 'Notion 和 飞书文档 哪个适合团队知识库', expect: ['notion', '飞书', '知识库'], mode: 'web' },
  { id: 'T6', q: '合肥 蜀山区 租房 一室 价格', expect: ['合肥', '租房', '蜀山'], mode: 'web' },
  { id: 'T7', q: '500 元以内 机械键盘 推荐', expect: ['机械键盘', '键盘', '推荐'], mode: 'web' },
  { id: 'T8', q: '繁花 电视剧 在线观看', expect: ['繁花'], mode: 'media' },
  { id: 'T9', q: '合肥 公积金 租房提取 条件 材料', expect: ['公积金', '提取', '合肥'], mode: 'web' },
  { id: 'T10', q: 'Transformer 位置编码 原理', expect: ['transformer', '位置编码', 'attention'], mode: 'web' }
];

(async () => {
  if (process.env.AISEARCH_LIVE !== '1') {
    console.log('这是真实联网评测，默认不跑。加 AISEARCH_LIVE=1 开启：');
    console.log('  PowerShell: $env:AISEARCH_LIVE=1; node tools/bench-aisearch.js');
    process.exit(0);
  }
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    /* LLM 用桩：只验证检索链路，不花额度。 */
    window.llmConn = function () { return { base: 'http://stub/v1', key: 'stub', model: 'stub' }; };
    window.LLMRouter = window.LLMRouter || {};
    window.LLMRouter.complete = function (o) {
      const text = '**结论**：桩摘要 [1]';
      return Promise.resolve().then(function () {
        if (o && o.onDelta) o.onDelta(text, text);
        return text;
      });
    };
    window.openDeskApp('aisearch');
  });
  await page.waitForTimeout(900);
  /* 可选：指定评测用的中转地址（AISEARCH_RELAY=http://127.0.0.1:8799），
     这样可以在不影响桌面端 8787 的情况下验证新版中转。 */
  const relay = String(process.env.AISEARCH_RELAY || '').replace(/\/$/, '');
  if (relay) {
    await page.evaluate((base) => {
      window.relayBase = function () { return base; };
    }, relay);
  }

  const rows = [];
  for (const c of CASES) {
    await page.evaluate((mode) => {
      const home = document.querySelector('#aisearchWin [data-act="home"], #aisearchWin .ais-brand');
      if (home) home.click();
      const btn = document.querySelector('#aisearchWin .ais-mode[data-mode="' + mode + '"]');
      if (btn && !btn.classList.contains('is-on')) btn.click();
    }, c.mode);
    await page.waitForTimeout(150);
    await page.fill('#aisearchWin .ais-hero-input', c.q);
    await page.press('#aisearchWin .ais-hero-input', 'Enter');
    await page.waitForFunction(() => {
      const s = document.querySelector('#aisearchWin .ais-status');
      return s && /完成|未找到|失败/.test(s.textContent || '');
    }, null, { timeout: 200000 });
    await page.waitForTimeout(400);
    const out = await page.evaluate(() => ({
      status: document.querySelector('#aisearchWin .ais-status').textContent.trim(),
      trace: [...document.querySelectorAll('#aisearchWin .ais-trace-item')].map((el) =>
        el.querySelector('.ais-trace-kind').textContent + ':' + el.querySelector('.ais-trace-res').textContent),
      hits: [...document.querySelectorAll('#aisearchWin .ais-hit')].map((el) =>
        el.querySelector('.ais-hit-title').textContent + ' | ' + el.querySelector('.ais-hit-url').textContent),
      filtered: document.querySelector('#aisearchWin .ais-filtered').textContent.trim(),
      promptLen: (window.__llmUser || '').length
    }));
    const pool = out.hits.join(' ').toLowerCase();
    const hits = c.expect.filter((k) => pool.includes(k.toLowerCase()));
    rows.push({
      id: c.id, q: c.q, status: out.status, n: out.hits.length,
      expectHit: hits.length + '/' + c.expect.length,
      hits: out.hits.slice(0, 8), trace: out.trace, filtered: out.filtered, promptLen: out.promptLen
    });
    await page.waitForTimeout(5000);
  }

  for (const r of rows) {
    console.log('\n### ' + r.id + ' ' + r.q + '  → ' + r.status + ' · ' + r.n + ' 条 · 期望命中 ' + r.expectHit + ' · 资料 ' + r.promptLen + ' 字');
    console.log('  trace: ' + r.trace.join(' ｜ '));
    console.log('  hits:'); r.hits.forEach((h) => console.log('   - ' + h));
    if (r.filtered) console.log('  ' + r.filtered);
  }
  console.log('\npageerrors:', errs.length ? errs : 'none');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('bench 异常：', e && e.message); process.exit(2); });
