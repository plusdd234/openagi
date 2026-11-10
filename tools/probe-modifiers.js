/* 探针：修改器栈 + 求值器（数据层，不依赖 UI）
 * 用法：node tools/probe-modifiers.js
 *
 * 为什么在页面里跑：网格内核 / 场景文档都是浏览器全局模块，求值器又依赖
 * Scene.getMesh 的对象缓存语义（必须拿到同一份 base），只有真加载 index.html 才测得准。
 * index.html 没引入 seed-modifiers.js（不允许改它），所以探针自己 addScriptTag 注入。
 *
 * 断言口径：
 *   - 无修改器 → evaluate 返回的必须就是 Scene.getMesh 的那个对象；
 *   - subdivision 1/2 级面数、顶点数符合 Catmull-Clark 的拓扑公式，vertexId 两次求值一致；
 *   - mirror 后每个面的法线都朝外，镜面上的点已焊成一个；
 *   - solidify 外壳体积为正、内壳为负（法线朝里），封闭网格面数正好翻倍；
 *   - 缓存命中返回同一引用，改参数 / revision.modifiers 会失效。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const info = (name, extra) => console.log(' ·· ' + name + (extra ? ' · ' + extra : ''));

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const bundled = await page.evaluate(() => typeof window.SeedModifiers !== 'undefined');
  if (!bundled) await page.addScriptTag({ path: path.join(root, 'js', 'seed-modifiers.js') });
  const ready = await page.evaluate(() => !!(window.SeedModel && SeedModel.Mesh && SeedModel.Evaluator && SeedModel.Scene && window.SeedModifiers));
  check(ready, '网格内核 / 场景 / 求值器 / 修改器都已就绪', bundled ? 'index.html 自带' : '探针注入 seed-modifiers.js');
  if (!ready) {
    await browser.close();
    process.exit(1);
  }

  /* 页面内小工具：造盒子、造文档、取面法线、算有符号体积 */
  await page.evaluate(() => {
    window.__pm = {
      box(w, h, d, dx) {
        const g = new THREE.BoxGeometry(w, h, d);
        if (dx) g.translate(dx, 0, 0);
        const m = SeedModel.Mesh.fromBufferGeometry(g);
        g.dispose();
        return m;
      },
      plane(w, h) {
        const g = new THREE.PlaneGeometry(w, h);
        const m = SeedModel.Mesh.fromBufferGeometry(g);
        g.dispose();
        return m;
      },
      /* 去掉完全落在镜面上的封口面：镜像的标准用法是「开放半边」，
       * 带封口面会得到两层贴合的内壁（法线方向相反，属于预期的内部结构） */
      dropPlaneFaces(mesh, axis, eps) {
        const out = SeedModel.Mesh.create();
        for (let i = 0; i < mesh.positions.length; i++) out.positions.push(mesh.positions[i]);
        for (let i = 0; i < mesh.vertexIds.length; i++) out.vertexIds.push(mesh.vertexIds[i]);
        const hasUV = SeedModel.Mesh.hasUV(mesh);
        for (let f = 0; f < mesh.faceIds.length; f++) {
          const s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
          let onPlane = true;
          for (let k = s; k < e; k++) {
            const v = mesh.faceIndices[k] * 3 + axis;
            if (Math.abs(mesh.positions[v]) > eps) { onPlane = false; break; }
          }
          if (onPlane) continue;
          for (let k = s; k < e; k++) out.faceIndices.push(mesh.faceIndices[k]);
          out.faceOffsets.push(out.faceIndices.length);
          out.faceIds.push(mesh.faceIds[f]);
          out.faceSlots.push(mesh.faceSlots[f]);
          if (hasUV) for (let k = s; k < e; k++) out.uvs.push(mesh.uvs[k * 2], mesh.uvs[k * 2 + 1]);
        }
        out.nextVertexId = mesh.nextVertexId;
        out.nextFaceId = mesh.nextFaceId;
        SeedModel.Mesh.bump(out);
        return out;
      },
      doc(mesh) {
        return SeedModel.Scene.createDoc({ mesh: mesh, revision: { current: 1, mesh: 1, modifiers: 0 } });
      },
      faces(mesh) {
        const P = mesh.positions, out = [];
        for (let f = 0; f < mesh.faceIds.length; f++) {
          const s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1], n = e - s;
          let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
          for (let k = 0; k < n; k++) {
            const ia = mesh.faceIndices[s + k] * 3;
            const ib = mesh.faceIndices[s + ((k + 1) % n)] * 3;
            const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
            const bx = P[ib], by = P[ib + 1], bz = P[ib + 2];
            nx += (ay - by) * (az + bz);
            ny += (az - bz) * (ax + bx);
            nz += (ax - bx) * (ay + by);
            cx += P[ia]; cy += P[ia + 1]; cz += P[ia + 2];
          }
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          out.push({
            n: [nx / len, ny / len, nz / len],
            c: [cx / n, cy / n, cz / n],
            corners: n
          });
        }
        return out;
      },
      /* 有符号体积：向外绕序为正；用来验「内壳法线朝里」 */
      volume(mesh, f0, f1) {
        const P = mesh.positions;
        let vol = 0;
        const from = f0 == null ? 0 : f0;
        const to = f1 == null ? mesh.faceIds.length : f1;
        for (let f = from; f < to; f++) {
          const s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
          const i0 = mesh.faceIndices[s];
          for (let k = 1; k < e - s - 1; k++) {
            const i1 = mesh.faceIndices[s + k], i2 = mesh.faceIndices[s + k + 1];
            const ax = P[i0 * 3], ay = P[i0 * 3 + 1], az = P[i0 * 3 + 2];
            const bx = P[i1 * 3], by = P[i1 * 3 + 1], bz = P[i1 * 3 + 2];
            const cx = P[i2 * 3], cy = P[i2 * 3 + 1], cz = P[i2 * 3 + 2];
            vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
          }
        }
        return vol;
      },
      uniqueIds(mesh) {
        const seen = Object.create(null);
        let dup = 0;
        for (const id of mesh.vertexIds) { if (seen[id]) dup++; else seen[id] = 1; }
        return { total: mesh.vertexIds.length, unique: Object.keys(seen).length, dup };
      },
      dupPositions(mesh, eps) {
        const q = eps || 1e5, seen = Object.create(null);
        let dup = 0;
        for (let i = 0; i < mesh.positions.length / 3; i++) {
          const k = Math.round(mesh.positions[i * 3] * q) + ',' +
            Math.round(mesh.positions[i * 3 + 1] * q) + ',' +
            Math.round(mesh.positions[i * 3 + 2] * q);
          if (seen[k]) dup++; else seen[k] = 1;
        }
        return dup;
      }
    };
  });

  /* ---------------- 1. 无修改器 = 同一份 base ---------------- */
  const a = await page.evaluate(() => {
    const m = __pm.box(1, 1, 1);
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);
    const got1 = SeedModel.Evaluator.evaluate(doc, node);
    const got2 = SeedModel.Evaluator.evaluate(doc, node);
    const base = SeedModel.Scene.getMesh(doc, node);
    return {
      same1: got1 === base,
      same2: got2 === base,
      faces: m.faceIds.length,
      verts: m.vertexIds.length,
      version: m.version
    };
  });
  check(a.same1 && a.same2, '无修改器：evaluate 直接返回 Scene.getMesh 的同一对象',
    'refs=' + (a.same1 ? '1' : '0') + '/' + (a.same2 ? '1' : '0') + ' v=' + a.version);
  check(a.faces === 6 && a.verts === 8, '测试盒子是 6 面 / 8 点（三角已合回四边形）',
    a.faces + ' 面 / ' + a.verts + ' 点');

  /* ---------------- 2. subdivision：拓扑与 ID 稳定性 ---------------- */
  const b = await page.evaluate(() => {
    const m = __pm.box(1, 1, 1);
    const hash0 = SeedModel.Mesh.hash(m);
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);

    node.modifiers = [{ type: 'subdivision', level: 1 }];
    doc.revision.modifiers = 1;
    const l1 = SeedModel.Evaluator.evaluate(doc, node);
    const ids1 = l1.vertexIds.slice();

    node.modifiers[0].level = 2;
    doc.revision.modifiers = 2;
    const l2 = SeedModel.Evaluator.evaluate(doc, node);

    node.modifiers[0].level = 3;
    doc.revision.modifiers = 3;
    const l3 = SeedModel.Evaluator.evaluate(doc, node);

    /* 同一份 base、新文档再求一次 level1：ID 应逐位相同（不依赖缓存） */
    node.modifiers[0].level = 1;
    doc.revision.modifiers = 1;
    const doc2 = __pm.doc(m);
    const node2 = SeedModel.Scene.nodeOf(doc2);
    node2.modifiers = [{ type: 'subdivision', level: 1 }];
    doc2.revision.modifiers = 1;
    const l1b = SeedModel.Evaluator.evaluate(doc2, node2);

    SeedModel.Evaluator.invalidate(node.id);
    const l1c = SeedModel.Evaluator.evaluate(doc, node);

    const q1 = __pm.faces(l1);
    return {
      baseHashSame: hash0 === SeedModel.Mesh.hash(m),
      baseFaces: m.faceIds.length,
      f1: l1.faceIds.length, v1: l1.vertexIds.length,
      f2: l2.faceIds.length, v2: l2.vertexIds.length,
      f3: l3.faceIds.length, v3: l3.vertexIds.length,
      allQuads: q1.every(x => x.corners === 4),
      prefixOk: ids1.slice(0, m.vertexIds.length).every((id, i) => id === m.vertexIds[i]),
      stable: ids1.join(',') === l1b.vertexIds.join(',') && ids1.join(',') === l1c.vertexIds.join(','),
      ids1: __pm.uniqueIds(l1),
      ids2: __pm.uniqueIds(l2),
      prefix: ids1.slice(0, 8).join(',')
    };
  });
  check(b.baseHashSame, 'subdivision 没改 base 网格（指纹不变）', 'base 仍 ' + b.baseFaces + ' 面');
  check(b.f1 === 24 && b.v1 === 26, 'subdivision L1：6 面 → 24 面 / 26 点（V+E+F）',
    b.f1 + ' 面 / ' + b.v1 + ' 点');
  check(b.f2 === 96 && b.v2 === 98, 'subdivision L2：24 面 → 96 面 / 98 点', b.f2 + ' 面 / ' + b.v2 + ' 点');
  info('subdivision L3', b.f3 + ' 面 / ' + b.v3 + ' 点');
  check(b.allQuads, 'subdivision L1 全部输出四边形', '');
  check(b.prefixOk, '原顶点沿用旧 vertexId（选择集不会失效）', '前缀=' + b.prefix);
  check(b.stable, 'subdivision 两次独立求值的 vertexId 逐位一致', '');
  check(b.ids1.unique === b.ids1.total && b.ids2.unique === b.ids2.total,
    'subdivision 输出 vertexId 无重复', 'L1 ' + b.ids1.total + ' / L2 ' + b.ids2.total);

  /* ---------------- 3. mirror：法线朝向 + 缝上焊接 ---------------- */
  const c = await page.evaluate(() => {
    /* 标准用法：半盒去掉贴合镜面的封口面，只留开放半边 */
    const m = __pm.dropPlaneFaces(__pm.box(1, 2, 2, 0.5), 0, 1e-6);   // x 0..1，y/z ±1，无 x=0 封口
    const hash0 = SeedModel.Mesh.hash(m);
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);
    node.modifiers = [{ type: 'mirror', axis: 'x', merge: 0.001 }];
    doc.revision.modifiers = 1;
    const e = SeedModel.Evaluator.evaluate(doc, node);

    const infos = __pm.faces(e);
    let minDot = Infinity;
    for (const f of infos) {
      const d = f.n[0] * f.c[0] + f.n[1] * f.c[1] + f.n[2] * f.c[2];
      if (d < minDot) minDot = d;
    }
    let seam = 0;
    for (let i = 0; i < e.positions.length / 3; i++) {
      if (Math.abs(e.positions[i * 3]) <= 1e-6) seam++;
    }
    return {
      baseHashSame: hash0 === SeedModel.Mesh.hash(m),
      baseVerts: m.vertexIds.length,
      baseFaces: m.faceIds.length,
      verts: e.vertexIds.length,
      faces: e.faceIds.length,
      minDot: +minDot.toFixed(4),
      seam: seam,
      dup: __pm.dupPositions(e),
      ids: __pm.uniqueIds(e)
    };
  });
  check(c.baseHashSame, 'mirror 没改 base 网格', '');
  check(c.baseFaces === 5 && c.baseVerts === 8, '开放半边是 5 面 / 8 点', c.baseFaces + ' 面');
  check(c.faces === 10, 'mirror：开放半边 5 面 → 完整盒 10 面', c.faces + ' 面');
  check(c.verts === 12 && c.baseVerts === 8, 'mirror：8 点 → 12 点（缝上 4 点复用）',
    c.verts + ' 点（base ' + c.baseVerts + '）');
  check(c.minDot > 0, 'mirror 后所有面法线朝外（绕序已翻）', 'min(法线·质心)=' + c.minDot);
  check(c.seam === 4, '镜面上的点是焊好的（x≈0 只有 4 个）', 'seam=' + c.seam);
  check(c.dup === 0 && c.ids.unique === c.ids.total, 'mirror 输出没有重合顶点 / 重复 ID',
    'dupPos=' + c.dup + ' dupId=' + c.ids.dup);

  /* ---------------- 4. solidify：双壳面数 + 体积方向 ---------------- */
  const d = await page.evaluate(() => {
    const m = __pm.box(1, 1, 1);
    const hash0 = SeedModel.Mesh.hash(m);
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);
    node.modifiers = [{ type: 'solidify', thickness: 0.2, offset: -1 }];
    doc.revision.modifiers = 1;
    const e = SeedModel.Evaluator.evaluate(doc, node);

    const baseFaces = m.faceIds.length;
    const outer = __pm.volume(e, 0, baseFaces);
    const inner = __pm.volume(e, baseFaces, baseFaces * 2);
    const total = __pm.volume(e);

    /* 内壳面的法线应指向模型中心（与质心方向相反） */
    const infos = __pm.faces(e).slice(baseFaces, baseFaces * 2);
    let maxInnerDot = -Infinity;
    for (const f of infos) {
      const dot = f.n[0] * f.c[0] + f.n[1] * f.c[1] + f.n[2] * f.c[2];
      if (dot > maxInnerDot) maxInnerDot = dot;
    }
    return {
      baseHashSame: hash0 === SeedModel.Mesh.hash(m),
      bases: baseFaces,
      faces: e.faceIds.length,
      verts: e.vertexIds.length,
      outer: +outer.toFixed(4),
      inner: +inner.toFixed(4),
      total: +total.toFixed(4),
      maxInnerDot: +maxInnerDot.toFixed(4)
    };
  });
  check(d.baseHashSame, 'solidify 没改 base 网格', '');
  check(d.faces === d.bases * 2 && d.verts === 16, 'solidify 封闭网格：面数翻倍、内外壳各一套点',
    d.faces + ' 面 / ' + d.verts + ' 点');
  check(d.outer > 0.9 && d.outer < 1.1, '外壳朝向正确（体积为正，≈ 原体积 1）', 'outer=' + d.outer);
  check(d.inner < 0, '内壳绕序已翻（体积为负 = 法线朝里）', 'inner=' + d.inner);
  check(d.total > 0 && d.total < d.outer, '总的有符号体积为正且小于外壳（内壳已扣掉）', 'total=' + d.total);
  check(d.maxInnerDot < 0, '内壳每个面的法线都指向内侧', 'max(法线·质心)=' + d.maxInnerDot);

  /* ---------------- 5. solidify 侧壁（开放平面） ---------------- */
  const e = await page.evaluate(() => {
    const m = __pm.plane(1, 1);
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);
    node.modifiers = [{ type: 'solidify', thickness: 0.1, offset: -1 }];
    doc.revision.modifiers = 1;
    const out = SeedModel.Evaluator.evaluate(doc, node);
    return {
      baseFaces: m.faceIds.length,
      baseVerts: m.vertexIds.length,
      faces: out.faceIds.length,
      verts: out.vertexIds.length,
      vol: +__pm.volume(out).toFixed(4)
    };
  });
  check(e.baseFaces === 1 && e.baseVerts === 4, '开放平面为 1 面 / 4 点', e.baseFaces + ' 面');
  check(e.faces === e.baseFaces * 2 + 4 && e.verts === 8,
    'solidify 开放网格：外壳 + 内壳 + 4 条边界侧壁', e.faces + ' 面 / ' + e.verts + ' 点');
  check(e.vol > 0, '侧壁把开放网格封成了正体积', 'vol=' + e.vol);

  /* ---------------- 6. 缓存：同引用、参数 / revision 失效 ---------------- */
  const f = await page.evaluate(() => {
    const m = __pm.box(1, 1, 1);
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);
    node.modifiers = [{ type: 'subdivision', level: 1 }];
    doc.revision.modifiers = 1;

    const a1 = SeedModel.Evaluator.evaluate(doc, node);
    const a2 = SeedModel.Evaluator.evaluate(doc, node);
    const hit = a1 === a2;

    /* 只改参数、不动 revision：键里带了参数，必须失效 */
    node.modifiers[0].level = 2;
    const b1 = SeedModel.Evaluator.evaluate(doc, node);

    /* 参数改回、只推 revision.modifiers：也必须失效 */
    node.modifiers[0].level = 1;
    doc.revision.modifiers = 2;
    const c1 = SeedModel.Evaluator.evaluate(doc, node);

    /* 缓存被命中后返回的是同一对象；invalidate 之后必须是新对象 */
    const c2 = SeedModel.Evaluator.evaluate(doc, node);
    SeedModel.Evaluator.invalidate(node.id);
    const c3 = SeedModel.Evaluator.evaluate(doc, node);

    return {
      hit: hit,
      paramChanged: b1 !== a1 && b1.faceIds.length === 96,
      revChanged: c1 !== b1 && c1.faceIds.length === 24,
      hitAfterRev: c2 === c1,
      invalidated: c3 !== c2 && c3.faceIds.length === 24
    };
  });
  check(f.hit, '缓存命中：同一参数返回同一对象引用', '');
  check(f.paramChanged, '改修改器参数会让缓存失效（96 面）', '');
  check(f.revChanged, '只改 revision.modifiers 也会失效（重新算 24 面）', '');
  check(f.hitAfterRev && f.invalidated, 'invalidate(nodeId) 之后重新求值得到新对象', '');

  /* ---------------- 7. 栈顺序 / 无 pageerror ---------------- */
  const g = await page.evaluate(() => {
    const m = __pm.box(2, 1, 1, 0.5);   // x 0..1
    const doc = __pm.doc(m);
    const node = SeedModel.Scene.nodeOf(doc);
    node.modifiers = [
      { type: 'mirror', axis: 'x', merge: 0.001 },
      { type: 'subdivision', level: 1 }
    ];
    doc.revision.modifiers = 1;
    const out = SeedModel.Evaluator.evaluate(doc, node);
    return {
      faces: out.faceIds.length,
      /* 镜像后完整盒 12 面，再细分一次 → 12 × 4 = 48 面 */
      ok: out.faceIds.length === 48,
      applied: SeedModel.Evaluator.evaluate(doc, node) === out
    };
  });
  check(g.ok && g.applied, '修改器按栈顺序叠加（mirror → subdivision = 48 面）',
    g.faces + ' 面');

  check(errors.length === 0, '无 pageerror', errors.join(' | '));

  await browser.close();
  console.log(fails ? '\n❌ ' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('探针异常：', e);
  process.exit(1);
});
