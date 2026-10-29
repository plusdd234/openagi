/* 回归测试：名片 App
 *
 * 覆盖：
 *   ① App 注册三件套（DESK_APPS / DESK_GLYPH / DESK_APP_META）+ 桌面图标真的画出来了
 *   ② 打开后窗口被搬进 App 页（#deskAppHost），页头标题取自 META
 *   ③ 内容渲染：名字 / UID / 等级 / 四格数字 / 关于段落 / 四条线 / 七个合集 / 三条联系方式
 *   ④ 数据自洽：UID 与拷贝值一致、每条外链都指向自己的主页而不是别人的
 *   ⑤ 赞赏码：固定文件 img/pay-qr.png；**没有换图入口**（按钮、file input、点击换码都要没有）；
 *      图片丢失时切成文字说明而不是破图框
 *   ⑥ 技术交流群：群名 / 群号 / 复制值 / 群码图片都要对，且**不能残留旧群号 931374446**
 *   ⑦ 关闭：× 走 deskAppLeave，窗口回到原父节点
 *   ⑧ 纯逻辑：esc
 *
 * 用法：node tools/card.js
 *
 * ⚠ DESK_APPS / DESK_GLYPH 是 desktop.js 顶层的 const，**不挂 window**，
 *   页面里只能按裸标识符取。写 window.DESK_APPS 会拿到 undefined，
 *   然后一整套断言变成在测「没打开任何 App」——这个坑在播放器测试里踩过。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openCard(page){
  await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'card');
    if (app && typeof app.open === 'function') app.open();
  });
  await sleep(620);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForSelector('#cardWin', { state: 'attached' });
  await page.evaluate(() => { try { localStorage.removeItem('hf_card_qr'); } catch (e) {} });

  /* ================= ① App 注册 ================= */
  console.log('\n— ① App 注册 —');
  const reg = await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const a = apps.find(x => x.id === 'card');
    const glyphs = (typeof DESK_GLYPH !== 'undefined') ? DESK_GLYPH : {};
    const meta = (typeof DESK_APP_META !== 'undefined') ? DESK_APP_META : {};
    return {
      inApps: !!a,
      name: a ? a.name : '',
      hasGlyph: !!glyphs.card,
      meta: meta.card || null,
      hasFn: typeof (window.devCard || {}).open === 'function',
      iconCount: document.querySelectorAll('.desk-app').length
    };
  });
  check(reg.inApps, 'DESK_APPS 里有 card', reg.name);
  check(reg.name === '名片', 'App 名字叫「名片」', reg.name);
  check(reg.hasGlyph, 'DESK_GLYPH.card 存在（桌面图标不会退化成默认字形）');
  check(!!reg.meta && reg.meta.win === 'cardWin', 'DESK_APP_META.card 指向 cardWin', reg.meta ? reg.meta.win : 'null');
  check(reg.hasFn, 'window.devCard.open 可用');
  check(reg.iconCount >= 8, '桌面图标已渲染（含名片）', reg.iconCount + ' 个');

  /* ================= ② 打开 ================= */
  console.log('\n— ② 打开与搬运 —');
  await openCard(page);
  const opened = await page.evaluate(() => {
    const win = document.getElementById('cardWin');
    const host = document.getElementById('deskAppHost');
    const head = document.querySelector('.dapp-head');
    return {
      visible: !!win && !win.classList.contains('hidden'),
      inHost: !!win && win.parentElement === host,
      headText: head ? head.textContent.replace(/\s+/g, ' ').trim() : ''
    };
  });
  check(opened.visible, '窗口可见');
  check(opened.inHost, '窗口被搬进 #deskAppHost（App 页）');
  check(/名片/.test(opened.headText), 'App 页头显示「名片」', opened.headText.slice(0, 40));

  /* ================= ③ 内容 ================= */
  console.log('\n— ③ 内容渲染 —');
  const content = await page.evaluate(() => {
    const t = id => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
    return {
      name: t('cdName'),
      uid: t('cdUid'),
      lv: t('cdLv'),
      tag: t('cdTag'),
      statN: document.querySelectorAll('#cdStats .cd-stat').length,
      statText: [...document.querySelectorAll('#cdStats .cd-stat')].map(e => e.textContent.trim()),
      aboutN: document.querySelectorAll('#cdAbout .cd-p').length,
      trackN: document.querySelectorAll('#cdTracks .cd-track').length,
      workN: document.querySelectorAll('#cdWorks .cd-work').length,
      linkN: document.querySelectorAll('#cdLinks .cd-link').length,
      foot: t('cdFoot'),
      empty: (document.getElementById('cdWorks') || {}).innerHTML === ''
    };
  });
  check(content.name === '虚幻茅场', '昵称渲染正确', content.name);
  check(/641892012/.test(content.uid), 'UID 正确', content.uid);
  check(/LV5/.test(content.lv), '等级徽标', content.lv);
  check(content.tag.length > 6, '一句话标签非空', content.tag);
  check(content.statN === 4, '数字条 4 格', content.statN + ' 格');
  check(/7,890/.test(content.statText.join('|')), '粉丝数在数字条里', content.statText[0]);
  check(content.aboutN === 2, '关于我 2 段', content.aboutN + ' 段');
  check(content.trackN === 4, '四条线 4 张卡', content.trackN + ' 张');
  check(content.workN === 7, '合集列表 7 条（一条都不能丢）', content.workN + ' 条');
  check(content.linkN === 2, '链接区 2 条', content.linkN + ' 条');
  check(/2026-10-29/.test(content.foot), '数据日期标注存在', content.foot);
  check(!content.empty, '合集区不是空的');

  /* 逐列填充：左列应该是第 1、2、3、4 条（DOM 顺序照旧，靠 grid-auto-flow 排版） */
  const layout = await page.evaluate(() => {
    const box = document.getElementById('cdWorks');
    const cs = getComputedStyle(box);
    return { flow: cs.gridAutoFlow, rows: cs.gridTemplateRows, cols: cs.gridTemplateColumns };
  });
  check(/column/.test(layout.flow), '合集列表逐列填充（先读完左列）', layout.flow);
  check(/repeat\(4/.test(layout.rows) || layout.rows.split(' ').length === 4, '网格 4 行 2 列', layout.rows);

  /* ================= ④ 数据自洽 ================= */
  console.log('\n— ④ 数据自洽 —');
  const links = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#cdLinks .cd-link')];
    return rows.map(r => ({ k: r.querySelector('.cd-link-k').textContent, url: r.dataset.url || '', copy: r.dataset.copy || '' }));
  });
  check(links.length === 2, '链接区两条（群不在这里重复，有独立的群卡）', links.length + ' 条');
  const home = links.find(l => /B 站主页/.test(l.k));
  check(!!home && home.url === 'https://space.bilibili.com/641892012', '主页链接指向自己的 UID', home ? home.url : '缺');
  const live = links.find(l => /直播间/.test(l.k));
  check(!!live && /live\.bilibili\.com\/23635391/.test(live.url), '直播间链接正确', live ? live.url : '缺');
  /* B 站是主阵地：这一行必须带 is-main，视觉上排在前面 */
  const mainRow = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#cdLinks .cd-link')];
    const i = r.findIndex(x => x.classList.contains('is-main'));
    return { idx: i, k: i >= 0 ? r[i].querySelector('.cd-link-k').textContent : '' };
  });
  check(mainRow.idx === 0, 'B 站主页排在第一条且带 is-main', mainRow.k || '无 is-main');

  const copyBtn = await page.evaluate(() => {
    const b = document.getElementById('cdCopyUid');
    return b ? b.dataset.copy : '';
  });
  check(copyBtn === '641892012', 'UID 复制按钮带的值与显示一致', copyBtn);

  /* 外链必须 target=_blank + noopener，否则 Electron 里会把应用页导航走 */
  const relOk = await page.evaluate(() => new Promise(resolve => {
    const seen = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      seen.push({ href: this.href, target: this.target, rel: this.rel });
    };
    const row = [...document.querySelectorAll('#cdLinks .cd-link')].find(r => /B 站主页/.test(r.textContent));
    if (row) row.click();
    HTMLAnchorElement.prototype.click = orig;
    setTimeout(() => resolve(seen[0] || null), 60);
  }));
  check(!!relOk && relOk.target === '_blank', '外链用新窗口打开', relOk ? relOk.target : 'no click');
  check(!!relOk && /noopener/.test(relOk.rel || ''), '外链带 rel=noopener', relOk ? relOk.rel : '');

  /* ================= ⑤ 赞赏码 ================= */
  console.log('\n— ⑤ 赞赏码（固定文件，无换图入口） —');
  const qr0 = await page.evaluate(() => {
    const img = document.getElementById('cdQr');
    const win = document.getElementById('cardWin');
    return {
      src: img.getAttribute('src'),
      hidden: img.classList.contains('hidden'),
      w: img.naturalWidth,
      title: (document.getElementById('cdPayTitle') || {}).textContent || '',
      note: (document.getElementById('cdPayS') || {}).textContent || '',
      hasPick: !!document.getElementById('cdQrPick'),
      hasFileInput: !!document.querySelector('#cardWin input[type=file]'),
      btnText: /换一张|换码/.test(win.textContent || '')
    };
  });
  check(/pay-qr\.png$/.test(qr0.src || ''), '赞赏码用固定文件 img/pay-qr.png', qr0.src);
  check(qr0.w > 100, '图片真的加载出来了（不是破图框）', qr0.w + 'px');
  check(qr0.hidden === false, '图片没被 fallback 顶掉');
  check(!!qr0.title && !!qr0.note, '标题与说明都在', qr0.title + ' / ' + qr0.note);
  check(!qr0.hasPick, '没有「换一张码」按钮');
  check(!qr0.hasFileInput, '窗口里没有 file input（换图整条链路都撤了）');
  check(!qr0.btnText, '页面上搜不到「换一张 / 换码」字样');

  /* 图丢了要给一句说明，而不是留个破图框 */
  const qrFallback = await page.evaluate(async () => {
    const img = document.getElementById('cdQr');
    img.src = 'img/__not_exist__.png';
    await new Promise(r => setTimeout(r, 600));
    const fb = document.getElementById('cdQrFb');
    return {
      imgHidden: img.classList.contains('hidden'),
      fbShown: fb ? fb.classList.contains('show') : false,
      fbText: fb ? fb.textContent : ''
    };
  });
  check(qrFallback.imgHidden && qrFallback.fbShown, '图丢失时切成文字说明', qrFallback.fbText);
  check(/pay-qr\.png/.test(qrFallback.fbText), '说明里写清了该把文件放哪', qrFallback.fbText);

  /* ================= ⑥ 技术交流群 ================= */
  console.log('\n— ⑥ 技术交流群 —');
  const grpCard = await page.evaluate(() => {
    const img = document.getElementById('cdGroupQr');
    const cp = document.getElementById('cdCopyGroup');
    return {
      name: (document.getElementById('cdGroupName') || {}).textContent || '',
      id: (document.getElementById('cdGroupId') || {}).textContent || '',
      copy: cp ? cp.dataset.copy : '',
      src: img ? img.getAttribute('src') : '',
      w: img ? img.naturalWidth : 0,
      hidden: img ? img.classList.contains('hidden') : true
    };
  });
  check(/虚幻引擎蓝图笔记3群/.test(grpCard.name), '群名正确', grpCard.name);
  check(/1108459704/.test(grpCard.id), '群号显示正确', grpCard.id);
  check(grpCard.copy === '1108459704', '复制按钮带的是新群号', grpCard.copy);
  check(/qq-group\.png$/.test(grpCard.src || ''), '群二维码用 img/qq-group.png', grpCard.src);
  check(grpCard.w === 520, '群码图片已加载（520×520）', grpCard.w + 'px');
  check(grpCard.hidden === false, '群码可见，没被 fallback 顶掉');

  /* 旧群号 931374446 是 B 站简介里挂的，不该再出现在名片上 */
  const legacy = await page.evaluate(() => document.getElementById('cardWin').textContent.includes('931374446'));
  check(!legacy, '页面上没有残留的旧群号 931374446');

  /* ================= ⑧ 关闭 ================= */
  console.log('\n— ⑧ 关闭 —');
  const closed = await page.evaluate(async () => {
    const win = document.getElementById('cardWin');
    document.getElementById('btnCardWinClose').click();
    await new Promise(r => setTimeout(r, 700));
    return {
      hiddenOrMoved: win.classList.contains('hidden') || win.parentElement !== document.getElementById('deskAppHost'),
      pageBack: !document.querySelector('.desk-wall.app-open')
    };
  });
  check(closed.hiddenOrMoved, '窗口离开 App 页（不会留在里面跟着隐藏）');
  check(closed.pageBack, 'App 页已退场，回到桌面');

  /* ================= ⑨ 纯逻辑 ================= */
  console.log('\n— ⑨ 纯逻辑 —');
  const pure = await page.evaluate(() => {
    const esc = window.devCard._pure.esc;
    return {
      amp: esc('a&b'),
      tag: esc('<b>x</b>'),
      quote: esc('he said "hi"'),
      nullv: esc(null),
      num: esc(12)
    };
  });
  check(pure.amp === 'a&amp;b', 'esc 转义 &', pure.amp);
  check(pure.tag === '&lt;b&gt;x&lt;/b&gt;', 'esc 转义标签', pure.tag);
  check(/&quot;/.test(pure.quote), 'esc 转义双引号', pure.quote);
  check(pure.nullv === '', 'esc(null) 给空串', JSON.stringify(pure.nullv));
  check(pure.num === '12', 'esc(数字) 转字符串', pure.num);

  const errs = errors.filter(e => !/ERR_CONNECTION_REFUSED|Failed to fetch|net::/.test(e));
  check(errs.length === 0, '页面零脚本错误', errs.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 全部通过'));
  if (fails) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
