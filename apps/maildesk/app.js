/* 邮箱台 —— 批量申请临时信箱，集中收取验证码与链接。
 *
 * 定位：注册、联调、演练时要「一次开好几个信箱，然后盯着它们收信」；
 * 浏览器里一个个开网页、记地址、翻验证码太碎，这里把三件事收进一个窗口：
 *   ① 批量申请（一次 1–20 个，服务商侧真实创建，不是本地占位）
 *   ② 集中收取（单箱刷新 / 全部刷新 / 定时自动收）
 *   ③ 读信（验证码与链接自动挑出来，点一下就复制）
 *
 * 服务商：mail.tm / mail.gw（同一套 REST 协议，互为备用）与「演示」（完全离线，
 * 用来试流程和跑无头探针 —— 默认测试不许碰真实网络）。
 *
 * 网络：页面跑在 file:// / app:// 下，直连第三方接口一定是 CORS 拒（origin: null），
 * 所以与 aisearch 一样借本地中转（relay）的 /proxy，用 X-Relay-Target 指定上游。
 * 中转没起来时只报「请求失败」，不会让人以为信箱服务坏了。
 *
 * ⚠ 三条硬约束（和别的 App 一样，见 apps/README.md）：
 *   ① 整个文件包在 IIFE 里；
 *   ② mount() 幂等：画过一次只刷新数据，不重建 DOM（否则用户正在读的信会被冲掉）；
 *   ③ 不碰 window.openagiDesktop，不读 llmKey。
 */
