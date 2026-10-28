/* 截图：本地生图的卡片文案（中文提示词译成英文 / 没译成）
 * 用法：node tools/shot-chat-local.js
 * 只出图不断言。重点在卡片底部那行说明——它决定了用户下次会不会再踩「图和描述无关」。
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

  await page.addInitScript(() => { try { localStorage.setItem('mc_scope_image', 'local'); } catch (e) { } });
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  await page.evaluate(() => {
    const r = document.getElementById('relayOn');
    if (r) r.checked = false;
    document.getElementById('llmBaseUrl').value = 'http://127.0.0.1:11434/v1';
    document.getElementById('llmKey').value = 'ollama';
    document.getElementById('llmModel').value = 'qwen2.5:3b';

    window.llmStreamRequest = async (sys, m, onDelta) => {
      const isRefine = /提示词工程师/.test(String(sys || ''));
      const text = isRefine
        ? '猫趴在地上，阳光透过树叶洒在它身上，材质细腻，镜头低角度，构图简洁，风格写实，色调温暖柔和'
        : '好的，我按这个方向来画。';
      if (isRefine) window.__refined = text;      // 卡片只会为「实际送出去的那句」显示说明
      await new Promise(x => setTimeout(x, 100));
      if (onDelta) onDelta(text, text, { phase: 'answer' });
      return text;
    };
    window.llmChatMessagesStream = (sys, m, d, o) => window.llmStreamRequest(sys, m, d, o);

    // 本地来源：卡片上要带「本地 · <模型名>」，提示行才会出现
    window.deskImage.source = () => ({
      kind: 'local', label: '本地 · v1-5-pruned-emaonly-fp16.safetensors',
      ready: true, where: 'comfy', hint: ''
    });

    window.__shotImg = (function () {
      const c = document.createElement('canvas');
      c.width = 768; c.height = 512;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, 0, 512);
      bg.addColorStop(0, '#f3e2bd'); bg.addColorStop(.6, '#d8b57a'); bg.addColorStop(1, '#7a5a34');
      g.fillStyle = bg; g.fillRect(0, 0, 768, 512);
      // 树叶缝隙里落下来的光斑
      for (let i = 0; i < 40; i++) {
        g.beginPath();
        g.ellipse(Math.random() * 768, Math.random() * 512, 12 + Math.random() * 46, 8 + Math.random() * 26, Math.random() * Math.PI, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,246,205,' + (0.05 + Math.random() * 0.12) + ')';
        g.fill();
      }
      // 地上的猫（示意：身子 + 耳朵 + 尾巴）
      g.fillStyle = '#6b4a2c';
      g.beginPath(); g.ellipse(330, 330, 130, 62, -0.12, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(452, 300, 54, 46, 0.1, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(430, 262); g.lineTo(442, 226); g.lineTo(456, 262); g.fill();
      g.beginPath(); g.moveTo(466, 258); g.lineTo(486, 226); g.lineTo(492, 262); g.fill();
      g.strokeStyle = '#6b4a2c'; g.lineWidth = 18; g.lineCap = 'round';
      g.beginPath(); g.moveTo(206, 322); g.quadraticCurveTo(120, 300, 132, 232); g.stroke();
      g.font = '600 30px "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(60,40,20,.62)';
      g.fillText('CAT · SUNLIGHT', 34, 72);
      return c.toDataURL('image/png');
    })();
    window.wfImage = async () => { await new Promise(x => setTimeout(x, 1200)); return window.__shotImg; };
  });

  const runCase = async (tag, tr) => {
    await page.evaluate(t => {
      window.comfyLastLocalize = () => ({
        zh: window.__refined || '',
        en: 'Cat on the ground, sunlight filtering through leaves onto it',
        ok: t.ok, via: t.via || '', model: t.model || '', reason: t.reason || ''
      });
    }, tr);
    await page.evaluate(() => window.deskChat.imgMode('image'));
    await page.fill('#deskAiText', '画一只猫趴在地上，阳光透过树叶洒在它身上');
    await page.click('#deskAiSend');
    await page.waitForFunction(n => document.querySelectorAll('.dgen.is-done').length >= n,
      { done: 1 }, { timeout: 20000 }).catch(() => { });
    await sleep(600);
    await page.locator('.dgen.is-done').last().screenshot({ path: path.join(OUT, 'chat-local-' + tag + '.png') });
    await page.evaluate(() => { window.__n = (window.__n || 0) + 1; });
  };

  await runCase('ok', { ok: true, via: 'ollama', model: 'qwen2.5:3b' });
  await runCase('fail', { ok: false, reason: '语言模型：Failed to fetch（直连 11434 被 CORS 拦）' });

  /* 图生图：卡片上多一个「重绘强度」按钮（本地没有 mask / ControlNet，强度是唯一的构图约束） */
  await page.evaluate(() => {
    window.comfyLastLocalize = () => ({ zh: window.__refined || '', en: 'same subject, background changed to seaside sunset', ok: true, via: 'ollama', model: 'qwen2.5:3b' });
    window.deskChat.setLastImage(window.__shotImg);
    window.deskChat.imgMode('auto');
    document.getElementById('deskAiText').value = '把背景换成海边日落，猫和它的姿态保持不变';
    document.getElementById('deskAiSend').click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.dgen.is-done').length >= 3, null, { timeout: 20000 }).catch(() => { });
  await sleep(600);
  await page.locator('.dgen.is-done').last().screenshot({ path: path.join(OUT, 'chat-local-i2i.png') });

  await browser.close();
  console.log('shots ->', OUT);
})();
