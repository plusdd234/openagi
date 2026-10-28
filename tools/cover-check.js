/* 节点库「输入类型覆盖」体检
 * 1) 汇总所有节点的输入 / 输出引脚类型，找出「没有数据源可连」的输入类型
 * 2) 真实跑一次：数值节点(int/float) → 四视图参数引脚；布尔节点 → 分支
 * 用法：node tools/cover-check.js [model.obj 路径]
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储
const OBJ = process.argv[2] || 'C:/Users/30297/Desktop/自研贴图系统/AIGC工具包/pipeline/model.obj';

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  /* ---------------- 1. 覆盖矩阵 ---------------- */
  const cover = await page.evaluate(() => {
    const libTypes = NODE_LIB.reduce((a, g) => a.concat(g.types), []);
    const flow = {
      id: 'cover_' + Date.now(), name: '类型覆盖体检',
      nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null
    };
    // 按 5 列排布，便于截图核对全部节点形态
    Object.keys(NODE_DEFS).forEach((t, i) => {
      const col = i % 5, rowN = Math.floor(i / 5);
      flow.nodes.push(newNode(t, col * 230, rowN * 250));
    });
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    const rows = Array.from(document.querySelectorAll('.node')).map(el => {
      const n = bp.nodes.find(x => x.id === el.dataset.id);
      const pin = d => Array.from(el.querySelectorAll('.pin.' + d))
        .map(p => ({ key: p.dataset.key, type: p.dataset.type }))
        .filter(p => p.type !== 'exec');
      return { type: n.type, in: pin('in'), out: pin('out') };
    });
    return { rows, libTypes, types: Object.keys(TYPE_META) };
  });

  const sink = new Map(), src = new Map();
  cover.rows.forEach(r => {
    r.in.forEach(p => {
      if (!sink.has(p.type)) sink.set(p.type, new Set());
      sink.get(p.type).add(r.type);
    });
    if (cover.libTypes.includes(r.type)) {
      r.out.forEach(p => {
        if (!src.has(p.type)) src.set(p.type, new Set());
        src.get(p.type).add(r.type);
      });
    }
  });

  console.log('=== 节点库可添加的节点 ===');
  console.log(' ' + cover.libTypes.join(', '));
  console.log('\n=== 输入引脚类型 → 能否从节点库找到数据源 ===');
  [...sink.keys()].sort().forEach(t => {
    const providers = src.get(t) ? [...src.get(t)] : [];
    console.log(` ${t.padEnd(7)} 需要方: ${[...sink.get(t)].join(',')}`);
    console.log(` ${''.padEnd(7)} 提供方: ${providers.length ? providers.join(',') : '❌ 无（缺口）'}`);
  });
  const gaps = [...sink.keys()].filter(t => !src.has(t));
  console.log('\n缺口类型: ' + (gaps.length ? gaps.join(', ') : '无'));
  await page.evaluate(() => fitView());
  await page.screenshot({ path: path.join(__dirname, '..', 'samples', 'all_types.png') });

  /* ---------------- 2. 真实连线运行 ---------------- */
  const objData = 'data:model/obj;base64,' + fs.readFileSync(OBJ).toString('base64');
  const run = await page.evaluate(async (objData) => {
    const s = newNode('start', -260, 0);          // 执行流只从「任务开始」出发
    const mi = newNode('modelIn', 0, 0);
    mi.data.model = objData; mi.data.fileName = 'model.obj';
    const nv = newNode('numNode', 40, 320); nv.data.value = 3.7;
    const bn = newNode('boolNode', 40, 460); bn.data.bool = false;
    const mv = newNode('modelViews', 330, 0);
    const br = newNode('branch', 330, 460);
    const rs = newNode('result', 640, 260);

    const wide = mv.data.params.find(p => p.name === '线宽');   // float
    const gap = mv.data.params.find(p => p.name === '间距');    // int
    const flow = {
      id: 'run_' + Date.now(), name: '数值联动',
      nodes: [s, mi, nv, bn, mv, br, rs], vars: [], updated: Date.now(), lastRun: null,
      links: [
        // 执行线：任务开始 → 四视图 → 结果；任务开始 → 分支
        { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: mv.id, key: 'exec' } },
        { id: uid(), from: { node: mv.id, key: 'exec' }, to: { node: rs.id, key: 'exec' } },
        { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: br.id, key: 'exec' } },
        // 数据线：输入类节点不占执行线，由下游按需读取
        { id: uid(), from: { node: nv.id, key: 'float' }, to: { node: mv.id, key: wide.id } },
        { id: uid(), from: { node: nv.id, key: 'int' }, to: { node: mv.id, key: gap.id } },
        { id: uid(), from: { node: bn.id, key: 'bool' }, to: { node: br.id, key: 'bool' } },
        { id: uid(), from: { node: mi.id, key: 'model' }, to: { node: mv.id, key: 'model' } },
        { id: uid(), from: { node: mv.id, key: 'image' }, to: { node: rs.id, key: 'image' } }
      ]
    };
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();

    const round = async v => {
      nv.data.value = v;
      bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
      await runFlow();
      const mvN = bp.nodes.find(n => n.type === 'modelViews');
      const nvN = bp.nodes.find(n => n.type === 'numNode');
      return {
        value: v,
        numOut: { int: nvN.out.int, float: nvN.out.float },
        mvStatus: mvN.status, mvErr: mvN.error || '',
        mvText: mvN.out.text || '',
        imgLen: (mvN.out.image || '').length,
        head: (mvN.out.image || '').slice(0, 64)
      };
    };

    const a = await round(3.7);
    const b = await round(0.5);
    const brN = bp.nodes.find(n => n.type === 'branch');
    const bnN = bp.nodes.find(n => n.type === 'boolNode');

    // DOM：已连线的数值参数引脚应处于 is-linked（控件隐藏）
    const mvEl = document.getElementById('n-' + mv.id);
    const rows = Array.from(mvEl.querySelectorAll('.port-row.has-param'))
      .map(r => ({ key: r.dataset.paramKey, linked: r.classList.contains('is-linked') }));

    return {
      a, b, rows,
      same: a.imgLen === b.imgLen && a.head === b.head,
      boolOut: bnN.out.bool,
      branchGot: brN.out ? brN.out.bool : null,
      statuses: bp.nodes.map(n => n.type + ':' + n.status + (n.error ? '(' + n.error + ')' : ''))
    };
  }, objData);

  console.log('\n=== 运行：数值节点 → 四视图参数 ===');
  console.log(' 数值节点输出: ' + JSON.stringify(run.a.numOut));
  console.log(' 线宽/间距引脚连线态: ' + JSON.stringify(run.rows));
  console.log(' A 值=3.7 → ' + run.a.mvStatus + ' | ' + run.a.mvText + ' | PNG ' + run.a.imgLen + ' 字符');
  console.log(' B 值=0.5 → ' + run.b.mvStatus + ' | ' + run.b.mvText + ' | PNG ' + run.b.imgLen + ' 字符');
  console.log(' 两次结果是否随数值变化: ' + (run.same ? '否 ❌' : '是 ✅'));
  console.log('\n=== 布尔节点 → 分支 ===');
  console.log(' boolNode 输出 ' + run.boolOut + ' → branch 得到 ' + run.branchGot);
  console.log(' 全部节点状态: ' + run.statuses.join(' | '));

  await page.screenshot({ path: path.join(__dirname, '..', 'samples', 'input_types.png'), fullPage: false });

  console.log('\n=== 错误 (' + errors.length + ') ===');
  errors.slice(0, 10).forEach(e => console.log(' - ' + e));
  await browser.close();
  process.exit(errors.length || gaps.length ? 1 : 0);
})().catch(e => { console.error('CHECK FAILED:', e); process.exit(2); });
