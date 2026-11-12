/* 编码 App 的界面冒烟测试（Electron + Playwright）
 *
 * 目的：不是测样式好不好看，是测**这条链路真的通**：
 *   窗口存在 → 骨架能画出来 → 主进程 code:info 能应答 → 文件树能渲染 → 能打开一个文件。
 *
 * 为什么必须用真 Electron：code* 全部走 preload 的 contextBridge，
 * 换成浏览器打开 index.html 时 window.openagiDesktop 根本不存在，
 * 那样测出来的"通过"是假的（只会走降级分支）。
 *
 * 跑法：node tools/test-code-ui.mjs
 */
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOT = path.join(ROOT, 'docs', 'code-app-smoke.png');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if(c){ pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (extra ? ' — ' + extra : '')); }
};

// 造一个假工作区，避免碰用户真实目录
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ogcode-ui-'));
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.writeFileSync(path.join(ws, 'README.md'), '# demo\nhello\n', 'utf8');
fs.writeFileSync(path.join(ws, 'src', 'main.js'), 'export function hi(){\n  return 1;\n}\n', 'utf8');

/* ⚠ 环境里可能带着 ELECTRON_RUN_AS_NODE=1（某些终端/沙箱会设），
 * 那样 Electron 会以纯 Node 模式跑，protocol / BrowserWindow 全是 undefined，
 * 表现是「Process failed to launch!」这种看不出根因的错。必须先删掉。 */
const ENV = { ...process.env, OPENAGI_TEST: '1' };
delete ENV.ELECTRON_RUN_AS_NODE;

/* 独立的 userData：
 *   ① 主进程有 requestSingleInstanceLock，用户自己开着 App 时第二个实例会**静默退出**
 *      —— 表现就是这里 "Target page has been closed"，看不出是单实例锁在挡。
 *      锁是按 userData 目录分的，换一个目录就互不干扰。
 *   ② 测试会调 code:set-root，共用 userData 会把用户的工作区指到临时目录去，
 *      跑完虽然会还原，但中途崩溃就留在那儿了。 */
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ogcode-ud-'));

