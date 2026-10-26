/* 体检：节点契约（P0 第一层）
 * 覆盖：契约完整性 / 默认值唯一来源 / 动态引脚解析 / JSON 提取 / 自动布局 / 生成提示词
 * 零桥、零真实 LLM、零积分。 */
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
  await page.waitForFunction(() => typeof nodeContract === 'function' && typeof seedNodeData === 'function', null, { timeout: 8000 });

  console.log('=== 1. 契约完整性 ===');
  const r1 = await page.evaluate(() => {
    const c = nodeContract();
    const types = Object.keys(c.types);
    const missing = Object.keys(NODE_DEFS).filter(t => !c.types[t]);
    const noTitle = types.filter(t => !c.types[t].title);
    const noDesc = types.filter(t => !c.types[t].desc);
    const badPins = [];
    Object.keys(NODE_DEFS).forEach(t => {
      const n = { id: 'x', type: t, data: {}, params: [] };
      ((NODE_DEFS[t] || {}).inputs || []).forEach(k => {
        if (pinTypeOf(n, k) === null) badPins.push(t + '.' + k + '(in)');
      });
      ((NODE_DEFS[t] || {}).outputs || []).forEach(k => {
        if (pinTypeOf(n, k) === null) badPins.push(t + '.' + k + '(out)');
      });
    });
    return { total: types.length, missing, noTitle, noDesc, badPins };
  });
  check('契约覆盖全部节点类型', r1.missing.length === 0, r1.missing.join(','));
  check('节点类型数量 >= 20', r1.total >= 20, 'total=' + r1.total);
  check('每个类型都有标题与说明', r1.noTitle.length === 0 && r1.noDesc.length === 0, r1.noTitle.concat(r1.noDesc).join(','));
  check('全部静态引脚都能解析出类型', r1.badPins.length === 0, r1.badPins.join(','));

  console.log('\n=== 2. 默认值唯一来源 ===');
  const r2 = await page.evaluate(() => {
    const ai = seedNodeData('aiTask');
    const tri = seedNodeData('tripoImg');
    const st = seedNodeData('start');
    const mv = seedNodeData('modelViews');
    const sp = seedNodeData('imageSplit');
    const ab = seedNodeData('smartBranch');
    const tm = seedNodeData('tripoModelMulti');
    const b = seedNodeData('boolNode');
    return {
      aiTimeout: ai.data.timeout, aiIn: (ai.data.inputs || []).length, aiOut: (ai.data.outputs || []).length,
      triTimeout: tri.data.timeout, triMode: tri.data.mode, triRatio: tri.data.ratio,
      startParams: Array.isArray(st.params) && st.params.length,
      mvParams: (mv.data.params || []).length,
      splitViews: (sp.data.views || []).length,
      branchCount: (ab.data.branches || []).length,
      multiTimeout: tm.data.timeout,
      boolDefault: b.data.bool
    };
  });
  check('aiTask 默认超时 300 秒', r2.aiTimeout === 300, String(r2.aiTimeout));
  check('aiTask 默认 1 进 1 出引脚', r2.aiIn === 1 && r2.aiOut === 1, r2.aiIn + '/' + r2.aiOut);
  check('tripoImg 默认超时 240 / auto 模式 / auto 比例', r2.triTimeout === 240 && r2.triMode === 'auto' && r2.triRatio === 'auto');
  check('start 带空参数表', r2.startParams === 0);
  check('modelViews 默认 8 个参数引脚', r2.mvParams === 8, String(r2.mvParams));
  check('imageSplit 默认 2 个视图', r2.splitViews === 2, String(r2.splitViews));
  check('智能分支默认 2 个出口', r2.branchCount === 2, String(r2.branchCount));
  check('tripoModelMulti 默认超时 600 秒', r2.multiTimeout === 600, String(r2.multiTimeout));
  check('boolNode 默认真', r2.boolDefault === true);

  const r3 = await page.evaluate(() => {
    const diffs = [];
    Object.keys(NODE_DEFS).forEach(t => {
      const n = newNode(t, 10, 20);
      const s = seedNodeData(t);
      const ks = Object.keys(s.data).sort().join(',');
      const kn = Object.keys(n.data).sort().join(',');
      if (ks !== kn) diffs.push(t + '(data:' + kn + ')');
      const hasParams = Array.isArray(n.params);
      if ((s.params !== null) !== hasParams) diffs.push(t + ':params');
    });
    return diffs;
  });
  check('newNode 与 seedNodeData 完全同形（默认值不会漂移）', r3.length === 0, r3.join(' | '));

  console.log('\n=== 3. 动态引脚解析 ===');
  const r4 = await page.evaluate(() => {
    const ai = newNode('aiTask', 0, 0);
    const inId = ai.data.inputs[0].id, outId = ai.data.outputs[0].id;
    const sp = newNode('imageSplit', 0, 0);
    const vid = sp.data.views[0].id;
    const br = newNode('smartBranch', 0, 0);
    const bid = br.data.branches[0].id;
    const vars = [{ id: 'v1', name: '素材', type: 'image' }];
    const vg = { id: 'vg', type: 'varGet', data: { varId: 'v1' } };
    const vs = { id: 'vs', type: 'varSet', data: { varId: 'v1' } };
    const st = { id: 's', type: 'start', params: [{ id: 'p1', name: '图像', type: 'image', value: '' }] };
    const en = { id: 'e', type: 'end', params: [{ id: 'p2', name: '结果', type: 'image', value: '' }] };
    const mv = newNode('modelViews', 0, 0);
    const w = mv.data.params.find(p => p.name === '线宽');
    return {
      aiIn: pinTypeOf(ai, inId) + '/' + pinDirOf(ai, inId),
      aiOut: pinTypeOf(ai, outId) + '/' + pinDirOf(ai, outId),
      viewImg: pinTypeOf(sp, vid) + '/' + pinDirOf(sp, vid),
      viewHas: pinTypeOf(sp, vid + '__has') + '/' + pinDirOf(sp, vid + '__has'),
      branch: pinTypeOf(br, bid) + '/' + pinDirOf(br, bid),
      varGet: pinTypeOf(vg, 'v1', vars) + '/' + pinDirOf(vg, 'v1', vars),
      varSet: pinDirOf(vs, 'v1', vars),
      startOut: pinDirOf(st, 'p1') + '/' + pinTypeOf(st, 'p1'),
      endIn: pinDirOf(en, 'p2') + '/' + pinTypeOf(en, 'p2'),
      floatParam: pinTypeOf(mv, w.id) + '/' + pinDirOf(mv, w.id),
      unknown: pinTypeOf(ai, 'nope_xxx')
    };
  });
  check('aiTask 自定义输入引脚 = string/in', r4.aiIn === 'string/in', r4.aiIn);
  check('aiTask 自定义输出引脚 = string/out', r4.aiOut === 'string/out', r4.aiOut);
  check('imageSplit 视图引脚 = image/out', r4.viewImg === 'image/out', r4.viewImg);
  check('imageSplit「是否有」引脚 = bool/out', r4.viewHas === 'bool/out', r4.viewHas);
  check('智能分支出口引脚 = exec/out', r4.branch === 'exec/out', r4.branch);
  check('varGet 变量引脚 = image/out', r4.varGet === 'image/out', r4.varGet);
  check('varSet 变量引脚方向 = in', r4.varSet === 'in', String(r4.varSet));
  check('start 参数 = out/image', r4.startOut === 'out/image', r4.startOut);
  check('end 参数 = in/image', r4.endIn === 'in/image', r4.endIn);
  check('modelViews 参数引脚 = float/in', r4.floatParam === 'float/in', r4.floatParam);
  check('不存在的引脚返回 null（校验器靠它抓悬空连线）', r4.unknown === null, String(r4.unknown));

  console.log('\n=== 4. JSON 提取 ===');
  const r5 = await page.evaluate(() => {
    const plain = extractJson('{"a":1}');
    const fenced = extractJson('说明\n```json\n{"b":2}\n```\n结尾');
    const prose = extractJson('好的，结果如下：{"c":3} 希望有帮助');
    const nested = extractJson('```\n{"d":{"e":[1,2]}}\n```');
    return {
      plain: plain && plain.a,
      fenced: fenced && fenced.b,
      prose: prose && prose.c,
      nested: nested && nested.d && nested.d.e.length,
      bad: extractJson('这不是 JSON'),
      empty: extractJson('')
    };
  });
  check('纯 JSON', r5.plain === 1);
  check('```json 围栏', r5.fenced === 2);
  check('夹在说明文字里的 JSON', r5.prose === 3);
  check('嵌套对象', r5.nested === 2);
  check('非 JSON 返回 null', r5.bad === null && r5.empty === null);

  console.log('\n=== 5. 自动布局 ===');
  const r6 = await page.evaluate(() => {
    const nodes = [
      { id: 'a', type: 'start', data: {}, params: [] },
      { id: 'b', type: 'aiTask', data: {}, params: null },
      { id: 'c', type: 'end', data: {}, params: [] }
    ];
    const links = [
      { from: { node: 'a', key: 'exec' }, to: { node: 'b', key: 'exec' } },
      { from: { node: 'b', key: 'exec' }, to: { node: 'c', key: 'exec' } }
    ];
    autoLayout(nodes, links);
    return nodes.map(n => ({ x: n.x, y: n.y }));
  });
  check('链式流程按层递增 x', r6[0].x < r6[1].x && r6[1].x < r6[2].x, JSON.stringify(r6.map(n => n.x)));
  check('同层节点 y 不重叠', r6[0].y !== r6[1].y || r6[0].x !== r6[1].x);

  console.log('\n=== 6. 生成提示词 ===');
  const r7 = await page.evaluate(() => {
    const s = buildGenSystemPrompt();
    const missing = Object.keys(NODE_DEFS).filter(t => s.indexOf('### ' + t + ' ·') < 0);
    return {
      len: s.length,
      missing,
      hasRules: s.indexOf('硬性规则') >= 0,
      hasAsk: s.indexOf('questions') >= 0,
      hasDag: s.indexOf('links') >= 0 && s.indexOf('nodes') >= 0
    };
  });
  check('提示词覆盖全部节点目录', r7.missing.length === 0, r7.missing.join(','));
  check('提示词含硬性规则', r7.hasRules);
  check('提示词允许模型反问', r7.hasAsk);
  check('提示词含 DAG 字段说明', r7.hasDag);
  check('提示词长度在合理范围（3K–30K 字符）', r7.len > 3000 && r7.len < 30000, 'len=' + r7.len);

  console.log('\n=== 7. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
