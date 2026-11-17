/* 笔刷采样：把「上一落点 → 这一落点」变成一串等距图章。
 *
 * 为什么单独拆成一个文件：这是笔迹形状的**唯一定义**，有两个消费者——
 *   ① js/md-paint.js 真正往画布上打图章；
 *   ② tools/md-stroke.js 在 Node 里做纯逻辑断言。
 * 以前这段算式写在 md-paint.move() 里，只能靠开浏览器画一笔来验，
 * 间距 / 跨 UV 接缝 / 采样上限全都无法单测。
 *
 * 约定（与画布一致）：
 *   - u/v 是 UV，[0,1] 之外会被折算回画布（paintStampUV 负责）；
 *   - w/h 是画布像素尺寸，笔刷半径以「画布短边 / maxSide」缩放；
 *   - 相邻两点之间按 UV 线性插值，跨 0/1 接缝走最短方向（不能绕整张贴图一圈）。
 *
 * 纯函数：不碰 DOM、不读写全局状态，可直接 require。
 */
(function (global) {
  'use strict';

  /* 单段最多补多少个图章：一次 pointermove 内插 400 个点已经覆盖
   * 400 × 最小间距（1.5px）以上的距离；再密的采样对像素结果没有影响。 */
  var MAX_SAMPLES = 400;

  /* 跨 UV 接缝的判据：屏幕几乎没动、UV 却跳了很远。
   * 3D 上相邻的两张面在贴图里可能隔着半张图集；把两点直接连线，
   * 会在模型上凭空多出一条长线，还会一次补满几百个图章把主线程卡住。
   * 两条规则：
   *   ① 一帧跨过 1/4 图集 —— 只可能是换岛，与拖拽速度无关；
   *   ② 屏幕 45px 内 UV 跳 7% —— 正常拖拽的 UV 位移与屏幕位移成正比，二者不会同时成立。
   * 阈值宁可略松：误判只是接缝处少连一小段，漏判则是整条长线 + 卡顿。 */
  var SEAM_PX = 45, SEAM_UV = 0.07, SEAM_UV_MAX = 0.28;
  function seamJump(dpx, duv) {
    var d = duv || 0;
    if (d > SEAM_UV_MAX) return true;
    return (dpx || 0) < SEAM_PX && d > SEAM_UV;
  }

  /* 笔刷半径（画布像素）。面板里的 size 是「在 2048² 画布上的直径」，
   * 小贴图按短边等比缩放，保证同一个 size 看起来一样粗。 */
  function radius(size, w, h, maxSide) {
    var sc = Math.min(w || 0, h || 0) / (maxSide || 2048);
    return Math.max(1.5, (size || 0) * 0.5 * sc);
  }

  /* 两个采样点之间的 UV 差：跨接缝走最短方向 */
  function span(u0, v0, u1, v1) {
    var du = u1 - u0, dv = v1 - v0;
    if (du > 0.5) du -= 1; else if (du < -0.5) du += 1;
    if (dv > 0.5) dv -= 1; else if (dv < -0.5) dv += 1;
    return { du: du, dv: dv };
  }

  /* 图章间距（画布像素）：笔越小间距越小，但至少 1.5px */
  function step(size, w, h, maxSide) {
    var sc = Math.min(w || 0, h || 0) / (maxSide || 2048);
    return Math.max(1.5, (size || 0) * 0.22 * sc);
  }

  /* 一段笔画 → 图章参数。
   * 返回 { n, du, dv, dist, step }：调用方从 i=1..n 取
   *   (u0 + du*i/n, v0 + dv*i/n)
   * 这样起点不会被重复打一次（起点在 begin() 里已经落过图章）。 */
  function samples(u0, v0, u1, v1, w, h, size, maxSide) {
    var s = span(u0, v0, u1, v1);
    var dist = Math.sqrt(s.du * s.du * w * w + s.dv * s.dv * h * h);
    var st = step(size, w, h, maxSide);
    var n = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(dist / st)));
    return { n: n, du: s.du, dv: s.dv, dist: dist, step: st };
  }

  /* 一次图章的包围盒（画布像素）：脏块 / 局部上传都用它，
   * 保证「画多大就只动多大」——不要每落一个图章都当整张画布脏了。 */
  function bboxOf(x, y, rad, pad) {
    var p = pad || 0;
    var w = Math.max(0, Math.ceil((rad + p) * 2));
    var h = w;
    return { x: x - rad - p, y: y - rad - p, w: w, h: h };
  }

  /* 两个包围盒的并集（脏块累积）。null 代表「还没有脏块」 */
  function unionBox(a, b) {
    if (!a) return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    if (!b) return a;
    var x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    var x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 把包围盒夹进画布并取整：gl.texSubImage2D 不接受负偏移 */
  function clampBox(b, w, h) {
    if (!b) return null;
    var x0 = Math.max(0, Math.floor(b.x));
    var y0 = Math.max(0, Math.floor(b.y));
    var x1 = Math.min(w, Math.ceil(b.x + b.w));
    var y1 = Math.min(h, Math.ceil(b.y + b.h));
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  var API = {
    MAX_SAMPLES: MAX_SAMPLES,
    radius: radius, step: step, span: span, samples: samples, seamJump: seamJump,
    bboxOf: bboxOf, unionBox: unionBox, clampBox: clampBox
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.PaintStroke = API;
})(typeof window !== 'undefined' ? window : globalThis);