(function () {
  'use strict';

  const LS_KEY = 'hf_maildesk_v1';
  const DOMAIN_KEY = 'hf_maildesk_domains';
  const BODY = window.MAILDESK_BODY;
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.4"/>' +
    '<path d="m3.6 7.2 8.4 6 8.4-6"/><path d="M6.6 15.6h4.2"/></svg>';

  /* 演示服务不联网：信箱与来信都在本机生成，用来试流程与跑回归。 */
  const PROVIDERS = {
    mailtm: { label: 'mail.tm', base: 'https://api.mail.tm' },
    guerrilla: { label: 'Guerrilla', base: 'https://api.guerrillamail.com/ajax.php' },
    mailgw: { label: 'mail.gw', base: 'https://api.mail.gw' },
    demo: { label: '演示', base: '' },
    /* 手动登记：保存地址与口令，常见邮箱可通过本地中转走 IMAP 收信。 */
    manual: { label: '手动', base: '' }
  };

  /* 手动登记的邮箱按域名推断 IMAP 主机：地址与口令都在本机，收信时才发给本地中转。
   * 表里没有的域名只做地址/口令保管，不尝试收信。 */
  const IMAP_PRESETS = [
    { re: /@(outlook|hotmail|live|msn)\.com$/i, host: 'outlook.office365.com', port: 993 },
    { re: /@foxmail\.com$/i, host: 'imap.qq.com', port: 993 },
    { re: /@qq\.com$/i, host: 'imap.qq.com', port: 993 },
    { re: /@gmail\.com$/i, host: 'imap.gmail.com', port: 993 },
    { re: /@163\.com$/i, host: 'imap.163.com', port: 993 },
    { re: /@126\.com$/i, host: 'imap.126.com', port: 993 },
    { re: /@sina\.com$/i, host: 'imap.sina.com', port: 993 },
    { re: /@yahoo\.com$/i, host: 'imap.mail.yahoo.com', port: 993 },
    { re: /@(icloud|me)\.com$/i, host: 'imap.mail.me.com', port: 993 }
  ];

  function imapPreset(address) {
    const a = String(address || '');
    for (let i = 0; i < IMAP_PRESETS.length; i++) {
      if (IMAP_PRESETS[i].re.test(a)) return IMAP_PRESETS[i];
    }
    return null;
  }

  /* OAuth2 凭证：卡密里的 client_id + refresh_token。
   * 只存本机，不展示、不导出、不进模型上下文；刷新令牌由本地中转换取访问令牌。 */
  function hasOauth(b) {
    return !!(b && b.clientId && b.refreshToken);
  }

  /* 手动邮箱的 SMTP 发信主机：与 IMAP 表对应。
   * secure=true 用 465 直连 TLS，false 用 587 + STARTTLS。 */
  const SMTP_PRESETS = [
    { re: /@(outlook|hotmail|live|msn)\.com$/i, host: 'smtp.office365.com', port: 587, secure: false },
    { re: /@foxmail\.com$/i, host: 'smtp.qq.com', port: 465, secure: true },
    { re: /@qq\.com$/i, host: 'smtp.qq.com', port: 465, secure: true },
    { re: /@gmail\.com$/i, host: 'smtp.gmail.com', port: 465, secure: true },
    { re: /@163\.com$/i, host: 'smtp.163.com', port: 465, secure: true },
    { re: /@126\.com$/i, host: 'smtp.126.com', port: 465, secure: true },
    { re: /@sina\.com$/i, host: 'smtp.sina.com', port: 465, secure: true },
    { re: /@yahoo\.com$/i, host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    { re: /@(icloud|me)\.com$/i, host: 'smtp.mail.me.com', port: 587, secure: false }
  ];

  function smtpPreset(address) {
    const a = String(address || '');
    for (let i = 0; i < SMTP_PRESETS.length; i++) {
      if (SMTP_PRESETS[i].re.test(a)) return SMTP_PRESETS[i];
    }
    return null;
  }

  function canSend(b) {
    return !!b && b.provider === 'manual' && (!!b.password || hasOauth(b)) && !!smtpPreset(b.address);
  }

  function manualFetchable(b) {
    return !!b && b.provider === 'manual' && (!!b.password || hasOauth(b)) && !!imapPreset(b.address);
  }

  /* 地址前缀词表：只求「读得出来、看得出是测试号」，不做花哨命名。 */
  const WORDS = ['amber', 'brisk', 'coral', 'dusky', 'ember', 'frost', 'glide', 'hazel',
    'ivory', 'jade', 'lumen', 'maple', 'nimbus', 'onyx', 'pearl', 'quartz', 'raven',
    'sable', 'tide', 'umber', 'vivid', 'willow', 'xenon', 'yarrow', 'zephyr'];

  const DOMAIN_CACHE = { mailtm: { at: 0, list: [] }, mailgw: { at: 0, list: [] } };

  let S = loadState();
  let els = null;
  let busy = false;
  let timer = null;
  let saveTimer = null;
  /* 筛选 / 选中 / 邮件搜索都只活在本次打开期间，不写进 localStorage：
   * 这些是「看的时候的视角」，不是信箱数据。 */
  let FILTER = 'all';
  let MSGQ = '';
  let batchConfirm = false;
  let batchTimer = null;
  const SEL = new Set();

  /* ================= 基础工具 ================= */

  function now() { return Date.now(); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function msgOf(e) { return String((e && e.message) || e || '未知错误'); }

  function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function fmtAgo(ts) {
    if (!ts) return '从未';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    const diff = now() - d.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtFull(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function providerLabel(p) { return (PROVIDERS[p] && PROVIDERS[p].label) || p; }
  function baseOf(p) { return (PROVIDERS[p] && PROVIDERS[p].base) || ''; }

  /* ================= 状态 ================= */

  function blankState() {
    return {
      provider: 'mailtm', count: 3, prefix: '', auto: false, autoSec: 30,
      boxes: [], activeId: '', lastAutoAt: 0
    };
  }

  function normMessage(m) {
    const from = m && m.from && typeof m.from === 'object'
      ? { name: String(m.from.name || ''), address: String(m.from.address || '') }
      : null;
    return {
      id: String((m && m.id) || ''),
      subject: String((m && m.subject) || ''),
      intro: String((m && m.intro) || ''),
      from: from,
      seen: !!(m && m.seen),
      createdAt: String((m && m.createdAt) || ''),
      text: String((m && m.text) || '').slice(0, 4000),
      loaded: !!(m && m.loaded)
    };
  }

  function normBox(b) {
    return {
      id: String((b && b.id) || uid()),
      provider: PROVIDERS[b && b.provider] ? b.provider : 'mailtm',
      address: String((b && b.address) || ''),
      password: String((b && b.password) || ''),
      clientId: String((b && b.clientId) || ''),
      refreshToken: String((b && b.refreshToken) || ''),
      token: String((b && b.token) || ''),
      createdAt: Number(b && b.createdAt) || now(),
      lastSync: Number(b && b.lastSync) || 0,
      error: String((b && b.error) || ''),
      activeMsgId: String((b && b.activeMsgId) || ''),
      messages: Array.isArray(b && b.messages)
        ? b.messages.filter(function (m) { return m && m.id; }).slice(0, 20).map(normMessage)
        : []
    };
  }

  function loadState() {
    const st = blankState();
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return st;
    st.provider = PROVIDERS[raw.provider] ? raw.provider : 'mailtm';
    st.count = clamp(parseInt(raw.count, 10) || 3, 1, 20);
    st.prefix = String(raw.prefix || '').slice(0, 12);
    st.auto = !!raw.auto;
    st.autoSec = [15, 30, 60, 120].indexOf(Number(raw.autoSec)) >= 0 ? Number(raw.autoSec) : 30;
    st.boxes = Array.isArray(raw.boxes) ? raw.boxes.filter(function (b) { return b && b.address; }).map(normBox) : [];
    st.activeId = st.boxes.some(function (b) { return b.id === raw.activeId; }) ? raw.activeId : (st.boxes[0] ? st.boxes[0].id : '');
    return st;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          provider: S.provider, count: S.count, prefix: S.prefix,
          auto: S.auto, autoSec: S.autoSec, activeId: S.activeId,
          boxes: S.boxes.map(normBox)
        }));
      } catch (e) { /* 配额满就只留在内存里，不阻断收信 */ }
    }, 180);
  }

  function loadDomainCache() {
    try {
      const o = JSON.parse(localStorage.getItem(DOMAIN_KEY) || 'null');
      if (!o) return;
      Object.keys(DOMAIN_CACHE).forEach(function (k) {
        if (o[k] && Array.isArray(o[k].list) && o[k].list.length) DOMAIN_CACHE[k] = { at: Number(o[k].at) || 0, list: o[k].list };
      });
    } catch (e) { /* 缓存坏了就当没有 */ }
  }

  function saveDomainCache() {
    try { localStorage.setItem(DOMAIN_KEY, JSON.stringify(DOMAIN_CACHE)); } catch (e) { /* 忽略 */ }
  }

  /* ================= 网络 ================= */

  function relayBaseSafe() {
    try { if (typeof relayBase === 'function') return relayBase().replace(/\/+$/, ''); } catch (e) { /* 用默认 */ }
    return 'http://127.0.0.1:8787';
  }

  function relayEndpoint() { return relayBaseSafe() + '/proxy'; }
  function relayHealthUrl() { return relayBaseSafe() + '/health'; }
  function needRelay() {
    try { return /^(file|app|chrome-extension|moz-extension|edge):$/.test(location.protocol); }
    catch (e) { return false; }
  }

  function friendlyHttp(status, msg) {
    if (status === 429) return '服务限流，稍等 1 分钟再试';
    if (status === 401) return '登录态失效';
    if (status === 404) return '资源不存在（可能已被服务端清理）';
    if (status >= 500) return '服务端异常（HTTP ' + status + '）';
    return msg || ('HTTP ' + status);
  }

  function pickErr(data) {
    if (!data || typeof data !== 'object') return '';
    return String(data['hydra:description'] || data.detail || data.message || data.error || '');
  }

  /* 直连优先；file:// / app:// 下默认走本地中转。
   * Guerrilla 的接口带 Access-Control-Allow-Origin: *，传 preferDirect=true 时先直连，
   * 省掉对本地中转的依赖。真实 HTTP 错误（429/401/404）不再换通道重试。 */
  async function httpJson(url, opts, ms, preferDirect) {
    const init = Object.assign({ cache: 'no-store', redirect: 'follow' }, opts || {});
    const headers = Object.assign({ Accept: 'application/json' }, init.headers || {});
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 20000);
    const relay = relayEndpoint();
    const targets = (needRelay() && !preferDirect) ? [relay] : [url, relay];
    try {
      for (let i = 0; i < targets.length; i++) {
        const viaRelay = targets[i] === relay;
        const h = viaRelay ? Object.assign({}, headers, { 'X-Relay-Target': url }) : headers;
        let res;
        try {
          res = await fetch(targets[i], Object.assign({}, init, { headers: h, signal: ctl.signal }));
        } catch (e) {
          if (i + 1 < targets.length) continue;
          if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round((ms || 20000) / 1000) + ' 秒）');
          throw new Error('请求失败：接口不可达或本地中转未启动');
        }
        const raw = await res.text().catch(function () { return ''; });
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
          const err = new Error(friendlyHttp(res.status, pickErr(data)));
          err.http = res.status;
          throw err;
        }
        return data;
      }
      throw new Error('请求失败');
    } finally {
      clearTimeout(timerId);
    }
  }

  function hydraList(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d['hydra:member'] || d.member || d.items || [];
  }

  /* 手动邮箱收信：地址与口令（或 OAuth2 凭证）只发给本机中转的 /mail/imap，
   * 由它代连 IMAP。中转必须在本机运行；这里不把凭证写进任何日志或提示。
   * 超时给 70 秒：OAuth2 换令牌 + IMAP 收信各有一段独立预算。 */
  async function relayMailFetch(payload, ms) {
    const url = relayBaseSafe() + '/mail/imap';
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 70000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      const raw = await res.text().catch(function () { return ''; });
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || ('本地中转 HTTP ' + res.status));
      }
      if (!data || data.ok !== true) {
        throw new Error((data && data.error) || '本地中转没有返回邮件');
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('收信超时（' + Math.round((ms || 70000) / 1000) + ' 秒）');
      }
      if (e && e.name === 'TypeError') {
        throw new Error('本地中转未启动或不可达：手动邮箱收信需要本地中转');
      }
      throw e;
    } finally {
      clearTimeout(timerId);
    }
  }

  /* 发信：凭证与正文只发给本机中转的 /mail/smtp，由它代连 SMTP。 */
  async function relayMailSend(payload, ms) {
    const url = relayBaseSafe() + '/mail/smtp';
    const ctl = new AbortController();
    const timerId = setTimeout(function () { ctl.abort(); }, ms || 70000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      const raw = await res.text().catch(function () { return ''; });
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && (data.error || data.message)) || ('本地中转 HTTP ' + res.status));
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('发信超时（' + Math.round((ms || 70000) / 1000) + ' 秒）');
      }
      if (e && e.name === 'TypeError') {
        throw new Error('本地中转未启动或不可达：手动邮箱发信需要本地中转');
      }
      throw e;
    } finally {
      clearTimeout(timerId);
    }
  }

  async function loadDomains(provider, force) {
    const c = DOMAIN_CACHE[provider];
    if (!force && c.list.length && now() - c.at < 10 * 60 * 1000) return c.list;
    const d = await httpJson(baseOf(provider) + '/domains', {}, 15000);
    const list = hydraList(d)
      .filter(function (x) { return x && x.domain && x.isActive !== false; })
      .map(function (x) { return x.domain; });
    if (!list.length) throw new Error('服务端没有返回可用域名，稍后再试');
    c.list = list;
    c.at = now();
    saveDomainCache();
    return list;
  }

  async function mtLogin(provider, address, password) {
    const tok = await httpJson(baseOf(provider) + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, password: password })
    }, 20000);
    if (!tok || !tok.token) throw new Error('登录令牌获取失败');
    return tok.token;
  }

  async function mtCreateAccount(provider, address, password) {
    await httpJson(baseOf(provider) + '/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, password: password })
    }, 20000);
    return mtLogin(provider, address, password);
  }

  /* 令牌过期（401）时用本地保存的口令重登一次；口令是申请时自己生成的，只存本机。 */
  async function withRelogin(box, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.http !== 401 || !box.password) throw e;
      box.token = await mtLogin(box.provider, box.address, box.password);
      return fn();
    }
  }

  function listMessages(box) {
    return withRelogin(box, function () {
      return httpJson(baseOf(box.provider) + '/messages?page=1', {
        headers: { Authorization: 'Bearer ' + box.token }
      }, 20000);
    }).then(hydraList);
  }

  function readMessage(box, id) {
    return withRelogin(box, function () {
      return httpJson(baseOf(box.provider) + '/messages/' + encodeURIComponent(id), {
        headers: { Authorization: 'Bearer ' + box.token }
      }, 20000);
    });
  }

  function markSeen(box, id) {
    if (box.provider === 'demo' || box.provider === 'guerrilla') return;
    httpJson(baseOf(box.provider) + '/messages/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + box.token,
        'Content-Type': 'application/merge-patch+json'
      },
      body: JSON.stringify({ seen: true })
    }, 12000).catch(function () { /* 标记已读失败不影响本地显示 */ });
  }

  /* ---- Guerrilla Mail ----
   * 无需账号：一次 get_email_address 就是一个独立会话（sid_token 代替口令），
   * set_email_user 可以把本地部分改成自己的前缀；读信用 fetch_email。
   * 注意：每个新会话自带一封官方欢迎信，列表里过滤掉，不占用未读数。 */
  function gUrl(qs) {
    return baseOf('guerrilla') + '?' + qs + '&lang=en&site=guerrillamail.com&agent=maildesk';
  }

  async function guerrillaCreate(prefix) {
    const a = await httpJson(gUrl('f=get_email_address'), {}, 20000, true);
    if (!a || !a.email_addr || !a.sid_token) throw new Error('没能拿到临时地址（服务可能限流）');
    const sid = String(a.sid_token);
    let address = String(a.email_addr);
    if (prefix) {
      const local = prefix + String(Math.floor(1000 + Math.random() * 9000));
      try {
        const s = await httpJson(gUrl('f=set_email_user&email_user=' + encodeURIComponent(local) +
          '&sid_token=' + encodeURIComponent(sid)), {}, 20000, true);
        if (s && s.email_addr && !s.alias_error) address = String(s.email_addr);
      } catch (e) { /* 前缀没改成就用随机地址，不影响收信 */ }
    }
    return { address: address, sid: sid };
  }

  async function guerrillaList(box) {
    const d = await httpJson(gUrl('f=get_email_list&offset=0&sid_token=' + encodeURIComponent(box.token)), {}, 20000, true);
    if (!d) return [];
    if (Array.isArray(d.list)) return d.list;
    if (d.error) throw new Error(String(d.error));
    return [];
  }

  async function guerrillaRead(box, id) {
    const d = await httpJson(gUrl('f=fetch_email&email_id=' + encodeURIComponent(id) +
      '&sid_token=' + encodeURIComponent(box.token)), {}, 25000, true);
    if (!d || d.mail_body == null) throw new Error('没取到正文（会话可能已过期）');
    return {
      subject: String(d.mail_subject || ''),
      from: parseFrom(d.mail_from),
      text: htmlToText(d.mail_body)
    };
  }

  /* ================= 解析邮件内容 ================= */

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, function (_, d) { try { return String.fromCharCode(Number(d)); } catch (e) { return ''; } })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ''; } })
      .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  }

  function htmlToText(html) {
    return decodeEntities(String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textOf(detail) {
    if (detail && detail.text && String(detail.text).trim()) return String(detail.text);
    const html = Array.isArray(detail && detail.html) ? detail.html.join('\n') : ((detail && detail.html) || '');
    return htmlToText(html);
  }

  /* 验证码：先找「验证码 / code / OTP」附近的 4–8 位数字，再兜底裸 6 位数字。
   * 只认数字 —— 带字母的码各站格式千奇百怪，硬猜会把订单号当验证码。 */
  function extractCodes(raw) {
    const s = String(raw || '');
    const out = [];
    const push = function (v) {
      const c = String(v || '').trim();
      if (c && out.indexOf(c) < 0) out.push(c);
    };
    const near = /(?:验证码|校验码|动态码|确认码|verification\s*code|verify\s*code|one[-\s]?time\s*code|\bcode\b|\bOTP\b|\bPIN\b)[^0-9]{0,20}([0-9]{4,8})/gi;
    let m;
    while ((m = near.exec(s)) && out.length < 4) push(m[1]);
    const bare = /(^|[^0-9])([0-9]{6})(?![0-9])/g;
    while ((m = bare.exec(s)) && out.length < 4) push(m[2]);
    return out.slice(0, 4);
  }

  function extractLinks(raw) {
    const out = [];
    const re = /https?:\/\/[^\s<>"'）)，。、]+/g;
    let m;
    while ((m = re.exec(String(raw || ''))) && out.length < 6) {
      const u = m[0].replace(/[.,;:!?\]}]+$/, '');
      if (out.indexOf(u) < 0) out.push(u);
    }
    return out;
  }

  function fromText(from) {
    if (!from) return '未知发件人';
    if (from.name && from.address) return from.name + ' <' + from.address + '>';
    return from.name || from.address || '未知发件人';
  }

  /* Guerrilla 的 mail_from 常是 "Name <addr>" 一整串，统一拆成结构。 */
  function parseFrom(s) {
    const str = String(s || '').trim();
    const m = str.match(/^(.*?)<([^>]+)>$/);
    if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() };
    return { name: '', address: str };
  }

  function isGuerrillaWelcome(x) {
    return /guerrillamail/i.test(String(x.mail_from || '')) &&
      /^welcome to guerrilla mail/i.test(String(x.mail_subject || ''));
  }

  /* ================= 演示服务 ================= */

  function randLocal() {
    return WORDS[Math.floor(Math.random() * WORDS.length)] + String(Math.floor(1000 + Math.random() * 9000));
  }

  function randPassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 14; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function demoSeed(address) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    return [{
      id: ('demo-' + uid()),
      from: { name: '邮箱台演示', address: 'noreply@demo.maildesk' },
      subject: '欢迎使用邮箱台 · 验证码 ' + code,
      intro: '这是一封演示来信，用来验证收信列表、验证码识别与复制流程。',
      seen: false,
      createdAt: new Date().toISOString(),
      text: '你好：\n\n这是演示信箱 ' + address + ' 收到的示例邮件，不会真的走网络。\n\n' +
        '你的验证码是 ' + code + '，5 分钟内有效。\n\n' +
        '如需走完整个流程，可以打开 https://example.com/verify?code=' + code + ' 查看效果。\n\n' +
        '— 邮箱台演示服务',
      loaded: true
    }];
  }

  function addDemoBox() {
    let address = '';
    for (let i = 0; i < 5; i++) {
      const a = randLocal() + '@demo.maildesk';
      if (!S.boxes.some(function (b) { return b.address === a; })) { address = a; break; }
    }
    if (!address) address = 'demo' + uid() + '@demo.maildesk';
    const box = {
      id: uid(), provider: 'demo', address: address, password: '', token: '',
      createdAt: now(), lastSync: now(), error: '', activeMsgId: '', messages: demoSeed(address)
    };
    box.activeMsgId = box.messages[0] ? box.messages[0].id : '';
    S.boxes.unshift(box);
    S.activeId = box.id;
    return box;
  }

  /* ================= 业务：申请 / 收取 / 读信 ================= */

  function activeBox() {
    for (let i = 0; i < S.boxes.length; i++) if (S.boxes[i].id === S.activeId) return S.boxes[i];
    return null;
  }

  function unreadOf(b) {
    return b.messages.filter(function (m) { return !m.seen; }).length;
  }

  function selectedBoxes() {
    return S.boxes.filter(function (b) { return SEL.has(b.id); });
  }

  function activeMsg() {
    const b = activeBox();
    if (!b || !b.activeMsgId) return null;
    for (let i = 0; i < b.messages.length; i++) {
      if (b.messages[i].id === b.activeMsgId) return b.messages[i];
    }
    return null;
  }

  /* 选中集合只保留仍存在的信箱，避免筛选 / 移除后留下幽灵 id。 */
  function pruneSelection() {
    const live = new Set(S.boxes.map(function (b) { return b.id; }));
    Array.from(SEL).forEach(function (id) { if (!live.has(id)) SEL.delete(id); });
  }

  function toggleSel(id, on) {
    if (on) SEL.add(id); else SEL.delete(id);
    resetBatchConfirm();
    renderBoxes();
  }

  function boxVisible(b) {
    if (FILTER === 'unread' && !unreadOf(b)) return false;
    if (FILTER === 'pass' && !b.password && !hasOauth(b)) return false;
    if (FILTER === 'error' && !b.error) return false;
    const q = String(els && els.search ? els.search.value : '').trim().toLowerCase();
    return !q || b.address.toLowerCase().indexOf(q) >= 0;
  }

  function exportText(list) {
    return list.map(function (b) {
      return b.address + (b.password ? '----' + b.password : '');
    }).join('\n');
  }

  /* 导入识别两种写法：
   *   ① 卡密四段：address----password----client_id----refresh_token（第 5 段起忽略）
   *   ② 老格式：地址 + 空格/制表符 + 口令
   * 令牌类字段只存本机：不展示、不写日志、不进模型上下文，也不随导出外泄。 */
  function clipLen(s, n) {
    const t = String(s == null ? '' : s).trim();
    return t.length > n ? t.slice(0, n) : t;
  }

  function parseImport(text) {
    const out = [];
    const bad = [];
    const seen = {};
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
      const line = raw.trim();
      if (!line || /^(#|\/\/)/.test(line)) return;
      const m = line.match(/[a-z0-9._%+-]+@[a-z0-9]+(?:[.-][a-z0-9]+)+/i);
      if (!m) { bad.push(line); return; }
      const address = m[0].toLowerCase();
      const rest = line.slice(line.indexOf(m[0]) + m[0].length).replace(/^[>\s]+/, '');
      const segs = rest.split(/\s*(?:----|\t|,|;|\|)\s*/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s; });
      if (seen[address]) return;
      seen[address] = true;
      out.push({
        address: address,
        password: clipLen(segs[0], 80),
        clientId: clipLen(segs[1], 120),
        refreshToken: clipLen(segs[2], 4096)
      });
    });
    return { list: out, bad: bad };
  }

  function importBoxes(text) {
    const r = parseImport(text);
    let added = 0;
    let updated = 0;
    let dup = 0;
    r.list.forEach(function (x) {
      const exist = S.boxes.filter(function (b) {
        return b.provider === 'manual' && b.address.toLowerCase() === x.address;
      })[0];
      if (exist) {
        let changed = false;
        if (x.password && x.password !== exist.password) { exist.password = x.password; changed = true; }
        if (x.clientId && x.clientId !== exist.clientId) { exist.clientId = x.clientId; changed = true; }
        if (x.refreshToken && x.refreshToken !== exist.refreshToken) { exist.refreshToken = x.refreshToken; changed = true; }
        if (changed) {
          exist.error = '';
          save();
          updated++;
        } else {
          dup++;
        }
        return;
      }
      const res = addManualBox(x.address, x.password, x.clientId, x.refreshToken);
      if (res.error) dup++;
      else added++;
    });
    return { added: added, updated: updated, dup: dup, bad: r.bad.length };
  }

  function downloadText(name, text) {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }, 1200);
      return true;
    } catch (e) {
      return false;
    }
  }

  function resetBatchConfirm() {
    batchConfirm = false;
    clearTimeout(batchTimer);
    if (els && els.batchRemove) {
      els.batchRemove.textContent = '移除';
      els.batchRemove.classList.remove('is-confirm');
    }
  }

  function mergeMessages(box, incoming) {
    const old = {};
    box.messages.forEach(function (m) { old[m.id] = m; });
    const out = incoming.map(function (x) {
      const prev = old[x.id] || {};
      return normMessage({
        id: x.id,
        from: x.from || prev.from || null,
        subject: x.subject || prev.subject || '',
        intro: x.intro || prev.intro || '',
        seen: prev.seen === true || x.seen === true,
        createdAt: x.createdAt || prev.createdAt || '',
        text: x.text || prev.text || '',
        loaded: x.loaded === true || prev.loaded === true
      });
    });
    out.sort(function (a, b) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    box.messages = out.slice(0, 20);
    if (box.activeMsgId && !box.messages.some(function (m) { return m.id === box.activeMsgId; })) {
      box.activeMsgId = '';
    }
  }

  /* mail.tm / mail.gw 的 hydra 摘要 → 统一消息结构 */
  function mergeSummaries(box, list) {
    mergeMessages(box, list.map(function (x) {
      return {
        id: x.id,
        from: x.from,
        subject: x.subject,
        intro: x.intro,
        seen: x.seen === true,
        createdAt: x.createdAt
      };
    }));
  }

  /* Guerrilla 的邮件摘要 → 统一消息结构（mail_timestamp 是秒） */
  function mergeGuerrilla(box, list) {
    mergeMessages(box, list.filter(function (x) { return !isGuerrillaWelcome(x); }).map(function (x) {
      return {
        id: String(x.mail_id),
        from: parseFrom(x.mail_from),
        subject: String(x.mail_subject || ''),
        intro: String(x.mail_excerpt || ''),
        seen: Number(x.mail_read) === 1,
        createdAt: x.mail_timestamp ? new Date(Number(x.mail_timestamp) * 1000).toISOString() : ''
      };
    }));
  }

  /* 手动邮箱走 IMAP：只读最近 8 封，不删除、不改服务端已读状态。
   * 有 client_id + refresh_token 就走 OAuth2（XOAUTH2），否则用口令登录。 */
  async function syncManual(box) {
    const preset = imapPreset(box.address);
    if (!preset) throw new Error('这个域名还没有内置 IMAP 收信配置');
    const oauth = hasOauth(box);
    if (!box.password && !oauth) throw new Error('没有口令或 OAuth2 令牌，无法登录收信');
    setStatus('正在通过 IMAP' + (oauth ? '（OAuth2）' : '') + '收取 ' + box.address + '…');
    const payload = {
      address: box.address,
      host: preset.host,
      port: preset.port,
      secure: true,
      limit: 8
    };
    if (oauth) {
      payload.clientId = box.clientId;
      payload.refreshToken = box.refreshToken;
    } else {
      payload.password = box.password;
    }
    const data = await relayMailFetch(payload);
    mergeMessages(box, Array.isArray(data.messages) ? data.messages : []);
    box.lastSync = now();
    box.error = '';
    save();
  }

  /* 发信：凭证与正文只发给本机中转，不保存副本、不写已发送列表。 */
  async function sendMail(box, to, subject, body) {
    if (!canSend(box)) {
      throw new Error('这个信箱没有可用的发信凭证（需要口令或 OAuth2 令牌，且域名在发信列表里）');
    }
    const preset = smtpPreset(box.address);
    const target = String(to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) throw new Error('收件人地址不正确');
    const text = String(body || '');
    if (!text.trim()) throw new Error('正文不能为空');
    const payload = {
      address: box.address,
      to: target,
      subject: String(subject || '').trim().slice(0, 200),
      body: text.slice(0, 20 * 1024),
      host: preset.host,
      port: preset.port,
      secure: preset.secure
    };
    const oauth = hasOauth(box);
    if (oauth) {
      payload.clientId = box.clientId;
      payload.refreshToken = box.refreshToken;
    } else {
      payload.password = box.password;
    }
    setStatus('正在通过 SMTP' + (oauth ? '（OAuth2）' : '') + ' 发送到 ' + target + '…');
    await relayMailSend(payload);
    box.error = '';
    save();
  }

  /* 凭证工具：按字段更新当前手动邮箱，留空表示保留旧值；旧值不回显。 */
  function applyCredential(box, password, clientId, refreshToken) {
    if (!box || box.provider !== 'manual') return { error: '只有手动邮箱可以更新凭证' };
    const pass = clipLen(password, 80);
    const cid = clipLen(clientId, 120);
    const rt = clipLen(refreshToken, 4096);
    if (!pass && !cid && !rt) return { error: '三项都为空，没有可保存的内容' };
    if ((cid && !rt) || (!cid && rt)) return { error: 'OAuth2 需要同时填写 client_id 与 refresh_token' };
    if (pass) box.password = pass;
    if (cid && rt) {
      box.clientId = cid;
      box.refreshToken = rt;
    }
    box.error = '';
    save();
    return { ok: true };
  }

  function clearCredential(box) {
    if (!box) return { error: '没有选中的信箱' };
    box.password = '';
    box.clientId = '';
    box.refreshToken = '';
    box.error = '';
    save();
    return { ok: true };
  }

  async function syncBox(box) {
    if (box.provider === 'demo') {
      box.lastSync = now();
      box.error = '';
      return;
    }
    if (box.provider === 'manual') {
      await syncManual(box);
      return;
    }
    if (box.provider === 'guerrilla') {
      mergeGuerrilla(box, await guerrillaList(box));
    } else {
      mergeSummaries(box, await listMessages(box));
    }
    box.lastSync = now();
    box.error = '';
    save();
  }

  async function syncAll(silent) {
    if (busy) return;
    const list = S.boxes.filter(function (b) {
      return b.provider === 'mailtm' || b.provider === 'mailgw' ||
        b.provider === 'guerrilla' || manualFetchable(b);
    });
    if (!list.length) {
      if (!silent) setStatus(S.boxes.length ? '当前没有可收信的信箱（手动邮箱需要口令或 OAuth2 令牌，且域名在收信列表里）' : '还没有信箱，先批量申请');
      return;
    }
    busy = true;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let lastErr = '';
    for (let i = 0; i < list.length; i++) {
      setStatus('正在收取 ' + (i + 1) + ' / ' + list.length + '：' + list[i].address);
      try {
        await syncBox(list[i]);
        ok++;
      } catch (e) {
        fail++;
        lastErr = msgOf(e);
        list[i].error = lastErr;
      }
      renderBoxes();
      renderMsgs();
    }
    busy = false;
    setBusy(false);
    save();
    setStatus('收取完成：' + ok + ' 个成功' + (fail ? '，' + fail + ' 个失败（' + lastErr + '）' : ''),
      fail ? 'err' : 'ok');
  }

  async function createBatch() {
    if (busy) return;
    const provider = S.provider;
    const n = clamp(parseInt(els.count.value, 10) || 1, 1, 20);
    const prefix = String(els.prefix.value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    S.count = n;
    S.prefix = prefix;
    save();

    busy = true;
    setBusy(true);
    try {
      if (provider === 'demo') {
        for (let i = 0; i < n; i++) addDemoBox();
        renderAll();
        save();
        setStatus('已创建 ' + n + ' 个演示信箱（离线模拟，不会真的收信）', 'ok');
        return;
      }

      /* Guerrilla 不需要账号体系：一个会话就是一份信箱，创建更轻。 */
      if (provider === 'guerrilla') {
        const madeG = [];
        let failG = 0;
        let lastErrG = '';
        for (let i = 0; i < n; i++) {
          setStatus('正在申请 ' + (i + 1) + ' / ' + n + ' 个 Guerrilla 信箱…');
          try {
            const r = await guerrillaCreate(prefix);
            const box = {
              id: uid(), provider: 'guerrilla', address: r.address, password: '', token: r.sid,
              createdAt: now(), lastSync: 0, error: '', activeMsgId: '', messages: []
            };
            S.boxes.unshift(box);
            S.activeId = box.id;
            madeG.push(box);
            save();
            renderAll();
          } catch (e) {
            failG++;
            lastErrG = msgOf(e);
          }
          if (i < n - 1) await sleep(900);
        }
        for (let i = 0; i < madeG.length; i++) {
          try { await syncBox(madeG[i]); } catch (e) { madeG[i].error = msgOf(e); }
        }
        renderAll();
        save();
        setStatus('申请完成：' + madeG.length + ' 个成功' + (failG ? '，' + failG + ' 个失败（' + lastErrG + '）' : ''),
          failG ? 'err' : 'ok');
        return;
      }

      setStatus('正在获取可用域名…');
      const domains = await loadDomains(provider);
      const made = [];
      let fail = 0;
      let lastErr = '';

      for (let i = 0; i < n; i++) {
        setStatus('正在申请 ' + (i + 1) + ' / ' + n + ' 个信箱…');
        const domain = domains[i % domains.length];
        let address = '';
        for (let t = 0; t < 4; t++) {
          const local = prefix
            ? prefix + String(Math.floor(100 + Math.random() * 900))
            : randLocal();
          const a = local + '@' + domain;
          if (!S.boxes.some(function (b) { return b.address === a; })) { address = a; break; }
        }
        if (!address) { fail++; lastErr = '生成的地址重复'; continue; }

        const password = randPassword();
        try {
          const token = await mtCreateAccount(provider, address, password);
          const box = {
            id: uid(), provider: provider, address: address, password: password, token: token,
            createdAt: now(), lastSync: 0, error: '', activeMsgId: '', messages: []
          };
          S.boxes.unshift(box);
          S.activeId = box.id;
          made.push(box);
          save();
          renderAll();
        } catch (e) {
          fail++;
          lastErr = msgOf(e);
        }
        if (i < n - 1) await sleep(1100);
      }

      /* 刚建好的信箱顺手收一次（多半为空，但能立刻验证口令有效）。 */
      for (let i = 0; i < made.length; i++) {
        setStatus('正在收取新信箱 ' + (i + 1) + ' / ' + made.length + '…');
        try { await syncBox(made[i]); } catch (e) { made[i].error = msgOf(e); }
      }
      renderAll();
      save();
      setStatus('申请完成：' + made.length + ' 个成功' + (fail ? '，' + fail + ' 个失败（' + lastErr + '）' : ''),
        fail ? 'err' : 'ok');
    } catch (e) {
      setStatus('申请失败：' + msgOf(e), 'err');
    } finally {
      busy = false;
      setBusy(false);
      renderAll();
    }
  }

  /* 手动登记：保存地址、口令，以及可选的 OAuth2（client_id + refresh_token）。
   * 常见邮箱可走 IMAP 收信；两项凭证都只存本机。 */
  function addManualBox(address, password, clientId, refreshToken) {
    const addr = String(address == null ? '' : address).trim().toLowerCase();
    const pass = clipLen(password, 80);
    const cid = clipLen(clientId, 120);
    const rt = clipLen(refreshToken, 4096);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return { error: '地址格式不对，例：name@example.com' };
    }
    if (S.boxes.some(function (b) { return b.address.toLowerCase() === addr; })) {
      return { error: '这个地址已经在列表里：' + addr };
    }
    const box = {
      id: uid(), provider: 'manual', address: addr, password: pass,
      clientId: cid, refreshToken: rt, token: '',
      createdAt: now(), lastSync: 0, error: '', activeMsgId: '', messages: []
    };
    S.boxes.unshift(box);
    S.activeId = box.id;
    save();
    return { box: box };
  }

  function findBox(address) {
    const addr = String(address == null ? '' : address).trim().toLowerCase();
    if (!addr) return null;
    for (let i = 0; i < S.boxes.length; i++) {
      if (S.boxes[i].address.toLowerCase() === addr) return S.boxes[i];
    }
    return null;
  }

  function removeBox(b) {
    if (!b) return;
    S.boxes = S.boxes.filter(function (x) { return x.id !== b.id; });
    S.activeId = S.boxes[0] ? S.boxes[0].id : '';
    save();
    renderAll();
    setStatus('已从列表移除：' + b.address +
      (b.provider === 'manual' ? '（本机记录已删除）' : '（服务端账号会自行过期）'));
  }

  function selectBox(id) {
    S.activeId = id;
    MSGQ = '';
    if (els && els.msgSearch) els.msgSearch.value = '';
    save();
    renderBoxes();
    renderMsgs();
    renderRead();
  }

  function toggleSeen() {
    const b = activeBox();
    const m = activeMsg();
    if (!b || !m) return;
    m.seen = !m.seen;
    if (m.seen) markSeen(b, m.id);
    save();
    renderMsgs();
    renderRead();
    renderStats();
    renderFilters();
    setStatus(m.seen ? '已标记为已读' : '已标记为未读', 'ok');
  }

  async function batchRefresh() {
    if (busy) return;
    const list = selectedBoxes().filter(function (b) {
      return b.provider === 'mailtm' || b.provider === 'mailgw' ||
        b.provider === 'guerrilla' || manualFetchable(b);
    });
    if (!list.length) {
      setStatus('选中的信箱不支持收信（演示 / 未配置口令或 OAuth2 令牌的手动邮箱）', 'err');
      return;
    }
    busy = true;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length; i++) {
      setStatus('正在收取 ' + (i + 1) + ' / ' + list.length + '：' + list[i].address);
      try {
        await syncBox(list[i]);
        ok++;
      } catch (e) {
        fail++;
        list[i].error = msgOf(e);
      }
      renderBoxes();
      renderMsgs();
      renderRead();
    }
    busy = false;
    setBusy(false);
    save();
    setStatus('批量收取完成：' + ok + ' 个成功' + (fail ? '，' + fail + ' 个失败' : ''), fail ? 'err' : 'ok');
  }

  function batchCopy() {
    const list = selectedBoxes();
    if (!list.length) return;
    copyThenStatus(exportText(list), list.length + ' 个信箱（地址+口令）');
  }

  function batchRemove() {
    if (busy) return;
    const list = selectedBoxes();
    if (!list.length) return;
    if (!batchConfirm) {
      batchConfirm = true;
      els.batchRemove.textContent = '确认移除 ' + list.length + ' 个';
      els.batchRemove.classList.add('is-confirm');
      setStatus('再次点击「确认移除」才会删除这些本机记录');
      clearTimeout(batchTimer);
      batchTimer = setTimeout(resetBatchConfirm, 4000);
      return;
    }
    resetBatchConfirm();
    const ids = list.map(function (b) { return b.id; });
    S.boxes = S.boxes.filter(function (b) { return ids.indexOf(b.id) < 0; });
    ids.forEach(function (id) { SEL.delete(id); });
    if (S.boxes.every(function (b) { return b.id !== S.activeId; })) {
      S.activeId = S.boxes[0] ? S.boxes[0].id : '';
    }
    save();
    renderAll();
    setStatus('已移除 ' + ids.length + ' 个信箱（仅删本机记录）', 'ok');
  }

  function openImport() {
    if (!els) return;
    els.importModal.hidden = false;
    els.importText.value = '';
    setTimeout(function () { try { els.importText.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function closeImport() {
    if (!els) return;
    els.importModal.hidden = true;
    els.importText.value = '';
  }

  function runImport() {
    const r = importBoxes(els.importText.value);
    if (!r.added && !r.updated && !r.dup && !r.bad) {
      setStatus('没有可导入的内容：每行一个「地址----口令----client_id----refresh_token」', 'err');
      return;
    }
    closeImport();
    renderAll();
    setStatus('导入完成：新增 ' + r.added + ' 个' +
      (r.updated ? '，更新凭证 ' + r.updated + ' 个' : '') +
      (r.dup ? '，跳过重复 ' + r.dup + ' 个' : '') +
      (r.bad ? '，' + r.bad + ' 行无法识别' : ''), (r.added || r.updated) ? 'ok' : 'err');
  }

  /* ---- 写邮件 ---- */

  function openCompose() {
    if (!els) return;
    const b = activeBox();
    if (!b) { setStatus('先选一个手动邮箱', 'err'); return; }
    if (!canSend(b)) {
      setStatus('这个信箱不能发信：需要手动邮箱 + 口令或 OAuth2 凭证', 'err');
      return;
    }
    els.composeFrom.textContent = b.address;
    els.composeModal.hidden = false;
    setTimeout(function () { try { els.composeTo.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function closeCompose() {
    if (!els) return;
    els.composeModal.hidden = true;
    els.composeTo.value = '';
    els.composeSubject.value = '';
    els.composeBody.value = '';
  }

  async function runCompose() {
    const b = activeBox();
    if (!b) { setStatus('先选一个手动邮箱', 'err'); return; }
    const to = String(els.composeTo.value || '').trim();
    const subject = String(els.composeSubject.value || '').trim();
    const body = String(els.composeBody.value || '');
    if (!to) { setStatus('请填写收件人', 'err'); els.composeTo.focus(); return; }
    if (!body.trim()) { setStatus('请填写正文', 'err'); els.composeBody.focus(); return; }
    if (busy) return;
    setBusy(true);
    els.composeSend.disabled = true;
    try {
      await sendMail(b, to, subject, body);
      closeCompose();
      setStatus('已通过 SMTP 发送到 ' + to, 'ok');
    } catch (e) {
      setStatus('发信失败：' + msgOf(e), 'err');
    } finally {
      els.composeSend.disabled = false;
      setBusy(false);
    }
  }

  /* ---- 凭证工具 ---- */

  function openCred() {
    if (!els) return;
    const b = activeBox();
    if (!b || b.provider !== 'manual') {
      setStatus('只有手动登记的邮箱可以管理凭证', 'err');
      return;
    }
    els.credAddr.textContent = b.address;
    els.credPass.value = '';
    els.credClient.value = '';
    els.credToken.value = '';
    els.credModal.hidden = false;
    setTimeout(function () { try { els.credPass.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function closeCred() {
    if (!els) return;
    els.credModal.hidden = true;
    els.credPass.value = '';
    els.credClient.value = '';
    els.credToken.value = '';
  }

  function saveCred() {
    const b = activeBox();
    const r = applyCredential(b, els.credPass.value, els.credClient.value, els.credToken.value);
    if (r.error) { setStatus(r.error, 'err'); return; }
    closeCred();
    renderAll();
    setStatus('凭证已更新：' + b.address + (hasOauth(b) ? '（OAuth2）' : ''), 'ok');
  }

  function clearCred() {
    const b = activeBox();
    if (!b) return;
    const ok = window.confirm
      ? window.confirm('清除 ' + b.address + ' 的口令与 OAuth2 令牌？清除后无法收信 / 发信。')
      : true;
    if (!ok) return;
    clearCredential(b);
    closeCred();
    renderAll();
    setStatus('已清除凭证：' + b.address, 'ok');
  }

  function saveManualBox() {
    const r = addManualBox(els.addAddr.value, els.addPass.value);
    if (r.error) {
      setStatus(r.error, 'err');
      try { els.addAddr.focus(); } catch (e) { /* 忽略 */ }
      return;
    }
    els.addPanel.hidden = true;
    els.addAddr.value = '';
    els.addPass.value = '';
    renderAll();
    setStatus('已添加手动邮箱：' + r.box.address, 'ok');
  }

  async function openMessage(box, m) {
    box.activeMsgId = m.id;
    if (!m.seen) {
      m.seen = true;
      markSeen(box, m.id);
    }
    renderMsgs();
    renderRead();
    renderStats();
    renderFilters();
    save();
    if (m.loaded || box.provider === 'demo') return;

    setStatus('正在读取正文…');
    try {
      const d = box.provider === 'guerrilla'
        ? await guerrillaRead(box, m.id)
        : await readMessage(box, m.id);
      m.text = textOf(d).slice(0, 4000);
      m.subject = String((d && d.subject) || m.subject || '');
      m.from = (d && d.from) || m.from;
      m.loaded = true;
      renderRead();
      save();
      setStatus('已读取正文', 'ok');
    } catch (e) {
      setStatus('读取正文失败：' + msgOf(e), 'err');
    }
  }

  /* ================= 渲染 ================= */

  function monogram(s) {
    const t = String(s == null ? '' : s).replace(/^[<"']+/, '').trim();
    return esc(t ? t.charAt(0).toUpperCase() : '?');
  }

  function boxHtml(b) {
    const unread = unreadOf(b);
    const on = b.id === S.activeId;
    const checked = SEL.has(b.id);
    return '<div class="md-box p-' + esc(b.provider) + (on ? ' is-on' : '') +
      (checked ? ' is-checked' : '') + '" role="button" tabindex="0" ' +
      'data-box="' + esc(b.id) + '" title="' + esc(b.address) + '">' +
      '<input type="checkbox" class="md-box-check" data-check="' + esc(b.id) + '"' +
        (checked ? ' checked' : '') + ' aria-label="选择 ' + esc(b.address) + '">' +
      '<span class="md-box-avatar">' + monogram(b.address) + '</span>' +
      '<span class="md-box-main">' +
        '<span class="md-box-addr">' + esc(b.address) + '</span>' +
        '<span class="md-box-meta">' +
          (b.provider === 'demo' || b.provider === 'manual'
            ? ''
            : '<span class="md-box-prov">' + esc(providerLabel(b.provider)) + '</span>') +
          esc(b.provider === 'demo' ? '本地演示' : (b.provider === 'manual' ? '手动登记' : fmtAgo(b.lastSync || b.createdAt))) +
          (b.error ? ' · <em class="md-err">收取失败</em>' : '') +
        '</span>' +
      '</span>' +
      (unread ? '<span class="md-badge">' + unread + '</span>' : '') +
      '</div>';
  }

  function renderStats() {
    if (!els) return;
    let unread = 0;
    let issues = 0;
    S.boxes.forEach(function (b) {
      unread += unreadOf(b);
      if (b.error) issues++;
    });
    els.statBoxes.textContent = String(S.boxes.length);
    els.statUnread.textContent = String(unread);
    els.statIssues.textContent = String(issues);
    els.statIssuesWrap.classList.toggle('is-bad', issues > 0);
  }

  function renderFilters() {
    if (!els) return;
    let unread = 0;
    let pass = 0;
    let error = 0;
    S.boxes.forEach(function (b) {
      if (unreadOf(b)) unread++;
      if (b.password || hasOauth(b)) pass++;
      if (b.error) error++;
    });
    const counts = { all: S.boxes.length, unread: unread, pass: pass, error: error };
    const btns = els.filters.querySelectorAll('[data-filter]');
    for (let i = 0; i < btns.length; i++) {
      const f = btns[i].getAttribute('data-filter');
      btns[i].classList.toggle('is-on', f === FILTER);
      const num = btns[i].querySelector('b');
      if (num) num.textContent = String(counts[f] || 0);
    }
  }

  function updateBatchBar(list) {
    if (!els || !els.batch) return;
    const n = SEL.size;
    els.batch.classList.toggle('is-empty', !n);
    els.batchCount.textContent = n ? ('已选 ' + n + ' 个') : '勾选后可批量操作';
    els.batchRefresh.disabled = !n || busy;
    els.batchCopy.disabled = !n;
    els.batchRemove.disabled = !n || busy;
    const visible = list || [];
    const allChecked = visible.length > 0 && visible.every(function (b) { return SEL.has(b.id); });
    els.selectAll.checked = allChecked;
    els.selectAll.indeterminate = !allChecked && visible.some(function (b) { return SEL.has(b.id); });
    if (!n) resetBatchConfirm();
  }

  function renderBoxes() {
    if (!els) return;
    pruneSelection();
    const list = S.boxes.filter(boxVisible);
    const top = els.boxes.scrollTop;
    els.boxCount.textContent = String(S.boxes.length);
    els.boxes.innerHTML = list.length
      ? list.map(boxHtml).join('')
      : '<div class="md-empty">' + (S.boxes.length
        ? '当前筛选下没有信箱<span>换个筛选条件，或清空搜索</span>'
        : '还没有信箱<span>选好服务与数量，点「批量申请」</span>') + '</div>';
    els.boxes.scrollTop = top;
    els.copyAll.disabled = !S.boxes.length || busy;
    renderFilters();
    renderStats();
    updateBatchBar(list);
  }

  function senderName(m) {
    return (m.from && (m.from.name || m.from.address)) || '未知发件人';
  }

  function msgRow(b, m) {
    const raw = (m.subject || '') + '\n' + (m.intro || '') + '\n' + (m.text || '');
    const hasCode = extractCodes(raw).length > 0;
    return '<button type="button" class="md-msg' + (m.id === b.activeMsgId ? ' is-on' : '') +
      (m.seen ? ' is-read' : '') + '" data-msg="' + esc(m.id) + '">' +
      '<span class="md-msg-avatar" aria-hidden="true">' + monogram(senderName(m)) + '</span>' +
      '<span class="md-msg-main">' +
        '<span class="md-msg-top">' +
          '<span class="md-msg-from">' + esc(senderName(m)) + '</span>' +
          '<span class="md-msg-time">' + esc(fmtAgo(m.createdAt)) + '</span>' +
        '</span>' +
        '<span class="md-msg-subject">' + esc(m.subject || '(无主题)') + '</span>' +
        (m.intro ? '<span class="md-msg-intro">' + esc(m.intro) + '</span>' : '') +
        (hasCode ? '<span class="md-msg-tag">含验证码</span>' : '') +
      '</span>' +
      '</button>';
  }

  function msgMatches(m) {
    if (!MSGQ) return true;
    const from = m.from ? (String(m.from.name || '') + ' ' + String(m.from.address || '')) : '';
    return (String(m.subject || '') + ' ' + from + ' ' + String(m.intro || ''))
      .toLowerCase().indexOf(MSGQ) >= 0;
  }

  function renderMsgs() {
    if (!els) return;
    const b = activeBox();
    els.addr.textContent = b ? b.address : '未选择信箱';
    els.addr.title = b ? b.address : '';
    els.prov.hidden = !b;
    els.prov.textContent = b
      ? (b.provider === 'manual' ? '手动登记' : (b.provider === 'demo' ? '本地演示' : providerLabel(b.provider)))
      : '';
    const pass = b ? String(b.password || '') : '';
    const oauth = !!b && hasOauth(b);
    els.passRow.hidden = !pass && !oauth;
    els.pass.textContent = pass || (oauth ? 'OAuth2（令牌已保存）' : '—');
    els.pass.title = pass ? '信箱口令：' + pass : (oauth ? 'OAuth2 刷新令牌已保存在本机，不在界面显示' : '');
    els.copyAddr.disabled = !b || busy;
    els.copyPass.disabled = !pass || busy;
    const manual = !!b && b.provider === 'manual';
    const preset = manual ? imapPreset(b.address) : null;
    const canFetch = manual ? (!!preset && (!!b.password || oauth)) : true;
    els.syncOne.disabled = !b || (manual && !canFetch) || busy;
    els.syncOne.title = manual
      ? (canFetch
        ? '通过 IMAP' + (oauth ? '（OAuth2）' : '') + '收取：' + preset.host
        : (!preset ? '这个域名还没有内置 IMAP 收信配置' : '没有口令或 OAuth2 令牌，无法收信'))
      : '';
    const smtp = manual ? smtpPreset(b.address) : null;
    const canMail = manual ? (canSend(b)) : false;
    els.compose.disabled = !canMail || busy;
    els.compose.title = canMail
      ? '用 ' + b.address + ' 发信：' + smtp.host
      : '这个信箱没有可用的发信凭证';
    els.cred.disabled = !manual || busy;
    els.cred.title = manual ? '更新或清除这个邮箱的口令 / OAuth2 凭证' : '只有手动邮箱可以管理凭证';
    els.remove.disabled = !b || busy;
    if (!b) {
      els.msgCount.textContent = '0 封';
      els.msgSearch.disabled = true;
      els.msgs.innerHTML = '<div class="md-empty">左侧选一个信箱<span>或先批量申请几个</span></div>';
      return;
    }
    const unread = unreadOf(b);
    els.msgCount.textContent = b.messages.length + ' 封' + (unread ? ' · 未读 ' + unread : '');
    els.msgSearch.disabled = !b.messages.length;
    const list = b.messages.filter(msgMatches);
    const top = els.msgs.scrollTop;
    els.msgs.innerHTML = list.length
      ? list.map(function (m) { return msgRow(b, m); }).join('')
      : '<div class="md-empty">' + (b.messages.length
        ? '没有匹配的邮件<span>换个关键词试试</span>'
        : (manual
          ? (canFetch
            ? '这个信箱还没有来信<span>点「刷新」通过 IMAP 收取</span>'
            : '这个域名暂时不能收信<span>可复制地址与凭证，到目标站点使用</span>')
          : '这个信箱还没有来信<span>把地址填到目标站点，再点「刷新」收取</span>')) + '</div>';
    els.msgs.scrollTop = top;
  }

  function renderRead() {
    if (!els) return;
    const b = activeBox();
    const m = activeMsg();
    if (!b || !m) {
      els.read.innerHTML = '<div class="md-empty">点开一封信<span>正文、验证码与链接会显示在这里</span></div>';
      return;
    }
    const text = m.text || m.intro || '（这封信没有可读正文，点「刷新」后再试试）';
    const codes = extractCodes((m.subject || '') + '\n' + text);
    const links = extractLinks((m.subject || '') + '\n' + text);

    els.read.innerHTML =
      '<div class="md-read-bar">' +
        '<span class="md-read-badge">' + esc(providerLabel(b.provider)) + '</span>' +
        '<span class="md-read-acts">' +
          '<button type="button" class="md-mini" data-read-act="copy-body">复制正文</button>' +
          '<button type="button" class="md-mini" data-read-act="toggle-seen">' +
            (m.seen ? '标为未读' : '标为已读') + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="md-read-head">' +
        '<div class="md-read-subject">' + esc(m.subject || '(无主题)') + '</div>' +
        '<div class="md-read-meta">' +
          '<span class="md-read-from">' + esc(fromText(m.from)) + '</span>' +
          '<span class="md-read-sep">·</span>' +
          '<span>' + esc(fmtFull(m.createdAt)) + '</span>' +
        '</div>' +
      '</div>' +
      (codes.length
        ? '<div class="md-codes"><div class="md-codes-h">识别到的验证码 · 点击复制</div>' +
          codes.map(function (c) {
            return '<button type="button" class="md-code" data-copy="' + esc(c) + '" title="复制 ' + esc(c) + '">' + esc(c) + '</button>';
          }).join('') + '</div>'
        : '') +
      (links.length
        ? '<div class="md-links"><div class="md-links-h">邮件里的链接</div>' +
          links.map(function (u) {
            return '<div class="md-link-row">' +
              '<span class="md-link" title="' + esc(u) + '">' + esc(clip(u, 72)) + '</span>' +
              '<button type="button" class="md-mini" data-copy="' + esc(u) + '">复制</button>' +
              '<button type="button" class="md-mini" data-open="' + esc(u) + '">打开</button>' +
              '</div>';
          }).join('') + '</div>'
        : '') +
      '<div class="md-read-body"><pre class="md-body">' + esc(text) + '</pre></div>';
  }

  function renderAll() {
    if (!els) return;
    renderBoxes();
    renderMsgs();
    renderRead();
    updateHint();
  }

  function updateHint() {
    if (!els) return;
    els.hint.textContent = S.provider === 'demo'
      ? '演示模式：信箱只在本机模拟'
      : (S.provider === 'guerrilla'
        ? 'Guerrilla 免账号，会话过期后需重新申请'
        : '口令与 OAuth2 令牌只保存在本机，收发信经本地中转');
  }

  function setStatus(text, tone) {
    if (!els) return;
    els.status.textContent = text;
    els.statusBar.classList.remove('is-ok', 'is-err');
    if (tone === 'ok') els.statusBar.classList.add('is-ok');
    if (tone === 'err') els.statusBar.classList.add('is-err');
  }

  function setBusy(on) {
    busy = on;
    if (!els) return;
    els.root.classList.toggle('is-busy', on);
    els.create.disabled = on;
    els.syncAll.disabled = on;
    renderBoxes();
    renderMsgs();
  }

  function setNet(text, tone) {
    if (!els || !els.netText) return;
    els.netText.textContent = text;
    els.net.className = 'md-net' + (tone ? ' is-' + tone : '');
  }

  async function checkNet() {
    if (!els) return;
    if (S.provider === 'demo') { setNet('离线演示', 'demo'); return; }
    try {
      const r = await fetch(relayHealthUrl(), { cache: 'no-store' });
      setNet(r.ok ? '本地中转在线' : '本地中转异常', r.ok ? 'ok' : 'bad');
    } catch (e) {
      setNet('本地中转未启动', 'bad');
    }
  }

  /* ================= 剪贴板 / 打开链接 ================= */

  async function copyText(text) {
    const s = String(text == null ? '' : text);
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }

  async function copyThenStatus(text, label) {
    const ok = await copyText(text);
    if (ok) setStatus('已复制' + (label ? '：' + clip(label, 60) : ''), 'ok');
    else setStatus('复制失败：浏览器拒绝了剪贴板权限', 'err');
  }

  function openInBrowser(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    if (typeof window.openDeskApp === 'function') {
      window.__bwPendingUrl = url;
      window.openDeskApp('browser');
      setStatus('已转交内置浏览器打开', 'ok');
    } else {
      copyThenStatus(url, url);
    }
  }

  /* ================= AI 邮箱助手 =================
   * 把当前信箱清单（地址、未读、是否有口令、最近来信与识别到的验证码）交给模型，
   * 模型只返回一份操作计划；删除等动作必须由用户点「执行」后才落到本机。
   * 口令永远不进模型上下文。
   */
  const AI = { open: false, busy: false, log: [] };

  const AI_SYS = [
    '你是「邮箱台」里的邮箱管理助手，帮助用户查看、添加、选择、刷新、清理信箱，以及代写并发信。',
    '只输出一个 JSON 对象，不要 Markdown，不要在 JSON 之外写任何文字。',
    '格式：{"reply":"中文答复","actions":[...]}',
    '可用动作：',
    '{"type":"add","address":"name@example.com","password":"可选"}',
    '{"type":"remove","address":"name@example.com"}',
    '{"type":"select","address":"name@example.com"}',
    '{"type":"refresh","address":"可选；为空表示全部"}',
    '{"type":"send","address":"发件信箱，可选；为空用当前信箱","to":"收件人","subject":"主题","body":"纯文本正文"}',
    '规则：只能引用状态清单里存在的地址；用户没有明确要求删除时不要生成 remove；',
    '只有用户明确要求发信时才生成 send，正文要完整可发送，不要虚构凭证或验证码；',
    '凭证明细不会出现在状态里，也不要向用户索要 refresh_token；',
    '不要编造地址、口令或来信内容；不需要执行动作时 actions 用空数组；reply 控制在 80 字内。'
  ].join('\n');

  function llmConnSafe() {
    try {
      if (typeof llmConn === 'function') return llmConn();
    } catch (e) { /* 未配置 */ }
    return null;
  }

  function aiReady() {
    const conn = llmConnSafe();
    return !!(window.LLMRouter && typeof window.LLMRouter.complete === 'function'
      && conn && conn.base && conn.key && conn.model);
  }

  function aiContext() {
    const lines = ['时间：' + fmtFull(new Date().toISOString()) + '；信箱数：' + S.boxes.length];
    S.boxes.slice(0, 40).forEach(function (b, i) {
      const unread = b.messages.filter(function (m) { return !m.seen; }).length;
      const recent = b.messages.slice(0, 3).map(function (m) {
        const codes = extractCodes((m.subject || '') + '\n' + (m.text || m.intro || ''));
        return '「' + clip(m.subject || '(无主题)', 40) + '」' +
          (codes.length ? ' 码:' + codes.join('/') : '');
      }).join('');
      lines.push((i + 1) + '. ' + b.address + ' | ' + providerLabel(b.provider) +
        ' | 未读 ' + unread + ' | ' + (b.password ? '有口令' : (hasOauth(b) ? 'OAuth2 已配置' : '无口令')) +
        (b.provider === 'manual' ? (manualFetchable(b) ? ' | IMAP 可收信' : ' | 不可收信') : '') +
        (b.provider === 'manual' && canSend(b) ? ' | SMTP 可发信' : '') +
        (b.error ? ' | 收取失败' : '') + (recent ? ' | 来信 ' + recent : ''));
    });
    if (!S.boxes.length) lines.push('（列表为空）');
    return lines.join('\n');
  }

  function parseAiPlan(raw) {
    let t = String(raw == null ? '' : raw).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return { reply: t || '（模型没有返回内容）', actions: [] };
    let obj;
    try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { return { reply: t.slice(a, b + 1), actions: [] }; }
    const allowed = { add: 1, remove: 1, select: 1, refresh: 1, send: 1 };
    const actions = Array.isArray(obj.actions) ? obj.actions.filter(function (x) {
      if (!x || !allowed[x.type]) return false;
      if (x.type === 'refresh') return true;
      if (x.type === 'send') return !!String(x.to || '').trim() && !!String(x.body || '').trim();
      return !!String(x.address || '').trim();
    }).slice(0, 12) : [];
    return { reply: String(obj.reply || '').trim(), actions: actions };
  }

  function actionLabel(a) {
    const addr = String(a.address || '');
    if (a.type === 'add') return '添加手动邮箱 ' + addr + (a.password ? '（含口令）' : '（无口令）');
    if (a.type === 'remove') return '移除 ' + addr;
    if (a.type === 'select') return '选中 ' + addr;
    if (a.type === 'refresh') return addr ? ('刷新 ' + addr) : '刷新全部可收信信箱';
    if (a.type === 'send') {
      return '用 ' + (addr || '当前信箱') + ' 发到 ' + String(a.to || '') +
        (a.subject ? '：' + clip(a.subject, 30) : '');
    }
    return '未知动作';
  }

  function aiMsgHtml(item, i) {
    if (item.role === 'user') return '<div class="md-ai-msg is-user">' + esc(item.text) + '</div>';
    if (item.role === 'err') return '<div class="md-ai-msg is-err">' + esc(item.text) + '</div>';
    let html = '<div class="md-ai-msg is-agent">' + esc(item.text);
    if (item.actions && item.actions.length) {
      html += '<div class="md-ai-plan">' + item.actions.map(function (a) {
        return '<div class="md-ai-act">' + esc(actionLabel(a)) + '</div>';
      }).join('');
      if (!item.done) {
        html += '<div class="md-ai-plan-acts">' +
          '<button type="button" class="md-mini" data-ai-skip="' + i + '">忽略</button>' +
          '<button type="button" class="md-btn md-primary" data-ai-run="' + i + '">执行</button>' +
          '</div>';
      } else if (item.results && item.results.length) {
        html += '<div class="md-ai-results">' + item.results.map(function (r) {
          return '<div>' + esc(r) + '</div>';
        }).join('') + '</div>';
      }
      html += '</div>';
    }
    return html + '</div>';
  }

  function renderAi() {
    if (!els || !els.ai) return;
    els.ai.hidden = !AI.open;
    els.aiToggle.classList.toggle('is-on', AI.open);
    els.aiToggle.textContent = AI.open ? '收起助手' : 'AI 助手';
    if (!AI.open) return;
    els.aiNote.textContent = aiReady() ? '操作计划需确认后执行' : '未配置语言模型';
    els.aiSend.disabled = AI.busy;
    const nearBottom = els.aiLog.scrollHeight - els.aiLog.scrollTop - els.aiLog.clientHeight < 48;
    els.aiLog.innerHTML = AI.log.length
      ? AI.log.map(aiMsgHtml).join('')
      : '<div class="md-ai-empty">问它「现在有哪些未读」，或让它帮你清理空信箱。</div>';
    if (nearBottom || AI.log.length <= 1) els.aiLog.scrollTop = els.aiLog.scrollHeight;
  }

  function setAiOpen(on) {
    AI.open = !!on;
    if (AI.open && !AI.log.length) {
      AI.log.push({
        role: 'agent',
        text: '我可以汇总未读、检查凭证与异常、刷新收信、添加或清理信箱，也能代写并发信。说出要求，我先给计划，你确认后再执行。',
        actions: []
      });
    }
    renderAi();
    if (AI.open) setTimeout(function () { try { els.aiText.focus(); } catch (e) { /* 忽略 */ } }, 40);
  }

  function askAgent(text) {
    const q = String(text == null ? '' : text).trim();
    if (!q || AI.busy) return;
    if (!aiReady()) {
      AI.log.push({ role: 'err', text: '还没有可用的语言模型：请先在「设置 → 模型」里配置接口与 Key。' });
      renderAi();
      return;
    }
    const history = AI.log.filter(function (x) {
      return x.role === 'user' || x.role === 'agent';
    }).slice(-6).map(function (x) {
      return { role: x.role === 'user' ? 'user' : 'assistant', content: x.text };
    });
    AI.log.push({ role: 'user', text: q });
    AI.busy = true;
    renderAi();
    window.LLMRouter.complete({
      app: 'maildesk',
      sys: AI_SYS,
      messages: history.concat([{
        role: 'user',
        content: '当前信箱状态：\n' + aiContext() + '\n\n用户指令：' + q
      }]),
      opts: { temperature: 0.2, timeoutMs: 60000 }
    }).then(function (out) {
      const plan = parseAiPlan(out);
      AI.log.push({
        role: 'agent', text: plan.reply || '（模型没有给出说明）',
        actions: plan.actions, done: false, results: null
      });
    }).catch(function (e) {
      AI.log.push({ role: 'err', text: '助手调用失败：' + msgOf(e) });
    }).then(function () {
      AI.busy = false;
      renderAi();
    });
  }

  async function aiRefresh(address) {
    const box = address ? findBox(address) : null;
    if (address && !box) return '没找到：' + address;
    if (box && (box.provider === 'demo' || (box.provider === 'manual' && !manualFetchable(box)))) {
      return box.address + ' 不支持收信';
    }
    if (!box) {
      const any = S.boxes.some(function (b) {
        return b.provider === 'mailtm' || b.provider === 'mailgw' ||
          b.provider === 'guerrilla' || manualFetchable(b);
      });
      if (!any) return '没有可收信的信箱';
      await syncAll(false);
      return '已刷新全部可收信信箱';
    }
    if (busy) return '正在刷新，稍后再试';
    busy = true;
    setBusy(true);
    try {
      await syncBox(box);
      renderMsgs();
      renderRead();
      save();
      return '已刷新 ' + box.address;
    } catch (e) {
      box.error = msgOf(e);
      return '刷新失败：' + box.error;
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  async function runAiActions(i) {
    const item = AI.log[i];
    if (!item || item.done || !item.actions) return;
    item.done = true;
    item.results = [];
    for (let k = 0; k < item.actions.length; k++) {
      const a = item.actions[k];
      try {
        if (a.type === 'add') {
          const r = addManualBox(a.address, a.password);
          item.results.push(r.error || ('已添加 ' + r.box.address));
        } else if (a.type === 'remove') {
          const box = findBox(a.address);
          if (!box) item.results.push('没找到：' + a.address);
          else { const addr = box.address; removeBox(box); item.results.push('已移除 ' + addr); }
        } else if (a.type === 'select') {
          const box = findBox(a.address);
          if (!box) item.results.push('没找到：' + a.address);
          else { selectBox(box.id); item.results.push('已选中 ' + box.address); }
        } else if (a.type === 'refresh') {
          item.results.push(await aiRefresh(a.address));
        } else if (a.type === 'send') {
          const box = a.address ? findBox(a.address) : activeBox();
          if (!box) item.results.push('没找到发件信箱：' + (a.address || '当前信箱'));
          else if (!canSend(box)) item.results.push(box.address + ' 没有可用的发信凭证');
          else {
            try {
              await sendMail(box, a.to, a.subject, a.body);
              item.results.push('已用 ' + box.address + ' 发送到 ' + a.to);
            } catch (e) {
              item.results.push('发信失败：' + msgOf(e));
            }
          }
        }
      } catch (e) {
        item.results.push('失败：' + msgOf(e));
      }
    }
    renderAll();
    renderAi();
  }

  function sendAiInput(text) {
    const v = text == null ? els.aiText.value : text;
    els.aiText.value = '';
    askAgent(v);
  }

  /* ================= 自动收取 ================= */

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(function () {
      if (!els || !S.auto || busy) return;
      const win = document.getElementById('maildeskWin');
      if (win && win.classList.contains('hidden')) return;
      const gap = (Number(S.autoSec) || 30) * 1000;
      if (now() - (S.lastAutoAt || 0) < gap) return;
      S.lastAutoAt = now();
      syncAll(true);
    }, 5000);
  }

  /* ================= 事件 ================= */

  function cacheEls(body) {
    const q = function (s) { return body.querySelector(s); };
    els = {
      root: q('.md-root'),
      net: q('#mdNet'),
      netText: q('#mdNet span'),
      statBoxes: q('#mdStatBoxes'),
      statUnread: q('#mdStatUnread'),
      statIssues: q('#mdStatIssues'),
      statIssuesWrap: q('#mdStatIssuesWrap'),
      provider: q('#mdProvider'),
      count: q('#mdCount'),
      prefix: q('#mdPrefix'),
      create: q('#mdCreate'),
      auto: q('#mdAuto'),
      autoSec: q('#mdAutoSec'),
      syncAll: q('#mdSyncAll'),
      importBtn: q('#mdImport'),
      exportBtn: q('#mdExport'),
      boxCount: q('#mdBoxCount'),
      filters: q('#mdFilters'),
      addBtn: q('#mdAdd'),
      addPanel: q('#mdAddPanel'),
      addAddr: q('#mdAddAddr'),
      addPass: q('#mdAddPass'),
      addSave: q('#mdAddSave'),
      addCancel: q('#mdAddCancel'),
      copyAll: q('#mdCopyAll'),
      search: q('#mdSearch'),
      batch: q('#mdBatch'),
      batchCount: q('#mdSelCount'),
      selectAll: q('#mdSelectAll'),
      batchRefresh: q('#mdBatchRefresh'),
      batchCopy: q('#mdBatchCopy'),
      batchRemove: q('#mdBatchRemove'),
      boxes: q('#mdBoxes'),
      addr: q('#mdAddr'),
      prov: q('#mdProv'),
      passRow: q('#mdPassRow'),
      pass: q('#mdPass'),
      copyAddr: q('#mdCopyAddr'),
      copyPass: q('#mdCopyPass'),
      compose: q('#mdCompose'),
      cred: q('#mdCred'),
      syncOne: q('#mdSyncOne'),
      remove: q('#mdRemove'),
      msgCount: q('#mdMsgCount'),
      msgSearch: q('#mdMsgSearch'),
      msgs: q('#mdMsgs'),
      read: q('#mdRead'),
      status: q('#mdStatus'),
      statusBar: q('.md-status'),
      hint: q('#mdHint'),
      ai: q('#mdAi'),
      aiToggle: q('#mdAiToggle'),
      aiNote: q('#mdAiNote'),
      aiLog: q('#mdAiLog'),
      aiQuick: q('.md-ai-quick'),
      aiText: q('#mdAiText'),
      aiSend: q('#mdAiSend'),
      aiClear: q('#mdAiClear'),
      aiClose: q('#mdAiClose'),
      importModal: q('#mdImportModal'),
      importText: q('#mdImportText'),
      importSave: q('#mdImportSave'),
      importCancel: q('#mdImportCancel'),
      composeModal: q('#mdComposeModal'),
      composeFrom: q('#mdComposeFrom'),
      composeTo: q('#mdComposeTo'),
      composeSubject: q('#mdComposeSubject'),
      composeBody: q('#mdComposeBody'),
      composeSend: q('#mdComposeSend'),
      composeCancel: q('#mdComposeCancel'),
      credModal: q('#mdCredModal'),
      credAddr: q('#mdCredAddr'),
      credPass: q('#mdCredPass'),
      credClient: q('#mdCredClient'),
      credToken: q('#mdCredToken'),
      credSave: q('#mdCredSave'),
      credCancel: q('#mdCredCancel'),
      credClear: q('#mdCredClear')
    };
  }

  function syncForm() {
    els.provider.value = S.provider;
    els.count.value = String(S.count);
    els.prefix.value = S.prefix;
    els.auto.checked = !!S.auto;
    els.autoSec.value = String(S.autoSec);
  }

  function wire() {
    els.provider.addEventListener('change', function () {
      S.provider = PROVIDERS[els.provider.value] ? els.provider.value : 'mailtm';
      save();
      updateHint();
      checkNet();
    });

    function readCount() {
      const n = clamp(parseInt(els.count.value, 10) || 1, 1, 20);
      S.count = n;
      els.count.value = String(n);
      save();
    }
    els.count.addEventListener('change', readCount);
    els.count.addEventListener('blur', readCount);

    els.prefix.addEventListener('input', function () {
      S.prefix = String(els.prefix.value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      save();
    });

    els.create.addEventListener('click', function () { createBatch(); });

    els.syncAll.addEventListener('click', function () { syncAll(false); });

    els.auto.addEventListener('change', function () {
      S.auto = !!els.auto.checked;
      S.lastAutoAt = 0;
      save();
      setStatus(S.auto ? '已开启自动收取（每 ' + S.autoSec + ' 秒）' : '已关闭自动收取');
    });

    els.autoSec.addEventListener('change', function () {
      S.autoSec = Number(els.autoSec.value) || 30;
      S.lastAutoAt = 0;
      save();
    });

    els.search.addEventListener('input', function () { renderBoxes(); });

    els.filters.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      FILTER = btn.getAttribute('data-filter') || 'all';
      renderBoxes();
    });

    els.selectAll.addEventListener('change', function () {
      const list = S.boxes.filter(boxVisible);
      if (els.selectAll.checked) list.forEach(function (b) { SEL.add(b.id); });
      else list.forEach(function (b) { SEL.delete(b.id); });
      renderBoxes();
    });

    els.batchRefresh.addEventListener('click', function () { batchRefresh(); });
    els.batchCopy.addEventListener('click', function () { batchCopy(); });
    els.batchRemove.addEventListener('click', function () { batchRemove(); });

    els.msgSearch.addEventListener('input', function () {
      MSGQ = String(els.msgSearch.value || '').trim().toLowerCase();
      renderMsgs();
    });

    els.importBtn.addEventListener('click', openImport);
    els.importCancel.addEventListener('click', closeImport);
    els.importSave.addEventListener('click', runImport);

    els.importModal.addEventListener('click', function (e) {
      if (e.target === els.importModal) closeImport();
    });

    els.compose.addEventListener('click', function () { openCompose(); });
    els.composeCancel.addEventListener('click', closeCompose);
    els.composeSend.addEventListener('click', runCompose);
    els.composeModal.addEventListener('click', function (e) {
      if (e.target === els.composeModal) closeCompose();
    });

    els.cred.addEventListener('click', function () { openCred(); });
    els.credCancel.addEventListener('click', closeCred);
    els.credSave.addEventListener('click', saveCred);
    els.credClear.addEventListener('click', clearCred);
    els.credModal.addEventListener('click', function (e) {
      if (e.target === els.credModal) closeCred();
    });
    els.composeBody.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCompose();
    });
    els.credToken.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCred();
    });

    els.exportBtn.addEventListener('click', function () {
      const list = SEL.size ? selectedBoxes() : S.boxes;
      if (!list.length) { setStatus('还没有可导出的信箱', 'err'); return; }
      const text = exportText(list);
      if (downloadText('maildesk-' + Date.now() + '.txt', text)) {
        setStatus('已导出 ' + list.length + ' 个信箱（地址+口令，不含令牌）', 'ok');
      } else {
        copyThenStatus(text, list.length + ' 个信箱（地址+口令）');
      }
    });

    els.addBtn.addEventListener('click', function () {
      els.addPanel.hidden = !els.addPanel.hidden;
      if (!els.addPanel.hidden) {
        els.addAddr.value = '';
        els.addPass.value = '';
        setTimeout(function () { try { els.addAddr.focus(); } catch (e) { /* 忽略 */ } }, 30);
      }
    });

    els.addCancel.addEventListener('click', function () { els.addPanel.hidden = true; });

    els.addSave.addEventListener('click', saveManualBox);

    els.addPass.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveManualBox();
    });

    els.addAddr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') els.addPass.focus();
    });

    els.aiToggle.addEventListener('click', function () { setAiOpen(!AI.open); });
    els.aiClose.addEventListener('click', function () { setAiOpen(false); });

    els.aiClear.addEventListener('click', function () {
      AI.log = [];
      setAiOpen(true);
    });

    els.aiSend.addEventListener('click', function () { sendAiInput(); });

    els.aiText.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiInput();
      }
    });

    els.aiQuick.addEventListener('click', function (e) {
      const b = e.target.closest('[data-ai-q]');
      if (b) sendAiInput(b.getAttribute('data-ai-q'));
    });

    els.aiLog.addEventListener('click', function (e) {
      const run = e.target.closest('[data-ai-run]');
      if (run) {
        runAiActions(Number(run.getAttribute('data-ai-run')));
        return;
      }
      const skip = e.target.closest('[data-ai-skip]');
      if (skip) {
        const item = AI.log[Number(skip.getAttribute('data-ai-skip'))];
        if (item && !item.done) {
          item.done = true;
          item.results = ['已忽略本次计划'];
          renderAi();
        }
      }
    });

    els.copyAll.addEventListener('click', function () {
      if (!S.boxes.length) return;
      copyThenStatus(S.boxes.map(function (b) { return b.address; }).join('\n'),
        S.boxes.length + ' 个地址');
    });

    els.copyAddr.addEventListener('click', function () {
      const b = activeBox();
      if (b) copyThenStatus(b.address, b.address);
    });

    els.copyPass.addEventListener('click', function () {
      const b = activeBox();
      if (b && b.password) copyThenStatus(b.password, b.password);
    });

    els.syncOne.addEventListener('click', async function () {
      const b = activeBox();
      if (!b || busy) return;
      if (b.provider === 'demo') { setStatus('演示信箱不需要刷新'); return; }
      busy = true;
      setBusy(true);
      setStatus('正在收取：' + b.address);
      try {
        await syncBox(b);
        renderMsgs();
        renderRead();
        setStatus('收取完成：' + b.messages.length + ' 封信', 'ok');
      } catch (e) {
        b.error = msgOf(e);
        setStatus('收取失败：' + b.error, 'err');
      } finally {
        busy = false;
        setBusy(false);
        save();
      }
    });

    els.remove.addEventListener('click', function () {
      const b = activeBox();
      if (!b) return;
      removeBox(b);
    });

    els.boxes.addEventListener('click', function (e) {
      const chk = e.target.closest('[data-check]');
      if (chk) {
        toggleSel(chk.getAttribute('data-check'), chk.checked);
        return;
      }
      const el = e.target.closest('[data-box]');
      if (!el) return;
      selectBox(el.getAttribute('data-box'));
    });

    els.boxes.addEventListener('keydown', function (e) {
      const el = e.target.closest('[data-box]');
      if (!el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      selectBox(el.getAttribute('data-box'));
    });

    els.msgs.addEventListener('click', function (e) {
      const el = e.target.closest('[data-msg]');
      if (!el) return;
      const b = activeBox();
      if (!b) return;
      const id = el.getAttribute('data-msg');
      let m = null;
      for (let i = 0; i < b.messages.length; i++) if (b.messages[i].id === id) m = b.messages[i];
      if (m) openMessage(b, m);
    });

    els.root.addEventListener('click', function (e) {
      const act = e.target.closest('[data-read-act]');
      if (act) {
        e.preventDefault();
        const kind = act.getAttribute('data-read-act');
        if (kind === 'toggle-seen') toggleSeen();
        if (kind === 'copy-body') {
          const m = activeMsg();
          if (m) copyThenStatus(m.text || m.intro || '', '邮件正文');
        }
        return;
      }
      const c = e.target.closest('[data-copy]');
      if (c) {
        e.preventDefault();
        copyThenStatus(c.getAttribute('data-copy'), c.getAttribute('data-copy'));
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) {
        e.preventDefault();
        openInBrowser(o.getAttribute('data-open'));
      }
    });
  }

  /* ================= 注册 ================= */

  registerApp({
    id: 'maildesk',
    name: '邮箱台',
    title: '邮箱台 · 批量信箱与收件',
    sub: '批量申请临时信箱，集中收取验证码与链接',
    icon: ICON,
    order: 18,
    cls: 'maildesk',
    win: 'maildeskWin',
    css: ['apps/maildesk/app.css'],

    mount: function (body) {
      /* 已经画过：只刷新数据，不重建 DOM —— 否则正在读的那封信、滚动位置、
         输入框里的前缀都会被冲掉。 */
      if (body.dataset.ready === '1' && els && els.root && body.contains(els.root)) {
        renderAll();
        renderAi();
        checkNet();
        ensureTimer();
        return;
      }

      loadDomainCache();
      body.innerHTML = BODY;
      cacheEls(body);
      wire();
      syncForm();
      body.dataset.ready = '1';

      renderAll();
      renderAi();
      ensureTimer();
      checkNet();
      if (S.boxes.length) setStatus('已恢复 ' + S.boxes.length + ' 个信箱');
      setTimeout(function () { try { els.count.focus(); } catch (e) { /* 忽略 */ } }, 80);
    }
  });
})();
