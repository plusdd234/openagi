/* tripoModel 节点体检（全程不触发生成、不消耗积分）
 * 护栏：window.fetch 一律拦截 127.0.0.1:8790（Tripo 网页桥）的真实调用，
 *       改为记录并返回合成响应——任何路径都不可能误触网页生成。
 * 1) 节点库可添加；引脚与参数渲染（模式 / 网格版本 / 面数 / 数量 / 格式 / 超时）
 * 2) 缺参考图 → 友好报错，且不发起任何请求
 * 3) 打桩 fetch：executeNode → wfTripoWebModel 的请求体 / 输出键 / 日志
 * 4) 数值引脚连线覆盖就地参数（faceCount）
 * 5) model3d 在非 Tripo 引擎下给出明确门禁提示（零请求）
 * 用法：node tools/tripo-model-node.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const BRIDGE_RE = /127\.0\.0\.1:8790|localhost:8790/;
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  await page.waitForTimeout(1500);

  /* ---- 护栏：拦截一切打到 Tripo 网页桥的真实请求 ---- */
  await page.evaluate(() => {
    window.__bridgeCalls = [];
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ message: '测试环境已禁用真实桥调用' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        }));
      }
      return orig.apply(this, arguments);
    };
  });

  /* ---------- 1. 渲染：引脚 + 参数 ---------- */
  const ui = await page.evaluate(() => {
    const flow = { id: 'tm_' + Date.now(), name: 'tripoModel 体检', nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null };
    const s = newNode('start', -300, 0);
    const tm = newNode('tripoModel', 60, 0);
    const rs = newNode('result', 620, 0);
    flow.nodes = [s, tm, rs];
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: tm.id, key: 'exec' } },
      { id: uid(), from: { node: tm.id, key: 'exec' }, to: { node: rs.id, key: 'exec' } },
      { id: uid(), from: { node: tm.id, key: 'model' }, to: { node: rs.id, key: 'model' } }
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const el = document.getElementById('n-' + tm.id);
    const pins = d => Array.from(el.querySelectorAll('.pin.' + d)).map(p => ({ key: p.dataset.key, type: p.dataset.type }));
    const rows = Array.from(el.querySelectorAll('.port-row.has-param')).map(r => {
      const label = (r.querySelector('.port-label') || {}).textContent || '';
      const ctl = r.querySelector('select, input');
      return { label: label.trim(), ctl: ctl ? ctl.tagName.toLowerCase() : '', value: ctl ? ctl.value : '' };
    });
    const libHas = NODE_LIB.reduce((a, g) => a.concat(g.types), []).includes('tripoModel');
    const title = ((el.querySelector('.node-title') || {}).textContent || '').trim();
    const tips = Array.from(el.querySelectorAll('.node-result')).map(t => (t.textContent || '').trim()).join('|');
    return { in: pins('in'), out: pins('out'), rows, libHas, def: NODE_DEFS.tripoModel, title, tips };
  });

  console.log('=== 1. tripoModel 节点渲染 ===');
  check(ui.libHas, '节点库可添加 tripoModel');
  check(ui.title === 'Tripo 网页生成模型', '节点标题正确', ui.title);
  check(/积分/.test(ui.tips) && /风控/.test(ui.tips), '风控/积分提示已渲染', ui.tips.slice(0, 40));
  const dataIn = ui.in.filter(p => p.type !== 'exec');
  const dataOut = ui.out.filter(p => p.type !== 'exec');
  check(ui.in.some(p => p.key === 'image' && p.type === 'image'), '输入引脚：image', JSON.stringify(ui.in));
  check(JSON.stringify(dataOut.map(p => p.key)) === '["model","text"]', '输出数据引脚：model + text', JSON.stringify(dataOut));
  check(dataIn.length === 7, '参数同时是可连线输入引脚（7 个）', String(dataIn.length));
  check(dataIn.find(p => p.key === 'faceCount').type === 'int' && dataIn.find(p => p.key === 'count').type === 'int', '面数/数量引脚为 int');
  check(dataOut.find(p => p.key === 'model').type === 'model', 'model 引脚类型为 model');
  check(dataOut.find(p => p.key === 'text').type === 'string', 'text 引脚类型为 string');
  check(ui.def && ui.def.execIn === true && (ui.def.execOut || []).length === 1, '带执行引脚（接入执行线）');
  console.log(' 参数行: ' + JSON.stringify(ui.rows));
  const labels = ui.rows.map(r => r.label).join('|');
  ['模式', '网格版本', '面数', '数量', '格式', '超时'].forEach(k => check(labels.includes(k), '参数行含「' + k + '」'));
  const modeRow = ui.rows.find(r => r.label === '模式');
  check(modeRow && modeRow.value === 'smart', '模式默认「智能网格」', modeRow && modeRow.value);
  const verRow = ui.rows.find(r => r.label === '网格版本');
  check(verRow && verRow.value === 'P2.0', '网格版本默认 P2.0', verRow && verRow.value);

  /* ---------- 2. 缺参考图：友好报错且零请求 ---------- */
  const noImg = await page.evaluate(async () => {
    window.__calls = [];
    const tm = bp.nodes.find(n => n.type === 'tripoModel');
    bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
    await runFlow();
    return { status: tm.status, err: tm.error || '', calls: window.__bridgeCalls.slice() };
  });
  console.log('\n=== 2. 未连参考图 ===');
  check(noImg.status === 'error', '节点状态为失败', noImg.status);
  check(/参考图/.test(noImg.err), '错误提示提到参考图', noImg.err);
  check(noImg.calls.length === 0, '未发起任何请求（不误触发生成）', '请求数=' + noImg.calls.length);

  /* ---------- 3. 打桩 fetch：完整请求体 / 输出 / 数值引脚覆盖 ---------- */
  const stubbed = await page.evaluate(async (png) => {
    // 在护栏之上再打一层桩：精确捕获 /generate-model 的请求体
    const guard = window.fetch;
    window.__calls = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      window.__calls.push({ url: String(url), method: (init || {}).method, body: (init || {}).body });
      return new Response(JSON.stringify({
        url: 'http://127.0.0.1:8790/out/model_stub.glb',
        file: 'model_stub.glb', size: 20480, message: ''
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      // 数值节点 → 面数引脚（连线优先于就地值）
      const nv = newNode('numNode', -300, 260); nv.data.value = 15000;
      const tm = bp.nodes.find(n => n.type === 'tripoModel');
      bp.nodes.push(nv);
      bp.links.push({ id: uid(), from: { node: nv.id, key: 'int' }, to: { node: tm.id, key: 'faceCount' } });
      // 参考图：图像输入节点（纯参数节点，不占执行线）
      const ii = newNode('imageIn', -300, 420);
      ii.data.image = png; ii.data.fileName = 'ref.png';
      bp.nodes.push(ii);
      bp.links.push({ id: uid(), from: { node: ii.id, key: 'image' }, to: { node: tm.id, key: 'image' } });
      // 就地参数也改一下，验证连线优先
      tm.data.format = 'glb';
      tm.data.count = 2;
      tm.data.timeout = 600;
      bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
      await runFlow();
      return {
        calls: window.__calls.slice(),
        tmStatus: tm.status, tmErr: tm.error || '',
        tmOut: { model: tm.out.model, text: tm.out.text },
        rsOut: (bp.nodes.find(n => n.type === 'result') || {}).out || {}
      };
    } finally { window.fetch = guard; }
  }, PNG_1PX);

  console.log('\n=== 3. 打桩 fetch 跑通执行分支 ===');
  const call = stubbed.calls.find(c => /\/generate-model$/.test(c.url));
  check(!!call, 'POST /generate-model 被调用', stubbed.calls.map(c => c.url).join(','));
  if (call) {
    const body = JSON.parse(call.body);
    check(call.method === 'POST', '方法为 POST');
    check(body.mode === 'smart', 'mode=smart', body.mode);
    check(body.version === 'P2.0', 'version=P2.0', body.version);
    check(body.faceCount === 15000, '面数取连线值 15000（覆盖就地 0）', String(body.faceCount));
    check(body.count === 2, '数量取就地值 2', String(body.count));
    check(body.format === 'glb', '格式取就地值 glb', body.format);
    check(body.timeoutSec === 600, '超时取就地值 600', String(body.timeoutSec));
    check(typeof body.image === 'string' && body.image.length > 100, '参考图已随请求发出', (body.image || '').slice(0, 30) + '…');
  }
  check(stubbed.tmStatus === 'ok', 'tripoModel 执行成功', stubbed.tmStatus + (stubbed.tmErr ? ' · ' + stubbed.tmErr : ''));
  check(/^http:\/\/127\.0\.0\.1:8790\/out\/model_stub\.glb\?t=\d+$/.test(stubbed.tmOut.model || ''), '输出 model 为下载地址', stubbed.tmOut.model);
  check(/网页生成模型完成/.test(stubbed.tmOut.text || ''), '输出 text 为完成说明', stubbed.tmOut.text);
  check(!!(stubbed.rsOut.model || '').length, '结果节点收到 model', (stubbed.rsOut.model || '').slice(0, 40));

  /* ---------- 4. model3d 引擎门禁（独立流程 + 非 Tripo 引擎，零请求） ---------- */
  const apiEngine = await page.evaluate(async (png) => {
    const sel = document.getElementById('genEngine');
    const prev = sel ? sel.value : '';
    if (sel) { sel.value = 'openai'; sel.dispatchEvent(new Event('change')); }
    const before = window.__bridgeCalls.length;
    // 独立流程，只放 start → model3d，避免带上一步的参考图连接
    const flow = { id: 'gate_' + Date.now(), name: '引擎门禁', nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null };
    const s = newNode('start', 0, 0);
    const ii = newNode('imageIn', 0, 200);
    ii.data.image = png; ii.data.fileName = 'ref.png';
    const m = newNode('model3d', 300, 0);
    flow.nodes = [s, ii, m];
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: m.id, key: 'exec' } },
      { id: uid(), from: { node: ii.id, key: 'image' }, to: { node: m.id, key: 'image' } }
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id);
    await runFlow();
    // openFlow 后节点对象可能被替换，从 bp.nodes 取最新引用
    const m2 = bp.nodes.find(n => n.type === 'model3d') || m;
    const r = { status: m2.status, err: m2.error || '', bridgeCalls: window.__bridgeCalls.length - before };
    if (sel && prev) { sel.value = prev; sel.dispatchEvent(new Event('change')); }
    return r;
  }, PNG_1PX);
  console.log('\n=== 4. model3d 引擎门禁 ===');
  check(apiEngine.status === 'error' && /Tripo 引擎/.test(apiEngine.err), '非 Tripo 引擎下给出明确提示', apiEngine.err);
  check(apiEngine.bridgeCalls === 0, '门禁在发请求前生效（零桥调用）', '调用数=' + apiEngine.bridgeCalls);

  console.log('\n错误: ' + errors.length);
  errors.slice(0, 5).forEach(e => console.log('  ' + e));
  check(errors.length === 0, '无页面错误');
  console.log(fails === 0 ? '\n总体: 通过 ✅' : '\n总体: ' + fails + ' 项不符合预期 ❌');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('运行失败：', e); process.exit(1); });
