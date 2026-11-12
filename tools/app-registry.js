/* 体检：App 注册表（registerApp + apps/ 目录 + 自动生成的清单）
 * 用法：node tools/app-registry.js
 *
 * 这套东西存在的理由只有一个：让「加一个 App」不再碰共享文件，
 * 于是多个 AI 能并行各写一个 App 而不互相踩。所以断言的重点不是界面好不好看，
 * 而是**它有没有真的把三处手改都消掉**，以及**重复打开会不会把用户状态冲掉**。
 *
 * 关键断言是第 4 节：切走再切回，DOM 节点必须是同一个对象。
 * openDeskApp 每次都会调 open() → mount()，如果 mount 重建了 innerHTML，
 * 节点对象就变了（用户的输入、滚动位置全没）。这一条只有比较对象身份才验得出来。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + String(extra).slice(0, 160) : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const errors = [];
  /* 本地服务（8787 中转 / 8794 桥 / 8791 网关）没起时，页面探活会是 ERR_CONNECTION_REFUSED。
   * 那是「探到了没人应答」这个**正常结果**，不是 JS 异常 —— 而且浏览器直开 file:// 就是常态。
   * 只放行这一个 code：真·缺文件会是 ERR_FILE_NOT_FOUND，真·JS 异常走 pageerror，一个都跑不掉。 */
  const isProbeNoise = t => /net::ERR_CONNECTION_REFUSED/.test(t);
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));
  page.on('console', m => { if (m.type() === 'error' && !isProbeNoise(m.text())) errors.push('console: ' + m.text()); });

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  console.log('\n=== 1. 注册：一个目录 → 三张表 + 图标 + 窗口，全自动 ===');
  const s1 = await page.evaluate(() => {
    const win = document.getElementById('helloWin');
    return {
      registered: typeof registerApp === 'function',
      inApps: DESK_APPS.some(a => a.id === 'hello'),
      meta: DESK_APP_META.hello || null,
      icon: !!document.querySelector('.desk-app[data-app="hello"]'),
      iconLabel: (document.querySelector('.desk-app[data-app="hello"] .desk-app-label') || {}).textContent || '',
      winExists: !!win,
      winParent: win ? win.parentElement.id : null,
      winHidden: win ? win.classList.contains('hidden') : null,
      body: win ? !!win.querySelector('.os-win-body') : null,
      close: win ? !!win.querySelector('.os-win-close') : null,
      /* index.html 里不该出现这个 App 的任何痕迹 */
      inHtmlSource: null
    };
  });
  check(s1.registered === true, 'registerApp 已定义');
  check(s1.inApps === true, 'DESK_APPS 里有 hello（不用手改 desk-shell.js）');
  check(!!(s1.meta && s1.meta.win === 'helloWin' && s1.meta.title), 'DESK_APP_META 自动写入', JSON.stringify(s1.meta));
  check(s1.icon === true, '桌面出现图标');
  check(s1.iconLabel === '你好', '图标文字取声明里的 name', s1.iconLabel);
  check(s1.winExists === true && s1.winParent === 'deskWall', '窗口自动生成并挂在 deskWall（不用手写 os-win）', s1.winParent);
  check(s1.winHidden === true, '生成的窗口初始是隐藏的');
  check(s1.body === true && s1.close === true, '窗口结构齐全（body + 关闭按钮）');

  const inHtml = require('fs').readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  check(!/helloWin|apps\/hello/.test(inHtml), 'index.html 里没有这个 App 的任何代码（窗口块外置成功）');

  console.log('\n=== 2. 打开：翻页 / 交接 / 骨架 / 按需注入 ===');
  await page.evaluate(() => openDeskApp('hello'));
  await page.waitForTimeout(1200);
  const s2 = await page.evaluate(() => {
    const w = document.getElementById('helloWin');
    const r = w.getBoundingClientRect();
    const host = document.getElementById('deskAppHost').getBoundingClientRect();
    return {
      appOpen: document.getElementById('deskWall').classList.contains('app-open'),
      inHost: w.parentElement.id,
      visible: !w.classList.contains('hidden'),
      skelDone: !w.classList.contains('app-loading') && document.getElementById('deskAppSkel').hidden,
      painted: !!w.querySelector('.hello-wrap'),
      css: [...document.querySelectorAll('link[rel=stylesheet]')].some(l => l.href.indexOf('apps/hello/app.css') >= 0),
      /* 铺满：窗口尺寸应当接近 host（差 1px 容差） */
      fills: Math.abs(r.width - host.width) < 2 && Math.abs(r.height - host.height) < 2,
      box: [Math.round(r.width), Math.round(r.height)],
      hostBox: [Math.round(host.width), Math.round(host.height)],
      tabs: [...document.querySelectorAll('#appbarTabs .abt')].map(b => b.dataset.win + (b.classList.contains('on') ? '*' : ''))
    };
  });
  check(s2.appOpen === true, '整页翻到 App 页');
  check(s2.inHost === 'deskAppHost', '窗口被搬进 App 页 host');
  check(s2.visible === true, '窗口可见');
  check(s2.painted === true, '内容已画出');
  check(s2.skelDone === true, '骨架已撤（等的是 mount 的 promise，不是固定秒数）');
  check(s2.css === true, 'app.css 按需注入成功');
  check(s2.fills === true, '窗口铺满画布（没有缩成小卡片）', JSON.stringify([s2.box, s2.hostBox]));
  check(s2.tabs.length === 1 && s2.tabs[0] === 'helloWin*', '顶栏出现标签并高亮', JSON.stringify(s2.tabs));

  console.log('\n=== 3. 交互：能力真的接上了 ===');
  await page.fill('#helloWin .hello-in', 'abc\ndef');
  await sleep(150);
  const s3 = await page.evaluate(() => ({
    out: (document.querySelector('#helloWin .hello-out') || {}).textContent || '',
    meta: (document.querySelector('#helloWin .hello-meta') || {}).textContent || ''
  }));
  check(s3.out === 'fed\ncba', '输出区拿到反转结果', JSON.stringify(s3.out));
  check(/7 字/.test(s3.meta) && /2 行/.test(s3.meta), '统计正确（7 字 / 2 行）', s3.meta);

  console.log('\n=== 4. 幂等：切走再切回，DOM 必须是同一个对象 ===');
  await page.evaluate(() => { window.__hw = document.querySelector('#helloWin .hello-wrap'); });
  await page.evaluate(() => document.getElementById('btnDeskHome').click());
  await sleep(600);
  await page.evaluate(() => openDeskApp('hello'));
  await page.waitForTimeout(900);
  const s4 = await page.evaluate(() => {
    const w = document.querySelector('#helloWin .hello-wrap');
    return {
      sameNode: w === window.__hw,
      value: (document.querySelector('#helloWin .hello-in') || {}).value || '',
      restored: document.getElementById('helloWin').parentElement.id,
      cnt: (document.querySelector('#helloWin .hello-meta') || {}).textContent || ''
    };
  });
  check(s4.sameNode === true, '切回后是同一个 DOM 节点（mount 没有重建）');
  check(s4.value === 'abc\ndef', '用户输入还在（没被冲掉）', JSON.stringify(s4.value));
  check(s4.restored === 'deskAppHost', '窗口重新搬进 App 页');
  check(/打开 2 次/.test(s4.cnt), 'mount 确实又被调了一次（幂等 ≠ 不执行）', s4.cnt);

  console.log('\n=== 5. 关闭：× 划掉标签、翻回桌面、窗口回到原处 ===');
  await page.evaluate(() => document.querySelector('#helloWin .os-win-close').click());
  await sleep(700);
  const s5 = await page.evaluate(() => {
    const w = document.getElementById('helloWin');
    return {
      appOpen: document.getElementById('deskWall').classList.contains('app-open'),
      tabs: document.querySelectorAll('#appbarTabs .abt').length,
      parent: w.parentElement.id,
      hidden: w.classList.contains('hidden'),
      deskTab: (typeof deskTabs !== 'undefined' ? deskTabs.map(t => t.win) : [])
    };
  });
  check(s5.appOpen === false, '翻回桌面');
  check(s5.tabs === 0, '标签被划掉');
  check(s5.deskTab.indexOf('helloWin') < 0, '标签表里也移除了');
  check(s5.parent === 'deskWall' && s5.hidden === true, '窗口回到 deskWall 并隐藏（没有丢节点）', s5.parent);

  console.log('\n=== 6. 从桌面双击图标也能进 ===');
  await page.evaluate(() => document.querySelector('.desk-app[data-app="hello"]')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await page.waitForTimeout(900);
  const s6 = await page.evaluate(() => ({
    appOpen: document.getElementById('deskWall').classList.contains('app-open'),
    inHost: document.getElementById('helloWin').parentElement.id,
    value: (document.querySelector('#helloWin .hello-in') || {}).value || ''
  }));
  check(s6.appOpen === true && s6.inHost === 'deskAppHost', '双击图标进 App 页');
  check(s6.value === 'abc\ndef', '第三次打开后输入还在');

  console.log('\n=== 7. 防护：错用要拦在注册那一刻 ===');
  const s7 = await page.evaluate(() => {
    const out = { noId: null, dup: null, clash: null };
    /* 先记下「现在有几个」再故意注册错的：断言的是「没被污染」，不是「刚好等于某个数」。
     * 曾经写死 `=== 15`，于是**每加一个 App 都要改测试** —— 而加 App 正是这套机制的目的。 */
    out.before = DESK_APPS.length;
    try { registerApp({ name: 'x' }); } catch (e) { out.noId = String(e.message || e); }
    out.dup = registerApp({ id: 'hello', name: 'x' });
    out.clash = registerApp({ id: 'store', name: 'x' });
    return { noId: out.noId, dup: out.dup === null, clash: out.clash === null, before: out.before, apps: DESK_APPS.length };
  });
  check(/缺 id/.test(s7.noId || ''), '缺 id 直接抛错', s7.noId);
  check(s7.dup === true, '重复注册同一个 id 被拒（返回 null）');
  check(s7.clash === true, 'id 撞内置 App 被拒');
  check(s7.apps === s7.before, '被拒的注册没有污染 DESK_APPS', s7.apps + ' / ' + s7.before);

  console.log('\n=== 8. 清单与目录一致（并行开发时这条最容易失守） ===');
  let scanOut = '';
  let scanOk = true;
  try {
    scanOut = execSync('node tools/app-scan.js --check', { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  } catch (e) {
    scanOk = false;
    scanOut = String((e.stdout || '') + (e.stderr || '')).trim();
  }
  check(scanOk === true, 'apps/manifest.js 与 apps/ 同步', scanOut.slice(0, 120));

  console.log('\n=== 9. 页面零错误 ===');
  check(errors.length === 0, '全程没有 JS 报错', errors.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? '❌ ' + fails + ' 条未通过' : '✅ 全部通过'));
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
