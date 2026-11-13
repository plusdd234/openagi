/* ================= 语言模型路由层 =================
 * 目标：把「用哪套凭据」从各 App 里收回来，统一由这里决定。
 *
 * 现状：
 *   - 设置页那套配置（llmBaseUrl / llmKey / llmModel）始终作为默认凭据；
 *   - 额外 Key 存在 localStorage 的 hf_llm_keys，字段与默认凭据一致；
 *   - 登录云端网关时，网关凭据仍然优先，行为与 llmConn() 保持一致。
 *
 * 路由规则（按 App 请求分配空闲凭据）：
 *   1. 先按 app 过滤：条目的 apps 为空表示所有 App 可用，否则只在列出的 App 里用；
 *   2. 再按空闲度排序：inflight / maxConcurrent 越小越优先；
 *   3. 同分时优先「该 App 上次用成功的 Key」，避免同一任务每轮换 Key；
 *   4. 都没空时退化为最少占用者，不阻塞请求。
 *
 * 对外 API（全局 LLMRouter）：
 *   LLMRouter.acquire({ app, conn })        取一条凭据，返回 { conn, release(result) }
 *   LLMRouter.complete({ app, sys, messages, onDelta, opts })
 *                                           流式对话的高层封装，自动取/还凭据
 *   LLMRouter.postChat({ app, conn, messages, temperature, max_tokens, timeoutMs })
 *                                           非流式 /chat/completions，返回原始 JSON
 *   LLMRouter.add({ label, base, key, model, apps, maxConcurrent })
 *   LLMRouter.update(id, patch) / remove(id) / setEnabled(id, on)
 *   LLMRouter.stats() / resetStats()
 *
 * 凭据只在内存里记录 inflight / cooldown，不落盘；额外 Key 落盘在 hf_llm_keys。
 * ==================================================== */
