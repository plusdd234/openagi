/* 探针：ComfyUI App —— 「引擎生命周期 + 内嵌工作流界面」
 *
 * 这个 App 的界面从「一页状态卡片」变成了「状态条 + 舞台」：
 *   · 引擎在跑时，舞台里是一个指向 http://127.0.0.1:8188/ 的容器（webview / iframe）；
 *   · 停止 / 启动 / 刷新 / 管理 都在窗口内部完成，不再跳系统浏览器。
 *
 * 覆盖点：
 *   ① 运行中 → 容器被创建并指向 8188，管理面板让位；
 *   ② 「管理」切面板、「返回界面」切回容器；
 *   ③ 「停止」真的调主进程，状态词与容器同步收起；
 *   ④ 停止后再「启动」，容器重新回到前台；
 *   ⑤ 切回桌面再打开，不重建 DOM（容器节点还是同一个）。
 *
 * ⚠ 全程用桩替掉桌面桥，并拦截发往 8188 的请求：默认测试不碰真实 ComfyUI。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

let fails = 0;
const run = createRun('probe-comfy');
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const stateWord = (page) => page.evaluate(() =>
  (document.querySelector('#comfyWin .cf-bar-state') || {}).textContent || '');
const frameInfo = (page) => page.evaluate(() => {
  const f = document.querySelector('#comfyWin .cf-frame');
  if (!f) return null;
  const cs = getComputedStyle(f);
  return {
    tag: f.tagName.toLowerCase(),
    src: f.src || '',
    hidden: f.classList.contains('is-off') || cs.visibility === 'hidden'
  };
});
const panelHidden = (page) => page.evaluate(() => {
  const p = document.querySelector('#comfyWin .cf-panel');
  return !p || p.classList.contains('is-off') || getComputedStyle(p).display === 'none';
});

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  /* 默认测试不碰真实引擎：发往 8188 的请求一律拦掉，只验证容器与状态机 */
  await page.route('http://127.0.0.1:8188/**', (r) => r.abort());

  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  /* 桌面桥桩：引擎「已安装 + 运行中」，生命周期动作只改桩里的状态 */
  await page.evaluate(() => {
    window.__cf = { running: true, calls: [] };
    window.openagiDesktop = {
      comfyDetect: async () => ({
        ok: true, running: window.__cf.running, installed: true,
        dir: 'D:\\ComfyUI', layout: { mode: 'portable' },
        tar: 'C:\\Windows\\System32\\tar.exe', sevenZip: '', canInstall: true,
        systemStats: { system: { comfyui_version: '0.3.0' } }, log: ''
      }),
      comfyLaunch: async () => {
        window.__cf.calls.push('launch'); window.__cf.running = true; return { ok: true };
      },
      comfyStop: async () => {
        window.__cf.calls.push('stop'); window.__cf.running = false; return { ok: true };
      },
      comfyOpenUi: async () => {
        window.__cf.calls.push('openui'); return { ok: true, url: 'http://127.0.0.1:8188' };
      },
      comfyPickDir: async () => ({ ok: false, cancelled: true }),
      comfyCancel: async () => ({ ok: true }),
      onComfyProgress: () => {},
      enginesStatus: async () => ({ ollama: 'off', comfy: 'already' })
    };
  });

  await page.evaluate(() => window.openDeskApp('comfy'));
  await page.waitForTimeout(1200);

  check(await page.evaluate(() => !!document.querySelector('#comfyWin .cf-bar')), '顶部状态条已渲染');
  check((await stateWord(page)) === '运行中', '状态词显示「运行中」', await stateWord(page));

  const f1 = await frameInfo(page);
  check(!!f1, '舞台里创建了界面容器');
  check(!!f1 && /^http:\/\/127\.0\.0\.1:8188\/?/.test(f1.src), '容器指向本机 8188', f1 && f1.src);
  check(!!f1 && !f1.hidden, '运行中时容器在前台');
  check(await panelHidden(page), '运行中时管理面板让位');
  check(await page.evaluate(() =>
    document.querySelector('#comfyWin [data-cf-act="reload"]').hidden === false &&
    document.querySelector('#comfyWin [data-cf-act="stop"]').hidden === false &&
    document.querySelector('#comfyWin [data-cf-act="launch"]').hidden === true),
    '运行中只给「刷新 / 停止 / 管理」，不给「启动」');

  /* 管理 ↔ 界面 */
  await page.evaluate(() => document.querySelector('#comfyWin [data-cf-act="manage"]').click());
  await page.waitForTimeout(250);
  check(!(await panelHidden(page)), '点「管理」后状态面板出现');
  check((await frameInfo(page)).hidden === true, '管理态下界面容器收起');
  await page.evaluate(() => document.querySelector('#comfyWin [data-cf-act="manage"]').click());
  await page.waitForTimeout(250);
  check(await panelHidden(page), '再点「返回界面」回到工作流');

  /* 停止：进程要停，界面也要一起收 */
  await page.evaluate(() => document.querySelector('#comfyWin [data-cf-act="stop"]').click());
  await page.waitForTimeout(1400);
  check(await page.evaluate(() => window.__cf.calls.indexOf('stop') >= 0), '停止按钮真的调了主进程');
  check((await stateWord(page)) === '已停止', '停止后状态词变「已停止」', await stateWord(page));
  check(!(await panelHidden(page)), '停止后自动露出管理面板');
  check((await frameInfo(page)).hidden === true, '停止后界面容器收起');

  /* 启动：回来 */
  await page.evaluate(() => document.querySelector('#comfyWin [data-cf-act="launch"]').click());
  await page.waitForTimeout(1200);
  check(await page.evaluate(() => window.__cf.calls.indexOf('launch') >= 0), '启动按钮真的调了主进程');
  check((await stateWord(page)) === '运行中', '启动后状态词回「运行中」', await stateWord(page));
  check((await frameInfo(page)).hidden === false, '启动后界面容器回到前台');

  /* 切回桌面再打开：容器不能重建（否则工作流页面会被冲掉） */
  await page.evaluate(() => {
    const f = document.querySelector('#comfyWin .cf-frame');
    f.dataset.keep = '1';
  });
  await page.evaluate(() => window.deskAppLeave());
  await page.waitForTimeout(400);
  await page.evaluate(() => window.openDeskApp('comfy'));
  await page.waitForTimeout(1000);
  check(await page.evaluate(() =>
    document.querySelector('#comfyWin .cf-frame').dataset.keep === '1'),
    '重新打开后仍是同一个容器节点（没有重建）');
  check((await frameInfo(page)).hidden === false, '重新打开后工作流界面仍在');

  check(errors.length === 0, '全程无 pageerror', errors.join(' | ').slice(0, 160));
  console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 全部通过');
  await browser.close();
  run.finish(fails ? [{ message: fails + ' 项未通过' }] : []);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e);
  run.finish([{ message: String((e && e.stack) || e) }]);
  process.exit(2);
});
