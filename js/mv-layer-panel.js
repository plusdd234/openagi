/* ============================================================
 * 多视图 App · 图层面板（mv-layer-panel）
 *
 * 一行 = 一个效果。面板**倒着显示** state.layerOrder（上层在上，PS 直觉）。
 * 眼睛驱动的是隐藏 input 的 checked —— state 仍然只有那一条写入口。
 * 每层自己的属性面板里的控件是从 #mvPropPool 搬过去的（搬节点，不克隆）。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-layer-panel.js 必须在 mv-state.js 之后加载');

  var state = MV.state;
  var LAYER_META = MV.LAYER_META;
  var FIELDS = MV.FIELDS;
  var $ = MV.$;
  var cls = MV.cls;
  var esc = MV.esc;
  var saveSet = MV.saveSet;
  var scheduleRender = MV.scheduleRender;
  var render = MV.render;
  var defaultOpacity = MV.defaultOpacity;

  function fieldOf(k) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].k === k) return FIELDS[i];
    return null;
  }

  /* 面板上的显示顺序 = 绘制顺序反过来（后画的在上） */
  function layerView() {
    return MV.normalizeLayerOrder(state.layerOrder).slice().reverse();
  }

  /* 这一层有哪些数值参数（开关不算：开关就是行上那只眼睛）。
   * 顺序 = FIELDS 里的顺序，所以面板里的控件排布不用另外维护。 */
  function propsOf(k) {
    return FIELDS.filter(function (f) { return f.ly === k && f.ui && f.ui !== 'check'; });
  }

  /* 控件节点 = input 外面那层 .mv-field（整行带标签一起搬，不然只剩个滑条） */
  function fieldNode(f) {
    if (!f.id) return null;
    var el = $(f.id);
    if (!el) return null;
    return el.closest ? el.closest('.mv-field') : el.parentNode;
  }

  /* 把所有被搬进图层面板的控件收回池里。重建列表之前必须走一遍：
   * 设 innerHTML='' 会把面板连同里面的 input 一起扔掉，FIELDS 就再也找不到 id 了。 */
  function recycleProps() {
    var pool = $('mvPropPool');
    if (!pool) return;
    var nodes = document.querySelectorAll('.mv-ly-fields .mv-field');
    for (var i = 0; i < nodes.length; i++) pool.appendChild(nodes[i]);
  }

  /* 展开的那一层把它的控件搬进自己的面板，其余收回池里。
   * 搬节点而不是克隆：id 只能有一个，写入口也只能有一条。 */
  function syncProps() {
    var pool = $('mvPropPool');
    if (!pool) return;
    var open = state.openLayer || '';
    var panels = document.querySelectorAll('.mv-ly-props');
    for (var i = 0; i < panels.length; i++) {
      var k = panels[i].getAttribute('data-for');
      var isOpen = !!open && k === open;
      panels[i].hidden = !isOpen;
      cls(panels[i].previousElementSibling, 'is-open', isOpen);
      var offHint = panels[i].querySelector('.mv-ly-off-hint');
      if (offHint) offHint.hidden = !(isOpen && !state[LAYER_META[k].f]);
      if (!isOpen) {
        var inner = panels[i].querySelector('.mv-ly-fields');
        var kids = inner ? inner.querySelectorAll('.mv-field') : [];
        for (var j = 0; j < kids.length; j++) pool.appendChild(kids[j]);
        continue;
      }
      var box = panels[i].querySelector('.mv-ly-fields');
      if (!box) continue;
      propsOf(k).forEach(function (f) {
        var n = fieldNode(f);
        if (n) box.appendChild(n);       // 已经在里面就等价于挪到末尾，DOM 不会重复
      });
    }
  }

  function paintLayers() {
    var list = $('mvLayerList');
    if (!list) return;
    var view = layerView();

    /* 行按当前顺序排；数量不对就整片重建（拖拽过、或者存档里少一层） */
    if (list.children.length !== view.length * 2) {
      recycleProps();                    // 先救出控件，再清 DOM
      list.innerHTML = '';
      view.forEach(function (k) {
        var L = LAYER_META[k];
        var op = Math.round(state.opacity[k] == null ? 100 : state.opacity[k]);
        var row = document.createElement('div');
        row.className = 'mv-ly-item' + (L.fixed ? ' is-fixed' : '');
        row.setAttribute('data-ly', k);
        /* 固定位不给拖：后期处理层永远在最上面，背景层永远在最底下 */
        row.setAttribute('draggable', L.fixed ? 'false' : 'true');
        row.innerHTML = '<button type="button" class="mv-ly-eye" title="显示 / 隐藏这一层"></button>' +
          '<span class="mv-ly-name">' + esc(L.n) + '</span>' +
          '<span class="mv-ly-op-badge"' + (op >= 100 ? ' hidden' : '') + '>' + op + '%</span>' +
          '<span class="mv-ly-tag">' + L.tag + '</span>' +
          (L.fixed ? '<span class="mv-ly-lock" title="' +
            (L.fixed === 'bottom' ? '固定在最底层，不能拖动' : '固定在最上层，不能拖动') + '">' +
            (L.fixed === 'bottom' ? '底' : '顶') + '</span>' : '') +
          '<span class="mv-ly-caret" title="展开这一层的属性"></span>';
        list.appendChild(row);

        /* 每层一块自己的面板，紧跟在行下面（PS 里的「图层效果」那种形态）。
         * 控件是搬进来的，所以面板本身只有说明 + 一个空容器。
         * 不透明度是**每层都有**的，直接写死在面板里，不走 FIELDS 那套搬运。 */
        var props = document.createElement('div');
        props.className = 'mv-ly-props';
        props.setAttribute('data-for', k);
        props.hidden = true;
        props.innerHTML = '<div class="mv-ly-desc">' + esc(L.d || '') + '</div>' +
          /* 层关着的时候面板照样能调（先调好再打开是常用顺序），
           * 但得说清楚「现在看不到效果」，并给一个就地打开的入口。 */
          '<button type="button" class="mv-ly-off-hint" hidden>这一层是关着的 · 点这里打开</button>' +
          '<div class="mv-field mv-op">' +
            '<span>不透明度</span>' +
            '<input type="range" class="mv-op-range" data-ly-op="' + k + '" min="0" max="100" step="1" value="' + op + '">' +
            '<b class="mv-op-val">' + op + '%</b>' +
          '</div>' +
          '<div class="mv-ly-fields"></div>';
        list.appendChild(props);
      });
      bindLayerDrag(list);
    } else {
      /* 顺序变了（拖完）但数量没变：按 view 重排，不重建节点（保住 hover / 选中）。
       * 行和它的面板是一对，得成对搬，否则面板会跑到别的层下面去。 */
      view.forEach(function (k) {
        var row = list.querySelector('.mv-ly-item[data-ly="' + k + '"]');
        var props = list.querySelector('.mv-ly-props[data-for="' + k + '"]');
        if (row) list.appendChild(row);
        if (props) list.appendChild(props);
      });
    }

    view.forEach(function (k) {
      var L = LAYER_META[k];
      var row = list.querySelector('.mv-ly-item[data-ly="' + k + '"]');
      if (!row) return;
      cls(row, 'is-on', !!state[L.f]);
      cls(row, 'is-sel', state.selLayer === k);
      cls(row, 'is-open', state.openLayer === k);
      paintOpBadge(row, k);
    });
    syncProps();
  }

  /* 行上那个「50%」小标：满不透明时不显示（8 行全挂着 100% 纯属噪音） */
  function paintOpBadge(row, k) {
    if (!row) return;
    var badge = row.querySelector('.mv-ly-op-badge');
    if (!badge) return;
    var v = Math.round(state.opacity[k] == null ? 100 : state.opacity[k]);
    badge.textContent = v + '%';
    badge.hidden = v >= 100;
  }

  /* 面板里的不透明度滑条回填（第二次打开窗口时行是复用的，得刷一遍） */
  function syncOpacityUI() {
    var nodes = document.querySelectorAll('.mv-op-range');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-ly-op');
      if (!k) continue;
      var v = Math.round(state.opacity[k] == null ? 100 : state.opacity[k]);
      nodes[i].value = v;
      var b = nodes[i].parentNode.querySelector('.mv-op-val');
      if (b) b.textContent = v + '%';
      paintOpBadge(nodes[i].closest('.mv-ly-props').previousElementSibling, k);
    }
  }

  /* 点行：眼睛 = 开关，别处 = 选中。点击绑在容器上（事件委托），
   * 这样重排/重建都不用重新绑。 */
  function bindLayerDrag(list) {
    list.addEventListener('click', function (e) {
      /* 面板里的「这层是关着的」提示条：点一下就打开这一层 */
      var hint = e.target && e.target.closest ? e.target.closest('.mv-ly-off-hint') : null;
      if (hint) {
        var pk = hint.parentNode && hint.parentNode.getAttribute('data-for');
        var pf = pk && LAYER_META[pk] ? fieldOf(LAYER_META[pk].f) : null;
        var pb = pf && pf.id ? $(pf.id) : null;
        if (pb) { pb.checked = true; pb.dispatchEvent(new Event('change')); }
        return;
      }
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      var k = row.getAttribute('data-ly');
      var L = LAYER_META[k];
      if (!L) return;
      if (e.target.classList && e.target.classList.contains('mv-ly-eye')) {
        var f = fieldOf(L.f);
        var box = f && f.id ? $(f.id) : null;
        if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); }
        return;
      }
      /* 点行本身 = 展开/收起这一层自己的属性面板（展开的同时选中）。
       * 判断依据用 openLayer 而不是 selLayer：眼睛关掉一层会收起面板但保留高亮，
       * 那时若按 selLayer 判断，再点这一行会变成「取消选中」，看起来像点不动。
       * 每层都至少有不透明度，所以每层都能展开。 */
      if (state.openLayer === k) {
        state.openLayer = '';
        state.selLayer = '';
      } else {
        state.openLayer = k;
        state.selLayer = k;
      }
      paintLayers();
    });

    /* 面板里的「不透明度」滑条：也是事件委托（面板会被重建）。
     * 它不属于 FIELDS 那套一维字段，所以单独接；但落盘/重渲的口径跟别的滑条一样。 */
    list.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute || !el.getAttribute('data-ly-op')) return;
      var k = el.getAttribute('data-ly-op');
      var v = Math.max(0, Math.min(100, Math.round(Number(el.value) || 0)));
      if (!state.opacity) state.opacity = defaultOpacity();
      state.opacity[k] = v;
      var b = el.parentNode.querySelector('.mv-op-val');
      if (b) b.textContent = v + '%';
      paintOpBadge(el.closest('.mv-ly-props').previousElementSibling, k);
      saveSet(); scheduleRender();
    });

    /* 拖拽换序：只有同 tag（3D 之间 / 2D 之间）能换。
     * 跨 tag 时 dragover 不 preventDefault，浏览器自己就显示「禁止」光标。 */
    var dragK = '';
    list.addEventListener('dragstart', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      var k = row.getAttribute('data-ly');
      /* 固定位不给拖：后期处理层永远在最上面，背景层永远在最底下 */
      if (!k || !LAYER_META[k] || LAYER_META[k].fixed) { e.preventDefault(); return; }
      dragK = k;
      row.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragK); } catch (err) {}
      }
    });
    list.addEventListener('dragend', function () {
      dragK = '';
      var rows = list.querySelectorAll('.mv-ly-item');
      for (var i = 0; i < rows.length; i++) {
        cls(rows[i], 'is-dragging', false);
        cls(rows[i], 'is-drop-before', false);
        cls(rows[i], 'is-drop-after', false);
      }
    });
    list.addEventListener('dragover', function (e) {
      if (!dragK) return;
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      var k = row.getAttribute('data-ly');
      if (!k || !LAYER_META[k]) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var r = row.getBoundingClientRect();
      var after = e.clientY > r.top + r.height / 2;
      var rows = list.querySelectorAll('.mv-ly-item');
      for (var i = 0; i < rows.length; i++) {
        cls(rows[i], 'is-drop-before', false);
        cls(rows[i], 'is-drop-after', false);
      }
      cls(row, after ? 'is-drop-after' : 'is-drop-before', true);
    });
    list.addEventListener('drop', function (e) {
      if (!dragK) return;
      var row = e.target && e.target.closest ? e.target.closest('.mv-ly-item') : null;
      if (!row) return;
      e.preventDefault();
      var k = row.getAttribute('data-ly');
      if (!k) return;
      var r = row.getBoundingClientRect();
      var after = e.clientY > r.top + r.height / 2;
      moveLayer(dragK, k, after);
      dragK = '';
    });
  }

  /* 把 src 插到 dst 的前/后。返回 false = 同一个 / 认不出的层。
   * 3D 与 2D 之间**也能换**：渲染核会把相邻的 3D 层合成一段、渲完落到 2D 画布，
   * 中间的 2D 层插在两次渲染之间，所以顺序是真的。
   * 代价只有一个：交错的段数越多，每段多一次全屏渲染（默认顺序只有一段，不额外花钱）。 */
  function moveLayer(src, dst, after) {
    if (!src || !dst || src === dst) return false;
    if (!LAYER_META[src] || !LAYER_META[dst]) return false;
    /* 固定位不参与换序：后期处理层必须永远在最上面，背景层必须永远在最底下 */
    if (LAYER_META[src].fixed || LAYER_META[dst].fixed) return false;
    var view = layerView();
    var a = view.indexOf(src);
    var b = view.indexOf(dst);
    if (a < 0 || b < 0) return false;
    view.splice(a, 1);
    b = view.indexOf(dst);
    view.splice(after ? b + 1 : b, 0, src);
    state.layerOrder = view.slice().reverse();   // 存回「先画的在前」
    saveSet(); paintLayers(); render();
    return true;
  }

  /* 状态字段名 → 图层 key（'depthEdge' → 'dedge'）。图层表是唯一真源，反查一次即可，
   * 不在别处再维护一份对照。 */
  function layerKeyOf(f) {
    for (var k in LAYER_META) if (LAYER_META[k].f === f) return k;
    return '';
  }

  /* 关了某一层就顺手收起它的面板：眼睛亮不亮和面板开不开是两件事，
   * 但「关掉了还摊着一排参数」很容易以为它还生效。 */
  function closePropsIf(k) {
    if (k && state.openLayer === k) state.openLayer = '';
  }

  MV.fieldOf = fieldOf;
  MV.layerView = layerView;
  MV.paintLayers = paintLayers;
  MV.syncOpacityUI = syncOpacityUI;
  MV.moveLayer = moveLayer;
  MV.layerKeyOf = layerKeyOf;
  MV.closePropsIf = closePropsIf;
})();
