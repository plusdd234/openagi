/* M6a 工具框架探针：命令表 / 工具会话 / 吸附 / 显示开关 四条链路 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

const checks = [];
function check(ok, name, detail) {
  checks.push({ ok: !!ok, name, detail: detail == null ? '' : String(detail) });
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (detail ? ' · ' + detail : ''));
}

(async () => {
  const root = path.join(__dirname, '..');
  const b = await chromium.launch({ channel: 'msedge' });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(String(e.message)));

  await p.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await p.waitForTimeout(600);
  await p.evaluate(() => window.openDeskApp('modeldesk'));
  await p.waitForTimeout(2300);

  /* 1) 四个模块已加载 */
  const mods = await p.evaluate(() => ({
    commands: !!window.SeedCommands,
    tools: !!window.SeedTools,
    snap: !!window.SeedSnap,
    viewFlags: !!window.SeedViewFlags
  }));
  check(mods.commands && mods.tools && mods.snap && mods.viewFlags,
    '四个模块已加载（commands / tools / snap / viewFlags）', JSON.stringify(mods));

  /* 2) 命令表：define / lookup / list / available / run */
  const cmd = await p.evaluate(() => {
    const C = window.SeedCommands;
    const rec = C.lookup('tool.inflate');
    return {
      hasRec: !!rec, label: rec && rec.label, group: rec && rec.group, key: rec && rec.key,
      listLen: C.list().length,
      avail: C.available('tool.inflate', {}),
      bogus: C.run('nope.nothing', {})
    };
  });
  check(cmd.hasRec && cmd.label === '沿法线外推' && cmd.group === 'mesh' && cmd.key === 'B',
    '命令注册表：define/lookup 工作（id/label/group/key 都对）', JSON.stringify(cmd));
  check(cmd.listLen >= 1 && cmd.avail === true,
    '命令表 list/available 工作（菜单可渲染）', 'list=' + cmd.listLen + ' avail=' + cmd.avail);
  check(cmd.bogus && cmd.bogus.ok === false && cmd.bogus.reason === 'no-such-command',
    '命令表拒绝未注册 id（不抛异常）', JSON.stringify(cmd.bogus));

  /* 3) 工具会话：begin → drag → commit = 一条历史 */
  const s0 = await p.evaluate(() => {
    const s = window.modelDesk.getState();
    return { undo: s.undo, hash: s.meshHash, faces: s.faces };
  });
  const live1 = await p.evaluate(() => {
    const r = window.modelDesk.beginTool('tool.inflate');
    return { ok: r, state: window.modelDesk.getState() };
  });
  check(live1.ok === true && live1.state.toolLive === true && live1.state.toolId === 'tool.inflate' && live1.state.toolPreview === true,
    'begin：会话启动 + 预览挂进视口（文档未动）',
    JSON.stringify({ ok: live1.ok, live: live1.state.toolLive, id: live1.state.toolId, preview: live1.state.toolPreview }));

  const sMid = await p.evaluate(() => window.modelDesk.getState());
  check(sMid.undo === s0.undo && sMid.meshHash === s0.hash,
    'drag 中文档逐字节不变（预览只进视口）',
    'undo ' + s0.undo + '→' + sMid.undo + ' hash ' + (sMid.hash === s0.hash ? 'same' : 'DIFF'));

  /* 改参数 → 预览重算（但仍不动文档） */
  await p.evaluate(() => {
    window.modelDesk.tools().setParams({ offset: 0.3 });
  });
  const sParam = await p.evaluate(() => window.modelDesk.getState());
  check(sParam.toolPreview === true && sParam.undo === s0.undo && sParam.meshHash === s0.hash,
    'setParams 重算预览、仍不进历史', 'undo=' + sParam.undo);

  /* commit：一条历史 + 文档变了 */
  const live2 = await p.evaluate(() => {
    const r = window.modelDesk.commitTool();
    return { r: r, state: window.modelDesk.getState() };
  });
  check(live2.r && live2.r.ok === true && live2.state.toolLive === false && live2.state.toolPreview === false,
    'commit：预览收起、会话结束', JSON.stringify({ ok: live2.r && live2.r.ok, live: live2.state.toolLive }));
  check(live2.state.undo === s0.undo + 1 && live2.state.meshHash !== s0.hash,
    'commit 只记一条历史（hash 变、undo +1）',
    'undo ' + s0.undo + '→' + live2.state.undo + ' hash ' + (live2.state.meshHash !== s0.hash ? 'changed' : 'SAME'));

  /* 4) Esc 无痕：begin → Esc → 文档逐字节回 begin 前 */
  const sBefore = await p.evaluate(() => {
    window.modelDesk.beginTool('tool.inflate');
    return window.modelDesk.getState();
  });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(150);
  const sAfterEsc = await p.evaluate(() => window.modelDesk.getState());
  check(sAfterEsc.toolLive === false && sAfterEsc.toolPreview === false,
    'Esc：会话结束 + 预览收起', JSON.stringify({ live: sAfterEsc.toolLive, preview: sAfterEsc.toolPreview }));
  check(sAfterEsc.undo === sBefore.undo && sAfterEsc.meshHash === sBefore.meshHash,
    'Esc：文档逐字节不变（无痕）',
    'undo ' + sBefore.undo + '→' + sAfterEsc.undo + ' hash ' + (sAfterEsc.meshHash === sBefore.meshHash ? 'same' : 'DIFF'));

  /* 4b) 操纵器归属：由工具 spec 的 ownsGizmo 声明，不再由外壳认 id（tool.extrude）。
   *    三条都要测，少一条就会「改对了但没人知道」：
   *      ① 无主工具不该被误收（以前外壳认 id，非挤出工具都走 else 分支，等价于本条）
   *      ② 有主工具必须收起（两套手柄叠在同一处，变换手柄 capture 阶段先拿事件）
   *      ③ 取消后必须挂回去（不恢复 = 用户点不到手柄，且没有任何报错） */
  const gzA = await p.evaluate(() => {
    const S = window.SeedTools;
    window.modelDesk.beginTool('tool.inflate');
    const d = window.modelDesk.__debug();
    return { api: typeof S.ownsGizmo, owns: S.ownsGizmo(), cur: (S.current() || {}).ownsGizmo, target: !!d.gizmo.target };
  });
  check(gzA.api === 'function' && gzA.owns === false && gzA.cur === false,
    'ownsGizmo 契约：无主工具不声明操纵器', JSON.stringify(gzA));
  check(gzA.target === true,
    '无主工具会话里变换手柄照常挂在对象上（不该被误收）');

  const gzB = await p.evaluate(() => {
    const S = window.SeedTools;
    window.modelDesk.cancelTool();
    const ok = window.modelDesk.beginTool('tool.extrude');
    const d = window.modelDesk.__debug();
    return {
      ok: ok, owns: S.ownsGizmo(), ownId: S.ownsGizmo('tool.extrude'), otherId: S.ownsGizmo('tool.inflate'),
      cur: (S.current() || {}).ownsGizmo, targetNull: d.gizmo.target === null, visible: d.gizmo.group.visible
    };
  });
  check(gzB.ok === true && gzB.owns === true && gzB.cur === true && gzB.ownId === true && gzB.otherId === false,
    '挤出声明 ownsGizmo：本工具真、别的工具假（不是「有会话就真」）', JSON.stringify(gzB));
  check(gzB.targetNull === true && gzB.visible === false,
    '有主工具会话里变换手柄收起（不与专用箭头抢事件）');

  const gzC = await p.evaluate(() => {
    const S = window.SeedTools;
    window.modelDesk.cancelTool();
    const d = window.modelDesk.__debug();
    return { owns: S.ownsGizmo(), cur: S.current(), target: !!d.gizmo.target, visible: d.gizmo.group.visible };
  });
  check(gzC.owns === false && gzC.cur === null && gzC.target === true && gzC.visible === true,
    '取消后变换手柄挂回去（否则用户点不到手柄且无报错）', JSON.stringify(gzC));

  /* 5) B 键触发假工具 → 再按 B 提交 */
  const sPre = await p.evaluate(() => window.modelDesk.getState());
  await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await p.keyboard.press('b');
  await p.waitForTimeout(150);
  const sB1 = await p.evaluate(() => window.modelDesk.getState());
  check(sB1.toolLive === true && sB1.toolPreview === true,
    'B 键启动工具会话', JSON.stringify({ live: sB1.toolLive, preview: sB1.toolPreview }));
  await p.keyboard.press('b');
  await p.waitForTimeout(200);
  const sB2 = await p.evaluate(() => window.modelDesk.getState());
  check(sB2.toolLive === false && sB2.undo === sPre.undo + 1,
    '再按 B 提交（一条历史）', 'undo ' + sPre.undo + '→' + sB2.undo);

  /* 6) 命令行也走命令表 */
  await p.evaluate(() => {
    const c = document.getElementById('mdCmd');
    c.value = 'tool.inflate';
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await p.waitForTimeout(150);
  const sCli = await p.evaluate(() => window.modelDesk.getState());
  check(sCli.toolLive === true, '命令行「tool.inflate」启动会话（与命令表同源）', 'live=' + sCli.toolLive);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);

  /* 7) 吸附服务（A3）：步长取整 + 候选点吸附 */
  const snap = await p.evaluate(() => {
    const S = window.SeedSnap;
    /* 外壳初始把 UI 的吸附开关（默认关）同步进服务，这里单独测服务本身，先显式打开 */
    S.setEnabled(true);
    S.setPrefs({ move: 0.5 });
    const v = { x: 0.37, y: 1.12, z: -0.4 };
    S.snapPoint(v, {});
    const cands = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }];
    const hit = S.snapTo({ x: 0.9, y: 0.95, z: 0.9 }, cands, 0.5);
    const miss = S.snapTo({ x: 50, y: 50, z: 50 }, cands, 0.5);
    const ang = S.snapAngle(0.7);
    return {
      v: [v.x, v.y, v.z],
      hit: hit && [hit.x, hit.y, hit.z],
      miss: miss === null,
      ang: +ang.toFixed(3),
      prefs: S.getPrefs()
    };
  });
  check(snap.v[0] === 0.5 && snap.v[1] === 1 && snap.v[2] === -0.5,
    '吸附：步长取整（move=0.5）', JSON.stringify(snap.v));
  check(snap.hit && snap.hit[0] === 1 && snap.miss === true,
    '吸附：候选点最近 + 超出半径返回 null', JSON.stringify({ hit: snap.hit, miss: snap.miss }));
  /* 角度吸附步长来自 prefs.rotate（度），这里 15° ≈ 0.262 rad → 0.7 取整到 3 步 = 0.785 */
  check(snap.prefs.move === 0.5 && Math.abs(snap.ang - 0.785) < 0.02,
    '吸附：偏好生效（步长不写死）', JSON.stringify({ prefs: snap.prefs, ang: snap.ang }));

  /* 8) 显示开关表（A4）：set/toggle/onChange */
  const vf = await p.evaluate(() => {
    const V = window.SeedViewFlags;
    const log = [];
    const off = V.onChange((n, v) => log.push(n + '=' + v));
    V.set('grid', false);
    V.toggle('edges');
    const all = V.all();
    off();
    V.set('grid', true);
    return {
      log: log,
      grid: V.get('grid'),
      edges: V.get('edges'),
      names: all.map(x => x.name).join(','),
      afterOff: log.length
    };
  });
  check(vf.log.join('|') === 'grid=false|edges=false' && vf.grid === true && vf.edges === false,
    '显示开关：set/toggle/onChange 广播', JSON.stringify(vf.log));
  check(vf.names === 'grid,edges,verts,backface,material,texture,lighting,wireframe',
    '显示开关：八项（A4 口径）', vf.names);

  /* 8b) A1：后四项真的落到材质与灯光 */
  const flagsLive = await p.evaluate(() => {
    const V = window.SeedViewFlags, D = window.modelDesk, dbg = D.__debug();
    let solid = null;
    const pvs = dbg.pivots ? Object.keys(dbg.pivots).map(k => dbg.pivots[k]) : [dbg.pivot];
    pvs.forEach(pv => pv && pv.traverse(o => {
      if (!solid && o.userData && o.userData.mdPart === 'solid') solid = o;
    }));
    const m = Array.isArray(solid.material) ? solid.material[0] : solid.material;
    const dir = (dbg.lights || []).filter(l => l.isDirectionalLight);
    const amb = (dbg.lights || []).filter(l => l.isAmbientLight);
    const base = '#' + m.color.getHexString();
    V.set('backface', false);
    const sideFront = m.side;
    V.set('backface', true);
    const sideDouble = m.side;
    V.set('material', false);
    const colorClay = '#' + m.color.getHexString();
    V.set('material', true);
    const colorBack = '#' + m.color.getHexString();
    V.set('texture', false);
    const mapOff = m.map === null;
    V.set('texture', true);
    V.set('lighting', false);
    const dirOff = dir.map(l => l.intensity);
    const ambOff = amb.map(l => l.intensity === l.userData.mdBaseIntensity);
    V.set('lighting', true);
    const dirOn = dir.map(l => l.intensity);
    return { base, sideFront, sideDouble, colorClay, colorBack, mapOff, dirOff, ambOff, dirOn };
  });
  check(flagsLive.sideFront === 0 && flagsLive.sideDouble === 2,
    '背面开关：FrontSide ⇄ DoubleSide 真的写进材质', JSON.stringify({ front: flagsLive.sideFront, double: flagsLive.sideDouble }));
  check(flagsLive.colorClay === '#c9ccd4' && flagsLive.colorBack === flagsLive.base,
    '材质开关：关=素模灰 / 开=材质本色', JSON.stringify({ clay: flagsLive.colorClay, base: flagsLive.colorBack }));
  check(flagsLive.mapOff === true,
    '纹理开关：无贴图时置 null（有贴图时按留底还原）', 'map=null');
  check(flagsLive.dirOff.every(x => x === 0) && flagsLive.ambOff.every(Boolean) && flagsLive.dirOn.join(',') === '0.85,0.26,0.19',
    '光照开关：关=方向光归零且环境光保留 / 开=恢复出厂强度',
    JSON.stringify({ off: flagsLive.dirOff, amb: flagsLive.ambOff, on: flagsLive.dirOn }));

  /* 8c) A3：UI 吸附开关与服务/手柄同一份状态 */
  const snapUi = await p.evaluate(() => {
    const D = window.modelDesk, S = window.SeedSnap;
    const before = D.getState().snap;
    document.querySelector('[data-md-act="snap"]').click();
    const after = D.getState();
    return { before, after: after.snap, enabled: S.getPrefs().enabled, gizmoSnap: D.__debug().gizmo.snap };
  });
  check(snapUi.before === false && snapUi.after === true && snapUi.enabled === true && snapUi.gizmoSnap === true,
    '吸附开关：UI → SeedSnap.enabled → 手柄，一份状态', JSON.stringify(snapUi));

  /* 9) 命令表 when 谓词：没有文档时灰显 */
  const whenTest = await p.evaluate(() => {
    const C = window.SeedCommands;
    return {
      withDoc: C.available('tool.inflate', {}),
      noDoc: C.run('tool.inflate', {})
    };
  });
  check(whenTest.withDoc === true, 'when 谓词：有文档 → 可用', 'avail=' + whenTest.withDoc);

  /* 10) 页面无错 */
  check(errors.length === 0, '打开与操作期间无 pageerror', errors.slice(0, 3).join(' | '));

  await b.close();

  const pass = checks.filter(c => c.ok).length;
  const fail = checks.length - pass;
  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过') + '（' + pass + '/' + checks.length + '）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
