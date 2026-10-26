/* 体检：交流社区服务（server/chat.js）
 * 覆盖：SSE 握手 / 发消息广播 / 两个客户端互通 / 频率限制 / 长度限制 / 屏蔽词 /
 *       在线人数 / 断线重连带 since 补历史 / 管理员删除 / 重启后历史仍在
 * 零依赖、零真实用户。
 * 用法：node tools/chat.js
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort(){
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function parseBlock(b){
  let event = 'message', data = '';
  b.split('\n').forEach(line => {
    if(line.startsWith('event:')) event = line.slice(6).trim();
    else if(line.startsWith('data:')) data += line.slice(5).trim();
  });
  if(!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch(e){ return { event, data: null }; }
}
async function openSSE(url){
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const events = [];
  let buf = '';
  const reader = res.body.getReader();
  (async () => {
    try {
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        buf += Buffer.from(value).toString('utf8');
        let i;
        while((i = buf.indexOf('\n\n')) >= 0){
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = parseBlock(block);
          if(ev) events.push(ev);
        }
      }
    } catch(e){}
  })();
  return { events, close: () => { try { ctrl.abort(); } catch(e){} } };
}
async function waitFor(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 3000)){
    const v = fn();
    if(v) return v;
    await sleep(50);
  }
  return null;
}
async function post(port, p, body){
  const r = await fetch('http://127.0.0.1:' + port + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch(e){}
  return { status: r.status, json };
}
function startChat(port, dataDir){
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'chat.js'), '--port=' + port, '--data=' + dataDir], {
    env: Object.assign({}, process.env, { CHAT_ADMIN_KEY: 'adm-123' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  proc.stdout.on('data', d => logs.push(String(d)));
  proc.stderr.on('data', d => logs.push(String(d)));
  return { proc, logs };
}
async function waitHealth(port){
  for(let i = 0; i < 50; i++){
    try { const r = await fetch('http://127.0.0.1:' + port + '/healthz'); if(r.ok) return await r.json(); } catch(e){}
    await sleep(120);
  }
  throw new Error('社区服务没起来');
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openagi-chat-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    chatRateMs: 300, chatMaxLen: 100, chatBlockWords: ['广告'], chatKeep: 500
  }, null, 1));

  const port = await freePort();
  let chat = startChat(port, dataDir);
  const health = await waitHealth(port);

  console.log('\n=== 1. 初始状态与握手 ===');
  check(health.ok === true && health.online === 0, '服务可用且初始无人', JSON.stringify(health));
  const a = await openSSE('http://127.0.0.1:' + port + '/chat/events?cid=c1&name=%E7%94%B2');
  const hello = await waitFor(() => a.events.find(e => e.event === 'hello'));
  check(!!hello, '收到 hello 握手', hello ? JSON.stringify(hello.data) : 'timeout');
  check(hello && hello.data.cid === 'c1', '握手带回自己的 cid');

  console.log('\n=== 2. 发消息与广播 ===');
  const m1 = await post(port, '/chat/messages', { cid: 'c1', name: '甲', text: '大家好，我是甲' });
  check(m1.status === 200 && m1.json.message.text === '大家好，我是甲', '发送成功', String(m1.status));
  const got1 = await waitFor(() => a.events.find(e => e.event === 'message' && e.data.text === '大家好，我是甲'));
  check(!!got1, '自己也能收到自己的消息');

  const b = await openSSE('http://127.0.0.1:' + port + '/chat/events?cid=c2&name=%E4%B9%99');
  await waitFor(() => b.events.find(e => e.event === 'hello'));
  const m2 = await post(port, '/chat/messages', { cid: 'c2', name: '乙', text: '我是乙，多交流' });
  check(m2.status === 200, '第二个客户端发送成功');
  const gotA = await waitFor(() => a.events.find(e => e.event === 'message' && e.data.cid === 'c2'));
  check(!!gotA, '甲收到了乙的消息（跨客户端广播）', gotA ? gotA.data.text : 'timeout');

  const st = await (await fetch('http://127.0.0.1:' + port + '/chat/state')).json();
  check(st.online === 2 && st.total === 2, '在线人数与消息数正确', JSON.stringify(st));

  console.log('\n=== 3. 限制 ===');
  const tooFast = await post(port, '/chat/messages', { cid: 'c1', name: '甲', text: '再来一句' });
  check(tooFast.status === 429 && /太快/.test(tooFast.json.error || ''), '发太快被限流', String(tooFast.status) + ' ' + (tooFast.json && tooFast.json.error));

  await sleep(350);
  const tooLong = await post(port, '/chat/messages', { cid: 'c1', name: '甲', text: 'x'.repeat(120) });
  check(tooLong.status === 400 && /太长/.test(tooLong.json.error || ''), '超长被拒', String(tooLong.status) + ' ' + (tooLong.json && tooLong.json.error));

  const badWord = await post(port, '/chat/messages', { cid: 'c1', name: '甲', text: '这里有广告内容' });
  check(badWord.status === 400 && /不允许/.test(badWord.json.error || ''), '命中屏蔽词被拒', String(badWord.status) + ' ' + (badWord.json && badWord.json.error));

  const empty = await post(port, '/chat/messages', { cid: 'c1', name: '甲', text: '   ' });
  check(empty.status === 400, '空消息被拒', String(empty.status));

  console.log('\n=== 4. 断线重连补历史 ===');
  const since = m1.json.message.id;
  const c = await openSSE('http://127.0.0.1:' + port + '/chat/events?cid=c3&name=%E4%B8%99&since=' + encodeURIComponent(since));
  await waitFor(() => c.events.find(e => e.event === 'hello'));
  const cMsgs = c.events.filter(e => e.event === 'message').map(e => e.data.text);
  check(cMsgs.indexOf('大家好，我是甲') < 0, 'since 之前的消息不重复下发', cMsgs.join('|'));
  check(cMsgs.indexOf('我是乙，多交流') >= 0, 'since 之后的消息补上了', cMsgs.join('|'));

  console.log('\n=== 5. 管理员删除 ===');
  const badKey = await post(port, '/chat/delete', { key: 'wrong', id: m2.json.message.id });
  check(badKey.status === 403, '管理密钥不对时拒绝', String(badKey.status));
  const del = await post(port, '/chat/delete', { key: 'adm-123', id: m2.json.message.id });
  check(del.status === 200, '管理员删除成功', String(del.status));
  const gotDel = await waitFor(() => a.events.find(e => e.event === 'delete'));
  check(!!gotDel && gotDel.data.id === m2.json.message.id, '删除事件广播给在线客户端');
  const st2 = await (await fetch('http://127.0.0.1:' + port + '/chat/state')).json();
  check(st2.total === 1, '消息数减少', String(st2.total));

  console.log('\n=== 6. 重启后历史仍在 ===');
  a.close(); b.close(); c.close();
  chat.proc.kill();
  await sleep(300);
  const port2 = await freePort();
  chat = startChat(port2, dataDir);
  await waitHealth(port2);
  const st3 = await (await fetch('http://127.0.0.1:' + port2 + '/chat/state')).json();
  check(st3.total === 1, '重启后消息保留', String(st3.total));
  const d2 = await openSSE('http://127.0.0.1:' + port2 + '/chat/events?cid=c4&name=%E4%B8%81');
  await waitFor(() => d2.events.find(e => e.event === 'hello'));
  const hist = d2.events.filter(e => e.event === 'message').map(e => e.data.text);
  check(hist.indexOf('大家好，我是甲') >= 0, '新客户端能看到历史', hist.join('|'));
  check(hist.indexOf('我是乙，多交流') < 0, '被删除的消息不再出现', hist.join('|'));
  d2.close();

  console.log('\n=== 7. 长轮询（不占长连接） ===');
  const lastId = (await (await fetch('http://127.0.0.1:' + port2 + '/chat/state')).json()).lastId;
  const immediate = await (await fetch('http://127.0.0.1:' + port2 + '/chat/poll?since=&wait=0')).json();
  check(Array.isArray(immediate.messages) && immediate.messages.length >= 1, 'since 为空时返回最近历史', String(immediate.messages && immediate.messages.length));

  const pending = fetch('http://127.0.0.1:' + port2 + '/chat/poll?cid=c5&since=' + encodeURIComponent(lastId) + '&wait=8000').then(r => r.json());
  await sleep(300);
  const wake = await post(port2, '/chat/messages', { cid: 'c5', name: '戊', text: '唤醒长轮询' });
  const woken = await pending;
  check(wake.status === 200, '轮询挂起期间发消息成功');
  check(Array.isArray(woken.messages) && woken.messages.some(m => m.text === '唤醒长轮询'), '新消息把挂起的轮询叫醒', JSON.stringify((woken.messages || []).map(m => m.text)));

  const t0 = Date.now();
  const emptyPoll = await (await fetch('http://127.0.0.1:' + port2 + '/chat/poll?cid=c6&since=' + encodeURIComponent(woken.lastId) + '&wait=600')).json();
  const cost = Date.now() - t0;
  check(Array.isArray(emptyPoll.messages) && emptyPoll.messages.length === 0, '没有新消息时返回空数组');
  check(cost >= 500 && cost < 3000, '确实等到了超时才返回（不空转）', cost + 'ms');

  console.log('\n=== 8. 多实例共享同一个数据目录（负载均衡的前提） ===');
  const port3 = await freePort();
  const inst2 = startChat(port3, dataDir);
  await waitHealth(port3);
  const toB = await post(port3, '/chat/messages', { cid: 'c7', name: '己', text: '发给实例二' });
  check(toB.status === 200, '向第二个实例发消息成功');
  const pollA = await (await fetch('http://127.0.0.1:' + port2 + '/chat/poll?cid=c8&since=' + encodeURIComponent(woken.lastId) + '&wait=3000')).json();
  check(Array.isArray(pollA.messages) && pollA.messages.some(m => m.text === '发给实例二'), '实例一能读到实例二收到的消息（无状态共享）', JSON.stringify((pollA.messages || []).map(m => m.text)));
  inst2.proc.kill();

  chat.proc.kill();
  await sleep(150);
  await fsp.rm(root, { recursive: true, force: true });

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
