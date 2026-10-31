/* 体检：UV 排布（js/uvpack.js）的装箱与写回
 * 用法：node tools/uvpack-check.js
 *
 * 为什么不用 Playwright 测：这里的错都是「数字错一点」，截图看不出来——
 *   · 岛超出 0–1（贴图被裁掉一块）
 *   · 两个岛叠在一起（两处互相抢颜色）
 *   · 同一个顶点被两个变换轮流覆盖（UV 撕成花屏）
 * 全是纯算术，所以直接给一份合成模型在 Node 里跑，断言 bbox 与真实 UV。
 * 真实模型的端到端（点按钮 → 岛图变化 → 存 GLB）在 tools/_uvpackcheck.js。
 */
const path = require('path');
const THREE = require(path.join(__dirname, '../vendor/three.min.js'));

global.window = global;
global.THREE = THREE;
require(path.join(__dirname, '../js/uvpack.js'));
const UvPack = global.UvPack;

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-5 : t);

/* 造 part：顶点 / UV / 三角形表 */
function mkPart(verts, uvs, tris) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  const idx = [];
  tris.forEach(t => idx.push(t[0], t[1], t[2]));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  return { g, pos: g.attributes.position, uv: g.attributes.uv, idx: g.index, tri: tris.length, mw: new THREE.Matrix4() };
}

/* 假 root：uvpack 只通过 traverse 找网格，够用就行 */
function mkRoot(list) {
  return {
    traverse: function (cb) {
      for (let i = 0; i < list.length; i++) {
        cb({ isMesh: true, geometry: list[i].geometry, material: list[i].material });
      }
    }
  };
}

/* 该 part 的三角形在 UV 上占到的格子（N×N 光栅化，用来判「两个网格有没有抢同一块 UV」） */
function coverage(part, N) {
  const set = new Uint8Array(N * N);
  const uv = part.uv;
  for (let t = 0; t < part.tri; t++) {
    const vi = k => part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
    const xs = [], ys = [];
    for (let k = 0; k < 3; k++) { const v = vi(k); xs.push(uv.getX(v) * N); ys.push(uv.getY(v) * N); }
    const den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
    if (Math.abs(den) < 1e-9) continue;
    const minx = Math.max(0, Math.floor(Math.min(...xs))), maxx = Math.min(N, Math.ceil(Math.max(...xs)));
    const miny = Math.max(0, Math.floor(Math.min(...ys))), maxy = Math.min(N, Math.ceil(Math.max(...ys)));
    for (let py = miny; py < maxy; py++) {
      for (let px = minx; px < maxx; px++) {
        const fx = px + 0.5, fy = py + 0.5;
        const l0 = ((ys[1] - ys[2]) * (fx - xs[2]) + (xs[2] - xs[1]) * (fy - ys[2])) / den;
        const l1 = ((ys[2] - ys[0]) * (fx - xs[2]) + (xs[0] - xs[2]) * (fy - ys[2])) / den;
        const l2 = 1 - l0 - l1;
        if (l0 >= -0.001 && l1 >= -0.001 && l2 >= -0.001) set[py * N + px] = 1;
      }
    }
  }
  return set;
}
function hitRatio(s1, s2) {
  let a1 = 0, a2 = 0, both = 0;
  for (let i = 0; i < s1.length; i++) {
    if (s1[i]) a1++;
    if (s2[i]) a2++;
    if (s1[i] && s2[i]) both++;
  }
  return both / Math.max(1, Math.min(a1, a2));
}

/* ---------------- 合成模型 ----------------
 * part0：3 个岛、各自独立顶点（原始 UV 已分开），三块面积差 10 倍，
 *        用来验证「不拆顶点也能排」+ 尺寸倍率 / 统一密度的语义。
 * part1：两个岛共用顶点 2 —— 这份几何不拆顶点就会被两个变换轮流覆盖。 */
