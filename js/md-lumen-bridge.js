/* js/md-lumen-bridge.js —— 流明头模 → 建模 App 的「桥」
 *
 * 定位：这**不是**另做一套头模，是读流明 3D 已有的那一份资产。
 *   流明 3D（apps/lumen3d）的参考脸打包在 model/ 下：face-meta.js（清单 + 骨骼 + 贴图）、
 *   face-geometry.js（13.9MB base64 顶点缓冲）、face-curves.js（表演曲线，本桥不碰）。
 *   本文件只做两件事：
 *     ① 需要时把那两个数据包读进来（script 注入 · 只读一次 · 全程只读）；
 *     ② 把清单里的 Body 网格翻译成一份 BufferGeometry（position/normal/uv/索引 + 112 个形态键）。
 *   不做的：流明的 UI、形态键操控器、表演曲线、面部 shader、骨骼动画 —— 那是流明自己的事。
 *
 * 为什么是「桥」而不是「复制」：
 *   同一份顶点、同一套形态键名字（vrc.v_aa / mouth_a / sp_cheek…）。在建模 App 里改完的形状，
 *   名字对得上就能原路回去；如果这里另造一套「二次元头」，两边永远对不齐。
 *
 * ⚠ 唯一的耦合点就是下面 ASSET_BASE 这一条路径。改流明的资源目录只改这里。
 *   反过来，流明不知道本文件存在 —— 删掉 js/md-lumen-bridge.js，流明照跑，
 *   建模 App 的「＋ 组件」面板只会说「没有可用的组件源」。
 */
