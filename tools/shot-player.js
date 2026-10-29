/* 截图：播放器 App
 * 用法：node tools/shot-player.js   → tools/shots/player-*.png
 *
 * 用假的媒体库数据（真实目录里没片子），只看版式：舞台、控制条、分组、列表、
 * 下载面板、不可播标记各自长什么样。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
const ITEMS = [
  { id: '葬送的芙莉莲/第01话 冒险的结束.mp4', name: '第01话 冒险的结束.mp4', folder: '葬送的芙莉莲', kind: 'video', ext: 'mp4', size: 734003200, sizeMB: 700, playable: true, mtime: 1 },
  { id: '葬送的芙莉莲/第02话 其实不需要魔法.mp4', name: '第02话 其实不需要魔法.mp4', folder: '葬送的芙莉莲', kind: 'video', ext: 'mp4', size: 692060160, sizeMB: 660, playable: true, mtime: 2 },
  { id: '葬送的芙莉莲/第03话 杀人魔法.mp4', name: '第03话 杀人魔法.mp4', folder: '葬送的芙莉莲', kind: 'video', ext: 'mp4', size: 713031680, sizeMB: 680, playable: true, mtime: 3 },
  { id: '葬送的芙莉莲/第10话 强大的魔法使.mp4', name: '第10话 强大的魔法使.mp4', folder: '葬送的芙莉莲', kind: 'video', ext: 'mp4', size: 671088640, sizeMB: 640, playable: true, mtime: 4 },
  { id: '葬送的芙莉莲/第11话 北方魔法使.mp4', name: '第11话 北方魔法使.mp4', folder: '葬送的芙莉莲', kind: 'video', ext: 'mp4', size: 702545920, sizeMB: 670, playable: true, mtime: 5 },
  { id: '葬送的芙莉莲/第12话 真正的勇者.mkv', name: '第12话 真正的勇者.mkv', folder: '葬送的芙莉莲', kind: 'video', ext: 'mkv', size: 838860800, sizeMB: 800, playable: false, mtime: 6 },
  { id: '拍摄花絮 01.webm', name: '拍摄花絮 01.webm', folder: '', kind: 'video', ext: 'webm', size: 52428800, sizeMB: 50, playable: true, mtime: 7 },
  { id: '葬送的芙莉莲/第01话 冒险的结束.vtt', name: '第01话 冒险的结束.vtt', folder: '葬送的芙莉莲', kind: 'sub', ext: 'vtt', size: 4096, sizeMB: 0, playable: true, mtime: 1 }
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(listData => {
    window.openagiDesktop = {
      mediaList: async () => JSON.parse(JSON.stringify(listData)),
      mediaImport: async () => ({ ok: false, cancelled: true }),
      mediaImportDir: async () => ({ ok: false, cancelled: true }),
      mediaOpenDir: async () => ({ ok: true }),
      mediaDownload: async () => ({ ok: false, message: 'mock' }),
      mediaCancel: async () => ({ ok: true }),
      onMediaProgress: () => {}
    };
    try {
      /* 前两集标记成看过的，进度条才有东西可看 */
      localStorage.setItem('hf_player_pos', JSON.stringify({
        '葬送的芙莉莲/第01话 冒险的结束.mp4': { t: 1400, d: 1440, at: Date.now() },
        '葬送的芙莉莲/第02话 其实不需要魔法.mp4': { t: 380, d: 1440, at: Date.now() }
      }));
    } catch (e) {}
  }, {
    ok: true, root: 'C:\\Users\\Me\\AppData\\Roaming\\openagi\\media',
    files: ITEMS,
    folders: [{ name: '葬送的芙莉莲', count: 7, bytes: 5171515392 }, { name: '散文件', count: 1, bytes: 52428800 }],
    total: 5223944192, totalMB: 4982
  });

  const page = await ctx.newPage();
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url);
  await page.waitForSelector('#playerWin', { state: 'attached' });
  await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'player');
    if (app) app.open();
  });
  await page.waitForTimeout(900);

  await page.screenshot({ path: path.join(OUT, 'player-1-list.png') });
  console.log('✅ player-1-list.png（空舞台 + 列表 + 分组）');

  /* 选中一集：假路径没有真文件，<video> 必然报 error 并把空态切回「播不了」。
     所以先点、等 error 落定，再把空态收起、伪造播放进度——只为看版式。 */
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#plList .pl-item');
    if (rows[2]) rows[2].click();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const box = document.getElementById('plEmpty');
    if (box) box.classList.add('hidden');
    const t = document.getElementById('plTime');
    if (t) t.textContent = '23:41 / 24:00';
    const seek = document.getElementById('plSeek');
    if (seek) seek.value = '987';
    const bar = document.getElementById('plPlay');
    if (bar) { const p = bar.querySelector('.pl-ico-play'); const q = bar.querySelector('.pl-ico-pause'); if (p) p.classList.add('hidden'); if (q) q.classList.remove('hidden'); }
  });
  await page.waitForTimeout(160);
  await page.screenshot({ path: path.join(OUT, 'player-2-playing.png') });
  console.log('✅ player-2-playing.png（选中态 + 控制条）');

  /* 分组切到「葬送的芙莉莲」 */
  await page.evaluate(() => {
    const chips = document.querySelectorAll('#plFolders .pl-chip');
    if (chips[1]) chips[1].click();
  });
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(OUT, 'player-3-folder.png'), clip: { x: 1090, y: 120, width: 340, height: 720 } });
  console.log('✅ player-3-folder.png（按作品分组后的列表）');

  /* 下载面板 */
  await page.evaluate(() => {
    const chips = document.querySelectorAll('#plFolders .pl-chip');
    if (chips[0]) chips[0].click();
    const b = document.getElementById('plDl');
    if (b) b.classList.remove('hidden');
    const u = document.getElementById('plDlUrl');
    if (u) u.value = 'https://example.com/videos/ep13.mp4';
  });
  await page.waitForTimeout(240);
  await page.screenshot({ path: path.join(OUT, 'player-4-download.png') });
  console.log('✅ player-4-download.png（直链下载面板）');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
