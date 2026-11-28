/* Tripo 工坊 —— 生图 / 生模型 / 纹理 / 拉回结果。
 *
 * 生成链路刻意复用工作流里已有的两个 Tripo 网页节点实现：
 *   wfTripoWebImage(prompt, images, opts)   ← node-defs 的 tripoImg
 *   wfTripoWebModel(image, opts)            ← node-defs 的 tripoModel / tripoModelMulti
 * 这样 App 与工作流共用同一套请求体、超时、中断和错误文案，不再各写一份。
 *
 * 所有渲染逻辑包在 IIFE 内；对外的唯一调试入口是 window.TripStudio。
 */
(function () {
  'use strict';

  var APP_ID = 'tripostudio';
  var LS_KEY = 'hf_tripoStudioProj';
  var MAX_ASSETS = 120;
  var MAX_MODEL_THUMBS = 24;
  var IMAGE_REF_KEYS = ['image:0', 'image:1', 'image:2'];
  var MODEL_REF_KEYS = ['model:single', 'model:front', 'model:left', 'model:right', 'model:back'];
  var MODEL_EXT_RE = /\.(glb|gltf|obj|fbx|stl)(?:$|[?#])/i;
  /* 内嵌视图地址：openagi_embed=1 是给助手认领 guest 的标记（浏览器 App 里手动打开的
     Tripo 页没有这个参数），站点就算把它丢掉，助手也会退回按 studio 域名匹配。 */
  var TPS_EMBED_URL = 'https://studio.tripo3d.com/?openagi_embed=1';

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function uid(prefix) {
    return (prefix || 'a') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function basename(url) {
    var s = String(url || '').split(/[?#]/)[0];
    try { return decodeURIComponent(s.split('/').pop() || ''); } catch (e) { return s.split('/').pop() || ''; }
  }
  function extOf(url) {
    var m = String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }
  function guessKind(url) {
    return MODEL_EXT_RE.test(String(url || '')) ? 'model' : 'image';
  }
  function kindLabel(kind) {
    return kind === 'model' ? '模型' : (kind === 'texture' ? '纹理' : '图像');
  }
  function bust(url) {
    if (!/^https?:/i.test(url || '')) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtDur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? (s + ' 秒') : (Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒');
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function errMsg(e) {
    return String((e && e.message) || e || '未知错误');
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function defaultState() {
    return {
      v: 1,
      panel: 'image',
      selId: '',
      assets: [],
      image: { prompt: '', mode: 'auto', ratio: '1:1', timeout: 240 },
      model: { mode: 'smart', version: 'P2.0', topology: '', faceCount: 0, count: 1, format: '', timeout: 420, multi: false },
      tex: { prompt: '', tile: 2, roughness: 0.62, metalness: 0, fromModel: true, timeout: 240 },
      stage: { grid: true, rotate: false, mat: 'texture', bg: 'studio' },
      conn: { state: 'checking', text: '检测助手…', ready: false, modelReady: false, running: false, title: '', mode: 'none', embedded: false }
    };
  }

  function getPath(obj, path) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return '';
      cur = cur[parts[i]];
    }
    return cur;
  }
  function setPath(obj, path, val) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }

  function copyText(text) {
    if (!text) { toast('没有可复制的内容', 'warn'); return; }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('已复制');
      } catch (e) { toast('复制失败', 'err'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, fallback);
    } else fallback();
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name || 'download.bin';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function dataURLToBlob(dataUrl) {
    var parts = String(dataUrl).split(',');
    var m = /data:([^;]+);base64/.exec(parts[0] || '');
    var mime = m ? m[1] : 'application/octet-stream';
    var bin = atob(parts[1] || '');
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function fileToDataURL(file, limitMB) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有文件')); return; }
      var limit = (limitMB || 24) * 1024 * 1024;
      if (file.size > limit) { reject(new Error('文件超过 ' + (limitMB || 24) + ' MB 上限')); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  function packLocal(dataUrl) {
    if (typeof blobPack === 'function') {
      try { return blobPack(dataUrl); } catch (e) { /* 落到 data URL */ }
    }
    return dataUrl;
  }

  function isStub(url) {
    return typeof url === 'string' && /^blob:/.test(url);
  }

  async function resolveUrl(url) {
    if (!url) throw new Error('资源地址为空');
    if (!isStub(url)) return url;
    if (typeof blobResolveAsync !== 'function') throw new Error('本地资产库未加载');
    var v = await blobResolveAsync(url);
    if (!v || v === url) throw new Error('本地资产已丢失');
    return v;
  }

  async function fetchBlobByUrl(url) {
    if (/^data:/i.test(url)) return dataURLToBlob(url);
    var init = { cache: 'no-store' };
    var req = (typeof apiRequest === 'function') ? apiRequest(url, init) : { url: url, init: init };
    var timer = null;
    var ctrl = new AbortController();
    timer = setTimeout(function () { ctrl.abort(); }, 60000);
    try {
      var res = await fetch(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  function bridgeBase() {
    try { if (typeof TRIPO_WEB_BASE !== 'undefined' && TRIPO_WEB_BASE) return TRIPO_WEB_BASE; } catch (e) { /* ignore */ }
    return 'http://127.0.0.1:8790';
  }

  function bridgeFetch(path, opts, timeoutMs) {
    if (typeof tripoWebFetch === 'function') return tripoWebFetch(path, opts, timeoutMs);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000);
    return fetch(bridgeBase() + path, Object.assign({ signal: ctrl.signal }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { if (!r.ok) throw new Error((d && d.message) || ('HTTP ' + r.status)); return d || {}; }); })
      .finally(function () { clearTimeout(timer); });
  }

  /* ------------------------------------------------------------------ *
   * 运行时状态（不持久化）
   * ------------------------------------------------------------------ */
  var S = defaultState();
  var RT = {
    imgRefs: [null, null, null],
    modelRefs: { single: null, front: null, left: null, right: null, back: null },
    fileTarget: '',
    busyCtrl: null,
    busyTimer: 0,
    statusTimer: 0,
    toastTimer: 0,
    saveTimer: 0,
    logs: [],
    filter: 'all',
    resolved: {},
    thumbs: {},
    thumbMiss: {},
    thumbQueued: {},
    thumbQueue: [],
    thumbBusy: false,
    lastModelId: '',
    loadedModelId: '',
    showToken: 0,
    /* 内嵌 Tripo 网页。supported = 桌面外壳；bridge = 助手报告支持内嵌（CDP 端口已开）。
       只有两者同时成立才会显示「内嵌」按钮；否则所有流程保持原来的外部 Edge 逻辑。 */
    embed: { supported: false, bridge: false, on: false, ready: false, wv: null }
  };
  var E = {};
  var viewport2d = null;
  var viewport3d = null;

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */
  function loadState() {
    var s = defaultState();
    var parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { parsed = null; }
    if (parsed && parsed.v === 1) {
      if (parsed.panel) s.panel = parsed.panel;
      if (parsed.selId) s.selId = parsed.selId;
      ['image', 'model', 'tex'].forEach(function (k) {
        if (parsed[k] && typeof parsed[k] === 'object') {
          Object.keys(s[k]).forEach(function (f) {
            if (parsed[k][f] !== undefined && parsed[k][f] !== null) s[k][f] = parsed[k][f];
          });
        }
      });
      if (parsed.stage && typeof parsed.stage === 'object') {
        Object.keys(s.stage).forEach(function (f) {
          if (parsed.stage[f] !== undefined && parsed.stage[f] !== null) s.stage[f] = parsed.stage[f];
        });
      }
      if (Array.isArray(parsed.assets)) {
        s.assets = parsed.assets.filter(function (a) {
          return a && typeof a.url === 'string' && /^(https?:|data:|blob:)/.test(a.url);
        }).slice(0, MAX_ASSETS).map(function (a, i) {
          return {
            id: a.id || ('a' + i),
            kind: a.kind === 'model' || a.kind === 'texture' ? a.kind : 'image',
            url: a.url,
            file: a.file || '',
            name: a.name || a.file || basename(a.url),
            prompt: a.prompt || '',
            ts: Number(a.ts) || Date.now(),
            pulled: a.pulled !== false,
            meta: a.meta && typeof a.meta === 'object' ? a.meta : {}
          };
        });
      }
    }
    // 数值兜底
    s.image.timeout = clamp(Number(s.image.timeout) || 240, 10, 900);
    s.model.timeout = clamp(Number(s.model.timeout) || 420, 30, 1800);
    s.model.faceCount = clamp(Number(s.model.faceCount) || 0, 0, 25000);
    s.model.count = [1, 2, 4].indexOf(Number(s.model.count)) >= 0 ? Number(s.model.count) : 1;
    s.tex.timeout = clamp(Number(s.tex.timeout) || 240, 10, 900);
    s.tex.tile = clamp(Number(s.tex.tile) || 1, 1, 8);
    s.tex.roughness = clamp(Number(s.tex.roughness) || 0, 0, 1);
    s.tex.metalness = clamp(Number(s.tex.metalness) || 0, 0, 1);
    if (['image', 'model', 'texture', 'assets'].indexOf(s.panel) < 0) s.panel = 'image';
    if (['texture', 'clay', 'wire'].indexOf(s.stage.mat) < 0) s.stage.mat = 'texture';
    if (['studio', 'dark', 'light'].indexOf(s.stage.bg) < 0) s.stage.bg = 'studio';
    S = s;
  }

  function saveNow() {
    clearTimeout(RT.saveTimer);
    RT.saveTimer = 0;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        v: 1,
        panel: S.panel,
        selId: S.selId,
        assets: S.assets,
        image: S.image,
        model: S.model,
        tex: S.tex,
        stage: S.stage
      }));
    } catch (e) {
      log('项目保存失败：' + errMsg(e), 'warn');
    }
  }
  function saveSoon() {
    clearTimeout(RT.saveTimer);
    RT.saveTimer = setTimeout(saveNow, 300);
  }

  /* ------------------------------------------------------------------ *
   * 元素
   * ------------------------------------------------------------------ */
  function bindEls(body) {
    E.body = body;
    E.app = $('.tps-app', body);
    E.conn = $('[data-role="conn"]', body);
    E.connText = $('[data-role="connText"]', body);
    E.menus = $('[data-role="menus"]', body);
    E.side = $('[data-role="side"]', body);
    E.stageTitle = $('[data-role="stageTitle"]', body);
    E.tools2d = $('[data-role="tools2d"]', body);
    E.tools3d = $('[data-role="tools3d"]', body);
    E.zoomText = $('[data-role="zoomText"]', body);
    E.busy = $('[data-role="busy"]', body);
    E.busyText = $('[data-role="busyText"]', body);
    E.viewport = $('[data-role="viewport"]', body);
    E.imgStage = $('[data-role="imgStage"]', body);
    E.imgTile = $('[data-role="imgTile"]', body);
    E.img = $('[data-role="img"]', body);
    E.empty = $('[data-role="empty"]', body);
    E.grid2d = $('[data-role="grid2d"]', body);
    E.scene3d = $('[data-role="scene3d"]', body);
    E.host3d = $('[data-role="host3d"]', body);
    E.missing = $('[data-role="missing"]', body);
    E.missingText = $('[data-role="missingText"]', body);
    E.dropmask = $('[data-role="dropmask"]', body);
    E.assetMeta = $('[data-role="assetMeta"]', body);
    E.stageHint = $('[data-role="stageHint"]', body);
    E.info = $('[data-role="info"]', body);
    E.queue = $('[data-role="queue"]', body);
    E.log = $('[data-role="log"]', body);
    E.strip = $('[data-role="strip"]', body);
    E.assetCount = $('[data-role="assetCount"]', body);
    E.assetList = $('[data-role="assetList"]', body);
    E.assetFilters = $('[data-role="assetFilters"]', body);
    E.statusMain = $('[data-role="statusMain"]', body);
    E.statusConn = $('[data-role="statusConn"]', body);
    E.statusCount = $('[data-role="statusCount"]', body);
    E.texSec = $('[data-role="texSec"]', body);
    E.dialog = $('[data-role="dialog"]', body);
    E.pullUrl = $('[data-role="pullUrl"]', body);
    E.pullKind = $('[data-role="pullKind"]', body);
    E.pullAsTexture = $('[data-role="pullAsTexture"]', body);
    E.fileImage = $('[data-role="fileImage"]', body);
    E.fileModel = $('[data-role="fileModel"]', body);
    E.fileTexture = $('[data-role="fileTexture"]', body);
    E.toast = $('[data-role="toast"]', body);
    E.camPreset = $('[data-role="camPreset"]', body);
    E.matSeg = $('[data-role="matSeg"]', body);
    E.modelSeg = $('[data-role="modelSeg"]', body);
    E.modelSingle = $('[data-role="modelSingle"]', body);
    E.modelMulti = $('[data-role="modelMulti"]', body);
    E.imgPromptCount = $('[data-role="imgPromptCount"]', body);
    E.texPromptCount = $('[data-role="texPromptCount"]', body);
    E.inspect = $('[data-role="inspect"]', body);
    E.embed = $('[data-role="embed"]', body);
    E.embedBtn = $('[data-role="embedBtn"]', body);
    E.embedHost = $('[data-role="embedHost"]', body);
    E.embedState = $('[data-role="embedState"]', body);
    E.embedNote = $('[data-role="embedNote"]', body);
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  function currentAsset() {
    if (!S.selId) return null;
    return findAsset(S.selId);
  }
  function findAsset(id) {
    for (var i = 0; i < S.assets.length; i++) if (S.assets[i].id === id) return S.assets[i];
    return null;
  }
  function currentModelAsset() {
    var a = currentAsset();
    if (a && a.kind === 'model') return a;
    if (RT.lastModelId) {
      var m = findAsset(RT.lastModelId);
      if (m && m.kind === 'model') return m;
    }
    return null;
  }
  function displayName(a) {
    return a.name || a.file || basename(a.url) || (kindLabel(a.kind) + '资源');
  }

  function setConn(state, text, extra) {
    S.conn = Object.assign({ state: state, text: text, ready: false, modelReady: false, running: false, title: '' }, extra || {});
    if (E.conn) {
      E.conn.dataset.state = state;
      E.connText.textContent = text;
    }
    if (E.statusConn) E.statusConn.textContent = text;
  }

  function renderConn() {
    var c = S.conn;
    if (!E.conn) return;
    var state = c.state || 'off';
    E.conn.dataset.state = state;
    var text;
    var where = c.mode === 'embedded' ? '内嵌' : '浏览器';
    if (state === 'checking') text = '检测助手…';
    else if (state === 'off') text = c.embedded ? '内嵌网页未连接' : '助手未启动';
    else if (c.ready) text = '已连接 · ' + where + '生图页就绪';
    else if (c.modelReady) text = '已连接 · ' + where + '生成页就绪';
    else text = where + '已打开 · 请登录';
    E.connText.textContent = text;
    E.statusConn.textContent = text;
  }

  function renderPromptCounts() {
    if (E.imgPromptCount) E.imgPromptCount.textContent = (S.image.prompt || '').length + ' / 1200';
    if (E.texPromptCount) E.texPromptCount.textContent = (S.tex.prompt || '').length + ' / 800';
  }

  function renderTexOutputs() {
    $$('[data-role="texTileOut"],[data-role="texTileOut2"]').forEach(function (o) { o.textContent = String(S.tex.tile); });
    $$('[data-role="texRoughOut"],[data-role="texRoughOut2"]').forEach(function (o) { o.textContent = Number(S.tex.roughness).toFixed(2); });
    $$('[data-role="texMetalOut"],[data-role="texMetalOut2"]').forEach(function (o) { o.textContent = Number(S.tex.metalness).toFixed(2); });
  }

  function syncForms() {
    $$('[data-form]').forEach(function (el) {
      var path = el.getAttribute('data-form');
      var v = getPath(S, path);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'number') el.value = v === '' || v == null ? '' : Number(v);
      else el.value = v == null ? '' : v;
    });
    renderPromptCounts();
    renderTexOutputs();
  }

  function renderModelMode() {
    if (!E.modelSeg) return;
    $$('button[data-mmode]', E.modelSeg).forEach(function (b) {
      b.classList.toggle('is-on', (b.getAttribute('data-mmode') === 'multi') === !!S.model.multi);
    });
    E.modelSingle.classList.toggle('hidden', !!S.model.multi);
    E.modelMulti.classList.toggle('hidden', !S.model.multi);
  }

  function renderStageTools() {
    var mode = E.app.getAttribute('data-stage');
    var model = mode === 'model';
    // 空舞台也归 2D：没有资源时工具栏消失会显得窗口是空的
    E.tools2d.classList.toggle('hidden', model);
    E.tools3d.classList.toggle('hidden', !model);
    $$('[data-toggle="grid"]').forEach(function (b) { b.classList.toggle('is-on', !!S.stage.grid); });
    $$('[data-toggle="rotate"]').forEach(function (b) { b.classList.toggle('is-on', !!S.stage.rotate); });
    if (E.matSeg) {
      $$('button[data-mat]', E.matSeg).forEach(function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-mat') === S.stage.mat);
      });
    }
    if (E.camPreset) E.camPreset.value = S.stage.cam || 'persp';
    E.scene3d.classList.remove('tps-bg-studio', 'tps-bg-dark', 'tps-bg-light');
    E.scene3d.classList.add('tps-bg-' + (S.stage.bg || 'studio'));
  }

  function setStageMode(mode) {
    E.app.setAttribute('data-stage', mode);
    var model = mode === 'model';
    E.imgStage.classList.toggle('hidden', model);
    E.scene3d.classList.toggle('hidden', !model);
    E.tools2d.classList.toggle('hidden', model);
    E.tools3d.classList.toggle('hidden', !model);
    if (model && viewport3d) viewport3d.resize();
    renderStageTools();
  }

  function renderRefs() {
    $$('.tps-ref').forEach(function (slot) {
      var key = slot.getAttribute('data-ref');
      var v = refGet(key);
      slot.classList.toggle('has', !!v);
      var img = $('img', slot);
      if (!img) return;
      if (v) {
        if (img.getAttribute('src') !== v) img.src = v;
      } else {
        img.removeAttribute('src');
      }
    });
  }

  function renderCounts() {
    if (E.assetCount) E.assetCount.textContent = String(S.assets.length);
    if (E.statusCount) E.statusCount.textContent = S.assets.length + ' 个资源';
  }

  function makeChip(kind) {
    var span = document.createElement('span');
    span.className = 'tps-card-kind';
    span.setAttribute('data-kind', kind);
    span.textContent = kind === 'model' ? '3D' : (kind === 'texture' ? 'TEX' : 'IMG');
    return span;
  }

  function makeCard(a) {
    var card = document.createElement('div');
    card.className = 'tps-card' + (a.id === S.selId ? ' is-on' : '') + (a.meta && a.meta.missing ? ' is-missing' : '');
    card.setAttribute('data-asset-id', a.id);
    card.title = displayName(a);

    var thumb = document.createElement('div');
    thumb.className = 'tps-card-thumb';
    thumb.setAttribute('data-thumb-id', a.id);
    if (a.kind === 'model') {
      var cached = RT.thumbs[a.url];
      if (cached) {
        var im = document.createElement('img');
        im.src = cached;
        im.alt = '';
        thumb.appendChild(im);
      } else {
        thumb.textContent = '3D';
        enqueueThumb(a);
      }
    } else {
      var im2 = document.createElement('img');
      im2.alt = '';
      thumb.appendChild(im2);
      paintAssetThumb(a, im2);
    }
    card.appendChild(thumb);

    var label = document.createElement('div');
    label.className = 'tps-card-label';
    label.appendChild(makeChip(a.kind));
    var txt = document.createElement('span');
    txt.textContent = truncate(displayName(a), 22);
    label.appendChild(txt);
    card.appendChild(label);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'tps-card-del';
    del.setAttribute('data-del', a.id);
    del.title = '删除';
    del.textContent = '×';
    card.appendChild(del);

    return card;
  }

  function renderStrip() {
    if (!E.strip) return;
    E.strip.textContent = '';
    if (!S.assets.length) {
      var empty = document.createElement('div');
      empty.className = 'tps-strip-empty';
      empty.textContent = '还没有资源 · 生成结果会自动出现在这里';
      E.strip.appendChild(empty);
    } else {
      S.assets.forEach(function (a) { E.strip.appendChild(makeCard(a)); });
    }
    renderCounts();
  }

  function paintAssetThumb(a, imgEl) {
    if (!imgEl) return;
    resolveUrl(a.url).then(function (src) {
      if (imgEl.isConnected) imgEl.src = bust(src);
    }).catch(function () {
      if (imgEl.isConnected) imgEl.removeAttribute('src');
    });
  }

  function paintThumbById(id) {
    var a = findAsset(id);
    if (!a) return;
    var cardThumb = E.strip && $('[data-thumb-id="' + id + '"]', E.strip);
    if (cardThumb) {
      cardThumb.textContent = '';
      var im = document.createElement('img');
      im.src = RT.thumbs[a.url];
      im.alt = '';
      cardThumb.appendChild(im);
    }
    var rowThumb = E.assetList && $('[data-thumb-row="' + id + '"]', E.assetList);
    if (rowThumb) {
      rowThumb.textContent = '';
      var im2 = document.createElement('img');
      im2.src = RT.thumbs[a.url];
      im2.alt = '';
      rowThumb.appendChild(im2);
    }
  }

  function enqueueThumb(a) {
    if (!a || a.kind !== 'model' || !a.url) return;
    if (RT.thumbs[a.url] || RT.thumbMiss[a.url] || RT.thumbQueued[a.url]) return;
    if (Object.keys(RT.thumbs).length >= MAX_MODEL_THUMBS) return;
    RT.thumbQueued[a.url] = true;
    RT.thumbQueue.push(a);
    pumpThumbs();
  }

  async function pumpThumbs() {
    if (RT.thumbBusy) return;
    RT.thumbBusy = true;
    while (RT.thumbQueue.length) {
      var a = RT.thumbQueue.shift();
      try {
        if (!window.Model3D || typeof window.Model3D.renderThumb !== 'function') break;
        var src = await resolveUrl(a.url);
        var r = await window.Model3D.renderThumb(src, { size: 160 });
        RT.thumbs[a.url] = r.dataURL;
        delete RT.thumbQueued[a.url];
        paintThumbById(a.id);
      } catch (e) {
        RT.thumbMiss[a.url] = true;
        delete RT.thumbQueued[a.url];
      }
    }
    RT.thumbBusy = false;
  }

  function renderAssetList() {
    if (!E.assetList) return;
    E.assetList.textContent = '';
    var list = S.assets.filter(function (a) { return RT.filter === 'all' || a.kind === RT.filter; });
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'tps-assetempty';
      empty.textContent = RT.filter === 'all' ? '项目里还没有资源' : ('还没有' + kindLabel(RT.filter) + '资源');
      E.assetList.appendChild(empty);
      return;
    }
    list.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'tps-assetrow' + (a.id === S.selId ? ' is-on' : '') + (a.meta && a.meta.missing ? ' is-missing' : '');
      row.setAttribute('data-asset-row', a.id);

      var thumb = document.createElement('div');
      thumb.className = 'tps-assetrow-thumb';
      thumb.setAttribute('data-thumb-row', a.id);
      if (a.kind === 'model') {
        if (RT.thumbs[a.url]) {
          var im = document.createElement('img');
          im.src = RT.thumbs[a.url];
          im.alt = '';
          thumb.appendChild(im);
        } else {
          thumb.textContent = '3D';
          enqueueThumb(a);
        }
      } else {
        var im2 = document.createElement('img');
        im2.alt = '';
        thumb.appendChild(im2);
        paintAssetThumb(a, im2);
      }
      row.appendChild(thumb);

      var main = document.createElement('div');
      main.className = 'tps-assetrow-main';
      var b = document.createElement('b');
      b.textContent = displayName(a);
      var small = document.createElement('small');
      small.textContent = kindLabel(a.kind) + ' · ' + fmtTime(a.ts) + (a.meta && a.meta.missing ? ' · 不可用' : '');
      main.appendChild(b);
      main.appendChild(small);
      row.appendChild(main);

      E.assetList.appendChild(row);
    });
  }

  function renderFilters() {
    if (!E.assetFilters) return;
    $$('button[data-filter]', E.assetFilters).forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-filter') === RT.filter);
    });
  }

  function addInfoRow(dt, dd) {
    var d1 = document.createElement('dt');
    d1.textContent = dt;
    var d2 = document.createElement('dd');
    d2.textContent = dd == null || dd === '' ? '—' : dd;
    E.info.appendChild(d1);
    E.info.appendChild(d2);
  }

  function renderInspector() {
    if (!E.info) return;
    var a = currentAsset();
    E.info.textContent = '';
    if (!a) {
      addInfoRow('资源', '未选择');
      addInfoRow('提示', '生成图像、模型或从外部拉回资源');
    } else {
      addInfoRow('类型', kindLabel(a.kind));
      addInfoRow('名称', truncate(displayName(a), 44));
      addInfoRow('来源', a.meta && a.meta.source === 'tripo-web' ? 'Tripo 网页' : (a.meta && a.meta.source === 'screenshot' ? '模型截图' : '本地 / 导入'));
      addInfoRow('时间', fmtTime(a.ts));
      if (a.prompt) addInfoRow('提示词', truncate(a.prompt, 260));
      if (a.kind === 'model') {
        var loaded = RT.loadedModelId === a.id && viewport3d;
        var st = loaded ? viewport3d.stats() : null;
        addInfoRow('面数', st ? st.tris.toLocaleString() : (a.meta.tris ? Number(a.meta.tris).toLocaleString() : '载入后统计'));
        addInfoRow('顶点', st ? st.verts.toLocaleString() : (a.meta.verts ? Number(a.meta.verts).toLocaleString() : '载入后统计'));
        addInfoRow('UV', st ? (st.hasUV ? '有' : '无 UV') : '载入后统计');
        addInfoRow('纹理', (a.meta.textureUrl ? '已应用' : '未应用') + (st && st.hasTexture ? '（当前生效）' : ''));
        if (a.meta.multi !== undefined) addInfoRow('生成方式', a.meta.multi ? '多视图' : '单图');
        if (a.meta.mode) addInfoRow('模式', a.meta.mode === 'hd' ? '高精度模型' : (a.meta.mode === 'smart' ? '智能网格' : a.meta.mode));
        if (a.meta.format) addInfoRow('格式', String(a.meta.format).toUpperCase());
      }
      addInfoRow('文件', a.file || basename(a.url) || '—');
      if (a.meta && a.meta.durationMs) addInfoRow('耗时', fmtDur(a.meta.durationMs));
      addInfoRow('地址', truncate(a.url, 120));
    }
    E.texSec.classList.toggle('hidden', !(a && a.kind === 'model'));
    renderTexOutputs();
  }

  function renderBusy() {
    if (!E.busy) return;
    if (!S.busy) {
      E.busy.classList.add('hidden');
      if (E.statusMain) E.statusMain.textContent = '就绪';
      if (E.queue) E.queue.textContent = '空闲';
      return;
    }
    var elapsed = Math.max(0, Math.round((Date.now() - S.busy.started) / 1000));
    E.busy.classList.remove('hidden');
    E.busyText.textContent = S.busy.label + ' · ' + elapsed + 's';
    if (E.statusMain) E.statusMain.textContent = '生成中：' + S.busy.label;
    if (E.queue) {
      E.queue.textContent = '';
      var b = document.createElement('b');
      b.textContent = S.busy.label;
      E.queue.appendChild(b);
      E.queue.appendChild(document.createElement('br'));
      E.queue.appendChild(document.createTextNode('已用时 ' + elapsed + ' 秒 · Tripo 助手单任务串行'));
    }
    $$('[data-act="genImage"],[data-act="genModel"],[data-act="genTexture"],[data-act="genTextureOnly"]').forEach(function (b) { b.disabled = true; });
  }

  function renderLog() {
    if (!E.log) return;
    E.log.textContent = '';
    RT.logs.slice(-120).forEach(function (it) {
      var line = document.createElement('div');
      if (it.type === 'warn' || it.type === 'err') line.className = 'tps-log-' + it.type;
      var d = new Date(it.t);
      function p(n) { return n < 10 ? '0' + n : '' + n; }
      line.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '  ' + it.text;
      E.log.appendChild(line);
    });
    E.log.scrollTop = E.log.scrollHeight;
  }

  function log(text, type) {
    RT.logs.push({ t: Date.now(), text: String(text), type: type || '' });
    if (RT.logs.length > 240) RT.logs.splice(0, RT.logs.length - 240);
    renderLog();
  }

  function toast(text, type) {
    if (!E.toast) return;
    E.toast.textContent = text;
    E.toast.setAttribute('data-type', type || '');
    E.toast.classList.add('is-on');
    clearTimeout(RT.toastTimer);
    RT.toastTimer = setTimeout(function () { E.toast.classList.remove('is-on'); }, 2800);
  }

  function renderAll() {
    renderConn();
    syncForms();
    renderModelMode();
    renderRefs();
    renderStrip();
    renderAssetList();
    renderFilters();
    renderInspector();
    renderBusy();
    renderCounts();
    renderStageTools();
  }

  /* ------------------------------------------------------------------ *
   * 助手连接
   * ------------------------------------------------------------------ */
  function refreshStatus(manual) {
    return bridgeFetch('/status', {}, 6000).then(function (d) {
      var running = !!(d && d.running);
      var ready = !!(d && d.ready);
      var modelReady = !!(d && d.modelReady);
      S.conn = {
        state: !running ? 'off' : ((ready || modelReady) ? 'ready' : 'login'),
        ready: ready,
        modelReady: modelReady,
        running: running,
        title: (d && d.title) || '',
        mode: (d && d.mode) || 'none',
        embedded: !!(d && d.embedded)
      };
      RT.embed.bridge = !!(d && d.embedded);
      renderEmbedButton();
      renderConn();
      if (manual) {
        if (!running) toast('助手未启动：请先双击 start.bat', 'warn');
        else if (ready || modelReady) toast('已连接 Tripo 网页助手');
        else toast('页面已打开，请完成登录并进入生图 / 生成页', 'warn');
      }
    }).catch(function (e) {
      S.conn = { state: 'off', ready: false, modelReady: false, running: false, title: '', mode: 'none', embedded: false };
      RT.embed.bridge = false;
      renderEmbedButton();
      renderConn();
      if (manual) toast('无法连接本地助手：' + errMsg(e), 'err');
    });
  }

  async function ensureBridge() {
    if (S.conn.state === 'off' || !S.conn.running) await refreshStatus(false);
    if (S.conn.state === 'off') {
      throw new Error('Tripo 助手未启动：请先双击 start.bat 启动项目，再点右上角「登录」');
    }
  }

  /* ------------------------------------------------------------------ *
   * 内嵌 Tripo 网页（仅桌面版）
   *
   * 登录与生成都由助手插件直接驱动这个 <webview>（走 CDP），所以这里只负责：
   *   1) 判断当前外壳是不是 Electron；2) 按需创建 webview；3) 和 /login 对齐。
   * 浏览器环境完全不碰 webview，退回原来的外部 Edge 流程。
   * ------------------------------------------------------------------ */
  function isDesktopShell() {
    return /Electron\//i.test(navigator.userAgent || '');
  }

  function setupEmbed() {
    RT.embed.supported = isDesktopShell();
    // 窗口关闭再打开时 rebuild 了 DOM，旧 webview 的引用不能继续用
    if (RT.embed.wv && !RT.embed.wv.isConnected) {
      RT.embed.wv = null;
      RT.embed.ready = false;
      RT.embed.on = false;
    }
    if (!RT.embed.supported) {
      if (E.embedBtn) E.embedBtn.classList.add('hidden');
      if (E.embed) E.embed.classList.add('hidden');
      if (E.embedNote) {
        E.embedNote.textContent = '内嵌网页只在桌面版可用。当前是浏览器环境，请点「登录」用外部 Edge 完成登录与生成。';
        E.embedNote.classList.remove('hidden');
      }
      return;
    }
    renderEmbedButton();
  }

  function renderEmbedButton() {
    if (!E.embedBtn) return;
    E.embedBtn.classList.toggle('hidden', !(RT.embed.supported && RT.embed.bridge));
    E.embedBtn.classList.toggle('is-on', !!RT.embed.on);
  }

  function embedState(text) {
    if (E.embedState) E.embedState.textContent = text;
  }

  function createWebview() {
    if (RT.embed.wv && RT.embed.wv.isConnected) return RT.embed.wv;
    if (!E.embedHost) return null;
    var wv = document.createElement('webview');
    wv.className = 'tps-embedview';
    /* 分区由主进程白名单放行：登录态独立于「浏览器」App，下载落到 tripo_out。
       allowpopups 是第三方登录（Google 等）开新窗口的必要条件。 */
    wv.setAttribute('partition', 'persist:tripo-embed');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'nodeIntegration=no, contextIsolation=yes, sandbox=yes');
    /* 去掉 Electron / 应用名标识：Tripo 的 Cloudflare 对 Electron UA 更敏感。
       主进程给分区设了同一套 UA，这里显式写一遍，避免 webview 默认继承宿主 UA。 */
    var ua = String(navigator.userAgent || '')
      .replace(/\sElectron\/[\d.]+/i, '')
      .replace(/\s(?:openagi|the-seed)\/[\d.]+/ig, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (ua) wv.setAttribute('useragent', ua);
    wv.setAttribute('src', TPS_EMBED_URL);
    wv.addEventListener('did-start-loading', function () { embedState('加载中…'); });
    wv.addEventListener('dom-ready', function () {
      RT.embed.ready = true;
      embedState('已就绪');
      if (E.embedNote) E.embedNote.classList.add('hidden');
    });
    wv.addEventListener('did-stop-loading', function () { if (RT.embed.ready) embedState('已就绪'); });
    wv.addEventListener('did-fail-load', function (ev) {
      if (ev && ev.errorCode === -3) return; // 主动跳转打断的加载，不算失败
      embedState('加载失败');
      if (E.embedNote) {
        E.embedNote.textContent = 'Tripo 页面加载失败（' + ((ev && ev.errorDescription) || '网络错误') + '）。可以点「刷新」重试，或改用外部浏览器登录。';
        E.embedNote.classList.remove('hidden');
      }
    });
    E.embedHost.appendChild(wv);
    RT.embed.wv = wv;
    if (E.embedNote) E.embedNote.classList.add('hidden');
    return wv;
  }

  function embedNavigate(url) {
    var wv = createWebview();
    if (!wv) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (done) return; done = true; resolve(); }
      try { wv.addEventListener('did-stop-loading', fin, { once: true }); } catch (e) { /* ignore */ }
      setTimeout(fin, 5000);
      try {
        if (RT.embed.ready && typeof wv.loadURL === 'function') wv.loadURL(url);
        else wv.setAttribute('src', url);
      } catch (e) {
        try { wv.setAttribute('src', url); } catch (err) { /* ignore */ }
        fin();
      }
    });
  }

  /* 收起用 is-off（visibility），不用 display:none：webview 一旦没有尺寸，
     guest 会白屏，登录态和正在生成的页面都会跟着出问题。 */
  function showEmbed(on) {
    if (!RT.embed.supported) {
      toast('内嵌网页只在桌面版可用，请点「登录」使用外部浏览器', 'warn');
      return;
    }
    if (on && !RT.embed.bridge) {
      toast('本地助手没有开启内嵌模式，请改用外部浏览器登录', 'warn');
      return;
    }
    RT.embed.on = !!on;
    renderEmbedButton();
    if (!E.embed) return;
    if (on) {
      E.embed.classList.remove('hidden');
      E.embed.classList.remove('is-off');
      createWebview();
      log('内嵌 Tripo 页面已打开');
    } else {
      E.embed.classList.add('is-off');
      log('已切回编辑器（内嵌页面保持运行）');
    }
  }

  /* 等内嵌页面第一次 dom-ready（或已就绪）。不抛错：助手自己会再等 guest 出现。 */
  function waitEmbedReady() {
    var wv = RT.embed.wv;
    if (!wv || RT.embed.ready) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (done) return; done = true; resolve(); }
      try { wv.addEventListener('dom-ready', fin, { once: true }); } catch (e) { /* ignore */ }
      setTimeout(fin, 8000);
    });
  }

  function openLogin() {
    var target = '';
    try { if (typeof confGet === 'function') target = confGet('tripoWebUrl') || ''; } catch (e) { target = ''; }

    /* 桌面版优先内嵌：不在工坊外面再弹一个 Edge。助手侧 /login 会直接挂到 webview，
       并负责把页面导航到 target —— 这里不抢先导航，否则 openagi_embed=1 标记会先丢掉，
       助手可能认领到「浏览器」App 里另一个 Tripo 页。 */
    if (RT.embed.supported && RT.embed.bridge) {
      showEmbed(true);
      log('请求内嵌 Tripo 登录页');
      waitEmbedReady().then(function () {
        return bridgeFetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: target })
        }, 20000);
      }).then(function (d) {
        if (d && d.needOpen) {
          toast('内嵌页面还没就绪，稍等一下再点「登录」', 'warn');
          return;
        }
        toast((d && d.message) || '已切换到内嵌 Tripo 页面，请在其中登录');
        setTimeout(function () { refreshStatus(false); }, 1200);
      }).catch(function (e) {
        toast('内嵌登录请求失败：' + errMsg(e), 'err');
        log('内嵌登录请求失败：' + errMsg(e), 'err');
      });
      return;
    }

    bridgeFetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target })
    }, 15000).then(function (d) {
      /* 与内嵌分支同款：外部 Edge 分支原来把响应参数整个丢掉，无条件 toast「已打开」。
         桌面版内嵌模式下服务端可能回 needOpen（webview guest 未就绪），这里同样要认，
         否则假成功。needOpen 时引导用户改走内嵌（工坊）登录。 */
      if (d && d.needOpen) {
        toast('内嵌页面还没就绪，稍等几秒再点「登录」，或确认已在「Tripo 工坊」里打开过登录页', 'warn');
        log('外部登录路径收到 needOpen：webview 未就绪');
        return;
      }
      toast((d && d.message) || '已打开 Tripo 登录页，登录完成后回到这里点「检测」');
      log('已请求打开 Tripo 登录页');
      setTimeout(function () { refreshStatus(false); }, 1500);
    }).catch(function (e) {
      toast('打开登录页失败：' + errMsg(e), 'err');
      log('打开登录页失败：' + errMsg(e), 'err');
    });
  }

  /* ------------------------------------------------------------------ *
   * 任务
   * ------------------------------------------------------------------ */
  function beginBusy(label, ctrl) {
    S.busy = { label: label, started: Date.now() };
    RT.busyCtrl = ctrl || null;
    clearInterval(RT.busyTimer);
    RT.busyTimer = setInterval(renderBusy, 1000);
    renderBusy();
    log('开始：' + label);
  }

  function endBusy() {
    S.busy = null;
    RT.busyCtrl = null;
    clearInterval(RT.busyTimer);
    RT.busyTimer = 0;
    renderBusy();
    $$('[data-act="genImage"],[data-act="genModel"],[data-act="genTexture"],[data-act="genTextureOnly"]').forEach(function (b) { b.disabled = false; });
    saveSoon();
  }

  function runTask(label, fn) {
    if (S.busy) { toast('已有任务在进行中', 'warn'); return; }
    var ctrl = new AbortController();
    beginBusy(label, ctrl);
    Promise.resolve().then(function () { return fn(ctrl.signal); }).then(function () {
      log('完成：' + label);
    }).catch(function (e) {
      if (e && e._stopped) {
        log('已取消：' + label, 'warn');
        toast('已取消');
        return;
      }
      log(label + '失败：' + errMsg(e), 'err');
      toast(label + '失败：' + errMsg(e), 'err');
    }).finally(function () {
      endBusy();
    });
  }

  /* ------------------------------------------------------------------ *
   * 生图
   * ------------------------------------------------------------------ */
  function doGenImage() {
    var prompt = String(S.image.prompt || '').trim();
    if (!prompt) { toast('请先填写提示词', 'warn'); return; }
    runTask('生成图像', async function (signal) {
      await ensureBridge();
      var refs = RT.imgRefs.filter(Boolean).slice(0, 3);
      if (typeof wfTripoWebImage !== 'function') throw new Error('工作流运行时未加载，无法调用 Tripo 生图节点');
      var t0 = Date.now();
      var r = await wfTripoWebImage(prompt, refs, {
        signal: signal,
        timeoutSec: S.image.timeout,
        ratio: S.image.ratio,
        mode: S.image.mode === 'auto' ? '' : S.image.mode
      });
      var a = {
        kind: 'image',
        url: r.url,
        file: r.file || '',
        name: r.file || '生成图像',
        prompt: prompt,
        meta: {
          source: 'tripo-web',
          ratio: S.image.ratio,
          mode: S.image.mode,
          refs: refs.length,
          durationMs: Date.now() - t0
        }
      };
      addAsset(a);
      log('图像生成完成 · ' + fmtDur(Date.now() - t0));
      toast('图像已生成并载入编辑器');
      refreshStatus(false);
    });
  }

  /* ------------------------------------------------------------------ *
   * 生模型
   * ------------------------------------------------------------------ */
  function doGenModel() {
    var multi = !!S.model.multi;
    if (multi) {
      var views = {
        front: RT.modelRefs.front || '',
        left: RT.modelRefs.left || '',
        right: RT.modelRefs.right || '',
        back: RT.modelRefs.back || ''
      };
      if (!views.front && !views.left && !views.right && !views.back) {
        toast('多视图模式至少要提供一张参考图', 'warn');
        return;
      }
    } else if (!RT.modelRefs.single) {
      toast('请先上传一张参考图', 'warn');
      return;
    }

    runTask('生成模型', async function (signal) {
      await ensureBridge();
      if (typeof wfTripoWebModel !== 'function') throw new Error('工作流运行时未加载，无法调用 Tripo 模型节点');
      var t0 = Date.now();
      var opts = {
        signal: signal,
        multi: multi,
        views: multi ? {
          front: RT.modelRefs.front || '',
          left: RT.modelRefs.left || '',
          right: RT.modelRefs.right || '',
          back: RT.modelRefs.back || ''
        } : null,
        mode: S.model.mode,
        version: S.model.version,
        topology: S.model.topology,
        faceCount: S.model.faceCount,
        count: S.model.count,
        format: S.model.format,
        timeoutSec: S.model.timeout
      };
      var r = await wfTripoWebModel(multi ? (RT.modelRefs.front || '') : RT.modelRefs.single, opts);
      var a = {
        kind: 'model',
        url: r.url,
        file: r.file || '',
        size: r.size || 0,
        name: r.file || '生成模型',
        prompt: String(S.image.prompt || '').trim(),
        meta: {
          source: 'tripo-web',
          multi: multi,
          mode: S.model.mode,
          version: S.model.version,
          topology: S.model.topology,
          faceCount: S.model.faceCount,
          count: S.model.count,
          format: S.model.format,
          size: r.size || 0,
          durationMs: Date.now() - t0
        }
      };
      addAsset(a);
      log('模型生成完成 · ' + fmtDur(Date.now() - t0) + (r.size ? (' · ' + fmtSize(r.size)) : ''));
      toast('模型已生成并载入 3D 视口');
      refreshStatus(false);
    });
  }

  /* ------------------------------------------------------------------ *
   * 纹理
   * ------------------------------------------------------------------ */
  async function ensureModelLoaded(model) {
    if (!model) throw new Error('请先选择一个模型');
    if (RT.loadedModelId === model.id && viewport3d) return true;
    var ok = await selectAsset(model.id);
    if (!ok) throw new Error('模型载入失败，无法应用纹理');
    return true;
  }

  async function applyTextureToModel(model, texUrl) {
    if (!model) throw new Error('请先选择一个模型');
    await ensureModelLoaded(model);
    var src = await resolveUrl(texUrl);
    await viewport3d.applyTexture(src, {
      tile: S.tex.tile,
      roughness: S.tex.roughness,
      metalness: S.tex.metalness
    });
    model.meta.textureUrl = texUrl;
    model.meta.tex = { tile: S.tex.tile, roughness: S.tex.roughness, metalness: S.tex.metalness };
    S.stage.mat = 'texture';
    renderStageTools();
    renderInspector();
    renderStrip();
    saveSoon();
    log('纹理已应用到：' + displayName(model));
  }

  function doGenTexture(apply) {
    var prompt = String(S.tex.prompt || '').trim();
    if (!prompt) { toast('请先填写纹理描述', 'warn'); return; }
    var model = apply ? currentModelAsset() : null;
    if (apply && !model) { toast('请先选择一个模型，再生成并应用纹理', 'warn'); return; }
    if (S.tex.fromModel && !currentModelAsset()) { toast('「以当前模型视图为参考」需要先选择一个模型', 'warn'); return; }

    runTask(apply ? '生成并应用纹理' : '生成纹理', async function (signal) {
      await ensureBridge();
      var refs = [];
      if (S.tex.fromModel) {
        var refModel = currentModelAsset();
        await ensureModelLoaded(refModel);
        refs = [viewport3d.screenshot()];
      }
      var enriched = prompt + '，无缝贴图，四方连续，无接缝，顶视图平铺，均匀光照，无阴影，高细节';
      var t0 = Date.now();
      var r = await wfTripoWebImage(enriched, refs, {
        signal: signal,
        timeoutSec: S.tex.timeout,
        ratio: '1:1',
        mode: refs.length ? 'image' : 'text'
      });
      var texAsset = {
        kind: 'texture',
        url: r.url,
        file: r.file || '',
        name: r.file || '生成纹理',
        prompt: prompt,
        meta: {
          source: 'tripo-web',
          ratio: '1:1',
          refs: refs.length,
          tile: S.tex.tile,
          roughness: S.tex.roughness,
          metalness: S.tex.metalness,
          durationMs: Date.now() - t0
        }
      };
      addAsset(texAsset, { select: !apply });
      if (apply && model) {
        await applyTextureToModel(model, texAsset.url);
        toast('纹理已生成并应用到当前模型');
      } else {
        toast('纹理已生成');
      }
      log('纹理生成完成 · ' + fmtDur(Date.now() - t0));
    });
  }

  function doClearTexture() {
    var model = currentModelAsset();
    if (!model) { toast('请先选择一个模型', 'warn'); return; }
    if (viewport3d && RT.loadedModelId === model.id) viewport3d.clearTexture();
    delete model.meta.textureUrl;
    delete model.meta.tex;
    renderInspector();
    renderStrip();
    saveSoon();
    toast('已移除模型纹理');
  }

  function doApplyCurrentTexture() {
    var a = currentAsset();
    if (!a) { toast('请先选择一张图像或纹理', 'warn'); return; }
    var model = currentModelAsset();
    if (!model) { toast('请先选择一个模型', 'warn'); return; }
    if (a.kind !== 'image' && a.kind !== 'texture') { toast('当前资源不是图像，无法作为纹理', 'warn'); return; }
    runTask('应用纹理', async function () {
      await applyTextureToModel(model, a.url);
      toast('已应用到：' + displayName(model));
    });
  }

  function applyTexOptsLive() {
    var model = currentModelAsset();
    if (!model || !model.meta.textureUrl) return;
    if (!viewport3d || RT.loadedModelId !== model.id) return;
    var ok = viewport3d.updateTexture({
      tile: S.tex.tile,
      roughness: S.tex.roughness,
      metalness: S.tex.metalness
    });
    if (ok) {
      model.meta.tex = { tile: S.tex.tile, roughness: S.tex.roughness, metalness: S.tex.metalness };
      saveSoon();
    }
  }

  /* ------------------------------------------------------------------ *
   * 资源选择 / 载入
   * ------------------------------------------------------------------ */
  function showMissing(msg) {
    E.missing.classList.remove('hidden');
    E.missingText.textContent = msg || '文件可能已被清理，或本地助手尚未启动。';
  }
  function hideMissing() { E.missing.classList.add('hidden'); }

  function setStageTitle(text) {
    if (E.stageTitle) E.stageTitle.textContent = text || '未选择资源';
  }

  function updateStageMeta(a) {
    if (!E.assetMeta) return;
    if (!a) { E.assetMeta.textContent = '—'; return; }
    var bits = [kindLabel(a.kind), displayName(a)];
    if (a.kind === 'model' && a.meta && a.meta.size) bits.push(fmtSize(a.meta.size));
    if (a.meta && a.meta.durationMs) bits.push('耗时 ' + fmtDur(a.meta.durationMs));
    E.assetMeta.textContent = bits.join(' · ');
  }

  function ensure3d() {
    if (viewport3d) return viewport3d;
    if (!window.TripStudioViewport || typeof window.TripStudioViewport.createModelStage !== 'function') {
      throw new Error('3D 视口模块未加载');
    }
    viewport3d = window.TripStudioViewport.createModelStage({
      host: E.host3d,
      sceneEl: E.scene3d,
      onChange: function (ev) {
        if (ev && ev.type === 'model') {
          var a = currentAsset();
          if (a && a.kind === 'model') {
            a.meta.verts = ev.stats.verts;
            a.meta.tris = ev.stats.tris;
            renderInspector();
            saveSoon();
          }
        }
      }
    });
    viewport3d.setGrid(!!S.stage.grid);
    viewport3d.setAutoRotate(!!S.stage.rotate);
    viewport3d.setMaterialMode(S.stage.mat);
    return viewport3d;
  }

  async function showImage(a, token) {
    setStageMode('image');
    hideMissing();
    setStageTitle(displayName(a) + ' · ' + kindLabel(a.kind));
    updateStageMeta(a);
    try {
      var src = await resolveUrl(a.url);
      if (token !== RT.showToken) return false;
      var dims = await viewport2d.setSrc(bust(src));
      if (token !== RT.showToken) return false;
      if (dims) {
        a.meta.w = dims.w;
        a.meta.h = dims.h;
        a.meta.missing = false;
      }
      E.stageHint.textContent = dims ? (dims.w + ' × ' + dims.h + ' px') : '已载入';
      renderInspector();
      return true;
    } catch (e) {
      if (token === RT.showToken) {
        viewport2d.clear();
        a.meta.missing = true;
        showMissing('图像加载失败：' + errMsg(e));
        setStageTitle(displayName(a) + ' · 不可用');
        E.stageHint.textContent = '加载失败';
        renderStrip();
        renderAssetList();
      }
      return false;
    }
  }

  async function showModel(a, token) {
    try {
      var v3 = ensure3d();
      setStageMode('model');
      hideMissing();
      setStageTitle(displayName(a) + ' · 模型');
      updateStageMeta(a);
      E.stageHint.textContent = '载入模型…';
      var src = await resolveUrl(a.url);
      if (token !== RT.showToken) return false;
      var texSpec = null;
      if (a.meta && a.meta.textureUrl) {
        try {
          var texSrc = await resolveUrl(a.meta.textureUrl);
          var t = a.meta.tex || {};
          texSpec = {
            url: texSrc,
            tile: t.tile !== undefined ? t.tile : S.tex.tile,
            roughness: t.roughness !== undefined ? t.roughness : S.tex.roughness,
            metalness: t.metalness !== undefined ? t.metalness : S.tex.metalness,
            texAssetUrl: a.meta.textureUrl
          };
        } catch (e) { /* 纹理丢了不影响模型 */ }
      }
      var res = await v3.load(src, texSpec);
      if (token !== RT.showToken || !res) return false;
      RT.loadedModelId = a.id;
      a.meta.missing = false;
      a.meta.verts = res.stats.verts;
      a.meta.tris = res.stats.tris;
      E.stageHint.textContent = '已载入 · ' + res.stats.tris.toLocaleString() + ' 三角面';
      v3.setGrid(!!S.stage.grid);
      v3.setAutoRotate(!!S.stage.rotate);
      v3.setMaterialMode(S.stage.mat);
      v3.resize();
      renderInspector();
      renderStrip();
      return true;
    } catch (e) {
      if (token === RT.showToken) {
        a.meta.missing = true;
        setStageMode('model');
        showMissing('模型加载失败：' + errMsg(e));
        setStageTitle(displayName(a) + ' · 不可用');
        E.stageHint.textContent = '加载失败';
        renderStrip();
        renderAssetList();
      }
      return false;
    }
  }

  async function selectAsset(id) {
    var a = findAsset(id);
    var token = ++RT.showToken;
    S.selId = a ? a.id : '';
    if (!a) {
      setStageMode('empty');
      setStageTitle('未选择资源');
      updateStageMeta(null);
      viewport2d.clear();
      hideMissing();
      renderStrip();
      renderAssetList();
      renderInspector();
      saveSoon();
      return false;
    }
    if (a.kind === 'model') {
      RT.lastModelId = a.id;
      if (a.meta && a.meta.tex) {
        S.tex.tile = a.meta.tex.tile !== undefined ? a.meta.tex.tile : S.tex.tile;
        S.tex.roughness = a.meta.tex.roughness !== undefined ? a.meta.tex.roughness : S.tex.roughness;
        S.tex.metalness = a.meta.tex.metalness !== undefined ? a.meta.tex.metalness : S.tex.metalness;
        renderTexOutputs();
      }
    } else {
      viewport2d.clear();
    }
    renderStrip();
    renderAssetList();
    renderInspector();
    saveSoon();
    if (a.kind === 'model') return showModel(a, token);
    return showImage(a, token);
  }

  function removeAsset(id) {
    var idx = -1;
    for (var i = 0; i < S.assets.length; i++) if (S.assets[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    S.assets.splice(idx, 1);
    if (RT.lastModelId === id) RT.lastModelId = '';
    if (RT.loadedModelId === id) RT.loadedModelId = '';
    if (S.selId === id) {
      S.selId = '';
      var next = S.assets[idx] || S.assets[idx - 1] || null;
      if (next) selectAsset(next.id);
      else selectAsset('');
    } else {
      renderStrip();
      renderAssetList();
      renderInspector();
      saveSoon();
    }
    log('已删除资源');
  }

  function addAsset(a, opts) {
    opts = opts || {};
    a.id = a.id || uid('a');
    a.ts = a.ts || Date.now();
    a.meta = a.meta && typeof a.meta === 'object' ? a.meta : {};
    a.name = a.name || a.file || basename(a.url) || kindLabel(a.kind);
    if (!a.kind) a.kind = guessKind(a.url);
    S.assets.unshift(a);
    if (S.assets.length > MAX_ASSETS) S.assets.length = MAX_ASSETS;
    if (opts.select !== false) selectAsset(a.id);
    else {
      renderStrip();
      renderAssetList();
      renderCounts();
      renderInspector();
    }
    saveSoon();
    return a;
  }

  /* ------------------------------------------------------------------ *
   * 参考图
   * ------------------------------------------------------------------ */
  function refGet(key) {
    if (/^image:/.test(key)) return RT.imgRefs[Number(key.split(':')[1])] || null;
    return RT.modelRefs[key.split(':')[1]] || null;
  }
  function refSet(key, val) {
    if (/^image:/.test(key)) RT.imgRefs[Number(key.split(':')[1])] = val || null;
    else RT.modelRefs[key.split(':')[1]] = val || null;
    renderRefs();
  }

  async function setRefFromCurrent(target) {
    var a = currentAsset();
    if (!a || a.kind === 'model') { toast('请先选择一张图像或纹理', 'warn'); return; }
    try {
      var src = await resolveUrl(a.url);
      refSet(target, src);
      toast('已填入参考图');
    } catch (e) { toast('读取图像失败：' + errMsg(e), 'err'); }
  }

  function setRefFromModel(target) {
    var model = currentModelAsset();
    if (!model) { toast('请先选择一个模型', 'warn'); return; }
    if (!viewport3d || RT.loadedModelId !== model.id) {
      selectAsset(model.id).then(function (ok) {
        if (ok) setRefFromModel(target);
      });
      return;
    }
    try {
      var shot = viewport3d.screenshot();
      refSet(target, shot);
      toast('已用当前模型视图填入参考图');
    } catch (e) { toast('截图失败：' + errMsg(e), 'err'); }
  }

  function pickImage(target) {
    RT.fileTarget = target;
    E.fileImage.value = '';
    E.fileImage.click();
  }

  function importImage() {
    RT.fileTarget = 'importImage';
    E.fileImage.value = '';
    E.fileImage.click();
  }
  function importModel() {
    RT.fileTarget = 'importModel';
    E.fileModel.value = '';
    E.fileModel.click();
  }
  function importTexture() {
    RT.fileTarget = 'importTexture';
    E.fileTexture.value = '';
    E.fileTexture.click();
  }

  async function consumeImageFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var target = RT.fileTarget;
    RT.fileTarget = '';
    if (/^ref:/.test(target)) {
      var key = target.slice(4);
      try {
        var data = await fileToDataURL(list[0], 24);
        refSet(key, data);
        toast('参考图已更新');
      } catch (e) { toast('参考图读取失败：' + errMsg(e), 'err'); }
      return;
    }
    if (target === 'importTexture') {
      try {
        var dataTex = await fileToDataURL(list[0], 32);
        var texAsset = {
          kind: 'texture',
          url: packLocal(dataTex),
          name: list[0].name,
          file: list[0].name,
          prompt: '',
          meta: { source: 'local', w: 0, h: 0 }
        };
        addAsset(texAsset);
        log('已导入纹理：' + list[0].name);
      } catch (e) { toast('导入纹理失败：' + errMsg(e), 'err'); }
      return;
    }
    // 普通导入
    for (var i = 0; i < list.length; i++) {
      try {
        var d = await fileToDataURL(list[i], 32);
        var a = {
          kind: 'image',
          url: packLocal(d),
          name: list[i].name,
          file: list[i].name,
          prompt: '',
          meta: { source: 'local' }
        };
        addAsset(a, { select: i === list.length - 1 });
        log('已导入图像：' + list[i].name);
      } catch (e) {
        toast('导入失败：' + errMsg(e), 'err');
      }
    }
    toast('已导入 ' + list.length + ' 个图像');
  }

  async function consumeModelFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    RT.fileTarget = '';
    var model = list.find(function (f) { return MODEL_EXT_RE.test('.' + (f.name.split('.').pop() || '')) || /\.(glb|gltf|obj|fbx|stl)$/i.test(f.name); }) || list[0];
    try {
      var data = await fileToDataURL(model, 160);
      var a = {
        kind: 'model',
        url: packLocal(data),
        name: model.name,
        file: model.name,
        size: model.size,
        prompt: '',
        meta: { source: 'local', size: model.size }
      };
      addAsset(a);
      log('已导入模型：' + model.name + ' · ' + fmtSize(model.size));
      toast('模型已导入');
    } catch (e) { toast('导入模型失败：' + errMsg(e), 'err'); }
  }

  /* ------------------------------------------------------------------ *
   * 拉回 / 本地保存 / 导出
   * ------------------------------------------------------------------ */
  function openPullDialog(prefill) {
    if (!E.dialog) return;
    E.dialog.classList.remove('hidden');
    if (E.pullUrl) {
      E.pullUrl.value = prefill || '';
      setTimeout(function () { E.pullUrl.focus(); }, 30);
    }
  }
  function closePullDialog() {
    if (E.dialog) E.dialog.classList.add('hidden');
  }

  async function doPull() {
    var url = String((E.pullUrl && E.pullUrl.value) || '').trim();
    if (!url) { toast('请填写结果地址', 'warn'); return; }
    if (!/^(https?:|data:|blob:)/i.test(url)) { toast('只支持 http(s) / data / blob 地址', 'warn'); return; }
    var kind = E.pullKind ? E.pullKind.value : 'auto';
    if (kind === 'auto') kind = guessKind(url);
    var asTex = !!(E.pullAsTexture && E.pullAsTexture.checked);
    closePullDialog();
    if (asTex) {
      var model = currentModelAsset();
      if (!model) { toast('请先选择一个模型，再作为纹理拉回', 'warn'); return; }
      var tex = {
        kind: 'texture',
        url: url,
        name: basename(url) || '拉回纹理',
        file: basename(url),
        prompt: '',
        meta: { source: 'pull' }
      };
      addAsset(tex, { select: false });
      try {
        await applyTextureToModel(model, tex.url);
        toast('已拉回并应用纹理');
      } catch (e) {
        toast('纹理应用失败：' + errMsg(e), 'err');
      }
      return;
    }
    var a = {
      kind: kind,
      url: url,
      name: basename(url) || ('拉回' + kindLabel(kind)),
      file: basename(url),
      prompt: '',
      meta: { source: 'pull' }
    };
    addAsset(a);
    log('已拉回资源：' + truncate(url, 120));
    toast('已拉回' + kindLabel(kind) + '，正在载入');
  }

  async function probeAsset(a) {
    try {
      var src = await resolveUrl(a.url);
      if (a.kind === 'model') {
        var req = (typeof apiRequest === 'function') ? apiRequest(src, { method: 'HEAD', cache: 'no-store' }) : { url: src, init: { method: 'HEAD' } };
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 6000);
        try {
          var res = await fetch(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
          return res.ok;
        } finally { clearTimeout(timer); }
      }
      return await new Promise(function (resolve) {
        var img = new Image();
        var done = false;
        function fin(v) { if (!done) { done = true; resolve(v); } }
        img.onload = function () { fin(true); };
        img.onerror = function () { fin(false); };
        img.src = bust(src);
        setTimeout(function () { fin(false); }, 12000);
      });
    } catch (e) {
      return false;
    }
  }

  async function pullAllCheck() {
    if (!S.assets.length) { toast('项目里还没有资源'); return; }
    if (S.busy) { toast('已有任务在进行中', 'warn'); return; }
    var ctrl = new AbortController();
    beginBusy('校验资源', ctrl);
    var miss = 0;
    try {
      for (var i = 0; i < S.assets.length; i++) {
        if (ctrl.signal.aborted) break;
        var a = S.assets[i];
        E.statusMain.textContent = '校验资源 ' + (i + 1) + ' / ' + S.assets.length;
        var ok = await probeAsset(a);
        a.meta = a.meta || {};
        a.meta.missing = !ok;
        if (!ok) miss++;
      }
    } finally {
      endBusy();
      renderStrip();
      renderAssetList();
      renderInspector();
      saveSoon();
      if (miss) {
        toast(miss + ' 个资源已不可用，可用「拉回结果」重新接入', 'warn');
        log('校验完成：' + miss + ' 个资源不可用', 'warn');
      } else {
        toast('全部资源可用');
        log('校验完成：全部资源可用');
      }
    }
  }

  async function pinAsset() {
    var a = currentAsset();
    if (!a) { toast('请先选择一个资源', 'warn'); return; }
    if (isStub(a.url)) { toast('该资源已经是本地资产'); return; }
    if (S.busy) { toast('已有任务在进行中', 'warn'); return; }
    runTask('保存到本地资产', async function () {
      var blob = await fetchBlobByUrl(a.url);
      var data = await new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(new Error('读取下载内容失败')); };
        fr.readAsDataURL(blob);
      });
      a.url = packLocal(data);
      a.meta = a.meta || {};
      a.meta.pinned = true;
      a.meta.size = blob.size;
      a.pulled = true;
      saveSoon();
      renderStrip();
      renderAssetList();
      renderInspector();
      if (S.selId === a.id) selectAsset(a.id);
      toast('已保存到本地资产，服务器清理结果也不影响');
      log('已固化资源到本地资产库：' + displayName(a));
    });
  }

  async function exportCurrentImage() {
    var a = currentAsset();
    if (!a || a.kind === 'model') { toast('请先选择一张图像或纹理', 'warn'); return; }
    try {
      var src = await resolveUrl(a.url);
      var blob;
      if (/^data:/i.test(src)) blob = dataURLToBlob(src);
      else blob = await fetchBlobByUrl(src);
      var ext = /png/i.test(blob.type) ? 'png' : (/jpe?g/i.test(blob.type) ? 'jpg' : 'png');
      downloadBlob(blob, 'tripo-' + a.kind + '-' + Date.now() + '.' + ext);
      toast('图像已导出');
    } catch (e) { toast('导出失败：' + errMsg(e), 'err'); }
  }

  async function exportCurrentModel() {
    var a = currentAsset();
    var model = (a && a.kind === 'model') ? a : currentModelAsset();
    if (!model) { toast('请先选择一个模型', 'warn'); return; }
    if (S.busy) { toast('已有任务在进行中', 'warn'); return; }
    runTask('导出 GLB', async function () {
      await ensureModelLoaded(model);
      var data = await viewport3d.exportGLB();
      var blob = new Blob([data], { type: 'model/gltf-binary' });
      downloadBlob(blob, (displayName(model).replace(/\.[^.]+$/, '') || 'tripo-model') + '.glb');
      toast('GLB 已导出');
      log('已导出 GLB：' + fmtSize(blob.size));
    });
  }

  function takeScreenshot() {
    var model = currentModelAsset();
    if (!model) { toast('请先选择一个模型', 'warn'); return; }
    try {
      if (!viewport3d || RT.loadedModelId !== model.id) {
        selectAsset(model.id).then(function (ok) { if (ok) takeScreenshot(); });
        return;
      }
      var shot = viewport3d.screenshot();
      addAsset({
        kind: 'image',
        url: packLocal(shot),
        name: '模型截图',
        file: 'screenshot-' + Date.now() + '.png',
        prompt: '',
        meta: { source: 'screenshot', w: 0, h: 0 }
      }, { select: false });
      toast('截图已加入项目资源');
      log('已截取当前 3D 视图');
    } catch (e) { toast('截图失败：' + errMsg(e), 'err'); }
  }

  /* ------------------------------------------------------------------ *
   * 菜单动作
   * ------------------------------------------------------------------ */
  function setPanel(name) {
    if (['image', 'model', 'texture', 'assets'].indexOf(name) < 0) return;
    S.panel = name;
    E.app.setAttribute('data-panel', name);
    $$('.tps-rail-btn').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-panel') === name); });
    $$('.tps-pane').forEach(function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== name); });
    saveSoon();
  }

  function fitStage() {
    if (E.app.getAttribute('data-stage') === 'model' && viewport3d) viewport3d.fit();
    else viewport2d.fit();
  }
  function actualStage() {
    if (E.app.getAttribute('data-stage') === 'image') viewport2d.actual();
  }
  function toggleGrid() {
    S.stage.grid = !S.stage.grid;
    viewport2d.setGrid(S.stage.grid);
    if (viewport3d) viewport3d.setGrid(S.stage.grid);
    renderStageTools();
    saveSoon();
  }
  function toggleRotate() {
    if (E.app.getAttribute('data-stage') !== 'model') { toast('旋转只在 3D 视口生效', 'warn'); return; }
    S.stage.rotate = !S.stage.rotate;
    if (viewport3d) viewport3d.setAutoRotate(S.stage.rotate);
    renderStageTools();
    saveSoon();
  }
  function toggleBg() {
    var order = ['studio', 'dark', 'light'];
    S.stage.bg = order[(order.indexOf(S.stage.bg) + 1) % order.length];
    renderStageTools();
    saveSoon();
  }
  function setMatMode(mode) {
    if (['texture', 'clay', 'wire'].indexOf(mode) < 0) return;
    S.stage.mat = mode;
    if (viewport3d) viewport3d.setMaterialMode(mode);
    renderStageTools();
    saveSoon();
  }

  function clearAll() {
    if (!S.assets.length) { toast('项目已经是空的'); return; }
    if (!window.confirm('清空项目中的所有资源？本地资产库里的文件不会被删除。')) return;
    S.assets = [];
    S.selId = '';
    RT.lastModelId = '';
    RT.loadedModelId = '';
    viewport2d.clear();
    if (viewport3d) viewport3d.clearTexture();
    setStageMode('empty');
    setStageTitle('未选择资源');
    updateStageMeta(null);
    hideMissing();
    renderStrip();
    renderAssetList();
    renderInspector();
    saveNow();
    toast('项目已清空');
    log('项目已清空');
  }

  function imageToRef() {
    var a = currentAsset();
    if (!a || a.kind === 'model') { toast('请先选择一张图像或纹理', 'warn'); return; }
    var target;
    if (S.panel === 'model') target = S.model.multi ? 'model:front' : 'model:single';
    else {
      var empty = IMAGE_REF_KEYS.find(function (k) { return !refGet(k); });
      target = empty || 'image:0';
    }
    setRefFromCurrent(target);
  }

  function runAction(act, node) {
    switch (act) {
      case 'connCheck': refreshStatus(true); break;
      case 'login': openLogin(); break;
      case 'toggleEmbed': showEmbed(!RT.embed.on); break;
      case 'embedClose': showEmbed(false); break;
      case 'embedReload': if (RT.embed.wv) { try { RT.embed.wv.reload(); } catch (e) { showEmbed(true); } } else showEmbed(true); break;
      case 'embedHome': showEmbed(true); embedNavigate(TPS_EMBED_URL); break;
      case 'genImage': doGenImage(); break;
      case 'genModel': doGenModel(); break;
      case 'genTexture': doGenTexture(true); break;
      case 'genTextureOnly': doGenTexture(false); break;
      case 'clearTexture': doClearTexture(); break;
      case 'applyCurrentTexture': doApplyCurrentTexture(); break;
      case 'importImage': importImage(); break;
      case 'importModel': importModel(); break;
      case 'importTexture': importTexture(); break;
      case 'exportImage': exportCurrentImage(); break;
      case 'exportModel': exportCurrentModel(); break;
      case 'pinAsset': pinAsset(); break;
      case 'downloadModel': exportCurrentModel(); break;
      case 'clearAll': clearAll(); break;
      case 'copyPrompt': {
        var a = currentAsset();
        copyText(a && a.prompt ? a.prompt : (S.panel === 'texture' ? S.tex.prompt : S.image.prompt));
        break;
      }
      case 'copyUrl': {
        var b = currentAsset();
        if (b) copyText(b.url); else toast('请先选择一个资源', 'warn');
        break;
      }
      case 'removeAsset': {
        var c = currentAsset();
        if (c) removeAsset(c.id); else toast('请先选择一个资源', 'warn');
        break;
      }
      case 'imageToRef': imageToRef(); break;
      case 'imageToTexture': doApplyCurrentTexture(); break;
      case 'refFromCurrent': {
        var target = (node && node.getAttribute('data-target')) || (S.model.multi ? 'model:front' : 'model:single');
        setRefFromCurrent(target);
        break;
      }
      case 'refFromModel': {
        var target2 = (node && node.getAttribute('data-target')) || (S.model.multi ? 'model:front' : 'model:single');
        setRefFromModel(target2);
        break;
      }
      case 'fit': fitStage(); break;
      case 'actual': actualStage(); break;
      case 'zoomIn': if (E.app.getAttribute('data-stage') === 'image') viewport2d.zoomIn(); break;
      case 'zoomOut': if (E.app.getAttribute('data-stage') === 'image') viewport2d.zoomOut(); break;
      case 'toggleGrid': toggleGrid(); break;
      case 'toggleRotate': toggleRotate(); break;
      case 'toggleBg': toggleBg(); break;
      case 'toggleInspect': E.app.classList.toggle('is-inspect-off'); break;
      case 'shot': takeScreenshot(); break;
      case 'panel': setPanel((node && node.getAttribute('data-panel')) || 'image'); break;
      case 'pullBack': openPullDialog(''); break;
      case 'pullAll': pullAllCheck(); break;
      case 'pullDo': doPull(); break;
      case 'pullCancel': closePullDialog(); break;
      case 'retryAsset': {
        var d = currentAsset();
        if (d) selectAsset(d.id);
        break;
      }
      case 'cancel': {
        if (RT.busyCtrl) RT.busyCtrl.abort();
        toast('已请求取消，等待当前步骤退出');
        break;
      }
      case 'clearLog': RT.logs = []; renderLog(); break;
      case 'about':
        toast('Tripo 工坊 v1.0 · 复用工作流 tripoImg / tripoModel 节点');
        log('Tripo 工坊 v1.0 · 生图 / 生模型 / 纹理 / 拉回结果');
        break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  function bindEvents() {
    // 菜单开关
    $$('.tps-menu-btn', E.menus).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var menu = btn.parentNode;
        var was = menu.classList.contains('open');
        $$('.tps-menu').forEach(function (m) { m.classList.remove('open'); });
        if (!was) menu.classList.add('open');
      });
    });
    document.addEventListener('click', function (e) {
      if (!E.menus) return;
      if (!e.target.closest('.tps-menu')) $$('.tps-menu').forEach(function (m) { m.classList.remove('open'); });
    });

    // 统一点击委派
    E.app.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        removeAsset(del.getAttribute('data-del'));
        return;
      }
      var x = e.target.closest('[data-x]');
      if (x) {
        e.preventDefault();
        e.stopPropagation();
        refSet(x.getAttribute('data-x'), null);
        return;
      }
      var act = e.target.closest('[data-act]');
      if (act) {
        e.preventDefault();
        $$('.tps-menu').forEach(function (m) { m.classList.remove('open'); });
        runAction(act.getAttribute('data-act'), act);
        return;
      }
      var panel = e.target.closest('[data-panel]');
      if (panel) {
        e.preventDefault();
        setPanel(panel.getAttribute('data-panel'));
        return;
      }
      var mmode = e.target.closest('[data-mmode]');
      if (mmode) {
        e.preventDefault();
        S.model.multi = mmode.getAttribute('data-mmode') === 'multi';
        renderModelMode();
        saveSoon();
        return;
      }
      var mat = e.target.closest('[data-mat]');
      if (mat) {
        e.preventDefault();
        setMatMode(mat.getAttribute('data-mat'));
        return;
      }
      var chip = e.target.closest('[data-chip]');
      if (chip) {
        e.preventDefault();
        var path = chip.getAttribute('data-chip');
        var old = String(getPath(S, path) || '').trim();
        setPath(S, path, old ? (old + '\n' + chip.getAttribute('data-text')) : chip.getAttribute('data-text'));
        syncForms();
        saveSoon();
        return;
      }
      var filter = e.target.closest('[data-filter]');
      if (filter) {
        e.preventDefault();
        RT.filter = filter.getAttribute('data-filter');
        renderFilters();
        renderAssetList();
        return;
      }
      var ref = e.target.closest('[data-ref]');
      if (ref) {
        e.preventDefault();
        pickImage('ref:' + ref.getAttribute('data-ref'));
        return;
      }
      var card = e.target.closest('[data-asset-id]');
      if (card) {
        e.preventDefault();
        selectAsset(card.getAttribute('data-asset-id'));
        return;
      }
      var row = e.target.closest('[data-asset-row]');
      if (row) {
        e.preventDefault();
        selectAsset(row.getAttribute('data-asset-row'));
        return;
      }
      if (e.target.closest('[data-role="dialog"]') && !e.target.closest('.tps-dialog-box')) {
        closePullDialog();
      }
    });

    // 表单
    function onForm(e) {
      var el = e.target.closest('[data-form]');
      if (!el) return;
      var path = el.getAttribute('data-form');
      var val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number' || el.type === 'range') val = el.value === '' ? 0 : Number(el.value);
      else val = el.value;
      if (path === 'image.timeout') val = clamp(Number(val) || 240, 10, 900);
      if (path === 'model.timeout') val = clamp(Number(val) || 420, 30, 1800);
      if (path === 'tex.timeout') val = clamp(Number(val) || 240, 10, 900);
      if (path === 'model.faceCount') val = clamp(Number(val) || 0, 0, 25000);
      if (path === 'tex.tile') val = clamp(Number(val) || 1, 1, 8);
      if (path === 'tex.roughness' || path === 'tex.metalness') val = clamp(Number(val) || 0, 0, 1);
      setPath(S, path, val);
      if (el.type === 'checkbox') {
        // 同一字段只同步复选框，不覆盖其它控件
        $$('[data-form="' + path + '"]').forEach(function (o) { if (o.type === 'checkbox' && o !== el) o.checked = !!val; });
      } else {
        $$('[data-form="' + path + '"]').forEach(function (o) { if (o !== el && o.type !== 'checkbox') o.value = val; });
      }
      renderPromptCounts();
      renderTexOutputs();
      if (path.indexOf('tex.') === 0) applyTexOptsLive();
      saveSoon();
    }
    E.app.addEventListener('input', onForm);
    E.app.addEventListener('change', onForm);

    // 参考图槽拖放
    $$('.tps-ref').forEach(function (slot) {
      slot.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        slot.style.borderColor = '#8ea4ff';
      });
      slot.addEventListener('dragleave', function () { slot.style.borderColor = ''; });
      slot.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        slot.style.borderColor = '';
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f || !/^image\//.test(f.type)) { toast('这里只能放图像', 'warn'); return; }
        fileToDataURL(f, 24).then(function (data) {
          refSet(slot.getAttribute('data-ref'), data);
          toast('参考图已更新');
        }).catch(function (er) { toast('读取失败：' + errMsg(er), 'err'); });
      });
    });

    // 文件选择
    E.fileImage.addEventListener('change', function () { consumeImageFiles(E.fileImage.files); });
    E.fileModel.addEventListener('change', function () { consumeModelFiles(E.fileModel.files); });
    E.fileTexture.addEventListener('change', function () { consumeImageFiles(E.fileTexture.files); });

    // 相机视角
    if (E.camPreset) {
      E.camPreset.addEventListener('change', function () {
        S.stage.cam = E.camPreset.value;
        if (viewport3d) viewport3d.setCameraPreset(S.stage.cam);
        saveSoon();
      });
    }

    // 舞台拖放（导入）
    var dragDepth = 0;
    ['dragenter', 'dragover'].forEach(function (t) {
      E.viewport.addEventListener(t, function (e) {
        if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
        e.preventDefault();
        if (t === 'dragenter') dragDepth++;
        E.dropmask.classList.remove('hidden');
      });
    });
    E.viewport.addEventListener('dragleave', function (e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) E.dropmask.classList.add('hidden');
    });
    E.viewport.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      E.dropmask.classList.add('hidden');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var f = files[0];
      if (MODEL_EXT_RE.test(f.name)) consumeModelFiles(files);
      else if (/^image\//.test(f.type)) consumeImageFiles(files);
      else toast('暂不支持该文件类型', 'warn');
    });

    // 键盘
    document.addEventListener('keydown', function (e) {
      if (!E.app || !E.app.offsetParent) return;
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (S.panel === 'model') doGenModel();
        else if (S.panel === 'texture') doGenTexture(true);
        else doGenImage();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); importImage(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportCurrentModel(); return; }
      var tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        var a = currentAsset();
        if (a) { e.preventDefault(); removeAsset(a.id); }
        return;
      }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitStage(); return; }
      if (e.key === '1') { setPanel('image'); return; }
      if (e.key === '2') { setPanel('model'); return; }
      if (e.key === '3') { setPanel('texture'); return; }
      if (e.key === '4') { setPanel('assets'); return; }
      if (e.code === 'Space') {
        if (E.app.getAttribute('data-stage') === 'model') { e.preventDefault(); toggleRotate(); }
      }
    });

    window.addEventListener('beforeunload', saveNow);
  }

  /* ------------------------------------------------------------------ *
   * mount
   * ------------------------------------------------------------------ */
  function mount(body) {
    if (!body) return;
    if (body.dataset.ready === '1') {
      setupEmbed();
      renderAll();
      refreshStatus(false);
      if (viewport2d) {
        if (S.selId) selectAsset(S.selId);
      }
      if (viewport3d) viewport3d.resize();
      return;
    }

    bindEls(body);
    loadState();
    bindEvents();
    setupEmbed();

    if (window.TripStudioViewport) {
      viewport2d = window.TripStudioViewport.createImageStage({
        stage: E.imgStage,
        tile: E.imgTile,
        img: E.img,
        empty: E.empty,
        grid: E.grid2d,
        onChange: function (v) {
          if (E.zoomText) E.zoomText.textContent = Math.round(v.zoom * 100) + '%';
        }
      });
    }

    setPanel(S.panel);
    renderAll();
    renderLog();

    E.imgStage.classList.remove('hidden');
    E.scene3d.classList.add('hidden');
    setStageMode('empty');
    hideMissing();

    if (S.selId && findAsset(S.selId)) {
      selectAsset(S.selId);
    } else {
      S.selId = '';
      viewport2d.clear();
      setStageMode('empty');
      updateStageMeta(null);
    }

    if (S.stage.grid) viewport2d.setGrid(true);

    log('Tripo 工坊已就绪 · 复用工作流 tripoImg / tripoModel 节点');
    refreshStatus(false);

    clearInterval(RT.statusTimer);
    RT.statusTimer = setInterval(function () {
      if (!E.app || !E.app.offsetParent) return;
      if (S.busy) return;
      refreshStatus(false);
    }, 30000);

    body.dataset.ready = '1';
  }

  /* ------------------------------------------------------------------ *
   * 调试 / 自动化入口（探针与二次开发用）
   * ------------------------------------------------------------------ */
  window.TripStudio = {
    version: '1.0.0',
    appId: APP_ID,
    state: function () { return S; },
    addAsset: function (a, opts) { return addAsset(a, opts); },
    select: function (id) { return selectAsset(id); },
    remove: function (id) { removeAsset(id); },
    pull: function (url, kind) { return addAsset({ kind: kind || guessKind(url), url: url, name: basename(url) }); },
    applyTexture: function (url) {
      var model = currentModelAsset();
      return applyTextureToModel(model, url);
    },
    has3d: function () { return !!viewport3d; },
    stats: function () { return viewport3d ? viewport3d.stats() : null; },
    getPanel: function () { return S.panel; },
    setPanel: setPanel,
    getStage: function () { return E.app ? E.app.getAttribute('data-stage') : ''; },
    ready: function () { return !!(E.body && E.body.dataset.ready === '1'); },
    embed: function () {
      return { supported: !!RT.embed.supported, bridge: !!RT.embed.bridge, on: !!RT.embed.on, ready: !!RT.embed.ready, hasWebview: !!(RT.embed.wv && RT.embed.wv.isConnected) };
    },
    toggleEmbed: function (on) { showEmbed(typeof on === 'boolean' ? on : !RT.embed.on); }
  };

  registerApp({
    id: 'tripostudio',
    name: 'Tripo 工坊',
    order: 20,
    cls: 'tripostudio',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6l8-4.4Z"/><path d="m4 7.6 8 4.4 8-4.4M12 12v8.8"/><path d="M17.6 3.1v3.2M16 4.7h3.2"/></svg>',
    desc: '生图 / 生模型 / 纹理 / 拉回结果',
    body: window.TPS_BODY,
    css: ['apps/tripostudio/app.css'],
    scripts: ['apps/tripostudio/viewport.js'],
    mount: mount
  });
})();
