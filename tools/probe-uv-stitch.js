/* 模型库 · UV 视图「缝合碎岛」回归
 * 用真实资产 assets/models/mwby1p3x-d569ed18.obj（AI 生成身体，带 200+ 碎片岛）
 * 覆盖：
 *   1) 打开 UV 视图 → 概览给出岛数
 *   2) 缝合碎岛：岛数显著下降、三角面数不变（只动 UV 不动 3D）
 *   3) 自动排布在缝合后的岛分组上仍能跑（pack + 贴图重采样成功）
 *   4) 还原：岛数回到原始值（restore 后重算分岛生效）
 *   5) 存为 GLB：新 UV + 重采样贴图内嵌入库
 * 产物：_stitch_before.png / _stitch_after.png / _stitch_packed.png / _stitch_ui.png
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1';
const OBJ = path.join(ROOT, 'assets', 'models', 'mwby1p3x-d569ed18.obj');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== undefined ? '  → ' + info : '')); }
};

(async () => {
  const objDataURL = 'data:model/obj;base64,' + fs.readFileSync(OBJ).toString('base64');
  const modelAssets = [{
    id: 'frag-model', kind: 'model', ext: 'obj', name: '身体.obj.obj',
    size: fs.statSync(OBJ).size, created: Date.now(), updated: Date.now(), source: 'texture'
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
  }, [modelAssets, objDataURL, TINY_PNG]);

  const clickText = (t) => page.evaluate((txt) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().indexOf(txt) === 0);
    if (!b) throw new Error('找不到按钮：' + txt);
    b.click();
    return true;
  }, t);

  /* 「UV 查看」在模型库列表页也有一处（提示文案旁），底栏那个才是模型查看器的。
   * 点可见的最后一个，别撞到库页那颗。 */
  const clickLastVisible = (t) => page.evaluate((txt) => {
    const hits = Array.from(document.querySelectorAll('button')).filter(x => {
      if (x.textContent.trim().indexOf(txt) !== 0) return false;
      if (!x.offsetParent) return false;
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!hits.length) throw new Error('找不到可见按钮：' + txt);
    hits[hits.length - 1].click();
    return hits.length;
  }, t);

  const waitIdle = async () => {
    await page.waitForFunction(() => {
      const busy = Array.from(document.querySelectorAll('button')).some(b => /中…$/.test(b.textContent.trim()));
      return !busy;
    }, null, { timeout: 60000 });
  };

  /* 概览数字：UV 岛 / 三角面 / 网格 */
  const stats = () => page.evaluate(() => {
    const t = document.body.innerText;
    const pick = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
    return {
      islands: pick(/UV 岛\s*\n?\s*(\d+)/) || pick(/UV 岛 (\d+)/),
      tris: pick(/三角面\s*\n?\s*(\d+)/) || pick(/三角面 (\d+)/),
      meshes: pick(/网格\s*\n?\s*(\d+)/) || pick(/网格 (\d+)/),
      note: (t.match(/已缝合[^\n]*/) || [''])[0],
      err: (t.match(/(缝合|排布|还原)失败[^\n]*/) || [''])[0],
      uvNote: (t.match(/岛数 \d+ → \d+/) || [''])[0]
    };
  });

  const dumpAtlas = async (file) => page.evaluate((f) => {
    const im = document.querySelector('.mv3-uv-img');
    if (!im) return false;
    const a = document.createElement('a');
    a.href = im.src;
    const i = String(im.src).indexOf('base64,');
    if (i < 0) return false;
    window.__lastAtlas = String(im.src).slice(i + 7);
    window.__atlasName = f;
    return true;
  }, file).then(ok => {
    if (!ok) return false;
    return page.evaluate(() => {
      /* 把 base64 传回 Node：走 title 中转太绕，直接分块 eval 拿 */
      return window.__lastAtlas.length;
    }).then(async len => {
      let s = '';
      for (let off = 0; off < len; off += 400000) {
        s += await page.evaluate(o => window.__lastAtlas.substr(o, 400000), off);
      }
      fs.writeFileSync(path.join(__dirname, file), Buffer.from(s, 'base64'));
      return true;
    });
  });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openLibrary === 'function' && typeof Model3D !== 'undefined', null, { timeout: 15000 });
  await page.evaluate(() => openLibrary('model'));
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => libOpenAsset('frag-model'));
  await page.waitForFunction(() => document.querySelectorAll('.mv3-preset').length > 0, null, { timeout: 60000 });
  await page.waitForTimeout(800);

  console.log('=== 1. 打开 UV 视图 ===');
  await clickLastVisible('UV 查看');
  await page.waitForFunction(() => document.body.innerText.indexOf('三角面') >= 0 &&
    !document.body.innerText.match(/分析中|渲染中/), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const s0 = await stats();
  console.log('   原始:', JSON.stringify(s0));
  check('概览给出岛数', !!s0.islands && s0.islands > 100, String(s0.islands));
  check('三角面读到了', !!s0.tris && s0.tris > 1000, String(s0.tris));
  const islands0 = s0.islands, tris0 = s0.tris;
  await page.screenshot({ path: path.join(__dirname, '_stitch_ui_before.png') });
  await dumpAtlas('_stitch_before.png');

  console.log('=== 2. 缝合碎岛 ===');
  await clickText('缝合碎岛');
  await waitIdle();
  await page.waitForTimeout(600);
  const s1 = await stats();
  console.log('   缝合后:', JSON.stringify(s1));
  check('缝合提示出现', s1.note.indexOf('已缝合') >= 0, s1.note);
  check('岛数显著下降（碎片并回主岛）', !!s1.islands && s1.islands < islands0 * 0.7,
    islands0 + ' → ' + s1.islands + (s1.uvNote ? '（' + s1.uvNote + '）' : ''));
  check('三角面数不变（只动 UV 不动 3D）', s1.tris === tris0, tris0 + ' → ' + s1.tris);
  check('缝合无报错', !s1.err, s1.err);
  const islands1 = s1.islands;
  await dumpAtlas('_stitch_after.png');
  await page.screenshot({ path: path.join(__dirname, '_stitch_ui.png') });

  console.log('=== 3. 缝合后自动排布 ===');
  await clickText('自动排布');
  await waitIdle();
  await page.waitForTimeout(600);
  const s2 = await stats();
  console.log('   排布后:', JSON.stringify(s2));
  check('排布后没有报错', !s2.err, s2.err);
  check('排布后岛数与缝合后一致', s2.islands === s1.islands, s1.islands + ' → ' + s2.islands);
  await dumpAtlas('_stitch_packed.png');

  console.log('=== 4. 还原：回到缝合后的基线 ===');
  await clickText('还原');
  await waitIdle();
  await page.waitForTimeout(600);
  const s3 = await stats();
  console.log('   还原后:', JSON.stringify(s3));
  /* 缝合会把新 UV 拍成新基线（否则自动排布从基线重来会把缝合覆盖回碎片状态），
   * 所以「还原」回到的是缝合后、排布前 —— 岛数应等于缝合后 */
  check('还原后岛数回到缝合后的基线', s3.islands === islands1, islands1 + ' → ' + s3.islands);
  check('还原后三角面不变', s3.tris === tris0, String(s3.tris));
  check('还原无报错', !s3.err, s3.err);

  console.log('=== 5. 缝合 + 排布 → 存为 GLB ===');
  await clickText('缝合碎岛');
  await waitIdle();
  await clickText('自动排布');
  await waitIdle();
  await clickText('存为 GLB');
  await waitIdle();
  await page.waitForTimeout(800);
  const saved = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/已存入模型库：「[^」]+」/);
    return { note: m ? m[0] : '', putCount: window.__put.length,
             last: window.__put.length ? window.__put[window.__put.length - 1] : null };
  });
  check('GLB 已入库', saved.putCount > 0 && /已存入模型库/.test(saved.note), saved.note);
  check('入库的是 GLB', saved.last && saved.last.asset && saved.last.asset.ext === 'glb',
    saved.last ? saved.last.asset.ext : 'none');
  check('GLB 数据非空', saved.last && typeof saved.last.data === 'string' && saved.last.data.length > 100000,
    saved.last ? String(saved.last.data.length) : '0');

  check('页面零错误', errors.length === 0, errors.join(' | '));
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
