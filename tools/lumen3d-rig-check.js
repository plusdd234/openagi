/* 量化校验：流明 3D 的 16 个脸型变形器 + vrc.v_aa 张嘴形态键
 *
 * 背景：app.js 的 SHAPE_VERT_HEAD 用「面部坐标系」做变形
 *   t = (y - minY) / H           线性高度
 *   v = 锚点坐标（下巴 0 / 嘴 0.30 / 鼻尖 0.55 / 眼 0.66 / 额 0.90）
 *   u = x / halfW(t)             横向坐标，±1 落在脸缘
 * 这个脚本在 Node 里把同一套数学跑一遍，对 16 个参数各取 0 / 100 两个极值，量化：
 *   ① 边拉伸比 / 压缩比（皮肤与五官线圈分开统计）
 *   ② 三角形面积比
 *   ③ 上脸泄漏：下半张脸参数在 v > 0.8 的位移必须为 0
 *   ④ 五官泄漏：眼 / 鼻参数的影响范围必须落在各自线圈内
 *   ⑤ 左右对称性
 *   ⑥ 叠加 vrc.v_aa 形态键后，上脸位移与联合拉伸
 *
 * 用法：
 *   node tools/lumen3d-rig-check.js           控制台报告，失败 exit 1
 *   node tools/lumen3d-rig-check.js --json    JSON 输出，失败 exit 1
 *
 * 注意：数学是 apps/lumen3d/app.js 里 SHAPE_VERT_HEAD 的镜像，两边必须同步修改。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.indexOf('--json') >= 0;

/* 通过阈值；改这里等于改验收标准。
 * 脸模是低模：中位边长 3.9mm、眼睛/嘴的贴图区最小 0.1mm，掩码过渡一旦窄于网格边长，
 * 比值就会被放大。因此「皮肤 / 五官线圈」分开验收：
 *   - 皮肤（脸颊、下颌、额头）目标是不出现折痕，允许 1.40 的局部拉伸；
 *   - 眼、嘴、鼻是贴图随形变的区域，允许到 1.60；
 *   - 面积比同时兜住翻面（<0）和压扁（<0.5）。 */
const LIMIT = {
  skinStretch: 1.40,        // 脸部皮肤最大边拉伸比（单参数极值）
  skinStretchMorph: 1.65,   // 叠加 vrc.v_aa 之后
  skinSquash: 0.70,         // 皮肤最小边压缩比
  areaMin: 0.50,            // 三角形面积比下限
  areaMax: 1.60,            // 三角形面积比上限
  featureStretch: 1.60,     // 眼 / 嘴 / 鼻线圈内部允许的局部拉伸（贴图随形变）
  upperLeak: 1e-9,          // 下半张脸参数在 v > 0.8 的位移
  aaUpper: 0.004            // vrc.v_aa 在 v > 0.8 的最大位移（世界单位）
};

const SHAPE_DEFS = [
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
  { key: 'mouthPos', label: '嘴位', group: '嘴部' }
];

/* 只影响下半张脸：v > 0.8 必须完全不动 */
const LOWER = { chin: 1, jaw: 1, chinWidth: 1, mouth: 1, lipThick: 1, mouthPos: 1 };
/* 五官参数：影响范围必须被各自线圈兜住 */
const FEATURE = { eyeDist: 'eye', eyeWidth: 'eye', eyeHeight: 'eye', eyeTilt: 'eye', noseLength: 'nose' };

/* 曲面范围线圈的默认值，必须与 apps/lumen3d/app.js 的 DEFAULT_COILS 完全一致
 * [uc, ur, vc, vr]；u 取 |u| 左右对称 */
const COILS = {
  width: [0.00, 3.00, 0.42, 0.55],
  length: [0.50, 1.80, 0.55, 0.95],
  chin: [0.00, 3.00, 0.10, 0.34],
  jaw: [0.00, 3.00, 0.10, 0.62],
  cheek: [0.72, 0.60, 0.60, 0.30],
  cheekFull: [0.45, 0.80, 0.50, 0.40],
  forehead: [0.00, 3.00, 0.86, 0.22],
  eyeDist: [0.48, 0.34, 0.66, 0.13],
  eyeWidth: [0.52, 0.30, 0.66, 0.13],
  eyeHeight: [0.52, 0.29, 0.66, 0.13],
  eyeTilt: [0.55, 0.32, 0.66, 0.13],
  noseLength: [0.00, 0.50, 0.55, 0.23],
  chinWidth: [0.00, 3.00, 0.06, 0.30],
  mouth: [0.00, 0.72, 0.30, 0.18],
  lipThick: [0.00, 0.55, 0.30, 0.17],
  mouthPos: [0.00, 0.80, 0.30, 0.24]
};

