/* 探针：投射烘焙的映射方向对不对（四象限原画 + 球体）
 * 用法：node tools/probe-projbake-map.js > out.txt 2>&1
 *
 * 为什么单独一个：主探针只证明「蓝色进了贴图」，证明不了「进对了位置」。
 * 这里用一张四象限色图（左上红 / 右上绿 / 左下蓝 / 右下黄），把岛拖到某个象限，
 * 再回到贴图上读该岛包围盒中心的颜色 —— 颜色对得上才说明 UV ↔ 原画的映射
 * （尤其是 V 轴要不要翻转）是对的。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-projbake-map');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const info = (n, e) => console.log(' ·· ' + n + (e ? ' · ' + e : ''));

const QUAD = `
  (function(){
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
    const x = cv.getContext('2d');
    x.fillStyle = '#ff0000'; x.fillRect(0,0,256,256);
    x.fillStyle = '#00ff00'; x.fillRect(256,0,256,256);
    x.fillStyle = '#0000ff'; x.fillRect(0,256,256,256);
    x.fillStyle = '#ffff00'; x.fillRect(256,256,256,256);
    x.strokeStyle = '#000'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(256,0); x.lineTo(256,512); x.moveTo(0,256); x.lineTo(512,256); x.stroke();
    return cv.toDataURL('image/png');
  })()`;

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.openDeskApp && window.openDeskApp('modeldesk'));
  await page.waitForTimeout(2800);

  /* 新建一个球体：面数够高才看得出重投影质量，也才有「曲面」的透视。
   * 点 shelf 图标只是打开基础体面板并选中球体页签，还得点面板里的「创建」。 */
  await page.click('[data-md-prim="sphere"]');
  await page.waitForTimeout(500);
  await page.click('[data-md-act="prim-create"]');
  await page.waitForTimeout(1400);
  const st0 = await page.evaluate(() => window.modelDesk.getState());
  info('球体', JSON.stringify({ v: st0.vertices, f: st0.faces }));
  check(st0.faces > 100, '球体已建立（面数够测重投影）', st0.faces + ' 面');

  /* 展开排布，保证岛互不重叠 */
  const unwrapped = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const mesh = window.SeedModel.Scene.getMesh(doc);
    const r = window.SeedUV.unwrap(mesh, { gap: 0.03 });
    if (window.SeedModel.Mesh.bump) window.SeedModel.Mesh.bump(mesh);
    return r ? r.islands : 0;
  });
  info('展开后岛数', String(unwrapped));
  /* 球体的球面展开本来就是「一个连续岛」，不是多个 —— 这里只要求有岛 */
  check(unwrapped >= 1, '球体 UV 已展开', String(unwrapped));

  /* 把相机对准当前对象（真实用户也会先框显一下再投射） */
  await page.keyboard.press('f');
  await page.waitForTimeout(700);

  /* 把相机摆到正面（默认就是），打开投射烘焙 */
  await page.evaluate(() => window.modelDesk.openProjBake());
  await page.waitForTimeout(1000);
  let d = await page.evaluate(() => window.modelDesk.projBake().__debug());
  info('着色', d.camInfo + ' / cam ' + (d.cam ? d.cam.w + '×' + d.cam.h : 'null') + ' / 覆盖 ' + (d.coverage * 100).toFixed(1) + '%');
  check(/当前视角/.test(d.camInfo || ''), '右栏是当前视角画面', d.camInfo);

  /* 窗口内按 F 必须能把对象框显（提示条写着「按 F」，按下去就得有效果） */
  const covBefore = d.coverage;
  await page.keyboard.press('f');
  await page.waitForTimeout(900);
  d = await page.evaluate(() => window.modelDesk.projBake().__debug());
  info('按 F 之后覆盖率', (d.coverage * 100).toFixed(1) + '%（之前 ' + (covBefore * 100).toFixed(1) + '%）');
  check(d.coverage > Math.max(0.3, covBefore * 1.4), '窗口内按 F 能框显对象并重抓', (d.coverage * 100).toFixed(1) + '%');

  /* 右栏颜色多样性：相机着色应该是有明暗层次的，不该是单色块 */
  const variety = await page.evaluate(() => {
    const c = document.getElementById('mdPbRight');
    const cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height;
    const x = cv.getContext('2d'); x.drawImage(c, 0, 0);
    const d2 = x.getImageData(0, 0, cv.width, cv.height).data;
    const set = new Set();
    for (let i = 0; i < d2.length; i += 4 * 17) {
      if (d2[i] < 60 && d2[i + 1] < 60 && d2[i + 2] < 60) continue; /* 底色/暗部不计 */
      set.add((d2[i] >> 3) + ',' + (d2[i + 1] >> 3) + ',' + (d2[i + 2] >> 3));
    }
    return set.size;
  });
  info('右栏色阶数', String(variety));
  check(variety > 12, '右栏是相机着色（有明暗层次，不是单色块）', variety + ' 个色阶');

  /* 塞四象限原画 */
  await page.evaluate((dataUrl) => {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => { window.modelDesk.projBake().__setSrc(img); res(); };
      img.src = dataUrl;
    });
  }, await page.evaluate(QUAD));
  await page.waitForTimeout(300);

  /* 依次把「同一个岛」拖到四个象限，每次烘焙后读贴图该岛中心的颜色 */
  const targets = [
    { name: '左上(红)', fx: 0.25, fy: 0.25, want: [255, 0, 0] },
    { name: '右下(黄)', fx: 0.75, fy: 0.75, want: [255, 255, 0] },
    { name: '右上(绿)', fx: 0.75, fy: 0.25, want: [0, 255, 0] },
    { name: '左下(蓝)', fx: 0.25, fy: 0.75, want: [0, 0, 255] }
  ];
  for (const t of targets) {
    const geo = await page.evaluate(() => {
      const m = window.modelDesk.projBake();
      const pickIsland = (mod) => {
        const ids = mod.__islandIds();
        for (const id of ids) { const q = mod.__islandPoint(id); if (q && q[0] > 4 && q[1] > 4) return q; }
        return [40, 40];
      };
      const s = m.__debug();
      const b = s.islandBounds;
      const p = pickIsland(m);
      const rc = document.getElementById('mdPbRight').getBoundingClientRect();
      const lc = document.getElementById('mdPbLeft').getBoundingClientRect();
      return { from: { x: rc.left + p[0], y: rc.top + p[1] }, lc: { x: lc.left, y: lc.top, w: lc.width, h: lc.height } };
    });
    const to = { x: geo.lc.x + geo.lc.w * t.fx, y: geo.lc.y + geo.lc.h * t.fy };
    await page.mouse.move(geo.from.x, geo.from.y);
    await page.waitForTimeout(120);
    const hv = await page.evaluate(() => window.modelDesk.projBake().__debug().hover);
    info('  按下点', JSON.stringify(geo.from) + ' 命中岛 ' + hv);
    await page.mouse.down();
    await page.waitForTimeout(60);
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(geo.from.x + (to.x - geo.from.x) * i / 6, geo.from.y + (to.y - geo.from.y) * i / 6);
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    await page.waitForTimeout(220);
    const bd = await page.evaluate(() => window.modelDesk.projBake().__debug());
    info('  绑定/选中', JSON.stringify({ bound: bd.bound, binds: bd.binds, sel: bd.sel, hover: bd.hover }));
    await page.click('[data-pbact="bake"]');
    await page.waitForTimeout(900);

    const got = await page.evaluate(async () => {
      const doc = window.modelDesk.getDocument();
      const info = window.modelDesk.projBake().__debug();
      const b = info.islandBounds;
      /* 切片二：烘焙写进「编辑层栈」，不写 slotMaps。
       * 取样对象必须是**合成结果**（底座 ⊕ 投射层），否则量到的是没变的旧贴图。 */
      let cv = null;
      if (window.TexStack && window.TexStack.has(doc, 0)) {
        const r0 = window.TexSource ? window.TexSource.resolveBase(0) : { img: null, from: '', url: '' };
        cv = window.TexStack.edited(doc, 0, { base: r0.img, baseKey: r0.from + '|' + r0.url });
      }
      if (!cv) {
        const url = (doc.materials.slotMaps || [])[0] || '';
        if (!url) return { r: 0, g: 0, b: 0, px: 0, py: 0, w: 0, h: 0 };
        const img = new Image();
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = url; });
        cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
      }
      const x = cv.getContext('2d');
      /* 岛包围盒中心 → 贴图像素（v 向上：py = (1-v)*H） */
      const px = Math.round(b.cu * cv.width);
      const py = Math.round((1 - b.cv) * cv.height);
      const d2 = x.getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data;
      let r = 0, g = 0, bl = 0, n = 0;
      for (let i = 0; i < d2.length; i += 4) { r += d2[i]; g += d2[i + 1]; bl += d2[i + 2]; n++; }
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(bl / n), px, py, w: cv.width, h: cv.height };
    });
    const dist = Math.abs(got.r - t.want[0]) + Math.abs(got.g - t.want[1]) + Math.abs(got.b - t.want[2]);
    check(dist < 120, '拖到' + t.name + ' → 贴图该岛中心是对应颜色',
      'rgb(' + got.r + ',' + got.g + ',' + got.b + ') 期望 rgb(' + t.want.join(',') + ') 距离 ' + dist);
  }

  /* 截图：整窗 + 单独右栏 */
  const shotWin = await RUN.shot(page.locator('#mdPbWin'), 'pb-window.png');
  const shotFull = await RUN.shot(page, 'pb-full.png');
  if (shotWin || shotFull) info('截图', [shotWin, shotFull].filter(Boolean).join(' / '));

  check(errors.length === 0, '页面零错误', errors.slice(0, 3).join(' | ') || '0');
  await browser.close();
  console.log(fails ? ('\n❌ 失败 ' + fails + ' 项') : '\n✅ 全通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('探针崩了：', e); process.exit(1); });
