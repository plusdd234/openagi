/* Ollama 拉取进度（js/provider.js 的 pullModel）
 *
 * 现场：模型商店里点「安装」拉 LLaVA 7B，卡片一直显示
 *   「pulling 170370233dd5」+ 一根 0% 的空进度条 + 灰掉的「下载中…」
 * 用户以为点了没反应。根因是进度判定写错了字段：
 *
 *   老代码： if(ev.status === 'downloading' && ev.digest) { ...算百分比... }
 *   实际：   Ollama 0.40 全程不发 "downloading"，下载中的 status 一直是
 *            "pulling <digest 前 12 位>"（见 fixtures/ollama-pull-0.40.ndjson，
 *            那是本机真实抓包，144 条事件里 0 条 downloading）。
 *           于是 pct 恒为 -1 → 进度条恒 0% → 界面只剩原始状态串。
 *
 * 还守着几个一起踩到的坑：
 *   · 每层开头十几个事件只有 total 没有 completed，缺字段当成 0 会把进度打回起点；
 *   · 多层模型的 completed/total 要按 digest 分别累加，否则百分比来回跳；
 *   · 重连时 completed 会短暂回退，百分比必须单调不减；
 *   · {"error": "..."} 事件不抛出来，界面会永远停在「下载中」；
 *   · 流的最后一行常常没有换行符（success 就在里面），丢了就永远到不了 100%。
 *
 * node tools/pull-progress.js > log 2>&1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'provider.js'), 'utf8');
const RealDate = Date;

/* 在沙箱里跑 provider.js：fetch 换成假流，Date.now 换成可控时钟。
 * 时钟必须可控——真实事件在几百毫秒内跑完，速度采样窗口是 500ms，
 * 不推进时钟就永远算不出速度，测不出「有没有速度显示」。 */
function makeSandbox(raw, o){
  const opt = o || {};
  const chunk = opt.chunk || 97;
  const msPerChunk = opt.msPerChunk || 50;
  let fakeMs = 1700000000000;
  let idx = 0;

  function FakeDate(...a){ return a.length ? new RealDate(...a) : new RealDate(fakeMs); }
  FakeDate.now = () => fakeMs;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const text = opt.dropTailNewline ? raw.replace(/\n$/, '') : raw;
  const parts = [];
  const enc = new TextEncoder();
  for(let i = 0; i < text.length; i += chunk) parts.push(enc.encode(text.slice(i, i + chunk)));

  const makeStream = () => new ReadableStream({
    pull(c){
      if(idx >= parts.length){ c.close(); return; }
      fakeMs += msPerChunk;          // 每送出一片就往前推时钟
      c.enqueue(parts[idx++]);
    }
  });

  const sandbox = {
    console, JSON, Math, Number, String, Object, Array, Promise,
    Date: FakeDate, setTimeout, clearTimeout, isFinite, isNaN,
    location: { search: '' },
    $: id => ({ value: '' }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: makeStream() }),
    TextDecoder, TextEncoder, ReadableStream, AbortController,
    FormData: class { append(){} },
    FileReader: class { readAsDataURL(){} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'provider.js' });
  return sandbox;
}

async function pull(sandbox, name){
  const p = sandbox.providerFor('llm', 'ollama-llm');
  const events = [];
  let err = null;
  try{
    await p.pullModel(name || 'all-minilm', e => events.push(e));
  }catch(e){
    err = e;
  }
  return { events, err, p };
}

function ndjson(list){
  return list.map(x => JSON.stringify(x)).join('\n') + '\n';
}

