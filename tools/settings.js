/* 体检：设置面板（重做后的 .settings2 壳）
 * 用法：node tools/settings.js
 *
 * 只测「结构」不测「功能细节」：配置读写各字段有自己的测试，这里要守住的是
 *  ① 导航 tab 与 pane 一一对应（缺一个就是点进去白屏）
 *  ② 每个 pane 的关键 id 还在（config.js / bind.js 按 id 绑，删了就静默失效）
 *  ③ 总览卡片数量 + 点卡片能跳过去（settings-home.js 的唯一职责）
 *  ④ openSettings('image'/'llm') 这两条**被代码直接调用**的入口不能坏
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 每个 pane 必须存在的 id。故意只列「按 id 被 js 读写」的那些，
 * 纯展示的装饰元素不加进来——那种删了不影响功能，加进来只会让测试变脆。 */
const MUST = {
  overview: ['setHomeGrid', 'setHomePaths'],
  llm: ['llmKey', 'llmBaseUrl', 'llmModel', 'btnLoadModels', 'modelStatus', 'testLLM', 'llmPresetLinks'],
  image: ['genEngine', 'imgKey', 'imgBaseUrl', 'imgModel', 'btnLoadImgModels', 'imgEndpoint', 'imgSize', 'respPath', 'sendImage', 'testIMG'],
  search: ['wsProvider', 'wsBase', 'wsKey', 'wsCount', 'btnTestSearch', 'wsStatus'],
  relay: ['relayUrl', 'relayOn', 'btnTestRelay', 'relayStatus'],
  account: ['gwEmail', 'gwPassword', 'gwLogin', 'gwRegister', 'gwLoggedOut', 'gwLoggedIn', 'gwUsage', 'gwLogout'],
  assets: ['paneAssets'],
  about: ['resetKey']
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  console.log('\n=== 1. 导航与分组一一对应 ===');
  const nav = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.set-nav .tab')).map(t => t.dataset.tab);
    const panes = Array.from(document.querySelectorAll('.tabpane')).map(p => p.dataset.pane);
    return { tabs, panes };
  });
  check(nav.tabs.length >= 8, '导航项数量', String(nav.tabs.length));
  check(nav.tabs.length === nav.panes.length, 'tab 数与 pane 数相等', nav.tabs.length + ' / ' + nav.panes.length);
  const diff = nav.tabs.filter(t => !nav.panes.includes(t)).concat(nav.panes.filter(p => !nav.tabs.includes(p)));
  check(diff.length === 0, 'tab 与 pane 完全对齐', diff.length ? '对不上：' + diff.join(',') : '零差异');

  console.log('\n=== 2. 每个 pane 的关键 id 齐全 ===');
  for (const [pane, ids] of Object.entries(MUST)) {
    const missing = await page.evaluate(list => list.filter(id => !document.getElementById(id)), ids);
    check(missing.length === 0, pane + ' 分组', missing.length ? '缺 ' + missing.join(',') : ids.length + ' 个 id 全在');
  }

  console.log('\n=== 3. 总览卡片 ===');
  await page.evaluate(() => openSettings());
  await sleep(350);
  const home = await page.evaluate(() => {
    const box = document.getElementById('setHomeGrid');
    if (!box) return null;
    const cards = Array.from(box.querySelectorAll('.set-card'));
    return {
      n: cards.length,
      goes: cards.map(c => c.dataset.setGo),
      states: cards.map(c => (c.className.match(/\b(ok|warn|bad|off)\b/) || [])[1]),
      texts: cards.map(c => (c.querySelector('.set-card-v') || {}).textContent || ''),
      visible: !document.getElementById('settingsBackdrop').classList.contains('hidden')
    };
  });
  check(!!home && home.visible, '设置面板打开了');
  check(home && home.n === 6, '总览 6 张状态卡', home ? String(home.n) : 'null');
  check(home && home.states.every(s => !!s), '每张卡都有状态类', home ? home.states.join(',') : '');
  check(home && home.texts.every(t => t && t.trim() && t !== '读取中…'), '每张卡都有说明文字');
  check(home && home.goes.every(g => nav.tabs.includes(g)), '卡片跳转目标都是合法 tab', home ? home.goes.join(',') : '');

  console.log('\n=== 4. 点卡片能跳到对应分组 ===');
  const jump = async (target) => {
    await page.evaluate(() => openSettings());
    await sleep(120);
    await page.evaluate(t => {
      const b = document.querySelector('.set-card[data-set-go="' + t + '"]');
      if (b) b.click();
    }, target);
    await sleep(140);
    return page.evaluate(t => {
      const pane = document.querySelector('.tabpane[data-pane="' + t + '"]');
      const tab = document.querySelector('.set-nav .tab[data-tab="' + t + '"]');
      const vis = pane && !pane.classList.contains('hidden') && pane.getBoundingClientRect().height > 40;
      return { vis: !!vis, active: !!(tab && tab.classList.contains('active')) };
    }, target);
  };
  for (const t of ['image', 'relay']) {
    const r = await jump(t);
    check(r.vis && r.active, '点「' + t + '」卡 → 分组切换到位', JSON.stringify(r));
  }

  console.log('\n=== 5. 左侧状态点 ===');
  const dots = await page.evaluate(() => {
    const ds = Array.from(document.querySelectorAll('.set-nav [data-dot]'));
    return { n: ds.length, bad: ds.filter(d => !/\bset-dot\b/.test(d.className) || !/\b(ok|warn|bad|off)\b/.test(d.className)).map(d => d.dataset.dot) };
  });
  check(dots.n >= 6, '导航状态点数量', String(dots.n));
  check(dots.bad.length === 0, '状态点类名合法', dots.bad.length ? '异常：' + dots.bad.join(',') : 'ok');

  console.log('\n=== 6. 被代码直接调用的入口 ===');
  for (const t of ['image', 'llm']) {
    const r = await page.evaluate(x => {
      openSettings(x);
      const pane = document.querySelector('.tabpane[data-pane="' + x + '"]');
      return pane && !pane.classList.contains('hidden');
    }, t);
    check(!!r, "openSettings('" + t + "') 落到正确分组");
  }

  console.log('\n=== 7. 关闭与清 Key 链路 ===');
  const closed = await page.evaluate(() => {
    document.getElementById('btnCloseSettings').click();
    return document.getElementById('settingsBackdrop').classList.contains('hidden');
  });
  check(closed === true, '关闭按钮把面板收起');
  /* 别去 patch window.clearKeys——事件监听器绑的是**函数引用**，改 window 拦不住。
   * 直接看行为：填进去的 Key 点一下就空。 */
  const reset = await page.evaluate(() => {
    const k = document.getElementById('llmKey');
    const b = document.getElementById('resetKey');
    if (!k || !b) return { ok: false, why: '元素缺失' };
    k.value = 'sk-test-not-real';
    openSettings('about');
    b.click();
    return { ok: k.value === '', why: 'llmKey=' + JSON.stringify(k.value) };
  });
  check(reset.ok === true, '「清空所有 Key」真的清空', reset.why);

  console.log('\n=== 8. Key / 地址不再在设置页出现 ===');
  /* 用户要求：Key 与接口地址只在「对话输入条 → 配置自定义模型」里改。
   * 字段本体还得留在 DOM 里（config.js 按 id 读写），所以断言的是**不可见**。 */
  const cfg = await page.evaluate(() => {
    const vis = id => {
      const e = document.getElementById(id);
      if (!e) return false;
      if (e.type === 'hidden' || e.classList.contains('hidden')) return false;
      const r = e.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    return {
      shown: ['llmKey', 'llmBaseUrl', 'imgKey', 'imgBaseUrl'].filter(vis),
      present: ['llmKey', 'llmBaseUrl', 'imgKey', 'imgBaseUrl', 'presetSelect', 'imgPresetSelect']
        .filter(id => !document.getElementById(id)),
      toggles: document.querySelectorAll('[data-target="llmKey"], [data-target="imgKey"]').length,
      kvRows: document.querySelectorAll('.set-kv').length,
      cfgBtn: !!document.getElementById('setLlmCfg') && !!document.getElementById('setImgCfg')
    };
  });
  check(cfg.shown.length === 0, '没有可见的 Key / Base URL 输入框', cfg.shown.join(',') || 'none');
  check(cfg.present.length === 0, '隐藏字段仍在 DOM 里（config.js 靠它读写）', cfg.present.join(',') || 'ok');
  check(cfg.toggles === 0, '没有残留的「显示密码」按钮', String(cfg.toggles));
  check(cfg.kvRows >= 2, '两行只读信息（当前接口 / 模型清单）', String(cfg.kvRows));

  console.log('\n=== 9. 「去配置」能拉起对话条的配置弹层 ===');
  const opened = await page.evaluate(async () => {
    openSettings('llm');
    document.getElementById('setLlmCfg').click();
    await new Promise(r => setTimeout(r, 260));
    const m = document.getElementById('daiCfgMask');
    const on = !!m && !m.classList.contains('hidden');
    const filled = on && !!document.getElementById('daiCfgBase');
    if (on && window.deskChat && window.deskChat.modelCfg) window.deskChat.modelCfg.close();
    return { on, filled };
  });
  check(opened.on, '「去配置」打开了模型配置弹层');
  check(opened.filled, '弹层里有接口地址 / Key / 模型三个字段');

  console.log('\n=== 10. 新壳 × 老全局样式的碰撞 ===');
  /* 这三条都是「截图才看得出来」的：新壳用老外壳的全局类名，样式互相打。
   * 逐条守住，别等下次重做又踩一遍。 */
  const clash = await page.evaluate(() => {
    openSettings('llm');
    /* ① .inline 里有 input/select + 按钮时，必须排在同一行。
     *    全局 input/select 是 width:100%，item 又是 flex-basis:auto → basis 取到那个 100%，
     *    按钮被挤到下一行（「读取模型」曾经单独占一行）。 */
    const rows = [];
    document.querySelectorAll('.settings2 .inline').forEach(box => {
      const field = box.querySelector(':scope > input, :scope > select');
      const btn = box.querySelector(':scope > .btn');
      if (!field || !btn) return;
      rows.push({
        gap: Math.abs(field.getBoundingClientRect().top - btn.getBoundingClientRect().top),
        id: (btn.id || btn.className)
      });
    });
    /* ② `.msel-value.empty` 不能被全局 `.empty`（虚线框 + padding + 居中 flex）命中 */
    const host = document.querySelector('.tabpane[data-pane="llm"]');
    const probe = document.createElement('div');
    probe.className = 'msel-value empty';
    host.appendChild(probe);
    const cs = getComputedStyle(probe);
    const emptyStyle = { border: cs.borderTopStyle, pad: cs.paddingTop, disp: cs.display };
    probe.remove();
    /* ③ 「测试分析接口」前那颗圆点：01-base 是暗色主题的 #3b4763，白底上看像墨点 */
    const dot = getComputedStyle(document.getElementById('testLLM'), '::before').backgroundColor;
    return { rows, emptyStyle, dot };
  });
  const wrapped = clash.rows.filter(r => r.gap > 8);
  check(clash.rows.length > 0, '找到可校验的 .inline 行', String(clash.rows.length));
  check(wrapped.length === 0, '.inline 里按钮与输入框同一行未被挤下去',
    wrapped.length ? wrapped.map(r => r.id + ' 差 ' + Math.round(r.gap) + 'px').join(', ') : '全部同排');
  check(clash.emptyStyle.border !== 'dashed' && clash.emptyStyle.pad !== '22px',
    '模型下拉的 .empty 没吃到全局虚线空态样式', JSON.stringify(clash.emptyStyle));
  check(clash.dot !== 'rgb(59, 71, 99)', '测试接口前的圆点已换浅色（不是暗色主题的 #3b4763）', clash.dot);

  console.log('\n=== 11. 页面零报错 ===');
  check(errors.length === 0, '无 pageerror', errors.length ? errors.slice(0, 3).join(' | ') : 'clean');

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
