/* 真实页面只读探针（不点「生成」、不消耗积分）：
 * 上传 1 张参考图后，检查页面上「已有的参考图」长什么样、有没有删除/清空入口，
 * 供 tripo-web.js 实现「先清空再上传」。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '..', '.tripo-profile');
const PAGE_URL = 'https://studio.tripo3d.ai/zh/workspace/generate-image';
const TMP = path.join(ROOT, '..', 'tripo_tmp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const bridge = require(path.join(ROOT, '..', 'tripo-web.js'));
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null });
  const results = [];
  const check = (ok, name, extra) => { results.push(ok); console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : '')); };
  try {
    // profile 里可能残留已关闭的标签页，取第一个还活着的，否则新建
    let page = context.pages().find(p => !p.isClosed());
    if (!page) page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    await sleep(7000);
    if (page.isClosed()) { page = await context.newPage(); await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(6000); }

    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').slice(0, 200),
      fileInputs: document.querySelectorAll('input[type=file]').length,
      visFileInputs: Array.from(document.querySelectorAll('input[type=file]')).filter(el => {
        const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0;
      }).length,
      imgTotal: document.querySelectorAll('img').length,
    })).catch(e => ({ err: e.message }));
    console.log('  页面状态：', JSON.stringify(pageInfo));
    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_clear_refs.png') });

    // 生成一张测试图
    fs.mkdirSync(TMP, { recursive: true });
    const dataUrl = await page.evaluate(() => {
      const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#e74c3c'; ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('T', 48, 58);
      return cv.toDataURL('image/png');
    }).catch(() => null);
    const f = path.join(TMP, 'clear_probe.png');
    if (dataUrl) fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));

    const before = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter(i => i.naturalWidth > 0).length);
    const up = await bridge.attachReference(page, f);
    await sleep(2500);
    check(up, '已上传 1 张参考图', JSON.stringify(up));
    const after = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter(i => i.naturalWidth > 0).length);
    console.log('  可见图片数：' + before + ' → ' + after);

    // 找出参考图缩略图容器，以及其中可能的删除控件
    const info = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      // 找 blob: 预览图（刚上传的）
      const blobs = Array.from(document.querySelectorAll('img')).filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0);
      const blobInfo = blobs.map(i => {
        const b = i.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      });
      // 找所有可能的删除类控件
      const dels = [];
      Array.from(document.querySelectorAll('button,[role=button],svg,span,div,i')).forEach(el => {
        if (!vis(el)) return;
        const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
        const blobish = /delete|remove|clear|close|trash|x-?icon|del-?btn|icon-?close/i.test(cls);
        const aria = /delete|remove|clear|close/i.test((el.getAttribute('aria-label') || '') + (el.getAttribute('title') || ''));
        const txt = (el.innerText || '').trim();
        const isX = txt === '×' || txt === '✕' || txt === 'X';
        if (!blobish && !aria && !isX) return;
        const b = el.getBoundingClientRect();
        dels.push({
          tag: el.tagName.toLowerCase(),
          cls: cls.slice(0, 70),
          aria: el.getAttribute('aria-label') || el.getAttribute('title') || '',
          txt: txt.slice(0, 12),
          x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        });
      });
      return { blobInfo, dels: dels.slice(0, 30), imgCount: document.querySelectorAll('img').length };
    });
    console.log('  blob 预览图位置：', JSON.stringify(info.blobInfo));
    console.log('  可疑删除控件：', JSON.stringify(info.dels, null, 1));

    await page.screenshot({ path: path.join(ROOT, 'samples', 'probe_clear_refs.png') });
    check(info.blobInfo.length >= 1, '参考图预览已渲染', JSON.stringify(info.blobInfo));
    console.log('  找到 ' + info.dels.length + ' 个可能的删除控件');
    try { fs.unlinkSync(f); } catch (e) {}
  } finally {
    await context.close();
  }
  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('验证失败：', e.stack); process.exit(1); });
