/* 探针：图库「重命名」对话框（真实 Electron 渲染进程）
 * 用法：node tools/probe-library-rename.js
 *
 * 为什么要有这一份：
 *   改名原来走 window.prompt。Electron 渲染进程里 prompt 是**明确不支持的**实现，
 *   调用当场抛 "prompt() is not supported." —— 右键 → 重命名点了毫无反应，
 *   异常在弹框那一步把整条链路打断，连 libState.error 都落不上。
 *   换成自绘 .lib-ask 之后，这条链路必须真窗口验一遍：
 *     · DOM 桩（tools/library.js）验不到排版：.os-win 带 transform + overflow:hidden，
 *       position:fixed 的遮罩到底盖不盖满窗口，只有真的排一次版才知道；
 *     · 「只选中基名不选扩展名」靠 setSelectionRange，桩里是空实现。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-libask-'));

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 会把 Electron 降成纯 Node
  delete env.OPENAGI_SMOKE;

  /* 源码断言：改名链路不许再碰 window.prompt */
  const src = fs.readFileSync(path.join(ROOT, 'js/library.js'), 'utf8');
  check(!/[^.\w]prompt\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'library.js 不再调用 prompt()');

  let app = null;
  try {
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [ROOT, '--user-data-dir=' + USERDATA, '--no-sandbox'],
      env,
      timeout: 60000
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message)));
    await page.waitForLoadState('load');
    await page.waitForTimeout(1500);

    /* ① 复现根因：这个环境里 prompt 确实不可用（否则下面的自绘就没必要） */
    const promptErr = await page.evaluate(() => {
      try { window.prompt('t', 'v'); return 'OK'; } catch (e) { return String(e && e.message); }
    });
    check(/not supported/i.test(promptErr), '本环境 prompt() 不可用（改名必须自绘）', promptErr);

    /* ② 打开图库，拿到真实窗口 */
    await page.evaluate(() => { if (typeof openDeskApp === 'function') openDeskApp('gallery'); });
    await page.waitForTimeout(800);
    const hasWin = await page.evaluate(() => {
      const w = document.getElementById('libWin');
      return !!(w && w.offsetWidth > 100);
    });
    check(hasWin, '图库窗口已打开（#libWin 有实际尺寸）');

    /* ③ 打开改名框，量一遍排版 */
    await page.evaluate(() => {
      window.__askResult = 'PENDING';
      libAskName({ title: '重命名资产', value: '首屏海报.png', selectBase: true })
        .then(v => { window.__askResult = (v === null ? 'NULL' : String(v)); });
    });
    await page.waitForSelector('.lib-ask', { timeout: 5000 });
    const geo = await page.evaluate(() => {
      const a = document.querySelector('.lib-ask').getBoundingClientRect();
      const w = document.getElementById('libWin').getBoundingClientRect();
      const i = document.querySelector('.lib-ask-input');
      return {
        a: [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)],
        w: [Math.round(w.left), Math.round(w.top), Math.round(w.width), Math.round(w.height)],
        val: i.value, ss: i.selectionStart, se: i.selectionEnd,
        focused: document.activeElement === i
      };
    });
    const coverW = Math.abs(geo.a[2] - geo.w[2]) <= 2 && Math.abs(geo.a[0] - geo.w[0]) <= 2;
    const coverH = Math.abs(geo.a[3] - geo.w[3]) <= 2 && Math.abs(geo.a[1] - geo.w[1]) <= 2;
    check(coverW && coverH, '遮罩正好铺满图库窗口（祖先 transform 没有把定位撕开）',
      '遮罩 ' + geo.a.join(',') + ' / 窗口 ' + geo.w.join(','));
    check(geo.val === '首屏海报.png', '输入框预填当前名', geo.val);
    check(geo.ss === 0 && geo.se === 4, '只选中基名、不选扩展名（.png 前留光标）', geo.ss + '→' + geo.se);
    check(geo.focused, '输入框自动获得焦点');

    /* ④ Enter 确认 */
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const r1 = await page.evaluate(() => window.__askResult);
    check(r1 === '首屏海报.png', 'Enter 确认返回新名字', r1);
    check(await page.evaluate(() => !document.querySelector('.lib-ask')), '确认后对话框从 DOM 移除');

    /* ⑤ Esc 取消 */
    await page.evaluate(() => {
      window.__askResult = 'PENDING';
      libAskName({ title: '重命名资产', value: 'a.png', selectBase: true })
        .then(v => { window.__askResult = (v === null ? 'NULL' : String(v)); });
    });
    await page.waitForSelector('.lib-ask');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__askResult) === 'NULL', 'Esc 取消返回 null（不改名）');

    /* ⑥ 点遮罩取消 */
    await page.evaluate(() => {
      window.__askResult = 'PENDING';
      libAskName({ title: '重命名资产', value: 'b.png', selectBase: true })
        .then(v => { window.__askResult = (v === null ? 'NULL' : String(v)); });
    });
    await page.waitForSelector('.lib-ask');
    const box = await page.evaluate(() => {
      const r = document.querySelector('.lib-ask').getBoundingClientRect();
      return { x: Math.round(r.left + 8), y: Math.round(r.top + 8) };
    });
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__askResult) === 'NULL', '点遮罩取消返回 null');
    check(await page.evaluate(() => !document.querySelector('.lib-ask')), '取消后没有残留节点');

    /* ⑦ 连开两次不留两个框（F2 连按 / 双击又右键） */
    await page.evaluate(() => {
      window.__first = 'PENDING';
      libAskName({ title: 'A', value: '1.png' }).then(v => { window.__first = (v === null ? 'NULL' : v); });
      window.__second = 'PENDING';
      libAskName({ title: 'B', value: '2.png' }).then(v => { window.__second = (v === null ? 'NULL' : v); });
    });
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.querySelectorAll('.lib-ask').length) === 1, '同时只存在一个改名框');
    check(await page.evaluate(() => window.__first) === 'NULL', '被顶掉的那个当取消收掉（不悬挂 Promise）');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    /* ⑧ 真正的端到端：写一个资产进索引 → libRename → 回车 → 索引里的名字真的变了。
     *    这一步才证明「右键重命名无效」真的修好了：不是对话框能弹，而是改得动。 */
    const putId = await page.evaluate(async () => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bin = atob(png.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const r = await window.openagiDesktop.assetPut({ kind: 'image', ext: 'png', name: '旧名字.png', data: bytes, source: 'probe' });
      return r && r.ok ? r.asset.id : '';
    });
    check(!!putId, '探针写入测试资产（走真实 asset:put）', putId);

    await page.evaluate(() => { libState.kind = 'image'; return libRefresh(); });
    /* 注意：不能 await libRename 的 Promise —— 它要等用户点确定才 resolve，
     * 在 evaluate 里 await 会把探针自己卡住。开火后不管，用 waitForSelector 等框。 */
    await page.evaluate(id => { libSetSel([id]); libRename([id]); }, putId);
    await page.waitForSelector('.lib-ask', { timeout: 5000 });
    await page.fill('.lib-ask-input', '');
    await page.keyboard.type('新名字.png');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const after = await page.evaluate(async id => {
      const l = await window.openagiDesktop.assetList();
      const a = (l.assets || []).find(x => x.id === id);
      return { name: a && a.name, inDom: new RegExp('新名字').test(document.getElementById('libBody').innerHTML) };
    }, putId);
    check(after.name === '新名字.png', '回车后索引里的名字真的改了', JSON.stringify(after));
    check(after.inDom, '网格上显示的是新名字（libRefresh 之后画面同步）');

    check(errors.length === 0, '页面零错误', errors.slice(0, 3).join(' | '));
  } catch (e) {
    check(false, '探针自身异常', String((e && e.message) || e).slice(0, 300));
  } finally {
    if (app) { try { await app.close(); } catch (e) {} }
  }

  console.log(fails ? '\n❌ ' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})();
