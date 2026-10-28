/* makeElectronHttpGet 的运行时验证（必须在真实 Electron 里跑，node 提供不了 Chromium 网络栈）
 *
 * 生产用它而不是 node https 的原因：Electron net 会继承系统代理 / PAC。
 * 国内绝大多数机器只有走系统代理才连得上 GitHub，「net 层没生效」等于下载整个坏掉。
 *
 * 跑法（注意必须 unset ELECTRON_RUN_AS_NODE，否则 require('electron') 返回路径字符串）：
 *   unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe tools/ollama-net.js
 *
 * 覆盖：Range→206、headers 拍平、字节数、外网 fetch、外网 HTTPS + 307/302 重定向分片探测、
 *       真外网小文件完整下载（sha256sum.txt 只有几十字节，不浪费流量）。
 */
const { app, net } = require('electron');
const DL = require('../electron/ollama-download');
const http = require('http');

app.whenReady().then(async () => {
  let ok = 0, bad = 0;
  const t = (c, n, e) => { if(c){ ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

  // 1) 打一个本地服务器（验证 header 拍平、206、数据流）
  const BUF = Buffer.alloc(300000); BUF[0]=0x4d; BUF[1]=0x5a;
  for(let i=2;i<BUF.length;i++) BUF[i]=i&0xff;
  const srv = http.createServer((req,res)=>{
    const m=/bytes=(\d+)-(\d+)/.exec(req.headers.range||'');
    if(!m){ res.writeHead(200,{'content-length':BUF.length}); return res.end(BUF); }
    const s=Number(m[1]), e=Math.min(Number(m[2]),BUF.length-1);
    res.writeHead(206,{'content-range':'bytes '+s+'-'+e+'/'+BUF.length,'content-length':e-s+1});
    res.end(BUF.slice(s,e+1));
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const httpGet = DL.makeElectronHttpGet(net);

  // 单次带 Range 的请求
  try{
    const h = await httpGet(base + '/x', { headers: { range: 'bytes=100-199' }, connectMs: 8000 });
    t(h.status === 206, 'Range 请求返回 206', 'status=' + h.status);
    t(typeof h.headers['content-range'] === 'string', 'headers 已拍平成字符串', JSON.stringify(h.headers['content-range']));
    let got = 0;
    await new Promise(r => { h.stream.on('data', b => got += b.length); h.stream.on('end', r); h.stream.on('close', r); });
    t(got === 100, '收到正确字节数', got);
  }catch(e){ t(false, 'Range 请求', e.message); }

  // 真实外网：GitHub API + 分片探测（验证 HTTPS / 重定向 / 代理）
  try{
    const r = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'x' } });
    t(r.ok, '外网 fetch 可用（走 Chromium 栈）', 'HTTP ' + r.status);
  }catch(e){ t(false, '外网 fetch', e.message); }

  try{
    const asset = { url: 'https://github.com/ollama/ollama/releases/download/v0.40.11/OllamaSetup.exe', name: 'GitHub 直连' };
    const p = await DL.probeOne(asset, httpGet, 6000);
    t(p.speed > 0, '外网 HTTPS 分片探测（含 307/302 重定向）', 'speed=' + Math.round(p.speed/1024) + 'KB/s total=' + p.total + ' ' + p.error);
    t(p.total > 0, '拿到文件总大小', p.total);
  }catch(e){ t(false, '外网探测', e.message); }

  // 小文件完整下载（真外网、真分片、真校验）
  try{
    const dest = require('path').join(app.getPath('temp'), 'net-probe-download.bin');
    const r = await DL.download({
      dest,
      sources: [{ url: 'https://github.com/ollama/ollama/releases/download/v0.40.11/sha256sum.txt', name: 'sha256sum' }],
      httpGet, expectPE: false
    });
    const fs = require('fs');
    const txt = fs.readFileSync(dest, 'utf8');
    t(r.ok && /OllamaSetup\.exe/.test(txt), '真外网小文件完整下载 + 内容正确', (txt.match(/.*OllamaSetup.*/)||[''])[0].slice(0,80));
    try{ fs.unlinkSync(dest); }catch(e){}
  }catch(e){ t(false, '真外网小文件下载', e.message); }

  srv.close();
  console.log('\n通过 ' + ok + '，失败 ' + bad);
  app.exit(bad ? 1 : 0);
});
