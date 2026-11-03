/* 探针：建模 App 真跑到哪一步（不改代码，只读+模拟操作）
 * 用法：node tools/probe-modeldesk.js
 *
 * 为什么要它：里程碑表是按「交付物」写的，但完成度必须看**实际能点出什么**。
 * 这里把窗口打开、数一遍可点控件与占位控件、逐项点过去，并把 state 打出来。
 * 输出重定向到文件再读（| tail 会吞退出码）。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const info = (name, extra) => console.log(' ·· ' + name + (extra ? ' · ' + extra : ''));

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  /* 1. 从桌面入口打开（走真实路径：翻页 + 骨架 + 模块 open） */
  const opened = await page.evaluate(() => {
    if (typeof window.openDeskApp !== 'function') return 'no openDeskApp';
    window.openDeskApp('modeldesk');
    return 'ok';
  });
  check(opened === 'ok', '桌面入口 openDeskApp("modeldesk") 可调用', opened);
  await page.waitForTimeout(2600);

  const st0 = await page.evaluate(() => window.modelDesk && window.modelDesk.getState());
  check(!!(st0 && st0.hasDoc), '打开后有文档', st0 ? JSON.stringify({ v: st0.vertices, f: st0.faces, e: st0.edges }) : 'null');

  /* 2. 视口是否真在渲染（拿 renderer.info，不信截图） */
  const gpu = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const i = d.renderer && d.renderer.info;
    return {
      tris: i ? i.render.triangles : -1,
      calls: i ? i.render.calls : -1,
      cw: d.stage ? d.stage.clientWidth : 0,
      ch: d.stage ? d.stage.clientHeight : 0,
      grid: !!(d.scene && d.scene.children.find(o => o.type === 'GridHelper')),
      overlayEdges: !!d.edgeLines,
      overlayVerts: !!d.vertPoints,
      gizmoVisible: !!(d.gizmo && d.gizmo.group && d.gizmo.group.visible)
    };
  });
  check(gpu.cw > 400 && gpu.ch > 300, '视口尺寸正常', gpu.cw + '×' + gpu.ch);
  check(gpu.tris > 0 && gpu.calls > 0, 'WebGL 每帧有绘制', 'tri=' + gpu.tris + ' calls=' + gpu.calls);
  check(gpu.overlayEdges && gpu.overlayVerts, '拓扑边线 / 顶点叠加层已建', '');
  info('栅格 / 手柄', JSON.stringify({ grid: gpu.grid, gizmo: gpu.gizmoVisible }));

  /* 2.5 V1 渲染校准：色调映射真开、标签与渲染器一致、像素不过曝、三个可见面有明暗差 */
  const tone = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const THREE = window.THREE;
    const s = window.modelDesk.getState();
    const gl = d.renderer.getContext();
    d.renderer.render(d.scene, d.camera);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const L = (x, y) => {
      const i = ((h - 1 - y) * w + x) * 4;
      return Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    };
    const at = v => {
      const q = v.clone().project(d.camera);
      return L(Math.round((q.x * 0.5 + 0.5) * w), Math.round((-q.y * 0.5 + 0.5) * h));
    };
    /* 三个可见面的采样点要避开手柄（手柄正好压在模型中心） */
    const faces = {
      top: at(new THREE.Vector3(0.22, 0.5, 0.18)),
      front: at(new THREE.Vector3(-0.25, -0.22, 0.5)),
      right: at(new THREE.Vector3(0.5, -0.22, 0.18))
    };
    let max = 0, clip = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      if (l > max) max = l;
      if (l > 250) clip++;
      n++;
    }
    /* 边线对比度：沿正面上沿取 6 个点，在 ±3px 内找最暗像素，与面亮度相减。
     * 1px 线有 MSAA 混合，不能用「绝对够黑」判，只能用「比面暗多少」。 */
    const a = new THREE.Vector3(-0.5, 0.5, 0.5).project(d.camera);
    const b2 = new THREE.Vector3(0.5, 0.5, 0.5).project(d.camera);
    const ax = Math.round((a.x * 0.5 + 0.5) * w), ay = Math.round((-a.y * 0.5 + 0.5) * h);
    const bx = Math.round((b2.x * 0.5 + 0.5) * w), by = Math.round((-b2.y * 0.5 + 0.5) * h);
    const contrasts = [];
    for (let t = 0.2; t <= 0.71; t += 0.1) {
      const x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t);
      let minL = 255;
      for (let dy = -3; dy <= 3; dy++) minL = Math.min(minL, L(x, y + dy));
      contrasts.push(L(x, y + 6) - minL);
    }
    return {
      toneMapping: s.toneMapping, exposure: s.exposure,
      label: (document.querySelector('.md-vpstyle') || {}).textContent || '',
      expRead: (document.querySelectorAll('.md-vpnum .md-numb')[1] || {}).textContent || '',
      faces, max: Math.round(max), clipPct: +(clip / n * 100).toFixed(2),
      edgeContrast: Math.round(contrasts.reduce((x, y) => x + y, 0) / contrasts.length),
      faceSpread: Math.max(faces.top, faces.front, faces.right) - Math.min(faces.top, faces.front, faces.right)
    };
  });
  check(tone.toneMapping !== 0, '色调映射真的开了（不是 NoToneMapping）', 'toneMapping=' + tone.toneMapping);
  check(/ACES/.test(tone.label) && tone.expRead === tone.exposure.toFixed(2),
    '视口标签与实际渲染器一致', 'label="' + tone.label + '" 曝光读数=' + tone.expRead);
  check(tone.max <= 240 && tone.clipPct < 0.2, '面片不再过曝到纯白',
    '峰值=' + tone.max + '/255 过曝像素=' + tone.clipPct + '%');
  check(tone.faceSpread >= 30, '三个可见面有明暗差（不是一块白板）',
    '顶' + tone.faces.top + ' / 前' + tone.faces.front + ' / 右' + tone.faces.right + '，差 ' + tone.faceSpread);
  check(tone.edgeContrast >= 60, '边线压得住亮面（对比度）', '平均对比 ' + tone.edgeContrast + ' 级');

  /* 2.6 V2 顶点两层（白面上也能看见） */
  const verts = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const THREE = window.THREE;
    const g = d.pivot && d.pivot.getObjectByName('topology-vertices');
    const gl = d.renderer.getContext();
    d.renderer.render(d.scene, d.camera);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const L = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const i = ((h - 1 - y) * w + x) * 4;
      return Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    };
    /* 取一个立方体顶点，看它周围有没有「深环 + 亮芯」两种像素 */
    const q = new THREE.Vector3(0.5, 0.5, 0.5).project(d.camera);
    const cx = Math.round((q.x * 0.5 + 0.5) * w), cy = Math.round((-q.y * 0.5 + 0.5) * h);
    let dark = 0, bright = 0;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const l = L(cx + dx, cy + dy);
        if (l == null) continue;
        if (l < 120) dark++;
        if (l > 200) bright++;
      }
    }
    return {
      layers: g ? g.children.length : 0,
      colors: g ? g.children.map(c => c.material.color.getHexString()) : [],
      darkPx: dark, brightPx: bright
    };
  });
  check(verts.layers === 2 && verts.colors[0] !== verts.colors[1],
    '顶点是「深底盘 + 浅芯」两层', JSON.stringify({ layers: verts.layers, colors: verts.colors }));
  check(verts.darkPx > 8 && verts.brightPx > 4, '顶点在白面上可辨（深环 + 亮芯都在）',
    '深 ' + verts.darkPx + ' px / 亮 ' + verts.brightPx + ' px');


  /* 3. 控件盘点：可点 vs 占位 */
  const inv = await page.evaluate(() => {
    const host = document.getElementById('modelDeskHost');
    const q = s => Array.from(host.querySelectorAll(s));
    const acts = q('[data-md-act]');
    const spanTitle = q('span[title]');
    const placeholder = spanTitle.filter(s => /接入/.test(s.getAttribute('title') || ''));
    const buttons = Array.from(host.querySelectorAll('button'));
    const disabledBtns = buttons.filter(b => b.disabled);
    return {
      hostNodes: host.querySelectorAll('*').length,
      acts: acts.map(b => b.dataset.mdAct),
      modes: q('[data-md-mode]').length,
      tabs: q('[data-md-tab]').map(b => b.dataset.mdTab),
      menuBtns: q('[data-md-menu]').length,
      buttons: buttons.length,
      disabled: disabledBtns.length,
      disabledText: disabledBtns.map(b => (b.textContent || '').trim()).slice(0, 12),
      spansWithTitle: spanTitle.length,
      placeholderSpans: placeholder.length,
      placeholderSample: placeholder.slice(0, 8).map(s => (s.getAttribute('title') || '').trim()),
      inputs: q('input').map(i => i.id || i.dataset.mdGlobal || ''),
      region: ['md-menu', 'md-toolbar', 'md-shelf', 'md-strip', 'md-outline', 'md-stage', 'md-right', 'md-dock', 'md-cmdrow'].map(c => ({
        c, n: host.querySelectorAll('.' + c).length, h: (host.querySelector('.' + c) || {}).clientHeight || 0
      }))
    };
  });
  info('DOM 节点数', String(inv.hostNodes));
  info('可点命令(data-md-act)', inv.acts.join(','));
  info('按钮 / 禁用', inv.buttons + ' / ' + inv.disabled + (inv.disabledText.length ? ' → ' + inv.disabledText.join('|') : ''));
  info('占位 span(title 含"接入")', inv.placeholderSpans + ' / 带 title span ' + inv.spansWithTitle);
  info('占位样例', inv.placeholderSample.join(' ; '));
  info('输入框', inv.inputs.join(','));
  info('区域高度', inv.region.map(r => r.c + ':' + r.h).join(' '));
  check(inv.region.every(r => r.n === 1), '八大区域各存在一份', '');

  /* 4. 着色三态 */
  const shade = await page.evaluate(async () => {
    const sel = document.getElementById('mdShadeSel');
    const out = [];
    for (const v of ['shaded', 'wire', 'shaded-wire']) {
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
      const d = window.modelDesk.__debug();
      const solid = [];
      d.pivot && d.pivot.traverse(o => { if (o.userData && o.userData.mdPart === 'solid') solid.push(o.visible); });
      out.push({ v, state: window.modelDesk.getState().shading, solid: solid[0], edge: d.edgeLines ? d.edgeLines.visible : null });
    }
    return out;
  });
  check(shade.every(x => x.state === x.v), '着色下拉三态切换写入 state', shade.map(x => x.state).join('>'));
  check(shade[0].solid === true && shade[0].edge === false, '实体模式隐藏边线', JSON.stringify(shade[0]));
  check(shade[1].solid === false && shade[1].edge === true, '线框模式隐藏面、显示边', JSON.stringify(shade[1]));

  /* 5. 栅格按钮 */
  const grid = await page.evaluate(async () => {
    const before = window.modelDesk.__debug().scene.children.find(o => o.type === 'GridHelper').visible;
    document.querySelector('[data-md-act="grid"]').click();
    await new Promise(r => requestAnimationFrame(r));
    const after = window.modelDesk.__debug().scene.children.find(o => o.type === 'GridHelper').visible;
    document.querySelector('[data-md-act="grid"]').click();
    return { before, after };
  });
  check(grid.before === true && grid.after === false, '栅格按钮真的切 GridHelper.visible', JSON.stringify(grid));

  /* 6. 四视图 */
  const quad = await page.evaluate(async () => {
    document.querySelector('[data-md-act="quad"]').click();
    await new Promise(r => setTimeout(r, 260));
    const d = window.modelDesk.__debug();
    const s = window.modelDesk.getState();
    const out = {
      quad: s.quad, cls: d.stage.classList.contains('quad'),
      ctrl: d.controls ? d.controls.enabled : null,
      gizmo: d.gizmo && d.gizmo.group ? d.gizmo.group.visible : null,
      tris: d.renderer.info.render.triangles
    };
    document.querySelector('[data-md-act="quad"]').click();
    await new Promise(r => setTimeout(r, 260));
    return out;
  });
  check(quad.quad === true && quad.cls === true, '四视图开了并对 stage 打 .quad', JSON.stringify(quad));
  check(quad.ctrl === false && quad.gizmo === false, '四视图下禁用单视图导航与手柄', 'ctrl=' + quad.ctrl + ' gizmo=' + quad.gizmo);
  check(quad.tris > 0, '四视图仍在出图', 'tri=' + quad.tris);

  /* 7. ViewCube（真 3D 立方体）：点面切视图 + 朝向跟随主相机 */
  const cube = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const c = d.cube;
    if (!c) return { view: '', err: 'cube 未初始化' };
    const T = window.THREE;
    const r = c.canvas.getBoundingClientRect();
    /* 「前」面中心 = 立方体局部 +Z 半边长 0.75，投影回屏幕就是这一面的位置 */
    const p = new T.Vector3(0, 0, 0.75).applyQuaternion(c.group.quaternion).project(c.cam);
    const x = r.left + (p.x * 0.5 + 0.5) * r.width;
    const y = r.top + (-p.y * 0.5 + 0.5) * r.height;
    const send = (type) => c.canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y
    }));
    send('pointerdown'); send('pointerup');
    await new Promise(res => setTimeout(res, 520));
    return { view: window.modelDesk.getState().viewName, size: c.canvas.clientWidth };
  });
  check(cube.size > 0 && cube.view === '前视图', 'ViewCube 点面切正视图', JSON.stringify(cube));

  /* 7.2 立体跟随：拖立方体 → 相机绕模型转，立方体朝向同步反着转 */
  const cubeSync = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const c = d.cube;
    const q0 = c.group.quaternion.clone();
    const r = c.canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const send = (type, x) => c.canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 2, clientX: x, clientY: cy
    }));
    send('pointerdown', cx);
    for (let i = 1; i <= 5; i++) send('pointermove', cx + i * 8);
    send('pointerup', cx + 40);
    await new Promise(res => setTimeout(res, 240));
    return { dq: q0.angleTo(c.group.quaternion), view: window.modelDesk.getState().viewName };
  });
  check(cubeSync.dq > 0.05 && cubeSync.view === '自由', 'ViewCube 随相机同步旋转', JSON.stringify(cubeSync));

  /* 7.5 Alt 导航门控：**不发 keydown**，只让指针事件带 altKey。
   * 真实浏览器里第一次按 Alt 常被窗口菜单吃掉 keydown，旧实现会「第一次拖拽无效」。 */
  const altState = await (async () => {
    const cdp = await page.context().newCDPSession(page);
    const base = await page.evaluate(() => {
      const b = window.modelDesk.__debug();
      b.controls.enableDamping = false;
      const q = b.canvas.getBoundingClientRect();
      return { x: q.left + q.width / 2, y: q.top + q.height / 2, x0: b.camera.position.x };
    });
    const drag = async (mods) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y, modifiers: mods });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: base.x, y: base.y, button: 'left', buttons: 1, clickCount: 1, modifiers: mods });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x + i * 12, y: base.y, button: 'left', buttons: 1, modifiers: mods });
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: base.x + 96, y: base.y, button: 'left', buttons: 0, clickCount: 1, modifiers: mods });
      await page.waitForTimeout(140);
      return page.evaluate(() => window.modelDesk.__debug().camera.position.x);
    };
    const afterAlt = await drag(1);       // 1 = Alt
    const afterPlain = await drag(0);
    await page.evaluate(() => { window.modelDesk.__debug().controls.enableDamping = true; });
    /* 回轴测，后面的取景与拾取断言都依赖这个视角 */
    await page.evaluate(() => document.getElementById('mdCube').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await page.waitForTimeout(200);
    return { x0: base.x0, afterAlt, afterPlain };
  })();
  check(Math.abs(altState.afterAlt - altState.x0) > 0.2,
    'Alt 拖拽第一次就生效（不依赖 keydown）', altState.x0.toFixed(2) + ' → ' + altState.afterAlt.toFixed(2));
  check(Math.abs(altState.afterPlain - altState.afterAlt) < 0.01,
    '不按 Alt 的拖拽不会转相机', altState.afterAlt.toFixed(2) + ' → ' + altState.afterPlain.toFixed(2));

  /* 8. 变换手柄拖动（真拖，看文档与历史） */
  const dragInfo = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const THREE = window.THREE;
    const cam = d.camera, pivot = d.pivot;
    const box = new THREE.Box3().setFromObject(pivot);
    const c = box.getCenter(new THREE.Vector3());
    const dist = cam.position.distanceTo(c);
    const unit = Math.max(0.02, dist * 0.18);
    const p0 = c.clone().project(cam);
    const p1 = c.clone().add(new THREE.Vector3(unit * 0.55, 0, 0)).project(cam);
    const r = d.stage.getBoundingClientRect();
    const toXY = p => ({ x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height });
    return { a: toXY(p0), b: toXY(p1), pos: pivot.position.toArray(), undo: window.modelDesk.getState().undo };
  });
  await page.mouse.move(dragInfo.b.x, dragInfo.b.y);
  await page.mouse.down();
  await page.mouse.move(dragInfo.b.x + 90, dragInfo.b.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterDrag = await page.evaluate(() => ({
    pos: window.modelDesk.getDocument().nodes[0].transform.position,
    undo: window.modelDesk.getState().undo
  }));
  const moved = Math.abs(afterDrag.pos[0] - dragInfo.pos[0]) > 1e-4;
  check(moved, '拖 X 手柄能改文档里的位置', dragInfo.pos.map(n => n.toFixed(2)) + ' → ' + afterDrag.pos.map(n => n.toFixed(2)));
  check(afterDrag.undo === dragInfo.undo + 1, '一次拖动只进一条历史', dragInfo.undo + ' → ' + afterDrag.undo);

  /* 8.5 V3 历史认网格：换一份网格 → 一次历史 → 撤销能换回去，且只多存这一版 */
  const mv = await page.evaluate(() => {
    const M = window.SeedModel.Mesh;
    const before = window.modelDesk.getState();
    const moved = M.clone(window.modelDesk.__debug().mesh);
    M.translate(moved, 0.1, 0, 0);
    M.bump(moved);
    const ok = window.modelDesk.applyMesh(moved, '探针移动网格');
    const mid = window.modelDesk.getState();
    window.modelDesk.undo();
    const back = window.modelDesk.getState();
    window.modelDesk.redo();
    const again = window.modelDesk.getState();
    window.modelDesk.undo();
    const settled = window.modelDesk.getState();
    return {
      ok,
      beforeHash: before.meshHash, movedHash: mid.meshHash,
      backHash: back.meshHash, againHash: again.meshHash, settledHash: settled.meshHash,
      statesBefore: before.meshStates, statesAfter: mid.meshStates,
      undoBefore: before.undo, undoAfter: mid.undo,
      bytesBefore: before.historyBytes, bytesAfter: mid.historyBytes
    };
  });
  check(mv.ok === true && mv.undoAfter === mv.undoBefore + 1,
    '换网格算一次历史（以前会被 editKey 判成没变化）', 'undo ' + mv.undoBefore + ' → ' + mv.undoAfter);
  check(mv.movedHash !== mv.beforeHash, '网格指纹随内容变化', mv.beforeHash + ' → ' + mv.movedHash);
  check(mv.backHash === mv.beforeHash, '撤销真的换回旧网格', mv.backHash === mv.beforeHash ? '与 before 一致' : '不一致：' + mv.backHash);
  check(mv.againHash === mv.movedHash, '重做回到新网格', mv.againHash === mv.movedHash ? '与 after 一致' : '不一致');
  check(mv.settledHash === mv.beforeHash, '再撤销又回到旧网格（可反复）', mv.settledHash === mv.beforeHash ? 'ok' : 'drift');
  check(mv.statesAfter === mv.statesBefore + 1,
    '只多存一版网格（未改网格的历史不复制）', mv.statesBefore + ' → ' + mv.statesAfter + ' 版');
  check(mv.bytesAfter > mv.bytesBefore, '字节数按真实副本增长', mv.bytesBefore + ' → ' + mv.bytesAfter + ' B');

  /* 9. 属性编辑器改名 + 撤销 */  const ren = await page.evaluate(async () => {
    const el = document.querySelector('[data-md-global="name"]');
    if (!el) return { ok: false };
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    el.value = '探针改名';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const named = window.modelDesk.getDocument().name;
    const undoN = window.modelDesk.getState().undo;
    window.modelDesk.undo();
    await new Promise(r => setTimeout(r, 60));
    return { ok: true, named, afterUndo: window.modelDesk.getDocument().name, undoN };
  });
  check(ren.named === '探针改名', '属性编辑器改名写进文档', JSON.stringify(ren));
  check(ren.afterUndo === '立方体', '撤销能还原名称', String(ren.afterUndo));

  /* 10. 大纲搜索 */
  const search = await page.evaluate(async () => {
    const el = document.getElementById('mdOutlineSearch');
    const total = document.querySelectorAll('#mdOutlineList .md-part-row').length;
    el.value = 'persp';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const filtered = document.querySelectorAll('#mdOutlineList .md-part-row').length;
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { total, filtered, restored: document.querySelectorAll('#mdOutlineList .md-part-row').length };
  });
  check(search.filtered === 1 && search.restored === search.total, '大纲按名称过滤并可恢复', JSON.stringify(search));

  /* 11. 快捷键层（S4）：W/E/R 生效，且输入框里打字不会误触 */
  const keys = await page.evaluate(async () => {
    const press = (k, target) => (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const mode = () => window.modelDesk.getState().gizmoMode;
    const out = { start: mode() };
    press('e'); out.afterE = mode();
    press('r'); out.afterR = mode();
    press('w'); out.afterW = mode();
    press('k'); out.afterK = window.modelDesk.getState().tool;
    press('q'); out.afterQ = window.modelDesk.getState().tool;
    const inp = document.querySelector('[data-md-global="name"]');
    inp.focus(); press('e', inp); out.typingGuard = mode();
    inp.blur();
    out.backticks = (() => { press('`'); const a = document.activeElement; return a && a.id; })();
    return out;
  });
  check(keys.afterE === 'rotate' && keys.afterR === 'scale' && keys.afterW === 'translate',
    'W / E / R 真的切工具', JSON.stringify(keys));
  check(keys.typingGuard === 'translate', '在输入框里按 E 不会误切工具', keys.typingGuard);
  check(keys.afterK === 'knife' && keys.afterQ === 'select',
    'K 切多切割、Q 回选择工具', JSON.stringify({ k: keys.afterK, q: keys.afterQ }));
  check(keys.backticks === 'mdCmd', '反引号聚焦命令行', String(keys.backticks));

  /* 11.5 S1 拾取：点 / 边 / 面 + 加选 + 清空 + 遮挡剔除
   * 拾取前先把手柄摘掉：否则屏幕上的箭头会吃掉点击，测到的就不是拾取内核了。 */
  /* 先回到轴测视图并释放焦点：前视图下顶面是边缘朝向的，点不到；
   * 焦点还在命令行里的话，F9–F11 会被输入守卫挡住（这是设计，不是 bug）。 */
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const c = document.getElementById('mdCube');
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForTimeout(260);
  const pick = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    const r = d.canvas.getBoundingClientRect();
    const proj = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(d.pivot.matrixWorld).project(d.camera);
      return { cx: r.left + (v.x * 0.5 + 0.5) * r.width, cy: r.top + (-v.y * 0.5 + 0.5) * r.height };
    };
    d.gizmo.setTarget(null);
    return {
      v0: proj(0.5, 0.5, 0.5), v1: proj(-0.5, 0.5, 0.5),
      hidden: proj(-0.5, -0.5, -0.5),
      f1: proj(0.2, 0.2, 0.5), f2: proj(0.32, 0.5, 0.32),
      empty: { cx: r.left + 8, cy: r.top + 8 }
    };
  });
  await page.keyboard.press('F9');
  await page.mouse.click(pick.v0.cx, pick.v0.cy);
  const sel1 = await page.evaluate(() => ({ s: window.modelDesk.getState(), doc: window.modelDesk.getDocument().selection }));
  check(sel1.s.selMode === 'vertex' && sel1.s.selVertex === 1 && sel1.doc.vertexIds.length === 1,
    '顶点模式点中 1 个顶点（并写进文档选择集）', JSON.stringify({ mode: sel1.doc.mode, ids: sel1.doc.vertexIds }));
  check(sel1.s.selHighlight === true, '高亮对象真的生成了', String(sel1.s.selHighlight));

  await page.keyboard.down('Shift');
  await page.mouse.click(pick.v1.cx, pick.v1.cy);
  await page.keyboard.up('Shift');
  const sel2 = await page.evaluate(() => window.modelDesk.getState().selVertex);
  check(sel2 === 2, 'Shift 加选到 2 个', String(sel2));

  await page.mouse.click(pick.empty.cx, pick.empty.cy);
  const sel3 = await page.evaluate(() => window.modelDesk.getState().selVertex);
  check(sel3 === 0, '点空白清空选择', String(sel3));

  await page.keyboard.press('F11');
  await page.mouse.click(pick.f1.cx, pick.f1.cy);
  await page.keyboard.down('Shift');
  await page.mouse.click(pick.f2.cx, pick.f2.cy);
  await page.keyboard.up('Shift');
  const sel4 = await page.evaluate(() => ({ s: window.modelDesk.getState(), doc: window.modelDesk.getDocument().selection }));
  check(sel4.s.selFace === 2 && sel4.doc.faceIds.length === 2,
    '面模式命中两个面（存的是文档面 ID，不是三角形下标）', JSON.stringify(sel4.doc.faceIds));

  /* S2b/B4：换模式按包含关系转换（两个相邻四边形的并集 = 6 个顶点） */
  await page.keyboard.press('F9');
  const conv1 = await page.evaluate(() => ({ s: window.modelDesk.getState(), doc: window.modelDesk.getDocument().selection }));
  check(conv1.s.selMode === 'vertex' && conv1.s.selVertex === 6 && conv1.doc.vertexIds.length === 6,
    '换模式不清空：面→顶点按包含关系转换', JSON.stringify({ mode: conv1.doc.mode, n: conv1.doc.vertexIds.length }));
  await page.keyboard.press('F11');
  const conv2 = await page.evaluate(() => ({ s: window.modelDesk.getState(), doc: window.modelDesk.getDocument().selection }));
  check(conv2.s.selMode === 'face' && conv2.s.selFace === 2,
    '顶点→面往返回到同一组面（少选一个点的面被丢弃）', JSON.stringify({ mode: conv2.doc.mode, n: conv2.doc.faceIds.length }));

  /* 面 = 多边形：被选中的面必须是 4 个角（导入时把三角对合并回了四边形） */
  const polyInfo = await page.evaluate(() => {
    const m = window.modelDesk.__debug().mesh;
    const ids = window.modelDesk.getDocument().selection.faceIds;
    const byId = {};
    for (let f = 0; f < m.faceIds.length; f++) byId[m.faceIds[f]] = m.faceOffsets[f + 1] - m.faceOffsets[f];
    return { corners: ids.map(function (id) { return byId[id] || 0; }), total: m.faceIds.length };
  });
  check(polyInfo.corners.length === 2 && polyInfo.corners.every(function (n) { return n === 4; }),
    '选中的面是四边形（多边形），不是三角面',
    '角数 ' + JSON.stringify(polyInfo.corners) + ' · 网格共 ' + polyInfo.total + ' 面');

  await page.keyboard.press('F9');
  await page.mouse.click(pick.hidden.cx, pick.hidden.cy);
  const sel5 = await page.evaluate(() => window.modelDesk.getState().selVertex);
  check(sel5 === 0, '背面的顶点点不到（遮挡剔除生效）', String(sel5));

  await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    d.gizmo.setTarget(d.pivot);
    window.modelDesk.getDocument().selection = { mode: 'object', nodeIds: [], vertexIds: [], edgeIds: [], faceIds: [] };
  });
  await page.keyboard.press('F8');

  /* 11.55 UV 岛：UV 数据、岛划分、点选整岛、落盘、老文件兼容 */
  const uvInfo = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), M = window.SeedModel.Mesh, S = window.SeedModel.Scene;
    const m = d.mesh;
    const isl = M.uvIslands(m);
    const json = S.toSeedModel(window.modelDesk.getDocument());
    const back = M.fromJSON(json.meshes.main);
    const legacy = JSON.parse(JSON.stringify(json.meshes.main));
    delete legacy.uvs;                       /* 老文件没有 UV 字段 */
    const old = M.fromJSON(legacy);
    const legacyHadUV = M.hasUV(old);
    M.ensureUV(old);
    return {
      hasUV: M.hasUV(m), corners: m.faceIndices.length * 2, uvLen: m.uvs.length,
      islands: isl.islands.length, sizes: isl.islands.map(function (i) { return i.faces.length; }),
      savedUV: M.hasUV(back), savedLen: back.uvs.length,
      legacyHadUV: legacyHadUV, legacyIslands: M.uvIslands(old).islands.length
    };
  });
  check(uvInfo.hasUV && uvInfo.uvLen === uvInfo.corners, '网格带 face-varying UV',
    uvInfo.uvLen + ' / ' + uvInfo.corners + ' 个面角');
  check(uvInfo.islands === 6 && uvInfo.sizes.every(function (n) { return n === 1; }),
    '立方体 6 个四边形面，每个面自成一个 UV 岛', JSON.stringify(uvInfo.sizes));
  check(uvInfo.savedUV && uvInfo.savedLen === uvInfo.corners, 'UV 跟着文档落盘',
    '读回 ' + uvInfo.savedLen + ' 个值');
  check(uvInfo.legacyHadUV === false && uvInfo.legacyIslands === 6,
    '老文件没有 UV → 盒式投影兜底，仍是 6 个岛', '老文件 UV=' + uvInfo.legacyHadUV + ' 岛=' + uvInfo.legacyIslands);

  const ip = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    const r = d.canvas.getBoundingClientRect();
    const proj = function (x, y, z) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(d.pivot.matrixWorld).project(d.camera);
      return { cx: r.left + (v.x * 0.5 + 0.5) * r.width, cy: r.top + (-v.y * 0.5 + 0.5) * r.height };
    };
    d.gizmo.setTarget(null);
    return { a: proj(0.2, 0.2, 0.5), b: proj(0.3, 0.5, 0.3) };
  });
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('F12');
  await page.mouse.click(ip.a.cx, ip.a.cy);
  const isl1 = await page.evaluate(() => ({
    s: window.modelDesk.getState(), doc: window.modelDesk.getDocument().selection
  }));
  check(isl1.s.selMode === 'island' && isl1.s.selFace === 1 && isl1.doc.mode === 'island' && isl1.s.selHighlight,
    'F12 岛模式点一个面选中整个岛（1 个四边形）',
    JSON.stringify({ faces: isl1.s.selFace, docMode: isl1.doc.mode }));

  await page.keyboard.down('Shift');
  await page.mouse.click(ip.b.cx, ip.b.cy);
  await page.keyboard.up('Shift');
  const isl2 = await page.evaluate(() => window.modelDesk.getState().selFace);
  check(isl2 === 2, 'Shift 加选另一个岛 → 2 个面', String(isl2));

  await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    d.gizmo.setTarget(d.pivot);
    window.modelDesk.getDocument().selection = { mode: 'object', nodeIds: [], vertexIds: [], edgeIds: [], faceIds: [] };
  });
  await page.keyboard.press('F8');

  /* 11.555 热盒（按住空格）+ 对象级编辑（复制 / 删除 / 隐藏） */
  await page.mouse.move(700, 430);
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.down(' ');
  await page.waitForTimeout(180);
  const readHb = () => page.evaluate(() => {
    const box = document.getElementById('mdHotbox');
    return {
      on: box.classList.contains('on'),
      mode: window.modelDesk.getState().selMode,
      zones: Array.from(box.querySelectorAll('.md-hb-zone')).map(function (z) {
        return {
          t: z.querySelector('b').textContent,
          items: Array.from(z.querySelectorAll('.md-hb-run')).map(function (b) {
            var row = b.parentNode;
            return b.querySelector('span').textContent + (row && row.classList.contains('off') ? '·占位' : '');
          })
        };
      }),
      core: (box.querySelector('.md-hb-core') || {}).textContent || ''
    };
  });
  const hbRows = await page.evaluate(() => {
    const box = document.getElementById('mdHotbox');
    return {
      rows: box.querySelectorAll('.md-hb-row').length,
      icons: box.querySelectorAll('.md-hb-ico svg').length,
      opts: box.querySelectorAll('.md-hb-opt').length
    };
  });
  check(hbRows.rows === 24 && hbRows.icons === 24 && hbRows.opts === 24,
    '每行 = 图标 + 名字 + 右侧方框（24 行一一对应）', JSON.stringify(hbRows));

  const hb = await readHb();
  check(hb.on && hb.zones.length === 4 && hb.zones[1].t === '对象操作',
    '热盒四区：组件模式 / 当前模式操作 / 工具 / 显示（对象模式下右区=对象操作）', JSON.stringify(hb.zones.map(function (z) { return z.t; })));
  check(hb.zones[1].items.indexOf('复制对象') === 0 && hb.zones[1].items.filter(function (x) { return /占位$/.test(x); }).length === 3,
    '对象操作区：3 个真命令 + 3 个占位（分组/父子/隔离）', JSON.stringify(hb.zones[1].items));

  /* 在热盒里点「面」→ 不关热盒，右区应换成「面操作」那一层 */
  const faceHbBtn = await page.$('#mdHotbox [data-hb="n:3"]');
  const fhb = await faceHbBtn.boundingBox();
  await page.mouse.click(fhb.x + fhb.width / 2, fhb.y + fhb.height / 2);
  await page.waitForTimeout(220);
  const hbFace = await readHb();
  check(hbFace.on && hbFace.mode === 'face' && hbFace.zones[1].t === '面操作' &&
    hbFace.zones[1].items.indexOf('挤出') > 0 && hbFace.zones[1].items.indexOf('内插') > 0,
    '点「面」后热盒不关，右区自动换成「面操作」层（挤出/内插/删除面已接入）', JSON.stringify(hbFace.zones[1]));
  check(hbFace.zones[0].items.join(',') === '对象,顶点,边,面,UV 岛',
    '切层后组件模式区仍在（可继续换模式）', JSON.stringify(hbFace.zones[0].items));

  /* 回对象模式再测悬停执行 / 占位 */
  const objHbBtn = await page.$('#mdHotbox [data-hb="n:0"]');
  const ohb = await objHbBtn.boundingBox();
  await page.mouse.click(ohb.x + ohb.width / 2, ohb.y + ohb.height / 2);
  await page.waitForTimeout(200);

  /* 悬停「线框」后松开空格 → 应该执行 */
  const wireBtn = await page.$('#mdHotbox [data-hb="w:2"]');
  const wb2 = await wireBtn.boundingBox();
  await page.mouse.move(wb2.x + wb2.width / 2, wb2.y + wb2.height / 2);
  await page.waitForTimeout(60);
  await page.keyboard.up(' ');
  await page.waitForTimeout(150);
  const shadeAfterHb = await page.evaluate(() => window.modelDesk.getState().shading);
  check(shadeAfterHb === 'wire', '热盒悬停「线框」后松手即执行', shadeAfterHb);
  await page.evaluate(() => { const s = document.getElementById('mdShadeSel'); s.value = 'shaded-wire'; s.dispatchEvent(new Event('change', { bubbles: true })); });

  /* 占位项：点了只说明，不改文档 */
  await page.keyboard.down(' ');
  await page.waitForTimeout(150);
  const stubBtn = await page.$('#mdHotbox [data-hb="e:3"]');
  const sb2 = await stubBtn.boundingBox();
  await page.mouse.click(sb2.x + sb2.width / 2, sb2.y + sb2.height / 2);
  await page.waitForTimeout(150);
  const stubStatus = await page.evaluate(() => document.getElementById('mdStatus').textContent);
  check(/尚未接入/.test(stubStatus) && /B6/.test(stubStatus),
    '占位项点了只回「尚未接入 + 计划编号」', stubStatus);

  /* 对象编辑：复制 / 删除 / 隐藏 */
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(250);
  const dup = await page.evaluate(() => ({ n: window.modelDesk.getState().nodeCount, m: window.modelDesk.getState().meshCount, names: window.modelDesk.getState().docNodes.map(function (x) { return x.name; }) }));
  check(dup.n === 2 && dup.m === 2, 'Ctrl+D 复制对象（节点与网格都各多一份）', JSON.stringify(dup.names));

  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  const del = await page.evaluate(() => ({ n: window.modelDesk.getState().nodeCount, m: window.modelDesk.getState().meshCount }));
  check(del.n === 1 && del.m === 1, 'Delete 删除对象并回收网格', JSON.stringify(del));

  /* 6.0i 多对象：新建=追加、跨对象点选、最后一个不许删 */
  await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    d.doc.name = '立方体';            // 让 nameIsAuto() 成立，创建后自动改名成「球体」
    return true;
  });
  await page.evaluate(() => { window.modelDesk.createPrimitive(); });
  await page.waitForTimeout(300);
  const multi = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), s = window.modelDesk.getState();
    return {
      n: s.nodeCount, scene: s.sceneObjects,
      names: s.docNodes.map(function (x) { return x.name; }),
      /* 新对象必须是独立网格（复制才是共享 meshRef 的实例） */
      freshMesh: s.docNodes[s.docNodes.length - 1].meshRef !== s.docNodes[0].meshRef,
      activeIdx: s.docNodes.map(function (x) { return x.id; }).indexOf(s.activeNodeId),
      faces: s.faces
    };
  });
  check(multi.n === 2 && multi.scene === 2 && multi.freshMesh &&
    multi.names[0] === '立方体' && multi.activeIdx === 1,
    '新建基础体 = 追加第二个对象（独立网格 + 两个 pivot，激活切到新对象）', JSON.stringify(multi));

  /* 点另一个对象（立方体）→ 激活切换 */
  const otherPt = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    const r = d.canvas.getBoundingClientRect();
    const cube = d.pivots[d.doc.nodes[0].id];
    const v = new THREE.Vector3(0, 0, 0.5).applyMatrix4(cube.matrixWorld).project(d.camera);
    return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height };
  });
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('F8');
  await page.mouse.click(otherPt.x, otherPt.y);
  await page.waitForTimeout(250);
  const pickOther = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { idx: s.docNodes.map(function (x) { return x.id; }).indexOf(s.activeNodeId), faces: s.faces };
  });
  check(pickOther.idx === 0 && pickOther.faces === 6,
    '对象模式点另一个对象 → 切成激活（统计跟着换成 6 面立方体）', JSON.stringify(pickOther));

  /* Delete 删掉的是「球体」（原激活对象），不是被点中的立方体 */
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  const delOne = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { n: s.nodeCount, scene: s.sceneObjects, names: s.docNodes.map(function (x) { return x.name; }) };
  });
  check(delOne.n === 1 && delOne.scene === 1 && delOne.names[0] === '立方体',
    'Delete 后场景真的只剩立方体（渲染层同步回收）', JSON.stringify(delOne));

  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  const delLast = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { n: s.nodeCount, scene: s.sceneObjects, status: s.status };
  });
  check(delLast.n === 1 && delLast.scene === 1 && /最后一个对象/.test(delLast.status),
    '最后一个对象拒绝删除（模型还在 + 状态行说明）', JSON.stringify(delLast));

  /* B2b 大纲层级：行数 = 假节点 + 真节点，点行 = 换激活对象 */
  await page.evaluate(() => window.modelDesk.createPrimitive('sphere'));
  await page.waitForTimeout(350);
  const outTwo = await page.evaluate(() => window.modelDesk.getState().outline);
  check(outTwo.real === 2 && outTwo.fake === 6 && outTwo.rows === 8,
    '大纲两行真节点（+6 行 Maya 默认假节点）', JSON.stringify(outTwo));
  check(outTwo.count === '2 个对象', '大纲角标 = 真节点数', outTwo.count);

  /* 每行面数是「该节点自己的」，不是激活对象的 */
  const outFaces = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#mdOutlineList .md-part-row[data-md-node] em')).map(function (e) {
      return e.textContent.trim();
    });
  });
  const f0 = parseInt(outFaces[0], 10), f1 = parseInt(outFaces[1], 10);
  check(outFaces.length === 2 && f0 === 6 && f1 > 100 && f0 !== f1,
    '每行面数是该节点自己的（立方体 ' + f0 + ' / 球 ' + f1 + '）', JSON.stringify(outFaces));

  /* 点第一行（立方体）→ 激活切过去 */
  const row0id = await page.evaluate(() => {
    return document.querySelector('#mdOutlineList .md-part-row[data-md-node]').getAttribute('data-md-node');
  });
  await page.click('#mdOutlineList .md-part-row[data-md-node="' + row0id + '"]');
  await page.waitForTimeout(250);
  const outPick = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { sel: s.outline.sel, active: s.docNodes.map(function (x) { return x.id; }).indexOf(s.activeNodeId) };
  });
  check(outPick.active === 0 && /立方体/.test(outPick.sel),
    '点大纲第一行 → 激活切到立方体（行高亮跟着走）', JSON.stringify(outPick));

  /* 用 API 切到第二个对象 */
  const outApi = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    const id = s.docNodes[1].id;
    window.modelDesk.selectNodeById(id);
    return { sel: window.modelDesk.getState().outline.sel, active: window.modelDesk.getState().activeNodeId === id };
  });
  check(outApi.active === true, 'selectNodeById 切激活（大纲与视口同一入口）', JSON.stringify(outApi));

  /* 隐藏其中一个 → 行标 off */
  const outHide = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    const id = s.docNodes[1].id;
    window.modelDesk.getDocument().nodes.filter(function (n) { return n.id === id; })[0].visible = false;
    window.modelDesk.selectNodeById(s.docNodes[0].id);
    window.modelDesk.selectNodeById(id);
    return window.modelDesk.getState().outline;
  });
  check(outHide.off === 1, '隐藏的对象在大纲里标 off（压暗 + 划线）', JSON.stringify(outHide));

  /* 清回一个立方体（后面框选/套索/M5 都假设单个立方体、6 面、8 顶点） */
  await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const sphere = doc.nodes.filter(function (n) { return n.name !== '立方体'; })[0];
    if (sphere) window.modelDesk.selectNodeById(sphere.id);
  });
  await page.waitForTimeout(150);
  await page.keyboard.press('Delete');        /* 删掉球体 */
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const cube = doc.nodes[0];
    window.modelDesk.selectNodeById(cube.id);
    cube.visible = true;
    window.modelDesk.reselect();
    window.modelDesk.selectNodeById(cube.id);
  });
  await page.waitForTimeout(150);
  const outBack = await page.evaluate(() => window.modelDesk.getState());
  check(outBack.nodeCount === 1 && outBack.outline.real === 1 && outBack.nodeVisible === true &&
    outBack.docNodes[0].name === '立方体',
    '大纲收回到 1 行真节点（立方体、可见）', JSON.stringify({ o: outBack.outline, v: outBack.nodeVisible, n: outBack.docNodes }));

  await page.keyboard.press('h');
  await page.waitForTimeout(250);
  const hid = await page.evaluate(() => {
    window.modelDesk.reselect();
    return { v: window.modelDesk.getState().nodeVisible, pv: window.modelDesk.__debug().pivot.visible };
  });
  check(hid.v === false && hid.pv === false, 'H 隐藏对象（数据与视口同步）', JSON.stringify(hid));
  await page.keyboard.press('h');
  await page.waitForTimeout(250);
  await page.evaluate(() => window.modelDesk.reselect());

  /* 11.5555 右侧方框 → 参数面板（Maya 的 option box） */
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('F8');
  await page.keyboard.up(' ');
  await page.waitForTimeout(80);
  await page.mouse.move(700, 430);
  await page.keyboard.down(' ');
  await page.waitForTimeout(150);
  const optCopy = await page.$('#mdHotbox [data-opt="e:0"]');
  const oc = await optCopy.boundingBox();
  await page.mouse.click(oc.x + oc.width / 2, oc.y + oc.height / 2);
  await page.waitForTimeout(200);
  const pnlCopy = await page.evaluate(() => {
    const el = document.getElementById('mdHbPanel');
    if (!el) return null;
    return {
      title: el.querySelector('b').textContent,
      fields: Array.from(el.querySelectorAll('.md-hbp-row')).map(function (r) {
        return r.querySelector('span').textContent + '=' + r.querySelector('input').value + (r.querySelector('input').disabled ? '·锁' : '');
      }),
      apply: !el.querySelector('.md-hbp-apply').disabled
    };
  });
  check(pnlCopy && pnlCopy.title === '复制对象' && pnlCopy.fields.length === 2 &&
    pnlCopy.fields[0].indexOf('数量=1') === 0 && pnlCopy.apply,
    '点「复制对象」的方框 → 参数面板（数量 / 偏移 可改）', JSON.stringify(pnlCopy));

  await page.fill('#mdHbPanel [data-hbp="0"]', '2');
  await page.click('#mdHbPanel .md-hbp-apply');
  await page.waitForTimeout(300);
  const dup2 = await page.evaluate(() => window.modelDesk.getState().nodeCount);
  check(dup2 === 3, '面板里填数量 2 → 真的多出两份', '节点数 ' + dup2);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const backToOne = await page.evaluate(() => window.modelDesk.getState().nodeCount);
  check(backToOne === 1, '删回一个对象（收尾）', '节点数 ' + backToOne);

  /* 占位算子的面板：参数灰显 + 应用禁用 + 写明计划编号 */
  await page.keyboard.press('F11');
  await page.keyboard.up(' ');
  await page.waitForTimeout(80);
  await page.mouse.move(700, 430);
  await page.keyboard.down(' ');
  await page.waitForTimeout(180);
  const optEx = await page.$('#mdHotbox [data-opt="e:1"]');
  const oe = await optEx.boundingBox();
  await page.mouse.click(oe.x + oe.width / 2, oe.y + oe.height / 2);
  await page.waitForTimeout(200);
  const pnlEx = await page.evaluate(() => {
    const el = document.getElementById('mdHbPanel');
    if (!el) return null;
    return {
      title: el.querySelector('b').textContent,
      locked: Array.from(el.querySelectorAll('.md-hbp-row input')).filter(function (i) { return i.disabled; }).length,
      apply: !el.querySelector('.md-hbp-apply').disabled,
      note: (el.querySelector('.md-hbp-note') || {}).textContent || ''
    };
  });
  check(pnlEx && pnlEx.title === '挤出' && pnlEx.locked === 0 && pnlEx.apply === true,
    '已接入算子的参数面板：参数可调 + 应用可用', JSON.stringify(pnlEx));
  await page.evaluate(() => { const x = document.querySelector('#mdHbPanel [data-hbp-act="close"]'); if (x) x.click(); });
  await page.keyboard.up(' ');
  await page.keyboard.press('F8');

  /* 11.56 组件变换：手柄挂到「选中组件的中心」，位移经世界→局部换算写回顶点 */
  /* 前面多对象块把激活对象删到只剩「立方体」（可能被复制面板改过位置）。
   * 这里不靠点选（容易点到别的对象），直接选中「当前激活网格」的第一个顶点。 */
  const compInfo = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    d.gizmo.setTarget(null);                     // 先摘手柄，免得点顶点时先点到箭头
    const mesh = window.SeedModel.Scene.getMesh(d.doc);
    const corner = new THREE.Vector3(mesh.positions[0], mesh.positions[1], mesh.positions[2]);
    /* 清掉旧选择，按 ID 选中第一个顶点（ID 稳定，不随重建变） */
    const doc = d.doc;
    doc.selection = {
      mode: 'vertex', nodeIds: [doc.activeNodeId],
      vertexIds: [mesh.vertexIds ? mesh.vertexIds[0] : 0], edgeIds: [], faceIds: []
    };
    window.modelDesk.reselect();
    return {
      expect: corner.clone().applyMatrix4(d.pivot.matrixWorld).toArray().map(function (n) { return +n.toFixed(2); })
    };
  });
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('F9');
  await page.waitForTimeout(150);
  const compTarget = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    const m = window.SeedModel.Scene.getMesh(d.doc);
    const expect = new THREE.Vector3(m.positions[0], m.positions[1], m.positions[2])
      .applyMatrix4(d.pivot.matrixWorld).toArray().map(function (n) { return +n.toFixed(2); });
    return {
      name: d.gizmo.target && d.gizmo.target.name,
      pivot: d.pivot && d.pivot.name,
      pos: d.gizmo.target ? d.gizmo.target.position.toArray().map(function (n) { return +n.toFixed(2); }) : null,
      expect: expect,
      sel: window.modelDesk.getState().selVertex
    };
  });
  check(compTarget.name === 'comp-pivot' && compTarget.sel === 1 &&
    Math.abs(compTarget.pos[0] - compTarget.expect[0]) < 0.02 &&
    Math.abs(compTarget.pos[1] - compTarget.expect[1]) < 0.02 &&
    Math.abs(compTarget.pos[2] - compTarget.expect[2]) < 0.02,
    '选中顶点后手柄挂到组件中心（世界坐标 = 顶点世界坐标）', JSON.stringify(compTarget));

  /* 把对象绕 Y 转 45°，模拟手柄按世界 X 平移 0.3：世界位移必须是 (0.3,0,0)，局部则被旋转回去 */
  const compDrag = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    d.pivot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    d.pivot.updateMatrixWorld(true);
    const m = window.SeedModel.Scene.getMesh(d.doc);
    const wb = new THREE.Vector3(m.positions[0], m.positions[1], m.positions[2]).applyMatrix4(d.pivot.matrixWorld).toArray();
    const lb = [m.positions[0], m.positions[1], m.positions[2]];
    d.gizmo.onStart({ mode: 'translate', axis: 'x' });
    d.compPivot.position.x += 0.3;
    d.compPivot.updateMatrixWorld(true);
    d.gizmo.onChange();
    const wa = new THREE.Vector3(m.positions[0], m.positions[1], m.positions[2]).applyMatrix4(d.pivot.matrixWorld).toArray();
    const la = [m.positions[0], m.positions[1], m.positions[2]];
    d.gizmo.onEnd({ mode: 'translate', axis: 'x', changed: true });
    return {
      dw: [wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]].map(function (n) { return +n.toFixed(3); }),
      dl: [la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]].map(function (n) { return +n.toFixed(3); }),
      undo: window.modelDesk.getState().undo
    };
  });
  check(Math.abs(compDrag.dw[0] - 0.3) < 0.01 && Math.abs(compDrag.dw[1]) < 0.01 && Math.abs(compDrag.dw[2]) < 0.01,
    '世界 X 拖动 → 顶点世界位移正好沿 X（旋转对象也对）', JSON.stringify(compDrag.dw));
  check(Math.abs(compDrag.dl[0] - 0.212) < 0.02 && Math.abs(compDrag.dl[2] - 0.212) < 0.02,
    '局部坐标按对象旋转反算（0.3/√2 ≈ 0.212）', JSON.stringify(compDrag.dl));
  check(compDrag.undo >= 1, '组件变换记一条历史', String(compDrag.undo));

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const compUndo = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    return { q: d.pivot.quaternion.toArray().map(function (n) { return +n.toFixed(3); }), undo: window.modelDesk.getState().undo };
  });
  check(compUndo.q[1] > 0.3 || Math.abs(compUndo.q[1]) < 0.01, '撤销回到拖动前（历史可回滚）', JSON.stringify(compUndo));

  await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    d.pivot.quaternion.set(0, 0, 0, 1);
    d.pivot.updateMatrixWorld(true);
    window.modelDesk.getDocument().selection = { mode: 'object', nodeIds: [], vertexIds: [], edgeIds: [], faceIds: [] };
  });
  await page.keyboard.press('F8');

  /* 11.57 左侧工具条：选择 / 套索 / 绘制选择 / 移动 / 旋转 / 缩放 */
  const toolInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.md-tool[data-md-tool]'));
    return { ids: btns.map(function (b) { return b.dataset.mdTool; }), svgs: btns.filter(function (b) { return !!b.querySelector('svg'); }).length };
  });
  check(toolInfo.ids.join(',') === 'select,lasso,paint,move,rotate,scale' && toolInfo.svgs === 6,
    '左侧竖条六个工具（内联 SVG 图标）', toolInfo.ids.join(','));

  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.click('.md-tool[data-md-tool="lasso"]');
  const toolSel = await page.evaluate(() => ({ tool: window.modelDesk.getState().tool, on: document.querySelector('.md-tool.on').dataset.mdTool }));
  check(toolSel.tool === 'lasso' && toolSel.on === 'lasso', '点图标切到套索且高亮同步', JSON.stringify(toolSel));

  await page.click('.md-tool[data-md-tool="rotate"]');
  const toolRot = await page.evaluate(() => ({ tool: window.modelDesk.getState().tool, gizmo: window.modelDesk.getState().gizmoMode }));
  check(toolRot.tool === 'rotate' && toolRot.gizmo === 'rotate', '旋转工具同时切换手柄模式', JSON.stringify(toolRot));

  const boxPts = await page.evaluate(() => {
    const d = window.modelDesk.__debug(), THREE = window.THREE;
    const r = d.canvas.getBoundingClientRect();
    const proj = function (x, y, z) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(d.pivot.matrixWorld).project(d.camera);
      return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height };
    };
    const c = [];
    [-0.5, 0.5].forEach(function (x) { [-0.5, 0.5].forEach(function (y) { [-0.5, 0.5].forEach(function (z) { c.push(proj(x, y, z)); }); }); });
    const xs = c.map(function (q) { return q.x; }), ys = c.map(function (q) { return q.y; });
    d.gizmo.setTarget(null);
    return { x1: Math.min.apply(null, xs) - 30, y1: Math.min.apply(null, ys) - 30, x2: Math.max.apply(null, xs) + 30, y2: Math.max.apply(null, ys) + 30 };
  });
  /* 框选：顶点模式下框住整个立方体 → 8 个顶点全中 */
  await page.click('.md-tool[data-md-tool="select"]');
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('F9');
  await page.mouse.move(boxPts.x1, boxPts.y1);
  await page.mouse.down();
  await page.mouse.move(boxPts.x2, boxPts.y2, { steps: 6 });
  const lassoCls = await page.evaluate(() => document.getElementById('mdGest').className);
  await page.mouse.up();
  const boxN = await page.evaluate(() => window.modelDesk.getState().selVertex);
  check(boxN === 8 && lassoCls.indexOf('box') >= 0, '选择工具拖动 = 框选，框住整块选中 8 个顶点',
    '选中 ' + boxN + ' · 覆盖层 ' + lassoCls);

  /* 套索：同样的矩形，但用自由手画一圈 */
  await page.keyboard.press('F10');
  await page.keyboard.press('F9');
  await page.click('.md-tool[data-md-tool="lasso"]');
  await page.mouse.move(boxPts.x1, boxPts.y1);
  await page.mouse.down();
  await page.mouse.move(boxPts.x2, boxPts.y1, { steps: 4 });
  await page.mouse.move(boxPts.x2, boxPts.y2, { steps: 4 });
  await page.mouse.move(boxPts.x1, boxPts.y2, { steps: 4 });
  await page.mouse.move(boxPts.x1, boxPts.y1, { steps: 4 });
  await page.mouse.up();
  const lassoN = await page.evaluate(() => window.modelDesk.getState().selVertex);
  check(lassoN === 8, '套索圈住整块也选中 8 个顶点', String(lassoN));

  /* 绘制选择：沿顶沿刷一道，至少刷到顶点 */
  await page.keyboard.press('F10');
  await page.keyboard.press('F9');
  await page.click('.md-tool[data-md-tool="paint"]');
  await page.mouse.move(boxPts.x1, boxPts.y1 + 30);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) {
    await page.mouse.move(boxPts.x1 + i * ((boxPts.x2 - boxPts.x1) / 12), boxPts.y1 + 30);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  const paintN = await page.evaluate(() => window.modelDesk.getState().selVertex);
  check(paintN > 0, '绘制选择刷过的范围进选择集', String(paintN));

  await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    d.gizmo.setTarget(d.pivot);
    window.modelDesk.getDocument().selection = { mode: 'object', nodeIds: [], vertexIds: [], edgeIds: [], faceIds: [] };
  });
  await page.click('.md-tool[data-md-tool="select"]');
  await page.keyboard.press('F8');

  /* 11.58 建模工具箱的模式条：五个图标 + 当前模式回显 */
  const modeBtns = await page.evaluate(() => Array.from(document.querySelectorAll('.md-mode[data-md-selmode]')).map(function (b) { return b.dataset.mdSelmode; }));
  check(modeBtns.join(',') === 'object,vertex,edge,face,island', '工具箱模式条五个图标（对象/点/边/面/UV 岛）', modeBtns.join(','));

  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.click('.md-mode[data-md-selmode="face"]');
  const m1 = await page.evaluate(() => ({
    mode: window.modelDesk.getState().selMode,
    on: document.querySelector('.md-mode.on').dataset.mdSelmode,
    header: document.getElementById('mdTbMode').textContent,
    hint: document.getElementById('mdModeHint').textContent,
    tab: document.querySelector('.md-tbtab.on').textContent
  }));
  check(m1.mode === 'face' && m1.on === 'face' && m1.header === '面' && /F11/.test(m1.hint) && m1.tab === '多组件',
    '点面图标：模式/高亮/标题/提示/页签同步', JSON.stringify(m1));

  await page.keyboard.press('F12');
  const m2 = await page.evaluate(() => ({
    mode: window.modelDesk.getState().selMode,
    on: document.querySelector('.md-mode.on').dataset.mdSelmode,
    header: document.getElementById('mdTbMode').textContent
  }));
  check(m2.mode === 'island' && m2.on === 'island' && m2.header === 'UV 岛', 'F12 切 UV 岛时模式条跟着走', JSON.stringify(m2));

  await page.click('.md-tbtab[data-md-tbtab="object"]');
  const m3 = await page.evaluate(() => ({ mode: window.modelDesk.getState().selMode, tab: document.querySelector('.md-tbtab.on').textContent }));
  check(m3.mode === 'object' && m3.tab === '对象', '「对象」页签回到对象模式', JSON.stringify(m3));

  /* 11.6 M5 基础体：Shelf → 面板 → 创建 → 撤销 */
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.getElementById('mdCube').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.click('.md-shelf-grid button[data-md-prim="sphere"]');
  await page.waitForTimeout(120);
  const dlg = await page.evaluate(() => ({
    on: document.querySelector('.md-overlay').className.indexOf('on') >= 0,
    tab: (document.querySelector('.md-prim-tab.on') || {}).textContent,
    fields: document.querySelectorAll('[data-md-psize]').length,
    seg: !!document.querySelector('[data-md-pseg]')
  }));
  check(dlg.on && dlg.tab === '球体' && dlg.fields === 3 && dlg.seg, 'Shelf 图标打开基础体面板', JSON.stringify(dlg));

  /* 先清成单个立方体（前面复制面板可能留下副本） */
  await page.evaluate(() => {
    /* 直接删到只剩 1 个，再统一改名 + 显式可见 */
    const desk = window.modelDesk;
    const doc = desk.getDocument();
    while (doc.nodes.length > 1) {
      const extra = doc.nodes[doc.nodes.length - 1];
      desk.selectNodeById(extra.id);
      doc.nodes.pop();
      desk.reselect();
    }
    const cube = doc.nodes[0];
    cube.name = '立方体';
    cube.visible = true;
    doc.name = '立方体';
    desk.reselect();
    desk.selectNodeById(cube.id);
  });
  await page.waitForTimeout(250);
  const m5Base = await page.evaluate(() => window.modelDesk.getState());
  check(m5Base.nodeCount === 1 && m5Base.docNodes[0].name === '立方体' && m5Base.faces === 6,
    'M5 起点：单个立方体（6 面）', JSON.stringify(m5Base.docNodes) + ' / ' + m5Base.faces + ' 面');

  await page.fill('[data-md-pseg]', '24');
  const beforeM5 = await page.evaluate(() => window.modelDesk.getState());
  await page.click('[data-md-act="prim-create"]');
  await page.waitForTimeout(260);
  const m5 = await page.evaluate(() => ({ s: window.modelDesk.getState(), name: window.modelDesk.getDocument().name }));
  check(m5.s.nodeCount === 2 && m5.s.docNodes.length === 2 &&
    m5.s.docNodes[0].name === '立方体' && m5.s.docNodes[1].name === '球体' && m5.s.faces > 300,
    '创建球体 = 追加第二个对象（' + m5.s.faces + ' 面 + 自动改名）',
    JSON.stringify(m5.s.docNodes) + ' / 激活 ' + m5.s.faces + ' 面');
  check(m5.s.undo === beforeM5.undo + 1, '新建基础体只记一条历史', beforeM5.undo + ' → ' + m5.s.undo);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(220);
  const undoM5 = await page.evaluate(() => ({ s: window.modelDesk.getState(), name: window.modelDesk.getDocument().name }));
  check(undoM5.s.nodeCount === 1 && undoM5.s.docNodes[0].name === '立方体' && undoM5.s.faces === 6,
    '撤销一次回到立方体（新加的对象消失，名字与面数一起回）',
    undoM5.name + ' / ' + undoM5.s.faces + ' 面 / 节点 ' + undoM5.s.nodeCount);

  const curveGuard = await page.evaluate(() => {
    try { window.Modeler.geometryOf('tube', [0.1, 0.1, 0], 8); return 'no-throw'; } catch (e) { return e.message; }
  });
  check(/曲线|截面/.test(curveGuard), '曲线类形状不冒充基础体', curveGuard);

  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  const visObject = await page.evaluate(() => window.modelDesk.__debug().vertPoints.visible);
  await page.keyboard.press('F9');
  const visVertex = await page.evaluate(() => window.modelDesk.__debug().vertPoints.visible);
  await page.keyboard.press('F8');
  check(visObject === false && visVertex === true,
    '顶点层只在顶点模式显示（重建后也要生效）', '对象=' + visObject + ' 顶点=' + visVertex);

  /* 11.7 B2a 文档多网格：老格式迁移 / 两对象隔离 / 共享实例 / 回收 / 序列化 */
  const schema = await page.evaluate(() => {
    const S = window.SeedModel.Scene, M = window.SeedModel.Mesh, THREE = window.THREE;
    const live = S.toSeedModel(window.modelDesk.getDocument());

    /* 1) 老格式：只有 mesh 字段（v2.0 文件） */
    const legacy = JSON.parse(JSON.stringify(live));
    /* 不写死 'main'：当前文档的网格键可能已经是 mesh-N（复制/新建之后） */
    const firstKey = Object.keys(legacy.meshes)[0];
    legacy.mesh = legacy.meshes[firstKey];
    delete legacy.meshes;
    const v = S.validate(legacy);
    const d2 = v.doc;
    const migratedKeys = d2 ? Object.keys(d2.meshes) : [];

    /* 2) 加第二个对象，网格互不相同 */
    const g = new THREE.SphereGeometry(0.4, 12, 8);
    const sphere = M.fromBufferGeometry(g, { weld: true });
    g.dispose();
    const n1 = S.nodeOf(d2);
    const faces1 = S.stats(d2, n1).faces;
    const n2 = S.addMeshNode(d2, { name: '球', mesh: sphere, transform: { position: [1, 0, 0] } });
    const faces2 = S.stats(d2, n2).faces;

    /* 3) 只改第二个对象，第一个的网格必须一个字节都不动 */
    const h1 = M.hash(S.getMesh(d2, n1));
    const moved = M.clone(S.getMesh(d2, n2));
    M.translate(moved, 0.1, 0, 0);
    M.bump(moved);
    S.setMesh(d2, moved, n2);
    const h1After = M.hash(S.getMesh(d2, n1));

    /* 4) 共享同一个 meshId = 实例 */
    const n3 = S.addMeshNode(d2, { name: '球副本', meshId: n2.meshRef });
    const sharedRef = n3.meshRef === n2.meshRef;

    /* 5) 删节点：共享的网格不能跟着被删，最后一个引用走了才回收 */
    S.removeNode(d2, n3.id);
    const aliveAfterFirstRemove = !!d2.meshes[n2.meshRef];
    S.removeNode(d2, n2.id);
    const goneAfterLastRemove = !d2.meshes[n2.meshRef];

    /* 6) 序列化：只写 meshes，不写 mesh */
    const out = S.toSeedModel(d2);
    return {
      migratedKeys: migratedKeys, migratedWarn: (v.warnings || []).some(w => /迁移/.test(w)),
      faces1: faces1, faces2: faces2,
      node1Untouched: h1 === h1After, h1: h1.slice(0, 6), h1After: h1After.slice(0, 6),
      sharedRef: sharedRef, aliveAfterFirstRemove: aliveAfterFirstRemove, goneAfterLastRemove: goneAfterLastRemove,
      hasMeshKey: Object.prototype.hasOwnProperty.call(out, 'mesh'),
      meshCount: Object.keys(out.meshes).length, nodeCount: out.nodes.length,
      hasActive: !!out.activeNodeId
    };
  });
  check(schema.migratedKeys.length === 1 && schema.migratedKeys[0] === 'main' && schema.migratedWarn,
    '老文件（只有 mesh）自动迁移成 meshes.main', JSON.stringify(schema.migratedKeys));
  check(schema.faces1 === 6 && schema.faces2 > 6,
    '两个对象各自持有网格', '立方体 ' + schema.faces1 + ' 面 / 球 ' + schema.faces2 + ' 面');
  check(schema.node1Untouched,
    '改第二个对象不会动到第一个的网格', schema.h1 + ' → ' + schema.h1After);
  check(schema.sharedRef && schema.aliveAfterFirstRemove && schema.goneAfterLastRemove,
    'meshId 复用 = 实例，删节点按引用回收',
    JSON.stringify({ shared: schema.sharedRef, alive: schema.aliveAfterFirstRemove, gone: schema.goneAfterLastRemove }));
  check(!schema.hasMeshKey && schema.meshCount === 1 && schema.nodeCount === 1 && schema.hasActive,
    '保存只写 meshes + activeNodeId（不再写 mesh）',
    'mesh 键=' + schema.hasMeshKey + ' · 网格数=' + schema.meshCount + ' · 节点数=' + schema.nodeCount);

  /* 11.8 B2a 存取往返：GLB 里塞两个对象，读回来结构不变 */
  const rt = await page.evaluate(async () => {
    const S = window.SeedModel.Scene, M = window.SeedModel.Mesh, THREE = window.THREE, G = window.SeedGLB;
    const copy = S.validate(S.toSeedModel(window.modelDesk.getDocument())).doc;
    const g = new THREE.SphereGeometry(0.35, 10, 8);
    const sphere = M.fromBufferGeometry(g, { weld: true });
    g.dispose();
    S.addMeshNode(copy, { name: '球', mesh: sphere, transform: { position: [1.2, 0, 0] } });
    const buf = await window.modelDesk.exportBytes();
    const withExtras = G.injectSeedModel(buf, S.toSeedModel(copy));
    const back = G.readSeedModel(G.fromDataURL(G.toDataURL(withExtras)));
    const v = S.validate(back);
    return {
      ok: v.ok, errors: v.errors,
      nodes: v.doc ? v.doc.nodes.length : 0,
      meshes: v.doc ? Object.keys(v.doc.meshes).length : 0,
      faces: v.doc ? v.doc.nodes.map(function (n) { return S.stats(v.doc, n).faces; }) : []
    };
  });
  check(rt.ok && rt.nodes === 2 && rt.meshes === 2 && rt.faces[0] >= 6 && rt.faces[1] > 6 && rt.faces[0] !== rt.faces[1],
    'GLB 往返后两个对象的网格与面数都还在',
    JSON.stringify({ nodes: rt.nodes, meshes: rt.meshes, faces: rt.faces }));

  /* 11.8 面数上限是策略线不是性能线：2 万面级网格应能直接转换 */
  const capite = await page.evaluate(() => {
    const THREE = window.THREE, M = window.SeedModel.Mesh;
    const g = new THREE.SphereGeometry(1, 150, 100);
    const t0 = performance.now();
    const mesh = M.fromBufferGeometry(g, {});
    const ms = performance.now() - t0;
    g.dispose();
    return { cap: M.MAX_FACES, faces: M.faceCount(mesh), ms: Math.round(ms) };
  });
  check(capite.cap >= 50000 && capite.faces > 10000 && capite.ms < 500,
    '面数上限抬到 50000，2 万面级网格可转换',
    JSON.stringify(capite));

  /* 11.9 底部「内容浏览器」：打开模型库 → 置于（追加）/ 打开（清空重载） */
  const dockCss = await page.evaluate(() => {
    const el = document.querySelector('.md-dock');
    return el ? { exists: true, on: el.classList.contains('on'), h: el.getBoundingClientRect().height } : { exists: false };
  });
  check(dockCss.exists && !dockCss.on && dockCss.h <= 28,
    '内容浏览器默认收起，只占一条页签', JSON.stringify(dockCss));

  const dockAsset = await page.evaluate(async () => {
    const S = window.SeedModel.Scene, M = window.SeedModel.Mesh, G = window.SeedGLB, THREE = window.THREE;
    /* 用当前文档的副本 + 一个球，做成「两节点资产」，再塞进 GLB 的 extras */
    const copy = S.validate(S.toSeedModel(window.modelDesk.getDocument())).doc;
    const g = new THREE.SphereGeometry(0.4, 12, 8);
    const sphere = M.fromBufferGeometry(g, { weld: true });
    g.dispose();
    S.addMeshNode(copy, { name: '置于球', mesh: sphere, transform: { position: [1.2, 0, 0] } });
    const buf = await window.modelDesk.exportBytes();
    const withExtras = G.injectSeedModel(buf, S.toSeedModel(copy));
    const url = G.toDataURL(withExtras);
    const store = { 'asset-dock-1': url };
    window.openagiDesktop = {
      assetPut: async o => ({ ok: true, asset: { id: o.id, name: o.name } }),
      assetList: async () => ({ ok: true, assets: [
        { id: 'asset-dock-1', name: '置于测试.glb', kind: 'model', ext: 'glb', size: withExtras.length, updated: 1750000000000 }
      ] }),
      assetRead: async id => ({ ok: true, dataURL: store[id] }),
      assetThumb: async () => ({ ok: false })
    };
    return { bytes: withExtras.length, nodes: copy.nodes.length };
  });
  info('测试资产', JSON.stringify(dockAsset));

  await page.click('.md-act[data-md-act="open"]');
  await page.waitForTimeout(500);
  const dockOpen = await page.evaluate(() => ({
    on: document.querySelector('.md-dock').classList.contains('on'),
    tab: document.querySelector('.md-dock-tab.on').textContent,
    cards: document.querySelectorAll('.md-cb-card').length,
    sub: (document.getElementById('mdDockSub') || {}).textContent || '',
    buttons: Array.from(document.querySelectorAll('.md-cb-card:first-child button')).map(b => b.textContent),
    nodeCount: window.modelDesk.getState().nodeCount,
    undo: window.modelDesk.getState().undo
  }));
  check(dockOpen.on && /内容浏览器/.test(dockOpen.tab) && dockOpen.cards === 1 && dockOpen.sub === '1 个模型',
    '工具行「打开」展开内容浏览器并列出模型库', JSON.stringify(dockOpen));
  check(dockOpen.buttons.join(',') === '置于,打开',
    '每个资产都有「置于」「打开」两个动作', dockOpen.buttons.join(','));

  await page.click('.md-cb-card:first-child [data-md-cb-place]');
  await page.waitForTimeout(600);
  const placed = await page.evaluate(() => ({
    nodeCount: window.modelDesk.getState().nodeCount,
    undo: window.modelDesk.getState().undo,
    status: window.modelDesk.getState().status,
    on: document.querySelector('.md-dock').classList.contains('on')
  }));
  check(placed.nodeCount === dockOpen.nodeCount + dockAsset.nodes && placed.undo === dockOpen.undo + 1,
    '「置于」把资产节点追加进当前场景（一条历史）',
    JSON.stringify({ before: dockOpen.nodeCount, after: placed.nodeCount, undo: dockOpen.undo + '→' + placed.undo }));
  check(/已置于/.test(placed.status) && placed.on,
    '置于后有状态提示，内容浏览器保持展开', placed.status);

  await page.click('.md-cb-card:first-child [data-md-cb-open]');
  await page.waitForTimeout(600);
  const reopened = await page.evaluate(() => ({
    nodeCount: window.modelDesk.getState().nodeCount,
    undo: window.modelDesk.getState().undo,
    names: window.modelDesk.getState().docNodes.map(n => n.name),
    status: window.modelDesk.getState().status
  }));
  check(reopened.nodeCount === dockAsset.nodes && reopened.undo === 0 &&
    reopened.names.indexOf('置于球') >= 0,
    '「打开」清空场景并载入资产（历史重置）',
    JSON.stringify({ nodes: reopened.nodeCount, undo: reopened.undo, names: reopened.names }));
  check(/已打开/.test(reopened.status), '打开后有状态提示', reopened.status);

  /* 11.10 普通 GLB（没有 seedModel）也要能打开：转成可编辑网格 */
  const plainBytes = await page.evaluate(async () => {
    const G = window.SeedGLB;
    const buf = await window.modelDesk.exportBytes();
    const json = G.readJson(buf);
    if (json.asset && json.asset.extras) delete json.asset.extras.seedModel;
    const plain = G.writeJson(buf, json);
    const prevRead = window.openagiDesktop.assetRead;
    window.openagiDesktop.assetRead = async id => {
      if (id === 'asset-dock-plain') return { ok: true, dataURL: G.toDataURL(plain) };
      return prevRead(id);
    };
    const prevList = window.openagiDesktop.assetList;
    window.openagiDesktop.assetList = async () => {
      const l = await prevList();
      l.assets.push({ id: 'asset-dock-plain', name: '普通模型.glb', kind: 'model', ext: 'glb', size: plain.length, updated: 1749999999000 });
      return l;
    };
    return plain.length;
  });
  await page.click('.md-dock-mini[data-md-dock="refresh"]');
  await page.waitForTimeout(500);
  const twoCards = await page.evaluate(() => document.querySelectorAll('.md-cb-card').length);
  check(twoCards === 2, '刷新后模型库多出普通 GLB 卡片', String(twoCards));

  await page.click('[data-md-cb-id="asset-dock-plain"] [data-md-cb-open]');
  await page.waitForTimeout(900);
  const plainOpen = await page.evaluate(() => ({
    nodeCount: window.modelDesk.getState().nodeCount,
    status: window.modelDesk.getState().status
  }));
  check(/普通模型已转为可编辑网格/.test(plainOpen.status) && !/失败/.test(plainOpen.status) &&
    plainOpen.nodeCount >= 1,
    '普通 GLB 打开时自动转成可编辑网格（不再「打开失败」）',
    JSON.stringify({ nodes: plainOpen.nodeCount, status: plainOpen.status }));

  /* 11.10b FBX：ASCII 网格走同一条「普通模型」导入路径 */
  const FBX_MINI = `; FBX 7.2.0 project file
; Copyright (C) 1997-2010 Autodesk Inc. and/or its licensors.
; All rights reserved.
; ----------------------------------------------------

FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7200
}

Objects:  {
	Model: 10, "Model::Layer 01", "Null" {
	}
	Geometry: 2000, "Geometry::", "Mesh" {
		Vertices: *24 {
			a: -1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1
		}
		PolygonVertexIndex: *24 {
			a: 0,1,2,-4, 0,4,7,-3, 4,5,6,-8, 1,5,6,-3, 0,4,5,-2, 2,6,7,-3
		}
		GeometryVersion: 124
	}
	Model: 200, "Model::MiniCube", "Mesh" {
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
			P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
		}
		Shading: T
		Culling: "CullingOff"
	}
}

Connections:  {
	C: "OO",10,0
	C: "OO",200,10
	C: "OO",2000,200
}`;
  const fbxAsset = await page.evaluate(async (text) => {
    const url = 'data:application/octet-stream;base64,' + btoa(text);
    const prevRead = window.openagiDesktop.assetRead;
    window.openagiDesktop.assetRead = async id => {
      if (id === 'asset-dock-fbx') return { ok: true, dataURL: url };
      return prevRead(id);
    };
    const prevList = window.openagiDesktop.assetList;
    window.openagiDesktop.assetList = async () => {
      const l = await prevList();
      l.assets.push({ id: 'asset-dock-fbx', name: '方盒.fbx', kind: 'model', ext: 'fbx', size: text.length, updated: 1749999998000 });
      return l;
    };
    return { loader: typeof window.THREE.FBXLoader, bytes: text.length };
  }, FBX_MINI);
  check(fbxAsset.loader === 'function', 'FBXLoader 已挂到全局 THREE', JSON.stringify(fbxAsset));

  await page.click('.md-dock-mini[data-md-dock="refresh"]');
  await page.waitForTimeout(500);
  const fbxCard = await page.evaluate(() => {
    const card = document.querySelector('[data-md-cb-id="asset-dock-fbx"]');
    return {
      cards: document.querySelectorAll('.md-cb-card').length,
      buttons: card ? Array.from(card.querySelectorAll('button')).map(b => b.textContent) : []
    };
  });
  check(fbxCard.cards === 3 && fbxCard.buttons.join(',') === '置于,打开',
    'FBX 资产在内容浏览器里可置于/打开', JSON.stringify(fbxCard));

  await page.click('[data-md-cb-id="asset-dock-fbx"] [data-md-cb-open]');
  await page.waitForTimeout(900);
  const fbxOpen = await page.evaluate(() => ({
    nodeCount: window.modelDesk.getState().nodeCount,
    names: window.modelDesk.getState().docNodes.map(n => n.name),
    status: window.modelDesk.getState().status
  }));
  check(fbxOpen.nodeCount === 1 && !/失败/.test(fbxOpen.status) &&
    /普通模型已转为可编辑网格/.test(fbxOpen.status),
    'FBX 打开后转成 1 个可编辑节点',
    JSON.stringify(fbxOpen));

  /* 11.11 命令行输入框必须服从建模 App 的深色风格，且不越出命令行行高 */
  const cmdStyle = await page.evaluate(() => {
    const el = document.getElementById('mdCmd');
    const r = el.getBoundingClientRect();
    const row = el.closest('.md-cmdrow').getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      h: Math.round(r.height * 10) / 10,
      overTop: Math.round((r.top - row.top) * 10) / 10,
      overBottom: Math.round((r.bottom - row.bottom) * 10) / 10,
      bg: cs.backgroundColor, radius: cs.borderRadius
    };
  });
  check(cmdStyle.h <= 21 && cmdStyle.overTop >= -1 && cmdStyle.overBottom <= 1 &&
    cmdStyle.bg !== 'rgb(255, 255, 255)' && cmdStyle.radius !== '9px',
    '命令行输入框不再白底、不越出命令行高度',
    JSON.stringify(cmdStyle));

  await page.click('.md-dock-tab[data-md-dock="toggle"]');
  await page.waitForTimeout(200);
  const dockClosed = await page.evaluate(() => document.querySelector('.md-dock').classList.contains('on'));
  check(dockClosed === false, '再点页签可收起内容浏览器', String(dockClosed));
  await page.click('.md-dock-tab[data-md-dock="toggle"]');
  await page.waitForTimeout(300);

  /* 12. 截图（整窗 + 视口） */
  const shotWin = path.join(__dirname, '_md-shot-win.png');
  const shotVp = path.join(__dirname, '_md-shot-vp.png');
  try {
    const win = await page.$('#modelDeskWin');
    if (win) await win.screenshot({ path: shotWin });
    const stage = await page.$('#mdStage');
    if (stage) await stage.screenshot({ path: shotVp });
    info('截图', shotWin + ' , ' + shotVp);
  } catch (e) { info('截图失败', String(e && e.message)); }

  check(errors.length === 0, '打开与操作期间无 pageerror', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(fails ? '\n❌ 失败 ' + fails + ' 项' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})();
