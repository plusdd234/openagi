/* 探针：真实项目 Electron 实例（electron/main.js + app://openagi/index.html）
 * 用法：node tools/probe-browser-real.js [--tripo]
 *
 * 为什么必须有这一份：
 *   probe-browser-guest.js 起的是「临时最小 Electron 工程 + 复制过来的 app.js」，
 *   probe-browser-webview.js 是 DOM 桩。两者都验不到真实主进程链路：
 *     · 页面 origin 是 app://openagi 还是 file://
 *     · 主进程的 webviewTag / will-attach-webview 护栏是否真的生效
 *     · 页面实际执行的 apps/manifest.js 是不是最新那份
 *       （内容包 / 旧进程没重启 / 改了 app.js 忘重生成，都会让页面跑旧代码）
 *   2026-11-13 实测：临时工程探针全绿，用户手上的实例从昨晚 21:06 起一直跑旧 manifest，
 *   boot.log 里连着 5 条 -27 ERR_BLOCKED_BY_RESPONSE —— 产品里照样白屏。
 *
 * 本探针起一个干净的真实项目实例（独立 userData 避开单实例锁），验：
 *   ① 页面跑在 app://openagi，<webview> 自定义元素已升级
 *   ② 页面实际加载的 manifest 带 src="about:blank"（旧包立即判红）
 *   ③ 打开浏览器 App 后容器是 WEBVIEW 而不是 IFRAME
 *   ④ guest 是独立 webContents，URL / DOM 内容到位，状态栏无报错
 *
 * --tripo：用真实 Tripo 地址做决定性验证（依赖外网 / Cloudflare，不作默认门禁）
 */
