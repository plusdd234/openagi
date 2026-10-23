/* tripoImg 多参考图体检（全程不触发生成、不消耗积分）
 * 护栏：window.fetch 一律拦截 127.0.0.1:8790（Tripo 网页桥）的真实调用，改为记录并返回合成响应。
 * A. 节点渲染：image / image2 / image3 三个图像输入引脚 + prompt + 执行线
 * B. 请求体：接 3 张 → images 数组 3 项；接 image+image3（跳过 image2）→ 2 项且不插空；接 1 张 → 1 项；不接 → 0 项
 * C. 输出：多图时 text 标注张数
 * D. 桥侧 attachReferences：mock 页面上带 multiple 的 input 一次写入 3 个文件
 * 用法：node tools/tripo-multi-ref.js
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储
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
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  /* ---- 护栏 ---- */
  await page.evaluate(() => {
    window.__bridgeCalls = [];
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/127\.0\.0\.1:8790|localhost:8790/.test(url)) {
        window.__bridgeCalls.push({ url: String(url), body: (init && init.body) || '' });
        return Promise.resolve(new Response(JSON.stringify({
          ok: true, file: 'C:/tmp/out.png', url: 'http://127.0.0.1:8790/out/out.png'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return orig.apply(this, arguments);
    };
  });

  /* ---------- A. 渲染 ---------- */
  const ui = await page.evaluate(() => {
    const flow = { id: 'mr_' + Date.now(), name: '多参考图体检', nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null };
    const s = newNode('start', -320, 0);
    const ti = newNode('tripoImg', 60, 0);
    const rs = newNode('result', 640, 0);
    flow.nodes = [s, ti, rs];
    flow.links = [
      { id: uid(), from: { node: s.id, key: 'exec' }, to: { node: ti.id, key: 'exec' } },
      { id: uid(), from: { node: ti.id, key: 'exec' }, to: { node: rs.id, key: 'exec' } }
    ];
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const el = document.getElementById('n-' + ti.id);
    const pins = d => Array.from(el.querySelectorAll('.pin.' + d)).map(p => ({ key: p.dataset.key, type: p.dataset.type }));
    const labels = Array.from(el.querySelectorAll('.port-label')).map(l => l.textContent.trim());
    return {
      in: pins('in'), out: pins('out'), labels,
      title: ((el.querySelector('.node-title') || {}).textContent || '').trim(),
      def: NODE_DEFS.tripoImg,
    };
  });

  console.log('=== A. 节点渲染 ===');
  check(ui.title === 'Tripo 网页生图', '节点标题正确', ui.title);
  const imgPins = ui.in.filter(p => p.type === 'image');
  check(imgPins.length === 3, '三个图像输入引脚', JSON.stringify(imgPins.map(p => p.key)));
  check(imgPins.map(p => p.key).join(',') === 'image,image2,image3', '引脚键为 image / image2 / image3');
  check(ui.labels.includes('参考图2') && ui.labels.includes('参考图3'), '参考图2 / 参考图3 标签已渲染', JSON.stringify(ui.labels));
  check(ui.def.inputs.join(',') === 'prompt,image,image2,image3', 'NODE_DEFS 声明同步', ui.def.inputs.join(','));

  /* ---------- B/C. 请求体 ---------- */
  const runWith = async (connectKeys) => page.evaluate(async (keys) => {
    // 注意：openFlow 会把流程深拷贝给 bp，运行时只认 bp，必须改 bp 而不是 FLOWS 里的原件
    const ti = bp.nodes.find(n => n.type === 'tripoImg');
    // 清掉旧的数据连线，只保留执行线
    bp.links = bp.links.filter(l => l.from.key === 'exec' || l.to.key === 'exec');
    // 建图像输入节点并连线（每张图内容不同，才能验证顺序不串位）
    const mk = (color) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 8;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 8, 8);
      return cv.toDataURL('image/png');
    };
    const COLORS = ['#e74c3c', '#3498db', '#2ecc71'];
    const srcs = [];
    keys.forEach((k, i) => {
      const img = newNode('imageIn', -60, 200 + srcs.length * 120);
      img.data.image = mk(COLORS[i]);
      srcs.push(img);
      bp.nodes.push(img);
      bp.links.push({ id: uid(), from: { node: img.id, key: 'image' }, to: { node: ti.id, key: k } });
    });
    ti.data.prompt = '测试提示词';
    window.__bridgeCalls = [];
    bp.nodes.forEach(n => { n.out = {}; n.status = ''; n.error = ''; });
    await runFlow();
    const call = window.__bridgeCalls[0] || null;
    let body = null;
    try { body = call ? JSON.parse(call.body) : null; } catch (e) {}
    const out = {
      calls: window.__bridgeCalls.length,
      images: body ? (body.images || []) : null,
      imageField: body ? body.image : null,
      prompt: body ? body.prompt : null,
      status: ti.status,
      error: ti.error || '',
      text: ti.out.text || '',
      imgOut: !!ti.out.image,
    };
    // 清理临时输入节点
    bp.nodes = bp.nodes.filter(n => srcs.indexOf(n) < 0);
    return out;
  }, connectKeys);

  console.log('=== B. 请求体映射 ===');
  const r3 = await runWith(['image', 'image2', 'image3']);
  check(r3.calls === 1, '只发一次请求', 'calls=' + r3.calls);
  check(r3.images && r3.images.length === 3, '3 张参考图 → images 长度 3', JSON.stringify(r3.images && r3.images.length));
  check(r3.imageField && r3.imageField === r3.images[0], 'image 字段为第一张（向后兼容）');
  check(r3.prompt === '测试提示词', '提示词透传', r3.prompt);

  const r2 = await runWith(['image', 'image3']);
  check(r2.images && r2.images.length === 2, '跳过 image2 → images 长度 2（不插空）', JSON.stringify(r2.images && r2.images.length));
  check(r2.images && r2.images[0] !== r2.images[1], '两张图内容不同（未串位）');
  check(r2.images && r2.images[0] && r2.images[0].length > 0, '第一张是 image 引脚来源');
  check(r2.images && r2.images[1] && r2.images[1] !== r2.images[0], '第二张是 image3 引脚来源');

  const r1 = await runWith(['image']);
  check(r1.images && r1.images.length === 1, '只接 1 张 → images 长度 1', JSON.stringify(r1.images && r1.images.length));

  const r0 = await runWith([]);
  check(r0.images && r0.images.length === 0, '不接图 → images 长度 0（文生图）', JSON.stringify(r0.images && r0.images.length));
  check(r0.calls === 1, '不接图也能发请求（文生图）', 'calls=' + r0.calls);

  console.log('=== C. 输出 ===');
  check(r3.imgOut, '图像输出已写入');
  check(/3 张参考图/.test(r3.text), 'text 标注参考图张数', r3.text);
  check(!/张参考图/.test(r1.text), '单图时不加张数后缀', r1.text);

  /* ---------- D. 桥侧 attachReferences（mock 页模拟真实页面行为） ---------- */
  console.log('=== D. 桥侧多文件写入（mock 页） ===');
  const bridge = require(path.join(__dirname, '..', 'tripo-web.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mref-'));
  const pngPath = path.join(tmp, 'a.png');
  fs.writeFileSync(pngPath, Buffer.from(PNG_1PX.split(',')[1], 'base64'));
  // 模拟真实页面：控件带 multiple，change 时把每个文件追加成预览图，然后清空控件
  const mock = '<!doctype html><meta charset="utf-8"><body>'
    + '<input id="f" type="file" accept="image/png,image/webp,image/jpg,image/jpeg" multiple>'
    + '<div id="previews"></div>'
    + '<script>document.getElementById("f").addEventListener("change", e => {'
    + '  Array.from(e.target.files || []).forEach(f => {'
    + '    const img = new Image(); img.src = URL.createObjectURL(f); img.width = 40; img.height = 40;'
    + '    document.getElementById("previews").appendChild(img);'
    + '  });'
    + '  e.target.value = "";'
    + '});</script></body>';
  const mockPath = path.join(tmp, 'mock.html');
  fs.writeFileSync(mockPath, mock);

  const p2 = await browser.newPage();
  await p2.goto(pathToFileURL(mockPath).href, { waitUntil: 'load' });
  const res = await bridge.attachReferences(p2, [pngPath, pngPath, pngPath]);
  const previews = await p2.evaluate(() => document.querySelectorAll('#previews img').length);
  check(res.ok, 'attachReferences 返回成功', JSON.stringify(res));
  check(res.uploaded >= 3, '报告上传 3 张', 'uploaded=' + res.uploaded);
  check(previews === 3, 'mock 页出现 3 个预览图（逐张追加）', 'previews=' + previews);

  // 单张：走原路径
  const p3 = await browser.newPage();
  await p3.goto(pathToFileURL(mockPath).href, { waitUntil: 'load' });
  const res1 = await bridge.attachReferences(p3, [pngPath]);
  const prev1 = await p3.evaluate(() => document.querySelectorAll('#previews img').length);
  check(res1.ok && res1.uploaded === 1 && prev1 === 1, '单张参考图正常', JSON.stringify(res1) + ' previews=' + prev1);

  // 空列表：不报错，返回未上传
  const res0 = await bridge.attachReferences(p3, []);
  check(res0.ok === false && res0.uploaded === 0, '空列表返回未上传', JSON.stringify(res0));

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
