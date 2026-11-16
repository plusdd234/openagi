/* 线稿重绘台（visionlab）
 *
 * 做的事：位图 → 中线折线 + 线宽（矢量化线稿） → DeepSeek 用工具重新描绘 → 回读指标验证。
 *
 * 只做线稿层，不做填充层。原因：
 *   位图里没有「线」，只有覆盖率。填充件是零宽区域边界，线稿是「中线 + 厚度」，
 *   两者几何对象不同，指标也不同，混在一个 IoU 里必然误判。
 *
 * 依赖既有共享模块：Tracer / Segmenter / toolLoopRun / llmStreamRequest / llmConn。
 * 模型只传 key 与样式，几何一律由程序从提取结果直接复制；创作入口除外，且限 16 个控制点。
 */
(function () {
  'use strict';

  var MAX_EXTRACT = 2048;    // 提取时最长边上限（轮廓模式直接按像素边界取，缩图就是丢精度）
  var MAX_CHECK = 1600;      // 回读栅格化上限
  var STORE_KEY = 'vl.lineRun.v1';

  var S = {
    img: null, imgName: '', w: 0, h: 0,
    region: null,
    strokes: [],          // {key,path,width,color,length,bbox,cx,cy,name,...}
    lexicon: {},
    ops: new Map(),
    view: { s: 1, ox: 0, oy: 0 }, zoomed: false,
    onlyDraw: false,
    ckpt: false,
    drag: null,
    opt: { shape: 'auto', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8, background: 238, tolerance: 26, fill: true },
    lastMode: '', autoStats: null, srcStats: null,
    groups: [], drop: {},
    layers: [], hidden: {},
    activeKey: '',
    busy: false, ctrl: null, stub: false, stubMsgs: null, stubFirst: null,
    metrics: null, best: null, calls: [], runs: [], round: 0,
    customSeq: 0, variant: '', form: 'auto', ready: false, lastReview: ''
  };

  var R = {};
  var CV = null, CTX = null;
  var savedLLM = null;

  /* ---------------- 基础工具 ---------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function fmtK(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(Math.round(n));
    return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hexOf(rgb) {
    return '#' + rgb.map(function (v) {
      var h = clamp(Math.round(v), 0, 255).toString(16);
      return ('0' + h).slice(-2);
    }).join('');
  }
  function rgbOf(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [40, 40, 40];
  }
  /* 线稿颜色：把浅色区域的平均色直接画在白底上等于没画（浅蓝发丝、白纱都是这样）。
   * 亮度高于 150 就按比例压暗，保留色相；深色原样返回。 */
  function inkColor(hex) {
    var c = rgbOf(hex);
    var l = lum(c[0], c[1], c[2]);
    if (l > 150) {
      var k = 110 / l;
      c = c.map(function (v) { return Math.round(v * k); });
    }
    return hexOf(c);
  }
  function hueBucket(hex) {
    var c = rgbOf(hex), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.08) return 0;
    var h;
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return Math.floor(h * 12);
  }
  function lum(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[a.length >> 1];
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[clamp(Math.round((a.length - 1) * p), 0, a.length - 1)];
  }
  function bboxOfPath(path) {
    var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    path.forEach(function (p) {
      if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
      if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
    });
    return [mnx, mny, mxx, mxy];
  }
  function pathLength(path) {
    var L = 0;
    for (var i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    return L;
  }
  function distToSeg(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var wx = p[0] - a[0], wy = p[1] - a[1];
    var L2 = vx * vx + vy * vy;
    var t = L2 ? clamp((wx * vx + wy * vy) / L2, 0, 1) : 0;
    return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
  }

  /* ---------------- 画布 ---------------- */

  function resizeCanvas() {
    if (!CV || !R.stage) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, R.stage.clientWidth), h = Math.max(1, R.stage.clientHeight);
    CV.width = Math.round(w * dpr); CV.height = Math.round(h * dpr);
    CV.style.width = w + 'px'; CV.style.height = h + 'px';
    CTX.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.cw = w; S.ch = h;
  }

  function fitView() {
    if (!S.img) return;
    var pad = 26;
    var s = clamp(Math.min((S.cw - pad * 2) / S.w, (S.ch - pad * 2) / S.h), 0.05, 8);
    S.view.s = s;
    S.view.ox = (S.cw - S.w * s) / 2;
    S.view.oy = (S.ch - S.h * s) / 2;
    S.zoomed = false;
  }

  /* 窗口是可拖拽缩放的浮动面板，缩放时画布尺寸变了但视图没变，
   * 图会按旧比例被裁掉。重排后重新适配；用户自己滚轮缩放过就不打断他。 */
  function syncStage() {
    if (!R.stage || R.wrap.offsetParent === null) return;
    var w = R.stage.clientWidth, h = R.stage.clientHeight;
    if (w === S.cw && h === S.ch) return;
    resizeCanvas();
    if (!S.zoomed) fitView();
    drawScene();
  }

  function canvasPt(ev) {
    var r = CV.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  function toImg(cx, cy) { return [(cx - S.view.ox) / S.view.s, (cy - S.view.oy) / S.view.s]; }
  function toCanvas(ix, iy) { return [ix * S.view.s + S.view.ox, iy * S.view.s + S.view.oy]; }

  function opOf(key) { return S.ops.get(key) || null; }

  /* 线宽上限跟着区域尺寸走：37px 图标上给 4px 线，等于把画面涂掉。
   * 下限 1.2px 保证小图仍能看见，上限 16px 给大图留空间。 */
  function widthCap() {
    var r = S.region || { w: S.w, h: S.h };
    return clamp(Math.min(r.w || 1, r.h || 1) / 24, 1.2, 16);
  }
  function safeWidth(v, fallback) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) n = fallback;
    return clamp(n, 0.35, widthCap());
  }

  function sortedOps() {
    var list = [];
    S.strokes.forEach(function (p) {
      var op = opOf(p.key);
      /* drop = 明确判定为无意义碎块，不参与绘制，也不计入已描绘 */
      if (!op || S.drop[p.key]) return;
      list.push({ part: p, op: op });
    });
    list.sort(function (a, b) {
      var oa = a.op.order != null ? a.op.order : a.part.area;
      var ob = b.op.order != null ? b.op.order : b.part.area;
      return oa - ob;
    });
    return list;
  }

  /* 在指定变换下描一条线：几何用区域坐标，厚度用区域像素 */
  function strokeOne(g, p, op) {
    var bb = p.bbox;
    var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    g.save();
    g.translate(cx + (op.dx || 0), cy + (op.dy || 0));
    if (op.rot) g.rotate(op.rot);
    if (op.sc && op.sc !== 1) g.scale(op.sc, op.sc);
    g.translate(-cx, -cy);
    g.beginPath();
    var path = p.path;
    if (p.region) {
      if (!bezPath(g, p.bez)) curvePath(g, p.path, true);
      (p.holes || []).forEach(function (hp, i) {
        if (!bezPath(g, (p.holeBez || [])[i])) curvePath(g, hp, true);
      });
    } else {
      for (var i = 0; i < path.length; i++) {
        if (i === 0) g.moveTo(path[i][0], path[i][1]); else g.lineTo(path[i][0], path[i][1]);
      }
      if (p.closed) g.closePath();
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(0.35, (op.width != null ? op.width : p.width));
    g.strokeStyle = inkColor(op.color || p.color);
    g.stroke();
    g.restore();
  }

  /* 闭合轮廓默认填色：字是实心块，只描边等于画了个空心框。
   * 孔洞（A 的三角孔）按包含关系挂到外轮廓上，用 evenodd 挖掉。 */
  function pointInPoly(x, y, path) {
    var inside = false;
    for (var i = 0, j = path.length - 1; i < path.length; j = i++) {
      var xi = path[i][0], yi = path[i][1], xj = path[j][0], yj = path[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function addPath(g, path) {
    for (var i = 0; i < path.length; i++) {
      if (i === 0) g.moveTo(path[i][0], path[i][1]); else g.lineTo(path[i][0], path[i][1]);
    }
    g.closePath();
  }

  /* 向心 Catmull-Rom（alpha=0.5）。均匀参数化在锚点疏密不均时会打结、鼓包——
   * 抽稀出来的锚点正好疏密不均（直段一个点、弯处连着一串），所以必须用向心参数化，
   * 否则曲线会「甩出去」再绕回来，看起来就是扭曲。 */
  function crPoint(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; }

  function catmullRomCentripetal(points, closed, steps) {
    var pts = [];
    for (var i = 0; i < points.length; i++) {
      var q = points[i], last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q);
    }
    if (pts.length < 3) return pts;
    var seq = closed === false
      ? [pts[0]].concat(pts, [pts[pts.length - 1]])
      : [pts[pts.length - 1]].concat(pts, [pts[0], pts[1]]);
    var out = [];
    for (var j = 0; j < seq.length - 3; j++) {
      var p0 = seq[j], p1 = seq[j + 1], p2 = seq[j + 2], p3 = seq[j + 3];
      var t0 = 0;
      var t1 = t0 + Math.max(1e-4, Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])));
      var t2 = t1 + Math.max(1e-4, Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
      var t3 = t2 + Math.max(1e-4, Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])));
      for (var s = 0; s < steps; s++) {
        var t = t1 + (t2 - t1) * (s / steps);
        var A1 = crPoint(p0, p1, (t - t0) / (t1 - t0));
        var A2 = crPoint(p1, p2, (t - t1) / (t2 - t1));
        var A3 = crPoint(p2, p3, (t - t2) / (t3 - t2));
        var B1 = crPoint(A1, A2, (t - t0) / (t2 - t0));
        var B2 = crPoint(A2, A3, (t - t1) / (t3 - t1));
        out.push(crPoint(B1, B2, (t - t1) / (t2 - t1)));
      }
    }
    return out;
  }

  /* 闭合区域的落笔口径：锚点是控制点，用 Catmull-Rom 采样成曲线再描。
   * 直接 lineTo 会把 1px 台阶放大成一圈折线，再填色就是「像素图」的观感；
   * 采样后控制点仍只有十几个，可单独拖动，形状是曲线而不是多边形。 */
  function curvePath(g, path, closed) {
    if (!path || path.length < 3) { if (path && path.length) addPath(g, path); return; }
    var pts = catmullRomCentripetal(path, closed !== false, 8);
    for (var i = 0; i < pts.length; i++) {
      if (i === 0) g.moveTo(pts[i][0], pts[i][1]); else g.lineTo(pts[i][0], pts[i][1]);
    }
    if (closed !== false) g.closePath();
  }

  function fillGroups(list) {
    var items = list.map(function (it) {
      var bb = it.part.bbox;
      return { it: it, bb: bb, area: Math.max(1, (bb[2] - bb[0]) * (bb[3] - bb[1])), parent: null };
    });
    items.forEach(function (a) {
      var best = null;
      items.forEach(function (b) {
        if (a === b || b.area <= a.area) return;
        if (a.bb[0] < b.bb[0] || a.bb[1] < b.bb[1] || a.bb[2] > b.bb[2] || a.bb[3] > b.bb[3]) return;
        var p0 = a.it.part.path[0];
        if (!p0 || !pointInPoly(p0[0], p0[1], b.it.part.path)) return;
        if (!best || b.area < best.area) best = b;
      });
      a.parent = best;
    });
    var roots = items.filter(function (a) { return !a.parent; }).map(function (a) {
      return { outer: a.it, holes: [] };
    });
    items.forEach(function (a) {
      if (!a.parent) return;
      var root = a.parent, guard = 0;
      while (root.parent && guard++ < 8) root = root.parent;
      var g = roots.filter(function (r) { return r.outer === root.it; })[0];
      if (g) g.holes.push(a.it);
    });
    return roots;
  }

  function fillOne(g, grp) {
    var p = grp.outer.part, op = grp.outer.op;
    var bb = p.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    g.save();
    g.translate(cx + (op.dx || 0), cy + (op.dy || 0));
    if (op.rot) g.rotate(op.rot);
    if (op.sc && op.sc !== 1) g.scale(op.sc, op.sc);
    g.translate(-cx, -cy);
    g.beginPath();
    addPath(g, p.path);
    grp.holes.forEach(function (h) { addPath(g, h.part.path); });
    g.fillStyle = inkColor(op.color || p.color);
    g.fill('evenodd');
    g.restore();
  }

  /* 色块：外轮廓 + 孔洞一次 evenodd 填完，颜色用区域原色（不压暗）。
   * 边界走曲线：色块锚点本来就少，用折线填出来是一圈多边形，看着像像素图。
   * 多色图靠「面积从大到小逐块盖上去」还原层次：大块打底，小块（嘴、脚、眼）后盖。 */
  function fillRegion(g, p, op) {
    var bb = p.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    g.save();
    g.translate(cx + (op.dx || 0), cy + (op.dy || 0));
    if (op.rot) g.rotate(op.rot);
    if (op.sc && op.sc !== 1) g.scale(op.sc, op.sc);
    g.translate(-cx, -cy);
    g.beginPath();
    if (!bezPath(g, p.bez)) curvePath(g, p.path, true);
    (p.holes || []).forEach(function (hp, i) {
      if (!bezPath(g, (p.holeBez || [])[i])) curvePath(g, hp, true);
    });
    g.fillStyle = op.color || p.color;
    g.fill('evenodd');
    g.restore();
  }

  /* 语义分组：同一部位的碎块（围巾本体 + 阴影、眼白 + 瞳孔）并成一组。
   * 关键约束：只有「套在别的块里面」的成员才当孔洞挖掉，同级并列的成员各自填。
   * 之前把所有非最大成员都当孔洞，两只脚并成一组时右脚会整块消失——
   * 那不是「并部位」，是「吞掉部位」。 */
  function groupedParts(list) {
    var byKey = {}, used = {}, out = [];
    list.forEach(function (it) { if (it.part.region) byKey[it.part.key] = it; });

    S.groups.forEach(function (grp) {
      var members = (grp.keys || []).map(function (k) { return byKey[k]; }).filter(Boolean);
      if (!members.length) return;
      members.forEach(function (m) { used[m.part.key] = 1; });
      members.sort(function (a, b) { return (b.part.area || 0) - (a.part.area || 0); });

      /* 谁是孔：first point 落在另一个更大的成员环内 */
      var parent = {};
      members.forEach(function (m) {
        var p0 = m.part.path[0], best = null;
        if (!p0) return;
        members.forEach(function (o) {
          if (o === m || (o.part.area || 0) <= (m.part.area || 0)) return;
          if (!pointInPoly(p0[0], p0[1], o.part.path)) return;
          if (!best || (o.part.area || 0) < (best.part.area || 0)) best = o;
        });
        parent[m.part.key] = best;
      });

      members.forEach(function (m) {
        if (parent[m.part.key]) return;
        var holes = (m.part.holes || []).slice();
        var holeBez = (m.part.holeBez || []).slice();
        members.forEach(function (c) {
          if (parent[c.part.key] === m) { holes.push(c.part.path); holeBez.push(c.part.bez); }
        });
        out.push({
          area: m.part.area || 0,
          part: {
            path: m.part.path, holes: holes, bbox: m.part.bbox,
            bez: m.part.bez, holeBez: holeBez, tol: m.part.tol,
            color: grp.color || m.part.color
          },
          op: grp.color ? Object.assign({}, m.op, { color: grp.color }) : m.op
        });
      });
    });
    list.forEach(function (it) {
      if (!it.part.region || used[it.part.key]) return;
      out.push({ area: it.part.area || 0, part: it.part, op: it.op });
    });
    return out;
  }

  /* 色块 → 先按语义组填，再补未分组块，最后按面积降序；线仍走原分支 */
  function paintOps(g, list) {
    var hid = {};
    S.layers.forEach(function (l) {
      if (!S.hidden[l.id]) return;
      l.keys.forEach(function (k) { hid[k] = 1; });
    });
    var live = list.filter(function (it) { return !S.drop[it.part.key] && !hid[it.part.key]; });
    var regs = [], strokes = [], fills = [];
    live.forEach(function (it) {
      if (it.part.region) regs.push(it);
      else if (S.opt.fill && it.part.closed && it.part.path.length > 2) fills.push(it);
      else strokes.push(it);
    });
    if (regs.length) {
      groupedParts(live).sort(function (a, b) { return b.area - a.area; })
        .forEach(function (x) { fillRegion(g, x.part, x.op); });
    }
    if (fills.length) fillGroups(fills).forEach(function (grp) { fillOne(g, grp); });
    strokes.forEach(function (it) { strokeOne(g, it.part, it.op); });
  }

  function drawScene() {
    if (!CTX) return;
    CTX.clearRect(0, 0, S.cw, S.ch);
    if (!S.img) return;
    if (S.onlyDraw) {
      /* 只看重绘：遮掉原图，用来判断「单独看还认不认得出」。
       * 色块模式里有白色部件（白肚、白底板），纯白底会把它们吃掉，改用浅灰。 */
      CTX.fillStyle = S.lastMode === 'color' ? '#eef1f5' : '#ffffff';
      CTX.fillRect(0, 0, S.cw, S.ch);
    } else {
      CTX.save();
      CTX.translate(S.view.ox, S.view.oy);
      CTX.scale(S.view.s, S.view.s);
      CTX.imageSmoothingQuality = 'high';
      CTX.drawImage(S.img, 0, 0, S.w, S.h);
      CTX.restore();
    }

    if (S.region && !S.onlyDraw) {
      var a = toCanvas(S.region.x, S.region.y);
      var b = toCanvas(S.region.x + S.region.w, S.region.y + S.region.h);
      CTX.save();
      CTX.setLineDash([5, 4]);
      CTX.lineWidth = 1.4;
      CTX.strokeStyle = '#5b8fd9';
      CTX.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      CTX.restore();
    }

    /* 参考层：还没被描绘的线，淡虚线。
     * 它只是对照——画布上的实线只能来自模型调用 vl_draw_parts，
     * 提取完就自动全量画上去等于「程序画的」，看不出模型到底画了什么。 */
    if (S.strokes.length) {
      CTX.save();
      CTX.translate(S.view.ox, S.view.oy);
      CTX.scale(S.view.s, S.view.s);
      var unit = 1 / S.view.s;
      CTX.setLineDash([3 * unit, 3 * unit]);
      CTX.lineWidth = unit;
      CTX.lineCap = 'round';
      CTX.strokeStyle = 'rgba(120,138,162,.5)';
      S.strokes.forEach(function (p) {
        if (S.ops.has(p.key)) return;
        var path = p.path;
        CTX.beginPath();
        if (p.region) { curvePath(CTX, path, true); }
        else {
          for (var i = 0; i < path.length; i++) {
            if (i === 0) CTX.moveTo(path[i][0], path[i][1]); else CTX.lineTo(path[i][0], path[i][1]);
          }
          if (p.closed) CTX.closePath();
        }
        CTX.stroke();
      });
      CTX.restore();
    }

    CTX.save();
    CTX.translate(S.view.ox, S.view.oy);
    CTX.scale(S.view.s, S.view.s);
    paintOps(CTX, sortedOps());
    CTX.restore();

    if (!S.onlyDraw) drawLabels();
    if (S.ckpt) drawAnchors();

    if (S.drag && S.drag.rect) {
      var d = S.drag.rect;
      var p1 = toCanvas(d.x, d.y), p2 = toCanvas(d.x + d.w, d.y + d.h);
      CTX.save();
      CTX.fillStyle = 'rgba(91,143,217,.12)';
      CTX.fillRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
      CTX.setLineDash([4, 3]);
      CTX.strokeStyle = '#5b8fd9';
      CTX.lineWidth = 1.2;
      CTX.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
      CTX.restore();
    }
  }

  function drawLabels() {
    if (S.view.s < 0.35) return;
    CTX.save();
    CTX.font = '11px ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif';
    CTX.textBaseline = 'middle';
    S.strokes.forEach(function (p) {
      if (!opOf(p.key)) return;
      var bb = p.bbox;
      var c = toCanvas((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
      var name = partName(p);
      var tw = CTX.measureText(name).width + 8;
      CTX.globalAlpha = 0.9;
      CTX.fillStyle = p.key === S.activeKey ? '#5b8fd9' : 'rgba(255,255,255,.88)';
      CTX.fillRect(c[0] - tw / 2, c[1] - 8, tw, 16);
      CTX.strokeStyle = 'rgba(91,143,217,.35)';
      CTX.lineWidth = 1;
      CTX.strokeRect(c[0] - tw / 2, c[1] - 8, tw, 16);
      CTX.fillStyle = p.key === S.activeKey ? '#fff' : '#3a4653';
      CTX.fillText(name, c[0] - tw / 2 + 4, c[1] + 0.5);
    });
    CTX.restore();
  }

  /* 控制点模式：把每个部位的锚点画出来，选中的部位实心、其余半透明。
   * 锚点就是曲线要穿过的点，拖动即改形状；控制点数量由提取时的抽稀口径决定。 */
  function drawAnchors() {
    if (S.view.s < 0.2) return;
    CTX.save();
    S.strokes.forEach(function (p) {
      var hot = !S.activeKey || p.key === S.activeKey;
      CTX.fillStyle = hot ? 'rgba(91,143,217,.95)' : 'rgba(91,143,217,.35)';
      CTX.strokeStyle = '#fff';
      CTX.lineWidth = 1;
      p.path.forEach(function (q) {
        var c = toCanvas(q[0], q[1]);
        CTX.beginPath();
        CTX.arc(c[0], c[1], hot ? 3.2 : 2.2, 0, Math.PI * 2);
        CTX.fill();
        if (hot) CTX.stroke();
      });
    });
    CTX.restore();
  }

  /* 抓最近的控制点（屏幕 10px 以内），选中的部位优先 */
  function nearestAnchor(ip) {
    var best = null, bestD = Math.pow(10 / Math.max(0.01, S.view.s), 2);
    S.strokes.forEach(function (p) {
      var bonus = (!S.activeKey || p.key === S.activeKey) ? 1 : 0.6;
      p.path.forEach(function (q, i) {
        var d = (Math.pow(q[0] - ip[0], 2) + Math.pow(q[1] - ip[1], 2)) * bonus;
        if (d <= bestD) { bestD = d; best = { key: p.key, idx: i }; }
      });
    });
    return best;
  }

  /* ---------------- 图像 ---------------- */

  function setImage(img, name) {
    S.img = img; S.imgName = name || 'image';
    S.w = img.naturalWidth || img.width;
    S.h = img.naturalHeight || img.height;
    S.region = null; S.strokes = []; S.ops = new Map(); S.metrics = null; S.best = null;
    /* 语义分组属于上一张图，换图必须清掉，否则旧 key 会串到新图 */
    S.groups = []; S.drop = {};
    S.activeKey = ''; S.lexicon = {};
    if (R.empty) R.empty.hidden = true;
    resizeCanvas(); fitView(); drawScene();
    renderParts(); updateStat();
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type || '')) return Promise.reject(new Error('不是图片文件'));
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); setImage(img, file.name); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  /* 演示图：粗体文字 + 一条细线。文字用来验证「轮廓模式能不能一笔认出字」，
   * 细线用来验证「中线模式」还活着。 */
  function loadDemo() {
    return new Promise(function (res) {
      var c = document.createElement('canvas');
      c.width = 480; c.height = 360;
      var g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 480, 360);
      g.fillStyle = '#1f2630';
      g.font = 'bold 150px "Microsoft YaHei","PingFang SC",sans-serif';
      g.textBaseline = 'alphabetic';
      g.fillText('字 A', 30, 220);
      g.strokeStyle = '#cb2129'; g.lineWidth = 4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(40, 300); g.lineTo(430, 300); g.stroke();
      var img = new Image();
      img.onload = function () { setImage(img, 'demo'); res(true); };
      img.src = c.toDataURL('image/png');
    });
  }

  function cropData(rect, maxSide) {
    var m = Math.max(1, Math.max(rect.w, rect.h));
    var scale = Math.min(1, maxSide / m);
    var w = Math.max(2, Math.round(rect.w * scale));
    var h = Math.max(2, Math.round(rect.h * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    /* 必须先铺白底：透明像素的 RGB 是 0,0,0，直接读会被当成墨，
     * 图标外围的透明区域就变成一整圈「黑边」，里面反而成了孔。 */
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.drawImage(S.img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    return { data: g.getImageData(0, 0, w, h), scale: scale, w: w, h: h };
  }

  /* 把框选区域缩成一张小图给模型看。
   * 矢量只说明「哪里有墨水」，认不出「这是企鹅」；语义必须回到位图。
   * 尺寸压到 768 以内，JPEG 0.82，避免把几 MB 的截图塞进上下文。 */
  function regionImageURL(maxSide) {
    if (!S.img) return '';
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var m = Math.max(1, Math.max(r.w, r.h));
    var scale = Math.min((maxSide || 768) / m, Math.max(1, 512 / m));
    var w = Math.max(2, Math.round(r.w * scale));
    var h = Math.max(2, Math.round(r.h * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(S.img, r.x, r.y, r.w, r.h, 0, 0, w, h);
    try { return c.toDataURL('image/jpeg', 0.82); } catch (e) { return ''; }
  }

  /* ---------------- 取线：暗线 / 边缘 / 自动 ---------------- */

  function darkThreshold(v) {
    /* 滑杆 5..60 在暗线模式映射成 40..200 的亮度阈值 */
    return clamp(Math.round(60 + (v - 20) * 2), 40, 200);
  }

  function buildLineMask(data, w, h, src, threshold) {
    var seg = Segmenter.segment(data, {
      mode: 'light', background: S.opt.background, tolerance: S.opt.tolerance,
      barrier: 'edge', lineThreshold: 0
    });
    var fg = seg.fg.mask;
    var wall = seg.wall;

    function darkMask(th) {
      var m = new Uint8Array(w * h), d = data.data;
      for (var i = 0; i < w * h; i++) {
        if (!fg[i]) continue;
        if (lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < th) m[i] = 1;
      }
      return m;
    }
    function edgeMask() {
      var m = new Uint8Array(w * h);
      for (var i = 0; i < w * h; i++) if (fg[i] && wall[i]) m[i] = 1;
      return m;
    }

    var mode = src;
    if (mode === 'auto') {
      /* 判据：暗像素面积 vs 边界像素面积。
       * 线稿 / 黑块：暗面本身就是主体，暗像素 ≥ 边界；柔边彩图：暗像素只剩零星深色
       * （眼睛、发丝），真正的结构全在色块边界上。用厚度判据会把人像判成 dark，
       * 实测只提出 31 条碎线，画出来是空白；改成面积比后判 edge，提出 109 条完整轮廓。 */
      var dm = darkMask(darkThreshold(threshold));
      var em = edgeMask();
      var dn = 0, en = 0;
      for (var i = 0; i < w * h; i++) { if (dm[i]) dn++; if (em[i]) en++; }
      mode = (dn > 0 && dn >= en * 0.5) ? 'dark' : 'edge';
      S.srcStats = { dark: dn, edge: en, ratio: en ? round2(dn / en) : 0, mode: mode };
    }
    var mask = mode === 'dark' ? darkMask(darkThreshold(threshold)) : edgeMask();
    return { mask: mask, mode: mode, seg: seg };
  }

  function distTransform(mask, w, h) {
    var INF = 1e9;
    var d = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
    var D1 = 1, D2 = Math.SQRT2;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (d[k] === 0) continue;
        var best = d[k];
        if (x > 0) best = Math.min(best, d[k - 1] + D1);
        if (y > 0) {
          best = Math.min(best, d[k - w] + D1);
          if (x > 0) best = Math.min(best, d[k - w - 1] + D2);
          if (x < w - 1) best = Math.min(best, d[k - w + 1] + D2);
        }
        d[k] = best;
      }
    }
    for (var y2 = h - 1; y2 >= 0; y2--) {
      for (var x2 = w - 1; x2 >= 0; x2--) {
        var k2 = y2 * w + x2;
        if (d[k2] === 0) continue;
        var b2 = d[k2];
        if (x2 < w - 1) b2 = Math.min(b2, d[k2 + 1] + D1);
        if (y2 < h - 1) {
          b2 = Math.min(b2, d[k2 + w] + D1);
          if (x2 < w - 1) b2 = Math.min(b2, d[k2 + w + 1] + D2);
          if (x2 > 0) b2 = Math.min(b2, d[k2 + w - 1] + D2);
        }
        d[k2] = b2;
      }
    }
    return d;
  }

  /* Zhang-Suen 细化：把「线带」压成 1px 中线 */
  function thin(src, w, h) {
    var img = src.slice();
    var changed = true, guard = 0;
    function nb(x, y) {
      var i = y * w + x;
      return [
        img[i - w], img[i - w + 1], img[i + 1], img[i + w + 1],
        img[i + w], img[i + w - 1], img[i - 1], img[i - w - 1]
      ];
    }
    while (changed && guard++ < 80) {
      changed = false;
      for (var step = 0; step < 2; step++) {
        var del = [];
        for (var y = 1; y < h - 1; y++) {
          for (var x = 1; x < w - 1; x++) {
            var i = y * w + x;
            if (!img[i]) continue;
            var p = nb(x, y);
            var B = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
            if (B < 2 || B > 6) continue;
            var A = 0;
            for (var t = 0; t < 8; t++) if (!p[t] && p[(t + 1) % 8]) A++;
            if (A !== 1) continue;
            if (step === 0) {
              if (p[0] * p[2] * p[4] !== 0) continue;
              if (p[2] * p[4] * p[6] !== 0) continue;
            } else {
              if (p[0] * p[2] * p[6] !== 0) continue;
              if (p[0] * p[4] * p[6] !== 0) continue;
            }
            del.push(i);
          }
        }
        if (del.length) { changed = true; del.forEach(function (i) { img[i] = 0; }); }
      }
    }
    return img;
  }

  function neighborsOf(i, w, h, arr) {
    var x = i % w, y = (i / w) | 0, out = [];
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var j = yy * w + xx;
        if (arr[j]) out.push(j);
      }
    }
    return out;
  }

  function traceSkeleton(skel, w, h) {
    var used = new Uint8Array(w * h);
    var lines = [];

    function degOf(i) { return neighborsOf(i, w, h, skel).length; }

    function walk(start) {
      var pts = [[start % w, (start / w) | 0]];
      used[start] = 1;
      var cur = start, prev = -1;
      for (var guard = 0; guard < w * h; guard++) {
        var cands = neighborsOf(cur, w, h, skel).filter(function (j) { return !used[j]; });
        if (!cands.length) break;
        var pick = cands[0];
        if (cands.length > 1 && prev >= 0) {
          var px = prev % w, py = (prev / w) | 0;
          var cx = cur % w, cy = (cur / w) | 0;
          var vx = cx - px, vy = cy - py;
          var bestDot = -1e9;
          cands.forEach(function (j) {
            var jx = j % w, jy = (j / w) | 0;
            var wx = jx - cx, wy = jy - cy;
            var dot = vx * wx + vy * wy;
            if (dot > bestDot) { bestDot = dot; pick = j; }
          });
        }
        used[pick] = 1;
        pts.push([pick % w, (pick / w) | 0]);
        prev = cur; cur = pick;
        if (degOf(cur) >= 3 && pts.length > 2) break;
      }
      return pts;
    }

    var i;
    for (i = 0; i < w * h; i++) if (skel[i] && degOf(i) === 1) lines.push(walk(i));
    for (i = 0; i < w * h; i++) if (skel[i] && !used[i]) lines.push(walk(i));
    return lines;
  }

  function rdp(points, eps) {
    if (points.length < 3) return points;
    var first = points[0], last = points[points.length - 1];
    var maxD = -1, idx = -1;
    for (var i = 1; i < points.length - 1; i++) {
      var d = distToSeg(points[i], first, last);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
      var left = rdp(points.slice(0, idx + 1), eps);
      var right = rdp(points.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  /* ---------------- 轮廓：闭合环 ---------------- */

  /* 沿前景掩膜的像素边界（crack boundary）追闭合环：每个字形一圈，天生完整。
   * 中线（骨架）在交叉处必须断开，文字会碎成一堆短段；轮廓没有这个问题。
   * 边按「前景在右手边」定向；一个点上出现多条边（对角相接）时优先右转，
   * 这样两个只在对角碰到的字形不会被缝成一个。 */
  function traceContours(mask, w, h) {
    var edges = [];
    var starts = new Map();
    function at(x, y) { return (x >= 0 && y >= 0 && x < w && y < h) ? mask[y * w + x] : 0; }
    function addEdge(x1, y1, x2, y2) {
      var i = edges.length;
      edges.push({ a: [x1, y1], b: [x2, y2], used: false });
      var k = x1 + ',' + y1;
      var list = starts.get(k);
      if (!list) { list = []; starts.set(k, list); }
      list.push(i);
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (!at(x, y - 1)) addEdge(x, y, x + 1, y);
        if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
        if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
        if (!at(x - 1, y)) addEdge(x, y + 1, x, y);
      }
    }

    var loops = [];
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].used) continue;
      var loop = [];
      var e = edges[i];
      for (var guard = 0; e && !e.used && guard <= edges.length; guard++) {
        e.used = true;
        loop.push(e.a);
        var dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
        var nextList = starts.get(e.b[0] + ',' + e.b[1]) || [];
        var pick = -1;
        if (nextList.length === 1) {
          if (!edges[nextList[0]].used) pick = nextList[0];
        } else {
          var best = -1e9;
          nextList.forEach(function (j) {
            if (edges[j].used) return;
            var ex = edges[j].b[0] - edges[j].a[0], ey = edges[j].b[1] - edges[j].a[1];
            /* 屏幕坐标 y 向下：cross > 0 是顺时针（右转） */
            var score = (dx * ey - dy * ex) * 2 + (dx * ex + dy * ey);
            if (score > best) { best = score; pick = j; }
          });
        }
        e = pick >= 0 ? edges[pick] : null;
      }
      if (loop.length >= 4) loops.push(loop);
    }
    return loops;
  }

  /* Chaikin 角切：每轮把每条边切成 1/4、3/4 两点，闭环不做端点补齐。
   * 用来消掉小图轮廓上的 1px 像素台阶。 */
  function chaikin(pts, iters) {
    var list = pts.slice();
    for (var k = 0; k < iters; k++) {
      var n = list.length;
      if (n < 3) return list;
      var out = [];
      for (var i = 0; i < n; i++) {
        var a = list[i], b = list[(i + 1) % n];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      list = out;
    }
    return list;
  }

  function rdpClosed(loop, eps) {
    if (loop.length < 3) return loop.slice();
    /* 闭环不能从同一个点起收：先找离起点最远的点，从它切成两段各自抽稀，
       否则起点附近的转角不会被判定为「偏离」。 */
    var far = 0, best = -1;
    for (var i = 1; i < loop.length; i++) {
      var d = Math.pow(loop[i][0] - loop[0][0], 2) + Math.pow(loop[i][1] - loop[0][1], 2);
      if (d > best) { best = d; far = i; }
    }
    var a = rdp(loop.slice(0, far + 1), eps);
    var b = rdp(loop.slice(far).concat([loop[0]]), eps);
    return a.concat(b.slice(1, b.length - 1));
  }

  /* ---- 三次贝塞尔拟合（不是插值） ----
   * 像素边界直接上 Catmull-Rom，控制点全落在台阶拐角上，画出来是一圈波浪。
   * 这里用最小二乘拟合：每段在容差内贴合点集，台阶会被平均成直线 / 弧，
   * 只有误差超限才二分。输出是真正的三次贝塞尔段（c1 / c2），落笔用 bezierCurveTo。 */
  function bezAt(p0, c1, c2, p3, t) {
    var mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
      a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
  }

  function lineSeg(p0, p3) {
    return [p0, [p0[0] + (p3[0] - p0[0]) / 3, p0[1] + (p3[1] - p0[1]) / 3],
      [p0[0] + (p3[0] - p0[0]) * 2 / 3, p0[1] + (p3[1] - p0[1]) * 2 / 3], p3];
  }

  function fitRun(pts, tol, out, depth) {
    var n = pts.length;
    if (n < 2) return;
    var p0 = pts[0], p3 = pts[n - 1];
    var chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    /* 闭环首尾是同一点，弦长为 0。直接出直线会得到一条退化曲线（整块消失），
     * 必须在中点切成两段再各自拟合。 */
    if (chord < 1e-6) {
      if (n > 3) {
        var mid = Math.floor((n - 1) / 2);
        fitRun(pts.slice(0, mid + 1), tol, out, depth + 1);
        fitRun(pts.slice(mid), tol, out, depth + 1);
      }
      return;
    }
    if (n === 2) { out.push(lineSeg(p0, p3)); return; }

    var u = new Array(n), i;
    u[0] = 0;
    for (i = 1; i < n; i++) u[i] = u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    var total = u[n - 1] || 1;
    for (i = 0; i < n; i++) u[i] /= total;

    var t1 = [pts[1][0] - p0[0], pts[1][1] - p0[1]];
    var t2 = [pts[n - 2][0] - p3[0], pts[n - 2][1] - p3[1]];
    var l1 = Math.hypot(t1[0], t1[1]), l2 = Math.hypot(t2[0], t2[1]);
    if (!l1 || !l2) { out.push(lineSeg(p0, p3)); return; }
    t1 = [t1[0] / l1, t1[1] / l1];
    t2 = [t2[0] / l2, t2[1] / l2];

    var c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    var dot12 = t1[0] * t2[0] + t1[1] * t2[1];
    for (i = 0; i < n; i++) {
      var t = u[i], mt = 1 - t;
      var b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      c00 += b1 * b1; c01 += b1 * b2 * dot12; c11 += b2 * b2;
      var bx = p0[0] * (b0 + b1) + p3[0] * (b2 + b3);
      var by = p0[1] * (b0 + b1) + p3[1] * (b2 + b3);
      var dx = pts[i][0] - bx, dy = pts[i][1] - by;
      x0 += b1 * (t1[0] * dx + t1[1] * dy);
      x1 += b2 * (t2[0] * dx + t2[1] * dy);
    }
    var det = c00 * c11 - c01 * c01;
    var a1 = det ? (x0 * c11 - x1 * c01) / det : chord / 3;
    var a2 = det ? (c00 * x1 - c01 * x0) / det : chord / 3;
    /* 解出负手柄 = 这段本来就不该是一条单弧（尖角 / S 弯），退回直线再靠二分 */
    if (!isFinite(a1) || !isFinite(a2) || a1 < 0 || a2 < 0) { a1 = chord / 3; a2 = chord / 3; }
    var c1 = [p0[0] + t1[0] * a1, p0[1] + t1[1] * a1];
    var c2 = [p3[0] + t2[0] * a2, p3[1] + t2[1] * a2];

    var worst = 0, at = -1;
    for (i = 0; i < n; i++) {
      var q = bezAt(p0, c1, c2, p3, u[i]);
      var dd = (q[0] - pts[i][0]) * (q[0] - pts[i][0]) + (q[1] - pts[i][1]) * (q[1] - pts[i][1]);
      if (dd > worst) { worst = dd; at = i; }
    }
    if (worst <= tol * tol || depth >= 14 || at <= 0 || at >= n - 1) {
      out.push([p0, c1, c2, p3]);
      return;
    }
    fitRun(pts.slice(0, at + 1), tol, out, depth + 1);
    fitRun(pts.slice(at), tol, out, depth + 1);
  }

  /* 闭环 → 贝塞尔段：把首点再补一次当作收尾，接缝处按同一方向拟合，不会多一个折角。 */
  function bezTurn(a, b, c) {
    var v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
    var l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (!l1 || !l2) return 0;
    return Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * 180 / Math.PI;
  }

  function fitBezLoop(points, tol) {
    var pts = [];
    for (var i = 0; i < points.length; i++) {
      var q = points[i], last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q);
    }
    if (pts.length < 3) return [];
    /* 闭环必然在某处接缝。把起点挪到拐角最大的点，接缝落在角上，
     * 就不会在平滑段中间多出一个折痕。 */
    var n = pts.length, bi = 0, ba = -1;
    for (i = 0; i < n; i++) {
      var ang = bezTurn(pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
      if (ang > ba) { ba = ang; bi = i; }
    }
    if (bi > 0) pts = pts.slice(bi).concat(pts.slice(0, bi));
    var out = [];
    fitRun(pts.concat([[pts[0][0], pts[0][1]]]), Math.max(0.3, tol), out, 0);
    return out;
  }

  function bezPath(g, segs) {
    if (!segs || !segs.length) return false;
    g.moveTo(segs[0][0][0], segs[0][0][1]);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      g.bezierCurveTo(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
    }
    g.closePath();
    return true;
  }

  /* 前景掩膜的边界像素（至少一个 4 邻域在掩膜外）。轮廓模式的回读参照系。 */
  function boundaryMask(mask, w, h) {
    var b = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (!mask[k]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            !mask[k - 1] || !mask[k + 1] || !mask[k - w] || !mask[k + w]) b[k] = 1;
      }
    }
    return b;
  }

  /* 一圈轮廓的颜色 = 这圈包围盒里掩膜像素的均色（内孔环落在笔画环上，取到的仍是笔画色） */
  function loopColor(loop, mask, data, w, h) {
    var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    loop.forEach(function (p) {
      if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
      if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
    });
    var r = 0, g = 0, b = 0, n = 0;
    for (var y = Math.max(0, mny); y < Math.min(h, mxy); y++) {
      for (var x = Math.max(0, mnx); x < Math.min(w, mxx); x++) {
        var k = y * w + x;
        if (!mask[k]) continue;
        r += data[k * 4]; g += data[k * 4 + 1]; b += data[k * 4 + 2]; n++;
      }
    }
    if (!n) return '#2b3440';
    return hexOf([r / n, g / n, b / n]);
  }

  function contourStrokes(mask, w, h, inv, data, o) {
    var loops = traceContours(mask, w, h);
    var out = [];
    loops.forEach(function (loop) {
      if (loop.length < 4) return;
      /* 小图的原生边界是 1px 台阶，直接画在放大视图里就是一根根方角黑条。
       * Chaikin 两轮把台阶磨成连续曲线，再抽稀，形状偏差 <0.5px。 */
      var pts = rdpClosed(chaikin(loop, 2), o.simplify);
      if (pts.length < 3) return;
      var len = 0;
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length];
        len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      if (len * inv < o.minLen) return;
      var path = pts.map(function (p) { return [p[0] * inv, p[1] * inv]; });
      out.push({
        path: path,
        width: Math.max(0.8, inv),
        color: loopColor(loop, mask, data, w, h),
        length: len * inv,
        anchors: path.length,
        closed: true,
        bbox: bboxOfPath(path)
      });
    });
    out.sort(function (a, b) { return b.length - a.length; });
    return out;
  }

  /* ---------------- 色块：多色区域逐块取轮廓 ---------------- */

  /* 多色图不能按「暗不暗」取线：深色底会把整块画布判成前景，红色 / 黄色这类亮部件
   * 又不在暗掩膜里，最后只剩黑白反相。这里直接用平面分件的结果，
   * 每个色块取自己的闭合环，填色用区域原色。 */

  /* 背景 = 贴着画布边、面积够大、颜色与主背景接近的块。背景不填充，
   * 否则四周一圈会被涂成实心，图看起来像被框住。 */
  function bgLabels(seg, st, w, h) {
    var edge = new Set();
    function push(x, y) { var L = seg.labels[y * w + x]; if (L) edge.add(L); }
    for (var x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (var y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

    var bg = new Set(), best = 0;
    edge.forEach(function (L) { if (st.area[L] > best) best = st.area[L]; });
    if (best < w * h * 0.12) return bg;   /* 边缘没有占主导的色块：整幅都算图形 */
    var ref = null;
    edge.forEach(function (L) { if (st.area[L] === best) ref = L; });
    var rc = [st.sr[ref] / best, st.sg[ref] / best, st.sb[ref] / best];
    edge.forEach(function (L) {
      var a = st.area[L];
      if (!a) return;
      var c = [st.sr[L] / a, st.sg[L] / a, st.sb[L] / a];
      var dd = Math.pow(c[0] - rc[0], 2) + Math.pow(c[1] - rc[1], 2) + Math.pow(c[2] - rc[2], 2);
      if (dd <= 1600) bg.add(L);   /* 与主背景色差 40 级以内算同一片背景 */
    });
    return bg;
  }

  function lumOfLabel(st, L) {
    var n = Math.max(1, st.area[L]);
    return (st.sr[L] + st.sg[L] + st.sb[L]) / 3 / n;
  }

  function meanOfLabel(st, L) {
    var n = Math.max(1, st.area[L]);
    return [st.sr[L] / n, st.sg[L] / n, st.sb[L] / n];
  }

  function dist2(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  /* 小块是不是「真实细节」：瞳孔、眼睛高光都只有几十像素，67px 图标上就是 1~2 个像素。
   * 判据三条：不贴画布边、不与背景相邻（被包住）、亮度是局部极值（比所有邻居都暗或都亮）。
   * 抗锯齿产生的过渡色亮度夹在两个邻居之间，第三条会把它挡掉——这是细节与噪点的分界。 */
  function isDetail(seg, st, bg, L, w, h) {
    if (st.area[L] < 16) return false;
    var x0 = st.minX[L], y0 = st.minY[L], x1 = st.maxX[L], y1 = st.maxY[L];
    if (x0 <= 0 || y0 <= 0 || x1 >= w - 1 || y1 >= h - 1) return false;
    var mine = lumOfLabel(st, L);
    var lo = Infinity, hi = -1;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (seg.labels[y * w + x] !== L) continue;
        var nb = [seg.labels[y * w + x - 1], seg.labels[y * w + x + 1],
          seg.labels[(y - 1) * w + x], seg.labels[(y + 1) * w + x]];
        for (var i = 0; i < 4; i++) {
          var N = nb[i];
          if (!N || N === L) continue;
          if (bg.has(N)) return false;
          var v = lumOfLabel(st, N);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (lo === Infinity) return false;
    return mine <= lo - 25 || mine >= hi + 25;
  }

  /* 抗锯齿碎块归并：小于「块」下限的色块分两种处理。
   *   · 过渡色 → 并进颜色最近的邻居（否则放大后的图标会被切成上百个 6×6 灰块，
   *     眼白、围巾这些部位全被切碎，画出来是碎片）；
   *   · 局部极值 → 原样保留（瞳孔被并进眼白就没有瞳孔了）。
   * Segmenter.cleanupSmall 不做这个区分，一刀切 260 会把瞳孔一起并掉。 */
  function mergeNoise(seg, w, h) {
    var minArea = Math.max(24, Math.round(w * h * 0.001));
    for (var round = 0; round < 6; round++) {
      var st = Segmenter.labelStats(seg);
      var bg = bgLabels(seg, st, w, h);
      var labels = seg.labels;
      var small = [];
      for (var L = 1; L <= st.maxL; L++) {
        if (!st.area[L] || st.area[L] >= minArea || bg.has(L)) continue;
        if (isDetail(seg, st, bg, L, w, h)) continue;
        small.push(L);
      }
      if (!small.length) break;

      var want = new Set(small);
      var adj = new Map();
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var a = labels[y * w + x];
          if (!a || !want.has(a)) continue;
          var nb = [];
          if (x > 0) nb.push(labels[y * w + x - 1]);
          if (x < w - 1) nb.push(labels[y * w + x + 1]);
          if (y > 0) nb.push(labels[(y - 1) * w + x]);
          if (y < h - 1) nb.push(labels[(y + 1) * w + x]);
          for (var j = 0; j < nb.length; j++) {
            var b = nb[j];
            if (!b || b === a) continue;
            var m = adj.get(a);
            if (!m) { m = new Map(); adj.set(a, m); }
            m.set(b, (m.get(b) || 0) + 1);
          }
        }
      }

      var changed = 0;
      small.forEach(function (s) {
        var m = adj.get(s);
        if (!m || !m.size) return;
        var own = meanOfLabel(st, s), pick = 0, bestD = Infinity;
        m.forEach(function (cnt, c) {
          var dd = dist2(own, meanOfLabel(st, c));
          if (dd < bestD) { bestD = dd; pick = c; }
        });
        if (!pick) return;
        for (var i = 0; i < labels.length; i++) if (labels[i] === s) labels[i] = pick;
        changed++;
      });
      if (!changed) break;
    }
    return seg;
  }

  /* 同色孤岛归并：像素图里被黑线隔开的同色小岛其实是同一部位（围巾在下巴处露出的
   * 一小块红、被喙挡住的巾角）。只按面积/亮度判噪点会把它们留成独立部位，
   * 模型只能硬起名字——「舌尖红点」就是这么来的。
   * 条件：面积小、与某个至少大 4 倍的块颜色接近、两块包围盒相距 ≤4px；背景不参与。 */
  function mergeIslands(seg, w, h) {
    var st = Segmenter.labelStats(seg);
    var bg = bgLabels(seg, st, w, h);
    var minArea = Math.max(24, Math.round(w * h * 0.001));
    var lim = minArea * 2.5;
    var list = [];
    for (var L = 1; L <= st.maxL; L++) if (st.area[L] && !bg.has(L)) list.push(L);
    var labels = seg.labels, changed = 0;

    list.forEach(function (s) {
      if (st.area[s] >= lim) return;
      var own = meanOfLabel(st, s);
      var sx0 = st.minX[s], sy0 = st.minY[s], sx1 = st.maxX[s], sy1 = st.maxY[s];
      var pick = 0, bestA = 0;
      list.forEach(function (t) {
        if (t === s || st.area[t] < st.area[s] * 4) return;
        if (dist2(own, meanOfLabel(st, t)) > 900) return;
        var gx = Math.max(0, Math.max(sx0 - st.maxX[t], st.minX[t] - sx1));
        var gy = Math.max(0, Math.max(sy0 - st.maxY[t], st.minY[t] - sy1));
        if (Math.hypot(gx, gy) > 4) return;
        if (st.area[t] > bestA) { bestA = st.area[t]; pick = t; }
      });
      if (!pick) return;
      for (var i = 0; i < labels.length; i++) if (labels[i] === s) labels[i] = pick;
      changed++;
    });
    return changed;
  }

  function colorSeg(data, w, h, o) {
    var seg = Segmenter.segment(data, {
      mode: 'light', background: o.background, tolerance: o.tolerance,
      barrier: 'edge', lineThreshold: 0
    });
    Segmenter.mergeAdjacent(seg, { mergeTol: o.mergeTol != null ? o.mergeTol : 22 });
    mergeNoise(seg, w, h);
    mergeIslands(seg, w, h);
    /* 墙像素（描边 / 抗锯齿）分给邻居，否则块与块之间留 1~3px 空缝，填出来是碎边 */
    Segmenter.absorbWalls(seg);
    Segmenter.compact(seg);
    var st = Segmenter.labelStats(seg);
    return { seg: seg, st: st, bg: bgLabels(seg, st, w, h) };
  }

  function shoelace(path) {
    var a = 0;
    for (var i = 0, j = path.length - 1; i < path.length; j = i++) {
      a += path[j][0] * path[i][1] - path[i][0] * path[j][1];
    }
    return a / 2;
  }

  /* 单个色块的闭合环：按块包围盒裁出来再描，整图逐块扫会慢一个量级。
   * 面积最大的环是外轮廓，其余是孔（眼睛、白肚这类被别的块盖住的洞）。
   * 抽稀容差按「块」给：按整图尺寸一刀切会把 20px 的眼睛也砍掉 3px，小部位直接被抹成斑；
   * 上限仍由整图尺寸兜底，防止大块把台阶点全留下。 */
  function regionLoops(seg, st, L, simplify) {
    var w = seg.w, h = seg.h, labels = seg.labels;
    var x0 = st.minX[L], y0 = st.minY[L], x1 = st.maxX[L], y1 = st.maxY[L];
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    /* 容差跟着「块」的大小走：台阶宽度是固定的（这张图放大 6 倍 = 6px），
     * 大块必须给到 5px 以上才消得掉，小块给大了就抹成一块斑。 */
    var eps = clamp(Math.max(Number(simplify) || 0, Math.min(bw, bh) * 0.06), 0.4, 16);
    var mask = new Uint8Array(bw * bh);
    var n = 0;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (labels[y * w + x] !== L) continue;
        mask[(y - y0) * bw + (x - x0)] = 1; n++;
      }
    }
    if (!n) return [];
    var loops = traceContours(mask, bw, bh);
    return loops.map(function (lp) {
      var full = lp.map(function (q) { return [q[0] + x0, q[1] + y0]; });
      return rdpClosed(chaikin(full, 2), eps);
    }).filter(function (lp) { return lp.length >= 3; });
  }

  function colorExtract(cd, o) {
    var w = cd.w, h = cd.h, inv = 1 / cd.scale;
    var got = colorSeg(cd.data, w, h, o);
    var st = got.st, bg = got.bg;
    /* 小碎块（抗锯齿边、压缩噪点）不进入参考线：26 块里有一半是这种，
     * 逐块让模型重绘只会把预算花在看不见的地方。局部极值的小块是例外（瞳孔、眼睛高光）。 */
    var minArea = Math.max(24, Math.round(w * h * 0.001));
    var out = [];

    for (var L = 1; L <= st.maxL; L++) {
      if (!st.area[L] || bg.has(L)) continue;
      if (st.area[L] < minArea && !isDetail(got.seg, st, bg, L, w, h)) continue;
      var loops = regionLoops(got.seg, st, L, o.simplify);
      if (!loops.length) continue;
      /* 一个色块可能被拆成多个不连通的片，最大的那圈当外轮廓 */
      var oi = 0, oa = 0;
      loops.forEach(function (lp, i) {
        var a = Math.abs(shoelace(lp));
        if (a > oa) { oa = a; oi = i; }
      });
      var outer = loops[oi].map(function (q) { return [q[0] * inv, q[1] * inv]; });
      var holes = loops.filter(function (_, i) { return i !== oi; })
        .map(function (lp) { return lp.map(function (q) { return [q[0] * inv, q[1] * inv]; }); });
      var a2 = Math.max(1, st.area[L]);
      /* 拟合容差跟着块走：大块的台阶高，容差要盖过台阶才能被平均成直线；
       * 小块（眼睛、脚掌）容差压在 1~2px，否则形状被抹圆。 */
      var tol = clamp(Math.min(st.maxX[L] - st.minX[L], st.maxY[L] - st.minY[L]) * 0.05, 0.5, 10) * inv;
      out.push({
        path: outer,
        holes: holes,
        bez: fitBezLoop(outer, tol),
        holeBez: holes.map(function (hp) { return fitBezLoop(hp, tol); }),
        tol: tol,
        closed: true,
        region: true,
        area: a2 * inv * inv,
        color: hexOf([st.sr[L] / a2, st.sg[L] / a2, st.sb[L] / a2]),
        width: Math.max(0.8, inv),
        length: pathLength(outer),
        anchors: outer.length,
        bbox: bboxOfPath(outer)
      });
    }
    out.sort(function (a, b) { return b.area - a.area; });
    return { strokes: out, mode: 'color', auto: null, cw: w, ch: h, inv: inv };
  }

  /* 色块模式的回读参照：所有「非背景」像素的并集。
   * 与填色轮廓同口径——问的是「这块画面有没有被覆盖」，不是「边界描得准不准」。 */
  function colorRefMask(data, w, h, o) {
    var got = colorSeg(data, w, h, o);
    var m = new Uint8Array(w * h);
    for (var i = 0; i < m.length; i++) {
      var L = got.seg.labels[i];
      if (L && !got.bg.has(L)) m[i] = 1;
    }
    return m;
  }

  /* ---------------- 提取 ---------------- */

  /* 判断前景是「笔画网络」还是「实心区域」，给「自动」形态用。
   * 笔画网络：骨架几乎铺满外接框（字、线条画）；实心区域：骨架缩成一根脊，线宽接近短边。 */
  function skelStats(mask, w, h, dt, lines) {
    var x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    var bw = Math.max(1, x1 - x0 + 1), bh = Math.max(1, y1 - y0 + 1);
    var perim = 2 * (bw + bh);
    var skelLen = 0, ws = [];
    lines.forEach(function (line) {
      for (var i = 1; i < line.length; i++) {
        skelLen += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      }
      line.forEach(function (p) { ws.push(dt[p[1] * w + p[0]] * 2); });
    });
    var mw = median(ws) || 0;
    var short = Math.min(bw, bh);
    var ratio = perim ? skelLen / perim : 0;
    /* 细线（≤2.5px）才是线稿：中线 + 线宽能还原；再粗就是实心块，
     * 骨架只是它的中轴，描出来是一根圆头面条，必须走闭合轮廓（填色）。 */
    var pick = (ratio >= 0.45 && mw <= 2.5) ? 'center' : 'contour';
    return {
      ratio: round2(ratio), w: round2(mw), short: short,
      skel: Math.round(skelLen), perim: perim, area: area, pick: pick
    };
  }

  function extractRect(rect, over) {
    var o = {};
    Object.keys(S.opt).forEach(function (k) { o[k] = S.opt[k]; });
    Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });

    var cd = cropData(rect, MAX_EXTRACT);
    /* 色块模式不经过「暗线 / 边缘」掩膜：多色图按颜色分块才有意义 */
    if (o.src === 'color') return colorExtract(cd, o);

    var w = cd.w, h = cd.h, inv = 1 / cd.scale;
    var built = buildLineMask(cd.data, w, h, o.src, o.threshold);
    var mask = built.mask;
    var shape = o.shape;
    var dt = null, lines = null, auto = null;

    /* 「自动」= 判断这块区域是「笔画网络」还是「实心区域」。
     * 实心字（粗体文字）用轮廓只能描出一圈外沿，笔画全糊成一条带子；
     * 中线才能把每一笔拆开。反过来，实心图标用中线会被抽成一根脊。
     * 判据：骨架总长 / 外接框周长（笔画网络接近 1）与 中位线宽 / 短边（实心区域很大）。 */
    if (shape !== 'contour') {
      dt = distTransform(mask, w, h);
      var skel = thin(mask, w, h);
      lines = traceSkeleton(skel, w, h);
      auto = skelStats(mask, w, h, dt, lines);
      if (shape === 'auto') shape = auto.pick;
    }

    if (shape === 'contour') {
      return { strokes: contourStrokes(mask, w, h, inv, cd.data.data, o), mode: 'contour', auto: auto, cw: w, ch: h, inv: inv };
    }

    var out = [];
    var src = cd.data.data;
    lines.forEach(function (line) {
      if (line.length < 2) return;
      var pts = rdp(line, o.simplify);
      if (pts.length < 2) return;
      var len = 0;
      for (var i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len * inv < o.minLen) return;

      var ws = [], rgb = [0, 0, 0], n = 0;
      line.forEach(function (p) {
        ws.push(dt[p[1] * w + p[0]] * 2);
        var q = (p[1] * w + p[0]) * 4;
        rgb[0] += src[q]; rgb[1] += src[q + 1]; rgb[2] += src[q + 2]; n++;
      });
      var width = clamp(median(ws) || 1, 0.8, 16);
      var color = hexOf(rgb.map(function (v) { return v / Math.max(1, n); }));

      var path = pts.map(function (p) { return [p[0] * inv, p[1] * inv]; });
      out.push({
        path: path,
        width: width * inv,
        color: color,
        length: len * inv,
        anchors: path.length,
        bbox: bboxOfPath(path)
      });
    });
    out.sort(function (a, b) { return b.length - a.length; });
    return { strokes: out, mode: 'center', auto: auto, cw: w, ch: h, inv: inv };
  }

  function stableKey(p, used) {
    var bb = p.bbox;
    var base = 'l' + Math.round(p.length) + '-' + Math.round((bb[0] + bb[2]) / 2) + '-' +
      Math.round((bb[1] + bb[3]) / 2) + '-' + hueBucket(p.color);
    var key = base, i = 2;
    while (used[key]) { key = base + '-' + (i++); }
    used[key] = 1;
    return key;
  }

  /* 提取层的默认名。真正的语义（围巾 / 眼睛 / 白肚）只有模型能给——
   * 走 vl_group_parts / vl_name_parts 才会写进 lexicon。这里只把测出来的东西翻成
   * 人能读的字：颜色 + 位置（+ 内孔数），来源标记仍是 heuristic，不冒充语义。 */
  function defaultName(p, n) {
    if (!p.region) return '线段' + n;
    var bb = p.bbox;
    var r = S.region || { x: 0, y: 0, w: S.w || 1, h: S.h || 1 };
    var t = colorTone(p.color) + '·' + placeText(
      (((bb[0] + bb[2]) / 2) - r.x) / Math.max(1, r.w),
      (((bb[1] + bb[3]) / 2) - r.y) / Math.max(1, r.h));
    var hn = (p.holes || []).length;
    if (hn) t += '·' + hn + '孔';
    return t;
  }

  function finalizeStrokes(raw, rect) {
    var used = {};
    return raw.map(function (p) {
      var item = Object.assign({}, p);
      item.key = stableKey(item, used);
      var lex = S.lexicon[item.key];
      item.name = (lex && lex.name) || defaultName(item, Object.keys(used).length);
      item.en = (lex && lex.en) || '';
      item.conf = (lex && lex.conf) || 0.3;
      item.source = (lex && lex.source) || 'heuristic';
      /* 色块自带像素面积（决定填充顺序），不要被长度覆盖 */
      item.area = item.area || item.length;
      item.cx = ((item.bbox[0] + item.bbox[2]) / 2) / rect.w;
      item.cy = ((item.bbox[1] + item.bbox[3]) / 2) / rect.h;
      return item;
    });
  }

  function extractStrokes() {
    if (!S.img) return 0;
    if (!S.region) S.region = { x: 0, y: 0, w: S.w, h: S.h };

    var got = extractRect(S.region, null);
    S.lastMode = got.mode;
    S.autoStats = got.auto || null;
    S.strokes = finalizeStrokes(got.strokes, S.region);
    /* 提取只产生「参考线」，不落笔。实线必须由模型调 vl_draw_parts 才有，
       否则画布上是程序自己画满的成品，监督就失去意义。 */
    S.ops = new Map();
    /* 分组/忽略是上一张图的语义，图变了就作废 */
    S.groups = []; S.drop = {}; S.layers = []; S.hidden = {};
    S.metrics = null;   /* 几何变了，上一轮的指标作废；但「最好一轮」的回滚点要保留 */
    renderParts(); drawScene(); updateStat();
    if (!S.strokes.length) {
      note('没提到线段：把「阈值」调低（边缘模式）或调高（暗线模式），或者换个大一点的框选区域。', true);
    } else {
      note('提到 ' + S.strokes.length + ' 条参考线（淡虚线）。点「监督重绘」，让模型自己决定画哪些。');
    }
    return S.strokes.length;
  }

  /* ---------------- 命名 ---------------- */

  function partName(p) { return (p && p.name) || (p && p.key) || ''; }

  function setLex(key, name, en, source, conf) {
    var p = S.strokes.filter(function (x) { return x.key === key; })[0];
    if (p) { p.name = name; p.en = en || ''; p.source = source; p.conf = conf == null ? 1 : conf; }
    S.lexicon[key] = { name: name, en: en || '', source: source, conf: conf == null ? 1 : conf };
  }

  async function nameUnknown(keys) {
    var list = (keys && keys.length) ? keys.slice() : S.strokes.map(function (p) { return p.key; });
    list = list.filter(function (k) {
      var lex = S.lexicon[k];
      return !lex || lex.source !== 'user';
    });
    if (!list.length) return { named: 0, source: 'none' };

    function fallback(k) {
      var p = S.strokes.filter(function (x) { return x.key === k; })[0];
      return p ? ('线段') : '线段';
    }
    if (S.stub) {
      list.forEach(function (k) { setLex(k, fallback(k), '', 'heuristic', 0.3); });
      return { named: list.length, source: 'heuristic' };
    }

    var conn = null;
    try { conn = (typeof llmConn === 'function') ? llmConn() : null; } catch (e) { conn = null; }
    if (!conn || !conn.base) {
      list.forEach(function (k) { if (!S.lexicon[k]) setLex(k, fallback(k), '', 'heuristic', 0.3); });
      return { named: list.length, source: 'heuristic', reason: '模型未配置' };
    }

    var payload = list.map(function (k) {
      var p = S.strokes.filter(function (x) { return x.key === k; })[0];
      if (!p) return null;
      return {
        key: p.key, length: Math.round(p.length), width: round2(p.width), color: p.color,
        bbox: p.bbox.map(function (v) { return Math.round(v); }),
        cx: round2(p.cx), cy: round2(p.cy)
      };
    }).filter(Boolean);

    var sys = [
      '你是线稿分段命名器。输入是一组线段的中线几何摘要（JSON 数组），外加框选区域的位图。',
      '先看图确认画面主体（例如「企鹅」「字 A」「线稿人像」），再按几何位置判断每条线是主体的哪个部位。',
      '只输出一个 JSON 对象：{"<key>":"中文名称"}，不要解释、不要代码块。',
      '名称必须带主体：例如「企鹅·身体外轮廓」「企鹅·左翅」「企鹅·嘴」。',
      '不要用「左侧小环」「主体外轮廓（内层闭环）」这类纯几何叫法——那样的名字说明没认出画的是什么。'
    ].join('\n');
    var content = [{ type: 'text', text: JSON.stringify(payload) }];
    var shot = regionImageURL(640);
    if (shot) content.push({ type: 'image_url', image_url: { url: shot } });
    var text = await llmStreamRequest(sys, [{ role: 'user', content: content }], null, { conn: conn, app: 'visionlab' });
    var map = {};
    try {
      var m = /{[\s\S]*}/.exec(String(text || ''));
      map = m ? JSON.parse(m[0]) : {};
    } catch (e) { map = {}; }
    var named = 0;
    list.forEach(function (k) {
      var name = map[k];
      if (typeof name === 'string' && name.trim()) { setLex(k, name.trim(), '', 'llm', 0.8); named++; }
      else if (!S.lexicon[k]) setLex(k, fallback(k), '', 'heuristic', 0.3);
    });
    renderParts(); drawScene();
    return { named: named, total: list.length, source: 'llm' };
  }

  /* ---------------- 回读：Chamfer + 覆盖率 ---------------- */

  function rasterizeDrawn(w, h, k) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.scale(k, k);
    paintOps(g, sortedOps());
    return { canvas: c, data: g.getImageData(0, 0, w, h).data };
  }

  function renderCheck() {
    if (!S.img || !S.region) return { error: '没有可校验的区域' };
    if (!S.strokes.length) return { error: '还没有提取线段' };

    var rect = S.region;
    var cd = cropData(rect, MAX_CHECK);
    var W = cd.w, H = cd.h;
    var k = W / rect.w;

    /* 色块模式的参照是「非背景像素的并集」，不是暗掩膜 */
    var isColor = S.lastMode === 'color';
    var built = isColor ? null : buildLineMask(cd.data, W, H, S.opt.src, S.opt.threshold);
    var srcMask = isColor ? colorRefMask(cd.data, W, H, S.opt) : built.mask;
    /* auto 解析后的实际形态才是口径：S.opt.shape 可能还是 auto */
    var isContour = S.lastMode === 'contour';
    /* 填色轮廓画的是整块区域，参照用前景掩膜；只有空心描边才用掩膜边界 */
    var filled = isColor || (isContour && S.opt.fill);
    if (isContour && !filled) srcMask = boundaryMask(srcMask, W, H);

    var drawn = rasterizeDrawn(W, H, k);
    var dd = drawn.data;
    var dMask = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) dMask[i] = dd[i * 4 + 3] > 12 ? 1 : 0;

    /* 距离变换算的是「到最近的 0 像素」。要问的是「离最近的线有多远」，
       所以两边都要先取反，否则漏画/多画的方向会反。 */
    var invSrc = new Uint8Array(W * H), invDraw = new Uint8Array(W * H);
    for (var j = 0; j < W * H; j++) {
      invSrc[j] = srcMask[j] ? 0 : 1;
      invDraw[j] = dMask[j] ? 0 : 1;
    }
    var dtD = distTransform(invDraw, W, H);  // 原图像素 → 最近的绘制像素：漏画距离
    var dtS = distTransform(invSrc, W, H);   // 绘制像素 → 最近的原图像素：多画距离

    var near = [], far = [];
    var srcPix = 0, hit = 0;
    for (var p = 0; p < W * H; p++) {
      if (srcMask[p]) {
        srcPix++;
        var d1 = dtD[p];
        near.push(d1);
        if (d1 <= 1.5) hit++;
      }
      if (dMask[p]) far.push(dtS[p]);
    }
    var chamfer = near.length ? near.reduce(function (a, b) { return a + b; }, 0) / near.length : 0;
    var recall = srcPix ? hit / srcPix : 0;
    var precSum = 0;
    for (var q = 0; q < far.length; q++) if (far[q] <= 1.5) precSum++;
    var precision = far.length ? precSum / far.length : 0;
    var f = (precision + recall) ? (2 * precision * recall / (precision + recall)) : 0;

    /* 逐条归因：模型自己提过「只有全局 Chamfer，看不出 4 段里哪段拖后腿，只能盲改」。
     * miss = 这条线自己的点到参照掩膜的平均距离；off = 离参照线超过容差的点占比。 */
    var per = [];
    S.strokes.forEach(function (sp) {
      if (!S.ops.has(sp.key)) return;
      var sum = 0, mx = 0, off = 0, cnt = 0;
      var step = Math.max(1, Math.floor(sp.path.length / 40));
      for (var t = 0; t < sp.path.length; t += step) {
        var xc = Math.round((sp.path[t][0] - rect.x) * k);
        var yc = Math.round((sp.path[t][1] - rect.y) * k);
        if (xc < 0 || yc < 0 || xc >= W || yc >= H) continue;
        var dv = dtD[yc * W + xc];
        sum += dv; if (dv > mx) mx = dv; if (dv > 1.5) off++;
        cnt++;
      }
      if (!cnt) return;
      per.push({
        key: sp.key, name: partName(sp), miss: +(sum / cnt).toFixed(2),
        max: +mx.toFixed(1), off: +(off / cnt).toFixed(2), len: Math.round(sp.len)
      });
    });
    per.sort(function (a, b) { return b.miss - a.miss; });
    var worst = per.filter(function (r) { return r.miss > 1.2 || r.off > 0.25; }).slice(0, 6);
    var undrawn = S.strokes.filter(function (sp) { return !S.ops.has(sp.key); })
      .sort(function (a, b) { return b.len - a.len; })
      .slice(0, 6)
      .map(function (sp) { return { key: sp.key, name: partName(sp), len: Math.round(sp.len) }; });

    var m = {
      chamfer: +chamfer.toFixed(3),
      chamferP95: +percentile(near, 0.95).toFixed(2),
      recall: +recall.toFixed(4),
      precision: +precision.toFixed(4),
      f: +f.toFixed(4),
      segments: S.strokes.length,
      drawn: sortedOps().length,
      total: S.strokes.length,
      medianWidth: +median(S.strokes.map(function (s) { return s.width; })).toFixed(2),
      mode: isColor ? 'color' : (isContour ? 'contour' : built.mode),
      shape: isColor ? 'color' : (isContour ? 'contour' : 'center'),
      filled: !!filled,
      px: W + '×' + H,
      worst: worst,
      undrawn: undrawn,
      at: new Date().toISOString()
    };
    /* 最好的一轮：模型上一轮把 5.108 改到 7.306 才收口，中间没有回滚点 */
    if (m.drawn > 0 && (!S.best || m.chamfer < S.best.m.chamfer)) {
      S.best = { round: S.round, m: m, snap: snapRun() };
    }
    m.bestRound = S.best ? S.best.round : null;
    m.bestChamfer = S.best ? S.best.m.chamfer : null;
    /* 这一刻比最好那轮更差、且不是同一轮：模型据此收口或回滚（它自己在复盘里要过这个信号） */
    m.noProgress = !!(S.best && S.round > S.best.round && m.chamfer > S.best.m.chamfer + 0.01);
    S.metrics = m;
    showMetrics(m);
    return m;
  }

  /* 回滚点：操作项 + 整份线段几何。只存操作项不够：
   * 模型一旦 force 重提取，key 全换了，只还原 ops 会一条都画不出来。 */
  function snapRun() {
    var ops = [];
    S.ops.forEach(function (op, key) { ops.push([key, JSON.parse(JSON.stringify(op))]); });
    return { ops: ops, strokes: JSON.parse(JSON.stringify(S.strokes)) };
  }

  function restoreBest() {
    if (!S.best) return { error: '还没有可回滚的一轮（需要先校验过一次）' };
    var snap = S.best.snap;
    if (snap.strokes) S.strokes = JSON.parse(JSON.stringify(snap.strokes));
    S.ops = new Map();
    snap.ops.forEach(function (e) { S.ops.set(e[0], e[1]); });
    drawScene(); renderParts(); updateStat();
    var m = renderCheck();
    return { restored: true, round: S.best.round, chamfer: m.chamfer, recall: m.recall, precision: m.precision };
  }

  /* ---------------- 工具 ---------------- */

  function regionInfo() {
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    return [r.x, r.y, r.w, r.h].map(function (v) { return Math.round(v); });
  }

  /* 色块的颜色与位置必须能被模型直接读懂：只给十六进制和 bbox 数字，
   * 模型会把肚子里两条浅色竖条命名成「眼睛」，再把真的白眼涂成瞳孔色。
   * tone / where / holes 都是测量值，不替模型下结论。 */
  function colorTone(hex) {
    var c = rgbOf(hex), l = lum(c[0], c[1], c[2]);
    var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    if (mx - mn < 26) return l > 225 ? '白' : (l > 170 ? '浅灰' : (l > 90 ? '灰' : (l > 40 ? '深灰' : '黑')));
    return hueBucket(hex) < 1 ? '红' : (hueBucket(hex) < 2 ? '橙' : (hueBucket(hex) < 3 ? '黄' :
      (hueBucket(hex) < 5 ? '绿' : (hueBucket(hex) < 7 ? '青' : (hueBucket(hex) < 9 ? '蓝' :
        (hueBucket(hex) < 10 ? '紫' : '粉'))))));
  }
  function placeText(nx, ny) {
    var v = ny < 0.34 ? '上' : (ny < 0.67 ? '中' : '下');
    var h = nx < 0.34 ? '左' : (nx < 0.67 ? '中' : '右');
    return v + h;
  }

  function strokeBrief(p) {
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var bb = p.bbox;
    var b = {
      key: p.key, name: partName(p),
      len: Math.round(p.length),
      w: round2(p.width),
      color: p.color,
      bbox: bb.map(function (v) { return Math.round(v); }),
      anchors: p.anchors,
      closed: !!p.closed,
      region: !!p.region,
      conf: round2(p.conf || 0),
      src: p.source
    };
    if (p.region) {
      b.tone = colorTone(p.color);
      b.where = placeText(((bb[0] + bb[2]) / 2 - r.x) / Math.max(1, r.w),
        ((bb[1] + bb[3]) / 2 - r.y) / Math.max(1, r.h));
      b.holes = (p.holes || []).length;
      /* 像素面积：判断「这是独立部位还是描边残条」用面积 + 长宽比，比只看周长可靠 */
      b.area = Math.round(p.area || 0);
    }
    return b;
  }

  /* 沿折线按弧长均匀取 n 个点。给模型看形状用——只有长度和包围盒看不出曲线怎么弯。 */
  function samplePath(path, closed, n) {
    if (!path || path.length < 2) return (path || []).slice();
    var pts = closed ? path.concat([path[0]]) : path.slice();
    var seg = [], total = 0;
    for (var i = 1; i < pts.length; i++) {
      var d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d); total += d;
    }
    if (!total) return [pts[0]];
    var out = [], k = 0, acc = 0, steps = closed ? n : n - 1;
    for (var j = 0; j < n; j++) {
      var target = total * j / Math.max(1, steps);
      while (k < seg.length - 1 && acc + seg[k] < target) { acc += seg[k]; k++; }
      var t = seg[k] ? (target - acc) / seg[k] : 0;
      var a = pts[k], b = pts[k + 1] || pts[k];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
  }

  /* 采样点数按周长自适应。轮廓的 RDP 顶点常在 200 以上，上限必须够大：
   * 企鹅图实测 32 点（周长 5028）P95 偏差 37px、Chamfer 6.0，画出来是带尖刺的三角形。
   * 上限 128 仍能一次传回，10 条约 12KB。 */
  function sampleCount(p) {
    /* 1 点 / 12px，下限 12、上限 128。
     * 实测把预算从周长/24 提到周长/4（演示图暗面环 23 → 25 点）Chamfer 只从 1.09 降到 1.04，
     * 说明 RDP 顶点数量此时不是瓶颈（114 顶点里保形点本来只有 25 个）；
     * 真正的残差是「少量点 + 均匀 Catmull-Rom」在尖角处的过冲，见 §4.4。 */
    return clamp(Math.round((p.length || 100) / 12), 12, 128);
  }

  /* 给模型的控制点候选 = 按预算抽稀的 RDP 顶点。
   * 均匀采样会漏尖角（把角切圆），拐点吸附又会在密集顶点里制造来回跳的尖刺；
   * RDP 的 ε 保证「抽稀后的折线离原线不超过 ε」，保形性最好。 */
  function controlSamples(path, closed, maxN) {
    if (!path || path.length < 3) return (path || []).slice();
    var out;
    if (path.length <= maxN) {
      out = path.slice();
    } else {
      var lo = 0, hi = 1e6, best = null;
      for (var it = 0; it < 18; it++) {
        var mid = (lo + hi) / 2;
        var pts = rdp(path, mid);
        if (pts.length <= maxN) { best = pts; hi = mid; }
        else { lo = mid; }
      }
      out = (best && best.length >= 3) ? best : samplePath(path, closed, maxN);
    }
    return densify(out, closed, Math.min(maxN, 12));
  }

  /* 顶点太少时在最长边上补中点：保留尖角，又给样条足够约束，
   * 否则 4 个顶点会被 Catmull-Rom 拉成椭圆。 */
  function densify(pts, closed, minN) {
    var list = (pts || []).slice();
    var guard = 0;
    while (list.length < minN && guard++ < 256) {
      var segs = closed ? list.length : list.length - 1;
      var bi = 0, bl = -1;
      for (var i = 0; i < segs; i++) {
        var a = list[i], b = list[(i + 1) % list.length];
        var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l > bl) { bl = l; bi = i; }
      }
      var p = list[bi], q = list[(bi + 1) % list.length];
      list.splice(bi + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    }
    return list;
  }

  function viewRegion(args) {
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var palette = [];
    S.strokes.forEach(function (p) { if (palette.indexOf(p.color) < 0) palette.push(p.color); });
    var from = clamp(Number((args && args.from) || 0) | 0, 0, S.strokes.length);
    var limit = clamp(Number((args && args.limit) || 32) | 0, 1, 64);
    var slice = S.strokes.slice(from, from + limit);
    return {
      image: { w: S.w, h: S.h, name: S.imgName },
      region: [r.x, r.y, r.w, r.h].map(function (v) { return Math.round(v); }),
      count: S.strokes.length,
      from: from,
      returned: slice.length,
      mode: S.lastMode,
      palette: palette.slice(0, 8),
      /* 坐标一律归一化到 0–1000（相对区域），模型回传也用这个口径 */
      coord: '各点坐标是相对区域归一化的 0–1000；重绘时把坐标按同一口径传回 vl_redraw_parts',
      strokes: slice.map(function (p) {
        var b = strokeBrief(p);
        b.samples = controlSamples(p.path, p.closed, sampleCount(p)).map(function (q) {
          return [Math.round((q[0] - r.x) / Math.max(1, r.w) * 1000), Math.round((q[1] - r.y) / Math.max(1, r.h) * 1000)];
        });
        /* 贝塞尔切段建议：长线给分段点，模型只补「往哪转」的手柄（B 组） */
        var bk = bezierBreaks(p.path, p.closed, 16);
        if (bk) b.breaks = bk.breaks.map(normPx);
        return b;
      })
    };
  }

  function drawStrokes(args) {
    var ops = Array.isArray(args && args.ops) ? args.ops : [];
    var applied = 0;
    ops.forEach(function (o, i) {
      if (!o) return;
      var targets = (!o.key || o.key === '*' || o.key === 'all') ? S.strokes.slice()
        : S.strokes.filter(function (x) { return x.key === o.key; });
      targets.forEach(function (p) {
        var cur = opOf(p.key) || {};
        S.ops.set(p.key, {
          color: o.color || cur.color || p.color,
          width: safeWidth(o.width != null ? o.width : (cur.width != null ? cur.width : p.width), p.width),
          order: o.order != null ? Number(o.order) : i,
          dx: 0, dy: 0, sc: 1, rot: 0
        });
        applied++;
      });
    });
    renderParts(); drawScene(); updateStat();
    return { applied: applied, drawn: sortedOps().length };
  }

  /* 语义分组：模型把碎块归到「部位」并命名、给统一颜色；
   * 无意义碎块（抗锯齿暗带、压缩噪点）用 drop 丢掉。
   * 这是色块模式从「像素拼贴」变成「围巾像围巾、眼睛像眼睛」的关键一步。
   *
   * 颜色是测量值，语义不能改写它：模型给的组色离实测平均色太远时直接拒收，
   * 保留各块原色。真实运行里模型把白眼块命名成瞳孔并给 #111111，眼睛就黑了。 */
  var GROUP_COLOR_MAX_DIST = 60;

  function groupMeasuredColor(keys, valid) {
    var r = 0, g = 0, b = 0, w = 0;
    keys.forEach(function (k) {
      var p = valid[k];
      if (!p) return;
      var c = rgbOf(p.color), kk = Math.max(1, p.area || p.length || 1);
      r += c[0] * kk; g += c[1] * kk; b += c[2] * kk; w += kk;
    });
    return w ? hexOf([r / w, g / w, b / w]) : '';
  }
  function colorDist(a, b) {
    var x = rgbOf(a), y = rgbOf(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }

  function groupParts(args) {
    if (S.lastMode !== 'color') return { error: '分组只用于色块模式（取线源=色块）' };
    var raw = Array.isArray(args && args.groups) ? args.groups : [];
    var valid = {};
    S.strokes.forEach(function (p) { if (p.region) valid[p.key] = p; });
    var seen = {}, groups = [], dropped = 0, fixed = [];

    /* 顶层 drop：真实运行里模型就把 drop 写在主参数上（{"drop":[…],"groups":[…]}），
     * 只支持组内 drop 会静默吞掉这条指令，于是「未分组 2」一直清不掉，模型反复重分组直到轮次耗尽。 */
    if (Array.isArray(args && args.drop)) {
      args.drop.forEach(function (k) {
        if (valid[k] && !seen[k] && !S.drop[k]) { S.drop[k] = 1; dropped++; }
      });
    }

    raw.forEach(function (g, i) {
      if (!g) return;
      var keys = (Array.isArray(g.keys) ? g.keys : []).filter(function (k) {
        return valid[k] && !seen[k];
      });
      keys.forEach(function (k) { seen[k] = 1; });
      if (Array.isArray(g.drop)) {
        g.drop.forEach(function (k) {
          if (valid[k] && !seen[k] && !S.drop[k]) { S.drop[k] = 1; dropped++; }
        });
      }
      if (!keys.length) return;
      var given = g.color || '';
      var used = given;
      if (given) {
        var measured = groupMeasuredColor(keys, valid);
        if (measured && colorDist(given, measured) > GROUP_COLOR_MAX_DIST) {
          used = '';
          fixed.push({
            name: String(g.name || '未命名部位'),
            given: given, measured: measured,
            why: '组色与实测色差 ' + Math.round(colorDist(given, measured)) + '，超过 ' + GROUP_COLOR_MAX_DIST + '，按实测保留'
          });
        }
      }
      groups.push({
        id: 'g' + (i + 1), name: String(g.name || '未命名部位'),
        keys: keys, color: used, given: given
      });
    });

    S.groups = groups;
    /* 分图层：每个语义组就是一层，按组的顺序落笔（先大后小）。图层可以单独隐藏，
     * 用来检查「这个部位画对没有」，而不是所有色块糊在一张画布上没法分辨。 */
    S.layers = groups.map(function (g, i) {
      var m = S.strokes.filter(function (p) { return (g.keys || []).indexOf(p.key) >= 0; })[0];
      return {
        id: 'L' + i, name: g.name || ('部位' + (i + 1)),
        color: g.color || (m ? m.color : '#c8d4e2'),
        keys: (g.keys || []).slice()
      };
    });
    /* 组名就是部位语义：写进每条线，参考线列表和锚点标签才显示「企鹅·白色肚子」而不是「白·中中」。
     * 用户手改过的名字（source='user'）不覆盖；其余用模型给的组名，source='model'。 */
    groups.forEach(function (g) {
      if (!g.name || g.name === '未命名部位') return;
      g.keys.forEach(function (k) {
        var lex = S.lexicon[k];
        if (lex && lex.source === 'user') return;
        setLex(k, g.name, '', 'model', 0.8);
      });
    });
    /* 分组即落笔：几何是精确的区域边界，复制不需要模型再花一轮。
     * 之前模型分完组又反复 view_region，轮次耗尽时 0 条描绘，画面全空。 */
    var drawn = 0;
    if (!args || args.draw !== false) {
      var ops = [];
      groups.forEach(function (g) {
        g.keys.forEach(function (k) {
          /* 组色被拒时显式回落到该块原色，免得沿用上一轮的旧组色 */
          ops.push({ key: k, color: g.color || (valid[k] && valid[k].color) || '', order: ops.length });
        });
      });
      if (ops.length) drawn = drawStrokes({ ops: ops }).applied;
    }
    renderParts(); drawScene(); updateStat();
    var m = renderCheck();
    return {
      groups: groups.length,
      grouped: Object.keys(seen).length,
      drawn: drawn,
      dropped: dropped,
      colorFixed: fixed,
      ungrouped: S.strokes.filter(function (p) { return p.region && !seen[p.key] && !S.drop[p.key]; }).length,
      chamfer: m.chamfer, recall: m.recall, precision: m.precision
    };
  }

  /* 语义合理性自检：每块是否都有归属、有没有重复归组、有没有漏掉的噪声碎块。
   * 指标只说明「画到了」，这一步回答「画对了没有」。 */
  function semanticCheck() {
    var used = {}, dup = [], total = 0;
    S.strokes.forEach(function (p) { total += (p.area || 0); });
    S.groups.forEach(function (g) {
      (g.keys || []).forEach(function (k) {
        if (used[k]) dup.push(k);
        used[k] = 1;
      });
    });

    var ungrouped = [], noise = [];
    S.strokes.forEach(function (p) {
      if (!p.region || used[p.key] || S.drop[p.key]) return;
      var brief = { key: p.key, color: p.color, area: Math.round(p.area || 0), bbox: p.bbox.map(function (v) { return Math.round(v); }) };
      ungrouped.push(brief);
      if ((p.area || 0) < total * 0.004) noise.push(brief);
    });

    /* 同一组里颜色跨度太大 = 很可能把两个部位并成一组（白眼睛 + 黑瞳孔）。
     * 这类错并会让「一組只填一次」盖掉内部细节，必须在收口前拆开。 */
    var byKey = {};
    S.strokes.forEach(function (p) { if (p.region) byKey[p.key] = p; });
    var clash = [];
    S.groups.forEach(function (g) {
      var cols = (g.keys || []).map(function (k) { return byKey[k] && byKey[k].color; }).filter(Boolean);
      var spread = 0;
      for (var i = 0; i < cols.length; i++) {
        for (var j = i + 1; j < cols.length; j++) spread = Math.max(spread, colorDist(cols[i], cols[j]));
      }
      if (spread > 90) clash.push({ name: g.name, spread: Math.round(spread), colors: cols });
    });

    var m = renderCheck();
    var hint = ungrouped.length
      ? '还有色块没归组：直接在 vl_group_parts 里补一组（或并进现有组）；确认是无意义碎块（抗锯齿暗带/噪点）再用 drop。不要再 view_region。'
      : (clash.length
        ? '有组内颜色跨度太大：同一组只填一次，会把里面的小件盖掉（白眼 + 瞳孔、围巾 + 牙齿都会被压平）。拆成两个部位重新 group。'
        : '全部色块都有归属，组内颜色一致。');
    return {
      mode: S.lastMode,
      groups: S.groups.map(function (g) {
        return { name: g.name, blocks: g.keys.length, color: g.color || '', given: g.given || '' };
      }),
      unnamed: S.groups.filter(function (g) { return !g.name || g.name === '未命名部位'; }).length,
      duplicates: dup,
      dropped: Object.keys(S.drop).length,
      ungrouped: ungrouped,
      noise: noise,
      clash: clash,
      colorFixed: S.groups.filter(function (g) { return g.given && !g.color; }).map(function (g) {
        return { name: g.name, given: g.given };
      }),
      hint: hint,
      chamfer: m.chamfer, recall: m.recall, precision: m.precision, drawn: m.drawn
    };
  }

  /* 精确重绘：模型给控制点，程序只做 Catmull-Rom 拟合与落笔。
   * 与 vl_draw_parts 的区别：那个是「按参考几何复制」，这个是「模型自己给曲线」。 */
  function distToPolyline(p, path, closed) {
    var best = 1e9;
    for (var i = 1; i < path.length; i++) best = Math.min(best, distToSeg(p, path[i - 1], path[i]));
    if (closed && path.length > 2) best = Math.min(best, distToSeg(p, path[path.length - 1], path[0]));
    return best;
  }

  function projOnSeg(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var L2 = vx * vx + vy * vy;
    var t = L2 ? clamp(((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2, 0, 1) : 0;
    var q = [a[0] + vx * t, a[1] + vy * t];
    return { t: t, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
  }

  /* 模型给的点通常落在参考线上，但顺序可能被它按角度/坐标重排过。
   * 对一条已知的参考折线来说，正确顺序就是弧长顺序：按投影弧长排序可复原。
   * 返回是否真的改过顺序，供监督页显示。 */
  function orderAlongPolyline(pts, path, closed) {
    var segs = [], acc = 0;
    function push(a, b) {
      var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push({ a: a, b: b, l0: acc, l: l });
      acc += l;
    }
    for (var i = 1; i < path.length; i++) push(path[i - 1], path[i]);
    if (closed && path.length > 2) push(path[path.length - 1], path[0]);
    if (!segs.length) return { pts: pts, changed: false };
    var tagged = pts.map(function (q, idx) {
      var best = { d: 1e9, s: 0 };
      segs.forEach(function (sg) {
        var pr = projOnSeg(q, sg.a, sg.b);
        if (pr.d < best.d) best = { d: pr.d, s: sg.l0 + pr.t * sg.l };
      });
      return { p: q, s: best.s, i: idx };
    });
    tagged.sort(function (x, y) { return x.s - y.s; });
    var changed = false;
    tagged.forEach(function (x, k) { if (x.i !== k) changed = true; });
    return { pts: tagged.map(function (x) { return x.p; }), changed: changed };
  }

  function redrawParts(args) {
    var ops = Array.isArray(args && args.ops) ? args.ops : [];
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    var keys = [], missing = [], devs = [], reordered = 0;
    var bez = { n: 0, segs: 0, clamped: 0, fitted: 0, gap: 0 };
    ops.forEach(function (o, i) {
      if (!o || !o.key) return;
      var targets = (o.key === '*' || o.key === 'all') ? S.strokes.slice()
        : S.strokes.filter(function (x) { return x.key === o.key; });
      if (!targets.length) { missing.push(o.key); return; }
      targets.forEach(function (p) {
        /* 参考线固定为提取结果，不随上一轮重绘漂移，诊断才有基准 */
        if (!p.ref) p.ref = p.path.slice();
        var closed = (o.closed != null) ? !!o.closed : !!p.closed;
        var useBez = (o.form === 'bezier') || (Array.isArray(o.segs) && o.segs.length > 0);
        if (useBez) {
          /* B / C 组：模型给端点 + 手柄。缺手柄时由 fitHandles 从参考线上最小二乘解出来（C 组）。
           * 手柄长度上限 0.85×弦长，超过就夹紧——否则三次贝塞尔会在段内自交出环。 */
          var start = normPt(o.start) || (Array.isArray(o.points) && normPt(o.points[0]));
          var segsIn = Array.isArray(o.segs) ? o.segs : [];
          var segs = [], cur = start, perClamp = 0, perFit = 0;
          /* 参考线在「弧长空间」里逐段前进：RDP 之后顶点间距可达 12px，
           * 按最近顶点取子路径会把端点前后错开一格，切向直接反号；
           * 轮廓又会在窄颈处自相近，全局最近点会跳到环的另一侧（实测 chord 51px 配了 320px 弧长）。 */
          var tb = p.refTB || (p.refTB = arcTable(p.ref, p.closed));
          var startS = start ? arcProject(tb, 0, start, tb.total, p.closed).s : 0;
          var curS = startS;
          segsIn.forEach(function (sg) {
            if (!sg || !cur) return;
            var end = normPt(sg.end);
            if (!end) return;
            var c1 = normPt(sg.c1), c2 = normPt(sg.c2);
            var chord = Math.hypot(end[0] - cur[0], end[1] - cur[1]) || 1;
            var cap = 0.85 * chord;
            /* 向前窗口按弦长给：真弧长一般 ≤1.6×弦长，2.5×+30 足够用，
             * 但能挡住「绕到环的另一侧」那种成倍的假弧长。 */
            var pa = arcProject(tb, curS, end, 2.5 * chord + 30, p.closed);
            var sEnd = Math.max(pa.s, curS + 0.5);
            if (!c1 || !c2) {
              var f = fitHandles(cur, end, sampleSubArc(tb, curS, sEnd));
              if (!c1) c1 = f.c1;
              if (!c2) c2 = f.c2;
              if (f.fitted) perFit++;
            }
            var l1 = Math.hypot(c1[0] - cur[0], c1[1] - cur[1]);
            if (l1 > cap) {
              c1 = [cur[0] + (c1[0] - cur[0]) * cap / l1, cur[1] + (c1[1] - cur[1]) * cap / l1];
              perClamp++;
            }
            var l2 = Math.hypot(c2[0] - end[0], c2[1] - end[1]);
            if (l2 > cap) {
              c2 = [end[0] + (c2[0] - end[0]) * cap / l2, end[1] + (c2[1] - end[1]) * cap / l2];
              perClamp++;
            }
            segs.push({ c1: c1, c2: c2, end: end });
            cur = end;
            curS = p.closed ? (sEnd % tb.total) : Math.min(sEnd, tb.total);
          });
          if (start && segs.length) {
            /* 闭合环：最后一段回到起点。模型常常只给到 breaks 的末点，
             * 这里沿参考线补一段（C 组同款最小二乘），避免收口变成一条直弦。 */
            if (closed) {
              var lst = segs[segs.length - 1].end;
              var gapArc = (startS - curS + tb.total) % tb.total;
              if (gapArc > 1 && gapArc < tb.total - 1) {
                var fc = fitHandles(lst, start, sampleSubArc(tb, curS, curS + gapArc));
                segs.push({ c1: fc.c1, c2: fc.c2, end: start.slice() });
                if (fc.fitted) perFit++;
                bez.gap++;
              }
            }
            var curve = bezierPath(start, segs, 8);
            var ends = [start].concat(segs.map(function (s) { return s.end; }));
            devs.push(percentile(ends.map(function (q) { return distToPolyline(q, p.ref, p.closed); }), 0.5));
            p.path = curve;
            p.anchors = segs.length + 1;
            if (p.region) p.bez = fitBezLoop(curve, p.tol || 2);
            p.closed = closed;
            p.form = 'bezier';
            p.length = pathLength(closed ? curve.concat([curve[0]]) : curve);
            p.bbox = bboxOfPath(curve);
            p.source = 'model';
            p.redrawn = true;
            bez.n++; bez.segs += segs.length; bez.clamped += perClamp; bez.fitted += perFit;
          }
        } else if (Array.isArray(o.points) && o.points.length >= 2) {
          var pts = o.points.map(function (q) {
            if (!Array.isArray(q) || q.length < 2) return null;
            var x = Number(q[0]), y = Number(q[1]);
            return (isFinite(x) && isFinite(y)) ? [r.x + x / 1000 * r.w, r.y + y / 1000 * r.h] : null;
          }).filter(Boolean);
          if (pts.length >= 2) {
            /* 控制点离参考线多远：给模型一个能自我纠正的数，而不是只看最终 Chamfer */
            var ds = pts.map(function (q) { return distToPolyline(q, p.ref, p.closed); });
            devs.push(percentile(ds, 0.5));
            /* 点对但顺序错（按角度重排）会把凹轮廓拉成横跨内部的弦，这里按弧长复原 */
            var ordered = orderAlongPolyline(pts, p.ref, closed);
            if (ordered.changed) reordered++;
            var smooth = catmullRom(ordered.pts, closed, 6);
            p.path = smooth;
            p.anchors = ordered.pts.length;
            if (p.region) p.bez = fitBezLoop(smooth, p.tol || 2);
            p.closed = closed;
            p.form = 'poly';
            p.length = pathLength(closed ? smooth.concat([smooth[0]]) : smooth);
            p.bbox = bboxOfPath(smooth);
            p.source = 'model';
            p.redrawn = true;
          }
        }
        if (o.width != null) p.width = safeWidth(o.width, p.width);
        if (o.color) p.color = o.color;
        if (o.name) p.name = o.name;
        var curOp = opOf(p.key) || {};
        S.ops.set(p.key, {
          color: o.color || curOp.color || p.color,
          width: safeWidth(o.width != null ? o.width : (curOp.width != null ? curOp.width : p.width), p.width),
          order: o.order != null ? Number(o.order) : (curOp.order != null ? curOp.order : i),
          dx: 0, dy: 0, sc: 1, rot: 0
        });
        keys.push(p.key);
      });
    });
    S.metrics = null;   /* 几何变了，上一轮的指标作废；但「最好一轮」的回滚点要保留 */
    renderParts(); drawScene(); updateStat();
    return {
      redrawn: keys.length, keys: keys.slice(0, 20), drawn: sortedOps().length,
      dev: devs.length ? round2(percentile(devs, 0.5)) : null,
      maxDev: devs.length ? round2(Math.max.apply(null, devs)) : null,
      reordered: reordered,
      bezier: bez.n, segs: bez.segs, clamped: bez.clamped, fitted: bez.fitted, gap: bez.gap,
      missing: missing.slice(0, 8)
    };
  }

  function catmullRom(points, closed, steps) {
    if (!points || points.length < 2) return points || [];
    var pts = points.slice();
    if (closed) pts = [pts[pts.length - 1]].concat(pts, [pts[0], pts[1]]);
    else pts = [pts[0]].concat(pts, [pts[pts.length - 1]]);
    var out = [];
    for (var i = 0; i < pts.length - 3; i++) {
      var p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];
      for (var j = 0; j < steps; j++) {
        var t = j / steps, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    return out;
  }

  /* ---------------- 贝塞尔（B / C 组） ---------------- */

  function regionRect() { return S.region || { x: 0, y: 0, w: S.w, h: S.h }; }

  /* 0–1000 归一化坐标 → 区域像素；非法返回 null */
  function normPt(v) {
    if (!Array.isArray(v) || v.length < 2) return null;
    var x = Number(v[0]), y = Number(v[1]);
    if (!isFinite(x) || !isFinite(y)) return null;
    var r = regionRect();
    return [r.x + x / 1000 * r.w, r.y + y / 1000 * r.h];
  }

  function normPx(q) {
    var r = regionRect();
    return [Math.round((q[0] - r.x) / Math.max(1, r.w) * 1000), Math.round((q[1] - r.y) / Math.max(1, r.h) * 1000)];
  }

  /* 三次贝塞尔采样：start 与 segs 都是区域像素坐标 */
  function bezierPath(start, segs, steps) {
    if (!start || !segs || !segs.length) return null;
    var out = [start.slice()], cur = start;
    segs.forEach(function (sg) {
      for (var k = 1; k <= steps; k++) {
        var t = k / steps, u = 1 - t;
        out.push([
          u * u * u * cur[0] + 3 * u * u * t * sg.c1[0] + 3 * u * t * t * sg.c2[0] + t * t * t * sg.end[0],
          u * u * u * cur[1] + 3 * u * u * t * sg.c1[1] + 3 * u * t * t * sg.c2[1] + t * t * t * sg.end[1]
        ]);
      }
      cur = sg.end;
    });
    return out;
  }

  function arcTable(path, closed) {
    var pts = path.slice();
    if (closed && pts.length > 2) pts = pts.concat([pts[0]]);
    var segs = [], acc = 0;
    for (var i = 1; i < pts.length; i++) {
      var l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      segs.push({ a: pts[i - 1], b: pts[i], l0: acc, l: l });
      acc += l;
    }
    return { segs: segs, total: acc };
  }

  function pointAtArc(tb, s) {
    s = clamp(s, 0, tb.total);
    for (var i = 0; i < tb.segs.length; i++) {
      var sg = tb.segs[i];
      if (s <= sg.l0 + sg.l || i === tb.segs.length - 1) {
        var t = sg.l ? clamp((s - sg.l0) / sg.l, 0, 1) : 0;
        return {
          p: [sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t],
          d: sg.l ? [(sg.b[0] - sg.a[0]) / sg.l, (sg.b[1] - sg.a[1]) / sg.l] : [1, 0]
        };
      }
    }
    return { p: tb.segs[0].a.slice(), d: [1, 0] };
  }

  /* 每个顶点的累计弧长与转角，用来把切段点吸到拐角上 */
  function vertexTurns(path, closed) {
    var n = path.length, tb = arcTable(path, closed), out = [];
    for (var i = 0; i < n; i++) {
      var s = i < tb.segs.length ? tb.segs[i].l0 : tb.total;
      if (!closed && (i === 0 || i === n - 1)) { out.push({ s: s, turn: 0 }); continue; }
      var a = path[(i - 1 + n) % n], b = path[i], c = path[(i + 1) % n];
      var ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      var lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
      out.push({ s: s, turn: Math.acos(clamp((ux * vx + uy * vy) / (lu * lv), -1, 1)) });
    }
    return out;
  }

  /* 切段建议：段长目标 60px，2–16 段；段界优先落在拐角上。
   * 60px 是实测下限：再长，一段三次贝塞尔跨过拐角就会偏 8–19px（§4.5）。 */
  function bezierBreaks(path, closed, maxSegs) {
    if (!path || path.length < 3) return null;
    var tb = arcTable(path, closed);
    if (tb.total < 90) return null;
    var n = clamp(Math.round(tb.total / 60), 2, maxSegs || 16);
    var turns = vertexTurns(path, closed);
    var out = [pointAtArc(tb, 0).p];
    var prev = 0;
    for (var k = 1; k < n; k++) {
      var ideal = k * tb.total / n, win = 0.35 * tb.total / n, best = null;
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        if (t.s <= prev + 1 || t.s < ideal - win || t.s > ideal + win) continue;
        if (!best || t.turn > best.turn) best = t;
      }
      var s = best ? best.s : ideal;
      /* 必须严格递增：吸到拐角后可能落到上一段之前，那样「正向前进」的子路径会绕整圈，
       * 最小二乘用错方向的参考点（实测某段 chord 51px 却走了 320px 弧长）。 */
      if (s <= prev + 1) s = prev + Math.max(2, tb.total / n / 2);
      if (s >= tb.total - 2) break;
      out.push(pointAtArc(tb, s).p);
      prev = s;
    }
    return { breaks: out, segs: out.length, total: tb.total };
  }

  /* 从弧长 fromS 向前找 q 在参考线上的投影位置（含段内插值，精度到亚像素）。
   * 只在 [fromS, fromS+win] 里找：轮廓自相近时，全局最近点会落到环的另一侧。
   * closed 时允许窗口跨过 total，用 ±total 的副本参与比较。 */
  function arcProject(tb, fromS, q, win, closed) {
    var total = tb.total, toS = fromS + Math.max(0.5, Math.min(win || total, total));
    var best = null;
    tb.segs.forEach(function (sg) {
      var pr = projOnSeg(q, sg.a, sg.b);
      var s0 = sg.l0 + pr.t * sg.l;
      for (var rep = 0; rep < (closed ? 2 : 1); rep++) {
        var s = s0 + rep * total;
        if (s < fromS - 1e-6 || s > toS) continue;
        if (!best || pr.d < best.d) best = { s: s, d: pr.d };
      }
    });
    return best || { s: fromS, d: 1e9 };
  }

  /* 弧长 s0→s1 的密采样子路径（约 2px 一点）。closed 时 s1 可以超过 total，按环取模。 */
  function sampleSubArc(tb, s0, s1) {
    var total = tb.total, len = Math.max(0.5, s1 - s0);
    var n = clamp(Math.ceil(len / 2), 2, 400), out = [];
    for (var i = 0; i <= n; i++) {
      var s = s0 + len * i / n;
      if (total > 0) s = ((s % total) + total) % total;
      out.push(pointAtArc(tb, clamp(s, 0, total)).p);
    }
    return out;
  }

  /* C 组：端点已定，手柄长度用最小二乘解（方向取参考线的切向，只解两个长度标量） */
  function fitHandles(start, end, sub) {
    var chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
    var flat = { c1: start.slice(), c2: end.slice(), fitted: false };
    if (chord < 1 || !sub || sub.length < 2) return flat;
    var tb = arcTable(sub, false);
    if (tb.total < 1) return flat;
    var d0 = pointAtArc(tb, 0).d, d1 = pointAtArc(tb, tb.total).d;
    var n = Math.max(8, Math.round(tb.total / 6));
    var aa = 0, ab = 0, bb = 0, ra = 0, rb = 0;
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      var q = pointAtArc(tb, tb.total * t).p;
      var b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      /* c1 = A + a·d0、c2 = B − b·d1，所以残差是 B1·a·d0 − B2·b·d1 */
      var rx = q[0] - (b0 + b1) * start[0] - (b2 + b3) * end[0];
      var ry = q[1] - (b0 + b1) * start[1] - (b2 + b3) * end[1];
      var ax = b1 * d0[0], ay = b1 * d0[1];
      var bx = -b2 * d1[0], by = -b2 * d1[1];
      aa += ax * ax + ay * ay;
      ab += ax * bx + ay * by;
      bb += bx * bx + by * by;
      ra += ax * rx + ay * ry;
      rb += bx * rx + by * ry;
    }
    var det = aa * bb - ab * ab, a = 0, b = 0;
    if (Math.abs(det) > 1e-9) { a = (ra * bb - rb * ab) / det; b = (rb * aa - ra * ab) / det; }
    var cap = 0.85 * chord;
    a = clamp(a, 0, cap); b = clamp(b, 0, cap);
    return { c1: [start[0] + d0[0] * a, start[1] + d0[1] * a], c2: [end[0] - d1[0] * b, end[1] - d1[1] * b], fitted: true, a: a, b: b, subLen: tb.total };
  }

  function drawPaths(args) {
    var paths = Array.isArray(args && args.paths) ? args.paths : [];
    var keys = [];
    paths.forEach(function (pp) {
      var pts = (pp && pp.points) || [];
      if (pts.length < 2) return;
      if (pts.length > 16) pts = pts.slice(0, 16);
      var path = catmullRom(pts.map(function (q) { return [Number(q[0]) || 0, Number(q[1]) || 0]; }), pp.closed === true, 8);
      S.customSeq++;
      var key = 'c' + S.customSeq;
      var bbox = bboxOfPath(path);
      var part = {
        key: key, path: path,
        width: pp.width != null ? Number(pp.width) : 1.5,
        color: pp.color || '#2b3440',
        length: pathLength(path),
        anchors: pts.length,
        bbox: bbox,
        name: pp.name || ('新线' + S.customSeq),
        en: '', conf: 0.5, source: 'model',
        cx: 0, cy: 0, area: pathLength(path)
      };
      S.strokes.push(part);
      S.ops.set(key, {
        color: part.color, width: part.width,
        order: 1e7 + S.customSeq, dx: 0, dy: 0, sc: 1, rot: 0
      });
      keys.push(key);
    });
    drawScene(); renderParts();
    return { created: keys.length, keys: keys };
  }

  function editStrokes(args) {
    var ops = Array.isArray(args && args.ops) ? args.ops : [];
    var applied = 0;
    ops.forEach(function (o) {
      if (!o || !o.key) return;
      var cur = opOf(o.key);
      if (!cur) return;
      if (o.dx != null) cur.dx = (cur.dx || 0) + Number(o.dx);
      if (o.dy != null) cur.dy = (cur.dy || 0) + Number(o.dy);
      if (o.sc != null) cur.sc = (cur.sc || 1) * Number(o.sc);
      if (o.rot != null) cur.rot = (cur.rot || 0) + Number(o.rot);
      if (o.width != null) cur.width = safeWidth(o.width, cur.width);
      if (o.color) cur.color = o.color;
      if (o.order != null) cur.order = Number(o.order);
      S.ops.set(o.key, cur);
      applied++;
    });
    drawScene(); renderParts(); updateStat();
    return { applied: applied };
  }

  function measure(args) {
    var a = args && args.a, b = args && args.b;
    function midOf(key) {
      var p = S.strokes.filter(function (x) { return x.key === key; })[0];
      if (!p) return null;
      return [(p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2];
    }
    if (args && args.aKey) a = midOf(args.aKey) || a;
    if (args && args.bKey) b = midOf(args.bKey) || b;
    if (!a || !b) return { error: '需要 a/b 两个点，或 aKey/bKey' };
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var dist = Math.sqrt(dx * dx + dy * dy);
    var r = S.region || { w: S.w, h: S.h };
    return {
      dx: round2(dx), dy: round2(dy), dist: round2(dist),
      distRatio: +((dist / Math.sqrt(r.w * r.w + r.h * r.h)) * 100).toFixed(2),
      angleDeg: +((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1))
    };
  }

  var TOOLS = [
    {
      type: 'function', function: {
        name: 'vl_view_region',
        description: '看当前区域的线稿摘要：每条线段的中线 key、名称、长度、线宽、颜色、包围盒、锚点数、samples（轮廓采样点）、breaks（贝塞尔切段建议），以及取线模式。一次最多返回 64 条，用 from 翻页。开工第一步调它。',
        parameters: {
          type: 'object', properties: {
            from: { type: 'number', description: '从第几条开始（默认 0）' },
            limit: { type: 'number', description: '本次返回多少条（默认 32，上限 64）' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_trace',
        description: '重新提取线稿。可覆盖 shape（contour/center）、src（auto/edge/dark/color）、threshold、simplify、minLen，用来对比不同取线口径。',
        parameters: {
          type: 'object', properties: {
            shape: { type: 'string', description: 'contour=每个字形/图形一圈闭合轮廓, center=中线 + 线宽' },
            src: { type: 'string', description: 'auto=自动判断, edge=按颜色边缘取线, dark=按暗像素取线, color=色块（多色图标/插画，逐块取轮廓并原色填充）' },
            threshold: { type: 'number', description: '取线阈值。边缘模式越小抓得越多；暗线模式映射为亮度阈值' },
            simplify: { type: 'number', description: '抽稀容差（像素）' },
            minLen: { type: 'number', description: '最短线段（像素），短的直接丢' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_draw_parts',
        description: '按参考几何复制线段（只传 key / 线宽 / 颜色 / 顺序，不传坐标）。这一步不改几何，适合「线已经是你要的形状」。要改形状用 vl_redraw_parts。',
        parameters: {
          type: 'object', properties: {
            ops: {
              type: 'array', items: {
                type: 'object', properties: {
                  key: { type: 'string' }, width: { type: 'number' }, color: { type: 'string' }, order: { type: 'number' }
                }, required: ['key']
              }
            }
          }, required: ['ops']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_group_parts',
        description: '色块模式专用：把色块归到「语义部位」并命名；无意义碎块（抗锯齿暗带、压缩噪点）用 drop 丢掉。同级碎块各自填，只有整个套在另一块里面的成员才当孔洞挖掉；默认自动落笔（draw:false 可关）。先分组，再自检。',
        parameters: {
          type: 'object', properties: {
            groups: {
              type: 'array', items: {
                type: 'object', properties: {
                  name: { type: 'string', description: '中文部位名，格式「主体·部位」，例如「企鹅·红围巾」「企鹅·左眼」' },
                  keys: { type: 'array', items: { type: 'string' }, description: '属于这个部位的色块 key（先看 tone / where / holes 再归组）' },
                  color: { type: 'string', description: '可选。留空 = 沿用每块实测原色（推荐）；只有需要统一同色相碎块时才给，且必须贴近实测色，差太远会被拒收并在 colorFixed 回报' },
                  drop: { type: 'array', items: { type: 'string' }, description: '确认无意义的碎块 key，直接不画（也可以写在顶层 drop）' }
                }, required: ['name', 'keys']
              }
            },
            drop: {
              type: 'array', items: { type: 'string' },
              description: '顶层写法：无意义碎块（抗锯齿暗带、细窄残条、噪点）的 key，不参与绘制也不计入已描绘'
            }
          }, required: ['groups']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_redraw_parts',
        description: '精确重绘。两种形态：① points 折线（3–128 个控制点，程序 Catmull-Rom 拟合）；② form:"bezier" 端点+手柄（start + segs，适合头发、衣褶这类长而平滑的弧）。一次最多 8 条，超过要分多批调用。坐标都用 vl_view_region 的 samples 同一口径（相对区域 0–1000）。',
        parameters: {
          type: 'object', properties: {
            ops: {
              type: 'array', items: {
                type: 'object', properties: {
                  key: { type: 'string' },
                  form: { type: 'string', description: 'poly=折线控制点（默认）；bezier=三次贝塞尔（端点 + 手柄）' },
                  points: {
                    type: 'array', description: '折线控制点 [[x,y], …]，0–1000 归一化；沿参考线取点，曲率大的地方多取',
                    items: { type: 'array', items: { type: 'number' } }
                  },
                  start: { type: 'array', description: 'bezier 起点 [x,y]，0–1000；可省略 segs[0] 之前的点', items: { type: 'number' } },
                  segs: {
                    type: 'array',
                    description: 'bezier 段序列。每段 {c1,c2,end}：c1/c2 是手柄（0–1000 坐标），手柄长度不要超过该段弦长的 0.85 倍；不传 c1/c2 时由程序从参考线最小二乘求出',
                    items: {
                      type: 'object', properties: {
                        c1: { type: 'array', items: { type: 'number' } },
                        c2: { type: 'array', items: { type: 'number' } },
                        end: { type: 'array', items: { type: 'number' } }
                      }, required: ['end']
                    }
                  },
                  closed: { type: 'boolean' },
                  width: { type: 'number' },
                  color: { type: 'string' },
                  name: { type: 'string', description: '中文语义名，格式「主体·部位」，例如「企鹅·左翅」' },
                  order: { type: 'number' }
                }, required: ['key']
              }
            }
          }, required: ['ops']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_edit_parts',
        description: '微调已描绘的线段：位移（像素）、缩放、旋转（弧度）、改线宽、改色、改层级。',
        parameters: {
          type: 'object', properties: {
            ops: {
              type: 'array', items: {
                type: 'object', properties: {
                  key: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' },
                  sc: { type: 'number' }, rot: { type: 'number' }, width: { type: 'number' },
                  color: { type: 'string' }, order: { type: 'number' }
                }, required: ['key']
              }
            }
          }, required: ['ops']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_draw_paths',
        description: '创作新线：给 8-16 个控制点（区域像素坐标），程序会拟合平滑曲线并给指定线宽。',
        parameters: {
          type: 'object', properties: {
            paths: {
              type: 'array', items: {
                type: 'object', properties: {
                  points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                  closed: { type: 'boolean' }, width: { type: 'number' }, color: { type: 'string' }, name: { type: 'string' }
                }, required: ['points']
              }
            }
          }, required: ['paths']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_measure',
        description: '量两点距离/角度，或两条线段中点之间的距离。坐标都是区域内的像素坐标。',
        parameters: {
          type: 'object', properties: {
            a: { type: 'array', items: { type: 'number' } },
            b: { type: 'array', items: { type: 'number' } },
            aKey: { type: 'string' }, bKey: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_name_parts',
        description: '给线段起语义名（外轮廓 / 领口 / 发丝…）。只对需要命名的 key 调用。',
        parameters: {
          type: 'object', properties: {
            keys: { type: 'array', items: { type: 'string' }, description: '留空表示所有未手改过的线段' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_render_check',
        description: '回读校验：把当前描绘栅格化，与原图线稿比 Chamfer 距离、覆盖率召回/精度、中位线宽。每次画完都要调。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_check_semantics',
        description: '语义自检：每个色块是否都有归属、组名是否完整、有没有重复归组、组内颜色跨度是否过大（clash）、有没有被拒收的组色（colorFixed）、还剩多少未分组噪声碎块。色块模式每次分组后都要调。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_restore_best',
        description: '回滚到目前 Chamfer 最好的一轮（连几何一起还原）。改坏了、或者收口前想保住最好结果时调用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'vl_finish',
        description: '收口：说明这次重新描绘做了什么、指标如何、还有哪里没对齐。',
        parameters: {
          type: 'object', properties: { summary: { type: 'string' } }, required: ['summary']
        }
      }
    }
  ];

  async function execTool(name, args) {
    switch (name) {
      case 'vl_view_region': return viewRegion(args);
      case 'vl_trace': {
        var changed = false;
        ['shape', 'src', 'threshold', 'simplify', 'minLen'].forEach(function (k) {
          if (args && args[k] != null && args[k] !== S.opt[k]) changed = true;
        });
        /* 已经画上线还改参数：重提取会把画布清空。实测模型会连改三次参数，
         * 把已经画好的 31 条抹成 0，最后只来得及画 12 条。默认拦住。 */
        if (changed && S.ops.size && !(args && args.force)) {
          return {
            count: S.strokes.length, mode: S.lastMode, blocked: true, cleared: 0,
            hint: '已描绘 ' + S.ops.size + ' 条；改参数会清空它们。先完成重绘；确实要重来请传 force:true。'
          };
        }
        /* 一条都没画就反复对比取线口径：实测模型在 24/5/18/5 段之间来回切，
         * 8 轮全花在重提取上，最后 0 条描绘。初提取已经给了参考线，先画再换。 */
        if (changed && !S.ops.size && S.strokes.length && !(args && args.force)) {
          return {
            count: S.strokes.length, mode: S.lastMode, blocked: true, cleared: 0,
            auto: S.autoStats || null,
            hint: '还没画任何线。先用当前参考线重绘并校验，再换口径；确实要重提取请传 force:true。'
          };
        }
        ['shape', 'src', 'threshold', 'simplify', 'minLen'].forEach(function (k) {
          if (args && args[k] != null) S.opt[k] = args[k];
        });
        /* 参数没变的重复提取结果必然一样，但会把模型已经画上去的线全部清空。
         * 直接当空操作返回，避免模型「重提取一次看看」把自己的工作抹掉。 */
        if (!changed && S.strokes.length) {
          return { count: S.strokes.length, mode: S.lastMode, unchanged: true };
        }
        var had = S.ops.size;
        var before = S.strokes.length;
        var n = extractStrokes();
        return {
          count: n, mode: S.lastMode, cleared: had, delta: n - before,
          auto: S.autoStats || null,
          strokes: S.strokes.slice(0, 12).map(strokeBrief)
        };
      }
      case 'vl_draw_parts': return drawStrokes(args);
      case 'vl_redraw_parts': return redrawParts(args);
      case 'vl_edit_parts': return editStrokes(args);
      case 'vl_draw_paths': return drawPaths(args);
      case 'vl_measure': return measure(args);
      case 'vl_name_parts': return await nameUnknown((args && args.keys) || []);
      case 'vl_render_check': return renderCheck();
      case 'vl_group_parts': return groupParts(args);
      case 'vl_check_semantics': return semanticCheck();
      case 'vl_restore_best': return restoreBest();
      case 'vl_finish':
        if (args && args.summary) note(String(args.summary));
        setPhase('完成', '');
        return {
          ok: true, strokes: S.strokes.length, drawn: S.ops.size,
          chamfer: S.metrics ? S.metrics.chamfer : null,
          recall: S.metrics ? S.metrics.recall : null,
          precision: S.metrics ? S.metrics.precision : null,
          medianWidth: S.metrics ? S.metrics.medianWidth : null
        };
      default: return { error: '未知工具：' + name };
    }
  }

  function digestOf(name, res) {
    if (!res) return '';
    if (res.error) return '失败';
    if (name === 'vl_view_region') return (res.count || 0) + ' 段 · ' + res.mode;
    /* 分组 / 语义自检以前没有摘要，账本里只剩「r2 vl_group_parts：」一行空白，
     * 模型因此以为这两个工具没返回内容，反复重调。字段必须进账本。 */
    if (name === 'vl_group_parts') {
      var gp = (res.groups || 0) + ' 组 · 归组 ' + (res.grouped || 0) + ' 块 · 落笔 ' + (res.drawn || 0);
      if (res.dropped) gp += ' · drop ' + res.dropped;
      if (res.ungrouped) gp += ' · 未分组 ' + res.ungrouped;
      if (res.colorFixed && res.colorFixed.length) gp += ' · 拒收组色 ' + res.colorFixed.length;
      if (res.chamfer != null) gp += ' · Chamfer ' + res.chamfer;
      return gp;
    }
    if (name === 'vl_check_semantics') {
      var bad = [];
      if (res.ungrouped && res.ungrouped.length) bad.push('未分组 ' + res.ungrouped.length);
      if (res.duplicates && res.duplicates.length) bad.push('重复归组 ' + res.duplicates.length);
      if (res.unnamed) bad.push('未命名组 ' + res.unnamed);
      if (res.clash && res.clash.length) bad.push('组内色跨度大 ' + res.clash.length);
      if (res.colorFixed && res.colorFixed.length) bad.push('拒收组色 ' + res.colorFixed.length);
      return (bad.length ? bad.join(' · ') : '通过')
        + ' · ' + (res.groups ? res.groups.length : 0) + ' 组 · 已画 ' + (res.drawn || 0)
        + (res.chamfer != null ? ' · Chamfer ' + res.chamfer : '');
    }
    if (name === 'vl_trace') return res.blocked ? ('已拦截：画布上有 ' + res.count + ' 条，未清空')
      : (res.unchanged ? '参数未变，未重提取' : ((res.count || 0) + ' 段 · ' + res.mode + (res.cleared ? '（画布已清空）' : '')));
    if (name === 'vl_draw_parts') return (res.applied || 0) + ' 段已画';
    if (name === 'vl_redraw_parts') {
      var s = (res.redrawn || 0) + ' 段已重绘';
      if (res.bezier) s += ' · 贝塞尔 ' + res.bezier + ' 条/' + res.segs + ' 段';
      if (res.fitted) s += ' · 程序拟合手柄 ' + res.fitted;
      if (res.clamped) s += ' · 手柄夹紧 ' + res.clamped;
      if (res.dev != null) s += '（偏离参考 ' + res.dev + 'px）';
      if (res.reordered) s += ' · 重排 ' + res.reordered + ' 条';
      if (res.missing && res.missing.length) s += ' · ' + res.missing.length + ' 个 key 不存在';
      return s;
    }
    if (name === 'vl_edit_parts') return (res.applied || 0) + ' 段已调';
    if (name === 'vl_draw_paths') return (res.created || 0) + ' 条新线';
    if (name === 'vl_measure') return res.dist != null ? ('距离 ' + res.dist) : '无结果';
    if (name === 'vl_name_parts') return (res.named || 0) + '/' + (res.total || res.named || 0) + ' 已命名';
    if (name === 'vl_render_check') {
      var c = 'Chamfer ' + (res.chamfer != null ? res.chamfer : '—')
        + ' · 召回 ' + res.recall + ' / 精度 ' + res.precision + ' · 线宽 ' + res.medianWidth;
      if (res.bestChamfer != null) c += '（最好 ' + res.bestChamfer + ' / 第 ' + (res.bestRound + 1) + ' 轮）';
      if (res.noProgress) c += ' · 比最好那轮更差，考虑 vl_restore_best 或停止改动';
      if (res.worst && res.worst.length) {
        c += ' · 最差 ' + res.worst.slice(0, 3).map(function (w) {
          return w.key + ' miss ' + w.miss + (w.off ? ' off ' + w.off : '');
        }).join(', ');
      }
      if (res.undrawn && res.undrawn.length) c += ' · 未画 ' + res.undrawn.length + ' 条（' + res.undrawn.slice(0, 3).map(function (u) { return u.key; }).join(',') + '）';
      return c;
    }
    if (name === 'vl_restore_best') {
      if (res.error) return '失败';
      return '已回滚到第 ' + (res.round + 1) + ' 轮 · Chamfer ' + res.chamfer;
    }
    /* 收口这一步本身也要能当验收凭据，否则账本最后一行还是空的 */
    if (name === 'vl_finish') {
      return '已收口 · 已画 ' + (res.drawn || 0) + '/' + (res.strokes || 0)
        + (res.chamfer != null ? ' · Chamfer ' + res.chamfer + ' · 召回 ' + res.recall + ' / 精度 ' + res.precision : '');
    }
    return '';
  }
  function digestArgsOf(name, args) {
    if (name === 'vl_draw_parts' && args && Array.isArray(args.ops)) return args.ops.length + ' 条';
    if (name === 'vl_redraw_parts' && args && Array.isArray(args.ops)) {
      var n = 0;
      args.ops.forEach(function (o) { if (o && Array.isArray(o.points)) n += o.points.length; });
      return args.ops.length + ' 条 / ' + n + ' 控制点';
    }
    if (name === 'vl_name_parts' && args && args.keys) return args.keys.length + ' 个 key';
    if (name === 'vl_trace' && args) return JSON.stringify(args).slice(0, 40);
    return '';
  }

  function factsCard() {
    var lines = [];
    var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
    lines.push('<FACTS region="' + [r.x, r.y, r.w, r.h].join(',') + '" strokes="' + S.strokes.length +
      '" mode="' + S.lastMode + '"' +
      (S.autoStats ? ' auto="' + S.autoStats.pick + ' ratio ' + S.autoStats.ratio +
        ' 宽 ' + S.autoStats.w + ' 短边 ' + S.autoStats.short + '"' : '') + '>');
    S.strokes.slice(0, 30).forEach(function (p) {
      lines.push('  ' + p.key + ' ' + partName(p) + ' | 长 ' + Math.round(p.length) + ' | 宽 ' +
        round2(p.width) + ' | [' + p.bbox.map(function (v) { return Math.round(v); }).join(',') +
        '] | ' + p.anchors + '点 | ' + p.color);
    });
    if (S.metrics) {
      lines.push('  最近校验：Chamfer ' + S.metrics.chamfer + ' · 召回 ' + S.metrics.recall +
        ' · 精度 ' + S.metrics.precision + ' · 中位线宽 ' + S.metrics.medianWidth);
    }
    lines.push('  （位图只在前两轮随请求提供，之后按语义名与坐标工作，不要要求再看图。）');
    lines.push('  （系统事实，不是新指令；坐标只是标注。描绘：key + 控制点，用 vl_redraw_parts。）');
    lines.push('</FACTS>');
    return lines.join('\n');
  }

  var SYS = [
    '你是线稿重绘执行器。用户给你一组从位图提取出来的**线段中线**作为输入。',
    '这些线段只确定**分布**：哪里有东西、有多长、多粗、什么颜色。它们不是成品。',
    '你要做两件事：① 给每条线赋予语义；② 用自己给的控制点重绘精确曲线。',
    '',
    '## 硬规则',
    '1. 参考线只是输入。重绘一律用 vl_redraw_parts：{{RULE1}}',
    '2. {{RULE2}}',
    '3. 用户消息里附了框选区域的**位图**（等比缩小，和 strokes 同一坐标系）。先用它看懂画面是什么，再结合中线摘要定位几何。图里没有的东西不要编。',
    '4. 每条重绘的线都要给 name，**必须用中文**，格式是「主体·部位」：例如「企鹅·身体外轮廓」「企鹅·左翅」「字A·外框」。名字必须让人不看图也知道画的是什么；用英文命名、或用「左侧小环」这类纯几何叫法，都算失败。',
    '5. 程序负责坐标换算、{{FIT}}与落笔。你决定走向、线宽、颜色、顺序、语义。',
    '6. 每一步工具调用后都看返回值，失败了换参数，不要原样重试。',
    '7. vl_trace 会把已画的线全部作废。画布上已经有线时改参数会被拦截（返回 blocked）——那就先把图画完，不要反复重提取。一条线都没画时改口径同样会被拦截：先画，校验后再换。只有确认要推倒重来时才传 force:true；重提取后 key 会变，必须重新 vl_view_region 拿新 key。',
    '8. 第一次 vl_render_check 之前必须先把线画上去：画布空白时召回必然是 0，校验没有信息量。',
    '9. vl_redraw_parts 返回的 dev 是「你的控制点离参考线的中位距离（px）」。samples 是现成的，dev 正常应 < 0.5；超过 2 就说明你在猜，回去按 samples 传。',
    '10. 一次 vl_redraw_parts 最多 8 条，超过必须分多批调用（每批画完再画下一批）。把 ops 的 JSON 当成普通文本发出来不会被解析，等于一条都没画。',
    '11. vl_render_check 会返回 worst（逐条 miss / off，拖后腿的线）和 undrawn（还没画的线）。只看全局 Chamfer 就盲改是错的：先按 worst / undrawn 定位，再只改那几条。',
    '12. 每轮校验都会记下最好的一轮。指标变差时用 vl_restore_best 回滚，收口前也要确认当前不是比最好那轮更差。',
    '',
    '## 标准流程',
    '⓪ 先看图：一句话说清主体是什么（企鹅 / 字 / 人像 / 线稿），以及画面由哪几块组成。看错了后面全错。',
    '① vl_view_region 拿 samples → ② 逐条想语义名（主体·部位） → ③ {{FLOW}}',
    '④ vl_render_check',
    '⑤ Chamfer > 1.5 或召回 < 0.9：先判断是哪类线漏了/偏了（短碎段、细线、控制点太少），',
    '   用 vl_redraw_parts 补控制点重画，或用 vl_trace 换取线口径。仅当「几何已经对、只想改粗细颜色」才用 vl_draw_parts。',
    '⑥ 达标就 vl_finish。只要 Chamfer ≤ 1.5 且召回 ≥ 0.9，立刻收口，重画一遍不会更好。',
    '',
    '## 关于形态',
    '`auto`（默认）提取时按骨架长度 / 外接框周长与中位线宽自动选择下面两种，结果写在 FACTS 的 mode 与 auto 字段里；',
    '形态不需要你比较：先按当前参考线重绘，校验之后再决定要不要换口径（未画任何线时改动会被拦截）。',
    '`contour`（轮廓）给的是每个字形/图形的一圈闭合环，可能带内孔。它天生完整，',
    '不要把它拆成多段，也不要因为「这条线很长」就以为是错误。文字、实心笔画用这个。',
    '`center`（中线）给的是笔画骨架，交叉处会被切断，所以段数偏多、短段多；',
    '短段通常不是错误，是线的分叉与端点。',
    '`color`（色块，仅当取线源设为色块时）给的是**每个色块**的一圈外轮廓 + 内孔，颜色就是该块的平均色；',
    '填充按面积从大到小逐块盖上去。多色图标 / 插画用这个，不要按「暗线」口径去理解它——',
    '色块不是线，是面，不要试图给它们设线宽。',
    '色块模式按「部位」而不是「像素块」交付，顺序固定：vl_view_region → vl_group_parts（自动落笔）→ vl_redraw_parts（逐部位重画平滑曲线，每批 ≤8）→ vl_check_semantics → vl_finish。',
    '· 分组即落笔：几何已经是精确的区域边界，系统会自动复制，不需要再调 vl_draw_parts（draw:false 才需要手动画）。',
    '· 认部位看四项测量值：`tone`（白/黑/红/橙…）、`where`（上左/中中/下右）、`holes`（内孔数）、`area`（像素面积）。',
    '  眼白是「浅色 + 在头部 + 通常带 1 个孔（瞳孔）」；肚子里两侧的细长浅色条是描边残条，面积小又细长，不是眼睛。',
    '  面积只占几个百分点、形状是一条细带的块，先并进相邻部位或 drop，不要给它编一个独立部位名。',
    '· 分组：同一部位的碎块并成一组（围巾本体 + 阴影），给中文名「主体·部位」；',
    '  同级碎块各自填，只有整个套在另一块里面的成员才当孔洞挖掉（所以眼白 + 瞳孔要分成两组，不要并成一组）。',
    '· 组色默认**留空**：留空 = 沿用每块的实测原色，这是色彩还原的正确做法。',
    '  只有组内确实需要统一（同一色相被抗锯齿拆成几块）才给 color，且必须贴近实测色；',
    '  与实测差太远的组色会被程序拒收并在 colorFixed 里回报——不要靠改色去「修正」命名。',
    '· 丢弃：抗锯齿暗带、细窄残条、压缩噪点这类画出来只会是「混乱像素」的碎块，写进**顶层** `drop:[key,…]`（与 groups 平级）；',
    '  但眼睛、瞳孔、嘴、脚这类小件必须单独成组，不要当噪声丢掉，也不要并进身体。',
    '· 遮挡：先大后小（底板 → 身体 → 围巾/嘴/脚 → 眼睛 → 瞳孔），同一部位不要拆成多组。',
    '· 收口前必须调 vl_check_semantics：未分组块 0，duplicates 空，unnamed 0，colorFixed 空。',
    '  clash 只是提示：两块都大（占比 ≥1%）才需要拆开；细窄残条并进相邻部位看不出来，不必为它反复重分组。',
    '· 分组一次成型：除非 vl_check_semantics 报了 ungrouped / clash / colorFixed，否则不要再调 vl_group_parts 改名字。',
    '  名字错了但颜色和几何都对时，画面不会变；反复改名只烧轮次。',
    '分组落笔的是「区域边界」本身，像素台阶会原样保留，看起来就是歪歪扭扭的折线。',
    '所以分组之后必须用 vl_redraw_parts 按部位重画一遍：每个部位给 8~20 个控制点，',
    '按部位的整体形状画成平滑闭合曲线（身体是一圈、围巾是一条带），samples 只用来定位，不要逐像素照抄；',
    '一批最多 8 条，分多批画完。重画后旧指标作废，最后再 vl_render_check。',
  ].join('\n');

  /* 曲线形态的实验分组。auto=模型自选，bezier=B 组（模型给手柄），
   * poly=A 组对照（强制折线），fit=C 组（只给端点，手柄由程序最小二乘求）。 */
  var FORM_NOTES = {
    auto: [
      '## 两种重绘形态（自选）',
      '· 折线 `points`：折角多、短、细节线。',
      '· 贝塞尔 `form:"bezier"`：长而平滑的弧（头发外沿、衣褶、轮廓弧）。用 vl_view_region 给的 `breaks` 当段端点，',
      '  你只补每段的 `c1` / `c2` 手柄：手柄方向 = 该端点处的切线，长度不超过本段弦长的 0.85 倍（超过会被夹紧）。',
      '· 判断依据：看不出明显折角 → 贝塞尔；有明显尖角（字形、图标、直角）→ 折线。',
    ].join('\n'),
    bezier: [
      '## 本组固定：贝塞尔（B 组）',
      '所有线都用 `form:"bezier"`：`start` + `segs`（每段 `end` + `c1` / `c2`）。',
      '`breaks` 已经是切段建议，直接用；你只负责手柄的方向与长度（≤ 段弦长 0.85 倍）。不要用 `points`。',
    ].join('\n'),
    poly: [
      '## 本组固定：折线（A 组）',
      '所有线都用 `points` 折线（samples 原样回传），不要用 `form:"bezier"`。',
    ].join('\n'),
    fit: [
      '## 本组固定：程序拟合手柄（C 组）',
      '所有线都用 `form:"bezier"`，但你只给 `start` 与每段的 `end`（按 `breaks` 切段），**不要给 `c1` / `c2`**。',
      '手柄由程序用参考线做最小二乘求解；你只决定在哪切段、每条线是什么。',
    ].join('\n')
  };

  /* 分组时把「给几何」的口径整段换掉。真实运行暴露过：末尾的分组说明压不过开头的硬规则，
   * 模型 5 次重绘全部照旧传 points，一次 bezier 都没有。 */
  var GEOM = {
    auto: {
      rule1: 'key 指向参考线，points 是你给的控制点（3–128 个，相对区域 0–1000，与 samples 同口径）；长而平滑的弧也可以改用 form:"bezier" 给端点与手柄。',
      rule2: 'samples 是按形状抽稀好的轮廓顶点（最多 128 个），保形性已经验证过：直接把 samples 原样传回 points，不要删点、不要按角度重排、不要自己重算坐标。只有确实要改形状时才微调个别点。',
      fit: 'Catmull-Rom 拟合',
      flow: 'vl_redraw_parts（key + points + name + width + color + order）'
    },
    bezier: {
      rule1: '**必须**写 form:"bezier"，给 key + start + segs（每段 end 与 c1 / c2，坐标同样是 0–1000）；本组不要用 points。',
      rule2: 'breaks 是程序按目标段长（约 60px）切好的段端点，直接用，不要自己另选切点；你只决定每段手柄的方向与长度（长度 ≤ 本段弦长的 0.85 倍，超出会被夹紧）。',
      fit: '三次贝塞尔落笔',
      flow: 'vl_redraw_parts（key + form:"bezier" + start + segs + name + width + color + order）'
    },
    poly: {
      rule1: 'key + points（samples 原样回传）；本组不要用 form:"bezier"。',
      rule2: 'samples 是抽稀好的轮廓顶点，直接原样传回 points，不要删点、不要重排、不要重算坐标。',
      fit: 'Catmull-Rom 拟合',
      flow: 'vl_redraw_parts（key + points + name + width + color + order）'
    },
    fit: {
      rule1: '**必须**写 form:"bezier"，给 key + start + 每段 end（照 breaks 切段）；**不要给 c1 / c2**，也不要给 points。',
      rule2: 'breaks 是程序切好的段端点，直接用；手柄由程序按参考线做最小二乘求解，你只决定在哪切段、每条线是什么。',
      fit: '三次贝塞尔落笔（手柄由程序求）',
      flow: 'vl_redraw_parts（key + form:"bezier" + start + segs[只给 end] + name + width + color + order）'
    }
  };

  /* 工具描述也要跟着分组走：模型先读 description，口径不一致时它会按老的写 */
  var FORM_TOOL = {
    bezier: '精确重绘（本组固定贝塞尔）。必须写 form:"bezier"，给 start 与 segs[{end,c1,c2}]，坐标是相对区域 0–1000；不要传 points。手柄长度不超过本段弦长的 0.85 倍。',
    fit: '精确重绘（本组固定贝塞尔 + 程序拟合手柄）。必须写 form:"bezier"，给 start 与 segs[{end}]，不要给 c1 / c2、不要传 points；手柄由程序求解。',
    poly: '精确重绘（本组固定折线）。给 key + points（0–1000 控制点）+ name，不要用 form:"bezier"。'
  };

  function sysText() {
    var g = GEOM[S.form] || GEOM.auto;
    var base = SYS.replace('{{RULE1}}', g.rule1)
      .replace('{{RULE2}}', g.rule2)
      .replace('{{FIT}}', g.fit)
      .replace('{{FLOW}}', g.flow);
    return base + '\n\n' + (FORM_NOTES[S.form] || FORM_NOTES.auto);
  }

  function toolsFor(form) {
    if (!form || form === 'auto' || !FORM_TOOL[form]) return TOOLS;
    return TOOLS.map(function (t) {
      if (!t.function || t.function.name !== 'vl_redraw_parts') return t;
      var d = JSON.parse(JSON.stringify(t));
      d.function.description = FORM_TOOL[form];
      return d;
    });
  }

  /* ---------------- 界面 ---------------- */

  function note(text, warn) {
    var d = document.createElement('div');
    d.className = 'vl-say';
    if (warn) d.style.color = '#b4453a';
    d.textContent = text;
    R.sup.appendChild(d);
    R.sup.scrollTop = R.sup.scrollHeight;
    return d;
  }

  function setPhase(text, cls) {
    R.phase.textContent = text || '';
    R.phase.className = 'vl-phase' + (cls ? ' ' + cls : '');
  }

  function clearSup() {
    R.sup.innerHTML = '';
    R.metrics.hidden = true;
    R.round.textContent = '';
    S.calls = [];
  }

  function addToolCard(name, args) {
    var el = document.createElement('div');
    el.className = 'vl-tool';
    el.dataset.tool = name;
    el.innerHTML =
      '<div class="vl-tool-h"><span class="vl-tool-name">' + esc(name) + '</span>' +
      '<span class="vl-chip">执行中</span><span class="vl-tool-ms"></span></div>' +
      '<div class="vl-tool-a">' + esc(JSON.stringify(args || {}).slice(0, 220)) + '</div>' +
      '<div class="vl-tool-r" hidden></div>';
    R.sup.appendChild(el);
    R.sup.scrollTop = R.sup.scrollHeight;
    S.openCard = el;
    return el;
  }

  function fillToolCard(el, rec) {
    if (!el) return;
    var chip = el.querySelector('.vl-chip');
    var ms = el.querySelector('.vl-tool-ms');
    var box = el.querySelector('.vl-tool-r');
    if (ms) ms.textContent = (rec.ms || 0) + 'ms';
    if (chip) {
      chip.textContent = rec.error ? '失败' : 'ok';
      chip.className = 'vl-chip ' + (rec.error ? 'err' : 'ok');
    }
    if (box) {
      box.hidden = false;
      box.textContent = (rec.error ? ('错误：' + rec.error) : JSON.stringify(rec.result)).slice(0, 320);
    }
    R.sup.scrollTop = R.sup.scrollHeight;
  }

  function showMetrics(m) {
    if (!m) return;
    function cls(v, good, bad, reverse) {
      if (v == null) return '';
      if (reverse) return v <= good ? 'is-good' : (v >= bad ? 'is-bad' : 'is-warn');
      return v >= good ? 'is-good' : (v <= bad ? 'is-bad' : 'is-warn');
    }
    R.metrics.hidden = false;
    var note = [];
    if (m.bestChamfer != null && m.bestRound != null) {
      note.push('<span class="vl-tag is-good">最好 ' + m.bestChamfer + ' · 第 ' + (m.bestRound + 1) + ' 轮</span>');
    }
    if (m.noProgress) note.push('<span class="vl-tag is-bad">比最好那轮差 · 可回滚</span>');
    if (m.chamferP95 != null) note.push('<span class="vl-tag">P95 ' + m.chamferP95 + '</span>');
    if (m.drawn != null) note.push('<span class="vl-tag">已画 ' + m.drawn + '/' + m.total + '</span>');
    if (m.undrawn && m.undrawn.length) note.push('<span class="vl-tag is-warn">未画 ' + m.undrawn.length + '</span>');
    R.metrics.innerHTML =
      '<div class="vl-metric-grid">' +
        '<div class="vl-metric ' + cls(m.chamfer, 1.5, 3, true) + '"><b>' + (m.chamfer != null ? m.chamfer : '—') + '</b><span>Chamfer px</span></div>' +
        '<div class="vl-metric ' + cls(m.recall, 0.9, 0.7) + '"><b>' + (m.recall != null ? round3(m.recall) : '—') + '</b><span>召回</span></div>' +
        '<div class="vl-metric ' + cls(m.precision, 0.9, 0.7) + '"><b>' + (m.precision != null ? round3(m.precision) : '—') + '</b><span>精度</span></div>' +
        '<div class="vl-metric"><b>' + (m.medianWidth != null ? m.medianWidth : '—') + '</b><span>中位线宽</span></div>' +
      '</div>' +
      (note.length ? '<div class="vl-metric-note">' + note.join('') + '</div>' : '');
  }

  function renderParts() {
    if (!R.partsList) return;
    R.partsN.textContent = String(S.strokes.length);
    if (!S.strokes.length) {
      R.partsList.innerHTML = '<div class="vl-none">还没有线段。先载入图片并提取。</div>';
      R.legend.innerHTML = '';
      if (R.layers) { R.layers.hidden = true; R.layers.innerHTML = ''; }
      return;
    }
    /* 图层 = 语义组。组名、颜色、包含几块都列出来，点一行单独隐藏/显示，
     * 用来核对每个部位各自的形状，而不是只能看一张糊在一起的画。 */
    if (R.layers) {
      if (!S.layers.length) {
        R.layers.hidden = true; R.layers.innerHTML = '';
      } else {
        R.layers.hidden = false;
        R.layers.innerHTML = '<div class="vl-legend-t">图层</div>' + S.layers.map(function (l) {
          var off = !!S.hidden[l.id];
          return '<div class="vl-part' + (off ? ' is-off' : '') + '" data-layer="' + esc(l.id) + '">' +
            '<span class="vl-sw" style="background:' + esc(l.color) + '"></span>' +
            '<div class="vl-part-main"><div class="vl-part-name">' + esc(l.name) + '</div>' +
            '<div class="vl-part-meta"><span>' + l.keys.length + ' 块</span><span>' + (off ? '已隐藏' : '显示中') + '</span></div></div>' +
            '</div>';
        }).join('');
      }
    }
    R.partsList.innerHTML = S.strokes.map(function (p) {
      var src = p.source === 'user' ? '手改' : (p.source === 'model' ? '模型' : (p.source === 'llm' ? '模型' : '默认'));
      var drawn = S.ops.has(p.key);
      return '<div class="vl-part' + (p.key === S.activeKey ? ' is-on' : '') + '" data-key="' + esc(p.key) + '">' +
        '<span class="vl-sw" style="background:' + esc(p.color) + '"></span>' +
        '<div class="vl-part-main">' +
          '<input class="vl-name" data-name="' + esc(p.key) + '" value="' + esc(partName(p)) + '">' +
          '<div class="vl-part-meta"><span>长 ' + Math.round(p.length) + '</span><span>宽 ' + round2(p.width) +
          '</span><span>' + p.anchors + ' 锚点</span><span class="vl-src">' + src + '</span></div>' +
        '</div>' +
        '<span class="vl-state' + (drawn ? ' is-drawn' : '') + '">' + (drawn ? '已画' : '参考') + '</span>' +
        '</div>';
    }).join('');

    R.legend.innerHTML = '<div class="vl-legend-t">参考线</div>' + S.strokes.slice(0, 5).map(function (p) {
      return '<div class="vl-legend-row"><i style="background:' + esc(p.color) + '"></i>' +
        esc(partName(p)) + ' 长' + Math.round(p.length) + '</div>';
    }).join('');
  }

  function updateStat() {
    if (!R.stat) return;
    R.stat.textContent = S.img
      ? (S.imgName + ' · ' + S.w + '×' + S.h +
        (S.region ? (' · 区域 ' + Math.round(S.region.w) + '×' + Math.round(S.region.h)) : '') +
        (S.lastMode ? (' · ' + (S.lastMode === 'contour' ? '轮廓' : S.lastMode === 'dark' ? '中线·暗线' : '中线·边缘')) : '') +
        (S.strokes.length ? (' · 已描绘 ' + S.ops.size + '/' + S.strokes.length) : ''))
      : '未载入图像';
    if (R.dot) {
      R.dot.className = 'vl-dot' + (S.busy ? ' is-live' : (S.img ? ' is-ready' : ''));
    }
  }

  function setBusyUI(on) {
    var open = R.wrap.querySelector('[data-act="open"]');
    var run = R.wrap.querySelector('[data-act="run"]');
    var stop = R.wrap.querySelector('[data-act="stop"]');
    var ext = R.wrap.querySelector('[data-act="extract"]');
    if (open) open.disabled = on;
    if (run) run.disabled = on;
    if (ext) ext.disabled = on;
    if (stop) stop.disabled = !on;
  }

  function readOpts() {
    if (R.shape) S.opt.shape = R.shape.value;
    if (R.src) S.opt.src = R.src.value;
    if (R.threshold) S.opt.threshold = Number(R.threshold.value);
    if (R.simplify) S.opt.simplify = Number(R.simplify.value);
    if (R.minLen) S.opt.minLen = Number(R.minLen.value);
    if (R.fill) S.opt.fill = !!R.fill.checked;
    if (R.thresholdV) R.thresholdV.textContent = String(S.opt.threshold);
    if (R.simplifyV) R.simplifyV.textContent = String(S.opt.simplify);
    if (R.minLenV) R.minLenV.textContent = String(S.opt.minLen);
  }

  /* ---------------- 主流程 ---------------- */

  async function startRedraw(variantId) {
    if (S.busy) return;
    if (!S.img) { setPhase('先载入图片', 'is-err'); return; }
    if (!S.strokes.length) extractStrokes();

    var conn = null;
    try { conn = (typeof llmConn === 'function') ? llmConn() : null; } catch (e) { conn = null; }
    if (!conn && !S.stub) {
      setPhase('未配置语言模型', 'is-err');
      note('还没有可用的语言模型。去「设置」里填接口地址 / Key / 模型，或登录云端账号。', true);
      return;
    }

    readOpts();
    S.busy = true; S.ctrl = new AbortController(); S.variant = variantId || '';
    S.metrics = null; S.best = null;
    /* 每次运行从空白开始：画布上的实线只能是这一轮模型自己画的 */
    S.ops = new Map();
    drawScene();
    clearSup();
    setBusyUI(true);
    setPhase('思考中…', 'is-run');
    S.round = 0;
    R.round.textContent = '';
    switchTab('sup');

    var t0 = Date.now();
    var roundBubble = null;
    var res = null, err = null, review = '';
    /* 位图必须随第一条消息发出去：矢量只说明墨在哪，认出「企鹅」只能靠看图。 */
    var firstContent = [{
      type: 'text',
      text: '框选区域已提取 ' + S.strokes.length + ' 条参考线。附是该区域的原始位图（等比缩小，坐标与 strokes 一致）。先看清主体是什么，再逐条命名并重绘。'
    }];
    var shot = regionImageURL(768);
    if (shot) firstContent.push({ type: 'image_url', image_url: { url: shot } });
    try {
      res = await toolLoopRun({
        sys: sysText(),
        messages: [{ role: 'user', content: firstContent }],
        tools: toolsFor(S.form),
        maxRounds: 8,
        keepRounds: 2,
        /* 位图只在首两轮随请求发出：后面每轮都重发同一张图，输入费用按轮次线性涨 */
        stripImagesAfterRound: 2,
        app: 'visionlab',
        conn: conn,
        signal: S.ctrl.signal,
        executor: execTool,
        digest: digestOf,
        digestArgs: digestArgsOf,
        facts: factsCard,
        onDelta: function (acc, delta) {
          if (!roundBubble) {
            roundBubble = document.createElement('div');
            roundBubble.className = 'vl-say';
            R.sup.appendChild(roundBubble);
          }
          /* llmStreamRequest 的第一个参数是累计全文，第二个才是增量。
           * 以前按增量拼累计值，长回答会指数级膨胀。 */
          roundBubble.textContent = (typeof acc === 'string' && acc)
            ? acc
            : ((roundBubble.textContent || '') + (delta || ''));
          R.sup.scrollTop = R.sup.scrollHeight;
        },
        onRound: function (r) {
          S.round = r.round;
          R.round.textContent = r.phase === 'final' ? '收口轮'
            : ('第 ' + (r.round + 1) + ' 轮' + (r.maxRounds != null ? ' / ' + (r.maxRounds + 1) : ''));
          roundBubble = null;
          if (r.phase === 'request') setPhase('第 ' + (r.round + 1) + ' 轮：请求中', 'is-run');
          if (r.phase === 'tools') setPhase('第 ' + (r.round + 1) + ' 轮：执行工具', 'is-run');
        },
        onToolStart: function (c) { addToolCard(c.name, c.args); },
        onTool: function (rec) {
          S.calls.push({ name: rec.name, args: rec.args, ms: rec.ms, error: rec.error || '', result: rec.result });
          fillToolCard(S.openCard, rec);
        }
      });
      /* 模型 force 重提取把线全清了、又没来得及重画：最好一轮别丢（快照里是模型自己画的线） */
      if (!S.ops.size && S.best) {
        try {
          restoreBest();
          note('结束时画布为空，已自动回到最好一轮（Chamfer ' + (S.metrics ? S.metrics.chamfer : '?') + '）。');
        } catch (e4) {}
      }
      /* 模型最后一笔常常就是重绘；此时指标被清空，收口前补算一次，别让监督页停在「无指标」 */
      if (!S.metrics && S.ops.size) { try { renderCheck(); } catch (e2) {} }
      if (res && res.exhausted) note('达到工具轮次上限，已强制收口。');
      if (res && res.text) note(String(res.text));
      if (res && res.requests) {
        /* 字符数不是 token：各家中转口径不同，只有「相对大小」是可靠的。
         * 中文约 1.5 字/token、JSON 坐标约 3 字/token，这里按 2.5 粗估。 */
        note('本次 ' + res.requests + ' 次请求，上下文合计 ' + fmtK(res.ctxChars) +
          ' 字符（≈' + fmtK(Math.round((res.ctxChars || 0) / 2.5)) + ' tokens，粗估）。');
      }
      review = await askReview(res, conn);
    } catch (e) {
      err = e;
      var msg = String((e && e.message) || e);
      if (/abort|停止/i.test(msg) && S.ctrl && S.ctrl.signal.aborted) {
        setPhase('已停止', 'is-err');
        note('已停止。');
      } else {
        /* 与正常结束同一口径：画布被清空时先回滚最好一轮，再判断是否收口 */
        if (!S.ops.size && S.best) { try { restoreBest(); } catch (e5) {} }
        if (!S.metrics && S.ops.size) { try { renderCheck(); } catch (e3) {} }
        if (S.calls.length && S.metrics) {
          setPhase('已收口 · Chamfer ' + S.metrics.chamfer, 'is-run');
          note('模型最后一轮没有给出结论（' + msg + '），已按当前描绘结果收口。');
          err = null;
        } else {
          setPhase('出错', 'is-err');
          note('出错：' + msg, true);
        }
      }
    } finally {
      S.busy = false; S.ctrl = null;
      setBusyUI(false);
      if (!err) setPhase(S.metrics ? ('完成 · Chamfer ' + S.metrics.chamfer) : '完成', 'is-run');

      S.runs.unshift({
        ts: new Date().toISOString(),
        variant: variantId || '手控',
        params: Object.assign({}, S.opt),
        mode: S.lastMode,
        strokes: S.strokes.length,
        rounds: res ? res.rounds : S.round,
        calls: (res && res.calls) ? res.calls.length : S.calls.length,
        chamfer: S.metrics ? S.metrics.chamfer : null,
        recall: S.metrics ? S.metrics.recall : null,
        precision: S.metrics ? S.metrics.precision : null,
        width: S.metrics ? S.metrics.medianWidth : null,
        ms: Date.now() - t0,
        requests: res && res.requests != null ? res.requests : null,
        ctxChars: res && res.ctxChars != null ? res.ctxChars : null,
        review: review || '',
        error: err ? String((err && err.message) || err) : ''
      });
      if (S.runs.length > 30) S.runs.pop();
      saveRuns(); renderRuns(); renderParts(); drawScene();
    }
  }

  /* 跑完复盘：循环内的上下文只有最近两轮原文，所以退出后单独发一条请求
   * （只挂一个 vl_review 工具），输入是这一轮的压缩账本 + 失败记录 + 最终指标，
   * 让它以使用者身份指出工具哪里难用。用 ledger 而不是回放全量消息，成本只有几百 token。 */
  async function askReview(res, conn) {
    if (S.stub || !res || !res.calls || !res.calls.length) return '';
    var mem = res.memory || {};
    var m = S.metrics;
    var fact = m
      ? ('Chamfer ' + m.chamfer + ' / 召回 ' + m.recall + ' / 精度 ' + m.precision + ' / 中位线宽 ' + m.medianWidth)
      : '未校验';
    var ask = [
      '这一轮重绘已经结束。下面是你刚才的调用账本与最终指标，不要继续画。',
      '<WORK_LOG>', (mem.ledger || []).join('\n') || '(空)', '</WORK_LOG>',
      '<REJECTED>', (mem.negatives || []).join('\n') || '(无)', '</REJECTED>',
      '曲线口径：' + S.form + '；参考线 ' + S.strokes.length + ' 条，已描绘 ' + S.ops.size + ' 条；最终 ' + fact + '。',
      '',
      '请以「刚用过这套工具的人」的身份复盘，只通过 vl_review 工具提交，不要写正文：',
      'friction 至少 2 条，每条要引用账本里的具体数字或返回字段；missing 写最缺的一个能力；keep 写最该保留的一条设定。'
    ].join('\n');
    /* 复盘也走工具调用：这台中转在「自由续写」上会退化成逐字加长的重复
     * （实测把「最难用的一步：」重复了上千次，输出 600KB），而工具参数没出现过这个问题。 */
    var tool = {
      type: 'function',
      function: {
        name: 'vl_review',
        description: '提交本轮工具使用的复盘',
        parameters: {
          type: 'object',
          properties: {
            friction: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string', description: '工具名或指令条目' },
                  what: { type: 'string', description: '哪里难用 / 哪里自相矛盾' },
                  evidence: { type: 'string', description: '账本里的具体数字或返回字段' },
                  fix: { type: 'string', description: '具体改法' }
                },
                required: ['tool', 'what', 'fix']
              }
            },
            missing: { type: 'string', description: '最缺的一个能力' },
            keep: { type: 'string', description: '最该保留的一条设定' }
          },
          required: ['friction', 'missing', 'keep']
        }
      }
    };
    var out = null;
    try {
      out = await llmStreamRequest('', [{ role: 'user', content: ask }], function () {},
        { conn: conn, app: 'visionlab', tools: [tool] });
    } catch (e) { return ''; }
    var calls = (out && Array.isArray(out.toolCalls)) ? out.toolCalls : [];
    if (!calls.length) return '';
    var args = null;
    try { args = JSON.parse(calls[0].function.arguments || '{}'); } catch (e) { args = null; }
    if (!args) return '';
    var txt = JSON.stringify(args);
    S.lastReview = txt;
    note('【模型复盘】' + txt);
    return txt;
  }

  function stopRun() { if (S.ctrl) S.ctrl.abort(); }

  /* ---------------- 实验 ---------------- */

  var VARIANTS = [
    { id: 'A', name: 'A 轮廓基线', desc: '轮廓模式（每字一圈闭合环），抽稀 0.5。文字 / 实心笔画首选。', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } },
    { id: 'B', name: 'B 轮廓强抽稀', desc: '轮廓 + 抽稀 1.8：锚点少、折角明显。检验可读性的锚点下限。', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 1.8, minLen: 8 } },
    { id: 'C', name: 'C 轮廓弱抽稀', desc: '轮廓 + 抽稀 0.3：锚点多、最贴边。与 B 形成锚点预算对照。', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.3, minLen: 8 } },
    { id: 'D', name: 'D 中线基线', desc: '中线 + 线宽，阈值 20、抽稀 0.8。单线手绘 / 线稿用它。', opt: { shape: 'center', src: 'auto', threshold: 20, simplify: 0.8, minLen: 8 } },
    { id: 'E', name: 'E 中线低阈值', desc: '中线 + 阈值 12，抓更多淡线。检验召回与碎段数量的取舍。', opt: { shape: 'center', src: 'auto', threshold: 12, simplify: 0.8, minLen: 8 } },
    { id: 'F', name: 'F 中线强抽稀', desc: '中线 + 抽稀 1.8，锚点少。检验几何精度下限与 Chamfer 的关系。', opt: { shape: 'center', src: 'auto', threshold: 20, simplify: 1.8, minLen: 8 } },
    { id: 'G', name: 'G 贝塞尔（B 组）', desc: '强制 form:bezier：模型给端点与手柄，程序直接落三次贝塞尔。对照曲线表示法。', form: 'bezier', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } },
    { id: 'H', name: 'H 折线（A 组）', desc: '强制 points 折线 + Catmull-Rom。与 G 同图同参，只差曲线表示法。', form: 'poly', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } },
    { id: 'I', name: 'I 程序拟合手柄（C 组）', desc: '模型只给端点（按 breaks 切段），手柄由程序最小二乘求。用来分离「模型判断」与「程序拟合」。', form: 'fit', opt: { shape: 'contour', src: 'auto', threshold: 20, simplify: 0.5, minLen: 8 } }
  ];

  function applyVariant(v) {
    S.form = v.form || 'auto';
    Object.keys(v.opt).forEach(function (k) { S.opt[k] = v.opt[k]; });
    if (R.shape) R.shape.value = S.opt.shape;
    if (R.src) R.src.value = S.opt.src;
    if (R.threshold) R.threshold.value = String(S.opt.threshold);
    if (R.simplify) R.simplify.value = String(S.opt.simplify);
    if (R.minLen) R.minLen.value = String(S.opt.minLen);
    readOpts();
    extractStrokes();
  }

  function renderVariants() {
    if (!R.variants) return;
    R.variants.innerHTML = VARIANTS.map(function (v, i) {
      return '<div class="vl-variant">' +
        '<span class="vl-variant-no">' + (i + 1) + '</span>' +
        '<div class="vl-variant-body"><div class="vl-variant-t">' + esc(v.name) + '</div>' +
        '<div class="vl-variant-d">' + esc(v.desc) + '</div></div>' +
        '<button type="button" class="vl-btn" data-variant="' + v.id + '">跑</button></div>';
    }).join('');
  }

  async function runVariant(id) {
    var v = VARIANTS.filter(function (x) { return x.id === id; })[0];
    if (!v) return;
    if (!S.img) { setPhase('先载入图片', 'is-err'); switchTab('sup'); return; }
    applyVariant(v);
    await startRedraw(v.id);
  }

  function renderRuns() {
    if (!R.runs) return;
    if (!S.runs.length) {
      R.runs.innerHTML = '<div class="vl-none">还没有记录。跑一次重绘后这里会出现指标。</div>';
      return;
    }
    R.runs.innerHTML = '<div class="vl-runs-h"><span>方案</span><span>时间 / 调用 / 上下文</span><span>Chamfer</span></div>' +
      S.runs.map(function (r) {
        var t = String(r.ts || '').slice(11, 19);
        var ctx = r.ctxChars ? ' / ≈' + fmtK(Math.round(r.ctxChars / 2.5)) + 't' : '';
        return '<div class="vl-run"><b>' + esc(r.variant) + '</b><span>' + t + ' · ' + r.strokes + '段/' + r.calls + '调用' + ctx + '</span>' +
          '<span class="vl-run-ch">' + (r.chamfer == null ? '—' : r.chamfer) + '</span></div>';
      }).join('');
  }

  function saveRuns() {
    if (/[?&]nostore=1/.test(location.search)) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S.runs.slice(0, 30))); } catch (e) {}
  }
  function loadRuns() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) S.runs = JSON.parse(raw) || [];
    } catch (e) { S.runs = []; }
  }

  function exportRun() {
    var data = {
      tool: 'visionlab',
      kind: 'line',
      at: new Date().toISOString(),
      image: { name: S.imgName, w: S.w, h: S.h },
      region: S.region,
      params: S.opt,
      mode: S.lastMode,
      strokes: S.strokes.map(strokeBrief),
      metrics: S.metrics,
      runs: S.runs
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'visionlab-line-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    note('已导出运行记录 JSON。');
  }

  /* ---------------- 交互 ---------------- */

  function switchTab(name) {
    R.wrap.querySelectorAll('.vl-tab').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.tab === name);
    });
    R.wrap.querySelectorAll('.vl-pane').forEach(function (p) {
      p.hidden = p.dataset.pane !== name;
    });
  }

  function bindCanvas() {
    CV.addEventListener('pointerdown', function (ev) {
      if (!S.img || S.busy) return;
      CV.setPointerCapture(ev.pointerId);
      var cp = canvasPt(ev);
      if (ev.shiftKey || ev.button === 1) {
        S.drag = { mode: 'pan', x: cp[0], y: cp[1], ox: S.view.ox, oy: S.view.oy };
        return;
      }
      if (ev.button !== 0) return;
      var ip = toImg(cp[0], cp[1]);
      if (S.ckpt) {
        /* 控制点模式：优先抓最近的控制点，抓空了不重提取（避免误把选区清掉） */
        var hit = nearestAnchor(ip);
        if (hit) { S.drag = { mode: 'ckpt', key: hit.key, idx: hit.idx, moved: false }; return; }
        return;
      }
      S.drag = { mode: 'rect', x0: clamp(ip[0], 0, S.w), y0: clamp(ip[1], 0, S.h), rect: null };
      drawScene();
    });

    CV.addEventListener('pointermove', function (ev) {
      if (!S.drag) return;
      var cp = canvasPt(ev);
      if (S.drag.mode === 'pan') {
        S.view.ox = S.drag.ox + (cp[0] - S.drag.x);
        S.view.oy = S.drag.oy + (cp[1] - S.drag.y);
        drawScene();
        return;
      }
      var ip = toImg(cp[0], cp[1]);
      if (S.drag.mode === 'ckpt') {
        var part = S.strokes.filter(function (q) { return q.key === S.drag.key; })[0];
        if (part && part.path[S.drag.idx]) {
          part.path[S.drag.idx] = [clamp(ip[0], 0, S.w), clamp(ip[1], 0, S.h)];
          part.bbox = bboxOfPath(part.path);
          if (part.region) part.bez = fitBezLoop(part.path, part.tol || 2);
          S.drag.moved = true;
          drawScene();
        }
        return;
      }
      var x0 = S.drag.x0, y0 = S.drag.y0;
      var x1 = clamp(ip[0], 0, S.w), y1 = clamp(ip[1], 0, S.h);
      S.drag.rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      drawScene();
    });

    CV.addEventListener('pointerup', function () {
      if (!S.drag) return;
      var d = S.drag;
      S.drag = null;
      if (d.mode === 'ckpt') {
        if (d.moved) {
          /* 几何改了，旧指标就不再对应这张图，先清掉等下一次回读 */
          S.metrics = null; S.best = null;
          R.metrics.hidden = true;
          renderParts();
          note('控制点已调整。点「回读校验」或「监督重绘」再量一次 Chamfer。');
        }
        drawScene();
        return;
      }
      if (d.mode === 'rect' && d.rect && d.rect.w >= 6 && d.rect.h >= 6) {
        S.region = {
          x: Math.round(d.rect.x), y: Math.round(d.rect.y),
          w: Math.round(d.rect.w), h: Math.round(d.rect.h)
        };
        updateStat();
        extractStrokes();
      }
      drawScene();
    });

    CV.addEventListener('wheel', function (ev) {
      if (!S.img) return;
      ev.preventDefault();
      var cp = canvasPt(ev);
      var before = toImg(cp[0], cp[1]);
      var k = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      S.view.s = clamp(S.view.s * k, 0.05, 12);
      S.view.ox = cp[0] - before[0] * S.view.s;
      S.view.oy = cp[1] - before[1] * S.view.s;
      S.zoomed = true;
      drawScene();
    }, { passive: false });
  }

  function bindStage() {
    R.stage.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    R.stage.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) loadFile(f).catch(function (e) { note(e.message, true); });
    });
    document.addEventListener('paste', function (ev) {
      if (R.wrap.offsetParent === null) return;
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { loadFile(f).catch(function (e) { note(e.message, true); }); ev.preventDefault(); }
          break;
        }
      }
    });
  }

  function bindUI() {
    R.wrap.addEventListener('click', function (ev) {
      var act = ev.target.closest('[data-act]');
      if (act) {
        var a = act.dataset.act;
        if (a === 'open') R.file.click();
        else if (a === 'only') {
          S.onlyDraw = !S.onlyDraw;
          act.classList.toggle('is-on', S.onlyDraw);
          drawScene();
        }
        else if (a === 'ckpt') {
          /* 控制点模式：画布上的锚点可以直接拖，拖完几何就是新的。
           * 和「框选提取」冲突，所以做成互斥的开关，而不是常驻。 */
          S.ckpt = !S.ckpt;
          act.classList.toggle('is-on', S.ckpt);
          drawScene();
          note(S.ckpt ? '控制点模式：拖动圆点即可改曲线，改动只影响几何。'
            : '已退出控制点模式。');
        }
        else if (a === 'extract') extractStrokes();
        else if (a === 'reset') {
          /* 清空描绘：把画布还给「参考线」，不替模型补画 */
          S.ops = new Map();
          S.metrics = null; S.best = null; R.metrics.hidden = true;
          drawScene(); renderParts(); updateStat();
          note('已清空描绘。画布上剩下的淡虚线只是参考，不是成品。');
        } else if (a === 'run') startRedraw('');
        else if (a === 'stop') stopRun();
        else if (a === 'export') exportRun();
        return;
      }
      var tab = ev.target.closest('.vl-tab');
      if (tab) { switchTab(tab.dataset.tab); return; }
      var vbtn = ev.target.closest('[data-variant]');
      if (vbtn) { runVariant(vbtn.dataset.variant); return; }
      var part = ev.target.closest('.vl-part');
      if (part && !ev.target.closest('.vl-name')) {
        S.activeKey = S.activeKey === part.dataset.key ? '' : part.dataset.key;
        renderParts(); drawScene();
      }
    });

    R.file.addEventListener('change', function () {
      var f = R.file.files && R.file.files[0];
      if (f) loadFile(f).catch(function (e) { note(e.message, true); });
      R.file.value = '';
    });

    R.partsList.addEventListener('change', function (ev) {
      var inp = ev.target.closest('[data-name]');
      if (!inp) return;
      var key = inp.dataset.name;
      var val = inp.value.trim();
      if (!val) return;
      setLex(key, val, '', 'user', 1);
      renderParts();
    });

    if (R.layers) {
      R.layers.addEventListener('click', function (ev) {
        var row = ev.target.closest('[data-layer]');
        if (!row) return;
        var id = row.dataset.layer;
        S.hidden[id] = !S.hidden[id];
        renderParts(); drawScene();
      });
    }

    ['threshold', 'simplify', 'minLen'].forEach(function (k) {
      var el = R[k];
      if (!el) return;
      el.addEventListener('input', function () { readOpts(); });
      el.addEventListener('change', function () { readOpts(); if (S.img) extractStrokes(); });
    });
    if (R.src) R.src.addEventListener('change', function () { readOpts(); if (S.img) extractStrokes(); });
    if (R.shape) R.shape.addEventListener('change', function () { readOpts(); if (S.img) extractStrokes(); });
    if (R.fill) R.fill.addEventListener('change', function () {
      readOpts(); drawScene();
      /* 填色改变「画出来的面积」，指标要跟着重算，否则监督页停在旧口径 */
      if (S.ops.size) renderCheck();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(syncStage).observe(R.stage);
    } else {
      window.addEventListener('resize', syncStage);
    }
  }

  /* ---------------- 注册 ---------------- */

  registerApp({
    id: 'visionlab',
    name: '线稿重绘台',
    title: '线稿重绘台 · 中线 + 线宽',
    sub: '从位图提中线与线宽，监督模型重新描绘线稿并回读 Chamfer',
    order: 95,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 17c4-1 5-9 9-9s5 8 9 7"/><path d="M3 12h3M18 12h3"/>' +
      '<circle cx="7" cy="6" r="1.2"/><circle cx="17" cy="6" r="1.2"/></svg>',
    css: ['apps/visionlab/app.css'],
    body: window.VL_BODY,

    mount: function (body) {
      R.wrap = body.querySelector('.vl-wrap');
      ['stage', 'canvas', 'empty', 'legend', 'stat', 'dot', 'file', 'partsList', 'partsN', 'layers',
        'phase', 'round', 'metrics', 'sup', 'variants', 'runs',
        'shape', 'src', 'threshold', 'thresholdV', 'simplify', 'simplifyV', 'minLen', 'minLenV', 'fill'
      ].forEach(function (k) { R[k] = body.querySelector('[data-ref="' + k + '"]'); });

      CV = R.canvas;
      CTX = CV.getContext('2d');
      S.ready = true;

      if (body.dataset.ready === '1') {
        resizeCanvas(); fitView(); drawScene(); renderParts(); updateStat();
        return;
      }
      body.dataset.ready = '1';

      loadRuns();
      renderVariants();
      renderRuns();
      readOpts();
      resizeCanvas();
      bindCanvas();
      bindStage();
      bindUI();
      drawScene();
      setPhase('待命', '');
    }
  });

  /* ---------------- 测试钩子 ---------------- */

  window.vlLab = {
    __debug: function () {
      return {
        ready: S.ready,
        visible: !!(R.wrap && R.wrap.offsetParent !== null),
        image: !!S.img,
        w: S.w, h: S.h,
        view: { s: S.view.s, ox: S.view.ox, oy: S.view.oy },
        ckpt: S.ckpt,
        region: S.region,
        strokes: S.strokes.length,
        mode: S.lastMode,
        auto: S.autoStats || null,
        drawn: sortedOps().length,
        metrics: S.metrics,
        runs: S.runs.length,
        calls: S.calls.length,
        busy: S.busy,
        stub: S.stub,
        opts: Object.assign({}, S.opt)
      };
    },
    __test: {
      loadDemo: function () { return loadDemo(); },
      loadFile: function (f) { return loadFile(f); },
      loadDataURL: function (url) {
        return new Promise(function (res, rej) {
          var img = new Image();
          img.onload = function () { setImage(img, 'pasted'); res(true); };
          img.onerror = function () { rej(new Error('图片解码失败')); };
          img.src = url;
        });
      },
      setOnly: function (v) { S.onlyDraw = !!v; drawScene(); return S.onlyDraw; },
      setOpt: function (o) {
        Object.keys(o || {}).forEach(function (k) { if (k in S.opt) S.opt[k] = o[k]; });
        /* 先写 DOM 再读回来：readOpts 会从控件取值，反过来会把刚设的值盖掉 */
        if (R.shape) R.shape.value = S.opt.shape;
        if (R.src) R.src.value = S.opt.src;
        if (R.threshold) R.threshold.value = String(S.opt.threshold);
        if (R.simplify) R.simplify.value = String(S.opt.simplify);
        if (R.minLen) R.minLen.value = String(S.opt.minLen);
        if (R.fill) R.fill.checked = !!S.opt.fill;
        readOpts();
        return Object.assign({}, S.opt);
      },
      setRegion: function (r) { S.region = r; updateStat(); return extractStrokes(); },
      extract: function () { return extractStrokes(); },
      autoDraw: function () {
        return drawStrokes({
          ops: S.strokes.map(function (p, i) {
            return { key: p.key, width: p.width, color: p.color, order: i };
          })
        });
      },
      bez: function (key) {
        var p = S.strokes.filter(function (x) { return x.key === key; })[0];
        if (!p) return null;
        return { tol: p.tol, segs: (p.bez || []).length, holeSegs: (p.holeBez || []).map(function (a) { return a.length; }),
          first: (p.bez || [])[0] };
      },
      check: function () { return renderCheck(); },
      parts: function () { return S.strokes.map(strokeBrief); },
      path: function (key) {
        var p = S.strokes.filter(function (x) { return x.key === key; })[0]
          || S.strokes.filter(function (x) { return x.key === S.activeKey; })[0]
          || S.strokes[0];
        if (!p) return null;
        var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
        return {
          key: p.key, points: p.path.length, anchors: p.anchors,
          closed: !!p.closed, source: p.source, redrawn: !!p.redrawn,
          bbox: p.bbox, width: p.width, name: partName(p),
          /* 与 vl_view_region 同口径：相对区域 0–1000 */
          samples: controlSamples(p.path, p.closed, sampleCount(p)).map(function (q) {
            return [Math.round((q[0] - r.x) / Math.max(1, r.w) * 1000),
              Math.round((q[1] - r.y) / Math.max(1, r.h) * 1000)];
          }),
          head: p.path.slice(0, 3),
          form: p.form || '',
          breaks: (function () {
            var bk = bezierBreaks(p.path, p.closed, 16);
            return bk ? { segs: bk.segs, points: bk.breaks.map(normPx) } : null;
          })()
        };
      },
      setForm: function (f) { S.form = FORM_NOTES[f] ? f : 'auto'; return S.form; },
      /* 探针用它验证：分组提示词里不能残留 {{...}} 占位符 */
      sys: function () { return sysText(); },
      tools: function (f) { return toolsFor(f || S.form); },
      lastReview: function () { return S.lastReview || ''; },
      best: function () { return S.best ? { round: S.best.round, chamfer: S.best.m.chamfer } : null; },
      restoreBest: function () { return restoreBest(); },
      region: function () { return S.region; },
      raw: function (key) {
        var p = S.strokes.filter(function (x) { return x.key === key; })[0] || S.strokes[0];
        return p ? { key: p.key, closed: !!p.closed, width: p.width, path: p.path } : null;
      },
      redraw: function (args) { return redrawParts(args); },
      ops: function () { return sortedOps().map(function (it) { return { key: it.part.key, op: it.op }; }); },
      variant: function (id) { return runVariant(id); },
      calls: function () {
        return S.calls.map(function (c) { return { name: c.name, args: c.args, ms: c.ms, error: c.error || '', result: c.result }; });
      },
      run: function () { return startRedraw(''); },
      tool: function (name, args) { return execTool(name, args || {}); },
      group: function (args) { return groupParts(args); },
      semantics: function () { return semanticCheck(); },
      groups: function () { return S.groups.map(function (g) { return { name: g.name, keys: g.keys.slice(), color: g.color }; }); },
      /* 直接采样栅格化结果（与指标同口径），不受画布缩放/底图影响 */
      sampleDraw: function (x, y) {
        var r = S.region || { x: 0, y: 0, w: S.w, h: S.h };
        var W = Math.max(1, Math.round(r.w)), H = Math.max(1, Math.round(r.h));
        var d = rasterizeDrawn(W, H, 1).data;
        var px = Math.round(x), py = Math.round(y);
        if (px < 0 || py < 0 || px >= W || py >= H) return '';
        var i = (py * W + px) * 4;
        return hexOf([d[i], d[i + 1], d[i + 2]]);
      },
      /* 采样画布上的最终像素（区域坐标），用来断言「这一块最后是什么颜色」 */
      sample: function (x, y) {
        var dpr = window.devicePixelRatio || 1;
        var cx = Math.round((x * S.view.s + S.view.ox) * dpr);
        var cy = Math.round((y * S.view.s + S.view.oy) * dpr);
        var d = CTX.getImageData(cx, cy, 1, 1).data;
        return hexOf([d[0], d[1], d[2]]);
      },
      name: function (keys) { return nameUnknown(keys || []); },
      viewImage: function (maxSide) { return regionImageURL(maxSide); },
      lastUserParts: function () {
        var m = S.stubMsgs && S.stubMsgs[0];
        if (!m || !Array.isArray(m.content)) return [];
        return m.content.map(function (p) { return p && p.type; });
      },
      firstUserParts: function () {
        var m = S.stubFirst && S.stubFirst[0];
        if (!m || !Array.isArray(m.content)) return [];
        return m.content.map(function (p) { return p && p.type; });
      },
      stubLLM: function (script) {
        S.stub = true;
        S.stubFirst = null;
        var i = 0;
        if (!savedLLM) savedLLM = window.llmStreamRequest;
        window.llmStreamRequest = async function (sys, msgs) {
          S.stubMsgs = msgs;
          if (!S.stubFirst) S.stubFirst = msgs;
          var step = script[i++];
          if (!step || step.finish) return { text: '（测试桩：完成）', toolCalls: [] };
          return {
            text: '',
            toolCalls: [{
              id: 'stub-' + i, type: 'function',
              function: { name: step.tool, arguments: JSON.stringify(step.args || {}) }
            }]
          };
        };
        return true;
      },
      restoreLLM: function () {
        S.stub = false;
        if (savedLLM) { window.llmStreamRequest = savedLLM; savedLLM = null; }
      },
      reset: function () {
        S.ops = new Map();
        S.strokes = []; S.region = null; S.metrics = null; S.best = null; S.img = null;
        S.runs = []; S.calls = []; S.lastMode = '';
        S.groups = []; S.drop = {};
        if (R.empty) R.empty.hidden = false;
        renderParts(); drawScene(); updateStat();
      }
    }
  };
})();
