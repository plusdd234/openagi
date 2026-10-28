/* 截图：模型控制台里的「引擎自动启动」开关 + 自动启动进行中 / 失败的样子
 * 用法：node tools/shot-engine-auto.js
 * 只出图不断言，供人工与文档看效果。
 *
 * 为什么要在页面里注入一个假桥：开关只在桌面端出现（判据是 window.openagiDesktop 存在），
 * 网页版看不到。假桥只实现这几个卡片用得到的方法，够渲染就行。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'tmp-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if(!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));

  // 假桌面桥：必须在页面脚本执行前注入
  await page.addInitScript(() => {
    const st = {
      ollamaRunning: true,
      comfyRunning: false,
      comfyInstalled: true
    };
    window.__shot = { statusCbs: [], state: st };
    window.openagiDesktop = {
      versions: async () => ({ app: '0.1.0', electron: '33', chrome: '130', content: 'shot' }),
      hardware: async () => ({ probedAt: Date.now(), gpu: { ok: true, name: 'RTX 4060 Laptop', vramMB: 8188 }, cpu: { cores: 16 }, mem: { totalMB: 32768 }, recommend: {} }),
      ollamaDetect: async () => ({ installed: true, exe: 'C:/fake/ollama.exe' }),
      ollamaStatus: async () => ({ installing: false, progress: null }),
      comfyDetect: async () => ({
        ok: true, running: st.comfyRunning, installed: st.comfyInstalled,
        dir: 'D:/ComfyUI_windows_portable', layout: { mode: 'portable' },
        base: 'http://127.0.0.1:8188', tar: 'C:/Windows/System32/tar.exe', sevenZip: '', canInstall: true, log: ''
      }),
      enginesConfig: async () => ({ ollama: true, comfy: true, warm: false }),
      enginesSetConfig: async p => Object.assign({ ollama: true, comfy: true, warm: false }, p || {}),
      enginesStatus: async () => ({ ollama: 'ready', comfy: 'idle', run: false, done: true, at: Date.now(), note: '', ollamaNote: 'Ollama 已就绪', comfyNote: '' }),
      onEngineStatus: cb => { window.__shot.statusCbs.push(cb); },
      onOllamaProgress: () => {},
      onComfyProgress: () => {}
    };
  });

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // 打开「模型控制台」窗口并渲染
  const open = async () => {
    await page.evaluate(async () => {
      document.getElementById('modelsWin').classList.remove('hidden');
      await renderModelsConsole();
    });
    await page.waitForTimeout(400);
  };
  await open();

  /* 本机 8794 桥是真在跑的，rtHealth 会被探成绿色，卡片就显示「运行中」——
   * 那和「自动启动前」的样子对不上。这里把探活按住，模拟刚开机的状态。 */
  await page.evaluate(async () => {
    rtHealth.ollama.ok = false;
    rtHealth.comfy.ok = false;
    window.rtRefresh = async () => false;
    mcPaintEng();
    mcPaintComfy();
  });
  await page.waitForTimeout(200);

  // 只截两张引擎卡片：整窗截图里字太小，看不清开关
  const box = await page.evaluate(() => {
    const a = document.getElementById('mcEng').getBoundingClientRect();
    const b = document.getElementById('mcComfy').getBoundingClientRect();
    return { x: Math.min(a.x, b.x) - 14, y: a.y - 12, width: Math.max(a.width, b.width) + 28, height: (b.bottom - a.top) + 24 };
  });

  await page.screenshot({ path: path.join(OUT, 'engine-auto-idle.png'), clip: box });

  // 自动启动进行中
  await page.evaluate(() => {
    const cbs = window.__shot.statusCbs;
    cbs.forEach(cb => cb({
      ollama: 'starting', comfy: 'starting',
      ollamaNote: '正在启动 Ollama…',
      comfyNote: '正在启动 ComfyUI（首次加载 torch 约 100 秒）…',
      run: true, done: false
    }));
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'engine-auto-starting.png'), clip: box });

  // 一个起来了、一个没起来
  await page.evaluate(() => {
    window.__shot.state.comfyRunning = true;
    const cbs = window.__shot.statusCbs;
    cbs.forEach(cb => cb({
      ollama: 'failed', comfy: 'ready',
      ollamaNote: '启动超时（30 秒）：可稍后手动启动',
      comfyNote: 'ComfyUI 已就绪',
      run: false, done: true
    }));
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'engine-auto-failed.png'), clip: box });

  console.log('shots ->', OUT);
  await browser.close();
})().catch(e => {
  console.error('截图失败：', (e && e.stack) || e);
  process.exit(1);
});
