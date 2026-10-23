/* 真实鼠标拖线验证：数值节点各输出引脚能否连到对应类型的输入引脚
 * 同时验证「分析任务」自定义引脚（新加的真实 pin）可拖可连
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const setup = await page.evaluate(() => {
    const nv = newNode('numNode', 60, 80);  nv.data.value = 2.5;
    const at = newNode('aiTask', 400, 60);
    const mv = newNode('modelViews', 400, 420);
    const ic = newNode('imageCompress', 60, 420);
    const flow = { id: 'drag_' + Date.now(), name: '拖线验证', nodes: [nv, at, mv, ic], links: [], vars: [], updated: Date.now() };
    FLOWS.unshift(flow);
    openFlow(flow.id);
    const id = nid => nid;
    window.__ids = {
      nv: nv.id, at: at.id, mv: mv.id, ic: ic.id,
      atIn: at.data.inputs[0].id,
      mvGap: mv.data.params.find(p => p.name === '间距').id,
      mvW:   mv.data.params.find(p => p.name === '线宽').id
    };
    return window.__ids;
  });

  const pinCenter = async (nodeId, dir, key) => {
    const box = await page.locator(`#n-${nodeId} .pin[data-dir="${dir}"][data-key="${key}"]`).first().boundingBox();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  };

  const drag = async (from, to, label) => {
    const a = await pinCenter(from.node, 'out', from.key);
    const b = await pinCenter(to.node, 'in', to.key);
    if (!a || !b) return { label, ok: false, why: '找不到引脚 DOM' };
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const res = await page.evaluate(([fn, tk]) => {
      const hit = bp.links.find(l => l.from.node === fn.node && l.from.key === fn.key && l.to.node === tk.node && l.to.key === tk.key);
      const toast = document.getElementById('bpToast');
      return { linked: !!hit, toast: toast && !toast.classList.contains('hidden') ? toast.textContent : '' };
    }, [from, to]);
    return { label, ok: res.linked, why: res.linked ? '' : ('未建立连线' + (res.toast ? '（提示：' + res.toast + '）' : '')) };
  };

  const results = [];
  results.push(await drag({ node: setup.nv, key: 'int' },   { node: setup.mv, key: setup.mvGap }, '数值.int → 四视图.间距(int)'));
  results.push(await drag({ node: setup.nv, key: 'float' }, { node: setup.mv, key: setup.mvW },  '数值.float → 四视图.线宽(float)'));
  results.push(await drag({ node: setup.nv, key: 'int' },   { node: setup.ic, key: 'maxEdge' },     '数值.int → 压缩.最长边(int)'));
  results.push(await drag({ node: setup.nv, key: 'float' }, { node: setup.at, key: setup.atIn },    '数值.float → 分析任务.自定义引脚(string)，类型不符应拒绝'));

  // 把自定义引脚改成 image 后，应当可以正常连上（验证自定义 pin 真的可拖可连）
  await page.evaluate(([at, atImg]) => {
    const n = bp.nodes.find(x => x.id === at);
    n.data.inputs[0].type = 'image';
    n.data.inputs[0].id = atImg;
    renderNodes();
  }, [setup.at, setup.atIn]);
  await page.waitForTimeout(200);
  results.push(await drag({ node: setup.mv, key: 'image' }, { node: setup.at, key: setup.atIn },    '四视图.image → 分析任务.自定义引脚(image)'));

  console.log('=== 拖线结果 ===');
  results.forEach(r => console.log(` ${r.ok ? '✅' : '❌'} ${r.label}${r.why ? ' · ' + r.why : ''}`));
  const pass = results[0].ok && results[1].ok && results[2].ok && !results[3].ok && results[4].ok;
  console.log(' 判定: ' + (pass ? '符合预期 ✅' : '存在异常 ❌'));

  const info = await page.evaluate(() => ({
    links: bp.links.map(l => l.from.node.slice(0, 3) + '.' + l.from.key.slice(0, 3) + ' → ' + l.to.node.slice(0, 3) + '.' + l.to.key.slice(0, 3)),
    dashed: document.querySelectorAll('#bpLinks path').length
  }));
  console.log('\n当前连线数: ' + info.links.length + ' · SVG 线段数: ' + info.dashed);

  await page.screenshot({ path: path.join(__dirname, '..', 'samples', 'pin_drag.png') });
  console.log('\n错误: ' + errors.length);
  errors.forEach(e => console.log(' - ' + e));
  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(2); });
