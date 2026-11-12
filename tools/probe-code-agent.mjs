/* 编码助手的端到端探针：真模型 + 真工具 + 真 diff 确认
 *
 * ⚠ 这个脚本会**真的调用语言模型**（花钱、依赖网络），所以不进回归清单，
 *   要在需要验证整条链路时手动跑：node tools/probe-code-agent.mjs
 *
 * 它验证的东西，UI 测试验证不了：
 *   - 系统提示词能不能真的把模型约束成「先读再改」
 *   - tool_calls 的流式解析 + 工具结果回填在真实模型上是否成立
 *   - 模型自己算的 old 能不能精确匹配文件内容（CRLF / 缩进 / 行号前缀）
 *   - 模型会不会在 diff 还没确认时就说「已修复」
 *
 * 判据不是"通过了没"，是下面这几条打印出来的事实。
 */
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOT = path.join(ROOT, 'docs', 'code-agent-probe.png');
const TASK = process.argv[2] || 'src/calc.js 里的 add 函数算错了，帮我修一下，改完跑一下测试确认';
const TIMEOUT_MS = 300000;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ogcode-probe-'));
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
fs.writeFileSync(path.join(ws, 'src', 'calc.js'), [
  '// 简单的算术工具',
  '',
  'export function add(a, b){',
  '  return a - b;      // BUG: 应该是加法',
  '}',
  '',
  'export function mul(a, b){',
  '  return a * b;',
  '}',
  ''
].join('\n'), 'utf8');
/* 一个**真的会挂**的测试：修好之前 add(2,3) 返回 -1。
 * 探针要验的不是"命令能跑"，而是"模型会不会用命令发现自己是错的"。 */
fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
  name: 'probe', private: true, type: 'module',
  scripts: { test: 'node test/run.js' }
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(ws, 'test', 'run.js'), [
  'import assert from \'node:assert\';',
  'import { add, mul } from \'../src/calc.js\';',
  '',
  'assert.equal(add(2, 3), 5, \'add(2,3) 应该是 5\');',
  'assert.equal(mul(2, 3), 6, \'mul(2,3) 应该是 6\');',
  'console.log(\'all tests passed\');',
  ''
].join('\n'), 'utf8');
fs.writeFileSync(path.join(ws, 'README.md'), '# probe\n\n一个用来验证编码助手的小项目。\n', 'utf8');

const ENV = { ...process.env, OPENAGI_TEST: '1' };
delete ENV.ELECTRON_RUN_AS_NODE;

console.log('工作区：' + ws);
console.log('任务：' + TASK);
console.log('');

const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: ENV, timeout: 60000 });

