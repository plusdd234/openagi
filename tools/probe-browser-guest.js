/* 探针：真实 Electron <webview> guest（不是 DOM 桩）
 * 用法：node tools/probe-browser-guest.js
 *
 * 为什么必须有这一份：probe-browser-webview.js 用 addInitScript 装了个 HTMLUnknownElement 桩，
 * 补上 loadURL 就敢断言「webview 路径没问题」。但真实 Electron 里 <webview> 没 src 时
 * 不创建 guest、不发 dom-ready，loadURL 会抛 "The WebView must be attached to the DOM and
 * the dom-ready event emitted" —— 桩不会抛，于是 25 条全绿、产品里整块白屏（2026-11-13）。
 *
 * 本探针起真实 Electron 进程，加载**项目真实的 apps/browser/app.js + app.css**，验：
 *   ① mount 后容器是 webview，且带 src="about:blank"
 *   ② dom-ready 真的发生（导航不再排队）
 *   ③ guest 是独立 webContents，URL 与 DOM 内容都到位（不是空白）
 *   ④ 状态栏没有「未就绪 / 加载失败」
 *   ⑤ 全程无 pageerror
 *
 * 内建反证（关键）：把 app.js 里 `wv.setAttribute('src', 'about:blank');` 删掉再跑一遍，
 * 必须复现白屏 —— 没有 guest、状态栏出现「网页容器未就绪」。
 * 若这条变异也报绿，说明探针根本没验到内核，等于没写。
 *
 * ⚠ 环境变量 ELECTRON_RUN_AS_NODE=1 会把 Electron 降成纯 Node（require('electron') 找不到、
 *   Process failed to launch!），launch 前必须从 env 里删掉。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
/* --tripo：用真实站点做一次性决定性验证（依赖外网 / Cloudflare，不作为默认回归门禁） */
const tripoMode = process.argv.includes('--tripo');
const TARGET = tripoMode
  ? 'https://studio.tripo3d.ai/zh/workspace/generate-image'
  : 'data:text/html,<h1>guest-ok</h1>';
const MUTATION = "wv.setAttribute('src', 'about:blank');";

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css">
<style>html,body{margin:0;width:100%;height:100%}#host{width:100vw;height:100vh}</style>
</head><body>
<div id="host"></div>
<script>
window.__probe = { registered:false, mounted:false, frameTag:'', src:'', events:[], errors:[] };
window.addEventListener('error', e => window.__probe.errors.push(String(e.message)));
window.registerApp = function(spec){ window.__spec = spec; window.__probe.registered = true; };
const orig = document.createElement.bind(document);
document.createElement = function(tag, opts){
  const el = orig(tag, opts);
  if(String(tag).toLowerCase() === 'webview'){
    ['dom-ready','did-navigate','did-navigate-in-page','did-fail-load'].forEach(function(ev){
      el.addEventListener(ev, function(e){
        window.__probe.events.push({ ev:ev, url:e.url||'', code:e.errorCode, desc:e.errorDescription||'' });
      });
    });
  }
  return el;
};
</script>
<script src="./app.js"></script>
<script>
/* ⚠ 必须等 load 之后再 mount：Electron 的 <webview> 是自定义元素，
   页面同步脚本阶段 createElement('webview') 返回的是未升级的 HTMLElement
   （没有 loadURL），makeFrame() 会误判成普通浏览器而回退 iframe。
   产品里 mount 由用户点击触发（页面早已 load 完），探针要对齐这个时序。 */
