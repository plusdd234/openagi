/* 体检：中转地址被填成乱值时，不能「明明 relay 在跑却报未连接」
 * 断言数见末尾。不依赖真实中转——健康检查用桩响应。 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const TARGET = pathToFileURL(path.join(__dirname, '..', '..', '..', 'index.html')).href + '?nostore=1';
let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));

  // 桩：/health 一律成功，与真实 relay 的返回结构一致
  let hit = 0;
  await page.route('**/health', async route => {
    hit++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, service: 'open-agi-relay' }) });
  });

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(600);

  console.log('=== 1. 地址被填成别的内容时的兜底 ===');
  const r1 = await page.evaluate(() => {
    $('relayUrl').value = '武器，物体等';
    return { base: relayBase(), issue: relayUrlIssue(), raw: relayRaw() };
  });
  check('非法地址不再被拿去发请求', r1.base === 'http://127.0.0.1:8787', 'base=' + r1.base);
  check('给出明确的原因说明', /不是合法的 http 地址/.test(r1.issue), 'issue=' + r1.issue);

  console.log('\n=== 2. 测试中转：能连上就说连上，不再误报 ===');
  const r2 = await page.evaluate(async () => {
    $('relayUrl').value = '武器，物体等';
    await testRelay();
    return { text: $('relayStatus').textContent, target: relayBase() };
  });
  check('桩服务可达时显示「中转正常」', /中转正常/.test(r2.text), 'text=' + r2.text);
  check('同时提示地址已被替换', /不是合法的 http 地址/.test(r2.text), 'text=' + r2.text);

  console.log('\n=== 3. 服务真没开时，说清是「请求发不出去」 ===');
  await page.unroute('**/health');
  await page.route('**/health', route => route.abort('connectionrefused'));
  const r3 = await page.evaluate(async () => {
    $('relayUrl').value = '';
    await testRelay();
    return { text: $('relayStatus').textContent };
  });
  check('失败时报出目标地址', /127\.0\.0\.1:8787/.test(r3.text), 'text=' + r3.text);
  check('失败时说明是请求发不出去', /请求发不出去|未连接/.test(r3.text), 'text=' + r3.text);
  check('提示了启动方式', /start\.bat/.test(r3.text), 'text=' + r3.text);
  check('提示了代理可能性', /代理/.test(r3.text), 'text=' + r3.text);

  console.log('\n=== 4. 少写协议头时自动补全，不误清空 ===');
  const r4 = await page.evaluate(() => {
    const out = {};
    $('llmBaseUrl').value = 'api.lingsuan.si/v1';
    $('relayUrl').value = '127.0.0.1:8787';
    const r = sanitizeCfg();
    out.llm = $('llmBaseUrl').value;
    out.relay = $('relayUrl').value;
    out.fixed = r.fixed.length;
    $('llmBaseUrl').value = 'https://api.lingsuan.si/v1';
    $('relayUrl').value = 'http://127.0.0.1:8787';
    return out;
  });
  check('域名补 https', r4.llm === 'https://api.lingsuan.si/v1', 'llm=' + r4.llm);
  check('本机地址补 http', r4.relay === 'http://127.0.0.1:8787', 'relay=' + r4.relay);

  console.log('\n=== 5. 非法值自愈（重启页面即生效）===');
  // 注：reload 会触发 beforeunload 的 saveAll，输入框当前值会覆盖这里写的值，
  // 所以 localStorage 和输入框要一起设成脏值
  await page.evaluate(() => {
    localStorage.setItem('hf_relayUrl', '武器，物体等');
    localStorage.setItem('hf_imgSize', '结果');
    localStorage.setItem('hf_imgEndpoint', '图集');
    localStorage.setItem('hf_imgBaseUrl', '拓扑结构');
    localStorage.setItem('hf_llmBaseUrl', 'https://api.lingsuan.si/v1');
    localStorage.setItem('hf_llmModel', 'deepseek-chat');
    $('relayUrl').value = '武器，物体等';
    $('imgSize').value = '结果';
    $('imgEndpoint').value = '图集';
    $('imgBaseUrl').value = '拓扑结构';
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const r5 = await page.evaluate(() => ({
    relay: $('relayUrl').value, relayBase: relayBase(), ls: localStorage.getItem('hf_relayUrl'),
    size: $('imgSize').value, endpoint: $('imgEndpoint').value, imgBase: $('imgBaseUrl').value,
    llm: $('llmBaseUrl').value
  }));
  check('非法中转地址被清掉', r5.relay === '', 'relay=' + r5.relay + ' ls=' + r5.ls);
  check('实际使用的地址回到默认', r5.relayBase === 'http://127.0.0.1:8787', 'base=' + r5.relayBase);
  check('尺寸恢复默认', r5.size === '1024x1024', 'size=' + r5.size);
  check('接口路径恢复默认', r5.endpoint === '/images/edits', 'endpoint=' + r5.endpoint);
  check('非法生图地址被清掉', r5.imgBase === '', 'imgBase=' + r5.imgBase);
  check('合法的分析地址不受影响', r5.llm === 'https://api.lingsuan.si/v1', 'llm=' + r5.llm);

  console.log('\n=== 6. 模型名不像 id 时只提醒，不擅自改 ===');
  const r6 = await page.evaluate(() => {
    $('llmModel').value = '原画';
    const r = sanitizeCfg();
    return { kept: $('llmModel').value, warned: r.warned.join('；') };
  });
  check('模型名保留原值', r6.kept === '原画', 'kept=' + r6.kept);
  check('给出提醒', /不像模型 id/.test(r6.warned), 'warned=' + r6.warned);

  console.log('\n=== 7. 「恢复默认」按钮 ===');
  const r7 = await page.evaluate(() => {
    $('relayUrl').value = '武器，物体等';
    $('btnRelayDefault').click();
    return { val: $('relayUrl').value, text: $('relayStatus').textContent, base: relayBase() };
  });
  check('清空后回到默认地址', r7.val === '' && r7.base === 'http://127.0.0.1:8787', JSON.stringify(r7));
  check('界面给出确认', /已恢复默认中转地址/.test(r7.text), 'text=' + r7.text);

  console.log('\n=== 页面错误 ===');
  const fatal = errors.filter(e => /ReferenceError|is not defined|is not a function/.test(e));
  check('无致命脚本错误', fatal.length === 0, fatal.join(' | '));

  console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
