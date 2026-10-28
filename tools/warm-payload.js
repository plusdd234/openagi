/* 验证「预热请求的 payload」真的能让模型驻留（模拟主进程 engines:warm 的请求）。
 * 跑法：node tools/warm-payload.js
 *
 * 这个测试存在的理由：早期版本的预热请求漏了 options.num_predict = 0，
 * Ollama 会真的去生成 token；加上前端重复调度，
 * 就出现「预热打 9 次、模型始终没驻留」的现象。
 * 这里把两种 payload 各跑一遍，把差异钉死。
 */
'use strict';

const BASE = 'http://127.0.0.1:11434';
const MODEL = process.argv[2] || 'qwen2.5:3b';
let pass = 0, fail = 0;
function check(c, m, x){ if(c){ pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (x?'  → '+x:'')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gen(body, timeout=300000){
  const res = await fetch(BASE + '/api/generate', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  return { status: res.status, json: await res.json() };
}
async function resident(){
  try{
    const r = await fetch(BASE + '/api/ps', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return (d.models || []).map(m => m.name);
  }catch(e){ return []; }
}
async function unload(){
  try{ await gen({ model: MODEL, keep_alive: 0, prompt: '', stream: false }, 60000); }catch(e){}
  await sleep(2500);
}

async function main(){
  console.log('== 预热 payload 对模型驻留的影响 ==');

  /* ---- A 不带 num_predict（旧写法）---- */
  console.log('\n[A 不带 num_predict（旧写法）]');
  await unload();
  check(!(await resident()).includes(MODEL), '清场');
  let t0 = Date.now();
  let r = await gen({ model: MODEL, prompt: '', keep_alive: '30m', stream: false });
  console.log('  耗时 ' + ((Date.now()-t0)/1000).toFixed(2) + 's  done_reason=' + r.json.done_reason +
              '  response=' + JSON.stringify((r.json.response || '').slice(0, 30)));
  await sleep(1500);
  let res = await resident();
  console.log('  驻留: ' + JSON.stringify(res));
  check(res.includes(MODEL), '模型也进了显存（所以问题不在驻留，而在慢和重复）');

  /* ---- B 带 num_predict=0（新写法）---- */
  console.log('\n[B 带 num_predict: 0（新写法）]');
  await unload();
  check(!(await resident()).includes(MODEL), '清场');
  t0 = Date.now();
  r = await gen({ model: MODEL, prompt: '', keep_alive: '30m', stream: false, options: { num_predict: 0 } });
  console.log('  耗时 ' + ((Date.now()-t0)/1000).toFixed(2) + 's  done_reason=' + r.json.done_reason +
              '  response=' + JSON.stringify(r.json.response || ''));
  await sleep(1500);
  res = await resident();
  console.log('  驻留: ' + JSON.stringify(res));
  check(res.includes(MODEL), '模型进显存');
  check(r.json.done_reason === 'load', 'done_reason=load（纯加载，没生成）', String(r.json.done_reason));
  check((r.json.response || '') === '', '没有产出任何 token');

  /* ---- C 重复请求不会把模型踢掉 ---- */
  console.log('\n[C 连续 3 次预热：模型应当始终驻留]');
  const marks = [];
  for(let i = 0; i < 3; i++){
    await gen({ model: MODEL, prompt: '', keep_alive: '30m', stream: false, options: { num_predict: 0 } });
    await sleep(800);
    marks.push((await resident()).includes(MODEL));
  }
  console.log('  每次之后是否驻留: ' + JSON.stringify(marks));
  check(marks.every(Boolean), '连续预热不会把模型踢出显存（这正是早期「预热 9 次却没驻留」的原因）');

  await unload();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if(fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
