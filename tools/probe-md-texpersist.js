/* 探针：建模 App · 贴图笔迹层的「重启后还能读回来」
 * 用法：node tools/probe-md-texpersist.js
 *
 * 背景（曾经的 bug）：v4 配置里的 ops 像素被外置成 'blob:<id>' 存根，
 * 但 blob-store 启动时只按「工作流 / 蓝图」收集要读回的 id，不认识
 * openagi_model_tex_v1 —— 重启后笔迹层一层都解不出来，用户看到的是
 * 「画好的贴图保存出来是旧的」。
 *
 * 覆盖：
 *   1) 配置引用的 blob 在页面重载后仍能解析成原文（根提供者 + 启动收集）
 *   2) blobGC 不会把贴图配置引用的块当垃圾删掉（GC 存活根）
 *   3) 启动后才写入的存根也能用 blobFetch 单条兜底取回
 *
 * 说明：无头环境没有桌面桥，走 IndexedDB 这条真实后端；
 * 每次用全新的浏览器 profile，不碰用户的本地数据。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-texpersist');
const ROOT = path.join(__dirname, '..');
const ID_A = 'probe_texpersist_a';
const ID_B = 'probe_texpersist_b';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

async function openPaint(page) {
  await page.evaluate(() => window.openDeskApp && window.openDeskApp('modeldesk'));
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const b = document.querySelector('[data-md-tbk="paint"]');
    if (b) b.click();
  });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  try {
    const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await openPaint(page);

    /* 造一份「笔迹层已外置」的真实状态：配置引用 blob 存根，像素进 IndexedDB */
    const seeded = await page.evaluate(async ({ idA, png }) => {
      await blobPutIdb(idA, png);
      localStorage.setItem('openagi_model_tex_v1', JSON.stringify({
        probeAsset: {
          v: 4, layers: [], baked: null,
          ops: [{ type: 'paint', src: 'blob:' + idA }]
        }
      }));
      return typeof blobRegisterRoot === 'function';
    }, { idA: ID_A, png: PNG });
    check('blob-store 提供根注册接口', seeded === true);

    const roots = await page.evaluate(() => (typeof BLOB_ROOTS === 'undefined' ? -1 : BLOB_ROOTS.length));
    check('贴图配置已注册为 blob 存活根', roots >= 1, 'roots=' + roots);

    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    await openPaint(page);

    const afterReload = await page.evaluate(async (idA) => {
      await blobEnsure();
      return { resolved: blobResolve('blob:' + idA) };
    }, ID_A);
    check('重载后配置里的 blob 存根能解回原文',
      typeof afterReload.resolved === 'string' && afterReload.resolved.indexOf('data:image/png') === 0,
      JSON.stringify(afterReload).slice(0, 160));

    const afterGc = await page.evaluate(async (idA) => {
      await blobGC({});
      const keep = await blobGetIdb(idA);
      return { kept: typeof keep === 'string' && keep.length > 0,
        meta: JSON.parse(localStorage.getItem('openagi_model_tex_v1') || '{}') };
    }, ID_A);
    check('blobGC 保留贴图配置引用的块', afterGc.kept === true, JSON.stringify(afterGc).slice(0, 200));
    check('GC 没有顺手删掉配置本身',
      !!(afterGc.meta && afterGc.meta.probeAsset && afterGc.meta.probeAsset.ops.length === 1));

    /* 启动后才出现的存根：全量根收集来不及覆盖，靠 blobFetch 单条兜底 */
    const late = await page.evaluate(async ({ idB, png }) => {
      await blobPutIdb(idB, png);
      const got = await blobFetch(idB);
      return { got: typeof got === 'string' && got.length > 0 };
    }, { idB: ID_B, png: PNG });
    check('blobFetch 能单条取回启动后新增的存根', late.got === true);

    check('全程无 pageerror', errors.length === 0, errors.join(' | '));
  } catch (e) {
    fail++;
    console.log('  ✗ 探针崩了：' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
  }
  RUN.finish(fail ? ['失败 ' + fail + ' 项'] : []);
  console.log('\n' + (fail ? '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过' : '✅ 全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})();
