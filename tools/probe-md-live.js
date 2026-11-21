'use strict';
/* 探针：建模 App 的「组件运行时」与「控制器」—— 眨眼 / 大纲区分 / 编辑事务
 * 用法：node tools/probe-md-live.js      （PROBE_SHOTS=0 关截图）
 *
 * 验五件事：
 *   ① 大纲把组件节点和普通网格分开（图标 + 第三列），且组件源消失时不画空白；
 *   ② 属性面板里的控制器能就地改表情（改的是同一个对象，不弹窗、不新增）；
 *   ③ 自动眨眼在 3D 里真的动（eye_close 的 influence 被推到 > 0.5）；
 *   ④ 眨眼**不污染存盘数据**：mesh.morphs 里 eye_close 的 weight 仍是 0，
 *     node.comp.params 里没有相位（这条是「运行时不写文档」的唯一证据）；
 *   ⑤ 拖一次滑杆只产生一条历史（撤销一次回到拖动前，而不是回到某个中间值）。
 *
 * 为什么单开一个探针：probe-modeldesk-component 验的是「头模这份资产对不对」，
 * 这里验的是「架构边界对不对」——两者失败时的排查方向完全不同。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-live');
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

  /* 加一个头模：后面所有断言都围绕它 */
  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1000);
  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });
  check(!!headId, '头模已加进场景', headId);

  /* ---------- ① 大纲区分 ---------- */
  const rows0 = await page.evaluate(() => Array.from(
    document.querySelectorAll('#mdOutlineList .md-part-row[data-md-node]')
  ).map((r) => ({
    id: r.dataset.mdNode,
    comp: r.dataset.mdCompRow || '',
    icon: (r.querySelector('i') || {}).className || '',
    shape: (r.querySelector('.md-part-shape') || {}).textContent || ''
  })));
  const headRow = rows0.find((r) => r.id === headId);
  const plainRow = rows0.find((r) => r.id !== headId);
  check(!!headRow && headRow.icon.indexOf('md-cicon') >= 0, '组件行用的是组件图标（不是普通网格的方块）',
    headRow && headRow.icon);
  check(!!headRow && headRow.shape.trim() === '组件', '组件行第三列写「组件」', headRow && headRow.shape.trim());
  check(!!headRow && headRow.comp === 'lumen-head', '行上带着组件 id（供测试 / 脚本定位）', headRow && headRow.comp);
  check(!!plainRow && plainRow.icon.indexOf('md-nicon') >= 0 && plainRow.shape.trim() === '网格',
    '普通网格行不受影响（还是方块 + 网格）', plainRow && (plainRow.icon + ' / ' + plainRow.shape.trim()));

  /* 组件源消失（模拟删掉桥文件 / 改名）时不能画成空白：
   * 空白和「本来就没有组件」长得一样，用户只会以为对象坏了。 */
  const dangling = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id);
    const keep = node.comp.id;
    node.comp.id = 'not-loaded-part';
    window.modelDesk.selectNodeById(id);
    const row = document.querySelector('#mdOutlineList .md-part-row[data-md-node="' + id + '"]');
    const miss = document.querySelector('#mdParams .md-ctl-miss');
    const out = {
      icon: row ? row.querySelector('i').className : '',
      shape: row ? row.querySelector('.md-part-shape').textContent.trim() : '',
      title: row ? (row.getAttribute('title') || '') : '',
      miss: miss ? miss.textContent : ''
    };
    node.comp.id = keep;
    window.modelDesk.selectNodeById(id);
    return out;
  }, headId);
  check(dangling.shape.trim() === '组件' && dangling.icon.indexOf('md-cicon') >= 0,
    '组件源缺失时行还在、仍标成组件（不空白）', dangling.shape.trim());
  check(/not-loaded-part/.test(dangling.title), '悬空的 id 写在 title 里（能查出是哪个零件没了）', dangling.title);
  check(/未加载/.test(dangling.miss), '属性面板说明「组件源未加载」而不是画空控制器', dangling.miss.slice(0, 30));

  /* ---------- ② 控制器就地改表情 ---------- */
  const ctlClick = await page.evaluate((id) => {
    const box = document.querySelector('.md-ctl');
    if (!box) return { err: 'no controller' };
    const b = Array.from(box.querySelectorAll('.md-md-expr')).find((x) => /生气/.test(x.textContent));
    if (!b) return { err: 'no angry btn' };
    b.click();
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id);
    const mesh = window.SeedModel.Scene.getMesh(doc, node);
    return {
      expr: node.comp.params.expr,
      weighted: (mesh.morphs || []).filter((m) => m.weight > 0).length,
      nodes: doc.nodes.length,
      meshRef: node.meshRef,
      overlay: !!document.querySelector('.md-overlay.on'),
      chips: box.querySelectorAll('.md-md-key').length
    };
  }, headId);
  check(ctlClick.expr === 'angry' && ctlClick.weighted >= 3,
    '控制器里点表情，参数直接落到对象上（不弹窗、不点确定）',
    ctlClick.expr + ' · ' + ctlClick.weighted + ' 键');
  check(!ctlClick.overlay, '控制器是就地编辑，没有打开对话框');
  check(ctlClick.chips >= 3, '点完立刻重铺控制器（chips 跟着变）', ctlClick.chips + ' 个');
  check(ctlClick.nodes === 2 && ctlClick.meshRef === 'mesh-2',
    '还是同一个对象、同一份网格（没有偷偷新增 / 重建）',
    ctlClick.nodes + ' 节点 · ' + ctlClick.meshRef);

  /* ---------- ③ 眨眼真的在动 ---------- */
  const blinkOn = await page.evaluate(() => {
    const box = document.querySelector('.md-ctl');
    const cb = box && box.querySelector('[data-md-cev="blink"]');
    return { has: !!cb, checked: cb ? cb.checked : null };
  });
  check(blinkOn.has && blinkOn.checked === true, '控制器里有自动眨眼开关，默认开着',
    'checked=' + blinkOn.checked);

  await page.evaluate(() => {
    window.__blink = { max: 0, hit: 0, samples: 0 };
    window.__blinkRun = true;
    const step = () => {
      const m = window.modelDesk.morphs();
      if (m) {
        const it = m.items.filter((x) => x.name === 'eye_close')[0];
        if (it) {
          window.__blink.samples++;
          if (it.influence > window.__blink.max) window.__blink.max = it.influence;
          if (it.influence > 0.02) window.__blink.hit++;
        }
      }
      if (window.__blinkRun) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await page.waitForTimeout(7000);
  const blink = await page.evaluate(() => { window.__blinkRun = false; return window.__blink; });
  check(blink.max > 0.5, '3D 里眼睛真的闭上了（eye_close 的 influence 被推到 > 0.5）',
    'max=' + (blink.max || 0).toFixed(3) + ' · ' + blink.hit + '/' + blink.samples + ' 帧非零');

  /* ---------- ④ 眨眼不污染存盘数据 ---------- */
  const clean = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id);
    const mesh = window.SeedModel.Scene.getMesh(doc, node);
    const eye = (mesh.morphs || []).filter((m) => m.name === 'eye_close')[0];
    const json = JSON.stringify(node.comp.params || {});
    const raw = JSON.parse(JSON.stringify(window.SeedModel.Scene.toSeedModel(doc)));
    const v = window.SeedModel.Scene.validate(raw);
    const back = v.doc && v.doc.nodes.filter((n) => n.id === id)[0];
    return {
      weight: eye ? eye.weight : -1,
      hasPhase: /phase|blinkValue|next/i.test(json),
      json: json,
      backBlinks: back && back.comp && back.comp.params ? back.comp.params.blink : null
    };
  }, headId);
  check(clean.weight === 0, '存盘权重没被眨眼改过（eye_close.weight 仍是 0）',
    'weight=' + clean.weight);
  check(clean.hasPhase === false, '参数里没有运行时相位（存盘不会停在半闭眼）', clean.json);
  check(clean.backBlinks === true, '开关本身是持久参数（过序列化往返还在）', 'blink=' + clean.backBlinks);

  /* 关掉自动眨眼：必须立刻睁回去，不能停在一个半闭的相位上 */
  await page.evaluate(() => {
    const box = document.querySelector('.md-ctl');
    const cb = box.querySelector('[data-md-cev="blink"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  const off = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id);
    const m = window.modelDesk.morphs();
    const it = m && m.items.filter((x) => x.name === 'eye_close')[0];
    return { influence: it ? it.influence : -1, blink: node.comp.params.blink };
  }, headId);
  check(off.blink === false && off.influence <= 0.02, '关掉后立刻睁眼（不停在半闭）',
    'blink=' + off.blink + ' · influence=' + off.influence);

  /* ---------- ⑤ 拖一次滑杆 = 一条历史 ---------- */
  const txn = await page.evaluate((id) => {
    const doc = window.modelDesk.getDocument();
    const node = window.SeedModel.Scene.nodeById(doc, id);
    const mesh = window.SeedModel.Scene.getMesh(doc, node);
    const baseline = JSON.stringify((mesh.morphs || []).map((m) => +m.weight.toFixed(3)));
    const box = document.querySelector('.md-ctl');
    const range = box.querySelector('input[type="range"][data-md-cev="w"]');
    if (!range) return { err: 'no slider' };
    /* 模拟一次拖拽：连续 input + 最后一次 change */
    const vals = [20, 35, 50, 65, 80];
    vals.forEach((v) => {
      range.value = String(v);
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    range.dispatchEvent(new Event('change', { bubbles: true }));
    const afterDrag = JSON.stringify((mesh.morphs || []).map((m) => +m.weight.toFixed(3)));
    window.modelDesk.undo();
    const d2 = window.modelDesk.getDocument();
    const n2 = window.SeedModel.Scene.nodeById(d2, id);
    const m2 = window.SeedModel.Scene.getMesh(d2, n2);
    const afterUndo = JSON.stringify((m2.morphs || []).map((m) => +m.weight.toFixed(3)));
    return { baseline: baseline, afterDrag: afterDrag, afterUndo: afterUndo };
  }, headId);
  check(txn.afterDrag !== txn.baseline, '拖拽确实改了权重（不是空操作）',
    (txn.afterDrag || '').slice(0, 60));
  check(txn.afterUndo === txn.baseline,
    '撤销一次就回到拖动前（一次拖拽 = 一条历史，不是每帧一条）',
    (txn.afterUndo || '').slice(0, 60));

  /* ---------- ⑥ 多对象：切节点不串参数、各自眨眼 ---------- */
  const second = await page.evaluate(() => {
    const ok = window.modelDesk.addComponent();
    const doc = window.modelDesk.getDocument();
    return { ok: !!ok, id: doc.nodes[doc.nodes.length - 1].id, nodes: doc.nodes.length };
  });
  check(!!second.ok && second.nodes === 3, '再加一个头模', second.nodes + ' 个对象 · ' + second.id);

  /* 切节点时控制器必须换一份参数。st.comp 是单例工作区，
   * 不重置的话第二个头会显示第一个的表情 —— 而且改下去会把第一个改坏。 */
  const switched = await page.evaluate((ids) => {
    const chips = (id) => {
      window.modelDesk.selectNodeById(id);
      const box = document.querySelector('.md-ctl');
      return box ? box.querySelectorAll('.md-md-key').length : -1;
    };
    const a = chips(ids[0]);
    const b = chips(ids[1]);
    const a2 = chips(ids[0]);
    return { a: a, b: b, a2: a2 };
  }, [headId, second.id]);
  check(switched.a >= 3, '切回头模 A：控制器显示它自己的叠加键', switched.a + ' 个');
  check(switched.b === 0, '切到新建的头模 B：控制器是空的（没有串到 A 的参数）', switched.b + ' 个');
  check(switched.a2 === switched.a, '切回 A 参数还在（没被 B 覆盖）', switched.a + ' → ' + switched.a2);

  /* 两个头模各自眨眼：状态按 nodeId 存，不是单例 */
  await page.evaluate((ids) => {
    /* A 的自动眨眼在上一段被关掉了，这里打开（走控制器，等于用户操作） */
    window.modelDesk.selectNodeById(ids[0]);
    const box = document.querySelector('.md-ctl');
    const cb = box && box.querySelector('[data-md-cev="blink"]');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, [headId, second.id]);
  await page.waitForTimeout(300);

  await page.evaluate((ids) => {
    window.__both = { a: 0, b: 0, runs: true };
    const step = () => {
      [['a', ids[0]], ['b', ids[1]]].forEach(([k, id]) => {
        const m = window.modelDesk.morphs(id);
        if (!m) return;
        const it = m.items.filter((x) => x.name === 'eye_close')[0];
        if (it && it.influence > window.__both[k]) window.__both[k] = it.influence;
      });
      if (window.__both.runs) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [headId, second.id]);
  await page.waitForTimeout(9000);
  const both = await page.evaluate(() => { window.__both.runs = false; return window.__both; });
  check(both.a > 0.5 && both.b > 0.5,
    '两个头模各自眨眼（运行时状态按节点存，不是全局单例）',
    'A max=' + both.a.toFixed(3) + ' · B max=' + both.b.toFixed(3));

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  /* finish(errors, extra) 的第一个参数是**错误数组**（探针异常 / 页面错误），
   * 断言失败数走 extra.fails —— 传错类型会让 result.json 写不出来。 */
  RUN.finish(errors, { fails: fails });
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 条失败 · ' + RUN.dir : '✅ 全部通过 · ' + RUN.dir);
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e && e.message);
  process.exit(1);
});
