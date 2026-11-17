/* 贴图编辑层栈：底座留一份像素，编辑动作挂成可重放的「层」
 *
 * 为什么要有这层（2026-11-11 调研，docs/纹理系统-整合与架构兼容方案.html）：
 * 以前每个功能都把结果**写回** doc.materials.slotMaps。于是
 *   - 投射烘焙把「底图 + 岛」整张写回 → 混合层被烙进基础图 → 下次合成再叠一次（双份）
 *   - 只挂材质的资产（slotMaps 空）没有底座可写 → 一烘就把整片贴图洗成槽位灰
 *   - 每次操作都是一张 2048² 的 PNG，历史预算一撞车就把最老的丢掉
 * 改成「底座 + 层」之后，编辑只推一层（增量图，透明背景，体积是岛面积），
 * 「固化」才写一次 slotMaps。
 *
 * 层（op）按 type 分三类，合成顺序不同（见 md-texmix 的 composeOnto）：
 *   { type:'project', label, canvas, w, h, op }        —— 投射：属于底座，在混合层之下
 *   { type:'stroke', mode, canvas, w, h, op }          —— 画笔 / 橡皮：叠在混合层之上
 *   { type:'blur', radius, canvas, w, h, op }          —— 模糊：canvas 是笔刷遮罩，回放时糊当前结果
 *   canvas 是**只有这一层像素**的增量图（透明底），不是整张合成结果 ——
 *   存整张的话重放就退化成覆盖，等于又回到破坏性编辑。
 *
 * 状态挂在 doc 上（WeakMap），换文档天然隔离。持久化走 v4 配置的 `ops` 字段
 * （md-texmix 用 `toDesc` 取描述、`fromDesc` 还原，像素以 data URL / blob 存根存放）。
 *
 * 对外（window.TexStack）：
 *   ops(doc, slot) / has(doc, slot) / rev(doc, slot)
 *   push(doc, slot, op) / setOps(doc, slot, arr) / clear(doc, slot)
 *   edited(doc, slot, { base, baseKey }) → canvas（透明底：base ⊕ ops）
 *   flatten(doc, slot, { base, slotColor }) → canvas（不透明：槽位色 → base → ops）
 *   srcOf(op) / toDesc(doc, slot) / fromDesc(desc, img) —— v4 落盘用
 *   bytes(doc, slot)
 */
