/* 比例选择逻辑体检（纯 mock 页面，不碰真实 Tripo）
 * 场景：
 *  1) 页面按钮文本是标准「1:1」→ 应选中，且点到比例胶囊而不是外层容器
 *  2) 文本带前后缀 / 空格 / 全角冒号（「方形 1:1」「1 ： 1」）→ 仍应选中
 *  3) 比例收在下拉里（触发器写着「比例」，点开后才出现选项）→ 应先点开再选中
 *  4) 页面根本没有该比例 → 返回 false，且不得把弹层留在页面上
 *  5) 传 'auto' → 直接返回 false（跟随页面设置，不发任何点击）
 * 用法：node plugins/tripo/tests/ratio-select.js
 */
const { chromium } = require('playwright-core');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* mock 页面：
 *  - chips=true：一排比例胶囊（外层容器文本包含所有比例，用来验证「不点容器」）
 *  - menu=true ：比例藏在下拉里，点「比例」触发器才渲染选项
 *  - ratios   ：可用比例文案
 * 点击任意比例 → 记录到 window.__picked，并标记 window.__pickedIsChip（是否点到了带 data-chip 的元素）
 */
function mockHtml({ ratios, menu, wrap }) {
  const chip = (t, i) => `<button data-chip="1" data-r="${i}" class="ratio-btn">${wrap ? wrap.replace('{t}', t) : t}</button>`;
  const list = ratios.map((t, i) => chip(t, i)).join('');
  return `<!doctype html><meta charset="utf-8"><body>
    <div id="root">
      ${menu
        ? `<button id="ratio-trigger" class="select-trigger">比例</button><div id="menu" style="display:none">${list}</div>`
        : `<div class="ratio-row" id="row">${list}</div>`}
    </div>
    <script>
      window.__picked = '';
      window.__pickedIsChip = false;
      const bind = () => {
        document.querySelectorAll('[data-chip]').forEach(b => {
          if (b.__bound) return;
          b.__bound = true;
          b.addEventListener('click', () => {
            window.__picked = (b.textContent || '').trim();
            window.__pickedIsChip = b.hasAttribute('data-chip');
            document.querySelectorAll('[data-chip]').forEach(x => x.removeAttribute('data-on'));
            b.setAttribute('data-on', '1');
          });
        });
      };
      const trigger = document.getElementById('ratio-trigger');
      if (trigger) trigger.addEventListener('click', () => {
        const m = document.getElementById('menu');
        m.style.display = m.style.display === 'none' ? 'block' : 'none';
        bind();
      });
      bind();
      window.__ready = true;
    </script></body>`;
}

(async () => {
  const bridge = require(path.join(__dirname, '..', 'tripo-web.js'));
  const browser = await chromium.launch({ channel: 'msedge' });
  const open = async (cfg) => {
    const page = await browser.newPage();
    await page.setContent(mockHtml(cfg));
    await page.waitForFunction(() => window.__ready === true, { timeout: 8000 }).catch(() => {});
    return page;
  };
  const picked = (page) => page.evaluate(() => window.__picked);
  const pickedIsChip = (page) => page.evaluate(() => window.__pickedIsChip);

  console.log('=== 1. 标准文案 + 外层容器也含比例文本 ===');
  {
    const p = await open({ ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'] });
    const ok = await bridge.selectRatio(p, '1:1');
    check(ok === true, 'selectRatio 返回 true');
    check(await picked(p) === '1:1', '选中了 1:1', 'picked=' + await picked(p));
    check(await pickedIsChip(p) === true, '点的是比例胶囊（不是包住整排的容器）');
    const ok2 = await bridge.selectRatio(p, '16:9');
    check(ok2 === true && await picked(p) === '16:9', '可以改选 16:9', 'picked=' + await picked(p));
    await p.close();
  }

  console.log('=== 2. 文案不规范（前后缀 / 空格 / 全角冒号）===');
  {
    const p = await open({ ratios: ['1:1', '16:9'], wrap: '方形 {t}' });
    const ok = await bridge.selectRatio(p, '1:1');
    check(ok === true && await picked(p) === '方形 1:1', '「方形 1:1」也能命中', 'picked=' + await picked(p));
    await p.close();

    const p2 = await open({ ratios: ['1：1', '16:9'], wrap: '{t}' });
    const ok2 = await bridge.selectRatio(p2, '1:1');
    check(ok2 === true, '全角冒号「1：1」也能命中', 'picked=' + await picked(p2));
    await p2.close();

    const p3 = await open({ ratios: ['1 : 1', '16:9'], wrap: '{t}' });
    const ok3 = await bridge.selectRatio(p3, '1:1');
    check(ok3 === true, '带空格的「1 : 1」也能命中', 'picked=' + await picked(p3));
    await p3.close();
  }

  console.log('=== 3. 比例收在下拉里 ===');
  {
    const p = await open({ ratios: ['1:1', '16:9', '9:16'], menu: true });
    const before = await p.evaluate(() => document.getElementById('menu').style.display);
    check(before === 'none', '开始时下拉是收起的', before);
    const ok = await bridge.selectRatio(p, '9:16');
    check(ok === true, '点开下拉后选中 9:16', 'picked=' + await picked(p));
    check(await picked(p) === '9:16', '选中的确实是 9:16');
    await p.close();
  }

  console.log('=== 4. 页面上没有这个比例 ===');
  {
    const p = await open({ ratios: ['1:1', '16:9'], menu: true });
    const ok = await bridge.selectRatio(p, '21:9');
    check(ok === false, '返回 false（调用方保持页面默认）');
    const display = await p.evaluate(() => document.getElementById('menu').style.display);
    check(display === 'none', '失败的弹层已收起，不会挡住提示词输入框', display);
    check(await picked(p) === '', '没有误点任何比例', 'picked=' + await picked(p));
    await p.close();
  }

  console.log('=== 5. auto / 空值 ===');
  {
    const p = await open({ ratios: ['1:1'] });
    check(await bridge.selectRatio(p, 'auto') === false, "auto 直接返回 false（跟随页面设置）");
    check(await bridge.selectRatio(p, '') === false, '空值直接返回 false');
    check(await picked(p) === '', 'auto/空值不产生任何点击');
    await p.close();
  }

  console.log('=== 6. 归一化函数 ===');
  {
    check(bridge.normRatio('1:1') === '1:1', 'normRatio(1:1)');
    check(bridge.normRatio('1：1') === '1:1', 'normRatio(全角冒号)');
    check(bridge.normRatio('方形 16:9') === '16:9', 'normRatio(带前缀)');
    check(bridge.normRatio('auto') === '', 'normRatio(auto) 为空');
    check(JSON.stringify(bridge.ratioTokens('1:1 / 16:9')) === JSON.stringify(['1:1', '16:9']), 'ratioTokens 抽多个');
  }

  await browser.close();
  console.log(fails ? `\n✗ ${fails} 项失败` : '\n✅ 全部通过');
  if (fails) process.exit(1);
})();
