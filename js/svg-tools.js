/* 图像转 SVG：本地工具层（MVP 五件套）
 *
 * inspect_raster / trace_region / ocr_text / render_svg_compare / validate_svg
 *
 * 三条硬约束（与 Astra 联调后定下，改代码前先读）：
 *   1) 工具参数与返回值里**不出现整段 SVG**。草稿存在本地 drafts 里，用 draft_id 引用；
 *      只有模型确实要整体改写时，才允许在 validate / compare 里传一次 svg。
 *   2) 所有几何坐标都是**源图像素坐标**。各图层共享 viewBox="0 0 W H"，不做局部缩放；
 *      trace_region 的局部裁剪结果在输出前已把区域偏移加回去。
 *   3) 纯前端：canvas + DOMParser，零依赖、零网络请求。file:// 下也能跑。
 *
 * 暴露的全局接口（脚本作用域，不是模块）：
 *   SVG_TOOLS            工具定义数组（直接塞进 /chat/completions 的 tools）
 *   svgToolRun(name,args) 统一执行入口，返回 Promise<可序列化结果>
 *   svgSetSource(img,opt) 载入原图（App 调用）
 *   svgSourceInfo()      当前原图信息
 *   svgDraftNew/svgDraftSetCurrent/svgDraftGet/svgDraftSetSvg/svgDraftToSvg
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /* 默认图层栈（自底向上）。新建草稿按这份顺序生成 <g>；
     之后一切都以草稿里的 layout 为准——用户可以像 PS 一样增删、改名、调序，
     不再假定永远只有这四层。 */
  const DEFAULT_LAYERS = [
    { id: 'layer-background', name: '背景', short: 'bg' },
    { id: 'layer-subject', name: '主体', short: 'sj' },
    { id: 'layer-detail', name: '细节', short: 'dt' },
    { id: 'layer-text', name: '文字', short: 'tx' }
  ];
  const LAYER_IDS = DEFAULT_LAYERS.map(l => l.id);
  const MAX_LAYERS = 24;
  const MAX_REGION_PX = 900000;     // 单次 trace 的区域上限：再大既慢又会让路径爆炸
  const MAX_DRAFTS = 6;

  /* 确定性基线：比对、消融、分层掩膜、测试报告全部以这一组常量为准。
     改任何一个值都等于换了一把尺子——旧报告不能再直接和新报告对比。 */
  const DET = Object.freeze({
    version: 1,
    refMaxSide: 1024,      // 比对 / 消融 / 分层掩膜的统一下采样上限
    bg: '#ffffff',         // 合成底色（与 canvas 透明区分）
    minAlpha: 24,          // 像素算「画到了」的 alpha 阈值
    edgeThreshold: 30,     // 边缘检测阈值（luma 梯度）
    blockSize: 24,         // top_mismatches 的分块尺寸（在采样分辨率上）
    coordDecimals: 1,      // 坐标写入精度
    simplify: 1.2          // 默认 RDP 容差
  });
  const SHAPE_SEL = 'path, rect, circle, ellipse, polygon, polyline, line, text';
  const DEDUP_TAGS = ['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'];

  /* ---------------- 小工具 ---------------- */
  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  function int(v, d, lo, hi) {
    const n = Math.round(num(v, d));
    return Math.max(lo, Math.min(hi, n));
  }
  function r1(n) { return Math.round(n * 10) / 10; }
  function hex(c) {
    return '#' + [c[0], c[1], c[2]].map(x => {
      const s = Math.max(0, Math.min(255, Math.round(x))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }
  function cut(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* ---------------- 图层栈（PS 式，可增删改名调序） ----------------
   * draft.layout 自底向上存 [{ id, name, short }]：
   *   数组顺序 = 文档顺序 = 绘制顺序（下标 0 在最底）。
   * panel 展示时反过来排（最上层在最上面）。short 只用于生成 path_id 前缀。 */
  function defaultLayout() {
    return DEFAULT_LAYERS.map(l => ({ id: l.id, name: l.name, short: l.short }));
  }
  function layoutOf(d) {
    if (!d) return defaultLayout();
    if (!Array.isArray(d.layout) || !d.layout.length) d.layout = defaultLayout();
    if (d.layerSeq == null) d.layerSeq = 0;
    d.layout.forEach(l => {
      if (!l.name) l.name = l.id;
      if (!l.short) l.short = 'l' + (++d.layerSeq);
    });
    return d.layout;
  }
  function layerIdsOf(d) { return layoutOf(d).map(l => l.id); }
  function layerOf(d, id) { return layoutOf(d).find(l => l.id === id) || null; }
  function shortOf(d, id) {
    const l = layerOf(d, id);
    return (l && l.short) || 'l';
  }
  function topLayerId(d) {
    const list = layoutOf(d);
    return list.length ? list[list.length - 1].id : LAYER_IDS[LAYER_IDS.length - 1];
  }
  /* 模型给的 layer 可能是过期的 id：能对上就用，对不上退回 fallback / 最上层，
     绝不因为「这一层被删了」让整笔画不出去。 */
  function resolveLayer(d, v, fallback) {
    const id = String(v || '');
    if (layerOf(d, id)) return id;
    if (fallback && layerOf(d, fallback)) return fallback;
    return topLayerId(d);
  }
  function newLayerShort(d) { return 'l' + (++d.layerSeq); }
  function newLayerId(d) {
    const ids = layerIdsOf(d);
    let n = 1;
    while (ids.indexOf('layer-' + n) >= 0) n++;
    return 'layer-' + n;
  }

  /* ---------------- 草稿缓存 ---------------- */
  let draftSeq = 0;
  let currentId = '';
  const drafts = new Map();

  function skeleton(w, h, layout) {
    const list = Array.isArray(layout) && layout.length ? layout : defaultLayout();
    return '<svg xmlns="' + SVG_NS + '" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">'
      + list.map(l => '<g id="' + l.id + '" data-name="' + xmlEscape(l.name) + '"></g>').join('')
      + '</svg>';
  }

  function svgDraftNew(w, h, opts) {
    w = Math.max(1, Math.round(num(w, 1)));
    h = Math.max(1, Math.round(num(h, 1)));
    const id = 'draft-' + (++draftSeq);
    const layout = defaultLayout();
    drafts.set(id, {
      id: id, w: w, h: h, svg: skeleton(w, h, layout),
      name: (opts && opts.name) || '', createdAt: Date.now(), calls: [],
      seq: {}, deduped: 0, undo: [],
      /* 图层栈自底向上；用户增删改序后这里就是唯一真源 */
      layout: layout, layerSeq: 0,
      /* 钢笔作画的真源（见下方「节点模型」）：d.svg 只是它的派生渲染缓存 */
      model: { version: 0, nodes: [], seq: {} }, shot: null
    });
    // 草稿只留最近几份：它可能带着几十 KB 路径，没有理由长期堆积
    while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
    currentId = id;
    return id;
  }
  function svgDraftSetCurrent(id) {
    if (drafts.has(id)) currentId = id;
    return currentId;
  }
  function svgDraftGet(id) { return drafts.get(id) || drafts.get(currentId) || null; }
  function svgDraftCurrentId() { return currentId; }
  function svgDraftToSvg(id) {
    const d = svgDraftGet(id);
    return d ? d.svg : '';
  }
  function svgDraftReset(id) {
    const d = drafts.get(id || currentId);
    if (!d) return '';
    d.svg = skeleton(d.w, d.h, layoutOf(d));
    d.seq = {};
    d.deduped = 0;
    d.undo = [];
    d.model = { version: 0, nodes: [], seq: {} };
    d.shot = null;
    return d.id;
  }

  /* ------------- 撤销：一次工具写入 = 一个快照 -------------
   * 「整图重画」是一连串追加，改坏一笔就得能退回去；快照直接存 SVG 字符串，
   * 一屏插画的大小可以接受。只留最近 12 笔，避免旧草稿把内存吃满。 */
  const UNDO_MAX = 12;

  function pushUndo(d, tag) {
    if (!d) return;
    if (!d.undo) d.undo = [];
    d.undo.push({
      svg: d.svg,
      seq: JSON.parse(JSON.stringify(d.seq || {})),
      deduped: d.deduped || 0,
      /* 节点模型也必须一起回滚：否则撤销后 SVG 退回去了，下一次改点又从新模型重建 */
      model: d.model ? JSON.parse(JSON.stringify(d.model)) : null,
      /* 图层栈同理：加层/改名/调序也是一次写入 */
      layout: d.layout ? JSON.parse(JSON.stringify(d.layout)) : null,
      layerSeq: d.layerSeq || 0,
      tag: String(tag || '')
    });
    while (d.undo.length > UNDO_MAX) d.undo.shift();
  }

  function svgDraftUndo(id) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可撤销的草稿');
    if (!d.undo || !d.undo.length) return { draft_id: d.id, undone: false, remaining: 0 };
    const snap = d.undo.pop();
    d.svg = snap.svg;
    d.seq = snap.seq || {};
    d.deduped = snap.deduped || 0;
    if (snap.model) d.model = snap.model;
    if (snap.layout) d.layout = snap.layout;
    d.layerSeq = snap.layerSeq || 0;
    return { draft_id: d.id, undone: true, tag: snap.tag, remaining: d.undo.length };
  }

  function svgDraftCanUndo(id) {
    const d = svgDraftGet(id);
    return !!(d && d.undo && d.undo.length);
  }

  /* ================= 钢笔作画：节点模型 =================
   * 真源是锚点/控制柄，不是 SVG 字符串：
   *   node = { id, type:'path'|'raw', layer, closed,
   *            anchors:[{x,y,in:[dx,dy],out:[dx,dy]}], stroke, width, fill, bbox }
   * d.svg 是派生缓存：每次改点后 rebuild(d) 重新序列化，再跑 syncDraft 补 bbox。
   * 为什么不让模型直接写 d="…"：改一个锚点要重算两条贝塞尔控制柄，
   * 在字符串上做不可靠，也没法保证「填色」引用的是同一个闭合形状。
   *
   * 约定：in / out 是**相对锚点**的偏移量；两柄都为 0 时该段退回直线（L）。
   */
  function modelOf(d) {
    if (!d.model) d.model = { version: 0, nodes: [], seq: {} };
    if (!Array.isArray(d.model.nodes)) d.model.nodes = [];
    if (!d.model.seq) d.model.seq = {};
    return d.model;
  }

  function normColor(v, fallback) {
    let s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'none' || s === 'transparent') return 'none';
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/.test(s) ? s : fallback;
  }

  /* 控制柄兼容两种写法：[dx,dy] 或 {x,y}（都按相对锚点处理） */
  function handlePair(v) {
    if (Array.isArray(v)) return [r1(num(v[0], 0)), r1(num(v[1], 0))];
    if (v && typeof v === 'object') return [r1(num(v.x, 0)), r1(num(v.y, 0))];
    return [0, 0];
  }

  function clampX(v, w) { return Math.max(0, Math.min(w, r1(num(v, 0)))); }
  function clampY(v, h) { return Math.max(0, Math.min(h, r1(num(v, 0)))); }

  function anchorOf(a, w, h) {
    return {
      x: clampX(a && a.x, w), y: clampY(a && a.y, h),
      in: handlePair(a && a.in), out: handlePair(a && a.out)
    };
  }

  function pathD(anchors, closed) {
    const n = anchors.length;
    if (n < 2) return '';
    let s = 'M' + anchors[0].x + ',' + anchors[0].y;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = anchors[i], b = anchors[(i + 1) % n];
      const straight = !a.out[0] && !a.out[1] && !b.in[0] && !b.in[1];
      if (straight) {
        s += 'L' + b.x + ',' + b.y;
        continue;
      }
      s += 'C' + r1(a.x + a.out[0]) + ',' + r1(a.y + a.out[1]) + ','
        + r1(b.x + b.in[0]) + ',' + r1(b.y + b.in[1]) + ','
        + b.x + ',' + b.y;
    }
    return closed ? s + 'Z' : s;
  }

  function nodeMarkup(n, short) {
    if (n.type === 'raw') return n.markup || '';
    const dAttr = pathD(n.anchors, n.closed);
    if (!dAttr) return '';
    const attrs = [
      'd="' + dAttr + '"',
      'data-path-id="' + n.id + '"',
      'data-layer="' + (short || 'sj') + '"'
    ];
    if (n.fill && n.fill !== 'none') {
      attrs.push('fill="' + n.fill + '"', 'fill-rule="evenodd"');
    } else {
      attrs.push('fill="none"');
    }
    if (n.stroke && n.stroke !== 'none') {
      attrs.push('stroke="' + n.stroke + '"', 'stroke-width="' + r1(n.width || 2) + '"',
        'stroke-linejoin="round"', 'stroke-linecap="round"');
    }
    return '<path ' + attrs.join(' ') + '/>';
  }

  function importMarkup(doc, markup) {
    const wrap = new DOMParser().parseFromString(
      '<svg xmlns="' + SVG_NS + '">' + markup + '</svg>', 'image/svg+xml');
    if (wrap.querySelector('parsererror')) return null;
    const el = wrap.documentElement.firstElementChild;
    return el ? doc.importNode(el, true) : null;
  }

  /* 从节点重建整份 SVG。节点为空时保持原样（老接口直接写 svg 的场景不受影响）；
     force=true 用于图层增删改序：即使暂时没有节点，也要按新 layout 重排 <g>。 */
  function rebuild(d, force) {
    const m = modelOf(d);
    if (!m.nodes.length && !force) return m.version;
    const root = parseSvg(skeleton(d.w, d.h, d.layout));
    const cdoc = root.ownerDocument;
    m.nodes.forEach(n => {
      /* 图层被删后残留的节点：挪到主体层（或最上层），而不是悄悄丢掉 */
      if (!layerOf(d, n.layer)) n.layer = resolveLayer(d, '', 'layer-subject');
      const el = importMarkup(cdoc, nodeMarkup(n, shortOf(d, n.layer)));
      if (!el) return;                                  // 单个节点坏掉不该毁掉整张画布
      const g = root.querySelector('[id="' + n.layer + '"]');
      if (g) g.appendChild(el);
    });
    d.svg = new XMLSerializer().serializeToString(root);
    syncDraft(d, { dedup: false });
    /* bbox 回写给节点：区域删除 / 命中测试都靠它，不必再解析一次 */
    const byId = {};
    m.nodes.forEach(n => { byId[n.id] = n; });
    parseSvg(d.svg).querySelectorAll('[data-path-id]').forEach(el => {
      const n = byId[el.getAttribute('data-path-id')];
      if (!n) return;
      const bb = String(el.getAttribute('data-bbox') || '').split(',').map(Number);
      if (bb.length === 4 && bb.every(Number.isFinite)) {
        n.bbox = { x: bb[0], y: bb[1], w: bb[2], h: bb[3] };
      }
    });
    m.version = (m.version || 0) + 1;
    return m.version;
  }

  function addRawNode(d, layer, markup, bbox) {
    const m = modelOf(d);
    const short = shortOf(d, layer) || 'tx';
    m.seq[short] = (m.seq[short] || 0) + 1;
    const id = short + '-' + pad3(m.seq[short]);
    const wrap = new DOMParser().parseFromString(
      '<svg xmlns="' + SVG_NS + '">' + markup + '</svg>', 'image/svg+xml');
    if (wrap.querySelector('parsererror')) throw new Error('节点片段不是合法 XML');
    const el = wrap.documentElement.firstElementChild;
    if (!el) throw new Error('节点片段为空');
    el.setAttribute('data-path-id', id);
    el.setAttribute('data-layer', short);
    m.nodes.push({
      id: id, type: 'raw', layer: layer,
      markup: new XMLSerializer().serializeToString(el),
      bbox: bbox || null
    });
    rebuild(d);
    return id;
  }

  function nodeById(d, id) {
    return modelOf(d).nodes.find(n => n.id === id) || null;
  }

  function removeNodeById(d, id) {
    const m = modelOf(d);
    const before = m.nodes.length;
    m.nodes = m.nodes.filter(n => n.id !== id);
    return m.nodes.length !== before;
  }

  function deleteNodesInRect(d, layer, rect) {
    const m = modelOf(d);
    let removed = 0;
    m.nodes = m.nodes.filter(n => {
      if (n.layer !== layer || !n.bbox) return true;
      if (!boxHitsRect([n.bbox.x, n.bbox.y, n.bbox.w, n.bbox.h], rect)) return true;
      removed++;
      return false;
    });
    if (removed) rebuild(d);
    return removed;
  }

  /* 判定两段折线是否相交（用于填色前的自交检查；曲线按锚点折线近似） */
  function segIntersect(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
  }

  function anchorsSelfIntersect(anchors, closed) {
    const n = anchors.length;
    if (n > 80) return false;                    // 太密时先不判，避免 O(n²) 卡住工具
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      for (let j = i + 1; j < segs; j++) {
        if (j === i + 1) continue;
        if (closed && i === 0 && j === segs - 1) continue;
        const a = anchors[i], b = anchors[(i + 1) % n];
        const c = anchors[j], e = anchors[(j + 1) % n];
        if (segIntersect(a, b, c, e)) return true;
      }
    }
    return false;
  }

  /* ---------------- 工具：draw_paths（钢笔） ---------------- */
  function toolDrawPaths(args) {
    const d = resolveDraft(args);
    const layer = resolveLayer(d, args && args.layer, 'layer-subject');
    const layerMeta = layerOf(d, layer);
    if (layerMeta && /文字|text/i.test(layerMeta.name)) throw new Error('文字不要用 draw_paths 画：请用 write_text');
    const list = args && args.paths;
    if (!Array.isArray(list) || !list.length) throw new Error('paths 必须是非空数组');
    if (list.length > 32) throw new Error('一次最多 32 笔：请拆成两次 draw_paths');
    const defaultStroke = normColor(args.stroke, '#1b1f24');
    const defaultWidth = Math.max(0.5, Math.min(40, num(args.width, 2)));

    /* 先全部校验再落笔：第 8 笔参数错了不该留下前 7 笔的半成品 */
    const prepared = [];
    list.forEach((p, i) => {
      const closed = !!(p && p.closed);
      const anchors = ((p && p.anchors) || []).map(a => anchorOf(a, d.w, d.h));
      const min = closed ? 3 : 2;
      if (anchors.length < min) {
        throw new Error('第 ' + (i + 1) + ' 笔只有 ' + anchors.length + ' 个锚点（'
          + (closed ? '闭合' : '开放') + ' 至少 ' + min + ' 个）');
      }
      prepared.push({
        closed: closed, anchors: anchors,
        fill: closed ? normColor(p.fill, 'none') : 'none',
        stroke: normColor(p.stroke, defaultStroke),
        width: Math.max(0.5, Math.min(40, num(p.width, defaultWidth)))
      });
    });

    const m = modelOf(d);
    let removed = 0;
    (Array.isArray(args.remove_ids) ? args.remove_ids : []).forEach(id => {
      if (removeNodeById(d, String(id))) removed++;
    });
    const short = shortOf(d, layer);
    const ids = [];
    prepared.forEach(p => {
      m.seq[short] = (m.seq[short] || 0) + 1;
      const id = short + '-' + pad3(m.seq[short]);
      m.nodes.push({
        id: id, type: 'path', layer: layer, closed: p.closed, anchors: p.anchors,
        stroke: p.stroke, width: p.width, fill: p.fill, bbox: null
      });
      ids.push(id);
    });
    rebuild(d);
    return {
      ok: true, draft_id: d.id, layer: layer,
      added: ids.length, removed: removed, ids: ids,
      total_paths: modelOf(d).nodes.filter(n => n.type === 'path').length,
      version: m.version,
      note: '已画 ' + ids.length + ' 笔。上色时用 fill_regions 引用这里的 ids'
    };
  }

  /* ---------------- 工具：edit_paths（改点/删点/改柄） ---------------- */
  function toolEditPaths(args) {
    const d = resolveDraft(args);
    const ops = args && args.ops;
    if (!Array.isArray(ops) || !ops.length) throw new Error('ops 必须是非空数组');
    if (ops.length > 64) throw new Error('一次最多 64 个改动');
    const m = modelOf(d);
    const done = [];
    let changed = 0;

    ops.forEach(op => {
      const id = String((op && op.path_id) || '');
      const n = nodeById(d, id);
      if (!n || n.type !== 'path') { done.push({ path_id: id, ok: false, error: '没有这条路径' }); return; }
      const act = String((op && op.action) || '').toLowerCase();
      if (act === 'delete_path') {
        removeNodeById(d, id);
        done.push({ path_id: id, ok: true, action: act });
        changed++;
        return;
      }
      if (act === 'move') {
        const dx = num(op.dx, 0), dy = num(op.dy, 0);
        n.anchors.forEach(a => { a.x = clampX(a.x + dx, d.w); a.y = clampY(a.y + dy, d.h); });
        done.push({ path_id: id, ok: true, action: act });
        changed++;
        return;
      }
      if (act === 'set_anchor' || act === 'set_handles') {
        const i = Math.round(num(op.index, -1));
        if (!(i >= 0 && i < n.anchors.length)) { done.push({ path_id: id, ok: false, error: 'index 越界' }); return; }
        const a = n.anchors[i];
        if (op.x != null) a.x = clampX(op.x, d.w);
        if (op.y != null) a.y = clampY(op.y, d.h);
        if (op.in !== undefined) a.in = handlePair(op.in);
        if (op.out !== undefined) a.out = handlePair(op.out);
        done.push({ path_id: id, ok: true, action: act });
        changed++;
        return;
      }
      if (act === 'delete_anchor') {
        const i = Math.round(num(op.index, -1));
        if (!(i >= 0 && i < n.anchors.length)) { done.push({ path_id: id, ok: false, error: 'index 越界' }); return; }
        const floor = n.closed ? 3 : 2;
        if (n.anchors.length <= floor) { done.push({ path_id: id, ok: false, error: '锚点已到下限 ' + floor }); return; }
        n.anchors.splice(i, 1);
        done.push({ path_id: id, ok: true, action: act });
        changed++;
        return;
      }
      if (act === 'close') {
        const want = !!op.closed;
        if (want && n.anchors.length < 3) { done.push({ path_id: id, ok: false, error: '闭合至少需要 3 个锚点' }); return; }
        n.closed = want;
        if (!want) n.fill = 'none';
        done.push({ path_id: id, ok: true, action: act });
        changed++;
        return;
      }
      if (act === 'set_style') {
        if (op.fill !== undefined) n.fill = n.closed ? normColor(op.fill, n.fill) : 'none';
        if (op.stroke !== undefined) n.stroke = normColor(op.stroke, n.stroke);
        if (op.width != null) n.width = Math.max(0.5, Math.min(40, num(op.width, n.width)));
        done.push({ path_id: id, ok: true, action: act });
        changed++;
        return;
      }
      done.push({ path_id: id, ok: false, error: '未知 action：' + act });
    });

    if (changed) rebuild(d);
    const failed = done.filter(x => !x.ok).length;
    return {
      ok: failed === 0, draft_id: d.id, changed: changed, failed: failed,
      ops: done, version: m.version,
      note: failed ? '有 ' + failed + ' 个改动没生效，看 ops[].error' : '改动已生效'
    };
  }

  /* ---------------- 工具：fill_regions（只填已闭合路径） ---------------- */
  function toolFillRegions(args) {
    const d = resolveDraft(args);
    let items = args && args.items;
    if (!Array.isArray(items)) {
      const ids = args && args.region_path_ids;
      if (Array.isArray(ids)) items = ids.map(id => ({ path_id: id, fill: args.fill }));
    }
    if (!Array.isArray(items) || !items.length) throw new Error('items 必须是非空数组');
    const applied = [], rejected = [];
    items.forEach(it => {
      const n = nodeById(d, String((it && it.path_id) || ''));
      if (!n || n.type !== 'path') { rejected.push({ path_id: it && it.path_id, reason: '没有这条路径' }); return; }
      if (!n.closed) { rejected.push({ path_id: n.id, reason: '路径没闭合：先 edit_paths 设 closed=true' }); return; }
      const fill = normColor(it.fill, '');
      if (!fill || fill === 'none') { rejected.push({ path_id: n.id, reason: 'fill 必须是 #rrggbb' }); return; }
      n.fill = fill;
      if (it.stroke !== undefined) n.stroke = normColor(it.stroke, 'none');
      if (it.width != null) n.width = Math.max(0.5, Math.min(40, num(it.width, n.width)));
      applied.push(n.id);
    });
    if (applied.length) rebuild(d);
    return {
      ok: applied.length > 0, draft_id: d.id,
      applied: applied.length, rejected: rejected.length,
      ids: applied, reasons: rejected.slice(0, 6),
      version: modelOf(d).version,
      note: applied.length ? '已上色 ' + applied.length + ' 块'
        : '没有一块填上：检查 path_id 是否存在且 closed=true'
    };
  }

  /* ---------------- 工具：observe_canvas（看自己画的） ----------------
   * 完整 PNG 只留在本地，工具结果里不出现 base64：
   * App 在下一轮请求里把它作为附图发出（tool 角色塞 image_url 兼容性差）。 */
  async function toolObserve(args) {
    const d = resolveDraft(args);
    const maxSide = int(args && args.size, 640, 128, 1600);
    const png = await svgDraftPng(d.id, { maxSide: maxSide, transparent: false });
    const st = layerStatsOf(parseSvg(d.svg), d);
    const s = Math.min(1, maxSide / Math.max(d.w, d.h));
    const size = [Math.max(1, Math.round(d.w * s)), Math.max(1, Math.round(d.h * s))];
    d.shot = { url: png, version: modelOf(d).version, size: size, at: Date.now() };
    return {
      ok: true, draft_id: d.id, version: d.shot.version, size: size,
      paths: st.totals.paths, texts: st.totals.texts,
      empty: st.totals.shapes === 0,
      attached: 'next_user_message',
      note: '渲染图会在下一轮请求里附上（不回传 base64，省 token）'
    };
  }

  function svgDraftShot(id) {
    const d = svgDraftGet(id);
    if (!d || !d.shot) return null;
    return {
      url: d.shot.url, size: d.shot.size, version: d.shot.version,
      stale: d.shot.version !== modelOf(d).version
    };
  }

  /* ---------------- 工具：validate_canvas（线稿/填色验收） ---------------- */
  function toolValidateCanvas(args) {
    const d = resolveDraft(args);
    const base = toolValidate({ draft_id: d.id });
    const m = modelOf(d);
    const errors = (base.errors || []).slice();
    const warnings = (base.warnings || []).slice();
    const paths = m.nodes.filter(n => n.type === 'path');
    const filled = paths.filter(n => n.fill && n.fill !== 'none');
    const openFilled = filled.filter(n => !n.closed);
    const oob = paths.filter(n => n.anchors.some(a => a.x < 0 || a.y < 0 || a.x > d.w || a.y > d.h));
    const selfInt = filled.filter(n => anchorsSelfIntersect(n.anchors, n.closed));

    if (!paths.length) errors.push('画布还没有路径：先 draw_paths 画线稿');
    openFilled.slice(0, 4).forEach(n => errors.push(n.id + ' 有填色但没闭合'));
    if (oob.length) errors.push(oob.length + ' 笔有锚点超出画布：' + oob.slice(0, 4).map(n => n.id).join('、'));
    if (selfInt.length) errors.push(selfInt.length + ' 笔填色路径自交：' + selfInt.slice(0, 4).map(n => n.id).join('、'));

    const closed = paths.filter(n => n.closed).length;
    return {
      ok: errors.length === 0,
      draft_id: d.id, version: m.version,
      errors: errors, warnings: warnings.slice(0, 6),
      checks: {
        paths: paths.length, closed: closed, filled: filled.length,
        open_filled: openFilled.length, oob_anchors: oob.length,
        self_intersections: selfInt.length,
        color_ready: paths.length > 0 && openFilled.length === 0
      },
      gate: { pass: errors.length === 0, reasons: errors.slice(0, 6), thresholds: { open_filled: 0, oob_anchors: 0, self_intersections: 0 } },
      stats: base.stats,
      note: '线稿阶段只要求「有路径、无越界」；上色后还要求「填色路径全部闭合、无自交」'
    };
  }

  /* 区域内的形状删除：按 data-bbox 与矩形求交，只删目标层。
     整图重画时「同一块重画」用得上——先清掉旧轮廓，再写新的，避免叠两层。
     没有 bbox 的飘移元素不动（外部传入的 SVG 可能没跑过 syncDraft）。 */
  function boxHitsRect(bb, rect) {
    return bb[0] < rect.x + rect.w && bb[0] + bb[2] > rect.x
      && bb[1] < rect.y + rect.h && bb[1] + bb[3] > rect.y;
  }

  function eraseShapesInRect(d, layer, rect) {
    const root = parseSvg(d.svg);
    const g = root.querySelector('[id="' + layer + '"]');
    if (!g) return { removed: 0 };
    let removed = 0;
    Array.prototype.slice.call(g.querySelectorAll(SHAPE_SEL)).forEach(el => {
      const bb = String(el.getAttribute('data-bbox') || '').split(',').map(Number);
      if (bb.length !== 4 || !bb.every(Number.isFinite)) return;
      if (!boxHitsRect(bb, rect)) return;
      if (el.parentElement) el.parentElement.removeChild(el);
      removed++;
    });
    if (removed) {
      d.svg = new XMLSerializer().serializeToString(root);
      syncDraft(d);
    }
    return { removed: removed };
  }

  /* ---------------- 规范化：稳定 id / 去重 / bbox ----------------
   * 每次写入后都跑一遍：
   *   1) 同层内**完全相同**的形状只留一条（同一区域 trace 两次不会把路径翻倍）
   *   2) 每个形状补 data-path-id / data-layer / data-bbox
   * id 只增不减：同一草稿在多次追加后路径依然能对上，差异 / 消融 / 快照都靠它。 */
  function shapeKey(el) {
    const parts = [];
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a.name === 'data-path-id' || a.name === 'data-bbox' || a.name === 'data-layer') continue;
      parts.push(a.name + '=' + a.value);
    }
    parts.sort();
    return el.tagName + '|' + parts.join('|')
      + (el.tagName === 'text' ? '|' + el.textContent : '');
  }
  function pad3(n) {
    return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n);
  }
  function unionBox(a, b) {
    if (!a) return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x, y: y, w: x2 - x, h: y2 - y };
  }

  function syncDraft(d, opts) {
    const dedupOn = !(opts && opts.dedup === false);
    const root = parseSvg(d.svg);
    if (!d.seq) d.seq = {};
    let deduped = 0;
    layoutOf(d).forEach(l => {
      const g = root.querySelector('[id="' + l.id + '"]');
      if (!g) return;
      const short = l.short;
      let seq = d.seq[short] || 0;
      const seen = new Set();
      Array.prototype.slice.call(g.children).forEach(el => {
        if (dedupOn && DEDUP_TAGS.indexOf(el.tagName) >= 0) {
          const key = shapeKey(el);
          if (seen.has(key)) { g.removeChild(el); deduped++; return; }
          seen.add(key);
        }
        if (!el.getAttribute('data-path-id')) {
          el.setAttribute('data-path-id', short + '-' + pad3(++seq));
        }
        if (!el.getAttribute('data-layer')) el.setAttribute('data-layer', short);
      });
      d.seq[short] = seq;
    });

    /* bbox 只能靠真实布局量：在离屏 host 里排一次版面，再把结果写回字符串。
       node 与 root 是两棵树，但 querySelectorAll 的遍历顺序一致，可按索引对齐。 */
    const host = measureHost();
    host.innerHTML = '';
    const node = document.importNode(root, true);
    node.setAttribute('width', String(d.w));
    node.setAttribute('height', String(d.h));
    host.appendChild(node);
    const from = node.querySelectorAll(SHAPE_SEL);
    const to = root.querySelectorAll(SHAPE_SEL);
    for (let i = 0; i < from.length && i < 3000; i++) {
      let box;
      try { box = from[i].getBBox(); } catch (e) { continue; }
      if (!box) continue;
      to[i].setAttribute('data-bbox',
        r1(box.x) + ',' + r1(box.y) + ',' + r1(box.width) + ',' + r1(box.height));
    }
    host.innerHTML = '';

    d.svg = new XMLSerializer().serializeToString(root);
    d.deduped = (d.deduped || 0) + deduped;
    return deduped;
  }

  /* 只保留指定图层后的 SVG 字符串（单层导出 / 隔离预览 / 消融都用它）。
     「图层」= <svg> 下带 id 的 <g>；不在 keep 里的整组移除。 */
  function svgOnlyLayers(svgText, keepIds) {
    const root = parseSvg(svgText);
    const keep = Array.isArray(keepIds) ? keepIds : [];
    Array.prototype.slice.call(root.children).forEach(el => {
      if (el.nodeType !== 1 || el.tagName.toLowerCase() !== 'g') return;
      const id = el.getAttribute('id') || '';
      if (!id || keep.indexOf(id) >= 0) return;
      root.removeChild(el);
    });
    return new XMLSerializer().serializeToString(root);
  }

  function svgDraftSvgForView(id, opts) {
    const d = svgDraftGet(id);
    if (!d) return '';
    const o = opts || {};
    const ids = layerIdsOf(d);
    const isolate = ids.indexOf(o.isolate) >= 0 ? o.isolate : '';
    const hidden = (o.hidden || []).filter(l => ids.indexOf(l) >= 0);
    const keep = ids.filter(l => isolate ? l === isolate : hidden.indexOf(l) < 0);
    return svgOnlyLayers(d.svg, keep);
  }

  function svgDraftExport(id, opts) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可导出的草稿');
    const layer = opts && opts.layer;
    if (!layer) return { kind: 'merged', bytes: d.svg.length, svg: d.svg };
    if (!layerOf(d, layer)) throw new Error('未知图层：' + layer);
    const svg = svgOnlyLayers(d.svg, [layer]);
    return { kind: 'layer', layer: layer, bytes: svg.length, svg: svg };
  }

  function svgToPngDataUrl(svg, cw, ch, transparent) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!transparent) {
          g.fillStyle = DET.bg;
          g.fillRect(0, 0, cw, ch);
        }
        g.drawImage(img, 0, 0, cw, ch);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG 无法栅格化（可能有非法标签或外链资源）'));
      img.src = svgDataUrl(svg);
    });
  }

  /* 分层 PNG：默认单层导出保留透明底（叠加对比时才有意义），合并导出用白底。 */
  async function svgDraftPng(id, opts) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可导出的草稿');
    const o = opts || {};
    const layer = layerOf(d, o.layer) ? o.layer : '';
    const svg = layer ? svgOnlyLayers(d.svg, [layer]) : d.svg;
    const maxSide = int(o.maxSide, DET.refMaxSide, 64, 4096);
    const s = Math.min(1, maxSide / Math.max(d.w, d.h));
    const cw = Math.max(1, Math.round(d.w * s));
    const ch = Math.max(1, Math.round(d.h * s));
    const transparent = o.transparent !== undefined ? !!o.transparent : !!layer;
    return svgToPngDataUrl(svg, cw, ch, transparent);
  }

  /* 结构统计：每层的路径数 / 文字数 / 字节 / 颜色 / 包围盒。
     纯 DOM 计算，不栅格化——图层面板每次工具调用后都能便宜地刷新。 */
  function layerStatsOf(root, d) {
    const list = [];
    const totals = { paths: 0, texts: 0, shapes: 0, bytes: 0, untagged: 0 };
    const layout = layoutOf(d);
    layout.forEach((lay, idx) => {
      const id = lay.id;
      const g = root.querySelector('[id="' + id + '"]');
      const e = {
        id: id, index: idx, name: lay.name, short: lay.short, present: !!g,
        paths: 0, texts: 0, shapes: 0, bytes: 0, untagged: 0,
        bbox: null, colors: []
      };
      if (g) {
        e.bytes = new XMLSerializer().serializeToString(g).length;
        const shapes = g.querySelectorAll(SHAPE_SEL);
        e.shapes = shapes.length;
        const seen = {};
        let box = null;
        Array.prototype.forEach.call(shapes, el => {
          if (el.tagName === 'path') e.paths++;
          if (el.tagName === 'text') e.texts++;
          if (!el.getAttribute('data-path-id')) e.untagged++;
          const fill = String(el.getAttribute('fill') || '').toLowerCase();
          if (/^#[0-9a-f]{6}$/.test(fill)) seen[fill] = (seen[fill] || 0) + 1;
          const bb = String(el.getAttribute('data-bbox') || '').split(',').map(Number);
          if (bb.length === 4 && bb.every(Number.isFinite)) {
            box = unionBox(box, { x: bb[0], y: bb[1], w: bb[2], h: bb[3] });
          }
        });
        e.bbox = box ? { x: r1(box.x), y: r1(box.y), w: r1(box.w), h: r1(box.h) } : null;
        e.colors = Object.keys(seen).sort((a, b) => seen[b] - seen[a]).slice(0, 6)
          .map(k => ({ hex: k, count: seen[k] }));
      }
      totals.paths += e.paths; totals.texts += e.texts;
      totals.shapes += e.shapes; totals.bytes += e.bytes;
      totals.untagged += e.untagged;
      list.push(e);
    });
    return {
      draft_id: d.id,
      viewBox: { x: 0, y: 0, w: d.w, h: d.h },
      order: layout.map(l => l.id),
      layers: list,
      totals: totals
    };
  }

  function svgDraftLayers(id) {
    const d = svgDraftGet(id);
    if (!d) return null;
    return layerStatsOf(parseSvg(d.svg), d);
  }

  /* ---------------- 图层操作（PS 式：新建 / 改名 / 调序 / 删除） ----------------
   * 每次操作都算一次写入（可撤销），改完立刻按新 layout 重排 <g>。
   * 图层是「容器」不是语义标签：名字由用户定，工具只认 layer_id。 */
  function layerOrderText(d) {
    return layoutOf(d).map(l => l.name + '(' + l.id + ')').join(' → ');
  }

  function svgDraftLayerAdd(id, opts) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可操作的草稿');
    const layout = layoutOf(d);
    if (layout.length >= MAX_LAYERS) throw new Error('图层最多 ' + MAX_LAYERS + ' 个');
    let lid = String((opts && opts.layer_id) || '').trim();
    if (!lid || layerOf(d, lid)) lid = newLayerId(d);
    const name = String((opts && opts.name) || ('图层 ' + (layout.length + 1))).slice(0, 40);
    const layer = { id: lid, name: name, short: newLayerShort(d) };
    const pos = opts && opts.position === 'bottom' ? 0 : layout.length;
    pushUndo(d, 'add_layer');
    layout.splice(pos, 0, layer);
    rebuild(d, true);
    return { ok: true, draft_id: d.id, layer_id: lid, name: name, order: layerIdsOf(d), index: pos };
  }

  function svgDraftLayerRename(id, layerId, name) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可操作的草稿');
    const l = layerOf(d, layerId);
    if (!l) throw new Error('没有这一层：' + layerId);
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('图层名不能为空');
    pushUndo(d, 'rename_layer');
    l.name = clean;
    const root = parseSvg(d.svg);
    const g = root.querySelector('[id="' + l.id + '"]');
    if (g) g.setAttribute('data-name', clean);
    d.svg = new XMLSerializer().serializeToString(root);
    return { ok: true, draft_id: d.id, layer_id: l.id, name: clean };
  }

  /* dir='up' 往上层移（数组下标 +1），'down' 往下层移。 */
  function svgDraftLayerMove(id, layerId, dir) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可操作的草稿');
    const layout = layoutOf(d);
    const i = layout.findIndex(l => l.id === layerId);
    if (i < 0) throw new Error('没有这一层：' + layerId);
    const j = dir === 'down' ? i - 1 : i + 1;
    if (j < 0 || j >= layout.length) return { ok: false, reason: i === 0 ? '已经在最底' : '已经在最顶', index: i, order: layerIdsOf(d) };
    pushUndo(d, 'move_layer');
    const t = layout[i]; layout[i] = layout[j]; layout[j] = t;
    rebuild(d, true);
    return { ok: true, draft_id: d.id, layer_id: layerId, index: j, order: layerIdsOf(d) };
  }

  function svgDraftLayerDelete(id, layerId) {
    const d = svgDraftGet(id);
    if (!d) throw new Error('没有可操作的草稿');
    const layout = layoutOf(d);
    const i = layout.findIndex(l => l.id === layerId);
    if (i < 0) throw new Error('没有这一层：' + layerId);
    if (layout.length <= 1) throw new Error('至少保留一个图层');
    pushUndo(d, 'delete_layer');
    const gone = layout.splice(i, 1)[0];
    const m = modelOf(d);
    const before = m.nodes.length;
    m.nodes = m.nodes.filter(n => n.layer !== gone.id);
    rebuild(d, true);
    return {
      ok: true, draft_id: d.id, deleted: gone.id, name: gone.name,
      removed_nodes: before - m.nodes.length, order: layerIdsOf(d)
    };
  }

  function parseSvg(text) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('XML 解析失败');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('根节点不是 <svg>');
    return root;
  }

  function viewBoxOf(root) {
    const parts = String(root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }
    return null;
  }

  function ensureLayer(d, root, id) {
    const layout = layoutOf(d);
    let l = layerOf(d, id);
    if (!l) {
      const known = DEFAULT_LAYERS.find(x => x.id === id);
      l = { id: id, name: known ? known.name : id, short: newLayerShort(d) };
      layout.push(l);
    }
    let g = root.querySelector('[id="' + id + '"]');
    if (g) return g;
    g = root.ownerDocument.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', id);
    g.setAttribute('data-name', l.name);
    /* 按 layout 顺序插到正确位置：后面第一个已存在的组之前，没有就追加到末尾 */
    const idx = layout.indexOf(l);
    let next = null;
    for (let i = idx + 1; i < layout.length; i++) {
      const n = root.querySelector('[id="' + layout[i].id + '"]');
      if (n) { next = n; break; }
    }
    if (next) root.insertBefore(g, next);
    else root.appendChild(g);
    return g;
  }

  function svgDraftSetSvg(id, text) {
    const d = drafts.get(id || currentId);
    if (!d) throw new Error('没有可写入的草稿');
    const s = String(text || '').trim();
    if (!s) throw new Error('svg 为空');
    parseSvg(s);                       // 先验一遍：坏 XML 不该悄悄存进去
    d.svg = s;
    syncDraft(d);                      // 外部传入的片段也要补 id / bbox
    return d.id;
  }

  /* 把一组 path 追加到草稿图层里。d/fill 之外不塞多余属性，避免 SVG 变胖；
     id / bbox 由 syncDraft 统一补。返回 { added, deduped }。 */
  function svgDraftAppendPaths(id, layer, paths) {
    const d = drafts.get(id || currentId);
    if (!d) throw new Error('没有可写入的草稿');
    const root = parseSvg(d.svg);
    const g = ensureLayer(d, root, resolveLayer(d, layer, 'layer-subject'));
    let added = 0;
    (paths || []).forEach(p => {
      if (!p || !p.d) return;
      const el = root.ownerDocument.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', p.d);
      if (p.fill === 'none') el.setAttribute('fill', 'none');
      else {
        el.setAttribute('fill', p.fill || '#808080');
        el.setAttribute('fill-rule', p.fillRule || 'evenodd');
      }
      if (p.opacity != null && p.opacity < 1) el.setAttribute('opacity', r1(p.opacity));
      g.appendChild(el);
      added++;
    });
    d.svg = new XMLSerializer().serializeToString(root);
    const deduped = syncDraft(d);
    return { added: added, deduped: deduped };
  }

  /* 把任意 SVG 片段（<text>/<g>/<path> …）追加到指定图层。
   * 模型写文字层时只需发这一小段，不必把已追踪好的路径再吐一遍。 */
  function svgDraftAppendMarkup(id, layer, markup) {
    const d = drafts.get(id || currentId);
    if(!d) throw new Error('没有可写入的草稿');
    const root = parseSvg(d.svg);
    const g = ensureLayer(d, root, resolveLayer(d, layer, 'layer-text'));
    const frag = new DOMParser().parseFromString(
      '<svg xmlns="' + SVG_NS + '">' + String(markup) + '</svg>', 'image/svg+xml');
    if(frag.querySelector('parsererror')) throw new Error('片段不是合法 XML');
    Array.prototype.slice.call(frag.documentElement.childNodes).forEach(n => {
      if(n.nodeType !== 1) return;
      g.appendChild(root.ownerDocument.importNode(n, true));
    });
    d.svg = new XMLSerializer().serializeToString(root);
    syncDraft(d);
  }

  /* validate / compare 的写入语义：
   *   args.svg    → 整体替换草稿（模型重写结构时用一次）
   *   args.append → { layer, markup } 片段追加（写文字层最常用，token 最省）
   * 两个都传时先替换再追加。 */
  function applyOverride(d, args) {
    if (args && typeof args.svg === 'string' && args.svg.trim()) svgDraftSetSvg(d.id, args.svg);
    const ap = args && args.append;
    if (ap && typeof ap.markup === 'string' && ap.markup.trim()) {
      svgDraftAppendMarkup(d.id, ap.layer, ap.markup);
      return { appended: true, layer: resolveLayer(d, ap.layer, 'layer-text') };
    }
    return null;
  }

  /* ---------------- 原图 ---------------- */
  let source = null;   // {w,h,canvas,ctx,data,name,version}
  let sourceSeq = 0;

  function svgSetSource(imgLike, opts) {
    if (!imgLike) throw new Error('没有图像');
    const nw = Math.round(imgLike.naturalWidth || imgLike.width || 0);
    const nh = Math.round(imgLike.naturalHeight || imgLike.height || 0);
    if (!nw || !nh) throw new Error('图像尺寸无效');
    /* 超大图先降采样：逐像素工具在 4K 上做不了交互式响应，
       而 viewBox 用降采样后的尺寸反而让路径点更省。 */
    let w = nw, h = nh;
    const cap = 2200;
    if (w > cap || h > cap) {
      const s = cap / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(imgLike, 0, 0, w, h);
    let data;
    try { data = ctx.getImageData(0, 0, w, h).data; }
    catch (e) { throw new Error('图像像素不可读（跨域图片不允许直接取像素）'); }
    source = {
      w: w, h: h, naturalW: nw, naturalH: nh,
      canvas: canvas, ctx: ctx, data: data,
      name: (opts && opts.name) || '', _luma: null, version: ++sourceSeq
    };
    currentId = '';
    return svgSourceInfo();
  }

  function svgSourceInfo() {
    if (!source) return null;
    return {
      w: source.w, h: source.h,
      natural: [source.naturalW, source.naturalH],
      name: source.name,
      version: source.version,
      scaled: source.w !== source.naturalW || source.h !== source.naturalH
    };
  }

  function requireSource() {
    if (!source) throw new Error('还没有载入图片：请先在窗口里选择一张图');
    return source;
  }

  function resolveDraft(args) {
    const wanted = args && args.draft_id;
    if (wanted) {
      const d = drafts.get(wanted);
      // 显式传了 id 就必须命中：静默回落到当前草稿会让报告指向错的图
      if (!d) throw new Error('草稿不存在：' + wanted + '（可能已被新草稿挤掉，请省略 draft_id 用当前草稿）');
      return d;
    }
    const d = svgDraftGet();
    if (!d) throw new Error('还没有 SVG 草稿：请先载入图片（会自动创建草稿）');
    return d;
  }

  function clampRegion(r, w, h) {
    if (!r || typeof r !== 'object') throw new Error('缺少 region');
    const x = Math.max(0, Math.min(w - 1, Math.round(num(r.x, 0))));
    const y = Math.max(0, Math.min(h - 1, Math.round(num(r.y, 0))));
    const rw = Math.max(1, Math.min(w - x, Math.round(num(r.w, w - x))));
    const rh = Math.max(1, Math.min(h - y, Math.round(num(r.h, h - y))));
    return { x: x, y: y, w: rw, h: rh };
  }

  function lumaOf(src) {
    if (src._luma) return src._luma;
    const { data, w, h } = src;
    const out = new Uint8Array(w * h);
    for (let i = 0, o = 0; i < out.length; i++, o += 4) {
      out[i] = Math.round(data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114);
    }
    src._luma = out;
    return out;
  }

  /* ---------------- 颜色量化：median cut ---------------- */
  function boxRange(list) {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
      if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
      if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
    }
    const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
    const ch = rr >= gr && rr >= br ? 0 : (gr >= br ? 1 : 2);
    return { ch: ch, max: Math.max(rr, gr, br) };
  }
  function avgColor(list) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < list.length; i++) { r += list[i][0]; g += list[i][1]; b += list[i][2]; }
    const n = list.length || 1;
    return [r / n, g / n, b / n];
  }
  function medianCut(pixels, k) {
    if (!pixels.length) return [];
    let boxes = [pixels];
    while (boxes.length < k) {
      let bi = -1, best = -1;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.length < 2) continue;
        const rg = boxRange(b);
        const score = rg.max * Math.log(b.length + 1);   // 既要色差大，也要覆盖像素多
        if (score > best) { best = score; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi];
      const rg = boxRange(b);
      b.sort((p, q) => p[rg.ch] - q[rg.ch]);
      const mid = Math.floor(b.length / 2);
      boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
    }
    return boxes.filter(b => b.length).map(avgColor);
  }

  function paletteFromRegion(src, rect, k) {
    const { data, w } = src;
    const area = rect.w * rect.h;
    const stride = Math.max(1, Math.floor(Math.sqrt(area / 60000)));
    const px = [];
    for (let y = rect.y; y < rect.y + rect.h && px.length < 80000; y += stride) {
      for (let x = rect.x; x < rect.x + rect.w && px.length < 80000; x += stride) {
        const o = (y * w + x) * 4;
        if (data[o + 3] < 24) continue;
        px.push([data[o], data[o + 1], data[o + 2]]);
      }
    }
    if (!px.length) return [];
    return medianCut(px, Math.max(2, Math.min(16, k)));
  }

  /* 每个像素映射到最近色号；透明像素记 255（跳过）。 */
  function assignMap(src, rect, palette) {
    const { data, w } = src;
    const out = new Uint8Array(rect.w * rect.h);
    const cache = new Int16Array(64 * 64 * 64).fill(-1);
    const n = palette.length;
    for (let y = 0; y < rect.h; y++) {
      const gy = rect.y + y;
      for (let x = 0; x < rect.w; x++) {
        const o = ((gy * w) + (rect.x + x)) * 4;
        if (data[o + 3] < 24) { out[y * rect.w + x] = 255; continue; }
        const r = data[o], g = data[o + 1], b = data[o + 2];
        const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
        let idx = cache[key];
        if (idx < 0) {
          let best = 0, bestD = Infinity;
          for (let i = 0; i < n; i++) {
            const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
            const d = dr * dr * 0.9 + dg * dg * 1.1 + db * db * 0.8;
            if (d < bestD) { bestD = d; best = i; }
          }
          idx = best;
          cache[key] = best;
        }
        out[y * rect.w + x] = idx;
      }
    }
    return out;
  }

  /* ---------------- 轮廓追踪 --------------
   * 做法：对二值 mask 收集「内像素与外像素之间的有向边」，再按端点串成闭环。
   * 比 marching squares 少一层插值歧义，而且天然把洞（反向环）也带出来，
   * path 用 fill-rule="evenodd" 一次成形。 */
  function traceLoops(mask, rw, rh, minArea) {
    const W1 = rw + 1;
    const edges = new Map();
    const add = (a, b) => {
      let arr = edges.get(a);
      if (!arr) { arr = []; edges.set(a, arr); }
      arr.push(b);
    };
    for (let y = 0; y < rh; y++) {
      const row = y * rw;
      for (let x = 0; x < rw; x++) {
        if (!mask[row + x]) continue;
        const p00 = y * W1 + x, p10 = p00 + 1, p01 = p00 + W1, p11 = p01 + 1;
        if (y === 0 || !mask[row - rw + x]) add(p00, p10);          // 上
        if (x === rw - 1 || !mask[row + x + 1]) add(p10, p11);      // 右
        if (y === rh - 1 || !mask[row + rw + x]) add(p11, p01);     // 下
        if (x === 0 || !mask[row + x - 1]) add(p01, p00);           // 左
      }
    }
    const loops = [];
    let guard = edges.size * 4 + 16;
    while (edges.size && guard-- > 0) {
      const start = edges.keys().next().value;
      let cur = start;
      const ids = [start];
      let inner = 400000;
      let closed = false;
      while (inner-- > 0) {
        const arr = edges.get(cur);
        if (!arr || !arr.length) break;
        const next = arr.pop();
        if (!arr.length) edges.delete(cur);
        if (next === start) { closed = true; break; }
        ids.push(next);
        cur = next;
      }
      if (!closed || ids.length < 4) continue;
      const pts = ids.map(id => ({ x: id % W1, y: Math.floor(id / W1) }));
      let area = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
      }
      area = Math.abs(area / 2);
      if (area >= minArea) loops.push({ pts: pts, area: area });
    }
    return loops;
  }

  /* Chaikin 角切平滑：把像素台阶的锯齿磨掉。只对闭合环做，不改拓扑。 */
  function chaikinClosed(pts, iter) {
    let out = pts;
    for (let k = 0; k < iter; k++) {
      const n = out.length;
      if (n < 4) break;
      const next = [];
      for (let i = 0; i < n; i++) {
        const a = out[i], b = out[(i + 1) % n];
        next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out = next;
    }
    return out;
  }

  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = 1; keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const p = pts[i];
        const d = Math.abs(dy * p.x - dx * p.y + bx * ay - by * ax) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /* 轮廓转路径：默认输出三次贝塞尔（Catmull-Rom → C 控制点），并做尖角保护。
   * 之前只出 M/L/Z 折线，像素台阶会被原样保留，小图上看起来就是一堆不规则方块。
   * 转角超过 cornerDeg 的顶点仍按折线处理，避免把所有拐角都抹圆。 */
  function loopToPath(pts, ox, oy, opt) {
    const o = opt || {};
    const n = pts.length;
    const curve = o.curve !== false && n >= 5;
    const cornerRad = num(o.cornerDeg, 55) * Math.PI / 180;
    const corner = new Uint8Array(n);
    if (curve) {
      for (let i = 0; i < n; i++) {
        const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
        const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (!la || !lb) { corner[i] = 1; continue; }
        const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
        if (Math.acos(cos) >= cornerRad) corner[i] = 1;
      }
    }
    const px = i => r1(pts[i].x + ox);
    const py = i => r1(pts[i].y + oy);
    let s = 'M' + px(0) + ',' + py(0);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const k = (j + 1) % n;
      if (!curve || corner[i] || corner[j]) {
        s += 'L' + px(j) + ',' + py(j);
        continue;
      }
      const p1 = pts[i], p2 = pts[j], p0 = pts[(i - 1 + n) % n], p3 = pts[k];
      /* Catmull-Rom 张力 1/6：曲线过每个顶点，控制点只由相邻点决定 */
      const t = 1 / 6;
      const c1x = p1.x + (p2.x - p0.x) * t, c1y = p1.y + (p2.y - p0.y) * t;
      const c2x = p2.x - (p3.x - p1.x) * t, c2y = p2.y - (p3.y - p1.y) * t;
      s += 'C' + r1(c1x + ox) + ',' + r1(c1y + oy) + ','
        + r1(c2x + ox) + ',' + r1(c2y + oy) + ','
        + px(j) + ',' + py(j);
    }
    return s + 'Z';
  }

  /* ---------------- 工具 1：inspect_raster ---------------- */
  function toolInspect() {
    const src = requireSource();
    const { data, w, h } = src;
    const total = w * h;
    const step = Math.max(1, Math.floor(Math.sqrt(total / 150000)));

    let opaque = 0, counted = 0;
    const palette = paletteFromRegion(src, { x: 0, y: 0, w: w, h: h }, 10);
    const luma = lumaOf(src);

    // 主色占比：用采样像素做一次最近色分配
    const shares = new Array(palette.length).fill(0);
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const o = (y * w + x) * 4;
        counted++;
        if (data[o + 3] < 24) continue;
        opaque++;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        let best = 0, bestD = Infinity;
        for (let i = 0; i < palette.length; i++) {
          const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = i; }
        }
        shares[best]++;
      }
    }
    const paletteOut = palette.map((c, i) => ({
      hex: hex(c),
      share: counted ? Math.round(shares[i] / Math.max(1, opaque) * 1000) / 1000 : 0
    })).filter(p => p.share >= 0.005);
    /* median cut 会在渐变里切出几个几乎同色的格子：占比极低又重复的色号直接从事实里去掉，
       否则模型会对着 0% 的色号做无意义决策。 */
    const uniq = [];
    paletteOut.sort((a, b) => b.share - a.share).forEach(p => {
      if (!uniq.some(q => q.hex === p.hex)) uniq.push(p);
    });

    /* 边缘密度分区：4×4 格。文字 / 细节密集的格子会浮到前面，
       让模型按区域调用 trace_region，而不是一次 trace 全图。 */
    const cols = 4, rows = 4;
    const cells = [];
    let edgeTotal = 0, edgeSamples = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x0 = Math.floor(cx * w / cols), x1 = Math.floor((cx + 1) * w / cols);
        const y0 = Math.floor(cy * h / rows), y1 = Math.floor((cy + 1) * h / rows);
        let edge = 0, samples = 0, colors = 0;
        const seen = {};
        for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y += 3) {
          for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x += 3) {
            const i = y * w + x;
            const gx = Math.abs(luma[i + 1] - luma[i - 1]);
            const gy = Math.abs(luma[i + w] - luma[i - w]);
            samples++;
            if (gx + gy >= 30) edge++;
            const o = i * 4;
            if (data[o + 3] >= 24) {
              const key = (data[o] >> 4) + ',' + (data[o + 1] >> 4) + ',' + (data[o + 2] >> 4);
              if (!seen[key]) { seen[key] = 1; colors++; }
            }
          }
        }
        const density = samples ? edge / samples : 0;
        edgeTotal += edge; edgeSamples += samples;
        cells.push({
          bbox: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
          edge: Math.round(density * 1000) / 1000,
          colors: colors,
          text_hint: density > 0.22 && colors < 12 ? '可能含文字/线条' : ''
        });
      }
    }
    const busy = cells.slice().sort((a, b) => (b.edge * Math.log(b.colors + 2)) - (a.edge * Math.log(a.colors + 2)))
      .slice(0, 6).map(c => ({
        x: Math.max(0, c.bbox.x - 6), y: Math.max(0, c.bbox.y - 6),
        w: Math.min(w - Math.max(0, c.bbox.x - 6), c.bbox.w + 12),
        h: Math.min(h - Math.max(0, c.bbox.y - 6), c.bbox.h + 12),
        edge: c.edge, colors: c.colors, note: c.text_hint
      }));

    return {
      image: {
        w: w, h: h, aspect: Math.round(w / h * 1000) / 1000,
        transparent: Math.round((1 - opaque / Math.max(1, counted)) * 1000) / 1000,
        version: src.version,
        scaled_from: src.naturalW !== w || src.naturalH !== h ? [src.naturalW, src.naturalH] : null
      },
      palette: uniq.slice(0, 6),
      edges: { density: edgeSamples ? Math.round(edgeTotal / edgeSamples * 1000) / 1000 : 0 },
      regions: busy,
      next: '先对 regions 里最复杂的 1~3 块调 trace_region（layer 按背景/主体/细节分配），再 ocr_text 找文字'
    };
  }

  /* ---------------- 工具 2：trace_region ---------------- */
  function toolTrace(args) {
    const src = requireSource();
    const rect = clampRegion(args && args.region, src.w, src.h);
    if (rect.w * rect.h > MAX_REGION_PX) {
      throw new Error('区域过大（' + rect.w + '×' + rect.h + '）：请拆成不超过 '
        + MAX_REGION_PX + ' 像素的小块分别调用 trace_region');
    }
    const k = int(args && args.palette_size, 6, 2, 16);
    const simplify = Math.max(0, Math.min(10, num(args && args.simplify, 1.2)));
    const maxPaths = int(args && args.max_paths, 120, 4, 400);
    const minArea = int(args && args.min_area, Math.max(16, Math.round(rect.w * rect.h / 40000)), 4, 4000);
    const layer = resolveLayer(d, args && args.layer, 'layer-subject');
    const mode = String((args && args.mode) || 'append').toLowerCase();
    const curveOn = !(args && args.curve === false);
    const cornerDeg = int(args && args.corner_deg, 55, 10, 170);

    /* 同一块重画：先把该层在这个矩形里的旧轮廓删掉，再写新的。
       append 会把旧轮廓和新轮廓叠在一起（颜色不同就是两层边），整图重建时几乎一定会踩到。 */
    let removed = 0;
    if (mode === 'replace' || mode === 'clear') {
      removed = eraseShapesInRect(svgDraftGet(), layer, rect).removed;
    }
    if (mode === 'clear') {
      const dc = svgDraftGet();
      return {
        ok: true, draft_id: dc.id, layer: layer, region: rect, mode: 'clear',
        removed: removed,
        note: '只清空，没有重画：需要新轮廓就再调一次 trace_region（mode=append 或 replace）'
      };
    }

    const palette = paletteFromRegion(src, rect, k);
    if (!palette.length) throw new Error('该区域几乎全透明，没有可追踪的内容');

    const idxMap = assignMap(src, rect, palette);
    const areas = new Array(palette.length).fill(0);
    for (let i = 0; i < idxMap.length; i++) {
      const v = idxMap[i];
      if (v !== 255) areas[v]++;
    }

    const perColor = Math.max(2, Math.floor(maxPaths / palette.length));
    const groups = [];
    for (let p = 0; p < palette.length; p++) {
      if (!areas[p]) continue;
      const mask = new Uint8Array(rect.w * rect.h);
      let n = 0;
      for (let i = 0; i < idxMap.length; i++) if (idxMap[i] === p) { mask[i] = 1; n++; }
      if (!n) continue;
      const loops = traceLoops(mask, rect.w, rect.h, minArea);
      if (!loops.length) continue;
      loops.sort((a, b) => b.area - a.area);
      const picked = loops.slice(0, perColor);
      let d = '';
      picked.forEach(lp => {
        const pts = simplify > 0 ? rdp(lp.pts, simplify) : lp.pts;
        if (pts.length >= 3) {
          d += loopToPath(pts, rect.x, rect.y, { curve: curveOn, cornerDeg: cornerDeg });
        }
      });
      if (!d) continue;
      groups.push({
        fill: hex(palette[p]), share: Math.round(areas[p] / (rect.w * rect.h) * 1000) / 1000,
        loops: picked.length, d: d
      });
    }
    if (!groups.length) throw new Error('没有追踪到有效轮廓：试试调小 min_area 或提高 palette_size');
    groups.sort((a, b) => b.share - a.share);

    const write = svgDraftAppendPaths(null, layer, groups.map(g => ({ d: g.d, fill: g.fill })));
    const draft = svgDraftGet();
    return {
      ok: true,
      draft_id: draft.id,
      layer: layer,
      region: rect,
      mode: mode === 'replace' ? 'replace' : 'append',
      removed: removed,
      palette: groups.map(g => ({ fill: g.fill, share: g.share, loops: g.loops })),
      path_count: write.added,
      deduped: write.deduped,
      bytes: groups.reduce((s, g) => s + g.d.length, 0),
      /* 只留 1 条样例：Astra 复核时看一条曲线就够，完整 d 留在本地草稿里。
         返回 3 条 × 200 字，四个区域就是 2.4k 字符的纯历史噪声。 */
      sample: groups.slice(0, 1).map(g => ({ fill: g.fill, loops: g.loops, d: cut(g.d, 120) })),
      note: '路径已写入本地草稿，不需要在对话里回传 SVG；用 render_svg_compare 看差异'
    };
  }

  /* ---------------- 工具 3：write_text ----------------
   * 文字层专用：模型只给「内容 + 框 + 颜色」，字号/基线/转义由本地算。
   * 之前让模型手写 <text …> 片段，经常漏 data-text、字号乱给、把 XML 写坏；
   * 生图模型最爱把文字画成乱码，这一层必须能低成本重写。 */
  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normHex(v, fallback) {
    const s = String(v || '').trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fallback;
  }

  function toolWriteText(args) {
    const d = resolveDraft(args);
    const src = requireSource();
    const layer = 'layer-text';
    const raw = (Array.isArray(args && args.items) && args.items.length)
      ? args.items
      : [{ text: args && args.text, bbox: args && args.bbox, fill: args && args.fill,
         weight: args && args.weight, family: args && args.family }];
    const items = [];
    raw.forEach((it, i) => {
      const text = String((it && it.text) || '').trim();
      if (!text) return;
      let box;
      try { box = clampRegion(it.bbox, src.w, src.h); }
      catch (e) { throw new Error('第 ' + (i + 1) + ' 条缺少 bbox（x/y/w/h）'); }
      items.push({
        text: text, box: box,
        fill: normHex(it.fill, '#111111'),
        weight: it.weight === 'bold' ? 'bold' : 'normal',
        family: String(it.family || 'sans-serif')
      });
    });
    if (!items.length) throw new Error('没有可写入的文字：text 不能为空');

    /* 同一个框里重写文字会叠字：先把该框内的旧文字节点删掉 */
    let removed = 0;
    items.forEach(it => { removed += deleteNodesInRect(d, layer, it.box); });

    const ids = items.map(it => {
      const b = it.box;
      const size = Math.max(6, Math.round(b.h * 0.8));
      const cx = Math.round(b.x + b.w / 2);
      const cy = Math.round(b.y + b.h / 2 + size * 0.34);   // 基线偏移，不用 dominant-baseline
      const markup = '<text x="' + cx + '" y="' + cy + '" font-size="' + size
        + '" font-family="' + xmlEscape(it.family) + '" font-weight="' + it.weight
        + '" fill="' + it.fill + '" text-anchor="middle"'
        + ' data-text="' + xmlEscape(it.text) + '"'
        + ' data-source-bbox="' + b.x + ',' + b.y + ',' + b.w + ',' + b.h + '">'
        + xmlEscape(it.text) + '</text>';
      return addRawNode(d, layer, markup, { x: b.x, y: b.y, w: b.w, h: b.h });
    });

    return {
      ok: true,
      draft_id: d.id,
      layer: layer,
      written: items.length,
      removed: removed,
      ids: ids,
      items: items.map(it => ({ text: it.text, box: it.box, fill: it.fill })),
      note: '已写入文字层（data-text / data-source-bbox 自动带上）；字号按框高 0.8 倍估，偏大偏小就调 bbox 重写'
    };
  }

  /* ---------------- 工具 3：ocr_text ----------------
   * 本地没有 OCR 引擎。这里只做「文字候选区域」的启发式检测：
   * 高频细边缘 + 低色彩数的格子里，成行成块的就是候选。
   * text 恒为 null —— 不要在 UI 上假装已经识别出文字。 */
  function toolOcr(args) {
    const src = requireSource();
    const rect = clampRegion(
      (args && args.region) || { x: 0, y: 0, w: src.w, h: src.h }, src.w, src.h);
    const maxRegions = int(args && args.max_regions, 10, 1, 24);
    const luma = lumaOf(src);
    const CELL = 8;
    const gw = Math.ceil(rect.w / CELL), gh = Math.ceil(rect.h / CELL);
    const dense = new Uint8Array(gw * gh);   // 1 = 该格里笔画密集
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let hits = 0, samples = 0;
        for (let y = gy * CELL; y < Math.min(rect.h, (gy + 1) * CELL); y += 2) {
          for (let x = gx * CELL; x < Math.min(rect.w, (gx + 1) * CELL); x += 2) {
            const ix = rect.x + x, iy = rect.y + y;
            if (ix <= 0 || iy <= 0 || ix >= src.w - 1 || iy >= src.h - 1) continue;
            const i = iy * src.w + ix;
            samples++;
            const gx2 = Math.abs(luma[i + 1] - luma[i - 1]);
            const gy2 = Math.abs(luma[i + src.w] - luma[i - src.w]);
            if (gx2 + gy2 >= 34) hits++;
          }
        }
        dense[gy * gw + gx] = samples && hits / samples > 0.25 ? 1 : 0;
      }
    }

    // 格级连通块（横向允许 1 格缺口，纵向不允许——文字行是横向延伸的）
    const seen = new Uint8Array(gw * gh);
    const boxes = [];
    for (let i = 0; i < dense.length; i++) {
      if (!dense[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let minx = gw, maxx = 0, miny = gh, maxy = 0, count = 0;
      while (stack.length) {
        const c = stack.pop();
        const cx = c % gw, cy = Math.floor(c / gw);
        if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        count++;
        const near = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
        near.forEach(([nx, ny]) => {
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) return;
          const ni = ny * gw + nx;
          if (dense[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        });
      }
      boxes.push({ minx, maxx, miny, maxy, count });
    }

    // 过小的块是噪点；过高的块不是单行文字
    const lines = boxes.map(b => ({
      x: rect.x + b.minx * CELL,
      y: rect.y + b.miny * CELL,
      w: Math.min(rect.w, (b.maxx + 1) * CELL - b.minx * CELL),
      h: Math.min(rect.h, (b.maxy + 1) * CELL - b.miny * CELL),
      fill: Math.round(b.count / Math.max(1, (b.maxx - b.minx + 1) * (b.maxy - b.miny + 1)) * 100) / 100
    })).filter(b => b.w >= 24 && b.h >= 9 && b.h <= 140 && b.fill >= 0.35);

    // 同一行内相邻的块合并成段
    lines.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    lines.forEach(b => {
      const m = merged.find(t => {
        const overlapX = Math.min(t.x + t.w, b.x + b.w) - Math.max(t.x, b.x);
        const vgap = Math.abs((t.y + t.h) - b.y);
        return overlapX > 0 && vgap <= 10 && Math.abs(t.h - b.h) <= 10;
      });
      if (m) {
        const x2 = Math.max(m.x + m.w, b.x + b.w), y2 = Math.max(m.y + m.h, b.y + b.h);
        m.x = Math.min(m.x, b.x); m.y = Math.min(m.y, b.y);
        m.w = x2 - m.x; m.h = y2 - m.y; m.lines = (m.lines || 1) + 1;
      } else {
        merged.push({ x: b.x, y: b.y, w: b.w, h: b.h, lines: 1 });
      }
    });

    const regions = merged
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, maxRegions)
      .map(r => ({
        bbox: { x: r.x, y: r.y, w: r.w, h: r.h },
        lines: r.lines,
        confidence: r.h > 200 ? 'low' : r.lines > 1 ? 'medium' : 'low'
      }));

    return {
      text: null,
      engine: 'heuristic',
      regions: regions,
      note: '本地没有 OCR 引擎：只给出文字候选框，内容需结合原图判断（或用后续接引擎）。'
        + '写入 layer-text 时请用 <text> 并带 data-text / data-source-bbox'
    };
  }

  /* ---------------- 工具 4：render_svg_compare ---------------- */
  function svgDataUrl(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function scaledSource(src, cw, ch) {
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, cw, ch);
    g.drawImage(src.canvas, 0, 0, cw, ch);
    return g.getImageData(0, 0, cw, ch).data;
  }

  /* transparent=true 时不铺白底：分层掩膜/遮挡关系要靠 alpha 判断「这一层画到了哪」 */
  function rasterizeSvg(svg, cw, ch, transparent) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!transparent) {
          g.fillStyle = DET.bg;
          g.fillRect(0, 0, cw, ch);
        }
        g.drawImage(img, 0, 0, cw, ch);
        resolve(g.getImageData(0, 0, cw, ch).data);
      };
      img.onerror = () => reject(new Error('SVG 无法栅格化（可能有非法标签或外链资源）'));
      img.src = svgDataUrl(svg);
    });
  }

  function edgesOf(rgba, w, h) {
    const luma = new Uint8Array(w * h);
    for (let i = 0, o = 0; i < luma.length; i++, o += 4) {
      luma[i] = Math.round(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114);
    }
    const edge = new Uint8Array(w * h);
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = Math.abs(luma[i + 1] - luma[i - 1]);
        const gy = Math.abs(luma[i + w] - luma[i - w]);
        if (gx + gy >= DET.edgeThreshold) { edge[i] = 1; count++; }
      }
    }
    return { edge: edge, count: count };
  }

  /* 比对 / 消融共用同一把尺子：同样的加权、同样的分块、同样的阈值 */
  function scoreRasters(a, b, cw, ch, scale) {
    let diff = 0;
    for (let o = 0; o < a.length; o += 4) {
      diff += (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2])) / 3;
    }
    const pixelError = diff / (a.length / 4) / 255;

    const ea = edgesOf(a, cw, ch), eb = edgesOf(b, cw, ch);
    let inter = 0, union = 0;
    for (let i = 0; i < ea.edge.length; i++) {
      const x = ea.edge[i], y = eb.edge[i];
      if (x && y) inter++;
      if (x || y) union++;
    }
    const edgeError = union ? 1 - inter / union : 0;

    /* 分块找最差的地方：模型据此决定「补 trace 哪一块」，而不是盲目重画全图 */
    const BS = DET.blockSize;
    const bw = Math.ceil(cw / BS), bh = Math.ceil(ch / BS);
    const blocks = [];
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let pe = 0, n = 0, sa = 0, sb = 0;
        for (let y = by * BS; y < Math.min(ch, (by + 1) * BS); y += 2) {
          for (let x = bx * BS; x < Math.min(cw, (bx + 1) * BS); x += 2) {
            const i = y * cw + x, o = i * 4;
            pe += (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2])) / 3;
            n++;
            sa += ea.edge[i]; sb += eb.edge[i];
          }
        }
        const e = n ? pe / n / 255 : 0;
        const ed = n ? Math.abs(sa - sb) / n : 0;
        blocks.push({
          x: Math.round(bx * BS / scale), y: Math.round(by * BS / scale),
          w: Math.round(Math.min(BS, cw - bx * BS) / scale),
          h: Math.round(Math.min(BS, ch - by * BS) / scale),
          score: Math.round((e * 0.65 + ed * 0.35) * 1000) / 1000,
          kind: sa > sb ? 'missing' : sb > sa ? 'extra' : 'color'
        });
      }
    }
    blocks.sort((p, q) => q.score - p.score);

    const globalScore = Math.max(0, Math.min(1, 1 - (pixelError * 0.6 + edgeError * 0.4)));
    const verdict = globalScore >= 0.9 ? 'excellent' : globalScore >= 0.8 ? 'good'
      : globalScore >= 0.65 ? 'fair' : 'poor';
    return {
      global_score: Math.round(globalScore * 1000) / 1000,
      pixel_error: Math.round(pixelError * 1000) / 1000,
      edge_error: Math.round(edgeError * 1000) / 1000,
      verdict: verdict,
      blocks: blocks
    };
  }

  function compareFrame(src) {
    const s = Math.min(1, DET.refMaxSide / Math.max(src.w, src.h));
    return {
      scale: s,
      cw: Math.max(1, Math.round(src.w * s)),
      ch: Math.max(1, Math.round(src.h * s))
    };
  }

  async function toolCompare(args) {
    const d = resolveDraft(args);
    applyOverride(d, args);
    const src = requireSource();
    const f = compareFrame(src);
    const a = scaledSource(src, f.cw, f.ch);
    const b = await rasterizeSvg(d.svg, f.cw, f.ch);
    const r = scoreRasters(a, b, f.cw, f.ch, f.scale);
    return {
      draft_id: d.id,
      source_version: src.version,
      evaluated_at: [f.cw, f.ch],
      global_score: r.global_score,
      pixel_error: r.pixel_error,
      edge_error: r.edge_error,
      verdict: r.verdict,
      top_mismatches: r.blocks.slice(0, 5).map(b2 => ({
        bbox: { x: b2.x, y: b2.y, w: b2.w, h: b2.h },
        score: b2.score,
        kind: b2.kind,
        note: b2.kind === 'missing' ? '原图这里更实：可能漏追踪/漏画' : b2.kind === 'extra' ? 'SVG 这里更实：可能多画了轮廓' : '主要是颜色偏差'
      }))
    };
  }

  /* ---------------- 分层掩膜 / 遮挡 / 消融 ---------------- */
  async function layerMasksOf(svg, cw, ch, ids) {
    const out = {};
    const list = Array.isArray(ids) && ids.length ? ids : LAYER_IDS;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const data = await rasterizeSvg(svgOnlyLayers(svg, [id]), cw, ch, true);
      const m = new Uint8Array(cw * ch);
      for (let p = 0; p < m.length; p++) {
        m[p] = data[p * 4 + 3] >= DET.minAlpha ? 1 : 0;
      }
      out[id] = m;
    }
    return out;
  }

  /* 遮挡：order 里越靠后越在上层。ratio = 该层画到的像素里被更高层盖住的比例。 */
  function occlusionOf(masks, order) {
    const list = [];
    (order || LAYER_IDS).forEach((id, i) => {
      const m = masks[id];
      if (!m) return;
      let painted = 0, covered = 0;
      for (let p = 0; p < m.length; p++) {
        if (!m[p]) continue;
        painted++;
        for (let j = i + 1; j < order.length; j++) {
          const up = masks[order[j]];
          if (up && up[p]) { covered++; break; }
        }
      }
      list.push({
        layer: id, painted: painted, covered: covered,
        ratio: painted ? Math.round(covered / painted * 1000) / 1000 : 0
      });
    });
    return list;
  }

  async function toolLayerReport(args) {
    const d = resolveDraft(args);
    applyOverride(d, args);
    const src = requireSource();
    const f = compareFrame(src);
    const a = scaledSource(src, f.cw, f.ch);
    const b = await rasterizeSvg(d.svg, f.cw, f.ch);
    const base = scoreRasters(a, b, f.cw, f.ch, f.scale);

    const struct = layerStatsOf(parseSvg(d.svg), d);
    const ids = layerIdsOf(d);
    const masks = await layerMasksOf(d.svg, f.cw, f.ch, ids);
    const canvasPx = f.cw * f.ch;

    /* 整图重画最怕的不是「不像」，而是「漏画」：源图有内容、所有图层都没画到的块。
       这里直接给出这些块的坐标，模型可以照着补 trace_region。 */
    const union = new Uint8Array(canvasPx);
    ids.forEach(id => {
      const m = masks[id];
      if (!m) return;
      for (let p = 0; p < canvasPx; p++) if (m[p]) union[p] = 1;
    });
    const stepX = src.w / f.cw, stepY = src.h / f.ch;
    const spanX = Math.max(1, Math.floor(stepX)), spanY = Math.max(1, Math.floor(stepY));
    let contentPx = 0, uncoveredPx = 0;
    for (let y = 0; y < f.ch; y++) {
      for (let x = 0; x < f.cw; x++) {
        const bx = Math.min(src.w - 1, Math.floor(x * stepX));
        const by = Math.min(src.h - 1, Math.floor(y * stepY));
        let has = 0;
        for (let dy = 0; dy < spanY && !has; dy++) {
          for (let dx = 0; dx < spanX && !has; dx++) {
            const px = bx + dx, py = by + dy;
            if (px >= src.w || py >= src.h) continue;
            if (src.data[(py * src.w + px) * 4 + 3] >= DET.minAlpha) has = 1;
          }
        }
        if (!has) continue;
        contentPx++;
        if (!union[y * f.cw + x]) uncoveredPx++;
      }
    }
    const BS = DET.blockSize;
    const bw = Math.ceil(f.cw / BS), bh = Math.ceil(f.ch / BS);
    const holes = [];
    /* 每个块统计「源图有内容但四层都没画」的比例；取最严重的 6 块给模型补画 */
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let content = 0, miss = 0;
        for (let y = by * BS; y < Math.min(f.ch, (by + 1) * BS); y++) {
          for (let x = bx * BS; x < Math.min(f.cw, (bx + 1) * BS); x++) {
            const sx = Math.min(src.w - 1, Math.floor(x * stepX));
            const sy = Math.min(src.h - 1, Math.floor(y * stepY));
            if (src.data[(sy * src.w + sx) * 4 + 3] < DET.minAlpha) continue;
            content++;
            if (!union[y * f.cw + x]) miss++;
          }
        }
        if (content < 24 || miss < 16) continue;
        const ratio = miss / content;
        if (ratio < 0.35) continue;
        holes.push({
          x: Math.round(bx * BS / f.scale), y: Math.round(by * BS / f.scale),
          w: Math.round(Math.min(BS, f.cw - bx * BS) / f.scale),
          h: Math.round(Math.min(BS, f.ch - by * BS) / f.scale),
          missing_ratio: Math.round(ratio * 1000) / 1000,
          missing_px: miss
        });
      }
    }
    holes.sort((p, q) => q.missing_px - p.missing_px);
    const coverage = ids.map(id => {
      const st = struct.layers.find(l => l.id === id);
      const m = masks[id];
      let painted = 0;
      for (let p = 0; p < m.length; p++) painted += m[p];
      return {
        layer: id,
        covered_ratio: Math.round(painted / canvasPx * 1000) / 1000,
        painted: painted,
        paths: st ? st.paths : 0,
        texts: st ? st.texts : 0,
        bytes: st ? st.bytes : 0,
        bbox: st ? st.bbox : null
      };
    });

    /* 消融：逐层隐藏后重算分数，delta>0 说明这层有用、绝对值越大越关键 */
    const ablation = [];
    if (args && args.with_ablation) {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const st = struct.layers.find(l => l.id === id);
        if (!st || (!st.paths && !st.texts)) continue;
        const b2 = await rasterizeSvg(svgOnlyLayers(d.svg, ids.filter(l => l !== id)), f.cw, f.ch);
        const r2 = scoreRasters(a, b2, f.cw, f.ch, f.scale);
        ablation.push({
          hidden: id,
          score: r2.global_score,
          delta: Math.round((base.global_score - r2.global_score) * 1000) / 1000,
          pixel_error: r2.pixel_error
        });
      }
    }

    /* 质量门禁：整图重画的验收不该只看一个全局分数。
       覆盖缺口、未登记的飘移元素、分数过低，任何一条不过就明确告诉模型「还没到可以收口」。 */
    const GATE = { min_score: 0.6, min_covered: 0.92, max_holes: 0 };
    const gateReasons = [];
    const coveredRatio = contentPx ? (contentPx - uncoveredPx) / contentPx : 1;
    if (coveredRatio < GATE.min_covered) {
      gateReasons.push('覆盖不足：' + Math.round(coveredRatio * 100) + '% < '
        + Math.round(GATE.min_covered * 100) + '%');
    }
    if (holes.length > GATE.max_holes) gateReasons.push('还有 ' + holes.length + ' 个未画到的块');
    if (base.global_score < GATE.min_score) {
      gateReasons.push('总分 ' + base.global_score + ' < ' + GATE.min_score);
    }
    if (struct.totals.untagged > 0) {
      gateReasons.push(struct.totals.untagged + ' 个元素没有 data-path-id');
    }

    return {
      draft_id: d.id,
      source_version: src.version,
      evaluated_at: [f.cw, f.ch],
      global_score: base.global_score,
      verdict: base.verdict,
      gate: { pass: gateReasons.length === 0, reasons: gateReasons, thresholds: GATE },
      layer_order: struct.order,
      layers: coverage,
      totals: struct.totals,
      deduped: d.deduped || 0,
      coverage_gap: {
        content_px: contentPx,
        uncovered_px: uncoveredPx,
        covered_ratio: contentPx ? Math.round((contentPx - uncoveredPx) / contentPx * 1000) / 1000 : 1,
        holes: holes.slice(0, 6)
      },
      occlusion: occlusionOf(masks, ids),
      ablation: ablation,
      note: 'occlusion[].ratio = 该层画到的像素里被更高层盖住的比例；ablation[].delta = 隐藏该层后分数掉了多少（正数说明这层有用）；coverage_gap.holes = 源图有内容但四层都没画到的块，优先补 trace_region'
    };
  }

  /* ---------------- 工具 5：validate_svg ---------------- */
  const MEASURE_HOST = 'isvgMeasureHost';

  function measureHost() {
    let host = document.getElementById(MEASURE_HOST);
    if (!host) {
      host = document.createElement('div');
      host.id = MEASURE_HOST;
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
      document.body.appendChild(host);
    }
    return host;
  }

  function toolValidate(args) {
    const d = resolveDraft(args);
    applyOverride(d, args);
    const errors = [], warnings = [];
    let root;
    try { root = parseSvg(d.svg); }
    catch (e) {
      return { ok: false, errors: ['XML 解析失败：' + (e.message || e)], warnings: [], stats: {} };
    }

    const vb = viewBoxOf(root);
    if (root.namespaceURI !== SVG_NS) {
      warnings.push('根节点缺少 xmlns="http://www.w3.org/2000/svg"：data URL 渲染时可能被拒');
    }
    if (!vb) errors.push('缺少 viewBox：各图层无法共享同一坐标系');
    else if (Math.abs(vb.w - d.w) > 1 || Math.abs(vb.h - d.h) > 1) {
      warnings.push('viewBox 是 ' + vb.w + '×' + vb.h + '，源图是 ' + d.w + '×' + d.h + '（草稿会按源图尺寸重采样）');
    }

    const ids = layerIdsOf(d);
    const layers = {};
    ids.forEach(id => {
      const g = root.querySelector('[id="' + id + '"]');
      layers[id] = !!g;
      if (!g) { warnings.push('缺少图层 <g id="' + id + '">'); return; }
      /* 图层必须是 <svg> 的直接子元素：套进别的 <g> 里，绘制顺序就不再由图层栈决定 */
      if (g.parentElement !== root) {
        errors.push('图层 ' + id + ' 不是 <svg> 的直接子元素：层的先后顺序会被父级打乱');
      }
      const tf = String(g.getAttribute('transform') || '').replace(/\s+/g, ' ');
      if (tf && !/^translate\(\s*0[ ,]*0\s*\)$/.test(tf)) {
        errors.push('图层 ' + id + ' 带 transform（' + cut(tf, 40) + '）：图层之间禁止独立缩放/平移');
      }
    });

    /* 层序：文档顺序必须与草稿 layout 一致（自底向上 = 数组顺序） */
    const orderNow = Array.prototype.filter.call(root.children, el =>
      el.nodeType === 1 && ids.indexOf(el.getAttribute('id')) >= 0
    ).map(el => el.getAttribute('id'));
    const orderWant = ids.filter(id => layers[id]);
    if (orderNow.join('|') !== orderWant.join('|')) {
      errors.push('图层顺序错误：实际 [' + orderNow.join(' -> ') + ']，应为 [' + orderWant.join(' -> ') + ']');
    }
    /* 不在 layout 里的顶层 <g> 不算错，但必须点名：它们会画在层序之外 */
    const stray = Array.prototype.filter.call(root.children, el =>
      el.nodeType === 1 && el.tagName.toLowerCase() === 'g'
      && el.getAttribute('id') && ids.indexOf(el.getAttribute('id')) < 0
    ).map(el => el.getAttribute('id'));
    if (stray.length) warnings.push('有未登记的顶层图层：' + stray.slice(0, 4).join('、') + '（导出仍会带上，但面板管不到）');

    if (root.querySelector('image, foreignObject')) {
      errors.push('包含 <image> / <foreignObject>：内嵌位图不可编辑，必须改成矢量路径');
    }
    ['href', 'xlink:href'].forEach(attr => {
      const nodes = root.querySelectorAll('*');
      nodes.forEach(n => {
        if (!n.hasAttribute || !n.hasAttribute(attr)) return;
        const v = n.getAttribute(attr);
        if (!v || String(v).startsWith('#')) return;
        errors.push('<' + n.nodeName + '> 引用了外部资源：' + cut(v, 60));
      });
    });
    if (root.querySelector('script')) errors.push('包含 <script>：SVG 不允许内联脚本');

    // 用真实布局量 bbox：path 的几何边界靠字符串算不可靠
    const host = measureHost();
    host.innerHTML = '';
    const node = document.importNode(root, true);
    node.setAttribute('width', String(d.w));
    node.setAttribute('height', String(d.h));
    host.appendChild(node);

    const shapes = node.querySelectorAll(SHAPE_SEL);
    const shapesTotal = shapes.length;
    const perLayer = {};
    ids.forEach(id => { perLayer[id] = { shapes: 0, oob: 0, bbox: null }; });
    const layerOfShape = el => {
      let p = el.parentElement;
      while (p) {
        const id = p.getAttribute ? p.getAttribute('id') : '';
        if (ids.indexOf(id) >= 0) return id;
        p = p.parentElement;
      }
      return '';
    };
    let oob = 0;
    const oobSample = [];
    let maxOverflow = 0;
    let invisible = 0;
    const LIMIT = 3000;
    for (let i = 0; i < shapesTotal && i < LIMIT; i++) {
      const el = shapes[i];
      if (el.tagName === 'path' && (!el.getAttribute('fill') || el.getAttribute('fill') === 'none')
        && (!el.getAttribute('stroke') || el.getAttribute('stroke') === 'none')) invisible++;
      let box;
      try { box = el.getBBox(); } catch (e) { continue; }
      if (!box || (box.width === 0 && box.height === 0)) continue;
      const ov = Math.max(vb ? vb.x - box.x : -box.x, vb ? vb.y - box.y : -box.y,
        (box.x + box.width) - (vb ? vb.x + vb.w : d.w), (box.y + box.height) - (vb ? vb.y + vb.h : d.h));
      const lid = layerOfShape(el);
      if (lid && perLayer[lid]) {
        perLayer[lid].shapes++;
        perLayer[lid].bbox = unionBox(perLayer[lid].bbox,
          { x: box.x, y: box.y, w: box.width, h: box.height });
      }
      if (ov > 2) {
        oob++;
        maxOverflow = Math.max(maxOverflow, ov);
        if (lid && perLayer[lid]) perLayer[lid].oob++;
        if (oobSample.length < 6) {
          oobSample.push({ layer: lid || '-', tag: el.tagName, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) });
        }
      }
    }
    host.innerHTML = '';
    if (shapesTotal > LIMIT) warnings.push('只测量了前 ' + LIMIT + ' 个元素（共 ' + shapesTotal + ' 个）');
    if (oob) {
      errors.push(oob + ' 个元素越出 viewBox（最大越界 ' + Math.round(maxOverflow) + 'px）：局部坐标要把裁剪偏移加回去');
    }
    if (invisible) warnings.push(invisible + ' 个 path 既没有 fill 也没有 stroke，将不可见');

    const texts = root.querySelectorAll('text');
    let noMeta = 0;
    texts.forEach(t => { if (!t.getAttribute('data-text') && !t.getAttribute('data-source-bbox')) noMeta++; });
    if (noMeta) warnings.push(noMeta + ' 个 <text> 缺少 data-text / data-source-bbox，回改时无法定位');

    /* 稳定 id：重复会让差异 / 消融 / 快照对不上同一个形状 */
    const idSeen = {};
    const dupIds = [];
    root.querySelectorAll('[data-path-id]').forEach(el => {
      const k = el.getAttribute('data-path-id');
      if (!k) return;
      idSeen[k] = (idSeen[k] || 0) + 1;
      if (idSeen[k] === 2) dupIds.push(k);
    });
    if (dupIds.length) errors.push('data-path-id 重复：' + dupIds.slice(0, 6).join('、') + '（同一形状会被算两次）');

    /* 按层明细：模型看图层面板 / 测试报告都读这一块，不比整段 SVG 便宜就白搭 */
    const detail = ids.map(id => {
      const g = root.querySelector('[id="' + id + '"]');
      const pl = perLayer[id];
      let paths = 0, tex = 0;
      if (g) {
        g.querySelectorAll(SHAPE_SEL).forEach(el => {
          if (el.tagName === 'path') paths++;
          else if (el.tagName === 'text') tex++;
        });
      }
      return {
        id: id,
        name: (layerOf(d, id) || {}).name || id,
        paths: paths,
        texts: tex,
        shapes: pl.shapes,
        bytes: g ? new XMLSerializer().serializeToString(g).length : 0,
        bbox: pl.bbox ? {
          x: Math.round(pl.bbox.x), y: Math.round(pl.bbox.y),
          w: Math.round(pl.bbox.w), h: Math.round(pl.bbox.h)
        } : null,
        out_of_bounds: pl.oob
      };
    });
    const untagged = root.querySelectorAll(SHAPE_SEL).length - root.querySelectorAll('[data-path-id]').length;
    if (untagged > 0) warnings.push(untagged + ' 个元素没有 data-path-id（本地写入会自动补；外部传入的 svg 不会）');

    const stats = {
      bytes: d.svg.length,
      paths: root.querySelectorAll('path').length,
      texts: texts.length,
      groups: root.querySelectorAll('g').length,
      shapes: shapesTotal,
      layers: layers,
      layers_detail: detail,
      out_of_bounds: oob,
      oob_sample: oobSample
    };
    return { ok: errors.length === 0 && warnings.length === 0, errors: errors, warnings: warnings.slice(0, 6), warning_count: warnings.length, stats: stats, draft_id: d.id, source_version: source ? source.version : 0 };
  }

  /* ---------------- 工具定义（OpenAI function calling） ---------------- */
  const ANCHOR_SCHEMA = {
    type: 'object',
    description: '钢笔锚点：x/y 是画布像素坐标，in/out 是相对锚点的控制柄偏移；两个柄都为 0 时该段是直线',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      in: { type: 'array', items: { type: 'number' }, description: '[dx,dy] 进入控制柄（相对锚点）' },
      out: { type: 'array', items: { type: 'number' }, description: '[dx,dy] 离开控制柄（相对锚点）' }
    },
    required: ['x', 'y']
  };
  const SVG_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'draw_paths',
        description: '钢笔工具：在画布上画线稿/细节。每笔给锚点序列，曲线用控制柄 in/out（相对锚点的像素偏移）；两个柄都为 0 就是直线段。一次提交 6~12 笔，返回 path_id 供 fill_regions 引用。坐标就是画布像素坐标。',
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              description: '要画的笔，一次 1~32 笔',
              items: {
                type: 'object',
                properties: {
                  anchors: { type: 'array', items: ANCHOR_SCHEMA, description: '开放线至少 2 个，闭合形状至少 3 个' },
                  closed: { type: 'boolean', description: '是否闭合；闭合的才能上色' },
                  stroke: { type: 'string', description: '描边色 #rrggbb；none 表示不描边' },
                  width: { type: 'number', description: '描边宽度，默认 2' },
                  fill: { type: 'string', description: '闭合时的填充色 #rrggbb；不填写 none' }
                },
                required: ['anchors']
              }
            },
            layer: { type: 'string', enum: ['layer-background', 'layer-subject', 'layer-detail'], description: '默认 layer-subject；底色进 background，碎细节进 detail' },
            stroke: { type: 'string', description: '这一批的默认描边色，默认 #1b1f24' },
            width: { type: 'number', description: '这一批的默认描边宽度，默认 2' },
            remove_ids: { type: 'array', items: { type: 'string' }, description: '可选：先删掉这些 path_id 再画（整笔重画）' },
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' }
          },
          required: ['paths']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_paths',
        description: '修改已经画好的笔：移锚点、改控制柄、删锚点、整笔平移、闭合/打开、改描边填色、删整笔。改点比重画一笔便宜得多。',
        parameters: {
          type: 'object',
          properties: {
            ops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path_id: { type: 'string', description: 'draw_paths 返回的 id' },
                  action: { type: 'string', enum: ['set_anchor', 'set_handles', 'delete_anchor', 'move', 'close', 'set_style', 'delete_path'] },
                  index: { type: 'integer', description: '锚点下标（set_anchor / set_handles / delete_anchor 用）' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  in: { type: 'array', items: { type: 'number' }, description: '[dx,dy]' },
                  out: { type: 'array', items: { type: 'number' }, description: '[dx,dy]' },
                  dx: { type: 'number', description: 'move 的整体水平位移' },
                  dy: { type: 'number', description: 'move 的整体垂直位移' },
                  closed: { type: 'boolean', description: 'close 用：true 闭合 / false 打开' },
                  fill: { type: 'string', description: 'set_style 用' },
                  stroke: { type: 'string', description: 'set_style 用' },
                  width: { type: 'number', description: 'set_style 用' }
                },
                required: ['path_id', 'action']
              }
            },
            draft_id: { type: 'string' }
          },
          required: ['ops']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fill_regions',
        description: '上色：把颜色填进**已经闭合**的线稿路径（只认闭合路径，引用 draw_paths 返回的 path_id）。不会新建任何形状——缺一块就先 edit_paths 补闭合再填。',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path_id: { type: 'string' },
                  fill: { type: 'string', description: '#rrggbb' },
                  stroke: { type: 'string', description: '可选：同时改描边色，none 表示去掉描边' },
                  width: { type: 'number', description: '可选：同时改描边宽度' }
                },
                required: ['path_id', 'fill']
              }
            },
            fill: { type: 'string', description: '配合 region_path_ids 时的统一填色' },
            region_path_ids: { type: 'array', items: { type: 'string' }, description: '一串已闭合 path_id，统一填同一个颜色' },
            draft_id: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'observe_canvas',
        description: '看自己画的东西：把当前画布栅格化成 PNG，下一轮请求会把这张图作为附图发给你。每画完一批就调一次，用它检查闭合、漏色与比例。',
        parameters: {
          type: 'object',
          properties: {
            size: { type: 'integer', description: '长边像素，默认 640；线稿 512、上色/细化 768 都够' },
            draft_id: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'validate_canvas',
        description: '验收：结构合法、四图层顺序、路径有无越界、填色路径是否闭合、填色路径是否自交。返回 gate.pass；pass=false 时按 errors 修完再验一次，不要带着错误收口。',
        parameters: {
          type: 'object',
          properties: {
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'inspect_raster',
        description: '看参考图：尺寸、透明比例、主色板、4×4 分区边缘密度与最复杂的区域。开始画线稿前先看它，确定构图、比例和主色；之后不要反复调它。',
        parameters: { type: 'object', properties: { image_id: { type: 'string', description: '可选，默认当前图' } } }
      }
    },
    {
      type: 'function',
      function: {
        name: 'trace_region',
        description: '对矩形区域做颜色量化 + 轮廓追踪，把简化后的路径**直接写入本地草稿的指定图层**，只返回摘要（不返回整段 SVG）。坐标是源图像素坐标，输出已加回全局偏移。区域面积上限 900000 像素，过大请拆分。',
        parameters: {
          type: 'object',
          properties: {
            region: {
              type: 'object',
              description: '源图像素坐标下的矩形',
              properties: {
                x: { type: 'number' }, y: { type: 'number' },
                w: { type: 'number' }, h: { type: 'number' }
              },
              required: ['x', 'y', 'w', 'h']
            },
            layer: { type: 'string', enum: ['layer-background', 'layer-subject', 'layer-detail'], description: '写入哪一层；大色块进 background，主体进 subject，碎细节进 detail' },
            palette_size: { type: 'integer', description: '该区域的颜色数，2~16，默认 6' },
            min_area: { type: 'integer', description: '小于该面积的色块丢弃，默认按区域面积自适应' },
            simplify: { type: 'number', description: 'RDP 简化容差（像素），默认 1.2；越大路径越短、越容易丢细节' },
            max_paths: { type: 'integer', description: '本次最多写入多少条路径，默认 120' },
            curve: { type: 'boolean', description: '是否输出三次贝塞尔曲线，默认 true；false 则输出折线（像素台阶会保留）' },
            corner_deg: { type: 'integer', description: '尖角保护阈值（度，默认 55）：转角大于它仍按折线，避免把所有拐角抹圆' },
            mode: {
              type: 'string',
              enum: ['append', 'replace', 'clear'],
              description: 'append=直接追加（默认）；replace=先删掉该层在这个矩形里的旧轮廓再写（同一块重画用这个，避免叠两层）；clear=只清空不重画'
            },
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' }
          },
          required: ['region']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ocr_text',
        description: '检测文字候选区域（本地无 OCR 引擎：text 恒为 null，只返回候选框与行数）。需要你结合原图判断文字内容，再用 write_text 写进 layer-text。',
        parameters: {
          type: 'object',
          properties: {
            region: {
              type: 'object',
              description: '可选，限定检测范围',
              properties: {
                x: { type: 'number' }, y: { type: 'number' },
                w: { type: 'number' }, h: { type: 'number' }
              }
            },
            max_regions: { type: 'integer', description: '最多返回多少个候选区域，默认 10' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_text',
        description: '把文字写进 layer-text：只给内容、外框、颜色，字号与基线由本地计算；同一个框里重写会自动清掉旧文字。适合修复生图模型的乱码/错字。可以一次传 items 写多行。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '单行文字；多行请用 items' },
            bbox: {
              type: 'object',
              description: '这段文字在源图里的外框（像素坐标）',
              properties: {
                x: { type: 'number' }, y: { type: 'number' },
                w: { type: 'number' }, h: { type: 'number' }
              },
              required: ['x', 'y', 'w', 'h']
            },
            fill: { type: 'string', description: '十六进制颜色，默认 #111111' },
            weight: { type: 'string', enum: ['normal', 'bold'], description: '字重，默认 normal' },
            family: { type: 'string', description: '字体族，默认 sans-serif' },
            items: {
              type: 'array',
              description: '多行文字；每项是 {text, bbox, fill?, weight?, family?}',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  bbox: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' }, y: { type: 'number' },
                      w: { type: 'number' }, h: { type: 'number' }
                    },
                    required: ['x', 'y', 'w', 'h']
                  },
                  fill: { type: 'string' },
                  weight: { type: 'string' },
                  family: { type: 'string' }
                },
                required: ['text', 'bbox']
              }
            },
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'render_svg_compare',
        description: '把草稿栅格化，与原图逐像素/边缘比对，返回 global_score、pixel_error、edge_error 和最差的 5 个分块（可直接拿去补 trace_region）。写完后用 append 追加片段，平时不要传整段 SVG。',
        parameters: {
          type: 'object',
          properties: {
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' },
            svg: { type: 'string', description: '可选。传入即**整体替换**草稿；仅重写结构时使用' },
            append: {
              type: 'object',
              description: '可选。把一段 SVG 片段追加进图层（写文字层最省 token），先追加再比对',
              properties: {
                layer: { type: 'string', enum: ['layer-background', 'layer-subject', 'layer-detail', 'layer-text'] },
                markup: { type: 'string', description: '例如 <text x="..." y="..." ...>文字</text>' }
              }
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'layer_report',
        description: '读取当前草稿的分层结构：每层的路径数/文字数/字节/覆盖率/包围盒，以及被上层遮挡的比例。with_ablation=true 时会逐层隐藏并重算分数，用来看是哪一层拖后腿（delta 为正表示这层有用）。',
        parameters: {
          type: 'object',
          properties: {
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' },
            with_ablation: { type: 'boolean', description: '是否做逐层消融（较慢，默认 false）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'validate_svg',
        description: '校验草稿 SVG：XML 合法性、viewBox、四个固定图层的存在与**先后顺序**、逐层越界、data-path-id 唯一性、外链/内嵌位图、文字元数据。返回 stats.layers_detail（每层路径数/字节/bbox/越界数）。最后一步必调。',
        parameters: {
          type: 'object',
          properties: {
            draft_id: { type: 'string', description: '草稿 id；省略则用当前草稿' },
            svg: { type: 'string', description: '可选。传入即整体替换草稿后再校验' },
            append: {
              type: 'object',
              description: '可选。先追加一段 SVG 片段进图层，再校验',
              properties: {
                layer: { type: 'string', enum: ['layer-background', 'layer-subject', 'layer-detail', 'layer-text'] },
                markup: { type: 'string' }
              }
            }
          }
        }
      }
    }
  ];

  async function svgToolRun(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    const d = drafts.get(a.draft_id) || svgDraftGet();
    if (d) d.calls.push({ name: name, at: Date.now() });
    /* 一次工具写入 = 一个可撤销点。整图重画是一长串追加，改坏一笔必须能退回。 */
    const mutates = name === 'draw_paths' || name === 'edit_paths' || name === 'fill_regions'
      || name === 'trace_region' || name === 'write_text'
      || (!!a.svg || !!a.append);
    if (d && mutates) pushUndo(d, name);
    switch (name) {
      case 'draw_paths': return toolDrawPaths(a);
      case 'edit_paths': return toolEditPaths(a);
      case 'fill_regions': return toolFillRegions(a);
      case 'observe_canvas': return toolObserve(a);
      case 'validate_canvas': return toolValidateCanvas(a);
      case 'inspect_raster': return toolInspect(a);
      case 'trace_region': return toolTrace(a);
      case 'write_text': return toolWriteText(a);
      case 'ocr_text': return toolOcr(a);
      case 'render_svg_compare': return toolCompare(a);
      case 'layer_report': return toolLayerReport(a);
      case 'validate_svg': return toolValidate(a);
      default: throw new Error('未知工具：' + name);
    }
  }

  global.SVG_TOOLS = SVG_TOOLS;
  global.svgToolRun = svgToolRun;
  global.svgSetSource = svgSetSource;
  global.svgSourceInfo = svgSourceInfo;
  global.svgDraftNew = svgDraftNew;
  global.svgDraftGet = svgDraftGet;
  global.svgDraftSetCurrent = svgDraftSetCurrent;
  global.svgDraftCurrentId = svgDraftCurrentId;
  global.svgDraftSetSvg = svgDraftSetSvg;
  global.svgDraftToSvg = svgDraftToSvg;
  global.svgDraftReset = svgDraftReset;
  global.svgDraftLayers = svgDraftLayers;
  global.svgDraftSvgForView = svgDraftSvgForView;
  global.svgDraftExport = svgDraftExport;
  global.svgDraftPng = svgDraftPng;
  global.svgDraftAppendPaths = svgDraftAppendPaths;
  global.svgDraftAppendMarkup = svgDraftAppendMarkup;
  global.svgDraftUndo = svgDraftUndo;
  global.svgDraftCanUndo = svgDraftCanUndo;
  global.svgDraftShot = svgDraftShot;
  global.svgDraftModel = function (id) {
    const d = svgDraftGet(id);
    return d ? JSON.parse(JSON.stringify(modelOf(d))) : null;
  };
  global.svgOnlyLayers = svgOnlyLayers;
  global.svgLayerMasks = layerMasksOf;
  global.svgOcclusionOf = occlusionOf;
  global.svgScoreRasters = scoreRasters;
  global.svgLayerIds = LAYER_IDS.slice();
  global.SVG_DET = DET;
  /* 测试报告要把这把尺子写进去：换了浏览器 / 换了 DET 版本，报告不能直接对比 */
  global.svgDeterminism = () => ({
    det: JSON.parse(JSON.stringify(DET)),
    renderer: 'canvas.drawImage(image/svg+xml)',
    note: '同一份 SVG 在同一浏览器里多次栅格化结果一致；跨浏览器抗锯齿不同，分数可能有微小差异'
  });
})(window);
