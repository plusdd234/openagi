/* smartBranch「智能分支」节点体检（不调真实 LLM、不触桥、不耗积分）
 * 1) 默认形态与节点库位置（aiBranch 不再出现在库里，但老流程仍可执行）
 * 2) 引脚渲染：自定义输入（数量 / 类型任意）+ instruction / timeout + 动态执行出口 + text 输出
 * 3) 增删输入引脚：加一个、改类型、删一个（删时清理连线）
 * 4) pinType / pinDirOf 识别：动态输入按声明类型、出口识别成 exec
 * 5) 打桩 LLM 执行：任意输入随提示词送模型、选中哪条出口只走哪条
 * 6) 多图输入（content 里带 image_url）
 * 7) 错误路径：无出口 / 无输入 / 既无依据也无输入
 * 用法：node tools/smart-branch-node.js
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

  /* 护栏：拦桥；LLM 指向桩域名 */
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

  console.log('\n=== 1. 默认形态与节点库 ===');
  const r1 = await page.evaluate(() => {
    const n = newNode('smartBranch', 0, 0);
    const lib = NODE_LIB.reduce((a, g) => a.concat(g.types), []);
    return {
      inputs: (n.data.inputs || []).map(p => p.name + ':' + p.type),
      branches: (n.data.branches || []).length,
      timeout: n.data.timeout,
      hasExecIn: !!(NODE_DEFS.smartBranch.execIn),
      execOutFrom: NODE_DEFS.smartBranch.execOutFrom,
      inLib: lib.indexOf('smartBranch') >= 0,
      oldInLib: lib.indexOf('aiBranch') >= 0,
      oldStillDefined: !!NODE_DEFS.aiBranch
    };
  });
  check(JSON.stringify(r1.inputs) === JSON.stringify(['文本:string', '图像:image']), '默认两个输入引脚（文本 / 图像）', JSON.stringify(r1.inputs));
  check(r1.branches === 2, '默认两个出口', String(r1.branches));
  check(r1.timeout === 120 && r1.execOutFrom === 'branches', '默认超时与动态出口声明', r1.timeout + '/' + r1.execOutFrom);
  check(r1.hasExecIn === true, '有执行入口');
  check(r1.inLib === true, '节点库里有「智能分支」');
  check(r1.oldInLib === false, '旧的「AI 分支」已从节点库移除', '仍在库里会让人选错');
  check(r1.oldStillDefined === true, '旧节点定义保留（老流程还能打开运行）');

  console.log('\n=== 2. 引脚渲染 ===');
  const r2 = await page.evaluate(() => {
    const n = newNode('smartBranch', 40, 0);
    const flow = { id: 'sb_' + Date.now(), name: 'smartBranch 体检', nodes: [n], links: [], vars: [], updated: Date.now(), lastRun: null };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const el = document.getElementById('n-' + n.id);
    const pins = d => Array.from(el.querySelectorAll('.pin.' + d)).map(p => ({ key: p.dataset.key, type: p.dataset.type }));
    window.__sb = { n, el };
    return {
      ins: pins('in'), outs: pins('out'),
      ids: { i1: n.data.inputs[0].id, i2: n.data.inputs[1].id, b1: n.data.branches[0].id, b2: n.data.branches[1].id }
    };
  });
  const inKeys = r2.ins.map(p => p.key);
  check(inKeys.indexOf(r2.ids.i1) >= 0 && inKeys.indexOf(r2.ids.i2) >= 0, '两个自定义输入都有真实引脚', inKeys.join(','));
  check(r2.ins.find(p => p.key === r2.ids.i1).type === 'string' && r2.ins.find(p => p.key === r2.ids.i2).type === 'image', '引脚类型与声明一致');
  check(inKeys.indexOf('instruction') >= 0 && inKeys.indexOf('timeout') >= 0, '选择依据 / 超时也有引脚', inKeys.join(','));
  check(r2.outs.find(p => p.key === r2.ids.b1).type === 'exec' && r2.outs.find(p => p.key === r2.ids.b2).type === 'exec', '两个出口是 exec 引脚');
  check(!!r2.outs.find(p => p.key === 'text'), '有 text 输出引脚（选择结果）');

  console.log('\n=== 3. 增删输入引脚 ===');
  const r3 = await page.evaluate(() => {
    // openFlow 会深拷贝流程，必须从 bp 里取活节点
    const n = bp.nodes.find(x => x.id === window.__sb.n.id);
    const sec = document.querySelector('#n-' + n.id + ' .task-sec');
    const add = sec ? sec.querySelector('.task-add') : null;
    add.click();
    const afterAdd = (n.data.inputs || []).length;
    const last = n.data.inputs[n.data.inputs.length - 1];
    const el = document.getElementById('n-' + n.id);
    const pinEl = el.querySelector('.pin.in[data-key="' + last.id + '"]');
    // 改类型：直接驱动行内 select 的 change
    const row = Array.from(el.querySelectorAll('.task-pin')).find(r => {
      const input = r.querySelector('input');
      return input && (input.value === last.name);
    });
    const sel = row ? row.querySelector('select') : null;
    if (sel) { sel.value = 'float'; sel.dispatchEvent(new Event('change')); }
    const pinTypeAfter = pinType(n, last.id);
    const pinTypeFromContract = pinTypeOf(n, last.id);
    // 改类型会触发重渲染，必须重新取 DOM
    const fresh = document.getElementById('n-' + n.id).querySelector('.pin.in[data-key="' + last.id + '"]');
    return {
      afterAdd,
      pinRendered: !!pinEl,
      pinTypeAfter,
      pinTypeFromContract,
      selValue: sel ? sel.value : '',
      pinDataset: fresh ? fresh.dataset.type : '(missing)'
    };
  });
  check(r3.afterAdd === 3, '点「+ 添加」新增一条输入引脚', String(r3.afterAdd));
  check(r3.pinRendered === true, '新引脚渲染出真实 pin 元素（能拖线）');
  check(r3.pinTypeAfter === 'float' && r3.pinTypeFromContract === 'float' && r3.pinDataset === 'float',
    '改类型后编辑器与契约解析都跟着变', r3.selValue + '/' + r3.pinDataset);

  const r4 = await page.evaluate(() => {
    const n = bp.nodes.find(x => x.id === window.__sb.n.id);
    const target = n.data.inputs[0];
    // 建一个文本节点连到这条引脚上，验证删除时连线被清理
    const t = newNode('text', 0, 200);
    t.data.text = '要送进分支的描述';
    bp.nodes.push(t);
    bp.links.push({ id: uid(), from: { node: t.id, key: 'text' }, to: { node: n.id, key: target.id } });
    renderNodes();
    const before = bp.links.length;
    removeTaskPin(n, 'in', target);
    return {
      before, after: bp.links.length,
      removed: !(n.data.inputs || []).some(p => p.id === target.id)
    };
  });
  check(r4.removed === true, '删除引脚后数据里不再有它');
  check(r4.after === r4.before - 1, '删除引脚时连带清掉连线', r4.before + '→' + r4.after);

  console.log('\n=== 4. 校验器认识这个节点 ===');
  const r5 = await page.evaluate(() => {
    const n = newNode('smartBranch', 0, 0);
    n.data.inputs = [{ id: 'i_str', name: '描述', type: 'string' }, { id: 'i_img', name: '图', type: 'image' }];
    n.data.branches = [{ id: 'b1', name: '走 A', hint: '', fallback: false }];
    n.data.instruction = '按描述分流';
    const cond = newNode('condition', 0, 0);
    cond.data.instruction = '判断';
    const img = newNode('imageIn', 0, 0);
    img.data.image = 'data:image/png;base64,AAAA';
    const res = validateFlow({
      nodes: [n, cond, img], vars: [],
      links: [
        { id: 'l1', from: { node: img.id, key: 'image' }, to: { node: cond.id, key: 'text' } },   // image → string，应报 E-TYPE
        { id: 'l2', from: { node: n.id, key: 'b1' }, to: { node: cond.id, key: 'exec' } }           // 动态出口 → exec，应放行
      ]
    });
    const bare = newNode('smartBranch', 0, 0);
    bare.data.inputs = [];
    bare.data.branches = [];
    bare.data.instruction = 'x';
    const empty = validateFlow({ nodes: [bare], vars: [], links: [] });
    return {
      errors: res.errors.map(e => e.code),
      warnings: res.warnings.map(w => w.code),
      emptyWarn: empty.warnings.map(w => w.code)
    };
  });
  check(r5.errors.indexOf('E-TYPE') >= 0, 'image 输入连到 string 引脚会被拦（E-TYPE）', r5.errors.join(','));
  check(r5.errors.indexOf('E-PIN') < 0, '出口引脚与自定义输入都能被正确解析（不误报 E-PIN）', r5.errors.join(','));
  check(r5.emptyWarn.indexOf('W-DYNAMIC') >= 0, '没有输入/出口时给出 W-DYNAMIC 提醒', r5.emptyWarn.join(','));

  console.log('\n=== 5. 执行：任意输入送进模型，按选择只走一条 ===');
  const r6 = await page.evaluate(async () => {
    const n = newNode('smartBranch', 300, 0);
    const iDesc = { id: 'sb_desc', name: '描述', type: 'string' };
    const iNum = { id: 'sb_num', name: '数量', type: 'int' };
    const iImg = { id: 'sb_img', name: '参考图', type: 'image' };
    n.data.inputs = [iDesc, iNum, iImg];
    n.data.instruction = '按数量与描述决定走哪条出口';
    const bA = { id: 'sb_bA', name: '分支A', hint: '数量小于 10', fallback: false };
    const bB = { id: 'sb_bB', name: '分支B', hint: '数量大于 10', fallback: true };
    n.data.branches = [bA, bB];

    const s = newNode('start', 0, 0);
    const tDesc = newNode('text', 0, 120); tDesc.data.text = '需要精修的老照片';
    const tNum = newNode('numNode', 0, 200); tNum.data.value = 12;
    const img = newNode('imageIn', 0, 280); img.data.image = 'data:image/png;base64,AAAA';
    const rA = newNode('result', 600, 0);
    const tA = newNode('text', 600, 120); tA.data.text = 'A 路径产出';
    const rB = newNode('result', 600, 200);
    const tB = newNode('text', 600, 320); tB.data.text = 'B 路径产出';

    const L = (a, ak, b, bk) => ({ id: uid(), from: { node: a.id, key: ak }, to: { node: b.id, key: bk } });
    const flow = {
      id: 'sb_run_' + Date.now(), name: '智能分支执行', vars: [], updated: Date.now(), lastRun: null,
      nodes: [s, tDesc, tNum, img, n, rA, tA, rB, tB],
      links: [
        L(s, 'exec', n, 'exec'),
        L(tDesc, 'text', n, iDesc.id),
        L(tNum, 'int', n, iNum.id),
        L(img, 'image', n, iImg.id),
        L(n, bA.id, rA, 'exec'), L(tA, 'text', rA, 'text'),
        L(n, bB.id, rB, 'exec'), L(tB, 'text', rB, 'text')
      ]
    };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    // openFlow 深拷贝，读状态要取 bp 里的活节点
    const live = bp.nodes.find(x => x.id === n.id);
    const liveA = bp.nodes.find(x => x.id === rA.id);
    const liveB = bp.nodes.find(x => x.id === rB.id);

    window.__llmCalls = [];
    const guard = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/stub\.test/.test(url)) {
        window.__llmCalls.push({ body: (init && init.body) || '' });
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '```json\n{"choice":"分支B","reason":"数量超过 10"}\n```' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return guard.apply(this, arguments);
    };
    await runFlow();
    const body = window.__llmCalls.length ? JSON.parse(window.__llmCalls[0].body) : {};
    const content = (body.messages && body.messages[1] && body.messages[1].content) || [];
    const text = Array.isArray(content) ? content.map(c => c.text || '').join('\n') : '';
    const images = Array.isArray(content) ? content.filter(c => c.type === 'image_url').length : 0;
    return {
      status: live.status, err: live.error || '',
      choice: live.out.choice, text: live.out.text || '',
      rA: liveA.status, rB: liveB.status,
      llmCalls: window.__llmCalls.length, bridge: window.__bridgeCalls.length,
      reqText: text, images
    };
  });
  check(r6.status === 'ok', '节点运行成功', r6.status + ' ' + r6.err);
  check(r6.choice === 'sb_bB', 'out.choice 指向模型选的出口', r6.choice);
  check(/已选择「分支B」/.test(r6.text) && /数量超过 10/.test(r6.text), 'text 输出选择结果与理由', r6.text);
  check(r6.rB === 'ok' && r6.rA === '', '只激活被选中出口的下游', 'B=' + r6.rB + ' A=' + r6.rA);
  check(r6.llmCalls === 1, 'LLM 只请求一次', String(r6.llmCalls));
  check(/输入数据/.test(r6.reqText) && /描述：需要精修的老照片/.test(r6.reqText), '字符串输入进了提示词', r6.reqText.slice(0, 80));
  check(/数量：12/.test(r6.reqText), '整数输入按文本送进提示词');
  check(/图像输入：已附带 1 张（参考图）/.test(r6.reqText), '图像输入在提示词里标注了名称与数量');
  check(r6.images === 1, '图像以 image_url 形式附带', 'images=' + r6.images);
  check(r6.bridge === 0, '全程零桥请求');

  console.log('\n=== 6. 错误路径 ===');
  const r7 = await page.evaluate(async () => {
    const out = {};
    const mk = (mut) => {
      const n = newNode('smartBranch', 0, 0);
      n.data.inputs = [{ id: 'x1', name: '描述', type: 'string' }];
      n.data.branches = [{ id: 'y1', name: '唯一出口', hint: '', fallback: false }];
      n.data.instruction = '';
      const s = newNode('start', 0, 0);
      const t = newNode('text', 0, 120); t.data.text = '内容';
      const flow = {
        id: 'sb_err_' + Math.random(), name: '错误路径', vars: [], updated: Date.now(), lastRun: null,
        nodes: [s, t, n],
        links: [
          { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: n.id, key: 'exec' } },
          { id: uid(), from: { node: t.id, key: 'text' }, to: { node: n.id, key: 'x1' } }
        ]
      };
      if (mut) mut(n);
      FLOWS.unshift(flow);
      openFlow(flow.id);
      return bp.nodes.find(x => x.id === n.id);
    };
    // 无出口
    let n = mk(x => { x.data.branches = []; });
    await runFlow();
    out.noBranch = { status: n.status, err: n.error || '' };
    // 无输入引脚
    n = mk(x => { x.data.inputs = []; });
    await runFlow();
    out.noInput = { status: n.status, err: n.error || '' };
    return out;
  });
  check(r7.noBranch.status === 'error' && /出口/.test(r7.noBranch.err), '没有出口时友好报错', r7.noBranch.err);
  check(r7.noInput.status === 'error' && /输入引脚/.test(r7.noInput.err), '没有输入引脚时友好报错', r7.noInput.err);

  console.log('\n=== 7. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
