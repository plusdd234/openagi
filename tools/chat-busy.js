/* 体检：对话 / 生图的「正在跑」锁（chatBusyEnter / chatBusyLeave / chatBusyReset）
 * 用法：node tools/chat-busy.js
 *
 * 为什么单独测这个锁：
 *   它原来是一个裸布尔 `let busy`，而 send() 里会 `await runGen()` —— 两条管线嵌套。
 *   runGen 收尾时把布尔置 false，**外层 send 还没跑完**，发送按钮就解锁了；
 *   这时再点一次发送就是两条并发的 send。这种错不会报错、不会崩，只是偶发地
 *   出现两段交错回复 —— 靠人工点根本复现不出来，只能靠不变量断言。
 *
 * 判据全部走「对外可观测的状态」：isChatBusy() 与 #deskAiSend 的 disabled。
 * 不读 busyDepth 这类内部变量 —— 那是实现细节，换成别的实现也该照样绿。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra !== undefined ? ' · ' + String(extra).slice(0, 160) : ''));
  if (!ok) fails++;
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const snap = () => page.evaluate(() => {
    const b = document.getElementById('deskAiSend');
    return { busy: window.isChatBusy(), disabled: b ? b.disabled : null };
  });

  console.log('\n=== 1. 空闲态 ===');
  const s0 = await snap();
  check(s0.busy === false, '初始没在跑');
  check(s0.disabled === false, '发送按钮可用');

  console.log('\n=== 2. 嵌套：内层收尾不得解锁外层（本次修复的核心） ===');
  const s2 = await page.evaluate(() => {
    const t1 = chatBusyEnter();          // 外层 send
    const t2 = chatBusyEnter();          // 内层 runGen
    chatBusyLeave(t2);                   // 内层先收尾
    const mid = { busy: isChatBusy(), disabled: document.getElementById('deskAiSend').disabled };
    chatBusyLeave(t1);                   // 外层再收尾
    const end = { busy: isChatBusy(), disabled: document.getElementById('deskAiSend').disabled };
    return { mid: mid, end: end };
  });
  check(s2.mid.busy === true, '内层退出后仍算「在跑」（旧实现这里会变 false）');
  check(s2.mid.disabled === true, '内层退出后按钮仍锁着');
  check(s2.end.busy === false, '两层都退出后才空闲');
  check(s2.end.disabled === false, '两层都退出后才解锁');

  console.log('\n=== 3. 用户按「停止」：立刻可操作，且旧请求的收尾不再影响新一轮 ===');
  const s3 = await page.evaluate(() => {
    const old1 = chatBusyEnter();        // 那条被放弃的请求（外层）
    const old2 = chatBusyEnter();        // 它内部的 runGen
    chatBusyReset();                     // 用户点停止 → 换代 + 清零
    const afterReset = { busy: isChatBusy(), disabled: document.getElementById('deskAiSend').disabled };

    const fresh = chatBusyEnter();       // 用户紧接着又发了一条
    chatBusyLeave(old1);                 // 旧请求的 finally 现在才跑到
    chatBusyLeave(old2);
    const afterStale = { busy: isChatBusy(), disabled: document.getElementById('deskAiSend').disabled };

    chatBusyLeave(fresh);
    const done = { busy: isChatBusy(), disabled: document.getElementById('deskAiSend').disabled };
    return { afterReset: afterReset, afterStale: afterStale, done: done };
  });
  check(s3.afterReset.busy === false, '停止后立刻空闲');
  check(s3.afterReset.disabled === false, '停止后按钮立即可用');
  check(s3.afterStale.busy === true, '旧请求的收尾**不**解开新一轮的锁');
  check(s3.afterStale.disabled === true, '新一轮的按钮没有被旧请求解锁');
  check(s3.done.busy === false, '新一轮自己收尾后空闲');
  check(s3.done.disabled === false, '新一轮收尾后解锁');

  console.log('\n=== 4. 多余的收尾不会把状态弄成负数（漏配对的另一侧） ===');
  const s4 = await page.evaluate(() => {
    chatBusyReset();
    chatBusyLeave(chatBusyEnter());   // 正常一进一出
    chatBusyLeave(0);                 // 白给一次
    chatBusyLeave(0);
    const idle = isChatBusy();
    const t = chatBusyEnter();        // 再来一轮，确认还能正常锁上
    const locked = { busy: isChatBusy(), disabled: document.getElementById('deskAiSend').disabled };
    chatBusyLeave(t);
    return { idle: idle, locked: locked, final: isChatBusy() };
  });
  check(s4.idle === false, '多收几次之后仍是空闲（不会变成负深度）');
  check(s4.locked.busy === true && s4.locked.disabled === true, '之后还能正常上锁');
  check(s4.final === false, '正常收尾');

  console.log('\n=== 5. 锁着的时候 send() 不产生新消息 ===');
  const s5 = await page.evaluate(async () => {
    const input = document.getElementById('deskAiText');
    const box = document.querySelector('#chatWin .dchat-log, #chatWin');
    if (input) { input.value = '锁着的时候不该发出去'; input.dispatchEvent(new Event('input')); }
    const t = chatBusyEnter();
    const before = typeof msgs !== 'undefined' ? msgs.length : -1;
    await send();
    const after = typeof msgs !== 'undefined' ? msgs.length : -1;
    chatBusyLeave(t);
    if (input) { input.value = ''; input.dispatchEvent(new Event('input')); }
    return { before: before, after: after, hasMsgs: typeof msgs !== 'undefined' };
  });
  check(s5.hasMsgs === true, '能读到对话状态 msgs');
  check(s5.before === s5.after, '忙时 send() 直接返回，没有新增消息', s5.before + ' → ' + s5.after);

  console.log('\n=== 6. 页面零错误 ===');
  check(errors.length === 0, '全程没有 JS 报错', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + (fails ? '❌ ' + fails + ' 项失败' : '全部通过'));
  process.exit(fails ? 1 : 0);
})();
