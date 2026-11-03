/* 参数化建模内核（自研，不依赖 Tripo / Blender）
 *
 * 定位：把「建模」拆成两个可分离的阶段，和整个项目的思路一致——
 *   AI 只产出**规格 JSON**（创作期，一次），几何由这里的确定性代码搭出来（执行期，可重放）。
 *   规格是纯数据，所以同一个 spec 永远得到同一个模型；改一个数字就是改一处比例，不用重新生成。
 *
 * 能力（第一版，够搭「人形 / 道具 / 装置」这类由基础体拼出来的形体）：
 *   shape      box / sphere / capsule / cylinder / cone / torus / plane
 *   size       每个 shape 三个参数（见 SHAPES[shape].size 的说明）
 *   pos / rot  米为单位的位移、以度为单位的欧拉角
 *   mirror     沿某轴镜像一份（做左右对称的肢体 / 耳朵）
 *   repeat     沿一个方向阵列（做鞋带孔、栅栏、牙齿这类重复件）
 *   color      每件独立颜色（导出 GLB 时是一组材质）
 *   height     整体高度（米）：规格里写了就把模型缩放到这个高度并落在地面上
 *
 * 不做：布尔、细分曲面、雕刻、绑骨。这些要么需要真拓扑算法，要么该交给专门的 DCC 工具；
 * 在这里假装能做，只会给出一堆看不出问题的烂网格。规格里出现未知 shape 会**明确报错**，
 * 而不是悄悄跳过（静默降级 = 用户以为建模成功，拿到一个缺零件的模型）。
 */
