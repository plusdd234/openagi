/* 探针：流明 3D 数字人（apps/lumen3d）
 *
 * 覆盖：
 *   ① 桌面图标 → 窗口打开；
 *   ② 参考脸与 97 段曲线加载完成，canvas 尺寸合理；
 *   ③ 形态键数量、表情标签与目录一致；
 *   ④ 标签驱动：切「微笑」后形态键权重被抬起，曲线随时间变化；
 *   ⑤ 口型：vrc.v_aa 能按口型状态抬起；
 *   ⑥ 对话：桩掉 llmStreamRequest，标签剥掉、表情切换、气泡落字；
 *   ⑦ 右侧检查器：对话 / 捏脸 / 纹理常驻右列，16 个变形器写进 uniform、预设 / 随机 / 撤销可用，
 *      纹理修改器可落笔、应用；三维直接操控：脸上的分组操控点、拖动改参数、选区覆层（画在本体材质里）、轮廓曲线控制脸型；
 *   ⑧ 关窗再开复用 DOM 与 canvas（mount 幂等）；
 *   ⑨ 窄窗口无横向溢出且舞台保留尺寸；
 *   ⑩ 全程无 pageerror / console error。
 *
 * 用法：node tools/probe-lumen3d.js [--shots]
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { createRun, ROOT } = require('./probe-run');

const run = createRun('probe-lumen3d');
let fails = 0;

function check(ok, name, extra) {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
}

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.classList.contains('hidden') && cs.display !== 'none' &&
    cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
}, sel);

const rig = (page) => page.evaluate(() => (window.__lumen3d ? window.__lumen3d() : null));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/speech|voice|audio|ERR_CONNECTION_REFUSED|Autoplay/i.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.removeItem('hf_lumen3d_state'); } catch (e) { /* 忽略 */ } });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('hf_lumen3dShape');
      localStorage.removeItem('hf_lumen3dPresets');
      localStorage.removeItem('hf_lumen3d_tex');
    } catch (e) { /* 忽略 */ }
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1100);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="lumen3d"]')),
    '桌面出现「流明3D」图标');

  await page.evaluate(() => window.openDeskApp('lumen3d'));
  await page.waitForTimeout(600);
  check(await visible(page, '#lumen3dWin'), '流明3D 窗口已打开');

  /* ② 19MB 内联资源 + 10MB 几何解析，本地也给足时间 */
  const loaded = await page.waitForFunction(
    () => window.__lumen3d && window.__lumen3d() !== null,
    null, { timeout: 45000 }
  ).then(() => true).catch(() => false);
  check(loaded, '参考脸与表演曲线加载完成');

  const canvas = await page.evaluate(() => {
    const c = document.querySelector('#l3Canvas canvas');
    if (!c) return null;
    return {
      w: c.clientWidth,
      h: c.clientHeight,
      loadingDone: document.querySelector('#l3Loading').classList.contains('is-done'),
      state: document.getElementById('l3State').textContent.trim()
    };
  });
  check(!!canvas && canvas.w > 200 && canvas.h > 200, 'canvas 已挂载且尺寸合理',
    canvas ? canvas.w + '×' + canvas.h : '无 canvas');
  check(!!canvas && canvas.loadingDone, '加载遮罩已收起', canvas ? canvas.state : '');

  const meta = await rig(page);
  check(!!meta && meta.morphs >= 100, '形态键数量正确', meta ? meta.morphs + ' 个' : '未就绪');
  check(!!meta && meta.styles === 97, '曲线片段与目录一致', meta ? meta.styles + ' 段' : '');
  check(!!meta && meta.labels.includes('微笑') && meta.labels.includes('自然放松'),
    '表情标签包含常用项', meta ? meta.labels.length + ' 个标签' : '');

  /* ④ 标签驱动：切「微笑」后至少有一个形态键被抬起 */
  const smile = await page.evaluate(() => {
    const api = window.__lumen3d();
    const current = api.play('微笑');
    return { current: current, before: api.influence('vrc.v_sil') };
  });
  await page.waitForTimeout(420);
  const smileAfter = await page.evaluate(() => {
    const api = window.__lumen3d();
    return { current: api.current, peak: api.peak() };
  });
  check(smile.current === '微笑' && smileAfter.current === '微笑', '选「微笑」后播放该段曲线', smileAfter.current);
  check(smileAfter.peak.value > 0.02, '微笑曲线已写入形态键',
    smileAfter.peak.name + ' ' + Number(smileAfter.peak.value).toFixed(3));

  /* ⑤ 口型：aa 通道抬起 */
  await page.evaluate(() => window.__lumen3d().setMouth('aa', 1));
  await page.waitForTimeout(160);
  const mouth = await page.evaluate(() => window.__lumen3d().influence('vrc.v_aa'));
  check(Number(mouth) > 0.2, '口型驱动 vrc.v_aa 抬起', Number(mouth).toFixed(3));

  /* ⑥ 对话：桩掉语言模型，验证标签剥离与表情切换 */
  await page.evaluate(() => {
    window.llmStreamRequest = function (sys, messages, onDelta) {
      const text = '（开心）你好呀，我是流明，很高兴见到你。';
      return new Promise((resolve) => {
        let i = 0;
        const timer = setInterval(() => {
          i += 4;
          onDelta(text.slice(0, i), text.slice(i - 4, i));
          if (i >= text.length) { clearInterval(timer); resolve(text); }
        }, 24);
      });
    };
  });
  await page.fill('#l3Input', '你好');
  await page.click('#l3Send');
  await page.waitForTimeout(900);
  const chat = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('#l3Msgs .l3-msg')];
    const last = bubbles[bubbles.length - 1];
    return {
      count: bubbles.length,
      text: last ? last.textContent : '',
      expr: document.getElementById('l3Expr').textContent.trim(),
      current: window.__lumen3d().current,
      busy: document.getElementById('l3Send').disabled
    };
  });
  check(chat.count >= 2 && chat.text.indexOf('你好呀') >= 0, '对话气泡渲染出台词',
    chat.text.slice(0, 30));
  check(chat.text.indexOf('（') < 0 && chat.text.indexOf('(') < 0, '气泡里已剥掉表情标签', chat.text.slice(0, 24));
  check(chat.expr === '开心欢快' || chat.current === '开心欢快',
    '标签切换到对应表情', chat.expr + ' / ' + chat.current);
  check(!chat.busy, '生成结束后发送按钮恢复');

  await page.waitForTimeout(300);
  await run.shot(page, 'lumen3d-wide.png');

  /* ⑦ 右侧检查器：捏脸编辑器 + 内置纹理编辑器 */
  const layout = await page.evaluate(() => {
    const app = document.getElementById('l3App').getBoundingClientRect();
    const stage = document.getElementById('l3Stage').getBoundingClientRect();
    const insp = document.getElementById('l3Drawer').getBoundingClientRect();
    return {
      tabs: document.querySelectorAll('#l3Drawer .l3-insp-tabs [data-tab]').length,
      gap: Math.round(insp.left - stage.right),
      right: Math.round(app.right - insp.right),
      chat: document.getElementById('l3Drawer').getAttribute('data-tab')
    };
  });
  check(layout.tabs === 3 && layout.gap >= -1 && layout.gap <= 1 && layout.right <= 1,
    '检查器常驻展示区右侧', layout.tabs + ' 页签 · 间隔 ' + layout.gap + 'px / 右缘 ' + layout.right + 'px');
  check(layout.chat === 'chat', '默认停在对话页', layout.chat);

  await page.click('#l3LookBtn');
  await page.waitForTimeout(280);
  const drawer = await page.evaluate(() => {
    const el = document.getElementById('l3Drawer');
    return {
      on: !document.querySelector('[data-pane="shape"]').hidden && el.getAttribute('data-tab') === 'shape',
      rows: document.querySelectorAll('#l3ShapeList input[type="range"]').length,
      groups: document.querySelectorAll('#l3ShapeList .l3-shape-group').length,
      presets: document.querySelectorAll('#l3ShapePresets [data-preset]').length,
      keys: Array.from(document.querySelectorAll('#l3ShapeList [data-shape]'))
        .map((el) => el.getAttribute('data-shape'))
    };
  });
  check(drawer.on, '「捏脸」切到造型页');
  /* 轮廓 8 + 眼睛 8 + 鼻子 1 = 17。眼睛这一组是这一版新加的：
   * 整眼手柄改不了睫毛翘度 / 眼球大小，只能靠滑杆补。 */
  check(drawer.rows === 17, '滑杆覆盖轮廓 + 眼睛 + 鼻子（17 项）', String(drawer.rows));
  check(drawer.groups === 3, '参数按 3 组呈现', String(drawer.groups));
  check(drawer.presets >= 7, '内置预设已渲染', String(drawer.presets) + ' 个');
  /* 嘴部仍然只走区域手柄：唇形靠拖，滑杆留着会两套逻辑打架 */
  check(drawer.keys.every((key) => !/^mouth|^lip/.test(key)),
    '嘴部仍然不出现滑杆（只走区域手柄）', drawer.keys.join(','));

  await page.click('#l3ShapePresets [data-preset="Q版"]');
  await page.waitForTimeout(160);
  const preset = await page.evaluate(() => {
    const api = window.__lumen3d();
    const chip = document.querySelector('#l3ShapePresets [data-preset="Q版"]');
    return { width: api.shape('width'), name: api.shapePreset(), on: chip.classList.contains('on') };
  });
  check(preset.width === 78 && preset.name === 'Q版', '点击预设套用参数', String(preset.width));
  check(preset.on, '当前预设高亮');

  const shape = await page.evaluate(() => {
    const api = window.__lumen3d();
    api.setShape('width', 100);
    api.setShape('chin', 0);
    api.setShape('eyeWidth', 100);
    const saved = JSON.parse(localStorage.getItem('hf_lumen3dShape') || '{}');
    return {
      width: api.shape('width'), chin: api.shape('chin'),
      u: api.shapeUniforms(), saved: saved.width, preset: api.shapePreset()
    };
  });
  check(shape.width === 100 && shape.chin === 0, '脸型参数写入脸模');
  check(Math.abs(shape.u.shape[0][0] - 1) < 0.001 && Math.abs(shape.u.shape[0][2] + 1) < 0.001,
    '轮廓参数同步到 uniform', JSON.stringify(shape.u.shape[0]));
  check(Math.abs(shape.u.shape[2][0] - 1) < 0.001, '第二组 uniform 正确打包', JSON.stringify(shape.u.shape[2]));
  check(shape.saved === 100, '脸型参数已持久化');
  check(shape.preset === '', '手动改参数后取消预设高亮');

  const random = await page.evaluate(() => {
    const api = window.__lumen3d();
    const hit = document.getElementById('l3ShapeRandom');
    hit.click();
    const values = api.shapeValues();
    return { width: values.width, history: api.shapeHistory() };
  });
  check(random.history.size >= 2 && random.width !== 100,
    '随机捏脸产生新参数并记入历史', String(random.width) + ' / ' + random.history.size);

  await page.click('#l3ShapeUndo');
  await page.waitForTimeout(120);
  const undone = await page.evaluate(() => {
    const api = window.__lumen3d();
    return { width: api.shape('width'), chin: api.shape('chin'), history: api.shapeHistory() };
  });
  check(undone.width === 100 && undone.chin === 0, '撤销恢复到随机前', String(undone.width));

  const typed = await page.evaluate(() => {
    const num = document.querySelector('[data-shape-num="length"]');
    num.value = '30';
    num.dispatchEvent(new Event('change', { bubbles: true }));
    const range = document.querySelector('[data-shape="length"]');
    return { value: window.__lumen3d().shape('length'), range: range.value };
  });
  check(typed.value === 30 && typed.range === '30', '数值框输入与滑杆联动', typed.range);

  const mine = await page.evaluate(() => {
    const api = window.__lumen3d();
    const name = api.savePreset('测试脸');
    const saved = JSON.parse(localStorage.getItem('hf_lumen3dPresets') || '[]');
    const chip = document.querySelector('#l3ShapePresets [data-preset="测试脸"]');
    api.deletePreset('测试脸');
    return {
      name: name,
      stored: saved.length,
      chip: !!chip,
      gone: !document.querySelector('#l3ShapePresets [data-preset="测试脸"]'),
      left: JSON.parse(localStorage.getItem('hf_lumen3dPresets') || '[]').length
    };
  });
  check(mine.name === '测试脸' && mine.chip && mine.stored === 1, '自定义预设可保存并渲染');
  check(mine.gone && mine.left === 0, '自定义预设可删除');

  await page.click('#l3ShapeReset');
  await page.waitForTimeout(120);
  const reset = await page.evaluate(() => window.__lumen3d().shapeValues());
  check(Object.keys(reset).every((key) => reset[key] === 50), '复原回到原始脸模');

  /* ④ 三维直接操控：脸上的操控点、曲面范围、轮廓曲线 */
  const sculpt = await page.evaluate(() => {
    const api = window.__lumen3d();
    const layer = document.getElementById('l3Gizmos');
    const host = document.getElementById('l3Canvas').getBoundingClientRect();
    return {
      group: api.gizmoGroup(),
      on: !!layer && !layer.classList.contains('is-off'),
      count: layer ? layer.querySelectorAll('.l3-gizmo').length : 0,
      items: api.gizmos(),
      curve: api.curvePoints(),
      path: api.curvePath(),
      host: { w: host.width, h: host.height }
    };
  });
  check(sculpt.on && sculpt.group === '轮廓' && sculpt.count === 8 && sculpt.items.length === 8,
    '轮廓组在脸上渲染 8 个操控点', sculpt.count + ' 个');
  check(sculpt.items.every((item) => item.visible &&
    item.x > 0 && item.x < sculpt.host.w && item.y > 0 && item.y < sculpt.host.h),
    '操控点投影在三维画布内', sculpt.items.map((item) => item.key).join(','));
  check(sculpt.curve.length === 4 && sculpt.path.length > 80, '轮廓曲线生成 4 个控制点',
    sculpt.curve.map((item) => item.key).join(','));

  await page.locator('.l3-gizmo[data-gizmo="width"]').hover();
  await page.waitForTimeout(180);
  const hovered = await page.evaluate(() => {
    const api = window.__lumen3d();
    const uniforms = api.gizmoHighlight();
    return { alpha: uniforms.selAlpha, coil: uniforms.highlight, face: api.faceHighlight() };
  });
  check(hovered.alpha > 0.2 && hovered.coil[1] > 1,
    '悬停操控点显示影响范围', '覆层 ' + Number(hovered.alpha).toFixed(2) + ' / 线圈 ' + hovered.coil.join(','));

  /* 选区：直接在模型材质里画的覆层（不是独立面片，也不是屏幕上的椭圆曲线） */
  const sel = await page.evaluate(() => window.__lumen3d().selection());
  check(!!sel.highlight && sel.highlight.on && sel.highlight.kind === 'coil',
    '选区是模型表面的覆层', sel.highlight ? sel.highlight.kind + ' / ' + sel.highlight.key : '无选区');
  check(sel.highlight.mode === 'material' && sel.highlight.overlayMeshes === 0,
    '覆层画在本体材质里（没有独立叠加网格）',
    sel.highlight.mode + ' / 叠加网格 ' + sel.highlight.overlayMeshes);
  check(sel.highlight.alpha > 0.2 && sel.highlight.alpha <= 0.7,
    '覆层不透明度合理（看得见但不糊住脸）', Number(sel.highlight.alpha).toFixed(2));
  check(sel.legacyCurve === 0, '旧的贴脸椭圆曲线（3D 曲线曲面）已下线', '残留 ' + sel.legacyCurve + ' 条');
  check(sel.handles.coil, '选区手柄仍可拖（范围可改）');

  /* 抓手拖拽：顺着力的方向拖变大，反向拖变小 */
  const gain = await page.evaluate(() => window.__lumen3d().gizmoGain('width'));
  const gLen = Math.hypot(gain[0], gain[1]) || 1;
  const gDir = [gain[0] / gLen, gain[1] / gLen];
  const widthBefore = await page.evaluate(() => window.__lumen3d().shape('width'));
  const widthBox = await page.locator('.l3-gizmo[data-gizmo="width"]').boundingBox();
  const wx = widthBox.x + widthBox.width / 2;
  const wy = widthBox.y + widthBox.height / 2;
  await page.mouse.move(wx, wy);
  await page.mouse.down();
  await page.mouse.move(wx + gDir[0] * 40, wy + gDir[1] * 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const widthAfter = await page.evaluate(() => window.__lumen3d().shape('width'));
  check(widthAfter > widthBefore + 8, '顺着力方向拖操控点 → 参数变大',
    widthBefore + ' → ' + widthAfter);

  const backBefore = widthAfter;
  const box2 = await page.locator('.l3-gizmo[data-gizmo="width"]').boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2 - gDir[0] * 40, box2.y + box2.height / 2 - gDir[1] * 40,
    { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const widthBack = await page.evaluate(() => window.__lumen3d().shape('width'));
  check(widthBack < backBefore - 8, '反向拖 → 参数变小（方向与力一致）',
    backBefore + ' → ' + widthBack);

  /* 范围手柄的死区：线圈顶到脸的轮廓 / 中线时那条边怎么拖都不会动，
   * 这种手柄必须不再摆出来（以前它钳在耳朵上，用户抓到就是「拖了没反应」）；
   * 范围铺满整宽时中心只剩上下移动，横拖同样无效。 */
  await page.evaluate(() => {
    const api = window.__lumen3d();
    api.setCoil('width', [0, 3, 0.42, 0.55]);
    api.setCoil('cheekFull', [0.45, 0.8, 0.5, 0.4]);
  });
  await page.waitForTimeout(160);
  const coilDead = await page.evaluate(() => {
    const api = window.__lumen3d();
    const pick = (role) => api.coilHandles().filter((h) => h.role === role)[0] || {};
    return {
      key: api.gizmoKey(),
      axis: pick('center').axis,
      right: !!pick('right').visible, left: !!pick('left').visible,
      top: !!pick('top').visible, bottom: !!pick('bottom').visible
    };
  });
  check(coilDead.key === 'width' && !coilDead.right && !coilDead.left && !coilDead.bottom &&
    coilDead.axis === 'v', '范围顶到轮廓的边不再摆出手柄（拖不动的死区）',
    JSON.stringify(coilDead));

  const coilBox = await page.locator('#l3Coil [data-coil-edge="center"]').boundingBox();
  const vcBefore = await page.evaluate(() => window.__lumen3d().coils().width[2]);
  await page.mouse.move(coilBox.x + coilBox.width / 2, coilBox.y + coilBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(coilBox.x + coilBox.width / 2, coilBox.y + coilBox.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const vcAfter = await page.evaluate(() => window.__lumen3d().coils().width[2]);
  check(Math.abs(vcAfter - vcBefore) > 0.05, '中心手柄竖拖仍能移动范围',
    Number(vcBefore).toFixed(2) + ' → ' + Number(vcAfter).toFixed(2));

  await page.click('.l3-gizmo[data-gizmo="cheekFull"]');
  await page.waitForTimeout(200);
  const coilSide = await page.evaluate(() => {
    const api = window.__lumen3d();
    const pick = (role) => api.coilHandles().filter((h) => h.role === role)[0] || {};
    return {
      key: api.gizmoKey(), axis: pick('center').axis,
      right: !!pick('right').visible, top: !!pick('top').visible, bottom: !!pick('bottom').visible,
      tip: pick('center').tip
    };
  });
  check(coilSide.key === 'cheekFull' && coilSide.axis === 'both' &&
    coilSide.top && coilSide.bottom && !coilSide.right,
    '范围没铺满整宽时中心可横移、能拖的边照旧', JSON.stringify(coilSide));
  await page.evaluate(() => {
    const api = window.__lumen3d();
    api.resetCoil('width');
    api.resetCoil('cheekFull');
  });

  /* 眼睛：两片面高亮 + 移动 / 缩放 / 旋转 */
  await page.click('#l3GizmoGroups [data-gizmo-group="眼睛"]');
  await page.waitForTimeout(320);
  const eye = await page.evaluate(() => {
    const api = window.__lumen3d();
    const data = api.projectRegion('eye');
    const handles = api.regionHandles();
    return {
      items: data ? data.items.length : 0,
      spread: data ? data.items.map((it) => {
        const xs = it.ring.map((p) => p.x);
        return [Math.round(Math.min(...xs)), Math.round(Math.max(...xs))];
      }) : [],
      handles: handles.filter((h) => h.visible).length,
      roles: [...new Set(handles.map((h) => h.role))].sort().join(','),
      face: api.faceHighlight(),
      sel: api.selection()
    };
  });
  check(eye.items === 2 && eye.face.on, '左右眼各一块覆层', eye.items + ' 块');
  check(eye.face.kind === 'region' && eye.face.region === 'eye' && eye.face.maskId === 1,
    '眼睛覆层走眼掩码', eye.face.region + ' / ' + eye.face.maskId);
  check(eye.spread.every(([a, b]) => b - a < 160), '每片只圈住一只眼',
    eye.spread.map(([a, b]) => a + '-' + b).join(' | '));
  check(eye.handles === 6 && eye.roles === 'center,rotate,scale',
    '每只眼 3 个手柄（移动/缩放/旋转）', eye.roles);
  check(!!eye.sel && eye.sel.legacyCurve === 0 && eye.sel.handles.region,
    '眼睛不再画椭圆曲线，只留手柄', eye.sel ? '残留 ' + eye.sel.legacyCurve : '无');

  const eyeMove = await page.evaluate(() => window.__lumen3d().xform().eye);
  const moveBox = await page.locator('.l3-region-handle.is-center[data-side="1"]').boundingBox();
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width / 2 + 14, moveBox.y + moveBox.height / 2 - 10, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const eyeMoved = await page.evaluate(() => window.__lumen3d().xform().eye);
  check(Math.abs(eyeMoved[0] - eyeMove[0]) > 0.01 || Math.abs(eyeMoved[1] - eyeMove[1]) > 0.01,
    '拖中心移动眼睛', eyeMove.slice(0, 2).map((n) => n.toFixed(2)).join(',') + ' → ' +
    eyeMoved.slice(0, 2).map((n) => n.toFixed(2)).join(','));

  const scaleBox = await page.locator('.l3-region-handle.is-scale[data-side="1"]').boundingBox();
  const scaleDir = await page.evaluate(() => {
    const data = window.__lumen3d().projectRegion('eye');
    const right = data.items.filter((i) => i.side === 1)[0];
    const dx = right.scale.x - right.center.x;
    const dy = right.scale.y - right.center.y;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  });
  const sx = scaleBox.x + scaleBox.width / 2;
  const sy = scaleBox.y + scaleBox.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + scaleDir[0] * 26, sy + scaleDir[1] * 26, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const eyeScaled = await page.evaluate(() => window.__lumen3d().xform().eye);
  check(eyeScaled[3] > eyeMoved[3] + 0.02, '拖外侧手柄放大眼睛',
    eyeMoved[3].toFixed(2) + ' → ' + eyeScaled[3].toFixed(2));

  const rotBefore = await page.evaluate(() => {
    const data = window.__lumen3d().projectRegion('eye');
    const right = data.items.filter((i) => i.side === 1)[0];
    return { rot: window.__lumen3d().xform().eye[2], top: right.rotate };
  });
  const rotBox = await page.locator('.l3-region-handle.is-rotate[data-side="1"]').boundingBox();
  await page.mouse.move(rotBox.x + rotBox.width / 2, rotBox.y + rotBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rotBox.x + rotBox.width / 2 + 22, rotBox.y + rotBox.height / 2 + 4, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const rotAfter = await page.evaluate(() => {
    const data = window.__lumen3d().projectRegion('eye');
    const right = data.items.filter((i) => i.side === 1)[0];
    return { rot: window.__lumen3d().xform().eye[2], top: right.rotate };
  });
  check(Math.abs(rotAfter.rot - rotBefore.rot) > 0.02, '拖上方手柄旋转眼睛',
    rotBefore.rot.toFixed(2) + ' → ' + rotAfter.rot.toFixed(2));
  check(rotAfter.top.x > rotBefore.top.x, '旋转方向跟手',
    Math.round(rotBefore.top.x) + ' → ' + Math.round(rotAfter.top.x));

  /* 睫毛必须算进眼睛：这颗脸的眼睛 / 睫毛 / 眼线全画在皮肤贴图上（把 FaceEyes
   * 材质染成纯红拍一张，屏幕上一点红都没有），所以只能靠皮肤掩码去盖。
   * 用 regionWeight 按 (au, v) 直接算权重，不看图：
   *   ① 睫毛尖（v≈0.775）要拿得到高权重，否则拉眼睛时睫毛末端原地不动——
   *      这就是用户连报两轮的 bug；
   *   ② 外眼角的睫毛尾（au≈0.78）也得有份，普通椭圆在那里是 0；
   *   ③ 额头 / 眉毛（v≥0.81）必须完全为 0，不然眉毛会被拽变形。
   * 数字是实测值：打开覆层（setHighlight）截图，用覆层自己的轮廓当标尺把
   * 睫毛尖 / 眉毛换算成 v，再按行统计「暗像素有多少被覆层盖到」量出来的。
   * 换脸模必须重新量，不要照抄。 */
  const eyeMaskCfg = await page.evaluate(() => ({
    frames: window.__lumen3d().regionFrames(),
    parts: window.__lumen3d().materialParts()
  }));
  const weights = await page.evaluate(() => {
    const a = window.__lumen3d();
    return {
      lashTop: a.regionWeight('eye', 0.45, 0.775),
      lashTail: a.regionWeight('eye', 0.78, 0.760),
      browLine: a.regionWeight('eye', 0.45, 0.810),
      center: a.regionWeight('eye', 0.45, 0.695)
    };
  });
  check(weights.lashTop >= 0.6, '睫毛尖在眼区掩码里（拿得到高权重）', weights.lashTop.toFixed(2));
  check(weights.lashTail >= 0.3, '外眼角睫毛尾也在掩码里', weights.lashTail.toFixed(2));
  check(weights.browLine <= 0.02, '额头 / 眉毛不在眼区掩码里', weights.browLine.toFixed(3));
  check(weights.center >= 0.99, '眼睛中心满权重', weights.center.toFixed(2));
  const eyeShape = eyeMaskCfg.frames && eyeMaskCfg.frames.eye;
  check(!!eyeShape && Number(eyeShape.p) >= 3,
    '眼区掩码是超椭圆（普通椭圆盖不住又宽又扁的睫毛带）', eyeShape ? 'p=' + eyeShape.p : '缺少 p');
  const eyeParts = (eyeMaskCfg.parts || []).map((item) => item.name + '=' + item.part).join(',');
  check(eyeParts === 'FaceSurface=0,FaceEyes=1', '眼球 / 睫毛材质走睫毛口径掩码', eyeParts);

  /* 顶点分部位：眼球 / 睫毛 / 眼角 / 口腔挤在同一个 FaceEyes 材质里，
   * 只能靠连通分量 + 形状特征逐顶点打标。打错标的后果是「拉睫毛把牙齿一起拽」，
   * 而且肉眼看不出区别 —— 必须在这里守住四类都在、且数量对得上几何。 */
  const partStats = await page.evaluate(() => window.__lumen3d().partStats());
  const partNums = [1, 2, 3, 4].map((k) => (partStats && partStats[k]) || 0);
  check(partNums.every((n) => n > 0), '眼球 / 睫毛 / 眼角 / 口腔都被单独打标',
    'ball ' + partNums[0] + ' / lash ' + partNums[1] + ' / corner ' + partNums[2] + ' / inner ' + partNums[3]);
  check(partNums[1] >= 100 && partNums[1] < partNums[0] + partNums[3],
    '睫毛只占细带那部分顶点（没把眼球 / 牙齿吃进来）', String(partNums[1]));

  /* 眼睛分组必须能在抽屉里直接调：以前 eyeDist..eyeTilt 被 NEUTRAL_KEYS 从滑杆里滤掉，
   * 眼睛只剩一个整眼手柄，睫毛翘度 / 眼球大小这种局部量根本没入口。 */
  const eyeRows = await page.evaluate(() => {
    const keys = Array.from(document.querySelectorAll('#l3ShapeList [data-shape]'))
      .map((el) => el.getAttribute('data-shape'));
    return { keys: keys, eye: keys.filter((k) => ['eyeDist', 'eyeWidth', 'eyeHeight', 'eyeTilt', 'lashLength', 'lashCurl', 'eyeTail', 'eyeOpen'].indexOf(k) >= 0) };
  });
  check(eyeRows.eye.length === 8, '眼睛 8 个参数都在抽屉里有滑杆', eyeRows.eye.join(','));

  /* 新参数必须真的落到 uniform 上：lashLength 是第 17 个参数（下标 16 → vec4[4].x），
   * 打包错位的话滑杆会变成改别的参数，界面上完全看不出来。 */
  const lashUniform = await page.evaluate(() => {
    const api = window.__lumen3d();
    api.setShape('lashLength', 100);
    api.setShape('eyeTail', 0);
    const u = api.shapeUniforms();
    api.setShape('lashLength', 50);
    api.setShape('eyeTail', 50);
    return { lash: u.shape[4][0], ball: u.shape[4][2] };
  });
  check(Math.abs(lashUniform.lash - 1) < 0.001 && Math.abs(lashUniform.ball + 1) < 0.001,
    '睫毛长度 / 眼尾上扬打包进 l3Shape[4]', JSON.stringify(lashUniform));

  /* 眼部四档必须在**皮肤掩码**上做：
   *   实测把 FaceEyes 材质染红、皮肤染绿各拍一张，红色一个像素都没有 ——
   *   屏幕上看到的眼睛 / 睫毛 / 眼线全是画在皮肤贴图上的，FaceEyes 那块几何被皮肤挡住。
   *   所以任何「按 aPart 分别动眼球 / 睫毛几何」的写法改了等于没改，
   *   探针在这里守住：眼部参数一律走 l3EyeSkinMask，并且不能再回来用 aPart 变形。 */
  const glsl = await page.evaluate(() => window.__lumen3d().deformSource());
  check(/float lashBand = l3EyeSkinMask\(au, v\)/.test(glsl) &&
    /float lidBand = l3EyeSkinMask\(au, v\)/.test(glsl) &&
    /float tailBand = l3EyeSkinMask\(au, v\)/.test(glsl),
    '睫毛 / 眼睑 / 眼尾三块掩码都长在皮肤椭圆上', glsl.length + ' 字符');
  check(!/isLash/.test(glsl) && !/isBall/.test(glsl),
    '眼部参数不再按 aPart 分别动几何（那块几何看不见）',
    /isLash/.test(glsl) ? '还在用 isLash' : '');
  /* 睁眼度 100 必须是「睁大」：上眼睑 y 增大。写反了滑块语义就整个倒过来。 */
  check(/p\.y \+= l3Shape\[4\]\.w \* [\d.]+ \* hScale \* lidBand/.test(glsl),
    '睁眼度方向：正值抬上眼睑（不是压）', /p\.y -= l3Shape\[4\]\.w/.test(glsl) ? '写反了' : '');
  /* 眼区椭圆必须够高：睫毛尖在 v≈0.81，椭圆上沿至少要越过它，
   * 否则睫毛末端权重是 0 —— 用户报的「睫毛末端不动」就是这个。 */
  const frame = await page.evaluate(() => window.__lumen3d().regionFrames().eye);
  /* 上沿 = vc + vrUp * hi^(1/p)（超椭圆不是 hi 的平方根） */
  const topV = frame.vc + frame.vrUp * Math.pow(frame.hi, 1 / (Number(frame.p) || 2));
  check(topV >= 0.79, '眼区掩码上沿越过睫毛尖（实测 v≈0.775）', 'top v ' + topV.toFixed(3));

  await page.click('#l3GizmoGroups [data-gizmo-group="嘴部"]');
  await page.waitForTimeout(300);
  const mouthSel = await page.evaluate(() => {
    const data = window.__lumen3d().projectRegion('mouth');
    const handles = window.__lumen3d().regionHandles();
    return {
      items: data ? data.items.length : 0,
      handles: handles.filter((h) => h.visible).length,
      face: window.__lumen3d().faceHighlight()
    };
  });
  check(mouthSel.items === 1 && mouthSel.handles === 3, '嘴巴一块覆层 + 3 个手柄',
    mouthSel.items + ' 块 / ' + mouthSel.handles + ' 手柄');
  check(mouthSel.face.kind === 'region' && mouthSel.face.region === 'mouth' && mouthSel.face.maskId === 2,
    '嘴巴覆层走嘴掩码', mouthSel.face.region + ' / ' + mouthSel.face.maskId);

  await page.click('#l3GizmoGroups [data-gizmo-group="轮廓"]');
  await page.waitForTimeout(240);

  const curveBefore = await page.evaluate(() => ({
    forehead: window.__lumen3d().shape('forehead'),
    path: window.__lumen3d().curvePath()
  }));
  const curveBox = await page.locator('#l3CurveSvg [data-curve="forehead"]').boundingBox();
  await page.mouse.move(curveBox.x + curveBox.width / 2, curveBox.y + curveBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(curveBox.x + curveBox.width / 2 + 30, curveBox.y + curveBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const curveAfter = await page.evaluate(() => ({
    forehead: window.__lumen3d().shape('forehead'),
    path: window.__lumen3d().curvePath()
  }));
  check(curveAfter.forehead > curveBefore.forehead + 6,
    '拖动曲线控制点修改脸型', curveBefore.forehead + ' → ' + curveAfter.forehead);
  check(curveAfter.path !== curveBefore.path, '轮廓曲线随参数重绘');

  /* ---- 面部轮廓线：在 3D 画布上直接拖脸缘 ----
   * 用户的原话是「能不能直接调轮廓曲线，而不是反复调参数看效果」。三条底线：
   * ① 默认倍率下手柄必须落在真实脸缘（u=±1）上，否则「抓的点不是脸」；
   * ② 拖了必须真的进顶点着色器（按加位移落地），不能只是改个数字；
   * ③ 只在轮廓分组下出现，别和眼睛 / 嘴部的区域手柄抢指针。 */
  const outlineInfo = await page.evaluate(() => {
    const api = window.__lumen3d();
    return {
      shown: api.outlineShown(),
      glsl: api.deformSource(),
      knots: api.outline(),
      uniform: api.outlineUniform(),
      nodes: api.outlineNodes().map((n) => ({
        index: n.index,
        k: +n.k.toFixed(3),
        cx: n.center.x,
        ex: n.edge.x,
        lx: n.edgeL.x,
        bx: n.base.x,
        blx: n.baseL.x
      })),
      handles: api.outlineHandles()
    };
  });
  const liveHandles = outlineInfo.handles.filter((h) => h.shown);
  check(outlineInfo.shown && liveHandles.length >= 14,
    '轮廓分组下脸缘浮出轮廓节点', liveHandles.length + ' / ' + outlineInfo.handles.length + ' 个可见');
  check(/float outlineDx = \(l3Outline\(t\) - 1\.0\) \* w/.test(outlineInfo.glsl) &&
    /p\.x \+= sign\(rest\.x\) \* outlineDx/.test(outlineInfo.glsl),
    '轮廓倍率进了顶点着色器（按加位移落地，不是乘 x）',
    /p\.x \*= .*outline/i.test(outlineInfo.glsl) ? '还在乘 x，耳朵会被拉成翅膀' : '');
  /* 默认倍率 1：手柄 x 必须落在脸缘上（u 正负两侧各一个），
   * 且「当前脸缘」edge 与「倍率 1 的脸缘」base 必须重合。 */
  const edgeMiss = outlineInfo.nodes.reduce((worst, node) => {
    const pos = outlineInfo.handles.find((h) => h.index === node.index && h.side === 'pos');
    const neg = outlineInfo.handles.find((h) => h.index === node.index && h.side === 'neg');
    if (!pos || !neg) return worst;
    return Math.max(worst, Math.abs(pos.x - node.ex), Math.abs(neg.x - node.lx),
      Math.abs(node.ex - node.bx), Math.abs(node.lx - node.blx));
  }, 0);
  check(edgeMiss <= 2.5, '轮廓手柄贴在真实脸缘上（默认倍率 1）', '最大偏差 ' + edgeMiss.toFixed(2) + 'px');

  /* 拖第 4 个节点 u 正侧的手柄往外 48px。
   * ⚠ 「往外」在屏幕上是左还是右由相机决定（相机在 -z 看 +z，u 正侧落在屏幕左边），
   * 所以方向从节点的 中线→脸缘 向量取，不写死正负。 */
  const knot3 = outlineInfo.nodes.filter((n) => n.index === 3)[0];
  const outward = Math.sign(knot3.ex - knot3.cx) || 1;
  const outBox = await page.locator('#l3Outline [data-out-index="3"][data-out-side="pos"]').boundingBox();
  const outCurveBefore = await page.evaluate(() => window.__lumen3d().curvePath());
  if (outBox) {
    await page.mouse.move(outBox.x + outBox.width / 2, outBox.y + outBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(outBox.x + outBox.width / 2 + 48 * outward, outBox.y + outBox.height / 2, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForTimeout(160);
  const outlineAfter = await page.evaluate(() => ({
    knots: window.__lumen3d().outline(),
    uniform: window.__lumen3d().outlineUniform(),
    curve: window.__lumen3d().curvePath(),
    at: window.__lumen3d().outlineNodes().map((n) => +n.k.toFixed(3)),
    handle: window.__lumen3d().outlineHandles()
      .filter((h) => h.index === 3 && h.side === 'pos')[0]
  }));
  check(outlineAfter.knots[3] > 1.08,
    '往外拖第 4 段脸缘放大脸宽', '×' + outlineInfo.knots[3] + ' → ×' + outlineAfter.knots[3].toFixed(2));
  check(outlineAfter.at[3] > 1.05,
    '曲线在节点处取到该倍率（不是只有端点生效）', '×' + outlineAfter.at[3]);
  check(outlineAfter.uniform.every((k, i) => Math.abs(k - outlineAfter.knots[i]) < 1e-6),
    '手柄倍率与 shader uniform 一致', outlineAfter.uniform.map((k) => k.toFixed(2)).join(','));
  check(outlineAfter.curve !== outCurveBefore, '二维轮廓曲线跟着轮廓倍率重绘');
  check(outlineAfter.handle && outlineAfter.handle.changed,
    '改过的节点标记成实心（is-changed）', outlineAfter.handle ? '' : '找不到手柄');

  /* 双击单个节点复位 */
  const dblBox = await page.locator('#l3Outline [data-out-index="3"][data-out-side="pos"]').boundingBox();
  if (dblBox) {
    await page.mouse.dblclick(dblBox.x + dblBox.width / 2, dblBox.y + dblBox.height / 2);
  }
  await page.waitForTimeout(200);
  const afterDbl = await page.evaluate(() => window.__lumen3d().outline());
  check(Math.abs(afterDbl[3] - 1) < 0.02, '双击节点把这一段复位成 ×1', '×' + afterDbl[3].toFixed(2));

  /* 撤销必须把轮廓一起倒回去：只倒参数不倒轮廓 = 「撤销没生效」 */
  const knot5 = outlineInfo.nodes.filter((n) => n.index === 5)[0];
  const outward5 = Math.sign(knot5.ex - knot5.cx) || 1;
  const undoBox = await page.locator('#l3Outline [data-out-index="5"][data-out-side="pos"]').boundingBox();
  if (undoBox) {
    await page.mouse.move(undoBox.x + undoBox.width / 2, undoBox.y + undoBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(undoBox.x + undoBox.width / 2 + 40 * outward5, undoBox.y + undoBox.height / 2, { steps: 5 });
    await page.mouse.up();
  }
  await page.waitForTimeout(150);
  const beforeUndo = await page.evaluate(() => window.__lumen3d().outline());
  await page.click('#l3ShapeUndo');
  await page.waitForTimeout(160);
  const afterUndo = await page.evaluate(() => window.__lumen3d().outline());
  check(beforeUndo[5] > 1.05 && Math.abs(afterUndo[5] - 1) < 0.02,
    '撤销把轮廓倍率一起倒回去', '×' + beforeUndo[5].toFixed(2) + ' → ×' + afterUndo[5].toFixed(2));

  /* 分组隔离 + 开关 */
  await page.click('#l3GizmoGroups [data-gizmo-group="眼睛"]');
  await page.waitForTimeout(220);
  const eyeGroupOutline = await page.evaluate(() => window.__lumen3d().outlineShown());
  await page.click('#l3GizmoGroups [data-gizmo-group="轮廓"]');
  await page.waitForTimeout(200);
  const backOutline = await page.evaluate(() => window.__lumen3d().outlineShown());
  check(!eyeGroupOutline && backOutline, '轮廓节点只在轮廓分组下出现',
    '眼睛组 ' + eyeGroupOutline + ' / 轮廓组 ' + backOutline);
  await page.uncheck('#l3OutlineOn');
  await page.waitForTimeout(180);
  const offOutline = await page.evaluate(() => ({
    shown: window.__lumen3d().outlineShown(),
    hidden: document.getElementById('l3Outline').classList.contains('is-off')
  }));
  await page.check('#l3OutlineOn');
  await page.waitForTimeout(180);
  check(!offOutline.shown && offOutline.hidden, '关掉「轮廓线」开关后手柄收起',
    'shown ' + offOutline.shown + ' · is-off ' + offOutline.hidden);

  await page.click('#l3Drawer [data-tab="texture"]');
  await page.waitForTimeout(420);
  const tex = await page.evaluate(() => {
    const api = window.__lumen3d();
    const canvas = document.getElementById('l3TexCanvas');
    const info = api.texture();
    return {
      visible: !document.querySelector('[data-pane="texture"]').hidden,
      ready: info.ready,
      width: info.width,
      height: info.height,
      cssW: canvas ? canvas.getBoundingClientRect().width : 0
    };
  });
  check(tex.visible && tex.ready && tex.width === 2048 && tex.height === 2048,
    '纹理页载入 2048×2048 贴图', tex.width + '×' + tex.height);
  check(tex.cssW > 200, '纹理画布按抽屉宽度缩放', Math.round(tex.cssW) + 'px');

  /* 分区绘制：区域列表、右侧停靠、选区外不落笔 */
  const regions = await page.evaluate(() => {
    const api = window.__lumen3d();
    const info = api.textureRegion();
    const canvas = document.getElementById('l3Canvas').getBoundingClientRect();
    const drawer = document.getElementById('l3Drawer').getBoundingClientRect();
    return {
      labels: info.list.map((item) => item.label),
      pixels: info.list.map((item) => item.pixels),
      chips: document.querySelectorAll('#l3TexRegions .l3-regionchip').length,
      docked: Math.abs(drawer.left - canvas.right) <= 1,
      gap: Math.round(drawer.left - canvas.right),
      brow: api.regionAt(300, 300),
      eye: api.regionAt(640, 884)
    };
  });
  check(regions.labels.join(',') === '全部,面部,眼睛,眉毛,鼻子,嘴巴',
    '纹理分区覆盖五官 · ' + regions.labels.length + ' 项', regions.labels.join(' / '));
  check(regions.pixels.slice(1).every((n) => n > 0) && regions.chips === regions.labels.length,
    '每个分区都有 UV 像素与按钮', regions.pixels.slice(1).join(','));
  check(regions.docked && regions.gap >= -1,
    '纹理面板停靠在预览右侧', '停靠 ' + regions.docked + ' · 间隔 ' + regions.gap + 'px');
  check(regions.brow === 3 && regions.eye === 2, 'UV 命中分区正确',
    '眉区 ' + regions.brow + ' · 眼区 ' + regions.eye);

  const clipBefore = await page.evaluate(() => window.__lumen3d().texturePixel(300, 300));
  await page.evaluate(() => window.__lumen3d().setTextureRegion('eyes'));
  await page.evaluate(() => window.__lumen3d().paintTexture(300, 300));
  const clipAfter = await page.evaluate(() => window.__lumen3d().texturePixel(300, 300));
  check(JSON.stringify(clipBefore) === JSON.stringify(clipAfter),
    '选区外（眉毛）不会落笔', String(clipBefore) + ' → ' + String(clipAfter));

  const eyeBefore = await page.evaluate(() => window.__lumen3d().texturePixel(640, 884));
  await page.evaluate(() => window.__lumen3d().paintTexture(640, 884));
  const eyeAfter = await page.evaluate(() => window.__lumen3d().texturePixel(640, 884));
  check(JSON.stringify(eyeBefore) !== JSON.stringify(eyeAfter),
    '选区内（眼睛）正常落笔', String(eyeBefore) + ' → ' + String(eyeAfter));

  await page.evaluate(() => window.__lumen3d().setTextureRegion('all'));
  const before = await page.evaluate(() => window.__lumen3d().texturePixel(300, 300));
  const box = await page.locator('#l3TexCanvas').boundingBox();
  if (box) {
    const px = box.x + box.width * (300 / 2048);
    const py = box.y + box.height * (300 / 2048);
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.mouse.move(px + 6, py + 6, { steps: 3 });
    await page.mouse.up();
  }
  await page.waitForTimeout(180);
  const afterPaint = await page.evaluate(() => window.__lumen3d().texturePixel(300, 300));
  check(!!afterPaint && afterPaint[0] > 120 && afterPaint[1] < 130, '画笔在贴图上留下笔迹',
    String(before) + ' → ' + String(afterPaint));

  await page.click('#l3TexApply');
  await page.waitForTimeout(420);
  const applied = await page.evaluate(() => {
    const rec = JSON.parse(localStorage.getItem('hf_lumen3d_tex') || 'null');
    return rec && typeof rec.src === 'string' ? rec.src.slice(0, 5) : '';
  });
  check(applied === 'blob:' || applied === 'data:', '应用贴图后写入持久化记录', applied || '无');

  const chatBack = await page.evaluate(async () => {
    document.querySelector('#l3Drawer .l3-insp-tabs [data-tab="chat"]').click();
    await new Promise((resolve) => setTimeout(resolve, 260));
    return {
      tab: document.getElementById('l3Drawer').getAttribute('data-tab'),
      chat: !document.querySelector('[data-pane="chat"]').hidden,
      gizmos: document.getElementById('l3Gizmos').classList.contains('is-off'),
      /* 轮廓手柄是后加的图层，最容易漏掉「切页也要收」 */
      outline: (document.getElementById('l3Outline') || {}).className || '',
      outlineShown: window.__lumen3d().outlineShown()
    };
  });
  check(chatBack.tab === 'chat' && chatBack.chat, '切回对话页收起编辑面板');
  check(chatBack.gizmos, '对话页隐藏脸上的操控点');
  check(/is-off/.test(chatBack.outline) && !chatBack.outlineShown,
    '对话页也收起轮廓节点', chatBack.outline);

  /* ⑧ 关窗再开：DOM 与 canvas 复用 */
  await page.evaluate(() => {
    window.__l3MsgsNode = document.querySelector('#lumen3dWin #l3Msgs');
    window.__l3CanvasNode = document.querySelector('#l3Canvas canvas');
    deskCloseWin(document.getElementById('lumen3dWin'));
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.openDeskApp('lumen3d'));
  await page.waitForTimeout(700);
  check(await visible(page, '#lumen3dWin'), '关窗后能再次打开');
  check(await page.evaluate(() => window.__l3MsgsNode === document.querySelector('#lumen3dWin #l3Msgs')),
    '再次打开复用原 DOM（mount 幂等）');
  check(await page.evaluate(() => window.__l3CanvasNode === document.querySelector('#l3Canvas canvas')),
    '三维 canvas 没有被重建');

  /* ⑨ 窄窗无横向溢出 */
  await page.setViewportSize({ width: 820, height: 760 });
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => {
    const app = document.querySelector('#lumen3dWin .l3-app');
    const shell = document.querySelector('#lumen3dWin .l3-shell');
    const stage = document.querySelector('#lumen3dWin .l3-stage');
    const c = document.querySelector('#l3Canvas canvas');
    return {
      app: app.scrollWidth - app.clientWidth,
      dir: getComputedStyle(shell).flexDirection,
      stageH: stage.getBoundingClientRect().height,
      cw: c ? c.clientWidth : 0
    };
  });
  check(overflow.app <= 2, '窄窗口下 App 无横向溢出', '+' + overflow.app);
  check(overflow.dir === 'column', '窄窗口下展示区与检查器上下堆叠', overflow.dir);
  check(overflow.stageH > 160 && overflow.cw > 160, '窄窗口下舞台与 canvas 仍保留尺寸',
    Math.round(overflow.stageH) + 'px / canvas ' + overflow.cw + 'px');

  await run.shot(page, 'lumen3d-window.png');

  await browser.close();
  check(errors.length === 0, '全程无 pageerror / console error', errors.join(' | '));

  run.finish(errors);
  console.log('\n' + (fails ? '❌ ' + fails + ' 项未通过' : '✅ 全部通过') + ' · 运行目录 ' + run.dir);
  process.exit(fails ? 1 : 0);
})().catch(async (err) => {
  console.error('探针异常：', err && err.stack || err);
  try { run.finish([err]); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
