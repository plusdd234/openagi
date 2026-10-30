/* 笔刷上色引擎（2026-10-30）。屏空间笔画 + 收笔一次投影烘焙，人与 AI 共用同一执行层。
 *
 * 架构（为什么不是逐笔 bakeProject）：
 *   - 烘焙是整场景 GPU 活，逐「笔触点」调一次太贵；
 *   - 所以笔触只画进一张「屏空间草稿画布」（2D，零成本），
 *     3D 材质用 shader 补丁把草稿实时叠到表面（WYSIWYG，带朝向剔除），
 *     收笔（pointerup / 一条笔画结束）才调 TexPaint.bakeProject 烘进 UV 贴图——权威落盘；
 *   - 遮挡由烘焙的深度剔除保证（草稿层预览只做近似：背面/掠射角不显示）。
 *
 * 图层：baseCanvas（底图，不可变）→ paintCanvas（笔画层，撤销栈在这里）→ viewCanvas
 *（= 底 + 笔画，真正贴给模型的贴图）。擦除 = 从笔画层 destination-out，露出底图、不伤底图。
 *
 * 笔画 JSON（AI 与节点共用的确定性回放格式，坐标 = 视口像素，左上原点）：
 *   [{ "cam":{ "az":0, "el":0, "dist":自动 }, "pts":[[x,y],[x,y]…],
 *      "color":"#e0533f", "radius":24, "hardness":0.7, "erase":false }, …]
 *   az/el 度（az=0 正对 +Z 前方，el 向上）；dist 缺省按模型半径自动取。
 *
 * 依赖：three（r149）、Model3D.load 产出的 analyze 结果（a.root/parts/radius/center）、
 *       TexPaint.bakeProject（useSrcAlpha 门控 + NoBlending）。
 * 坑（别再踩）：
 *   - 材质补丁里用 vUv / vNormal / vViewPosition（r149 名字），r152+ 才是 vMapUv；
 *   - bakeProject 的 RT 若开默认混合，color×alpha 预乘读回再混会双重变暗——引擎里已 NoBlending；
 *   - CanvasTexture 默认 flipY=true，恰好把「图片原点左上」翻成 GL 的「uv 原点左下」，
 *     gl_FragCoord.xy/view 直接采样草稿画布即可，不要自己再翻一次 y。
 */