let exitCode = 0;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.codeApp !== 'undefined', null, { timeout: 20000 });

  const prevRoot = await page.evaluate(async () => {
    const i = await window.openagiDesktop.codeInfo();
    return i && i.ready ? i.root : '';
  });

  await page.evaluate(async d => {
    const info = await window.openagiDesktop.codeSetRoot(d);
    const st = window.codeApp.state;
    st.root = info.root; st.name = info.name; st.ready = true;
    openDeskApp('code');
    await new Promise(r => setTimeout(r, 1600));
    await window.codeApp.open();
  }, ws);

  // 模型连接到底是什么（不打印 Key）
  const conn = await page.evaluate(() => {
    try {
      const c = window.llmConn();
      return { ok: !!(c && c.base && c.key && c.model), model: c && c.model, via: c && c.via, base: c && c.base };
    } catch(e){ return { ok: false, err: String(e && e.message || e) }; }
  });
  console.log('模型连接：' + (conn.ok ? (conn.via || 'local') + ' · ' + conn.model + ' · ' + conn.base : '未配置'));
  if(!conn.ok){
    console.log('\n❌ 没有可用的语言模型，没法验对话。先去设置里配 Key 或登录。');
    exitCode = 1;
    throw new Error('no-llm');
  }

  const before = fs.readFileSync(path.join(ws, 'src', 'calc.js'), 'utf8');

  // 发一条真实消息
  await page.evaluate(t => {
    const box = document.getElementById('caAgInput');
    box.value = t;
    document.getElementById('caAgSend').click();
  }, TASK);

  console.log('\n--- 开始等模型（最多 4 分钟） ---');
  const t0 = Date.now();
  let applied = 0, declined = 0, asked = 0;
  let lastLog = '';

  /* 边跑边把卡片点掉：这不是作弊，模拟的就是人的动作。
   * 但每次点击前把卡片内容记下来，后面要核对 diff 是否合理。 */
  const deadline = Date.now() + TIMEOUT_MS;
  const seenCards = new Set();
  const seenRuns = new Set();
  const ranCmds = [];
  let settledAt = 0;

  while(Date.now() < deadline){
    const st = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.ca-ag-diff'));
      const runs = Array.from(document.querySelectorAll('.ca-ag-run'));
      return {
        busy: window.CodeAgent.isBusy(),
        state: (document.getElementById('caAgState') || {}).textContent || '',
        log: (document.getElementById('caAgLog') || {}).innerText || '',
        cards: cards.map((c, i) => ({
          i,
          path: (c.querySelector('.ca-df-path') || {}).textContent || '',
          why: (c.querySelector('.ca-df-why') || {}).textContent || '',
          pending: !!c.querySelector('.ca-df-ok'),
          cls: c.className,
          body: (c.querySelector('.ca-df-body') || {}).innerText || ''
        })),
        runs: runs.map((c, i) => ({
          i,
          cmd: (c.querySelector('.ca-run-cmd') || {}).textContent || '',
          why: (c.querySelector('.ca-run-meta') || {}).textContent || '',
          pending: !!c.querySelector('.ca-run-ok'),
          foot: (c.querySelector('.ca-run-foot') || {}).textContent || '',
          out: (c.querySelector('.ca-run-out') || {}).textContent || ''
        }))
      };
    });
    lastLog = st.log;

    /* 运行卡片也要点：探针扮演的还是"人"，人在这儿会批的是验证命令。
     * 白名单外的（比如它想跑 npm install）一律跳过 —— 那不是验证。 */
    for(const r of st.runs){
      if(!r.pending || seenRuns.has(r.i)) continue;
      seenRuns.add(r.i);
      console.log('\n[运行卡片 #' + (r.i + 1) + '] $ ' + r.cmd);
      const risky = /install|commit|push|add\s+-A|reset|publish/i.test(r.cmd);
      if(risky){
        await page.locator('.ca-run-no').nth(r.i).click().catch(() => {});
        console.log('    → 点了「跳过」（会改用户环境，不该自动批）');
        continue;
      }
      await page.locator('.ca-run-ok').nth(r.i).click().catch(() => {});
      ranCmds.push(r.cmd);
      console.log('    → 点「运行」');
    }

    for(const c of st.cards){
      if(!c.pending || seenCards.has(c.i)) continue;
      seenCards.add(c.i);
      asked++;
      console.log('\n[diff 卡片 #' + (c.i + 1) + '] ' + c.path + (c.why ? ' · ' + c.why : ''));
      console.log(c.body.split('\n').slice(0, 14).map(l => '    ' + l).join('\n'));
      if(/calc\.js/.test(c.path)){
        // 只对目标文件的改动放行，别的一律拒绝 —— 助手不该顺手改别处
        await page.locator('.ca-df-ok').nth(c.i).click().catch(() => {});
        applied++;
        console.log('    → 点「应用」');
      }else{
        await page.locator('.ca-df-no').nth(c.i).click().catch(() => {});
        declined++;
        console.log('    → 点了「放弃」（不是目标文件，不该改）');
      }
    }

    if(!st.busy){
      settledAt = Date.now();
      break;
    }
    await new Promise(r => setTimeout(r, 700));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n--- 结束（' + elapsed + ' 秒） ---');

  const finalLog = await page.evaluate(() => (document.getElementById('caAgLog') || {}).innerText || '');
  console.log('\n=== 对话全文 ===');
  console.log(finalLog.slice(-3000));

  const after = fs.readFileSync(path.join(ws, 'src', 'calc.js'), 'utf8');
  console.log('\n=== 磁盘结果 ===');
  console.log(after);

  const checks = [];
  const add = (ok, name, extra) => checks.push({ ok, name, extra });

  add(applied >= 1, '至少应用了一处改动（模型走了 fs_edit）');
  add(declined === 0, '没有改动目标之外的文件', '被放弃 ' + declined + ' 处');
  add(/return\s+a\s*\+\s*b/.test(after), '★ calc.js 真的被改成了加法');
  add(/a\s*-\s*b/.test(after) === false, '旧的有 bug 的写法已经不在了');
  add(/return\s+a\s*\*\s*b/.test(after), 'mul 函数没被误改');
  add(settledAt > 0, '助手正常结束（不是超时）');
  add(lastLog.indexOf('已达到本轮工具调用上限') < 0,
    '★ 自然收尾（不是撞上 8 轮上限被截断）');
  /* 注意：「已修改」这个措辞现在是对的 —— 工具是等用户点完应用才返回的，
   * 模型拿到 applied=true 时改动确实已经在磁盘上。要检查的不是它说不说"已修改"，
   * 而是它有没有跳过 diff 直接宣称完成（那由 applied>=1 覆盖）以及有没有说清改了什么。 */
  add(/calc|add|a \+ b|加法/.test(finalLog), '最终回复说清了改的是什么（不是一句空话）');
  add(/declined|放弃/.test(finalLog) === false, '没有把「用户放弃」误报成完成');

  /* ---- 验证闭环（这一轮的重点）----
   * 判据不是"命令能跑通"，而是**模型有没有主动去验**，以及它是否真的用上了结果。 */
  const runsAfter = await page.evaluate(() => {
    const runs = Array.from(document.querySelectorAll('.ca-ag-run'));
    return runs.map(c => ({
      cmd: (c.querySelector('.ca-run-cmd') || {}).textContent || '',
      foot: (c.querySelector('.ca-run-foot') || {}).textContent || '',
      out: (c.querySelector('.ca-run-out') || {}).textContent || ''
    }));
  });
  const lastRun = runsAfter[runsAfter.length - 1] || null;
  console.log('\n=== 命令执行 ===');
  runsAfter.forEach((r, i) => {
    console.log('  [' + (i + 1) + '] $ ' + r.cmd);
    console.log('      ' + (r.foot || '(无)') + (r.out ? ' · 输出 ' + r.out.split('\n').length + ' 行' : ''));
  });

  add(runsAfter.length >= 1, '★ 模型主动发起了验证命令', ranCmds.join(' / '));
  add(ranCmds.some(c => /test|check|lint|tsc/i.test(c)),
    '验证的是测试/检查，不是无关命令', ranCmds.join(' / '));
  add(!!lastRun && /退出码 0/.test(lastRun.foot),
    '★ 最后一次验证退出码 0（它确实修好了才收手）', lastRun ? lastRun.foot : '无运行');
  add(!!lastRun && /passed|ok|✓/i.test(lastRun.out),
    '输出里能看到测试通过的字样', lastRun ? lastRun.out.slice(-120) : '');
  add(/测试|test|验证|通过/i.test(finalLog.slice(-600)),
    '最终回复提到了验证结果');

  const toolCalls = (finalLog.match(/^ws_(tree|list|read|search)$|^fs_(edit|new)$|^run_cmd$/gm) || []).length;
  console.log('\n工具调用次数：' + toolCalls + '（理想 4~6 次：读 → 改 → 跑测试 → 收尾）');

  /* ---- 轨迹验收（H0）----
   * 构造数据测不出插桩接没接上，只有真模型跑一遍才知道。
   * 这里检查：真实任务是否留下轨迹、事件数是否和界面上的工具调用对得上。 */
  const trace = await page.evaluate(() => {
    const T = window.CodeTrace;
    if (!T) return { missing: true };
    const s = T.stats();
    const last = T.list({ limit: 1, full: true })[0] || null;
    return {
      tasks: s.tasks,
      writable: T._budget().writable,
      last: last ? { id: last.id, reason: last.reason, ms: last.ms, edges: last.edges, ev: last.events } : null
    };
  });

  console.log('\n=== 轨迹（H0 验收） ===');
  if (trace.missing) {
    add(false, '★ CodeTrace 已加载');
  } else {
    const e = (trace.last && trace.last.edges) || {};
    const ev = (trace.last && trace.last.ev) || [];
    const toolEv = ev.filter(x => x.e === 'tool');
    const turnEv = ev.filter(x => x.e === 'turn');
    console.log('任务数 ' + trace.tasks + ' · 本任务事件 ' + ev.length + ' 条（turn ' + turnEv.length + ' / tool ' + toolEv.length + '）');
    console.log('派生：工具 ' + e.tools + ' · 首编辑前读取 ' + e.readsBeforeEdit + ' · 应用 ' + e.applied + ' · 放弃 ' + e.declined);
    toolEv.forEach(x => console.log('  r' + x.n + ' ' + x.k + '  [' + x.a + '] → ' + x.d + '  (' + x.ms + 'ms)'));

    add(ev.length > 0, '★ 这次真实任务留下了轨迹');
    add(toolEv.length >= 2, '每次工具调用都有对应事件',
      '记录 ' + toolEv.length + ' 条 / 界面 ' + toolCalls + ' 次');
    add(turnEv.length >= 1, '轮次边界被记下（onRound 接上了）');
    add(toolEv.some(x => x.k === 'fs_edit'), 'fs_edit 被记录');
    add(toolEv.some(x => x.k === 'run_cmd'), 'run_cmd 被记录（验证也算动作）');
    add(e.applied >= 1, 'diff 判定（用户点应用）被记录');
    add(e.readsBeforeEdit >= 1, '★ H1 基线（首编辑前读取）算得出来', String(e.readsBeforeEdit));
    add(trace.last.reason === 'done', '结束原因 = done（自然收尾）', trace.last.reason);
    add(ev.every(x => !x.a || x.a.length <= 200), '所有摘要都在长度上限内');
    const editEv = toolEv.filter(x => x.k === 'fs_edit')[0];
    const diffEv = ev.filter(x => x.e === 'diff')[0];
    add(!!editEv && editEv.ms < 300, '★ fs_edit 耗时不含人工确认时间',
      editEv ? editEv.ms + 'ms（确认另记）' : '无 fs_edit');
    add(!!diffEv, '人工确认单独记成 diff 事件', diffEv ? ('wait=' + diffEv.wait + 'ms') : '');
    const raw = JSON.stringify(ev);
    add(raw.indexOf('return a - b') < 0, '★ 轨迹里没有源码原文');
    add(raw.indexOf('a - b') < 0, '短片段也没漏进去');
  }

  await page.waitForTimeout(400);
  const winEl = await page.$('#codeWin');
  if(winEl) await winEl.screenshot({ path: SHOT });

  console.log('\n=== 判定 ===');
  let bad = 0;
  for(const c of checks){
    console.log((c.ok ? '  ✅ ' : '  ❌ ') + c.name + (c.extra ? ' — ' + c.extra : ''));
    if(!c.ok) bad++;
  }
  console.log('\n截图：' + SHOT);
  if(bad) { console.log('❌ ' + bad + ' 项不达标'); exitCode = 1; }
  else console.log('✅ 端到端通过');

  await page.evaluate(async prev => {
    if(prev) await window.openagiDesktop.codeSetRoot(prev);
    else await window.openagiDesktop.codeClear();
  }, prevRoot);

} catch(e) {
  if(String(e && e.message) !== 'no-llm'){
    console.error('\n探针自身出错：', e && e.message || e);
    exitCode = 1;
  }
} finally {
  await app.close().catch(() => {});
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch(e){}
  process.exit(exitCode);
}
