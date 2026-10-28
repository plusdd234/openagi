/* 旧「AI 分支」→「智能分支」迁移体检（不调真实 LLM、不触桥、不耗积分）
 * 旧 aiBranch 类型已删除，老流程必须打开即用：
 * 1) 类型已从 NODE_DEFS 消失，节点库里也没有
 * 2) 老流程（无 data.inputs）打开后：type 变 smartBranch、固定引脚 text/image 转成动态输入、
 *    入边按新 id 重映射、校验不再报 E-PIN
 * 3) 迁移是幂等的（跑两次不会翻倍）
 * 4) 迁移后的节点照常执行：围栏 JSON 能选中出口、乱答走兜底出口
 * 用法：node tools/branch-migrate.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 造一份「老版本」流程：aiBranch 没有 data.inputs，入边用的是固定 key text / image */
const LEGACY = {
  id: 'legacy_branch_flow',
  name: '老流程（含 AI 分支）',
  vars: [], frames: [], updated: Date.now(), lastRun: null,
  nodes: [
    { id: 'L_s', type: 'start', x: 0, y: 0, data: {}, params: [] },
    { id: 'L_t', type: 'text', x: 0, y: 120, data: { text: '轻微破损的老照片' } },
    { id: 'L_i', type: 'imageIn', x: 0, y: 200, data: { image: 'data:image/png;base64,AAAA' } },
    {
      id: 'L_b', type: 'aiBranch', x: 300, y: 60,
      data: {
        instruction: '按图像复杂度选择修复方式',
        timeout: 120,
        branches: [
          { id: 'Lb1', name: '轻量修复', hint: '整体清晰', fallback: false },
          { id: 'Lb2', name: '精细重绘', hint: '破损较多', fallback: true }
        ]
      }
    },
    { id: 'L_ra', type: 'result', x: 600, y: 0, data: {} },
    { id: 'L_ta', type: 'text', x: 600, y: 120, data: { text: '走了轻量修复' } },
    { id: 'L_rb', type: 'result', x: 600, y: 240, data: {} },
    { id: 'L_tb', type: 'text', x: 600, y: 340, data: { text: '走了精细重绘' } }
  ],
  links: [
    { id: 'L1', from: { node: 'L_s', key: 'exec' }, to: { node: 'L_b', key: 'exec' } },
    { id: 'L2', from: { node: 'L_t', key: 'text' }, to: { node: 'L_b', key: 'text' } },
    { id: 'L3', from: { node: 'L_i', key: 'image' }, to: { node: 'L_b', key: 'image' } },
    { id: 'L4', from: { node: 'L_b', key: 'Lb1' }, to: { node: 'L_ra', key: 'exec' } },
    { id: 'L5', from: { node: 'L_ta', key: 'text' }, to: { node: 'L_ra', key: 'text' } },
    { id: 'L6', from: { node: 'L_b', key: 'Lb2' }, to: { node: 'L_rb', key: 'exec' } },
    { id: 'L7', from: { node: 'L_tb', key: 'text' }, to: { node: 'L_rb', key: 'text' } }
  ]
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    window.__bridgeCalls = [];
    const orig = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push(String(url));
        return Promise.resolve(new Response('{"message":"测试环境已禁用真实桥调用"}', { status: 503 }));
      }
      return orig.apply(this, arguments);
    };
    $('llmKey').value = 'test-key';
    $('llmBaseUrl').value = 'https://stub.test/v1';
    $('llmModel').value = 'stub-router';
    if ($('relayOn')) $('relayOn').checked = false;
  });

  console.log('\n=== 1. 旧类型已彻底删除 ===');
  const r1 = await page.evaluate(() => {
    const lib = NODE_LIB.reduce((a, g) => a.concat(g.types), []);
    const seed = seedNodeData('aiBranch');
    return {
      defined: !!NODE_DEFS.aiBranch,
      params: !!NODE_PARAMS.aiBranch,
      seedEmpty: Object.keys(seed.data).length === 0 && seed.params === null,
      inLib: lib.indexOf('aiBranch') >= 0,
      smart: lib.indexOf('smartBranch') >= 0
    };
  });
  check(r1.defined === false, 'NODE_DEFS 里没有 aiBranch', String(r1.defined));
  check(r1.params === false, 'NODE_PARAMS 里没有 aiBranch');
  check(r1.inLib === false && r1.smart === true, '节点库只有智能分支');
  check(r1.seedEmpty === true, 'seedNodeData 不再为 aiBranch 生成任何默认值');

  console.log('\n=== 2. 老流程打开即迁移 ===');
  const r2 = await page.evaluate(legacy => {
    FLOWS.unshift(JSON.parse(JSON.stringify(legacy)));
    openFlow('legacy_branch_flow'); flushViewSwap();
    const n = bp.nodes.find(x => x.id === 'L_b');
    const linksTo = bp.links.filter(l => l.to.node === 'L_b');
    const dataTo = linksTo.filter(l => l.to.key !== 'exec');
    const v = validateFlow(snapshotBp());
    const el = document.getElementById('n-' + n.id);
    const inputIds = (n.data.inputs || []).map(p => p.id);
    return {
      type: n.type,
      inputCount: (n.data.inputs || []).length,
      inputTypes: (n.data.inputs || []).map(p => p.type).join(','),
      inputIds,
      branchCount: (n.data.branches || []).length,
      instruction: n.data.instruction,
      oldKeys: dataTo.filter(l => l.to.key === 'text' || l.to.key === 'image').length,
      remapped: dataTo.map(l => l.to.key),
      pinTypes: dataTo.map(l => pinType(n, l.to.key)),
      errors: v.errors.map(e => e.code),
      warnDyn: v.warnings.filter(w => w.code === 'W-DYNAMIC').length,
      renderedPins: Array.from(el.querySelectorAll('.pin.in')).filter(p => inputIds.indexOf(p.dataset.key) >= 0).length,
      execIn: !!el.querySelector('.pin.exec.in')
    };
  }, LEGACY);
  check(r2.type === 'smartBranch', '节点类型转成 smartBranch', r2.type);
  check(r2.inputCount === 2 && r2.inputTypes === 'string,image', '固定引脚转成两个动态输入（文本/图像）', r2.inputTypes);
  check(r2.oldKeys === 0, '入边不再指向旧的固定 key', r2.remapped.join(','));
  check(r2.pinTypes.join(',') === 'string,image', '重映射后引脚类型正确', r2.pinTypes.join(','));
  check(r2.errors.length === 0, '迁移后校验无错误（不再报 E-PIN）', r2.errors.join(','));
  check(r2.renderedPins === 2, '两个输入都渲染成可拖线的引脚', String(r2.renderedPins));
  check(r2.execIn === true && r2.branchCount === 2, '执行入口与出口保持不变', r2.branchCount + ' 出口');
  check(r2.instruction === '按图像复杂度选择修复方式', '选择依据保留', r2.instruction);

  console.log('\n=== 3. 迁移幂等 ===');
  const r3 = await page.evaluate(() => {
    const flow = FLOWS.find(f => f.id === 'legacy_branch_flow');
    const first = migrateLegacyBranches(flow);     // 若已落盘则为 0，否则 1
    const mid = flow.nodes.find(n => n.id === 'L_b').data.inputs.map(p => p.type).join(',');
    const second = migrateLegacyBranches(flow);    // 第二次必须是空操作
    const after = flow.nodes.find(n => n.id === 'L_b').data.inputs.map(p => p.type).join(',');
    return { first, second, mid, after, count: flow.nodes.find(n => n.id === 'L_b').data.inputs.length };
  });
  check(r3.second === 0 && r3.mid === r3.after, '重复迁移是空操作（引脚不翻倍）', 'first=' + r3.first + ' second=' + r3.second);
  check(r3.count === 2 && r3.after === 'string,image', '迁移后引脚仍然是 2 个（文本/图像）', r3.after);

  console.log('\n=== 4. 迁移后照常执行（围栏 JSON → 选中出口） ===');
  const r4 = await page.evaluate(async () => {
    const n = bp.nodes.find(x => x.id === 'L_b');
    const ra = bp.nodes.find(x => x.id === 'L_ra');
    const rb = bp.nodes.find(x => x.id === 'L_rb');
    window.__calls = [];
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__calls.push({ body: (init && init.body) || '' });
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '我的判断：\n```json\n{"choice":"轻量修复","reason":"整体清晰"}\n```\n完毕' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    const body = window.__calls.length ? JSON.parse(window.__calls[0].body) : {};
    const content = (body.messages && body.messages[1] && body.messages[1].content) || [];
    const text = Array.isArray(content) ? content.map(c => c.text || '').join('\n') : '';
    return {
      status: n.status, err: n.error || '',
      choice: n.out.choice, text: n.out.text || '',
      ra: ra.status, rb: rb.status,
      reqText: text,
      images: Array.isArray(content) ? content.filter(c => c.type === 'image_url').length : 0,
      bridge: window.__bridgeCalls.length
    };
  });
  check(r4.status === 'ok', '迁移后的节点能正常执行', r4.status + ' ' + r4.err);
  check(r4.choice === 'Lb1', '围栏 JSON 被正确解析并选中出口', r4.choice);
  check(r4.ra === 'ok' && r4.rb === '', '只激活被选中出口的下游', 'A=' + r4.ra + ' B=' + r4.rb);
  check(/输入数据/.test(r4.reqText) && /轻微破损的老照片/.test(r4.reqText), '老的文本入边仍进了提示词', r4.reqText.slice(0, 60));
  check(r4.images === 1, '老的图像入边仍以 image_url 附带', 'images=' + r4.images);
  check(r4.bridge === 0, '全程零桥请求');

  console.log('\n=== 5. 模型乱答 → 走兜底出口 ===');
  const r5 = await page.evaluate(async () => {
    const n = bp.nodes.find(x => x.id === 'L_b');
    const ra = bp.nodes.find(x => x.id === 'L_ra');
    const rb = bp.nodes.find(x => x.id === 'L_rb');
    const guard = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '我觉得都行' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    return { status: n.status, choice: n.out.choice, text: n.out.text || '', ra: ra.status, rb: rb.status };
  });
  check(r5.status === 'ok' && r5.choice === 'Lb2', '未匹配时走标了兜底的出口', r5.choice + ' / ' + r5.text.slice(0, 40));
  check(r5.rb === 'ok' && r5.ra === '', '兜底出口的下游被激活', 'A=' + r5.ra + ' B=' + r5.rb);

  console.log('\n=== 6. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
