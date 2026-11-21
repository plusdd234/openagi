/* Tripo 工坊 —— 2D 图像视口与 3D 模型视口。
 *
 * 由 registerApp({ scripts }) 在 open 阶段注入，挂在 window.TripStudioViewport 上。
 * 不依赖 App 内部状态；所有回调通过 onChange 通知 app.js。
 */
(function () {
  'use strict';

  var EPS = 1e-6;

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  /* ------------------------------------------------------------------ *
   * 2D 图像视口：适应窗口、1:1、滚轮缩放、拖拽平移、三分网格
   * ------------------------------------------------------------------ */
  function createImageStage(opts) {
    var stage = opts.stage;
    var tile = opts.tile;
    var img = opts.img;
    var empty = opts.empty;
    var grid = opts.grid;
    var onChange = opts.onChange || function () {};

    var zoom = 1, panX = 0, panY = 0;
    var natW = 0, natH = 0;
    var userZoomed = false;
    var dragging = false;
    var dragStart = null;
    var hasImage = false;

    function apply() {
      tile.style.transform = 'translate(-50%, -50%) translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      onChange({ zoom: zoom, panX: panX, panY: panY });
    }

    function fit() {
      if (!hasImage || !natW || !natH) return;
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      zoom = Math.min((w - 56) / natW, (h - 56) / natH, 1);
      if (!isFinite(zoom) || zoom <= 0) zoom = 1;
      panX = 0; panY = 0;
      userZoomed = false;
      apply();
    }

    function actual() {
      if (!hasImage) return;
      zoom = 1; panX = 0; panY = 0; userZoomed = true;
      apply();
    }

    function zoomAt(factor, clientX, clientY) {
      if (!hasImage) return;
      var next = clamp(zoom * factor, 0.03, 16);
      if (Math.abs(next - zoom) < EPS) return;
      var rect = stage.getBoundingClientRect();
      var cx = (typeof clientX === 'number' ? clientX : rect.left + rect.width / 2) - rect.left - rect.width / 2;
      var cy = (typeof clientY === 'number' ? clientY : rect.top + rect.height / 2) - rect.top - rect.height / 2;
      var k = next / zoom;
      panX = cx - (cx - panX) * k;
      panY = cy - (cy - panY) * k;
      zoom = next;
      userZoomed = true;
      apply();
    }

    function setSrc(src) {
      return new Promise(function (resolve, reject) {
        if (!src) {
          clear();
          resolve(null);
          return;
        }
        var done = false;
        img.onload = function () {
          if (done) return;
          done = true;
          hasImage = true;
          natW = img.naturalWidth || 1;
          natH = img.naturalHeight || 1;
          img.classList.add('is-on');
          empty.classList.add('hidden');
          fit();
          resolve({ w: natW, h: natH });
        };
        img.onerror = function () {
          if (done) return;
          done = true;
          hasImage = false;
          img.classList.remove('is-on');
          empty.classList.remove('hidden');
          reject(new Error('图像加载失败'));
        };
        img.src = src;
      });
    }

    function clear() {
      hasImage = false;
      natW = natH = 0;
      zoom = 1; panX = 0; panY = 0;
      img.onload = img.onerror = null;
      img.removeAttribute('src');
      img.classList.remove('is-on');
      empty.classList.remove('hidden');
      apply();
    }

    function setGrid(on) { grid.classList.toggle('hidden', !on); }

    function onWheel(e) {
      if (!hasImage) return;
      e.preventDefault();
      var factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(factor, e.clientX, e.clientY);
    }

    function onPointerDown(e) {
      if (!hasImage || e.button !== 0) return;
      dragging = true;
      dragStart = { x: e.clientX - panX, y: e.clientY - panY, id: e.pointerId };
      stage.classList.add('is-panning');
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }

    function onPointerMove(e) {
      if (!dragging || !dragStart) return;
      panX = e.clientX - dragStart.x;
      panY = e.clientY - dragStart.y;
      apply();
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      dragStart = null;
      stage.classList.remove('is-panning');
      try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }

    function onDblClick() { fit(); }

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('dblclick', onDblClick);

    var ro = new ResizeObserver(function () {
      if (!userZoomed) fit();
    });
    ro.observe(stage);

    return {
      setSrc: setSrc,
      clear: clear,
      fit: fit,
      actual: actual,
      zoomIn: function () { zoomAt(1.25); },
      zoomOut: function () { zoomAt(1 / 1.25); },
      setGrid: setGrid,
      getZoom: function () { return zoom; },
      hasImage: function () { return hasImage; },
      destroy: function () {
        ro.disconnect();
        stage.removeEventListener('wheel', onWheel);
        stage.removeEventListener('pointerdown', onPointerDown);
        stage.removeEventListener('pointermove', onPointerMove);
        stage.removeEventListener('pointerup', onPointerUp);
        stage.removeEventListener('pointercancel', onPointerUp);
        stage.removeEventListener('dblclick', onDblClick);
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 3D 模型视口：Orbit + 布光 + 网格 + 材质/白模/线框 + 贴图 + 截图 + GLB
   * ------------------------------------------------------------------ */
  function createModelStage(opts) {
    if (!window.THREE) throw new Error('three.js 未加载');
    var THREE = window.THREE;
    if (!THREE.OrbitControls) throw new Error('OrbitControls 未加载');

    var host = opts.host;
    var sceneEl = opts.sceneEl;
    var onChange = opts.onChange || function () {};

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping !== undefined) renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    camera.position.set(3, 2.2, 3.8);

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.02;
    controls.maxDistance = 5000;
    controls.autoRotateSpeed = 1.7;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2b3342, 1.05));

    var key = new THREE.DirectionalLight(0xffffff, 1.55);
    key.position.set(4.5, 7.5, 5.5);
    scene.add(key);

    var fill = new THREE.DirectionalLight(0xdbe6ff, 0.55);
    fill.position.set(-6, 2.4, -3.8);
    scene.add(fill);

    var rim = new THREE.DirectionalLight(0xffffff, 0.42);
    rim.position.set(-1.5, 4.2, -7);
    scene.add(rim);

    var grid = null;
    var currentRoot = null;
    var bounds = { center: new THREE.Vector3(), radius: 1, size: 1 };
    var stats = { verts: 0, tris: 0, meshes: 0, hasUV: false, hasTexture: false };
    var origWeak = new WeakMap();
    var matMode = 'texture';
    var loadToken = 0;
    var texState = null;
    var resizeObserver = null;
    var rafId = 0;

    function makeGrid(size, y) {
      if (grid) {
        scene.remove(grid);
        if (grid.geometry) grid.geometry.dispose();
        if (grid.material) grid.material.dispose();
        grid = null;
      }
      if (!size || !isFinite(size) || size <= 0) size = 4;
      grid = new THREE.GridHelper(size, 20, 0x8c9ab0, 0x495468);
      if (grid.material) {
        grid.material.transparent = true;
        grid.material.opacity = 0.34;
      }
      grid.position.set(bounds.center.x, typeof y === 'number' ? y : 0, bounds.center.z);
      scene.add(grid);
    }

    function applyGridVisibility(visible) {
      if (grid) grid.visible = !!visible;
    }

    function resize() {
      var w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function tick() {
      rafId = requestAnimationFrame(tick);
      if (!host.offsetParent) return;
      controls.update();
      renderer.render(scene, camera);
    }

    function measure(root) {
      var box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) {
        bounds.center.set(0, 0, 0);
        bounds.radius = 1;
        bounds.size = 2;
        return box;
      }
      box.getCenter(bounds.center);
      var s = new THREE.Vector3();
      box.getSize(s);
      bounds.size = Math.max(s.x, s.y, s.z, 0.01);
      bounds.radius = Math.max(s.length() * 0.5, 0.01);
      return box;
    }

    function snapshotMaterials(root) {
      root.traverse(function (o) {
        if (!o.isMesh) return;
        var wasArray = Array.isArray(o.material);
        var mats = wasArray ? o.material : [o.material];
        var cloned = mats.map(function (m) { return m && m.clone ? m.clone() : m; });
        o.material = wasArray ? cloned : cloned[0];
        cloned.forEach(function (m) {
          if (!m) return;
          origWeak.set(m, {
            map: m.map || null,
            color: m.color ? m.color.getHex() : null,
            roughness: typeof m.roughness === 'number' ? m.roughness : null,
            metalness: typeof m.metalness === 'number' ? m.metalness : null,
            transparent: !!m.transparent,
            opacity: typeof m.opacity === 'number' ? m.opacity : 1,
            side: m.side,
            wireframe: !!m.wireframe
          });
        });
      });
    }

    function collectStats(root) {
      var s = { verts: 0, tris: 0, meshes: 0, hasUV: false, hasTexture: !!(texState && texState.tex) };
      root.traverse(function (o) {
        if (!o.isMesh) return;
        s.meshes++;
        var g = o.geometry;
        if (g && g.attributes && g.attributes.position) s.verts += g.attributes.position.count;
        if (g) {
          if (g.index) s.tris += Math.round(g.index.count / 3);
          else if (g.attributes && g.attributes.position) s.tris += Math.round(g.attributes.position.count / 3);
          if (g.attributes && g.attributes.uv) s.hasUV = true;
        }
      });
      stats = s;
      return s;
    }

    function refreshMaterials() {
      if (!currentRoot) return;
      var hasTex = !!(texState && texState.tex);
      var texOpts = texState && texState.opts ? texState.opts : {};
      currentRoot.traverse(function (o) {
        if (!o.isMesh) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          if (!m) return;
          var o0 = origWeak.get(m);
          if (!o0) return;
          if (matMode === 'clay') {
            m.map = null;
            m.wireframe = false;
            if (m.color) m.color.setHex(0xd8dde6);
            if ('roughness' in m) m.roughness = 0.82;
            if ('metalness' in m) m.metalness = 0.02;
          } else if (matMode === 'wire') {
            m.map = null;
            m.wireframe = true;
            if (m.color) m.color.setHex(0x8fc1ff);
            if ('roughness' in m) m.roughness = 0.55;
            if ('metalness' in m) m.metalness = 0;
          } else {
            m.wireframe = false;
            if (hasTex) {
              m.map = texState.tex;
              if (m.color) m.color.setHex(0xffffff);
              if ('roughness' in m) m.roughness = clamp(Number(texOpts.roughness), 0, 1) || 0;
              if ('metalness' in m) m.metalness = clamp(Number(texOpts.metalness), 0, 1) || 0;
            } else {
              m.map = o0.map;
              if (m.color && o0.color !== null) m.color.setHex(o0.color);
              if ('roughness' in m && o0.roughness !== null) m.roughness = o0.roughness;
              if ('metalness' in m && o0.metalness !== null) m.metalness = o0.metalness;
            }
            m.transparent = o0.transparent;
            m.opacity = o0.opacity;
            if (o0.side !== undefined) m.side = o0.side;
          }
          m.needsUpdate = true;
        });
      });
      stats.hasTexture = hasTex;
    }

    function frame(dir, target, radius) {
      var c = target || bounds.center;
      var r = radius || bounds.radius;
      var fov = camera.fov * Math.PI / 180;
      var dist = r / Math.max(Math.sin(fov / 2), 0.12) * 1.08;
      camera.near = Math.max(r / 800, 0.001);
      camera.far = Math.max(r * 200, 100);
      camera.updateProjectionMatrix();
      camera.position.copy(c).add(dir.clone().normalize().multiplyScalar(dist));
      controls.target.copy(c);
      controls.update();
    }

    function fit() { frame(new THREE.Vector3(1.15, 0.72, 1.45)); }

    function setCameraPreset(key) {
      var d;
      camera.up.set(0, 1, 0);
      if (key === 'front') d = new THREE.Vector3(0, 0, 1);
      else if (key === 'back') d = new THREE.Vector3(0, 0, -1);
      else if (key === 'left') d = new THREE.Vector3(-1, 0, 0);
      else if (key === 'right') d = new THREE.Vector3(1, 0, 0);
      else if (key === 'top') { d = new THREE.Vector3(0, 1, 0.001); camera.up.set(0, 0, -1); }
      else d = new THREE.Vector3(1.15, 0.72, 1.45);
      frame(d);
    }

    async function load(url, textureSpec) {
      if (!window.Model3D || typeof window.Model3D.load !== 'function') throw new Error('Model3D 未加载');
      var token = ++loadToken;
      var res0 = await window.Model3D.load(url);
      if (token !== loadToken) return null;
      /* Model3D.load 返回 { root, center, radius, ... }，视口要的是 Object3D 本身 */
      var root = res0 && res0.root ? res0.root : res0;

      if (currentRoot) scene.remove(currentRoot);
      currentRoot = root;

      snapshotMaterials(root);
      scene.add(root);

      var box = measure(root);
      makeGrid(bounds.size * 2.6, box.isEmpty() ? 0 : box.min.y);
      stats = collectStats(root);

      clearTexture();
      fit();

      if (textureSpec && textureSpec.url) {
        try {
          await applyTexture(textureSpec.url, textureSpec);
        } catch (e) {
          /* 纹理失败不阻断模型显示，交给 app 记录日志 */
        }
      }
      refreshMaterials();
      onChange({ type: 'model', stats: stats });
      return { stats: stats, size: bounds.size };
    }

    function clearTexture() {
      if (texState && texState.tex && texState.tex.dispose) {
        try { texState.tex.dispose(); } catch (_) { /* ignore */ }
      }
      texState = null;
      stats.hasTexture = false;
      refreshMaterials();
      onChange({ type: 'texture', hasTexture: false });
    }

    function loadTexture(src) {
      return new Promise(function (resolve, reject) {
        var loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(src, resolve, undefined, function () { reject(new Error('纹理加载失败')); });
      });
    }

    async function applyTexture(url, texOpts) {
      var opts = texOpts || {};
      var tex = await loadTexture(url);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      var tile = clamp(Number(opts.tile) || 1, 0.1, 32);
      tex.repeat.set(tile, tile);
      if (THREE.SRGBColorSpace !== undefined && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
      else if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
      try { tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); } catch (_) { /* ignore */ }

      if (texState && texState.tex && texState.tex.dispose) {
        try { texState.tex.dispose(); } catch (_) { /* ignore */ }
      }
      texState = {
        tex: tex,
        opts: {
          url: url,
          tile: tile,
          roughness: clamp(Number(opts.roughness), 0, 1) || 0,
          metalness: clamp(Number(opts.metalness), 0, 1) || 0
        }
      };
      matMode = 'texture';
      refreshMaterials();
      stats.hasTexture = true;
      onChange({ type: 'texture', hasTexture: true });
      return true;
    }

    function updateTexture(texOpts) {
      if (!texState) return false;
      if (!texState.opts) texState.opts = {};
      if (texOpts.tile !== undefined) {
        var tile = clamp(Number(texOpts.tile) || 1, 0.1, 32);
        texState.opts.tile = tile;
        if (texState.tex) texState.tex.repeat.set(tile, tile);
      }
      if (texOpts.roughness !== undefined) texState.opts.roughness = clamp(Number(texOpts.roughness), 0, 1) || 0;
      if (texOpts.metalness !== undefined) texState.opts.metalness = clamp(Number(texOpts.metalness), 0, 1) || 0;
      refreshMaterials();
      return true;
    }

    function setMaterialMode(mode) {
      matMode = mode === 'clay' || mode === 'wire' ? mode : 'texture';
      refreshMaterials();
      onChange({ type: 'mat', mode: matMode });
    }

    function setAutoRotate(on) { controls.autoRotate = !!on; }
    function setGrid(on) { applyGridVisibility(on); }

    function screenshot() {
      renderer.render(scene, camera);
      try { return renderer.domElement.toDataURL('image/png'); }
      catch (e) { throw new Error('截图失败：画布被跨域资源污染'); }
    }

    async function exportGLB() {
      if (!currentRoot) throw new Error('没有可导出的模型');
      if (!THREE.GLTFExporter) throw new Error('GLTFExporter 未加载');
      var prev = matMode;
      setMaterialMode('texture');
      try {
        var exporter = new THREE.GLTFExporter();
        var data = await new Promise(function (resolve, reject) {
          try {
            exporter.parse(currentRoot, resolve, { binary: true, embedImages: true, onlyVisible: true });
          } catch (e) { reject(e); }
        });
        return data;
      } finally {
        setMaterialMode(prev);
      }
    }

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();
    tick();

    return {
      load: load,
      fit: fit,
      setCameraPreset: setCameraPreset,
      setMaterialMode: setMaterialMode,
      getMaterialMode: function () { return matMode; },
      applyTexture: applyTexture,
      updateTexture: updateTexture,
      clearTexture: clearTexture,
      hasTexture: function () { return !!(texState && texState.tex); },
      textureOpts: function () { return texState && texState.opts ? texState.opts : null; },
      setGrid: setGrid,
      setAutoRotate: setAutoRotate,
      screenshot: screenshot,
      exportGLB: exportGLB,
      stats: function () { return stats; },
      bounds: function () { return { center: bounds.center.clone(), radius: bounds.radius, size: bounds.size }; },
      resize: resize,
      destroy: function () {
        cancelAnimationFrame(rafId);
        if (resizeObserver) resizeObserver.disconnect();
        if (currentRoot) scene.remove(currentRoot);
        if (grid) {
          if (grid.geometry) grid.geometry.dispose();
          if (grid.material) grid.material.dispose();
        }
        renderer.dispose();
        if (renderer.domElement && renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      }
    };
  }

  window.TripStudioViewport = {
    createImageStage: createImageStage,
    createModelStage: createModelStage
  };
})();
