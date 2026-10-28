/* tripo 参考图就绪闸门体检（全程不触发生成、不消耗积分）
 * 复现 bug（用户报告「参考图没上传完毕就开始生成了」）：
 * 写入文件控件只代表浏览器接受了文件，页面还要转码 / 上传 / 处理，之后才渲染参考图缩略图。
 * 旧实现「写完固定等 1.8s 就点生成」，上传稍慢就会带着不完整的参考图生成。
 *
 * A. waitRefsReady / waitThumbGrow 单测（假页面，不起浏览器）：
 *    数量始终不达标 → ok:false（闸门拦得住）；缓慢就绪 → 放行；
 *    页面不渲染可识别缩略图 → 降级放行（不误伤）；持续 busy → 宽限后放行
 * B. runOnce 端到端（mock 慢上传页）：
 *    B1 慢上传：等参考图全部就绪才点生成（旧实现在就绪前就点）
 *    B2 第 2 张被页面拒绝（上传失败）：就绪闸门中止生成，且绝不点生成
 *    B3 页面无可识别缩略图：降级放行，不阻断正常流程
 * C. attachMultiView：逐槽等缩略图就绪，返回时 4 张预览已全部出现
 * 用法：node plugins/tripo/tests/tripo-ref-wait.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* ================= A. 就绪探测单测（假页面） ================= */

// 假页面：evaluate 时把 refsSnapshot 的回调放到受控的 document 上执行。
// plan(t) 按「距创建的毫秒数」返回 { imgs, busy }，模拟页面状态随时间变化。
function fakePage(plan) {
  const st = { t0: Date.now(), imgs: [], busy: [] };
  return {
    evaluate: async (fn) => {
      const r = plan(Date.now() - st.t0) || {};
      st.imgs = r.imgs || [];
      st.busy = r.busy || [];
      const doc = {
        images: st.imgs,
        querySelectorAll: (sel) => (/progress|loading|uploading|spinner/i.test(sel) ? st.busy : []),
      };
      global.document = doc;
      try { return fn(); } finally { delete global.document; }
    },
  };
}
const mkImg = () => ({
  currentSrc: 'blob:fake', src: 'blob:fake', naturalWidth: 64,
  getBoundingClientRect: () => ({ width: 64, height: 64 }),
});
const mkBusy = () => ({
  className: 'upload-progress',
  getBoundingClientRect: () => ({ width: 120, height: 8 }),
});

