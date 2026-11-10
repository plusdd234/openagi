/* 探针：数据层算子（阵列 / 溶解 / 细分一遍 / 布尔体检）回归
 * 用法：node tools/probe-ops2.js
 *
 * 为什么用 vm 而不是 playwright：这几个算子只碰数组和纯函数，不需要 WebGL / DOM；
 * vm 里喂一个 window 桩就能跑，快、无浏览器版本差异，也不会被外壳的拆分进度影响。
 * pageerror 在这里等价于「脚本加载 / 算子执行抛出异常」，一样会累计成失败项。
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const info = (name, extra) => console.log(' ·· ' + name + (extra ? ' · ' + extra : ''));

(async () => {
  const root = path.join(__dirname, '..');
  const errors = [];
  const sandbox = vm.createContext({ console: console });
  sandbox.window = sandbox;
  /* 顺序不能反：operators 依赖 SeedModel.Mesh */
  for (const rel of ['js/seed-mesh-core.js', 'js/seed-operators.js']) {
    try {
      vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), sandbox, { filename: rel });
    } catch (e) {
      errors.push(rel + ': ' + (e && e.message));
    }
  }
  const M = sandbox.SeedModel && sandbox.SeedModel.Mesh;
  const Ops = sandbox.SeedOps;
  check(!!(M && Ops), '两个脚本加载完成且导出 SeedModel.Mesh / SeedOps', errors.join(' | '));
  if (!M || !Ops) {
    console.log('\n❌ 脚本加载失败，后续断言跳过');
    process.exit(1);
  }

  /* 单位立方体（6 个四边面，闭合流形），可指定中心与边长 */
  function cube(cx, cy, cz, s) {
    cx = cx || 0; cy = cy || 0; cz = cz || 0; s = s == null ? 1 : s;
    const h = s / 2, m = M.create();
    const p = [
      [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
      [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]
    ];
    p.forEach(v => m.positions.push(v[0] + cx, v[1] + cy, v[2] + cz));
    m.vertexIds = [0, 1, 2, 3, 4, 5, 6, 7];
    m.nextVertexId = 8;
    const quads = [
      [1, 0, 3, 2],   /* -Z */
      [4, 5, 6, 7],   /* +Z */
      [1, 2, 6, 5],   /* +X */
      [0, 4, 7, 3],   /* -X */
      [3, 7, 6, 2],   /* +Y */
      [0, 1, 5, 4]    /* -Y */
    ];
    m.faceOffsets = [0];
    quads.forEach(q => {
      q.forEach(v => m.faceIndices.push(v));
      m.faceOffsets.push(m.faceIndices.length);
    });
    m.faceIds = [0, 1, 2, 3, 4, 5];
    m.faceSlots = [0, 0, 0, 0, 0, 0];
    m.nextFaceId = 6;
    M.bump(m);
    return m;
  }

  /* 2×2 四边网格（开口的薄片，用来测溶解 / 细分，不参与布尔） */
  function grid() {
    const m = M.create();
    const pos = [], ids = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) { ids.push(y * 3 + x); pos.push(x / 2, y / 2, 0); }
    }
    const quads = [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]];
    const idx = [];
    quads.forEach(q => q.forEach(v => idx.push(v)));
    m.positions = pos; m.vertexIds = ids; m.nextVertexId = 9;
    m.faceOffsets = [0];
    quads.forEach((q, i) => m.faceOffsets.push((i + 1) * 4));
    m.faceIndices = idx; m.faceIds = [0, 1, 2, 3]; m.faceSlots = [0, 0, 0, 0];
    m.nextFaceId = 4;
    M.bump(m);
    return m;
  }

  /* 网格体检：结构错误 / 面内重复顶点 / 孤点 / ID 冲突 */
  function audit(mesh) {
    const errs = M.validate(mesh) || [];
    const used = new Set();
    let repeated = 0, badFaces = 0;
    for (let f = 0; f < mesh.faceIds.length; f++) {
      const s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      if (e - s < 3) badFaces++;
      const seen = new Set();
      for (let k = s; k < e; k++) {
        const v = mesh.faceIndices[k];
        used.add(v);
        if (seen.has(v)) repeated++;
        seen.add(v);
      }
    }
    let orphans = 0;
    for (let v = 0; v < mesh.vertexIds.length; v++) if (!used.has(v)) orphans++;
    const dupV = mesh.vertexIds.length - new Set(mesh.vertexIds).size;
    const dupF = mesh.faceIds.length - new Set(mesh.faceIds).size;
    return { errs: errs, repeated: repeated, badFaces: badFaces, orphans: orphans, dupV: dupV, dupF: dupF };
  }
  const clean = a => a.errs.length === 0 && a.repeated === 0 && a.badFaces === 0 && a.orphans === 0 && a.dupV === 0 && a.dupF === 0;
  function faceSizes(mesh) {
    const out = [];
    for (let f = 0; f < mesh.faceIds.length; f++) out.push(mesh.faceOffsets[f + 1] - mesh.faceOffsets[f]);
    return out;
  }

  try {
    /* ---------------- 1. 阵列 ---------------------------- */
    const lin = Ops.arrayMesh(cube(0, 0, 0, 1), { mode: 'linear', count: 3, offset: [1.5, 0, 0] });
    const linAudit = audit(lin);
    check(!!lin && lin.vertexIds.length === 24 && lin.faceIds.length === 18,
      '线性阵列 count=3：顶点 / 面各乘 3', lin ? lin.vertexIds.length + 'v / ' + lin.faceIds.length + 'f' : 'null');
    check(lin && clean(linAudit) && lin.nextVertexId === 24 && lin.nextFaceId === 18,
      '线性阵列：ID 连续且无冲突，输出是合法网格', JSON.stringify(linAudit));
    check(lin && Math.abs(lin.positions[6 * 3] - 0.5) < 1e-9 && Math.abs(lin.positions[(8 + 6) * 3] - 2.0) < 1e-9,
      '线性阵列：第 2 份整体平移 offset，第 1 份 ID / 位置不变',
      lin ? 'v6x=' + lin.positions[6 * 3] + ' v6x(2nd)=' + lin.positions[(8 + 6) * 3] : '');
    check(lin && 24 - new Set(lin.vertexIds).size === 0,
      '线性阵列：每份顶点 ID 互不相同', lin ? 'unique=' + new Set(lin.vertexIds).size : '');

    const radial = Ops.arrayMesh(cube(2, 0, 0, 1), { mode: 'radial', count: 4, axis: 'y', angle: 90 });
    check(!!radial && radial.vertexIds.length === 32 && radial.faceIds.length === 24 && clean(audit(radial)),
      '圆周阵列 count=4 / 90°：顶点 8×4、面 6×4，网格合法',
      radial ? radial.vertexIds.length + 'v / ' + radial.faceIds.length + 'f' : 'null');
    /* 第 2 份（dense 8..15）的顶点 1：源 (2.5,-0.5,-0.5) 绕 y 转 90° → (-0.5,-0.5,-2.5) */
    const rad1 = radial ? [radial.positions[(8 + 1) * 3], radial.positions[(8 + 1) * 3 + 1], radial.positions[(8 + 1) * 3 + 2]] : null;
    check(rad1 && Math.abs(rad1[0] + 0.5) < 1e-9 && Math.abs(rad1[1] + 0.5) < 1e-9 && Math.abs(rad1[2] + 2.5) < 1e-9,
      '圆周阵列：第 2 份绕 y 轴真的转到了另一侧（x 2.5→-0.5，z -0.5→-2.5）',
      rad1 ? 'x=' + (+rad1[0].toFixed(4)) + ' y=' + (+rad1[1].toFixed(4)) + ' z=' + (+rad1[2].toFixed(4)) : '');

    const weld = Ops.arrayMesh(cube(0, 0, 0, 1), { mode: 'linear', count: 2, offset: [1, 0, 0], merge: true });
    check(!!weld && weld.vertexIds.length === 12 && weld.vertexIds.length === new Set(weld.vertexIds).size,
      '线性阵列 merge=true：贴合面上 4 个重合顶点被焊成一份（8+8→12）',
      weld ? weld.vertexIds.length + 'v' : 'null');

    /* ---------------- 2. 溶解 ---------------------------- */
    const g = grid();
    const gBefore = { v: g.vertexIds.length, f: g.faceIds.length };
    const faceDis = Ops.dissolve(g, { kind: 'face', ids: [0, 1] });
    const fdAudit = faceDis ? audit(faceDis) : null;
    check(!!faceDis && faceDis.faceIds.length === 3 && clean(fdAudit) && g.faceIds.length === gBefore.f,
      '面溶解：相邻 2 张四边面并成 1 张多边形（4→3 面），原网格不被原地改',
      faceDis ? JSON.stringify({ f: faceDis.faceIds.length, sizes: faceSizes(faceDis) }) : 'null');
    check(faceDis && faceSizes(faceDis).indexOf(6) >= 0,
      '面溶解：结果是 6 边多边形，不是三角化一堆小面',
      faceDis ? 'sizes=' + faceSizes(faceDis).join(',') : '');

    const cEdge = cube(0, 0, 0, 1);
    const edgeDis = Ops.dissolve(cEdge, { kind: 'edge', ids: [M.EDGE_STRIDE * 0 + 1] });
    const edAudit = edgeDis ? audit(edgeDis) : null;
    check(!!edgeDis && edgeDis.faceIds.length === 5 && clean(edAudit) && faceSizes(edgeDis).indexOf(6) >= 0,
      '边溶解：共用该边的 2 张四边面并成 1 张六边面（6→5 面）',
      edgeDis ? JSON.stringify({ f: edgeDis.faceIds.length, sizes: faceSizes(edgeDis) }) : 'null');

    const cVert = cube(0, 0, 0, 1);
    const vertDis = Ops.dissolve(cVert, { kind: 'vertex', ids: [0] });
    const vdAudit = vertDis ? audit(vertDis) : null;
    check(!!vertDis && vertDis.faceIds.length === 4 && vertDis.vertexIds.length === 7 &&
      clean(vdAudit) && vertDis.vertexIds.indexOf(0) < 0,
      '点溶解：立方体一角 3 张面并成 1 张，被删的点作为孤点清零（8→7 点 / 6→4 面）',
      vertDis ? JSON.stringify({ v: vertDis.vertexIds.length, f: vertDis.faceIds.length }) : 'null');
    check(vertDis && faceSizes(vertDis).indexOf(6) >= 0,
      '点溶解：并出来的面是六边形（保持多边形）',
      vertDis ? 'sizes=' + faceSizes(vertDis).join(',') : '');

    /* 边界顶点（开口网格上只有 2 张面）必须明确拒绝，不能把边也一起吃掉 */
    const g2 = grid();
    const boundaryV = Ops.dissolve(g2, { kind: 'vertex', ids: [0] });
    check(boundaryV === null, '点溶解：网格边界顶点（非闭合扇形）明确拒绝', 'result=' + boundaryV);

    /* ---------------- 3. 细分一遍 ---------------------------- */
    const sub = Ops.subdivideOnce(cube(0, 0, 0, 1), { simple: true });
    const subAudit = sub ? audit(sub) : null;
    check(!!sub && sub.faceIds.length === 24 && sub.vertexIds.length === 26 && clean(subAudit),
      '细分一遍：立方体 6 面 → 24 面（每四边面 ×4），顶点 8+12 边中点+6 面中心 = 26，网格合法',
      sub ? JSON.stringify({ v: sub.vertexIds.length, f: sub.faceIds.length }) : 'null');
    check(sub && faceSizes(sub).every(n => n === 4),
      '细分一遍：四边面切出来的 24 张全是四边面', sub ? 'sizes=' + [...new Set(faceSizes(sub))].join(',') : '');
    check(sub && sub.positions[0] === -0.5 && sub.positions[1] === -0.5 && sub.positions[2] === -0.5 &&
      sub.faceIds.length === new Set(sub.faceIds).size,
      '细分一遍：原顶点位置不动、面 ID 不冲突（simple 拓扑细分）', '');

    const tri1 = M.create();
    tri1.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    tri1.vertexIds = [0, 1, 2]; tri1.nextVertexId = 3;
    tri1.faceOffsets = [0, 3]; tri1.faceIndices = [0, 1, 2];
    tri1.faceIds = [0]; tri1.faceSlots = [0]; tri1.nextFaceId = 1;
    M.bump(tri1);
    const triSub = Ops.subdivideOnce(tri1);
    check(!!triSub && triSub.faceIds.length === 4 && triSub.vertexIds.length === 6 &&
      faceSizes(triSub).every(n => n === 3) && clean(audit(triSub)),
      '细分一遍：三角面 → 4 张三角面（1-to-4），共 6 个顶点',
      triSub ? JSON.stringify({ v: triSub.vertexIds.length, f: triSub.faceIds.length, sizes: faceSizes(triSub) }) : 'null');

    const gSub = Ops.subdivideOnce(grid());
    check(!!gSub && gSub.faceIds.length === 16 && gSub.vertexIds.length === 25 && clean(audit(gSub)),
      '细分一遍：2×2 四边网格 → 16 面；共享边中点只建一次（9+12+4=25 点，无 T 形缝）',
      gSub ? JSON.stringify({ v: gSub.vertexIds.length, f: gSub.faceIds.length }) : 'null');

    /* ---------------- 4. 布尔 ---------------------------- */
    const A = cube(0, 0, 0, 1);
    const B = cube(0.4, 0.3, 0.2, 1);
    const uni = Ops.booleanMeshes(A, B, 'union');
    const inter = Ops.booleanMeshes(A, B, 'intersect');
    const subtr = Ops.booleanMeshes(A, B, 'subtract');
    const bStats = {
      union: uni ? { f: uni.faceIds.length, t: M.triangleCount(uni) } : null,
      intersect: inter ? { f: inter.faceIds.length, t: M.triangleCount(inter) } : null,
      subtract: subtr ? { f: subtr.faceIds.length, t: M.triangleCount(subtr) } : null,
      err: Ops.lastOpError
    };
    info('布尔结果', JSON.stringify(bStats));
    check(!!uni && !!inter && !!subtr, 'union / intersect / subtract 都能算（同一套 BSP）', Ops.lastOpError || 'ok');
    check(uni && inter && M.triangleCount(uni) >= M.triangleCount(inter) && M.triangleCount(inter) > 0,
      'union / intersect 面数单调合理：交集体非空且并集体不小于交集体', JSON.stringify(bStats));
    check(uni && subtr && M.triangleCount(uni) >= 12 && M.triangleCount(subtr) >= 12,
      '布尔结果保留了完整的外壳（三角数不少于单个立方体）', '');
    check(uni && clean(audit(uni)), 'union 输出结构合法（无非法面 / 无重复 ID）', JSON.stringify(uni ? audit(uni) : null));

    /* 近共面：只沿 x 错开 0.25，上下前后 4 对平面完全共面且重叠 */
    const near = Ops.booleanMeshes(cube(0, 0, 0, 1), cube(0.25, 0, 0, 1), 'union');
    check(near === null && /共面/.test(Ops.lastOpError),
      '布尔：近共面重叠输入返回明确失败原因', near === null ? Ops.lastOpError : 'result!=null');

    /* 非封闭：删掉立方体一张面 */
    const openMesh = Ops.deleteFaces(cube(0, 0, 0, 1), { faceIds: [1] });
    const openRes = Ops.booleanMeshes(openMesh, cube(2, 0, 0, 1), 'union');
    check(openRes === null && /封闭/.test(Ops.lastOpError),
      '布尔：非封闭输入返回明确失败原因', openRes === null ? Ops.lastOpError : 'result!=null');

    /* 自交：同一份网格里塞两个互相穿插的立方体（各自闭合，但表面相交） */
    const selfX = Ops.arrayMesh(cube(0, 0, 0, 1), { mode: 'linear', count: 2, offset: [0.3, 0.25, 0.1] });
    const selfRes = Ops.booleanMeshes(selfX, cube(5, 0, 0, 1), 'union');
    check(selfRes === null && /自交/.test(Ops.lastOpError),
      '布尔：自交输入返回明确失败原因', selfRes === null ? Ops.lastOpError : 'result!=null');

    /* 成功路径必须把上一次的失败原因清掉，否则外壳会一直显示旧提示 */
    const okAgain = Ops.booleanMeshes(cube(0, 0, 0, 1), cube(0.4, 0.3, 0.2, 1), 'union');
    check(!!okAgain && Ops.lastOpError === '',
      '布尔：成功后 lastOpError 清空（外壳不会残留旧失败提示）', '"' + Ops.lastOpError + '"');

    /* ---------------- 5. 按面拆出独立网格（UV 岛拆分） ----------------
     * 用 2×2 四边网格：给每张面标不同材质槽 + 一份面角 UV，验证拆分后
     * 面 ID / 材质槽 / UV 都跟着面走，两块各自合法、不共享顶点下标。 */
    const gv = grid();
    gv.faceSlots = [0, 1, 0, 1];
    gv.uvs = [];
    for (let f = 0; f < gv.faceIds.length; f++) {
      const s = gv.faceOffsets[f], e = gv.faceOffsets[f + 1];
      for (let k = s; k < e; k++) {
        const vi = gv.faceIndices[k];
        gv.uvs.push((vi % 3) / 2, Math.floor(vi / 3) / 2);
      }
    }
    M.bump(gv);
    const gvFaceCount = gv.faceIds.length, gvVertCount = gv.vertexIds.length;

    const split = Ops.extractFaces(gv, [1, 3]);
    check(!!split && !!split.part && !!split.keep, '按面拆分：选中 2 张面返回 { part, keep }', split ? '' : 'null');
    if (split) {
      const pa = audit(split.part), ka = audit(split.keep);
      check(split.part.faceIds.length === 2 && split.keep.faceIds.length === 2 && clean(pa) && clean(ka),
        '按面拆分：两块各 2 面、各自合法（无孤点 / 无重复 ID）', JSON.stringify({ part: pa, keep: ka }));
      check(split.part.faceIds.join(',') === '1,3' && split.keep.faceIds.join(',') === '0,2',
        '按面拆分：面 ID 原样保留并各自归位',
        split.part.faceIds.join(',') + ' | ' + split.keep.faceIds.join(','));
      check(split.part.faceSlots.join(',') === '1,1' && split.keep.faceSlots.join(',') === '0,0',
        '按面拆分：材质槽跟着面走（不是一律归 0）',
        split.part.faceSlots.join(',') + ' | ' + split.keep.faceSlots.join(','));
      check(split.part.uvs.length === split.part.faceIndices.length * 2 &&
        Math.abs(split.part.uvs[0] - 0.5) < 1e-9 && Math.abs(split.part.uvs[1] - 0) < 1e-9,
        '按面拆分：UV 按面角继承（面 1 首角顶点 1 → 0.5,0）', split.part.uvs.slice(0, 4).join(','));
      /* 面 1=[1,2,5,4] + 面 3=[4,5,8,7] → 6 顶点；keep 面 0/2 → 6 顶点；
       * 原网格 9 顶点，共享的 1/4/7 各留一份（9+3=12）。 */
      check(split.part.positions.length / 3 === 6 && split.keep.positions.length / 3 === 6 &&
        split.part.vertexIds.length === 6 && split.keep.vertexIds.length === 6,
        '按面拆分：两块各自紧凑重排，共享顶点各留一份（6+6=原 9 + 共享 3）',
        (split.part.vertexIds.length) + '+' + (split.keep.vertexIds.length) + ' / 原 ' + gvVertCount);
      check(gv.faceIds.length === gvFaceCount && gv.vertexIds.length === gvVertCount,
        '按面拆分：原网格不被原地改', gv.faceIds.length + 'f / ' + gv.vertexIds.length + 'v');
    }
    check(Ops.extractFaces(gv, [0, 1, 2, 3]) === null, '按面拆分：全选时拒绝（原网格会变空）', '');
    check(Ops.extractFaces(gv, []) === null, '按面拆分：空选择拒绝', '');
    check(Ops.extractFaces(gv, [99]) === null, '按面拆分：不存在的面 ID 拒绝', '');
  } catch (e) {
    errors.push('算子执行异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  }

  check(errors.length === 0, '加载与全部算子执行期间无异常（等价 pageerror=0）', errors.slice(0, 3).join(' | '));

  console.log(fails ? '\n❌ 失败 ' + fails + ' 项' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})();
