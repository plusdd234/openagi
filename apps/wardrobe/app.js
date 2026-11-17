/* 衣柜 —— 数字人皮套的真实换装台。
 *
 * 左边套装、中间预览、右边衣橱。皮套清单与数据包都复用数字人 App 的
 * apps/live2d/model/（由 tools/pack-live2d.js 生成），预览运行时是 rig.js 的
 * window.WD_RIG，槽位定义在 presets.js 的 window.WD_PRESETS —— 这个文件只管界面与状态，
 * 不直接碰 Cubism，也不猜参数：槽位里只出现模型作者实际预留的开关。
 *
 * 数据只存本机（v2；读到 v1 会自动迁移）：
 *   hf_wardrobe_state = {
 *     v: 2,
 *     modelId,                    // 上次预览的皮套
 *     activeId,                   // 最近穿上的套装（仅用于高亮）
 *     outfits: [{ id, name, modelId, look, extra, showManual, hidden, shown, params, ts }],
 *     draft: { modelId, look, extra, showManual, hidden, shown, params }
 *   }
 * look  = { slotId: itemId }，衣橱槽位的选择；
 * extra = 手动隐藏的部件，showManual = 手动强制显示的部件，两者是槽位之外的微调；
 * shown = 展开后的最终显示列表（槽位要求整组显示时用；当前鲸鱼娘没有这种槽位）。
 *
 * 皮套下拉只列出 presets.js 里真的有槽位的模型：没有作者预留开关的皮套
 * （例如官方 Haru）不放进衣柜，避免「点进去什么都没有」。
 *
 * 「应用到数字人」写 draft 并调 window.__l2dApplyOutfit（数字人开着就即时生效，
 * 没开就等它下次启动读 draft）。
 */
