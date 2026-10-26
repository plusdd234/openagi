/* 体检：工作流静态校验（P0 第二层）
 * 覆盖：结构 / 引脚存在 / 方向 / 类型（含 int→float 加宽）/ 环路 / 单例 / 执行线 / 必填项
 * 每个用例独立造流程，断言只看错误码，避免文案变动误伤。 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};
const has = (arr, code) => (arr || []).indexOf(code) >= 0;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof validateFlow === 'function', null, { timeout: 8000 });

  const R = await page.evaluate(() => {
    const codes = res => ({
      ok: res.ok,
      errors: res.errors.map(e => e.code),
      warnings: res.warnings.map(w => w.code),
      msgs: res.errors.map(e => e.message)
    });

    // 基线：start → aiTask → imageGen → end（连线全部正确）
    const mk = () => {
      const s = newNode('start', 0, 0);
      const p1 = { id: 'sp1', name: '图像', type: 'image', value: '' };
      s.params = [p1];
      const ai = newNode('aiTask', 0, 0);
      ai.data.instruction = '分析图像';
      const aiIn = { id: 'ai_in1', name: '图像', type: 'image' };
      const aiOut = { id: 'ai_out1', name: '描述', type: 'string' };
      ai.data.inputs = [aiIn];
      ai.data.outputs = [aiOut];
      const gen = newNode('imageGen', 0, 0);
      gen.data.prompt = '修复画面';
      const en = newNode('end', 0, 0);
      const p2 = { id: 'ep1', name: '结果图', type: 'image', value: '' };
      en.params = [p2];
      const links = [
        { id: 'l1', from: { node: s.id, key: p1.id }, to: { node: ai.id, key: aiIn.id } },
        { id: 'l2', from: { node: s.id, key: 'exec' }, to: { node: ai.id, key: 'exec' } },
        { id: 'l3', from: { node: ai.id, key: aiOut.id }, to: { node: gen.id, key: 'prompt' } },
        { id: 'l4', from: { node: ai.id, key: 'exec' }, to: { node: gen.id, key: 'exec' } },
        { id: 'l5', from: { node: gen.id, key: 'image' }, to: { node: en.id, key: p2.id } },
        { id: 'l6', from: { node: gen.id, key: 'exec' }, to: { node: en.id, key: 'exec' } }
      ];
      return {
        flow: { nodes: [s, ai, gen, en], links, vars: [] },
        s, ai, gen, en, p1, p2, aiIn, aiOut, links
      };
    };

    const out = {};

    // 1. 合法流程
    out.base = codes(validateFlow(mk().flow));

    // 2. 缺少 start
    {
      const c = mk();
      c.flow.nodes = c.flow.nodes.filter(n => n.type !== 'start');
      c.flow.links = c.flow.links.filter(l => l.from.node !== c.s.id);
      out.noStart = codes(validateFlow(c.flow));
    }

    // 3. 连线指向不存在的引脚
    {
      const c = mk();
      c.flow.links.push({ id: 'lx', from: { node: c.ai.id, key: c.aiOut.id }, to: { node: c.gen.id, key: 'bogus_pin' } });
      out.badPin = codes(validateFlow(c.flow));
    }

    // 4. 方向反了（end 的输入参数当作起点）
    {
      const c = mk();
      c.flow.links = c.flow.links.filter(l => l.id !== 'l1');
      c.flow.links.push({ id: 'lx', from: { node: c.en.id, key: c.p2.id }, to: { node: c.s.id, key: c.p1.id } });
      out.badDir = codes(validateFlow(c.flow));
    }

    // 5. 类型不匹配（image → string）
    {
      const c = mk();
      const badGen = newNode('imageGen', 0, 0);
      badGen.data.prompt = '另一个生成';
      c.flow.nodes.push(badGen);
      c.flow.links.push({ id: 'l7', from: { node: c.ai.id, key: 'exec' }, to: { node: badGen.id, key: 'exec' } });
      c.flow.links.push({ id: 'lx', from: { node: c.gen.id, key: 'image' }, to: { node: badGen.id, key: 'prompt' } });
      out.typeMismatch = codes(validateFlow(c.flow));
    }

    // 6. int → float 允许（数值加宽）
    {
      const num = newNode('numNode', 0, 0);
      num.data.value = 1.4;
      const mv = newNode('modelViews', 0, 0);
      const w = mv.data.params.find(p => p.name === '线宽');
      out.intToFloat = codes(validateFlow({
        nodes: [num, mv], vars: [],
        links: [{ id: 'a', from: { node: num.id, key: 'int' }, to: { node: mv.id, key: w.id } }]
      }));
    }

    // 7. 数据连接成环
    {
      const a = newNode('aiTask', 0, 0);
      a.data.inputs = [{ id: 'a_in', name: '入', type: 'string' }];
      a.data.outputs = [{ id: 'a_out', name: '出', type: 'string' }];
      const b = newNode('aiTask', 0, 0);
      b.data.inputs = [{ id: 'b_in', name: '入', type: 'string' }];
      b.data.outputs = [{ id: 'b_out', name: '出', type: 'string' }];
      out.cycle = codes(validateFlow({
        nodes: [a, b], vars: [],
        links: [
          { id: 'c1', from: { node: a.id, key: 'a_out' }, to: { node: b.id, key: 'b_in' } },
          { id: 'c2', from: { node: b.id, key: 'b_out' }, to: { node: a.id, key: 'a_in' } }
        ]
      }));
    }

    // 8. 节点 id 重复
    {
      const n1 = newNode('text', 0, 0);
      const n2 = newNode('text', 0, 0);
      n2.id = n1.id;
      out.dupId = codes(validateFlow({ nodes: [n1, n2], links: [], vars: [] }));
    }

    // 9. 未知节点类型
    out.unknownType = codes(validateFlow({ nodes: [{ id: 'x1', type: 'nope', data: {} }], links: [], vars: [] }));

    // 10. 变量引用
    {
      const vg = newNode('varGet', 0, 0);
      vg.data.varId = 'v_missing';
      const vg2 = newNode('varGet', 0, 0);       // 没选变量
      const vs = newNode('varSet', 0, 0);
      vs.data.varId = 'v_ok';
      out.varMissing = codes(validateFlow({
        nodes: [vg, vg2, vs], links: [],
        vars: [{ id: 'v_ok', name: '素材', type: 'image', value: '' }]
      }));
    }

    // 11. 执行线未接入（去掉 start→aiTask 的执行线）
    {
      const c = mk();
      c.flow.links = c.flow.links.filter(l => l.id !== 'l2');
      out.execIdle = codes(validateFlow(c.flow));
    }

    // 12. 没有产出收集节点
    {
      const c = mk();
      c.flow.nodes = c.flow.nodes.filter(n => n.type !== 'end');
      c.flow.links = c.flow.links.filter(l => l.to.node !== c.en.id);
      out.noOutput = codes(validateFlow(c.flow));
    }

    // 13. aiTask 指令为空
    {
      const c = mk();
      c.ai.data.instruction = '';
      out.emptyInstruction = codes(validateFlow(c.flow));
    }

    // 14. 多个 start
    {
      const c = mk();
      c.flow.nodes.push(newNode('start', 0, 200));
      out.multiStart = codes(validateFlow(c.flow));
    }

    // 15. imageSplit 无视图
    {
      const sp = newNode('imageSplit', 0, 0);
      sp.data.views = [];
      sp.data.prompt = '拆分';
      out.noViews = codes(validateFlow({ nodes: [sp], links: [], vars: [] }));
    }

    // 16. tripoModel 缺参考图
    out.noRef = codes(validateFlow({ nodes: [newNode('tripoModel', 0, 0)], links: [], vars: [] }));

    // 17. tripoModelMulti 四视图一个都没接
    out.noMultiRef = codes(validateFlow({ nodes: [newNode('tripoModelMulti', 0, 0)], links: [], vars: [] }));

    // 18. 摘要文案
    out.sumOk = validateSummary(validateFlow(mk().flow));
    {
      const c = mk();
      c.flow.nodes = c.flow.nodes.filter(n => n.type !== 'start');
      out.sumBad = validateSummary(validateFlow(c.flow));
    }

    return out;
  });

  console.log('=== 1. 合法流程 ===');
  check('基线流程校验通过', R.base.ok === true, JSON.stringify(R.base.errors));
  check('基线流程没有错误', R.base.errors.length === 0, R.base.errors.join(','));
  check('基线流程没有告警', R.base.warnings.length === 0, R.base.warnings.join(','));

  console.log('\n=== 2. 结构性错误 ===');
  check('缺少任务开始 → E-START', has(R.noStart.errors, 'E-START'), R.noStart.errors.join(','));
  check('未知节点类型 → E-TYPE-UNKNOWN', has(R.unknownType.errors, 'E-TYPE-UNKNOWN'), R.unknownType.errors.join(','));
  check('节点 id 重复 → E-DUP-ID', has(R.dupId.errors, 'E-DUP-ID'), R.dupId.errors.join(','));

  console.log('\n=== 3. 连线检查 ===');
  check('引脚不存在 → E-PIN', has(R.badPin.errors, 'E-PIN'), R.badPin.errors.join(','));
  check('方向反了 → E-PIN-DIR', has(R.badDir.errors, 'E-PIN-DIR'), R.badDir.errors.join(','));
  check('类型不匹配 → E-TYPE', has(R.typeMismatch.errors, 'E-TYPE'), R.typeMismatch.errors.join(','));
  check('int → float 放行（不报 E-TYPE）', !has(R.intToFloat.errors, 'E-TYPE'), R.intToFloat.errors.join(','));
  check('数据成环 → E-CYCLE', has(R.cycle.errors, 'E-CYCLE'), R.cycle.errors.join(','));

  console.log('\n=== 4. 变量 ===');
  check('引用不存在的变量 → E-VAR', has(R.varMissing.errors, 'E-VAR'), R.varMissing.errors.join(','));
  check('没选变量 → W-REQ 告警', has(R.varMissing.warnings, 'W-REQ'), R.varMissing.warnings.join(','));

  console.log('\n=== 5. 执行与产出 ===');
  check('执行线未接入 → W-EXECIN', has(R.execIdle.warnings, 'W-EXECIN'), R.execIdle.warnings.join(','));
  check('没有 end/result → W-OUTPUT', has(R.noOutput.warnings, 'W-OUTPUT'), R.noOutput.warnings.join(','));
  check('多个 start → W-START', has(R.multiStart.warnings, 'W-START'), R.multiStart.warnings.join(','));

  console.log('\n=== 6. 必填项与动态引脚 ===');
  check('aiTask 指令为空 → W-REQ', has(R.emptyInstruction.warnings, 'W-REQ'), R.emptyInstruction.warnings.join(','));
  check('imageSplit 无视图 → W-DYNAMIC', has(R.noViews.warnings, 'W-DYNAMIC'), R.noViews.warnings.join(','));
  check('tripoModel 缺参考图 → W-REQ', has(R.noRef.warnings, 'W-REQ'), R.noRef.warnings.join(','));
  check('多视图建模一张没接 → W-REQ', has(R.noMultiRef.warnings, 'W-REQ'), R.noMultiRef.warnings.join(','));

  console.log('\n=== 7. 摘要 ===');
  check('通过时摘要为「流程校验通过」', R.sumOk === '流程校验通过', R.sumOk);
  check('未通过时摘要以「校验未通过」开头', /^校验未通过/.test(R.sumBad), R.sumBad);

  console.log('\n=== 8. 页面零错误 ===');
  check('无页面异常', errors.length === 0, errors.join(' | '));

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
