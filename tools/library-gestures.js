/* 图库手势回归（真实浏览器）
 *
 * 这一层是纯 DOM 交互，VM 单元测试覆盖不到，必须真起浏览器：
 *   ① 点选 / Ctrl 加选 —— 卡片本身要能选中，不是只有左上角复选框
 *   ② 框选 —— 空白处拖出矩形，相交的卡片被选中（遮罩不能被东西挡住）
 *   ③ 拖到垃圾桶 —— 拖拽幽灵跟手、垃圾桶 hover 高亮、松手走「确认 + 入回收站」
 *   ④ 中断清理 —— pointercancel / blur / Esc 都不能留残骸（幽灵、红色高亮）
 *
 * 说明：图库依赖桌面端 IPC 列资产，网页里没有 preload，
 * 所以这里在页面加载前注入一个假的 window.openagiDesktop 来喂数据。
 * ⚠ 桌面翻页是 3D 旋转（.52s），收敛期坐标会飘几像素——测试里禁掉该过渡，
 *   且每个手势前重新量卡片矩形，坐标才可预期。
 *
 * 用法：node tools/library-gestures.js
 */
const path = require('path');
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const ASSETS = Array.from({ length: 6 }, (_, i) => ({
  id: 'g' + (i + 1),
  kind: 'image',
  name: 'asset-' + (i + 1) + '.png',
  size: (i + 1) * 1024 * 512,
  created: 1e12 - i * 1000,
  missing: false,
  ext: 'png'
}));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // 假桌面端：只为图库提供数据，删除记到 window.__removed 里供断言
  await page.addInitScript(a => {
    const list = a;
    window.__removed = [];
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.openagiDesktop = {
      assetList: async () => ({ ok: true, assets: list, count: list.length }),
      assetStat: async () => ({
        ok: true, totalBytes: list.reduce((s, x) => s + x.size, 0), count: list.length,
        byKind: {
          image: { count: list.length, bytes: list.reduce((s, x) => s + x.size, 0) },
          model: { count: 0, bytes: 0 }
        },
        trashBytes: 0, trashCount: 0, root: 'C:\\fake\\assets'
      }),
      assetRead: async () => ({ ok: true, dataURL: PNG }),
      assetThumb: async () => ({ ok: false }),
      assetThumbSave: async () => ({ ok: true }),
      assetRemove: async ids => { window.__removed.push(ids.slice()); return { ok: true, moved: ids, failed: [] }; },
      assetImport: async () => ({ ok: true, imported: [] }),
      assetReconcile: async () => ({ ok: true, added: [], dropped: [] }),
      assetEmptyTrash: async () => ({ ok: true }),
      assetExport: async ids => ({ ok: true, files: ids, dir: 'C:\\out' })
    };
  }, ASSETS);

  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });

  await page.goto(APP, { waitUntil: 'load' });
  /* ⚠ 桌面工作台的 App 页带 3D 透视壳（.desk-pages / preserve-3d），
   * 多步手势序列下组合器命中测试会出现几像素漂移 + 偶发丢事件（隔离验证均正常）。
   * 手势逻辑与外壳无关：把窗口摘出来按普通 fixed 窗口测，结果才可复现。 */
  await page.waitForFunction(() => typeof window.openLibrary === 'function', null, { timeout: 15000 });
  await page.evaluate(() => openLibrary('image'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length >= 6, null, { timeout: 15000 });
  await page.evaluate(() => {
    const win = document.getElementById('libWin');
    document.body.appendChild(win);
    win.classList.remove('hidden');
    win.style.cssText = 'position:fixed;left:24px;top:24px;width:1040px;height:780px;' +
      'transform:none;z-index:99999;display:flex;opacity:1;visibility:visible;';
  });
  await page.waitForTimeout(500);

  // 每个手势前都重新量：选中态/缩略图加载都可能让网格微动
  const measure = () => page.evaluate(() => {
    return Array.from(document.querySelectorAll('#libBody .lib-card')).map(c => {
      const r = c.getBoundingClientRect();
      return { id: c.dataset.libId, left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    });
  });
  let rects = await measure();
  check(rects.length === 6, '图库渲染出 6 张卡片', 'count=' + rects.length);

  const center = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
  const clickCard = async r => { const c = center(r); await page.mouse.click(c.x, c.y); };
  const gapOf = (a, b) => ({ x: (a.right + b.left) / 2, y: a.top + a.h / 2 });
  const sel = () => page.evaluate(() => Array.from(libState.sel));
  const cleanState = () => page.evaluate(() => ({
    ghosts: document.querySelectorAll('.lib-drag-ghost').length,
    hot: (() => { const t = document.getElementById('libTrash'); return t && t.classList.contains('hot'); })(),
    dragging: document.querySelectorAll('#libBody .lib-card.dragging').length,
    marquee: document.querySelectorAll('.lib-marquee').length
  }));

  /* ---------- 1. 点选 ---------- */
  await clickCard(rects[0]);
  let s = await sel();
  check(s.length === 1 && s[0] === rects[0].id, '单击卡片即选中该卡片', JSON.stringify(s));

  await page.keyboard.down('Control');
  await clickCard(rects[1]);
  await page.keyboard.up('Control');
  s = await sel();
  check(s.length === 2, 'Ctrl+点击可加选', JSON.stringify(s));

  await page.keyboard.down('Control');
  await clickCard(rects[1]);
  await page.keyboard.up('Control');
  s = await sel();
  check(s.length === 1, 'Ctrl+再次点击可取消该卡片', JSON.stringify(s));

  // 垃圾桶：有选中项才显形（等过渡结束再读，别把动画中的半透明当失败）
  await page.waitForTimeout(320);
  const trashShown = await page.evaluate(() => {
    const t = document.getElementById('libTrash');
    if (!t) return { ok: false, reason: 'no-element' };
    const r = t.getBoundingClientRect();
    const w = document.getElementById('libWin').getBoundingClientRect();
    return {
      ok: true, visible: getComputedStyle(t).visibility, opacity: getComputedStyle(t).opacity,
      inside: r.left >= w.left && r.right <= w.right && r.bottom <= w.bottom,
      inBody: !!document.getElementById('libBody').querySelector('.lib-trashcan')
    };
  });
  check(trashShown.ok && trashShown.visible === 'visible' && Number(trashShown.opacity) > 0.5,
    '有选中项时右下角垃圾桶显形', JSON.stringify(trashShown));
  check(trashShown.inside, '垃圾桶固定在窗口内（右下角）');
  check(!trashShown.inBody, '垃圾桶不在 libBody 内（否则重绘就被清掉）');

  // 浮动选中条：挂窗口、随选中显形、不占排版
  const selbar = await page.evaluate(() => {
    const b = document.getElementById('libSelBar');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
      shown: b.classList.contains('show'),
      inBody: !!document.getElementById('libBody').querySelector('.lib-selbar'),
      onScreen: r.width > 0 && r.height > 0
    };
  });
  check(selbar && selbar.shown && selbar.onScreen, '浮动选中条随选中显形', JSON.stringify(selbar));
  check(selbar && !selbar.inBody, '选中条不在 libBody 流里（否则框选时网格会跳动）');

  /* ---------- 2. 框选 ---------- */
  rects = await measure();
  // 先清空选择：点一下卡片之间的空隙（属于 .lib-grid 的空白区）
  const gap = gapOf(rects[0], rects[1]);
  await page.mouse.click(gap.x, gap.y);
  s = await sel();
  check(s.length === 0, '点空白处清空选择', JSON.stringify(s));

  // 从空隙横向拖到第 3 张卡片右下角 → 应框住第 2、3 张
  rects = await measure();
  const gap2 = gapOf(rects[0], rects[1]);
  const target = { x: rects[2].right - 3, y: rects[2].bottom - 3 };
  await page.mouse.move(gap2.x, gap2.y);
  await page.mouse.down();
  await page.mouse.move(gap2.x + 30, gap2.y + 10, { steps: 4 });
  const marqueeAlive = await page.evaluate(() => !!document.querySelector('.lib-marquee'));
  await page.mouse.move(target.x, target.y, { steps: 12 });
  const marqueeRect = await page.evaluate(() => {
    const m = document.querySelector('.lib-marquee');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), pe: getComputedStyle(m).pointerEvents };
  });
  await page.mouse.up();
  s = await sel();
  check(marqueeAlive, '拖拽时出现框选遮罩');
  check(marqueeRect && marqueeRect.w > 20 && marqueeRect.h > 20, '遮罩尺寸跟随指针', JSON.stringify(marqueeRect));
  check(marqueeRect && marqueeRect.pe === 'none', '遮罩不吃指针事件（否则选到一半就断了）', marqueeRect && marqueeRect.pe);
  check(s.length >= 2 && s.indexOf(rects[1].id) >= 0, '框选选中矩形内的卡片', JSON.stringify(s));
  const leftover = await page.evaluate(() => !!document.querySelector('.lib-marquee'));
  check(!leftover, '松手后遮罩被移除');

  /* ---------- 3. 拖到垃圾桶删除 ---------- */
  rects = await measure();
  const dragFrom = center(rects[1]);
  const trash = await page.evaluate(() => {
    const r = document.getElementById('libTrash').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const beforeSel = await sel();

  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 20, dragFrom.y + 20, { steps: 4 });
  const ghost = await page.evaluate(() => !!document.querySelector('.lib-drag-ghost'));
  await page.mouse.move(trash.x, trash.y, { steps: 14 });
  const hot = await page.evaluate(() => document.getElementById('libTrash').classList.contains('hot'));
  await page.mouse.up();
  await page.waitForTimeout(600);

  check(ghost, '拖拽时出现「几项 · 拖到垃圾桶删除」幽灵');
  check(hot, '拖到垃圾桶上方时垃圾桶高亮');
  check(dialogs.length > 0, '松手后仍走确认（资产不能一松手就没）', dialogs[0] && dialogs[0].slice(0, 40));
  const removed = await page.evaluate(() => window.__removed);
  check(removed.length === 1 && removed[0].length === beforeSel.length,
    '确认后把拖拽的这批送去回收站', JSON.stringify(removed));
  s = await sel();
  check(s.length === 0, '删除后选择被清空');

  /* ---------- 4. 手势中断必须清理干净 ----------
   * 用户实测：拖拽被 pointercancel/失焦打断后，「N 项 · 拖到垃圾桶删除」幽灵
   * 和红色高亮的垃圾桶一直留在页面上。这里逐个中断路径验一遍。 */

  // 4a. pointercancel：拖到一半被系统打断
  rects = await measure();
  await clickCard(rects[0]);
  let c = center(rects[0]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y + 20, { steps: 4 });
  let st = await cleanState();
  check(st.ghosts === 1, '中断前幽灵存在（前提）', JSON.stringify(st));
  await page.evaluate(() => window.dispatchEvent(new Event('pointercancel')));
  st = await cleanState();
  check(st.ghosts === 0 && !st.hot && st.dragging === 0, 'pointercancel 后幽灵/高亮/拖拽态全部清掉', JSON.stringify(st));
  await page.mouse.up();   // 迟到的 pointerup 不能报错、不能误删

  // 4b. 窗口失焦：拖到一半切走
  rects = await measure();
  c = center(rects[1]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y + 20, { steps: 4 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  st = await cleanState();
  check(st.ghosts === 0 && !st.hot && st.dragging === 0, 'blur 后清理干净', JSON.stringify(st));
  await page.mouse.up();

  // 4c. Esc 中止框选
  rects = await measure();
  const gap3 = gapOf(rects[0], rects[1]);
  await page.mouse.move(gap3.x, gap3.y);
  await page.mouse.down();
  await page.mouse.move(gap3.x + 60, gap3.y + 40, { steps: 4 });
  await page.keyboard.press('Escape');
  st = await cleanState();
  check(st.marquee === 0, 'Esc 中止框选后遮罩被移除', JSON.stringify(st));
  await page.mouse.up();

  // 4d. 拖到半路松手（不在垃圾桶上）：幽灵消失、不触发删除
  const removedBefore = await page.evaluate(() => window.__removed.length);
  rects = await measure();
  c = center(rects[2]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 6 });
  await page.mouse.up();
  st = await cleanState();
  const removedAfter = await page.evaluate(() => window.__removed.length);
  check(st.ghosts === 0 && !st.hot, '半路松手幽灵消失、垃圾桶不高亮', JSON.stringify(st));
  check(removedAfter === removedBefore, '半路松手不触发删除');

  // 收尾：幽灵总数必须归零（用户截图里就是残留了多个）
  const finalSt = await cleanState();
  check(finalSt.ghosts === 0, '页面上没有残留的拖拽幽灵', JSON.stringify(finalSt));

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
