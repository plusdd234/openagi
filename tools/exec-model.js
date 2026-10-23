/* 执行模型验证
 * 1) 输入类节点（图像/模型/文本/数值/布尔/获取变量）不应有执行引脚
 * 2) 执行流只从「任务开始」出发；不在执行链上的节点不激活
 * 3) 无「任务开始」节点时，不执行任何步骤
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储
const IMG = path.join(__dirname, '..', 'samples', 'ui_linked.png');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  /* ---------- 1. 执行引脚盘点 ---------- */
  const pins = await page.evaluate(() => {
    const flow = { id: 'pin_' + Date.now(), name: '执行引脚盘点', nodes: [], links: [], vars: [], updated: Date.now() };
    Object.keys(NODE_DEFS).forEach((t, i) => flow.nodes.push(newNode(t, (i % 5) * 240, Math.floor(i / 5) * 260)));
    FLOWS.unshift(flow);
    openFlow(flow.id);
    return Array.from(document.querySelectorAll('.node')).map(el => {
      const n = bp.nodes.find(x => x.id === el.dataset.id);
      const d = NODE_DEFS[n.type];
      return {
        type: n.type,
        title: d.title,
        pure: !!d.pure,
        execIn: el.querySelectorAll('.pin.exec.in').length,
        execOut: el.querySelectorAll('.pin.exec.out').length,
        declaredIn: !!d.execIn,
        declaredOut: (d.execOut || []).length
      };
    });
  });

  console.log('=== 1. 节点执行引脚 ===');
  const bad = [];
  pins.forEach(p => {
    const mark = p.declaredIn || p.declaredOut ? '执行' : '参数';
    console.log(` ${p.title.padEnd(16)} ${mark}  声明 in=${p.declaredIn} out=${p.declaredOut} · DOM in=${p.execIn} out=${p.execOut}`);
    if ((p.declaredIn ? 1 : 0) !== p.execIn && p.declaredIn !== (p.execIn > 0)) bad.push(p.type + ' 输入');
    if (p.declaredOut && p.execOut !== p.declaredOut) bad.push(p.type + ' 输出');
  });
  const pureWithExec = pins.filter(p => p.pure && (p.execIn || p.execOut));
  console.log(' 参数节点却带执行引脚: ' + (pureWithExec.length ? pureWithExec.map(p => p.type).join(',') : '无 ✅'));

  /* ---------- 2. 只从「任务开始」出发 ---------- */
  const imgData = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');
  const runA = await page.evaluate(async (imgData) => {
    const s = newNode('start', 0, 0);
    const ii = newNode('imageIn', 0, 220); ii.data.image = imgData;
    const nv = newNode('numNode', 0, 380); nv.data.value = 256;
    const ic = newNode('imageCompress', 300, 120);
    const idleNode = newNode('result', 640, 320);          // execIn，但故意不接执行线
    const flow = {
      id: 'runA_' + Date.now(), name: '执行链', nodes: [s, ii, nv, ic, idleNode], vars: [], updated: Date.now(),
      links: [
        { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: ic.id, key: 'exec' } },
        { id: uid(), from: { node: ii.id, key: 'image' }, to: { node: ic.id, key: 'image' } },
        { id: uid(), from: { node: nv.id, key: 'int' }, to: { node: ic.id, key: 'maxEdge' } }
      ]
    };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    await runFlow();
    const icN = bp.nodes.find(n => n.type === 'imageCompress');
    return {
      statuses: bp.nodes.map(n => ({ type: n.type, status: n.status, out: Object.keys(n.out || {}).length })),
      compressKeys: Object.keys(icN.out || {}),
      compressText: (icN.out && (icN.out.text || icN.out.info || icN.out.note)) || '',
      logs: Array.from(document.querySelectorAll('#bpLog .log-line, #bpLog > div')).map(e => e.textContent).slice(-6)
    };
  }, imgData);

  console.log('\n=== 2. 执行链（start → 压缩图像），另有一个未接线的 result ===');
  runA.statuses.forEach(s => console.log(` ${s.type.padEnd(14)} status=${s.status || '(未激活)'} 输出键=${s.out}`));
  console.log(' 日志尾部: ' + JSON.stringify(runA.logs));
  const icOk = runA.statuses.find(s => s.type === 'imageCompress').status === 'ok';
  const idleOk = runA.statuses.find(s => s.type === 'result').status === '';
  const numPulled = runA.statuses.find(s => s.type === 'numNode').status === 'ok';
  const compLog = runA.logs.join(' ');
  const edgeUsed = /→\s*\d+×256\b/.test(compLog);
  console.log(' 压缩节点输出键: ' + runA.compressKeys.join(',') + ' · 日志: ' + (compLog.match(/已压缩[^·]*·[^·]*/) || [''])[0]);
  console.log(' 链上节点已执行: ' + (icOk ? '✅' : '❌') + ' · 未接线节点未激活: ' + (idleOk ? '✅' : '❌'));
  console.log(' 参数节点被按需读取: ' + (numPulled ? '✅' : '❌') + ' · 连线数值生效(maxEdge=256): ' + (edgeUsed ? '✅' : '❌'));

  /* ---------- 3. 没有「任务开始」节点 ---------- */
  const runB = await page.evaluate(async (imgData) => {
    const ii = newNode('imageIn', 0, 0); ii.data.image = imgData;
    const ic = newNode('imageCompress', 300, 0);
    const flow = {
      id: 'runB_' + Date.now(), name: '无开始节点', nodes: [ii, ic], vars: [], updated: Date.now(),
      links: [{ id: uid(), from: { node: ii.id, key: 'image' }, to: { node: ic.id, key: 'image' } }]
    };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    await runFlow();
    return {
      statuses: bp.nodes.map(n => ({ type: n.type, status: n.status })),
      logs: Array.from(document.querySelectorAll('#bpLog > div')).map(e => e.textContent).slice(-4)
    };
  }, imgData);

  console.log('\n=== 3. 没有「任务开始」节点 ===');
  runB.statuses.forEach(s => console.log(` ${s.type.padEnd(14)} status=${s.status || '(未激活)'}`));
  console.log(' 日志: ' + JSON.stringify(runB.logs));
  const noneRan = runB.statuses.every(s => s.status === '');
  console.log(' 未执行任何步骤: ' + (noneRan ? '✅' : '❌'));

  /* ---------- 4. 旧流程迁移：清掉从输入节点拉出的失效执行线 ---------- */
  const mig = await page.evaluate(() => {
    const s = newNode('start', 0, 0);
    const ii = newNode('imageIn', 0, 200);
    const ig = newNode('imageGen', 300, 0);
    const flow = {
      id: 'mig_' + Date.now(), name: '旧执行线', nodes: [s, ii, ig], vars: [], updated: Date.now(),
      links: [
        { id: uid(), from: { node: ii.id, key: 'exec' }, to: { node: ig.id, key: 'exec' } },  // 旧式：输入节点拉执行线
        { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: ig.id, key: 'exec' } }   // 正常：任务开始 → 生图
      ]
    };
    const dropped = migrateExecLinks(flow);
    return { dropped, left: flow.links.map(l => l.from.node.slice(0, 3) + '.' + l.from.key) };
  });
  console.log('\n=== 4. 旧流程迁移 ===');
  console.log(' 清理失效执行线: ' + mig.dropped + ' 条 · 保留: ' + mig.left.join(', '));
  const migOk = mig.dropped === 1 && mig.left.length === 1 && mig.left[0].endsWith('.exec');
  console.log(' 只清掉输入节点的执行线、保留任务开始的: ' + (migOk ? '✅' : '❌'));

  /* ---------- 5. 任务开始 / 任务结束不可删除 ---------- */
  const lock = await page.evaluate(() => {
    const flow = {
      id: 'lock_' + Date.now(), name: '骨架锁定',
      nodes: [newNode('start', 0, 0), newNode('end', 320, 0), newNode('text', 0, 220)],
      links: [], vars: [], updated: Date.now()
    };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const dels = Array.from(document.querySelectorAll('.node')).map(el => {
      const n = bp.nodes.find(x => x.id === el.dataset.id);
      return { type: n.type, hasDel: !!el.querySelector('.node-del') };
    });
    const libTypes = Array.from(document.querySelectorAll('#bpLibBody .lib-item')).map(e => e.dataset.type);
    const menuTypes = Array.from(document.querySelectorAll('#bpAdd option')).map(o => o.value).filter(Boolean);
    const before = bp.nodes.length;
    addNodeAt('start', 900, 0);
    addNodeAt('end', 900, 200);
    const afterAdd = bp.nodes.length;
    removeNode(bp.nodes.find(n => n.type === 'start'));
    removeNode(bp.nodes.find(n => n.type === 'end'));
    const afterDel = bp.nodes.length;
    return { dels, libTypes, menuTypes, before, afterAdd, afterDel, toast: document.getElementById('bpToast').textContent };
  });
  console.log('\n=== 5. 任务开始 / 任务结束不可删除 ===');
  lock.dels.forEach(d => console.log(` ${d.type.padEnd(6)} 删除按钮: ${d.hasDel ? '有' : '无'}`));
  console.log(' 节点库是否仍列出骨架节点: ' + (lock.libTypes.filter(t => t === 'start' || t === 'end').join(',') || '否 ✅'));
  console.log(' 下拉菜单是否仍列出骨架节点: ' + (lock.menuTypes.filter(t => t === 'start' || t === 'end').join(',') || '否 ✅'));
  console.log(` 重复添加 start/end: ${lock.before} → ${lock.afterAdd}（应不变）· 强行删除: → ${lock.afterDel}（应不变）`);
  console.log(' 提示: ' + lock.toast);
  const noDelBtn = lock.dels.filter(d => (d.type === 'start' || d.type === 'end') && !d.hasDel).length === 2;
  const textHasDel = lock.dels.find(d => d.type === 'text').hasDel;
  const lockOk = noDelBtn && textHasDel && lock.afterAdd === lock.before && lock.afterDel === lock.before
    && !lock.libTypes.includes('start') && !lock.libTypes.includes('end');

  // 普通节点仍可正常删除（真实点击）
  const beforeClick = await page.evaluate(() => bp.nodes.length);
  const tid = await page.evaluate(() => bp.nodes.find(n => n.type === 'text').id);
  await page.click(`#n-${tid} .node-del`);
  await page.waitForTimeout(150);
  const afterClick = await page.evaluate(() => bp.nodes.length);
  console.log(` 普通节点点击删除: ${beforeClick} → ${afterClick}`);
  const delWorks = afterClick === beforeClick - 1;

  // 历史流程里重复的骨架节点应可清理，但必须保留一个
  const dup = await page.evaluate(() => {
    const flow = {
      id: 'dup_' + Date.now(), name: '重复骨架',
      nodes: [newNode('start', 0, 0), newNode('start', 0, 260), newNode('end', 320, 0)],
      links: [], vars: [], updated: Date.now()
    };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const dels = Array.from(document.querySelectorAll('.node')).map(el => {
      const n = bp.nodes.find(x => x.id === el.dataset.id);
      return { type: n.type, hasDel: !!el.querySelector('.node-del') };
    });
    const second = bp.nodes.filter(n => n.type === 'start')[1];
    removeNode(second);
    const afterDup = bp.nodes.filter(n => n.type === 'start').length;
    const last = bp.nodes.find(n => n.type === 'start');
    removeNode(last);
    const afterLast = bp.nodes.filter(n => n.type === 'start').length;
    return { dels, afterDup, afterLast };
  });
  console.log(` 重复的骨架节点: 两个 start 的删除按钮 = ${dup.dels.filter(d => d.type === 'start').map(d => d.hasDel).join('/')}`);
  console.log(` 删掉多余的一个: 剩余 ${dup.afterDup} 个 · 再删最后一个: 剩余 ${dup.afterLast} 个（应仍为 1）`);
  const dupOk = dup.afterDup === 1 && dup.afterLast === 1;

  console.log('\n=== 错误 (' + errors.length + ') ===');
  errors.slice(0, 8).forEach(e => console.log(' - ' + e));
  await page.screenshot({ path: path.join(__dirname, '..', 'samples', 'exec_model.png') });
  await browser.close();
  const ok = !pureWithExec.length && icOk && idleOk && noneRan && numPulled && edgeUsed && migOk && lockOk && delWorks && dupOk && !errors.length;
  console.log('\n总体: ' + (ok ? '符合新执行模型 ✅' : '存在偏差 ❌'));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAILED:', e); process.exit(2); });