(async () => {

  /* ---------- 1. 真实抓包重放（本次修复的核心证据） ---------- */
  console.log('\n=== 1. 真实事件流（Ollama 0.40 / all-minilm） ===');
  {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'ollama-pull-0.40.ndjson'), 'utf8');
    // 每个事件都故意切在 JSON 中间，顺带守「分片边界不能丢行」
    const sb = makeSandbox(raw, { chunk: 97, msPerChunk: 50 });
    const { events, err } = await pull(sb);

    ok(!err, '拉取正常结束', err && err.message);
    ok(events.length > 50, '逐条事件都到达（分片切断不影响解析）', events.length + ' 条');

    // 老代码守卫：真实流里一条 downloading 都没有，任何一条事件都不该是 pct<0 的裸状态
    const withPct = events.filter(e => typeof e.pct === 'number' && e.pct >= 0);
    ok(withPct.length > events.length * 0.4, '大部分事件都带百分比（老代码这里是 0 条）',
      withPct.length + ' / ' + events.length);

    ok(withPct.every(e => !/^pulling\s+[0-9a-f]{8,}$/i.test(e.message || '')),
      '不再把原始「pulling <digest>」直接透给用户',
      (withPct.find(e => /^pulling\s/i.test(e.message || '')) || {}).message);

    ok(withPct.some(e => /%/.test(e.message || '')), '文案里带百分比',
      (withPct.find(e => /%/.test(e.message || '')) || {}).message);

    const mono = withPct.every((e, i) => i === 0 || e.pct >= withPct[i - 1].pct);
    ok(mono, '百分比单调不减', withPct.map(e => e.pct).join(',').slice(0, 60));

    eq(withPct[withPct.length - 1].pct, 100, '最后一条是 100%');

    const spd = events.filter(e => e.speed > 0);
    ok(spd.length > 0, '算出了下载速度', spd.length ? Math.round(spd[spd.length - 1].speed) + ' B/s' : '全 0');
    ok(events.some(e => e.etaMs > 0), '估算出剩余时间',
      (events.find(e => e.etaMs > 0) || {}).etaMs);

    ok(/下载完成/.test(events[events.length - 1].message || ''), '结束时是「下载完成」',
      events[events.length - 1].message);
  }

  /* ---------- 2. completed 缺字段不能当 0 ---------- */
  console.log('\n=== 2. 只有 total、没有 completed 的事件 ===');
  {
    const raw = ndjson([
      { status: 'pulling manifest' },
      { status: 'pulling aaa', digest: 'd1', total: 100, completed: 50 },
      { status: 'pulling aaa', digest: 'd1', total: 100 },
      { status: 'pulling aaa', digest: 'd1', total: 100 }
    ]);
    const { events } = await pull(makeSandbox(raw, { chunk: 40 }));
    const after = events.slice(2);
    ok(after.every(e => e.pct === 50), '缺 completed 时沿用该层已有进度，不回落到 0',
      after.map(e => e.pct).join(','));
  }

  /* ---------- 3. 重连导致的回退 ---------- */
  console.log('\n=== 3. completed 短暂回退 ===');
  {
    const raw = ndjson([
      { status: 'pulling aaa', digest: 'd1', total: 100, completed: 50 },
      { status: 'pulling aaa', digest: 'd1', total: 100, completed: 30 },
      { status: 'pulling aaa', digest: 'd1', total: 100, completed: 70 }
    ]);
    const { events } = await pull(makeSandbox(raw, { chunk: 40 }));
    eq(events.map(e => e.pct).join(','), '50,50,70', '百分比只增不减');
  }

  /* ---------- 4. 多层按 digest 累加 ---------- */
  console.log('\n=== 4. 多层模型的总进度 ===');
  {
    const raw = ndjson([
      { status: 'pulling a', digest: 'd1', total: 100, completed: 100 },
      { status: 'pulling b', digest: 'd2', total: 300, completed: 0 },
      { status: 'pulling b', digest: 'd2', total: 300, completed: 150 }
    ]);
    const { events } = await pull(makeSandbox(raw, { chunk: 40 }));
    eq(events[1].pct, 25, '第一层下完但第二层没开始：按总量算 25%');
    eq(events[2].pct, 63, '两层各半：62.5% 取整成 63%');   // 250/400
  }

  /* ---------- 5. error 事件必须抛出来 ---------- */
  console.log('\n=== 5. {"error":...} 事件 ===');
  {
    const raw = ndjson([
      { status: 'pulling manifest' },
      { error: 'pull model manifest: file does not exist' }
    ]);
    const { err, events } = await pull(makeSandbox(raw, { chunk: 30 }), 'nope');
    ok(!!err, '拉取失败会 reject，而不是一直挂着');
    ok(/does not exist/.test(String(err && err.message)), '错误原文透给用户',
      err && err.message);
    ok(events.length >= 1, '出错前的事件仍然回放过', events.length);
  }

  /* ---------- 6. 最后一行没有换行符 ---------- */
  console.log('\n=== 6. 流末尾缺换行（success 常常就在这一包） ===');
  {
    const raw = ndjson([
      { status: 'pulling aaa', digest: 'd1', total: 100, completed: 90 },
      { status: 'success' }
    ]);
    const { events } = await pull(makeSandbox(raw, { chunk: 25, dropTailNewline: true }));
    const last = events[events.length - 1] || {};
    eq(last.pct, 100, '末尾事件没被丢掉，进度到 100%');
    ok(/下载完成/.test(last.message || ''), '文案是「下载完成」', last.message);
  }

  /* ---------- 7. 文案映射 ---------- */
  console.log('\n=== 7. 各阶段文案 ===');
  {
    const raw = ndjson([
      { status: 'pulling manifest' },
      { status: 'pulling aaa', digest: 'd1', total: 100, completed: 40 },
      { status: 'verifying sha256 digest' },
      { status: 'writing manifest' },
      { status: 'removing any unused layers' },
      { status: 'success' }
    ]);
    const { events } = await pull(makeSandbox(raw, { chunk: 40 }));
    const msgs = events.map(e => e.message).join(' | ');
    ok(/读取模型清单/.test(msgs), 'pulling manifest → 读取模型清单…', msgs);
    ok(/校验文件完整性/.test(msgs), 'verifying → 校验文件完整性…', msgs);
    ok(/写入模型清单/.test(msgs), 'writing manifest → 写入模型清单…', msgs);
    ok(/清理旧文件/.test(msgs), 'removing → 清理旧文件…', msgs);
    ok(!/pulling [0-9a-f]{8,}/i.test(msgs), '任何阶段都不出现裸 digest', msgs);
  }

  /* ---------- 8. 引擎卡死：不能一直显示「下载中」 ---------- */
  console.log('\n=== 8. 流卡住不动（停滞看门狗） ===');
  {
    const sb = makeSandbox('', { chunk: 10 });
    // 假引擎：连上了，但一个字节都不发，也不关闭
    sb.fetch = async (url, init) => {
      let ctl = null;
      const body = new ReadableStream({
        start(c){ ctl = c; },
        pull(){ return new Promise(() => {}); }
      });
      if(init && init.signal){
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          try{ ctl.error(e); }catch(_){}
        });
      }
      return { ok: true, status: 200, body };
    };
    let err = null;
    const guard = new Promise(r => setTimeout(() => r('timeout'), 5000));
    const run = sb.rtFetchStream('/ollama/api/pull', { stallMs: 300 }, () => {}).then(
      () => '', e => e);
    const got = await Promise.race([run, guard]);
    if(got === 'timeout') ok(false, '卡住时能自己退出（否则测试会一直挂着）');
    else { err = got; ok(!!err && /没有任何响应/.test(String(err.message)), '卡住时抛出明确错误，不再干等一小时',
      err && err.message); }
  }

  /* ---------- 9. 卸载模型用的 HTTP 方法 ---------- */
  console.log('\n=== 9. deleteModel（卸载） ===');
  {
    const sb = makeSandbox('', { chunk: 10 });
    const calls = [];
    let queue = [];
    sb.fetch = async (url, init) => {
      calls.push(String((init && init.method) || 'GET') + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
      const r = queue.shift() || { status: 200, body: {} };
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body || {}
      };
    };
    const p = sb.providerFor('llm', 'ollama-llm');

    // 正常：只需要一次 DELETE
    calls.length = 0; queue = [{ status: 200, body: {} }];
    let err = null;
    try{ await p.deleteModel('llava:7b'); }catch(e){ err = e; }
    ok(!err, '正常卸载不报错', err && err.message);
    eq(calls.join(' | '), 'DELETE /ollama/api/delete',
      '用 DELETE 而不是 POST（Ollama 0.40 对 POST 直接回 405）');

    // 老版本只认 POST：405 时回退
    calls.length = 0; queue = [{ status: 405, body: {} }, { status: 200, body: {} }];
    err = null;
    try{ await p.deleteModel('llava:7b'); }catch(e){ err = e; }
    ok(!err, '405 时回退 POST 并成功', err && err.message);
    eq(calls.length, 2, '回退只重试一次');

    // 本来就没有：按成功处理
    calls.length = 0; queue = [{ status: 404, body: { error: "model 'x' not found" } }];
    err = null;
    try{ await p.deleteModel('x'); }catch(e){ err = e; }
    ok(!err, '模型本来就不存在时也算卸载成功', err && err.message);
    eq(calls.length, 1, '404 不触发 POST 回退（否则错误会变成 405，更难懂）');

    // 真正的错误要抛出来
    calls.length = 0; queue = [{ status: 500, body: { error: 'disk busy' } }];
    err = null;
    try{ await p.deleteModel('llava:7b'); }catch(e){ err = e; }
    ok(!!err && /disk busy/.test(String(err.message)), '其他错误照常抛出', err && err.message);
  }

  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  if(fail) process.exit(1);
})();