(function (global) {
  'use strict';

  var DOCS = new WeakMap();   /* doc -> { slots: { [slot]: { ops, rev, cache, cacheRev, cacheBase } } } */
  var MAX_SIDE = 2048;        /* 与 md-texmix 的 MAX_SIDE 同一档：一次流转不重编码 */

  function rec(doc, slot, make) {
    if (!doc) return null;
    var d = DOCS.get(doc);
    if (!d) {
      if (!make) return null;
      d = { slots: Object.create(null) };
      DOCS.set(doc, d);
    }
    var k = String(slot);
    var r = d.slots[k];
    if (!r && make) r = d.slots[k] = { ops: [], rev: 0, cache: null, cacheRev: -1, cacheBase: '' };
    return r || null;
  }

  function ops(doc, slot) {
    var r = rec(doc, slot);
    return r ? r.ops : [];
  }
  function has(doc, slot) {
    var r = rec(doc, slot);
    return !!(r && r.ops.length);
  }
  function rev(doc, slot) {
    var r = rec(doc, slot);
    return r ? r.rev : 0;
  }
  function bump(r) { r.rev++; r.cache = null; r.cacheRev = -1; }

  function push(doc, slot, op) {
    if (!doc || !op) return 0;
    var r = rec(doc, slot, true);
    r.ops.push(op);
    bump(r);
    return r.ops.length;
  }
  function setOps(doc, slot, arr) {
    if (!doc) return 0;
    var r = rec(doc, slot, true);
    r.ops = (arr || []).slice();
    bump(r);
    return r.ops.length;
  }
  function clear(doc, slot) { return setOps(doc, slot, []); }

  /* 目标尺寸：以底座为准（只缩不放大），没底座就取第一层的尺寸 */
  function sizeOf(list, base, cap) {
    var W = 0, H = 0;
    if (base && (base.naturalWidth || base.width)) {
      W = base.naturalWidth || base.width;
      H = base.naturalHeight || base.height;
    }
    if (!W) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i].canvas;
        if (c && c.width) { W = c.width; H = c.height; break; }
      }
    }
    if (!W) return null;
    var k = Math.min(1, (cap || MAX_SIDE) / Math.max(W, H));
    return { w: Math.max(4, Math.round(W * k)), h: Math.max(4, Math.round(H * k)) };
  }

  /* 模糊层：canvas 存的是「笔刷遮罩」（alpha），回放时把当前画布整体模糊一次，
   * 再按遮罩把模糊结果盖回去。存模糊后的像素会把下面那一层的内容锁死，
   * 换底座 / 换混合层之后就会对不上。 */
  var BLUR_TMP = null;
  function blurMasked(cv, mask, radius) {
    var W = cv.width, H = cv.height;
    if (!(radius > 0) || !mask || !mask.width) return cv;
    /* 半径按画布缩放：遮罩是在绘画工作副本（最高 2048）上量的，
     * 而合成画布可能更小（跟着底座 / 混合层走）。不缩放的话，
     * 小贴图上会被糊成一整片。 */
    var r = radius * (W / mask.width);
    if (!(r > 0.2)) return cv;
    var tmp = BLUR_TMP;
    if (!tmp) tmp = BLUR_TMP = document.createElement('canvas');
    if (tmp.width !== W) tmp.width = W;
    if (tmp.height !== H) tmp.height = H;
    var g = tmp.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    if ('filter' in g) g.filter = 'blur(' + r.toFixed(2) + 'px)';
    g.drawImage(cv, 0, 0);
    if ('filter' in g) g.filter = 'none';
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    cv.getContext('2d').drawImage(tmp, 0, 0);
    return cv;
  }

  /* 一层画到目标画布上。带 bbox 的笔迹只拷那一块：
   * 2048² 的 drawImage 每次都会走一遍全图，而一笔实际只碰几十万像素。 */
  function drawLayer(c2, op, cv) {
    var src = op.canvas;
    var b = op.bbox;
    if (b && b.w > 0 && b.h > 0 && src.width && src.height) {
      var kx = cv.width / src.width, ky = cv.height / src.height;
      var sx = Math.max(0, Math.floor(b.x)), sy = Math.max(0, Math.floor(b.y));
      var sw = Math.min(src.width - sx, Math.ceil(b.w)), sh = Math.min(src.height - sy, Math.ceil(b.h));
      if (sw > 0 && sh > 0) {
        c2.drawImage(src, sx, sy, sw, sh, sx * kx, sy * ky, sw * kx, sh * ky);
        return;
      }
    }
    c2.drawImage(src, 0, 0, cv.width, cv.height);
  }

  function paint(cv, base, list) {
    var c2 = cv.getContext('2d');
    if (base) c2.drawImage(base, 0, 0, cv.width, cv.height);
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      if (!op || op.on === false) continue;
      var a = op.op == null ? 1 : op.op;
      if (!(a > 0.002)) continue;
      if (!op.canvas || !op.canvas.width) continue;
      if (op.type === 'blur') { blurMasked(cv, op.canvas, op.radius || 0); continue; }
      /* 橡皮层：增量图里的 alpha 就是擦除量。回放必须用 destination-out ——
       * 直接 source-over 画一块黑上去，擦除就变成了涂黑。 */
      c2.globalCompositeOperation = op.mode === 'erase' ? 'destination-out' : 'source-over';
      c2.globalAlpha = a;
      drawLayer(c2, op, cv);
    }
    c2.globalCompositeOperation = 'source-over';
    c2.globalAlpha = 1;
    return cv;
  }

  /* 按层类型筛选：合成顺序必须区分「底座类」与「覆盖类」——
   * 投射（project）属于底座，笔迹（stroke）必须叠在混合层之上。
   * 不传 kinds 时返回全量（老调用点的语义不变）。 */
  function filterKinds(list, kinds) {
    if (!kinds || !kinds.length) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      if (op && kinds.indexOf(op.type || 'stroke') >= 0) out.push(op);
    }
    return out;
  }

  /* 视口 / 左栏用：透明底 + 底座 + 各层。
   * 没有底座时保持透明 —— 材质本色（槽位色）会从下面透出来，等价于「槽位色打底」，
   * 但不会把槽位色当成像素写进任何地方。
   * opt.kinds：只回放某一类层（合成器用它把笔迹单独叠到混合层之上）；
   * 缓存键必须带上 kinds，否则全量缓存会把过滤后的结果覆盖掉。 */
  function edited(doc, slot, opt) {
    opt = opt || {};
    var r = rec(doc, slot);
    if (!r || !r.ops.length) return null;
    var list = filterKinds(r.ops, opt.kinds);
    if (!list.length) return null;
    var base = opt.base || null;
    var baseKey = (opt.baseKey || '') + '|k:' + (opt.kinds ? opt.kinds.join(',') : '*');
    if (r.cache && r.cacheRev === r.rev && r.cacheBase === baseKey) return r.cache;
    var sz = sizeOf(list, base, opt.cap);
    if (!sz) return null;
    var cv = document.createElement('canvas');
    cv.width = sz.w; cv.height = sz.h;
    paint(cv, base, list);
    r.cache = cv; r.cacheRev = r.rev; r.cacheBase = baseKey;
    return cv;
  }

  /* 往已有画布上叠一层（不复制整张）：合成器先烘底座 + 混合层，
   * 再把笔迹按顺序盖上去。传 null / 某类层为空时原样返回。 */
  function overlay(cv, doc, slot, kinds) {
    if (!cv) return cv;
    var r = rec(doc, slot);
    if (!r || !r.ops.length) return cv;
    var list = filterKinds(r.ops, kinds);
    if (!list.length) return cv;
    paint(cv, null, list);
    return cv;
  }

  /* 「固化为底图」用：不透明合成（先铺槽位色），结果可以直接写回 slotMaps。
   * 注意它与 edited 的颜色结果一致 —— 不同的是透明区域的处理方式。 */
  function flatten(doc, slot, opt) {
    opt = opt || {};
    var r = rec(doc, slot);
    if (!r || !r.ops.length) return null;
    var base = opt.base || null;
    var sz = sizeOf(r.ops, base, opt.cap);
    if (!sz) return null;
    var cv = document.createElement('canvas');
    cv.width = sz.w; cv.height = sz.h;
    var c2 = cv.getContext('2d');
    c2.fillStyle = opt.slotColor || '#c9ccd4';
    c2.fillRect(0, 0, cv.width, cv.height);
    paint(cv, base, r.ops);
    /* 橡皮擦出来的是**透明洞**：先填的槽位色也被一起擦掉了。
     * 导出用的贴图必须不透明，所以最后再垫一层槽位色补洞（destination-over 只补 alpha<1 的地方，
     * 已有像素一个都不动）。 */
    c2.globalCompositeOperation = 'destination-over';
    c2.fillStyle = opt.slotColor || '#c9ccd4';
    c2.fillRect(0, 0, cv.width, cv.height);
    c2.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* 字节估算：层是增量图，用 canvas 面积近似（比 stringify dataURL 快得多，
   * 也不会因为一次 toDataURL 就卡住主线程） */
  function bytes(doc, slot) {
    var list = ops(doc, slot), n = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i].canvas;
      if (c && c.width) n += c.width * c.height * 4;
    }
    return n;
  }

  /* 层的 data URL —— **缓存到 op 上**。
   * 为什么必须缓存：一次 toDataURL 是 2048² 的 PNG 编码（约 120ms），
   * 而落盘（v4 配置）会在拖滑杆、加层、撤销时被反复调用，
   * 不缓存的话每帧都重编码一遍所有层。层建好之后像素不会再变，缓存是安全的。 */
  function srcOf(op) {
    if (!op) return '';
    if (op.src) return op.src;
    if (!op.canvas || !op.canvas.width) return '';
    /* 不在主线程同步编码：触发放到后台，本次落盘先跳过这一层。
     * md-texmix.persistOps 会等 pendingSrc 归零后再写，所以不会丢层。 */
    srcAsync(op);
    return '';
  }

  /* 异步编码：抬笔后主线程还要继续响应下一笔，不能在 rAF 里同步编 2048² PNG。
   * 优先 OffscreenCanvas.convertToBlob（编码在渲染线程之外），
   * 其次 requestIdleCallback + toDataURL（至少不抢用户输入）。
   * 两条路的产物都是 data URL，落盘格式不变。 */
  var pendingEnc = new WeakMap();   /* op -> Promise<string> */
  function blobToDataURL(blob) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(blob);
    });
  }
  function encodeCanvas(cv) {
    if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
      try {
        var oc = new OffscreenCanvas(cv.width, cv.height);
        oc.getContext('2d').drawImage(cv, 0, 0);
        return oc.convertToBlob({ type: 'image/png' }).then(blobToDataURL)
          .catch(function () { return encodeIdle(cv); });
      } catch (e) { /* 落回 idle 路径 */ }
    }
    return encodeIdle(cv);
  }
  function encodeIdle(cv) {
    return new Promise(function (resolve) {
      var go = function () {
        try { resolve(cv.toDataURL('image/png')); } catch (e) { resolve(''); }
      };
      if (global.requestIdleCallback) global.requestIdleCallback(go, { timeout: 300 });
      else setTimeout(go, 0);
    });
  }
  function srcAsync(op) {
    if (!op) return Promise.resolve('');
    if (op.src) return Promise.resolve(op.src);
    if (!op.canvas || !op.canvas.width) return Promise.resolve('');
    var p = pendingEnc.get(op);
    if (!p) {
      p = encodeCanvas(op.canvas).then(function (src) {
        if (src) op.src = src;
        pendingEnc.delete(op);
        return src;
      });
      pendingEnc.set(op, p);
    }
    return p;
  }
  /* 还有几层的像素没编完（落盘要等它归零，否则会把笔迹写成空层） */
  function pendingSrc(doc, slot) {
    var list = ops(doc, slot), n = 0;
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      if (op && op.on !== false && !op.src && op.canvas && op.canvas.width) n++;
    }
    return n;
  }
  function ensureSrc(doc, slot) {
    var list = ops(doc, slot), jobs = [];
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      if (op && op.on !== false && !op.src) jobs.push(srcAsync(op));
    }
    return Promise.all(jobs);
  }

  /* 层 → 可存进配置的描述（不含像素，只有 src 与参数）。
   * 这是 v4 配置里 `ops` 字段的唯一生成口径。 */
  function toDesc(doc, slot) {
    var list = ops(doc, slot), out = [];
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      if (!op || op.on === false) continue;
      var src = srcOf(op);
      if (!src) continue;
      out.push({
        type: op.type || 'stroke',
        mode: op.mode === 'erase' ? 'erase' : 'normal',
        op: op.op == null ? 1 : op.op,
        radius: op.radius || 0,
        w: op.canvas ? op.canvas.width : (op.w || 0),
        h: op.canvas ? op.canvas.height : (op.h || 0),
        label: op.label || '',
        /* 这一层实际动过的像素范围：下次合成 / 上传只需要看它 */
        bbox: op.bbox ? { x: op.bbox.x, y: op.bbox.y, w: op.bbox.w, h: op.bbox.h } : null,
        src: src
      });
    }
    return out;
  }

  /* 配置描述 → 运行时层。src 可能已经被外置成 'blob:<id>' 存根，
   * 解码交给调用方（它知道 imgOnce 那套缓存）。 */
  function fromDesc(desc, img) {
    if (!desc || !img) return null;
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, desc.w || img.width || img.naturalWidth || 1);
    cv.height = Math.max(1, desc.h || img.height || img.naturalHeight || 1);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return {
      type: desc.type || 'stroke',
      mode: desc.mode === 'erase' ? 'erase' : 'normal',
      op: desc.op == null ? 1 : desc.op,
      radius: desc.radius || 0,
      label: desc.label || '',
      canvas: cv, w: cv.width, h: cv.height,
      bbox: desc.bbox ? { x: desc.bbox.x, y: desc.bbox.y, w: desc.bbox.w, h: desc.bbox.h } : null,
      /* 保留原始 src：下次落盘不必重新编码 */
      src: desc.src || ''
    };
  }

  function __debug(doc, slot) {
    var list = ops(doc, slot);
    return {
      rev: rev(doc, slot),
      n: list.length,
      types: list.map(function (o) { return o && o.type; }),
      sizes: list.map(function (o) { return o && o.canvas ? (o.canvas.width + '×' + o.canvas.height) : ''; }),
      bytes: bytes(doc, slot)
    };
  }

  global.TexStack = {
    ops: ops, has: has, rev: rev,
    push: push, setOps: setOps, clear: clear,
    edited: edited, overlay: overlay, blurMasked: blurMasked, flatten: flatten, bytes: bytes,
    srcOf: srcOf, srcAsync: srcAsync, pendingSrc: pendingSrc, ensureSrc: ensureSrc,
    toDesc: toDesc, fromDesc: fromDesc,
    MAX_SIDE: MAX_SIDE, __debug: __debug
  };
})(window);
