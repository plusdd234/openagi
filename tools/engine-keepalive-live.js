/* 保活器 × 真实 Ollama 端到端（node 直跑，不起 Electron）
 * 跑法：node tools/engine-keepalive-live.js
 *
 * 验证：保活器对着真实的 11434 端口工作正常
 *   ① resident 查询准确（模型在/不在显存里）
 *   ② 对已在显存里的模型续期 → expires_at 被推后
 *   ③ 对不在显存里的模型 → 走加载路径
 *   ④ 换模型 → 旧的被卸载
 */
'use strict';
const { createKeeper } = require('../electron/engine-keepalive.js');

const BASE = 'http://127.0.0.1:11434';
let pass = 0, fail = 0;
function check(c, m, x){ if(c){ pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (x?'  → '+x:'')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(path, body, timeout=300000){
  const res = await fetch(BASE + path, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  return await res.json();
}
async function ps(){
  try{
    const res = await fetch(BASE + '/api/ps', { signal: AbortSignal.timeout(5000) });
    return await res.json();
  }catch(e){ return { models: [] }; }
}
/* ⚠ ps() 是 async，返回的是 Promise —— 必须 await 才能拿到 .models。
 *   第一版这里写成 `ps().models||[]`，拿到的是 undefined，
 *   于是「模型没进显存」的假象出现了（查了一轮才发现是测试自己的 bug）。 */
async function names(){
  const d = await ps();
  return (d.models||[]).map(m => m.name);
}

async function main(){
  console.log('== 保活器 × 真实 Ollama ==');
  const MODEL = process.argv[2] || 'qwen2.5:3b';

  // 清场：卸载目标模型
  try{ await post('/api/generate', { model: MODEL, keep_alive: 0, prompt:'', stream:false }, 60000); }catch(e){}
  await sleep(2500);
  check(!(await names()).includes(MODEL), '清场：模型不在显存里', JSON.stringify(await names()));

  /* ---- 构造一个对着真实端口的保活器 ---- */
  const keeper = createKeeper({
    ping: async (m, ka) => {
      const t0 = Date.now();
      const r = await post('/api/generate', {
        model: m, prompt:'', keep_alive: ka, stream:false, options:{ num_predict: 0 }
      }, 300000);
      return { ok: !r.error, ms: Date.now() - t0 };
    },
    unload: async (m) => { try{ await post('/api/generate', { model:m, keep_alive:0, prompt:'', stream:false }, 60000); }catch(e){} },
    resident: async (m) => {
      const d = await ps();
      return (d.models||[]).some(x => x.name === m || x.name === m + ':latest');
    },
    log: m => console.log('    [log] ' + m)
  });

  /* ---- ① 模型不在显存里 → 保活器应当加载它 ---- */
  console.log('\n[① 不在显存 → 加载]');
  keeper.setModel(MODEL);
  const t0 = Date.now();
  const ok1 = await keeper.pingOnce();
  console.log('  pingOnce 耗时 ' + ((Date.now()-t0)/1000).toFixed(2) + 's');
  check(ok1 === true, 'pingOne 成功');
  // ⚠ 必须等一下：Ollama 的响应先回来，/api/ps 里登记模型稍晚（实测差几十毫秒）。
  //    少了这个 sleep 会误判成「没加载进去」——第一版测试就栽在这。
  await sleep(1500);
  check((await names()).includes(MODEL), '模型已进显存', JSON.stringify(await names()));

  /* ---- ② 已驻留 → 续期把 expires_at 推后 ---- */
  console.log('\n[② 已驻留 → 续期推后 expires_at]');
  const before = (await ps()).models.find(m => m.name === MODEL);
  console.log('  续期前 expires_at = ' + (before && before.expires_at));
  await sleep(3000);
  const t1 = Date.now();
  const ok2 = await keeper.pingOnce();
  const ms2 = Date.now() - t1;
  await sleep(1500);
  const after = (await ps()).models.find(m => m.name === MODEL);
  console.log('  续期后 expires_at = ' + (after && after.expires_at) + '（耗时 ' + ms2 + 'ms）');
  check(ok2 === true, '续期成功');
  check(ms2 < 3000, '续期很快（' + ms2 + 'ms，不是一次冷加载）');
  const tB = Date.parse(before && before.expires_at), tA = Date.parse(after && after.expires_at);
  check(tA > tB, 'expires_at 被推后了', (before && before.expires_at) + ' → ' + (after && after.expires_at));

  /* ---- ③ 换模型 → 旧的被卸载 ---- */
  console.log('\n[③ 换模型 → 旧的卸载]');
  const OTHER = 'qwen3-vl:8b-cpu';
  keeper.setModel(OTHER);
  await sleep(3000);
  const now = await names();
  check(!now.includes(MODEL), '旧模型已卸载（防显存泄漏）', JSON.stringify(now));

  // 清场
  try{ await post('/api/generate', { model: OTHER, keep_alive: 0, prompt:'', stream:false }, 60000); }catch(e){}
  try{ await post('/api/generate', { model: MODEL, keep_alive: 0, prompt:'', stream:false }, 60000); }catch(e){}
  await sleep(1500);

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if(fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
