/* 衣柜 —— 数字人皮套的换装台。
 *
 * 左边套装、中间预览、右边部件。皮套清单与数据包都复用数字人 App 的
 * apps/live2d/model/（由 tools/pack-live2d.js 生成），预览运行时是 rig.js 的
 * window.WD_RIG —— 这个文件只管界面与状态，不直接碰 Cubism。
 *
 * 数据只存本机：
 *   hf_wardrobe_state = {
 *     v: 1,
 *     modelId,                    // 上次预览的皮套
 *     activeId,                   // 最近穿上的套装（仅用于高亮）
 *     outfits: [{ id, name, modelId, hidden: [partId], ts }],
 *     draft: { modelId, hidden }  // 当前搭配：数字人启动时按它穿
 *   }
 *
 * 「应用到数字人」写 draft 并调 window.__l2dApplyOutfit（数字人开着就即时生效，
 * 没开就等它下次启动读 draft）。部件隐藏靠 Cubism 的部件透明度实现。
 * 扩展点：PART_CATS 里加一条正则就有新分组；新的换装维度在 rig.js 上开方法。
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
  var STORE_VER = 1;
  var L2D_KEY = 'hf_live2d_state';

  /* 部件分组：按 cdi3 的中文名归类；匹配不到落到「其他」。
     想加一类（比如「尾巴」「翅膀」）在这里插一条正则即可。 */
  var PART_CATS = [
    { key: 'hair', label: '头发 / 头饰', re: /发|角|耳|帽|头饰|蝴蝶结|呆毛|兽耳/ },
    { key: 'face', label: '面部 / 表情', re: /脸|眉|眼|嘴|口|腮|舌|泪|痣|表情/ },
    { key: 'hand', label: '手 / 手臂', re: /手|爪|臂|指|腕/ },
    { key: 'cloth', label: '服装', re: /衣|裙|裤|袜|鞋|领|袖|披风|围巾|制服|泳装/ },
    { key: 'prop', label: '道具 / 场景', re: /饭|板|手机|包|桌|杯|盘|笔|书|伞|道具|麦克风|椅|床/ },
    { key: 'fx', label: '特效 / 贴图', re: /特效|贴图|光|晕|符号|背景|阴影/ },
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

  /* ---------- 存档 ---------- */
  function loadState() {
    var out = { modelId: '', activeId: '', outfits: [], draft: null };
    var d = readJson(STORE_KEY);
    if (!d || d.v !== STORE_VER) {
      /* 第一次用衣柜：沿用数字人当前的皮套，不硬切回第一套 */
      var l2 = readJson(L2D_KEY);
      if (l2 && typeof l2.modelId === 'string') out.modelId = l2.modelId;
      return out;
    }
    if (typeof d.modelId === 'string') out.modelId = d.modelId;
    if (typeof d.activeId === 'string') out.activeId = d.activeId;
    if (d.draft && typeof d.draft === 'object') {
      out.draft = {
        modelId: typeof d.draft.modelId === 'string' ? d.draft.modelId : '',
        hidden: cleanIds(d.draft.hidden)
      };
    }
    if (Array.isArray(d.outfits)) {
      out.outfits = d.outfits.filter(function (o) {
        return o && typeof o.id === 'string' && o.id;
      }).map(function (o) {
        return {
          id: o.id,
          name: String(o.name || '未命名').slice(0, 16),
          modelId: typeof o.modelId === 'string' ? o.modelId : '',
          hidden: cleanIds(o.hidden),
          ts: Number(o.ts) || 0
        };
      }).slice(0, 60);
    }
    if (out.activeId && !out.outfits.some(function (o) { return o.id === out.activeId; })) {
      out.activeId = '';
    }
    return out;
  }

  function saveState() {
    if (!S) return;
    var payload = {
      v: STORE_VER,
      modelId: S.modelId || '',
      activeId: S.activeId || '',
      outfits: S.outfits.map(function (o) {
        return { id: o.id, name: o.name, modelId: o.modelId, hidden: o.hidden.slice(), ts: o.ts };
      }),
      draft: { modelId: S.modelId || '', hidden: S.hidden.slice() }
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch (e) { /* 配额满就只留在内存里 */ }
  }

  /* ---------- 启动 ---------- */
  function boot(body) {
    var loaded = loadState();

    S = {
      body: body,
      win: body.closest ? body.closest('.os-win') : null,
      models: [],
      modelId: loaded.modelId || '',
      hidden: loaded.draft ? loaded.draft.hidden.slice() : [],
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
      S.models = (models || []).filter(function (m) { return m && m.id && m.pack; });
      renderModels();
      if (!S.models.length) {
        S.loading = false;
        S.error = '没有可用的皮套：把模型放进 apps/live2d/model/<id>/ 后跑 node tools/pack-live2d.js';
        setStageState();
        return;
      }

      var def = null;
      S.models.forEach(function (m) { if (m.id === S.modelId) def = m; });
      if (!def) {
        def = S.models[0];
        S.modelId = def.id;
        /* 皮套变了，旧部件的隐藏状态没有意义 */
        S.hidden = [];
        S.activeId = '';
      }
      if (S.refs.modelSel) S.refs.modelSel.value = S.modelId;
      S.rig.setHidden(S.hidden);
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
      showAll: b.querySelector('#wdShowAll'),
      partCount: b.querySelector('#wdPartCount'),
      toast: b.querySelector('#wdToast'),
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

    r.showAll.addEventListener('click', function () {
      clearHidden();
    });
    r.reset.addEventListener('click', function () {
      r.search.value = '';
      clearHidden();
      renderParts();
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
    S.rig.setHidden(S.hidden);

    S.rig.load(id).then(function (info) {
      if (seq !== S.loadSeq) return;
      S.loading = false;
      S.ready = !!(info && info.ready);
      S.error = (info && info.error) || '';
      if (info && info.modelId) S.modelId = info.modelId;
      if (S.refs.modelSel) S.refs.modelSel.value = S.modelId;
      if (S.ready) S.rig.setHidden(S.hidden);
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
    S.hidden = [];
    S.activeId = '';
    if (S.rig) S.rig.setHidden([]);
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

  /* ---------- 部件 ---------- */
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
      S.refs.hiddenCount.textContent = n ? ('隐藏 ' + n) : '全部显示';
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
    renderOutfits();
  }

  function groupParts(list) {
    var buckets = PART_CATS.map(function (c) { return { cat: c, items: [] }; });
    list.forEach(function (p) {
      for (var i = 0; i < buckets.length; i++) {
        if (buckets[i].cat.re.test(p.name)) { buckets[i].items.push(p); return; }
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

  /* 手改过部件就不再属于某个套装，清掉高亮 */
  function markDirty() {
    S.activeId = '';
  }

  function applyHidden() {
    if (S.rig) S.rig.setHidden(S.hidden);
    saveState();
    syncHiddenUI();
  }

  function togglePart(id, show) {
    var set = {};
    S.hidden.forEach(function (x) { set[x] = 1; });
    if (show) delete set[id]; else set[id] = 1;
    S.hidden = Object.keys(set);
    markDirty();
    applyHidden();
  }

  function clearHidden() {
    if (!S.hidden.length) { renderParts(); return; }
    S.hidden = [];
    markDirty();
    applyHidden();
    renderParts();
    toast('已显示全部部件');
  }

  function isolatePart(id) {
    if (!id) return;
    var all = S.rig ? S.rig.parts() : [];
    S.hidden = all.filter(function (p) { return p.id !== id; }).map(function (p) { return p.id; });
    markDirty();
    applyHidden();
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

  function saveOutfit(name) {
    var nm = String(name || '').trim();
    if (!nm) nm = '套装 ' + (S.outfits.length + 1);
    var o = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: nm.slice(0, 16),
      modelId: S.modelId,
      hidden: S.hidden.slice(),
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
    if (S.refs.outfitCount) S.refs.outfitCount.textContent = String(S.outfits.length);
    toast('已删除套装：' + gone.name);
  }

  function wearOutfit(id, toHuman) {
    var o = null;
    S.outfits.forEach(function (x) { if (x.id === id) o = x; });
    if (!o) return;

    S.activeId = o.id;
    S.hidden = o.hidden.slice();
    if (S.rig) S.rig.setHidden(S.hidden);
    saveState();
    renderOutfits();
    syncHiddenUI();

    if (o.modelId && o.modelId !== S.modelId) {
      S.modelId = o.modelId;
      if (S.refs.modelSel) S.refs.modelSel.value = o.modelId;
      loadModel(o.modelId, function () {
        if (S.rig) S.rig.setHidden(S.hidden);
        saveState();
        syncHiddenUI();
        renderParts();
        if (toHuman) pushToHuman(o.name);
        else toast('试穿：' + o.name);
      });
      return;
    }

    if (S.rig) S.rig.setHidden(S.hidden);
    renderParts();
    syncHiddenUI();
    if (toHuman) pushToHuman(o.name);
    else toast('试穿：' + o.name);
  }

  function renderOutfits() {
    var box = S.refs && S.refs.outfits;
    if (!box) return;
    if (S.refs.outfitCount) S.refs.outfitCount.textContent = String(S.outfits.length);
    if (!S.outfits.length) {
      box.innerHTML = '<p class="wd-empty">还没有套装。调好部件后点「保存当前」。</p>';
      return;
    }
    var html = '';
    S.outfits.forEach(function (o) {
      var n = o.hidden.length;
      html += '<article class="wd-outfit' + (o.id === S.activeId ? ' is-on' : '') + '" data-oid="' + esc(o.id) + '">' +
        '<div class="wd-outfit-top">' +
          '<b>' + esc(o.name) + '</b>' +
          '<span>' + (n ? ('隐藏 ' + n) : '全套') + '</span>' +
        '</div>' +
        '<div class="wd-outfit-meta">' + esc(modelName(o.modelId) || '未记录皮套') + '</div>' +
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
      hidden: S.hidden.slice()
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

  /* 探针只读钩子：无头测试读部件、隐藏状态与存档用 */
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
          hidden: S.hidden.slice(),
          applied: (info.hidden || []).slice(),
          activeId: S.activeId,
          outfits: S.outfits.map(function (o) {
            return { id: o.id, name: o.name, modelId: o.modelId, hidden: o.hidden.slice() };
          })
        };
      };
    }
    if (!window.__wdPartOpacity) {
      window.__wdPartOpacity = function (id) {
        return S && S.rig ? S.rig.partOpacity(id) : null;
      };
    }
    if (!window.__wdState) {
      window.__wdState = function () { return readJson(STORE_KEY); };
    }
  }

  /* ---------- 注册 ---------- */
  registerApp({
    id: 'wardrobe',
    name: '衣柜',
    title: '衣柜 · 数字人皮套',
    sub: '换皮套、挑部件、存套装',
    icon: ICON,
    order: 17,
    cls: 'wardrobe',
    win: 'wardrobeWin',
    css: ['apps/wardrobe/app.css'],
    scripts: ['apps/wardrobe/rig.js'],
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
