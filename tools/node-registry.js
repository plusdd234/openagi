/* 架构体检：节点注册表 + 单一引脚 schema（改良 A + B）
 * 1) 21 个类型都注册完整：声明 / 参数 / 默认值 / 执行 / 分组
 * 2) 重复注册会被拦
 * 3) schema 与渲染清单一致：pinsForRender 给出的每个引脚，pinTypeOf/pinDirOf 都能对上
 * 4) 编辑器与契约共用同一份解析（pinType === pinTypeOf，消灭双实现）
 * 5) **即插即用**：运行时注册一个新节点，不改任何其他文件就能出现在节点库、通过校验、真跑出结果
 * 用法：node tools/node-registry.js
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

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  console.log('\n=== 1. 注册完整性 ===');
  const r1 = await page.evaluate(() => {
    const types = Object.keys(NODE_REGISTRY);
    const noDef = types.filter(t => !NODE_DEFS[t]);
    const noParams = types.filter(t => !Array.isArray(NODE_PARAMS[t]));
    const noRun = types.filter(t => typeof NODE_RUNNERS[t] !== 'function');
    const seedBad = [];
    types.forEach(t => {
      try {
        const s = seedNodeData(t);
        if(!s || typeof s.data !== 'object' || s.data === null) seedBad.push(t);
        if(!('params' in s)) seedBad.push(t + ':params');
      } catch(e){ seedBad.push(t + ':throw'); }
    });
    return { count: types.length, noDef, noParams, noRun, seedBad, lib: NODE_LIB.map(g => g.group + ':' + g.types.length) };
  });
  check(r1.count === 21, '注册了 21 个节点', String(r1.count));
  check(r1.noDef.length === 0, '每个类型都有声明（NODE_DEFS）', r1.noDef.join(','));
  check(r1.noParams.length === 0, '每个类型都有参数表（NODE_PARAMS）', r1.noParams.join(','));
  check(r1.noRun.length === 0, '每个类型都有执行函数（NODE_RUNNERS）', r1.noRun.join(','));
  check(r1.seedBad.length === 0, '每个类型都能给出默认值', r1.seedBad.join(','));
  check(r1.lib.join('|') === '输入:5|分析任务:1|图像任务:4|3D 任务:4|逻辑:2|流程:2|输出:1', '节点库分组与顺序保持', r1.lib.join('|'));

  console.log('\n=== 2. 重复注册被拦 ===');
  const r2 = await page.evaluate(() => {
    let msg = '';
    try { registerNode({ type:'aiTask', title:'重复' }); } catch(e){ msg = String(e.message || e); }
    let msg2 = '';
    try { registerNode({ title:'没有 type' }); } catch(e){ msg2 = String(e.message || e); }
    return { msg, msg2 };
  });
  check(/重复注册/.test(r2.msg), '同类型重复注册抛错', r2.msg);
  check(/缺少 type/.test(r2.msg2), '缺 type 抛错', r2.msg2);

  console.log('\n=== 3. schema 与渲染清单一致 ===');
  const r3 = await page.evaluate(() => {
    const bad = [];
    const mismatch = [];
    Object.keys(NODE_DEFS).forEach(t => {
      const n = newNode(t, 0, 0);
      if(t === 'start' || t === 'end') n.params = [{ id:'pp', name:'参数', type:'image', value:'' }];
      if(t === 'varGet' || t === 'varSet') n.data.varId = 'v1';
      const vars = [{ id:'v1', name:'变量', type:'image', value:'' }];
      const sets = pinsForRender(n, vars);
      sets.in.forEach(p => {
        const ty = pinTypeOf(n, p.key, vars);
        const dir = pinDirOf(n, p.key, vars);
        if(ty !== p.type) bad.push(t + '.in.' + p.key + ':' + ty + '≠' + p.type);
        if(dir !== 'in' && dir !== 'both') bad.push(t + '.in.' + p.key + ':dir=' + dir);
        if(t !== 'varSet' && pinType(n, p.key) !== ty) mismatch.push(t + '.in.' + p.key);
      });
      sets.out.forEach(p => {
        const ty = pinTypeOf(n, p.key, vars);
        const dir = pinDirOf(n, p.key, vars);
        if(ty !== p.type) bad.push(t + '.out.' + p.key + ':' + ty + '≠' + p.type);
        if(dir !== 'out' && dir !== 'both') bad.push(t + '.out.' + p.key + ':dir=' + dir);
        if(t !== 'varGet' && pinType(n, p.key) !== ty) mismatch.push(t + '.out.' + p.key);
      });
    });
    return { bad, mismatch, checked: Object.keys(NODE_DEFS).length };
  });
  check(r3.bad.length === 0, '渲染清单里的引脚都能被 schema 解析且类型一致', r3.bad.slice(0, 5).join(' | '));
  check(r3.mismatch.length === 0, '编辑器 pinType 与 schema pinTypeOf 完全一致（单一真源）', r3.mismatch.slice(0, 5).join(' | '));

  const r3b = await page.evaluate(() => {
    // var 引脚：schema 依赖「当前流程的 vars」，开一个有变量的流程来验
    const vg = newNode('varGet', 0, 0);
    vg.data.varId = 'v1';
    const vs = newNode('varSet', 0, 0);
    vs.data.varId = 'v1';
    const flow = { id:'var_' + Date.now(), name:'变量流程', nodes:[vg, vs], links:[], vars:[{ id:'v1', name:'素材', type:'image', value:'' }], updated:Date.now(), lastRun:null };
    FLOWS.unshift(flow); openFlow(flow.id); flushViewSwap();
    const liveGet = bp.nodes.find(x => x.type === 'varGet');
    const liveSet = bp.nodes.find(x => x.type === 'varSet');
    return {
      get: pinType(liveGet, 'v1') + '/' + pinDirOf(liveGet, 'v1', bp.vars),
      set: pinType(liveSet, 'v1') + '/' + pinDirOf(liveSet, 'v1', bp.vars)
    };
  });
  check(r3b.get === 'image/out' && r3b.set === 'image/in', '变量引脚按当前流程的变量类型解析', r3b.get + ' / ' + r3b.set);

  console.log('\n=== 4. 几个关键解析点 ===');
  const r4 = await page.evaluate(() => {
    const at = newNode('aiTask', 0, 0);
    const sb = newNode('smartBranch', 0, 0);
    const bc = newNode('branch', 0, 0);
    const st = newNode('start', 0, 0);
    st.params = [{ id:'s1', name:'图', type:'image', value:'' }];
    return {
      execBoth: pinDirOf(at, 'exec'),
      atIn: pinTypeOf(at, at.data.inputs[0].id),
      atOut: pinTypeOf(at, at.data.outputs[0].id),
      instruction: pinTypeOf(at, 'instruction'),
      timeout: pinTypeOf(at, 'timeout'),
      sbIn: pinTypeOf(sb, sb.data.inputs[0].id),
      sbBranch: pinTypeOf(sb, sb.data.branches[0].id) + '/' + pinDirOf(sb, sb.data.branches[0].id),
      branchTrue: pinTypeOf(bc, 'true') + '/' + pinDirOf(bc, 'true'),
      startParam: pinTypeOf(st, 's1') + '/' + pinDirOf(st, 's1'),
      unknown: pinTypeOf(at, 'no_such_pin')
    };
  });
  check(r4.execBoth === 'both', '中间节点的 exec 是双向引脚', String(r4.execBoth));
  check(r4.atIn === 'string' && r4.atOut === 'string', '分析任务自定义引脚可解析', r4.atIn + '/' + r4.atOut);
  check(r4.instruction === 'string' && r4.timeout === 'int', '参数引脚有正确类型（instruction/timeout）', r4.instruction + '/' + r4.timeout);
  check(r4.sbIn === 'string' && r4.sbBranch === 'exec/out', '智能分支输入与出口', r4.sbIn + ' / ' + r4.sbBranch);
  check(r4.branchTrue === 'exec/out', '条件分支 true/false 是 exec', r4.branchTrue);
  check(r4.startParam === 'image/out', '起点参数是输出引脚', r4.startParam);
  check(r4.unknown === null, '不存在的引脚返回 null', String(r4.unknown));

  console.log('\n=== 5. 即插即用：运行时注册一个新节点并真跑 ===');
  const r5 = await page.evaluate(async () => {
    registerNode({
      type:'echoNote', title:'回显备注', dot:'text', group:'输出',
      desc:'把输入框里的备注原样输出（架构体检用的最小节点）',
      execIn:true, execOut:['exec'], outputs:['text'],
      params:[ { key:'note', label:'备注', ctl:'textarea', ph:'随便写点什么' } ],
      seed: () => ({ data:{ note:'来自新节点' }, params:null }),
      run: async ({ n }) => { n.out.text = '回显：' + (n.data.note || ''); },
      validate: (n, c) => c.linked('note') || String(n.data.note || '').trim() ? [] : [{ code:'W-REQ', message:'备注为空' }]
    });
    const registered = !!NODE_DEFS.echoNote && (NODE_PARAMS.echoNote || []).length === 1;
    const inLib = (NODE_LIB.find(g => g.group === '输出') || { types:[] }).types.indexOf('echoNote') >= 0;

    // 造流程：start(exec) → echoNote(exec) → end(文本参数)
    const s = newNode('start', 0, 0);
    const e = newNode('echoNote', 300, 0);
    const out = newNode('end', 600, 0);
    out.params = [{ id:'op1', name:'结果', type:'string', value:'' }];
    const flow = {
      id: 'echo_' + Date.now(), name: '新节点即插即用', vars: [], updated: Date.now(), lastRun: null,
      nodes: [s, e, out],
      links: [
        { id: 'e1', from: { node:s.id, key:'exec' }, to: { node:e.id, key:'exec' } },
        { id: 'e2', from: { node:e.id, key:'exec' }, to: { node:out.id, key:'exec' } },
        { id: 'e3', from: { node:e.id, key:'text' }, to: { node:out.id, key:'op1' } }
      ]
    };
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    const v = validateFlow(snapshotBp());
    await runFlow();
    const live = bp.nodes.find(x => x.type === 'echoNote');
    const endNode = bp.nodes.find(x => x.type === 'end');
    return {
      registered, inLib,
      seedNote: seedNodeData('echoNote').data.note,
      errors: v.errors.map(x => x.code),
      warnings: v.warnings.map(x => x.code),
      status: live.status, out: live.out.text || '',
      endValue: (bp.lastRun && bp.lastRun.values && bp.lastRun.values[0] ? bp.lastRun.values[0].value : '')
    };
  });
  check(r5.registered === true, '注册后立刻出现在 NODE_DEFS / NODE_PARAMS');
  check(r5.inLib === true, '注册后自动进入节点库分组');
  check(r5.seedNote === '来自新节点', '默认值来自描述符的 seed', r5.seedNote);
  check(r5.errors.length === 0, '新节点通过校验（无需改校验器）', r5.errors.join(','));
  check(!r5.warnings.includes('W-REQ'), '有备注时不报必填告警', r5.warnings.join(','));
  check(r5.status === 'ok' && r5.out === '回显：来自新节点', '新节点能被运行时执行', r5.status + ' / ' + r5.out);
  check(r5.endValue === '回显：来自新节点', '输出通过连线流到结束节点', String(r5.endValue));

  console.log('\n=== 6. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
