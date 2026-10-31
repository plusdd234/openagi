/* 生成「参考图 → 参数化建模」直线工作流（v1：只跑通，不做自动复核）
 *
 * 用脚本生成而不是手写 JSON：节点 data 的形状由 seedNodeData 决定，
 * 手写迟早漂移；这里用页面里的 newNode + validateFlow 保证格式和当前代码一致。
 *
 * 为什么 v1 里没有「复核 → 分支 → 改规格重跑」：
 *   截图给模型看只能得到「头身比失调」这种模糊评语，改多少全靠猜。
 *   精确的观察手段是 tools/match-ref.js（剪影对图：IoU + 逐高度带宽度差），
 *   等这条直线跑通了，再把对图接入流程做自动调整。
 *
 * 用法：node tools/make-flow-ref-model.js [输出路径]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const OUT = process.argv[2] || path.join(__dirname, '..', 'flow-参考图建模-v1.json');
const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof newNode === 'function' && typeof validateFlow === 'function' && typeof Modeler !== 'undefined', null, { timeout: 15000 });

  const flow = await page.evaluate(() => {
    const n = (type, x, y) => {
      const v = newNode(type, x, y);
      v.id = type + '_' + Math.random().toString(36).slice(2, 7);
      return v;
    };
    const link = (a, ap, b, bp) => ({ from: { node: a.id, key: ap }, to: { node: b.id, key: bp } });

    const start = n('start', -1600, 60);
    start.params = [
      { id: 'p_struct', name: '结构参考', type: 'image', value: '', fileName: '' },
      { id: 'p_color', name: '着色参考', type: 'image', value: '', fileName: '' }
    ];
    const iStruct = n('imageIn', -1600, 260);
    const iColor = n('imageIn', -1600, 460);

    /* 规格：AI 只出数据，几何交给 Modeler 确定性地搭 */
    const spec = n('aiTask', -1300, 140);
    spec.data.instruction = [
      '你是三维建模师。输入两张参考图：结构参考（形体 / 比例 / 剪影）、着色参考（配色 / 材质）。',
      '请输出**参数化建模规格 JSON**，不要输出任何解释文字。',
      '规则：',
      '1) 只能用这些 shape：' + Modeler.SHAPES.join(' / ') + '；',
      '2) 全部以米为单位，height 填你估计的总身高（人形一般 1.5~1.75）；',
      '3) 左右对称的部件只写一个，加 "mirror":"x"（不要自己复制两份）；',
      '4) 重复出现的小件（褶皱、鞋带孔、发束）用 repeat{count,offset}；',
      '5) 每个部件都要 color，主色取自着色参考；',
      '6) 先大形（头/躯干/四肢）再细节，部件总数不超过 60；',
      '6b) **曲线曲面优先**：头发束 / 卷发 / 飘带 / 手指 / 绑绳用 tube 沿曲线扫掠；',
      '    腿 / 靴筒 / 杯形裙摆用 lathe；躯干 / 裙子用 loft 放样。不要用一堆球和胶囊去「近似」曲线。',
      '7) 尺寸按身高比例对齐参考图：头顶=height、下巴≈0.87h、肩≈0.82h、',
      '    腰≈0.62h、臀≈0.55h、膝≈0.28h、脚踝≈0.05h。',
      '规格格式：',
      Modeler.schemaHelp()
    ].join('\n');
    spec.data.timeout = 300;
    spec.data.inputs = [
      { id: 'in_struct', name: '结构参考', type: 'image' },
      { id: 'in_color', name: '着色参考', type: 'image' }
    ];
    spec.data.outputs = [
      { id: 'out_spec', name: '建模规格', type: 'string' },
      { id: 'out_note', name: '要点', type: 'string' }
    ];

    const build = n('modelBuild', -960, 140);
    build.data.spec = '';
    build.data.height = 1.6;

    const views = n('modelViews', -640, 140);
    const out = n('result', -340, 140);

    const nodes = [start, iStruct, iColor, spec, build, views, out];
    const links = [
      link(start, 'exec', spec, 'exec'),
      link(spec, 'exec', build, 'exec'),
      link(build, 'exec', views, 'exec'),
      link(views, 'exec', out, 'exec'),
      link(iStruct, 'image', spec, 'in_struct'),
      link(iColor, 'image', spec, 'in_color'),
      link(spec, 'out_spec', build, 'spec'),
      link(build, 'model', views, 'model'),
      link(views, 'image', out, 'image'),
      link(build, 'model', out, 'model'),
      link(spec, 'out_note', out, 'text')
    ];

    const f = {
      id: 'flow_ref_model_v1_' + Date.now().toString(36),
      name: '参考图建模 v1（参数化 · 免 Tripo · 先跑通）',
      updated: Date.now(),
      lastRun: null,
      vars: [],
      frames: [],
      nodes,
      links
    };
    return { flow: f, check: validateFlow(f) };
  });

  fs.writeFileSync(OUT, JSON.stringify({ 0: flow.flow }, null, 1), 'utf8');
  console.log('→ ' + OUT);
  console.log('节点 ' + flow.flow.nodes.length + ' / 连线 ' + flow.flow.links.length);
  console.log('校验：' + (flow.check.ok ? '通过' : '失败'));
  (flow.check.errors || []).forEach(e => console.log('  ✗ ' + e.nodeLabel + ' ' + e.message));
  (flow.check.warnings || []).forEach(w => console.log('  ! ' + w.nodeLabel + ' ' + w.message));
  if (errors.length) console.log('页面错误：' + errors.join(' | '));
  await browser.close();
  if (!flow.check.ok) process.exit(1);
})();
