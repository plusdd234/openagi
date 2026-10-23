/* 真实页面只读验证（不点「生成」、不消耗积分）：
 * 连接桥已经打开的普通 Edge（CDP 9222），复用同一登录态，
 * 验证「先清空已有参考图」的实际效果：
 *   上传 2 张 → 确认页面上有 2 张 → clearReferences → 确认清空 → 再上传 1 张 → 确认只有 1 张
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const TMP = path.join(ROOT, '..', 'tripo_tmp');
const CDP_URL = process.env.TRI_CDP_URL || 'http://127.0.0.1:9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const bridge = require(path.join(ROOT, '..', 'tripo-web.js'));
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const results = [];
  const check = (ok, name, extra) => { results.push(ok); console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : '')); };
  try {
    const page = ctx.pages().filter(p => !p.isClosed()).find(p => /tripo3d/.test(p.url())) || ctx.pages()[0];
    await page.bringToFront().catch(() => {});
    const title = await page.title();
    console.log('  页面：' + title.slice(0, 44));

    // 页面若还在 Cloudflare 验证页，直接给出结论
    if (/请稍候|just a moment/i.test(title || '')) {
      console.log('  ⚠️ 页面仍在 Cloudflare 验证页，跳过真实页面验证');
      try { await browser.close(); } catch (e) {}
      process.exit(2);
    }

    // 未登录时上传不会生效（页面显示「注册/登录」），先判定清楚
    const bodyTxt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (/注册\/登录|登录 \/ 注册|立即登录/.test(bodyTxt || '')) {
      console.log('  ⚠️ Tripo 登录态已失效（页面右上角是「注册/登录」），上传不会被页面接受。');
      console.log('     请在已打开的 Edge 窗口里重新登录一次，再跑本探针。');
      try { await browser.close(); } catch (e) {}
      process.exit(2);
    }

    // 三张测试图
    fs.mkdirSync(TMP, { recursive: true });
    const files = [];
    for (let i = 0; i < 3; i++) {
      const dataUrl = await page.evaluate((n) => {
        const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = ['#e74c3c', '#3498db', '#2ecc71'][n];
        ctx.fillRect(0, 0, 96, 96);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(String(n + 1), 48, 58);
        return cv.toDataURL('image/png');
      }, i).catch(() => null);
      if (!dataUrl) break;
      const f = path.join(TMP, 'clear_probe_' + i + '.png');
      fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
      files.push(f);
    }
    check(files.length === 3, '三张测试图已生成');

    const blobCount = () => page.evaluate(() => Array.from(document.querySelectorAll('img'))
      .filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0).length).catch(() => 0);

    // ① 先上传 2 张，制造「已有参考图」的状态
    const up1 = await bridge.attachReference(page, files[0]);
    await sleep(1500);
    const up2 = await bridge.attachReference(page, files[1]);
    await sleep(9000);
    const n1 = await blobCount();
    check(up1 && up2, '已上传 2 张参考图', JSON.stringify([up1, up2]));
    check(n1 >= 2, '页面上现在有 ' + n1 + ' 张参考图');
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_clear_refs_before.png') });

    // ② 清空
    const cl = await bridge.clearReferences(page);
    await sleep(1200);
    const n2 = await blobCount();
    console.log('  清空结果：' + JSON.stringify(cl) + ' → 剩余 ' + n2 + ' 张');
    check(cl.ok === true, 'clearReferences 成功', JSON.stringify(cl));
    check(n2 < n1, '参考图数量已减少（' + n1 + ' → ' + n2 + '）');
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_clear_refs_after.png') });

    // ③ 清空后再上传 1 张，应该只有 1 张（没有叠加旧的）
    const up3 = await bridge.attachReference(page, files[2]);
    await sleep(9000);
    const n3 = await blobCount();
    check(up3, '清空后可正常重新上传', JSON.stringify(up3));
    check(n3 === 1, '页面上只剩 1 张（没有与旧图叠加）', 'count=' + n3);
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_clear_refs_final.png') });

    files.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    try { await browser.close(); } catch (e) {}
  } catch (e) {
    console.error('验证失败：', e.stack);
    try { await browser.close(); } catch (e2) {}
    process.exit(1);
  }
  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('验证失败：', e.stack); process.exit(1); });
