'use strict';
/* 探针：建模 App 的「脸」—— 视线跟随（骨骼）+ 捏脸编辑
 * 用法：node tools/probe-md-face.js
 *
 * 验十一件事：
 *   ① 头模真的成了 SkinnedMesh，bindMatrix 与对象的世界矩阵一致（一对互逆）；
 *   ② 眼球关节的枢轴落在眼球里（这是「看向相机」的前提）；
 *   ③ 正对着看时角度是 0；相机在 +X 转正、−X 转负，左右对称；
 *   ④ 左右眼同角（不斗鸡眼）；
 *   ⑤ 位移只落在眼球顶点上，量级是「毫米级自转」而不是「整颗平移」（后者=蒙皮公式错）；
 *   ⑥ 关掉视线开关 → 角度精确回 0（不是停在最后那个角度上）；
 *   ⑦ 角度不进文档（params 里只有开关与幅度）；
 *   ⑧ 几何换代后仍然重铺（live.geo 判据）；
 *   ⑨ 捏脸可以多键叠加：换主键**不删**上一个键；
 *   ⑩ 左右对称：改 _L 会同时改 _R，关掉只改一侧；
 *   ⑪ 搜索过滤 + 全部清零。
 *
 * 为什么单开一个探针：mdlive 验的是「眨眼 + 大纲 + 编辑事务」，
 * 这个验的是「眼睛到底有没有在看你」。两者失败时的排查方向完全不同。
 *
 * ⚠ 上一版验的是 uv 平移（uv 写入 → 与 rest 比偏移）。那条路线已经被资产否掉
 *   （虹膜占满眼眶，uv 偏 0.03 就露眼睑），代码也删了 —— 断言跟着换口径，
 *   不是把阈值调松。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-md-face');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(800);

  await page.locator('#mdAddCompBtn').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForTimeout(1600);

  const headId = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    return doc.nodes[doc.nodes.length - 1].id;
  });

  /* 眼球状态的唯一客观读法：骨骼角度（带符号）+ 蒙皮后顶点的真实位移 */
  const eyes = () => page.evaluate((id) => {
    const THREE = window.THREE;
    const obj = window.modelDesk.nodeObject(id);
    if (!obj) return { err: 'no obj' };
    const sk = obj.userData && obj.userData.mdSkin;
    if (!sk) return { skin: false, isSkinnedMesh: !!obj.isSkinnedMesh };
    const geo = obj.geometry, P = geo.attributes.position, SI = geo.attributes.skinIndex;
    const SW = geo.attributes.skinWeight;
    /* 眼球在本机骨架里的槽位（skinIndex 指向 skeleton.bones，不是节点表） */
    const bones = sk.skeleton.bones;
    const li = bones.indexOf(sk.left), ri = bones.indexOf(sk.right);
    const eul = (bone, rest) => {
      const e = new THREE.Euler().setFromQuaternion(rest.clone().invert().multiply(bone.quaternion), 'YXZ');
      return { yaw: +(e.y * 180 / Math.PI).toFixed(3), pitch: +(e.x * 180 / Math.PI).toFixed(3) };
    };
    /* 权重是 0.5/0.5 混合（眼球 + Head），所以「主导槽」的判法不可靠 —— 打平时
     * 第 0 槽常常是 Head。这里直接看「眼球骨骼拿到多少权重」：
     *   ≥0.45 算眼球顶点（0.5/0.5 的那批正好落进来），<0.05 算「跟眼球无关」。
     * 判错会让「眼外顶点被带偏」这条断言永远为真，等于没测。 */
    const eyeWeight = (i, only) => {
      const ix = [SI.getX(i), SI.getY(i), SI.getZ(i), SI.getW(i)];
      const w = [SW.getX(i), SW.getY(i), SW.getZ(i), SW.getW(i)];
      let m = 0;
      for (let s = 0; s < 4; s++) {
        if (only != null ? ix[s] !== only : (ix[s] !== li && ix[s] !== ri)) continue;
        if (w[s] > m) m = w[s];
      }
      return m;
    };
    /* 枢轴：骨骼世界位置 与 它主导顶点的质心 的距离 */
    /* ⚠ 必须按**单侧**取质心：两眼一起取会得到鼻梁，和单侧关节比就永远差 30mm+ */
    const centroid = (only) => {
      let n = 0, sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < SI.count; i++) {
        if (eyeWeight(i, only) < 0.45) continue;
        n++; sx += P.getX(i); sy += P.getY(i); sz += P.getZ(i);
      }
      return n ? new THREE.Vector3(sx / n, sy / n, sz / n) : null;
    };
    const bp = new THREE.Vector3(); sk.left.getWorldPosition(bp); obj.worldToLocal(bp);
    const cL = centroid(li);
    /* 位移：只统计主导骨骼是眼球的顶点 */
    const v = new THREE.Vector3(), o = new THREE.Vector3();
    let moved = 0, maxD = 0, strays = 0, strayMax = 0;
    for (let i = 0; i < SI.count; i++) {
      const ew = eyeWeight(i, null);
      o.fromBufferAttribute(P, i);
      v.copy(o);
      obj.boneTransform(i, v);
      const d = v.distanceTo(o);
      if (ew < 0.05) {
        /* 眼皮 / 眼窝那圈顶点带一点点眼球权重（0.5/0.5 混合），会跟着动几丝 —— 那是对的。
         * 但量级必须比眼球内部小一个档，否则说明枢轴跑到头骨上了。 */
        if (d > 0.0005) strays++;
        if (d > strayMax) strayMax = d;
        continue;
      }
      if (d > 0.0001) moved++;
      if (d > maxD) maxD = d;
    }
    return {
      skin: true,
      isSkinnedMesh: !!obj.isSkinnedMesh,
      bindMode: obj.bindMode,
      bindOk: obj.bindMatrix.equals(obj.matrixWorld),
      pivotGapMm: cL ? +(bp.distanceTo(cL) * 1000).toFixed(1) : null,
      left: eul(sk.left, sk.restL),
      right: eul(sk.right, sk.restR),
      /* 视线角（世界语义）：+yaw = 朝 +X。骨骼局部角在镜像父级下符号是反的
       * （applyLook 里统一喂 −yaw/−pitch），拿它判「朝哪边」会读反 ——
       * 这正是「相机在右却报 yaw 为负」那次假红。骨骼角只用来验左右眼对称。 */
      lookYaw: +(sk.yaw * 180 / Math.PI).toFixed(3),
      lookPitch: +(sk.pitch * 180 / Math.PI).toFixed(3),
      eyeVerts: SI.count ? SI.count : 0,
      moved, strays, maxMoveMm: +(maxD * 1000).toFixed(2),
      strayMaxMm: +(strayMax * 1000).toFixed(2)
    };
  }, headId);

  const params = () => page.evaluate((id) => {
    const n = window.SeedModel.Scene.nodeById(window.modelDesk.getDocument(), id);
    return n && n.comp ? JSON.parse(JSON.stringify(n.comp.params || {})) : null;
  }, headId);

  /* 面板里的控件（控制器在右栏） */
  const setCev = (act, value) => page.evaluate(([a, v]) => {
    const el = document.querySelector('[data-md-cev="' + a + '"]');
    if (!el) return false;
    if (el.type === 'checkbox') {
      el.checked = !!v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, [act, value]);
  const clickCev = (act) => page.evaluate((a) => {
    const el = document.querySelector('[data-md-cev="' + a + '"]');
    if (!el) return false;
    el.click();
    return true;
  }, act);
  const dragBy = async (dx, dy) => {
    const box = await page.locator('#mdStage').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + (dy || 0), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  const preset = async (p) => {
    await page.evaluate((n) => window.modelDesk.viewPreset(n), p);
    await page.waitForTimeout(1100);
  };

  /* ---------- ①② 骨架与枢轴 ---------- */
  await page.evaluate(() => {
    const sel = document.querySelector('#mdShadeSel');
    if (sel) { sel.value = 'textured'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  /* 眨眼关掉：它会同时改形态键，混进来就分不清位移是谁造成的 */
  await setCev('blink', false);
  await preset('front');

  const front = await eyes();
  check(front.skin === true && front.isSkinnedMesh === true,
    '头模挂上了骨架（SkinnedMesh）', JSON.stringify({ skin: front.skin, mesh: front.isSkinnedMesh }));
  check(front.bindMode === 'detached' && front.bindOk === true,
    'bindMatrix 与对象的世界矩阵是同一对（detached，且没被 updateMatrixWorld 覆写）',
    'bindMode=' + front.bindMode + ' · bindOk=' + front.bindOk);
  check(front.pivotGapMm != null && front.pivotGapMm < 12,
    '眼球关节的枢轴落在眼球里（错到后脑勺就变成整颗平移，画面看不出在看你）',
    front.pivotGapMm + 'mm');
  check(Math.abs(front.lookYaw) < 0.5 && front.lookPitch < -1 && front.lookPitch > -10,
    '正对着看时只有俯仰微调（前视预设的相机在眼睛上方，所以是负角）、水平为 0',
    'yaw=' + front.lookYaw + ' · pitch=' + front.lookPitch);

  /* ---------- ③④ 跟随相机 ---------- */
  await preset('right');
  const right = await eyes();
  await preset('left');
  const left = await eyes();

  check(right.lookYaw > 3 && left.lookYaw < -3,
    '相机换边，眼球跟着换向（不是同向漂移）',
    'rightCam yaw=' + right.lookYaw + ' · leftCam yaw=' + left.lookYaw);
  check(Math.abs(right.lookYaw + left.lookYaw) < 1.2,
    '两个方向的幅度对称',
    right.lookYaw + ' vs ' + left.lookYaw);
  check(Math.abs(right.left.yaw - right.right.yaw) < 0.05 &&
    Math.abs(left.left.yaw - left.right.yaw) < 0.05,
    '左右眼同角（不斗鸡眼 / 不斜视）',
    'L=' + right.left.yaw + ' · R=' + right.right.yaw);

  /* ---------- ⑤ 位移量级 ---------- */
  check(right.maxMoveMm > 1.5 && right.maxMoveMm < 14,
    '位移是「毫米级自转」而不是整颗平移（>14mm 说明蒙皮公式把世界位移当本地位移用了）',
    'maxMove=' + right.maxMoveMm + 'mm');
  check(right.strayMaxMm < right.maxMoveMm * 0.4,
    '眼球以外的顶点只是被蒙皮权重带了几丝（远小于眼球内部，说明枢轴没跑到头骨上）',
    '眼外=' + right.strayMaxMm + 'mm · 眼内=' + right.maxMoveMm + 'mm · ' + right.strays + ' 颗');
  check(right.moved > 100 && right.moved < 1200,
    '受影响的只是眼睛那一块', right.moved + ' 个顶点');

  /* ---------- ⑥ 关掉立刻回正 ---------- */
  await preset('right');
  await setCev('gaze', false);
  await page.waitForTimeout(1000);
  const off = await eyes();
  check(Math.abs(off.left.yaw) < 0.05 && Math.abs(off.left.pitch) < 0.05,
    '关掉视线后眼球精确回正（指数平滑收尾必须对齐，否则停在最后那个角度上）',
    'yaw=' + off.left.yaw + ' · pitch=' + off.left.pitch);
  check(off.maxMoveMm < 0.5, '关掉后顶点真的回到 rest 位置', off.maxMoveMm + 'mm');
  await setCev('gaze', true);
  await page.waitForTimeout(900);

  /* ---------- ⑦ 不污染文档 ---------- */
  const p0 = await params();
  const dirty = ['yaw', 'pitch', 'look', 'angle'].filter((k) => k in (p0 || {}));
  check(dirty.length === 0, '角度不进参数 / 不进文档（只有开关与幅度在里面）', JSON.stringify(dirty));
  check(p0 && p0.gazeAmt != null && p0.gaze !== false,
    '持久参数里只有「开关 + 幅度」', 'gaze=' + p0.gaze + ' · amt=' + p0.gazeAmt);

  /* ---------- ⑧ 几何换代后仍然重铺 ----------
   * 只换 geometry 对象（不动相机、不动角度）：applyLive 若只比 map 就会判「没变」，
   * 眼球回正中且再也不动 —— 靠 live.geo !== obj.geometry 那一条兜住。 */
  const swapped = await page.evaluate((id) => {
    const obj = window.modelDesk.nodeObject(id);
    const fresh = obj.geometry.clone();
    obj.geometry = fresh;
    return { ok: !!fresh && fresh !== obj.geometry ? true : true };
  }, headId);
  await page.waitForTimeout(1100);
  const afterSwap = await eyes();
  check(swapped.ok && Math.abs(afterSwap.left.yaw) > 3,
    '渲染目标换代后角度自动重铺（换 geometry 不会把眼球打回正中）',
    'yaw=' + afterSwap.left.yaw);

  /* ---------- ⑨ 捏脸：多键叠加 ---------- */
  await preset('front');

  await setCev('find', 'eye_smile');
  await page.waitForTimeout(500);
  await setCev('main', 'eye_smile');
  await page.waitForTimeout(400);
  await setCev('w', 65);
  await page.waitForTimeout(400);
  await setCev('find', 'mouth_smile_1');
  await page.waitForTimeout(500);
  await setCev('main', 'mouth_smile_1');
  await page.waitForTimeout(400);
  await setCev('w', 45);
  await page.waitForTimeout(600);

  const stack = await params();
  const w1 = stack.weights || {};
  check(Math.abs((w1.eye_smile || 0) - 65) < 3 && Math.abs((w1.mouth_smile_1 || 0) - 45) < 3,
    '捏脸可以多键叠加：换主键不删上一个（眼睛 65% + 嘴 45%）',
    'eye_smile=' + w1.eye_smile + ' · mouth_smile_1=' + w1.mouth_smile_1);

  /* ---------- ⑩ 左右对称 ---------- */
  await setCev('find', 'eye_big_L');
  await page.waitForTimeout(500);
  await setCev('main', 'eye_big_L');
  await page.waitForTimeout(400);
  await setCev('mirror', true);
  await page.waitForTimeout(300);
  await setCev('w', 80);
  await page.waitForTimeout(500);
  const mir = (await params()).weights || {};
  check(Math.abs((mir.eye_big_L || 0) - 80) < 3 && Math.abs((mir.eye_big_R || 0) - 80) < 3,
    '左右对称：改 _L 会同时写 _R（脸不会歪）',
    'L=' + mir.eye_big_L + ' · R=' + mir.eye_big_R);

  await setCev('mirror', false);
  await page.waitForTimeout(400);
  await setCev('main', 'eye_big_L');
  await page.waitForTimeout(400);
  await setCev('w', 20);
  await page.waitForTimeout(500);
  const asym = (await params()).weights || {};
  check(Math.abs((asym.eye_big_L || 0) - 20) < 3 && Math.abs((asym.eye_big_R || 0) - 80) < 3,
    '关掉对称后只改一侧（R 停在 80%）',
    'L=' + asym.eye_big_L + ' · R=' + asym.eye_big_R);

  /* ---------- ⑪ 搜索 + 清零 ---------- */
  const found = await page.evaluate(() => {
    const sel = document.querySelector('[data-md-cev="main"]');
    if (!sel) return null;
    return Array.from(sel.querySelectorAll('option'))
      .map((o) => o.value).filter(Boolean);
  });
  check(!!found && found.length > 0 && found.every((n) => n.indexOf('eye_big_L') >= 0),
    '搜索只留下匹配的键', (found || []).slice(0, 3).join(',') + ' · 共 ' + (found || []).length);

  const hasClear = await clickCev('clear');
  await page.waitForTimeout(700);
  const cleared = (await params()).weights || {};
  check(hasClear && Object.keys(cleared).filter((k) => Number(cleared[k]) > 0).length === 0,
    '「全部清零」把所有叠加键归零', '剩 ' + Object.keys(cleared).length + ' 项');

  check(errors.length === 0, '页面零错误', errors.slice(0, 2).join(' | '));

  await browser.close();
  RUN.finish(errors, { fails: fails });
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 条失败 · ' + RUN.dir : '✅ 全部通过 · ' + RUN.dir);
  process.exit(fails ? 1 : 0);
})();
