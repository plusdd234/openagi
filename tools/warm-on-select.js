/* 端到端：用户在客户端里选一个本地模型 → 预热自动发生 → 模型进显存。
 *
 * 这是「首次使用」场景的关键路径：
 *   新装客户端 → hf_desk_model 根本没设过 → 启动时没模型可预热（这是对的）
 *   → 用户在对话里选了本地模型 → 必须立刻预热
 *   → 否则第一次提问照样冷加载 → 照样闪黑窗口
 *
 * ⚠ 为什么要走 Node 侧代理：
 *   页面 origin 是 file://，跨域 POST 会先发 OPTIONS 预检，
 *   直连 http://127.0.0.1:11434 被 CORS 拦掉（实测 "TypeError: Failed to fetch"）。
 *   真实客户端里预热走主进程 IPC（engines:warm），主进程 fetch 不受 CORS 限制。
 *   所以这里在 Node 侧起一个小代理，让页面通过它转发，模拟主进程的行为。
 *
 * 跑法：node tools/warm-on-select.js [模型名]
 */
'use strict';
const path = require('path');
const http = require('http');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

const ROOT = path.join(__dirname, '..');
const MODEL = process.argv[2] || 'qwen2.5:3b';
const OLLAMA = 'http://127.0.0.1:11434';

let pass = 0, fail = 0;
function check(c, m, x){ if(c){ pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (x?'  → '+x:'')); } }

async function ps(){
  try{
    const r = await fetch(OLLAMA + '/api/ps', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return (d.models || []).map(m => m.name);
  }catch(e){ return []; }
}
async function unload(){
  try{
    await fetch(OLLAMA + '/api/generate', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ model: MODEL, keep_alive: 0, prompt: '', stream: false }),
      signal: AbortSignal.timeout(60000)
    });
  }catch(e){}
  await new Promise(r => setTimeout(r, 2500));
}

/* 模拟主进程 engines:warm：转发到 11434，并记录调用次数与返回。
 * ⚠ 必须处理 OPTIONS 预检：页面 origin 是 file://，跨域 POST 会先发预检；
 *   不处理的话真正的 POST 根本到不了（实测表现为「model '' not found」——
 *   body 是空的，因为只收到了预检请求）。 */
function startProxy(stats){
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
  const srv = http.createServer((req, res) => {
    if(req.method === 'OPTIONS'){
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try{ payload = JSON.parse(body || '{}'); }catch(e){}
      if(req.url === '/warm'){
        stats.warm.push(payload.model);
        const t0 = Date.now();
        try{
          const r = await fetch(OLLAMA + '/api/generate', {
            method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify({
              model: payload.model, prompt: '', keep_alive: '30m',
              stream: false, options: { num_predict: 0 }
            }),
            signal: AbortSignal.timeout(300000)
          });
          const j = await r.json();
          stats.results.push({ model: payload.model, done: j.done_reason,
                               err: j.error || '', ms: Date.now() - t0 });
          res.writeHead(200, Object.assign({'content-type':'application/json'}, CORS));
          res.end(JSON.stringify({ ok: !j.error, model: payload.model }));
        }catch(e){
          stats.results.push({ model: payload.model, error: String(e) });
          res.writeHead(200, Object.assign({'content-type':'application/json'}, CORS));
          res.end(JSON.stringify({ ok: false, message: String(e) }));
        }
        return;
      }
      res.writeHead(404, CORS);
      res.end('{}');
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function main(){
  console.log('== 选模型 → 自动预热（端到端，走主进程代理）==');

  await unload();
  console.log('初始驻留: ' + JSON.stringify(await ps()));
  check(!(await ps()).includes(MODEL), '清场：模型不在显存里');

  const stats = { warm: [], results: [] };
  const srv = await startProxy(stats);
  const port = srv.address().port;

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));

  await page.addInitScript((proxyPort) => {
    const calls = { warm: [], ping: [] };
    window.__calls = calls;
    window.openagiDesktop = {
      enginesStatus: async () => ({ ollama: 'already', comfy: 'idle', run: true, done: true }),
      enginesConfig: async () => ({ ollama: true, comfy: true, warm: true }),
      enginesSetConfig: async () => ({}),
      enginesAutoStart: async () => ({}),
      enginesWarm: async (req) => {
        calls.warm.push(req && req.model);
        const r = await fetch('http://127.0.0.1:' + proxyPort + '/warm', {
          method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify(req || {})
        });
        return await r.json();
      },
      enginesKeepalive: async () => ({ model: '', running: false }),
      enginesKeepalivePing: async (req) => {
        calls.ping.push(req && req.model);
        return { ok: true };
      },
      onEngineStatus: () => {}
    };
  }, port);

  const url = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html?nostore=1';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

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

  await page.waitForTimeout(14000);

  const calls = await page.evaluate(() => window.__calls);
  const resident = await ps();
  console.log('预热调用: ' + JSON.stringify(calls.warm));
  console.log('保活登记: ' + JSON.stringify(calls.ping));
  console.log('预热详情: ' + JSON.stringify(stats.results));
  console.log('预热后驻留: ' + JSON.stringify(resident));
  console.log('页面异常: ' + (errors.length ? errors.join(' | ') : '无'));

  await browser.close();
  srv.close();

  const warmCount = calls.warm.filter(m => m === MODEL).length;
  /* 三条断言，缺一不可：
   *   ① 选模型后确实预热了（否则第一次提问照样冷加载 → 照样弹黑窗口）
   *   ② 模型真的进了显存（预热成功 ≠ 驻留，见过「打了 9 次却没驻留」）
   *   ③ 只预热一次（多次预热 = 多次冷加载 = 多次黑窗口 + 白白抢显存） */
  check(calls.warm.includes(MODEL), '① 选模型后触发了预热');
  check(resident.includes(MODEL), '② 模型进了显存', JSON.stringify(resident));
  check(warmCount === 1, '③ 只预热一次（不是 ' + warmCount + ' 次）');
  check(errors.length === 0, '④ 页面无异常', errors.join(' | '));

  await unload();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if(fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