(async () => {
  const bridge = require(path.join(__dirname, '..', 'tripo-web.js'));

  console.log('=== A. waitRefsReady / waitThumbGrow 单测 ===');

  // A1 数量始终差一张：闸门必须拦住（这是用户 bug 的核心防线）
  const p1 = fakePage(() => ({ imgs: [mkImg()], busy: [] }));
  const tA1 = Date.now();
  const r1 = await bridge.waitRefsReady(p1, 2, { timeoutMs: 3000 });
  check(r1.ok === false, 'A1 数量不达标 → 闸门拦住（ok=false）', JSON.stringify({ ok: r1.ok, reason: r1.reason, loaded: r1.loaded }));
  check(r1.loaded === 1 && r1.total === 1, 'A1 回报已就绪数量供提示使用', 'loaded=' + r1.loaded);
  check(Date.now() - tA1 >= 2800, 'A1 等满超时才放弃', (Date.now() - tA1) + 'ms');

  // A2 上传慢（前 2.5s 只有进度条）：就绪后放行，且带 1.2s 静默稳定期
  const p2 = fakePage(t => t < 2500 ? { imgs: [], busy: [mkBusy()] } : { imgs: [mkImg(), mkImg()], busy: [] });
  const tA2 = Date.now();
  const r2 = await bridge.waitRefsReady(p2, 2, { timeoutMs: 10000 });
  check(r2.ok === true && r2.verified === true && r2.reason === 'ready', 'A2 缓慢就绪 → 放行', JSON.stringify({ ok: r2.ok, reason: r2.reason, loaded: r2.loaded }));
  check(Date.now() - tA2 >= 3400, 'A2 等到全部就绪 + 静默稳定后才放行', (Date.now() - tA2) + 'ms');

  // A3 页面压根不渲染可识别的缩略图：降级放行，不能把正常流程拖死/误伤
  const p3 = fakePage(() => ({ imgs: [], busy: [] }));
  const tA3 = Date.now();
  const r3 = await bridge.waitRefsReady(p3, 1, { timeoutMs: 8000 });
  check(r3.ok === true && r3.verified === false && r3.reason === 'no-thumbs', 'A3 无可识别缩略图 → 降级放行不阻断', JSON.stringify({ ok: r3.ok, reason: r3.reason }));
  check(Date.now() - tA3 < 4500, 'A3 降级前只短等约 3 秒', (Date.now() - tA3) + 'ms');

  // A4 数量够但页面持续 busy（可能是无关动画）：宽限后放行，不永久卡死
  const p4 = fakePage(() => ({ imgs: [mkImg(), mkImg()], busy: [mkBusy()] }));
  const r4 = await bridge.waitRefsReady(p4, 2, { timeoutMs: 20000, busyGraceMs: 1500 });
  check(r4.ok === true && r4.reason === 'busy-ignored', 'A4 持续 busy → 宽限后放行', JSON.stringify({ ok: r4.ok, reason: r4.reason }));

  // A5/A6 waitThumbGrow：等到新缩略图 / 页面无缩略图时短等后放过
  const p5 = fakePage(t => t < 1500 ? { imgs: [], busy: [mkBusy()] } : { imgs: [mkImg()], busy: [] });
  const g1 = await bridge.waitThumbGrow(p5, 0, { timeoutMs: 8000 });
  check(g1.ok === true && g1.loaded === 1, 'A5 waitThumbGrow 等到新缩略图', JSON.stringify(g1));
  const p6 = fakePage(() => ({ imgs: [], busy: [] }));
  const tA6 = Date.now();
  const g2 = await bridge.waitThumbGrow(p6, 0, { timeoutMs: 8000, noThumbMs: 2000 });
  check(g2.ok === false && Date.now() - tA6 < 3200, 'A6 页面无缩略图 → 短等后放过', JSON.stringify(g2) + ' ' + (Date.now() - tA6) + 'ms');

  /* ================= B. runOnce 端到端（mock 慢上传页） ================= */
  console.log('=== B. runOnce 端到端（mock 页） ===');

  const MOCK_HTML = `<!doctype html><meta charset="utf-8"><body>
<style>.hide{display:none!important}#prog,#err{font-size:12px}#err{color:#c00}</style>
<div id="panel">
  <div id="inputs"></div>
  <div id="prog" class="upload-progress hide">上传中 0%</div>
  <div id="err" class="hide">上传失败</div>
  <div id="thumbs"></div>
  <textarea id="prompt" placeholder="描述你想要的画面" style="width:420px;height:90px"></textarea>
  <button id="gen" style="width:120px;height:36px">生成</button>
  <div id="results"></div>
</div>
<script>
const MODE = new URLSearchParams(location.search).get('m') || 'slow';
const DELAY = MODE === 'multi' ? 1200 : 2500;   // 模拟页面处理一张图要多久
window.__genClicked = 0; window.__appended = 0; window.__writes = 0;
const $ = id => document.getElementById(id);
if (MODE === 'multi') {
  for (let i = 0; i < 4; i++) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.className = 'slot-input';
    inp.setAttribute('accept', 'image/png,image/jpeg,image/webp');
    inp.style.cssText = 'display:block;width:80px;height:24px';
    $('inputs').appendChild(inp);
  }
} else {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.id = 'f'; inp.multiple = true;
  inp.setAttribute('accept', 'image/png,image/jpeg,image/webp');
  $('inputs').appendChild(inp);
}
function showProg(on) { $('prog').classList.toggle('hide', !on); }
function showErr(on) { $('err').classList.toggle('hide', !on); }
function addThumb(file) {
  window.__writes++;
  if (MODE === 'reject2' && window.__writes >= 2) {   // 第 2 张起被页面拒绝
    showErr(true);
    setTimeout(() => showErr(false), 3000);
    return;
  }
  if (MODE === 'nothumb') return;                     // 页面不渲染可识别的缩略图
  showProg(true);
  const url = URL.createObjectURL(file);
  setTimeout(() => {
    showProg(false);
    const img = new Image();
    img.src = url; img.width = 64; img.height = 64;
    $('thumbs').appendChild(img);
    window.__appended++;
  }, DELAY);
}
$('inputs').addEventListener('change', e => {
  if (!e.target.matches('input[type=file]')) return;
  Array.from(e.target.files || []).forEach(f => addThumb(f));
  e.target.value = '';
});
$('gen').addEventListener('click', () => {
  window.__genClicked++;
  const c = document.createElement('canvas'); c.width = c.height = 300;
  const x = c.getContext('2d');
  x.fillStyle = '#3498db'; x.fillRect(0, 0, 300, 300);
  x.fillStyle = '#fff'; x.font = '40px sans-serif'; x.fillText('OK', 120, 160);
  const img = new Image();
  img.src = c.toDataURL('image/png');
  $('results').appendChild(img);
});
</script></body>`;

  const browser = await chromium.launch({ channel: 'msedge' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refwait-'));
  const mockPath = path.join(tmp, 'mock.html');
  fs.writeFileSync(mockPath, MOCK_HTML);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  // 每次换 query 触发整页重载，保证场景间状态干净
  const runImg = (mode, images) => page
    .goto(pathToFileURL(mockPath).href + '?m=' + mode, { waitUntil: 'load' })
    .then(() => bridge.runOnce(ctx, page, '一只棕色的猫坐在草地上', { images, timeoutSec: 20 }));

  // B1 慢上传：两张各要 2.5s 才就绪，旧实现（固定等 1.8s）会在第一张就绪前就点生成
  const tB1 = Date.now();
  const r1e = await runImg('slow', [PNG_1PX, PNG_1PX]);
  const gen1 = await page.evaluate(() => window.__genClicked);
  check(r1e.ok === true, 'B1 慢上传：等全部就绪后生成成功', r1e.message || r1e.file);
  check(gen1 === 1, 'B1 点击了 1 次生成', 'genClicked=' + gen1);
  check(r1e.file && fs.existsSync(r1e.file), 'B1 结果文件已保存', r1e.file);
  check(Date.now() - tB1 >= 5000, 'B1 确实等了上传（≥5s，含 2×2.5s 处理 + 静默稳定期）', (Date.now() - tB1) + 'ms');

  // B2 第 2 张被页面拒绝（显示「上传失败」）：闸门必须中止，且绝不点生成
  const r2e = await runImg('reject2', [PNG_1PX, PNG_1PX]);
  const gen2 = await page.evaluate(() => window.__genClicked);
  check(r2e.ok === false, 'B2 上传不完整：返回失败', r2e.message);
  check(/参考图尚未处理完成/.test(r2e.message || '') && /已中止生成/.test(r2e.message || ''),
    'B2 失败原因是就绪闸门中止（而非误报上传失败）', r2e.message);
  check(/已就绪 1\/2/.test(r2e.message || ''), 'B2 提示已就绪数量 1/2', r2e.message);
  check(gen2 === 0, 'B2 关键回归：参考图未全部就绪前绝不点生成', 'genClicked=' + gen2);

  // B3 页面无可识别缩略图：降级放行，不把正常流程误判成失败
  const r3e = await runImg('nothumb', [PNG_1PX, PNG_1PX]);
  const gen3 = await page.evaluate(() => window.__genClicked);
  check(r3e.ok === true, 'B3 无可识别缩略图：不误伤正常流程', r3e.message || r3e.file);
  check(gen3 === 1, 'B3 降级放行后点了生成', 'genClicked=' + gen3);

  /* ================= C. attachMultiView 逐槽就绪 ================= */
  console.log('=== C. attachMultiView 逐槽就绪 ===');
  const pm = await browser.newPage();
  await pm.goto(pathToFileURL(mockPath).href + '?m=multi', { waitUntil: 'load' });
  const tC = Date.now();
  const up = await bridge.attachMultiView(pm, { front: PNG_1PX, left: PNG_1PX, right: PNG_1PX, back: PNG_1PX });
  const thumbs = await pm.evaluate(() => document.querySelectorAll('#thumbs img').length);
  check(up === 4, 'C 四槽全部写入', 'uploaded=' + up);
  check(thumbs === 4, 'C 返回时 4 张缩略图已全部就绪（旧实现写完盲等会带着 0 张返回）', 'thumbs=' + thumbs);
  check(Date.now() - tC >= 4000, 'C 逐槽串行等待各槽就绪（约 4×1.2s）', (Date.now() - tC) + 'ms');

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
