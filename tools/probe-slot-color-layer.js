/* 模型库 · 材质槽「重载颜色层」回归
 * 覆盖：
 *   1) ✎ 绘制颜色 → 工具条有 吸管 / 铺满颜色 / 锁定选中岛 / 解除
 *   2) 吸管：在模型上点一下，从本槽贴图吸到的 hex 回写进 <input type=color>
 *   3) 锁定 3 个 UV 岛 → 铺满颜色 → 这一层的 PNG 只在岛内不透明（岛外 alpha=0）
 *   4) 对照组：不锁定的新层铺满 → 整张不透明，证明差别来自岛遮罩
 *   5) 配置落盘带 kind:'color' + islands:[...]
 *   6) 刷新还原：层还在、徽标显示「重载颜色 · 岛 3」、islands 没被洗掉
 *   7) 建模 App 的 normLayer/encLayer 原样保留这两个字段（双边不丢）
 *   8) 页面零错误
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-slot-color-layer');
const ROOT = path.join(__dirname, '..');
const TARGET = pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1';
const GLB = path.join(ROOT, 'assets', 'models', 'mvyfd48a-8e2b846b.glb');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

(async () => {
  const glbDataURL = 'data:model/gltf-binary;base64,' + fs.readFileSync(GLB).toString('base64');
  const modelAssets = [{
    id: 'test-model-1', kind: 'model', ext: 'glb', name: '测试模型.glb',
    size: fs.statSync(GLB).size, created: Date.now(), updated: Date.now(), source: 'texture'
  }];

  const browser = await chromium.launch({
    channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.addInitScript(([assets, dataURL, tiny]) => {
    const put = [];
    window.__put = put;
    window.openagiDesktop = {
      assetList: async () => ({ ok: true, assets }),
      assetStat: async () => ({ ok: true, count: assets.length, totalBytes: 0, byKind: {}, trashBytes: 0, trashCount: 0 }),
      assetRead: async id => {
        const hit = put.filter(p => p.asset && p.asset.id === id).pop();
        if (hit) return { ok: true, dataURL: hit.data };
        if (String(id).indexOf('put-') === 0) return { ok: true, dataURL: tiny };
        if (id === assets[0].id) return { ok: true, dataURL };
        return { ok: false, error: 'not found' };
      },
      assetThumb: async () => ({ ok: false }),
      assetThumbSave: async () => ({ ok: true }),
      assetPut: async req => {
        const a = { id: 'put-' + (put.length + 1), kind: req.kind, ext: req.ext, name: req.name,
                    size: 1, created: Date.now(), updated: Date.now(), source: req.source };
        put.push({ asset: a, data: req.data || tiny });
        return { ok: true, asset: a };
      },
      assetRemove: async () => ({ ok: true }),
      assetReconcile: async () => ({ ok: true }),
      assetEmptyTrash: async () => ({ ok: true }),
      assetExport: async () => ({ ok: true, files: [] }),
      assetImport: async () => ({ ok: false })
    };
    /* 只在首次进页面时清配置：后面还要 reload 验证「刷新还原」，
     * 每次 addInitScript 都清就等于自己把要验的数据删了。 */
    try {
      if (!sessionStorage.getItem('__slotcolor_seen')) {
        sessionStorage.setItem('__slotcolor_seen', '1');
        localStorage.removeItem('openagi_model_tex_v1');
      }
    } catch (e) {}
  }, [modelAssets, glbDataURL, TINY_PNG]);

  const clickText = (t) => page.evaluate((txt) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().indexOf(txt) === 0);
    if (!b) throw new Error('找不到按钮：' + txt);
    b.click();
    return true;
  }, t);

  const paintText = () => page.evaluate(() => {
    const w = document.querySelector('[data-mask-paint]');
    return w ? w.innerText : '';
  });

  const openPaint = async () => {
    await clickText('材质插槽');
    await page.waitForTimeout(250);
    await clickText('纹理混合');
    await page.waitForTimeout(250);
    await clickText('✎ 绘制颜色');
    await page.waitForTimeout(700);
  };

  /* 视口 canvas 的中心：射线能打到模型，UV 才有得吸 */
  const canvasCenter = () => page.evaluate(() => {
    const w = document.querySelector('[data-mask-paint]');
    const c = w && w.parentElement ? w.parentElement.querySelector('canvas') : null;
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });

  const lastPutPngStats = () => page.evaluate(async () => {
    const p = window.__put[window.__put.length - 1];
    if (!p) return null;
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = p.data; });
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0, total = 0;
    for (let i = 3; i < d.length; i += 4) { total++; if (d[i] > 200) opaque++; }
    return { w: c.width, h: c.height, opaque, total, pct: total ? Math.round(opaque / total * 100) : 0 };
  });

  /* 把最后一次入库的层 PNG 落盘，肉眼就能看出「只有锁定的岛被涂到」 */
  const dumpLastPut = async (file) => {
    const d = await page.evaluate(() => {
      const p = window.__put[window.__put.length - 1];
      return p ? p.data : '';
    });
    const i = String(d).indexOf('base64,');
    if (i > 0) fs.writeFileSync(RUN.artifact(file), Buffer.from(d.slice(i + 7), 'base64'));
  };

  const cfgTop = () => page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}');
    const m = cfg['test-model-1'] || {};
    const k = Object.keys(m)[0];
    const ls = (m[k] && m[k].layers) || [];
    return { count: ls.length, top: ls[ls.length - 1] || null, all: ls };
  });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => libOpenAsset('test-model-1'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 30000 });

  console.log('=== 1. 进入绘制颜色工具条 ===');
  await openPaint();
  const t1 = await paintText();
  check('工具条已打开', t1.indexOf('颜色绘制') >= 0, JSON.stringify(t1.slice(0, 90)));
  check('有「吸管」模式', t1.indexOf('吸管') >= 0);
  check('有「铺满颜色」', t1.indexOf('铺满颜色') >= 0);
  check('有「锁定选中岛」', t1.indexOf('锁定选中岛') >= 0);
  check('有「解除」', t1.indexOf('解除') >= 0);
  check('层锁定初始为「未锁定」', t1.indexOf('未锁定') >= 0);

  console.log('=== 2. 吸管：从本槽贴图取色 ===');
  await clickText('吸管');
  await page.waitForTimeout(150);
  const c = await canvasCenter();
  check('拿到视口 canvas 中心', !!c, JSON.stringify(c));
  if (c) {
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(300);
    const picked = await page.evaluate(() => {
      const w = document.querySelector('[data-mask-paint]');
      const ci = w && w.querySelector('input[type=color]');
      const body = document.body.innerText;
      const m = body.match(/已吸取\s+(#[0-9a-fA-F]{6})/);
      return { hex: m ? m[1] : '', color: ci ? ci.value : '', hint: body.match(/已吸取[^\n]*/) ? body.match(/已吸取[^\n]*/)[0] : '' };
    });
    check('提示里给出吸取到的 hex', /^#[0-9a-fA-F]{6}$/.test(picked.hex), JSON.stringify(picked));
    check('笔色已回写成吸取的颜色', !!picked.color && picked.color.toLowerCase() === picked.hex.toLowerCase(),
      JSON.stringify(picked));
    check('吸管取完自动回到绘制模式', (await paintText()).indexOf('上色中') >= 0 || picked.hint.indexOf('继续上色') >= 0);
  }

  console.log('=== 3. 锁定 UV 岛 → 铺满颜色 → 只在岛内 ===');
  /* 吸管吸到的可能是角色衣服的浅色，截图看不出差别；固定成醒目红便于肉眼核对 */
  await page.evaluate(() => {
    const w = document.querySelector('[data-mask-paint]');
    const ci = w && w.querySelector('input[type=color]');
    if (ci) { ci.value = '#ff3355'; ci.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  const selN = await page.evaluate(() => {
    const nms = Array.from(document.querySelectorAll('[data-mask-paint] [title^="UV 岛 #"]'));
    nms.slice(0, 3).forEach(n => n.parentElement.click());
    return nms.length;
  });
  check('左栏列出了 UV 岛', selN >= 3, 'island rows=' + selN);
  await page.waitForTimeout(150);
  check('已选中 3 个岛', (await paintText()).indexOf('已选 3 个岛') >= 0, (await paintText()).slice(0, 120));
  await clickText('锁定选中岛');
  await page.waitForTimeout(300);
  const t3 = await paintText();
  check('层锁定显示「已锁定 3 个岛」', t3.indexOf('已锁定 3 个岛') >= 0, t3.slice(0, 160));
  await clickText('铺满颜色');
  await page.waitForTimeout(300);
  await RUN.shot(page, 'slotcolor-ui.png');
  await clickText('完成');
  await page.waitForTimeout(1200);
  await dumpLastPut('_slotcolor_layer.png');
  const s1 = await lastPutPngStats();
  const c1 = await cfgTop();
  console.log('   锁定层 PNG:', JSON.stringify(s1));
  console.log('   配置顶层:', JSON.stringify(c1.top));
  check('铺色层已入库', !!s1);
  check('锁定后铺色只落在岛内（不是整张不透明）', !!s1 && s1.pct > 0 && s1.pct < 95,
    s1 ? '不透明 ' + s1.pct + '%' : 'no png');
  check('配置里写了 kind:color', c1.top && c1.top.kind === 'color');
  check('配置里写了 3 个岛 id', c1.top && Array.isArray(c1.top.islands) && c1.top.islands.length === 3,
    JSON.stringify(c1.top && c1.top.islands));

  console.log('=== 4. 对照组：不锁定的新层铺满 ===');
  await clickText('✎ 绘制颜色');
  await page.waitForTimeout(700);
  check('新层没有继承锁定', (await paintText()).indexOf('未锁定') >= 0);
  await clickText('铺满颜色');
  await page.waitForTimeout(300);
  await clickText('完成');
  await page.waitForTimeout(1200);
  await dumpLastPut('_slotcolor_layer_full.png');
  const s2 = await lastPutPngStats();
  const c2 = await cfgTop();
  console.log('   对照层 PNG:', JSON.stringify(s2));
  check('未锁定时铺满整张贴图', !!s2 && s2.pct >= 99, s2 ? '不透明 ' + s2.pct + '%' : 'no png');
  check('现在是两层，第一层仍带 3 个岛', c2.count === 2 && c2.all[0].islands && c2.all[0].islands.length === 3,
    JSON.stringify(c2.all.map(l => ({ kind: l.kind, islands: l.islands }))));

  console.log('=== 5. 刷新还原 ===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => libOpenAsset('test-model-1'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 30000 });
  await clickText('材质插槽');
  await page.waitForTimeout(300);
  await clickText('纹理混合');
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => document.body.innerText);
  check('层列表标出「重载颜色」', restored.indexOf('重载颜色') >= 0);
  check('层列表标出「岛 3」', restored.indexOf('岛 3') >= 0);
  const c3 = await cfgTop();
  check('刷新后 islands 仍在配置里', c3.all[0] && c3.all[0].islands && c3.all[0].islands.length === 3,
    JSON.stringify(c3.all.map(l => l.islands)));

  console.log('=== 6. 建模 App 双边兼容（纯函数） ===');
  const compat = await page.evaluate(() => {
    if (!window.MDTexMix || !MDTexMix.normLayer) return { err: 'MDTexMix 未导出纯函数' };
    const n = MDTexMix.normLayer({ id: 'X', name: 'c', opacity: 1, blend: 'normal',
                                   kind: 'color', islands: [3, 7, 11] });
    const e = MDTexMix.encLayer(n, false);
    return { nk: n.kind, ni: n.islands, ek: e.kind, ei: e.islands };
  });
  check('normLayer 保留 kind/islands', compat.nk === 'color' && JSON.stringify(compat.ni) === '[3,7,11]', JSON.stringify(compat));
  check('encLayer 保留 kind/islands', compat.ek === 'color' && JSON.stringify(compat.ei) === '[3,7,11]', JSON.stringify(compat));

  check('页面零错误', errors.length === 0, errors.join(' | '));
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
