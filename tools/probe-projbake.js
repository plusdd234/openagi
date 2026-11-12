/* 探针：投射烘焙编辑器（js/md-proj-bake.js）
 * 用法：node tools/probe-projbake.js > out.txt 2>&1
 *
 * 测的是「用户那条路能不能走通」，不是「函数存不存在」：
 *   打开 → 有 UV 岛 → 右侧画出相机着色 → 真的用鼠标把岛拖到左边 →
 *   点烘焙 → 贴图真的变了颜色（原画的纯蓝被采进 UV 区域）。
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

  /* 1. 走真实入口进建模 App */
  await page.evaluate(() => window.openDeskApp && window.openDeskApp('modeldesk'));
  await page.waitForTimeout(2800);
  const hasDoc = await page.evaluate(() => !!(window.modelDesk && window.modelDesk.getState().hasDoc));
  check(hasDoc, '建模 App 已打开且有文档');
  check(await page.evaluate(() => typeof window.modelDesk.openProjBake === 'function'), 'openProjBake 已暴露');

  /* 1.5 先把 UV 摊平：默认立方体的兜底 UV 是「每个面铺满 0–1」（6 个岛完全重叠），
   * 那种 UV 下烘焙一个岛必然盖满整图，测不出「只采到岛的区域」。
   * 真实 AI 资产都有正常 UV，这里用内核自己的展开把场景对齐到真实情况。 */
  const unwrapped = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const mesh = window.SeedModel.Scene.getMesh(doc);
    const r = window.SeedUV.unwrap(mesh, { gap: 0.02 });
    if (window.SeedModel.Mesh.bump) window.SeedModel.Mesh.bump(mesh);
    return r ? r.islands : 0;
  });
  info('UV 已展开排布', unwrapped + ' 个岛');

  /* 2. 打开投射烘焙 */
  const opened = await page.evaluate(() => window.modelDesk.openProjBake());
  await page.waitForTimeout(900);
  check(opened === true, '投射烘焙窗口可打开', String(opened));
  check(await page.evaluate(() => !!document.getElementById('mdPbWin')), '窗口 DOM 存在');
  const hasLR = await page.evaluate(() => !!(document.getElementById('mdPbLeft') && document.getElementById('mdPbRight')));
  check(hasLR, '左右两块画布都在');

  let d = await page.evaluate(() => window.modelDesk.projBake().__debug());
  info('状态', JSON.stringify({ islands: d.islands, cam: d.cam, camInfo: d.camInfo, cache: d.cache, left: d.left, right: d.right }));
  check(d.islands > 0, '网格有 UV 岛', '岛屿数 ' + d.islands);
  check(!!d.cam && d.cam.w > 32, '抓到了当前摄像机的渲染图', d.cam ? d.cam.w + '×' + d.cam.h : 'null');
  check(!!d.idMap && d.idMap.w > 32, '拾取用的 id 位图已生成', d.idMap ? d.idMap.w + '×' + d.idMap.h : 'null');
  check(!!d.camInfo, '右栏统计已生成', d.camInfo);

  /* 3. 右栏 = 当前视角画面 + 岛边界线（画面几乎铺满，所以数青色边界像素） */
  const rightPixels = await page.evaluate(() => {
    const c = document.getElementById('mdPbRight');
    const cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    const x = cv.getContext('2d');
    x.drawImage(c, 0, 0);
    const d2 = x.getImageData(0, 0, cv.width, cv.height).data;
    let cyan = 0, lit = 0, total = cv.width * cv.height;
    for (let i = 0; i < d2.length; i += 4) {
      if (d2[i] + d2[i + 1] + d2[i + 2] > 45) lit++;
      if (d2[i] < 170 && d2[i + 1] > 150 && d2[i + 2] > 175) cyan++;
    }
    return { cyan, lit, total, litRatio: +(lit / total).toFixed(3) };
  });
  info('右栏像素', JSON.stringify(rightPixels));
  check(rightPixels.litRatio > 0.05, '右栏画出了当前视角的画面', (rightPixels.litRatio * 100).toFixed(1) + '%');
  /* 只画露在外面的段：立方体 6 个岛里相机只看得到 2–3 个，像素数不会多 */
  check(rightPixels.cyan > 60, '右栏画出了可见的 UV 岛边界线', rightPixels.cyan + ' 个描边像素');

  /* 4. 塞一张纯蓝原画（纯色便于断言「采样真的到了贴图上」） */
  const srcOk = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const x = cv.getContext('2d');
    x.fillStyle = '#0000ff';
    x.fillRect(0, 0, 256, 256);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = cv.toDataURL('image/png'); });
    window.modelDesk.projBake().__setSrc(img);
    return true;
  });
  check(srcOk, '原画已就位（纯蓝 256×256）');
  await page.waitForTimeout(260);
  const leftPx = await page.evaluate(() => {
    const c = document.getElementById('mdPbLeft');
    const cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    const x = cv.getContext('2d');
    x.drawImage(c, 0, 0);
    const d2 = x.getImageData(0, 0, cv.width, cv.height).data;
    let blue = 0;
    for (let i = 0; i < d2.length; i += 4) if (d2[i + 2] > 180 && d2[i] < 80) blue++;
    return blue;
  });
  /* 语义已经变了：左栏是**合成结果**（底图 = 模型这一槽的旧贴图），
   * 原画只在「拖岛进来」的那一刻铺出来当素材（选材模式）。
   * 所以这里断言的是反过来的事：没拖层之前，左栏不该出现原画。 */
  check(leftPx < 200, '左栏显示的是合成底图，不是原画本身（原画只在选材时铺出来）', '蓝色像素 ' + leftPx);

  /* 5. 真鼠标：右栏某个岛 → 拖到左栏中间 */
  const geo = await page.evaluate(() => {
    const m = window.modelDesk.projBake();
    const pickIsland = (mod) => {
      const ids = mod.__islandIds();
      for (const id of ids) { const q = mod.__islandPoint(id); if (q && q[0] > 4 && q[1] > 4) return q; }
      return [40, 40];
    };
    const st = m.__debug();
    const b = st.islandBounds;
    /* 岛包围盒中心 → 右栏屏幕坐标（用模块自己的换算，和绘制同一把尺子） */
    const p = pickIsland(m);
    const rc = document.getElementById('mdPbRight').getBoundingClientRect();
    const lc = document.getElementById('mdPbLeft').getBoundingClientRect();
    return {
      from: { x: rc.left + p[0], y: rc.top + p[1] },
      to: { x: lc.left + lc.width / 2, y: lc.top + lc.height / 2 },
      bounds: b
    };
  });
  info('拖动路径', JSON.stringify(geo.from) + ' → ' + JSON.stringify(geo.to));
  await page.mouse.move(geo.from.x, geo.from.y);
  await page.waitForTimeout(120);
  const hovered = await page.evaluate(() => window.modelDesk.projBake().__debug().hover);
  info('悬停命中的岛 id', String(hovered));
  check(hovered >= 0, '鼠标悬停能命中岛', String(hovered));

  await page.mouse.down();
  await page.waitForTimeout(80);
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      geo.from.x + (geo.to.x - geo.from.x) * i / 8,
      geo.from.y + (geo.to.y - geo.from.y) * i / 8
    );
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(260);
  d = await page.evaluate(() => window.modelDesk.projBake().__debug());
  check(d.bound > 0, '拖到左栏后建立绑定', '绑定数 ' + d.bound);
  info('绑定内容', JSON.stringify(d.binds));

  /* 6. 点「烘焙」（走真实按钮） */
  const beforeUrl = await page.evaluate(() => {
    const m = window.modelDesk.getDocument().materials;
    return (m && m.slotMaps && m.slotMaps[0]) || '';
  });
  await page.click('[data-pbact="bake"]');
  await page.waitForTimeout(1200);
  /* 切片二之后：烘焙 = 推一层编辑层，**不写 slotMaps**。
   * 所以这里量两样东西：贴图有没有被动（应该没动）＋ 合成结果有没有那一块蓝。 */
  const after = await page.evaluate(async (beforeUrl) => {
    const doc = window.modelDesk.getDocument();
    const m = doc.materials;
    const url = (m && m.slotMaps && m.slotMaps[0]) || '';
    const stack = window.TexStack ? window.TexStack.__debug(doc, 0) : null;
    let blue = 0, total = 0, w = 0, h = 0;
    if (window.TexStack && window.TexStack.has(doc, 0)) {
      const r = window.TexSource ? window.TexSource.resolveBase(0) : { img: null, from: '', url: '' };
      const cv2 = window.TexStack.edited(doc, 0, { base: r.img, baseKey: r.from + '|' + r.url });
      if (cv2) {
        w = cv2.width; h = cv2.height; total = w * h;
        const px = cv2.getContext('2d').getImageData(0, 0, w, h).data;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 2] > 150 && px[i] < 90 && px[i + 3] > 200) blue++;
        }
      }
    }
    return { url, same: url === beforeUrl, blue, total, w, h, stack };
  }, beforeUrl);
  info('烘焙后', JSON.stringify({ w: after.w, h: after.h, blue: after.blue, total: after.total, ops: after.stack && after.stack.n }));
  check(after.same, '投射不写贴图（slotMaps 哈希不变）');
  check(after.stack && after.stack.n === 1, '多了一层投射（编辑层栈）', JSON.stringify(after.stack));
  check(after.blue > 0, '原画的蓝真的采进了合成结果', '蓝色像素 ' + after.blue);
  check(after.blue / after.total < 0.9, '只填了被绑定的岛，没把整张刷成纯色', (after.blue / after.total * 100).toFixed(1) + '%');

  /* 7. 固化为底图：写进贴图 + 层清空 + 像素与合成结果等价 */
  await page.click('[data-pbact="flatten"]');
  await page.waitForTimeout(900);
  const flat = await page.evaluate(async (prevBlue) => {
    const doc = window.modelDesk.getDocument();
    const m = doc.materials;
    const url = (m && m.slotMaps && m.slotMaps[0]) || '';
    const stack = window.TexStack ? window.TexStack.__debug(doc, 0) : null;
    if (!url) return { url: '', ops: stack && stack.n, blue: 0 };
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = url; });
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const x = cv.getContext('2d');
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, cv.width, cv.height).data;
    let blue = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 150 && px[i] < 90) blue++;
    return { url, ops: stack && stack.n, blue, prevBlue, w: cv.width, h: cv.height };
  }, after.blue);
  info('固化后', JSON.stringify({ w: flat.w, h: flat.h, blue: flat.blue, ops: flat.ops }));
  check(flat.url && flat.url !== beforeUrl, '固化把合成结果写进了贴图');
  check(flat.ops === 0, '固化之后层清空', 'ops=' + flat.ops);
  /* 像素等价：蓝的多寡不该因为「合并」而变（±8% 容忍编码 / 缩放差） */
  check(flat.blue > 0 && Math.abs(flat.blue - after.blue) / Math.max(1, after.blue) < 0.08,
    '固化前后像素等价', after.blue + ' → ' + flat.blue);

  /* 7b. 撤销固化 → 贴图回退、层回来 */
  await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(600);
  const un1 = await page.evaluate((beforeUrl) => {
    const doc = window.modelDesk.getDocument();
    const url = (doc.materials.slotMaps || [])[0] || '';
    const stack = window.TexStack ? window.TexStack.__debug(doc, 0) : null;
    return { url, ops: stack && stack.n };
  }, beforeUrl);
  info('撤销固化', JSON.stringify({ same: un1.url === beforeUrl, ops: un1.ops }));
  check(un1.url === beforeUrl, 'Ctrl+Z 撤销固化：贴图回到固化前');
  check(un1.ops === 1, 'Ctrl+Z 撤销固化：投射层回来了', 'ops=' + un1.ops);

  /* 7c. 再撤销一次 → 投射本身被撤销 */
  await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(600);
  const un2 = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const stack = window.TexStack ? window.TexStack.__debug(doc, 0) : null;
    return { ops: stack && stack.n };
  });
  check(un2.ops === 0, 'Ctrl+Z 能撤销这次烘焙', 'ops=' + un2.ops);

  /* 8. 关窗不炸 + 页面零错误 */
  await page.click('[data-pbact="close"]');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => !document.getElementById('mdPbWin')), '窗口能正常关闭');
  check(errors.length === 0, '页面零错误', errors.slice(0, 3).join(' | ') || '0');

  await browser.close();
  console.log(fails ? ('\n❌ 失败 ' + fails + ' 项') : '\n✅ 全通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('探针崩了：', e); process.exit(1); });