const p0 = mkPart(
  [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    20, 0, 0, 22, 0, 0, 22, 2, 0, 20, 2, 0,
    30, 0, 0, 60, 0, 0, 60, 30, 0, 30, 30, 0],
  [0, 0, 0.4, 0, 0.4, 0.5, 0, 0.5,
    0.5, 0, 0.6, 0, 0.6, 0.1, 0.5, 0.1,
    0.6, 0.6, 0.9, 0.6, 0.9, 0.9, 0.6, 0.9],
  [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7], [8, 9, 10], [8, 10, 11]]
);
const p1 = mkPart(
  [0, 0, 0, 10, 0, 0, 5, 10, 0, 15, 5, 0, 20, 0, 0],
  [0, 0, 0.3, 0, 0.3, 0.3, 0.5, 0.5, 0.8, 0.6],
  [[0, 1, 2], [2, 3, 4]]
);

const a = {
  parts: [p0, p1],
  islands: [
    { id: 0, tris: [{ part: 0, t: 0 }, { part: 0, t: 1 }] },
    { id: 1, tris: [{ part: 0, t: 2 }, { part: 0, t: 3 }] },
    { id: 2, tris: [{ part: 0, t: 4 }, { part: 0, t: 5 }] },
    { id: 3, tris: [{ part: 1, t: 0 }] },
    { id: 4, tris: [{ part: 1, t: 1 }] }
  ],
  triIsland: null,
  /* 假 root：两个网格各一张贴图 → 两份独立 UV 空间（等价于 tripo 的 GLB） */
  root: mkRoot([{ geometry: p0.g, material: { map: { uuid: 'mapA' } } },
                { geometry: p1.g, material: { map: { uuid: 'mapB' } } }])
};

/* 实测每个岛的 UV 包围盒（写完之后读真实 UV，不信 ops 里的数） */
function realBoxes() {
  const out = [];
  a.islands.forEach(o => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    o.tris.forEach(ref => {
      const part = a.parts[ref.part], uv = part.uv;
      const vi = k => part.idx ? part.idx.getX(ref.t * 3 + k) : ref.t * 3 + k;
      for (let k = 0; k < 3; k++) {
        const v = vi(k), u = uv.getX(v), w = uv.getY(v);
        if (u < x0) x0 = u; if (u > x1) x1 = u;
        if (w < y0) y0 = w; if (w > y1) y1 = w;
      }
    });
    out.push({ id: o.id, part: o.tris[0].part, x0, y0, x1, y1 });
  });
  return out;
}

const PREC = 1e-5;
const sameBoxes = (b1, b2) => b1.every((b, i) => near(b.x0, b2[i].x0) && near(b.x1, b2[i].x1) && near(b.y0, b2[i].y0) && near(b.y1, b2[i].y1));

/* ---------------- 1. 排布：全部落进 0–1，互不重叠 ---------------- */
const base = realBoxes();
const snap = UvPack.snapshot(a);
const r1 = UvPack.pack(a, { scale: 1 });
check(r1.ok, 'pack 返回成功', 'fill=' + r1.fill.toFixed(3) + ' 岛数=' + Object.keys(r1.ops).length);
check(Object.keys(r1.ops).length === a.islands.length, '每个岛都有放置结果');

const ap1 = UvPack.apply(a, r1.ops);
UvPack.refresh(a);
check(ap1.rebuilt.indexOf(1) >= 0, '共享顶点的插槽被拆顶点', 'rebuilt=' + JSON.stringify(ap1.rebuilt));
check(ap1.rebuilt.indexOf(0) < 0, '顶点本来就分开的插槽不重建几何');
check(a.parts[0].idx !== null, 'part0 仍保留索引缓冲', 'idx=' + (a.parts[0].idx ? '有' : '无'));
check(a.parts[1].idx === null, 'part1 已展平为无索引几何');

const b1 = realBoxes();
check(b1.every(b => b.x0 >= -PREC && b.y0 >= -PREC && b.x1 <= 1 + PREC && b.y1 <= 1 + PREC),
  '所有岛都在 0–1 之内', b1.map(b => b.x0.toFixed(2) + ',' + b.y0.toFixed(2) + '→' + b.x1.toFixed(2) + ',' + b.y1.toFixed(2)).join(' | '));