const fs = require('fs');
const { createRun } = require('./probe-run');
const RUN = createRun('probe-browser-real');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-real-'));
const tripoMode = process.argv.includes('--tripo');
const shotMode = process.argv.includes('--shot');
const wideMode = process.argv.includes('--wide');   /* 对照：把主窗口拉宽再测，验证「站点最小宽度」假设 */
const noFitMode = process.argv.includes('--nofit'); /* 反证：屏蔽 setZoomFactor，预期「无横向溢出」判红 */
const TARGET = tripoMode
  ? 'https://studio.tripo3d.ai/zh/workspace/generate-image'
  : 'data:text/html,<h1>real-guest-ok</h1>';

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 会把 Electron 降成纯 Node
  delete env.OPENAGI_SMOKE;          // 冒烟模式 1.2s 后自动退出

  let app = null;
  try {
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [ROOT, '--user-data-dir=' + USERDATA, '--no-sandbox'],
      env: env,
      timeout: 60000
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message)));
    await page.waitForLoadState('load');
    await page.waitForTimeout(1800);

    check(/^app:\/\/openagi\//.test(page.url()),
      '页面跑在 app://openagi（真实主进程链路）', page.url());

    const up = await page.evaluate(() => {
      const w = document.createElement('webview');
      return { tag: w.tagName, hasLoadURL: typeof w.loadURL === 'function', ready: document.readyState };
    });
    check(up.hasLoadURL && up.tag === 'WEBVIEW',
      '<webview> 自定义元素已升级（不是未升级的 HTMLElement）', JSON.stringify(up));

    /* 关键守卫：页面 fetch 到的是它真正执行的那份 manifest。
       改了 app.js 没重跑 app-scan、或者进程没重启跑旧包，这条立刻红。 */
    const mf = await page.evaluate(async () => {
      try {
        const r = await fetch('apps/manifest.js');
        const t = await r.text();
        return {
          len: t.length,
          blank: t.indexOf("setAttribute('src', 'about:blank')") >= 0,
          fit: t.indexOf('setZoomFactor') >= 0 && t.indexOf('fitWidth') >= 0
        };
      } catch (e) { return { err: String(e && e.message) }; }
    });
    check(!!mf.blank,
      '页面实际执行的 manifest 带 src="about:blank"（旧包 / 未重生成会红）', JSON.stringify(mf));
    check(!!mf.fit,
      '页面实际执行的 manifest 带缩放适配（旧进程没重启 / 忘重生成会红）', JSON.stringify(mf));

    await page.evaluate(() => window.openDeskApp('browser'));
    await page.waitForTimeout(1200);
    if (wideMode){
      await app.evaluate((electron) => {
        const w = electron.BrowserWindow.getAllWindows()[0];
        if (w) w.setSize(1500, 950);
      });
      await page.waitForTimeout(1000);
      console.log('   🔍 对照模式：主窗口已拉宽到 1500×950');
    }
    const fr = await page.evaluate(() => {
      const f = document.querySelector('#browserWin .bw-frame');
      return f ? { tag: f.tagName, src: f.getAttribute('src') } : null;
    });
    check(!!fr && fr.tag === 'WEBVIEW',
      '浏览器 App 容器是 WEBVIEW（不是 iframe 回退）', JSON.stringify(fr));
    check(!!fr && fr.src === 'about:blank',
      'webview 带初始 src="about:blank"', fr && fr.src);

    if (noFitMode){
      await page.evaluate(() => {
        const f = document.querySelector('#browserWin .bw-frame');
        if (f) f.setZoomFactor = function(){};   /* 只屏蔽缩放，其余照跑 */
      });
      console.log('   🧪 反证模式：setZoomFactor 已屏蔽（预期「无横向溢出」判红）');
    }

    await page.fill('#browserWin .bw-input', TARGET);
    await page.press('#browserWin .bw-input', 'Enter');
    await page.waitForTimeout(tripoMode ? 11000 : 2600);

    const st = await page.evaluate(() => ({
      addr: (document.querySelector('#browserWin .bw-input') || {}).value || '',
      msg: (document.querySelector('#browserWin .bw-status-msg') || {}).textContent || ''
    }));
    check(!/未就绪|加载失败|网页加载失败/.test(st.msg),
      '状态栏没有「未就绪 / 加载失败」', st.msg);
    check(st.addr === TARGET, '地址栏停在目标地址', st.addr);

    /* 缩放自适应：Tripo 固定 1280 布局塞不进窄视口时应自动缩到 <100%；
       普通页面保持 100%，不能见谁都缩。 */
    const zv = await page.evaluate(() =>
      ((document.querySelector('#browserWin .bw-zoom-val') || {}).textContent || '').trim());
    if (tripoMode){
      check(/^\d+%$/.test(zv) && zv !== '100%',
        '自动适应把缩放调到 <100%（宽站点塞进窄视口）', zv);
    } else {
      check(zv === '100%', '普通页面保持 100% 不误缩', zv);
    }

    /* ⚠ guest 有内容 ≠ 用户眼前看得见。吃过「探针全绿但产品白屏」的亏：
       is-off 没摘 / 尺寸被压成 0 / 被别的窗口层盖住，guest DOM 照样完整。
       这几条把判据从「guest 拿到了页面」抬到「屏幕上真有东西」。 */
    const vis = await page.evaluate(() => {
      const f = document.querySelector('#browserWin .bw-frame');
      if (!f) return { found: false };
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      let hit = 'null';
      try {
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hit = el ? ((el === f || f.contains(el)) ? 'self' : (el.tagName + '.' + (el.className || ''))) : 'null';
      } catch (e) { hit = 'err:' + (e && e.message); }
      const pr = f.parentElement ? f.parentElement.getBoundingClientRect() : null;
      const winEl = document.getElementById('browserWin');
      const wr = winEl ? winEl.getBoundingClientRect() : null;
      return {
        found: true,
        off: f.classList.contains('is-off'),
        hidden: f.classList.contains('hidden'),
        visibility: cs.visibility, display: cs.display, opacity: cs.opacity,
        w: Math.round(r.width), h: Math.round(r.height), hit: hit,
        viewW: pr ? Math.round(pr.width) : null,
        winW: wr ? Math.round(wr.width) : null,
        overflowRight: pr ? Math.round(r.right - pr.right) : null,
        overflowBottom: pr ? Math.round(r.bottom - pr.bottom) : null
      };
    });
    check(vis.found && !vis.off && !vis.hidden && vis.visibility !== 'hidden' && vis.display !== 'none',
      '容器在用户眼前可见（is-off / hidden / visibility / display）', JSON.stringify(vis));
    check(vis.w > 100 && vis.h > 100,
      '容器尺寸非 0（没被压成 0×0 白屏）', vis.w + '×' + vis.h);
    check(vis.hit === 'self',
      '容器中心点命中自身（没被别的层盖住）', vis.hit);
    /* 「右侧被裁切」量化：webview 右边界超出 .bw-view 多少 px */
    check(vis.overflowRight !== null && Math.abs(vis.overflowRight) <= 2 && Math.abs(vis.overflowBottom) <= 2,
      'webview 零裁切地铺满视口（右/下不溢出）',
      'right=' + vis.overflowRight + ' bottom=' + vis.overflowBottom +
      ' frameW=' + vis.w + ' viewW=' + vis.viewW + ' winW=' + vis.winW);

    if (shotMode && vis.found){
      const clip = await page.evaluate(() => {
        const r = document.querySelector('#browserWin .bw-frame').getBoundingClientRect();
        return { x: Math.max(0, r.left), y: Math.max(0, r.top),
                 width: Math.max(1, r.width), height: Math.max(1, r.height) };
      });
      try {
        const shot = await RUN.shot(page, 'browser-real.png', { clip: clip });
        if (shot) console.log('   📷 截图：' + shot);
      } catch (e) { console.log('   ⚠ 截图失败：' + (e && e.message)); }
    }

    /* app.evaluate 的第一个参数是 Electron 模块本身（不是 require 可用上下文） */
    const guests = await app.evaluate(async (electron) => {
      const { webContents } = electron;
      const out = [];
      for (const wc of webContents.getAllWebContents()) {
        let dom = null;
        try {
          dom = await wc.executeJavaScript(
            '({title:document.title,' +
            'len:document.documentElement.outerHTML.length,' +
            'text:(document.body?document.body.innerText:"").slice(0,80),' +
            'iw:window.innerWidth,cw:document.documentElement.clientWidth,' +
            'sw:document.documentElement.scrollWidth,dpr:window.devicePixelRatio,' +
            'bodyOv:getComputedStyle(document.body).overflowX})'
          );
        } catch (e) { dom = { err: String(e && e.message) }; }
        out.push({ id: wc.id, type: wc.getType(), url: wc.getURL(), dom: dom });
      }
      return out;
    });
    const guest = guests.find(g => g.type === 'webview');
    check(!!guest, 'guest 是独立 webContents（已创建）',
      JSON.stringify(guests.map(g => ({ type: g.type, url: g.url }))));
    if (guest) {
      check(guest.url === TARGET, 'guest 停在目标地址', guest.url);
      if (tripoMode) {
        check(!!guest.dom && guest.dom.len > 10000,
          'guest 拿到完整 Tripo 页面（不是白屏）',
          JSON.stringify(guest.dom && { title: guest.dom.title, len: guest.dom.len }));
      } else {
        check(!!guest.dom && /real-guest-ok/.test(guest.dom.text || ''),
          'guest 有真实内容（不是白屏）', JSON.stringify(guest.dom));
      }
      /* guest 视口诊断：innerWidth 明显小于容器宽 = DPI/zoom 把页面放大后裁掉右侧；
         scrollWidth 明显大于 innerWidth = 站点自身横向溢出，右侧内容进不了可视区。 */
      if (guest.dom && guest.dom.iw) {
        const d = guest.dom;
        console.log('   📐 guest 视口 innerWidth=' + d.iw + ' clientWidth=' + d.cw +
                    ' scrollWidth=' + d.sw + ' dpr=' + d.dpr +
                    ' bodyOverflowX=' + d.bodyOv + ' · 容器宽=' + vis.w);
        check(d.iw >= vis.w - 4,
          'guest 视口宽 >= 容器宽（无 DPI/zoom 放大裁切）',
          'innerWidth=' + d.iw + ' frameW=' + vis.w);
        if (tripoMode){
          /* 决定性判据：页面内容不再比视口宽 = 右侧没被裁。
             --nofit 屏蔽缩放后这条必须红，否则等于没测。 */
          check(d.sw <= d.iw + 8,
            'Tripo 页面无横向溢出（右侧不再被裁）',
            'scrollWidth=' + d.sw + ' innerWidth=' + d.iw);
        }
      }
    }
    check(errors.length === 0, '主窗口无 pageerror', errors.join(' | ').slice(0, 160));
  } finally {
    if (app) { try { await app.close(); } catch (e) {} }
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (e) {}
  }
  RUN.finish(fails ? ['失败 ' + fails + ' 项'] : []);
  console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 全部通过（真实项目实例）');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', (e && e.stack) || e);
  process.exit(2);
});
