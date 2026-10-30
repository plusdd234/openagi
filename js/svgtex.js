/* SVG 纹理绘制引擎：给 AI 用的「在 UV 空间直接画贴图」工具。
 *
 * 与投影贴图（texpaint.js）的区别：
 *   投影 = 把一张参考照片的像素搬上去（要有对的图、对的姿态）
 *   本引擎 = AI 用矢量（rect / circle / path / text…）按 UV 坐标**直接画**贴图
 *          → 不依赖任何参考图、矢量无限清晰、AI 能精确描述「在胸口画金五角星」
 *
 * 约定：AI 把 viewBox 设为 0 0 size size（即纹理像素坐标系），按 UV 布局图给的
 * 区域坐标落笔。引擎只负责把这段 SVG 光栅化到指定分辨率的 canvas（albedo）。
 */
(function (root) {
  'use strict';

  /* 拼成一份完整 SVG 文档。inner 是任意合法的 SVG 内部片段；
   * 若 inner 自身已是 <svg> 根，则原样返回（并强制带 width/height）。 */
  function doc(inner, size, opts) {
    opts = opts || {};
    size = size || 1024;
    var trimmed = String(inner || '').trim();
    if (trimmed.indexOf('<svg') === 0) {
      // 已经是一份文档：确保带尺寸
      var withSize = trimmed
        .replace(/<svg([^>]*?)\s*>/, function (m, attrs) {
          var a = attrs.replace(/\s+width\s*=\s*"[^"]*"/, '');
          a = a.replace(/\s+height\s*=\s*"[^"]*"/, '');
          return '<svg' + a + ' width="' + size + '" height="' + size + '">';
        });
      return withSize;
    }
    var bg = opts.bg ? '<rect width="' + size + '" height="' + size + '" fill="' + opts.bg + '"/>' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + size + ' ' + size + '">' + bg + inner + '</svg>';
  }

  /* 把 SVG 光栅化成 canvas。返回 Promise<HTMLCanvasElement>。
   * 浏览器原生矢量渲染，分辨率随意；颜色用 encodeURIComponent 传，支持 # 与中文。 */
  function rasterize(svg, size) {
    size = size || 1024;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = size; c.height = size;
        c.getContext('2d').drawImage(img, 0, 0, size, size);
        resolve(c);
      };
      img.onerror = function () { reject(new Error('SVG 渲染失败')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  root.SvgTex = { doc: doc, rasterize: rasterize };
})(window);
