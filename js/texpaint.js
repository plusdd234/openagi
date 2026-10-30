/* 贴图投影（projection painting）基础能力。
 *
 * 为什么需要它：Tripo 之类的生成模型贴图是「一次成型、黑盒」，UV 展开与像素分配由它自己
 * 说了算，不接受「金边往左挪 8px」这类约束。重跑多少次都只是重新猜一遍，不会朝参考图的
 * 像素位置收敛。真要「精确」，只有把参考图里已知正确的像素直接搬到模型表面 —— 即本模块。
 *
 * 三条能力：
 *   1) uvMaterial()      —— UV pass 材质：每个屏幕像素记住自己的 uv 坐标（可视化 / 粗定位用）
 *   2) bakeProject()     —— GPU 烘焙（正式路径）：把参考图按当前相机反投到 UV 空间，
 *                           自带自遮挡剔除（被挡住的 texel 不画）与边缘羽化
 *   3) paintFromScreen() —— 8 位回读路径（仅粗定位 / 掩码查询，不用于最终烘焙，原因见函数注释）
 *
 * 纯函数，不依赖任何 App 状态；节点与调试页共用这一份，避免两套实现漂移。
 */
(function (root) {
  'use strict';

  var sharedRenderer = null, sharedCanvas = null;

  /* 自己带一个离屏渲染器：烘焙是「离屏 + 任意尺寸」的活，借 App 的画布会把状态搅乱。 */
  function rendererOf(opt) {
    if (opt && opt.renderer) return opt.renderer;
    if (sharedRenderer) return sharedRenderer;
    sharedCanvas = document.createElement('canvas');
    sharedRenderer = new THREE.WebGLRenderer({
      canvas: sharedCanvas, antialias: false, preserveDrawingBuffer: true, alpha: true
    });
    sharedRenderer.setPixelRatio(1);
    return sharedRenderer;
  }

  /* UV pass 材质：uv.x → R，uv.y → G，alpha=1 表示「这块是模型表面」。
   * 背景必须清成 alpha=0，解码时靠 alpha 区分模型与空白。 */
  function uvMaterial() {
    return new THREE.ShaderMaterial({
      vertexShader: [
        'varying vec2 vUv;',
        'void main(){',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec2 vUv;',
        'void main(){ gl_FragColor = vec4(vUv, 0.0, 1.0); }'
      ].join('\n'),
      side: THREE.DoubleSide
    });
  }

  /* WebGL 画布不能直接 getContext('2d')，必须中转一次再取像素。 */
  function snapshot(glCanvas) {
    var c = document.createElement('canvas');
    c.width = glCanvas.width;
    c.height = glCanvas.height;
    c.getContext('2d').drawImage(glCanvas, 0, 0);
    return c;
  }

  function unpackUv(canvas) {
    var w = canvas.width, h = canvas.height;
    var img = canvas.getContext('2d').getImageData(0, 0, w, h);
    return { w: w, h: h, data: img.data };
  }

  var srcCache = new WeakMap();
  function srcCanvasOf(src) {
    var hit = srcCache.get(src);
    if (hit) return hit;
    var c = document.createElement('canvas');
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    srcCache.set(src, c);
    return c;
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function int(v) { return Math.max(0, Math.round(Number(v) || 0)); }

  /* ---------------- GPU 烘焙（正式路径） ----------------
   *
   * 做法：把顶点位置直接写成 uv（gl_Position = uv*2-1），于是光栅化发生在「UV 空间」，
   * 每个贴图 texel 恰好被访问一次 —— 没有量化、没有空洞、没有重复写。
   * 片段里再用相机矩阵算出这个 texel 在屏幕上的位置，去参考图上取色。
   *
   * 自遮挡必须剔除：否则「贴图背面的 texel」也会算出同一个屏幕位置，被涂上正面内容。
   * 所以先渲一张相机视角的线性深度图，片段里比一下谁的深度更靠前。
   *
   * opt.scene / opt.camera / opt.src
   * opt.viewSize   相机渲染用的屏幕尺寸（screenRect 按它算），缺省 = size
   * opt.screenRect {x,y,w,h} 屏幕像素矩形（左上原点）—— 只修这块
   * opt.srcRect    {x,y,w,h} 归一化（左上原点），缺省整张
 * opt.feather    边缘羽化像素，缺省 2
 * opt.bias       深度容差（世界单位），缺省 0.01
 * opt.useSrcAlpha 源 alpha 门控（笔刷草稿层：透明处不落笔），缺省关
 * opt.renderer   复用调用方的渲染器（笔刷视口烘焙时就用它，免得养两个 GL 上下文）
 * 返回 { canvas, alpha, painted, occluded }
   */
  function bakeProject(opt) {
    var scene = opt.scene, camera = opt.camera, src = opt.src;
    var size = Math.max(64, Math.min(4096, int(opt.size) || 1024));
    var view = Math.max(64, Math.min(4096, int(opt.viewSize) || size));
    var rect = opt.screenRect;
    var feather = opt.feather == null ? 2 : Math.max(0, Number(opt.feather) || 0);
    var bias = opt.bias == null ? 0.01 : Number(opt.bias);

    var sc = srcCanvasOf(src);
    var sr = opt.srcRect || { x: 0, y: 0, w: 1, h: 1 };   // 归一化
    var r = rendererOf(opt);

    var srcTex = new THREE.CanvasTexture(sc);
    srcTex.needsUpdate = true;
    if (THREE.SRGBColorSpace && 'colorSpace' in srcTex) srcTex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding && 'encoding' in srcTex) srcTex.encoding = THREE.sRGBEncoding;

    /* 1. 相机视角线性深度。深度图要浮点才有意义（8 位只有 1/255 精度，远处几乎分不开），
     *    但输出贴图必须是 8 位（要落到 canvas），所以两个 RT 用不同精度。 */
    var gl0 = r.getContext ? r.getContext() : null;
    var canFloat = !!(gl0 && (gl0.getExtension('EXT_color_buffer_float') || gl0.getExtension('WEBGL_color_buffer_float')));
    var depthRT;
    try {
      depthRT = new THREE.WebGLRenderTarget(view, view, {
        type: canFloat ? THREE.FloatType : THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true
      });
    } catch (e) {
      canFloat = false;
      depthRT = new THREE.WebGLRenderTarget(view, view, { depthBuffer: true });
    }

    var near = camera.near || 0.1, far = camera.far || 1000;
    var depthMat = new THREE.ShaderMaterial({
      vertexShader: [
        'varying float vZ;',
        'void main(){',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vZ = -mv.z;',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying float vZ;',
        'void main(){ gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }'
      ].join('\n'),
      side: THREE.DoubleSide
    });
    if (!canFloat) {
      /* 没有浮点 RT：把线性深度压到 0~1 存 8 位，精度约 1/255，只够粗剔除 */
      depthMat.fragmentShader = [
        'uniform float uNear, uFar;',
        'varying float vZ;',
        'void main(){ gl_FragColor = vec4(clamp((vZ - uNear) / (uFar - uNear), 0.0, 1.0), 0.0, 0.0, 1.0); }'
      ].join('\n');
      depthMat.uniforms = { uNear: { value: near }, uFar: { value: far } };
    }

    /* 2. 烘焙 */
    var bakeMat = new THREE.ShaderMaterial({
      uniforms: {
        uDepth: { value: depthRT.texture },
        uSrc: { value: srcTex },
        uView: { value: new THREE.Vector2(view, view) },
        uRect: { value: new THREE.Vector4(rect.x, rect.y, Math.max(1, rect.w), Math.max(1, rect.h)) },
        uSrcR: { value: new THREE.Vector4(sr.x, sr.y, sr.w, sr.h) },
        uFeather: { value: feather },
        uBias: { value: canFloat ? bias : bias / Math.max(1e-6, far - near) },
        uNorm: { value: canFloat ? 0 : 1 },
        uSrcA: { value: opt.useSrcAlpha ? 1 : 0 },
        uNear: { value: near },
        uFar: { value: far }
      },
      vertexShader: [
        'varying float vZ;',
        'varying vec4 vClip;',
        'void main(){',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vZ = -mv.z;',
        '  vClip = projectionMatrix * mv;',
        '  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uDepth, uSrc;',
        'uniform vec2 uView;',
        'uniform vec4 uRect, uSrcR;',
        'uniform float uFeather, uBias, uNorm, uSrcA, uNear, uFar;',
        'varying float vZ;',
        'varying vec4 vClip;',
        'void main(){',
        '  vec2 nd = vClip.xy / vClip.w * 0.5 + 0.5;',
        '  if(nd.x < 0.0 || nd.x > 1.0 || nd.y < 0.0 || nd.y > 1.0) discard;',
        '  float occ = texture2D(uDepth, nd).r;',
        '  if(uNorm > 0.5) occ = uNear + occ * (uFar - uNear);',
        '  if(vZ > occ + uBias) discard;',
        '  vec2 px = vec2(nd.x, 1.0 - nd.y) * uView;',
        '  vec2 local = (px - uRect.xy) / uRect.zw;',
        '  if(local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) discard;',
        '  float a = 1.0;',
        '  if(uFeather > 0.0){',
        '    vec2 e = min(px - uRect.xy, uRect.xy + uRect.zw - px);',
        '    a = clamp(min(e.x, e.y) / uFeather, 0.0, 1.0);',
        '  }',
        '  vec2 suv = uSrcR.xy + local * uSrcR.zw;',
        '  vec4 s = texture2D(uSrc, vec2(suv.x, 1.0 - suv.y));',
        /* uSrcA：笔画源带透明度（笔刷草稿层）——透明处不许落笔，否则 RGB 残渣会被涂成黑点。
         * 普通参考图不透明（s.a=1），行为与原来完全一致。 */
        '  gl_FragColor = vec4(s.rgb, uSrcA > 0.5 ? a * s.a : a);',
        '}'
      ].join('\n'),
      /* NoBlending：RT 里存的必须是 shader 原样输出（非预乘）。
       * 默认混合会把 color×alpha 写进缓冲，读回再按「非预乘」混一次 → 软边双重变暗发黑。 */
      blending: THREE.NoBlending,
      side: THREE.FrontSide
    });

    var bakeRT = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false
    });

    var prevOverride = scene.overrideMaterial;
    var prevTarget = r.getRenderTarget ? r.getRenderTarget() : null;
    var prevAutoClear = r.autoClear;
    var prevClear = new THREE.Color();
    if (r.getClearColor) r.getClearColor(prevClear);
    var prevAlpha = r.getClearAlpha ? r.getClearAlpha() : 1;

    try {
      r.setPixelRatio(1);

      r.setRenderTarget(depthRT);
      r.setClearColor(0xffffff, 1);
      r.clear(true, true, true);
      scene.overrideMaterial = depthMat;
      r.render(scene, camera);

      r.setRenderTarget(bakeRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      scene.overrideMaterial = bakeMat;
      r.render(scene, camera);
    } finally {
      scene.overrideMaterial = prevOverride;
      r.setRenderTarget(prevTarget || null);
      r.autoClear = prevAutoClear;
      if (r.setClearColor) r.setClearColor(prevClear, prevAlpha);
    }

    /* 3. 读回：GL 是自下而上，ImageData 自上而下，要翻 */
    var buf = new Uint8Array(size * size * 4);
    r.readRenderTargetPixels(bakeRT, 0, 0, size, size, buf);
    var cvs = document.createElement('canvas');
    cvs.width = size; cvs.height = size;
    var ctx = cvs.getContext('2d');
    var img = ctx.createImageData(size, size);
    var painted = 0;
    for (var y = 0; y < size; y++) {
      var srcRow = (size - 1 - y) * size * 4;
      var dstRow = y * size * 4;
      for (var x = 0; x < size * 4; x += 4) {
        img.data[dstRow + x] = buf[srcRow + x];
        img.data[dstRow + x + 1] = buf[srcRow + x + 1];
        img.data[dstRow + x + 2] = buf[srcRow + x + 2];
        img.data[dstRow + x + 3] = buf[srcRow + x + 3];
        if (buf[srcRow + x + 3] > 8) painted++;
      }
    }
    ctx.putImageData(img, 0, 0);

    depthRT.dispose();
    bakeRT.dispose();
    srcTex.dispose();

    return { canvas: cvs, painted: painted, size: size };
  }

  /* 把烘焙结果按 alpha 混到贴图上（原地改写 base） */
  function composite(base, over) {
    var b = base.getContext('2d');
    var o = over.getContext('2d');
    var W = base.width, H = base.height;
    var bd = b.getImageData(0, 0, W, H);
    var od = o.getImageData(0, 0, over.width, over.height);
    var sx = over.width / W, sy = over.height / H;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var oi = ((Math.floor(y * sy)) * over.width + Math.floor(x * sx)) * 4;
        var a = od.data[oi + 3] / 255;
        if (a <= 0.002) continue;
        var bi = (y * W + x) * 4;
        bd.data[bi] = bd.data[bi] * (1 - a) + od.data[oi] * a;
        bd.data[bi + 1] = bd.data[bi + 1] * (1 - a) + od.data[oi + 1] * a;
        bd.data[bi + 2] = bd.data[bi + 2] * (1 - a) + od.data[oi + 2] * a;
      }
    }
    b.putImageData(bd, 0, 0);
    return base;
  }

  /* ---------------- 8 位回读路径（不要用于最终烘焙） ----------------
   *
   * 实测结论：UV pass 把 uv 存进 RGB 8 位，当目标表面只占贴图一小块时精度会塌。
   * 本项目一次实测：472×324 的屏幕矩形 → 154,050 个屏幕像素只落到 3,024 个 texel
   * （每个 texel 被写 50 次），贴图放大 9 倍，眼睛明显糊。
   * 所以正式烘焙一律走 bakeProject；这条只在「想知道某屏幕区域碰了哪些 texel」
   * 或者没有 WebGL 时的兜底查询里用。
   */
  function paintFromScreen(opt) {
    var uv = opt.uv, albedo = opt.albedo, src = opt.src;
    var sc = srcCanvasOf(src);
    var sr = opt.srcRect || { x: 0, y: 0, w: sc.width, h: sc.height };
    sr = { x: int(sr.x), y: int(sr.y), w: Math.max(1, int(sr.w)), h: Math.max(1, int(sr.h)) };
    sr.w = Math.min(sr.w, sc.width - sr.x) || 1;
    sr.h = Math.min(sr.h, sc.height - sr.y) || 1;

    var sd = sc.getContext('2d').getImageData(sr.x, sr.y, sr.w, sr.h).data;
    var W = albedo.width, H = albedo.height;
    var actx = albedo.getContext('2d');
    var aimg = actx.getImageData(0, 0, W, H);
    var ad = aimg.data;

    var tr = opt.screenRect;
    var x0 = Math.max(0, Math.floor(tr.x)), x1 = Math.min(uv.w, Math.ceil(tr.x + tr.w));
    var y0 = Math.max(0, Math.floor(tr.y)), y1 = Math.min(uv.h, Math.ceil(tr.y + tr.h));

    var mask = new Uint8Array(W * H);
    var written = 0, covered = 0;

    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var i = (y * uv.w + x) * 4;
        if (uv.data[i + 3] < 128) continue;
        covered++;
        var u = uv.data[i] / 255, v = uv.data[i + 1] / 255;
        var tx = Math.round(clamp01(u) * (W - 1));
        var ty = Math.round((1 - clamp01(v)) * (H - 1));
        var px = Math.min(sr.w - 1, Math.floor((x - tr.x) / tr.w * sr.w));
        var py = Math.min(sr.h - 1, Math.floor((y - tr.y) / tr.h * sr.h));
        px = px < 0 ? 0 : px; py = py < 0 ? 0 : py;
        var si = (py * sr.w + px) * 4;
        var di = (ty * W + tx) * 4;
        ad[di] = sd[si]; ad[di + 1] = sd[si + 1]; ad[di + 2] = sd[si + 2]; ad[di + 3] = 255;
        mask[ty * W + tx] = 1;
        written++;
      }
    }

    var unique = 0;
    for (var m0 = 0; m0 < mask.length; m0++) if (mask[m0]) unique++;

    var filled = 0;
    var rounds = opt.dilate == null ? 1 : Math.max(0, int(opt.dilate));
    for (var r0 = 0; r0 < rounds; r0++) {
      var add = [];
      for (var yy = 0; yy < H; yy++) {
        for (var xx = 0; xx < W; xx++) {
          if (mask[yy * W + xx]) continue;
          var n = 0, rr = 0, gg = 0, bb = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var nx = xx + dx, ny = yy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              if (!mask[ny * W + nx]) continue;
              var ni = (ny * W + nx) * 4;
              rr += ad[ni]; gg += ad[ni + 1]; bb += ad[ni + 2]; n++;
            }
          }
          if (n) add.push([yy * W + xx, rr / n, gg / n, bb / n]);
        }
      }
      for (var k = 0; k < add.length; k++) {
        var p = add[k], pi = p[0] * 4;
        ad[pi] = p[1]; ad[pi + 1] = p[2]; ad[pi + 2] = p[3]; ad[pi + 3] = 255;
        mask[p[0]] = 1;
      }
      filled += add.length;
      if (!add.length) break;
    }

    actx.putImageData(aimg, 0, 0);
    return { written: written, covered: covered, filled: filled, unique: unique };
  }

  root.TexPaint = {
    uvMaterial: uvMaterial,
    snapshot: snapshot,
    unpackUv: unpackUv,
    srcCanvasOf: srcCanvasOf,
    bakeProject: bakeProject,
    composite: composite,
    paintFromScreen: paintFromScreen
  };
})(window);
