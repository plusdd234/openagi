/* cloudflared 下载器（隧道插件专用，不依赖 Electron）
 *
 * 为什么单独一份：plugins 打包后在 resources/bridge/plugins 下，
 * require('../../electron/ollama-download') 在安装版里是断的。
 * 这里只保留「能把一个 55 MB 的 exe 落到本地」所需的最小能力：
 *   - 多镜像顺序回退（GitHub 直连 / 常用加速前缀）
 *   - Range 断点续传（进程被杀、网络中断后接着下）
 *   - 停滞检测（60 秒没有新字节就换源），避免「一直显示下载中但不动」
 *   - .part 临时文件 + 完成后改名，避免半截文件被当成可用二进制
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const IDLE_MS = 60000;        // 单源 60 秒无新字节 → 换源
const CONNECT_MS = 20000;     // 建连超时
const MAX_TOTAL_MS = 20 * 60000;
const PER_SOURCE_TRIES = 3;   // 同一源连续无进展的重试上限
const MIN_VALID = 1024 * 1024;

/* 实测顺序：直连可用但偏慢；gh-proxy 在大文件后半段会卡死，放在后面兜底。
 * 前缀为空字符串表示直连。 */
const MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gitproxy.click/'
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

function openStream(url, headers) {
  return new Promise((resolve, reject) => {
    try { new URL(url); } catch (e) { return reject(new Error('地址无效：' + url)); }
    const follow = (u, hops) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(e); }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(u, { headers: headers || {} }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= 5) return reject(new Error('重定向过多'));
          return follow(new URL(res.headers.location, u).href, hops + 1);
        }
        resolve({ status: res.statusCode, headers: res.headers, stream: res, url: u });
      });
      req.setTimeout(CONNECT_MS, () => { try { req.destroy(new Error('连接超时')); } catch (e) {} });
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

/* 从单个源把剩余字节追加到 part 文件。
 * 返回 { total, size }：total 来自 content-length（可能为 0），size 是落盘后的大小。 */
async function pullToFile(url, partFile, onProgress, idleMs) {
  let have = fileSize(partFile);
  const res = await openStream(url, have > 0 ? { Range: 'bytes=' + have + '-' } : {});
  if (res.status === 416) {
    try { res.stream.resume(); } catch (e) {}
    return { total: have, size: have };
  }
  if (res.status !== 200 && res.status !== 206) {
    try { res.stream.resume(); } catch (e) {}
    throw new Error('HTTP ' + res.status);
  }
  const len = Number(res.headers['content-length'] || 0);
  if (have > 0 && res.status === 200) {
    // 服务端不支持 Range：只能从头写
    have = 0;
    try { fs.truncateSync(partFile, 0); } catch (e) {}
  }
  const total = len ? len + have : 0;
  const ws = fs.createWriteStream(partFile, { flags: have > 0 ? 'a' : 'w' });

  await new Promise((resolve, reject) => {
    let got = 0;
    let settled = false;
    let idleTimer = null;
    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(new Error('停滞 ' + Math.round((idleMs || IDLE_MS) / 1000) + ' 秒')), idleMs || IDLE_MS);
    };
    const stop = err => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      try { res.stream.destroy(); } catch (e) {}
      ws.end(() => (err ? reject(err) : resolve()));
    };
    arm();
    res.stream.on('data', chunk => {
      got += chunk.length;
      if (onProgress) onProgress(have + got, total);
      arm();
    });
    res.stream.on('end', () => stop(null));
    res.stream.on('error', e => stop(e));
    ws.on('error', e => stop(e));
    res.stream.pipe(ws, { end: false });
  });

  return { total: total, size: fileSize(partFile) };
}

/* 下载到 dest；已存在且体积合理时直接复用。
 * opts.onProgress({ got, total, pct, source, bytesPerSec }) */
async function ensure(url, dest, opts) {
  const o = opts || {};
  if (fileSize(dest) > MIN_VALID) return { path: dest, bytes: fileSize(dest), cached: true };

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const deadline = Date.now() + MAX_TOTAL_MS;
  let idx = 0;
  let tries = 0;
  let lastErr = null;

  while (Date.now() < deadline) {
    if (idx >= MIRRORS.length) {
      idx = 0;
      await sleep(1500);
      continue;
    }
    const prefix = MIRRORS[idx];
    const full = prefix ? prefix + url : url;
    const label = prefix ? prefix.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'GitHub 直连';
    const before = fileSize(part);
    const t0 = Date.now();

    try {
      const r = await pullToFile(full, part, (got, total) => {
        if (!o.onProgress) return;
        const dt = Math.max(1, Date.now() - t0) / 1000;
        o.onProgress({
          got: got,
          total: total,
          pct: total ? Math.min(99.9, Math.round(got / total * 1000) / 10) : 0,
          source: label,
          bytesPerSec: Math.round((got - before) / dt)
        });
      }, o.idleMs || IDLE_MS);

      if (r.total && r.size >= r.total) {
        fs.renameSync(part, dest);
        return { path: dest, bytes: r.size, cached: false };
      }
      if (!r.size) throw new Error('没有收到数据');
      // 连接正常结束但长度未知 / 未下满：若大小在增长就继续当前源
      if (r.size > before) { tries = 0; continue; }
      throw new Error('没有进展');
    } catch (e) {
      lastErr = e;
      const grew = fileSize(part) > before;
      if (grew && tries < PER_SOURCE_TRIES) {
        tries++;
        await sleep(800);
        continue;
      }
      tries = 0;
      idx++;
    }
  }

  // 超时：如果已有可观字节，先交出去让调用方试着运行（cloudflared 自检会兜底）
  const size = fileSize(part);
  if (size > MIN_VALID) {
    fs.renameSync(part, dest);
    return { path: dest, bytes: size, cached: false, partial: true };
  }
  throw new Error('下载 cloudflared 失败：' + ((lastErr && lastErr.message) || '网络不可用'));
}

module.exports = { ensure, MIRRORS, fileSize };
