#!/usr/bin/env node
/* 探针：邮箱台（maildesk）能否批量申请信箱、集中收信、识别验证码。
 * 用法：node tools/probe-maildesk.js
 *
 * 为什么全程用「演示」服务：
 *   ① mail.tm / mail.gw 在公网且按 IP 限流（实测 /domains 是 1 次/分钟），
 *      探针不该把一次回归跑成「时红时绿」；
 *   ② 默认测试规范要求不访问真实外部服务；
 *   ③ 这里要验的是 App 自己的批量创建、列表、读信、验证码抽取、幂等与持久化，
 *      不是服务商的可用性。真网络由人工在 App 里点「批量申请」验证。
 *
 * 覆盖：
 *   ① 桌面有「邮箱台」图标，点开是完整三栏界面；
 *   ② 一次申请 3 个信箱，地址互不重复且带演示域名；
 *   ③ 选中信箱后能看到来信，点开显示正文、验证码（6 位）与链接；
 *   ④ 验证码按钮带 data-copy，链接按钮带 data-open（复制/打开链路已接）；
 *   ⑤ 搜索过滤只影响列表，不影响已选信箱；
 *   ⑥ 重新打开窗口不重建 DOM、数据不丢（mount 幂等）；
 *   ⑦ 刷新页面后本地保存的信箱仍在（持久化）；
 *   ⑧ 手动登记的 Outlook 邮箱能通过本地中转 IMAP 收信（stub /mail/imap，不联网）；
 *   ⑨ OAuth2 凭证导入、凭证更新、SMTP 发信与 AI 发信动作（stub /mail/smtp，不联网）；
 *   ⑩ 全程无 pageerror。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const run = createRun('probe-maildesk');
let fails = 0;
const failed = [];
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) { fails++; failed.push(name + (extra ? ' · ' + extra : '')); }
};

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.classList.contains('hidden') && cs.display !== 'none' &&
    cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
}, sel);

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));

  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="maildesk"]')),
    '桌面上的「邮箱台」图标存在');

  await page.evaluate(() => window.openDeskApp('maildesk'));
  await page.waitForSelector('#maildeskWin .md-root', { timeout: 8000 });
  await page.waitForTimeout(300);

  check(await visible(page, '#maildeskWin'), '窗口已翻到前台');
  check(await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return !!(w.querySelector('.md-side') && w.querySelector('.md-inbox') && w.querySelector('.md-read'));
  }), '三栏界面（信箱 / 收件箱 / 正文）都在');
  check(await page.evaluate(() => /还没有信箱/.test(document.querySelector('#maildeskWin #mdBoxes').textContent)),
    '空状态给出下一步提示');

  /* ---- 批量申请（演示服务，离线） ---- */
  await page.selectOption('#maildeskWin #mdProvider', 'demo');
  await page.fill('#maildeskWin #mdCount', '3');
  await page.click('#maildeskWin #mdCreate');
  await page.waitForFunction(() => document.querySelectorAll('#maildeskWin .md-box').length === 3, null, { timeout: 8000 });

  const created = await page.evaluate(() => ({
    n: document.querySelectorAll('#maildeskWin .md-box').length,
    addrs: [...document.querySelectorAll('#maildeskWin .md-box-addr')].map(e => e.textContent.trim()),
    count: document.querySelector('#maildeskWin #mdBoxCount').textContent
  }));
  check(created.n === 3 && created.count === '3', '一次申请 3 个信箱', created.n + ' 个 / 计数 ' + created.count);
  check(new Set(created.addrs).size === 3, '地址互不重复', created.addrs.join(' , '));
  check(created.addrs.every(a => /@demo\.maildesk$/.test(a)), '地址都落在演示域名下');

  const demoCred = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return { hidden: w.querySelector('#mdPassRow').hidden, disabled: w.querySelector('#mdCopyPass').disabled };
  });
  check(demoCred.hidden && demoCred.disabled, '没有口令的服务不显示口令行，也不给复制按钮');

  /* 批量申请后自动选中最后一个，先切到第二个信箱验证选中联动 */
  const second = await page.evaluate(() => {
    const boxes = document.querySelectorAll('#maildeskWin .md-box');
    const addr = boxes[1].querySelector('.md-box-addr').textContent.trim();
    boxes[1].click();
    return addr;
  });
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.querySelector('#maildeskWin #mdAddr').textContent.trim()) === second,
    '点第二个信箱后，收件箱标题跟着切换', second);

  /* ---- 读信：正文 / 验证码 / 链接 ---- */
  check(await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-msg').length >= 1),
    '演示信箱里有来信');

  await page.click('#maildeskWin .md-msg');
  await page.waitForTimeout(250);

  const read = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const code = w.querySelector('.md-code');
    const link = w.querySelector('.md-link-row [data-open]');
    return {
      subject: (w.querySelector('.md-read-subject') || {}).textContent || '',
      body: (w.querySelector('.md-body') || {}).textContent || '',
      code: code ? code.textContent.trim() : '',
      codeCopy: code ? code.getAttribute('data-copy') : '',
      links: w.querySelectorAll('.md-link-row').length,
      linkUrl: link ? link.getAttribute('data-open') : ''
    };
  });
  check(/验证码/.test(read.subject) && /验证码/.test(read.body), '正文与主题已显示');
  check(/^\d{6}$/.test(read.code) && read.codeCopy === read.code,
    '验证码被识别出来且带复制数据', read.code);
  check(read.links >= 1 && /^https?:\/\//.test(read.linkUrl), '邮件里的链接被单独列出并可打开', read.linkUrl);

  /* 点击验证码：状态栏要给出复制反馈（是否真写进剪贴板由浏览器权限决定） */
  await page.click('#maildeskWin .md-code');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => /复制/.test(document.querySelector('#maildeskWin #mdStatus').textContent)),
    '点验证码后状态栏给出复制反馈');

  /* ---- 正文工具栏：标为未读 / 再标回已读 ---- */
  await page.click('#maildeskWin [data-read-act="toggle-seen"]');
  await page.waitForTimeout(180);
  const unreadAgain = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const on = w.querySelector('.md-msg.is-on');
    return {
      read: on ? on.classList.contains('is-read') : true,
      status: w.querySelector('#mdStatus').textContent,
      unread: w.querySelector('#mdStatUnread').textContent
    };
  });
  check(!unreadAgain.read && /未读/.test(unreadAgain.status) && Number(unreadAgain.unread) >= 1,
    '正文工具栏可以把邮件标回未读', '未读统计 ' + unreadAgain.unread);
  await page.click('#maildeskWin [data-read-act="toggle-seen"]');
  await page.waitForTimeout(180);
  check(await page.evaluate(() => {
    const on = document.querySelector('#maildeskWin .md-msg.is-on');
    return !!on && on.classList.contains('is-read');
  }), '再点一次恢复已读');

  /* ---- 本信箱邮件搜索 ---- */
  await page.fill('#maildeskWin #mdMsgSearch', '不存在的邮件关键词');
  await page.waitForTimeout(150);
  const msgFiltered = await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-msg').length);
  await page.fill('#maildeskWin #mdMsgSearch', '');
  await page.waitForTimeout(150);
  const msgRestored = await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-msg').length);
  check(msgFiltered === 0 && msgRestored >= 1, '按关键词过滤本信箱邮件，清空后恢复',
    '过滤后 ' + msgFiltered + ' / 恢复后 ' + msgRestored);

  /* ---- 搜索过滤 ---- */
  await page.fill('#maildeskWin #mdSearch', '不存在的地址');
  await page.waitForTimeout(150);
  const filtered = await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-box').length);
  await page.fill('#maildeskWin #mdSearch', '');
  await page.waitForTimeout(150);
  check(filtered === 0, '搜索无结果时列表清空', '过滤后 ' + filtered + ' 个');
  check(await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-box').length === 3),
    '清空搜索后列表恢复');

  /* ---- 幂等：重新打开不重建 DOM、状态还在 ---- */
  const before = await page.evaluate(() => {
    window.__mdRoot = document.querySelector('#maildeskWin .md-root');
    window.__mdBoxes = document.querySelector('#maildeskWin .md-boxes');
    return {
      addr: document.querySelector('#maildeskWin #mdAddr').textContent.trim(),
      msg: (document.querySelector('#maildeskWin .md-msg.is-on .md-msg-subject') || {}).textContent || ''
    };
  });
  await page.evaluate(() => window.openDeskApp('maildesk'));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    sameRoot: window.__mdRoot === document.querySelector('#maildeskWin .md-root'),
    sameBoxes: window.__mdBoxes === document.querySelector('#maildeskWin .md-boxes'),
    addr: document.querySelector('#maildeskWin #mdAddr').textContent.trim(),
    msg: (document.querySelector('#maildeskWin .md-msg.is-on .md-msg-subject') || {}).textContent || '',
    n: document.querySelectorAll('#maildeskWin .md-box').length
  }));
  check(after.sameRoot && after.sameBoxes, '重新打开窗口没有重建 DOM（mount 幂等）');
  check(after.addr === before.addr && after.msg === before.msg && after.n === 3,
    '重新打开后选中的信箱与正在读的信都还在');

  /* ---- 持久化：整页刷新后本地保存的信箱仍在 ---- */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.openDeskApp('maildesk'));
  await page.waitForSelector('#maildeskWin .md-box', { timeout: 8000 });
  const persisted = await page.evaluate(() => ({
    n: document.querySelectorAll('#maildeskWin .md-box').length,
    provider: document.querySelector('#maildeskWin #mdProvider').value,
    msgs: document.querySelectorAll('#maildeskWin .md-msg').length
  }));
  check(persisted.n === 3 && persisted.provider === 'demo',
    '刷新页面后 3 个信箱与所选服务都恢复了', persisted.n + ' 个 / ' + persisted.provider);
  check(persisted.msgs >= 1, '来信也一并恢复（不是只存了地址）', persisted.msgs + ' 封');

  /* ---- 手动登记 / 重复校验 / 移除 ---- */
  await page.click('#maildeskWin #mdAdd');
  await page.fill('#maildeskWin #mdAddAddr', 'Kayaba@Example.com');
  await page.fill('#maildeskWin #mdAddPass', 'ManualPass9');
  await page.click('#maildeskWin #mdAddSave');
  await page.waitForTimeout(250);
  const manual = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return {
      n: w.querySelectorAll('.md-box').length,
      addr: w.querySelector('#mdAddr').textContent.trim(),
      pass: w.querySelector('#mdPass').textContent.trim(),
      meta: (w.querySelector('.md-box.is-on .md-box-meta') || {}).textContent || '',
      syncDisabled: w.querySelector('#mdSyncOne').disabled
    };
  });
  check(manual.n === 4 && manual.addr === 'kayaba@example.com' && manual.pass === 'ManualPass9',
    '手动添加的邮箱会被选中并显示口令', manual.addr + ' / ' + manual.pass);
  check(/手动登记/.test(manual.meta) && manual.syncDisabled, '手动邮箱标为手动登记，刷新按钮不可用');

  await page.click('#maildeskWin #mdAdd');
  await page.fill('#maildeskWin #mdAddAddr', 'kayaba@example.com');
  await page.click('#maildeskWin #mdAddSave');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return w.querySelectorAll('.md-box').length === 4 && /已经在列表/.test(w.querySelector('#mdStatus').textContent);
  }), '重复地址被拒绝且不新增');

  /* ---- AI 助手：计划渲染、口令不外泄、确认后执行 ---- */
  await page.evaluate(() => {
    window.llmConn = function () { return { base: 'https://mock', key: 'mock-key', model: 'mock-model' }; };
    window.__aiReq = null;
    window.LLMRouter = {
      complete: function (req) {
        window.__aiReq = req;
        return Promise.resolve(JSON.stringify({
          reply: '可以，先添加再移除一个测试信箱。',
          actions: [
            { type: 'add', address: 'agent@example.com', password: 'AgentPass9' },
            { type: 'remove', address: 'agent@example.com' }
          ]
        }));
      }
    };
  });
  await page.click('#maildeskWin #mdAiToggle');
  await page.waitForTimeout(150);
  check(await visible(page, '#maildeskWin #mdAi'), 'AI 助手面板可以展开');
  await page.fill('#maildeskWin #mdAiText', '加一个测试信箱再删掉');
  await page.click('#maildeskWin #mdAiSend');
  await page.waitForSelector('#maildeskWin [data-ai-run]', { timeout: 5000 });
  const aiPlan = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const nodes = w.querySelectorAll('.md-ai-msg.is-agent');
    return {
      text: nodes.length ? nodes[nodes.length - 1].textContent : '',
      req: JSON.stringify(window.__aiReq || {})
    };
  });
  check(/添加手动邮箱 agent@example\.com/.test(aiPlan.text) &&
    /移除 agent@example\.com/.test(aiPlan.text), '模型返回的操作计划被渲染出来');
  check(!/ManualPass9/.test(aiPlan.req), '口令不会进入模型上下文');

  await page.click('#maildeskWin [data-ai-run]');
  await page.waitForTimeout(350);
  const aiDone = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return {
      n: w.querySelectorAll('.md-box').length,
      results: (w.querySelector('.md-ai-results') || {}).textContent || ''
    };
  });
  check(aiDone.n === 4 && /已添加 agent@example\.com/.test(aiDone.results) &&
    /已移除 agent@example\.com/.test(aiDone.results), '确认后执行计划：添加与移除都生效');

  await page.evaluate(() => {
    const boxes = Array.prototype.slice.call(document.querySelectorAll('#maildeskWin .md-box'));
    const target = boxes.filter(function (x) { return /kayaba@example\.com/.test(x.textContent); })[0];
    if (target) target.click();
  });
  await page.waitForTimeout(150);
  await page.click('#maildeskWin #mdRemove');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return w.querySelectorAll('.md-box').length === 3 &&
      w.querySelector('#mdAddr').textContent.trim() !== 'kayaba@example.com';
  }), '移除手动邮箱后列表回到 3 个');

  /* ---- 口令显示：mail.tm 类信箱申请时生成的口令要能看见、能复制 ---- */
  await page.evaluate(() => {
    localStorage.setItem('hf_maildesk_v1', JSON.stringify({
      provider: 'mailtm', count: 1, prefix: '', auto: false, autoSec: 30, activeId: 'seed-pass',
      boxes: [{
        id: 'seed-pass', provider: 'mailtm', address: 'seed@example.com',
        password: 'TestPass1234', token: '', createdAt: Date.now(), lastSync: 0,
        error: '', activeMsgId: '', messages: []
      }]
    }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.openDeskApp('maildesk'));
  await page.waitForSelector('#maildeskWin .md-root', { timeout: 8000 });
  const cred = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return {
      hidden: w.querySelector('#mdPassRow').hidden,
      pass: w.querySelector('#mdPass').textContent.trim(),
      canCopy: !w.querySelector('#mdCopyPass').disabled
    };
  });
  check(!cred.hidden && cred.pass === 'TestPass1234' && cred.canCopy,
    '申请时生成的口令显示在信箱标题下且可复制', cred.pass);

  /* ---- 批量导入：地址 + 口令 + 可选 OAuth2 凭证 ----
   * 第三、四段（client_id / refresh_token）只保存在本机，供收信使用，不在界面显示。 */
  await page.click('#maildeskWin #mdImport');
  await page.waitForTimeout(150);
  check(await visible(page, '#maildeskWin #mdImportModal'), '批量导入弹层可以打开');
  await page.fill('#maildeskWin #mdImportText',
    'alpha@example.com----AlphaPass----CLIENT-ID-1----REFRESH_TOKEN_SAVED_LOCALLY\n' +
    'beta@example.com----BetaPass\n' +
    '这一行不是邮箱');
  await page.click('#maildeskWin #mdImportSave');
  await page.waitForTimeout(350);
  const imported = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const raw = localStorage.getItem('hf_maildesk_v1') || '';
    let alpha = null;
    try {
      alpha = (JSON.parse(raw).boxes || []).filter(function (b) {
        return b.address === 'alpha@example.com';
      })[0] || null;
    } catch (e) { alpha = null; }
    return {
      n: w.querySelectorAll('.md-box').length,
      addr: w.querySelector('#mdAddr').textContent.trim(),
      pass: w.querySelector('#mdPass').textContent.trim(),
      status: w.querySelector('#mdStatus').textContent,
      closed: w.querySelector('#mdImportModal').hidden,
      visibleLeak: document.documentElement.innerHTML.indexOf('REFRESH_TOKEN_SAVED_LOCALLY') >= 0,
      storedToken: alpha ? alpha.refreshToken : '',
      storedClient: alpha ? alpha.clientId : ''
    };
  });
  check(imported.n === 3 && imported.addr === 'beta@example.com' && imported.pass === 'BetaPass' && imported.closed,
    '导入取地址与口令，并自动选中最后一个', imported.addr + ' / ' + imported.pass);
  check(/新增 2 个/.test(imported.status) && /1 行无法识别/.test(imported.status),
    '导入结果给出新增与无法识别的统计', imported.status);
  check(!imported.visibleLeak, 'OAuth2 刷新令牌不在页面上显示');
  check(imported.storedClient === 'CLIENT-ID-1' && imported.storedToken === 'REFRESH_TOKEN_SAVED_LOCALLY',
    'OAuth2 凭证只保存在本机存储');

  /* ---- 筛选计数与切换 ---- */
  const filterCounts = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const map = {};
    w.querySelectorAll('#mdFilters [data-filter]').forEach(function (b) {
      map[b.getAttribute('data-filter')] = b.querySelector('b').textContent;
    });
    return map;
  });
  check(filterCounts.all === '3' && filterCounts.pass === '3' &&
    filterCounts.unread === '0' && filterCounts.error === '0',
    '筛选计数按真实状态统计', JSON.stringify(filterCounts));
  await page.click('#maildeskWin [data-filter="unread"]');
  await page.waitForTimeout(150);
  const emptyUnread = await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-box').length);
  await page.click('#maildeskWin [data-filter="all"]');
  await page.waitForTimeout(150);
  check(emptyUnread === 0, '未读筛选在全部已读时不显示信箱');
  check(await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-box').length === 3),
    '切回「全部」后列表恢复');

  /* ---- 批量全选 / 复制 / 二次确认移除 ---- */
  await page.click('#maildeskWin #mdSelectAll');
  await page.waitForTimeout(180);
  const selAll = await page.evaluate(() => ({
    checked: document.querySelectorAll('#maildeskWin .md-box.is-checked').length,
    count: document.querySelector('#maildeskWin #mdSelCount').textContent
  }));
  check(selAll.checked === 3 && /已选 3/.test(selAll.count),
    '全选勾中当前筛选下的全部信箱', selAll.checked + ' / ' + selAll.count);

  await page.click('#maildeskWin #mdBatchCopy');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => /复制/.test(document.querySelector('#maildeskWin #mdStatus').textContent)),
    '批量复制给出状态反馈');

  /* 取消全选，只勾 alpha，验证二次确认 */
  await page.click('#maildeskWin #mdSelectAll');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const boxes = Array.prototype.slice.call(w.querySelectorAll('.md-box'));
    const target = boxes.filter(function (b) { return /alpha@example\.com/.test(b.textContent); })[0];
    if (target) target.querySelector('.md-box-check').click();
  });
  await page.waitForTimeout(150);
  await page.click('#maildeskWin #mdBatchRemove');
  await page.waitForTimeout(150);
  const firstConfirm = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return {
      n: w.querySelectorAll('.md-box').length,
      label: w.querySelector('#mdBatchRemove').textContent,
      selected: w.querySelector('#mdSelCount').textContent
    };
  });
  check(firstConfirm.n === 3 && /确认移除 1 个/.test(firstConfirm.label),
    '批量移除需要二次确认，第一次点击不删除', firstConfirm.label + ' / ' + firstConfirm.selected);
  await page.click('#maildeskWin #mdBatchRemove');
  await page.waitForTimeout(250);
  check(await page.evaluate(() => document.querySelectorAll('#maildeskWin .md-box').length === 2),
    '确认后只移除选中的信箱');

  /* ---- 手动信箱没有来信时，邮件搜索不可用；导出入口可见 ---- */
  check(await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return w.querySelector('#mdMsgSearch').disabled && !!w.querySelector('#mdExport');
  }), '没有来信时邮件搜索禁用，导出入口可用');

  /* ---- 手动 Outlook 邮箱：通过本地中转 IMAP 收信 ----
   * 用 window.fetch stub 拦 /mail/imap：不联网，只验 App 侧发出的请求与渲染。 */
  await page.click('#maildeskWin #mdAdd');
  await page.fill('#maildeskWin #mdAddAddr', 'probe@outlook.com');
  await page.fill('#maildeskWin #mdAddPass', 'OutlookPass1');
  await page.click('#maildeskWin #mdAddSave');
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    window.__imapCalls = [];
    window.__smtpCalls = [];
    const orig = window.fetch;
    window.fetch = function (url, init) {
      const u = String(url && url.url ? url.url : url);
      if (u.indexOf('/mail/imap') < 0 && u.indexOf('/mail/smtp') < 0) {
        return orig.apply(this, arguments);
      }
      let body = null;
      try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = null; }
      if (u.indexOf('/mail/smtp') >= 0) {
        window.__smtpCalls.push({ url: u, body: body });
        return Promise.resolve(new Response(JSON.stringify({ ok: true, accepted: [body && body.to] }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        }));
      }
      window.__imapCalls.push({ url: u, body: body });
      const payload = {
        ok: true, count: 1,
        messages: [{
          id: 'imap:9001', subject: '登录验证码 654321',
          from: { name: 'Outlook', address: 'no-reply@outlook.com' },
          createdAt: new Date().toISOString(), seen: false,
          text: 'Your verification code is 654321.', loaded: true
        }]
      };
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    };
  });

  const imapReady = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    const on = w.querySelector('.md-box.is-on');
    return {
      addr: w.querySelector('#mdAddr').textContent.trim(),
      disabled: w.querySelector('#mdSyncOne').disabled,
      title: w.querySelector('#mdSyncOne').title,
      empty: w.querySelector('#mdMsgs').textContent,
      meta: on ? on.querySelector('.md-box-meta').textContent : ''
    };
  });
  check(imapReady.addr === 'probe@outlook.com' && /手动登记/.test(imapReady.meta),
    'Outlook 手动邮箱被选中并标为手动登记', imapReady.addr);
  check(!imapReady.disabled && /outlook\.office365\.com/.test(imapReady.title) &&
    /IMAP/.test(imapReady.empty),
    '内置域名的口令邮箱可以用 IMAP 收信', imapReady.title);

  await page.click('#maildeskWin #mdSyncOne');
  await page.waitForFunction(() => document.querySelectorAll('#maildeskWin .md-msg').length >= 1,
    null, { timeout: 8000 });
  const imapCalls = await page.evaluate(() => window.__imapCalls);
  const imapReq = imapCalls[0] || {};
  const imapBody = imapReq.body || {};
  check(imapCalls.length === 1 && imapBody.address === 'probe@outlook.com' &&
    imapBody.password === 'OutlookPass1' && imapBody.host === 'outlook.office365.com' &&
    imapBody.port === 993 && imapBody.secure === true,
    '收信请求带给中转：地址、口令、IMAP 主机',
    imapBody.host + ':' + imapBody.port + ' / limit ' + imapBody.limit);

  await page.click('#maildeskWin .md-msg');
  await page.waitForTimeout(200);
  const imapRead = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return {
      subject: (w.querySelector('.md-read-subject') || {}).textContent || '',
      body: (w.querySelector('.md-body') || {}).textContent || '',
      code: (w.querySelector('.md-code') || {}).textContent || '',
      status: w.querySelector('#mdStatus').textContent,
      count: w.querySelector('#mdMsgCount').textContent
    };
  });
  check(/654321/.test(imapRead.subject) && /^\s*654321\s*$/.test(imapRead.code),
    'IMAP 来信能打开并识别验证码', imapRead.code.trim());
  check(/收取完成/.test(imapRead.status) && /1 封/.test(imapRead.count),
    '收信完成后状态栏与计数都更新', imapRead.status.trim());

  /* ---- 四段卡密导入：OAuth2 邮箱走 XOAUTH2 收信 ----
   * 卡密格式：地址----口令----client_id----refresh_token----...
   * 只验 App 侧：凭证是否被保存、收信时是否只发 OAuth2 字段。 */
  await page.click('#maildeskWin #mdImport');
  await page.fill('#maildeskWin #mdImportText',
    'oauth@outlook.com----OldPass1----client-abc----refresh-def----ignored-segment');
  await page.click('#maildeskWin #mdImportSave');
  await page.waitForTimeout(350);
  const importedBox = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return {
      addr: w.querySelector('#mdAddr').textContent.trim(),
      status: w.querySelector('#mdStatus').textContent,
      title: w.querySelector('#mdSyncOne').title
    };
  });
  check(importedBox.addr === 'oauth@outlook.com' && /新增 1/.test(importedBox.status),
    '四段卡密导入后自动选中新邮箱', importedBox.addr + ' / ' + importedBox.status.trim());

  await page.evaluate(() => { window.__imapCalls = []; });
  await page.click('#maildeskWin #mdSyncOne');
  await page.waitForFunction(() => window.__imapCalls.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const oauthBody = await page.evaluate(() => (window.__imapCalls[0] || {}).body || {});
  check(oauthBody.address === 'oauth@outlook.com' &&
    oauthBody.clientId === 'client-abc' && oauthBody.refreshToken === 'refresh-def' &&
    !('password' in oauthBody),
    'OAuth2 邮箱收信只向中转发送 client_id/refresh_token', importedBox.title);

  /* ---- 写邮件：OAuth2 邮箱经本地中转 SMTP 发信 ---- */
  const composeReady = await page.evaluate(() => {
    const w = document.querySelector('#maildeskWin');
    return { disabled: w.querySelector('#mdCompose').disabled, title: w.querySelector('#mdCompose').title };
  });
  check(!composeReady.disabled && /smtp\.office365\.com/.test(composeReady.title),
    'OAuth2 邮箱可以打开发信', composeReady.title);

  await page.click('#maildeskWin #mdCompose');
  await page.waitForTimeout(150);
  check(await visible(page, '#maildeskWin #mdComposeModal'), '写邮件弹层可以打开');
  const composeFrom = await page.textContent('#maildeskWin #mdComposeFrom');
  check(String(composeFrom).trim() === 'oauth@outlook.com', '写邮件默认使用当前信箱发件', composeFrom.trim());

  await page.fill('#maildeskWin #mdComposeTo', 'friend@example.com');
  await page.fill('#maildeskWin #mdComposeSubject', '探针测试邮件');
  await page.fill('#maildeskWin #mdComposeBody', '这是探针发出的测试正文。');
  await page.click('#maildeskWin #mdComposeSend');
  await page.waitForFunction(() => window.__smtpCalls.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(250);
  const sendState = await page.evaluate(() => ({
    calls: window.__smtpCalls,
    status: document.querySelector('#maildeskWin #mdStatus').textContent,
    closed: document.querySelector('#maildeskWin #mdComposeModal').hidden
  }));
  const smtpBody = (sendState.calls[0] || {}).body || {};
  check(smtpBody.address === 'oauth@outlook.com' && smtpBody.to === 'friend@example.com' &&
    smtpBody.clientId === 'client-abc' && smtpBody.refreshToken === 'refresh-def' &&
    !('password' in smtpBody) && smtpBody.host === 'smtp.office365.com' && smtpBody.port === 587,
    '发信请求带给中转 OAuth2 凭证与 SMTP 主机', smtpBody.host + ':' + smtpBody.port);
  check(/已通过 SMTP 发送/.test(sendState.status) && sendState.closed,
    '发信成功后弹层关闭并提示', sendState.status.trim());

  /* ---- 凭证工具：更新 OAuth2 令牌后立即生效 ---- */
  await page.click('#maildeskWin #mdCred');
  await page.waitForTimeout(150);
  check(await visible(page, '#maildeskWin #mdCredModal'), '凭证弹层可以打开');
  const credAddr = await page.textContent('#maildeskWin #mdCredAddr');
  check(String(credAddr).trim() === 'oauth@outlook.com', '凭证弹层显示当前邮箱', credAddr.trim());
  await page.fill('#maildeskWin #mdCredClient', 'client-xyz');
  await page.fill('#maildeskWin #mdCredToken', 'refresh-xyz');
  await page.click('#maildeskWin #mdCredSave');
  await page.waitForTimeout(300);
  const credState = await page.evaluate(() => ({
    status: document.querySelector('#maildeskWin #mdStatus').textContent,
    closed: document.querySelector('#maildeskWin #mdCredModal').hidden
  }));
  check(/凭证已更新/.test(credState.status) && credState.closed,
    '凭证更新成功并关闭弹层', credState.status.trim());

  await page.evaluate(() => { window.__imapCalls = []; });
  await page.click('#maildeskWin #mdSyncOne');
  await page.waitForFunction(() => window.__imapCalls.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const updatedBody = await page.evaluate(() => (window.__imapCalls[0] || {}).body || {});
  check(updatedBody.clientId === 'client-xyz' && updatedBody.refreshToken === 'refresh-xyz' &&
    !('password' in updatedBody),
    '更新后的 OAuth2 凭证立即用于收信', updatedBody.clientId);

  /* ---- AI 助手：生成发信计划，确认后经中转执行 ---- */
  const aiOpen = await page.evaluate(() => !document.querySelector('#maildeskWin #mdAi').hidden);
  if (!aiOpen) {
    await page.click('#maildeskWin #mdAiToggle');
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => {
    window.__aiReq2 = null;
    window.LLMRouter = {
      complete: function (req) {
        window.__aiReq2 = req;
        return Promise.resolve(JSON.stringify({
          reply: '已拟好一封测试邮件。',
          actions: [{
            type: 'send', address: 'oauth@outlook.com', to: 'ai-friend@example.com',
            subject: 'AI 测试', body: '来自邮箱台 AI 助手的测试正文。'
          }]
        }));
      }
    };
  });
  const runBtnsBefore = await page.evaluate(() => {
    return document.querySelectorAll('#maildeskWin [data-ai-run]').length;
  });
  await page.fill('#maildeskWin #mdAiText', '用 oauth@outlook.com 发一封测试邮件');
  await page.click('#maildeskWin #mdAiSend');
  await page.waitForFunction(function (n) {
    return document.querySelectorAll('#maildeskWin [data-ai-run]').length > n;
  }, runBtnsBefore, { timeout: 8000 });
  const aiPlanText = await page.evaluate(() => {
    const nodes = document.querySelectorAll('#maildeskWin .md-ai-msg.is-agent');
    return nodes.length ? nodes[nodes.length - 1].textContent : '';
  });
  check(/发到 ai-friend@example\.com/.test(aiPlanText), 'AI 能生成发信计划并展示');
  const aiCtx = await page.evaluate(() => JSON.stringify(window.__aiReq2 || {}));
  check(!/refresh-def|refresh-xyz/.test(aiCtx), '刷新令牌不会进入模型上下文');

  await page.evaluate(() => { window.__smtpCalls = []; });
  await page.evaluate(() => {
    const btns = document.querySelectorAll('#maildeskWin [data-ai-run]');
    if (btns.length) btns[btns.length - 1].click();
  });
  await page.waitForFunction(() => window.__smtpCalls.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(250);
  const aiSendState = await page.evaluate(() => {
    const s = document.querySelectorAll('#maildeskWin .md-ai-results');
    return {
      calls: window.__smtpCalls,
      results: s.length ? s[s.length - 1].textContent : ''
    };
  });
  check((aiSendState.calls[0] || {}).body && aiSendState.calls[0].body.to === 'ai-friend@example.com' &&
    /已用 oauth@outlook\.com 发送到 ai-friend@example\.com/.test(aiSendState.results),
    '确认后 AI 发信执行成功');

  /* ---- 无报错 ---- */
  check(errors.length === 0, '全程无 pageerror', errors.join(' | '));

  await run.shot(page, 'maildesk.png');
  const ok = run.finish(errors);
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项：' + failed.join(' ; ') : '✅ 全部通过'));
  await browser.close();
  process.exit(fails || !ok ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e);
  run.finish([e]);
  process.exit(1);
});
