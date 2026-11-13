/* 探针：浏览器 App 的 Electron <webview> 路径（普通浏览器回退 iframe 由 probe-browser.js 测）
 * 用法：node tools/probe-browser-webview.js
 *
 * Chromium 里没有 <webview>（Electron 专属标签）。这里用 addInitScript 装一个桩：
 *   document.createElement('webview') → HTMLUnknownElement + 补上 loadURL / reload
 * 于是 makeFrame() 会走 webview 分支。验的是 **App 自己的分支逻辑与事件契约**，
 * 不是 Electron 内核（内核那份由 electron/main.js 的 webviewTag + will-attach-webview 保证）。
 *
 * 覆盖：
 *   ① 容器选择：webview 而非 iframe，且带 webpreferences 护栏
 *   ② 收起语义用 is-off（visibility）而不是 hidden（display:none 会把 guest 压成 0 尺寸）
 *   ③ dom-ready 之前点链接要排队；dom-ready 后放行；迟迟不来只给诊断提示，**不强行 loadURL**
 *   ④ did-navigate / did-navigate-in-page 把真实地址同步回地址栏（iframe 做不到）
 *   ⑤ did-start/did-stop-loading 控进度线；did-fail-load 非 -3 报错、-3 静默
 *   ⑥ 刷新走 reload() 而不是重新 loadURL()
 *   ⑦ app:// 地址不会被当成搜索词（Electron 壳的 origin 就是 app://openagi）
 *   ⑧ **webview 必须带 src="about:blank"** —— 没有 src 就不会创建 guest、不发 dom-ready，
 *      loadURL 必抛错、整块白屏（2026-11-13 真实 Electron 实测，删掉这行必回归）
 *   ⑨ 全程无 pageerror
 *
 * ⚠ 桩只验 App 的分支逻辑，验不了 Electron 内核。真实内核那条链（webview 无 src →
 *    永不 dom-ready → loadURL 抛错 → 白屏）另由 tools/probe-browser-guest.js 覆盖。
 * ⚠ 反证改 apps/manifest.js 单行（避开 CRLF 静默替换失效），注入前打印命中数 ——
 *    「替换没生效」和「逻辑没问题」输出一样。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const ROOT = path.join(__dirname, '..');
const ENTRY = pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1';

/* 桩：只拦 'webview' 这一个标签，其余一律原样交给浏览器，别污染别的 App */
function installStub() {
  window.__wv = {
    created: 0, loads: [], reloads: 0, url: '',
    zooms: [], zoom: 1,
    /* fitWidth 通过 executeJavaScript 读 guest 的内容宽/视口宽；桩里给可控值 */
    pageMetrics: { iw: 0, sw: 0 }
  };
  const orig = document.createElement.bind(document);
  document.createElement = function (tag, opts) {
    if (String(tag).toLowerCase() !== 'webview') return orig(tag, opts);
    const el = orig('webview', opts);
    el.loadURL = function (u) {
      const s = String(u);
      window.__wv.loads.push(s);
      window.__wv.url = s;
      el.setAttribute('src', s);
    };
    el.reload = function () { window.__wv.reloads++; };
    el.setZoomFactor = function (f) {
      window.__wv.zooms.push(f);
      window.__wv.zoom = f;
    };
    el.executeJavaScript = function () {
      return Promise.resolve(window.__wv.pageMetrics);
    };
    window.__wv.created++;
    return el;
  };
}

const addr = page => page.inputValue('#browserWin .bw-input');
const wv = page => page.evaluate(() => window.__wv);
const status = page => page.evaluate(() =>
  document.querySelector('#browserWin .bw-status-msg').textContent || '');
const frameInfo = page => page.evaluate(() => {
  const f = document.querySelector('#browserWin .bw-frame');
  return f ? {
    tag: f.tagName.toLowerCase(),
    prefs: f.getAttribute('webpreferences') || '',
    src: f.getAttribute('src') || '',
    off: f.classList.contains('is-off'),
    hidden: f.classList.contains('hidden')
  } : null;
});

/* 派发 Electron 的 webview 事件。Event 对象可扩展，用 defineProperty 挂 url / errorCode */
async function fire(page, name, props) {
  return page.evaluate(({ name, props }) => {
    const el = document.querySelector('#browserWin webview');
    if (!el) return false;
    const ev = new Event(name);
    Object.keys(props || {}).forEach(k =>
      Object.defineProperty(ev, k, { value: props[k], enumerable: true }));
    el.dispatchEvent(ev);
    return true;
  }, { name, props });
}

/* ⚠ 不能「等固定秒数就点下一步」：mount 是异步排到桌面翻页之后的，
   固定等待会撞上「App 还没画完」—— 首跑 8 条红里有 5 条就是这么来的。
   改成等 DOM 真的出现；尽快返回，好让「dom-ready 之前排队」这段落在诊断计时之前。 */
