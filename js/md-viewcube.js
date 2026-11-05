/* ViewCube：视口右上角那块小画布
 *
 * 一块独立的小画布：六个面带标签的立方体，朝向永远等于主相机朝向的逆，
 * 所以视口里怎么转，它就跟着怎么转，还能看出三个面近大远小的透视。
 * 单独开 renderer 而不是画进主视口：主场景在「线框」模式是白底、还会被
 * 模型挡住，小画布透明底浮在最上层，任何着色模式下都读得清。
 *
 * 为什么拆出来：拾取、拖拽环绕、翻 90°、双击回轴测都只碰 st.cube 这块
 * 私有渲染状态，跟主场景的渲染循环只差一个 draw() 调用。
 *
 * 对外（window.MDViewCube）：create(ctx) → { bind, draw }
 * 外壳保留 bindCube / drawCube 两个门面，原调用点不用改。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, THREE = ctx.THREE, $ = ctx.$;
    var updateChrome = ctx.updateChrome, updateHud = ctx.updateHud;
    var setStatus = ctx.setStatus;
    var turnBy = ctx.turnBy, tumbleBy = ctx.tumbleBy, viewFromPreset = ctx.viewFromPreset;

    var CUBE_FACES = [
      { kind: 'right', label: '右', axes: [1, 0, 0] },
      { kind: 'left', label: '左', axes: [-1, 0, 0] },
      { kind: 'top', label: '顶', axes: [0, 1, 0] },
      { kind: 'bottom', label: '底', axes: [0, -1, 0] },
      { kind: 'front', label: '前', axes: [0, 0, 1] },
      { kind: 'back', label: '后', axes: [0, 0, -1] }
    ];
    var CUBE_SIZE = 92;
    var CUBE_SIDE = 1.5;
    /* 六个面用六块 PlaneGeometry 拼，而不是一个 BoxGeometry：
     * BoxGeometry 的 UV 是给贴图设计的（+Y / -Y 的竖直轴是 Z），文字直接贴会歪；
     * 自己摆六个面，每面的「上」都能对准那个正视图里的屏幕上方，标签永远是正的。 */
    var CUBE_FACE_XF = [
      { pos: [0.75, 0, 0], rot: [0, Math.PI / 2, 0] },     /* 右 +X：字头朝 +Y */
      { pos: [-0.75, 0, 0], rot: [0, -Math.PI / 2, 0] },   /* 左 -X */
      { pos: [0, 0.75, 0], rot: [-Math.PI / 2, 0, 0] },    /* 顶 +Y：字头朝 -Z */
      { pos: [0, -0.75, 0], rot: [Math.PI / 2, 0, 0] },    /* 底 -Y：字头朝 +Z */
      { pos: [0, 0, 0.75], rot: [0, 0, 0] },               /* 前 +Z */
      { pos: [0, 0, -0.75], rot: [0, Math.PI, 0] }         /* 后 -Z */
    ];

    function cubeFaceTexture(label) {
      var c = document.createElement('canvas');
      c.width = c.height = 128;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0, '#eeeff2'); g.addColorStop(1, '#cfd3da');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      x.strokeStyle = '#9aa1ab'; x.lineWidth = 6;
      x.strokeRect(3, 3, 122, 122);
      x.fillStyle = '#2c3138';
      x.font = '600 44px system-ui,"Microsoft YaHei",sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(label, 64, 66);
      var t = new THREE.CanvasTexture(c);
      if ('encoding' in t) t.encoding = THREE.sRGBEncoding;
      return t;
    }

    function setupCube() {
      var box = $('mdCube'), canvas = $('mdCubeCanvas');
      if (!box || !canvas || !THREE) return;
      var size = box.clientWidth || CUBE_SIZE;
      var renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
      } catch (e) {
        /* 开不出第二个 WebGL 上下文时宁可没有立方体，也不要把主视口一起拖垮 */
        box.style.display = 'none';
        return;
      }
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      renderer.setSize(size, size, false);
      renderer.setClearAlpha(0);
      if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

      var scene = new THREE.Scene();
      var cam = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      cam.position.set(0, 0, 4.4);
      cam.lookAt(0, 0, 0);
      scene.add(new THREE.AmbientLight(0xffffff, 0.95));
      var key = new THREE.DirectionalLight(0xffffff, 0.75);
      key.position.set(-1.4, 1.8, 2.4);
      scene.add(key);

      var group = new THREE.Group();
      scene.add(group);
      var faceGeo = new THREE.PlaneGeometry(CUBE_SIDE, CUBE_SIDE);
      var planes = [], mats = [];
      CUBE_FACES.forEach(function (f, i) {
        var mat = new THREE.MeshStandardMaterial({ map: cubeFaceTexture(f.label), roughness: 1, metalness: 0 });
        var mesh = new THREE.Mesh(faceGeo, mat);
        var xf = CUBE_FACE_XF[i];
        mesh.position.set(xf.pos[0], xf.pos[1], xf.pos[2]);
        mesh.rotation.set(xf.rot[0], xf.rot[1], xf.rot[2]);
        mesh.userData.face = i;
        group.add(mesh);
        planes.push(mesh);
        mats.push(mat);
      });
      /* 棱线单独画一遍：六个面各自有边框，但立方体的骨架更清楚 */
      group.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE_SIDE, CUBE_SIDE, CUBE_SIDE)),
        new THREE.LineBasicMaterial({ color: 0x7d8794 })
      ));

      st.cube = {
        box: box, canvas: canvas, renderer: renderer, scene: scene, cam: cam,
        group: group, planes: planes, mats: mats, q: new THREE.Quaternion(),
        ray: new THREE.Raycaster()
      };
      drawCube();
    }

    /* 相机怎么转，立方体就反向转同样的角度：屏幕上的立方体 = 世界坐标轴的朝向 */
    function drawCube() {
      var c = st.cube;
      if (!c || !st.camera || st.quad || !c.renderer) return;
      c.q.copy(st.camera.quaternion).conjugate();
      c.group.quaternion.copy(c.q);
      c.renderer.render(c.scene, c.cam);

      /* 四个转向三角只在「归正」时露出：视线正对某个轴（前/后/左/右/顶/底）。
       * 斜着看的时候再翻 90° 落点还是斜的，箭头没有意义，反而挡住立方体的面。 */
      if (st.controls) {
        var dir = st.camera.position.clone().sub(st.controls.target).normalize();
        var aligned = Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)) > 0.999;
        if (aligned !== c.aligned) {
          c.aligned = aligned;
          c.box.classList.toggle('on', aligned);
        }
      }
    }

    function cubePick(e) {
      var c = st.cube;
      if (!c) return -1;
      var r = c.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return -1;
      c.group.updateMatrixWorld(true);
      c.ray.setFromCamera(new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      ), c.cam);
      var hit = c.ray.intersectObjects(c.planes, false)[0];
      return (hit && hit.object && typeof hit.object.userData.face === 'number')
        ? hit.object.userData.face : -1;
    }

    function bind() {
      setupCube();
      var c = st.cube;
      if (!c) return;
      var box = c.box;

      function tint(i) {
        c.mats.forEach(function (m, k) { m.color.setHex(k === i ? 0xffcf86 : 0xffffff); });
      }

      /* 四边的小三角是按钮，不走拖拽那条路：命中它就直接转 90° */
      box.querySelectorAll('[data-md-turn]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          turnBy(btn.getAttribute('data-md-turn'));
        });
        btn.addEventListener('dblclick', function (e) { e.stopPropagation(); });
      });

      box.addEventListener('pointerdown', function (e) {
        if (e.button) return;
        if (e.target && e.target.closest && e.target.closest('[data-md-turn]')) return;
        st.cubeDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, face: cubePick(e) };
        box.classList.add('drag');
        try { box.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });

      box.addEventListener('pointermove', function (e) {
        var d = st.cubeDrag;
        if (!d) {
          var hov = cubePick(e);
          if (hov !== st.cubeHover) { st.cubeHover = hov; tint(hov); }
          box.style.cursor = hov >= 0 ? 'pointer' : 'grab';
          return;
        }
        if (d.id !== e.pointerId) return;
        var dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (!d.moved) return;
        tumbleBy(dx, dy);
        d.x = e.clientX;
        d.y = e.clientY;
      });

      box.addEventListener('pointerup', function (e) {
        var d = st.cubeDrag;
        if (!d || d.id !== e.pointerId) return;
        st.cubeDrag = null;
        box.classList.remove('drag');
        try { box.releasePointerCapture(e.pointerId); } catch (err) {}
        if (d.moved) {
          st.viewName = '自由';
          updateChrome();
          updateHud();
          setStatus('视口已环绕');
          return;
        }
        var face = CUBE_FACES[d.face];
        if (!face) return;
        /* 留一点延迟，双击时不要先跳一次单面视图 */
        clearTimeout(st.cubeClickTimer);
        st.cubeClickTimer = setTimeout(function () { viewFromPreset(face.kind); }, 260);
      });

      box.addEventListener('pointercancel', function () {
        st.cubeDrag = null;
        box.classList.remove('drag');
      });

      box.addEventListener('pointerleave', function () {
        if (st.cubeDrag) return;
        st.cubeHover = -1;
        tint(-1);
      });

      box.addEventListener('dblclick', function (e) {
        e.preventDefault();
        clearTimeout(st.cubeClickTimer);
        st.cubeDrag = null;
        viewFromPreset('iso');
      });
    }

    return { bind: bind, draw: drawCube };
  }

  global.MDViewCube = { create: create };
})(window);
