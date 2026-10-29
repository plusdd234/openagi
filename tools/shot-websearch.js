/* 截图：对话「联网搜索」（开关 / 带来源的回答 / 设置页来源配置）
 * 用法：node tools/shot-websearch.js
 * 全程走 page.route 假数据，不碰外网。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const DDG_HTML = `
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://openagi.dev/docs">OpenAGI 文档 · 快速开始</a></h2>
  <a class="result__snippet">开源 AI 工作流工作台：可视化节点、多引擎生图、本地 ComfyUI 与 3D 生成。</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://github.com/plusdd234/openagi">GitHub - plusdd234/openagi</a></h2>
  <a class="result__snippet">MIT licensed. Node-based workflow editor with local engines.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://openagi.dev/blog/2026">2026 更新日志</a></h2>
  <a class="result__snippet">两页式桌面、自定义云端生图、联网搜索。</a>
</div>
`;
const ANSWER = 'OpenAGI 是一个开源的 AI 工作流工作台：用节点把「分析 → 生图 → 3D」串起来，既能接云端接口，也能跑本地 ComfyUI [1][2]。\n\n最近一版还加了「自定义云端生图」和对话内联网搜索，前者用来接中转站，后者让回答能带上实时网页来源。';

(async () => {
  const out = path.join(__dirname, '..', '.workbuddy', 'shots');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  await page.route('https://html.duckduckgo.com/**', r => r.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' }, body: DDG_HTML
  }));
  await page.route('**/chat/completions', r => r.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ choices: [{ message: { content: ANSWER } }] })
  }));

  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1400);

  await page.evaluate(() => {
    const relay = document.getElementById('relayOn');
    if (relay) { relay.checked = false; relay.dispatchEvent(new Event('change', { bubbles: true })); }
    const base = document.getElementById('llmBaseUrl');
    base.value = 'https://llm.test/v1';
    base.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('llmKey').value = 'sk-test';
    document.getElementById('llmKey').dispatchEvent(new Event('input', { bubbles: true }));
    const sel = document.getElementById('deskAiModel');
    const o = document.createElement('option');
    o.value = 'local:test-model'; o.textContent = 'test-model';
    sel.appendChild(o); sel.value = 'local:test-model';
    localStorage.setItem('hf_wsProvider', 'ddg');
    localStorage.setItem('hf_wsCount', '3');
    window.deskChat.imgMode('chat');
    window.deskChat.webSearch(true);
  });
  await page.waitForTimeout(300);

  /* 1. 工具栏：联网按钮亮着（在 + 与「无上下文」之间） */
  const bar = await page.locator('.dai-bar').boundingBox();
  if (bar) {
    await page.screenshot({
      path: path.join(out, 'websearch-1-bar.png'),
      clip: { x: Math.max(0, bar.x - 4), y: Math.max(0, bar.y - 10), width: Math.min(1440, bar.width + 8), height: bar.height + 20 }
    });
  }

  /* 2. 一问一答：回答带「联网来源」 */
  await page.fill('#deskAiText', 'OpenAGI 是什么？');
  await page.click('#deskAiSend');
  await page.waitForFunction(() => {
    const list = Array.from(document.querySelectorAll('.dchat-msg.ai .dchat-text'));
    const t = list.length ? list[list.length - 1].textContent.trim() : '';
    return !!t && t !== '…';
  }, null, { timeout: 15000 });
  await page.waitForTimeout(700);
  const win = await page.locator('#deskChatFoot').boundingBox();
  const log = await page.locator('.dchat-log, #deskChatLog').first().boundingBox();
  if (log) {
    await page.screenshot({
      path: path.join(out, 'websearch-2-reply.png'),
      clip: { x: Math.max(0, log.x - 10), y: Math.max(0, log.y - 10), width: Math.min(1440, log.width + 20), height: Math.min(700, log.height + 20) }
    });
  }

  /* 3. 设置页：联网来源（三个来源 + 条数 + 测试按钮） */
  await page.evaluate(() => {
    if (typeof openSettings === 'function') openSettings('llm');
    const d = document.getElementById('wsBox');
    if (d) d.open = true;
  });
  /* 等 toast 自己消失：它悬在底部中央，正好压住这一块 */
  await page.waitForTimeout(3200);
  const pane = await page.locator('#wsBox').boundingBox();
  if (pane) {
    await page.screenshot({
      path: path.join(out, 'websearch-3-settings.png'),
      clip: { x: Math.max(0, pane.x - 14), y: Math.max(0, pane.y - 14), width: Math.min(900, pane.width + 28), height: pane.height + 28 }
    });
  }

  await browser.close();
  console.log('截图已存到 .workbuddy/shots/：websearch-1-bar / websearch-2-reply / websearch-3-settings');
})().catch(e => { console.error(e); process.exit(1); });
