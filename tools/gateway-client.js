/* 体检：账号网关 + 桌面端（真网关 + 假上游 + 真浏览器）
 * 覆盖：设置里的账号页能注册/登录；登录后 llmChat 走网关拿到结果；
 *       未登录时回落到本地 Key（没有 Key 就明确报错）；额度用尽给出可读错误；退出后回到未登录态。
 * 零真实 API Key。
 * 用法：node tools/gateway-client.js
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
    try { const r = await fetch('http://127.0.0.1:' + port + '/healthz'); if(r.ok) return await r.json(); } catch(e){}
    await sleep(120);
  }
  throw new Error('网关没起来');
}
function mockUpstream(port){
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '网关应答：收到 ' + raw.length + ' 字节' } }]
    }));
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openagi-gwc-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const upPort = await freePort();
  const gwPort = await freePort();
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    minIntervalMs: 0, dailyLimit: 100, tokenDays: 7,
    upstreamBase: 'http://127.0.0.1:' + upPort,
    dailyCredits: 0.3, defaultModel: 'cheap',
    models: [
      { id: 'cheap', label: '便宜模型', multiplier: 0.11, tags: ['夜间折扣'] },
      { id: 'free',  label: '免费模型', multiplier: 0,    tags: ['限时免费'] },
      { id: 'dear',  label: '贵模型',   multiplier: 1.2 }
    ]
  }, null, 1));

  const upstream = await mockUpstream(upPort);
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'gateway.js'), '--port=' + gwPort, '--data=' + dataDir], {
    env: Object.assign({}, process.env, { GATEWAY_UPSTREAM_KEY: 'sk-test' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitHealth(gwPort);

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1&gateway=' + encodeURIComponent('http://127.0.0.1:' + gwPort);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 清掉本机可能已保存的自填 Key，保证「未登录」基线干净
  await page.evaluate(() => {
    $('llmKey').value = '';
    $('llmBaseUrl').value = '';
    $('llmModel').value = '';
    localStorage.removeItem('hf_llmKey');
    localStorage.removeItem('hf_preset');
  });

  console.log('\n=== 1. 未登录时的基线 ===');
  const r1 = await page.evaluate(() => ({
    logged: gwLogged(),
    ready: llmReady(),
    via: llmConn().via
  }));
  check(r1.logged === false, '初始未登录');
  check(r1.ready === false, '没有 Key 时 llmReady 为 false');
  check(r1.via === 'local', '未登录走本地路径', r1.via);

  const r2 = await page.evaluate(async () => {
    try { await llmChat('sys', 'hi'); return 'no-throw'; }
    catch(e){ return String(e.message || e); }
  });
  check(/未配置/.test(r2), '未登录且无 Key 时给出明确错误', r2);

  console.log('\n=== 2. 在设置里注册 ===');
  const r3 = await page.evaluate(async () => {
    openSettings('account');
    await new Promise(r => setTimeout(r, 200));
    $('gwEmail').value = 'desk@test.com';
    $('gwPassword').value = 'secret123';
    $('gwRegister').click();
    await new Promise(r => setTimeout(r, 1200));
    return {
      logged: gwLogged(),
      email: (gwUser() || {}).email,
      model: (gwUser() || {}).model,
      usage: ((gwUser() || {}).usage || {}).limit,
      paneTitle: $('gwUserLine').textContent,
      usageText: $('gwUsage').textContent,
      loggedInVisible: !$('gwLoggedIn').classList.contains('hidden'),
      msg: $('gwMsg').textContent
    };
  });
  check(r3.logged === true, '注册后进入登录态', r3.msg);
  check(r3.email === 'desk@test.com' && r3.model === 'cheap', '账号与默认模型都拿到了', r3.email + ' / ' + r3.model);
  check(r3.loggedInVisible === true && /desk@test\.com/.test(r3.paneTitle), '面板切到已登录视图', r3.paneTitle);
  check(/剩余/.test(r3.usageText), '显示剩余额度', r3.usageText);

  console.log('\n=== 3. 模型列表与切换 ===');
  const r3b = await page.evaluate(async () => {
    await gwLoadModels();
    renderGatewayModels();
    const rows = Array.from(document.querySelectorAll('#gwModels .gw-model'));
    const first = rows[0] || {};
    const picker = {
      count: rows.length,
      labels: rows.map(r => (r.querySelector('.m-label') || {}).textContent),
      muls: rows.map(r => (r.querySelector('.m-mul') || {}).textContent),
      tags: rows.map(r => (r.querySelector('.m-tag') || {}).textContent).filter(Boolean),
      checked: rows.filter(r => r.classList.contains('on')).length
    };
    // 选免费模型
    const freeRow = rows.find(r => /免费模型/.test((r.querySelector('.m-label') || {}).textContent || ''));
    freeRow.click();
    await new Promise(r => setTimeout(r, 150));
    return { picker, modelNow: gwModelId(), connModel: llmConn().model, via: llmConn().via };
  });
  check(r3b.picker.count === 3, '面板列出三个云端模型', String(r3b.picker.count));
  check(r3b.picker.labels.join(',') === '便宜模型,免费模型,贵模型', '显示模型名', r3b.picker.labels.join(','));
  check(r3b.picker.muls.join(',') === '0.11x,0.00x,1.20x', '显示倍率', r3b.picker.muls.join(','));
  check(r3b.picker.tags.indexOf('限时免费') >= 0, '显示标签', r3b.picker.tags.join(','));
  check(r3b.picker.checked === 1, '默认模型有且只有一个勾选', String(r3b.picker.checked));
  check(r3b.modelNow === 'free' && r3b.connModel === 'free', '点一下切到免费模型', r3b.modelNow);

  console.log('\n=== 4. 登录后调用走网关 ===');
  const r4 = await page.evaluate(async () => {
    gwSetModel('cheap');
    renderGatewayModels();
    const via = llmConn().via;
    const out = await llmChat('sys', '你好');
    const usage = (gwUser() || {}).usage || {};
    return { via, out, ready: llmReady(), keyEmpty: $('llmKey').value.trim() === '', cost: usage.cost };
  });
  check(r4.via === 'gateway', '凭据来自网关', r4.via);
  check(/网关应答/.test(r4.out), '模型调用经网关拿到结果', r4.out.slice(0, 40));
  check(r4.ready === true && r4.keyEmpty === true, '没有自填 Key 也算就绪', 'keyEmpty=' + r4.keyEmpty);

  console.log('\n=== 5. 额度按倍率消耗 ===');
  const r5 = await page.evaluate(async () => {
    await gwRefreshMe();
    renderGatewayPane();
    const before = (gwUser() || {}).usage || {};
    gwSetModel('dear');
    let err = '';
    try { await llmChat('sys', '用贵的'); } catch(e){ err = String(e.message || e); }
    return { cost: before.cost, remaining: before.remaining, err, usageText: $('gwUsage').textContent };
  });
  check(Math.abs(r5.cost - 0.11) < 1e-6, '一次调用扣 0.11', String(r5.cost));
  check(/额度/.test(r5.err), '贵模型额度不足时给出可读错误', r5.err);
  check(/已用 0\.11/.test(r5.usageText), '面板显示已用额度', r5.usageText);

  console.log('\n=== 6. 自定义模型模式 ===');
  const r6 = await page.evaluate(async () => {
    const custom = $('gwCustom');
    custom.click();
    await new Promise(r => setTimeout(r, 150));
    const localMode = llmMode();
    const viaLocal = llmConn().via;
    // 填自己的 Key 后应当能脱离网关工作（这里只验证路径切换，不真发请求）
    $('llmBaseUrl').value = 'https://custom.example/v1';
    $('llmKey').value = 'sk-own';
    $('llmModel').value = 'my-model';
    const conn = llmConn();
    $('gwUseCloud').click();
    await new Promise(r => setTimeout(r, 150));
    return { localMode, viaLocal, localBase: conn.base, localModel: conn.model, cloudMode: llmMode(), viaCloud: llmConn().via, model: llmConn().model };
  });
  check(r6.localMode === 'local' && r6.viaLocal === 'local', '「配置自定义模型」切到本地路径', r6.localMode);
  check(r6.localBase === 'https://custom.example/v1' && r6.localModel === 'my-model', '本地路径用自己填的地址与模型', r6.localBase + ' / ' + r6.localModel);
  check(r6.cloudMode === 'cloud' && r6.viaCloud === 'gateway' && r6.model === 'dear', '「使用云端模型」切回网关并保留选择', r6.viaCloud + ' / ' + r6.model);

  console.log('\n=== 7. 退出登录 ===');
  const r8 = await page.evaluate(async () => {
    await gwLogout();
    await new Promise(r => setTimeout(r, 200));
    return {
      logged: gwLogged(),
      ready: llmReady(),
      via: llmConn().via,
      loggedOutVisible: !$('gwLoggedOut').classList.contains('hidden'),
      hasSession: !!localStorage.getItem('hf_gw_session')
    };
  });
  check(r8.logged === false && r8.hasSession === false, '会话已清除');
  check(r8.loggedOutVisible === true, '面板回到未登录视图');
  // 第 6 节填过自己的 Key，所以退出后 llmReady 仍为 true（本地 Key 可用），重点是路径回到 local
  check(r8.via === 'local', '退出后回落到本地路径', r8.via + ' / ready=' + r8.ready);

  console.log('\n=== 8. 重新登录（登录而不是注册） ===');
  const r9 = await page.evaluate(async () => {
    const d = await gwLogin('desk@test.com', 'secret123');
    return { ok: !!d.token, email: d.user.email };
  });
  check(r9.ok && r9.email === 'desk@test.com', '同一账号可以再次登录', r9.email);

  console.log('\n=== 9. 页面零错误 ===');
  check(errors.length === 0, '无页面异常', errors.slice(0, 3).join(' | '));

  await browser.close();
  gw.kill();
  upstream.close();
  await sleep(150);
  await fsp.rm(root, { recursive: true, force: true });

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
