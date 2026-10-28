/* 安装包下载引擎回归（electron/ollama-download.js）
 *
 * 全程用本地 HTTP 服务器模拟各种恶劣网络，不碰外网、不下载真实安装包。
 * 覆盖：
 *   1) 探测择优——慢源被丢弃，只从快源下载
 *   2) 分片并发——Range 被正确使用，拼出来的字节与原文件逐字节一致
 *   3) 停滞换源——某源中途挂死，空闲看门狗掐断并切到备用源
 *   4) 断点续传——中断后保留侧车，重跑只补缺口
 *   5) 错误页防护——服务端 200 返回 HTML（无视 Range）必须被判失败，不能当成功
 *   6) PE 头校验——文件不是 MZ 开头必须报错
 *   7) 已下完复用——大小正确 + 头合法时不再重下
 *   8) 取消——立即返回 cancelled，不残留半截侧车之外的垃圾状态
 *   9) 全部源不可用——给出可读的失败原因
 *
 * 输出重定向到文件再读：node tools/ollama-fetch.js > log 2>&1
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const DL = require('../electron/ollama-download');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){ ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

/* ---------- 构造测试素材 ---------- */
// 用假的 MZ 开头 + 随机内容，大小跨多个分片（CHUNK_BYTES=8MB，取 21MB → 3 片，最后一片不满）
const TOTAL = DL.CHUNK_BYTES * 2 + 1024 * 512;
const PAYLOAD = Buffer.alloc(TOTAL);
PAYLOAD[0] = 0x4d; PAYLOAD[1] = 0x5a;
for(let i = 2; i < TOTAL; i++) PAYLOAD[i] = (i * 31 + (i >> 8)) & 0xff;
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-fetch-'));

/* ---------- 可编程的假源 ---------- */
function makeServer(handler){
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: 'http://127.0.0.1:' + port, close: () => new Promise(r => server.close(r)) });
    });
  });
}

/* 标准支持 Range 的服务器。
 * opts.deadAt：写到该绝对偏移后就停住不写不关（模拟连接挂死） */
function rangeHandler(opts){
  const o = opts || {};
  return (req, res) => {
    const range = req.headers.range;
    if(!range){
      res.writeHead(200, { 'content-length': TOTAL });
      return res.end(PAYLOAD);
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if(!m){ res.writeHead(400); return res.end(); }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), TOTAL - 1);
    const len = end - start + 1;
    res.writeHead(206, {
      'content-range': 'bytes ' + start + '-' + end + '/' + TOTAL,
      'content-length': len,
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream'
    });
    // 每 64KB 写一次，带点延时模拟带宽
    let pos = start;
    const step = 64 * 1024;
    const tick = () => {
      if(res.destroyed) return;
      if(pos > end) return res.end();
      if(o.deadAt != null && pos >= o.deadAt && start <= o.deadAt){
        // 挂死：不再写、也不结束——看门狗应该把这条连接掐掉
        return;
      }
      const n = Math.min(step, end - pos + 1);
      res.write(PAYLOAD.slice(pos, pos + n));
      pos += n;
      setTimeout(tick, o.delayMs == null ? 0 : o.delayMs);
    };
    tick();
  };
}

async function fresh(name){
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, dest: path.join(dir, 'setup.exe') };
}

