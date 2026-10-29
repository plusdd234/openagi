/* 回归测试：播放器 App
 *
 * 覆盖：
 *   ① App 已注册（DESK_APPS / DESK_GLYPH / DESK_APP_META），点图标能翻到 App 页
 *   ② 列表只收视频/音频：图片和字幕不进队列
 *   ③ **自然序**：第2集一定排在第10集前面（字典序会反过来，那是跳集的直接原因）
 *   ④ **分组语义**：null = 全部、'' = 根目录散文件、其余 = 子目录——三者不能混
 *   ⑤ 点列表 / 上一集 / 下一集 的高亮跟随；切集后进度条位置正确
 *   ⑥ 断点续播：太靠前不续、太靠后不续（否则「下一集」永远要从头看片尾）
 *   ⑦ 协议地址编码：中文、空格、`#` 都要 encodeURIComponent（`#` 不编码会被当 fragment 截断）
 *   ⑧ 没有 Electron 媒体库时降级成文件选择器（能选出条目并渲染）
 *   ⑨ 直链下载面板开合；非法地址给出提示而不是静默失败
 *
 * 用法：node tools/player.js
 *
 * ⚠ 媒体库用 addInitScript 在页面脚本**之前**注入 window.openagiDesktop。
 *   player.js 里的 `const desktop = window.openagiDesktop` 是 IIFE 顶层立即求值的，
 *   页面加载完再补就来不及了（这是之前踩过的坑）。
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

const ROOT = 'C:/Users/fake/AppData/Roaming/openagi/media';
const ITEMS = [
  { id: '某番剧/第2集.mp4', name: '第2集.mp4', folder: '某番剧', kind: 'video', ext: 'mp4', mime: 'video/mp4', size: 125829120, sizeMB: 120, mtime: 1, playable: true },
  { id: '某番剧/第10集.mp4', name: '第10集.mp4', folder: '某番剧', kind: 'video', ext: 'mp4', mime: 'video/mp4', size: 104857600, sizeMB: 100, mtime: 2, playable: true },
  { id: '某番剧/第2集.vtt', name: '第2集.vtt', folder: '某番剧', kind: 'sub', ext: 'vtt', mime: 'text/vtt', size: 1024, sizeMB: 0, mtime: 1, playable: true },
  { id: '某番剧/封面.jpg', name: '封面.jpg', folder: '某番剧', kind: 'image', ext: 'jpg', mime: 'image/jpeg', size: 204800, sizeMB: 0.2, mtime: 1, playable: true },
  { id: '某番剧/第3集.mkv', name: '第3集.mkv', folder: '某番剧', kind: 'video', ext: 'mkv', mime: 'video/x-matroska', size: 209715200, sizeMB: 200, mtime: 3, playable: false },
  { id: '散片 01.webm', name: '散片 01.webm', folder: '', kind: 'video', ext: 'webm', mime: 'video/webm', size: 8388608, sizeMB: 8, mtime: 4, playable: true }
];

const MEDIA_LIST = {
  ok: true, root: ROOT, files: ITEMS,
  folders: [{ name: '散文件', count: 1, bytes: 8388608 }, { name: '某番剧', count: 4, bytes: 440401920 }],
  total: 449290240, totalMB: 428.5
};

async function openPlayer(page){
  /* DESK_APPS 是 desktop.js 顶层的 const，**不挂在 window 上** ——
   * 只能按裸标识符取（写 window.DESK_APPS 会拿到 undefined，然后整个测试
   * 变成在测「没打开任何 App」）。 */
  await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'player');
    if (app && typeof app.open === 'function') app.open();
  });
  await sleep(420);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';

  /* ================= 第一段：有媒体库（Electron 形态） ================= */
  const errorsA = [];
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxA.addInitScript(listData => {
    window.openagiDesktop = {
      mediaList: async () => JSON.parse(JSON.stringify(listData)),
      mediaStat: async () => ({ ok: true, root: 'C:/x', count: 6, bytes: 1 }),
      mediaImport: async () => ({ ok: false, cancelled: true }),
      mediaImportDir: async () => ({ ok: false, cancelled: true }),
      mediaRemove: async () => ({ ok: true }),
      mediaReveal: async () => ({ ok: true }),
      mediaOpenDir: async () => ({ ok: true, dir: 'C:/x' }),
      mediaDownload: async () => ({ ok: false, message: 'mock 下载被拦' }),
      mediaCancel: async () => ({ ok: true }),
      onMediaProgress: cb => { window.__progCb = cb; }
    };
  }, MEDIA_LIST);
  const pageA = await ctxA.newPage();
  pageA.on('pageerror', e => errorsA.push(String(e && e.message)));
  await pageA.goto(url);
  await pageA.waitForSelector('#playerWin', { state: 'attached' });

  console.log('\n— ① App 注册 —');
  const reg = await pageA.evaluate(() => ({
    inApps: (typeof DESK_APPS !== 'undefined' && !!DESK_APPS.find(a => a.id === 'player')),
    glyph: (typeof DESK_GLYPH !== 'undefined' && !!DESK_GLYPH.video),
    meta: (typeof DESK_APP_META !== 'undefined' && DESK_APP_META.player) || null,
    hasFn: typeof (window.playerApp || {}).open === 'function'
  }));
  check(reg.inApps, 'DESK_APPS 里有 player');
  check(reg.glyph, 'DESK_GLYPH.video 存在');
  check(!!reg.meta && reg.meta.win === 'playerWin', 'DESK_APP_META.player 指向 playerWin', JSON.stringify(reg.meta));
  check(reg.hasFn, 'window.playerApp.open 可用');

  await openPlayer(pageA);
  const mounted = await pageA.evaluate(() => {
    const win = document.getElementById('playerWin');
    return {
      visible: win && !win.classList.contains('hidden'),
      inHost: !!(win && win.parentElement && win.parentElement.id === 'deskAppHost'),
      appOpen: !!document.querySelector('#deskWall.app-open'),
      title: (document.getElementById('deskAppTitle') || {}).textContent || '',
      sub: (document.getElementById('deskAppSub') || {}).textContent || ''
    };
  });
  check(mounted.visible && mounted.inHost, '窗口搬进 App 页并显示');
  check(mounted.appOpen, '桌面翻到 App 页');
  check(mounted.title === '播放器', 'App 页标题是「播放器」', mounted.title);
  check(mounted.sub.indexOf('本地') >= 0, '副标题说明这是本地播放器', mounted.sub);

  console.log('\n— ② 列表只收影音 —');
  const listInfo = await pageA.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#plList .pl-item'));
    return {
      n: rows.length,
      names: rows.map(r => (r.querySelector('.pl-nm') || {}).textContent || ''),
      ids: rows.map(r => r.dataset.id)
    };
  });
  check(listInfo.n === 4, '6 个文件里只有 4 个影音进队列（图/字幕被排除）', 'n=' + listInfo.n);
  check(!listInfo.names.some(n => /\.(jpg|vtt)$/i.test(n)), '队列里没有 jpg / vtt', listInfo.names.join(' | '));

  console.log('\n— ③ 自然序 —');
  const order = await pageA.evaluate(() => {
    const q = window.playerApp._pure.queueOf(window.playerApp.files(), null).map(f => f.name);
    return q;
  });
  const i2 = order.indexOf('第2集.mp4');
  const i10 = order.indexOf('第10集.mp4');
  check(i2 >= 0 && i10 >= 0 && i2 < i10, '第2集 排在第10集 前面', order.join(' → '));
  check(order[order.length - 1].indexOf('散片') === 0, '按分组排序：子目录在前、散文件在后', order.join(' → '));

  console.log('\n— ④ 分组语义 —');
  const grp = await pageA.evaluate(() => {
    const P = window.playerApp._pure;
    const files = window.playerApp.files();
    const all = P.queueOf(files, null).length;
    const inFolder = P.queueOf(files, '某番剧').length;
    const loose = P.queueOf(files, '').length;
    const groups = P.groupsOf(files).map(g => g.key + '=' + g.count);
    return { all, inFolder, loose, groups };
  });
  check(grp.all === 4, 'null = 全部（4 条，含 mkv 这种不可播的也先列出来）', 'all=' + grp.all);
  check(grp.inFolder === 3, "folder='某番剧' = 3 条", 'in=' + grp.inFolder);
  check(grp.loose === 1, "folder='' 只给根目录散文件（不能等于全部）", 'loose=' + grp.loose);
  check(grp.groups.length === 2, '分组两个：散文件 + 某番剧', grp.groups.join(','));

  const chips = await pageA.evaluate(() => {
    const cs = Array.from(document.querySelectorAll('#plFolders .pl-chip'));
    return { n: cs.length, texts: cs.map(c => c.textContent), on: cs.filter(c => c.classList.contains('is-on')).map(c => c.textContent) };
  });
  check(chips.n === 3, '分组条 = 全部 + 两个分组', chips.texts.join(' / '));
  check(chips.on.length === 1 && chips.on[0].indexOf('全部') === 0, '默认选中「全部」', chips.on.join(''));

  console.log('\n— ⑤ 切集与高亮 —');
  await pageA.evaluate(() => {
    const rows = document.querySelectorAll('#plList .pl-item');
    rows[1] && rows[1].click();
  });
  await sleep(260);
  const afterClick = await pageA.evaluate(() => {
    const cur = document.querySelector('#plList .pl-item.is-cur');
    const st = window.playerApp.state();
    return { curId: cur ? cur.dataset.id : '', state: st };
  });
  check(afterClick.curId === '某番剧/第3集.mkv', '点第二项 → 高亮落在第3集', afterClick.curId);
  check(afterClick.state.idx === 1, '队列索引同步到 1', 'idx=' + afterClick.state.idx);

  const nextPrev = await pageA.evaluate(() => {
    document.getElementById('plNext').click();
    const a = (document.querySelector('#plList .pl-item.is-cur') || {}).dataset;
    document.getElementById('plPrev').click();
    const b = (document.querySelector('#plList .pl-item.is-cur') || {}).dataset;
    document.getElementById('plPrev').click();
    const c = (document.querySelector('#plList .pl-item.is-cur') || {}).dataset;
    return { a: a ? a.id : '', b: b ? b.id : '', c: c ? c.id : '' };
  });
  /* 队列按自然序：第2集 → 第3集 → 第10集。所以从第3集「下一集」应该到第10集，
   * 而不是字典序里的第2集——这正是③要守的东西在交互层的体现。 */
  check(nextPrev.a === '某番剧/第10集.mp4', '下一集 → 第10集（不是字典序的下一项）', nextPrev.a);
  check(nextPrev.b === '某番剧/第3集.mkv', '上一集 → 回到第3集', nextPrev.b);
  check(nextPrev.c === '某番剧/第2集.mp4', '再上一集 → 第2集', nextPrev.c);

  console.log('\n— ⑥ 断点续播的取舍 —');
  const resume = await pageA.evaluate(() => {
    const R = window.playerApp._pure.resumeAt;
    return {
      head: R({ t: 3, d: 1440 }, 1440),        // 片头曲里 → 不续
      mid: R({ t: 620, d: 1440 }, 1440),       // 中间 → 续
      tail: R({ t: 1435, d: 1440 }, 1440),     // 只剩 5 秒 → 当看完
      nod: R({ t: 620, d: 0 }, 0),             // 没有 duration 记录 → 用记录里的 d
      zero: R(null, 1440)
    };
  });
  check(resume.head === 0, '3 秒不续播（还在片头）', String(resume.head));
  check(resume.mid === 620, '620 秒续播', String(resume.mid));
  check(resume.tail === 0, '距结尾 5 秒内不续播', String(resume.tail));
  check(resume.nod === 620, 'duration 未知时按记录里的 d 判断', String(resume.nod));
  check(resume.zero === 0, '没记录 → 0', String(resume.zero));

  console.log('\n— ⑦ 协议地址编码 —');
  const urls = await pageA.evaluate(() => {
    const U = window.playerApp._urlOf;
    return {
      loose: U({ id: '散片 01.webm' }),
      hash: U({ id: '某番剧/第#2集.mp4' }),
      plain: U({ id: 'a.mp4' })
    };
  });
  check(urls.plain === 'openagi-media://media/a.mp4', '普通路径原样', urls.plain);
  check(urls.loose.indexOf('%20') > 0, '空格被编码（否则路径断开）', urls.loose);
  check(urls.hash.indexOf('%23') > 0 && urls.hash.indexOf('#2') < 0, '`#` 被编码成 %23（不编码会被当 fragment）', urls.hash);

  console.log('\n— ⑧ 下载面板 —');
  await pageA.evaluate(() => { const b = document.getElementById('plDl'); if (b) b.classList.add('hidden'); });
  await pageA.evaluate(() => document.getElementById('plDlOpen').click());
  await sleep(120);
  const dlOpen = await pageA.evaluate(() => !document.getElementById('plDl').classList.contains('hidden'));
  check(dlOpen, '点「＋ 直链」展开下载面板');
  await pageA.evaluate(() => document.getElementById('plDlGo').click());
  await sleep(200);
  const dlBad = await pageA.evaluate(() => {
    const t = document.querySelector('#plEmpty .pl-empty-t');
    return t ? t.textContent : '';
  });
  check(dlBad.indexOf('播不了') === 0, '空地址点下载 → 给出提示而不是静默', dlBad);

  console.log('\n— ⑨ 进度条与总量 —');
  const countTxt = await pageA.evaluate(() => (document.getElementById('plCount') || {}).textContent || '');
  check(/4 \/ 4/.test(countTxt), '侧栏显示「当前组/总数」', countTxt);
  check(/MB|GB/.test(countTxt), '侧栏显示占用空间', countTxt);

  check(errorsA.length === 0, '页面零错误（媒体库形态）', errorsA.join(' | '));

  /* ================= 第二段：没有媒体库（浏览器直开） ================= */
  console.log('\n— ⑩ 浏览器降级 —');
  const errorsB = [];
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageB = await ctxB.newPage();
  pageB.on('pageerror', e => errorsB.push(String(e && e.message)));
  await pageB.goto(url);
  await pageB.waitForSelector('#playerWin', { state: 'attached' });

  const modeB = await pageB.evaluate(() => window.playerApp.hasLib());
  check(modeB === false, '没有 openagiDesktop 时 hasLib() = false');

  await openPlayer(pageB);
  /* 降级路径的入口是 #plFile；用 setInputFiles 走真实的 change 流程 */
  await pageB.setInputFiles('#plFile', [
    { name: '试播 01.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 1) },
    { name: '试播 02.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4096, 1) }
  ]);
  await sleep(320);
  const localList = await pageB.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#plList .pl-item'));
    return {
      n: rows.length,
      ids: rows.map(r => r.dataset.id),
      files: window.playerApp.files().map(f => f.name),
      hasUrl: window.playerApp.files().every(f => /^blob:/.test(f.url || ''))
    };
  });
  check(localList.n === 2, '降级模式选出 2 条并渲染', 'n=' + localList.n);
  check(localList.hasUrl, '降级条目带 blob: 地址（不走媒体协议）');
  check(localList.ids.every(id => id.indexOf('local:') === 0), '降级条目 id 以 local: 开头', localList.ids.join(','));

  /* 这里放的是一段假 buffer，解码必然失败 —— 所以空态要么收起（真视频的情况），
   * 要么切成「播不了这一集」。**两种情况都算对**，只要它不再说「还没有可播的东西」。
   * 断言写死 hidden=true 就变成了在要求「假文件也能播」，那才是错的。 */
  const emptyState = await pageB.evaluate(() => {
    const box = document.getElementById('plEmpty');
    const t = box ? box.querySelector('.pl-empty-t') : null;
    return { hidden: box ? box.classList.contains('hidden') : null, title: t ? t.textContent : '' };
  });
  check(emptyState.hidden === true || emptyState.title === '播不了这一集',
    '空态不再是「还没有可播的东西」', 'hidden=' + emptyState.hidden + ' title=' + emptyState.title);

  check(errorsB.length === 0, '页面零错误（降级形态）', errorsB.join(' | '));

  /* ================= 第三段：进度记忆 ================= */
  console.log('\n— ⑪ 进度条记忆 —');
  await ctxA.close();
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxC.addInitScript(listData => {
    window.openagiDesktop = {
      mediaList: async () => JSON.parse(JSON.stringify(listData)),
      mediaImport: async () => ({ ok: false, cancelled: true }),
      mediaImportDir: async () => ({ ok: false, cancelled: true }),
      mediaDownload: async () => ({ ok: false }),
      mediaCancel: async () => ({ ok: true }),
      onMediaProgress: () => {}
    };
    /* 进度在 localStorage 里，IIFE 初始化时读一次 —— 所以必须在脚本之前写。
     * ?nostore=1 只禁「我们自己写」，外部 setItem 不受影响。 */
    try {
      localStorage.setItem('hf_player_pos', JSON.stringify({
        '某番剧/第2集.mp4': { t: 600, d: 1440, at: Date.now() }
      }));
      localStorage.setItem('hf_player_set', JSON.stringify({ vol: 0.5, rate: 1.5, muted: false, folder: null }));
    } catch (e) {}
  }, MEDIA_LIST);
  const pageC = await ctxC.newPage();
  await pageC.goto(url);
  await openPlayer(pageC);
  const remembered = await pageC.evaluate(() => {
    const row = document.querySelector('#plList .pl-item[data-id="某番剧/第2集.mp4"]');
    const done = row ? row.querySelector('.pl-done') : null;
    const set = window.playerApp._settings();
    return {
      hasBar: !!done,
      width: done ? done.style.width : '',
      vol: set.vol,
      rate: set.rate
    };
  });
  check(remembered.hasBar, '看过的集在列表里带进度条');
  check(remembered.width === '42%', '进度条宽度按 600/1440 ≈ 42%', remembered.width);
  check(remembered.vol === 0.5, '音量记忆生效', String(remembered.vol));
  check(remembered.rate === 1.5, '倍速记忆生效', String(remembered.rate));

  const rateCycle = await pageC.evaluate(() => {
    const N = window.playerApp._pure.nextRate;
    return { a: N(1), b: N(2), c: N(9), d: N(0.5) };
  });
  check(rateCycle.a === 1.25 && rateCycle.b === 0.5 && rateCycle.c === 1, '倍速循环 1→1.25、2→0.5、非法值→1',
    JSON.stringify(rateCycle));

  console.log('\n— ⑫ 时间格式 —');
  const fmt = await pageC.evaluate(() => {
    const F = window.playerApp._pure.fmtTime;
    return [F(0), F(9), F(65), F(3599), F(3600), F(3725), F(-5), F(NaN)];
  });
  check(fmt[0] === '0:00', '0 → 0:00', fmt[0]);
  check(fmt[2] === '1:05', '65 → 1:05', fmt[2]);
  check(fmt[4] === '1:00:00', '3600 → 1:00:00', fmt[4]);
  check(fmt[5] === '1:02:05', '3725 → 1:02:05', fmt[5]);
  check(fmt[6] === '0:00' && fmt[7] === '0:00', '负数 / NaN 都归零（不显示 -1:-5）', fmt[6] + ' / ' + fmt[7]);

  await ctxB.close();
  await ctxC.close();
  await browser.close();

  console.log('\n' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('测试崩了：', e);
  process.exit(1);
});
