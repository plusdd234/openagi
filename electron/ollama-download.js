/* Ollama 安装包下载引擎（多源择优 + 分片并发 + 断点续传 + 停滞换源）
 *
 * 为什么需要它：安装包已经涨到 ~1.6 GB，而 ollama.com → GitHub Releases →
 * release-assets.githubusercontent.com 这条链在国内单连接只有十几 KB/s
 * （本机实测 17 KB/s，单线程 ETA 二十多小时）。原实现是「单连接 + 无续传 + 无镜像 +
 * 无停滞检测」，用户只看到「正在下载 2 / 1585 MB」然后几小时不动，
 * 既判断不出是慢还是卡死，也拿不到任何可操作的提示。
 *
 * 本模块只负责「把 URL 列表变成本地文件」，不依赖 Electron，可直接单测：
 *   - httpGet 可注入：生产用 Electron net（走 Chromium 网络栈，继承系统代理），单测用 node http
 *   - 探测阶段并发测速，按实测速度排序选源（哪条快因网络环境而异，不能写死顺序）
 *   - 分片 Range 并发下载，每片独立重试并轮换源
 *   - 进度侧车 .part.json：进程被杀 / 用户取消后仍可续传
 *   - 单片空闲超过 idleMs 判定停滞 → 销毁连接、换源重试
 *   - 完成后校验长度 + PE 头（安装包必然 MZ 开头），防止代理返回错误页却当成功
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PROBE_BYTES = 1 << 20;        // 每个源探测 1 MB
const PROBE_MS = 4000;              // 探测最长 4s（并发进行，总耗时不超过它）
const CHUNK_BYTES = 8 << 20;        // 分片 8 MB
const WORKERS = 6;                  // 并发连接数
const IDLE_MS = 15000;              // 单片空闲 15s 判定停滞
const MAX_ATTEMPTS = 5;             // 单片最多尝试次数
const MAX_CHUNK_TRIES = 24;         // 单块重排队上限（超过判定该块放弃，而不是拖垮整体）
const PROGRESS_MS = 300;            // 进度回调节流
const CONNECT_MS = 20000;           // 建连超时
const STALL_MS = 180000;            // 全源无字节进展 3 分钟才判定整体失败（不是单片失败就中止）
const COOLDOWN_BASE_MS = 2000;      // 单源失败后的冷却起点（指数退避）
const COOLDOWN_MAX_MS = 45000;      // 冷却上限
const REPROBE_MS = 45000;           // 全源冷却时重跑测速的最小间隔
const SOURCE_DEAD_AFTER = 4;        // 从没成功过却连败这么多分片 → 判死（探测绿灯不算数）

/* ---------------- HTTP 层 ---------------- */