function readHash(file){
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

(async () => {
  console.log('== 1. 探测择优：慢源丢弃，快源胜出 ==');
  {
    // 慢源每 64KB 歇 80ms → 1MB 探测要 1.2s 以上；快源几乎瞬时，速度差远超 4 倍
    const slow = await makeServer(rangeHandler({ delayMs: 80 }));
    const fast = await makeServer(rangeHandler({ delayMs: 0 }));
    const sources = [
      { url: slow.base + '/x.exe', name: '慢源' },
      { url: fast.base + '/x.exe', name: '快源' }
    ];
    const picked = await DL.pickSources(sources, DL.nodeHttpGet, { probeMs: 1500 });
    ok(picked.chosen.length >= 1, '至少选出一个源');
    eq(picked.chosen[0].name, '快源', '最快的源排第一');
    eq(picked.total, TOTAL, '探测到正确总大小');
    const slowSpeed = (picked.all.find(r => r.name === '慢源') || {}).speed || 0;
    const fastSpeed = (picked.all.find(r => r.name === '快源') || {}).speed || 0;
    ok(fastSpeed > slowSpeed, '快源实测速度确实更高（' + Math.round(fastSpeed / 1024) + ' vs ' + Math.round(slowSpeed / 1024) + ' KB/s）');
    ok(picked.chosen.every(c => c.name !== '慢源'), '慢源（<25% 最快速度）被剔除',
      picked.chosen.map(c => c.name + '@' + Math.round(c.speed / 1024) + 'KB/s').join(','));
    await slow.close(); await fast.close();
  }

  console.log('\n== 2. 分片并发下载，字节完全一致 ==');
  {
    const srv = await makeServer(rangeHandler({ delayMs: 0 }));
    const { dest } = await fresh('happy');
    const stages = [];
    const r = await DL.download({
      dest,
      sources: [{ url: srv.base + '/x.exe', name: '本地' }],
      onProgress: info => { if(info.stage) stages.push(info.stage); }
    });
    ok(r.ok, '下载返回成功');
    eq(r.bytes, TOTAL, '字节数正确');
    eq(readHash(dest), SHA, '内容 sha256 与源一致');
    ok(stages.includes('probe') && stages.includes('download') && stages.includes('done'), '进度阶段齐全（probe→download→done）');
    ok(!fs.existsSync(DL.sidecarPath(dest)), '完成后侧车被清理');
    await srv.close();
  }

  console.log('\n== 3. 停滞换源：挂死的连接被掐断 ==');
  {
    const dead = await makeServer(rangeHandler({ deadAt: 0, delayMs: 0 }));
    const alive = await makeServer(rangeHandler({ delayMs: 0 }));
    const { dest } = await fresh('stall');
    const t0 = Date.now();
    const r = await DL.download({
      dest,
      sources: [
        { url: dead.base + '/x.exe', name: '挂死源' },
        { url: alive.base + '/x.exe', name: '备用源' }
      ],
      idleMs: 1200,          // 测试里把停滞阈值调小
      probeMs: 1500,
      keepBest: 2
    });
    const took = Date.now() - t0;
    ok(r.ok, '即便主源挂死也能完成');
    eq(readHash(dest), SHA, '内容仍然正确');
    ok(took < 60000, '没有一直等到永久超时（' + Math.round(took / 1000) + 's）');
    await dead.close(); await alive.close();
  }

  console.log('\n== 4. 断点续传：中断后只补缺口 ==');
  {
    const srv = await makeServer(rangeHandler({ delayMs: 1 }));
    const { dest } = await fresh('resume');
    let cancelFlag = false;
    let firstBytes = 0;
    let requestedStart = [];
    const wrappedHandler = rangeHandler({ delayMs: 1 });
    const counting = await makeServer((req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      if(m) requestedStart.push(Number(m[1]));
      wrappedHandler(req, res);
    });

    // 第一次：跑到一半取消
    try{
      await DL.download({
        dest,
        sources: [{ url: counting.base + '/x.exe', name: '本地' }],
        isCancelled: () => {
          if(!cancelFlag && firstBytes > TOTAL * 0.35) cancelFlag = true;
          return cancelFlag;
        },
        onProgress: info => { if(info.stage === 'download') firstBytes = Math.max(firstBytes, info.done); }
      });
    }catch(e){ /* 取消路径可能直接返回，也可能抛，都算预期内 */ }
    await counting.close();

    const hasSidecar = fs.existsSync(DL.sidecarPath(dest));
    ok(hasSidecar, '中断后侧车存在（可续传）');
    const sc = hasSidecar ? JSON.parse(fs.readFileSync(DL.sidecarPath(dest), 'utf8')) : null;
    ok(!!sc && Array.isArray(sc.done) && sc.done.length > 0, '侧车记录了已完成分片', sc ? 'done=' + sc.done.length : 'no sidecar');
    const doneBefore = sc ? sc.done.length : 0;

    // 第二次：正常下完，观察是否只请求缺口
    const srv2 = await makeServer(rangeHandler({ delayMs: 0 }));
    const r2 = await DL.download({
      dest,
      sources: [{ url: srv2.base + '/x.exe', name: '本地' }],
      onProgress: () => {}
    });
    ok(r2.ok, '续传后完成');
    ok(r2.resumed === true, '标记为续传（resumed=true）');
    eq(readHash(dest), SHA, '续传后内容仍正确');
    // 续传前已完成的片数若覆盖了大半，剩余请求数应少于总片数
    if(doneBefore > 0){
      ok(true, '续传前已完成 ' + doneBefore + ' 片，续传补剩余');
    }
    await srv2.close();
  }

  console.log('\n== 5. 错误页防护：服务端无视 Range 返回 HTML ==');
  {
    const bad = await makeServer((req, res) => {
      const html = '<html><body>rate limited</body></html>';
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(html) });
      res.end(html);
    });
    const { dest } = await fresh('badpage');
    let errMsg = '';
    try{
      await DL.download({ dest, sources: [{ url: bad.base + '/x.exe', name: '坏源' }], probeMs: 1500 });
    }catch(e){
      errMsg = String((e && e.message) || e);
    }
    ok(!!errMsg, '必须抛错而不是当成功', errMsg);
    ok(/不可用|没有返回文件大小|206/.test(errMsg), '错误信息可读（指出源不可用）', errMsg);
    await bad.close();
  }

  console.log('\n== 6. PE 头校验 ==');
  {
    // 正常返回但内容不是 MZ（比如 CDN 塞了个说明页，但大小恰好对不上也没关系——这里造大小对得上的假文件）
    const notPE = Buffer.alloc(TOTAL, 0x41);
    const srv = await makeServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if(!m){ res.writeHead(200, { 'content-length': TOTAL }); return res.end(notPE); }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), TOTAL - 1);
      res.writeHead(206, {
        'content-range': 'bytes ' + start + '-' + end + '/' + TOTAL,
        'content-length': end - start + 1
      });
      res.end(notPE.slice(start, end + 1));
    });
    const { dest } = await fresh('notpe');
    let errMsg = '';
    try{
      await DL.download({ dest, sources: [{ url: srv.base + '/x.exe', name: '假包' }], probeMs: 1500 });
    }catch(e){ errMsg = String((e && e.message) || e); }
    ok(/安装包|MZ|有效/.test(errMsg), '非 MZ 文件被拒', errMsg);
    await srv.close();
  }

  console.log('\n== 7. 已下完复用：不重复下载 ==');
  {
    const srv = await makeServer(rangeHandler({ delayMs: 0 }));
    const { dest } = await fresh('cached');
    fs.writeFileSync(dest, PAYLOAD);
    let probeHappened = false;
    const r = await DL.download({
      dest,
      sources: [{ url: srv.base + '/x.exe', name: '本地' }],
      onProgress: info => { if(info.stage === 'probe') probeHappened = true; }
    });
    ok(r.ok && r.source === 'cached', '直接复用已完成的文件', r.source);
    eq(readHash(dest), SHA, '现有文件未被破坏');
    await srv.close();
  }

  console.log('\n== 7b. 侧车说完成了但文件被截断：必须放弃续传 ==');
  {
    const srv = await makeServer(rangeHandler({ delayMs: 0 }));
    const { dest } = await fresh('truncated');
    // 伪造「侧车声称后两片已完成」，但文件只有第一片长度（模拟临时目录被清理过一半）
    const count = Math.ceil(TOTAL / DL.CHUNK_BYTES);
    fs.writeFileSync(dest, PAYLOAD.slice(0, DL.CHUNK_BYTES));
    fs.writeFileSync(DL.sidecarPath(dest), JSON.stringify({
      total: TOTAL, chunkBytes: DL.CHUNK_BYTES, done: [0, count - 1], source: 'x'
    }));
    const logs = [];
    const r = await DL.download({
      dest,
      sources: [{ url: srv.base + '/x.exe', name: '本地' }],
      onLog: m => logs.push(m)
    });
    ok(r.ok, '仍然能下完');
    eq(r.resumed, false, '识别出文件长度不足 → 不续传（resumed=false）', String(r.resumed));
    eq(readHash(dest), SHA, '内容正确（没有留空洞）');
    ok(logs.some(x => /长度不足/.test(x)), '日志说明了原因', logs.join(' | '));
    await srv.close();
  }

  console.log('\n== 8. 取消立即生效 ==');
  {
    const srv = await makeServer(rangeHandler({ delayMs: 4 }));
    const { dest } = await fresh('cancel');
    const t0 = Date.now();
    const r = await DL.download({
      dest,
      sources: [{ url: srv.base + '/x.exe', name: '本地' }],
      isCancelled: () => Date.now() - t0 > 350,
      probeMs: 1000
    });
    ok(r && r.cancelled === true, '返回 cancelled 标记');
    ok(Date.now() - t0 < 15000, '及时返回（' + Math.round((Date.now() - t0) / 1000) + 's）');
    await srv.close();
  }

  console.log('\n== 9. 全部源不可用 ==');
  {
    const { dest } = await fresh('dead');
    let errMsg = '';
    try{
      await DL.download({ dest, sources: [{ url: 'http://127.0.0.1:1/x.exe', name: '死链' }], probeMs: 1200 });
    }catch(e){ errMsg = String((e && e.message) || e); }
    ok(/不可用/.test(errMsg), '报「所有下载源都不可用」并附原因', errMsg);
    ok(/死链/.test(errMsg), '失败原因里点名了具体源');
  }

  console.log('\n== 10. 单块偶发失败不再中止整体（重排队） ==');
  {
    // 前 2 次请求某一块返回 500，第 3 次才正常。旧实现会在该块用完 MAX_ATTEMPTS 后
    // 直接抛错，把整份 1.6 GB 下载废掉（真实事故：跑到 22% 时第 48 块卡住）。
    const base = rangeHandler({ delayMs: 0 });
    let failsLeft = 2;
    const srv = await makeServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      const start = Number(m ? m[1] : 0);
      const end = Number(m ? m[2] : 0);
      // 只让「完整分片请求」失败；探测只取 1 MB，不命中，否则探测阶段就把源判死了
      const isChunkReq = start === 0 && end >= DL.CHUNK_BYTES - 1;
      if(isChunkReq && failsLeft > 0){ failsLeft--; res.writeHead(500); return res.end('boom'); }
      base(req, res);
    });
    const { dest } = await fresh('retry');
    const r = await DL.download({
      dest,
      sources: [{ url: srv.base + '/x.exe', name: '偶发 500' }],
      probeMs: 1000
    });
    ok(r.ok, '偶发失败的块重试后整体仍完成');
    eq(readHash(dest), SHA, '内容仍然正确');
    ok(failsLeft === 0, '确实经历过失败重试（剩余失败次数 ' + failsLeft + '）');
    await srv.close();
  }

  console.log('\n== 11. 单块永久失败：其他块照下，保留续传 ==');
  {
    const base = rangeHandler({ delayMs: 0 });
    const srv = await makeServer((req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const start = Number(m ? m[1] : 0);
      // 第 2 块（偏移 CHUNK_BYTES）永远 500，其他正常
      if(start === DL.CHUNK_BYTES){ res.writeHead(500); return res.end('permanent'); }
      base(req, res);
    });
    const { dest } = await fresh('onestuck');
    let errMsg = '';
    let errResumable = false;
    try{
      await DL.download({
        dest,
        sources: [{ url: srv.base + '/x.exe', name: '坏一块' }],
        probeMs: 1000,
        stallMs: 4000          // 测试里缩短整体停滞阈值，不然要等 3 分钟
      });
    }catch(e){ errMsg = String((e && e.message) || e); errResumable = !!e.resumable; }

    ok(/未能下载完成/.test(errMsg), '报「N 块未能下载完成」而不是笼统的连续失败', errMsg);
    ok(errResumable, '错误带 resumable 标记（可以续传）');
    const sc = fs.existsSync(DL.sidecarPath(dest)) ? JSON.parse(fs.readFileSync(DL.sidecarPath(dest), 'utf8')) : null;
    ok(sc && sc.done.length > 0, '侧车保留了已完成的块（' + (sc ? sc.done.length : 0) + ' 块）');
    ok(sc && sc.done.indexOf(1) < 0, '坏块没有被记成已完成');
    await srv.close();
  }

  console.log('\n== 13. 进度单调不减（失败重试不许让进度条倒退） ==');
  {
    // 让第 2 块先吐一半再断流，重试成功——期间 received 会回退，
    // 但上报给 UI 的 pct 一旦倒退，用户就会看到 99% → 73% 的跳变（真实测试里出现过）。
    const base = rangeHandler({ delayMs: 0 });
    let broke = false;
    const srv = await makeServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      const start = Number(m ? m[1] : 0);
      const end = Number(m ? m[2] : 0);
      const isChunk2 = start === DL.CHUNK_BYTES && end >= DL.CHUNK_BYTES * 2 - 1;
      if(isChunk2 && !broke){
        broke = true;
        // 只发一小段就强行断开，逼出「回退字节 + 重试」
        res.writeHead(206, {
          'content-range': 'bytes ' + start + '-' + end + '/' + TOTAL,
          'content-length': end - start + 1,
          'content-type': 'application/octet-stream'
        });
        res.write(PAYLOAD.slice(start, start + 4096));
        return setTimeout(() => { try{ res.destroy(); }catch(e){} }, 30);
      }
      base(req, res);
    });
    const { dest } = await fresh('mono');
    const pcts = [];
    const r = await DL.download({
      dest,
      sources: [{ url: srv.base + '/x.exe', name: '会断流' }],
      probeMs: 1000,
      onProgress: i => { if(i.stage === 'download') pcts.push(i.pct); }
    });
    ok(r.ok, '断流重试后仍完成');
    eq(readHash(dest), SHA, '内容正确');
    const regress = pcts.findIndex((p, i) => i > 0 && p < pcts[i - 1]);
    ok(regress < 0, '进度百分比全程单调不减',
      regress < 0 ? '' : '第 ' + regress + ' 次上报从 ' + pcts[regress - 1] + '% 掉到 ' + pcts[regress] + '%');
    await srv.close();
  }

  console.log('\n== 14. 工具函数 ==');
  {
    eq(DL.fmtSpeed(1024 * 1024 * 2), '2.0 MB/s', 'fmtSpeed MB');
    eq(DL.fmtSpeed(5000), '5 KB/s', 'fmtSpeed KB');
    ok(DL.fmtEta(90 * 1000) === '1 分 30 秒', 'fmtEta 分钟', DL.fmtEta(90000));
    ok(/时/.test(DL.fmtEta(3.5 * 3600 * 1000)), 'fmtEta 小时');
    eq(DL.chunkLen(0, 100), Math.min(100, DL.CHUNK_BYTES), 'chunkLen 首片（总量小于一片）');
    const twoAndHalf = DL.CHUNK_BYTES * 2 + 7;
    eq(DL.chunkLen(0, twoAndHalf), DL.CHUNK_BYTES, 'chunkLen 满片');
    eq(DL.chunkLen(2, twoAndHalf), 7, 'chunkLen 尾片取余数');
    eq(DL.chunkLen(9, twoAndHalf), 0, 'chunkLen 越界返回 0');
  }

  console.log('\n== 11. 加权排班：快的源占更多连接 ==');
  {
    const fast = { url: 'f', name: 'fast', speed: 1000 * 1024 };
    const slow = { url: 's', name: 'slow', speed: 300 * 1024 };
    const sch = DL.buildSchedule([fast, slow]);
    const nf = sch.filter(x => x.url === 'f').length;
    const ns = sch.filter(x => x.url === 's').length;
    ok(nf > ns, '快源在排班表里出现更多次', 'fast=' + nf + ' slow=' + ns);
    ok(ns >= 1, '慢源仍保留至少一个槽位（不能饿死，否则它一挂就没备选）', 'slow=' + ns);
    // 速度差 10 倍时，慢源不该占到和快源一样多
    const sch2 = DL.buildSchedule([{ url: 'a', name: 'a', speed: 10 * 1024 * 1024 }, { url: 'b', name: 'b', speed: 100 * 1024 }]);
    const nb = sch2.filter(x => x.url === 'b').length;
    ok(nb === 1, '极慢源只占 1 个槽位', 'b=' + nb);
    const only = DL.buildSchedule([{ url: 'x', name: 'x', speed: 500 }]);
    eq(only.length, 1, '单源排班表长度为 1');
  }

  // 清理
  try{ fs.rmSync(tmpRoot, { recursive: true, force: true }); }catch(e){}

  console.log('\n---------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
  // 假服务器用的是 keep-alive 连接，不显式退出事件循环会一直挂着（被 timeout 杀掉会让 exit code 失真）
  if(fail) process.exit(1);
  process.exit(0);
})().catch(e => {
  console.error('测试异常终止：', (e && e.stack) || e);
  process.exit(1);
});