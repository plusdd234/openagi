/* 体检：账号网关（server/gateway.js）
 * 真起一个网关进程 + 一个假上游，覆盖：
 *   健康检查 / 注册（首个账号是管理员）/ 重复邮箱 / 密码错误 / 登录
 *   /auth/me 的额度 / 非流式转发 / 流式转发 / 额度用尽 429 / 退出后旧令牌失效
 *   邀请码开关 / 未配置上游时 503
 * 零外部依赖、零真实 API Key。
 * 用法：node tools/gateway.js
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

async function waitHealth(port, tries){
  for(let i = 0; i < (tries || 40); i++){
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/healthz');
      if(r.ok) return await r.json();
    } catch(e){}
    await sleep(100);
  }
  throw new Error('网关没起来');
}

async function post(port, p, body, token){
  const r = await fetch('http://127.0.0.1:' + port + p, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch(e){}
  return { status: r.status, json };
}

/* 假上游：非流式返回 JSON，流式按 SSE 分块返回 */
function mockUpstream(port){
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch(e){}
    if(body.stream){
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for(const part of ['你好', '，世界']){
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n');
        await sleep(20);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1',
      model: body.model,
      choices: [{ message: { role: 'assistant', content: '来自假上游：' + (body.messages ? body.messages.length : 0) + ' 条消息' } }]
    }));
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

