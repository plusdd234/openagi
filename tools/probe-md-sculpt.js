'use strict';
/* 探针：建模 App 的「捏脸控制器」——单键微调 / 精确输入 / 存表情
 * 用法：node tools/probe-md-sculpt.js
 *
 * 验十件事：
 *   ① 形态键下拉带位移量级（「· 0.8mm」/「· 空」），能分辨有效键与空键；
 *   ② 主强度除了滑杆还有数值框，输入 37 就是 37（不是四舍五入到最近的格）；
 *   ③ 拖滑杆时数值框跟着走（paintCompNumber 认 INPUT，不是只认 textContent）；
 *   ④ 叠加多个键后，用某个 chip 的数值框**只改它**：其它键、当前主键都不动；
 *   ⑤ chip 数值框改成 0 = 移除这个键（不需要先切主键再拖）；
 *   ⑥ 点 chip 里的数值框**不会**把这个键删掉（外层不是 button，点击委托不该命中）；
 *   ⑦ 「存为表情」把当前叠加拍成快照写进 params.mine（纯数据、可序列化）；
 *   ⑧ 清零后套用那张脸，权重逐值回到快照；套用是整批替换（不是叠加）；
 *   ⑨ 删除自定义表情只删它自己；
 *   ⑩ 每一次数值改动 = 一条历史（撤销一次回到改之前）。
 *
 * 为什么不并进 probe-md-face：那个验的是「眼球到底有没有在看你」，
 * 这个验的是「手的动作有没有落到数据上」。失败时的排查方向完全不同。
 *
 * ⚠ 所有判据都读 params / mesh.weights，**不看截图**：
 *   捏脸是数值编辑，屏幕上差 3% 根本看不出来，但文档里差 3% 就是数据错了。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-sculpt');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(800);

  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1600);

  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* 参数是唯一判据。深拷贝一份回来，避免把活引用序列化时的循环问题带进来。 */
  const params = () => page.evaluate((id) => {
    const n = window.SeedModel.Scene.nodeById(window.modelDesk.getDocument(), id);
    return n && n.comp ? JSON.parse(JSON.stringify(n.comp.params || {})) : null;
  }, headId);

  /* 视口里的真实权重（跟 params 分开读）：证明改动真的落到了网格上，
   * 而不只是把数字记进了文档。 */
  const weights = () => page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    const n = window.SeedModel.Scene.nodeById(doc, id);
    const m = window.SeedModel.Scene.getMesh(doc, n);
    const out = {};
    (m && m.morphs || []).forEach((x) => { if (x.weight > 1e-6) out[x.name] = +x.weight.toFixed(4); });
    return out;
  }, headId);

  const setCev = (act, value, extra) => page.evaluate(([a, v, ex]) => {
    const sel = '[data-md-cev="' + a + '"]' + (ex ? '[data-md-cval="' + ex + '"]' : '');
    const el = document.querySelector(sel);
    if (!el) return false;
    if (el.type === 'checkbox') {
      el.checked = !!v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, [act, value, extra || '']);

  const clickCev = (act, arg) => page.evaluate(([a, c]) => {
    const sel = '[data-md-cev="' + a + '"]' + (c ? '[data-md-cval="' + c + '"]' : '');
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, [act, arg || '']);

  /* ---------- ① 下拉里的位移量级 ---------- */
  const amp = await page.evaluate(() => {
    const sel = document.querySelector('[data-md-cev="main"]');
    if (!sel) return null;
    const opts = Array.from(sel.querySelectorAll('option')).filter((o) => o.value);
    const mmRe = /\u00b7\s([\d.]+)\s?mm$/;
    const mm = [], blank = [];
    opts.forEach((o) => {
      const m = mmRe.exec(o.textContent);
      if (m) mm.push(Number(m[1]));
      else if (/\u00b7\s\u7a7a$/.test(o.textContent)) blank.push(o.value);
    });
    return {
      total: opts.length, mm: mm, blank: blank.length,
      max: mm.length ? Math.max.apply(null, mm) : 0,
      min: mm.length ? Math.min.apply(null, mm) : 0,
      sample: opts.slice(0, 2).map((o) => o.textContent)
    };
  });
  check(!!amp && amp.total > 100 && amp.mm.length + amp.blank === amp.total,
    '① 每个形态键都标了位移量级（有效键给 mm、空键写「空」）',
    amp ? (amp.total + ' 个 · ' + amp.mm.length + ' 个有位移 · ' + amp.blank + ' 个空 · 例：' + amp.sample.join(' / ')) : 'no select');
  /* 这份资产里**一个空键都没有**（112 个全有位移，最小 0.1mm 级）——
   * 所以不能断言「存在空键」，那是在替资产编事实。能断言的是
   * 「标注是真量出来的」：量级跨两个数量级，最大值必须是能看见的毫米级。
   * 若哪天标注退化成常量（比如全 0.0mm），这条会立刻红。 */
  check(!!amp && amp.max >= 3 && amp.min > 0 && amp.max / Math.max(amp.min, 1e-9) > 5,
    '①b 标注是实测位移而不是常量（跨度覆盖微调键与大动作键）',
    amp ? ('最小 ' + amp.min + 'mm · 最大 ' + amp.max + 'mm') : '');

  /* ---------- ②③ 主强度的数值框 ---------- */
  await setCev('main', 'mouth_smile_1');
  await page.waitForTimeout(400);
  const hasNum = await page.evaluate(() => !!document.querySelector('[data-md-cev="wNum"]'));
  check(hasNum, '② 主强度有精确数值框（不只是滑杆）', hasNum ? 'found #wNum' : 'missing');
  await setCev('wNum', 37);
  await page.waitForTimeout(500);
  const p37 = await params();
  check(p37 && Math.round(p37.weights.mouth_smile_1) === 37,
    '②b 输入 37 → weights 就是 37（不被步进吃掉）', 'w=' + (p37 && p37.weights.mouth_smile_1));

  /* 拖滑杆：数值框要跟着走。这条单独测是因为 paintCompNumber 早先只写 textContent，
   * 换成 input 之后如果不判 tagName，滑杆还在动、数字框纹丝不动（且零报错）。 */
  await page.evaluate(() => {
    const r = document.querySelector('[data-md-cev="w"]');
    r.value = '62';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const sync = await page.evaluate(() => {
    const el = document.querySelector('[data-md-cev="wNum"]');
    return el ? Number(el.value) : -1;
  });
  check(sync === 62, '③ 拖滑杆时数值框同步（paintCompNumber 认 INPUT）', 'num=' + sync);

  /* ---------- ④⑤⑥ 叠加键的 chip 数值框 ---------- */
  await setCev('main', 'eye_smile');
  await page.waitForTimeout(300);
  await setCev('w', 55);
  await page.waitForTimeout(400);
  const before = await params();
  const chips = await page.evaluate(() => document.querySelectorAll('.md-md-keyv').length);
  check(chips >= 2, '④ 叠加两个键后每个 chip 都有自己的数值框', chips + ' 个');

  /* 布局判据（不是看截图）：每个控件都要有实际宽度、不横向溢出面板块。
   * chip 从「一个按钮」变成「三段一体」之后，最容易被挤爆的就是这里 ——
   * 挤爆的表现是数值框宽度 0，用户点不到，而 DOM 里一切正常。 */
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.md-ctl');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    const bad = [];
    box.querySelectorAll('input, select, button').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width < 6 || b.height < 6) bad.push('zero:' + (el.className || el.tagName));
      else if (b.right > r.right + 1) bad.push('out:' + (el.className || el.tagName));
    });
    return { w: Math.round(r.width), sw: box.scrollWidth, cw: box.clientWidth, bad: bad.slice(0, 4), n: bad.length };
  });
  check(!!fit && fit.n === 0 && fit.sw <= fit.cw + 1,
    '④c 控制器里的控件都有实际尺寸、不横向溢出（三段 chip 没被挤爆）',
    fit ? (fit.w + 'px 宽 · 溢出项 ' + fit.n + (fit.bad.length ? ' ' + fit.bad.join(',') : '') +
      ' · scrollW ' + fit.sw + '/' + fit.cw) : 'no .md-ctl');

  /* 点数值框本身：外层是 span 不是 button，点击委托里 closest('button') 应当为 null */
  const alive = await page.evaluate(() => {
    const el = document.querySelector('[data-md-cev="chipw"][data-md-cval="eye_smile"]');
    if (!el) return { ok: false, why: 'no chip input' };
    el.click();
    return { ok: true };
  });
  await page.waitForTimeout(300);
  const afterClick = await params();
  check(alive.ok && afterClick && Math.round(afterClick.weights.eye_smile || 0) === 55,
    '⑥ 点 chip 里的数值框不会误删这个键（容器不是 button）',
    'eye_smile=' + (afterClick && afterClick.weights.eye_smile));

  /* 单键微调：改 chip 数值 → 只改它，其它键与 main 都不动 */
  await setCev('chipw', 21, 'eye_smile');
  await page.waitForTimeout(500);
  const tweak = await params();
  const other = before.weights.mouth_smile_1;
  check(tweak && Math.round(tweak.weights.eye_smile) === 21 &&
    Math.round(tweak.weights.mouth_smile_1 || 0) === Math.round(other || 0) &&
    tweak.main === 'eye_smile',
    '④b chip 数值框只改这一个键（另一键与当前主键都不动）',
    'eye_smile=21 · mouth_smile_1=' + (tweak && tweak.weights.mouth_smile_1) + ' · main=' + (tweak && tweak.main));

  /* 撤销粒度：上一步改数值应当是一条历史 */
  await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(600);
  const undone = await params();
  check(undone && Math.round(undone.weights.eye_smile || 0) === 55,
    '⑩ 改一次 chip 数值 = 一条历史（撤销一次回到 55）',
    'after undo eye_smile=' + (undone && undone.weights.eye_smile));

  /* 归零 = 移除 */
  await setCev('chipw', 0, 'eye_smile');
  await page.waitForTimeout(500);
  const zeroed = await params();
  check(zeroed && (zeroed.weights.eye_smile == null || Number(zeroed.weights.eye_smile) === 0),
    '⑤ chip 数值改成 0 = 移除这个键（不用先切主键再拖）',
    JSON.stringify(zeroed && zeroed.weights));

  /* ---------- ⑦⑧⑨ 存表情 → 清零 → 套用 → 删除 ---------- */
  await setCev('main', 'eye_smile');
  await page.waitForTimeout(300);
  await setCev('w', 55);
  await page.waitForTimeout(300);
  await setCev('main', 'mouth_smile_1');
  await page.waitForTimeout(300);
  await setCev('wNum', 30);
  await page.waitForTimeout(400);
  const snapshot = await params();
  const wantW = {
    eye_smile: Math.round(snapshot.weights.eye_smile || 0),
    mouth_smile_1: Math.round(snapshot.weights.mouth_smile_1 || 0)
  };

  await setCev('mineName', '探针脸');
  await page.waitForTimeout(300);
  const saved = await clickCev('mineSave');
  await page.waitForTimeout(700);
  const pMine = await params();
  const rec = pMine && (pMine.mine || [])[0];
  check(saved && pMine && (pMine.mine || []).length === 1 && rec && rec.name === '探针脸',
    '⑦ 「存为表情」把当前叠加存进 params.mine（带名字）',
    rec ? ('mine=' + (pMine.mine.length) + ' · name=' + rec.name + ' · w=' + JSON.stringify(rec.w)) : 'none');
  check(!!rec && Object.keys(rec.w || {}).length === 2 &&
    Number(rec.w.eye_smile) === wantW.eye_smile && Number(rec.w.mouth_smile_1) === wantW.mouth_smile_1,
    '⑦b 快照是**键名 → 百分比**的纯数据（可直接序列化进文档）',
    JSON.stringify(rec && rec.w));

  /* 清零：套用前必须真的空了，否则「套用成功」可能只是「本来就在」 */
  await clickCev('clear');
  await page.waitForTimeout(500);
  const cleared = await params();
  const clearedLive = await weights();
  check(cleared && Object.keys(cleared.weights || {}).length === 0 &&
    Object.keys(clearedLive).length === 0,
    '⑧ 清零：params 与视口权重同时归零', 'params=' + JSON.stringify(cleared && cleared.weights) +
    ' · mesh=' + JSON.stringify(clearedLive));

  await clickCev('mineUse', rec ? rec.id : '');
  await page.waitForTimeout(800);
  const used = await params();
  const usedLive = await weights();
  const usedOk = used &&
    Math.round(used.weights.eye_smile || 0) === wantW.eye_smile &&
    Math.round(used.weights.mouth_smile_1 || 0) === wantW.mouth_smile_1 &&
    Object.keys(used.weights).length === 2;
  check(usedOk, '⑧b 套用那张脸：权重逐值回到快照（整批替换，不是叠加）',
    JSON.stringify(used && used.weights));
  /* 视口里形态键权重是 0..1 的归一值，转成百分比比 */
  const livePct = {};
  Object.keys(usedLive).forEach((k) => { livePct[k] = Math.round(usedLive[k] * 100); });
  check(Math.round((livePct.eye_smile || 0)) === wantW.eye_smile &&
    Math.round((livePct.mouth_smile_1 || 0)) === wantW.mouth_smile_1,
    '⑧c 视口里的形态键权重也跟上了（不是只改了文档数字）',
    JSON.stringify(livePct));

  /* 再点一次同一张脸：不能变成 110% */
  await clickCev('mineUse', rec ? rec.id : '');
  await page.waitForTimeout(600);
  const twice = await params();
  check(Math.round(twice.weights.eye_smile || 0) === wantW.eye_smile,
    '⑧d 连点两次不会叠成双倍（表情 = 整张脸的姿态）', 'eye_smile=' + twice.weights.eye_smile);

  await clickCev('mineDel', rec ? rec.id : '');
  await page.waitForTimeout(600);
  const deld = await params();
  check(deld && (deld.mine || []).length === 0 && Object.keys(deld.weights || {}).length === 2,
    '⑨ 删除自定义表情只删它自己（当前叠加不动）',
    'mine=' + ((deld && deld.mine) || []).length + ' · weights=' + JSON.stringify(deld && deld.weights));

  /* ---------- 收尾 ---------- */
  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  RUN.finish(errors, { fails: fails });
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 条失败 · ' + RUN.dir : '✅ 全部通过 · ' + RUN.dir);
  process.exit(fails ? 1 : 0);
})();
