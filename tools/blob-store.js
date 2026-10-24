/* 体检：大块数据外置（localStorage 爆仓 → 图片/模型搬到 IndexedDB）
 * 断言数见末尾统计。零桥、零真实 LLM、零积分。
 * 注意：IndexedDB 在 file:// 下可用，测试用的是临时 profile，每次运行都是干净环境。 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

// 在页面里直接数 IndexedDB 的键（绕开页面自己的缓存，看真实落库情况）
const COUNT_KEYS = `(() => new Promise(res => {
  const q = indexedDB.open('openagi', 1);
  q.onsuccess = () => {
    const db = q.result;
    if(!db.objectStoreNames.contains('blobs')) return res(-1);
    const r = db.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys();
    r.onsuccess = () => res((r.result || []).length);
    r.onerror = () => res(-1);
  };
  q.onerror = () => res(-1);
}))()`;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForFunction(() => window.blobState && window.blobState().loaded, null, { timeout: 8000 });

  const BIG = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);      // 300KB 内联素材
  const HUGE = 'data:image/png;base64,' + 'B'.repeat(1500 * 1024);    // 1.5MB，用来撑爆配额

  console.log('=== 1. 环境 ===');
  const st0 = await page.evaluate(() => window.blobState());
  check('IndexedDB 可用（未退化成内联）', st0.broken === false, JSON.stringify(st0));
  check('启动时已载入库内大块数据', st0.loaded === true);

  console.log('\n=== 2. 保存时外置 ===');
  const r2 = await page.evaluate(big => {
    FLOWS.length = 0;
    FLOWS.push({
      id: 'f1', name: '含大图', updated: Date.now(), lastRun: null, vars: [], links: [],
      nodes: [{ id: 'n1', type: 'imageIn', x: 0, y: 0, data: { image: big } }]
    });
    const ok = persistFlows();
    const raw = localStorage.getItem('hf_flows');
    return { ok, rawLen: raw.length, hasStub: raw.indexOf('blob:') >= 0, hasInline: raw.indexOf(big) >= 0, cached: blobState().cached };
  }, BIG);
  check('保存成功', r2.ok === true);
  check('localStorage 里只剩存根，不再内联大图', r2.hasStub === true && r2.hasInline === false);
  check('写入 localStorage 的体积远小于素材本身', r2.rawLen < 20 * 1024, 'rawLen=' + r2.rawLen);
  check('素材已进入内存缓存', r2.cached >= 1, 'cached=' + r2.cached);

  const keys2 = await page.evaluate(COUNT_KEYS);
  check('素材已落 IndexedDB', keys2 === 1, 'keys=' + keys2);

  console.log('\n=== 3. 内容寻址：重复保存不产生副本 ===');
  await page.evaluate(() => { persistFlows(); persistFlows(); });
  await page.waitForTimeout(200);
  const keys3 = await page.evaluate(COUNT_KEYS);
  check('多次保存后库里仍只有 1 份', keys3 === 1, 'keys=' + keys3);

  console.log('\n=== 4. 重新打开页面后能还原 ===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.blobState && window.blobState().loaded, null, { timeout: 8000 });
  // 注：本机若开着本地中转，hydrate 会把磁盘上的工作流也合并进来，
  // 所以只针对本次写入的 f1 断言，不看总数。
  const r4 = await page.evaluate(big => {
    const f = FLOWS.find(x => x.id === 'f1');
    const img = f && f.nodes[0] && f.nodes[0].data ? f.nodes[0].data.image : '';
    return { found: !!f, same: img === big, len: img.length, isStub: String(img).indexOf('blob:') === 0 };
  }, BIG);
  check('流程仍在', r4.found === true);
  check('图片已还原成完整 data URL（不是存根）', r4.same === true && r4.isStub === false, 'len=' + r4.len);

  console.log('\n=== 5. 导出备份是完整数据 ===');
  const exported = await page.evaluate(() => new Promise(res => {
    // 清空缓存，强制走「等 IndexedDB 载入」这条路径
    BLOB_CACHE.clear();
    // 拦下导出：不能真触发下载（会跳转走、丢执行上下文），只取 Blob 内容
    const origURL = URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = b => { b.text().then(t => { window.__exported = t; }); return 'blob:capture'; };
    HTMLAnchorElement.prototype.click = function(){};
    exportFlows().then(() => {
      URL.createObjectURL = origURL;
      HTMLAnchorElement.prototype.click = origClick;
      setTimeout(() => res(window.__exported || ''), 150);
    });
  }));
  check('导出内容包含完整图片', exported.indexOf(BIG) >= 0, 'len=' + exported.length);
  check('导出内容不含未解析的存根', exported.indexOf('"blob:') < 0);

  console.log('\n=== 6. 删除工作流后回收大块数据 ===');
  await page.waitForTimeout(150);
  const keys6a = await page.evaluate(async big2 => {
    FLOWS.length = 0;
    FLOWS.push(
      { id: 'g1', name: 'A', updated: Date.now(), vars: [], links: [], nodes: [{ id: 'a1', type: 'imageIn', x: 0, y: 0, data: { image: big2 } }] },
      { id: 'g2', name: 'B', updated: Date.now(), vars: [], links: [], nodes: [{ id: 'a2', type: 'imageIn', x: 0, y: 0, data: { image: big2 + 'ZZ' } }] }
    );
    persistFlows();
    await new Promise(r => setTimeout(r, 300));
    const q = indexedDB.open('openagi', 1);
    const before = await new Promise(res => {
      q.onsuccess = () => {
        const r = q.result.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys();
        r.onsuccess = () => res((r.result || []).length); r.onerror = () => res(-1);
      };
      q.onerror = () => res(-1);
    });
    FLOWS = FLOWS.filter(f => f.id !== 'g2');        // 删掉一个
    persistFlows();
    await new Promise(r => setTimeout(r, 400));
    const after = await new Promise(res => {
      const r = q.result.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys();
      r.onsuccess = () => res((r.result || []).length); r.onerror = () => res(-1);
    });
    return { before, after };
  }, BIG);
  check('两张图各自入库', keys6a.before === 2, JSON.stringify(keys6a));
  check('删掉的工作流，它的大块数据被回收', keys6a.after === 1, JSON.stringify(keys6a));

  console.log('\n=== 7. IndexedDB 不可用时不外置（绝不丢数据）===');
  const r7 = await page.evaluate(big => {
    blobDisable();
    FLOWS.length = 0;
    FLOWS.push({
      id: 'f2', name: '降级', updated: Date.now(), vars: [], links: [],
      nodes: [{ id: 'n2', type: 'imageIn', x: 0, y: 0, data: { image: big } }]
    });
    const ok = persistFlows();
    const raw = localStorage.getItem('hf_flows');
    return { ok, hasStub: raw.indexOf('blob:') >= 0, hasInline: raw.indexOf(big) >= 0 };
  }, BIG);
  check('保存仍然成功', r7.ok === true);
  check('退回内联，不留下无法解析的存根', r7.hasInline === true && r7.hasStub === false);

  console.log('\n=== 8. 配额见底时的救援（保住当前工作流）===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.blobState && window.blobState().loaded, null, { timeout: 8000 });
  const r8 = await page.evaluate(huge => {
    blobDisable();                                   // 关掉外置，模拟最坏情况
    localStorage.clear();
    const chunk = 'x'.repeat(256 * 1024);
    let i = 0;
    try { for (; i < 40; i++) localStorage.setItem('__junk' + i, chunk); } catch (e) {}
    for (let k = 0; k < 8; k++) localStorage.removeItem('__junk' + k);   // 腾出约 2MB：够放一个工作流
    const mk = (id, name) => ({
      id, name, updated: Date.now(), vars: [], links: [],
      nodes: [{ id: 'n' + id, type: 'imageIn', x: 0, y: 0, data: { image: huge } }]
    });
    FLOWS.length = 0;
    FLOWS.push(mk('cur', '当前编辑'), mk('old', '旧工作流'));
    openFlow('cur');                                 // 当前编辑的流程必须保住
    const ok = persistFlows();
    const cur = FLOWS.find(f => f.id === 'cur');
    const old = FLOWS.find(f => f.id === 'old');
    return {
      ok,
      junk: i,
      curKept: cur.nodes[0].data.image === huge,
      oldStripped: old.nodes[0].data.image === '' && old._stripped === true,
      toast: ($('bpToast').textContent || '')
    };
  }, HUGE);
  check('空间已满时保存仍然成功（清理非当前工作流）', r8.ok === true, JSON.stringify(r8));
  check('当前编辑的工作流素材完好', r8.curKept === true);
  check('被清理的工作流打了标记，界面上能看出来', r8.oldStripped === true);
  check('提示说明了清理动作', /清理/.test(r8.toast), 'toast=' + r8.toast);

  console.log('\n=== 8b. 只剩当前工作流时，宁可丢素材也要保住流程本身 ===');
  const r8b = await page.evaluate(huge => {
    blobDisable();
    localStorage.clear();
    const chunk = 'x'.repeat(256 * 1024);
    try { for (let i = 0; i < 40; i++) localStorage.setItem('__junk' + i, chunk); } catch (e) {}
    FLOWS.length = 0;
    FLOWS.push({
      id: 'solo', name: '唯一', updated: Date.now(), vars: [], links: [],
      nodes: [{ id: 'ns', type: 'imageIn', x: 0, y: 0, data: { image: huge } }]
    });
    openFlow('solo');
    const ok = persistFlows();
    const f = FLOWS[0];
    return {
      ok, saved: !!JSON.parse(localStorage.getItem('hf_flows') || '[]').find(x => x.id === 'solo'),
      imgGone: f.nodes[0].data.image === '', stripped: f._stripped === true,
      toast: ($('bpToast').textContent || '')
    };
  }, HUGE);
  check('保存成功，工作流结构保住了', r8b.ok === true && r8b.saved === true, JSON.stringify(r8b));
  check('素材被清空并打标记（可重新上传）', r8b.imgGone === true && r8b.stripped === true);
  check('提示说明了当前工作流也被清理', /清空/.test(r8b.toast), 'toast=' + r8b.toast);

  console.log('\n=== 9. 实在放不下时明确报错，不乱写 ===');
  const r9 = await page.evaluate(() => {
    blobDisable();
    localStorage.clear();
    const chunk = 'x'.repeat(256 * 1024);
    let i = 0;
    try { for (; i < 40; i++) localStorage.setItem('__junk' + i, chunk); } catch (e) {}
    // 用海量短字段撑出一个「清不掉」的超大工作流结构（单条都够不上外置阈值，无法被清理）
    const nodes = [];
    for (let k = 0; k < 400; k++) nodes.push({ id: 'n' + k, type: 'imageIn', x: (k % 30) * 10, y: k * 2, data: { text: 'x'.repeat(1600) } });
    FLOWS.length = 0;
    FLOWS.push({ id: 'fat', name: '巨型', updated: Date.now(), vars: [], links: [], nodes });
    openFlow('fat');
    const ok = persistFlows();
    return { ok, toast: ($('bpToast').textContent || '') };
  });
  check('无法救援时返回失败', r9.ok === false);
  check('报错给出可操作的下一步（导出备份 / 删除）', /导出备份/.test(r9.toast), 'toast=' + r9.toast);

  console.log('\n=== 10. 上传压缩 ===');
  const r10 = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 3000; cv.height = 2000;
    const c = cv.getContext('2d');
    for (let i = 0; i < 400; i++) { c.fillStyle = 'hsl(' + (i * 7 % 360) + ',70%,' + (30 + i % 50) + '%)'; c.fillRect((i * 137) % 3000, (i * 91) % 2000, 160, 120); }
    const orig = cv.toDataURL('image/png');
    const out = await shrinkImageDataUrl(orig);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = out; });
    return { origLen: orig.length, outLen: out.length, w: img.naturalWidth, h: img.naturalHeight, head: out.slice(0, 22) };
  });
  check('压缩后明显变小', r10.outLen < r10.origLen * 0.6, r10.origLen + ' → ' + r10.outLen);
  check('长边压到 1600 以内', Math.max(r10.w, r10.h) <= 1600, r10.w + 'x' + r10.h);
  check('输出仍是合法图片', /^data:image\//.test(r10.head), r10.head);

  console.log('\n=== 11. 界面上的容量提示 ===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.blobState && window.blobState().loaded, null, { timeout: 8000 });
  const r11 = await page.evaluate(big => {
    FLOWS.length = 0;
    FLOWS.push({
      id: 'f3', name: '容量', updated: Date.now(), vars: [], links: [],
      nodes: [{ id: 'n3', type: 'imageIn', x: 0, y: 0, data: { image: big } }]
    });
    persistFlows();
    renderFlowsWindow();
    const meter = $('wfStorage');
    const card = Array.from(document.querySelectorAll('.wf-card')).find(c => (c.textContent || '').indexOf('容量') >= 0);
    return {
      label: (meter ? meter.textContent : ''),
      hidden: meter ? meter.classList.contains('hidden') : true,
      badge: card ? (card.querySelector('.wf-size') || {}).textContent : ''
    };
  }, BIG);
  check('存储条给出了用量', /内联素材/.test(r11.label) && /MB|KB/.test(r11.label), 'label=' + r11.label);
  check('有流程时存储条可见', r11.hidden === false);
  check('卡片上标出了该工作流的占用', /KB|MB/.test(r11.badge || ''), 'badge=' + r11.badge);

  console.log('\n=== 12. 打开时数据还没进内存，用之前能还原 ===');
  const r12 = await page.evaluate(big => new Promise(res => {
    // 模拟刚打开页面：库里有数据，但内存缓存是空的（blobReload 就是这条路径）
    const id = blobIdFor(big);
    localStorage.setItem('hf_flows', JSON.stringify([{
      id: 'f4', name: '待还原', updated: Date.now(), vars: [], links: [],
      nodes: [{ id: 'n4', type: 'imageIn', x: 0, y: 0, data: { image: 'blob:' + id } }]
    }]));
    FLOWS = JSON.parse(localStorage.getItem('hf_flows'));
    blobReload();
    openFlow('f4');
    const before = bp.nodes[0].data.image;
    // 走真实路径：运行前会先把存根还原（这个流程没有「任务开始」节点，运行本身不会产生任何请求）
    runFlow().then(() => {
      const after = bp.nodes[0].data.image;
      res({ before, after: after === big, missing: blobMissing([bp]), len: String(after).length });
    });
  }), BIG);
  check('载入前是存根', r12.before.indexOf('blob:') === 0, 'before=' + r12.before);
  check('载入后还原成真实数据', r12.after === true && r12.missing === 0, 'len=' + r12.len + ' missing=' + r12.missing);

  console.log('\n=== 页面错误 ===');
  const fatal = errors.filter(e => /ReferenceError|is not defined|is not a function/.test(e));
  check('无致命脚本错误', fatal.length === 0, fatal.join(' | '));

  console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
