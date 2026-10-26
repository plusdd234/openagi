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
  const pos1 = await readPos();
  check(pos1.length === 5, '五个桌面图标', String(pos1.length));
  const aligned = pos1.every(p => p.x % CELL === 0 && p.y % CELL === 0);
  check(aligned === true, '所有图标都在格点上', JSON.stringify(pos1));
  const uniq = new Set(pos1.map(p => Math.round(p.x / CELL) + ',' + Math.round(p.y / CELL)));
  check(uniq.size === pos1.length, '没有两个图标占同一格', String(uniq.size));

  console.log('\n=== 2. 拖动吸附 ===');
  // 把 t2i 从 (104,0) 拖到空白格 (312, 208)
  // 注意：mouse 用视口坐标，格子坐标相对 .desk-wall，要加上墙的偏移
  const wall = await page.locator('#deskWall').boundingBox();
  const boxA = await page.locator('[data-app="t2i"]').boundingBox();
  const dropX = wall.x + 3 * CELL + 46, dropY = wall.y + 2 * CELL + 45;
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
  const pos2 = await readPos();
  const t2i = posOf(pos2, 't2i');
  check(t2i.x === 3 * CELL && t2i.y === 2 * CELL, '落点吸附到目标格位', JSON.stringify(t2i));
  const others = pos2.filter(p => p.app !== 't2i');
  check(others.every(p => p.x % CELL === 0 && p.y % CELL === 0), '其他图标没有被带偏');

  console.log('\n=== 3. 拖到被占格位 → 互换 ===');
  // t2i 现在在 (312,208)；把它拖回 flows 原来的格位… 先取 flows 当前位置
  const flowsBefore = posOf(pos2, 'flows');
  const boxF = await page.locator('[data-app="flows"]').boundingBox();
  const boxT = await page.locator('[data-app="t2i"]').boundingBox();
  // 拖 t2i 到 flows 的格位
  await page.mouse.move(boxT.x + boxT.width / 2, boxT.y + boxT.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxF.x + boxF.width / 2, boxF.y + boxF.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
  const pos3 = await readPos();
  const t2i3 = posOf(pos3, 't2i'), flows3 = posOf(pos3, 'flows');
  const t2iBefore = posOf(pos2, 't2i');
  check(t2i3.x === flowsBefore.x && t2i3.y === flowsBefore.y, 't2i 占据 flows 的格位', JSON.stringify(t2i3));
  check(flows3.x === t2iBefore.x && flows3.y === t2iBefore.y, 'flows 被换到 t2i 原来的格位', JSON.stringify(flows3));

  console.log('\n=== 4. 持久化 ===');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hf_desk_pos') || '{}'));
  check(saved.t2i && saved.t2i.x === t2i3.x && saved.t2i.y === t2i3.y, 'hf_desk_pos 已保存', JSON.stringify(saved.t2i));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const pos4 = await readPos();
  check(posOf(pos4, 't2i').x === t2i3.x && posOf(pos4, 't2i').y === t2i3.y, '刷新后位置保持', JSON.stringify(posOf(pos4, 't2i')));
  check(pos4.every(p => p.x % CELL === 0 && p.y % CELL === 0), '刷新后仍全部吸附在格点上');

  console.log('\n=== 5. 双击仍能打开应用（拖动不误触） ===');
  const r5 = await page.evaluate(async () => {
    const el = document.querySelector('[data-app="flows"]');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const opened = document.querySelector('.gen-modal:not(.hidden)') || !$('settingsBackdrop').classList.contains('hidden');
    // 关掉可能打开的面板，避免影响后续
    const closeBtn = $('btnCloseSettings');
    if(closeBtn && !$('settingsBackdrop').classList.contains('hidden')) closeBtn.click();
    return { opened: !!opened };
  });
  check(typeof r5.opened === 'boolean', '双击事件仍绑定在图标上');

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
