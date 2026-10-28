/* 截图：模型把出图指令写两遍时的界面（正文里不该出现裸 JSON）
 * 用法：node tools/shot-chat-dup.js
 * 只出图不断言，供人工核对。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'tmp-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  await page.evaluate(() => {
    const r = document.getElementById('relayOn');
    if (r) r.checked = false;
    document.getElementById('llmBaseUrl').value = 'http://127.0.0.1:9/v1';
    document.getElementById('llmKey').value = 'sk-shot';
    document.getElementById('llmModel').value = 'seedream-v5';
    const J = '{"type":"image","prompt":"一只橘白相间的猫坐在窗台上，午后阳光斜射，毛发明亮，浅景深，写实摄影","mode":"text"}';
    window.llmStreamRequest = async (sys, m, onDelta) => {
      const isRefine = /提示词工程师/.test(String(sys || ''));
      const text = isRefine ? '一只橘白相间的猫坐在窗台上，午后阳光斜射，毛发明亮，浅景深，写实摄影' : (J + '\n' + J);
      await new Promise(r => setTimeout(r, 160));
      if (onDelta && !isRefine) {
        for (let i = 8; i <= text.length; i += 8) {
          onDelta(text.slice(0, i), text.slice(i - 8, i), { phase: 'answer' });
          await new Promise(r => setTimeout(r, 6));
        }
      } else if (onDelta) onDelta(text, text, { phase: 'answer' });
      return text;
    };
    window.llmChatMessagesStream = (sys, m, d, o) => window.llmStreamRequest(sys, m, d, o);

    window.__shotImg = (function () {
      const c = document.createElement('canvas');
      c.width = 768; c.height = 512;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, 768, 512);
      bg.addColorStop(0, '#f6e7d3'); bg.addColorStop(.6, '#e8c9a4'); bg.addColorStop(1, '#b98a5e');
      g.fillStyle = bg; g.fillRect(0, 0, 768, 512);
      // 窗框
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.fillRect(60, 40, 300, 330);
      g.fillStyle = 'rgba(120,90,60,.35)';
      g.fillRect(60, 200, 300, 12); g.fillRect(205, 40, 12, 330);
      // 猫
      g.fillStyle = '#e9a45c';
      g.beginPath(); g.ellipse(430, 360, 118, 92, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(430, 236, 78, 68, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(378, 200); g.lineTo(392, 138); g.lineTo(424, 190); g.fill();
      g.beginPath(); g.moveTo(482, 200); g.lineTo(468, 138); g.lineTo(436, 190); g.fill();
      g.fillStyle = '#2a2320';
      g.beginPath(); g.ellipse(408, 232, 9, 12, 0, 0, 7); g.fill();
      g.beginPath(); g.ellipse(452, 232, 9, 12, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,240,200,.55)';
      g.beginPath(); g.moveTo(380, 300); g.lineTo(560, 120); g.lineTo(640, 200); g.lineTo(470, 400); g.fill();
      return c.toDataURL('image/png');
    })();
    window.wfImage = async () => { await new Promise(r => setTimeout(r, 1500)); return window.__shotImg; };
  });

  // ① 正常完成：气泡里只有一句话，卡片是干净的提示词
  await page.fill('#deskAiText', '窗边那只猫挺可爱的');
  await page.click('#deskAiSend');
  await page.waitForSelector('.dgen.is-done', { timeout: 15000 });
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 'chat-dup-clean.png'), clip: { x: 234, y: 60, width: 1186, height: 840 } });

  // ② 取图失败：错误说明在卡片上，正文依旧不含 JSON
  await page.evaluate(() => {
    window.wfImage = async () => { await new Promise(r => setTimeout(r, 600)); throw new Error('取回生成图失败：HTTP 404（openagi_00008_.png · output）'); };
  });
  await page.fill('#deskAiText', '再来一张，换个角度');
  await page.click('#deskAiSend');
  await page.waitForSelector('.dgen.is-error', { timeout: 15000 });
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'chat-dup-error.png'), clip: { x: 234, y: 260, width: 1186, height: 640 } });

  console.log('shots ->', OUT);
  await browser.close();
})();