(function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const n = m ? parseInt(m[1], 16) : 0xe0533f;
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* 球坐标摆机位：az=0 → +Z（正面），el 向上为正 */
  function placeCamera(cam, center, dist, az, el) {
    const A = (az || 0) * Math.PI / 180, E = (el || 0) * Math.PI / 180;
    cam.position.set(
      center.x + Math.sin(A) * Math.cos(E) * dist,
      center.y + Math.sin(E) * dist,
      center.z + Math.cos(A) * Math.cos(E) * dist);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
  }

  /* ---------------- 笔触落草稿：软边圆点 + 沿折线按间距插值 ---------------- */

  function dab(ctx, x, y, radius, hardness, color) {
    const r = Math.max(1, radius);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const h = clamp(hardness == null ? 0.7 : hardness, 0, 1);
    g.addColorStop(0, hexToRgba(color, 1));
    g.addColorStop(Math.max(0.01, h * 0.92), hexToRgba(color, 1));
    g.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function dabLine(ctx, x0, y0, x1, y1, radius, hardness, color) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1.5, radius * 0.35);
    const n = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= n; i++) {
      dab(ctx, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, radius, hardness, color);
    }
  }

  /* ---------------- 引擎主体 ---------------- */

  function mount(host, opt) {
    if (!window.THREE) throw new Error('three.js 未加载');
    if (!window.TexPaint) throw new Error('texpaint.js 未加载');
    const a = opt.a;
    if (!a || !a.root) throw new Error('缺少模型分析结果（先 ModelTex.analyze）');
    const size = clamp(Math.trunc(opt.size || 1024), 128, 4096);   // UV 贴图边长
    const view = clamp(Math.trunc(opt.view || 720), 256, 2048);    // 视口边长（正方形）

    /* --- 图层 --- */
    const baseCanvas = mkCanvas(size, size);
    const paintCanvas = mkCanvas(size, size);
    const viewCanvas = mkCanvas(size, size);
    const strokeCanvas = mkCanvas(view, view);
    const bctx = baseCanvas.getContext('2d');
    const pctx = paintCanvas.getContext('2d');
    const vctx = viewCanvas.getContext('2d');
    const sctx = strokeCanvas.getContext('2d');

    bctx.fillStyle = opt.baseColor || '#f4f7fb';
    bctx.fillRect(0, 0, size, size);
    if (opt.base) {   // 底图：上游贴图（dataURL / canvas / img）
      const img = opt.base;
      bctx.drawImage(img, 0, 0, size, size);
    }
    function redrawView() {
      vctx.drawImage(baseCanvas, 0, 0);
      vctx.drawImage(paintCanvas, 0, 0);
      if (tex) tex.needsUpdate = true;
    }

    /* --- 三件套 --- */
    const rd = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    rd.setPixelRatio(1);
    rd.setSize(view, view, false);
    rd.setClearColor(new THREE.Color('#16181c'), 1);
    rd.domElement.style.width = '100%';
    rd.domElement.style.height = '100%';
    rd.domElement.style.display = 'block';
    rd.domElement.style.touchAction = 'none';
    host.appendChild(rd.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const l1 = new THREE.DirectionalLight(0xffffff, 0.5); l1.position.set(2, 4, 5); scene.add(l1);
    const l2 = new THREE.DirectionalLight(0xffffff, 0.25); l2.position.set(-3, 2, -4); scene.add(l2);

    const tex = new THREE.CanvasTexture(viewCanvas);
    tex.anisotropy = 4;
    const baseTex = new THREE.CanvasTexture(baseCanvas);

    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.9, metalness: 0, side: THREE.DoubleSide
    });
    /* 草稿层实时预览：把 strokeCanvas 按屏幕坐标叠到表面。
     * 朝向剔除：背面 + 掠射角淡出（近似的遮挡预览，权威剔除在烘焙的深度测试里）。 */
    const strokeTex = new THREE.CanvasTexture(strokeCanvas);
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uStroke = { value: strokeTex };
      sh.uniforms.uBase = { value: baseTex };
      sh.uniforms.uViewPx = { value: new THREE.Vector2(view, view) };
      sh.uniforms.uErase = { value: st.erase ? 1 : 0 };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'uniform sampler2D uStroke;',
          'uniform sampler2D uBase;',
          'uniform vec2 uViewPx;',
          'uniform float uErase;'
        ].join('\n'))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          '{',
          '  vec4 s = texture2D(uStroke, gl_FragCoord.xy / uViewPx);',
          '  float facing = dot(normalize(vNormal), normalize(vViewPosition));',
          '  s.a *= smoothstep(0.0, 0.35, facing);',
          '  if (s.a > 0.001) {',
          '#ifdef USE_MAP',
          '    vec3 baseC = texture2D(uBase, vUv).rgb;',
          '#else',
          '    vec3 baseC = vec3(0.957, 0.968, 0.984);',
          '#endif',
          '    vec3 want = mix(s.rgb, baseC, uErase);',
          '    diffuseColor.rgb = mix(diffuseColor.rgb, want, s.a);',
          '  }',
          '}'
        ].join('\n'));
      mat.userData.shader = sh;   // 编译完成后才能动态切 uErase
    };
    const root = a.root;
    root.traverse(o => { if (o.isMesh) o.material = mat; });
    scene.add(root);

    const cam = new THREE.PerspectiveCamera(35, 1, a.radius / 500, a.radius * 40);
    const fitDist = a.radius / Math.tan(35 * Math.PI / 360) * 1.25;
    placeCamera(cam, a.center, fitDist, 0, 4);

    const controls = new THREE.OrbitControls(cam, rd.domElement);
    controls.target.copy(a.center);
    /* 左键留给画笔，右键转视角，中键平移，滚轮缩放 */
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.update();

    /* --- 状态 --- */
    const st = {
      color: opt.color || '#e0533f',
      radius: clamp(Number(opt.radius) || 24, 2, 200),
      hardness: clamp(opt.hardness == null ? 0.7 : opt.hardness, 0, 1),
      erase: !!opt.eraser,
      painting: false,
      last: null,
      strokes: 0,
      undoStack: [],
      disposed: false,
      onChange: null
    };

    function setEraseUniform(v) {
      if (mat.userData.shader) mat.userData.shader.uniforms.uErase.value = v ? 1 : 0;
    }

    function pushUndo() {
      const c = mkCanvas(size, size);
      c.getContext('2d').drawImage(paintCanvas, 0, 0);
      st.undoStack.push(c);
      if (st.undoStack.length > 12) st.undoStack.shift();
    }

    function bakeStroke() {
      if (!sctxStrokeDirty) return;
      /* ⚠ TexPaint.srcCache 按 src 引用缓存内容快照：草稿画布一直在变，
       * 直接传会被当成「同一张图」用旧内容烘焙。每次先复制一份快照。 */
      const snap = mkCanvas(view, view);
      snap.getContext('2d').drawImage(strokeCanvas, 0, 0);
      const r = TexPaint.bakeProject({
        scene, camera: cam, src: snap,
        size, viewSize: view,
        renderer: rd,
        useSrcAlpha: true, feather: 0,
        screenRect: { x: 0, y: 0, w: view, h: view }
      });
      if (st.erase) {
        pctx.globalCompositeOperation = 'destination-out';
        pctx.drawImage(r.canvas, 0, 0);
        pctx.globalCompositeOperation = 'source-over';
      } else {
        pctx.drawImage(r.canvas, 0, 0);
      }
      sctx.clearRect(0, 0, view, view);
      strokeTex.needsUpdate = true;
      redrawView();
      st.strokes++;
      sctxStrokeDirty = false;
      if (st.onChange) st.onChange({ strokes: st.strokes, painted: r.painted });
    }

    let sctxStrokeDirty = false;

    /* --- 指针：左键画，右键交给 OrbitControls --- */
    function evPos(e) {
      const rc = rd.domElement.getBoundingClientRect();
      return [clamp(e.clientX - rc.left, 0, view - 1), clamp(e.clientY - rc.top, 0, view - 1)];
    }
    rd.domElement.addEventListener('contextmenu', e => e.preventDefault());
    rd.domElement.addEventListener('pointerdown', e => {
      if (st.disposed || e.button !== 0 || e.pointerType === 'touch') return;
      st.painting = true;
      st.last = evPos(e);
      pushUndo();
      dab(sctx, st.last[0], st.last[1], st.radius, st.hardness, st.erase ? '#ffffff' : st.color);
      sctxStrokeDirty = true;
      strokeTex.needsUpdate = true;
      try { rd.domElement.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    rd.domElement.addEventListener('pointermove', e => {
      if (!st.painting || st.disposed) return;
      const p = evPos(e);
      dabLine(sctx, st.last[0], st.last[1], p[0], p[1], st.radius, st.hardness, st.erase ? '#ffffff' : st.color);
      st.last = p;
      sctxStrokeDirty = true;
      strokeTex.needsUpdate = true;
      e.preventDefault();
    });
    function endPaint() {
      if (!st.painting) return;
      st.painting = false;
      bakeStroke();
      setEraseUniform(st.erase);
    }
    rd.domElement.addEventListener('pointerup', endPaint);
    rd.domElement.addEventListener('pointercancel', endPaint);
    rd.domElement.addEventListener('pointerleave', endPaint);

    /* --- 渲染循环 --- */
    function loop() {
      if (st.disposed) return;
      requestAnimationFrame(loop);
      controls.update();
      rd.render(scene, cam);
    }
    loop();
    redrawView();

    /* --- 公开 API --- */
    const ctl = {
      viewCanvas, paintCanvas, baseCanvas, size,
      get strokeCount() { return st.strokes; },
      get undoDepth() { return st.undoStack.length; },
      setColor(c) { st.color = String(c || '#e0533f'); },
      setRadius(px) { st.radius = clamp(Number(px) || 24, 2, 200); },
      setHardness(h) { st.hardness = clamp(Number(h) || 0, 0, 1); },
      setEraser(v) { st.erase = !!v; setEraseUniform(st.erase); },
      undo() {
        const c = st.undoStack.pop();
        if (!c) return false;
        pctx.clearRect(0, 0, size, size);
        pctx.drawImage(c, 0, 0);
        redrawView();
        return true;
      },
      exportPNG() { return viewCanvas.toDataURL('image/png'); },
      /* 当前视角/指定方位角的渲染快照 */
      snapshot(az, el) {
        const keep = cam.position.clone(), tgt = controls.target.clone();
        placeCamera(cam, a.center, fitDist, az == null ? null : az, el == null ? 4 : el);
        rd.render(scene, cam);
        const url = rd.domElement.toDataURL('image/png');
        cam.position.copy(keep); controls.target.copy(tgt); controls.update();
        return url;
      },
      /* 确定性笔画回放（AI 与测试共用）：返回统计 */
      async applyStrokes(list) {
        if (!Array.isArray(list)) throw new Error('笔画需要是数组');
        let baked = 0;
        const saved = { color: st.color, radius: st.radius, hardness: st.hardness, erase: st.erase };
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (!s || !Array.isArray(s.pts) || s.pts.length < 1) continue;
          const c = s.cam || {};
          /* el 缺省 4：与 mount 初始取景、ctl.snapshot 的缺省一致。
           * ⚠ placeCamera 内部缺省是 0，直接透传会让「照抄取景图出笔画」的 AI 偏 4° 仰角。 */
          placeCamera(cam, a.center, Number(c.dist) || fitDist, c.az, c.el == null ? 4 : c.el);
          controls.target.copy(a.center);
          controls.update();
          pushUndo();
          st.color = s.color || saved.color;
          st.radius = clamp(Number(s.radius) || saved.radius, 2, 200);
          st.hardness = clamp(s.hardness == null ? saved.hardness : s.hardness, 0, 1);
          st.erase = !!s.erase;
          setEraseUniform(st.erase);
          const col = st.erase ? '#ffffff' : st.color;
          dab(sctx, s.pts[0][0], s.pts[0][1], st.radius, st.hardness, col);
          for (let k = 1; k < s.pts.length; k++) {
            dabLine(sctx, s.pts[k - 1][0], s.pts[k - 1][1], s.pts[k][0], s.pts[k][1], st.radius, st.hardness, col);
          }
          strokeTex.needsUpdate = true;
          sctxStrokeDirty = true;
          bakeStroke();
          baked++;
        }
        st.color = saved.color; st.radius = saved.radius; st.hardness = saved.hardness; st.erase = saved.erase;
        setEraseUniform(st.erase);
        return { strokes: baked, view: [view, view], size };
      },
      dispose() {
        st.disposed = true;
        try { controls.dispose(); } catch (e) {}
        try { rd.dispose(); } catch (e) {}
        try { rd.forceContextLoss && rd.forceContextLoss(); } catch (e) {}
        if (rd.domElement.parentNode) rd.domElement.parentNode.removeChild(rd.domElement);
        tex.dispose(); baseTex.dispose(); strokeTex.dispose();
      }
    };
    return ctl;
  }

  /* ---------------- 交互弹窗（index.html 的 #paintBackdrop） ----------------
   * open(opt) → Promise<{ texture, image, strokes }>；取消 reject('用户取消') */

  let modalCtl = null;

  function openInteractive(opt) {
    const $ = id => document.getElementById(id);
    if (!$('paintBackdrop')) return Promise.reject(new Error('笔刷弹窗不存在（index.html 缺少 paintBackdrop）'));
    $('paintBackdrop').classList.remove('hidden');

    const host = $('paintHost');
    host.innerHTML = '';
    modalCtl = mount(host, opt);

    const mini = $('paintTexMini').getContext('2d');
    function drawMini() { mini.drawImage(modalCtl.viewCanvas, 0, 0, 200, 200); }
    modalCtl.onChange = drawMini;
    drawMini();

    $('paintColor').value = opt.color || '#e0533f';
    $('paintRadius').value = opt.radius || 24;
    $('paintHard').value = Math.round((opt.hardness == null ? 0.7 : opt.hardness) * 100);
    $('paintMode').value = opt.eraser ? 'erase' : 'paint';
    modalCtl.setColor($('paintColor').value);
    modalCtl.setRadius($('paintRadius').value);
    modalCtl.setHardness($('paintHard').value / 100);
    modalCtl.setEraser($('paintMode').value === 'erase');

    function bindVal(inputId, labelId, fn, fmt) {
      const el = $(inputId);
      el.oninput = () => { $(labelId).textContent = fmt(el.value); fn(el.value); };
    }
    bindVal('paintRadius', 'paintRadiusVal', v => modalCtl.setRadius(v), v => v);
    bindVal('paintHard', 'paintHardVal', v => modalCtl.setHardness(v / 100), v => v + '%');
    $('paintColor').oninput = e => modalCtl.setColor(e.target.value);
    $('paintMode').onchange = e => modalCtl.setEraser(e.target.value === 'erase');
    $('paintUndo').onclick = () => { modalCtl.undo(); drawMini(); };

    function close() {
      $('paintBackdrop').classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      if (modalCtl) { modalCtl.dispose(); modalCtl = null; }
    }
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (modalCtl) { modalCtl.undo(); drawMini(); }
      }
    }
    document.addEventListener('keydown', onKey);

    return new Promise((resolve, reject) => {
      $('paintDone').onclick = () => {
        if (!modalCtl) return;
        const r = { texture: modalCtl.exportPNG(), strokes: modalCtl.strokeCount };
        close();
        resolve(r);
      };
      const cancel = () => { close(); reject(new Error('用户取消')); };
      $('paintCancel').onclick = cancel;
      $('paintClose').onclick = cancel;
      $('paintBackdrop').onpointerdown = e => {
        if (e.target === $('paintBackdrop')) cancel();
      };
    });
  }

  /* dataURL / URL → Image（mount 的 opt.base 要的是可 drawImage 的对象） */
  function loadImage(src) {
    if (src && src.width && src.height) return Promise.resolve(src);   // 已是 img/canvas
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('底图加载失败'));
      img.src = src;
    });
  }

  /* ---------------- 取景摆拍：给 AI 看的「坐标系基准图」 ----------------
   * 用与笔刷完全相同的相机公式渲染一张正面图 + 元数据。
   * AI 看这张图出笔画 JSON，坐标天然对齐（像素、左上原点、view×view 正方形）。
   * 默认叠岛编号标注 + meta.screen（岛质心的屏幕像素映射），AI 不用做任何投影计算。 */
  async function stage(opt) {
    const a = opt.a;
    const view = clamp(Math.trunc(opt.view || 720), 256, 2048);
    const az = opt.az == null ? 0 : opt.az;
    const el = opt.el == null ? 4 : opt.el;
    const host = document.createElement('div');
    const ctl = mount(host, Object.assign({}, opt, { view }));
    let raw;
    try { raw = ctl.snapshot(az, el); } finally { ctl.dispose(); }
    const dist = a.radius / Math.tan(35 * Math.PI / 360) * 1.25;   // 与 mount 的 fitDist 同式

    /* 岛元数据（面积 top N）+ 质心屏幕投影（与渲染相机同公式） */
    const TOPN = opt.topN || 120;
    const islMeta = a.islands.slice(0, TOPN).map(o => ({
      id: o.id, area: +o.area.toFixed(4),
      centroid: o.centroid.map(v => +v.toFixed(2)),
      bbox: o.bbox.map(v => +v.toFixed(2))
    }));
    const { THREE } = window;
    const cam = new THREE.PerspectiveCamera(35, 1, a.radius / 500, a.radius * 40);
    const A = az * Math.PI / 180, E = el * Math.PI / 180;
    cam.position.set(
      a.center.x + Math.sin(A) * Math.cos(E) * dist,
      a.center.y + Math.sin(E) * dist,
      a.center.z + Math.cos(A) * Math.cos(E) * dist);
    cam.lookAt(a.center); cam.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const screen = [];
    islMeta.forEach(o => {
      v.set(o.centroid[0], o.centroid[1], o.centroid[2]).project(cam);
      if (v.z > 1) return;                                       // 相机背后
      const px = Math.round((v.x * 0.5 + 0.5) * view), py = Math.round((0.5 - v.y * 0.5) * view);
      if (px < -20 || py < -20 || px > view + 20 || py > view + 20) return;
      screen.push({ id: o.id, px, py });
    });

    /* 叠岛编号标注（opt.labels 显式 false 关闭） */
    let image = raw;
    if (opt.labels !== false) {
      const c = document.createElement('canvas');
      c.width = view; c.height = view;
      const ctx = c.getContext('2d');
      ctx.drawImage(await awaitImg(raw), 0, 0);
      ctx.font = '600 13px system-ui,"Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      screen.forEach(s => {
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(s.id, s.px, s.py);
        ctx.fillStyle = '#ffe14d'; ctx.fillText(s.id, s.px, s.py);
      });
      image = c.toDataURL('image/png');
    }

    const c = a.center;
    return {
      image,
      meta: {
        view, fov: 35,
        camera: { az, el, dist: +dist.toFixed(2) },
        center: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
        radius: +a.radius.toFixed(2),
        height: +a.h.toFixed(2),
        islands: islMeta,
        screen,
        hint: [
          '这是 3D 模型笔刷视口的取景图。图宽=高=' + view + 'px，笔画坐标就是本图像素坐标，左上为原点、y 向下。',
          '图上黄色数字是 UV 岛编号；meta.screen 是「岛 id → 本图像素坐标」映射（岛 3D 质心的投影，只含本视角可见的岛）。画到某部位：从 screen 找该部位的岛 id 拿像素坐标，或直接在图上目测坐标。',
          '笔画 JSON 数组，每项：{"cam":{"az":' + az + ',"el":' + el + ',"dist":' + dist.toFixed(2) + '},"pts":[[x,y],…],"color":"#十六进制","radius":像素,"hardness":0到1}。',
          'cam 照抄这里的 camera 即可还原本视角；要看背面就把 az 改成 180、左侧 az=90、右侧 az=-90（度，逆时针），el 是仰角。dist 缺省自动取，别随意改。',
          'radius 是屏幕像素半径（笔画在屏幕上的粗细，烘焙时按深度投影）；hardness 0=软边喷枪 1=硬边。擦除加 "erase":true。',
          '画细线时 pts 给密集折线（间距小于 radius 的一半），否则会断点。被遮挡的笔画会被自动剔除，放心画。'
        ].join('\n')
      }
    };
  }

  function awaitImg(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('快照图解码失败'));
      img.src = src;
    });
  }

  window.TexBrush = { mount, openInteractive, stage, loadImage };
})();
