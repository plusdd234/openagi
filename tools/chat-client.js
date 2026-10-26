/* 体检：客户端聊天面板（真服务 + 真浏览器）
 * 覆盖：悬浮按钮打开面板 / 连接成功显示在线数 / 发消息出现在列表 / 收到的消息渲染 / 昵称生效
 * 用法：node tools/chat-client.js
 */
const http = require('http');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');

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
async function waitHealth(port){
  for(let i = 0; i < 50; i++){
    try { const r = await fetch('http://127.0.0.1:' + port + '/healthz'); if(r.ok) return true; } catch(e){}
    await sleep(120);
  }
  throw new Error('社区服务没起来');
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openagi-chatui-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const port = await freePort();
  const chat = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'chat.js'), '--port=' + port, '--data=' + dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitHealth(port);

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1&chat=' + encodeURIComponent('http://127.0.0.1:' + port), { waitUntil: 'load' });
  await page.waitForTimeout(900);

  console.log('\n=== 1. 打开面板并连接 ===');
  const r1 = await page.evaluate(async () => {
    $('chatBtn').click();
    await new Promise(r => setTimeout(r, 900));
    return {
      open: !$('chatPanel').classList.contains('hidden'),
      online: $('chatOnline').textContent,
      hint: $('chatHint').textContent,
      empty: !!document.querySelector('.chat-empty')
    };
  });
  check(r1.open === true, '点悬浮按钮打开面板');
  check(/1 人在线/.test(r1.online), '显示在线人数', r1.online);
  check(r1.empty === true, '空列表给出引导语');
  check(!r1.hint || !/连不上/.test(r1.hint), '连接没有报错', r1.hint);

  console.log('\n=== 2. 发消息 ===');
  const r2 = await page.evaluate(async () => {
    $('chatName').value = '测试员';
    $('chatName').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    $('chatInput').value = '这是一条来自客户端的消息';
    $('chatSend').click();
    await new Promise(r => setTimeout(r, 800));
    const rows = Array.from(document.querySelectorAll('.chat-msg'));
    const last = rows[rows.length - 1] || {};
    return {
      count: rows.length,
      name: (last.querySelector && last.querySelector('.chat-msg-name') || {}).textContent,
      text: (last.querySelector && last.querySelector('.chat-msg-text') || {}).textContent,
      mine: last.classList ? last.classList.contains('mine') : false,
      inputCleared: $('chatInput').value === ''
    };
  });
  check(r2.count >= 1, '消息出现在列表里', String(r2.count));
  check(r2.text === '这是一条来自客户端的消息', '内容正确', r2.text);
  check(r2.name === '测试员', '昵称生效', r2.name);
  check(r2.mine === true, '自己的消息有区分样式');
  check(r2.inputCleared === true, '发送后清空输入框');

  console.log('\n=== 3. 收到别人的消息 ===');
  const r3 = await page.evaluate(async () => {
    const res = await fetch(chatBase() + '/chat/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: 'other-1', name: '路人', text: '我也来接一句' })
    });
    await new Promise(r => setTimeout(r, 700));
    const rows = Array.from(document.querySelectorAll('.chat-msg'));
    const last = rows[rows.length - 1] || {};
    return {
      ok: res.ok,
      text: (last.querySelector && last.querySelector('.chat-msg-text') || {}).textContent,
      mine: last.classList ? last.classList.contains('mine') : true
    };
  });
  check(r3.ok === true, '另一个客户端发送成功');
  check(r3.text === '我也来接一句', '推送实时出现在列表', r3.text);
  check(r3.mine === false, '别人的消息样式不同');

  await page.screenshot({ path: 'C:/Users/30297/AppData/Local/Temp/chat_panel.png', clip: { x: 1040, y: 300, width: 400, height: 600 } });

  console.log('\n=== 4. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  await browser.close();
  chat.kill();
  await sleep(150);
  await fsp.rm(root, { recursive: true, force: true });

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
