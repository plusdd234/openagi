/* engine-keepalive 的单元测试（node 直跑，不用 Electron）
 * 跑法：node tools/engine-keepalive.js
 *
 * 覆盖：配置归一化 / 续期成功失败 / 驻留判断（关键：不在显存里才允许冷加载）/
 *       换模型卸旧的 / 失败达上限就放弃。
 */
'use strict';
const path = require('path');
const { createKeeper, DEFAULTS, normalize } = require(path.join(__dirname, '..', 'electron', 'engine-keepalive.js'));

let pass = 0, fail = 0;
function check(cond, msg, extra){
  if(cond){ pass++; console.log('  ok  ' + msg); }
  else{ fail++; console.log('  FAIL ' + msg + (extra ? '  → ' + extra : '')); }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function main(){
  console.log('== engine-keepalive ==');

  /* ---- 配置归一化 ---- */
  console.log('\n[配置归一化]');
  let n = normalize({});
  check(n.intervalMs === DEFAULTS.intervalMs && n.keepAlive === DEFAULTS.keepAlive,
    '空配置 → 全部用默认值');
  n = normalize({ intervalMs: -5, keepAlive: 'abc', maxMisses: 0 });
  check(n.intervalMs === DEFAULTS.intervalMs, '负数 intervalMs → 回落默认');
  check(n.keepAlive === DEFAULTS.keepAlive, '非法 keepAlive → 回落默认');
  check(n.maxMisses === DEFAULTS.maxMisses, '0 maxMisses → 回落默认（不能是 0，否则一次失败就放弃）');
  n = normalize({ intervalMs: 1000, keepAlive: '5m', maxMisses: 2 });
  check(n.intervalMs === 1000 && n.keepAlive === '5m' && n.maxMisses === 2, '合法值原样保留');
  check(normalize(null).intervalMs === DEFAULTS.intervalMs, 'null → 默认值');

  /* ---- 续期成功 / 失败 ---- */
  console.log('\n[续期]');
  let calls = [];
  let k = createKeeper({
    ping: async (m, ka) => { calls.push({ m, ka }); return { ok: true }; },
    log: () => {}
  });
  k.setModel('qwen2.5:3b');
  check(k.model === 'qwen2.5:3b', 'setModel 记住了模型');
  let ok = await k.pingOnce();
  check(ok === true, 'pingOnce 成功');
  check(calls.length === 1 && calls[0].m === 'qwen2.5:3b', 'ping 收到了正确的模型名');
  check(calls[0].ka === DEFAULTS.keepAlive, 'ping 收到了 keep_alive');
  check(k.status().fails === 0, '成功后失败计数归零');
  check(k.status().lastOkAt > 0, '成功后记下了 lastOkAt');

  let failCount = 0;
  k = createKeeper({
    ping: async () => { failCount++; return { ok: false }; },
    log: () => {}
  });
  k.setModel('m1');
  await k.pingOnce();
  await k.pingOnce();
  check(failCount === 2, '失败也照发（不吞）');
  check(k.status().fails === 2, '失败计数累加');

  /* ---- 驻留判断：关键行为 ---- */
  console.log('\n[驻留判断 —— 冷加载 vs 续期]');
  let pingCalls = [];
  let residentVal = true;
  k = createKeeper({
    ping: async (m) => { pingCalls.push(m); return { ok: true }; },
    resident: async () => residentVal,
    log: () => {}
  });
  k.setModel('m1');
  await k.pingOnce();
  check(pingCalls.length === 1, '已驻留 → 仍然发续期请求（把 expires_at 推后）');

  // resident 抛异常 → 应当当作「不在」→ 走加载路径（仍然发 ping，但要区分）
  pingCalls = [];
  k = createKeeper({
    ping: async (m) => { pingCalls.push(m); return { ok: true }; },
    resident: async () => { throw new Error('查不到'); },
    log: () => {}
  });
  k.setModel('m1');
  await k.pingOnce();
  check(pingCalls.length === 1, '查不到驻留状态 → 仍然保证模型被加载（宁可多加载也不漏）');

  // 没注入 resident → 直接续期，不额外判断（保持向后兼容）
  pingCalls = [];
  k = createKeeper({ ping: async (m) => { pingCalls.push(m); return { ok: true }; }, log: () => {} });
  k.setModel('m1');
  await k.pingOnce();
  check(pingCalls.length === 1, '没注入 resident → 照常续期');

  /* ---- 换模型卸旧的 ---- */
  console.log('\n[换模型]');
  const unloaded = [];
  k = createKeeper({
    ping: async () => ({ ok: true }),
    unload: async (m) => { unloaded.push(m); },
    log: () => {}
  });
  k.setModel('old');
  k.setModel('new');
  await sleep(10);
  check(unloaded.length === 1 && unloaded[0] === 'old', '换模型 → 旧的被卸载（防显存泄漏）');
  check(k.model === 'new', '换模型 → 目标变成新模型');

  unloaded.length = 0;
  k.setModel('new');
  await sleep(10);
  check(unloaded.length === 0, '设成同一个模型 → 不卸载（别把自己卸了）');

  /* ---- 登记即保活（关键行为）----
   * 语义：「把模型登记进保活器」= 「从现在起保活它」。
   * 只登记不启动的话，模型会在一个 TTL 后被卸载，
   * 而界面上还显示「已登记」——实际早没保活了。 */
  console.log('\n[登记即保活]');
  k = createKeeper({ ping: async () => ({ ok: true }), log: () => {} });
  k.setModel('m1');
  check(k.running === true, 'setModel 之后保活器自动启动');
  k.setModel('m1');
  check(k.running === true, '重复 setModel 同一个模型 → 保活器仍在跑');
  k.stop();
  k.setModel('m2');
  check(k.running === true, '停掉之后重新登记 → 又活过来了');
  k.stop();

  /* ---- 定时续期 ---- */
  console.log('\n[定时续期]');
  let ticks = 0;
  k = createKeeper({
    ping: async () => { ticks++; return { ok: true }; },
    intervalMs: 40,
    log: () => {}
  });
  k.setModel('m1');
  k.start();
  check(k.running === true, 'start 之后 running 为真');
  await sleep(140);
  check(ticks >= 2, '定时器在按间隔续期（实测 ' + ticks + ' 次）');
  k.stop();
  check(k.running === false, 'stop 之后 running 为假');
  const after = ticks;
  await sleep(90);
  check(ticks === after, 'stop 之后不再续期');

  /* ---- 连续失败达上限就放弃 ---- */
  console.log('\n[失败放弃]');
  let n2 = 0;
  k = createKeeper({
    ping: async () => { n2++; return { ok: false }; },
    intervalMs: 30,
    maxMisses: 2,
    log: () => {}
  });
  k.setModel('m1');
  k.start();
  await sleep(400);
  check(k.running === false, '连续失败达上限 → 自动放弃续期（引擎多半已退出）');
  check(n2 <= 6, '放弃后不再继续打（实测 ' + n2 + ' 次）');

  /* ---- 无 ping 注入时 start 应安全返回 ---- */
  console.log('\n[边界]');
  k = createKeeper({});
  check(k.start() === false, '没有 ping → start 返回 false（不崩）');
  check((await k.pingOnce()) === false, '没有 ping → pingOnce 返回 false');
  k = createKeeper({ ping: async () => ({ ok: true }) });
  check(k.setModel('') === false, '空模型名 → setModel 返回 false');
  check(k.setModel('   ') === false, '空白模型名 → setModel 返回 false');

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if(fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
