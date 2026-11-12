/* 探针：投射烘焙「拖动没反应」的三条静默路径（js/md-proj-bake.js）
 * 用法：node tools/probe-projbake-drag.js > out.txt 2>&1
 *
 * 这三条以前全是**静默死路**：没有任何提示、没有绑定、也没有报错，
 * 用户唯一的感受就是「拖不动」。真实指针事件，直读窗口里的提示条与空态。
 *    A 没有原画时拖岛      → 必须提示「还没有原画」+ 空态闪一下 + 不能建绑定
 *    B 有原画但松手在右栏  → 必须提示「拖到左边原画上」+ 不能建绑定
 *    C 按下不动只是选岛    → 必须**不**提示（否则单击选岛一直冒黄条）
 * 输出必须重定向到文件再读（| tail 会吞退出码）。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const info = (name, extra) => console.log(' ·· ' + name + (extra ? ' · ' + extra : ''));

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.openDeskApp && window.openDeskApp('modeldesk'));
  await page.waitForTimeout(2800);

  /* UV 摊平：默认立方体每面铺满 0–1，6 个岛完全重叠，吸出来的点会互相压着 */
  await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const mesh = window.SeedModel.Scene.getMesh(doc);
    window.SeedUV.unwrap(mesh, { gap: 0.02 });
    if (window.SeedModel.Mesh.bump) window.SeedModel.Mesh.bump(mesh);
  });
  await page.evaluate(() => window.modelDesk.openProjBake());
  await page.waitForTimeout(900);
  check(await page.evaluate(() => !!document.getElementById('mdPbWin')), '投射烘焙窗口已打开');

  /* 工具：岛代表点 → 页面坐标；提示条 / 空态状态 */
  const probeView = () => page.evaluate(() => {
    const m = window.modelDesk.projBake();
    const d = m.__debug();
    const rc = document.getElementById('mdPbRight').getBoundingClientRect();
    const lc = document.getElementById('mdPbLeft').getBoundingClientRect();
    let from = null;
    for (const id of m.__islandIds()) {
      const q = m.__islandPoint(id);
      if (q && q[0] > 4 && q[1] > 4 && q[0] < rc.width - 4 && q[1] < rc.height - 4) { from = q; break; }
    }
    const tst = document.getElementById('mdPbToast');
    const emp = document.getElementById('mdPbLeftEmpty');
    return {
      from: from ? { x: rc.left + from[0], y: rc.top + from[1] } : null,
      leftC: { x: lc.left + lc.width / 2, y: lc.top + lc.height / 2 },
      inRight: { x: rc.left + rc.width * 0.5, y: rc.top + rc.height * 0.85 },
      src: d.src, bound: d.bound,
      toast: tst.textContent, toastOn: tst.classList.contains('on'),
      emptyHidden: emp.hidden, emptyAttn: emp.classList.contains('attn')
    };
  });

  const clearToast = () => page.evaluate(() => {
    const t = document.getElementById('mdPbToast');
    t.textContent = ''; t.classList.remove('on');
  });

  /* ---------- A · 没有原画时拖岛 ---------- */
  let v = await probeView();
  if (v.src) {
    await page.click('[data-pbact="srcClear"]');
    await page.waitForTimeout(200);
    v = await probeView();
  }
  check(!v.src, 'A 起始状态：没有原画', v.src ? '仍有原画' : 'src=null');
  check(v.emptyHidden === false, 'A 左栏显示「还没有原画」空态');
  check(!!v.from, 'A 找到了可拖的岛代表点');
  await clearToast();

  await page.mouse.move(v.from.x, v.from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(v.from.x + (v.leftC.x - v.from.x) * i / 6, v.from.y + (v.leftC.y - v.from.y) * i / 6);
    await page.waitForTimeout(35);
  }
  const midDrag = await probeView();
  info('A 拖动中', JSON.stringify({ attn: midDrag.emptyAttn, toast: midDrag.toastOn ? midDrag.toast : '(未弹)' }));
  check(midDrag.emptyAttn === true, 'A 拖动中左栏空态会闪一下（说明「你的拖动有被收到」）');
  await page.mouse.up();
  await page.waitForTimeout(200);
  v = await probeView();
  info('A 松手后', JSON.stringify({ toast: v.toast, on: v.toastOn, bound: v.bound }));
  check(v.toastOn && /还没有原画/.test(v.toast), 'A 松手有明确提示「还没有原画」', v.toast || '(空)');
  check(v.bound === 0, 'A 没有原画时不建绑定（不写脏数据）', '绑定数 ' + v.bound);
  check(v.emptyAttn === false, 'A 松手后空态停止闪动');

  /* ---------- B · 有原画，但松手在右栏 ---------- */
  await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const x = cv.getContext('2d');
    x.fillStyle = '#0000ff';
    x.fillRect(0, 0, 256, 256);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = cv.toDataURL('image/png'); });
    window.modelDesk.projBake().__setSrc(img);
  });
  await page.waitForTimeout(260);
  v = await probeView();
  check(!!v.src, 'B 原画已就位');
  check(v.emptyHidden === true, 'B 有原画后空态隐藏');
  await clearToast();

  await page.mouse.move(v.from.x, v.from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(v.from.x + 10, v.from.y + (v.inRight.y - v.from.y) * i / 5);
    await page.waitForTimeout(35);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  v = await probeView();
  info('B 松手后', JSON.stringify({ toast: v.toast, on: v.toastOn, bound: v.bound }));
  check(v.toastOn && /左边原画/.test(v.toast), 'B 松手在右栏时提示「拖到左边原画上」', v.toast || '(空)');
  check(v.bound === 0, 'B 没落到左栏就不该建绑定', '绑定数 ' + v.bound);

  /* ---------- C · 按下不动 = 选岛，不该弹提示 ---------- */
  await clearToast();
  await page.mouse.move(v.from.x, v.from.y);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(200);
  v = await probeView();
  info('C 单击后', JSON.stringify({ toast: v.toast, on: v.toastOn, sel: await page.evaluate(() => window.modelDesk.projBake().__debug().sel) }));
  check(v.toastOn === false, 'C 单击选岛不弹提示', v.toast || '(空)');
  check(v.bound === 0, 'C 单击选岛不建绑定', '绑定数 ' + v.bound);

  /* ---------- D · 正常拖到左栏仍然要能落位（别把主链路改坏） ---------- */
  await clearToast();
  v = await probeView();
  await page.mouse.move(v.from.x, v.from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(v.from.x + (v.leftC.x - v.from.x) * i / 8, v.from.y + (v.leftC.y - v.from.y) * i / 8);
    await page.waitForTimeout(35);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  v = await probeView();
  info('D 绑定', JSON.stringify(v.bound ? v.toast : null));
  check(v.bound > 0, 'D 有原画时拖到左栏仍能落位', '绑定数 ' + v.bound);

  check(errors.length === 0, '页面零错误', errors.slice(0, 3).join(' | ') || '0');

  await browser.close();
  console.log(fails ? ('\n❌ 失败 ' + fails + ' 项') : '\n✅ 全通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('探针崩了：', e); process.exit(1); });
