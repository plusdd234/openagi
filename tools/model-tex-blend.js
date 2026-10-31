/* 模型库 · 材质插槽「纹理混合」回归
 * 假桥（不启 Electron / 不联网），真 GLB 从磁盘读。
 * 覆盖：
 *   1) 插槽面板 → 纹理混合 二级面板打开，基础层在底部且不可删
 *   2) 上传两层贴图：层数 / 卡片摘要 / localStorage v2 配置
 *   3) 比例滑杆 + 混合模式 + 遮罩：不报错且落到配置里
 *   4) 导出 GLB → 解析文件里内嵌的那张贴图，逐像素验证「红底 + 50% 蓝 + 左半遮罩」
 *   5) 刷新页面后从配置还原层数（持久化闭环）
 *   6) 页面零错误
 *
 * 为什么非要解 GLB 里的图：混合是在 canvas 里烘出来的一张图再当 mat.map 用的。
 * 如果哪天有人改成着色器混合，视口照样好看，但导出会是空的——这条断言就是防它。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
const GLB = path.join(__dirname, '..', 'assets', 'models', 'mvv9621p-9e37196e.glb');
const TMP = path.join(__dirname, '_texblend');

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

/* ---------------- 造几张确定性 PNG：纯色红 / 纯色蓝 / 左白右黑遮罩 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writePNG(file, w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = pixel(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

/* ---------------- GLB 解包：拿出内嵌图片 ---------------- */
function glbImages(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004E4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) return [];
  return (json.images || []).map(im => {
    const bv = json.bufferViews[im.bufferView];
    const start = bv.byteOffset || 0;
    return { mime: im.mimeType || 'image/png', data: bin.subarray(start, start + bv.byteLength) };
  });
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const RED = path.join(TMP, 'red.png');
  const BLUE = path.join(TMP, 'blue.png');
  const MASK = path.join(TMP, 'mask.png');
  writePNG(RED, 64, 64, () => [255, 0, 0]);
  writePNG(BLUE, 64, 64, () => [0, 0, 255]);
  writePNG(MASK, 64, 64, (x) => (x < 32 ? [255, 255, 255] : [0, 0, 0]));

  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const glbDataURL = 'data:model/gltf-binary;base64,' + fs.readFileSync(GLB).toString('base64');
  const modelAssets = [{
    id: 'test-model-1', kind: 'model', ext: 'glb', name: '测试模型.glb',
    size: fs.statSync(GLB).size, created: Date.now(), updated: Date.now(), source: 'texture'
  }];

  await page.addInitScript(([assets, dataURL, tiny]) => {
    const put = [];
    window.__put = put;
    window.openagiDesktop = {
      assetList: async () => ({ ok: true, assets }),
      assetStat: async () => ({ ok: true, count: assets.length, totalBytes: 0, byKind: { model: { count: assets.length, bytes: 0 }, image: { count: 0, bytes: 0 } }, trashBytes: 0, trashCount: 0 }),
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
        const a = { id: 'put-' + (put.length + 1), kind: req.kind, ext: req.ext, name: req.name, size: 1, created: Date.now(), updated: Date.now(), source: req.source };
        put.push({ asset: a, data: req.data || tiny });
        return { ok: true, asset: a };
      },
      assetRemove: async () => ({ ok: true }),
      assetReconcile: async () => ({ ok: true }),
      assetEmptyTrash: async () => ({ ok: true }),
      assetExport: async () => ({ ok: true, files: [] }),
      assetImport: async () => ({ ok: false })
    };
    try {
      if (!sessionStorage.getItem('__texblend_seen')) {
        sessionStorage.setItem('__texblend_seen', '1');
        localStorage.removeItem('openagi_model_tex_v1');
      }
    } catch (e) {}
  }, [modelAssets, glbDataURL, TINY_PNG]);

  /* 面板里的按钮按文字找：面板是内联样式、没有 class，文字就是契约 */
  const clickText = (t) => page.evaluate((txt) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().indexOf(txt) === 0);
    if (!b) throw new Error('找不到按钮：' + txt);
    b.click();
    return true;
  }, t);

  /* 走「本机文件…」：真实点击会弹文件选择器；拿不到就退回直接塞文件 */
  async function pickLocal(file) {
    const wait = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
    await clickText('本机文件…');
    const chooser = await wait;
    if (chooser) await chooser.setFiles(file);
    else await page.setInputFiles('input[type=file]', file);
    await page.waitForTimeout(600);
  }

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => libOpenAsset('test-model-1'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 30000 });

  console.log('=== 1. 材质插槽 → 纹理混合 面板 ===');
  await clickText('材质插槽');
  await page.waitForTimeout(300);
  const slotCount = await page.evaluate(() => (document.querySelectorAll('.mv3-stage > div, .mv3-stage div').length, 0));
  await clickText('纹理混合');
  await page.waitForTimeout(300);
  let ui = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      hasTitle: txt.indexOf('纹理混合') >= 0,
      hasBase: txt.indexOf('模型自带贴图（底层）') >= 0,
      hasAdd: txt.indexOf('本机贴图') >= 0,
      hasEmptyHint: txt.indexOf('还没有混合层') >= 0
    };
  });
  check('纹理混合面板打开了', ui.hasTitle);
  check('底部有「模型自带贴图（底层）」', ui.hasBase);
  check('空态有引导文案', ui.hasEmptyHint);
  check('有「＋ 本机贴图」入口', ui.hasAdd);

  console.log('=== 2. 叠两层贴图 ===');
  await clickText('＋ 本机贴图');
  await page.waitForTimeout(200);
  await pickLocal([RED, BLUE]);   // 一次多选两张：后选的盖在上面

  const after2 = await page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}');
    const m = cfg['test-model-1'] || {};
    const k = Object.keys(m)[0];
    return {
      layers: k ? (m[k].layers || []).length : 0,
      v: k ? m[k].v : 0,
      ids: k ? (m[k].layers || []).map(l => l.id) : [],
      rows: document.querySelectorAll('[data-mix-root] input[type=range]').length
    };
  });
  check('配置里记下两层（v2）', after2.layers === 2 && after2.v === 2, JSON.stringify(after2));
  check('两层都拿到了资产 id', after2.ids.length === 2 && after2.ids.every(Boolean), after2.ids.join(','));
  check('面板里每层各一个比例滑杆', after2.rows === 2, String(after2.rows));

  console.log('=== 3. 比例 / 混合模式 / 遮罩 ===');
  /* 最上面那层（列表第一行）就是最后加的蓝层：比例 50%，正常 */
  await page.evaluate(() => {
    const r = document.querySelectorAll('[data-mix-root] input[type=range]')[0];
    r.value = '50';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const afterSlider = await page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}');
    const m = cfg['test-model-1'] || {};
    const k = Object.keys(m)[0];
    const ls = (m[k] && m[k].layers) || [];
    return { op: ls.length === 2 ? ls[1].opacity : -1, label: (document.querySelectorAll('[data-mix-root] input[type=range]')[0].parentNode.innerText || '') };
  });
  check('比例 50% 写进配置', Math.abs(afterSlider.op - 0.5) < 0.001, String(afterSlider.op));

  /* 遮罩：给蓝层加「左白右黑」 */
  await clickText('＋ 遮罩');
  await page.waitForTimeout(200);
  await pickLocal(MASK);
  const afterMask = await page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}');
    const m = cfg['test-model-1'] || {};
    const k = Object.keys(m)[0];
    const ls = (m[k] && m[k].layers) || [];
    return {
      mask: (ls[1] && ls[1].mask && ls[1].mask.id) || '',
      invert: !!(ls[1] && ls[1].mask && ls[1].mask.invert),
      panel: (document.querySelector('[data-slot-panel]') || document.body).innerText
    };
  });
  check('遮罩落到蓝层并记了 id', !!afterMask.mask, JSON.stringify(afterMask));
  check('插槽摘要标出「1 个遮罩」', afterMask.panel.indexOf('个遮罩') >= 0, afterMask.panel.replace(/\s+/g, ' ').slice(0, 260));

  /* 反相按钮：状态要跟着配置走 */
  await clickText('反相');
  await page.waitForTimeout(250);
  const inverted = await page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}');
    const m = cfg['test-model-1'] || {};
    const k = Object.keys(m)[0];
    return !!(m[k].layers[1].mask.invert);
  });
  check('「反相」写进配置', inverted === true);
  await clickText('反相');            // 翻回来：像素断言按「白=显示」的原始遮罩算
  await page.waitForTimeout(250);

  console.log('=== 4. 导出 GLB 并验证内嵌贴图 ===');
  await clickText('导出 GLB 存入模型库');
  await page.waitForFunction(() => (window.__put || []).some(p => p.asset && p.asset.kind === 'model'), null, { timeout: 90000 });
  await page.waitForTimeout(500);
  const glbURL = await page.evaluate(() => {
    const p = (window.__put || []).filter(x => x.asset && x.asset.kind === 'model').pop();
    return p ? p.data : '';
  });
  check('导出产出了 GLB 资产', !!glbURL && glbURL.length > 1000, String(glbURL.length));
  const hintTxt = await page.evaluate(() => document.body.innerText.indexOf('已存入模型库') >= 0);
  check('提示「已存入模型库」', hintTxt);

  const buf = Buffer.from(String(glbURL).split(',')[1] || '', 'base64');
  const imgs = glbImages(buf);
  check('GLB 里内嵌了图片', imgs.length >= 1, String(imgs.length));

  /* 逐张取样：左半应约 (128,0,128)（红上叠 50% 蓝），右半应仍是纯红（遮罩黑 = 隐藏蓝层）。
   * 图片顺序不稳定（基础贴图 / 合成图都在），所以「任意一张符合」即可。 */
  const samples = [];
  for (const im of imgs) {
    const s = await page.evaluate(async ([b64, mime]) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:' + mime + ';base64,' + b64; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      const at = (fx, fy) => Array.from(x.getImageData(Math.floor(fx * img.width), Math.floor(fy * img.height), 1, 1).data);
      return { w: img.width, h: img.height, left: at(0.25, 0.5), right: at(0.75, 0.5) };
    }, [im.data.toString('base64'), im.mime]).catch(() => null);
    if (s) samples.push(s);
  }
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const blendOK = samples.some(s =>
    near(s.left[0], 128, 16) && near(s.left[1], 0, 16) && near(s.left[2], 128, 16) &&
    near(s.right[0], 255, 12) && near(s.right[1], 0, 12) && near(s.right[2], 0, 12));
  check('导出贴图左半=红+50%蓝（约 128,0,128）且右半=纯红（遮罩生效）', blendOK,
    JSON.stringify(samples.map(s => [s.w + 'x' + s.h, s.left.slice(0, 3), s.right.slice(0, 3)])));

  console.log('=== 5. 刷新后从配置还原 ===');
  await page.evaluate(() => { Model3D.closePreview && Model3D.closePreview(); });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => libOpenAsset('test-model-1'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 30000 });
  await clickText('材质插槽');
  await page.waitForTimeout(1200);
  const restored = await page.evaluate(() => {
    const t = (document.querySelector('[data-slot-panel]') || document.body).innerText;
    return { twoLayers: t.indexOf('2 层混合') >= 0, oneMask: t.indexOf('1 个遮罩') >= 0 };
  });
  check('刷新后还原成「2 层混合」', restored.twoLayers, JSON.stringify(restored));
  check('刷新后遮罩也在', restored.oneMask, JSON.stringify(restored));

  console.log('=== 6. 页面零错误 ===');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail) process.exit(1);
})().catch(e => { console.error('崩了：', e); process.exit(1); });
