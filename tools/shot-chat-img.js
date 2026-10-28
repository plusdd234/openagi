/* 截图：对话内生图（输入条按钮 / 生成中 / 成品卡片 / 大图）
 * 用法：node tools/shot-chat-img.js
 * 只出图不断言，供人工与文档看效果。
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
    window.llmStreamRequest = async (sys, m, onDelta) => {
      const isRefine = /提示词工程师/.test(String(sys || ''));
      const text = isRefine
        ? '一只穿黑色风衣的赛博朋克猫站在雨夜街头，霓虹灯反射在积水里，电影级特写，冷蓝配洋红'
        : '好的，我按这个方向来画。';
      await new Promise(r => setTimeout(r, 120));
      if (onDelta) onDelta(text, text, { phase: 'answer' });
      return text;
    };
    window.llmChatMessagesStream = (sys, m, d, o) => window.llmStreamRequest(sys, m, d, o);
    // 造一张有内容的图，别拿 1×1 像素截图
    window.__shotImg = (function () {
      const c = document.createElement('canvas');
      c.width = 768; c.height = 512;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, 768, 512);
      bg.addColorStop(0, '#1b1740'); bg.addColorStop(.55, '#4a1d6b'); bg.addColorStop(1, '#0d2a4a');
      g.fillStyle = bg; g.fillRect(0, 0, 768, 512);
      for (let i = 0; i < 26; i++) {
        const x = Math.random() * 768, y = Math.random() * 380, w = 6 + Math.random() * 26, h = 20 + Math.random() * 90;
        g.fillStyle = ['rgba(255,86,190,.5)', 'rgba(90,220,255,.45)', 'rgba(255,214,102,.5)'][i % 3];
        g.fillRect(x, y, w, h);
      }
      g.fillStyle = 'rgba(10,12,20,.55)'; g.fillRect(0, 380, 768, 132);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = 'rgba(255,255,255,.06)';
        g.fillRect(Math.random() * 768, 380 + Math.random() * 132, 2, 18);
      }
      g.font = '600 34px "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(255,255,255,.9)';
      g.fillText('CYBER CAT', 34, 84);
      return c.toDataURL('image/png');
    })();
    window.wfImage = async () => { await new Promise(r => setTimeout(r, 1400)); return window.__shotImg; };
  });

  // 输入条：生图模式按钮（自动）与（生图）
  await page.screenshot({ path: path.join(OUT, 'chat-img-bar.png'), clip: { x: 234, y: 740, width: 1186, height: 150 } });
  await page.evaluate(() => window.deskChat.imgMode('image'));
  await sleep(150);
  await page.screenshot({ path: path.join(OUT, 'chat-img-bar-on.png'), clip: { x: 234, y: 740, width: 1186, height: 150 } });

  // 生成中
  await page.fill('#deskAiText', '画一只在雨里的赛博朋克猫');
  await page.click('#deskAiSend');
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, 'chat-img-loading.png') });

  // 完成
  await page.waitForSelector('.dgen.is-done', { timeout: 15000 });
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'chat-img-done.png') });
  await page.locator('.dgen.is-done').screenshot({ path: path.join(OUT, 'chat-img-card.png') });

  // 图生图：用作参考图 → 改这张
  await page.click('.dgen.is-done .dgen-act[data-act="ref"]');
  await sleep(200);
  await page.fill('#deskAiText', '把背景换成海边日落，其他保持不变');
  await page.click('#deskAiSend');
  await page.waitForFunction(() => document.querySelectorAll('.dgen.is-done').length === 2, null, { timeout: 15000 });
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'chat-img-i2i.png') });

  // 大图
  await page.click('.dgen.is-done .dgen-img');
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 'chat-img-viewer.png'), animations: 'disabled' });

  // 失败态
  await page.evaluate(() => { window.wfImage = async () => { throw new Error('显存不足，模型没能加载起来'); }; });
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.fill('#deskAiText', '画一张超大海报');
  await page.click('#deskAiSend');
  await page.waitForSelector('.dgen.is-error', { timeout: 12000 });
  await sleep(400);
  await page.locator('.dgen.is-error').screenshot({ path: path.join(OUT, 'chat-img-error.png') });

  await browser.close();
  console.log('shots ->', OUT);
})();
