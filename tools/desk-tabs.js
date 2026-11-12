/* 体检：顶栏 App 切换条（打开过的 App 各一个标签 / 点击切回 / 关闭标签 / Ctrl+Tab）
 * 用法：node tools/desk-tabs.js
 *
 * 关键断言是「切回去内容还在」——窗口节点被 deskAppRestore 搬回桌面层并隐藏，
 * 但模块状态没被销毁。所以切回来时卡片数量必须和第一次打开时一致。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + String(extra).slice(0, 160) : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const tabsState = () => page.evaluate(() => {
    const bar = document.getElementById('appbarTabs');
    const items = [...document.querySelectorAll('#appbarTabs .abt')];
    return {
      exists: !!bar,
      show: !!bar && getComputedStyle(bar).display !== 'none',
      names: items.map(b => (b.querySelector('.abt-name') || {}).textContent || ''),
      wins: items.map(b => b.dataset.win),
      active: items.filter(b => b.classList.contains('on')).map(b => b.dataset.win),
      appOpen: document.getElementById('deskWall').classList.contains('app-open'),
      table: (typeof deskTabs !== 'undefined' ? deskTabs.map(t => t.win) : null)
    };
  });

  console.log('\n=== 1. 桌面上不该有条子 ===');
  const s0 = await tabsState();
  check(s0.exists === true, '顶栏里有 #appbarTabs 容器');
  check(s0.show === false, '桌面（未打开 App）时整条隐藏');
  check(s0.names.length === 0, '没有标签残留');

  console.log('\n=== 2. 打开第一个 App ===');
  await page.evaluate(async () => { if (typeof openModelStore === 'function') await openModelStore(); });
  await page.waitForTimeout(900);
  const s1 = await tabsState();
  check(s1.show === true, '翻到 App 页后条子出现');
  check(s1.names.length === 1 && s1.names[0] === '模型商店', '出现「模型商店」一个标签', JSON.stringify(s1.names));
  check(s1.active[0] === 'storeWin', '当前 App 的标签是高亮态', JSON.stringify(s1.active));
  const cards1 = await page.evaluate(() => document.querySelectorAll('#mcStore .ms-card').length);
  check(cards1 >= 10, '模型商店渲染出卡片', cards1);

  console.log('\n=== 2b. 条子在红框那段空白里（左不压品牌、右不压资产/齿轮） ===');
  const geo = await page.evaluate(() => {
    const r = el => { const b = document.querySelector(el).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    return { tabs: r('#appbarTabs'), left: r('.appbar-left'), right: r('.appbar-right'), bar: r('.appbar') };
  });
  check(geo.tabs.l >= geo.left.r - 1, '左侧不压住品牌区', geo.tabs.l.toFixed(0) + ' >= ' + geo.left.r.toFixed(0));
  check(geo.tabs.r <= geo.right.l + 1, '右侧不压住「资产」与齿轮', geo.tabs.r.toFixed(0) + ' <= ' + geo.right.l.toFixed(0));
  check(geo.tabs.t >= geo.bar.t && geo.tabs.b <= geo.bar.b + 1, '垂直方向落在顶栏内');

  console.log('\n=== 3. 打开第二个 App → 两个标签 ===');
  await page.evaluate(async () => { if (typeof openLibrary === 'function') await openLibrary('image'); });
  await page.waitForTimeout(1200);
  const s2 = await tabsState();
  check(s2.names.length === 2, '两个标签', JSON.stringify(s2.names));
  check(s2.active[0] === 'libWin', '新打开的「图库」成为当前', JSON.stringify(s2.active));
  check(s2.names.includes('图库'), '标签沿用 libWin 这次挂载的名字（不是写死的「模型商店」）', JSON.stringify(s2.names));

  console.log('\n=== 4. 点标签切回去（内容不重载） ===');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#appbarTabs .abt')].find(x => x.dataset.win === 'storeWin');
    b.click();
  });
  await page.waitForTimeout(500);
  const s3 = await page.evaluate(() => {
    const host = document.getElementById('deskAppHost');
    const store = document.getElementById('storeWin');
    const lib = document.getElementById('libWin');
    return {
      storeInHost: host.contains(store),
      storeHidden: store.classList.contains('hidden'),
      libHidden: lib.classList.contains('hidden'),
      libInHost: host.contains(lib),
      cards: document.querySelectorAll('#mcStore .ms-card').length,
      appOpen: document.getElementById('deskWall').classList.contains('app-open'),
      active: [...document.querySelectorAll('#appbarTabs .abt.on')].map(b => b.dataset.win)
    };
  });
  check(s3.storeInHost === true && s3.storeHidden === false, '模型商店被搬回 App 页且显示');
  check(s3.libHidden === true && s3.libInHost === false, '图库被放回桌面层并隐藏');
  check(s3.cards === cards1, '切回来卡片数不变（没有重新加载）', s3.cards + '/' + cards1);
  check(s3.appOpen === true, '仍在 App 页，没有翻回桌面');
  check(s3.active[0] === 'storeWin', '高亮跟着切过去', JSON.stringify(s3.active));

  console.log('\n=== 5. 标签的关闭按钮 ===');
  const r5 = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#appbarTabs .abt')].find(x => x.dataset.win === 'libWin');
    b.querySelector('.abt-x').click();
    return { names: [...document.querySelectorAll('#appbarTabs .abt .abt-name')].map(e => e.textContent) };
  });
  await page.waitForTimeout(300);
  check(r5.names.length === 1 && r5.names[0] === '模型商店', '点 × 划掉「图库」这一条', JSON.stringify(r5.names));
  const s5 = await page.evaluate(() => ({
    libHidden: document.getElementById('libWin').classList.contains('hidden'),
    storeVisible: !document.getElementById('storeWin').classList.contains('hidden'),
    active: [...document.querySelectorAll('#appbarTabs .abt.on')].map(b => b.dataset.win)
  }));
  check(s5.libHidden === true, '被关掉的窗口已隐藏');
  check(s5.storeVisible === true && s5.active[0] === 'storeWin', '没有连带把当前 App 也关掉');

  console.log('\n=== 6. 关掉最后一个 → 回桌面，条子收起 ===');
  await page.evaluate(() => {
    const b = document.querySelector('#appbarTabs .abt');
    b.querySelector('.abt-x').click();
  });
  await page.waitForTimeout(500);
  const s6 = await page.evaluate(() => ({
    appOpen: document.getElementById('deskWall').classList.contains('app-open'),
    show: getComputedStyle(document.getElementById('appbarTabs')).display !== 'none',
    hidden: document.getElementById('storeWin').classList.contains('hidden'),
    table: deskTabs.length
  }));
  check(s6.appOpen === false, '整页翻回桌面');
  check(s6.show === false, '条子收起');
  check(s6.hidden === true, '窗口已隐藏');
  check(s6.table === 0, '标签表已清空', s6.table);

  console.log('\n=== 7. 返回桌面：标签留着、条子也在，还能从桌面直接点进去 ===');
  await page.evaluate(async () => {
    await openModelStore();
    await new Promise(r => setTimeout(r, 700));
    await openLibrary('image');
    await new Promise(r => setTimeout(r, 900));
  });
  await page.evaluate(() => document.getElementById('btnDeskHome').click());
  await page.waitForTimeout(500);
  const s7a = await page.evaluate(() => ({
    appOpen: document.getElementById('deskWall').classList.contains('app-open'),
    table: deskTabs.length,
    show: getComputedStyle(document.getElementById('appbarTabs')).display !== 'none',
    n: document.querySelectorAll('#appbarTabs .abt').length,
    active: document.querySelectorAll('#appbarTabs .abt.on').length,
    desktopVisible: getComputedStyle(document.getElementById('deskPage1')).opacity !== '0'
  }));
  check(s7a.appOpen === false && s7a.desktopVisible === true, '确实回到了桌面首页');
  check(s7a.table === 2 && s7a.n === 2, '标签表保留，两个标签都还在', JSON.stringify(s7a));
  check(s7a.show === true, '桌面上条子不再收起（这正是「返回主页看不到选项卡」的修复）');
  check(s7a.active === 0, '桌面上没有「当前 App」，所以没有高亮标签', s7a.active);
  /* 从桌面点标签 → 直接翻进那个 App，不用先双击图标 */
  await page.evaluate(() => {
    [...document.querySelectorAll('#appbarTabs .abt')].find(b => b.dataset.win === 'libWin').click();
  });
  await page.waitForTimeout(700);
  const s7b = await page.evaluate(() => ({
    appOpen: document.getElementById('deskWall').classList.contains('app-open'),
    active: [...document.querySelectorAll('#appbarTabs .abt.on')].map(b => b.dataset.win),
    inHost: document.getElementById('deskAppHost').contains(document.getElementById('libWin')),
    storeHidden: document.getElementById('storeWin').classList.contains('hidden'),
    desktopGone: getComputedStyle(document.getElementById('deskPage1')).opacity === '0'
  }));
  check(s7b.appOpen === true && s7b.desktopGone === true, '桌面点标签 → 整页翻到 App 页');
  check(s7b.inHost === true && s7b.storeHidden === true, '目标 App 被挂进 App 页，别的窗口让位', JSON.stringify(s7b));
  check(s7b.active[0] === 'libWin', '高亮落到刚点的那个标签', JSON.stringify(s7b.active));
  await page.keyboard.press('Control+Tab');
  await page.waitForTimeout(500);
  const s7c = await page.evaluate(() => ({ active: [...document.querySelectorAll('#appbarTabs .abt.on')].map(b => b.dataset.win), appOpen: document.getElementById('deskWall').classList.contains('app-open') }));
  check(s7c.active[0] === 'storeWin' && s7c.appOpen === true, 'Ctrl+Tab 切到下一个标签', JSON.stringify(s7c.active));
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForTimeout(500);
  const s7d = await page.evaluate(() => [...document.querySelectorAll('#appbarTabs .abt.on')].map(b => b.dataset.win));
  check(s7d[0] === 'libWin', 'Ctrl+Shift+Tab 切回上一个', JSON.stringify(s7d));

  console.log('\n=== 8. 进工作流编辑器时收起（否则点标签是死点击） ===');
  await page.evaluate(() => { if (typeof showView === 'function') showView('bp'); });
  await page.waitForTimeout(700);
  const s8 = await page.evaluate(() => ({
    homeHidden: document.getElementById('homeView').classList.contains('hidden'),
    show: getComputedStyle(document.getElementById('appbarTabs')).display !== 'none',
    table: deskTabs.length
  }));
  check(s8.homeHidden === true && s8.show === false, '工作流编辑器里不显示切换条', JSON.stringify(s8));
  await page.evaluate(() => { if (typeof showView === 'function') showView('home'); });
  await page.waitForTimeout(700);
  const s8b = await page.evaluate(() => ({
    show: getComputedStyle(document.getElementById('appbarTabs')).display !== 'none',
    n: document.querySelectorAll('#appbarTabs .abt').length,
    active: [...document.querySelectorAll('#appbarTabs .abt.on')].length
  }));
  check(s8b.show === true && s8b.n === 2 && s8b.active === 1, '回到工作台条子又出现，标签与高亮都还在', JSON.stringify(s8b));

  console.log('\n=== 9. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  await page.screenshot({ path: 'C:/Users/30297/AppData/Local/Temp/desk_tabs.png' });
  await browser.close();

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
