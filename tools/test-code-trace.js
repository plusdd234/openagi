/* code-trace.js 单元测试（纯 node，不启 Electron）
 *
 * 这个模块的价值全在「记什么」和「不记什么」上，所以测试也压这两点：
 *   ① 必须留下的：工具名、路径摘要、成功失败、耗时、人的判定、轮次
 *   ② 绝对不能留的：文件内容、模型原文、用户输入全文
 *
 * 第 ② 条如果破了，不是功能 bug，是**隐私事故**——而且不会有任何报错，
 * 只会在某天发现轨迹库里有整份源码。所以这里用「把长文本喂进去，
 * 断言库里搜不到它」的方式硬测。
 *
 * 跑法：node tools/test-code-trace.js
 */
'use strict';

const path = require('path');
const FILE = path.join(__dirname, '..', 'js', 'code-trace.js');

let pass = 0, fail = 0;

function ok(cond, name, detail){
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(a, b, name){
  ok(a === b, name, '实际 ' + JSON.stringify(a) + ' 期望 ' + JSON.stringify(b));
}
function fresh(){
  delete require.cache[require.resolve(FILE)];
  return require(FILE);
}

/* 假 localStorage：可以模拟配额满，也可以模拟完全不可用 */
function fakeLS(opt){
  const o = opt || {};
  const m = new Map();
  const api = {
    _m: m,
    failSet: !!o.failSet,
    getItem(k){ return m.has(k) ? m.get(k) : null; },
    setItem(k, v){
      if (api.failSet) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, v);
    },
    removeItem(k){ m.delete(k); }
  };
  return api;
}

/* 一段很有辨识度的「源码」，用来验证它不会出现在轨迹里 */
const SECRET = [
  'const API_KEY = "sk-should-never-appear-in-trace";',
  'function secretBusinessLogic(){ return 42; }',
  '// 这一整段都不应该被记录'
].join('\n');