(function (global) {
  'use strict';

  var SHAPES = {
    box: { size: '[宽, 高, 深]', geo: function (s, seg) { return new THREE.BoxGeometry(s[0], s[1], s[2], 1, 1, 1); } },
    sphere: { size: '[半径X, 半径Y, 半径Z]', geo: function (s, seg) { return new THREE.SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.75))); }, unit: true },
    /* ⚠ 胶囊不能像球那样「单位几何 + 缩放」：three 的 CapsuleGeometry(radius, length)
       半径参与总高（总高 = length + 2*radius），再乘缩放就把长度也一起乘了。
       所以这里直接按真实半径/长度建，只在横截面是椭圆时补一个 z 缩放。 */
    capsule: { size: '[半径, 柱长, 半径]', geo: function (s, seg) { return new THREE.CapsuleGeometry(s[0], s[1], 6, seg); } },
    cylinder: { size: '[上半径, 高, 下半径]', geo: function (s, seg) { return new THREE.CylinderGeometry(s[0], s[2], s[1], seg, 1); } },
    cone: { size: '[底半径, 高, 底半径]', geo: function (s, seg) { return new THREE.ConeGeometry(s[0], s[1], seg, 1); } },
    torus: { size: '[主半径, 管半径, 忽略]', geo: function (s, seg) { return new THREE.TorusGeometry(s[0], s[1], Math.max(6, Math.round(seg * 0.5)), seg); } },
    plane: { size: '[宽, 高, 忽略]', geo: function (s, seg) { return new THREE.PlaneGeometry(s[0], s[1], 1, 1); }, side: true },

    /* ---------- 曲线 / 曲面：基础体拼不出来的东西都靠这三类 ----------
     * tube  沿三维样条扫掠（可锥形收细）→ 发丝、螺旋卷、飘带、手指、绑绳
     * lathe 二维轮廓绕 Y 轴旋转 → 腿、靴、杯状裙摆、任何回转体
     * loft  一组椭圆截面按高度放样 → 躯干、四肢、裙筒（截面可偏心，做出前凸后翘）
     * 这三个的 spec 不用 size，用各自的数据字段（见各条注释）。 */
    tube: {
      size: '[管半径, 收尾半径, 忽略]',
      curve: true,
      geo: function (s, seg, part) {
        var pts = (part.points || []).map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
        var curve = new THREE.CatmullRomCurve3(pts, !!part.closed, 'catmullrom', 0.5);
        var tubular = Math.max(8, Math.min(160, Math.round(num(part.tubular, Math.max(12, pts.length * 8)))));
        var radial = Math.max(6, Math.min(24, seg));
        var geo = new THREE.TubeGeometry(curve, tubular, 1, radial, !!part.closed);
        /* 锥形：TubeGeometry 只有恒定半径，所以先按单位半径建，再逐环缩放离轴偏移。
         * 顶点顺序是「环 × 每环 radial+1 个」，第 i 个顶点属于第 floor(i/(radial+1)) 环。 */
        var r0 = Math.max(1e-4, s[0]);
        var r1 = Math.max(1e-4, s[1] || s[0]);
        var per = radial + 1;
        var pos = geo.attributes.position;
        var c = new THREE.Vector3(), v = new THREE.Vector3();
        for (var i = 0; i < pos.count; i++) {
          var ring = Math.floor(i / per);
          var t = part.closed ? (ring / tubular) : (ring / tubular);
          var k = r0 + (r1 - r0) * t;
          curve.getPointAt(Math.min(1, t), c);
          v.set(pos.getX(i) - c.x, pos.getY(i) - c.y, pos.getZ(i) - c.z).multiplyScalar(k);
          pos.setXYZ(i, c.x + v.x, c.y + v.y, c.z + v.z);
        }
        geo.computeVertexNormals();
        return geo;
      }
    },
    lathe: {
      size: '[整体缩放, 忽略, 忽略]',
      curve: true,
      geo: function (s, seg, part) {
        var prof = (part.profile || []).map(function (p) { return new THREE.Vector2(Math.max(0, p[0]), p[1]); });
        var geo = new THREE.LatheGeometry(prof, Math.max(8, seg));
        var k = num(s[0], 1) || 1;
        if (k !== 1) geo.scale(k, 1, k);
        if (part.squash) geo.scale(1, 1, Math.max(0.1, num(part.squash, 1)));
        geo.computeVertexNormals();
        return geo;
      }
    },
    loft: {
      size: '[基半径, 忽略, 忽略]',
      curve: true,
      geo: function (s, seg, part) {
        var secs = (part.sections || []).slice().sort(function (a, b) { return a.y - b.y; });
        var N = Math.max(6, seg);
        var rings = [];
        secs.forEach(function (sec) {
          var rx = Math.max(1e-4, num(sec.rx, 0.1)), rz = Math.max(1e-4, num(sec.rz, rx));
          var ring = [];
          for (var i = 0; i < N; i++) {
            var a = i / N * Math.PI * 2;
            ring.push(new THREE.Vector3(num(sec.cx, 0) + Math.cos(a) * rx, sec.y, num(sec.cz, 0) + Math.sin(a) * rz));
          }
          rings.push(ring);
        });
        var verts = [], idx = [];
        rings.forEach(function (ring) { ring.forEach(function (p) { verts.push(p.x, p.y, p.z); }); });
        for (var r = 0; r < rings.length - 1; r++) {
          for (var i = 0; i < N; i++) {
            var j = (i + 1) % N;
            var a0 = r * N + i, a1 = r * N + j, b0 = (r + 1) * N + i, b1 = (r + 1) * N + j;
            idx.push(a0, b0, b1, a0, b1, a1);
          }
        }
        /* 封口：两端各补一个中心点扇形，避免四视图里看到「空心管子」 */
        var bottom = verts.length / 3;
        verts.push(0, secs[0].y, 0);
        for (var i2 = 0; i2 < N; i2++) idx.push(bottom, (i2 + 1) % N, i2);
        var top = verts.length / 3;
        verts.push(0, secs[secs.length - 1].y, 0);
        var base = (rings.length - 1) * N;
        for (var i3 = 0; i3 < N; i3++) idx.push(top, base + i3, base + (i3 + 1) % N);

        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
      }
    }
  };

  var DEFAULT_SEG = 24;
  var MAX_PARTS = 200;
  var SIZES = { max: 50 };            // 单件最长边上限（米），挡住「把 160 当米填进去」这类错误

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }
  function vec3(v, d) {
    if (!Array.isArray(v)) return d.slice();
    return [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])];
  }
  function clampSize(s) {
    var m = Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
    if (!(m > 0)) return s;
    if (m <= SIZES.max) return s;
    var k = SIZES.max / m;
    return [s[0] * k, s[1] * k, s[2] * k];
  }

  /* ---------- 校验（不建网格，只出报告） ----------
   * 节点里先跑 compile：错就抛，让「规格有问题」在建模之前暴露，而不是给一个坏模型。 */
  function compile(spec) {
    var errors = [], warnings = [], parts = [];
    if (!spec || typeof spec !== 'object') {
      return { ok: false, errors: ['规格不是对象'], warnings: warnings, parts: parts };
    }
    var list = Array.isArray(spec.parts) ? spec.parts : null;
    if (!list || !list.length) {
      return { ok: false, errors: ['规格里没有 parts（至少要有一个部件）'], warnings: warnings, parts: parts };
    }
    if (list.length > MAX_PARTS) errors.push('部件数 ' + list.length + ' 超过上限 ' + MAX_PARTS);

    list.forEach(function (p, i) {
      var tag = 'parts[' + i + ']' + (p && p.id ? '(' + p.id + ')' : '');
      if (!p || typeof p !== 'object') { errors.push(tag + ' 不是对象'); return; }
      var shape = String(p.shape || '').toLowerCase();
      if (!SHAPES[shape]) {
        errors.push(tag + ' 的 shape「' + (p.shape || '空') + '」不认识，可用：' + Object.keys(SHAPES).join(' / '));
        return;
      }
      var curveKind = !!SHAPES[shape].curve;
      var size = vec3(p.size, [0.1, 0.1, 0.1]);
      if (!curveKind && !(size[0] > 0 && size[1] > 0)) errors.push(tag + ' 的 size 必须是正数');
      var raw = size.slice();
      if (!curveKind) {
        size = clampSize(size);
        if (size[0] !== raw[0]) warnings.push(tag + ' 尺寸过大，已按上限 ' + SIZES.max + ' 米等比缩小');
      }
      /* 曲线类的前置校验：字段缺了必须在建模前说清楚，否则用户拿到的是一个空节点 */
      var part3 = { points: p.points, profile: p.profile, sections: p.sections, closed: !!p.closed, squash: p.squash, tubular: p.tubular };
      if (shape === 'tube') {
        if (!Array.isArray(p.points) || p.points.length < 2) errors.push(tag + ' 的 tube 需要 points（至少 2 个 [x,y,z]）');
        else if (p.points.length > 64) errors.push(tag + ' 的 points 超过 64 个，螺旋卷请拆成几段');
      } else if (shape === 'lathe') {
        if (!Array.isArray(p.profile) || p.profile.length < 2) errors.push(tag + ' 的 lathe 需要 profile（[[半径, 高度], …] 至少 2 点）');
      } else if (shape === 'loft') {
        if (!Array.isArray(p.sections) || p.sections.length < 2) errors.push(tag + ' 的 loft 需要 sections（至少 2 个 {y,rx,rz} 截面）');
      }
      var rep = p.repeat && typeof p.repeat === 'object' ? p.repeat : null;
      if (rep) {
        var rc = Math.round(num(rep.count, 1));
        if (!(rc > 0) || rc > 64) errors.push(tag + ' 的 repeat.count 必须在 1~64');
      }
      parts.push({
        id: String(p.id || shape + i),
        shape: shape,
        size: size,
        pos: vec3(p.pos, [0, 0, 0]),
        rot: vec3(p.rot, [0, 0, 0]),
        mirror: /^(x|y|z)$/i.test(String(p.mirror || '')) ? String(p.mirror).toLowerCase() : '',
        repeat: rep ? { count: Math.round(num(rep.count, 1)), offset: vec3(rep.offset, [0, 0, 0]) } : null,
        color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(p.color || '')) ? String(p.color) : '',
        points: Array.isArray(p.points) ? p.points.map(function (q) { return vec3(q, [0, 0, 0]); }) : null,
        profile: Array.isArray(p.profile) ? p.profile.map(function (q) { return [num(q && q[0], 0), num(q && q[1], 0)]; }) : null,
        sections: Array.isArray(p.sections) ? p.sections.map(function (q) { return { y: num(q && q.y, 0), rx: num(q && q.rx, 0.05), rz: num(q && q.rz, num(q && q.rx, 0.05)), cx: num(q && q.cx, 0), cz: num(q && q.cz, 0) }; }) : null,
        closed: !!p.closed,
        squash: p.squash != null ? num(p.squash, 1) : 0,
        tubular: num(p.tubular, 0),
        seg: Math.max(6, Math.min(64, Math.round(num(p.seg, DEFAULT_SEG)))),
        smooth: p.smooth !== false
      });
    });

    var height = num(spec.height, 0);
    if (height && (height < 0.05 || height > 30)) {
      warnings.push('height ' + height + ' 米超出常规范围（0.05~30），已忽略');
      height = 0;
    }
    if (!height) warnings.push('没有给 height，模型不会被统一缩放到目标身高');
    return { ok: errors.length === 0, errors: errors, warnings: warnings, parts: parts, height: height, name: String(spec.name || '') };
  }

  function meshOf(part, scaleMul) {
    var def = SHAPES[part.shape];
    var geo = def.geo(part.size, part.seg, part);
    if (def.unit) {
      /* 球 / 胶囊是「单位几何 + 缩放」，否则三个半径没法各不相同 */
      if (part.shape === 'sphere') geo.scale(part.size[0], part.size[1], part.size[2]);
      else if (part.shape === 'capsule') {
        var r0 = Math.max(1e-4, part.size[0]);
        var r1 = Math.max(1e-4, part.size[2]);
        if (Math.abs(r1 - r0) > 1e-6) geo.scale(1, 1, r1 / r0);   // 椭圆截面才动 z
      }
    } else if (!def.curve) {
      geo.computeVertexNormals();
    }
    var mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(part.color || '#c9ccd4'),
      metalness: part.metal != null ? num(part.metal, 0) : 0,
      roughness: part.rough != null ? num(part.rough, 0.8) : 0.8,
      side: def.side ? THREE.DoubleSide : THREE.FrontSide
    });
    var m = new THREE.Mesh(geo, mat);
    m.position.set(part.pos[0] * scaleMul, part.pos[1] * scaleMul, part.pos[2] * scaleMul);
    m.rotation.set(
      part.rot[0] * Math.PI / 180, part.rot[1] * Math.PI / 180, part.rot[2] * Math.PI / 180
    );
    m.name = part.id;
    if (part.mirror) {
      m.scale.set(part.mirror === 'x' ? -1 : 1, part.mirror === 'y' ? -1 : 1, part.mirror === 'z' ? -1 : 1);
      mat.side = THREE.DoubleSide;      // 负缩放会翻面，双面渲染才不会「一面黑」
    }
    return m;
  }

  /* ---------- 建网格 ---------- */
  function assemble(cmp) {
    var group = new THREE.Group();
    group.name = cmp.name || 'model';
    cmp.parts.forEach(function (part) {
      var times = part.repeat ? part.repeat.count : 1;
      for (var k = 0; k < times; k++) {
        var clone = Object.assign({}, part);
        if (part.repeat) {
          clone.pos = [
            part.pos[0] + part.repeat.offset[0] * k,
            part.pos[1] + part.repeat.offset[1] * k,
            part.pos[2] + part.repeat.offset[2] * k
          ];
        }
        var mesh = meshOf(clone, 1);
        var mirrored = false;
        if (part.mirror) {
          /* 镜像件：负缩放那份必须跟着阵列偏移一起镜像，否则两边不对称 */
          var mm = meshOf(clone, 1);
          mm.name = part.id + '_mirror';
          mesh.name = part.id;
          mirrored = true;
          group.add(mm);
        }
        group.add(mesh);
        void mirrored;
      }
    });
    /* 统一到目标身高并落地：AI 给的 height 是硬约束，落地是让四视图 / 视图框不跑偏 */
    group.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(group);
    var size = new THREE.Vector3();
    box.getSize(size);
    if (cmp.height && size.y > 1e-6) {
      var k = cmp.height / size.y;
      group.scale.multiplyScalar(k);
      group.updateMatrixWorld(true);
      box.setFromObject(group);
    }
    var min = box.min;
    group.position.x -= (box.min.x + box.max.x) / 2;
    group.position.z -= (box.min.z + box.max.z) / 2;
    group.position.y -= min.y;
    group.updateMatrixWorld(true);
    return group;
  }

  function statsOf(group) {
    var tris = 0, verts = 0, meshes = 0;
    group.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      var g = o.geometry;
      verts += g.attributes.position ? g.attributes.position.count : 0;
      tris += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    });
    return { meshes: meshes, verts: verts, tris: Math.round(tris) };
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

  /* build(spec) → { dataURL, stats, height, report } */
  /* 单件几何（M5 基础体面板用）：走同一张 SHAPES 表，别在面板里再抄一份
   * 「球体三个半径 / 圆柱段数」的语义。返回的 BufferGeometry 由调用方负责 dispose。
   * 曲线/曲面（tube / lathe / loft）需要各自的控制点数据，不算基础体，这里明确拒绝。 */
  function geometryOf(shape, size, seg) {
    if (typeof THREE === 'undefined') throw new Error('three.js 未就绪');
    var key = String(shape || '').toLowerCase();
    var def = SHAPES[key];
    if (!def) throw new Error('不认识的 shape：' + shape);
    if (def.curve) throw new Error(key + ' 需要曲线/截面数据，不是基础体');
    var s = vec3(size, [0.1, 0.1, 0.1]);
    var n = Math.max(6, Math.min(64, Math.round(num(seg, DEFAULT_SEG))));
    var geo = def.geo(s, n);
    if (def.unit) {
      if (key === 'sphere') geo.scale(s[0], s[1], s[2]);
    } else {
      geo.computeVertexNormals();
    }
    return geo;
  }

  async function build(spec) {
    if (typeof THREE === 'undefined') throw new Error('three.js 未就绪');
    var cmp = compile(spec);
    if (!cmp.ok) {
      var err = new Error('建模规格有误：' + cmp.errors.join('；'));
      err.compile = cmp;
      throw err;
    }
    var group = assemble(cmp);
    var dataURL = await toGLB(group);
    var box = new THREE.Box3().setFromObject(group);
    var size = new THREE.Vector3();
    box.getSize(size);
    return {
      dataURL: dataURL,
      stats: statsOf(group),
      size: [size.x, size.y, size.z].map(function (v) { return +v.toFixed(3); }),
      parts: cmp.parts.length,
      warnings: cmp.warnings,
      name: cmp.name
    };
  }

  /* buildGroup(spec) → {group, report}
   * 编辑窗口要的是「活的网格」，不是导出的 GLB 字节：参数面板每改一次就重新
   * 导出/解析一遍 GLB，既慢又平白多一层缓存。几何仍然由 assemble 产出，
   * 所以和 build() 是同一份确定性执行，不会出现「编辑里看到的和导出后不一样」。 */
  function buildGroup(spec) {
    if (typeof THREE === 'undefined') throw new Error('three.js 未就绪');
    var cmp = compile(spec);
    if (!cmp.ok) {
      var err = new Error('建模规格有误：' + cmp.errors.join('；'));
      err.compile = cmp;
      throw err;
    }
    return { group: assemble(cmp), report: cmp };
  }

  /* 从 AI 文本里抠规格再建：支持的围栏 / 前后夹杂说明都吃 */
  async function buildFromText(text) {
    var spec = (typeof extractJson === 'function') ? extractJson(text) : null;
    if (!spec) {
      try { spec = JSON.parse(String(text || '')); } catch (e) { spec = null; }
    }
    if (!spec) throw new Error('没有从输入里找到 JSON 规格（需要一段 {"parts":[…]}）');
    var r = await build(spec);
    r.spec = spec;
    return r;
  }

  global.Modeler = {
    version: '1.0',
    SHAPES: Object.keys(SHAPES),
    DEFAULT_SEG: DEFAULT_SEG,
    compile: compile,
    geometryOf: geometryOf,
    build: build,
    buildGroup: buildGroup,
    buildFromText: buildFromText,
    /* 给节点 / AI 提示词用的规格说明（单一真源：改这里，提示词和校验一起变） */
    schemaHelp: function () {
      return [
        '{ "name":"角色", "height":1.6, "parts":[',
        '  {"id":"head","shape":"sphere","size":[0.11,0.13,0.12],"pos":[0,1.47,0],"color":"#f2d9c9"},',
        '  {"id":"torso","shape":"capsule","size":[0.14,0.34,0.14],"pos":[0,1.12,0],"color":"#ffffff"},',
        '  {"id":"leg","shape":"cylinder","size":[0.07,0.62,0.06],"pos":[0.09,0.42,0],"mirror":"x","color":"#f4f7fb"}',
        '] }',
        '可用 shape：' + Object.keys(SHAPES).join(' / '),
        'size 含义：box[宽,高,深] · sphere[半径X,半径Y,半径Z] · capsule[半径,柱长,半径] · cylinder[上半径,高,下半径] · cone[底半径,高,底半径] · torus[主半径,管半径,忽略] · plane[宽,高,忽略]',
        '曲线/曲面（这三类不用 size，用各自字段）：',
        '  tube   沿样条扫掠：{shape:tube,size:[起始半径,收尾半径,0],points:[[x,y,z],…2~64 点],closed:false,seg:10}',
        '         → 发丝、螺旋卷、飘带、绑绳、手指。points 就是曲线的控制点，半径可锥形收细。',
        '  lathe  旋转体：{shape:lathe,size:[整体缩放,0,0],profile:[[半径,高度],…],squash:1,seg:32}',
        '         → 腿、靴筒、杯形裙摆等回转体；profile 从下往上写，半径 0 的点自然收口。',
        '  loft   放样：{shape:loft,size:[1,0,0],sections:[{y:1.0,rx:0.14,rz:0.09,cz:0},…],seg:24}',
        '         → 躯干、裙筒、四肢这类「截面沿高度变化」的体；cx/cz 让截面偏心（做胸部/臀部）。',
        '其它字段：pos[x,y,z] 米 · rot[度,度,度] · mirror x|y|z · repeat{count,offset[x,y,z]} · color #rrggbb · seg 6~64',
        '约束：所有尺寸以米为单位、人体身高约 1.4~1.8；height 是硬约束（模型会被缩放到这个高度并落地）。'
      ].join('\n');
    }
  };
})(window);
