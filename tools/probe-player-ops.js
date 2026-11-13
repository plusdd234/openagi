/* 探针：播放器媒体库文件操作（右键菜单 / 行内改名 / F2 / Delete）
 * 覆盖：⋯ 按钮显隐、右键菜单定位与能力裁剪、行内改名提交与取消、
 *       进度随改名迁移、删除确认、定位 / 复制文件名、降级环境收敛。
 * 用法：node tools/probe-player-ops.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if(!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ITEMS = [
  { id: '某番剧/第2集.mp4', name: '第2集.mp4', folder: '某番剧', kind: 'video', ext: 'mp4', mime: 'video/mp4', size: 125829120, sizeMB: 120, mtime: 1, playable: true },
  { id: '某番剧/第10集.mp4', name: '第10集.mp4', folder: '某番剧', kind: 'video', ext: 'mp4', mime: 'video/mp4', size: 104857600, sizeMB: 100, mtime: 2, playable: true },
  { id: '某番剧/第3集.mkv', name: '第3集.mkv', folder: '某番剧', kind: 'video', ext: 'mkv', mime: 'video/x-matroska', size: 209715200, sizeMB: 200, mtime: 3, playable: false },
  { id: '散片 01.webm', name: '散片 01.webm', folder: '', kind: 'video', ext: 'webm', mime: 'video/webm', size: 8388608, sizeMB: 8, mtime: 4, playable: true }
];

async function openPlayer(page){
  await page.evaluate(() => {
    const apps = (typeof DESK_APPS !== 'undefined') ? DESK_APPS : [];
    const app = apps.find(a => a.id === 'player');
    if(app && typeof app.open === 'function') app.open();
  });
  await sleep(420);
}

function desktopMock(seedPos){
  return `
    window.__items = ${JSON.stringify(ITEMS)};
    window.__renamed = [];
    window.__removed = [];
    try{
      ${seedPos ? `localStorage.setItem('hf_player_pos', JSON.stringify(${JSON.stringify(seedPos)}));` : ''}
    }catch(e){}
    window.openagiDesktop = {
      mediaList: async () => ({
        ok: true, root: 'C:/x',
        files: window.__items.map(f => Object.assign({}, f)),
        folders: [], total: 0, totalMB: 0
      }),
      mediaRename: async (id, name) => {
        if(window.__failRename) return { ok: false, message: '模拟失败' };
        const it = window.__items.find(f => f.id === id);
        if(!it) return { ok: false, message: '文件不存在' };
        const newId = (it.folder ? it.folder + '/' : '') + name;
        if(window.__items.some(f => f.id === newId)) return { ok: false, message: '同一目录下已有同名文件：' + name };
        window.__renamed.push({ id, name });
        it.id = newId; it.name = name;
        return { ok: true, id: newId, oldId: id, name, sidecars: [] };
      },
      mediaRemove: async ids => {
        window.__removed.push(ids.slice());
        window.__items = window.__items.filter(f => ids.indexOf(f.id) < 0);
        return { ok: true, removed: ids, trashed: true };
      },
      mediaReveal: async id => { window.__revealed = id; return { ok: true }; },
      mediaImport: async () => ({ ok: false, cancelled: true }),
      mediaImportDir: async () => ({ ok: false, cancelled: true }),
      mediaDownload: async () => ({ ok: false, message: 'mock' }),
      mediaCancel: async () => ({ ok: true }),
      mediaOpenDir: async () => ({ ok: true }),
      onMediaProgress: () => {}
    };
  `;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  const errors = [];

  /* ============ 第一段：Electron 形态（可写盘） ============ */
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(desktopMock({
    '某番剧/第2集.mp4': { t: 600, d: 1440, at: 1 },
    '某番剧/第10集.mp4': { t: 200, d: 1400, at: 2 }
  }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(url);
  await page.waitForSelector('#playerWin', { state: 'attached' });
  await openPlayer(page);

  console.log('\n— ① 列表行与「⋯」按钮 —');
  check(await page.locator('#plList .pl-item').count() === 4, '列表渲染 4 行');
  check(await page.locator('#plList .pl-item .pl-more').count() === 4, '每行都有「⋯」按钮');
  const moreOpacity = await page.evaluate(() => {
    const row = document.querySelector('#plList .pl-item');
    return getComputedStyle(row.querySelector('.pl-more')).opacity;
  });
  check(moreOpacity === '0', '默认不显示「⋯」（hover 才出现）', 'opacity=' + moreOpacity);
  await page.hover('#plList .pl-item:first-child');
  await sleep(120);
  const hoverOpacity = await page.evaluate(() => getComputedStyle(document.querySelector('#plList .pl-item .pl-more')).opacity);
  check(Number(hoverOpacity) > 0.9, 'hover 后「⋯」显现', 'opacity=' + hoverOpacity);

  console.log('\n— ② 右键菜单 —');
  const row10 = page.locator('#plList .pl-item[data-id="某番剧/第10集.mp4"]');
  await row10.click({ button: 'right' });
  await sleep(150);
  const ctxInfo = await page.evaluate(() => {
    const el = document.getElementById('plCtx');
    const r = el.getBoundingClientRect();
    const acts = {};
    el.querySelectorAll('[data-act]').forEach(b => { acts[b.dataset.act] = !b.classList.contains('hidden'); });
    return {
      open: !el.classList.contains('hidden'),
      acts,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      sel: (document.querySelector('#plList .pl-item.is-sel') || {}).dataset ? document.querySelector('#plList .pl-item.is-sel').dataset.id : ''
    };
  });
  check(ctxInfo.open, '右键打开菜单');
  check(ctxInfo.inView, '菜单没有探出视口');
  check(ctxInfo.acts.play && ctxInfo.acts.rename && ctxInfo.acts.reveal && ctxInfo.acts.copy && ctxInfo.acts.remove, '写盘环境显示全部菜单项', JSON.stringify(ctxInfo.acts));
  check(ctxInfo.sel === '某番剧/第10集.mp4', '右键目标被标为选中', ctxInfo.sel);

  await page.keyboard.press('Escape');
  await sleep(100);
  check(await page.evaluate(() => document.getElementById('plCtx').classList.contains('hidden')), 'Esc 关闭菜单');

  console.log('\n— ③ 行内改名（F2） —');
  await row10.click();
  await sleep(150);
  await page.keyboard.press('F2');
  await sleep(120);
  const inInfo = await page.evaluate(() => {
    const i = document.querySelector('#plList .pl-rename-in');
    if(!i) return null;
    return {
      val: i.value,
      selStart: i.selectionStart,
      selEnd: i.selectionEnd,
      nmHidden: document.querySelector('#plList .pl-item[data-id="某番剧/第10集.mp4"] .pl-nm').classList.contains('hidden'),
      focused: document.activeElement === i
    };
  });
  check(!!inInfo, 'F2 在行内打开输入框');
  check(inInfo && inInfo.val === '第10集.mp4', '输入框预填当前文件名', inInfo && inInfo.val);
  check(inInfo && inInfo.focused, '输入框自动获得焦点');
  check(inInfo && inInfo.selEnd === '第10集'.length, '只选中主文件名（不含扩展名）', inInfo && (inInfo.selStart + '-' + inInfo.selEnd));
  check(inInfo && inInfo.nmHidden, '原文件名暂时隐藏');

  await page.fill('#plList .pl-rename-in', '第十集 重制版.mp4');
  await page.keyboard.press('Enter');
  await sleep(300);
  const afterRename = await page.evaluate(() => ({
    renamed: window.__renamed,
    ids: Array.from(document.querySelectorAll('#plList .pl-item')).map(r => r.dataset.id),
    names: Array.from(document.querySelectorAll('#plList .pl-item .pl-nm')).map(n => n.textContent),
    inputLeft: !!document.querySelector('#plList .pl-rename-in'),
    done: Array.from(document.querySelectorAll('#plList .pl-item')).filter(r => r.dataset.id === '某番剧/第十集 重制版.mp4').map(r => (r.querySelector('.pl-state') || {}).textContent)
  }));
  check(afterRename.renamed.length === 1 && afterRename.renamed[0].name === '第十集 重制版.mp4', '主进程收到新名字', JSON.stringify(afterRename.renamed));
  check(afterRename.ids.includes('某番剧/第十集 重制版.mp4'), '列表行的 id 已更新');
  check(!afterRename.inputLeft, '提交后输入框收起');
  check(afterRename.names.some(n => n === '第十集 重制版.mp4'), '列表显示新文件名');
  check(afterRename.done.some(t => t && t.indexOf('已看 14%') >= 0), '改名后「已看」进度跟着搬（状态迁移）', JSON.stringify(afterRename.done));

  console.log('\n— ④ 改名取消 / 失败回填 —');
  await page.locator('#plList .pl-item[data-id="某番剧/第2集.mp4"]').click();
  await sleep(120);
  await page.keyboard.press('F2');
  await sleep(100);
  await page.fill('#plList .pl-rename-in', '不该生效.mp4');
  await page.keyboard.press('Escape');
  await sleep(200);
  const cancelled = await page.evaluate(() => ({
    n: window.__renamed.length,
    stillThere: !!document.querySelector('#plList .pl-item[data-id="某番剧/第2集.mp4"]'),
    inputLeft: !!document.querySelector('#plList .pl-rename-in')
  }));
  check(cancelled.n === 1, 'Esc 取消不发起改名', 'n=' + cancelled.n);
  check(cancelled.stillThere && !cancelled.inputLeft, '取消后原名字恢复、输入框收起');

  console.log('\n— ⑤ 删除确认（Delete） —');
  await page.locator('#plList .pl-item[data-id="某番剧/第3集.mkv"]').click();
  await sleep(120);
  await page.keyboard.press('Delete');
  await sleep(150);
  const dlg = await page.evaluate(() => {
    const box = document.getElementById('plDialog');
    return {
      open: !box.classList.contains('hidden'),
      title: (document.getElementById('plDialogT') || {}).textContent || '',
      body: (document.getElementById('plDialogS') || {}).textContent || '',
      okText: (document.getElementById('plDialogOk') || {}).textContent || ''
    };
  });
  check(dlg.open, 'Delete 打开确认对话框');
  check(/回收站/.test(dlg.title) && dlg.body.indexOf('第3集.mkv') >= 0, '对话框说明是移到回收站并点名文件', dlg.title + ' / ' + dlg.body);
  check(dlg.okText === '移到回收站', '确认按钮文案明确', dlg.okText);

  await page.click('#plDialogCancel');
  await sleep(150);
  const afterCancel = await page.evaluate(() => ({
    hidden: document.getElementById('plDialog').classList.contains('hidden'),
    rows: document.querySelectorAll('#plList .pl-item').length,
    removed: window.__removed.length
  }));
  check(afterCancel.hidden, '取消后对话框关闭');
  check(afterCancel.rows === 4 && afterCancel.removed === 0, '取消不会删除文件', 'rows=' + afterCancel.rows);

  await page.keyboard.press('Delete');
  await sleep(150);
  await page.click('#plDialogOk');
  await sleep(400);
  const afterDel = await page.evaluate(() => ({
    removed: window.__removed,
    ids: Array.from(document.querySelectorAll('#plList .pl-item')).map(r => r.dataset.id),
    dlgHidden: document.getElementById('plDialog').classList.contains('hidden'),
    count: (document.getElementById('plCount') || {}).textContent || ''
  }));
  check(afterDel.removed.length === 1 && afterDel.removed[0][0] === '某番剧/第3集.mkv', '确认后主进程收到删除请求', JSON.stringify(afterDel.removed));
  check(afterDel.ids.length === 3 && afterDel.ids.indexOf('某番剧/第3集.mkv') < 0, '删除后列表少一行');
  check(afterDel.dlgHidden, '删除成功后对话框关闭');
  check(afterDel.count.indexOf('3') >= 0, '侧栏计数同步', afterDel.count);

  console.log('\n— ⑥ 菜单里的定位 / 复制 / 播放 —');
  await page.locator('#plList .pl-item[data-id="散片 01.webm"]').click({ button: 'right' });
  await sleep(120);
  await page.click('#plCtx [data-act="reveal"]');
  await sleep(150);
  check(await page.evaluate(() => window.__revealed === '散片 01.webm'), '「在文件夹中显示」调用主进程');
  check(await page.evaluate(() => document.getElementById('plCtx').classList.contains('hidden')), '点菜单项后菜单收起');

  await page.locator('#plList .pl-item[data-id="散片 01.webm"]').click({ button: 'right' });
  await sleep(120);
  await page.click('#plCtx [data-act="copy"]');
  await sleep(200);
  const osdText = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#plStage .pl-osd, .pl-osd'));
    return els.map(e => e.textContent).filter(Boolean).join(' | ');
  });
  check(/已复制文件名/.test(osdText), '「复制文件名」给出 OSD 反馈', osdText);

  console.log('\n— ⑦ 点空白处收起菜单 —');
  await page.locator('#plList .pl-item[data-id="某番剧/第2集.mp4"]').click({ button: 'right' });
  await sleep(120);
  check(await page.evaluate(() => !document.getElementById('plCtx').classList.contains('hidden')), '菜单已打开');
  await page.mouse.click(640, 400);
  await sleep(150);
  check(await page.evaluate(() => document.getElementById('plCtx').classList.contains('hidden')), '点击别处后菜单收起');

  console.log('\n— ⑧ 页面零错误 —');
  check(errors.length === 0, '没有 JS 报错', errors.join(' | '));

  await ctx.close();

  /* ============ 第二段：浏览器降级（无写盘能力） ============ */
  console.log('\n— ⑨ 浏览器降级：写盘入口收起 —');
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctxB.addInitScript(`
    window.openagiDesktop = {
      mediaList: async () => ({ ok: true, root: 'C:/x', files: ${JSON.stringify(ITEMS)}, folders: [], total: 0, totalMB: 0 }),
      onMediaProgress: () => {}
    };
  `);
  const pageB = await ctxB.newPage();
  const errorsB = [];
  pageB.on('pageerror', e => errorsB.push(String(e && e.message)));
  await pageB.goto(url);
  await pageB.waitForSelector('#playerWin', { state: 'attached' });
  await openPlayer(pageB);
  await pageB.locator('#plList .pl-item:first-child').click({ button: 'right' });
  await sleep(150);
  const deg = await pageB.evaluate(() => {
    const el = document.getElementById('plCtx');
    const vis = {};
    el.querySelectorAll('[data-act]').forEach(b => { vis[b.dataset.act] = !b.classList.contains('hidden'); });
    const sep = el.querySelector('.pl-ctx-sep');
    return { open: !el.classList.contains('hidden'), vis, sepHidden: sep && sep.classList.contains('hidden') };
  });
  check(deg.open, '降级环境也能右键');
  check(deg.vis.play && deg.vis.copy && !deg.vis.rename && !deg.vis.remove && !deg.vis.reveal, '只保留播放 / 复制文件名', JSON.stringify(deg.vis));
  check(!!deg.sepHidden, '不显示删除分隔线');

  await pageB.keyboard.press('F2');
  await sleep(150);
  const f2deg = await pageB.evaluate(() => ({
    input: !!document.querySelector('.pl-rename-in'),
    osd: Array.from(document.querySelectorAll('.pl-osd')).map(e => e.textContent).join(' | ')
  }));
  check(!f2deg.input && /不能改名|桌面版/.test(f2deg.osd), '降级环境 F2 不进入改名并给出提示', f2deg.osd);

  check(errorsB.length === 0, '降级环境零错误', errorsB.join(' | '));
  await ctxB.close();
  await browser.close();

  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
