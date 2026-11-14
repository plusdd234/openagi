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
const { createRun } = require('./probe-run');

const RUN = createRun('probe-modeldesk');

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

  /* 4b. 平涂 / UV 岛着色（参考模型库的材质预览做法） */
  const shadeMore = await page.evaluate(async () => {
    const sel = document.getElementById('mdShadeSel');
    const apply = async (v) => {
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
    };
    const firstSolid = () => {
      let s = null;
      const piv = window.modelDesk.__debug().pivots || {};
      Object.keys(piv).forEach(k => piv[k].traverse(o => {
        if (!s && o.userData && o.userData.mdPart === 'solid') s = o;
      }));
      return s;
    };
    const typeOf = o => {
      if (!o || !o.material) return null;
      return (Array.isArray(o.material) ? o.material[0] : o.material).type;
    };
    const out = {};
    await apply('flat');
    const s1 = firstSolid();
    const m1 = s1 && (Array.isArray(s1.material) ? s1.material[0] : s1.material);
    out.flat = {
      state: window.modelDesk.getState().shading,
      type: typeOf(s1), toneMapped: m1 ? m1.toneMapped : null, visible: !!(s1 && s1.visible)
    };
    await apply('uv');
    const d2 = window.modelDesk.__debug();
    let layer = null, solid2 = null;
    Object.keys(d2.pivots || {}).forEach(k => d2.pivots[k].traverse(o => {
      const part = o.userData && o.userData.mdPart;
      if (part === 'uvisland') layer = o;
      if (part === 'solid' && !solid2) solid2 = o;
    }));
    out.uv = {
      state: window.modelDesk.getState().shading,
      layer: !!layer, layerVisible: !!(layer && layer.visible),
      colors: !!(layer && layer.geometry && layer.geometry.attributes && layer.geometry.attributes.color),
      vertexColors: !!(layer && layer.material && layer.material.vertexColors),
      solidHidden: !(solid2 && solid2.visible)
    };
    await apply('shaded-wire');
    out.restored = { state: window.modelDesk.getState().shading, type: typeOf(firstSolid()) };
    return out;
  });
  check(shadeMore.flat.state === 'flat' && shadeMore.flat.type === 'MeshBasicMaterial' &&
    shadeMore.flat.visible === true && shadeMore.flat.toneMapped === false,
    '平涂 = unlit 材质（不吃灯光 / 色调映射）', JSON.stringify(shadeMore.flat));
  check(shadeMore.uv.state === 'uv' && shadeMore.uv.layer === true && shadeMore.uv.layerVisible === true &&
    shadeMore.uv.colors === true && shadeMore.uv.vertexColors === true && shadeMore.uv.solidHidden === true,
    'UV 岛着色：实体收起、岛色层（顶点色）出场', JSON.stringify(shadeMore.uv));
  check(shadeMore.restored.state === 'shaded-wire' && shadeMore.restored.type === 'MeshStandardMaterial',
    '切回实体 + 线框恢复受光材质', JSON.stringify(shadeMore.restored));

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

  /* 7.2 转向三角：点一下 = 绕目标点翻 90°，落点是正轴视图且箭头继续显示 */
  const cubeTurn = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const box = document.getElementById('mdCube');
    const before = d.camera.position.clone().sub(d.controls.target).normalize();
    const shown = box.classList.contains('on');
    document.querySelector('[data-md-turn="right"]').click();
    await new Promise(r => setTimeout(r, 200));
    const after = d.camera.position.clone().sub(d.controls.target).normalize();
    return {
      deg: before.angleTo(after) * 180 / Math.PI,
      view: window.modelDesk.getState().viewName,
      shown: shown, still: box.classList.contains('on')
    };
  });
  const VIEWS = ['前视图', '后视图', '左视图', '右视图', '顶视图', '底视图'];
  check(Math.abs(cubeTurn.deg - 90) < 5 && VIEWS.indexOf(cubeTurn.view) >= 0 &&
    cubeTurn.shown && cubeTurn.still, 'ViewCube 箭头 90° 转向', JSON.stringify(cubeTurn));

  /* 7.2b 任意正视图 → 向上翻：必须落在正顶视图
   * （旧实现 phi 夹 0.08，会留下 4.6° 斜角，正是「前视图切顶视图没摆正」） */
  const cubeTop = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const box = document.getElementById('mdCube');
    document.querySelector('[data-md-turn="up"]').click();
    await new Promise(r => setTimeout(r, 200));
    const dir = d.camera.position.clone().sub(d.controls.target).normalize();
    return {
      view: window.modelDesk.getState().viewName,
      y: +dir.y.toFixed(6), x: +dir.x.toFixed(6), z: +dir.z.toFixed(6),
      shown: box.classList.contains('on')
    };
  });
  check(cubeTop.view === '顶视图' && cubeTop.y > 0.99999 && Math.abs(cubeTop.z) < 0.01 && cubeTop.shown,
    'ViewCube 翻到顶视图摆正', JSON.stringify(cubeTop));

  /* 7.2c 极点不能把按钮吞掉：顶 → 下 → 前 → 下 → 底；
   * 底视图里「左 / 右」要还能转画面（相机右向量转 90°，仍在底视图），
   * 「下」要能离开极点落到另一个正轴视图。上一版在极点无条件 theta=0，这三个按钮等于失效。 */
  const cubePole = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const T = window.THREE;
    const box = document.getElementById('mdCube');
    const click = async (k) => {
      document.querySelector('[data-md-turn="' + k + '"]').click();
      await new Promise(r => setTimeout(r, 160));
    };
    const snap = () => {
      const dir = d.camera.position.clone().sub(d.controls.target).normalize();
      return {
        view: window.modelDesk.getState().viewName,
        y: +dir.y.toFixed(5), x: +dir.x.toFixed(5), z: +dir.z.toFixed(5),
        shown: box.classList.contains('on')
      };
    };
    const right = () => new T.Vector3().setFromMatrixColumn(d.camera.matrixWorld, 0).clone();
    await click('down');
    const seq1 = snap();
    await click('down');
    const seq2 = snap();
    const r0 = right();
    await click('left');
    const r1 = right();
    const leftRoll = +(r0.angleTo(r1) * 180 / Math.PI).toFixed(1);
    const afterLeft = snap();
    await click('right');
    const rightRoll = +(r1.angleTo(right()) * 180 / Math.PI).toFixed(1);
    const afterRight = snap();
    await click('down');
    const afterDown = snap();
    return {
      seq: [seq1.view, seq2.view], afterLeft, afterRight, afterDown,
      leftRoll, rightRoll
    };
  });
  check(cubePole.seq[0] === '前视图' && cubePole.seq[1] === '底视图',
    '顶视图按「下」两次落到正底视图', JSON.stringify(cubePole.seq));
  check(cubePole.afterLeft.view === '底视图' && cubePole.afterLeft.y < -0.99999 &&
    cubePole.afterLeft.shown && Math.abs(cubePole.leftRoll - 90) < 3,
    '底视图按「左」画面原地转 90°', JSON.stringify(cubePole.afterLeft) + ' roll=' + cubePole.leftRoll);
  check(cubePole.afterRight.view === '底视图' && cubePole.afterRight.y < -0.99999 &&
    cubePole.afterRight.shown && Math.abs(cubePole.rightRoll - 90) < 3,
    '底视图按「右」画面原地转 90°', JSON.stringify(cubePole.afterRight) + ' roll=' + cubePole.rightRoll);
  check(VIEWS.indexOf(cubePole.afterDown.view) >= 0 && cubePole.afterDown.view !== '底视图' &&
    cubePole.afterDown.shown, '底视图按「下」离开极点落到正轴视图',
    JSON.stringify(cubePole.afterDown));

  /* 7.3 立体跟随：拖立方体 → 相机绕模型转，立方体朝向同步反着转；
   * 转完不再归正，四个转向三角必须收起来 */
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
    return {
      dq: q0.angleTo(c.group.quaternion), view: window.modelDesk.getState().viewName,
      shown: document.getElementById('mdCube').classList.contains('on')
    };
  });
  check(cubeSync.dq > 0.05 && cubeSync.view === '自由' && !cubeSync.shown,
    'ViewCube 随相机同步旋转', JSON.stringify(cubeSync));

  /* 7.3b 悬停与单击延迟：这两条是 `cubeHover` / `cubeClickTimer` 唯一的观测手段。
   * 2026-11-13 把这两个键（连同 cubeDrag）从 `st` 搬进 md-viewcube 的闭包 ——
   * 拖拽有 7.3 盯着，悬停和延迟此前**一条断言都没有**，所以补在这里。
   * 扫格找命中点而不是假定画布中心：7.3 之后视角是斜的，中心点不一定落在面上。 */
  const cubeHoverClick = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const c = d.cube, T = window.THREE;
    const box = document.getElementById('mdCube');
    const r = c.canvas.getBoundingClientRect();
    const pickAt = (x, y) => {
      c.group.updateMatrixWorld(true);
      c.ray.setFromCamera(new T.Vector2(((x - r.left) / r.width) * 2 - 1,
        -((y - r.top) / r.height) * 2 + 1), c.cam);
      const hit = c.ray.intersectObjects(c.planes, false)[0];
      return hit && typeof hit.object.userData.face === 'number' ? hit.object.userData.face : -1;
    };
    let px = -1, py = -1, face = -1;
    for (let iy = 2; iy <= 8 && face < 0; iy++) {
      for (let ix = 2; ix <= 8 && face < 0; ix++) {
        const x = r.left + r.width * ix / 10, y = r.top + r.height * iy / 10;
        const f = pickAt(x, y);
        if (f >= 0) { px = x; py = y; face = f; }
      }
    }
    if (face < 0) return { err: '画布上找不到能命中面的点' };

    const pv = (type, x, y) => box.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 11, clientX: x, clientY: y
    }));

    /* ① 悬停：只移动不按下 */
    pv('pointermove', px, py);
    await new Promise(res => setTimeout(res, 60));
    const lit = c.mats[face].color.getHex();
    const othersWhite = c.mats.every((m, k) => k === face || m.color.getHex() === 0xffffff);
    const cursor = box.style.cursor;
    pv('pointermove', r.left - 300, r.top - 300);
    await new Promise(res => setTimeout(res, 60));
    const backWhite = c.mats.every(m => m.color.getHex() === 0xffffff);

    /* ② 单击延迟：按 260ms 才跳，立刻不跳（这个延迟是为了双击不先跳一次单面） */
    const start = window.modelDesk.getState().viewName;
    pv('pointerdown', px, py); pv('pointerup', px, py);
    await new Promise(res => setTimeout(res, 120));
    const mid = window.modelDesk.getState().viewName;
    await new Promise(res => setTimeout(res, 320));
    const end = window.modelDesk.getState().viewName;

    return { face, lit, othersWhite, cursor, backWhite, start, mid, end };
  });
  check(!cubeHoverClick.err && (cubeHoverClick.lit === 0xffcf86 && cubeHoverClick.othersWhite &&
    cubeHoverClick.cursor === 'pointer' && cubeHoverClick.backWhite),
    'ViewCube 悬停：命中面变暖色、其余回白、移开全白、光标 pointer', JSON.stringify(cubeHoverClick));
  check(!cubeHoverClick.err && (cubeHoverClick.mid === cubeHoverClick.start &&
    cubeHoverClick.end !== cubeHoverClick.start),
    'ViewCube 单击有 260ms 延迟（立刻不跳、到点才跳）',
    JSON.stringify({ start: cubeHoverClick.start, mid: cubeHoverClick.mid, end: cubeHoverClick.end }));

  /* 7.4 回轴测：后面的 Alt 导航与拾取断言都依赖这个视角 */
  await page.evaluate(async () => {
    document.getElementById('mdCube').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  });

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
  check(hbRows.rows === hbRows.icons && hbRows.icons === hbRows.opts && hbRows.rows >= 24,
    '每行 = 图标 + 名字 + 右侧方框（一一对应）', JSON.stringify(hbRows));

  const hb = await readHb();
  check(hb.on && hb.zones.length === 4 && hb.zones[1].t === '对象操作',
    '热盒四区：组件模式 / 当前模式操作 / 工具 / 显示（对象模式下右区=对象操作）', JSON.stringify(hb.zones.map(function (z) { return z.t; })));
  check(hb.zones[1].items.indexOf('复制对象') === 0 && hb.zones[1].items.filter(function (x) { return /占位$/.test(x); }).length === 2 &&
    hb.zones[1].items.indexOf('隔离') > 0,
    '对象操作区：4 个真命令 + 2 个占位（分组/父子），隔离已接入', JSON.stringify(hb.zones[1].items));

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

  /* 最后一个对象也能删：场景变空是合法状态，渲染层跟着清空，Ctrl+Z 还能整份回来 */
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  const delLast = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { n: s.nodeCount, scene: s.sceneObjects, faces: s.faces, status: s.status };
  });
  check(delLast.n === 0 && delLast.scene === 0 && delLast.faces === 0 && /场景已空/.test(delLast.status),
    '最后一个对象可以删除，场景变空（渲染层同步清掉）', JSON.stringify(delLast));

  /* 空场景也要能导出（保存时 currentGLB 不再因为「没有网格」直接抛错） */
  const emptyGlb = await page.evaluate(async () => {
    try {
      const buf = await window.modelDesk.exportBytes();
      return { ok: true, bytes: buf.byteLength || buf.length };
    } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  });
  check(emptyGlb.ok && emptyGlb.bytes > 0,
    '空场景能导出 GLB（保存链路不再抛「还没有网格」）', JSON.stringify(emptyGlb));

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(350);
  const undel = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { n: s.nodeCount, scene: s.sceneObjects, faces: s.faces, names: s.docNodes.map(x => x.name) };
  });
  check(undel.n === 1 && undel.scene === 1 && undel.faces === 6,
    '撤销删除：对象与网格一起回来', JSON.stringify(undel));

  /* 空场景里再从「新建」加对象：不能因为文档没有激活节点就卡住 */
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  await page.evaluate(() => window.modelDesk.createPrimitive());
  await page.waitForTimeout(350);
  const fromEmpty = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { n: s.nodeCount, scene: s.sceneObjects, faces: s.faces };
  });
  check(fromEmpty.n === 1 && fromEmpty.scene === 1 && fromEmpty.faces > 0,
    '空场景里「新建」能重新加对象', JSON.stringify(fromEmpty));

  /* 回到「立方体」单对象：撤销这次新建，再撤销删除，后续用例状态就绪 */
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const backToCube = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { n: s.nodeCount, faces: s.faces, names: s.docNodes.map(x => x.name) };
  });
  check(backToCube.n === 1 && backToCube.faces === 6 && /立方体/.test(backToCube.names[0]),
    '两次撤销回到「立方体」单对象', JSON.stringify(backToCube));

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

  /* 11.8b 空场景也能存盘再读回：删光对象后的文档不该被「补一个幽灵节点」 */
  const emptyRt = await page.evaluate(() => {
    const S = window.SeedModel.Scene;
    const doc = S.validate(S.toSeedModel(window.modelDesk.getDocument())).doc;
    S.nodesOf(doc).forEach(function (n) { S.removeNode(doc, n.id); });
    const v = S.validate(S.toSeedModel(doc));
    return {
      ok: v.ok, errors: v.errors, warnEmpty: (v.warnings || []).some(w => /空场景/.test(w)),
      nodes: v.doc ? v.doc.nodes.length : -1,
      meshes: v.doc ? Object.keys(v.doc.meshes).length : -1,
      active: v.doc ? v.doc.activeNodeId : 'x'
    };
  });
  check(emptyRt.ok && emptyRt.nodes === 0 && emptyRt.meshes === 0 && emptyRt.active === '' && emptyRt.warnEmpty,
    '空场景可以序列化 / 校验（不会补幽灵节点）', JSON.stringify(emptyRt));

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

  /* 11.10b 导入色真的到材质上：slotColors / slotMaps 不能只存在文档里，视口实体材质得吃到 */
  const importedColor = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const doc = window.modelDesk.getDocument();
    const mats = [];
    if (d.pivot) d.pivot.traverse(o => {
      if (o.userData && o.userData.mdPart === 'solid' && o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.push(m));
      }
    });
    return {
      slotNames: doc.materials.slotNames.length,
      slotColors: doc.materials.slotColors,
      maps: (doc.materials.slotMaps || []).filter(Boolean).length,
      matColors: mats.map(m => '#' + m.color.getHexString()),
      matMaps: mats.map(m => !!m.map)
    };
  });
  check(importedColor.slotNames > 0 && importedColor.slotColors.length === importedColor.slotNames &&
    importedColor.matColors.length > 0 &&
    importedColor.matColors[0] === importedColor.slotColors[0],
    '导入后槽色写进文档并挂到实体材质上（重开不再变灰）',
    JSON.stringify({ doc: importedColor.slotColors[0], mat: importedColor.matColors[0],
      slots: importedColor.slotNames, maps: importedColor.maps }));

  /* 11.10c 同名同材质碎片并成一个节点（导出器 16 位索引 / 按材质拆 primitive 的常见产物） */
  await page.evaluate(async () => {
    const THREE = window.THREE, G = window.SeedGLB;
    const scene = new THREE.Scene();
    const mat = new THREE.MeshStandardMaterial({ name: '同材质', color: 0xb0b4ba });
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    a.name = 'Body';
    a.position.set(-1.2, 0, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    b.name = 'Body';
    b.position.set(1.2, 0, 0);
    scene.add(a, b);
    const buf = await new Promise((res, rej) => new THREE.GLTFExporter().parse(scene, res, rej, { binary: true }));
    const prevRead = window.openagiDesktop.assetRead;
    window.openagiDesktop.assetRead = async id => {
      if (id === 'asset-dock-merge') return { ok: true, dataURL: G.toDataURL(buf) };
      return prevRead(id);
    };
    const prevList = window.openagiDesktop.assetList;
    window.openagiDesktop.assetList = async () => {
      const l = await prevList();
      l.assets.push({ id: 'asset-dock-merge', name: '同名碎片.glb', kind: 'model', ext: 'glb', size: buf.byteLength, updated: 1749999998000 });
      return l;
    };
  });
  await page.click('.md-dock-mini[data-md-dock="refresh"]');
  await page.waitForTimeout(500);
  await page.click('[data-md-cb-id="asset-dock-merge"] [data-md-cb-open]');
  await page.waitForTimeout(900);
  const mergedOpen = await page.evaluate(() => {
    const st = window.modelDesk.getState();
    const doc = window.modelDesk.getDocument();
    return {
      nodes: st.docNodes.map(n => n.name),
      faces: Object.keys(doc.meshes).map(k => doc.meshes[k].faceCount),
      status: st.status
    };
  });
  check(mergedOpen.nodes.length === 1 && mergedOpen.nodes[0] === 'Body' && mergedOpen.faces[0] === 12,
    '同名同材质碎片并成一个节点（不再裂成两个 Body）',
    JSON.stringify(mergedOpen));

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
  check(fbxCard.cards >= 3 && fbxCard.buttons.join(',') === '置于,打开',
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
      bg: cs.backgroundColor, radius: cs.borderRadius, border: cs.borderColor
    };
  });
  check(cmdStyle.h <= 21 && cmdStyle.overTop >= -1 && cmdStyle.overBottom <= 1 &&
    cmdStyle.radius === '4px' && cmdStyle.border === 'rgb(217, 221, 227)',
    '命令行输入框沿用浅色字段样式（冷灰描边、4px 圆角、不越出命令行高度）',
    JSON.stringify(cmdStyle));

  await page.click('.md-dock-tab[data-md-dock="toggle"]');
  await page.waitForTimeout(200);
  const dockClosed = await page.evaluate(() => document.querySelector('.md-dock').classList.contains('on'));
  check(dockClosed === false, '再点页签可收起内容浏览器', String(dockClosed));
  await page.click('.md-dock-tab[data-md-dock="toggle"]');
  await page.waitForTimeout(300);

  /* 11.12 Maya 式变换手柄：中心 = 屏幕空间、平面手柄 = 两轴平面、外圈 = 屏幕旋转、
   *       中心方块 = 整体缩放、旋转 / 缩放环跟随对象朝向、悬停高亮 */
  const giz = await page.evaluate(async () => {
    const d = window.modelDesk.__debug(), g = d.gizmo, T = window.THREE;
    const pickAt = (h, local) => g._screenPoint(h.pickers[0].localToWorld(new T.Vector3().copy(local)));
    const send = (type, x, y, id) => d.canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: id, clientX: x, clientY: y
    }));
    const drag = async (h, local, dx, dy, id) => {
      const a = pickAt(h, local || new T.Vector3());
      send('pointerdown', a.x, a.y, id);
      for (let i = 1; i <= 8; i++) send('pointermove', a.x + dx * i / 8, a.y + dy * i / 8, id);
      send('pointerup', a.x + dx, a.y + dy, id);
      await new Promise(r => setTimeout(r, 120));
    };
    const pos = () => d.pivot.position.clone();
    const out = {};

    g.setMode('translate');
    /* 中心方块：位移必须落在「正对相机」的平面里（与视线方向的点积 ≈ 0） */
    const cH = g.handles.find(h => h.kind === 'center');
    const camDir = g._cameraDir().clone();
    const p0 = pos();
    await drag(cH, new T.Vector3(), 60, -60, 11);
    const dvC = pos().sub(p0);
    out.center = { len: +dvC.length().toFixed(3), dotCam: +Math.abs(dvC.dot(camDir)).toFixed(4) };

    /* XY 平面手柄：法向 Z，位移不该有 Z 分量 */
    const pH = g.handles.find(h => h.kind === 'plane' && h.axes.join('') === 'xy');
    const p1 = pos();
    await drag(pH, new T.Vector3(), 56, 40, 12);
    const dvP = pos().sub(p1);
    out.plane = { len: +dvP.length().toFixed(3), dz: +Math.abs(dvP.z).toFixed(4) };

    /* X 轴：只沿 X 走 */
    const xH = g.handles.find(h => h.kind === 'axis' && h.mode === 'translate' && h.axis === 'x');
    const p2 = pos();
    await drag(xH, new T.Vector3(0, 0.21, 0), 72, 32, 13);
    const dvX = pos().sub(p2);
    out.axis = { len: +dvX.length().toFixed(3), dy: +Math.abs(dvX.y).toFixed(4), dz: +Math.abs(dvX.z).toFixed(4) };

    /* 外圈：绕相机视线旋转；环的朝向与对象一致 */
    g.setMode('rotate');
    const sH = g.handles.find(h => h.kind === 'screen');
    const q0 = d.pivot.quaternion.clone();
    const sp = pickAt(sH, new T.Vector3(sH.pickers[0].geometry.parameters.radius, 0, 0));
    const cen = pickAt(sH, new T.Vector3());
    const rr = Math.hypot(sp.x - cen.x, sp.y - cen.y), a0 = Math.atan2(sp.y - cen.y, sp.x - cen.x);
    send('pointerdown', sp.x, sp.y, 14);
    for (let i = 1; i <= 12; i++) {
      const ang = a0 + 1.2 * i / 12;
      send('pointermove', cen.x + Math.cos(ang) * rr, cen.y + Math.sin(ang) * rr, 14);
    }
    send('pointerup', cen.x + Math.cos(a0 + 1.2) * rr, cen.y + Math.sin(a0 + 1.2) * rr, 14);
    await new Promise(r => setTimeout(r, 120));
    const dq = q0.clone().invert().multiply(d.pivot.quaternion);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
    const ax = new T.Vector3(dq.x, dq.y, dq.z);
    if (ax.length() > 1e-6) ax.normalize();
    out.screenRot = {
      deg: +(ang * 180 / Math.PI).toFixed(1),
      axisDot: +Math.abs(ax.dot(camDir)).toFixed(3),
      follow: +g.group.quaternion.angleTo(d.pivot.getWorldQuaternion(new T.Quaternion())).toFixed(4)
    };

    /* 中心方块：整体缩放（右拖变大 / 左拖变小，三轴同步） */
    g.setMode('scale');
    const uH = g.handles.find(h => h.kind === 'uniform');
    const s0 = d.pivot.scale.clone();
    await drag(uH, new T.Vector3(), 80, 0, 15);
    const s1 = d.pivot.scale.clone();
    await drag(uH, new T.Vector3(), -80, 0, 16);
    const s2 = d.pivot.scale.clone();
    out.uniform = {
      right: +(s1.x / s0.x).toFixed(2),
      left: +(s2.x / s1.x).toFixed(2),
      skew: +Math.max(Math.abs(s1.y / s0.y - s1.x / s0.x), Math.abs(s1.z / s0.z - s1.x / s0.x)).toFixed(4)
    };

    /* 悬停高亮 */
    g.setMode('translate');
    const hp = pickAt(xH, new T.Vector3(0, 0.21, 0));
    send('pointermove', hp.x, hp.y, 17);
    await new Promise(r => setTimeout(r, 60));
    out.hover = { kind: g._hover ? g._hover.kind : null, axis: g._hover ? g._hover.axis : null };

    /* 内圈：拖三色环 = 绕该环自己的轴旋转（环在结构上是一根轴，走 axis 分支）；
     * 旧代码把环标成 kind='ring'，pointerdown 没有这个分支 → 拿不到起点方向，拖了完全没反应。
     * 三只环的拾取管互相叠着，射线命中哪只由 gizmo 判定，所以基准轴取「拖动记录里的轴」。 */
    g.setMode('rotate');
    const rH = g.handles.find(h => h.kind === 'ring' && h.axis === 'y');
    let rp = null;
    for (const c of [[1, 0, 0], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, -1, 0]]) {
      rp = pickAt(rH, new T.Vector3(c[0], c[1], c[2]));
      send('pointermove', rp.x, rp.y, 18);
      await new Promise(r => setTimeout(r, 40));
      if (g._hover && g._hover.kind === 'ring') break;
    }
    const qR0 = d.pivot.quaternion.clone();
    const rc = pickAt(rH, new T.Vector3());
    const rad = { x: rp.x - rc.x, y: rp.y - rc.y };
    const rl = Math.hypot(rad.x, rad.y) || 1;
    const tx = -rad.y / rl, ty = rad.x / rl;      /* 屏幕上的切线方向 = 绕环拖动 */
    send('pointerdown', rp.x, rp.y, 18);
    const rKey = g.drag ? g.drag.axis : '';
    const rAxis = g.drag ? g.drag.dir.clone() : new T.Vector3();
    for (let i = 1; i <= 10; i++) send('pointermove', rp.x + tx * 90 * i / 10, rp.y + ty * 90 * i / 10, 18);
    send('pointerup', rp.x + tx * 90, rp.y + ty * 90, 18);
    await new Promise(r => setTimeout(r, 120));
    /* 世界空间的增量：q · q0⁻¹（premultiply 的旋转轴是世界轴，不能拿 q0⁻¹·q 来量） */
    const dqr = d.pivot.quaternion.clone().multiply(qR0.clone().invert());
    const angR = 2 * Math.acos(Math.min(1, Math.abs(dqr.w)));
    const axR = new T.Vector3(dqr.x, dqr.y, dqr.z);
    if (axR.length() > 1e-6) axR.normalize();
    out.ringRot = {
      axis: rKey, deg: +(angR * 180 / Math.PI).toFixed(1),
      axisDot: +Math.abs(axR.dot(rAxis)).toFixed(3)
    };
    return out;
  });
  check(giz.center.len > 0.05 && giz.center.dotCam < 0.01,
    '中心拖拽 = 屏幕空间平移（位移与视线垂直）', JSON.stringify(giz.center));
  check(giz.plane.len > 0.05 && giz.plane.dz < 0.005,
    '平面手柄 = 两轴平面内平移（XY 面不动 Z）', JSON.stringify(giz.plane));
  check(giz.axis.len > 0.05 && giz.axis.dy < 0.005 && giz.axis.dz < 0.005,
    '轴手柄 = 只沿该轴平移', JSON.stringify(giz.axis));
  check(Math.abs(giz.screenRot.deg - 68.8) < 6 && giz.screenRot.axisDot > 0.99 && giz.screenRot.follow < 0.001,
    '外圈 = 屏幕空间旋转，且旋转环跟随对象轴', JSON.stringify(giz.screenRot));
  check(giz.ringRot.deg > 5 && giz.ringRot.axisDot > 0.99,
    '内圈 = 绕该环自身轴旋转（拖了有反应）', JSON.stringify(giz.ringRot));
  check(giz.uniform.right > 1.2 && giz.uniform.left < 0.9 && giz.uniform.skew < 0.001,
    '中心方块整体缩放（右增大 / 左缩小 / 三轴同步）', JSON.stringify(giz.uniform));
  check(giz.hover.kind === 'axis' && giz.hover.axis === 'x', '悬停手柄高亮', JSON.stringify(giz.hover));

  /* 11.13 挤出：工具一启动就弹属性面板（厚度 / 局部平移 Z / 偏移 / 分段 / 保持面的连续性）；
   * 关闭连接性 = 每张面各自挤出（各长 4 面侧壁），开启 = 整块壳体（只在区域外边界长 6 面，
   * 内部共享边上没有隐藏的内接面）。 */
  const ext = await page.evaluate(async () => {
    const d = window.modelDesk.__debug();
    const API = window.modelDesk;
    const m = d.mesh;
    /* 找一对共享一条边的四边形面 */
    const first = Object.create(null);
    let pair = null;
    for (let f = 0; f < m.faceIds.length && !pair; f++) {
      const s = m.faceOffsets[f], e = m.faceOffsets[f + 1], n = e - s;
      if (n !== 4) continue;
      for (let c = 0; c < n; c++) {
        const a = m.faceIndices[s + c], b = m.faceIndices[s + (c + 1) % n];
        const k = a < b ? a + '_' + b : b + '_' + a;
        if (first[k] != null && first[k] !== f) { pair = [first[k], f]; break; }
        first[k] = f;
      }
    }
    const ids = [m.faceIds[pair[0]], m.faceIds[pair[1]]];
    const doc = API.getDocument();
    doc.selection = {
      mode: 'face', nodeIds: doc.selection.nodeIds || [],
      vertexIds: [], edgeIds: [], faceIds: ids
    };
    API.reselect();
    window.SeedCommands.run('mesh.extrude', {});
    await new Promise(r => setTimeout(r, 150));

    const panel = document.getElementById('mdToolPanel');
    const rows = panel ? Array.from(panel.querySelectorAll('.md-hbp-row > span')).map(s => s.textContent) : [];
    const sw = panel ? panel.querySelector('.md-tp-sw') : null;
    const live0 = window.modelDesk.getState().toolLive;
    const preview0 = !!d.scene.getObjectByName('tool-preview-mesh');
    const toggle0 = sw ? { text: sw.textContent.trim(), on: sw.classList.contains('on') } : null;
    /* 默认厚度必须是 0：一启动就沿法线顶出去 0.1 不是「开始挤出」，是「已经挤出过」 */
    const defDist = +Number(((window.SeedTools.current() || {}).params || {}).dist).toFixed(3);
    /* 数值参数全部用滑条：range 数量 = 四个数值参数，number 输入应为 0，右侧读数和参数一致 */
    const slider = {
      ranges: panel ? panel.querySelectorAll('input[type="range"]').length : 0,
      numbers: panel ? panel.querySelectorAll('input[type="number"]').length : 0,
      marks: panel ? Array.from(panel.querySelectorAll('[data-tp-out]')).map(b => b.textContent) : [],
      defDist: defDist
    };

    /* 面板上改厚度 → 预览立刻重算（不需要重新点工具） */
    const thick = panel ? panel.querySelector('input[data-tp="0"]') : null;
    if (thick) {
      thick.value = '0.25';
      thick.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 80));
    const live1 = window.modelDesk.getState().toolLive;
    const preview1 = !!d.scene.getObjectByName('tool-preview-mesh');
    /* 拖动滑条后，右侧读数必须同步成 0.25 */
    const mark1 = panel ? (panel.querySelector('[data-tp-out="0"]') || {}).textContent : '';

    /* 关掉「保持面的连续性」→ 预览还在，参数为 0 */
    if (sw) sw.click();
    await new Promise(r => setTimeout(r, 80));
    const offState = (window.SeedTools.current() || {}).params || null;

    /* × = 取消：面板收起、预览清掉、网格不动 */
    const closers = panel ? panel.querySelector('[data-tp-act="close"]') : null;
    if (closers) closers.click();
    await new Promise(r => setTimeout(r, 120));
    const afterCancel = {
      panel: !!document.getElementById('mdToolPanel'),
      live: window.modelDesk.getState().toolLive,
      preview: !!d.scene.getObjectByName('tool-preview-mesh')
    };

    const base = { faces: m.faceIds.length, verts: m.vertexIds.length };
    const E = o => window.SeedOps.extrudeFaces(m, Object.assign({ faceIds: ids, dist: 0.1 }, o));
    const on = E({ keepTogether: true });
    const off = E({ keepTogether: false });
    const div = E({ keepTogether: true, divisions: 2 });
    const plain = E({ keepTogether: true, dist: 0.1, offset: 0 });
    const inset = E({ keepTogether: true, dist: 0.1, offset: -0.05 });
    const area = mesh => {
      let sum = 0, p = mesh.positions;
      for (let f = 0; f < mesh.faceIds.length; f++) {
        if (ids.indexOf(mesh.faceIds[f]) < 0) continue;
        const s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1], n = e - s;
        let ax = 0, ay = 0, az = 0;
        for (let c = 0; c < n; c++) {
          const i = mesh.faceIndices[s + c], j = mesh.faceIndices[s + ((c + 1) % n)];
          ax += p[i * 3] * p[j * 3 + 1] - p[j * 3] * p[i * 3 + 1];
          ay += p[i * 3 + 1] * p[j * 3 + 2] - p[j * 3 + 1] * p[i * 3 + 2];
          az += p[i * 3 + 2] * p[j * 3] - p[j * 3 + 2] * p[i * 3];
        }
        sum += Math.sqrt(ax * ax + ay * ay + az * az) * 0.5;
      }
      return sum;
    };
    return {
      pairing: pair, ids: ids,
      rows, toggle0, live0, preview0, live1, preview1, offState,
      slider, mark1,
      afterCancel,
      base,
      on: { faces: on.faceIds.length - base.faces, verts: on.vertexIds.length - base.verts },
      off: { faces: off.faceIds.length - base.faces, verts: off.vertexIds.length - base.verts },
      div: { faces: div.faceIds.length - base.faces, verts: div.vertexIds.length - base.verts },
      areaPlain: +area(plain).toFixed(4), areaInset: +area(inset).toFixed(4)
    };
  });
  check(ext.pairing && ext.rows.length === 5 &&
    ext.rows.join('|') === '厚度|局部平移 Z|偏移|分段|保持面的连续性',
    '挤出后弹出属性面板（五个参数齐全）', JSON.stringify(ext.rows));
  check(ext.toggle0 && ext.toggle0.text === '启用' && ext.toggle0.on && ext.live0 && ext.preview0,
    '面板绑在工具会话上（默认保持连接 + 实时预览）', JSON.stringify({ t: ext.toggle0, live: ext.live0, pv: ext.preview0 }));
  check(ext.slider && ext.slider.defDist === 0 && ext.slider.marks[0] === '0.00',
    '挤出默认厚度为 0（箭头停在面上，不是先顶出去）', JSON.stringify(ext.slider));
  check(ext.slider && ext.slider.ranges === 4 && ext.slider.numbers === 0 && ext.mark1 === '0.25',
    '数值参数全是滑条（4 个 range / 0 个 number），读数随拖动同步', JSON.stringify({ slider: ext.slider, mark1: ext.mark1 }));
  check(ext.live1 && ext.preview1 && ext.offState && ext.offState.keep === 0,
    '面板改厚度 / 切开关都实时重算预览', JSON.stringify({ live: ext.live1, pv: ext.preview1, keep: ext.offState && ext.offState.keep }));
  check(ext.afterCancel.live === false && ext.afterCancel.panel === false && ext.afterCancel.preview === false,
    '面板 × = 取消会话（预览与面板一起收起）', JSON.stringify(ext.afterCancel));

  /* 货架入口：点一下必须**留下**参数面板并进入 live 会话。
   * 以前的 bug 是走 runToolNow → 立刻 commit，面板只闪一帧，用户根本看不到。 */
  const shelfExtrude = await page.evaluate(async () => {
    const btn = document.querySelector('.md-shelf [data-md-op="extrude"]');
    if (!btn) return { btn: false };
    btn.click();
    await new Promise(r => setTimeout(r, 180));
    const panel = document.getElementById('mdToolPanel');
    const out = {
      btn: true,
      panel: !!panel,
      live: window.modelDesk.getState().toolLive,
      rows: panel ? panel.querySelectorAll('.md-hbp-row').length : 0,
      title: panel ? (panel.querySelector('.md-hbp-h b') || {}).textContent || '' : '',
      preview: !!window.modelDesk.__debug().scene.getObjectByName('tool-preview-mesh')
    };
    if (panel) {
      const wr = document.getElementById('modelDeskWin').getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      out.insideWin = pr.left >= wr.left - 1 && pr.right <= wr.right + 1 &&
        pr.top >= wr.top - 1 && pr.bottom <= wr.bottom + 1;
      out.rect = { l: Math.round(pr.left), t: Math.round(pr.top), w: Math.round(pr.width) };
    }
    const closer = panel && panel.querySelector('[data-tp-act="close"]');
    if (closer) closer.click();
    await new Promise(r => setTimeout(r, 100));
    out.afterClose = { panel: !!document.getElementById('mdToolPanel'), live: window.modelDesk.getState().toolLive };
    return out;
  });
  check(shelfExtrude.btn && shelfExtrude.panel && shelfExtrude.live && shelfExtrude.rows === 5,
    '货架点「挤出」留下参数面板（不再闪一帧就提交）', JSON.stringify(shelfExtrude));
  check(shelfExtrude.insideWin === true,
    '参数面板落在建模窗口内（窗口没最大化也不会跑到屏幕角落）', JSON.stringify(shelfExtrude.rect));
  check(shelfExtrude.afterClose && shelfExtrude.afterClose.panel === false && shelfExtrude.afterClose.live === false,
    '货架挤出的面板可关闭并干净取消', JSON.stringify(shelfExtrude.afterClose));
  check(ext.on.faces === 6 && ext.on.verts === 6,
    '保持连接：只在区域外边界长 6 面、共享边共用 6 个新点（无内部隐藏面）', JSON.stringify(ext.on));
  check(ext.off.faces === 8 && ext.off.verts === 8,
    '关闭连接：两张面各自挤出（每张各 4 面侧壁 + 4 个新点）', JSON.stringify(ext.off));
  check(ext.div.faces === 12 && ext.div.verts === 12,
    '分段 2：侧壁拆成两圈（顶面仍是一张面）', JSON.stringify(ext.div));
  check(ext.areaInset < ext.areaPlain * 0.95 && ext.areaPlain > 0,
    '偏移 -0.05 让顶面内缩', 'plain=' + ext.areaPlain + ' inset=' + ext.areaInset);



  /* 11.5 UV 编辑器（X5a–X5e）：窗口结构 / 画布 / 拾取 / 变换 / 撤销 / 展开排布 */
  const uvOpen = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-md-act="uv"]')];
    if (!btns.length) return { ok: false };
    btns[0].click();
    return { ok: true, clicked: btns.length };
  });
  await page.waitForTimeout(360);
  const uvSt0 = await page.evaluate(() => window.modelDesk.getState());
  check(uvOpen.ok && uvSt0.uvOpen && !!await page.$('#mdUvWin'), 'Shelf ◒ 打开 UV 编辑器窗口',
    JSON.stringify({ clicked: uvOpen.clicked, open: uvSt0.uvOpen }));

  const uvUi = await page.evaluate(() => {
    const win = document.getElementById('mdUvWin');
    if (!win) return null;
    return {
      title: win.querySelector('.md-uv-head b').textContent,
      menus: [...win.querySelectorAll('.md-uv-mitem')].map(b => b.textContent),
      groups: [...win.querySelectorAll('.md-uvk-gt span')].map(b => b.textContent),
      kit: (win.querySelector('.md-uvk-head b') || {}).textContent,
      modes: [...win.querySelectorAll('.md-uv-tools [data-uvact^="mode"]')].length,
      canvas: !!document.getElementById('mdUvCanvas'),
      tex: (win.querySelector('.md-uv-tex') || {}).textContent,
      hint: (document.getElementById('mdUvHint') || {}).textContent
    };
  });
  check(!!uvUi && uvUi.title === 'UV 编辑器' && uvUi.kit === 'UV 工具包' && uvUi.canvas,
    '标题栏 / UV 工具包 / 画布都在', uvUi && JSON.stringify({ title: uvUi.title, kit: uvUi.kit }));
  check(!!uvUi && uvUi.menus.length === 11 && uvUi.menus.indexOf('切割/缝合') >= 0,
    '11 个菜单（编辑 / 创建 / 选择 / 切割缝合 / 修改 / 工具 / 视图 / 图像 / 纹理 / UV 集 / 帮助）',
    uvUi && uvUi.menus.join('|'));
  check(!!uvUi && uvUi.groups.join('|') === '固定|按类型选择|软选择|变换|创建|切割和缝合|展开|对齐和捕捉|排列和布局',
    '工具包 9 个折叠组与截图同名同序', uvUi && uvUi.groups.join('|'));

  const uvPix = await page.evaluate(() => {
    const c = document.getElementById('mdUvCanvas');
    if (!c) return null;
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    let cyan = 0, orange = 0, ink = 0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i + 1], b = img[i + 2];
      if (Math.abs(r - 35) + Math.abs(g - 35) + Math.abs(b - 35) > 26) ink++;
      if (r < 130 && g > 140 && b > 160) cyan++;
      if (r > 170 && g > 100 && b < 130) orange++;
    }
    return { w: c.width, h: c.height, cyan, orange, ink };
  });
  check(!!uvPix && uvPix.w > 300 && uvPix.h > 200 && uvPix.cyan + uvPix.orange > 300 && uvPix.ink > 1000,
    '画布真的画出 UV 壳 + 网格（不是空画布）', uvPix && JSON.stringify(uvPix));

  /* 点选：按 uvState 的视图变换把面角 0 换算成屏幕坐标，再真实点一下 */
  const uvPick = await page.evaluate(() => {
    const d = window.modelDesk.__debug();
    const uv = window.modelDesk.uvState();
    const c = document.getElementById('mdUvCanvas');
    if (!d.mesh || !c || !uv.canvas) return null;
    const rect = c.getBoundingClientRect();
    const meshes = d.mesh;
    let pick = null;
    for (let k = 0; k < meshes.faceIndices.length; k++) {
      const u = meshes.uvs[k * 2], v = meshes.uvs[k * 2 + 1];
      const x = rect.left + uv.canvas.w / 2 + (u - uv.view.cu) * uv.view.scale;
      const y = rect.top + uv.canvas.h / 2 - (v - uv.view.cv) * uv.view.scale;
      if (x > rect.left + 40 && x < rect.right - 12 && y > rect.top + 40 && y < rect.bottom - 12) {
        pick = { corner: k, u, v, x, y }; break;
      }
    }
    return pick;
  });
  check(!!uvPick, '找到一个可见面角用于点选', uvPick && JSON.stringify({ corner: uvPick.corner }));
  if (uvPick) {
    await page.mouse.click(uvPick.x, uvPick.y);
    await page.waitForTimeout(140);
  }
  const uvSel = await page.evaluate(() => {
    const s = window.modelDesk.getState();
    return { corners: s.uvSelCorners, faces: s.uvSelFaces, mode: s.uvMode, selMode: s.selMode, selFace: s.selFace };
  });
  check(uvSel.corners > 0 && uvSel.faces > 0 && uvSel.selFace > 0,
    '点选 UV 点 → UV 选择集非空，并同步到 3D 面选择', JSON.stringify(uvSel));

  const uvDrag0 = await page.evaluate(corner => {
    const s = window.modelDesk.getState();
    const d = window.modelDesk.__debug();
    return { u: d.mesh.uvs[corner * 2], v: d.mesh.uvs[corner * 2 + 1], undo: s.undo, scale: s.uvScale };
  }, uvPick ? uvPick.corner : 0);
  if (uvPick) {
    await page.mouse.move(uvPick.x, uvPick.y);
    await page.mouse.down();
    await page.mouse.move(uvPick.x + 40, uvPick.y + 20, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(160);
  }
  const uvDrag1 = await page.evaluate(corner => {
    const s = window.modelDesk.getState();
    const d = window.modelDesk.__debug();
    return { u: d.mesh.uvs[corner * 2], v: d.mesh.uvs[corner * 2 + 1], undo: s.undo };
  }, uvPick ? uvPick.corner : 0);
  const du = uvDrag1.u - uvDrag0.u, dv = uvDrag1.v - uvDrag0.v;
  check(Math.abs(du - 40 / uvDrag0.scale) < 0.02 && Math.abs(dv + 20 / uvDrag0.scale) < 0.02,
    '拖动 UV 点按屏幕像素换算成 UV 位移（右 +40 / 下 +20）',
    JSON.stringify({ du: +du.toFixed(4), dv: +dv.toFixed(4), expect: [+(40 / uvDrag0.scale).toFixed(4), +(-20 / uvDrag0.scale).toFixed(4)] }));
  check(uvDrag1.undo === uvDrag0.undo + 1, '一次 UV 拖动只进一条历史', uvDrag0.undo + ' → ' + uvDrag1.undo);

  const uvUndo = await page.evaluate(corner => {
    window.modelDesk.undo();
    const d = window.modelDesk.__debug();
    const s = window.modelDesk.getState();
    return { u: d.mesh.uvs[corner * 2], v: d.mesh.uvs[corner * 2 + 1], undo: s.undo };
  }, uvPick ? uvPick.corner : 0);
  check(Math.abs(uvUndo.u - uvDrag0.u) < 1e-9 && Math.abs(uvUndo.v - uvDrag0.v) < 1e-9,
    'Ctrl+Z / undo 还原 UV 坐标', JSON.stringify({ before: uvDrag0.u.toFixed(4), after: uvUndo.u.toFixed(4) }));

  const uvSelOps = await page.evaluate(() => {
    const before = window.modelDesk.getState();
    window.modelDesk.uvCommand('selAll');
    const all = { corners: window.modelDesk.getState().uvSelCorners, total: window.modelDesk.__debug().mesh.faceIndices.length };
    window.modelDesk.uvCommand('selNone');
    const none = window.modelDesk.getState().uvSelCorners;
    window.modelDesk.uvCommand('selInvert');
    const inv = window.modelDesk.getState().uvSelCorners;
    return { all, none, inv };
  });
  check(uvSelOps.all.corners === uvSelOps.all.total && uvSelOps.none === 0 && uvSelOps.inv > 0,
    '全选 / 清除 / 反向选择按面角工作', JSON.stringify(uvSelOps));

  /* 自动展开：清空选择 → 对全网格跑；断言 UV 全在 0–1 内、岛之间不重叠 */
  const uvUnwrap = await page.evaluate(() => {
    window.modelDesk.uvCommand('selNone');
    const undo0 = window.modelDesk.getState().undo;
    const ok = window.modelDesk.uvCommand('unwrap');
    const s = window.modelDesk.getState();
    const d = window.modelDesk.__debug();
    const m = d.mesh;
    const uvs = m.uvs;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < uvs.length; i += 2) {
      if (uvs[i] < minU) minU = uvs[i];
      if (uvs[i] > maxU) maxU = uvs[i];
      if (uvs[i + 1] < minV) minV = uvs[i + 1];
      if (uvs[i + 1] > maxV) maxV = uvs[i + 1];
    }
    const isl = window.SeedModel.Mesh.uvIslands(m);
    const boxes = isl.islands.map(is => {
      let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
      for (const f of is.faces) {
        for (let k = m.faceOffsets[f]; k < m.faceOffsets[f + 1]; k++) {
          const u = uvs[k * 2], v = uvs[k * 2 + 1];
          if (u < a) a = u; if (u > c) c = u; if (v < b) b = v; if (v > e) e = v;
        }
      }
      return { a, b, c, e };
    });
    let overlap = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i], B = boxes[j];
      const w = Math.min(A.c, B.c) - Math.max(A.a, B.a);
      const h = Math.min(A.e, B.e) - Math.max(A.b, B.b);
      if (w > 1e-6 && h > 1e-6) overlap++;
    }
    return {
      ok, islands: isl.islands.length, overlap,
      minU: +minU.toFixed(4), maxU: +maxU.toFixed(4), minV: +minV.toFixed(4), maxV: +maxV.toFixed(4),
      undo: s.undo - undo0, faces: m.faceIds.length
    };
  });
  check(uvUnwrap.ok && uvUnwrap.undo === 1 && uvUnwrap.islands > 0,
    '自动展开按壳拍平并记一条历史', JSON.stringify(uvUnwrap));
  check(uvUnwrap.minU >= -1e-6 && uvUnwrap.maxU <= 1 + 1e-6 && uvUnwrap.minV >= -1e-6 && uvUnwrap.maxV <= 1 + 1e-6,
    '展开后 UV 全部落在 0–1 空格内', JSON.stringify({ u: [uvUnwrap.minU, uvUnwrap.maxU], v: [uvUnwrap.minV, uvUnwrap.maxV] }));
  check(uvUnwrap.overlap === 0, '展开后排布的 UV 岛之间没有包围盒重叠', '重叠对数=' + uvUnwrap.overlap + ' / ' + uvUnwrap.islands + ' 岛');

  const uvToggles = await page.evaluate(() => {
    const g = document.querySelector('#mdUvWin [data-uvact="grid"]');
    const sn = document.querySelector('#mdUvWin [data-uvact="snap"]');
    const before = window.modelDesk.getState();
    if (g) g.click();
    if (sn) sn.click();
    const after = window.modelDesk.getState();
    return { grid: [before.uvGrid, after.uvGrid], snap: [before.uvSnap, after.uvSnap] };
  });
  check(uvToggles.grid[0] !== uvToggles.grid[1] && uvToggles.snap[0] !== uvToggles.snap[1],
    '工具栏「网格 / 吸附」按钮真的切换状态', JSON.stringify(uvToggles));

  const uvMenu = await page.evaluate(() => {
    const btn = document.querySelector('#mdUvWin .md-uv-mitem');
    btn.click();
    const drop = document.getElementById('mdUvDrop');
    const items = [...drop.querySelectorAll('.md-uv-mi')].map(b => b.querySelector('span').textContent);
    const shown = !drop.hidden;
    btn.click();
    return { label: btn.textContent, shown, items, closed: drop.hidden };
  });
  check(uvMenu.shown && uvMenu.items.indexOf('撤销') >= 0 && uvMenu.closed,
    '菜单能展开 / 收起，编辑菜单含撤销等命令', JSON.stringify({ label: uvMenu.label, items: uvMenu.items.length }));

  /* 11.6 X5f 已落地的一半：圆柱/球形投影、棋盘格、缝合、点击提示 */
  const uvProj = await page.evaluate(() => {
    const s0 = window.modelDesk.getState();
    const okCyl = window.modelDesk.uvCommand('projCyl');
    const okSph = window.modelDesk.uvCommand('projSphere');
    const m = window.modelDesk.__debug().mesh;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < m.uvs.length; i += 2) {
      if (m.uvs[i] < minU) minU = m.uvs[i];
      if (m.uvs[i] > maxU) maxU = m.uvs[i];
      if (m.uvs[i + 1] < minV) minV = m.uvs[i + 1];
      if (m.uvs[i + 1] > maxV) maxV = m.uvs[i + 1];
    }
    return {
      okCyl, okSph, undo: window.modelDesk.getState().undo - s0.undo,
      u: [+minU.toFixed(4), +maxU.toFixed(4)], v: [+minV.toFixed(4), +maxV.toFixed(4)]
    };
  });
  check(uvProj.okCyl && uvProj.okSph && uvProj.undo >= 1 &&
    uvProj.u[0] >= -1e-6 && uvProj.u[1] <= 1 + 1e-6 && uvProj.v[0] >= -1e-6 && uvProj.v[1] <= 1 + 1e-6,
    '圆柱 / 球形投影可用且归一化到 0–1', JSON.stringify(uvProj));

  const uvTex = await page.evaluate(() => {
    const c = document.getElementById('mdUvCanvas');
    const ctx = c.getContext('2d');
    const sum = () => {
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      return s;
    };
    const before = sum();
    document.getElementById('mdUvTex').click();
    const after = sum();
    return { tex: window.modelDesk.getState().uvTex, before, after, label: document.getElementById('mdUvTex').textContent };
  });
  check(uvTex.tex && Math.abs(uvTex.after - uvTex.before) > 50000 && /棋盘格/.test(uvTex.label),
    '棋盘格底图开关真正改画布像素（浅色底上变暗也算）', JSON.stringify({ tex: uvTex.tex, delta: uvTex.after - uvTex.before, label: uvTex.label }));

  const uvStitch = await page.evaluate(() => {
    document.querySelector('#mdUvWin [data-uvact="selAll"]').click();
    const d = window.modelDesk.__debug();
    const m = d.mesh;
    const s = m.faceOffsets[0], e = m.faceOffsets[1];
    const before = [m.uvs[s * 2], m.uvs[s * 2 + 1]];
    for (let k = s; k < e; k++) { m.uvs[k * 2] += 0.015; m.uvs[k * 2 + 1] += 0.008; }
    window.SeedModel.Mesh.bump(m);
    const moved = [m.uvs[s * 2], m.uvs[s * 2 + 1]];
    const u0 = window.modelDesk.getState().undo;
    window.modelDesk.uvCommand('stitch');
    const after = [window.modelDesk.__debug().mesh.uvs[s * 2], window.modelDesk.__debug().mesh.uvs[s * 2 + 1]];
    return { before, moved, after, undo: window.modelDesk.getState().undo - u0, toast: document.getElementById('mdUvToast').textContent };
  });
  check(uvStitch.undo === 1 && Math.abs(uvStitch.after[0] - uvStitch.moved[0]) > 1e-4,
    '缝合把 2% 容差内的选中 UV 点吸到平均位置', JSON.stringify(uvStitch));

  const uvToast = await page.evaluate(() => {
    const mi = [...document.querySelectorAll('#mdUvWin .md-uv-mitem')].find(b => b.textContent === 'UV 集');
    mi.click();
    const todo = [...document.querySelectorAll('#mdUvDrop .md-uv-mi')].find(b => b.dataset.uvtodo);
    if (todo) todo.click();
    const el = document.getElementById('mdUvToast');
    return { has: !!el, on: el.classList.contains('on'), text: el.textContent, todo: !!todo };
  });
  check(uvToast.has && uvToast.todo && uvToast.on && uvToast.text.length > 0,
    '点未实现菜单项时画布内有可见提示（不是「点了没反应」）', JSON.stringify(uvToast));

  /* X5g：沿边切割 / 分离 UV 壳 / 图片底图 */
  /* 先点一个 UV 点，让选择集落在「一个角 + 它周围的几个面」上（与真实操作一致） */
  const seamPoint = await page.evaluate(() => {
    const desk = window.modelDesk;
    desk.uvCommand('selNone');
    desk.uvCommand('modePoint');
    const uv = desk.uvState();
    const d = desk.__debug();
    const c = document.getElementById('mdUvCanvas');
    const rect = c.getBoundingClientRect();
    for (let k = 0; k < d.mesh.faceIndices.length; k++) {
      const u = d.mesh.uvs[k * 2], v = d.mesh.uvs[k * 2 + 1];
      const x = rect.left + uv.canvas.w / 2 + (u - uv.view.cu) * uv.view.scale;
      const y = rect.top + uv.canvas.h / 2 - (v - uv.view.cv) * uv.view.scale;
      if (x > rect.left + 40 && x < rect.right - 12 && y > rect.top + 40 && y < rect.bottom - 12) {
        return { corner: k, x, y };
      }
    }
    return null;
  });
  check(!!seamPoint, '找到一个可见 UV 点用于切割', seamPoint && JSON.stringify({ corner: seamPoint.corner }));
  if (seamPoint) {
    await page.mouse.click(seamPoint.x, seamPoint.y);
    await page.waitForTimeout(160);
  }
  const uvSeam = await page.evaluate(() => {
    const desk = window.modelDesk;
    const Mesh = window.SeedModel.Mesh;
    const m0 = desk.__debug().mesh;
    const seams0 = Mesh.seamCount(m0);
    const isl0 = Mesh.uvIslands(m0).islands.length;
    const faces0 = m0.faceIds.length;
    const selFaces = desk.getState().uvSelFaces;
    const ok = desk.uvCommand('seamCut');
    const m1 = desk.__debug().mesh;
    return {
      ok, selFaces, seams0, seams1: Mesh.seamCount(m1),
      isl0, isl1: Mesh.uvIslands(m1).islands.length,
      faces0, faces1: m1.faceIds.length
    };
  });
  check(uvSeam.ok && uvSeam.selFaces > 0 && uvSeam.seams1 > uvSeam.seams0,
    '沿边切割把选中面的边界落成 UV 缝（岛按缝重算）', JSON.stringify(uvSeam));
  check(uvSeam.isl1 >= uvSeam.isl0,
    '切割后 UV 岛数量只增不减（缝真的阻断合并）', uvSeam.isl0 + ' → ' + uvSeam.isl1);
  check(uvSeam.faces1 === uvSeam.faces0,
    '切割只改 UV 缝标记，不改拓扑（面数不变）', uvSeam.faces0 + ' → ' + uvSeam.faces1);

  const uvSep = await page.evaluate(() => {
    const desk = window.modelDesk;
    const Mesh = window.SeedModel.Mesh;
    const undo0 = desk.getState().undo;
    const ok = desk.uvCommand('sepShells');
    const m = desk.__debug().mesh;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < m.uvs.length; i += 2) {
      if (m.uvs[i] < minU) minU = m.uvs[i];
      if (m.uvs[i] > maxU) maxU = m.uvs[i];
      if (m.uvs[i + 1] < minV) minV = m.uvs[i + 1];
      if (m.uvs[i + 1] > maxV) maxV = m.uvs[i + 1];
    }
    return {
      ok, undo: desk.getState().undo - undo0, seams: Mesh.seamCount(m),
      islands: Mesh.uvIslands(m).islands.length, faces: m.faceIds.length,
      u: [+minU.toFixed(4), +maxU.toFixed(4)], v: [+minV.toFixed(4), +maxV.toFixed(4)]
    };
  });
  check(uvSep.ok && uvSep.undo === 1 && uvSep.islands > 1,
    '分离 UV 壳：边界切开后按 2% 间隙重新排布', JSON.stringify(uvSep));
  check(uvSep.u[0] >= -1e-6 && uvSep.u[1] <= 1 + 1e-6 && uvSep.v[0] >= -1e-6 && uvSep.v[1] <= 1 + 1e-6,
    '分离后 UV 仍在 0–1 空格内', JSON.stringify({ u: uvSep.u, v: uvSep.v }));

  const uvSeamUndo = await page.evaluate(() => {
    const desk = window.modelDesk;
    const Mesh = window.SeedModel.Mesh;
    desk.undo();   /* 分离壳 */
    desk.undo();   /* 沿边切割 */
    const m = desk.__debug().mesh;
    return { seams: Mesh.seamCount(m), faces: m.faceIds.length };
  });
  check(uvSeamUndo.seams === uvSeam.seams0 && uvSeamUndo.faces === uvSeam.faces0,
    '撤销还原 UV 缝（缝标记进指纹与历史）', JSON.stringify({ seams: uvSeamUndo.seams, faces: uvSeamUndo.faces }));

  const texFile = RUN.artifact('uvtex.svg');
  fs.writeFileSync(texFile, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
    '<rect width="32" height="32" fill="#ff2d55"/></svg>');
  const redCount = await page.evaluate(() => {
    const c = document.getElementById('mdUvCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 130) red++;
    }
    return red;
  });
  await page.setInputFiles('#mdUvFile', texFile);
  await page.waitForTimeout(600);
  const uvImg = await page.evaluate(() => {
    const desk = window.modelDesk;
    const c = document.getElementById('mdUvCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 130) red++;
    }
    return {
      red, image: desk.getState().uvImage, name: desk.getState().uvImageName,
      tex: desk.getState().uvTex
    };
  });
  check(uvImg.image && /uvtex\.svg$/i.test(uvImg.name || '') && uvImg.red > redCount + 200,
    '载入图片后 0–1 范围铺上真实底图（画布像素变化）', JSON.stringify(uvImg));
  check(uvImg.tex === false, '载入图片时自动关闭棋盘格（避免底图发花）', 'tex=' + uvImg.tex);

  const uvImgClear = await page.evaluate(() => {
    window.modelDesk.uvCommand('imgClear');
    const c = document.getElementById('mdUvCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 130) red++;
    }
    return { image: window.modelDesk.getState().uvImage, red };
  });
  check(!uvImgClear.image && uvImgClear.red < uvImg.red,
    '清除图片底图后画布恢复（不写文档也能退出）', JSON.stringify(uvImgClear));


  /* 线框必须按拓扑画：平面上的 4 张四边面 = 12 条边都要出来。
   * 旧实现按相邻面法线过滤（共面内部边隐藏），这里只剩 8 条，正好把环切 / 细分线吞掉。 */
  const wire = await page.evaluate(async () => {
    const M = window.SeedModel.Mesh;
    const m = M.create();
    m.positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1, 0, 0, 2, 1, 0, 2, 2, 0, 2];
    m.vertexIds = [0, 1, 2, 3, 4, 5, 6, 7, 8]; m.nextVertexId = 9;
    m.faceOffsets = [0, 4, 8, 12, 16];
    m.faceIndices = [0, 1, 4, 3, 1, 2, 5, 4, 3, 4, 7, 6, 4, 5, 8, 7];
    m.faceIds = [0, 1, 2, 3]; m.faceSlots = [0, 0, 0, 0]; m.nextFaceId = 4;
    M.bump(m);
    const beforeFaces = window.modelDesk.getState().faces;
    window.modelDesk.applyMesh(m, 'probe:wireframe');
    await new Promise(r => requestAnimationFrame(r));
    const d = window.modelDesk.__debug();
    const seg = d.edgeLines ? d.edgeLines.geometry.attributes.position.count / 2 : -1;
    const topo = M.ensureEdges(d.mesh).edges.length;
    window.modelDesk.undo();
    await new Promise(r => requestAnimationFrame(r));
    return { seg, topo, beforeFaces, faces: window.modelDesk.getState().faces };
  });
  check(wire.seg === wire.topo && wire.topo === 12 && wire.faces === wire.beforeFaces,
    '线框按实际拓扑画满每条边（共面内部边不再被面法线过滤）', JSON.stringify(wire));


  /* X6：环切（四边环）/ 循环边选择内核 */
  const loopCore = await page.evaluate(() => {
    const M = window.SeedModel.Mesh, Ops = window.SeedOps;
    function grid() {
      const m = M.create();
      const pos = [], ids = [], idx = [];
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) { ids.push(y * 3 + x); pos.push(x / 2, y / 2, 0); }
      }
      const quads = [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]];
      quads.forEach(q => q.forEach(v => idx.push(v)));
      m.positions = pos; m.vertexIds = ids; m.nextVertexId = 9;
      m.faceOffsets = [0]; quads.forEach((q, i) => m.faceOffsets.push((i + 1) * 4));
      m.faceIndices = idx; m.faceIds = [0, 1, 2, 3]; m.faceSlots = [0, 0, 0, 0]; m.nextFaceId = 4;
      m.uvs = []; idx.forEach(v => { m.uvs.push((v % 3) / 2, Math.floor(v / 3) / 2); });
      M.bump(m);
      return m;
    }
    const m = grid();
    const ring = Ops.edgeRing(m, 1, 4);
    if (!ring) return { ring: null };
    const cut = Ops.loopCut(m, { aId: 1, bId: 4, count: 1, slide: 0 });
    const allQuad = cut.faceOffsets.every((o, i) => i === 0 || cut.faceOffsets[i] - cut.faceOffsets[i - 1] === 4);
    const m2 = grid();
    const cut2 = Ops.loopCut(m2, { aId: 1, bId: 4, count: 1, slide: 0.3 });
    let mid = null, midCount = 0;
    for (let i = 0; i < cut2.vertexIds.length; i++) {
      if (cut2.vertexIds[i] >= 9) {
        const x = cut2.positions[i * 3], y = cut2.positions[i * 3 + 1];
        if (Math.abs(x - 0.5) < 1e-6) { midCount++; if (!mid) mid = { x: +x.toFixed(4), y: +y.toFixed(4), id: cut2.vertexIds[i] }; }
      }
    }
    const tri = M.create();
    tri.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]; tri.vertexIds = [0, 1, 2]; tri.nextVertexId = 3;
    tri.faceOffsets = [0, 3]; tri.faceIndices = [0, 1, 2]; tri.faceIds = [0]; tri.faceSlots = [0]; tri.nextFaceId = 1;
    tri.uvs = [0, 0, 1, 0, 0, 1]; M.bump(tri);
    const triCut = Ops.loopCut(tri, { aId: 0, bId: 1, count: 1, slide: 0 });
    const edges = M.ensureEdges(m);
    let loopRec = null;
    edges.edges.forEach(r => { if (r.aId === 1 && r.bId === 4) loopRec = r; });
    const loop = loopRec ? window.SeedSelection.edgeLoop(m, loopRec.id) : [];
    return {
      ring: true,
      ringFaces: ring.faces.length, ringEdges: ring.edges.length, ringClosed: ring.closed,
      faces: cut.faceIds.length, verts: cut.vertexIds.length, allQuad,
      mid, midCount, triRefused: triCut === null, loop: loop.length,
      tool: !!window.SeedTools.lookup('tool.loopcut'),
      params: (window.SeedTools.lookup('tool.loopcut') || {}).params ? window.SeedTools.lookup('tool.loopcut').params.length : 0
    };
  });
  check(loopCore.ring && loopCore.ringFaces === 2 && loopCore.ringEdges === 3 && !loopCore.ringClosed,
    '边环遍历：选中边所在环认出 2 张四边面 / 3 条环边', JSON.stringify(loopCore));
  check(loopCore.faces === 6 && loopCore.verts === 12 && loopCore.allQuad,
    '环切：2 张四边面切成 4 张，总面数 4 → 6，新面全是四边', JSON.stringify({ faces: loopCore.faces, verts: loopCore.verts }));
  check(loopCore.mid && loopCore.midCount === 1 && Math.abs(loopCore.mid.y - 0.3235) < 0.01,
    '滑移 0.3（t=0.647）时环边只有一个共享切点，反向半边没有错开', JSON.stringify({ mid: loopCore.mid, n: loopCore.midCount }));
  check(loopCore.triRefused, '三角面 / n 边环拒绝环切（不留 T 形接点）', 'triCut=' + loopCore.triRefused);
  check(loopCore.loop === 2, '循环边选择：3×3 网格上 1-4 边得到 1-4 / 4-7 两条边', 'loop=' + loopCore.loop);
  check(loopCore.tool && loopCore.params === 2,
    '环切已注册为 live 工具（条数 / 滑移两个参数）', JSON.stringify({ tool: loopCore.tool, params: loopCore.params }));

  /* 入口盘点：Shelf 图标 + 工具箱行 + 命令表都得能找到同一个环切 */
  const loopEntry = await page.evaluate(() => {
    const host = document.getElementById('modelDeskHost');
    return {
      n: host.querySelectorAll('[data-md-op="loopcut"]').length,
      toolboxLabel: (host.querySelector('.md-op[data-md-op="loopcut"] .md-op-lb') || {}).textContent || '',
      cmd: !!window.SeedCommands.lookup('mesh.loopcut')
    };
  });
  check(loopEntry.n >= 2 && loopEntry.toolboxLabel === '环切' && loopEntry.cmd,
    '环切有 Shelf 图标 + 工具箱行 + 命令表三个入口',
    JSON.stringify(loopEntry));

  /* 三角转四边：成对三角并成四边；UV 接缝不并；单三角不并；三个入口都能找到 */
  const t2q = await page.evaluate(() => {
    const M = window.SeedModel.Mesh, Ops = window.SeedOps;
    function square(seam) {
      const m = M.create();
      m.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
      m.vertexIds = [0, 1, 2, 3]; m.nextVertexId = 4;
      m.faceOffsets = [0, 3, 6];
      m.faceIndices = [0, 1, 2, 0, 2, 3];
      m.faceIds = [0, 1]; m.faceSlots = [0, 0]; m.nextFaceId = 2;
      m.uvs = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
      if (seam) m.uvs[8] = 0.5;              /* 三角 2 在共享点 2 的 UV 与三角 1 不一致 */
      M.bump(m);
      return m;
    }
    const m = square(false);
    const q = Ops.trisToQuads(m);
    const seam = square(true);
    const single = M.create();
    single.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]; single.vertexIds = [0, 1, 2]; single.nextVertexId = 3;
    single.faceOffsets = [0, 3]; single.faceIndices = [0, 1, 2]; single.faceIds = [0]; single.faceSlots = [0];
    single.nextFaceId = 1; M.bump(single);
    const host = document.getElementById('modelDeskHost');
    return {
      before: m.faceIds.length, after: q ? q.faceIds.length : -1,
      corners: q ? q.faceOffsets[1] - q.faceOffsets[0] : -1,
      originalUntouched: m.faceIds.length === 2,
      seamNull: Ops.trisToQuads(seam) === null,
      singleNull: Ops.trisToQuads(single) === null,
      cmd: !!window.SeedCommands.lookup('mesh.trisToQuads'),
      entries: host.querySelectorAll('[data-md-op="tris-to-quads"]').length
    };
  });
  check(t2q.after === 1 && t2q.corners === 4 && t2q.originalUntouched,
    '三角转四边：成对三角并成 1 张四边（原网格不被原地改）', JSON.stringify(t2q));
  check(t2q.seamNull && t2q.singleNull, '三角转四边：UV 接缝 / 单张三角明确拒绝', JSON.stringify({ seam: t2q.seamNull, single: t2q.singleNull }));
  check(t2q.cmd && t2q.entries >= 2, '三角转四边有 Shelf 图标 + 工具箱行 + 命令表入口', JSON.stringify({ cmd: t2q.cmd, entries: t2q.entries }));


  try {
    const uvwin = await page.$('#mdUvWin');
    if (uvwin) {
      const shot = await RUN.shot(uvwin, 'uv-window.png');
      if (shot) info('UV 窗口截图', shot);
    }
  } catch (e) { info('UV 截图失败', String(e && e.message)); }

  const uvClose = await page.evaluate(() => {
    const b = document.querySelector('#mdUvWin [data-uvact="close"]');
    if (b) b.click();
    return { open: window.modelDesk.getState().uvOpen, dom: !!document.getElementById('mdUvWin') };
  });
  check(!uvClose.open && !uvClose.dom, '关闭按钮移除窗口并复位 uvOpen', JSON.stringify(uvClose));

  /* 11.14 挤出专用操纵器：法线箭头（拖 = 厚度）+ 箭头根部轴心方柄（右拖放大 / 左拖缩小顶面）。
   * 断言以「参数 + 面板数字 + 历史」为准，不依赖截图。 */
  const extGiz = await page.evaluate(async () => {
    const API = window.modelDesk, d = API.__debug();
    const T = window.THREE, M = window.SeedModel.Mesh;
    const canvas = d.canvas, r = canvas.getBoundingClientRect();
    const send = (target, type, x, y, id) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: id, clientX: x, clientY: y
    }));
    const wait = ms => new Promise(res => setTimeout(res, ms));
    const proj = v => {
      const p = v.clone().project(d.camera);
      return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
    };
    /* 挑一张「法线不冲着相机」的四边形面：箭头在屏幕上要有足够长度才拖得动 */
    const pm = d.pivot.matrixWorld, m0 = d.mesh;
    let best = null;
    for (let f = 0; f < m0.faceIds.length; f++) {
      const s = m0.faceOffsets[f], e = m0.faceOffsets[f + 1], n = e - s;
      if (n !== 4) continue;
      const tn = [0, 0, 0];
      M.triNormal(m0, f, tn);
      const nv = new T.Vector3(tn[0], tn[1], tn[2]).transformDirection(pm).normalize();
      const c = { x: 0, y: 0, z: 0 };
      for (let k = s; k < e; k++) {
        const vi = m0.faceIndices[k];
        c.x += m0.positions[vi * 3]; c.y += m0.positions[vi * 3 + 1]; c.z += m0.positions[vi * 3 + 2];
      }
      c.x /= n; c.y /= n; c.z /= n;
      const cw = new T.Vector3(c.x, c.y, c.z).applyMatrix4(pm);
      const a = proj(cw), b = proj(cw.clone().addScaledVector(nv, 0.3));
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!best || len > best.len) best = { f: f, id: m0.faceIds[f], len: len, n: nv.toArray() };
    }
    if (!best) return { best: null };
    const doc = API.getDocument();
    doc.selection = { mode: 'face', nodeIds: doc.selection.nodeIds || [], vertexIds: [], edgeIds: [], faceIds: [best.id] };
    API.reselect();
    window.SeedCommands.run('mesh.extrude', {});
    await wait(260);

    const g = API.__debug().extrudeGizmo;
    const out = { best: { id: best.id, px: +best.len.toFixed(1) }, has: !!g };
    if (!g) return out;
    out.visible = g.group.visible === true;
    out.parts = g.group.children.length;
    out.basePx = g.basePx && { x: Math.round(g.basePx.x), y: Math.round(g.basePx.y) };
    out.tipPx = g.tipPx && { x: Math.round(g.tipPx.x), y: Math.round(g.tipPx.y) };
    out.tipLen = Math.round(Math.hypot(g.tipPx.x - g.basePx.x, g.tipPx.y - g.basePx.y));
    out.transformHidden = !(d.gizmo.group && d.gizmo.group.visible);
    /* 箭头方向 = 手柄局部 +Y 经四元数旋转；必须和所选面的世界法线同向（以前是 45° 斜的） */
    const gdir = new T.Vector3(0, 1, 0).applyQuaternion(g.group.quaternion).normalize();
    const fdir = new T.Vector3(best.n[0], best.n[1], best.n[2]).normalize();
    out.align = {
      dir: gdir.toArray().map(v => +v.toFixed(3)),
      faceN: fdir.toArray().map(v => +v.toFixed(3)),
      dot: +gdir.dot(fdir).toFixed(3)
    };

    /* 悬停光标：根部 = ew-resize，杆身 = grab */
    const tip = { x: r.left + g.tipPx.x, y: r.top + g.tipPx.y };
    const base = { x: r.left + g.basePx.x, y: r.top + g.basePx.y };
    send(canvas, 'pointermove', tip.x, tip.y, 31);
    out.cursorTip = canvas.style.cursor;
    send(canvas, 'pointermove', base.x, base.y, 31);
    out.cursorRoot = canvas.style.cursor;

    /* 拖箭头 → dist 增加；面板输入框同步 */
    const ax = { x: g.tipPx.x - g.basePx.x, y: g.tipPx.y - g.basePx.y };
    const al = Math.hypot(ax.x, ax.y) || 1;
    const distBefore = +Number(window.SeedTools.current().params.dist).toFixed(3);
    send(canvas, 'pointerdown', tip.x, tip.y, 32);
    for (let i = 1; i <= 6; i++) {
      send(window, 'pointermove', tip.x + ax.x / al * 90 * i / 6, tip.y + ax.y / al * 90 * i / 6, 32);
    }
    send(window, 'pointerup', tip.x + ax.x / al * 90, tip.y + ax.y / al * 90, 32);
    await wait(140);
    const distAfter = +Number(window.SeedTools.current().params.dist).toFixed(3);
    const panel = document.getElementById('mdToolPanel');
    const thickInput = panel && panel.querySelector('input[data-tp="0"]');
    out.dist = { before: distBefore, after: distAfter };
    out.panelSync = thickInput ? +Number(thickInput.value).toFixed(3) : null;

    /* 箭头拖完后根部已经跟着厚度走了：按新的 basePx 再取根部方柄 */
    const gNow = API.__debug().extrudeGizmo;
    const base2 = { x: r.left + gNow.basePx.x, y: r.top + gNow.basePx.y };
    /* 拖根部方柄：右 = 外扩（offset > 0）、左 = 收缩（offset < 0） */
    send(canvas, 'pointerdown', base2.x, base2.y, 33);
    for (let i = 1; i <= 6; i++) send(window, 'pointermove', base2.x + 72 * i / 6, base2.y, 33);
    send(window, 'pointerup', base2.x + 72, base2.y, 33);
    await wait(120);
    const offR = +Number(window.SeedTools.current().params.offset).toFixed(3);
    /* 第二次必须仍从手柄所在位置按下（按住时移动了 72px 不代表手柄跟着走） */
    send(canvas, 'pointerdown', base2.x, base2.y, 34);
    for (let i = 1; i <= 8; i++) send(window, 'pointermove', base2.x - 144 * i / 8, base2.y, 34);
    send(window, 'pointerup', base2.x - 144, base2.y, 34);
    await wait(120);
    const offL = +Number(window.SeedTools.current().params.offset).toFixed(3);
    out.offset = { right: offR, left: offL };

    /* Enter 提交：一条历史，手柄收起，变换手柄回来 */
    const st0 = API.getState();
    API.commitTool();
    await wait(220);
    const st1 = API.getState();
    const gAfter = API.__debug().extrudeGizmo;
    out.commit = {
      live: st1.toolLive, panel: !!document.getElementById('mdToolPanel'),
      undo: st1.undo - st0.undo, faces: st1.meshHash !== st0.meshHash,
      gizmoHidden: !gAfter || gAfter.group.visible !== true,
      transformBack: !!(d.gizmo.target)
    };
    /* 预览收起后，正式实体 / 边线必须原样回来（预览期间被 mdPreviewOff 藏起来的那批） */
    let leftOff = 0;
    API.__debug().pivot.traverse(function (o) { if (o.userData && o.userData.mdPreviewOff) leftOff++; });
    out.commit.offLeft = leftOff;
    out.commit.previewGone = !API.__debug().toolPreview;

    /* 再开一次，拖箭头后取消：网格与历史必须无痕 */
    const m1 = API.__debug().mesh;
    let fid = null;
    for (let f = 0; f < m1.faceIds.length; f++) {
      if (m1.faceOffsets[f + 1] - m1.faceOffsets[f] === 4) { fid = m1.faceIds[f]; break; }
    }
    const d1 = API.getDocument();
    d1.selection = { mode: 'face', nodeIds: d1.selection.nodeIds || [], vertexIds: [], edgeIds: [], faceIds: [fid] };
    API.reselect();
    window.SeedCommands.run('mesh.extrude', {});
    await wait(220);
    const g2 = API.__debug().extrudeGizmo;
    const undoBefore = API.getState().undo, hashBefore = API.getState().meshHash;
    if (g2 && g2.basePx) {
      const t2 = { x: r.left + g2.tipPx.x, y: r.top + g2.tipPx.y };
      send(canvas, 'pointerdown', t2.x, t2.y, 35);
      send(window, 'pointermove', t2.x + 40, t2.y, 35);
      send(window, 'pointerup', t2.x + 40, t2.y, 35);
      await wait(100);
    }
    API.cancelTool();
    await wait(200);
    const st2 = API.getState();
    out.cancel = {
      live: st2.toolLive, undo: st2.undo - undoBefore, historyClean: st2.meshHash === hashBefore,
      gizmoHidden: !(API.__debug().extrudeGizmo && API.__debug().extrudeGizmo.group.visible),
      transformBack: !!(d.gizmo.target)
    };
    return out;
  });
  check(extGiz.has && extGiz.visible && extGiz.parts === 3 && extGiz.tipLen > 40,
    '挤出会话里出现专用箭头（杆 + 锥头 + 根部轴心柄，屏幕长度够拖）',
    JSON.stringify({ visible: extGiz.visible, parts: extGiz.parts, tipLen: extGiz.tipLen }));
  check(extGiz.align && extGiz.align.dot > 0.999,
    '箭头沿所选面的真实法线（不再偏成 45°）', JSON.stringify(extGiz.align));
  check(extGiz.cursorTip === 'grab' && extGiz.cursorRoot === 'ew-resize',
    '箭头 / 轴心柄悬停光标（grab / ew-resize）', JSON.stringify({ tip: extGiz.cursorTip, root: extGiz.cursorRoot }));
  check(extGiz.dist && extGiz.dist.after > extGiz.dist.before + 0.05 && extGiz.panelSync === extGiz.dist.after,
    '沿箭头轴向拖 = 厚度变大（面板数字同步）', JSON.stringify(extGiz.dist) + ' panel=' + extGiz.panelSync);
  check(extGiz.offset && extGiz.offset.right > 0.02 && extGiz.offset.left < -0.02,
    '轴心方柄右拖放大 / 左拖缩小顶面（offset 正负）', JSON.stringify(extGiz.offset));
  check(extGiz.commit && extGiz.commit.live === false && extGiz.commit.panel === false &&
    extGiz.commit.undo === 1 && extGiz.commit.faces === true && extGiz.commit.gizmoHidden === true,
    'Enter 提交：一条历史、手柄收起', JSON.stringify(extGiz.commit));
  check(extGiz.commit.offLeft === 0 && extGiz.commit.previewGone === true,
    '提交后预览退场，正式实体 / 边线恢复显示', JSON.stringify({ offLeft: extGiz.commit.offLeft, previewGone: extGiz.commit.previewGone }));
  check(extGiz.cancel && extGiz.cancel.live === false && extGiz.cancel.undo === 0 &&
    extGiz.cancel.historyClean === true && extGiz.cancel.gizmoHidden === true,
    'Esc 取消：网格与历史无痕、手柄收起', JSON.stringify(extGiz.cancel));
  check(extGiz.transformHidden === true && extGiz.commit.transformBack === true,
    '挤出会话里变换手柄让位，提交后恢复', JSON.stringify({ hidden: extGiz.transformHidden, back: extGiz.commit.transformBack }));

  /* 11.15 绘画工具箱：页签切换 → 笔刷设置 → 在模型上画一笔，贴图写回文档 */
  const paintTab = await page.evaluate(() => {
    const b = document.querySelector('[data-md-tbk="paint"]');
    if (b) b.click();
    const s = window.modelDesk.getState();
    const box = document.getElementById('mdPaintBox');
    const tb = document.getElementById('mdToolbox');
    const cs = tb ? getComputedStyle(tb) : null;
    /* 属性编辑器是同一行的第三个页签：切到绘画时它整块收起，不占高度 */
    const right = document.querySelector('.md-right'), props = document.querySelector('.md-props');
    return {
      kind: s.tbKind, boxVisible: !!(box && !box.hidden), toolboxHidden: !!(cs && cs.display === 'none'),
      hasBrush: !!document.getElementById('mdBrushSel'), hasSize: !!document.getElementById('mdBrushSize'),
      hasMask: !!document.getElementById('mdPaintMask'),
      dir: getComputedStyle(right).flexDirection,
      propsHidden: getComputedStyle(props).display === 'none',
      tabs: Array.from(document.querySelectorAll('[data-md-tbk]')).map(b => b.dataset.mdTbk)
    };
  });
  check(paintTab.kind === 'paint' && paintTab.boxVisible && paintTab.toolboxHidden && paintTab.hasBrush && paintTab.hasSize,
    '绘画工具箱页签切出笔刷面板，建模工具箱让位', JSON.stringify(paintTab));
  check(paintTab.dir === 'column' && paintTab.propsHidden && paintTab.hasMask && paintTab.tabs.length === 3,
    '属性编辑器与工具箱同排页签，切换显示不占额外空间',
    JSON.stringify({ dir: paintTab.dir, propsHidden: paintTab.propsHidden, tabs: paintTab.tabs }));

  const paintOpts = await page.evaluate(() => {
    const sel = document.getElementById('mdBrushSel');
    sel.value = 'hard';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const size = document.getElementById('mdBrushSize');
    size.value = '60';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    const col = document.getElementById('mdBrushColor');
    col.value = '#22c55e';
    col.dispatchEvent(new Event('input', { bubbles: true }));
    const s = window.modelDesk.getState();
    return { brush: s.brush, size: s.brushSize, color: s.brushColor };
  });
  check(paintOpts.brush === 'hard' && paintOpts.size === 60 && paintOpts.color === '#22c55e',
    '笔刷类型 / 大小 / 颜色设置生效', JSON.stringify(paintOpts));

  const paintStroke = await page.evaluate(() => {
    const API = window.modelDesk, d = API.__debug(), T = window.THREE;
    const canvas = d.canvas, r = canvas.getBoundingClientRect();
    /* 探针跑到这里时对象已被前面的变换测试挪过位置，不能再拿世界原点当落笔点；
     * 取「正对相机的那张面」的面心，投影到屏幕，保证这一点真的在模型上。 */
    const m = d.mesh;
    const camPos = d.camera.getWorldPosition(new T.Vector3());
    let bestFace = -1, bestDot = -Infinity, bestC = null;
    for (let f = 0; f < m.faceIds.length; f++) {
      const s = m.faceOffsets[f], e = m.faceOffsets[f + 1];
      if (e - s < 3) continue;
      const c = new T.Vector3(), n = new T.Vector3();
      for (let k = s; k < e; k++) {
        const vi = m.faceIndices[k] * 3;
        c.x += m.positions[vi]; c.y += m.positions[vi + 1]; c.z += m.positions[vi + 2];
      }
      c.multiplyScalar(1 / (e - s));
      const a0 = m.faceIndices[s] * 3, a1 = m.faceIndices[s + 1] * 3, a2 = m.faceIndices[s + 2] * 3;
      const v1 = new T.Vector3(m.positions[a1] - m.positions[a0], m.positions[a1 + 1] - m.positions[a0 + 1], m.positions[a1 + 2] - m.positions[a0 + 2]);
      const v2 = new T.Vector3(m.positions[a2] - m.positions[a0], m.positions[a2 + 1] - m.positions[a0 + 1], m.positions[a2 + 2] - m.positions[a0 + 2]);
      n.crossVectors(v1, v2).normalize();
      const wc = d.pivot.localToWorld(c.clone());
      const wn = n.clone().transformDirection(d.pivot.matrixWorld);
      /* 法线朝相机 → 是可见面；视线方向 = 面心指回相机 */
      const dot = wn.dot(camPos.clone().sub(wc).normalize());
      if (dot > bestDot) { bestDot = dot; bestFace = f; bestC = wc; }
    }
    const p = bestC.clone().project(d.camera);
    const x = r.left + (p.x * 0.5 + 0.5) * r.width, y = r.top + (-p.y * 0.5 + 0.5) * r.height;
    const send = (type, cx, cy) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 77, clientX: cx, clientY: cy
    }));
    /* 先打开 UV 岛遮罩，验证落笔时上下文真的加了岛剪裁，抬笔后剪裁被释放 */
    const maskEl = document.getElementById('mdPaintMask');
    maskEl.checked = true;
    maskEl.dispatchEvent(new Event('change', { bubbles: true }));
    const before = (API.getDocument().materials.slotMaps || [])[0] || '';
    send('pointerdown', x, y);
    const mid = API.getState();
    for (let i = 1; i <= 5; i++) send('pointermove', x + i * 8, y + i * 5);
    send('pointerup', x + 40, y + 25);
    const end = API.getState();
    const after = (API.getDocument().materials.slotMaps || [])[0] || '';
    /* 切片三之后：一笔 = 一个 stroke 层，slotMaps 一个字都不该动 */
    const stack = window.TexStack ? window.TexStack.ops(API.getDocument(), end.paintSlot) : [];
    let inkPx = 0;
    if (stack.length) {
      const ic = stack[stack.length - 1].canvas;
      const d2 = ic.getContext('2d').getImageData(0, 0, ic.width, ic.height).data;
      for (let i = 3; i < d2.length; i += 4) if (d2[i] > 8) inkPx++;
    }
    return {
      face: bestFace, dot: Number(bestDot.toFixed(2)),
      maskOn: mid.paintMask, clipped: mid.paintClipped, clipPolys: mid.paintClipPolys,
      restored: !end.paintClipped,
      beforeLen: before.length, afterLen: after.length, before, mapSame: before === after,
      ops: stack.length, opType: stack.length ? stack[stack.length - 1].type : '', inkPx,
      slot: end.paintSlot
    };
  });
  check(paintStroke.ops === 1 && paintStroke.opType === 'stroke' && paintStroke.inkPx > 0 && paintStroke.mapSame,
    '在模型上画一笔 = 推一个 stroke 层（slotMaps 不动）',
    JSON.stringify({ ops: paintStroke.ops, type: paintStroke.opType, inkPx: paintStroke.inkPx, mapSame: paintStroke.mapSame }));
  check(paintStroke.maskOn === true && paintStroke.clipped === true &&
    paintStroke.clipPolys >= 1 && paintStroke.restored === true,
    'UV 岛遮罩：落笔试加了岛剪裁，抬笔后释放',
    JSON.stringify({ mask: paintStroke.maskOn, clipped: paintStroke.clipped, polys: paintStroke.clipPolys, restored: paintStroke.restored }));

  /* 画笔撤销：一笔 = 一条历史；撤销少这一层，重做回来，贴图始终在 */
  const paintUndo = await page.evaluate(() => {
    const API = window.modelDesk;
    const doc = API.getDocument();
    const slot = API.getState().paintSlot;
    const map0 = (doc.materials.slotMaps || [])[0] || '';
    const n0 = window.TexStack ? window.TexStack.ops(doc, slot).length : -1;
    const undoOk = API.undo();
    const nMid = window.TexStack ? window.TexStack.ops(doc, slot).length : -1;
    const mapMid = (doc.materials.slotMaps || [])[0] || '';
    const redoOk = API.redo();
    const nBack = window.TexStack ? window.TexStack.ops(doc, slot).length : -1;
    const st = API.getState(), d = API.__debug();
    return {
      undoOk, redoOk, n0, nMid, nBack,
      /* 底座没画过就是空串：判据是「没被写」，不是「非空」 */
      mapSame: map0 === mapMid && mapMid === ((doc.materials.slotMaps || [])[0] || ''),
      undoLeft: st.undo, redoLeft: st.redo,
      /* 撤销重建了视口：绘画页签下手柄不能趁机复活 */
      gizmoHidden: !(d.gizmo && d.gizmo.target)
    };
  });
  check(paintUndo.undoOk === true && paintUndo.n0 === 1 && paintUndo.nMid === 0 &&
    paintUndo.redoOk === true && paintUndo.nBack === 1 && paintUndo.mapSame === true &&
    paintUndo.gizmoHidden === true,
    '画笔笔画可撤销 / 重做（栈里少一层再回来，贴图始终在）',
    JSON.stringify({ undoOk: paintUndo.undoOk, ops: paintUndo.n0 + '→' + paintUndo.nMid + '→' + paintUndo.nBack, mapSame: paintUndo.mapSame, gizmoHidden: paintUndo.gizmoHidden }));

  /* 单独显示（隔离所选）：只留当前对象，再点一次恢复；文档里的 node.visible 不受影响 */
  const iso = await page.evaluate(() => {
    const API = window.modelDesk;
    /* 单对象场景看不出隔离效果：先 Ctrl+D 复制一个（也是用户走得到的路径） */
    if (API.getState().nodeCount < 2) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
    }
    const before = API.getState();
    const btn = document.getElementById('mdIsolateBtn');
    /* 图标按钮应该在「着色」下拉的右边，不是跑到分隔线后面 */
    const sel = document.getElementById('mdShadeSel').getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const placed = br.width > 0 && br.left >= sel.right - 1 && (br.left - sel.right) < 24;
    btn.click();
    const on = API.getState();
    const d = API.__debug();
    const visIds = Object.keys(d.pivots).filter(id => d.pivots[id].visible);
    const statusOn = (document.getElementById('mdStatus') || {}).textContent || '';
    const docVis = API.getDocument().nodes.map(n => n.visible !== false);
    btn.click();
    const off = API.getState();
    return {
      placed,
      nodeCount: before.nodeCount, beforeVisible: before.visibleObjects,
      isolateOn: on.isolate, onVisible: on.visibleObjects, visIds: visIds.length,
      active: on.activeNodeId, statusOk: statusOn.indexOf('单独显示') >= 0,
      docVis: docVis.filter(Boolean).length,
      isolateOff: off.isolate, offVisible: off.visibleObjects,
      btnOff: !btn.classList.contains('on')
    };
  });
  check(iso.nodeCount >= 2 && iso.isolateOn === true && iso.onVisible === 1 && iso.visIds === 1 &&
    iso.statusOk === true && iso.isolateOff === false && iso.offVisible === iso.beforeVisible &&
    iso.btnOff === true && iso.placed === true,
    '单独显示：图标按钮在着色右侧，只渲染当前选中对象，再点恢复（不动文档可见性）',
    JSON.stringify(iso));

  const backModel = await page.evaluate(() => {
    document.querySelector('[data-md-tbk="model"]').click();
    const s = window.modelDesk.getState();
    return { kind: s.tbKind, boxHidden: document.getElementById('mdPaintBox').hidden };
  });
  check(backModel.kind === 'model' && backModel.boxHidden, '切回建模工具箱后绘画面板收起', JSON.stringify(backModel));

  /* 组件单独显示：面模式下选一张面，隔离后只显示这张面（替身网格），退出恢复整只对象 */
  await page.keyboard.press('F11');
  const compIso = await page.evaluate(() => {
    const API = window.modelDesk, d = API.__debug(), T = window.THREE;
    const canvas = d.canvas, r = canvas.getBoundingClientRect();
    const m = d.mesh;
    const camPos = d.camera.getWorldPosition(new T.Vector3());
    let bestFace = -1, bestDot = -Infinity, bestP = null;
    for (let f = 0; f < m.faceIds.length; f++) {
      const s = m.faceOffsets[f], e = m.faceOffsets[f + 1];
      if (e - s < 3) continue;
      const c = new T.Vector3(), n = new T.Vector3();
      for (let k = s; k < e; k++) {
        const vi = m.faceIndices[k] * 3;
        c.x += m.positions[vi]; c.y += m.positions[vi + 1]; c.z += m.positions[vi + 2];
      }
      c.multiplyScalar(1 / (e - s));
      const a0 = m.faceIndices[s] * 3, a1 = m.faceIndices[s + 1] * 3, a2 = m.faceIndices[s + 2] * 3;
      const v1 = new T.Vector3(m.positions[a1] - m.positions[a0], m.positions[a1 + 1] - m.positions[a0 + 1], m.positions[a1 + 2] - m.positions[a0 + 2]);
      const v2 = new T.Vector3(m.positions[a2] - m.positions[a0], m.positions[a2 + 1] - m.positions[a0 + 1], m.positions[a2 + 2] - m.positions[a0 + 2]);
      n.crossVectors(v1, v2).normalize();
      const wc = d.pivot.localToWorld(c.clone());
      const wn = n.clone().transformDirection(d.pivot.matrixWorld);
      const dot = wn.dot(camPos.clone().sub(wc).normalize());
      /* 取面心与第一个角点之间靠角的位置：避开正中被手柄轴挡住的区域 */
      const corner = new T.Vector3(m.positions[a0], m.positions[a0 + 1], m.positions[a0 + 2]);
      const pick = c.clone().multiplyScalar(0.45).add(corner.multiplyScalar(0.55));
      const wp = d.pivot.localToWorld(pick.clone());
      if (dot > bestDot) { bestDot = dot; bestFace = f; bestP = wp; }
    }
    const p = bestP.project(d.camera);
    const x = r.left + (p.x * 0.5 + 0.5) * r.width, y = r.top + (-p.y * 0.5 + 0.5) * r.height;
    const send = (type) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 78, clientX: x, clientY: y
    }));
    send('pointerdown'); send('pointerup');
    const picked = API.getState();
    const btn = document.getElementById('mdIsolateBtn');
    btn.click();
    const on = API.getState();
    const dOn = API.__debug(), pv = dOn.pivot;
    const group = pv.userData.mdIsoMesh;
    let visibleSolids = 0;
    pv.traverse(o => { if (o.userData.mdPart === 'solid' && o.visible) visibleSolids++; });
    const subSolid = group && group.children.find(o => o.userData.mdPart === 'solid');
    btn.click();
    const off = API.getState();
    const dOff = API.__debug();
    let origVisible = false;
    dOff.pivot.traverse(o => { if (o.userData.mdPart === 'solid' && !o.userData.mdIsolate && o.visible) origVisible = true; });
    return {
      selMode: picked.selMode, selFace: picked.selFace, dot: Number(bestDot.toFixed(2)),
      isoOn: on.isolate, isoComp: on.isoComp, isoFaces: on.isoFaces,
      hasGroup: !!group, subGroups: subSolid ? subSolid.geometry.groups.length : 0,
      visibleSolids,
      isoOff: off.isolate, isoCompOff: off.isoComp,
      groupGone: !dOff.pivot.userData.mdIsoMesh, origVisible,
      status: (document.getElementById('mdStatus') || {}).textContent || ''
    };
  });
  check(compIso.selMode === 'face' && compIso.selFace >= 1 && compIso.isoOn === true &&
    compIso.isoComp === true && compIso.isoFaces >= 1 && compIso.hasGroup === true &&
    compIso.subGroups >= 1 && compIso.visibleSolids === 1 &&
    compIso.isoOff === false && compIso.isoCompOff === false && compIso.groupGone === true &&
    compIso.origVisible === true,
    '组件单独显示：只显示选中的面，退出后恢复整只对象',
    JSON.stringify(compIso));

  /* 有 UV 的网格拖面：渲染顶点是拆过的，缓冲区必须按 mdOrig 映射回写，否则整块模型炸开 */
  const faceDrag = await page.evaluate(() => {
    const API = window.modelDesk, d = API.__debug();
    const m = d.mesh;
    const before = new Float32Array(m.positions);
    let geo = null;
    d.pivot.traverse(o => {
      if (!geo && o.userData && o.userData.mdPart === 'solid' && o.geometry) geo = o.geometry;
    });
    if (!geo) return { noGeo: true };
    const arr = geo.attributes.position.array, map = geo.userData.mdOrig;
    d.gizmo.onStart({ mode: 'translate', axis: 'x' });
    d.compPivot.position.x += 0.25;
    d.compPivot.updateMatrixWorld(true);
    d.gizmo.onChange();
    let mis = 0, bad = 0, maxD = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const dd = Math.hypot(m.positions[i] - before[i], m.positions[i + 1] - before[i + 1], m.positions[i + 2] - before[i + 2]);
      if (dd > maxD) maxD = dd;
      if (!isFinite(m.positions[i]) || !isFinite(m.positions[i + 1]) || !isFinite(m.positions[i + 2])) bad++;
    }
    const rn = arr.length / 3;
    for (let r = 0; r < rn; r++) {
      const oi = (map ? map[r] : r) * 3, ri = r * 3;
      if (Math.abs(arr[ri] - m.positions[oi]) > 1e-4 ||
        Math.abs(arr[ri + 1] - m.positions[oi + 1]) > 1e-4 ||
        Math.abs(arr[ri + 2] - m.positions[oi + 2]) > 1e-4) mis++;
    }
    d.gizmo.onEnd({ mode: 'translate', axis: 'x', changed: true });
    API.undo();
    return {
      hasMap: !!map, mapLen: map ? map.length : 0, renderVerts: rn,
      meshVerts: m.positions.length / 3, mis, bad, maxD: +maxD.toFixed(3),
      selFace: API.getState().selFace
    };
  });
  /* maxD 是网格局部位移；导入模型常被整体缩放过，所以只校验「动了、没乱、没出非数」 */
  check(faceDrag.hasMap === true && faceDrag.mis === 0 && faceDrag.bad === 0 &&
    faceDrag.maxD > 0.1 && faceDrag.selFace >= 1,
    '拖面：渲染缓冲按 UV 拆点映射回写，模型不炸开',
    JSON.stringify(faceDrag));

  /* 「属性编辑器」页签：切过去才显示，且整块吃满右栏高度；切回建模后收起 */
  const propsTab = await page.evaluate(() => {
    document.querySelector('[data-md-tbk="props"]').click();
    const right = document.querySelector('.md-right');
    const props = document.querySelector('.md-props'), tb = document.querySelector('.md-tb');
    const pr = props.getBoundingClientRect();
    const params = document.getElementById('mdParams').getBoundingClientRect();
    const out = {
      kind: window.modelDesk.getState().tbKind, isProps: right.classList.contains('is-props'),
      propsShown: getComputedStyle(props).display !== 'none' && pr.height > 300,
      toolboxHidden: getComputedStyle(tb).display === 'none',
      paramsVisible: params.height > 100
    };
    document.querySelector('[data-md-tbk="model"]').click();
    out.backToModel = window.modelDesk.getState().tbKind;
    return out;
  });
  check(propsTab.kind === 'props' && propsTab.isProps && propsTab.propsShown &&
    propsTab.toolboxHidden && propsTab.paramsVisible && propsTab.backToModel === 'model',
    '属性编辑器页签可切换：占满右栏高度，切回建模后收起',
    JSON.stringify(propsTab));

  /* 「占位控件落实」：视口条 5 个下拉 / 大纲三页签 / 视图行 / 工具架页签 / 命令行 */
  const uiCtrl = await page.evaluate(async () => {
    const q = (s) => document.querySelector(s);
    const popItem = (text) => Array.from(document.querySelectorAll('.md-pop .md-mi'))
      .find((b) => b.textContent.indexOf(text) >= 0);
    const state = () => window.modelDesk.getState();
    const out = {};
    try {

    /* 相机视图菜单：打开 → 有 7 项 → 点前视图 */
    q('#mdViewLabel').click();
    out.viewMenu = Array.from(document.querySelectorAll('.md-pop .md-mi span')).map((e) => e.textContent);
    popItem('前视图').click();
    out.viewFront = state().viewName;

    /* 显示开关：栅格关 → 开 */
    q('[data-md-pop="display"]').click();
    popItem('栅格').click();
    out.gridOff = window.SeedViewFlags.get('grid');
    q('[data-md-pop="display"]').click();
    popItem('栅格').click();
    out.gridOn = window.SeedViewFlags.get('grid');

    /* 照明预设：环境光（主光归零）→ 默认 */
    q('[data-md-pop="light"]').click();
    popItem('环境光').click();
    out.lightAmbient = state().lightingPreset;
    out.lightKeyOff = state().lightIntensity[1];
    q('[data-md-pop="light"]').click();
    popItem('默认').click();
    out.lightBack = state().lightingPreset;

    /* 渲染器：Reinhard + 曝光 1.25，再恢复 */
    q('[data-md-pop="render"]').click();
    out.renderItems = Array.from(document.querySelectorAll('.md-pop .md-mi span')).map((e) => e.textContent);
    popItem('Reinhard').click();
    out.tone = state().prefs.toneMapping;
    out.renderStatus = (q('#mdStatus') || {}).textContent || '';
    q('[data-md-pop="render"]').click();
    popItem('曝光 1.25').click();
    out.exposure = state().prefs.exposure;
    q('[data-md-pop="render"]').click();
    popItem('ACES Filmic').click();
    q('[data-md-pop="render"]').click();
    popItem('曝光 1.00').click();
    out.toneBack = state().prefs.toneMapping + '/' + state().prefs.exposure;

    /* 面板：隐藏 / 显示大纲 */
    q('[data-md-pop="panel"]').click();
    popItem('大纲视图').click();
    out.outlineHidden = q('.md-outline').hidden;
    q('[data-md-pop="panel"]').click();
    popItem('大纲视图').click();
    out.outlineBack = !q('.md-outline').hidden;

    /* 大纲三页签：帮助 → 显示 */
    q('[data-md-otab="help"]').click();
    out.helpNote = (q('#mdOutlineList .md-note') || {}).textContent || '';
    q('[data-md-otab="all"]').click();
    out.outlineTabBack = state().outlineTab;

    /* 大纲视图行：点 top 切顶视图，再回轴测 */
    q('[data-md-view="top"]').click();
    out.viewTop = state().viewName;
    q('[data-md-view="iso"]').click();
    out.viewIso = state().viewName;

    /* 工具架页签：渲染页 → FX 空页 → 回多边形 */
    q('[data-md-stab="render"]').click();
    out.shelfRender = state().shelfTab;
    out.shelfRenderVisible = Array.from(document.querySelectorAll('.md-shelf-grid .md-sico'))
      .filter((b) => !b.hidden).length;
    q('[data-md-stab="fx"]').click();
    out.fxNote = q('#mdShelfNote').hidden ? '' : q('#mdShelfNote').textContent;
    q('[data-md-stab="poly"]').click();
    out.shelfBack = state().shelfTab;
    out.shelfPolyVisible = Array.from(document.querySelectorAll('.md-shelf-grid .md-sico'))
      .filter((b) => !b.hidden).length;

    /* 命令行：camera / display / tone / exposure */
    const cmd = (v) => {
      const el = q('#mdCmd');
      el.value = v;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    cmd('camera back');
    out.cmdView = state().viewName;
    cmd('display verts off');
    out.cmdVertsOff = window.SeedViewFlags.get('verts');
    cmd('display verts on');
    cmd('tone reinhard');
    out.cmdTone = state().prefs.toneMapping;
    cmd('exposure 1.1');
    out.cmdExposure = state().prefs.exposure;
    cmd('tone aces');
    cmd('exposure 1');
    cmd('camera iso');
    out.cmdRestore = state().viewName;
    } catch (e) {
      out.error = String((e && e.stack) || e);
    }
    return out;
  });

  check(uiCtrl.error == null, '视口控件探针无脚本错误', uiCtrl.error || '');
  check((uiCtrl.viewMenu || []).length === 7 && uiCtrl.viewFront === '前视图',
    '视口「透视▾」可切 7 个相机视图', JSON.stringify({ items: (uiCtrl.viewMenu || []).length, view: uiCtrl.viewFront }));
  check(uiCtrl.gridOff === false && uiCtrl.gridOn === true,
    '视口「显示▾」栅格开关真实生效并可恢复', JSON.stringify({ off: uiCtrl.gridOff, on: uiCtrl.gridOn }));
  check(uiCtrl.lightAmbient === 'ambient' && Math.abs(uiCtrl.lightKeyOff) < 1e-6 && uiCtrl.lightBack === 'default',
    '视口「照明▾」环境光预设把主光归零，切回默认恢复', JSON.stringify(uiCtrl));
  check(uiCtrl.tone === 'reinhard' && Math.abs(uiCtrl.exposure - 1.25) < 1e-6 && uiCtrl.toneBack === 'aces/1',
    '视口「渲染器▾」色调映射与曝光可切换并恢复', JSON.stringify({ tone: uiCtrl.tone, exposure: uiCtrl.exposure, back: uiCtrl.toneBack }));
  check(uiCtrl.outlineHidden === true && uiCtrl.outlineBack === true,
    '视口「面板▾」可隐藏 / 恢复大纲', JSON.stringify({ hidden: uiCtrl.outlineHidden, back: uiCtrl.outlineBack }));
  check(uiCtrl.helpNote != null && uiCtrl.helpNote.indexOf('显示') >= 0 && uiCtrl.outlineTabBack === 'all',
    '大纲「显示 / 隐藏 / 帮助」页签可切换，帮助页给出说明', JSON.stringify({ note: uiCtrl.helpNote, tab: uiCtrl.outlineTabBack }));
  check(uiCtrl.viewTop === '顶视图' && uiCtrl.viewIso === '轴测',
    '大纲视图行可点击切换相机（top / persp）', JSON.stringify({ top: uiCtrl.viewTop, iso: uiCtrl.viewIso }));
  check(uiCtrl.shelfRender === 'render' && uiCtrl.shelfRenderVisible >= 3 &&
    uiCtrl.fxNote != null && uiCtrl.fxNote.indexOf('FX') >= 0 && uiCtrl.shelfBack === 'poly' && uiCtrl.shelfPolyVisible >= 10,
    '工具架 7 个页签可切换，渲染页 3 个真工具 / FX 页给出未接入说明',
    JSON.stringify(uiCtrl));
  check(uiCtrl.cmdView === '后视图' && uiCtrl.cmdVertsOff === false &&
    uiCtrl.cmdTone === 'reinhard' && Math.abs(uiCtrl.cmdExposure - 1.1) < 1e-6 && uiCtrl.cmdRestore === '轴测',
    '命令行 camera / display / tone / exposure 全部生效',
    JSON.stringify({ view: uiCtrl.cmdView, verts: uiCtrl.cmdVertsOff, tone: uiCtrl.cmdTone, exp: uiCtrl.cmdExposure }));

  /* 12. 截图（整窗 + 视口） */
  try {
    const win = await page.$('#modelDeskWin');
    const shotWin = win ? await RUN.shot(win, 'window.png') : null;
    const stage = await page.$('#mdStage');
    const shotVp = stage ? await RUN.shot(stage, 'stage.png') : null;
    if (shotWin || shotVp) info('截图', [shotWin, shotVp].filter(Boolean).join(' , '));
  } catch (e) { info('截图失败', String(e && e.message)); }

  check(errors.length === 0, '打开与操作期间无 pageerror', errors.slice(0, 3).join(' | '));

  await browser.close();
  RUN.finish(fails ? ['失败 ' + fails + ' 项'] : []);
  console.log(fails ? '\n❌ 失败 ' + fails + ' 项' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})();