/* ---------- 读资源 ---------- */
function loadModel() {
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  ['face-meta.js', 'face-geometry.js'].forEach(function (name) {
    const file = path.join(ROOT, 'apps', 'lumen3d', 'model', name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: name });
  });
  const meta = sandbox.window.LUMEN3D_META;
  const raw = Buffer.from(sandbox.window.LUMEN3D_GEOMETRY, 'base64');
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const mesh = meta.avatar.meshes[0];
  function values(desc) {
    const Type = desc.type === 'uint32' ? Uint32Array : Float32Array;
    if (desc.offset + desc.count * 4 > bytes.byteLength) throw new Error('几何数据越界');
    return new Type(bytes, desc.offset, desc.count);
  }
  return { meta: meta, mesh: mesh, values: values };
}

/* ---------- app.js SHAPE_VERT_HEAD 的 JS 镜像 ---------- */
const H_REF = 0.202114;

function createRig(bounds) {
  const MIN = bounds.minY;
  const H = bounds.maxY - bounds.minY;
  const INV = 1 / H;
  const hScale = H / H_REF;

  function seg(t, a, b, va, vb) {
    const k = Math.min(1, Math.max(0, (t - a) / Math.max(b - a, 1e-5)));
    return va + (vb - va) * k;
  }
  function sstep(a, b, x) {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  }
  function vOf(t) {
    let v = seg(t, 0.000, 0.120, 0.00, 0.30);
    if (t >= 0.120) v = seg(t, 0.120, 0.215, 0.30, 0.55);
    if (t >= 0.215) v = seg(t, 0.215, 0.290, 0.55, 0.66);
    if (t >= 0.290) v = seg(t, 0.290, 0.450, 0.66, 0.80);
    if (t >= 0.450) v = seg(t, 0.450, 0.600, 0.80, 0.90);
    if (t >= 0.600) v = seg(t, 0.600, 0.800, 0.90, 0.97);
    if (t >= 0.800) v = seg(t, 0.800, 1.000, 0.97, 1.00);
    return v;
  }
  function halfW(t) {
    let w = seg(t, 0.000, 0.040, 0.015, 0.030);
    if (t >= 0.040) w = seg(t, 0.040, 0.080, 0.030, 0.042);
    if (t >= 0.080) w = seg(t, 0.080, 0.120, 0.042, 0.050);
    if (t >= 0.120) w = seg(t, 0.120, 0.160, 0.050, 0.056);
    if (t >= 0.160) w = seg(t, 0.160, 0.200, 0.056, 0.070);
    if (t >= 0.200) w = seg(t, 0.200, 0.250, 0.070, 0.074);
    if (t >= 0.250) w = seg(t, 0.250, 0.290, 0.074, 0.080);
    if (t >= 0.290) w = seg(t, 0.290, 0.350, 0.080, 0.081);
    if (t >= 0.350) w = seg(t, 0.350, 0.450, 0.081, 0.072);
    if (t >= 0.450) w = seg(t, 0.450, 0.600, 0.072, 0.077);
    if (t >= 0.600) w = seg(t, 0.600, 0.750, 0.077, 0.061);
    if (t >= 0.750) w = seg(t, 0.750, 0.900, 0.061, 0.058);
    if (t >= 0.900) w = seg(t, 0.900, 1.000, 0.058, 0.050);
    return w;
  }
  function coil(u, v, uc, ur, vc, vr) {
    const du = (u - uc) / Math.max(ur, 1e-4);
    const dv = (v - vc) / Math.max(vr, 1e-4);
    return 1 - sstep(0.15, 1.10, du * du + dv * dv);
  }
  /* 与 shader 的 l3C(l3CoilU[i], au, v) 一致：调用点固定 key */
  function coilOf(key, u, v) {
    const c = COILS[key];
    return coil(u, v, c[0], c[1], c[2], c[3]);
  }

  /* 计算一个顶点的坐标系与所有掩码（与 shader 一致） */
  function frame(rest) {
    const t = Math.min(1, Math.max(0, (rest[1] - MIN) * INV));
    const v = vOf(t);
    const w = Math.max(halfW(t), 0.020) * hScale;
    const u = rest[0] / w;
    const au = Math.abs(u);
    const front = sstep(0.045, 0.065, rest[2]);
    return {
      t: t, v: v, w: w, u: u, au: au,
      mWidth: coilOf('width', au, v),
      mLength: coilOf('length', au, v),
      mChin: coilOf('chin', au, v),
      mJaw: coilOf('jaw', au, v),
      mCheek: coilOf('cheek', au, v),
      mCheekFull: coilOf('cheekFull', au, v),
      mForehead: coilOf('forehead', au, v),
      mEyeDist: coilOf('eyeDist', au, v),
      mEyeWidth: coilOf('eyeWidth', au, v),
      mEyeHeight: coilOf('eyeHeight', au, v),
      mEyeTilt: coilOf('eyeTilt', au, v),
      mNose: coilOf('noseLength', au, v) * front,
      mChinWidth: coilOf('chinWidth', au, v),
      mMouth: coilOf('mouth', au, v),
      mLip: coilOf('lipThick', au, v),
      mMouthPos: coilOf('mouthPos', au, v)
    };
  }

  /* 眼 / 嘴 / 鼻区域的边单独放宽阈值 */
  function featureOf(f) {
    if (!f) return false;
    return f.mEyeDist > 0.05 || f.mEyeWidth > 0.05 || f.mEyeHeight > 0.05 || f.mEyeTilt > 0.05 ||
      f.mMouth > 0.05 || f.mLip > 0.05 || f.mMouthPos > 0.05 || f.mNose > 0.05;
  }

  const eyeY = MIN + 0.29 * H;
  const mouthY = MIN + 0.12 * H;

  /* s: 16 个 -1..1 的归一化参数；返回 [x, y, z] */
  function deform(rest, s) {
    const f = frame(rest);
    const px = rest[0], py = rest[1], pz = rest[2];
    const au = f.au;
    const s00 = s[0], s01 = s[1], s02 = s[2], s03 = s[3];
    const s10 = s[4], s11 = s[5], s12 = s[6], s13 = s[7];
    const s20 = s[8], s21 = s[9], s22 = s[10], s23 = s[11];
    const s30 = s[12], s31 = s[13], s32 = s[14], s33 = s[15];

    let x = px, y = py;
    /* [0] 轮廓 */
    y = eyeY + (y - eyeY) * (1 + s01 * 0.13 * f.mLength);
    y = mouthY + (y - mouthY) * (1 + s02 * 0.35 * f.mChin);
    let wx = 1 + s00 * 0.24 * f.mWidth;
    wx *= 1 - s03 * 0.18 * f.mJaw;
    /* [1] 面中 */
    wx *= 1 + s10 * 0.11 * f.mCheek;
    wx *= 1 + s11 * 0.09 * f.mCheekFull;
    wx *= 1 + s12 * 0.16 * f.mForehead;
    x *= wx;
    x += (px >= 0 ? 1 : -1) * s13 * 0.05 * f.w * f.mEyeDist;
    /* [2] 眼鼻 */
    const eyeX = 0.50 * f.w;
    const side = px >= 0 ? 1 : -1;
    x = side * eyeX + (x - side * eyeX) * (1 + s20 * 0.20 * f.mEyeWidth);
    y = eyeY + (y - eyeY) * (1 + s21 * 0.16 * f.mEyeHeight);
    y += Math.min(1, Math.max(-1, (au - 0.50) * 5)) * s22 * 0.0035 * hScale * f.mEyeTilt;
    y -= s23 * 0.0035 * hScale * f.mNose;
    /* [3] 下巴与嘴 */
    x *= 1 + s30 * 0.18 * f.mChinWidth;
    x *= 1 + s31 * 0.30 * f.mMouth;
    y = mouthY + (y - mouthY) * (1 + s32 * 0.34 * f.mLip);
    y += s33 * 0.0035 * hScale * f.mMouthPos;
    return [x, y, pz];
  }

  return {
    deform: deform, frame: frame, featureOf: featureOf,
    bounds: { minY: MIN, H: H, eyeY: eyeY, mouthY: mouthY }
  };
}