(function () {
  'use strict';

  /* ---------------- 0. 数据源 ---------------- */

  var ASSET_BASE = 'apps/lumen3d/model/';
  var FILES = ['face-meta.js', 'face-geometry.js'];

  var cache = null;      /* 解码结果，一次就够 */
  var loading = null;    /* 载入中的 promise：并发点两次「＋组件」只注入一遍 */

  function inject(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('读不到 ' + src)); };
      document.head.appendChild(s);
    });
  }

  function hasPack() {
    return !!(window.LUMEN3D_META && window.LUMEN3D_GEOMETRY);
  }

  /* base64 → ArrayBuffer。13.9MB 的串，逐字符填 Uint8Array 是这里唯一的重活；
   * 比 atob 之后 decodeURIComponent(escape(...)) 那套稳，也不会因非法字符静默截断。 */
  function b64ToBuffer(b64) {
    var bin = window.atob(b64);
    var n = bin.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function f32(ab, desc) {
    if (desc.offset < 0 || desc.count < 0 || desc.offset + desc.count * 4 > ab.byteLength) {
      throw new Error('几何属性超出缓冲区（清单与数据包不配套）');
    }
    return new Float32Array(ab, desc.offset, desc.count);
  }
  function u32(ab, desc) {
    return new Uint32Array(ab, desc.offset, desc.count);
  }
  /* 骨架与几何**不在同一个 z 手性**上：清单里 LeftEye/RightEye 的 position z=−0.032，
   * 而眼球顶点质心 z=+0.040（差 81mm ≈ 半个头深）。这不是清单写错了 ——
   * 流明在 apps/lumen3d/app.js:739 用 `model.scale.z = -1` 把**骨架和网格一起翻**，
   * 翻了之后关节正好落在眼球后面 7mm（一颗眼球的半径），所以它转眼球是自转。
   *
   * 我们的桥只搬顶点、不翻任何东西（建模 App 的正面相机在 +Z），所以 skin 里带
   * `flipZ: true`，由 App 给骨骼树套一层 `scale.z = -1` 的父级 —— 等价于流明那一步，
   * 局部变换一个都不用改（整树镜像时各节点局部变换不变）。
   *
   * ⚠ 不要去挪单个关节来「修枢轴」：rest 由实测逆矩阵保证恒等，挪完看着一样，
   *   但枢轴实测仍在脑后 80mm，转眼球变成整颗平移 —— 症状正是「没有看向相机」。 */

  /* 解包：只认 schema，不猜结构。清单里 Body 就是整颗头（y≈1.13–1.34 的那 20cm），
   * 10818 是 **float 个数**，顶点数是它 /3 —— 这个数第一版读错过一次。 */
  function decode() {
    var meta = window.LUMEN3D_META;
    var b64 = window.LUMEN3D_GEOMETRY;
    if (!meta || !b64) throw new Error('流明数据包缺失');
    if (!meta.avatar || meta.avatar.schema !== 'lumen.web.avatar.v1') {
      throw new Error('脸模清单格式不支持（' + (meta.avatar && meta.avatar.schema) + '）');
    }
    var ab = b64ToBuffer(b64);
    var meshes = (meta.avatar.meshes || []);
    var mesh = null;
    for (var i = 0; i < meshes.length; i++) {
      if (meshes[i].morphs && meshes[i].morphs.length) { mesh = meshes[i]; break; }
    }
    if (!mesh) throw new Error('清单里没有带形态键的网格');
    if (!mesh.position || mesh.position.itemSize !== 3) throw new Error('position 属性不合法');
    var verts = Math.floor(mesh.position.count / 3);

    /* 形态键：以「-」开头的是分组标题行（----LIPSYNC&ETC----），不是真形态键，
     * 流明自己也跳过它们（app.js: name.charAt(0) === '-'）。这里直接剔掉，
     * 免得面板里冒出 5 个永远没效果的下拉项。 */
    var morphs = [];
    (mesh.morphs || []).forEach(function (m, idx) {
      if (!m || !m.name || m.name.charAt(0) === '-') return;
      if (!m.position || m.position.count !== mesh.position.count) return;
      morphs.push({ name: m.name, index: idx, desc: m.position });
    });
    /* 每个键的位移量级（米）：**面板要靠它分辨「这个键有没有内容」**。
     * 112 个键里有一批幅度只有 0.1mm 级（是给微调用的），还有几个整键为 0
     * （作者留的分组占位）。没有这个数，用户选到空键拖滑杆会以为控件坏了 ——
     * 而界面上不会有任何报错，只有一个「什么都没发生」。
     * 取最大分量（Chebyshev）而不是欧氏长度：只是想量「动没动」，不必开方。
     * 代价是 decode 时多扫 0.4M 个顶点（~10ms），随资产读取一次付清。 */
    morphs.forEach(function (mo) {
      var d = f32(ab, mo.desc), mx = 0;
      for (var i = 0; i < d.length; i += 3) {
        var ax = d[i] < 0 ? -d[i] : d[i];
        var ay = d[i + 1] < 0 ? -d[i + 1] : d[i + 1];
        var az = d[i + 2] < 0 ? -d[i + 2] : d[i + 2];
        var s = ax > ay ? (ax > az ? ax : az) : (ay > az ? ay : az);
        if (s > mx) mx = s;
      }
      mo.amp = mx;
    });

    /* 包围盒（原始坐标）：用来居中 + 定剪影比例。必须遍历真实顶点，
     * 不能拿清单里的 preview_height 顶替 —— 那是整具角色的。 */
    var pos = f32(ab, mesh.position);
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var v = 0; v < pos.length; v += 3) {
      for (var k = 0; k < 3; k++) {
        var t = pos[v + k];
        if (t < min[k]) min[k] = t;
        if (t > max[k]) max[k] = t;
      }
    }

    /* ---------- 眼片（真正「会动的眼睛」）的规格：用资产自己的形态键自标定 ----------
     * 这颗头**不是**靠那两颗眼球几何看人的：FaceEyes 那 1800 个三角被皮肤整片挡住
     * （染色实测全隐 —— 把 mats[1] 染红、不透明、写深度，屏幕上一点红都没有；
     *  把 mats[0] 染绿，整颗头连眼睛一起变绿）。眼睛是画在皮肤贴图上的一层。
     *
     * 作者给它的转向通道就是 eyeshighlight_move_L / _R：
     *   实测 288 顶点、位移均值 (−2.25, 0, 0) / (+2.89, 0, 0) mm、**标准差 0.00**
     *   —— 纯刚体平移、只沿 x、两只眼同向（L 键 = 两只眼一起看左）。
     * 所以这里一个数都不猜：拿这两个键的位移顶点取包围盒，就是眼片的范围；
     * 位移量也直接取实测值。建模 App 拿它做**连续**的区域位移（跟着相机平滑转，
     * 不是开关），这比转那两颗看不见的眼球有效，也和流明 l3Deform 的做法同构
     * （apps/lumen3d/app.js:989 在 `#include <skinning_vertex>` 之后位移顶点，
     *  掩码用原始 position 现算 —— 我们照抄这个位置和口径）。 */
    var eyeSheet = (function () {
      var hit = morphs.filter(function (m) { return /^eyeshighlight_move_/i.test(m.name); });
      if (!hit.length) return null;
      var cen = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      var lx0 = Infinity, lx1 = -Infinity, rx0 = Infinity, rx1 = -Infinity;
      var y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      var maxAbs = 0, cnt = 0, seen = Object.create(null);
      hit.forEach(function (m) {
        var d = f32(ab, m.desc);
        for (var v = 0; v < verts; v++) {
          var dx = d[v * 3], dy = d[v * 3 + 1], dz = d[v * 3 + 2];
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-6) continue;
          cnt++;
          if (Math.abs(dx) > maxAbs) maxAbs = Math.abs(dx);
          if (seen[v]) continue;
          seen[v] = 1;
          /* 与 buildGeometry 的 position 同一个口径：减掉包围盒中心 */
          var px = pos[v * 3] - cen[0], py = pos[v * 3 + 1] - cen[1], pz = pos[v * 3 + 2] - cen[2];
          if (px < 0) { if (-px < lx0) lx0 = -px; if (-px > lx1) lx1 = -px; }
          else { if (px < rx0) rx0 = px; if (px > rx1) rx1 = px; }
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
        }
      });
      if (!cnt || !isFinite(lx0) || !isFinite(rx0)) return null;
      /* 单眼圆心：|x| 的里沿到外沿取中（左右取平均，消掉资产本身的不对称）。
       * ⚠ inner / outer 是两个**不同**的量：inner = 里沿的最小值（离中线最近的代表），
       *   outer = 外沿的最大值。第一版把外沿也取了 min，半径算成 1mm（横向全废），
       *   而偏置量级看起来还「对」，所以不会报错 —— 只会表现为「眼睛只上下动」。
       * 半径：贴片只圈住「虹膜 + 高光」，而眼皮 / 眼白要跟着一起走，
       * 所以横向 ×1.15、纵向 ×1.6（纵向外扩更多是量出来的：贴片盒只有 1.5mm 高，
       * 直接当掩码会让眼白留在原地、只把瞳孔拽走）。 */
      var inner = Math.min(lx0, rx0);
      var outer = Math.max(lx1, rx1);
      var cx = (inner + outer) / 2;
      var cy = (y0 + y1) / 2;
      return {
        center: [+cx.toFixed(4), +cy.toFixed(4)],
        radius: [+(((outer - inner) / 2) * 1.15).toFixed(4), +(((y1 - y0) / 2) * 1.6).toFixed(4)],
        /* 正脸闸门：低于贴片下沿 20mm 才开始放行，确保后脑 / 脖子不被拽动
         * （流明同款做法：`l3EyeSkinMask(au,v) * smoothstep(0.005, 0.020, z)`）。 */
        zGate: [+(z0 - 0.020).toFixed(4), +(z0 - 0.003).toFixed(4)],
        /* 幅度（米）：**在视线限幅处**的位移量，不是「yaw=90° 时」的量。
         * 差这一步会差 3 倍 —— 限幅 16°，sin(16°)=0.28，若把 sway 当 yaw=90° 的幅值，
         * 实际只会走 1.0mm（约 2px），看起来仍然「没动」。App 用
         * sin(yaw)/sin(swayAt) 归一，所以这两个数就是画面上能看到的最大位移。
         *
         * 取值要换算，不能直接抄资产那 2.89mm：那是按**真实眼径**算的表情幅度，
         * 而这是个两倍头身的卡通脸 —— 屏幕上量出来虹膜直径约是头宽的 1/3（≈54mm），
         * 眼球半径 ≈27mm，转 16° 的位移应是 27·sin16° ≈ 7.4mm，是 2.89 的 2.6 倍。
         *
         * 幅度**就用资产原值**（横向 2.89mm / 纵向 2.89mm 那对键的实测值），不再放大：
         *   · 这是「照抄」的口径 —— 流明也是这个量级，效果已经由它验证过；
         *   · 放大会把贴图层拉伸（实测 7.5mm 时虹膜外缘被压成一条扁丝），
         *     那是**副作用**，不是「眼睛转得更多」；
         *   · 更关键：位移只发生在 GPU，顶点数组不被改写（见 tools/probe-md-restore.js），
         *     幅度怎么调都不影响「数据可还原」这条底线。
         * 纵向没有实测值（那两个键的位移全是 x 方向、y 恒为 0），按同量级给。 */
        sway: [+maxAbs.toFixed(4), +maxAbs.toFixed(4)],
        /* 对应的视线限幅（弧度）：上限幅处 = sway。两个轴限幅不同，所以要一对。 */
        swayAt: [GAZE_YAW, GAZE_PITCH],
        verts: Object.keys(seen).length,
        maxShift: +maxAbs.toFixed(4)
      };
    })();

    var ctr = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

    /* ---------- 视口控制器的锚点：全部由**顶点簇自己量出来** ----------
     * 一根杆 = 一个区域的一组形态键。锚点取「受这些键影响的顶点在 rest 下的质心」，
     * 不是手填坐标：换一份资产、换一个头的比例，杆自己跟到脸上。
     *
     * 坐标是 **App 的局部坐标**（资产坐标 − center）：App 只做 localToWorld，
     * 不需要知道这里面有平移这回事。
     *
     * ⚠ 这个用户点名的「二次元眼睛」（星星 / 爱心 / 圈圈）是 z≈+20mm 的**表情件**，
     *   藏在脑袋内部（见 eye_star / eye_heart 的质心 z 都只有 13–23mm）。
     *   它们是「不用时藏起来」的可替换件，不适合当常驻控制器 —— 摆在脸上会指向后脑。
     *   所以这里挑的全是**皮肤上的表情键**（z≈55–73mm）。
     * ⚠ eye_close 故意不在表里：它是**运行时通道**（自动眨眼每帧写同一个键），
     *   控制器再写一次就成了两个源抢一个键，眨眼会抖。 */
    var CTRL_SPEC = [
      { id: 'eyeSmile', label: '眼笑', color: 'eye', keys: ['eye_smile'], dx: -0.009 },
      { id: 'squint', label: '眯眼', color: 'eye', keys: ['eye_small_L', 'eye_small_R'], dx: 0.009 },
      { id: 'mouthOpen', label: '张嘴', color: 'mouth', keys: ['mouth_a'], dx: -0.011 },
      { id: 'mouthSmile', label: '微笑', color: 'mouth', keys: ['mouth_smile_1', 'mouth_smile_2'], dx: 0.011 },
      { id: 'browL', label: '左眉', color: 'brow', keys: ['eyebrow_up_L'] },
      { id: 'browR', label: '右眉', color: 'brow', keys: ['eyebrow_up_R'] },
      /* 脸颊的簇质心正好在两眼与嘴之间，和上面四根撞在同一列：
       * 往右挪 16mm，落在脸颊外侧 —— 区域本身有一百多颗顶点，偏一点仍是它 */
      { id: 'cheek', label: '脸颊', color: 'cheek', keys: ['sp_cheek'], dx: 0.016 }
    ];
    /* 单键的簇质心（资产坐标，rest 状态）：没有位移的键返回 null，那条杆就不出现 ——
     * 摆一根拖了没反应的杆比不摆更糟（用户会以为坏掉了）。 */
    function clusterOf(name) {
      var mo = findMorph({ morphs: morphs }, name);
      if (!mo || !mo.desc) return null;
      var d = f32(ab, mo.desc);
      var sx = 0, sy = 0, sz = 0, n = 0;
      for (var v = 0; v < verts; v++) {
        var o = v * 3;
        if (Math.abs(d[o]) + Math.abs(d[o + 1]) + Math.abs(d[o + 2]) < 3e-5) continue;
        n++;
        sx += pos[o]; sy += pos[o + 1]; sz += pos[o + 2];
      }
      if (!n) return null;
      return { c: [sx / n, sy / n, sz / n], n: n, amp: mo.amp || 0 };
    }
    var controls = [];
    CTRL_SPEC.forEach(function (sp) {
      var sum = [0, 0, 0], total = 0, amp = 0, found = [];
      sp.keys.forEach(function (k) {
        var cl = clusterOf(k);
        if (!cl) return;
        found.push(k);
        sum[0] += cl.c[0] * cl.n; sum[1] += cl.c[1] * cl.n; sum[2] += cl.c[2] * cl.n;
        total += cl.n;
        if (cl.amp > amp) amp = cl.amp;
      });
      if (!total) return;
      controls.push({
        id: sp.id, label: sp.label, color: sp.color,
        keys: found,
        /* 主键：面板里拖滑杆 / 搜索默认指向它 */
        key: found[0],
        /* dx 只为了两根杆别叠在一起（眼笑 / 眯眼、张嘴 / 微笑同区域），
         * 纵向一律不偏 —— 偏了就不像那块区域了。 */
        at: [
          +(sum[0] / total - ctr[0] + (sp.dx || 0)).toFixed(5),
          +(sum[1] / total - ctr[1]).toFixed(5),
          +(sum[2] / total - ctr[2]).toFixed(5)
        ],
        amp: +(+amp).toFixed(5),
        verts: total
      });
    });

    return {
      meta: meta, ab: ab, mesh: mesh, verts: verts, morphs: morphs,
      min: min, max: max,
      eyeSheet: eyeSheet,
      controls: controls,
      center: ctr,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      tex: meta.texture || null,
      /* 清单里的材质表：两个组各有语义（FaceSurface 不透明 / FaceEyes 透明叠层）。
       * 建模 App 按 group 建材质时要照抄这些开关，否则眼睛那一层会被皮肤整个挡住
       * （见 buildGeometry 里的 mdGroupMats）。 */
      mats: meta.avatar.materials || [],
      /* 每个 primitive 对应的材质语义，按清单原样算一次（不猜）：
       * FaceEyes 在清单里就是 transparent + depthWrite:false —— 它是**叠在皮肤上的一层**，
       * 按不透明画会被皮肤整片挡住（流明自己的注释也写了这点，
       * apps/lumen3d/app.js:455）。 */
      groupMats: (mesh.primitives || []).map(function (pr) {
        var m = (meta.avatar.materials || [])[pr.material] || {};
        return {
          name: m.name || '',
          transparent: !!m.transparent,
          opacity: (m.color && m.color[3] != null) ? Number(m.color[3]) : 1,
          alphaTest: Number(m.alphaTest) || 0,
          depthWrite: !m.transparent,
          doubleSide: true
        };
      }),
      /* 蒙皮：清单里一直都有（skinIndex / skinWeight / bones / inverseBind / joints），
       * 第一版没搬 —— 代价是头模在建模 App 里变成**静态脸皮**，眼睛只能靠贴图平移。
       * 而这张贴图上的眼睛几乎占满眼白（虹膜直径约等于眼眶），实测 uv 偏 0.03 就露出
       * 眼睑、眼睛直接「闭上」。搬过来之后眼睛是真的绕自己的眼球转：
       * 实测 yaw 8° → 448 个顶点（左右眼各 224）位移最大 5.1mm，眼外顶点位移 0。
       *
       * ⚠ inverseBind **不交给 App 用**（它属于另一个带镜像的坐标系）。
       *   App 会把骨骼摆回 rest 实测一遍，得到严格互逆的一对矩阵；见 model-desk.js。
       * ⚠ 这里给的是**纯数据**，建骨骼 / SkinnedMesh 是建模 App 的事（组件不认识 three）。
       * ⚠ skinIndex 是 float32 存的（不是 u16），count = 顶点数 × 4。 */
      skin: (function () {
        if (!mesh.skinIndex || !mesh.skinWeight || !mesh.inverseBind) return null;
        if (!mesh.bones || !mesh.bones.length) return null;
        if (!meta.avatar.nodes || !meta.avatar.nodes.length) return null;
        if (mesh.skinIndex.count !== verts * 4) return null;
        var cen = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        return {
          nodes: meta.avatar.nodes,
          bones: mesh.bones,
          joints: meta.avatar.joints || {},
          /* 骨架是「脸朝 −Z」那套（见上方手性说明）：App 必须给骨骼树套 scale.z=-1 */
          flipZ: true,
          /* 顶点过桥时会被平移到包围盒中心（buildPoints: p − center），
           * 骨骼必须跟着平移，否则蒙皮会把整张脸挪到头外。 */
          center: cen,
          inverseBind: f32(ab, mesh.inverseBind),
          index: f32(ab, mesh.skinIndex),
          weight: f32(ab, mesh.skinWeight)
        };
      })(),
      /* 通道分组（mouth / eyes / brows / other），用来把 112 项分进 optgroup */
      groups: (function () {
        var map = Object.create(null);
        var chs = (meta.channels && meta.channels.channels) || [];
        chs.forEach(function (c) { if (c && c.name) map[c.name] = c.group || 'other'; });
        return map;
      })()
    };
  }

  function load() {
    if (cache) return Promise.resolve(cache);
    if (loading) return loading;
    loading = Promise.resolve()
      .then(function () { return window.LUMEN3D_META ? null : inject(ASSET_BASE + FILES[0]); })
      .then(function () { return window.LUMEN3D_GEOMETRY ? null : inject(ASSET_BASE + FILES[1]); })
      .then(function () {
        cache = decode();
        loading = null;
        return cache;
      })
      .catch(function (e) {
        loading = null;
        cache = null;
        throw e;
      });
    return loading;
  }

  /* ---------------- 1. 坐标约定 ----------------
   * 数据就在这儿，直接搬，**不做镜像**：
   *   · 清单里 preview_forward = [0,0,1]，实测眼睛子网格质心 z = +0.030、法线也朝 +Z ——
   *     这份资产本来就是「脸朝 +Z、Y 上」，正是建模 App 的约定；
   *   · 流明自己用 model.scale.z = -1 是因为它把相机放在 -Z（app.js updateCamera），
   *     镜像只是把那台相机补偿回来。我们照抄镜像，脸就朝 -Z 了 —— 实测「前视图」看到的是后脑勺
   *     （两只耳朵在下方、中间是脖子），而且绕序/法线跟着全反。
   *   · 唯一要动的是平移：资产里这颗头挂在 y≈1.23 的脖子上，拿出来要回到自己中心。
   * 代价：左右手性和流明屏幕上的镜像版相反（近对称的脸看不出来），换来坐标约定一致。 */

  /* 参数形状：{ main: '当前编辑的键', weights: { 键名: 0..100 }, expr: '表情 id' }
   *
   * 为什么不是「一个形态键 + 一个强度」：
   *   表情从来不是一个键。微笑 = 嘴角 + 眼 + 眉 三四个键一起动，少了任何一个都像面瘫。
   *   流明自己也是这么驱动的（channels 里 112 个键可以同时置值），
   *   所以这一份 params 必须**能叠加**，这也是本组件「有自己属性」的地方 ——
   *   普通组件只有一组静态参数，它多一层「若干个形态键各自的权重」。 */
  function weightsOf(p) {
    var out = [];
    var ws = (p && p.weights) || null;
    if (!ws) return out;
    for (var n in ws) {
      if (!Object.prototype.hasOwnProperty.call(ws, n)) continue;
      var w = clamp01((Number(ws[n]) || 0) / 100);
      if (w <= 0) continue;
      var m = findMorph(cache, n);
      if (m) out.push({ m: m, w: w });
    }
    return out;
  }

  function buildPoints(p) {
    var d = cache;
    if (!d) throw new Error('流明资产还没载入');
    var N = d.verts;
    var pos = f32(d.ab, d.mesh.position);
    var nor = d.mesh.normal ? f32(d.ab, d.mesh.normal) : null;

    var P = new Float32Array(N * 3);
    var Nn = nor ? new Float32Array(N * 3) : null;
    var cx = d.center[0], cy = d.center[1], cz = d.center[2];
    for (var i = 0; i < N; i++) {
      var o = i * 3;
      P[o] = pos[o] - cx;
      P[o + 1] = pos[o + 1] - cy;
      P[o + 2] = pos[o + 2] - cz;
      if (Nn) { Nn[o] = nor[o]; Nn[o + 1] = nor[o + 1]; Nn[o + 2] = nor[o + 2]; }
    }
    /* 多键叠加：一个键整趟累加（3606 个顶点），比「逐顶点查表」简单也更快。 */
    var act = weightsOf(p);
    for (var a = 0; a < act.length; a++) {
      var D = f32(d.ab, act[a].m.desc), w = act[a].w;
      for (var v = 0; v < N; v++) {
        var oo = v * 3;
        P[oo] += D[oo] * w;
        P[oo + 1] += D[oo + 1] * w;
        P[oo + 2] += D[oo + 2] * w;
      }
    }
    return { P: P, N: Nn };
  }

  function findMorph(d, name) {
    if (!name) return null;
    for (var i = 0; i < d.morphs.length; i++) if (d.morphs[i].name === name) return d.morphs[i];
    return null;
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ---------------- 2. 出几何 ---------------- */

  function headGeometry(p) {
    var THREE = window.THREE;
    if (!THREE) throw new Error('three.js 未加载');
    if (!cache) throw new Error('流明资产还没载入');
    var d = cache;
    /* 顶点永远是**静止**的：选中的表情不烘进坐标，而是作为形态键权重交出去。
     * 烘进去的话「再选一次同一个键」会叠加两次，而且文档里就分不清哪部分是人改的。 */
    var pts = buildPoints(null);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts.P, 3));
    if (pts.N) geo.setAttribute('normal', new THREE.BufferAttribute(pts.N, 3));
    var uvDesc = d.mesh.uv;
    if (uvDesc) {
      /* uv 是 view，交给 BufferGeometry 并不会被改；fromBufferGeometry 会拷走 */
      geo.setAttribute('uv', new THREE.BufferAttribute(f32(d.ab, uvDesc), 2));
    }

    /* 索引：清单按材质切成两个 primitive（0 = 皮肤 FaceSurface / 1 = 眼睛 FaceEyes），
     * 两段索引不重叠，合成一张表 + 两个 group 就能在建模 App 里按材质槽区分。
     * 绕序原样搬：源几何的叉乘法线与顶点法线 93% 同向（4992/5358），本来就是朝外的，
     * 一动它就要成对改法线，不该在这里做的事就不做。 */
    var prims = d.mesh.primitives || [];
    var parts = prims.map(function (pr) { return u32(d.ab, pr.indices); });
    var total = parts.reduce(function (a, b) { return a + b.length; }, 0);
    var IDX = total > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    var at = 0, start = 0;
    parts.forEach(function (src, gi) {
      IDX.set(src, at);
      at += src.length;
      geo.addGroup(start, src.length, gi);
      start += src.length;
    });
    geo.setIndex(new THREE.BufferAttribute(IDX, 1));

    /* 每个材质组的渲染语义，原样搬清单（apps/lumen3d/app.js:948 建材质时就是这么用的）：
     *   FaceSurface → 不透明、写深度
     *   FaceEyes    → transparent + depthWrite:false，**叠在皮肤上面**
     *
     * ⚠ 这不是「美化」而是**能不能看见眼球转动**的前提：两组的三角形几乎共面，
     *   皮肤先画且写深度，眼睛那层若当不透明画就会被深度测试整片剔掉 ——
     *   于是转眼球骨骼时皮肤上的眼睛纹丝不动，看起来就是「眼球完全没动」。
     *   流明自己的注释也写了这层关系（apps/lumen3d/app.js:455「FaceEyes 整块被皮肤挡住」）。 */
    geo.userData.mdGroupMats = prims.map(function (pr) {
      var m = (d.mats && d.mats[pr.material]) || {};
      return {
        name: m.name || '',
        transparent: !!m.transparent,
        opacity: (m.color && m.color[3] != null) ? Number(m.color[3]) : 1,
        alphaTest: Number(m.alphaTest) || 0,
        depthWrite: !m.transparent,
        doubleSide: true
      };
    });

    /* 形态键：全量保留（这就是「桥」的意义）。
     * 只搬 position 的位移，不搬法线位移 —— three 的 morphAttributes.normal 会让 GPU 再吃
     * 一份同量级的数据，而建模 App 的 mesh.morphs 只认位移（SeedModel 里 morph 就是 deltas）。 */
    var names = [], weights = [];
    var ws = (p && p.weights) || {};
    var list = d.morphs.map(function (m) {
      var src = f32(d.ab, m.desc);
      var D = new Float32Array(src.length);
      D.set(src);
      names.push(m.name);
      weights.push(clamp01((Number(ws[m.name]) || 0) / 100));
      return new THREE.BufferAttribute(D, 3);
    });
    if (list.length) {
      geo.morphAttributes.position = list;
      geo.morphTargetsRelative = true;
      geo.userData.morphNames = names;
      geo.userData.morphWeights = weights;
    }
    geo.userData.source = 'lumen3d/model/face-meta.js';
    /* 包围盒自己按静止顶点算：three 的 computeBoundingBox() 在 morphTargetsRelative 下
     * 会把 112 个形态键的位移累加着往外扩（包围盒胀到五倍）。这里只算 position。 */
    var bbMin = [Infinity, Infinity, Infinity], bbMax = [-Infinity, -Infinity, -Infinity];
    for (var vi = 0; vi < pts.P.length; vi += 3) {
      for (var kk = 0; kk < 3; kk++) {
        var vv = pts.P[vi + kk];
        if (vv < bbMin[kk]) bbMin[kk] = vv;
        if (vv > bbMax[kk]) bbMax[kk] = vv;
      }
    }
    var box = new THREE.Box3(
      new THREE.Vector3(bbMin[0], bbMin[1], bbMin[2]),
      new THREE.Vector3(bbMax[0], bbMax[1], bbMax[2])
    );
    geo.boundingBox = box;
    geo.boundingSphere = new THREE.Sphere(box.getCenter(new THREE.Vector3()), box.getSize(new THREE.Vector3()).length() / 2);
    return geo;
  }

  /* ---------------- 3. 剪影（面板预览） ----------------
   * 从真实顶点投影出来，不是手画的曲线：换形态键时预览跟着变，
   * 「参数 → 形状」这条链在面板里就是真的。
   *
   * ⚠ 用**凸包**而不是「每行取极值」：极值版在耳朵 / 睫毛那些点簇边界会一行一行地跳，
   *   轮廓看起来像被横着撕开（实测侧脸中间裂出一道横口子）；分位数 + 中值滤波又把它
   *   抹成一块块台阶。凸包是这堆点的**真实外轮廓**，没有可调参数，也不会出现毛刺：
   *   代价只是看不出耳朵和鼻子的凹口，缩略图上没人需要那个。 */
  function silhouette(p, boxH) {
    if (!cache) return null;
    var pts = buildPoints(p).P;
    var n = pts.length / 3;
    var H = Math.max(60, Number(boxH) || 132);
    var ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (var i = 0; i < n; i++) {
      var x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    }
    var spanY = Math.max(ymax - ymin, 1e-4);
    /* 顶上留一行给「正 / 侧」标签：不留的话文字基线落在画布底边，
     * 7px 的字被裁掉一半，缩略图上看起来「什么都没有」，两个轮廓分不清谁是谁。 */
    var TOP = 13;
    var scale = (H - TOP) / spanY;
    var fw = Math.max(10, (xmax - xmin) * scale);
    var sw = Math.max(10, (zmax - zmin) * scale);
    var gap = 16;

    /* Andrew monotone chain：2D 点集 → 逆时针凸包（返回的是屏幕坐标，y 已经翻过） */
    function hull(flat) {
      var q = flat.slice().sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
      function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
      var lower = [], upper = [], k;
      for (k = 0; k < q.length; k++) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q[k]) <= 0) lower.pop();
        lower.push(q[k]);
      }
      for (k = q.length - 1; k >= 0; k--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q[k]) <= 0) upper.pop();
        upper.push(q[k]);
      }
      lower.pop(); upper.pop();
      return lower.concat(upper);
    }
    function poly(flat) {
      var cs = hull(flat);
      return cs.map(function (c, i) { return (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1); }).join('') + 'Z';
    }
    var frontPts = [], sidePts = [];
    for (var j = 0; j < n; j++) {
      var y2 = TOP + (ymax - pts[j * 3 + 1]) * scale;    /* 屏幕 y 向下，顶端留白 */
      frontPts.push([(pts[j * 3] - xmin) * scale, y2]);
      sidePts.push([fw + gap + (pts[j * 3 + 2] - zmin) * scale, y2]);
    }
    return {
      front: poly(frontPts),
      side: poly(sidePts),
      w: Math.round(fw + gap + sw),
      h: Math.round(H),
      frontCx: fw / 2,
      sideCx: fw + gap + sw / 2
    };
  }

  /* ---------------- 4. 自报给建模 App ----------------
   * 这一节是「特殊组件」的分界线：
   *   普通组件只报 fields（参数表），由建模 App 画成滑杆；
   *   流明头模额外报 panel / onEvent / applyTo / props —— 它有自己的面板、
   *   自己的交互、自己「改已有对象」的方式。建模 App 只转发、不认识任何控件。 */

  var GROUP_LABEL = { mouth: '口型', eyes: '眼', brows: '眉', other: '其它' };
  var GROUP_ORDER = ['mouth', 'eyes', 'brows', 'other'];

  /* 搜索词是**界面状态**，不进 params —— params 会进文档、进历史，
   * 「上次搜的是 eye」这种事没有理由跟着模型一起存盘。 */
  var UI_FIND = '';

  /* 「存为表情」的输入框内容。同样只是界面状态：名字一旦存进 mine 就跟着模型走，
   * 而输入到一半的字不该进文档（每敲一个字符就是一次 params 变更 = 一条历史）。 */
  var UI_MINE_NAME = '';
  /* 视口控制器显示哪个分组的操控点（界面状态，不进文档 —— 和搜索词同一性质）。 */
  var UI_GROUP = '轮廓';

  /* 成对的键：捏脸时改左眼就该同时改右眼，不然脸是歪的。
   * 命名规律是 _L / _R 后缀（eye_big_L、eyebrow_smile_R …），但清单里也有
   * 带空格的怪名（eyebrow_move _front_L），所以只按后缀判断、不猜结构。 */
  function mirrorOf(n) {
    if (/_L$/.test(n)) return n.slice(0, -2) + '_R';
    if (/_R$/.test(n)) return n.slice(0, -2) + '_L';
    return null;
  }

  /* 键名对人没有可读性（eye_smile / vrc.v_aa / sp_cheek），分组标题给个中文，
   * 至少知道是哪一类，不用一个词一个词认。 */

  /* 表情预设：一组形态键同时驱动。键名全部取自清单（不是编的）；
   * 流明那边改名后 findMorph 找不到就跳过 —— 少一个键表情会变淡，不会崩。 */
  var EXPR = [
    { id: 'neutral', name: '中性', w: {} },
    { id: 'smile', name: '微笑', w: { mouth_smile_1: 70, eye_smile: 55, eyebrow_smile_L: 30, eyebrow_smile_R: 30 } },
    { id: 'angry', name: '生气', w: { mouth_angry_1: 75, eye_angry: 60, eyebrow_angry_L: 65, eyebrow_angry_R: 65 } },
    { id: 'sad', name: '难过', w: { mouth_short: 45, eye_worry: 60, eyebrow_worry_L: 60, eyebrow_worry_R: 60 } },
    { id: 'surprise', name: '惊讶', w: { mouth_o: 70, eye_surprised: 65, eyebrow_up_L: 70, eyebrow_up_R: 70 } },
    { id: 'aa', name: '张嘴', w: { 'vrc.v_aa': 100 } }
  ];

  /* ---------- 运行时状态：眨眼 ----------
   * 时序照搬流明 3D（apps/lumen3d/app.js:4417 tickBlink）：
   *   0.09s 闭上 → 0.05s 保持 → 0.14s 睁开，然后随机等 2.2–5.2s；
   *   18% 概率连眨（0.3s 后再来一次）。
   * 这套时长不是为了好看：0.28s 一次接近真人眨眼（0.1–0.4s），再快像抽搐，再慢像困了。
   *
   * 它**不进 params**：params 是存盘数据，写进去存盘会记住相位（重开停在半闭眼），
   * 而且每帧一次改动会把撤销栈冲爆。所以这里只回「这一帧的覆盖值」，
   * 建模 App 负责按 max 叠到 influences 上（对应虚幻里 UPROPERTY 的 Transient）。
   */
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* 不存盘的初值：眨眼相位 + 视线滤波状态。
   * ⚠ 这两样都不能进 params —— params 进文档、进历史，每帧改一次会把撤销栈冲爆。 */
  function liveState() {
    return {
      blink: { t: 0, next: rand(1.4, 3.4), phase: 0, value: 0 },
      gaze: { yaw: 0, pitch: 0, ready: false }
    };
  }

  /* ---------- 视线锚点（实测标定，不是猜的） ----------
   * 两眼质心的中点。y 偏下是因为这颗头的包围盒含下巴，眼睛本来就在中线下。
   * 它只用来把「相机在哪」换算成一个方向；真正转动的是骨骼
   * （清单里的 leftEye / rightEye 两个关节，权重 0.5 与 Head 混合）。 */
  var EYE_ANCHOR = [0, -0.046, 0.035];

  /* 视角限幅：流明是 8° / 10°，这里给 16° / 18°。
   * 两个理由，都是量出来的：
   *   ① 有效转角只有一半 —— 眼周顶点是 0.5 眼球 + 0.5 Head，线性混合后减半；
   *   ② 8° 时眼周顶点最大位移 3.4mm，在 20mm 的眼白上约 1.5px，看着就是「没动」。
   * 16°/18° → 位移 ≈6.8mm、观感约 8°/9°（≈ 流明那副「有神」的程度）。
   * 再大就不好看：超过 20° 上眼睑会被拉成一条（0.5 Head 权重不跟着走）。
   * 用户还可以在面板把幅度拉到 150%（24°/27°）。 */
  var GAZE_YAW = 16 * Math.PI / 180;
  var GAZE_PITCH = 18 * Math.PI / 180;

  /* 每帧一次。返回值的写法（建模 App 都认，见 model-desk.js normLive）：
   *   { eye_close: 0.6 }                                          —— 只有形态键覆盖
   *   { weight: { eye_close: 0.6 }, look: { yaw, pitch } }        —— 形态键 + 眼球角度
   * null = 这一帧什么都不用改（静止时不能每帧都返回一份"一样"的表，否则按需渲染失效）。
   *
   * look 是**交给 App 的纯数据**：组件不知道自己有没有骨骼、骨骼叫什么、骨骼矩阵怎么算。
   */
  function tickLive(dt, ctx) {
    var s = ctx.state || {};
    var p = ctx.params || {};
    var weight = null;
    var look = null;

    /* --- 眨眼 --- */
    var b = s.blink || (s.blink = { t: 0, next: rand(1.4, 3.4), phase: 0, value: 0 });
    if (p.blink === false) {
      /* 关掉：立刻睁回去并停在 0。只「不推进」会让眼睛停在半闭的相位上，看起来像坏了。 */
      if (b.value > 0 || b.phase > 0) {
        b.value = 0; b.phase = 0; b.t = 0; b.next = rand(1.4, 3.4);
        weight = { eye_close: 0 };
      }
    } else {
      b.t += dt;
      if (b.t < b.next) {
        if (b.value > 0) { b.value = 0; weight = { eye_close: 0 }; }
      } else {
        b.phase += dt;
        var ph = b.phase;
        if (ph < 0.09) b.value = ph / 0.09;
        else if (ph < 0.14) b.value = 1;
        else if (ph < 0.28) b.value = 1 - (ph - 0.14) / 0.14;
        else {
          b.phase = 0; b.t = 0; b.value = 0;
          b.next = Math.random() < 0.18 ? 0.3 : rand(2.2, 5.2);
          b.value = 0;
        }
        weight = { eye_close: b.value };
      }
    }

    /* --- 视线跟随（盯着相机） ---
     * 与流明同一套数学，也同一套驱动方式：转**眼球骨骼**（蒙皮），不是移贴图。
     * 第一版试过 uv 位移，被资产本身否掉了 —— 这张贴图上的虹膜几乎占满眼眶，
     * 偏 0.03 就露出眼睑、眼睛直接「闭上」。骨骼转动没有这个问题：
     * 整块眼球几何一起动，边缘由 0.5/0.5 的蒙皮权重过渡。 */
    var gz = s.gaze || (s.gaze = { yaw: 0, pitch: 0, ready: false });
    var g = ctx.gaze;
    var goalYaw = 0, goalPitch = 0;
    if (p.gaze !== false && g && g.dir) {
      var d = g.dir;
      /* ⚠ 这里**不抄**流明的 `if (localTarget.z > 0)` 闸门。
       * 流明只做正面微动，相机永远在前半球；建模 App 的用户会绕着模型转，
       * 一到正侧视角 z≈0，闸门就把角度整个吃掉 —— 症状是「转到侧面眼神就不动了」，
       * 而且没有任何报错。atan2 本身有定义，限幅会兜住 ±8°，直接算即可。 */
      goalYaw = clamp(Math.atan2(d[0], d[2]), -GAZE_YAW, GAZE_YAW);
      goalPitch = clamp(-Math.atan2(d[1], Math.hypot(d[0], d[2])), -GAZE_PITCH, GAZE_PITCH);
      /* 圆盘归一：两个轴同时打满会让眼球看起来「瞪」出去 */
      var rad = Math.hypot(goalYaw / GAZE_YAW, goalPitch / GAZE_PITCH);
      if (rad > 1) { goalYaw /= rad; goalPitch /= rad; }
      /* 幅度：100% 就是流明那 8°/10°；上限 150% 留给「眼神再夸张一点」 */
      var amt = (p.gazeAmt == null ? 100 : Number(p.gazeAmt)) / 100;
      goalYaw *= amt;
      goalPitch *= amt;
    }
    /* 平滑与流明一致（1 - exp(-14·dt)）：快了像抽搐，慢了像没跟上。
     * 首帧直接对齐，不然打开文档那一秒眼睛会从正中慢慢滑过来。 */
    var k = gz.ready ? (1 - Math.exp(-14 * Math.max(0, Number(dt) || 0))) : 1;
    gz.ready = true;
    gz.yaw += (goalYaw - gz.yaw) * k;
    gz.pitch += (goalPitch - gz.pitch) * k;
    /* 指数平滑永远到不了终点：残差 0.9° 时每帧只走 0.18°，低于 App 的变化阈值
     * （0.2°）就被判成「没变」而停住 —— 关掉视线后眼球停在最后那个角度上。
     * 残差小于 0.35° 时直接对齐目标（比阈值大一档，保证这一帧一定会被应用）。 */
    var SNAP = 6e-3;
    if (Math.abs(goalYaw - gz.yaw) < SNAP) gz.yaw = goalYaw;
    if (Math.abs(goalPitch - gz.pitch) < SNAP) gz.pitch = goalPitch;
    /* 关掉开关时不能只「不输出」—— 那样眼球停在最后那个角度上。
     * 继续输出直到真的回到 0，那一帧写完才算收工。 */
    if (p.gaze !== false || Math.abs(gz.yaw) > 2e-4 || Math.abs(gz.pitch) > 2e-4) {
      look = { yaw: gz.yaw, pitch: gz.pitch };
    }

    if (!weight && !look) return null;
    return { weight: weight, look: look };
  }

  function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
  }

  /* 捏脸面板：预设 chips + 分组滑杆行。当前值来自 p.shape（缺项 50）。
   * 预设高亮：所有键都等于某预设时才亮 —— 差一键也算「改过」，不冒充。 */
  function shapeVals(p) {
    var out = {};
    SHAPE_DEFS.forEach(function (d) {
      out[d.key] = Math.round(Number((p.shape || {})[d.key]) || 50);
    });
    return out;
  }
  function shapePresetChips(p) {
    var vals = shapeVals(p);
    return SHAPE_PRESETS.map(function (x) {
      var on = SHAPE_DEFS.every(function (d) {
        return vals[d.key] === Math.round(Number(x.values[d.key]) || 50);
      });
      return '<button type="button" class="md-md-expr' + (on ? ' on' : '') + '"' +
        ' data-md-cev="shapePreset" data-md-cval="' + esc0(x.name) + '">' + esc0(x.name) + '</button>';
    }).join('');
  }
  function shapeRows(p) {
    var vals = shapeVals(p);
    var out = '';
    var groups = [];
    SHAPE_DEFS.forEach(function (d) {
      if (groups.indexOf(d.group) < 0) groups.push(d.group);
    });
    groups.forEach(function (g) {
      out += '<div class="md-shape-g">' + esc0(g) + '</div>';
      SHAPE_DEFS.forEach(function (d) {
        if (d.group !== g) return;
        var v = vals[d.key];
        out += '<div class="md-shape-row">' +
          '<span class="md-shape-name" data-md-cev="shapeRst" data-md-cval="' + esc0(d.key) + '"' +
            ' title="双击恢复 50">' + esc0(d.label) + '</span>' +
          '<input type="range" data-md-cev="shape" data-md-cval="' + esc0(d.key) + '"' +
            ' min="0" max="100" step="1" value="' + v + '">' +
          '<input type="number" class="md-md-num md-shape-num" data-md-cev="shape" data-md-cval="' + esc0(d.key) + '"' +
            ' min="0" max="100" step="1" value="' + v + '"></div>';
      });
    });
    return out;
  }

  /* 面板里的一段：表情预设 + 主键下拉 + 强度 + 已叠加的键。
   * ctx 由建模 App 给（params 是**同一个对象引用**，直接改就生效）。 */
  function panel(ctx) {
    var p = ctx.params, esc = ctx.esc;
    var ws = p.weights || {};
    var cur = p.main || '';
    var keys = Object.keys(ws).filter(function (n) { return Number(ws[n]) > 0; });

    var opts = '<option value="">（基础 / rest 表情）</option>';
    var find = UI_FIND.toLowerCase();
    var hit = 0;
    GROUP_ORDER.forEach(function (g) {
      var items = (cache ? cache.morphs : []).filter(function (m) {
        if ((cache.groups[m.name] || 'other') !== g) return false;
        /* 搜索按子串匹配：112 个键靠翻 optgroup 太慢，
         * 而用户记得的通常是一段（eye / smile / aa），不是一个完整的键名。 */
        return !find || m.name.toLowerCase().indexOf(find) >= 0;
      });
      if (!items.length) return;
      hit += items.length;
      opts += '<optgroup label="' + esc(GROUP_LABEL[g] || g) + '">';
      items.forEach(function (m) {
        var w = Number(ws[m.name]) || 0;
        /* 尾注按优先级二选一：已经叠加过的显示百分比（这是用户当下关心的），
         * 没叠加的显示位移量级 —— 「空」比「0.0mm」更直白，用户不用换算就知道
         * 这个键拖了也不会动。阈值 0.1mm 是实测的「肉眼临界」：
         * 这颗头约 200mm 高，0.1mm 在 900px 的视口里不到半个像素。 */
        var tail = w > 0
          ? ' · ' + Math.round(w) + '%'
          : (m.amp >= 1e-4 ? ' · ' + (m.amp * 1000).toFixed(1) + 'mm' : ' · 空');
        opts += '<option value="' + esc(m.name) + '"' + (cur === m.name ? ' selected' : '') + '>' +
          esc(m.name) + tail + '</option>';
      });
      opts += '</optgroup>';
    });
    if (find && !hit) {
      opts = '<option value="">没有匹配「' + esc(UI_FIND) + '」的形态键</option>';
    }

    var expr = EXPR.map(function (x) {
      return '<button type="button" class="md-md-expr' + (x.id === p.expr ? ' on' : '') + '"' +
        ' data-md-cev="expr" data-md-cval="' + esc(x.id) + '">' + esc(x.name) + '</button>';
    }).join('');

    var chips = keys.length
      ? keys.map(function (n) {
          var v = Math.round(Number(ws[n]) || 0);
          /* 三段一体：名字（设为当前主键）/ 数值（单键微调）/ ×（移除）。
           * ⚠ 外层**不能是 button**：里面放着 number 输入框，而点击委托会把任何
           *   子节点 closest('button') 之后当成「点了这个 chip」—— 表现就是
           *   「想改数值，结果把键删了」。所以容器是 span，三段各自是控件。 */
          return '<span class="md-md-key">' +
            '<button type="button" class="md-md-keyn" data-md-cev="pick" data-md-cval="' + esc(n) + '"' +
              ' title="设为当前主键（其它键保留）">' + esc(n) + '</button>' +
            '<input type="number" class="md-md-keyv" data-md-cev="chipw" data-md-cval="' + esc(n) + '"' +
              ' min="0" max="100" step="1" value="' + v + '"' +
              ' title="单独调这个键：只改它，不镜像对侧">' +
            '<button type="button" class="md-md-keyx" data-md-cev="drop" data-md-cval="' + esc(n) + '"' +
              ' title="移除 ' + esc(n) + '">×</button></span>';
        }).join('')
      : '<span class="md-md-none">还没有叠加任何形态键</span>';

    /* 自己存的表情：捏好一张脸得能留住，否则每次都要从 112 个键里重捏。
     * 存进 **params**（`mine` 数组）而不是组件级 presets：presets 是「出厂预设」，
     * 属于组件；这张脸属于这个模型，换文档、换机器要跟着模型走。
     * 记录形状 { id, name, w }：w 是「键名 → 百分比」的快照，套用时整批替换。 */
    var mine = (p.mine || []).filter(function (x) { return x && x.id && x.w; });
    var mineChips = mine.length
      ? mine.map(function (x) {
          var cnt = Object.keys(x.w || {}).length;
          return '<span class="md-md-key md-md-mine">' +
            '<button type="button" class="md-md-keyn" data-md-cev="mineUse" data-md-cval="' + esc(x.id) + '"' +
              ' title="套用「' + esc(x.name) + '」：整批替换当前叠加（' + cnt + ' 个键）">' +
              esc(x.name) + '</button>' +
            '<button type="button" class="md-md-keyx" data-md-cev="mineDel" data-md-cval="' + esc(x.id) + '"' +
              ' title="删除「' + esc(x.name) + '」">×</button></span>';
        }).join('')
      : '<span class="md-md-none">存过之后这里会出现你的脸</span>';

    var curW = Math.round(Number(ws[cur]) || 0);

    return [
      '<div class="md-md-sec"><div class="md-md-h">表情<em>一组键一起动</em></div>',
      '<div class="md-md-exprs">' + expr + '</div></div>',
      '<div class="md-md-sec"><div class="md-md-h">形态键<em>' + (cache ? cache.morphs.length : 0) + ' 个 · 可叠加</em></div>',
      '<label class="md-comp-field wide"><input type="search" data-md-cev="find" ' +
        'placeholder="搜形态键（eye / smile / aa）" value="' + esc(UI_FIND) + '"></label>',
      '<label class="md-comp-field wide"><select data-md-cev="main">' + opts + '</select></label>',
      /* ⚠ 这一行用 div 不用 label：label 会把点击转发给它的第一个可聚焦控件，
       *   而这里有两个（滑杆 + 数值框），点数值框可能被转给滑杆 —— 见鬼的是
       *   浏览器行为不一致，只在某些版本上「点数字框没反应」。 */
      '<div class="md-comp-field"><span>强度</span>',
      '<input type="range" data-md-cev="w" min="0" max="100" step="1" value="' +
        curW + '"' + (cur ? '' : ' disabled') + '>',
      /* 滑杆给手感，数值框给准头：捏脸常要「就 35%」，拖是拖不准的。
       * 两者是同一个参数 —— 拖滑杆时 paintCompNumber 会把值写进这个框
       * （靠 data-md-cpv 找，判 tagName 决定写 value 还是 textContent）。 */
      '<input type="number" class="md-md-num" data-md-cev="wNum" data-md-cpv="w" min="0" max="100"' +
        ' step="1" value="' + curW + '"' + (cur ? '' : ' disabled') + '></div>',
      '<label class="md-md-chk"><input type="checkbox" data-md-cev="mirror"' +
        (p.mirror === false ? '' : ' checked') +
        /* 关掉对称时文案必须跟着变：这个开关的后果是「只改一侧」，
         * 而界面上如果一直写「_L / _R 一起改」，用户会以为自己改歪了脸。 */
        '><span>左右对称' + (p.mirror === false
          ? '（<b>关</b>：只改当前一侧）' : '（_L / _R 一起改）') + '</span></label>',
      '</div>',
      '<div class="md-md-sec"><div class="md-md-h">当前叠加<em>同时生效</em>' +
        (keys.length ? '<button type="button" class="md-md-clr" data-md-cev="clear">全部清零</button>' : '') +
        '</div><div class="md-md-keys">' + chips + '</div></div>',
      /* 「我的表情」紧跟当前叠加：捏完 → 存下来，是同一个动作的两半。
       * 上限 24 张：params 会跟着每次编辑写进历史与文档，无限长等于给撤销栈塞垃圾。 */
      '<div class="md-md-sec"><div class="md-md-h">我的表情<em>存进模型 · ' + mine.length + '/24</em></div>',
      '<div class="md-md-keys">' + mineChips + '</div>',
      '<div class="md-md-row">',
      '<input type="text" class="md-md-mine-name" data-md-cev="mineName" maxlength="12"' +
        ' placeholder="给这张脸起个名（可空）" value="' + esc(UI_MINE_NAME) + '">',
      '<button type="button" class="md-md-expr" data-md-cev="mineSave"' +
        (keys.length ? '' : ' disabled') + ' title="把当前叠加的键与强度存起来">存为表情</button>',
      '</div></div>',
      /* ---- 捏脸（脸型变形器）----
       * 与流明同一个东西：shader 形变 + 预设 + 滑杆/数值双入口。
       * 行结构：名字（双击恢复 50）+ range + number，三控件写同一个参数。
       * 滑杆 data-md-cev="shape"（input→preview / change→full）；
       * 数值框同名 act，复用同一条事件路径；名字 data-md-cev="shapeRst"。 */
      '<div class="md-md-sec"><div class="md-md-h">捏脸<em>流明同款 · 20 参数 · 50 = 原始</em></div>',
      '<div class="md-md-exprs">' + SHAPE_GROUPS_ALL.map(function (g) {
        return '<button type="button" class="md-md-expr' + (g === UI_GROUP ? ' on' : '') + '"' +
          ' data-md-cev="shapeGroup" data-md-cval="' + esc0(g) + '"' +
          ' title="在脸上显示这一组的操控点">' + esc0(g) + '</button>';
      }).join('') + '</div>',
      '<div class="md-md-exprs">' + shapePresetChips(p) + '</div>',
      shapeRows(p),
      '</div>',
      /* 自动眨眼：开关是**持久参数**（跟着文档走），相位是**运行时状态**（不存盘）。
       * 两者分开写是有意的：关掉以后重开文件应该还是关的，但不该记着「上次眨到一半」。 */
      '<div class="md-md-sec"><div class="md-md-h">自动眨眼<em>运行时 · 相位不存盘</em></div>',
      '<label class="md-md-chk"><input type="checkbox" data-md-cev="blink"' +
        (p.blink === false ? '' : ' checked') + '><span>随机眨（约 2–5 秒一次）</span></label></div>',
      /* 视线：转的是**眼球骨骼**（蒙皮），和流明 App 一模一样。
       * 开关进持久参数（重开文件还认），角度每帧从相机算（不存盘）。 */
      '<div class="md-md-sec"><div class="md-md-h">视线<em>转眼球骨骼 · 角度不存盘</em></div>',
      '<label class="md-md-chk"><input type="checkbox" data-md-cev="gaze"' +
        (p.gaze === false ? '' : ' checked') + '><span>盯着相机看（眼球随视角转动）</span></label>',
      '<label class="md-comp-field wide"><span>幅度</span>',
      '<input type="range" data-md-cev="gazeAmt" min="0" max="150" step="5" value="' +
        Math.round(p.gazeAmt == null ? 100 : Number(p.gazeAmt)) + '">',
      '<b data-md-cpv="gazeAmt">' + Math.round(p.gazeAmt == null ? 100 : Number(p.gazeAmt)) + '</b></label></div>'
    ].join('');
  }

  /* 写一个键的权重（0 = 删掉）。开了左右对称就把 _L / _R 成对写。
   * 对称写之前要确认对侧键真的存在 —— 清单里不是每一对都齐
   * （有的只有 _L，写进一个不存在的名字会让 chips 里出现一个拖不动的幽灵）。 */
  function writeWeight(p, name, v) {
    var ws = p.weights || (p.weights = {});
    if (v > 0) ws[name] = v; else delete ws[name];
    if (p.mirror === false) return;
    var m = mirrorOf(name);
    if (!m || !cache) return;
    var ok = false;
    for (var i = 0; i < cache.morphs.length; i++) if (cache.morphs[i].name === m) { ok = true; break; }
    if (!ok) return;
    if (v > 0) ws[m] = v; else delete ws[m];
  }

  /* 面板里的事件。返回值告诉建模 App 怎么重画：
   *   'full'    → 整块参数区重铺（换了主键 / 点了表情，滑杆值要跟着走）
   *   'preview' → 只重画剪影（拖强度时不能重铺，否则滑杆丢焦点） */
  function onEvent(ev, ctx) {
    var p = ctx.params;
    if (!p.weights) p.weights = {};
    var ws = p.weights;

    /* 搜索：只影响下拉里列哪些键。词存在模块变量里（界面状态），不进 params。 */
    if (ev.type === 'input' && ev.act === 'find') {
      UI_FIND = String(ev.value == null ? '' : ev.value);
      return 'full';
    }
    if (ev.type === 'change' && ev.act === 'mirror') {
      p.mirror = !!ev.value;
      /* 打开对称时把当前主键立刻同步过去 —— 不然用户会以为开关没生效 */
      if (p.mirror && p.main && Number(ws[p.main]) > 0) writeWeight(p, p.main, Number(ws[p.main]));
      return 'full';
    }
    if (ev.type === 'click' && ev.act === 'clear') {
      p.weights = {};
      p.main = '';
      p.expr = '';
      return 'full';
    }

    /* 自动眨眼开关：改的是**持久参数**（进文档、进历史），不是运行时相位。
     * 返回 'full' 是为了让复选框和旁边的说明一起重铺 —— 只改数字不值得单独一条路径。 */
    if (ev.type === 'change' && ev.act === 'blink') {
      p.blink = !!ev.value;
      p.expr = p.expr || '';
      return 'full';
    }
    /* 视线开关：同样是持久参数。关掉以后组件会继续输出角度直到真的回到 0
     * （App 那边按值比较，归零那一帧一定会重写）。 */
    if (ev.type === 'change' && ev.act === 'gaze') {
      p.gaze = !!ev.value;
      return 'full';
    }
    if (ev.type === 'input' && ev.act === 'gazeAmt') {
      var ga = Number(ev.value);
      if (!isFinite(ga)) return '';
      p.gazeAmt = Math.max(0, Math.min(150, Math.round(ga)));
      return 'preview';
    }

    /* ---------- 捏脸：单键微调 / 精确强度 / 存表情 ---------- */

    /* 主强度的数值框：和滑杆同一个参数，但要整块重铺（滑杆的位置得跟过去）。
     * ⚠ 只在 change 上处理 —— number 输入框每敲一个字符都会发 input，
     *   在 input 上重铺会把「正在输入的框」连焦点一起换掉，表现为「打一位就跳走」。 */
    if (ev.type === 'change' && ev.act === 'wNum') {
      if (!p.main) return '';
      var nv = Number(ev.value);
      if (!isFinite(nv)) return '';
      writeWeight(p, p.main, Math.max(0, Math.min(100, nv)));
      p.expr = '';
      return 'full';
    }
    /* 叠加键上的数值框：**只改这一个键**，不走 writeWeight。
     * 理由：用户手指落在某个 chip 上，意图就是「把这一侧调到 40%」。
     * 顺手镜像对侧会把「故意捏歪的脸」抹平，而且没有任何提示。
     *
     * 视口里的 3D 控制器拖的也是这条路（同一个 act、同一个 arg），区别只有返回粒度：
     * 拖动中（input）返回 'preview' —— 返回 'full' 会每帧重铺整块控制器 DOM，
     * 拖动会一顿一顿，还会把正在编辑的输入框焦点换掉。松手（change）才重铺。 */
    if ((ev.type === 'change' || ev.type === 'input') && ev.act === 'chipw') {
      var key = ev.arg || '';
      if (!key) return '';
      var cv = Number(ev.value);
      if (!isFinite(cv)) return '';
      cv = Math.max(0, Math.min(100, Math.round(cv)));
      if (cv > 0) ws[key] = cv; else delete ws[key];
      if (p.main === key && cv <= 0) p.main = '';
      p.expr = '';
      return ev.type === 'input' ? 'preview' : 'full';
    }
    /* 点 chip 的名字 = 设为当前主键。**不删**这个键、也不动其它键 ——
     * 这样接着拖滑杆 / 敲数值就是在调它，而捏到一半的其它键还在。 */
    if (ev.type === 'click' && ev.act === 'pick') {
      p.main = ev.value || '';
      p.expr = '';
      return 'full';
    }
    if (ev.type === 'input' && ev.act === 'mineName') {
      UI_MINE_NAME = String(ev.value == null ? '' : ev.value).slice(0, 12);
      return '';
    }
    /* 存表情：把当前叠加拍一张快照。重名就覆盖 —— 用户改了两笔再存一次，
     * 期望的是「更新那一张」，而不是多出一张同名的。 */
    if (ev.type === 'click' && ev.act === 'mineSave') {
      var snapW = {};
      Object.keys(ws).forEach(function (k) {
        var v = Math.round(Number(ws[k]) || 0);
        if (v > 0) snapW[k] = v;
      });
      var nk = Object.keys(snapW);
      if (!nk.length) return '';
      var list = (p.mine || []).slice();
      var nm = String(UI_MINE_NAME || '').replace(/^\s+|\s+$/g, '') || ('表情 ' + (list.length + 1));
      var at = -1;
      for (var li = 0; li < list.length; li++) if (list[li] && list[li].name === nm) at = li;
      var rec = {
        id: (at >= 0 ? list[at].id : ('m' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36))),
        name: nm,
        w: snapW
      };
      if (at >= 0) list[at] = rec;
      else {
        list.push(rec);
        /* 超上限丢最旧的：宁可丢一张旧脸，也不让 params 无界增长
         * （它每次都整份进历史快照）。 */
        if (list.length > 24) list = list.slice(list.length - 24);
      }
      p.mine = list;
      p.expr = '';
      UI_MINE_NAME = '';
      return 'full';
    }
    /* 套用一张存过的脸：**整批替换**而不是叠加。叠加两次同一张脸会变成 140%，
     * 和表情预设那里是同一套理由（表情 = 整张脸的姿态）。 */
    if (ev.type === 'click' && ev.act === 'mineUse') {
      var want = null;
      (p.mine || []).forEach(function (x) { if (x && x.id === ev.value) want = x; });
      if (!want) return '';
      var nw = {};
      Object.keys(want.w || {}).forEach(function (k) {
        var v = Math.round(Number(want.w[k]) || 0);
        if (v > 0) nw[k] = v;
      });
      p.weights = nw;
      p.expr = '';
      p.main = Object.keys(nw)[0] || '';
      return 'full';
    }
    if (ev.type === 'click' && ev.act === 'mineDel') {
      p.mine = (p.mine || []).filter(function (x) { return !x || x.id !== ev.value; });
      return 'full';
    }

    /* ---- 捏脸 ----
     * 20 个参数共用一个 act（'shape'），键名走 data-md-cval（ev.arg），数值走 ev.value。
     * input → preview（拖滑杆不重铺，焦点不能断）；change → full（数值框 / 松手要重铺，
     * 预设高亮也要跟上）。 */
    if ((ev.type === 'input' || ev.type === 'change') && ev.act === 'shape') {
      var sk = ev.arg || '';
      if (!(sk in SHAPE_INDEX)) return '';
      var sv = Math.round(Number(ev.value));
      if (!isFinite(sv)) return '';
      p.shape = p.shape || {};
      sv = Math.max(0, Math.min(100, sv));
      if (sv === 50) delete p.shape[sk]; else p.shape[sk] = sv;
      return ev.type === 'input' ? 'preview' : 'full';
    }
    /* 视口显示哪个分组的操控点 */
    if (ev.type === 'click' && ev.act === 'shapeGroup') {
      if (UI_GROUP === ev.value) return '';
      UI_GROUP = String(ev.value || '');
      return 'full';
    }
    /* 双击参数名恢复 50（delete 键 = 回到「没改过」）。 */
    if (ev.type === 'click' && ev.act === 'shapeRst') {
      if (!(ev.value in SHAPE_INDEX)) return '';
      p.shape = p.shape || {};
      delete p.shape[ev.value];
      return 'full';
    }
    /* 预设整批套用（含「原始」= 全部回 50）。与表情同一套理由：整张脸的姿态。 */
    if (ev.type === 'click' && ev.act === 'shapePreset') {
      var pr = null;
      SHAPE_PRESETS.forEach(function (x) { if (x.name === ev.value) pr = x; });
      if (!pr) return '';
      p.shape = {};
      SHAPE_DEFS.forEach(function (d) {
        var v = Math.round(Number(pr.values[d.key]));
        if (isFinite(v) && v !== 50) p.shape[d.key] = Math.max(0, Math.min(100, v));
      });
      return 'full';
    }

    /* 拖完主强度要重铺一次：chips 里的百分比、「当前叠加」的排布都变了。
     * input 阶段**不能**重铺（每帧重建 112 个 option + chips，拖着就卡，焦点也断），
     * change（松手）才是重铺的时机 —— 浏览器在滑杆松手时一定会补一个 change。 */
    if (ev.type === 'change' && ev.act === 'w') return 'full';

    /* 旧的单键接口（setComponentParam('morph' | 'weight', …) 与外部脚本）照样认：
     * 选键 = 只留这个键满强度，拖权重 = 改当前主键。 */
    if (ev.type === 'param') {
      if (ev.key === 'morph') {
        p.weights = {};
        p.main = ev.value ? String(ev.value) : '';
        if (p.main) p.weights[p.main] = 100;
        p.expr = '';
        return 'full';
      }
      if (ev.key === 'weight') {
        if (!p.main) return '';
        var wv = Number(ev.value);
        if (!isFinite(wv)) return '';
        writeWeight(p, p.main, wv);
        return 'preview';
      }
      return '';
    }

    if (ev.type === 'click' && ev.act === 'expr') {
      var x = null;
      for (var i = 0; i < EXPR.length; i++) if (EXPR[i].id === ev.value) x = EXPR[i];
      if (!x) return '';
      /* 表情是**整张脸的姿态**，不是再叠一层：先清空再写。
       * 不清的话连点两次「微笑」就成了 140%，而且点「生气」会跟微笑混在一起。
       * 这是表情和捏脸的分界：表情=整批替换，捏脸=多键叠加（见下面的 main 切换）。 */
      p.weights = {};
      Object.keys(x.w).forEach(function (n) { p.weights[n] = x.w[n]; });
      p.expr = x.id;
      p.main = Object.keys(x.w)[0] || '';
      /* 表情是成套给的，不该再镜像（否则会把 _L/_R 的值复制成同一个数） */
      return 'full';
    }
    if (ev.type === 'click' && ev.act === 'drop') {
      /* 单独删一个键：既然用户点的是这个键的 ×，就别顺手把对侧也删了 */
      delete ws[ev.value];
      if (p.main === ev.value) p.main = '';
      p.expr = '';
      return 'full';
    }
    if (ev.type === 'change' && ev.act === 'main') {
      /* ⚠ 换主键**不清旧键**。
       * 早先这里是 `delete ws[old]`，本意是「选一个新键就别留着上一个」，
       * 但那等于把捏脸锁死成「一次只能调一个键」—— 调完眼睛调嘴，眼睛就回弹了。
       * 表情按钮那边已经有整批替换（p.weights = {}），不需要这里再做一次。 */
      p.main = ev.value || '';
      p.expr = '';
      return 'full';
    }
    if (ev.type === 'input' && ev.act === 'w') {
      if (!p.main) return '';
      var v = Number(ev.value);
      if (!isFinite(v)) return '';
      writeWeight(p, p.main, v);
      p.expr = '';
      return 'preview';
    }
    return '';
  }

  /* 把参数应用到**已经存在的网格**上：只改权重，不重建几何。
   * 这是「自己的属性」最实际的一面 —— 加进场景的头模还能继续调表情，
   * 而且调的是同一份顶点（拓扑、UV、用户改过的东西全不动）。 */
  function applyTo(mesh, p) {
    if (!mesh || !mesh.morphs || !mesh.morphs.length) return false;
    var ws = (p && p.weights) || {};
    for (var i = 0; i < mesh.morphs.length; i++) {
      var m = mesh.morphs[i];
      m.weight = clamp01((Number(ws[m.name]) || 0) / 100);
    }
    return true;
  }

  /* 属性面板里那块「组件」的内容（建模 App 只负责套外壳和按钮） */
  function props(node) {
    var p = (node && node.comp && node.comp.params) || {};
    var ws = p.weights || {};
    var keys = Object.keys(ws).filter(function (n) { return Number(ws[n]) > 0; });
    var name = '';
    EXPR.forEach(function (x) { if (x.id === p.expr) name = x.name; });
    var list = keys.length
      ? keys.map(function (n) { return '<b>' + esc0(n) + '</b> ' + Math.round(Number(ws[n]) || 0) + '%'; }).join(' · ')
      : '基础表情（未叠加）';
    var mine = (p.mine || []).filter(function (x) { return x && x.id; }).length;
    return '<div class="md-md-sum">' +
      (name ? '<i>' + esc0(name) + '</i> ' : '') + list + '</div>' +
      '<div class="md-note">自动眨眼 <b>' + (p.blink === false ? '关' : '开') +
      '</b> · 视线跟随 <b>' + (p.gaze === false ? '关' : '开') +
      '</b> · 左右对称 <b>' + (p.mirror === false ? '关' : '开') +
      '</b>' + (mine ? ' · 自存表情 <b>' + mine + '</b> 张' : '') +
      '<br>同一个网格 · 顶点与形态键都来自流明资产，改表情不动拓扑</div>';
  }
  function esc0(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 表面（贴图）：流明的脸有 90% 在贴图上 —— 瞳孔、睫毛、嘴、眉毛全是画出来的，
   * 几何只负责眼皮和嘴腔的形。不挂这张图，头模在建模 App 里就是一颗灰壳，
   * 「同一份资产」这句话也就不成立了（UV 已经是这张图的布局）。 */
  function surface() {
    if (!cache || !cache.tex) return [];
    return [{ map: cache.tex, color: '#ffffff' }];
  }

  /* ================= 捏脸：脸型变形器（照抄流明） =================
   * 20 个参数在**顶点着色器**里按「面部坐标系」变形：
   *   t = (y − minY) / H   线性高度，0 下巴 / 1 头顶
   *   v = l3V(t)           锚点坐标：下巴 0 / 嘴 0.30 / 鼻尖 0.55 / 眼 0.66 / 额 0.90
   *   u = x / halfW(t)     横向坐标，±1 正好落在该高度的脸缘
   * 线圈（椭圆）既是变形掩码也是界面高亮 —— 「看到的就是生效的」。
   *
   * ⚠ 下面每个常量块都用脚本从 apps/lumen3d/app.js **逐字节抽取**（tools/probe-md-shape.js
   *   会再抽一遍与这里比对），手改任何一个数字都会被探针抓出来 —— 要改两边一起改。
   * ⚠ 资产坐标系：建模 App 的网格顶点是「资产 − center」，而这套 GLSL 里的绝对 z 阈值
   *   （鼻梁 0.045 / 眼皮 0.005 / 口腔 −0.010）都是资产系的数。注入时用 l3Org（= center）
   *   把顶点抬回资产系再变形、算完再减回来 —— GLSL 一个字不动。
   *
   * 建模 App 侧的挂接（applyShapeShader）：uniform l3Shape[5]（参数，App 从 params 打包）、
   * l3CoilU[20]（线圈）、l3Bounds（资产 y 范围）、l3Hi/l3SelKind/l3SelA/l3SelColor（覆层）、
   * l3Out[3]（轮廓曲线，默认全 1）、l3EyeX/l3MouthX/l3EyeC/R/l3MouthC/R（区域变换，本版不开放
   * 手柄，全部给中性值）、l3EyePart（FaceEyes 材质 = 1）、l3Org（资产系偏移）。
   */
  var SLIDER_GROUPS = ['轮廓', '眼睛', '鼻子'];

    var REGION_FRAMES = {
    eye: { uc: 0.45, ur: 0.355, vc: 0.695, vrUp: 0.092, vrDn: 0.086, lo: 0.50, hi: 1.55, p: 3.4 },
    eyePart: { uc: 0.44, ur: 0.34, vc: 0.688, vrUp: 0.165, vrDn: 0.078, lo: 0.30, hi: 1.30 },
    mouth: { uc: 0.00, ur: 0.32, vc: 0.285, vrUp: 0.105, vrDn: 0.105, lo: 0.22, hi: 1.45 }
  };

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

    var COIL_LIMIT = {
    uc: [0, 1.25], ur: [0.05, 3.20], vc: [0, 1], vr: [0.04, 0.90]
  };

    var COIL_INDEX = {};

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

    var OUTLINE_KNOTS = [0.04, 0.16, 0.28, 0.40, 0.52, 0.64, 0.76, 0.88];

    var OUTLINE_STEP = OUTLINE_KNOTS[1] - OUTLINE_KNOTS[0];

    var OUTLINE_LIMIT = [0.65, 1.45];

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

  /* ---- 捏脸：运行时换算（JS 镜像，与 tools/lumen3d-rig-check.js 同源） ---- */
  var SHAPE_INDEX = {};
  SHAPE_DEFS.forEach(function (d, i) { SHAPE_INDEX[d.key] = i; });
  var SHAPE_GROUPS_ALL = [];
  SHAPE_DEFS.forEach(function (d) {
    if (SHAPE_GROUPS_ALL.indexOf(d.group) < 0) SHAPE_GROUPS_ALL.push(d.group);
  });

  /* 缺键 = 50（没改过）。⚠ Number(undefined) 是 NaN，NaN 一路进 shader
   * 就是整张脸的顶点全变 NaN —— 面板上「没显示的参数」必须在这里兜住。 */
  function shapeNorm(value) {
    var v = (value == null || value === '') ? 50 : Number(value);
    if (!isFinite(v)) v = 50;
    return (clamp(v, 0, 100) - 50) / 50;
  }

  /* params.shape（缺项 = 50）→ 5 个 vec4。顺序 = SHAPE_DEFS，shader 用常量下标取。 */
  function shapePack(shape) {
    var out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    SHAPE_DEFS.forEach(function (d, i) {
      var v = shapeNorm((shape || {})[d.key]);
      var q = out[i >> 2], s = i & 3;
      if (s === 0) q[0] = v; else if (s === 1) q[1] = v;
      else if (s === 2) q[2] = v; else q[3] = v;
    });
    return out;
  }

  /* 资产系的 y 范围（l3Bounds：x = minY, z = 1/H）。 */
  function shapeBounds() { return cache ? [cache.min[1], cache.max[1]] : null; }
  /* 网格局部 → 资产 的平移量（GLSL 里的 l3Org）。 */
  function shapeOrigin() { return cache ? cache.center : null; }

  function shapeSeg(t, a, b, va, vb) {
    var k = Math.min(1, Math.max(0, (t - a) / Math.max(b - a, 1e-5)));
    return va + (vb - va) * k;
  }
  function shapeSstep(a, b, x) {
    var k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  }
  function shapeV(t) {
    var v = shapeSeg(t, 0.000, 0.120, 0.00, 0.30);
    if (t >= 0.120) v = shapeSeg(t, 0.120, 0.215, 0.30, 0.55);
    if (t >= 0.215) v = shapeSeg(t, 0.215, 0.290, 0.55, 0.66);
    if (t >= 0.290) v = shapeSeg(t, 0.290, 0.450, 0.66, 0.80);
    if (t >= 0.450) v = shapeSeg(t, 0.450, 0.600, 0.80, 0.90);
    if (t >= 0.600) v = shapeSeg(t, 0.600, 0.800, 0.90, 0.97);
    if (t >= 0.800) v = shapeSeg(t, 0.800, 1.000, 0.97, 1.00);
    return v;
  }
  function shapeHalfW(t) {
    var w = shapeSeg(t, 0.000, 0.040, 0.015, 0.030);
    if (t >= 0.040) w = shapeSeg(t, 0.040, 0.080, 0.030, 0.042);
    if (t >= 0.080) w = shapeSeg(t, 0.080, 0.120, 0.042, 0.050);
    if (t >= 0.120) w = shapeSeg(t, 0.120, 0.160, 0.050, 0.056);
    if (t >= 0.160) w = shapeSeg(t, 0.160, 0.200, 0.056, 0.070);
    if (t >= 0.200) w = shapeSeg(t, 0.200, 0.250, 0.070, 0.074);
    if (t >= 0.250) w = shapeSeg(t, 0.250, 0.290, 0.074, 0.080);
    if (t >= 0.290) w = shapeSeg(t, 0.290, 0.350, 0.080, 0.081);
    if (t >= 0.350) w = shapeSeg(t, 0.350, 0.450, 0.081, 0.072);
    if (t >= 0.450) w = shapeSeg(t, 0.450, 0.600, 0.072, 0.077);
    if (t >= 0.600) w = shapeSeg(t, 0.600, 0.750, 0.077, 0.061);
    if (t >= 0.750) w = shapeSeg(t, 0.750, 0.900, 0.061, 0.058);
    if (t >= 0.900) w = shapeSeg(t, 0.900, 1.000, 0.058, 0.050);
    return w;
  }
  function shapeCoilW(u, v, c) {
    var du = (u - c[0]) / Math.max(c[1], 1e-4);
    var dv = (v - c[2]) / Math.max(c[3], 1e-4);
    return 1 - shapeSstep(0.15, 1.10, du * du + dv * dv);
  }

  /* 脸上的操控点：按 ANCHOR_SPECS 取「该高度的最前表面点」（照抄 buildAnchors.pick，
   * 没做射线投射 —— pick 出来的点已经在脸面上，够手柄落位）。 */
  var SHAPE_ANCHORS = null;
  function shapeAnchors() {
    if (!cache) return null;
    if (SHAPE_ANCHORS) return SHAPE_ANCHORS;
    var out = {};
    var minY = cache.min[1], H = cache.max[1] - cache.min[1];
    if (H > 0) {
      var pos = f32(cache.ab, cache.mesh.position);
      var front = [];
      for (var i = 0; i < pos.length; i += 3) {
        if (pos[i + 2] > 0) front.push(pos[i], pos[i + 1], pos[i + 2]);
      }
      function pick(t, ratio) {
        var yT = minY + t * H;
        var band = Math.max(H * 0.02, 0.0015);
        var maxX = 0, j;
        for (j = 0; j < front.length; j += 3) {
          if (Math.abs(front[j + 1] - yT) > band) continue;
          var ax = Math.abs(front[j]);
          if (ax > maxX) maxX = ax;
        }
        if (!(maxX > 0)) return null;
        var targetX = ratio * maxX;
        var bestZ = -Infinity;
        for (j = 0; j < front.length; j += 3) {
          if (Math.abs(front[j + 1] - yT) > band) continue;
          if (Math.abs(Math.abs(front[j]) - targetX) > maxX * 0.14) continue;
          if (front[j + 2] > bestZ) bestZ = front[j + 2];
        }
        if (bestZ === -Infinity) bestZ = 0;
        return [targetX, yT, bestZ + 0.003];
      }
      Object.keys(ANCHOR_SPECS).forEach(function (key) {
        var local = pick(ANCHOR_SPECS[key].t, ANCHOR_SPECS[key].u);
        if (!local) return;
        /* App 的网格顶点是「资产 − center」：锚点跟着换算，localToWorld 才落得准 */
        out[key] = [
          +(local[0] - cache.center[0]).toFixed(5),
          +(local[1] - cache.center[1]).toFixed(5),
          +(local[2] - cache.center[2]).toFixed(5)
        ];
      });
    }
    SHAPE_ANCHORS = out;
    return out;
  }

  /* 拖动手柄的增益（JS 镜像 gizmoGain 的**局部**一半）：
   * 该参数 +1（滑杆 0–100 的 1 格）时锚点在资产系里的位移 (dx, dy)。
   * App 拿它乘 host 的世界旋转、再投影到屏幕像素 —— 「顺着力的方向拖」才放大。 */
  function shapeGain(key) {
    if (!cache) return [0, 0];
    var a = shapeAnchors();
    var rest = a && a[key];
    if (!rest) return [0, 0];
    var restA = [rest[0] + cache.center[0], rest[1] + cache.center[1], rest[2] + cache.center[2]];
    var minY = cache.min[1], H = cache.max[1] - cache.min[1];
    if (!(H > 0)) return [0, 0];
    var hScale = H / 0.202114;
    var t = clamp((restA[1] - minY) / H, 0, 1);
    var v = shapeV(t);
    var w = Math.max(shapeHalfW(t), 0.020) * hScale;
    var au = Math.abs(restA[0] / w);
    var eyeY = minY + 0.299 * H;
    var mouthY = minY + 0.112 * H;
    function mask(name) { return shapeCoilW(au, v, DEFAULT_COILS[name]); }
    var dx = 0, dy = 0;
    if (key === 'width') dx = restA[0] * 0.24 * 0.02 * mask('width');
    else if (key === 'length') dy = (restA[1] - eyeY) * 0.13 * 0.02 * mask('length');
    else if (key === 'chin') dy = (restA[1] - mouthY) * 0.35 * 0.02 * mask('chin');
    else if (key === 'jaw') dx = -restA[0] * 0.18 * 0.02 * mask('jaw');
    else if (key === 'cheek') dx = restA[0] * 0.11 * 0.02 * mask('cheek');
    else if (key === 'cheekFull') dx = restA[0] * 0.09 * 0.02 * mask('cheekFull');
    else if (key === 'forehead') dx = restA[0] * 0.16 * 0.02 * mask('forehead');
    else if (key === 'chinWidth') dx = restA[0] * 0.18 * 0.02 * mask('chinWidth');
    else if (key === 'noseLength') dy = -0.0035 * hScale * 0.02 * mask('noseLength');
    else return [0, 0];
    return [dx, dy];
  }

  var def = {
    id: 'lumen-head',
    name: '流明头模',
    note: '流明 3D 的同一份资产 · 112 形态键 · 可叠加表情',
    kind: 'mesh',
    /* async：几何来自别人的数据包，第一次用要先把 14MB 读进来。
     * 面板与按钮都认这个标记，看到它就显示「读取中…」而不是直接抛错。 */
    async: true,
    ready: function () { return !!cache; },
    load: load,
    paramsOf: function () {
      return {
        main: '', weights: {}, expr: '',
        blink: true, gaze: true, gazeAmt: 100,
        /* mirror 是**持久偏好**（关掉对称后重开文件还是关的），
         * 搜索词不是 —— 那个在模块变量 UI_FIND 里，不进文档。 */
        mirror: true,
        /* 用户自己存的表情（{ id, name, w } 数组）。放 params 里是刻意的：
         * 它是**这张脸的一部分**，存盘 / 复制模型 / 传给下游都应该带着走；
         * 组件级 presets 是「出厂预设」，语义完全不同，不能混。 */
        mine: [],
        /* 捏脸：20 个脸型参数，0–100、50 = 原始。缺项 = 50（shapePack 兜底），
         * 所以这里只存**改过的键**，原始脸在 params 里是一个空对象。 */
        shape: {}
      };
    },
    /* 运行时锚点：眼睛在哪（本地坐标）。
     * 建模 App 只把它当纯数据用 —— 它不知道那是眼睛。 */
    gazeAnchor: function () { return EYE_ANCHOR; },
    /* 蒙皮数据（纯数组 + 节点表）：建模 App 用它建骨骼和 SkinnedMesh。
     * 组件这边只交数据，不碰 three、不碰对象树。 */
    skin: function () { return cache ? cache.skin : null; },
    /* 每个材质组的渲染语义（纯数据）。建模 App 按它给每组配材质：
     * FaceSurface 不透明 / FaceEyes 透明叠层。少了这一步，眼睛那层会被皮肤挡住。 */
    groupMats: function () { return cache ? cache.groupMats : null; },
    /* 眼片规格（纯数据）：这颗头的「眼神」是皮肤上一块贴片的平移，不是眼球几何。
     * 建模 App 拿它做连续的区域位移；数值全部由资产自己的 eyeshighlight_move_* 键标定。
     * 组件不认识 three、不认识骨骼、也不知道「相机在哪」。 */
    eyeSheet: function () { return cache ? cache.eyeSheet : null; },
    /* ---- 捏脸：视口控制器与滑杆的全部数据源（纯数据，App 不认识「脸宽」） ----
     * info    参数表 / 分组 / 预设
     * glsl    注入用的两段着色器（与流明逐字节相同，探针会比对源码）
     * bounds  资产系 y 范围 → l3Bounds；origin → l3Org（网格局部 → 资产）
     * pack    params.shape → 5×vec4（App 每次参数变了调）
     * anchors 脸上操控点（网格局部坐标，App localToWorld）
     * gain    拖动手柄的增益（资产系位移 / 滑杆 +1 格，App 投影到像素） */
    shapeInfo: function () {
      return {
        defs: SHAPE_DEFS.map(function (d) { return { key: d.key, label: d.label, group: d.group }; }),
        groups: ['轮廓', '眼睛', '鼻子', '嘴部'],
        presets: SHAPE_PRESETS.map(function (x) { return { name: x.name, values: x.values }; })
      };
    },
    shapeGlsl: function () { return { vert: SHAPE_VERT_HEAD, frag: SHAPE_SEL_FRAG }; },
    shapeBounds: shapeBounds,
    shapeOrigin: shapeOrigin,
    shapePack: shapePack,
    shapeAnchors: shapeAnchors,
    shapeGain: shapeGain,
    /* 高亮覆层的线圈：key 是参数名（l3Hi = 该参数的线圈，l3SelKind = 0） */
    shapeCoilOf: function (key) { return DEFAULT_COILS[key] || null; },
    /* 当前在脸上显示哪一组操控点（组件的界面状态，App 只读） */
    shapeGroup: function () { return UI_GROUP; },
    /* panel 存在时建模 App 不画通用 fields，整块参数区交给组件自己 */
    panel: panel,
    onEvent: onEvent,
    applyTo: applyTo,
    props: props,
    surface: surface,
    /* 运行时状态只走这两个口：liveState() 建一份不存盘的初值，tickLive(dt) 每帧推进。
     * 建模 App 不需要知道里面是眨眼还是呼吸。 */
    liveState: liveState,
    tickLive: tickLive,
    presets: [],
    buildGeometry: headGeometry,
    silhouette: silhouette,
    /* 面板底部那段说明，由组件自己写：它最清楚「这一份是从哪来的、能不能回原路」 */
    blurb: function () {
      if (!cache) return '正在读取流明 3D 的参考脸数据包…';
      return '顶点 <b>' + cache.verts + '</b> · 三角形 <b>' + (cache.mesh.primitives || [])
        .reduce(function (a, pr) { return a + pr.indices.count / 3; }, 0) +
        '</b> · 形态键 <b>' + cache.morphs.length + '</b>（名字与流明一致，可原路对回）。' +
        '加进场景后仍可在属性面板里改表情 —— 改的是同一份顶点，不新增对象。';
    },
    info: function () {
      if (!cache) return null;
      return {
        source: cache.meta.source,
        license: cache.meta.license,
        verts: cache.verts,
        morphs: cache.morphs.length,
        exprs: EXPR.length,
        size: cache.size,
        groups: (cache.mesh.primitives || []).length,
        tex: cache.tex ? 'inline-png' : ''
      };
    }
  };

  var reg = window.MDComponents || (window.MDComponents = {
    list: [],
    get: function (id) {
      for (var i = 0; i < this.list.length; i++) if (this.list[i].id === id) return this.list[i];
      return null;
    }
  });
  /* 同一个文件被加载两次时不要重复登记（manifest 内联 + 手工注入都可能发生） */
  for (var i = 0; i < reg.list.length; i++) if (reg.list[i].id === def.id) reg.list.splice(i--, 1);
  reg.list.push(def);

  window.MDLumenBridge = {
    load: load,
    geometry: headGeometry,
    silhouette: silhouette,
    component: def,
    status: function () {
      return { loaded: !!cache, loading: !!loading, path: ASSET_BASE };
    }
  };
})();
