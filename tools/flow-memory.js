/* 体检：经验记忆（P2）
 * 覆盖：写入与去重（同写法只加 hits）/ 过滤 / 从变体生成经验 / 提示词 hint 构造
 * （按节点类型过滤、最多 5 条、超长截断）/ 真正注入到生成与变异两处系统提示词。
 * 零真实 LLM、零桥、零积分。 */
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

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof flowMemoryAdd === 'function' && typeof flowMemoryHint === 'function', null, { timeout: 8000 });

  console.log('=== 1. 写入与去重 ===');
  const r1 = await page.evaluate(async () => {
    await flowMemoryClear();
    const a = await flowMemoryAdd([
      { nodeType: 'aiTask', key: 'instruction', from: '旧A', to: '写得具体一点', source: 'variant' },
      { nodeType: 'imageGen', key: 'prompt', from: '旧B', to: '更中性的修复提示词', source: 'variant' }
    ], { flowId: 'f1', flowName: '流程一' });
    const list1 = await flowMemoryList({});
    const dup = await flowMemoryAdd([
      { nodeType: 'aiTask', key: 'instruction', from: '旧A', to: '写得具体一点', source: 'variant' }
    ], { flowId: 'f1', flowName: '流程一' });
    const list2 = await flowMemoryList({});
    const ai = list2.find(m => m.nodeType === 'aiTask');
    const img = list2.find(m => m.nodeType === 'imageGen');
    return {
      added: a.added, bumped: a.bumped,
      len1: list1.length, len2: list2.length,
      dupAdded: dup.added, dupBumped: dup.bumped,
      hits: ai ? ai.hits : -1,
      flowName: ai ? ai.flowName : '',
      from: ai ? ai.from : '', to: ai ? ai.to : '',
      imgSrc: img ? img.source : ''
    };
  });
  check('两条都写入', r1.added === 2 && r1.len1 === 2, JSON.stringify(r1));
  check('字段完整（from/to/flowName/source）', r1.from === '旧A' && r1.to === '写得具体一点' && r1.flowName === '流程一' && r1.imgSrc === 'variant');
  check('同写法不重复堆，只加 hits', r1.dupAdded === 0 && r1.dupBumped === 1 && r1.len2 === 2, JSON.stringify(r1));
  check('hits 累加到 2', r1.hits === 2, String(r1.hits));

  console.log('\n=== 2. 过滤 ===');
  const r2 = await page.evaluate(async () => {
    const all = await flowMemoryList({});
    const ai = await flowMemoryList({ nodeType: 'aiTask' });
    const byKey = await flowMemoryList({ key: 'prompt' });
    const byFlow = await flowMemoryList({ flowId: 'f-nope' });
    return { all: all.length, ai: ai.length, byKey: byKey.length, byFlow: byFlow.length };
  });
  check('按节点类型过滤', r2.ai === 1 && r2.all === 2, r2.ai + '/' + r2.all);
  check('按参数键过滤', r2.byKey === 1, String(r2.byKey));
  check('按流程过滤（不存在的流程为 0）', r2.byFlow === 0);

  console.log('\n=== 3. 从变体生成经验 ===');
  const r3 = await page.evaluate(() => {
    const flow = {
      id: 'f1', name: '流程一',
      nodes: [
        { id: 'a', type: 'aiTask', data: { instruction: '原指令' } },
        { id: 'b', type: 'text', data: { text: '原文' } }
      ]
    };
    const variant = {
      id: 'v1', name: '更具体',
      patches: [
        { nodeId: 'a', key: 'instruction', value: '新指令' },
        { nodeId: 'zz', key: 'instruction', value: '不该出现' },
        { nodeId: 'b', key: 'text', value: '新文' }
      ]
    };
    const lessons = flowMemoryFromVariant(flow, variant);
    return { n: lessons.length, keys: lessons.map(l => l.nodeType + ':' + l.key).join(','), froms: lessons.map(l => l.from).join('|'), last: lessons[1] ? lessons[1].to : '', note: lessons[0] ? lessons[0].note : '' };
  });
  check('每个有效 patch 生成一条经验', r3.n === 2 && r3.keys === 'aiTask:instruction,text:text', r3.keys);
  check('带上原值', r3.froms === '原指令|原文', r3.froms);
  check('带上新值与来源说明', r3.last === '新文' && /更具体/.test(r3.note), r3.last + '/' + r3.note);

  console.log('\n=== 4. 提示词 hint 构造 ===');
  const r4 = await page.evaluate(async () => {
    await flowMemoryClear();
    const batch = [];
    for (let i = 0; i < 7; i++) {
      batch.push({ nodeType: 'aiTask', key: 'instruction', from: '旧' + i, to: '写法' + i });
    }
    batch.push({ nodeType: 'imageGen', key: 'prompt', from: '旧P', to: '很长的提示词' + 'X'.repeat(200) });
    await flowMemoryAdd(batch, { flowId: 'f1' });
    const allHint = await flowMemoryHint(null);
    const aiFlow = { nodes: [{ id: 'a', type: 'aiTask' }] };
    const aiHint = await flowMemoryHint(aiFlow);
    const imgFlow = { nodes: [{ id: 'b', type: 'imageGen' }] };
    const imgHint = await flowMemoryHint(imgFlow);
    const emptyFlow = { nodes: [{ id: 'c', type: 'tripoModel' }] };   // 没有任何文本参数节点
    const emptyHint = await flowMemoryHint(emptyFlow);
    return {
      allLines: allHint.split('\n').filter(Boolean).length,
      aiLines: aiHint.split('\n').filter(Boolean).length,
      aiHasNode: aiHint.indexOf('[分析任务·instruction]') >= 0,
      imgTruncated: imgHint.indexOf('…') >= 0,
      imgLen: imgHint.length,
      empty: emptyHint === ''
    };
  });
  check('最多注入 5 条', r4.allLines === 5 && r4.aiLines === 5, r4.allLines + '/' + r4.aiLines);
  check('按节点类型筛选（只给流程里有的类型）', r4.aiHasNode === true && r4.aiLines === 5);
  check('超长经验被截断', r4.imgTruncated === true, String(r4.imgLen));
  check('没有相关经验时返回空串', r4.empty === true);

  console.log('\n=== 5. 注入到生成提示词 ===');
  const r5 = await page.evaluate(async () => {
    await flowMemoryClear();
    await flowMemoryAdd([{ nodeType: 'aiTask', key: 'instruction', to: '经验标记ZQX 的写法' }], { flowId: 'f1' });
    const dag = {
      name: '注入测试',
      nodes: [
        { id: 'n1', type: 'start', params: [{ id: 'p1', name: '图', type: 'image', value: '' }] },
        { id: 'n2', type: 'aiTask', data: { instruction: '分析', inputs: [{ id: 'i1', name: '图', type: 'image' }], outputs: [{ id: 'o1', name: '结果', type: 'string' }] } },
        { id: 'n3', type: 'end', params: [{ id: 'p2', name: '文本', type: 'string', value: '' }] }
      ],
      links: [
        { id: 'l1', from: { node: 'n1', key: 'p1' }, to: { node: 'n2', key: 'i1' } },
        { id: 'l2', from: { node: 'n1', key: 'exec' }, to: { node: 'n2', key: 'exec' } },
        { id: 'l3', from: { node: 'n2', key: 'o1' }, to: { node: 'n3', key: 'p2' } },
        { id: 'l4', from: { node: 'n2', key: 'exec' }, to: { node: 'n3', key: 'exec' } }
      ]
    };
    const sysList = [];
    const ask = (sys) => { sysList.push(sys); return Promise.resolve(JSON.stringify(dag)); };
    const res1 = await generateFlowDag('分析图片并输出文本', { ask, retries: 0 });
    await flowMemoryClear();
    const res2 = await generateFlowDag('分析图片并输出文本', { ask, retries: 0 });
    return {
      ok: res1.ok,
      withMem: sysList[0].indexOf('历史经验') >= 0 && sysList[0].indexOf('经验标记ZQX') >= 0,
      withoutMem: sysList[1].indexOf('历史经验') < 0
    };
  });
  check('生成仍然成功', r5.ok === true);
  check('有经验时注入到系统提示词', r5.withMem === true);
  check('经验清空后不再注入', r5.withoutMem === true);

  console.log('\n=== 6. 注入到变异提示词 ===');
  const r6 = await page.evaluate(async () => {
    await flowMemoryClear();
    await flowMemoryAdd([{ nodeType: 'aiTask', key: 'instruction', to: '变异经验标记QWE' }], { flowId: 'f1' });
    const flow = { name: 'x', nodes: [{ id: 'a', type: 'aiTask', data: { instruction: '原指令' } }] };
    const sysList = [];
    const ask = (sys) => {
      sysList.push(sys);
      return Promise.resolve(JSON.stringify({ variants: [{ name: 'v', patches: [{ nodeId: 'a', key: 'instruction', value: '新指令' }] }] }));
    };
    await mutateFlowVariants(flow, { ask, count: 2 });
    await flowMemoryClear();
    await mutateFlowVariants(flow, { ask, count: 2 });
    return {
      withMem: sysList[0].indexOf('历史经验') >= 0 && sysList[0].indexOf('变异经验标记QWE') >= 0,
      withoutMem: sysList[1].indexOf('历史经验') < 0
    };
  });
  check('变异时注入相关经验', r6.withMem === true);
  check('经验清空后不再注入', r6.withoutMem === true);

  console.log('\n=== 7. 删除与清空 ===');
  const r7 = await page.evaluate(async () => {
    await flowMemoryClear();
    await flowMemoryAdd([
      { nodeType: 'aiTask', key: 'instruction', to: 'A' },
      { nodeType: 'text', key: 'text', to: 'B' }
    ], {});
    const list = await flowMemoryList({});
    const del = await flowMemoryDelete(list[0].id);
    const afterDel = (await flowMemoryList({})).length;
    const cleared = await flowMemoryClear();
    const afterClear = (await flowMemoryList({})).length;
    const stats = await flowMemoryStats();
    return { del, afterDel, cleared, afterClear, total: stats.total };
  });
  check('删除单条', r7.del === true && r7.afterDel === 1, String(r7.afterDel));
  check('清空全部', r7.cleared === true && r7.afterClear === 0 && r7.total === 0);

  console.log('\n=== 8. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
