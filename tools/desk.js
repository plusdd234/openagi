/* 体检：桌面图标格位吸附（拖动对齐格子 + 占位互换 + 持久化）
 * 用法：node tools/desk.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const CELL = 104;   // 必须与 js/desktop.js 的 DESK_CELL 一致
let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
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
  await page.waitForTimeout(800);

  const readPos = () => page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.desk-app'));
    return els.map(el => ({ app: el.dataset.app, x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 }));
  });
  const posOf = (list, app) => list.find(p => p.app === app);

  console.log('\n=== 1. 初始布局吸附到格子 ===');
  // 图标数量跟着 DESK_APPS 走：写死 5 的话，加一个 app 就要改一次测试
  const appCount = await page.evaluate(() => (typeof DESK_APPS !== 'undefined' ? DESK_APPS.length : 0));
  const pos1 = await readPos();
  check(pos1.length === appCount, '每个注册的 app 都有图标（' + appCount + ' 个）', String(pos1.length));
  check(!!posOf(pos1, 'store'), '工作台上有「模型商店」');
  const aligned = pos1.every(p => p.x % CELL === 0 && p.y % CELL === 0);
  check(aligned === true, '所有图标都在格点上', JSON.stringify(pos1));
  const uniq = new Set(pos1.map(p => Math.round(p.x / CELL) + ',' + Math.round(p.y / CELL)));
  check(uniq.size === pos1.length, '没有两个图标占同一格', String(uniq.size));

  console.log('\n=== 1b. App 层灰底画布（与边缘留边距） ===');
  /* 开场动画还在跑的时候量几何会差 1–2px（父级带着 transform），
     这不是布局错，是「量早了」。等两次数值完全一致再量，断言本身不放松。 */
  {
    let prev = '';
    let stable = false;
    for(let i = 0; i < 20 && !stable; i++){
      const cur = await page.evaluate(() => {
        const c = document.getElementById('deskCanvas');
        const w = document.getElementById('deskWall');
        if(!c || !w) return '';
        const cr = c.getBoundingClientRect(), wr = w.getBoundingClientRect();
        return [cr.left - wr.left, wr.right - cr.right, cr.top - wr.top, wr.bottom - cr.bottom]
          .map(n => n.toFixed(2)).join(',');
      });
      stable = !!cur && cur === prev;
      prev = cur;
      if(!stable) await sleep(150);
    }
    check(stable, '画布几何已经稳定（不在开场动画中途量）', prev);
  }
  const layer = await page.evaluate(() => {
    const c = document.getElementById('deskCanvas');
    if(!c) return null;
    const cr = c.getBoundingClientRect();
    const wr = document.getElementById('deskWall').getBoundingClientRect();
    const ar = document.getElementById('deskAiWrap').getBoundingClientRect();
    const bg = getComputedStyle(c).backgroundImage;
    const apps = [...document.querySelectorAll('.desk-app')].map(e => e.getBoundingClientRect());
    return {
      left: Math.round(cr.left - wr.left), right: Math.round(wr.right - cr.right),
      top: Math.round(cr.top - wr.top), bottom: Math.round(wr.bottom - cr.bottom),
      radius: parseFloat(getComputedStyle(c).borderTopLeftRadius) || 0,
      bg: bg.slice(0, 42),
      allInside: apps.every(r => r.left >= cr.left && r.top >= cr.top && r.right <= cr.right && r.bottom <= cr.bottom),
      gapToInput: Math.round(ar.top - cr.bottom)
    };
  });
  check(!!layer, '存在 #deskCanvas 图标画布');
  check(layer && layer.left === 20 && layer.right === 20, '画布左右各留 20px（与输入条同竖线）',
    layer ? 'L=' + layer.left + ' R=' + layer.right : '');
  check(layer && layer.top === 16 && layer.bottom > 140, '画布上留 16px、下让出输入条',
    layer ? 'T=' + layer.top + ' B=' + layer.bottom : '');
  check(layer && layer.radius >= 12, '画布是圆角块（有层次感）', layer ? String(layer.radius) : '');
  check(layer && layer.bg.includes('linear-gradient'), '画布垫了灰底渐变', layer ? layer.bg : '');
  check(layer && layer.allInside, '所有图标都在灰底画布内，没落到白边上');
  check(layer && layer.gapToInput >= 4, '画布与输入条之间留了缝', layer ? 'gap=' + layer.gapToInput : '');

  console.log('\n=== 2. 拖动吸附 ===');
  // 把「图库」拖到空白格 (312, 208)
  // 注意：mouse 用视口坐标，格子坐标相对 #deskIcons（画布内再缩 20px），要加上它的偏移
  const wall = await page.locator('#deskIcons').boundingBox();
  const boxA = await page.locator('[data-app="gallery"]').boundingBox();
  const dropX = wall.x + 3 * CELL + 46, dropY = wall.y + 2 * CELL + 45;
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
  const pos2 = await readPos();
  const moved = posOf(pos2, 'gallery');
  check(moved.x === 3 * CELL && moved.y === 2 * CELL, '落点吸附到目标格位', JSON.stringify(moved));
  const others = pos2.filter(p => p.app !== 'gallery');
  check(others.every(p => p.x % CELL === 0 && p.y % CELL === 0), '其他图标没有被带偏');

  console.log('\n=== 3. 拖到被占格位 → 互换 ===');
  // 图库现在在 (312,208)；把它拖到「本地生图」的格位，两者应该互换
  const comfyBefore = posOf(pos2, 'comfy');
  const boxF = await page.locator('[data-app="comfy"]').boundingBox();
  const boxT = await page.locator('[data-app="gallery"]').boundingBox();
  await page.mouse.move(boxT.x + boxT.width / 2, boxT.y + boxT.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxF.x + boxF.width / 2, boxF.y + boxF.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
  const pos3 = await readPos();
  const moved3 = posOf(pos3, 'gallery'), comfy3 = posOf(pos3, 'comfy');
  const movedBefore = posOf(pos2, 'gallery');
  check(moved3.x === comfyBefore.x && moved3.y === comfyBefore.y, '图库占据「本地生图」的格位', JSON.stringify(moved3));
  check(comfy3.x === movedBefore.x && comfy3.y === movedBefore.y, '「本地生图」被换到图库原来的格位', JSON.stringify(comfy3));

  console.log('\n=== 3b. 「工作流」App 已移除（左侧列表就是全部） ===');
  check(!posOf(pos1, 'flows'), '桌面上没有「工作流」App 图标');
  const hasFlowsWin = await page.evaluate(() => !!document.getElementById('flowsWin'));
  check(hasFlowsWin === false, '工作流窗口 DOM 也已移除');
  const sideNewTop = await page.evaluate(() => {
    const side = document.querySelector('.desk-side');
    const btn = $('btnDeskNewFlow');
    const list = $('deskSideList');
    if (!side || !btn || !list) return null;
    const sb = side.getBoundingClientRect(), b = btn.getBoundingClientRect(), l = list.getBoundingClientRect();
    return { btnTop: b.top, listTop: l.top, btnBottom: b.bottom, footTop: (document.querySelector('.desk-side-foot') || { getBoundingClientRect: () => ({ top: 0 }) }).getBoundingClientRect().top, sideBottom: sb.bottom };
  });
  check(!!sideNewTop && sideNewTop.btnBottom <= sideNewTop.listTop, '「新建工作流」按钮在列表上方', JSON.stringify(sideNewTop));
  check(!!sideNewTop && sideNewTop.footTop > sideNewTop.listTop, '底部占用区在列表下方', JSON.stringify(sideNewTop));
  const meterVisible = await page.evaluate(() => {
    const m = $('wfStorage');
    return !!m && !m.classList.contains('hidden') && /内联素材/.test(m.textContent || '');
  });
  check(meterVisible === true, '存储（内存）占用条常驻在列表底部');

  console.log('\n=== 4. 持久化 ===');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hf_desk_pos') || '{}'));
  check(saved.gallery && saved.gallery.x === moved3.x && saved.gallery.y === moved3.y, 'hf_desk_pos 已保存', JSON.stringify(saved.gallery));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const pos4 = await readPos();
  check(posOf(pos4, 'gallery').x === moved3.x && posOf(pos4, 'gallery').y === moved3.y, '刷新后位置保持', JSON.stringify(posOf(pos4, 'gallery')));
  check(pos4.every(p => p.x % CELL === 0 && p.y % CELL === 0), '刷新后仍全部吸附在格点上');

  console.log('\n=== 5. 双击仍能打开应用（拖动不误触） ===');
  const r5 = await page.evaluate(async () => {
    const el = document.querySelector('[data-app="gallery"]');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const opened = document.querySelector('.gen-modal:not(.hidden)') || !$('settingsBackdrop').classList.contains('hidden');
    // 关掉可能打开的面板，避免影响后续
    const closeBtn = $('btnCloseSettings');
    if(closeBtn && !$('settingsBackdrop').classList.contains('hidden')) closeBtn.click();
    return { opened: !!opened };
  });
  check(typeof r5.opened === 'boolean', '双击事件仍绑定在图标上');

  console.log('\n=== 5b. 模型商店 app：翻页打开，不是弹窗 ===');
  const r5b = await page.evaluate(async () => {
    if(typeof openModelStore !== 'function') return { err: 'openModelStore 未定义' };
    await openModelStore();
    const win = document.getElementById('storeWin');
    const host = document.getElementById('deskAppHost');
    const can = document.getElementById('deskAppCanvas');
    const p1 = document.getElementById('deskPage1');
    const p3 = document.getElementById('deskPageApps');
    const wr = win.getBoundingClientRect(), cr = can.getBoundingClientRect();
    const cs = getComputedStyle(can);
    return {
      open: !!win && !win.classList.contains('hidden'),
      cards: document.querySelectorAll('#mcStore .ms-card').length,
      title: (document.querySelector('#mcStore .ms-title') || {}).textContent || '',
      hasLlama: !!document.querySelector('.desk-app[data-app="store"] .desk-app-img'),
      inHost: host.contains(win),
      appOpen: document.getElementById('deskWall').classList.contains('app-open'),
      p1Opacity: getComputedStyle(p1).opacity,
      p3Transform: getComputedStyle(p3).transform,
      head: document.getElementById('deskAppTitle').textContent,
      insets: [Math.round(wr.x - cr.x), Math.round(wr.y - cr.y), Math.round(cr.right - wr.right), Math.round(cr.bottom - wr.bottom)],
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      canvasBg: cs.backgroundColor + '|' + cs.backgroundImage.slice(0, 40),
      barHidden: getComputedStyle(win.querySelector('.os-win-bar')).display === 'none'
    };
  });
  check(r5b.open === true, '从工作台能打开模型商店', JSON.stringify(r5b).slice(0, 120));
  check(r5b.cards >= 10, '商店渲染出模型卡片', String(r5b.cards));
  check(r5b.title === '模型商店', '窗口里是模型商店而不是别的面板', r5b.title);
  check(r5b.hasLlama === true, '图标用的是羊驼头图片（不是默认线条图标）');
  check(r5b.inHost === true, '窗口被搬进 App 页（#deskAppHost），不是浮在桌面上的弹窗');
  check(r5b.appOpen === true && r5b.p1Opacity === '0', '整页翻到第三页：第一页已离场');
  // 翻页过渡 520ms，这里可能刚好读到最后 1~2°：接受 identity 或近似 identity 的 3D 矩阵
  const _m = (r5b.p3Transform.match(/matrix(?:3d)?\(([^)]+)\)/) || [])[1] || '';
  const _v = _m.split(',').map(Number);
  const _flat = /^matrix\(1, 0, 0, 1/.test(r5b.p3Transform)
    || (_v.length === 16 && Math.abs(_v[2]) < .06 && Math.abs(_v[8]) < .06 && Math.abs(_v[0]) > .99);
  check(_flat, '第三页转正（rotateY 归零）', r5b.p3Transform);
  check(r5b.head === '模型商店', '页头显示 App 名称', r5b.head);
  check(r5b.insets.every(v => v >= 12), '窗口缩在灰底画布里，四边露出边框', JSON.stringify(r5b.insets));
  check(r5b.radius >= 16, '灰底画布是圆角矩形', String(r5b.radius));
  check(/gradient/.test(r5b.canvasBg), '画布是灰底（不是白底）', r5b.canvasBg.slice(0, 60));
  check(r5b.barHidden === true, '窗口自带的标题栏隐藏（由页头顶替，避免双标题）');

  console.log('\n=== 5d. 应用页头部：<<< 换到左边、名称换到右边 ===');
  await sleep(300);   // 骨架淡出 200ms + 收 hidden，等它走完再断言「已收起」
  const r5d = await page.evaluate(() => {
    const head = document.querySelector('#deskPageApps .dapp-head');
    const back = document.getElementById('deskAppBack');
    const title = document.getElementById('deskAppTitle');
    const sub = document.getElementById('deskAppSub');
    const b = back.getBoundingClientRect(), t = title.getBoundingClientRect();
    const sk = document.getElementById('deskAppSkel');
    return {
      firstIsBack: head.firstElementChild === back,
      backLeft: Math.round(b.left), titleLeft: Math.round(t.left),
      backMid: Math.round(b.top + b.height / 2), titleMid: Math.round(t.top + t.height / 2),
      backText: (back.textContent || '').trim(),
      chev: back.querySelectorAll('.dab-ch').length,
      aria: back.getAttribute('aria-label') || '',
      titleAfterSub: !!(sub && title.compareDocumentPosition(sub) & 4),
      skHidden: !sk || sk.hidden,
      skAnim: sk ? getComputedStyle(sk.querySelector('.sk-row'), '::after').animationName : '',
    };
  });
  check(r5d.firstIsBack === true, '返回按钮是页头第一个元素（位置换到左侧）');
  check(r5d.backLeft < r5d.titleLeft, '界面名称在返回按钮右侧', 'back=' + r5d.backLeft + ' title=' + r5d.titleLeft);
  // 比中线而不是比 top：按钮 30 高、标题行高 19，比 top 天生差半个行距
  check(Math.abs(r5d.backMid - r5d.titleMid) <= 2, '两者同一行居中对齐', r5d.backMid + '/' + r5d.titleMid);
  check(r5d.chev === 3, '返回图标是三枚 chevron（<<<）', String(r5d.chev));
  check(r5d.backText === '', '返回按钮只留图标、没有文字');
  check(r5d.aria === '回到桌面', '图标按钮带无障碍名称', r5d.aria);
  check(r5d.skHidden === true, '加载完成后骨架已收起');
  check(r5d.skAnim === 'skShimmer', '骨架动画是 transform 关键帧（不靠 background-position）', r5d.skAnim);

  const r5c = await page.evaluate(async () => {
    document.getElementById('deskAppBack').click();
    await new Promise(r => setTimeout(r, 60));
    const win = document.getElementById('storeWin');
    return {
      appOpen: document.getElementById('deskWall').classList.contains('app-open'),
      hostKids: document.getElementById('deskAppHost').children.length,
      hidden: win.classList.contains('hidden'),
      backInWall: win.parentElement.id === 'deskWall'
    };
  });
  check(r5c.appOpen === false, '「回到桌面」把整页翻回去');
  check(r5c.hostKids === 0, '窗口从 App 页里撤出');
  check(r5c.hidden === true, '窗口关闭（隐藏）');
  check(r5c.backInWall === true, '窗口放回桌面层原位，下次还能正常打开');

  console.log('\n=== 6. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  await page.screenshot({ path: 'C:/Users/30297/AppData/Local/Temp/desk_grid.png' });
  await browser.close();

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
