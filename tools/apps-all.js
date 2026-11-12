/* 体检：把桌面上的每个 App 都真的打开一遍。
 * 用法：node tools/apps-all.js [id ...]
 *
 * 为什么要有这个：App 从 index.html 的静态 .os-win 迁到 registerApp 生成之后，
 * 「窗口能造出来」和「模块真能往里画东西」是两件事。前者靠 app-registry 的体检，
 * 后者只能逐个打开看 —— 而漏掉的那个往往是 body 里少了个宿主节点，
 * 或者模块按老 id 找元素找不着，症状是窗口开着、里面空着。
 *
 * 逐个打开也顺便验证了「切走」这条路：窗口要能搬回 deskWall、标签要能划掉。
 * 不传参数就跑全部；传 id 就只跑那几个（迁移时一次盯一个更省时间）。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + String(extra).slice(0, 140) : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const all = await page.evaluate(() => DESK_APPS.map(a => a.id));
  const ids = only.length ? only.filter(id => all.indexOf(id) >= 0) : all;
  console.log('将逐个打开 ' + ids.length + ' 个 App：' + ids.join(' , '));

  for (const id of ids) {
    console.log('\n--- ' + id + ' ---');
    const before = errors.length;

    await page.evaluate(i => { if (typeof openDeskApp === 'function') openDeskApp(i); }, id);
    await page.waitForTimeout(1400);

    const s = await page.evaluate(i => {
      const meta = DESK_APP_META[i] || {};
      const w = meta.win ? document.getElementById(meta.win) : null;
      if (!w) return { noWin: true };
      const body = w.querySelector('.os-win-body');
      const r = w.getBoundingClientRect();
      return {
        winId: w.id,
        inHost: w.parentElement ? w.parentElement.id : null,
        visible: !w.classList.contains('hidden'),
        loading: w.classList.contains('app-loading'),
        bodyKids: body ? body.children.length : -1,
        /* 「body 里有节点」是假绿：宿主 div 是注册时静态写进去的，模块一个东西没画也有它。
           真正的判据是**宿主内部**还有没有节点 —— 那才是模块渲染出来的。
           原来这里测 body 的 getBoundingClientRect 高度，空壳同样是 778，等于没测。 */
        deep: body ? body.querySelectorAll('*').length : 0,
        w: Math.round(r.width), h: Math.round(r.height),
        tab: [...document.querySelectorAll('#appbarTabs .abt')].map(b => b.dataset.win + (b.classList.contains('on') ? '*' : '')),
        appOpen: document.getElementById('deskWall').classList.contains('app-open')
      };
    }, id);

    if (s.noWin) { check(false, id + ' 没有对应窗口'); continue; }
    check(s.appOpen === true, '翻到 App 页');
    check(s.inHost === 'deskAppHost', '窗口搬进 host', s.inHost);
    check(s.visible === true, '窗口可见');
    check(s.bodyKids > 0, 'body 里有节点', '节点数 ' + s.bodyKids);
    check(s.deep > 1, '宿主里真画出了东西（不是只有一层空壳）', '子孙节点 ' + s.deep);
    check(s.loading === false, '骨架已撤（模块的 open 落定了）');
    check(s.w > 400 && s.h > 300, '窗口铺满画布', s.w + '×' + s.h);
    check(s.tab.length >= 1 && s.tab.some(t => t.endsWith('*')), '顶栏标签出现并高亮', JSON.stringify(s.tab));

    /* 切走：窗口回 deskWall、标签划掉 */
    await page.evaluate(() => { const b = document.getElementById('btnDeskHome'); if (b) b.click(); });
    await page.waitForTimeout(500);
    const back = await page.evaluate(winId => {
      const w = document.getElementById(winId);
      return {
        appOpen: document.getElementById('deskWall').classList.contains('app-open'),
        parent: w ? (w.parentElement ? w.parentElement.id : null) : 'GONE',
        hidden: w ? w.classList.contains('hidden') : null,
        tabs: [...document.querySelectorAll('#appbarTabs .abt')].map(b => b.dataset.win)
      };
    }, s.winId);
    check(back.appOpen === false && back.parent === 'deskWall' && back.hidden === true, '切走后窗口回 deskWall 且隐藏', back.parent);
    check(back.tabs.indexOf(s.winId) >= 0, '标签保留（返回不等于关闭）', JSON.stringify(back.tabs));

    check(errors.length === before, '这一步没有新报错', errors.slice(before, before + 2).join(' | '));
  }

  console.log('\n=== 收尾 ===');
  check(errors.length === 0, '全程零报错', errors.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? '❌ ' + fails + ' 条未通过' : '✅ 全部通过'));
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