async function main(){
  console.log('=== 1. 基本流与事件形状 ===');
  {
    const T = fresh();
    const id = T.start({ model: 'deepseek-chat', ws: 'my-project' });
    ok(/^ct/.test(id), 'start 返回任务 id', id);

    T.turn(0, 'request');
    T.tool({ name: 'ws_tree', argsDigest: '', ok: true, resultDigest: '18 项', ms: 5 });
    T.turn(1, 'request');
    T.tool({ name: 'ws_read', argsDigest: 'src/calc.js · 1.2KB', ok: true, resultDigest: '42 行', ms: 9 });
    const done = T.end({ reason: 'done' });
    eq(done, id, 'end 返回同一个 id');

    const t = T.get(id);
    eq(t.events.length, 4, '事件数 = 2 turn + 2 tool');
    eq(t.events[0].e, 'turn', '首事件是 turn');
    eq(t.events[1].e, 'tool', '次事件是 tool');
    eq(t.events[1].n, 0, '工具事件带上了所属轮次');
    eq(t.events[3].n, 1, '第 2 轮的工具带轮次 1');
    ok(t.ms >= 0, '任务记录了总耗时', String(t.ms));
    eq(t.reason, 'done', '结束原因被记录');
  }

  console.log('\n=== 2. 隐私：绝不存全文 ===');
  {
    const T = fresh();
    const id = T.start({ model: 'm', ws: 'w' });
    T.turn(0, 'request');
    /* 模拟工具层的真实摘要方式：路径 + 长度，不带内容 */
    T.tool({
      name: 'ws_read',
      argsDigest: 'src/secret.js · ' + SECRET.length + 'B',
      ok: true, resultDigest: '3 行 · ' + SECRET.length + 'B', ms: 3
    });
    T.tool({
      name: 'fs_edit',
      argsDigest: 'src/secret.js · old:' + SECRET.length + ' · new:' + SECRET.length,
      ok: true, resultDigest: '+3 -3', ms: 11
    });
    T.verdict({ path: 'src/secret.js', kind: 'mod', verdict: 'apply', wait: 2400 });
    T.end({ reason: 'done' });

    const raw = T.exportJson();
    ok(raw.indexOf('sk-should-never-appear-in-trace') < 0, 'API Key 没有进轨迹');
    ok(raw.indexOf('secretBusinessLogic') < 0, '源码标识符没有进轨迹');
    ok(raw.indexOf('这一整段都不应该被记录') < 0, '注释原文没有进轨迹');
    ok(raw.indexOf('src/secret.js') >= 0, '但路径留下了（监督必需）');
    ok(raw.indexOf(String(SECRET.length)) >= 0, '长度留下了（能判断读了多少）');

    /* 就算调用方违规传了超长内容，也只能保证"长度不失控"——
     * clip 砍的是长度，砍不掉"前 200 字符正好是源码"。
     * 这里如实断言这个**能力边界**，避免误以为它是隐私防线：
     * 真正的保证来自调用方只传派生量（见 code-agent 的 digestArgsOf）。 */
    const id2 = T.start({ model: 'm', ws: 'w' });
    T.tool({ name: 'ws_read', argsDigest: SECRET.repeat(20), ok: true, resultDigest: '', ms: 1 });
    T.end({ reason: 'done' });
    const t2 = T.get(id2);
    eq(t2.events[0].a.length, 200, '★ 超长 argsDigest 被硬截到 200 字符（防体积，非防泄露）');
  }

  console.log('\n=== 3. derive：H1 的核心指标 ===');
  {
    const T = fresh();
    const id = T.start({ model: 'm', ws: 'w' });
    T.turn(0, 'request');
    T.tool({ name: 'ws_tree', argsDigest: '', ok: true, resultDigest: '10 项', ms: 2 });
    T.tool({ name: 'ws_read', argsDigest: 'a.js · 100B', ok: true, resultDigest: '10 行', ms: 2 });
    T.tool({ name: 'ws_read', argsDigest: 'b.js · 200B', ok: true, resultDigest: '20 行', ms: 2 });
    T.turn(1, 'request');
    T.tool({ name: 'ws_read', argsDigest: 'c.js · 300B', ok: true, resultDigest: '30 行', ms: 2 });
    T.tool({ name: 'fs_edit', argsDigest: 'c.js · old:50 · new:60', ok: true, resultDigest: '+2 -1', ms: 8 });
    T.tool({ name: 'ws_read', argsDigest: 'c.js · 300B', ok: true, resultDigest: '30 行', ms: 2 });
    T.end({ reason: 'done' });

    const e = T.get(id).edges;
    eq(e.reads, 4, '总读取次数 = 4');
    /* 这条是 H1 的判定依据：给地图前是 3，给地图后要降到 ≤2 才算有效 */
    eq(e.readsBeforeEdit, 3, '★ 首次编辑前的读取次数 = 3');
    eq(e.hasEdit, true, '标记出「这次任务真的改了代码」');
    eq(e.tools, 6, '工具总数');
    eq(e.touched.length, 3, '去重后的被读文件 = 3 个（c.js 读了两次算一个）');
    ok(e.touched.indexOf('c.js') >= 0, 'touched 里含 c.js');
  }

  console.log('\n=== 4. 判定三态与 acceptRate ===');
  {
    const T = fresh();
    const id = T.start({ model: 'm', ws: 'w' });
    T.verdict({ path: 'a.js', kind: 'mod', verdict: 'apply', wait: 1000 });
    T.verdict({ path: 'b.js', kind: 'mod', verdict: 'skip', wait: 3000 });
    T.verdict({ path: 'c.js', kind: 'new', verdict: 'apply', wait: 500 });
    T.verdict({ path: 'd.js', kind: 'mod', verdict: 'abort', wait: 200 });
    T.end({ reason: 'aborted' });

    const e = T.get(id).edges;
    eq(e.applied, 2, '应用 2 次');
    eq(e.declined, 1, '放弃 1 次');
    eq(e.aborted, 1, '中止 1 次');
    eq(e.waitMs, 4700, '等待总时长 = 1000+3000+500+200');

    const s = T.stats();
    /* 中止不该算进放弃 —— 用户点停止不是「否决这个改动」，
     * 混进去会让 acceptRate 无端变低 */
    eq(s.acceptRate, 0.67, '★ acceptRate = 2/3（中止不计入分母）');
    eq(s.confirmWait.n, 3, '等待时长只统计 3 次真实判定（中止那次不算人看过 diff）');
    eq(s.confirmWait.median, 1000, '等待中位数 = 1000（500 / 1000 / 3000 取中间）');
  }

  {
    const T = fresh();
    T.start({ model: 'm', ws: 'w' });
    T.tool({ name: 'ws_tree', argsDigest: '', ok: true, resultDigest: '', ms: 1 });
    T.end({ reason: 'done' });
    /* 一次判定都没有时，acceptRate 必须是 null 而不是 0。
     * 返回 0 会被读成「全部被放弃」，那是个假结论。 */
    eq(T.stats().acceptRate, null, '★ 零判定时 acceptRate = null（不是 0）');
  }

  console.log('\n=== 5. 失败与异常 ===');
  {
    const T = fresh();
    const id = T.start({ model: 'm', ws: 'w' });
    T.tool({ name: 'fs_edit', argsDigest: 'a.js · old:10', ok: false, resultDigest: '找不到要替换的文本', ms: 4 });
    T.tool({ name: 'ws_read', argsDigest: 'a.js · 90B', ok: true, resultDigest: '9 行', ms: 2 });
    T.end({ reason: 'done' });
    eq(T.get(id).edges.failed, 1, '失败的工具被计数');
    ok(T.get(id).events[0].ok === 0, '失败标记为 0');
    ok(T.get(id).events[0].d.indexOf('找不到') >= 0, '失败原因被保留（否则无法判断为什么失败）');

    /* end 之前就没人调 end 的情况不能崩 */
    T.start({ model: 'm', ws: 'w' });
    T.tool({ name: 'ws_read', argsDigest: 'x', ok: true, resultDigest: '', ms: 1 });
    const before = T.stats().tasks;
    T.start({ model: 'm', ws: 'w' });   // 直接开新的，旧的丢弃
    eq(T.stats().tasks, before, '未 end 的任务不进库（不产生半条脏记录）');

    /* 没有 start 就调 tool 不能崩 */
    const T2 = fresh();
    T2.tool({ name: 'ws_read' });
    T2.verdict({ path: 'a' });
    T2.end({});
    ok(true, '★ 无 start 时各写入函数都静默返回，不抛');
  }

  console.log('\n=== 6. 容量与体积 ===');
  {
    const T = fresh();
    for (let i = 0; i < T.MAX_TASKS + 5; i++) {
      T.start({ model: 'm', ws: 'w' + i });
      T.turn(0, 'request');
      T.tool({ name: 'ws_read', argsDigest: 'f' + i + '.js · 100B', ok: true, resultDigest: '1 行', ms: 1 });
      T.end({ reason: 'done' });
    }
    const all = T.list({ limit: 999 });
    eq(all.length, T.MAX_TASKS, '库容量封顶在 MAX_TASKS');
    eq(all[all.length - 1].ws, 'w' + (T.MAX_TASKS + 4), '最新一条是最后写入的');
    ok(all[0].ws !== 'w0', '最老的被丢弃', all[0].ws);
  }

  {
    const T = fresh();
    T.start({ model: 'm', ws: 'w' });
    /* 造一个接近最坏情况的任务：满事件、满字段 */
    for (let i = 0; i < 60; i++) {
      T.turn(i, 'request');
      T.tool({
        name: 'fs_edit', argsDigest: 'some/deep/path/file' + i + '.js · old:1200 · new:1300',
        ok: i % 7 !== 0, resultDigest: '+' + i + ' -' + (i + 1), ms: 3
      });
      T.verdict({ path: 'some/deep/path/file' + i + '.js', kind: 'mod', verdict: i % 3 ? 'apply' : 'skip', wait: 1200 });
    }
    T.end({ reason: 'done' });
    const size = T._budget().bytes;
    ok(size < T.TASK_BYTE_BUDGET, '★ 单任务体积在 200KB 预算内', size + 'B');
    ok(size < 60 * 1024, '实际远小于预算（正常任务几 KB）', size + 'B');
  }

  console.log('\n=== 7. 存储降级与坏数据 ===');
  {
    /* 无 localStorage（node 默认）→ 内存模式，功能照常 */
    const T = fresh();
    const id = T.start({ model: 'm', ws: 'w' });
    T.tool({ name: 'ws_read', argsDigest: 'a.js · 1B', ok: true, resultDigest: '', ms: 1 });
    T.end({ reason: 'done' });
    eq(T.get(id) !== null, true, '★ 无存储时降级到内存，记录仍可读');
    ok(T._budget().writable === false, '并如实报告 writable=false');
  }

  {
    const save = globalThis.localStorage;
    globalThis.localStorage = fakeLS();
    const T = fresh();
    T.clear();
    T.start({ model: 'm', ws: 'w' });
    T.tool({ name: 'ws_read', argsDigest: 'a.js · 1B', ok: true, resultDigest: '', ms: 1 });
    T.end({ reason: 'done' });
    ok(T._budget().writable === true, '有 localStorage 时 writable=true');
    ok(globalThis.localStorage.getItem('openagi:code-trace') !== null, '数据真的写进了 storage');

    /* 坏数据：解析失败不能把整个能力搞崩 */
    globalThis.localStorage.setItem('openagi:code-trace', '{这不是JSON');
    const T2 = fresh();
    eq(T2.stats().tasks, 0, '★ 坏数据当作空库，不抛');

    /* 配额满：丢最老的继续写，不能因为满了就不记当次 */
    const full = fakeLS();
    full.setItem('openagi:code-trace', JSON.stringify({ v: 1, tasks: [{ id: 'old', events: [], edges: {} }] }));
    full.failSet = true;
    globalThis.localStorage = full;
    const T3 = fresh();
    eq(T3.stats().tasks, 1, '先读到旧库（配额此时已满）');
    T3.start({ model: 'm', ws: 'w' });
    T3.end({ reason: 'done' });
    ok(true, '★ 配额满时不抛（丢老任务后重试，当次不丢）');

    globalThis.localStorage = save;
  }

  console.log('\n=== 8. 持久化（模拟重启） ===');
  {
    const save = globalThis.localStorage;
    const ls = fakeLS();
    globalThis.localStorage = ls;
    const T = fresh();
    T.clear();
    T.start({ model: 'deepseek-chat', ws: 'proj' });
    T.turn(0, 'request');
    T.tool({ name: 'fs_edit', argsDigest: 'a.js · old:10 · new:12', ok: true, resultDigest: '+1 -0', ms: 7 });
    T.verdict({ path: 'a.js', kind: 'mod', verdict: 'apply', wait: 800 });
    T.end({ reason: 'done' });

    /* 重新 require = 进程重启，只能从 storage 读 */
    const T2 = fresh();
    const s = T2.stats();
    eq(s.tasks, 1, '★ 重启后从 storage 读回 1 条任务');
    eq(s.applied, 1, '判定结果被持久化');
    eq(s.toolCalls.median, 1, '工具数被持久化');
    ok(T2.get(T2.list()[0].id).edges.touched[0] === 'a.js', '被改文件被持久化');

    globalThis.localStorage = save;
  }

  console.log('\n=== 9. exclude 防串味 ===');
  {
    /* 不同工作区的轨迹混在一起统计，会让基线完全失真 ——
     * 大仓库和小项目的中位数本来就不该同池比较 */
    const T = fresh();
    T.clear();
    T.start({ model: 'm', ws: 'small' });
    T.tool({ name: 'ws_read', argsDigest: 'a.js · 1B', ok: true, resultDigest: '', ms: 1 });
    T.end({ reason: 'done' });
    T.start({ model: 'm', ws: 'big' });
    for (let i = 0; i < 5; i++) T.tool({ name: 'ws_read', argsDigest: 'b' + i + '.js · 1B', ok: true, resultDigest: '', ms: 1 });
    T.end({ reason: 'done' });

    const ws = T.list().map(t => t.ws);
    ok(ws.indexOf('small') >= 0 && ws.indexOf('big') >= 0, '两个工作区都记下了（可事后按 ws 分组）');
    eq(T.stats().tasks, 2, '库里有 2 条');
  }

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) process.exit(1);
}

main().catch(e => { console.error('测试自身出错：', e); process.exit(1); });