let overlap = 0;
for (let i = 0; i < b1.length; i++) {
  for (let j = i + 1; j < b1.length; j++) {
    if (b1[i].part !== b1[j].part) continue;          // 不同插槽各自 0–1，本来就会重叠
    const A = b1[i], B = b1[j];
    const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    if (ox > PREC && oy > PREC) overlap++;
  }
}
check(overlap === 0, '同插槽内的岛互不重叠', '重叠对数=' + overlap);

/* 岛间必须留出边距：宽度不会被撑到贴着（pad/2 各一侧） */
let minGap = Infinity;
for (let i = 0; i < b1.length; i++) {
  for (let j = i + 1; j < b1.length; j++) {
    if (b1[i].part !== b1[j].part) continue;
    const A = b1[i], B = b1[j];
    const gx = Math.max(A.x0 - B.x1, B.x0 - A.x1);
    const gy = Math.max(A.y0 - B.y1, B.y0 - A.y1);
    minGap = Math.min(minGap, Math.max(gx, gy));
  }
}
check(minGap >= UvPack.PAD - PREC, '岛与岛之间留出了边距', '最小间隙=' + minGap.toFixed(4) + ' pad=' + UvPack.PAD);

/* 100% 时尺寸必须还原成原始大小（不是随便缩放） */
const b1Scaled = b1.map(b => ({ id: b.id, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
const baseMap = new Map(base.map(b => [b.id, b]));
check(b1Scaled.every(b => near(b.w, baseMap.get(b.id).x1 - baseMap.get(b.id).x0, 1e-4) &&
  near(b.h, baseMap.get(b.id).y1 - baseMap.get(b.id).y0, 1e-4)),
  '100% 时岛尺寸等于原始尺寸');

/* ---------------- 2. 幂等：还原后同参数再排一次，结果一模一样 ---------------- */
const opsA = JSON.stringify(r1.ops);
UvPack.restore(a, snap);
check(sameBoxes(realBoxes(), base), 'restore 把 UV 还原成原值');
check(a.parts[1].idx !== null && a.parts[1].g === snap.parts[1].g, 'restore 把拆过的几何整个换回来了');

const r2 = UvPack.pack(a, { scale: 1 });
check(JSON.stringify(r2.ops) === opsA, '同参数重复排布结果完全一致（幂等）');
UvPack.apply(a, r2.ops);
UvPack.refresh(a);

/* ---------------- 3. 尺寸倍率：50% → 面积 1/4 ---------------- */
UvPack.restore(a, snap);
const r3 = UvPack.pack(a, { scale: 0.5 });
UvPack.apply(a, r3.ops);
const b3 = realBoxes();
check(b3.every(b => near(b.x1 - b.x0, (baseMap.get(b.id).x1 - baseMap.get(b.id).x0) * 0.5, 1e-4)),
  '50% 时每个岛的宽高都减半');
check(near(r3.fill, r1.fill * 0.25, 2e-3), '50% 的 UV 占用约为原来的 1/4',
  r3.fill.toFixed(4) + ' vs ' + (r1.fill * 0.25).toFixed(4));

/* ---------------- 4. 统一贴图密度：UV 面积 / 3D 面积 处处相等 ---------------- */
UvPack.restore(a, snap);
const r4 = UvPack.pack(a, { scale: 1, equalDensity: true });
UvPack.apply(a, r4.ops);
UvPack.refresh(a);
const ratio = a.islands.map(o => {
  /* UV 面积 / 3D 面积：refresh 后的 o.area 是 UV 面积 */
  const part = a.parts[o.tris[0].part];
  let a3 = 0;
  o.tris.forEach(ref => {
    const vi = k => part.idx ? part.idx.getX(ref.t * 3 + k) : ref.t * 3 + k;
    const P = k => { const v = vi(k); return new THREE.Vector3(part.pos.getX(v), part.pos.getY(v), part.pos.getZ(v)); };
    const A = P(0), B = P(1), C = P(2);
    a3 += B.sub(A).cross(C.sub(A)).length() / 2;
  });
  return o.area / a3;
});
/* 不同插槽各自归一化，所以只在同插槽内比 */
const g0 = ratio.slice(0, 3), g1 = ratio.slice(3);
const spread = arr => Math.max(...arr) / Math.min(...arr);
check(spread(g0) < 1.02 && spread(g1) < 1.02, '统一密度后「UV 面积 / 3D 面积」处处相等',
  'part0 离散=' + spread(g0).toFixed(4) + ' part1=' + spread(g1).toFixed(4));

/* ---------------- 5. 写回不能产生 NaN / 越界 ---------------- */
UvPack.restore(a, snap);
const r5 = UvPack.pack(a, { scale: 2 });   // 故意超装：必须自动降级而不是吐出越界结果
UvPack.apply(a, r5.ops);
const b5 = realBoxes();
check(r5.scale < 2 && r5.notes.length > 0, '放不下时自动降级并给出说明（scale 报的是最终倍率）',
  '最终 ' + Math.round(r5.scale * 100) + '% · ' + r5.notes.join('；'));
check(b5.every(b => b.x1 <= 1 + PREC && b.y1 <= 1 + PREC), '降级后仍然不越界');
const nan = (() => {
  for (const p of a.parts) {
    const arr = p.uv.array;
    for (let i = 0; i < arr.length; i++) if (!isFinite(arr[i])) return true;
  }
  return false;
})();
check(!nan, '写回的 UV 没有 NaN');

UvPack.restore(a, snap);
check(sameBoxes(realBoxes(), base), '最后一轮 restore 仍然精确还原');

/* ---------------- 6. 共用 UV 空间：多个网格不许各装一份 0–1 ----------------
 * 「身体.obj」的 bug（2026-11-01）：一个 OBJ 里三个 object 摊在同一张 UV 上、且都没贴图。
 * 按 mesh 分别排布 = 三套 UV 全塞进同一块 0–1，上色时互相抢颜色，
 * 看起来就是「同一个岛的位置被别的插槽占掉」。 */
const q0 = mkPart([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5], [[0, 1, 2], [0, 2, 3]]);
const q1 = mkPart([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], [0.5, 0.5, 1, 0.5, 1, 1, 0.5, 1], [[0, 1, 2], [0, 2, 3]]);
const a2 = {
  parts: [q0, q1],
  islands: [
    { id: 20, tris: [{ part: 0, t: 0 }, { part: 0, t: 1 }] },
    { id: 21, tris: [{ part: 1, t: 0 }, { part: 1, t: 1 }] }
  ],
  triIsland: null,
  root: mkRoot([{ geometry: q0.g, material: {} }, { geometry: q1.g, material: {} }])
};
const g2 = UvPack.groups(a2);
check(g2.length === 1 && g2[0].length === 2, '没有贴图的多个网格判为同一份 UV 空间', JSON.stringify(g2));

const r6 = UvPack.pack(a2, { scale: 1 });
UvPack.apply(a2, r6.ops);
UvPack.refresh(a2);
const ov6 = hitRatio(coverage(a2.parts[0], 64), coverage(a2.parts[1], 64));
check(ov6 < 0.05, '共用 UV 的两个网格排布后不再互相覆盖', '重叠 ' + (ov6 * 100).toFixed(1) + '%');

/* 反过来：各有一张贴图必须分开装，否则白扔一半以上 UV 空间 */
check(UvPack.groups(a).length === 2, '各有一张贴图的网格分成两组 UV 空间', JSON.stringify(UvPack.groups(a)));

console.log(fails ? '\n❌ ' + fails + ' 项未通过' : '\n✅ UV 排布全部通过');
process.exit(fails ? 1 : 0);
