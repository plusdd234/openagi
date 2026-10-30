// 模型库 UV 查看功能验收：真实模型 + 真 WebGL，截图 + 状态断言
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8137;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.obj': 'text/plain' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.goto('http://127.0.0.1:' + PORT + '/index.html?nostore=1', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof ModelTex !== 'undefined', null, { timeout: 10000 });

  // 桌面桥桩：只给资产库要用到的接口
  // 贴图持久化要验证「设置贴图 → 关掉 → 重开贴图还在」，所以桩里备一张图片资产
  const TEST_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.evaluate((TEST_IMG) => {
    const put = {};
    window.__put = put;
    window.openagiDesktop = {
      assetList: async () => ({ assets: [
        { id: 'm1', kind: 'model', name: '少女身体.obj', ext: 'obj', size: 7362705, created: Date.now() },
        { id: 'img-test', kind: 'image', name: '测试贴图.png', ext: 'png', size: 68, created: Date.now() - 1000 }
      ] }),
      assetStat: async () => ({ count: 2, totalBytes: 7362773, byKind: { model: { count: 1, bytes: 7362705 }, image: { count: 1, bytes: 68 } }, root: 'C:/tmp', trashBytes: 0, trashCount: 0 }),
      assetRead: async (id) => {
        if (id === 'img-test') return { ok: true, kind: 'image', dataURL: TEST_IMG };
        const r = await fetch('/assets/models/mvu6nqhf-c24e23e7.obj');
        const b = await r.blob();
        const dataURL = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
        return { ok: true, dataURL };
      },
      assetPut: async (req) => {
        const id = 'img-' + (Object.keys(put).length + 1);
        put[id] = req;
        return { ok: true, asset: { id, kind: req.kind, name: req.name } };
      },
      assetThumb: async () => ({ ok: false }),
      assetThumbSave: async () => ({ ok: true })
    };
  }, TEST_IMG);

  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => libState.assets.length > 0, null, { timeout: 10000 });

  const cards = await page.evaluate(() => document.querySelectorAll('#libBody [data-lib-uv]').length);
  console.log('卡片 UV 入口:', cards);

  // 双击进 3D：必须是库窗口内的浮层，而不是另开窗口
  await page.dblclick('#libBody .lib-card');
  await page.waitForFunction(() => libMv.open && (() => {
    const cv = document.querySelector('#libMvHost canvas');
    return cv && cv.width > 0 && cv.clientWidth > 0;
  })(), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const mv = await page.evaluate(() => ({
    inWin: !!document.querySelector('#libWin #libMv'),
    visible: !document.querySelector('#libMv').classList.contains('hidden'),
    viewWinHidden: document.querySelector('#modelViewWin').classList.contains('hidden'),
    canvas: (() => { const c = document.querySelector('#libMvHost canvas'); return c ? c.clientWidth + 'x' + c.clientHeight : ''; })()
  }));
  console.log('3D 内嵌:', JSON.stringify(mv));
  await page.locator('#libWin').screenshot({ path: path.join(__dirname, '_mv_inapp.png') });
  await page.click('#libMv [data-mv-act="close"]');
  await page.waitForFunction(() => !libMv.open && !document.querySelector('#libMvHost'), null, { timeout: 10000 });
  const mvClosed = await page.evaluate(() => document.querySelector('#libMv').classList.contains('hidden'));
  console.log('3D 关闭回到网格:', mvClosed);

  // ---- 贴图持久化：设置 → 关闭 → 重开贴图还在 ----
  await page.evaluate(() => localStorage.removeItem('openagi_model_tex_v1'));
  await page.dblclick('#libBody .lib-card');
  await page.waitForFunction(() => libMv.open && document.querySelector('#libMvHost canvas'), null, { timeout: 30000 });
  await page.locator('#libMvHost button:has-text("材质插槽")').click();
  await page.locator('#libMvHost button:has-text("设置贴图")').first().click();
  await page.locator('#libMvHost button:has-text("从图库选择")').click();
  await page.waitForSelector('#libMvHost [title="测试贴图.png"]', { timeout: 10000 });
  await page.click('#libMvHost [title="测试贴图.png"]');
  await page.waitForFunction(() => {
    const j = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}');
    return !!(j.m1 && Object.keys(j.m1).length);
  }, null, { timeout: 10000 });
  const cfg1 = await page.evaluate(() => localStorage.getItem('openagi_model_tex_v1'));
  console.log('贴图配置已写入:', cfg1);

  await page.click('#libMv [data-mv-act="close"]');
  await page.waitForFunction(() => !libMv.open, null, { timeout: 10000 });
  await page.dblclick('#libBody .lib-card');
  await page.waitForFunction(() => libMv.open && document.querySelector('#libMvHost canvas'), null, { timeout: 30000 });
  await page.locator('#libMvHost button:has-text("材质插槽")').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#libMvHost');
    return el && /已有贴图/.test(el.textContent);
  }, null, { timeout: 10000 });
  await page.locator('#libWin').screenshot({ path: path.join(__dirname, '_tex_persist.png') });
  const restore = await page.evaluate(() => {
    const el = document.querySelector('#libMvHost');
    return { restored: el ? /已有贴图/.test(el.textContent) : false, cfg: localStorage.getItem('openagi_model_tex_v1') };
  });
  console.log('重开后贴图恢复:', JSON.stringify(restore));
  await page.click('#libMv [data-mv-act="close"]');
  await page.waitForFunction(() => !libMv.open, null, { timeout: 10000 });

  // ---- UV 并入模型查看器：同一个视口切换，不再另开浮层 ----
  await page.evaluate(() => libUvOpen('m1'));
  await page.waitForFunction(() => libMv.open && document.querySelector('#libMvHost .mv3-uv.on .mv3-uv-img'), null, { timeout: 60000 });

  const info = await page.evaluate(() => ({
    inViewer: !!document.querySelector('#libMvHost .mv3-uv'),
    oldOverlay: !!document.getElementById('libUv'),
    sub: (document.querySelector('.mv3-uv-sub') || {}).textContent || '',
    side: ((document.querySelector('.mv3-uv-side') || {}).innerText || '').replace(/\n/g, ' | '),
    atlasBytes: (document.querySelector('.mv3-uv-img') || {}).src.length || 0,
    chips: document.querySelectorAll('.mv3-uv-head [data-uv="part"]').length
  }));
  console.log('UV 状态:', JSON.stringify(info));
  await page.locator('#libWin').screenshot({ path: path.join(__dirname, '_uv_atlas.png') });

  // 插槽隔离：切到单插槽后岛图必须变化（不再叠着画）
  await page.click('.mv3-uv-head [data-uv="part"][data-v="0"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('.mv3-uv-img');
    return img && img.src.length && document.querySelector('.mv3-uv-head [data-uv="part"][data-v="0"]').classList.contains('on');
  }, null, { timeout: 30000 });
  const slot = await page.evaluate(() => ({
    bytes: document.querySelector('.mv3-uv-img').src.length,
    chips: document.querySelectorAll('.mv3-uv-head [data-uv="part"]').length
  }));
  console.log('切到插槽1:', JSON.stringify(slot), '岛图变化:', slot.bytes !== info.atlasBytes);
  await page.locator('#libWin').screenshot({ path: path.join(__dirname, '_uv_slot.png') });
  await page.click('.mv3-uv-head [data-uv="part"][data-v="all"]');
  await page.waitForFunction(() => document.querySelector('.mv3-uv-head [data-uv="part"][data-v="all"]').classList.contains('on'), null, { timeout: 30000 });

  // 编号开关：岛图必须真的重画
  const beforeLabels = await page.evaluate(() => document.querySelector('.mv3-uv-img').src.length);
  await page.click('.mv3-uv-head [data-uv="labels"]');
  const afterLabels = await page.evaluate(() => ({
    bytes: document.querySelector('.mv3-uv-img').src.length,
    on: document.querySelector('.mv3-uv-head [data-uv="labels"]').classList.contains('on')
  }));
  console.log('编号切换:', JSON.stringify(afterLabels), '图变化:', afterLabels.bytes !== beforeLabels);

  // 3D 岛图
  await page.click('.mv3-uv-head [data-uv="mode"][data-v="3d"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('.mv3-uv-img');
    return img && img.src.length && document.querySelector('.mv3-uv-head [data-uv="mode"][data-v="3d"]').classList.contains('on');
  }, null, { timeout: 60000 });
  const p3d = await page.evaluate(() => document.querySelector('.mv3-uv-img').src.length);
  await page.locator('#libWin').screenshot({ path: path.join(__dirname, '_uv_3d.png') });

  // 3D 模式下切插槽要重新出图
  await page.click('.mv3-uv-head [data-uv="part"][data-v="1"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('.mv3-uv-img');
    return img && img.src.length && document.querySelector('.mv3-uv-head [data-uv="part"][data-v="1"]').classList.contains('on');
  }, null, { timeout: 60000 });
  const p3dslot = await page.evaluate(() => document.querySelector('.mv3-uv-img').src.length);
  console.log('3D 岛图:', p3d, '切插槽后:', p3dslot, '变化:', p3dslot !== p3d);
  await page.locator('#libWin').screenshot({ path: path.join(__dirname, '_uv_3d_slot.png') });

  // 返回 3D：画布重新出现，UV 层收起
  await page.click('.mv3-uv-head [data-uv="back"]');
  const back = await page.evaluate(() => ({
    uvOff: !document.querySelector('.mv3-uv').classList.contains('on'),
    canvas: (() => { const c = document.querySelector('#libMvHost canvas'); return !!c && c.style.display !== 'none'; })()
  }));
  console.log('返回 3D:', JSON.stringify(back));

  // Esc 关闭
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => !libMv.open && !document.querySelector('#libMvHost'));
  console.log('Esc 关闭:', closed);
  console.log('pageErrors:', errors.length ? errors : '无');

  await browser.close();
  server.close();
  process.exit(closed && info.inViewer && !info.oldOverlay && slot.bytes !== info.atlasBytes &&
    afterLabels.bytes !== beforeLabels && p3dslot !== p3d && back.uvOff && back.canvas &&
    mv.inWin && mv.visible && mvClosed && restore.restored ? 0 : 1);
})().catch(e => { console.error('FAIL', e); server.close(); process.exit(2); });
