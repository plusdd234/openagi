/* 集成测试：对话「联网搜索」开关
 *
 * 覆盖：
 *   ① 默认关；点一下打开，样式与 aria-pressed、localStorage 都跟着变
 *   ② 打开后发送 → **先检索再回答**：模型收到的 system 里带【联网搜索结果】，
 *      用户那句话本身不被污染（检索块只进 system，不塞进用户消息）
 *   ③ 回答气泡下面列出「联网来源」：编号、解码后的真实地址、新窗口打开
 *   ④ 主来源（DDG）挂了 → **自动换 Bing 兜底**，并在气泡下说明「原来源连不上」
 *   ⑤ 两个都挂 → 失败不阻断对话，且**熔断**（后面几条不再白等一次超时）
 *   ⑥ 关掉之后不再发检索请求（不是「发了不用」）
 *   ⑦ 失败文案分因：中转连不上 / 上游超时 / 上游 HTTP 错误，不能再混成一句话
 *
 * 用法：node tools/desk-chat-websearch.js
 *
 * ⚠ 全程零外网。**mock 必须挂在本地中转 `/proxy` 上**，不是挂在 duckduckgo.com：
 *   页面跑在 file:// 下，直连第三方必然是 CORS 拒，代码已不再先试直连（省一个必失败的来回）。
 *   所以拦截点改成「看 X-Relay-Target 头决定上游回什么」。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DDG_HTML = `
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenagi.dev%2Fdocs&amp;rut=1">OpenAGI 文档</a></h2>
  <a class="result__snippet">开源 AI 工作流工作台，支持可视化节点与多引擎生图。</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://github.com/plusdd234/openagi">GitHub - plusdd234/openagi</a></h2>
  <a class="result__snippet">MIT licensed.</a>
</div>
`;

/* Bing 真实结构：<li class="b_algo"> 里 <h2><a href="真实地址"> + 首个 <p> 摘要。
 * 链接是真实地址（不像百度那样藏一层 link 跳转）。 */
const BING_HTML = `
<ol id="b_results">
<li class="b_algo"><h2><a target="_blank" href="https://openagi.dev/docs" h="ID=SERP,5128.2">OpenAGI <strong>文档</strong></a></h2>
<div class="b_caption"><p>开源 AI 工作流工作台，可视化节点编排。</p></div></li>
<li class="b_algo"><h2><a target="_blank" href="https://github.com/plusdd234/openagi">GitHub - openagi</a></h2>
<div class="b_caption"><p>MIT licensed, self-hosted.</p></div></li>
</ol>
`;

