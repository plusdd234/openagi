/* 参考图清空逻辑体检（纯 mock 页面，不碰真实 Tripo）
 * 场景：
 *  1) 页面已有 3 张参考图，且每张有 × 删除按钮 → clearReferences 应全部清掉
 *  2) 页面已有参考图但**没有**任何删除控件 → 应返回 ok=false（由调用方整页重载兜底）
 *  3) 页面本来就没有参考图 → ok=true，不做任何事
 * 用法：node tools/clear-refs.js
 */
const { chromium } = require('playwright-core');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

// mock 页面：有 n 张参考图（blob 预览），可选带 × 删除按钮
function mockHtml(n, withDelete) {
  const imgs = Array.from({ length: n }, (_, i) => `
    <div class="ref-item">
      <img src="blob:mock/${i}" style="width:40px;height:40px">
      ${withDelete ? '<button class="icon delete-btn" aria-label="删除">×</button>' : ''}
    </div>`).join('');
  return `<!doctype html><meta charset="utf-8"><body>
    <div class="upload-area">${imgs}</div>
    <script>
      // 用 canvas 造出真实可解码的 blob 图，模拟页面上的参考图预览
      (async () => {
        const items = document.querySelectorAll('.ref-item');
        for (let i = 0; i < items.length; i++) {
          const cv = document.createElement('canvas'); cv.width = cv.height = 40;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = ['#e74c3c','#3498db','#2ecc71','#f39c12'][i % 4];
          ctx.fillRect(0, 0, 40, 40);
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          items[i].querySelector('img').src = URL.createObjectURL(blob);
        }
        window.__ready = true;
        // 有删除按钮时：点一下就把整张图从 DOM 移除
        document.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', () => {
          b.closest('.ref-item').remove();
        }));
      })();
    </script></body>`;
}

(async () => {
  const bridge = require(path.join(__dirname, '..', 'tripo-web.js'));
  const browser = await chromium.launch({ channel: 'msedge' });

  const openMock = async (n, withDelete) => {
    const page = await browser.newPage();
    await page.setContent(mockHtml(n, withDelete));
    await page.waitForFunction(() => window.__ready === true, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    return page;
  };
  const blobCount = (page) => page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0).length);

  console.log('=== 1. 有删除按钮 ===');
  const p1 = await openMock(3, true);
  check(await blobCount(p1) === 3, 'mock 页面已渲染 3 张参考图', 'count=' + await blobCount(p1));
  const r1 = await bridge.clearReferences(p1);
  check(r1.ok === true, 'clearReferences 返回成功', JSON.stringify(r1));
  check(r1.removed === 3, '报告清掉 3 张', 'removed=' + r1.removed);
  check(await blobCount(p1) === 0, '页面上的参考图已清空', 'count=' + await blobCount(p1));
  await p1.close();

  console.log('=== 2. 没有删除控件 ===');
  const p2 = await openMock(2, false);
  check(await blobCount(p2) === 2, 'mock 页面有 2 张参考图');
  const r2 = await bridge.clearReferences(p2);
  check(r2.ok === false, '无删除控件时返回 ok=false（交由调用方整页重载）', JSON.stringify(r2));
  check(r2.remain === 2, '并报告仍剩几张', 'remain=' + r2.remain);
  await p2.close();

  console.log('=== 3. 本来就没有参考图 ===');
  const p3 = await openMock(0, true);
  const r3 = await bridge.clearReferences(p3);
  check(r3.ok === true && r3.method === 'empty', '空状态直接返回 ok=true', JSON.stringify(r3));
  await p3.close();

  await browser.close();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
