/* ============================================================
 * 设置 · 语言模型池
 *
 * 为什么单独一份：
 *   路由层 js/llm-router.js 早已支持多套凭据（hf_llm_keys）与按空闲度分配，
 *   但设置页只展示了「当前配置」一条，用户没有地方增删其余模型，也看不到
 *   某条模型现在是在跑还是闲着。这里只做两件事：
 *     ① 让用户配置复数的语言模型（增 / 改 / 删 / 启停）；
 *     ② 定时读 LLMRouter.stats()，把「空闲 / 工作中 / 冷却 / 停用」显示出来。
 *
 * 三条约束：
 *   ① 不另存一份配置：列表与状态全部来自 LLMRouter，页面只做渲染。
 *      「当前配置」这条来自设置页隐藏 input，不可删、不可在此编辑（去对话条改）。
 *   ② 轮询只在「设置打开 + 停在语言模型页」时执行，关掉设置就跳过。
 *   ③ 状态变（inflight / cooldown）只改角标文字，不重建整行，
 *      否则用户正在点「启用」或「编辑」时会被重绘打断。
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var bound = false;
  var editingId = null;
  var listSig = '';
  var timer = null;
  var POLL_MS = 1500;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hostOf(u) {
    var s = String(u || '').trim();
    if (!s) return '未填地址';
    try { return new URL(s).host || s; } catch (e) { return s.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''); }
  }

  function parseApps(v) {
    return String(v || '').split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function msg(text) {
    var el = $('llmPoolMsg');
    if (el) el.textContent = text || '';
  }

  function router() {
    return (typeof window.LLMRouter !== 'undefined' && window.LLMRouter) || null;
  }

  /* ---------------- 状态判定 ---------------- */

  function stateOf(e) {
    if (!e.enabled) return { cls: 'off', text: '停用' };
    if (e.cooldownLeft > 0) return { cls: 'cool', text: '冷却 ' + Math.ceil(e.cooldownLeft / 1000) + 's' };
    if (e.inflight > 0) return { cls: 'busy', text: '工作中 ' + e.inflight + '/' + e.maxConcurrent };
    return { cls: 'idle', text: '空闲' };
  }

  function sourceTag(e) {
    if (e.id === '__gateway__') return '云端网关';
    if (e.id === '__config__') return '当前配置';
    return '模型池';
  }

  function subHtml(e) {
    var bits = [hostOf(e.base), e.model || '未填模型'];
    if (e.key) bits.push(e.key);
    bits.push('并发 ' + e.inflight + '/' + e.maxConcurrent);
    bits.push(e.apps && e.apps.length ? 'App: ' + e.apps.join(', ') : 'App: 全部');
    if (e.cooldownLeft > 0) bits.push('冷却剩余 ' + Math.ceil(e.cooldownLeft / 1000) + 's');
    if (e.lastError) bits.push('最近错误：' + e.lastError);
    return bits.map(esc).join(' · ');
  }

  /* ---------------- 列表 ---------------- */

  function actsHtml(e) {
    if (e.id === '__gateway__') return '';
    if (e.id === '__config__') return '<button type="button" class="linkbtn" data-act="cfg">去配置</button>';
    return '<label class="sf-inline"><input type="checkbox" data-act="toggle"' + (e.enabled ? ' checked' : '') + '> 启用</label>'
      + '<button type="button" class="linkbtn" data-act="edit">编辑</button>'
      + '<button type="button" class="linkbtn" data-act="del">删除</button>';
  }

  function rowHtml(e) {
    var s = stateOf(e);
    return '<div class="llm-pool-row' + (e.enabled ? '' : ' is-off') + '" data-id="' + esc(e.id) + '">'
      + '<span class="llm-pool-dot ' + s.cls + '"></span>'
      + '<div class="llm-pool-main">'
      + '<div class="llm-pool-title">'
      + '<span class="llm-pool-name">' + esc(e.label) + '</span>'
      + '<span class="llm-pool-badge ' + s.cls + '">' + esc(s.text) + '</span>'
      + '<span class="llm-pool-src">' + esc(sourceTag(e)) + '</span>'
      + '</div>'
      + '<div class="llm-pool-sub">' + subHtml(e) + '</div>'
      + '</div>'
      + '<div class="llm-pool-acts">' + actsHtml(e) + '</div>'
      + '</div>';
  }

  function renderList(list) {
    var box = $('llmPoolList');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="empty">还没配置语言模型：先在对话输入条里填一套，或在下面添加。</div>';
      return;
    }
    box.innerHTML = list.map(rowHtml).join('');
  }

  function paintRow(row, e) {
    var s = stateOf(e);
    row.classList.toggle('is-off', !e.enabled);
    var dot = row.querySelector('.llm-pool-dot');
    if (dot) dot.className = 'llm-pool-dot ' + s.cls;
    var badge = row.querySelector('.llm-pool-badge');
    if (badge) {
      badge.className = 'llm-pool-badge ' + s.cls;
      badge.textContent = s.text;
    }
    var sub = row.querySelector('.llm-pool-sub');
    if (sub) sub.innerHTML = subHtml(e);
  }

  function paint() {
    var box = $('llmPoolList');
    var r = router();
    if (!box || !r || typeof r.stats !== 'function') {
      if (box) box.innerHTML = '<div class="empty">路由层未就绪，无法读取模型池。</div>';
      return;
    }
    var list = r.stats() || [];
    /* 只有「条目本身」变了才重建；inflight / cooldown 这类高频变化只改文字 */
    var sig = list.map(function (e) {
      return [e.id, e.label, e.base, e.model, e.key, e.apps.join(','), e.maxConcurrent, e.enabled ? 1 : 0].join('\u0001');
    }).join('\u0002');
    if (sig !== listSig) {
      listSig = sig;
      renderList(list);
    }
    list.forEach(function (e) {
      var row = box.querySelector('.llm-pool-row[data-id="' + e.id + '"]');
      if (row) paintRow(row, e);
    });
  }

  /* ---------------- 表单 ---------------- */

  function resetForm() {
    editingId = null;
    ['llmPoolLabel', 'llmPoolModel', 'llmPoolBase', 'llmPoolKey', 'llmPoolApps'].forEach(function (id) {
      var el = $(id);
      if (el) el.value = '';
    });
    var max = $('llmPoolMax');
    if (max) max.value = '2';
    var add = $('llmPoolAdd');
    if (add) add.textContent = '添加到模型池';
    var cancel = $('llmPoolCancel');
    if (cancel) cancel.classList.add('hidden');
  }

  function startEdit(id) {
    var r = router();
    if (!r) return;
    var raw = (r.extras() || []).filter(function (e) { return e.id === id; })[0];
    if (!raw) { msg('找不到这条模型：' + id); return; }
    editingId = id;
    if ($('llmPoolLabel')) $('llmPoolLabel').value = raw.label || '';
    if ($('llmPoolModel')) $('llmPoolModel').value = raw.model || '';
    if ($('llmPoolBase')) $('llmPoolBase').value = raw.base || '';
    if ($('llmPoolKey')) $('llmPoolKey').value = raw.key || '';
    if ($('llmPoolApps')) $('llmPoolApps').value = (raw.apps || []).join(', ');
    if ($('llmPoolMax')) $('llmPoolMax').value = String(raw.maxConcurrent || 2);
    var add = $('llmPoolAdd');
    if (add) add.textContent = '保存修改';
    var cancel = $('llmPoolCancel');
    if (cancel) cancel.classList.remove('hidden');
    msg('正在编辑：' + (raw.label || id));
  }

  function submit() {
    var r = router();
    if (!r) { msg('路由层未就绪，无法保存。'); return; }
    var entry = {
      label: String($('llmPoolLabel') ? $('llmPoolLabel').value : '').trim() || '备用模型',
      base: String($('llmPoolBase') ? $('llmPoolBase').value : '').trim(),
      key: String($('llmPoolKey') ? $('llmPoolKey').value : '').trim(),
      model: String($('llmPoolModel') ? $('llmPoolModel').value : '').trim(),
      apps: parseApps($('llmPoolApps') ? $('llmPoolApps').value : ''),
      maxConcurrent: Math.max(1, Math.min(16, Number($('llmPoolMax') ? $('llmPoolMax').value : 2) || 2))
    };
    if (!entry.base || !entry.key || !entry.model) {
      msg('接口地址、Key、模型名都要填。');
      return;
    }
    try {
      if (editingId) {
        r.update(editingId, entry);
        msg('已保存：' + entry.label);
      } else {
        r.add(entry);
        msg('已加入模型池：' + entry.label);
      }
      resetForm();
      listSig = '';
      paint();
      if (window.settingsHome && typeof window.settingsHome.refresh === 'function') window.settingsHome.refresh();
    } catch (e) {
      msg('保存失败：' + ((e && e.message) || e));
    }
  }

  function removeEntry(id) {
    var r = router();
    if (!r) return;
    var stat = (r.stats() || []).filter(function (e) { return e.id === id; })[0];
    var name = stat ? stat.label : id;
    if (typeof window.confirm === 'function' && !window.confirm('从模型池删除「' + name + '」？')) return;
    try {
      r.remove(id);
      if (editingId === id) resetForm();
      listSig = '';
      paint();
      msg('已删除：' + name);
      if (window.settingsHome && typeof window.settingsHome.refresh === 'function') window.settingsHome.refresh();
    } catch (e) {
      msg('删除失败：' + ((e && e.message) || e));
    }
  }

  function openConfig() {
    var d = window.deskChat;
    if (d && d.modelCfg && typeof d.modelCfg.open === 'function') d.modelCfg.open();
    else msg('请到对话输入条的「配置自定义模型」里修改当前配置。');
  }

  /* ---------------- 绑定与轮询 ---------------- */

  function visible() {
    var pane = document.querySelector('.tabpane[data-pane="llm"]');
    var back = $('settingsBackdrop');
    return !!(pane && !pane.classList.contains('hidden') && back && !back.classList.contains('hidden'));
  }

  function bindOnce() {
    if (bound) return;
    bound = true;

    if ($('llmPoolAdd')) $('llmPoolAdd').addEventListener('click', submit);
    if ($('llmPoolCancel')) $('llmPoolCancel').addEventListener('click', function () { resetForm(); msg(''); });

    var box = $('llmPoolList');
    if (box) {
      box.addEventListener('click', function (e) {
        var act = e.target && e.target.getAttribute ? e.target.getAttribute('data-act') : '';
        var row = e.target && e.target.closest ? e.target.closest('.llm-pool-row') : null;
        if (!act || !row) return;
        var id = row.getAttribute('data-id');
        if (act === 'edit') startEdit(id);
        else if (act === 'del') removeEntry(id);
        else if (act === 'cfg') openConfig();
      });
      box.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || t.getAttribute('data-act') !== 'toggle') return;
        var row = t.closest ? t.closest('.llm-pool-row') : null;
        if (!row) return;
        var r = router();
        if (!r) return;
        try {
          r.setEnabled(row.getAttribute('data-id'), !!t.checked);
          listSig = '';
          paint();
        } catch (err) {
          msg('启停失败：' + ((err && err.message) || err));
        }
      });
    }

    timer = setInterval(function () {
      if (visible()) paint();
    }, POLL_MS);
  }

  function llmPoolPaneRender() {
    if (!$('llmPoolList')) return;
    bindOnce();
    paint();
  }

  window.llmPoolPaneRender = llmPoolPaneRender;
})();