const ANSWER = 'OpenAGI 是一个开源工作台，用节点编排流程 [1]。';

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  let ddgHits = 0;
  let bingHits = 0;
  let proxyHits = 0;
  let ddgDown = false;
  let bingDown = false;
  let relayDead = false;
  let lastBody = null;

  /* 中转是唯一出口：按 X-Relay-Target 分流到不同 fixture */
  await page.route('**/proxy', async route => {
    proxyHits++;
    if (relayDead) return route.abort('failed');
    const target = String(route.request().headers()['x-relay-target'] || '');
    const html = (body, status) => route.fulfill({
      status: status || 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body
    });
    if (target.indexOf('duckduckgo.com') >= 0) {
      ddgHits++;
      return ddgDown ? html('down', 503) : html(DDG_HTML);
    }
    if (target.indexOf('bing.com') >= 0) {
      bingHits++;
      return bingDown ? html('down', 503) : html(BING_HTML);
    }
    return html('unexpected target', 500);
  });

  await page.route('**/chat/completions', async route => {
    try { lastBody = JSON.parse(route.request().postData() || '{}'); } catch (e) { lastBody = null; }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER } }] })
    });
  });

  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1300);

  /* ---------- 造一个能用的对话连接（不碰网络） ---------- */
  await page.evaluate(() => {
    const relay = document.getElementById('relayOn');
    if (relay) { relay.checked = false; relay.dispatchEvent(new Event('change', { bubbles: true })); }
    const base = document.getElementById('llmBaseUrl');
    base.value = 'https://llm.test/v1';
    base.dispatchEvent(new Event('input', { bubbles: true }));
    const key = document.getElementById('llmKey');
    key.value = 'sk-test';
    key.dispatchEvent(new Event('input', { bubbles: true }));

    const sel = document.getElementById('deskAiModel');
    const o = document.createElement('option');
    o.value = 'local:test-model';
    o.textContent = 'test-model';
    sel.appendChild(o);
    sel.value = 'local:test-model';

    localStorage.setItem('hf_wsProvider', 'ddg');
    localStorage.setItem('hf_wsCount', '3');
    try { localStorage.removeItem('hf_desk_websearch'); } catch (e) {}
    window.deskSearch._resetBreaker();
    window.deskChat.webSearch(false);
    /* 这条测试只管「联网」，不管生图路由：显式锁成「仅对话」。
       不锁的话，工作区里残留的 hf_desk_imgmode=image 会把整句判成生图请求，
       结果测出来的是生图链路，跟搜索毫无关系（这个坑真的踩过）。 */
    window.deskChat.imgMode('chat');
  });
  await sleep(250);

  console.log('\n=== 1. 开关存在、默认关、点一下打开 ===');
  const off = await page.evaluate(() => {
    const b = document.getElementById('deskAiWeb');
    return b ? {
      exists: true,
      on: b.classList.contains('is-on'),
      pressed: b.getAttribute('aria-pressed'),
      stored: localStorage.getItem('hf_desk_websearch'),
      title: b.title
    } : { exists: false };
  });
  check(off.exists, '输入条上有联网按钮（#deskAiWeb）');
  check(off.on === false, '默认是关的（不会每句话都去搜）');
  check(off.pressed === 'false', 'aria-pressed=false');
  check(/关/.test(off.title || ''), 'title 说明了当前状态', off.title);

  await page.click('#deskAiWeb');
  await sleep(260);
  const on = await page.evaluate(() => {
    const b = document.getElementById('deskAiWeb');
    return { on: b.classList.contains('is-on'), pressed: b.getAttribute('aria-pressed'), stored: localStorage.getItem('hf_desk_websearch'), title: b.title };
  });
  check(on.on === true, '点一下 → 打开（金黄高亮）');
  check(on.pressed === 'true', 'aria-pressed=true');
  check(on.stored === '1', '状态写进 localStorage（重开还在）', String(on.stored));
  check(/开/.test(on.title || '') && /检索/.test(on.title || ''), 'title 改成「开」并说明会先检索', on.title);

  console.log('\n=== 2. 打开后：先检索，再交给模型 ===');
  await page.fill('#deskAiText', 'OpenAGI 是什么');
  await page.click('#deskAiSend');
  const waitReply = async (label) => {
    try{
      await page.waitForFunction(() => {
        const list = Array.from(document.querySelectorAll('.dchat-msg.ai .dchat-text'));
        const t = list.length ? list[list.length - 1].textContent.trim() : '';
        return !!t && t !== '…';
      }, null, { timeout: 20000 });
    }catch(e){
      /* 只在失败时把现场打出来：这类超时几乎都是「根本没发出去」，光看超时无从下手 */
      const st = await page.evaluate(() => ({
        msgs: (window.deskChat.msgs() || []).map(m => ({ role: m.role, len: (m.content || '').length, err: !!m.error })),
        dot: (document.getElementById('deskAiDot') || {}).title || '',
        toast: (document.getElementById('deskToast') || {}).textContent || '',
        busy: document.getElementById('deskAiSend') ? document.getElementById('deskAiSend').disabled : null
      }));
      console.log('   ⚠ 超时现场（' + label + '）：' + JSON.stringify(st) + ' · ddgHits=' + ddgHits + ' bingHits=' + bingHits);
      throw e;
    }
  };
  await waitReply('联网成功路径');
  await sleep(400);

  check(ddgHits >= 1, '确实发了一次检索请求（走中转）', 'ddgHits=' + ddgHits);
  check(bingHits === 0, '主来源没坏时不去碰兜底源', 'bingHits=' + bingHits);
  check(!!lastBody, '抓到了发给模型的请求体');
  const sysMsg = lastBody && lastBody.messages && lastBody.messages[0];
  check(!!sysMsg && sysMsg.role === 'system', '第一条是 system');
  const sysText = (sysMsg && sysMsg.content) || '';
  check(/【联网搜索结果】/.test(sysText), 'system 里有检索块');
  check(/openagi\.dev\/docs/.test(sysText), '检索块里带真实地址（不是跳转链）');
  check(/\[1\]/.test(sysText), '结果带编号（供模型引用）');
  const userMsg = lastBody && lastBody.messages && lastBody.messages[1];
  check(!!userMsg && userMsg.content === 'OpenAGI 是什么', '用户那句话没被污染（检索块只进 system）', userMsg && userMsg.content);

  console.log('\n=== 3. 气泡下方列出「联网来源」 ===');
  const readLast = () => page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.dchat-msg.ai'));
    const last = rows[rows.length - 1];
    const links = last ? Array.from(last.querySelectorAll('.dchat-src')) : [];
    const label = last ? last.querySelector('.dchat-src-label') : null;
    return {
      count: links.length,
      label: label ? label.textContent : '',
      hrefs: links.map(a => a.getAttribute('href')),
      texts: links.map(a => a.textContent),
      target: links[0] ? links[0].getAttribute('target') : '',
      rel: links[0] ? (links[0].getAttribute('rel') || '') : '',
      text: last ? (last.querySelector('.dchat-text') || {}).textContent || '' : '',
      note: last && last.querySelector('.dchat-srcnote') ? last.querySelector('.dchat-srcnote').textContent : '',
      err: !!(last && last.querySelector('.dchat-body.error'))
    };
  });
  const src = await readLast();
  check(src.count === 2, '列了 2 条来源', 'count=' + src.count);
  check(src.label === '联网来源', '有「联网来源」标签', src.label);
  check(src.hrefs[0] === 'https://openagi.dev/docs', '第一条是解码后的真实地址', src.hrefs[0]);
  check(/^\[1\] /.test(src.texts[0] || ''), '来源带编号', src.texts[0]);
  check(src.target === '_blank' && /noopener/.test(src.rel), '新窗口打开且带 noopener');
  check(!src.note, '成功时不显示失败说明');

  console.log('\n=== 4. 主来源挂了 → 自动换 Bing，并说出来 ===');
  ddgDown = true;
  await page.evaluate(() => window.deskSearch._resetBreaker());
  await page.fill('#deskAiText', '再问一次 OpenAGI 是什么');
  await page.click('#deskAiSend');
  await waitReply('换源兜底');
  await sleep(400);
  const fb = await readLast();
  check(bingHits >= 1, '兜底源（Bing）被调用了', 'bingHits=' + bingHits);
  check(fb.count === 2, '兜底成功后照样列出 2 条来源', 'count=' + fb.count);
  check(/改用/.test(fb.note) && /Bing/.test(fb.note), '气泡下说明「改用了 Bing」', fb.note);
  check(/连不上|HTTP/.test(fb.note), '说明里带上了原来源失败原因', fb.note);
  check(!fb.err, '换源成功不是红色错误气泡');
  const sysFb = (lastBody && lastBody.messages && lastBody.messages[0] && lastBody.messages[0].content) || '';
  check(/【联网搜索结果】/.test(sysFb), '换源后检索块照常进 system');

  console.log('\n=== 5. 中转整体不可达 → 失败不阻断 + 熔断不重发 ===');
  /* ⚠ 熔断只针对**慢**失败（超时 / 中转连不上）。HTTP 503 是毫秒返回的，
   * 缓存它没意义（还可能把用户刚改好的配置挡住）。所以这一段的失败要造成
   * 「中转连不上」——直接让 /proxy 请求失败，正是中转没启动的样子。 */
  relayDead = true;
  bingDown = true;
  const hitsBeforeFail = { ddg: ddgHits, bing: bingHits, proxy: proxyHits };
  await page.fill('#deskAiText', '第三问 OpenAGI 是什么');
  await page.click('#deskAiSend');
  await waitReply('全部失败');
  await sleep(400);
  const failed = await readLast();
  check(!!failed.text && failed.text.indexOf('OpenAGI') >= 0, '照样给出了回答', failed.text.slice(0, 24));
  check(!failed.err, '没有变成红色错误气泡（不因为搜索失败就中断对话）');
  check(/联网搜索失败/.test(failed.note), '气泡下方给出失败说明', failed.note.slice(0, 60));
  check(/中转连不上/.test(failed.note), '原因指向「中转连不上」，不再笼统怪用户没启动', failed.note.slice(0, 60));
  check(failed.count === 0, '失败时不列来源');
  const sys2 = (lastBody && lastBody.messages && lastBody.messages[0] && lastBody.messages[0].content) || '';
  check(/检索失败/.test(sys2), 'system 里告知模型这次没搜到（别装作查过）', sys2.slice(-40));
  check(proxyHits > hitsBeforeFail.proxy, '确实试过一次（不是直接放弃）', hitsBeforeFail.proxy + ' → ' + proxyHits);

  /* 熔断：主来源已记失败，后面这句应当**不再去撞它**
   * （兜底源还会试一次——那条是毫秒级的「连不上」，不是 12 秒超时，不值得也拦掉）。 */
  const before2 = { ddg: ddgHits };
  await page.fill('#deskAiText', '第四问');
  await page.click('#deskAiSend');
  await waitReply('熔断路径');
  await sleep(400);
  const broken = await readLast();
  check(ddgHits === before2.ddg, '熔断后主来源一次都没重发', before2.ddg + ' → ' + ddgHits);
  check(/分钟/.test(broken.note), '说明里给出「N 分钟内不再重试」', broken.note.slice(0, 70));
  check(!!broken.text && broken.text.indexOf('OpenAGI') >= 0, '熔断时照常回答');

  console.log('\n=== 6. 关掉之后不再检索 ===');
  await page.click('#deskAiWeb');
  await sleep(240);
  const after = await page.evaluate(() => ({
    on: document.getElementById('deskAiWeb').classList.contains('is-on'),
    stored: localStorage.getItem('hf_desk_websearch')
  }));
  check(after.on === false && after.stored === '0', '关掉了并落盘（0）', JSON.stringify(after));

  const hitsBefore = ddgHits + bingHits;
  await page.fill('#deskAiText', '第五问 OpenAGI 是什么');
  await page.click('#deskAiSend');
  await waitReply('关闭后');
  await sleep(400);
  check(ddgHits + bingHits === hitsBefore, '关掉后一条检索请求都没发', hitsBefore + ' → ' + (ddgHits + bingHits));
  const sys3 = (lastBody && lastBody.messages && lastBody.messages[0] && lastBody.messages[0].content) || '';
  check(!/【联网搜索结果】/.test(sys3), 'system 里不再有检索块');
  const lastNote = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.dchat-msg.ai'));
    const last = rows[rows.length - 1];
    return last && last.querySelector('.dchat-srcnote') ? last.querySelector('.dchat-srcnote').textContent : '';
  });
  check(!lastNote, '不显示任何搜索说明');

  console.log('\n=== 7. 失败文案分因（别再一律怪「中转没启动」） ===');
  const msgs = await page.evaluate(() => {
    const E = window.deskSearch._errText;
    const timeoutErr = new Error('请求超时（12 秒）');
    const httpErr = new Error('HTTP 403'); httpErr.http = 403;
    const refusedErr = new TypeError('Failed to fetch');
    return {
      timeout: E(timeoutErr, 12000),
      http: E(httpErr, 12000),
      refused: E(refusedErr, 12000)
    };
  });
  check(/中转正常/.test(msgs.timeout) && /没响应/.test(msgs.timeout), '上游超时 → 说「中转正常，源没响应」', msgs.timeout);
  check(/HTTP 403/.test(msgs.http), '上游 HTTP 错 → 原样报状态码', msgs.http);
  check(/中转连不上/.test(msgs.refused) && /启动/.test(msgs.refused), '中转没起 → 说「中转连不上」并给出下一步', msgs.refused);
  check(!/直连/.test(msgs.timeout) && !/直连/.test(msgs.refused), '不再出现「直连 Failed to fetch」这种噪音');

  console.log('\n=== 8. Bing 解析器 ===');
  const parsed = await page.evaluate(html => window.deskSearch._parse.bing(html), BING_HTML);
  check(parsed.length === 2, '解析出 2 条', 'n=' + parsed.length);
  check(parsed[0] && parsed[0].url === 'https://openagi.dev/docs', '第一条地址正确', parsed[0] && parsed[0].url);
  check(parsed[0] && /OpenAGI/.test(parsed[0].title), '标题去掉了 <strong> 标签', parsed[0] && parsed[0].title);
  check(parsed[0] && /工作流/.test(parsed[0].snippet), '摘要来自首个 <p>', parsed[0] && parsed[0].snippet);
  check(parsed[0] && parsed[0].host === 'openagi.dev', '带 host（引用时显示）', parsed[0] && parsed[0].host);

  console.log('\n=== 9. 无页面异常 ===');
  check(errors.length === 0, '没有未捕获的 JS 错误', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有 ' + fails + ' 项未通过'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
