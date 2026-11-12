/* ============================================================
 * 3D 交互预览：视口（openPreview / closePreview）+ 深度像素描边
 *
 * 从 js/model3d.js 拆出（2026-11-01），与它是同一套东西：
 *   - 模型加载、几何、材质这些私有实现仍归 model3d.js，这里通过 global.__m3d 取用；
 *   - 深度描边只被预览用（createDepthOutline），所以跟着视口一起搬。
 * 对外接口不变：Model3D.openPreview / Model3D.closePreview / Model3D.openRefs。
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var M = global.__m3d || {};

  /* model3d.js 的私有实现：只取用，不重写 */
  var ready = M.ready;
  var load = M.load;
  var bufToDataURL = M.bufToDataURL;
  var saveDataURL = M.saveDataURL;
  var baryGeometry = M.baryGeometry;
  var wireMaterial = M.wireMaterial;
  var fillMaterial = M.fillMaterial;
  var pushBackDepth = M.pushBackDepth;
  var addUvSeams = M.addUvSeams;
  var quadViews = M.quadViews;
  var renderThumb = M.renderThumb;

  /* 材质插槽面板在 m3d-slots.js：调用时才从 M 取，文件加载顺序不再是隐式约定 */
  function setupSlotPanel(deps) { return M.setupSlotPanel(deps); }

  /* ---------------- 交互预览 ---------------- */
  var pv = null; // 当前预览实例
  var refOpener = null;   // 当前预览的「打开参考图」动作（没有预览时为 null）

  function closePreview() {
    refOpener = null;      // 视口没了，入口也就没了
    if (!pv) return;
    cancelAnimationFrame(pv.raf);
    try { pv.controls && pv.controls.dispose && pv.controls.dispose(); } catch (e) {}
    /* 深度描边的 RT 和 shader 要一起收：它的 RT 是一个额外的帧缓冲 + 深度纹理，
     * 每次开关预览都漏一份的话，多开几次模型就顶到显存上限 */
    try { pv.dout && pv.dout.dispose && pv.dout.dispose(); } catch (e) {}
    try { pv.renderer.dispose(); } catch (e) {}
    /* 视角立方体是第二个 WebGL 上下文（透明底小画布），单独收 */
    try { pv.vcRenderer && pv.vcRenderer.dispose(); } catch (e) {}
    if (pv.overlay && pv.overlay.parentNode) pv.overlay.parentNode.removeChild(pv.overlay);
    /* 宿主模式（app 内 .os-win 窗口）：藏窗口 + 清空宿主，renderer 不 dispose 会一直占 WebGL 上下文 */
    if (pv.win) {
      try { pv.win.classList.add('hidden'); } catch (e) {}
    }
    if (pv.host) pv.host.innerHTML = '';
    pv = null;
  }

  async function openPreview(src, opts) {
    opts = opts || {};
    if (!ready()) throw new Error('three.js 未就绪');
    closePreview();

    /* 宿主优先（2026-10-30）：工作台里有 #modelViewHost（3D 查看器 .os-win 窗口）就
     * 装进窗口——和图片编辑器同一套窗口隐喻，不再全屏接管整个屏幕。
     * 独立页（multiview.html 等）没有这个宿主，退回全屏遮罩；opts.host 可显式指定容器。 */
    var hostEl = opts.host || document.getElementById('modelViewHost') || null;
    var winEl = hostEl && hostEl.closest ? hostEl.closest('.os-win') : null;
    var overlay = null, panel = null;

    var stage = document.createElement('div');
    stage.style.cssText = 'flex:1;position:relative;background:#0a0b0e;min-height:0;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    stage.appendChild(canvas);

    var bar = document.createElement('div');
    bar.className = 'mv3-bar';
    /* 单行 + 横向滚动：入口按「视角 / 显示 / 检查 / 素材 / 导出」分组（见 mkBarGroup），
     * 不再靠 flex-wrap 折成两行——两行时按钮之间没有关系，扫一眼分不清哪个是视图哪个是工具。 */
    bar.style.cssText = 'flex:0 0 auto;display:flex;flex-wrap:nowrap;align-items:center;gap:2px;' +
      'padding:6px 10px;border-top:1px solid #23262e;background:#111318;overflow-x:auto;overflow-y:hidden;';

    var hint = document.createElement('span');
    hint.style.cssText = 'color:#9aa0b0;font-size:11.5px;white-space:nowrap;';
    hint.textContent = '拖拽旋转 · 滚轮缩放 · 右键平移';
    /* 提示语不占工具条宽度：它是「状态行」（加载中 / N 条接缝 / 已导出），
     * 塞进工具条里会把 20 个入口挤到左边只剩一个省略号。放在画布底部中间当浮条。 */
    var hintBar = document.createElement('div');
    hintBar.style.cssText = 'position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:3;' +
      'pointer-events:none;padding:4px 11px;border-radius:999px;background:rgba(13,15,20,.74);' +
      'border:1px solid #23262e;max-width:70%;overflow:hidden;text-overflow:ellipsis;';
    hintBar.appendChild(hint);
    stage.appendChild(hintBar);

    function mkBtn(text, fn) {
      var b = document.createElement('button');
      b.textContent = text;
      /* 固定 26px 高：和预设胶囊对齐，工具条里所有按钮顶部落在同一条线上 */
      b.style.cssText = 'height:26px;box-sizing:border-box;display:inline-flex;align-items:center;' +
        'justify-content:center;padding:0 10px;border-radius:7px;border:1px solid #2c303a;background:#191c22;' +
        'color:#e8eaf0;cursor:pointer;font:12px/1 inherit;white-space:nowrap;flex:0 0 auto;';
      b.addEventListener('click', fn);
      return b;
    }

    /* 工具条分组：一组功能一个容器，组与组之间一条竖线。
     * 组容器自己不加标签（标签会把本来就不宽的工具条再撑满一屏），靠视觉分栏表达层级。 */
    function mkBarGroup(name) {
      var g = document.createElement('div');
      g.className = 'mv3-grp';
      g.setAttribute('data-grp', name || '');
      /* 第一组不加左边线：视角按钮撤掉后它是工具条起点，留着会变成贴边的一条灰线 */
      g.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:0 8px;' +
        (name && bar.children.length ? 'border-left:1px solid #262a33;' : '');
      bar.appendChild(g);
      return g;
    }
    /* 视角组已撤：前 / 后 / 左 / 右 / 顶 / 轴测 那排按钮换成了视口右上角的视角立方体 */
    var grpLook = mkBarGroup('look');
    var grpCheck = mkBarGroup('check');
    var grpAsset = mkBarGroup('asset');
    var grpExport = mkBarGroup('export');

    /* ---------------- 右侧 dock ----------------
     * 材质插槽 / 参考图共用右侧这一块：同一位置、同一宽度，打开一个必收起另一个。
     * 之前它们各自绝对定位（right:0 / right:10），同时打开时参考图正好压在纹理混合上。 */
    var dockEl = document.createElement('div');
    dockEl.className = 'mv3-dock';
    dockEl.setAttribute('data-mv3-dock', '1');
    dockEl.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:340px;max-width:88%;z-index:5;' +
      'display:none;flex-direction:column;min-height:0;background:rgba(13,15,20,.97);' +
      'border-left:1px solid #23262e;box-shadow:-12px 0 28px rgba(0,0,0,.35);';
    stage.appendChild(dockEl);
    var dockCur = '';
    function dockShow(name) { dockCur = name || ''; dockEl.style.display = 'flex'; }
    function dockHide(name) {
      /* 指定 name 时只关自己那一页：避免「关参考图把刚打开的材质面板一起关掉」 */
      if (name && dockCur && dockCur !== name) return;
      dockCur = '';
      dockEl.style.display = 'none';
    }

    if (hostEl) {
      /* chrome:false —— 宿主自己带标题栏/关闭按钮（例如嵌在模型库 App 里），
       * 这里就只管渲染本体，不去改外层窗口的标题和关闭行为。 */
      hostEl.innerHTML = '';
      hostEl.appendChild(stage);
      hostEl.appendChild(bar);
      if (opts.chrome !== false) {
        var tEl = winEl && winEl.querySelector('.os-win-title');
        if (tEl) tEl.textContent = opts.title || '3D 预览';
        if (winEl) winEl.classList.remove('hidden');
        /* onclick 覆盖赋值而不是 addEventListener：重复打开不会叠出一排旧监听 */
        var xBtn = winEl && winEl.querySelector('.os-win-close');
        if (xBtn) xBtn.onclick = closePreview;
      }
    } else {
      overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(6,7,10,.86);' +
        'display:flex;align-items:center;justify-content:center;padding:24px;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e8eaf0;';

      panel = document.createElement('div');
      panel.style.cssText = 'width:min(1100px,96vw);height:min(760px,92vh);background:#111318;border:1px solid #23262e;' +
        'border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5);';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var title = document.createElement('div');
      title.style.cssText = 'font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      title.textContent = opts.title || '3D 预览';
      head.appendChild(title);

      var closeBtn = mkBtn('关闭', closePreview);
      head.appendChild(closeBtn);
      overlay.appendChild(panel);
      panel.appendChild(head);
      panel.appendChild(stage);
      panel.appendChild(bar);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePreview(); });
      document.body.appendChild(overlay);
    }

    hint.textContent = '正在加载模型…';

    var model;
    try {
      model = await load(src);
    } catch (e) {
      hint.textContent = '加载失败：' + (e && e.message);
      hint.style.color = '#e05252';
      throw e;
    }

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.debug.checkShaderErrors = false;
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));

    var scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0b0e');
    /* 贴图是 sRGB 的，渲染器不声明 outputEncoding 就会把线性值直接当显示值输出 ——
     * 表现就是「模型发灰发暗，跟原画不是一个颜色」。这一行是颜色正确的前提。 */
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    /* 三盏灯而不是一盏：主光给形，补光把暗面提起来（否则白模/哑光一片死黑，看不出形体），
     * 背光勾一圈轮廓，模型边缘不会糊进深色背景里。 */
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    var dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(1, 1.2, 1);
    scene.add(dir);
    var fill = new THREE.DirectionalLight(0xdce6ff, 0.45);
    fill.position.set(-1.1, 0.5, 0.7);
    scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(0.2, 0.6, -1.2);
    scene.add(rim);

    /* near / far 跟着模型尺度走，别抄 0.01 / 1000 这种默认值。
     * 原因不只是近裁面：**深度精度由 near 决定**——透视深度的有效位几乎全压在 near 附近那一小段，
     * near=0.01 而模型上千单位时，1000 米处的深度已经写着 0.99999，
     * 24 位深度纹理的 1 个台阶反算回线性深度就是 6 个世界单位。
     * 深度描边（1 像素 ≈ 0.8 单位）会把同一块平面上的相邻像素全判成「深度断裂」，
     * 整只模型被描黑。near = radius/100 之后量化误差降到 0.05 单位，问题消失。
     * far 收到 radius*50：相机最远也就在 radius*3 附近，留 50 倍余量足够。 */
    var camNear = Math.max(model.radius / 100, 0.001);
    var camFar = Math.max(model.radius * 50, 100);
    var camera = new THREE.PerspectiveCamera(45, 1, camNear, camFar);
    var d0 = model.radius * 3;
    camera.position.set(model.center.x + d0 * 0.6, model.center.y + d0 * 0.45, model.center.z + d0 * 0.9);

    var controls = new THREE.OrbitControls(camera, canvas);
    controls.target.copy(model.center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    /* ---------------- 视角立方体（ViewCube） ----------------
     * 工具条里那排「前 / 后 / 左 / 右 / 顶 / 轴测」换成建模软件那种立方体：
     * 右上角一小块独立画布，立方体跟着主相机同步朝向——拖它 = 绕模型翻转，点某个面 = 正对那个视角。
     * 为什么另开一个 renderer/scene：主 scene 在「线框」模式会把背景刷成白色，
     * 立方体放进去会跟着变白、还可能挡住模型；小画布透明底叠在视口上，任何时候都读得清。
     * 材质顺序跟 BoxGeometry 一致：+X / -X / +Y / -Y / +Z / -Z。 */
    var VC_FACES = [
      { axes: [1, 0, 0],  label: '右' },
      { axes: [-1, 0, 0], label: '左' },
      { axes: [0, 1, 0],  label: '顶' },
      { axes: [0, -1, 0], label: '底' },
      { axes: [0, 0, 1],  label: '前' },
      { axes: [0, 0, -1], label: '后' }
    ];
    var VC_SIZE = 92;

    function vcFaceTexture(label) {
      var c = document.createElement('canvas');
      c.width = c.height = 128;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0, '#f7f9fc'); g.addColorStop(1, '#dbe2ec');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      x.strokeStyle = '#aeb8c6'; x.lineWidth = 6;
      x.strokeRect(3, 3, 122, 122);
      x.fillStyle = '#242a33';
      x.font = '600 42px system-ui,"Microsoft YaHei",sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(label, 64, 66);
      var t = new THREE.CanvasTexture(c);
      if ('encoding' in t) t.encoding = THREE.sRGBEncoding;
      return t;
    }

    var vcBox = document.createElement('div');
    vcBox.className = 'mv3-vcube';
    vcBox.title = '拖拽翻转视角 · 点面切到正视角 · 双击回到轴测';
    vcBox.style.cssText = 'position:absolute;right:12px;top:12px;width:' + VC_SIZE + 'px;height:' + VC_SIZE + 'px;' +
      'z-index:4;border-radius:10px;background:rgba(15,17,22,.82);border:1px solid #2c303a;' +
      'box-shadow:0 8px 22px rgba(0,0,0,.38);cursor:grab;touch-action:none;user-select:none;overflow:hidden;';
    stage.appendChild(vcBox);

    var vcCanvas = document.createElement('canvas');
    vcCanvas.style.cssText = 'display:block;width:100%;height:100%;';
    vcBox.appendChild(vcCanvas);
    var vcRenderer = new THREE.WebGLRenderer({ canvas: vcCanvas, antialias: true, alpha: true });
    vcRenderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    vcRenderer.setSize(VC_SIZE, VC_SIZE, false);
    vcRenderer.setClearAlpha(0);
    if ('outputEncoding' in vcRenderer) vcRenderer.outputEncoding = THREE.sRGBEncoding;

    var vcScene = new THREE.Scene();
    var vcCam = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    vcCam.position.set(0, 0, 4.4);
    vcCam.lookAt(0, 0, 0);
    vcScene.add(new THREE.AmbientLight(0xffffff, 0.95));
    var vcKey = new THREE.DirectionalLight(0xffffff, 0.75);
    vcKey.position.set(-1.4, 1.8, 2.4);
    vcScene.add(vcKey);

    var vcGroup = new THREE.Group();
    vcScene.add(vcGroup);
    var vcMats = VC_FACES.map(function (f) {
      return new THREE.MeshStandardMaterial({ map: vcFaceTexture(f.label), roughness: 1, metalness: 0 });
    });
    var vcCube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), vcMats);
    vcGroup.add(vcCube);
    vcGroup.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(vcCube.geometry),
      new THREE.LineBasicMaterial({ color: 0x8c96a6 })
    ));

    /* 立方体是「世界坐标轴的屏幕朝向」：取主相机朝向的逆，模型怎么转它就怎么转 */
    var vcQ = new THREE.Quaternion();
    function vcDraw() {
      vcQ.copy(camera.quaternion).conjugate();
      vcGroup.quaternion.copy(vcQ);
      vcRenderer.render(vcScene, vcCam);
    }

    var vcRay = new THREE.Raycaster();
    var vcPtr = null;       // 拖动状态：pointerdown 后才有
    var vcHover = -1;
    var vcTween = null;     // 点面后的 240ms 补间；用户一拖就取消

    function vcPick(e) {
      var r = vcCanvas.getBoundingClientRect();
      if (!r.width || !r.height) return -1;
      vcGroup.updateMatrixWorld(true);
      vcRay.setFromCamera(new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      ), vcCam);
      var hit = vcRay.intersectObject(vcCube, false)[0];
      return (hit && hit.face) ? hit.face.materialIndex : -1;
    }
    function vcTint(i) {
      vcMats.forEach(function (m, k) { m.color.setHex(k === i ? 0xffe3a8 : 0xffffff); });
    }
    function vcStopTween() { vcTween = null; }

    /* 拖立方体 = 绕模型转：直接改球坐标，再让 OrbitControls 按新位置重算目标朝向 */
    function vcOrbit(dx, dy) {
      vcStopTween();
      var sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      sph.theta -= dx * 0.01;
      sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi - dy * 0.01));
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      controls.update();
    }

    /* 点面 / 双击回轴测：把相机放到那个轴上，距离沿用 radius*3（和原来按钮的尺度一致） */
    function vcGo(axes) {
      vcStopTween();
      var d = model.radius * 3;
      var to = new THREE.Vector3(
        model.center.x + axes[0] * d,
        model.center.y + axes[1] * d,
        model.center.z + axes[2] * d
      );
      var from = camera.position.clone();
      var t0 = performance.now();
      vcTween = function () {
        var k = Math.min(1, (performance.now() - t0) / 240);
        k = 1 - Math.pow(1 - k, 3);
        camera.position.lerpVectors(from, to, k);
        controls.update();
        if (k >= 1) vcTween = null;
      };
    }

    vcBox.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      vcPtr = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
      vcStopTween();
      try { vcBox.setPointerCapture(e.pointerId); } catch (err) {}
      vcBox.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    });
    vcBox.addEventListener('pointermove', function (e) {
      if (!vcPtr) {
        var i = vcPick(e);
        if (i !== vcHover) { vcHover = i; vcTint(i); }
        vcBox.style.cursor = i >= 0 ? 'pointer' : 'grab';
        return;
      }
      var dx = e.clientX - vcPtr.x, dy = e.clientY - vcPtr.y;
      vcPtr.x = e.clientX; vcPtr.y = e.clientY;
      vcPtr.moved += Math.abs(dx) + Math.abs(dy);
      vcOrbit(dx, dy);
      e.preventDefault();
      e.stopPropagation();
    });
    function vcEnd(e) {
      if (!vcPtr) return;
      var dragged = vcPtr.moved > 6;
      var id = vcPtr.id;
      vcPtr = null;
      vcBox.style.cursor = 'grab';
      try { vcBox.releasePointerCapture(id); } catch (err) {}
      if (!dragged && e.type === 'pointerup') {
        var i = vcPick(e);
        if (i >= 0) vcGo(VC_FACES[i].axes);
      }
      e.preventDefault();
      e.stopPropagation();
    }
    vcBox.addEventListener('pointerup', vcEnd);
    vcBox.addEventListener('pointercancel', vcEnd);
    vcBox.addEventListener('pointerleave', function () {
      if (!vcPtr && vcHover >= 0) { vcHover = -1; vcTint(-1); }
    });
    /* 轴测视角没有自己的按钮了，双击立方体就是「回到默认角度看全身」 */
    vcBox.addEventListener('dblclick', function (e) {
      vcGo([0.7, 0.5, 0.78]);
      e.preventDefault();
      e.stopPropagation();
    });


    var wireGroup = null, matGroup = null;
    matGroup = model.root;
    scene.add(matGroup);

    // 线框组（懒构建，切到线框模式时才生成）
    function ensureWire() {
      if (wireGroup) return wireGroup;
      wireGroup = new THREE.Group();
      var fillMat = fillMaterial('#ffffff', 1);
      var wireMat = wireMaterial(2.0, '#2b2b2b');
      model.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        var m = new THREE.Matrix4().copy(o.matrixWorld);
        var f = new THREE.Mesh(o.geometry, fillMat); f.matrixAutoUpdate = false; f.matrix.copy(m);
        var w = new THREE.Mesh(baryGeometry(o.geometry), wireMat); w.matrixAutoUpdate = false; w.matrix.copy(m);
        wireGroup.add(f); wireGroup.add(w);
      });
      return wireGroup;
    }

    var curMode = 'material';
    function setMode(m) {
      curMode = m;
      if (m === 'wire') {
        scene.remove(matGroup);
        scene.add(ensureWire());
        scene.background = new THREE.Color('#ffffff');
      } else {
        if (wireGroup) scene.remove(wireGroup);
        scene.add(matGroup);
        scene.background = new THREE.Color('#0a0b0e');
      }
    }

    grpLook.appendChild(mkBtn('实体 / 线框', function () { setMode(curMode === 'wire' ? 'material' : 'wire'); }));

    /* ---------------- 预览材质（只影响「怎么看」） ----------------
     * 换的是 mesh.material 这张皮，几何 / 贴图 / 文件都不动；原件挂在 mesh.userData.__origMat 上，
     * 切回「原始」原样放回（含贴图插槽面板改过的那份，所以来回切不会丢编辑）。
     * 为什么需要几个预设：
     *   贴图会把结构问题盖住（腿歪一点、肩不对称，上色后完全看不出来）→ 白模 / 哑光用来量形体；
     *   平涂去掉光照，只剩贴图本色 → 判断颜色是否过曝 / 偏色最直接；
     *   法线一眼看出 UV 接缝和翻面。 */
    var MAT_PRESETS = [
      { key: 'original', label: '原始贴图' },
      { key: 'clay', label: '白模' },
      { key: 'matte', label: '哑光灰' },
      { key: 'metal', label: '金属' },
      { key: 'flat', label: '平涂' },
      { key: 'normal', label: '法线' }
    ];
    var curPreset = 'original';
    var presetCache = {};      // key -> Map(mesh.uuid -> material)，flat 要按 mesh 的贴图各做一份
    var envTex = null;

    /* 金属没有环境贴图就是一坨黑：现场烘一张 64×32 的等距柱状渐变当环境光，
     * 只在选「金属」时挂到 scene.environment，切走就摘掉（不影响别的预设的观感）。 */
    function ensureEnv() {
      if (envTex) return envTex;
      var c = document.createElement('canvas');
      c.width = 64; c.height = 32;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 0, 32);
      g.addColorStop(0, '#e9eef7'); g.addColorStop(0.45, '#8f97a6'); g.addColorStop(1, '#2a2f38');
      x.fillStyle = g; x.fillRect(0, 0, 64, 32);
      var hot = x.createRadialGradient(46, 8, 0, 46, 8, 14);
      hot.addColorStop(0, 'rgba(255,252,240,.95)'); hot.addColorStop(1, 'rgba(255,252,240,0)');
      x.fillStyle = hot; x.fillRect(0, 0, 64, 32);
      envTex = new THREE.CanvasTexture(c);
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      if ('encoding' in envTex) envTex.encoding = THREE.sRGBEncoding;
      return envTex;
    }

    function makePresetMat(key, origMat) {
      var m;
      if (key === 'clay') {
        m = new THREE.MeshStandardMaterial({ color: 0xe7e3dc, metalness: 0, roughness: 0.62, side: THREE.FrontSide });
      } else if (key === 'matte') {
        m = new THREE.MeshStandardMaterial({ color: 0x9aa3af, metalness: 0, roughness: 0.85 });
      } else if (key === 'metal') {
        m = new THREE.MeshStandardMaterial({ color: 0xd6dae2, metalness: 1, roughness: 0.26 });
      } else if (key === 'flat') {
        /* 平涂必须带各自的 map，否则全白什么都看不出来 */
        m = new THREE.MeshBasicMaterial({ map: (origMat && origMat.map) || null });
      } else if (key === 'normal') {
        m = new THREE.MeshNormalMaterial();
      }
      if (m && origMat) {
        m.transparent = !!origMat.transparent;
        m.side = origMat.side != null ? origMat.side : THREE.FrontSide;
      }
      return m;
    }

    function applyPreset(key) {
      if (!matGroup) return;
      curPreset = key;
      if (key === 'original') {
        matGroup.traverse(function (o) {
          if (o.isMesh && o.userData && o.userData.__origMat) {
            o.material = o.userData.__origMat;
            delete o.userData.__origMat;
          }
        });
        scene.environment = null;
      } else {
        if (!presetCache[key]) presetCache[key] = {};
        var cache = presetCache[key];
        matGroup.traverse(function (o) {
          if (!o.isMesh || !o.material) return;
          if (!o.userData.__origMat) o.userData.__origMat = o.material;
          var pick = cache[o.uuid];
          if (!pick) {
            pick = cache[o.uuid] = makePresetMat(key, o.userData.__origMat);
          }
          o.material = pick;
        });
        scene.environment = (key === 'metal') ? ensureEnv() : null;
      }
      /* 线框模式和材质预设是两个维度：开着线框时切预设，把用户拉回实体，
       * 否则点半天没反应（线框组本来就不吃材质）。 */
      if (curMode === 'wire') setMode('material');
      syncPresetChips();
      /* 换预设 = 换了一批新材质（没打 polygonOffset），描边会被面咬掉，重推一次 */
      if (seamMesh) pushBackDepth(scene);
    }

    function syncPresetChips() {
      for (var i = 0; i < presetBtns.length; i++) {
        var b = presetBtns[i];
        b.classList.toggle('on', b.getAttribute('data-mv-preset') === curPreset);
      }
    }

    var presetRow = document.createElement('div');
    presetRow.className = 'mv3-presets';
    var presetBtns = [];
    MAT_PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mv3-preset';
      b.setAttribute('data-mv-preset', p.key);
      b.textContent = p.label;
      b.addEventListener('click', function () { applyPreset(p.key); });
      presetRow.appendChild(b);
      presetBtns.push(b);
    });
    grpLook.appendChild(presetRow);
    syncPresetChips();

    /* ---------------- UV 描边（3D 视口里的开关） ----------------
     * 只加一层线，不动材质、不进预设——它是「怎么看」的东西（检查展 UV / 找翻面接缝）。
     * 描边几何按需算（扫一遍模型的所有三角形），关掉就 dispose，不常驻。 */
    var seamMesh = null, seamBtn = null;
    function toggleSeam() {
      if (seamMesh) {
        scene.remove(seamMesh);
        try { seamMesh.geometry.dispose(); seamMesh.material.dispose(); } catch (e) {}
        seamMesh = null;
        if (seamBtn) { seamBtn.style.borderColor = '#2c303a'; seamBtn.style.color = '#e8eaf0'; }
        hint.textContent = 'UV 描边已关闭';
        return;
      }
      var dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
      var dpr = renderer.getPixelRatio() || 1;
      var r = addUvSeams(scene, model, {
        lineWidth: 2.4 * dpr, lineColor: '#ff2d78', res: [dbs.x, dbs.y]
      });
      seamMesh = r.mesh;
      if (!seamMesh) {
        hint.textContent = r.hasUV ? '这个模型没有 UV 接缝（整片 UV 连着）' : '模型没有 UV，画不出 UV 岛';
        return;
      }
      if (seamBtn) { seamBtn.style.borderColor = '#a3345e'; seamBtn.style.color = '#ffb3cd'; }
      hint.textContent = 'UV 描边：' + r.edges + ' 条接缝';
    }
    seamBtn = mkBtn('UV 描边', toggleSeam);
    grpCheck.appendChild(seamBtn);


    /* 参考图面板的实例（同一时刻只留一个，和材质插槽共用右侧 dock） */
    var refPanelEl = null;
    function closeRefsPanel() {
      if (refPanelEl && refPanelEl.parentNode) refPanelEl.parentNode.removeChild(refPanelEl);
      refPanelEl = null;
      dockHide('refs');
    }

    /* 材质插槽面板：模型库「设置贴图」的入口（插槽列表 / 选图 / 导出 GLB） */
    var slotUI = setupSlotPanel({
      model: model, stage: stage, bar: bar, mkBtn: mkBtn, hint: hint, title: opts.title, assetId: opts.assetId,
      /* 面板挂进右侧 dock，工具条里的入口也塞进「素材」组 */
      dock: dockEl, barAsset: grpAsset,
      /* 手绘遮罩要往模型上打射线：相机 / 操控器 / 画布都交出去，渲染循环仍归这里管 */
      renderer: renderer, camera: camera, controls: controls, canvas: canvas,
      /* 打开插槽面板：退出 UV、收起参考图、回到原始贴图。
       * 右侧同一块地方只留一个面板，否则「参考图压着纹理混合」。 */
      onPanelOpen: function () {
        if (uv && uv.on) uvClose();
        closeRefsPanel();
        dockShow('slots');
        /* 换贴图要在「原始贴图」下看，否则白模/平涂顶着，改完毫无反馈 */
        if (curPreset !== 'original') applyPreset('original');
      },
      onPanelClose: function () { dockHide('slots'); },
      /* 直接开画时也要回到原始贴图：白模/平涂下看不见混合结果，画了没反馈 */
      onEditStart: function () {
        closeRefsPanel();
        if (curPreset !== 'original') applyPreset('original');
      }
    });

    /* 参考图：结构参考 + 着色参考，存在资产库里（见 js/model-refs.js）。
     * 这里只挂一个入口；面板自己管上传 / 清除 / 发到 AI 对话。 */
    if (global.ModelRefs && opts.assetId) {
      /* 打开动作抽成具名函数：按钮点击和「模型库磁贴上的参考入口」走同一条路。
       * 不要再经由 refBtn.click() 转发——宿主重绘时旧按钮会脱链（isConnected 为 false），
       * 点了个空。 */
      var openRefPanel = function () {
        if (uv && uv.on) uvClose();
        slotUI.hide();                 // 材质插槽让位（它关的时候会顺手 dockHide）
        refPanelEl = global.ModelRefs.panel(dockEl, {
          modelId: opts.assetId,
          modelName: opts.title || '',
          onChange: function (ids) {
            var n = (ids.struct ? 1 : 0) + (ids.color ? 1 : 0);
            refBtn.textContent = n ? ('参考图 ' + n) : '参考图';
            refBtn.classList.toggle('mv3-has-ref', n > 0);
          },
          onClose: function () { refPanelEl = null; dockHide('refs'); }
        });
        if (refPanelEl) dockShow('refs');
        return refPanelEl;
      };
      var refBtn = mkBtn('参考图', openRefPanel);
      refOpener = openRefPanel;
      grpAsset.appendChild(refBtn);
      /* 已经配过参考图的模型，按钮上直接标数量：不用点进去才知道有没有 */
      try {
        var initIds = global.ModelRefs.get(opts.assetId);
        var n0 = (initIds.struct ? 1 : 0) + (initIds.color ? 1 : 0);
        if (n0) { refBtn.textContent = '参考图 ' + n0; refBtn.classList.add('mv3-has-ref'); }
      } catch (e) {}
    }


    /* ---------------- UV 视图（并入查看器内部） ----------------
     * 以前 UV 是库窗口里另一层浅色浮层，和 3D 查看器是两套界面。这里把它并进来：
     * 同一个视口里按「UV 查看」切过去，岛图 / 3D 岛图 / 编号 / 插槽隔离 / 分辨率 /
     * 导出都在这一层，配色沿用 3D 视口的深色语言，不再跳窗口也不再换主题。
     * 分析走 ModelTex（它会自己再 load 一次模型），首次进入 UV 才算，3D 不受影响。 */
    var uvName = String(opts.title || '模型').replace(/\.(glb|gltf|obj|fbx|stl|ply|3mf|usdz)$/i, '');
    var uv = {
      on: false, layer: null, a: null, busy: false, err: '',
      mode: 'atlas', part: 'all', labels: true, size: 1024,
      atlas: null, preview: '', previewBusy: false, slotIslands: [],
      /* 排布状态：scale=滑杆（相对原始 UV 的倍率），snap=第一次动手前留的基线，
       * applied=排过没（决定「还原 / 存为 GLB」可不可点） */
      pk: { scale: 100, density: false, fill: 0, note: '', snap: null, busy: false, applied: false, saving: false }
    };
    var uvBtn = mkBtn('UV 查看', function () { uvToggle(); });
    grpCheck.appendChild(uvBtn);
    /* 外层窗口（模型库）靠它知道现在是 UV 还是 3D，好把副标题换成对应的操作提示 */
    var notifyUv = opts.onUvState;

    function uvEsc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }
    function uvColor(id) {
      return 'hsl(' + ((id * 137.508) % 360).toFixed(1) + ',72%,58%)';
    }
    /* ---------------- 「插槽」的口径 = 独立贴图空间，不是 mesh ----------------
     * OBJLoader 遇到一个 group 就建一个 mesh，于是「身体.obj」这种文件
     * （里面写着两段 g input）会被显示成「插槽 1 / 插槽 2」—— 看着像模型被碎裂了。
     * 但这两个 mesh 共用同一套 0–1 UV（岛在 UV 空间里互补）、共用同一个材质，
     * 它们就是**一张贴图**。插槽该按 UV 空间分，不该按 mesh 分。
     * 分组口径必须和 UvPack.packGroups 一致：排布按它装箱，界面也按它显示，
     * 否则界面说两个插槽、排布却一起装，数字对不上（用户看到的就是「碎成两半」）。 */
    function uvSlotGroups() {
      var a = uv.a;
      if (!a) return [];
      var g = (global.UvPack && global.UvPack.groups) ? global.UvPack.groups(a) : null;
      if (!g || !g.length) return a.parts.map(function (_, i) { return [i]; });
      return g;
    }
    /* 当前选择 → 涉及哪些 part（mesh）索引；null = 全部 */
    function uvSlotParts(sel) {
      if (sel == null || sel === 'all') return null;
      var gs = uvSlotGroups();
      var m = /^g(\d+)$/.exec(String(sel));
      /* 组不存在（换了模型 / 选择残留）→ 当作「全部」，宁可多显示也不能给个空白界面 */
      if (m) { var g2 = gs[Number(m[1])]; return (g2 && g2.length) ? g2 : null; }
      var n = Number(sel);              /* 兼容旧的「按 mesh 索引」选择 */
      return isNaN(n) ? null : [n];
    }
    /* 当前选择是第几个插槽（1 起）；'all' → 0 */
    function uvSlotNo(sel) {
      if (sel == null || sel === 'all') return 0;
      var m = /^g(\d+)$/.exec(String(sel));
      if (m) return Number(m[1]) + 1;
      var n = Number(sel);
      return isNaN(n) ? 0 : n + 1;
    }
    function ensureUvStyle() {
      if (document.getElementById('mv3UvStyle')) return;
      var st = document.createElement('style');
      st.id = 'mv3UvStyle';
      st.textContent = [
        '.mv3-uv{position:absolute;inset:0;display:none;flex-direction:column;background:#0a0b0e;z-index:4;}',
        '.mv3-uv.on{display:flex;}',
        '.mv3-uv-head{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #23262e;background:#111318;}',
        '.mv3-uv-brand{display:flex;flex-direction:column;gap:1px;margin-right:auto;min-width:0;}',
        '.mv3-uv-kicker{font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#e88a00;}',
        '.mv3-uv-name{font-size:13px;font-weight:600;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw;}',
        '.mv3-uv-sub{font-size:10.5px;color:#8b90a0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-chip{padding:4px 10px;border-radius:7px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;font-size:12px;cursor:pointer;line-height:1.4;font-family:inherit;}',
        '.mv3-uv-chip.on{border-color:#e88a00;background:#241c10;color:#ffb453;}',
        '.mv3-uv-chip:disabled{opacity:.45;cursor:default;}',
        '.mv3-uv-main{flex:1;min-height:0;display:flex;}',
        '.mv3-uv-stage{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:10px;position:relative;',
          'background-color:#0a0b0e;',
          'background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);',
          'background-size:24px 24px;}',
        '.mv3-uv-img{max-width:100%;max-height:100%;display:block;object-fit:contain;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);}',
        '.mv3-uv-state{display:flex;align-items:center;gap:8px;font-size:12px;color:#c6ccd6;}',
        '.mv3-uv-state.err{color:#ff9a90;max-width:90%;line-height:1.6;}',
        '.mv3-uv-spin{width:14px;height:14px;border-radius:50%;flex:0 0 auto;border:2px solid rgba(255,255,255,.18);border-top-color:#e88a00;animation:mv3UvSpin .8s linear infinite;}',
        '@keyframes mv3UvSpin{to{transform:rotate(360deg);}}',
        '.mv3-uv-side{flex:0 0 208px;width:208px;display:flex;flex-direction:column;gap:12px;padding:12px;border-left:1px solid #23262e;background:#0d0f14;overflow-y:auto;color:#c6ccd6;}',
        '.mv3-uv-sec{display:flex;flex-direction:column;gap:4px;}',
        '.mv3-uv-h{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8b90a0;}',
        '.mv3-uv-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:11.5px;color:#a8aeba;}',
        '.mv3-uv-kv b{font-weight:600;color:#e8eaf0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-island{display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:6px;background:#171a21;font-size:10.5px;color:#a8aeba;}',
        '.mv3-uv-island b{color:#e8eaf0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-island span{margin-left:auto;font-variant-numeric:tabular-nums;color:#8b90a0;}',
        '.mv3-uv-dot{flex:0 0 auto;width:9px;height:9px;border-radius:3px;}',
        /* UV 排布：滑杆 + 整行按钮 + 两列小按钮 */
        '.mv3-uv-slider{display:flex;align-items:center;gap:8px;}',
        '.mv3-uv-slider input{flex:1;min-width:0;height:16px;accent-color:#e88a00;cursor:pointer;}',
        '.mv3-uv-slider b{flex:0 0 auto;min-width:36px;text-align:right;font-size:11.5px;font-weight:600;color:#e8eaf0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-wide{width:100%;padding:6px 8px;border-radius:7px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;font-size:12px;font-family:inherit;cursor:pointer;line-height:1.4;}',
        '.mv3-uv-wide:hover{border-color:#3a3f4b;}',
        '.mv3-uv-wide.on{border-color:#e88a00;background:#241c10;color:#ffb453;}',
        '.mv3-uv-wide.primary{border-color:#e88a00;background:#e88a00;color:#1a1206;font-weight:700;}',
        '.mv3-uv-wide.primary:hover{background:#ffa52b;}',
        '.mv3-uv-wide:disabled{opacity:.45;cursor:default;}',
        '.mv3-uv-row{display:flex;gap:6px;}',
        '.mv3-uv-row .mv3-uv-chip{flex:1;text-align:center;}',
        '.mv3-uv-hint{font-size:10.5px;line-height:1.6;color:#8b90a0;}',
        '.mv3-uv-tip{margin-top:auto;font-size:10.5px;line-height:1.65;color:#8b90a0;}'
      ].join('\n');
      document.head.appendChild(st);
    }
    function ensureUvLayer() {
      ensureUvStyle();
      if (uv.layer) return uv.layer;
      uv.layer = document.createElement('div');
      uv.layer.className = 'mv3-uv';
      stage.appendChild(uv.layer);
      /* 一层铺在 stage 上，事件统一委托：重绘只改 innerHTML，不重复绑监听 */
      uv.layer.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-uv]') : null;
        if (!el) return;
        uvAct(el.getAttribute('data-uv'), el.getAttribute('data-v'));
      });
      /* 滑杆走 input 而不是 click：拖动过程中只改数字和一个文本节点，
       * 绝不能让 uvRender 重建 innerHTML——那样滑杆会在拖动中途被销毁，手感直接废掉。 */
      uv.layer.addEventListener('input', function (e) {
        var el = e.target;
        if (!el || !el.getAttribute || el.getAttribute('data-uvrange') !== 'scale') return;
        uv.pk.scale = Math.round(Number(el.value) || 100);
        var lab = uv.layer.querySelector('[data-uvscale]');
        if (lab) lab.textContent = uv.pk.scale + '%';
      });
      return uv.layer;
    }
    function uvAct(act, val) {
      if (act === 'back') { uvClose(); return; }
      if (act === 'mode') {
        if (uv.mode === val) return;
        uv.mode = val;
        uvRender();
        if (val === '3d' && !uv.preview) uvPreview();
      } else if (act === 'part') {
        if (uv.part === val) return;
        uv.part = val;
        uvBuildAtlas(); uv.preview = ''; uvRender();
        if (uv.mode === '3d') uvPreview();
      } else if (act === 'labels') {
        uv.labels = !uv.labels; uvBuildAtlas(); uv.preview = ''; uvRender();
      } else if (act === 'size') {
        uv.size = uv.size === 1024 ? 2048 : 1024; uvBuildAtlas(); uv.preview = ''; uvRender();
      } else if (act === 'density') {
        uv.pk.density = !uv.pk.density; uvRender();
      } else if (act === 'pack') {
        uvPackRun();
      } else if (act === 'stitch') {
        uvStitchRun();
      } else if (act === 'pkreset') {
        uvPackReset();
      } else if (act === 'pksave') {
        uvSaveGlb();
      } else if (act === 'export') {
        uvExport();
      }
    }
    function uvAtlasCanvas(forPreview) {
      var o = { labels: uv.labels };
      if (uv.part !== 'all') {
        var ps = uvSlotParts(uv.part);
        if (ps && ps.length) o.parts = ps;
      }
      if (forPreview) o.bg = '#ffffff';
      return global.ModelTex.islandAtlas(uv.a, uv.size, o);
    }
    function uvBuildAtlas() {
      uv.atlas = null;
      if (!uv.a || !global.ModelTex) return;
      try { uv.atlas = uvAtlasCanvas(false); }
      catch (e) { uv.err = '生成 UV 岛图失败：' + ((e && e.message) || e); }
    }
    async function uvPreview() {
      if (!uv.a || uv.previewBusy || !global.ModelTex) return;
      uv.previewBusy = true;
      uvRender();
      try {
        await new Promise(function (r) { setTimeout(r, 0); });   // 先让「渲染中」上屏
        uv.preview = global.ModelTex.previewGrid(uv.a, uvAtlasCanvas(true), {
          cell: 320, angles: [0, 35, 180], compare: false,
          paintedLabel: uv.part === 'all' ? '岛图' : ('插槽 ' + uvSlotNo(uv.part)),
          texLabel: 'UV 岛图'
        });
      } catch (e) {
        uv.err = '渲染 3D 岛图失败：' + ((e && e.message) || e);
      } finally {
        uv.previewBusy = false;
        uvRender();
      }
    }
    function uvExport() {
      if (!global.ModelTex || !global.ModelTex.download) return;
      var base = uvName.replace(/[\\/:*?"<>|]/g, '_');
      if (uv.mode === '3d' && uv.preview) global.ModelTex.download(base + '_3d_islands.png', uv.preview);
      else if (uv.atlas) global.ModelTex.download(base + '_uv_' + uv.size + '.png', uv.atlas.toDataURL('image/png'));
    }

    /* ---------------- UV 排布：调节岛大小 + 自动装箱 ----------------
     * 滑杆是参数、按钮是动作，不合成一个：
     *   拖动中就改几何的话，一来看不到「改动前后差在哪」，二来每拖一格都要重算装箱，
     *   手感直接废。所以滑杆只记数，「自动排布」才动几何。
     * 每次都从 snap 基线重来（restore → pack → apply）：这样 100% 恒等于模型原始尺寸，
     * 连点两次不会越缩越小，滑杆也才有确定含义。 */
    /* 按当前几何重新分岛。缝合 / 排布会改 UV、拆顶点，岛分组必须跟着重算，
     * 否则岛图、插槽统计、下一次排布拿到的都是上一轮的过期分组。 */
    function uvReanalyze() {
      if (!global.ModelTex || !uv.a || !uv.a.root) return null;
      var a2 = global.ModelTex.analyzeRoot(uv.a.root);
      uv.a = a2;
      uv.slotIslands = uvSlotGroups().map(function (g2) {
        return a2.islands.filter(function (o) {
          return o.tris.some(function (r) { return g2.indexOf(r.part) >= 0; });
        }).length;
      });
      return a2;
    }

    async function uvPackRun() {
      if (!uv.a || uv.pk.busy) return;
      var P = global.UvPack;
      if (!P) { uv.err = 'UV 排布模块未就绪（uvpack.js 未加载）'; uvRender(); return; }
      uv.pk.busy = true; uv.err = ''; uv.pk.note = '';
      uvRender();
      await new Promise(function (r) { setTimeout(r, 0); });   // 先让「排布中」上屏
      try {
        if (!uv.pk.snap) uv.pk.snap = P.snapshot(uv.a);
        P.restore(uv.a, uv.pk.snap);
        uvReanalyze();                     // 从基线重来：岛分组也按基线 UV 重算（缝合后 id 会变）
        var r = P.pack(uv.a, { scale: uv.pk.scale / 100, equalDensity: uv.pk.density });
        if (!r.ok) throw new Error('没有可排布的 UV 岛');
        P.apply(uv.a, r.ops);
        P.refresh(uv.a);
        /* 几何写完就算排布成功（还原 / 存 GLB 必须可用），贴图是附加一步：
         * 贴图重采样挂了不该让整个操作变成「失败但几何已经改了」的中间态。 */
        uv.pk.applied = true;
        uv.pk.fill = r.fill;
        var notes = (r.notes || []).slice();
        var rm = null;
        try {
          rm = P.remapTextures(uv.a, uv.pk.snap);
        } catch (e2) {
          notes.push('贴图重采样失败：' + ((e2 && e2.message) || e2) + '（建议存 GLB 后重新上色）');
        }
        if (rm && rm.count) notes.push(rm.count + ' 张贴图已按新 UV 重采样');
        uv.pk.note = notes.join('；') || ('已按 ' + uv.pk.scale + '% 排满 0–1 UV');
        uvBuildAtlas();
        uv.preview = '';
      } catch (e) {
        uv.err = '排布失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.busy = false;
        uvRender();
        if (uv.mode === '3d' && !uv.err) uvPreview();
      }
    }

    async function uvPackReset() {
      if (!uv.a || !uv.pk.snap || uv.pk.busy) return;
      var P = global.UvPack;
      if (!P) return;
      uv.pk.busy = true; uv.err = ''; uv.pk.note = '';
      uvRender();
      await new Promise(function (r) { setTimeout(r, 0); });
      try {
        P.restore(uv.a, uv.pk.snap);
        uv.pk.snap = null;        // 基线已经还回去了，下次排布重新拍一份
        uv.pk.applied = false; uv.pk.fill = 0;
        uvReanalyze();            // 岛分组跟着基线 UV 重算，岛图才不会显示缝合后的过期分组
        uvBuildAtlas(); uv.preview = '';
      } catch (e) {
        uv.err = '还原失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.busy = false; uvRender();
        if (uv.mode === '3d' && !uv.err) uvPreview();
      }
    }

    /* ---------------- 缝合碎岛 ----------------
     * AI 生成模型的遗留：一小片一小片的面在 UV 上被切出主岛（碎片 UV 还叠在
     * 主岛内部），3D 顶点位置其实没动。碎片当独立岛参与逐岛投射 / 上色时
     * 会各自归到别的视图，表面出一堆杂色小斑。
     * 这里把碎片 UV 重新参数化进主岛（见 uvpack.js 的 stitch），重算岛分组后
     * 碎片自动并入主岛；贴图跟着重采样，碎片显示的颜色跟它搬过去。 */
    async function uvStitchRun() {
      if (!uv.a || uv.pk.busy) return;
      var P = global.UvPack;
      if (!P || !P.stitch) { uv.err = 'UV 缝合模块未就绪（uvpack.js 未加载）'; uvRender(); return; }
      uv.pk.busy = true; uv.err = ''; uv.pk.note = '缝合中…';
      uvRender();
      await new Promise(function (r) { setTimeout(r, 0); });
      try {
        if (!uv.pk.snap) uv.pk.snap = P.snapshot(uv.a);
        var before = uv.a.islands.length;
        var r = P.stitch(uv.a, {});
        P.refresh(uv.a);
        uvReanalyze();
        var after = uv.a.islands.length;
        var notes = (r.notes || []).slice();
        if (r.merged) notes.push('岛数 ' + before + ' → ' + after);
        try {
          var rm = P.remapTextures(uv.a, uv.pk.snap);
          if (rm && rm.count) notes.push(rm.count + ' 张贴图已按新 UV 重采样');
        } catch (e2) {
          notes.push('贴图重采样失败：' + ((e2 && e2.message) || e2) + '（建议存 GLB 后重新上色）');
        }
        /* 缝合后的 UV 成为新基线：自动排布必须从基线重来（restore → pack），
         * 不换基线的话一排布就把缝合覆盖回碎片状态，等于白缝。
         * 代价是「还原」回到缝合前而不是模型最原始——碎片本来就是要修掉的，符合直觉。 */
        if (r.merged) uv.pk.snap = P.snapshot(uv.a);
        uv.pk.applied = true;
        uv.pk.note = notes.join('；') || '没有可缝合的碎片岛';
        uvBuildAtlas(); uv.preview = '';
      } catch (e) {
        uv.err = '缝合失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.busy = false; uvRender();
        if (uv.mode === '3d' && !uv.err) uvPreview();
      }
    }

    /* 排布结果只活在 UV 视图里（3D 视口那份模型是另一次 load 的实例）。
     * 出口是「存为 GLB」：新 UV + 重采样后的贴图一起内嵌，入库后从模型库打开即是新排布。 */
    async function uvSaveGlb() {
      var P = global.UvPack;
      if (!uv.a || !P || uv.pk.saving) return;
      uv.pk.saving = true; uv.pk.note = '正在导出 GLB…'; uv.err = '';
      uvRender();
      try {
        var buf = await P.exportGLB(uv.a);
        var url = bufToDataURL(buf, 'model/gltf-binary');
        var nm = (uvName.replace(/[\\/:*?"<>|]/g, '_') || 'model') + '_UV排布.glb';
        var d = window.openagiDesktop;
        if (!(d && typeof d.assetPut === 'function')) {
          saveDataURL(nm, url);
          uv.pk.note = '浏览器里存不进模型库，已改为下载 GLB';
          return;
        }
        var r = await d.assetPut({ kind: 'model', ext: 'glb', name: nm, data: url, source: 'uvpack' });
        if (!(r && r.ok && r.asset && r.asset.id)) throw new Error((r && r.message) || '入库失败');
        /* 缩略图顺手补一张，模型库磁贴直接是新排布的样子（失败不影响入库） */
        try {
          var th = await renderThumb(url, { size: 256 });
          await d.assetThumbSave(r.asset.id, th.dataURL);
        } catch (e2) { }
        uv.pk.note = '已存入模型库：「' + nm + '」';
      } catch (e) {
        uv.err = '导出失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.saving = false;
        uvRender();
      }
    }
    function uvPackHtml() {
      var P = uv.pk;
      var s = '<div class="mv3-uv-sec">' +
        '<div class="mv3-uv-h">UV 排布</div>' +
        '<div class="mv3-uv-slider">' +
          '<input type="range" min="20" max="200" step="5" value="' + P.scale + '" data-uvrange="scale" title="相对原始 UV 的尺寸倍率（100% = 模型本身的尺寸）">' +
          '<b data-uvscale>' + P.scale + '%</b>' +
        '</div>' +
        '<button type="button" class="mv3-uv-wide' + (P.density ? ' on' : '') + '" data-uv="density" data-v="1"' +
          ' title="按 3D 面积给每个岛分配 UV 面积：贴图精度均匀，不会大岛吃满、小岛只剩几个像素">' +
          '统一贴图密度' + (P.density ? ' · 开' : '') + '</button>' +
        '<button type="button" class="mv3-uv-wide" data-uv="stitch" data-v="1"' + (P.busy ? ' disabled' : '') + '"' +
          ' title="把「脱离主岛」的碎片面缝合回主岛：AI 生成模型常见一堆 1–4 面的碎岛（顶点位置没动、UV 叠在主岛内部），缝合后岛图干净、逐岛投射 / 上色不再出杂色斑">' +
          '缝合碎岛</button>' +
        '<button type="button" class="mv3-uv-wide primary" data-uv="pack" data-v="1"' + (P.busy ? ' disabled' : '') + '>' +
          (P.busy ? '排布中…' : '自动排布') + '</button>' +
        '<div class="mv3-uv-row">' +
          '<button type="button" class="mv3-uv-chip" data-uv="pkreset" data-v="1"' + (P.applied && !P.busy ? '' : ' disabled') + '>还原</button>' +
          '<button type="button" class="mv3-uv-chip" data-uv="pksave" data-v="1"' + (P.applied && !P.busy ? '' : ' disabled') + '>存为 GLB</button>' +
        '</div>' +
        (P.fill > 0 ? '<div class="mv3-uv-kv"><span>UV 占用</span><b>' + Math.round(P.fill * 100) + '%</b></div>' : '') +
        (P.note ? '<div class="mv3-uv-hint">' + uvEsc(P.note) + '</div>' : '') +
        '<div class="mv3-uv-hint">' + (P.applied
          ? '排布只在本视图和导出的 GLB 里生效；3D 视口要重新打开新文件才看得到。'
          : '滑杆定尺寸，排布按它重新装箱；贴图会跟着重采样，不会错位。') + '</div>' +
        '</div>';
      return s;
    }
    function uvStatHtml() {
      var a = uv.a;
      if (!a) return '';
      var tris = a.parts.reduce(function (n, p) { return n + p.tri; }, 0);
      /* 插槽 = UV 空间组（见 uvSlotGroups）。当前选择落到哪些 mesh 上。 */
      var gs = uvSlotGroups();
      var selParts = uvSlotParts(uv.part);
      var shown = !selParts ? a.islands : a.islands.filter(function (o) {
        return o.tris.some(function (r) { return selParts.indexOf(r.part) >= 0; });
      });
      var slotTris = !selParts ? tris : selParts.reduce(function (n, pi) {
        return n + (a.parts[pi] ? a.parts[pi].tri : 0);
      }, 0);
      var kv = function (k, v) { return '<div class="mv3-uv-kv"><span>' + k + '</span><b>' + v + '</b></div>'; };
      var rng = function (o) { return o.bbox[1].toFixed(1) + '–' + o.bbox[4].toFixed(1); };
      return '<div class="mv3-uv-sec"><div class="mv3-uv-h">概览</div>' +
          kv('UV 岛', uv.part === 'all' ? shown.length : (shown.length + ' / ' + a.islands.length)) +
          kv('三角面', slotTris) +
          kv('网格', a.parts.length) +
          (gs.length < a.parts.length ? kv('UV 空间', gs.length + ' 组' + (gs.length === 1 ? '（一张贴图）' : '')) : '') +
          (gs.length > 1 ? kv('当前插槽', uv.part === 'all' ? '全部' : ('#' + uvSlotNo(uv.part))) : '') +
          kv('UV 图', uv.size + ' × ' + uv.size) +
        '</div>' +
        uvPackHtml() +
        '<div class="mv3-uv-sec"><div class="mv3-uv-h">最大的岛</div>' +
          shown.slice(0, 6).map(function (o) {
            return '<div class="mv3-uv-island">' +
              '<i class="mv3-uv-dot" style="background:' + uvColor(o.id) + '"></i>' +
              '<b>#' + o.id + '</b>' +
              '<span>' + o.tris.length + ' 面 · y ' + rng(o) + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
        '<div class="mv3-uv-tip">' + (a.parts.length > 1
          ? (gs.length === 1
            ? '这 ' + a.parts.length + ' 个网格共用同一张 UV（同一套布局、同一张贴图），排布时会一起装进 0–1。'
            : '这个模型有 ' + a.parts.length + ' 个网格、' + gs.length + ' 份独立 UV 空间（各自一张贴图），每份分别装进 0–1。')
          : '岛编号可以直接写进「模型区域上色」的区域规则与细节规则，用来定位部位。') + '</div>';
    }
    function uvRender() {
      if (!uv.layer) return;
      var a = uv.a;
      var sub = a
        ? (a.islands.length + ' 个 UV 岛 · ' + a.parts.reduce(function (n, p) { return n + p.tri; }, 0) + ' 三角面' +
           (uv.pk.applied ? ' · 已排布' : ''))
        : (uv.busy ? '读取模型中…' : '等待分析');
      var chip = function (act, val, label, on, title) {
        return '<button type="button" class="mv3-uv-chip' + (on ? ' on' : '') + '" data-uv="' + act + '" data-v="' + val + '"' +
          (title ? ' title="' + uvEsc(title) + '"' : '') + '>' + label + '</button>';
      };
      var gs = uvSlotGroups();
      /* 插槽按钮按 **UV 空间组** 给，不按 mesh 给：
       * 只有 1 组时干脆不显示（没有可隔离的对象），否则用户会以为模型碎成了几块。
       * 真的多组时，标签写清「N 个网格」，点一次隔离整组。 */
      var slots = (a && gs.length > 1)
        ? chip('part', 'all', '全部', uv.part === 'all') +
          gs.map(function (g2, gi) {
            var tri = g2.reduce(function (n, pi) { return n + (a.parts[pi] ? a.parts[pi].tri : 0); }, 0);
            var label = '插槽 ' + (gi + 1) + (g2.length > 1 ? ('（' + g2.length + ' 个网格）') : '');
            return chip('part', 'g' + gi, label, uv.part === 'g' + gi,
              tri + ' 面 · ' + (uv.slotIslands[gi] || 0) + ' 个岛');
          }).join('')
        : '';
      /* 只读提示：网格数 ≠ 贴图数时，把这件事说在脸上（不然用户以为模型坏了） */
      var slotNote = (a && gs.length && a.parts.length > gs.length)
        ? '<span class="mv3-uv-chip" style="cursor:default;opacity:.85" title="这几个网格共用同一套 UV 布局，是同一张贴图">' +
          a.parts.length + ' 个网格 · ' + gs.length + ' 张贴图</span>'
        : '';
      var stageHtml;
      if (uv.err) stageHtml = '<div class="mv3-uv-state err">' + uvEsc(uv.err) + '</div>';
      else if (uv.busy) stageHtml = '<div class="mv3-uv-state"><span class="mv3-uv-spin"></span>正在分析 UV 岛…</div>';
      else if (!a) stageHtml = '<div class="mv3-uv-state">准备中…</div>';
      else if (uv.mode === '3d') {
        stageHtml = uv.preview
          ? '<img class="mv3-uv-img" src="' + uv.preview + '" alt="3D 岛图">'
          : '<div class="mv3-uv-state"><span class="mv3-uv-spin"></span>正在渲染 3D 岛图…</div>';
      } else {
        stageHtml = uv.atlas
          ? '<img class="mv3-uv-img" src="' + uv.atlas.toDataURL('image/png') + '" alt="UV 岛图">'
          : '<div class="mv3-uv-state">准备中…</div>';
      }
      uv.layer.innerHTML =
        '<div class="mv3-uv-head">' +
          '<div class="mv3-uv-brand">' +
            '<span class="mv3-uv-kicker">UV 查看</span>' +
            '<b class="mv3-uv-name" title="' + uvEsc(uvName) + '">' + uvEsc(uvName) + '</b>' +
            '<span class="mv3-uv-sub">' + uvEsc(sub) + '</span>' +
          '</div>' +
          chip('mode', 'atlas', 'UV 岛图', uv.mode === 'atlas') +
          chip('mode', '3d', '3D 岛图', uv.mode === '3d') +
          slots +
          slotNote +
          chip('labels', '1', '编号', uv.labels, '在面积足够大的岛上标出编号') +
          chip('size', '1', uv.size, false, '切换 UV 图分辨率') +
          chip('export', '1', '导出 PNG', false) +
          chip('back', '1', '返回 3D', false) +
        '</div>' +
        '<div class="mv3-uv-main">' +
          '<div class="mv3-uv-stage">' + stageHtml + '</div>' +
          '<aside class="mv3-uv-side">' + uvStatHtml() + '</aside>' +
        '</div>';
    }
    function uvToggle() {
      if (uv.on) uvClose();
      else uvOpen();
    }
    async function uvOpen() {
      ensureUvLayer();
      uv.on = true;
      uv.layer.classList.add('on');
      /* UV 是完整的另一屏：底栏那几个 3D 专用按钮（线框 / 朝向 / 四视图）在这层没意义，
       * 直接收起，回到 3D 时再出现；插槽抽屉也一样收起，免得两面叠在一起。 */
      canvas.style.display = 'none';
      bar.style.display = 'none';
      vcBox.style.display = 'none';   // UV 是另一屏，立方体跟着 3D 视口一起收
      if (slotUI && slotUI.hide) slotUI.hide();
      closeRefsPanel();
      uvBtn.textContent = '返回 3D';
      if (typeof notifyUv === 'function') notifyUv(true);
      if (!global.ModelTex) {
        uv.err = 'UV 分析模块未就绪（modeltex.js 未加载）';
        uvRender();
        return;
      }
      if (!uv.a && !uv.busy) {
        uv.busy = true; uv.err = '';
        uvRender();
        try {
          uv.a = await global.ModelTex.analyze(src);
          /* 每个插槽（UV 空间组）有多少个岛 —— 按钮上的提示数字 */
          uv.slotIslands = uvSlotGroups().map(function (g2) {
            return uv.a.islands.filter(function (o) {
              return o.tris.some(function (r) { return g2.indexOf(r.part) >= 0; });
            }).length;
          });
          /* 换模型后旧的插槽选择可能不存在了 → 回到「全部」，
           * 别让按钮高亮一个不存在的插槽（uvSlotParts 对越界会兜底成全部）。 */
          if (uv.part !== 'all' && !uvSlotParts(uv.part)) uv.part = 'all';
          uvBuildAtlas();
        } catch (e) {
          uv.err = 'UV 分析失败：' + ((e && e.message) || e);
        } finally {
          uv.busy = false;
          uvRender();
        }
      } else {
        uvRender();
      }
    }
    function uvClose() {
      uv.on = false;
      if (uv.layer) uv.layer.classList.remove('on');
      canvas.style.display = '';
      bar.style.display = '';
      vcBox.style.display = '';
      uvBtn.textContent = 'UV 查看';
      if (typeof notifyUv === 'function') notifyUv(false);
      resize();
    }

    var exportBtn = mkBtn('导出四视图 2K', async function () {
      exportBtn.disabled = true;
      var old = exportBtn.textContent;
      exportBtn.textContent = '渲染中…';
      try {
        var url = await quadViews(src, { size: 2048, mode: 'line' });
        var a = document.createElement('a');
        a.href = url;
        a.download = 'model_quad_views_2k.png';
        a.click();
        hint.textContent = '四视图已导出';
      } catch (e) {
        hint.textContent = '导出失败：' + (e && e.message);
        hint.style.color = '#e05252';
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = old;
      }
    });
    grpExport.appendChild(exportBtn);

    /* ---------------- 深度像素描边：工具条开关 + 弹层两个滑条 ----------------
     * 滑条为什么不放工具条里：工具条已经到「前/后/左/右/顶/轴测 + 导出」了，
     * 再塞两个 range 会把按钮挤成两行、每次开关还抖一下。弹层固定在视口右上角，
     * 开的时候才出现，参数改完立刻生效（每帧都在重画）。 */
    var dout = createDepthOutline({ renderer: renderer, scene: scene, camera: camera });
    var doutPop = null;

    function ensureDoutPop() {
      if (doutPop) return doutPop;
      doutPop = document.createElement('div');
      doutPop.className = 'mv3-dout';
      doutPop.innerHTML =
        '<div class="mv3-dout-h">深度描边</div>' +
        '<label class="mv3-dout-row"><span>阈值</span>' +
          '<input type="range" min="0.5" max="12" step="0.5" value="' + dout.params.threshold + '" data-dout="threshold">' +
          '<b>' + Number(dout.params.threshold).toFixed(1) + '</b></label>' +
        '<label class="mv3-dout-row"><span>线宽</span>' +
          '<input type="range" min="0.5" max="4" step="0.5" value="' + dout.params.width + '" data-dout="width">' +
          '<b>' + Number(dout.params.width).toFixed(1) + '</b></label>' +
        '<div class="mv3-dout-tip">阈值 = 深度跳变相当于几个像素的倾斜。数字越小线越多；调到 8 以上只剩大轮廓。</div>';
      stage.appendChild(doutPop);
      /* 只改 uniform，不重建面板：拖动过程中 DOM 被重建的话滑杆会掉手 */
      doutPop.addEventListener('input', function (e) {
        var el = e.target;
        var k = el && el.getAttribute ? el.getAttribute('data-dout') : null;
        if (!k) return;
        dout.setParam(k, el.value);
        var b = el.parentNode.querySelector('b');
        if (b) b.textContent = Number(dout.params[k]).toFixed(1);
      });
      return doutPop;
    }
    function showDoutPop(v) {
      ensureDoutPop().classList.toggle('on', !!v);
    }

    var doutBtn = mkBtn('深度描边', function () {
      var on = !dout.enabled;
      dout.setEnabled(on);
      doutBtn.style.borderColor = on ? '#e88a00' : '#2c303a';
      doutBtn.style.color = on ? '#ffb453' : '#e8eaf0';
      showDoutPop(on);
      if (on && dout.failed) hint.textContent = '这台设备给不了深度纹理，描边开不了（画面已退回普通渲染）';
      else hint.textContent = on ? '深度描边：勾出所有深度断裂（轮廓 / 遮挡 / 台阶），参数在右上角' : '深度描边已关闭';
    });
    grpCheck.appendChild(doutBtn);

    hint.textContent = '拖拽旋转 · 滚轮缩放 · 右键平移';

    function resize() {
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      /* 深度描边的 RT 跟着视口走：不通知的话窗口拉大会按旧尺寸采样，线会糊成一团 */
      dout.resize(w, h);
      /* UV 描边是屏幕空间扩边，视口一变就得把新的像素尺寸告诉它，
       * 否则窗口拉大后线会跟着变粗（线宽是「像素」不是「世界单位」）。 */
      if (seamMesh && seamMesh.userData && seamMesh.userData.setRes) {
        var pr = renderer.getPixelRatio() || 1;
        seamMesh.userData.setRes(w * pr, h * pr);
        seamMesh.material.uniforms.uWidth.value = 2.4 * pr;
      }
    }
    resize();
    var ro = new ResizeObserver(resize);
    ro.observe(stage);

    function tick() {
      pv.raf = requestAnimationFrame(tick);
      controls.update();
      if (vcTween) vcTween();
      /* 关闭时这里就是一次普通 render，没有额外开销 */
      dout.draw();
      /* 立方体小画布：92×92、一个盒子，每帧一次的开销可以忽略 */
      vcDraw();
    }
    pv = { overlay: overlay, win: (hostEl && opts.chrome !== false) ? winEl : null, host: hostEl, renderer: renderer, controls: controls, raf: 0, ro: ro, dout: dout, vcRenderer: vcRenderer };
    tick();

    /* 库里的「UV 查看」入口：直接以 UV 模式打开，不用先看 3D 再切 */
    /* 初始状态放到最后再描：上面那行「拖拽旋转…」会把 hint 覆盖掉，
     * 先描的话用户永远看不到「N 条接缝」这句 */
    if (opts.uvEdge) toggleSeam();
    if (opts.uv) uvOpen();

    return true;
  }

  /* ---------------- 深度像素描边（屏幕空间） ----------------
   * 判据是「相邻像素的世界深度差」，不是几何数据：外轮廓、遮挡关系、台阶、两块网格没对齐，
   * 全都自动出线，不需要任何显式边信息。和 UV 描边（几何法，只描显式接缝）互补，两个开关互不影响。
   *
   * 为什么阈值要归一化成「像素当量」：
   *   直接拿 |Δz| 当阈值，模型一放大 / 一拉近 / 换分辨率，线就忽有忽无——透视下同一个深度断裂
   *   在近处的 Δz 远大于远处。这里把 Δz 除以「该深度下 1 个像素对应的世界尺寸」
   *   （2·z·tan(fov/2)/H），得到「这个跳变相当于多少个像素的平面倾斜」：
   *   斜面一般 1–3，真正的断裂几十上百。于是阈值 2 在任何视角、任何分辨率下含义都一样。
   *
   * 两次渲染：场景 → 带 DepthTexture 的 RT，再全屏 quad 采样深度做 8 方向 × 2 环比较。
   * 关掉时退回一次直接渲染，零额外开销；RT 按需建、关掉即 dispose。
   */
  function createDepthOutline(opt) {
    var renderer = opt.renderer, scene = opt.scene, camera = opt.camera;
    var enabled = false, rt = null, w = 1, h = 1, failed = false;
    var bgTmp = new THREE.Color();
    var params = { threshold: 2, width: 1.5 };

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uTan: { value: 0.4 },
        uThreshold: { value: 2 },
        uWidth: { value: 1.5 },
        uColor: { value: new THREE.Color('#000000') },
        uStrength: { value: 1 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = vec4(position.xy, 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        '#include <packing>',
        'uniform sampler2D tColor;',
        'uniform sampler2D tDepth;',
        'uniform vec2 uRes;',
        'uniform float uNear;',
        'uniform float uFar;',
        'uniform float uTan;',
        'uniform float uThreshold;',
        'uniform float uWidth;',
        'uniform vec3 uColor;',
        'uniform float uStrength;',
        'varying vec2 vUv;',
        '',
        '/* 线性 → sRGB。为什么要自己写：three r149 只有渲染到屏幕时才套 outputEncoding，',
        ' * 渲到普通 RT 恒为线性（WebGLProgram 里 `currentRenderTarget === null ? outputEncoding : Linear`）。',
        ' * 不补这一步，后处理把线性值直接上屏，整屏发暗（实测平均亮度 20.7 -> 14.0）。',
        ' * 手写而不 include <encodings_pars_fragment>：那个依赖 WebGLProgram 注入的宏，',
        ' * 对自定义 ShaderMaterial 不保证注入，编不出来就是黑屏。 */',
        'vec3 lin2srgb(vec3 c) {',
        '  vec3 lo = c * 12.92;',
        '  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;',
        '  return mix(lo, hi, step(vec3(0.0031308), c));',
        '}',
        '',
        '/* 线性深度（相机到片元的距离，正数，越大越远）。',
        ' * 必须自己做钳位，不能直接丢给 perspectiveDepthToViewZ：',
        ' * 那边是 (near*far)/((far-near)*d - far)，d 一旦 >= 1（背景、或精度上溢到 1.0000001）',
        ' * 分母变号，返回 -inf / 巨大值 —— 后面除以 px 就变成 inf，max() 把它传染给整片，',
        ' * 结果整只模型被判成断裂（实测：模型全黑，只剩轮廓外的背景正常）。',
        ' * 这里把「背景 / 越界 / NaN」统一按 far 处理，公式只在 [0,1) 内跑。 */',
        'float lz(vec2 p) {',
        '  float d = texture2D(tDepth, p).x;',
        '  if (!(d >= 0.0) || d >= 0.9999990) return uFar;',
        '  float z = -perspectiveDepthToViewZ(d, uNear, uFar);',
        '  return (z > 0.0 && z < uFar * 1.5) ? z : uFar;',
        '}',
        'float isBg(float z) { return step(uFar * 0.999, z); }',
        '',
        'void main() {',
        '  vec3 col = texture2D(tColor, vUv).rgb;',
        '  float z0 = lz(vUv);',
        '  /* 该深度下 1 像素的世界尺寸：透视投影 = 2*z*tan(fov/2)/H */',
        '  float px = max(z0 * 2.0 * uTan / uRes.y, 1e-5);',
        '  vec2 o = vec2(uWidth) / uRes;',
        '  float e = 0.0;',
        '',
        '  /* 判据用**二阶差分**（z(+) + z(-) - 2*z0），不是一阶 |z(+) - z0|。',
        '   * 一开始写的是「相邻像素深度差超过阈值就描」，结果整只模型被描黑：',
        '   * 掠射面上（侧着对视线、头发边缘、裙褶）相邻像素的 Δz 本来就很大 ——',
        '   * 表面与视线夹角超过 ~63° 时 Δz 就超过「2 个像素的世界尺寸」，',
        '   * 而模型上一大半的面都是这种角度。二阶差分对「线性变化」是 0，',
        '   * 斜面（含透视下的近似线性）几乎不留残差，只有真正断开的地方（遮挡、台阶、剪影）才爆。',
        '   * 归一化仍用 px，阈值含义保持「相当于多少个像素的断裂」。 */',
        '  #define LAP(dx, dy, r) { float za = lz(vUv + vec2(dx, dy) * o * r); float zb = lz(vUv - vec2(dx, dy) * o * r); e = max(e, abs(za + zb - 2.0 * z0) / px); }',
        '  LAP(1.0, 0.0, 1.0) LAP(0.0, 1.0, 1.0)',
        '  LAP(0.707, 0.707, 1.0) LAP(0.707, -0.707, 1.0)',
        '  /* 内环：比线宽还小的凸起只跑外环会被整段跳过 */',
        '  LAP(1.0, 0.0, 0.5) LAP(0.0, 1.0, 0.5)',
        '  #undef LAP',
        '',
        '  float k = smoothstep(uThreshold * 0.6, uThreshold, e) * uStrength;',
        '',
        '  /* 空背景那一侧也要描：中心是 far、四邻有实体 → 描。',
        '   * 不补的话外轮廓只有内侧 1px，模型贴边或局部出画时线会断一截。 */',
        '  float nb = min(min(lz(vUv + vec2(o.x, 0.0)), lz(vUv - vec2(o.x, 0.0))),',
        '                 min(lz(vUv + vec2(0.0, o.y)), lz(vUv - vec2(0.0, o.y))));',
        '  if (isBg(z0) > 0.5 && isBg(nb) < 0.5) k = max(k, uStrength);',
        '',
        '  gl_FragColor = vec4(lin2srgb(mix(col, uColor, clamp(k, 0.0, 1.0))), 1.0);',
        '}'
      ].join('\n'),
      depthTest: false,
      depthWrite: false
    });

    var quadScene = new THREE.Scene();
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    function disposeRT() {
      if (!rt) return;
      try { rt.depthTexture && rt.depthTexture.dispose(); } catch (e) {}
      try { rt.dispose(); } catch (e) {}
      rt = null;
    }

    function ensureRT() {
      var pr = renderer.getPixelRatio() || 1;
      var W = Math.max(2, Math.floor(w * pr)), H = Math.max(2, Math.floor(h * pr));
      if (rt && rt.width === W && rt.height === H) return true;
      disposeRT();
      try {
        var dt = new THREE.DepthTexture(W, H);
        /* UnsignedIntType 是这里唯一能拿到的：r149 的 WebGLTextures.setupRenderTarget 会把
         * depthTexture.format/type 强制改写成 DEPTH_COMPONENT24 + UnsignedIntType，
         * 设 FloatType 会被无声覆盖（试过）。
         * 所以深度精度只能靠相机 near/far 控制 —— 见 openPreview 里 camNear 那段注释。 */
        dt.type = THREE.UnsignedIntType;
        dt.minFilter = THREE.NearestFilter;
        dt.magFilter = THREE.NearestFilter;
        rt = new THREE.WebGLRenderTarget(W, H, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthTexture: dt,
          depthBuffer: true,
          stencilBuffer: false
        });
        /* RT 保持默认的线性色彩空间：显式设 texture.encoding = sRGBEncoding 在 r149 里
         * 对普通 RT 没有任何作用（见 shader 里 lin2srgb 那段注释），设了只会让人误以为已经处理过。
         * 编码统一在后处理片元里做一次。 */
        mat.uniforms.tColor.value = rt.texture;
        mat.uniforms.tDepth.value = dt;
        mat.uniforms.uRes.value.set(W, H);
        return true;
      } catch (e) {
        rt = null;
        failed = true;
        return false;
      }
    }

    function draw() {
      if (!enabled || failed) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      if (!ensureRT()) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      var u = mat.uniforms;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uTan.value = Math.tan(camera.fov * Math.PI / 360);
      u.uThreshold.value = params.threshold;
      u.uWidth.value = params.width;
      /* 背景色要临时转成线性：
       * scene.background 是「清屏色」，不论渲染到屏幕还是 RT 都是把 Color 数字直接丢给
       * gl.clearColor，**不过 outputEncoding**。而模型是走编码的（屏幕 sRGB / RT 线性）。
       * 所以进 RT 时背景不转，出来再统一编码，背景就会被抬亮（#0a0b0e 变成 #383838）。
       * 只在画这一帧期间换掉，画完立刻换回，外面看到的一直是原值。 */
      var bg = scene.background, swap = null;
      if (bg && bg.isColor) {
        swap = bg;
        bgTmp.copy(bg).convertSRGBToLinear();
        scene.background = bgTmp;
      }
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      if (swap) scene.background = swap;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    }

    return {
      get enabled() { return enabled; },
      get failed() { return failed; },
      params: params,
      setEnabled: function (v) { enabled = !!v; if (!enabled) disposeRT(); },
      setParam: function (k, v) {
        if (!(k in params)) return;
        var n = Number(v);
        if (!isFinite(n)) return;
        params[k] = k === 'threshold' ? Math.max(0.1, Math.min(40, n)) : Math.max(0.5, Math.min(8, n));
      },
      resize: function (nw, nh) { w = Math.max(1, nw || 1); h = Math.max(1, nh || 1); },
      draw: draw,
      dispose: function () {
        disposeRT();
        try { mat.dispose(); quadScene.children[0].geometry.dispose(); } catch (e) {}
      }
    };
  }

  /* 两个入口挂回内部命名空间：model3d.js 的门面通过它转发 */
  M.openPreview = openPreview;
  M.closePreview = closePreview;
  /* 参考图抽屉的入口是 openPreview 里的局部状态，用 getter 让 Model3D.openRefs 看得到 */
  Object.defineProperty(M, 'refOpener', {
    configurable: true,
    get: function () { return refOpener; }
  });
})(window);