(function (global) {
  'use strict';

  var LS_KEY = 'hf_llm_keys';
  var DEFAULT_MAX = 2;              // 额外 Key 默认同时处理 2 个请求
  var COOLDOWN_RATE = 45 * 1000;    // 429：让这个 Key 歇 45 秒
  var COOLDOWN_AUTH = 5 * 60 * 1000;// 401 / 402 / 403：先歇 5 分钟
  var COOLDOWN_FAIL = 15 * 1000;    // 其他失败：短暂避让，避免连续撞同一个

  var runtime = Object.create(null); // id -> { inflight, ok, fail, lastAt, cooldownUntil, lastError }
  var affinity = Object.create(null);// app -> 上次成功的 Key id
  var rr = 0;

  function trimBase(v) {
    return String(v == null ? '' : v).trim().replace(/\/+$/, '');
  }

  function maskKey(k) {
    var s = String(k || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 4) + '****' + s.slice(-4);
  }

  /* 读当前设置：桌面用 confLlm()，独立页（multiview.html）退回 DOM / localStorage */
  function readConfigConn() {
    try {
      if (typeof global.confLlm === 'function') return global.confLlm();
    } catch (_) { /* 继续走兜底 */ }
    function get(id) {
      var el = document.getElementById(id);
      if (el && typeof el.value === 'string') return String(el.value).trim();
      try { return String(localStorage.getItem('hf_' + id) || '').trim(); } catch (_) { return ''; }
    }
    return { base: get('llmBaseUrl'), key: get('llmKey'), model: get('llmModel') };
  }

  /* 云端网关凭据：只有已登录且不是「仅本地」模式时才算候选，和 llmConn() 的优先级一致 */
  function gatewayEntry() {
    try {
      if (typeof global.gwLogged !== 'function' || !global.gwLogged()) return null;
      if (typeof global.llmMode === 'function' && global.llmMode() === 'local') return null;
      if (typeof global.gwConn !== 'function') return null;
      var c = global.gwConn();
      if (!c || !c.base || !c.key) return null;
      return {
        id: '__gateway__', label: '云端网关', base: trimBase(c.base), key: c.key,
        model: String(c.model || ''), via: 'gateway', apps: [],
        enabled: true, maxConcurrent: 16
      };
    } catch (_) { return null; }
  }

  function readExtras() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (_) { return []; }
  }

  function writeExtras(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (_) { /* 配额满时只影响持久化 */ }
  }

  function sanitize(e) {
    e = e || {};
    return {
      id: e.id || ('k_' + Math.random().toString(36).slice(2, 9)),
      label: String(e.label || '备用 Key'),
      base: trimBase(e.base),
      key: String(e.key == null ? '' : e.key).trim(),
      model: String(e.model == null ? '' : e.model).trim(),
      apps: Array.isArray(e.apps) ? e.apps.map(String) : [],
      enabled: e.enabled !== false,
      maxConcurrent: Math.max(1, Number(e.maxConcurrent) || DEFAULT_MAX)
    };
  }

  function runtimeOf(id) {
    if (!runtime[id]) {
      runtime[id] = { inflight: 0, ok: 0, fail: 0, lastAt: 0, cooldownUntil: 0, lastError: '' };
    }
    return runtime[id];
  }

  function configEntry() {
    var c = readConfigConn();
    var key = String(c.key || '').trim();
    if (!key) return null;
    return {
      id: '__config__', label: '当前配置', base: trimBase(c.base), key: key,
      model: String(c.model || '').trim(), via: 'local', apps: [],
      enabled: true, maxConcurrent: 16
    };
  }

  function allEntries() {
    var list = [];
    var gw = gatewayEntry();
    if (gw) list.push(gw);
    var cfg = configEntry();
    if (cfg) list.push(cfg);
    readExtras().forEach(function (e) {
      var s = sanitize(e);
      if (s.base && s.key) { s.via = 'local'; list.push(s); }
    });
    var seen = Object.create(null);
    return list.filter(function (e) {
      var k = e.base + '\n' + e.key;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  /* 实际参与路由的候选：网关模式下仍只走网关，避免改变登录用户的既有链路 */
  function routableEntries() {
    var gw = gatewayEntry();
    if (gw) return [gw];
    return allEntries().filter(function (e) { return e.id !== '__gateway__'; });
  }

  function usable(e, app) {
    if (!e.enabled || !e.base || !e.key) return false;
    if (e.apps.length && e.apps.indexOf(app) < 0) return false;
    var rt = runtimeOf(e.id);
    return rt.cooldownUntil <= Date.now();
  }

  function loadScore(e) {
    var rt = runtimeOf(e.id);
    return rt.inflight / Math.max(1, e.maxConcurrent);
  }

  function choose(list, app) {
    var st = runtime[affinity[app]] || null;
    if (st && st.inflight === 0) {
      var pinned = list.filter(function (e) { return e.id === affinity[app]; })[0];
      var hasBound = list.some(function (e) { return e.apps.length && e.apps.indexOf(app) >= 0; });
      /* 有专门绑定给这个 App 的 Key 时，不要让旧的 affinity 把请求留在通用 Key 上 */
      if (pinned && (!hasBound || pinned.apps.indexOf(app) >= 0)) return pinned;
    }
    list.sort(function (a, b) {
      /* 显式绑定给这个 App 的 Key 优先，其次才比空闲度 */
      var aa = (a.apps.length && a.apps.indexOf(app) >= 0) ? 0 : 1;
      var ab = (b.apps.length && b.apps.indexOf(app) >= 0) ? 0 : 1;
      if (aa !== ab) return aa - ab;
      var sa = loadScore(a), sb = loadScore(b);
      if (sa !== sb) return sa - sb;
      var ia = runtimeOf(a.id).inflight, ib = runtimeOf(b.id).inflight;
      if (ia !== ib) return ia - ib;
      var la = runtimeOf(a.id).lastAt, lb = runtimeOf(b.id).lastAt;
      if (la !== lb) return la - lb;
      return String(a.id).localeCompare(String(b.id));
    });
    var best = loadScore(list[0]);
    var bestRank = (list[0].apps.length && list[0].apps.indexOf(app) >= 0) ? 0 : 1;
    var bucket = list.filter(function (e) {
      var rank = (e.apps.length && e.apps.indexOf(app) >= 0) ? 0 : 1;
      return rank === bestRank && Math.abs(loadScore(e) - best) < 1e-9;
    });
    if (bucket.length > 1) {
      rr = (rr + 1) % bucket.length;
      return bucket[rr];
    }
    return list[0];
  }

  function releaseLease(lease, result) {
    if (!lease || lease.__released) return;
    lease.__released = true;
    var id = lease.conn && lease.conn.keyId;
    if (!id) return;
    var rt = runtimeOf(id);
    rt.inflight = Math.max(0, rt.inflight - 1);
    var ok = !!(result && result.ok);
    if (ok) {
      rt.ok++;
      rt.lastError = '';
      if (lease.app) affinity[lease.app] = id;
      return;
    }
    /* 用户主动停止 / 超时中止不算 Key 的锅，不记失败、不进入冷却 */
    if (result && result.abort) return;
    rt.fail++;
    var err = result && result.error;
    var text = typeof err === 'string' ? err : String((err && err.message) || '');
    rt.lastError = text.slice(0, 200);
    var m = text.match(/HTTP\s+(\d{3})/);
    var cool = COOLDOWN_FAIL;
    if (m) {
      var status = Number(m[1]);
      if (status === 429) cool = COOLDOWN_RATE;
      else if (status === 401 || status === 402 || status === 403) cool = COOLDOWN_AUTH;
    }
    rt.cooldownUntil = Math.max(rt.cooldownUntil, Date.now() + cool);
  }

  /* 取一条本次请求要用的凭据。
   * conn 传了就是「调用方已经选定来源」：只有本地连接才参与多 Key 路由，
   * 网关 / Ollama 这种单一来源原样返回 null，让调用方继续用自己的 conn。 */
  function acquire(opts) {
    opts = opts || {};
    var app = String(opts.app || 'unknown');
    var explicit = opts.conn || null;
    if (explicit && explicit.via && explicit.via !== 'local') return null;

    var fallbackModel = String((explicit && explicit.model) || opts.model || readConfigConn().model || '').trim();
    /* 显式指定本地连接时，即使登录了网关也要允许本地 Key 池参与；
       没显式指定才按「网关优先」的候选集走。 */
    var source = explicit
      ? allEntries().filter(function (e) { return e.id !== '__gateway__'; })
      : routableEntries();
    var list = source.filter(function (e) { return usable(e, app); });

    if (explicit) {
      var base = trimBase(explicit.base);
      list = list.filter(function (e) {
        return trimBase(e.base) === base && (!e.model || !fallbackModel || e.model === fallbackModel);
      });
    }
    if (!list.length) return null;

    var pick = choose(list, app);
    var model = String(pick.model || fallbackModel || '').trim();
    if (!model) return null;

    var rt = runtimeOf(pick.id);
    rt.inflight++;
    rt.lastAt = Date.now();

    var conn = {
      base: pick.base,
      key: pick.key,
      model: model,
      via: pick.via || 'local',
      keyId: pick.id,
      keyLabel: pick.label
    };
    var lease = { conn: conn, app: app, __released: false };
    lease.release = function (result) { releaseLease(lease, result); };
    return lease;
  }

  /* 非流式对话。返回原始 OpenAI JSON，调用方自己取 choices[0].message.content。 */
  function postChat(opts) {
    opts = opts || {};
    var app = String(opts.app || 'unknown');
    var lease = acquire({ app: app, conn: opts.conn || null, model: opts.model });
    var conn = (lease && lease.conn) || opts.conn || (typeof global.llmConn === 'function' ? global.llmConn() : null);
    if (!conn || !conn.base || !conn.key || !conn.model) {
      if (lease) lease.release({ ok: false, error: new Error('语言模型未配置') });
      return Promise.reject(new Error('语言模型未配置'));
    }
    var body = Object.assign({
      model: conn.model,
      messages: opts.messages || []
    }, opts.body || {});
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.max_tokens != null) body.max_tokens = opts.max_tokens;
    var url = trimBase(conn.base) + '/chat/completions';
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + conn.key };

    function readRelay() {
      var on = false;
      var el = document.getElementById('relayOn');
      if (el) on = !!el.checked;
      else {
        var v = String((function () { try { return localStorage.getItem('hf_relayOn') || ''; } catch (_) { return ''; } })()).toLowerCase();
        on = (v === '1' || v === 'true');
      }
      var base = '';
      var be = document.getElementById('relayUrl');
      if (be && be.value.trim()) base = be.value.trim();
      else {
        try { base = localStorage.getItem('hf_relayUrl') || ''; } catch (_) { base = ''; }
      }
      return { on: on, base: trimBase(base || 'http://127.0.0.1:8787') };
    }

    function rawFetch() {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, opts.timeoutMs || 180000);
      var payload = JSON.stringify(body);
      function done() { clearTimeout(timer); }
      return fetch(url, {
        method: 'POST',
        headers: headers,
        body: payload,
        signal: ctrl ? ctrl.signal : undefined
      }).catch(function (e) {
        /* 独立页（如 multiview.html）没有 config.js 的 apiFetch，也没有中转逻辑；
           直连被 CORS / 网络拦住时，按设置里的中转配置再试一次。 */
        if (e && e.name === 'AbortError') throw e;
        var relay = readRelay();
        if (!relay.on) throw e;
        var rh = Object.assign({}, headers, { 'X-Relay-Target': url });
        return fetch(relay.base + '/proxy', {
          method: 'POST',
          headers: rh,
          body: payload,
          signal: ctrl ? ctrl.signal : undefined
        });
      }).finally(done);
    }

    var p = (typeof global.apiFetch === 'function')
      ? global.apiFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }, opts.timeoutMs || 180000)
      : rawFetch();

    return p.then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + '：' + String(t || '').slice(0, 300));
        });
      }
      var ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/html') >= 0) {
        throw new Error('接口返回的是网页而不是 API 数据：通常是接口地址少了 /v1');
      }
      return res.json();
    }).then(function (data) {
      if (lease) lease.release({ ok: true });
      return data;
    }).catch(function (e) {
      if (lease) {
        lease.release({
          ok: false,
          error: e,
          abort: !!(e && (e.name === 'AbortError' || /超时/.test(String(e.message || ''))))
        });
      }
      throw e;
    });
  }

  /* 流式对话的高层封装：应用层只需要给 app 名，不用自己选 Key。 */
  function complete(opts) {
    opts = opts || {};
    var app = String(opts.app || 'unknown');
    var lease = acquire({ app: app, conn: opts.conn || null, model: opts.model });
    var conn = (lease && lease.conn) || opts.conn || (typeof global.llmConn === 'function' ? global.llmConn() : null);
    if (!conn || !conn.base || !conn.key || !conn.model) {
      if (lease) lease.release({ ok: false, error: new Error('语言模型未配置') });
      return Promise.reject(new Error('语言模型未配置'));
    }
    if (typeof global.llmStreamRequest !== 'function') {
      if (lease) lease.release({ ok: false, error: new Error('语言模型未就绪') });
      return Promise.reject(new Error('语言模型未就绪：请先在设置里配置接口'));
    }
    var reqOpts = Object.assign({}, opts.opts || {}, { conn: conn, app: app, _leased: true });
    return Promise.resolve()
      .then(function () { return global.llmStreamRequest(opts.sys || '', opts.messages || [], opts.onDelta, reqOpts); })
      .then(function (res) {
        if (lease) lease.release({ ok: true });
        return res;
      })
      .catch(function (e) {
        if (lease) lease.release({ ok: false, error: e, abort: !!(e && e.name === 'AbortError') });
        throw e;
      });
  }

  function stats() {
    return allEntries().map(function (e) {
      var rt = runtimeOf(e.id);
      return {
        id: e.id,
        label: e.label,
        base: e.base,
        key: maskKey(e.key),
        model: e.model,
        apps: e.apps.slice(),
        enabled: e.enabled,
        via: e.via || 'local',
        maxConcurrent: e.maxConcurrent,
        inflight: rt.inflight,
        cooldownLeft: Math.max(0, rt.cooldownUntil - Date.now()),
        ok: rt.ok,
        fail: rt.fail,
        lastAt: rt.lastAt,
        lastError: rt.lastError
      };
    });
  }

  function add(entry) {
    var list = readExtras();
    var e = sanitize(entry);
    if (!e.base || !e.key) throw new Error('新增 Key 需要 base 和 key');
    list.push(e);
    writeExtras(list);
    return e;
  }

  function update(id, patch) {
    var list = readExtras();
    var found = null;
    list = list.map(function (raw) {
      if (raw.id !== id) return raw;
      found = sanitize(Object.assign({}, raw, patch || {}, { id: id }));
      return found;
    });
    if (!found) throw new Error('找不到 Key：' + id);
    writeExtras(list);
    return found;
  }

  function remove(id) {
    var list = readExtras().filter(function (e) { return e.id !== id; });
    writeExtras(list);
    delete runtime[id];
    Object.keys(affinity).forEach(function (app) {
      if (affinity[app] === id) delete affinity[app];
    });
    return true;
  }

  function setEnabled(id, on) {
    return update(id, { enabled: !!on });
  }

  function resetStats() {
    Object.keys(runtime).forEach(function (id) { delete runtime[id]; });
    Object.keys(affinity).forEach(function (app) { delete affinity[app]; });
  }

  global.LLMRouter = {
    acquire: acquire,
    complete: complete,
    postChat: postChat,
    stats: stats,
    add: add,
    update: update,
    remove: remove,
    setEnabled: setEnabled,
    resetStats: resetStats,
    extras: readExtras
  };
})(window);
