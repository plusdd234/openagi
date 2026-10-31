/* 原画分区：SVG 闭合曲线 → 带标签的闭合曲面（2D 控制的地基）
 *
 * 为什么要从 2D 闭合轮廓开始，而不是继续堆 3D 基础体：
 *   原画本身就是「分区 + 轮廓」——头发是一块、裙摆是一块、靴筒是一块。
 *   在 2D 上把每块圈出来并打标签，位置/宽窄/比例都能对着图直接改（改数字或拖点），
 *   比在 3D 里凭感觉放球体精确得多；而且同一份轮廓后面可以挤出、放样、旋转成体。
 *
 * 约定：
 *   ① 只认**闭合**路径（带 Z / z，或首尾点重合）。开口路径直接报错并指出是哪个 id ——
 *      开口轮廓三角化出来是破面，静默放过等于给用户一个看起来正常的坏模型。
 *   ② 坐标系统一：SVG 用 viewBox 坐标，落到 3D 时按 height 把「整张图的高度」映射成米数，
 *      平面躺在 XZ 上（y=0），这样后续挤出是沿 +Y 长，和「站在地上」的直觉一致。
 *   ③ **标签**：优先取路径上的 data-label，其次 data-name，再次 id；也可以在 labels 参数里
 *      覆盖（{id: {label, color}}）。标签是后面「按部位做 2D 控制」的唯一入口。
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SAMPLE_STEP = 2;      // 采样步长（viewBox 单位），越小轮廓越贴，三角面也越多

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  /* 从 path 的 d 里数子路径并判断是否闭合（DOM 拿不到，只能看指令） */
  function closedFlags(d) {
    var subs = String(d || '').split(/(?=[Mm])/).filter(function (s) { return s.trim(); });
    return subs.map(function (s) {
      var closed = /[Zz]\s*$/.test(s.trim());
      /* 首尾坐标相同但没有 Z：也算闭合（Illustrator 导出常见） */
      if (!closed) {
        var nums = (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
        if (nums.length >= 6) {
          var n = nums.length;
          closed = Math.abs(nums[0] - nums[n - 2]) < 0.01 && Math.abs(nums[1] - nums[n - 1]) < 0.01;
        }
      }
      return closed;
    });
  }

  function parse(svgText, labels) {
    var errors = [], warnings = [], regions = [];
    var text = String(svgText || '').trim();
    if (!text) return { ok: false, errors: ['SVG 为空'], warnings: warnings, regions: regions };

    var doc;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); }
    catch (e) { return { ok: false, errors: ['SVG 解析失败：' + (e && e.message)], warnings: warnings, regions: regions }; }
    var root = doc.documentElement;
    if (!root || root.nodeName === 'parsererror' || doc.querySelector('parsererror')) {
      return { ok: false, errors: ['SVG 不是合法 XML（检查有没有未闭合的标签 / 多余的 & ）'], warnings: warnings, regions: regions };
    }
    var vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    var vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : num(root.getAttribute('width'), 0);
    var vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : num(root.getAttribute('height'), 0);
    if (!vbW || !vbH) { vbW = 1000; vbH = 1000; warnings.push('SVG 没有 viewBox/宽高，按 1000×1000 处理'); }

    var nodes = root.querySelectorAll('path, polygon, polyline, rect, circle, ellipse');
    if (!nodes.length) errors.push('SVG 里没有可用的图形（path / polygon / rect / circle…）');

    Array.prototype.forEach.call(nodes, function (el, i) {
      var tag = el.nodeName.toLowerCase();
      var id = el.getAttribute('id') || (tag + '_' + (i + 1));
      var d = '';
      if (tag === 'path') d = el.getAttribute('d') || '';
      else if (tag === 'polygon' || tag === 'polyline') {
        var pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/);
        var pairs = [];
        for (var k = 0; k + 1 < pts.length; k += 2) pairs.push(pts[k] + ',' + pts[k + 1]);
        d = 'M' + pairs.join(' L') + (tag === 'polygon' ? ' Z' : '');
      } else {
        /* 基本图形转成等价 path，后面统一按 path 采样 */
        var x = num(el.getAttribute('x'), 0), y = num(el.getAttribute('y'), 0);
        var w = num(el.getAttribute('width'), 0), h = num(el.getAttribute('height'), 0);
        var cx = num(el.getAttribute('cx'), 0), cy = num(el.getAttribute('cy'), 0);
        var rx = num(el.getAttribute('r'), num(el.getAttribute('rx'), 0));
        var ry = num(el.getAttribute('r'), num(el.getAttribute('ry'), 0));
        if (tag === 'rect') d = 'M' + x + ',' + y + ' H' + (x + w) + ' V' + (y + h) + ' H' + x + ' Z';
        else if (tag === 'circle' || tag === 'ellipse') {
          d = 'M' + (cx - rx) + ',' + cy +
            ' A' + rx + ',' + ry + ' 0 1,0 ' + (cx + rx) + ',' + cy +
            ' A' + rx + ',' + ry + ' 0 1,0 ' + (cx - rx) + ',' + cy + ' Z';
        } else {
          warnings.push(id + '：' + tag + ' 暂不支持，已跳过');
          return;
        }
      }
      if (!d.trim()) { warnings.push(id + '：没有路径数据，已跳过'); return; }
      var flags = closedFlags(d);
      if (flags.some(function (c) { return !c; })) {
        errors.push(id + '：路径不是闭合的（缺少 Z 或首尾不重合）。开口轮廓三角化会出破面，先补上闭合再导');
      }
      var meta = (labels && labels[id]) || {};
      var label = String(meta.label || el.getAttribute('data-label') || el.getAttribute('data-name') || id);
      var color = meta.color || el.getAttribute('fill') || el.getAttribute('data-fill') || '#c9ccd4';
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) color = '#c9ccd4';
      regions.push({
        id: id, label: label, d: d, color: color,
        meta: { id: id, label: label, color: color },
        transform: el.getAttribute('transform') || ''
      });
    });

    return { ok: errors.length === 0, errors: errors, warnings: warnings, regions: regions, viewBox: [0, 0, vbW, vbH] };
  }

  /* 用浏览器的 SVG 路径引擎采样：曲线（贝塞尔 / 圆弧）直接按弧长取点，
   * 不用自己实现贝塞尔求值，也不会因为控制点分布不均而采样过稀。 */
  function samplePoints(region, viewBox) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + viewBox[2] + ' ' + viewBox[3]);
    svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
    svg.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none';
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', region.d);
    if (region.transform) path.setAttribute('transform', region.transform);
    svg.appendChild(path);
    document.body.appendChild(svg);

    var pts = [];
    try {
      var len = path.getTotalLength();
      if (!(len > 0)) return { pts: [], len: 0 };
      var step = Math.max(0.5, Math.min(SAMPLE_STEP, len / 24));
      var n = Math.max(12, Math.min(1200, Math.ceil(len / step)));
      for (var i = 0; i < n; i++) {
        var p = path.getPointAtLength(len * i / n);
        pts.push([p.x, p.y]);
      }
    } finally {
      svg.parentNode.removeChild(svg);
    }
    /* 去掉连续重复点（直线段采样会产出等距点，重复点会让三角化退化） */
    var out = [];
    for (var j = 0; j < pts.length; j++) {
      var q = pts[j];
      var prev = out[out.length - 1];
      if (!prev || Math.abs(prev[0] - q[0]) > 1e-3 || Math.abs(prev[1] - q[1]) > 1e-3) out.push(q);
    }
    if (out.length > 2) {
      var f = out[0], l = out[out.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-3 && Math.abs(f[1] - l[1]) < 1e-3) out.pop();
    }
    return { pts: out, len: len };
  }

  function areaOf(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
  }

  /* 按标签做 2D 调整：在**采样点**上改，而不是动 mesh 变换 ——
   * 后面要按这些轮廓挤出/放样时，点改了才是真的改了形，节点变换只是个外壳。
   * adj: { <id 或 label>: { dx, dy, sx, sy, rot, hide } }，dx/dy 用米，rot 用度，以包围盒中心为轴。 */
  function applyAdjust(pts, adj, k) {
    if (!adj) return pts;
    var cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= pts.length; cy /= pts.length;
    var dxPx = num(adj.dx, 0) / k, dyPx = num(adj.dy, 0) / k;
    var sx = adj.sx != null ? num(adj.sx, 1) : 1;
    var sy = adj.sy != null ? num(adj.sy, 1) : (adj.s != null ? num(adj.s, 1) : 1);
    if (adj.s != null && adj.sx == null) sx = num(adj.s, 1);
    var rot = num(adj.rot, 0) * Math.PI / 180;
    var cos = Math.cos(rot), sin = Math.sin(rot);
    return pts.map(function (p) {
      var x = (p[0] - cx) * sx, y = (p[1] - cy) * sy;
      var rx = x * cos - y * sin, ry = x * sin + y * cos;
      return [rx + cx + dxPx, ry + cy + dyPx];
    });
  }

  /* 采样 + 建平面网格。opts.height：整张图的高度（米），默认 1.6m 的人高。 */
  function build(svgText, opts) {
    opts = opts || {};
    var parsed = parse(svgText, opts.labels);
    if (!parsed.ok) {
      var err = new Error('SVG 分区有误：' + parsed.errors.join('；'));
      err.parse = parsed;
      throw err;
    }
    var vb = parsed.viewBox;
    var height = num(opts.height, 1.6) || 1.6;
    var k = height / vb[3];                       // viewBox → 米

    var group = new THREE.Group();
    group.name = opts.name || 'svgRegions';
    var outRegions = [];

    var adjustAll = opts.adjust || {};
    parsed.regions.forEach(function (r) {
      var adj = adjustAll[r.id] || adjustAll[r.label] || null;
      if (adj && adj.hide) { parsed.warnings.push(r.label + '：按 2D 控制被隐藏'); return; }
      var s = samplePoints(r, vb);
      if (adj) s.pts = applyAdjust(s.pts, adj, k);
      if (s.pts.length < 3) {
        parsed.warnings.push(r.id + '：采样点不足 3 个，已跳过');
        return;
      }
      var shape = new THREE.Shape();
      /* 注意 Y 轴：SVG 向下为正，3D 里让图「正着看」要翻 Y。
       * 翻在坐标上而不是靠旋转节点——旋转会让后续挤出方向跟着变，很难解释。 */
      s.pts.forEach(function (p, i) {
        var x = (p[0] - vb[0]) * k;
        var z = (p[1] - vb[1]) * k;               // 直接当成 Z（平面躺在 XZ 上，正视时屏幕竖轴是 Z 的反向）
        if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
      });
      shape.closePath();

      var geo;
      try { geo = new THREE.ShapeGeometry(shape); }
      catch (e) { parsed.warnings.push(r.id + '：三角化失败（' + (e && e.message) + '）'); return; }

      /* ShapeGeometry 的 uv 是原始 xy 坐标，重映射到 0..1（后面贴原画/贴图都要用） */
      var pos = geo.attributes.position, uv = geo.attributes.uv;
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (var i2 = 0; i2 < pos.count; i2++) {
        minX = Math.min(minX, pos.getX(i2)); maxX = Math.max(maxX, pos.getX(i2));
        minY = Math.min(minY, pos.getY(i2)); maxY = Math.max(maxY, pos.getY(i2));
      }
      var wSpan = Math.max(1e-6, maxX - minX), hSpan = Math.max(1e-6, maxY - minY);
      for (var i3 = 0; i3 < uv.count; i3++) {
        uv.setXY(i3, (pos.getX(i3) - minX) / wSpan, (pos.getY(i3) - minY) / hSpan);
      }
      uv.needsUpdate = true;

      /* 平面躺到 XZ：绕 X 转 -90°，让「正视」时看到的是原图的样子 */
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(r.color),
        metalness: 0, roughness: 0.85,
        side: THREE.DoubleSide
      }));
      mesh.name = r.label;
      mesh.userData.region = { id: r.id, label: r.label };
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0;
      group.add(mesh);

      outRegions.push({
        id: r.id, label: r.label, color: r.color, adjusted: !!adj,
        points: s.pts.length,
        tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
        area2d: +(areaOf(s.pts) * k * k).toFixed(4),
        bbox: [+(minX.toFixed(3)), +(minY.toFixed(3)), +(maxX.toFixed(3)), +(maxY.toFixed(3))]
      });
    });

    return { group: group, regions: outRegions, warnings: parsed.warnings, viewBox: vb, scale: k, parsed: parsed };
  }

  function statsOf(group) {
    var tris = 0, meshes = 0;
    group.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
    });
    return { meshes: meshes, tris: Math.round(tris) };
  }

  function toGLB(group) {
    if (!THREE.GLTFExporter) return Promise.reject(new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）'));
    return new Promise(function (res, rej) {
      new THREE.GLTFExporter().parse(group, res, rej, { binary: true, onlyVisible: true });
    }).then(function (buf) {
      var u8 = new Uint8Array(buf), s = '', CH = 8192;
      for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      return 'data:model/gltf-binary;base64,' + btoa(s);
    });
  }

  /* 给节点用：解析 → 建网格 → 导出 GLB，附带标签清单 */
  async function buildGLB(svgText, opts) {
    var r = build(svgText, opts);
    if (!r.regions.length) throw new Error('没有生成任何闭合曲面（检查路径是否闭合、是否都在 viewBox 内）');
    var dataURL = await toGLB(r.group);
    return {
      dataURL: dataURL,
      stats: statsOf(r.group),
      regions: r.regions,
      warnings: r.warnings,
      viewBox: r.viewBox,
      scale: r.scale
    };
  }

  global.SvgShapes = {
    SAMPLE_STEP: SAMPLE_STEP,
    parse: parse,
    build: build,
    buildGLB: buildGLB,
    samplePoints: samplePoints,
    areaOf: areaOf,
    /* 给 AI 的模板：告诉它「怎么画一块闭合区域并打标签」 */
    schemaHelp: function () {
      return [
        '输出一个 SVG（viewBox="0 0 W H"），每块部件 = 一条**闭合** path：',
        '<svg viewBox="0 0 512 1024">',
        '  <path id="hair" data-label="头发" data-fill="#d8d3e6" d="M…Z"/>',
        '  <path id="skirt" data-label="裙摆" data-fill="#ffffff" d="M…Z"/>',
        '  <path id="legL" data-label="左腿" data-fill="#f6dfd2" d="M…Z"/>',
        '</svg>',
        '规则：① 每条路径必须闭合（结尾 Z）；② data-label 是这块的语义标签，后面按标签做 2D 控制；',
        '③ data-fill 给主色；④ 轮廓贴着原画的剪影边缘画，不要画内部细节线；⑤ 大形优先，细节后补。'
      ].join('\n');
    }
  };
})(window);
