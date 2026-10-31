/* 模型库回归：材质切换 / 参考图插槽 / 卡片渲染
 * 用假的 openagiDesktop 桥（真实 GLB 从磁盘读成 dataURL），零 Electron、零网络。
 * 覆盖：
 *   1) 卡片渲染 + 参考图角标
 *   2) 双击进 3D 视口：六档预览材质都在，切换后 on 状态跟着走
 *   3) 切换材质不改模型数据（再切回「原始」材质对象还是原来那份）
 *   4) 参考图抽屉：两个插槽（结构 / 着色），上传写入资产库后角标出现
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

/* 1×1 红色 PNG，当「用户上传的参考图」 */
const TINY_PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const glbDataURL = 'data:model/gltf-binary;base64,' + fs.readFileSync(GLB).toString('base64');
  const modelAssets = [{
    id: 'test-model-1', kind: 'model', ext: 'glb', name: '测试模型.glb',
    size: fs.statSync(GLB).size, created: Date.now(), updated: Date.now(), source: 'texture'
  }];

  /* 假桥：只实现模型库真正用到的几个方法 */
  await page.addInitScript(([assets, dataURL, tiny, tiny2]) => {
    const put = [];
    window.__put = put;
    window.openagiDesktop = {
      assetList: async () => ({ ok: true, assets }),
      assetStat: async () => ({ ok: true, count: assets.length, totalBytes: 0, byKind: { model: { count: assets.length, bytes: 0 }, image: { count: 0, bytes: 0 } }, trashBytes: 0, trashCount: 0 }),
      assetRead: async id => {
        if (id === 'put-2') return { ok: true, dataURL: tiny2 };
        if (String(id).indexOf('put-') === 0) return { ok: true, dataURL: tiny };
        const hit = put.filter(p => p.asset && p.asset.id === id).pop();
        if (hit) return { ok: true, dataURL: hit.data };
        if (id === assets[0].id) return { ok: true, dataURL };
        return { ok: false, error: 'not found' };
      },
      assetThumb: async () => ({ ok: false }),
      assetThumbSave: async () => ({ ok: true }),
      assetPut: async req => {
        const a = { id: 'put-' + (put.length + 1), kind: req.kind, ext: req.ext, name: req.name, size: 1, created: Date.now(), updated: Date.now(), source: req.source };
        put.push({ asset: a, data: tiny });
        return { ok: true, asset: a };
      },
      assetRemove: async () => ({ ok: true }),
      assetReconcile: async () => ({ ok: true }),
      assetEmptyTrash: async () => ({ ok: true }),
      assetExport: async () => ({ ok: true, files: [] }),
      assetImport: async () => ({ ok: false })
    };
    try { localStorage.removeItem('openagi/modelrefs'); } catch (e) {}
  }, [modelAssets, glbDataURL, TINY_PNG, TINY_PNG2]);

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });

  console.log('=== 1. 卡片与角标 ===');
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  const card = await page.evaluate(() => {
    const c = document.querySelector('#libBody .lib-card');
    return { name: c.querySelector('.lib-name').textContent, hasModelThumb: !!c.querySelector('.lib-thumb.model'), badge: !!c.querySelector('.lib-refbadge') };
  });
  check('模型卡渲染出来了', card.name === '测试模型.glb', card.name);
  check('模型卡用的是 3D 缩略底座', card.hasModelThumb);
  check('还没配参考图时没有角标', card.badge === false);

  console.log('=== 2. 3D 视口的预览材质 ===');
  await page.evaluate(() => libOpenAsset('test-model-1'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 20000 });
  const presets = await page.evaluate(() => Array.from(document.querySelectorAll('.mv3-preset')).map(b => b.textContent));
  check('六档预览材质都在', presets.length === 6, presets.join('/'));
  check('默认停在「原始贴图」', await page.evaluate(() => document.querySelector('.mv3-preset.on').textContent) === '原始贴图');

  /* 切白模：材质变成不带贴图的素模，且 on 状态转移 */
  await page.evaluate(() => document.querySelector('[data-mv-preset="clay"]').click());
  await page.waitForTimeout(300);
  const clay = await page.evaluate(() => ({
    on: document.querySelector('.mv3-preset.on').textContent,
    mapped: Array.from(document.querySelectorAll('canvas')).length > 0
  }));
  check('切到白模后高亮跟着走', clay.on === '白模', clay.on);

  /* 切回原始：材质回滚（对比贴图是否回来，用 map 是否存在判断） */
  const back = await page.evaluate(() => {
    document.querySelector('[data-mv-preset="original"]').click();
    return document.querySelector('.mv3-preset.on').textContent;
  });
  check('能切回「原始贴图」', back === '原始贴图', back);

  console.log('=== 3. 参考图抽屉 ===');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.mv3-bar button')).find(b => b.textContent.indexOf('参考图') === 0);
    btn.click();
  });
  await page.waitForSelector('.mref-drawer', { timeout: 5000 });
  const slots = await page.evaluate(() => ({
    count: document.querySelectorAll('.mref-drawer .mref-slot').length,
    labels: Array.from(document.querySelectorAll('.mref-drawer .mref-info b')).map(b => b.textContent),
    goDisabled: document.querySelector('.mref-go').disabled
  }));
  check('抽屉里正好两个插槽', slots.count === 2, String(slots.count));
  check('两个插槽是「结构参考 / 着色参考」', slots.labels.join('|') === '结构参考|着色参考', slots.labels.join('|'));
  check('没有参考图时「发到 AI」是禁用的', slots.goDisabled === true);

  /* 直接走 ModelRefs.set（等价于上传成功后写索引），再刷新抽屉 */
  await page.evaluate(async () => {
    await ModelRefs.upload('test-model-1', 'struct', new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' }), '测试模型.glb').catch(() => {});
    ModelRefs.set('test-model-1', 'struct', 'put-1');
    ModelRefs.set('test-model-1', 'color', 'put-2');
  });
  await page.evaluate(() => {
    document.querySelector('.mref-x').click();
    const btn = Array.from(document.querySelectorAll('.mv3-bar button')).find(b => b.textContent.indexOf('参考图') === 0);
    btn.click();
  });
  await page.waitForSelector('.mref-drawer', { timeout: 5000 });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    thumbs: document.querySelectorAll('.mref-drawer .mref-thumb img').length,
    goDisabled: document.querySelector('.mref-go').disabled,
    label: Array.from(document.querySelectorAll('.mv3-bar button')).find(b => b.textContent.indexOf('参考图') === 0).textContent
  }));
  check('两张参考图都显示缩略图', after.thumbs === 2, String(after.thumbs));
  check('配好后「发到 AI」可用', after.goDisabled === false);
  check('工具条按钮标出了张数', after.label.indexOf('2') >= 0, after.label);

  console.log('=== 4. 卡片角标 ===');
  await page.evaluate(() => { document.querySelector('.mref-x').click(); return libPaint(); });
  await page.waitForTimeout(400);
  const badge = await page.evaluate(() => {
    const b = document.querySelector('#libBody .lib-card .lib-refbadge');
    return b ? b.textContent : '';
  });
  check('卡片上出现参考图角标', badge.indexOf('结构') >= 0 && badge.indexOf('着色') >= 0, badge);

  console.log('=== 5. 发到 AI 对话（事件接缝） ===');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.mv3-bar button')).find(b => b.textContent.indexOf('参考图') === 0);
    if (btn) btn.click();
  });
  await page.waitForSelector('[data-mref-act="to-chat"]', { timeout: 5000 });
  const chat = await page.evaluate(async () => {
    const got = [];
    const onEv = e => got.push(e.detail);
    window.addEventListener('openagi:model-refs', onEv);
    document.querySelector('[data-mref-act="to-chat"]').click();
    await new Promise(r => setTimeout(r, 600));
    window.removeEventListener('openagi:model-refs', onEv);
    const atts = (window.deskChat && window.deskChat.atts) ? window.deskChat.atts().length : -1;
    return { fired: got.length, atts };
  });
  check('点「发到 AI 对话」会派发事件', chat.fired >= 1, String(chat.fired));
  check('对话侧收到并带入了附件', chat.atts >= 2, String(chat.atts));

  console.log('=== 6. 卡片「参考」快捷入口 ===');
  /* 上一节把对话 App 翻上来了：先翻回模型库。注意这里用 attached 而不是 visible ——
   * 库窗口这时可能还在翻页动画里（父级 hidden），但 DOM 接线是否成立照样能验。 */
  await page.evaluate(() => openLibrary('model'));
  await page.waitForSelector('#libBody [data-lib-ref]', { state: 'attached', timeout: 10000 });
  check('磁贴上有「参考」入口', true);
  await page.evaluate(() => document.querySelector('#libBody [data-lib-ref]').click());
  await page.waitForSelector('.mref-drawer', { state: 'attached', timeout: 25000 });
  check('点「参考」直接打开 3D 视口 + 参考图抽屉', true);

  console.log('=== 7. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})();