const app = await electron.launch({
  args: [ROOT, '--user-data-dir=' + USERDATA],
  cwd: ROOT,
  env: ENV,
  timeout: 60000
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  /* 收集控制台错误。「页面能跑」和「页面没报错」是两件事 ——
   * 一个 null 解引用可以只让某个按钮失灵，而所有断言照样绿。 */
  const consoleErrors = [];
  page.on('console', m => { if(m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  // 桌面壳要跑完一轮脚本才注册好 App 列表
  await page.waitForFunction(() => typeof window.codeApp !== 'undefined', null, { timeout: 20000 });
  console.log('\n=== 1. 注册 ===');
  ok(await page.evaluate(() => !!document.getElementById('codeWin')), 'codeWin 窗口存在于 DOM');
  ok(await page.evaluate(() => typeof DESK_APP_META !== 'undefined' && !!DESK_APP_META.code), 'DESK_APP_META 有 code');
  ok(await page.evaluate(() => DESK_APPS.some(a => a.id === 'code')), 'DESK_APPS 里有 code 项');
  ok(await page.evaluate(() => {
    const a = DESK_APPS.find(x => x.id === 'code');
    return !!a && a.glyph === 'code' && typeof a.open === 'function';
  }), '图标与 open 都已接上');
  ok(await page.evaluate(() => !!DESK_GLYPH.code), 'DESK_GLYPH 有 code 图标');

  console.log('\n=== 2. preload 接口 ===');
  const apiKeys = await page.evaluate(() => {
    const d = window.openagiDesktop || {};
    return ['codeInfo','codePickDir','codeClear','codeList','codeTree','codeRead','codeWrite','codeSearch','codeReveal','codeSetRoot',
      'codeRun','codeRunCancel','codeRunStatus','onCodeRunOutput',
      'codePutBin','codeExists','codeOpenExternal','codePreviewUrl']
      .filter(k => typeof d[k] === 'function');
  });
  ok(apiKeys.length === 18, '十八个 code* 接口都暴露了', '缺 ' + (18 - apiKeys.length) + ' 个');

  console.log('\n=== 3. 打开 App（走真实入口 openDeskApp） ===');
  const setRes = await page.evaluate(async () => {
    const before = await window.openagiDesktop.codeInfo();
    return { before };
  });
  ok(setRes.before && setRes.before.ready === false, '尚未选目录时 info.ready 为 false（干净初始态）');

  /* 必须走 openDeskApp 而不是手动 remove('hidden')：
   * 真实入口会把窗口搬进 #deskAppHost 并铺满（inset:0），
   * 手动显示的话窗口留在桌面浮窗态，高度按内容撑 —— 全 flex 的内容会塌成一条线，
   * 那测出来的是"假失败"，反而会误导人去改 CSS。 */
  const opened = await page.evaluate(async () => {
    openDeskApp('code');
    await new Promise(r => setTimeout(r, 1500));   // 翻页 + 模块 open + 骨架撤
    const w = document.getElementById('codeWin');
    return {
      host: w.parentElement ? w.parentElement.id : '',
      loading: w.classList.contains('app-loading'),
      hasPick: !!document.getElementById('caPick')
    };
  });
  ok(opened.host === 'deskAppHost', '窗口已搬进 App 页宿主', opened.host);
  ok(opened.hasPick === true, '骨架已渲染（按钮在）');
  ok(opened.loading === false, '加载骨架已撤（模块画出了内容）');

  const built = await page.evaluate(() => ({
    ta: !!document.getElementById('caTa'),
    root: (document.getElementById('caRoot') || {}).textContent || ''
  }));
  ok(built.ta, '编辑器已就位');
  ok(built.root === '未选择', '未选目录时显示「未选择」', built.root);

  // [hidden] 会被显式 display 覆盖，这条专门盯那个坑
  const modes = await page.evaluate(() => {
    const tree = document.getElementById('caTree');
    const sbox = document.getElementById('caSearchBox');
    const vis = n => !!(n && n.getClientRects().length > 0);
    const before = { tree: vis(tree), search: vis(sbox) };
    document.getElementById('caModeSearch').click();
    const after = { tree: vis(tree), search: vis(sbox) };
    document.getElementById('caModeTree').click();
    return { before, after };
  });
  ok(modes.before.tree === true && modes.before.search === false, '默认只显示文件树（搜索框确实隐藏）', JSON.stringify(modes.before));
  ok(modes.after.tree === false && modes.after.search === true, '切到搜索时树隐藏、搜索框出现', JSON.stringify(modes.after));

  console.log('\n=== 4. 布局不塌 ===');
  const box = await page.evaluate(() => {
    const w = document.getElementById('codeWin');
    const q = s => w.querySelector(s);
    const r = n => n ? n.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      win: r(w), body: r(q('.os-win-body')), edit: r(document.getElementById('caEdit')),
      side: r(q('.ca-side')), gutter: r(document.getElementById('caGutter')),
      host: r(document.getElementById('deskAppHost'))
    };
  });
  ok(box.body.height > 300, '主体有实际高度', String(Math.round(box.body.height)));
  ok(box.edit.height > 200, '编辑区没塌成一条线', String(Math.round(box.edit.height)));
  ok(box.side.width > 100, '侧栏宽度正常', String(box.side.width));
  ok(box.gutter.width > 20, '行号栏有宽度', String(box.gutter.width));
  ok(Math.abs(box.win.height - box.host.height) < 40, '窗口铺满 App 页', Math.round(box.win.height) + ' vs ' + Math.round(box.host.height));

  console.log('\n=== 5. 行号与正文对齐 ===');
  const align = await page.evaluate(() => {
    const g = document.getElementById('caGutter');
    const ta = document.getElementById('caTa');
    const gs = getComputedStyle(g), ts = getComputedStyle(ta);
    return {
      gh: gs.lineHeight, th: ts.lineHeight,
      gp: gs.paddingTop, tp: ts.paddingTop,
      gf: gs.fontSize, tf: ts.fontSize
    };
  });
  ok(align.gh === align.th, '行高一致', align.gh + ' vs ' + align.th);
  ok(align.gp === align.tp, 'padding-top 一致（否则滚到后面会错半行）', align.gp + ' vs ' + align.tp);
  ok(align.gf === align.tf, '字号一致', align.gf + ' vs ' + align.tf);

  console.log('\n=== 6. 文件树渲染（注入假数据，不碰真实磁盘） ===');
  const tree = await page.evaluate(() => {
    const st = window.codeApp.state;
    st.ready = true; st.root = 'C:/demo'; st.name = 'demo';
    st.kids.clear(); st.expanded.clear();
    st.kids.set('', [
      { name: 'src', dir: true, size: 0, mtime: 0, heavy: false },
      { name: 'node_modules', dir: true, size: 0, mtime: 0, heavy: true },
      { name: 'README.md', dir: false, size: 42, mtime: 0, heavy: false }
    ]);
    st.kids.set('src', [
      { name: 'main.js', dir: false, size: 30, mtime: 0, heavy: false }
    ]);
    st.expanded.add('src');
    window.codeApp._render.tree();
    const rows = [...document.querySelectorAll('#caTree .ca-row')];
    return {
      names: rows.map(r => r.querySelector('.ca-name').textContent),
      pads: rows.map(r => parseInt(r.style.paddingLeft, 10)),
      heavyCls: !!document.querySelector('#caTree .ca-row.is-heavy'),
      carets: rows.map(r => r.querySelector('.ca-caret').textContent)
    };
  });
  ok(tree.names.length === 4, '根 + 展开的 src 共 4 行', JSON.stringify(tree.names));
  ok(tree.names[0] === 'src' && tree.names[1] === 'main.js', '子项排在父项之后（树序正确）', JSON.stringify(tree.names));
  ok(tree.pads[1] > tree.pads[0], '子层缩进比父层大', tree.pads.join(','));
  ok(tree.heavyCls === true, 'node_modules 带 heavy 标记（默认折叠）');
  ok(tree.carets[0] === '▾' && tree.carets[1] === '', '展开的目录有开箭头，文件没有', JSON.stringify(tree.carets));

  // 点击目录折叠
  const collapsed = await page.evaluate(() => {
    const row = document.querySelector('#caTree .ca-row.is-dir');
    row.click();
    return [...document.querySelectorAll('#caTree .ca-row')].map(r => r.querySelector('.ca-name').textContent);
  });
  ok(collapsed.length === 3 && collapsed.indexOf('main.js') < 0, '点目录能折叠（子项消失）', JSON.stringify(collapsed));

  // 转义：文件名里的尖括号不能变成 HTML
  const escaped = await page.evaluate(() => {
    const st = window.codeApp.state;
    st.kids.set('', [{ name: '<img src=x onerror=alert(1)>.js', dir: false, size: 1, mtime: 0, heavy: false }]);
    st.expanded.clear();
    window.codeApp._render.tree();
    const row = document.querySelector('#caTree .ca-row');
    return { text: row.querySelector('.ca-name').textContent, imgs: document.querySelectorAll('#caTree img').length };
  });
  ok(escaped.imgs === 0, '恶意文件名没有注入成真实节点');
  ok(escaped.text.indexOf('<img') === 0, '恶意文件名按纯文本显示', escaped.text);

  console.log('\n=== 7. 编辑器内容与行号 ===');
  const ed = await page.evaluate(() => {
    const st = window.codeApp.state;
    st.file = { rel: 'src/main.js', text: 'line1\nline2\nline3', sha: 'x', dirty: false, eol: '\n' };
    window.codeApp._render.editor();
    const ta = document.getElementById('caTa');
    const g = document.getElementById('caGutter');
    return {
      disabled: ta.disabled,
      value: ta.value,
      lines: g.textContent.trim().split('\n').length,
      gutterLast: g.textContent.trim().split('\n').pop(),
      tabName: document.getElementById('caTabName').textContent,
      saveDisabled: document.getElementById('caSave').disabled
    };
  });
  ok(ed.disabled === false, '打开文件后编辑器可编辑');
  ok(ed.value.split('\n').length === 3, '内容完整灌进 textarea');
  ok(ed.lines === 3 && ed.gutterLast === '3', '行号数量与行数一致', ed.lines + ' 行，末号 ' + ed.gutterLast);
  ok(ed.tabName === 'src/main.js', '标签显示相对路径');
  ok(ed.saveDisabled === true, '未改动时保存按钮是禁用的');

  console.log('\n=== 8. 编码助手：挂上真实工作区 ===');
  /* 应用内选目录会弹系统对话框，自动化点不了 —— 走只在 OPENAGI_TEST 下存在的 codeSetRoot。
   * 先记下用户原本的工作区，测试结束要还回去（否则人家一开 App 发现工作区被换了）。 */
  const prevRoot = await page.evaluate(async () => {
    const i = await window.openagiDesktop.codeInfo();
    return i && i.ready ? i.root : '';
  });

  const wsSetup = await page.evaluate(async d => {
    const info = await window.openagiDesktop.codeSetRoot(d);
    const st = window.codeApp.state;
    st.root = info.root; st.name = info.name; st.ready = true;
    await window.codeApp.open();       // 走真实入口：重新读 info + reloadTree
    return { root: info.root, name: info.name, ready: info.ready, file: st.file };
  }, ws);
  ok(wsSetup.ready === true, '工作区已挂上', wsSetup.root);
  ok(wsSetup.name === path.basename(ws), '工作区名取目录名', wsSetup.name);
  ok(wsSetup.file === null, 'open() 之后没有残留的上一个文件（第 7 节的假数据已被清掉）');

  const ag = await page.evaluate(() => {
    const r = n => n ? n.getBoundingClientRect() : { width: 0, height: 0 };
    const body = document.getElementById('caBody');
    const el = document.getElementById('caAgent');
    return {
      mounted: !!el,
      hasLog: !!document.getElementById('caAgLog'),
      hasInput: !!document.getElementById('caAgInput'),
      hasSend: !!document.getElementById('caAgSend'),
      welcome: (document.getElementById('caAgLog') || {}).textContent || '',
      agW: r(el).width, agH: r(el).height,
      mainW: r(body.querySelector('.ca-main')).width,
      sideW: r(body.querySelector('.ca-side')).width,
      bodyW: r(body).width,
      bodyH: r(body).height
    };
  });
  ok(ag.mounted && ag.hasLog && ag.hasInput && ag.hasSend, '助手面板已挂载（日志/输入/发送都在）');
  ok(ag.welcome.indexOf('说明要做什么') >= 0, '首次进入有引导文案');
  ok(ag.agW > 220, '助手栏有宽度', String(Math.round(ag.agW)));
  ok(ag.agH > 200, '助手栏有高度（没塌）', String(Math.round(ag.agH)));
  ok(ag.mainW > 200, '编辑区没被挤没', String(Math.round(ag.mainW)));
  ok(ag.sideW > 100, '文件树侧栏还在', String(Math.round(ag.sideW)));
  ok(Math.abs(ag.agW + ag.mainW + ag.sideW - ag.bodyW) < 4,
    '三栏宽度加起来等于容器（没有横向溢出）',
    [ag.sideW, ag.mainW, ag.agW].map(Math.round).join('+') + ' vs ' + Math.round(ag.bodyW));

  console.log('\n=== 9. 助手工具：读 ===');
  const treeRes = await page.evaluate(() => window.CodeAgent._runTool('ws_tree', { depth: 3 }, {}));
  ok(treeRes && typeof treeRes.tree === 'string', 'ws_tree 有返回');
  ok(/src\//.test(treeRes.tree), 'ws_tree 看得到 src/ 目录', String(treeRes.tree).slice(0, 40));
  ok(treeRes.entries > 0, 'ws_tree 报了条目数', String(treeRes.entries));

  const readRes = await page.evaluate(() => window.CodeAgent._runTool('ws_read', { path: 'src/main.js' }, {}));
  ok(readRes && readRes.total_lines >= 3, 'ws_read 读到行数', String(readRes.total_lines));
  ok(/^\s*1\| /.test(readRes.preview || ''), '预览带行号前缀', String(readRes.preview).split('\n')[0]);
  ok(/行号/.test(readRes.note || ''), '明确提示行号不属于文件内容');
  ok((readRes.preview || '').indexOf('return 1') >= 0, '预览里有真实代码');

  // 读不存在的文件 → 报错而不是空内容（否则模型会以为文件是空的）
  const readBad = await page.evaluate(() => window.CodeAgent._runTool('ws_read', { path: 'nope.js' }, {}));
  ok(readBad && !!readBad.error, '读不存在的文件返回 error');

  const searchRes = await page.evaluate(() => window.CodeAgent._runTool('ws_search', { query: 'return 1' }, {}));
  ok(searchRes && searchRes.hits.length >= 1, 'ws_search 能搜到', String(searchRes.hits.length));
  ok(searchRes.hits[0].path === 'src/main.js' && searchRes.hits[0].line === 2, '命中有路径和行号',
    JSON.stringify(searchRes.hits[0]));

  console.log('\n=== 10. diff 确认：人点「应用」才落盘 ===');
  const before = fs.readFileSync(path.join(ws, 'src', 'main.js'), 'utf8');
  ok(before.indexOf('return 1') >= 0, '改动前磁盘是原内容');

  await page.evaluate(() => {
    window.__r1 = null;
    window.CodeAgent._runTool('fs_edit', {
      path: 'src/main.js', old: '  return 1;', new: '  return 42;', why: '把返回值改成 42'
    }, {}).then(r => { window.__r1 = r; });
  });
  await page.waitForSelector('.ca-ag-diff', { state: 'attached', timeout: 8000 });

  const card = await page.evaluate(() => {
    const c = document.querySelectorAll('.ca-ag-diff');
    const el = c[c.length - 1];
    return {
      path: (el.querySelector('.ca-df-path') || {}).textContent || '',
      why: (el.querySelector('.ca-df-why') || {}).textContent || '',
      adds: el.querySelectorAll('.ca-df-row.add').length,
      dels: el.querySelectorAll('.ca-df-row.del').length,
      hasOk: !!el.querySelector('.ca-df-ok'),
      hasNo: !!el.querySelector('.ca-df-no'),
      phase: (document.getElementById('caAgState') || {}).textContent || ''
    };
  });
  ok(card.path === 'src/main.js', '卡片显示文件名', card.path);
  ok(card.why.indexOf('42') >= 0, '卡片显示改动理由', card.why);
  ok(card.adds >= 1 && card.dels >= 1, 'diff 里有增有删', '+' + card.adds + ' -' + card.dels);
  ok(card.hasOk && card.hasNo, '有「应用」和「放弃」两个按钮');
  ok(/等待你确认/.test(card.phase), '等待期间状态栏提示在等确认', card.phase);

  // 还没点的时候磁盘必须**一个字节都没变** —— 这是整个设计的核心承诺
  ok(fs.readFileSync(path.join(ws, 'src', 'main.js'), 'utf8') === before,
    '★ 卡片出现时磁盘未被改动（AI 没有写盘权）');

  await page.locator('.ca-df-ok').last().click();
  await page.waitForFunction(() => window.__r1 !== null, null, { timeout: 8000 });
  const r1 = await page.evaluate(() => window.__r1);
  ok(r1 && r1.applied === true, '点「应用」后工具返回 applied=true', JSON.stringify(r1).slice(0, 80));
  const afterApply = fs.readFileSync(path.join(ws, 'src', 'main.js'), 'utf8');
  ok(afterApply.indexOf('return 42') >= 0, '★ 磁盘内容真的变成了新版本');
  ok(afterApply.indexOf('return 1') < 0, '旧内容已不在');

  const verdict = await page.evaluate(() => {
    const c = document.querySelectorAll('.ca-ag-diff');
    const el = c[c.length - 1];
    return { cls: el.className, text: (el.querySelector('.ca-df-verdict') || {}).textContent || '' };
  });
  ok(/applied/.test(verdict.cls) && verdict.text === '已应用', '卡片标记为已应用', verdict.text);

  console.log('\n=== 11. diff 确认：点「放弃」不落盘 ===');
  const snap = fs.readFileSync(path.join(ws, 'src', 'main.js'), 'utf8');
  await page.evaluate(() => {
    window.__r2 = null;
    window.CodeAgent._runTool('fs_edit', {
      path: 'src/main.js', old: '  return 42;', new: '  return 999;', why: '这次会被放弃'
    }, {}).then(r => { window.__r2 = r; });
  });
  await page.waitForFunction(() => document.querySelectorAll('.ca-ag-diff').length >= 2,
    null, { timeout: 8000 });
  await page.locator('.ca-df-no').last().click();
  await page.waitForFunction(() => window.__r2 !== null, null, { timeout: 8000 });
  const r2 = await page.evaluate(() => window.__r2);
  ok(r2 && r2.applied === false && r2.declined === true, '点「放弃」返回 declined', JSON.stringify(r2).slice(0, 80));
  ok(fs.readFileSync(path.join(ws, 'src', 'main.js'), 'utf8') === snap,
    '★ 放弃后磁盘一个字节都没变');
  ok(/不要原样重试/.test(r2.note || ''), '返回里明确告诉模型别原样重试', r2.note);

  console.log('\n=== 12. 改动后编辑器必须同步 ===');
  await page.evaluate(() => window.codeApp.state.file && (window.codeApp.state.file = null));
  await page.evaluate(() => window.codeApp._render.editor());
  await page.evaluate(() => window.codeApp.state.file = null);
  await page.evaluate(async () => {
    // 走正规路径打开文件（点树里那一行不好定位，直接用 openFile 的内部效果）
    const st = window.codeApp.state;
    const f = await window.openagiDesktop.codeRead('src/main.js');
    st.file = { rel: f.rel, text: f.text, sha: f.sha, dirty: false, eol: f.eol };
    window.codeApp._render.editor();
  });
  const openedText = await page.evaluate(() => document.getElementById('caTa').value);
  ok(openedText.indexOf('return 42') >= 0, '编辑器里是当前磁盘内容', openedText.replace(/\n/g, '|'));

  await page.evaluate(() => {
    window.__r3 = null;
    window.CodeAgent._runTool('fs_edit', {
      path: 'src/main.js', old: '  return 42;', new: '  return 7;', why: '改完编辑器要跟着变'
    }, {}).then(r => { window.__r3 = r; });
  });
  await page.waitForFunction(() => document.querySelectorAll('.ca-ag-diff').length >= 3,
    null, { timeout: 8000 });
  await page.locator('.ca-df-ok').last().click();
  await page.waitForFunction(() => window.__r3 !== null, null, { timeout: 8000 });
  const synced = await page.evaluate(() => {
    const st = window.codeApp.state;
    return {
      ta: document.getElementById('caTa').value,
      dirty: st.file && st.file.dirty,
      saveDisabled: document.getElementById('caSave').disabled
    };
  });
  ok(synced.ta.indexOf('return 7') >= 0, '★ 编辑器跟着换成了新内容（不是旧文本）', synced.ta.replace(/\n/g, '|'));
  ok(synced.dirty === false, '没有被误标成未保存');
  ok(synced.saveDisabled === true, '保存按钮回到禁用（内容与磁盘一致）');

  console.log('\n=== 13. 脏文件保护（AI 不许碰正在改的文件） ===');
  const guarded = await page.evaluate(async () => {
    const st = window.codeApp.state;
    st.file.dirty = true;                      // 模拟用户改了没保存
    const r = await window.CodeAgent._runTool('fs_edit', {
      path: 'src/main.js', old: '  return 7;', new: '  return 8;', why: '应该被拦'
    }, {});
    st.file.dirty = false;
    return r;
  });
  ok(guarded && !!guarded.error, '被拦下来了');
  ok(/未保存/.test(guarded.error) && /Ctrl\+S/.test(guarded.error), '错误里说清了要先保存', guarded.error);
  ok(fs.readFileSync(path.join(ws, 'src', 'main.js'), 'utf8').indexOf('return 8') < 0,
    '★ 被拦的改动没有写进磁盘');

  console.log('\n=== 14. 新建文件 ===');
  const made = await page.evaluate(async () => {
    const p = window.CodeAgent._runTool('fs_new', {
      path: 'src/util.js', content: 'export const twice = n => n * 2;\n', why: '新增一个工具函数'
    }, {});
    // 卡片会立刻出现，自动点应用
    const okBtn = () => new Promise(res => {
      const t = setInterval(() => {
        const btns = document.querySelectorAll('.ca-ag-diff .ca-df-ok');
        const b = btns[btns.length - 1];
        if(b){ clearInterval(t); b.click(); res(true); }
      }, 60);
      setTimeout(() => { clearInterval(t); res(false); }, 6000);
    });
    const clicked = await okBtn();
    const r = await p;
    return { clicked, r };
  });
  ok(made.clicked, '新文件卡片出现并点了应用');
  ok(made.r && made.r.applied === true, 'fs_new 返回 applied', JSON.stringify(made.r).slice(0, 80));
  ok(fs.existsSync(path.join(ws, 'src', 'util.js')), '★ 新文件真的建出来了');
  ok(fs.readFileSync(path.join(ws, 'src', 'util.js'), 'utf8').indexOf('twice') >= 0, '内容正确');

  const dup = await page.evaluate(() => window.CodeAgent._runTool('fs_new', {
    path: 'src/util.js', content: 'x'
  }, {}));
  ok(dup && !!dup.error && /已经存在/.test(dup.error), '已存在的文件不能当新建（否则会整个盖掉）', dup && dup.error);

  console.log('\n=== 15. 助手不绕过工作区 ===');
  const esc = await page.evaluate(() => window.CodeAgent._runTool('ws_read', { path: '../../etc/passwd' }, {}));
  ok(esc && !!esc.error && /越出/.test(esc.error), '工具层也拦路径逃逸', esc && esc.error);

  console.log('\n=== 16. 命令执行：先给人看，人点了才跑 ===');
  /* 走 _runTool 走真实链路：卡片 → 人点 → invoke → 流式输出 → 结果。
   * 不碰模型，但主进程、IPC、流式事件、卡片渲染全部是真的。 */
  const runRes = await page.evaluate(async () => {
    const before = document.querySelectorAll('.ca-ag-run').length;
    const p = window.CodeAgent._runTool('run_cmd', {
      command: 'node -e "console.log(6*7)"', why: '验证一下加法'
    }, {});
    const waitBtn = sel => new Promise(res => {
      const t = setInterval(() => {
        const b = document.querySelector(sel);
        if (b) { clearInterval(t); res(b); }
      }, 50);
      setTimeout(() => { clearInterval(t); res(null); }, 6000);
    });
    const btn = await waitBtn('.ca-ag-run .ca-run-ok');
    const shown = btn ? btn.closest('.ca-ag-run') : null;
    const cmdText = shown ? shown.querySelector('.ca-run-cmd').textContent : '';
    const hasMeta = !!(shown && shown.querySelector('.ca-run-meta'));
    if (btn) btn.click();
    const r = await p;
    await new Promise(res => setTimeout(res, 250));
    const cards = document.querySelectorAll('.ca-ag-run');
    const card = cards[cards.length - 1];
    return {
      before,
      after: cards.length,
      hadBtn: !!btn,
      cmdText,
      hasMeta,
      r,
      out: card ? (card.querySelector('.ca-run-out') || {}).textContent || '' : '',
      foot: card ? (card.querySelector('.ca-run-foot') || {}).textContent || '' : '',
      acts: card ? (card.querySelector('.ca-run-acts') || {}).textContent || '' : ''
    };
  });
  ok(runRes.hadBtn, '卡片出现且带「运行」按钮（不会偷偷执行）');
  ok(runRes.after === runRes.before + 1, '多了一张运行卡片', runRes.before + '→' + runRes.after);
  ok(runRes.cmdText.indexOf('console.log(6*7)') >= 0, '命令原样显示（人批的就是它）', runRes.cmdText);
  ok(runRes.hasMeta, '卡片上标了 cwd 和超时');
  ok(runRes.r && runRes.r.ok === true, '命令执行成功', JSON.stringify(runRes.r && runRes.r.error));
  ok(runRes.r && runRes.r.exit_code === 0, '退出码 0');
  ok(runRes.out.indexOf('42') >= 0, '★ 输出显示在卡片里（流式渲染生效）', JSON.stringify(runRes.out));
  ok(runRes.foot.indexOf('退出码 0') >= 0, '页脚给出退出码与耗时', runRes.foot);
  ok(runRes.foot.indexOf('已完成') >= 0, '页脚给出完成状态', runRes.foot);
  ok(runRes.acts.indexOf('运行中') < 0 && runRes.acts.indexOf('停止') < 0,
    '★ 跑完按钮行撤掉（留着「运行中」和停止按钮会让人以为还在跑）', JSON.stringify(runRes.acts));

  console.log('\n=== 17. 命令执行：拒绝与跳过 ===');
  const runReject = await page.evaluate(async () => {
    const waitBtn = sel => new Promise(res => {
      const t = setInterval(() => {
        const b = document.querySelector(sel);
        if (b) { clearInterval(t); res(b); }
      }, 50);
      setTimeout(() => { clearInterval(t); res(null); }, 6000);
    });
    /* 白名单外 → 主进程不发 end 事件，只能靠 close 兜底；卡片不能停在"运行中" */
    const p1 = window.CodeAgent._runTool('run_cmd', { command: 'rm -rf /' }, {});
    const b1 = await waitBtn('.ca-ag-run .ca-run-ok');
    if (b1) b1.click();
    const r1 = await p1;
    await new Promise(r => setTimeout(r, 200));
    const cards = document.querySelectorAll('.ca-ag-run');
    const c1 = cards[cards.length - 1];
    const foot1 = (c1.querySelector('.ca-run-foot') || {}).textContent || '';

    /* 人点跳过 → 不执行 */
    const p2 = window.CodeAgent._runTool('run_cmd', { command: 'node -e "console.log(1)"' }, {});
    const b2 = await waitBtn('.ca-ag-run .ca-run-no');
    if (b2) b2.click();
    const r2 = await p2;
    return { r1, foot1, r2 };
  });
  ok(runReject.r1 && !!runReject.r1.error && /不允许执行/.test(runReject.r1.error), '白名单外的程序被拒', runReject.r1 && runReject.r1.error);
  ok(runReject.foot1.indexOf('没有执行') >= 0, '★ 被拒时卡片给出原因（不停在"运行中"）', runReject.foot1);
  ok(runReject.r2 && runReject.r2.skipped === true, '点跳过 → 返回 skipped', JSON.stringify(runReject.r2));

  console.log('\n=== 18. 授权后直接运行（仍需显示输出）===');
  const autoRun = await page.evaluate(async () => {
    /* 先把「本对话都直接运行」勾上，再发一条 —— 不该再出现按钮 */
    const p0 = window.CodeAgent._runTool('run_cmd', { command: 'node -e "console.log(\'a\')"' }, {});
    const waitBtn = sel => new Promise(res => {
      const t = setInterval(() => {
        const b = document.querySelector(sel);
        if (b) { clearInterval(t); res(b); }
      }, 50);
      setTimeout(() => { clearInterval(t); res(null); }, 6000);
    });
    const b = await waitBtn('.ca-ag-run .ca-run-chk');
    if (b) { b.checked = true; b.closest('.ca-ag-run').querySelector('.ca-run-ok').click(); }
    await p0;
    const p1 = window.CodeAgent._runTool('run_cmd', { command: 'node -e "console.log(\'b\')"' }, {});
    const r1 = await p1;
    const cards = document.querySelectorAll('.ca-ag-run');
    const last = cards[cards.length - 1];
    return {
      hadCheckbox: !!b,
      r1,
      stillShowsCmd: (last.querySelector('.ca-run-cmd') || {}).textContent || '',
      foot: (last.querySelector('.ca-run-foot') || {}).textContent || ''
    };
  });
  ok(autoRun.hadCheckbox, '卡片上有「本对话都直接运行」');
  ok(autoRun.r1 && autoRun.r1.ok === true, '★ 授权后无需再点按钮，直接执行', JSON.stringify(autoRun.r1 && autoRun.r1.error));
  ok(autoRun.stillShowsCmd.indexOf('console.log') >= 0, '★ 授权不等于静默：命令仍然显示出来', autoRun.stillShowsCmd);
  ok(autoRun.foot.indexOf('退出码 0') >= 0, '授权执行也有结果页脚', autoRun.foot);

  console.log('\n=== 19. 轨迹看板（H0 仪表） ===');
  /* 先备份真实轨迹：这个 App 和用户日常用的是同一个 origin，
   * 测试如果不还原，跑一次回归就把人家攒的样本清空了。样本是最贵的东西。 */
  const traceBackup = await page.evaluate(() => {
    try { return localStorage.getItem('openagi:code-trace'); } catch (e) { return null; }
  });

  const tr = await page.evaluate(() => {
    const T = window.CodeTrace;
    if (!T) return { missing: true };
    T.clear();
    /* 造两条真实形状的轨迹：一条成功改了代码，一条被中止 */
    T.start({ model: 'test-model', ws: 'proj' });
    T.turn(0, 'request');
    T.tool({ name: 'ws_tree', argsDigest: '.', ok: true, resultDigest: '12 项', ms: 5 });
    T.tool({ name: 'ws_read', argsDigest: 'src/a.js · 900B', ok: true, resultDigest: 'L1-40/40 · 900B', ms: 4 });
    T.tool({ name: 'ws_read', argsDigest: 'src/b.js · 500B', ok: true, resultDigest: 'L1-20/20 · 500B', ms: 3 });
    T.turn(1, 'request');
    T.tool({ name: 'fs_edit', argsDigest: 'src/a.js · old:120 · new:130', ok: true, resultDigest: 'applied +3 -1', ms: 9 });
    T.verdict({ path: 'src/a.js', kind: 'mod', verdict: 'apply', wait: 1500 });
    T.end({ reason: 'done' });

    T.start({ model: 'test-model', ws: 'proj' });
    T.turn(0, 'request');
    T.tool({ name: 'ws_read', argsDigest: 'src/c.js · 300B', ok: true, resultDigest: 'L1-10/10 · 300B', ms: 3 });
    T.end({ reason: 'aborted' });

    const s = T.stats();
    const b = T._budget();
    return {
      tasks: s.tasks, toolsMedian: s.toolCalls.median, toolsAvg: s.toolCalls.avg, readsBefore: s.readsBeforeFirstEdit.median,
      acceptRate: s.acceptRate, waitMedian: s.confirmWait.median,
      bytes: b.bytes, writable: b.writable,
      raw: T.exportJson()
    };
  });
  ok(!tr.missing, 'CodeTrace 已加载（index.html 引入了 code-trace.js）');
  ok(tr.tasks === 2, '两条轨迹入库', String(tr.tasks));
  /* 样本只有 2 个时中位数取上中位（4），意义不大 —— 断言均值更稳 */
  ok(tr.toolsAvg === 3, '工具调用均值 = 3（4 和 1 的平均）', String(tr.toolsAvg));
  ok(tr.readsBefore === 2, '★ 首编辑前读取 = 2（H1 的基线算得出来）', String(tr.readsBefore));
  ok(tr.acceptRate === 1, '接受率 = 1（1 应用 / 0 放弃）', String(tr.acceptRate));
  ok(tr.waitMedian === 1500, '确认等待中位数 = 1500ms（H2 的基线）', String(tr.waitMedian));
  ok(tr.bytes > 0 && tr.bytes < 200 * 1024, '库体积在 200KB 预算内', tr.bytes + 'B');
  ok(tr.writable === true, 'App 页里 localStorage 可写（轨迹能跨会话保留）');
  ok(tr.raw.indexOf('old:120') >= 0 && tr.raw.indexOf('function') < 0, '★ 轨迹里只有长度没有源码');

  const panel = await page.evaluate(async () => {
    document.getElementById('caTraceBtn').click();
    await new Promise(r => setTimeout(r, 150));
    const box = document.getElementById('caTraceBox');
    const cells = [...box.querySelectorAll('.ca-tb-v')].map(n => n.textContent.trim());
    return {
      hidden: box.hidden,
      display: getComputedStyle(box).display,
      height: box.getBoundingClientRect().height,
      cells, rows: box.querySelectorAll('.ca-tb-row').length,
      hasExport: !!box.querySelector('[data-tb="export"]')
    };
  });
  ok(panel.hidden === false && panel.display !== 'none', '点「轨迹」后看板显示');
  ok(panel.height > 120, '看板有实际高度（不是塌成一条线）', Math.round(panel.height) + 'px');
  ok(panel.cells.length === 5, '五个指标卡都渲染了', panel.cells.join(' | '));
  ok(panel.cells.indexOf('2') >= 0, '指标里出现真实数字（首编辑前读取=2）', panel.cells.join(' | '));
  ok(panel.rows === 2, '最近任务列表渲染了 2 行', String(panel.rows));
  ok(panel.hasExport, '导出按钮在');

  /* 看板截图：这个面板是给人看数据的，样子不对等于没用 */
  const TRACE_SHOT = path.join(ROOT, 'docs', 'code-trace-panel.png');
  fs.mkdirSync(path.dirname(TRACE_SHOT), { recursive: true });
  const tbEl = await page.$('#caTraceBox');
  await tbEl.screenshot({ path: TRACE_SHOT });
  ok(fs.existsSync(TRACE_SHOT) && fs.statSync(TRACE_SHOT).size > 4000, '看板截图已产出', TRACE_SHOT);

  const reclosed = await page.evaluate(async () => {
    document.getElementById('caTraceBtn').click();
    await new Promise(r => setTimeout(r, 80));
    const box = document.getElementById('caTraceBox');
    return { hidden: box.hidden, display: getComputedStyle(box).display };
  });
  /* 这条盯的是老坑：[hidden] 会被显式 display 盖掉，面板"关了还在" */
  ok(reclosed.hidden === true && reclosed.display === 'none',
    '★ 再点一次真的隐藏（[hidden] 没被 display 覆盖）', JSON.stringify(reclosed));

  await page.evaluate(raw => {
    try {
      if (raw === null) localStorage.removeItem('openagi:code-trace');
      else localStorage.setItem('openagi:code-trace', raw);
    } catch (e) {}
  }, traceBackup);

  console.log('\n=== 20. ws_put：二进制卡片与落盘 ===');
  {
    // 1×1 透明 PNG
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pngAbs = path.join(ws, 'img', 'dot.png');

    // 不 await：卡片要等人点，await 会把整个测试卡死在这里
    const pending = page.evaluate(b64 => window.CodeAgent._runTool('ws_put', {
      path: 'img/dot.png', b64, why: '测试放一张图'
    }), PNG);

    await page.waitForSelector('.ca-ag-put', { timeout: 5000 });
    ok(true, '出现了「放入」卡片');
    /* 这条是整个安全模型的地基：卡片出现的那一刻磁盘必须一个字节都没变。
     * 少了它，后面所有"人点确认才落盘"的说法都只是口头承诺。 */
    ok(!fs.existsSync(pngAbs), '卡片出现时磁盘还没有这个文件');
    ok(await page.evaluate(() => !!document.querySelector('.ca-ag-put .ca-put-img')), '卡片里给了缩略图');

    await page.click('.ca-ag-put .ca-df-ok');
    const putRes = await pending;
    ok(putRes && putRes.applied === true, '点「放入」后工具返回 applied=true', JSON.stringify(putRes && putRes.error));
    ok(fs.existsSync(pngAbs), '文件真的落盘了');
    ok(fs.statSync(pngAbs).size === Buffer.from(PNG, 'base64').length, '字节数与 base64 解码一致');

    // 文本文件必须被挡回去，走 fs_new
    const refused = await page.evaluate(() => window.CodeAgent._runTool('ws_put', {
      path: 'a.html', b64: 'AAAA'
    }));
    ok(!!refused && /文本文件/.test(String(refused.error || '')), '文本文件被劝去用 fs_new', JSON.stringify(refused));
  }

  console.log('\n=== 21. 预览面板 ===');
  {
    /* 故意做一个"坏的"页面：一个 404 的脚本 + 一个运行时异常。
     * 正常页面测不出「错误回传」这条链，而它恰恰是"白屏时唯一的信息来源"。
     * 同时带上**相对路径引用的 css 和图片** —— 多文件站就是这么组织的，
     * 只测单文件等于没测"同一个项目的资源能不能互通"。 */
    fs.writeFileSync(path.join(ws, 'style.css'), 'h1 { color: rgb(200, 0, 0); }\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'index.html'), [
      '<!doctype html><html><head><meta charset="utf-8"><title>预览测试页</title>',
      '<link rel="stylesheet" href="./style.css"></head>',
      '<body><h1 id="h">hello preview</h1>',
      '<img id="pic" src="img/dot.png" alt="dot">',
      '<script src="./missing.js"></script>',
      '<script>setTimeout(function(){ throw new Error("boom-from-test") }, 30)</script>',
      '</body></html>'
    ].join('\n'), 'utf8');

    const started = await page.evaluate(async () => {
      await window.codeApp.openFile('index.html');
      document.getElementById('caPvBtn').click();
      await new Promise(r => setTimeout(r, 1200));
      const f = document.getElementById('caPvFrame');
      /* 必须看**计算样式**而不是 .hidden 属性：.ca-edit 上有 display:flex，
       * 属性 hidden 对它无效，光读 hidden 会得到"已隐藏"的假结论
       * （这个坑已经踩过一次：预览被挤到下半屏，测试却全绿）。 */
      const cs = id => getComputedStyle(document.getElementById(id)).display;
      return {
        pvVisible: cs('caPv') !== 'none',
        editHidden: cs('caEdit') === 'none',
        src: f ? f.src : '',
        rel: window.codeApp.state.pv.rel,
        errors: window.codeApp.state.pv.errors.map(e => e.text)
      };
    });
    ok(started.pvVisible === true, '预览层显示了');
    ok(started.editHidden === true, '编辑区让位了');
    ok(started.rel === 'index.html', '预览目标是当前 HTML', started.rel);
    ok(/^openagi-preview:\/\/ws\//.test(started.src), '用了独立协议而不是 file://', started.src);

    const frame = page.frames().find(f => f.url().startsWith('openagi-preview://ws/'));
    ok(!!frame, 'iframe 真的加载了预览协议');

    if(frame){
      const h1 = await frame.evaluate(() => {
        const el = document.getElementById('h');
        return el ? el.textContent : '';
      }).catch(e => 'err:' + e.message);
      ok(h1 === 'hello preview', '页面内容真的渲染出来了', String(h1));

      // 相对路径的 CSS 必须生效：这验证了"同源 + 协议能服务子资源"，不只是能开一个 html
      const color = await frame.evaluate(() => {
        const el = document.getElementById('h');
        return el ? getComputedStyle(el).color : '';
      }).catch(e => 'err:' + e.message);
      ok(/rgb\(200,\s*0,\s*0\)/.test(String(color)), '同目录的 style.css 生效了（相对路径没问题）', String(color));

      // 图片走 ws_put 放进去的那张：证明二进制资产在页面里能被引用
      const pic = await frame.evaluate(() => {
        const el = document.getElementById('pic');
        return el ? { w: el.naturalWidth, src: el.getAttribute('src') } : null;
      }).catch(e => ({ err: e.message }));
      ok(pic && pic.w === 1, '图片资源加载成功（naturalWidth=1）', JSON.stringify(pic));

      /* 安全边界：预览页和应用不同源，所以它摸不到 preload 挂的 openagiDesktop。
       * 这条如果不成立，AI 生成的任意 HTML 都能直接调 codeWrite 绕过人确认 ——
       * 那整个"AI 没有写盘权"的设计就作废了。 */
      const escape = await frame.evaluate(() => {
        try {
          if (parent.openagiDesktop) return 'LEAK';
          return 'blocked';
        } catch (e) { return 'blocked'; }
      }).catch(e => 'unknown:' + e.message);
      ok(escape === 'blocked', '预览页拿不到 parent.openagiDesktop（跨源已生效）', String(escape));

      const origin = await frame.evaluate(() => String(location.origin + '|' + location.host)).catch(() => '');
      ok(/^openagi-preview:\/\/ws/.test(origin), '预览页 origin 是独立 scheme', String(origin));
    }

    // 错误回传：等钩子把两类错都送出来
    await page.waitForTimeout(600);
    const errs = await page.evaluate(() => window.codeApp.state.pv.errors.map(e => e.kind + ':' + e.text));
    ok(errs.some(t => /boom-from-test/.test(t)), '运行时异常被捕获并上报', errs.join(' / '));
    ok(errs.some(t => /missing\.js/.test(t)), '资源 404 被捕获并上报', errs.join(' / '));
    ok(await page.evaluate(() => !document.getElementById('caPvErrBtn').hidden), '错误按钮出现了');
    // 面板默认收起：错误多的时候它会盖住页面，用户没点过就不该展开
    ok(await page.evaluate(() => document.getElementById('caPvList').hidden), '错误列表默认收起');

    await page.click('#caPvErrBtn');
    ok(await page.evaluate(() => !document.getElementById('caPvList').hidden), '点错误按钮能展开列表');
    await page.click('#caPvErrBtn');

    // 助手要能看见这些错 —— factsOf 里那段 <LAST_PREVIEW_ERRORS> 读的就是这个钩子
    ok(await page.evaluate(() => {
      const e = document.getElementById('caPvErrBtn');
      return e && /错误 \d/.test(e.textContent);
    }), '错误计数显示在按钮上');

    /* 闭环验证：报错必须真的能进模型上下文。
     * 只在面板上显示是不够的 —— 用户说"还是白屏"的时候，
     * 助手拿到的上下文里如果没有这些错误，它就只能猜。 */
    const facts = await page.evaluate(() => window.CodeAgent._factsOf({ round:0, maxRounds:6, remaining:6 }));
    ok(/<LAST_PREVIEW_ERRORS>/.test(facts), '事实卡里带上了预览报错段');
    ok(/boom-from-test/.test(facts), '报错原文进了上下文', facts.slice(-160));
    ok(/可能已经被你后来改好/.test(facts), '并且说清了这是"上次看到的"（不能当成当前事实）');

    // 留一张预览态截图：这是"改完能看见"这件事唯一的视觉证据
    const PVSHOT = path.join(ROOT, 'docs', 'code-app-preview.png');
    fs.mkdirSync(path.dirname(PVSHOT), { recursive: true });
    const pvWin = await page.$('#codeWin');
    await pvWin.screenshot({ path: PVSHOT });
    ok(fs.existsSync(PVSHOT) && fs.statSync(PVSHOT).size > 5000, '预览截图已产出', PVSHOT);

    // 关掉要真的停：iframe 置空，否则页面里的定时器会一直跑
    const closedPv = await page.evaluate(async () => {
      document.getElementById('caPvClose').click();
      await new Promise(r => setTimeout(r, 200));
      return {
        hidden: document.getElementById('caPv').hidden,
        editShown: !document.getElementById('caEdit').hidden,
        src: document.getElementById('caPvFrame').src
      };
    });
    ok(closedPv.hidden === true && closedPv.editShown === true, '「回到代码」恢复编辑区');
    ok(/about:blank$/.test(closedPv.src), 'iframe 被置空（页面里的定时器不会继续跑）', closedPv.src);
  }

  console.log('\n=== 22. 截图（树 + 代码 + 助手 + diff 卡片都在，才有信息量） ===');
  await page.waitForTimeout(400);
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  const winEl = await page.$('#codeWin');
  await winEl.screenshot({ path: SHOT });
  ok(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 5000, '截图已产出', SHOT);

  console.log('\n=== 23. 关闭按钮回到桌面 ===');
  const closed = await page.evaluate(async () => {
    document.getElementById('btnCodeWinClose').click();
    await new Promise(r => setTimeout(r, 700));   // 等返回动画
    const w = document.getElementById('codeWin');
    const wall = document.getElementById('deskWall');
    return {
      inHost: w.parentElement ? w.parentElement.id : '',
      hidden: w.classList.contains('hidden'),
      appOpen: wall.classList.contains('app-open')
    };
  });
  ok(closed.hidden === true, '窗口已关闭（不是留在 App 页里空着）');
  ok(closed.inHost !== 'deskAppHost', '窗口已搬回桌面（不再挂在 App 页宿主里）', closed.inHost);
  ok(closed.appOpen === false, '桌面已翻回来');

  console.log('\n=== 24. 页面无致命错误 ===');
  // 收集到的 console error 在 launch 前没法挂钩，这里改为检查关键函数是否还在
  const alive = await page.evaluate(() => typeof window.codeApp.open === 'function'
    && typeof window.CodeAgent.mount === 'function'
    && typeof window.toolLoopRun === 'function');
  ok(alive, 'codeApp / CodeAgent / toolLoopRun 都还在');

  /* 预览测试故意做了个 404 的脚本，那条错误是**预期的**，不算应用的问题。
   * 这条断言真正要抓的是「某个 handler 没绑 / 某个 null 没判」那一类 ——
   * 它们不会让测试失败，只会让某个按钮默默不响应。 */
  const noise = /missing\.js|ERR_FILE_NOT_FOUND|Failed to load resource|boom-from-test/i;
  const fatal = consoleErrors.filter(t => !noise.test(t));
  ok(fatal.length === 0, '没有意外的控制台错误', fatal.slice(0, 3).join(' | '));

  // 还原用户原本的工作区（测试把工作区指到了临时目录）
  await page.evaluate(async prev => {
    if(prev) await window.openagiDesktop.codeSetRoot(prev);
    else await window.openagiDesktop.codeClear();
  }, prevRoot);

} finally {
  await app.close().catch(() => {});
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch(e){}
}

console.log('\n----------------------------------------');
console.log(fail === 0 ? '✅ 全部通过 · ' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
console.log('截图：' + SHOT);
if(fail > 0) process.exit(1);
