/* 多视图 · 两种描边（UV 岛 / 外轮廓）回归
 * 假桥 + 真 GLB，零 Electron / 零网络。
 * 覆盖：
 *   1) 底色回归：底色从 WebGL 清屏搬到 2D 落脚之后，不透明底仍然实心
 *      （这一条是给「为了拿 alpha 改清屏」那次改动兜底的）
 *   2) UV 描边：关着没有品红像素、开着有；返回值 uv.edges / hasUV / drawn
 *   3) 外轮廓：关着没有深色描边像素、开着有；返回值 outline
 *   4) 多视图 App：两个勾选框都在、都能触发出图，且能同时开
 *   5) 页面零错误
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
const GLB = path.join(__dirname, '..', 'assets', 'models', 'mvv9621p-9e37196e.glb');

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

/* 在页面里数像素：mode=solid + 白底 → 除了两种描边色，画面里只有白色 */
async function renderStats(page, src, opts) {
  const png = await page.evaluate(async (args) => {
    const s = args[0], o = args[1];
    const r = await Model3D.viewGrid(s, Object.assign({
      views: ['front'], cell: 512, cols: 1, gap: 0,
      mode: 'solid', wire: false, cam: 'ortho',
      transparent: false, bgColor: '#ffffff', labels: false
    }, o));
    window.__last = { uv: r.uv, outline: r.outline, crease: r.crease };
    return r.png;
  }, [src, opts]);
  const pix = await page.evaluate(async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      /* #ff2d78：红高、绿低、蓝居中 */
      if (d[i] > 195 && d[i + 1] < 150 && d[i + 2] > 60 && d[i + 2] < 205) magenta++;
      /* #171a20 外轮廓：三通道都压得很低 */
      if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 80) dark++;
    }
    const corner = Array.from(x.getImageData(2, 2, 1, 1).data);
    return { magenta, dark, corner };
  }, png);
  return { pix, info: await page.evaluate(() => window.__last) };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const glbDataURL = 'data:model/gltf-binary;base64,' + fs.readFileSync(GLB).toString('base64');
  const assets = [{
    id: 'uvm-1', kind: 'model', ext: 'glb', name: '角色.glb',
    size: fs.statSync(GLB).size, created: Date.now(), updated: Date.now(), source: 'test'
  }];

  await page.addInitScript(([list, dataURL]) => {
    window.openagiDesktop = {
      assetList: async () => ({ ok: true, assets: list }),
      assetStat: async () => ({ ok: true, count: list.length, totalBytes: 0, byKind: { model: { count: list.length, bytes: 0 }, image: { count: 0, bytes: 0 } }, trashBytes: 0, trashCount: 0 }),
      assetRead: async id => (id === list[0].id ? { ok: true, dataURL } : { ok: false, error: 'not found' }),
      assetThumb: async () => ({ ok: false }),
      assetThumbSave: async () => ({ ok: true }),
      assetPut: async req => ({ ok: true, asset: { id: 'x', kind: req.kind, name: req.name } }),
      assetRemove: async () => ({ ok: true })
    };
    try { localStorage.removeItem('hf_mv_set'); } catch (e) {}
  }, [assets, glbDataURL]);

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Model3D !== 'undefined' && Model3D.ready(), null, { timeout: 20000 });

  console.log('=== 1. 底色（改清屏之后的回归） ===');
  const plain = await renderStats(page, glbDataURL, {});
  check('不透明底的四角是实心白', plain.pix.corner[3] === 255 && plain.pix.corner[0] === 255, JSON.stringify(plain.pix.corner));
  check('不开描边时没有深色像素', plain.pix.dark === 0, String(plain.pix.dark));
  check('不开描边时没有品红像素', plain.pix.magenta === 0, String(plain.pix.magenta));

  console.log('=== 2. UV 描边 ===');
  const uvOn = await renderStats(page, glbDataURL, { uvEdge: true });
  check('勾上后出现品红描边像素', uvOn.pix.magenta > 400, String(uvOn.pix.magenta));
  check('uv.edges > 0', !!uvOn.info.uv && uvOn.info.uv.edges > 0, JSON.stringify(uvOn.info.uv));
  check('uv.hasUV / drawn 都为真', !!uvOn.info.uv && uvOn.info.uv.hasUV === true && uvOn.info.uv.drawn === true, JSON.stringify(uvOn.info.uv));

  /* 线宽是「像素」不是「世界单位」：加粗一倍，描边像素数应该跟着涨一大截。
   * 顺带证明线是实心连续的——重心坐标那版在密集网格上会断成虚线，像素数根本不跟线宽走。 */
  const thin = await renderStats(page, glbDataURL, { uvEdge: true, lineWidth: 1.2 });
  const thick = await renderStats(page, glbDataURL, { uvEdge: true, lineWidth: 3.0 });
  check('线宽加粗后描边像素明显变多（等宽可控）', thick.pix.magenta > thin.pix.magenta * 1.4,
    JSON.stringify({ thin: thin.pix.magenta, thick: thick.pix.magenta }));

  console.log('=== 2b. 角度线框 ===');
  /* 子集关系：阈值 0 应该画满（≈ 普通线框），阈值越高线越少，90° 只剩直角以上的硬边。
   * 全都用 dark（#2b2b2b / 深色线）像素数比：白底 + 纯色模式下没有别的深色来源。 */
  const plainWire = await renderStats(page, glbDataURL, { wire: true });
  const deg0 = await renderStats(page, glbDataURL, { wireAngle: true, wireAngleDeg: 0 });
  const deg30 = await renderStats(page, glbDataURL, { wireAngle: true, wireAngleDeg: 30 });
  const deg90 = await renderStats(page, glbDataURL, { wireAngle: true, wireAngleDeg: 90 });
  check('阈值 0 时画的是全量边（量级与普通线框相当）',
    deg0.pix.dark > plainWire.pix.dark * 0.5 && deg0.pix.dark < plainWire.pix.dark * 2.2,
    JSON.stringify({ plain: plainWire.pix.dark, deg0: deg0.pix.dark }));
  check('阈值 30° 明显比 0° 少（是普通线框的真子集）', deg30.pix.dark < deg0.pix.dark * 0.9,
    JSON.stringify({ deg0: deg0.pix.dark, deg30: deg30.pix.dark }));
  check('阈值 90° 只剩硬边，但仍要画', deg90.pix.dark < deg30.pix.dark && deg90.pix.dark > 150,
    JSON.stringify({ deg30: deg30.pix.dark, deg90: deg90.pix.dark }));
  check('返回值带回阈值与边数', !!deg30.info.crease && deg30.info.crease.deg === 30 &&
    deg30.info.crease.edges > 0 && deg30.info.crease.edges < deg0.info.crease.edges,
    JSON.stringify({ d30: deg30.info.crease, d0: deg0.info.crease }));

  console.log('=== 3. 外轮廓 ===');
  const olOn = await renderStats(page, glbDataURL, { outline: true });
  check('勾上后出现深色外轮廓像素', olOn.pix.dark > 300, String(olOn.pix.dark));
  check('返回值 outline = true', olOn.info.outline === true, JSON.stringify(olOn.info.outline));
  check('外轮廓不会带出品红（两种描边互不串）', olOn.pix.magenta === 0, String(olOn.pix.magenta));

  const both = await renderStats(page, glbDataURL, { outline: true, uvEdge: true });
  check('两种描边能同时开', both.pix.dark > 300 && both.pix.magenta > 400, JSON.stringify({ d: both.pix.dark, m: both.pix.magenta }));

  /* 外轮廓在透明底上也要在（App 默认就是透明底） */
  const trans = await renderStats(page, glbDataURL, { outline: true, transparent: true });
  check('透明底也能描出外轮廓', trans.pix.dark > 300, String(trans.pix.dark));
  check('透明底四角是透明的', trans.pix.corner[3] === 0, JSON.stringify(trans.pix.corner));

  console.log('=== 4. 多视图 App ===');
  /* 本机 localStorage 里的 hf_mv_set 会被 js/config.js 的 hydrate 从工程存档水合回来，
   * 光删不干净——这里直接写一份确定值，再让 open() 按它回填控件。 */
  await page.evaluate(() => {
    localStorage.setItem('hf_mv_set', JSON.stringify({
      views: ['front', 'left', 'right'], mode: 'solid', wire: false,
      uvEdge: false, outline: false, cam: 'ortho', cell: 512, labels: false
    }));
  });
  await page.evaluate(() => window.multiview.open());
  await page.waitForSelector('#mvList [data-mv-id]', { state: 'attached', timeout: 10000 });
  const boxes = await page.evaluate(() => ({
    uv: !!document.querySelector('#mvUvEdge'),
    ol: !!document.querySelector('#mvOutline'),
    uvOff: document.querySelector('#mvUvEdge').checked === false,
    olOff: document.querySelector('#mvOutline').checked === false
  }));
  check('工具条里有「UV 描边」', boxes.uv);
  check('工具条里有「外轮廓」', boxes.ol);
  check('两个都默认不勾', boxes.uvOff && boxes.olOff);
  const abox = await page.evaluate(() => ({
    box: !!document.querySelector('#mvAngleWire'),
    slider: !!document.querySelector('#mvWireAngle'),
    off: document.querySelector('#mvAngleWire') && document.querySelector('#mvAngleWire').checked === false
  }));
  check('工具条里有「角度线框」且默认不勾', abox.box && abox.off);
  check('精细面板里有折角阈值滑条', abox.slider);

  await page.evaluate(() => document.querySelector('#mvList [data-mv-id]').click());
  await page.waitForFunction(() => {
    const img = document.querySelector('#mvOut');
    return img && (img.getAttribute('src') || '').indexOf('data:image/png') === 0;
  }, null, { timeout: 90000 });

  await page.evaluate(() => {
    for (const id of ['#mvUvEdge', '#mvOutline']) {
      const b = document.querySelector(id);
      if (b && !b.checked) { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  });
  await page.waitForFunction(() => {
    const t = document.querySelector('#mvInfo').textContent || '';
    return t.indexOf('UV 描边') >= 0 && t.indexOf('外轮廓') >= 0;
  }, null, { timeout: 90000 });
  const info = await page.evaluate(() => document.querySelector('#mvInfo').textContent);
  check('摘要同时标出两种描边', info.indexOf('UV 描边') >= 0 && info.indexOf('外轮廓') >= 0, info);

  /* 角度线框：勾上它必须把普通线框踢掉（两者互斥），滑条改了要重渲并写进摘要 */
  await page.evaluate(() => {
    const w = document.querySelector('#mvWire');
    if (!w.checked) { w.checked = true; w.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.evaluate(() => {
    const b = document.querySelector('#mvAngleWire');
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => (document.querySelector('#mvInfo').textContent || '').indexOf('角度线框') >= 0, null, { timeout: 90000 });
  const ex = await page.evaluate(() => ({
    wire: document.querySelector('#mvWire').checked,
    angle: document.querySelector('#mvAngleWire').checked,
    info: document.querySelector('#mvInfo').textContent
  }));
  check('勾「角度线框」会自动取消「线框」', ex.angle === true && ex.wire === false, JSON.stringify(ex));
  check('摘要标出「角度线框 ≥30°」', ex.info.indexOf('≥30°') >= 0, ex.info);

  await page.evaluate(() => {
    const r = document.querySelector('#mvWireAngle');
    r.value = '70';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => (document.querySelector('#mvInfo').textContent || '').indexOf('≥70°') >= 0, null, { timeout: 90000 });
  check('拖阈值滑条会重渲并更新摘要', true);
  await page.evaluate(() => {
    const b = document.querySelector('#mvAngleWire');
    b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* 回到两种描边的状态，给后面「出图里两种线都在」用 */
  await page.evaluate(() => {
    const b = document.querySelector('#mvUvEdge');
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1200);

  const appPix = await page.evaluate(async () => {
    const src = document.querySelector('#mvOut').getAttribute('src');
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      if (d[i] > 195 && d[i + 1] < 150 && d[i + 2] > 60 && d[i + 2] < 205) magenta++;
      if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 80) dark++;
    }
    return { magenta, dark };
  });
  check('App 出图里两种描边都在', appPix.magenta > 100 && appPix.dark > 100, JSON.stringify(appPix));

  console.log('=== 5. 3D 预览里的 UV 描边 ===');
  await page.evaluate((src) => Model3D.openPreview(src, { title: '角色.glb', uvEdge: true }), glbDataURL);
  await page.waitForTimeout(1500);
  const pv = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.mv3-bar button')).find(b => b.textContent === 'UV 描边');
    return { btn: !!btn, on: btn ? btn.style.borderColor : '', hint: (document.querySelector('.mv3-bar span') || {}).textContent || '' };
  });
  check('预览工具条有「UV 描边」按钮且已生效', pv.btn && pv.hint.indexOf('接缝') >= 0, JSON.stringify(pv));
  await page.evaluate(() => Model3D.closePreview());

  console.log('=== 6. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})().catch(e => { console.error('崩了：', e); process.exit(1); });
