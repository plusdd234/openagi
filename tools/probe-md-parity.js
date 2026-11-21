'use strict';
/* 探针：头模的顶点链路与流明 app **逐值对齐**
 * 用法：node tools/probe-md-parity.js
 *
 * 判断标准（不靠截图）：同一份 position / uv / 蒙皮权重 + 同一套骨骼 + 同一对
 * bindMatrix / boneInverse，那最终渲染顶点就必然逐顶点相同 —— 效果也就必然相同。
 * 所以第 ⑨ 条是**决定性的**：在页面里用清单原始 buffer 独立重算一遍流明的蒙皮，
 * 同一个骨骼姿态下逐顶点比位移向量。前面 ①~⑧ 都是它的分解与定位手段。
 *
 * 流明那边（apps/lumen3d/app.js:739 起）的做法是：
 *   geometry  attribute(desc)             ← 直接读 buffer，不加工
 *   model.scale.z = -1                    ← 只镜像父级，局部变换一个都不改
 *   mesh.bind(skeleton, 单位 bindMatrix)
 *   boneInverse = 清单 inverseBind（转置）
 * ⇒ boneWorld·boneInverse = (F·W_pose)·W_rest⁻¹，其中 F = diag(1,1,-1)
 * 我们这边多了一步「把物体摆到原点」的中心平移 T(-c)，其余照抄。于是可以证明
 * 两边逐顶点位移**恒等**（见 ⑨ 推导注释）。
 *
 * 验九件事：
 *   ① position 与清单 buffer 逐索引相同（差一个常量 center 平移）
 *   ② uv 逐索引相同（uv 一变，贴图上那双眼睛就移位）
 *   ③ skinIndex / skinWeight 逐值相同
 *   ④ 骨骼树与清单 nodes 逐值相同（name / parent / 局部变换 / root 空间世界矩阵）
 *   ⑤ 清单 inverseBind 自洽：== inverse(按清单 nodes 算出的 rest 世界矩阵，**未镜像**)
 *   ⑥ App 的 boneInverse 与清单的差异**完全**由「镜像 F + 中心平移 T(c) + 物体摆位 P」解释
 *   ⑦ rest 姿态下 CPU 蒙皮结果 == position（严格还原）
 *   ⑧ 同一个骨骼局部旋转下，蒙皮位移场是「绕眼球自转」
 *   ⑨ 同姿态下逐顶点位移向量 == 流明实现（决定性判据）
 *
 * ⚠ 口径上的坑（早先都踩过，报出来全是假红）：
 *   · `skeleton.bones` 的顺序是**关节表**（skin.bones[jointSlot] = 节点下标）的顺序，
 *     不是节点表顺序 —— 直接 nodes[i] 对 bones[i] 会错位，报一堆 0.19 的假差异。
 *   · 清单 inverseBind 存的是**未镜像**手性（脸朝 −Z）的逆；镜像由父级承担，
 *     拿镜像后的 rest 逆去比差 2.0 —— 那是 1 vs −1，不是数值误差。
 *   · `sk.root.matrixWorld` / `bone.matrixWorld` 是缓存，读之前必须 updateWorldMatrix。
 *   · 资产顶点在 y≈1.13–1.34（整颗头悬在 1.23m 高处），桥把它平移到包围盒中心，
 *     所以 position 天然差一个常量 center；这不影响形变。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-parity');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(700);
  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1800);

  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* =====================================================================
   * ①~⑥：我们拿到的东西 vs 清单 buffer
   * ===================================================================== */
  const raw = await page.evaluate(async (id) => {
    const THREE = window.THREE;
    const def = window.MDComponents.get('lumen-head');
    await def.load();
    const meta = window.LUMEN3D_META;
    const obj = window.modelDesk.nodeObject(id);
    const g = obj.geometry;
    const skin = def.skin();

    /* 直接从 base64 buffer 读清单原始值（不经过任何组件代码） */
    const bin = atob(window.LUMEN3D_GEOMETRY);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = bytes.buffer;
    const readF32 = (desc) => Array.from(new Float32Array(buf, desc.offset, desc.count));

    const mesh = (meta.avatar.meshes || []).find((m) => m.morphs && m.morphs.length);
    const posRaw = readF32(mesh.position);
    const uvRaw = readF32(mesh.uv);
    const siRaw = readF32(mesh.skinIndex);
    const swRaw = readF32(mesh.skinWeight);
    const nRaw = posRaw.length / 3;

    const posOurs = g.attributes.position.array;
    const uvOurs = g.attributes.uv.array;
    const siOurs = g.attributes.skinIndex.array;
    const swOurs = g.attributes.skinWeight.array;
    const nOurs = g.attributes.position.count;

    const c = skin.center || [0, 0, 0];

    /* 顶点编号在两边是**两套**：组件按资产序给，render 顶点被 buildGeometry 按
     * (顶点, UV) 拆过、顺序也换成面遍历序。唯一的对应表是 geo.userData.mdOrig
     * （渲染顶点 → 资产顶点），形态键位移就是靠它重排的 —— 所以三条属性都按它比。
     * 早先按索引直接比，报出「position 差 10456 处、uv 差 6986 处」的假红，
     * 而 skinIndex「0 处差异」才是真问题（权重根本没重排）。 */
    const orig = g.userData && g.userData.mdOrig;
    let posMax = 0, posBad = 0, uvMax = 0, uvBad = 0, siBad = 0, swBad = 0;
    if (orig && orig.length === nOurs) {
      for (let r = 0; r < nOurs; r++) {
        const j = orig[r];
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(posOurs[r * 3 + k] - (posRaw[j * 3 + k] - c[k]));
          if (d > 1e-6) posBad++;
          if (d > posMax) posMax = d;
        }
        for (let k = 0; k < 2; k++) {
          const d = Math.abs(uvOurs[r * 2 + k] - uvRaw[j * 2 + k]);
          if (d > 0) uvBad++;
          if (d > uvMax) uvMax = d;
        }
        for (let k = 0; k < 4; k++) {
          if (siOurs[r * 4 + k] !== siRaw[j * 4 + k]) siBad++;
          if (swOurs[r * 4 + k] !== swRaw[j * 4 + k]) swBad++;
        }
      }
    } else {
      posBad = uvBad = siBad = swBad = -1;
    }
    const hasOrig = !!(orig && orig.length === nOurs);

    /* ④ 骨骼树。按关节表把每个 Bone 映回清单节点下标再比。
     * 0..3（LumenFaceReference / Hips / Spine / Chest）不是关节，组件只把
     * skin.bones 里那 7 个下发成 Bone —— 它们不该出现在 skeleton 里，也不算差异。 */
    obj.updateWorldMatrix(true, true);
    const sk = obj.userData.mdSkin;
    /* ⚠ 先把眼球摆回 rest：视线默认开着，`applyLook` 已经改写了两只眼关节的四元数，
     *   直接比会报 LeftEye/RightEye 差 0.106 —— 那是活的凝视角，不是数据错。 */
    if (sk.left && sk.right) {
      sk.left.quaternion.copy(sk.restL);
      sk.right.quaternion.copy(sk.restR);
      sk.root.updateMatrixWorld(true);
    }
    const boneList = sk.skeleton.bones;
    const nodeToSlot = Object.create(null);
    skin.bones.forEach((nodeIdx, slot) => { nodeToSlot[nodeIdx] = slot; });

    /* 再按流明的方式建一份「未镜像」rest 骨架：root 在原点、不缩放。
     * 它的 matrixWorld 就是资产的 rest 世界矩阵 W_plain。 */
    const plainRoot = new THREE.Group();
    const plain = skin.nodes.map((n) => {
      const b = new THREE.Bone();
      b.name = n.name || '';
      b.position.fromArray(n.position || [0, 0, 0]);
      b.quaternion.fromArray(n.rotation || [0, 0, 0, 1]);
      b.scale.fromArray(n.scale || [1, 1, 1]);
      return b;
    });
    skin.nodes.forEach((n, i) => { (n.parent >= 0 ? plain[n.parent] : plainRoot).add(plain[i]); });
    plainRoot.updateMatrixWorld(true);

    const maxDiff = (a, b) => {
      const x = a.elements, y = b.elements;
      let mx = 0, at = -1;
      for (let i = 0; i < 16; i++) { const d = Math.abs(x[i] - y[i]); if (d > mx) { mx = d; at = i; } }
      return [+mx.toFixed(9), at];
    };

    const nodeDiff = [];
    const invRoot = new THREE.Matrix4().copy(sk.root.matrixWorld).invert();
    (skin.nodes || []).forEach((n, i) => {
      const slot = nodeToSlot[i];
      if (slot == null) return;
      const b = boneList[slot];
      if (!b) { nodeDiff.push({ i, name: n.name, err: 'missing' }); return; }
      let max = 0;
      ['position', 'quaternion', 'scale'].forEach((k) => {
        const want = k === 'quaternion' ? (n.rotation || [0, 0, 0, 1]) : (n[k] || (k === 'scale' ? [1, 1, 1] : [0, 0, 0]));
        const got = b[k];
        const arr = k === 'quaternion' ? [got.x, got.y, got.z, got.w] : [got.x, got.y, got.z];
        for (let j = 0; j < arr.length; j++) {
          const d = Math.abs(arr[j] - (want[j] || 0));
          if (d > max) max = d;
        }
      });
      /* root 空间世界矩阵：折叠掉 mdBones 那层（含 T(-c) 与 scale.z=-1）之后，
       * 必须逐值等于资产的未镜像 rest 世界矩阵 —— 这就证明「镜像全在父级、
       * 局部变换一个都没改」，和流明第 739 行同一个口径。 */
      const local = new THREE.Matrix4().multiplyMatrices(invRoot, b.matrixWorld);
      const w = maxDiff(local, plain[i].matrixWorld);
      if (max > 1e-9 || w[0] > 1e-6) {
        nodeDiff.push({ i, name: n.name, max: +max.toFixed(6), world: w });
      }
    });
    const nameOk = (skin.nodes || []).every((n, i) => {
      const slot = nodeToSlot[i];
      return slot == null ? true : (boneList[slot].name === (n.name || ''));
    });
    const parentBad = [];
    const parentOk = (skin.nodes || []).every((n, i) => {
      const slot = nodeToSlot[i];
      if (slot == null) return true;
      const b = boneList[slot];
      /* 父节点：makeSkinFor 按**整棵节点树**建 Bone（11 根），Skeleton 只引用关节表里
       * 那 7 根 —— 所以 Chest 这种非关节节点仍然是真实的父级，必须照资产叫名字。
       * 根（parent < 0）挂在 mdBones 上。 */
      const wantName = n.parent >= 0 ? (skin.nodes[n.parent].name || '') : 'mdBones';
      const gotName = (b.parent && b.parent.name) || '(none)';
      if (gotName !== wantName) { parentBad.push({ i, name: n.name, want: wantName, got: gotName, nodeParent: n.parent }); return false; }
      return true;
    });

    /* ⑤ 清单 inverseBind 自洽（**未镜像**口径）。清单是行主序，转置成 three 的列主序 */
    const arr = skin.inverseBind;
    const list = skin.bones.map((_v, i) => {
      const m = new THREE.Matrix4();
      m.fromArray(arr, i * 16);
      m.transpose();
      return m;
    });
    let selfMax = 0, selfWorst = '';
    for (let i = 0; i < list.length; i++) {
      const nodeIdx = skin.bones[i];
      const inv = new THREE.Matrix4().copy(plain[nodeIdx].matrixWorld).invert();
      const d = maxDiff(list[i], inv)[0];
      if (d > selfMax) { selfMax = d; selfWorst = skin.nodes[nodeIdx].name; }
    }

    /* ⑥ App 实际用的 boneInverse。
     * 我们的 root 比资产多两层：T(-c)（把物体摆到原点）与 F（镜像），
     * 骨骼世界矩阵又整体挂在物体自身摆位 P 下，于是
     *   live = inv(P · T(-c) · F · W_rest) = inv(W_rest) · F · T(c) · inv(P)
     * 两边乘 P 就得到应该**逐值相等**的式子：
     *   live · P == 清单 · F · T(c)
     * 这条同时守住「镜像做了」「中心平移做了」「没有别的偏差」。 */
    const F = new THREE.Matrix4().makeScale(1, 1, -1);
    const Tc = new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]);
    const P = obj.matrixWorld;
    const live = sk.skeleton.boneInverses;
    let useMax = 0, useWorst = '', useAt = -1;
    for (let i = 0; i < list.length && i < live.length; i++) {
      const got = live[i].clone().multiply(P);
      const want = list[i].clone().multiply(F).multiply(Tc);
      const r = maxDiff(got, want);
      if (r[0] > useMax) { useMax = r[0]; useWorst = skin.nodes[skin.bones[i]].name; useAt = r[1]; }
    }

    return {
      verts: nOurs, rawVerts: nRaw, hasOrig,
      posOk: hasOrig && posBad === 0,
      posMax, posBad,
      uvOk: hasOrig && uvBad === 0, uvBad, uvMax,
      siOk: hasOrig && siBad === 0, siBad,
      swOk: hasOrig && swBad === 0, swBad,
      center: c, flipZ: !!skin.flipZ,
      nodeCount: (skin.nodes || []).length,
      boneCount: boneList.length,
      nodeDiff: nodeDiff.slice(0, 3), nodeDiffCount: nodeDiff.length,
      nameOk, parentOk, parentBad: parentBad.slice(0, 3),
      selfMax, selfWorst,
      useMax, useWorst, useAt,
      morphs: (g.morphAttributes.position || []).length
    };
  }, headId);

  check(raw.posOk, '① position 与清单 buffer 逐顶点相同（按 mdOrig 映射 · 只差常量 center 平移）',
    raw.posOk
      ? (raw.verts + '/' + raw.rawVerts + ' 顶点 · 最大偏差 ' + raw.posMax.toExponential(1) + 'm（float32 减法舍入）')
      : (raw.hasOrig ? (raw.posBad + ' 个分量超差 · 最大 ' + raw.posMax.toExponential(2)) : '缺 mdOrig 映射'));
  check(raw.uvOk, '② uv 逐顶点相同（uv 一变，贴图上那双眼睛就移位）',
    raw.uvOk ? '0 处差异' : (raw.uvBad + ' 处 · 最大 ' + raw.uvMax));
  check(raw.siOk, '③ skinIndex 逐顶点相同（按 mdOrig 重排后 · 早先这里漏了重排）',
    raw.siOk ? '0 处差异' : (raw.siBad + ' 处错位'));
  check(raw.swOk, '③ skinWeight 逐顶点相同（按 mdOrig 重排后）',
    raw.swOk ? '0 处差异' : (raw.swBad + ' 处错位'));

  const cx = Math.abs(raw.center[0]) + Math.abs(raw.center[1]) + Math.abs(raw.center[2]);
  check(true, '①b 整体平移量与镜像开关（建模 App 要把物体摆到原点，形变与此无关）',
    'center=' + JSON.stringify(raw.center.map((v) => +v.toFixed(4))) + ' · flipZ=' + raw.flipZ +
    (cx < 1e-6 ? ' · 无平移' : ' · 平移后与流明差这一个常量'));

  check(raw.boneCount === 7 && raw.nodeDiffCount === 0 && raw.nameOk && raw.parentOk,
    '④ 骨骼树与清单 nodes 逐值相同（7 个关节 · name / parent / 局部变换 / root 空间世界矩阵）',
    raw.boneCount + ' 根骨骼 · 差异 ' + raw.nodeDiffCount + ' 处' +
    (raw.nameOk ? '' : ' · name 不符') + (raw.parentOk ? '' : ' · parent 不符 ' + JSON.stringify(raw.parentBad)) +
    (raw.nodeDiff.length ? ' · ' + JSON.stringify(raw.nodeDiff[0]) : ''));

  /* ⑤ 的容差 1e-4（0.1mm）：清单 inverseBind 是离线按 float64 算的，节点 TRS 却是
   * float32 存根，1.23m 长链累到脖子只剩 2.9e-5 —— 那是存根精度，不是口径错。
   * 顺带一提：App 根本不用清单 inverseBind（syncSkinBind 实测），所以这条只是
   * 「清单自洽」的旁证，不是链路的一部分。 */
  check(raw.selfMax < 1e-4, '⑤ 清单 inverseBind == inverse(按清单 nodes 算出的 rest 世界矩阵 · 未镜像手性)',
    '最大元素差 ' + raw.selfMax.toExponential(2) + (raw.selfWorst ? ' · 最差 ' + raw.selfWorst : ''));
  check(raw.useMax < 1e-4, '⑥ App 的 boneInverse·P == 清单 · F · T(center)（差异只有镜像与中心平移）',
    '最大元素差 ' + raw.useMax.toExponential(2) + (raw.useWorst ? ' · 最差 ' + raw.useWorst : '') +
    ' · 出在元素 ' + raw.useAt);

  /* =====================================================================
   * ⑦ rest 严格还原
   * ===================================================================== */
  const rest = await page.evaluate((id) => {
    const THREE = window.THREE;
    const obj = window.modelDesk.nodeObject(id);
    const sk = obj.userData && obj.userData.mdSkin;
    /* ⚠ 必须先把眼球摆回 rest：视线是默认开着的，直接测会量到「转角造成的位移」，
     *   早先就这么报了 9.76mm 的假红。 */
    if (sk && sk.left && sk.right) {
      sk.left.quaternion.copy(sk.restL);
      sk.right.quaternion.copy(sk.restR);
      sk.root.updateMatrixWorld(true);
    }
    const g = obj.geometry, P = g.attributes.position;
    const v = new THREE.Vector3(), o = new THREE.Vector3();
    let max = 0, worst = -1;
    for (let i = 0; i < P.count; i++) {
      o.fromBufferAttribute(P, i);
      v.copy(o);
      obj.boneTransform(i, v);
      const d = v.distanceTo(o);
      if (d > max) { max = d; worst = i; }
    }
    return { max, worst, count: P.count };
  }, headId);
  check(rest.max < 1e-6, '⑦ 眼球复位到 rest 后，蒙皮结果 == position（严格还原）',
    (rest.max * 1000).toExponential(2) + ' mm · ' + rest.count + ' 顶点');

  /* =====================================================================
   * ⑧ + ⑨ 同一个骨骼局部旋转：位移场自转量级 / 与流明实现逐值比对
   * ===================================================================== */
  const pose = await page.evaluate(async (id) => {
    const THREE = window.THREE;
    const def = window.MDComponents.get('lumen-head');
    await def.load();
    const skin = def.skin();
    const obj = window.modelDesk.nodeObject(id);
    const sk = obj.userData.mdSkin;
    if (!sk) return { err: 'no skin' };

    const g = obj.geometry, P = g.attributes.position;
    const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    const boneList = sk.skeleton.bones;
    const li = boneList.indexOf(sk.left);

    const eyeW = (i) => {
      const ix = [SI.getX(i), SI.getY(i), SI.getZ(i), SI.getW(i)];
      const w = [SW.getX(i), SW.getY(i), SW.getZ(i), SW.getW(i)];
      let m = 0;
      for (let s = 0; s < 4; s++) if (ix[s] === li && w[s] > m) m = w[s];
      return m;
    };

    /* 眼球球心 = 高权重顶点质心（单侧，避免两眼平均成鼻梁） */
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < P.count; i++) {
      if (eyeW(i) < 0.45) continue;
      if (P.getX(i) >= 0) continue;
      n++; sx += P.getX(i); sy += P.getY(i); sz += P.getZ(i);
    }
    const C = new THREE.Vector3(sx / n, sy / n, sz / n);

    const d2r = Math.PI / 180;
    const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -8 * d2r, 0, 'YXZ'));

    /* --- 我们的：App 现成的 boneTransform --- */
    sk.left.quaternion.copy(sk.restL).multiply(Q);
    sk.right.quaternion.copy(sk.restR).multiply(Q);
    sk.root.updateMatrixWorld(true);
    const ours = new Float32Array(P.count * 3);
    const v = new THREE.Vector3(), o = new THREE.Vector3();
    let maxD = 0, sumD = 0, cnt = 0, maxR = 0;
    for (let i = 0; i < P.count; i++) {
      o.fromBufferAttribute(P, i);
      v.copy(o);
      obj.boneTransform(i, v);
      ours[i * 3] = v.x - o.x; ours[i * 3 + 1] = v.y - o.y; ours[i * 3 + 2] = v.z - o.z;
      const ew = eyeW(i);
      if (ew < 0.45 || P.getX(i) >= 0) continue;
      const d = v.distanceTo(o);
      if (d > maxD) maxD = d;
      sumD += d; cnt++;
      const r = Math.hypot(o.x - C.x, o.z - C.z);
      if (r > maxR) maxR = r;
    }
    sk.left.quaternion.copy(sk.restL);
    sk.right.quaternion.copy(sk.restR);
    sk.root.updateMatrixWorld(true);

    /* --- 参考实现：完全用清单原始 buffer 独立重算，**不镜像** ---
     * W_rest / W_pose 都按清单 nodes 的局部变换搭出来（root 在原点、不缩放），
     * 每个关节的蒙皮矩阵 K = W_pose · W_rest⁻¹ —— 这就是「流明那副骨架」的
     * boneWorld·boneInverse（清单 inverseBind 与之差 ≤0.03mm，见 ⑤）。
     *
     * ⚠ 关键口径：我们的骨骼树多一层 `scale.z = -1`，于是有效的蒙皮矩阵是
     *     M_ours = R · (W_pose·W_rest⁻¹) · R⁻¹，R = T(-c)·F
     *   把它作用在 u = v − c 上、再算位移，等价于
     *     d_ours = F · [ K·(F v) − F v ]
     *   —— 即在**镜像后的点**上求值、再把位移镜像回去（因为 F 是等距变换，模长不变）。
     *   这一步是必须的：清单的骨架「脸朝 −Z」（LeftEye z=−0.032），顶点却是「脸朝 +Z」
     *   （眼球质心 z=+0.030）。少了这一层，枢轴离眼球 62mm，转眼球就变成整颗平移
     *   （实测 6.86mm 全是平移分量）—— 这正是「眼球完全没动」那个 bug。
     *
     * 早先的错误口径（报 170.79mm）：直接拿镜像后的 boneWorld 乘清单 inverseBind，
     * 忘了 `bindMatrixInverse` 那一半 —— 那对矩阵在真实渲染里把 F 抵消掉了。 */
    const bin = atob(window.LUMEN3D_GEOMETRY);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = bytes.buffer;
    const readF32 = (desc) => new Float32Array(buf, desc.offset, desc.count);
    const meshMeta = (window.LUMEN3D_META.avatar.meshes || []).find((m) => m.morphs && m.morphs.length);
    const posRaw = readF32(meshMeta.position);
    const siRaw = readF32(meshMeta.skinIndex);
    const swRaw = readF32(meshMeta.skinWeight);

    const buildPlain = (posed) => {
      const r = new THREE.Group();
      const bs = skin.nodes.map((nd) => {
        const b = new THREE.Bone();
        b.name = nd.name || '';
        b.position.fromArray(nd.position || [0, 0, 0]);
        b.quaternion.fromArray(nd.rotation || [0, 0, 0, 1]);
        b.scale.fromArray(nd.scale || [1, 1, 1]);
        return b;
      });
      skin.nodes.forEach((nd, i) => { (nd.parent >= 0 ? bs[nd.parent] : r).add(bs[i]); });
      r.updateMatrixWorld(true);
      if (posed) {
        bs[skin.joints.leftEye].quaternion.multiply(Q);
        bs[skin.joints.rightEye].quaternion.multiply(Q);
        r.updateMatrixWorld(true);
      }
      return bs;
    };
    const Wr = buildPlain(false).map((b) => b.matrixWorld.clone());
    const Wp = buildPlain(true).map((b) => b.matrixWorld.clone());
    const K = skin.bones.map((ni) => new THREE.Matrix4().multiplyMatrices(Wp[ni], Wr[ni].clone().invert()));

    /* 逐顶点。渲染顶点 i 对应资产顶点 orig[i]（buildGeometry 拆点 + 面序遍历），
     * 位置、权重、索引三样都得按这张表取，否则比的不是同一个点。 */
    const origMap = (g.userData && g.userData.mdOrig) || null;
    let pq = 0, vecMax = 0, vecAt = -1, lenSum = 0, nz = 0;
    let unmirrored = 0, unmirroredMax = 0;
    for (let i = 0; i < P.count; i++) {
      const j = origMap ? origMap[i] : i;
      const x = posRaw[j * 3], y = posRaw[j * 3 + 1], z = posRaw[j * 3 + 2];
      /* 在镜像点上求值：x' = F·v = (x, y, −z) */
      const mx = x, my = y, mz = -z;
      let ox = 0, oy = 0, oz = 0;
      let ux = 0, uy = 0, uz = 0;
      for (let s = 0; s < 4; s++) {
        const w = swRaw[j * 4 + s];
        if (!w) continue;
        const m = K[siRaw[j * 4 + s]];
        if (!m) continue;
        const e = m.elements;
        ox += w * (e[0] * mx + e[4] * my + e[8] * mz + e[12]);
        oy += w * (e[1] * mx + e[5] * my + e[9] * mz + e[13]);
        oz += w * (e[2] * mx + e[6] * my + e[10] * mz + e[14]);
        /* 反证用：如果不在镜像点上求值（错误口径），位移会变成纯平移 */
        ux += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
        uy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
        uz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      /* 位移再镜像回来：d = F · (K·Fv − F·v) */
      const dx = ox - mx, dy = oy - my, dz = -(oz - mz);
      const ex = ours[i * 3] - dx, ey = ours[i * 3 + 1] - dy, ez = ours[i * 3 + 2] - dz;
      const dd = Math.hypot(ex, ey, ez);
      if (dd > 1e-6) { pq++; if (dd > vecMax) { vecMax = dd; vecAt = i; } }
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-6) { nz++; lenSum += len; }
      const ul = Math.hypot(ux - x, uy - y, uz - z);
      if (ul > 1e-6) { unmirrored++; if (ul > unmirroredMax) unmirroredMax = ul; }
    }
    return {
      eyeVerts: cnt, maxD, meanD: sumD / Math.max(cnt, 1), radius: maxR,
      expect4: maxR * Math.sin(4 * d2r), expect8: maxR * Math.sin(8 * d2r),
      verts: P.count,
      vecBad: pq, vecMax, vecAt,
      moved: nz, meanLen: lenSum / Math.max(nz, 1),
      unmirrored, unmirroredMax,
      hasOrig: !!origMap
    };
  }, headId);

  if (pose.err) {
    check(false, '⑧ 转同一个局部角：位移场自重转', pose.err);
    check(false, '⑨ 同姿态下逐顶点位移 == 流明实现', pose.err);
  } else {
    const lo = Math.min(pose.expect4, pose.expect8) * 0.45;
    const hi = Math.max(pose.expect4, pose.expect8) * 1.6;
    check(pose.maxD > 0.0005 && pose.maxD > lo && pose.maxD < hi,
      '⑧ 转 8° 后位移是「绕眼球自转」（量级落在 0.5 权重后的解析区间）',
      '最大 ' + (pose.maxD * 1000).toFixed(2) + 'mm · 均值 ' + (pose.meanD * 1000).toFixed(2) +
      'mm · 球半径 ' + (pose.radius * 1000).toFixed(1) + 'mm · 区间 [' +
      (lo * 1000).toFixed(2) + ',' + (hi * 1000).toFixed(2) + ']mm · ' + pose.eyeVerts + ' 顶点');

    check(pose.vecBad === 0,
      '⑨ 同姿态下逐顶点位移向量 == 参考实现（F·[K·(F·v) − F·v]）· 决定性',
      pose.vecBad === 0
        ? (pose.verts + ' 顶点全等 · 最大差 ' + (pose.vecMax * 1e3).toExponential(1) + 'mm · ' +
           pose.moved + ' 个点动了 · 均值 ' + (pose.meanLen * 1000).toFixed(3) + 'mm')
        : (pose.vecBad + ' 个顶点不符 · 最大 ' + (pose.vecMax * 1000).toFixed(4) + 'mm · 首个 #' + pose.vecAt));
    /* 反证：把求值点换成「未镜像」的 v（漏掉父级镜像那一层），位移立刻变成平移主导 ——
     * 6.86mm vs 3.39mm，枢轴跑到脸后面 62mm。这条不是断言，是给后来人看的口径凭据。 */
    check(pose.unmirrored > 0, '⑨b 反证：漏掉镜像层会在未镜像点上求值（位移翻倍 = 整颗平移）',
      pose.unmirrored + ' 个点位移 ' + (pose.unmirroredMax * 1000).toFixed(2) + 'mm（对照正确口径 ' +
      (pose.maxD * 1000).toFixed(2) + 'mm）');
  }

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  RUN.finish(errors, { fails: fails });
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 条失败 · ' + RUN.dir : '✅ 全部通过 · ' + RUN.dir);
  process.exit(fails ? 1 : 0);
})();
