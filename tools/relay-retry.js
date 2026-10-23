/* 本地中转（relay.js）重试与容错体检 —— 全程只打本机 mock 上游，不碰真实服务商
 * 场景：
 *  1) 上游首次连接被重置 → 中转自动重试 → 客户端拿到 200
 *  2) 上游持续重置 → 中转重试耗尽 → 客户端拿到可操作的 502 提示（不再是裸 errno）
 *  3) 上游先返回 503 → 中转重试 → 客户端拿到 200
 *  4) /health 暴露重试统计
 * 用法：node tools/relay-retry.js
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const BACKUP_DIR = path.join(os.tmpdir(), 'relay-retry-backups');

const RELAY_PORT = 8899;
const RELAY_BASE = 'http://127.0.0.1:' + RELAY_PORT;

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

// ---- mock 上游 ----
function startMock(mode){
  const state = { hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits++;
    req.resume();
    if (mode === 'always-reset') { req.socket.destroy(); return; }
    if (mode === 'reset-once' && state.hits === 1) { req.socket.destroy(); return; }
    if (mode === '503-once' && state.hits === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service busy' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits: state.hits }));
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port }));
  });
}

// ---- 通过中转发一个请求 ----
function viaRelay(target){
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: RELAY_PORT, path: '/proxy', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
        'X-Relay-Target': target,
      },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.end(JSON.stringify({ hello: 'world' }));
  });
}

function waitHealth(tries = 40){
  return new Promise(async (resolve) => {
    for (let i = 0; i < tries; i++) {
      const r = await new Promise(resolve => {
        const req = http.get(RELAY_BASE + '/health', response => {
          let b = '';
          response.on('data', d => b += d);
          response.on('end', () => resolve(b));
        });
        req.on('error', () => resolve(''));
      });
      if (r) { try { return resolve(JSON.parse(r)); } catch (e) {} }
      await new Promise(r => setTimeout(r, 200));
    }
    resolve(null);
  });
}

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(RELAY_PORT),
      RELAY_RETRY: '2',
      RELAY_RETRY_DELAY: '120',   // 测试里退避快一点
      RELAY_TIMEOUT: '30',
      RELAY_STORE_FILE: path.join(os.tmpdir(), 'relay-retry-test-store.json'),  // 绝不动真实存储
      RELAY_BACKUP_DIR: BACKUP_DIR,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relayLog = [];
  relay.stdout.on('data', d => relayLog.push(d.toString()));
  relay.stderr.on('data', d => relayLog.push('ERR ' + d.toString()));

  try {
    const health = await waitHealth();
    check(!!health, '中转已启动', health ? JSON.stringify(health.retry) : '未就绪');
    if (!health) throw new Error('中转未就绪');

    /* ---------- 1. 首次重置 → 自动重试成功 ---------- */
    const m1 = await startMock('reset-once');
    const r1 = await viaRelay('http://127.0.0.1:' + m1.port + '/v1/chat/completions');
    check(r1.status === 200, '上游首次重置后客户端拿到 200', 'status=' + r1.status + ' body=' + r1.body.slice(0, 60));
    check(m1.state.hits === 2, '上游被请求了 2 次（重试生效）', 'hits=' + m1.state.hits);
    m1.srv.close();

    /* ---------- 2. 持续重置 → 重试耗尽给出可操作提示 ---------- */
    const m2 = await startMock('always-reset');
    const r2 = await viaRelay('http://127.0.0.1:' + m2.port + '/v1/chat/completions');
    check(r2.status === 502, '持续重置 → 502', 'status=' + r2.status);
    check(/ECONNRESET/.test(r2.body) && /重试/.test(r2.body), '错误提示可操作（含 ECONNRESET 与重试说明）', r2.body.slice(0, 110));
    check(m2.state.hits === 3, '上游被请求了 3 次（1 + 2 次重试）', 'hits=' + m2.state.hits);
    m2.srv.close();

    /* ---------- 3. 上游 503 → 重试后成功 ---------- */
    const m3 = await startMock('503-once');
    const r3 = await viaRelay('http://127.0.0.1:' + m3.port + '/v1/chat/completions');
    check(r3.status === 200, '上游 503 后重试成功', 'status=' + r3.status + ' body=' + r3.body.slice(0, 60));
    check(m3.state.hits === 2, '上游被请求了 2 次', 'hits=' + m3.state.hits);
    m3.srv.close();

    /* ---------- 4. 健康检查统计 ---------- */
    const h2 = await waitHealth();
    check(h2 && h2.stats && h2.stats.retried >= 3, '统计记录了重试次数', JSON.stringify(h2 && h2.stats));
    check(h2 && h2.stats && h2.stats.failed >= 1, '统计记录了失败次数', JSON.stringify(h2 && h2.stats));

    /* ---------- 5. 正常转发不受影响 ---------- */
    const m4 = await startMock('ok');
    const r4 = await viaRelay('http://127.0.0.1:' + m4.port + '/v1/chat/completions');
    check(r4.status === 200 && /"ok":true/.test(r4.body), '正常请求一次成功', 'status=' + r4.status);
    check(m4.state.hits === 1, '正常请求不重试', 'hits=' + m4.state.hits);
    m4.srv.close();

    /* ---------- 6. 工作流合并：不同源的流程互不覆盖 ---------- */
    console.log('=== 6. 工作流存储合并 ===');
    const postStore = (key, body) => new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1', port: RELAY_PORT, path: '/store/' + key, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    const getStore = (key) => new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1', port: RELAY_PORT, path: '/store/' + key, method: 'GET',
      }, res => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
      });
      req.on('error', () => resolve(''));
      req.end();
    });

    const mk = (id, name, updated) => ({ id, name, updated, nodes: [{ id: 'n1', type: 'start' }], links: [] });
    await postStore('hf_flows', [mk('flowA', '源A的流程', 1000)]);
    await postStore('hf_flows', [mk('flowB', '源B的流程', 2000)]);
    await new Promise(r => setTimeout(r, 400));
    let merged = [];
    try { merged = JSON.parse(await getStore('hf_flows')); } catch (e) {}
    check(merged.length === 2, '两个源各写一次后磁盘上有 2 个流程（不再互相覆盖）', 'count=' + merged.length);
    check(merged.some(f => f.id === 'flowA') && merged.some(f => f.id === 'flowB'), '两个流程都在');

    // 同 id 写入更新版本 → 取较新的
    await postStore('hf_flows', [mk('flowA', '源A的流程·新版', 5000)]);
    await new Promise(r => setTimeout(r, 400));
    merged = [];
    try { merged = JSON.parse(await getStore('hf_flows')); } catch (e) {}
    const fa = merged.find(f => f.id === 'flowA');
    check(merged.length === 2, '同 id 更新不会减少流程数', 'count=' + merged.length);
    check(fa && fa.updated === 5000 && fa.name === '源A的流程·新版', '同 id 取较新的版本', JSON.stringify(fa && { u: fa.updated, n: fa.name }));

    // 备份目录里应留下历史版本
    const backups = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
    check(backups.length >= 1, '覆盖前已备份旧版本', '备份数=' + backups.length);

    const logs = relayLog.join('');
    check(/重试/.test(logs), '中转日志里有重试记录', logs.split('\n').filter(l => /重试/.test(l)).slice(0, 1).join(' | ').slice(0, 90));
  } finally {
    relay.kill();
  }

  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
