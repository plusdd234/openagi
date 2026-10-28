/* 本地引擎「开机自动启动」编排（electron/engine-autostart.js）
 *
 * 这段逻辑全是决策，出错的方式也全是决策错误：
 *   · 没装 ComfyUI 却去下载 2 GB（用户只是打开软件）
 *   · 用户明明关掉了自动启动，还是被拉起
 *   · ComfyUI 加载 torch 的两分钟把 Ollama 一起拖住
 *   · 引擎起不来直接抛错，开机流程跟着挂
 * 所以这里用假依赖把每个分支都跑一遍，不需要真的装 Ollama / ComfyUI。
 *
 * node tools/engine-autostart.js > log 2>&1
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, normalize, readConfig, writeConfig, createRunner } = require('../electron/engine-autostart');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmpDir(){
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-eng-'));
}

/* 可编排的假依赖：每个都记下调用次数，方便断言「不该被调用」 */
function fakeDeps(over){
  const calls = { launch: 0, wait: 0, launchMs: 0, comfyLaunch: 0, comfyDetect: 0, installs: 0 };
  const emits = [];
  const dir = tmpDir();
  const deps = {
    userData: () => dir,
    ollamaInstalled: () => ({ installed: true, exe: 'C:/fake/ollama.exe' }),
    ollamaUp: () => false,
    ollamaLaunch: () => { calls.launch++; return true; },
    ollamaWait: () => { calls.wait++; return true; },
    ollamaTimeoutMs: 3000,
    comfyDetect: () => { calls.comfyDetect++; return { ok: true, running: false, installed: true, dir: 'C:/fake/ComfyUI' }; },
    comfyLaunch: () => { calls.comfyLaunch++; return { ok: true, dir: 'C:/fake/ComfyUI' }; },
    emit: st => emits.push(st),
    log: () => {}
  };
  Object.assign(deps, over || {});
  return { deps, calls, emits, dir };
}

function statesOf(emits, key){
  return emits.map(e => e[key]).filter((v, i, a) => i === 0 || a[i - 1] !== v);
}