/* node 原生实现（单测 / 无 Electron 时使用）。跟随重定向，保留自定义头。 */
function nodeHttpGet(url, opts){
  const o = opts || {};
  const idle = o.idleTimeoutMs || IDLE_MS;
  return new Promise((resolve, reject) => {
    const follow = (u, hops) => {
      let parsed;
      try { parsed = new URL(u); } catch(e){ return reject(new Error('地址无效：' + u)); }
      const lib = parsed.protocol === 'https:' ? https : http;
      let req;
      try {
        req = lib.get(u, { headers: o.headers || {} }, res => {
          if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
            res.resume();
            if(hops >= 5) return reject(new Error('下载重定向过多'));
            let next;
            try { next = new URL(res.headers.location, u).href; } catch(e){ return reject(e); }
            return follow(next, hops + 1);
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            stream: res,
            url: u,
            abort: () => { try{ req.destroy(); }catch(e){} }
          });
        });
      } catch(e){
        return reject(e);
      }
      req.setTimeout(idle, () => { try{ req.destroy(new Error('连接空闲 ' + Math.round(idle / 1000) + ' 秒')); }catch(e){} });
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

/* Electron net 版本：走 Chromium 网络栈，自动继承系统代理 / PAC（国内必须）。
 * 与 node http 的差异：res.headers 是 Record<string, string[]>，这里拍平成单值，
 * 调用方不必区分两套形态。停滞判定不在这一层做，统一交给 pumpToFile 的空闲看门狗。 */
function makeElectronHttpGet(net){
  return function electronHttpGet(url, opts){
    const o = opts || {};
    const connectMs = o.connectMs || CONNECT_MS;
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = net.request({ url, method: 'GET', redirect: 'follow', useSessionCookies: false });
      } catch(e){
        return reject(e);
      }
      const headers = o.headers || {};
      Object.keys(headers).forEach(k => { try{ req.setHeader(k, headers[k]); }catch(e){} });

      let settled = false;
      let stage = 'connect';                 // connect → stream
      let hung = null;                        // 交出去后若停滞，用这个通知消费方
      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        try{ req.abort(); }catch(e){}
        reject(new Error(stage === 'connect' ? '连接超时' : '响应超时'));
      }, connectMs);

      req.on('response', res => {
        clearTimeout(timer);
        if(settled){ try{ res.resume(); }catch(e){} return; }
        stage = 'stream';
        const flat = {};
        const raw = res.headers || {};
        Object.keys(raw).forEach(k => {
          const v = raw[k];
          flat[String(k).toLowerCase()] = Array.isArray(v)
            ? (v.length > 1 ? v.join(', ') : String(v[0]))
            : String(v);
        });
        settled = true;
        resolve({
          status: res.statusCode,
          headers: flat,
          stream: res,
          url,
          abort: () => { try{ req.abort(); }catch(e){} }
        });
      });
      req.on('error', e => {
        clearTimeout(timer);
        if(settled) return;
        settled = true;
        reject(e || new Error('网络错误'));
      });
      req.on('abort', () => {
        clearTimeout(timer);
        if(settled) return;
        settled = true;
        reject(new Error('连接被中止'));
      });
      try{ req.end(); }catch(e){ settled = true; clearTimeout(timer); reject(e); }
    });
  };
}

/* ---------------- 分片读取 + 落盘 ---------------- */

/* 把一段 Range 流按位置写进文件，返回本次写入字节数。
 * 空闲看门狗：idleMs 内没有任何数据就销毁连接并抛错（换源重试用）。
 *
 * 关键：'end' 可能在最后一次异步写**之前**触发，此时 pos 还没推进。
 * 必须把挂起的写 promise 等到底再判定完整性，否则会「分片长度不足」误报，
 * 甚至更糟——把尾字节缺失的分片当成完成记进侧车，续传后文件中间留洞。 */