window.addEventListener('load', function(){
  var host = document.getElementById('host');
  host.className = 'os-win browser';
  var body = document.createElement('div');
  body.className = 'os-win-body';
  host.appendChild(body);
  window.__spec.mount(body);
  var f = body.querySelector('.bw-frame');
  window.__probe.frameTag = f.tagName;
  window.__probe.src = f.getAttribute('src') || '';
  window.__probe.mounted = true;
});
</script>
</body></html>`;

const MAIN_JS = `const { app, BrowserWindow } = require('electron');
const path = require('path');
app.setPath('userData', path.join(__dirname, 'userdata'));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
  win.loadFile(path.join(__dirname, 'page.html'));
});`;

function makeTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-wv-' + tag + '-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'openagi-wv-' + tag, main: 'main.js' }));
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN_JS);
  fs.writeFileSync(path.join(dir, 'page.html'), PAGE_HTML);
  fs.copyFileSync(path.join(ROOT, 'apps', 'browser', 'app.css'), path.join(dir, 'app.css'));
  let src = fs.readFileSync(path.join(ROOT, 'apps', 'browser', 'app.js'), 'utf8');
  if (tag === 'mutant') {
    const hits = src.split(MUTATION).length - 1;
    if (hits !== 1) throw new Error('变异注入失败：期望命中 1 处 src=about:blank，实际 ' + hits + ' 处');
    console.log('  [反证] 注入生效：删除 src=about:blank（命中 ' + hits + ' 处）');
    src = src.replace(MUTATION, '');
  }
  fs.writeFileSync(path.join(dir, 'app.js'), src);
  return dir;
}

async function run(tag) {
  const dir = makeTmp(tag);
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [dir, '--no-sandbox'],
      env: env,
      timeout: 40000
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__probe && window.__probe.mounted, null, { timeout: 15000 });

    const before = await page.evaluate(() => ({
      registered: window.__probe.registered,
      frameTag: window.__probe.frameTag,
      src: window.__probe.src
    }));

    await page.evaluate((url) => {
      const inp = document.querySelector('.bw-input');
      inp.value = url;
      document.querySelector('.bw-addr').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true })
      );
    }, TARGET);

    /* 给足 dom-ready + guest 导航 + 诊断计时（2500ms）的时间；
       真实站点还要留 Cloudflare 验证与首屏渲染的余量 */
    await page.waitForTimeout(tripoMode ? 11000 : 4200);

    const after = await page.evaluate(() => ({
      events: window.__probe.events,
      status: document.querySelector('.bw-status-msg').textContent || '',
      errors: window.__probe.errors,
      frameClass: document.querySelector('.bw-frame').className
    }));

    const guests = await app.evaluate(async ({ webContents }) => {
      const out = [];
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getType() !== 'webview') continue;
        let text = '', htmlLen = 0;
        try { htmlLen = await wc.executeJavaScript('document.documentElement ? document.documentElement.outerHTML.length : 0'); }
        catch (e) { htmlLen = -1; }
        try { text = await wc.executeJavaScript('document.body ? document.body.innerText.slice(0,200) : ""'); }
        catch (e) { text = 'ERR ' + e.message; }
        out.push({ url: wc.getURL(), title: wc.getTitle(), htmlLen: htmlLen, text: text });
      }
      return out;
    });

    return { before, after, guests };
  } finally {
    if (app) { try { await app.close(); } catch (e) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error('❌ 找不到 Electron：' + ELECTRON);
    process.exit(2);
  }

  console.log(tripoMode ? '=== 真实站点验证：Tripo 生图页 ===' : '=== 正常态（项目真实 app.js）===');
  const ok = await run('normal');
  check(ok.before.registered, 'registerApp 被调用、App 已 mount');
  check(ok.before.frameTag === 'WEBVIEW', '容器是真实 Electron webview', ok.before.frameTag);
  check(ok.before.src === 'about:blank', 'webview 带 src="about:blank"', ok.before.src);
  check(ok.after.events.some(e => e.ev === 'dom-ready'), 'about:blank 触发了 dom-ready',
    JSON.stringify(ok.after.events.map(e => e.ev)));
  check(ok.guests.length === 1, 'guest 是独立 webContents（已创建）', 'count=' + ok.guests.length);
  const g = ok.guests[0] || {};
  if (tripoMode) {
    check(/tripo3d\.ai/.test(String(g.url || '')), 'guest 停在 Tripo 地址', g.url);
    check((Number(g.htmlLen) || 0) > 10000, 'guest 拿到完整页面（不是白屏）', 'htmlLen=' + g.htmlLen);
    console.log('    guest: ' + JSON.stringify({
      title: g.title, htmlLen: g.htmlLen, text: String(g.text || '').slice(0, 200)
    }));
  } else {
    check(String(g.url || '').indexOf('data:text/html') === 0, 'guest 已导航到目标地址', g.url);
    check(String(g.text || '').includes('guest-ok'), 'guest 有真实内容（不是白屏）', g.text);
  }
  check(!/未就绪|加载失败/.test(ok.after.status), '状态栏没有未就绪 / 加载失败', ok.after.status);
  check(ok.after.errors.length === 0, '全程无 JS 错误', ok.after.errors.join(' | ').slice(0, 160));

  if (tripoMode) {
    console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 真实站点验证通过');
    process.exit(fails ? 1 : 0);
    return;
  }

  console.log('=== 变异反证：删掉 src="about:blank" 必须复现白屏 ===');
  const bad = await run('mutant');
  check(bad.guests.length === 0, '没有 src 时 guest 根本不创建（白屏）', 'count=' + bad.guests.length);
  check(!bad.after.events.some(e => e.ev === 'dom-ready'), '没有 src 时 dom-ready 永不触发',
    JSON.stringify(bad.after.events.map(e => e.ev)));
  check(/网页容器未就绪/.test(bad.after.status), '给出诊断提示而不是无声白屏', bad.after.status);
  check(bad.after.errors.length === 0, '变异态也全程无 JS 错误', bad.after.errors.join(' | ').slice(0, 160));

  console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 全部通过（真实 Electron guest + 变异反证）');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(2);
});
