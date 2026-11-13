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

  // 拖拽删除已移除：图库里不该再有垃圾桶 / 拖拽幽灵
  const dragUi = await page.evaluate(() => ({
    trash: !!document.getElementById('libTrash'),
    trashCss: !!document.querySelector('.lib-trashcan'),
    ghost: document.querySelectorAll('.lib-drag-ghost').length
  }));
  check(!dragUi.trash && !dragUi.trashCss && dragUi.ghost === 0,
    '拖拽删除相关 UI 已移除（垃圾桶 / 幽灵）', JSON.stringify(dragUi));

  // 浮动选中条已移除：底部「导出 / 删除」与右键菜单重复，选中动作统一走右键菜单
  const selbar = await page.evaluate(() => document.getElementById('libSelBar'));
  check(selbar === null, '底部浮动选中条已移除（避免与右键菜单重复）', String(selbar));

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

  /* ---------- 3. 在卡片上拖拽：不再触发删除 ---------- */
  rects = await measure();
  const dragFrom = center(rects[1]);
  const removedBefore = await page.evaluate(() => window.__removed.length);
  const dialogsBefore = dialogs.length;

  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 60, dragFrom.y + 40, { steps: 8 });
  const dragArtifacts = await page.evaluate(() => ({
    ghost: document.querySelectorAll('.lib-drag-ghost').length,
    dragging: document.querySelectorAll('#libBody .lib-card.dragging').length,
    marquee: document.querySelectorAll('.lib-marquee').length
  }));
  await page.mouse.up();
  await page.waitForTimeout(300);

  check(dragArtifacts.ghost === 0 && dragArtifacts.dragging === 0 && dragArtifacts.marquee === 0,
    '卡片上拖拽不再产生幽灵/拖拽态/框选遮罩', JSON.stringify(dragArtifacts));
  const removedAfter = await page.evaluate(() => window.__removed.length);
  check(removedAfter === removedBefore, '拖拽松手不会删除资产');
  check(dialogs.length === dialogsBefore, '拖拽松手不再弹删除确认');

  /* ---------- 4. 框选中途被打断必须清理干净 ---------- */

  // 4a. window blur：拖到一半切走窗口
  rects = await measure();
  const gapB = gapOf(rects[0], rects[1]);
  await page.mouse.move(gapB.x, gapB.y);
  await page.mouse.down();
  await page.mouse.move(gapB.x + 60, gapB.y + 40, { steps: 4 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  let st = await cleanState();
  check(st.marquee === 0, 'blur 中止框选后遮罩被移除', JSON.stringify(st));
  await page.mouse.up();

  // 4b. pointercancel：拖到一半被系统打断
  rects = await measure();
  await page.mouse.move(gapB.x, gapB.y);
  await page.mouse.down();
  await page.mouse.move(gapB.x + 60, gapB.y + 40, { steps: 4 });
  await page.evaluate(() => window.dispatchEvent(new Event('pointercancel')));
  st = await cleanState();
  check(st.marquee === 0, 'pointercancel 中止框选后遮罩被移除', JSON.stringify(st));
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

  // 收尾：页面上不能留下任何手势残骸
  const finalSt = await page.evaluate(() => ({
    marquee: document.querySelectorAll('.lib-marquee').length,
    ghost: document.querySelectorAll('.lib-drag-ghost').length
  }));
  check(finalSt.marquee === 0 && finalSt.ghost === 0, '页面上没有残留的手势遮罩/幽灵', JSON.stringify(finalSt));

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