/* ---------- 统计 ---------- */
function dist(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function main() {
  const model = loadModel();
  const pos = model.values(model.mesh.position);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pos.length; i += 3) {
    if (pos[i] < minY) minY = pos[i];
    if (pos[i] > maxY) maxY = pos[i];
  }
  const rig = createRig({ minY: minY, maxY: maxY });
  const N = model.mesh.position.count;

  /* 顶点只取被三角形引用到的，避免缓冲区里的未用数据干扰统计 */
  const used = new Uint8Array(N);
  const tris = [];
  model.mesh.primitives.forEach(function (prim) {
    const idx = model.values(prim.indices);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      used[a] = used[b] = used[c] = 1;
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
  });

  const edgeSet = new Set();
  const edges = [];
  tris.forEach(function (t) {
    for (let k = 0; k < 3; k++) {
      const a = Math.min(t[k], t[(k + 1) % 3]);
      const b = Math.max(t[k], t[(k + 1) % 3]);
      const key = a * N + b;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push([a, b]);
    }
  });

  function vertex(i) { return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]; }

  const rest = new Float64Array(N * 3);
  const frames = new Array(N);
  for (let i = 0; i < N; i++) {
    if (!used[i]) continue;
    const p = vertex(i);
    rest[i * 3] = p[0]; rest[i * 3 + 1] = p[1]; rest[i * 3 + 2] = p[2];
    frames[i] = rig.frame(p);
  }

  const restEdge = new Float64Array(edges.length);
  edges.forEach(function (e, i) { restEdge[i] = dist(vertex(e[0]), vertex(e[1])); });

  const restArea = new Float64Array(tris.length);
  tris.forEach(function (t, i) {
    const a = vertex(t[0]), b = vertex(t[1]), c = vertex(t[2]);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    restArea[i] = Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
  });

  function zeros() { return new Float64Array(16); }

  function stats(s) {
    const out = new Float64Array(N * 3);
    let maxStretch = 0, minStretch = Infinity;
    let featureStretch = 0, featureSquash = Infinity;
    let areaMin = Infinity, areaMax = 0;
    let worstEdge = -1, worstFeatureEdge = -1, worstTri = -1, worstTriRatio = 0;
    for (let i = 0; i < N; i++) {
      if (!used[i]) continue;
      const p = rest.subarray(i * 3, i * 3 + 3);
      const q = rig.deform([p[0], p[1], p[2]], s);
      out[i * 3] = q[0]; out[i * 3 + 1] = q[1]; out[i * 3 + 2] = q[2];
    }
    for (let i = 0; i < edges.length; i++) {
      if (restEdge[i] < 1e-7) continue;
      const e = edges[i];
      const a = [out[e[0] * 3], out[e[0] * 3 + 1], out[e[0] * 3 + 2]];
      const b = [out[e[1] * 3], out[e[1] * 3 + 1], out[e[1] * 3 + 2]];
      const ratio = dist(a, b) / restEdge[i];
      const feature = rig.featureOf(frames[e[0]]) || rig.featureOf(frames[e[1]]);
      if (feature) {
        if (ratio > featureStretch) { featureStretch = ratio; worstFeatureEdge = i; }
        if (ratio < featureSquash) featureSquash = ratio;
      } else {
        if (ratio > maxStretch) { maxStretch = ratio; worstEdge = i; }
        if (ratio < minStretch) minStretch = ratio;
      }
    }
    for (let i = 0; i < tris.length; i++) {
      if (restArea[i] < 1e-12) continue;
      const t = tris[i];
      const a = [out[t[0] * 3], out[t[0] * 3 + 1], out[t[0] * 3 + 2]];
      const b = [out[t[1] * 3], out[t[1] * 3 + 1], out[t[1] * 3 + 2]];
      const c = [out[t[2] * 3], out[t[2] * 3 + 1], out[t[2] * 3 + 2]];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const ratio = Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5 / restArea[i];
      if (ratio < areaMin) areaMin = ratio;
      if (ratio > areaMax) { areaMax = ratio; worstTri = i; worstTriRatio = ratio; }
    }
    return {
      out: out, maxStretch: maxStretch, minStretch: minStretch,
      featureStretch: featureStretch, featureSquash: featureSquash,
      areaMin: areaMin, areaMax: areaMax,
      worstEdge: worstEdge, worstFeatureEdge: worstFeatureEdge,
      worstTri: worstTri, worstTriRatio: worstTriRatio
    };
  }

  /* 某一类顶点上的最大 / 最小位移 */
  function leak(out, predicate) {
    let max = 0;
    for (let i = 0; i < N; i++) {
      if (!used[i] || !frames[i] || !predicate(frames[i])) continue;
      const d = dist(
        [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]],
        [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]
      );
      if (d > max) max = d;
    }
    return max;
  }

  function movedBox(out) {
    const box = { uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity };
    for (let i = 0; i < N; i++) {
      if (!used[i] || !frames[i]) continue;
      const d = dist(
        [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]],
        [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]
      );
      if (d < 1e-9) continue;
      const f = frames[i];
      if (f.u < box.uMin) box.uMin = f.u;
      if (f.u > box.uMax) box.uMax = f.u;
      if (f.v < box.vMin) box.vMin = f.v;
      if (f.v > box.vMax) box.vMax = f.v;
    }
    return box;
  }

  /* vrc.v_aa 形态键 */
  const aa = model.mesh.morphs.find(function (m) { return m.name === 'vrc.v_aa'; });
  if (!aa) throw new Error('缺少 vrc.v_aa 形态键');
  const delta = model.values(aa.position);
  const aaPos = new Float64Array(N * 3);
  for (let i = 0; i < N * 3; i++) aaPos[i] = rest[i] + delta[i];
  const aaUpper = (function () {
    let max = 0;
    for (let i = 0; i < N; i++) {
      if (!used[i] || !frames[i] || frames[i].v <= 0.8) continue;
      const d = dist(
        [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]],
        [aaPos[i * 3], aaPos[i * 3 + 1], aaPos[i * 3 + 2]]
      );
      if (d > max) max = d;
    }
    return max;
  })();

  /* 叠加 aa 后重新跑边 / 面积：s 从 rest 换成 aaPos */
  function statsOn(base, s) {
    const out = new Float64Array(N * 3);
    for (let i = 0; i < N; i++) {
      if (!used[i]) continue;
      const q = rig.deform([base[i * 3], base[i * 3 + 1], base[i * 3 + 2]], s);
      out[i * 3] = q[0]; out[i * 3 + 1] = q[1]; out[i * 3 + 2] = q[2];
    }
    let maxStretch = 0, minStretch = Infinity, areaMin = Infinity, areaMax = 0;
    for (let i = 0; i < edges.length; i++) {
      if (restEdge[i] < 1e-7) continue;
      const e = edges[i];
      const a = [out[e[0] * 3], out[e[0] * 3 + 1], out[e[0] * 3 + 2]];
      const b = [out[e[1] * 3], out[e[1] * 3 + 1], out[e[1] * 3 + 2]];
      const ra = [base[e[0] * 3], base[e[0] * 3 + 1], base[e[0] * 3 + 2]];
      const rb = [base[e[1] * 3], base[e[1] * 3 + 1], base[e[1] * 3 + 2]];
      const ratio = dist(a, b) / Math.max(dist(ra, rb), 1e-7);
      if (ratio > maxStretch) maxStretch = ratio;
      if (ratio < minStretch) minStretch = ratio;
    }
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const a = [out[t[0] * 3], out[t[0] * 3 + 1], out[t[0] * 3 + 2]];
      const b = [out[t[1] * 3], out[t[1] * 3 + 1], out[t[1] * 3 + 2]];
      const c = [out[t[2] * 3], out[t[2] * 3 + 1], out[t[2] * 3 + 2]];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const area = Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
      const ra = [base[t[0] * 3], base[t[0] * 3 + 1], base[t[0] * 3 + 2]];
      const rb = [base[t[1] * 3], base[t[1] * 3 + 1], base[t[1] * 3 + 2]];
      const rc = [base[t[2] * 3], base[t[2] * 3 + 1], base[t[2] * 3 + 2]];
      const p1 = [rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2]];
      const p2 = [rc[0] - ra[0], rc[1] - ra[1], rc[2] - ra[2]];
      const qx = p1[1] * p2[2] - p1[2] * p2[1];
      const qy = p1[2] * p2[0] - p1[0] * p2[2];
      const qz = p1[0] * p2[1] - p1[1] * p2[0];
      const baseArea = Math.sqrt(qx * qx + qy * qy + qz * qz) * 0.5;
      if (baseArea < 1e-12) continue;
      const ratio = area / baseArea;
      if (ratio < areaMin) areaMin = ratio;
      if (ratio > areaMax) areaMax = ratio;
    }
    return { maxStretch: maxStretch, minStretch: minStretch, areaMin: areaMin, areaMax: areaMax };
  }

  /* 左右对称：f(-x) 必须等于 mirror(f(x)) */
  let symmetry = 0;
  for (let i = 0; i < N; i++) {
    if (!used[i] || !frames[i]) continue;
    const p = [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]];
    const s = zeros();
    s[0] = 1; s[4] = 1; s[8] = 1; s[13] = 1; s[14] = 1;
    const a = rig.deform(p, s);
    const m = rig.deform([-p[0], p[1], p[2]], s);
    const e = Math.max(Math.abs(a[0] + m[0]), Math.abs(a[1] - m[1]), Math.abs(a[2] - m[2]));
    if (e > symmetry) symmetry = e;
  }

  /* ---------- 逐参数极值 ---------- */
  const rows = [];
  SHAPE_DEFS.forEach(function (def, index) {
    const worst = { key: def.key, label: def.label, group: def.group };
    [1, -1].forEach(function (sign) {
      const s = zeros();
      s[index] = sign;
      const st = stats(s);
      const withMorph = statsOn(aaPos, s);
      const tag = sign > 0 ? '100' : '0';
      let leakValue = 0;
      if (LOWER[def.key]) leakValue = leak(st.out, function (f) { return f.v > 0.8; });
      const box = movedBox(st.out);
      if (!worst.stretch || st.maxStretch > worst.stretch) worst.stretch = st.maxStretch;
      if (!worst.squash || st.minStretch < worst.squash) worst.squash = st.minStretch;
      if (!worst.feature || st.featureStretch > worst.feature) worst.feature = st.featureStretch;
      if (!worst.areaMin || st.areaMin < worst.areaMin) worst.areaMin = st.areaMin;
      if (!worst.areaMax || st.areaMax > worst.areaMax) worst.areaMax = st.areaMax;
      if (!worst.morph || withMorph.maxStretch > worst.morph) worst.morph = withMorph.maxStretch;
      if (!worst.morphSquash || withMorph.minStretch < worst.morphSquash) worst.morphSquash = withMorph.minStretch;
      if (!worst.morphAreaMin || withMorph.areaMin < worst.morphAreaMin) worst.morphAreaMin = withMorph.areaMin;
      if (!worst.morphAreaMax || withMorph.areaMax > worst.morphAreaMax) worst.morphAreaMax = withMorph.areaMax;
      if (leakValue > (worst.leak || 0)) worst.leak = leakValue;
      if (!worst.box || sign > 0) worst.box = box;
      worst[tag] = {
        stretch: st.maxStretch, squash: st.minStretch, feature: st.featureStretch,
        area: [st.areaMin, st.areaMax], morph: withMorph.maxStretch, leak: leakValue
      };
    });
    /* 五官参数的影响范围必须在线圈内（u 有正负，取绝对值上界） */
    if (FEATURE[def.key]) {
      const b = worst.box;
      const auMax = Math.max(Math.abs(b.uMin), Math.abs(b.uMax));
      if (FEATURE[def.key] === 'eye') {
        worst.contained = auMax < 0.90 && b.vMin > 0.52 && b.vMax < 0.80;
      } else {
        worst.contained = auMax < 0.70 && b.vMin > 0.28 && b.vMax < 0.80;
      }
    }
    const fails = [];
    if (worst.stretch > LIMIT.skinStretch) fails.push('皮肤拉伸 ' + worst.stretch.toFixed(3));
    if (worst.squash < LIMIT.skinSquash) fails.push('皮肤压缩 ' + worst.squash.toFixed(3));
    if (worst.feature > LIMIT.featureStretch) fails.push('五官拉伸 ' + worst.feature.toFixed(3));
    if (worst.areaMin < LIMIT.areaMin) fails.push('面积下限 ' + worst.areaMin.toFixed(3));
    if (worst.areaMax > LIMIT.areaMax) fails.push('面积上限 ' + worst.areaMax.toFixed(3));
    if (worst.morph > LIMIT.skinStretchMorph) fails.push('张嘴联合拉伸 ' + worst.morph.toFixed(3));
    if ((worst.leak || 0) > LIMIT.upperLeak) fails.push('上脸泄漏 ' + (worst.leak || 0).toExponential(2));
    if (worst.contained === false) fails.push('影响范围越出线圈');
    worst.fails = fails;
    rows.push(worst);
  });

  const identity = statsOn(rest, zeros());
  const identityOk = identity.maxStretch > 0.9999 && identity.maxStretch < 1.0001 &&
    Math.abs(identity.minStretch - 1) < 0.0001;

  const globalFails = [];
  if (aaUpper > LIMIT.aaUpper) globalFails.push('vrc.v_aa 上脸位移 ' + aaUpper.toFixed(4));
  if (!identityOk) globalFails.push('零参数不是恒等变换');
  if (symmetry > 1e-9) globalFails.push('左右不对称 ' + symmetry.toExponential(2));
  rows.forEach(function (row) { if (row.fails.length) globalFails.push(row.label + '：' + row.fails.join(' / ')); });

  const result = {
    ok: globalFails.length === 0,
    bounds: { minY: minY, maxY: maxY, height: maxY - minY },
    vertices: N,
    usedVertices: used.reduce(function (n, v) { return n + v; }, 0),
    edges: edges.length,
    triangles: tris.length,
    aaUpper: aaUpper,
    symmetry: symmetry,
    identity: identityOk,
    limits: LIMIT,
    params: rows.map(function (row) {
      return {
        key: row.key, label: row.label, group: row.group,
        stretch: row.stretch, squash: row.squash, featureStretch: row.feature,
        areaMin: row.areaMin, areaMax: row.areaMax,
        morphStretch: row.morph, leak: row.leak || 0,
        contained: row.contained === undefined ? null : row.contained,
        affectedBox: row.box ? [row.box.uMin, row.box.uMax, row.box.vMin, row.box.vMax] : null,
        at100: row['100'], at0: row['0'],
        fails: row.fails
      };
    }),
    fails: globalFails
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('流明 3D 变形器量化校验');
    console.log('脸模 ' + result.usedVertices + ' 顶点 / ' + result.edges + ' 边 / ' +
      result.triangles + ' 三角形，H=' + (maxY - minY).toFixed(6));
    console.log('阈值：皮肤拉伸 ≤' + LIMIT.skinStretch + '，压缩 ≥' + LIMIT.skinSquash +
      '，面积 ' + LIMIT.areaMin + '–' + LIMIT.areaMax +
      '，五官拉伸 ≤' + LIMIT.featureStretch + '，张嘴联合 ≤' + LIMIT.skinStretchMorph);
    console.log('');
    console.log('参数'.padEnd(8) + ' 拉伸   压缩   五官   面积区间        张嘴联合  上脸泄漏');
    rows.forEach(function (row) {
      console.log(
        (row.fails.length ? ' ❌ ' : ' ✅ ') + row.label.padEnd(8) +
        ' ' + row.stretch.toFixed(3) +
        '  ' + row.squash.toFixed(3) +
        '  ' + row.feature.toFixed(3) +
        '  ' + row.areaMin.toFixed(3) + '–' + row.areaMax.toFixed(3) +
        '  ' + row.morph.toFixed(3) +
        '    ' + (row.leak || 0).toExponential(1)
      );
    });
    console.log('');
    console.log('vrc.v_aa 上脸（v>0.8）最大位移：' + aaUpper.toFixed(5) +
      '（阈值 ' + LIMIT.aaUpper + '）');
    console.log('左右对称误差：' + symmetry.toExponential(2));
    console.log(globalFails.length ? '\n不通过：\n - ' + globalFails.join('\n - ') : '\n全部通过');
  }

  process.exit(result.ok ? 0 : 1);
}

main();
