/* ============================================================
 * 设置 · 总览页 + 左侧状态点
 *
 * 为什么需要这一页：
 *   设置项散在 6 个 tab 里，用户打开设置第一眼看到的是「API Key」输入框，
 *   但真正要先回答的问题是「我现在什么能用、什么还没配」。所以先给一张
 *   状态表，点卡片直达对应分组。
 *
 * 三条原则：
 *   ① 状态只读现有真值（输入框、rtHealth、cfState、gwSession、relayEnabled），
 *      **不另存一份状态**——存一份必然和界面显示的对不上。
 *   ② 判定要保守：缺一样就降级成 warn，别在没验证的情况下打绿点。
 *   ③ 不引第三方图标库，跟导航同一套 SVG 语言。
 * ============================================================ */
(function () {
  'use strict';

  var ICO = {
    llm: '<path d="M4 5h16v10H9l-5 4V5Z"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="14" rx="2.5"/><circle cx="8.6" cy="9.6" r="1.4"/><path d="m4.5 16.5 4.6-4 3.4 2.7 3-2.2 4 3.5"/>',
    search: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/>',
    relay: '<path d="M4 8h11l-3-3M20 16H9l3 3"/>',
    account: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    assets: '<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/><path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>'
  };

  function $(id) { return document.getElementById(id); }

  function val(id) {
    var el = $(id);
    return el ? String(el.value == null ? '' : el.value).trim() : '';
  }

  function hostOf(u) {
    var s = String(u || '').trim();
    if (!s) return '默认地址';
    try { return new URL(s).host || s; } catch (e) { return s.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''); }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isLocalImg() {
    var m = '';
    try { m = localStorage.getItem('mc_scope_image') || ''; } catch (e) { m = ''; }
    return m === 'local';
  }

  /* ---------------- 六张卡的真值判定 ---------------- */

  function cardLlm() {
    var key = val('llmKey'), model = val('llmModel'), base = val('llmBaseUrl');
    var st = key && model ? 'ok' : (key || model ? 'warn' : 'off');
    return {
      key: 'llm', name: '语言模型', ico: 'llm', state: st,
      value: model
        ? esc(model) + ' · ' + esc(hostOf(base))
        : (key ? '已填 Key，还没选模型' : '未配置：填 Key 后读取模型')
    };
  }

  function cardImage() {
    var eng = val('genEngine') || 'openai';
    if (eng === 'tripo') {
      var tk = val('tripoKey');
      return {
        key: 'image', name: '图像生成', ico: 'image', state: tk ? 'ok' : 'off',
        value: tk ? 'Tripo API · ' + esc(hostOf('' + (val('tripoVersion') || ''))) : 'Tripo 引擎，还没填 API Key'
      };
    }
    if (eng === 'tripo-web') {
      var ready = (typeof tripoWebReady !== 'undefined') && tripoWebReady;
      return {
        key: 'image', name: '图像生成', ico: 'image', state: ready ? 'ok' : 'warn',
        value: ready ? 'Tripo 网页账号 · 已连接' : 'Tripo 网页账号 · 未登录'
      };
    }
    if (isLocalImg()) {
      var comfyOk = !!(typeof rtHealth === 'object' && rtHealth && rtHealth.comfy && rtHealth.comfy.ok);
      return {
        key: 'image', name: '图像生成', ico: 'image', state: comfyOk ? 'ok' : 'bad',
        value: comfyOk ? '本地 ComfyUI · 引擎在跑' : '本地 ComfyUI · 引擎没在跑'
      };
    }
    var k = val('imgKey') || val('llmKey');
    var m = val('imgModel') || val('llmModel');
    var b = val('imgBaseUrl') || val('llmBaseUrl');
    return {
      key: 'image', name: '图像生成', ico: 'image',
      state: k && m ? 'ok' : (k || m ? 'warn' : 'off'),
      value: m ? esc(m) + ' · ' + esc(hostOf(b)) : '在线接口，还没选生图模型'
    };
  }

  function cardSearch() {
    var p = val('wsProvider') || 'ddg';
    if (p === 'tavily') {
      var has = !!val('wsKey');
      return {
        key: 'search', name: '联网搜索', ico: 'search', state: has ? 'ok' : 'off',
        value: has ? 'Tavily · 已填 Key' : 'Tavily · 还没填 Key'
      };
    }
    if (p === 'searxng') {
      var base = val('wsBase');
      return {
        key: 'search', name: '联网搜索', ico: 'search', state: base ? 'ok' : 'warn',
        value: base ? 'SearXNG · ' + esc(hostOf(base)) : 'SearXNG · 还没填实例地址'
      };
    }
    return { key: 'search', name: '联网搜索', ico: 'search', state: 'warn', value: 'DuckDuckGo · 免 Key，可能被反爬页挡住' };
  }

  function cardRelay() {
    var on = (typeof relayEnabled === 'function') && relayEnabled();
    var base = (typeof relayBase === 'function') ? relayBase() : '';
    return {
      key: 'relay', name: '本地中转', ico: 'relay',
      /* 启用≠可用：没点过测试就不知道服务在不在，所以启用只给 warn */
      state: on ? 'warn' : 'off',
      value: on ? esc(hostOf(base)) + ' · 已启用（未验证）' : '未启用，跨域服务商会失败'
    };
  }

  function cardAccount() {
    var sess = (typeof gwSession !== 'undefined') ? gwSession : null;
    var who = sess && (sess.user && (sess.user.email || sess.user.name) || sess.email);
    return {
      key: 'account', name: '账号', ico: 'account',
      state: sess ? 'ok' : 'off',
      value: sess ? '已登录 · ' + esc(who || '云端账号') : '未登录，用自己填的 Key'
    };
  }

  function cardAssets() {
    return {
      key: 'assets', name: '存储与数据', ico: 'assets', state: 'off',
      value: '正在统计占用…', asyncTick: true
    };
  }

  function cards() {
    return [cardLlm(), cardImage(), cardSearch(), cardRelay(), cardAccount(), cardAssets()];
  }

  /* ---------------- 渲染 ---------------- */

  function cardHtml(c) {
    return '<button type="button" class="set-card ' + c.state + '" data-set-go="' + esc(c.key) + '">' +
      '<span class="set-card-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[c.ico] || ICO.llm) + '</svg></span>' +
      '<span class="set-card-main">' +
        '<span class="set-card-t">' + esc(c.name) + '<span class="set-dot ' + c.state + '"></span></span>' +
        '<span class="set-card-v" data-card-v="' + esc(c.key) + '">' + c.value + '</span>' +
      '</span>' +
    '</button>';
  }

  function renderHome() {
    var box = $('setHomeGrid');
    if (!box) return;
    var list = cards();
    box.innerHTML = list.map(cardHtml).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-set-go]'), function (b) {
      b.addEventListener('click', function () {
        if (typeof switchTab === 'function') switchTab(b.dataset.setGo);
      });
    });
    fillAssets();
  }

  /* 占用走异步且**只查一次**：assetStat() 是 IPC，
   * 每敲一个键就重查一遍是没必要的开销，而且会让卡片文字闪烁。 */
  var assetsInfo = null;

  async function fillAssets() {
    var el = document.querySelector('[data-card-v="assets"]');
    if (!el) return;
    if (assetsInfo) { applyAssets(el, assetsInfo); return; }
    var d = window.openagiDesktop;
    if (!d || typeof d.assetStat !== 'function') {
      el.textContent = '浏览器模式：资产不落盘';
      return;
    }
    try {
      assetsInfo = await d.assetStat();
      if (!el.isConnected) return;
      applyAssets(el, assetsInfo);
    } catch (e) {
      el.textContent = '统计失败：' + ((e && e.message) || e);
    }
  }

  function applyAssets(el, s) {
    el.textContent = fmtBytes(s.totalBytes) + ' · ' + (s.count || 0) + ' 个资产';
    var card = el.closest('.set-card');
    var st = (s.count || 0) ? 'ok' : 'off';
    if (card) {
      card.classList.remove('off', 'warn', 'bad', 'ok');
      card.classList.add(st);
      var dot = card.querySelector('.set-dot');
      if (dot) dot.className = 'set-dot ' + st;
    }
  }

  function fmtBytes(b) {
    var n = Number(b) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function renderDots() {
    var list = cards();
    var map = {};
    list.forEach(function (c) { map[c.key] = c.state; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-dot]'), function (d) {
      var s = map[d.dataset.dot] || 'off';
      d.className = 'set-dot ' + s;
    });
  }

  function renderPaths() {
    var el = $('setHomePaths');
    if (!el) return;
    var d = window.openagiDesktop;
    var lines = [];
    lines.push('配置与 Key：浏览器 localStorage（键名 <code class="relay-code">hf_*</code>）');
    if (d && typeof d.assetStat === 'function') {
      lines.push('资产与模型：应用用户数据目录下的 <code class="relay-code">assets/</code>、<code class="relay-code">media/</code>');
    } else {
      lines.push('浏览器模式：资产不落盘，只会存在内存里');
    }
    el.innerHTML = lines.join('<br>');
  }

  /* 设置页不再摆 Key / 地址输入框之后，「现在接的是哪个站」只能靠这两行看。
   * 只读值来自隐藏 input（对话条的配置弹层写的就是它们），所以永远和真值一致。 */
  function fillHostRows() {
    var llm = $('setLlmHost');
    if (llm) {
      var base = val('llmBaseUrl');
      var model = val('llmModel');
      if (!base && !model) llm.textContent = '还没配置';
      else llm.textContent = hostOf(base) + (model ? ' · ' + model : ' · 未选模型');
    }
    var img = $('setImgHost');
    if (img) {
      var ib = val('imgBaseUrl');
      var im = val('imgModel');
      if (ib) img.textContent = hostOf(ib) + (im ? ' · ' + im : '');
      else if (val('llmBaseUrl')) img.textContent = '复用分析侧 · ' + hostOf(val('llmBaseUrl'));
      else img.textContent = '还没配置';
    }
  }

  /* 「去配置」：直接把对话输入条的配置弹层拉起来。
   * 为什么不做成跳转：那套弹层是挂在 body 上的，不依赖对话窗口是否打开，
   * 从设置里点开就能配，配完 dispatch 的 input 事件会把这里的状态一并刷新。 */
  function bindCfgButtons() {
    var llm = $('setLlmCfg');
    if (llm && !llm.dataset.bound) {
      llm.dataset.bound = '1';
      llm.addEventListener('click', function () {
        var d = window.deskChat;
        if (d && d.modelCfg && typeof d.modelCfg.open === 'function') d.modelCfg.open();
        else if (typeof openSettings === 'function') { /* 老版本没有对外接口，退回不动 */ }
      });
    }
    var img = $('setImgCfg');
    if (img && !img.dataset.bound) {
      img.dataset.bound = '1';
      img.addEventListener('click', function () {
        var d = window.deskChat;
        if (d && d.imgCfg && typeof d.imgCfg.open === 'function') d.imgCfg.open();
      });
    }
  }

  function refresh() {
    if (!document.getElementById('setHomeGrid')) return;
    renderHome();
    renderDots();
    renderPaths();
    fillHostRows();
    bindCfgButtons();
  }

  window.settingsHome = { refresh: refresh };

  /* 输入变化后状态就可能变。用委托而不是逐个绑定：
   * config.js 已经给每个字段绑了保存，这里再绑一遍容易重复注册。
   * 只刷小圆点与卡片文字，不动输入框本身——重渲 Home 会打断正在输入的人。 */
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (!document.getElementById('settingsBackdrop')) return;
    if (document.getElementById('settingsBackdrop').classList.contains('hidden')) return;
    refresh();
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (!document.getElementById('settingsBackdrop')) return;
    if (document.getElementById('settingsBackdrop').classList.contains('hidden')) return;
    refresh();
  }, true);

  window.addEventListener('engines-status', function () {
    if (document.getElementById('settingsBackdrop') &&
        !document.getElementById('settingsBackdrop').classList.contains('hidden')) refresh();
  });
})();
