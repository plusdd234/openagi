'use strict';
/* 探针：建模 App「添加组件 → 流明头模」端到端（真 UI，不走 API 抄近路）
 * 用法：node tools/probe-modeldesk-component.js      （PROBE_SHOTS=0 关截图）
 *
 * 验八件事：
 *   ① 大纲那行的「＋ 组件」按钮存在且和页签同一行、可点开面板；
 *   ② 面板认出「这是异步组件源」：先出「读取中」，读完自己重铺（不靠用户再点一次）；
 *   ③ 读进来的就是流明 3D 那一份：112 个形态键、名字对得上（vrc.v_aa / mouth_a…）；
 *   ④ 点「添加到场景」真的多一个网格节点，面数 / 顶点 / UV / 朝向都对；
 *   ⑤ 形态键**过桥了**：节点上带着 112 个 morph、位移非零（不是只剩一张静态皮）；
 *   ⑥ 新零件按包围盒避让，不埋进已有对象里（默认文档那个 1m 立方体的坑）；
 *   ⑦ 它是**特殊组件**：node.comp 带自己的参数、属性面板认得出、能改「这一个」而不新增、
 *      改完还是同一份网格（不重建），存盘重开后身份还在；
 *   ⑧ 撤销能把添加 / 调整分别退回。
 */
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-modeldesk-component');
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERR ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.openDeskApp('modeldesk'); });
  await page.waitForFunction(() => !!(window.modelDesk && window.modelDesk.getDocument && window.modelDesk.getDocument()), null, { timeout: 45000 });
  await page.waitForTimeout(900);

  /* ---------- ① 按钮 ---------- */
  const btn = page.locator('#mdAddCompBtn');
  check(await btn.count() === 1, '大纲那行有「＋ 组件」按钮');
  const btnBox = await btn.boundingBox();
  const tabBox = await page.locator('.md-otabs').first().boundingBox();
  check(!!btnBox && !!tabBox && btnBox.y >= tabBox.y - 1 && btnBox.y <= tabBox.y + tabBox.height,
    '按钮和大纲页签同一行（截图里箭头指的位置）',
    btnBox ? 'y=' + Math.round(btnBox.y) : 'no box');

  /* ---------- ② 组件源自报（载入前） ---------- */
  const cat0 = await page.evaluate(() => window.modelDesk.componentCatalog());
  check(cat0.length === 1 && cat0[0].id === 'lumen-head', '组件源注册了 1 个零件（流明头模）',
    JSON.stringify(cat0.map((c) => c.id)));
  check(cat0[0].async === true && cat0[0].ready === false, '它是异步组件源：打开面板前还没读资产');

  /* 打开面板与取样放在同一次 evaluate 里：资产小（14MB 走本地磁盘缓存）时可能几百毫秒就读完，
   * 中间插一次 waitForTimeout 就采不到「读取中」那一帧了 —— 曾经因此误判成没做加载态。 */
  const loading = await page.evaluate(() => {
    document.querySelector('#mdAddCompBtn').click();
    const ov = document.querySelector('.md-overlay.comp');
    if (!ov) return null;
    const go = ov.querySelector('[data-md-act="comp-add"]');
    return {
      wait: !!ov.querySelector('.md-comp-wait'),
      goText: (go ? go.textContent : '').trim(),
      disabled: !!go && go.disabled
    };
  });
  check(!!loading && loading.wait, '面板先出「正在读取」占位（不是空白也不是假装就绪）', loading && loading.goText);
  check(!!loading && loading.disabled, '资产没读完时「添加到场景」是禁用的（不让点了个空）');

  /* 等资产读完：脚本注入 + 14MB base64 解码，给足 90s */
  await page.waitForFunction(() => {
    const c = window.modelDesk.componentCatalog()[0];
    return !!(c && c.ready);
  }, null, { timeout: 90000 });
  await page.waitForTimeout(400);

  const cat1 = await page.evaluate(() => window.modelDesk.componentCatalog()[0]);
  check(cat1.info && cat1.info.verts === 3606, '读到的是流明那份网格（3606 顶点）',
    cat1.info ? cat1.info.verts + ' 顶点' : 'no info');
  check(cat1.info && cat1.info.morphs === 112, '形态键 112 个（117 减去 5 个分组标题行）',
    cat1.info ? String(cat1.info.morphs) : 'no info');
  /* 它是「特殊组件」：不是只有一张参数表，而是自带面板、自带「改已有对象」的方式 */
  check(cat1.panel === true && cat1.applyTo === true && cat1.props === true,
    '组件自报 panel / applyTo / props（特殊组件，不是通用滑杆）',
    'panel=' + cat1.panel + ' applyTo=' + cat1.applyTo + ' props=' + cat1.props);
  check(cat1.surface === true, '组件自带表面（流明那张脸贴图，不是灰壳）');

  /* ---------- ③ 面板（读完） ---------- */
  const ui = await page.evaluate(() => {
    const ov = document.querySelector('.md-overlay.comp');
    if (!ov) return null;
    const svg = ov.querySelector('.md-comp-preview svg');
    const sel = ov.querySelector('select[data-md-cev="main"]');
    return {
      cards: ov.querySelectorAll('.md-comp-card').length,
      selects: ov.querySelectorAll('select[data-md-cev]').length,
      options: sel ? sel.querySelectorAll('option').length : 0,
      groups: sel ? sel.querySelectorAll('optgroup').length : 0,
      /* 只数「强度」那一个滑杆：面板里现在还有视线幅度（data-md-cev="gazeAmt"），
       * 笼统数 range 会把「多了一个控件」误报成「强度重复了」。 */
      sliders: ov.querySelectorAll('input[type=range][data-md-cev="w"]').length,
      exprs: ov.querySelectorAll('.md-md-expr').length,
      special: !!ov.querySelector('.md-comp-special'),
      pathLen: svg ? (svg.querySelector('.md-comp-front').getAttribute('d') || '').length : 0,
      sideLen: svg ? (svg.querySelector('.md-comp-side').getAttribute('d') || '').length : 0,
      svgH: svg ? Math.round(svg.getBoundingClientRect().height) : 0,
      goText: ((ov.querySelector('[data-md-act="comp-add"]') || {}).textContent || '').trim(),
      goDisabled: !!(ov.querySelector('[data-md-act="comp-add"]') || {}).disabled,
      note: (ov.querySelector('.md-comp-main .md-note') || {}).textContent || ''
    };
  });
  check(!!ui && ui.cards === 1, '左侧列出组件卡片', ui && ui.cards + ' 张');
  check(!!ui && ui.selects === 1 && ui.options === 113, '下拉里有「基础」+ 112 个形态键',
    ui && ui.options + ' 项');
  check(!!ui && ui.groups >= 3, '形态键按部位分组（optgroup）', ui && ui.groups + ' 组');
  check(!!ui && ui.sliders === 1, '强度只有一个滑杆', ui && String(ui.sliders));
  check(!!ui && ui.special && ui.exprs >= 5, '面板用的是组件自报的那一块（表情预设 + 形态键 + 叠加）',
    ui && ui.exprs + ' 个表情');
  check(!!ui && ui.pathLen > 200 && ui.sideLen > 200, '剪影 SVG 有实际路径（正 / 侧各一条）',
    ui && ui.pathLen + ' / ' + ui.sideLen + ' 字符');
  /* 剪影是从**真实顶点**投出来的：高度被同名 var 覆盖成 1 时路径还在、断言也过，屏幕却是空的 */
  check(!!ui && ui.svgH > 100, '剪影真的画出来了（高度没被覆盖成 1px）', ui && ui.svgH + 'px');
  check(!!ui && /添加到场景/.test(ui.goText) && !ui.goDisabled, '读完资产后主按钮可用', ui && ui.goText);
  check(!!ui && /顶点/.test(ui.note) && /形态键/.test(ui.note), '面板写明数据来源与规模（不是「重做了一套」）',
    ui && ui.note.slice(0, 60));

  await RUN.shot(page, 'panel.png');

  /* 换形态键 → 剪影必须跟着变（参数真的作用在同一份几何上）。
   * ⚠ 必须比「正 + 侧」两条：vrc.v_aa / sp_cheek 这些表情动的多是 z 向（侧脸轮廓），
   *   正视图的行内极值往往一个都不变 —— 只比 front 会误判成「参数没生效」。 */
  const morph = await page.evaluate(() => {
    const d = () => {
      const svg = document.querySelector('.md-comp-preview svg');
      return svg
        ? svg.querySelector('.md-comp-front').getAttribute('d') + '|' +
          svg.querySelector('.md-comp-side').getAttribute('d')
        : '';
    };
    const d1 = d();
    window.modelDesk.setComponentParam('morph', 'sp_cheek');
    const d2 = d();
    window.modelDesk.setComponentParam('weight', 100);
    const d3 = d();
    return { changed: d1 !== d3, mid: d2 !== d1, stillOpen: !!document.querySelector('.md-overlay.comp') };
  });
  check(morph.changed && morph.mid, '选形态键 + 强度后剪影跟着变（预览不是装饰）');
  check(morph.stillOpen, '改参数不重铺面板（下拉不丢选中）');
  await RUN.shot(page, 'panel-morph.png');
  /* 归零，恢复基础表情再添加 */
  await page.evaluate(() => { window.modelDesk.setComponentParam('morph', ''); window.modelDesk.setComponentParam('weight', 100); });

  /* ---------- ④ 添加 ---------- */
  const before = await page.evaluate(() => window.modelDesk.getDocument().nodes.length);
  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForFunction((n) => window.modelDesk.getDocument().nodes.length > n, before, { timeout: 30000 });
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const a = window.modelDesk;
    const doc = a.getDocument();
    const node = doc.nodes[doc.nodes.length - 1];
    const mesh = window.SeedModel.Scene.getMesh(doc, node);
    const stats = window.SeedModel.Mesh.stats(mesh);
    let uMin = 1e9, uMax = -1e9, vMin = 1e9, vMax = -1e9;
    for (let i = 0; i < mesh.uvs.length; i += 2) {
      uMin = Math.min(uMin, mesh.uvs[i]); uMax = Math.max(uMax, mesh.uvs[i]);
      vMin = Math.min(vMin, mesh.uvs[i + 1]); vMax = Math.max(vMax, mesh.uvs[i + 1]);
    }
    let yMin = 1e9, yMax = -1e9, zMax = -1e9, xMax = -1e9;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      yMin = Math.min(yMin, mesh.positions[i + 1]); yMax = Math.max(yMax, mesh.positions[i + 1]);
      zMax = Math.max(zMax, mesh.positions[i + 2]); xMax = Math.max(xMax, mesh.positions[i]);
    }
    /* 形态键过桥的证据：数量 + 名字 + 位移量级（全 0 就是「只搬了静态皮」） */
    const morphs = mesh.morphs || [];
    let maxDelta = 0, nonZero = 0;
    morphs.slice(0, 12).forEach((m) => {
      for (let i = 0; i < m.deltas.length; i += 7) {
        const d = Math.abs(m.deltas[i]);
        if (d > maxDelta) maxDelta = d;
        if (d > 1e-6) nonZero++;
      }
    });
    return {
      nodes: doc.nodes.length,
      name: node.name,
      overlay: !!document.querySelector('.md-overlay.on'),
      faces: stats.faces, verts: stats.vertices,
      /* 三角形数不能拿 faceIndices.length/3 算：mergeQuads 把三角对并回四边形后，
       * 一个四边面只贡献 4 个索引。按「每面 n 边 → n-2 个三角」才是源几何的口径。 */
      tris: (function () {
        let t = 0;
        for (let f = 0; f + 1 < mesh.faceOffsets.length; f++) t += (mesh.faceOffsets[f + 1] - mesh.faceOffsets[f]) - 2;
        return t;
      })(),
      uv: [uMin, uMax, vMin, vMax].map((x) => +x.toFixed(3)),
      y: [+yMin.toFixed(3), +yMax.toFixed(3)],
      xMax: +xMax.toFixed(3), zMax: +zMax.toFixed(3),
      morphs: morphs.length,
      hasAA: morphs.some((m) => m.name === 'vrc.v_aa'),
      hasMouth: morphs.some((m) => m.name === 'mouth_a'),
      maxDelta: +maxDelta.toFixed(5), nonZero,
      /* 贴图：流明的脸 90% 画在这张图上，没挂上就只是一颗灰壳 */
      skin: (function () {
        const g = window.modelDesk.__debug();
        const pv = g.pivots[Object.keys(g.pivots)[1]];
        let m = null;
        pv.traverse((o) => { if (!m && o.isMesh && o.userData && o.userData.mdPart === 'solid') m = o; });
        if (!m) return null;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        return { has: !!(mat && mat.map), base: !!(mat && mat.userData && mat.userData.mdBaseMap) };
      })(),
      status: (document.querySelector('.md-status, .md-statusbar') || {}).textContent || ''
    };
  });
  check(after.nodes === before + 1, '添加后多了一个对象', before + ' → ' + after.nodes);
  check(/流明头模/.test(after.name), '新节点叫「流明头模」', after.name);
  check(!after.overlay, '添加成功后面板自动关闭');
  /* 面数按「多边形」统计（三角对已经被 mergeQuads 并回四边形），三角形数才是和源一致的判据 */
  check(after.tris === 5358 && after.verts === 3606, '三角形 / 顶点数与流明那份完全一致',
    after.tris + ' 三角 → ' + after.faces + ' 面 / ' + after.verts + ' 顶点');
  check(after.uv[0] >= -0.001 && after.uv[1] <= 1.001 && after.uv[2] >= -0.001 && after.uv[3] <= 1.001,
    'UV 落在 [0,1]（能直接画脸）', JSON.stringify(after.uv));
  check(after.zMax > after.xMax, '脸朝 +Z（鼻尖是 z 最大处）', 'xMax=' + after.xMax + ' zMax=' + after.zMax);
  check(after.morphs === 112, '节点上带着 112 个形态键（不是静态皮）', String(after.morphs));
  check(after.hasAA && after.hasMouth, '形态键名字与流明一致（vrc.v_aa / mouth_a 都在）');
  check(after.maxDelta > 1e-4 && after.nonZero > 10, '形态键位移非零（真的搬了 delta）',
    'max|delta|=' + after.maxDelta);
  check(!!after.skin && after.skin.has && after.skin.base,
    '脸上挂着流明那张贴图（mdBaseMap 也在，切显示模式不会白掉）',
    after.skin ? JSON.stringify(after.skin) : 'null');

  /* 摆放必须避开已有对象：默认文档是个 1m 立方体，头只有 20cm，
   * 早先按「节点数 × 间距」排开时头整个落进立方体里，加完屏幕上什么都没有。 */
  const apart = await page.evaluate(() => {
    const g = window.modelDesk.__debug();
    const ids = Object.keys(g.pivots);
    const TH = window.THREE;
    const a = new TH.Box3().setFromObject(g.pivots[ids[0]]);
    const b = new TH.Box3().setFromObject(g.pivots[ids[1]]);
    return { overlap: a.intersectsBox(b), ax: +a.max.x.toFixed(3), bx: +b.min.x.toFixed(3) };
  });
  check(!apart.overlap, '新零件不埋进已有对象里（按包围盒找空位）', '立方体右沿 ' + apart.ax + ' → 头左沿 ' + apart.bx);

  /* 面朝外：z 镜像之后必须倒序，否则 80% 的面朝里。双面渲染看不出差别，
   * 但平面法线、导出的 GLB、背面剔除全跟着错 —— 这条断言守的就是「看不出来但会坏」的那类。 */
  const facing = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const mesh = window.SeedModel.Scene.getMesh(doc, doc.nodes[doc.nodes.length - 1]);
    const P = mesh.positions;
    let out = 0, inn = 0;
    for (let f = 0; f + 1 < mesh.faceOffsets.length; f++) {
      const s = mesh.faceOffsets[f];
      if (mesh.faceOffsets[f + 1] - s < 3) continue;
      const i0 = mesh.faceIndices[s] * 3, i1 = mesh.faceIndices[s + 1] * 3, i2 = mesh.faceIndices[s + 2] * 3;
      const ax = P[i1] - P[i0], ay = P[i1 + 1] - P[i0 + 1], az = P[i1 + 2] - P[i0 + 2];
      const bx = P[i2] - P[i0], by = P[i2 + 1] - P[i0 + 1], bz = P[i2 + 2] - P[i0 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const cx = (P[i0] + P[i1] + P[i2]) / 3, cy = (P[i0 + 1] + P[i1 + 1] + P[i2 + 1]) / 3, cz = (P[i0 + 2] + P[i1 + 2] + P[i2 + 2]) / 3;
      if (nx * cx + ny * cy + nz * cz > 0) out++; else inn++;
    }
    return { out, inn };
  });
  check(facing.out > facing.inn, '面朝外（镜像后绕序已翻正，不是靠双面渲染兜着）',
    facing.out + ' 朝外 / ' + facing.inn + ' 朝内');

  /* ---------- ⑤ 特殊组件：有自己的属性，能改「这一个」而不新增 ---------- */
  const owned = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes[doc.nodes.length - 1];
    return {
      id: node.id,
      meshRef: node.meshRef,
      nodes: doc.nodes.length,
      comp: node.comp ? JSON.parse(JSON.stringify(node.comp)) : null
    };
  });
  check(!!owned.comp && owned.comp.id === 'lumen-head', '节点带着组件身份（node.comp.id = lumen-head）',
    owned.comp ? JSON.stringify(owned.comp).slice(0, 70) : 'null');
  check(!!owned.comp && owned.comp.params && typeof owned.comp.params.weights === 'object',
    '身份里是它自己的参数形态（weights 表，不是通用 key → value）');

  /* 属性面板要认得出「这是个组件」，并给一个回面板的口子 */
  const propUi = await page.evaluate(() => {
    const box = document.querySelector('#mdParams');
    const nameEl = box && box.querySelector('.md-md-name');
    const ctl = box && box.querySelector('.md-ctl');
    return {
      hasComp: !!nameEl,
      name: nameEl ? nameEl.textContent : '',
      hasEdit: !!(box && box.querySelector('[data-md-act="comp-edit"]')),
      /* 控制器 = 组件自报的 panel 直接嵌在属性面板里（不弹窗、可就地调）。
       * 和下面那个「大面板」是同一份 HTML 的两个宿主，所以选择器必须限定作用域。 */
      hasCtl: !!(ctl && ctl.querySelector('.md-md-expr')),
      ctlSliders: ctl ? ctl.querySelectorAll('input[type="range"]').length : 0
    };
  });
  check(propUi.hasComp && /流明头模/.test(propUi.name), '属性面板里有「组件」区，写着它是流明头模',
    propUi.name);
  check(propUi.hasEdit && propUi.hasCtl, '组件区有控制器（表情按钮 + 强度滑杆就地可调）+ 大面板入口',
    'ctl=' + propUi.hasCtl + ' sliders=' + propUi.ctlSliders);

  /* 从属性面板进 = 编辑模式（改的是这个对象），不是又加一个 */
  await page.locator('[data-md-act="comp-edit"]').click();
  await page.waitForTimeout(600);
  const editUi = await page.evaluate(() => {
    const ov = document.querySelector('.md-overlay.comp');
    if (!ov) return null;
    return {
      title: (ov.querySelector('.md-ov-head b') || {}).textContent || '',
      go: ((ov.querySelector('[data-md-act="comp-add"]') || {}).textContent || '').trim(),
      cardsDisabled: Array.from(ov.querySelectorAll('.md-comp-card')).every((c) => c.disabled),
      exprs: ov.querySelectorAll('.md-md-expr').length
    };
  });
  check(!!editUi && /调整组件/.test(editUi.title), '从属性面板进来是「调整组件」', editUi && editUi.title);
  check(!!editUi && /应用到对象/.test(editUi.go), '主按钮变成「应用到对象」', editUi && editUi.go);
  check(!!editUi && editUi.cardsDisabled, '编辑模式下不能再切组件类别（改的是这个对象，不是换零件）');

  /* 点「微笑」→ 一次点亮多个形态键（表情不是单选一个键）
   * ⚠ 必须限定在 overlay 里找：属性面板的控制器里有同一套按钮，
   *   全文档 querySelectorAll 会先命中后台那一套 —— 那测的就不是这个面板了。 */
  const smile = await page.evaluate(() => {
    const ov = document.querySelector('.md-overlay.comp');
    if (!ov) return null;
    const b = Array.from(ov.querySelectorAll('.md-md-expr')).find((x) => /微笑/.test(x.textContent));
    if (!b) return null;
    b.click();
    const cv = document.querySelector('.md-overlay.comp') || ov;
    const chips = Array.from(cv.querySelectorAll('.md-md-key')).map((c) => c.textContent.trim());
    return { chips, len: chips.length, state: window.modelDesk.componentState() };
  });
  check(!!smile && smile.len >= 3, '「微笑」一次点亮多个形态键（叠加，不是单选）',
    smile && smile.chips.join(' , '));
  check(!!smile && smile.state && smile.state.editing === true, '面板知道自己正在改一个已存在的对象');

  await page.locator('[data-md-act="comp-add"]').click();
  await page.waitForFunction(() => !document.querySelector('.md-overlay.on'), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const applied = await page.evaluate((prevId) => {
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes[doc.nodes.length - 1];
    const mesh = window.SeedModel.Scene.getMesh(doc, node);
    const live = (mesh.morphs || []).filter((m) => m.weight > 0);
    const box = document.querySelector('#mdParams');
    return {
      sameNode: node.id === prevId,
      nodes: doc.nodes.length,
      meshRef: node.meshRef,
      verts: mesh.positions.length / 3,
      expr: node.comp && node.comp.params ? node.comp.params.expr : '',
      weighted: live.length,
      names: live.map((m) => m.name).sort().join(','),
      sum: +live.reduce((a, m) => a + m.weight, 0).toFixed(3),
      /* 控制器里的 chips = 属性面板对「这个对象现在什么表情」的实时反映 */
      ctlChips: (box && box.querySelectorAll('.md-ctl .md-md-key').length) || 0,
      summary: (box && box.querySelector('.md-ctl') ? box.querySelector('.md-ctl').textContent : '')
    };
  }, owned.id);
  check(applied.sameNode && applied.nodes === owned.nodes, '应用后**没有**新增对象（改的是同一个头）',
    owned.nodes + ' → ' + applied.nodes);
  check(applied.meshRef === owned.meshRef && applied.verts === 3606,
    '还是同一份网格（没重建几何，拓扑与 UV 不动）', applied.meshRef + ' · ' + applied.verts + ' 顶点');
  check(applied.expr === 'smile' && applied.weighted >= 3, '参数落在这个对象上（expr=smile，3+ 个键有权重）',
    applied.weighted + ' 键 · Σw=' + applied.sum + ' · ' + applied.names);
  check(applied.ctlChips >= 3, '属性面板的控制器跟着变（组件属性是活的，不是一次性快照）',
    applied.ctlChips + ' 个叠加键 · ' + applied.summary.trim().slice(0, 40));

  /* 存盘重开之后还得知道自己是什么：node.comp 必须过一遍序列化 + 归一化 */
  const round = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const raw = JSON.parse(JSON.stringify(window.SeedModel.Scene.toSeedModel(doc)));
    const v = window.SeedModel.Scene.validate(raw);
    const back = v.doc && v.doc.nodes[v.doc.nodes.length - 1];
    return { ok: v.ok, id: back && back.comp ? back.comp.id : null,
      expr: back && back.comp && back.comp.params ? back.comp.params.expr : '' };
  });
  check(round.ok && round.id === 'lumen-head' && round.expr === 'smile',
    'node.comp 过序列化 + 归一化还在（存盘重开不会退化成普通网格）', JSON.stringify(round));

  /* 撤销这次调整：对象留着、表情回基础（不是把对象撤掉） */
  await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(700);
  const undoneEdit = await page.evaluate(() => {
    const doc = window.modelDesk.getDocument();
    const node = doc.nodes[doc.nodes.length - 1];
    const mesh = window.SeedModel.Scene.getMesh(doc, node);
    return {
      nodes: doc.nodes.length,
      weighted: (mesh.morphs || []).filter((m) => m.weight > 0).length,
      expr: node.comp && node.comp.params ? node.comp.params.expr : ''
    };
  });
  check(undoneEdit.nodes === owned.nodes && undoneEdit.weighted === 0,
    '撤销这次调整：对象还在、表情回到基础', JSON.stringify(undoneEdit));

  /* ---------- ⑥ 三视图截图 ---------- */
  /* 干净画面：默认文档那个 1m 立方体不藏起来，侧视图整屏都是它的内壁 */
  await page.evaluate(() => {
    const g = window.modelDesk.__debug();
    Object.keys(g.pivots).forEach((id, i) => { if (i === 0) g.pivots[id].visible = false; });
    window.modelDesk.clearSelection();
  });
  await page.waitForTimeout(500);
  const stage = await page.evaluate(() => {
    const r = document.querySelector('#mdCanvas').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const shot = async (tag) => {
    await page.waitForTimeout(520);
    await RUN.shot(page, 'view-' + tag + '.png', { clip: stage });
  };
  for (const v of ['front', 'left', 'iso']) {
    await page.evaluate((vv) => window.modelDesk.viewPreset(vv), v);
    await shot(v);
  }

  /* ---------- ⑦ 撤销 ---------- */
  await page.evaluate(() => window.modelDesk.undo());
  await page.waitForTimeout(700);
  const undone = await page.evaluate(() => window.modelDesk.getDocument().nodes.length);
  check(undone === before, 'Ctrl+Z 能把这次添加整体退回', before + ' ← ' + undone);
  await page.evaluate(() => window.modelDesk.redo());
  await page.waitForTimeout(500);

  /* ---------- 页面错误 ---------- */
  const realErrs = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  check(realErrs.length === 0, '页面零错误', realErrs.slice(0, 2).join(' | '));

  await browser.close();
  RUN.finish(realErrs, { fails: fails });
  console.log('\n' + (fails ? '❌ ' + fails + ' 条失败' : '✅ 全部通过') + ' · ' + path.relative(ROOT, RUN.dir));
  process.exit(fails ? 1 : 0);
})();
