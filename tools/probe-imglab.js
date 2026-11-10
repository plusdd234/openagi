/* 探针：图像工坊（PS 类多图层工作站）是否真的接上并能跑完整链路
 * 用法：node tools/probe-imglab.js
 *
 * 为什么单独一个：这套东西的关键卖点在「大图 + 瓦片 + 历史」，
 * 光看代码看不出真机上会不会白屏。这里从桌面图标点进去，验证：
 *   ① 演示稿建得起来、瓦片渲染有统计；
 *   ② 缩小时走 mip（一次 drawImage 顶替一堆瓦片）；
 *   ③ 画笔 / 油漆桶 / 滤镜都进历史，撤销能回来；
 *   ④ 调整层、导出、超大图降采样、大图导入都能工作；
 *   ⑤ 关闭按钮真的能把窗口收回去，且全程无 pageerror。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const icon = await page.evaluate(() => !!document.querySelector('.desk-app[data-app="imglab"]'));
  check(icon, '桌面上的「图像工坊」图标存在', '');

  await page.evaluate(() => window.openDeskApp('imglab'));
  await page.waitForTimeout(2600);

  let dbg = await page.evaluate(() => window.psLab && window.psLab.__debug());
  check(!!dbg && dbg.ready, 'psLab 就绪', '');
  check(!!dbg && dbg.visible, '窗口已翻到前台（没有 hidden）', '');
  check(await page.evaluate(() => !!document.querySelector('#psStageHost canvas.ps-canvas')), '画布节点存在', '');
  check(dbg.doc.w === 1600 && dbg.doc.h === 1000, '演示稿尺寸 1600 × 1000', dbg.doc.w + ' × ' + dbg.doc.h);
  check(dbg.doc.layers >= 3, '演示稿至少 3 个图层', dbg.doc.layers + ' 层：' + dbg.doc.names.join(' / '));
  check(dbg.tiles > 0, '首帧画出了瓦片', dbg.tiles + ' 瓦片');

  /* 1. 缩放：100% 用瓦片；缩到 18% 用 mip */
  await page.evaluate(() => window.psLab.__test.setZoom(1));
  await page.waitForTimeout(500);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(Math.abs(dbg.zoom - 1) < 0.001, 'setZoom(1) 生效', 'zoom=' + dbg.zoom);
  check(dbg.stats && dbg.stats.tiles > 0, '100% 时按瓦片绘制', dbg.stats && (dbg.stats.tiles + ' 瓦片 / ' + dbg.stats.ms + 'ms'));

  await page.evaluate(() => window.psLab.__test.setZoom(0.18));
  await page.waitForTimeout(600);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.mips > 0, '缩小后 mip 已生成', dbg.mips + ' 层 mip');
  check(dbg.stats && dbg.stats.mips > 0, '18% 时走 mip 绘制', dbg.stats && ('mips=' + dbg.stats.mips + ' / tiles=' + dbg.stats.tiles));

  await page.evaluate(() => window.psLab.__test.setZoom(1));
  await page.waitForTimeout(320);

  /* 2. 画笔 → 撤销 → 重做 */
  const before = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  await page.evaluate(() => window.psLab.__test.brushAt(200, 200));
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  check(after.hex !== before.hex, '画笔画上去了', before.hex + ' → ' + after.hex);
  const undid = await page.evaluate(() => window.psLab.__test.undo());
  const un = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  check(!!undid && un.hex === before.hex, '撤销后像素回到原样', un.hex);
  const redid = await page.evaluate(() => window.psLab.__test.redo());
  const re = await page.evaluate(() => window.psLab.__test.sample(200, 200));
  check(!!redid && re.hex === after.hex, '重做后像素再次出现', re.hex);

  /* 3. 选区 + 油漆桶 */
  await page.evaluate(() => window.psLab.__test.selectRect({ x: 780, y: 460, w: 150, h: 130 }));
  const fill = await page.evaluate(() => window.psLab.__test.fillAt(880, 520, '#2f7bff'));
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => window.psLab.__test.sample(880, 520));
  check(fill && fill.ok, '选区内油漆桶填充成功', fill && ('改了 ' + fill.count + ' 像素'));
  check(sel.hex !== '#e8a13a' && sel.b > 120, '填充颜色落在选区里', sel.hex);
  await page.evaluate(() => window.psLab.__test.selectClear());

  /* 4. 滤镜进历史 */
  const histBefore = dbg.history.length;
  const fr = await page.evaluate(async () => window.psLab.__test.filter('grayscale', {}));
  await page.waitForTimeout(500);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.history.length > histBefore, '灰度滤镜写入历史', histBefore + ' → ' + dbg.history.length);
  check(dbg.history.index === dbg.history.length - 1, '历史游标停在最新一步', dbg.history.index + '/' + dbg.history.length);
  check(!!fr, '滤镜返回结果', '');

  /* 5. 调整层 */
  const layersBefore = dbg.doc.layers;
  const adjId = await page.evaluate(() => window.psLab.__test.addAdjust('brightness'));
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(!!adjId && dbg.doc.layers === layersBefore + 1, '新建调整层', layersBefore + ' → ' + dbg.doc.layers);
  check(dbg.doc.types.indexOf('adjust') >= 0, '图层类型里出现 adjust', dbg.doc.types.join(','));

  /* 6. 导出 */
  const exp = await page.evaluate(() => window.psLab.__test.exportBlob('image/png'));
  check(exp && exp.size > 0 && exp.w === 1600 && exp.h === 1000, '导出 PNG', exp && (exp.size + ' bytes · ' + exp.w + '×' + exp.h));

  /* 7. 超大图导入前自动降采样 */
  const plan = await page.evaluate(() => window.psLab.__test.planImport(12000, 8000));
  check(plan.limited && plan.width < 12000 && plan.width * plan.height <= 48e6,
    '12000×8000 自动降采样', plan.width + '×' + plan.height + ' · scale=' + plan.scale.toFixed(3));

  /* 8. 3000×2000 大图导入 + mip */
  const bigUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 2000;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 3000, 2000);
    g.addColorStop(0, '#123456'); g.addColorStop(1, '#fedcba');
    x.fillStyle = g; x.fillRect(0, 0, 3000, 2000);
    x.fillStyle = 'rgba(255,255,255,.9)';
    x.font = 'bold 180px sans-serif';
    x.fillText('BIG', 280, 1200);
    return c.toDataURL('image/png');
  });
  const imp = await page.evaluate(async url => window.psLab.__test.importDataURL(url, '测试大图'), bigUrl);
  check(imp && imp.w === 3000 && imp.h === 2000, '导入 3000×2000 大图', imp && (imp.w + '×' + imp.h + ' · ' + imp.layers + ' 层'));
  await page.waitForTimeout(1600);
  dbg = await page.evaluate(() => window.psLab.__debug());
  check(dbg.mips > 0, '大图导入后 mip 生成', dbg.mips + ' 层 mip');
  check(dbg.tiles > 0, '大图按瓦片存储', dbg.tiles + ' 瓦片 · ' + Math.round(dbg.memory / 1048576) + ' MB 估算');

  /* 9. 关闭按钮 */
  const closed = await page.evaluate(() => {
    const b = document.getElementById('btnImgLabClose');
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(600);
  const hidden = await page.evaluate(() => {
    const w = document.getElementById('imgLabWin');
    return !!w && w.classList.contains('hidden');
  });
  check(closed && hidden, '关闭按钮能收回窗口', '');

  check(errors.length === 0, '无 pageerror', errors.join(' | '));

  await browser.close();
  console.log(fails ? '\n❌ ' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(1);
});
