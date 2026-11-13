/* 模型库 · 材质槽「模糊笔刷 / 修复接缝」回归
 * 覆盖：
 *   1) TexBlend.featherData：alpha 加权羽化，颜色向透明区出血且不被透明黑拉暗
 *   2) TexBlend.seamBleedData：只改边缘，内部 alpha=255 的像素逐字节不变
 *   3) 工具条有「模糊」模式 / 「柔化」滑杆 / 「修复接缝」按钮
 *   4) 模糊笔刷绕开岛 clip（hint 有「岛遮罩已让开」）、确实改写了图层像素
 *   5) 一键「修复接缝」在真实层上让透明像素减少、半透明出血带出现
 *   6) 完成落盘的 PNG 合法、页面零错误
 * 产物：_seam_before.png / _seam_after.png / _seam_brush.png / _seam_ui.png
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-slot-seam-blur');
const ROOT = path.join(__dirname, '..');
const TARGET = pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1';
const GLB = path.join(ROOT, 'assets', 'models', 'mvyfd48a-8e2b846b.glb');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const INK = '#3366cc';                 // [51,102,204]
const RGB = [51, 102, 204];

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== undefined ? '  → ' + info : '')); }
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
    try { localStorage.removeItem('openagi_model_tex_v1'); } catch (e) {}
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
  const nextLayer = async () => {
    await clickText('✎ 绘制颜色');
    await page.waitForTimeout(700);
  };

  const canvasCenter = () => page.evaluate(() => {
    const w = document.querySelector('[data-mask-paint]');
    const c = w && w.parentElement ? w.parentElement.querySelector('canvas') : null;
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });

  const setColor = () => page.evaluate((hex) => {
    const w = document.querySelector('[data-mask-paint]');
    const ci = w && w.querySelector('input[type=color]');
    if (!ci) throw new Error('找不到取色器');
    ci.value = hex; ci.dispatchEvent(new Event('input', { bubbles: true }));
  }, INK);

  const setFeather = (n) => page.evaluate((v) => {
    const w = document.querySelector('[data-mask-paint]');
    const rs = Array.from(w.querySelectorAll('input[type=range]'));
    const r = rs[rs.length - 1];                 // 第二个 range = 柔化
    if (!r) throw new Error('找不到柔化滑杆');
    r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true }));
    return { n: rs.length, value: r.value, label: w.innerText.match(/(\d+)px/) ? w.innerText.match(/(\d+)px/)[1] : '' };
  }, n);

  const clickMode = (key) => page.evaluate((k) => {
    const b = Array.from(document.querySelectorAll('[data-mask-paint] button'))
      .find(x => x.dataset.mvMode === k);
    if (!b) throw new Error('找不到模式：' + k);
    b.click();
    return true;
  }, key);

  const dabOnce = async (c) => {
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 6, c.y + 3, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  };

  const lastData = () => page.evaluate(() => {
    const p = window.__put[window.__put.length - 1];
    return p ? p.data : '';
  });

  const dumpLast = async (file) => {
    const d = await lastData();
    const i = String(d).indexOf('base64,');
    if (i > 0) fs.writeFileSync(RUN.artifact(file), Buffer.from(d.slice(i + 7), 'base64'));
  };

  /* 把入库 PNG 读回像素：统计不透明 / 半透明 / 全透明，以及出血带的平均色 */
  const statsData = (dataURL) => page.evaluate(async (src) => {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src; });
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0, semi = 0, clear = 0, r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a >= 250) opaque++;
      else if (a > 4) {
        semi++;
        if (a < 120) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      } else clear++;
    }
    return { w: c.width, h: c.height, opaque, semi, clear,
             bleedAvg: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null };
  }, dataURL);

  const diffData = (a, b) => page.evaluate(async ([sa, sb]) => {
    const load = async (src) => {
      const im = new Image();
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src; });
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      return { d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    };
    const A = await load(sa), B = await load(sb);
    if (A.w !== B.w || A.h !== B.h) return -1;
    let n = 0;
    for (let i = 0; i < A.d.length; i += 4) {
      if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) +
          Math.abs(A.d[i + 2] - B.d[i + 2]) + Math.abs(A.d[i + 3] - B.d[i + 3]) > 6) n++;
    }
    return n;
  }, [a, b]);

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });

  /* ============ 1. 纯算法：alpha 加权羽化 / 接缝出血 ============ */
  console.log('=== 1. featherData / seamBleedData 纯算法 ===');
  const alg = await page.evaluate(() => {
    const TB = window.TexBlend;
    if (!TB || !TB.featherData) return { err: 'TexBlend.featherData 不存在' };
    /* 左半纯色 #3366cc 不透明，右半全透明：模拟一个 UV 岛的直边 */
    const cv = document.createElement('canvas');
    cv.width = 100; cv.height = 100;
    const x = cv.getContext('2d');
    x.fillStyle = '#3366cc'; x.fillRect(0, 0, 50, 100);
    const src = x.getImageData(0, 0, 100, 100);
    const f = TB.featherData(cv, 4);
    const bl = TB.seamBleedData(cv, 4);
    const zero = TB.featherData(cv, 0);
    const px = (d, xx, yy) => {
      const p = (yy * d.width + xx) * 4;
      return [d.data[p], d.data[p + 1], d.data[p + 2], d.data[p + 3]];
    };
    const alphas = [];
    for (let xx = 49; xx <= 58; xx++) alphas.push(px(f, xx, 50)[3]);
    let insideSame = true;
    for (let yy = 0; yy < 100; yy++) {
      for (let xx = 0; xx < 40; xx++) {
        const a = px(src, xx, yy), b = px(bl, xx, yy);
        for (let k = 0; k < 4; k++) if (a[k] !== b[k]) insideSame = false;
      }
    }
    return {
      inside: px(f, 25, 50),
      bleed1: px(f, 51, 50),          // 边界外 1px，原 alpha=0
      far: px(f, 95, 50),
      alphaLine: alphas,
      seamBleedAt51: px(bl, 51, 50),
      seamInside: px(bl, 25, 50),
      insideSame,
      zeroSame: zero.data.every((v, i) => v === src.data[i]),
      featherCv: (() => { const c = TB.feather(cv, 3); return c ? [c.width, c.height] : null; })(),
      bleedCv: (() => { const c = TB.seamBleed(cv, 3); return c ? [c.width, c.height] : null; })()
    };
  });
  check('TexBlend 已导出羽化算法', !alg.err, alg.err);
  if (!alg.err) {
    check('岛内部纯色区模糊后仍是原色 (51,102,204)',
      alg.inside[0] === RGB[0] && alg.inside[1] === RGB[1] && alg.inside[2] === RGB[2] && alg.inside[3] === 255,
      JSON.stringify(alg.inside));
    check('边界外 1px 出血出颜色且不被透明黑拉暗',
      alg.bleed1[3] > 0 && alg.bleed1[0] > 45 && alg.bleed1[1] > 90 && alg.bleed1[2] > 180,
      JSON.stringify(alg.bleed1));
    check('远离岛的全透明区仍然透明', alg.far[3] === 0, JSON.stringify(alg.far));
    check('alpha 沿边界向外单调不增', alg.alphaLine.every((v, i, a) => i === 0 || v <= a[i - 1]),
      JSON.stringify(alg.alphaLine));
    check('seamBleed 把出血写进边缘像素', alg.seamBleedAt51[3] > 0 && alg.seamBleedAt51[0] > 45,
      JSON.stringify(alg.seamBleedAt51));
    check('seamBleed 内部 alpha=255 像素逐字节不变', alg.insideSame && alg.seamInside[0] === 51,
      JSON.stringify(alg.seamInside));
    check('半径 0 = 原样返回', alg.zeroSame);
    check('feather/seamBleed 的 canvas 包装尺寸正确',
      JSON.stringify(alg.featherCv) === '[100,100]' && JSON.stringify(alg.bleedCv) === '[100,100]',
      JSON.stringify([alg.featherCv, alg.bleedCv]));
  }

  /* ============ 2. 真实 UI：进入绘制颜色工具条 ============ */
  console.log('=== 2. 绘制工具条：模糊 / 柔化 / 修复接缝 ===');
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => libOpenAsset('test-model-1'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 30000 });
  await openPaint();
  const t1 = await paintText();
  check('工具条已打开', t1.indexOf('颜色绘制') >= 0, JSON.stringify(t1.slice(0, 100)));
  check('有「模糊」模式', t1.indexOf('模糊') >= 0);
  check('有「柔化」滑杆', t1.indexOf('柔化') >= 0 && /\d+px/.test(t1));
  check('有「修复接缝」按钮', t1.indexOf('修复接缝') >= 0);
  const hasBlurMode = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-mask-paint] button')).some(b => b.dataset.mvMode === 'blur'));
  check('blur 模式按钮绑定了 data-mv-mode', hasBlurMode);
  const fr = await setFeather(12);
  check('柔化滑杆可调到 12px', fr.n === 2 && fr.value === '12' && fr.label === '12', JSON.stringify(fr));
  await setColor();

  const c = await canvasCenter();
  check('拿到视口 canvas 中心', !!c, JSON.stringify(c));
  if (!c) throw new Error('视口 canvas 不可用');

  /* ============ 3. 基准层：只画一笔，不修缝 ============ */
  console.log('=== 3. 基准层（未修缝） ===');
  await dabOnce(c);
  await clickText('完成');
  await page.waitForTimeout(1200);
  const dataA = await lastData();
  await dumpLast('_seam_before.png');
  const A = await statsData(dataA);
  console.log('   基准:', JSON.stringify(A));
  check('基准层 PNG 已入库且尺寸合法', !!A && A.w >= 256 && A.h >= 256);
  check('基准层有透明区（笔迹之外没画）', A.clear > 0 && A.opaque > 0);

  /* ============ 4. 一键修复接缝 ============ */
  console.log('=== 4. 一键「修复接缝」 ===');
  await nextLayer();
  await setColor();
  await setFeather(12);
  await dabOnce(c);
  await clickText('修复接缝');
  await page.waitForTimeout(350);
  const hintB = await page.evaluate(() => document.body.innerText);
  check('修复接缝给出出血提示', /已把颜色向 UV 岛外出血 12px/.test(hintB), hintB.match(/已把颜色向[^\n]*/) ? hintB.match(/已把颜色向[^\n]*/)[0] : '');
  await clickText('完成');
  await page.waitForTimeout(1200);
  const dataB = await lastData();
  await dumpLast('_seam_after.png');
  const B = await statsData(dataB);
  console.log('   修缝后:', JSON.stringify(B));
  check('透明像素减少（颜色确实向外扩散）', B.clear < A.clear, A.clear + ' → ' + B.clear);
  check('半透明出血带增加', B.semi > A.semi, A.semi + ' → ' + B.semi);
  check('出血带颜色没被透明黑拉暗', !!B.bleedAvg &&
    B.bleedAvg[0] > 35 && B.bleedAvg[1] > 75 && B.bleedAvg[2] > 150, JSON.stringify(B.bleedAvg));

  /* ============ 5. 模糊笔刷：跨岛 clip + 确实改像素 ============ */
  console.log('=== 5. 模糊笔刷 ===');
  await nextLayer();
  await setColor();
  await setFeather(12);
  await dabOnce(c);                       // 先制造一个带硬边的笔迹
  await clickMode('blur');
  await page.waitForTimeout(120);
  const blurHint = await page.evaluate(() => document.body.innerText);
  check('切到模糊模式有对应说明', /模糊笔刷/.test(blurHint));
  await dabOnce(c);                       // 在同一位置沿边缘涂抹
  const afterHint = await page.evaluate(() => document.body.innerText);
  check('模糊笔刷绕开岛遮罩（hint 明说）', /岛遮罩已让开/.test(afterHint),
    afterHint.match(/模糊中[^\n]*/) ? afterHint.match(/模糊中[^\n]*/)[0] : '');
  const clipState = await page.evaluate(() => {
    const w = document.querySelector('[data-mask-paint]');
    const b = Array.from(w.querySelectorAll('button')).find(x => /^岛遮罩：/.test(x.textContent.trim()));
    return b ? { disabled: b.disabled, note: b.parentElement.innerText } : null;
  });
  check('模糊模式下岛遮罩开关置灰并写明让开', !!clipState && clipState.disabled &&
    /岛遮罩自动让开/.test(clipState.note), JSON.stringify(clipState));
  await RUN.shot(page, 'seam-ui.png');
  await clickText('完成');
  await page.waitForTimeout(1200);
  const dataC = await lastData();
  await dumpLast('_seam_brush.png');
  const C = await statsData(dataC);
  const diff = await diffData(dataA, dataC);
  console.log('   模糊层:', JSON.stringify(C), ' 与基准差异像素:', diff);
  check('模糊笔刷确实改写了图层像素', diff > 0, String(diff));
  check('模糊层 PNG 合法', C.w === A.w && C.h === A.h);
  /* 回归守卫：逐通道线性插值会把出血颜色乘上笔刷强度，缝会修成一条暗边。
   * 预乘 alpha 插值后，出血带的颜色必须是笔刷本色。 */
  check('模糊笔刷的出血颜色没被拉暗（预乘插值）', !!C.bleedAvg &&
    C.bleedAvg[0] > 40 && C.bleedAvg[1] > 85 && C.bleedAvg[2] > 175, JSON.stringify(C.bleedAvg));

  /* 三张 2048 贴图里笔迹只占中间一小块，整张看不出差别：
   * 按笔迹 bbox 裁一块放大拼成三态对比图，肉眼就能看到出血带。 */
  const compareURL = await page.evaluate(async (urls) => {
    const load = async (src) => {
      const im = new Image();
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src; });
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      return { c: c, d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    };
    const items = [];
    for (const u of urls) items.push(await load(u));
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (const it of items) {
      for (let y = 0; y < it.h; y += 2) for (let x = 0; x < it.w; x += 2) {
        if (it.d[(y * it.w + x) * 4 + 3] > 4) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return '';
    const pad = 45;
    const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
    const cw = Math.min(items[0].w - x0, maxX - minX + pad * 2);
    const ch = Math.min(items[0].h - y0, maxY - minY + pad * 2);
    const S = 2, gap = 14, top = 26;
    const out = document.createElement('canvas');
    out.width = cw * S * 3 + gap * 4;
    out.height = ch * S + top + gap;
    const o = out.getContext('2d');
    o.fillStyle = '#14171d'; o.fillRect(0, 0, out.width, out.height);
    const labels = ['未修缝（硬边）', '一键修复接缝（出血）', '模糊笔刷（局部晕开）'];
    o.font = '13px system-ui, sans-serif';
    for (let i = 0; i < 3; i++) {
      const dx = gap + i * (cw * S + gap), dy = top;
      o.fillStyle = '#20242c'; o.fillRect(dx, dy, cw * S, ch * S);
      o.drawImage(items[i].c, x0, y0, cw, ch, dx, dy, cw * S, ch * S);
      o.fillStyle = '#e8eaf0'; o.fillText(labels[i], dx + 4, 18);
    }
    return out.toDataURL('image/png');
  }, [dataA, dataB, dataC]);
  if (compareURL) {
    const ci = compareURL.indexOf('base64,');
    fs.writeFileSync(RUN.artifact('seam-compare.png'), Buffer.from(compareURL.slice(ci + 7), 'base64'));
    check('已产出三态局部对比图', true);
  } else check('已产出三态局部对比图', false, '对比图为空');

  check('页面零错误', errors.length === 0, errors.join(' | '));
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
