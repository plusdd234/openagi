/* 101 机械臂控制台 —— 等比例 3D 孪生 + 总线舵机信号仿真。
 *
 * 机型参照开源 SO-101（LeRobot）六轴桌面臂：5 个旋转关节 + 1 个夹爪，
 * 舵机按 Feetech STS3215 建模，通信按 SCS 总线帧（FF FF ID LEN INSTR ... CHK）。
 * 这里不连接真实硬件：滑杆 → 目标角 → 位置指令 → 3D 臂平滑跟随，
 * 信号监视器里能看到实际拼出来的十六进制帧，方便对照真机协议。
 *
 * 三维场景用 index.html 里已加载的全局 THREE + OrbitControls（r149）。
 */
(function () {
  'use strict';

  /* ---------- 机型参数 ----------
   * 关节顺序、行程与零位取自 SO-ARM100 官方 URDF（so101_new_calib.urdf）：
   * shoulder_pan ±110°、shoulder_lift ±100°、elbow_flex ±96.8°、
   * wrist_flex ±95°、wrist_roll −157.2°…162.8°、gripper −10°…100°。
   * 连杆长度：肩→肘 116 mm，肘→腕 135 mm，腕→腕转 61.1 mm，腕转→夹持点 98.1 mm。
   */
  var JOINTS = [
    { key: 'pan',   id: 1, label: '底座回转', en: 'shoulder_pan',  min: -110, max: 110, unit: '°' },
    { key: 'lift',  id: 2, label: '大臂俯仰', en: 'shoulder_lift', min: -100, max: 100, unit: '°' },
    { key: 'elbow', id: 3, label: '小臂俯仰', en: 'elbow_flex',    min: -97,  max: 97,  unit: '°' },
    { key: 'wrist', id: 4, label: '腕部俯仰', en: 'wrist_flex',    min: -95,  max: 95,  unit: '°' },
    { key: 'roll',  id: 5, label: '腕部旋转', en: 'wrist_roll',    min: -157, max: 163, unit: '°' },
    { key: 'grip',  id: 6, label: '夹爪开合', en: 'gripper',       min: 0,    max: 100, unit: '%' }
  ];

  /* 零位是「大臂竖直、小臂水平前伸」的 L 形，肘角为正 = 小臂向下折，lift 为负 = 整条臂上抬。
   * 下面这些姿态都用官方 URDF 正运动学校核过：HOME 末端在 (277, 153, 0) mm，
   * 抓取位在 (238, 16, 0) mm 且工具朝下，夹指正好落在 30 mm 工件的两侧。 */
  var HOME_POSE = { pan: 0, lift: -36, elbow: 24, wrist: 50, roll: 0, grip: 35 };

  var PICK_POSE = { pan: 0, lift: 0, elbow: 26, wrist: 55, roll: 0, grip: 60 };

  /* 夹爪：0% 合拢（夹指内距约 10 mm）、100% 全开约 63 mm；
   * 夹住 30 mm 工件时舵轴停在 12°（按官方 STL 实测内距≈30 mm） */
  var GRIP_CLOSED = -7;
  var GRIP_SPAN = 50;
  var GRASP_DEG = 12;

  var PIECE_HOME = { x: 0.25, y: 0.015, z: 0 };

  var DEMO = [
    { label: '观察位 · 抬臂张开夹爪', pose: { pan: 0,   lift: -36, elbow: 24,  wrist: 50, roll: 0, grip: 85 } },
    { label: '接近工件 · 移至上方',   pose: { pan: 0,   lift: 0,   elbow: 20,  wrist: 62, roll: 0, grip: 85 } },
    { label: '下探 · 对准夹取点',     pose: { pan: 0,   lift: 0,   elbow: 26,  wrist: 55, roll: 0, grip: 85 } },
    { label: '夹持 · 闭合夹爪',       pose: PICK_POSE },
    { label: '抬升 · 保持夹持',       pose: { pan: 0,   lift: 0,   elbow: -10, wrist: 80, roll: 0, grip: 60 } },
    { label: '转移 · 底座回转',       pose: { pan: -28, lift: 0,   elbow: -10, wrist: 80, roll: 0, grip: 60 } },
    { label: '下放 · 下降到位',       pose: { pan: -28, lift: 0,   elbow: 26,  wrist: 55, roll: 0, grip: 60 } },
    { label: '释放 · 张开夹爪',       pose: { pan: -28, lift: 0,   elbow: 26,  wrist: 55, roll: 0, grip: 88 } },
    { label: '复位 · 回到 Home',      pose: HOME_POSE }
  ];

  /* ---------- 运行状态 ---------- */
  var S = {
    body: null, win: null, stage: null, canvas: null,
    refs: {}, rig: null, scene: null, camera: null, renderer: null, controls: null,
    cur: {}, goal: {}, speed: 5,
    linked: true, estop: false, demo: false, demoStep: 0, demoTimer: 0,
    packets: 0, lastTs: 0, lastTip: 0, raf: 0, started: false,
    view0: null, tmp: null, piece: null, held: false
  };

  /* ---------- 小工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad4(n) { return ('0000' + n).slice(-4); }
  function hex8(n) { return ('0' + (n & 255).toString(16).toUpperCase()).slice(-2); }
  function nowStr() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + ('00' + d.getMilliseconds()).slice(-3);
  }
  function ticksFor(j, value) {
    return Math.round(clamp((value - j.min) / (j.max - j.min), 0, 1) * 4095);
  }

  /* ---------- SCS 总线帧（Feetech 兼容） ---------- */
  function frameWrite(id, ticks) {
    var params = [0x2A, ticks & 255, (ticks >> 8) & 255];
    var len = params.length + 2;
    var sum = id + len + 0x03;
    for (var i = 0; i < params.length; i++) sum += params[i];
    var all = [0xFF, 0xFF, id, len, 0x03].concat(params, [(~sum) & 255]);
    return all.map(hex8).join(' ');
  }

  function frameSync(list) {
    var params = [0x2A, 0x02];
    list.forEach(function (x) {
      params.push(x.id, x.ticks & 255, (x.ticks >> 8) & 255);
    });
    var len = params.length + 2;
    var sum = 0xFE + len + 0x83;
    for (var i = 0; i < params.length; i++) sum += params[i];
    var all = [0xFF, 0xFF, 0xFE, len, 0x83].concat(params, [(~sum) & 255]);
    return all.map(hex8).join(' ');
  }

  function syncList() {
    return JOINTS.map(function (j) {
      return { id: j.id, ticks: ticksFor(j, S.goal[j.key]) };
    });
  }

  /* ---------- 信号监视器 ---------- */
  function log(kind, text) {
    var el = S.refs.log;
    if (!el) return;
    var stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 26;
    var line = document.createElement('div');
    line.className = 'arm101-line is-' + kind;
    var tag = kind === 'tx' ? 'TX' : kind === 'rx' ? 'RX' : kind === 'err' ? 'STOP' : 'SYS';
    line.innerHTML = '<span class="arm101-time"></span><span class="arm101-tag"></span><span class="arm101-msg"></span>';
    line.querySelector('.arm101-time').textContent = nowStr();
    line.querySelector('.arm101-tag').textContent = tag;
    line.querySelector('.arm101-msg').textContent = text;
    el.appendChild(line);
    while (el.children.length > 140) el.removeChild(el.firstChild);
    if (stick) el.scrollTop = el.scrollHeight;
  }

  /* ---------- 三维模型 ----------
   * 打印件与舵机直接用 SO-101 官方 STL（parts.js，int16 量化 0.1 mm）。
   * 关节原点 / 视件 origin 均按官方 URDF（so101_new_calib.urdf）摆放：
   *   URDF 是 Z 轴朝上，这里把整机挂在一个绕 X 轴 −90° 的组里，场景仍然是 Y 轴朝上。
   */
  var M = null;
  var ZAXIS = new THREE.Vector3(0, 0, 1);
  var _q = new THREE.Quaternion();

  function buildMaterials() {
    return {
      body:   new THREE.MeshStandardMaterial({ color: 0xeae6dc, roughness: 0.6,  metalness: 0.03 }),
      body2:  new THREE.MeshStandardMaterial({ color: 0xd6d0c3, roughness: 0.7,  metalness: 0.03 }),
      servo:  new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.44, metalness: 0.32 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xef9f3c, roughness: 0.4,  metalness: 0.24 }),
      dark:   new THREE.MeshStandardMaterial({ color: 0x3b414a, roughness: 0.62, metalness: 0.18 }),
      mat:    new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.94, metalness: 0.04 }),
      piece:  new THREE.MeshStandardMaterial({ color: 0xd9544a, roughness: 0.52, metalness: 0.08 })
    };
  }

  function roundedGeo(w, h, d, r) {
    var s = new THREE.Shape();
    var x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    var geo = new THREE.ExtrudeGeometry(s, {
      depth: d, bevelEnabled: true,
      bevelThickness: Math.min(r * 0.55, d * 0.22),
      bevelSize: Math.min(r * 0.55, 0.0016),
      bevelSegments: 2, curveSegments: 5
    });
    geo.center();
    return geo;
  }

  function ring(parent, radius, tube, mat, y) {
    var m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 72), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    parent.add(m);
    return m;
  }

  /* URDF 的 rpy = Rz(yaw) · Ry(pitch) · Rx(roll) */
  function quatRpy(r, p, y) {
    var m = new THREE.Matrix4();
    m.multiplyMatrices(
      new THREE.Matrix4().makeRotationZ(y),
      new THREE.Matrix4().makeRotationY(p)
    ).multiply(new THREE.Matrix4().makeRotationX(r));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  function partAt(parent, xyz, rpy) {
    var g = new THREE.Group();
    g.position.set(xyz[0], xyz[1], xyz[2]);
    if (rpy) g.quaternion.copy(quatRpy(rpy[0], rpy[1], rpy[2]));
    parent.add(g);
    return g;
  }

  /* 关节组：记住初始姿态，后面绕自身 Z 轴叠加转角 */
  function jointAt(parent, xyz, rpy) {
    var g = partAt(parent, xyz, rpy);
    g.userData.base = g.quaternion.clone();
    return g;
  }

  function spin(g, deg) {
    if (!g || !g.userData.base) return;
    _q.setFromAxisAngle(ZAXIS, deg * Math.PI / 180);
    g.quaternion.copy(g.userData.base).multiply(_q);
  }

  /* parts.js 按需加载：只有打开本 App 才付这 2.6 MB 的解析成本 */
  function loadParts(done) {
    if (window.ARM101_PARTS) { done(true); return; }
    var s = document.createElement('script');
    s.src = 'apps/arm101/parts.js';
    s.onload = function () { done(!!window.ARM101_PARTS); };
    s.onerror = function () { done(false); };
    document.head.appendChild(s);
  }

  var geoCache = {};

  /* int16（0.1 mm）→ Float32 米制顶点；三角面法线在运行时算一次 */
  function partGeo(key) {
    if (geoCache[key]) return geoCache[key];
    var rec = window.ARM101_PARTS && window.ARM101_PARTS[key];
    if (!rec) return null;
    var bin = atob(rec.b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var q = new Int16Array(bytes.buffer);
    var pos = new Float32Array(q.length);
    for (var k = 0; k < q.length; k++) pos[k] = q[k] * 0.0001;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geoCache[key] = geo;
    return geo;
  }

  /* 按 URDF 视件 origin 摆一个 STL 零件 */
  function partMesh(parent, key, xyz, rpy, mat) {
    var geo = partGeo(key);
    if (!geo) return null;
    var g = partAt(parent, xyz, rpy);
    var m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return g;
  }

  /* ---------- 机体：底座 / 旋转座 / 大臂 / 小臂 / 腕 / 夹爪 ---------- */

  function buildBase(parent, ledMat) {
    /* base_link：底板 + 电机座 + 底盘舵机 */
    partMesh(parent, 'base', [-0.00636471, 0, -0.0024], [Math.PI / 2, 0, Math.PI / 2], M.body);
    partMesh(parent, 'baseHolder', [-0.00636471, -0.0000994414, -0.0024], [Math.PI / 2, 0, Math.PI / 2], M.body2);
    partMesh(parent, 'servo', [0.0263353, 0, 0.0437], [0, 0, 0], M.servo);

    /* 状态指示灯：嵌在底座前立面，正对默认视角 */
    var led = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 14, 12), ledMat);
    led.position.set(0.0645, -0.035, 0.009);
    parent.add(led);
    return { led: led };
  }

  function buildPan(pan) {
    /* shoulder_link：肩部舵机 + 电机座 + 俯仰拱架 */
    partMesh(pan, 'motorHolderBase', [-0.0675992, -0.000177759, 0.0158499], [Math.PI / 2, -Math.PI / 2, 0], M.body2);
    partMesh(pan, 'rotationPitch', [0.0122008, 0.0000222413, 0.0464], [-Math.PI / 2, 0, 0], M.body);
    partMesh(pan, 'servo', [-0.0303992, 0.000422241, -0.0417], [Math.PI / 2, Math.PI / 2, 0], M.servo);
  }

  function buildUpperArm(lift) {
    /* upper_arm_link：142.1 × 24.5 × 67.3 mm 打印件 + 肘部舵机 */
    partMesh(lift, 'upperArm', [-0.065085, 0.012, 0.0182], [Math.PI, 0, 0], M.body);
    partMesh(lift, 'servo', [-0.11257, -0.0155, 0.0187], [-Math.PI, 0, -Math.PI / 2], M.servo);
  }

  function buildLowerArm(elbow) {
    /* lower_arm_link：小臂打印件 + 腕部电机座 + 腕部舵机 */
    partMesh(elbow, 'underArm', [-0.0648499, -0.032, 0.0182], [Math.PI, 0, 0], M.body);
    partMesh(elbow, 'motorHolderWrist', [-0.0648499, -0.032, 0.018], [-Math.PI, 0, 0], M.body2);
    partMesh(elbow, 'servo', [-0.1224, 0.0052, 0.0187], [-Math.PI, 0, -Math.PI], M.servo);
  }

  function buildWrist(wrist) {
    /* wrist_link：俯仰叉架 + 腕转舵机（官方用 no_horn 版，现有 STL 带舵盘，藏在叉架内） */
    partMesh(wrist, 'wristRollPitch', [0, -0.028, 0.0181], [-Math.PI / 2, -Math.PI / 2, 0], M.body);
    partMesh(wrist, 'servo', [0, -0.0424, 0.0306], [Math.PI / 2, Math.PI / 2, 0], M.servo);
  }

  function buildGripper(roll) {
    /* gripper_link：腕转从动件（含固定夹指）+ 第 6 轴舵机 */
    partMesh(roll, 'wristRollFollower', [0, -0.000218214, 0.000949706], [-Math.PI, 0, 0], M.body);
    partMesh(roll, 'servo', [0.0077, 0.0001, -0.0234], [-Math.PI / 2, 0, 0], M.servo);

    /* 指尖参考系：URDF gripper_frame_joint */
    var tip = new THREE.Object3D();
    tip.position.set(-0.0079, -0.000218121, -0.0981274);
    tip.rotation.y = Math.PI;
    roll.add(tip);
    return tip;
  }

  function buildMovingJaw(jaw) {
    /* 动夹指：绕自身 Z 轴摆动的摇臂 */
    partMesh(jaw, 'movingJaw', [0, 0, 0.0189], [0, 0, 0], M.body2);
  }

  function buildRig() {
    var root = new THREE.Group();
    var urdf = new THREE.Group();
    urdf.rotation.x = -Math.PI / 2;          /* URDF Z-up → 场景 Y-up */
    root.add(urdf);

    var ledMat = new THREE.MeshStandardMaterial({
      color: 0x36e07f, emissive: 0x36e07f, emissiveIntensity: 2.4, roughness: 0.4
    });

    buildBase(urdf, ledMat);

    /* shoulder_pan */
    var pan = jointAt(urdf, [0.0388353, 0, 0.0624], [Math.PI, 0, -Math.PI]);
    buildPan(pan);

    /* shoulder_lift */
    var lift = jointAt(pan, [-0.0303992, -0.0182778, -0.0542], [-Math.PI / 2, -Math.PI / 2, 0]);
    buildUpperArm(lift);

    /* elbow_flex */
    var elbow = jointAt(lift, [-0.11257, -0.028, 0], [0, 0, Math.PI / 2]);
    buildLowerArm(elbow);

    /* wrist_flex */
    var wrist = jointAt(elbow, [-0.1349, 0.0052, 0], [0, 0, -Math.PI / 2]);
    buildWrist(wrist);

    /* wrist_roll */
    var roll = jointAt(wrist, [0, -0.0611, 0.0181], [Math.PI / 2, 0.0486795, Math.PI]);
    var tip = buildGripper(roll);

    /* gripper（动夹指） */
    var jaw = jointAt(roll, [0.0202, 0.0188, -0.0234], [Math.PI / 2, 0, 0]);
    buildMovingJaw(jaw);

    return {
      root: root, urdf: urdf, pan: pan, lift: lift, elbow: elbow,
      wrist: wrist, roll: roll, jaw: jaw, tip: tip, led: ledMat
    };
  }


  /* ---------- 场景 ---------- */
  function initScene() {
    if (!window.THREE || typeof THREE.WebGLRenderer !== 'function') {
      showFallback('三维引擎未加载');
      return;
    }
    var stage = S.stage;
    var canvas = S.canvas;
    M = buildMaterials();

    try {
      S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    } catch (e) {
      showFallback('当前环境无法创建 WebGL 上下文');
      return;
    }

    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.shadowMap.enabled = true;
    S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if ('outputEncoding' in S.renderer) S.renderer.outputEncoding = THREE.sRGBEncoding;
    if ('toneMapping' in S.renderer) {
      S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      S.renderer.toneMappingExposure = 1.0;
    }

    S.scene = new THREE.Scene();
    S.camera = new THREE.PerspectiveCamera(34, 1, 0.01, 20);
    S.camera.position.set(0.68, 0.46, 0.72);

    S.controls = new THREE.OrbitControls(S.camera, canvas);
    S.controls.enableDamping = true;
    S.controls.dampingFactor = 0.075;
    S.controls.enablePan = false;
    S.controls.minDistance = 0.35;
    S.controls.maxDistance = 2.6;
    S.controls.maxPolarAngle = Math.PI * 0.495;
    S.controls.target.set(0.2, 0.17, -0.02);
    S.controls.update();

    S.view0 = { pos: S.camera.position.clone(), target: S.controls.target.clone() };

    /* 灯光 */
    S.scene.add(new THREE.HemisphereLight(0xf1f5ff, 0x14171c, 0.9));

    var key = new THREE.DirectionalLight(0xfff4e6, 2.05);
    key.position.set(0.7, 1.2, 0.55);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.05;
    key.shadow.camera.far = 2.6;
    key.shadow.camera.left = -0.62;
    key.shadow.camera.right = 0.62;
    key.shadow.camera.top = 0.8;
    key.shadow.camera.bottom = -0.12;
    key.shadow.bias = -0.0005;
    key.shadow.radius = 3;
    S.scene.add(key);

    var fill = new THREE.DirectionalLight(0x9db9dd, 0.6);
    fill.position.set(-0.62, 0.45, -0.52);
    S.scene.add(fill);

    var rim = new THREE.DirectionalLight(0xffc68a, 0.95);
    rim.position.set(-0.3, 0.34, 0.7);
    S.scene.add(rim);

    /* 工作台：半径 500 mm，够放整条臂的伸展范围 */
    var mat = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.014, 80), M.mat);
    mat.position.y = -0.007;
    mat.receiveShadow = true;
    S.scene.add(mat);

    ring(S.scene, 0.492, 0.0018, M.accent, 0.0014).material = new THREE.MeshStandardMaterial({
      color: 0xef9f3c, emissive: 0xef9f3c, emissiveIntensity: 0.45, roughness: 0.6
    });
    var r1 = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.0008, 6, 96), M.dark);
    r1.rotation.x = -Math.PI / 2;
    r1.position.y = 0.0014;
    S.scene.add(r1);

    /* 工件：抓取点正下方 */
    var piece = new THREE.Mesh(roundedGeo(0.03, 0.03, 0.03, 0.004), M.piece);
    piece.position.set(PIECE_HOME.x, PIECE_HOME.y, PIECE_HOME.z);
    piece.castShadow = true;
    piece.receiveShadow = true;
    S.scene.add(piece);
    S.piece = piece;
    S.held = false;

    var pad = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.0015, 8, 48), M.accent);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(PIECE_HOME.x, 0.0016, PIECE_HOME.z);
    S.scene.add(pad);

    /* 放置位标记：pan −28° 时 TCP 落点 (221, −97) mm */
    var pad2Mat = new THREE.MeshStandardMaterial({
      color: 0xef9f3c, emissive: 0xef9f3c, emissiveIntensity: 0.5, roughness: 0.7
    });
    var pad2 = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.0012, 8, 48), pad2Mat);
    pad2.rotation.x = -Math.PI / 2;
    pad2.position.set(0.221, 0.0016, -0.097);
    S.scene.add(pad2);

    S.tmp = new THREE.Vector3();
    resizeCanvas();

    /* 官方 STL 数据体积大，按需加载；加载完再建机关 */
    loadParts(function (ok) {
      if (!ok) {
        log('err', '模型数据 parts.js 加载失败');
        showFallback('模型数据加载失败');
        return;
      }
      S.rig = buildRig();
      S.scene.add(S.rig.root);
      applyPose();
      updateTip();
      updateGrab();
      syncUI();
    });
  }

  function showFallback(msg) {
    var el = S.refs.fallback;
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    if (S.canvas) S.canvas.style.display = 'none';
  }

  function resizeCanvas() {
    if (!S.renderer || !S.stage) return;
    var w = S.stage.clientWidth, h = S.stage.clientHeight;
    if (!w || !h) return;
    var size = S.renderer.getSize(new THREE.Vector2());
    if (Math.round(size.x) === w && Math.round(size.y) === h) return;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
  }

  function applyPose() {
    if (!S.rig) return;
    spin(S.rig.pan, S.cur.pan);
    spin(S.rig.lift, S.cur.lift);
    spin(S.rig.elbow, S.cur.elbow);
    spin(S.rig.wrist, S.cur.wrist);
    spin(S.rig.roll, S.cur.roll);
    /* 动夹指绕竖直舵轴摆动；夹着工件时停在工件宽度处，不穿模 */
    var jaw = GRIP_CLOSED + (S.cur.grip / 100) * GRIP_SPAN;
    if (S.held && jaw < GRASP_DEG) jaw = GRASP_DEG;
    spin(S.rig.jaw, jaw);
  }

  /* 夹爪与工件的接触判定：闭合到位且 TCP 靠近工件 → 夹起；张开 → 落到台面 */
  function updateGrab() {
    if (!S.rig || !S.piece) return;
    S.rig.tip.updateWorldMatrix(true, false);
    S.tmp.setFromMatrixPosition(S.rig.tip.matrixWorld);

    if (!S.held) {
      /* 只在夹指收到工件宽度附近时判定，避免一进画面就吸住 */
      if (S.cur.grip < 50 || S.cur.grip > 78) return;
      var dx = S.tmp.x - S.piece.position.x;
      var dy = S.tmp.y - S.piece.position.y;
      var dz = S.tmp.z - S.piece.position.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 0.075) return;
      S.rig.roll.attach(S.piece);
      S.held = true;
      log('sys', '夹爪闭合 · 工件已夹持');
    } else if (S.cur.grip > 80) {
      S.scene.attach(S.piece);
      S.piece.position.y = PIECE_HOME.y;
      S.held = false;
      log('sys', '夹爪张开 · 工件落于工作台');
    }
  }

  function resetPiece() {
    if (!S.piece) return;
    if (S.held) {
      S.scene.attach(S.piece);
      S.held = false;
    }
    S.piece.position.set(PIECE_HOME.x, PIECE_HOME.y, PIECE_HOME.z);
    S.piece.rotation.set(0, 0, 0);
  }

  function updateTip() {
    if (!S.rig || !S.tmp || !S.refs.tipX) return;
    S.rig.tip.updateWorldMatrix(true, false);
    S.tmp.setFromMatrixPosition(S.rig.tip.matrixWorld);
    S.refs.tipX.textContent = Math.round(S.tmp.x * 1000);
    S.refs.tipY.textContent = Math.round(S.tmp.y * 1000);
    S.refs.tipZ.textContent = Math.round(S.tmp.z * 1000);
  }

  /* ---------- 渲染循环 ---------- */
  function frame(ts) {
    S.raf = requestAnimationFrame(frame);
    var dt = S.lastTs ? Math.min(0.06, (ts - S.lastTs) / 1000) : 0.016;
    S.lastTs = ts;

    if (S.rig && !S.estop) {
      var k = 1 - Math.exp(-dt * (4 + S.speed * 1.7));
      var moving = false;
      for (var i = 0; i < JOINTS.length; i++) {
        var key = JOINTS[i].key;
        var d = S.goal[key] - S.cur[key];
        if (Math.abs(d) < 0.04) {
          S.cur[key] = S.goal[key];
        } else {
          S.cur[key] += d * k;
          moving = true;
        }
      }
      if (moving || S.needPose) {
        applyPose();
        updateGrab();
        S.needPose = false;
      }
    }

    /* 窗口没有铺开（还在桌面上 / 已关闭）时不渲染，省 GPU */
    if (!S.stage || !S.stage.clientWidth) return;
    resizeCanvas();
    S.controls.update();
    S.renderer.render(S.scene, S.camera);

    if (ts - S.lastTip > 120) {
      S.lastTip = ts;
      updateTip();
    }
  }

  /* ---------- 关节行 ---------- */
  function buildJointRows() {
    var host = S.refs.joints;
    S.refs.inputs = {};
    S.refs.vals = {};

    JOINTS.forEach(function (j) {
      var row = document.createElement('div');
      row.className = 'arm101-joint';

      var head = document.createElement('div');
      head.className = 'arm101-jrow';
      head.innerHTML = '<span class="arm101-jid">ID ' + pad2(j.id) + '</span>' +
        '<span class="arm101-jname">' + j.label + '<em>' + j.en + '</em></span>' +
        '<b class="arm101-jval"><span></span><i>' + j.unit + '</i></b>';
      row.appendChild(head);

      var input = document.createElement('input');
      input.type = 'range';
      input.className = 'arm101-range';
      input.min = j.min;
      input.max = j.max;
      input.step = 1;
      input.value = HOME_POSE[j.key];
      input.setAttribute('aria-label', j.label);
      row.appendChild(input);

      host.appendChild(row);

      var val = head.querySelector('.arm101-jval span');
      val.textContent = HOME_POSE[j.key];
      S.refs.inputs[j.key] = input;
      S.refs.vals[j.key] = val;

      input.addEventListener('input', function () {
        if (!S.linked || S.estop) return;
        stopDemo(true);
        S.goal[j.key] = +input.value;
        val.textContent = +input.value;
      });

      input.addEventListener('change', function () {
        if (!S.linked || S.estop) return;
        sendJoint(j, +input.value);
      });
    });
  }

  function setPose(pose, send) {
    JOINTS.forEach(function (j) {
      S.goal[j.key] = pose[j.key];
      if (S.refs.inputs[j.key]) {
        S.refs.inputs[j.key].value = pose[j.key];
        S.refs.vals[j.key].textContent = pose[j.key];
      }
    });
    if (send) sendAll();
  }

  function sendJoint(j, value) {
    if (!S.linked || S.estop) return;
    var ticks = ticksFor(j, value);
    S.packets += 1;
    updatePackets();
    log('tx', 'ID ' + pad2(j.id) + ' ← ' + pad4(ticks) + ' · ' + value + j.unit + '   ' + frameWrite(j.id, ticks));
    var lat = 3.1 + Math.random() * 2.9;
    setTimeout(function () {
      if (S.linked && !S.estop) log('rx', 'ID ' + pad2(j.id) + ' ACK · ' + lat.toFixed(1) + ' ms');
    }, 70 + Math.random() * 70);
  }

  function sendAll() {
    if (!S.linked || S.estop) return;
    var list = syncList();
    S.packets += list.length;
    updatePackets();
    var lat = 3.4 + Math.random() * 2.6;
    log('tx', 'SYNC_WRITE 6 servos · ' + list.length * 3 + ' B   ' + frameSync(list));
    setTimeout(function () {
      if (S.linked && !S.estop) log('rx', 'SYNC ACK 6/6 · ' + lat.toFixed(1) + ' ms');
    }, 90 + Math.random() * 60);
  }

  function updatePackets() {
    if (S.refs.pkts) S.refs.pkts.textContent = S.packets;
  }

  /* ---------- 演示序列 ---------- */
  function toggleDemo() {
    if (S.demo) {
      stopDemo(true);
      return;
    }
    if (!S.linked || S.estop) return;
    resetPiece();
    S.demo = true;
    S.demoStep = 0;
    S.refs.demoBtn.textContent = '停止演示';
    log('sys', '演示序列开始 · ' + DEMO.length + ' 步');
    runDemo();
  }

  function demoDelay() {
    return 1250 + (10 - S.speed) * 90;
  }

  function runDemo() {
    if (!S.demo) return;
    if (S.demoStep >= DEMO.length) {
      S.demoTimer = setTimeout(function () {
        stopDemo(true);
        log('sys', '序列完成 · 六轴保持末位姿');
      }, 1400);
      return;
    }
    var step = DEMO[S.demoStep];
    setPose(step.pose);
    log('sys', 'DEMO ' + pad2(S.demoStep + 1) + '/' + pad2(DEMO.length) + ' · ' + step.label);
    sendAll();
    S.demoStep += 1;
    S.demoTimer = setTimeout(runDemo, demoDelay());
  }

  function stopDemo(logIt) {
    if (!S.demo) return;
    S.demo = false;
    clearTimeout(S.demoTimer);
    if (S.refs.demoBtn) S.refs.demoBtn.textContent = '演示序列';
    if (logIt) log('sys', '演示已停止 · 保持当前位姿');
  }

  /* ---------- 电源 / 急停 ---------- */
  function setLinked(on) {
    S.linked = on;
    if (!on) {
      stopDemo(false);
      S.estop = false;
      log('sys', 'SERIAL CLOSED · 舵机失能');
    } else {
      log('sys', 'SERIAL OPEN · /dev/ttyACM0 @ 1000000 8N1');
      log('sys', '舵机 6/6 应答 · 力矩 ON · 已载入中位 2048');
    }
    syncUI();
  }

  function toggleEstop() {
    if (!S.linked) return;
    S.estop = !S.estop;
    if (S.estop) {
      stopDemo(false);
      log('err', 'EMERGENCY STOP · 力矩 OFF · 目标位置冻结');
    } else {
      log('sys', 'TORQUE ON · 驱动器就绪 · 继续跟踪目标');
    }
    syncUI();
  }

  function syncUI() {
    var root = S.refs.root;
    root.dataset.link = S.linked ? 'on' : 'off';
    root.dataset.estop = S.estop ? '1' : '0';

    S.refs.conn.innerHTML = '<i></i><b>' + (S.linked ? '串口已连接 · 1 Mbps' : '串口未连接') + '</b>';
    S.refs.linkBtn.textContent = S.linked ? '断开串口' : '连接串口';
    S.refs.estopBtn.textContent = S.estop ? '解除急停' : '急停';
    S.refs.estopBanner.hidden = !S.estop;
    S.refs.demoBtn.textContent = S.demo ? '停止演示' : '演示序列';

    var lock = !S.linked || S.estop;
    JOINTS.forEach(function (j) {
      if (S.refs.inputs[j.key]) S.refs.inputs[j.key].disabled = lock;
    });
    S.refs.sendBtn.disabled = lock;
    S.refs.homeBtn.disabled = lock;
    S.refs.demoBtn.disabled = lock;
    S.refs.estopBtn.disabled = !S.linked;

    if (S.rig && S.rig.led) {
      var c = S.estop ? 0xff3b30 : S.linked ? 0x36e07f : 0xffa41f;
      S.rig.led.color.setHex(c);
      S.rig.led.emissive.setHex(c);
    }
  }

  function resetView() {
    if (!S.controls || !S.view0) return;
    S.camera.position.copy(S.view0.pos);
    S.controls.target.copy(S.view0.target);
    S.controls.update();
  }

  /* ---------- 挂载 ---------- */
  function mount(body, win) {
    S.body = body;
    S.win = win;

    if (body.dataset.ready === '1') {
      syncUI();
      return;
    }

    S.refs.root = body.querySelector('.arm101-root');
    S.refs.stage = body.querySelector('[data-stage]');
    S.refs.canvas = body.querySelector('[data-canvas]');
    S.refs.conn = body.querySelector('[data-conn]');
    S.refs.joints = body.querySelector('[data-joints]');
    S.refs.log = body.querySelector('[data-log]');
    S.refs.fallback = body.querySelector('[data-fallback]');
    S.refs.tipX = body.querySelector('[data-tip-x]');
    S.refs.tipY = body.querySelector('[data-tip-y]');
    S.refs.tipZ = body.querySelector('[data-tip-z]');
    S.refs.pkts = body.querySelector('[data-pkts]');
    S.refs.linkBtn = body.querySelector('[data-act="link"]');
    S.refs.sendBtn = body.querySelector('[data-act="send"]');
    S.refs.homeBtn = body.querySelector('[data-act="home"]');
    S.refs.demoBtn = body.querySelector('[data-act="demo"]');
    S.refs.estopBtn = body.querySelector('[data-act="estop"]');
    S.refs.estopBanner = body.querySelector('[data-estop]');
    S.refs.speed = body.querySelector('[data-speed]');
    S.refs.speedV = body.querySelector('[data-speed-v]');
    S.stage = S.refs.stage;
    S.canvas = S.refs.canvas;

    S.cur = {}; S.goal = {};
    JOINTS.forEach(function (j) {
      S.cur[j.key] = HOME_POSE[j.key];
      S.goal[j.key] = HOME_POSE[j.key];
    });

    buildJointRows();
    initScene();

    S.refs.linkBtn.addEventListener('click', function () { setLinked(!S.linked); });
    S.refs.estopBtn.addEventListener('click', toggleEstop);
    S.refs.sendBtn.addEventListener('click', sendAll);
    S.refs.demoBtn.addEventListener('click', toggleDemo);
    S.refs.homeBtn.addEventListener('click', function () {
      stopDemo(false);
      resetPiece();
      setPose(HOME_POSE);
      log('sys', 'HOME 位姿');
      sendAll();
    });
    S.refs.speed.addEventListener('input', function () {
      S.speed = +S.refs.speed.value;
      S.refs.speedV.textContent = S.speed;
    });
    body.querySelector('[data-act="view"]').addEventListener('click', resetView);

    body.dataset.ready = '1';
    syncUI();

    log('sys', 'SERIAL OPEN · /dev/ttyACM0 @ 1000000 8N1');
    log('sys', '舵机 6/6 应答 · 力矩 ON · 已载入中位 2048');
    log('sys', '数字孪生就绪 · 拖拽滑杆下发位置指令');

    if (!S.started) {
      S.started = true;
      S.raf = requestAnimationFrame(frame);
    }
  }

  registerApp({
    id: 'arm101',
    name: '101机械臂',
    title: '101 机械臂 · 控制台',
    sub: '六轴桌面臂 · 3D 孪生 · 总线信号仿真',
    order: 18,
    css: ['apps/arm101/app.css'],
    body: window.ARM101_BODY,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4.5 20.5h7"/><path d="M8 20.5v-2.6"/>' +
      '<circle cx="8.2" cy="16.2" r="1.7"/>' +
      '<path d="m9.6 15.1 3.9-4.6"/><circle cx="14.8" cy="9" r="1.7"/>' +
      '<path d="m16.1 7.9 2.4-1.9"/><path d="m18.1 6.4 2.2 2.1"/>' +
      '<path d="m18.7 6.6-1.2 2.8"/></svg>',
    mount: mount
  });
})();
