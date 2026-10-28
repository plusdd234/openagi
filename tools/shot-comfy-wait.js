/* 截图：开机自动启动期间打开「本地生图」，以及它起好之后自己变「运行中」
 * 用法：node tools/shot-comfy-wait.js
 * 只出图不断言，供人工核对「卡在启动中」有没有真的解决。
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
    const st = {
      ok: true, running: false, installed: true,
      dir: 'C:\\Users\\30297\\ComfyUI_windows_portable',
      layout: { mode: 'portable' }, sevenZip: '', tar: 'C:\\Windows\\System32\\tar.exe',
      canInstall: true, systemStats: null, log: ''
    };
    window.__st = st;
    window.openagiDesktop = {
      comfyDetect: async () => Object.assign({}, st),
      comfyLaunch: async () => ({ ok: false, message: '正在启动中，请稍候' }),
      comfyStop: async () => { st.running = false; return { ok: true }; },
      comfyOpenUi: async () => ({ ok: true }),
      comfyPickDir: async () => ({ ok: false, cancelled: true }),
      comfyInstall: async () => ({ ok: false, message: '跳过' }),
      comfyCancel: async () => ({ ok: true }),
      onComfyProgress: () => {},
      onEngineStatus: () => {}
    };
  });

  // ① 自动启动正在跑：打开窗口就该是「启动中」，而不是一片红字
  await page.evaluate(() => {
    window.openComfyApp();
    window.dispatchEvent(new CustomEvent('engines-status', {
      detail: { comfy: 'starting', comfyNote: '正在启动 ComfyUI（首次加载 torch 约 100 秒）…' }
    }));
  });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, 'comfy-wait-starting.png') });

  // ② 引擎起来了：不点任何按钮，窗口自己变「运行中」
  await page.evaluate(() => {
    window.__st.running = true;
    window.dispatchEvent(new CustomEvent('engines-status', { detail: { comfy: 'ready' } }));
  });
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'comfy-wait-running.png') });

  console.log('shots ->', OUT);
  await browser.close();
})();
