/* 体检：版本快照与回滚（P2 安全门）
 * 覆盖：保存 / 元信息列表（不带整份流程）/ 快照独立性 / 每个流程 10 份上限 /
 * 不可序列化时拒绝 / 合并规则（沿用当前 id）/ 真实「改坏 → 恢复 → 恢复前也留快照」。
 * 零 LLM、零桥、零积分。 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  page.on('dialog', d => d.accept());

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof flowVersionSave === 'function', null, { timeout: 8000 });

  console.log('=== 1. 保存与元信息 ===');
  const r1 = await page.evaluate(async () => {
    const flow = {
      id: 'vf1', name: '版本测试', updated: Date.now(), lastRun: null, vars: [],
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, data: { text: '原始内容' } },
        { id: 'b', type: 'end', x: 200, y: 0, data: {}, params: [] }
      ],
      links: [{ id: 'l1', from: { node: 'a', key: 'text' }, to: { node: 'b', key: 'p1' } }],
      frames: []
    };
    const saved = await flowVersionSave(flow, { reason: '第一次' });
    const list = await flowVersionList('vf1');
    const row = list[0] || {};
    // 改动原对象后，快照不应受影响
    flow.nodes[0].data.text = '被改过了';
    const full = await flowVersionGet(saved.id);
    const restoredText = full && full.flow && full.flow.nodes[0].data.text;
    // 循环引用应被拒绝
    const cyc = { id: 'vf2', nodes: [] };
    cyc.self = cyc;
    const bad = await flowVersionSave(cyc, {});
    return {
      ok: saved.ok, hasId: /^s/.test(saved.id || ''), size: saved.size,
      listLen: list.length,
      metaHasFlow: Object.prototype.hasOwnProperty.call(row, 'flow'),
      metaNodes: row.nodes, metaLinks: row.links, reason: row.reason,
      restoredText,
      badOk: bad.ok, badErr: bad.error || ''
    };
  });
  check('保存成功且返回 id', r1.ok === true && r1.hasId === true);
  check('记录了大小', r1.size > 0, String(r1.size));
  check('列表返回 1 条', r1.listLen === 1, String(r1.listLen));
  check('列表只给元信息（不搬整份流程）', r1.metaHasFlow === false);
  check('元信息含节点/连线数与备注', r1.metaNodes === 2 && r1.metaLinks === 1 && r1.reason === '第一次',
    r1.metaNodes + '/' + r1.metaLinks + '/' + r1.reason);
  check('快照与原对象解耦（深拷贝）', r1.restoredText === '原始内容', r1.restoredText);
  check('不可序列化时拒绝并说明', r1.badOk === false && /序列化/.test(r1.badErr), r1.badErr);

  console.log('\n=== 2. 每流程 10 份上限 ===');
  const r2 = await page.evaluate(async () => {
    for (let i = 0; i < 13; i++) {
      await flowVersionSave({
        id: 'vf1', name: '版本测试', nodes: [{ id: 'n' + i, type: 'text', data: { text: 'v' + i } }], links: [], vars: []
      }, { reason: '第 ' + (i + 2) + ' 次' });
    }
    const list = await flowVersionList('vf1');
    return { len: list.length, newest: list[0].reason, oldest: list[list.length - 1].reason };
  });
  check('只保留最近 10 份', r2.len === 10, String(r2.len));
  check('留下的是最新的', r2.newest === '第 14 次', r2.newest);

  console.log('\n=== 3. 合并规则 ===');
  const r3 = await page.evaluate(() => {
    const cur = { id: 'same-id', name: '当前名' };
    const snap = { id: 'old-id', name: '', nodes: [{ id: 'x' }], links: [], vars: [], frames: [] };
    const merged = flowVersionMerge(cur, snap);
    return { id: merged.id, name: merged.name, nodes: merged.nodes.length, hasUpdated: typeof merged.updated === 'number' };
  });
  check('沿用当前流程 id', r3.id === 'same-id', r3.id);
  check('快照没名字时沿用当前名', r3.name === '当前名', r3.name);
  check('内容整体来自快照', r3.nodes === 1);
  check('刷新 updated', r3.hasUpdated === true);

  console.log('\n=== 4. 真实「改坏 → 恢复」 ===');
  const r4 = await page.evaluate(async () => {
    createFlow();
    await new Promise(r => setTimeout(r, 400));
    const node = bp.nodes.find(n => n.type === 'aiTask');
    node.data.instruction = '原始指令';
    renderNodes();
    scheduleFlowSave();
    const saved = await flowVersionSave(snapshotBp(), { reason: '改坏之前' });
    node.data.instruction = '改坏了的指令';
    renderNodes();
    scheduleFlowSave();
    memRestoreVersion(saved.id);
    await new Promise(r => setTimeout(r, 700));
    const after = (bp.nodes.find(n => n.type === 'aiTask') || { data: {} }).data.instruction;
    const list = await flowVersionList(bp.id);
    return {
      savedOk: saved.ok, after,
      reasons: list.map(v => v.reason),
      count: list.length
    };
  });
  check('恢复后指令回到快照里的值', r4.after === '原始指令', r4.after);
  check('恢复前自动存了一份（可再滚回来）', r4.count >= 2 && r4.reasons.some(x => /恢复前/.test(x)), r4.reasons.join(','));
  check('快照与恢复都在同一流程下', r4.savedOk === true);

  console.log('\n=== 5. 删除 ===');
  const r5 = await page.evaluate(async () => {
    const list = await flowVersionList(bp.id);
    const before = list.length;
    const ok = await flowVersionDelete(list[0].id);
    const after = (await flowVersionList(bp.id)).length;
    const gone = await flowVersionGet(list[0].id);
    return { ok, before, after, gone };
  });
  check('删除成功', r5.ok === true && r5.after === r5.before - 1, r5.before + '→' + r5.after);
  check('删除后读不到', r5.gone === null);

  console.log('\n=== 6. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
