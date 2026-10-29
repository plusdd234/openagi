/* 工作流存储隔离与合并体检 —— 全程只打本机 mock 中转，不碰真实存储
 * 1) ?nostore=1：自动化测试页面写入**不会**落到磁盘存储（防止测试污染用户数据）
 * 2) 无参数：正常写入会落盘
 * 3) 两个「源」各存各的流程 → 重新加载后应看到**并集**，而不是后写的覆盖先写的
 * 用法：node plugins/relay/tests/store-isolation.js
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');

const RELAY_PORT = 8901;
const RELAY_BASE = 'http://127.0.0.1:' + RELAY_PORT;
const STORE_FILE = path.join(os.tmpdir(), 'store-isolation-store.json');
const BACKUP_DIR = path.join(os.tmpdir(), 'store-isolation-backups');
// 应用本体在仓库根目录（plugins/relay/ 下只有 relay.js，没有 index.html）
const APP = pathToFileURL(path.join(__dirname, '..', '..', '..', 'index.html')).href;

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const getStore = (key) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: '/store/' + key, method: 'GET' }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
  });
  req.on('error', () => resolve(''));
  req.end();
});

(async () => {
  try { fs.unlinkSync(STORE_FILE); } catch (e) {}
  try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch (e) {}

  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(RELAY_PORT),
      RELAY_STORE_FILE: STORE_FILE,
      RELAY_BACKUP_DIR: BACKUP_DIR,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  relay.stdout.on('data', d => logs.push(d.toString()));
  relay.stderr.on('data', d => logs.push('ERR ' + d.toString()));

  // 等中转就绪
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise(r => setTimeout(r, 200));
    up = !!(await getStore('hf_flows') !== undefined && await new Promise(res => {
      const req = http.get(RELAY_BASE + '/health', r2 => { r2.resume(); r2.on('end', () => res(true)); });
      req.on('error', () => res(false));
    }));
  }
  check(up, '中转已启动');

  const browser = await chromium.launch({ channel: 'msedge' });
  const errors = [];

  const openApp = async (withParam) => {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(APP + (withParam ? '?nostore=1&' : '?') + 'relay=' + encodeURIComponent(RELAY_BASE), { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    return page;
  };
  const writeFlows = (page, list) => page.evaluate((flows) => {
    localStorage.setItem('hf_flows', JSON.stringify(flows));
  }, list);
  const mk = (id, name, updated) => ({ id, name, updated, nodes: [{ id: 'n' + id, type: 'start' }], links: [], vars: [] });

  /* ---------- 1. ?nostore=1 不落盘 ---------- */
  const p1 = await openApp(true);
  await writeFlows(p1, [mk('iso1', '隔离测试流程', 1000)]);
  await p1.waitForTimeout(900);
  const s1 = await getStore('hf_flows');
  check(s1 === '' || s1 === '[]', '?nostore=1 时写入不落到磁盘存储', '磁盘内容长度=' + s1.length);
  await p1.close();

  /* ---------- 2. 正常写入会落盘 ---------- */
  const p2 = await openApp(false);
  await writeFlows(p2, [mk('real1', '正常流程', 2000)]);
  await p2.waitForTimeout(900);
  let disk = [];
  try { disk = JSON.parse(await getStore('hf_flows')); } catch (e) {}
  check(disk.some(f => f.id === 'real1'), '无参数时正常落盘', '磁盘流程数=' + disk.length);
  await p2.close();

  /* ---------- 3. 两个源各写各的 → 重新加载应看到并集 ---------- */
  // 源甲：自己的 localStorage 里只有 A
  const p3 = await openApp(false);
  await p3.evaluate(() => { localStorage.setItem('hf_flows', JSON.stringify([{ id: 'srcA', name: '源甲流程', updated: 3000, nodes: [{ id: 'a1', type: 'start' }], links: [], vars: [] }])); });
  await p3.waitForTimeout(900);
  // 源乙：另一个 localStorage（不同上下文）里只有 B
  const ctx = await browser.newContext();
  const p4 = await ctx.newPage();
  await p4.goto(APP + '?relay=' + encodeURIComponent(RELAY_BASE), { waitUntil: 'load' });
  await p4.waitForTimeout(1200);
  await p4.evaluate(() => { localStorage.setItem('hf_flows', JSON.stringify([{ id: 'srcB', name: '源乙流程', updated: 4000, nodes: [{ id: 'b1', type: 'start' }], links: [], vars: [] }])); });
  await p4.waitForTimeout(900);

  disk = [];
  try { disk = JSON.parse(await getStore('hf_flows')); } catch (e) {}
  check(disk.some(f => f.id === 'srcA') && disk.some(f => f.id === 'srcB'), '两个源各写一次后磁盘上是并集', '磁盘流程=' + disk.map(f => f.id).join(','));

  // 重新加载页面：hydrate 应把磁盘并集合并进本地
  await p4.reload({ waitUntil: 'load' });
  await p4.waitForTimeout(2200);
  const mergedLocal = await p4.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('hf_flows') || '[]').map(f => f.id); } catch (e) { return []; }
  });
  check(mergedLocal.includes('srcA') && mergedLocal.includes('srcB'), '重新加载后本地拿到并集', '本地=' + mergedLocal.join(','));

  /* ---------- 4. 全新环境打开：磁盘上的流程必须出现在界面列表里 ---------- */
  // 这是「重启后工作流不见了」的根本修复点：
  // FLOWS 是在脚本加载时同步读 localStorage 的，而 hydrate 是异步的，
  // 不刷新内存列表的话界面一直是空的，随后一次保存就把空列表写回去。
  const ctx2 = await browser.newContext();          // 全新上下文 = 全新 localStorage
  const p5 = await ctx2.newPage();
  await p5.goto(APP + '?relay=' + encodeURIComponent(RELAY_BASE), { waitUntil: 'load' });
  await p5.waitForTimeout(2600);
  const inMemory = await p5.evaluate(() => {
    try { return (typeof FLOWS !== 'undefined' ? FLOWS : []).map(f => f.id); } catch (e) { return []; }
  });
  check(inMemory.includes('srcA') && inMemory.includes('srcB'), '新环境打开后内存列表含磁盘上的流程', '内存=' + inMemory.join(','));
  const cardCount = await p5.evaluate(() => document.querySelectorAll('#deskSideList .wf-side-item').length);
  check(cardCount >= 2, '界面左侧工作流列表已渲染', '列表项数=' + cardCount);
  await p5.close();
  await ctx2.close();

  /* ---------- 5. 删除一个流程 → 重新加载后别复活（墓碑跨源生效） ---------- */
  // 根因回归：union 合并只增不减，删除的流程因磁盘上还有旧副本而被并回
  // （2026-10-29 用户实测：删一个刷新又恢复）。
  const ctx3 = await browser.newContext();
  const p6 = await ctx3.newPage();
  await p6.goto(APP + '?relay=' + encodeURIComponent(RELAY_BASE), { waitUntil: 'load' });
  await p6.waitForTimeout(1200);
  await p6.evaluate(() => {
    localStorage.setItem('hf_flows', JSON.stringify([
      { id: 'keepA', name: '留着', updated: 5000, nodes: [{ id: 'k1', type: 'start' }], links: [], vars: [] },
      { id: 'delA',  name: '要删', updated: 5000, nodes: [{ id: 'd1', type: 'start' }], links: [], vars: [] }
    ]));
  });
  await p6.waitForTimeout(900);
  await p6.reload({ waitUntil: 'load' });
  await p6.waitForTimeout(2200);
  // 删掉 delA：走与界面一致的删除路径（记录墓碑 + 落盘）
  await p6.evaluate(() => {
    FLOWS = FLOWS.filter(x => x.id !== 'delA');
    if (typeof recordFlowDelete === 'function') recordFlowDelete('delA');
    persistFlows();
  });
  await p6.waitForTimeout(900);
  // 同源重新加载：delA 不该复活（之前这里会复活）
  await p6.reload({ waitUntil: 'load' });
  await p6.waitForTimeout(2200);
  const sameSrc = await p6.evaluate(() => (typeof FLOWS !== 'undefined' ? FLOWS.map(f => f.id) : []));
  check(sameSrc.includes('keepA') && !sameSrc.includes('delA'), '同源删除单个后刷新不复活', 'FLOWS=' + JSON.stringify(sameSrc));
  // 全新源打开：磁盘上的墓碑应当拦住 delA，不被并回
  const ctx4 = await browser.newContext();
  const p7 = await ctx4.newPage();
  await p7.goto(APP + '?relay=' + encodeURIComponent(RELAY_BASE), { waitUntil: 'load' });
  await p7.waitForTimeout(2600);
  const freshSrc = await p7.evaluate(() => (typeof FLOWS !== 'undefined' ? FLOWS.map(f => f.id) : []));
  check(freshSrc.includes('keepA') && !freshSrc.includes('delA'), '新源不会把别处删掉的流程并回来', 'FLOWS=' + JSON.stringify(freshSrc));
  // 磁盘 store 本身也不该再含有 delA
  let diskAfter = [];
  try { diskAfter = JSON.parse(await getStore('hf_flows')); } catch (e) {}
  check(!diskAfter.some(f => f.id === 'delA'), '磁盘 store 已剔除被删流程', 'disk=' + diskAfter.map(f => f.id).join(','));
  await p6.close();
  await ctx3.close();
  await p7.close();
  await ctx4.close();

  /* ---------- 6. 重命名走行内输入（Electron 不支持 prompt()，点了必须出输入框） ---------- */
  const ctx5 = await browser.newContext();
  const p8 = await ctx5.newPage();
  await p8.goto(APP + '?relay=' + encodeURIComponent(RELAY_BASE), { waitUntil: 'load' });
  await p8.waitForTimeout(2600);
  // 点 ⋯ → 菜单 → 重命名：必须原地出现输入框（回归：之前 prompt 在 Electron 里直接抛错、毫无反应）
  const keepItem = p8.locator('#deskSideList .wf-side-item', { hasText: '留着' });
  await keepItem.locator('.wf-side-more').click();
  await p8.locator('.wf-menu button', { hasText: '重命名' }).click();
  const renameInput = p8.locator('#deskSideList .wf-side-rename');
  let renameOk = true;
  try { await renameInput.waitFor({ state: 'visible', timeout: 5000 }); }
  catch (e) { renameOk = false; }
  check(renameOk, '点重命名后原地出现行内输入框');
  if (renameOk) {
    await renameInput.fill('改名后的流程');
    await renameInput.press('Enter');
    await p8.waitForTimeout(900);
    const names = await p8.evaluate(() => (typeof FLOWS !== 'undefined' ? FLOWS : []).map(f => f.name));
    check(names.includes('改名后的流程') && !names.includes('留着'), 'Enter 提交后流程名已更新', 'names=' + names.join(','));
    let diskRenamed = [];
    try { diskRenamed = JSON.parse(await getStore('hf_flows')); } catch (e) {}
    check(diskRenamed.some(f => f.name === '改名后的流程'), '改名同步落到磁盘 store');
    // Esc 取消路径：名字不能变
    const item2 = p8.locator('#deskSideList .wf-side-item', { hasText: '改名后的流程' });
    await item2.locator('.wf-side-more').click();
    await p8.locator('.wf-menu button', { hasText: '重命名' }).click();
    const input2 = p8.locator('#deskSideList .wf-side-rename');
    await input2.waitFor({ state: 'visible', timeout: 5000 });
    await input2.fill('不该生效的名字');
    await input2.press('Escape');
    await p8.waitForTimeout(600);
    const names2 = await p8.evaluate(() => (typeof FLOWS !== 'undefined' ? FLOWS : []).map(f => f.name));
    check(names2.includes('改名后的流程') && !names2.includes('不该生效的名字'), 'Esc 取消不改名', 'names=' + names2.join(','));
  }
  await p8.close();
  await ctx5.close();

  await p4.close();
  await ctx.close();
  await p3.close();
  await browser.close();

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  relay.kill();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