(function () {
  'use strict';

  var BODY_HTML = window.WD_BODY || '';

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 7.4V5.6a1.8 1.8 0 1 1 3.6 0"/>' +
    '<path d="M12 7.4 3.6 13.1a1.5 1.5 0 0 0 .8 2.8h15.2a1.5 1.5 0 0 0 .8-2.8L12 7.4Z"/></svg>';

  var STORE_KEY = 'hf_wardrobe_state';
  var STORE_VER = 2;
  var L2D_KEY = 'hf_live2d_state';

  /* 高级部件分组：按 cdi3 的中文名归类；匹配不到落到「其他」 */
  var PART_CATS = [
    { key: 'hair', label: '头发 / 头饰', re: /发|角|耳|帽|头饰|蝴蝶结|呆毛|兽耳/ },
    { key: 'face', label: '面部 / 表情', re: /脸|眉|眼|嘴|口|腮|舌|泪|痣|表情/ },
    { key: 'hand', label: '手 / 手臂', re: /手|爪|臂|指|腕/ },
    { key: 'cloth', label: '服装', re: /衣|裙|裤|袜|鞋|领|袖|披风|围巾|制服|泳装|腕|body|arm/i },
    { key: 'prop', label: '道具 / 场景', re: /饭|板|手机|包|桌|杯|盘|笔|书|伞|道具|麦克风|椅|床|背景|下绘|rough/i },
    { key: 'fx', label: '特效 / 贴图', re: /特效|贴图|光|晕|符号|阴影/ },
    { key: 'other', label: '其他', re: /[\s\S]*/ }
  ];

  var S = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function readJson(key) {
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function cleanIds(list) {
    return (Array.isArray(list) ? list : []).filter(function (id) {
      return typeof id === 'string' && id;
    }).slice(0, 300);
  }

  function cleanLook(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      if (typeof obj[k] === 'string' && obj[k]) out[k] = obj[k];
    });
    return out;
  }

  function cleanParams(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      var v = Number(obj[k]);
      if (k && isFinite(v)) out[k] = v;
    });
    return out;
  }

  /* ---------- 存档 ---------- */
  function emptyDraft() {
    return { modelId: '', look: {}, extra: [], showManual: [], hidden: [], shown: [], params: {} };
  }

  function loadState() {
    var out = { modelId: '', activeId: '', outfits: [], draft: emptyDraft() };
    var d = readJson(STORE_KEY);
    if (!d || (d.v !== 1 && d.v !== STORE_VER)) {
      /* 第一次用衣柜：沿用数字人当前的皮套，不硬切回第一套 */
      var l2 = readJson(L2D_KEY);
      if (l2 && typeof l2.modelId === 'string') out.modelId = l2.modelId;
      return out;
    }
    if (typeof d.modelId === 'string') out.modelId = d.modelId;
    if (typeof d.activeId === 'string') out.activeId = d.activeId;

    function fix(o, v1) {
      var hidden = cleanIds(o.hidden);
      var manual = cleanIds(o.manualShow);
      /* 早期 v2 把「手动显示」放在 shown 里，这里兼容读一次 */
      if (!manual.length && Array.isArray(o.shown)) manual = cleanIds(o.shown);
      return {
        modelId: typeof o.modelId === 'string' ? o.modelId : '',
        look: v1 ? {} : cleanLook(o.look),
        extra: v1 ? hidden : cleanIds(o.extra),
        showManual: v1 ? [] : manual,
        hidden: hidden,
        shown: cleanIds(o.shown),
        params: v1 ? {} : cleanParams(o.params)
      };
    }

    if (d.draft && typeof d.draft === 'object') out.draft = fix(d.draft, d.v === 1);
    if (Array.isArray(d.outfits)) {
      var presets = window.WD_PRESETS || {};
      out.outfits = d.outfits.filter(function (o) {
        /* 旧版本可能存过没有真实槽位的皮套（例如 Haru 的假「制服」），读档时丢掉 */
        return o && typeof o.id === 'string' && o.id && presets[o.modelId];
      }).map(function (o) {
        var f = fix(o, d.v === 1);
        f.id = o.id;
        f.name = String(o.name || '未命名').slice(0, 16);
        f.ts = Number(o.ts) || 0;
        return f;
      }).slice(0, 60);
    }
    if (out.activeId && !out.outfits.some(function (o) { return o.id === out.activeId; })) {
      out.activeId = '';
    }
    return out;
  }

  function draftOf() {
    return {
      modelId: S.modelId || '',
      look: Object.assign({}, S.look),
      extra: S.extra.slice(),
      shown: S.showParts.slice(),
      manualShow: S.showManual.slice(),
      hidden: S.hidden.slice(),
      params: Object.assign({}, S.params)
    };
  }

  function saveState() {
    if (!S) return;
    var payload = {
      v: STORE_VER,
      modelId: S.modelId || '',
      activeId: S.activeId || '',
      outfits: S.outfits.map(function (o) {
        return {
          id: o.id, name: o.name, modelId: o.modelId,
          look: Object.assign({}, o.look), extra: o.extra.slice(), shown: o.shown.slice(),
          manualShow: o.showManual.slice(), hidden: o.hidden.slice(),
          params: Object.assign({}, o.params), ts: o.ts
        };
      }),
      draft: draftOf()
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); }
    catch (e) { /* 配额满就只留在内存里 */ }
  }

  /* ---------- 启动 ---------- */
  function boot(body) {
    var loaded = loadState();

    S = {
      body: body,
      win: body.closest ? body.closest('.os-win') : null,
      models: [],
      modelId: loaded.modelId || '',
      look: loaded.draft.look,
      extra: loaded.draft.extra,
      showManual: loaded.draft.showManual,
      showParts: [],
      hidden: loaded.draft.hidden,
      params: loaded.draft.params,
      outfits: loaded.outfits,
      activeId: loaded.activeId,
      rig: null,
      ready: false,
      loading: true,
      error: '',
      loadSeq: 0,
      toastTimer: null,
      refs: {}
    };

    cacheRefs();
    bindEvents();
    compose();
    renderSlots();
    renderOutfits();
    syncHiddenUI();
    body.dataset.ready = '1';

    if (!window.WD_RIG) {
      S.loading = false;
      S.error = '预览运行时没加载：检查 apps/wardrobe/rig.js';
      setStageState();
      return;
    }

    S.rig = window.WD_RIG.create(S.refs.canvas, {});
    installProbe();

    window.WD_RIG.runtime().then(function (models) {
      var presets = window.WD_PRESETS || {};
      S.models = (models || []).filter(function (m) {
        return m && m.id && m.pack && presets[m.id];
      });
      renderModels();
      if (!S.models.length) {
        S.loading = false;
        S.error = '没有可换装的皮套：先在 apps/wardrobe/presets.js 里为模型补槽位';
        setStageState();
        return;
      }

      var def = null;
      S.models.forEach(function (m) { if (m.id === S.modelId) def = m; });
      if (!def) {
        def = S.models[0];
        S.modelId = def.id;
        /* 皮套变了，旧槽位 / 微调都没有意义 */
        S.look = {};
        S.extra = [];
        S.showManual = [];
        S.activeId = '';
        compose();
        renderSlots();
      }
      if (S.refs.modelSel) S.refs.modelSel.value = S.modelId;
      S.rig.setParams(S.params);
      S.rig.setHidden(S.hidden);
      S.rig.setShown(S.showParts);
      loadModel(S.modelId);
    }).catch(function (err) {
      S.loading = false;
      S.error = (err && err.message) || String(err);
      setStageState();
    });
  }

  function cacheRefs() {
    var b = S.body;
    S.refs = {
      modelSel: b.querySelector('#wdModelSel'),
      applyHuman: b.querySelector('#wdApplyHuman'),
      outfitCount: b.querySelector('#wdOutfitCount'),
      outfitName: b.querySelector('#wdOutfitName'),
      saveOutfit: b.querySelector('#wdSaveOutfit'),
      outfits: b.querySelector('#wdOutfits'),
      stage: b.querySelector('#wdStage'),
      canvas: b.querySelector('#wdCanvas'),
      loading: b.querySelector('#wdLoading'),
      err: b.querySelector('#wdErr'),
      chip: b.querySelector('#wdChip'),
      resetLook: b.querySelector('#wdResetLook'),
      partCount: b.querySelector('#wdPartCount'),
      toast: b.querySelector('#wdToast'),
      slotCount: b.querySelector('#wdSlotCount'),
      note: b.querySelector('#wdNote'),
      slots: b.querySelector('#wdSlots'),
      adv: b.querySelector('#wdAdv'),
      hiddenCount: b.querySelector('#wdHiddenCount'),
      search: b.querySelector('#wdSearch'),
      reset: b.querySelector('#wdReset'),
      parts: b.querySelector('#wdParts')
    };
  }

  /* ---------- 事件 ---------- */
  function bindEvents() {
    var r = S.refs;

    r.modelSel.addEventListener('change', function () {
      changeModel(r.modelSel.value);
    });

    r.applyHuman.addEventListener('click', function () {
      var name = activeOutfit() ? activeOutfit().name : '当前搭配';
      pushToHuman(name);
    });

    r.saveOutfit.addEventListener('click', function () {
      saveOutfit(r.outfitName.value);
    });
    r.outfitName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveOutfit(r.outfitName.value); }
    });

    r.outfits.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.wd-outfit') : null;
      if (!card) return;
      var id = card.getAttribute('data-oid');
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (btn && btn.hasAttribute('data-del')) { removeOutfit(id); return; }
      if (btn && btn.hasAttribute('data-human')) { wearOutfit(id, true); return; }
      wearOutfit(id, false);
    });

    r.slots.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.wd-opt') : null;
      if (!btn) return;
      choose(btn.getAttribute('data-slot'), btn.getAttribute('data-item'));
    });

    r.resetLook.addEventListener('click', function () {
      resetLook();
    });
    r.reset.addEventListener('click', function () {
      r.search.value = '';
      resetLook(true);
    });

    var searchTimer = 0;
    r.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderParts, 90);
    });

    r.parts.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.type !== 'checkbox') return;
      var id = input.getAttribute('data-pid');
      if (!id) return;
      togglePart(id, input.checked);
    });

    r.parts.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-solo]') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      isolatePart(btn.getAttribute('data-solo'));
    });

    /* 窗口从最小化 / 关标签回来时，舞台尺寸可能变过 */
    if (window.ResizeObserver) {
      S.refs.stageObserver = new ResizeObserver(function () {
        if (S && S.rig) S.rig.fit();
      });
      S.refs.stageObserver.observe(r.stage);
    }
  }

  /* ---------- 皮套 ---------- */
  function renderModels() {
    var sel = S.refs.modelSel;
    if (!sel) return;
    sel.innerHTML = '';
    S.models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      sel.appendChild(o);
    });
    if (S.modelId) sel.value = S.modelId;
  }

  function modelName(id) {
    var hit = '';
    S.models.forEach(function (m) { if (m.id === id) hit = m.name || m.id; });
    return hit || id || '';
  }

  function loadModel(id, done) {
    if (!S || !S.rig) return;
    var seq = ++S.loadSeq;
    S.loading = true;
    S.ready = false;
    S.error = '';
    setStageState();
    S.rig.setParams(S.params);
    S.rig.setHidden(S.hidden);
    S.rig.setShown(S.showParts);

    S.rig.load(id).then(function (info) {
      if (seq !== S.loadSeq) return;
      S.loading = false;
      S.ready = !!(info && info.ready);
      S.error = (info && info.error) || '';
      if (info && info.modelId) S.modelId = info.modelId;
      if (S.refs.modelSel) S.refs.modelSel.value = S.modelId;
      if (S.ready) {
        S.rig.setHidden(S.hidden);
        S.rig.setShown(S.showParts);
        S.rig.setParams(S.params);
      }
      saveState();
      renderParts();
      syncHiddenUI();
      setStageState();
      if (done) done();
    });
  }

  function changeModel(id) {
    if (!id || id === S.modelId) return;
    S.modelId = id;
    S.look = {};
    S.extra = [];
    S.showManual = [];
    S.activeId = '';
    compose();
    renderSlots();
    saveState();
    renderOutfits();
    loadModel(id, function () {
      toast('已换上皮套：' + modelName(id));
    });
  }

  function setStageState() {
    var r = S.refs;
    if (!r) return;
    if (r.loading) r.loading.hidden = !S.loading;
    if (r.err) {
      r.err.hidden = !S.error;
      if (S.error) {
        var span = r.err.querySelector('span');
        if (span) span.textContent = S.error;
      }
    }
    if (r.chip) {
      r.chip.textContent = S.ready
        ? modelName(S.modelId)
        : (S.error ? '皮套不可用' : '正在穿上皮套…');
      r.chip.classList.toggle('is-err', !!S.error);
    }
  }

  function toast(text) {
    var el = S && S.refs ? S.refs.toast : null;
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.add('on');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      el.classList.remove('on');
      el.hidden = true;
    }, 2000);
  }

  /* ---------- 衣橱槽位 ---------- */
  function preset() {
    var all = window.WD_PRESETS || {};
    return all[S.modelId] || null;
  }

  function slotDef(p, slotId) {
    var hit = null;
    ((p && p.slots) || []).forEach(function (s) { if (s.id === slotId) hit = s; });
    return hit;
  }

  function itemOf(slot, itemId) {
    var hit = null;
    (slot.items || []).forEach(function (it) { if (it.id === itemId) hit = it; });
    return hit || (slot.items || [])[0] || null;
  }

  /* 把 look 展开成最终的 hidden / shown / params；look 里没有的槽位用默认项 */
  function compose() {
    var p = preset();
    var hidden = p && p.defaultHidden ? p.defaultHidden.slice() : [];
    var show = [];
    var params = {};
    ((p && p.slots) || []).forEach(function (slot) {
      var it = itemOf(slot, S.look[slot.id]);
      if (!it) return;
      if (it.hide) hidden = hidden.concat(it.hide);
      if (it.show) show = show.concat(it.show);
      if (it.params) Object.keys(it.params).forEach(function (k) { params[k] = it.params[k]; });
    });
    hidden = hidden.concat(S.extra);
    show = show.concat(S.showManual);
    var showSet = {};
    var showList = [];
    show.forEach(function (id) {
      if (!id || showSet[id]) return;
      showSet[id] = 1;
      showList.push(id);
    });
    var seen = {};
    S.hidden = hidden.filter(function (id) {
      if (!id || seen[id] || showSet[id]) return false;
      seen[id] = 1;
      return true;
    });
    S.showParts = showList;
    S.params = params;
  }

  function applyLook() {
    compose();
    if (S.rig) {
      S.rig.setHidden(S.hidden);
      S.rig.setShown(S.showParts);
      S.rig.setParams(S.params);
    }
    saveState();
    syncHiddenUI();
  }

  function choose(slotId, itemId) {
    var slot = slotDef(preset(), slotId);
    if (!slot) return;
    var it = itemOf(slot, itemId);
    if (!it) return;
    S.look[slotId] = it.id;
    S.activeId = '';
    /* 换了槽位就清掉这一槽位相关的手动微调，避免旧部件残留 */
    var rel = {};
    (slot.items || []).forEach(function (x) {
      (x.hide || []).forEach(function (id) { rel[id] = 1; });
      (x.show || []).forEach(function (id) { rel[id] = 1; });
    });
    if (Object.keys(rel).length) {
      S.extra = S.extra.filter(function (id) { return !rel[id]; });
      S.showManual = S.showManual.filter(function (id) { return !rel[id]; });
    }
    applyLook();
    renderSlots();
    renderOutfits();
    toast(slot.label + '：' + it.name);
  }

  function resetLook(silent) {
    S.look = {};
    S.extra = [];
    S.showManual = [];
    S.activeId = '';
    applyLook();
    renderSlots();
    renderOutfits();
    renderParts();
    if (!silent) toast('已恢复默认搭配');
  }

  function renderSlots() {
    var box = S.refs.slots;
    if (!box) return;
    var p = preset();
    if (!p) {
      box.innerHTML = '<p class="wd-empty">这个皮套没有作者预留的换装槽位。</p>';
      if (S.refs.note) S.refs.note.textContent = '';
      if (S.refs.slotCount) S.refs.slotCount.textContent = '';
      return;
    }
    if (S.refs.note) S.refs.note.textContent = p.note || '';
    if (S.refs.slotCount) S.refs.slotCount.textContent = p.slots.length + ' 组';

    var html = '';
    p.slots.forEach(function (slot) {
      var cur = itemOf(slot, S.look[slot.id]);
      var curId = cur ? cur.id : '';
      html += '<section class="wd-slot" data-slot="' + esc(slot.id) + '">' +
        '<div class="wd-slot-h"><b>' + esc(slot.label) + '</b><span>' +
          esc(cur ? cur.name : '—') + '</span></div>' +
        '<div class="wd-opts">';
      (slot.items || []).forEach(function (it) {
        html += '<button type="button" class="wd-opt' + (it.id === curId ? ' is-on' : '') +
          '" data-slot="' + esc(slot.id) + '" data-item="' + esc(it.id) + '">' +
          esc(it.name) + '</button>';
      });
      html += '</div></section>';
    });
    box.innerHTML = html;
  }

  /* ---------- 高级：部件微调 ---------- */
  function hiddenMap() {
    var m = {};
    (S ? S.hidden : []).forEach(function (id) { m[id] = 1; });
    return m;
  }

  function syncHiddenUI() {
    var hidden = hiddenMap();
    var all = S.rig ? S.rig.parts() : [];
    var n = 0;
    all.forEach(function (p) { if (hidden[p.id]) n++; });

    if (S.refs.hiddenCount) {
      S.refs.hiddenCount.textContent = n ? ('隐藏 ' + n) : '隐藏 0';
    }
    if (S.refs.partCount) {
      S.refs.partCount.textContent = '部件 ' + all.length + (n ? ' · 隐藏 ' + n : '');
    }
    if (S.refs.outfitCount) S.refs.outfitCount.textContent = String(S.outfits.length);

    /* 只同步勾选与灰态，不重建列表 —— 保住滚动位置 */
    var inputs = S.refs.parts ? S.refs.parts.querySelectorAll('input[data-pid]') : [];
    for (var i = 0; i < inputs.length; i++) {
      var id = inputs[i].getAttribute('data-pid');
      var on = !hidden[id];
      inputs[i].checked = on;
      var row = inputs[i].closest ? inputs[i].closest('.wd-part') : null;
      if (row) row.classList.toggle('is-off', !on);
    }
  }

  function groupParts(list) {
    var buckets = PART_CATS.map(function (c) { return { cat: c, items: [] }; });
    list.forEach(function (p) {
      for (var i = 0; i < buckets.length; i++) {
        if (buckets[i].cat.re.test(p.name) || buckets[i].cat.re.test(p.id)) {
          buckets[i].items.push(p);
          return;
        }
      }
    });
    return buckets.filter(function (b) { return b.items.length; });
  }

  function renderParts() {
    var box = S.refs.parts;
    if (!box) return;
    var all = S.rig ? S.rig.parts() : [];
    var hidden = hiddenMap();
    var q = (S.refs.search && S.refs.search.value || '').trim().toLowerCase();

    if (!all.length) {
      box.innerHTML = '<p class="wd-empty">' +
        (S.loading ? '正在读取部件…' : '这个皮套没有可列出的部件') + '</p>';
      return;
    }

    var list = all.filter(function (p) {
      if (!q) return true;
      return p.name.toLowerCase().indexOf(q) >= 0 || p.id.toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      box.innerHTML = '<p class="wd-empty">没有匹配「' + esc(q) + '」的部件</p>';
      return;
    }

    var html = '';
    groupParts(list).forEach(function (g) {
      html += '<section class="wd-group">' +
        '<h4 class="wd-group-h"><span>' + esc(g.cat.label) + '</span><i>' + g.items.length + '</i></h4>';
      g.items.forEach(function (p) {
        var on = !hidden[p.id];
        html += '<div class="wd-part' + (on ? '' : ' is-off') + '" data-pid="' + esc(p.id) + '">' +
          '<label class="wd-part-main">' +
            '<input type="checkbox" data-pid="' + esc(p.id) + '"' + (on ? ' checked' : '') +
              ' aria-label="显示 ' + esc(p.name) + '">' +
            '<span class="wd-part-name">' + esc(p.name) + '</span>' +
            '<span class="wd-part-id">' + esc(p.id) + '</span>' +
          '</label>' +
          '<button type="button" class="wd-part-solo" data-solo="' + esc(p.id) + '" title="只显示这一件">只</button>' +
        '</div>';
      });
      html += '</section>';
    });
    box.innerHTML = html;
  }

  function togglePart(id, show) {
    if (!id) return;
    if (show) {
      S.extra = S.extra.filter(function (x) { return x !== id; });
      S.showManual = S.showManual.filter(function (x) { return x !== id; });
      /* 槽位本身会隐藏它：记一条「强制显示」 */
      if (S.hidden.indexOf(id) >= 0) S.showManual.push(id);
    } else {
      S.showManual = S.showManual.filter(function (x) { return x !== id; });
      if (S.extra.indexOf(id) < 0) S.extra.push(id);
    }
    S.activeId = '';
    applyLook();
  }

  function isolatePart(id) {
    if (!id) return;
    var all = S.rig ? S.rig.parts() : [];
    var base = S.hidden.filter(function (x) { return x !== id; });
    var baseSet = {};
    base.forEach(function (x) { baseSet[x] = 1; });
    S.extra = all.filter(function (p) { return p.id !== id && !baseSet[p.id]; })
      .map(function (p) { return p.id; });
    S.showManual = [id];
    S.activeId = '';
    applyLook();
    renderParts();
    var name = id;
    all.forEach(function (p) { if (p.id === id) name = p.name; });
    toast('只显示：' + name);
  }

  /* ---------- 套装 ---------- */
  function activeOutfit() {
    var hit = null;
    S.outfits.forEach(function (o) { if (o.id === S.activeId) hit = o; });
    return hit;
  }

  function outfitSummary(o) {
    var p = (window.WD_PRESETS || {})[o.modelId] || null;
    if (!p) return '';
    var names = [];
    p.slots.forEach(function (slot) {
      var it = itemOf(slot, (o.look || {})[slot.id]);
      if (!it) return;
      var first = (slot.items || [])[0];
      if (first && it.id === first.id) return;
      names.push(it.name);
    });
    var n = (o.extra || []).length;
    if (n) names.push('微调 ' + n);
    return names.join(' · ');
  }

  function saveOutfit(name) {
    var nm = String(name || '').trim();
    if (!nm) nm = '套装 ' + (S.outfits.length + 1);
    var o = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: nm.slice(0, 16),
      modelId: S.modelId,
      look: Object.assign({}, S.look),
      extra: S.extra.slice(),
      shown: S.showParts.slice(),
      showManual: S.showManual.slice(),
      hidden: S.hidden.slice(),
      params: Object.assign({}, S.params),
      ts: Date.now()
    };
    S.outfits.unshift(o);
    S.activeId = o.id;
    S.refs.outfitName.value = '';
    saveState();
    renderOutfits();
    syncHiddenUI();
    toast('已保存套装：' + o.name);
  }

  function removeOutfit(id) {
    var gone = null;
    S.outfits = S.outfits.filter(function (o) {
      if (o.id === id) { gone = o; return false; }
      return true;
    });
    if (!gone) return;
    if (S.activeId === id) S.activeId = '';
    saveState();
    renderOutfits();
    toast('已删除套装：' + gone.name);
  }

  function wearOutfit(id, toHuman) {
    var o = null;
    S.outfits.forEach(function (x) { if (x.id === id) o = x; });
    if (!o) return;

    S.activeId = o.id;
    S.look = Object.assign({}, o.look);
    S.extra = o.extra.slice();
    S.showManual = (o.showManual || []).slice();
    compose();
    renderSlots();

    function after() {
      if (S.rig) {
        S.rig.setHidden(S.hidden);
        S.rig.setShown(S.showParts);
        S.rig.setParams(S.params);
      }
      saveState();
      renderParts();
      syncHiddenUI();
      if (toHuman) pushToHuman(o.name);
      else toast('试穿：' + o.name);
    }

    if (o.modelId && o.modelId !== S.modelId) {
      S.modelId = o.modelId;
      if (S.refs.modelSel) S.refs.modelSel.value = o.modelId;
      loadModel(o.modelId, after);
      return;
    }

    renderOutfits();
    after();
  }

  function renderOutfits() {
    var box = S.refs && S.refs.outfits;
    if (!box) return;
    if (S.refs.outfitCount) S.refs.outfitCount.textContent = String(S.outfits.length);
    if (!S.outfits.length) {
      box.innerHTML = '<p class="wd-empty">还没有套装。在右边衣橱里挑好，点「保存当前」。</p>';
      return;
    }
    var html = '';
    S.outfits.forEach(function (o) {
      var sum = outfitSummary(o);
      html += '<article class="wd-outfit' + (o.id === S.activeId ? ' is-on' : '') + '" data-oid="' + esc(o.id) + '">' +
        '<div class="wd-outfit-top">' +
          '<b>' + esc(o.name) + '</b>' +
          '<span>' + esc(modelName(o.modelId) || '未记录皮套') + '</span>' +
        '</div>' +
        '<div class="wd-outfit-meta">' + esc(sum || '默认搭配') + '</div>' +
        '<div class="wd-outfit-acts">' +
          '<button type="button" class="wd-mini" data-human="' + esc(o.id) + '">穿上</button>' +
          '<button type="button" class="wd-mini ghost" data-del="' + esc(o.id) + '" title="删除套装">删除</button>' +
        '</div>' +
      '</article>';
    });
    box.innerHTML = html;
  }

  /* 把当前搭配同步给数字人；数字人开着就即时生效，没开就等它下次启动读 draft */
  function pushToHuman(name) {
    var payload = {
      name: name || '当前搭配',
      modelId: S.modelId,
      hidden: S.hidden.slice(),
      shown: S.showParts.slice(),
      params: Object.assign({}, S.params)
    };
    saveState();
    var fn = window.__l2dApplyOutfit;
    if (typeof fn === 'function') {
      fn(payload);
      toast('数字人已穿上：' + payload.name);
    } else {
      toast('已保存搭配，打开「数字人」就会穿上');
    }
  }

  /* 探针只读钩子：无头测试读槽位、参数、隐藏状态与存档用 */
  function installProbe() {
    if (!window.__wdRig) {
      window.__wdRig = function () {
        if (!S) return null;
        var info = S.rig ? S.rig.info() : { ready: false, loading: true, error: '', parts: [], hidden: [] };
        return {
          ready: !!info.ready,
          loading: !!info.loading,
          error: info.error || '',
          modelId: S.modelId,
          parts: (info.parts || []).map(function (p) { return { id: p.id, name: p.name }; }),
          partCount: (info.parts || []).length,
          look: Object.assign({}, S.look),
          hidden: S.hidden.slice(),
          shown: S.showParts.slice(),
          applied: (info.hidden || []).slice(),
          params: Object.assign({}, S.params),
          activeId: S.activeId,
          outfits: S.outfits.map(function (o) {
            return {
              id: o.id, name: o.name, modelId: o.modelId,
              look: Object.assign({}, o.look), hidden: o.hidden.slice(), params: Object.assign({}, o.params)
            };
          })
        };
      };
    }
    if (!window.__wdPartOpacity) {
      window.__wdPartOpacity = function (id) {
        return S && S.rig ? S.rig.partOpacity(id) : null;
      };
    }
    if (!window.__wdParam) {
      window.__wdParam = function (id) {
        return S && S.rig ? S.rig.paramValue(id) : null;
      };
    }
    if (!window.__wdState) {
      window.__wdState = function () { return readJson(STORE_KEY); };
    }
    if (!window.__wdModel) {
      window.__wdModel = function () { return S && S.rig ? S.rig.model() : null; };
    }
  }

  /* ---------- 注册 ---------- */
  registerApp({
    id: 'wardrobe',
    name: '衣柜',
    title: '衣柜 · 真实换装',
    sub: '作者预留的配饰 / 道具 / 配色开关，存套装',
    icon: ICON,
    order: 17,
    cls: 'wardrobe',
    win: 'wardrobeWin',
    css: ['apps/wardrobe/app.css'],
    scripts: ['apps/wardrobe/presets.js', 'apps/wardrobe/rig.js'],
    body: BODY_HTML,
    mount: function (body) {
      if (body.dataset.ready === '1' && S && S.body === body) {
        /* 切回来只同步状态与尺寸，不重建 DOM，预览也不重载 */
        syncHiddenUI();
        setStageState();
        if (S.rig) S.rig.fit();
        return;
      }
      boot(body);
    }
  });
})();
