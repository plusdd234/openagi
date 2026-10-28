// 校验：参数文本域随内容自动增高，字符串完整可见、无滚动框
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';   // 禁止测试写入真实本地存储
const LONG = '分析这张图片的特征，拟写生成灰度正效果\n图提示词，并且把每一处的细节、'
  + '光影层次、材质表现、构图意图都逐条列出来，不要遗漏任何可见元素，'
  + '最后再给出一份可直接用于生图的完整提示词。';

let fails = 0;
function check(ok, name, detail){
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? ' · ' + detail : ''));
  if(!ok) fails++;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  // 建一个含长指令的「分析任务」节点
  const LONG2 = LONG;
  const info = await page.evaluate((text) => {
    const flow = { id: 'ta_' + Date.now(), name: '文本域高度', nodes: [], links: [], vars: [], updated: Date.now(), lastRun: null };
    const s = newNode('start', -420, 0);
    const t = newNode('aiTask', -160, 0);
    t.data.instruction = text;
    flow.nodes = [s, t];
    flow.links = [{ id: uid(), from: { node: s.id, key: 'exec' }, to: { node: t.id, key: 'exec' } }];
    FLOWS.unshift(flow);
    openFlow(flow.id); flushViewSwap();
    return null;
  }, LONG2);
  await page.waitForTimeout(700);

  const m = await page.evaluate(() => {
    const ta = document.querySelector('.node textarea.ctl-textarea');
    if(!ta) return { found:false };
    const cs = getComputedStyle(ta);
    return {
      found:true,
      scrollH: ta.scrollHeight,
      clientH: ta.clientHeight,
      offsetH: ta.offsetHeight,
      styleH: ta.style.height,
      overflowY: cs.overflowY,
      resize: cs.resize,
      rows: ta.rows,
      valueLen: ta.value.length,
      nodeH: ta.closest('.node').offsetHeight,
    };
  });
  check(m.found, '找到分析任务的 instruction 文本域');
  if(m.found){
    check(m.scrollH <= m.clientH + 1, '无滚动（scrollHeight ≤ clientHeight）', 'scroll=' + m.scrollH + ' client=' + m.clientH);
    check(m.overflowY === 'hidden', 'overflow 隐藏滚动框', m.overflowY);
    check(m.resize === 'none', '去掉手动拖拽把手', m.resize);
    check(m.offsetH > 40, '高度已按内容撑开', 'offsetH=' + m.offsetH + 'px / 文本 ' + m.valueLen + ' 字');
  }

  // 追加输入后应继续增高
  const after = await page.evaluate(() => {
    const ta = document.querySelector('.node textarea.ctl-textarea');
    const before = ta.offsetHeight;
    ta.value = ta.value + '\n再补充一条更长的说明文字用于验证自动增高是否随输入实时生效。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: ta.offsetHeight, scrollH: ta.scrollHeight, clientH: ta.clientHeight };
  });
  check(after.after > after.before, '输入后实时增高', after.before + 'px → ' + after.after + 'px');
  check(after.scrollH <= after.clientH + 1, '输入后仍无滚动', 'scroll=' + after.scrollH + ' client=' + after.clientH);

  // 截图
  const el = await page.evaluateHandle(() => {
    const nodes = Array.from(document.querySelectorAll('.node'));
    return nodes.find(n => (n.querySelector('.node-title') || {}).textContent === '分析任务');
  });
  await el.screenshot({ path: path.join(__dirname, '..', 'samples', 'z_textarea_grow.png') });

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));
  await browser.close();
  console.log(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
