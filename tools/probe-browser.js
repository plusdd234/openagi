/* 探针：浏览器 App（内嵌网页）是否真的能从桌面点进去、并在窗口内部完成导航
 * 用法：node tools/probe-browser.js
 *
 * 覆盖的关键点：
 *   ① 桌面有「浏览器」图标，点进去是起始页而不是空白；
 *   ② 起始页常用入口能把本地示例页加载进 iframe（离线可复现）；
 *   ③ 后退 / 前进 / 刷新 / 回起始页；
 *   ④ javascript: 地址被拦截，不会在父页面上下文里执行；
 *   ⑤ 非网址输入按搜索词处理；
 *   ⑥ 切回桌面再打开，当前网页还在（mount 幂等）；
 *   ⑦ 全程无 pageerror。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const addr = (page) => page.inputValue('#browserWin .bw-input');
const frameSrc = (page) => page.evaluate(() => {
  const f = document.querySelector('#browserWin .bw-frame');
  return f ? f.src : '';
});
const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.classList.contains('hidden') && cs.display !== 'none' &&
    cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
}, sel);

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  let dialogs = 0;
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1100);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="browser"]')),
    '桌面上的「浏览器」图标存在');

  await page.evaluate(() => window.openDeskApp('browser'));
  await page.waitForTimeout(1500);

  check(await visible(page, '#browserWin'), '浏览器窗口已翻到前台');
  check(await visible(page, '#browserWin .bw-app'), 'App 外壳已渲染');
  check(await page.evaluate(() => {
    const f = document.querySelector('#browserWin .bw-frame');
    return !!f && f.tagName.toLowerCase() === 'iframe';
  }), '普通浏览器环境回退到 iframe 容器');

  /* iframe 没有 setZoomFactor，缩放控件必须整组隐藏，不能摆一排点了没反应的按钮。
     反证：补上 is-web 标记后控件要立刻出现 —— 证明是 CSS 在门控、不是元素压根没渲染。 */
  check(await page.evaluate(() => {
    const z = document.querySelector('#browserWin .bw-zoom');
    return !!z && getComputedStyle(z).display === 'none' &&
      !document.querySelector('#browserWin .bw-app').classList.contains('is-web');
  }), 'iframe 模式隐藏缩放控件且不打 is-web 标记');
  await page.evaluate(() => document.querySelector('#browserWin .bw-app').classList.add('is-web'));
  check(await page.evaluate(() =>
    getComputedStyle(document.querySelector('#browserWin .bw-zoom')).display !== 'none'),
    '反证：补上 is-web 后缩放控件立刻出现（规则真在门控）');
  await page.evaluate(() => document.querySelector('#browserWin .bw-app').classList.remove('is-web'));

  check(await visible(page, '#browserWin .bw-start'), '首次打开停在起始页');
  check(!(await visible(page, '#browserWin .bw-frame')), '起始页状态下 iframe 是收起的');
  check(await page.evaluate(() => {
    const b = document.querySelector('#browserWin [data-act="back"]');
    const f = document.querySelector('#browserWin [data-act="forward"]');
    return !!b && !!f && b.disabled && f.disabled;
  }), '起始页时后退/前进都不可点');
  const links = await page.evaluate(() => document.querySelectorAll('#browserWin .bw-link').length);
  check(links >= 6, '起始页常用入口已铺开', links + ' 个');

  /* 1. 常用入口 → 本地示例页（不走网络，保证可复现） */
  await page.evaluate(() => {
    const link = [...document.querySelectorAll('#browserWin .bw-link')]
      .find((b) => (b.getAttribute('data-url') || '').includes('demo.html'));
    if (link) link.click();
  });
  await page.waitForTimeout(900);

  const a1 = await addr(page);
  const s1 = await frameSrc(page);
  check(a1.includes('apps/browser/demo.html'), '地址栏显示本地示例页地址', a1);
  check(s1.includes('apps/browser/demo.html'), 'iframe 指向本地示例页', s1);
  check(await visible(page, '#browserWin .bw-frame'), 'iframe 已显示');
  check(!(await visible(page, '#browserWin .bw-start')), '起始页已让位');

  const demoFrame = page.frames().find((f) => f.url().includes('demo.html'));
  check(!!demoFrame, '页面帧已创建');
  if (demoFrame) {
    const txt = await demoFrame.evaluate(() => document.body.innerText);
    check(txt.includes('本地示例页'), 'iframe 内确实渲染了示例页内容', txt.slice(0, 22).replace(/\n/g, ' '));
  }
  check(await page.evaluate(() => !document.querySelector('#browserWin .bw-app').classList.contains('is-loading')),
    '加载结束后进度线已停');

  /* 1b. iframe 白屏判定分两档（file:// 父页面 origin 是 opaque，跨域 iframe 的
     contentDocument 一律为 null —— 正常站也读不到，不能据此断言「禁止被内嵌」）：
       ① 可确定是空白页（contentDocument 可读 + body 空）→ 明确诊断；
       ② 读不到内容 → 只给条件式出口「若此页空白…」。
     用 about:blank 离线复现 ②，用可配置的假 contentDocument 复现 ①。 */
  const bwStatus = () => page.evaluate(() =>
    document.querySelector('#browserWin .bw-status-msg').textContent || '');
  await page.waitForTimeout(1900);
  check(!(await bwStatus()).includes('在系统浏览器打开'),
    '正常页面不会误报白屏提示', await bwStatus());

  await page.fill('#browserWin .bw-input', 'about:blank');
  await page.press('#browserWin .bw-input', 'Enter');
  await page.waitForTimeout(2000);
  check((await bwStatus()).includes('在系统浏览器打开'),
    '内容读不到时给出兜底出口提示', await bwStatus());
  check(!(await bwStatus()).includes('禁止被内嵌'),
    '读不到内容时绝不武断断言「禁止被内嵌」', await bwStatus());

  /* 档 ①：把 contentDocument 换成「同源可访问且 body 空」的空白错误页形态。
     点刷新不会动历史栈，后面的前进/后退断言仍在同一条线上。 */
  await page.evaluate(() => {
    const f = document.querySelector('#browserWin .bw-frame');
    Object.defineProperty(f, 'contentDocument', {
      configurable: true,
      get: () => ({ body: { innerText: '', children: [] } })
    });
  });
  await page.evaluate(() => document.querySelector('#browserWin [data-act="reload"]').click());
  await page.waitForTimeout(2000);
  check((await bwStatus()).includes('禁止被内嵌'),
    '可确定的空白页给出明确诊断', await bwStatus());
  await page.evaluate(() => {
    const f = document.querySelector('#browserWin .bw-frame');
    delete f.contentDocument;   // 撤掉桩，回退到原型 getter
  });

  /* 退回示例页：后面的刷新 / 前进后退仍在同一条历史线上 */
  await page.evaluate(() => document.querySelector('#browserWin [data-act="back"]').click());
  await page.waitForTimeout(600);
  check((await addr(page)).includes('demo.html'), '白屏测试后回到示例页');
  check(!(await bwStatus()).includes('禁止被内嵌'), '回到正常页后提示被清掉');

  /* 2. 刷新：地址不变，页面重新加载 */
  await page.evaluate(() => document.querySelector('#browserWin [data-act="reload"]').click());
  await page.waitForTimeout(700);
  check((await addr(page)).includes('demo.html'), '刷新后地址保持');
  check(await page.evaluate(() => {
    const f = document.querySelector('#browserWin .bw-frame');
    return !!f && !f.classList.contains('hidden');
  }), '刷新后 iframe 仍在');

  /* 3. 「在系统浏览器打开」拿到的是当前地址（把 window.open 换成桩，避免真的弹窗） */
  await page.evaluate(() => {
    window.__bwOpened = null;
    window.open = (u) => { window.__bwOpened = u; return null; };
  });
  await page.evaluate(() => document.querySelector('#browserWin [data-act="external"]').click());
  check(await page.evaluate(() => String(window.__bwOpened || '').includes('demo.html')),
    '系统浏览器入口拿到了当前地址', await page.evaluate(() => String(window.__bwOpened || '')));

  /* 4. 后退 / 前进走的是 App 自己的 URL 栈 */
  await page.evaluate(() => document.querySelector('#browserWin [data-act="back"]').click());
  await page.waitForTimeout(500);
  check(await visible(page, '#browserWin .bw-start'), '后退回起始页');
  check((await addr(page)) === '', '后退后地址栏清空');

  await page.evaluate(() => document.querySelector('#browserWin [data-act="forward"]').click());
  await page.waitForTimeout(700);
  check((await addr(page)).includes('demo.html'), '前进回到示例页');

  /* 5. 切回桌面再打开：当前网页必须还在（mount 不能重建 DOM） */
  await page.evaluate(() => window.deskAppLeave());
  await page.waitForTimeout(450);
  await page.evaluate(() => window.openDeskApp('browser'));
  await page.waitForTimeout(1100);
  check((await addr(page)).includes('demo.html'), '重新打开后地址栏还在示例页');
  check(await visible(page, '#browserWin .bw-frame'), '重新打开后网页没有被重置回起始页');

  /* 6. javascript: 必须拦掉（否则会在父页面上下文里执行） */
  await page.fill('#browserWin .bw-input', 'javascript:alert(1)');
  await page.press('#browserWin .bw-input', 'Enter');
  await page.waitForTimeout(350);
  check((await addr(page)).includes('demo.html'), 'javascript: 地址被退回当前页', await addr(page));
  check(await page.evaluate(() => (document.querySelector('#browserWin .bw-status-msg').textContent || '').includes('拦截')),
    '状态栏提示已拦截');
  check(await page.evaluate(() => !window.__bwAlert) && dialogs === 0, '没有执行 javascript: 里的脚本');

  /* 7. 非网址输入 → 搜索地址 */
  await page.fill('#browserWin .bw-input', 'openai 教程');
  await page.press('#browserWin .bw-input', 'Enter');
  await page.waitForTimeout(600);
  const a2 = await addr(page);
  check(/^https:\/\/www\.bing\.com\/search\?q=/.test(a2), '搜索词拼成必应搜索地址', a2);
  check(a2.includes(encodeURIComponent('openai 教程')), '搜索词已正确编码', a2);

  /* 8. 回起始页 + 关闭窗口 */
  await page.evaluate(() => document.querySelector('#browserWin [data-act="home"]').click());
  await page.waitForTimeout(350);
  check(await visible(page, '#browserWin .bw-start'), '主页按钮回到起始页');
  check((await addr(page)) === '', '回起始页后地址栏为空');

  await page.evaluate(() => document.querySelector('#btnBrowserWinClose').click());
  await page.waitForTimeout(500);
  check(!(await visible(page, '#browserWin')), '关闭按钮能把窗口收回去');

  check(errors.length === 0, '全程无 pageerror', errors.join(' | ').slice(0, 160));
  console.log(fails ? ('\n❌ ' + fails + ' 项未通过') : '\n✅ 全部通过');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
