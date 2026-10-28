/* 真实 Electron 客户端里的完整链路验收（走 CDP 连真客户端）：
 *   选本地模型 → 预热 → 模型进显存 → 主进程保活器登记 → 续期成功
 *
 * 为什么用 CDP 而不是 playwright 的 _electron.launch：
 *   后者要求客户端以 --inspect 启动并接管调试端口，与本项目的启动方式不合。
 *   CDP 直接连真客户端，测的是**完整的产品路径**：
 *   渲染进程 → preload 桥 → 主进程 IPC → 11434。
 *
 * 跑法：node tools/e2e-keepalive-electron.js [模型名]
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

const ROOT = path.join(__dirname, '..');
const MODEL = process.argv[2] || 'qwen2.5:3b';
const CDP_PORT = 9333;
let pass = 0, fail = 0;
function check(c, m, x){ if(c){ pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (x?'  → '+x:'')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ps(){
  try{
    const r = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return (d.models || []).map(m => m.name);
  }catch(e){ return []; }
}
async function unload(){
  try{
    await fetch('http://127.0.0.1:11434/api/generate', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ model: MODEL, keep_alive: 0, prompt: '', stream: false }),
      signal: AbortSignal.timeout(60000)
    });
  }catch(e){}
  await sleep(2500);
}

async function waitCdp(port, secs=45){
  const end = Date.now() + secs * 1000;
  while(Date.now() < end){
    try{
      const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
      if(r.ok) return true;
    }catch(e){}
    await sleep(500);
  }
  return false;
}

async function main(){
  console.log('== 真实客户端（CDP）：选模型 → 预热 → 保活 ==');
  await unload();
  console.log('初始驻留: ' + JSON.stringify(await ps()));

  const env = Object.assign({}, process.env);
  // ELECTRON_RUN_AS_NODE 会让 electron.exe 走 Node 模式（不启动应用）
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn('node_modules/electron/dist/electron.exe',
    // ⚠ 开关必须放在应用路径【前面】：electron.exe 把第一个非开关参数当成应用路径，
    //   放在后面会被当成应用自己的 argv，调试端口就不会开（实测连不上）。
    ['--remote-debugging-port=' + CDP_PORT, ROOT],
    { cwd: ROOT, env, stdio: 'ignore', detached: false });

  const alive = await waitCdp(CDP_PORT, 50);
  check(alive, '客户端起来了，CDP 可连');
  if(!alive){
    try{ proc.kill(); }catch(e){}
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT);
  const ctx = browser.contexts()[0];
  let page = ctx.pages()[0];
  if(!page) page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  await sleep(2500);

  const hasBridge = await page.evaluate(() => !!(window.openagiDesktop && typeof window.openagiDesktop.enginesWarm === 'function'));
  check(hasBridge, 'preload 桥可用');
  if(!hasBridge){
    try{ proc.kill(); }catch(e){}
    process.exit(1);
  }

  const picked = await page.evaluate((model) => {
    const s = document.querySelector('#deskAiModel');
    if(!s) return 'no-select';
    const target = 'oll:' + model;
    if(!Array.from(s.options || []).some(o => o.value === target)){
      const o = document.createElement('option');
      o.value = target; o.textContent = model;
      s.appendChild(o);
    }
    s.value = target;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok:' + s.value;
  }, MODEL);
  console.log('选中: ' + picked);

  let resident = [];
  for(let i = 0; i < 12; i++){
    await sleep(2000);
    resident = await ps();
    if(resident.includes(MODEL)) break;
  }
  console.log('驻留: ' + JSON.stringify(resident));
  check(resident.includes(MODEL), '① 模型进了显存');

  const keep = await page.evaluate(async () => {
    const d = window.openagiDesktop;
    if(typeof d.enginesKeepalive !== 'function') return null;
    return await d.enginesKeepalive();
  });
  console.log('保活状态: ' + JSON.stringify(keep));
  check(keep && keep.model === MODEL, '② 主进程保活器登记了这个模型', JSON.stringify(keep));
  check(keep && keep.running === true, '③ 保活定时器在跑');

  const ping = await page.evaluate(async (model) => {
    const d = window.openagiDesktop;
    const r = await d.enginesKeepalivePing({ model: model, force: true });
    const after = await d.enginesKeepalive();
    return { ok: !!(r && r.ok), after };
  }, MODEL);
  console.log('续期结果: ' + JSON.stringify(ping));
  check(ping.ok === true, '④ 手动续期成功');
  check(errors.length === 0, '⑤ 页面无异常', errors.join(' | '));

  try{ await browser.close(); }catch(e){}
  try{ proc.kill(); }catch(e){}
  await sleep(1500);
  await unload();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if(fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