async function boot(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.addInitScript(installStub);
  await page.goto(ENTRY, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.openDeskApp('browser'));
  await page.waitForFunction(() =>
    !!document.querySelector('#browserWin .bw-frame') &&
    document.querySelectorAll('#browserWin .bw-link').length > 0,
    null, { timeout: 8000 });
  return { page, errors };
}

/* 点起始页的「本地示例页」入口（不经过输入框 normalize，直接 navigate） */
async function clickDemo(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#browserWin .bw-link')]
      .find(x => (x.getAttribute('data-url') || '').includes('demo.html'));
    if (b) b.click();
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });

  /* ============ 页面 A：主流程 ============ */
  const A = await boot(browser);
  const page = A.page;

  const s0 = await wv(page);
  const f0 = await frameInfo(page);
  check(s0.created === 1 && f0 && f0.tag === 'webview',
    'Electron 分支创建的是 webview 容器', 'created=' + s0.created + ' tag=' + (f0 && f0.tag));
  check(await page.evaluate(() => document.querySelectorAll('#browserWin iframe.bw-frame').length === 0),
    '没有同时挂 iframe 容器');
  check(f0 && /nodeIntegration=no/.test(f0.prefs) && /contextIsolation=yes/.test(f0.prefs),
    'webpreferences 剥掉 Node、开启隔离', f0 && f0.prefs);
  check(f0 && f0.off && !f0.hidden,
    '起始页用 is-off 收起 webview（不用 display:none）', f0 && JSON.stringify(f0));
  check(f0 && f0.src === 'about:blank',
    'webview 带 src="about:blank"（否则 guest 不就绪、loadURL 抛错白屏）', f0 && f0.src);
  check(await page.evaluate(() => {
    const a = document.querySelector('#browserWin .bw-app');
    const z = document.querySelector('#browserWin .bw-zoom');
    return !!a && a.classList.contains('is-web') && !!z && getComputedStyle(z).display !== 'none';
  }), 'webview 模式显示缩放控件（iframe 模式隐藏）');

  /* dom-ready 没来之前，第一次导航必须排队 */
  await clickDemo(page);
  await page.waitForTimeout(120);
  const sQueue = await wv(page);
  check(sQueue.loads.length === 0,
    'dom-ready 之前的导航请求被排队（没有提前 loadURL）', 'loads=' + sQueue.loads.length);
  check((await addr(page)).includes('demo.html'), '排队期间地址栏已更新');

  await fire(page, 'dom-ready', {});
  await page.waitForTimeout(160);
  const sReady = await wv(page);
  check(sReady.loads.length === 1 && sReady.loads[0].includes('demo.html'),
    'dom-ready 后放行排队的 URL', sReady.loads.join(' | '));

  /* 导航事件同步地址栏：这是 webview 比 iframe 强的那一条 */
  const navUrl = 'https://studio.tripo3d.ai/zh/workspace/generate-image';
  check(await fire(page, 'did-navigate', { url: navUrl }), 'did-navigate 事件可派发');
  await page.waitForTimeout(120);
  check((await addr(page)) === navUrl, 'did-navigate 把真实地址同步回地址栏', await addr(page));

  const spaUrl = 'https://studio.tripo3d.ai/zh/workspace/gallery';
  await fire(page, 'did-navigate-in-page', { url: spaUrl });
  await page.waitForTimeout(120);
  check((await addr(page)) === spaUrl, 'did-navigate-in-page 同步 SPA 路由', await addr(page));

  /* 前进/后退栈只更新当前条目，不新增历史 */
  check(await page.evaluate(() => document.querySelector('#browserWin [data-act="forward"]').disabled),
    '页面内跳转不新增前进历史（仍是栈顶）');

  /* 进度线 */
  await fire(page, 'did-start-loading', {});
  await page.waitForTimeout(80);
  check(await page.evaluate(() => document.querySelector('#browserWin .bw-app').classList.contains('is-loading')),
    'did-start-loading 打开进度线');
  await fire(page, 'did-stop-loading', {});
  await page.waitForTimeout(80);
  check(await page.evaluate(() => !document.querySelector('#browserWin .bw-app').classList.contains('is-loading')),
    'did-stop-loading 收起进度线');

  /* did-fail-load：-3（ERR_ABORTED）静默；其他要报错 */
  await fire(page, 'did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED' });
  await page.waitForTimeout(80);
  check(!(await status(page)).includes('加载失败'),
    'did-fail-load(-3) 主动中止不误报', await status(page));
  await fire(page, 'did-fail-load', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED' });
  await page.waitForTimeout(80);
  check((await status(page)).includes('加载失败'),
    'did-fail-load(-105) 给出失败提示', await status(page));
  check(await page.evaluate(() => !document.querySelector('#browserWin .bw-app').classList.contains('is-loading')),
    '加载失败后进度线被清掉');

  /* 刷新走 reload() */
  const beforeReload = await wv(page);
  await page.evaluate(() => document.querySelector('#browserWin [data-act="reload"]').click());
  await page.waitForTimeout(150);
  const afterReload = await wv(page);
  check(afterReload.reloads === beforeReload.reloads + 1 && afterReload.loads.length === beforeReload.loads.length,
    '刷新调用 webview.reload()，不重新 loadURL', 'reloads=' + afterReload.reloads);

  /* app:// 是 Electron 壳的 origin，不能被 normalize 当成搜索词 */
  const appUrl = 'app://openagi/apps/browser/demo.html';
  await page.fill('#browserWin .bw-input', appUrl);
  await page.press('#browserWin .bw-input', 'Enter');
  await page.waitForTimeout(180);
  check((await addr(page)) === appUrl,
    'app:// 地址被当作网址而不是搜索词', await addr(page));
  check((await wv(page)).url === appUrl,
    'app:// 地址确实送进了 webview.loadURL', (await wv(page)).url);

  /* 回起始页：is-off 回来 + guest 被清成 about:blank */
  await page.evaluate(() => document.querySelector('#browserWin [data-act="home"]').click());
  await page.waitForTimeout(180);
  const fHome = await frameInfo(page);
  check(fHome && fHome.off && !fHome.hidden, '回起始页重新用 is-off 收起');
  check((await wv(page)).url === 'about:blank', '回起始页把 guest 清成 about:blank', (await wv(page)).url);

  /* ---- 缩放 / 适应宽度（桩给出「视口 1138 / 内容 1280」= Tripo 实测形态）---- */
  const zoomVal = () => page.evaluate(() =>
    ((document.querySelector('#browserWin .bw-zoom-val') || {}).textContent || '').trim());
  await page.evaluate(() => { window.__wv.pageMetrics = { iw: 1138, sw: 1280 }; });
  await page.evaluate(() => document.querySelector('#browserWin [data-act="zoom-fit"]').click());
  await page.waitForTimeout(150);
  const zooms = (await wv(page)).zooms;
  check(zooms.length === 1 && Math.abs(zooms[0] - 0.89) < 0.02,
    '「适应」按内容宽算出 0.89 并调用 setZoomFactor', JSON.stringify(zooms));
  check((await zoomVal()) === '89%', '状态栏显示 89%', await zoomVal());
  check(await page.evaluate(() =>
    document.querySelector('#browserWin .bw-zoom-fit').classList.contains('is-on')),
    '「适应」按钮进入 is-on 态');
  await page.evaluate(() => document.querySelector('#browserWin [data-act="zoom-in"]').click());
  await page.waitForTimeout(80);
  check((await zoomVal()) === '99%', '放大 +10% → 99%', await zoomVal());
  await page.evaluate(() => document.querySelector('#browserWin [data-act="zoom-reset"]').click());
  await page.waitForTimeout(80);
  check((await zoomVal()) === '100%', '重置回 100%', await zoomVal());
  /* 反证：度量读不到时绝不误缩（删掉 pageMetrics 就红） */
  await page.evaluate(() => { window.__wv.pageMetrics = { iw: 0, sw: 0 }; });
  const zBefore = (await wv(page)).zooms.length;
  await page.evaluate(() => document.querySelector('#browserWin [data-act="zoom-fit"]').click());
  await page.waitForTimeout(150);
  check((await wv(page)).zooms.length === zBefore,
    '读不到页面宽度时不误缩（反证：度量为 0 必须无动作）');

  check(A.errors.length === 0, '页面 A 全程无 pageerror', A.errors.join(' | ').slice(0, 160));

  /* ============ 页面 B：dom-ready 永远不来时只诊断、绝不强行 loadURL ============ */
  const B = await boot(browser);
  await clickDemo(B.page);
  await B.page.waitForTimeout(2700);
  const sB = await wv(B.page);
  check(sB.loads.length === 0,
    'dom-ready 不来时绝不强行 loadURL（旧兜底会抛错白屏）', 'loads=' + sB.loads.length);
  check((await status(B.page)).includes('网页容器未就绪'),
    'dom-ready 不来时给出诊断提示', await status(B.page));
  /* flash 默认 2.6s 会清掉，一闪而过等于没提示 —— 这条必须验常驻 */
  await B.page.waitForTimeout(2800);
  check((await status(B.page)).includes('网页容器未就绪'),
    '诊断提示常驻而不是一闪而过', await status(B.page));

  /* 自动适应：用户没碰过缩放时，did-stop-loading 后按内容宽自动缩（不需要手点）。
     桩的 guest 没真加载，但 executeJavaScript 度量可调，逻辑链照走。 */
  await B.page.evaluate(() => { window.__wv.pageMetrics = { iw: 1138, sw: 1280 }; });
  await fire(B.page, 'did-stop-loading', {});
  await B.page.waitForTimeout(950);
  const bZooms = (await wv(B.page)).zooms;
  check(bZooms.length === 1 && Math.abs(bZooms[0] - 0.89) < 0.02,
    '未手动调过时 did-stop-loading 自动缩到 89%', JSON.stringify(bZooms));
  check(B.errors.length === 0, '页面 B 全程无 pageerror', B.errors.join(' | ').slice(0, 160));

  await browser.close();
  console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 全部通过（' + (fails === 0 ? 'webview 路径' : '') + '）');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(2);
});
