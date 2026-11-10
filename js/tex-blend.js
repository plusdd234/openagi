/* 纹理混合算法（模型库 / 建模 App 共用）
 *
 * 为什么单独成文件：模型库的材质插槽面板（js/m3d-slots.js）和建模 App 的
 * 绘画工具箱（js/md-texmix.js）用的是同一套「图层 → 烘一张图」的做法。
 * 两份各写一遍的话，同一个配置在两边会混出不同结果——用户看到的就是
 * 「模型库里配的混合，在建模 App 里打开变了样」。
 *
 * 这里只放纯算法：混合模式表、遮罩换算、合成尺寸、逐层合成。
 * DOM / 资产库 / 材质都由调用方自己管，本文件不碰 localStorage、不建材质。
 *
 * 对外（window.TexBlend）：
 *   BLEND_MODES / blendOp(key) / clampNum(v,a,b) /
 *   maskAlpha(rec,w,h,flip) / mixSize({baseImg,layers},maxSide) /
 *   compose({w,h,baseImg,layers,canvas?}) → canvas
 */
(function (global) {
  'use strict';

  /* 混合模式 → canvas 合成算子。名字沿用设计软件的说法；
   * 「相加」用 lighter——它既是唯一会让结果整体变亮的模式，也是发光层要的效果。 */
  var BLEND_MODES = [
    { key: 'normal', label: '正常', op: 'source-over' },
    { key: 'multiply', label: '正片叠底', op: 'multiply' },
    { key: 'screen', label: '滤色', op: 'screen' },
    { key: 'overlay', label: '叠加', op: 'overlay' },
    { key: 'softlight', label: '柔光', op: 'soft-light' },
    { key: 'add', label: '相加', op: 'lighter' },
    { key: 'darken', label: '变暗', op: 'darken' },
    { key: 'lighten', label: '变亮', op: 'lighten' }
  ];

  function blendOp(key) {
    for (var i = 0; i < BLEND_MODES.length; i++) if (BLEND_MODES[i].key === key) return BLEND_MODES[i].op;
    return 'source-over';
  }

  function clampNum(v, a, b) {
    v = Number(v);
    if (!isFinite(v)) v = a;
    return Math.max(a, Math.min(b, v));
  }

  /* 遮罩 → alpha 图。约定「白=显示、黑=隐藏」，跟常见灰度遮罩一致；
   * 透明区域一律算隐藏（白色形状 + 透明底 的 PNG 不会整片糊上去）。
   * 反相只翻灰度、不动透明度——否则透明底会变成整块不透明，层直接消失。
   * 按「尺寸 + 反相 + 是否上下翻」缓存：拖滑杆时每帧都重算像素会卡。 */
  function maskAlpha(rec, w, h, flip) {
    /* 手绘遮罩本身就是「透明底 + 白色笔迹」，等于一张现成的 alpha 图；
     * 尺寸和合成画布一致、又不反相时直接拿去用。拖动笔刷时这就省掉了
     * 每帧对整张 1024/2048 贴图做一次 getImageData 的开销。 */
    if (rec.__direct && !rec.invert && !flip &&
        rec.img && rec.img.width === w && rec.img.height === h) return rec.img;
    if (!rec.__mc) rec.__mc = {};
    var key = w + 'x' + h + (rec.invert ? 'i' : '') + (flip ? 'f' : '');
    if (rec.__mc[key]) return rec.__mc[key];
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    if (flip) { ctx.translate(0, h); ctx.scale(1, -1); }
    ctx.drawImage(rec.img, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h);
    var px = data.data;
    for (var i = 0; i < px.length; i += 4) {
      var l = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
      if (rec.invert) l = 255 - l;
      px[i + 3] = Math.round(l * px[i + 3] / 255);
    }
    ctx.putImageData(data, 0, 0);
    var keys = Object.keys(rec.__mc);
    if (keys.length > 5) delete rec.__mc[keys[0]];
    rec.__mc[key] = cv;
    return cv;
  }

  /* 合成画布尺寸：跟基础层同一比例，长边压到上限。
   * 贴图必须和基础层同一个 UV 比例，改比例会整片拉伸；
   * 没有基础图时用第一张有效图定比例，都没有就 1024。 */
  function mixSize(o, maxSide) {
    o = o || {};
    var base = o.baseImg;
    var W = (base && base.width) ? base.width : 0;
    var H = (base && base.height) ? base.height : 0;
    if (!W || !H) {
      var ls = o.layers || [];
      for (var i = 0; i < ls.length; i++) {
        var im = ls[i] && ls[i].img;
        if (im && im.width) { W = im.width; H = im.height; break; }
      }
    }
    if (!W || !H) { W = H = 1024; }
    var sc = Math.min(1, (maxSide || 2048) / Math.max(W, H));
    return { w: Math.max(4, Math.round(W * sc)), h: Math.max(4, Math.round(H * sc)) };
  }

  /* 把基础图 + 所有层烘进一张 canvas：
   *   白底 → 基础图 → 每层先画到 tmp、遮罩裁一次、再按混合模式与比例叠上来。
   * 每层先画到自己那张纸上，是为了让遮罩裁剪只作用于这一层；
   * 直接在主画布上做 destination-in 会把底下的东西一起裁掉。
   * 传 canvas 时复用同一张（拖滑杆 / 画笔每帧重合成，避免反复分配canvas与纹理）。 */
  function compose(o) {
    o = o || {};
    var W = Math.max(4, Math.round(o.w || 1024));
    var H = Math.max(4, Math.round(o.h || 1024));
    var cv = o.canvas;
    if (!cv) cv = document.createElement('canvas');
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    /* 没有自带贴图时从白底开始：OBJ 的默认材质就是白色，
     * 用黑底会让「叠一层带透明洞的图」变成黑影，跟直觉相反。 */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (o.baseImg && o.baseImg.width) ctx.drawImage(o.baseImg, 0, 0, W, H);

    var tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    var tctx = tmp.getContext('2d');
    var ls = o.layers || [];
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i];
      if (!l || !l.img) continue;
      var a = clampNum(l.opacity, 0, 1);
      if (a <= 0) continue;
      tctx.globalCompositeOperation = 'source-over';
      tctx.clearRect(0, 0, W, H);
      tctx.drawImage(l.img, 0, 0, W, H);
      if (l.mask && l.mask.img) {
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(maskAlpha(l.mask, W, H, false), 0, 0);
        tctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = a;
      ctx.globalCompositeOperation = blendOp(l.blend);
      ctx.drawImage(tmp, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    return cv;
  }

  global.TexBlend = {
    BLEND_MODES: BLEND_MODES,
    blendOp: blendOp,
    clampNum: clampNum,
    maskAlpha: maskAlpha,
    mixSize: mixSize,
    compose: compose
  };
})(window);
