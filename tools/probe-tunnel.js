#!/usr/bin/env node
/* 探针：分享与反馈（隧道插件）
 *
 * 只测「本机服务」这一半：上传、反馈、口令、限速、大小限制、公网/本机接口隔离。
 * 真实隧道需要联网 + 55 MB 二进制，默认不跑；设 PROBE_LIVE=1 才会真的启动 cloudflared
 * （会外网请求，可能消耗时间，CI 里别开）。
 *
 * 用法：node tools/probe-tunnel.js
 * 产物：PROBE_RUN_DIR/result.json（由 test-headless 注入），否则落 .workbuddy/runs/
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createRun } = require('./probe-run');

const ROOT = path.resolve(__dirname, '..');
const run = createRun('probe-tunnel');
const errors = [];

function check(cond, msg) {
  if (!cond) errors.push(msg);
  console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + msg);
  return !!cond;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch (e) {}
    await sleep(stepMs || 250);
  }
  return false;
}

(async () => {
  const port = await freePort();
  if (!port) {
    check(false, '拿不到空闲端口');
    finish();
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-probe-'));
  const base = 'http://127.0.0.1:' + port;

  const child = spawn(process.execPath, [path.join(ROOT, 'plugins', 'tunnel', 'tunnel.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      TUNNEL_DIR: dataDir
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });

  try {
    const up = await waitFor(async () => {
      const r = await fetch(base + '/health');
      return r.ok;
    }, 15000);
    if (!check(up, '本地服务启动并响应 /health')) {
      console.log(out);
      finish();
      return;
    }

    const st = await (await fetch(base + '/api/status')).json();
    check(st && st.ok === true, '/api/status 返回 ok');
    check(!!(st.config && st.config.key && st.config.key.length >= 6), '启动时自动生成访问口令');
    check(st.config.keyOn === true, '默认启用口令保护');
    const key = st.config.key;

    /* —— 上传 —— */
    const payload = Buffer.from('hello tunnel');
    const up1 = await fetch(base + '/api/upload?name=' + encodeURIComponent('probe-上传.txt') + '&k=' + key, {
      method: 'PUT',
      body: payload
    });
    const up1j = await up1.json().catch(() => ({}));
    check(up1.status === 200 && up1j.ok === true, '带口令上传二进制成功');

    const saved = fs.readdirSync(path.join(dataDir, 'uploads'));
    check(saved.length === 1 && saved[0].indexOf('probe-上传.txt') > 0, '上传文件落盘且保留中文名');
    const savedBuf = fs.readFileSync(path.join(dataDir, 'uploads', saved[0]));
    check(savedBuf.equals(payload), '落盘内容与上传字节一致');

    const list = await (await fetch(base + '/api/uploads')).json();
    check(list.items && list.items.length === 1 && list.items[0].size === payload.length, '上传列表返回大小');

    /* —— 反馈 —— */
    const fb = await fetch(base + '/api/feedback?k=' + key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '探针', contact: 'probe@local', text: '这是一条测试反馈' })
    });
    check(fb.status === 200, '提交反馈成功');
    const fbList = await (await fetch(base + '/api/feedback')).json();
    check(fbList.items && fbList.items.length === 1 && fbList.items[0].text === '这是一条测试反馈', '反馈列表可读回');

    const empty = await fetch(base + '/api/feedback?k=' + key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' })
    });
    check(empty.status === 400, '空反馈被拒绝');

    /* —— 公网 / 本机接口隔离 —— */
    const cfHeaders = { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'probe' };
    const stPublic = await fetch(base + '/api/status', { headers: cfHeaders });
    check(stPublic.status === 404 || stPublic.status === 403, '公网请求读不到管理接口 /api/status');

    const gate = await fetch(base + '/', { headers: cfHeaders });
    const gateText = await gate.text();
    check(gate.status === 200 && gateText.indexOf('需要访问口令') >= 0, '公网无口令访问展示口令页');

    const page = await fetch(base + '/?k=' + key, { headers: cfHeaders });
    const pageText = await page.text();
    check(page.status === 200 && pageText.indexOf('上传资源') >= 0, '公网带口令访问展示分享页');
    check(pageText.indexOf(dataDir) < 0, '分享页不泄露本机路径');

    const noKey = await fetch(base + '/api/upload?name=x.txt', {
      method: 'PUT',
      headers: cfHeaders,
      body: Buffer.from('x')
    });
    check(noKey.status === 401, '公网无口令上传被拒绝');

    /* —— 大小限制 —— */
    await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxMB: 1 })
    });
    const big = await fetch(base + '/api/upload?name=big.bin&k=' + key, {
      method: 'PUT',
      body: Buffer.alloc(2 * 1024 * 1024, 1)
    });
    check(big.status === 413, '超过单文件上限返回 413');
    const stillOne = fs.readdirSync(path.join(dataDir, 'uploads')).length;
    check(stillOne === 1, '超限上传没有留下半截文件');

    /* —— 配置持久化 —— */
    const st2 = await (await fetch(base + '/api/status')).json();
    check(st2.config.maxMB === 1, '配置修改即时生效');
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    check(disk.maxMB === 1 && disk.key === key, '配置与口令已落盘');

    /* —— 真实隧道（可选） —— */
    if (process.env.PROBE_LIVE === '1') {
      await fetch(base + '/api/tunnel/start', { method: 'POST' });
      const live = await waitFor(async () => {
        const s = await (await fetch(base + '/api/status')).json();
        if (s.tunnel && s.tunnel.status === 'running' && s.tunnel.url) return s.tunnel.url;
        if (s.tunnel && s.tunnel.status === 'error') throw new Error(s.tunnel.error || '隧道失败');
        return false;
      }, 240000, 1500);
      check(!!live, '真实隧道拿到公网地址' + (live ? '：' + live : ''));
      if (live) {
        const r = await fetch(String(live) + '/?k=' + key);
        check(r.status === 200, '公网地址可访问');
      }
      await fetch(base + '/api/tunnel/stop', { method: 'POST' });
    } else {
      console.log('[SKIP] 真实隧道（设置 PROBE_LIVE=1 才跑）');
    }
  } catch (e) {
    errors.push('探针异常：' + ((e && e.stack) || e));
    console.log(out);
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  finish();

  function finish() {
    const ok = run.finish(errors, { port: port });
    process.exit(ok ? 0 : 1);
  }
})();
