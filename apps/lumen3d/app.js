/* 流明 3D 数字人 —— 用 LumenAct 的公开参考脸驱动桌面对话角色。
 *
 * 资源：apps/lumen3d/model/ 下三份打包文件（tools/pack-lumen3d.js 生成）
 *   face-meta.js      头像清单、通道表、97 段曲线目录、贴图
 *   face-geometry.js  几何缓冲区（base64，file:// 下 XHR 读不到本地文件）
 *   face-curves.js    表演曲线（0–100 量化成 uint8）
 *
 * 运行链路：对话回复里的（标签）→ 选一段表演曲线 → 写形态键；
 * 朗读复用工作站统一的 ttsBridge / 本地引擎，口型驱动 VRM 的 vrc.v_* 通道，
 * 眨眼、视线与头部微动是本文件补的程序化动画（LumenAct 公开包不含这些）。
 *
 * 授权：参考脸 CC BY-NC 4.0，仅限非商用；曲线 CC BY 4.0 需署名；
 * 代码 MIT；语义 ONNX 没有随包使用（标签直接查表，避免 146MB 模型）。
 */
(function () {
  'use strict';

  var BODY_HTML = window.LUMEN3D_BODY || '';

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3.2a5.6 5.6 0 0 1 5.6 5.6v2.4a5.6 5.6 0 0 1-11.2 0V8.8A5.6 5.6 0 0 1 12 3.2Z"/>' +
    '<path d="M5.2 11.4c0 3.6 3 6.4 6.8 6.4s6.8-2.8 6.8-6.4"/>' +
    '<path d="M9.3 8.4h.01M14.7 8.4h.01"/>' +
    '<path d="M9.9 12.1c.7.5 1.4.8 2.1.8s1.4-.3 2.1-.8"/>' +
    '<path d="M8.4 21c.6-1.9 1.9-3 3.6-3s3 1.1 3.6 3"/></svg>';

  var STORE_KEY = 'hf_lumen3d_state';
  var STORE_VER = 1;
  var PACKS = [
    'apps/lumen3d/model/face-meta.js',
    'apps/lumen3d/model/face-geometry.js',
    'apps/lumen3d/model/face-curves.js'
  ];

  /* 常用口语标签 → 曲线目录里的正式标签 */
  var ALIAS = {
    '开心': '开心欢快', '高兴': '开心欢快', '兴奋': '开心欢快', '愉快': '开心欢快',
    '平静': '自然放松', '中性': '自然放松', '放松': '自然放松',
    '生气': '生气愤怒', '愤怒': '生气愤怒', '不满': '生气愤怒',
    '惊讶': '惊讶震惊', '吃惊': '惊讶震惊', '震惊': '惊讶震惊',
    '难过': '难过流泪', '伤心': '难过流泪', '委屈': '难过流泪',
    '疑惑': '震惊疑惑质问', '质问': '震惊疑惑质问',
    '得意': '骄傲自豪', '骄傲': '骄傲自豪',
    '无聊': '感觉无聊无趣', '厌烦': '厌烦厌恶', '厌恶': '厌烦厌恶',
    '抱歉': '道歉抱歉', '对不起': '道歉抱歉',
    '担心': '担忧担心', '担忧': '担忧担心', '焦虑': '担忧担心',
    '痛苦': '痛苦疼痛', '欣慰': '欣慰宽慰', '坚定': '意志坚定',
    '困': '睡眼朦胧敷衍', '敷衍': '睡眼朦胧敷衍',
    '晕': '头晕目眩', '卖萌': '卖萌和蔼安详',
    '爱心': '爱心眼', '星星': '星星眼', '大眼': '大眼微笑',
    '闭眼微笑': '微笑_闭眼', '尴尬': '尴尬'
  };

  var QUICK = ['微笑', '开心欢快', '害羞', '惊讶震惊', '思考专注', '生气愤怒', '难过流泪', '自然放松'];
  var MOUTH_CHANNELS = ['aa', 'ou', 'ih', 'e', 'th'];

  /* 脸型参数：0–100，50 为原始脸模；shader 里映射到 -1..1。
   * 每 4 个参数压进一个 vec4，顺序必须与 SHAPE_VERT_HEAD 里的下标一致。 */
  var SHAPE_KEY = 'hf_lumen3dShape';
  var SHAPE_PRESET_KEY = 'hf_lumen3dPresets';
  var COIL_KEY = 'hf_lumen3dCoils';
  var XFORM_KEY = 'hf_lumen3dXform';
  var OUTLINE_KEY = 'hf_lumen3dOutline';
  var SHAPE_GROUPS = ['轮廓', '眼睛', '鼻子', '嘴部'];
  /* 滑杆里只保留还能线性调的两组；眼睛 / 嘴部改由脸上的 3D 手柄控制 */
  /* 抽屉里带滑杆的分组。眼睛单独有「区域手柄」（整眼平移 / 旋转 / 缩放），
   * 但整眼变换改不了睫毛翘度、眼球大小这种局部量，所以两组界面都保留：
   * 滑杆管单个部位，区域手柄管整体。 */
  var SLIDER_GROUPS = ['轮廓', '眼睛', '鼻子'];
  var SHAPE_DEFS = [
    { key: 'width', label: '脸宽', group: '轮廓' },
    { key: 'length', label: '脸长', group: '轮廓' },
    { key: 'chin', label: '下巴长度', group: '轮廓' },
    { key: 'jaw', label: '下巴收窄', group: '轮廓' },
    { key: 'cheek', label: '颧骨', group: '轮廓' },
    { key: 'cheekFull', label: '脸颊圆润', group: '轮廓' },
    { key: 'forehead', label: '额头宽', group: '轮廓' },
    { key: 'eyeDist', label: '眼距', group: '眼睛' },
    { key: 'eyeWidth', label: '眼宽', group: '眼睛' },
    { key: 'eyeHeight', label: '眼高', group: '眼睛' },
    { key: 'eyeTilt', label: '眼倾', group: '眼睛' },
    { key: 'noseLength', label: '鼻长', group: '鼻子' },
    { key: 'chinWidth', label: '下巴宽', group: '轮廓' },
    { key: 'mouth', label: '嘴宽', group: '嘴部' },
    { key: 'lipThick', label: '唇厚', group: '嘴部' },
    { key: 'mouthPos', label: '嘴位', group: '嘴部' },
    /* 下面四个是局部量：睫毛长度 / 翘度 / 眼尾 / 睁眼度。
     * 它们都作用在**皮肤**贴图的眼区上（实测 FaceEyes 几何整块被皮肤挡住，
     * 眼睛是画在贴图上的），靠超椭圆掩码定位，见 REGION_FRAMES.eye。 */
    { key: 'lashLength', label: '睫毛长度', group: '眼睛' },
    { key: 'lashCurl', label: '睫毛翘度', group: '眼睛' },
    { key: 'eyeTail', label: '眼尾上扬', group: '眼睛' },
    { key: 'eyeOpen', label: '睁眼度', group: '眼睛' }
  ];

  /* 三维操控点的落点：t 是线性高度（0 下巴 / 1 头顶），u 是相对该高度的半宽。 */
  var ANCHOR_SPECS = {
    width: { t: 0.45, u: 0.95 },
    length: { t: 0.92, u: 0.30 },
    chin: { t: 0.03, u: 0.00 },
    jaw: { t: 0.12, u: 0.72 },
    cheek: { t: 0.58, u: 0.80 },
    cheekFull: { t: 0.50, u: 0.58 },
    forehead: { t: 0.86, u: 0.45 },
    chinWidth: { t: 0.05, u: 0.42 },
    eyeDist: { t: 0.32, u: 0.40 },
    eyeWidth: { t: 0.32, u: 0.58 },
    eyeHeight: { t: 0.30, u: 0.53 },
    eyeTilt: { t: 0.33, u: 0.70 },
    noseLength: { t: 0.22, u: 0.00 },
    mouth: { t: 0.12, u: 0.45 },
    lipThick: { t: 0.12, u: 0.00 },
    mouthPos: { t: 0.15, u: 0.00 }
  };

  /* 眼睛 / 嘴巴已经改由区域 3D 手柄控制，对应的线性参数固定在中性值，
   * 不再出现在滑杆里，避免两套逻辑互相打架。 */
  /* 随机脸型时保持中性的键：五官交给区域手柄 / 专用滑杆单独调，
   * 随机出来容易怪。⚠ 它只管随机，不参与存档合并与滑杆渲染。 */
  var NEUTRAL_KEYS = {
    eyeDist: 1, eyeWidth: 1, eyeHeight: 1, eyeTilt: 1,
    mouth: 1, lipThick: 1, mouthPos: 1
  };

  /* 区域椭圆：[uc, ur, vc, vrUp, vrDn, lo, hi]——shader 里的 l3EyeSkinMask /
   * l3EyePartMask / l3MouthRegionMask 全部由这张表现拼（只有这一处数字），
   * 界面手柄也读它，改半径不会出现「画的和动的不一致」。
   * vrUp / vrDn 分开：睫毛只往上长，上下半径必须能不一样。
   *   eye      皮肤口径（含眼睑）：眼睑跟着眼走，上边界停在眼窝上沿，绝不能碰到眉毛；
   *   eyePart  眼球 / 睫毛口径：睫毛尖比眼球高出一大截，上半径要 0.165 才圈得住，
   *            它只作用在 FaceEyes 材质上（整块都在脸前面），扩到额头也没有副作用；
   *   mouth     嘴部，上下对称。
   * lo / hi 是 smoothstep 的过渡带：eyePart 收窄一点，睫毛才拿得到满权重。 */
  var REGION_FRAMES = {
    eye: { uc: 0.45, ur: 0.355, vc: 0.695, vrUp: 0.092, vrDn: 0.086, lo: 0.50, hi: 1.55, p: 3.4 },
    eyePart: { uc: 0.44, ur: 0.34, vc: 0.688, vrUp: 0.165, vrDn: 0.078, lo: 0.30, hi: 1.30 },
    mouth: { uc: 0.00, ur: 0.32, vc: 0.285, vrUp: 0.105, vrDn: 0.105, lo: 0.22, hi: 1.45 }
  };

  /* 顶点部位标记：0 皮肤 / 1 眼球 / 2 睫毛 / 3 眼角 / 4 口腔。
   * 眼球、六条睫毛、牙齿全挤在同一个 FaceEyes 材质、同一份 position 里，
   * 光按材质名分不出来，只能按连通分量 + 形状特征逐顶点打标。
   * 判据来自实测（别凭感觉改数字）：
   *   眼角那团 289 顶点挤在 0.006 见方里 → span < 0.012
   *   口腔（牙齿 / 舌 / 内壁）整块在眼线以下 → 中心 y < eyeY
   *   眼球是跨眼睛上下的大球（216 顶点）→ 顶点数 ≥ 100
   *   剩下的细带（每条 20 顶点）就是睫毛
   * 分错的后果很直接：拉睫毛会把牙齿一起拽走。 */
  var PART_SKIN = 0, PART_BALL = 1, PART_LASH = 2, PART_CORNER = 3, PART_INNER = 4;

  function tagVertexParts(idx, posData, out, eyeY) {
    if (!idx || !idx.length) return;
    var total = posData.length / 3;
    var parent = new Int32Array(total);
    for (var i = 0; i < total; i++) parent[i] = i;
    function find(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    for (var i = 0; i < idx.length; i += 3) {
      var a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]);
      if (a !== b) parent[b] = a;
      b = find(b); c = find(c);
      if (b !== c) parent[c] = b;
    }
    var groups = Object.create(null);
    for (var i = 0; i < idx.length; i++) {
      var root = find(idx[i]);
      (groups[root] || (groups[root] = [])).push(idx[i]);
    }
    Object.keys(groups).forEach(function (root) {
      var list = groups[root];
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      list.forEach(function (k) {
        var x = posData[k * 3], y = posData[k * 3 + 1], z = posData[k * 3 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      });
      var span = Math.max(x1 - x0, y1 - y0, z1 - z0);
      var tag;
      if (span < 0.012) tag = PART_CORNER;
      else if ((y0 + y1) / 2 < eyeY) tag = PART_INNER;
      else if (list.length >= 100) tag = PART_BALL;
      else tag = PART_LASH;
      list.forEach(function (k) { out[k] = tag; });
    });
  }

  /* 轮廓曲线节点：t 是归一化高度（0 下巴 → 1 头顶），等距 8 个。
   * 只存「宽度倍率」，高度是固定常量——所以 shader 和界面手柄共用这一张表，
   * 不会出现「曲线画在 A 处、变形发生在 B 处」。 */
  var OUTLINE_KNOTS = [0.04, 0.16, 0.28, 0.40, 0.52, 0.64, 0.76, 0.88];
  var OUTLINE_STEP = OUTLINE_KNOTS[1] - OUTLINE_KNOTS[0];
  /* 倍率上下限：1.45 已经是「脸宽变了快一半」，再大眼距和耳朵会明显失真；
   * 0.65 以下脸会细到鼻梁被自己吃进去。shader 端不钳，钳在这里一处
   * （shader 里的 setOutline 也读这张表，别在两处各写一份数字）。 */
  var OUTLINE_LIMIT = [0.65, 1.45];

  /* 把 8 个倍率拼成一条类 Catmull-Rom 的平滑曲线（分段三次 Hermite）。
   * 为什么不写 uniform 数组循环：GLSL ES 1.0 的数组下标必须是常量，
   * 而这段又必须和界面手柄完全同形——所以直接生成定长代码。 */
  function outlineGlsl() {
    var ref = [
      'l3Out[0].x', 'l3Out[0].y', 'l3Out[0].z',
      'l3Out[1].x', 'l3Out[1].y', 'l3Out[1].z',
      'l3Out[2].x', 'l3Out[2].y'
    ];
    var lines = [
      'float l3OutSeg(float t, float a, float h, float p0, float p1, float p2, float p3) {',
      '  float s = clamp((t - a) / h, 0.0, 1.0);',
      '  float s2 = s * s, s3 = s2 * s;',
      '  return 0.5 * (2.0 * p1 + (-p0 + p2) * s +',
      '    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * s2 +',
      '    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * s3);',
      '}',
      'float l3Outline(float t) {',
      '  float k = ' + ref[0] + ';'
    ];
    for (var i = 1; i < OUTLINE_KNOTS.length; i++) {
      var a = OUTLINE_KNOTS[i - 1].toFixed(3);
      /* 两端各补一个镜像邻居，免得端点附近塌陷 */
      var p0 = ref[Math.max(0, i - 2)];
      var p3 = ref[Math.min(ref.length - 1, i + 1)];
      lines.push('  k = mix(k, l3OutSeg(t, ' + a + ', ' + OUTLINE_STEP.toFixed(3) + ', ' +
        p0 + ', ' + ref[i - 1] + ', ' + ref[i] + ', ' + p3 + '), step(' + a + ', t));');
    }
    lines.push('  return k;', '}');
    return lines.join('\n');
  }

  /* 把一张区域表拼成 GLSL 掩码函数。
   * frame.p 是超椭圆幂次：2 = 普通椭圆，> 2 会越接近圆角矩形。
   * 眼睛必须用超椭圆：这颗脸的睫毛 / 眼线是画在皮肤贴图上的，形状是一条又宽又扁的
   * 带子（量出来 u 0.07–0.79、v 0.70–0.78），普通椭圆在带子两头权重直接掉到 0，
   * 拉眼睛时睫毛末端留在原地 —— 用户报的就是这个。 */
  function regionMaskGlsl(name, frame) {
    function num(value) { return Number(value).toFixed(5); }
    var p = Number(frame.p) || 2;
    var body = p === 2
      ? 'du * du + dv * dv'
      : 'pow(abs(du), ' + num(p) + ') + pow(abs(dv), ' + num(p) + ')';
    return [
      'float ' + name + '(float au, float v) {',
      '  float du = (au - ' + num(frame.uc) + ') / ' + num(frame.ur) + ';',
      '  float dv = (v - ' + num(frame.vc) + ') / (v > ' + num(frame.vc) + ' ? ' +
        num(frame.vrUp) + ' : ' + num(frame.vrDn) + ');',
      '  return 1.0 - smoothstep(' + num(frame.lo) + ', ' + num(frame.hi) + ', ' + body + ');',
      '}'
    ].join('\n');
  }

  /* 眼睛 / 嘴巴的区域掩码：vertex（变形）与 fragment（覆层）共用这一份，
   * part = 1 表示当前材质是眼部的几何（眼球 / 睫毛）。
   * 眼区的几个数同时导出成 GLSL 常量：眼睑 / 睫毛那几档位移要拿它算归一化距离，
   * 不能另抄一份数字进去（改了椭圆忘了改掩码 = 画的和动的不一致）。 */
  function frameConsts(prefix, frame) {
    function n(value) { return Number(value).toFixed(5); }
    return [
      'const float ' + prefix + '_UC = ' + n(frame.uc) + ';',
      'const float ' + prefix + '_UR = ' + n(frame.ur) + ';',
      'const float ' + prefix + '_VC = ' + n(frame.vc) + ';',
      'const float ' + prefix + '_VRUP = ' + n(frame.vrUp) + ';',
      'const float ' + prefix + '_VRDN = ' + n(frame.vrDn) + ';'
    ].join('\n');
  }
  var SHAPE_REGION_MATH = [
    frameConsts('L3_EYE', REGION_FRAMES.eye),
    frameConsts('L3_MOUTH', REGION_FRAMES.mouth),
    regionMaskGlsl('l3EyeSkinMask', REGION_FRAMES.eye),
    regionMaskGlsl('l3EyePartMask', REGION_FRAMES.eyePart),
    regionMaskGlsl('l3MouthRegionMask', REGION_FRAMES.mouth),
    'float l3EyeMask(float au, float v, float z, float part) {',
    /* 眼球 / 睫毛整块都在脸的前面（z 从 -0.03 到 0.04），不需要按深度收边；
     * 皮肤那圈必须收，否则后脑的顶点也会被当成眼周一起拽走。 */
    '  if (part > 0.5) return l3EyePartMask(au, v);',
    '  return l3EyeSkinMask(au, v) * smoothstep(0.005, 0.020, z);',
    '}'
  ].join('\n');
  var XFORM_DEFAULT = [0, 0, 0, 1];
  /* 位移必须能被柔边吸收：限制在脸高的几个百分点内，
   * 否则核心区一动，边界没地方让，皮肤直接撕开（穿模）。 */
  var XFORM_LIMIT = {
    eye: { tx: 0.22, ty: 0.065, rot: 0.65, scale: [0.70, 1.60] },
    mouth: { tx: 0.15, ty: 0.055, rot: 0.55, scale: [0.70, 1.70] }
  };

  /* 曲面范围线圈：[uc, ur, vc, vr]，顺序与 SHAPE_DEFS 一致。
   * 它既是脸上的蓝色范围提示，也是 shader 里该参数真正的变形掩码——看到的就是生效的。
   * u 取 |u| 左右对称，所以侧脸参数（颧骨、眼、嘴角）只画右半边，镜像由界面补一条虚线。 */
  var DEFAULT_COILS = {
    width: [0.00, 3.00, 0.42, 0.55],
    length: [0.50, 1.80, 0.55, 0.95],
    chin: [0.00, 3.00, 0.10, 0.34],
    jaw: [0.00, 3.00, 0.08, 0.42],
    cheek: [0.70, 0.46, 0.58, 0.26],
    cheekFull: [0.45, 0.80, 0.50, 0.40],
    forehead: [0.00, 3.00, 0.86, 0.22],
    /* 四档眼形必须盖住整只「画上去的眼睛」：睫毛尖在 v≈0.775，
     * 老线圈（vc 0.66 / vr 0.13）在睫毛尖只剩 ~0.35 权重，拉眼睛时睫毛尾拖不动。 */
    eyeDist: [0.45, 0.40, 0.695, 0.115],
    eyeWidth: [0.47, 0.38, 0.695, 0.115],
    eyeHeight: [0.47, 0.37, 0.695, 0.115],
    eyeTilt: [0.48, 0.38, 0.695, 0.115],
    noseLength: [0.00, 0.50, 0.55, 0.23],
    chinWidth: [0.00, 3.00, 0.06, 0.30],
    mouth: [0.00, 0.72, 0.30, 0.18],
    lipThick: [0.00, 0.55, 0.30, 0.17],
    mouthPos: [0.00, 0.80, 0.30, 0.24],
    /* 以下四个：线圈只用来画锚点，真正的变形由 [2b] 段按皮肤掩码算 */
    lashLength: [0.52, 0.32, 0.74, 0.16],
    lashCurl: [0.52, 0.32, 0.74, 0.16],
    eyeTail: [0.58, 0.22, 0.72, 0.10],
    eyeOpen: [0.50, 0.34, 0.74, 0.14]
  };
  /* 拖动时的安全范围：过大也不会把整张脸拉飞 */
  var COIL_LIMIT = {
    uc: [0, 1.25], ur: [0.05, 3.20], vc: [0, 1], vr: [0.04, 0.90]
  };
  var COIL_INDEX = {};
  SHAPE_DEFS.forEach(function (def, index) { COIL_INDEX[def.key] = index; });

  /* 内置预设：缺失的键取 50（原始脸模） */
  var SHAPE_PRESETS = [
    { name: '原始', values: {} },
    {
      name: 'Q版',
      values: {
        width: 78, length: 30, chin: 30, jaw: 70, cheek: 76, cheekFull: 80, forehead: 74,
        eyeDist: 60, eyeWidth: 78, eyeHeight: 70, eyeTilt: 56, noseLength: 34, chinWidth: 60,
        mouth: 60, lipThick: 60, mouthPos: 48
      }
    },
    {
      name: '幼态',
      values: {
        width: 66, length: 42, chin: 38, jaw: 62, cheek: 66, cheekFull: 72, forehead: 66,
        eyeDist: 54, eyeWidth: 68, eyeHeight: 64, eyeTilt: 54, noseLength: 40, chinWidth: 56,
        mouth: 56, lipThick: 58, mouthPos: 50
      }
    },
    {
      name: '少女',
      values: {
        width: 56, length: 50, chin: 46, jaw: 56, cheek: 54, cheekFull: 56, forehead: 54,
        eyeDist: 52, eyeWidth: 58, eyeHeight: 56, eyeTilt: 54, noseLength: 48, chinWidth: 52,
        mouth: 52, lipThick: 54, mouthPos: 50
      }
    },
    {
      name: '御姐',
      values: {
        width: 46, length: 60, chin: 64, jaw: 38, cheek: 44, cheekFull: 40, forehead: 48,
        eyeDist: 50, eyeWidth: 52, eyeHeight: 54, eyeTilt: 60, noseLength: 58, chinWidth: 46,
        mouth: 54, lipThick: 52, mouthPos: 52
      }
    },
    {
      name: '少年',
      values: {
        width: 52, length: 54, chin: 58, jaw: 46, cheek: 48, cheekFull: 44, forehead: 52,
        eyeDist: 48, eyeWidth: 54, eyeHeight: 52, eyeTilt: 50, noseLength: 54, chinWidth: 50,
        mouth: 52, lipThick: 46, mouthPos: 50
      }
    },
    {
      name: '冷峻',
      values: {
        width: 44, length: 62, chin: 68, jaw: 34, cheek: 40, cheekFull: 34, forehead: 46,
        eyeDist: 44, eyeWidth: 46, eyeHeight: 48, eyeTilt: 64, noseLength: 62, chinWidth: 44,
        mouth: 46, lipThick: 40, mouthPos: 52
      }
    },
    {
      name: '妖异',
      values: {
        width: 52, length: 56, chin: 72, jaw: 36, cheek: 50, cheekFull: 42, forehead: 56,
        eyeDist: 58, eyeWidth: 62, eyeHeight: 58, eyeTilt: 66, noseLength: 56, chinWidth: 44,
        mouth: 58, lipThick: 56, mouthPos: 54
      }
    }
  ];

  /* 贴图编辑结果：短存根进 localStorage，像素本体交给 blob-store */
  var TEX_KEY = 'hf_lumen3d_tex';

  /* 顶点变形：在蒙皮之后、对象空间里用「面部坐标系」计算。
   * 材质是 MeshBasicMaterial，不需要修正法线。
   *
   * 坐标系（与脸宽、脸长无关，所以同一组参数能套到不同比例的二次元脸上）：
   *   t = (y - minY) / H   线性高度，0 下巴、1 头顶
   *   v = l3V(t)           锚点坐标：下巴 0 / 嘴 0.30 / 鼻尖 0.55 / 眼 0.66 / 额 0.90
   *   u = x / halfW(t)     横向坐标，±1 正好落在该高度的脸缘
   * 五官掩码写成 u/v 的线圈（椭圆 + smoothstep），位移幅度按 H、halfW 归一化；
   * 下半张脸的参数在 v > 0.8 的额头区为 0，不会带动上半张脸。
   *
   * l3Shape 下标与 SHAPE_DEFS 顺序一一对应：
   *   [0] 脸宽 / 脸长 / 下巴长度 / 下巴收窄
   *   [1] 颧骨 / 脸颊圆润 / 额头宽 / 眼距
   *   [2] 眼宽 / 眼高 / 眼倾 / 鼻长
   *   [3] 下巴宽 / 嘴宽 / 唇厚 / 嘴位
   *
   * 注意：tools/lumen3d-rig-check.js 里有同一套数学的 JS 镜像，改这里必须同步。 */
  /* 一套解析换算：t → 锚点 v、t → 该高度正面半宽、u/v 椭圆线圈权重。
   * vertex（变形）与 fragment（覆层掩码）必须用同一份，抽成字符串共用，
   * 免得两处数学漂移；tools/lumen3d-rig-check.js 里还有第三份 JS 镜像，改这里要一起改。 */
  var SHAPE_AXIS_MATH = [
    'float l3Seg(float t, float a, float b, float va, float vb) {',
    '  float k = clamp((t - a) / max(b - a, 1e-5), 0.0, 1.0);',
    '  return mix(va, vb, k);',
    '}',
    /* 锚点分段：下巴 0、嘴 0.30、鼻尖 0.55、眼 0.66、眉 0.80、额 0.90、顶 1 */
    'float l3V(float t) {',
    '  float v = l3Seg(t, 0.000, 0.120, 0.00, 0.30);',
    '  v = mix(v, l3Seg(t, 0.120, 0.215, 0.30, 0.55), step(0.120, t));',
    '  v = mix(v, l3Seg(t, 0.215, 0.290, 0.55, 0.66), step(0.215, t));',
    '  v = mix(v, l3Seg(t, 0.290, 0.450, 0.66, 0.80), step(0.290, t));',
    '  v = mix(v, l3Seg(t, 0.450, 0.600, 0.80, 0.90), step(0.450, t));',
    '  v = mix(v, l3Seg(t, 0.600, 0.800, 0.90, 0.97), step(0.600, t));',
    '  v = mix(v, l3Seg(t, 0.800, 1.000, 0.97, 1.00), step(0.800, t));',
    '  return v;',
    '}',
    /* 各高度的正面半宽（离线采样，clamp 到 0.020 防止头顶除零） */
    'float l3HalfW(float t) {',
    '  float w = l3Seg(t, 0.000, 0.040, 0.015, 0.030);',
    '  w = mix(w, l3Seg(t, 0.040, 0.080, 0.030, 0.042), step(0.040, t));',
    '  w = mix(w, l3Seg(t, 0.080, 0.120, 0.042, 0.050), step(0.080, t));',
    '  w = mix(w, l3Seg(t, 0.120, 0.160, 0.050, 0.056), step(0.120, t));',
    '  w = mix(w, l3Seg(t, 0.160, 0.200, 0.056, 0.070), step(0.160, t));',
    '  w = mix(w, l3Seg(t, 0.200, 0.250, 0.070, 0.074), step(0.200, t));',
    '  w = mix(w, l3Seg(t, 0.250, 0.290, 0.074, 0.080), step(0.250, t));',
    '  w = mix(w, l3Seg(t, 0.290, 0.350, 0.080, 0.081), step(0.290, t));',
    '  w = mix(w, l3Seg(t, 0.350, 0.450, 0.081, 0.072), step(0.350, t));',
    '  w = mix(w, l3Seg(t, 0.450, 0.600, 0.072, 0.077), step(0.450, t));',
    '  w = mix(w, l3Seg(t, 0.600, 0.750, 0.077, 0.061), step(0.600, t));',
    '  w = mix(w, l3Seg(t, 0.750, 0.900, 0.061, 0.058), step(0.750, t));',
    '  w = mix(w, l3Seg(t, 0.900, 1.000, 0.058, 0.050), step(0.900, t));',
    '  return w;',
    '}',
    'float l3Coil(float u, float v, float uc, float ur, float vc, float vr) {',
    '  float du = (u - uc) / max(ur, 1e-4);',
    '  float dv = (v - vc) / max(vr, 1e-4);',
    '  return 1.0 - smoothstep(0.15, 1.10, du * du + dv * dv);',
    '}'
  ].join('\n');

  var SHAPE_VERT_HEAD = [
    'uniform vec4 l3Shape[5];',
    /* 20 个参数各自的曲面范围线圈，顺序同 SHAPE_DEFS；下标全部写成常量 */
    'uniform vec4 l3CoilU[20];',
    'uniform vec3 l3Bounds;',
    /* 顶点部位标记（0 皮肤 / 1 眼球 / 2 睫毛 / 3 眼角 / 4 口腔）建几何时照样打，
     * 但变形已经不用它了：FaceEyes 那块几何整块被皮肤挡住（染色实测全隐），
     * 屏幕上看到的是贴图。它现在只服务 partStats / partBounds 这类自检与量测。
     * 真要按部位分别动几何，前提是换一颗眼睛是真 3D 的模型。 */
    /* 当前操控点的线圈（uc, ur, vc, vr）；fragment 的覆层掩码也读它 */
    'uniform vec4 l3Hi;',
    /* 眼睛 / 嘴巴的 3D 变换：(平移 u、平移 t、绕 z 旋转、缩放) */
    'uniform vec4 l3EyeX;',
    'uniform vec4 l3MouthX;',
    /* 体积核：把「口腔 / 眼窝」这些二维椭圆盖不到的地方也纳入同一段变换 */
    'uniform vec3 l3EyeC;',
    'uniform vec3 l3EyeR;',
    'uniform vec3 l3MouthC;',
    'uniform vec3 l3MouthR;',
    /* 当前材质是不是眼部的几何（眼球 / 睫毛）：1 = 是，0 = 皮肤 */
    'uniform float l3EyePart;',
    /* 轮廓曲线（直接拖脸缘）：8 个节点各一个宽度倍率，1 = 原始轮廓。
     * 节点高度是固定常量（OUTLINE_KNOTS），只传倍率 —— 曲线形状由 JS 那端生成，
     * 界面手柄和 shader 用的是同一张表，不会出现「画的和动的不一样」。 */
    'uniform vec3 l3Out[3];',
    'varying vec3 vL3Rest;',
    'float l3Core(vec3 rest, vec3 c, vec3 r) {',
    '  vec3 d = (rest - c) / max(r, vec3(1e-4));',
    '  return 1.0 - smoothstep(0.52, 1.00, length(d));',
    '}',
    SHAPE_AXIS_MATH,
    /* 眼 / 嘴的固定区域：数字来自 REGION_FRAMES，与界面手柄同源 */
    SHAPE_REGION_MATH,
    /* 线圈取用：调用点一律写常量下标，避免 GLSL ES 1.0 的动态下标限制 */
    'float l3C(vec4 c, float u, float v) {',
    '  return l3Coil(u, v, c.x, c.y, c.z, c.w);',
    '}',
    outlineGlsl(),
    /* 顶点变形：蒙皮之后的实际位移（覆层掩码在 fragment 里另算） */
    'vec3 l3Deform(vec3 p, vec3 rest) {',
    '  float t = clamp((rest.y - l3Bounds.x) * l3Bounds.z, 0.0, 1.0);',
    '  float H = 1.0 / max(l3Bounds.z, 1e-6);',
    '  float hScale = H / 0.202114;',
    '  float v = l3V(t);',
    '  float w = max(l3HalfW(t), 0.020) * hScale;',
    '  float u = rest.x / w;',
    '  float au = abs(u);',
    '  float eyeY = l3Bounds.x + 0.299 * H;',
    '  float mouthY = l3Bounds.x + 0.112 * H;',
    /* ---- 掩码全部来自可编辑线圈 ---- */
    '  float mWidth = l3C(l3CoilU[0], au, v);',
    '  float mLength = l3C(l3CoilU[1], au, v);',
    '  float mChin = l3C(l3CoilU[2], au, v);',
    '  float mJaw = l3C(l3CoilU[3], au, v);',
    '  float mCheek = l3C(l3CoilU[4], au, v);',
    '  float mCheekFull = l3C(l3CoilU[5], au, v);',
    '  float mForehead = l3C(l3CoilU[6], au, v);',
    /* 轮廓曲线：直接拖脸缘改宽度。
     * ⚠ 用「加位移」而不是「乘 x」。这颗头的耳朵和脸是同一块网格，p.x *= k 会把
     * 耳尖一起乘出去 —— 实测拉到 1.45 时耳朵变成两片尖翅膀（连形变方向都变了）。
     * 改成每个顶点横向平移 (k-1)×该高度的半宽：脸缘正好落在 k×半宽（和手柄的位置
     * 口径完全一致），耳朵只是整体跟着平移、形状不变，也不会被拉长。 */
    '  float outlineDx = (l3Outline(t) - 1.0) * w;',
    /* ⚠ 眼部参数一律走皮肤线圈 / 皮肤椭圆，不要再用 aPart 去分别处理眼球、睫毛：
     * 实测（把 FaceEyes 材质染成纯红、皮肤染绿各拍一张）FaceEyes 那块几何
     * 完全被皮肤挡住，屏幕上看到的眼睛、睫毛、眼线全是**画在皮肤贴图上**的。
     * 所以能看见的只能是皮肤的位移——早先按 aPart 分开动的写法改了等于没改。 */
    '  float mEyeDist = l3C(l3CoilU[7], au, v);',
    '  float mEyeWidth = l3C(l3CoilU[8], au, v);',
    '  float mEyeHeight = l3C(l3CoilU[9], au, v);',
    '  float mEyeTilt = l3C(l3CoilU[10], au, v);',
    '  float mNose = l3C(l3CoilU[11], au, v) * smoothstep(0.045, 0.065, rest.z);',
    '  float mChinWidth = l3C(l3CoilU[12], au, v);',
    '  float mMouth = l3C(l3CoilU[13], au, v);',
    '  float mLip = l3C(l3CoilU[14], au, v);',
    '  float mMouthPos = l3C(l3CoilU[15], au, v);',
    /* [0] 轮廓：脸长以眼线为轴拉伸，下巴长度以嘴线为轴拉伸，眼睛本身不动 */
    '  p.y = eyeY + (p.y - eyeY) * (1.0 + l3Shape[0].y * 0.13 * mLength);',
    '  p.y = mouthY + (p.y - mouthY) * (1.0 + l3Shape[0].z * 0.35 * mChin);',
    '  float wx = 1.0 + l3Shape[0].x * 0.24 * mWidth;',
    '  wx *= 1.0 - l3Shape[0].w * 0.18 * mJaw;',
    /* [1] 面中：颧骨 / 脸颊圆润 / 额头宽 / 眼距 */
    '  wx *= 1.0 + l3Shape[1].x * 0.11 * mCheek;',
    '  wx *= 1.0 + l3Shape[1].y * 0.09 * mCheekFull;',
    '  wx *= 1.0 + l3Shape[1].z * 0.16 * mForehead;',
    '  p.x *= wx;',
    '  p.x += sign(rest.x) * outlineDx;',
    '  p.x += sign(rest.x) * l3Shape[1].w * 0.05 * w * mEyeDist;',
    /* [2] 眼鼻：眼宽/眼高绕单个眼心缩放，眼倾按内外眼角错位 */
    '  float eyeX = 0.50 * w;',
    '  float side = sign(rest.x);',
    '  p.x = side * eyeX + (p.x - side * eyeX) * (1.0 + l3Shape[2].x * 0.20 * mEyeWidth);',
    '  p.y = eyeY + (p.y - eyeY) * (1.0 + l3Shape[2].y * 0.16 * mEyeHeight);',
    '  p.y += clamp((au - 0.50) * 5.0, -1.0, 1.0) * l3Shape[2].z * 0.0035 * hScale * mEyeTilt;',
    '  p.y -= l3Shape[2].w * 0.0035 * hScale * mNose;',
    /* [2b] 眼睑 / 睫毛：眼睛、睫毛、眼线全是画在皮肤贴图上的（见上面那段实测说明），
     * 所以这四档只能动皮肤。掩码全部由眼区椭圆派生：
     *   lashBand  椭圆上缘那一带 —— 睫毛根部在眼睑上沿，尖再往外上方挑
     *   lidBand   椭圆中上段 —— 上眼睑，管「睁眼度」
     *   tailBand  外眼角那一侧 —— 管「眼尾上扬」
     * 早先按 aPart 分部位（眼球 / 睫毛几何顶点）的做法完全无效，别再回去。 */
    '  float duE = (au - L3_EYE_UC) / L3_EYE_UR;',
    '  float dvE = (v - L3_EYE_VC) / (v > L3_EYE_VC ? L3_EYE_VRUP : L3_EYE_VRDN);',
    '  float lashBand = l3EyeSkinMask(au, v) * smoothstep(0.02, 0.86, dvE);',
    '  float lidBand = l3EyeSkinMask(au, v) * smoothstep(-0.40, 0.40, dvE) *',
    '    (1.0 - smoothstep(0.45, 0.85, dvE));',
    '  float tailBand = l3EyeSkinMask(au, v) * smoothstep(0.15, 0.85, duE);',
    /* 睫毛长度：沿「根 → 尖」方向（外上方）推开，根部几乎不动，否则睫毛会脱开眼皮 */
    '  p.x += side * l3Shape[4].x * 0.010 * hScale * lashBand * smoothstep(0.05, 0.55, dvE);',
    '  p.y += l3Shape[4].x * 0.0045 * hScale * lashBand;',
    /* 睫毛翘度：越靠睫毛尖抬得越多，顺带一点点朝镜头（+z）。
     * ⚠ +z 别给大：额头是往后收的曲面，把眼前这一片推得太靠前，
     *   正面看会把画在额头上的眉毛整条遮掉（实测 0.008 就能让眉毛消失）。 */
    '  float lashTip = lashBand * smoothstep(0.25, 0.95, dvE);',
    '  p.y += l3Shape[4].y * 0.004 * hScale * lashTip;',
    '  p.x += side * l3Shape[4].y * 0.003 * hScale * lashTip;',
    '  p.z += l3Shape[4].y * 0.002 * hScale * lashBand;',
    /* 眼尾上扬：外眼角那一侧抬起来，眼神更「挑」 */
    '  p.y += l3Shape[4].z * 0.007 * hScale * tailBand;',
    /* 睁眼度：滑块 100 = 睁得更大，对应上眼睑往上抬（+y）、0 = 眯眼往下压。
     * ⚠ 方向极容易写反，别再改成 p.y -= 上眼睑那一段。 */
    '  p.y += l3Shape[4].w * 0.007 * hScale * lidBand;',
    /* [3] 下巴与嘴 */
    '  p.x *= 1.0 + l3Shape[3].x * 0.18 * mChinWidth;',
    '  p.x *= 1.0 + l3Shape[3].y * 0.30 * mMouth;',
    '  p.y = mouthY + (p.y - mouthY) * (1.0 + l3Shape[3].z * 0.34 * mLip);',
    '  p.y += l3Shape[3].w * 0.0035 * hScale * mMouthPos;',
    /* 眼 / 嘴的区域变换：皮肤只作用在正脸（rest.z > 0），背面顶点不会被拽走；
     * 眼球 / 睫毛整块都在脸前面，掩码内部不再按深度收边。 */
    /* 口腔（牙齿、舌头、内壁）藏在唇后 z≈0.009–0.037，比唇面深得多；
     * 门槛必须比眼睛更早打开，否则唇动了口腔不动，一移动就穿模。 */
    '  float mouthFront = smoothstep(-0.010, 0.006, rest.z);',
    /* 眼睛：绝对值坐标求核，左右共用一份椭球；l3EyePart 决定用皮肤口径还是睫毛口径 */
    '  vec3 eyeRest = vec3(abs(rest.x), rest.y, rest.z);',
    '  float eyeM = max(l3EyeMask(au, v, rest.z, l3EyePart), l3Core(eyeRest, l3EyeC, l3EyeR));',
    '  vec2 ec = vec2(side * 0.61 * w, eyeY);',
    '  float ea = l3EyeX.z * side;',
    '  vec2 ep = (vec2(p.x, p.y) - ec) * l3EyeX.w;',
    '  float ecs = cos(ea), esn = sin(ea);',
    '  vec2 et = ec + vec2(ep.x * ecs - ep.y * esn, ep.x * esn + ep.y * ecs) + ',
    '    vec2(side * l3EyeX.x * w, l3EyeX.y * H);',
    '  p.x = mix(p.x, et.x, eyeM);',
    '  p.y = mix(p.y, et.y, eyeM);',
    /* 椭圆管正脸的柔和过渡，体积核管唇后的口腔；取并集，牙齿舌头跟着嘴一起走 */
    '  float mouthM = max(l3MouthRegionMask(au, v) * mouthFront, l3Core(rest, l3MouthC, l3MouthR));',
    '  vec2 mc = vec2(0.0, mouthY);',
    '  vec2 mp = (vec2(p.x, p.y) - mc) * l3MouthX.w;',
    '  float mcs = cos(l3MouthX.z), msn = sin(l3MouthX.z);',
    '  vec2 mt = mc + vec2(mp.x * mcs - mp.y * msn, mp.x * msn + mp.y * mcs) + ',
    '    vec2(l3MouthX.x * w, l3MouthX.y * H);',
    '  p.x = mix(p.x, mt.x, mouthM);',
    '  p.y = mix(p.y, mt.y, mouthM);',
    '  return p;',
    '}',
    ''
  ].join('\n');

  /* ---- 选区覆层：直接在模型自己的材质里逐片元着色 ----
   * 早先的叠一张索引网格来点亮三角面，看着是碎的（面片边界 + 阶梯状锯齿）；
   * 现在把掩码搬到 fragment：拿 rest 坐标现算 (au, v)，按同一套公式取权重，
   * 再叠一层色。等于在模型自身的贴图上刷一层覆层——连续、无接缝，
   * 边界是该掩码的等值线，不会跟着网格密度走。 */
  var SHAPE_SEL_FRAG = [
    'uniform vec3 l3Bounds;',
    'uniform vec4 l3Hi;',
    'uniform vec3 l3SelColor;',
    'uniform float l3SelA;',
    'uniform float l3SelKind;',
    /* 与 vertex 同一份材质标记：眼部的几何（眼球 / 睫毛）用睫毛口径的椭圆 */
    'uniform float l3EyePart;',
    'varying vec3 vL3Rest;',
    SHAPE_AXIS_MATH,
    SHAPE_REGION_MATH,
    'float l3SelMask(vec3 rest) {',
    '  float t = clamp((rest.y - l3Bounds.x) * l3Bounds.z, 0.0, 1.0);',
    '  float H = 1.0 / max(l3Bounds.z, 1e-6);',
    '  float w = max(l3HalfW(t), 0.020) * (H / 0.202114);',
    '  float au = abs(rest.x / w);',
    '  float v = l3V(t);',
    /* 0 线圈 / 1 眼睛 / 2 嘴巴 / 3 鼻梁（线圈再乘 z 门槛，只带动鼻凸） */
    '  if (l3SelKind < 0.5) return l3Coil(au, v, l3Hi.x, l3Hi.y, l3Hi.z, l3Hi.w);',
    /* 亮度必须与变形同源：掩码怎么算，覆层就怎么亮 */
    '  if (l3SelKind < 1.5) return l3EyeMask(au, v, rest.z, l3EyePart);',
    '  if (l3SelKind < 2.5) {',
    '    return l3MouthRegionMask(au, v) * smoothstep(-0.010, 0.006, rest.z);',
    '  }',
    '  return l3Coil(au, v, l3Hi.x, l3Hi.y, l3Hi.z, l3Hi.w) * smoothstep(0.045, 0.065, rest.z);',
    '}'
  ].join('\n');

  var S = null;

  /* ---------- 小工具 ---------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  var scriptCache = window.__LUMEN3D_SCRIPTS || (window.__LUMEN3D_SCRIPTS = {});
  function injectScript(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(el);
    });
    return scriptCache[src];
  }

  /* 去掉台词里的（标签），只保留给人看 / 交给 TTS 的内容 */
  function stripTags(text) {
    return String(text || '')
      .replace(/[（(][^（）()\n]{1,24}[）)]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function firstTag(text) {
    var m = /[（(]\s*([^（）()\n]{1,24})\s*[）)]/.exec(String(text || ''));
    return m ? m[1].replace(/\s+/g, '') : '';
  }

  /* ---------- 3D 参考脸 ---------- */
  function createCameraGaze(THREE, eyes, camera) {
    var states = eyes.map(function (node) { return { node: node, rest: node.quaternion.clone() }; });
    var frame = states[0] ? states[0].node.parent : null;
    if (!frame) return function () {};
    var neutral = states[0].rest.clone();
    var inverseNeutral = neutral.clone().invert();
    var filtered = new THREE.Quaternion();
    var midpoint = new THREE.Vector3(), eyePosition = new THREE.Vector3();
    var cameraPosition = new THREE.Vector3(), localTarget = new THREE.Vector3();
    var turn = new THREE.Quaternion(), goal = new THREE.Quaternion();
    var euler = new THREE.Euler(0, 0, 0, 'YXZ');
    var yawLimit = THREE.MathUtils.degToRad(8);
    var pitchLimit = THREE.MathUtils.degToRad(10);
    return function (dt) {
      var alpha = 1 - Math.exp(-14 * Math.max(0, Number(dt) || 0));
      states.forEach(function (st) { st.node.quaternion.copy(st.rest); });
      frame.updateWorldMatrix(true, true);
      midpoint.set(0, 0, 0);
      states.forEach(function (st) {
        st.node.getWorldPosition(eyePosition);
        midpoint.add(frame.worldToLocal(eyePosition));
      });
      midpoint.multiplyScalar(1 / states.length);
      camera.getWorldPosition(cameraPosition);
      frame.worldToLocal(localTarget.copy(cameraPosition));
      localTarget.sub(midpoint).applyQuaternion(inverseNeutral);
      var yaw = 0, pitch = 0;
      if (localTarget.z > 0.0001) {
        yaw = clamp(Math.atan2(localTarget.x, localTarget.z), -yawLimit, yawLimit);
        pitch = clamp(-Math.atan2(localTarget.y, Math.hypot(localTarget.x, localTarget.z)), -pitchLimit, pitchLimit);
        var radius = Math.hypot(yaw / yawLimit, pitch / pitchLimit);
        if (radius > 1) { yaw /= radius; pitch /= radius; }
      }
      goal.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));
      filtered.slerp(goal, alpha).normalize();
      turn.copy(neutral).multiply(filtered).multiply(inverseNeutral);
      states.forEach(function (st) { st.node.quaternion.copy(turn).multiply(st.rest); });
    };
  }

  function createFaceView(host, initialTexture) {
    var THREE = window.THREE;
    if (!THREE) return Promise.reject(new Error('three.js 未加载'));
    var meta = window.LUMEN3D_META;
    var geometryData = window.LUMEN3D_GEOMETRY;
    if (!meta || !geometryData) return Promise.reject(new Error('脸模数据包缺失'));
    if (meta.avatar.schema !== 'lumen.web.avatar.v1') return Promise.reject(new Error('脸模清单格式不支持'));

    var buffer = b64ToBuffer(geometryData);
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    if ('outputEncoding' in renderer && THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-label', '流明三维参考脸');
    host.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    var model = new THREE.Group();
    model.scale.z = -1;
    scene.add(model);

    var bones = meta.avatar.nodes.map(function (item) {
      var bone = new THREE.Bone();
      bone.name = item.name;
      bone.position.fromArray(item.position);
      bone.quaternion.fromArray(item.rotation);
      bone.scale.fromArray(item.scale);
      return bone;
    });
    meta.avatar.nodes.forEach(function (item, index) {
      (item.parent >= 0 ? bones[item.parent] : model).add(bones[index]);
    });

    function values(desc) {
      var Type = desc.type === 'uint32' ? Uint32Array : Float32Array;
      if (desc.offset < 0 || desc.count < 0 || desc.offset + desc.count * 4 > buffer.byteLength) {
        throw new Error('几何属性超出缓冲区');
      }
      return new Type(buffer, desc.offset, desc.count);
    }

    function attribute(desc, integer) {
      var data = values(desc);
      return new THREE.BufferAttribute(integer ? Uint16Array.from(data) : data, desc.itemSize);
    }

    var textures = [];
    var materials = [];
    /* 材质名 → l3EyePart（1 = 眼球 / 睫毛，0 = 皮肤），探针读它守住接线 */
    var materialParts = [];
    /* 各部位顶点数（0 皮肤 / 1 眼球 / 2 睫毛 / 3 眼角 / 4 口腔），探针读它 */
    var partCounts = null;
    /* 各部位包围盒（原始模型单位），给睫毛位移系数定标 */
    var partBoxes = null;
    var geometries = [];
    var driven = [];
    var morphMap = Object.create(null);
    var camera = new THREE.PerspectiveCamera(35, 1, 0.005, 50);
    var initialDistance = 3;
    var focus = new THREE.Vector3();
    var yaw = 0, pitch = 0, distance = 3;
    var pointer = null;
    var resizeObserver = null;
    var canvas = renderer.domElement;

    /* 变形器 uniform：20 个参数压进 5 个 vec4，顺序与 SHAPE_DEFS 一致 */
    var shapeUniforms = {
      values: {
        value: [
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0)
        ]
      },
      /* 20 组曲面范围线圈，顺序同 SHAPE_DEFS */
      coils: {
        value: SHAPE_DEFS.map(function (def) {
          var c = DEFAULT_COILS[def.key];
          return new THREE.Vector4(c[0], c[1], c[2], c[3]);
        })
      },
      bounds: { value: new THREE.Vector3(0, 1, 1) },
      /* 覆层：l3Hi 是当前操控点的线圈，highlightMix 是掩码分类（0 线圈 / 1 眼 / 2 嘴 / 3 鼻） */
      highlight: { value: new THREE.Vector4(0.5, 0.5, 0.5, 0.2) },
      highlightMix: { value: 0 },
      /* 覆层颜色与不透明度（呼吸时只动 selA，不动掩码） */
      selColor: { value: new THREE.Color(0.62, 0.78, 1.0) },
      selA: { value: 0 },
      eyeX: { value: new THREE.Vector4(0, 0, 0, 1) },
      mouthX: { value: new THREE.Vector4(0, 0, 0, 1) },
      /* 轮廓曲线：8 个宽度倍率（1 = 原始轮廓），默认全 1 */
      outline: { value: [new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 0)] },
      /* 五官的「体积核」：中心点 + 三轴半径（局部坐标）。
       * (u,v) 椭圆只是贴着正脸的二维投影，口腔、眼窝这些藏在后面的体积要靠它兜住，
       * 否则嘴动口腔不动，一拖就穿模。 */
      eyeC: { value: new THREE.Vector3(0.42, 0, 0) },
      eyeR: { value: new THREE.Vector3(0.03, 0.02, 0.03) },
      mouthC: { value: new THREE.Vector3(0, 0, 0) },
      mouthR: { value: new THREE.Vector3(0.03, 0.02, 0.04) }
    };
    var shapeValues = {};
    SHAPE_DEFS.forEach(function (def) { shapeValues[def.key] = 50; });
    var restMinY = Infinity, restMaxY = -Infinity;
    var currentTextureURL = meta.texture;
    var currentTextureImage = null;

    function shapeNorm(value) {
      return (clamp(Number(value), 0, 100) - 50) / 50;
    }

    function applyShapeUniforms() {
      SHAPE_DEFS.forEach(function (def, index) {
        var vec = shapeUniforms.values.value[index >> 2];
        var slot = index & 3;
        var value = shapeNorm(shapeValues[def.key]);
        if (slot === 0) vec.x = value;
        else if (slot === 1) vec.y = value;
        else if (slot === 2) vec.z = value;
        else vec.w = value;
      });
    }

    function setShapeValue(name, value) {
      if (!(name in shapeValues)) return null;
      shapeValues[name] = clamp(Number(value), 0, 100);
      applyShapeUniforms();
      return shapeValues[name];
    }

    function setShapeAll(values) {
      var data = values || {};
      SHAPE_DEFS.forEach(function (def) {
        if (Number.isFinite(Number(data[def.key]))) shapeValues[def.key] = clamp(Number(data[def.key]), 0, 100);
      });
      applyShapeUniforms();
    }

    /* 把一组按键线圈写进 uniform；缺项保持当前值 */
    function setCoilUniforms(coils) {
      var data = coils || {};
      SHAPE_DEFS.forEach(function (def, index) {
        var list = data[def.key];
        if (!Array.isArray(list) || list.length < 4) return;
        shapeUniforms.coils.value[index].set(
          clamp(Number(list[0]) || 0, COIL_LIMIT.uc[0], COIL_LIMIT.uc[1]),
          clamp(Number(list[1]) || 0, COIL_LIMIT.ur[0], COIL_LIMIT.ur[1]),
          clamp(Number(list[2]) || 0, COIL_LIMIT.vc[0], COIL_LIMIT.vc[1]),
          clamp(Number(list[3]) || 0, COIL_LIMIT.vr[0], COIL_LIMIT.vr[1])
        );
      });
    }

    function useTexture(texture, url) {
      var olds = [];
      materials.forEach(function (material) {
        if (!material.map) return;
        if (olds.indexOf(material.map) < 0) olds.push(material.map);
        material.map = texture;
        material.needsUpdate = true;
      });
      olds.forEach(function (old) { if (old !== texture) old.dispose(); });
      textures = textures.filter(function (item) { return olds.indexOf(item) < 0; });
      textures.push(texture);
      currentTextureURL = url || currentTextureURL;
      currentTextureImage = texture.image;
    }

    function loadTextureURL(url) {
      return new THREE.TextureLoader().loadAsync(url).then(function (texture) {
        if (THREE.sRGBEncoding) texture.encoding = THREE.sRGBEncoding;
        if (texture.anisotropy !== undefined && renderer.capabilities.getMaxAnisotropy) {
          texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        }
        useTexture(texture, url);
        return texture;
      });
    }

    function applyCanvasTexture(source) {
      var texture = new THREE.CanvasTexture(source);
      if (THREE.sRGBEncoding) texture.encoding = THREE.sRGBEncoding;
      texture.needsUpdate = true;
      useTexture(texture, currentTextureURL);
      return texture;
    }

    function updateCamera() {
      camera.position.set(
        focus.x + Math.sin(yaw) * Math.cos(pitch) * distance,
        focus.y + Math.sin(pitch) * distance,
        focus.z - Math.cos(yaw) * Math.cos(pitch) * distance
      );
      camera.lookAt(focus);
    }

    function resize() {
      var width = host.clientWidth, height = host.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    }

    function setShapes(shapes) {
      var data = shapes || {};
      driven.forEach(function (entry) {
        entry.morphs.forEach(function (morph, index) {
          var value = data[morph.name];
          entry.mesh.morphTargetInfluences[index] = Number.isFinite(value)
            ? clamp(value / 100, 0, 1)
            : clamp(Number(morph.weight) || 0, 0, 1);
        });
      });
    }

    return Promise.resolve()
      .then(function () { return new THREE.TextureLoader().loadAsync(initialTexture || meta.texture); })
      .then(function (texture) {
        if (THREE.sRGBEncoding) texture.encoding = THREE.sRGBEncoding;
        textures.push(texture);
        currentTextureURL = initialTexture || meta.texture;
        currentTextureImage = texture.image;

        meta.avatar.materials.forEach(function (item) {
          var color = item.color || [1, 1, 1, 1];
          var material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color[0], color[1], color[2]),
            map: textures[item.texture] || null,
            transparent: !!item.transparent,
            opacity: color[3] === undefined ? 1 : color[3],
            alphaTest: Number(item.alphaTest) || 0,
            depthWrite: !item.transparent,
            side: THREE.DoubleSide
          });
          if (material.map) {
            material.map.offset.fromArray(item.offset || [0, 0]);
            material.map.repeat.fromArray(item.repeat || [1, 1]);
          }
          /* 眼部几何（眼球 / 睫毛）自成一块材质：它比皮肤高出一截，
           * 掩码要用另一档更大的椭圆，否则改眼睛时睫毛留在原地。 */
          var eyePartUniform = { value: /^FaceEyes$/i.test(item.name || '') ? 1 : 0 };
          materialParts.push({ name: item.name || '', part: eyePartUniform.value });
          material.onBeforeCompile = function (shader) {
            shader.uniforms.l3Shape = shapeUniforms.values;
            shader.uniforms.l3CoilU = shapeUniforms.coils;
            shader.uniforms.l3Bounds = shapeUniforms.bounds;
            shader.uniforms.l3Hi = shapeUniforms.highlight;
            shader.uniforms.l3SelKind = shapeUniforms.highlightMix;
            shader.uniforms.l3SelColor = shapeUniforms.selColor;
            shader.uniforms.l3SelA = shapeUniforms.selA;
            shader.uniforms.l3EyeX = shapeUniforms.eyeX;
            shader.uniforms.l3MouthX = shapeUniforms.mouthX;
            shader.uniforms.l3Out = shapeUniforms.outline;
            shader.uniforms.l3EyeC = shapeUniforms.eyeC;
            shader.uniforms.l3EyeR = shapeUniforms.eyeR;
            shader.uniforms.l3MouthC = shapeUniforms.mouthC;
            shader.uniforms.l3MouthR = shapeUniforms.mouthR;
            shader.uniforms.l3EyePart = eyePartUniform;
            shader.vertexShader = SHAPE_VERT_HEAD + shader.vertexShader;
            shader.vertexShader = shader.vertexShader
              .replace('#include <begin_vertex>',
                '#include <begin_vertex>\n  vec3 l3Rest = position;\n  vL3Rest = l3Rest;')
              .replace('#include <skinning_vertex>',
                '#include <skinning_vertex>\n  transformed = l3Deform( transformed, l3Rest );');
            /* 覆层画在模型自己的材质里：逐片元按 rest 坐标算掩码，
             * 拿到权重后在最终颜色上刷一层（0.46–0.56 的窄过渡让边界干脆但不锯齿）。 */
            shader.fragmentShader = SHAPE_SEL_FRAG + shader.fragmentShader
              .replace('#include <dithering_fragment>',
                '#include <dithering_fragment>\n' +
                '  if ( l3SelA > 0.002 && gl_FrontFacing ) {\n' +
                '    float l3sel = l3SelMask( vL3Rest );\n' +
                '    float l3core = smoothstep( 0.46, 0.56, l3sel ) * l3SelA;\n' +
                '    gl_FragColor.rgb = mix( gl_FragColor.rgb, l3SelColor, l3core );\n' +
                '  }');
          };
          materials.push(material);
        });

        model.updateMatrixWorld(true);

        meta.avatar.meshes.forEach(function (item) {
          if (item.position) {
            var posData = values(item.position);
            for (var pi = 1; pi < posData.length; pi += 3) {
              if (posData[pi] < restMinY) restMinY = posData[pi];
              if (posData[pi] > restMaxY) restMaxY = posData[pi];
            }
          }
          var geometry = new THREE.BufferGeometry();
          geometries.push(geometry);
          ['position', 'normal', 'uv', 'skinWeight'].forEach(function (key) {
            if (item[key]) geometry.setAttribute(key, attribute(item[key]));
          });
          geometry.setAttribute('skinIndex', attribute(item.skinIndex, true));

          /* 逐顶点部位标记（0 皮肤 / 1 眼球 / 2 睫毛 / 3 眼角 / 4 口腔）。
           * 皮肤那块全是 0，只有 FaceEyes 需要逐分量判定。
           * 眼线高度用与 shader 完全一致的公式，避免两边基准漂掉。 */
          var vertexCount = item.position ? item.position.count / 3 : 0;
          if (vertexCount > 0) {
            var partData = new Float32Array(vertexCount);
            var eyeLineY = restMinY + 0.299 * (restMaxY - restMinY);
            var restPos = values(item.position);
            item.primitives.forEach(function (part) {
              var matName = (meta.avatar.materials[part.material] || {}).name || '';
              if (!/^FaceEyes$/i.test(matName)) return;
              tagVertexParts(values(part.indices), restPos, partData, eyeLineY);
            });
            geometry.setAttribute('aPart', new THREE.BufferAttribute(partData, 1));
            /* 部位统计：探针靠它守住「眼球 / 睫毛 / 口腔确实被分开打标」这件事。
             * 分类全为 0 时肉眼看不出差别（睫毛照样不跟着动），必须能被断言抓住。 */
            var tally = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
            for (var vi = 0; vi < partData.length; vi++) {
              var tag = partData[vi] | 0;
              tally[tag] = (tally[tag] || 0) + 1;
            }
            partCounts = tally;
            /* 部位包围盒：睫毛长度 / 翘度这类「绝对位移量」要按实际尺寸定标，
             * 系数不能凭截图猜。原样是模型原始单位（shader 里的 p / rest 同一套）。 */
            var boxes = {};
            for (var bj = 0; bj < partData.length; bj++) {
              var bTag = partData[bj] | 0;
              var bx = restPos[bj * 3], by = restPos[bj * 3 + 1], bz = restPos[bj * 3 + 2];
              var e = boxes[bTag];
              if (!e) {
                boxes[bTag] = { minX: bx, maxX: bx, minY: by, maxY: by, minZ: bz, maxZ: bz };
              } else {
                if (bx < e.minX) e.minX = bx;
                if (bx > e.maxX) e.maxX = bx;
                if (by < e.minY) e.minY = by;
                if (by > e.maxY) e.maxY = by;
                if (bz < e.minZ) e.minZ = bz;
                if (bz > e.maxZ) e.maxZ = bz;
              }
            }
            partBoxes = boxes;
          }

          var count = item.primitives.reduce(function (sum, part) { return sum + part.indices.count; }, 0);
          var indices = new Uint32Array(count);
          var offset = 0;
          item.primitives.forEach(function (part) {
            indices.set(values(part.indices), offset);
            geometry.addGroup(offset, part.indices.count, part.material);
            offset += part.indices.count;
          });
          geometry.setIndex(new THREE.BufferAttribute(indices, 1));

          geometry.morphTargetsRelative = true;
          geometry.morphAttributes.position = (item.morphs || []).map(function (morph) {
            var attr = attribute(morph.position);
            attr.name = morph.name;
            return attr;
          });
          if (item.morphs && item.morphs.every(function (morph) { return morph.normal; })) {
            geometry.morphAttributes.normal = item.morphs.map(function (morph) { return attribute(morph.normal); });
          }

          var inverses = values(item.inverseBind);
          var skeleton = new THREE.Skeleton(
            item.bones.map(function (index) { return bones[index]; }),
            item.bones.map(function (_, index) {
              return new THREE.Matrix4().fromArray(inverses, index * 16).transpose();
            })
          );
          var mesh = new THREE.SkinnedMesh(geometry, materials);
          mesh.bind(skeleton, new THREE.Matrix4());
          mesh.frustumCulled = false;
          model.add(mesh);

          (item.morphs || []).forEach(function (morph, index) {
            if (!morph.name || morph.name.charAt(0) === '-') return;
            morphMap[morph.name] = { mesh: mesh, index: index };
          });
          driven.push({ mesh: mesh, morphs: item.morphs || [] });
        });

        if (Number.isFinite(restMinY) && restMaxY > restMinY) {
          shapeUniforms.bounds.value.set(restMinY, restMaxY, 1 / (restMaxY - restMinY));
          syncRegionCores();
        }
        applyShapeUniforms();

        /* ---- 选区覆层：在模型自己的材质里叠一层色 ----
         * 旧做法一路是「屏幕上投一圈贴脸椭圆」，浮在脸前、跟网格没关系；
         * 中途试过叠一张索引网格点亮三角面，但那样是碎的（每个面一块、边界阶梯状）。
         * 现在改在材质 fragment 里逐片元算掩码：拿 rest 坐标现算 (au, v)，
         * 套与变形同一套公式取权重，再按权重刷一层颜色。
         * 相当于直接在模型自身的贴图上画覆层——连续、无缝、不碎，
         * 边界是该掩码的等值线，亮到哪就是真的动到哪。 */
        var SEL_CORE = 0.5;             /* 掩码核心阈值，与 shader 里 0.46–0.56 的窄过渡对齐 */
        var SEL_ALPHA = 0.62;           /* 满强度时的最大不透明，不盖住脸 */
        var selState = { mask: null, strength: 0 };
        var SEL_KINDS = { coil: 0, eye: 1, mouth: 2, nose: 3 };

        function setFaceHighlight(mask, strength) {
          var value = clamp(Number(strength) || 0, 0, 1);
          selState.mask = mask && value > 0 ? mask : null;
          selState.strength = selState.mask ? value : 0;
          if (!selState.mask) {
            shapeUniforms.selA.value = 0;
            return { strength: 0, kind: 0 };
          }
          var kind = 0;
          if (selState.mask.region === 'eye') kind = SEL_KINDS.eye;
          else if (selState.mask.region === 'mouth') kind = SEL_KINDS.mouth;
          else if (selState.mask.key === 'noseLength') kind = SEL_KINDS.nose;
          if (selState.mask.coil) {
            shapeUniforms.highlight.value.set(
              selState.mask.coil[0], selState.mask.coil[1],
              selState.mask.coil[2], selState.mask.coil[3]);
          }
          shapeUniforms.highlightMix.value = kind;
          shapeUniforms.selA.value = selState.strength * SEL_ALPHA;
          return { strength: selState.strength, kind: kind };
        }

        /* ---- 纹理分区遮罩 ----
         * 按 3D 部位把贴图切成互不重叠的 UV 区域，纹理编辑器只允许在选中区域落笔，
         * 这样改眼睛不会带到眉毛、改嘴不会蹭到下巴。分类阈值来自参考脸实测坐标，
         * 换脸模需要重新标定；按钮文案与 REGION_DEFS 一一对应。 */
        var REGION_DEFS = [
          { id: 1, key: 'face', label: '面部' },
          { id: 2, key: 'eyes', label: '眼睛' },
          { id: 3, key: 'brow', label: '眉毛' },
          { id: 4, key: 'nose', label: '鼻子' },
          { id: 5, key: 'mouth', label: '嘴巴' }
        ];
        var regionData = null;

        function regionIdFor(primName, cx, cy, cz, t) {
          var ax = Math.abs(cx);
          if (primName === 'FaceEyes') {
            if (cy < 1.200 && ax < 0.020 && cz > 0) return 5; /* 口腔 / 牙齿 */
            if (cy < 1.250) return 2;                         /* 眼球 / 睫毛 / 眼白 */
            return 1;
          }
          if (t < 0.20 && ax < 0.030) return 5;                             /* 唇 */
          if (t >= 0.18 && t < 0.30 && ax < 0.016 && cz > 0.060) return 4;  /* 鼻尖 */
          if (t >= 0.24 && t < 0.36 && ax > 0.010 && ax < 0.075 && cz > 0.010) return 2;
          if (t >= 0.36 && t < 0.50 && ax > 0.015 && ax < 0.085 && cz > 0.045) return 3;
          return 1;
        }

        function buildRegionMask() {
          var image = currentTextureImage;
          var width = (image && (image.naturalWidth || image.width)) || 2048;
          var height = (image && (image.naturalHeight || image.height)) || 2048;
          var ids = new Uint8Array(width * height);
          var size = restMaxY - restMinY;
          if (!(size > 0)) return null;

          /* 把 UV 三角形栅格化进 ids；面部是兜底区，只填空位，避免盖住五官 */
          function fill(id, ua, va, ub, vb, uc, vc) {
            var ax = ua * width, ay = (1 - va) * height;
            var bx = ub * width, by = (1 - vb) * height;
            var cx = uc * width, cy = (1 - vc) * height;
            var d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(d) < 1e-9) return;
            var x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
            var x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
            var y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
            var y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
            for (var y = y0; y <= y1; y++) {
              for (var x = x0; x <= x1; x++) {
                var px = x + 0.5, py = y + 0.5;
                var w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
                var w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
                if (w0 < -0.002 || w1 < -0.002 || (1 - w0 - w1) < -0.002) continue;
                var index = y * width + x;
                if (id === 1 && ids[index]) continue;
                ids[index] = id;
              }
            }
          }

          meta.avatar.meshes.forEach(function (item) {
            if (!item.position || !item.uv) return;
            var positions = values(item.position);
            var uvs = values(item.uv);
            item.primitives.forEach(function (part) {
              var material = meta.avatar.materials[part.material] || {};
              var indices = values(part.indices);
              for (var i = 0; i < indices.length; i += 3) {
                var i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
                var cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
                var cy = (positions[i0 * 3 + 1] + positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 3;
                var cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
                var id = regionIdFor(material.name, cx, cy, cz, (cy - restMinY) / size);
                fill(id, uvs[i0 * 2], uvs[i0 * 2 + 1], uvs[i1 * 2], uvs[i1 * 2 + 1], uvs[i2 * 2], uvs[i2 * 2 + 1]);
              }
            });
          });

          var buckets = {};
          REGION_DEFS.forEach(function (def) {
            buckets[def.id] = { id: def.id, key: def.key, label: def.label, pixels: 0, u0: 1, v0: 1, u1: 0, v1: 0 };
          });
          for (var p = 0; p < ids.length; p++) {
            var id = ids[p];
            if (!id || !buckets[id]) continue;
            var bucket = buckets[id];
            bucket.pixels++;
            var u = ((p % width) + 0.5) / width;
            var v = 1 - (((p / width) | 0) + 0.5) / height;
            if (u < bucket.u0) bucket.u0 = u;
            if (u > bucket.u1) bucket.u1 = u;
            if (v < bucket.v0) bucket.v0 = v;
            if (v > bucket.v1) bucket.v1 = v;
          }
          var list = REGION_DEFS.map(function (def) { return buckets[def.id]; })
            .filter(function (item) { return item.pixels > 0; });
          list.forEach(function (item) {
            item.bbox = [item.u0, item.v0, item.u1, item.v1];
            delete item.u0; delete item.v0; delete item.u1; delete item.v1;
          });
          return { width: width, height: height, ids: ids, list: list };
        }

        /* 遮罩有 400 万像素，等第一次打开纹理页再算，避免拖慢启动 */
        function regionMask() {
          if (!regionData) regionData = buildRegionMask();
          return regionData;
        }

        (meta.avatar.preview_pose && meta.avatar.preview_pose.nodes || []).forEach(function (pose) {
          var node = bones[pose.index];
          if (!node) return;
          if (pose.position) node.position.fromArray(pose.position);
          if (pose.rotation) node.quaternion.fromArray(pose.rotation);
          if (pose.scale) node.scale.fromArray(pose.scale);
        });
        model.updateMatrixWorld(true);

        var bounds = new THREE.Box3().setFromObject(model, true);
        focus.copy(bounds.getCenter(new THREE.Vector3()));
        /* 参考脸只有头部：镜头留出额顶与下巴的余量，避免贴边裁切 */
        focus.y += 0.004;
        var size = bounds.getSize(new THREE.Vector3());
        var frameHeight = Math.max((meta.avatar.preview_height || 0.32) * 1.1, size.y * 1.35);
        initialDistance = frameHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        distance = initialDistance;
        camera.near = Math.max(0.005, initialDistance * 0.01);
        camera.far = initialDistance * 20;
        camera.updateProjectionMatrix();
        updateCamera();

        /* ---- 三维操控点 ----
         * 按 ANCHOR_SPECS 在当前脸模上取「该高度的最前表面点」，
         * 用射线投射到蒙皮后的真实曲面，拖动时屏幕坐标由相机实时投影。 */
        var anchorPoints = null;
        var anchorRest = null;
        var anchorRaycaster = new THREE.Raycaster();
        var frontDir = new THREE.Vector3(0, 0, 1).transformDirection(model.matrixWorld);
        var anchorToPoint = new THREE.Vector3();
        var anchorDir = new THREE.Vector3();
        var anchorProject = new THREE.Vector3();

        function buildAnchors() {
          var out = {};
          var restOut = {};
          var height = restMaxY - restMinY;
          if (!(height > 0)) return out;
          var front = [];
          meta.avatar.meshes.forEach(function (item) {
            if (!item.position) return;
            var pos = values(item.position);
            for (var i = 0; i < pos.length; i += 3) {
              if (pos[i + 2] > 0) front.push(pos[i], pos[i + 1], pos[i + 2]);
            }
          });
          var targets = [];
          model.traverse(function (object) {
            if (object.isSkinnedMesh) targets.push(object);
          });
          function pick(t, ratio) {
            var yT = restMinY + t * height;
            var band = Math.max(height * 0.02, 0.0015);
            var maxX = 0, i;
            for (i = 0; i < front.length; i += 3) {
              if (Math.abs(front[i + 1] - yT) > band) continue;
              var ax = Math.abs(front[i]);
              if (ax > maxX) maxX = ax;
            }
            if (!(maxX > 0)) return null;
            var targetX = ratio * maxX;
            var bestZ = -Infinity;
            for (i = 0; i < front.length; i += 3) {
              if (Math.abs(front[i + 1] - yT) > band) continue;
              if (Math.abs(Math.abs(front[i]) - targetX) > maxX * 0.14) continue;
              if (front[i + 2] > bestZ) bestZ = front[i + 2];
            }
            if (bestZ === -Infinity) bestZ = 0;
            return new THREE.Vector3(targetX, yT, bestZ + 0.003);
          }
          Object.keys(ANCHOR_SPECS).forEach(function (key) {
            var spec = ANCHOR_SPECS[key];
            var local = pick(spec.t, spec.u);
            if (!local) return;
            restOut[key] = local.clone();
            var world = local.clone().applyMatrix4(model.matrixWorld);
            anchorRaycaster.set(world.clone().addScaledVector(frontDir, 0.35), frontDir.clone().negate());
            anchorRaycaster.far = 0.7;
            var hits = anchorRaycaster.intersectObjects(targets, false);
            out[key] = hits.length ? hits[0].point.clone() : world;
          });
          anchorRest = restOut;
          return out;
        }

        function gizmoAnchor(key) {
          if (!anchorPoints) anchorPoints = buildAnchors();
          var point = anchorPoints[key];
          return point ? point.toArray() : null;
        }

        function projectAnchor(key) {
          if (!anchorPoints) anchorPoints = buildAnchors();
          var point = anchorPoints[key];
          var width = host.clientWidth, height = host.clientHeight;
          if (!point || !width || !height) return { x: 0, y: 0, visible: false };
          anchorToPoint.copy(point).sub(focus);
          camera.getWorldDirection(anchorDir);
          /* 点在脸心中线之后就被脸挡住，不再显示手柄 */
          var facing = anchorToPoint.dot(anchorDir) < 0.015;
          anchorProject.copy(point).project(camera);
          return {
            x: (anchorProject.x * 0.5 + 0.5) * width,
            y: (-anchorProject.y * 0.5 + 0.5) * height,
            visible: facing && anchorProject.z < 1
          };
        }

        /* 旧签名（只传线圈）保留一层包装，内部一律走面高亮 */
        function setHighlight(coil, strength) {
          setFaceHighlight(coil ? { coil: coil } : null, strength);
        }

        /* ---- 贴脸采样：解析曲面 + 平滑高度网格 ----
         * 选区不再画成线圈，但这套采样还留着：
         * 1) 选区手柄（拖动改范围）要落在脸上可点的位置；
         * 2) projectCoil / projectRegion 仍是界面定位手柄的唯一来源。
         * x/y 由 (u,v) 解析式给出，z 取自一张 64×64 的正面高度网格
         * （空单元用邻居均值补齐），手柄因此永远贴着真实脸面。 */
        var coilRingCache = Object.create(null);
        var COIL_SEGS = 48;
        var coilDir = new THREE.Vector3();
        var coilToPoint = new THREE.Vector3();
        var coilProject = new THREE.Vector3();
        var surfGrid = null;
        var GRID_N = 64;

        function buildSurfGrid() {
          var n = GRID_N;
          var z = new Float32Array(n * n);
          for (var i = 0; i < z.length; i++) z[i] = NaN;
          var height = restMaxY - restMinY;
          if (!(height > 0)) return z;
          var hScale = height / 0.202114;
          meta.avatar.meshes.forEach(function (item) {
            if (!item.position) return;
            var pos = values(item.position);
            for (var p = 0; p < pos.length; p += 3) {
              var vz = pos[p + 2];
              if (!(vz > 0)) continue;
              var t = clamp((pos[p + 1] - restMinY) / height, 0, 1);
              var w = Math.max(gizmoHalfW(t), 0.020) * hScale;
              var u = pos[p] / w;
              if (u < -1 || u > 1) continue;
              var ix = clamp(Math.round((u + 1) * 0.5 * (n - 1)), 0, n - 1);
              var iy = clamp(Math.round(gizmoV(t) * (n - 1)), 0, n - 1);
              var idx = iy * n + ix;
              if (!(z[idx] >= vz)) z[idx] = vz;
            }
          });
          for (var pass = 0; pass < 10; pass++) {
            var holes = 0;
            for (var y = 0; y < n; y++) {
              for (var x = 0; x < n; x++) {
                var cell = y * n + x;
                if (!isNaN(z[cell])) continue;
                var sum = 0, cnt = 0;
                for (var dy = -1; dy <= 1; dy++) {
                  for (var dx = -1; dx <= 1; dx++) {
                    var yy = y + dy, xx = x + dx;
                    if (yy < 0 || yy >= n || xx < 0 || xx >= n) continue;
                    var nz = z[yy * n + xx];
                    if (!isNaN(nz)) { sum += nz; cnt++; }
                  }
                }
                if (cnt) z[cell] = sum / cnt; else holes++;
              }
            }
            if (!holes) break;
          }
          /* 左右镜像平均：脸模本身不是绝对对称的（牙齿、睫毛会偏一边），
           * 深度不对称会让选区在屏幕上歪掉，取镜像均值后左右一致。 */
          for (var ry = 0; ry < n; ry++) {
            for (var rx = 0; rx < Math.floor(n / 2); rx++) {
              var li = ry * n + rx;
              var ri = ry * n + (n - 1 - rx);
              var lv = z[li], rv = z[ri];
              if (isNaN(lv) && isNaN(rv)) continue;
              if (isNaN(lv)) lv = rv;
              if (isNaN(rv)) rv = lv;
              var mean = (lv + rv) * 0.5;
              z[li] = mean;
              z[ri] = mean;
            }
          }
          return z;
        }

        function surfaceZ(u, v) {
          if (!surfGrid) surfGrid = buildSurfGrid();
          var n = GRID_N;
          var fx = clamp((u + 1) * 0.5 * (n - 1), 0, n - 1);
          var fy = clamp(v * (n - 1), 0, n - 1);
          var x0 = Math.floor(fx), y0 = Math.floor(fy);
          var x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
          var ax = fx - x0, ay = fy - y0;
          function at(xx, yy) {
            var val = surfGrid[yy * n + xx];
            return isNaN(val) ? 0 : val;
          }
          var top = at(x0, y0) * (1 - ax) + at(x1, y0) * ax;
          var bot = at(x0, y1) * (1 - ax) + at(x1, y1) * ax;
          return top * (1 - ay) + bot * ay;
        }

        /* v → 线性高度 t（l3V 单调，二分求逆即可） */
        function vToT(v) {
          var lo = 0, hi = 1;
          for (var i = 0; i < 26; i++) {
            var mid = (lo + hi) * 0.5;
            if (gizmoV(mid) < v) lo = mid; else hi = mid;
          }
          return (lo + hi) * 0.5;
        }

        function surfaceLocal(u, v) {
          var height = restMaxY - restMinY;
          var t = vToT(clamp(v, 0, 1));
          var hScale = height / 0.202114;
          var w = Math.max(gizmoHalfW(t), 0.020) * hScale;
          return new THREE.Vector3(
            u * w,
            restMinY + t * height,
            surfaceZ(clamp(u, -1, 1), clamp(v, 0, 1)) + 0.0035
          );
        }

        /* ---- 五官体积核：用脸高比例定标，换脸也不用手改 ----
         * 中心点取「贴脸曲面上该五官的中心再往里退一段」，半径按 H 的比例给；
         * 嘴的口腔、眼睛的眼球都在皮肤后面，二维椭圆盖不到，靠这颗椭球兜住。 */
        var regionBase = null;

        /* 实测该高度的正面深度：扫一遍顶点取前端最大值，避免依赖网格状态 */
        function frontZ(tCenter, tBand, uCenter, uBand) {
          var height = restMaxY - restMinY;
          if (!(height > 0)) return null;
          var hScale = height / 0.202114;
          var best = -Infinity;
          meta.avatar.meshes.forEach(function (item) {
            if (!item.position) return;
            var pos = values(item.position);
            for (var i = 0; i < pos.length; i += 3) {
              var x = pos[i], y = pos[i + 1], z = pos[i + 2];
              if (!(z > 0)) continue;
              var t = (y - restMinY) / height;
              if (Math.abs(t - tCenter) > tBand) continue;
              var w = Math.max(gizmoHalfW(t), 0.020) * hScale;
              if (Math.abs(x / w - uCenter) > uBand) continue;
              if (z > best) best = z;
            }
          });
          return best === -Infinity ? null : best;
        }

        function syncRegionCores() {
          var height = restMaxY - restMinY;
          if (!(height > 0)) return;
          var hScale = height / 0.202114;
          var eyeT = 0.293;
          /* 嘴的体积核中心取「上下唇 + 口腔」的中间高度，否则唇后的牙床落在核外 */
          var mouthT = 0.128;
          var eyeW = Math.max(gizmoHalfW(eyeT), 0.020) * hScale;
          var mouthW = Math.max(gizmoHalfW(mouthT), 0.020) * hScale;
          var eyeZ = frontZ(eyeT, 0.02, 0.42, 0.30);
          var mouthZ = frontZ(mouthT, 0.02, 0, 0.30);
          if (!(eyeZ > 0)) eyeZ = 0.06 * (height / 0.202114);
          if (!(mouthZ > 0)) mouthZ = 0.06 * (height / 0.202114);
          regionBase = {
            height: height,
            eyeW: eyeW,
            mouthW: mouthW,
            eye: [0.13 * height, 0.075 * height, 0.13 * height],
            mouth: [0.24 * height, 0.115 * height, 0.28 * height]
          };
          shapeUniforms.eyeC.value.set(0.42 * eyeW, restMinY + eyeT * height, eyeZ - 0.09 * height);
          shapeUniforms.mouthC.value.set(0, restMinY + mouthT * height, mouthZ - 0.10 * height);
          applyCoreRadii();
        }

        /* 柔边随位移自动放宽：拖得越远，跟着一起走的组织越多，
         * 位移始终小于「能吸收它的过渡带」，才不会在边界上撕出洞。 */
        function applyCoreRadii() {
          if (!regionBase) return;
          [['eye', shapeUniforms.eyeX.value, regionBase.eyeW, shapeUniforms.eyeR.value, regionBase.eye],
            ['mouth', shapeUniforms.mouthX.value, regionBase.mouthW, shapeUniforms.mouthR.value, regionBase.mouth]]
            .forEach(function (item) {
              var xf = item[1];
              var push = Math.max(Math.abs(Number(xf.x) || 0) * item[2],
                Math.abs(Number(xf.y) || 0) * regionBase.height);
              var grow = push * 1.7;
              item[3].set(item[4][0] + grow, item[4][1] + grow * 0.9, item[4][2] + grow * 0.5);
            });
        }

        /* 兼容旧调用点：贴脸采样就是解析曲面上的点 */
        function nearestFront(u, v) {
          return surfaceLocal(clamp(u, -1, 1), clamp(v, 0.002, 0.998));
        }

        /* 投影后的椭圆做两轮 3 点平滑：采样点少又贴着起伏的脸，边框会是毛刺状 */
        function smoothRing(points, passes) {
          var out = points.slice();
          var n = out.length;
          if (n < 4) return out;
          for (var p = 0; p < (passes || 2); p++) {
            var next = out.slice();
            for (var i = 0; i < n; i++) {
              var a = out[(i - 1 + n) % n];
              var b = out[i];
              var c = out[(i + 1) % n];
              if (!a || !b || !c || !a.visible || !b.visible || !c.visible) continue;
              next[i] = { x: (a.x + b.x * 2 + c.x) / 4, y: (a.y + b.y * 2 + c.y) / 4, visible: true };
            }
            out = next;
          }
          return out;
        }

        function projectPoint(point) {
          var width = host.clientWidth, height = host.clientHeight;
          if (!point || !width || !height) return { x: 0, y: 0, visible: false };
          coilToPoint.copy(point).sub(focus);
          camera.getWorldDirection(coilDir);
          var facing = coilToPoint.dot(coilDir) < 0.02;
          coilProject.copy(point).project(camera);
          return {
            x: (coilProject.x * 0.5 + 0.5) * width,
            y: (-coilProject.y * 0.5 + 0.5) * height,
            visible: facing && coilProject.z < 1 && coilProject.z > -1
          };
        }

        function coilWorld(hit, mirror) {
          var local = new THREE.Vector3(mirror ? -hit.x : hit.x, hit.y, hit.z);
          return local.applyMatrix4(model.matrixWorld);
        }

        function projectCoil(key) {
          var index = COIL_INDEX[key];
          if (index === undefined) return null;
          var data = coilRingCache[key];
          if (!data) {
            var vec = shapeUniforms.coils.value[index];
            var uc = vec.x, ur = vec.y, vc = vec.z, vr = vec.w;
            var ring = [], mirror = [];
            for (var i = 0; i < COIL_SEGS; i++) {
              var a = (i / COIL_SEGS) * Math.PI * 2;
              var u = clamp(uc + ur * Math.cos(a), -1, 1);
              var v = clamp(vc + vr * Math.sin(a), 0.005, 0.995);
              var hit = nearestFront(u, v);
              if (!hit) continue;
              ring.push(coilWorld(hit, false));
              mirror.push(coilWorld(hit, true));
            }
            function edge(eu, ev) {
              var item = nearestFront(clamp(eu, -1, 1), clamp(ev, 0.005, 0.995));
              return item ? coilWorld(item, false) : null;
            }
            data = {
              ring: ring,
              mirror: uc > 0.12 ? mirror : null,
              center: edge(uc, vc),
              edges: {
                right: edge(uc + ur, vc),
                left: edge(uc - ur, vc),
                top: edge(uc, vc + vr),
                bottom: edge(uc, vc - vr)
              }
            };
            coilRingCache[key] = data;
          }
          return {
            ring: smoothRing(data.ring.map(projectPoint)),
            mirror: data.mirror ? smoothRing(data.mirror.map(projectPoint)) : null,
            center: projectPoint(data.center),
            edges: {
              right: projectPoint(data.edges.right),
              left: projectPoint(data.edges.left),
              top: projectPoint(data.edges.top),
              bottom: projectPoint(data.edges.bottom)
            }
          };
        }

        /* 线圈改动后丢掉贴脸采样，拖动时重新取样 */
        function invalidateCoils() { coilRingCache = Object.create(null); }

        /* ---- 轮廓曲线（直接拖脸缘）----
         * shader 里的 l3Outline(t) 乘在宽度 wx 上，界面这边必须用同一条曲线算出
         * 手柄该落在哪：把「中线点 → 脸缘点」的屏幕向量按同一个倍率缩放即可
         * （宽度缩放是绕中线的纯 x 缩放，屏幕上等价）。 */
        function outlineValues() {
          var v = shapeUniforms.outline.value;
          return [v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y];
        }

        /* 与生成出来的 GLSL 完全同形：逐段覆盖，取最后一个成立的段 */
        function outlineAt(t) {
          var f = outlineValues();
          var k = f[0];
          for (var i = 1; i < f.length; i++) {
            if (t < OUTLINE_KNOTS[i - 1]) break;
            var p0 = f[Math.max(0, i - 2)], p1 = f[i - 1], p2 = f[i], p3 = f[Math.min(f.length - 1, i + 1)];
            var s = clamp((t - OUTLINE_KNOTS[i - 1]) / OUTLINE_STEP, 0, 1);
            var s2 = s * s, s3 = s2 * s;
            k = 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 +
              (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
          }
          return k;
        }

        function setOutline(list) {
          var v = shapeUniforms.outline.value;
          OUTLINE_KNOTS.forEach(function (t, i) {
            var raw = Array.isArray(list) ? Number(list[i]) : NaN;
            var k = Number.isFinite(raw) ? clamp(raw, OUTLINE_LIMIT[0], OUTLINE_LIMIT[1]) : 1;
            v[Math.floor(i / 3)].setComponent(i % 3, k);
          });
        }

        function resetOutline() { setOutline(null); }

        /* 脸缘在「现在的」脸型下有多宽 —— 只算 SHAPE_VERT_HEAD 里影响 x 的主项
         * （wx 链）。手柄必须贴在当前的轮廓上而不是原始网格上：脸宽拉到 100 时
         * 原始脸缘比屏幕上的脸窄两成，手柄会缩进脸里，看着就是「点不在脸上」。
         * ⚠ 这是 shader 的 JS 镜像，改 wx 那几行必须同步改这里。 */
        function coilAtPoint(index, au, v) {
          var c = shapeUniforms.coils.value[index];
          var du = (au - c.x) / Math.max(c.y, 1e-4);
          var dv = (v - c.z) / Math.max(c.w, 1e-4);
          var s = clamp((du * du + dv * dv - 0.15) / 0.95, 0, 1);
          return 1 - s * s * (3 - 2 * s);
        }

        function edgeScaleX(au, v) {
          var k = 1 + shapeNorm(shapeValues.width) * 0.24 * coilAtPoint(0, au, v);
          k *= 1 - shapeNorm(shapeValues.jaw) * 0.18 * coilAtPoint(3, au, v);
          k *= 1 + shapeNorm(shapeValues.cheek) * 0.11 * coilAtPoint(4, au, v);
          k *= 1 + shapeNorm(shapeValues.cheekFull) * 0.09 * coilAtPoint(5, au, v);
          k *= 1 + shapeNorm(shapeValues.forehead) * 0.16 * coilAtPoint(6, au, v);
          return k;
        }

        /* 每个节点的屏幕位置。三个点：
         *   center —— 中线（u≈0）；base —— 倍率 1 时的脸缘（含滑杆补偿）；
         *   edge   —— 当前倍率下的脸缘。
         * 为什么 edge 不写成 base × k：形变是「加位移」(k-1)×w（见 outlineDx），
         * 所以当前脸缘是 w×(sx + k - 1)，不是 w×sx×k。界面直接摆 edge，
         * 拖拽用 |base - center| 当 Δk 的基准长度 —— 两边口径完全一致。
         * 左右各给一份：左侧直接拿 u=-1 的脸缘点，不镜像右边的（相机一转就错位）。
         * index 必须带出去：某个节点被背面剔除时返回数组会短一截，界面按数组下标
         * 找人就会错位（第 6 个点画到第 7 个点的位置）。 */
        function projectOutline() {
          var out = [];
          OUTLINE_KNOTS.forEach(function (t, index) {
            var v = clamp(gizmoV(t), 0.005, 0.995);
            var center = nearestFront(0.001, v);
            var edge = nearestFront(1, v);
            var edgeL = nearestFront(-1, v);
            if (!center || !edge || !edgeL) return;
            var k = outlineAt(t);
            var sx = edgeScaleX(1, v);
            var w = edge.x;                 /* surfaceLocal(1,v).x 就是该高度的半宽 */
            var baseX = w * sx;
            var nowX = w * (sx + k - 1);
            var pc = projectPoint(coilWorld(center, false));
            out.push({
              index: index,
              t: t,
              k: k,
              center: pc,
              base: projectPoint(coilWorld(new THREE.Vector3(baseX, edge.y, edge.z), false)),
              baseL: projectPoint(coilWorld(new THREE.Vector3(-baseX, edgeL.y, edgeL.z), false)),
              edge: projectPoint(coilWorld(new THREE.Vector3(nowX, edge.y, edge.z), false)),
              edgeL: projectPoint(coilWorld(new THREE.Vector3(-nowX, edgeL.y, edgeL.z), false))
            });
          });
          return out;
        }

        /* ---- 眼睛 / 嘴巴的区域变换 ----
         * 与 shader 同源：u/v 椭圆 → 中心、平移、旋转、缩放。
         * 眼睛按 ±uc 左右各画一整圈，每个环 3 个手柄（移动 / 缩放 / 旋转）。 */
        var REGION_SEGS = 44;

        function regionRest(u, v) {
          return nearestFront(clamp(u, -1, 1), clamp(v, 0.005, 0.995));
        }

        function readXform(list) {
          var src = Array.isArray(list) ? list : [];
          var scale = Number(src[3]);
          return [
            Number(src[0]) || 0,
            Number(src[1]) || 0,
            Number(src[2]) || 0,
            Number.isFinite(scale) && scale > 0 ? scale : 1
          ];
        }

        function setXform(xform) {
          if (!xform) return;
          if (xform.eye) shapeUniforms.eyeX.value.fromArray(readXform(xform.eye));
          if (xform.mouth) shapeUniforms.mouthX.value.fromArray(readXform(xform.mouth));
          applyCoreRadii();
        }

        function currentXform() {
          return {
            eye: shapeUniforms.eyeX.value.toArray(),
            mouth: shapeUniforms.mouthX.value.toArray()
          };
        }

        /* 把脸上的静止点按当前 xform 变形（公式必须与 l3Deform 末尾一致） */
        function regionLocal(hit, kind, xf) {
          var local = new THREE.Vector3(hit.x, hit.y, hit.z);
          var height = restMaxY - restMinY;
          if (!(height > 0)) return local;
          var hScale = height / 0.202114;
          var t = clamp((hit.y - restMinY) / height, 0, 1);
          var w = Math.max(gizmoHalfW(t), 0.020) * hScale;
          var eyeY = restMinY + 0.299 * height;
          var mouthY = restMinY + 0.112 * height;
          var side = hit.x >= 0 ? 1 : -1;
          var cx = kind === 'eye' ? side * 0.61 * w : 0;
          var cy = kind === 'eye' ? eyeY : mouthY;
          var scale = clamp(Number(xf[3]) || 1, 0.1, 4);
          var ang = (kind === 'eye' ? Number(xf[2]) * side : Number(xf[2])) || 0;
          var rx = (hit.x - cx) * scale;
          var ry = (hit.y - cy) * scale;
          var cs = Math.cos(ang), sn = Math.sin(ang);
          local.x = cx + rx * cs - ry * sn + (kind === 'eye' ? side : 1) * (Number(xf[0]) || 0) * w;
          local.y = cy + rx * sn + ry * cs + (Number(xf[1]) || 0) * height;
          return local;
        }

        /* 椭圆半径上下分开（睫毛只往上长得更远），取半径按方向挑一支 */
        function frameVr(frame, dir) { return dir >= 0 ? frame.vrUp : frame.vrDn; }

        function projectRegion(kind) {
          var frame = REGION_FRAMES[kind];
          if (!frame) return null;
          var xf = kind === 'eye' ? shapeUniforms.eyeX.value.toArray() : shapeUniforms.mouthX.value.toArray();
          var sides = kind === 'eye' ? [1, -1] : [1];
          var items = sides.map(function (side) {
            var uc = side * frame.uc;
            function at(u, v) {
              var hit = regionRest(u, v);
              return hit
                ? projectPoint(regionLocal(hit, kind, xf).applyMatrix4(model.matrixWorld))
                : { x: 0, y: 0, visible: false };
            }
            var ring = [];
            var segs = REGION_SEGS;
            /* 环必须画成与 mask 同一个形状（超椭圆），否则「看到的手柄圈」和
             * 「真正会动的范围」不一致 —— 眼睛那张算子是 p>2 的圆角矩形 */
            var pw = 2 / (Number(frame.p) || 2);
            for (var i = 0; i < segs; i++) {
              var a = (i / segs) * Math.PI * 2;
              var ca = Math.cos(a), sa = Math.sin(a);
              var eu = Math.sign(ca) * Math.pow(Math.abs(ca), pw);
              var ev = Math.sign(sa) * Math.pow(Math.abs(sa), pw);
              var hit = regionRest(uc + frame.ur * eu,
                frame.vc + frameVr(frame, ev) * ev);
              if (!hit) continue;
              ring.push(projectPoint(regionLocal(hit, kind, xf).applyMatrix4(model.matrixWorld)));
            }
            var center = at(uc, frame.vc);
            /* 平移增益：中心点沿 tx / ty 各 +1 时的屏幕位移，拖动时用来解 2×2 方程 */
            var gain = { tx: [0, 0], ty: [0, 0] };
            var base = regionRest(uc, frame.vc);
            if (base) {
              var pa = projectPoint(regionLocal(base, kind, xf).applyMatrix4(model.matrixWorld));
              var upTx = xf.slice(); upTx[0] = (Number(xf[0]) || 0) + 1;
              var upTy = xf.slice(); upTy[1] = (Number(xf[1]) || 0) + 1;
              var pb = projectPoint(regionLocal(base, kind, upTx).applyMatrix4(model.matrixWorld));
              var pc = projectPoint(regionLocal(base, kind, upTy).applyMatrix4(model.matrixWorld));
              gain.tx = [pb.x - pa.x, pb.y - pa.y];
              gain.ty = [pc.x - pa.x, pc.y - pa.y];
            }
            return {
              side: side,
              ring: smoothRing(ring),
              center: center,
              scale: at(uc + side * frame.ur * 1.35, frame.vc),
              rotate: at(uc, frame.vc + frameVr(frame, 1) * 1.85),
              gain: gain
            };
          });
          return {
            kind: kind,
            items: items,
            rings: items.map(function (item) { return item.ring; })
          };
        }

        /* 手势增益：该参数 +1 时锚点在屏幕上移动多少像素。
         * 拖动时把指针位移投影到这条方向，手柄才会顺着真正的变形方向走。 */
        function gizmoGain(key) {
          if (!anchorPoints) anchorPoints = buildAnchors();
          if (!anchorRest) return [0, 0];
          var rest = anchorRest[key];
          var world = anchorPoints && anchorPoints[key];
          if (!rest || !world) return [0, 0];
          var height = restMaxY - restMinY;
          if (!(height > 0)) return [0, 0];
          var hScale = height / 0.202114;
          var t = clamp((rest.y - restMinY) / height, 0, 1);
          var v = gizmoV(t);
          var w = Math.max(gizmoHalfW(t), 0.020) * hScale;
          var au = Math.abs(rest.x / w);
          var eyeY = restMinY + 0.299 * height;
          var mouthY = restMinY + 0.112 * height;
          function mask(name) {
            var c = shapeUniforms.coils.value[COIL_INDEX[name]];
            var du = (au - c.x) / Math.max(c.y, 1e-4);
            var dv = (v - c.z) / Math.max(c.w, 1e-4);
            return 1 - smooth01(0.15, 1.10, du * du + dv * dv);
          }
          var dx = 0, dy = 0;
          if (key === 'width') dx = rest.x * 0.24 * 0.02 * mask('width');
          else if (key === 'length') dy = (rest.y - eyeY) * 0.13 * 0.02 * mask('length');
          else if (key === 'chin') dy = (rest.y - mouthY) * 0.35 * 0.02 * mask('chin');
          else if (key === 'jaw') dx = -rest.x * 0.18 * 0.02 * mask('jaw');
          else if (key === 'cheek') dx = rest.x * 0.11 * 0.02 * mask('cheek');
          else if (key === 'cheekFull') dx = rest.x * 0.09 * 0.02 * mask('cheekFull');
          else if (key === 'forehead') dx = rest.x * 0.16 * 0.02 * mask('forehead');
          else if (key === 'chinWidth') dx = rest.x * 0.18 * 0.02 * mask('chinWidth');
          else if (key === 'noseLength') dy = -0.0035 * hScale * 0.02 * mask('noseLength');
          else return [0, 0];
          var delta = new THREE.Vector3(dx, dy, 0)
            .applyMatrix4(new THREE.Matrix4().extractRotation(model.matrixWorld));
          var pa = projectPoint(world);
          var pb = projectPoint(world.clone().add(delta));
          return [pb.x - pa.x, pb.y - pa.y];
        }

        function down(event) {
          if (event.button !== 0) return;
          pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
          try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
        }
        function move(event) {
          if (!pointer || pointer.id !== event.pointerId) return;
          yaw += (event.clientX - pointer.x) * 0.007;
          pitch = clamp(pitch + (event.clientY - pointer.y) * 0.007, -1.35, 1.35);
          pointer.x = event.clientX;
          pointer.y = event.clientY;
          updateCamera();
        }
        function end(event) {
          if (pointer && pointer.id === event.pointerId) pointer = null;
        }
        function wheel(event) {
          event.preventDefault();
          distance = clamp(distance * Math.exp(event.deltaY * 0.001), initialDistance * 0.28, initialDistance * 4.5);
          updateCamera();
        }

        canvas.addEventListener('pointerdown', down);
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        canvas.addEventListener('wheel', wheel, { passive: false });
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();

        var headNode = bones.filter(function (node) { return /^(head|头)$/i.test(node.name); })[0];
        var neckNode = bones.filter(function (node) { return /^(neck|颈)$/i.test(node.name); })[0];
        var headRest = headNode ? headNode.quaternion.clone() : null;
        var neckRest = neckNode ? neckNode.quaternion.clone() : null;
        var eyes = ['leftEye', 'rightEye'].map(function (name) {
          var index = meta.avatar.joints && meta.avatar.joints[name];
          return index === undefined ? null : bones[index];
        }).filter(Boolean);
        var updateGaze = createCameraGaze(THREE, eyes, camera);

        var api = {
          channels: [],
          morphNames: Object.keys(morphMap),
          setShapes: setShapes,
          setView: function (name) {
            yaw = ({ front: 0, left: -0.65, right: 0.65, top: 0 })[name] || 0;
            pitch = name === 'top' ? 0.55 : 0;
            distance = initialDistance;
            updateCamera();
          },
          tick: function (dt, seconds) {
            var t = seconds;
            if (neckNode && neckRest) {
              neckNode.quaternion.copy(neckRest).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(
                Math.sin(t * 0.43) * THREE.MathUtils.degToRad(1.5),
                Math.sin(t * 0.31 + 0.8) * THREE.MathUtils.degToRad(2.4),
                Math.sin(t * 0.23) * THREE.MathUtils.degToRad(0.45), 'YXZ')));
            }
            if (headNode && headRest) {
              headNode.quaternion.copy(headRest).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(
                Math.sin(t * 0.61 + 1.1) * THREE.MathUtils.degToRad(0.8),
                Math.sin(t * 0.37) * THREE.MathUtils.degToRad(1.4),
                Math.sin(t * 0.29 + 0.4) * THREE.MathUtils.degToRad(0.25), 'YXZ')));
            }
            model.updateMatrixWorld(true);
            updateGaze(dt);
            /* 覆层轻微呼吸：静止时也能看出这是「当前选中」，而不是脸上的一块色斑 */
            if (selState.strength > 0) {
              shapeUniforms.selA.value = selState.strength * SEL_ALPHA * (0.84 + 0.16 * Math.sin(t * 2.2));
            }
            renderer.render(scene, camera);
          },
          influence: function (name) {
            var entry = morphMap[name];
            return entry ? entry.mesh.morphTargetInfluences[entry.index] : null;
          },
          peak: function () {
            var best = { name: '', value: 0 };
            Object.keys(morphMap).forEach(function (name) {
              var entry = morphMap[name];
              var value = entry.mesh.morphTargetInfluences[entry.index] || 0;
              if (value > best.value) best = { name: name, value: value };
            });
            return best;
          },
          setShape: setShapeValue,
          setShapeAll: setShapeAll,
          shape: function (name) { return shapeValues[name]; },
          shapeValues: function () {
            var out = {};
            SHAPE_DEFS.forEach(function (def) { out[def.key] = shapeValues[def.key]; });
            return out;
          },
          shapeUniforms: function () {
            return {
              shape: shapeUniforms.values.value.map(function (vec) { return vec.toArray(); }),
              coils: shapeUniforms.coils.value.map(function (vec) { return vec.toArray(); }),
              bounds: shapeUniforms.bounds.value.toArray(),
              highlight: shapeUniforms.highlight.value.toArray(),
              /* highlightMix 现在是掩码分类（0 线圈 / 1 眼 / 2 嘴 / 3 鼻） */
              highlightMix: shapeUniforms.highlightMix.value,
              selAlpha: shapeUniforms.selA.value
            };
          },
          setCoils: function (coils) {
            setCoilUniforms(coils);
            invalidateCoils();
          },
          setXform: setXform,
          currentXform: currentXform,
          projectCoil: projectCoil,
          projectRegion: projectRegion,
          /* 轮廓曲线：直接拖脸缘。projectOutline 返回每个节点在中线 / 脸缘上的屏幕位置，
           * 界面按 outlineAt(t) 缩放即可画出与变形一致的曲线。 */
          projectOutline: projectOutline,
          outlineAt: outlineAt,
          outlineValues: outlineValues,
          outlineKnots: function () { return OUTLINE_KNOTS.slice(); },
          setOutline: setOutline,
          resetOutline: resetOutline,
          /* 区域椭圆的唯一真源（shader 由同一张表现拼）：探针用它守住
           * 「睫毛口径比皮肤高」「上下半径不对称」这两件事不被改回去 */
          regionFrames: function () {
            var out = {};
            Object.keys(REGION_FRAMES).forEach(function (key) {
              var src = REGION_FRAMES[key];
              out[key] = {};
              Object.keys(src).forEach(function (field) { out[key][field] = src[field]; });
            });
            return out;
          },
          /* 按 (au, v) 算区域掩码权重——与 shader 里 regionMaskGlsl 完全同一套公式。
           * 探针用它断言「睫毛尖拿得到权重、额头/眉毛拿不到」，不必靠截图认图。 */
          regionWeight: function (kind, au, v) {
            var f = REGION_FRAMES[kind];
            if (!f) return 0;
            var du = (au - f.uc) / f.ur;
            var dv = (v - f.vc) / (v > f.vc ? f.vrUp : f.vrDn);
            var pw = Number(f.p) || 2;
            var d = pw === 2 ? du * du + dv * dv
              : Math.pow(Math.abs(du), pw) + Math.pow(Math.abs(dv), pw);
            var t = Math.min(1, Math.max(0, (d - f.lo) / Math.max(f.hi - f.lo, 1e-6)));
            return 1 - t * t * (3 - 2 * t);
          },
          /* 每个材质的 l3EyePart：FaceEyes（眼球 / 睫毛）必须是 1，皮肤必须是 0 */
          materialParts: function () {
            return materialParts.map(function (item) { return { name: item.name, part: item.part }; });
          },
          /* 部位顶点数：睫毛 / 眼球 / 口腔必须是不同的类，否则「拉睫毛带牙齿」的
           * 老毛病会回来，而且肉眼看不出来 */
          partStats: function () { return partCounts ? Object.assign({}, partCounts) : null; },
          /* 部位包围盒 + 模型高度：睫毛长度 / 翘度的位移量按它定标 */
          partBounds: function () {
            return partBoxes ? {
              boxes: JSON.parse(JSON.stringify(partBoxes)),
              height: restMaxY - restMinY
            } : null;
          },
          /* 顶点变形那段 GLSL 的原文（探针拿它守住「眼形参数走眼圈口径」
           * 和「睫毛 / 眼球按 aPart 分开动」这两件事没被改回去）。 */
          deformSource: function () { return SHAPE_VERT_HEAD; },
          gizmoAnchor: gizmoAnchor,
          projectAnchor: projectAnchor,
          gizmoGain: gizmoGain,
          setHighlight: setFaceHighlight,
          setFaceHighlight: setFaceHighlight,
          faceHighlight: function () {
            var mask = selState.mask;
            var kind = shapeUniforms.highlightMix.value;
            return {
              on: !!mask && selState.strength > 0,
              /* 覆层画在本体材质的 fragment 里，不是独立的叠加网格——
               * 测试用这个字段守住「不要再退回碎面片」 */
              mode: 'material',
              kind: mask ? (mask.coil ? 'coil' : 'region') : 'none',
              key: mask && mask.key ? mask.key : null,
              region: mask && mask.region ? mask.region : null,
              maskId: kind,
              strength: selState.strength,
              alpha: shapeUniforms.selA.value,
              threshold: SEL_CORE,
              color: '#' + shapeUniforms.selColor.value.getHexString(),
              /* 叠加网格数量：覆层方案下必须是 0 */
              overlayMeshes: 0
            };
          },
          textureImage: function () { return currentTextureImage; },
          textureURL: function () { return currentTextureURL; },
          originalTextureURL: function () { return meta.texture; },
          textureSize: function () {
            var image = currentTextureImage;
            return image ? [image.width || image.naturalWidth, image.height || image.naturalHeight] : [0, 0];
          },
          regionMask: regionMask,
          regions: function () {
            var mask = regionMask();
            return mask ? mask.list : [];
          },
          setTextureURL: loadTextureURL,
          applyCanvasTexture: applyCanvasTexture,
          dispose: function () {
            if (resizeObserver) resizeObserver.disconnect();
            canvas.removeEventListener('pointerdown', down);
            canvas.removeEventListener('pointermove', move);
            canvas.removeEventListener('pointerup', end);
            canvas.removeEventListener('pointercancel', end);
            canvas.removeEventListener('wheel', wheel);
            geometries.forEach(function (g) { g.dispose(); });
            materials.forEach(function (m) { m.dispose(); });
            textures.forEach(function (t) { t.dispose(); });
            renderer.dispose();
            if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
          }
        };
        api.channels = api.morphNames.map(function (name) { return { name: name }; });
        setShapes({});
        return api;
      });
  }

  /* ---------- 表演曲线播放器 ---------- */
  function createCurvePlayer() {
    var pack = window.LUMEN3D_CURVES;
    var meta = window.LUMEN3D_META;
    if (!pack || !meta) throw new Error('表演曲线数据缺失');
    var catalog = meta.catalog;
    var bytes = new Uint8Array(b64ToBuffer(pack.data));
    var width = pack.channelCount;
    var scale = pack.valueMax / 255;
    var tracks = catalog.channels
      .filter(function (channel) { return channel.kind === 'blendshape'; })
      .map(function (channel) {
        return { index: channel.index, name: channel.property.replace(/^blendShape\./, '') };
      });
    var neutral = catalog.styles.filter(function (style) {
      return String(style.id) === String(catalog.neutral_style);
    })[0] || catalog.styles[0];
    var selected = neutral;
    var position = 0;
    var transition = null;
    var fadeSeconds = 0.4;

    function durationOf(style) { return Math.max(0, (style.frames - 1) / catalog.fps); }

    function readShapes(style, time) {
      var frame = Math.max(0, Math.min(time * catalog.fps, style.frames - 1));
      var start = Math.floor(frame);
      var end = Math.min(start + 1, style.frames - 1);
      var weight = frame - start;
      var shapes = {};
      tracks.forEach(function (track) {
        var a = bytes[((style.offset + start) * width) + track.index] * scale;
        var b = bytes[((style.offset + end) * width) + track.index] * scale;
        shapes[track.name] = a + (b - a) * weight;
      });
      return shapes;
    }

    function sample() {
      var shapes = readShapes(selected, position);
      if (transition) {
        var t = Math.min(1, transition.elapsed / fadeSeconds);
        var weight = t * t * (3 - 2 * t);
        Object.keys(shapes).forEach(function (name) {
          var from = transition.from[name];
          shapes[name] = (from === undefined ? 0 : from) + (shapes[name] - (from === undefined ? 0 : from)) * weight;
        });
      }
      return shapes;
    }

    function advance(dt) {
      if (!transition) return;
      transition.elapsed += dt;
      if (transition.elapsed >= fadeSeconds) transition = null;
    }

    function switchTo(style) {
      var from = sample();
      selected = style;
      position = 0;
      transition = { from: from, elapsed: 0 };
    }

    return {
      styles: catalog.styles,
      labels: catalog.styles.map(function (style) { return style.label; }),
      neutral: neutral,
      get style() { return selected; },
      get duration() { return durationOf(selected); },
      sample: sample,
      choose: function (style) { if (style && style !== selected) switchTo(style); },
      returnToNeutral: function () { if (selected !== neutral) switchTo(neutral); },
      tick: function (dt) {
        var elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
        var duration = durationOf(selected);
        if (duration <= 0) { advance(elapsed); return; }
        var untilEnd = Math.max(0, duration - position);
        if (elapsed < untilEnd) { position += elapsed; advance(elapsed); return; }
        position = duration;
        advance(untilEnd);
        var from = sample();
        var remaining = elapsed - untilEnd;
        if (selected !== neutral) selected = neutral;
        var nextDuration = durationOf(selected);
        position = nextDuration > 0 ? remaining % nextDuration : 0;
        transition = { from: from, elapsed: 0 };
        advance(remaining);
      }
    };
  }

  /* ---------- 造型：脸型参数 ---------- */
  function defaultShape() {
    var out = {};
    SHAPE_DEFS.forEach(function (def) { out[def.key] = 50; });
    return out;
  }

  function cloneShape(source) {
    var out = {};
    SHAPE_DEFS.forEach(function (def) { out[def.key] = Number(source && source[def.key]); });
    return out;
  }

  function mergeShape(values) {
    var out = defaultShape();
    var data = values || {};
    /* NEUTRAL_KEYS 只用来「随机时不碰」，不能在这里把值压回 50：
     * 以前眼睛那四项被压回中性，用滑杆调完再读档就被吞了。 */
    SHAPE_DEFS.forEach(function (def) {
      var value = Number(data[def.key]);
      if (Number.isFinite(value)) out[def.key] = clamp(value, 0, 100);
    });
    return out;
  }

  function shapeEquals(a, b) {
    return SHAPE_DEFS.every(function (def) {
      return Math.round(Number(a[def.key])) === Math.round(Number(b[def.key]));
    });
  }

  function loadShape() {
    var raw = null;
    try { raw = localStorage.getItem(SHAPE_KEY); } catch (e) { raw = null; }
    if (!raw) return defaultShape();
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return defaultShape(); }
    if (!data || typeof data !== 'object') return defaultShape();
    return mergeShape(data);
  }

  function saveShape() {
    if (!S || !S.shape) return;
    try { localStorage.setItem(SHAPE_KEY, JSON.stringify(S.shape)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 曲面范围线圈：状态与持久化 ---------- */
  function defaultCoils() {
    var out = {};
    SHAPE_DEFS.forEach(function (def) { out[def.key] = DEFAULT_COILS[def.key].slice(); });
    return out;
  }

  function clampCoil(values) {
    var list = Array.isArray(values) ? values : [];
    var pick = function (value, range) {
      var num = Number(value);
      return clamp(Number.isFinite(num) ? num : range[0], range[0], range[1]);
    };
    return [
      pick(list[0], COIL_LIMIT.uc),
      pick(list[1], COIL_LIMIT.ur),
      pick(list[2], COIL_LIMIT.vc),
      pick(list[3], COIL_LIMIT.vr)
    ];
  }

  function loadCoils() {
    var state = { coils: defaultCoils(), on: true };
    var raw = null;
    try { raw = localStorage.getItem(COIL_KEY); } catch (e) { raw = null; }
    if (!raw) return state;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return state; }
    if (!data || typeof data !== 'object') return state;
    if (data.coils && typeof data.coils === 'object') {
      SHAPE_DEFS.forEach(function (def) {
        if (data.coils[def.key]) state.coils[def.key] = clampCoil(data.coils[def.key]);
      });
    }
    if (typeof data.on === 'boolean') state.on = data.on;
    return state;
  }

  function saveCoils() {
    if (!S || !S.coils) return;
    try {
      localStorage.setItem(COIL_KEY, JSON.stringify({ v: 1, on: S.coilOn !== false, coils: S.coils }));
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 面部轮廓：8 个节点的宽度倍率 ----------
   * 这里面只存倍率（1 = 原样），节点高度是常量 OUTLINE_KNOTS。
   * 它和 width / jaw / cheek / forehead 四个滑杆是「乘法叠加」关系，不是接管：
   * 滑杆管的是某一小块皮肤（带线圈权重、会衰减），轮廓线管的是整条脸缘，
   * 两者乘在一起。所以「滑杆调完再用轮廓线微调」是正常用法，不会互相抵消。 */
  function defaultOutline() {
    return OUTLINE_KNOTS.map(function () { return 1; });
  }

  function clampOutline(values) {
    var list = Array.isArray(values) ? values : [];
    return OUTLINE_KNOTS.map(function (t, i) {
      var raw = Number(list[i]);
      return Number.isFinite(raw) ? clamp(raw, OUTLINE_LIMIT[0], OUTLINE_LIMIT[1]) : 1;
    });
  }

  function loadOutline() {
    var raw = null;
    try { raw = localStorage.getItem(OUTLINE_KEY); } catch (e) { raw = null; }
    if (!raw) return defaultOutline();
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return defaultOutline(); }
    if (!Array.isArray(data)) return defaultOutline();
    return clampOutline(data);
  }

  function saveOutline() {
    if (!S || !S.outline) return;
    try { localStorage.setItem(OUTLINE_KEY, JSON.stringify(S.outline)); } catch (e) { /* 忽略 */ }
  }

  /* 唯一写入口：uniform、S.outline、图库曲线一起更新。
   * 拖节点时 persist 传 false（每帧都写 localStorage 太浪费），松手再落盘。 */
  function applyOutline(values, persist) {
    if (!S) return null;
    S.outline = clampOutline(values);
    if (S.face && S.face.setOutline) S.face.setOutline(S.outline);
    if (persist !== false) saveOutline();
    renderCurve();
    paintOutline();
    return S.outline;
  }

  /* ---------- 眼睛 / 嘴巴的 3D 变换：状态与持久化 ---------- */
  function defaultXform() {
    return { eye: XFORM_DEFAULT.slice(), mouth: XFORM_DEFAULT.slice() };
  }

  function readXformState(list) {
    var src = Array.isArray(list) ? list : [];
    var scale = Number(src[3]);
    return [
      Number(src[0]) || 0,
      Number(src[1]) || 0,
      Number(src[2]) || 0,
      Number.isFinite(scale) && scale > 0 ? scale : 1
    ];
  }

  function loadXform() {
    var state = defaultXform();
    var raw = null;
    try { raw = localStorage.getItem(XFORM_KEY); } catch (e) { raw = null; }
    if (!raw) return state;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return state; }
    if (!data || typeof data !== 'object') return state;
    state.eye = readXformState(data.eye);
    state.mouth = readXformState(data.mouth);
    return state;
  }

  function saveXform() {
    if (!S || !S.xform) return;
    try { localStorage.setItem(XFORM_KEY, JSON.stringify({ v: 1, eye: S.xform.eye, mouth: S.xform.mouth })); } catch (e) { /* 忽略 */ }
  }

  /* 自定义预设：名字 + 完整 16 项参数，最多存 20 个 */
  function loadCustomPresets() {
    var raw = null;
    try { raw = localStorage.getItem(SHAPE_PRESET_KEY); } catch (e) { raw = null; }
    if (!raw) return [];
    var list = null;
    try { list = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    return list.filter(function (item) {
      return item && typeof item.name === 'string' && item.name.length > 0 && item.values;
    }).slice(0, 20);
  }

  function saveCustomPresets(list) {
    try { localStorage.setItem(SHAPE_PRESET_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 历史（撤销 / 重做） ---------- */
  function paintShapeButtons() {
    if (!S || !S.refs) return;
    var hist = S.shapeHist;
    if (S.refs.shapeUndo) S.refs.shapeUndo.disabled = !hist || hist.index <= 0;
    if (S.refs.shapeRedo) S.refs.shapeRedo.disabled = !hist || hist.index >= hist.stack.length - 1;
  }

  /* 一帧历史 = 参数 + 轮廓。轮廓以前不在历史里，「拖完轮廓线按撤销」会把参数倒回去、
   * 轮廓却纹丝不动 —— 用户看到的是「撤销没生效」。 */
  function shapeStateOf() {
    return { shape: cloneShape(S.shape), outline: (S.outline || defaultOutline()).slice() };
  }

  function historyEquals(a, b) {
    if (!a || !b || !a.outline || !b.outline) return false;
    if (!shapeEquals(a.shape, b.shape)) return false;
    if (a.outline.length !== b.outline.length) return false;
    return a.outline.every(function (k, i) { return Math.abs(k - b.outline[i]) < 0.002; });
  }

  /* 每次参数落定后记一帧；重复状态自动跳过 */
  function commitShapeHistory() {
    if (!S || !S.shape) return;
    var hist = S.shapeHist;
    var top = hist.stack[hist.index];
    var snap = shapeStateOf();
    if (top && historyEquals(top, snap)) return;
    hist.stack = hist.stack.slice(0, hist.index + 1);
    hist.stack.push(snap);
    if (hist.stack.length > 40) hist.stack.shift();
    hist.index = hist.stack.length - 1;
    paintShapeButtons();
  }

  function applyShapeState(values, presetName) {
    /* 两种入参：{ shape, outline }（历史帧），或者一张纯参数表（预设 / 复原）。 */
    var packed = values && values.shape ? values : { shape: values };
    S.shape = mergeShape(packed.shape);
    SHAPE_DEFS.forEach(function (def) { paintShapeRow(def.key); });
    if (S.face) S.face.setShapeAll(S.shape);
    saveShape();
    /* 预设里没有轮廓数据，所以换预设 / 复原一律把轮廓放回原样：
     * 留着上一条脸的轮廓去套新预设，出来的脸既不像预设也不像上一条。 */
    applyOutline(packed.outline || defaultOutline(), true);
    if (arguments.length > 1) {
      S.presetName = presetName || '';
      paintPresetState();
    }
    paintShapeButtons();
    renderCurve();
  }

  function undoShape() {
    if (!S) return;
    var hist = S.shapeHist;
    if (hist.index <= 0) return;
    hist.index--;
    applyShapeState(hist.stack[hist.index], '');
  }

  function redoShape() {
    if (!S) return;
    var hist = S.shapeHist;
    if (hist.index >= hist.stack.length - 1) return;
    hist.index++;
    applyShapeState(hist.stack[hist.index], '');
  }

  /* ---------- 参数读写与联动 ---------- */
  function paintShapeRow(name) {
    if (!S || !S.refs || !S.refs.shapeList) return;
    var range = S.refs.shapeList.querySelector('[data-shape="' + name + '"]');
    if (!range) return;
    var value = Math.round(S.shape[name]);
    range.value = String(value);
    var num = S.refs.shapeList.querySelector('[data-shape-num="' + name + '"]');
    if (num) num.value = String(value);
  }

  function setShapeValue(name, value, fromUI) {
    if (!S || !S.shape || !(name in S.shape)) return null;
    S.shape[name] = clamp(Number(value), 0, 100);
    if (S.face) S.face.setShape(name, S.shape[name]);
    if (!fromUI) {
      paintShapeRow(name);
      commitShapeHistory();
    }
    if (S.presetName) {
      S.presetName = '';
      paintPresetState();
    }
    saveShape();
    renderCurve();
    return S.shape[name];
  }

  function resetShape() {
    if (!S) return;
    applyShapeState(defaultShape(), '原始');
    commitShapeHistory();
    resetCoil();
    resetXform();
  }

  function randomShape() {
    if (!S) return;
    var values = {};
    SHAPE_DEFS.forEach(function (def) {
      if (!NEUTRAL_KEYS[def.key]) values[def.key] = Math.round(rand(28, 72));
    });
    applyShapeState(values, '');
    commitShapeHistory();
  }

  function presetValues(name) {
    for (var i = 0; i < SHAPE_PRESETS.length; i++) {
      if (SHAPE_PRESETS[i].name === name) return mergeShape(SHAPE_PRESETS[i].values);
    }
    for (var k = 0; k < S.presets.length; k++) {
      if (S.presets[k].name === name) return mergeShape(S.presets[k].values);
    }
    return null;
  }

  function applyPreset(name) {
    if (!S) return null;
    var values = presetValues(name);
    if (!values) return null;
    applyShapeState(values, name);
    commitShapeHistory();
    return name;
  }

  function saveCurrentPreset() {
    if (!S || !S.refs || !S.refs.shapeSaveName) return null;
    var input = S.refs.shapeSaveName;
    var name = String(input.value || '').replace(/^\s+|\s+$/g, '').slice(0, 12);
    if (!name) return null;
    var reserved = SHAPE_PRESETS.some(function (item) { return item.name === name; });
    if (reserved) return null;
    var entry = { name: name, values: cloneShape(S.shape) };
    var replaced = false;
    S.presets = S.presets.map(function (item) {
      if (item.name === name) { replaced = true; return entry; }
      return item;
    });
    if (!replaced) S.presets.push(entry);
    S.presets = S.presets.slice(-20);
    saveCustomPresets(S.presets);
    input.value = '';
    if (S.refs.shapeSaveRow) S.refs.shapeSaveRow.hidden = true;
    renderShapePresets();
    S.presetName = name;
    paintPresetState();
    return name;
  }

  function deletePreset(name) {
    if (!S) return;
    S.presets = S.presets.filter(function (item) { return item.name !== name; });
    saveCustomPresets(S.presets);
    renderShapePresets();
    if (S.presetName === name) {
      S.presetName = '';
      paintPresetState();
    }
  }

  /* ---------- 预设条 ---------- */
  function paintPresetState() {
    if (!S || !S.refs || !S.refs.shapePresets) return;
    S.refs.shapePresets.querySelectorAll('[data-preset]').forEach(function (button) {
      button.classList.toggle('on', button.getAttribute('data-preset') === S.presetName);
    });
  }

  function renderShapePresets() {
    if (!S || !S.refs || !S.refs.shapePresets) return;
    var host = S.refs.shapePresets;
    host.innerHTML = '';
    SHAPE_PRESETS.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'l3-preset';
      button.setAttribute('data-preset', item.name);
      button.textContent = item.name;
      host.appendChild(button);
    });
    S.presets.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'l3-preset l3-preset-custom';
      button.setAttribute('data-preset', item.name);
      button.textContent = item.name;
      var del = document.createElement('span');
      del.className = 'l3-preset-del';
      del.setAttribute('data-del-preset', item.name);
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', '删除预设 ' + item.name);
      del.textContent = '×';
      button.appendChild(del);
      host.appendChild(button);
    });
    paintPresetState();
  }

  /* ---------- 脸型面板 ---------- */
  function buildShapePane() {
    if (!S || !S.refs || !S.refs.shapeList) return;
    var host = S.refs.shapeList;
    if (host.dataset.ready === '1') return;
    SLIDER_GROUPS.forEach(function (group) {
      /* NEUTRAL_KEYS 只管「随机时要不要参与」，不再拿来藏滑杆：
       * 眼睛那四项以前就是被它滤掉的，结果眼睛在抽屉里连个滑杆都没有。 */
      var defs = SHAPE_DEFS.filter(function (def) { return def.group === group; });
      if (!defs.length) return;
      var title = document.createElement('div');
      title.className = 'l3-shape-group';
      title.textContent = group;
      host.appendChild(title);
      defs.forEach(function (def) {
        var row = document.createElement('div');
        row.className = 'l3-shape-row';
        var name = document.createElement('span');
        name.className = 'l3-shape-name';
        name.textContent = def.label;
        name.title = '双击恢复 ' + def.label;
        var range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.value = String(Math.round(S.shape[def.key]));
        range.setAttribute('data-shape', def.key);
        range.title = '双击恢复';
        var num = document.createElement('input');
        num.type = 'number';
        num.className = 'l3-shape-val';
        num.min = '0';
        num.max = '100';
        num.step = '1';
        num.value = String(Math.round(S.shape[def.key]));
        num.setAttribute('data-shape-num', def.key);

        range.addEventListener('input', function () {
          setShapeValue(def.key, range.value, true);
          num.value = String(Math.round(S.shape[def.key]));
        });
        range.addEventListener('change', commitShapeHistory);
        function commitNumber() {
          if (!Number.isFinite(Number(num.value))) { paintShapeRow(def.key); return; }
          setShapeValue(def.key, num.value, true);
          paintShapeRow(def.key);
          commitShapeHistory();
        }
        num.addEventListener('change', commitNumber);
        function restoreOne() {
          setShapeValue(def.key, 50, true);
          paintShapeRow(def.key);
          commitShapeHistory();
        }
        name.addEventListener('dblclick', restoreOne);
        num.addEventListener('dblclick', restoreOne);

        row.appendChild(name);
        row.appendChild(range);
        row.appendChild(num);
        host.appendChild(row);
      });
    });
    /* 眼睛 / 嘴部已经交给脸上的三维手柄，这里说明一句，免得用户翻不到滑杆 */
    var note = document.createElement('p');
    note.className = 'l3-shape-note';
    note.textContent = '眼睛与嘴部不再用滑杆：切到上面「三维直接操控」的眼睛 / 嘴部分组，' +
      '在脸上的白色选区里直接移动、旋转、缩放。';
    host.appendChild(note);
    host.dataset.ready = '1';
  }

  /* ---------- 三维直接操控 ---------- */
  /* 脸上的手柄按分组显示，拖动直接改对应参数；悬停 / 拖动时用线圈染色显示曲面范围。 */
  function ensureGizmoLayer() {
    if (!S || !S.refs || !S.refs.canvasHost) return null;
    var layer = S.refs.canvasHost.querySelector('.l3-gizmos');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'l3-gizmos is-off';
      layer.id = 'l3Gizmos';
      S.refs.canvasHost.appendChild(layer);
    }
    return layer;
  }

  function gizmoDefs() {
    if (SLIDER_GROUPS.indexOf(S.gizmoGroup) < 0) return [];
    return SHAPE_DEFS.filter(function (def) { return def.group === S.gizmoGroup; });
  }

  /* 眼睛 / 嘴部两个分组走区域手柄，不再显示参数锚点 */
  function regionKindOf(group) {
    return group === '眼睛' ? 'eye' : (group === '嘴部' ? 'mouth' : null);
  }

  function gizmoVisible() {
    if (!S || !S.face || !S.gizmoOn || !S.refs || !S.refs.drawer) return false;
    return S.drawerTab === 'shape';
  }

  function coilOf(key) {
    if (!S || !S.coils) return null;
    return S.coils[key] || DEFAULT_COILS[key] || null;
  }

  /* 选区提示：轮廓 / 鼻子按参数线圈，眼睛 / 嘴部按固定区域；
   * 两者都不是画出来的曲线，而是把模型表面真正会被影响的三角面点亮。 */
  function syncGizmoHighlight(strength) {
    if (!S || !S.face) return;
    if (!gizmoVisible() || !S.coilOn) { S.face.setFaceHighlight(null, 0); return; }
    var value = strength;
    if (value === undefined) value = (S.coilDrag || S.regionDrag) ? 0.95 : 0.78;
    var kind = regionKindOf(S.gizmoGroup);
    if (kind) { S.face.setFaceHighlight({ region: kind }, value); return; }
    if (!S.gizmoKey) { S.face.setFaceHighlight(null, 0); return; }
    S.face.setFaceHighlight({ coil: coilOf(S.gizmoKey), key: S.gizmoKey }, value);
  }

  function paintGizmoSelection() {
    var layer = ensureGizmoLayer();
    if (!layer) return;
    layer.querySelectorAll('.l3-gizmo').forEach(function (handle) {
      handle.classList.toggle('on', handle.getAttribute('data-gizmo') === S.gizmoKey);
    });
  }

  function paintPull(layer, drag) {
    if (!layer) return;
    var line = layer.querySelector('.l3-pull');
    if (!drag) { if (line) line.style.display = 'none'; return; }
    if (!line) {
      line = document.createElement('i');
      line.className = 'l3-pull';
      layer.appendChild(line);
    }
    var handle = layer.querySelector('.l3-gizmo.is-dragging');
    if (!handle) { line.style.display = 'none'; return; }
    var x1 = drag.restX, y1 = drag.restY;
    var x2 = parseFloat(handle.style.left) || x1;
    var y2 = parseFloat(handle.style.top) || y1;
    var len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 3) { line.style.display = 'none'; return; }
    line.style.display = '';
    line.style.left = x1.toFixed(1) + 'px';
    line.style.top = y1.toFixed(1) + 'px';
    line.style.width = len.toFixed(1) + 'px';
    line.style.transform = 'rotate(' + Math.atan2(y2 - y1, x2 - x1).toFixed(4) + 'rad)';
  }

  function paintGizmos() {
    if (!S || !S.face || !gizmoVisible()) { hideCoil(); hideRegion(); hideOutline(); return; }
    var kind = regionKindOf(S.gizmoGroup);
    var layer = ensureGizmoLayer();
    if (kind) {
      if (layer) layer.classList.add('is-off');
      hideCoil();
      hideOutline();
      paintRegion(kind);
      return;
    }
    hideRegion();
    if (!layer) return;
    layer.classList.remove('is-off');
    var drag = S.gizmoDrag;
    layer.querySelectorAll('.l3-gizmo').forEach(function (handle) {
      var key = handle.getAttribute('data-gizmo');
      var pos = S.face.projectAnchor(key);
      if (!pos || !pos.visible) {
        handle.style.display = 'none';
        return;
      }
      handle.style.display = '';
      /* 拖动中让手柄贴在指针上：位置 = 静止锚点 + 已产生的位移 */
      var ox = 0, oy = 0;
      if (drag && drag.key === key) { ox = drag.ox; oy = drag.oy; }
      handle.style.left = (pos.x + ox).toFixed(1) + 'px';
      handle.style.top = (pos.y + oy).toFixed(1) + 'px';
    });
    paintPull(layer, drag);
    paintCoil();
    paintOutline();
  }

  /* ---------- 选区：模型表面的面高亮 ----------
   * 以前这里的选区是屏幕上投出来的一圈贴脸椭圆（填充 + 呼吸 + 流动虚线），
   * 看着像浮在脸前的一张半透明纸，跟网格没关系；现在这些全删掉，
   * 选区由 3D 里的叠加网格把真实三角面点亮（见 createFace 的 setFaceHighlight），
   * 这里只留几个小手柄用来改范围：中心移动、四边缩放。
   *
   * ⚠ 这些手柄只管「影响范围」，不管形状：形状照样由滑杆 / 抓手决定。
   * 线圈是按 |u| 镜像求值的，所以 uc 只能 ≥ 0；范围越铺越宽时手柄会被钳在
   * 脸的轮廓或中线上 —— 那种手柄怎么拖都不会动，属于死区，必须藏起来，
   * 否则用户抓到它的第一反应就是「这个控制坏了」（见 coilPinnedEdges）。 */
  var COIL_EDGE_ROLE = ['right', 'left', 'top', 'bottom'];
  /* 范围铺到多宽时中心就不能再横移（uc 会被钳在 0） */
  var COIL_SLIDE_MAX = 0.95;

  function ensureCoilLayer() {
    if (!S || !S.refs || !S.refs.canvasHost) return null;
    var layer = S.refs.canvasHost.querySelector('.l3-coil');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'l3-coil is-off';
    layer.id = 'l3Coil';
    layer.innerHTML =
      '<button type="button" class="l3-coil-handle is-center" data-coil-edge="center" data-axis="both" ' +
        'data-tip="影响范围 · 拖动移位，双击复位" ' +
        'aria-label="拖动移动影响范围，双击复位"><span></span></button>' +
      COIL_EDGE_ROLE.map(function (role) {
        var axis = role === 'top' || role === 'bottom' ? 'v' : 'h';
        var tip = axis === 'v' ? '上下拖动缩放范围' : '左右拖动缩放范围';
        return '<button type="button" class="l3-coil-handle is-edge" data-coil-edge="' + role +
          '" data-axis="' + axis + '" data-tip="' + tip +
          '" aria-label="拖动缩放影响范围"><span></span></button>';
      }).join('');
    S.refs.canvasHost.appendChild(layer);
    layer.querySelectorAll('[data-coil-edge]').forEach(function (handle) {
      handle.addEventListener('pointerdown', function (event) {
        startCoilDrag(event, handle.getAttribute('data-coil-edge'));
      });
      if (handle.getAttribute('data-coil-edge') === 'center') {
        handle.addEventListener('dblclick', function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (S && S.gizmoKey) resetCoil(S.gizmoKey);
        });
      }
    });
    return layer;
  }

  function hideCoil() {
    if (!S || !S.refs || !S.refs.canvasHost) return;
    var layer = S.refs.canvasHost.querySelector('.l3-coil');
    if (layer) layer.classList.add('is-off');
  }

  /* 哪些边被钳死在脸上（拖了也不会动）：u/v 都会被 clamp 到 [-1,1] / [0,1]，
   * 顶到边界的那条边就算继续拖也只是数字在变，手柄和覆层都不动 —— 死区。 */
  function coilPinnedEdges(coil) {
    var uc = Number(coil[0]) || 0, ur = Number(coil[1]) || 0;
    var vc = Number(coil[2]) || 0, vr = Number(coil[3]) || 0;
    return {
      right: uc + ur >= 1 - 1e-4,
      left: uc - ur <= 1e-4,
      top: vc + vr >= 1 - 1e-4,
      bottom: vc - vr <= 1e-4
    };
  }

  function paintCoil() {
    if (!S || !S.face || !S.coilOn || !S.gizmoKey || !gizmoVisible()) { hideCoil(); return; }
    if (regionKindOf(S.gizmoGroup)) { hideCoil(); return; }
    var layer = ensureCoilLayer();
    if (!layer) return;
    var data = S.face.projectCoil(S.gizmoKey);
    if (!data) { layer.classList.add('is-off'); return; }
    layer.classList.remove('is-off');
    var coil = coilOf(S.gizmoKey) || [0, 0, 0, 0];
    var pinned = coilPinnedEdges(coil);
    var canSlide = Number(coil[1]) < COIL_SLIDE_MAX;
    /* 只摆手柄：范围本身已经由模型上的面高亮画出来了 */
    layer.querySelectorAll('[data-coil-edge]').forEach(function (handle) {
      var role = handle.getAttribute('data-coil-edge');
      var pos = role === 'center' ? data.center : data.edges[role];
      /* 钳死在轮廓 / 中线上的边不摆出来：它拖不动，摆着只会被当成坏了 */
      if (!pos || !pos.visible || pinned[role]) { handle.style.display = 'none'; return; }
      handle.style.display = '';
      handle.style.left = pos.x.toFixed(1) + 'px';
      handle.style.top = pos.y.toFixed(1) + 'px';
      if (role === 'center') {
        /* 范围已经铺满整个宽度时 uc 被钳在 0，横拖是死区：光标与提示改成「只能上下」 */
        handle.setAttribute('data-axis', canSlide ? 'both' : 'v');
        handle.setAttribute('data-tip', canSlide
          ? '影响范围 · 拖动移位，双击复位'
          : '影响范围 · 只能上下移动，双击复位');
      }
    });
  }

  /* ---------- 面部轮廓线：直接拖脸缘 ----------
   * 8 个节点 × 左右两侧，落在 u=±1 的真实脸缘上（不是参数锚点）。
   * 拖哪个方向就按「中线 → 脸缘」那条线段的比例改宽度倍率，
   * 松手落盘 + 记一帧历史；双击单个节点复位。
   * 只在「轮廓」分组下出现：眼睛 / 嘴部有自己的区域手柄，混在一起会互相抢指针。 */
  /* 两侧按「u 的符号」命名，不按屏幕左右：相机在 -z 看 +z，世界 +x 落在屏幕**左**边
   * （同一个约定见 startCoilDrag：「屏幕右移对应 u 减小」）。用屏幕方位命名的话，
   * 用户把模型转半圈，代码里的 right 就跑到左边去了。 */
  var OUTLINE_SIDES = ['pos', 'neg'];

  function outlineShown() {
    if (!S || !S.face || !S.face.projectOutline) return false;
    if (S.outlineOn === false) return false;
    if (S.gizmoGroup !== '轮廓') return false;
    return gizmoVisible();
  }

  function ensureOutlineLayer() {
    if (!S || !S.refs || !S.refs.canvasHost) return null;
    var layer = S.refs.canvasHost.querySelector('.l3-outline');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'l3-outline is-off';
    layer.id = 'l3Outline';
    layer.innerHTML = OUTLINE_KNOTS.map(function (t, index) {
      return OUTLINE_SIDES.map(function (side) {
        /* 复用线圈手柄的视觉（同一个 is-edge 小圆点），免得画布上出现第三套手柄外观 */
        return '<button type="button" class="l3-coil-handle is-edge l3-out-handle" data-axis="h"' +
          ' data-out-index="' + index + '" data-out-side="' + side + '"' +
          ' data-tip="左右拖动改脸缘宽窄，双击复位">' +
          '<i class="l3-out-tag">×1.00</i></button>';
      }).join('');
    }).join('');
    S.refs.canvasHost.appendChild(layer);
    layer.querySelectorAll('[data-out-index]').forEach(function (handle) {
      handle.addEventListener('pointerdown', function (event) {
        startOutlineDrag(event,
          Number(handle.getAttribute('data-out-index')),
          handle.getAttribute('data-out-side'));
      });
      handle.addEventListener('dblclick', function (event) {
        event.preventDefault();
        event.stopPropagation();
        resetOutlineKnot(Number(handle.getAttribute('data-out-index')));
      });
    });
    return layer;
  }

  function hideOutline() {
    if (!S || !S.refs || !S.refs.canvasHost) return;
    var layer = S.refs.canvasHost.querySelector('.l3-outline');
    if (layer) layer.classList.add('is-off');
  }

  function paintOutline() {
    if (!outlineShown()) { hideOutline(); return; }
    var layer = ensureOutlineLayer();
    if (!layer) return;
    var data = S.face.projectOutline();
    if (!data || !data.length) { layer.classList.add('is-off'); return; }
    layer.classList.remove('is-off');
    var byIndex = Object.create(null);
    data.forEach(function (item) { byIndex[item.index] = item; });
    layer.querySelectorAll('[data-out-index]').forEach(function (handle) {
      var item = byIndex[handle.getAttribute('data-out-index')];
      var far = !item ? null : (handle.getAttribute('data-out-side') === 'neg' ? item.edgeL : item.edge);
      if (!far || !far.visible || !item.center.visible) {
        handle.style.display = 'none';
        return;
      }
      handle.style.display = '';
      /* 位置直接取 projectOutline 给的脸缘点：它已经按「加位移」公式算好了，
       * 界面再乘一次倍率就会和脸上的形变对不上 */
      handle.style.left = far.x.toFixed(1) + 'px';
      handle.style.top = far.y.toFixed(1) + 'px';
      handle.classList.toggle('is-changed', Math.abs(item.k - 1) >= 0.02);
      handle.setAttribute('data-out-k', item.k.toFixed(3));
      var tag = handle.querySelector('.l3-out-tag');
      if (tag) tag.textContent = '×' + item.k.toFixed(2);
    });
  }

  function resetOutlineKnot(index) {
    if (!S || !S.outline) return;
    var next = S.outline.slice();
    next[index] = 1;
    applyOutline(next, true);
    commitShapeHistory();
  }

  function setOutlineOn(on) {
    if (!S) return;
    S.outlineOn = !!on;
    if (S.refs && S.refs.outlineOn) S.refs.outlineOn.checked = S.outlineOn;
    paintOutline();
  }

  function startOutlineDrag(event, index, side) {
    if (!S || !S.face || !S.face.projectOutline) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    var handle = event.currentTarget;
    var item = null;
    S.face.projectOutline().forEach(function (row) { if (row.index === index) item = row; });
    if (!item) return;
    var rest = side === 'neg' ? item.baseL : item.base;
    if (!rest) return;
    /* 基准长度取「倍率 1 的脸缘」（base）到中线的屏幕距离：形变是加位移，
     * 每 +1 的倍率正好把脸缘推出去这么远，所以位移 / 基准 = Δk。
     * 用当前脸缘（edge）当基准的话，拖到一半基准会跟着变长，越拖越钝。 */
    var ax = rest.x - item.center.x, ay = rest.y - item.center.y;
    var len = Math.sqrt(ax * ax + ay * ay);
    if (len < 6) return;
    var start = (S.outline || defaultOutline()).slice();
    var drag = {
      index: index, side: side, x: event.clientX, y: event.clientY,
      start: start, base: start[index],
      dirX: ax / len, dirY: ay / len, len: len
    };
    S.outlineDrag = drag;
    handle.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }

    function move(ev) {
      if (!S || S.outlineDrag !== drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      /* 只认沿这条线的分量：斜着拖不会把倍率带偏 */
      var along = dx * drag.dirX + dy * drag.dirY;
      var next = drag.start.slice();
      next[drag.index] = drag.base + along / drag.len;
      applyOutline(next, false);
    }
    function end() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      if (!S) return;
      S.outlineDrag = null;
      saveOutline();
      commitShapeHistory();
      paintOutline();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    paintOutline();
  }

  /* ---------- 眼睛 / 嘴巴：面高亮 + 移动 / 旋转 / 缩放手柄 ----------
   * 眼睛不再走线性滑杆，改成每只眼一片会被一起带动的面（不跨鼻梁、不被中线切开），
   * 面上挂三个手柄：中心移动、外侧缩放、上方旋转；嘴巴同一套。
   * 选区本身由面高亮给出，这里只负责手柄。 */
  var REGION_HANDLES = ['center', 'scale', 'rotate'];

  function ensureRegionLayer() {
    if (!S || !S.refs || !S.refs.canvasHost) return null;
    var layer = S.refs.canvasHost.querySelector('.l3-region');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'l3-region is-off';
    layer.id = 'l3Region';
    S.refs.canvasHost.appendChild(layer);
    return layer;
  }

  function hideRegion() {
    if (!S || !S.refs || !S.refs.canvasHost) return;
    var layer = S.refs.canvasHost.querySelector('.l3-region');
    if (layer) layer.classList.add('is-off');
  }

  function paintRegion(kind) {
    if (!S || !S.face || !gizmoVisible()) { hideRegion(); return; }
    var layer = ensureRegionLayer();
    if (!layer || !S.face.projectRegion) return;
    var data = S.face.projectRegion(kind);
    if (!data) { layer.classList.add('is-off'); return; }
    layer.classList.remove('is-off');
    var items = data.items;
    var count = items.length * REGION_HANDLES.length;
    if (Number(layer.dataset.count) !== count || layer.dataset.kind !== kind) {
      layer.dataset.count = String(count);
      layer.dataset.kind = kind;
      layer.querySelectorAll('.l3-region-handle').forEach(function (n) { n.remove(); });
      items.forEach(function (item) {
        REGION_HANDLES.forEach(function (role) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'l3-region-handle is-' + role;
          button.setAttribute('data-region-role', role);
          button.setAttribute('data-side', String(item.side));
          button.title = role === 'center' ? '拖动移动（双击复位）' : (role === 'scale' ? '拖动缩放' : '拖动旋转');
          button.setAttribute('aria-label', button.title);
          button.addEventListener('pointerdown', function (event) {
            startRegionDrag(event, kind, role, item.side);
          });
          if (role === 'center') {
            button.addEventListener('dblclick', function (event) {
              event.preventDefault();
              event.stopPropagation();
              resetXform(kind);
            });
          }
          layer.appendChild(button);
        });
      });
    }
    var buttons = layer.querySelectorAll('.l3-region-handle');
    var cursor = 0;
    items.forEach(function (item) {
      REGION_HANDLES.forEach(function (role) {
        var button = buttons[cursor++];
        if (!button) return;
        var pos = item[role];
        if (!pos || !pos.visible) { button.style.display = 'none'; return; }
        button.style.display = '';
        button.style.left = pos.x.toFixed(1) + 'px';
        button.style.top = pos.y.toFixed(1) + 'px';
        var drag = S.regionDrag;
        button.classList.toggle('is-dragging', !!(drag && drag.kind === kind &&
          drag.side === item.side && drag.role === role));
      });
    });
  }

  function xformLimit(kind, list) {
    var lim = XFORM_LIMIT[kind];
    if (!lim) return XFORM_DEFAULT.slice();
    return [
      clamp(Number(list[0]) || 0, -lim.tx, lim.tx),
      clamp(Number(list[1]) || 0, -lim.ty, lim.ty),
      clamp(Number(list[2]) || 0, -lim.rot, lim.rot),
      clamp(Number(list[3]) || 1, lim.scale[0], lim.scale[1])
    ];
  }

  function applyXform(kind, values, persist) {
    if (!S || !S.xform || !S.xform[kind]) return null;
    var next = xformLimit(kind, values);
    S.xform[kind] = next;
    if (S.face) {
      var payload = {};
      payload[kind] = next;
      S.face.setXform(payload);
    }
    if (persist !== false) saveXform();
    if (gizmoVisible()) paintRegion(kind);
    return next;
  }

  function resetXform(kind) {
    if (!S) return;
    if (kind) {
      applyXform(kind, XFORM_DEFAULT.slice(), true);
    } else {
      applyXform('eye', XFORM_DEFAULT.slice(), false);
      applyXform('mouth', XFORM_DEFAULT.slice(), false);
      saveXform();
    }
  }

  function startRegionDrag(event, kind, role, side) {
    if (!S || !S.face || !gizmoVisible()) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    var data = S.face.projectRegion(kind);
    if (!data) return;
    var item = null;
    data.items.forEach(function (it) { if (it.side === side) item = it; });
    if (!item) item = data.items[0];
    /* 手柄坐标是相对画布的，指针是视口坐标：先换算到同一坐标系，否则旋转 / 缩放的半径全错 */
    var rect = S.refs.canvasHost.getBoundingClientRect();
    function local(ev) {
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }
    var at = local(event);
    var center = item.center || { x: 0, y: 0 };
    var start = S.xform[kind].slice();
    var drag = {
      kind: kind,
      role: role,
      side: side,
      x: at.x,
      y: at.y,
      start: start,
      center: center,
      gain: item.gain,
      dist: Math.max(1, Math.hypot(at.x - center.x, at.y - center.y)),
      angle: Math.atan2(-(at.y - center.y), at.x - center.x)
    };
    S.regionDrag = drag;
    var handle = event.currentTarget;
    handle.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
    syncGizmoHighlight();

    function move(ev) {
      if (!S || S.regionDrag !== drag) return;
      var here = local(ev);
      var next = drag.start.slice();
      if (role === 'center') {
        /* 2×2 雅可比求逆：屏幕位移 → tx / ty，手柄因此紧贴指针 */
        var dx = here.x - drag.x;
        var dy = here.y - drag.y;
        var gx = drag.gain.tx, gy = drag.gain.ty;
        var det = gx[0] * gy[1] - gy[0] * gx[1];
        if (Math.abs(det) > 1e-6) {
          next[0] = drag.start[0] + (dx * gy[1] - gy[0] * dy) / det;
          next[1] = drag.start[1] + (gx[0] * dy - dx * gx[1]) / det;
        }
      } else if (role === 'scale') {
        var dist = Math.hypot(here.x - drag.center.x, here.y - drag.center.y);
        next[3] = drag.start[3] * (dist / drag.dist);
      } else {
        var ang = Math.atan2(-(here.y - drag.center.y), here.x - drag.center.x);
        var delta = ang - drag.angle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        /* 屏幕 x 与模型 x 反向（正对镜头），所以屏幕上的顺时针就是模型里的正角度；
         * 眼睛左右镜像：两只眼共用一份参数，拖左眼时取反才会同步外翻。 */
        next[2] = drag.start[2] - delta * (kind === 'eye' ? side : 1);
      }
      applyXform(kind, next, false);
    }
    function end() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      if (S) {
        S.regionDrag = null;
        saveXform();
        paintRegion(kind);
        syncGizmoHighlight();
      }
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    paintRegion(kind);
  }

  /* 写线圈：uniform、面高亮范围、localStorage 一起更新 */
  function applyCoil(key, values, persist) {
    if (!S || !S.coils || !(key in S.coils)) return null;
    var next = clampCoil(values);
    S.coils[key] = next;
    if (S.face) {
      var payload = {};
      payload[key] = next;
      S.face.setCoils(payload);
      /* 范围一变，亮起来的面片跟着重算：拖手柄时看到的就是最新范围 */
      if (S.gizmoKey === key) syncGizmoHighlight();
    }
    if (persist !== false) saveCoils();
    paintCoil();
    return next;
  }

  function resetCoil(key) {
    if (!S) return;
    if (key) {
      applyCoil(key, DEFAULT_COILS[key], true);
    } else {
      Object.keys(DEFAULT_COILS).forEach(function (name) { applyCoil(name, DEFAULT_COILS[name], false); });
      saveCoils();
    }
    syncGizmoHighlight();
    paintCoil();
  }

  function setCoilOn(on) {
    if (!S) return;
    S.coilOn = !!on;
    if (S.refs && S.refs.coilOn) S.refs.coilOn.checked = S.coilOn;
    saveCoils();
    syncGizmoHighlight();
    if (gizmoVisible()) paintGizmos();
    else { hideCoil(); hideRegion(); }
  }

  function startCoilDrag(event, role) {
    if (!S || !S.face || !S.gizmoKey) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    var key = S.gizmoKey;
    var start = coilOf(key).slice();
    /* 钳死在轮廓 / 中线上的边不接拖拽：拖了也不会动，别让它吃掉指针 */
    if (role !== 'center' && coilPinnedEdges(start)[role]) return;
    var handle = event.currentTarget;
    var layer = ensureCoilLayer();
    var centerHandle = layer.querySelector('[data-coil-edge="center"]');
    var centerX = parseFloat(centerHandle && centerHandle.style.left) || 0;
    var centerY = parseFloat(centerHandle && centerHandle.style.top) || 0;
    var dirX = (parseFloat(handle.style.left) || 0) - centerX;
    var dirY = (parseFloat(handle.style.top) || 0) - centerY;
    var dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    dirX /= dirLen;
    dirY /= dirLen;
    var drag = {
      key: key, role: role, x: event.clientX, y: event.clientY,
      start: start, dirX: dirX, dirY: dirY
    };
    S.coilDrag = drag;
    handle.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
    syncGizmoHighlight(0.95);

    function move(ev) {
      if (!S || S.coilDrag !== drag) return;
      var dx = ev.clientX - drag.x;
      var dy = ev.clientY - drag.y;
      var next = drag.start.slice();
      if (role === 'center') {
        /* 相机在 -z 看向 +z：屏幕右移对应 u 减小，下移对应 v 减小 */
        next[0] = drag.start[0] - dx * 0.0040;
        next[2] = drag.start[2] - dy * 0.0040;
      } else {
        var along = dx * drag.dirX + dy * drag.dirY;
        if (role === 'top' || role === 'bottom') next[3] = drag.start[3] + along * 0.0032;
        else next[1] = drag.start[1] + along * 0.0042;
      }
      applyCoil(drag.key, next, false);
    }
    function end() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      if (S) {
        S.coilDrag = null;
        saveCoils();
        syncGizmoHighlight();
        paintCoil();
      }
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function startGizmoDrag(event, def) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    var handle = event.currentTarget;
    var rest = S.face && S.face.projectAnchor ? S.face.projectAnchor(def.key) : null;
    var drag = {
      key: def.key,
      x: event.clientX,
      y: event.clientY,
      start: Number(S.shape[def.key]),
      /* 该参数 +1 时锚点在屏幕上的位移方向；沿它拖 = 顺着力的方向捏，反向 = 往回推 */
      gain: S.face && S.face.gizmoGain ? S.face.gizmoGain(def.key) : [0, 0],
      restX: rest ? rest.x : event.clientX,
      restY: rest ? rest.y : event.clientY,
      ox: 0,
      oy: 0
    };
    S.gizmoKey = def.key;
    S.gizmoDrag = drag;
    handle.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }

    function move(ev) {
      if (!S || S.gizmoDrag !== drag) return;
      var dx = ev.clientX - drag.x;
      var dy = ev.clientY - drag.y;
      var gx = drag.gain[0], gy = drag.gain[1];
      var denom = gx * gx + gy * gy;
      var units, alongX = 0, alongY = 0;
      if (denom > 1e-3) {
        /* 把指针位移投影到变形方向：顺着力的方向拖才放大，反向就缩小 */
        units = (dx * gx + dy * gy) / denom;
        alongX = gx * units;
        alongY = gy * units;
      } else {
        units = (dx - dy) * 0.6;
        alongX = dx;
        alongY = dy;
      }
      /* 垂直于变形方向的余量只做三成橡皮跟随：手感像抓住皮肤被拽，
       * 但真正写进参数的只有沿力方向的那一段，不会被横着拖乱。 */
      var rx = dx - alongX;
      var ry = dy - alongY;
      drag.ox = alongX + rx * 0.30;
      drag.oy = alongY + ry * 0.30;
      setShapeValue(drag.key, drag.start + units, true);
      paintShapeRow(drag.key);
      paintGizmos();
    }
    function end() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      if (S) {
        S.gizmoDrag = null;
        commitShapeHistory();
        syncGizmoHighlight();
        paintGizmos();
      }
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    paintGizmoSelection();
    syncGizmoHighlight(0.85);
    paintGizmos();
  }

  function renderGizmos() {
    var layer = ensureGizmoLayer();
    if (!layer) return;
    layer.innerHTML = '';
    gizmoDefs().forEach(function (def) {
      var handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'l3-gizmo';
      handle.setAttribute('data-gizmo', def.key);
      handle.setAttribute('aria-label', '在脸上拖动调整' + def.label);
      handle.title = def.label + ' · 拖动即可修改';
      var dot = document.createElement('span');
      dot.className = 'l3-gizmo-dot';
      var tag = document.createElement('span');
      tag.className = 'l3-gizmo-tag';
      tag.textContent = def.label;
      handle.appendChild(dot);
      handle.appendChild(tag);
      handle.addEventListener('pointerenter', function () {
        S.gizmoKey = def.key;
        paintGizmoSelection();
        if (!S.gizmoDrag) syncGizmoHighlight(0.5);
      });
      handle.addEventListener('pointerleave', function () {
        if (!S.gizmoDrag) syncGizmoHighlight();
      });
      handle.addEventListener('pointerdown', function (event) { startGizmoDrag(event, def); });
      layer.appendChild(handle);
    });
    paintGizmoSelection();
    paintGizmos();
  }

  function updateSculptHint() {
    if (!S || !S.refs || !S.refs.sculptHint) return;
    var kind = regionKindOf(S.gizmoGroup);
    if (kind === 'eye') {
      S.refs.sculptHint.textContent = '眼睛：模型表面亮起来的这片覆层就是会一起动的范围；拖中心移动、拖外侧圆点缩放、拖上方圆点旋转，双击中心复位。';
    } else if (kind === 'mouth') {
      S.refs.sculptHint.textContent = '嘴巴：模型表面亮起来的这片覆层就是会一起动的范围；拖中心移动、拖外侧圆点缩放、拖上方圆点旋转，双击中心复位。';
    } else {
      S.refs.sculptHint.textContent = '脸上的圆点＝参数（往外拉变大、往里推变小）；亮起来的覆层＝它真正影响到的范围。'
        + '脸缘那一圈小点＝轮廓线：左右拖动直接改这一层的脸宽，双击单个点复位；它和脸宽 / 下颌 / 颧骨 / 额头四个滑杆是叠加关系，'
        + '换预设或复原会把轮廓一起清回原样。';
    }
  }

  function setGizmoGroup(name) {
    if (!S) return;
    S.gizmoGroup = SHAPE_GROUPS.indexOf(name) >= 0 ? name : SHAPE_GROUPS[0];
    S.regionDrag = null;
    var first = gizmoDefs()[0];
    S.gizmoKey = first ? first.key : null;
    if (S.refs.gizmoGroups) {
      S.refs.gizmoGroups.querySelectorAll('[data-gizmo-group]').forEach(function (chip) {
        chip.classList.toggle('on', chip.getAttribute('data-gizmo-group') === S.gizmoGroup);
      });
    }
    updateSculptHint();
    renderGizmos();
    syncGizmoHighlight();
  }

  function setGizmoOn(on) {
    if (!S) return;
    S.gizmoOn = !!on;
    if (S.refs.gizmoOn) S.refs.gizmoOn.checked = S.gizmoOn;
    updateGizmoVisibility();
  }

  function updateGizmoVisibility() {
    var layer = ensureGizmoLayer();
    if (!layer) return;
    var on = gizmoVisible();
    if (!on) {
      layer.classList.add('is-off');
      hideCoil();
      hideRegion();
      hideOutline();
      syncGizmoHighlight();
      return;
    }
    if (regionKindOf(S.gizmoGroup)) {
      paintGizmos();
    } else {
      layer.classList.remove('is-off');
      if (!layer.querySelector('.l3-gizmo')) renderGizmos();
      else paintGizmos();
    }
    syncGizmoHighlight();
  }

  /* ---------- 轮廓曲线：拖控制点改脸宽 / 下颌 / 颧骨 / 额头 ---------- */
  var CURVE_CTRL = [
    { key: 'jaw', t: 0.14 },
    { key: 'cheek', t: 0.30 },
    { key: 'width', t: 0.45 },
    { key: 'forehead', t: 0.72 }
  ];
  var CURVE_BASE = [
    [0.00, 0.33], [0.06, 0.42], [0.14, 0.60], [0.22, 0.74], [0.29, 0.93], [0.36, 1.00],
    [0.45, 0.89], [0.55, 0.92], [0.62, 0.90], [0.72, 0.79], [0.82, 0.73], [0.90, 0.71], [1.00, 0.60]
  ];

  function segValue(t, a, b, va, vb) {
    var k = clamp((t - a) / Math.max(b - a, 1e-5), 0, 1);
    return va + (vb - va) * k;
  }

  function smooth01(a, b, x) {
    var k = clamp((x - a) / (b - a), 0, 1);
    return k * k * (3 - 2 * k);
  }

  /* 与 shader 的 l3V 同分段，曲线坐标要用同一套锚点 */
  function gizmoV(t) {
    var v = segValue(t, 0.000, 0.120, 0.00, 0.30);
    if (t >= 0.120) v = segValue(t, 0.120, 0.215, 0.30, 0.55);
    if (t >= 0.215) v = segValue(t, 0.215, 0.290, 0.55, 0.66);
    if (t >= 0.290) v = segValue(t, 0.290, 0.450, 0.66, 0.80);
    if (t >= 0.450) v = segValue(t, 0.450, 0.600, 0.80, 0.90);
    if (t >= 0.600) v = segValue(t, 0.600, 0.800, 0.90, 0.97);
    if (t >= 0.800) v = segValue(t, 0.800, 1.000, 0.97, 1.00);
    return v;
  }

  /* 与 shader 的 l3HalfW 同表，线圈采样需要把顶点换算回 u */
  function gizmoHalfW(t) {
    var w = segValue(t, 0.000, 0.040, 0.015, 0.030);
    if (t >= 0.040) w = segValue(t, 0.040, 0.080, 0.030, 0.042);
    if (t >= 0.080) w = segValue(t, 0.080, 0.120, 0.042, 0.050);
    if (t >= 0.120) w = segValue(t, 0.120, 0.160, 0.050, 0.056);
    if (t >= 0.160) w = segValue(t, 0.160, 0.200, 0.056, 0.070);
    if (t >= 0.200) w = segValue(t, 0.200, 0.250, 0.070, 0.074);
    if (t >= 0.250) w = segValue(t, 0.250, 0.290, 0.074, 0.080);
    if (t >= 0.290) w = segValue(t, 0.290, 0.350, 0.080, 0.081);
    if (t >= 0.350) w = segValue(t, 0.350, 0.450, 0.081, 0.072);
    if (t >= 0.450) w = segValue(t, 0.450, 0.600, 0.072, 0.077);
    if (t >= 0.600) w = segValue(t, 0.600, 0.750, 0.077, 0.061);
    if (t >= 0.750) w = segValue(t, 0.750, 0.900, 0.061, 0.058);
    if (t >= 0.900) w = segValue(t, 0.900, 1.000, 0.058, 0.050);
    return w;
  }

  /* 与 shader 的 l3Coil 同公式，供轮廓曲线取某一点的范围权重 */
  function coilAt(key, u, v) {
    var c = S && S.coils ? S.coils[key] : DEFAULT_COILS[key];
    if (!c) return 0;
    var du = (Math.abs(u) - c[0]) / Math.max(c[1], 1e-4);
    var dv = (v - c[2]) / Math.max(c[3], 1e-4);
    return 1 - smooth01(0.15, 1.10, du * du + dv * dv);
  }

  function curveBase(t) {
    for (var i = 1; i < CURVE_BASE.length; i++) {
      if (t <= CURVE_BASE[i][0]) {
        return segValue(t, CURVE_BASE[i - 1][0], CURVE_BASE[i][0], CURVE_BASE[i - 1][1], CURVE_BASE[i][1]);
      }
    }
    return CURVE_BASE[CURVE_BASE.length - 1][1];
  }

  function curveHalf(t) {
    var shape = S.shape || defaultShape();
    var v = gizmoV(t);
    var w = curveBase(t);
    /* 轮廓曲线取脸缘（|u| = 1），与 shader 里的线圈权重保持一致 */
    w *= 1 + (shape.width - 50) / 50 * 0.24 * coilAt('width', 1, v);
    w *= 1 - (shape.jaw - 50) / 50 * 0.18 * coilAt('jaw', 1, v);
    w *= 1 + (shape.cheek - 50) / 50 * 0.11 * coilAt('cheek', 1, v);
    w *= 1 + (shape.forehead - 50) / 50 * 0.16 * coilAt('forehead', 1, v);
    /* 轮廓线是直接乘在脸缘 x 上的，二维曲线必须跟着乘同一条曲线，
     * 否则「曲线画在 A、脸在 B」——这正是用户看不见效果的原因之一。 */
    if (S.face && S.face.outlineAt) w *= S.face.outlineAt(t);
    return w;
  }

  function curveHalfPx(t) { return 16 + curveHalf(t) * 44; }

  function renderCurve() {
    var svg = S && S.refs && S.refs.curveSvg;
    if (!svg) return;
    var right = [], left = [];
    for (var i = 0; i <= 24; i++) {
      var t = i / 24;
      var half = curveHalfPx(t);
      var y = 124 - t * 108;
      right.push((120 + half).toFixed(1) + ',' + y.toFixed(1));
      left.unshift((120 - half).toFixed(1) + ',' + y.toFixed(1));
    }
    var d = 'M120,124 L' + right.join(' L') + ' L120,16 L' + left.join(' L') + ' Z';
    var html = '<path class="l3-curve-face" d="' + d + '"></path>' +
      '<line class="l3-curve-axis" x1="120" y1="14" x2="120" y2="126"></line>';
    CURVE_CTRL.forEach(function (item) {
      var half = curveHalfPx(item.t);
      var y = (124 - item.t * 108).toFixed(1);
      html += '<circle class="l3-curve-pt" data-curve="' + item.key + '" cx="' +
        (120 + half).toFixed(1) + '" cy="' + y + '" r="5"></circle>' +
        '<circle class="l3-curve-ghost" cx="' + (120 - half).toFixed(1) + '" cy="' + y + '" r="3"></circle>';
    });
    svg.innerHTML = html;
  }

  function bindCurve(svg) {
    svg.addEventListener('pointerdown', function (event) {
      var point = event.target.closest('[data-curve]');
      if (!point) return;
      event.preventDefault();
      var key = point.getAttribute('data-curve');
      var startX = event.clientX;
      var start = Number(S.shape[key]);
      function move(ev) {
        setShapeValue(key, start + (ev.clientX - startX) * 1.1, true);
        paintShapeRow(key);
      }
      function end() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        commitShapeHistory();
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
    });
  }

  /* ---------- 右侧检查器 ---------- */
  /* 检查器是常驻右列：对话 / 捏脸 / 纹理共用一个面板，切换页签只换内容，
   * 画布宽度由 flex 自动重算，编辑面板永远不会盖住预览。 */
  function syncModeButtons(name) {
    if (!S || !S.refs || !S.refs.modes) return;
    S.refs.modes.querySelectorAll('[data-mode]').forEach(function (button) {
      button.classList.toggle('on', button.getAttribute('data-mode') === name);
    });
  }

  function setDrawerTab(tab) {
    if (!S || !S.refs || !S.refs.drawer) return;
    var name = tab === 'texture' ? 'texture' : (tab === 'chat' ? 'chat' : 'shape');
    S.drawerTab = name;
    S.refs.drawer.setAttribute('data-tab', name);
    S.refs.drawer.querySelectorAll('.l3-insp-tabs [data-tab]').forEach(function (button) {
      var on = button.getAttribute('data-tab') === name;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    S.refs.drawer.querySelectorAll('[data-pane]').forEach(function (pane) {
      pane.hidden = pane.getAttribute('data-pane') !== name;
    });
    syncModeButtons(name);
    updateGizmoVisibility();
    if (name === 'texture') ensureTextureEditor();
  }

  function openDrawer(tab) {
    if (!S || !S.refs || !S.refs.drawer) return;
    setDrawerTab(tab || S.drawerTab || 'shape');
  }

  function closeDrawer() {
    setDrawerTab('chat');
  }

  /* ---------- 贴图持久化 ---------- */
  function loadTextureRecord() {
    var raw = null;
    try { raw = localStorage.getItem(TEX_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function registerTexBlobRoot() {
    if (typeof blobRegisterRoot !== 'function') return;
    try {
      blobRegisterRoot(function () {
        var rec = loadTextureRecord();
        return rec && rec.src ? { tex: rec.src } : null;
      });
    } catch (e) { /* 存储不可用 */ }
  }

  function savedTextureURL() {
    var rec = loadTextureRecord();
    if (!rec || !rec.src) return Promise.resolve('');
    var src = String(rec.src);
    if (src.indexOf('blob:') === 0) {
      if (typeof blobResolveAsync !== 'function') return Promise.resolve('');
      return Promise.resolve(blobResolveAsync(src)).then(function (value) {
        return (typeof value === 'string' && value.indexOf('data:') === 0) ? value : '';
      }).catch(function () { return ''; });
    }
    return Promise.resolve(src.indexOf('data:') === 0 ? src : '');
  }

  function persistCurrentTexture() {
    if (!S || !S.tex || !S.tex.ready) return;
    var data = '';
    try { data = S.tex.canvas.toDataURL('image/png'); } catch (e) { return; }
    var src = data;
    if (typeof blobPut === 'function' && typeof blobIdFor === 'function' && data.length > 40000) {
      try {
        var id = blobIdFor(data);
        blobPut(id, data);
        src = 'blob:' + id;
      } catch (e) { src = data; }
    }
    try { localStorage.setItem(TEX_KEY, JSON.stringify({ v: 1, src: src })); } catch (e) { /* 配额不足 */ }
  }

  /* ---------- 贴图编辑器 ---------- */
  function hexRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [224, 90, 90];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function texSnapshot() {
    var t = S.tex;
    try {
      t.undo.push(t.canvas.toDataURL('image/png'));
      if (t.undo.length > 8) t.undo.shift();
      t.redo.length = 0;
    } catch (e) { /* 画布不可读 */ }
    paintTexHistory();
  }

  function paintTexHistory() {
    if (!S || !S.refs) return;
    if (S.refs.texUndo) S.refs.texUndo.disabled = !S.tex.undo.length;
    if (S.refs.texRedo) S.refs.texRedo.disabled = !S.tex.redo.length;
  }

  function texLoad(url, done) {
    var image = new Image();
    image.onload = function () {
      var t = S.tex;
      t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
      t.ctx.drawImage(image, 0, 0, t.canvas.width, t.canvas.height);
      if (done) done(true);
    };
    image.onerror = function () { if (done) done(false); };
    image.src = url;
  }

  function texUndo() {
    var t = S.tex;
    if (!t.ready || !t.undo.length) return;
    t.redo.push(t.canvas.toDataURL('image/png'));
    texLoad(t.undo.pop(), function () { paintTexHistory(); texPreview(); });
    paintTexHistory();
  }

  function texRedo() {
    var t = S.tex;
    if (!t.ready || !t.redo.length) return;
    t.undo.push(t.canvas.toDataURL('image/png'));
    texLoad(t.redo.pop(), function () { paintTexHistory(); texPreview(); });
    paintTexHistory();
  }

  function texPoint(event) {
    var t = S.tex;
    var rect = t.canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / (rect.width || 1) * t.canvas.width, 0, t.canvas.width - 1),
      y: clamp((event.clientY - rect.top) / (rect.height || 1) * t.canvas.height, 0, t.canvas.height - 1)
    };
  }

  /* 当前选区：0 表示「全部」（只排除 UV 未使用区域），其余对应 face 遮罩里的分区 id */
  function texMaskAllows(index) {
    var ids = S.tex.maskIds;
    if (!ids) return true;
    var id = ids[index];
    if (!id) return false;
    var want = S.tex.maskId || 0;
    return !want || id === want;
  }

  /* 笔刷逐像素穿过选区遮罩：先画到暂存画布，再按 mask 合成回主画布。
   * 这样落笔边界严格贴住选中部位的 UV，不会蹭到相邻区域。 */
  function texStamp(x, y) {
    var t = S.tex, ctx = t.ctx;
    var radius = Math.max(1, t.size / 2);
    var width = t.canvas.width, height = t.canvas.height;
    var x0 = Math.max(0, Math.floor(x - radius - 1));
    var y0 = Math.max(0, Math.floor(y - radius - 1));
    var x1 = Math.min(width, Math.ceil(x + radius + 1));
    var y1 = Math.min(height, Math.ceil(y + radius + 1));
    var w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    if (!t.scratch) {
      t.scratch = document.createElement('canvas');
      t.scratch.width = 512;
      t.scratch.height = 512;
      t.scratchCtx = t.scratch.getContext('2d', { willReadFrequently: true });
    }
    var sctx = t.scratchCtx;
    var ox = x - x0, oy = y - y0;
    sctx.clearRect(0, 0, w, h);
    var rgb = hexRgb(t.color);
    var erase = t.tool === 'eraser';
    var gradient = sctx.createRadialGradient(ox, oy, radius * 0.2, ox, oy, radius);
    if (erase) {
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(0.7, 'rgba(0,0,0,0.85)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      gradient.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.95)');
      gradient.addColorStop(0.7, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.55)');
      gradient.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
    }
    sctx.fillStyle = gradient;
    sctx.beginPath();
    sctx.arc(ox, oy, radius, 0, Math.PI * 2);
    sctx.fill();
    var src = sctx.getImageData(0, 0, w, h).data;
    var shot = ctx.getImageData(x0, y0, w, h);
    var dst = shot.data;
    var ids = t.maskIds;
    var want = t.maskId || 0;
    for (var yy = 0; yy < h; yy++) {
      var row = (y0 + yy) * width + x0;
      for (var xx = 0; xx < w; xx++) {
        var maskId = ids ? ids[row + xx] : 1;
        if (!maskId || (want && maskId !== want)) continue;
        var p = (yy * w + xx) * 4;
        var alpha = src[p + 3] / 255;
        if (alpha <= 0.002) continue;
        if (erase) {
          dst[p + 3] = Math.round(dst[p + 3] * (1 - alpha));
        } else {
          var da = dst[p + 3] / 255;
          var outA = alpha + da * (1 - alpha);
          if (outA <= 0) { dst[p + 3] = 0; continue; }
          var keep = da * (1 - alpha);
          dst[p] = Math.round((src[p] * alpha + dst[p] * keep) / outA);
          dst[p + 1] = Math.round((src[p + 1] * alpha + dst[p + 1] * keep) / outA);
          dst[p + 2] = Math.round((src[p + 2] * alpha + dst[p + 2] * keep) / outA);
          dst[p + 3] = Math.round(outA * 255);
        }
      }
    }
    ctx.putImageData(shot, x0, y0);
  }

  function texLine(from, to) {
    var t = S.tex;
    var dx = to.x - from.x, dy = to.y - from.y;
    var length = Math.hypot(dx, dy);
    var step = Math.max(1, t.size * 0.18);
    var count = Math.max(1, Math.ceil(length / step));
    for (var i = 1; i <= count; i++) {
      texStamp(from.x + dx * (i / count), from.y + dy * (i / count));
    }
  }

  function texPick(point) {
    var t = S.tex;
    var data = t.ctx.getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data;
    var hex = '#' + [data[0], data[1], data[2]].map(function (v) {
      return ('0' + clamp(v, 0, 255).toString(16)).slice(-2);
    }).join('');
    t.color = hex;
    if (S.refs.texColor) S.refs.texColor.value = hex;
    if (S.refs.repFrom) S.refs.repFrom.value = hex;
    return hex;
  }

  function texFlood(sx, sy) {
    var t = S.tex, canvas = t.canvas, ctx = t.ctx;
    var width = canvas.width, height = canvas.height;
    sx = Math.floor(sx); sy = Math.floor(sy);
    var image = ctx.getImageData(0, 0, width, height);
    var data = image.data;
    var at = (sy * width + sx) * 4;
    var sr = data[at], sg = data[at + 1], sb = data[at + 2], sa = data[at + 3];
    var rgb = hexRgb(t.color);
    if (Math.abs(sr - rgb[0]) + Math.abs(sg - rgb[1]) + Math.abs(sb - rgb[2]) < 6 && sa === 255) return;
    var tolerance = t.tolerance;
    var seen = new Uint8Array(width * height);
    var stack = new Int32Array(width * height);
    var top = 0;
    var start = sy * width + sx;
    if (!texMaskAllows(start)) return;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      var index = stack[--top];
      if (!texMaskAllows(index)) continue;
      var pixel = index * 4;
      if (Math.abs(data[pixel] - sr) > tolerance || Math.abs(data[pixel + 1] - sg) > tolerance ||
          Math.abs(data[pixel + 2] - sb) > tolerance || Math.abs(data[pixel + 3] - sa) > tolerance) continue;
      data[pixel] = rgb[0];
      data[pixel + 1] = rgb[1];
      data[pixel + 2] = rgb[2];
      data[pixel + 3] = 255;
      var x = index % width, y = (index / width) | 0;
      if (x > 0 && !seen[index - 1]) { seen[index - 1] = 1; stack[top++] = index - 1; }
      if (x < width - 1 && !seen[index + 1]) { seen[index + 1] = 1; stack[top++] = index + 1; }
      if (y > 0 && !seen[index - width]) { seen[index - width] = 1; stack[top++] = index - width; }
      if (y < height - 1 && !seen[index + width]) { seen[index + width] = 1; stack[top++] = index + width; }
    }
    ctx.putImageData(image, 0, 0);
  }

  function texAdjust() {
    var t = S.tex;
    var brightness = Number(S.refs.adjBright.value) * 2.55;
    var contrast = Number(S.refs.adjContrast.value);
    var saturation = Number(S.refs.adjSat.value) / 100;
    if (!brightness && !contrast && !saturation) return;
    texSnapshot();
    var image = t.ctx.getImageData(0, 0, t.canvas.width, t.canvas.height);
    var data = image.data;
    var factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (var i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      if (!texMaskAllows(i >> 2)) continue;
      var r = (data[i] + brightness - 128) * factor + 128;
      var g = (data[i + 1] + brightness - 128) * factor + 128;
      var b = (data[i + 2] + brightness - 128) * factor + 128;
      var lum = r * 0.299 + g * 0.587 + b * 0.114;
      data[i] = clamp(lum + (r - lum) * (1 + saturation), 0, 255);
      data[i + 1] = clamp(lum + (g - lum) * (1 + saturation), 0, 255);
      data[i + 2] = clamp(lum + (b - lum) * (1 + saturation), 0, 255);
    }
    t.ctx.putImageData(image, 0, 0);
    S.refs.adjBright.value = 0;
    S.refs.adjContrast.value = 0;
    S.refs.adjSat.value = 0;
    texPreview();
  }

  function texReplace() {
    var t = S.tex;
    var from = hexRgb(S.refs.repFrom.value);
    var to = hexRgb(S.refs.repTo.value);
    var tolerance = t.tolerance;
    texSnapshot();
    var image = t.ctx.getImageData(0, 0, t.canvas.width, t.canvas.height);
    var data = image.data;
    for (var i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      if (!texMaskAllows(i >> 2)) continue;
      if (Math.abs(data[i] - from[0]) <= tolerance &&
          Math.abs(data[i + 1] - from[1]) <= tolerance &&
          Math.abs(data[i + 2] - from[2]) <= tolerance) {
        data[i] = to[0];
        data[i + 1] = to[1];
        data[i + 2] = to[2];
      }
    }
    t.ctx.putImageData(image, 0, 0);
    texPreview();
  }

  function texFit(force) {
    var t = S.tex;
    var view = S.refs.texView;
    if (!t.ready || !view) return;
    if (force) {
      var available = Math.max(160, view.clientWidth - 20);
      t.zoom = available / t.canvas.width;
    }
    texApplyZoom();
  }

  function texApplyZoom() {
    var t = S.tex;
    if (!t.ready) return;
    var size = Math.max(80, Math.round(t.canvas.width * t.zoom));
    t.canvas.style.width = size + 'px';
    t.canvas.style.height = size + 'px';
  }

  /* ---------- 分区选择 ---------- */

  function texRegionDef(key) {
    var list = S.tex.regionList || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return list[0] || null;
  }

  function paintTexRegions() {
    var refs = S.refs;
    if (!refs || !refs.texRegions) return;
    refs.texRegions.innerHTML = '';
    (S.tex.regionList || []).forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'l3-regionchip' + (item.key === S.tex.regionKey ? ' on' : '');
      button.setAttribute('data-region', item.key);
      button.textContent = item.label;
      button.title = item.pixels
        ? item.label + ' · ' + item.pixels.toLocaleString() + ' UV 像素'
        : '整张 UV 图，只允许画在模型已映射的区域';
      refs.texRegions.appendChild(button);
    });
    if (refs.texRegionHint) {
      var def = texRegionDef(S.tex.regionKey);
      refs.texRegionHint.textContent = !def || def.key === 'all'
        ? '全部区域：只在模型已映射的 UV 上落笔，未使用的贴图空白不会沾色。'
        : '当前选区「' + def.label + '」：只有该部位对应的 UV 接受笔迹，其余位置自动忽略。';
    }
  }

  /* 圈外压暗：选中区域保持原图，其余 UV 盖一层浅色纱，避免看错位置 */
  function texBuildVeil() {
    var t = S.tex;
    var veil = S.refs && S.refs.texVeil;
    if (!veil || !t.ready) return;
    var vctx = veil.getContext('2d');
    vctx.clearRect(0, 0, veil.width, veil.height);
    if (!t.maskIds) return;
    if (veil.width !== t.canvas.width || veil.height !== t.canvas.height) {
      veil.width = t.canvas.width;
      veil.height = t.canvas.height;
    }
    if (!t.maskCanvas) {
      t.maskCanvas = document.createElement('canvas');
      t.maskCanvas.width = t.canvas.width;
      t.maskCanvas.height = t.canvas.height;
    }
    var mctx = t.maskCanvas.getContext('2d');
    var image = mctx.createImageData(t.maskCanvas.width, t.maskCanvas.height);
    var data = image.data;
    var ids = t.maskIds;
    var want = t.maskId || 0;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!id || (want && id !== want)) continue;
      var p = i * 4;
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = 255;
    }
    mctx.putImageData(image, 0, 0);
    vctx.fillStyle = 'rgba(244,247,251,0.78)';
    vctx.fillRect(0, 0, veil.width, veil.height);
    vctx.globalCompositeOperation = 'destination-out';
    vctx.drawImage(t.maskCanvas, 0, 0, veil.width, veil.height);
    vctx.globalCompositeOperation = 'source-over';
  }

  function texFitRegion(bbox) {
    var t = S.tex;
    var view = S.refs && S.refs.texView;
    if (!t.ready || !view || !bbox) return;
    var u0 = Math.max(0, bbox[0] - 0.015);
    var v0 = Math.max(0, bbox[1] - 0.015);
    var u1 = Math.min(1, bbox[2] + 0.015);
    var v1 = Math.min(1, bbox[3] + 0.015);
    var bw = Math.max(1, (u1 - u0) * t.canvas.width);
    var bh = Math.max(1, (v1 - v0) * t.canvas.height);
    var availW = Math.max(120, view.clientWidth - 24);
    var availH = Math.max(120, view.clientHeight - 24);
    t.zoom = clamp(Math.min(availW / bw, availH / bh), 0.12, 4);
    texApplyZoom();
    var cx = (u0 + u1) / 2 * t.canvas.width * t.zoom;
    var cy = (1 - (v0 + v1) / 2) * t.canvas.height * t.zoom;
    view.scrollLeft = cx - view.clientWidth / 2;
    view.scrollTop = cy - view.clientHeight / 2;
  }

  function texSetRegion(key, fit) {
    var t = S.tex;
    var def = texRegionDef(key) || texRegionDef('all');
    t.regionKey = def ? def.key : 'all';
    t.maskId = def ? def.id : 0;
    paintTexRegions();
    texBuildVeil();
    if (fit) {
      if (def && def.bbox) texFitRegion(def.bbox);
      else texFit(true);
    }
  }

  /* 编辑中的实时预览：只换材质贴图，不写持久化（应用按钮才存） */
  function texPreview() {
    if (!S || !S.face || !S.tex.ready) return;
    try { S.face.applyCanvasTexture(S.tex.canvas); } catch (e) { /* 预览失败不影响继续编辑 */ }
  }

  function texZoomAt(clientX, clientY, factor) {
    var t = S.tex;
    var view = S.refs.texView;
    if (!view) return;
    var before = t.canvas.getBoundingClientRect();
    var rx = before.width ? (clientX - before.left) / before.width : 0.5;
    var ry = before.height ? (clientY - before.top) / before.height : 0.5;
    t.zoom = clamp(t.zoom * factor, 0.12, 4);
    texApplyZoom();
    var after = t.canvas.getBoundingClientRect();
    view.scrollLeft += (after.left + rx * after.width) - clientX;
    view.scrollTop += (after.top + ry * after.height) - clientY;
  }

  function bindTextureEditor() {
    var t = S.tex;
    var canvas = t.canvas;
    var view = S.refs.texView;
    canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    canvas.addEventListener('pointerdown', function (event) {
      if (event.button === 2) {
        t.pan = { x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop };
        try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
        return;
      }
      if (event.button !== 0) return;
      var point = texPoint(event);
      if (t.tool === 'pick' || event.altKey) { texPick(point); return; }
      var index = Math.floor(point.y) * t.canvas.width + Math.floor(point.x);
      if (!texMaskAllows(index)) return;
      if (t.tool === 'bucket') {
        texSnapshot();
        texFlood(point.x, point.y);
        texPreview();
        return;
      }
      texSnapshot();
      t.drawing = true;
      t.last = point;
      try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
      texStamp(point.x, point.y);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (t.pan) {
        view.scrollLeft = t.pan.left - (event.clientX - t.pan.x);
        view.scrollTop = t.pan.top - (event.clientY - t.pan.y);
        return;
      }
      if (!t.drawing) return;
      var point = texPoint(event);
      if (t.last) texLine(t.last, point);
      t.last = point;
    });
    function stop() {
      if (t.drawing) texPreview();
      t.pan = null;
      t.drawing = false;
      t.last = null;
    }
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    view.addEventListener('wheel', function (event) {
      if (!t.ready) return;
      event.preventDefault();
      texZoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    }, { passive: false });
  }

  function ensureTextureEditor() {
    if (!S || !S.face || !S.refs || !S.refs.texCanvas) return;
    var t = S.tex;
    if (t.ready) {
      if (t.regionKey && t.regionKey !== 'all') texSetRegion(t.regionKey, true);
      else texFit(false);
      return;
    }
    t.canvas = S.refs.texCanvas;
    t.ctx = t.canvas.getContext('2d', { willReadFrequently: true });
    var mask = S.face.regionMask ? S.face.regionMask() : null;
    if (mask && mask.ids && mask.ids.length === t.canvas.width * t.canvas.height) {
      t.maskIds = mask.ids;
      t.regionList = [{ key: 'all', label: '全部', id: 0 }].concat(mask.list);
    } else {
      t.maskIds = null;
      t.regionList = [{ key: 'all', label: '全部', id: 0 }];
    }
    t.regionKey = 'all';
    t.maskId = 0;
    var image = S.face.textureImage();
    if (image) t.ctx.drawImage(image, 0, 0, t.canvas.width, t.canvas.height);
    t.ready = true;
    t.zoom = 1;
    bindTextureEditor();
    paintTexRegions();
    texBuildVeil();
    texFit(true);
    paintTexHistory();
  }

  function texApply() {
    if (!S || !S.face || !S.tex.ready) return false;
    S.face.applyCanvasTexture(S.tex.canvas);
    persistCurrentTexture();
    return true;
  }

  function texExport() {
    if (!S || !S.tex.ready) return;
    var link = document.createElement('a');
    link.download = '流明贴图.png';
    link.href = S.tex.canvas.toDataURL('image/png');
    link.click();
  }

  function texReset() {
    if (!S || !S.face || !S.tex.ready) return;
    texSnapshot();
    texLoad(S.face.originalTextureURL(), texPreview);
  }

  function bindTexturePanel() {
    if (!S || !S.refs || S.texPanelBound) return;
    var refs = S.refs;
    S.texPanelBound = true;
    refs.drawer.querySelectorAll('[data-tool]').forEach(function (button) {
      button.addEventListener('click', function () {
        S.tex.tool = button.getAttribute('data-tool');
        refs.drawer.querySelectorAll('[data-tool]').forEach(function (item) {
          item.classList.toggle('on', item === button);
        });
      });
    });
    if (refs.texSize) refs.texSize.addEventListener('input', function () {
      S.tex.size = Number(refs.texSize.value);
      if (refs.texSizeVal) refs.texSizeVal.textContent = refs.texSize.value;
    });
    if (refs.texColor) refs.texColor.addEventListener('input', function () {
      S.tex.color = refs.texColor.value;
    });
    if (refs.texTol) refs.texTol.addEventListener('input', function () {
      S.tex.tolerance = Number(refs.texTol.value);
    });
    if (refs.texRegions) {
      refs.texRegions.addEventListener('click', function (event) {
        var chip = event.target.closest('[data-region]');
        if (chip) texSetRegion(chip.getAttribute('data-region'), true);
      });
    }
    if (refs.texUndo) refs.texUndo.addEventListener('click', texUndo);
    if (refs.texRedo) refs.texRedo.addEventListener('click', texRedo);
    if (refs.texReset) refs.texReset.addEventListener('click', texReset);
    if (refs.texExport) refs.texExport.addEventListener('click', texExport);
    if (refs.texApply) refs.texApply.addEventListener('click', texApply);
    if (refs.adjApply) refs.adjApply.addEventListener('click', texAdjust);
    if (refs.repRun) refs.repRun.addEventListener('click', texReplace);
  }

  /* ---------- App 状态 ---------- */
  function loadStore() {
    var out = { msgs: [], voiceOn: true, style: '', voice: '' };
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return out;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return out; }
    if (!data || (data.v !== 1 && data.v !== STORE_VER)) return out;
    if (Array.isArray(data.msgs)) out.msgs = data.msgs.filter(function (m) {
      return m && (m.r === 'u' || m.r === 'a') && typeof m.t === 'string';
    }).slice(-60);
    if (typeof data.voiceOn === 'boolean') out.voiceOn = data.voiceOn;
    if (typeof data.style === 'string') out.style = data.style;
    if (typeof data.voice === 'string') out.voice = data.voice;
    return out;
  }

  function saveStore() {
    if (!S) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: STORE_VER,
        msgs: S.msgs.slice(-60),
        voiceOn: S.voiceOn,
        style: S.styleLabel || '',
        voice: currentVoice()
      }));
    } catch (e) { /* 无痕模式忽略 */ }
  }

  /* ---------- 语音 ---------- */
  function currentVoice() {
    try { return String(localStorage.getItem('hf_ttsVoice') || ''); } catch (e) { return ''; }
  }
  function setCurrentVoice(value) {
    try { localStorage.setItem('hf_ttsVoice', value || ''); } catch (e) { /* 忽略 */ }
  }
  function ttsApi() {
    var bridge = window.ttsBridge;
    return (bridge && typeof bridge.catalog === 'function') ? bridge : null;
  }
  function voiceSpec() {
    var api = ttsApi();
    if (api) {
      try { return api.spec(currentVoice()); } catch (e) { return null; }
    }
    return null;
  }
  function systemVoices() {
    try { return window.speechSynthesis ? (window.speechSynthesis.getVoices() || []) : []; }
    catch (e) { return []; }
  }
  function pickSystemVoice() {
    var list = systemVoices();
    if (!list.length) return null;
    var zh = list.filter(function (v) {
      return /zh|chinese|中文|普通话/i.test((v.lang || '') + ' ' + (v.name || ''));
    });
    return zh.filter(function (v) {
      return /female|xiaoxiao|huihui|tingting|yaoyao|女/i.test(v.name || '');
    })[0] || zh[0] || null;
  }

  function stopSpeech() {
    if (!S) return;
    S.mouth.ttsUntil = 0;
    if (S.audio) {
      try { S.audio.pause(); } catch (e) { /* 已结束 */ }
      S.audio = null;
    }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 无引擎 */ }
  }

  function speakSystem(text) {
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      window.speechSynthesis.cancel();
      var utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.02;
      utterance.pitch = 1.08;
      var voice = pickSystemVoice();
      if (voice) utterance.voice = voice;
      S.mouth.ttsUntil = S.clock + Math.min(30, Math.max(1.4, text.length / 5.4));
      utterance.onboundary = function (event) {
        if (!S) return;
        var len = (event && event.charLength) || 2;
        S.mouth.pulse = clamp(0.4 + len * 0.12 + Math.random() * 0.25, 0, 1);
        S.mouth.pulseUntil = S.clock + 0.16;
        S.mouth.ttsUntil = Math.max(S.mouth.ttsUntil, S.clock + 0.6);
      };
      utterance.onend = function () {
        if (S) S.mouth.ttsUntil = Math.min(S.mouth.ttsUntil, S.clock + 0.25);
      };
      utterance.onerror = function () { if (S) S.mouth.ttsUntil = 0; };
      window.speechSynthesis.speak(utterance);
    } catch (e) { S.mouth.ttsUntil = 0; }
  }

  function speakLocal(text, spec) {
    if (!spec || typeof fetch !== 'function' || typeof rtBase !== 'function' || typeof Audio !== 'function') return false;
    var base = rtBase();
    if (!base) return false;
    var payload = { text: text, engine: spec.engine, rate: 1.02 };
    if (spec.engine === 'kokoro') payload.sid = spec.sid;
    else if (spec.engine === 'piper') payload.voice = spec.voice;
    S.mouth.ttsUntil = S.clock + Math.min(30, Math.max(1.4, text.length / 5.4));
    fetch(base + '/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (json) {
          throw new Error((json && json.error) || ('HTTP ' + res.status));
        });
      }
      return res.blob();
    }).then(function (blob) {
      if (!S || !blob || !blob.size) throw new Error('没有返回音频');
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      S.audio = audio;
      audio.onended = audio.onerror = function () {
        if (!S) return;
        S.mouth.ttsUntil = Math.min(S.mouth.ttsUntil, S.clock + 0.25);
        S.audio = null;
        try { URL.revokeObjectURL(url); } catch (e) { /* 已释放 */ }
      };
      var playing = audio.play();
      if (playing && playing.catch) playing.catch(function () { if (S) S.mouth.ttsUntil = 0; });
    }).catch(function () {
      if (S) speakSystem(text);
    });
    return true;
  }

  function speakAloud(text, force) {
    if (!S || (!S.voiceOn && !force) || !text) return;
    var clean = String(text).trim();
    if (!clean) return;
    try {
      stopSpeech();
      var spec = voiceSpec();
      if (spec && speakLocal(clean, spec)) return;
      speakSystem(clean);
    } catch (e) { S.mouth.ttsUntil = 0; }
  }

  /* ---------- 口型 / 眨眼 ---------- */
  function speechFeed(text) {
    if (!S || !text) return;
    S.mouth.queue += String(text);
    if (S.mouth.queue.length > 120) S.mouth.queue = S.mouth.queue.slice(-120);
  }

  function pickViseme(ch) {
    if (/[\s，。！？、,.!?…~～—：；]/.test(ch)) return 'sil';
    return MOUTH_CHANNELS[ch.charCodeAt(0) % MOUTH_CHANNELS.length];
  }

  function tickMouth(dt) {
    var mouth = S.mouth;
    if (mouth.queue) {
      mouth.acc += dt * 15.5;
      while (mouth.acc >= 1 && mouth.queue.length) {
        mouth.acc -= 1;
        var ch = mouth.queue.charAt(0);
        mouth.queue = mouth.queue.slice(1);
        mouth.viseme = pickViseme(ch);
        mouth.pulse = mouth.viseme === 'sil' ? 0 : rand(0.45, 0.95);
        mouth.pulseUntil = S.clock + 0.12;
      }
    }
    if (S.clock < mouth.ttsUntil && S.clock >= (mouth.ttsTick || 0)) {
      mouth.pulse = rand(0.45, 0.9);
      mouth.pulseUntil = S.clock + 0.12;
      mouth.ttsTick = S.clock + 0.12;
    }
    if (S.clock >= mouth.ttsUntil) mouth.ttsTick = 0;
    var target = S.clock < mouth.pulseUntil ? mouth.pulse : 0;
    mouth.open += (target - mouth.open) * Math.min(1, dt * 20);
    if (mouth.open < 0.004) mouth.open = 0;
  }

  function tickBlink(dt) {
    var blink = S.blink;
    blink.t += dt;
    if (blink.t < blink.next) { blink.value = 0; return; }
    blink.phase += dt;
    var p = blink.phase;
    if (p < 0.09) blink.value = p / 0.09;
    else if (p < 0.14) blink.value = 1;
    else if (p < 0.28) blink.value = 1 - (p - 0.14) / 0.14;
    else {
      blink.phase = 0;
      blink.t = 0;
      blink.value = 0;
      blink.next = Math.random() < 0.18 ? 0.3 : rand(2.2, 5.2);
    }
    S.browPulse.L = Math.max(0, S.browPulse.L - dt / 1.4);
    S.browPulse.R = Math.max(0, S.browPulse.R - dt / 1.4);
  }

  function composeShapes() {
    var shapes = S.player ? S.player.sample() : {};
    if (shapes === undefined || shapes === null) shapes = {};
    if (S.browPulse.L > 0.01) {
      shapes.eyebrow_up_L = Math.max(shapes.eyebrow_up_L || 0, 100 * S.browPulse.L);
    }
    if (S.browPulse.R > 0.01) {
      shapes.eyebrow_up_R = Math.max(shapes.eyebrow_up_R || 0, 100 * S.browPulse.R);
    }
    var open = S.mouth.open;
    if (open > 0.012) {
      shapes['vrc.v_sil'] = (1 - open) * 12;
      MOUTH_CHANNELS.forEach(function (name) {
        shapes['vrc.v_' + name] = name === S.mouth.viseme ? open * 100 : 0;
      });
    }
    shapes.eye_close = Math.max(shapes.eye_close || 0, S.blink.value * 100);
    return shapes;
  }

  /* ---------- 表情 ---------- */
  function styleForLabel(label) {
    if (!S || !S.player) return null;
    var key = String(label || '').replace(/\s+/g, '');
    if (!key) return null;
    var styles = S.player.styles;
    var hit = styles.filter(function (style) { return style.label === key; });
    if (!hit.length && ALIAS[key]) {
      var mapped = ALIAS[key];
      hit = styles.filter(function (style) { return style.label === mapped; });
    }
    if (!hit.length) {
      hit = styles.filter(function (style) {
        return style.label.indexOf(key) >= 0 || key.indexOf(style.label) >= 0;
      });
    }
    return hit[0] || null;
  }

  function setExprChip(text) {
    if (S && S.refs.expr) S.refs.expr.textContent = text || '自然放松';
  }

  function playLabel(label) {
    if (!S || !S.player) return;
    var key = String(label || '').replace(/\s+/g, '');
    if (key.indexOf('右眉') >= 0) {
      S.browPulse.R = 1;
      setExprChip('右眉上挑');
      S.styleLabel = '右眉上挑';
      return;
    }
    if (key.indexOf('左眉') >= 0) {
      S.browPulse.L = 1;
      setExprChip('左眉上挑');
      S.styleLabel = '左眉上挑';
      return;
    }
    var style = styleForLabel(key);
    if (!style) return;
    S.player.choose(style);
    S.styleLabel = style.label;
    setExprChip(style.label);
    if (S.refs.style) S.refs.style.value = style.label;
    saveStore();
  }

  /* ---------- 对话 ---------- */
  function buildSystem() {
    var labels = [];
    if (S && S.player) {
      S.player.styles.forEach(function (style) {
        if (labels.indexOf(style.label) < 0) labels.push(style.label);
      });
    }
    return [
      '你叫「流明」，是一个有三维脸部模型的虚拟角色。用户能看见你的表情，你能听见、也能用语音回答。',
      '规则一：每次回复必须以一个中文圆括号标签开头，标签只能从下面这些里选，不要自创：',
      labels.join('、') + '。',
      '规则二：标签只用来驱动表情，不要在台词里解释它，也不要说“我露出微笑”这类描述。',
      '规则三：台词会被直接朗读，不要用 Markdown、列表或颜文字；语气自然，1 到 3 句，不超过 80 个汉字。',
      '示例：（微笑）早上好，今天也一起加油吧。'
    ].join('\n');
  }

  function history() {
    return S.msgs.slice(-12).map(function (m) {
      return { role: m.r === 'u' ? 'user' : 'assistant', content: m.t };
    });
  }

  function addMsg(role, text) {
    var el = document.createElement('div');
    el.className = 'l3-msg ' + role;
    el.textContent = text;
    S.refs.msgs.appendChild(el);
    S.refs.msgs.scrollTop = S.refs.msgs.scrollHeight;
    return el;
  }

  function scrollMsgs() {
    if (S && S.refs.msgs) S.refs.msgs.scrollTop = S.refs.msgs.scrollHeight;
  }

  function renderMsgs() {
    S.refs.msgs.innerHTML = '';
    if (!S.msgs.length) {
      addMsg('a', '你好，我是流明。说点什么，我会用表情和声音回应你。');
      return;
    }
    S.msgs.forEach(function (m) { addMsg(m.r, m.t); });
  }

  function growInput() {
    var input = S.refs.input;
    input.style.height = 'auto';
    input.style.height = Math.min(108, input.scrollHeight) + 'px';
  }

  function setBusy(busy) {
    S.busy = busy;
    S.refs.send.disabled = busy;
    S.refs.send.textContent = busy ? '生成中' : '发送';
  }

  function finishAnswer(raw, bubble) {
    var text = stripTags(raw) || '……';
    bubble.classList.remove('typing');
    bubble.textContent = text;
    S.msgs.push({ r: 'a', t: text });
    if (S.msgs.length > 60) S.msgs = S.msgs.slice(-60);
    saveStore();
    speakAloud(text);
    scrollMsgs();
  }

  function send() {
    if (!S || S.busy) return;
    var text = S.refs.input.value.trim();
    if (!text) { S.refs.input.focus(); return; }
    S.refs.input.value = '';
    growInput();
    addMsg('u', text);
    S.msgs.push({ r: 'u', t: text });
    saveStore();

    stopSpeech();
    S.player.returnToNeutral();
    S.browPulse.L = 0;
    S.browPulse.R = 0;

    setBusy(true);
    var bubble = addMsg('a', '…');
    bubble.classList.add('typing');
    var acc = '';
    var fed = '';
    var lastTag = '';
    var controller = new AbortController();
    S.abort = controller;

    if (typeof llmStreamRequest !== 'function') {
      setBusy(false);
      bubble.classList.remove('typing');
      bubble.className = 'l3-msg s';
      bubble.textContent = '语言模型模块没有加载（llmStreamRequest 不可用）。';
      return;
    }

    llmStreamRequest(buildSystem(), history(), function (full, delta) {
      acc = full;
      var tag = firstTag(full);
      if (tag && tag !== lastTag) {
        lastTag = tag;
        playLabel(tag);
      }
      var clean = stripTags(full);
      bubble.textContent = clean || '…';
      bubble.classList.toggle('typing', !clean);
      if (clean.length > fed.length) speechFeed(clean.slice(fed.length));
      fed = clean;
      scrollMsgs();
    }, { app: 'lumen3d', signal: controller.signal }).then(function (finalText) {
      var raw = (typeof finalText === 'string' && finalText) ? finalText : acc;
      var tag = firstTag(raw);
      if (tag) playLabel(tag);
      finishAnswer(raw, bubble);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        var partial = stripTags(acc);
        if (partial) finishAnswer(acc, bubble);
        else {
          bubble.classList.remove('typing');
          bubble.className = 'l3-msg s';
          bubble.textContent = '已停止生成';
        }
        return;
      }
      bubble.classList.remove('typing');
      bubble.className = 'l3-msg s';
      bubble.textContent = '连接模型失败：' + (err && err.message ? err.message : String(err));
    }).then(function () {
      S.abort = null;
      setBusy(false);
    });
  }

  function abortSend() {
    if (S && S.abort) {
      try { S.abort.abort(); } catch (e) { /* 已结束 */ }
    }
    stopSpeech();
  }

  /* ---------- 音色 ---------- */
  function fillVoices() {
    var select = S.refs.voice;
    var api = ttsApi();
    var snapshot = api ? api.catalog() : null;
    var system = snapshot ? (snapshot.system || []) : systemVoices().map(function (v) {
      return { value: v.name, name: v.name, lang: v.lang || '' };
    });
    var local = snapshot ? (snapshot.local || []) : [];
    var current = currentVoice();

    select.innerHTML = '';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = system.length ? '系统默认（自动挑中文音色）' : '系统默认（未检测到系统语音）';
    select.appendChild(def);

    if (system.length) {
      var group = document.createElement('optgroup');
      group.label = '系统语音';
      system.forEach(function (v) {
        var option = document.createElement('option');
        option.value = v.value;
        option.textContent = v.name + (v.lang ? ' · ' + v.lang : '');
        group.appendChild(option);
      });
      select.appendChild(group);
    }
    if (local.length) {
      var localGroup = document.createElement('optgroup');
      localGroup.label = '本地模型';
      local.forEach(function (v) {
        var option = document.createElement('option');
        option.value = v.value;
        option.textContent = v.name + (v.ready ? '' : (v.needRef ? '（缺参考录音）' : '（未就绪）'));
        localGroup.appendChild(option);
      });
      select.appendChild(localGroup);
    }
    if (current && !system.some(function (v) { return v.value === current; }) &&
        !local.some(function (v) { return v.value === current; })) {
      var keep = document.createElement('option');
      keep.value = current;
      keep.textContent = (api ? api.label(current) : current) + '（未就绪）';
      select.appendChild(keep);
    }
    select.value = current;
    if (select.value !== current) select.value = '';
    paintEngine();
  }

  function paintEngine() {
    if (!S || !S.refs.engine) return;
    var isLocal = !!voiceSpec();
    S.refs.engine.textContent = isLocal ? '本地模型' : '系统语音';
  }

  function syncVoiceBtn() {
    if (!S) return;
    S.refs.voiceBtn.setAttribute('aria-pressed', S.voiceOn ? 'true' : 'false');
    S.refs.voiceBtn.textContent = S.voiceOn ? '朗读 开' : '朗读 关';
  }

  /* ---------- 资源加载 ---------- */
  function setStatus(text, kind) {
    if (!S || !S.refs.state) return;
    S.refs.state.textContent = text;
    S.refs.state.className = 'l3-chip' + (kind ? ' is-' + kind : '');
  }

  function loadFace() {
    var chain = Promise.resolve();
    PACKS.forEach(function (src) {
      chain = chain.then(function () { return injectScript(src); });
    });
    chain.then(function () { return savedTextureURL(); })
      .then(function (textureURL) {
        return createFaceView(S.refs.canvasHost, textureURL);
      })
      .then(function (face) {
      if (!S) return;
      S.face = face;
      if (S.shape) face.setShapeAll(S.shape);
      face.setCoils(S.coils);
      /* 轮廓要在脸模建好之后立刻灌进去，否则读档的脸型是原样、滑杆却是存档值 */
      if (S.outline) face.setOutline(S.outline);
      if (S.xform) face.setXform(S.xform);
      if (S.refs.coilOn) S.refs.coilOn.checked = S.coilOn;
      if (S.refs.outlineOn) S.refs.outlineOn.checked = S.outlineOn !== false;
      S.player = createCurvePlayer();
      S.morphCount = face.morphNames.length;
      var neutral = S.player.neutral;
      setExprChip(neutral ? neutral.label : '自然放松');
      if (neutral && S.styleLabel === '') S.styleLabel = neutral.label;
      setStatus('就绪 · ' + S.morphCount + ' 个形态键', 'ok');
      S.refs.loading.classList.add('is-done');
      fillStyles();
      updateGizmoVisibility();
      startLoop();
    }).catch(function (err) {
      if (!S) return;
      S.refs.loading.classList.add('is-error');
      var text = S.refs.loading.querySelector('.l3-loading-text');
      if (text) text.textContent = (err && err.message) || String(err);
      setStatus('加载失败', 'error');
    });
  }

  function fillStyles() {
    var labels = [];
    S.player.styles.forEach(function (style) {
      if (labels.indexOf(style.label) < 0) labels.push(style.label);
    });
    var select = S.refs.style;
    select.innerHTML = '';
    labels.forEach(function (label) {
      var option = document.createElement('option');
      option.value = label;
      option.textContent = label;
      select.appendChild(option);
    });
    var current = S.styleLabel || (S.player.neutral && S.player.neutral.label) || labels[0];
    select.value = labels.indexOf(current) >= 0 ? current : labels[0];

    var quick = S.refs.quick;
    quick.innerHTML = '';
    QUICK.forEach(function (label) {
      if (labels.indexOf(label) < 0) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', function () { playLabel(label); });
      quick.appendChild(button);
    });
  }

  /* ---------- 帧循环 ---------- */
  function startLoop() {
    if (S.raf) return;
    var last = 0;
    S.clock = 0;
    function frame(now) {
      S.raf = requestAnimationFrame(frame);
      if (!S || !S.face) return;
      var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      S.clock += dt;
      if (S.player) S.player.tick(dt);
      if (S.player && S.player.style && S.browPulse.L < 0.01 && S.browPulse.R < 0.01 &&
          S.player.style.label !== S.styleLabel) {
        /* 片段播完会自动回到自然放松，标签跟着曲线走，避免显示残留 */
        S.styleLabel = S.player.style.label;
        setExprChip(S.styleLabel);
        if (S.refs.style && S.refs.style.value !== S.styleLabel) S.refs.style.value = S.styleLabel;
      }
      tickMouth(dt);
      tickBlink(dt);
      S.face.setShapes(composeShapes());
      S.face.tick(dt, S.clock);
      paintGizmos();
    }
    S.raf = requestAnimationFrame(frame);
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    var refs = S.refs;
    refs.form.addEventListener('submit', function (event) {
      event.preventDefault();
      send();
    });
    refs.input.addEventListener('input', growInput);
    refs.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    refs.voiceBtn.addEventListener('click', function () {
      S.voiceOn = !S.voiceOn;
      if (!S.voiceOn) stopSpeech();
      syncVoiceBtn();
      saveStore();
    });
    refs.style.addEventListener('change', function () {
      playLabel(refs.style.value);
    });
    refs.play.addEventListener('click', function () { playLabel(refs.style.value); });
    refs.neutral.addEventListener('click', function () {
      if (!S.player) return;
      S.player.returnToNeutral();
      S.styleLabel = S.player.neutral ? S.player.neutral.label : '自然放松';
      setExprChip(S.styleLabel);
      saveStore();
    });
    refs.voice.addEventListener('change', function () {
      setCurrentVoice(refs.voice.value);
      paintEngine();
      saveStore();
    });
    refs.test.addEventListener('click', function () {
      speakAloud('你好，我是流明。很高兴见到你。', true);
    });
    refs.views.addEventListener('click', function (event) {
      var button = event.target.closest('[data-view]');
      if (!button || !S.face) return;
      refs.views.querySelectorAll('button').forEach(function (item) {
        item.classList.toggle('on', item === button);
      });
      S.face.setView(button.getAttribute('data-view'));
    });
    refs.lookBtn.addEventListener('click', function () { setDrawerTab('shape'); });
    if (refs.modes) {
      refs.modes.addEventListener('click', function (event) {
        var button = event.target.closest('[data-mode]');
        if (button) setDrawerTab(button.getAttribute('data-mode'));
      });
    }
    refs.drawer.querySelectorAll('.l3-insp-tabs [data-tab]').forEach(function (button) {
      button.addEventListener('click', function () { setDrawerTab(button.getAttribute('data-tab')); });
    });
    if (refs.shapeReset) refs.shapeReset.addEventListener('click', resetShape);
    if (refs.shapeRandom) refs.shapeRandom.addEventListener('click', randomShape);
    if (refs.shapeUndo) refs.shapeUndo.addEventListener('click', undoShape);
    if (refs.shapeRedo) refs.shapeRedo.addEventListener('click', redoShape);
    if (refs.shapeSave) {
      refs.shapeSave.addEventListener('click', function () {
        if (!refs.shapeSaveRow) return;
        refs.shapeSaveRow.hidden = !refs.shapeSaveRow.hidden;
        if (!refs.shapeSaveRow.hidden && refs.shapeSaveName) refs.shapeSaveName.focus();
      });
    }
    if (refs.shapeSaveOk) refs.shapeSaveOk.addEventListener('click', saveCurrentPreset);
    if (refs.shapeSaveCancel) {
      refs.shapeSaveCancel.addEventListener('click', function () {
        if (refs.shapeSaveName) refs.shapeSaveName.value = '';
        if (refs.shapeSaveRow) refs.shapeSaveRow.hidden = true;
      });
    }
    if (refs.shapeSaveName) {
      refs.shapeSaveName.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); saveCurrentPreset(); }
      });
    }
    if (refs.shapePresets) {
      refs.shapePresets.addEventListener('click', function (event) {
        var del = event.target.closest('[data-del-preset]');
        if (del) {
          event.stopPropagation();
          deletePreset(del.getAttribute('data-del-preset'));
          return;
        }
        var chip = event.target.closest('[data-preset]');
        if (chip) applyPreset(chip.getAttribute('data-preset'));
      });
    }
    if (refs.gizmoGroups) {
      refs.gizmoGroups.addEventListener('click', function (event) {
        var chip = event.target.closest('[data-gizmo-group]');
        if (chip) setGizmoGroup(chip.getAttribute('data-gizmo-group'));
      });
    }
    if (refs.gizmoOn) {
      refs.gizmoOn.addEventListener('change', function () { setGizmoOn(refs.gizmoOn.checked); });
    }
    if (refs.coilOn) {
      refs.coilOn.addEventListener('change', function () { setCoilOn(refs.coilOn.checked); });
    }
    if (refs.outlineOn) {
      refs.outlineOn.addEventListener('change', function () { setOutlineOn(refs.outlineOn.checked); });
    }
    if (refs.coilReset) {
      refs.coilReset.addEventListener('click', function () {
        var kind = regionKindOf(S && S.gizmoGroup);
        if (kind) resetXform(kind);
        else resetCoil();
      });
    }
    if (refs.curveSvg) bindCurve(refs.curveSvg);
    if (!S.keysBound) {
      S.keysBound = true;
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && S && S.busy) abortSend();
      });
    }
  }

  function cacheRefs() {
    var body = S.body;
    function q(sel) { return body.querySelector(sel); }
    S.refs = {
      canvasHost: q('#l3Canvas'),
      stage: q('#l3Stage'),
      loading: q('#l3Loading'),
      state: q('#l3State'),
      expr: q('#l3Expr'),
      views: q('#l3Views'),
      modes: q('#l3Modes'),
      msgs: q('#l3Msgs'),
      quick: q('#l3Quick'),
      form: q('#l3Form'),
      input: q('#l3Input'),
      send: q('#l3Send'),
      style: q('#l3Style'),
      play: q('#l3Play'),
      neutral: q('#l3Neutral'),
      voice: q('#l3Voice'),
      engine: q('#l3Engine'),
      test: q('#l3Test'),
      voiceBtn: q('#l3VoiceBtn'),
      lookBtn: q('#l3LookBtn'),
      drawer: q('#l3Drawer'),
      shapeList: q('#l3ShapeList'),
      shapePresets: q('#l3ShapePresets'),
      shapeRandom: q('#l3ShapeRandom'),
      shapeUndo: q('#l3ShapeUndo'),
      shapeRedo: q('#l3ShapeRedo'),
      shapeSave: q('#l3ShapeSave'),
      shapeSaveRow: q('#l3ShapeSaveRow'),
      shapeSaveName: q('#l3ShapeSaveName'),
      shapeSaveOk: q('#l3ShapeSaveOk'),
      shapeSaveCancel: q('#l3ShapeSaveCancel'),
      shapeReset: q('#l3ShapeReset'),
      gizmoGroups: q('#l3GizmoGroups'),
      gizmoOn: q('#l3GizmoOn'),
      coilOn: q('#l3CoilOn'),
      outlineOn: q('#l3OutlineOn'),
      coilReset: q('#l3CoilReset'),
      sculptHint: q('#l3SculptHint'),
      curveSvg: q('#l3CurveSvg'),
      texView: q('#l3TexView'),
      texCanvas: q('#l3TexCanvas'),
      texVeil: q('#l3TexVeil'),
      texRegions: q('#l3TexRegions'),
      texRegionHint: q('#l3TexRegionHint'),
      texSize: q('#l3TexSize'),
      texSizeVal: q('#l3TexSizeVal'),
      texColor: q('#l3TexColor'),
      texTol: q('#l3TexTol'),
      texTolVal: q('#l3TexTolVal'),
      texUndo: q('#l3TexUndo'),
      texRedo: q('#l3TexRedo'),
      texReset: q('#l3TexReset'),
      texExport: q('#l3TexExport'),
      texApply: q('#l3TexApply'),
      adjBright: q('#l3AdjBright'),
      adjContrast: q('#l3AdjContrast'),
      adjSat: q('#l3AdjSat'),
      adjApply: q('#l3AdjApply'),
      repFrom: q('#l3RepFrom'),
      repTo: q('#l3RepTo'),
      repRun: q('#l3RepRun')
    };
  }

  function boot(body) {
    var saved = loadStore();
    var coilState = loadCoils();
    S = {
      body: body,
      msgs: saved.msgs,
      voiceOn: saved.voiceOn,
      styleLabel: saved.style,
      busy: false,
      abort: null,
      audio: null,
      face: null,
      player: null,
      raf: 0,
      clock: 0,
      lastMouth: 0,
      morphCount: 0,
      mouth: { queue: '', acc: 0, pulse: 0, pulseUntil: 0, open: 0, viseme: 'sil', ttsUntil: 0, ttsTick: 0 },
      blink: { t: 0, next: rand(1.4, 3.4), phase: 0, value: 0 },
      browPulse: { L: 0, R: 0 },
      keysBound: false,
      shape: loadShape(),
      coils: coilState.coils,
      coilOn: coilState.on,
      coilDrag: null,
      outline: loadOutline(),
      outlineOn: true,
      outlineDrag: null,
      xform: loadXform(),
      regionDrag: null,
      shapeHist: { stack: [], index: -1 },
      presetName: '',
      presets: loadCustomPresets(),
      drawerTab: 'chat',
      gizmoOn: true,
      gizmoGroup: '轮廓',
      gizmoKey: 'width',
      gizmoDrag: null,
      texPanelBound: false,
      tex: {
        ready: false,
        canvas: null,
        ctx: null,
        tool: 'brush',
        color: '#e05a5a',
        size: 36,
        tolerance: 36,
        zoom: 1,
        undo: [],
        redo: [],
        drawing: false,
        last: null,
        pan: null,
        regionKey: 'all',
        maskId: 0,
        regionList: [{ key: 'all', label: '全部', id: 0 }],
        maskIds: null,
        maskCanvas: null,
        scratch: null,
        scratchCtx: null
      }
    };
    cacheRefs();
    bind();
    S.shapeHist.stack = [shapeStateOf()];
    S.shapeHist.index = 0;
    buildShapePane();
    renderShapePresets();
    paintShapeButtons();
    setGizmoGroup('轮廓');
    renderCurve();
    bindTexturePanel();
    registerTexBlobRoot();
    renderMsgs();
    syncVoiceBtn();
    fillVoices();
    body.dataset.ready = '1';
    setStatus('正在加载脸模…', '');
    loadFace();

    /* 调试口：探针用它读取形态键、切换表情、验证口型 */
    window.__lumen3d = function () {
      if (!S || !S.face || !S.player) return null;
      return {
        ready: true,
        morphs: S.face.morphNames.length,
        styles: S.player.styles.length,
        labels: S.player.labels.filter(function (label, index, list) { return list.indexOf(label) === index; }),
        current: S.player.style.label,
        mouthOpen: S.mouth.open,
        blink: S.blink.value,
        influence: function (name) { return S.face.influence(name); },
        peak: function () { return S.face.peak(); },
        play: function (label) { playLabel(label); return S.player.style.label; },
        setMouth: function (viseme, open) {
          S.mouth.viseme = viseme || 'aa';
          S.mouth.open = clamp(Number(open) || 0, 0, 1);
          S.mouth.pulseUntil = S.clock + 2;
          S.mouth.ttsUntil = S.clock + 2;
        },
        shape: function (name) { return S.shape ? S.shape[name] : null; },
        setShape: function (name, value) { return setShapeValue(name, value, false); },
        shapeValues: function () { return cloneShape(S.shape); },
        shapeUniforms: function () { return S.face ? S.face.shapeUniforms() : null; },
        shapePreset: function () { return S.presetName; },
        applyPreset: applyPreset,
        randomShape: function () { randomShape(); return cloneShape(S.shape); },
        undoShape: undoShape,
        redoShape: redoShape,
        shapeHistory: function () {
          return { index: S.shapeHist.index, size: S.shapeHist.stack.length };
        },
        savePreset: function (name) {
          if (!S.refs.shapeSaveName) return null;
          S.refs.shapeSaveName.value = name;
          return saveCurrentPreset();
        },
        deletePreset: deletePreset,
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,
        drawerTab: function () { return S.drawerTab; },
        gizmos: function () {
          var layer = ensureGizmoLayer();
          if (!layer) return [];
          return Array.prototype.map.call(layer.querySelectorAll('.l3-gizmo'), function (handle) {
            var key = handle.getAttribute('data-gizmo');
            var pos = S.face ? S.face.projectAnchor(key) : null;
            return {
              key: key,
              label: handle.querySelector('.l3-gizmo-tag').textContent,
              x: pos ? Math.round(pos.x) : 0,
              y: pos ? Math.round(pos.y) : 0,
              visible: !!pos && pos.visible && handle.style.display !== 'none'
            };
          });
        },
        gizmoGroup: function () { return S.gizmoGroup; },
        gizmoKey: function () { return S.gizmoKey; },
        setGizmoGroup: setGizmoGroup,
        setGizmoOn: setGizmoOn,
        gizmoHighlight: function () {
          return S.face ? S.face.shapeUniforms() : null;
        },
        faceHighlight: function () {
          return S.face && S.face.faceHighlight ? S.face.faceHighlight() : null;
        },
        coilOn: function () { return S.coilOn; },
        setCoilOn: setCoilOn,
        coils: function () {
          var out = {};
          Object.keys(S.coils).forEach(function (key) { out[key] = S.coils[key].slice(); });
          return out;
        },
        setCoil: function (key, values) { return applyCoil(key, values, true); },
        resetCoil: resetCoil,
        /* 面部轮廓：探针靠这一组验证「手柄画在哪、脸就动在哪」 */
        outline: function () { return (S.outline || defaultOutline()).slice(); },
        /* 手柄读数必须和真正送进 shader 的 uniform 一致：两处只要有一处忘了写，
         * 界面上的倍率就是假的（看着拖了、脸没动） */
        outlineUniform: function () { return S.face && S.face.outlineValues ? S.face.outlineValues() : null; },
        setOutline: function (list) { return applyOutline(list, true); },
        resetOutline: function () { return applyOutline(defaultOutline(), true); },
        outlineNodes: function () { return S.face && S.face.projectOutline ? S.face.projectOutline() : []; },
        outlineHandles: function () {
          var layer = S.refs.canvasHost && S.refs.canvasHost.querySelector('.l3-outline');
          if (!layer) return [];
          return Array.prototype.map.call(layer.querySelectorAll('[data-out-index]'), function (handle) {
            return {
              index: Number(handle.getAttribute('data-out-index')),
              side: handle.getAttribute('data-out-side'),
              k: Number(handle.getAttribute('data-out-k') || 1),
              changed: handle.classList.contains('is-changed'),
              shown: layer.classList.contains('is-off') === false && handle.style.display !== 'none',
              x: parseFloat(handle.style.left) || 0,
              y: parseFloat(handle.style.top) || 0
            };
          });
        },
        outlineShown: outlineShown,
        setOutlineOn: setOutlineOn,
        projectCoil: function (key) { return S.face ? S.face.projectCoil(key) : null; },
        projectRegion: function (kind) { return S.face && S.face.projectRegion ? S.face.projectRegion(kind) : null; },
        regionFrames: function () { return S.face && S.face.regionFrames ? S.face.regionFrames() : null; },
        materialParts: function () { return S.face && S.face.materialParts ? S.face.materialParts() : []; },
        regionWeight: function (kind, au, v) {
          return S.face && S.face.regionWeight ? S.face.regionWeight(kind, au, v) : 0;
        },
        partStats: function () { return S.face && S.face.partStats ? S.face.partStats() : null; },
        partBounds: function () { return S.face && S.face.partBounds ? S.face.partBounds() : null; },
        deformSource: function () { return S.face && S.face.deformSource ? S.face.deformSource() : ''; },
        gizmoGain: function (key) { return S.face && S.face.gizmoGain ? S.face.gizmoGain(key) : [0, 0]; },
        xform: function () { return S.face && S.face.currentXform ? S.face.currentXform() : null; },
        /* 覆层掩码：{ region: 'eye' | 'mouth' } 或 { coil: [...] }，strength 0–1。
         * 亮到哪就是真的动到哪 —— 探针/截图靠它确认掩码有没有盖住睫毛。 */
        setHighlight: function (mask, strength) {
          return S.face && S.face.setHighlight ? S.face.setHighlight(mask, strength) : null;
        },
        setXform: function (kind, values) { return applyXform(kind, values, true); },
        resetXform: resetXform,
        regionHandles: function () {
          var layer = S.refs.canvasHost && S.refs.canvasHost.querySelector('.l3-region');
          if (!layer) return [];
          return Array.prototype.map.call(layer.querySelectorAll('.l3-region-handle'), function (button) {
            return {
              role: button.getAttribute('data-region-role'),
              side: Number(button.getAttribute('data-side')),
              x: Math.round(parseFloat(button.style.left) || 0),
              y: Math.round(parseFloat(button.style.top) || 0),
              visible: button.style.display !== 'none'
            };
          });
        },
        /* 范围手柄现状：每个手柄的可用轴与是否被摆出来。
         * 钳死在脸上的边（拖不动的死区）必须是 display:none。 */
        coilHandles: function () {
          var layer = S.refs.canvasHost && S.refs.canvasHost.querySelector('#l3Coil');
          if (!layer) return [];
          return Array.prototype.map.call(layer.querySelectorAll('[data-coil-edge]'), function (button) {
            return {
              role: button.getAttribute('data-coil-edge'),
              axis: button.getAttribute('data-axis'),
              tip: button.getAttribute('data-tip'),
              visible: button.style.display !== 'none'
            };
          });
        },
        /* 选区现状：面高亮 + 手柄可见性。
         * legacyCurve 专门给回归测试用：它必须是 0，证明「3D 曲线曲面」确实下线了。 */
        selection: function () {
          var host = S.refs.canvasHost;
          var coilLayer = host && host.querySelector('.l3-coil');
          var regionLayer = host && host.querySelector('.l3-region');
          return {
            highlight: S.face && S.face.faceHighlight ? S.face.faceHighlight() : null,
            handles: {
              coil: !!coilLayer && !coilLayer.classList.contains('is-off'),
              region: !!regionLayer && !regionLayer.classList.contains('is-off')
            },
            legacyCurve: host ? host.querySelectorAll('.l3-sel-fill, .l3-sel-ants').length : 0
          };
        },
        curvePoints: function () {
          var svg = S.refs.curveSvg;
          if (!svg) return [];
          return Array.prototype.map.call(svg.querySelectorAll('[data-curve]'), function (point) {
            return {
              key: point.getAttribute('data-curve'),
              x: Number(point.getAttribute('cx')),
              y: Number(point.getAttribute('cy'))
            };
          });
        },
        curvePath: function () {
          var path = S.refs.curveSvg && S.refs.curveSvg.querySelector('.l3-curve-face');
          return path ? path.getAttribute('d') : '';
        },
        texture: function () {
          return S.tex.ready
            ? { ready: true, width: S.tex.canvas.width, height: S.tex.canvas.height }
            : { ready: false, width: 0, height: 0 };
        },
        texturePixel: function (x, y) {
          if (!S.tex.ready) return null;
          var data = S.tex.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
          return [data[0], data[1], data[2], data[3]];
        },
        textureRegion: function () {
          return {
            key: S.tex.regionKey,
            id: S.tex.maskId,
            zoom: S.tex.zoom,
            list: (S.tex.regionList || []).map(function (item) {
              return { key: item.key, label: item.label, pixels: item.pixels || 0 };
            })
          };
        },
        setTextureRegion: function (key) { texSetRegion(key, true); return S.tex.regionKey; },
        regionAt: function (x, y) {
          var ids = S.tex.maskIds;
          if (!ids) return 0;
          return ids[Math.floor(y) * S.tex.canvas.width + Math.floor(x)] || 0;
        },
        paintTexture: function (x, y) {
          if (!S.tex.ready) return false;
          texStamp(Number(x) || 0, Number(y) || 0);
          texPreview();
          return true;
        },
        applyTexture: texApply
      };
    };
  }

  /* ---------- 注册 ---------- */
  registerApp({
    id: 'lumen3d',
    name: '流明3D',
    title: '流明3D · 三维数字人',
    sub: '参考脸 + 自然语言表情，可对话、可朗读',
    icon: ICON,
    order: 17,
    cls: 'lumen3d',
    win: 'lumen3dWin',
    css: ['apps/lumen3d/app.css'],
    body: BODY_HTML,
    mount: function (body) {
      if (S && S.body === body && body.dataset.ready === '1') {
        /* 切回来只同步状态：不重建 DOM，canvas 与聊天记录都保留 */
        syncVoiceBtn();
        fillVoices();
        return;
      }
      boot(body);
    }
  });
})();