function pumpToFile(handle, fh, start, end, opts){
  const o = opts || {};
  const idle = o.idleMs || IDLE_MS;
  const isCancelled = typeof o.isCancelled === 'function' ? o.isCancelled : () => false;
  const onBytes = typeof o.onBytes === 'function' ? o.onBytes : () => {};
  return new Promise((resolve, reject) => {
    let pos = start;
    let wrote = 0;
    let settled = false;
    let idleTimer = null;
    let pending = Promise.resolve();   // 最后一次写

    const cleanup = () => {
      if(idleTimer){ clearTimeout(idleTimer); idleTimer = null; }
      try{ handle.stream.destroy(); }catch(e){}
    };
    const fail = e => {
      if(settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const armIdle = () => {
      if(idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error('空闲 ' + Math.round(idle / 1000) + ' 秒无数据')), idle);
    };
    armIdle();

    const finish = async () => {
      if(settled) return;
      await pending.catch(() => {});     // 等最后一批写落地，pos 才是真的
      if(settled) return;
      settled = true;
      cleanup();
      if(pos !== end + 1){
        const err = new Error('分片不完整（' + wrote + ' / ' + (end - start + 1) + ' 字节）');
        err.partial = wrote;
        return reject(err);
      }
      resolve(wrote);
    };

    handle.stream.on('data', buf => {
      if(settled) return;
      if(isCancelled()) return fail(Object.assign(new Error('已取消'), { cancelled: true }));
      armIdle();
      // 有些代理会忽略 Range 返回整文件，多给的部分一律截掉
      if(pos + buf.length > end + 1) buf = buf.slice(0, end + 1 - pos);
      if(!buf.length) return;
      handle.stream.pause();
      const at = pos;
      pending = fh.write(buf, 0, buf.length, at).then(() => {
        if(settled) return;
        pos = at + buf.length;
        wrote += buf.length;
        onBytes(buf.length);
        handle.stream.resume();
      }, e => { fail(e); });
    });
    handle.stream.on('error', e => fail(e));
    handle.stream.on('aborted', () => fail(new Error('连接被中断')));
    handle.stream.on('end', () => { finish(); });
    // 连接提前关闭也要收尾（有些代理不发 end 只 close）
    handle.stream.on('close', () => { if(!settled) finish(); });
  });
}

/* ---------------- 探测：并发测速选源 ---------------- */

async function probeOne(src, httpGet, budgetMs){
  const t0 = Date.now();
  let got = 0;
  let total = 0;
  let rangeOk = false;
  let handle = null;
  try{
    handle = await httpGet(src.url, {
      headers: { range: 'bytes=0-' + (PROBE_BYTES - 1) },
      connectMs: Math.max(4000, budgetMs),
      idleTimeoutMs: Math.max(3000, budgetMs)
    });
    if(handle.status !== 206 && handle.status !== 200) throw new Error('HTTP ' + handle.status);
    rangeOk = handle.status === 206;
    if(rangeOk){
      const m = /\/(\d+)\s*$/.exec(String(handle.headers['content-range'] || ''));
      if(m) total = Number(m[1]);
    }
    if(!total) total = Number(handle.headers['content-length']) || 0;
    await new Promise(resolve => {
      let done = false;
      const stop = () => {
        if(done) return;
        done = true;
        clearTimeout(timer);
        try{ handle.stream.destroy(); }catch(e){}
        resolve();
      };
      const timer = setTimeout(stop, budgetMs);
      handle.stream.on('data', buf => {
        got += buf.length;
        if(got >= PROBE_BYTES) stop();
      });
      handle.stream.on('end', stop);
      handle.stream.on('error', stop);
      handle.stream.on('close', stop);
    });
    const secs = Math.max(0.15, (Date.now() - t0) / 1000);
    return { url: src.url, name: src.name || src.url, speed: got / secs, total, rangeOk, error: '' };
  }catch(e){
    if(handle && handle.abort){ try{ handle.abort(); }catch(err){} }
    return { url: src.url, name: src.name || src.url, speed: 0, total: 0, rangeOk: false, error: String((e && e.message) || e) };
  }
}

/* 并发探测全部源，按实测速度降序；低于最快 25% 的源直接丢弃（留着只会拖慢），
 * 保留前 keepBest 个用于分片失败时轮换。 */
async function pickSources(sources, httpGet, opts){
  const o = opts || {};
  const budget = o.probeMs || PROBE_MS;
  const keepBest = o.keepBest || 3;
  const results = await Promise.all(sources.map(s => probeOne(s, httpGet, budget)));
  const alive = results.filter(r => r.speed > 0 && r.total > 0);
  if(!alive.length){
    const detail = results.map(r => r.name + '：' + (r.error || '无响应')).join('；');
    throw new Error('所有下载源都不可用（' + detail + '）');
  }
  /* 分片下载必须走 Range（206）。有些「加速镜像」会无视 Range 头直接从头吐整个文件，
   * 那种源一旦按分片偏移写进去，得到的就是错位的垃圾数据——而且它还会因为「速度快」
   * 被排到最前面（实测 gh-proxy.com 就是：Range 请求返回 200 + 整个 1.2 GB）。
   * 所以只保留真正回了 206 的源，哪怕只剩一个慢的。 */
  const ranged = alive.filter(r => r.rangeOk);
  if(!ranged.length){
    const detail = alive.map(r => r.name + ' 返回整包、不支持分片').join('；');
    throw new Error('下载源都不支持分片下载（' + detail + '）。换个网络或稍后重试——' +
      '这种源没法做断点续传，下 2 GB 中途断一次就得从头再来');
  }
  ranged.sort((a, b) => b.speed - a.speed);
  const best = ranged[0].speed;
  const chosen = ranged.filter(r => r.speed >= best * 0.25).slice(0, keepBest);
  // 大小不一致说明有源返回的不是同一个文件，只信最快的那个的 total
  const total = chosen[0].total;
  const consistent = chosen.filter(r => r.total === total);
  const use = consistent.length ? consistent : [chosen[0]];
  return { chosen: use, all: results, total, schedule: buildSchedule(use) };
}

/* 按实测速度分配排班槽位，让「槽位比例 ≈ 带宽比例」。
 *
 * 旧实现是 reps = round(speed/best*3)：最快的源 3 槽、慢源保底 1 槽，
 * 于是 10 倍速差时慢源仍占 25% 的连接。实测 gh.monlor 37 KB/s 与
 * gh-proxy 387 KB/s 同跑，慢源把 1/4 的连接白白占住，聚合速度被拖到 250 KB/s。
 *
 * 现在用固定长度表按速度比例切分（TABLE 槽）：10 倍差 → 11:1，慢源只当备份；
 * 两源等速 → 6:6，真正均分去压各自上限。每个源至少 1 槽，避免某源一挂就没备选。
 * 注意单源时不要复制（重复同一个源毫无意义，只会让日志难读）。 */
const SCHEDULE_SLOTS = 12;

function buildSchedule(chosen){
  if(!chosen || !chosen.length) return [];
  if(chosen.length === 1) return [chosen[0]];
  const sum = chosen.reduce((s, x) => s + Math.max(1, x.speed || 1), 0);
  const slots = [];
  chosen.forEach(src => {
    const w = Math.max(1, src.speed || 1);
    const reps = Math.max(1, Math.round(SCHEDULE_SLOTS * w / sum));
    for(let i = 0; i < reps; i++) slots.push(src);
  });
  return slots.length ? slots : chosen;
}

/* ---------------- 进度侧车（续传） ---------------- */

function sidecarPath(dest){ return dest + '.part.json'; }

async function readSidecar(dest){
  try{
    const j = JSON.parse(await fsp.readFile(sidecarPath(dest), 'utf8'));
    if(!j || !Number.isFinite(j.total) || j.total <= 0) return null;
    if(!Array.isArray(j.done)) return null;
    return j;
  }catch(e){
    return null;
  }
}

async function writeSidecar(dest, state){
  const tmp = sidecarPath(dest) + '.tmp';
  try{
    await fsp.writeFile(tmp, JSON.stringify(state));
    await fsp.rename(tmp, sidecarPath(dest));
  }catch(e){/* 侧车写不进去不该打断下载，最多丢续传能力 */}
}

async function dropSidecar(dest){
  try{ await fsp.unlink(sidecarPath(dest)); }catch(e){}
}

/* ---------------- 下载主体 ---------------- */

function fmtSpeed(bytesPerSec){
  const n = Math.max(0, bytesPerSec || 0);
  if(n >= 1048576) return (n / 1048576).toFixed(1) + ' MB/s';
  return Math.max(1, Math.round(n / 1024)) + ' KB/s';
}

function fmtEta(ms){
  if(!(ms >= 0) || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if(s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if(m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}

function chunkLen(idx, total){
  const start = idx * CHUNK_BYTES;
  if(start >= total) return 0;
  return Math.min(total - start, CHUNK_BYTES);
}

async function hasPEHeader(file){
  let fh = null;
  try{
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(2);
    const r = await fh.read(buf, 0, 2, 0);
    return r.bytesRead === 2 && buf[0] === 0x4d && buf[1] === 0x5a; // 'MZ'
  }catch(e){
    return false;
  }finally{
    if(fh){ try{ await fh.close(); }catch(e){} }
  }
}

/**
 * @param {object} opts
 *   dest        目标文件路径
 *   sources     [{ url, name }]
 *   httpGet     可注入的 HTTP 层（默认 nodeHttpGet）
 *   expectPE    完成后校验 MZ 头（默认 true）
 *   canResume   是否复用 .part.json（默认 true）
 *   isCancelled () => boolean
 *   onProgress  ({ stage, done, total, pct, speed, etaMs, source })
 */
async function download(opts){
  const o = opts || {};
  const dest = o.dest;
  if(!dest) throw new Error('缺少目标路径');
  const sources = (o.sources || []).filter(s => s && s.url);
  if(!sources.length) throw new Error('没有可用的下载源');
  const httpGet = o.httpGet || nodeHttpGet;
  const isCancelled = typeof o.isCancelled === 'function' ? o.isCancelled : () => false;
  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const expectPE = o.expectPE !== false;
  // 模块里没有全局 logger（要能在 node / Electron 两边跑），诊断信息走 onLog 或静默
  const logish = typeof o.onLog === 'function' ? o.onLog : () => {};

  report({ stage: 'probe', done: 0, total: 0, pct: -1, speed: 0, etaMs: -1, source: '' });

  const picked = await pickSources(sources, httpGet, o);
  const total = picked.total;
  if(!(total > 0)) throw new Error('下载源没有返回文件大小，无法分片下载');
  const schedule = picked.schedule && picked.schedule.length ? picked.schedule : picked.chosen;

  const chunkCount = Math.ceil(total / CHUNK_BYTES);
  const sc = o.canResume === false ? null : await readSidecar(dest);
  const layoutOk = !!(sc && sc.total === total && sc.chunkBytes === CHUNK_BYTES);
  const scDone = layoutOk
    ? new Set((sc.done || []).filter(i => Number.isInteger(i) && i >= 0 && i < chunkCount))
    : new Set();
  const fullyDone = layoutOk && scDone.size === chunkCount;

  // 已下完但没装成（上次卡在安装）→ 直接复用，不重下 1.6 GB。
  // ⚠ 只有「没有未完成侧车」时才能走这条路：并发位置写会把文件稀疏扩展到完整长度，
  //   中途取消后文件大小同样是 total，只看大小会把满是空洞的文件当成品。
  if(!layoutOk || fullyDone){
    try{
      const st = await fsp.stat(dest);
      if(st.size === total && (!expectPE || await hasPEHeader(dest))){
        await dropSidecar(dest);
        report({ stage: 'done', done: total, total, pct: 100, speed: 0, etaMs: 0, source: 'cached' });
        return { ok: true, bytes: total, source: 'cached', resumed: true, cancelled: false };
      }
    }catch(e){/* 文件不存在，正常开始 */}
  }

  // 续传：侧车里的分片布局与本次探测到的 total 完全一致才敢用，否则从头来
  let done = new Set();
  let resumed = false;
  let received = 0;
  if(layoutOk && scDone.size){
    // 侧车记了分片，但文件本身可能被外部截断 / 删除过（临时目录清理、用户手动删一半）。
    // 那时按位置写会留下空洞，且空洞恰好是「已标记完成」的区间，永远不会被补。
    // 只要求文件长度覆盖到最远完成分片的末尾即可——稀疏文件的长度是可信上界。
    let maxEnd = 0;
    scDone.forEach(i => { const e2 = Math.min(total, (i + 1) * CHUNK_BYTES); if(e2 > maxEnd) maxEnd = e2; });
    let sizeOk = false;
    try{
      const st = await fsp.stat(dest);
      sizeOk = st.size >= maxEnd;
    }catch(e){ sizeOk = false; }
    if(sizeOk){
      done = scDone;
      resumed = true;
      done.forEach(i => { received += chunkLen(i, total); });
    } else {
      logish('侧车分片 ' + scDone.size + ' 片但文件长度不足，放弃续传从头下载');
    }
  }
  if(!resumed){
    done = new Set();
    try{ await fsp.rm(dest, { force: true }); }catch(e){}
    await dropSidecar(dest);
  }

  try{ await fsp.access(dest, fs.constants.F_OK); }
  catch(e){ await fsp.writeFile(dest, Buffer.alloc(0)); }
  const fh = await fsp.open(dest, 'r+');

  const state = { total, chunkBytes: CHUNK_BYTES, done: Array.from(done).sort((a, b) => a - b), source: picked.chosen[0].url };
  let cursor = 0;
  let lastReport = 0;
  let speedAvg = 0;
  let lastBytes = received;
  let lastAt = Date.now();
  let lastProgressAt = Date.now();   // 最后一次真正收到字节的时刻（整体停滞判据）
  let receivedPeak = received;       // 进度只许前进：失败重试会回退 received，展示不能跟着退
  let fatal = null;                  // 全局停滞 / 取消导致的终止原因

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const paint = force => {
    const now = Date.now();
    if(!force && now - lastReport < PROGRESS_MS) return;
    const dt = (now - lastAt) / 1000;
    if(dt >= 0.2){
      const inst = Math.max(0, (received - lastBytes) / dt);
      speedAvg = speedAvg ? speedAvg * 0.65 + inst * 0.35 : inst;
      lastBytes = received;
      lastAt = now;
    }
    lastReport = now;
    /* 进度单调不减：某块失败重试会把它的字节从 received 里退回，若直接用它算百分比，
     * 用户会看到进度条从 99% 掉回 73%（真实测试里出现过）。取历史峰值即可——
     * 重试成功时字节会重新涨回来，峰值只影响那一段的观感，不影响最终正确性。 */
    if(received > receivedPeak) receivedPeak = received;
    const pct = Math.max(0, Math.min(100, Math.round(receivedPeak / total * 100)));
    const etaMs = speedAvg > 2048 ? Math.round(Math.max(0, total - receivedPeak) / speedAvg * 1000) : -1;
    report({ stage: 'download', done: receivedPeak, total, pct, speed: speedAvg, etaMs, source: state.source });
  };
  paint(true);

  /* 源健康度：失败的源进入指数退避冷却，避免「明明挂了这个源还一直派活给它」。
   * 冷却只影响优先级，不彻底禁用——只剩它一个时还得用它。
   * dead 是另一回事：源返回的不是 206（错误页 / 不支持 Range），重试再多次也一样，
   * 直接判死，全部判死时立刻失败，不要干等停滞看门狗。 */
  const srcHealth = new Map();
  const srcReady = src => {
    const h = srcHealth.get(src.url);
    return !h || !h.dead && (!h.until || Date.now() >= h.until);
  };
  const srcFail = src => {
    const h = srcHealth.get(src.url) || { fails: 0, ok: 0, until: 0 };
    h.fails++;
    h.until = Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * Math.pow(2, h.fails - 1));
    /* 从没成功过一次、却连续失败 SOURCE_DEAD_AFTER 次的源，直接判死。
     * 为什么不能只靠探测：实测 GitHub 直连对 1 MB 探测请求正常返回（探测绿灯），
     * 但发 8 MB 分片请求就挂住 15 秒不吐数据。探测通过 ≠ 能下载，
     * 只有「真实分片请求的成功率」才算数。真实测试里 56 块就是被这种源拖到停滞的。 */
    if(!h.ok && h.fails >= SOURCE_DEAD_AFTER) h.dead = true;
    srcHealth.set(src.url, h);
  };
  const srcDead = src => {
    const h = srcHealth.get(src.url) || { fails: 0, ok: 0, until: 0 };
    h.dead = true;
    srcHealth.set(src.url, h);
  };
  const aliveSources = () => schedule.filter(s => !(srcHealth.get(s.url) || {}).dead);
  const srcOk = src => {
    const h = srcHealth.get(src.url) || { fails: 0, ok: 0, until: 0 };
    h.fails = 0; h.until = 0; h.ok = (h.ok || 0) + 1;
    srcHealth.set(src.url, h);
  };

  /* 取活：优先取「到点重试」的块，其次取新块；都没有就返回 null（worker 去睡一会儿）。
   * 重试块放在队列里而不是就地死等——单块卡住时其他块仍能继续下载，
   * 这才是 1.6 GB 该有的容错：一块下不下来不该把已下的 300 MB 一起废掉。 */
  const retryQ = [];
  const stuck = [];                  // 放弃重试的块（连字节都收不到的坏块）
  const errByIdx = new Map();        // 每块最后一次失败原因，用于收尾时给出可读信息
  const lastErrOf = idx => errByIdx.get(idx) || null;
  const takeChunk = () => {
    const now = Date.now();
    for(let i = 0; i < retryQ.length; i++){
      if(retryQ[i].dueAt <= now){
        const job = retryQ.splice(i, 1)[0];
        return job;
      }
    }
    while(cursor < chunkCount){
      const i = cursor++;
      if(!done.has(i)) return { idx: i, fails: 0 };
    }
    return null;
  };
  const requeue = (idx, fails, err, delayMs) => {
    if(err) errByIdx.set(idx, err);
    if(fails >= MAX_CHUNK_TRIES){
      // 单块重试到这个份上，基本可以断定是这一块的数据在源侧有问题（或网络对它稳定失败）。
      // 不再占着连接空转，标记放弃，让收尾逻辑如实报告缺了哪几块。
      stuck.push({ idx, err });
      return;
    }
    retryQ.push({ idx, fails, dueAt: Date.now() + delayMs, err });
    if(retryQ.length > 1) retryQ.sort((a, b) => a.dueAt - b.dueAt);
  };

  const fetchChunk = async (idx, src) => {
    const start = idx * CHUNK_BYTES;
    const end = Math.min(total - 1, start + CHUNK_BYTES - 1);
    const handle = await httpGet(src.url, {
      headers: { range: 'bytes=' + start + '-' + end },
      connectMs: o.connectMs || CONNECT_MS,
      idleTimeoutMs: o.idleMs || IDLE_MS
    });
    if(handle.status !== 206){
      try{ handle.abort && handle.abort(); }catch(e){}
      const err = new Error('分片未返回 206（HTTP ' + handle.status + '）');
      /* 区分「这个源根本不能用于分片」和「这次请求运气不好」：
       *  - 2xx 但不是 206：源无视 Range 直接吐整文件（错误页 / 中转页），重试多少次都一样 → 判死
       *  - 403 / 404：地址确实不对（镜像没这个文件），也判死
       *  - 5xx / 429 / 其他：限流或临时故障，冷却一会儿还能用 → 只冷却
       * 早先把 500 也判死，结果「偶发 500」直接导致整份下载失败。 */
      const sc = handle.status;
      if((sc >= 200 && sc < 300) || sc === 403 || sc === 404) err.sourceDead = true;
      throw err;
    }
    return pumpToFile(handle, fh, start, end, {
      idleMs: o.idleMs || IDLE_MS,
      isCancelled,
      onBytes: n => { received += n; lastProgressAt = Date.now(); paint(false); }
    });
  };

  /* 选源：按健康度择优，而不是简单轮转。
   *
   * 实测教训（真实 1.6 GB 续传）：轮转会把请求均匀撒给所有「没在冷却」的源，
   * 于是一个探测时亮绿灯、真下载必挂的源（GitHub 直连：1 MB 探测正常，
   * 8 MB 分片 15 秒不吐字节）会一直分到活，56 块全被它拖死。
   * 现在改为：连续失败少的优先、探测速度快的优先；全都在冷却就等最近的冷却结束，
   * 而不是退回去打一个刚失败过的源。 */
  const pickSource = () => {
    const alive = aliveSources();
    if(!alive.length) return { src: null, waitMs: 0, allDead: true };
    const ready = alive.filter(srcReady);
    if(!ready.length){
      // 全在冷却：等到最早那个解冻（上限 3s，避免一次睡过头错过其他源）
      let soonest = Infinity;
      alive.forEach(s => {
        const h = srcHealth.get(s.url);
        if(h && h.until) soonest = Math.min(soonest, h.until);
      });
      const wait = Number.isFinite(soonest) ? Math.max(200, Math.min(3000, soonest - Date.now())) : 500;
      return { src: null, waitMs: wait, allDead: false };
    }
    // 连续失败次数最少的优先；同样少时探测速度快的优先（chosen 已按速度降序）
    let best = ready[0];
    let bestFails = (srcHealth.get(best.url) || {}).fails || 0;
    for(const s of ready){
      const f = (srcHealth.get(s.url) || {}).fails || 0;
      if(f < bestFails){ best = s; bestFails = f; }
    }
    return { src: best, waitMs: 0, allDead: false };
  };

  const worker = async () => {
    for(;;){
      if(fatal || isCancelled()) return;
      const job = takeChunk();
      if(!job){
        // 没活了：全部完成，或者剩下的块都在冷却 / 已判定放弃
        if(done.size >= chunkCount) return;
        if(!retryQ.length && cursor >= chunkCount) return;   // 没有可重试的块了，别空转
        await sleep(200);
        continue;
      }
      const { idx, fails } = job;
      const mark = received;
      const pick = pickSource();
      if(pick.allDead){
        fatal = new Error('所有下载源都不可用（分片请求全部失败，已完成 ' +
          done.size + ' / ' + chunkCount + ' 块会保留，重试可从断点续传）：' +
          picked.chosen.map(s => s.name || s.url).join('、'));
        fatal.resumable = true;
        return;
      }
      if(!pick.src){
        // 所有源都在冷却，且手上有块要下：先把它放回队列，等冷却结束再试
        requeue(idx, fails, lastErrOf(idx), pick.waitMs);
        await sleep(pick.waitMs);
        continue;
      }
      const src = pick.src;
      try{
        await fetchChunk(idx, src);
        srcOk(src);
        done.add(idx);
        state.done.push(idx);
        state.source = src.url;
        lastProgressAt = Date.now();
        await writeSidecar(dest, state);
        paint(true);
      }catch(e){
        if(e && e.cancelled){ fatal = fatal || { cancelled: true }; return; }
        // 回退本次失败尝试已计入的字节，重试时重新累计
        const rolled = received - mark;
        if(rolled > 0){ received -= rolled; paint(true); }
        if(e && e.sourceDead) srcDead(src); else srcFail(src);
        // 退避：先短后长，但封顶；单块连续失败到一定次数后放长，避免空转抢带宽
        const next = fails + 1;
        const delay = Math.min(15000, 400 * Math.pow(1.7, Math.min(next, 6)));
        requeue(idx, next, e, delay);
        logish('第 ' + (idx + 1) + ' 块第 ' + next + ' 次失败（' + (src.name || src.url) + '）：' +
          ((e && e.message) || e) + '，' + Math.round(delay / 1000) + 's 后重试');
      }
    }
  };

  /* 全局停滞看门狗：连续 stallMs 一个字节都没进来才算失败。
   * 分片级故障交给重排队处理，不再「一块失败 5 次就抛错」。 */
  const stallMs = o.stallMs || STALL_MS;
  const watchdog = setInterval(() => {
    if(fatal) return;
    if(done.size >= chunkCount) return;
    if(Date.now() - lastProgressAt > stallMs){
      const left = chunkCount - done.size;
      const stuckNote = retryQ.length ? ('，其中 ' + retryQ.length + ' 块仍在重试') : '';
      fatal = new Error(left + ' 块未能下载完成：连续 ' + Math.round(stallMs / 60000 * 10) / 10 +
        ' 分钟没有任何数据' + stuckNote + '（已完成的 ' + done.size + ' 块会保留，重试可从断点续传）');
      fatal.resumable = true;
    }
  }, 1000);
  if(watchdog.unref) watchdog.unref();

  let failure = null;
  try{
    const workers = [];
    const n = Math.min(WORKERS, chunkCount);
    for(let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
  }catch(e){
    failure = e;
  }finally{
    clearInterval(watchdog);
    try{ await fh.close(); }catch(e){}
  }
  if(fatal && !fatal.cancelled){ failure = fatal; }
  if(failure) throw failure;

  if(fatal && fatal.cancelled || isCancelled()){
    await writeSidecar(dest, state);
    return { ok: false, bytes: received, total, source: state.source, resumed, cancelled: true };
  }
  if(done.size < chunkCount){
    await writeSidecar(dest, state);
    const missing = chunkCount - done.size;
    const lastErr = retryQ.length ? ((retryQ[0].err && retryQ[0].err.message) || '') : '';
    const err = new Error(missing + ' 块未能下载完成' + (lastErr ? '（最后一次错误：' + lastErr + '）' : '') +
      '，已完成的 ' + done.size + ' 块会保留，重试可续传');
    err.resumable = true;
    throw err;
  }

  // 收尾：长度对齐（并发位置写不会短，截一下防万一）
  const st = await fsp.stat(dest);
  if(st.size > total){
    const h2 = await fsp.open(dest, 'r+');
    try{ await h2.truncate(total); } finally { try{ await h2.close(); }catch(e){} }
  }
  if(expectPE && !(await hasPEHeader(dest))){
    throw new Error('下载完成但文件不是有效的 Windows 安装包（代理可能返回了错误页）');
  }
  await dropSidecar(dest);
  report({ stage: 'done', done: total, total, pct: 100, speed: speedAvg, etaMs: 0, source: state.source });
  return { ok: true, bytes: total, source: state.source, resumed, cancelled: false };
}

module.exports = {
  PROBE_BYTES, PROBE_MS, CHUNK_BYTES, WORKERS, IDLE_MS, MAX_ATTEMPTS, MAX_CHUNK_TRIES,
  nodeHttpGet, makeElectronHttpGet, pumpToFile, buildSchedule,
  probeOne, pickSources,
  sidecarPath, readSidecar, writeSidecar, dropSidecar,
  download, fmtSpeed, fmtEta, hasPEHeader, chunkLen
};