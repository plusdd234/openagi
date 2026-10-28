/* 本地引擎桥的转发路径（plugins/runtime/runtime.js）
 *
 * 为什么专门测这个：桥是唯一把浏览器和 Ollama / ComfyUI 连起来的地方，
 * 它错一个字符，本地生图和本地对话就整个不可用，而前端看起来只会报一个
 * 「取回生成图失败：HTTP 404」——完全指不到真正的错处。
 *
 * 曾经的真实 bug：转发时只用了 pathname（已经去掉 ?），于是
 *   GET /comfy/view?filename=x.png&subfolder=&type=output
 * 被转发成 /view（没有文件名）→ ComfyUI 恒返回 404。
 *
 * 本测试起一个假上游 + 真 runtime 子进程，直接看上游收到了什么。
 *
 * node tools/runtime-bridge.js > log 2>&1
 */
'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

function freePort(){
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function listen(handler){
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function waitUp(url, timeoutMs){
  const t0 = Date.now();
  for(;;){
    try{
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      if(r.status) return true;
    }catch(e){}
    if(Date.now() - t0 > (timeoutMs || 6000)) return false;
    await sleep(120);
  }
}

(async () => {
  // ---- 假上游：记录下来访的 path（含查询串），回一段能认出来的内容 ----
  const seen = [];
  const fake = await listen((req, res) => {
    seen.push({ url: req.url, method: req.method, port: req.socket ? req.socket.remotePort : 0 });
    if(req.url.indexOf('/view') === 0){
      // 模拟 ComfyUI：没有 filename 就 404（这正是原来那个 bug 的表现）
      const u = new URL('http://x' + req.url);
      if(!u.searchParams.get('filename')){
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"no filename"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if(req.url.indexOf('/api/tags') === 0){
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"echo":"' + req.url + '"}');
  });

  const brPort = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'plugins', 'runtime', 'runtime.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(brPort),
      COMFY_HOST: 'http://127.0.0.1:' + fake.port,
      OLLAMA_HOST: 'http://127.0.0.1:' + fake.port
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += String(d); });
  child.stderr.on('data', d => { bootLog += String(d); });

  const base = 'http://127.0.0.1:' + brPort;
  const up = await waitUp(base + '/health', 8000);
  if(!up){
    console.log('桥没起来，输出：\n' + bootLog);
    child.kill();
    process.exit(1);
  }

  try{
    console.log('== 1. /health 同时探两个引擎 ==');
    {
      const r = await fetch(base + '/health');
      const j = await r.json();
      eq(r.status, 200, 'HTTP 200');
      eq(j.service, 'open-agi-runtime', '带 service 标识');
      ok(j.ollama && j.ollama.ok === true, 'Ollama 探活成功', JSON.stringify(j.ollama));
      ok(j.comfy && j.comfy.ok === true, 'ComfyUI 探活成功', JSON.stringify(j.comfy));
    }

    console.log('\n== 1b. 探针打引擎自己的轻量端点，且不复用连接 ==');
    {
      /* 两个曾经踩过的坑：
       * ① 原来 ComfyUI 探的是 '/'（整个前端 HTML，几十上百 KB 白读），而主进程 comfy:detect
       *    探的是 /system_stats。两边端点不同 → 结论会对不上（卡片「运行中」+ 对话「没在运行」）。
       * ② 探针复用了 keep-alive 连接。ComfyUI（aiohttp）闲置 75 秒就关连接，Node 的 agent 还留着，
       *    下次复用直接 ECONNRESET → 引擎活着却报「没运行」。 */
      seen.length = 0;
      await (await fetch(base + '/health')).json();
      const paths = seen.map(s => s.url);
      ok(paths.indexOf('/system_stats') >= 0, 'ComfyUI 探 /system_stats', JSON.stringify(paths));
      ok(paths.indexOf('/') >= 0, 'Ollama 仍探根路径（它没有 /system_stats）', JSON.stringify(paths));
      eq(paths.filter(p => p === '/system_stats').length, 1, '一次 /health 只探一次');

      const p1 = (seen.find(s => s.url === '/system_stats') || {}).port;
      seen.length = 0;
      await (await fetch(base + '/health')).json();
      const p2 = (seen.find(s => s.url === '/system_stats') || {}).port;
      ok(p1 > 0 && p2 > 0 && p1 !== p2, '两次探测用的是不同连接（不复用，避开被上游关掉的死 socket）', p1 + ' → ' + p2);
    }

    console.log('\n== 2. /comfy/view 的查询串必须原样到上游（曾经 404 的根因） ==');
    {
      seen.length = 0;
      const r = await fetch(base + '/comfy/view?filename=ComfyUI_0001_.png&subfolder=&type=output');
      eq(r.status, 200, '取图成功（旧实现这里恒为 404）');
      eq(seen.length, 1, '上游收到一次请求');
      eq(seen[0].url, '/view?filename=ComfyUI_0001_.png&subfolder=&type=output', '上游收到的 path 带着完整查询串');
      const buf = Buffer.from(await r.arrayBuffer());
      eq(buf[0], 0x89, '二进制原样透传（不是被转成文本）');
      eq(r.headers.get('access-control-allow-origin'), '*', '响应带 CORS 头（浏览器侧才敢读）');
    }

    console.log('\n== 3. 空 subfolder 不能被吞掉 ==');
    {
      seen.length = 0;
      await fetch(base + '/comfy/view?filename=a.png&subfolder=&type=temp');
      eq(seen[0].url, '/view?filename=a.png&subfolder=&type=temp', 'subfolder= 空值也保留');
    }

    console.log('\n== 4. 其它带查询串的路径一并保留 ==');
    {
      seen.length = 0;
      await fetch(base + '/ollama/api/tags?x=1');
      eq(seen[0].url, '/api/tags?x=1', '/ollama 侧的查询串同样保留');
      seen.length = 0;
      await fetch(base + '/comfy/history/abc-123');
      eq(seen[0].url, '/history/abc-123', '路径参数不受影响');
      seen.length = 0;
      await fetch(base + '/ollama/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"qwen"}' });
      eq(seen[0].url, '/api/pull', '无查询串时不会被拼出多余的 ?');
      eq(seen[0].method, 'POST', '方法与 body 照旧转发');
    }

    console.log('\n== 5. 未知路径仍然 404（别把兜底也放过去） ==');
    {
      const r = await fetch(base + '/nope');
      eq(r.status, 404, '未知路径 404');
    }

    console.log('\n== 6. OPTIONS 预检 ==');
    {
      const r = await fetch(base + '/comfy/view', { method: 'OPTIONS' });
      eq(r.status, 204, '预检 204');
      ok(/authorization/i.test(r.headers.get('access-control-allow-headers') || ''), '允许 authorization 头');
    }

    console.log('\n== 7. /health 报出「我在跑旧代码」 ==');
    {
      // 用一份拷贝来测：真文件不能动 mtime，否则会把正在跑的应用也标成 stale
      const fs = require('fs');
      const os = require('os');
      const copy = path.join(os.tmpdir(), 'openagi-runtime-copy-' + process.pid + '.js');
      fs.copyFileSync(path.join(__dirname, '..', 'plugins', 'runtime', 'runtime.js'), copy);
      const p2 = await freePort();
      const c2 = spawn(process.execPath, [copy], {
        env: Object.assign({}, process.env, {
          PORT: String(p2),
          COMFY_HOST: 'http://127.0.0.1:' + fake.port,
          OLLAMA_HOST: 'http://127.0.0.1:' + fake.port
        }),
        stdio: 'ignore'
      });
      const b2 = 'http://127.0.0.1:' + p2;
      try{
        ok(await waitUp(b2 + '/health', 8000), '拷贝版桥起来了');
        const h1 = await (await fetch(b2 + '/health')).json();
        ok(typeof h1.build === 'number' && h1.build > 0, 'health 带 build 时间戳', String(h1.build));
        eq(h1.stale, false, '刚起来时不算 stale');

        // 伪造「源码比进程新」：把 mtime 推到未来
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(copy, future, future);
        const h2 = await (await fetch(b2 + '/health')).json();
        eq(h2.stale, true, '源码比进程新 → stale=true');
        ok(h2.build > h1.build, 'build 跟着 mtime 变', h1.build + ' → ' + h2.build);
      } finally {
        try{ c2.kill(); }catch(e){}
        try{ fs.unlinkSync(copy); }catch(e){}
      }
    }
  } finally {
    try{ child.kill(); }catch(e){}
    fake.srv.close();
  }

  console.log('\n---------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
  if(fail) process.exit(1);
  // 子进程可能还压着事件循环，明确退出
  process.exit(0);
})().catch(e => {
  console.error('测试异常终止：', (e && e.stack) || e);
  process.exit(1);
});