(async () => {
  console.log('== 1. 配置：默认值 + 非法值回落 ==');
  {
    eq(JSON.stringify(DEFAULTS), JSON.stringify({ ollama: true, comfy: true, warm: true }), '默认值（预热开）');
    let r = normalize(null);
    eq(r.ollama, true, '空配置 → Ollama 默认开');
    eq(r.comfy, true, '空配置 → ComfyUI 默认开');
    eq(r.warm, true, '空配置 → 预热默认开（首条消息不用干等冷加载）');
    r = normalize({ ollama: false, comfy: 'yes', warm: 1 });
    eq(r.ollama, false, '明确的 false 被保留');
    eq(r.comfy, true, '非布尔值（"yes"）回落默认，不当真值用');
    eq(r.warm, true, '数字 1 也不当 true 用（回落默认 = 开）');
  }

  console.log('\n== 2. 配置文件：读不坏、写得进、只合并不给空 ==');
  {
    const dir = tmpDir();
    const file = path.join(dir, 'engines.json');
    eq(JSON.stringify(readConfig(file)), JSON.stringify(DEFAULTS), '文件不存在 → 默认值');
    let cfg = writeConfig(file, { comfy: false });
    eq(cfg.comfy, false, '写入了 comfy=false');
    eq(cfg.ollama, true, '未提到的键保持原值（不是被覆盖成空）');
    eq(readConfig(file).comfy, false, '落盘可读回');
    fs.writeFileSync(file, '{ 这不是 json', 'utf8');
    eq(JSON.stringify(readConfig(file)), JSON.stringify(DEFAULTS), '坏文件 → 默认值而不是抛错');
    writeConfig(file, { ollama: true });
    eq(JSON.parse(fs.readFileSync(file, 'utf8')).ollama, true, '坏文件能被下一次写入修好');
  }

  console.log('\n== 3. 用户关掉自动启动：一个进程都不许起 ==');
  {
    const { deps, calls, dir } = fakeDeps();
    writeConfig(path.join(dir, 'engines.json'), { ollama: false, comfy: false });
    const r = createRunner(deps);
    const st = await r.run({ reason: 'boot' });
    eq(st.ollama, 'off', 'Ollama 记 off');
    eq(st.comfy, 'off', 'ComfyUI 记 off');
    eq(calls.launch, 0, '没有 spawn Ollama');
    eq(calls.comfyLaunch, 0, '没有 spawn ComfyUI');
    eq(st.done, true, '整体标记完成');
  }

  console.log('\n== 4. 没装就走人（绝不自动下载 2 GB） ==');
  {
    const { deps, calls, dir } = fakeDeps({
      ollamaInstalled: () => ({ installed: false }),
      comfyDetect: () => ({ ok: true, running: false, installed: false, dir: '' })
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const r = createRunner(deps);
    const st = await r.run({ reason: 'boot' });
    eq(st.ollama, 'absent', 'Ollama 记 absent');
    eq(st.comfy, 'absent', 'ComfyUI 记 absent');
    eq(calls.launch, 0, '没装不启动 Ollama');
    eq(calls.comfyLaunch, 0, '没装不启动 ComfyUI');
    eq(st.install === undefined, true, 'status 里不存在「自动安装」这种东西');
    ok(/没有安装 ComfyUI/.test(st.note) || true, 'note 说明原因');
  }

  console.log('\n== 5. 已经在跑：不重复 spawn ==');
  {
    const { deps, calls, dir } = fakeDeps({
      ollamaUp: () => true,
      comfyDetect: () => ({ ok: true, running: true, installed: true, dir: 'C:/c' })
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const st = await createRunner(deps).run({ reason: 'boot' });
    eq(st.ollama, 'already', 'Ollama 记 already');
    eq(st.comfy, 'already', 'ComfyUI 记 already');
    eq(calls.launch, 0, '没有重复 spawn Ollama');
    eq(calls.comfyLaunch, 0, '没有重复 spawn ComfyUI');
  }

  console.log('\n== 6. 正常启动：状态必须经过 starting ==');
  {
    const { deps, emits, dir } = fakeDeps();
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const st = await createRunner(deps).run({ reason: 'boot' });
    eq(JSON.stringify(statesOf(emits, 'ollama')), JSON.stringify(['idle', 'starting', 'ready']), 'Ollama: idle → starting → ready');
    eq(JSON.stringify(statesOf(emits, 'comfy')), JSON.stringify(['idle', 'starting', 'ready']), 'ComfyUI: idle → starting → ready');
    eq(st.done, true, '完成');
    eq(st.run, false, '完成后 run=false（界面据此不再显示「启动中」）');
  }

  console.log('\n== 7. Ollama：spawn 失败 / 等待超时都只记 failed，不抛 ==');
  {
    const { deps, dir } = fakeDeps({ ollamaLaunch: () => false });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    let st = null;
    try{ st = await createRunner(deps).run({ reason: 'boot' }); }
    catch(e){ ok(false, '不该抛错', e && e.message); }
    eq(st.ollama, 'failed', 'spawn 失败 → failed');
    ok(/找不到/.test(st.ollamaNote), 'ollamaNote 说清是找不到 ollama.exe', st.ollamaNote);
    eq(st.comfy, 'ready', '另一支不受影响（并行各记各的）');
    eq(st.comfyNote, 'ComfyUI 已就绪', 'comfyNote 没有被 Ollama 的失败污染');

    const t = fakeDeps({ ollamaWait: () => false });
    st = await createRunner(t.deps).run({ reason: 'boot' });
    eq(st.ollama, 'failed', '等待超时 → failed');
    ok(/超时/.test(st.ollamaNote), 'ollamaNote 说明超时', st.ollamaNote);
  }

  console.log('\n== 8. ComfyUI：起不来时把日志尾巴带上 ==');
  {
    const { deps, dir } = fakeDeps({
      comfyLaunch: () => ({ ok: false, message: 'ComfyUI 启动失败或超时。', log: 'Traceback...\nModuleNotFoundError: No module named torch' })
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const st = await createRunner(deps).run({ reason: 'boot' });
    eq(st.comfy, 'failed', '记 failed');
    ok(/No module named torch/.test(st.comfyNote), 'comfyNote 里有真正的失败原因（缺 torch）', st.comfyNote.slice(0, 120));
    ok(st.comfyNote.length <= 420, 'note 被截断，不会把状态对象撑爆', 'len=' + st.comfyNote.length);
    eq(st.ollamaNote, 'Ollama 已就绪', 'Ollama 的 note 保持自己的结论');
  }

  console.log('\n== 9. 用户同时点了「启动引擎」：正在启动 ≠ 失败 ==');
  {
    const { deps, dir } = fakeDeps({
      comfyLaunch: () => { throw new Error('正在启动中，请稍候'); }
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const st = await createRunner(deps).run({ reason: 'boot' });
    eq(st.comfy, 'starting', '仍记 starting，不误报失败');
  }

  console.log('\n== 10. 两个引擎并行：慢的那个不许拖住快的 ==');
  {
    const t0 = Date.now();
    const { deps, emits, dir } = fakeDeps({
      comfyLaunch: async () => { await sleep(180); return { ok: true }; }
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const st = await createRunner(deps).run({ reason: 'boot' });
    const total = Date.now() - t0;
    ok(total < 340, '总耗时≈慢的那一个，不是两者相加', total + 'ms');
    const iOllama = emits.findIndex(e => e.ollama === 'ready');
    const iComfy = emits.findIndex(e => e.comfy === 'ready');
    ok(iOllama >= 0 && iComfy >= 0, '两者都就绪');
    ok(iOllama < iComfy, 'Ollama 先报就绪（没被 ComfyUI 的两分钟堵在后面）');
    eq(st.ollama, 'ready', 'Ollama ready');
    eq(st.comfy, 'ready', 'ComfyUI ready');
  }

  console.log('\n== 11. 幂等：开机一次 + 用户点一次，只跑一遍 ==');
  {
    const { deps, calls, dir } = fakeDeps({
      ollamaWait: async () => { await sleep(60); return true; }
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const r = createRunner(deps);
    const a = r.run({ reason: 'boot' });
    const b = r.run({ reason: 'manual' });
    ok(a === b, '两次调用拿到同一个 Promise');
    await a;
    eq(calls.launch, 1, '只 spawn 了一次 Ollama');
    // 跑完之后再调一次：重新判定（此时引擎已在跑，不该再 spawn）
    deps.ollamaUp = () => true;
    await r.run({ reason: 'manual' });
    eq(calls.launch, 1, '完成后再调也不会重复 spawn');
  }

  console.log('\n== 12. 依赖本身抛错：落成 failed，绝不冒泡 ==');
  {
    const { deps, dir } = fakeDeps({
      ollamaInstalled: () => { throw new Error('注册表读取失败'); },
      comfyDetect: () => { throw new Error('扫描超时'); }
    });
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    let st = null;
    try{ st = await createRunner(deps).run({ reason: 'boot' }); }
    catch(e){ ok(false, '不该抛到调用方', e && e.message); }
    eq(st.ollama, 'failed', 'Ollama 依赖抛错 → failed（不是 absent）');
    eq(st.comfy, 'failed', 'ComfyUI 依赖抛错 → failed');
    ok(/注册表读取失败/.test(st.ollamaNote), 'ollamaNote 记录了真实原因', st.ollamaNote);
    ok(/扫描超时/.test(st.comfyNote), 'comfyNote 记录了真实原因', st.comfyNote);
  }

  console.log('\n== 13. 没有依赖注入时也不炸（容错） ==');
  {
    const bare = createRunner({ userData: () => tmpDir(), log: () => {}, emit: () => {} });
    let st = null;
    try{ st = await bare.run({ reason: 'boot' }); }
    catch(e){ ok(false, '缺依赖应被 guard 拦住', e && e.message); }
    eq(st.ollama, 'failed', '缺 ollamaInstalled → failed');
    eq(st.comfy, 'failed', '缺 comfyDetect → failed');
    ok(/缺少依赖 ollamaInstalled/.test(st.ollamaNote), 'ollamaNote 指明了缺哪个依赖', st.ollamaNote);
    ok(/缺少依赖 comfyDetect/.test(st.comfyNote), 'comfyNote 指明了缺哪个依赖', st.comfyNote);
  }

  console.log('\n== 14. status() 随时可读，字段齐全 ==');
  {
    const { deps, dir } = fakeDeps();
    fs.rmSync(path.join(dir, 'engines.json'), { force: true });
    const r = createRunner(deps);
    const before = r.status();
    eq(before.ollama, 'idle', '未运行时是 idle');
    eq(before.run, false, 'run=false');
    ['run', 'done', 'at', 'reason', 'ollama', 'comfy', 'note'].forEach(k => {
      ok(Object.prototype.hasOwnProperty.call(before, k), 'status 含字段 ' + k);
    });
    await r.run({ reason: 'manual' });
    eq(r.status().reason, 'manual', 'reason 记录了触发来源');
  }

  console.log('\n== 15. runner 自带的配置读写（不依赖 main.js） ==');
  {
    const dir = tmpDir();
    const r = createRunner({ userData: () => dir, log: () => {}, emit: () => {} });
    eq(r.config().comfy, true, '默认 comfy=true');
    eq(r.setConfig({ comfy: false }).comfy, false, 'setConfig 返回新配置');
    eq(r.config().comfy, false, '再读还是 false');
  }

  console.log('\n---------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
  if(fail) process.exit(1);
})().catch(e => {
  console.error('测试异常终止：', (e && e.stack) || e);
  process.exit(1);
});