function startGateway(port, dataDir, extraEnv){
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'gateway.js'), '--port=' + port, '--data=' + dataDir], {
    env: Object.assign({}, process.env, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  proc.stdout.on('data', d => logs.push(String(d)));
  proc.stderr.on('data', d => logs.push(String(d)));
  return { proc, logs };
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openagi-gw-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const upPort = await freePort();
  const gwPort = await freePort();
  const upstream = await mockUpstream(upPort);

  // 额度 2 次/人、关掉最小间隔（否则测试自己会被限流）；上游 Key 从 env 给
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    minIntervalMs: 0, maxConcurrent: 4, tokenDays: 7,
    upstreamBase: 'http://127.0.0.1:' + upPort,
    dailyCredits: 0.3, dailyLimit: 100,
    defaultModel: 'cheap',
    models: [
      { id: 'cheap', label: '便宜模型', multiplier: 0.11, tags: ['夜间折扣'] },
      { id: 'free',  label: '免费模型', multiplier: 0,    tags: ['限时免费'] },
      { id: 'dear',  label: '贵模型',   multiplier: 1.2 }
    ]
  }, null, 1));

  const gw = startGateway(gwPort, dataDir, { GATEWAY_UPSTREAM_KEY: 'sk-test' });
  const health = await waitHealth(gwPort);

  console.log('\n=== 1. 健康检查与首次注册 ===');
  check(health.ok === true, '网关可用', JSON.stringify(health));
  check(health.users === 0, '初始没有账号');
  const reg = await post(gwPort, '/auth/register', { email: 'boss@test.com', password: 'secret123' });
  check(reg.status === 200 && reg.json.token, '注册成功并拿到令牌', String(reg.status));
  check(reg.json.user.role === 'admin', '第一个账号是管理员', reg.json.user.role);
  check(reg.json.user.usage.credits === 0.3 && reg.json.user.usage.cost === 0, '带回额度信息', JSON.stringify(reg.json.user.usage));
  check(reg.json.user.model === 'cheap', '带回默认模型', reg.json.user.model);

  const reg2 = await post(gwPort, '/auth/register', { email: 'boss@test.com', password: 'secret123' });
  check(reg2.status === 409, '重复邮箱被拒', String(reg2.status));
  const badEmail = await post(gwPort, '/auth/register', { email: 'not-an-email', password: 'secret123' });
  check(badEmail.status === 400, '邮箱格式校验', String(badEmail.status));
  const shortPw = await post(gwPort, '/auth/register', { email: 'a@b.com', password: '123' });
  check(shortPw.status === 400, '密码长度校验', String(shortPw.status));

  console.log('\n=== 2. 登录与身份 ===');
  const wrong = await post(gwPort, '/auth/login', { email: 'boss@test.com', password: 'nope' });
  check(wrong.status === 401, '密码错误 401', String(wrong.status));
  const login = await post(gwPort, '/auth/login', { email: 'boss@test.com', password: 'secret123' });
  check(login.status === 200 && login.json.token, '登录成功');
  const token = login.json.token;

  const meNoAuth = await fetch('http://127.0.0.1:' + gwPort + '/auth/me');
  check(meNoAuth.status === 401, '未带令牌访问 /auth/me 被拒', String(meNoAuth.status));
  const me = await fetch('http://127.0.0.1:' + gwPort + '/auth/me', { headers: { authorization: 'Bearer ' + token } });
  const meJson = await me.json();
  check(me.status === 200 && meJson.user.email === 'boss@test.com', '/auth/me 返回本人', JSON.stringify(meJson.user && meJson.user.email));

  console.log('\n=== 3. 模型目录 ===');
  const models = await (await fetch('http://127.0.0.1:' + gwPort + '/v1/models', { headers: { authorization: 'Bearer ' + token } })).json();
  check(Array.isArray(models.data) && models.data.length === 3, '返回三个模型', String(models.data && models.data.length));
  check(models.default === 'cheap', '带默认模型', models.default);
  const cheap = (models.data || []).find(m => m.id === 'cheap') || {};
  check(cheap.label === '便宜模型' && cheap.multiplier === 0.11, '模型带显示名与倍率', JSON.stringify(cheap));
  check(Array.isArray(cheap.tags) && cheap.tags[0] === '夜间折扣', '模型带标签', JSON.stringify(cheap.tags));

  const noAuthModels = await fetch('http://127.0.0.1:' + gwPort + '/v1/models');
  check(noAuthModels.status === 401, '未登录不能读模型列表', String(noAuthModels.status));

  console.log('\n=== 4. 转发与倍率扣费 ===');
  const r1 = await post(gwPort, '/v1/chat/completions', {
    model: 'cheap', messages: [{ role: 'user', content: '你好' }]
  }, token);
  check(r1.status === 200 && /来自假上游/.test(r1.json.choices[0].message.content), '非流式转发成功', JSON.stringify(r1.json).slice(0, 80));

  const streamRes = await fetch('http://127.0.0.1:' + gwPort + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ model: 'cheap', stream: true, messages: [{ role: 'user', content: '说说看' }] })
  });
  check(streamRes.status === 200, '流式请求返回 200', String(streamRes.status));
  const ctype = streamRes.headers.get('content-type') || '';
  check(/event-stream/.test(ctype), '流式响应的 content-type 正确', ctype);
  const chunks = [];
  const reader = streamRes.body.getReader();
  while(true){ const { done, value } = await reader.read(); if(done) break; chunks.push(Buffer.from(value).toString('utf8')); }
  const sse = chunks.join('');
  check(/你好/.test(sse) && /\[DONE\]/.test(sse), 'SSE 分块被原样透传', sse.replace(/\n/g, ' ').slice(0, 60));

  const me2 = await (await fetch('http://127.0.0.1:' + gwPort + '/auth/me', { headers: { authorization: 'Bearer ' + token } })).json();
  check(me2.user.usage.requests === 2 && me2.user.usage.cost === 0.22, '两次调用按 0.11x 累计消耗 0.22', JSON.stringify(me2.user.usage));

  const unknown = await post(gwPort, '/v1/chat/completions', { model: 'gpt-5-ultra', messages: [{ role: 'user', content: 'x' }] }, token);
  check(unknown.status === 400 && /不在可用列表/.test(unknown.json.error || ''), '目录外的模型被拒', String(unknown.status) + ' ' + (unknown.json && unknown.json.error));

  const dear = await post(gwPort, '/v1/chat/completions', { model: 'dear', messages: [{ role: 'user', content: 'x' }] }, token);
  check(dear.status === 429 && /额度/.test(dear.json.error || ''), '额度不足时拒绝贵模型', String(dear.status) + ' ' + (dear.json && dear.json.error));

  const free = await post(gwPort, '/v1/chat/completions', { model: 'free', messages: [{ role: 'user', content: '免费来一发' }] }, token);
  check(free.status === 200, '额度用完后免费模型仍可用', String(free.status));

  console.log('\n=== 5. 退出后旧令牌失效 ===');
  const out = await post(gwPort, '/auth/logout', {}, token);
  check(out.status === 200, '退出成功');
  const meAfter = await fetch('http://127.0.0.1:' + gwPort + '/auth/me', { headers: { authorization: 'Bearer ' + token } });
  check(meAfter.status === 401, '旧令牌立刻失效', String(meAfter.status));
  const proxyAfter = await post(gwPort, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, token);
  check(proxyAfter.status === 401, '旧令牌不能再调模型', String(proxyAfter.status));

  console.log('\n=== 6. 邀请码开关 ===');
  const gw2Port = await freePort();
  const gw2 = startGateway(gw2Port, dataDir, { GATEWAY_REGISTER_CODE: 'invite-123' });
  await waitHealth(gw2Port);
  const noCode = await post(gw2Port, '/auth/register', { email: 'x@y.com', password: 'secret123' });
  check(noCode.status === 403, '没带邀请码被拒', String(noCode.status));
  const withCode = await post(gw2Port, '/auth/register', { email: 'x@y.com', password: 'secret123', code: 'invite-123' });
  check(withCode.status === 200, '带对邀请码可注册', String(withCode.status));
  check(withCode.json.user.role === 'user', '第二个账号是普通用户', withCode.json.user.role);
  gw2.proc.kill();

  console.log('\n=== 7. 未配置上游时的提示 ===');
  const gw3Port = await freePort();
  const dataDir3 = path.join(root, 'data3');
  await fsp.mkdir(dataDir3, { recursive: true });
  const gw3 = startGateway(gw3Port, dataDir3, { GATEWAY_UPSTREAM_BASE: '', GATEWAY_UPSTREAM_KEY: '' });
  await waitHealth(gw3Port);
  const reg3 = await post(gw3Port, '/auth/register', { email: 'z@z.com', password: 'secret123' });
  const noUp = await post(gw3Port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, reg3.json.token);
  check(noUp.status === 503 && /上游/.test(noUp.json.error || ''), '没配上游时给出明确提示', String(noUp.status) + ' ' + (noUp.json && noUp.json.error));
  gw3.proc.kill();

  gw.proc.kill();
  upstream.close();
  await sleep(200);
  await fsp.rm(root, { recursive: true, force: true });

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
